import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { commitmentContent, KIND_SEGMENT_COMMITMENT, verifySegmentCommitment } from "../src/browser/segment-commitment.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";
import { boundedOperation } from "../src/browser/bounded-operation.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("condition did not become true");
    await sleep(10);
  }
}
class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  send() {}
  close() { if (this.readyState === "closed") return; this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  receive(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
}
class PC extends EventTarget {
  static instances = [];
  iceGatheringState = "complete";
  localDescription = { sdp: "address-bearing-sdp" };
  constructor() { super(); PC.instances.push(this); }
  close() { this.closed = true; }
  createDataChannel() { return new Channel(); }
  async createOffer() { return { type: "offer", sdp: "address-bearing-sdp" }; }
  async createAnswer() { return { type: "answer", sdp: "address-bearing-sdp" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
}
class Loader {
  stats = {};
  load(context, _config, callbacks) { callbacks.onSuccess({ data: new Uint8Array(32).fill(9).buffer }, this.stats, context, null); }
  abort() {}
  destroy() {}
}
const context = { url: "https://origin.example/seg.ts", frag: { sn: 1, level: 0, cc: 0 } };
const base = { swarmId: "review-swarm-abcd", RTCPeerConnectionImpl: PC };

class RecordedChannel extends Channel {
  sent = [];
  send(data) { this.sent.push(typeof data === "string" ? JSON.parse(data) : data.slice()); }
}

// Exercise the real relay/session admission and PeerLink paths, with only the
// browser connection replaced. No private swarm state is exposed to tests.
async function linkedFixture(options = {}, LoaderImpl = Loader) {
  const relay = await startLocalRelay();
  const connections = [], peers = [];
  class Connection extends PC { constructor() { super(); connections.push(this); } }
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], RTCPeerConnectionImpl: Connection, shadowSampleRate: 0, ...options });
  const hls = { config: { loader: LoaderImpl } };
  swarm.attach(hls);
  const pool = new RelayPool([relay.url]); await pool.connect();
  await until(() => swarm.metrics().pubkey);
  const addPeer = async (channel = new RecordedChannel()) => {
    const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId }); peer.start(); peers.push(peer);
    const count = connections.length, accepted = swarm.metrics().peers.offersAccepted;
    peer.sendSignal(swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: `fixture-${count}`, payload: { sdp: "fixture-offer", ...(options.admit ? { ticket: "fixture-ticket" } : {}) } });
    await until(() => connections.length > count && swarm.metrics().peers.offersAccepted > accepted);
    const event = new Event("datachannel"); event.channel = channel; connections[count].dispatchEvent(event);
    await until(() => swarm.metrics().peers.connected === peers.length);
    return channel;
  };
  const load = () => new Promise((resolve) => new hls.config.fLoader({}).load(context, {}, { onSuccess: resolve }));
  const close = async () => { swarm.stop(); for (const peer of peers) peer.close(); pool.close(); await relay.close(); };
  return { swarm, hls, addPeer, load, close, peers, pool };
}

test("concurrent accepted uploads reserve the full session allowance and withdraw availability", async () => {
  const fixture = await linkedFixture({ serve: true, maxUploadBytesPerSession: 64 });
  try {
    const first = await fixture.addPeer(), second = await fixture.addPeer();
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = first.sent.find((frame) => frame.t === "have" && frame.add?.length)?.add[0]; assert.ok(key);
    first.bufferedAmount = 2_000_000;
    first.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    second.receive(JSON.stringify({ t: "want", id: 2, k: key }));
    await until(() => fixture.swarm.metrics().bytes.uploaded === 64);
    const metrics = fixture.swarm.metrics();
    assert.equal(metrics.bytes.uploadRemaining, 0); assert.equal(metrics.bytes.uploadExhausted, true);
    assert.equal(metrics.bytes.uploadsServed, 2); assert.equal(metrics.serving, false); assert.equal(metrics.bytes.held, 0);
    for (const channel of [first, second]) assert.deepEqual(channel.sent.filter((frame) => frame.t === "have").at(-1).keys, [], "exhaustion replaces the previously advertised held set");
    first.close(); // Interrupted transfer does not return its reservation.
    second.receive(JSON.stringify({ t: "want", id: 3, k: key }));
    await until(() => second.sent.some((frame) => frame.t === "none" && frame.id === 3));
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 64);
    const delivered = await fixture.load(); assert.equal(delivered.data.byteLength, 32, "origin playback continues after exhaustion");
    await sleep(20); assert.equal(fixture.swarm.metrics().bytes.held, 0);
  } finally { await fixture.close(); }
});

test("an oversized next payload is refused and an interrupted reservation is never refunded", async () => {
  const fixture = await linkedFixture({ serve: true, maxUploadBytesPerSession: 48 });
  try {
    const first = await fixture.addPeer(), second = await fixture.addPeer();
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = first.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    first.bufferedAmount = 2_000_000;
    first.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => fixture.swarm.metrics().bytes.uploaded === 32);
    first.close();
    second.receive(JSON.stringify({ t: "want", id: 2, k: key }));
    await until(() => second.sent.some((frame) => frame.t === "none" && frame.id === 2));
    assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, 16);
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 32);
    assert.equal(fixture.swarm.metrics().bytes.uploadsRefused, 1);
    assert.equal(fixture.swarm.metrics().serving, true);
  } finally { await fixture.close(); }
});

test("omitting the session allowance keeps contribution unlimited", async () => {
  const fixture = await linkedFixture({ serve: true });
  try {
    const channel = await fixture.addPeer();
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = channel.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    for (let id = 1; id <= 4; id++) {
      channel.receive(JSON.stringify({ t: "want", id, k: key }));
      await until(() => channel.sent.some((frame) => frame.t === "eof" && frame.id === id));
    }
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 128);
    assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, null);
    assert.equal(fixture.swarm.metrics().bytes.uploadExhausted, false);
    assert.equal(fixture.swarm.metrics().serving, true);
  } finally { await fixture.close(); }
});

