import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, chmod, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadlines, cap, bounded, now, birth, groupAbsent, reapOwned, signalOwned, journal, identity, sameDirectory } from "./support/account-browser-guard.mjs";

test("original monotonic work, cleanup and whole boundaries never renew", async () => {
  const start = 1000000000n, clock = deadlines(start);
  assert.equal(cap(clock, "work", 200000, start), 150000);
  assert.equal(cap(clock, "grace", 200000, start), 165000);
  assert.equal(cap(clock, "whole", 200000, start), 180000);
  assert.equal(cap(clock, "work", 1000, BigInt(clock.work) - 1999999n), 1);
  for (const phase of Object.keys(clock)) for (const offset of [0n, 1n]) assert.throws(() => cap(clock, phase, 1, BigInt(clock[phase]) + offset));
  let invoked = false;
  await assert.rejects(bounded(() => { invoked = true; }, { work: String(now() - 1n) }, "work", 1));
  assert.equal(invoked, false, "expired operation must not start before checking its cap");
});

test("hung operation times out without claiming cancellation or resolution", async () => {
  let finished = false;
  const clock = { grace: String(now() + 30000000n) };
  await assert.rejects(bounded(() => new Promise(() => {}).then(() => { finished = true; }), clock, "grace", 15));
  assert.equal(finished, false);
});

test("private exclusive journal and root identity refuse replacement", { skip: process.platform === "win32" }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "account-guard-test-"))); await chmod(root, 0o700);
  try {
    const owner = identity(root); sameDirectory(root, owner);
    assert.throws(() => sameDirectory(root, { ...owner, ino: owner.ino + 1 }));
    const path = join(root, "owner.json"); journal(path, { v: 1 });
    assert.deepEqual(JSON.parse(await readFile(path)), { v: 1 });
    assert.throws(() => journal(path, { v: 2 }));
  } finally { await rm(root, { recursive: true }); }
});

test("owned trivial worker ignoring TERM is killed, reaped and group absent; wrong birth cannot signal", { skip: process.platform === "win32", timeout: 6000 }, async () => {
  const evidence = join(process.cwd(), "artifacts", "account-browser-guard-tests", ".private");
  await mkdir(evidence, { recursive: true, mode: 0o700 }); await chmod(evidence, 0o700);
  const prefix = `child-${Date.now()}-${process.pid}`;
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setTimeout(()=>process.exit(2),4500);setInterval(()=>{},1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  const clock = { reap: String(now() + 4000000000n) };
  let owner, firstError, cleanupError, phase = "ready", exitObserved = false, absence = null;
  const category = (error) => error ? { name: error.name, code: typeof error.code === "string" ? error.code : null } : null;
  const record = (suffix, value) => {
    try { journal(join(evidence, `${prefix}-${suffix}.json`), value); }
    catch (error) { cleanupError ??= error; }
  };
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => { exitObserved = true; resolve({ code, signal }); }));
  try {
    await new Promise((resolve) => child.stdout.once("data", resolve));
    phase = "ownership"; owner = birth(child.pid); assert.ok(owner && owner.pgid === child.pid);
    journal(join(evidence, `${prefix}-owner.json`), { at: new Date().toISOString(), owner });
    phase = "wrong-birth-refusal";
    assert.throws(() => signalOwned({ ...owner, birth: "wrong" }, "SIGTERM"));
    assert.equal(groupAbsent(child.pid), false);
    phase = "reap"; assert.equal(await reapOwned(owner, clock), true);
    phase = "exit"; assert.equal((await exited).signal, "SIGKILL");
    phase = "post-reap-probe"; assert.equal(groupAbsent(child.pid), true);
    assert.equal(signalOwned(owner, "SIGTERM"), false);
  } catch (error) { firstError = error; }
  finally {
    record("pre-cleanup", { at: new Date().toISOString(), phase, failure: category(firstError), exitObserved });
    try {
      if (owner) absence = await reapOwned(owner, clock);
      else { child.kill("SIGKILL"); await exited; absence = groupAbsent(child.pid); }
      await exited;
    } catch (error) { cleanupError ??= error; }
    record("post-cleanup", { at: new Date().toISOString(), absence, exitObserved, firstFailure: category(firstError), cleanupFailure: category(cleanupError) });
  }
  if (firstError) throw firstError;
  if (cleanupError) throw cleanupError;
  assert.equal(absence, true);
});

