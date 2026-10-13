import { constants } from "node:fs";
import { open, lstat, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { acquireExclusiveStateLease } from "./exclusive-state-lease.mjs";

// Own the worker lease independently of the publisher. The IPC channel dying
// means the publisher has gone; workers must die before this lease is released.
const workers = new Map();
let lease, stopping = false, stopPromise, marked = false;
const dirtyMarker = `${process.argv[2]}.dirty`;
let preparedResolve; const prepared = new Promise((done) => { preparedResolve = done; });
const send = (message, callback = () => {}) => { if (process.connected) process.send(message, callback); else callback(); };
function kill(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
}
async function reapGroup(child) {
  if (!child.pid) return;
  kill(child, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (true) {
    try { process.kill(-child.pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    if (Date.now() >= deadline) throw new Error("Worker process group could not be proved stopped.");
    await new Promise((done) => setTimeout(done, 20));
  }
}
function stop() {
  if (stopPromise) return stopPromise;
  stopping = true;
  stopPromise = (async () => {
    await prepared;
    const live = [...workers.values()];
    for (const worker of live) kill(worker.child, "SIGTERM");
    const force = setTimeout(() => { for (const worker of live) kill(worker.child, "SIGKILL"); }, 1500);
    let clean = false;
    try { await Promise.all(live.map((worker) => worker.closed)); clean = true; }
    finally {
      clearTimeout(force);
      try {
        if (marked && clean) {
          await rm(dirtyMarker);
          const directory = await open(dirname(dirtyMarker), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
        }
      } finally { lease?.close(); }
    }
    await new Promise((done) => send({ type: "stopped" }, done));
    if (process.connected) process.disconnect();
  })();
  return stopPromise;
}
process.on("disconnect", () => { stop().catch(() => { process.exitCode = 1; }); });
process.on("SIGTERM", () => { stop().catch(() => { process.exitCode = 1; }); });
process.on("SIGINT", () => { stop().catch(() => { process.exitCode = 1; }); });
process.on("message", (message) => {
  if (message?.type === "stop") { stop().catch(() => { process.exitCode = 1; }); return; }
  if (stopping || !lease || !process.connected) return;
  if (message?.type === "kill") { const worker = workers.get(message.id); if (worker && ["SIGTERM", "SIGKILL"].includes(message.signal)) kill(worker.child, message.signal); return; }
  if (message?.type !== "start" || typeof message.id !== "string" || workers.has(message.id) || workers.size >= 4 || typeof message.executable !== "string" || !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== "string")) return;
  const child = spawn(message.executable, message.args, { stdio: ["ignore", message.captureStdout ? "pipe" : "ignore", "pipe"], detached: true, windowsHide: true });
  let finish, refuse; const closed = new Promise((done, reject) => { finish = done; refuse = reject; });
  closed.catch(() => {});
  workers.set(message.id, { child, closed });
  child.stdout?.on("data", (buffer) => {
    child.stdout.pause(); let pending = Math.ceil(buffer.length / 8192);
    for (let offset = 0; offset < buffer.length; offset += 8192) send({ type: "stdout", id: message.id, data: buffer.subarray(offset, offset + 8192).toString("base64") }, () => { if (--pending === 0) child.stdout.resume(); });
  });
  child.stderr.on("data", () => {}); // Credential-bearing errors stay private.
  child.once("spawn", () => send({ type: "spawn", id: message.id }));
  child.once("error", (error) => send({ type: "error", id: message.id, code: ["ENOENT", "EACCES"].includes(error.code) ? error.code : "EWORKER" }));
  child.once("close", async (code) => {
    try {
      // A leader may exit while a redirected descendant remains. Its process
      // group remains ours until every member has been killed and reaped.
      await reapGroup(child);
      workers.delete(message.id); send({ type: "close", id: message.id, code }); finish();
    } catch (error) {
      refuse(error); send({ type: "failed" });
      await stop().catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
    }
  });
});
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
    try { await lstat(dirtyMarker); throw new Error("Unclean worker ownership requires operator recovery."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const handle = await open(dirtyMarker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile("1\n"); await handle.sync(); marked = true; } finally { await handle.close(); }
    const directory = await open(dirname(dirtyMarker), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  }
  preparedResolve();
  if (stopping || !process.connected) { await stop(); }
  else send({ type: "ready" });
} catch { preparedResolve(); send({ type: "failed" }); await stop().catch(() => {}); process.exitCode = 1; }