test("receive-only and zero-allowance viewers receive normally and never advertise or upload", async () => {
  for (const options of [{ serve: false, maxUploadBytesPerSession: 64 }, { serve: true, maxUploadBytesPerSession: 0 }]) {
    const fixture = await linkedFixture(options);
    try {
      const channel = await fixture.addPeer(); const response = await fixture.load();
      assert.equal(response.data.byteLength, 32);
      await sleep(20);
      channel.receive(JSON.stringify({ t: "want", id: 1, k: "a".repeat(64) }));
      await until(() => channel.sent.some((frame) => frame.t === "none"));
      assert.equal(fixture.swarm.metrics().bytes.held, 0); assert.equal(fixture.swarm.metrics().bytes.uploaded, 0);
      assert.equal(channel.sent.some((frame) => frame.t === "have" && (frame.keys?.length || frame.add?.length)), false);
    } finally { await fixture.close(); }
  }
});

test("upload floods close the link without growing its queue", async () => {
  const channel = new Channel(); channel.bufferedAmount = 2_000_000;
  const link = new PeerLink({ pubkey: "peer", pc: new PC(), channel, maxSegmentBytes: 1024, onRequest: () => new Uint8Array(32) });
  for (let id = 0; id < 1_000; id++) channel.receive(JSON.stringify({ t: "want", id, k: "a".repeat(64) }));
  assert.equal(link.closed, true);
  assert.ok(link.outboundInFlight <= 4);
  await sleep(0);
  assert.equal(link.outboundInFlight, 0);
});

test("empty chunks, tiny chunk floods and repeated metadata cannot retain unlimited buffers", async () => {
  for (const attack of ["empty", "tiny", "meta"]) {
    const channel = new Channel();
    const link = new PeerLink({ pubkey: "peer", pc: new PC(), channel, maxSegmentBytes: 1024 });
    const response = link.request("a".repeat(64), 1000);
    channel.receive(JSON.stringify({ t: "meta", id: 1, size: 100 }));
    if (attack === "empty") channel.receive(new ArrayBuffer(0));
    if (attack === "tiny") for (let i = 0; i < 10; i++) channel.receive(new ArrayBuffer(1));
    if (attack === "meta") channel.receive(JSON.stringify({ t: "meta", id: 1, size: 100 }));
    assert.equal(await response, null);
    assert.equal(link.closed, true);
  }
});

test("backpressure has a deadline and request cancellation closes the untagged transfer", async () => {
  const channel = new Channel(); channel.bufferedAmount = 2_000_000;
  const link = new PeerLink({ pubkey: "peer", pc: new PC(), channel, maxSegmentBytes: 1024, drainTimeoutMs: 20, onRequest: () => new Uint8Array(32) });
  channel.receive(JSON.stringify({ t: "want", id: 1, k: "a".repeat(64) }));
  await until(() => link.closed);
  const other = new PeerLink({ pubkey: "peer", pc: new PC(), channel: new Channel(), maxSegmentBytes: 1024 });
  const controller = new AbortController();
  const request = other.request("a".repeat(64), 1000, { signal: controller.signal });
  controller.abort();
  assert.equal(await request, null);
  assert.equal(other.closed, true);
});

test("authoritative size is enforced before accepting any peer chunks", async () => {
  const channel = new Channel();
  const link = new PeerLink({ pubkey: "peer", pc: new PC(), channel, maxSegmentBytes: 1024 });
  const request = link.request("a".repeat(64), 1000, { expectedSize: 32 });
  channel.receive(JSON.stringify({ t: "meta", id: 1, size: 1000 }));
  assert.equal(await request, null);
  assert.equal(link.closed, true);
});

test("relay reconnect cannot resurrect a socket after close", async () => {
  const sockets = [];
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; sockets.push(this); if (sockets.length === 1) queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send() {}
    close() { this.closed = true; this.dispatchEvent(new Event("close")); }
  }
  const pool = new RelayPool(["wss://relay.example"], { WebSocketImpl: Socket, reconnect: true, reconnectMaxMs: 20 });
  await pool.connect(); sockets[0].close();
  await until(() => sockets.length === 2);
  pool.close(); sockets[1].dispatchEvent(new Event("open"));
  assert.equal(pool.sockets.length, 0);
  assert.equal(pool.pendingSockets.size, 0);
  assert.equal(sockets[1].closed, true);
});

test("a pool recovers when every relay was unavailable at startup", async () => {
  let available = false;
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; queueMicrotask(() => this.dispatchEvent(new Event(available ? "open" : "error"))); }
    send() {}
    close() { this.dispatchEvent(new Event("close")); }
  }
  const pool = new RelayPool(["wss://relay.example"], { WebSocketImpl: Socket, reconnect: true, reconnectMaxMs: 20 });
  const connecting = pool.connect();
  await until(() => pool.retryTimers.size > 0); available = true;
  await connecting;
  assert.equal(pool.sockets.length, 1); pool.close();
  const cancelled = new RelayPool(["wss://relay.example"], { WebSocketImpl: Socket, reconnect: true });
  available = false;
  const waiting = cancelled.connect(); cancelled.close();
  await assert.rejects(waiting, /closed/);
});

test("a retry rechecks admission before publishing any more SDP", async () => {
  const relay = await startLocalRelay();
  let allowed = true, checks = 0, offers = 0;
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], admit: () => { checks++; return allowed; }, retryFloorMs: 20, retryCeilingMs: 20, maxRetriesPerPeer: 1 });
  const pool = new RelayPool([relay.url]);
  const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId });
  try {
    swarm.attach({ config: { loader: Loader } });
    await until(() => swarm.metrics().pubkey);
    await pool.connect(); peer.start();
    peer.onSignal(({ from, payload }) => {
      if (payload.type !== "offer") return;
      offers++; allowed = false;
      peer.sendSignal(from, { type: "reject", transport: "webrtc", requestId: payload.requestId, payload: { retryAfterMs: 20 } });
    });
    peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket: "expires" });
    await until(() => offers === 1);
    const before = checks;
    await until(() => checks > before);
    assert.equal(offers, 1);
    assert.equal(swarm.metrics().peers.dialsStarted, 1);
  } finally { swarm.stop(); peer.close(); pool.close(); await relay.close(); }
});

