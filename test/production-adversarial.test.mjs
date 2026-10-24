import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { startDemoServer } from "../demo/server.mjs";
import { fetchNativeObject } from "../src/native-client.mjs";
import { sha256Hex } from "../src/object-transfer.mjs";
import { startLocalDht } from "./support/local-dht.mjs";

// Actual HTTP, WebSocket and local DHT boundaries. These budgets bound keys
// and requests; open admission does not establish unique human identities.
async function mediaDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-adversarial-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "segment.ts"), Buffer.alloc(256 * 1024, 7));
  return directory;
}
async function demoFixture(t, options = {}) {
  const mediaDir = await mediaDirectory(t);
  const demo = await startDemoServer({ mediaDir, manifest: "index.m3u8", iceServers: [], ...options });
  t.after(() => demo.close());
  demo.mediaDir = mediaDir;
  return demo;
}
async function post(demo, path, input, extra = {}) {
  const response = await fetch(`${demo.base}${path}`, { method: "POST", headers: { origin: demo.base, "content-type": "application/json", ...extra }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
async function credential(demo, secret = generateSecretKey()) {
  const pubkey = getPublicKey(secret), challenge = await post(demo, "/admission/challenge", { pubkey });
  assert.equal(challenge.status, 200);
  const proof = finalizeEvent({ kind: 27235, tags: [], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ challenge: challenge.body.challenge, epoch: challenge.body.epoch, swarmId: demo.publisher.swarmId }) }, secret);
  const result = await post(demo, "/admission/ticket", { proof });
  assert.equal(result.status, 200);
  return { pubkey, secret, ticket: result.body.ticket };
}
async function socket(t, demo) {
  const ws = new WebSocket(`${demo.base.replace(/^http/u, "ws")}/relay`, { origin: demo.base }), frames = [];
  ws.on("error", () => {});
  ws.on("message", (raw) => frames.push(JSON.parse(raw)));
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, frames, send: (frame) => ws.send(JSON.stringify(frame)) };
}
async function until(predicate, message) {
  const end = Date.now() + 5000;
  while (!predicate()) { assert.ok(Date.now() < end, message); await new Promise((resolve) => setTimeout(resolve, 10)); }
}

test("malformed remote subscription filters cannot kill the publisher process", { timeout: 15000 }, async (t) => {
  const directory = await mediaDirectory(t);
  // A regression must report a failed child, rather than kill node:test with
  // an uncaught exception in the relay's WebSocket callback.
  const script = `
    import assert from 'node:assert/strict';
    import WebSocket from 'ws';
    import { startDemoServer } from './demo/server.mjs';
    const demo = await startDemoServer({mediaDir:process.argv[1],manifest:'index.m3u8'});
    const ws = new WebSocket(demo.base.replace(/^http/,'ws')+'/relay',{origin:demo.base});
    const frames=[]; ws.on('message',raw=>frames.push(JSON.parse(raw))); ws.on('error',()=>{});
    try {
      await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
      for(const extra of [{authors:{}},{authors:1},{authors:'a'},{kinds:{}},{since:{}},{until:[]},{ids:{}},{'#p':{}},{limit:1e99}])
        ws.send(JSON.stringify(['REQ','bad',{'#x':[demo.publisher.swarmId],...extra}]));
      ws.send(JSON.stringify(['REQ','healthy',{kinds:[30311],authors:[demo.publisher.streamEvent.pubkey]}]));
      const end=Date.now()+4000;
      while(!frames.some(f=>f[0]==='EOSE'&&f[1]==='healthy')){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10))}
      assert.ok(frames.some(f=>f[0]==='EVENT'&&f[1]==='healthy'));
      assert.equal((await fetch(demo.base+'/session.json')).status,200);
      console.log('malformed subscriptions isolated');
    } finally {ws.terminate();await demo.close()}
  `;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, directory], { cwd: new URL("..", import.meta.url), timeout: 12000 });
  assert.match(result.stdout, /malformed subscriptions isolated/u);
});

