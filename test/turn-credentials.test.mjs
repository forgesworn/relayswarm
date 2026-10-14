import test from "node:test";
import assert from "node:assert/strict";
import { createTurnCredentials } from "../demo/turn-credentials.mjs";
const jsonResponse = body => new Response(typeof body === "string" ? body : JSON.stringify(body), { headers: { "content-type": "application/json" } });
const descriptor = { v: 1, endpoint: "/turn-credentials", method: "POST" };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  let mono = 0, wall = 1000000, sequence = 0, fetchImpl;
  const timers = new Map(), calls = [], events = [];
  const client = createTurnCredentials({ origin: "https://viewer.test", now: () => mono, wallNow: () => wall,
    setTimer(fn, ms) { const id = ++sequence; timers.set(id, { at: mono + ms, fn }); return id; }, clearTimer(id) { timers.delete(id); },
    fetchImpl: (...args) => { calls.push(args); return fetchImpl(...args); },
    onRefresh() { events.push("refresh"); }, onUnavailable(reason) { events.push(reason); },
  });
  const payload = (ttlSeconds = 60, secret = "private-credential") => { const issuedAt = Math.floor(wall / 1000) * 1000; return { v: 1, iceServers: [{ urls: ["turns:relay.test:5349?transport=tcp"], username: "private-username", credential: secret }], ttlSeconds, issuedAt, expiresAt: issuedAt + ttlSeconds * 1000, refreshAt: issuedAt + Math.floor(ttlSeconds * 1000 * 2 / 3), serverTime: wall }; };
  fetchImpl = async () => jsonResponse(payload());
  return { client, calls, events, timers, payload, fetch(fn) { fetchImpl = fn; }, jump(m, w = m) { mono += m; wall += w; },
    async advance(ms) { const end = mono + ms; let steps = 0; while (true) { const next = [...timers].filter(([, row]) => row.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; assert.ok(++steps < 100); const delta = next[1].at - mono; mono += delta; wall += delta; timers.delete(next[0]); next[1].fn(); await flush(); } wall += end - mono; mono = end; await flush(); },
  };
}
test("TURN lifecycle is inert by default and descriptor changes never mint on their own", async () => {
  const f = fixture(); f.client.configure(undefined, "session"); assert.equal(await f.client.acquire(), true);
  f.client.configure(descriptor, "session"); f.client.configure({ ...descriptor }, "session");
  await f.advance(120000); assert.equal(f.calls.length, 0); assert.equal(f.client.fresh(), false);
  assert.equal(await f.client.acquire(), true); assert.equal(f.calls.length, 1);
  const [url, options] = f.calls[0]; assert.equal(url, "https://viewer.test/turn-credentials");
  assert.equal(options.method, "POST"); assert.equal(options.body, '{"v":1}'); assert.equal(options.credentials, "same-origin"); assert.equal(options.cache, "no-store"); assert.equal(options.redirect, "error");
  for (let i = 0; i < 10; i++) f.client.configure({ ...descriptor }, "session");
  assert.equal(f.calls.length, 1); f.client.close(); assert.equal(f.timers.size, 0);
});
test("TURN refresh preserves valid configuration, exposes no secrets and returns defensive copies", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); assert.equal(await f.client.acquire(), true);
  const servers = f.client.servers(); servers[0].credential = "changed"; servers[0].urls.length = 0;
  assert.equal(f.client.servers()[0].credential, "private-credential");
  await f.advance(40000); assert.equal(f.calls.length, 2); assert.deepEqual(f.events, ["configuration-changed", "refresh"]);
  assert.equal(f.client.fresh(), true); assert.equal(f.client.snapshot().refreshes, 2);
  const snapshot = JSON.stringify(f.client.snapshot()); for (const forbidden of ["relay.test", "private-", "turn-credentials", "session"]) assert.equal(snapshot.includes(forbidden), false);
  f.client.close();
});
test("failed refresh retains unexpired credentials, expiry revokes once and never automatically reacquires", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); await f.client.acquire();
  f.fetch(async () => { throw Error("private upstream body"); });
  await f.advance(40000); assert.equal(f.client.fresh(), true); assert.equal(f.client.servers()[0].credential, "private-credential");
  f.jump(21000); assert.equal(f.client.fresh(), false); assert.equal(f.client.servers(), undefined);
  assert.equal(f.events.filter(x => x === "expired").length, 1);
  const count = f.calls.length; await f.advance(20000); assert.equal(f.calls.length, count); assert.equal(f.client.snapshot().active, false);
  f.fetch(async () => jsonResponse(f.payload())); assert.equal(await f.client.acquire(), true);
  assert.equal(f.events.includes("refresh"), false, "Explicit reacquisition cannot invoke the active-peer refresh callback"); f.client.close();
});
test("expiry uses original request clocks and generation fences late replies after suspend or identity change", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); let resolve;
  f.fetch(() => new Promise(r => { resolve = r; })); const first = f.client.acquire(); await flush();
  const response = f.payload(); f.jump(2000); resolve(jsonResponse(response)); assert.equal(await first, true);
  assert.equal(f.client.snapshot().remainingMs, 58000, "Full request time is subtracted from server remaining lifetime");
  f.client.suspend(); const second = f.client.acquire(); await flush(); f.client.configure(descriptor, "replacement");
  resolve(jsonResponse(f.payload())); assert.equal(await second, false); assert.equal(f.client.fresh(), false); assert.equal(f.client.servers(), undefined);
  f.client.close();
});
test("single-flight slot survives timeout until actual fetch settlement, including ignored abort", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); let resolve;
  f.fetch(() => new Promise(r => { resolve = r; })); const first = f.client.acquire(); const second = f.client.acquire(); await flush();
  assert.equal(f.calls.length, 1); await f.advance(5000); assert.equal(await first, false); assert.equal(await second, false);
  assert.equal(f.client.snapshot().pending, true); assert.equal(await f.client.acquire(), false); assert.equal(f.calls.length, 1);
  resolve(jsonResponse(f.payload())); await flush(); assert.equal(f.client.snapshot().pending, false); assert.equal(f.client.fresh(), false); f.client.close();
});
test("whole request deadline covers stalled bodies and oversized or invalid responses never install", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); let cancelled = 0;
  f.fetch(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"v":')); }, cancel() { cancelled++; } }), { headers: { "content-type": "application/json" } }));
  const result = f.client.acquire(); await flush(); await f.advance(5000); assert.equal(await result, false); await flush(); assert.equal(cancelled, 1); assert.equal(f.client.snapshot().pending, false);
  for (const body of [" ".repeat(16385), JSON.stringify({ ...f.payload(), extra: "private" }), JSON.stringify({ ...f.payload(), expiresAt: 9999999 })]) {
    f.fetch(async () => jsonResponse(body)); assert.equal(await f.client.acquire(), false); assert.equal(f.client.fresh(), false);
  }
  f.client.close();
});
test("inactive, disabled and hidden lifecycle never refreshes; rollback expires rather than extending authority", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); await f.client.acquire(); f.client.setActive(false);
  await f.advance(45000); assert.equal(f.calls.length, 1); assert.equal(f.client.fresh(), true);
  f.jump(1, -1); assert.equal(f.client.fresh(), false); assert.ok(f.events.includes("clock-rollback"));
  f.client.configure(descriptor, "session"); await f.client.acquire(); f.client.suspend(); const count = f.calls.length; await f.advance(60000); assert.equal(f.calls.length, count);
  f.client.configure(undefined, "session"); assert.equal(f.client.snapshot().enabled, false); assert.equal(f.client.servers(), undefined);
  f.client.configure({ ...descriptor, endpoint: "https://other.test/turn-credentials" }, "session"); assert.equal(await f.client.acquire(), false); assert.equal(f.calls.length, count); f.client.close();
});

