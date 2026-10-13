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

function sparseAudioSetup() {
  const f = setup(); let frames = 4;
  const listeners = new Set(); f.hls.config = { autoStartLoad: true };
  f.hls.on = (_event, listener) => listeners.add(listener);
  f.hls.off = (_event, listener) => listeners.delete(listener);
  f.hls.detachMedia = () => f.calls.push("detach");
  f.media.currentTime = 0;
  f.media.getVideoPlaybackQuality = () => ({ totalVideoFrames: frames });
  const frag = { sn: 785, cc: 2, level: 0, type: "main", start: 2, duration: 2 };
  f.hls.latestLevelDetails = { live: false, fragmentStart: 0, edge: 4, fragments: [{ sn: 784, cc: 2, level: 0, type: "main", start: 0, duration: 2 }, frag] };
  return { ...f, frag, error: { ...fatal, error: { name: "HlsJsTrackRemovedError" }, frag }, frames(value) { frames = value; }, attached() { for (const listener of [...listeners]) listener(); }, listenerCount: () => listeners.size };
}

test("sparse audio VOD repair starts the current failing fragment and requires decoded progress", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = sparseAudioSetup(); f.recovery.handle(f.error); assert.equal(f.media.currentTime, 0); await Promise.resolve();
  assert.equal(f.hls.config.autoStartLoad, false); assert.ok(!f.calls.some(Array.isArray));
  f.attached(); assert.equal(f.hls.config.autoStartLoad, true);
  assert.deepEqual(f.calls, ["revoke", "stop", "recover", ["start", 2], "play"]); assert.equal(f.media.currentTime, 2);
  assert.equal(f.recovery.snapshot().records[0].kind, "vod-track-discovery");
  f.media.currentTime = 2.4; t.mock.timers.tick(200); assert.equal(f.recovery.snapshot().outcome, "recovering", "a seek cannot prove decoded recovery");
  f.frames(16); t.mock.timers.tick(200); assert.equal(f.recovery.snapshot().outcome, "recovered");
  f.recovery.handle(f.error); assert.equal(f.recovery.snapshot().attempted, 1); assert.equal(f.recovery.snapshot().outcome, "failed");
  assert.equal(f.calls.filter(c => c === "recover").length, 1);
});

test("sparse audio repair keeps the existing progress deadline and cancellation fence", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const timed = sparseAudioSetup(); timed.recovery.handle(timed.error); await Promise.resolve();
  t.mock.timers.tick(10000); assert.equal(timed.recovery.snapshot().records[0].reason, "progress-timeout"); assert.equal(timed.hls.config.autoStartLoad, true); assert.equal(timed.listenerCount(), 0); timed.attached(); assert.ok(!timed.calls.some(Array.isArray));
  const cancelled = sparseAudioSetup(); cancelled.recovery.handle(cancelled.error); cancelled.recovery.cancel(); await Promise.resolve();
  assert.equal(cancelled.media.currentTime, 0); assert.ok(!cancelled.calls.includes("recover"));
  const changed = sparseAudioSetup(); changed.recovery.handle(changed.error); changed.hls.latestLevelDetails = { ...changed.hls.latestLevelDetails, fragments: [] }; await Promise.resolve();
  assert.equal(changed.recovery.snapshot().records[0].reason, "fragment-context-changed"); assert.ok(!changed.calls.includes("recover"));
});

test("track discovery position refuses foreign, malformed, non-VOD and unrelated error contexts", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const invalid = [
    f => { f.error.frag = { ...f.frag }; },
    f => { f.frag.start = -1; },
    f => { f.frag.duration = Infinity; },
    f => { f.frag.start = 4; },
    f => { f.frag.cc = -1; },
    f => { f.frag.type = "audio"; },
    f => { f.error.part = {}; },
    f => { f.hls.latestLevelDetails.live = undefined; },
    f => { f.hls.latestLevelDetails.fragmentStart = 3; },
    f => { f.error.error.name = "OtherError"; },
    f => { f.error.details = "mediaSourceRequiresReset"; },
    f => { f.media.currentTime = 3; },
  ];
  for (const mutate of invalid) {
    const f = sparseAudioSetup(); mutate(f); const originalPosition = f.media.currentTime;
    f.recovery.handle(f.error); await Promise.resolve();
    assert.deepEqual(f.calls.find(Array.isArray), ["start", originalPosition]); assert.equal(f.recovery.snapshot().records[0].kind, undefined);
    f.recovery.cancel();
  }
  const live = sparseAudioSetup(); live.hls.latestLevelDetails.live = true; live.hls.liveSyncPosition = 3.5;
  live.recovery.handle(live.error); await Promise.resolve(); assert.deepEqual(live.calls.find(Array.isArray), ["start", 3.5]); assert.equal(live.media.currentTime, 0); live.recovery.cancel();
});


test("sparse audio attachment cancellation restores config and cannot restart later", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = sparseAudioSetup(); f.recovery.handle(f.error); await Promise.resolve();
  assert.equal(f.hls.config.autoStartLoad, false); f.recovery.cancel(); f.attached();
  assert.equal(f.hls.config.autoStartLoad, true); assert.equal(f.listenerCount(), 0);
  assert.ok(f.calls.includes("detach")); assert.ok(!f.calls.some(Array.isArray));
  assert.equal(f.recovery.snapshot().outcome, "cancelled");
});

test("sparse audio measures fresh attachment frames and fences a synchronous reset fatal", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const f = sparseAudioSetup(); f.frames(100000); f.recovery.handle(f.error); await Promise.resolve();
  f.frames(0); f.attached(); f.media.currentTime = 2.4; t.mock.timers.tick(200);
  assert.equal(f.recovery.snapshot().outcome, "recovering"); f.frames(8); t.mock.timers.tick(200);
  assert.equal(f.recovery.snapshot().outcome, "recovered"); assert.equal(f.recovery.snapshot().records[0].framesAfterReattach, 0);
  const failed = sparseAudioSetup(); failed.hls.recoverMediaError = () => failed.recovery.handle(failed.error);
  failed.recovery.handle(failed.error); await Promise.resolve(); failed.attached();
  assert.equal(failed.hls.config.autoStartLoad, true); assert.equal(failed.listenerCount(), 0);
  assert.equal(failed.recovery.snapshot().outcome, "failed"); assert.ok(!failed.calls.some(Array.isArray));
});