test("a full cohort's unchanged heartbeats skip HTTP admission while ticket changes and serving recheck it", async () => {
  let allowed = true;
  const verified = [], completed = [];
  const http = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks));
    verified.push(input);
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ admitted: allowed }));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const fixture = await linkedFixture({ maxPeers: 1, serve: true, admit: async (pubkey, ticket, { signal }) => {
    const response = await fetch(`http://127.0.0.1:${http.address().port}/verify`, { method: "POST", body: JSON.stringify({ pubkey, ticket }), signal });
    const admitted = (await response.json()).admitted;
    completed.push(ticket);
    return admitted;
  } });
  const extras = [];
  try {
    const channel = await fixture.addPeer(), known = fixture.peers[0];
    const witness = new RelaySwarmSession({ pool: fixture.pool, swarmId: base.swarmId }); witness.start(); extras.push(witness);
    let observed = 0;
    witness.onPresence(({ from, payload }) => { if (from !== fixture.swarm.metrics().pubkey && payload.have.length) observed++; });
    const unknown = Array.from({ length: 11 }, () => {
      const peer = new RelaySwarmSession({ pool: fixture.pool, swarmId: base.swarmId }); peer.start(); extras.push(peer); return peer;
    });
    const before = verified.length;
    let announcement = 0;
    const announce = (peer, ticket = "fixture-ticket", open = true) => peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket, open,
      have: [createHash("sha256").update(String(++announcement)).digest("hex")] });
    // Twelve signed identities, three distinct heartbeats each; every event is
    // delivered by the real relay, rather than collapsed by event-ID deduplication.
    for (let round = 0; round < 3; round++) for (const peer of [known, ...unknown]) announce(peer);
    await until(() => observed === 36); await sleep(50);
    assert.equal(verified.length, before, "connected same-ticket and unknown full-capacity presence grants no new access");
    assert.equal(fixture.swarm.metrics().peers.dialsStarted, 0);

    announce(known, "rotated-ticket");
    await until(() => completed.includes("rotated-ticket")); await sleep(0);
    assert.equal(verified.length, before + 1);
    assert.equal(verified.at(-1).ticket, "rotated-ticket", "active peers refresh changed credentials even when full");
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = channel.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    channel.receive(JSON.stringify({ t: "want", id: 900, k: key }));
    await until(() => fixture.swarm.metrics().bytes.uploaded === 32);
    assert.equal(verified.at(-1).ticket, "rotated-ticket", "serving uses the refreshed ticket and a new online check");

    const beforeRevoked = verified.length;
    allowed = false; announce(known, "rotated-ticket");
    await until(() => observed === 38); await sleep(30);
    assert.equal(verified.length, beforeRevoked, "a heartbeat does not cache or extend authority");
    channel.receive(JSON.stringify({ t: "want", id: 901, k: key }));
    await until(() => channel.readyState === "closed");
    assert.equal(verified.length, beforeRevoked + 1, "revocation is checked before sending another payload");
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 32);
  } finally {
    for (const peer of extras) peer.close();
    await fixture.close(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
  }
});

test("dialling heartbeats and cooldowns skip checks but changed tickets and answer expiry do not", async () => {
  const relay = await startLocalRelay();
  const checks = [], offers = [];
  let allowed = true;
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], maxRetriesPerPeer: 0,
    admit: (_pubkey, ticket) => { checks.push(ticket); return allowed; } });
  const pool = new RelayPool([relay.url]); const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId });
  let observed = 0, announcement = 0;
  const announce = (ticket) => peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket,
    have: [createHash("sha256").update(String(++announcement)).digest("hex")] });
  try {
    swarm.attach({ config: { loader: Loader } }); await until(() => swarm.metrics().pubkey);
    await pool.connect(); peer.start(); peer.onSignal(({ payload }) => { if (payload.type === "offer") offers.push(payload); });
    const witness = new RelaySwarmSession({ pool, swarmId: base.swarmId }); witness.start(); witness.onPresence(({ from }) => { if (from === peer.pubkey) observed++; });
    announce("original"); await until(() => offers.length === 1);
    const before = checks.length;
    announce("original"); announce("original");
    await until(() => observed === 3); await sleep(30);
    assert.equal(checks.length, before, "an already pending dial discloses no additional SDP from presence");
    announce("renewed"); await until(() => checks.length === before + 1);
    assert.equal(checks.at(-1), "renewed");
    allowed = false;
    const sent = swarm.metrics().relays.signalsSent;
    peer.sendSignal(swarm.metrics().pubkey, { type: "answer", transport: "webrtc", requestId: offers[0].requestId, payload: { sdp: "expired-answer", ticket: "renewed" } });
    await until(() => swarm.metrics().peers.dialsFailed === 1);
    assert.equal(checks.length, before + 2, "an expired or revoked ticket is checked again before accepting SDP");
    assert.equal(swarm.metrics().relays.signalsSent, sent);
    const coolingChecks = checks.length;
    announce("fresh-but-cooling"); announce("fresh-but-cooling");
    await until(() => observed === 6); await sleep(30);
    assert.equal(checks.length, coolingChecks, "presence cannot spend admission checks on a peer that cannot be dialled yet");
    assert.equal(swarm.metrics().peers.dialsStarted, 1);
    witness.close();
  } finally { swarm.stop(); peer.close(); pool.close(); await relay.close(); }
});

