import test from "node:test";
import assert from "node:assert/strict";
import { createPolicyRenewal } from "../demo/policy-renewal.mjs";
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  let time = 0, wall = 0, nextTimer = 0, consent = true;
  const timers = new Map(), attempts = [], commits = [], revocations = [];
  const renewal = createPolicyRenewal({ now: () => time, wallNow: () => wall, setTimer(callback, ms) { const id = ++nextTimer; timers.set(id, { at: time + ms, callback }); return id; }, clearTimer(id) { timers.delete(id); },
    load(context) { const result = defer(); attempts.push({ ...context, ...result }); return result.promise; },
    commit(value) { commits.push(value); }, revoke(reason) { revocations.push(reason); consent = false; } });
  async function advance(ms) { const end = time + ms; while (true) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; wall += due[1].at - time; time = due[1].at; timers.delete(due[0]); due[1].callback(); await flush(); } wall += end - time; time = end; await flush(); }
  async function begin() { const promise = renewal.renew(); await flush(); return { promise, attempt: attempts.at(-1) }; }
  async function succeed(a, { revision = 0, mode = null, value = "valid" } = {}) { assert.equal(a.policy({ revision, mode, telemetry: false }), true); a.resolve(value); await flush(); }
  return { renewal, attempts, commits, revocations, timers, advance, jumpWithoutTimers(ms) { time += ms; wall += ms; }, jumpWall(ms) { wall += ms; }, begin, succeed, consent: () => consent };
}
test("a withheld request does not block a newer renewal or revoke its live authority", async () => {
  const f = fixture(); const first = await f.begin(); await f.succeed(first.attempt); await f.advance(2000);
  const stuck = await f.begin(); await f.advance(2000); const later = await f.begin(); await f.succeed(later.attempt, { value: "new" });
  await f.advance(3000); assert.equal(stuck.attempt.signal.aborted, true); assert.equal(await stuck.promise, false); assert.equal(f.renewal.fresh(), true); assert.equal(f.consent(), true); assert.deepEqual(f.commits, ["valid", "new"]); assert.ok(f.renewal.snapshot().records.some(r => r.outcome === "cancelled")); f.renewal.close();
});
test("authority expires at issuance plus5s and later success never restores consent", async () => {
  const f = fixture(), a = await f.begin(); await f.advance(4500); await f.succeed(a.attempt); assert.equal(f.renewal.snapshot().remainingMs, 500);
  await f.advance(500); assert.equal(f.renewal.fresh(), false); assert.equal(f.consent(), false);
  const b = await f.begin(); await f.succeed(b.attempt); assert.equal(f.renewal.fresh(), true); assert.equal(f.consent(), false); f.renewal.close();
});
test("pending work caps at3 and cancellation settles even a callback that ignores its signal", async () => {
  const f = fixture(); const runs = [await f.begin(), await f.begin(), await f.begin()]; assert.equal(await f.renewal.renew(), false); assert.equal(f.attempts.length, 3); await f.advance(5000); assert.deepEqual(await Promise.all(runs.map(r => r.promise)), [false, false, false]); assert.equal(f.renewal.snapshot().pending, 0); f.renewal.close(); assert.equal(f.timers.size, 0);
});
test("OFF revokes immediately before session completion and older success cannot undo it", async () => {
  const f = fixture(), a = await f.begin(); await f.succeed(a.attempt);
  const old = await f.begin(); assert.equal(old.attempt.policy({ revision: 0, mode: null, telemetry: false }), true);
  const off = await f.begin(); assert.equal(off.attempt.policy({ revision: 1, mode: "off", telemetry: false }), true); assert.equal(f.consent(), false); assert.equal(f.renewal.fresh(), false);
  old.attempt.resolve("stale admission"); await flush(); assert.equal(await old.promise, false); off.attempt.resolve("off"); await flush(); assert.deepEqual(f.commits, ["valid", "off"]); f.renewal.close();
});
test("stale policy revisions and reordered candidates cannot restore older state", async () => {
  const f = fixture(), old = await f.begin(); assert.equal(old.attempt.policy({ revision: 1, mode: "shadow", telemetry: false }), true);
  const newer = await f.begin(); await f.succeed(newer.attempt, { revision: 2, mode: "peer-first", value: "new credential" });
  old.attempt.resolve("old credential"); await flush(); assert.equal(await old.promise, false); assert.deepEqual(f.commits, ["new credential"]);
  const stale = await f.begin(); assert.equal(stale.attempt.policy({ revision: 1, mode: "off", telemetry: false }), false); stale.attempt.resolve(null); await flush(); assert.equal(f.consent(), true); f.renewal.close();
});
test("invalid policy or changed identity fails closed; discarded admission never commits", async () => {
  const f = fixture(), a = await f.begin(); await f.succeed(a.attempt); const identity = await f.begin(); identity.attempt.policy({ revision: 0, mode: null, telemetry: false }); identity.attempt.invalidate("publisher-session-changed"); assert.equal(f.consent(), false);
  identity.attempt.reject(Error("Admission unavailable")); await flush(); assert.deepEqual(f.commits, ["valid"]);
  const invalid = await f.begin(); assert.throws(() => invalid.attempt.policy({ revision: 0, mode: "invalid", telemetry: false })); invalid.attempt.reject(Error("Invalid")); await flush(); assert.equal(f.renewal.fresh(), false); f.renewal.close();
});
test("suspension aborts requests and late completion cannot regrant authority", async () => {
  const f = fixture(), a = await f.begin(); a.attempt.policy({ revision: 0, mode: null, telemetry: false }); f.renewal.suspend(); a.attempt.resolve("late"); await flush(); assert.deepEqual(f.commits, []); assert.equal(f.consent(), false); assert.equal(await f.renewal.renew(), false); f.renewal.resume(); const b = await f.begin(); await f.succeed(b.attempt); assert.equal(f.consent(), false); f.renewal.close(); assert.equal(f.timers.size, 0);
});

test("synchronous authority use expires even when the timer has not run", async () => {
  const f = fixture(), a = await f.begin(); await f.succeed(a.attempt); f.jumpWithoutTimers(5001);
  assert.equal(f.renewal.fresh(), false); assert.equal(f.consent(), false); assert.ok(f.revocations.includes("expired")); f.renewal.close();
});

test("wall age expires frozen monotonic time, and observed wall rollback fails closed", async () => {
  const frozen = fixture(), a = await frozen.begin(); await frozen.succeed(a.attempt); frozen.jumpWall(5001);
  assert.equal(frozen.renewal.fresh(), false); assert.equal(frozen.consent(), false); frozen.renewal.close();
  const backward = fixture(), b = await backward.begin(); await backward.succeed(b.attempt); await backward.advance(1000); assert.equal(backward.renewal.fresh(), true);
  backward.jumpWall(-100); assert.equal(backward.renewal.fresh(), false); assert.equal(backward.consent(), false); assert.ok(backward.revocations.includes("clock-rollback")); backward.renewal.close();
});
