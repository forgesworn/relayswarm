import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

export async function startBroadcastWorkerControl(leasePath) {
  const guardian = fork(fileURLToPath(new URL("./broadcast-worker-guardian.mjs", import.meta.url)), [leasePath], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [] });
  const workers = new Map(); let nextId = 0, closing = false, guardianFailed = false, stoppedAcknowledged = false, closePromise, fatalCallback;
  const failure = new EventEmitter(); let startupComplete = false;
  const closed = new Promise((done) => guardian.once("close", (code, signal) => {
    for (const worker of workers.values()) { worker.stdout.end(); worker.emit("close", null); }
    workers.clear(); done({ code, signal });
  }));
  function send(message) { if (guardian.connected) guardian.send(message, (error) => { if (error && !closing) failed(); }); }
  function failed() {
    if (closing || guardianFailed) return;
    guardianFailed = true;
    for (const worker of workers.values()) { worker.stdout.end(); worker.emit("close", null); }
    workers.clear(); failure.emit("failure"); if (startupComplete) fatalCallback?.();
  }
  guardian.on("error", failed); guardian.on("disconnect", failed);
  guardian.on("message", (message) => {
    if (message?.type === "failed") { if (startupComplete) failed(); else failure.emit("failure"); return; }
    if (message?.type === "stopped") { stoppedAcknowledged = true; return; }
    if (message?.type === "ready") { failure.emit("ready"); return; }
    const worker = workers.get(message?.id); if (!worker) return;
    if (message.type === "stdout") worker.stdout.write(Buffer.from(message.data, "base64"));
    if (message.type === "spawn") worker.emit("spawn");
    if (message.type === "error") worker.emit("error", Object.assign(new Error("Broadcast worker unavailable."), { code: message.code }));
    if (message.type === "close") { workers.delete(message.id); worker.stdout.end(); worker.emit("close", message.code); }
  });
  try {
    await new Promise((done, reject) => {
      const cleanup = () => { clearTimeout(timer); failure.off("ready", ready); failure.off("failure", refuse); };
      const ready = () => { cleanup(); done(); }, refuse = () => { cleanup(); reject(new Error("Broadcast worker state is locked or unavailable.")); };
      const timer = setTimeout(refuse, 7000); failure.once("ready", ready); failure.once("failure", refuse);
    });
    startupComplete = true;
  } catch (error) { closing = true; send({ type: "stop" }); await closed; throw error; }
  return {
    guardianPid: guardian.pid,
    onFailure(callback) { fatalCallback = callback; if (guardianFailed) queueMicrotask(callback); },
    spawn(executable, args, { captureStdout = true } = {}) {
      const id = String(++nextId), worker = new EventEmitter();
      worker.stdout = new PassThrough(); worker.stderr = new PassThrough();
      worker.kill = (signal) => { send({ type: "kill", id, signal }); return true; };
      workers.set(id, worker);
      queueMicrotask(() => {
        if (!guardian.connected || closing) { workers.delete(id); worker.emit("error", Object.assign(new Error("Broadcast guardian unavailable."), { code: "EWORKER" })); worker.emit("close", null); return; }
        send({ type: "start", id, executable, args, captureStdout });
      });
      return worker;
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; send({ type: "stop" });
      closePromise = closed.then(({ code, signal }) => {
        if (!stoppedAcknowledged || code !== 0 || signal) throw new Error(`Worker guardian exited without verified clean shutdown (ack=${stoppedAcknowledged}, code=${code}, signal=${signal}).`);
      });
      return closePromise;
    },
  };
}