test("unchanged active credentials keep advisory open hints without trusting unknown full-capacity peers", async () => {
  let checks = 0;
  const fixture = await linkedFixture({ maxPeers: 1, admit: () => { checks++; return true; } });
  const strangers = [];
  try {
    await fixture.addPeer();
    const known = fixture.peers[0];
    const requester = new RelaySwarmSession({ pool: fixture.pool, swarmId: base.swarmId }); requester.start(); strangers.push(requester);
    const unknown = new RelaySwarmSession({ pool: fixture.pool, swarmId: base.swarmId }); unknown.start(); strangers.push(unknown);
    let presences = 0;
    requester.onPresence(({ from }) => { if (from === known.pubkey || from === unknown.pubkey) presences++; });
    const refusals = [];
    requester.onSignal(({ payload }) => { if (payload.type === "reject") refusals.push(payload.payload); });
    const announce = (peer, open) => peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket: "fixture-ticket", open });
    const offer = (id) => requester.sendSignal(fixture.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: id, payload: { sdp: "offer", ticket: "fixture-ticket" } });
    const before = checks;
    announce(known, true); announce(unknown, true);
    await until(() => presences === 2); await sleep(0);
    assert.equal(checks, before);
    offer("open-hint"); await until(() => refusals.length === 1);
    assert.deepEqual(refusals[0].referrals, [known.pubkey], "only the previously admitted identity supplies the open referral");
    const afterOffer = checks;
    announce(known, false);
    await until(() => presences === 3); await sleep(0);
    assert.equal(checks, afterOffer);
    offer("closed-hint"); await until(() => refusals.length === 2);
    assert.deepEqual(refusals[1].referrals, [], "the unchanged known ticket still updates a closed hint");
  } finally { for (const peer of strangers) peer.close(); await fixture.close(); }
});

test("delayed admission cannot create a peer after stop", async () => {
  const relay = await startLocalRelay();
  let release, entered = false;
  const pending = new Promise((resolve) => { release = resolve; });
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], admit: () => { entered = true; return pending; } });
  const pool = new RelayPool([relay.url]); const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId });
  try {
    swarm.attach({ config: { loader: Loader } }); await until(() => swarm.metrics().pubkey);
    await pool.connect(); peer.start();
    const before = PC.instances.length;
    peer.sendSignal(swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "pending-admission", payload: { sdp: "offer", ticket: "good" } });
    await until(() => entered); swarm.stop(); release(true); await sleep(30);
    assert.equal(PC.instances.length, before);
    assert.equal(swarm.metrics().peers.dialling, 0);
    assert.equal(swarm.metrics().relays.connected, 0);
  } finally { swarm.stop(); peer.close(); pool.close(); await relay.close(); }
});

test("defaults are receive-only and sampled coverage includes fragments with no peers", async () => {
  const relay = await startLocalRelay();
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], shadowSampleRate: 1, lateWindowMs: 20 });
  const hls = { config: { loader: Loader } };
  try {
    assert.equal(swarm.metrics().serving, false);
    assert.equal(createHlsSwarm({ ...base, relays: [relay.url] }).metrics().config.shadowSampleRate, 0.25);
    swarm.attach(hls);
    for (let i = 0; i < 2; i++) new hls.config.fLoader({}).load(context, {}, { onSuccess() {}, onError() {}, onTimeout() {} });
    await until(() => swarm.metrics().segments.noPeers === 2);
    const metrics = swarm.metrics();
    assert.equal(metrics.segments.inTimeShare, null);
    assert.equal(metrics.segments.sampledInTimeShare, 0);
    assert.equal(metrics.segments.sampledInTimeByteShare, 0);
    assert.equal(metrics.bytes.held, 0);
  } finally { swarm.stop(); await relay.close(); }
});

function signedFixture(overrides = {}, signer) {
  const secret = generateSecretKey();
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000), tags: [["d", "test"], ["relayswarm", "redistribute", "1"]], content: "" }, secret);
  const fields = { streamEventId: streamEvent.id, swarmId: base.swarmId, key: "a".repeat(64), rendition: "0", sequence: 1, discontinuity: 0, part: null, sha256: "b".repeat(64), size: 32, expiresAt: Math.floor(Date.now() / 1000) + 60, ...overrides };
  const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: Math.floor(Date.now() / 1000), tags: [["x", fields.swarmId], ["e", fields.streamEventId]], content: commitmentContent(fields) }, signer || secret);
  return { event, options: { streamEvent, swarmId: base.swarmId, key: "a".repeat(64), context, maxSegmentBytes: 1024 } };
}

function peerPlaybackOptions(originFallbackMs = 300) {
  const key = createHash("sha256").update(`${base.swarmId}\n/seg.ts`).digest("hex");
  const bytes = new Uint8Array(32).fill(9);
  const signed = signedFixture({ key, sha256: createHash("sha256").update(bytes).digest("hex") });
  return { bytes, key, options: { mode: "peer-first", streamEvent: signed.options.streamEvent, getCommitment: () => signed.event, originFallbackMs } };
}

class ServingChannel extends RecordedChannel {
  constructor(bytes, delayMs, trace, label) { super(); this.bytes = bytes; this.delayMs = delayMs; this.trace = trace; this.label = label; }
  send(data) {
    super.send(data);
    if (typeof data !== "string") return;
    const frame = JSON.parse(data);
    if (frame.t !== "want") return;
    this.trace.push(this.label);
    if (this.delayMs === null) return;
    setTimeout(() => {
      if (this.readyState !== "open") return;
      if (!this.bytes) return this.receive(JSON.stringify({ t: "none", id: frame.id }));
      this.receive(JSON.stringify({ t: "meta", id: frame.id, size: this.bytes.byteLength }));
      this.receive(this.bytes.slice().buffer);
      this.receive(JSON.stringify({ t: "eof", id: frame.id }));
    }, this.delayMs);
  }
}

