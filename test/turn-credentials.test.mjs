import test from "node:test";
import assert from "node:assert/strict";
import { createTurnCredentials, normalizeTurnCredentialDescriptor } from "../demo/turn-credentials.mjs";
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
  f.fetch(async () => jsonResponse(f.payload(60, "renewed-private-credential")));
  await f.advance(40000); assert.equal(f.calls.length, 2); assert.deepEqual(f.events, ["configuration-changed", "refresh"]);
  assert.equal(f.client.fresh(), true); assert.equal(f.client.snapshot().refreshes, 2);
  assert.equal(f.client.servers()[0].credential, "renewed-private-credential");
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

test("unchanged cached credentials preserve the original lease and retry without rebuilding peers", async () => {
  for (const barrier of [null, "expired", "inactive", "suspend", "identity", "close"]) {
    const f = fixture(); f.client.configure(descriptor, "session");
    const issued = f.payload(15); let initialReply;
    f.fetch(() => new Promise(resolve => { initialReply = resolve; }));
    const acquiring = f.client.acquire(); await flush();
    // The server timestamps a delayed initial response 200ms after its request
    // began. Request-start anchoring schedules refresh before its cache expires.
    f.jump(250); initialReply(jsonResponse({ ...issued, serverTime: issued.issuedAt + 200 }));
    assert.equal(await acquiring, true);
    f.fetch(async () => jsonResponse({ ...issued, serverTime: issued.issuedAt + 9800 }));
    await f.advance(9550);
    assert.equal(f.calls.length, 2);
    assert.equal(f.client.snapshot().remainingMs, 5000, "Cached reply must not extend the original conservative expiry");
    assert.equal(f.client.snapshot().refreshes, 1);
    assert.equal(f.events.filter(event => event === "refresh").length, 0);
    assert.equal(Math.min(...[...f.timers.values()].map(timer => timer.at)), 12300, "Use the existing bounded retry, not the cached refresh boundary");
    f.fetch(async () => jsonResponse(f.payload(15, "new-private-credential")));
    if (barrier === "expired") { f.jump(5000); assert.equal(f.client.fresh(), false); }
    if (barrier === "inactive") f.client.setActive(false);
    if (barrier === "suspend") f.client.suspend();
    if (barrier === "identity") f.client.configure(descriptor, "replacement");
    if (barrier === "close") f.client.close();
    await f.advance(2499); assert.equal(f.calls.length, 2);
    await f.advance(1);
    assert.equal(f.calls.length, barrier ? 2 : 3);
    assert.equal(f.client.snapshot().refreshes, barrier ? 1 : 2);
    assert.equal(f.events.filter(event => event === "refresh").length, barrier ? 0 : 1);
    if (!barrier) assert.equal(f.client.servers()[0].credential, "new-private-credential");
    f.client.close(); assert.equal(f.timers.size, 0);
  }
});


test("TURN projection descriptor is exact and issued is the same inert configuration as an absent default", async () => {
  const f = fixture();
  try {
    assert.deepEqual(normalizeTurnCredentialDescriptor({ ...descriptor, urlProjection: "issued" }), descriptor);
    f.client.configure(descriptor, "session"); assert.equal(await f.client.acquire(), true);
    f.client.configure({ ...descriptor, urlProjection: "issued" }, "session");
    assert.equal(f.client.fresh(), true); assert.equal(f.calls.length, 1); assert.equal(f.events.length, 1);
    for (const bad of [null, "", "all", "TLS-TCP", true, {}]) {
      f.client.configure({ ...descriptor, urlProjection: bad }, "session"); assert.equal(await f.client.acquire(), false);
    }
    f.client.configure({ ...descriptor, urlProjection: "tls-tcp", extra: true }, "session"); assert.equal(await f.client.acquire(), false);
    assert.equal(f.calls.length, 1); assert.equal(f.client.fresh(), false);
  } finally { f.client.close(); }
});

test("TLS TCP client independently rejects unprojected or mixed responses without widening the selected policy", async () => {
  for (const urls of [["turns:relay.test:5349"], ["turn:relay.test:5349?transport=tcp"], ["turns:relay.test:5349?transport=udp"], ["turns:relay.test?transport=tcp", "turn:relay.test"], ["turns:relay.test?transport=tcp&transport=udp"]]) {
    const f = fixture(); f.client.configure({ ...descriptor, urlProjection: "tls-tcp" }, "session");
    try {
      f.fetch(async () => { const value = f.payload(); value.iceServers[0].urls = urls; return jsonResponse(value); });
      assert.equal(await f.client.acquire(), false); assert.equal(f.client.fresh(), false); assert.equal(f.client.servers(), undefined);
      assert.equal(f.calls.length, 1); assert.equal(f.client.snapshot().refreshes, 0);
    } finally { f.client.close(); }
  }
});

