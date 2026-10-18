import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { generateSecretKey, finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { commitmentContent, KIND_SEGMENT_COMMITMENT, verifySegmentCommitment } from "../src/browser/segment-commitment.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";
import { boundedOperation } from "../src/browser/bounded-operation.mjs";
import { NeighbourDiscovery } from "../src/browser/neighbour-discovery.mjs";
import { PeerSelection } from "../src/browser/peer-selection.mjs";

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
  constructor(configuration) { super(); this.configuration = configuration; PC.instances.push(this); }
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
  const relay = options.WebSocketImpl ? { url: "wss://memory-relay.example", close: async () => {} } : await startLocalRelay();
  const connections = [], peers = [];
  let peakLiveConnections = 0;
  class Connection extends PC { constructor(configuration) { super(configuration); connections.push(this); peakLiveConnections = Math.max(peakLiveConnections, connections.filter(pc => !pc.closed).length); } }
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], RTCPeerConnectionImpl: Connection, shadowSampleRate: 0, ...options });
  const hls = { config: { loader: LoaderImpl } };
  swarm.attach(hls);
  const pool = new RelayPool([relay.url], { WebSocketImpl: options.WebSocketImpl }); await pool.connect();
  await until(() => swarm.metrics().pubkey);
  const addPeer = async (channel = new RecordedChannel(), peerPool = pool) => {
    const peer = new RelaySwarmSession({ pool: peerPool, swarmId: base.swarmId }); peer.start(); peers.push(peer);
    const count = connections.length, accepted = swarm.metrics().peers.offersAccepted;
    peer.sendSignal(swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: `fixture-${count}`, payload: { sdp: "fixture-offer", ...(options.admit ? { ticket: "fixture-ticket" } : {}) } });
    await until(() => connections.length > count && swarm.metrics().peers.offersAccepted > accepted);
    const event = new Event("datachannel"); event.channel = channel; connections[count].dispatchEvent(event);
    await until(() => swarm.metrics().peers.connected === peers.length);
    return channel;
  };
  const load = () => new Promise((resolve) => new hls.config.fLoader({}).load(context, {}, { onSuccess: resolve }));
  const close = async () => { swarm.stop(); for (const peer of peers) peer.close(); pool.close(); await relay.close(); };
  return { swarm, hls, addPeer, load, close, peers, pool, connections, get peakLiveConnections() { return peakLiveConnections; } };
}

// Real session/signature/encryption handling over an in-memory relay boundary.
// These focused loader diagnostics require no HTTP/WebSocket server or browser.
function memoryRelaySocket() {
  const sockets = new Set();
  return class extends EventTarget {
    subscriptions = new Set();
    constructor() { super(); sockets.add(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(text) {
      const [type, id] = JSON.parse(text);
      if (type === "REQ") this.subscriptions.add(id);
      else if (type === "CLOSE") this.subscriptions.delete(id);
      else if (type === "EVENT") {
        // RelayPool still applies its live filter and event validation before
        // dispatch; sending to unrelated subscriptions tests that boundary too.
        for (const socket of sockets) for (const subscription of socket.subscriptions) {
          queueMicrotask(() => { if (sockets.has(socket)) socket.dispatchEvent(new MessageEvent("message", {
            data: JSON.stringify(["EVENT", subscription, id]),
          })); });
        }
      }
    }
    close() { sockets.delete(this); this.dispatchEvent(new Event("close")); }
  };
}

for (const policy of [undefined, "all", "relay"]) {
  test(`ICE transport policy ${policy ?? "default"} reaches incoming and outgoing native connections`, async () => {
    const servers = [{ urls: "turns:relay.example:5349", username: "fixture", credential: "fixture" }];
    const fixture = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), iceServers: servers, iceTransportPolicy: policy });
    try {
      await fixture.addPeer();
      const peer = new RelaySwarmSession({ pool: fixture.pool, swarmId: base.swarmId });
      fixture.peers.push(peer); peer.start();
      peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }] });
      await until(() => fixture.connections.length >= 2);
      assert.equal(fixture.swarm.metrics().transportDiagnostics.counters.created.incoming, 1);
      assert.ok(fixture.swarm.metrics().transportDiagnostics.counters.created.outgoing >= 1);
      for (const pc of fixture.connections) assert.deepEqual(pc.configuration, { iceServers: servers, iceTransportPolicy: policy ?? "all" });
    } finally { await fixture.close(); }
  });
}

test("invalid ICE transport policies disable peers and leave the origin loader intact", () => {
  for (const iceTransportPolicy of [null, "", "Relay", "none", true, {}]) {
    const swarm = createHlsSwarm({ ...base, relays: ["wss://relay.example"], iceTransportPolicy });
    const hls = { config: { loader: Loader } };
    assert.equal(swarm.metrics().disabledReason, "invalid-ice-transport-policy");
    swarm.attach(hls); assert.equal(hls.config.fLoader, undefined); swarm.stop();
  }
});

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
    assert.equal(fixture.swarm.metrics().uploadRefusalDiagnostics.counters["session-allowance"], 1);
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

test("own ticket renewal preserves a live relay peer, verified media, held bytes and spent allowance", async () => {
  const verified = [], reservations = [], trace = [], announcements = [];
  let allowed = true, remoteRefreshHeld = false, releaseRemoteRefresh;
  const remoteRefresh = new Promise(resolve => { releaseRemoteRefresh = resolve; });
  const http = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); verified.push(input);
    if (input.ticket === "remote-after" && !remoteRefreshHeld) {
      remoteRefreshHeld = true;
      await remoteRefresh;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ admitted: allowed }));
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const playback = peerPlaybackOptions();
  const fixture = await linkedFixture({ ...playback.options, serve: true, ticket: "own-before", maxUploadBytesPerSession: 96,
    reannounceDebounceMs: 1, minReannounceGapMs: 0,
    reserveUploadBytes: (size) => { reservations.push(size); return true; },
    admit: async (pubkey, ticket, { signal }) => {
      const response = await fetch(`http://127.0.0.1:${http.address().port}/verify`, { method: "POST", body: JSON.stringify({ pubkey, ticket }), signal });
      return (await response.json()).admitted;
    },
  });
  try {
    const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 1, trace, "same-link")), peer = fixture.peers[0];
    peer.onPresence(({ from, payload }) => { if (from === fixture.swarm.metrics().pubkey) announcements.push(payload.ticket); });
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const loader = fixture.hls.config.fLoader, pubkey = fixture.swarm.metrics().pubkey;
    const upload = async (id) => {
      channel.receive(JSON.stringify({ t: "want", id, k: playback.key }));
      await until(() => channel.sent.some((frame) => frame.t === "eof" && frame.id === id));
      const payload = channel.sent.filter((frame) => frame instanceof Uint8Array).at(-1);
      assert.equal(createHash("sha256").update(payload).digest("hex"), createHash("sha256").update(playback.bytes).digest("hex"));
    };
    await upload(1001);
    channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    const before = fixture.swarm.metrics(), presence = before.relays.presenceSent;
    assert.equal(fixture.swarm.updateTicket("own-before"), true);
    await sleep(10); assert.equal(fixture.swarm.metrics().relays.presenceSent, presence, "same-ticket updates do not announce");
    assert.equal(fixture.swarm.updateTicket("own-after"), true);
    await until(() => announcements.includes("own-after"));
    assert.equal(fixture.swarm.metrics().peers.openPeersKnown, 0);
    const refreshedBy = Date.now() + 5_000;
    const refreshRemaining = () => { const left = refreshedBy - Date.now(); assert.ok(left > 0, "Changed-ticket admission exceeded its original 5s wait"); return left; };
    peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket: "remote-after", open: true });
    await until(() => remoteRefreshHeld && verified.some((input) => input.ticket === "remote-after"), refreshRemaining());
    const pending = fixture.swarm.metrics();
    assert.equal(pending.peers.openPeersKnown, 0, "A received HTTP request is not an accepted presence refresh");
    assert.equal(pending.peers.connected, before.peers.connected); assert.equal(pending.peers.linksOpened, before.peers.linksOpened);
    assert.equal(pending.peers.linksClosed, before.peers.linksClosed); assert.equal(channel.readyState, "open");
    assert.equal(pending.bytes.held, before.bytes.held); assert.equal(pending.bytes.uploaded, before.bytes.uploaded);
    assert.equal(pending.bytes.uploadRemaining, before.bytes.uploadRemaining); assert.deepEqual(reservations, [32]);
    releaseRemoteRefresh();
    await until(() => fixture.swarm.metrics().peers.openPeersKnown === 1, refreshRemaining());
    await upload(1002);
    assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    const after = fixture.swarm.metrics();
    assert.equal(fixture.hls.config.fLoader, loader); assert.equal(after.pubkey, pubkey);
    assert.equal(after.peers.connected, 1); assert.equal(after.peers.linksOpened, 1); assert.equal(after.peers.linksClosed, 0);
    assert.equal(channel.readyState, "open"); assert.equal(after.bytes.held, 32);
    assert.equal(after.bytes.uploaded, 64); assert.equal(after.bytes.uploadRemaining, 32);
    assert.equal(after.segments.peerFirstLoaded, 2); assert.deepEqual(reservations, [32, 32]);
    assert.equal(verified.at(-1).ticket, "remote-after", "payload access checks the renewed remote credential online");
    allowed = false; channel.receive(JSON.stringify({ t: "want", id: 1003, k: playback.key }));
    await until(() => channel.readyState === "closed");
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 64);
    fixture.swarm.stop(); assert.equal(fixture.swarm.updateTicket("late"), false);
  } finally { releaseRemoteRefresh(); await fixture.close(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
});

test("ticket updates reject unusable swarms and bounded invalid credentials", () => {
  const gated = createHlsSwarm({ ...base, relays: ["wss://relay.example"], admit: () => true });
  try {
    for (const ticket of [null, "", {}, "x".repeat(2049), "é".repeat(1025)]) assert.equal(gated.updateTicket(ticket), false);
    assert.equal(gated.updateTicket("valid"), true);
    assert.equal(createHlsSwarm({ ...base, mode: "off" }).updateTicket("valid"), false);
    assert.equal(createHlsSwarm({ ...base }).updateTicket("valid"), false);
  } finally { gated.stop(); }
});

test("active ticket refresh floods retain only the latest credential within sixteen real HTTP checks", async () => {
  const received = [], completed = [], held = new Map(); let peak = 0;
  const http = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); received.push(input);
    if (input.ticket.startsWith("old-")) {
      held.set(input.pubkey, response); peak = Math.max(peak, held.size);
      response.on("close", () => held.delete(input.pubkey));
    } else response.writeHead(200, { "content-type": "application/json" }).end('{"admitted":true}');
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  const fixture = await linkedFixture({ maxPeers: 17, serve: true, admit: async (pubkey, ticket, { signal }) => {
    const response = await fetch(`http://127.0.0.1:${http.address().port}/verify`, { method: "POST", body: JSON.stringify({ pubkey, ticket }), signal });
    const result = await response.json(); completed.push(ticket); return result.admitted;
  } });
  const extraPool = new RelayPool(fixture.pool.urls); await extraPool.connect();
  const witness = new RelaySwarmSession({ pool: extraPool, swarmId: base.swarmId }); witness.start();
  try {
    const channels = []; for (let i = 0; i < 17; i++) channels.push(await fixture.addPeer(new RecordedChannel(), i < 16 ? fixture.pool : extraPool));
    let observed = 0;
    witness.onPresence(({ payload }) => { if (payload.have.length) observed++; });
    let serial = 0;
    const announce = (peer, ticket) => peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket,
      have: [createHash("sha256").update(String(++serial)).digest("hex")] });
    const before = received.length;
    for (let i = 0; i < 16; i++) announce(fixture.peers[i], `old-${i}`);
    await until(() => held.size === 16);
    announce(fixture.peers[16], "seventeenth");
    for (let round = 0; round < 4; round++) for (let i = 0; i < 16; i++) announce(fixture.peers[i], `latest-${round}-${i}`);
    await until(() => observed === 81);
    assert.equal(received.length, before + 16, "neither same-peer floods nor a seventeenth check start extra HTTP work");
    for (const response of held.values()) response.writeHead(200, { "content-type": "application/json" }).end('{"admitted":true}');
    await until(() => completed.filter((ticket) => ticket.startsWith("latest-3-")).length === 16);
    assert.equal(received.length, before + 32); assert.equal(peak, 16);
    assert.equal(received.some(({ ticket }) => /^latest-[012]-/.test(ticket)), false);
    assert.equal(fixture.swarm.metrics().peers.connected, 17); assert.equal(fixture.swarm.metrics().peers.linksClosed, 0);
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = channels[0].sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    channels[0].receive(JSON.stringify({ t: "want", id: 2001, k: key }));
    await until(() => fixture.swarm.metrics().bytes.uploaded === 32);
    assert.equal(received.at(-1).ticket, "latest-3-0", "the old completion cannot overwrite the accepted new credential");
    announce(fixture.peers[0], "old-stop"); await until(() => held.size === 1);
    announce(fixture.peers[0], "never-after-stop"); await until(() => observed === 83);
    fixture.swarm.stop(); await until(() => held.size === 0);
    assert.equal(received.some(({ ticket }) => ticket === "never-after-stop"), false);
  } finally { witness.close(); extraPool.close(); await fixture.close(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
});

test("full outgoing dial slots skip new presence checks but admit changed active tickets and incoming offers", async () => {
  const relay = await startLocalRelay(), pool = new RelayPool([relay.url]), peers = [], checks = [];
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], maxDialsInFlight: 1, maxPeers: 4, admit: (_pubkey, ticket) => { checks.push(ticket); return true; } });
  try {
    swarm.attach({ config: { loader: Loader } }); await pool.connect(); await until(() => swarm.metrics().pubkey);
    for (let i = 0; i < 3; i++) { const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId }); peer.start(); peers.push(peer); }
    let observed = 0; peers[2].onPresence(({ from }) => { if (from !== swarm.metrics().pubkey) observed++; });
    const announce = (peer, ticket) => peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket });
    announce(peers[0], "first"); await until(() => swarm.metrics().peers.dialsStarted === 1 && checks.length === 3);
    const before = checks.length;
    announce(peers[1], "cannot-dial"); await until(() => observed === 2); await sleep(20);
    assert.equal(checks.length, before, "a spare maxPeers slot does not authorise wasted verification when outgoing slots are full");
    announce(peers[0], "renewed-active"); await until(() => checks.at(-1) === "renewed-active");
    peers[1].sendSignal(swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "incoming-with-outgoing-full", payload: { sdp: "offer", ticket: "incoming" } });
    await until(() => swarm.metrics().peers.offersAccepted === 1);
    assert.equal(checks.filter((ticket) => ticket === "incoming").length, 2);
    assert.equal(swarm.metrics().peers.dialsStarted, 1);
  } finally { swarm.stop(); for (const peer of peers) peer.close(); pool.close(); await relay.close(); }
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

