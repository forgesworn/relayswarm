import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function stopWorkerGroups(workers, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let failed = false, firstError;
  const note = (error) => { if (!failed) { failed = true; firstError = error; } };
  const signal = (value) => {
    for (const worker of workers) {
      try { worker.group.signal(value); } catch (error) { note(error); }
    }
  };
  signal("SIGTERM");
  const force = setTimer(() => signal("SIGKILL"), 1500);
  try {
    // One failure must not cancel the force timer for surviving siblings.
    await Promise.allSettled(workers.map((worker) => worker.closed.catch((error) => { note(error); throw error; })));
    if (failed) throw firstError;
  } finally { clearTimer(force); }
}

// The wrapper is the live group leader. Only it can signal its own group;
// the guardian's historical numeric PID is never signalling authority.
export function controlWorkerGroup(child, { configure, onSpawn = () => {}, onError = () => {},
  probe = (pid) => process.kill(-pid, 0), now = () => performance.now(),
  pause = () => new Promise((done) => setTimeout(done, 20)) } = {}) {
  let live = true, pipeClosed = false, channelClosed = false, configured = false, draining = false, stopping = false;
  let status, uncertain, observing, deadline, settled = false, pendingSends = 0, killRequested = false;
  let resolve, reject;
  const closed = new Promise((done, refuse) => { resolve = done; reject = refuse; });
  closed.catch(() => {});
  const fail = (error = new Error("Worker group ownership is unknown.")) => {
    uncertain ??= error;
    try { if (child.connected) child.disconnect(); } catch {}
    observe();
  };
  const send = (message) => {
    if (!live || !child.connected) return false;
    pendingSends++;
    let completed = false;
    const complete = (error) => {
      if (completed) return;
      completed = true; pendingSends--;
      if (error && !settled) fail(error);
    };
    try {
      child.send(message, complete);
      return true;
    } catch (error) { complete(error); return false; }
  };
  function observe() {
    deadline ??= now() + 5000;
    if (observing) return;
    observing = (async () => {
      try {
        while (true) {
          if (now() >= deadline) throw new Error("Worker process group could not be proved stopped.");
          let absent = false;
          if (child.pid) {
            try { probe(child.pid); }
            catch (error) { if (error.code === "ESRCH") absent = true; else throw error; }
          } else if (pipeClosed) absent = true;
          if (absent && pipeClosed && pendingSends === 0) {
            if (uncertain || !draining) throw uncertain ?? new Error("Worker wrapper exited without a drain witness.");
            settled = true; resolve({ code: status?.code ?? null, signal: status?.signal ?? null,
              statusKnown: !!status && (status.code !== null || status.signal !== null) }); return;
          }
          await pause();
        }
      } catch (error) {
        settled = true;
        // Release our pipe handles only after the bounded proof has failed.
        // This is not evidence that an escaped or unknown process was stopped.
        child.stdout?.destroy(); child.stderr?.destroy();
        try { if (child.connected) child.disconnect(); } catch {}
        reject(error);
      }
    })();
  }
  function signal(signal) {
    if (!["SIGTERM", "SIGKILL"].includes(signal) || !live || !child.connected || killRequested || draining) return false;
    stopping = true;
    // The first force request owns the remaining drain. Redundant IPC can race
    // the wrapper's self-kill and fail after its legitimate drain witness.
    if (signal === "SIGKILL") { killRequested = true; observe(); } // Same original five-second drain budget.
    return send({ type: "signal", signal });
  }
  child.on("message", (message) => {
    // Already queued messages on this same IPC channel can outlive 'exit'.
    // Closure or an actual IPC error remains a permanent trust boundary.
    if (pipeClosed || channelClosed || settled || uncertain) return;
    if (message?.type === "ready" && !configured) {
      if (stopping) signal("SIGKILL");
      else { configured = true; send({ type: "start", ...configure }); }
    }
    else if (message?.type === "spawn" && configured) onSpawn();
    else if (message?.type === "error" && configured) onError(["ENOENT", "EACCES"].includes(message.code) ? message.code : "EWORKER");
    else if (message?.type === "result" && configured && !status &&
      (message.code === null || Number.isInteger(message.code)) &&
      (message.signal === null || typeof message.signal === "string")) {
      status = { code: message.code, signal: message.signal }; signal("SIGKILL");
    } else if (message?.type === "draining" && (configured || stopping)) draining = true;
  });
  child.once("error", fail);
  child.once("exit", () => { live = false; observe(); });
  child.once("close", () => { live = false; pipeClosed = true; observe(); });
  child.once("disconnect", () => { channelClosed = true; if (live && !draining && !settled) fail(); });
  return { closed, signal };
}

// Import-safe so deterministic tests exercise the actual self-signalling seam.
export function signalOwnWorkerGroup(signal, owner = process) {
  if (!["SIGTERM", "SIGKILL"].includes(signal) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error("Invalid worker group signal.");
  owner.kill(-owner.pid, signal);
}

export function runWorkerGroup({ channel = process, launch = spawn,
  signalSelf = signalOwnWorkerGroup } = {}) {
  if (!channel.connected || typeof channel.send !== "function") throw new Error("Worker wrapper requires an IPC owner.");
  let started = false, finishing = false, killing = false;
  const kill = () => { if (!killing) { killing = true; signalSelf("SIGKILL"); } };
  const send = (message, callback = () => {}) => {
    if (!channel.connected) { kill(); return; }
    try { channel.send(message, (error) => { if (error) kill(); else callback(); }); }
    catch { kill(); }
  };
  channel.on("SIGTERM", () => {}); // Stay alive while the inner process drains.
  channel.on("SIGINT", () => {});
  channel.on("disconnect", kill);
  channel.on("message", (message) => {
    if (message?.type === "signal" && ["SIGTERM", "SIGKILL"].includes(message.signal)) {
      if (message.signal === "SIGTERM") signalSelf("SIGTERM");
      else send({ type: "draining" }, kill);
      return;
    }
    if (message?.type !== "start" || started || typeof message.executable !== "string" ||
      !Array.isArray(message.args) || message.args.some((arg) => typeof arg !== "string")) return;
    started = true;
    const result = (code, signal) => {
      if (finishing) return;
      finishing = true;
      send({ type: "result", code, signal });
    };
    try {
      // Direct descriptor inheritance preserves the guardian's pipe/backpressure
      // and keeps credentials out of the wrapper's argv and diagnostics.
      const inner = launch(message.executable, message.args,
        { stdio: ["ignore", "inherit", "inherit"], detached: false, windowsHide: true });
      inner.once("spawn", () => send({ type: "spawn" }));
      inner.once("error", (error) => {
        send({ type: "error", code: ["ENOENT", "EACCES"].includes(error.code) ? error.code : "EWORKER" });
        result(null, null);
      });
      // 'close' can wait forever for a redirected descendant's inherited pipe.
      inner.once("exit", result);
    } catch (error) {
      send({ type: "error", code: ["ENOENT", "EACCES"].includes(error.code) ? error.code : "EWORKER" });
      result(null, null);
    }
  });
  send({ type: "ready" });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.connected || typeof process.send !== "function") process.exitCode = 1;
  else runWorkerGroup();
}