test("peer-first explores a cold link, then prefers its measured faster verified delivery", async () => {
  const playback = peerPlaybackOptions(), trace = [];
  const fixture = await linkedFixture({ ...playback.options, serve: true, maxUploadBytesPerSession: 0 });
  try {
    const slow = await fixture.addPeer(new ServingChannel(playback.bytes, 40, trace, "slow"));
    const fast = await fixture.addPeer(new ServingChannel(playback.bytes, 2, trace, "fast"));
    for (const channel of [slow, fast]) channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    for (let i = 0; i < 7; i++) assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    assert.deepEqual(trace, ["slow", "slow", "slow", "slow", "fast", "fast", "fast"]);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 7);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 0);
    assert.equal(fixture.swarm.metrics().serving, false, "exhausted contribution still receives verified peer segments");
    const measurements = fixture.swarm.metrics().peers.deliveryMeasurements;
    assert.equal(measurements.length, 2);
    assert.ok(measurements.every((value) => value.latencyMs > 0 && value.throughputBytesPerSecond > 0));
  } finally { await fixture.close(); }
});

test("a failing eligible peer yields to another peer within the existing origin deadline", async () => {
  const playback = peerPlaybackOptions(200), trace = [];
  const fixture = await linkedFixture(playback.options);
  try {
    const failing = await fixture.addPeer(new ServingChannel(null, 1, trace, "failing"));
    const healthy = await fixture.addPeer(new ServingChannel(playback.bytes, 20, trace, "healthy"));
    for (const channel of [failing, healthy]) channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    await fixture.load(); await fixture.load();
    assert.deepEqual(trace, ["failing", "healthy", "healthy"]);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 2);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 0);
  } finally { await fixture.close(); }
});

test("known 900ms verified delivery keeps enough of a 1500ms deadline when alternatives are available", async () => {
  const playback = peerPlaybackOptions(1500), trace = [];
  const fixture = await linkedFixture(playback.options);
  try {
    const known = await fixture.addPeer(new ServingChannel(playback.bytes, 900, trace, "known"));
    known.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    await fixture.load(); // Observe real successful completion before alternatives join.
    for (let i = 0; i < 2; i++) {
      const other = await fixture.addPeer(new ServingChannel(null, null, trace, `other-${i}`));
      other.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    }
    const started = performance.now(); const response = await fixture.load();
    assert.deepEqual(new Uint8Array(response.data), playback.bytes);
    assert.ok(performance.now() - started < 1500, "the original origin budget is respected");
    assert.deepEqual(trace, ["known", "known"]);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 2);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 0);
    assert.equal(known.readyState, "open", "the measured useful link was not closed by a short equal slice");
  } finally { await fixture.close(); }
});

test("serial peer attempts leave time for another link and stalled peers fall back once by the deadline", async () => {
  for (const bothStall of [false, true]) {
    const playback = peerPlaybackOptions(120), trace = [];
    const fixture = await linkedFixture(playback.options);
    try {
      const stalled = await fixture.addPeer(new ServingChannel(null, null, trace, "stalled"));
      const other = await fixture.addPeer(new ServingChannel(playback.bytes, bothStall ? null : 2, trace, "other"));
      for (const channel of [stalled, other]) channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
      const started = performance.now(); const response = await fixture.load();
      assert.equal(response.data.byteLength, 32);
      assert.ok(performance.now() - started < 220, "the existing origin deadline remains bounded");
      await sleep(30);
      assert.deepEqual(trace, ["stalled", "other"]);
      assert.equal(fixture.swarm.metrics().segments.originFallbacks, bothStall ? 1 : 0);
      assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, bothStall ? 0 : 1);
    } finally { await fixture.close(); }
  }
});

test("commitments bind the authorised signer, stream, rendition, sequence, discontinuity, part, key, size and expiry", () => {
  const good = signedFixture();
  assert.ok(verifySegmentCommitment(good.event, good.options));
  for (const overrides of [{ streamEventId: "c".repeat(64) }, { swarmId: "another-swarm" }, { key: "c".repeat(64) }, { rendition: "1" }, { sequence: 2 }, { discontinuity: 1 }, { part: 0 }, { size: 2048 }, { expiresAt: 0 }]) {
    const value = signedFixture(overrides);
    assert.equal(verifySegmentCommitment(value.event, value.options), null);
  }
  const stranger = signedFixture({}, generateSecretKey());
  assert.equal(verifySegmentCommitment(stranger.event, stranger.options), null);
  const tampered = JSON.parse(JSON.stringify(good.event)); tampered.content += " ";
  assert.equal(verifySegmentCommitment(tampered, good.options), null);
  good.event.content += " ";
  assert.equal(verifySegmentCommitment(good.event, good.options), null, "a cached signature verdict cannot survive mutation");
});

test("a fragment no peer advertises uses origin; abort suppresses late callbacks", async () => {
  const relay = await startLocalRelay();
  const fixture = signedFixture();
  try {
    for (const getCommitment of [() => assert.fail("unavailable objects must not trigger commitment I/O")]) {
      const swarm = createHlsSwarm({ ...base, relays: [relay.url], mode: "peer-first", streamEvent: fixture.options.streamEvent, getCommitment, originFallbackMs: 30 });
      const hls = { config: { loader: Loader } }; swarm.attach(hls);
      let delivered = 0;
      const loader = new hls.config.fLoader({});
      loader.load(context, {}, { onSuccess: () => { delivered++; } });
      await until(() => delivered === 1);
      await sleep(40); assert.equal(delivered, 1); assert.equal(swarm.metrics().segments.originFallbacks, 1);
      loader.destroy(); swarm.stop();
    }
    const swarm = createHlsSwarm({ ...base, relays: [relay.url], mode: "peer-first", streamEvent: fixture.options.streamEvent, getCommitment: () => new Promise(() => {}), originFallbackMs: 30 });
    const hls = { config: { loader: Loader } }; swarm.attach(hls);
    let delivered = 0, aborted = 0;
    const loader = new hls.config.fLoader({});
    const statsReference = loader.stats;
    loader.load(context, {}, { onSuccess: () => { delivered++; }, onAbort: (stats, ctx) => { aborted++; assert.equal(stats, statsReference); assert.equal(ctx, context); assert.equal(stats.aborted, true); } });
    loader.abort(); loader.abort(); await sleep(50);
    assert.equal(delivered, 0); assert.equal(aborted, 1, "hls.js receives one abort outcome"); swarm.stop();
  } finally { await relay.close(); }
});