test("peer eligibility distinguishes zero budget with HAVE from positive budget without HAVE, without extra work", async () => {
  const playback = peerPlaybackOptions(120);
  let keyCalls = 0, commitments = 0, admissions = 0, deliveries = 0;
  class CountedOrigin extends Loader {
    load(ctx, config, callbacks) { deliveries++; super.load(ctx, config, callbacks); }
  }
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(),
    segmentKey: () => { keyCalls++; return "/seg.ts"; },
    getCommitment: () => { commitments++; assert.fail("neither branch requests a commitment"); },
    admit: () => { admissions++; return true; },
  }, CountedOrigin);
  try {
    const peer = await fixture.addPeer();
    peer.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 11 } };
    const admissionBaseline = admissions;
    let synchronous = false;
    new fixture.hls.config.fLoader({}).load(context, {}, { onSuccess: (response) => {
      synchronous = true; assert.deepEqual(new Uint8Array(response.data), playback.bytes);
    } });
    assert.equal(synchronous, true, "zero budget preserves immediate origin fallback even with matching HAVE");
    assert.equal(keyCalls, 2, "only the existing origin claim and origin retention key computations ran");
    await until(() => fixture.swarm.metrics().segments.originLoaded === 1);
    assert.equal(fixture.swarm.metrics().bytes.held, 0, "receive-only fallback does not retain upload media");
    let trace = fixture.swarm.metrics().peerEligibilityDiagnostics;
    assert.deepEqual(trace.records.map(({ reason, matchingHave, budgetMs }) => ({ reason, matchingHave, budgetMs })),
      [{ reason: "no-budget", matchingHave: null, budgetMs: 0 }]);
    peer.receive(JSON.stringify({ t: "have", keys: [] }));
    fixture.hls.media.buffered.end = () => 15;
    await fixture.load();
    trace = fixture.swarm.metrics().peerEligibilityDiagnostics;
    assert.equal(keyCalls, 5, "positive eligibility adds only its existing key computation, not a diagnostic hash");
    assert.deepEqual(trace.records.at(-1), { atMs: trace.records.at(-1).atMs, cc: 0, level: 0,
      budgetMs: 120, reason: "no-have-no-wait", matchingHave: false,
      budgetGeometry: { source: "buffer", positionSource: "fragment", currentTime: 10, bufferedEnd: 15, playableEnd: 15, fragmentStart: null, originReserveMs: 2000 } });
    assert.equal(trace.counters["no-budget"], 1); assert.equal(trace.counters["no-have-no-wait"], 1);
    assert.equal(commitments, 0); assert.equal(admissions, admissionBaseline);
    assert.equal(deliveries, 2); assert.equal(fixture.connections.length, 1);
    assert.equal(peer.sent.filter((frame) => frame.t === "want").length, 0);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 2);
    assert.equal(fixture.swarm.metrics().segments.coordinatedWaits, 0);
    assert.equal(fixture.swarm.metrics().segments.commitmentRequests, 0);
    for (const sensitive of [context.url, playback.key, fixture.peers[0].pubkey]) assert.ok(!JSON.stringify(trace).includes(sensitive));
  } finally { await fixture.close(); }
});

test("peer eligibility geometry captures original getter order and final calculation values", async () => {
  const fixture = await linkedFixture({ ...peerPlaybackOptions(1500).options, WebSocketImpl: memoryRelaySocket(), swarmParts: true });
  try {
    const reads = [], times = [10, 10, 10, 10.25], ends = [14, 13];
    const buffered = { get length() { reads.push("length"); return 1; },
      start() { reads.push("start"); return 0; }, end() { reads.push("end"); return ends.shift(); } };
    fixture.hls.media = { get buffered() { reads.push("buffered"); return buffered; },
      get currentTime() { reads.push("time"); return times.shift(); } };
    const ctx = { ...context, frag: { ...context.frag, get start() { assert.fail("part position must short-circuit fragment getter"); } },
      part: { index: 1, get start() { reads.push("partStart"); return 12.75; } } };
    await new Promise((resolve) => new fixture.hls.config.fLoader({}).load(ctx, {}, { onSuccess: resolve }));
    assert.deepEqual(reads, ["buffered", "length", "buffered", "start", "time", "buffered", "end", "time", "partStart", "time", "buffered", "end", "time"]);
    const row = fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1);
    assert.equal(row.budgetMs, 500);
    assert.deepEqual(row.budgetGeometry, { source: "buffer", positionSource: "part", currentTime: 10.25,
      bufferedEnd: 13, playableEnd: 12.75, fragmentStart: 12.75, originReserveMs: 2000 });
    assert.equal(row.reason, "no-have-no-wait");
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 1);
    assert.equal(fixture.swarm.metrics().segments.commitmentRequests, 0);
  } finally { await fixture.close(); }
});

test("peer eligibility geometry retains signed finite positions and isolates unavailable getters", async () => {
  const fixture = await linkedFixture({ ...peerPlaybackOptions(1500).options, WebSocketImpl: memoryRelaySocket() });
  try {
    let timeReads = 0, startReads = 0;
    fixture.hls.media = { get currentTime() { timeReads++; return -5; }, buffered: { length: 1, start: () => -10, end: () => 0 } };
    const ctx = { ...context, frag: { ...context.frag, get start() { startReads++; return -1; } } };
    await new Promise((resolve) => new fixture.hls.config.fLoader({}).load(ctx, {}, { onSuccess: resolve }));
    let row = fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1);
    assert.equal(timeReads, 4); assert.equal(startReads, 1); assert.equal(row.budgetMs, 1500);
    assert.deepEqual(row.budgetGeometry, { source: "buffer", positionSource: "fragment", currentTime: -5,
      bufferedEnd: 0, playableEnd: -1, fragmentStart: -1, originReserveMs: 2000 });
    for (const start of [NaN, Infinity, "private-fragment-position"]) {
      timeReads = 0;
      const nonfinite = { ...context, frag: { ...context.frag, start } };
      await new Promise((resolve) => new fixture.hls.config.fLoader({}).load(nonfinite, {}, { onSuccess: resolve }));
      row = fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1);
      assert.equal(timeReads, 3, "nonfinite fragment start preserves the original short-circuit");
      assert.equal(row.budgetGeometry.fragmentStart, null); assert.equal(row.budgetGeometry.playableEnd, 0);
      assert.ok(!JSON.stringify(row).includes("private-fragment-position"));
    }
    fixture.hls.media = { currentTime: 0, get buffered() { throw Error("private geometry failure"); } };
    let synchronous = false;
    new fixture.hls.config.fLoader({}).load(context, {}, { onSuccess: () => { synchronous = true; } });
    assert.equal(synchronous, true, "original failing budget getter still falls back synchronously");
    row = fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1);
    assert.equal(row.reason, "no-budget"); assert.equal(row.matchingHave, null);
    assert.deepEqual(row.budgetGeometry, { source: "error", positionSource: null, currentTime: null,
      bufferedEnd: null, playableEnd: null, fragmentStart: null, originReserveMs: null });
    assert.ok(!JSON.stringify(row).includes("private geometry failure"));
  } finally { await fixture.close(); }
});

test("peer eligibility counters survive ring eviction and snapshots cannot mutate retained records", async () => {
  const playback = peerPlaybackOptions(); let keys = 0;
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(),
    segmentKey: () => { keys++; return "/seg.ts"; }, getCommitment: () => assert.fail("zero budget has no commitment"),
  });
  try {
    fixture.hls.media = { currentTime: 0, buffered: { length: 0 } };
    for (let i = 0; i < 70; i++) await fixture.load();
    assert.equal(keys, 140, "ring bookkeeping performs no additional key work");
    const snapshot = fixture.swarm.metrics().peerEligibilityDiagnostics;
    assert.equal(snapshot.capacity, 64); assert.equal(snapshot.records.length, 64); assert.equal(snapshot.dropped, 6);
    assert.equal(snapshot.counters["no-budget"], 70);
    assert.ok(snapshot.records.every((row) => row.matchingHave === null && row.budgetMs === 0 && row.budgetGeometry.source === "no-buffer"));
    snapshot.records[0].reason = "untrusted-text"; snapshot.counters["no-budget"] = 0;
    snapshot.records[0].budgetGeometry.currentTime = 999;
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.counters["no-budget"], 70);
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.records[0].reason, "no-budget");
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.records[0].budgetGeometry.currentTime, null);
    const before = fixture.swarm.metrics().peerEligibilityDiagnostics;
    fixture.swarm.stop(); assert.deepEqual(fixture.swarm.metrics().peerEligibilityDiagnostics, before);
  } finally { await fixture.close(); }
});

test("peer eligibility preserves origin errors and pending loader aborts without added commitments", async () => {
  const playback = peerPlaybackOptions(100); const error = { code: 503, text: "origin-owned-error" }; let errors = 0;
  class FailedOrigin extends Loader {
    load(ctx, _config, callbacks) { callbacks.onError(error, ctx, "origin-details"); }
  }
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(),
    getCommitment: () => assert.fail("missing HAVE cannot request commitment"),
  }, FailedOrigin);
  try {
    fixture.hls.media = { currentTime: 0, buffered: { length: 0 } };
    const frag = { ...context.frag }; Object.defineProperty(frag, "cc", { get() { throw Error("private diagnostic getter"); } });
    new fixture.hls.config.fLoader({}).load({ ...context, frag }, {}, { onError: (actual, ctx, details) => {
      errors++; assert.equal(actual, error); assert.equal(ctx.frag, frag); assert.equal(details, "origin-details");
    } });
    assert.equal(errors, 1);
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1).cc, null, "diagnostic getter failure cannot affect fallback");
    fixture.hls.media.buffered = { length: 1, start: () => 0, end: () => 5 };
    const loader = new fixture.hls.config.fLoader({}); let aborts = 0;
    loader.load(context, {}, { onAbort: (stats) => { aborts++; assert.equal(stats.aborted, true); },
      onSuccess: () => assert.fail("aborted load must not deliver"), onError: () => assert.fail("aborted load must not fallback") });
    loader.abort(); await sleep(20);
    assert.equal(aborts, 1); assert.equal(errors, 1);
    assert.equal(fixture.swarm.metrics().segments.aborted, 1);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 1);
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.counters["aborted-before-eligibility"], 1);
    assert.ok(!JSON.stringify(fixture.swarm.metrics().peerEligibilityDiagnostics).includes("private diagnostic getter"));
  } finally { await fixture.close(); }
});

test("peer eligibility observes coordination with one bounded commitment per eligible load", async (t) => {
  const playback = peerPlaybackOptions(60), requested = [];
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket() });
  const realSetTimeout = setTimeout;
  // Keep real signing/hash work, but do not make its host scheduling consume
  // this branch test's 60ms playback budget. Advance only at observed phases.
  const phase = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "expected loader phase did not occur");
      await new Promise((resolve) => realSetTimeout(resolve, 1));
    }
  };
  try {
    const peer = await fixture.addPeer(new ServingChannel(playback.bytes, 1, requested, "existing-peer"));
    peer.receive(JSON.stringify({ t: "contribution", serving: true, rendition: "main:0" }));
    let clock = performance.now();
    t.mock.method(performance, "now", () => clock);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const advance = (ms) => { clock += ms; t.mock.timers.tick(ms); };
    fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 13 } };
    const missing = fixture.load();
    await phase(() => fixture.swarm.metrics().peerEligibilityDiagnostics.counters["no-have-wait"] === 1);
    const initialGeometry = fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1).budgetGeometry;
    fixture.hls.media.currentTime = 11;
    fixture.hls.media.buffered.end = () => 50;
    advance(60);
    await missing;
    // The loader's original fallback timer can abort the pending wait at its
    // deadline; that is cancellation, not a fabricated still-missing HAVE read.
    await phase(() => {
      const counters = fixture.swarm.metrics().peerEligibilityDiagnostics.counters;
      return counters["wait-aborted"] + counters["wait-expired"] === 1;
    });
    const ended = fixture.swarm.metrics().peerEligibilityDiagnostics;
    assert.equal(ended.counters["no-have-wait"], 1);
    assert.equal(ended.counters["wait-aborted"] + ended.counters["wait-expired"], 1);
    assert.equal(ended.records.at(-1).matchingHave, null);
    assert.deepEqual(ended.records.at(-1).budgetGeometry, initialGeometry, "async outcome retains original geometry despite media changes");
    ended.records[0].budgetGeometry.currentTime = 999;
    assert.equal(ended.records.at(-1).budgetGeometry.currentTime, 10, "rows do not share mutable geometry snapshots");
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1).budgetGeometry.currentTime, 10);
    assert.equal(fixture.swarm.metrics().segments.commitmentRequests, 1, "an eligible wait owns one overlapping metadata request even when HAVE never arrives");
    assert.deepEqual(requested, []);
    const pending = fixture.load();
    await phase(() => fixture.swarm.metrics().peerEligibilityDiagnostics.counters["no-have-wait"] === 2);
    setTimeout(() => peer.receive(JSON.stringify({ t: "have", keys: [playback.key] })), 10);
    advance(10);
    await phase(() => requested.length === 1);
    advance(1);
    await phase(() => fixture.swarm.metrics().segments.peerFirstLoaded === 1);
    assert.deepEqual(new Uint8Array((await pending).data), playback.bytes);
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.counters["have-after-wait"], 1);
    const present = fixture.load();
    await phase(() => requested.length === 2);
    advance(1);
    await phase(() => fixture.swarm.metrics().segments.peerFirstLoaded === 2);
    assert.deepEqual(new Uint8Array((await present).data), playback.bytes);
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.counters["have-at-entry"], 1);
    assert.equal(fixture.swarm.metrics().segments.commitmentRequests, 3);
    assert.deepEqual(requested, ["existing-peer", "existing-peer"]);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 2);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 1);
  } finally {
    // Restore clearTimeout before stopping timers created during real setup.
    t.mock.timers.reset();
    await fixture.close();
  }
});

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
    const diagnostic = fixture.swarm.metrics().peerRequestDiagnostics;
    assert.equal(diagnostic.counters.none, 1);
    assert.equal(diagnostic.counters.payload, 2);
    assert.deepEqual(diagnostic.records.map(row => row.outcome), ["none", "payload", "payload"]);
    assert.deepEqual(diagnostic.records.map(row => row.id), [1, 2, 2], "request outcomes join the existing local connection IDs");
    for (const row of diagnostic.records) {
      assert.equal(row.cc, 0); assert.equal(row.level, 0); assert.equal(row.expectedBytes, 32);
      assert.ok(row.remainingMs > 0 && row.remainingMs <= 200);
      assert.ok(row.timeoutMs > 0 && row.timeoutMs <= row.remainingMs);
      assert.equal(row.metadataReceived, row.outcome === "payload");
      assert.equal(row.receivedBytes, row.outcome === "payload" ? 32 : 0);
    }
  } finally { await fixture.close(); }
});