test("early HTTP, redirect and content-type rejection cancels body and aborts request without installing", async () => {
  for (const kind of ["status", "redirect", "type", "length"]) {
    const f = fixture(); f.client.configure(descriptor, "session"); let cancelled = 0, signal;
    f.fetch(async (_url, options) => {
      signal = options.signal;
      return { ok: kind !== "status", redirected: kind === "redirect",
        headers: new Headers({ "content-type": kind === "type" ? "text/html" : "application/json", ...(kind === "length" ? { "content-length": "16385" } : {}) }),
        body: new ReadableStream({ cancel() { cancelled++; } }),
      };
    });
    assert.equal(await f.client.acquire(), false); assert.equal(signal.aborted, true);
    assert.equal(cancelled, 1); assert.equal(f.client.fresh(), false); f.client.close();
  }
});

test("early rejection with a nonsettling body cancellation retains the single-flight slot", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); let release;
  f.fetch(async () => ({ ok: false, body: { cancel: () => new Promise(resolve => { release = resolve; }) } }));
  const pending = f.client.acquire(); await flush(); await f.advance(5000);
  assert.equal(await pending, false); assert.equal(f.client.snapshot().pending, true);
  assert.equal(await f.client.acquire(), false); assert.equal(f.calls.length, 1);
  release(); await flush(); assert.equal(f.client.snapshot().pending, false); f.client.close();
});

test("late raw refresh settlement rearms a missed retry only for the same active unexpired generation", async () => {
  for (const barrier of [null, "inactive", "suspend", "close", "identity", "expired"]) {
    const f = fixture(); f.client.configure(descriptor, "session"); await f.client.acquire();
    let release;
    f.fetch(() => new Promise(resolve => { release = resolve; }));
    await f.advance(40000); assert.equal(f.calls.length, 2);
    await f.advance(5000); assert.equal(f.client.snapshot().pending, true);
    assert.equal(f.client.fresh(), true); assert.equal(f.client.servers()[0].credential, "private-credential");
    await f.advance(5000); assert.equal(f.calls.length, 2, "Intervening retry must not overlap the unsettled raw request");
    if (barrier === "inactive") f.client.setActive(false);
    if (barrier === "suspend") f.client.suspend();
    if (barrier === "close") f.client.close();
    if (barrier === "identity") f.client.configure(descriptor, "replacement");
    if (barrier === "expired") { f.jump(10001); assert.equal(f.client.fresh(), false); }
    f.fetch(async () => jsonResponse(f.payload(60, "fresh-secret")));
    release(jsonResponse(f.payload())); await flush();
    assert.equal(f.client.snapshot().pending, false); assert.equal(f.calls.length, 2);
    await f.advance(5000);
    assert.equal(f.calls.length, barrier ? 2 : 3);
    assert.equal(f.events.filter(event => event === "refresh").length, barrier ? 0 : 1);
    if (!barrier) { assert.equal(f.client.fresh(), true); assert.equal(f.client.servers()[0].credential, "fresh-secret"); assert.equal(f.client.snapshot().active, true); }
    f.client.close(); assert.equal(f.timers.size, 0);
  }
});
