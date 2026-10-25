// Explicit companion entry. Bundle this module separately and pass its URL to
// createCoreTransferWorker; it never fetches a module or chooses another verifier.
import { loadTransferCore } from "./core-transfer.mjs";
import { coreTransferWorkerArguments, coreTransferWorkerConfig, coreTransferWorkerLimits } from "./core-transfer-worker.mjs";

export function createCoreTransferWorkerRuntime(send) {
  let core = null, limits = null, failed = false, initialising = false, activeBytes = 0;
  const handles = new Map();
  const respond = (id, result) => send({ v: 1, id, ok: true, result }, result?.bytes ? [result.bytes.buffer] : []);
  const error = (id, code, fatal = false) => { if (fatal) failed = true; send({ v: 1, id, ok: false, error: code, fatal }); };
  return async function receive({ data }) {
    if (!data || data.v !== 1 || !Number.isSafeInteger(data.id) || data.id < 1 || typeof data.op !== "string") return;
    const { id, op, handle, input } = data;
    if (failed) return error(id, "worker-failed", true);
    try {
      if (op === "init") {
        if (core || initialising || !(input?.module instanceof WebAssembly.Module)) return error(id, "invalid-init", true);
        initialising = true; limits = coreTransferWorkerLimits(input.limits);
        core = await loadTransferCore(input.module, { onFailure: () => { failed = true; } });
        if (failed) return error(id, "core-failed", true);
        return respond(id, true);
      }
      if (!core) return error(id, "not-ready");
      if (!Number.isSafeInteger(handle) || handle < 1) return error(id, "invalid-handle");
      if (op === "new") {
        const config = coreTransferWorkerConfig(input, limits);
        if (handles.has(handle) || handles.size >= limits.maxTransfers || activeBytes + config.size > limits.maxActiveBytes) return error(id, "transfer-limit");
        const transfer = core.transfer(config);
        if (!transfer) return error(id, failed || core.retired ? "core-failed" : "invalid-transfer", failed || core.retired);
        handles.set(handle, { transfer, size: config.size }); activeBytes += config.size;
        return respond(id, true);
      }
      const record = handles.get(handle);
      if (op === "free") {
        if (record) { record.transfer.free(); handles.delete(handle); activeBytes -= record.size; }
        return failed || core.retired ? error(id, "core-failed", true) : respond(id, true);
      }
      if (!record) return error(id, "unknown-transfer");
      if (!["start", "delivered", "failed", "progress", "tick"].includes(op) || !Array.isArray(input)) return error(id, "invalid-operation");
      const args = coreTransferWorkerArguments(op, input, limits.maxSegmentBytes);
      const result = record.transfer[op](...args);
      if (!result || failed || core.retired) return error(id, "core-failed", true);
      respond(id, result);
    } catch (caught) { error(id, caught?.code ?? "worker-failed", !caught?.code); }
  };
}

if (typeof DedicatedWorkerGlobalScope !== "undefined" && globalThis instanceof DedicatedWorkerGlobalScope) {
  const receive = createCoreTransferWorkerRuntime((message, transfer) => globalThis.postMessage(message, transfer));
  globalThis.addEventListener("message", receive);
}