test("peer request diagnostics bound and copy local records without reporting transport payload as verification", async () => {
  const playback = peerPlaybackOptions(500), trace = [];
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket() });
  try {
    const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 0, trace, "peer"));
    channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    for (let i = 0; i < 70; i++) await fixture.load();
    const snapshot = fixture.swarm.metrics().peerRequestDiagnostics;
    assert.equal(snapshot.counters.payload, 70); assert.equal(snapshot.records.length, 64); assert.equal(snapshot.dropped, 6);
    snapshot.counters.payload = 0; snapshot.records[0].outcome = "private-value";
    assert.equal(fixture.swarm.metrics().peerRequestDiagnostics.counters.payload, 70);
    assert.equal(fixture.swarm.metrics().peerRequestDiagnostics.records[0].outcome, "payload");
    const before = fixture.swarm.metrics().peerRequestDiagnostics;
    const encoded = JSON.stringify(before);
    for (const privateValue of [context.url, playback.key, fixture.peers[0].pubkey, "address-bearing-sdp", "peer"])
      assert.ok(!encoded.includes(privateValue), `diagnostics exclude ${privateValue}`);
    fixture.swarm.stop(); assert.deepEqual(fixture.swarm.metrics().peerRequestDiagnostics, before);
  } finally { await fixture.close(); }
});

test("cold peers keep enough of the original deadline to finish one verified delivery", async () => {
  const playback = peerPlaybackOptions(1500), trace = [];
  const fixture = await linkedFixture(playback.options);
  try {
    for (let i = 0; i < 3; i++) {
      const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 900, trace, `cold-${i}`));
      channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    }
    const started = performance.now(), response = await fixture.load();
    assert.deepEqual(new Uint8Array(response.data), playback.bytes);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 1);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 0);
    assert.deepEqual(trace, ["cold-0"]);
    assert.ok(performance.now() - started < 1500, "the original origin deadline is respected");
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
    assert.equal(fixture.swarm.metrics().uploadRefusalDiagnostics.counters["reservation-refused"], 1);
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
    assert.equal(fixture.swarm.metrics().uploadRefusalDiagnostics.counters.admission, 1);
  } finally { await fixture.close(); }
});

test("transport diagnostics retain bounded redacted real session phases and detach on stop", async () => {
  const fixture = await linkedFixture({ admit: () => true });
  try {
    await fixture.addPeer();
    const pc = fixture.connections[0];
    const before = fixture.swarm.metrics().transportDiagnostics;
    const events = before.records.map((r) => r.event);
    for (const event of ["created", "offer-received", "offer-admitted", "remote-installed", "local-answer", "signal-send", "channel-open"]) assert.ok(events.includes(event), event);
    assert.ok(events.indexOf("offer-received") < events.indexOf("offer-admitted"));
    assert.ok(events.indexOf("offer-admitted") < events.indexOf("remote-installed"));
    assert.ok(events.indexOf("remote-installed") < events.indexOf("local-answer"));
    assert.ok(events.indexOf("local-answer") < events.indexOf("signal-send"));
    assert.equal(before.records.find((r) => r.event === "local-answer").detail, "complete");
    assert.equal(before.records.find((r) => r.event === "local-answer").candidates, 0);
    for (let i = 0; i < 90; i++) {
      pc.iceConnectionState = i % 2 ? "checking" : "private-address-and-ticket";
      pc.dispatchEvent(new Event("iceconnectionstatechange"));
    }
    const metrics = fixture.swarm.metrics(), trace = metrics.transportDiagnostics;
    assert.equal(metrics.v, 2); assert.equal(trace.records.length, 64); assert.ok(trace.dropped > 0);
    assert.equal(trace.counters.ice.checking, 45); assert.equal(trace.counters.ice.unknown, 46);
    const text = JSON.stringify(trace);
    for (const denied of ["private-address-and-ticket", "address-bearing-sdp", "fixture-ticket", fixture.peers[0].pubkey, metrics.pubkey]) assert.ok(!text.includes(denied));
    for (const row of trace.records) {
      assert.deepEqual(Object.keys(row).sort(), ["atMs", "detail", "event", "id"]);
      assert.ok(Number.isSafeInteger(row.id) && row.id >= 0 && Number.isFinite(row.atMs) && row.atMs >= 0);
    }
    trace.records[0].detail = "mutated"; trace.counters.ice.checking = -1;
    assert.equal(fixture.swarm.metrics().transportDiagnostics.counters.ice.checking, 45);
    fixture.swarm.stop();
    const stopped = fixture.swarm.metrics().transportDiagnostics;
    assert.equal(stopped.records.at(-1).event, "link-close"); assert.equal(stopped.records.at(-1).detail, "host-stop");
    pc.iceConnectionState = "failed"; pc.dispatchEvent(new Event("iceconnectionstatechange"));
    await sleep(10);
    assert.deepEqual(fixture.swarm.metrics().transportDiagnostics, stopped, "stopped receipt remains bounded and stable");
  } finally { await fixture.close(); }
});

test("PeerLink closure distinguishes request timeout, caller abort, native and protocol failure without leaking reason", async () => {
  for (const expected of ["request-timeout", "request-abort", "native-disconnected", "channel-error", "protocol", "host"]) {
    const channel = new Channel(), pc = new PC(); let closes = 0;
    const link = new PeerLink({ pubkey: "private-peer", pc, channel, maxSegmentBytes: 1024, onClose: () => closes++ });
    if (expected === "request-timeout") assert.equal(await link.request("a".repeat(64), 5), null);
    else if (expected === "request-abort") {
      const controller = new AbortController(), pending = link.request("a".repeat(64), 2000, { signal: controller.signal });
      controller.abort(); assert.equal(await pending, null);
    } else if (expected === "native-disconnected") { pc.connectionState = "disconnected"; pc.dispatchEvent(new Event("connectionstatechange")); }
    else if (expected === "channel-error") channel.dispatchEvent(new Event("error"));
    else if (expected === "protocol") channel.receive("{private-invalid-json");
    else link.close("private-error-message");
    assert.equal(link.closeReason, expected); assert.equal(link.closed, true); assert.equal(pc.closed, true); assert.equal(closes, 1);
    link.close("request-timeout"); assert.equal(link.closeReason, expected); assert.equal(closes, 1);
  }
});

async function transportFixture({ gathering = "complete", ...options } = {}) {
  const relay = await startLocalRelay(), connections = [];
  class TracePC extends PC {
    constructor() { super(); this.iceGatheringState = gathering; connections.push(this); }
    localDescription = { sdp: "a=ice-pwd:PRIVATE\r\na=candidate:1 1 udp 1 private.local 5 typ host\r\n" };
    createDataChannel() { this.channel = new Channel(); return this.channel; }
  }
  const swarm = createHlsSwarm({ ...base, RTCPeerConnectionImpl: TracePC, relays: [relay.url], ...options });
  const pool = new RelayPool([relay.url]);
  const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId });
  try {
    swarm.attach({ config: { loader: Loader } }); await pool.connect(); peer.start(); await until(() => swarm.metrics().pubkey);
  } catch (error) { swarm.stop(); peer.close(); pool.close(); await relay.close(); throw error; }
  return { swarm, peer, connections, async close() { swarm.stop(); peer.close(); pool.close(); await relay.close(); } };
}

test("transport trace distinguishes outgoing authenticated answer, admission and installed description", async () => {
  let admitted = true;
  const f = await transportFixture({ admit: () => admitted, ticket: "own-private" });
  try {
    const offers = []; f.peer.onSignal(({ payload }) => offers.push(payload));
    f.peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: f.peer.pubkey }], ticket: "remote-private", have: [], open: true });
    await until(() => offers.some((p) => p.type === "offer"));
    const offer = offers.find((p) => p.type === "offer");
    f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "answer", transport: "webrtc", requestId: offer.requestId, payload: { sdp: "private-answer", ticket: "remote-private" } });
    await until(() => f.swarm.metrics().transportDiagnostics.counters["remote-installed"].answer === 1);
    f.connections[0].channel.dispatchEvent(new Event("open")); await until(() => f.swarm.metrics().peers.connected === 1);
    const trace = f.swarm.metrics().transportDiagnostics, rows = trace.records;
    for (const event of ["local-offer", "signal-send", "answer-received", "answer-admitted", "remote-installed", "channel-open"]) assert.ok(rows.some((r) => r.event === event));
    assert.equal(rows.find((r) => r.event === "local-offer").candidates, 1);
    assert.equal(rows.find((r) => r.event === "local-offer").candidatesCapped, false);
    assert.ok(rows.findIndex((r) => r.event === "answer-received") < rows.findIndex((r) => r.event === "answer-admitted"));
    assert.equal(new Set(rows.map((r) => r.id)).size, 1);
    for (const denied of [f.peer.pubkey, offer.requestId, "private-answer", "own-private", "remote-private", "PRIVATE", "private.local"]) assert.ok(!JSON.stringify(trace).includes(denied));
  } finally { await f.close(); }
});

test("transport trace keeps rejected admission separate from an authenticated answer and keeps existing timeout", async () => {
  let admitted = true;
  const f = await transportFixture({ admit: () => admitted, dialTimeoutMs: 500 });
  try {
    const offers = []; f.peer.onSignal(({ payload }) => offers.push(payload));
    f.peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: f.peer.pubkey }], ticket: "valid-then-revoked", have: [], open: true });
    await until(() => offers.some((p) => p.type === "offer")); admitted = false;
    f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "answer", transport: "webrtc", requestId: offers[0].requestId, payload: { sdp: "private-answer", ticket: "valid-then-revoked" } });
    await until(() => f.swarm.metrics().peers.dialsFailed === 1);
    const trace = f.swarm.metrics().transportDiagnostics;
    assert.equal(trace.counters["answer-received"].authenticated, 1);
    assert.equal(trace.counters["answer-admitted"].accepted, 0);
    assert.equal(trace.counters["remote-installed"].answer, 0);
    assert.equal(trace.records.at(-1).detail, "admission");
  } finally { await f.close(); }
  const timeout = await transportFixture({ dialTimeoutMs: 100 });
  try {
    timeout.peer.sendSignal(timeout.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "timeout-test", payload: { sdp: "private-offer" } });
    await until(() => timeout.swarm.metrics().peers.dialsTimedOut === 1);
    assert.equal(timeout.swarm.metrics().transportDiagnostics.records.at(-1).detail, "timeout");
  } finally { await timeout.close(); }
});

test("gather cap and lifecycle abort are observed without extending the native1200ms envelope", async () => {
  for (const abort of [false, true]) {
    const f = await transportFixture({ gathering: "gathering" });
    try {
      f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "gather-test", payload: { sdp: "private-offer" } });
      await until(() => f.connections.length === 1); await sleep(20);
      if (abort) f.swarm.stop();
      await until(() => f.swarm.metrics().transportDiagnostics.records.some((r) => r.event === "local-answer"));
      const trace = f.swarm.metrics().transportDiagnostics, local = trace.records.find((r) => r.event === "local-answer"), created = trace.records.find((r) => r.event === "created");
      assert.equal(local.detail, abort ? "aborted" : "capped");
      if (!abort) assert.ok(local.atMs - created.atMs >= 1100 && local.atMs - created.atMs < 3000);
      if (abort) { assert.equal(trace.counters["signal-send"].answer, 0); assert.equal(trace.records.at(-1).detail, "host-stop"); }
    } finally { await f.close(); }
  }
});

test("diagnostic getters cannot add errors after abort or during native state events", async () => {
  const f = await transportFixture({ gathering: "gathering" });
  try {
    f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "getter-test", payload: { sdp: "private-offer" } });
    await until(() => f.connections.length === 1); await sleep(20);
    const pc = f.connections[0], before = f.swarm.metrics().errors.total;
    Object.defineProperty(pc, "iceConnectionState", { get() { throw Error("private-native-getter"); } });
    pc.dispatchEvent(new Event("iceconnectionstatechange"));
    Object.defineProperty(pc, "localDescription", { get() { throw Error("private-closed-description"); } });
    f.swarm.stop(); await sleep(10);
    const m = f.swarm.metrics(); assert.equal(m.errors.total, before);
    assert.ok(m.transportDiagnostics.records.some((r) => r.event === "local-answer" && r.detail === "aborted" && !("candidates" in r)));
    assert.equal(m.transportDiagnostics.records.at(-1).detail, "host-stop");
    assert.ok(!JSON.stringify(m.transportDiagnostics).includes("private-"));
  } finally { await f.close(); }
});

test("upload drain diagnostics preserve rejection then microtask close ordering", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const channel = new Channel(); channel.bufferedAmount = 2_000_000;
  const link = new PeerLink({ pubkey: "peer", pc: new PC(), channel, maxSegmentBytes: 1024, drainTimeoutMs: 20, onRequest: () => new Uint8Array(32) });
  try {
    channel.receive(JSON.stringify({ t: "want", id: 1, k: "a".repeat(64) }));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    t.mock.timers.tick(20);
    assert.equal(link.closed, false, "the timer only rejects; serving.catch still owns closure");
    for (let i = 0; i < 6; i++) await Promise.resolve();
    assert.equal(link.closed, true); assert.equal(link.closeReason, "upload-drain-timeout");
  } finally { link.close(); t.mock.timers.reset(); }
});

test("superseded pending connections retain a distinct local ID and remove native diagnostics", async () => {
  const f = await transportFixture();
  try {
    const offer = (requestId) => f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId, payload: { sdp: "private-offer" } });
    offer("first-private-request"); await until(() => f.swarm.metrics().peers.offersAccepted === 1);
    offer("second-private-request"); await until(() => f.swarm.metrics().peers.offersAccepted === 2);
    const before = f.swarm.metrics().transportDiagnostics;
    assert.equal(before.counters["dial-end"].superseded, 1);
    assert.deepEqual(before.records.filter((r) => r.event === "created").map((r) => r.id), [1, 2]);
    assert.equal(f.swarm.metrics().peers.dialsFailed, 0);
    f.connections[0].iceConnectionState = "failed"; f.connections[0].dispatchEvent(new Event("iceconnectionstatechange"));
    assert.deepEqual(f.swarm.metrics().transportDiagnostics, before);
  } finally { await f.close(); }
});

