#!/usr/bin/env node
// Dedicated native glare supervisor. Import is inert; an exact final binding is required.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { fork, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, chmod, mkdir, writeFile, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { now, stamp, deadlines, cap, bounded, journal, birth, groupAbsent, reapOwned, identity, sameDirectory } from "./support/account-browser-guard.mjs";

export async function main() {
const { values } = parseArgs({ options: {
  chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  run: { type: "boolean", default: false }, binding: { type: "string" },
  resultsDir: { type: "string", default: "artifacts/native-glare-browser" },
} });
assert.ok(values.run && values.binding, "Explicit --run and final --binding are required");
assert.notEqual(process.platform, "win32", "This browser fixture requires POSIX process groups");
let resourceHelper;
const start = now(), clock = deadlines(start), at = stamp(), nonce = randomBytes(16).toString("hex");
values.resultsDir = resolve(values.resultsDir);
const runId = at.replace(/\D/gu, "") + "-" + nonce.slice(0, 8);
let child, owner, root, rootIdentity, input, workerClosed = false, stopped = false, chromeMayExist = false;
const cleanup = { resourceWatcherReaped: null, resourceWatcherGroupAbsent: null, workerGroupAbsent: null, workerReaped: null, chromeGroupAbsent: null, ownedScratchRemoved: null };
const fail = [];
let worker, watcher, watcherOwner, watcherExit = false;
const resourceSamples = [];
async function resource() {
  const row = JSON.parse(await readFile(input.resourcePath, "utf8"));
  assert.ok(row.ok && row.samples > 0 && Date.now() >= row.atMs && Date.now() - row.atMs <= 5000
    && Date.now() >= row.pressureAtMs && Date.now() - row.pressureAtMs <= 15000
    && Number.isSafeInteger(row.rssBytes) && row.rssBytes >= 0 && row.rssBytes <= 3 * 1024 ** 3
    && Number.isSafeInteger(row.processes) && row.processes >= 1 && row.processes <= 64
    && Number.isSafeInteger(row.freePercent) && row.freePercent >= 25 && row.freePercent <= 100);
  assert.ok(resourceSamples.length < 180); resourceSamples.push({ atMs: row.atMs, rssBytes: row.rssBytes, processes: row.processes, freePercent: row.freePercent, samples: row.samples });
}

const wholeAlarm = setTimeout(() => { process.exitCode = 1; process.exit(1); }, cap(clock, "whole", 180000));
const stop = () => { stopped = true; child?.send?.({ stop: true }, () => {}); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
let privateResults, resultsOwned = false;
try {
  const pinFile = resolve(values.binding);
  const pinBytes = await bounded(() => readFile(pinFile), clock, "work", 3000);
  assert.ok(pinBytes.length <= 65536);
  const binding = JSON.parse(pinBytes);
  assert.ok(/^[a-f0-9]{40}$/u.test(binding.sourceSha));
  assert.equal(binding.v, 1);
  resourceHelper = binding.resourceHelper;
  values.bundle = binding.bundle;
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const required = ["test/native-glare-browser.mjs", "test/support/native-glare-browser-worker.mjs", "test/support/native-glare-relay.mjs",
    "test/support/native-glare-page.mjs", "test/support/account-browser-guard.mjs", "test/support/account-browser-chrome.mjs",
    "src/browser/hls-swarm.mjs", "src/browser/peer-link.mjs", "src/relay-session.mjs", "demo/admission.mjs", "src/hls-publisher.mjs", "package-lock.json"];
  assert.ok(Array.isArray(binding.files) && binding.files.length <= 512);
  for (const path of [...required.map(path => resolve(repo, path)), resourceHelper, values.bundle]) {
    assert.ok(typeof path === "string" && binding.files.some(pin => pin.path === path), "Required source or helper pin missing");
  }
  const git = async (args) => (await promisify(execFile)("/usr/bin/git", args, { cwd: repo, timeout: cap(clock, "work", 3000), maxBuffer: 65536 })).stdout;
  assert.equal((await git(["rev-parse", "HEAD"])).trim(), binding.sourceSha);
  assert.equal(await git(["status", "--porcelain"]), "");
  assert.equal(values.chrome, binding.executables.chrome.path);
  assert.equal(process.execPath, binding.executables.node.path);
  assert.equal(binding.executables.python.path, "/usr/bin/python3");
  const verify = async ({ path, sha256 }) => {
    const info = await bounded(() => lstat(path), clock, "work", 3000);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024 * 1024);
    const bytes = await bounded(() => readFile(path), clock, "work", 5000);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
  };
  for (const pin of [...binding.files, ...Object.values(binding.executables)]) await verify(pin);
  await bounded(() => mkdir(values.resultsDir, { mode: 0o700 }), clock, "work", 5000); resultsOwned = true;
  privateResults = join(values.resultsDir, ".private"); await mkdir(privateResults, { mode: 0o700 }); await chmod(privateResults, 0o700);
  cap(clock, "work", 1);
  root = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-native-glare-"))); await chmod(root, 0o700); rootIdentity = identity(root);
  const temp = join(root, "tmp"); await mkdir(temp, { mode: 0o700 });
  const chromeWrapper = join(root, "chrome");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(chromeWrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./support/account-browser-chrome.mjs', import.meta.url)))} "$@"\n`, { mode: 0o700, flag: "wx" });
  input = { v: 1, at, nonce, clock, root, rootIdentity, chromeWrapper, values, sourceSha: binding.sourceSha, helperPinsSHA256: createHash("sha256").update(pinBytes).digest("hex"),
    resourcePath: join(privateResults, `resource-${runId}.json`), chromeJournal: join(privateResults, `chrome-${runId}.json`), chromeIntent: join(privateResults, `chrome-intent-${runId}.json`), workerReceipt: join(privateResults, `worker-${runId}.json`) };
  const inputPath = join(privateResults, `input-${runId}.json`); journal(inputPath, input);
  cap(clock, "work", 1); assert.ok(!stopped);
  journal(join(privateResults, `resource-intent-${runId}.json`), { nonce, at: stamp(), helper: resourceHelper, sourceSha: input.sourceSha, helperPinsSHA256: input.helperPinsSHA256 });
  watcher = spawn("/usr/bin/python3", ["-B", resourceHelper, "--run", "--root", String(process.pid), "--host", "M1", "--deadline", String(Date.now() + cap(clock, "work", 150000)), "--output", input.resourcePath], { detached: true, stdio: "ignore" });
  watcher.on("exit", () => { watcherExit = true; }); watcher.on("error", () => { fail.push("resource-watcher-spawn"); });
  watcherOwner = birth(watcher.pid); assert.ok(watcherOwner && watcherOwner.pgid === watcher.pid);
  journal(join(privateResults, `resource-owner-${runId}.json`), { ...watcherOwner, nonce });
  await bounded(async () => { while (true) { try { await readFile(input.resourcePath); break; } catch (e) { if (e.code !== "ENOENT") throw e; assert.ok(!watcherExit); await new Promise(r => setTimeout(r, 25)); } } }, clock, "work", 5000);
  await resource();
  cap(clock, "work", 1); assert.ok(!stopped);
  journal(join(privateResults, `worker-intent-${runId}.json`), { nonce, at: stamp(), sourceSha: input.sourceSha, helperPinsSHA256: input.helperPinsSHA256, worker: fileURLToPath(new URL("./support/native-glare-browser-worker.mjs", import.meta.url)) });
  child = fork(fileURLToPath(new URL("./support/native-glare-browser-worker.mjs", import.meta.url)), [], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, RELAYSWARM_ACCOUNT_INPUT: inputPath },
  });
  const ready = new Promise((resolveReady) => child.once("message", (message) => { if (message?.ready) resolveReady(); }));
  child.on("error", () => { fail.push("worker-spawn"); });
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => { workerClosed = true; worker = { code, signal }; resolveExit(); }));
  owner = birth(child.pid); assert.ok(owner && owner.pgid === child.pid);
  journal(join(privateResults, `worker-owner-${runId}.json`), { ...owner, nonce, at: stamp() });
  await bounded(() => ready, clock, "work", 15000);
  cap(clock, "work", 1);
  assert.ok(!stopped); child.send({ start: true });
  chromeMayExist = true;
  // At 150s the worker may clean up; at 165s the supervisor reaps it even if
  // setup, Playwright or server cleanup is stuck. No awaited worker controls this.
  await bounded(async () => {
    while (!workerClosed && !stopped) { await resource(); await Promise.race([exited, new Promise((r) => setTimeout(r, 1000))]); }
  }, clock, "grace", 165000);
} catch { fail.push("journey-or-supervisor-deadline"); }
finally {
  const attempts = await Promise.allSettled([
    (async () => {
      if (owner) cleanup.workerGroupAbsent = await reapOwned(owner, clock);
      else if (child) {
        // No start message was sent without the ownership journal. This exact
        // ChildProcess can be reaped, but no fixture descendants were authorised.
        child.kill("SIGKILL");
        await bounded(async () => { while (!workerClosed) await new Promise((r) => setTimeout(r, 25)); }, clock, "reap", 2000);
        cleanup.workerGroupAbsent = groupAbsent(child.pid);
      } else cleanup.workerGroupAbsent = true;
    })(),
    (async () => {
      // Re-read after the worker group is gone below as well: an in-flight
      // launch may journal Chrome while termination is being requested.
      if (!input) { cleanup.chromeGroupAbsent = !chromeMayExist; return; }
      try { const record = JSON.parse(await readFile(input.chromeJournal, "utf8")); assert.equal(record.nonce, nonce); cleanup.chromeGroupAbsent = await reapOwned(record, clock); }
      catch (error) { if (error.code === "ENOENT") cleanup.chromeGroupAbsent = null; else throw error; }
    })(),
  ]);
  if (attempts.some((item) => item.status === "rejected")) fail.push("owned-group-cleanup");
  if (cleanup.workerGroupAbsent === true && input) {
    try {
      let record;
      try { record = JSON.parse(await readFile(input.chromeJournal, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (record) { assert.equal(record.nonce, nonce); cleanup.chromeGroupAbsent = await reapOwned(record, clock); }
      else {
        // A launchServer call can be interrupted before its wrapper journals.
        // An intent without ownership is UNKNOWN, never proof of no browser.
        try { await readFile(input.chromeIntent); cleanup.chromeGroupAbsent = false; }
        catch (error) { if (error.code !== "ENOENT") throw error; cleanup.chromeGroupAbsent = true; }
      }
    } catch { cleanup.chromeGroupAbsent = false; }
  }
  if (child && !workerClosed && cleanup.workerGroupAbsent === true) {
    try { await bounded(async () => { while (!workerClosed) await new Promise((r) => setTimeout(r, 25)); }, clock, "reap", 1000); } catch {}
  }
  cleanup.workerReaped = child ? workerClosed : true;
  try { if (watcher && !watcherExit && !stopped && worker?.code === 0) await resource(); } catch { fail.push("resource-final-observation"); }
  try {
    if (watcherOwner) cleanup.resourceWatcherGroupAbsent = await reapOwned(watcherOwner, clock);
    else if (!watcher) cleanup.resourceWatcherGroupAbsent = true;
    else {
      // Only the direct ChildProcess is available after a partial launch.
      // No group signal is authorised without the journalled leader birth.
      if (!watcherExit) watcher.kill("SIGKILL");
      await bounded(async () => { while (!watcherExit) await new Promise(r => setTimeout(r, 25)); }, clock, "reap", 1000);
      cleanup.resourceWatcherGroupAbsent = watcher.pid ? groupAbsent(watcher.pid) : null;
      fail.push("resource-watcher-owner-unavailable");
    }
    if (watcher && !watcherExit) await bounded(async () => { while (!watcherExit) await new Promise(r => setTimeout(r, 25)); }, clock, "reap", 1000);
    cleanup.resourceWatcherReaped = watcher ? watcherExit : true;
  } catch { fail.push("resource-watcher-cleanup"); }
  if (!root) cleanup.ownedScratchRemoved = true;
  if (root && cleanup.workerGroupAbsent === true && cleanup.chromeGroupAbsent === true && cleanup.workerReaped && cleanup.resourceWatcherGroupAbsent === true && cleanup.resourceWatcherReaped === true) {
    try {
      sameDirectory(root, rootIdentity);
      const pattern = root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      let absent = false;
      try { await promisify(execFile)("pgrep", ["-f", pattern], { timeout: cap(clock, "whole", 1000), maxBuffer: 8192 }); }
      catch (error) { absent = error.code === 1 && !String(error.stdout ?? "").trim() && !String(error.stderr ?? "").trim(); }
      assert.ok(absent); sameDirectory(root, rootIdentity);
      await bounded(() => rm(root, { recursive: true }), clock, "whole", 3000); cleanup.ownedScratchRemoved = true;
    } catch { cleanup.ownedScratchRemoved = false; }
  }
  let receipt;
  try { receipt = JSON.parse(await readFile(input.workerReceipt, "utf8")); } catch { receipt = { v: 1, kind: "native-chrome-glare", ok: false, checkpoints: [], failures: [{ category: "worker-receipt-unavailable" }], cleanup: {} }; }
  const supervisor = { v: 1, at, finishedAt: stamp(), elapsedMs: Number((now() - start) / 1000000n),
    resourceSamples, sourceSha: input?.sourceSha ?? null, helperPinsSHA256: input?.helperPinsSHA256 ?? null, resourceCleanupScope: "watcher direct-child reaping and watcher group absence are separate; its internal ps probe reaping is not inferred from either", bounds: { wholeMs: 180000, workMs: 150000, gracefulCleanupEndsMs: 165000, groupReapEndsMs: 175000 }, worker, failures: fail, cleanup };
  supervisor.ok = worker?.code === 0 && worker?.signal === null && fail.length === 0 && Object.values(cleanup).every((value) => value === true) && supervisor.elapsedMs < 180000;
  receipt.supervisor = supervisor; receipt.ok = receipt.ok === true && supervisor.ok && !stopped;
  try {
    assert.ok(resultsOwned);
    await bounded(async () => {
      await writeFile(join(values.resultsDir, `native-glare-${runId}.json`), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await writeFile(join(values.resultsDir, "native-glare-browser.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    }, clock, "whole", 3000);
  } catch { receipt.ok = false; }
  clearTimeout(wholeAlarm);
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  console.log(JSON.stringify({ ok: receipt.ok, checkpoints: receipt.checkpoints.map(({ name }) => name), failures: receipt.failures, supervisor }));
  process.exit(receipt.ok ? 0 : 1);
}

}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Native glare supervisor refused"); process.exitCode = 1; });
}
