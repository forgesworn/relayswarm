import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTurnCredentialService, validateTurnCredentialsUrl } from "../demo/turn-credential-service.mjs";
import { startDemoServer } from "../demo/server.mjs";

const payload = (n = 1, ttl = 3600) => ({ urls: ["turns:relay.invalid:5349"], username: `test-${n}`, credential: `private-test-${n}`, ttl });
const response = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  let total = 0, closed = 0; const events = [];
  const controls = createTurnCredentialService({ url: "https://issuer.invalid/turn", fetchImpl: async () => response(payload()), ...options });
  let base;
  const notify = () => { for (const item of [...events]) if (item.ready()) { events.splice(events.indexOf(item), 1); item.done(); } };
  const server = createServer((request, res) => {
    request.once("end", () => queueMicrotask(() => { total++; notify(); }));
    res.once("close", () => queueMicrotask(() => { closed++; notify(); }));
    controls.handle(request, res, new URL(request.url, "http://localhost").pathname, base).then(handled => { if (!handled) res.writeHead(404).end(); }).catch(() => res.destroy());
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${server.address().port}`;
  const result = { controls, base, allowCloseFailure: false,
    async post(cookie, extra = {}) {
      const res = await fetch(`${base}/turn-credentials`, { method: "POST", ...extra, headers: { origin: base, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...extra.headers }, body: extra.body ?? '{"v":1}' });
      return { status: res.status, cookie: res.headers.get("set-cookie")?.split(";")[0], headers: res.headers, body: await res.json() };
    },
    until(kind, n) {
      return new Promise((done, reject) => {
        const item = { ready: () => (kind === "end" ? total : closed) >= n, done: () => { clearTimeout(timer); done(); } };
        const timer = setTimeout(() => { events.splice(events.indexOf(item), 1); reject(new Error("Owned HTTP event deadline")); }, 1000);
        events.push(item); notify();
      });
    },
  };
  t.after(async () => {
    try { await controls.close(); } catch (error) { if (!result.allowCloseFailure) throw error; }
    finally { server.closeAllConnections(); await new Promise(done => server.close(done)); }
  });
  return result;
}

test("issuer URL rejects credentials, queries, fragments and non-HTTPS before I/O", () => {
  for (const url of [undefined, "http://issuer.invalid/turn", "https://user:secret@issuer.invalid/turn", "https://issuer.invalid/turn?", "https://issuer.invalid/turn#", "https://issuer.invalid/turn?q=private", "https://issuer.invalid/turn\n"]) assert.throws(() => validateTurnCredentialsUrl(url), /credential-free HTTPS/u);
  assert.equal(validateTurnCredentialsUrl("https://issuer.invalid/turn"), "https://issuer.invalid/turn");
  assert.throws(() => createTurnCredentialService({ url: "https://issuer.invalid/turn", capacity: 65 }));
});

test("actual HTTP viewer cookies isolate credentials; repeated reads cache without minting", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, { fetchImpl: async (url, options) => {
    assert.equal(url, "https://issuer.invalid/turn"); assert.equal(options.redirect, "error"); assert.equal(options.credentials, "omit"); assert.equal(options.cache, "no-store");
    assert.deepEqual(options.headers, { accept: "application/json" }); return response(payload(++calls));
  } });
  const first = await f.post(), second = await f.post();
  assert.equal(first.status, 200); assert.equal(second.status, 200); assert.notEqual(first.cookie, second.cookie); assert.notEqual(first.body.iceServers[0].username, second.body.iceServers[0].username);
  assert.match(first.headers.get("set-cookie"), /Path=\/turn-credentials; HttpOnly; SameSite=Strict; Max-Age=10800/u);
  assert.equal(first.headers.get("cache-control"), "no-store");
  const cached = await f.post(first.cookie); assert.equal(calls, 2); assert.deepEqual(cached.body.iceServers, first.body.iceServers);
  assert.deepEqual(Object.keys(first.body).sort(), ["v", "iceServers", "ttlSeconds", "issuedAt", "expiresAt", "refreshAt", "serverTime"].sort());
  assert.equal(first.body.expiresAt, first.body.issuedAt + 3600000); assert.equal(first.body.refreshAt, first.body.issuedAt + 2400000);
});

test("refresh expiry is anchored before delayed fetch, and refresh is per viewer single flight", { timeout: 5000 }, async t => {
  let wall = 1000000, mono = 1000, calls = 0, held;
  const f = await fixture(t, { now: () => wall, monotonicNow: () => mono, fetchImpl: async () => {
    calls++; if (held) await held.promise; return response(payload(calls, 5));
  } });
  const first = await f.post(); assert.equal(first.body.expiresAt, 1005000);
  wall += 3334; mono += 3334; held = deferred();
  const a = f.post(first.cookie), b = f.post(first.cookie); await f.until("end", 3); assert.equal(calls, 2);
  wall += 700; mono += 700; held.resolve();
  const [one, two] = await Promise.all([a, b]); assert.equal(one.status, 200); assert.deepEqual(one.body, two.body);
  assert.equal(one.body.issuedAt, 1003000); assert.equal(one.body.expiresAt, 1008000); assert.equal(one.body.serverTime, 1004034);
});

test("one disconnected waiter does not cancel another; last waiter cancellation aborts upstream", { timeout: 5000 }, async t => {
  let wall = 1000000, mono = 1000, held, signal, calls = 0, upstreamAborted;
  const f = await fixture(t, { now: () => wall, monotonicNow: () => mono, fetchImpl: async (_url, options) => {
    if (++calls === 1) return response(payload(1, 5));
    signal = options.signal; const aborted = deferred(); upstreamAborted = aborted; signal.addEventListener("abort", () => aborted.resolve(), { once: true }); await held.promise;
    if (signal.aborted) throw new Error("private ignored cancellation"); return response(payload(2, 5));
  } });
  const initial = await f.post(); wall += 3334; mono += 3334; held = deferred();
  const controller = new AbortController(); const a = f.post(initial.cookie, { signal: controller.signal }).catch(() => null), b = f.post(initial.cookie);
  await f.until("end", 3); controller.abort(); await a; await f.until("close", 2); assert.equal(signal.aborted, false);
  held.resolve(); assert.equal((await b).status, 200);
  wall += 3334; mono += 3334; held = deferred(); const last = new AbortController(); const pending = f.post(initial.cookie, { signal: last.signal }).catch(() => null);
  await f.until("end", 4); last.abort(); await pending; await upstreamAborted.promise; assert.equal(signal.aborted, true); held.resolve();
});

test("logical timeout cannot start a second same-viewer fetch while raw cancellation is unresolved", { timeout: 5000 }, async t => {
  let wall = 1000000, mono = 1000, calls = 0, signal; const release = deferred();
  const f = await fixture(t, { timeoutMs: 30, now: () => wall, monotonicNow: () => mono, fetchImpl: async (_url, options) => {
    if (++calls === 1) return response(payload(1, 5)); signal = options.signal; await release.promise; return response(payload(2, 5));
  } });
  const first = await f.post(); wall += 3334; mono += 3334;
  assert.equal((await f.post(first.cookie)).status, 503); assert.equal(signal.aborted, true);
  assert.equal((await f.post(first.cookie)).status, 503); assert.equal(calls, 2);
  f.allowCloseFailure = true; await assert.rejects(f.controls.close(), /cancellation remains unresolved/u);
  release.resolve();
});

test("unresolved raw tasks retain the global issuance ceiling even after token refill", { timeout: 5000 }, async t => {
  let wall = 1000000, mono = 1000, calls = 0; const release = deferred();
  const f = await fixture(t, { timeoutMs: 30, now: () => wall, monotonicNow: () => mono, fetchImpl: async () => {
    calls++; await release.promise; return response(payload(calls));
  } });
  const results = await Promise.all(Array.from({ length: 11 }, () => f.post()));
  assert.equal(calls, 10); assert.equal(results.filter(r => r.status === 503).length, 10); assert.equal(results.filter(r => r.status === 429).length, 1);
  wall += 3000; mono += 3000; assert.equal((await f.post()).status, 429); assert.equal(calls, 10);
  f.allowCloseFailure = true; await assert.rejects(f.controls.close(), /cancellation remains unresolved/u); release.resolve();
});

test("non-200 and early header refusals abort and cancel their unread bodies without disclosing content", { timeout: 5000 }, async t => {
  for (const kind of ["status", "type", "length", "redirect"]) {
    let cancelled = false, signal;
    const f = await fixture(t, { fetchImpl: async (_url, options) => {
      signal = options.signal;
      return { status: kind === "status" ? 502 : 200, redirected: kind === "redirect", headers: new Headers({ "content-type": kind === "type" ? "text/plain" : "application/json", ...(kind === "length" ? { "content-length": "20000" } : {}) }),
        body: new ReadableStream({ cancel() { cancelled = true; } }) };
    } });
    const r = await f.post(); assert.equal(r.status, 503); assert.deepEqual(r.body, { error: "turn-unavailable" }); assert.equal(cancelled, true); assert.equal(signal.aborted, true);
  }
});

test("fetch plus body has one deadline; withheld, oversized and malformed bodies refuse", { timeout: 5000 }, async t => {
  let signal, cancelled = false;
  const slow = await fixture(t, { timeoutMs: 30, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(c) { signal.addEventListener("abort", () => c.error(new Error("private abort")), { once: true }); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/json" } });
  } });
  assert.equal((await slow.post()).status, 503); assert.equal(signal.aborted, true);
  for (const body of ["private-malformed", "x".repeat(16385), JSON.stringify({ ...payload(), ttl: 3601 }), JSON.stringify({ ...payload(), ttl: 4 }), JSON.stringify({ ...payload(), secret: "private" }), JSON.stringify({ ...payload(), urls: ["stun:relay.invalid:5349"] })]) {
    const f = await fixture(t, { fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }) });
    const r = await f.post(); assert.equal(r.status, 503); assert.equal(JSON.stringify(r.body).includes("private"), false);
  }
  void cancelled;
});

test("global burst/refill, viewer capacity and strict origins cannot be bypassed with caller IDs", { timeout: 5000 }, async t => {
  let mono = 1000, wall = 1000000, calls = 0;
  const f = await fixture(t, { now: () => wall, monotonicNow: () => mono, fetchImpl: async () => response(payload(++calls)) });
  for (let i = 0; i < 10; i++) assert.equal((await f.post()).status, 200);
  const limited = await f.post(); assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "3"); assert.equal(calls, 10);
  mono += 3000; wall += 3000; assert.equal((await f.post()).status, 200); assert.equal(calls, 11);
  assert.equal((await f.post(null, { headers: { origin: "https://foreign.invalid" } })).status, 403);
  assert.equal((await f.post(null, { body: '{"v":1,"viewer":"forged"}' })).status, 400);
  assert.equal((await f.post(null, { body: "x".repeat(129) })).status, 413);
  const capped = await fixture(t, { capacity: 1 }); const first = await capped.post(); assert.equal(first.status, 200);
  assert.equal((await capped.post()).status, 429); assert.equal((await capped.post(first.cookie)).status, 200);
});

test("wall rollback and monotonic expiry refuse cached credentials", { timeout: 5000 }, async t => {
  let wall = 1000000, mono = 1000, calls = 0;
  const f = await fixture(t, { now: () => wall, monotonicNow: () => mono, fetchImpl: async () => {
    if (++calls > 1) throw new Error("private issuer down"); return response(payload(1, 5));
  } });
  const first = await f.post(); mono += 6000;
  assert.equal((await f.post(first.cookie)).status, 503);
  wall--; assert.equal((await f.post(first.cookie)).status, 503);
  assert.equal(calls, 2);
});

test("demo exposes descriptor only, never mints on session polls, and defaults off", { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-turn-service-")); let demo, calls = 0;
  t.after(async () => { try { await demo?.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n"); await writeFile(join(directory, "segment.ts"), "fixture");
  const options = { mediaDir: directory, manifest: "index.m3u8" };
  demo = await startDemoServer(options); assert.equal((await fetch(`${demo.base}/session.json`).then(r => r.json())).turnCredentials, undefined);
  assert.equal((await fetch(`${demo.base}/turn-credentials`)).status, 404); await demo.close(); demo = null;
  await assert.rejects(startDemoServer({ ...options, iceServers: [], turnCredentials: { url: "https://issuer.invalid/turn" } }), /either static/u);
  demo = await startDemoServer({ ...options, turnCredentials: { url: "https://issuer.invalid/turn", fetchImpl: async () => response(payload(++calls)) } });
  for (let i = 0; i < 3; i++) {
    const session = await fetch(`${demo.base}/session.json`).then(r => r.json());
    assert.deepEqual(session.turnCredentials, { v: 1, endpoint: "/turn-credentials", method: "POST" }); assert.equal(session.iceServers, undefined);
    assert.equal(JSON.stringify(session).includes("private-test"), false);
  }
  assert.equal(calls, 0);
  assert.equal((await fetch(`${demo.base}/turn-credentials`, { method: "POST", headers: { origin: demo.base, "content-type": "application/json" }, body: '{"v":1}' })).status, 200);
  assert.equal(calls, 1);
});