test("a throwing gathering getter at the cap cannot prevent original wait completion", async () => {
  const f = await transportFixture({ gathering: "gathering" });
  try {
    f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "capped-getter-test", payload: { sdp: "private-offer" } });
    await until(() => f.connections.length === 1); await sleep(20);
    Object.defineProperty(f.connections[0], "iceGatheringState", { get() { throw Error("private-gathering-getter"); } });
    await until(() => f.swarm.metrics().peers.offersAccepted === 1);
    const metrics = f.swarm.metrics(), local = metrics.transportDiagnostics.records.find((r) => r.event === "local-answer");
    assert.equal(local.detail, "unknown"); assert.equal(metrics.errors.total, 0);
    assert.equal(metrics.transportDiagnostics.counters["signal-send"].answer, 1);
    assert.ok(!JSON.stringify(metrics.transportDiagnostics).includes("private-gathering-getter"));
  } finally { await f.close(); }
});

test("pending upload reservations never enter public metrics or a synchronous stop archive", async () => {
  for (const outcome of ["refused", "stop-refused", "stop-late-accepted", "throw"]) {
    let settle, fail, archived;
    const fixture = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve: true, maxUploadBytesPerSession: 64,
      reserveUploadBytes: () => new Promise((resolve, reject) => { settle = resolve; fail = reject; }),
    });
    try {
      const peer = await fixture.addPeer(); await fixture.load();
      await until(() => fixture.swarm.metrics().bytes.held === 32);
      const key = peer.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
      peer.receive(JSON.stringify({ t: "want", id: 1, k: key }));
      await until(() => settle);
      assert.equal(fixture.swarm.metrics().bytes.uploaded, 0, outcome);
      assert.equal(fixture.swarm.metrics().bytes.uploadsServed, 0);
      assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, 32, "pending reservation consumes capacity before yielding");
      assert.equal(peer.sent.filter((frame) => frame.t === "meta").length, 0);
      // Model the host revoking/archive-taking within the still-pending callback.
      archived = fixture.swarm.metrics();
      if (outcome.startsWith("stop")) fixture.swarm.stop();
      if (outcome === "throw") fail(new Error("fixture reservation error"));
      else settle(outcome === "stop-late-accepted");
      await until(() => fixture.swarm.metrics().bytes.uploadsRefused === 1);
      assert.equal(archived.bytes.uploaded, 0);
      assert.equal(fixture.swarm.metrics().bytes.uploaded, 0);
      assert.equal(fixture.swarm.metrics().bytes.uploadsServed, 0);
      assert.equal(peer.sent.filter((frame) => frame.t === "meta" || frame.t === "eof").length, 0);
      if (!outcome.startsWith("stop")) assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, 64, "refusal releases only the internal provisional debit");
    } finally { await fixture.close(); }
  }
});

test("accepted reservation on a closed link remains charged without becoming an uploaded payload", async () => {
  let settle;
  const fixture = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve: true, maxUploadBytesPerSession: 64,
    reserveUploadBytes: () => new Promise((resolve) => { settle = resolve; }),
  });
  try {
    const peer = await fixture.addPeer(); await fixture.load();
    await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = peer.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    peer.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => settle); peer.close(); settle(true);
    await until(() => fixture.swarm.metrics().bytes.uploadsRefused === 1);
    const snapshot = fixture.swarm.metrics();
    assert.equal(snapshot.bytes.uploaded, 0); assert.equal(snapshot.bytes.uploadsServed, 0);
    assert.equal(snapshot.bytes.uploadRemaining, 32, "accepted host reservation is never refunded after the link closes");
    assert.equal(peer.sent.filter((frame) => frame.t === "meta" || frame.t === "eof").length, 0);
    fixture.swarm.stop(); assert.equal(fixture.swarm.metrics().bytes.uploaded, snapshot.bytes.uploaded);
  } finally { await fixture.close(); }
});

test("concurrent pending uploads exhaust internal capacity without publishing provisional bytes", async () => {
  const pending = [];
  const fixture = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve: true, maxUploadBytesPerSession: 64,
    reserveUploadBytes: (size) => new Promise((resolve) => pending.push({ size, resolve })),
  });
  try {
    const peers = [await fixture.addPeer(), await fixture.addPeer(), await fixture.addPeer()];
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = peers[0].sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    peers.forEach((peer, index) => peer.receive(JSON.stringify({ t: "want", id: index + 1, k: key })));
    await until(() => pending.length === 2 && peers[2].sent.some((frame) => frame.t === "none"));
    assert.deepEqual(pending.map(({ size }) => size), [32, 32]);
    const before = fixture.swarm.metrics();
    assert.equal(before.bytes.uploaded, 0); assert.equal(before.bytes.uploadsServed, 0);
    assert.equal(before.bytes.uploadRemaining, 0); assert.equal(before.serving, false);
    assert.equal(peers.flatMap((peer) => peer.sent).filter((frame) => frame.t === "meta").length, 0);
    pending[0].resolve(true);
    await until(() => peers[0].sent.some((frame) => frame.t === "eof"));
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 32);
    assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, 0, "other pending bytes still consume capacity");
    pending[1].resolve(true);
    await until(() => peers[1].sent.some((frame) => frame.t === "eof"));
    const after = fixture.swarm.metrics();
    assert.equal(after.bytes.uploaded, 64); assert.equal(after.bytes.uploadsServed, 2);
    assert.equal(after.bytes.uploadsRefused, 1); assert.equal(after.bytes.uploadRemaining, 0);
    assert.equal(peers.flatMap((peer) => peer.sent).filter((frame) => frame instanceof Uint8Array).reduce((sum, bytes) => sum + bytes.byteLength, 0), 64);
    assert.equal(before.bytes.uploaded, 0, "previous metric snapshots remain stable");
    fixture.swarm.stop(); assert.equal(fixture.swarm.metrics().bytes.uploaded, 64);
  } finally { for (const { resolve } of pending) resolve(false); await fixture.close(); }
});

test("refused upload callbacks do not refund rate tokens when public counters stay zero", async (t) => {
  let clock = 0, calls = 0, settle;
  t.mock.method(performance, "now", () => clock);
  const fixture = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve: true, maxUploadBytesPerSession: 64, maxUploadBytesPerSecond: 32,
    reserveUploadBytes: () => { calls++; return new Promise((resolve) => { settle = resolve; }); },
  });
  try {
    const peer = await fixture.addPeer(); await fixture.load();
    await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = peer.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    peer.receive(JSON.stringify({ t: "want", id: 1, k: key })); await until(() => settle);
    settle(false); await until(() => peer.sent.some((frame) => frame.t === "none" && frame.id === 1));
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 0); assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, 64);
    peer.receive(JSON.stringify({ t: "want", id: 2, k: key }));
    await until(() => peer.sent.some((frame) => frame.t === "none" && frame.id === 2));
    assert.equal(calls, 1, "a refused reservation does not restore token-bucket capacity");
    clock = 1000;
    peer.receive(JSON.stringify({ t: "want", id: 3, k: key })); await until(() => calls === 2); settle(true);
    await until(() => peer.sent.some((frame) => frame.t === "eof" && frame.id === 3));
    assert.equal(fixture.swarm.metrics().bytes.uploaded, 32); assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, 32);
  } finally { await fixture.close(); }
});

test("a stopped swarm retains an already accepted charge without committing public upload metrics", async () => {
  let archive;
  const fixture = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve: true, maxUploadBytesPerSession: 64,
    reserveUploadBytes: () => {
      // The bounded callback settles true first, then stop precedes its caller's
      // continuation. This exercises the accepted-but-no-longer-live branch.
      queueMicrotask(() => queueMicrotask(() => { archive = fixture.swarm.metrics(); fixture.swarm.stop(); }));
      return true;
    },
  });
  try {
    const peer = await fixture.addPeer(); await fixture.load();
    await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = peer.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    peer.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => fixture.swarm.metrics().bytes.uploadsRefused === 1);
    assert.equal(archive.bytes.uploaded, 0); assert.equal(fixture.swarm.metrics().bytes.uploaded, 0);
    assert.equal(fixture.swarm.metrics().bytes.uploadRemaining, 32);
    assert.equal(peer.sent.filter((frame) => frame.t === "meta" || frame.t === "eof").length, 0);
  } finally { await fixture.close(); }
});


// Native signalling state is deliberately strict here. The older PC stub is
// useful for loader tests but cannot establish rollback or mutation ordering.
const glareFlush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function glareDeferred() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
class GlareChannel extends EventTarget {
  readyState = "connecting";
  bufferedAmount = 0;
  sent = [];
  openCallbacks = [];
  addEventListener(type, callback, options) { if (type === "open") this.openCallbacks.push(callback); super.addEventListener(type, callback, options); }
  send(value) { assert.equal(this.readyState, "open"); this.sent.push(value); }
  close() { if (this.readyState === "closed") return; this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
}
async function glareFixture(t, { polite = true, hold, gathering = false, rollbackSupported = true, timeout = 12000 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const secretKeys = [1, 2].map(value => { const key = new Uint8Array(32); key[31] = value; return key; })
    .sort((a, b) => getPublicKey(a) < getPublicKey(b) ? -1 : 1);
  const secretKey = secretKeys[polite ? 1 : 0], remoteKey = secretKeys[polite ? 0 : 1];
  const connections = [], received = [], gates = new Map();
  if (hold) gates.set(hold, glareDeferred());
  const state = { allow: true, onNative: () => {}, checks: [] };
  class StatefulPC extends EventTarget {
    signalingState = "stable";
    connectionState = "new";
    iceConnectionState = "new";
    iceGatheringState = gathering ? "gathering" : "complete";
    localDescription = null;
    remoteDescription = null;
    trace = [];
    closes = 0;
    busy = 0;
    constructor() { super(); connections.push(this); }
    async native(name, operation) {
      this.trace.push(name); assert.equal(++this.busy, 1, "Native negotiation operations must never overlap");
      try {
        await gates.get(name)?.promise;
        assert.notEqual(this.signalingState, "closed", "A completed native operation cannot mutate a closed PC");
        const result = operation(); state.onNative(name, this); return result;
      } finally { this.busy--; }
    }
    createDataChannel() { assert.equal(this.signalingState, "stable"); this.localChannel = new GlareChannel(); return this.localChannel; }
    createOffer() { return this.native("createOffer", () => { assert.equal(this.signalingState, "stable"); return { type: "offer", sdp: "native-local-offer" }; }); }
    createAnswer() { return this.native("createAnswer", () => { assert.equal(this.signalingState, "have-remote-offer"); return { type: "answer", sdp: "native-local-answer" }; }); }
    setLocalDescription(description) {
      return this.native(`local:${description.type}`, () => {
        if (description.type === "rollback") { assert.ok(rollbackSupported, "Native rollback unavailable"); assert.equal(this.signalingState, "have-local-offer"); this.signalingState = "stable"; this.localDescription = null; }
        else if (description.type === "offer") { assert.equal(this.signalingState, "stable"); this.signalingState = "have-local-offer"; this.localDescription = description; }
        else { assert.equal(description.type, "answer"); assert.equal(this.signalingState, "have-remote-offer"); this.signalingState = "stable"; this.localDescription = description; this.iceGatheringState = "complete"; }
      });
    }
    setRemoteDescription(description) {
      return this.native(`remote:${description.type}`, () => {
        assert.equal(this.signalingState, description.type === "offer" ? "stable" : "have-local-offer");
        this.signalingState = description.type === "offer" ? "have-remote-offer" : "stable";
        this.remoteDescription = description;
      });
    }
    incoming(channel = new GlareChannel()) { const event = new Event("datachannel"); event.channel = channel; this.dispatchEvent(event); return channel; }
    close() { this.closes++; this.signalingState = "closed"; this.connectionState = "closed"; }
    async getStats() { return new Map(); }
  }
  const Socket = memoryRelaySocket(), relayURL = "wss://glare-memory.example";
  const pool = new RelayPool([relayURL], { WebSocketImpl: Socket });
  await pool.connect();
  const peer = new RelaySwarmSession({ pool, swarmId: base.swarmId, secretKey: remoteKey }); peer.start();
  peer.onSignal(({ payload }) => received.push(payload));
  const swarm = createHlsSwarm({ ...base, secretKey, WebSocketImpl: Socket, RTCPeerConnectionImpl: StatefulPC,
    relays: [relayURL], maxPeers: 1, maxDialsInFlight: 1, dialTimeoutMs: timeout, ticket: "local-ticket", maxRetriesPerPeer: 0,
    admit(_pubkey, ticket) { state.checks.push(ticket); connections[0]?.trace.push(`admit:${ticket}`); return state.admit ? state.admit(ticket) : state.allow; } });
  swarm.attach({ config: { loader: Loader } });
  await glareFlush(); assert.equal(swarm.metrics().pubkey, getPublicKey(secretKey));
  const signal = (type, requestId, sdp = `native-remote-${type}`, ticket = "remote-ticket") => peer.sendSignal(swarm.metrics().pubkey,
    { type, transport: "webrtc", requestId, payload: { sdp, ticket } });
  const offer = (requestId = "winning-offer", ticket) => signal("offer", requestId, "native-remote-offer", ticket);
  const start = async () => {
    peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket: "remote-ticket" });
    await glareFlush(); t.mock.timers.tick(1500); await glareFlush();
    assert.equal(connections.length, 1); assert.equal(swarm.metrics().peers.dialling, 1);
    return connections[0];
  };
  t.after(async () => {
    swarm.stop(); for (const gate of gates.values()) gate.release(); await glareFlush();
    peer.close(); pool.close(); t.mock.timers.reset();
  });
  return { swarm, peer, state, connections, received, signal, offer, start,
    release(name) { gates.get(name)?.release(); }, async tick(ms) { t.mock.timers.tick(ms); await glareFlush(); } };
}

test("polite glare reuses the pending PC and original slot with one winning channel and request ID", async t => {
  const f = await glareFixture(t), pc = await f.start();
  const outgoing = f.received.find(value => value.type === "offer"); assert.ok(outgoing);
  const abandoned = pc.localChannel, staleOpen = abandoned.openCallbacks[0];
  f.offer(); await glareFlush();
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 0); assert.equal(abandoned.readyState, "closed");
  assert.deepEqual(pc.trace.filter(value => !value.startsWith("admit:")), ["createOffer", "local:offer", "local:rollback", "remote:offer", "createAnswer", "local:answer"]);
  assert.deepEqual(f.received.filter(value => value.type === "answer").map(value => value.requestId), ["winning-offer"]);
  f.signal("answer", outgoing.requestId); staleOpen(); await glareFlush();
  assert.equal(pc.trace.filter(value => value === "remote:answer").length, 0); assert.equal(pc.closes, 0);
  const channel = pc.incoming(); channel.open(); await glareFlush();
  assert.equal(f.swarm.metrics().peers.connected, 1); assert.equal(f.swarm.metrics().peers.linksOpened, 1);
  const acceptedCallback = channel.openCallbacks[0]; acceptedCallback(); staleOpen(); await glareFlush();
  assert.equal(channel.readyState, "open"); assert.equal(pc.closes, 0);
  const extra = pc.incoming(); await glareFlush();
  assert.equal(extra.readyState, "closed"); assert.equal(f.swarm.metrics().peers.linksOpened, 1);
  f.swarm.stop(); assert.equal(pc.closes, 1); assert.equal(channel.readyState, "closed");
});