test("challenge and hostile presence floods preserve bounded admission and honest relay delivery", { timeout: 15000 }, async (t) => {
  const demo = await demoFixture(t, { admissionOptions: { capacity: 8, perAddressTickets: 2, globalTickets: 2, perAddressRequests: 96, requestCapacity: 128 } });
  const honest = await credential(demo), second = await credential(demo);
  const reader = await socket(t, demo), attacker = await socket(t, demo);
  reader.send(["REQ", "presence", { kinds: [24170], "#x": [demo.publisher.swarmId] }]);
  await until(() => reader.frames.some((f) => f[0] === "EOSE"), "honest subscription ready");
  const floods = await Promise.all(Array.from({ length: 24 }, (_, i) => post(demo, "/admission/challenge", { pubkey: honest.pubkey }, { "x-forwarded-for": `192.0.2.${i}` })));
  assert.equal(floods.filter((r) => r.status === 200).length, 8);
  assert.equal(floods.filter((r) => r.status === 429).length, 16);
  assert.equal(demo.admission.metrics().challenges, 8);
  assert.equal(demo.admission.metrics().tickets, 2);
  const extraChallenge = floods.find((result) => result.status === 200).body;
  const excessProof = finalizeEvent({ kind: 27235, tags: [], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ challenge: extraChallenge.challenge, epoch: extraChallenge.epoch, swarmId: demo.publisher.swarmId }) }, honest.secret);
  assert.equal((await post(demo, "/admission/ticket", { proof: excessProof }, { "x-forwarded-for": "198.51.100.99" })).status, 429, "another claimed forwarded address cannot bypass issuance quotas");
  const outsider = generateSecretKey(), unknown = finalizeEvent({ kind: 24170, tags: [["x", demo.publisher.swarmId]], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ ticket: honest.ticket }) }, outsider);
  attacker.send(["EVENT", unknown]);
  attacker.send(["EVENT", { ...unknown, tags: {} }]);
  attacker.send(["EVENT", { ...unknown, content: "null" }]);
  attacker.send(["REQ", "barrier", { kinds: [24171], "#x": [demo.publisher.swarmId] }]);
  await until(() => attacker.frames.some((f) => f[0] === "EOSE" && f[1] === "barrier"), "hostile frames processed");
  assert.ok(!reader.frames.some((f) => f[0] === "EVENT" && f[2].pubkey === getPublicKey(outsider)));
  const event = finalizeEvent({ kind: 24170, tags: [["x", demo.publisher.swarmId]], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ ticket: honest.ticket }) }, honest.secret);
  reader.send(["EVENT", event]);
  await until(() => reader.frames.some((f) => f[0] === "EVENT" && f[2].id === event.id), "authorised event after challenge flood");
  for (let i = 0; i < 90; i++) if (attacker.ws.readyState === WebSocket.OPEN) attacker.send(["CLOSE", "unused"]);
  await until(() => attacker.ws.readyState === WebSocket.CLOSED, "per-socket frame budget closes flooder");
  assert.equal(reader.ws.readyState, WebSocket.OPEN);
  const oversized = await socket(t, demo);
  const rejected = new Promise((resolve) => oversized.ws.once("close", resolve));
  oversized.ws.send("x".repeat(24 * 1024 + 1));
  assert.equal(await rejected, 1009, "oversized WebSocket frames are closed at the parser boundary");
  assert.equal((await post(demo, "/admission/verify", { pubkey: second.pubkey, ticket: second.ticket })).body.admitted, true);
  assert.equal((await fetch(`${demo.base}/media/segment.ts`)).status, 200);
});