test("an empty playback buffer uses origin immediately and stop releases a waiting load once", async () => {
  const relay = await startLocalRelay();
  const fixture = signedFixture();
  let checks = 0;
  const options = { ...base, relays: [relay.url], mode: "peer-first", streamEvent: fixture.options.streamEvent, getCommitment: () => { checks++; return new Promise(() => {}); }, originFallbackMs: 1000 };
  try {
    const immediate = createHlsSwarm(options);
    const hls = { config: { loader: Loader }, media: { currentTime: 0, buffered: { length: 0 } } };
    immediate.attach(hls);
    let delivered = 0;
    new hls.config.fLoader({}).load(context, {}, { onSuccess: () => { delivered++; } });
    assert.equal(delivered, 1);
    assert.equal(checks, 0);
    immediate.stop();
    const waiting = createHlsSwarm(options);
    const second = { config: { loader: Loader } }; waiting.attach(second);
    delivered = 0;
    new second.config.fLoader({}).load(context, {}, { onSuccess: () => { delivered++; } });
    waiting.stop();
    assert.equal(delivered, 1);
    await sleep(30); assert.equal(delivered, 1);
  } finally { await relay.close(); }
});

test("stalled host operations have a deadline and shutdown cancels them", async () => {
  const stalled = () => new Promise(() => {});
  await assert.rejects(boundedOperation(stalled, new AbortController().signal, 20), /timed out/);
  const controller = new AbortController();
  const operation = boundedOperation(stalled, controller.signal, 1000);
  controller.abort();
  await assert.rejects(operation, /cancelled/);
});

test("real withheld admission HTTP requests abort at each deadline without accumulating or admitting peers", async () => {
  const held = new Set(), signals = [], peers = [], connections = [], serverErrors = [];
  let reply = null, aborted = 0, peakHeld = 0;
  const http = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/admission/verify"); assert.equal(request.method, "POST");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.match(input.pubkey, /^[0-9a-f]{64}$/); assert.equal(input.ticket, "fixture-ticket");
      if (reply !== null) { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ admitted: reply })); return; }
      held.add(response); peakHeld = Math.max(peakHeld, held.size);
      response.on("close", () => { held.delete(response); if (!response.writableEnded) aborted++; });
    } catch (error) { serverErrors.push(error.message); response.destroy(); }
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const url = `http://127.0.0.1:${http.address().port}/admission/verify`;
  const relay = await startLocalRelay(), pool = new RelayPool([relay.url]);
  class Connection extends PC { constructor() { super(); connections.push(this); } }
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], RTCPeerConnectionImpl: Connection, admissionTimeoutMs: 150,
    admit: async (pubkey, ticket, { signal }) => {
      signals.push(signal);
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey, ticket }), signal });
      return (await response.json()).admitted === true;
    },
  });
  const offer = (peer, id) => peer.sendSignal(swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: id, payload: { sdp: "fixture-offer", ticket: "fixture-ticket" } });
  try {
    swarm.attach({ config: { loader: Loader } }); await pool.connect(); await until(() => swarm.metrics().pubkey);
    const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId }); peer.start(); peers.push(peer);
    for (let round = 1; round <= 3; round++) {
      offer(peer, `withheld-${round}`); await until(() => held.size === 1);
      await until(() => aborted === round && held.size === 0 && swarm.metrics().peers.admitRefused === round);
      assert.equal(signals[round - 1].aborted, true);
      assert.equal(connections.length, 0); assert.equal(swarm.metrics().relays.signalsSent, 0, "no SDP may be published on expired admission");
    }
    assert.equal(peakHeld, 1); assert.equal(swarm.metrics().errors.byStage.admit, 3);
    reply = false; offer(peer, "explicit-denial"); await until(() => swarm.metrics().peers.admitRefused === 4);
    assert.equal(swarm.metrics().errors.byStage.admit, 3, "false admission is not a callback error");
    assert.equal(connections.length, 0);
    reply = true; offer(peer, "valid-after-timeouts"); await until(() => swarm.metrics().peers.offersAccepted === 1);
    assert.equal(connections.length, 1, "operation deadlines must not abort the swarm lifecycle");
    const second = new RelaySwarmSession({ pool, swarmId: base.swarmId }); second.start(); peers.push(second);
    reply = null; offer(second, "stop-withheld"); await until(() => held.size === 1);
    swarm.stop(); await until(() => aborted === 4 && held.size === 0);
    assert.equal(connections.length, 1, "stopped admission cannot create a late peer");
    assert.equal(signals.at(-1).aborted, true);
    assert.equal(new Set(signals).size, signals.length, "each host operation owns a distinct cancellation signal");
    assert.equal(signals[3].aborted, false); assert.equal(signals[4].aborted, false, "settled operations remove the lifecycle abort listener");
    assert.deepEqual(serverErrors, []);
  } finally {
    swarm.stop(); for (const peer of peers) peer.close(); pool.close(); await relay.close();
    for (const response of held) response.destroy(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve));
  }
});

test("a deadline settles once, ignores a late host result and preserves callback rejection values", async () => {
  const parent = new AbortController(); let release, signal, aborts = 0;
  const promise = boundedOperation((ownedSignal) => {
    signal = ownedSignal; signal.addEventListener("abort", () => { aborts++; });
    return new Promise((resolve) => { release = resolve; });
  }, parent.signal, 20);
  await assert.rejects(promise, /timed out/);
  assert.equal(parent.signal.aborted, false); assert.equal(signal.aborted, true);
  release(true); parent.abort(); await sleep(10); assert.equal(aborts, 1);
  await assert.rejects(promise, /timed out/);
  let rejected = false;
  await boundedOperation(() => Promise.reject(undefined), undefined, 100).catch((error) => { rejected = true; assert.equal(error, undefined); });
  assert.equal(rejected, true, "even a falsy rejection must not become successful admission");
});