test("TURN projection change aborts a held body, fences late completion and keeps its raw single-flight slot until settlement", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); let release, signal;
  try {
    f.fetch(async (_url, options) => {
      signal = options.signal; const body = JSON.stringify(f.payload());
      return { ok: true, redirected: false, headers: new Headers({ "content-type": "application/json" }), body: {
        getReader() { let count = 0; return { read() { if (count++) return Promise.resolve({ done: true }); return new Promise(resolve => { release = () => resolve({ done: false, value: new TextEncoder().encode(body) }); }); }, cancel: async () => {}, releaseLock() {} }; },
      } };
    });
    const applying = f.client.acquire(); await flush(); assert.equal(typeof release, "function");
    f.client.configure({ ...descriptor, urlProjection: "tls-tcp" }, "session");
    assert.equal(signal.aborted, true); assert.equal(await applying, false); assert.equal(f.client.snapshot().pending, true);
    assert.equal(await f.client.acquire(), false); assert.equal(f.calls.length, 1);
    release(); await flush(); assert.equal(f.client.snapshot().pending, false); assert.equal(f.client.fresh(), false);
    f.fetch(async () => jsonResponse(f.payload())); assert.equal(await f.client.acquire(), true);
    assert.equal(f.calls.length, 2); assert.deepEqual(f.client.servers()[0].urls, ["turns:relay.test:5349?transport=tcp"]);
    assert.equal(f.events.filter(value => value === "refresh").length, 0);
  } finally { f.client.close(); }
});

test("TLS TCP cached material preserves expiry and refreshes only new compliant material before original expiry", async () => {
  for (const barrier of [null, "expired", "inactive", "suspend", "identity", "close"]) {
    const f = fixture(); f.client.configure({ ...descriptor, urlProjection: "tls-tcp" }, "session");
    try {
      const issued = f.payload(15); let reply;
      f.fetch(() => new Promise(resolve => { reply = resolve; })); const applying = f.client.acquire(); await flush();
      f.jump(250); reply(jsonResponse({ ...issued, serverTime: issued.issuedAt + 200 })); assert.equal(await applying, true);
      f.fetch(async () => jsonResponse({ ...issued, serverTime: issued.issuedAt + 9800 })); await f.advance(9550);
      assert.equal(f.client.snapshot().remainingMs, 5000); assert.equal(f.client.snapshot().refreshes, 1); assert.equal(f.events.includes("refresh"), false);
      if (barrier === "expired") { f.jump(5000); assert.equal(f.client.fresh(), false); }
      if (barrier === "inactive") f.client.setActive(false);
      if (barrier === "suspend") f.client.suspend();
      if (barrier === "identity") f.client.configure({ ...descriptor, urlProjection: "tls-tcp" }, "replacement");
      if (barrier === "close") f.client.close();
      f.fetch(async () => jsonResponse(f.payload(15, "new-private-material"))); await f.advance(2500);
      assert.equal(f.calls.length, barrier ? 2 : 3); assert.equal(f.client.snapshot().refreshes, barrier ? 1 : 2);
      assert.equal(f.events.filter(value => value === "refresh").length, barrier ? 0 : 1);
    } finally { f.client.close(); }
  }
});

test("lease observation retains validated3600s metadata and the original conservative request anchors", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); const issued = f.payload(3600); let reply;
  f.fetch(() => new Promise(resolve => { reply = resolve; })); const acquiring = f.client.acquire(); await flush();
  f.jump(250); reply(jsonResponse({ ...issued, serverTime: issued.issuedAt + 200 }));
  assert.equal(await acquiring, true);
  assert.deepEqual(f.client.snapshot().lease, { leaseOrdinal: 1, authorityEpoch: 1, acceptanceKind: "explicit",
    ttlSeconds: 3600, issuedAt: 1000000, expiresAt: 4600000, refreshAt: 3400000, serverTime: 1000200,
    requestStartedMonotonicMs: 0, expiresAtMonotonicMs: 3599800, refreshAtMonotonicMs: 2399800, responseObservedMonotonicMs: 250, fullTtlAfterResponseMonotonicMs: 3600250 });
  assert.equal(f.client.snapshot().remainingMs, 3599550); f.client.close();
});

