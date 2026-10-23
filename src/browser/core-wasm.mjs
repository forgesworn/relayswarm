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

const SELECTION_EXPORTS = ["rs_sel_observe", "rs_sel_record", "rs_sel_forget", "rs_sel_select", "rs_sel_state",
  "rs_sel_project", "rs_sel_minimum", "rs_sel_estimate", "rs_sel_summary", "rs_link_new", "rs_link_free", "rs_link_call", "rs_disc_call"];
const LINK_SETS = 13;
const LINK_HEADER_BYTES = 13 * 8;
const orNull = (value) => Number.isNaN(value) ? null : value;
// Read memory only after the call: a call can grow it, detaching the old buffer.
const numbers = (core, pointer) => new Float64Array(core.memory.buffer, pointer, 6);

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
        const length = bytes.byteLength, pointer = exports.rs_alloc(length);
        let size;
        try {
          new Uint8Array(exports.memory.buffer, pointer, length).set(bytes);
          size = exports.rs_link_call(handle, op, now, channel, a, b, pointer, length);
        } finally {
          exports.rs_free(pointer, length);
        }
        if (size < 0 || (op !== LINK_SETS && size < LINK_HEADER_BYTES)) throw new Error(`Core link ${handle} refused operation ${op}.`);
        return new Uint8Array(exports.memory.buffer, exports.rs_result_ptr(), size).slice();
      } catch (error) {
        fail(error);
        return null;
      }
    },
    sets(handle) {
      const bytes = host.call(handle, LINK_SETS, 0, 0, 0, 0, new Uint8Array(0));
      if (!bytes) return null;
      try { return JSON.parse(decoder.decode(bytes)); } catch (error) { fail(error); return null; }
    },
  };

  function call(op, input) {
    let bytes;
    try { bytes = encoder.encode(JSON.stringify(input)); } catch { return null; }
    const pointer = exports.rs_alloc(bytes.length);
    try {
      new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
      const length = exports.rs_call(op, pointer, bytes.length);
      if (length < 0) return null;
      return JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, exports.rs_result_ptr(), length)));
    } finally {
      exports.rs_free(pointer, bytes.length);
    }
  }

  // One discovery operation: JSON arguments in, JSON out. Throws on a trap
  // or a refusal, which CoreNeighbourDiscovery reports through `fail`.
  function discoveryCall(op, now, args) {
    if (retired) throw new Error("The core has been retired.");
    const bytes = encoder.encode(JSON.stringify(args));
    const pointer = exports.rs_alloc(bytes.length);
    let length;
    try {
      new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
      length = exports.rs_disc_call(op, now, pointer, bytes.length);
    } finally {
      exports.rs_free(pointer, bytes.length);
    }
    if (length < 0) throw new Error(`Core discovery refused operation ${op}.`);
    return JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, exports.rs_result_ptr(), length)));
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
  });
}

/** Load the core's commitment verifiers only. */
export async function loadCoreVerifier(source) {
  return (await loadCore(source)).verifier;
}