test("peer-first fallback preserves a single-use HTTP loader's statistics contract", async () => {
  const relay = await startLocalRelay();
  const fixture = signedFixture();
  class SingleUseLoader extends Loader {
    stats = { loading: { start: 0 } };
    load(ctx, _config, callbacks) {
      assert.equal(this.stats.loading.start, 0, "unused HTTP loader has not been marked started");
      this.stats.loading.start = performance.now(); this.stats.loaded = 32;
      callbacks.onSuccess({ data: new Uint8Array(32).buffer }, this.stats, ctx, null);
    }
  }
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], mode: "peer-first", streamEvent: fixture.options.streamEvent, getCommitment: () => assert.fail("no advertised peer") });
  try {
    const hls = { config: { loader: SingleUseLoader } }; swarm.attach(hls);
    const loader = new hls.config.fLoader({}), reference = loader.stats;
    let deliveries = 0;
    loader.load(context, {}, { onSuccess: (_response, stats) => { deliveries++; assert.equal(stats, reference); assert.equal(stats.loaded, 32); } });
    await until(() => deliveries === 1);
    assert.equal(swarm.metrics().segments.originFallbacks, 1);
  } finally { swarm.stop(); await relay.close(); }
});

test("relay frames must match a live subscription before deduplication or dispatch", async () => {
  let socket;
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send() {}
    close() {}
    receive(id, event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EVENT", id, event]) })); }
  }
  const pool = new RelayPool(["wss://relay.example"], { WebSocketImpl: Socket });
  await pool.connect();
  try {
    const presence = pool.subscribe({ kinds: [24170], "#x": [base.swarmId] });
    const signals = pool.subscribe({ kinds: [24171], "#x": [base.swarmId], "#p": ["a".repeat(64)] });
    const event = finalizeEvent({ kind: 24171, created_at: Math.floor(Date.now() / 1000), tags: [["x", base.swarmId], ["p", "a".repeat(64)]], content: "test payload" }, generateSecretKey());
    let received = 0; pool.onEvent(() => received++);
    socket.receive("unknown", event); socket.receive(presence, event);
    assert.equal(received, 0); assert.equal(pool.seen.has(event.id), false);
    socket.receive(signals, { ...event, tags: null });
    assert.equal(received, 0);
    socket.receive(signals, event); assert.equal(received, 1);
    pool.unsubscribe(signals);
    socket.receive(signals, finalizeEvent({ ...event, content: "late frame" }, generateSecretKey()));
    assert.equal(received, 1);
  } finally { pool.close(); }
});

test("cached presence can be discovered without replaying old signals or expired presence", async () => {
  const relay = await startLocalRelay(), senderPool = new RelayPool([relay.url]), receiverPool = new RelayPool([relay.url]);
  const sender = new RelaySwarmSession({ pool: senderPool, swarmId: base.swarmId });
  const receiver = new RelaySwarmSession({ pool: receiverPool, swarmId: base.swarmId });
  const presences = [], signals = [];
  receiver.onPresence((value) => presences.push(value)); receiver.onSignal((value) => signals.push(value));
  try {
    await Promise.all([senderPool.connect(), receiverPool.connect()]);
    const now = Math.floor(Date.now() / 1000);
    const fresh = sender.announcePresence({ role: "seeder", transports: [], have: [] });
    senderPool.publish(finalizeEvent({ ...fresh, created_at: now - 10 }, sender.secretKey));
    senderPool.publish(finalizeEvent({ ...fresh, created_at: now - 121 }, sender.secretKey));
    const old = sender.sendSignal(receiver.pubkey, { type: "offer", transport: "webrtc", requestId: "old-signal-probe", payload: { type: "offer", sdp: "cached" } });
    senderPool.publish(finalizeEvent({ ...old, created_at: now - 10 }, sender.secretKey));
    await until(() => relay.events.length >= 5);
    // Keep only historical frames, so replay cannot be hidden by a fresh copy.
    relay.events.splice(0, relay.events.length, ...relay.events.filter((event) => event.created_at < now));
    receiver.start();
    await until(() => presences.length === 1);
    await sleep(30);
    assert.equal(presences[0].event.created_at, now - 10);
    assert.equal(signals.length, 0);
    sender.sendSignal(receiver.pubkey, { type: "offer", transport: "webrtc", requestId: "fresh-signal-probe", payload: { type: "offer", sdp: "fresh" } });
    await until(() => signals.length === 1);
    assert.equal(signals[0].payload.requestId, "fresh-signal-probe");
  } finally { sender.close(); receiver.close(); senderPool.close(); receiverPool.close(); await relay.close(); }
});

test("session subscribes only to its own signals and cleans up partial subscription failures", async () => {
  const filters = [], closed = [];
  let failSecond = false, handlerPresent = false;
  const pool = {
    onEvent() { handlerPresent = true; return () => { handlerPresent = false; }; },
    subscribe(filter) { if (failSecond && filters.length === 1) throw new Error("capacity"); filters.push(filter); return String(filters.length); },
    unsubscribe(id) { closed.push(id); },
  };
  const session = new RelaySwarmSession({ pool, swarmId: base.swarmId }); session.start();
  assert.deepEqual(filters.map((filter) => filter.kinds), [[24170], [24171]]);
  assert.deepEqual(filters[1]["#p"], [session.pubkey]);
  session.close(); assert.deepEqual(closed, ["1", "2"]); assert.equal(handlerPresent, false);
  filters.length = 0; closed.length = 0; failSecond = true;
  const partial = new RelaySwarmSession({ pool, swarmId: base.swarmId });
  assert.throws(() => partial.start(), /capacity/u);
  assert.deepEqual(closed, ["1"]); assert.equal(partial.started, false); assert.equal(handlerPresent, false);
});


