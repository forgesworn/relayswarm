import { get as httpGet } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { startDemoServer } from "../demo/server.mjs";
import { startBroadcastWaitingServer } from "../demo/broadcast-waiting.mjs";

async function start(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-demo-test-"));
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:4@0\nshared.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:4\nshared.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "shared.ts"), "abcdefgh");
  await writeFile(join(directory, "private.key"), "do not serve");
  let demo;
  try { demo = await startDemoServer({ mediaDir: directory, manifest: "index.m3u8", iceServers: [], ...options }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  t.after(async () => { await demo.close(); await rm(directory, { recursive: true, force: true }); });
  return demo;
}

test("demo serves exact HTTP ranges and matching signed commitments without exposing keys", async (t) => {
  const demo = await start(t);
  const session = await fetch(`${demo.base}/session.json`).then((response) => response.json());
  assert.equal(session.swarmId, demo.publisher.swarmId);
  assert.equal(session.secretKey, undefined);
  const response = await fetch(`${demo.base}/media/shared.ts`, { headers: { range: "bytes=4-7" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 4-7/8");
  assert.equal(await response.text(), "efgh");
  const query = new URLSearchParams({ path: "/media/shared.ts", level: "0", sequence: "1", cc: "0", start: "4", end: "8" });
  const commitment = await fetch(`${demo.base}/commitment?${query}`).then((value) => value.json());
  assert.equal(JSON.parse(commitment.content).size, 4);
  for (const path of ["/media/private.key", "/private.key", "/media/%2e%2e/private.key", "/media/shared.ts?notlisted=1"]) {
    // Query strings on an already listed media resource do not grant new access.
    if (path.includes("?")) assert.equal((await fetch(`${demo.base}${path}`)).status, 200);
    else assert.equal((await fetch(`${demo.base}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${demo.base}/media/shared.ts`, { headers: { range: "bytes=8-10" } })).status, 416);
  query.set("cc", "1"); assert.equal((await fetch(`${demo.base}/commitment?${query}`)).status, 404);
  assert.equal((await fetch(`${demo.base}/session.json`, { method: "POST" })).status, 405);
  const page = await fetch(demo.base);
  assert.ok(!page.headers.get("content-security-policy").includes("unsafe-inline"));
  assert.match(await page.text(), /id="upload" type="checkbox"/u);
});

test("demo refuses insecure remote bindings and invalid external configuration", async () => {
  await assert.rejects(startDemoServer({ host: "0.0.0.0" }), /require HTTPS/u);
  for (const publicUrl of ["http://example.test", "https://user:pass@example.test", "https://example.test/path"]) await assert.rejects(startDemoServer({ publicUrl }), /HTTPS origin/u);
  await assert.rejects(startDemoServer({ relays: ["ws://public.example"] }), /wss/u);
});

test("bounded demo relay delivers signed swarm events, honours CLOSE and recovers after an outage", async (t) => {
  const demo = await start(t);
  const connect = () => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${demo.base.replace(/^http/u, "ws")}/relay`, { origin: demo.base });
    socket.once("open", () => resolve(socket)); socket.once("error", reject);
  });
  const socket = await connect(); t.after(() => socket.terminate());
  const frames = []; socket.on("message", (raw) => frames.push(JSON.parse(raw)));
  const received = (predicate, description) => new Promise((done, reject) => {
    if (frames.some(predicate)) { done(); return; }
    const cleanup = () => { clearTimeout(timer); socket.off("message", check); socket.off("close", closed); };
    const check = (raw) => { if (predicate(JSON.parse(raw))) { cleanup(); done(); } };
    const closed = () => { cleanup(); reject(new Error(`Relay closed before ${description}`)); };
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Relay did not deliver ${description} within five seconds`)); }, 5000);
    socket.on("message", check); socket.once("close", closed);
  });
  socket.send(JSON.stringify(["REQ", "s", { kinds: [24170], "#x": [demo.publisher.swarmId] }]));
  await received((frame) => frame[0] === "EOSE" && frame[1] === "s", "subscription readiness");
  const event = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", demo.publisher.swarmId]], content: "presence" }, generateSecretKey());
  socket.send(JSON.stringify(["EVENT", event]));
  await received((frame) => frame[0] === "EVENT" && frame[2].id === event.id, "the subscribed signed event");
  socket.send(JSON.stringify(["CLOSE", "s"]));
  const other = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", demo.publisher.swarmId]], content: "next" }, generateSecretKey());
  socket.send(JSON.stringify(["EVENT", other]));
  // The relay processes frames in order. EOSE on a new, non-matching
  // subscription is a barrier after CLOSE and publication, including outgoing
  // delivery frames, so the negative assertion does not depend on a sleep.
  socket.send(JSON.stringify(["REQ", "barrier", { kinds: [24171], "#x": [demo.publisher.swarmId] }]));
  await received((frame) => frame[0] === "EOSE" && frame[1] === "barrier", "the CLOSE/publication barrier");
  assert.ok(!frames.some((frame) => frame[0] === "EVENT" && frame[2].id === other.id));
  const closed = new Promise((resolve) => socket.once("close", resolve)); demo.relay.pause(); await closed;
  demo.relay.resume(); const restarted = await connect(); restarted.terminate();
});

