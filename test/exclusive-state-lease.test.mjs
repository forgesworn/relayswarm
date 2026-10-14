import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, chmod, symlink, link, lstat, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireExclusiveStateLease } from "../src/exclusive-state-lease.mjs";
import { safeWorkerFailure, workerFailureReason } from "../src/broadcast-worker-diagnostics.mjs";

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