test("a distinct naturally scheduled3600s successor advances lease ordinal without changing authority epoch", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); f.fetch(async () => jsonResponse(f.payload(3600)));
  assert.equal(await f.client.acquire(), true); const first = f.client.snapshot();
  f.fetch(async () => jsonResponse(f.payload(3600, "successor-private-credential")));
  await f.advance(2400000); const next = f.client.snapshot();
  assert.equal(f.calls.length, 2); assert.equal(next.lease.leaseOrdinal, 2); assert.equal(next.lease.acceptanceKind, "automatic");
  assert.equal(next.authorityEpoch, first.authorityEpoch); assert.equal(next.lease.authorityEpoch, first.authorityEpoch);
  assert.equal(next.lease.ttlSeconds, 3600); assert.equal(next.lease.requestStartedMonotonicMs, 2400000);
  assert.equal(next.lease.expiresAtMonotonicMs, 6000000); assert.equal(next.lease.refreshAtMonotonicMs, 4800000);
  assert.deepEqual(f.events, ["configuration-changed", "refresh"]);
  // The demo refresh callback's stop/configure path changes cancellation generation.
  // Those operations must not masquerade as a new TURN authority epoch.
  f.client.setActive(false); f.client.configure({ ...descriptor }, "session"); f.client.setActive(true);
  assert.equal(f.client.snapshot().authorityEpoch, first.authorityEpoch); assert.deepEqual(f.client.snapshot().lease, next.lease);
  f.client.close();
});

test("an early cached response preserves every original observed lease field and deadline", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); const issued = f.payload(15); let reply;
  f.fetch(() => new Promise(resolve => { reply = resolve; })); const acquiring = f.client.acquire(); await flush();
  f.jump(250); reply(jsonResponse({ ...issued, serverTime: issued.issuedAt + 200 })); assert.equal(await acquiring, true);
  const before = f.client.snapshot().lease;
  f.fetch(async () => jsonResponse({ ...issued, serverTime: issued.issuedAt + 9800 })); await f.advance(9550);
  assert.deepEqual(f.client.snapshot().lease, before); assert.equal(f.client.snapshot().remainingMs, 5000);
  assert.equal(f.client.snapshot().refreshes, 1); assert.equal(f.events.filter(x => x === "refresh").length, 0);
  f.client.close();
});

test("only actual configuration, suspension and unavailability boundaries advance authority epoch", async () => {
  const f = fixture(); assert.equal(f.client.snapshot().authorityEpoch, 0);
  f.client.configure(descriptor, "session"); await f.client.acquire(); assert.equal(f.client.snapshot().authorityEpoch, 1);
  f.client.setActive(false); f.client.setActive(true); f.client.configure({ ...descriptor }, "session");
  assert.equal(f.client.snapshot().authorityEpoch, 1);
  f.client.suspend(); assert.equal(f.client.snapshot().authorityEpoch, 2); assert.equal(f.client.snapshot().lease, null);
  f.client.suspend(); assert.equal(f.client.snapshot().authorityEpoch, 2);
  assert.equal(await f.client.acquire(), true); assert.equal(f.client.snapshot().lease.leaseOrdinal, 2);
  assert.equal(f.client.snapshot().lease.acceptanceKind, "explicit"); assert.equal(f.client.snapshot().authorityEpoch, 2);
  f.client.configure(descriptor, "replacement"); assert.equal(f.client.snapshot().authorityEpoch, 3);
  assert.equal(f.client.snapshot().lease, null); assert.equal(await f.client.acquire(), true);
  assert.equal(f.client.snapshot().lease.leaseOrdinal, 3); assert.equal(f.client.snapshot().lease.authorityEpoch, 3);
  f.client.close(); assert.equal(f.client.snapshot().authorityEpoch, 4); f.client.close(); assert.equal(f.client.snapshot().authorityEpoch, 4);
});

test("expiry clears the lease and advances authority once while retaining explicit reacquisition semantics", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); f.fetch(async () => jsonResponse(f.payload(3600)));
  await f.client.acquire(); f.client.setActive(false); f.jump(3600001);
  assert.equal(f.client.fresh(), false); assert.equal(f.client.snapshot().lease, null); assert.equal(f.client.snapshot().authorityEpoch, 2);
  assert.equal(f.client.fresh(), false); assert.equal(f.client.snapshot().authorityEpoch, 2); assert.equal(f.calls.length, 1);
  assert.equal(await f.client.acquire(), true); assert.equal(f.client.snapshot().lease.leaseOrdinal, 2);
  assert.equal(f.client.snapshot().lease.authorityEpoch, 2); assert.equal(f.client.snapshot().lease.acceptanceKind, "explicit");
  assert.equal(f.events.filter(x => x === "expired").length, 1); assert.equal(f.events.includes("refresh"), false); f.client.close();
});

