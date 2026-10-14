import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { createBroadcastRequestTimings } from "./support/broadcast-request-timings.mjs";

function fixture(options = {}) {
  let clock = 1000;
  const recorder = createBroadcastRequestTimings({ origin: "http://127.0.0.1:12345", epochMs: 1000, now: () => clock, ...options });
  return { recorder, at(value) { clock = value; } };
}
function request(path = "/media/high/index.m3u8", range, overrides = {}) {
  return { url: () => `http://127.0.0.1:12345${path}`, headers: () => ({ ...(range === undefined ? {} : { range }), authorization: "PRIVATE-CREDENTIAL" }), method: () => "GET",
    timing: () => ({ startTime: 1700000000000, domainLookupStart: -1, domainLookupEnd: -1, connectStart: 0, secureConnectionStart: -1, connectEnd: 1, requestStart: 2, responseStart: 5, responseEnd: 8, secret: "PRIVATE-TIMING" }), ...overrides };
}
const response = (req, status = 200) => ({ request: () => req, status: () => status });

test("existing request/response/finish metadata retains actual clocks without reading bodies or errors", () => {
  const f = fixture(), p = f.recorder.page("consumer"), req = request();
  req.response = req.failure = () => { throw Error("must not inspect extra data"); };
  p.request(req); f.at(1005); p.response(response(req)); f.at(1008); p.finished(req);
  const s = p.snapshot(), row = s.rows[0];
  assert.deepEqual([row.requestObservedMs, row.responseObservedMs, row.terminalObservedMs], [0, 5, 8]);
  assert.equal(row.status, 200); assert.equal(row.outcome, "finished"); assert.equal(row.timing.startTime, 1700000000000);
  assert.equal(row.timing.requestStart, 2); assert.equal(row.timing.responseEnd, 8); assert.equal(row.timing.domainLookupStart, null);
  assert.equal(s.pending, 0); assert.equal(s.totals.finished, 1); assert.equal(s.statusClasses.success, 1);
});

test("shared labels correlate exact path/range across pages, never export those identities", () => {
  const f = fixture(), a = f.recorder.page("contributor-high"), b = f.recorder.page("consumer");
  const raw = "/media/PRIVATE-PATH/segment-SECRET.ts?credential=PRIVATE-QUERY";
  a.request(request(raw, "bytes=0-99")); b.request(request(raw, "bytes=0-99")); b.request(request(raw, "bytes=100-199")); b.request(request(raw));
  assert.equal(a.snapshot().rows[0].object, b.snapshot().rows[0].object);
  assert.notEqual(b.snapshot().rows[0].object, b.snapshot().rows[1].object); assert.notEqual(b.snapshot().rows[1].object, b.snapshot().rows[2].object);
  assert.deepEqual(b.snapshot().rows.map(r => r.rangePresent), [true, true, false]);
  assert.doesNotMatch(JSON.stringify(f.recorder.snapshot()), /PRIVATE|SECRET|127\.0|bytes=|credential|authorization|high\/|index\.m3u8/iu);
});

test("only exact owned loopback media is classified; categories and methods are fixed", () => {
  const f = fixture(), p = f.recorder.page("baseline");
  p.request(request("/session.json")); p.request(request("/media/a.ts", undefined, { url: () => "https://elsewhere.invalid/media/a.ts" }));
  for (const path of ["/media/master.m3u8", "/media/a.ts", "/media/init.mp4"]) p.request(request(path, undefined, { method: () => "PRIVATE-METHOD" }));
  const s = p.snapshot(); assert.equal(s.totals.started, 3); assert.deepEqual(s.rows.map(r => r.category), ["playlist", "segment", "other-media"]);
  assert.deepEqual(s.rows.map(r => r.rendition), ["master", "unknown", "unknown"]);
  assert.ok(s.rows.every(r => r.method === "other")); assert.equal(s.pending, 3);
  for (const origin of ["https://public.invalid", "http://127.0.0.1/path", "http://name:secret@localhost", "http://localhost/?q=1"]) assert.throws(() => fixture({ origin }));
});

