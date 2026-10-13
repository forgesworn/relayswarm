import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile, chmod, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireExclusiveStateLease } from "../src/exclusive-state-lease.mjs";
test("permanent lease rejects symlinks, hardlinks, permissive files and unsafe sidecars", { skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relay-lease-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = join(directory, "lease"), outside = join(directory, "outside");
  await writeFile(outside, "", { mode: 0o600 }); await symlink(outside, target);
  await assert.rejects(acquireExclusiveStateLease(target), /private/u); await rm(target);
  await link(outside, target); await assert.rejects(acquireExclusiveStateLease(target), /private/u); await rm(target);
  await writeFile(target, "", { mode: 0o644 }); await assert.rejects(acquireExclusiveStateLease(target), /private/u);
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
  let control;
  t.after(async () => { await control?.close(); await rm(directory, { recursive: true, force: true }); });
  control = await startBroadcastWorkerControl(join(directory, "lease.sqlite"));
  const source = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidPath)},String(child.pid));process.exit(0);`;
  const worker = control.spawn(process.execPath, ["-e", source], { captureStdout: false });
  await new Promise((done, reject) => { worker.once("close", done); worker.once("error", reject); });
  const pid = Number(await readFile(pidPath, "utf8")); assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await control.close();
  const next = await startBroadcastWorkerControl(join(directory, "lease.sqlite")); await next.close();
});
