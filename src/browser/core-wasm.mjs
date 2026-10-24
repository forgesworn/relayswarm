// The Rust core's commitment verifiers, compiled to WebAssembly
// (relayswarm-core.wasm, built by scripts/build-core-wasm.mjs from core/).
// The module has no imports. Each call passes `[event, options, atMs]` as
// JSON and reads JSON back; a rejection is null, exactly as in
// segment-commitment.mjs, which remains the reference implementation.
// Peer selection crosses as plain numbers; peer-selection.mjs is its
// reference. One instance holds one selection state, so load one per swarm.

import { CorePeerLink } from "./core-peer-link.mjs";
import { CoreNeighbourDiscovery } from "./core-discovery.mjs";
import { PeerSelection } from "./peer-selection.mjs";
import { segmentMediaContext } from "./segment-commitment.mjs";

const OP_STREAM = 0;
const OP_DELEGATION = 1;
const OP_COMMITMENT = 2;
const OP_PLAYER_HINT = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The fragment fields the core verifier reads from an hls.js load context. */
export function reduceFragmentContext(context) {
  return {
    sequence: context.frag.sn ?? null,
    discontinuity: context.frag.cc ?? 0,
    part: context.part?.index ?? null,
    level: String(context.frag.level),
    fragType: context.frag.type ?? null,
    decryptMethod: context.frag.decryptdata?.method ?? null,
    media: segmentMediaContext(context),
  };
}

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return WebAssembly.instantiate(source, {});
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return (await WebAssembly.instantiate(source, {})).instance;
  const url = source instanceof URL ? source.href : source;
  if (typeof url !== "string") throw new TypeError("coreWasm must be a URL, bytes or a WebAssembly.Module.");
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Core module unavailable (${response.status}).`);
  // A host serving the wrong media type still works, compiled from bytes.
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try { return (await WebAssembly.instantiateStreaming(response.clone(), {})).instance; } catch { /* fall through */ }
  }
  return (await WebAssembly.instantiate(await response.arrayBuffer(), {})).instance;
}

const SELECTION_EXPORTS = ["rs_sel_observe", "rs_sel_record", "rs_sel_mark", "rs_sel_forget", "rs_sel_select", "rs_sel_state",
  "rs_sel_project", "rs_sel_minimum", "rs_sel_estimate", "rs_sel_summary", "rs_link_new", "rs_link_free", "rs_link_call", "rs_disc_call"];
const LINK_SETS = 13;
const LINK_SERVE_RANGE = 15;
const LINK_HEADER = 13;
const LINK_HEADER_BYTES = LINK_HEADER * 8;
const LINK_RESOLVED = 5;
const orNull = (value) => Number.isNaN(value) ? null : value;
// Read memory only after the call: a call can grow it, detaching the old buffer.
const numbers = (core, pointer) => new Float64Array(core.memory.buffer, pointer, 6);

// Copy `bytes` into the module for one call and free them after. The memory
// view is taken after rs_alloc, which can grow and detach the old buffer.
function withBytes(exports, bytes, run) {
  const length = bytes.byteLength, pointer = exports.rs_alloc(length);
  try {
    new Uint8Array(exports.memory.buffer, pointer, length).set(bytes);
    return run(pointer, length);
  } finally {
    exports.rs_free(pointer, length);
  }
}

const resultBytes = (exports, length) => new Uint8Array(exports.memory.buffer, exports.rs_result_ptr(), length);

// Read a link frame out of the module before any callback can call in again:
// the header scalars, then each event as `{ tag, payload }` with its own copy.
// A resolved object is copied once, straight into a buffer of its exact size,
// with its request ID as `id`; `payload` is null when nothing was resolved.
function readLinkFrame(exports, length) {
  const bytes = resultBytes(exports, length);
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const header = new Array(LINK_HEADER);
  for (let index = 0; index < LINK_HEADER; index++) header[index] = view.getFloat64(index * 8, true);
  const events = [];
  for (let offset = LINK_HEADER_BYTES; offset < length;) {
    const tag = bytes[offset], start = offset + 5, end = start + view.getUint32(offset + 1, true);
    offset = end;
    if (tag !== LINK_RESOLVED) { events.push({ tag, payload: bytes.slice(start, end) }); continue; }
    if (end - start < 9 || end > length) throw new Error("Core link frame has a truncated resolution.");
    events.push({ tag, id: view.getFloat64(start, true), payload: bytes[start + 8] === 1 ? bytes.slice(start + 9, end) : null });
  }
  return { header, events };
}

/**
 * PeerSelection backed by the core. Arguments cross as WebAssembly doubles,
 * so they coerce exactly as the JavaScript's arithmetic does, and NaN comes
 * back as null. A trap hands over to a fresh JavaScript PeerSelection for
 * the rest of the session, which starts without link history.
 */
class CorePeerSelection {
  #exports;
  #onFailure;
  #fallback = null;
  #ids = new WeakMap();
  #next = 0;

  constructor(exports, fail) {
    this.#exports = exports;
    this.#onFailure = fail;
  }

  get kind() { return this.#fallback ? "js" : "wasm"; }

  /** Stop using the core, as after a trap elsewhere in the same instance. */
  retire() {
    this.#fallback ??= new PeerSelection();
  }

  #run(wasm, js) {
    if (this.#fallback) return js(this.#fallback);
    try {
      return wasm(this.#exports);
    } catch (error) {
      this.#fallback = new PeerSelection();
      this.#onFailure?.(error);
      return js(this.#fallback);
    }
  }

  #id(link) {
    let id = this.#ids.get(link);
    if (id === undefined) this.#ids.set(link, id = this.#next++);
    return id;
  }

  #state(index) {
    return this.#run((core) => numbers(core, core.rs_sel_state())[index],
      (js) => [js.firstByteMs(), js.rate(), js.lastObservedAt, js.turn, js.order][index] ?? NaN);
  }

  get lastObservedAt() { return this.#state(2); }
  get turn() { return this.#state(3); }
  get order() { return this.#state(4); }
  firstByteMs() { return orNull(this.#state(0)); }
  rate() { return orNull(this.#state(1)); }

  observe({ firstByteMs = null, bytes = 0, flowMs = 0, totalFlowMs = flowMs } = {}) {
    this.#run((core) => core.rs_sel_observe(Date.now(), Number.isFinite(firstByteMs) ? firstByteMs : NaN, bytes, flowMs, totalFlowMs || 0),
      (js) => js.observe({ firstByteMs, bytes, flowMs, totalFlowMs }));
  }

  record(link, elapsedMs, bytes = 0) {
    this.#run((core) => core.rs_sel_record(Date.now(), this.#id(link), elapsedMs, bytes), (js) => js.record(link, elapsedMs, bytes));
  }

  markSelected(link) {
    this.#run((core) => core.rs_sel_mark(this.#id(link)), (js) => js.markSelected(link));
  }

  forget(link) {
    const id = this.#ids.get(link);
    this.#run((core) => { if (id !== undefined) core.rs_sel_forget(id); }, (js) => js.forget(link));
  }

  projectMs(size) {
    return this.#run((core) => orNull(core.rs_sel_project(size)), (js) => js.projectMs(size));
  }

  minimumMs(size) {
    return this.#run((core) => core.rs_sel_minimum(size), (js) => js.minimumMs(size));
  }

  estimate(link, size) {
    return this.#run((core) => orNull(core.rs_sel_estimate(this.#id(link), size)), (js) => js.estimate(link, size));
  }

  summary(link) {
    return this.#run((core) => {
      const [attempts, latencyMs, throughputBytesPerSecond, failureRate, consecutiveFailures, lastSelected] =
        numbers(core, core.rs_sel_summary(this.#id(link)));
      return { attempts, latencyMs: orNull(latencyMs), throughputBytesPerSecond: orNull(throughputBytesPerSecond), failureRate, consecutiveFailures, lastSelected };
    }, (js) => js.summary(link));
  }

  select(links, key, tried, size, deadlineMs = Infinity) {
    return this.#run((core) => {
      // Link state stays on the JavaScript objects; the core sees handles.
      const eligible = [...links].filter((link) => !link.closed && !link.busy && !tried.has(link.pubkey) && link.have.has(key));
      const ids = eligible.map((link) => this.#id(link));
      const length = ids.length * 4;
      const pointer = core.rs_alloc(length);
      try {
        const view = new DataView(core.memory.buffer, pointer, length);
        ids.forEach((id, index) => view.setUint32(index * 4, id, true));
        const chosen = core.rs_sel_select(pointer, ids.length, size, deadlineMs);
        return chosen < 0 ? null : eligible[ids.indexOf(chosen)];
      } finally {
        core.rs_free(pointer, length);
      }
    }, (js) => js.select(links, key, tried, size, deadlineMs));
  }
}

/**
 * Load the core. `source` is a URL, the module's bytes or a compiled
 * WebAssembly.Module. `verifier` mirrors segment-commitment.mjs: a trap
 * inside the module throws; rejection returns null. `peerSelection()` returns
 * this instance's selection, once, `neighbourDiscovery(clock)` its
 * discovery, once, and `peerLink(options)` a PeerLink backed by the core.
 * A trap in selection, discovery or a link retires the whole instance:
 * selection and discovery move to fresh JavaScript instances, every core
 * link closes as `host`, and `onFailure(error)` runs once. `retire()` does the
 * same without the callback, for a trap the caller caught itself.
 */
export async function loadCore(source, { onFailure } = {}) {
  const exports = (await instantiate(source)).exports;
  for (const name of ["memory", "rs_alloc", "rs_free", "rs_call", "rs_result_ptr", ...SELECTION_EXPORTS]) {
    if (!exports[name]) throw new Error(`Core module lacks ${name}.`);
  }
  let retired = false, selection = null, discovery = null;
  const retire = () => {
    if (retired) return;
    retired = true;
    selection?.retire();
    discovery?.retire();
    for (const link of [...host.links]) link.die();
  };
  const fail = (error) => {
    if (retired) return;
    retire();
    try { onFailure?.(error); } catch {}
  };
  // What CorePeerLink needs from the instance. Results are copied out before
  // any callback runs, since a callback may call in again.
  const host = {
    links: new Set(),
    // Optional so new JavaScript can still use a previously pinned core.
    rangeUploads: typeof exports.rs_link_serve_range === "function",
    newLink(maxSegmentBytes, maxQueuedRequests, drainTimeoutMs, reliable, now) {
      if (retired) throw new Error("The core has been retired.");
      return exports.rs_link_new(maxSegmentBytes, maxQueuedRequests, drainTimeoutMs, reliable ? 1 : 0, now);
    },
    free(handle) {
      if (retired) return;
      try { exports.rs_link_free(handle); } catch (error) { fail(error); }
    },
    call(handle, op, now, channel, a, b, bytes) {
      if (retired) return null;
      try {
        const size = withBytes(exports, bytes, (pointer, length) => op === LINK_SERVE_RANGE && host.rangeUploads
          ? exports.rs_link_serve_range(handle, now, channel, a, b, pointer, length)
          : exports.rs_link_call(handle, op, now, channel, a, b, pointer, length));
        if (size < 0 || size < LINK_HEADER_BYTES) throw new Error(`Core link ${handle} refused operation ${op}.`);
        return readLinkFrame(exports, size);
      } catch (error) {
        fail(error);
        return null;
      }
    },
    sets(handle) {
      if (retired) return null;
      try {
        const size = withBytes(exports, EMPTY_BYTES, (pointer, length) => exports.rs_link_call(handle, LINK_SETS, 0, 0, 0, 0, pointer, length));
        if (size < 0) throw new Error(`Core link ${handle} refused operation ${LINK_SETS}.`);
        return JSON.parse(decoder.decode(resultBytes(exports, size)));
      } catch (error) {
        fail(error);
        return null;
      }
    },
  };

  function call(op, input) {
    let bytes;
    try { bytes = encoder.encode(JSON.stringify(input)); } catch { return null; }
    const length = withBytes(exports, bytes, (pointer, size) => exports.rs_call(op, pointer, size));
    return length < 0 ? null : JSON.parse(decoder.decode(resultBytes(exports, length)));
  }

  // One discovery operation: JSON arguments in, JSON out. Throws on a trap
  // or a refusal, which CoreNeighbourDiscovery reports through `fail`.
  function discoveryCall(op, now, args) {
    if (retired) throw new Error("The core has been retired.");
    const bytes = encoder.encode(JSON.stringify(args));
    const length = withBytes(exports, bytes, (pointer, size) => exports.rs_disc_call(op, now, pointer, size));
    if (length < 0) throw new Error(`Core discovery refused operation ${op}.`);
    return JSON.parse(decoder.decode(resultBytes(exports, length)));
  }

  const trust = ({ streamEvent, swarmId, revokedDelegationIds = [], delegationRevocations = [] }) =>
    ({ streamEvent, swarmId, revokedDelegationIds, delegationRevocations });

  const verifier = Object.freeze({
    kind: "wasm",
    validStreamAuthorisation: (event) => call(OP_STREAM, [event]) === true,
    verifyCommitmentDelegation: (event, options, at = Date.now()) => call(OP_DELEGATION, [event ?? null, trust(options), at]),
    verifySegmentCommitment(event, options, at = Date.now()) {
      let context;
      try { context = reduceFragmentContext(options.context); } catch { return null; }
      return call(OP_COMMITMENT, [event ?? null, { ...trust(options), key: options.key, context,
        maxSegmentBytes: options.maxSegmentBytes, delegation: options.delegation ?? null }, at]);
    },
  });
  return Object.freeze({
    verifier,
    playerHint(supply) {
      if (retired) return null;
      try { return call(OP_PLAYER_HINT, supply); } catch (error) { fail(error); return null; }
    },
    retire,
    get retired() { return retired; },
    peerSelection() {
      if (selection) throw new Error("This core instance already has a peer selection.");
      return selection = new CorePeerSelection(exports, fail);
    },
    neighbourDiscovery(clock) {
      if (discovery) throw new Error("This core instance already has a neighbour discovery.");
      if (retired) throw new Error("The core has been retired.");
      return discovery = new CoreNeighbourDiscovery(discoveryCall, fail, clock);
    },
    peerLink(options) {
      return new CorePeerLink(options, host);
    },
    // One schema 3 object across several holders, or null when this module
    // has no scheduler or the pieces do not fit the size.
    transfer({ size, sha256, pieces, deadline, maxHolders, originReserveMs }) {
      if (retired || !TRANSFER_EXPORTS.every((name) => typeof exports[name] === "function")) return null;
      try {
        const handle = withBytes(exports, encoder.encode(JSON.stringify({ sha256, pieces })),
          (pointer, length) => exports.rs_xfer_new(size, deadline, maxHolders, originReserveMs, pointer, length));
        return handle ? new CoreTransfer(exports, handle, () => retired, fail) : null;
      } catch (error) { fail(error); return null; }
    },
  });
}

const TRANSFER_EXPORTS = ["rs_xfer_new", "rs_xfer_call", "rs_xfer_free"];
const XFER = { start: 0, delivered: 1, failed: 2, tick: 3, state: 4, progress: 5 };

/** The Rust `Transfer` for one object. Each call returns `{ commands, next,
 * late, finished, verified, bytes }`, `verified` being the object's bytes
 * verified so far (each piece once), or null once the core has failed. Sources are a
 * peer's numeric ID, or "origin". */
class CoreTransfer {
  #exports; #handle; #retired; #fail;
  constructor(exports, handle, retired, fail) { this.#exports = exports; this.#handle = handle; this.#retired = retired; this.#fail = fail; }
  start(now, { peers, origin, sharedFirstByteMs = null, sharedRate = null }) {
    return this.#call(XFER.start, now, -1, 0, 0, encoder.encode(JSON.stringify({ peers, origin, sharedFirstByteMs, sharedRate })));
  }
  delivered(now, source, range, bytes) { return this.#call(XFER.delivered, now, source, range.start, range.end, bytes); }
  failed(now, source) { return this.#call(XFER.failed, now, source, 0, 0, EMPTY_BYTES); }
  tick(now) { return this.#call(XFER.tick, now, -1, 0, 0, EMPTY_BYTES); }
  /** Bytes received so far on the peer's in-flight ranged request. */
  progress(now, source, received) { return this.#call(XFER.progress, now, source, received, 0, EMPTY_BYTES); }
  free() {
    if (this.#handle === null) return;
    const handle = this.#handle;
    this.#handle = null;
    if (!this.#retired()) try { this.#exports.rs_xfer_free(handle); } catch (error) { this.#fail(error); }
  }
  #call(op, now, source, a, b, bytes) {
    if (this.#handle === null || this.#retired()) return null;
    const exports = this.#exports;
    try {
      const length = withBytes(exports, bytes,
        (pointer, size) => exports.rs_xfer_call(this.#handle, op, Math.floor(now), source === "origin" ? -1 : source, a, b, pointer, size));
      if (length < 4) throw new Error(`Core transfer refused operation ${op}.`);
      // Read straight from module memory: the JSON is decoded and a delivered
      // object copied once into its own buffer before anything can call in.
      const out = resultBytes(exports, length);
      const jsonLength = new DataView(out.buffer, out.byteOffset, length).getUint32(0, true);
      const state = JSON.parse(decoder.decode(out.subarray(4, 4 + jsonLength)));
      const object = length > 4 + jsonLength ? out.slice(4 + jsonLength) : null;
      const commands = state.c.map((command) => command.p ? { ...command, range: { start: command.p[0], end: command.p[1] } } : command);
      return { commands, next: state.next, late: state.late, finished: state.finished, verified: state.verified ?? null, bytes: object };
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }
}
const EMPTY_BYTES = new Uint8Array(0);

/** Load the core's commitment verifiers only. */
export async function loadCoreVerifier(source) {
  return (await loadCore(source)).verifier;
}