test("impolite glare keeps the lower-key offer and waits for its admitted answer before accepting a channel", async t => {
  const f = await glareFixture(t, { polite: false }), pc = await f.start();
  const outgoing = f.received.find(value => value.type === "offer"); assert.ok(outgoing);
  f.offer(); pc.localChannel.open(); await glareFlush();
  assert.equal(f.swarm.metrics().peers.connected, 0); assert.equal(pc.closes, 0);
  assert.equal(pc.trace.includes("local:rollback"), false); assert.equal(f.received.some(value => value.type === "answer"), false);
  f.signal("answer", outgoing.requestId); f.signal("answer", outgoing.requestId); await glareFlush();
  assert.equal(f.connections.length, 1); assert.equal(f.swarm.metrics().peers.connected, 1);
  assert.equal(pc.trace.filter(value => value === "remote:answer").length, 1);
});

for (const phase of ["createOffer", "local:offer", "gather"]) test(`polite glare fences an abandoned ${phase} continuation without overlapping native mutations`, async t => {
  const f = await glareFixture(t, { hold: phase === "gather" ? undefined : phase, gathering: phase === "gather" }), pc = await f.start();
  f.offer(); await glareFlush();
  if (phase !== "gather") {
    assert.equal(pc.trace.includes("remote:offer"), false, "The winning offer waits for the in-flight native call");
    f.release(phase); await glareFlush();
  }
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 0);
  assert.equal(f.received.filter(value => value.type === "offer").length, 0, "The abandoned outgoing offer must not be published");
  assert.equal(f.received.filter(value => value.type === "answer").length, 1);
  assert.equal(pc.trace.filter(value => value === "local:rollback").length, phase === "createOffer" ? 0 : 1);
  assert.equal(f.swarm.metrics().transportDiagnostics.counters["local-offer"].aborted, 0, "Superseded gathering must not be mislabelled on the adopted PC");
});

test("glare and same-request replays cannot reset the original absolute dial timeout", async t => {
  const f = await glareFixture(t, { timeout: 100 }), pc = await f.start();
  await f.tick(70); f.offer(); await glareFlush();
  const before = [...pc.trace]; f.offer(); f.offer(); await glareFlush();
  assert.deepEqual(pc.trace.filter(value => !value.startsWith("admit:")), before.filter(value => !value.startsWith("admit:")));
  assert.equal(f.connections.length, 1); await f.tick(29); assert.equal(pc.closes, 0);
  await f.tick(1); assert.equal(pc.closes, 1); assert.equal(f.swarm.metrics().peers.dialsTimedOut, 1);
  f.offer(); await glareFlush(); assert.equal(f.connections.length, 1, "A recently admitted request cannot allocate again after timeout");
});

test("incoming distinct requests retain supersession while duplicate or superseded request IDs do not allocate", async t => {
  const f = await glareFixture(t);
  f.offer("first-incoming"); await glareFlush(); assert.equal(f.connections.length, 1);
  f.offer("first-incoming"); await glareFlush(); assert.equal(f.connections.length, 1);
  f.offer("second-incoming"); await glareFlush(); assert.equal(f.connections.length, 2);
  assert.equal(f.connections[0].closes, 1); assert.equal(f.connections[1].closes, 0);
  f.offer("first-incoming"); await glareFlush(); assert.equal(f.connections.length, 2);
  assert.equal(f.swarm.metrics().transportDiagnostics.counters["dial-end"].superseded, 1);
});

test("settled incoming offer replay avoids another admission callback or native mutation", async t => {
  const f = await glareFixture(t);
  f.offer("settled-private-request"); await glareFlush();
  assert.equal(f.swarm.metrics().peers.offersAccepted, 1);
  const checks = f.state.checks.length, trace = [...f.connections[0].trace], replies = [...f.received];
  // A fresh encrypted event carrying the same request must be dropped even
  // after its original admission promise has settled.
  f.state.allow = false;
  f.offer("settled-private-request"); await glareFlush();
  assert.equal(f.state.checks.length, checks, "a settled replay must not call the host again");
  assert.deepEqual(f.connections[0].trace, trace);
  assert.deepEqual(f.received, replies);
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].closes, 0);
});

test("admission callsite diagnostics count coalesced callbacks and return copied redacted counters", async t => {
  const f = await glareFixture(t), pending = glareDeferred();
  f.state.admit = () => pending.promise;
  t.after(() => pending.release(true));
  f.offer("coalesced-private-request"); f.offer("coalesced-private-request"); await glareFlush();
  assert.equal(f.state.checks.length, 1);
  assert.equal(f.connections.length, 0);
  assert.equal(f.swarm.metrics().admissionDiagnostics.calls.offerIncoming, 1);
  pending.release(true); await glareFlush();
  assert.equal(f.swarm.metrics().peers.offersAccepted, 1, "post-await replay guard must still select one offer");
  assert.equal(f.connections.length, 1);
  const calls = f.swarm.metrics().admissionDiagnostics.calls;
  assert.equal(calls.offerIncoming, 1); assert.equal(calls.answerBeforeSend, 1);
  assert.deepEqual(Object.keys(calls), ["presence", "dialStart", "offerBeforeSend", "offerIncoming", "answerIncoming", "glareBeforeRollback", "glareAfterRollback", "answerBeforeSend", "upload", "refresh", "other"]);
  assert.equal(Object.values(calls).reduce((a, b) => a + b, 0), f.state.checks.length);
  assert.ok(Object.values(calls).every(value => Number.isSafeInteger(value) && value >= 0));
  for (const secret of [f.peer.pubkey, "coalesced-private-request", "remote-ticket", "local-ticket", "native-remote-offer"]) assert.ok(!JSON.stringify(calls).includes(secret));
  calls.offerIncoming = Number.MAX_SAFE_INTEGER; calls.extra = "private";
  assert.equal(f.swarm.metrics().admissionDiagnostics.calls.offerIncoming, 1);
  assert.equal(Object.keys(f.swarm.metrics().admissionDiagnostics.calls).length, 11);
});

test("admission callsite diagnostics retain refusal and fresh admission for an unseen request", async t => {
  const f = await glareFixture(t);
  f.state.allow = false; f.offer("previously-refused"); await glareFlush();
  assert.equal(f.state.checks.length, 1); assert.equal(f.connections.length, 0); assert.equal(f.received.length, 0);
  assert.equal(f.swarm.metrics().admissionDiagnostics.calls.offerIncoming, 1);
  f.state.allow = true; f.offer("previously-refused"); await glareFlush();
  assert.equal(f.connections.length, 1); assert.equal(f.swarm.metrics().peers.offersAccepted, 1);
  assert.equal(f.swarm.metrics().admissionDiagnostics.calls.offerIncoming, 2);
  assert.equal(f.swarm.metrics().admissionDiagnostics.calls.answerBeforeSend, 1);
});

test("admission callsite diagnostics preserve stop and post-await replay guards", async t => {
  const f = await glareFixture(t), pending = glareDeferred();
  f.state.admit = () => pending.promise; t.after(() => pending.release(true));
  f.offer("late-private-request"); f.offer("late-private-request"); await glareFlush();
  assert.equal(f.state.checks.length, 1);
  f.swarm.stop(); pending.release(true); await glareFlush();
  assert.equal(f.connections.length, 0); assert.equal(f.received.length, 0);
  const calls = f.swarm.metrics().admissionDiagnostics.calls;
  assert.equal(calls.offerIncoming, 1); assert.equal(calls.answerBeforeSend, 0);
  f.offer("after-stop"); await glareFlush();
  assert.deepEqual(f.swarm.metrics().admissionDiagnostics.calls, calls);
});

test("admission callsite diagnostics distinguish each outgoing and glare authority boundary", async t => {
  const f = await glareFixture(t); await f.start();
  assert.deepEqual(Object.entries(f.swarm.metrics().admissionDiagnostics.calls).filter(([, count]) => count), [["presence", 1], ["dialStart", 1], ["offerBeforeSend", 1]]);
  f.offer(); await glareFlush();
  const calls = f.swarm.metrics().admissionDiagnostics.calls;
  for (const site of ["presence", "dialStart", "offerBeforeSend", "offerIncoming", "glareBeforeRollback", "glareAfterRollback", "answerBeforeSend"]) assert.equal(calls[site], 1, site);
  assert.equal(Object.values(calls).reduce((a, b) => a + b, 0), f.state.checks.length);
  assert.equal(calls.answerIncoming, 0); assert.equal(calls.upload, 0);
});

test("admission callsite diagnostics count the incoming answer before native installation", async t => {
  const f = await glareFixture(t, { polite: false }), pc = await f.start();
  const outgoing = f.received.find(value => value.type === "offer");
  f.state.allow = false; f.signal("answer", outgoing.requestId); await glareFlush();
  assert.equal(f.swarm.metrics().admissionDiagnostics.calls.answerIncoming, 1);
  assert.equal(pc.trace.includes("remote:answer"), false); assert.equal(pc.closes, 1);
});

test("admission callsite diagnostics count fresh upload checks without granting revoked bytes", async () => {
  let allowed = true, checks = 0;
  const f = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve: true, admit: () => { checks++; return allowed; } });
  try {
    const channel = await f.addPeer(); await f.load();
    await until(() => f.swarm.metrics().bytes.held === 32);
    const key = channel.sent.find(frame => frame.t === "have" && frame.add?.length).add[0];
    allowed = false; channel.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => channel.readyState === "closed");
    const calls = f.swarm.metrics().admissionDiagnostics.calls;
    assert.equal(calls.upload, 1); assert.equal(calls.offerIncoming, 1); assert.equal(calls.answerBeforeSend, 1);
    assert.equal(Object.values(calls).reduce((a, b) => a + b, 0), checks);
    assert.equal(f.swarm.metrics().bytes.uploaded, 0);
    assert.equal(channel.sent.filter(frame => frame.t === "meta" || frame.t === "eof").length, 0);
  } finally { await f.close(); }
});

for (const phase of ["createOffer", "local:offer", "local:rollback", "remote:offer"]) test(`stop fences a late ${phase} completion after glare and closes its PC once`, async t => {
  const f = await glareFixture(t, { hold: phase }), pc = await f.start();
  f.offer(); await glareFlush(); f.swarm.stop(); f.release(phase); await glareFlush();
  assert.equal(pc.closes, 1); assert.equal(f.connections.length, 1);
  assert.equal(f.swarm.metrics().peers.connected, 0); assert.equal(f.swarm.metrics().peers.dialling, 0);
  assert.equal(f.received.filter(value => value.type === "answer").length, 0);
  assert.equal(f.swarm.metrics().errors.total, 0, "An abandoned native rejection must not fail another generation");
});

test("glare admission is rechecked before remote SDP and before publishing the winning answer", async t => {
  const f = await glareFixture(t), pc = await f.start();
  f.state.allow = false; f.offer("accepted-then-revoked"); await glareFlush();
  assert.equal(pc.trace.includes("remote:offer"), false); assert.equal(pc.localChannel.readyState, "connecting");
  f.state.allow = true;
  f.state.onNative = (name, connection) => { if (name === "local:answer") { connection.incoming().open(); f.state.allow = false; } };
  f.offer("accepted-then-revoked"); await glareFlush();
  assert.equal(pc.trace.includes("remote:offer"), true); assert.equal(pc.trace.includes("local:answer"), true);
  assert.equal(f.received.filter(value => value.type === "answer").length, 0);
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 1); assert.equal(f.swarm.metrics().peers.connected, 0);
  assert.equal(f.swarm.metrics().transportDiagnostics.counters["dial-end"].admission, 1);
});

test("unsupported rollback fails closed without replacement allocation or an accepted link", async t => {
  const f = await glareFixture(t, { rollbackSupported: false }), pc = await f.start();
  f.offer(); await glareFlush();
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 1);
  assert.equal(f.swarm.metrics().peers.dialsFailed, 1); assert.equal(f.swarm.metrics().peers.connected, 0);
  assert.equal(f.received.filter(value => value.type === "answer").length, 0);
});


for (const polite of [false, true]) test(`same-ID simultaneous offers still use the key tie-break (${polite ? "polite" : "impolite"})`, async t => {
  const f = await glareFixture(t, { polite }), pc = await f.start();
  const ownOffer = f.received.find(value => value.type === "offer"); assert.ok(ownOffer);
  f.offer(ownOffer.requestId); await glareFlush();
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 0);
  assert.equal(pc.trace.includes("local:rollback"), polite);
  assert.equal(f.received.filter(value => value.type === "answer").length, polite ? 1 : 0);
  if (polite) assert.equal(f.received.find(value => value.type === "answer").requestId, ownOffer.requestId);
});

test("queued glare cannot use admission revoked while the original native mutation was pending", async t => {
  const f = await glareFixture(t, { hold: "local:offer" }), pc = await f.start();
  f.offer(); await glareFlush(); assert.equal(pc.trace.includes("remote:offer"), false);
  const admittedAtReceipt = f.state.checks.length; f.state.allow = false;
  f.release("local:offer"); await glareFlush();
  assert.ok(f.state.checks.length > admittedAtReceipt, "Queued mutation needs a fresh online check");
  assert.equal(pc.trace.includes("local:rollback"), false); assert.equal(pc.trace.includes("remote:offer"), false);
  assert.equal(pc.closes, 1); assert.equal(f.connections.length, 1);
  assert.equal(f.swarm.metrics().transportDiagnostics.counters["dial-end"].admission, 1);
});

for (const state of ["connected", "failed", "closed", "disconnected", "unknown"]) test(`glare never reuses a transport whose native connection state is ${state}`, async t => {
  const f = await glareFixture(t), pc = await f.start();
  pc.connectionState = state; f.offer(); await glareFlush();
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 1);
  assert.equal(pc.trace.includes("remote:offer"), false); assert.equal(pc.trace.includes("local:rollback"), false);
});

test("a queued native connection becoming established cannot be adopted after its call settles", async t => {
  const f = await glareFixture(t, { hold: "local:offer" }), pc = await f.start();
  f.offer(); await glareFlush(); pc.connectionState = "connected";
  f.release("local:offer"); await glareFlush();
  assert.equal(pc.closes, 1); assert.equal(pc.trace.includes("remote:offer"), false);
  assert.equal(f.connections.length, 1); assert.equal(f.swarm.metrics().peers.connected, 0);
});


test("a transport becoming established during rollback is not reused for remote SDP", async t => {
  const f = await glareFixture(t, { hold: "local:rollback" }), pc = await f.start();
  f.offer(); await glareFlush(); assert.ok(pc.trace.includes("local:rollback"));
  pc.connectionState = "connected"; f.release("local:rollback"); await glareFlush();
  assert.equal(pc.trace.includes("remote:offer"), false); assert.equal(pc.closes, 1);
  assert.equal(f.connections.length, 1); assert.equal(f.swarm.metrics().peers.connected, 0);
});

