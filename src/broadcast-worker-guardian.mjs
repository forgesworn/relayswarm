import { constants } from "node:fs";
import { open, lstat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { fork } from "node:child_process";
import { controlWorkerGroup, stopWorkerGroups } from "./broadcast-worker-group.mjs";
import { acquireExclusiveStateLease } from "./exclusive-state-lease.mjs";
import { safeWorkerFailure, workerFailureReason } from "./broadcast-worker-diagnostics.mjs";

// Own the worker lease independently of the publisher. The IPC channel dying
// means the publisher has gone; workers must die before this lease is released.
const workers = new Map();
let lease, stopping = false, stopPromise, marked = false;
let firstFailure;
function noteFailure(stage, error) { firstFailure ??= safeWorkerFailure(stage, workerFailureReason(error)); }
function reportFailure(stage = "stop-unknown", error) {
  noteFailure(stage, error);
  send({ type: "failed", ...firstFailure });
}
const dirtyMarker = `${process.argv[2]}.dirty`;
let preparedResolve; const prepared = new Promise((done) => { preparedResolve = done; });
const send = (message, callback = () => {}) => { if (process.connected) process.send(message, callback); else callback(); };
function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    await prepared;
    const live = [...workers.values()];
    let clean = false;
    try { await stopWorkerGroups(live); clean = true; }
    catch (error) { noteFailure("stop-await-workers", error); throw error; }
    finally {
      try {
        if (marked && clean) {
          try { await rm(dirtyMarker); }
          catch (error) { noteFailure("marker-remove", error); throw error; }
          let directory;
          try { directory = await open(dirname(dirtyMarker), constants.O_RDONLY); }
          catch (error) { noteFailure("stop-directory-open", error); throw error; }
          try {
            try { await directory.sync(); }
            catch (error) { noteFailure("stop-directory-sync", error); throw error; }
          } finally {
            try { await directory.close(); }
            catch (error) { noteFailure("stop-directory-close", error); throw error; }
          }
        }
      } finally {
        try { lease?.close(); }
        catch (error) { noteFailure("lease-close", error); throw error; }
      }
    }
    try { await new Promise((done) => send({ type: "stopped" }, done)); }
    catch (error) { noteFailure("stopped-send", error); throw error; }
    try { if (process.connected) process.disconnect(); }
    catch (error) { noteFailure("stop-disconnect", error); throw error; }
  })();
  return stopPromise;
}
const stopFailed = (error) => { reportFailure("stop-unknown", error); process.exitCode = 1; };
process.on("disconnect", () => { stop().catch(stopFailed); });
process.on("SIGTERM", () => { stop().catch(stopFailed); });
process.on("SIGINT", () => { stop().catch(stopFailed); });
process.on("message", (message) => {
  if (message?.type === "stop") { stop().catch(stopFailed); return; }
  if (stopping || !lease || !process.connected) return;
  if (message?.type === "kill") { const worker = workers.get(message.id); if (worker && ["SIGTERM", "SIGKILL"].includes(message.signal)) worker.group.signal(message.signal); return; }
  if (message?.type !== "start" || typeof message.id !== "string" || workers.has(message.id) || workers.size >= 4 || typeof message.executable !== "string" || !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== "string")) return;
  const child = fork(new URL("./broadcast-worker-group.mjs", import.meta.url), [], {
    stdio: ["ignore", message.captureStdout ? "pipe" : "ignore", "pipe", "ipc"],
    detached: true, windowsHide: true, execArgv: [],
  });
  const group = controlWorkerGroup(child, {
    configure: { executable: message.executable, args: message.args },
    onSpawn: () => send({ type: "spawn", id: message.id }),
    onError: (code) => send({ type: "error", id: message.id, code }),
  });
  let finish, refuse; const closed = new Promise((done, reject) => { finish = done; refuse = reject; });
  closed.catch(() => {});
  workers.set(message.id, { child, group, closed });
  child.stdout?.on("data", (buffer) => {
    child.stdout.pause(); let pending = Math.ceil(buffer.length / 8192);
    for (let offset = 0; offset < buffer.length; offset += 8192) send({ type: "stdout", id: message.id, data: buffer.subarray(offset, offset + 8192).toString("base64") }, () => { if (--pending === 0) child.stdout.resume(); });
  });
  child.stderr.on("data", () => {}); // Credential-bearing errors stay private.
  group.closed.then(({ code }) => {
    try {
      workers.delete(message.id); send({ type: "close", id: message.id, code }); finish();
    } catch (error) { refuse(error); reportFailure("worker-close-notify", error); }
  }, async (error) => {
    noteFailure("worker-group-probe", error);
    refuse(error); reportFailure();
    await stop().catch((error) => { reportFailure("stop-unknown", error); process.exitCode = 1; if (process.connected) process.disconnect(); });
  });
});
let startupPhase = "lease-acquire";
try {
  // Retry only a kernel refusal while a crashed owner's guardian drains its
  // workers. Never reclaim or unlink the permanent worker lease inode.
  const deadline = Date.now() + 5000;
  while (!stopping) {
    try { lease = await acquireExclusiveStateLease(process.argv[2]); break; }
    catch (error) {
      if (error.cause?.errcode !== 5 || Date.now() >= deadline) throw error;
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  if (lease) {
    startupPhase = "marker-check";
    try { await lstat(dirtyMarker); throw new Error("Unclean worker ownership requires operator recovery."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    startupPhase = "marker-create";
    const handle = await open(dirtyMarker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      startupPhase = "marker-write"; await handle.writeFile("1\n");
      startupPhase = "marker-sync"; await handle.sync(); marked = true;
    } catch (error) { noteFailure(startupPhase, error); throw error; }
    finally {
      try { await handle.close(); }
      catch (error) { noteFailure("marker-close", error); throw error; }
    }
    startupPhase = "startup-directory-open";
    const directory = await open(dirname(dirtyMarker), constants.O_RDONLY);
    try { startupPhase = "startup-directory-sync"; await directory.sync(); }
    catch (error) { noteFailure(startupPhase, error); throw error; }
    finally {
      try { await directory.close(); }
      catch (error) { noteFailure("startup-directory-close", error); throw error; }
    }
  }
  preparedResolve();
  if (stopping || !process.connected) { await stop(); }
  else send({ type: "ready" });
} catch (error) { noteFailure(startupPhase, error); preparedResolve(); reportFailure(); await stop().catch(() => {}); process.exitCode = 1; }
