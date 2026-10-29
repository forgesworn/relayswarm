// Standalone prototype: the host explicitly packages a companion worker and
// opts in. Existing synchronous core/native transfer APIs remain unchanged.
const MIB = 1024 * 1024;
const DEFAULTS = Object.freeze({ maxTransfers: 2, maxSegmentBytes: 16 * MIB, maxActiveBytes: 32 * MIB,
  maxPending: 32, maxPendingBytes: 32 * MIB, initTimeoutMs: 5_000, operationTimeoutMs: 5_000 });
const MAXIMUMS = Object.freeze({ maxTransfers: 4, maxSegmentBytes: 32 * MIB, maxActiveBytes: 64 * MIB,
  maxPending: 128, maxPendingBytes: 64 * MIB, initTimeoutMs: 30_000, operationTimeoutMs: 30_000 });
const hash = value => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const time = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const estimate = value => value === null || time(value);
const validFrame = (value, size) => value && Array.isArray(value.commands) && value.commands.length <= 1_024
  && value.commands.every(command => command && ["request", "origin", "cancel", "abandon", "ban", "deliver", "fail"].includes(command.t))
  && (value.next === null || time(value.next)) && typeof value.late === "boolean" && typeof value.finished === "boolean"
  && (value.verified === null || (integer(value.verified) && value.verified <= size))
  && (value.bytes === null || (value.bytes instanceof Uint8Array && value.bytes.byteLength <= size));

export class CoreTransferWorkerError extends Error {
  constructor(code) { super(`Core transfer worker: ${code}.`); this.name = "CoreTransferWorkerError"; this.code = code; }
}
const abortError = () => new DOMException("Core transfer was cancelled.", "AbortError");

/** Shared with the companion runtime; every limit has a finite hard maximum. */
export function coreTransferWorkerLimits(options = {}) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULTS)) {
    const value = options[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUMS[key]) throw new CoreTransferWorkerError("invalid-limits");
    limits[key] = value;
  }
  return Object.freeze(limits);
}

export function coreTransferWorkerConfig(value, limits) {
  if (!value || !Array.isArray(value.pieces) || value.pieces.length < 1 || value.pieces.length > 256) throw new CoreTransferWorkerError("invalid-transfer");
  const config = value && { size: value.size, sha256: value.sha256, pieces: value.pieces?.slice(),
    deadline: value.deadline, maxHolders: value.maxHolders, originReserveMs: value.originReserveMs,
    ...(value.peerOnly === true ? { peerOnly: true } : {}),
    ...(value.exclusiveOrigin === true ? { exclusiveOrigin: true } : {}) };
  if (!config || !integer(config.size) || config.size < 1 || config.size > limits.maxSegmentBytes
    || !hash(config.sha256) || !Array.isArray(config.pieces) || config.pieces.length < 1 || config.pieces.length > 256
    || !config.pieces.every(hash) || !time(config.deadline) || !integer(config.maxHolders) || config.maxHolders < 1
    || config.maxHolders > 32 || !time(config.originReserveMs) || (value.peerOnly !== undefined && typeof value.peerOnly !== "boolean")
    || (value.exclusiveOrigin !== undefined && typeof value.exclusiveOrigin !== "boolean")
    || config.peerOnly && config.exclusiveOrigin) throw new CoreTransferWorkerError("invalid-transfer");
  return config;
}