const operatorToken = "operator-test-token-with-at-least-32-characters";
test("operator routes authenticate, reject cross-site and strict invalid inputs, and serialise policy without secrets", async (t) => {
  const demo = await start(t, { operatorToken, operatorExtraStatus: () => ({ workers: { hls: "running" } }) });
  const headers = { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" };
  assert.equal((await fetch(`${demo.base}/operator/status`)).status, 401);
  assert.equal((await fetch(`${demo.base}/operator/status`, { headers: { authorization: "Bearer incorrect" } })).status, 401);
  assert.equal((await fetch(`${demo.base}/operator/status`, { headers: { ...headers, origin: "https://other.example" } })).status, 403);
  assert.equal((await fetch(`${demo.base}/operator/status`, { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await fetch(`${demo.base}/operator/policy`, { headers })).status, 405);
  for (const body of ['null', '{"mode":"bad"}', '{"mode":"off","upload":true}', '{']) {
    assert.equal((await fetch(`${demo.base}/operator/policy`, { method: "POST", headers, body })).status, 400);
  }
  assert.equal((await fetch(`${demo.base}/operator/policy`, { method: "POST", headers, body: " ".repeat(2049) })).status, 413);
  assert.equal((await fetch(`${demo.base}/operator/policy`, { method: "POST", headers: { authorization: headers.authorization }, body: '{}' })).status, 415);
  const changed = await fetch(`${demo.base}/operator/policy`, { method: "POST", headers, body: JSON.stringify({ mode: "off" }) }).then((r) => r.json());
  assert.equal(changed.mode, "off"); assert.equal(changed.revision, 1);
  const policy = await fetch(`${demo.base}/delivery-policy.json`).then((r) => r.json());
  assert.deepEqual(policy, changed);
  await fetch(`${demo.base}/media/shared.ts`).then((r) => r.text());
  await fetch(`${demo.base}/commitment?path=/media/shared.ts&level=0&sequence=0&cc=0&start=0&end=4`).then((r) => r.text());
  const status = await fetch(`${demo.base}/operator/status`, { headers }).then((r) => r.json());
  assert.deepEqual(status.broadcast, { workers: { hls: "running" } });
  assert.equal(policy.broadcast, undefined);
  assert.equal(status.origin.mediaRequests, 1); assert.equal(status.origin.mediaResponseBytes, 8);
  assert.equal(status.origin.commitmentRequests, 1); assert.ok(status.origin.commitmentResponseBytes > 0);
  assert.ok(!JSON.stringify(status).includes(operatorToken));
  assert.ok(!await fetch(`${demo.base}/session.json`).then((r) => r.text()).then((s) => s.includes(operatorToken)));
});

test("operator and reporting are disabled by default", async (t) => {
  const demo = await start(t);
  assert.equal((await fetch(`${demo.base}/operator/status`)).status, 503);
  assert.equal((await fetch(`${demo.base}/reports`, { method: "POST" })).status, 403);
  assert.equal((await fetch(`${demo.base}/delivery-policy.json`).then((r) => r.json())).telemetry, false);
});

test("opted-in reports allow bounded numeric measurements only", async (t) => {
  const demo = await start(t, { operatorToken, telemetry: true, reportCapacity: 2 });
  const input = { durationMs: 10, peerBytes: 4, uploadedBytes: 5, originMediaRequests: 1, originMediaBytes: 8, stalls: 0, stallMs: 0, fatalErrors: 0 };
  const post = (value, origin = demo.base) => fetch(`${demo.base}/reports`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(value) });
  assert.equal((await post(input, "https://other.example")).status, 403);
  assert.equal((await fetch(`${demo.base}/reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await post({ ...input, identity: "private" })).status, 400);
  assert.equal((await post({ ...input, peerBytes: -1 })).status, 400);
  assert.equal((await post({ ...input, peerBytes: 1e13 })).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await post(input)).status, 200);
  const status = await fetch(`${demo.base}/operator/status`, { headers: { authorization: `Bearer ${operatorToken}` } }).then((r) => r.json());
  assert.equal(status.reports.samples, 2); assert.equal(status.reports.totals.uploadedBytes, 10);
  assert.ok(!JSON.stringify(status.reports).includes("identity"));
});


test("aborting during media path lookup releases every request slot before streaming", { timeout: 15000 }, async (t) => {
  const demo = await start(t);
  const media = demo.publisher.media.bind(demo.publisher);
  let entered, release;
  demo.publisher.media = async (path) => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return media(path);
  };
  for (let i = 0; i < 40; i++) {
    const waiting = new Promise((resolve) => { entered = resolve; });
    const request = httpGet(`${demo.base}/media/shared.ts`, (response) => {
      response.resume();
      assert.notEqual(response.statusCode, 503, "Cancelled requests must not exhaust the media concurrency budget");
    });
    request.on("error", () => {});
    await waiting;
    const closed = new Promise((resolve) => request.once("close", resolve));
    request.destroy(); await closed;
    // Let the server observe socket closure while its lookup is still pending.
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  demo.publisher.media = media;
  const response = await fetch(`${demo.base}/media/shared.ts`);
  assert.equal(response.status, 200); assert.equal(await response.text(), "abcdefgh");
  for (let i = 0; i < 40; i++) {
    const response = await fetch(`${demo.base}/media/shared.ts`, { method: "HEAD" });
    assert.equal(response.status, 200);
  }
});

test("aborting an active media stream closes its file and releases its request slot", { timeout: 15000 }, async (t) => {
  const demo = await start(t);
  const path = await demo.publisher.media("/media/shared.ts");
  await writeFile(path, Buffer.alloc(8 * 1024 * 1024));
  for (let i = 0; i < 40; i++) {
    await new Promise((done, reject) => {
      const request = httpGet(`${demo.base}/media/shared.ts`, (response) => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error("Cancelled streams exhausted the request budget")); return; }
        response.once("data", () => { response.destroy(); request.destroy(); });
      });
      request.once("close", done); request.once("error", (error) => { if (error.code !== "ECONNRESET") reject(error); });
    });
  }
  const response = await fetch(`${demo.base}/media/shared.ts`, { headers: { range: "bytes=0-3" } });
  assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 4);
});


test("prepared player calls beforeListen once and replaces a still-live waiting listener", async (t) => {
  const waiting = await startBroadcastWaitingServer({ port: 0 });
  t.after(() => waiting.close());
  let calls = 0;
  const demo = await start(t, { port: waiting.port, beforeListen: async () => {
    calls++;
    assert.match(await fetch(waiting.base).then((response) => response.text()), /Waiting for the broadcast/u);
    await waiting.close();
  } });
  assert.equal(calls, 1); assert.equal(demo.base, waiting.base);
  assert.match(await fetch(demo.base).then((response) => response.text()), /id="settings"/u);
});

test("beforeListen validation and rejected preparation preserve the waiting listener", async (t) => {
  await assert.rejects(startDemoServer({ beforeListen: true }), /beforeListen must be a function/u);
  const waiting = await startBroadcastWaitingServer({ port: 0 });
  t.after(() => waiting.close());
  await assert.rejects(start(t, { port: waiting.port, beforeListen: async () => { throw new Error("Host declined handoff"); } }), /Host declined handoff/u);
  const response = await fetch(waiting.base);
  assert.equal(response.status, 200); assert.match(await response.text(), /Waiting for the broadcast/u);
});
