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
  const relay = options.WebSocketImpl ? { url: "wss://memory-relay.example", close: async () => {} } : await startLocalRelay();
  const connections = [], peers = [];
  class Connection extends PC { constructor() { super(); connections.push(this); } }
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
  return { swarm, hls, addPeer, load, close, peers, pool, connections };
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

test("own ticket renewal preserves a live relay peer, verified media, held bytes and spent allowance", async () => {
  const verified = [], reservations = [], trace = [], announcements = [];
  let allowed = true;
  const http = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    verified.push(JSON.parse(Buffer.concat(chunks)));
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
    peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket: "remote-after" });
    await until(() => verified.some((input) => input.ticket === "remote-after"));
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
  } finally { await fixture.close(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
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
      budgetMs: 120, reason: "no-have-no-wait", matchingHave: false });
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
    assert.ok(snapshot.records.every((row) => row.matchingHave === null && row.budgetMs === 0));
    snapshot.records[0].reason = "untrusted-text"; snapshot.counters["no-budget"] = 0;
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.counters["no-budget"], 70);
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.records[0].reason, "no-budget");
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

test("peer eligibility observes existing coordination outcomes and matching HAVE without extra requests", async () => {
  const playback = peerPlaybackOptions(60), requested = [];
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket() });
  try {
    const peer = await fixture.addPeer(new ServingChannel(playback.bytes, 1, requested, "existing-peer"));
    peer.receive(JSON.stringify({ t: "contribution", serving: true, rendition: "main:0" }));
    await fixture.load();
    // The loader's original fallback timer can abort the pending wait at its
    // deadline; that is cancellation, not a fabricated still-missing HAVE read.
    await sleep(10);
    const ended = fixture.swarm.metrics().peerEligibilityDiagnostics;
    assert.equal(ended.counters["no-have-wait"], 1);
    assert.equal(ended.counters["wait-aborted"] + ended.counters["wait-expired"], 1);
    assert.equal(ended.records.at(-1).matchingHave, null);
    assert.equal(fixture.swarm.metrics().segments.commitmentRequests, 0);
    assert.deepEqual(requested, []);
    const pending = fixture.load();
    setTimeout(() => peer.receive(JSON.stringify({ t: "have", keys: [playback.key] })), 10);
    assert.deepEqual(new Uint8Array((await pending).data), playback.bytes);
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.counters["have-after-wait"], 1);
    await fixture.load();
    assert.equal(fixture.swarm.metrics().peerEligibilityDiagnostics.counters["have-at-entry"], 1);
    assert.equal(fixture.swarm.metrics().segments.commitmentRequests, 2);
    assert.deepEqual(requested, ["existing-peer", "existing-peer"]);
  } finally { await fixture.close(); }
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
