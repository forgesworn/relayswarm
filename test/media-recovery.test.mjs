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

function liveSetup() {
  let at = 0, frames = 100;
  const calls = [], session = {}, details = { live: true, startCC: 1, fragmentStart: 40, edge: 64, endSN: 30 };
  const media = { currentTime: 12, paused: false, seeking: false, readyState: 2, error: null,
    buffered: { length: 1, start: () => 4, end: () => 12.05 }, getVideoPlaybackQuality: () => ({ totalVideoFrames: frames }),
    pause() { this.paused = true; }, play: async () => {} };
  const hls = { latestLevelDetails: details, liveSyncPosition: 56, loadingEnabled: true,
    stopLoad: () => calls.push("stop"), startLoad: (position) => calls.push(["start", position]), recoverMediaError: () => calls.push("MSE-reset") };
  const recovery = createMediaRecovery({ media, getHls: () => hls, getSession: () => session, now: () => at, revokeContribution: () => calls.push("revoke"), status() {} });
  return { media, hls, details, recovery, calls, advance(ms, newFrames = frames) { at += ms; frames = newFrames; details.endSN++; }, observe: () => recovery.observeLive(details, { lastFragmentCC: 0 }) };
}

test("live repair requires ten seconds without frame progress and a fresh different continuity outside the buffer", async () => {
  const f = liveSetup(); assert.equal(f.observe(), false);
  f.advance(9000); assert.equal(f.observe(), false);
  f.advance(1000, 101); assert.equal(f.observe(), false, "new decoded frames reset the stall timer");
  f.advance(10000); f.details.startCC = 0; assert.equal(f.observe(), false, "same continuity cannot trigger this repair");
  f.details.startCC = 1; f.media.paused = true; assert.equal(f.observe(), false, "viewer pause is respected");
  f.media.paused = false; f.advance(10000); f.details.live = false; assert.equal(f.observe(), false, "VOD is excluded");
  f.details.live = true; assert.equal(f.observe(), true); assert.deepEqual(f.calls, ["revoke"]);
  f.recovery.cancel(); await Promise.resolve();
  assert.equal(f.recovery.snapshot().outcome, "cancelled"); assert.ok(!f.calls.some(Array.isArray));
});

test("live repair shares the fatal repair budget, uses public load controls and requires decoded progress", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = liveSetup(); f.observe(); f.advance(10000); assert.equal(f.observe(), true); await Promise.resolve();
  assert.deepEqual(f.calls, ["revoke", "stop", ["start", 56]]);
  f.media.currentTime = 57; t.mock.timers.tick(200); assert.equal(f.recovery.snapshot().outcome, "recovering", "a seek alone is not recovery");
  f.advance(200, 105); t.mock.timers.tick(200); assert.equal(f.recovery.snapshot().outcome, "recovered");
  assert.equal(f.observe(), false); f.recovery.handle(fatal);
  assert.equal(f.recovery.snapshot().attempted, 1); assert.equal(f.recovery.snapshot().outcome, "failed");
  assert.ok(!f.calls.includes("MSE-reset"));
});

test("live repair keeps the existing ten-second terminal deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = liveSetup(); f.observe(); f.advance(10000); f.observe(); await Promise.resolve();
  t.mock.timers.tick(9999); assert.equal(f.recovery.snapshot().outcome, "recovering");
  t.mock.timers.tick(1); assert.equal(f.recovery.snapshot().outcome, "failed"); assert.equal(f.media.paused, true);
  assert.equal(f.recovery.snapshot().records[0].reason, "progress-timeout");
  f.advance(30000); assert.equal(f.observe(), false); assert.equal(f.recovery.snapshot().attempted, 1);
});