test("cancelled slow admission bodies and commitment bursts do not retain slots or sign foreign context", { timeout: 15000 }, async (t) => {
  const demo = await demoFixture(t), endpoint = new URL(demo.base), slow = [];
  t.after(() => { for (const connection of slow) connection.destroy(); });
  for (let i = 0; i < 12; i++) {
    const connection = createConnection({ host: "127.0.0.1", port: Number(endpoint.port) }); slow.push(connection); connection.on("error", () => {});
    await new Promise((resolve) => connection.once("connect", resolve));
    connection.write(`POST /admission/challenge HTTP/1.1\r\nHost: ${endpoint.host}\r\nOrigin: ${demo.base}\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{`);
  }
  // Sixteen distinct contexts: identical requests would join one slot.
  await writeFile(join(demo.mediaDir, "index.m3u8"), `#EXTM3U\n#EXT-X-TARGETDURATION:2\n${Array.from({ length: 16 }, (_, i) => `#EXTINF:2,\n#EXT-X-BYTERANGE:16384@${i * 16384}\nsegment.ts\n`).join("")}#EXT-X-ENDLIST\n`);
  const context = (i) => new URLSearchParams({ path: "/media/segment.ts", level: "0", sequence: String(i % 16), cc: "0", start: String((i % 16) * 16384), end: String((i % 16 + 1) * 16384) });
  const results = await Promise.all(Array.from({ length: 32 }, (_, i) => fetch(`${demo.base}/commitment?${context(i)}`, { signal: AbortSignal.timeout(5000) }).then(async (r) => ({ i, status: r.status, body: await r.json() }))));
  assert.ok(results.some((r) => r.status === 200));
  assert.ok(results.every((r) => r.status === 200 || r.status === 503));
  for (const result of results.filter((r) => r.status === 200)) { assert.ok(verifyEvent(result.body)); assert.equal(result.body.pubkey, demo.publisher.streamEvent.pubkey); assert.equal(JSON.parse(result.body.content).sequence, result.i % 16); }
  assert.ok(results.some((r) => r.status === 503) && demo.publisher.getMetrics().busyRejected > 0, "the burst reaches the concurrency limit");
  assert.equal(demo.publisher.getMetrics().peakInFlight, 8);
  assert.equal(demo.publisher.getMetrics().inFlight, 0);
  const query = context(0);
  for (const connection of slow) connection.destroy();
  assert.equal(demo.admission.metrics().challenges, 0, "incomplete bodies never allocate a challenge");
  await credential(demo);
  query.set("sequence", "999"); assert.equal((await fetch(`${demo.base}/commitment?${query}`)).status, 404);
  const media = await fetch(`${demo.base}/media/segment.ts`, { headers: { range: "bytes=0-7" } });
  assert.equal(media.status, 206); assert.deepEqual(Buffer.from(await media.arrayBuffer()), Buffer.alloc(8, 7));
});

test("admitted multi-socket presence churn cannot evict the publisher discovery records", { timeout: 15000 }, async (t) => {
  const demo = await demoFixture(t), admitted = await credential(demo), writers = [];
  const advertisementId = demo.advertisement().id;
  for (let i = 0; i < 7; i++) writers.push(await socket(t, demo));
  // 525 events exceed the total history cap while remaining within the
  // per-socket and global ingress caps. One ticket still means one key.
  for (const [index, writer] of writers.entries()) {
    for (let item = 0; item < 75; item++) {
      const event = finalizeEvent({ kind: 24170, tags: [["x", demo.publisher.swarmId]], created_at: Math.floor(Date.now() / 1000), content: JSON.stringify({ ticket: admitted.ticket, update: index * 75 + item }) }, admitted.secret);
      writer.send(["EVENT", event]);
    }
    writer.send(["REQ", "processed", { kinds: [24171], "#x": [demo.publisher.swarmId] }]);
  }
  await Promise.all(writers.map((writer) => until(() => writer.frames.some((f) => f[0] === "EOSE" && f[1] === "processed"), "presence churn processed within ingress budgets")));
  const discovery = await socket(t, demo);
  discovery.send(["REQ", "publisher", { kinds: [30311], authors: [demo.publisher.streamEvent.pubkey] }]);
  await until(() => discovery.frames.some((f) => f[0] === "EOSE"), "discovery subscription completes after history churn");
  const ids = discovery.frames.filter((f) => f[0] === "EVENT").map((f) => f[2].id);
  assert.ok(ids.includes(demo.publisher.streamEvent.id), "stable authorisation remains discoverable");
  assert.ok(ids.includes(advertisementId), "latest live advertisement remains discoverable");
  assert.equal((await fetch(`${demo.base}/session.json`)).status, 200);
});

test("a withholding real relay and slow HTTP body cannot defeat native cancellation or the total deadline", { timeout: 15000 }, async (t) => {
  const dht = await startLocalDht(), bytes = Buffer.from("verified fallback object"), sockets = new Set();
  let requests = 0, closedBodies = 0;
  const server = createServer((request, response) => {
    requests++;
    if (request.url === "/healthy") { response.end(bytes); return; }
    response.writeHead(200, { "content-length": bytes.length }); response.write(bytes.subarray(0, 1));
    response.once("close", () => closedBodies++);
  });
  const relay = new WebSocketServer({ server, maxPayload: 1024 });
  relay.on("connection", (ws) => { sockets.add(ws); ws.on("error", () => {}); ws.on("close", () => sockets.delete(ws)); /* Deliberately withhold every reply. */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { for (const ws of sockets) ws.terminate(); server.closeAllConnections(); await Promise.all([new Promise((resolve) => relay.close(resolve)), new Promise((resolve) => server.close(resolve)), dht.close()]); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const descriptor = { v: 1, swarmId: "withholding-relay-test", sha256: sha256Hex(bytes), size: bytes.length, trustedSeeders: ["a".repeat(64)], relayUrls: [base.replace(/^http/u, "ws")], originUrl: `${base}/slow` };
  const options = { allowLoopback: true, bootstrap: dht.bootstrap, peerTimeoutMs: 200, timeoutMs: 1500 };
  const cancelled = new AbortController();
  const early = fetchNativeObject(descriptor, { ...options, signal: cancelled.signal });
  cancelled.abort(new Error("owner cancelled before fallback"));
  await assert.rejects(early, /owner cancelled/u); assert.equal(requests, 0);
  const started = performance.now();
  await assert.rejects(fetchNativeObject(descriptor, options));
  assert.ok(performance.now() - started < 4000, "withholding and body stalls share a bounded total deadline");
  await until(() => closedBodies === 1 && sockets.size === 0, "cancelled transfer releases HTTP and relay sockets");
  const result = await fetchNativeObject({ ...descriptor, originUrl: `${base}/healthy` }, options);
  assert.deepEqual(result.bytes, bytes); assert.equal(result.receipt.sha256Verified, true); assert.equal(result.receipt.fallback, true);
});