test("detail eviction retains lifecycle totals and bounded active records", () => {
  const f = fixture({ rowCapacity: 2 }), p = f.recorder.page("consumer"), rs = [request("/media/a.ts"), request("/media/b.ts"), request("/media/c.ts")];
  rs.forEach(r => p.request(r)); assert.equal(p.snapshot().rows.length, 2); assert.equal(p.snapshot().pendingRows.length, 3);
  for (const r of rs) { p.response(response(r)); p.finished(r); }
  const s = p.snapshot(); assert.equal(s.totals.retainedDetailEvictions, 1); assert.equal(s.totals.started, 3); assert.equal(s.totals.responses, 3); assert.equal(s.totals.finished, 3); assert.equal(s.statusClasses.success, 3); assert.equal(s.pending, 0);
});

test("active overflow and exhausted object labels stay explicitly uncorrelated, without resetting labels", () => {
  const f = fixture({ activeCapacity: 1, objectCapacity: 1 }), p = f.recorder.page("consumer"), one = request("/media/a.ts"), two = request("/media/b.ts");
  p.request(one); p.request(two); let s = p.snapshot(); assert.equal(s.totals.activeOverflow, 1); assert.equal(s.pending, 1); assert.equal(s.untrackedPendingLowerBound, 1);
  p.response(response(two, 503)); p.failed(two); p.response(response(one)); p.finished(one);
  s = p.snapshot(); assert.equal(s.totals.responseWithoutTrackedStart, 1); assert.equal(s.totals.terminalWithoutTrackedStart, 1); assert.equal(s.statusClasses.serverError, 1); assert.equal(s.totals.failed, 1); assert.equal(s.untrackedPendingLowerBound, 0);
  const three = request("/media/c.ts"); p.request(three); assert.equal(p.snapshot().rows.at(-1).object, null); assert.equal(f.recorder.snapshot().objectLabels, 1); assert.equal(f.recorder.snapshot().unlabelledObjectObservations, 1);
  assert.throws(() => fixture({ activeCapacity: 65 })); assert.throws(() => fixture({ objectCapacity: 513 })); assert.throws(() => fixture({ rowCapacity: 257 }));
});

test("failed or missing metadata remains null and fixed numeric unknown counts, no failure text", () => {
  const f = fixture(), p = f.recorder.page("consumer"), r = request("/media/a.ts", undefined, { timing: () => { throw Error("PRIVATE-TIMING-ERROR"); }, headers: () => { throw Error("PRIVATE-HEADER"); } });
  p.request(r); p.failed(r); let s = p.snapshot(); assert.equal(s.rows[0].status, null); assert.equal(s.rows[0].rangePresent, null); assert.equal(s.rows[0].object, null); assert.ok(Object.values(s.rows[0].timing).every(v => v === null));
  assert.equal(s.totals.statusUnknownAtTerminal, 1); assert.equal(s.totals.timingUnknownAtTerminal, 1); assert.ok(s.totals.metadataUnknown > 0); assert.equal(s.rows[0].outcome, "failed");
  const malformed = request("/media/b.ts", "PRIVATE-BAD-RANGE", { timing: () => ({ startTime: Infinity, requestStart: -1, responseEnd: NaN }) }); p.request(malformed); p.response(response(malformed, 999)); p.finished(malformed);
  s = p.snapshot(); assert.equal(s.rows[1].status, null); assert.equal(s.statusClasses.unknown, 1); assert.equal(s.rows[1].timing.startTime, null);
  assert.doesNotMatch(JSON.stringify(f.recorder.snapshot()), /PRIVATE|RangeError|TypeError|NaN|Infinity/u);
  const pending = request("/media/pending.ts", undefined, { timing: () => ({ startTime: 0, requestStart: 0, responseEnd: -1 }) });
  p.request(pending); const unknown = p.snapshot().rows.at(-1);
  assert.equal(unknown.timing.startTime, null, "Unpopulated native epoch is unknown, rather than 1970");
  assert.equal(unknown.timing.requestStart, 0, "A populated relative zero remains valid");
  assert.equal(unknown.timing.responseEnd, null); assert.equal(unknown.outcome, "pending");
});