for (const signalingState of [undefined, "have-remote-pranswer", "have-local-pranswer"]) test(`glare refuses unsupported signalling state ${String(signalingState)}`, async t => {
  const f = await glareFixture(t), pc = await f.start(); pc.signalingState = signalingState;
  f.offer(); await glareFlush();
  assert.equal(pc.trace.includes("local:rollback"), false); assert.equal(pc.trace.includes("remote:offer"), false);
  assert.equal(pc.closes, 1); assert.equal(f.connections.length, 1);
});


test("glare rechecks revocation after a held rollback before installing remote SDP", async t => {
  const f = await glareFixture(t, { hold: "local:rollback" }), pc = await f.start();
  f.offer(); await glareFlush(); assert.ok(pc.trace.includes("local:rollback"));
  const admittedBeforeRollback = f.state.checks.length;
  f.state.allow = false; f.release("local:rollback"); await glareFlush();
  assert.ok(f.state.checks.length > admittedBeforeRollback, "A completed rollback cannot retain earlier authority");
  assert.equal(pc.trace.includes("remote:offer"), false);
  assert.equal(f.received.filter(value => value.type === "answer").length, 0);
  assert.equal(f.swarm.metrics().peers.connected, 0); assert.equal(f.swarm.metrics().peers.dialling, 0);
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 1);
  assert.equal(f.swarm.metrics().transportDiagnostics.counters["dial-end"].admission, 1);
});


test("full idle neighbourhood discovers an admitted requested-rendition seeder without a seventh live PC", async t => {
  const playback = peerPlaybackOptions(300), outgoing = [], trace = [], admission = [];
  t.mock.method(PC.prototype, 'createDataChannel', function () {
    const channel = new ServingChannel(playback.bytes, 0, trace, 'discovered-seeder');
    outgoing.push(channel); return channel;
  });
  const f = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(), ticket: 'own-ticket',
    admit: async (_key, ticket) => { admission.push(ticket); return ticket === 'fixture-ticket'; },
    minLinkLifeMs: 1, idleEvictMs: 1, evictionCooldownMs: 1,
  });
  try {
    const idle = [];
    for (let i = 0; i < 6; i++) idle.push(await f.addPeer());
    await sleep(10);
    assert.equal(f.swarm.metrics().peers.connected, 6);
    // The existing loader computes this exact missing key at positive budget.
    await f.load();
    const candidate = new RelaySwarmSession({ pool: f.pool, swarmId: base.swarmId }); candidate.start(); f.peers.push(candidate);
    const offers = [];
    candidate.onSignal(({ payload }) => {
      if (payload.type !== 'offer') return;
      offers.push(payload);
      candidate.sendSignal(f.swarm.metrics().pubkey, { type: 'answer', transport: 'webrtc', requestId: payload.requestId,
        payload: { sdp: 'fixture-answer', ticket: 'fixture-ticket' } });
    });
    candidate.announcePresence({ role: 'viewer', transports: [{ type: 'webrtc', publicKey: candidate.pubkey }],
      have: [playback.key], open: true, ticket: 'fixture-ticket' });
    await until(() => offers.length === 1, 2500);
    await until(() => f.swarm.metrics().peers.linksOpened === 7);
    assert.equal(idle.filter(channel => channel.readyState === 'closed').length, 1, 'only one old idle victim is replaced');
    assert.equal(f.connections.filter(pc => !pc.closed).length, 6, 'replacement never retains a seventh native connection');
    assert.equal(f.peakLiveConnections, 6, 'the native allocation itself respects the cap');
    assert.equal(offers[0].payload.peers, 5, 'actual remaining peer count is disclosed truthfully');
    assert(admission.every(ticket => ticket === 'fixture-ticket'));
    assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 1, 'PC-open earns no replacement budget');
    outgoing.at(-1).receive(JSON.stringify({ t: 'have', keys: [playback.key] }));
    await sleep(10);
    assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 1, 'HAVE earns no replacement budget');
    await f.load();
    assert.equal(f.swarm.metrics().segments.peerFirstLoaded, 1, 'a later ordinary load verifies the advertised media under its original deadline');
    assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 0, 'accepted verified delivery ends this exact unmet episode');
    assert.deepEqual(trace, ['discovered-seeder']);
  } finally { await f.close(); }
});

test("saturated requested-rendition repair replaces one idle link at each admitted endpoint", { timeout: 5_000 }, async t => {
  const playback = peerPlaybackOptions(300), WebSocketImpl = memoryRelaySocket();
  playback.bytes = new Uint8Array(210_000).fill(9);
  const signed = signedFixture({ key: playback.key, size: playback.bytes.byteLength,
    sha256: createHash("sha256").update(playback.bytes).digest("hex") });
  Object.assign(playback.options, { streamEvent: signed.options.streamEvent, getCommitment: () => signed.event });
  class PayloadLoader extends Loader {
    load(context, _config, callbacks) { callbacks.onSuccess({ data: playback.bytes.slice().buffer }, this.stats, context, null); }
  }
  class PairedChannel extends RecordedChannel {
    send(data) {
      super.send(data);
      const copy = typeof data === "string" ? data : data.slice().buffer;
      queueMicrotask(() => { if (this.readyState === "open" && this.other.readyState === "open") this.other.receive(copy); });
    }
    close() { if (this.readyState === "closed") return; super.close(); this.other.close(); }
  }
  const requesterChannel = new PairedChannel(), targetChannel = new PairedChannel();
  requesterChannel.other = targetChannel; targetChannel.other = requesterChannel;
  let outgoingChannels = 0;
  t.mock.method(PC.prototype, "createDataChannel", () => {
    assert.equal(++outgoingChannels, 1, "only the actual repair creates an outgoing channel");
    return requesterChannel;
  });
  const requesterSecret = generateSecretKey(), targetSecret = generateSecretKey();
  const requesterKey = getPublicKey(requesterSecret), targetKey = getPublicKey(targetSecret);
  const realNow = Date.now; let age = 0, repair = false;
  t.mock.method(Date, "now", () => realNow() + age);
  let requester, target, targetSignals, requesterSignals;
  try {
    requester = await linkedFixture({ ...playback.options, WebSocketImpl, maxPeers: 4,
      secretKey: requesterSecret, ticket: "requester-ticket",
      admit: (key, ticket) => ticket === "fixture-ticket" || repair && key === targetKey && ticket === "target-ticket" }, PayloadLoader);
    target = await linkedFixture({ ...playback.options, WebSocketImpl, maxPeers: 4, serve: true,
      secretKey: targetSecret, ticket: "target-ticket",
      admit: (key, ticket) => ticket === "fixture-ticket" || repair && key === requesterKey && ticket === "requester-ticket" }, PayloadLoader);
    const requesterChannels = [], targetChannels = [];
    for (let i = 0; i < 4; i++) {
      requesterChannels.push(await requester.addPeer());
      targetChannels.push(await target.addPeer());
    }
    // Three useful sibling-audio links must survive a missing-main repair.
    await new Promise(resolve => new requester.hls.config.fLoader({}).load({ ...context,
      url: "https://origin.example/audio.ts", frag: { ...context.frag, type: "audio" } }, {}, { onSuccess: resolve }));
    for (const channel of requesterChannels.slice(0, 3)) channel.receive(JSON.stringify({
      t: "contribution", serving: true, rendition: "audio:0",
    }));
    await target.load(); await until(() => target.swarm.metrics().bytes.held === playback.bytes.byteLength);
    assert(targetChannels.every(channel => channel.sent.some(frame => frame.t === "have" && frame.add?.includes(playback.key))));
    assert.equal(target.swarm.metrics().serving, true);
    // Age real links past the unchanged 15s minimum-life and 20s idle guards;
    // the audio hints remain within their original 30s freshness window.
    age = 21_001;
    await requester.load();
    assert.equal(requester.swarm.metrics().peers.connected, 4);
    assert.equal(target.swarm.metrics().peers.connected, 4);
    repair = true;
    // Observe the genuine encrypted offer to the real target swarm, rather
    // than replacing that saturated target with an always-answering peer.
    targetSignals = new RelaySwarmSession({ pool: target.pool, swarmId: base.swarmId, secretKey: targetSecret });
    targetSignals.start(); const offers = [];
    targetSignals.onSignal(({ from, payload }) => { if (from === requesterKey && payload.type === "offer") offers.push(payload); });
    targetSignals.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: targetKey }],
      have: [playback.key], open: true, ticket: "target-ticket" });
    await until(() => offers.length === 1 && (target.swarm.metrics().peers.offersRefused > 0
      || target.swarm.metrics().peers.offersAccepted > 4));
    assert.equal(requester.swarm.metrics().peers.evicted, 1);
    assert(requesterChannels.slice(0, 3).every(channel => channel.readyState === "open"), "useful audio siblings are protected");
    assert.equal(requesterChannels[3].readyState, "closed", "only the requester's idle main victim is replaced");
    assert.equal(offers[0].payload.peers, 3, "the repair never claims the requester is peerless");
    assert.equal(target.swarm.metrics().peers.evicted, 1,
      "a serving saturated target holding the exact requested key must permit the same bounded idle replacement");
    assert.equal(offers[0].payload.requestedKey, playback.key, "only this actual discovery key is advised");
    const incoming = new Event("datachannel"); incoming.channel = targetChannel;
    target.connections[4].dispatchEvent(incoming);
    await until(() => requester.swarm.metrics().peers.connected === 4 && target.swarm.metrics().peers.connected === 4);
    assert.equal(targetChannels.filter(channel => channel.readyState === "closed").length, 1);
    assert.equal(requester.peakLiveConnections, 4); assert.equal(target.peakLiveConnections, 4);
    assert.equal(requester.swarm.metrics().segments.peerFirstLoaded, 0, "opening a link is not verified media delivery");
    const beforeDelivery = requester.swarm.metrics(), beforeUpload = target.swarm.metrics();
    const response = await requester.load();
    assert.deepEqual(new Uint8Array(response.data), playback.bytes, "the real serving swarm supplies the signed object's bytes");
    const delivered = requester.swarm.metrics(), uploaded = target.swarm.metrics();
    assert.equal(delivered.segments.peerFirstLoaded - beforeDelivery.segments.peerFirstLoaded, 1);
    assert.equal(delivered.segments.originFallbacks, beforeDelivery.segments.originFallbacks, "the repaired load adds no origin fallback");
    assert.equal(delivered.bytes.fromPeers - beforeDelivery.bytes.fromPeers, playback.bytes.byteLength);
    assert.equal(uploaded.bytes.uploaded - beforeUpload.bytes.uploaded, playback.bytes.byteLength);
    assert.equal(uploaded.bytes.uploadsServed - beforeUpload.bytes.uploadsServed, 1);
    assert.equal(uploaded.admissionDiagnostics.calls.upload - beforeUpload.admissionDiagnostics.calls.upload, 1);
    assert.equal(delivered.serving, false); assert.equal(delivered.bytes.uploaded, 0, "receive-only consent remains unchanged");
    assert.equal(delivered.peers.evicted, 1); assert.equal(uploaded.peers.evicted, 1);
    assert.equal(requester.peakLiveConnections, 4); assert.equal(target.peakLiveConnections, 4);
    assert.deepEqual(requesterChannel.sent.filter(frame => frame.t === "want").map(frame => frame.k), [playback.key]);
    assert.equal(targetChannel.sent.filter(frame => frame.t === "meta").length, 1);
    assert.equal(targetChannel.sent.filter(frame => frame.t === "eof").length, 1);
    const payload = delivered.peerRequestDiagnostics.records.at(-1);
    assert.equal(payload.outcome, "payload"); assert.equal(payload.receivedBytes, playback.bytes.byteLength);
    assert.equal(payload.expectedBytes, playback.bytes.byteLength);
    const checks = target.swarm.metrics().admissionDiagnostics.calls.offerIncoming;
    requesterSignals = new RelaySwarmSession({ pool: requester.pool, swarmId: base.swarmId, secretKey: requesterSecret });
    requesterSignals.start(); requesterSignals.sendSignal(targetKey, offers[0]);
    await sleep(20);
    assert.equal(target.swarm.metrics().admissionDiagnostics.calls.offerIncoming, checks, "replay cannot reacquire admission authority");
    assert.equal(target.swarm.metrics().peers.evicted, 1); assert.equal(target.connections.length, 5);
  } finally {
    targetSignals?.close(); requesterSignals?.close();
    await Promise.all([requester?.close(), target?.close()]);
  }
});

test("saturated requested-rendition repair refuses invalid advice and rechecks serving after admission", { timeout: 5_000 }, async t => {
  const playback = peerPlaybackOptions(300), realNow = Date.now;
  let age = 0, pendingAdmission = false, release;
  t.mock.method(Date, "now", () => realNow() + age);
  const admission = new Promise(resolve => { release = resolve; });
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"), connection = { type: "wifi" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection } });
  let target, sender;
  try {
    target = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(), maxPeers: 4, serve: true,
      ticket: "target-ticket", admit: (_key, ticket) => {
        if (ticket === "held-admission") { pendingAdmission = true; return admission; }
        return ticket === "fixture-ticket";
      } });
    const channels = [];
    for (let i = 0; i < 4; i++) channels.push(await target.addPeer());
    await target.load(); await until(() => target.swarm.metrics().bytes.held === playback.bytes.byteLength);
    age = 21_001;
    sender = new RelaySwarmSession({ pool: target.pool, swarmId: base.swarmId }); sender.start();
    const offer = (requestId, requestedKey, ticket = "fixture-ticket") => sender.sendSignal(target.swarm.metrics().pubkey, {
      type: "offer", transport: "webrtc", requestId, payload: { sdp: "fixture-offer", peers: 3, requestedKey, ticket },
    });
    const unchanged = () => {
      assert.equal(target.swarm.metrics().peers.evicted, 0); assert.equal(target.swarm.metrics().peers.connected, 4);
      assert.equal(target.connections.length, 4); assert.equal(target.peakLiveConnections, 4);
      assert(channels.every(channel => channel.readyState === "open"));
    };
    // Missing advice retains the legacy nonzero-peer refusal; neither malformed
    // values nor another valid hash may promote it to a held-object repair.
    const unheld = (playback.key[0] === "0" ? "1" : "0") + playback.key.slice(1);
    for (const [index, key] of [undefined, 7, playback.key.toUpperCase(), unheld].entries()) {
      const refused = target.swarm.metrics().peers.offersRefused;
      offer(`invalid-repair-${index}`, key);
      await until(() => target.swarm.metrics().peers.offersRefused === refused + 1); unchanged();
    }
    connection.type = "cellular";
    assert.equal(target.swarm.metrics().serving, false);
    let refused = target.swarm.metrics().peers.offersRefused;
    offer("not-serving-repair", playback.key);
    await until(() => target.swarm.metrics().peers.offersRefused === refused + 1); unchanged();
    connection.type = "wifi";
    assert.equal(target.swarm.metrics().serving, true);
    refused = target.swarm.metrics().peers.offersRefused;
    offer("serving-withdrawn-during-admission", playback.key, "held-admission");
    await until(() => pendingAdmission);
    unchanged(); connection.type = "cellular"; release(true);
    await until(() => target.swarm.metrics().peers.offersRefused === refused + 1);
    assert.equal(target.swarm.metrics().bytes.held, playback.bytes.byteLength, "the exact key remains held, so serving revocation is the discriminator");
    assert.equal(target.swarm.metrics().serving, false); unchanged();
  } finally {
    release(false); sender?.close();
    try { await target?.close(); } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else delete globalThis.navigator;
    }
  }
});

