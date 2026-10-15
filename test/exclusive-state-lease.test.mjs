import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, chmod, symlink, link, lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireExclusiveStateLease } from "../src/exclusive-state-lease.mjs";
import { safeWorkerFailure, workerFailureReason } from "../src/broadcast-worker-diagnostics.mjs";
import { EventEmitter } from "node:events";
import { controlWorkerGroup, runWorkerGroup, signalOwnWorkerGroup, stopWorkerGroups } from "../src/broadcast-worker-group.mjs";

test("guardian diagnostics expose only fixed stages and reasons, never error details", () => {
  const secret = "private/fixture-path bearer-secret";
  const error = Object.assign(new Error(secret), { code: "ENOENT", path: secret, extra: secret });
  const projected = safeWorkerFailure("marker-remove", workerFailureReason(error));
  assert.deepEqual(projected, { stage: "marker-remove", reason: "ENOENT" });
  assert.ok(Object.isFrozen(projected));
  assert.deepEqual(Object.keys(projected), ["stage", "reason"]);
  assert.ok(!JSON.stringify(projected).includes(secret));
  assert.deepEqual(safeWorkerFailure(secret, secret), { stage: "unknown", reason: "unknown" });
  assert.equal(workerFailureReason({ get code() { throw new Error(secret); } }), "unknown");
});

test("actual guardian IPC receiver sanitises diagnostics and retains the first failure", async () => {
  const source = await readFile(new URL("../src/broadcast-worker-control.mjs", import.meta.url), "utf8");
  const marker = 'guardian.on("message", (message) => {';
  assert.equal(source.split(marker).length, 2);
  const start = source.indexOf(marker) + marker.length, end = source.indexOf("\n  });", start);
  assert.ok(end > start);
  const state = { safeWorkerFailure, firstFailure: undefined, startupComplete: true, failedCalls: 0,
    failed() { state.failedCalls++; }, failure: { emit() {} }, workers: new Map() };
  const receive = runInNewContext(`(message) => {${source.slice(start, end)}}`, state);
  const secret = "private/path credential-secret";
  receive({ type: "failed", stage: "worker-group-probe", reason: "EPERM", message: secret, path: secret });
  receive({ type: "failed", stage: secret, reason: secret });
  assert.deepEqual(state.firstFailure, { stage: "worker-group-probe", reason: "EPERM" });
  assert.equal(state.failedCalls, 2);
  assert.ok(!JSON.stringify(state.firstFailure).includes(secret));
});
test("permanent lease rejects symlinks, hardlinks, permissive files and unsafe sidecars", { skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-lease-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "lease"), outside = join(directory, "outside");
  await writeFile(outside, "", { mode: 0o600 }); await symlink(outside, target);
  await assert.rejects(acquireExclusiveStateLease(target), /private/u); await rm(target);
  await link(outside, target); await assert.rejects(acquireExclusiveStateLease(target), /private/u); await rm(target);
  await writeFile(target, "", { mode: 0o644 }); await chmod(target, 0o644); await assert.rejects(acquireExclusiveStateLease(target), /private/u);
  await chmod(target, 0o600); await symlink(outside, `${target}-journal`); await assert.rejects(acquireExclusiveStateLease(target), /sidecar/u);
  await rm(`${target}-journal`); const lease = await acquireExclusiveStateLease(target);
  await assert.rejects(acquireExclusiveStateLease(target), /locked/u); lease.close(); lease.close();
  const next = await acquireExclusiveStateLease(target); assert.equal(next.inode, lease.inode); next.close();
});

test("a killed guardian leaves a durable fence that refuses automatic restart", { timeout: 5000, skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const { startBroadcastWorkerControl } = await import("../src/broadcast-worker-control.mjs");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-guardian-"))), path = join(directory, "workers.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await startBroadcastWorkerControl(path);
  process.kill(first.guardianPid, "SIGKILL"); await assert.rejects(first.close(), /without verified clean shutdown/u);
  await assert.rejects(startBroadcastWorkerControl(path), /locked or unavailable/u);
});

