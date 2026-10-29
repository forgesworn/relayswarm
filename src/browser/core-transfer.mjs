// Shared raw transfer facade. Rust alone verifies bytes and schedules pieces.
// Used by both the synchronous core and the dedicated transfer worker.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

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


export function createCoreTransfer(exports, { size, sha256, pieces, deadline, maxHolders, originReserveMs, peerOnly = false, exclusiveOrigin = false }, retired, fail) {
  if (retired() || !TRANSFER_EXPORTS.every(name => typeof exports[name] === "function")) return null;
  if (typeof peerOnly !== "boolean" || typeof exclusiveOrigin !== "boolean" || peerOnly && exclusiveOrigin) return null;
  // An older module must not silently ignore originless mode and invent an
  // HTTP lane. Decline just this object before allocation, retaining mixed.
  if (peerOnly) {
    try { if (typeof exports.rs_xfer_capabilities !== "function" || !(exports.rs_xfer_capabilities() & 2)) return null; }
    catch { return null; }
  }
  // Exclusive origin ranges require the new ownership contract. An older
  // module must decline this object before allocating a legacy transfer.
  if (exclusiveOrigin) {
    try { if (typeof exports.rs_xfer_capabilities !== "function" || !(exports.rs_xfer_capabilities() & 4)) return null; }
    catch { return null; }
  }
  try {
    const handle = withBytes(exports, encoder.encode(JSON.stringify({ sha256, pieces, ...(peerOnly ? { peerOnly: true } : {}),
      ...(exclusiveOrigin ? { exclusiveOrigin: true } : {}) })),
      (pointer, length) => exports.rs_xfer_new(size, deadline, maxHolders, originReserveMs, pointer, length));
    return handle ? new CoreTransfer(exports, handle, retired, fail, peerOnly) : null;
  } catch (error) { fail(error); return null; }
}

/** Instantiate only the transfer ABI in an already compiled module. No I/O. */
export async function loadTransferCore(module, { onFailure } = {}) {
  if (!(module instanceof WebAssembly.Module)) throw new TypeError("A compiled core module is required.");
  const { exports } = await WebAssembly.instantiate(module, {});
  for (const name of ["memory", "rs_alloc", "rs_free", "rs_result_ptr", ...TRANSFER_EXPORTS]) {
    if (!exports[name]) throw new Error(`Core transfer module lacks ${name}.`);
  }
  let retired = false;
  const fail = error => { if (!retired) { retired = true; try { onFailure?.(error); } catch {} } };
  return Object.freeze({
    get retired() { return retired; },
    retire() { retired = true; },
    transfer(config) { return createCoreTransfer(exports, config, () => retired, fail); },
  });
}

const TRANSFER_EXPORTS = ["rs_xfer_new", "rs_xfer_call", "rs_xfer_free"];
const XFER = { start: 0, delivered: 1, failed: 2, tick: 3, state: 4, progress: 5 };

/** The Rust `Transfer` for one object. Each call returns `{ commands, next,
 * late, finished, verified, bytes }`, `verified` being the object's bytes
 * verified so far (each piece once), or null once the core has failed. Sources are a
 * peer's numeric ID, or "origin". */
class CoreTransfer {
  #exports; #handle; #retired; #fail; #peerOnly;
  constructor(exports, handle, retired, fail, peerOnly = false) { this.#exports = exports; this.#handle = handle; this.#retired = retired; this.#fail = fail; this.#peerOnly = peerOnly; }
  start(now, { peers, origin, sharedFirstByteMs = null, sharedRate = null, probePeers = [] }) {
    let boundedProbes = false;
    try { boundedProbes = typeof this.#exports.rs_xfer_capabilities === "function" && Boolean(this.#exports.rs_xfer_capabilities() & 1); } catch {}
    // Old modules cannot express this cap. Drop those sources rather than
    // silently turning a calibration request into a whole-object assignment.
    const probes = new Set(probePeers);
    const eligible = boundedProbes ? peers : peers.filter(([id]) => !probes.has(id));
    return this.#call(XFER.start, now, -1, 0, 0, encoder.encode(JSON.stringify({ peers: eligible, origin: this.#peerOnly ? null : origin, sharedFirstByteMs, sharedRate,
      ...(boundedProbes ? { probePeers } : {}) })));
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