export function coreTransferWorkerArguments(op, args, maxSegmentBytes, peerOnly = false) {
  const [at, source, value] = args;
  if (!time(at)) throw new CoreTransferWorkerError("invalid-operation");
  if (op === "start") {
    const input = source;
    if (!input || !Array.isArray(input.peers) || input.peers.length > 32
      || !input.peers.every(row => Array.isArray(row) && row.length === 3 && integer(row[0]) && estimate(row[1]) && estimate(row[2]))
      || (peerOnly ? input.origin != null : !Array.isArray(input.origin) || input.origin.length !== 2 || !input.origin.every(estimate))
      || !estimate(input.sharedFirstByteMs ?? null) || !estimate(input.sharedRate ?? null)
      || !Array.isArray(input.probePeers ?? []) || (input.probePeers?.length ?? 0) > 32 || !(input.probePeers ?? []).every(integer)) {
      throw new CoreTransferWorkerError("invalid-operation");
    }
    return [at, { peers: input.peers.map(row => [...row]), origin: peerOnly ? null : [...input.origin],
      sharedFirstByteMs: input.sharedFirstByteMs ?? null, sharedRate: input.sharedRate ?? null, probePeers: [...(input.probePeers ?? [])] }];
  }
  if (op === "tick") return [at];
  if (source !== "origin" && !integer(source)) throw new CoreTransferWorkerError("invalid-operation");
  if (peerOnly && source === "origin") throw new CoreTransferWorkerError("invalid-operation");
  if (op === "failed") return [at, source];
  if (op === "progress" && integer(value) && value <= maxSegmentBytes) return [at, source, value];
  if (op === "delivered" && value && integer(value.start) && integer(value.end) && value.start < value.end && value.end <= 256) {
    const bytes = args[3];
    if (bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes)) {
      const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.byteLength <= maxSegmentBytes) return [at, source, { start: value.start, end: value.end }, view];
    }
  }
  throw new CoreTransferWorkerError("invalid-operation");
}

/**
 * One dedicated worker per opted-in swarm. `workerUrl` must be an explicitly
 * packaged companion; no adjacent asset is assumed after bundling this file.
 * Frames and hashes come only from the existing Rust module. Calls are async.
 */
