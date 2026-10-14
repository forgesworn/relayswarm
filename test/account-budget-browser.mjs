#!/usr/bin/env node
// Independent POSIX supervisor for the actual account-browser journey.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { fork, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, chmod, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { now, stamp, deadlines, cap, bounded, journal, birth, groupAbsent, reapOwned, identity, sameDirectory } from "./support/account-browser-guard.mjs";

const { values } = parseArgs({ options: {
  chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  resultsDir: { type: "string", default: "artifacts/account-budget-browser" },
} });
assert.notEqual(process.platform, "win32", "This browser fixture requires POSIX process groups");
const start = now(), clock = deadlines(start), at = stamp(), nonce = randomBytes(16).toString("hex");
values.resultsDir = resolve(values.resultsDir);
const runId = at.replace(/\D/gu, "") + "-" + nonce.slice(0, 8);
let child, owner, root, rootIdentity, input, workerClosed = false, stopped = false, chromeMayExist = false;
const cleanup = { workerGroupAbsent: null, workerReaped: null, chromeGroupAbsent: null, ownedScratchRemoved: null };
const fail = [];
let worker;
const wholeAlarm = setTimeout(() => { process.exitCode = 1; process.exit(1); }, cap(clock, "whole", 180000));
const stop = () => { stopped = true; child?.send?.({ stop: true }, () => {}); };
process.on("SIGTERM", stop); process.on("SIGINT", stop);
let privateResults;
try {
  await bounded(() => mkdir(values.resultsDir, { recursive: true }), clock, "work", 5000);
  privateResults = join(values.resultsDir, ".private"); await mkdir(privateResults, { recursive: true, mode: 0o700 }); await chmod(privateResults, 0o700);
  cap(clock, "work", 1);
  root = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-account-browser-"))); await chmod(root, 0o700); rootIdentity = identity(root);
  const temp = join(root, "tmp"); await mkdir(temp, { mode: 0o700 });
  const chromeWrapper = join(root, "chrome");
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(chromeWrapper, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("support/account-browser-chrome.mjs", import.meta.url)))} "$@"\n`, { mode: 0o700, flag: "wx" });
  input = { v: 1, at, nonce, clock, root, rootIdentity, chromeWrapper, values,
    chromeJournal: join(privateResults, `chrome-${runId}.json`), chromeIntent: join(privateResults, `chrome-intent-${runId}.json`), workerReceipt: join(privateResults, `worker-${runId}.json`) };
  const inputPath = join(privateResults, `input-${runId}.json`); journal(inputPath, input);
  cap(clock, "work", 1); assert.ok(!stopped);
  child = fork(fileURLToPath(new URL("support/account-budget-browser-worker.mjs", import.meta.url)), [], {
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
    while (!workerClosed && !stopped) await Promise.race([exited, new Promise((r) => setTimeout(r, 50))]);
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
  if (!root) cleanup.ownedScratchRemoved = true;
  if (root && cleanup.workerGroupAbsent === true && cleanup.chromeGroupAbsent === true && cleanup.workerReaped) {
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
  try { receipt = JSON.parse(await readFile(input.workerReceipt, "utf8")); } catch { receipt = { v: 1, kind: "relayswarm-account-budget-browser", ok: false, checkpoints: [], failures: [{ category: "worker-receipt-unavailable" }], cleanup: {} }; }
  const supervisor = { v: 1, at, finishedAt: stamp(), elapsedMs: Number((now() - start) / 1000000n),
    bounds: { wholeMs: 180000, workMs: 150000, gracefulCleanupEndsMs: 165000, groupReapEndsMs: 175000 }, worker, failures: fail, cleanup };
  supervisor.ok = worker?.code === 0 && worker?.signal === null && fail.length === 0 && Object.values(cleanup).every((value) => value === true) && supervisor.elapsedMs < 180000;
  receipt.supervisor = supervisor; receipt.ok = receipt.ok === true && supervisor.ok && !stopped;
  try {
    await bounded(async () => {
      await writeFile(join(values.resultsDir, `account-budget-${runId}.json`), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await writeFile(join(values.resultsDir, "account-budget-browser.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    }, clock, "whole", 3000);
  } catch { receipt.ok = false; }
  clearTimeout(wholeAlarm);
  process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  console.log(JSON.stringify({ ok: receipt.ok, checkpoints: receipt.checkpoints.map(({ name }) => name), failures: receipt.failures, supervisor }));
  process.exit(receipt.ok ? 0 : 1);
}