test("guardian cleans redirected descendants after the worker leader exits", { timeout: 8000, skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const { startBroadcastWorkerControl } = await import("../src/broadcast-worker-control.mjs");
  const { readFile } = await import("node:fs/promises");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-descendant-"))), pidPath = join(directory, "descendant.pid");
  const nonce = randomUUID(), metadata = await lstat(directory);
  const owner = { v: 1, kind: "guardian-descendant-fixture", nonce, directory, device: metadata.dev,
    inode: metadata.ino, uid: metadata.uid, mode: metadata.mode & 0o777, birthTimeMs: metadata.birthtimeMs, testPid: process.pid };
  let control, next, replacementAttempted = false;
  const witness = (phase) => t.diagnostic(JSON.stringify({ nonce, phase,
    guardianFailure: (next ?? control)?.failureDiagnostic() ?? safeWorkerFailure("unobserved", "unknown") }));
  t.signal.addEventListener("abort", () => witness("existing-test-abort"), { once: true });
  t.after(async () => {
    witness("before-fixture-close");
    if (!control || replacementAttempted && !next) { t.diagnostic(JSON.stringify({ nonce, fixtureRetained: true, closeProved: false })); return; }
    try { await next?.close(); await control.close(); }
    catch (error) { t.diagnostic(JSON.stringify({ nonce, fixtureRetained: true, closeProved: false })); throw error; }
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "fixture-owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
  t.diagnostic(JSON.stringify({ kind: owner.kind, nonce, device: owner.device, inode: owner.inode, uid: owner.uid, mode: owner.mode }));
  control = await startBroadcastWorkerControl(join(directory, "lease.sqlite"));
  const source = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.exit(0);`;
  const worker = control.spawn(process.execPath, ["-e", source], { captureStdout: false });
  await new Promise((done, reject) => { worker.once("close", done); worker.once("error", reject); });
  const pid = Number(await readFile(pidPath, "utf8")); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await control.close();
  replacementAttempted = true;
  next = await startBroadcastWorkerControl(join(directory, "lease.sqlite")); await next.close();
});

test("guardian preserves bounded stdout and inner exit status while draining an inherited-pipe descendant", { timeout: 8000, skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const { startBroadcastWorkerControl } = await import("../src/broadcast-worker-control.mjs");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-worker-pipe-")));
  const metadata = await lstat(directory), nonce = randomUUID(), pidPath = join(directory, "descendant.pid");
  const owner = { v: 1, kind: "guardian-pipe-descendant-fixture", nonce, directory,
    device: metadata.dev, inode: metadata.ino, uid: metadata.uid, mode: metadata.mode & 0o777, testPid: process.pid };
  await writeFile(join(directory, "fixture-owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
  let control, next, handoffAttempted = false;
  const witness = (phase) => t.diagnostic(JSON.stringify({ nonce, phase,
    guardianFailure: (next ?? control)?.failureDiagnostic() ?? safeWorkerFailure("unobserved", "unknown") }));
  t.signal.addEventListener("abort", () => witness("existing-test-abort"), { once: true });
  t.after(async () => {
    witness("before-fixture-close");
    const outcomes = await Promise.allSettled([next, control].filter(Boolean).map((value) => value.close()));
    const failure = outcomes.find((result) => result.status === "rejected");
    if (failure || !control || handoffAttempted && !next) {
      t.diagnostic(JSON.stringify({ nonce, fixtureRetained: true, closeProved: false }));
      if (failure) throw failure.reason;
      return;
    }
    await rm(directory, { recursive: true, force: true });
  });
  t.diagnostic(JSON.stringify({ kind: owner.kind, nonce, device: owner.device, inode: owner.inode, uid: owner.uid, mode: owner.mode }));
  control = await startBroadcastWorkerControl(join(directory, "lease.sqlite"));
  const size = 128 * 1024;
  const source = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');process.stdout.write(Buffer.alloc(${size},97),()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.exit(19);});`;
  const worker = control.spawn(process.execPath, ["-e", source], { captureStdout: true });
  const chunks = []; let bytes = 0;
  worker.stdout.on("data", (data) => { bytes += data.length; if (bytes <= size) chunks.push(data); });
  const code = await new Promise((done, reject) => { worker.once("close", done); worker.once("error", reject); });
  assert.equal(code, 19); assert.equal(bytes, size); assert.deepEqual(Buffer.concat(chunks), Buffer.alloc(size, 97));
  const pid = Number(await readFile(pidPath, "utf8")); assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await control.close(); handoffAttempted = true;
  next = await startBroadcastWorkerControl(join(directory, "lease.sqlite")); await next.close();
});

// No processes, timers or OS probes: these drive the same controller used by
// the guardian, including old IPC objects after their numeric PID is reused.
function groupHarness({ ready = true, holdSends = false } = {}) {
  const child = new EventEmitter(), sent = [], callbacks = [], probes = [], waits = [];
  let clock = 0, absent = false;
  Object.assign(child, { pid: 4123, connected: true,
    stdout: { destroy() {} }, stderr: { destroy() {} },
    send(message, callback) { sent.push(message); callbacks.push(callback); if (!holdSends) callback(); },
    disconnect() { if (child.connected) { child.connected = false; child.emit("disconnect"); } },
  });
  const group = controlWorkerGroup(child, { configure: { executable: "encoder", args: ["private-value"] },
    probe(pid) { probes.push(pid); if (absent) throw Object.assign(new Error(), { code: "ESRCH" }); },
    now: () => clock, pause: () => new Promise((done) => waits.push(done)),
  });
  if (ready) child.emit("message", { type: "ready" });
  return { child, group, sent, callbacks, probes,
    async tick(ms = 1000) { clock += ms; waits.splice(0).forEach((done) => done()); await Promise.resolve(); },
    exit() { absent = true; child.emit("exit", null, "SIGKILL"); },
    close() { child.emit("close", null, "SIGKILL"); },
    end() { this.exit(); this.close(); },
    reuse() { absent = false; },
  };
}

test("closed wrapper and delayed stop never signal a recycled PID or group", async () => {
  const h = groupHarness();
  h.child.emit("message", { type: "result", code: 7, signal: null });
  h.child.emit("message", { type: "draining" }); h.end(); await h.tick();
  assert.deepEqual(await h.group.closed, { code: 7, signal: null, statusKnown: true });
  const count = h.sent.length; h.reuse();
  assert.equal(h.group.signal("SIGTERM"), false);
  assert.equal(h.group.signal("SIGKILL"), false);
  assert.equal(h.sent.length, count, "the original IPC object is never replaced by numeric signalling");
  assert.ok(h.probes.every((pid) => pid === 4123));
});

test("stop before wrapper readiness never launches a late encoder", async () => {
  const h = groupHarness({ ready: false }); h.group.signal("SIGTERM");
  h.child.emit("message", { type: "ready" });
  assert.equal(h.sent.some((row) => row.type === "start"), false);
  h.child.emit("message", { type: "draining" }); h.end(); await h.tick();
  assert.equal((await h.group.closed).statusKnown, false);
});

test("original queued drain/result can arrive after exit but before channel and pipe closure", async () => {
  const h = groupHarness(); h.exit();
  const count = h.sent.length;
  h.child.emit("message", { type: "result", code: 9, signal: null });
  h.child.emit("message", { type: "draining" }); h.close(); await h.tick();
  assert.deepEqual(await h.group.closed, { code: 9, signal: null, statusKnown: true });
  assert.equal(h.sent.length, count, "queued observations cannot trigger outgoing IPC after exit");
});

test("unexpected wrapper death stays unknown despite group absence and late acknowledgement", async () => {
  const h = groupHarness(); h.end();
  h.child.emit("message", { type: "draining" });
  await h.tick();
  await assert.rejects(h.group.closed, /without a drain witness/u);
  assert.equal(h.group.signal("SIGKILL"), false);
});

test("IPC failure is sticky and a late drain or send acknowledgement cannot make cleanup clean", async () => {
  const h = groupHarness({ holdSends: true }); h.callbacks[0](); h.group.signal("SIGKILL");
  const error = Object.assign(new Error("private diagnostic"), { code: "ERR_IPC_CHANNEL_CLOSED" });
  h.callbacks.at(-1)(error);
  h.child.emit("message", { type: "draining" }); h.end(); await h.tick();
  await assert.rejects(h.group.closed, (actual) => actual === error);
  h.callbacks[0]();
  assert.equal(h.group.signal("SIGTERM"), false);
});

test("group absence cannot acknowledge clean shutdown before a late IPC send failure", async () => {
  const h = groupHarness({ holdSends: true }); h.callbacks[0](); h.group.signal("SIGKILL");
  let settled = false; h.group.closed.then(() => { settled = true; }, () => { settled = true; });
  h.child.emit("message", { type: "draining" }); h.end(); await h.tick();
  assert.equal(settled, false);
  const error = Object.assign(new Error(), { code: "ERR_IPC_CHANNEL_CLOSED" });
  h.callbacks.at(-1)(error); await h.tick();
  await assert.rejects(h.group.closed, (actual) => actual === error);
});

test("forced cleanup before inner status is explicitly unknown, never wrapper exit success", async () => {
  const h = groupHarness(); h.group.signal("SIGKILL");
  h.child.emit("message", { type: "draining" }); h.end(); await h.tick();
  assert.deepEqual(await h.group.closed, { code: null, signal: null, statusKnown: false });
});

test("a remaining or recycled group is only observed until the original five-second deadline", async () => {
  const h = groupHarness(); h.group.signal("SIGKILL");
  h.child.emit("message", { type: "draining" }); h.end(); h.reuse();
  await h.tick(5000);
  await assert.rejects(h.group.closed, /could not be proved/u);
  assert.deepEqual(h.sent.filter((row) => row.type === "signal"), [{ type: "signal", signal: "SIGKILL" }]);
});

test("the actual wrapper inherits pipes and reports inner exit before pipe-dependent close", () => {
  const channel = new EventEmitter(), inner = new EventEmitter(), messages = [], signals = [];
  Object.assign(channel, { connected: true, send(message, callback) { messages.push(message); callback(); } });
  runWorkerGroup({ channel, signalSelf: (signal) => signals.push(signal),
    launch(executable, args, options) {
      assert.equal(executable, "encoder"); assert.deepEqual(args, ["private-value"]);
      assert.deepEqual(options.stdio, ["ignore", "inherit", "inherit"]);
      assert.equal(options.detached, false); return inner;
    },
  });
  channel.emit("message", { type: "start", executable: "encoder", args: ["private-value"] });
  inner.emit("spawn"); inner.emit("exit", 19, null);
  assert.deepEqual(messages.at(-1), { type: "result", code: 19, signal: null });
  assert.deepEqual(signals, [], "inner exit leaves a live group anchor until the guardian requests drain");
  channel.emit("message", { type: "signal", signal: "SIGKILL" });
  assert.deepEqual(messages.at(-1), { type: "draining" }); assert.deepEqual(signals, ["SIGKILL"]);
  inner.emit("close", 19, null); assert.equal(messages.filter((row) => row.type === "result").length, 1);
  assert.ok(!JSON.stringify(messages).includes("private-value"));
});

test("wrapper spawn rejection without an inner PID still reports a terminal unknown status", () => {
  const channel = new EventEmitter(), inner = new EventEmitter(), messages = [];
  Object.assign(channel, { connected: true, send(message, callback) { messages.push(message); callback(); } });
  runWorkerGroup({ channel, launch: () => inner, signalSelf() {} });
  channel.emit("message", { type: "start", executable: "absent", args: [] });
  inner.emit("error", Object.assign(new Error("private executable"), { code: "ENOENT" }));
  assert.deepEqual(messages.slice(-2), [{ type: "error", code: "ENOENT" }, { type: "result", code: null, signal: null }]);
});

test("an unforked wrapper refuses startup without signalling a shared shell group", () => {
  const channel = new EventEmitter(), signals = [], launches = [];
  channel.connected = false;
  assert.throws(() => runWorkerGroup({ channel, signalSelf: (signal) => signals.push(signal),
    launch: (...args) => launches.push(args) }), /requires an IPC owner/u);
  assert.deepEqual(signals, []); assert.deepEqual(launches, []); assert.deepEqual(channel.eventNames(), []);
});

test("only the executing wrapper's own live PID supplies group signalling authority", () => {
  const calls = [];
  const owner = { pid: 1234, kill: (...args) => calls.push(args) };
  signalOwnWorkerGroup("SIGTERM", owner); signalOwnWorkerGroup("SIGKILL", owner);
  assert.deepEqual(calls, [[-1234, "SIGTERM"], [-1234, "SIGKILL"]]);
  assert.throws(() => signalOwnWorkerGroup("SIGKILL", { ...owner, pid: 0 }));
  assert.throws(() => signalOwnWorkerGroup("SIGUSR1", owner));
});

test("an early failed worker cannot cancel the original force timer for a TERM-ignoring sibling", async () => {
  const failure = new Error("first worker failed"), calls = [];
  let finishSibling, timer, cleared = false;
  const first = { closed: Promise.reject(failure), group: { signal: (signal) => calls.push([0, signal]) } };
  const sibling = { closed: new Promise((done) => { finishSibling = done; }),
    group: { signal(signal) { calls.push([1, signal]); if (signal === "SIGKILL") finishSibling(); } } };
  const stopped = stopWorkerGroups([first, sibling], {
    setTimer(callback, ms) { assert.equal(ms, 1500); timer = callback; return callback; },
    clearTimer(value) { assert.equal(value, timer); cleared = true; },
  });
  const observed = assert.rejects(stopped, (error) => error === failure);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(cleared, false);
  timer(); await observed;
  assert.deepEqual(calls, [[0, "SIGTERM"], [1, "SIGTERM"], [0, "SIGKILL"], [1, "SIGKILL"]]);
  assert.equal(cleared, true);
});