function advisoryFixture() {
  let at = 100_000;
  const state = new NeighbourDiscovery(() => at), key = "a".repeat(64), pubkey = "b".repeat(64);
  const context = state.demand("main", "main:0", key);
  state.hint(pubkey, [key], "fixture-ticket");
  const begin = () => state.begin(state.choose(() => true, () => true, false));
  return { state, key, pubkey, context, begin, advance(ms) { at += ms; } };
}

test("neighbour discovery isolates main/audio generations and bounds untrusted hints and demanded keys", () => {
  const f = advisoryFixture(), { state } = f;
  const main = f.context, audio = state.demand("audio", "audio:0", "c".repeat(64)), attempt = f.begin();
  for (let i = 1; i <= 6; i++) {
    state.demand("main", "main:0", i.toString(16).repeat(64));
    state.demand("audio", "audio:0", (i + 6).toString(16).repeat(64));
  }
  assert.equal(state.valid(attempt), true, "alternating audio requests do not invalidate the main intent");
  assert.equal(state.contexts.get("main"), main); assert.equal(state.contexts.get("audio"), audio);
  assert.equal(state.snapshot().requestedKeys, 4); assert(main.keys.includes(f.key), "a pending exact key stays pinned");
  state.context("audio", "audio:1"); assert.equal(state.valid(attempt), true);
  state.context("main", "main:1"); assert.equal(state.valid(attempt), false);
  for (let i = 0; i < 80; i++) state.hint(i.toString(16).padStart(64, "0"), Array.from({ length: 20 }, (_, n) => n.toString(16).padStart(64, "0")), { large: "untrusted" });
  assert.equal(state.candidates.size, 64);
  assert([...state.candidates.values()].every(value => value.have.length === 8 && value.ticket === null));
  assert.equal(state.snapshot().contexts, 2);
});

test("neighbour opportunity expiry is hard, nonrenewable and releases every reserved slot without clearing spent episodes", () => {
  const peers = [advisoryFixture(), advisoryFixture()];
  for (const f of peers) {
    const attempt = f.begin(); assert(f.state.replaced(attempt, "c".repeat(64)));
    f.state.allocated(attempt, {}); f.state.failed(attempt.dial);
    assert.equal(f.state.reserved(), true);
    for (let i = 0; i < 14; i++) { f.advance(1000); f.state.demand("main", "main:0", f.key); }
    assert.equal(f.state.snapshot().remainingMs, 1000);
    f.advance(1000); f.state.demand("main", "main:0", f.key);
    assert.equal(f.state.reserved(), false); assert.equal(f.state.suppresses("c".repeat(64)), false);
    assert.equal(f.state.valid(attempt), false); f.state.end();
    assert.equal(f.state.choose(() => true, () => true, false), null, "a refilled full neighbourhood cannot force another replacement");
    assert.equal(f.state.snapshot().replacementSpent, 1);
    f.advance(30_001); f.state.demand("main", "main:0", "d".repeat(64));
    assert.deepEqual(f.context.keys, ["d".repeat(64)], "inactivity clears stale keys before resuming");
    assert.equal(f.context.spent, true, "inactivity does not renew the eviction budget");
  }
});

test("neighbour success requires the exact selected generation and cannot credit a sibling or A-to-B-to-A result", () => {
  const f = advisoryFixture(), attempt = f.begin(); f.state.replaced(attempt, "c".repeat(64));
  const audio = f.state.demand("audio", "audio:0", "d".repeat(64));
  assert.equal(f.state.verified(audio), true); assert.equal(f.context.spent, true);
  f.state.context("main", "main:1"); const newMain = f.state.demand("main", "main:0", f.key); newMain.spent = true;
  assert.equal(f.state.verified(f.context), false); assert.equal(newMain.spent, true);
  assert.equal(f.state.verified(newMain), true); assert.equal(newMain.spent, false);
});

test("neighbour clock rollback invalidates intent and never reports more than its original fifteen seconds", () => {
  const f = advisoryFixture(), attempt = f.begin(); f.state.replaced(attempt, "c".repeat(64));
  f.advance(-1);
  assert.equal(f.state.valid(attempt), false); assert.equal(f.state.reserved(), false);
  assert.equal(f.state.suppresses("c".repeat(64)), false); assert.equal(f.state.snapshot().remainingMs, 0);
});

test("neighbour advancing clock cannot extend the opportunity past creation plus fifteen seconds", () => {
  let at = 100_000; const state = new NeighbourDiscovery(() => at++), key = "a".repeat(64);
  state.demand("main", "main:0", key); state.hint("b".repeat(64), [key], "fixture-ticket");
  const attempt = state.begin(state.choose(() => true, () => true, false));
  assert.equal(attempt.window.expiresAt - attempt.window.createdAt, 15_000);
});

test("neighbour zero-budget activity cannot revive a stale positive-budget key", () => {
  const f = advisoryFixture(); f.context.spent = true;
  for (let i = 0; i < 4; i++) { f.advance(10_000); f.state.context("main", "main:0"); }
  f.state.demand("main", "main:0", "e".repeat(64));
  assert.deepEqual(f.context.keys, ["e".repeat(64)]); assert.equal(f.context.spent, true);
});

async function discoveryFixture({ admit = async () => true, candidateSecretKey, ...options } = {}) {
  const playback = peerPlaybackOptions(100), state = { candidate: null, checks: 0 };
  const f = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(), ticket: "own-ticket",
    admit: (pubkey, ticket, extra) => { if (pubkey === state.candidate) state.checks++; return admit(pubkey, ticket, extra); },
    minLinkLifeMs: 1, idleEvictMs: 1, evictionCooldownMs: 1, ...options });
  const channels = [];
  for (let i = 0; i < 6; i++) channels.push(await f.addPeer());
  await sleep(10); await f.load();
  const candidate = new RelaySwarmSession({ pool: f.pool, swarmId: base.swarmId, ...(candidateSecretKey ? { secretKey: candidateSecretKey } : {}) });
  candidate.start(); f.peers.push(candidate); state.candidate = candidate.pubkey;
  const offers = []; candidate.onSignal(({ payload }) => { if (payload.type === "offer") offers.push(payload); });
  const announce = (have = [playback.key], ticket = "fixture-ticket") => candidate.announcePresence({ role: "viewer",
    transports: [{ type: "webrtc", publicKey: candidate.pubkey }], have, open: true, ticket });
  const signal = (peer, type, requestId, extra = {}) => peer.sendSignal(f.swarm.metrics().pubkey,
    { type, transport: "webrtc", requestId, payload: { ticket: "fixture-ticket", ...extra } });
  return { ...f, get peakLiveConnections() { return f.peakLiveConnections; }, channels, playback, candidate, state, offers, announce, signal };
}

for (const change of ["main-zero-budget", "withdrawal", "new-ticket", "expiry", "useful-neighbours", "revoked", "stop"]) test(`neighbour admission rechecks ${change} before evicting or disclosing SDP`, async t => {
  let release, candidate;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await discoveryFixture({ admit: pubkey => pubkey === candidate ? gate : true }); candidate = f.candidate.pubkey;
  try {
    f.announce(); await until(() => f.state.checks > 0);
    if (change === "main-zero-budget") {
      let haveChecks = 0; const valid = NeighbourDiscovery.prototype.valid;
      t.mock.method(NeighbourDiscovery.prototype, "valid", function (...args) { haveChecks++; return valid.apply(this, args); });
      f.hls.media = { currentTime: 0, buffered: { length: 0 } };
      let completed = false;
      new f.hls.config.fLoader({}).load({ ...context, frag: { ...context.frag, level: 1 } }, {}, { onSuccess() { completed = true; } });
      assert.equal(completed, true); assert.equal(haveChecks, 0, "zero-budget selection invalidation does not inspect candidate HAVE");
    } else if (change === "withdrawal") f.announce([]);
    else if (change === "new-ticket") f.announce([f.playback.key], "replacement-ticket");
    else if (change === "expiry") {
      const original = Date.now; t.mock.method(Date, "now", () => original() + 15_001);
      f.hls.media = { currentTime: 0, buffered: { length: 0 } }; await f.load();
    } else if (change === "useful-neighbours") {
      for (const channel of f.channels) channel.receive(JSON.stringify({ t: "have", keys: [f.playback.key] }));
    } else if (change === "stop") f.swarm.stop();
    if (change === "withdrawal" || change === "new-ticket") await sleep(20);
    release(change !== "revoked"); await sleep(40);
    assert.equal(f.connections.length, 6); assert.equal(f.swarm.metrics().peers.evicted, 0); assert.equal(f.offers.length, 0);
    assert(f.peakLiveConnections <= 6);
  } finally { release(false); await f.close(); }
});

test("neighbour admission rechecks concurrent incoming occupancy and the shared rotation budget", async () => {
  let release, candidate; const gate = new Promise(resolve => { release = resolve; });
  const f = await discoveryFixture({ evictionCooldownMs: 10_000, admit: pubkey => pubkey === candidate ? gate : true }); candidate = f.candidate.pubkey;
  try {
    f.announce(); await until(() => f.state.checks > 0);
    const newcomer = new RelaySwarmSession({ pool: f.pool, swarmId: base.swarmId }); newcomer.start(); f.peers.push(newcomer);
    f.signal(newcomer, "offer", "concurrent-peerless", { sdp: "fixture-offer", peers: 0 });
    await until(() => f.connections.length === 7);
    release(true); await sleep(40);
    assert.equal(f.connections.length, 7); assert.equal(f.swarm.metrics().peers.evicted, 1); assert.equal(f.offers.length, 0);
    assert.equal(f.peakLiveConnections, 6);
  } finally { release(false); await f.close(); }
});

test("neighbour admission cannot evict links with active outbound reservations", async () => {
  let release, releaseUploads, candidate, uploads = 0;
  const admission = new Promise(resolve => { release = resolve; }), reservations = new Promise(resolve => { releaseUploads = resolve; });
  const f = await discoveryFixture({ serve: true, maxUploadPeers: 6,
    reserveUploadBytes: () => { uploads++; return reservations; }, admit: pubkey => pubkey === candidate ? admission : true }); candidate = f.candidate.pubkey;
  try {
    f.announce(); await until(() => f.state.checks > 0);
    for (const channel of f.channels) channel.receive(JSON.stringify({ t: "want", id: 1, k: f.playback.key }));
    await until(() => uploads === 6);
    release(true); await sleep(40);
    assert.equal(f.connections.length, 6); assert.equal(f.swarm.metrics().peers.evicted, 0); assert.equal(f.offers.length, 0);
    assert.equal(f.peakLiveConnections, 6);
  } finally { release(false); releaseUploads(false); await f.close(); }
});

test("neighbour pending main admission survives actual sibling audio loads and an audio selection change", async () => {
  let release, candidate; const gate = new Promise(resolve => { release = resolve; });
  const f = await discoveryFixture({ admit: pubkey => pubkey === candidate ? gate : true }); candidate = f.candidate.pubkey;
  try {
    f.announce(); await until(() => f.state.checks > 0);
    for (const level of [0, 1]) await new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context,
      frag: { ...context.frag, type: "audio", level } }, {}, { onSuccess: resolve }));
    assert.equal(f.swarm.metrics().neighbourDiscovery.contexts, 2);
    release(true); await until(() => f.offers.length === 1);
    assert.equal(f.swarm.metrics().peers.evicted, 1); assert.equal(f.peakLiveConnections, 6);
  } finally { release(false); await f.close(); }
});

test("neighbour full refusal reserves once, suppresses its victim, and restores ordinary incoming at the hard deadline", async t => {
  const f = await discoveryFixture({ retryFloorMs: 10_000, retryCeilingMs: 10_000 });
  try {
    f.candidate.onSignal(({ payload }) => { if (payload.type === "offer") f.signal(f.candidate, "reject", payload.requestId, { retryAfterMs: 10_000 }); });
    f.announce(); await until(() => f.swarm.metrics().neighbourDiscovery.vacancyReserved);
    const victimIndex = f.connections.findIndex(pc => pc.closed), victim = f.peers[victimIndex];
    assert(victimIndex >= 0); assert.equal(f.swarm.metrics().peers.evicted, 1);
    f.signal(victim, "offer", "victim-before-expiry", { sdp: "fixture-offer", peers: 0 });
    victim.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: victim.pubkey }], have: [f.playback.key], ticket: "fixture-ticket" });
    await sleep(30); assert.equal(f.connections.length, 7); assert.equal(f.swarm.metrics().peers.evicted, 1);
    // Same actual requested rendition keeps arriving; it cannot renew the window.
    await f.load(); const original = Date.now; t.mock.method(Date, "now", () => original() + 15_001);
    f.signal(victim, "offer", "victim-after-expiry", { sdp: "fixture-offer", peers: 0 });
    await until(() => f.connections.length === 8);
    assert.equal(f.swarm.metrics().neighbourDiscovery.vacancyReserved, false);
    assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 1);
    for (let i = 0; i < 3; i++) { await f.load(); f.announce(); }
    await sleep(30); assert.equal(f.swarm.metrics().peers.evicted, 1); assert.equal(f.peakLiveConnections, 6);
  } finally { await f.close(); }
});

test("neighbour remote becoming available retries its existing vacancy without another victim", async t => {
  t.mock.method(Math, "random", () => 0);
  const f = await discoveryFixture({ retryFloorMs: 20, retryCeilingMs: 20 });
  try {
    f.candidate.onSignal(({ payload }) => {
      if (payload.type !== "offer") return;
      f.signal(f.candidate, f.offers.length === 1 ? "reject" : "answer", payload.requestId,
        f.offers.length === 1 ? { retryAfterMs: 20 } : { sdp: "fixture-answer" });
    });
    f.announce(); await until(() => f.swarm.metrics().peers.linksOpened === 7);
    assert.equal(f.offers.length, 2); assert.equal(f.swarm.metrics().peers.evicted, 1);
    assert.equal(f.peakLiveConnections, 6); assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 1, "PC-open alone does not earn another eviction");
  } finally { await f.close(); }
});