test("Chrome executable wrapper journals before child launch and its original watchdog kills its own group", { skip: process.platform === "win32", timeout: 6000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "account-wrapper-test-"))); await chmod(root, 0o700);
  const inputPath = join(root, "input.json"), chromeJournal = join(root, "chrome.json");
  const start = now();
  const clock = { work: String(start + 5000000000n), grace: String(start + 700000000n), reap: String(start + 4000000000n) };
  journal(inputPath, { root, rootIdentity: identity(root), clock, nonce: "owned-test", chromeJournal, values: { chrome: process.execPath } });
  const child = spawn(process.execPath, [new URL("./support/account-browser-chrome.mjs", import.meta.url).pathname, "-e",
    "const fs=require('fs');const i=JSON.parse(fs.readFileSync(process.env.RELAYSWARM_ACCOUNT_INPUT));const j=JSON.parse(fs.readFileSync(i.chromeJournal));if(j.nonce!=='owned-test')process.exit(2);fs.writeSync(3,'journal-before-child');setInterval(()=>{},1000)"],
  { detached: true, env: { ...process.env, RELAYSWARM_ACCOUNT_INPUT: inputPath }, stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let owner, firstError, cleanupError;
  try {
    const output = await new Promise((resolve) => child.stdio[3].once("data", (chunk) => resolve(String(chunk))));
    assert.equal(output, "journal-before-child");
    owner = JSON.parse(await readFile(chromeJournal));
    assert.equal(owner.pid, child.pid); assert.equal(owner.pgid, child.pid);
    assert.equal((await exited).signal, "SIGKILL");
    assert.ok(Number((now() - start) / 1000000n) < 3000);
    assert.equal(await reapOwned(owner, clock), true);
  } catch (error) { firstError = error; }
  finally {
    try {
      owner ??= JSON.parse(await readFile(chromeJournal));
      assert.equal(owner.nonce, "owned-test"); assert.ok(owner.pid === child.pid && owner.pgid === child.pid);
      assert.equal(await reapOwned(owner, clock), true);
      await exited;
      await rm(root, { recursive: true });
    } catch (error) { cleanupError = error; }
  }
  if (firstError) throw firstError;
  if (cleanupError) throw cleanupError;
});

const probeError = (code) => Object.assign(new Error("owned probe fixture"), { code });

test("absent or changed leaders cannot authorise group signals; absent-leader reaping only observes", async () => {
  const owner = { pid: 2147483000, pgid: 2147483000, birth: "owned-fixture" };
  for (const live of [null, { ...owner, birth: "reused" }, { ...owner, pgid: owner.pgid - 1 }]) {
    const signals = [];
    const operations = { readBirth: () => live, kill: (_pid, signal) => { signals.push(signal); } };
    assert.throws(() => signalOwned(owner, "SIGTERM", operations), /identity changed/u);
    assert.deepEqual(signals, [0], "a probe is not permission to signal a missing or changed leader");
  }
  const signals = []; let probes = 0;
  const operations = { readBirth: () => null, kill: (_pid, signal) => {
    signals.push(signal); if (++probes >= 3) throw probeError("ESRCH");
  } };
  assert.equal(await reapOwned(owner, { reap: String(now() + 100000000n) }, operations), true);
  assert.ok(signals.every(signal => signal === 0));
  const originalEnd = String(now() + 10000000n);
  await assert.rejects(reapOwned(owner, { reap: originalEnd }, { readBirth: () => null, kill: (_pid, signal) => {
    assert.equal(signal, 0); throw probeError("EPERM");
  } }), /ownership UNKNOWN/u);
});

test("EPERM is not absence and only later explicit ESRCH completes owned reaping", async () => {
  const owner = { pid: 2147483000, pgid: 2147483000, birth: "owned-fixture" };
  assert.equal(groupAbsent(owner.pid, () => { throw probeError("EPERM"); }), false);
  assert.equal(signalOwned(owner, "SIGTERM", { readBirth: () => owner, kill: () => { throw probeError("EPERM"); } }), false);
  let checks = 0;
  const signals = [];
  const operations = { readBirth: () => owner, kill: (_pid, signal) => {
    signals.push(signal);
    if (signal !== 0) throw probeError("EPERM");
    if (++checks < 4) throw probeError("EPERM");
    throw probeError("ESRCH");
  } };
  assert.equal(await reapOwned(owner, { reap: String(now() + 500000000n) }, operations), true);
  assert.ok(checks >= 4); assert.ok(signals.includes("SIGTERM"));
});

test("persistent EPERM cannot claim cleanup and original deadline and other errors remain effective", async () => {
  const owner = { pid: 2147483000, pgid: 2147483000, birth: "owned-fixture" };
  const end = now() + 20000000n, clock = { reap: String(end) };
  await assert.rejects(reapOwned(owner, clock, { readBirth: () => owner, kill: () => { throw probeError("EPERM"); } }), /deadline expired/u);
  assert.equal(clock.reap, String(end), "probing never renews the original deadline");
  for (const code of ["EIO", "EINVAL"]) {
    assert.throws(() => groupAbsent(owner.pid, () => { throw probeError(code); }), { code });
    await assert.rejects(reapOwned(owner, { reap: String(now() + 500000000n) }, { readBirth: () => owner, kill: () => { throw probeError(code); } }), { code });
  }
});