test("snapshots are copies; close detaches all four handlers and preserves pending without claiming cancellation", () => {
  const f = fixture(), p = f.recorder.page("consumer"), emitter = new EventEmitter(), r = request(); p.attach(emitter);
  emitter.emit("request", r); const before = p.snapshot(); before.rows[0].timing.requestStart = 999; before.totals.started = 999;
  emitter.emit("response", response(r));
  assert.equal(p.snapshot().rows[0].timing.requestStart, 2); assert.equal(p.snapshot().totals.started, 1);
  const final = f.recorder.close(); assert.equal(final.pages[0].pending, 1); assert.equal(final.pages[0].rows[0].outcome, "pending");
  assert.equal(final.pages[0].rows[0].status, 200); assert.deepEqual(final.cleanup, { listenersDetached: true, retainedRequestHandles: 0, objectLookupReleased: true });
  for (const name of ["request", "response", "requestfinished", "requestfailed"]) assert.equal(emitter.listenerCount(name), 0);
  emitter.emit("requestfinished", r); assert.equal(p.snapshot().pending, 1); assert.throws(() => f.recorder.page("baseline"));
});

test("fixed low/high rendition is independent of page role and opaque object labels", () => {
  const f = fixture(), p = f.recorder.page("consumer");
  for (const path of ["/media/low/index.m3u8", "/media/high/index.m3u8", "/media/run-PRIVATE/low/segment-SECRET.ts", "/media/run-PRIVATE/high/segment-SECRET.ts"]) p.request(request(path));
  assert.deepEqual(p.snapshot().rows.map(r => [r.category, r.rendition]), [["playlist", "low"], ["playlist", "high"], ["segment", "low"], ["segment", "high"]]);
  assert.doesNotMatch(JSON.stringify(f.recorder.snapshot()), /PRIVATE|SECRET|index\.m3u8/u);
});

test("malformed cached getters never escape event handlers or fabricate a terminal response", () => {
  const f = fixture(), p = f.recorder.page("consumer"), e = new EventEmitter(); p.attach(e);
  assert.doesNotThrow(() => e.emit("request", { url() { throw Error("PRIVATE"); } }));
  const r = request("/media/low/a.ts", undefined, { method() { throw Error("PRIVATE"); }, timing() { return new Proxy({}, { get() { throw Error("PRIVATE"); } }); } });
  assert.doesNotThrow(() => { e.emit("request", r); e.emit("response", { request: () => r, status() { throw Error("PRIVATE"); } }); e.emit("requestfailed", r); });
  const s = f.recorder.close(); assert.equal(s.pages[0].totals.classificationUnknown, 1); assert.ok(s.pages[0].totals.metadataUnknown > 0); assert.equal(s.pages[0].statusClasses.unknown, 1); assert.equal(s.pages[0].rows[0].status, null); assert.equal(s.pages[0].rows[0].method, "unknown");
  assert.doesNotMatch(JSON.stringify(s), /PRIVATE/u);
});

test("actual fixture teardown always releases recorder and preserves the first teardown rejection and sequence", async () => {
  const source = await readFile(new URL("./broadcast-browser.mjs", import.meta.url), "utf8");
  const block = source.match(/  try \{ await browser\?\.close\(\);[^\n]+\n  finally \{ receipt\.requestTimingsAfterBrowserClose = requestTimings\?\.close\(\); \}/u)?.[0];
  assert.ok(block, "Execute the fixture's actual teardown block");
  const run = new (Object.getPrototypeOf(async function () {}).constructor)("browser", "demo", "pipeline", "stop", "producer", "router", "receipt", "requestTimings", block);
  for (const failAt of [null, "browser", "demo", "pipeline", "producer", "router"]) {
    const calls = [], failure = Error("teardown failure"), result = {};
    const close = async (name) => { calls.push(name); if (name === failAt) throw failure; };
    const target = (name) => ({ close: () => close(name) });
    const pending = run(target("browser"), target("demo"), target("pipeline"), close, "producer", "router", result, { close() { calls.push("recorder"); return { pending: 1 }; } });
    if (failAt) await assert.rejects(pending, (error) => error === failure); else await pending;
    const sequence = ["browser", "demo", "pipeline", "producer", "router"];
    assert.deepEqual(calls, [...sequence.slice(0, failAt ? sequence.indexOf(failAt) + 1 : sequence.length), "recorder"]);
    assert.deepEqual(result.requestTimingsAfterBrowserClose, { pending: 1 });
  }
});