test("late fenced responses never install an observed lease or advance its ordinal", async () => {
  for (const barrier of ["suspend", "identity", "close"]) {
    const f = fixture(); f.client.configure(descriptor, "session"); let reply;
    f.fetch(() => new Promise(resolve => { reply = resolve; })); const acquiring = f.client.acquire(); await flush();
    if (barrier === "suspend") f.client.suspend();
    if (barrier === "identity") f.client.configure(descriptor, "replacement");
    if (barrier === "close") f.client.close();
    const epoch = f.client.snapshot().authorityEpoch; reply(jsonResponse(f.payload(3600))); assert.equal(await acquiring, false);
    assert.equal(f.client.snapshot().lease, null); assert.equal(f.client.snapshot().refreshes, 0);
    assert.equal(f.client.snapshot().authorityEpoch, epoch); f.client.close();
  }
});

test("lease snapshot has exact redacted scalar keys and independent defensive copies", async () => {
  const f = fixture(); f.client.configure(descriptor, "private-session"); await f.client.acquire();
  const before = f.client.snapshot(), original = { ...before.lease };
  assert.deepEqual(Object.keys(before.lease).sort(), ["leaseOrdinal", "authorityEpoch", "acceptanceKind", "ttlSeconds", "issuedAt", "expiresAt", "refreshAt", "serverTime", "requestStartedMonotonicMs", "expiresAtMonotonicMs", "refreshAtMonotonicMs", "responseObservedMonotonicMs", "fullTtlAfterResponseMonotonicMs"].sort());
  assert.ok(Object.entries(before.lease).every(([key, value]) => key === "acceptanceKind" ? value === "explicit" : typeof value === "number" && Number.isFinite(value)));
  before.lease.leaseOrdinal = 999; before.lease.expiresAtMonotonicMs = -1; before.authorityEpoch = 999; before.lease.responseObservedMonotonicMs = -1; before.lease.fullTtlAfterResponseMonotonicMs = -1;
  assert.deepEqual(f.client.snapshot().lease, original); assert.equal(f.client.snapshot().authorityEpoch, 1);
  const text = JSON.stringify(f.client.snapshot()); for (const forbidden of ["private-", "relay.test", "turns:", "username", "credential", "servers", "session"]) assert.equal(text.includes(forbidden), false);
  f.client.close(); assert.equal(f.client.snapshot().lease, null);
});

test("observation does not confuse issuer wall time with the page monotonic domain", async () => {
  const f = fixture(); f.jump(7000000, 1000); f.client.configure(descriptor, "session");
  f.fetch(async () => jsonResponse(f.payload(3600))); assert.equal(await f.client.acquire(), true);
  const lease = f.client.snapshot().lease; assert.equal(lease.issuedAt, 1001000); assert.equal(lease.serverTime, 1001000);
  assert.equal(lease.requestStartedMonotonicMs, 7000000); assert.equal(lease.expiresAtMonotonicMs, 10600000);
  assert.equal(lease.refreshAtMonotonicMs, 9400000); assert.equal(f.client.snapshot().remainingMs, 3600000); f.client.close();
});

test("a failed refresh retaining valid authority does not create a new lease or authority epoch", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); await f.client.acquire(); const before = f.client.snapshot();
  f.fetch(async () => { throw Error("private upstream detail"); }); await f.advance(40000);
  assert.equal(f.client.snapshot().available, true); assert.deepEqual(f.client.snapshot().lease, before.lease);
  assert.equal(f.client.snapshot().authorityEpoch, before.authorityEpoch); assert.equal(f.client.snapshot().failures, 1);
  assert.equal(f.client.snapshot().refreshes, 1); assert.equal(f.events.includes("refresh"), false); f.client.close();
});

test("disabled suspension and close never manufacture authority epochs", () => {
  for (const configured of [false, true]) {
    const f = fixture();
    if (configured) f.client.configure(null, "disabled-session");
    const epoch = f.client.snapshot().authorityEpoch;
    assert.equal(epoch, configured ? 1 : 0); assert.equal(f.client.snapshot().enabled, false);
    for (let i = 0; i < 3; i++) {
      f.client.suspend(); assert.equal(f.client.snapshot().authorityEpoch, epoch);
      assert.equal(f.client.snapshot().lease, null); assert.equal(f.client.snapshot().enabled, false);
    }
    f.client.close(); f.client.close(); f.client.suspend();
    assert.equal(f.client.snapshot().authorityEpoch, epoch); assert.equal(f.client.snapshot().closed, true);
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  }
});