test("neighbour asynchronous segment keys cannot restore an old actual quality selection", async t => {
  let release, keyCalls = 0; const gate = new Promise(resolve => { release = resolve; });
  const playback = peerPlaybackOptions(300);
  const f = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket() });
  const digest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  let hold = true;
  t.mock.method(globalThis.crypto.subtle, "digest", (...args) => {
    if (hold) { hold = false; keyCalls++; return gate.then(() => digest(...args)); }
    return digest(...args);
  });
  try {
    const pending = f.load(); await until(() => keyCalls > 0);
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    await new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context, frag: { ...context.frag, level: 1 } }, {}, { onSuccess: resolve }));
    release(); await pending; await sleep(20);
    assert.equal(f.swarm.metrics().neighbourDiscovery.requestedKeys, 0, "late old key does not restore old context demand");
    assert.equal(f.swarm.metrics().neighbourDiscovery.counters.checks, 0);
  } finally { release(); await f.close(); }
});

test("neighbour expiry cannot retire an incoming glare generation adopted from its pending outgoing PC", async t => {
  const keys = [1, 2].map(n => { const key = new Uint8Array(32); key[31] = n; return key; })
    .sort((a, b) => getPublicKey(a) < getPublicKey(b) ? -1 : 1);
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.mock.method(PC.prototype, "createOffer", () => gate);
  const f = await discoveryFixture({ secretKey: keys[1], candidateSecretKey: keys[0] });
  try {
    f.announce(); await until(() => f.connections.length === 7);
    const pc = f.connections.at(-1); Object.assign(pc, { connectionState: "new", iceConnectionState: "new", signalingState: "stable" });
    f.signal(f.candidate, "offer", "adopted-incoming", { sdp: "fixture-offer", peers: 5 });
    await until(() => !f.swarm.metrics().neighbourDiscovery.opportunityActive);
    release({ type: "offer", sdp: "fixture-offer" });
    await until(() => f.swarm.metrics().peers.offersAccepted === 7);
    const incoming = new RecordedChannel(), event = new Event("datachannel"); event.channel = incoming; pc.dispatchEvent(event);
    await until(() => f.swarm.metrics().peers.linksOpened === 7);
    const original = Date.now; t.mock.method(Date, "now", () => original() + 15_001);
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    await new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context, frag: { ...context.frag, level: 1 } }, {}, { onSuccess: resolve }));
    assert.equal(pc.closed, undefined); assert.equal(incoming.readyState, "open");
    assert.equal(f.offers.length, 0, "retired outgoing native completion discloses no stale SDP");
    assert.equal(f.peakLiveConnections, 6);
  } finally { release({ type: "offer", sdp: "fixture-offer" }); await f.close(); }
});

test("neighbour aborted peer payload cannot reset the spent episode", async t => {
  const playback = peerPlaybackOptions(300), trace = [], channels = [];
  t.mock.method(PC.prototype, "createDataChannel", () => {
    const channel = new ServingChannel(playback.bytes, 60, trace, "aborted"); channels.push(channel); return channel;
  });
  const f = await discoveryFixture();
  try {
    f.candidate.onSignal(({ payload }) => { if (payload.type === "offer") f.signal(f.candidate, "answer", payload.requestId, { sdp: "fixture-answer" }); });
    f.announce(); await until(() => f.swarm.metrics().peers.linksOpened === 7);
    channels.at(-1).receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    const loader = new f.hls.config.fLoader({}); let successes = 0, aborts = 0;
    loader.load(context, {}, { onSuccess() { successes++; }, onAbort() { aborts++; } });
    await until(() => trace.length === 1); loader.abort(); await sleep(80);
    assert.equal(successes, 0); assert.equal(aborts, 1); assert.equal(f.swarm.metrics().segments.peerFirstLoaded, 0);
    assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 1);
  } finally { await f.close(); }
});


// One signed HIGH-sized payload; only event ordering and the clock are controlled.
async function overlapControlledFixture(t, { expiresAt, wrongRendition = false, extraPeers = 0 } = {}) {
  const realTimer = setTimeout, realNow = performance.now.bind(performance);
  const bytes = new Uint8Array(670000).fill(9);
  const key = createHash("sha256").update(`${base.swarmId}\n/seg.ts`).digest("hex");
  const signed = signedFixture({ key, rendition: wrongRendition ? "0" : "1", size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"), ...(expiresAt === undefined ? {} : { expiresAt }) });
  let resolveMetadata, rejectMetadata, metadataSignal, metadataCalls = 0;
  const metadata = new Promise((resolve, reject) => { resolveMetadata = resolve; rejectMetadata = reject; });
  const fixture = await linkedFixture({ mode: "peer-first", streamEvent: signed.options.streamEvent,
    WebSocketImpl: memoryRelaySocket(), originFallbackMs: 1500,
    getCommitment: (_context, { signal }) => { metadataCalls++; metadataSignal = signal; return metadata; } });
  let performanceMock, timersMocked = false;
  const restoreTimers = () => { if (timersMocked) { t.mock.timers.reset(); timersMocked = false; } };
  try {
  const peer = await fixture.addPeer(new RecordedChannel());
  const otherPeers = [];
  for (let i = 0; i < extraPeers; i++) otherPeers.push(await fixture.addPeer(new RecordedChannel()));
  peer.receive(JSON.stringify({ t: "contribution", serving: true, rendition: "main:1" }));
  fixture.hls.media = { currentTime: 0, buffered: { length: 1, start: () => 0, end: () => 5 } };
  let clock = realNow();
  performanceMock = t.mock.method(performance, "now", () => clock);
  t.mock.timers.enable({ apis: ["setTimeout"] }); timersMocked = true;
  const phase = async predicate => {
    const end = realNow() + 3000;
    while (!predicate()) { assert(realNow() < end, "expected controlled overlap phase"); await new Promise(resolve => realTimer(resolve, 1)); }
  };
  const advance = ms => { clock += ms; if (timersMocked) t.mock.timers.tick(ms); };
  const wants = () => peer.sent.filter(frame => frame?.t === "want");
  const callbacks = { success: 0, abort: 0, error: 0 };
  let result;
  const pending = new Promise(resolve => {
    const loader = new fixture.hls.config.fLoader({}); result = { loader };
    loader.load({ ...context, frag: { ...context.frag, level: 1, type: "main" } }, {}, {
      onSuccess: response => { callbacks.success++; resolve(response); },
      onAbort: () => { callbacks.abort++; resolve(null); },
      onError: () => { callbacks.error++; resolve(null); },
    });
  });
  const deliver = (payload = bytes) => {
    const request = wants().at(-1); assert(request);
    peer.receive(JSON.stringify({ t: "meta", id: request.id, size: bytes.byteLength }));
    for (let offset = 0; offset < payload.byteLength; offset += 16384) peer.receive(payload.slice(offset, offset + 16384).buffer);
    peer.receive(JSON.stringify({ t: "eof", id: request.id }));
  };
  const stop = () => { restoreTimers(); fixture.swarm.stop(); };
  const close = async () => { restoreTimers(); performanceMock.mock.restore(); await fixture.close(); };
  return { fixture, peer, otherPeers, signed, bytes, key, phase, advance, wants, callbacks, pending, loader: result.loader,
    metadataCalls: () => metadataCalls, metadataSignal: () => metadataSignal,
    resolveMetadata: event => resolveMetadata(event ?? signed.event), rejectMetadata, deliver, stop, close };
  } catch (error) {
    restoreTimers(); performanceMock?.mock.restore(); await fixture.close(); throw error;
  }
}

test("cold delivery retains deadline time when measured alternatives cannot fit", async t => {
  const f = await overlapControlledFixture(t, { extraPeers: 2 });
  const originalSelect = PeerSelection.prototype.select;
  let seeded = false;
  t.mock.method(PeerSelection.prototype, "select", function (links, ...args) {
    const active = [...links];
    if (!seeded) {
      for (const link of active.slice(1)) this.record(link, 2000, f.bytes.byteLength);
      seeded = true;
    }
    return originalSelect.call(this, active, ...args);
  });
  try {
    for (const channel of [f.peer, ...f.otherPeers]) channel.receive(JSON.stringify({ t: "have", keys: [f.key] }));
    f.resolveMetadata(); await f.phase(() => f.wants().length === 1);
    f.advance(1470); f.deliver();
    await f.phase(() => f.callbacks.success + f.callbacks.abort + f.callbacks.error > 0);
    const response = await f.pending;
    assert.equal(response.data.byteLength, f.bytes.byteLength, "the cold peer completes before the unchanged1500ms origin deadline");
    assert.deepEqual(new Uint8Array(response.data), f.bytes);
    assert.equal(f.fixture.swarm.metrics().segments.peerFirstLoaded, 1);
    assert.equal(f.fixture.swarm.metrics().segments.originFallbacks, 0);
    assert(f.otherPeers.every(peer => !peer.sent.some(frame => frame?.t === "want")), "unfit alternatives are never requested");
    assert.equal(f.fixture.swarm.metrics().peerRequestDiagnostics.records.at(-1).timeoutMs, 1500);
  } finally { await f.close(); }
});

test("commitment overlap starts metadata before HAVE and verifies HIGH inside the original deadline", async t => {
  const f = await overlapControlledFixture(t);
  try {
    await f.phase(() => f.fixture.swarm.metrics().peerEligibilityDiagnostics.counters["no-have-wait"] === 1);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.metadataCalls(), 1, "the original serial source fails here before any HAVE or extended wait");
    assert.equal(f.wants().length, 0);
    f.advance(300); f.resolveMetadata(); await Promise.resolve();
    f.advance(200); f.peer.receive(JSON.stringify({ t: "have", keys: [f.key] }));
    await f.phase(() => f.wants().length === 1);
    f.advance(800); f.deliver();
    const response = await f.pending;
    assert.deepEqual(new Uint8Array(response.data), f.bytes);
    assert.equal(f.fixture.swarm.metrics().segments.peerFirstLoaded, 1);
    assert.equal(f.fixture.swarm.metrics().segments.originFallbacks, 0);
    assert.equal(f.metadataCalls(), 1);
  } finally { await f.close(); }
});

test("commitment overlap cancels lost waits, loader abort and stop with late rejection handled", async t => {
  for (const cause of ["withdrawal", "deadline", "abort", "stop"]) {
    const f = await overlapControlledFixture(t), unhandled = [];
    const recordUnhandled = error => unhandled.push(error);
    process.on("unhandledRejection", recordUnhandled);
    try {
      await f.phase(() => f.metadataCalls() === 1);
      if (cause === "withdrawal") { f.peer.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:1" })); f.advance(100); }
      if (cause === "deadline") f.advance(1500);
      if (cause === "abort") f.loader.abort();
      if (cause === "stop") f.stop();
      await f.phase(() => f.metadataSignal().aborted);
      f.rejectMetadata(new Error("synthetic late metadata rejection"));
      await new Promise(resolve => setImmediate(resolve));
      f.peer.receive(JSON.stringify({ t: "have", keys: [f.key] })); f.advance(2000);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(f.wants().length, 0);
      assert.equal(f.fixture.swarm.metrics().segments.peerFirstLoaded, 0);
      assert.equal(f.callbacks.success + f.callbacks.abort + f.callbacks.error, 1);
      assert.equal(f.metadataCalls(), 1);
      assert.deepEqual(unhandled, []);
      if (["withdrawal", "deadline"].includes(cause)) assert.equal(f.fixture.swarm.metrics().segments.originFallbacks, 1);
    } finally { process.removeListener("unhandledRejection", recordUnhandled); await f.close(); }
  }
});

test("commitment overlap retains post-HAVE expiry and exact-context verification", async t => {
  for (const mode of ["expired", "wrong-context"]) {
    const wall = Date.now(), f = await overlapControlledFixture(t, { expiresAt: Math.floor(wall / 1000) + 60, wrongRendition: mode === "wrong-context" });
    let dateMock;
    try {
      await f.phase(() => f.metadataCalls() === 1);
      f.resolveMetadata(); await Promise.resolve(); await Promise.resolve();
      if (mode === "expired") dateMock = t.mock.method(Date, "now", () => wall + 61000);
      f.advance(500); f.peer.receive(JSON.stringify({ t: "have", keys: [f.key] }));
      const response = await f.pending;
      assert.equal(response.data.byteLength, 32);
      assert.equal(f.wants().length, 0);
      assert.equal(f.fixture.swarm.metrics().segments.commitmentRejected, 1);
      assert.equal(f.fixture.swarm.metrics().segments.peerFirstLoaded, 0);
      assert.equal(f.fixture.swarm.metrics().segments.originFallbacks, 1);
    } finally { dateMock?.mock.restore(); await f.close(); }
  }
});

test("commitment overlap handles early metadata failure once without a late peer request", async t => {
  const f = await overlapControlledFixture(t), unhandled = [];
  const recordUnhandled = error => unhandled.push(error);
  process.on("unhandledRejection", recordUnhandled);
  try {
    await f.phase(() => f.metadataCalls() === 1);
    f.rejectMetadata(new Error("synthetic early metadata refusal"));
    await new Promise(resolve => setImmediate(resolve));
    f.advance(500); f.peer.receive(JSON.stringify({ t: "have", keys: [f.key] }));
    const response = await f.pending;
    assert.equal(response.data.byteLength, 32);
    assert.equal(f.wants().length, 0);
    assert.equal(f.fixture.swarm.metrics().segments.commitmentUnavailable, 1);
    assert.equal(f.fixture.swarm.metrics().segments.originFallbacks, 1);
    assert.equal(f.callbacks.success, 1);
    assert.deepEqual(unhandled, []);
  } finally { process.removeListener("unhandledRejection", recordUnhandled); await f.close(); }
});

test("commitment overlap still rejects corrupt peer bytes before the original origin fallback", async t => {
  const f = await overlapControlledFixture(t);
  try {
    await f.phase(() => f.metadataCalls() === 1);
    f.resolveMetadata();
    f.advance(500); f.peer.receive(JSON.stringify({ t: "have", keys: [f.key] }));
    await f.phase(() => f.wants().length === 1);
    const corrupt = f.bytes.slice(); corrupt[0] ^= 1;
    f.deliver(corrupt);
    const response = await f.pending;
    assert.equal(response.data.byteLength, 32);
    assert.equal(f.fixture.swarm.metrics().segments.peerCorrupt, 1);
    assert.equal(f.fixture.swarm.metrics().peers.banned, 1);
    assert.equal(f.fixture.swarm.metrics().segments.peerFirstLoaded, 0);
    assert.equal(f.fixture.swarm.metrics().segments.originFallbacks, 1);
    assert.equal(f.callbacks.success, 1);
  } finally { await f.close(); }
});