export async function createCoreTransferWorker({ module, workerUrl, workerFactory, signal, onFailure, ...options } = {}) {
  const limits = coreTransferWorkerLimits(options);
  if (!(module instanceof WebAssembly.Module)) throw new CoreTransferWorkerError("invalid-module");
  if (signal?.aborted) throw abortError();
  if (!workerFactory && (!(workerUrl instanceof URL || (typeof workerUrl === "string" && workerUrl.length > 0 && workerUrl.length <= 2_048))
    || typeof globalThis.Worker !== "function")) throw new CoreTransferWorkerError("worker-unavailable");
  const factory = workerFactory ?? ((url, opts) => new Worker(url, opts));
  let worker;
  try { worker = factory(workerUrl, { type: "module", name: "relayswarm-transfer" }); }
  catch { throw new CoreTransferWorkerError("worker-unavailable"); }
  let state = "loading", reason = null, nextRequest = 0, nextHandle = 0, pendingBytes = 0, activeBytes = 0;
  const pending = new Map(), handles = new Map();
  const release = record => {
    record.signal?.removeEventListener("abort", record.onAbort);
    if (handles.get(record.id) === record) { handles.delete(record.id); activeBytes -= record.size; }
  };
  const retire = (error, notify = true) => {
    if (state === "stopped" || state === "failed") return;
    state = notify ? "failed" : "stopped"; reason = error.code ?? error.name;
    worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError);
    worker.removeEventListener("messageerror", onError); signal?.removeEventListener("abort", onAbort);
    for (const entry of pending.values()) { clearTimeout(entry.timer); if (!entry.settled) entry.reject(error); }
    pending.clear(); pendingBytes = 0;
    for (const record of handles.values()) { record.closed = true; release(record); }
    try { const result = worker.terminate(); result?.catch?.(() => {}); } catch {}
    if (notify) try { onFailure?.(error)?.catch?.(() => {}); } catch {}
  };
  const onError = event => { event?.preventDefault?.(); retire(new CoreTransferWorkerError("worker-error")); };
  const onAbort = () => retire(abortError(), false);
  const onMessage = ({ data }) => {
    if (!data || data.v !== 1 || !integer(data.id) || !pending.has(data.id)) return;
    const entry = pending.get(data.id);
    pending.delete(data.id); pendingBytes -= entry.bytes; clearTimeout(entry.timer);
    if (data.ok !== true) {
      const error = new CoreTransferWorkerError(typeof data.error === "string" && /^[a-z-]{1,40}$/.test(data.error) ? data.error : "invalid-response");
      if (!entry.settled) entry.reject(error);
      if (data.fatal || data.ok !== false) retire(error);
    } else if (["init", "new", "free"].includes(entry.op) ? data.result !== true : !validFrame(data.result, entry.size)) {
      const error = new CoreTransferWorkerError("invalid-response");
      if (!entry.settled) entry.reject(error);
      retire(error);
    } else if (!entry.settled) entry.resolve(data.result);
  };
  const rpc = (op, handle, input, bytes = 0, transfer = [], control = false) => {
    if (state === "stopped" || state === "failed") return Promise.reject(new CoreTransferWorkerError("closed"));
    if ((!control && pending.size >= limits.maxPending) || pendingBytes + bytes > limits.maxPendingBytes) {
      return Promise.reject(new CoreTransferWorkerError("queue-limit"));
    }
    return new Promise((resolve, reject) => {
      const id = ++nextRequest;
      const entry = { resolve, reject, handle, bytes, op, size: handles.get(handle)?.size ?? limits.maxSegmentBytes, settled: false,
        timer: setTimeout(() => retire(new CoreTransferWorkerError(op === "init" ? "init-timeout" : "operation-timeout")),
          op === "init" ? limits.initTimeoutMs : limits.operationTimeoutMs) };
      pending.set(id, entry); pendingBytes += bytes;
      try { worker.postMessage({ v: 1, id, op, handle, input }, transfer); }
      catch { retire(new CoreTransferWorkerError("worker-message")); }
    });
  };
  worker.addEventListener("message", onMessage); worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onError); signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try { await rpc("init", null, { module, limits }); }
  catch (error) { retire(error); throw error; }
  if (state !== "loading") throw new CoreTransferWorkerError("closed");
  state = "ready";
  return Object.freeze({
    snapshot: () => ({ state, reason, transfers: handles.size, activeBytes, pending: pending.size, pendingBytes }),
    stop: onAbort,
    async transfer(value, { signal: transferSignal } = {}) {
      if (state !== "ready") throw new CoreTransferWorkerError("closed");
      if (transferSignal?.aborted) throw abortError();
      const config = coreTransferWorkerConfig(value, limits);
      if (handles.size >= limits.maxTransfers || activeBytes + config.size > limits.maxActiveBytes) throw new CoreTransferWorkerError("transfer-limit");
      const record = { id: ++nextHandle, size: config.size, closed: false, signal: transferSignal, release: null };
      handles.set(record.id, record); activeBytes += config.size;
      const free = () => {
        if (record.release) return record.release;
        record.closed = true;
        for (const entry of pending.values()) if (entry.handle === record.id && !entry.settled) { entry.settled = true; entry.reject(abortError()); }
        // A control slot per handle stays available even when data work fills
        // the queue. Its acknowledgement, or a genuine deadline, owns cleanup.
        return record.release = rpc("free", record.id, null, 0, [], true).then(() => true, () => false).finally(() => release(record));
      };
      record.onAbort = () => { void free(); };
      transferSignal?.addEventListener("abort", record.onAbort, { once: true });
      try { await rpc("new", record.id, config); }
      catch (error) { if (!record.closed) release(record); throw error; }
      if (record.closed || transferSignal?.aborted) { void free(); throw abortError(); }
      const call = async (op, args) => {
        if (record.closed) throw new CoreTransferWorkerError("closed-transfer");
        try {
          const input = coreTransferWorkerArguments(op, args, limits.maxSegmentBytes, config.peerOnly === true);
          let bytes = 0, transfer = [];
          if (op === "delivered") {
            bytes = input[3].byteLength;
            if (pendingBytes + bytes > limits.maxPendingBytes) throw new CoreTransferWorkerError("queue-limit");
            // Transfer our own exact view. The caller's range/origin buffer is
            // retained for its existing accounting, cache and trace lifecycle.
            input[3] = input[3].slice(); transfer = [input[3].buffer];
          }
          const result = await rpc(op, record.id, input, bytes, transfer);
          if (record.closed) throw abortError();
          return result;
        } catch (error) { void free(); throw error; }
      };
      return Object.freeze({
        start: (at, input) => call("start", [at, input]),
        delivered: (at, source, range, bytes) => call("delivered", [at, source, range, bytes]),
        failed: (at, source) => call("failed", [at, source]),
        progress: (at, source, received) => call("progress", [at, source, received]),
        tick: at => call("tick", [at]), free, cancel: free,
        get closed() { return record.closed; },
      });
    },
  });
}
