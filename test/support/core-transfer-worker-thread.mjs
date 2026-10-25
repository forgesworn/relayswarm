// Real worker-thread transport for the browser worker runtime, without a
// browser shim, media fixture, network access or a second verifier.
import { parentPort } from "node:worker_threads";
import { createCoreTransferWorkerRuntime } from "../../src/browser/core-transfer-worker-runtime.mjs";

const receive = createCoreTransferWorkerRuntime((message, transfer) => parentPort.postMessage(message, transfer));
parentPort.on("message", data => { void receive({ data }); });
