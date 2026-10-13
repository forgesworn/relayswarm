import test from "node:test";
import assert from "node:assert/strict";
import { createMediaRecovery } from "../demo/media-recovery.mjs";

const fatal = { fatal: true, type: "mediaError", details: "bufferAppendError" };
function setup() {
  const calls = [], media = { currentTime: 12, paused: false, readyState: 3, error: null, pause() { this.paused = true; calls.push("pause"); }, async play() { calls.push("play"); } };
  const hls = { latestLevelDetails: { live: false }, stopLoad() { calls.push("stop"); }, recoverMediaError() { calls.push("recover"); }, startLoad(position) { calls.push(["start", position]); } };
  let session = {};
  const recovery = createMediaRecovery({ media, getHls: () => hls, getSession: () => session, revokeContribution: () => calls.push("revoke"), status() {} });
  return { calls, media, hls, recovery, replaceSession: () => { session = {}; } };
}

test("recovery does not run inside fatal dispatch and cancellation prevents queued restart", async () => {
  const f = setup();
  assert.equal(f.recovery.handle({ ...fatal, fatal: false }), false);
  assert.equal(f.recovery.handle({ ...fatal, details: "bufferStalledError" }), false);
  assert.equal(f.recovery.handle(fatal), true); assert.deepEqual(f.calls, ["revoke"]);
  f.recovery.cancel(); await Promise.resolve();
  assert.equal(f.recovery.snapshot().outcome, "cancelled"); assert.ok(!f.calls.includes("recover"));
  f.recovery.handle(fatal); await Promise.resolve();
  assert.equal(f.recovery.snapshot().attempted, 1); assert.ok(!f.calls.includes("recover"));
});

test("changed publisher session cancels the queued repair", async () => {
  const f = setup(); f.recovery.handle(fatal); f.replaceSession(); await Promise.resolve();
  assert.equal(f.recovery.snapshot().records[0].reason, "player-or-session-changed"); assert.ok(!f.calls.includes("recover"));
});

test("a synchronous fatal during reattachment cannot restart loading after termination", async () => {
  const f = setup(); f.hls.recoverMediaError = () => { f.calls.push("recover"); f.recovery.handle(fatal); };
  f.recovery.handle(fatal); await Promise.resolve();
  assert.equal(f.recovery.snapshot().outcome, "failed"); assert.ok(!f.calls.some(Array.isArray)); assert.ok(!f.calls.includes("play"));
});