test("fresh live-edge objects wait for a same-rendition contributor without delaying playlists", async () => {
  const playback = peerPlaybackOptions(200), trace = [];
  const fixture = await linkedFixture(playback.options);
  try {
    const peer = await fixture.addPeer(new ServingChannel(playback.bytes, 2, trace, "seeder"));
    peer.receive(JSON.stringify({ t: "contribution", serving: true, rendition: "main:0" }));
    const pending = fixture.load();
    setTimeout(() => { peer.receive(JSON.stringify({ t: "fetching", k: playback.key, ms: 100 })); peer.receive(JSON.stringify({ t: "have", add: [playback.key] })); }, 30);
    assert.deepEqual(new Uint8Array((await pending).data), playback.bytes);
    assert.deepEqual(trace, ["seeder"]);
    assert.equal(fixture.swarm.metrics().segments.coordinatedWaits, 1);
    assert.equal(fixture.swarm.metrics().segments.coordinatedPeerLoads, 1);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 0);
  } finally { await fixture.close(); }
});

test("later LL-HLS parts use their own playback position while retaining the HTTP reserve", async () => {
  const playback = peerPlaybackOptions(1000), trace = [];
  const signed = signedFixture({ key: playback.key, part: 1, sha256: createHash("sha256").update(playback.bytes).digest("hex") });
  const fixture = await linkedFixture({ ...playback.options, swarmParts: true, streamEvent: signed.options.streamEvent, getCommitment: () => signed.event });
  try {
    fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 13 } };
    const peer = await fixture.addPeer(new ServingChannel(playback.bytes, 2, trace, "part-contributor"));
    peer.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    const partContext = { ...context, frag: { ...context.frag, start: 12 }, part: { index: 1, start: 13 } };
    await new Promise((resolve) => new fixture.hls.config.fLoader({}).load(partContext, {}, { onSuccess: resolve }));
    assert.deepEqual(trace, ["part-contributor"]);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 1);
    fixture.hls.media.currentTime = 11;
    await new Promise((resolve) => new fixture.hls.config.fLoader({}).load(partContext, {}, { onSuccess: resolve }));
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 1, "two seconds of remaining buffer are reserved for HTTP");
    assert.deepEqual(trace, ["part-contributor"]);
  } finally { await fixture.close(); }
});

test("measured slow HTTP raises a tuned low-latency reserve before any peer wait", async () => {
  class SlowOrigin extends Loader {
    load(context, config, callbacks) { setTimeout(() => super.load(context, config, callbacks), 500); }
  }
  const playback = peerPlaybackOptions(100), trace = [];
  const fixture = await linkedFixture({ ...playback.options, originReserveMs: 500 }, SlowOrigin);
  try {
    fixture.hls.media = { currentTime: 0, buffered: { length: 0 } };
    await fixture.load();
    const peer = await fixture.addPeer(new ServingChannel(playback.bytes, 2, trace, "available"));
    peer.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    fixture.hls.media.buffered = { length: 1, start: () => 0, end: () => 0.6 };
    await fixture.load();
    assert.deepEqual(trace, [], "600ms of buffer exceeds the configured reserve but not measured HTTP recovery plus append reserve");
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 2);
    assert.ok(fixture.swarm.metrics().segments.originLatencyMedianMs >= 450);
  } finally { await fixture.close(); }
});

test("fresh-object coordination is bounded for lying contributors and ignores unrelated ABR renditions", async () => {
  for (const rendition of ["main:0", "main:1"]) {
    const playback = peerPlaybackOptions(80), trace = [];
    const fixture = await linkedFixture(playback.options);
    try {
      const peer = await fixture.addPeer(new ServingChannel(playback.bytes, 2, trace, "seeder"));
      peer.receive(JSON.stringify({ t: "contribution", serving: true, rendition }));
      const started = performance.now(); await fixture.load();
      assert.ok(performance.now() - started < 160, "a malicious contributor cannot suppress HTTP recovery");
      assert.equal(fixture.swarm.metrics().segments.coordinatedWaits, rendition === "main:0" ? 1 : 0);
      assert.equal(fixture.swarm.metrics().segments.originFallbacks, 1);
      assert.deepEqual(trace, []);
    } finally { await fixture.close(); }
  }
});

test("coordination frames cannot grow leases without bounds or override contribution consent", () => {
  const channel = new RecordedChannel(), link = new PeerLink({ pubkey: "a".repeat(64), pc: new PC(), channel, maxSegmentBytes: 1024 });
  const lease = (key, ms) => channel.receive(JSON.stringify({ t: "fetching", k: key, ms }));
  lease("a".repeat(64), 2000);
  assert.equal(link.fetching.size, 0, "receive-only peers cannot claim seeding");
  channel.receive(JSON.stringify({ t: "contribution", serving: true, rendition: "main:0" }));
  for (let i = 0; i < 50; i++) lease(i.toString(16).padStart(64, "0"), 2000);
  assert.equal(link.fetching.size, 24);
  lease("b".repeat(64), 2001); lease("c".repeat(64), -1);
  assert.equal(link.fetching.size, 24);
  channel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
  assert.equal(link.fetching.size, 0);
  link.close();
});

test("persistent upload reservation refuses safely and concurrent reservations cannot overspend", async () => {
  let reserved = 0;
  const fixture = await linkedFixture({ serve: true, reserveUploadBytes: async (size) => { await sleep(15); if (reserved + size > 32) return false; reserved += size; return true; } });
  try {
    const peers = [await fixture.addPeer(), await fixture.addPeer()];
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = createHash("sha256").update(`${base.swarmId}\n/seg.ts`).digest("hex");
    for (const peer of peers) peer.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => peers.every((peer) => peer.sent.some((frame) => frame.t === "eof" || frame.t === "none")));
    assert.equal(reserved, 32);
    assert.equal(peers.flatMap((peer) => peer.sent).filter((frame) => frame.t === "eof").length, 1);
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 32);
  } finally { await fixture.close(); }
});


test("a revoked connected peer loses media access before any new accepted upload", async () => {
  let admitted = true;
  const fixture = await linkedFixture({ serve: true, admit: async () => admitted });
  try {
    const peer = await fixture.addPeer(); await fixture.load();
    await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = peer.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    admitted = false; peer.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => peer.readyState === "closed");
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 0);
    assert.equal(peer.sent.filter((frame) => frame.t === "meta").length, 0);
  } finally { await fixture.close(); }
});
