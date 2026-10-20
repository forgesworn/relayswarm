import { Agent, get as httpGet, request as httpRequest } from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, realpath, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { PublisherError } from "../src/hls-publisher.mjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { resolveTrustedStream } from "../src/browser/stream-discovery.mjs";
import { startDemoServer } from "../demo/server.mjs";
import { startBroadcastWaitingServer } from "../demo/broadcast-waiting.mjs";
import { appServerTiming } from "../demo/fetch-diagnostics.mjs";
import { startObservedFmp4Demo } from "./support/fmp4-observed-demo.mjs";
import { startObservedDemo } from "./support/broadcast-observed-demo.mjs";

async function start(t, options = {}, startServer = startDemoServer) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-demo-test-"));
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:4@0\nshared.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:4\nshared.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "shared.ts"), "abcdefgh");
  await writeFile(join(directory, "private.key"), "do not serve");
  let demo;
  try { demo = await startServer({ mediaDir: directory, manifest: "index.m3u8", iceServers: [], ...options }); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  t.after(async () => { await demo.close(); await rm(directory, { recursive: true, force: true }); });
  return demo;
}

test("demo serves exact HTTP ranges and matching signed commitments without exposing keys", async (t) => {
  const demo = await start(t);
  const session = await fetch(`${demo.base}/session.json`).then((response) => response.json());
  assert.equal(session.swarmId, demo.publisher.swarmId);
  assert.equal(session.iceTransportPolicy, "all");
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

test("demo publishes an explicit relay policy and rejects invalid policies before private reads", async (t) => {
  for (const iceTransportPolicy of [null, "", "Relay", "none", true]) {
    await assert.rejects(startDemoServer({ iceTransportPolicy, operatorTokenFile: "/must-not-read-token" }), /Invalid ICE transport policy/u);
  }
  const demo = await start(t, { iceTransportPolicy: "relay" });
  const session = await fetch(`${demo.base}/session.json`).then((response) => response.json());
  assert.equal(session.iceTransportPolicy, "relay");
  assert.deepEqual(session.iceServers, []); // Policy does not invent TURN service or downgrade to all.
  assert.equal(await fetch(`${demo.base}/media/shared.ts`).then((response) => response.text()), "abcdefgh");
});

test("inline policy snapshots validate the compatibility option before private reads", async () => {
  for (const policySessionSnapshot of [null, 0, 1, "true", {}]) {
    await assert.rejects(startDemoServer({ policySessionSnapshot, operatorTokenFile: "/must-not-read-token" }), /Invalid policy session snapshot option/u);
  }
});

test("inline policy snapshots expose only the shared public session on the exact opt-in query", async t => {
  const demo = await start(t, { operatorToken }), agent = new Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  const wire = (path, options) => bufferedRoundtrip(demo.base, agent, path, options);
  const sessionReply = await wire("/session.json"), session = JSON.parse(sessionReply.body.toString("utf8"));
  assert.equal(session.deliveryPolicyEndpoint, "/delivery-policy.json?session=1"); assert.equal(session.deliveryPolicySession, "inline-v1");
  const bare = JSON.parse((await wire("/delivery-policy.json")).body.toString("utf8"));
  assert.deepEqual(bare, { v: 1, mode: null, revision: 0, telemetry: false });
  const reply = await wire(session.deliveryPolicyEndpoint), combined = JSON.parse(reply.body.toString("utf8"));
  assert.equal(reply.reusedSocket, true); assert.equal(reply.headers["cache-control"], "no-store");
  assert.deepEqual(combined, { ...bare, session }); exactBufferedReply(reply, 200, Buffer.from(JSON.stringify(combined)));
  assert.ok(!reply.body.includes(Buffer.from(operatorToken))); assert.ok(!reply.body.includes(Buffer.from("do not serve")));
  for (const query of ["?session=0", "?session=1&extra=1", "?session=1&session=1", "?session=%31"]) {
    assert.deepEqual(JSON.parse((await wire(`/delivery-policy.json${query}`)).body.toString("utf8")), bare);
  }
  for (const method of ["HEAD", "POST"]) assert.equal((await wire(session.deliveryPolicyEndpoint, { method })).status, 405);
  // A legacy client follows the advertised endpoint but ignores the extra
  // public field and still makes its separate session read.
  const { session: ignored, ...oldClientPolicy } = combined;
  assert.deepEqual(oldClientPolicy, bare); assert.deepEqual(JSON.parse((await wire("/session.json")).body.toString("utf8")), ignored);
  const headers = { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" };
  const changedReply = await fetch(`${demo.base}/operator/policy`, { method: "POST", headers, body: JSON.stringify({ mode: "off" }) });
  assert.equal(changedReply.ok, true); const changed = await changedReply.json();
  assert.deepEqual(changed, { v: 1, mode: "off", revision: 1, telemetry: false });
  const rotatedReply = await fetch(`${demo.base}/operator/admission`, { method: "POST", headers, body: JSON.stringify({ rotate: true }) });
  assert.equal(rotatedReply.ok, true); const rotated = await rotatedReply.json();
  const current = await fetch(`${demo.base}${session.deliveryPolicyEndpoint}`).then(r => r.json());
  assert.deepEqual({ v: current.v, mode: current.mode, revision: current.revision, telemetry: current.telemetry }, changed);
  assert.equal(current.session.admission.epoch, rotated.epoch); assert.notEqual(current.session.admission.epoch, session.admission.epoch);
});

test("inline policy snapshots can be disabled without changing the legacy public contract", async t => {
  const demo = await start(t, { policySessionSnapshot: false });
  const session = await fetch(`${demo.base}/session.json`).then(r => r.json());
  assert.equal(session.deliveryPolicyEndpoint, "/delivery-policy.json"); assert.equal(Object.hasOwn(session, "deliveryPolicySession"), false);
  for (const path of ["/delivery-policy.json", "/delivery-policy.json?session=1"]) {
    assert.deepEqual(await fetch(`${demo.base}${path}`).then(r => r.json()), { v: 1, mode: null, revision: 0, telemetry: false });
  }
});

test("control timings expose numeric headers and authenticated bounded aggregates without request details", async (t) => {
  const token = "b".repeat(64), marker = "private-query-marker";
  const demo = await start(t, { operatorToken: token });
  const response = await fetch(`${demo.base}/session.json?credential=${marker}`);
  const appMs = appServerTiming(response.headers.get("server-timing"));
  assert.ok(Number.isFinite(appMs) && appMs >= 0);
  assert.equal((await response.json()).requestDiagnostics, undefined);
  assert.equal((await fetch(`${demo.base}/operator/status`)).status, 401);
  const status = await fetch(`${demo.base}/operator/status`, { headers: { authorization: `Bearer ${token}` } }).then((value) => value.json());
  const diagnostic = status.requestDiagnostics;
  assert.equal(diagnostic.current.routes.session.started, 1);
  assert.equal(diagnostic.current.routes.session.finished, 1);
  assert.equal(diagnostic.maxActive, 128);
  assert.equal(diagnostic.retainWindows, 120);
  assert.ok(!JSON.stringify(diagnostic).includes(marker));
  assert.ok(!JSON.stringify(diagnostic).includes(token));
  assert.equal((await fetch(`${demo.base}/media/shared.ts`)).headers.get("server-timing"), null);
});

test("failed TLS startup releases owned timers and the private operational lease", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-startup-cleanup-")));
  await chmod(directory, 0o700);
  const handles = [], cleared = new Set(), originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  t.after(async () => { for (const handle of handles) originalClear(handle); await rm(directory, { recursive: true, force: true }); });
  t.mock.method(globalThis, "setInterval", (...args) => { const handle = originalSet(...args); handles.push(handle); return handle; });
  t.mock.method(globalThis, "clearInterval", (handle) => { cleared.add(handle); return originalClear(handle); });
  const state = join(directory, "operator.json"), key = join(directory, "bad-key"), cert = join(directory, "bad-cert");
  await writeFile(key, "not a private key", { mode: 0o600 });
  await writeFile(cert, "not a certificate", { mode: 0o600 });
  const operationalState = process.platform === "win32" ? {} : { operatorState: state };
  await assert.rejects(start(t, { operatorToken: "c".repeat(64), ...operationalState, tlsKey: key, tlsCert: cert }));
  assert.ok(handles.every((handle) => cleared.has(handle)), "Every failed-startup sampler must be cleared.");
  const demo = await start(t, { operatorToken: "c".repeat(64), ...operationalState });
  assert.equal((await fetch(`${demo.base}/delivery-policy.json`)).status, 200);
  await demo.close();
  assert.ok(handles.every((handle) => cleared.has(handle)), "Successful shutdown must also clear owned timers.");
});

test("bounded demo relay delivers signed swarm events, honours CLOSE and recovers after an outage", async (t) => {
  const demo = await start(t);
  const secretKey = generateSecretKey();
  const post = (path, value) => fetch(`${demo.base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: demo.base }, body: JSON.stringify(value) }).then((response) => response.json());
  const challenge = await post("/admission/challenge", { pubkey: getPublicKey(secretKey) });
  const proof = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ challenge: challenge.challenge, swarmId: demo.publisher.swarmId, epoch: challenge.epoch }) }, secretKey);
  const credential = await post("/admission/ticket", { proof });
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
  const event = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", demo.publisher.swarmId]], content: JSON.stringify({ ticket: credential.ticket }) }, secretKey);
  socket.send(JSON.stringify(["EVENT", event]));
  await received((frame) => frame[0] === "EVENT" && frame[2].id === event.id, "the subscribed signed event");
  socket.send(JSON.stringify(["CLOSE", "s"]));
  const other = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", demo.publisher.swarmId]], content: JSON.stringify({ ticket: credential.ticket, update: true }) }, secretKey);
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

test("live advertisement links stable authorisation and is discoverable on the bounded relay", async (t) => {
  const demo = await start(t), session = await fetch(`${demo.base}/session.json`).then((response) => response.json());
  const event = await fetch(`${demo.base}${session.streamAdvertisementEndpoint}`).then((response) => response.json());
  const result = resolveTrustedStream(event, { trustedAuthors: [session.streamEvent.pubkey], allowedMediaOrigins: [demo.base],
    swarmId: session.swarmId, relays: session.relays, streamAuthorisations: [session.streamEvent], allowLoopback: true });
  assert.equal(result.streamEvent.id, session.streamEvent.id); assert.equal(result.liveEvent.id, event.id);
  assert.equal(result.manifestUrl, new URL(session.manifest, demo.base).href);
  const socket = new WebSocket(session.relays[0], { origin: demo.base }), frames = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw)));
  await new Promise((resolve) => socket.once("open", resolve)); t.after(() => socket.terminate());
  socket.send(JSON.stringify(["REQ", "live", { kinds: [30311], authors: [session.streamEvent.pubkey] }]));
  const deadline = Date.now() + 3000;
  while (!frames.some((frame) => frame[0] === "EOSE")) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.ok(frames.some((frame) => frame[0] === "EVENT" && frame[2].id === event.id));
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
  const values = { durationMs: 10, peerBytes: 4, uploadedBytes: 5, originMediaRequests: 1, originMediaBytes: 8, stalls: 0, stallMs: 0, fatalErrors: 0 };
  const input = { v: 1, reportId: "a".repeat(32), sequence: 1, values };
  const post = (value, origin = demo.base) => fetch(`${demo.base}/reports`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(value) });
  assert.equal((await post(input, "https://other.example")).status, 403);
  assert.equal((await fetch(`${demo.base}/reports`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status, 403);
  assert.equal((await post({ ...input, identity: "private" })).status, 400);
  assert.equal((await post({ ...input, values: { ...values, peerBytes: -1 } })).status, 400);
  assert.equal((await post({ ...input, values: { ...values, peerBytes: 1e13 } })).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await post(input)).status, 200);
  assert.equal((await post({ ...input, sequence: 2, values: { ...values, uploadedBytes: 7 } })).status, 200);
  assert.equal((await post({ ...input, reportId: "b".repeat(32) })).status, 200);
  assert.equal((await post({ ...input, reportId: "c".repeat(32) })).status, 429);
  const status = await fetch(`${demo.base}/operator/status`, { headers: { authorization: `Bearer ${operatorToken}` } }).then((r) => r.json());
  assert.equal(status.reports.samples, 2); assert.equal(status.reports.totals.uploadedBytes, 12);
  assert.ok(!JSON.stringify(status.reports).includes(input.reportId));
});


test("aborting during media path lookup releases every request slot before streaming", { timeout: 15000 }, async (t) => {
  const demo = await start(t);
  const media = demo.publisher.media.bind(demo.publisher);
  let entered, rejectEntered, release;
  demo.publisher.media = async (path) => {
    entered();
    await new Promise((resolve) => { release = resolve; });
    return media(path);
  };
  for (let i = 0; i < 40; i++) {
    const waiting = new Promise((resolve, reject) => { entered = resolve; rejectEntered = reject; });
    let cancelling = false;
    // Each case deliberately aborts its connection. A pooled socket racing
    // the preceding abort can reset before the server's lookup is reached.
    const request = httpGet(`${demo.base}/media/shared.ts`, { agent: false }, (response) => {
      response.resume();
      assert.notEqual(response.statusCode, 503, "Cancelled requests must not exhaust the media concurrency budget");
    });
    request.on("error", (error) => { if (!cancelling) rejectEntered(error); });
    await waiting;
    const closed = new Promise((resolve) => request.once("close", resolve));
    cancelling = true; request.destroy(); await closed;
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


function bufferedRoundtrip(base, agent, path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, base), { method, agent, headers }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => { size += chunk.length; if (size > 2 * 1024 * 1024) request.destroy(new Error("Fixture response exceeded bound.")); else chunks.push(chunk); });
      response.on("error", reject);
      response.on("aborted", () => reject(new Error("Fixture response aborted.")));
      response.on("end", () => resolve({ status: response.statusCode, version: response.httpVersion, complete: response.complete, headers: response.headers, body: Buffer.concat(chunks), reusedSocket: request.reusedSocket }));
    });
    request.setTimeout(3000, () => request.destroy(new Error("Fixture response timed out.")));
    request.on("error", reject); request.end(body);
  });
}
function exactBufferedReply(reply, status, expected, { head = false } = {}) {
  assert.equal(reply.status, status); assert.equal(reply.version, "1.1"); assert.equal(reply.complete, true);
  assert.equal(reply.headers["content-length"], String(expected.length));
  assert.equal(reply.headers["transfer-encoding"], undefined);
  assert.deepEqual(reply.body, head ? Buffer.alloc(0) : expected);
}

test("buffered demo responses preserve exact UTF-8, Buffer and Uint8Array bytes over HTTP/1.1", { timeout: 15000 }, async (t) => {
  const marker = "viewer-£-🎥", iceServers = [{ urls: "turn:fixture.invalid:3478?transport=tcp", username: marker, credential: "fixture-only" }];
  const demo = await start(t, { iceServers }), agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const wire = (path, options) => bufferedRoundtrip(demo.base, agent, path, options);
  const session = await wire("/session.json"), value = JSON.parse(session.body.toString("utf8"));
  assert.deepEqual(value.iceServers, iceServers);
  assert.ok(session.body.length > session.body.toString("utf8").length, "UTF-8 byte length differs from character count");
  const sessionBytes = Buffer.from(JSON.stringify(value), "utf8"); exactBufferedReply(session, 200, sessionBytes);
  const repeated = await wire("/session.json"); assert.equal(repeated.reusedSocket, true); exactBufferedReply(repeated, 200, sessionBytes);
  const built = await build({ entryPoints: [fileURLToPath(new URL("../demo/client.mjs", import.meta.url))], bundle: true, format: "esm", platform: "browser", write: false, minify: true, logLevel: "silent" });
  assert.ok(built.outputFiles[0].contents instanceof Uint8Array);
  for (const [path, bytes] of [["/", await readFile(new URL("../demo/index.html", import.meta.url))], ["/style.css", await readFile(new URL("../demo/style.css", import.meta.url))], ["/client.js", Buffer.from(built.outputFiles[0].contents)]]) {
    exactBufferedReply(await wire(path), 200, bytes);
    exactBufferedReply(await wire(path, { method: "HEAD" }), 200, bytes, { head: true });
  }
  const media = demo.publisher.media, message = "Fixture unavailable: £-🎥", errorBytes = Buffer.from(JSON.stringify({ error: message }), "utf8");
  demo.publisher.media = async () => { throw new PublisherError(message, 409); };
  try {
    exactBufferedReply(await wire("/media/shared.ts"), 409, errorBytes);
    exactBufferedReply(await wire("/media/shared.ts", { method: "HEAD" }), 409, errorBytes, { head: true });
  } finally { demo.publisher.media = media; }
  exactBufferedReply(await wire("/session.json"), 200, sessionBytes);
});

test("buffered operator policy, UTF-8 status and JSON errors retain exact HTTP/1.1 framing", { timeout: 15000 }, async (t) => {
  const marker = "operator-£-🎥", demo = await start(t, { operatorToken, operatorExtraStatus: () => ({ label: marker }) });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  const wire = (path, options) => bufferedRoundtrip(demo.base, agent, path, options), bytes = (value) => Buffer.from(JSON.stringify(value), "utf8");
  exactBufferedReply(await wire("/delivery-policy.json"), 200, bytes({ v: 1, mode: null, revision: 0, telemetry: false }));
  const status = await wire("/operator/status", { headers: { authorization: `Bearer ${operatorToken}` } });
  assert.equal(status.reusedSocket, true); const value = JSON.parse(status.body.toString("utf8")); assert.deepEqual(value.broadcast, { label: marker });
  assert.ok(status.body.length > status.body.toString("utf8").length); exactBufferedReply(status, 200, bytes(value));
  exactBufferedReply(await wire("/operator/status"), 401, bytes({ error: "Unauthorised." }));
  const update = async (mode) => {
    const body = bytes({ mode });
    return wire("/operator/policy", { method: "POST", headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json", "content-length": body.length }, body });
  };
  exactBufferedReply(await update("invalid"), 400, bytes({ error: "Supply only mode: null, off, shadow or peer-first." }));
  const changed = bytes({ v: 1, mode: "off", revision: 1, telemetry: false });
  exactBufferedReply(await update("off"), 200, changed); exactBufferedReply(await wire("/delivery-policy.json"), 200, changed);
});

test("observed bundles retain their own exact HTTP lengths and production headers", { timeout: 15000 }, async (t) => {
  for (const [name, factory, lengthField, hashField] of [
    ["fmp4", startObservedFmp4Demo, "bytes", "observedClientSHA256"],
    ["broadcast", startObservedDemo, "observedBytes", "observedSHA256"],
  ]) await t.test(name, async (t) => {
    const demo = await start(t, {}, factory), agent = new Agent({ keepAlive: true, maxSockets: 1 });
    t.after(() => agent.destroy());
    const reply = await bufferedRoundtrip(demo.base, agent, "/client.js");
    assert.equal(reply.status, 200); assert.equal(reply.complete, true);
    assert.equal(reply.headers["content-length"], String(demo.observation[lengthField]));
    assert.equal(reply.body.length, demo.observation[lengthField]);
    assert.equal(createHash("sha256").update(reply.body).digest("hex"), demo.observation[hashField]);
    assert.equal(reply.headers["transfer-encoding"], undefined);
    assert.equal(reply.headers["content-type"], "text/javascript; charset=utf-8");
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
    assert.ok(reply.headers["content-security-policy"].includes("default-src 'self'"));
    const head = await bufferedRoundtrip(demo.base, agent, "/client.js", { method: "HEAD" });
    assert.equal(head.reusedSocket, true); exactBufferedReply(head, 200, reply.body, { head: true });
  });
});