test("leaseObservation is a defensive three-scalar copy with zero operational reads or effects", async () => {
  let mono = 100, wall = 1000000, deny = false; const operations = [];
  const touch = name => { operations.push(name); if (deny) throw Error("Getter performed an operational action"); };
  const client = createTurnCredentials({ origin: "https://viewer.test",
    now() { touch("mono"); return mono; }, wallNow() { touch("wall"); return wall; },
    setTimer() { touch("set"); return 1; }, clearTimer() { touch("clear"); },
    fetchImpl() { touch("fetch"); return Promise.resolve(jsonResponse({ v: 1, iceServers: [{ urls: ["turns:relay.test:5349?transport=tcp"], username: "private-user", credential: "private-secret" }], ttlSeconds: 60, issuedAt: 1000000, expiresAt: 1060000, refreshAt: 1040000, serverTime: 1000000 })); },
    onRefresh() { touch("refresh"); }, onUnavailable() { touch("unavailable"); },
  });
  const inert = [...operations]; deny = true; assert.equal(client.leaseObservation(), null); assert.deepEqual(operations, inert); deny = false;
  client.configure(descriptor, "session"); assert.equal(await client.acquire(), true);
  const expected = { authorityEpoch: 1, leaseOrdinal: 1, responseObservedMonotonicMs: 100 };
  const before = client.snapshot(), trace = [...operations]; deny = true;
  const first = client.leaseObservation(); assert.deepEqual(first, expected); assert.deepEqual(Object.keys(first).sort(), Object.keys(expected).sort());
  first.authorityEpoch = 999; first.leaseOrdinal = 999; first.responseObservedMonotonicMs = -1;
  const second = client.leaseObservation(); assert.deepEqual(second, expected); assert.notEqual(second, first); assert.deepEqual(operations, trace);
  deny = false; assert.deepEqual(client.snapshot(), before);
  // The passive stamp does not compute freshness or grant authority, even after time passes.
  mono += 60001; wall += 60001; const expiredTrace = [...operations]; deny = true;
  assert.deepEqual(client.leaseObservation(), expected); assert.deepEqual(operations, expiredTrace); deny = false;
  assert.equal(client.fresh(), false); assert.equal(client.leaseObservation(), null); client.close();
});

test("leaseObservation follows a genuine automatic distinct successor without changing authority epoch", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); await f.client.acquire();
  const before = f.client.leaseObservation(); assert.deepEqual(before, { authorityEpoch: 1, leaseOrdinal: 1, responseObservedMonotonicMs: 0 });
  f.fetch(async () => jsonResponse(f.payload(60, "successor-private-credential"))); await f.advance(40000);
  assert.deepEqual(f.client.leaseObservation(), { authorityEpoch: 1, leaseOrdinal: 2, responseObservedMonotonicMs: 40000 });
  assert.equal(f.client.snapshot().lease.acceptanceKind, "automatic"); assert.deepEqual(f.events, ["configuration-changed", "refresh"]); f.client.close();
});

test("leaseObservation preserves the original stamp for an unchanged cached response", async () => {
  const f = fixture(); f.client.configure(descriptor, "session"); const issued = f.payload();
  f.fetch(async () => jsonResponse(issued)); await f.client.acquire(); const before = f.client.leaseObservation();
  f.fetch(async () => jsonResponse({ ...issued, serverTime: issued.issuedAt + 40000 })); await f.advance(40000);
  assert.deepEqual(f.client.leaseObservation(), before); assert.equal(f.client.snapshot().refreshes, 1);
  assert.equal(f.events.includes("refresh"), false); f.client.close();
});

test("leaseObservation clears on suspension, configuration change and close without reacquiring", async () => {
  const f = fixture(); assert.equal(f.client.leaseObservation(), null); f.client.configure(descriptor, "session"); assert.equal(f.client.leaseObservation(), null);
  await f.client.acquire(); const first = f.client.leaseObservation(); f.client.suspend(); assert.equal(f.client.leaseObservation(), null);
  const calls = f.calls.length; assert.equal(f.client.leaseObservation(), null); assert.equal(f.calls.length, calls);
  await f.client.acquire(); assert.deepEqual(f.client.leaseObservation(), { ...first, authorityEpoch: first.authorityEpoch + 1, leaseOrdinal: first.leaseOrdinal + 1 });
  f.client.configure(descriptor, "replacement"); assert.equal(f.client.leaseObservation(), null); assert.equal(f.calls.length, calls + 1);
  await f.client.acquire(); f.client.close(); assert.equal(f.client.leaseObservation(), null);
});
