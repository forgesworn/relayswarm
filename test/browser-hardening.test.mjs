import test from "node:test";
import { CORE_FUNCTIONS, stubCore } from "./core-stub.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import { Worker as WorkerThread } from "node:worker_threads";
import { generateSecretKey, finalizeEvent, getPublicKey } from "nostr-tools/pure";
import Hls, { M3U8Parser, LoaderContextType, LoadStats } from 'hls.js';
const { createHlsSwarm } = await import(process.env.TEST_SWARM_MODULE ?? "../src/browser/hls-swarm.mjs");
import { loadCore } from "../src/browser/core-wasm.mjs";
import { originClockOffsetMs, originClockSummary } from "../src/browser/origin-clock.mjs";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { commitmentContent, commitmentPieceSize, KIND_SEGMENT_COMMITMENT, verifySegmentCommitment } from "../src/browser/segment-commitment.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";
import { mixedHttpOrigin } from "./support/mixed-http-origin.mjs";
import { boundedOperation } from "../src/browser/bounded-operation.mjs";
import { WARM_AHEAD } from "../src/browser/warm-ahead.mjs";
import { NeighbourDiscovery } from "../src/browser/neighbour-discovery.mjs";
import { CoreNeighbourDiscovery } from "../src/browser/core-discovery.mjs";
import { PeerSelection } from "../src/browser/peer-selection.mjs";
import { VerifiedPieceFlow } from "../src/browser/verified-piece-flow.mjs";
import { createOperatorControls } from "../demo/operator.mjs";

const initialPeerFlow = () => ({ partialUsefulnessPreserved: 0, verifiedShortBatches: 0, verifiedShortBytes: 0, lastVerifiedShortBatch: null,
  modelEvaluations: { fit: 0, 'useful-unknown': 0, refresh: 0, 'cooldown-blocked': 0, 'known-slow': 0 },
  lastModel: null, noModelTransfers: 0, lastNoModel: null });

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
  localDescription = { sdp: "address-bearing-sdp\r\na=candidate:fixture 1 udp 1 fixture.local 9 typ host\r\n" };
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
// RELAYSWARM_TEST_CORE=1 runs every peer-first fixture without its own
// coreWasm on the committed module, with selection and discovery bound to it
// and links opened after it is ready.
const testCore = process.env.RELAYSWARM_TEST_CORE === "1"
  ? await WebAssembly.compile(await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url))) : null;

async function linkedFixture(options = {}, LoaderImpl = Loader, player = {}) {
  if (testCore && options.mode === "peer-first" && options.coreWasm === undefined) options = { ...options, coreWasm: testCore };
  const relay = options.WebSocketImpl ? { url: "wss://memory-relay.example", close: async () => {} } : await startLocalRelay();
  const connections = [], peers = [];
  let peakLiveConnections = 0;
  class Connection extends PC { constructor(configuration) { super(configuration); connections.push(this); peakLiveConnections = Math.max(peakLiveConnections, connections.filter(pc => !pc.closed).length); } }
  const swarm = createHlsSwarm({ ...base, relays: [relay.url], RTCPeerConnectionImpl: Connection, shadowSampleRate: 0, ...options });
  const hls = { ...player, config: { loader: LoaderImpl } };
  swarm.attach(hls);
  const pool = new RelayPool([relay.url], { WebSocketImpl: options.WebSocketImpl }); await pool.connect();
  await until(() => swarm.metrics().pubkey);
  if (testCore && options.coreWasm === testCore) {
    await until(() => swarm.metrics().core.state === "ready");
    assert.deepEqual([swarm.metrics().core.selection, swarm.metrics().core.discovery], ["wasm", "wasm"], "the fixture runs on the core");
  }
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

test("peer connection snapshots include only accepted active links and cannot mutate swarm state", async t => {
  for (const ending of ["channel-close", "disconnected", "closed", "stop"]) await t.test(ending, async () => {
    const fixture = await linkedFixture({ ...peerPlaybackOptions(500).options, WebSocketImpl: memoryRelaySocket() });
    try {
      assert.deepEqual(fixture.swarm.peerConnections(), []);
      assert.deepEqual(fixture.swarm.peerConnectionDetails(), []);
      const peer = new RelaySwarmSession({ pool: fixture.pool, swarmId: base.swarmId }); peer.start(); fixture.peers.push(peer);
      peer.sendSignal(fixture.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "snapshot-pending-offer", payload: { sdp: "fixture-offer" } });
      await until(() => fixture.connections.length === 1 && fixture.swarm.metrics().peers.offersAccepted === 1);
      assert.equal(fixture.swarm.metrics().peers.dialling, 1);
      assert.deepEqual(fixture.swarm.peerConnections(), [], "an admitted offer is still a pending negotiation");
      assert.deepEqual(fixture.swarm.peerConnectionDetails(), [], "pending offers have no accepted identity binding");
      const channel = new RecordedChannel(); channel.readyState = "connecting";
      const event = new Event("datachannel"); event.channel = channel; fixture.connections[0].dispatchEvent(event);
      assert.deepEqual(fixture.swarm.peerConnections(), [], "a not-yet-open channel cannot appear as a viewer");
      channel.readyState = "open"; channel.dispatchEvent(new Event("open"));
      await until(() => fixture.swarm.metrics().peers.connected === 1);
      const snapshot = fixture.swarm.peerConnections();
      assert.deepEqual(snapshot, [fixture.connections[0]], "the accepted link returns the exact native connection");
      const details = fixture.swarm.peerConnectionDetails();
      assert.deepEqual(details, [{ connection: fixture.connections[0], pubkey: peer.pubkey }], "identity is the authenticated remote signalling key");
      details[0].pubkey = "caller mutation"; details[0].connection = null; details.length = 0;
      assert.deepEqual(fixture.swarm.peerConnectionDetails(), [{ connection: fixture.connections[0], pubkey: peer.pubkey }], "caller-owned records cannot alter the native identity binding");
      assert.notEqual(fixture.swarm.peerConnections(), snapshot, "each call returns a fresh array");
      snapshot.pop(); snapshot.push({ arbitrary: "caller value" });
      assert.deepEqual(fixture.swarm.peerConnections(), [fixture.connections[0]], "mutating the caller's array cannot alter membership");
      assert.equal(fixture.swarm.peerConnections().length, fixture.swarm.metrics().peers.connected);
      if (ending === "channel-close") channel.close();
      else if (ending === "stop") fixture.swarm.stop();
      else { fixture.connections[0].connectionState = ending; fixture.connections[0].dispatchEvent(new Event("connectionstatechange")); }
      assert.deepEqual(fixture.swarm.peerConnections(), [], "closed, disconnected and stopped links disappear");
      assert.deepEqual(fixture.swarm.peerConnectionDetails(), [], "retired identity bindings disappear with the link");
      assert.equal(fixture.swarm.metrics().peers.connected, 0);
      fixture.swarm.stop(); assert.deepEqual(fixture.swarm.peerConnections(), []);
    } finally { await fixture.close(); }
  });
});

test("presence carries a bounded object framing version and drops an invalid one", async () => {
  const pool = new RelayPool(["wss://memory.test"], { WebSocketImpl: memoryRelaySocket() });
  const swarmId = "framing-presence", sender = new RelaySwarmSession({ pool, swarmId }), receiver = new RelaySwarmSession({ pool, swarmId });
  const seen = [];
  try {
    await pool.connect(); sender.start(); receiver.start();
    receiver.onPresence(({ payload }) => seen.push(payload.transports));
    const entry = (extra) => ({ type: "webrtc", publicKey: sender.pubkey, ...extra });
    for (const obj of [0, 16, 2.5, "2"]) assert.throws(() => sender.announcePresence({ role: "viewer", transports: [entry({ obj })] }), /transport capability/u);
    sender.announcePresence({ role: "viewer", transports: [entry({ obj: 2 })] });
    sender.announcePresence({ role: "viewer", transports: [entry()] });
    // An older or careless peer: the entry stays, the field reads as framing 1.
    pool.publish(finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", swarmId]],
      content: JSON.stringify({ v: 3, role: "viewer", transports: [entry({ obj: 16 })], have: [] }) }, generateSecretKey()));
    await until(() => seen.length === 3);
    assert.deepEqual(seen, [[entry({ obj: 2 })], [entry()], [entry()]]);
  } finally { sender.close(); receiver.close(); pool.close(); }
});

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

test("a cancelled upload stops before its next chunk and is counted without a refund", async () => {
  const fixture = await linkedFixture({ serve: true, maxUploadBytesPerSession: 64 });
  try {
    const peer = await fixture.addPeer();
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = peer.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    assert.equal(fixture.swarm.metrics().bytes.uploadsCancelled, 0);
    peer.bufferedAmount = 2_000_000;
    peer.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => peer.sent.some((frame) => frame.t === "meta" && frame.id === 1));
    peer.receive(JSON.stringify({ t: "cancel", id: 1 }));
    peer.bufferedAmount = 0; peer.dispatchEvent(new Event("bufferedamountlow"));
    await until(() => peer.sent.some((frame) => frame.t === "eof" && frame.id === 1));
    const response = peer.sent.slice(peer.sent.findIndex((frame) => frame.t === "meta" && frame.id === 1));
    assert.equal(response.filter((frame) => frame instanceof Uint8Array).length, 0, "no chunk follows the cancel");
    const bytes = fixture.swarm.metrics().bytes;
    assert.equal(bytes.uploadsCancelled, 1); assert.equal(bytes.uploadCancelledBytes, 32);
    assert.equal(bytes.uploaded, 32); assert.equal(bytes.uploadRemaining, 32, "the charged allowance is not refunded");
    assert.equal(fixture.swarm.metrics().peers.connected, 1);
  } finally { await fixture.close(); }
});

test("bytes a cancel kept from being sent return to the per-second upload rate", async () => {
  const fixture = await linkedFixture({ serve: true, maxUploadBytesPerSecond: 32 });
  try {
    const peer = await fixture.addPeer();
    await fixture.load(); await until(() => fixture.swarm.metrics().bytes.held === 32);
    const key = peer.sent.find((frame) => frame.t === "have" && frame.add?.length).add[0];
    peer.bufferedAmount = 2_000_000;
    peer.receive(JSON.stringify({ t: "want", id: 1, k: key }));
    await until(() => peer.sent.some((frame) => frame.t === "meta" && frame.id === 1));
    peer.receive(JSON.stringify({ t: "cancel", id: 1 }));
    peer.bufferedAmount = 0; peer.dispatchEvent(new Event("bufferedamountlow"));
    await until(() => peer.sent.some((frame) => frame.t === "eof" && frame.id === 1));
    // The 32 B/s rate allows one 32-byte response now; the unsent first is returned.
    peer.receive(JSON.stringify({ t: "want", id: 2, k: key }));
    await until(() => peer.sent.some((frame) => (frame.t === "meta" || frame.t === "none") && frame.id === 2));
    assert.ok(peer.sent.some((frame) => frame.t === "meta" && frame.id === 2), "the second request is served, not refused");
    const metrics = fixture.swarm.metrics();
    assert.equal(metrics.uploadRefusalDiagnostics.counters["rate-limit"] ?? 0, 0);
    assert.equal(metrics.bytes.uploadsCancelled, 1); assert.equal(metrics.bytes.uploadCancelledBytes, 32);
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

function controlledRelaySockets(ephemeral = false) {
  const sockets = [];
  class Socket extends EventTarget {
    sent = [];
    constructor(url) { super(); this.url = url; sockets.push(this); }
    send(data) {
      const frame = JSON.parse(data); this.sent.push(frame);
      if (ephemeral && frame[0] === "EVENT") for (const remote of sockets) {
        if (!remote.opened || remote.closed || remote.url !== this.url) continue;
        for (const request of remote.sent.filter(value => value[0] === "REQ")) queueMicrotask(() => {
          if (!remote.closed) remote.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EVENT", request[1], frame[1]]) }));
        });
      }
    }
    close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event("close")); }
    open() { this.opened = true; this.dispatchEvent(new Event("open")); }
  }
  return { Socket, sockets };
}
const relayTurns = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

test("reconnecting relay pool becomes ready on its first usable socket while later attempts remain owned", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { Socket, sockets } = controlledRelaySockets();
  const pool = new RelayPool(["wss://healthy.example", "wss://hung.example", "wss://late.example"], { WebSocketImpl: Socket, reconnect: true });
  let ready = false, session;
  const connecting = pool.connect().then(() => { ready = true; });
  try {
    sockets[0].open(); await relayTurns();
    assert.equal(ready, true, "a healthy relay starts before either other attempt or the 8s timeout");
    assert.equal(pool.pendingSockets.size, 2);
    session = new RelaySwarmSession({ pool, swarmId: base.swarmId }); session.start();
    const presence = () => session.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: session.pubkey }] });
    presence();
    assert.equal(sockets[0].sent.filter(frame => frame[0] === "EVENT").length, 1, "session presence can publish immediately");
    const subscriptions = sockets[0].sent.filter(frame => frame[0] === "REQ");
    sockets[2].open(); await relayTurns();
    assert.deepEqual(sockets[2].sent.filter(frame => frame[0] === "REQ"), subscriptions, "a late socket receives every existing subscription");
    assert.equal(sockets[2].sent.filter(frame => frame[0] === "EVENT").length, 1, "current presence replays only to the new relay");
    assert.equal(sockets[0].sent.filter(frame => frame[0] === "EVENT").length, 1, "no replay is broadcast to an existing relay");
    presence();
    assert.equal(sockets[2].sent.filter(frame => frame[0] === "EVENT").length, 2, "late sockets carry subsequent signed presence");
    t.mock.timers.tick(7_999); await relayTurns();
    assert.equal(pool.pendingSockets.size, 1);
    t.mock.timers.tick(1); await relayTurns();
    assert.equal(sockets[1].closed, true);
    assert.equal(pool.pendingSockets.size, 0);
    assert.equal(pool.retryTimers.size, 1, "the late rejected attempt still gets its bounded retry");
    assert.equal(pool.sockets.length, 2);
    assert.equal(pool.readyWaiters.size, 0);
  } finally {
    session?.close(); pool.close(); await Promise.allSettled([connecting]);
    t.mock.timers.tick(30_000); await relayTurns();
    assert.equal(sockets.length, 3, "stop owns and clears the pending retry");
    assert.equal(pool.pendingSockets.size + pool.retryTimers.size + pool.readyWaiters.size, 0);
  }
});

test("disjoint first relays discover through a late common ephemeral relay without replaying SDP", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { Socket, sockets } = controlledRelaySockets(true);
  const pools = [new RelayPool(["wss://a.example", "wss://common.example"], { WebSocketImpl: Socket, reconnect: true, reconnectMaxMs: 20 }),
    new RelayPool(["wss://b.example", "wss://common.example"], { WebSocketImpl: Socket, reconnect: true, reconnectMaxMs: 20 })];
  const ready = pools.map(pool => pool.connect());
  sockets[0].open(); sockets[2].open(); await Promise.all(ready);
  const sessions = pools.map(pool => new RelaySwarmSession({ pool, swarmId: base.swarmId }));
  const discovered = [[], []], signals = [];
  try {
    sessions.forEach((session, i) => { session.start(); session.onPresence(value => discovered[i].push(value.from));
      session.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: session.pubkey }] }); });
    sessions[1].onSignal(value => signals.push(value.payload.requestId));
    sessions[0].sendSignal(sessions[1].pubkey, { type: "offer", transport: "webrtc", requestId: "old-offer", payload: { sdp: "old" } });
    await relayTurns(); assert.deepEqual(discovered, [[], []]);
    const firstCounts = [sockets[0], sockets[2]].map(socket => socket.sent.length);
    sockets[1].open(); sockets[3].open(); await relayTurns();
    assert.deepEqual(discovered[0], [sessions[1].pubkey], "late shared relay discovers a peer without the periodic heartbeat");
    assert.deepEqual([sockets[0], sockets[2]].map(socket => socket.sent.length), firstCounts, "replays target only the newly opened relay");
    for (const socket of [sockets[1], sockets[3]]) assert.deepEqual(socket.sent.filter(frame => frame[0] === "EVENT").map(frame => frame[1].kind), [24170], "presence only, no old SDP");
    sessions[0].sendSignal(sessions[1].pubkey, { type: "offer", transport: "webrtc", requestId: "fresh-offer", payload: { sdp: "fresh" } });
    await relayTurns(); assert.deepEqual(signals, ["fresh-offer"], "fresh encrypted signalling works across the common relay");
    const beforeReconnect = sockets[0].sent.length;
    sockets[1].close(); t.mock.timers.tick(20); await relayTurns();
    sockets[4].open(); await relayTurns();
    assert.deepEqual(sockets[4].sent.filter(frame => frame[0] === "EVENT").map(frame => frame[1].kind), [24170], "a reconnected relay receives only current presence");
    assert.equal(sockets[0].sent.length, beforeReconnect);
    assert.deepEqual(discovered[1], [sessions[0].pubkey]);
  } finally { sessions.forEach(session => session.close()); pools.forEach(pool => pool.close()); await Promise.allSettled(ready); }
});

test("late relay replay owns its presence copy and respects session expiry and stop", async t => {
  for (const ending of ["expired", "stopped"]) await t.test(ending, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const { Socket, sockets } = controlledRelaySockets();
    const pool = new RelayPool(["wss://first.example", "wss://late.example", "wss://later.example"], { WebSocketImpl: Socket, reconnect: true });
    const connecting = pool.connect(); sockets[0].open(); await connecting;
    const session = new RelaySwarmSession({ pool, swarmId: base.swarmId, maxEventAgeSeconds: 2 });
    try {
      session.start();
      const returned = session.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: session.pubkey }] });
      const expected = JSON.parse(JSON.stringify(returned)); returned.content = "caller-mutated"; returned.tags[0][1] = "caller-mutated";
      sockets[1].open(); await relayTurns();
      assert.deepEqual(sockets[1].sent.filter(frame => frame[0] === "EVENT").map(frame => frame[1]), [expected], "cached signed presence owns its envelope");
      if (ending === "expired") t.mock.timers.tick(3_000); else session.close();
      sockets[2].open(); await relayTurns();
      assert.deepEqual(sockets[2].sent.filter(frame => frame[0] === "EVENT"), [], "expired or stopped sessions replay nothing");
      if (ending === "stopped") assert.equal(pool.relayOpenHandlers.size, 0);
    } finally { session.close(); pool.close(); await Promise.allSettled([connecting]); }
  });
});

test("stopping reconnect readiness closes every initial attempt and cannot resurrect from late opens", async t => {
  for (const firstOpened of [false, true]) await t.test(firstOpened ? "after first readiness" : "before readiness", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { Socket, sockets } = controlledRelaySockets();
    const pool = new RelayPool(["wss://first.example", "wss://hung.example"], { WebSocketImpl: Socket, reconnect: true });
    const connecting = pool.connect();
    const outcome = firstOpened ? connecting : assert.rejects(connecting, /closed/);
    if (firstOpened) { sockets[0].open(); await connecting; }
    pool.close(); await outcome;
    for (const socket of sockets) socket.open();
    t.mock.timers.tick(30_000); await relayTurns();
    assert.equal(pool.sockets.length + pool.pendingSockets.size + pool.retryTimers.size + pool.readyWaiters.size, 0);
    assert.ok(sockets.every(socket => socket.closed));
    assert.equal(sockets.length, 2, "no retry or replacement can start after stop");
  });
});

test("non-reconnecting readiness still waits for all attempts and bounds an all-failed error", async t => {
  for (const healthy of [true, false]) await t.test(healthy ? "one usable relay" : "all failed", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { Socket, sockets } = controlledRelaySockets();
    const pool = new RelayPool(["wss://first.example", "wss://hung.example"], { WebSocketImpl: Socket });
    let completed = false;
    const connecting = pool.connect().then(() => { completed = true; });
    const outcome = healthy ? connecting : assert.rejects(connecting, /No relay reachable.*timed out/);
    if (healthy) sockets[0].open();
    await relayTurns(); assert.equal(completed, false);
    t.mock.timers.tick(7_999); await relayTurns(); assert.equal(completed, false);
    t.mock.timers.tick(1); await outcome;
    assert.equal(completed, healthy);
    assert.equal(pool.retryTimers.size, 0);
    pool.close();
  });
});

test("one-shot readiness on the first relay still fails only when every attempt has, without retrying", async t => {
  for (const healthy of [true, false]) await t.test(healthy ? "one usable relay" : "all failed", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { Socket, sockets } = controlledRelaySockets();
    const pool = new RelayPool(["wss://first.example", "wss://hung.example"], { WebSocketImpl: Socket, readyOnFirstRelay: true });
    let completed = false;
    const connecting = pool.connect().then(() => { completed = true; });
    if (healthy) {
      sockets[0].open(); await relayTurns();
      assert.equal(completed, true, "ready before the other attempt settles");
      assert.equal(pool.pendingSockets.size, 1);
      sockets[1].open(); await relayTurns();
      assert.equal(pool.sockets.length, 2, "a slower relay joins when it opens");
      sockets[1].close(); await relayTurns();
      t.mock.timers.tick(60_000); await relayTurns();
      assert.equal(sockets.length, 2, "no redial without reconnect");
      await connecting;
    } else {
      const outcome = assert.rejects(connecting, /No relay reachable.*closed.*timed out/);
      sockets[0].close(); await relayTurns();
      assert.equal(completed, false);
      t.mock.timers.tick(7_999); await relayTurns(); assert.equal(completed, false);
      t.mock.timers.tick(1); await outcome;
    }
    assert.equal(pool.retryTimers.size, 0);
    pool.close();
  });
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
    const connection = fixture.swarm.peerConnectionDetails()[0];
    const uploaded = async (id) => {
      await until(() => channel.sent.some((frame) => frame.t === "eof" && frame.id === id));
      const payload = channel.sent.filter((frame) => frame instanceof Uint8Array).at(-1);
      assert.equal(createHash("sha256").update(payload).digest("hex"), createHash("sha256").update(playback.bytes).digest("hex"));
    };
    const upload = async (id) => { channel.receive(JSON.stringify({ t: "want", id, k: playback.key })); await uploaded(id); };
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
    // A media request can arrive while the changed-ticket HTTP check is still
    // pending. Renewal must not turn that overlap into an admission refusal.
    channel.receive(JSON.stringify({ t: "want", id: 1002, k: playback.key }));
    await sleep(30);
    assert.equal(channel.readyState, "open", "pending renewal does not close a live link when media is requested");
    assert.deepEqual(reservations, [32], "a pending refresh cannot authorise another upload reservation");
    assert.equal(fixture.swarm.metrics().bytes.uploaded, before.bytes.uploaded);
    releaseRemoteRefresh();
    await until(() => fixture.swarm.metrics().peers.openPeersKnown === 1, refreshRemaining());
    await uploaded(1002);
    assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    const after = fixture.swarm.metrics();
    assert.equal(fixture.hls.config.fLoader, loader); assert.equal(after.pubkey, pubkey);
    assert.equal(after.peers.connected, 1); assert.equal(after.peers.linksOpened, 1); assert.equal(after.peers.linksClosed, 0);
    const details = fixture.swarm.peerConnectionDetails();
    assert.equal(details.length, 1); assert.equal(details[0].connection, connection.connection);
    assert.equal(details[0].pubkey, connection.pubkey, "renewal retains the accepted peer identity");
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

test("uploads waiting for a ticket refresh refuse rejection, timeout and late acceptance after closure", async t => {
  for (const ending of ["rejected", "timeout", "stop", "channel-close"]) await t.test(ending, async child => {
    let entered = false, finish, admissionSignal;
    const reservations = [], checks = [];
    const refresh = new Promise(resolve => { finish = resolve; });
    const f = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve: true, ticket: "own", maxUploadBytesPerSession: 96,
      reserveUploadBytes: size => { reservations.push(size); return true; },
      admit: (_pubkey, ticket, { signal }) => {
        checks.push(ticket);
        if (ticket !== "pending-renewal") return true;
        entered = true; admissionSignal = signal; return refresh;
      } });
    let clock;
    try {
      const channel = await f.addPeer(); await f.load();
      await until(() => f.swarm.metrics().bytes.held === 32);
      const key = channel.sent.find(frame => frame.t === "have" && frame.add?.length).add[0];
      clock = virtualClock(child);
      const peer = f.peers[0];
      peer.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: peer.pubkey }], ticket: "pending-renewal" });
      await clock.advanceUntil(() => entered, 500);
      channel.receive(JSON.stringify({ t: "want", id: 501, k: key }));
      await clock.advance(20);
      assert.equal(channel.readyState, "open");
      assert.equal(f.swarm.metrics().bytes.uploaded, 0); assert.deepEqual(reservations, []);
      if (ending === "stop") { f.swarm.stop(); finish(true); }
      else if (ending === "channel-close") {
        // Accepted presence can legitimately start a new dial after closure.
        // Keep that separate admission outside this upload cancellation window.
        child.mock.method(Math, "random", () => 0.999);
        channel.close(); finish(true);
      }
      else if (ending === "rejected") finish(false);
      else await clock.advance(3_000);
      await clock.advanceUntil(() => channel.readyState === "closed", 500);
      if (ending === "timeout" || ending === "stop") assert.equal(admissionSignal.aborted, true);
      // Even a host callback that ignores cancellation and accepts late cannot
      // publish bytes or consume a reservation after timeout or link closure.
      finish(true); await clock.advance(20);
      assert.equal(f.swarm.metrics().bytes.uploaded, 0);
      assert.equal(f.swarm.metrics().bytes.uploadRemaining, 96); assert.deepEqual(reservations, []);
      assert.equal(checks.filter(ticket => ticket === "pending-renewal").length, 1, "media joins one bounded check");
      assert.equal(channel.sent.some(frame => frame instanceof Uint8Array || frame.t === "meta" || frame.t === "eof"), false);
      assert.deepEqual(f.swarm.peerConnectionDetails(), []);
    } finally { finish(false); clock?.restore(); await f.close(); }
  });
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

test("active ticket refresh floods retain only the latest credential within sixteen real HTTP checks", async t => {
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
  const clock = virtualClock(t);
  try {
    // Keep the existing three-second admission allowance independent of the
    // wall time spent signing the flood; HTTP itself remains real.
    await clock.settle((async () => {
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
    })());
  } finally { clock.restore(); witness.close(); extraPool.close(); await fixture.close(); http.closeAllConnections(); await new Promise((resolve) => http.close(resolve)); }
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

test("origin media is copied only to compare or serve it, and hashed only to compare it", async t => {
  const size = 64 * 1024, digest = t.mock.method(globalThis.crypto.subtle, "digest");
  const run = async (options, media, settled = () => true) => {
    let copies = 0;
    const data = new Uint8Array(size).fill(5).buffer;
    data.slice = function (...args) { copies++; return ArrayBuffer.prototype.slice.apply(this, args); };
    class Origin extends Loader { load(context, _config, callbacks) { callbacks.onSuccess({ data }, this.stats, context, null); } }
    const swarm = createHlsSwarm({ ...base, relays: ["wss://memory-relay.example"], WebSocketImpl: memoryRelaySocket(), lateWindowMs: 20, ...options });
    const hls = { config: { loader: Origin }, ...(media ? { media } : {}) };
    digest.mock.resetCalls();
    try {
      swarm.attach(hls);
      let delivered = null;
      new hls.config.fLoader({}).load(context, {}, { onSuccess(response) { delivered = response.data; }, onError() {}, onTimeout() {} });
      assert.equal(delivered, data, "the player receives the original buffer");
      await until(() => swarm.metrics().segments.originLoaded === 1 && settled(swarm.metrics()));
      await sleep(20);
      const metrics = swarm.metrics();
      assert.equal(metrics.bytes.fromOrigin, size);
      return { copies, hashed: digest.mock.calls.filter(call => call.arguments[1].byteLength === size).length, metrics };
    } finally { swarm.stop(); }
  };
  const resolved = (metrics) => metrics.segments.sampledOut + metrics.segments.noPeers === 1;
  const unsampled = await run({ shadowSampleRate: 0 }, null, resolved);
  assert.deepEqual([unsampled.copies, unsampled.hashed, unsampled.metrics.segments.sampledOut, unsampled.metrics.bytes.held], [0, 0, 1, 0]);
  const sampled = await run({ shadowSampleRate: 1 }, null, resolved);
  assert.deepEqual([sampled.copies, sampled.hashed, sampled.metrics.segments.noPeers, sampled.metrics.bytes.held], [1, 1, 1, 0]);
  const serving = await run({ shadowSampleRate: 0, serve: true }, null, metrics => resolved(metrics) && metrics.bytes.held > 0);
  assert.deepEqual([serving.copies, serving.hashed, serving.metrics.segments.sampledOut, serving.metrics.bytes.held], [1, 0, 1, size]);
  const playback = peerPlaybackOptions(), empty = { currentTime: 0, buffered: { length: 0 } };
  const receiveOnly = await run(playback.options, empty);
  assert.deepEqual([receiveOnly.copies, receiveOnly.hashed, receiveOnly.metrics.bytes.held], [0, 0, 0]);
  const peerServing = await run({ ...playback.options, serve: true }, empty, metrics => metrics.bytes.held > 0);
  assert.deepEqual([peerServing.copies, peerServing.hashed, peerServing.metrics.bytes.held], [1, 0, size]);
});

test("a progressive shadow load started on cellular is still held when it finishes on Wi-Fi", async () => {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator"), connection = { type: "wifi" };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection } });
  const chunk = 10_000, chunks = 4;
  class Origin extends Loader {
    async load(context, _config, callbacks) {
      for (let index = 0; index < chunks; index++) {
        callbacks.onProgress?.(this.stats, context, new Uint8Array(chunk).fill(index + 1).buffer, null);
        await sleep(5);
        if (index === 1) connection.type = "wifi";
      }
      callbacks.onSuccess({ data: new ArrayBuffer(0) }, this.stats, context, null);
    }
  }
  const swarm = createHlsSwarm({ ...base, relays: ["wss://memory-relay.example"], WebSocketImpl: memoryRelaySocket(), shadowSampleRate: 0, serve: true, lateWindowMs: 20 });
  try {
    const hls = { config: { loader: Origin } };
    swarm.attach(hls);
    // Serving is not allowed when the load starts, but is by the time it is held.
    connection.type = "cellular";
    new hls.config.fLoader({}).load(context, {}, { onSuccess() {}, onProgress() {}, onError() {}, onTimeout() {} });
    await until(() => swarm.metrics().segments.originLoaded === 1 && swarm.metrics().bytes.held === chunk * chunks);
  } finally {
    swarm.stop();
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("core discovery reads candidates again after a hint or clear", async () => {
  const core = await loadCore(await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url)));
  const at = 1_792_000_000_000, wasm = core.neighbourDiscovery(() => at), js = new NeighbourDiscovery(() => at);
  const [wanted, other, holder] = ["b", "c", "e"].map(digit => digit.repeat(64));
  const both = (operation) => [wasm, js].map(operation);
  const found = () => both(discovery => discovery.hinted(discovery.contexts.get("main"), () => true)?.candidate.pubkey ?? null);
  both(discovery => discovery.demand("main", "r", wanted));
  both(discovery => discovery.hint(other, ["d".repeat(64)], null));
  assert.deepEqual(found(), [null, null]);
  both(discovery => discovery.hint(holder, [wanted], null));
  assert.deepEqual(found(), [holder, holder]);
  both(discovery => discovery.hint(holder, [], null));
  assert.deepEqual(found(), [null, null]);
  both(discovery => discovery.hint(holder, [wanted], null));
  assert.deepEqual(both(discovery => discovery.choose(() => true, () => true, true)?.candidate.pubkey), [holder, holder]);
  both(discovery => discovery.clear());
  both(discovery => discovery.demand("main", "r", wanted));
  assert.deepEqual(found(), [null, null]);
  assert.equal(wasm.kind, "wasm");
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

// Policy-clock assertions exclude native crypto scheduling. Only this known
// segment key is synchronous; all other algorithms and inputs stay native.
function synchronousFixtureSegmentKey(t) {
  const subtle = globalThis.crypto.subtle, digest = subtle.digest.bind(subtle);
  const known = Buffer.from(`${base.swarmId}\n/seg.ts`);
  t.mock.method(subtle, "digest", (algorithm, input) => {
    if (algorithm !== "SHA-256" || !(input instanceof Uint8Array) || !Buffer.from(input).equals(known)) return digest(algorithm, input);
    const bytes = createHash("sha256").update(input).digest();
    return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  });
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

test("peer delivery observation identifies the successful connection once after verification and counter updates", async () => {
  const playback = peerPlaybackOptions(500), requested = [], observations = [];
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(),
    onPeerDelivery: value => observations.push({ value, peerBytes: fixture.swarm.metrics().bytes.peerFirst }) });
  try {
    const refusing = await fixture.addPeer(new ServingChannel(null, 0, requested, "refusing"));
    const serving = await fixture.addPeer(new ServingChannel(playback.bytes, 1, requested, "serving"));
    for (const channel of [refusing, serving]) channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    assert.deepEqual(observations, [], "presence, HAVE and signalling are not media delivery");
    for (let i = 0; i < 2; i++) {
      const response = await fixture.load();
      assert.deepEqual(new Uint8Array(response.data), playback.bytes);
      assert.equal(observations.length, i + 1, "one observation precedes each player success");
      assert.deepEqual(Object.keys(observations[i].value).sort(), ["bytes", "connection"]);
      assert.equal(observations[i].value.connection, fixture.connections[1], "the refusing connection is never credited");
      assert.equal(observations[i].value.bytes, playback.bytes.byteLength);
      assert.equal(observations[i].peerBytes, (i + 1) * playback.bytes.byteLength, "public aggregate is updated before observation");
      fixture.swarm.metrics(); fixture.swarm.metrics();
      assert.equal(observations.length, i + 1, "taking a snapshot cannot repeat a delivery callback");
    }
    assert.deepEqual(requested, ["refusing", "serving", "serving"]);
  } finally { await fixture.close(); }
});

test("throwing and asynchronously rejecting peer delivery observers cannot alter playback", async t => {
  for (const kind of ["throw", "reject"]) await t.test(kind, async () => {
    const playback = peerPlaybackOptions(500), observations = [];
    const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(),
      onPeerDelivery: value => { observations.push(value); if (kind === "throw") throw new Error("host observer failed"); return Promise.reject(new Error("host observer rejected")); } });
    try {
      const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 1, [], "holder"));
      channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
      assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(observations.length, 1);
      assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 1);
      assert.equal(fixture.swarm.metrics().segments.originFallbacks, 0);
      assert.equal(fixture.swarm.metrics().errors.total, 0);
    } finally { await fixture.close(); }
  });
});

test("origin fallback, rejected commitments and corrupt peer media never become peer delivery observations", async t => {
  for (const kind of ["origin", "commitment", "corrupt", "shadow"]) await t.test(kind, async () => {
    const playback = peerPlaybackOptions(100), observed = [];
    const options = { ...playback.options, WebSocketImpl: memoryRelaySocket(), onPeerDelivery: value => observed.push(value),
      ...(kind === "commitment" ? { getCommitment: () => null } : {}), ...(kind === "shadow" ? { mode: "shadow", shadowSampleRate: 1 } : {}) };
    const fixture = await linkedFixture(options);
    try {
      const bytes = playback.bytes.slice(); if (kind === "corrupt") bytes[0] ^= 0xff;
      const channel = await fixture.addPeer(new ServingChannel(bytes, 1, [], "holder"));
      if (kind !== "origin") channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
      assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
      if (kind === "shadow") await until(() => fixture.swarm.metrics().segments.peerInTime === 1);
      assert.deepEqual(observed, []);
      assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 0);
      if (kind === "corrupt") assert.equal(fixture.swarm.metrics().segments.peerCorrupt, 1);
      if (kind === "commitment") assert.equal(fixture.swarm.metrics().segments.commitmentRejected, 1);
    } finally { await fixture.close(); }
  });
});

test("late, aborted and destroyed peer loads never emit a delivery observation", async t => {
  for (const kind of ["late", "abort", "destroy", "stop"]) await t.test(kind, async subtest => {
    const playback = peerPlaybackOptions(50), observed = [], requested = [];
    const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(), onPeerDelivery: value => observed.push(value) });
    let time;
    try {
      const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 100, requested, "holder"));
      channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
      time = virtualClock(subtest);
      let successes = 0, aborts = 0;
      const loader = new fixture.hls.config.fLoader({});
      loader.load(context, {}, { onSuccess: () => { successes++; }, onAbort: () => { aborts++; } });
      await time.advanceUntil(() => requested.length === 1, 100);
      if (kind === "abort") loader.abort();
      else if (kind === "destroy") loader.destroy();
      else if (kind === "stop") fixture.swarm.stop();
      await time.advance(200);
      assert.deepEqual(observed, []);
      assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 0);
      assert.equal(successes, kind === "late" || kind === "stop" ? 1 : 0, "only normal origin fallback reaches the player");
      assert.equal(aborts, kind === "abort" ? 1 : 0);
    } finally { time?.restore(); await fixture.close(); }
  });
});

// Virtual time for loader timing tests: host timer lateness (Windows
// granularity, a loaded machine) cannot eat a budget. Each step yields to real
// I/O, then moves the loader and link clocks and mocked timers on by 1ms.
function virtualClock(t, fraction = 0) {
  const realSetTimeout = setTimeout;
  // Integer by default; a fraction deliberately exercises shell rounding.
  let clock = Math.ceil(performance.now()) + fraction;
  t.mock.method(performance, "now", () => clock);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const step = async () => { await new Promise((resolve) => realSetTimeout(resolve, 1)); clock += 1; t.mock.timers.tick(1); };
  const advanceUntil = async (predicate, limitMs) => {
    for (let elapsed = 0; !predicate(); elapsed++) {
      assert.ok(elapsed <= limitMs, "expected loader phase did not occur");
      await step();
    }
  };
  const advance = async (ms) => { for (let elapsed = 0; elapsed < ms; elapsed++) await step(); };
  const settle = async (promise, limitMs = 5_000) => {
    let outcome = null;
    promise.then((value) => { outcome = { value }; }, (error) => { outcome = { error }; });
    await advanceUntil(() => outcome !== null, limitMs);
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };
  return { now: () => clock, step, advance, advanceUntil, settle, restore: () => { t.mock.timers.reset(); t.mock.restoreAll(); } };
}

test("a peer request is skipped for origin when the time left is below the fastest completed transfer", async () => {
  const playback = peerPlaybackOptions(1000);
  const requested = [];
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket() });
  try {
    const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 250, requested, "holder"));
    channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 1);
    assert.equal(fixture.swarm.metrics().segments.peerSkippedLate, 0, "no completed transfer gives no floor");
    // 2.15 s buffered less the 2 s origin reserve leaves 150 ms; the only
    // completion took at least 250 ms for this size. The projection from that
    // completion sends the load to origin before any wait or request.
    fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.15 } };
    assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    const segments = fixture.swarm.metrics().segments;
    assert.deepEqual(requested, ["holder"], "the holder is not asked for a segment it could not deliver in time");
    assert.equal(segments.peerProjectedLate, 1);
    assert.equal(segments.peerSkippedLate, 0);
    assert.equal(segments.peerFirstLoaded, 1);
    assert.equal(segments.originLoaded, 1);
  } finally { await fixture.close(); }
});

// hls.js samples its bandwidth and first-byte estimates while it dispatches
// these two events; the fake player does the same.
test("abrIgnorePeers keeps a peer-delivered fragment out of the player's ABR estimate", async () => {
  const samples = [];
  const estimator = { sample: (ms, bytes) => samples.push(["bandwidth", ms, bytes]), sampleTTFB: (ms) => samples.push(["ttfb", ms]) };
  function trigger(event, data) { this.abrController.bwEstimator.sampleTTFB(5); this.abrController.bwEstimator.sample(10, data.bytes); return event; }
  const playback = peerPlaybackOptions(1000);
  const fixture = await linkedFixture({ ...playback.options, abrIgnorePeers: true, WebSocketImpl: memoryRelaySocket() }, Loader, { abrController: { bwEstimator: estimator }, trigger });
  try {
    const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 5, [], "holder"));
    channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    assert.equal(fixture.hls.trigger("hlsFragLoaded", { frag: context.frag, bytes: 32 }), "hlsFragLoaded");
    fixture.hls.trigger("hlsFragBuffered", { frag: context.frag, bytes: 32 });
    assert.deepEqual(samples, [], "the peer delivery is not sampled");
    fixture.hls.trigger("hlsFragBuffered", { frag: { sn: 2, level: 0, cc: 0 }, bytes: 64 });
    fixture.hls.trigger("hlsLevelLoaded", { frag: context.frag, bytes: 16 });
    assert.deepEqual(samples, [["ttfb", 5], ["bandwidth", 10, 64], ["ttfb", 5], ["bandwidth", 10, 16]], "other fragments and events are sampled as before");
    assert.equal(fixture.swarm.metrics().segments.abrPeerSamplesWithheld, 4);
  } finally { await fixture.close(); }
  assert.equal(fixture.hls.trigger, trigger, "stop restores the player's dispatch");
  const swarm = createHlsSwarm({ ...base, relays: ["wss://relay.example"], mode: "shadow", abrIgnorePeers: "yes" });
  assert.equal(swarm.metrics().disabledReason, "invalid-abr-option");
  swarm.stop();
});

const coreWasm = await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url));
// Every export the loader requires, each trapping.
const trappingCore = stubCore(Object.keys(CORE_FUNCTIONS));

test("the Rust core verifies peer-first commitments, and its rejection stands", async () => {
  const playback = peerPlaybackOptions(1000);
  const forged = signedFixture({ key: playback.key, sha256: createHash("sha256").update(playback.bytes).digest("hex") }, generateSecretKey());
  let commitment = playback.options.getCommitment();
  const fixture = await linkedFixture({ ...playback.options, getCommitment: () => commitment, coreWasm, WebSocketImpl: memoryRelaySocket() });
  try {
    await until(() => fixture.swarm.metrics().core.state === "ready");
    const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 5, [], "holder"));
    channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 1);
    commitment = forged.event;
    await fixture.load();
    const metrics = fixture.swarm.metrics();
    assert.equal(metrics.segments.commitmentRejected, 1);
    assert.equal(metrics.segments.peerFirstLoaded, 1);
    assert.deepEqual(metrics.core, { state: "ready", verifier: "wasm", selection: "wasm", discovery: "wasm", links: { wasm: 1, js: 0 }, fallbacks: 0, decided: { wasm: 2, js: 0 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, peerFlow: initialPeerFlow(), originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
  } finally { await fixture.close(); }
});

test("a trapping or unloadable core hands its links and verification to JavaScript", async () => {
  for (const [source, fallbacks] of [[trappingCore, 1], [Uint8Array.from([1, 2, 3]), 0]]) {
    const playback = peerPlaybackOptions(1000);
    const fixture = await linkedFixture({ ...playback.options, coreWasm: source, WebSocketImpl: memoryRelaySocket() });
    try {
      await until(() => ["ready", "failed"].includes(fixture.swarm.metrics().core.state));
      const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 5, [], "holder"));
      channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
      assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
      const metrics = fixture.swarm.metrics();
      assert.equal(metrics.segments.peerFirstLoaded, 1);
      // The trapping core fails on the first link it opens, which then runs in JavaScript.
      assert.deepEqual(metrics.core, { state: "failed", verifier: "js", selection: "js", discovery: "js", links: { wasm: 0, js: 1 }, fallbacks, decided: { wasm: 0, js: 1 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, peerFlow: initialPeerFlow(), originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
      assert.equal(metrics.errors.byStage.core, 1);
    } finally { await fixture.close(); }
  }
});

test("a core that answers malformed results retires and the loader carries on in JavaScript", async () => {
  // The stub answers every call with an empty result. Discovery or the first
  // link, whichever asks first, retires it; core-link.test.mjs covers links alone.
  const playback = peerPlaybackOptions(1000);
  const fixture = await linkedFixture({ ...playback.options, coreWasm: stubCore([], { rs_call: -1, rs_link_new: 1 }), WebSocketImpl: memoryRelaySocket() });
  try {
    await until(() => ["ready", "failed"].includes(fixture.swarm.metrics().core.state));
    const channel = await fixture.addPeer(new ServingChannel(playback.bytes, 5, [], "holder")).catch(() => null);
    await until(() => fixture.swarm.metrics().core.state === "failed");
    const { core, errors } = fixture.swarm.metrics();
    assert.deepEqual({ ...core, links: core.links.wasm + core.links.js }, { state: "failed", verifier: "js", selection: "js", discovery: "js", links: 1, fallbacks: 1, decided: { wasm: 0, js: 0 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, peerFlow: initialPeerFlow(), originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
    assert.equal(errors.byStage.core, 1);
    if (channel && core.links.js === 1) {
      channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
      assert.deepEqual(new Uint8Array((await fixture.load()).data), playback.bytes);
    }
  } finally { await fixture.close(); }
});

test("the relay session waits for a loading core, so discovery and selection start in it", async (t) => {
  let release = null, hung = false;
  t.mock.method(globalThis, "fetch", () => hung ? new Promise(() => {})
    : new Promise((resolve) => { release = () => resolve(new Response(coreWasm, { headers: { "content-type": "application/wasm" } })); }));
  for (const slow of [true, false]) {
    hung = !slow;
    const playback = peerPlaybackOptions(1000);
    const swarm = createHlsSwarm({ ...base, ...playback.options, relays: ["wss://memory-relay.example"], WebSocketImpl: memoryRelaySocket(), coreWasm: "https://core.example/relayswarm-core.wasm" });
    const hls = { config: { loader: Loader } };
    try {
      const started = performance.now();
      swarm.attach(hls);
      await sleep(50);
      assert.equal(swarm.metrics().pubkey, null, "no session while the core loads");
      assert.equal(swarm.metrics().relays.presenceSent, 0);
      // A fragment loaded meanwhile goes to origin and leaves discovery empty.
      await new Promise((resolve) => new hls.config.fLoader({}).load(context, {}, { onSuccess: resolve }));
      if (slow) release();
      await until(() => swarm.metrics().pubkey, slow ? 1000 : 4000);
      const { core } = swarm.metrics();
      if (slow) assert.deepEqual([core.state, core.selection, core.discovery], ["ready", "wasm", "wasm"]);
      else {
        assert.ok(performance.now() - started >= 1900, "a core that never settles holds the session for its wait only");
        assert.deepEqual([core.state, core.selection, core.discovery], ["loading", "js", "js"]);
      }
    } finally { swarm.stop(); }
  }
});

test("the core option is checked and ignored outside peer-first", () => {
  for (const coreWasm of [1, {}, null, true]) {
    assert.equal(createHlsSwarm({ ...base, relays: ["wss://relay.example"], coreWasm }).metrics().disabledReason, "invalid-core-wasm");
  }
  const swarm = createHlsSwarm({ ...base, relays: ["wss://relay.example"], coreWasm });
  assert.deepEqual(swarm.metrics().core, { state: "off", verifier: "js", selection: "js", discovery: "js", links: { wasm: 0, js: 0 }, fallbacks: 0, decided: { wasm: 0, js: 0 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, peerFlow: initialPeerFlow(), originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
  swarm.stop();
});

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
    assert.equal(keyCalls, 1, "origin retention reuses the claim's captured key without a second computation");
    await until(() => fixture.swarm.metrics().segments.originLoaded === 1);
    assert.equal(fixture.swarm.metrics().bytes.held, 0, "receive-only fallback does not retain upload media");
    let trace = fixture.swarm.metrics().peerEligibilityDiagnostics;
    assert.deepEqual(trace.records.map(({ reason, matchingHave, budgetMs }) => ({ reason, matchingHave, budgetMs })),
      [{ reason: "no-budget", matchingHave: null, budgetMs: 0 }]);
    peer.receive(JSON.stringify({ t: "have", keys: [] }));
    fixture.hls.media.buffered.end = () => 15;
    await fixture.load();
    trace = fixture.swarm.metrics().peerEligibilityDiagnostics;
    assert.equal(keyCalls, 3, "positive eligibility adds its key and one captured fallback key, without diagnostic or retention hashes");
    assert.deepEqual(trace.records.at(-1), { atMs: trace.records.at(-1).atMs, cc: 0, level: 0,
      budgetMs: 120, reason: "no-have-no-wait", matchingHave: false, holders: [], haveHolders: [], staleHolders: [], heldMissHolders: [],
      budgetGeometry: { source: "buffer", positionSource: "fragment", currentTime: 10, bufferedEnd: 15, playableEnd: 15, fragmentStart: null, originReserveMs: 2000, uncappedMs: 3000 } });
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
      bufferedEnd: 13, playableEnd: 12.75, fragmentStart: 12.75, originReserveMs: 2000, uncappedMs: 500 });
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
      bufferedEnd: 0, playableEnd: -1, fragmentStart: -1, originReserveMs: 2000, uncappedMs: 2000 });
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
      bufferedEnd: null, playableEnd: null, fragmentStart: null, originReserveMs: null, uncappedMs: null });
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
    assert.equal(keys, 70, "each fallback computes one captured key; ring bookkeeping adds no key work");
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
    loader.abort();
    // Eligibility records cancellation after the asynchronous segment-key
    // digest resumes; abort callbacks do not wait for that diagnostic.
    await until(() => fixture.swarm.metrics().peerEligibilityDiagnostics.counters["aborted-before-eligibility"] === 1);
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
    peer.receive(JSON.stringify({ t: "fetching", k: playback.key, ms: 2000 }));
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

test("peer-first explores a cold link, then prefers its measured faster verified delivery", async (t) => {
  const playback = peerPlaybackOptions(), trace = [];
  const fixture = await linkedFixture({ ...playback.options, serve: true, maxUploadBytesPerSession: 0 });
  let time = null;
  try {
    const slow = await fixture.addPeer(new ServingChannel(playback.bytes, 40, trace, "slow"));
    const fast = await fixture.addPeer(new ServingChannel(playback.bytes, 2, trace, "fast"));
    for (const channel of [slow, fast]) channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    time = virtualClock(t);
    for (let i = 0; i < 7; i++) assert.deepEqual(new Uint8Array((await time.settle(fixture.load(), 400)).data), playback.bytes);
    assert.deepEqual(trace, ["slow", "slow", "slow", "slow", "fast", "fast", "fast"]);
    assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, 7);
    assert.equal(fixture.swarm.metrics().segments.originFallbacks, 0);
    assert.equal(fixture.swarm.metrics().serving, false, "exhausted contribution still receives verified peer segments");
    const measurements = fixture.swarm.metrics().peers.deliveryMeasurements;
    assert.equal(measurements.length, 2);
    assert.ok(measurements.every((value) => value.latencyMs > 0 && value.throughputBytesPerSecond > 0));
  } finally { time?.restore(); await fixture.close(); }
});

test("a failing eligible peer yields to another peer within the existing origin deadline", async (t) => {
  const playback = peerPlaybackOptions(200), trace = [];
  const fixture = await linkedFixture(playback.options);
  let time = null;
  try {
    const failing = await fixture.addPeer(new ServingChannel(null, 1, trace, "failing"));
    const healthy = await fixture.addPeer(new ServingChannel(playback.bytes, 20, trace, "healthy"));
    for (const channel of [failing, healthy]) channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    time = virtualClock(t);
    await time.settle(fixture.load(), 300); await time.settle(fixture.load(), 300);
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
  } finally { time?.restore(); await fixture.close(); }
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

test("a holder projected slower than the budget gets a longer wait only while the buffer covers it", async (t) => {
  const playback = peerPlaybackOptions(1000), trace = [];
  const fixture = await linkedFixture(playback.options);
  let time = null;
  try {
    // 5 s buffered less the 2 s origin reserve leaves 3 s: room to wait.
    const deep = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 15 } };
    fixture.hls.media = deep;
    const first = await fixture.addPeer(new ServingChannel(playback.bytes, 900, trace, "first"));
    first.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    time = virtualClock(t);
    await time.settle(fixture.load(), 1_500); // A 900 ms completion is the evidence.
    assert.equal(fixture.swarm.metrics().segments.peerWaitExtended, 0, "no evidence, no longer wait");
    first.receive(JSON.stringify({ t: "have", keys: [] }));
    const slow = await time.settle(fixture.addPeer(new ServingChannel(playback.bytes, 1110, trace, "slow")));
    Object.assign(slow, { ordered: true, maxRetransmits: null, maxPacketLifeTime: null }); // A deadline drains, not closes.
    slow.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    // 3.05 s buffered leaves 1050 ms: the projection fits, the slow holder does not.
    fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 13.05 } };
    let started = performance.now();
    await time.settle(fixture.load(), 1_500);
    const elapsed = performance.now() - started;
    let segments = fixture.swarm.metrics().segments;
    assert.deepEqual(trace, ["first", "slow"]);
    assert.equal(segments.originFallbacks, 1, "the wait never passes the buffer less the origin reserve");
    assert.ok(elapsed >= 1000 && elapsed < 1100, `fell back at the buffer limit, not later (${Math.round(elapsed)} ms)`);
    await time.advance(150); // The cancelled response drains.
    fixture.hls.media = deep;
    started = performance.now();
    assert.deepEqual(new Uint8Array((await time.settle(fixture.load(), 3_000)).data), playback.bytes);
    assert.ok(performance.now() - started > 1000, "delivered after the 1000 ms budget");
    segments = fixture.swarm.metrics().segments;
    assert.equal(segments.peerFirstLoaded, 2); assert.equal(segments.originFallbacks, 1);
    assert.ok(segments.peerWaitExtended >= 1);
  } finally { time?.restore(); await fixture.close(); }
});

test("a projection that cannot fit the buffer goes to origin before any wait or request", async () => {
  const playback = peerPlaybackOptions(1500), trace = [];
  const fixture = await linkedFixture(playback.options);
  try {
    const holder = await fixture.addPeer(new ServingChannel(playback.bytes, 600, trace, "holder"));
    holder.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    await fixture.load();
    // 2.5 s buffered leaves 500 ms against a 600 ms projection.
    fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.5 } };
    const started = performance.now();
    await fixture.load();
    assert.ok(performance.now() - started < 200, "no budget is spent on a delivery that cannot fit");
    const metrics = fixture.swarm.metrics();
    assert.deepEqual(trace, ["holder"]);
    assert.equal(metrics.segments.peerProjectedLate, 1);
    const row = metrics.peerEligibilityDiagnostics.records.at(-1);
    assert.equal(row.reason, "projected-late");
    // A single-chunk 600 ms completion: its first byte alone overruns 500 ms.
    assert.equal(row.projection.stage, "entry"); assert.equal(row.projection.holderWaitMs, 0);
    // A 600 ms timer can measure a fraction under 600; the skip rests on the
    // first byte exceeding the room, which is what is asserted.
    assert.ok(row.projection.roomMs <= 500 && row.projection.firstByteMs > row.projection.roomMs, JSON.stringify(row.projection));
    assert.deepEqual(Object.keys(row.projection).sort(), ["firstByteMs", "holderWaitMs", "rateBytesPerSecond", "roomMs", "stage", "transferMs"]);
    assert.equal(metrics.segments.originFallbacks, 1);
  } finally { await fixture.close(); }
});

test("a silent holder is abandoned after its silence floor and the load goes to origin early", async () => {
  const playback = peerPlaybackOptions(1500), trace = [];
  const fixture = await linkedFixture(playback.options);
  try {
    fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 15 } };
    const fast = await fixture.addPeer(new ServingChannel(playback.bytes, 50, trace, "fast"));
    fast.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    await fixture.load();
    fast.receive(JSON.stringify({ t: "have", keys: [] }));
    const silent = await fixture.addPeer(new ServingChannel(playback.bytes, null, trace, "silent"));
    Object.assign(silent, { ordered: true, maxRetransmits: null, maxPacketLifeTime: null }); // Reliable: cancel, not close.
    silent.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
    const started = performance.now();
    await fixture.load();
    const elapsed = performance.now() - started;
    // Three 50 ms first bytes is under the 250 ms floor; no rate is known.
    assert.ok(elapsed >= 240 && elapsed < 1000, `abandoned near 250 ms, not at the 1500 ms budget (${Math.round(elapsed)} ms)`);
    const metrics = fixture.swarm.metrics();
    assert.deepEqual(trace, ["fast", "silent"]);
    assert.equal(metrics.segments.peerAbandoned, 1); assert.equal(metrics.segments.originFallbacks, 1);
    assert.equal(metrics.peerRequestDiagnostics.records.at(-1).outcome, "abandoned");
    assert.ok(silent.sent.some((frame) => frame.t === "cancel"), "the holder is asked to stop");
  } finally { await fixture.close(); }
});

test("serial peer attempts leave time for another link and stalled peers fall back once by the deadline", async (t) => {
  // The cold slice leaves another link 25ms, so this runs on virtual time.
  for (const bothStall of [false, true]) {
    const playback = peerPlaybackOptions(120), trace = [];
    const fixture = await linkedFixture(playback.options);
    let time = null;
    try {
      const stalled = await fixture.addPeer(new ServingChannel(null, null, trace, "stalled"));
      const other = await fixture.addPeer(new ServingChannel(playback.bytes, bothStall ? null : 2, trace, "other"));
      for (const channel of [stalled, other]) channel.receive(JSON.stringify({ t: "have", keys: [playback.key] }));
      time = virtualClock(t);
      const started = time.now();
      let response = null;
      fixture.load().then((value) => { response = value; });
      await time.advanceUntil(() => trace.length === 2, 200);
      assert.ok(time.now() - started < 120, "the stalled attempt ends before the origin deadline");
      await time.advanceUntil(() => response !== null, 200);
      assert.equal(response.data.byteLength, 32);
      assert.ok(time.now() - started <= 121, "the existing origin deadline remains bounded");
      await time.advance(30);
      assert.deepEqual(trace, ["stalled", "other"]);
      assert.equal(fixture.swarm.metrics().segments.originFallbacks, bothStall ? 1 : 0);
      assert.equal(fixture.swarm.metrics().segments.peerFirstLoaded, bothStall ? 0 : 1);
    } finally {
      time?.restore();
      await fixture.close();
    }
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
    peer.receive(JSON.stringify({ t: "fetching", k: playback.key, ms: 100 }));
    const pending = fixture.load();
    setTimeout(() => peer.receive(JSON.stringify({ t: "have", add: [playback.key] })), 30);
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

test("fresh-object coordination is bounded for lying contributors and ignores unrelated ABR renditions", async (t) => {
  for (const rendition of ["main:0", "main:1"]) {
    const playback = peerPlaybackOptions(80), trace = [];
    const fixture = await linkedFixture(playback.options);
    let time = null;
    try {
      const peer = await fixture.addPeer(new ServingChannel(playback.bytes, 2, trace, "seeder"));
      peer.receive(JSON.stringify({ t: "contribution", serving: true, rendition }));
      peer.receive(JSON.stringify({ t: "fetching", k: playback.key, ms: 2000 }));
      time = virtualClock(t);
      const started = performance.now(); await time.settle(fixture.load(), 160);
      assert.ok(performance.now() - started < 160, "a malicious contributor cannot suppress HTTP recovery");
      assert.equal(fixture.swarm.metrics().segments.coordinatedWaits, rendition === "main:0" ? 1 : 0);
      assert.equal(fixture.swarm.metrics().segments.originFallbacks, 1);
      assert.deepEqual(trace, []);
    } finally { time?.restore(); await fixture.close(); }
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
    assert.equal(before.records.find((r) => r.event === "local-answer").candidates, 1);
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

test("candidate-bearing gather cap and lifecycle abort retain the1200ms soft envelope", async () => {
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
async function glareFixture(t, { polite = true, hold, gathering = false, emptyCandidates = false, rollbackSupported = true, timeout = 12000 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const secretKeys = [1, 2].map(value => { const key = new Uint8Array(32); key[31] = value; return key; })
    .sort((a, b) => getPublicKey(a) < getPublicKey(b) ? -1 : 1);
  const secretKey = secretKeys[polite ? 1 : 0], remoteKey = secretKeys[polite ? 0 : 1];
  const connections = [], received = [], gates = new Map();
  if (hold) gates.set(hold, glareDeferred());
  const state = { allow: true, onNative: () => {}, checks: [], candidatesAvailable: !emptyCandidates, localServers: null };
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
    listeners = new Map();
    constructor(configuration) { super(); this.configuration = state.localServers ? { ...configuration, iceServers: structuredClone(state.localServers) } : configuration; connections.push(this); }
    addEventListener(type, callback, options) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(callback); super.addEventListener(type, callback, options);
    }
    removeEventListener(type, callback, options) { this.listeners.get(type)?.delete(callback); super.removeEventListener(type, callback, options); }
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
        else { assert.equal(description.type, "answer"); assert.equal(this.signalingState, "have-remote-offer"); this.signalingState = "stable"; this.localDescription = description; if (state.candidatesAvailable) this.iceGatheringState = "complete"; }
        if (description.type !== "rollback" && state.candidatesAvailable) this.localDescription = { ...description, sdp: `${description.sdp}\r\na=candidate:fixture 1 udp 1 fixture.local 9 typ ${state.localServers ? "relay" : "host"}\r\n` };
      });
    }
    candidate() {
      this.localDescription = { ...this.localDescription, sdp: `${this.localDescription.sdp}\r\na=candidate:fixture 1 tcp 1 fixture.local 9 typ relay\r\n` };
      this.dispatchEvent(new Event("icecandidate"));
    }
    complete() { this.iceGatheringState = "complete"; this.dispatchEvent(new Event("icegatheringstatechange")); }
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

for (const type of ["offer", "answer"]) test(`candidate-free ${type} waits beyond the soft gather cap for a real local candidate`, async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 });
  let pc;
  if (type === "offer") pc = await f.start();
  else { f.offer(); await glareFlush(); pc = f.connections[0]; }
  assert.ok(pc.localDescription); assert.equal(pc.iceGatheringState, "gathering");
  await f.tick(1200);
  assert.equal(f.received.length, 0, "the soft cap must never publish candidate-free SDP");
  await f.tick(983);
  assert.equal(f.received.length, 0); assert.equal(pc.closes, 0);
  pc.candidate(); await glareFlush();
  const sent = f.received.filter(value => value.type === type);
  assert.equal(sent.length, 1, "the first late candidate permits the original authenticated signal");
  assert.match(sent[0].payload.sdp, /^a=candidate:/m);
  assert.equal(pc.listeners.get("icecandidate")?.size ?? 0, 0, "the gather listener is retired after signalling");
  if (type === "offer") { f.signal("answer", sent[0].requestId); await glareFlush(); pc.localChannel.open(); }
  else pc.incoming().open();
  await glareFlush(); assert.deepEqual(f.swarm.peerConnections(), [pc]);
});

for (const type of ["offer", "answer"]) test(`candidate-free ${type} retains the original dial deadline and clears gathering listeners`, async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 });
  let pc;
  if (type === "offer") pc = await f.start();
  else { f.offer(); await glareFlush(); pc = f.connections[0]; }
  await f.tick(7999);
  assert.equal(f.received.length, 0); assert.equal(pc.closes, 0);
  await f.tick(1);
  assert.equal(pc.closes, 1); assert.equal(f.swarm.metrics().peers.dialsTimedOut, 1);
  assert.equal(f.swarm.metrics().peers.dialling, 0);
  assert.equal(pc.listeners.get("icecandidate")?.size ?? 0, 0);
  assert.equal(pc.listeners.get("icegatheringstatechange")?.size ?? 0, 0);
  pc.candidate(); pc.complete(); await f.tick(1000);
  assert.equal(f.received.length, 0, "late native events cannot revive an expired negotiation");
});

for (const type of ["offer", "answer"]) test(`completed candidate-free ${type} fails closed without waiting for the dial deadline`, async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 });
  let pc;
  if (type === "offer") pc = await f.start();
  else { f.offer(); await glareFlush(); pc = f.connections[0]; }
  pc.complete(); await glareFlush();
  assert.equal(f.received.length, 0); assert.equal(pc.closes, 1);
  assert.equal(f.swarm.metrics().peers.dialsFailed, 1);
  assert.equal(f.swarm.metrics().peers.dialsTimedOut, 0);
  assert.equal(pc.listeners.get("icecandidate")?.size ?? 0, 0);
  assert.equal(pc.listeners.get("icegatheringstatechange")?.size ?? 0, 0);
});

test("explicit local candidate retry replaces only a remembered empty-candidate dial using the future factory configuration", async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 }), old = await f.start();
  old.complete(); await glareFlush();
  assert.equal(old.closes, 1); assert.equal(f.swarm.metrics().peers.dialsFailed, 1);
  assert.equal(f.received.length, 0, 'the failed actual gathered() path disclosed no candidate-free offer');
  const servers = [{ urls: 'turns:changed.example:5549?transport=tcp', username: 'local-test-lease', credential: 'fixture-only' }];
  f.state.localServers = servers; f.state.candidatesAvailable = true;
  assert.equal(typeof f.swarm.retryLocalCandidates, 'function', 'explicit local-candidate retry API is missing');
  assert.equal(f.swarm.retryLocalCandidates(), 1);
  assert.equal(f.swarm.retryLocalCandidates(), 0, 'the same local failure authorises only one attempt');
  await glareFlush();
  assert.equal(f.connections.length, 2, 'a new current-config PC starts without advancing the old60s cooldown');
  const fresh = f.connections[1]; assert.deepEqual(fresh.configuration.iceServers, servers);
  fresh.complete(); await glareFlush();
  const sent = f.received.find(value => value.type === 'offer'); assert(sent); assert.match(sent.payload.sdp, /typ relay/);
  f.signal('answer', sent.requestId); await glareFlush(); fresh.localChannel.open(); await glareFlush();
  assert.deepEqual(f.swarm.peerConnections(), [fresh]);
  assert.equal(f.swarm.retryLocalCandidates(), 0); assert.equal(f.connections.length, 2, 'a connected link is never recreated');
});

for (const invalid of ['throwing-description', 'nonstring-sdp']) test(`local candidate retry never treats ${invalid} as a known empty gather`, async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 }), old = await f.start();
  const readable = old.localDescription; let reads = 0;
  Object.defineProperty(old, 'localDescription', { configurable: true, get() {
    reads++;
    if (invalid === 'throwing-description') throw new Error('fixture unreadable native description');
    return { ...readable, sdp: 42 };
  } });
  old.complete(); await glareFlush();
  assert.equal(reads, 2, 'classification reuses the existing gather read plus the existing diagnostic read');
  assert.equal(old.closes, 1); assert.equal(f.swarm.metrics().peers.dialsFailed, 1); assert.equal(f.received.length, 0);
  Object.defineProperty(old, 'localDescription', { configurable: true, writable: true, value: readable });
  f.state.candidatesAvailable = true; f.state.localServers = [{ urls: 'turns:changed.example:5549?transport=tcp' }];
  assert.equal(typeof old.localDescription.sdp, 'string', 'the invalid getter is repaired before notification');
  assert.equal(f.swarm.retryLocalCandidates(), 0, 'unknown/native read failure must retain its ordinary cooldown');
  await glareFlush(); assert.equal(f.connections.length, 1);
});

test("local candidate retry also remembers an actual completed empty-answer failure", async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 });
  f.offer(); await glareFlush(); const old = f.connections[0]; old.complete(); await glareFlush();
  assert.equal(f.swarm.metrics().peers.dialsFailed, 1); assert.equal(f.received.length, 0);
  f.state.candidatesAvailable = true;
  assert.equal(f.swarm.retryLocalCandidates(), 1); await glareFlush();
  assert.equal(f.connections.length, 2); f.connections[1].complete(); await glareFlush();
  assert.equal(f.received.filter(value => value.type === 'offer').length, 1);
  assert.equal(f.swarm.retryLocalCandidates(), 0);
});

test("local candidate retry cannot release a newer generic cooldown written in the same millisecond", async t => {
  t.mock.method(Date, 'now', () => 2000000000000);
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 }), old = await f.start();
  old.complete(); await glareFlush(); assert.equal(f.swarm.metrics().peers.dialsFailed, 1);
  t.mock.method(Object.getPrototypeOf(old), 'createAnswer', async () => { throw new Error('fixture native failure'); });
  f.offer('new-unrelated-native-failure'); await glareFlush();
  assert.equal(f.connections.length, 2); assert.equal(f.swarm.metrics().peers.dialsFailed, 2);
  assert.equal(f.swarm.retryLocalCandidates(), 0, 'the old local-candidate marker cannot unlock an equal-timestamp generic cooldown');
  f.peer.announcePresence({ role: 'viewer', transports: [{ type: 'webrtc', publicKey: f.peer.pubkey }], ticket: 'remote-ticket' });
  await f.tick(1500); assert.equal(f.connections.length, 2);
});

for (const ending of ['timeout', 'refusal']) test(`local candidate retry leaves ${ending} cooldown unchanged`, async t => {
  const f = await glareFixture(t, { gathering: ending === 'timeout', emptyCandidates: ending === 'timeout', timeout: 8000 }), pc = await f.start();
  if (ending === 'timeout') { await f.tick(7999); assert.equal(pc.closes, 0); await f.tick(1); assert.equal(f.swarm.metrics().peers.dialsTimedOut, 1); }
  else { const sent = f.received.find(value => value.type === 'offer'); f.signal('reject', sent.requestId); await glareFlush(); assert.equal(f.swarm.metrics().peers.dialsRejected, 1); }
  assert.equal(f.swarm.retryLocalCandidates(), 0); await glareFlush(); assert.equal(f.connections.length, 1);
});

for (const ending of ['admission-revoked', 'stop', 'stop-during-admission']) test(`local candidate retry respects ${ending}`, async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true, timeout: 8000 }), old = await f.start();
  old.complete(); await glareFlush(); assert.equal(f.swarm.metrics().peers.dialsFailed, 1);
  f.state.candidatesAvailable = true; let release;
  if (ending === 'stop') { f.swarm.stop(); assert.equal(f.swarm.retryLocalCandidates(), 0); }
  else {
    if (ending === 'admission-revoked') f.state.allow = false;
    else f.state.admit = () => new Promise(resolve => { release = resolve; });
    assert.equal(f.swarm.retryLocalCandidates(), 1, 'count denotes a normal admission attempt, not an admitted PC');
    if (ending === 'stop-during-admission') { await glareFlush(); assert(release); f.swarm.stop(); release(true); }
  }
  await glareFlush(); assert.equal(f.connections.length, 1); assert.equal(f.swarm.retryLocalCandidates(), 0);
});

test("stop retires candidate-free gathering before a late candidate can signal", async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true }), pc = await f.start();
  await f.tick(1200); f.swarm.stop(); await glareFlush();
  assert.equal(pc.closes, 1);
  assert.equal(pc.listeners.get("icecandidate")?.size ?? 0, 0);
  assert.equal(pc.listeners.get("icegatheringstatechange")?.size ?? 0, 0);
  pc.candidate(); pc.complete(); await f.tick(12000);
  assert.equal(f.received.length, 0); assert.equal(f.swarm.metrics().peers.dialsTimedOut, 0);
});

test("glare retires the candidate-free offer wait and signals only the adopted answer", async t => {
  const f = await glareFixture(t, { gathering: true, emptyCandidates: true }), pc = await f.start();
  await f.tick(1200); f.offer(); await glareFlush();
  assert.equal(pc.trace.filter(value => value === "local:rollback").length, 1);
  assert.equal(pc.localDescription.type, "answer"); assert.equal(f.received.length, 0);
  await f.tick(1200); pc.candidate(); await glareFlush();
  assert.deepEqual(f.received.map(value => value.type), ["answer"]);
  assert.equal(f.received[0].requestId, "winning-offer");
  assert.equal(pc.closes, 0); assert.equal(pc.listeners.get("icecandidate")?.size ?? 0, 0);
  pc.incoming().open(); await glareFlush();
  assert.deepEqual(f.swarm.peerConnections(), [pc]);
});

test("polite glare reuses the pending PC and original slot with one winning channel and request ID", async t => {
  const f = await glareFixture(t), pc = await f.start();
  assert.deepEqual(f.swarm.peerConnections(), [], "the outgoing glare candidate is not an accepted peer");
  const outgoing = f.received.find(value => value.type === "offer"); assert.ok(outgoing);
  const abandoned = pc.localChannel, staleOpen = abandoned.openCallbacks[0];
  f.offer(); await glareFlush();
  assert.deepEqual(f.swarm.peerConnections(), [], "a winning offer still waits for its accepted data channel");
  assert.equal(f.connections.length, 1); assert.equal(pc.closes, 0); assert.equal(abandoned.readyState, "closed");
  assert.deepEqual(pc.trace.filter(value => !value.startsWith("admit:")), ["createOffer", "local:offer", "local:rollback", "remote:offer", "createAnswer", "local:answer"]);
  assert.deepEqual(f.received.filter(value => value.type === "answer").map(value => value.requestId), ["winning-offer"]);
  f.signal("answer", outgoing.requestId); staleOpen(); await glareFlush();
  assert.equal(pc.trace.filter(value => value === "remote:answer").length, 0); assert.equal(pc.closes, 0);
  const channel = pc.incoming(); channel.open(); await glareFlush();
  assert.equal(f.swarm.metrics().peers.connected, 1); assert.equal(f.swarm.metrics().peers.linksOpened, 1);
  assert.deepEqual(f.swarm.peerConnections(), [pc], "glare exposes only the single accepted native connection");
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
    assert.equal(f.state.spent(f.context), true, "inactivity does not renew the eviction budget");
  }
});

test("neighbour success requires the exact selected generation and cannot credit a sibling or A-to-B-to-A result", () => {
  const f = advisoryFixture(), attempt = f.begin(); f.state.replaced(attempt, "c".repeat(64));
  const audio = f.state.demand("audio", "audio:0", "d".repeat(64));
  assert.equal(f.state.verified(audio), true); assert.equal(f.state.spent(f.context), true);
  f.state.context("main", "main:1"); const newMain = f.state.demand("main", "main:0", f.key); newMain.spentAt = f.state.clock();
  assert.equal(f.state.verified(f.context), false); assert.equal(f.state.spent(newMain), true);
  assert.equal(f.state.verified(newMain), true); assert.equal(f.state.spent(newMain), false);
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
  const f = advisoryFixture(); f.context.spentAt = f.state.clock();
  for (let i = 0; i < 4; i++) { f.advance(10_000); f.state.context("main", "main:0"); }
  f.state.demand("main", "main:0", "e".repeat(64));
  assert.deepEqual(f.context.keys, ["e".repeat(64)]); assert.equal(f.state.spent(f.context), true);
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
      let haveChecks = 0;
      for (const prototype of [NeighbourDiscovery.prototype, CoreNeighbourDiscovery.prototype]) {
        const valid = prototype.valid;
        t.mock.method(prototype, "valid", function (...args) { haveChecks++; return valid.apply(this, args); });
      }
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
    // The origin path holds a segment only after its key digest settles.
    f.announce(); await until(() => f.state.checks > 0 && f.swarm.metrics().bytes.held > 0);
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
  peer.receive(JSON.stringify({ t: "fetching", k: key, ms: 2000 }));
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

test("cold delivery retains deadline time when measured alternatives cannot fit", { skip: testCore ? "patches PeerSelection.prototype, which core selection does not use" : false }, async t => {
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
    // The clock starts at a fractional real time, so (t0 + 1500) - t0 may round.
    assert.ok(Math.abs(f.fixture.swarm.metrics().peerRequestDiagnostics.records.at(-1).timeoutMs - 1500) < 1e-6);
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

test("session counts events rejected by the age window and samples validated signal ages", () => {
  let deliver;
  const pool = { onEvent(handler) { deliver = handler; return () => {}; }, subscribe() { return "1"; }, unsubscribe() {}, publish() {} };
  const session = new RelaySwarmSession({ pool, swarmId: base.swarmId, maxEventAgeSeconds: 60 });
  const sender = new RelaySwarmSession({ pool, swarmId: base.swarmId });
  session.start();
  const now = Math.floor(Date.now() / 1000);
  const presence = (createdAt, tags = [["x", base.swarmId]]) => finalizeEvent({ kind: 24170, created_at: createdAt, tags, content: "{}" }, sender.secretKey);
  const signal = sender.sendSignal(session.pubkey, { type: "offer", transport: "webrtc", requestId: "clock-probe", payload: { type: "offer" } });
  const signalAt = (createdAt) => finalizeEvent({ ...signal, created_at: createdAt }, sender.secretKey);
  const forged = finalizeEvent({ kind: 24171, created_at: now - 50, tags: [["x", base.swarmId], ["p", session.pubkey]], content: "not ciphertext" }, sender.secretKey);
  try {
    assert.deepEqual(session.clockDiagnostics(), { aheadRejected: 0, staleRejected: 0, maxAheadSeconds: 0, signalSamples: 0, signalAgeMedianSeconds: null });
    deliver(presence(now + 120));
    deliver(signalAt(now + 45));
    deliver(presence(now - 300));
    deliver(presence(now + 120, [["x", "another-swarm-id"]]));
    deliver(presence(now - 20));
    deliver(forged);
    for (const age of [3, 4, 5]) deliver(signalAt(now - age));
    const clock = session.clockDiagnostics();
    assert.equal(clock.aheadRejected, 2);
    assert.equal(clock.staleRejected, 1);
    assert.ok(clock.maxAheadSeconds >= 119 && clock.maxAheadSeconds <= 120);
    assert.equal(clock.signalSamples, 3);
    assert.ok(clock.signalAgeMedianSeconds >= 4 && clock.signalAgeMedianSeconds <= 5);
    for (let i = 0; i < 70; i++) deliver(signalAt(now - (i % 2)));
    assert.equal(session.clockDiagnostics().signalSamples, 64);
  } finally { session.close(); sender.close(); }
});

test("pool counts since drops only when since alone caused them, and classifies timestamp refusals", async () => {
  let socket;
  class Socket extends EventTarget {
    constructor(url) { super(); this.url = url; socket = this; queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send() {}
    close() {}
    receive(id, event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EVENT", id, event]) })); }
    frame(frame) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
  }
  const pool = new RelayPool(["wss://relay.example"], { WebSocketImpl: Socket });
  await pool.connect();
  try {
    const now = Math.floor(Date.now() / 1000), me = "a".repeat(64), other = "b".repeat(64);
    const id = pool.subscribe({ kinds: [24171], "#x": [base.swarmId], "#p": [me], since: now - 60 });
    const sign = (kind, createdAt, p) => finalizeEvent({ kind, created_at: createdAt, tags: [["x", base.swarmId], ["p", p]], content: "t" }, generateSecretKey());
    let received = 0; pool.onEvent(() => received++);
    socket.receive(id, sign(24171, now - 600, me));
    assert.equal(pool.sinceDropped, 1);
    socket.receive(id, sign(24170, now - 600, me));
    socket.receive(id, sign(24171, now - 600, other));
    socket.receive(id, sign(24171, now, other));
    assert.equal(pool.sinceDropped, 1, "kind and recipient failures are not since drops");
    assert.equal(received, 0, "the drop itself is unchanged");
    socket.receive(id, sign(24171, now, me));
    assert.equal(received, 1);
    assert.equal(pool.sinceDropped, 1);
    socket.frame(["OK", "e1", false, "invalid: created_at too far in the future"]);
    socket.frame(["OK", "e2", false, "blocked: spam"]);
    socket.frame(["OK", "e3", false, "invalid: event timestamp too old"]);
    assert.equal(pool.rejected, 3);
    assert.equal(pool.rejectedTimestamp, 2);
  } finally { pool.close(); }
});

test("origin clock offset reads Date and Age from XHR-like and Response-like details", () => {
  const at = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  const xhr = (headers) => ({ getResponseHeader: (name) => headers[name] ?? null });
  const response = (headers) => ({ headers: new Headers(headers) });
  assert.equal(originClockOffsetMs(xhr({ Date: "Wed, 21 Oct 2026 07:28:05 GMT" }), at), 5000);
  assert.equal(originClockOffsetMs(response({ Date: "Wed, 21 Oct 2026 07:27:50 GMT" }), at), -10000);
  // RFC 850 carries GMT and parses; asctime has no zone and would read as local time.
  assert.equal(originClockOffsetMs(xhr({ Date: "Wednesday, 21-Oct-26 07:28:05 GMT" }), at), 5000);
  assert.equal(originClockOffsetMs(xhr({ Date: "Wed Oct 21 07:28:05 2026" }), at), null);
  assert.equal(originClockOffsetMs(response({ Date: "Wed, 21 Oct 2026 07:28:00 GMT", Age: "7" }), at), 7000);
  assert.equal(originClockOffsetMs(xhr({ Date: "Wed, 21 Oct 2026 07:28:00 GMT", Age: "-3" }), at), 0);
  assert.equal(originClockOffsetMs(xhr({ Date: "Wed, 21 Oct 2026 07:28:00 GMT", Age: "soon" }), at), 0);
  assert.equal(originClockOffsetMs(xhr({}), at), null);
  assert.equal(originClockOffsetMs(xhr({ Date: "not a date" }), at), null);
  assert.equal(originClockOffsetMs(null, at), null);
  assert.equal(originClockOffsetMs({ getResponseHeader() { throw new Error("blocked"); } }, at), null);
  assert.equal(originClockOffsetMs(xhr({ Date: "Wed, 21 Oct 2026 07:28:00 GMT", Age: "700000" }), at), null);
  assert.equal(originClockOffsetMs(xhr({ Date: "Wed, 21 Oct 2020 07:28:00 GMT" }), at), null);
  assert.deepEqual(originClockSummary([]), { samples: 0, offsetSeconds: null });
  assert.deepEqual(originClockSummary([1200, 4600, -3000]), { samples: 3, offsetSeconds: 5 });
});

const serving = (rendition = "main:0") => JSON.stringify({ t: "contribution", serving: true, rendition });
const haveFrame = (...keys) => JSON.stringify({ t: "have", keys });

test("holder labels tie request, wait and measurement rows to a link without exposing keys", async () => {
  const playback = peerPlaybackOptions(300), trace = [];
  const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket() });
  const rows = () => fixture.swarm.metrics().peerEligibilityDiagnostics.records;
  try {
    const first = await fixture.addPeer(new ServingChannel(playback.bytes, 1, trace, "first"));
    const second = await fixture.addPeer(new ServingChannel(playback.bytes, 1, trace, "second"));
    first.receive(serving()); second.receive(serving());
    await fixture.load();
    const waiting = rows().filter(row => row.reason !== "no-budget");
    assert.ok(waiting.length >= 1);
    for (const row of waiting) {
      assert.deepEqual(row.holders, [1, 2]); assert.deepEqual(row.haveHolders, []); assert.deepEqual(row.staleHolders, []);
      assert.deepEqual(row.heldMissHolders, [], "no held miss is recorded without a held-miss rule");
    }
    first.receive(haveFrame(playback.key));
    await fixture.load();
    let row = rows().at(-1);
    assert.equal(row.reason, "have-at-entry");
    assert.deepEqual([row.holders, row.haveHolders, row.staleHolders], [[1, 2], [1], []]);
    const requests = fixture.swarm.metrics().peerRequestDiagnostics.records;
    assert.deepEqual(trace.slice(-1), ["first"]); assert.equal(requests.at(-1).holder, 1);
    second.receive(haveFrame(playback.key)); first.receive(haveFrame());
    await fixture.load();
    assert.deepEqual(rows().at(-1).haveHolders, [2]); assert.equal(fixture.swarm.metrics().peerRequestDiagnostics.records.at(-1).holder, 2);
    // A zero budget neither hashes a key nor inspects links, so it gains no label fields.
    fixture.hls.media = { currentTime: 0, buffered: { length: 0 } };
    await fixture.load();
    row = rows().at(-1);
    assert.equal(row.reason, "no-budget");
    for (const field of ["holders", "haveHolders", "staleHolders", "heldMissHolders"]) assert.ok(!(field in row), `no-budget rows omit ${field}`);
    fixture.hls.media = undefined;
    // Labels are small local counters that survive a relink of the same remote peer.
    const measured = () => Object.fromEntries(fixture.swarm.metrics().peers.deliveryMeasurements.map(value => [value.pubkey, value.holder]));
    assert.deepEqual(measured(), { [fixture.peers[0].pubkey]: 1, [fixture.peers[1].pubkey]: 2 });
    first.close(); await until(() => fixture.swarm.metrics().peers.connected === 1);
    const count = fixture.connections.length;
    fixture.peers[0].sendSignal(fixture.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "relink-same-peer", payload: { sdp: "fixture-offer" } });
    await until(() => fixture.connections.length > count);
    const relinked = new RecordedChannel(), event = new Event("datachannel"); event.channel = relinked; fixture.connections[count].dispatchEvent(event);
    await until(() => fixture.swarm.metrics().peers.connected === 2);
    assert.deepEqual(measured(), { [fixture.peers[0].pubkey]: 1, [fixture.peers[1].pubkey]: 2 });
    // A new remote peer takes the next label.
    await fixture.addPeer(new RecordedChannel());
    assert.equal(measured()[fixture.peers[2].pubkey], 3);
    const snapshot = fixture.swarm.metrics(), labels = [
      ...snapshot.peerEligibilityDiagnostics.records.flatMap(record => [...(record.holders || []), ...(record.haveHolders || []), ...(record.staleHolders || [])]),
      ...snapshot.peerRequestDiagnostics.records.map(record => record.holder),
      ...snapshot.peers.deliveryMeasurements.map(value => value.holder)];
    assert.ok(labels.length > 0 && labels.every(label => Number.isSafeInteger(label) && label >= 1 && label <= 3), "labels are small integers");
    const encoded = JSON.stringify([snapshot.peerEligibilityDiagnostics, snapshot.peerRequestDiagnostics]);
    for (const peer of fixture.peers) assert.ok(!encoded.includes(peer.pubkey), "rows never carry a key");
    // Returned snapshots own their arrays.
    const owned = fixture.swarm.metrics().peerEligibilityDiagnostics.records.find(record => record.holders?.length);
    owned.holders.push(99); owned.heldMissHolders.push(99);
    assert.ok(!fixture.swarm.metrics().peerEligibilityDiagnostics.records.some(record => record.heldMissHolders?.includes(99)));
    assert.ok(!fixture.swarm.metrics().peerEligibilityDiagnostics.records.some(record => record.holders?.includes(99)));
    const sent = JSON.stringify([first.sent, second.sent, relinked.sent]);
    assert.ok(!sent.includes('"holder"'), "labels are never sent to a peer");
  } finally { await fixture.close(); }
});

test("the numeric operator report keeps exactly its eight fields and the server rejects a holder field", async () => {
  const fields = ["durationMs", "peerBytes", "uploadedBytes", "originMediaRequests", "originMediaBytes", "stalls", "stallMs", "fatalErrors"];
  const source = await readFile(new URL("../demo/client.mjs", import.meta.url), "utf8");
  const builders = [...source.matchAll(/const values = \{([^}]*)\};/gu)].filter(([, body]) => fields.every(field => body.includes(`${field}:`)));
  assert.equal(builders.length, 1, "exactly one numeric report builder");
  const keys = [...builders[0][1].matchAll(/(?:^|,)\s*([A-Za-z]+):/gu)].map(match => match[1]);
  assert.deepEqual([...keys].sort(), [...fields].sort());
  assert.ok(!/holder/iu.test(builders[0][1]));
  const controls = createOperatorControls({ telemetry: true });
  const post = async values => {
    const request = Readable.from([Buffer.from(JSON.stringify({ v: 1, reportId: "a".repeat(32), sequence: 1, values }))]);
    Object.assign(request, { method: "POST", headers: { origin: "https://demo.example", "content-type": "application/json" } });
    let code; await controls.handle(request, { writeHead(status) { code = status; return this; }, end() {} }, "/reports", "https://demo.example", {});
    return code;
  };
  const values = Object.fromEntries(fields.map((field, index) => [field, index + 1]));
  assert.equal(await post({ ...values, holder: 1 }), 400);
  assert.equal(await post(values), 200);
});

// A holder on a reliable channel: an abandoned or timed-out request is
// cancelled (the link drains and stays open) and the holder answers `none`.
class HolderChannel extends ServingChannel {
  constructor(...args) { super(...args); Object.assign(this, { ordered: true, maxRetransmits: null, maxPacketLifeTime: null }); }
  send(data) {
    const frame = typeof data === "string" ? JSON.parse(data) : null;
    // With bodyDelayMs the metadata comes after delayMs and the payload later.
    if (frame?.t === "want" && this.bodyDelayMs != null && this.delayMs !== null) {
      RecordedChannel.prototype.send.call(this, data); this.trace.push(this.label);
      const half = this.bytes.byteLength / 2;
      setTimeout(() => {
        if (this.readyState !== "open") return;
        this.receive(JSON.stringify({ t: "meta", id: frame.id, size: this.bytes.byteLength })); this.receive(this.bytes.slice(0, half).buffer);
      }, this.delayMs);
      setTimeout(() => {
        if (this.readyState !== "open") return;
        this.receive(this.bytes.slice(half).buffer); this.receive(JSON.stringify({ t: "eof", id: frame.id }));
      }, this.bodyDelayMs);
      return;
    }
    super.send(data);
    if (!frame) return;
    if (frame.t === "cancel") setTimeout(() => { if (this.readyState === "open") this.receive(JSON.stringify({ t: "none", id: frame.id })); }, 1);
  }
}

// A commitment for whatever segment key the context URL hashes to, so every
// load in a sequence can be delivered and verified. `unavailable` makes the
// commitment fetch fail.
function keyedCommitments(bytes) {
  const secret = generateSecretKey();
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000), tags: [["d", "test"], ["relayswarm", "redistribute", "1"]], content: "" }, secret);
  // `bytes` may be replaced between loads to change the committed size.
  const state = { unavailable: false, streamEvent, bytes };
  state.getCommitment = (ctx) => {
    if (state.unavailable) throw new Error("commitment unavailable");
    const sha256 = createHash("sha256").update(state.bytes).digest("hex");
    const key = createHash("sha256").update(`${base.swarmId}\n${new URL(ctx.url).pathname}`).digest("hex");
    const fields = { streamEventId: streamEvent.id, swarmId: base.swarmId, key, rendition: String(ctx.frag?.level ?? 0), sequence: 1, discontinuity: 0, part: null, sha256, size: state.bytes.byteLength,
      expiresAt: Math.floor(Date.now() / 1000) + 60 };
    return finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: Math.floor(Date.now() / 1000), tags: [["x", fields.swarmId], ["e", fields.streamEventId]], content: commitmentContent(fields) }, secret);
  };
  return state;
}

// A full two-link neighbourhood: an idle link and a stuck holder that serves
// the current rendition but never announces any segment. A separate candidate
// presents each demanded key. Date.now is shifted to control elapsed time
// without waiting; every shift stays under the 30 s freshness windows.
async function staleHolderFixture(t, { maxPeers = 2, answering = false, sibling = false, loader = Loader, serve = null, firstServes = false, firstServe = null, ...options } = {}) {
  const playback = peerPlaybackOptions(150), realNow = Date.now.bind(Date), shift = { ms: 0 };
  t.mock.method(Date, "now", () => realNow() + shift.ms);
  // With `serve`, the holder is a ServingChannel (its delayMs may be changed
  // between loads; null never answers) and every segment key has a signed commitment.
  const requests = [], commitments = serve ? keyedCommitments(serve.commitmentBytes ?? serve.bytes) : null;
  const holderChannel = serve ? new (serve.Channel ?? HolderChannel)(serve.bytes, serve.delayMs, requests, "holder") : new RecordedChannel();
  const f = await linkedFixture({ ...playback.options, ...(commitments ? { streamEvent: commitments.streamEvent, getCommitment: commitments.getCommitment } : {}),
    WebSocketImpl: memoryRelaySocket(), ticket: "own-ticket",
    admit: async () => true, maxPeers, minLinkLifeMs: 1, idleEvictMs: 1, evictionCooldownMs: 1, ...options }, loader);
  const own = f.swarm.metrics().pubkey;
  // The first link is idle, or with `sibling` serves the audio rendition only.
  // With `firstServe` the first link is a second holder (same trace, labelled "other").
  const otherChannel = firstServe ? new (firstServe.Channel ?? HolderChannel)(firstServe.bytes, firstServe.delayMs, requests, "other") : null;
  const first = await f.addPeer(otherChannel ?? undefined); const holder = await f.addPeer(holderChannel);
  holder.receive(serving());
  if (sibling) first.receive(serving("audio:0"));
  if (firstServes) first.receive(serving());
  const holderKey = f.peers[1].pubkey;
  const candidate = () => {
    const session = new RelaySwarmSession({ pool: f.pool, swarmId: base.swarmId }), offers = [];
    session.start(); f.peers.push(session);
    session.onSignal(({ payload }) => {
      if (payload.type !== "offer") return;
      offers.push(payload);
      if (answering) session.sendSignal(own, { type: "answer", transport: "webrtc", requestId: payload.requestId, payload: { ticket: "fixture-ticket", sdp: "fixture-answer" } });
    });
    const announce = (...keys) => session.announcePresence({ role: "viewer", transports: [{ type: "webrtc", publicKey: session.pubkey }],
      have: keys, open: true, ticket: "fixture-ticket" });
    return { session, offers, announce };
  };
  const rank = (pubkey, key) => [...pubkey].map((digit, i) => (parseInt(digit, 16) ^ parseInt(key[i], 16)).toString(16)).join("");
  let counter = 0;
  // Retain the fixture's distinct, consistently ranked keys. Wait authority
  // comes from the actual FETCH lease announced in load(), not that rank.
  const next = () => {
    for (;;) {
      const name = `stale-${counter++}`, key = createHash("sha256").update(`${base.swarmId}\n/${name}.ts`).digest("hex");
      if (rank(holderKey, key) < rank(own, key)) return { name, key };
    }
  };
  const load = (name, level = 0) => {
    const key = createHash("sha256").update(`${base.swarmId}\n/${name}.ts`).digest("hex");
    holder.receive(JSON.stringify({ t: "fetching", k: key, ms: 2000 }));
    return new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context,
      url: `https://origin.example/${name}.ts`, frag: { ...context.frag, level } }, {}, { onSuccess: resolve }));
  };
  const rows = () => f.swarm.metrics().peerEligibilityDiagnostics.records;
  const counters = () => f.swarm.metrics().peerEligibilityDiagnostics.counters;
  const discovery = () => f.swarm.metrics().neighbourDiscovery.counters;
  const touch = () => holder.receive(serving());
  const label = pubkey => f.swarm.metrics().peers.deliveryMeasurements.find(value => value.pubkey === pubkey)?.holder;
  // A wait that reaches its deadline is recorded as wait-expired, or as
  // wait-aborted when the origin timer wins the race with the wait loop at the
  // same instant. Both are misses; a caller abort is a wait-aborted that is not.
  const outcomes = () => counters()["wait-expired"] + counters()["wait-aborted"];
  const miss = async (via, count = 1) => {
    const target = outcomes() + count;
    for (let i = 0; i < 100 && outcomes() < target; i++) {
      const segment = next(); via.announce(segment.key); await sleep(30); touch(); await load(segment.name); await sleep(5);
    }
    assert.equal(outcomes(), target, "the stuck holder produced the deadline outcomes");
  };
  // The holder holds the demanded key at the decision and then fails to deliver
  // it (its channel never answers); the load ends at origin. Its HAVE is then
  // cleared, as when its announced window moves on.
  const fail = async (via, { keepHave = false, level = 0 } = {}) => {
    const segment = next(); via.announce(segment.key); await sleep(30); touch();
    holder.receive(haveFrame(segment.key));
    await load(segment.name, level); await sleep(5);
    if (!keepHave) holder.receive(haveFrame());
    return segment;
  };
  // Fail until the holder has taken `target` held misses. A slow runner can end
  // a load through a decline that asks nobody and so charges nobody, which is
  // correct; the bound keeps the loop finite and the message shows the path.
  const failUntil = async (via, target, options = {}) => {
    for (let i = 0; i < 12 && discovery().heldMiss < target; i++) await fail(via, options);
    assert.equal(discovery().heldMiss, target, `held misses reached the target: ${JSON.stringify({ counters: counters(), discovery: discovery(),
      rows: rows().map(row => [row.reason, row.projection?.stage ?? null, row.haveHolders, row.heldMissHolders]) })}`);
  };
  // The holder holds the key and delivers it: a verified peer segment.
  const deliver = async via => {
    const segment = next(), loaded = f.swarm.metrics().segments.peerFirstLoaded;
    via.announce(segment.key); await sleep(30); touch();
    holder.receive(haveFrame(segment.key));
    await load(segment.name); await sleep(5); holder.receive(haveFrame());
    assert.equal(f.swarm.metrics().segments.peerFirstLoaded, loaded + 1, "a verified segment came from the holder");
    return segment;
  };
  // A demand the holder does not hold: its wait row shows who is stale then.
  const trigger = async via => {
    const segment = next(); via.announce(segment.key); await sleep(30); touch();
    await load(segment.name); await sleep(30);
    return rows().filter(row => row.reason === "no-have-wait").at(-1);
  };
  return { ...f, shift, holderKey, holderChannel: holder, siblingChannel: first, requests, commitments, candidate, next, load, rows, counters, outcomes, discovery, touch, label, miss, fail, failUntil, deliver, trigger };
}

test("a linked holder that is never ahead stops suppressing discovery after four misses over ten seconds", async t => {
  const f = await staleHolderFixture(t);
  try {
    const via = f.candidate();
    await f.miss(via, 3);
    assert.equal(f.discovery().checks, 0, "fewer than four misses keep today's behaviour"); assert.equal(via.offers.length, 0);
    await f.miss(via, 1);
    assert.equal(f.outcomes(), 4);
    assert.equal(f.discovery().checks, 0, "four misses in under ten seconds keep today's behaviour"); assert.equal(via.offers.length, 0);
    assert.ok(f.rows().every(row => row.staleHolders === undefined || row.staleHolders.length === 0));
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); via.announce(segment.key); await sleep(30);
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1);
    assert.equal(via.offers[0].payload.requestedKey, segment.key, "the offer names the exact demanded key");
    assert.equal(f.discovery().checks, 1); assert.equal(f.discovery().staleHolder, 1);
    assert.equal(f.discovery().heldMiss, 0, "a holder that never held the key takes no held miss");
    await pending; await sleep(5);
    const wait = f.rows().filter(row => row.reason === "no-have-wait").at(-1), label = f.label(f.holderKey);
    assert.ok(Number.isSafeInteger(label) && label > 0);
    assert.deepEqual(wait.holders, [label]); assert.deepEqual(wait.haveHolders, []);
    assert.deepEqual(wait.staleHolders, [label], "the stuck holder is labelled stale on the next wait row");
  } finally { await f.close(); }
});

const bytes32 = new Uint8Array(32).fill(9);

test("a holder that is ahead but never delivers goes stale and lets discovery start", async t => {
  // The R68 shape: the holder's HAVE holds each demanded key, yet every load ends at origin.
  const f = await staleHolderFixture(t, { serve: { bytes: bytes32, delayMs: null } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    await f.failUntil(via, 3);
    assert.equal(f.discovery().heldMiss, 3, "one held miss per asked, undelivered key");
    assert.equal(f.requests.length, 3, 'entry decisions that ask nobody do not count as a held miss');
    assert.ok(f.rows().filter(row => row.reason === "have-at-entry").every(row => row.matchingHave === true && row.staleHolders.length === 0));
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[label], [label], [label]]);
    await f.failUntil(via, 4);
    assert.equal(f.discovery().heldMiss, 4);
    assert.equal(f.requests.length, 4, "the holder was asked each time and never delivered");
    assert.equal(f.swarm.metrics().segments.peerFirstLoaded, 0);
    assert.equal(f.discovery().checks, 0); assert.equal(via.offers.length, 0);
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); via.announce(segment.key); await sleep(30);
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1);
    assert.equal(via.offers[0].payload.requestedKey, segment.key);
    assert.equal(f.discovery().checks, 1); assert.equal(f.discovery().staleHolder, 1);
    await pending; await sleep(5);
    const wait = f.rows().filter(row => row.reason === "no-have-wait").at(-1);
    assert.deepEqual(wait.holders, [label]); assert.deepEqual(wait.staleHolders, [label], "the undelivering holder is labelled stale");
    assert.equal(f.discovery().heldMiss, 4, "the final load held nothing and charged no held miss");
  } finally { await f.close(); }
});

test('an unasked commitment timeout does not satisfy the stale-holder decline threshold', async t => {
  const signed = keyedCommitments(bytes32);
  let calls = 0, delayNext = false, forcedAtMs;
  const f = await staleHolderFixture(t, { serve: { bytes: bytes32, delayMs: null }, streamEvent: signed.streamEvent,
    getCommitment: async ctx => {
      calls++;
      if (delayNext) {
        delayNext = false; forcedAtMs = f.rows().filter(row => row.reason === 'have-at-entry').at(-1)?.atMs;
        await sleep(200);
      }
      return signed.getCommitment(ctx);
    } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    await f.failUntil(via, 3);
    const beforeCalls = calls;
    delayNext = true;
    for (let i = 0; i < 12 && calls === beforeCalls; i++) await f.fail(via);
    assert.equal(calls, beforeCalls + 1);
    assert.equal(delayNext, false, 'the bounded fixture reached the forced publisher callback');
    assert.equal(f.discovery().heldMiss, 3);
    assert.equal(f.requests.length, 3);
    assert.deepEqual(f.rows().find(row => row.reason === 'have-at-entry' && row.atMs === forcedAtMs).heldMissHolders, []);
    assert.equal(f.discovery().checks, 0); assert.equal(via.offers.length, 0);
    await f.failUntil(via, 4);
    assert.equal(f.discovery().heldMiss, 4); assert.equal(f.requests.length, 4);
    assert.equal(f.swarm.metrics().segments.peerFirstLoaded, 0);
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); via.announce(segment.key); await sleep(30);
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1);
    assert.equal(via.offers[0].payload.requestedKey, segment.key);
    assert.equal(f.discovery().checks, 1); assert.equal(f.discovery().staleHolder, 1);
    await pending;
    assert.deepEqual(f.rows().filter(row => row.reason === 'no-have-wait').at(-1).staleHolders, [label]);
    assert.equal(f.discovery().heldMiss, 4);
  } finally { await f.close(); }
});

test("a stale holder that keeps advertising the demanded key neither keeps discovery off nor stays protected", async t => {
  // The R68 shape with its HAVE left in place: it holds the last demanded key at the next demand.
  const f = await staleHolderFixture(t, { serve: { bytes: bytes32, delayMs: null } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    for (let i = 0; i < 3; i++) await f.fail(via, { keepHave: true });
    assert.equal(f.discovery().heldMiss, 3);
    // Not yet stale: the HAVE still keeps the context met.
    assert.equal(f.discovery().checks, 0);
    await f.fail(via, { keepHave: true });
    assert.equal(f.discovery().heldMiss, 4);
    assert.equal(f.discovery().checks, 0, "four held misses in under ten seconds keep discovery off"); assert.equal(via.offers.length, 0);
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); via.announce(segment.key); await sleep(30);
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1);
    assert.equal(via.offers[0].payload.requestedKey, segment.key);
    assert.equal(f.discovery().checks, 1); assert.equal(f.discovery().staleHolder, 1);
    await pending; await sleep(5);
    const wait = f.rows().filter(row => row.reason === "no-have-wait").at(-1);
    assert.deepEqual(wait.staleHolders, [label]); assert.deepEqual(wait.haveHolders, [], "it does not hold the new key, only the last one");
  } finally { await f.close(); }
});

test("a non-stale link that holds a demanded key but does not serve the rendition keeps discovery off", async t => {
  // Only the HAVE branch can meet the context: the holder serves nothing and has no history.
  const f = await staleHolderFixture(t, { serve: { bytes: bytes32, delayMs: null } });
  try {
    const via = f.candidate();
    f.holderChannel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    const demand = async () => {
      const segment = f.next(); via.announce(segment.key); await sleep(30);
      await f.load(segment.name); await sleep(30); return segment;
    };
    const held = f.next(); via.announce(held.key); await sleep(30);
    f.holderChannel.receive(haveFrame(held.key));
    await f.load(held.name); await sleep(30);
    // The next demand keeps the held key as its previous one, and the holder still advertises it.
    await demand();
    assert.equal(f.discovery().checks, 0); assert.equal(via.offers.length, 0);
    assert.equal(f.counters()["no-have-no-wait"] >= 1, true, "no link serves the rendition");
    // Without that HAVE nothing meets the context, and the same demand starts discovery.
    f.holderChannel.receive(haveFrame());
    const segment = f.next(); via.announce(segment.key); await sleep(30);
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1); await pending;
    assert.equal(f.discovery().checks, 1);
  } finally { await f.close(); }
});

test("a verified peer segment that arrives after the deadline goes to origin and charges the holders that held the key", async t => {
  const realNow = performance.now.bind(performance), jump = { ms: 0 };
  t.mock.method(performance, "now", () => realNow() + jump.ms);
  const f = await staleHolderFixture(t, { originFallbackMs: 1000, serve: { bytes: bytes32, delayMs: 60 } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch();
    f.holderChannel.receive(haveFrame(segment.key));
    const pending = f.load(segment.name);
    // The clock passes the deadline while the payload is on its way; the payload still verifies.
    await until(() => f.requests.length === 1); jump.ms = 5_000;
    await pending; await sleep(5);
    const metrics = f.swarm.metrics();
    assert.equal(metrics.segments.peerFirstLoaded, 0, "a late segment is not used"); assert.equal(metrics.segments.originFallbacks, 1);
    assert.equal(f.discovery().heldMiss, 1);
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[label]]);
  } finally { await f.close(); }
});

test("an undelivering stale holder that still advertises a key is the rotation victim while a non-stale serving holder is protected", async t => {
  const f = await staleHolderFixture(t, { sibling: true, serve: { bytes: bytes32, delayMs: null } });
  try {
    const via = f.candidate();
    await f.failUntil(via, 4, { keepHave: true });
    f.shift.ms += 10_001; f.touch(); f.siblingChannel.receive(serving("audio:0"));
    // The candidate still hints the last demanded key.
    const audio = new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context, url: "https://origin.example/audio-1.ts",
      frag: { ...context.frag, type: "audio", level: 0 } }, {}, { onSuccess: resolve }));
    await until(() => via.offers.length === 1); await audio;
    assert.equal(f.holderChannel.readyState, "closed", "the stale holder was replaced");
    assert.equal(f.siblingChannel.readyState, "open");
    assert.equal(f.swarm.metrics().peers.evicted, 1);
  } finally { await f.close(); }
});

test("a verified delivery clears a holder's entry and a delivering holder keeps discovery off", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 400, serve: { bytes: bytes32, delayMs: 1 } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    f.holderChannel.delayMs = null;
    for (let i = 0; i < 3; i++) await f.fail(via);
    f.holderChannel.delayMs = 1;
    await f.deliver(via);
    f.holderChannel.delayMs = null;
    for (let i = 0; i < 3; i++) await f.fail(via);
    assert.equal(f.discovery().heldMiss, 6);
    // Six misses would be stale; the delivery in between left three.
    f.shift.ms += 10_001; f.touch();
    assert.deepEqual((await f.trigger(via)).staleHolders, [], "the entry was cleared by the delivery");
    assert.equal(f.discovery().checks, 0); assert.equal(via.offers.length, 0);
    // That load made the fourth miss since the delivery.
    assert.deepEqual((await f.trigger(via)).staleHolders, [label]);
    assert.equal(f.discovery().checks, 1); assert.equal(via.offers.length, 1);
  } finally { await f.close(); }
});

test("a delivering holder is never stale however long the viewer runs", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 400, serve: { bytes: bytes32, delayMs: 1 } });
  try {
    const via = f.candidate();
    for (let i = 0; i < 2; i++) await f.deliver(via);
    f.shift.ms += 10_001; f.touch();
    for (let i = 0; i < 2; i++) await f.deliver(via);
    assert.equal(f.discovery().checks, 0); assert.equal(f.discovery().staleHolder, 0); assert.equal(via.offers.length, 0);
    assert.equal(f.discovery().heldMiss, 0);
    assert.ok(f.rows().every(row => !row.staleHolders?.length), "staleHolders stays empty on every row");
  } finally { await f.close(); }
});

test("deliveries from one serving link leave another serving link unchanged", async t => {
  // Link A holds and delivers every key; link B serves the rendition but never holds a key.
  const f = await staleHolderFixture(t, { originFallbackMs: 400, serve: { bytes: bytes32, delayMs: 1 }, firstServes: true });
  try {
    const via = f.candidate();
    for (let i = 0; i < 2; i++) await f.deliver(via);
    f.shift.ms += 10_001; f.touch(); f.siblingChannel.receive(serving());
    for (let i = 0; i < 2; i++) await f.deliver(via);
    const held = f.rows().filter(row => row.reason === "have-at-entry" || row.reason === "have-after-wait");
    assert.equal(held.length, 4); assert.ok(held.every(row => row.holders.length === 2 && row.haveHolders.length === 1));
    assert.ok(f.rows().every(row => !row.staleHolders?.length), "the other link is never stale");
    assert.equal(f.discovery().heldMiss, 0, "and is not counted as a miss");
    // Its own entry would still start from nothing: a demand nobody holds takes one miss for each.
    assert.deepEqual((await f.trigger(via)).staleHolders, []);
  } finally { await f.close(); }
});

test("only the serving links that held the key take the held miss", async t => {
  const f = await staleHolderFixture(t, { serve: { bytes: bytes32, delayMs: null }, firstServes: true });
  try {
    const via = f.candidate(), holder = f.label(f.holderKey), other = f.label(f.peers[0].pubkey);
    assert.notEqual(holder, other);
    await f.failUntil(via, 4);
    assert.equal(f.discovery().heldMiss, 4, "counted for the holder only");
    assert.ok(f.rows().filter(row => row.heldMissHolders?.length).every(row => row.heldMissHolders.length === 1 && row.heldMissHolders[0] === holder));
    assert.equal(f.rows().filter(row => row.heldMissHolders?.length).length, 4);
    f.shift.ms += 10_001; f.touch(); f.siblingChannel.receive(serving());
    const wait = await f.trigger(via);
    assert.deepEqual(wait.staleHolders, [holder], "only the holder is stale");
    assert.deepEqual(wait.holders, [holder, other].sort((a, b) => a - b));
  } finally { await f.close(); }
});

test("holding a key does not clear a holder entry; only a verified delivery does", async t => {
  const f = await staleHolderFixture(t, { serve: { bytes: bytes32, delayMs: null } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    for (let i = 0; i < 3; i++) await f.fail(via);
    // A have-at-entry row followed by an unavailable commitment (neutral) neither clears nor counts.
    f.commitments.unavailable = true;
    await f.fail(via);
    f.commitments.unavailable = false;
    assert.equal(f.counters()["have-at-entry"], 4);
    assert.equal(f.swarm.metrics().segments.commitmentUnavailable, 1);
    assert.equal(f.discovery().heldMiss, 3);
    await f.fail(via);
    assert.equal(f.discovery().heldMiss, 4);
    f.shift.ms += 10_001; f.touch();
    assert.deepEqual((await f.trigger(via)).staleHolders, [label], "three misses, a held key and a fourth miss: stale");
  } finally { await f.close(); }
});

test("a projected-late decision judged on swarm-wide estimates charges no holder, at either stage", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 1000, serve: { bytes: bytes32, delayMs: 20 } });
  try {
    const via = f.candidate();
    // A holder with a quick first chunk and a slow body: 20 ms to the first chunk, about 250 ms in all.
    f.holderChannel.bodyDelayMs = 250;
    await f.deliver(via);
    // 150 ms of room: the first byte fits, the transfer does not.
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.15 } };
    // A rendition with no known size is projected only once its commitment is in: the commitment stage.
    f.holderChannel.receive(serving("main:1"));
    await f.fail(via, { level: 1 });
    let late = f.rows().filter(row => row.reason === "projected-late");
    assert.equal(late.length, 1); assert.equal(late[0].projection.stage, "commitment"); assert.equal(late[0].matchingHave, true);
    // Now the size is known, so the same decision is made at entry.
    f.touch(); f.holderChannel.receive(serving("main:1"));
    await f.fail(via, { level: 1 });
    late = f.rows().filter(row => row.reason === "projected-late");
    assert.deepEqual(late.map(row => row.projection.stage), ["commitment", "entry"]);
    assert.ok(late.every(row => row.heldMissHolders.length === 0), "the holder was never asked, so it is not charged");
    assert.equal(f.discovery().heldMiss, 0);
    assert.equal(f.requests.length, 1, "only the first delivery was requested");
  } finally { await f.close(); }
});

test("two holders that hold every key: aggregate declines never make the unasked one stale and it stays protected", async t => {
  // A and B both hold every key. A delivers while it is measured; then loads are declined on the
  // buffer alone, so neither link is asked, and neither is judged.
  const f = await staleHolderFixture(t, { originFallbackMs: 1000, serve: { bytes: bytes32, delayMs: 20 }, firstServe: { bytes: bytes32, delayMs: 20 } });
  try {
    const via = f.candidate();
    const both = key => { f.holderChannel.receive(haveFrame(key)); f.siblingChannel.receive(haveFrame(key)); };
    const run = async () => {
      const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch(); f.siblingChannel.receive(serving()); both(segment.key);
      await f.load(segment.name); await sleep(5); both(); return segment;
    };
    await run(); await run();
    assert.equal(f.swarm.metrics().segments.peerFirstLoaded, 2, "sometimes a holder delivers");
    // 10 ms of room: even a measured first byte cannot fit, so these loads go to origin unasked.
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.01 } };
    const asked = f.requests.length;
    for (let i = 0; i < 5; i++) await run();
    assert.equal(f.counters()["projected-late"], 5); assert.equal(f.requests.length, asked, "no holder was asked");
    f.hls.media = undefined; f.shift.ms += 10_001; f.touch(); f.siblingChannel.receive(serving());
    assert.equal(f.discovery().heldMiss, 0);
    assert.ok(f.rows().every(row => !row.staleHolders?.length), "neither holder is ever stale");
    // And discovery stays off, so neither is offered up as a victim.
    const wait = await f.trigger(via);
    assert.deepEqual(wait.staleHolders, []); assert.equal(wait.holders.length, 2);
    assert.equal(f.discovery().checks, 0); assert.equal(via.offers.length, 0);
    assert.equal(f.holderChannel.readyState, "open"); assert.equal(f.siblingChannel.readyState, "open");
  } finally { await f.close(); }
});

test("an abandoned request charges the holder that held the key", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 1500, serve: { bytes: bytes32, delayMs: 50 } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    await f.deliver(via);
    // Then it goes silent: abandoned at its silence floor, well before the deadline.
    f.holderChannel.delayMs = null;
    await f.fail(via);
    assert.equal(f.swarm.metrics().segments.peerAbandoned, 1);
    assert.equal(f.discovery().heldMiss, 1);
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[label]]);
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.records.at(-1).outcome, "abandoned");
  } finally { await f.close(); }
});

test("loads that end for the viewer's own reasons record nothing against a holder", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 400, serve: { bytes: bytes32, delayMs: null } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    const loader = () => new f.hls.config.fLoader({}), url = name => ({ ...context, url: `https://origin.example/${name}.ts` });
    const requested = () => f.holderChannel.sent.filter(frame => frame.t === "want").length;
    // zero budget
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    await f.load(f.next().name); assert.equal(f.counters()["no-budget"], 1);
    f.hls.media = undefined;
    // aborted before eligibility
    let l = loader(); l.load(url(f.next().name), {}, { onSuccess() {}, onAbort() {} }); l.abort();
    await until(() => f.counters()["aborted-before-eligibility"] === 1);
    // no HAVE and no serving link to wait for: its own choice of origin
    f.holderChannel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    await f.load(f.next().name); await sleep(5); f.touch();
    assert.equal(f.counters()["no-have-no-wait"], 1);
    // the wait stops being eligible
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch();
    const waits = f.counters()["no-have-wait"], pending = f.load(segment.name);
    await until(() => f.counters()["no-have-wait"] === waits + 1, 2_000);
    f.holderChannel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    await pending; await sleep(5); f.touch();
    assert.equal(f.counters()["wait-no-longer-eligible"], 1);
    // an unavailable commitment after a matching HAVE
    f.commitments.unavailable = true; await f.fail(via); f.commitments.unavailable = false;
    assert.equal(f.swarm.metrics().segments.commitmentUnavailable, 1);
    // the loader aborts while the holder is being asked
    const held = f.next(); via.announce(held.key); await sleep(30); f.touch(); f.holderChannel.receive(haveFrame(held.key));
    const before = requested(); l = loader(); l.load(url(held.name), {}, { onSuccess() {}, onAbort() {} });
    await until(() => requested() === before + 1); l.abort(); await sleep(20); f.holderChannel.receive(haveFrame());
    assert.equal(f.discovery().heldMiss, 0, "none of these is a held miss");
    // Three real misses now make three: any miss recorded above would make the fourth.
    const beforeMisses = requested();
    await f.failUntil(via, 3);
    assert.equal(requested() - beforeMisses, 3, "exactly three real requests produced the misses");
    assert.equal(f.discovery().heldMiss, 3);
    f.shift.ms += 10_001; f.touch();
    assert.deepEqual((await f.trigger(via)).staleHolders, [], "the neutral loads added no misses");
  } finally { await f.close(); }
});

test("an unasked authority timeout stays neutral before three real holder misses", async t => {
  let delayNext = true, forcedAtMs;
  const f = await staleHolderFixture(t, { originFallbackMs: 400, serve: { bytes: bytes32, delayMs: null },
    getCommitment: async ctx => {
      if (delayNext) {
        delayNext = false; forcedAtMs = f.rows().filter(row => row.reason === "have-at-entry").at(-1)?.atMs;
        await sleep(450); // Beyond this fixture's unchanged 400 ms peer budget.
      }
      return f.commitments.getCommitment(ctx);
    } });
  try {
    const via = f.candidate();
    for (let i = 0; i < 12 && delayNext; i++) await f.fail(via);
    assert.equal(delayNext, false, "the bounded fixture reached the delayed publisher callback");
    await sleep(60); // The late authority result cannot start a peer request either.
    assert.equal(f.requests.length, 0);
    assert.equal(f.discovery().heldMiss, 0);
    assert.deepEqual(f.rows().find(row => row.reason === "have-at-entry" && row.atMs === forcedAtMs).heldMissHolders, []);
    await f.failUntil(via, 3);
    assert.equal(f.requests.length, 3); assert.equal(f.discovery().heldMiss, 3);
    assert.equal(f.swarm.metrics().segments.peerFirstLoaded, 0);
    f.shift.ms += 10_001; f.touch();
    assert.deepEqual((await f.trigger(via)).staleHolders, [], "only the three asked requests were charged");
  } finally { await f.close(); }
});

// stop() is not tested here: it clears discovery, so a held miss recorded after it could not
// be observed through the counters. The loader guards on stopped are the only protection.
// Two holders, each measured once so that selection is by estimate rather than exploration.
// The fixture's holder is A and its first link is B; both hold every key they are given.
async function measuredPair(t, { aDelay, bDelay, bBody, ...options }) {
  const f = await staleHolderFixture(t, { originFallbackMs: 2000, serve: { bytes: bytes32, delayMs: aDelay }, firstServe: { bytes: bytes32, delayMs: bDelay }, ...options });
  if (bBody) f.siblingChannel.bodyDelayMs = bBody;
  const via = f.candidate();
  const hold = (key, ...who) => {
    const frame = held => held ? haveFrame(key) : haveFrame();
    f.holderChannel.receive(frame(key && who.includes("A"))); f.siblingChannel.receive(frame(key && who.includes("B")));
  };
  const run = async (...who) => {
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch(); f.siblingChannel.receive(serving());
    hold(segment.key, ...who); await f.load(segment.name); await sleep(5); hold(undefined); return segment;
  };
  for (let i = 0; i < 12 && !(f.requests.includes("holder") && f.requests.includes("other")); i++) await run("A", "B");
  assert.ok(f.requests.includes("holder") && f.requests.includes("other"), "both holders have been measured");
  return { f, via, run, labels: { A: f.label(f.holderKey), B: f.label(f.peers[0].pubkey) } };
}

test("an asked and abandoned holder is charged while another holder of the key that was not asked is not", async t => {
  const { f, run, labels } = await measuredPair(t, { aDelay: 20, bDelay: 150 });
  try {
    f.holderChannel.delayMs = null;
    const asked = f.requests.length;
    await run("A", "B");
    assert.deepEqual(f.requests.slice(asked), ["holder"], "A, the faster, is asked and B is not");
    assert.equal(f.swarm.metrics().segments.peerAbandoned, 1);
    assert.equal(f.discovery().heldMiss, 1);
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[labels.A]]);
  } finally { await f.close(); }
});

test("at peerNoFit an untried holder whose own estimate does not fit is charged and a serving link without the key is not", async t => {
  // B is slow on its own link (quick first chunk, 800 ms body); A is fast. Only B holds the key, with 500 ms of room.
  const { f, run, labels } = await measuredPair(t, { aDelay: 20, bDelay: 20, bBody: 800 });
  try {
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.5 } };
    const asked = f.requests.length;
    await run("B");
    assert.equal(f.requests.length, asked, "nothing was asked");
    assert.equal(f.swarm.metrics().segments.peerNoFit, 1);
    assert.equal(f.discovery().heldMiss, 1);
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[labels.B]], "A serves but lacks the key");
  } finally { await f.close(); }
});

test("global timing refusals charge no holder before any new peer request", async t => {
  for (const branch of ["minimum-skip", "projected-late"]) await t.test(branch, async t => {
    const realTimer = setTimeout;
    const f = await staleHolderFixture(t, { originFallbackMs: 1000, serve: { bytes: bytes32, delayMs: 20 } });
    const clock = virtualClock(t);
    // Await real cryptographic/relay promises without advancing the loader's
    // controlled clock or firing its timers. Host scheduling cannot select
    // a different refusal branch during this second load.
    const phase = async predicate => {
      const deadline = process.hrtime.bigint() + 3_000_000_000n;
      while (!predicate()) {
        assert(process.hrtime.bigint() < deadline, "controlled refusal did not settle");
        await new Promise(resolve => realTimer(resolve, 1));
      }
    };
    try {
      const via = f.candidate(); f.holderChannel.bodyDelayMs = 250;
      await clock.settle(f.deliver(via), 1000);
      const measured = f.swarm.metrics().peers.deliveryMeasurements.find(row => row.pubkey === f.holderKey).latencyMs;
      assert(measured > 0); assert.equal(f.requests.length, 1);
      const room = measured * (branch === "minimum-skip" ? 0.9 : 0.5);
      f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12 + room / 1000 } };
      const segment = f.next(); via.announce(segment.key); f.touch();
      f.holderChannel.receive(haveFrame(segment.key));
      const at = clock.now(); let response;
      const pending = f.load(segment.name).then(value => { response = value; });
      await phase(() => response !== undefined); await pending;
      assert.equal(clock.now(), at, "async metadata did not consume the controlled room");
      sameBytes(new Uint8Array(response.data), bytes32);
      const metrics = f.swarm.metrics().segments;
      assert.equal(metrics.peerSkippedLate, branch === "minimum-skip" ? 1 : 0);
      assert.equal(metrics.peerProjectedLate, branch === "projected-late" ? 1 : 0);
      if (branch === "projected-late") {
        assert.equal(f.rows().at(-1).reason, "projected-late");
        assert.equal(f.rows().at(-1).projection.stage, "entry");
      }
      assert.equal(metrics.originFallbacks, 1); assert.equal(metrics.originLoaded, 1);
      assert.equal(metrics.peerFirstLoaded, 1, "only the calibration was delivered by a peer");
      assert.equal(f.requests.length, 1, "the refused holder was not asked again");
      assert.equal(f.discovery().heldMiss, 0);
      assert(f.rows().every(row => !row.heldMissHolders?.length));
    } finally { clock.restore(); await f.close(); }
  });
});

test("a corrupt payload hashed past the deadline is not charged but an earlier asked link that failed is", async t => {
  slowPayloadDigest(t, 400);
  // B (tried first) answers `none`; A then returns a payload that does not match its commitment.
  const f = await staleHolderFixture(t, { originFallbackMs: 150, serve: { bytes: new Uint8Array(32).fill(1), commitmentBytes: bytes32, delayMs: 20 },
    firstServe: { bytes: null, delayMs: 5 } });
  try {
    const via = f.candidate(), failed = f.label(f.peers[0].pubkey);
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch(); f.siblingChannel.receive(serving());
    f.holderChannel.receive(haveFrame(segment.key)); f.siblingChannel.receive(haveFrame(segment.key));
    await f.load(segment.name); await sleep(450);
    assert.deepEqual(f.requests, ["other", "holder"], "B failed first, then A was asked");
    assert.equal(f.swarm.metrics().segments.peerCorrupt, 1); assert.equal(f.holderChannel.readyState, "closed");
    assert.equal(f.discovery().heldMiss, 1);
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[failed]]);
  } finally { await f.close(); }
});

// The deadline lands while the payload is being hashed: hashing of the 32-byte payload is
// held past the origin timer, so the load has already fallen back when the digest returns.
function slowPayloadDigest(t, delayMs) {
  const real = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
  t.mock.method(globalThis.crypto.subtle, "digest", async (algorithm, data) => {
    if (data.byteLength === 32) await sleep(delayMs);
    return real(algorithm, data);
  });
}

test("a payload that would have verified but lands after the deadline during hashing charges the asked holder", async t => {
  slowPayloadDigest(t, 400);
  const f = await staleHolderFixture(t, { originFallbackMs: 150, serve: { bytes: bytes32, delayMs: 20 } });
  try {
    const via = f.candidate(), label = f.label(f.holderKey);
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch();
    f.holderChannel.receive(haveFrame(segment.key));
    await f.load(segment.name); await sleep(450);
    const metrics = f.swarm.metrics();
    assert.equal(f.requests.length, 1); assert.equal(metrics.segments.peerFirstLoaded, 0); assert.equal(metrics.segments.originFallbacks, 1);
    assert.equal(metrics.segments.peerCorrupt, 0);
    assert.equal(f.discovery().heldMiss, 1);
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[label]]);
  } finally { await f.close(); }
});

test("a mismatched payload that lands after the deadline is banned and closed, with no held miss", async t => {
  slowPayloadDigest(t, 400);
  const f = await staleHolderFixture(t, { originFallbackMs: 150, serve: { bytes: new Uint8Array(32).fill(1), commitmentBytes: bytes32, delayMs: 20 } });
  try {
    const via = f.candidate();
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch();
    f.holderChannel.receive(haveFrame(segment.key));
    await f.load(segment.name); await sleep(450);
    const metrics = f.swarm.metrics();
    assert.equal(metrics.segments.peerCorrupt, 1); assert.equal(f.holderChannel.readyState, "closed", "banned and closed as on the normal path");
    assert.equal(f.discovery().heldMiss, 0);
  } finally { await f.close(); }
});

test("an integrity failure is never charged to the corrupt link", async t => {
  const corrupt = await staleHolderFixture(t, { originFallbackMs: 400, serve: { bytes: new Uint8Array(32).fill(1), commitmentBytes: bytes32, delayMs: 1 } });
  try {
    const via = corrupt.candidate(), segment = corrupt.next();
    via.announce(segment.key); await sleep(30); corrupt.touch(); corrupt.holderChannel.receive(haveFrame(segment.key));
    await corrupt.load(segment.name); await sleep(5);
    assert.equal(corrupt.swarm.metrics().segments.peerCorrupt, 1);
    assert.equal(corrupt.holderChannel.readyState, "closed", "the corrupt holder is banned and closed");
    assert.equal(corrupt.discovery().heldMiss, 0);
  } finally { await corrupt.close(); }
});

test("a rendition switch away and back starts a fresh holder context however long the viewer was away", async t => {
  const f = await staleHolderFixture(t);
  try {
    const via = f.candidate();
    await f.miss(via, 4);
    f.shift.ms += 10_001; f.touch();
    // Away on another rendition: its segment is not hinted, so nothing is dialled for it.
    const away = f.next(); via.announce(f.next().key); await sleep(30);
    await f.load(away.name, 1); await sleep(5);
    assert.equal(f.discovery().checks, 0);
    f.shift.ms += 5_000; f.touch();
    await f.miss(via, 3);
    assert.equal(f.discovery().checks, 0, "the holder is not stale on the first loads after returning");
    assert.equal(f.discovery().staleHolder, 0); assert.equal(via.offers.length, 0);
    assert.ok(f.rows().every(row => !row.staleHolders?.length));
    // Four fresh misses over ten seconds still apply to the new context.
    await f.miss(via, 1);
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); via.announce(segment.key); await sleep(30);
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1); await pending;
    assert.equal(f.discovery().staleHolder, 1);
  } finally { await f.close(); }
});

test("zero-budget loads neither count as misses nor reset them", async t => {
  const f = await staleHolderFixture(t);
  try {
    const via = f.candidate();
    await f.miss(via, 3);
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    // 12 s in all, under the 30 s demand window: the first miss is now over ten seconds old.
    for (let i = 0; i < 3; i++) { f.shift.ms += 4_000; f.touch(); await f.load(`idle-${i}`); }
    assert.equal(f.counters()["no-budget"], 3);
    f.hls.media = undefined; f.touch();
    // Not stale: the zero-budget loads added no misses, so this load's demand-time seek finds three.
    await f.miss(via, 1);
    assert.equal(f.discovery().checks, 0); assert.equal(f.discovery().staleHolder, 0); assert.equal(via.offers.length, 0);
    // The one real miss completed the four: they were not reset.
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch();
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1); await pending;
    assert.equal(f.discovery().staleHolder, 1);
  } finally { await f.close(); }
});

test("a stale-only context blocked by the spent replacement and a full neighbourhood counts staleBlocked once per load", async t => {
  const f = await staleHolderFixture(t, { answering: true });
  try {
    const first = f.candidate(), second = f.candidate();
    await f.miss(first, 4);
    assert.equal(f.discovery().staleBlocked, 0, "no stale holder, nothing to count");
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); first.announce(segment.key); await sleep(30);
    const opening = f.load(segment.name);
    await until(() => f.swarm.metrics().peers.linksOpened === 3);
    await opening; await sleep(5);
    const snapshot = f.swarm.metrics();
    assert.equal(snapshot.peers.evicted, 1); assert.equal(snapshot.neighbourDiscovery.replacementSpent, 1);
    assert.equal(snapshot.peers.connected, 2); assert.equal(snapshot.neighbourDiscovery.counters.staleHolder, 1);
    assert.equal(snapshot.neighbourDiscovery.counters.staleBlocked, 0, "the load that began an attempt was not blocked");
    const checks = f.discovery().checks;
    for (let load = 1; load <= 3; load++) {
      const demanded = f.next(); second.announce(demanded.key); await sleep(30); f.touch();
      await f.load(demanded.name); await sleep(5);
      assert.equal(f.discovery().staleBlocked, load, "one count per load");
    }
    assert.equal(f.discovery().checks, checks, "no attempt begins while the allowance is spent"); assert.equal(second.offers.length, 0);
    assert.equal(f.swarm.metrics().peers.evicted, 1);
  } finally { await f.close(); }
});

test("neighbour holder state is bounded, scoped to its context and cleared with it", () => {
  const f = advisoryFixture(), { state, context } = f, holders = Array.from({ length: 10 }, (_, i) => (i + 5).toString(16).repeat(64));
  assert.equal(state.stale(context, holders[0]), false, "no entry is not stale");
  for (const pubkey of holders) { state.holderMiss(context, pubkey, "1".repeat(64)); assert.equal(context.holders.size <= 8, true); }
  assert.equal(context.holders.size, 8); assert.equal(context.holders.has(holders[0]), false, "oldest entry evicted");
  const pubkey = holders[9];
  for (const key of ["2", "3", "4", "4"]) state.holderMiss(context, pubkey, key.repeat(64));
  assert.equal(context.holders.get(pubkey).misses, 4, "a repeated key is one miss");
  assert.equal(state.stale(context, pubkey), false, "enough misses are not stale inside ten seconds");
  f.advance(9_999); assert.equal(state.stale(context, pubkey), false);
  f.advance(1); assert.equal(state.stale(context, pubkey), true);
  state.holderDelivered(context, pubkey); assert.equal(state.stale(context, pubkey), false);
  state.holderMiss(context, pubkey, "5".repeat(64)); state.forget(pubkey); assert.equal(context.holders.has(pubkey), false);
  state.holderMiss(context, holders[8], "6".repeat(64)); f.advance(30_001); state.context("main", "main:0");
  assert.equal(context.holders.size, 0, "inactivity clears holder state with the keys");
  const replaced = state.context("main", "main:1"); assert.notEqual(replaced.holders, context.holders); assert.equal(replaced.holders.size, 0);
});

test("held-miss and re-arm diagnostics start at zero and the re-arm interval is a fixed local constant", () => {
  const { state } = advisoryFixture(), snapshot = state.snapshot();
  assert.equal(snapshot.counters.heldMiss, 0); assert.equal(snapshot.counters.rearmed, 0);
  assert.equal(snapshot.replacementRearmMs, 20_000);
});

test("a spent replacement re-arms only after twenty seconds with no verified delivery, every serving link stale and a current context", () => {
  const f = advisoryFixture(), { state, context } = f, staleAll = () => true;
  assert.equal(state.rearm(context, staleAll), false, "an unspent context has nothing to re-arm");
  assert.equal(state.snapshot().replacementRearmMs, 20_000);
  assert.ok(state.replaced(f.begin(), "c".repeat(64)));
  assert.equal(state.spent(context), true); assert.equal(context.spentAt, state.clock());
  f.advance(19_999);
  assert.equal(state.rearm(context, staleAll), false, "not before twenty seconds");
  assert.equal(state.rearm(context, () => false), false, "not while a fresh serving link exists");
  f.advance(1);
  assert.equal(state.rearm(context, () => false), false, "not while a fresh serving link exists");
  assert.equal(state.spent(context), true); assert.equal(state.snapshot().counters.rearmed, 0);
  assert.equal(state.rearm(context, staleAll), true);
  assert.equal(state.spent(context), false); assert.equal(state.snapshot().replacementSpent, 0);
  assert.equal(state.snapshot().counters.rearmed, 1);
  // A second replacement succeeds, and is bounded the same way.
  state.end(); state.demand("main", "main:0", f.key);
  assert.ok(state.replaced(f.begin(), "d".repeat(64)));
  f.advance(20_000); assert.equal(state.rearm(context, staleAll), true);
  assert.equal(state.snapshot().counters.rearmed, 2);
  // Not once the context is no longer current.
  state.end(); state.demand("main", "main:0", f.key);
  assert.ok(state.replaced(f.begin(), "e".repeat(64)));
  f.advance(30_001); assert.equal(state.rearm(context, staleAll), false, "an idle context does not re-arm");
});

test("a verified delivery ends the spent state, so there is nothing to re-arm", () => {
  const f = advisoryFixture(), { state, context } = f;
  assert.ok(state.replaced(f.begin(), "c".repeat(64)));
  f.advance(10_000); assert.equal(state.verified(context), true);
  assert.equal(state.spent(context), false); assert.equal(context.spentAt, null);
  f.advance(20_000); assert.equal(state.rearm(context, () => true), false);
  assert.equal(state.snapshot().counters.rearmed, 0, "the delivery, not the timer, renewed it");
});

test("two spent contexts re-arming together still make one replacement per discovery window", () => {
  const f = advisoryFixture(), { state, context: main } = f, key = "d".repeat(64);
  const audio = state.demand("audio", "audio:0", key);
  state.hint(f.pubkey, [f.key, key], "fixture-ticket");
  const eligible = () => true, unmet = () => true;
  // Both are spent at the same instant, one after the other in two windows.
  const first = state.begin(state.choose(eligible, unmet, false));
  assert.ok(first && state.replaced(first, "c".repeat(64)));
  state.end();
  const second = state.begin(state.choose(eligible, unmet, false));
  assert.ok(second && second.window.context !== first.window.context && state.replaced(second, "e".repeat(64)));
  state.end();
  assert.equal(state.spent(main) && state.spent(audio), true);
  f.advance(20_000);
  assert.equal(state.rearm(main, () => true) && state.rearm(audio, () => true), true);
  assert.equal(state.snapshot().counters.rearmed, 2);
  state.demand("main", "main:0", f.key); state.demand("audio", "audio:0", key);
  // One window and one attempt at a time: the other context cannot begin inside it.
  const open = state.begin(state.choose(eligible, unmet, false));
  assert.ok(open); assert.equal(state.choose(eligible, unmet, false), null, "an attempt is in flight");
  const other = open.window.context === main ? audio : main;
  assert.equal(state.begin({ context: other, candidate: state.candidates.get(f.pubkey), key: other.keys[0] }), null, "the window belongs to one context");
  assert.ok(state.replaced(open, "f".repeat(64)));
  assert.equal(state.replaced(open, "f".repeat(64)), false, "one replacement per context per window");
  assert.equal(state.snapshot().counters.replacements, 3);
});

test("a re-armed replacement is still bounded by the eviction cooldown and the discovery window", async t => {
  // The replacement leaves a link that serves nothing, so the context stays stale-only
  // and re-arms after twenty seconds; the second eviction waits for the 25 s cooldown.
  const f = await staleHolderFixture(t, { answering: true, evictionCooldownMs: 25_000, serve: { bytes: bytes32, delayMs: null } });
  try {
    const first = f.candidate(), second = f.candidate();
    await f.failUntil(first, 4);
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); first.announce(segment.key); await sleep(30);
    const opening = f.load(segment.name);
    await until(() => f.swarm.metrics().peers.linksOpened === 3);
    await opening; await sleep(5);
    let snapshot = f.swarm.metrics();
    assert.equal(snapshot.peers.evicted, 1); assert.equal(snapshot.neighbourDiscovery.replacementSpent, 1);
    assert.equal(snapshot.neighbourDiscovery.counters.rearmed, 0);
    const demandSecond = async () => {
      const demanded = f.next(); second.announce(demanded.key); await sleep(30);
      await f.load(demanded.name); await sleep(5);
    };
    // Ten seconds on: still spent, so nothing is attempted.
    f.shift.ms += 10_000; await demandSecond();
    assert.equal(f.discovery().rearmed, 0); assert.equal(second.offers.length, 0);
    assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 1);
    // Twenty seconds after the replacement: re-armed, but the 25 s eviction cooldown still holds.
    f.shift.ms += 10_001; await demandSecond();
    assert.equal(f.discovery().rearmed, 1); assert.equal(f.swarm.metrics().neighbourDiscovery.replacementSpent, 0);
    assert.equal(second.offers.length, 0, "the eviction cooldown has not passed"); assert.equal(f.swarm.metrics().peers.evicted, 1);
    // Past the cooldown the second replacement goes ahead, and the context is spent again.
    f.shift.ms += 5_000;
    const last = f.next(); second.announce(last.key); await sleep(30);
    const pending = f.load(last.name);
    await until(() => second.offers.length === 1); await pending; await sleep(5);
    snapshot = f.swarm.metrics();
    assert.equal(snapshot.peers.evicted, 2); assert.equal(snapshot.neighbourDiscovery.replacementSpent, 1);
    assert.equal(snapshot.neighbourDiscovery.counters.replacements, 2); assert.equal(snapshot.neighbourDiscovery.counters.rearmed, 1);
    // And not again for another twenty seconds.
    f.shift.ms += 5_000; await demandSecond();
    assert.equal(f.swarm.metrics().neighbourDiscovery.counters.rearmed, 1);
  } finally { await f.close(); }
});

test("a stale holder is the rotation victim while a non-stale serving holder is protected", async t => {
  // The sibling serves audio only and is not stale there; the stuck holder serves
  // main and is stale there. Without the exemption both would be protected.
  const f = await staleHolderFixture(t, { sibling: true });
  try {
    const via = f.candidate();
    await f.miss(via, 4);
    f.shift.ms += 10_001; f.touch(); f.siblingChannel.receive(serving("audio:0"));
    // An audio load makes the audio context live, so the sibling is a useful
    // neighbour there; the seek it triggers finds the stale main context.
    const audio = new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context, url: "https://origin.example/audio-1.ts",
      frag: { ...context.frag, type: "audio", level: 0 } }, {}, { onSuccess: resolve }));
    await until(() => via.offers.length === 1); await audio;
    assert.equal(f.holderChannel.readyState, "closed", "the stale holder was replaced");
    assert.equal(f.siblingChannel.readyState, "open", "the non-stale serving holder survives");
    const snapshot = f.swarm.metrics();
    assert.equal(snapshot.peers.evicted, 1); assert.equal(snapshot.transportDiagnostics.counters["link-close"].rotation, 1);
    assert.equal(snapshot.neighbourDiscovery.counters.staleHolder, 1);
  } finally { await f.close(); }
});

test("an entry-stage projected-late with no holder counts as a miss", async t => {
  class SlowOrigin extends Loader {
    load(ctx, _config, callbacks) { setTimeout(() => callbacks.onSuccess({ data: new Uint8Array(32).fill(9).buffer }, this.stats, ctx, null), 100); }
  }
  const f = await staleHolderFixture(t, { originFallbackMs: 50, loader: SlowOrigin });
  try {
    const via = f.candidate();
    // One ordinary miss; its origin fallback then measures a 100 ms holder wait.
    await f.miss(via, 1);
    assert.equal(f.counters()["projected-late"], 0);
    for (let i = 0; i < 3; i++) {
      const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch(); await f.load(segment.name); await sleep(5);
    }
    assert.equal(f.counters()["projected-late"], 3);
    const late = f.rows().filter(row => row.reason === "projected-late");
    assert.ok(late.every(row => row.projection.stage === "entry" && row.matchingHave === false && row.haveHolders.length === 0));
    assert.equal(f.discovery().checks, 0, "four misses in under ten seconds");
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); via.announce(segment.key); await sleep(30);
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1); await pending;
    assert.equal(f.discovery().staleHolder, 1, "one wait miss and three entry-stage misses made the holder stale");
  } finally { await f.close(); }
});

test("a wait that is no longer eligible leaves the miss count alone", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 400 });
  try {
    const via = f.candidate();
    await f.miss(via, 3);
    const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch();
    const waits = f.counters()["no-have-wait"], pending = f.load(segment.name);
    await until(() => f.counters()["no-have-wait"] === waits + 1, 2_000);
    f.holderChannel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    await pending; await sleep(5);
    assert.equal(f.counters()["wait-no-longer-eligible"], 1);
    f.shift.ms += 10_001; f.touch();
    // Three misses stand: this load's demand-time seek finds the holder fresh, and its miss makes four.
    await f.miss(via, 1);
    assert.equal(f.discovery().checks, 0); assert.equal(via.offers.length, 0);
    const last = f.next(); via.announce(last.key); await sleep(30); f.touch();
    const next = f.load(last.name);
    await until(() => via.offers.length === 1); await next;
  } finally { await f.close(); }
});

test("a deadline-driven wait-aborted counts as a miss and keeps its row reason", async t => {
  const realNow = performance.now.bind(performance), lag = { ms: 0 };
  t.mock.method(performance, "now", () => realNow() - lag.ms);
  // The wait loop sees a clock running behind, so the origin timer reaches the
  // deadline first and aborts the wait.
  const f = await staleHolderFixture(t, { getCommitment: () => { lag.ms = 40; return new Promise(() => {}); } });
  try {
    const via = f.candidate();
    for (let i = 0; i < 4; i++) {
      const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch(); lag.ms = 0;
      await f.load(segment.name); lag.ms = 0; await sleep(5);
    }
    assert.equal(f.counters()["wait-aborted"], 4); assert.equal(f.counters()["wait-expired"], 0);
    assert.equal(f.discovery().checks, 0, "four misses in under ten seconds");
    f.shift.ms += 10_001; f.touch();
    const segment = f.next(); via.announce(segment.key); await sleep(30); lag.ms = 0;
    const pending = f.load(segment.name);
    await until(() => via.offers.length === 1); await pending;
    assert.equal(f.discovery().staleHolder, 1, "four deadline aborts made the holder stale");
  } finally { await f.close(); }
});

test("a caller abort during the wait is not a miss", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 400 });
  try {
    const via = f.candidate();
    await f.miss(via, 3);
    for (let i = 0; i < 2; i++) {
      const segment = f.next(); via.announce(segment.key); await sleep(30); f.touch();
      const waits = f.counters()["no-have-wait"], aborts = f.counters()["wait-aborted"];
      f.holderChannel.receive(JSON.stringify({ t: "fetching", k: segment.key, ms: 2000 }));
      const loader = new f.hls.config.fLoader({});
      loader.load({ ...context, url: `https://origin.example/${segment.name}.ts` }, {}, { onSuccess() {}, onAbort() {} });
      await until(() => f.counters()["no-have-wait"] === waits + 1, 2_000);
      loader.abort();
      await until(() => f.counters()["wait-aborted"] === aborts + 1, 2_000);
    }
    f.shift.ms += 10_001; f.touch();
    // Still three misses: this load's seek finds the holder fresh, and its miss makes four.
    await f.miss(via, 1);
    assert.equal(f.discovery().checks, 0); assert.equal(via.offers.length, 0);
    const last = f.next(); via.announce(last.key); await sleep(30); f.touch();
    const pending = f.load(last.name);
    await until(() => via.offers.length === 1); await pending;
  } finally { await f.close(); }
});

// --- multi-holder transfer (schema 3, framing 2) -----------------------------

const multiCoreBytes = await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url));
const multiCore = await WebAssembly.compile(multiCoreBytes);

// Probes for actual native work (worker-thread replies) that a functional clock
// must wait for in real time rather than race past in logical time.
const nativeWorkProbes = new Set();
function transferWorkerFixture(t, { pauseInit = false, failDelivery = false, holdFinal = false, holdNew = false, holdBan = false, holdDelivered = false, onFree, onRpc } = {}) {
  const workers = [];
  class WorkerImpl extends EventTarget {
    // Ids handed to the real worker thread whose reply has not yet arrived
    // from it (a reply the fixture then holds counts as arrived). A logical
    // clock can use this to wait for actual native work instead of a timer.
    inFlight = new Set();
    constructor() {
      super(); workers.push(this); this.holdNew = holdNew; this.holdDelivered = holdDelivered;
      if (onRpc) this.addEventListener('message', ({ data }) => {
        if (!this.rpcSent?.has(data.id)) return;
        const sent = this.rpcSent.get(data.id); this.rpcSent.delete(data.id);
        if ((this.rpcObserved ?? 0) < 32) {
          this.rpcObserved = (this.rpcObserved ?? 0) + 1;
          try { onRpc({ ...sent, replyAtMs: performance.now(), success: data.ok === true }); } catch {}
        } else this.rpcDropped = (this.rpcDropped ?? 0) + 1;
      });
      this.thread = new WorkerThread(new URL("./support/core-transfer-worker-thread.mjs", import.meta.url));
      this.exit = new Promise(resolve => this.thread.once("exit", resolve));
      this.thread.on("message", data => {
        this.inFlight.delete(data.id);
        if (this.holdStart && this.startIds?.delete(data.id)) { (this.startReplies ??= []).push(data); return; }
        if (this.holdDelivered && this.deliveredIds?.delete(data.id)) { (this.deliveredReplies ??= []).push(data); return; }
        if (this.holdNew && this.newIds?.delete(data.id)) { (this.newRequests ??= []).push({ data }); return; }
        if (holdBan && data.result?.commands?.some(command => command.t === "ban")) { this.banReply = data; return; }
        if (holdFinal && data.result?.commands?.some(command => command.t === "deliver")) { this.finalReply = data; return; }
        this.dispatchEvent(new MessageEvent("message", { data }));
      });
      this.thread.on("error", () => { this.inFlight.clear(); this.dispatchEvent(new Event("error")); });
      this.thread.once("exit", () => this.inFlight.clear());
    }
    postMessage(data, transfer) {
      if (onRpc && ['new', 'start'].includes(data.op)) {
        this.rpcSent ??= new Map();
        if (this.rpcSent.size < 32) this.rpcSent.set(data.id, { id: data.id, op: data.op, handle: data.handle,
          ...(data.op === 'new' ? { configSize: data.input.size, configDeadline: data.input.deadline,
            exclusiveOrigin: data.input.exclusiveOrigin === true, peerOnly: data.input.peerOnly === true } : {}),
          sentAtMs: performance.now() });
        else this.rpcDropped = (this.rpcDropped ?? 0) + 1;
      }
      if (this.holdStart && data.op === 'start') { this.heldStartPosted = true; (this.startIds ??= new Set()).add(data.id); }
      if (this.holdDelivered && data.op === 'delivered') (this.deliveredIds ??= new Set()).add(data.id);
      if (data.op === 'new') this.newCount = (this.newCount ?? 0) + 1;
      if (data.op === 'free') onFree?.();
      if (pauseInit && data.op === "init") { this.init = data; return; }
      if (this.holdNew && data.op === "new") (this.newIds ??= new Set()).add(data.id);
      if (failDelivery && data.op === "delivered") { queueMicrotask(() => this.dispatchEvent(new Event("error"))); return; }
      this.inFlight.add(data.id);
      this.thread.postMessage(data, transfer);
    }
    releaseStart() { this.dispatchEvent(new MessageEvent('message', { data: this.startReplies.shift() })); }
    releaseInit() { this.inFlight.add(this.init.id); this.thread.postMessage(this.init); }
    releaseNew() { const { data } = this.newRequests.shift(); this.dispatchEvent(new MessageEvent('message', { data })); }
    releaseFinal() { this.dispatchEvent(new MessageEvent("message", { data: this.finalReply })); }
    releaseBan() { this.dispatchEvent(new MessageEvent("message", { data: this.banReply })); }
    releaseDelivered() { this.dispatchEvent(new MessageEvent('message', { data: this.deliveredReplies.shift() })); }
    terminate() { this.terminated = true; this.inFlight.clear(); return this.thread.terminate(); }
  }
  const nativePending = () => workers.some(worker => worker.inFlight.size > 0);
  nativeWorkProbes.add(nativePending);
  t.after(async () => {
    nativeWorkProbes.delete(nativePending);
    await Promise.all(workers.map(worker => worker.terminate())); await Promise.all(workers.map(worker => worker.exit));
  });
  return { WorkerImpl, workers, nativePending };
}
const multiContext = { url: "https://origin.example/media/seg.ts",
  frag: { sn: 1, level: 0, cc: 0, type: "main", baseurl: "https://origin.example/media/index.m3u8" } };

/** A holder that answers framing 2 ranges by slicing its object. */
class RangedChannel extends RecordedChannel {
  wants = [];
  cancels = 0;
  constructor(bytes, { corrupt = false, silent = false, delayMs = 0, trickleMs = 0 } = {}) { super(); Object.assign(this, { bytes, corrupt, silent, delayMs, trickleMs }); }
  send(data) {
    super.send(data);
    if (typeof data !== "string") return;
    const frame = JSON.parse(data);
    if (frame.t === "cancel") this.cancels += 1;
    if (frame.t !== "want") return;
    this.wants.push(frame.p ?? null);
    if (this.silent) return;
    setTimeout(() => {
      if (this.readyState !== "open") return;
      const pieceSize = commitmentPieceSize(this.bytes.length);
      const [from, to] = frame.p ? [frame.p[0] * pieceSize, Math.min(frame.p[1] * pieceSize, this.bytes.length)] : [0, this.bytes.length];
      const body = this.bytes.slice(from, to);
      if (this.corrupt) body[0] ^= 0xff;
      this.receive(JSON.stringify({ t: "meta", id: frame.id, size: body.length, ...(frame.p ? { p: frame.p } : {}) }));
      if (this.trickleMs) {
        // 512 bytes per tick, until the requester cancels or the link closes.
        const cancels = this.cancels;
        const drip = (at) => {
          if (this.readyState !== "open" || this.cancels !== cancels || at >= body.length) return;
          this.receive(body.slice(at, at + 512).buffer);
          setTimeout(drip, this.trickleMs, at + 512);
        };
        return drip(0);
      }
      for (let at = 0; at < body.length; at += 16_384) this.receive(body.slice(at, at + 16_384).buffer);
      this.receive(JSON.stringify({ t: "eof", id: frame.id }));
    }, this.delayMs);
  }
}

/** Equal bytes, without a diff of a large array on failure. */
function sameBytes(actual, expected, message) {
  assert.ok(actual.length === expected.length && Buffer.compare(Buffer.from(actual), Buffer.from(expected)) === 0,
    message ?? `got ${actual.length} bytes, expected ${expected.length}`);
}

async function multiFixture(t, { holders, OriginLoader = null, size = 200_000, multiHolder = true, framing = 2, commitmentVersion = 3, originFallbackMs = 3_000, originDelayMs = 0, wholeOriginDelayMs = 0, holdWholeOrigin = false, ignoreRanges = false, traceRequests = 0, peerSupplyHint = false, onPlayerHint = null, beforeCommitment = null, onPeerDelivery = null, swarmOptions = {} }) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) % 251);
  // The player's loader. It answers a range from the same object; its whole
  // segment is different bytes, so a whole-segment fallback shows.
  const ranges = [], rangeLoaders = [], wholeLoads = [];
  let commitmentCalls = 0;
  class RangeLoader extends Loader {
    constructor(config) { super(); this.config = config; }
    load(context, config, callbacks) {
      this.aborted = false;
      if (!context.rangeEnd) {
        this.wholeCallbacks = callbacks; this.wholeContext = context;
        wholeLoads.push({ loader: this, context, config, callbacks });
        if (holdWholeOrigin) return;
        return wholeOriginDelayMs
          ? setTimeout(() => callbacks.onSuccess({ data: bytes.slice().buffer }, this.stats, context, null), wholeOriginDelayMs)
          : super.load(context, config, callbacks);
      }
      if (ignoreRanges) return setTimeout(() => super.load(context, config, callbacks), originDelayMs);
      rangeLoaders.push({ config: this.config, loaderConfig: config, context });
      ranges.push([context.rangeStart, context.rangeEnd - 1]);
      setTimeout(() => callbacks.onSuccess({ data: bytes.slice(context.rangeStart, context.rangeEnd).buffer }, this.stats, context, null), originDelayMs);
    }
    abort() { this.aborted = true; this.wholeCallbacks?.onAbort?.(this.stats, this.wholeContext, null); }
    destroy() { this.destroyed = true; }
  }
  const pieceSize = commitmentPieceSize(size), pieces = [];
  for (let at = 0; at < size; at += pieceSize) pieces.push(createHash("sha256").update(bytes.subarray(at, at + pieceSize)).digest("hex"));
  const key = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");
  const signed = signedFixture({ v: commitmentVersion, key, rendition: commitmentVersion === 1 ? "0" : "/media/index.m3u8", playlist: "/media/index.m3u8", mediaType: "main", encryption: null,
    sha256: createHash("sha256").update(bytes).digest("hex"), size, pieceSize, pieces });
  const f = await linkedFixture({ mode: "peer-first", streamEvent: signed.options.streamEvent, getCommitment: async (...args) => { commitmentCalls++; await beforeCommitment?.(...args); return signed.event; }, originFallbackMs,
    segmentKey: (url) => new URL(url).pathname, coreWasm: multiCore, multiHolder, traceRequests, peerSupplyHint, onPlayerHint, onPeerDelivery, WebSocketImpl: memoryRelaySocket(), ...swarmOptions }, OriginLoader ?? RangeLoader);
  await until(() => f.swarm.metrics().core.state === "ready");
  const channels = [];
  for (const options of holders) {
    const channel = await f.addPeer(new (options.Channel ?? RangedChannel)(bytes, options));
    channel.receive(JSON.stringify({ t: "have", keys: [key] }));
    channels.push(channel);
  }
  for (const peer of f.peers) peer.announcePresence({ role: "viewer", open: true, have: [key],
    transports: [{ type: "webrtc", publicKey: peer.pubkey, ...(framing === 2 ? { obj: 2 } : {}) }] });
  await until(() => f.swarm.metrics().peers.openPeersKnown === f.peers.length);
  // Plain fetch is not the origin path when the player's loader is known.
  t.mock.method(globalThis, "fetch", async () => { throw new Error("ranged origin load bypassed the player's loader"); });
  const hlsConfig = { xhrSetup: () => {} }, loaderConfig = { loadPolicy: { maxTimeToFirstByteMs: 10_000, maxLoadTimeMs: 10_000 } };
  const load = async (context = multiContext) => new Uint8Array((await new Promise((resolve) => new f.hls.config.fLoader(hlsConfig).load(context, loaderConfig, { onSuccess: resolve }))).data);
  return { ...f, bytes, key, channels, load, pieceSize, ranges, rangeLoaders, wholeLoads, hlsConfig, loaderConfig, get commitmentCalls() { return commitmentCalls; } };
}

// Retain hls.js's real FragmentLoader.resetLoader and XhrLoader.abortInternal.
// Only XMLHttpRequest is held; no request reaches an origin.
async function realHlsPeerCleanupFixture(t, { path = 'cached', beforeDestroy, originHandoff = false, originOptions = {} } = {}) {
  assert.equal(Hls.version, '1.7.3', 'exercise the pinned hls.js disposal contract');
  const globals = new Map(['self', 'XMLHttpRequest', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [], destroys = [], channels = [];
  const media = Object.assign(new EventTarget(), {
    currentTime: .1, paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1,
    buffered: { length: 1, start: () => 0, end: () => 2 },
  });
  class HeldXHR {
    readyState = 0;
    status = 200;
    responseType = 'arraybuffer';
    responseURL = 'https://origin.example/media/seg.ts';
    abortCalls = 0;
    constructor() { requests.push(this); }
    open() { this.readyState = 1; }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    getAllResponseHeaders() { return ''; }
    send() { this.savedReady = this.onreadystatechange; }
    abort() { this.abortCalls++; this.readyState = 0; }
    complete(bytes, late = false) {
      this.response = bytes.slice().buffer;
      this.readyState = 4;
      (late ? this.savedReady : this.onreadystatechange)?.();
    }
  }
  class HeldPeerBody extends RangedChannel {
    constructor(bytes) { super(bytes, { silent: true }); Object.assign(this, { ordered: true, maxRetransmits: null, maxPacketLifeTime: null }); }
    send(data) {
      super.send(data);
      if (typeof data !== 'string') return;
      const frame = JSON.parse(data);
      if (frame.t === 'want') {
        const size = frame.p ? Math.min(frame.p[1] * commitmentPieceSize(this.bytes.length), this.bytes.length) - frame.p[0] * commitmentPieceSize(this.bytes.length) : this.bytes.length;
        queueMicrotask(() => { if (this.readyState === 'open') this.receive(JSON.stringify({ t: 'meta', id: frame.id, size, ...(frame.p ? { p: frame.p } : {}) })); });
      } else if (frame.t === 'cancel') queueMicrotask(() => { if (this.readyState === 'open') this.receive(JSON.stringify({ t: 'eof', id: frame.id })); });
    }
  }
  Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: HeldXHR });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
  let actual, f, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { actual?.destroy(); }
    finally {
      try { await f?.close(); }
      finally {
        for (const [key, descriptor] of globals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
      }
    }
  };
  t.after(close);
  try {
    actual = new Hls({ autoStartLoad: false, enableWorker: false });
    const playback = peerPlaybackOptions(500);
    playback.key = createHash('sha256').update(`${base.swarmId}\n/media/seg.ts`).digest('hex');
    const hash = createHash('sha256').update(playback.bytes).digest('hex');
    const signed = signedFixture({
      v: 3, key: playback.key, sha256: hash, rendition: '/media/index.m3u8', playlist: '/media/index.m3u8',
      mediaType: 'main', encryption: null, pieceSize: commitmentPieceSize(playback.bytes.length), pieces: [hash],
    });
    f = await linkedFixture({
      ...playback.options, coreWasm: multiCore, multiHolder: true,
      streamEvent: signed.options.streamEvent, getCommitment: () => signed.event,
      WebSocketImpl: memoryRelaySocket(), zeroBudgetPeerRace: path !== 'ordinary',
      latePeerRace: path === 'late', sustainablePeerWait: true,
      ...(originHandoff ? { serve: true } : {}),
      ...originOptions,
    }, Hls.DefaultConfig.loader, { media });
    const Wrapped = f.hls.config.fLoader, instances = [];
    actual.config.fLoader = class extends Wrapped {
      constructor(config) { super(config); instances.push(this); }
      destroy() {
        beforeDestroy?.(this);
        destroys.push({ stats: this.stats, peer: !!this.peerStats, aborted: this.stats?.aborted });
        return super.destroy();
      }
    };
    const frag = M3U8Parser.parseLevelPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nlead.ts\n#EXTINF:2,\nseg.ts\n',
      'https://origin.example/media/index.m3u8', 0, 'main', 0, null,
    ).fragments[1];
    const add = async () => {
      const channel = await f.addPeer(originHandoff ? new HeldPeerBody(playback.bytes) : new RangedChannel(playback.bytes)), peer = f.peers.at(-1);
      channels.push(channel);
      peer.announcePresence({ role: 'viewer', open: true, have: [playback.key], transports: [{ type: 'webrtc', publicKey: peer.pubkey, obj: 2 }] });
      await until(() => f.swarm.metrics().peers.openPeersKnown === 1);
      channel.receive(JSON.stringify({ t: 'have', keys: [playback.key] }));
    };
    await until(() => f.swarm.metrics().core.state === 'ready');
    if (path === 'cached' || originHandoff && path === 'ordinary') await add();
    const promise = actual.streamController.fragmentLoader.load(frag);
    promise.catch(() => {}); // The test observes settlement after transport setup.
    const stats = frag.stats;
    await until(() => requests.length === 1);
    if (path === 'late') await add();
    return {
      f, actual, frag, stats, promise, requests, destroys, channels, key: playback.key, bytes: playback.bytes, loader: instances[0], close,
      disposeDirect: () => Wrapped.prototype.destroy.call(instances[0]),
    };
  } catch (error) { await close(); throw error; }
}

for (const path of ['ordinary', 'cached', 'late']) test(`origin handoff: actual Hls ${path} publishes retained HAVE before withdrawing FETCH`, { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t, { path, originHandoff: true });
  try {
    const channel = q.channels[0];
    await until(() => channel.sent.some(frame => frame.t === 'fetching' && frame.k === q.key && frame.ms > 0));
    if (path === 'cached') await until(() => channel.wants.length > 0);
    q.requests[0].complete(q.bytes);
    assert.equal(q.destroys.length, 1, 'real FragmentLoader reset/destroy remains synchronous with HTTP success');
    const result = await q.promise;
    sameBytes(new Uint8Array(result.payload), q.bytes);
    const advertised = channel.sent.findIndex(frame => frame.t === 'have' && (frame.add ?? frame.keys ?? []).includes(q.key));
    const withdrawn = channel.sent.findIndex(frame => frame.t === 'fetching' && frame.k === q.key && frame.ms === 0);
    assert(withdrawn >= 0, 'the completed HTTP claim is withdrawn');
    assert(advertised >= 0 && advertised < withdrawn, 'retained HAVE must precede FETCH withdrawal on the same ordered channel');
    assert.equal(q.f.swarm.metrics().bytes.held, q.bytes.length);
    assert.equal(q.f.swarm.metrics().segments.peerFirstLoaded, 0, 'origin retention creates no accepted peer-media credit');
  } finally { await q.close(); }
});

for (const path of ['ordinary', 'cached', 'late']) for (const ending of ['abort', 'error', 'retention-refusal']) {
  test(`origin handoff: actual Hls ${path} ${ending} never advertises an unretained body`, { timeout: 10_000 }, async t => {
    const q = await realHlsPeerCleanupFixture(t, { path, originHandoff: true,
      originOptions: ending === 'retention-refusal' ? { maxHeldBytes: 1 } : {} });
    try {
      const channel = q.channels[0];
      await until(() => channel.sent.some(frame => frame.t === 'fetching' && frame.k === q.key && frame.ms > 0));
      const old = { callbacks: q.loader.inner.callbacks, context: q.loader.inner.context, stats: q.stats };
      if (ending === 'abort') {
        q.actual.streamController.fragmentLoader.abort();
        await assert.rejects(q.promise, error => error.data.details === Hls.ErrorDetails.INTERNAL_ABORTED);
      } else if (ending === 'error') {
        q.requests[0].status = 500; q.requests[0].complete(q.bytes);
        await assert.rejects(q.promise, error => error.data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR);
      } else {
        q.requests[0].complete(q.bytes);
        sameBytes(new Uint8Array((await q.promise).payload), q.bytes);
      }
      if (ending !== 'retention-refusal') {
        old.callbacks.onSuccess({ data: q.bytes.slice().buffer }, old.stats, old.context, null);
        assert.equal(q.f.swarm.metrics().segments.originLoaded, 0, 'a retired payload is neither accepted nor retained');
      }
      assert.equal(q.f.swarm.metrics().bytes.held, 0);
      assert.equal(channel.sent.some(frame => frame.t === 'have' && (frame.add ?? frame.keys ?? []).includes(q.key)), false);
      assert.equal(q.f.swarm.metrics().segments.peerFirstLoaded, 0);
    } finally { await q.close(); }
  });
}

test('origin handoff: actual Hls reset retains the original advertised key', { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t, { path: 'ordinary', originHandoff: true,
    beforeDestroy: loader => { loader.context.url = 'https://origin.example/media/changed.ts'; } });
  try {
    const channel = q.channels[0];
    await until(() => channel.sent.some(frame => frame.t === 'fetching' && frame.k === q.key && frame.ms > 0));
    q.requests[0].complete(q.bytes); await q.promise;
    const advertised = channel.sent.filter(frame => frame.t === 'have').flatMap(frame => frame.add ?? frame.keys ?? []);
    assert.deepEqual(advertised, [q.key], 'synchronous Hls disposal cannot retarget the source copy to a changed context');
    assert.equal(q.f.swarm.metrics().bytes.held, q.bytes.length);
  } finally { await q.close(); }
});

test('origin handoff: stale ordinary HTTP callbacks cannot retire a new real Hls load', { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t, { path: 'ordinary', originHandoff: true });
  try {
    const channel = q.channels[0];
    await until(() => channel.sent.some(frame => frame.t === 'fetching' && frame.k === q.key && frame.ms > 0));
    const old = { callbacks: q.loader.inner.callbacks, context: q.loader.inner.context, stats: q.stats };
    q.actual.streamController.fragmentLoader.abort();
    await assert.rejects(q.promise, error => error.data.details === Hls.ErrorDetails.INTERNAL_ABORTED);
    const next = M3U8Parser.parseLevelPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:2\n#EXTINF:2,\nnext.ts\n',
      'https://origin.example/media/index.m3u8', 0, 'main', 0, null).fragments[0];
    const nextKey = createHash('sha256').update(`${base.swarmId}\n/media/next.ts`).digest('hex');
    const pending = q.actual.streamController.fragmentLoader.load(next); pending.catch(() => {});
    await until(() => q.requests.length === 2 && channel.sent.some(frame => frame.t === 'fetching' && frame.k === nextKey && frame.ms > 0));
    const active = next.loader;
    old.callbacks.onSuccess({ data: q.bytes.slice().buffer }, old.stats, old.context, null);
    old.callbacks.onError({ code: 500, text: 'old-error' }, old.context, null, old.stats);
    old.callbacks.onTimeout(old.stats, old.context, null); old.callbacks.onAbort(old.stats, old.context, null);
    assert.equal(next.loader, active, 'old terminals cannot reset the new FragmentLoader');
    assert.equal(channel.sent.some(frame => frame.t === 'fetching' && frame.k === nextKey && frame.ms === 0), false);
    assert.equal(q.f.swarm.metrics().bytes.held, 0);
    q.requests[1].complete(q.bytes);
    sameBytes(new Uint8Array((await pending).payload), q.bytes);
    assert.equal(channel.sent.some(frame => frame.t === 'have' && (frame.add ?? frame.keys ?? []).includes(q.key)), false);
  } finally { await q.close(); }
});

for (const path of ['cached', 'late']) test(`accepted peer stats: actual Hls ${path} cleanup preserves verified success and reference`, { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t, { path });
  try {
    const result = await q.promise;
    sameBytes(new Uint8Array(result.payload), q.bytes);
    assert.equal(result.frag, q.frag);
    assert.equal(q.frag.stats, q.stats);
    assert.equal(q.destroys[0].stats, q.stats);
    assert.equal(q.destroys[0].aborted, false, 'verified peer stats are valid before real Hls synchronous cleanup');
    assert.ok(q.requests[0].abortCalls >= 2, 'real XhrLoader abort and destroy both dispose the losing pending HTTP');
    assert.equal(q.stats.aborted, false, 'losing XHR cleanup must not mark the accepted peer object aborted');
    assert.equal(q.stats.loaded, q.bytes.length);
    assert.equal(q.stats.total, q.bytes.length);
    q.requests[0].complete(q.bytes, true);
    await sleep(5);
    assert.equal(q.f.swarm.metrics().segments.peerFirstLoaded, 1);
    assert.equal(q.stats.aborted, false);
  } finally { await q.close(); }
});

for (const path of ['http', 'pending-abort']) test(`accepted peer stats: actual Hls ${path} retains its original cleanup semantics`, { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t, { path });
  try {
    if (path === 'http') {
      q.requests[0].complete(q.bytes);
      const result = await q.promise;
      sameBytes(new Uint8Array(result.payload), q.bytes);
      assert.equal(q.stats.aborted, false);
      assert.equal(q.requests[0].abortCalls, 0);
      assert.equal(q.destroys[0].peer, false);
    } else {
      q.actual.streamController.fragmentLoader.abort();
      await assert.rejects(q.promise, error => error.data.details === Hls.ErrorDetails.INTERNAL_ABORTED);
      assert.equal(q.stats.aborted, true);
    }
  } finally { await q.close(); }
});

for (const incoming of [true, null, undefined]) test(`accepted peer stats: cleanup never normalises incoming ${incoming} to success`, { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t, { beforeDestroy: loader => { if (loader.peerStats) loader.peerStats.aborted = incoming; } });
  try {
    await q.promise;
    assert.notEqual(q.stats.aborted, false);
    assert.equal(q.destroys[0].aborted, incoming);
  } finally { await q.close(); }
});

test('accepted peer stats: explicit caller abort before disposal stays aborted', { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t, { beforeDestroy: loader => { if (loader.peerStats) loader.abort(); } });
  try { await q.promise; assert.equal(q.stats.aborted, true); }
  finally { await q.close(); }
});

for (const unreadable of [false, true]) test(`accepted peer stats: ${unreadable ? 'throwing flag getter' : 'cleanup throw'} preserves disposal exception semantics`, { timeout: 10_000 }, async t => {
  const q = await realHlsPeerCleanupFixture(t);
  let totalReads = 0, disposed = 0;
  try {
    await q.promise;
    const failure = new Error('fixture-disposal-error');
    Object.defineProperty(q.stats, 'total', { configurable: true, get() { totalReads++; throw new Error('must-not-read-total'); } });
    if (unreadable) Object.defineProperty(q.stats, 'aborted', { configurable: true, get() { throw new Error('unreadable-abort-flag'); } });
    q.loader.inner.destroy = () => { disposed++; if (!unreadable) q.stats.aborted = true; throw failure; };
    assert.throws(() => q.disposeDirect(), error => error === failure);
    assert.equal(disposed, 1);
    assert.equal(totalReads, 0);
    if (!unreadable) assert.equal(q.stats.aborted, false, 'completed peer flag survives even when disposal throws');
  } finally { await q.close(); }
});

async function directLateFixture(t, options = {}) {
  const f = await multiFixture(t, { holders: [], holdWholeOrigin: true, beforeCommitment: options.beforeCommitment,
    swarmOptions: { zeroBudgetPeerRace: true, sustainablePeerWait: true, latePeerRace: true,
      ...(options.gated ? { admit: () => true, ticket: 'fixture-owner' } : {}), ...options.swarmOptions } });
  const media = Object.assign(new EventTarget(), { paused: false, ended: false, buffered: { length: 0 }, currentTime: 0 });
  f.hls.media = media;
  t.after(() => f.close());
  const context = options.context ?? { ...multiContext, frag: { ...multiContext.frag } }, calls = { success: 0, abort: 0, error: 0, timeout: 0 };
  let settle;
  const outcome = new Promise(resolve => { settle = resolve; });
  const loader = new f.hls.config.fLoader(f.hlsConfig);
  if (options.context) context.frag.stats = loader.stats;
  loader.load(context, f.loaderConfig, {
    onSuccess: (response, stats, delivered) => { calls.success++; settle({ kind: 'success', bytes: new Uint8Array(response.data), stats, context: delivered }); },
    onAbort: () => { calls.abort++; settle({ kind: 'abort' }); },
    onError: () => { calls.error++; settle({ kind: 'error' }); },
    onTimeout: () => { calls.timeout++; settle({ kind: 'timeout' }); },
  });
  await until(() => f.wholeLoads.length === 1);
  const add = async () => {
    const channel = await f.addPeer(new RangedChannel(f.bytes));
    const peer = f.peers.at(-1);
    peer.announcePresence({ role: 'viewer', open: true, have: [f.key], ticket: 'fixture-ticket',
      transports: [{ type: 'webrtc', publicKey: peer.pubkey, obj: 2 }] });
    await until(() => f.swarm.metrics().peers.openPeersKnown === 1);
    channel.receive(JSON.stringify({ t: 'have', keys: [f.key] }));
    return channel;
  };
  const finish = () => { const row = f.wholeLoads[0]; row.callbacks.onSuccess({ data: f.bytes.slice().buffer }, row.loader.stats, row.context, null); };
  return { ...f, media, context, calls, outcome, loader, add, finish };
}

test('latePeerRace direct HTTP has one winner and cannot resurrect callbacks after peer delivery', async t => {
  const f = await directLateFixture(t), channel = await f.add();
  const outcome = await f.outcome;
  assert.equal(outcome.kind, 'success'); sameBytes(outcome.bytes, f.bytes);
  assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
  assert.equal(f.wholeLoads.length, 1); assert.equal(f.wholeLoads[0].loader.aborted, true);
  assert(channel.wants.length > 0);
  f.finish(); f.loader.destroy(); f.loader.abort(); await sleep(5);
  assert.deepEqual(f.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  assert.equal(f.swarm.metrics().latePeerRace.pending, 0);
});

test('latePeerRace direct delivery preserves the actual parsed Hls Fragment and caller stats identity', async t => {
  const fragment = M3U8Parser.parseLevelPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nseg.ts\n',
    'https://origin.example/media/index.m3u8', 0, 'main', 0, null).fragments[0];
  const context = { ...multiContext, frag: fragment, url: fragment.url, type: LoaderContextType.MEDIA_FRAGMENT,
    responseType: 'arraybuffer', headers: {}, rangeStart: 0, rangeEnd: 0 };
  const f = await directLateFixture(t, { context });
  const originalStats = fragment.stats;
  await f.add(); const result = await f.outcome;
  assert.equal(result.kind, 'success'); sameBytes(result.bytes, f.bytes);
  assert.equal(result.context, context, 'Hls receives its own context, not the immutable verification snapshot');
  assert.equal(result.context.frag, fragment); assert.equal(result.stats, originalStats);
  assert.equal(fragment.stats, originalStats); assert.equal(originalStats.loaded, f.bytes.length);
  assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
  assert.equal(f.wholeLoads.length, 1); assert.equal(f.wholeLoads[0].loader.aborted, true);
});

for (const phase of ['authority', 'worker', 'final']) test(`latePeerRace direct context mutation during ${phase} preserves HTTP and refuses stale peer delivery`, async t => {
  let release, entered = false, mutate;
  const gate = new Promise(resolve => { release = resolve; });
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdNew: phase === 'worker', onFree: phase === 'final' ? () => mutate?.() : undefined });
  const f = await directLateFixture(t, { beforeCommitment: phase === 'authority' ? async () => { entered = true; await gate; } : undefined,
    swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } });
  await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
  mutate = () => { f.context.url = 'https://origin.example/media/replaced.ts'; };
  const channel = await f.add();
  if (phase === 'authority') { await until(() => entered); mutate(); release(); }
  else if (phase === 'worker') { await until(() => workers[0].newRequests?.length === 1); mutate(); workers[0].releaseNew(); }
  await until(() => f.swarm.metrics().latePeerRace.refused === 1);
  assert.equal(f.wholeLoads.length, 1); assert.equal(f.wholeLoads[0].loader.aborted, false, 'context refusal must keep the original network owner');
  if (phase !== 'final') assert.equal(channel.wants.length, 0, 'invalid context must be fenced before peer requests');
  if (phase === 'authority') assert.equal(workers[0].newCount ?? 0, 0);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  assert.equal(f.calls.success, 0);
  f.loader.abort(); assert.equal((await f.outcome).kind, 'abort');
  assert.deepEqual(f.calls, { success: 0, abort: 1, error: 0, timeout: 0 });
  await until(() => f.swarm.metrics().core.transferWorker.transfers === 0);
  assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0);
});

test('latePeerRace direct signed authority expiring during worker creation cannot issue a peer request', async t => {
  const wall = Date.now.bind(Date); let shift = 0;
  t.mock.method(Date, 'now', () => wall() + shift);
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdNew: true });
  const f = await directLateFixture(t, { swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } });
  await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
  const channel = await f.add();
  await until(() => workers[0].newRequests?.length === 1);
  shift = 61_000; workers[0].releaseNew();
  await until(() => f.swarm.metrics().latePeerRace.refused === 1);
  assert.equal(channel.wants.length, 0, 'authority expires before the worker may ask for bytes');
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.equal(f.calls.success, 0);
  assert.equal(f.wholeLoads.length, 1); assert.equal(f.wholeLoads[0].loader.aborted, false);
  assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0);
  f.loader.abort(); assert.equal((await f.outcome).kind, 'abort');
  assert.deepEqual(f.calls, { success: 0, abort: 1, error: 0, timeout: 0 });
});

for (const ending of ['pause', 'ticket', 'timeout', 'prefix']) test(`latePeerRace direct ${ending} retires adoption while the original HTTP contract remains intact`, async t => {
  const f = await directLateFixture(t, { gated: ending === 'ticket' });
  const original = f.wholeLoads[0];
  if (ending === 'pause') { f.media.paused = true; f.media.dispatchEvent(new Event('pause')); }
  else if (ending === 'ticket') assert.equal(f.swarm.updateTicket('next-fixture-ticket'), true);
  else if (ending === 'timeout') original.callbacks.onTimeout(original.loader.stats, f.context, null);
  else original.callbacks.onProgress(original.loader.stats, f.context, Uint8Array.of(1), null);
  const channel = await f.add(); await sleep(10);
  assert.equal(channel.wants.length, 0); assert.equal(f.swarm.metrics().latePeerRace.armed, 0);
  assert.equal(f.swarm.metrics().latePeerRace.pending, 0);
  assert.equal(f.wholeLoads.length, 1);
  f.finish();
  const result = await f.outcome;
  assert.equal(result.kind, ending === 'timeout' ? 'timeout' : 'success');
  assert.equal(f.calls.success, ending === 'timeout' ? 0 : 1); assert.equal(f.calls.timeout, ending === 'timeout' ? 1 : 0);
  assert.equal(f.calls.abort + f.calls.error, 0);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
});

function beginCountedMultiLoad(f, context = multiContext, onProgress = null) {
  const calls = { success: [], abort: [], error: [], progress: [] };
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const loader = new f.hls.config.fLoader(f.hlsConfig);
  loader.load(context, f.loaderConfig, {
    onSuccess: (...args) => { calls.success.push(args); resolve(new Uint8Array(args[0].data)); },
    onAbort: (...args) => calls.abort.push(args), onError: (...args) => calls.error.push(args),
    onProgress: (...args) => { calls.progress.push(args); onProgress?.(...args); },
  });
  return { loader, response, calls };
}

test("transfer worker: six-MiB verified contribution uses the shared Rust facade and exact observations", async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t), observed = [];
  const f = await multiFixture(t, { size: 6 * 1024 * 1024, holders: [{}, {}], originFallbackMs: 5_000, originDelayMs: 1_000,
    traceRequests: 4_096, onPeerDelivery: value => observed.push(value),
    swarmOptions: { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl } });
  try {
    await until(() => f.swarm.metrics().core.transferWorker.state === "ready");
    sameBytes(await f.load(), f.bytes);
    const metrics = f.swarm.metrics();
    assert.equal(workers.length, 1, "one warmed worker belongs to this swarm");
    assert.equal(metrics.core.multiHolder.delivered, 1);
    assert.ok(metrics.bytes.peerFirst > 0);
    assert.equal(observed.reduce((sum, row) => sum + row.bytes, 0), metrics.bytes.peerFirst);
    assert.ok(observed.every(row => f.connections.includes(row.connection)));
    assert.ok(f.swarm.trace().rows.some(row => row.k === "xfer" && row.op === "delivered" && row.out.c.some(command => command.t === "deliver")));
    await until(() => f.swarm.metrics().core.transferWorker.transfers === 0);
    assert.equal(f.swarm.metrics().core.transferWorker.pending, 0);
  } finally { await f.close(); }
  assert.equal(workers[0].terminated, true);
});

test("transfer worker: current demand leases a link before async creation and warmed work waits without another HTTP arm", async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdNew: true });
  const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: 1500,
    swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl, zeroBudgetPeerRace: true, sustainablePeerWait: true, maxPeerWaitMs: 2500 } });
  try {
    await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
    const current = f.load();
    await until(() => workers[0].newRequests?.length === 1);
    const warm = f.load({ ...multiContext, [WARM_AHEAD]: { peerBytes: 0 } });
    await sleep(30);
    assert.equal(workers[0].newRequests.length, 1, 'the warm arm cannot select the same free-looking link during worker creation');
    assert.equal(f.swarm.metrics().peerAdmission.waiting, 1);
    workers[0].releaseNew(); sameBytes(await current, f.bytes);
    const currentMetrics = f.swarm.metrics();
    assert.equal(currentMetrics.bytes.peerFirst, f.bytes.length, 'the genuine current object must have verified peer credit before testing peer handover');
    assert.equal(f.ranges.length, 0, 'the actual-site zero-headroom path is a peer-only race against whole HTTP');
    t.diagnostic(JSON.stringify({ currentAcceptedPeerBytes: currentMetrics.bytes.peerFirst, originRanges: f.ranges.length,
      admission: currentMetrics.peerAdmission, peerNoFit: currentMetrics.segments.peerNoFit }));
    try { await until(() => workers[0].newRequests.length === 1); }
    catch (error) {
      const m = f.swarm.metrics();
      t.diagnostic(JSON.stringify({ admission: m.peerAdmission, peerNoFit: m.segments.peerNoFit,
        peerOutcomes: m.peerRequestDiagnostics.counters, acceptedPeerBytes: m.bytes.peerFirst, originRanges: f.ranges.length }));
      throw error;
    }
    workers[0].releaseNew(); sameBytes(await warm, f.bytes);
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.counters.busy, 0);
    assert.equal(f.wholeLoads.length, 2, 'only the already-running current and speculative source arms were started');
    assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0);
  } finally { await f.close(); }
});

for (const ending of ['abort', 'failure']) test(`transfer worker: ${ending} during creation releases the link lease and fences a late acknowledgement`, async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdNew: true });
  const f = await multiFixture(t, { holders: [{}], swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } });
  try {
    await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
    const pending = beginCountedMultiLoad(f);
    await until(() => workers[0].newRequests?.length === 1);
    assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 1);
    if (ending === 'abort') pending.loader.abort(); else workers[0].dispatchEvent(new Event('error'));
    await until(() => f.swarm.metrics().peerAdmission.claimedLinks === 0);
    workers[0].releaseNew(); await sleep(20);
    assert.equal(f.channels[0].wants.length, 0);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    if (ending === 'abort') assert.equal(f.wholeLoads.length, 0, 'caller abort cannot start hidden recovery');
    else { assert.equal((await pending.response).length, 32); assert.equal(f.wholeLoads.length, 1); }
  } finally { await f.close(); }
});

test('transfer worker: a warm lease waiter expires inside its original peer window while its existing source continues', async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdNew: true });
  const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: 1100,
    swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl, zeroBudgetPeerRace: true, maxPeerWaitMs: 1000 } });
  try {
    await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
    const current = beginCountedMultiLoad(f);
    await until(() => workers[0].newRequests?.length === 1);
    const warm = f.load({ ...multiContext, [WARM_AHEAD]: { peerBytes: 0 } });
    await until(() => f.swarm.metrics().peerAdmission.waiting === 1);
    await until(() => f.swarm.metrics().peerAdmission.waiting === 0);
    assert.equal(f.swarm.metrics().peerAdmission.granted, 0);
    assert.equal(workers[0].newRequests.length, 1);
    sameBytes(await warm, f.bytes);
    current.loader.abort();
    assert.equal(f.wholeLoads.length, 1);
    assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0);
  } finally { await f.close(); }
});

test("transfer worker: warming never delays ordinary HTTP or silently uses the main-thread transfer", async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { pauseInit: true });
  const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: 5,
    swarmOptions: { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl } });
  try {
    assert.equal(f.swarm.metrics().core.transferWorker.state, "loading");
    const key = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");
    f.channels[0].receive(JSON.stringify({ t: "have", keys: [] }));
    f.channels[0].receive(JSON.stringify({ t: "contribution", serving: true, rendition: "main:0" }));
    f.channels[0].receive(JSON.stringify({ t: "fetching", k: key, ms: 2_000 }));
    sameBytes(await f.load(), f.bytes);
    assert.equal(f.wholeLoads.length, 1);
    assert.equal(f.channels[0].wants.length, 0, "no hidden synchronous peer transfer fills the startup gap");
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.swarm.metrics().segments.coordinatedWaits, 0, "a real FETCH with no HAVE cannot wait for an unavailable worker");
    assert.equal(f.commitmentCalls, 0);
    workers[0].releaseInit();
    await until(() => f.swarm.metrics().core.transferWorker.state === "ready");
    f.channels[0].receive(JSON.stringify({ t: "have", keys: [key] }));
    sameBytes(await f.load(), f.bytes);
    assert.ok(f.swarm.metrics().bytes.peerFirst > 0);
  } finally { await f.close(); }
});

test("transfer worker: late replies obey the absolute origin backstop before timers run", async t => {
  for (const late of [false, true]) await t.test(late ? "past hard backstop" : "within origin reserve", async t => {
    const { WorkerImpl, workers } = transferWorkerFixture(t, { holdFinal: true }), observed = [];
    const f = await multiFixture(t, { holders: [{}], originFallbackMs: 500, originDelayMs: 1_000, wholeOriginDelayMs: 5,
      onPeerDelivery: row => observed.push(row),
      swarmOptions: { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl, maxPeerWaitMs: 500 } });
    let shift = 0;
    try {
      await until(() => f.swarm.metrics().core.transferWorker.state === "ready");
      const actualNow = performance.now.bind(performance);
      t.mock.method(performance, "now", () => actualNow() + shift);
      const pending = f.load();
      await until(() => workers[0].finalReply);
      const before = f.swarm.metrics();
      assert.equal(f.wholeLoads.length, 0, "no fallback timer has run before the held worker reply");
      shift = late ? 10_000 : 600;
      workers[0].releaseFinal();
      sameBytes(await pending, f.bytes);
      const after = f.swarm.metrics();
      if (late) {
        assert.equal(after.bytes.peerFirst, 0);
        assert.equal(after.core.multiHolder.peerBytes, before.core.multiHolder.peerBytes, "late state cannot add diagnostic verified-piece credit");
        assert.equal(after.core.multiHolder.delivered, 0);
        assert.deepEqual(observed, []);
        assert.equal(f.wholeLoads.length, 1);
      } else {
        assert.ok(after.bytes.peerFirst > 0, "the measured origin reserve remains available to mixed delivery");
        assert.equal(after.core.multiHolder.delivered, 1);
        assert.equal(f.wholeLoads.length, 0);
      }
    } finally { shift = 0; await f.close(); }
  });
});

test("transfer worker: genuine failure recovers through HTTP with no false verified delivery", async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { failDelivery: true }), observed = [];
  const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: 5, onPeerDelivery: row => observed.push(row),
    swarmOptions: { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl } });
  try {
    await until(() => f.swarm.metrics().core.transferWorker.state === "ready");
    sameBytes(await f.load(), f.bytes);
    const metrics = f.swarm.metrics();
    assert.equal(metrics.core.transferWorker.state, "failed");
    assert.equal(metrics.core.transferWorker.reason, "worker-error");
    assert.equal(metrics.core.state, "ready", "a worker failure does not retire healthy main-thread peer links");
    assert.equal(metrics.bytes.peerFirst, 0);
    assert.deepEqual(observed, []);
    assert.equal(workers[0].terminated, true);
    const requests = f.channels[0].wants.length;
    sameBytes(await f.load(), f.bytes);
    assert.equal(f.channels[0].wants.length, requests, "future fragments retain HTTP rather than retrying on the main thread");
  } finally { await f.close(); }
});

test("transfer worker: stopping a cached race terminates peer work while its original HTTP continues", async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t), observed = [];
  const f = await multiFixture(t, { holders: [{ delayMs: 200 }], wholeOriginDelayMs: 400,
    onPeerDelivery: row => observed.push(row),
    swarmOptions: { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl, zeroBudgetPeerRace: true } });
  try {
    await until(() => f.swarm.metrics().core.transferWorker.state === "ready");
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    const pending = beginCountedMultiLoad(f);
    assert.equal(f.wholeLoads.length, 1, "the ordinary HTTP request starts synchronously");
    await until(() => f.channels[0].wants.length > 0);
    f.swarm.stop();
    sameBytes(await pending.response, f.bytes);
    assert.equal(pending.calls.success.length, 1);
    assert.equal(pending.calls.abort.length, 0);
    assert.equal(pending.calls.error.length, 0);
    assert.equal(f.wholeLoads[0].loader.aborted, false);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.deepEqual(observed, []);
    assert.equal(f.swarm.metrics().core.transferWorker.state, "stopped");
    assert.equal(workers[0].terminated, true);
  } finally { await f.close(); }
});

// A real partial payload establishes a fresh slow estimate. Later requests
// arrive in short bursts, too short to replace that estimate's 300ms flow
// floor. No selection state or private swarm fields are injected by the test.
class PartialThenBurstChannel extends RangedChannel {
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  trainingId = null;
  send(data) {
    const frame = typeof data === "string" ? JSON.parse(data) : null;
    if (frame?.t === "want" && this.trainingId === null) {
      this.trainingId = frame.id;
      RecordedChannel.prototype.send.call(this, data);
      this.wants.push(frame.p ?? null);
      const pieceSize = commitmentPieceSize(this.bytes.length);
      const size = frame.p ? Math.min(this.bytes.length, frame.p[1] * pieceSize) - frame.p[0] * pieceSize : this.bytes.length;
      setTimeout(() => {
        if (this.readyState !== "open") return;
        this.receive(JSON.stringify({ t: "meta", id: frame.id, size, ...(frame.p ? { p: frame.p } : {}) }));
        const from = frame.p ? frame.p[0] * pieceSize : 0;
        this.receive(this.bytes.slice(from, from + 16_384).buffer);
      }, 400);
      setTimeout(() => {
        if (this.readyState !== "open" || this.cancels) return;
        const from = frame.p ? frame.p[0] * pieceSize : 0;
        this.receive(this.bytes.slice(from + 16_384, from + 32_768).buffer);
      }, 600);
      return;
    }
    if (frame?.t === "cancel" && frame.id === this.trainingId) {
      RecordedChannel.prototype.send.call(this, data); this.cancels++;
      setTimeout(() => this.receive(JSON.stringify({ t: "eof", id: frame.id })), 1);
      return;
    }
    super.send(data);
  }
}

// Trace-shaped service: startup is distinct from the time carrying bytes.
// The real core sees native ordered framing and reports both timings itself.
class PhasedFlowChannel extends RangedChannel {
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  constructor(bytes, options = {}) {
    super(bytes, options);
    this.firstByteMs = options.firstByteMs ?? 625;
    this.flowMs = options.flowMs ?? 619;
  }
  send(data) {
    const frame = typeof data === "string" ? JSON.parse(data) : null;
    if (frame?.t === "cancel") {
      RecordedChannel.prototype.send.call(this, data); this.cancels++;
      setTimeout(() => this.receive(JSON.stringify({ t: "eof", id: frame.id })), 1);
      return;
    }
    if (frame?.t !== "want") return super.send(data);
    RecordedChannel.prototype.send.call(this, data);
    this.wants.push(frame.p ?? null);
    const size = commitmentPieceSize(this.bytes.length);
    const from = frame.p ? frame.p[0] * size : 0;
    const to = frame.p ? Math.min(this.bytes.length, frame.p[1] * size) : this.bytes.length;
    const body = this.bytes.slice(from, to), cancelled = this.cancels;
    const chunks = Math.ceil(body.length / 16_384);
    setTimeout(() => {
      if (this.readyState === "open") this.receive(JSON.stringify({ t: "meta", id: frame.id, size: body.length, ...(frame.p ? { p: frame.p } : {}) }));
    }, 0);
    setTimeout(() => {
      if (this.readyState !== "open" || this.cancels !== cancelled) return;
      this.receive(body.slice(0, Math.min(16_384, body.length)).buffer);
    }, this.firstByteMs);
    for (let chunk = 1; chunk < Math.max(2, chunks); chunk++) setTimeout(() => {
      if (this.readyState !== "open" || this.cancels !== cancelled) return;
      if (chunk < chunks) this.receive(body.slice(chunk * 16_384, (chunk + 1) * 16_384).buffer);
      if (chunk === Math.max(1, chunks - 1)) this.receive(JSON.stringify({ t: "eof", id: frame.id }));
    }, this.firstByteMs + this.flowMs * chunk / Math.max(1, chunks - 1));
  }
}

test('verified piece flow scalar batches include gaps and only fresh credited fractions', () => {
  const flow = new VerifiedPieceFlow();
  assert.equal(flow.record({ freshBytes: 10000, startAt: 1000, endAt: 1100 }), null);
  assert.equal(flow.record({ freshBytes: 10000, startAt: 1150, endAt: 1230 }), null);
  assert.deepEqual(flow.record({ freshBytes: 12768, startAt: 1300, endAt: 1400 }), { bytes: 32768, flowMs: 400 });
  assert.equal(flow.record({ freshBytes: 0, startAt: 0, endAt: 9999 }), null, 'duplicates add neither bytes nor a new anchor');
  assert.deepEqual(flow.record({ freshBytes: 32768, startAt: 1400, endAt: 1700 }), { bytes: 32768, flowMs: 300 }, 'emitted bytes never enter another batch');
});

test('verified piece flow preserves earlier out-of-order starts and rejects overlap with an emitted window', () => {
  const flow = new VerifiedPieceFlow();
  assert.equal(flow.record({ freshBytes: 16384, startAt: 200, endAt: 300 }), null);
  assert.deepEqual(flow.record({ freshBytes: 16384, startAt: 100, endAt: 400 }), { bytes: 32768, flowMs: 300 });
  assert.equal(flow.record({ freshBytes: 65536, startAt: 399, endAt: 700 }), null, 'a late range is discarded, never clamped while counting its bytes');
  assert.deepEqual(flow.record({ freshBytes: 32768, startAt: 700, endAt: 1000 }), { bytes: 32768, flowMs: 300 });
});

test('verified piece flow keeps the byte and wall-time floors and discards pending failure evidence', () => {
  const flow = new VerifiedPieceFlow();
  assert.equal(flow.record({ freshBytes: 32767, startAt: 0, endAt: 300 }), null);
  flow.discard(300);
  assert.equal(flow.record({ freshBytes: 32768, startAt: 300, endAt: 599.999 }), null);
  assert.equal(flow.record({ freshBytes: 0, startAt: 300, endAt: 600 }), null);
  assert.deepEqual(flow.record({ freshBytes: 1, startAt: 600, endAt: 600 }), { bytes: 32769, flowMs: 300 });
  assert.equal(flow.record({ freshBytes: 20000, startAt: 700, endAt: 900 }), null);
  flow.discard(900);
  assert.equal(flow.record({ freshBytes: 20000, startAt: 950, endAt: 1100 }), null);
  assert.deepEqual(flow.record({ freshBytes: 12768, startAt: 1150, endAt: 1250 }), { bytes: 32768, flowMs: 300 });
});

test('verified piece flow never pools separate transfers, connections or time to first byte', async t => {
  const selection = Object.getPrototypeOf((await loadCore(multiCore)).peerSelection()), observe = selection.observe;
  const batches = [];
  t.mock.method(selection, 'observe', function (input = {}) {
    if (!Number.isFinite(input.firstByteMs)) batches.push({ ...input });
    return observe.call(this, input);
  });
  const clock = virtualClock(t); let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 65536, holders: [{ delayMs: 100 }],
      wholeOriginDelayMs: 10000, originDelayMs: 10000, originFallbackMs: 1000 }));
    for (let i = 0; i < 4; i++) sameBytes(await clock.settle(f.load()), f.bytes);
    assert.equal(f.swarm.metrics().core.multiHolder.transfers, 4);
    assert.deepEqual(batches, [], 'four sub-floor transfers on the same connection never become one sample');
    await clock.settle(f.close()); f = null;
    f = await clock.settle(multiFixture(t, { size: 2 * 65536, holders: [
      { Channel: PhasedFlowChannel, firstByteMs: 100, flowMs: 50 },
      { Channel: PhasedFlowChannel, firstByteMs: 400, flowMs: 50 }],
      wholeOriginDelayMs: 10000, originDelayMs: 10000, originFallbackMs: 1000 }));
    sameBytes(await clock.settle(f.load()), f.bytes);
    assert.equal(f.channels.filter(channel => channel.wants.length > 0).length, 2, JSON.stringify(f.channels.map(channel => channel.wants)));
    assert.deepEqual(batches, [], 'two different 50ms connection flows 350ms apart never pool');
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

// Functional policy time excludes only actual native segment-key digest work.
// Native fixtures never install this observer; payload hashes remain native.
function logicalSegmentKeyDigests(t, swarmId, delayForKey = () => 0) {
  const prefix = new TextEncoder().encode(`${swarmId}\n`), originalDigest = crypto.subtle.digest, nativeTimer = setTimeout;
  let pending = 0, operations = 0, maxPending = 0, delayedOperations = 0;
  const mock = t.mock.method(crypto.subtle, 'digest', function (algorithm, data, ...args) {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    const matched = algorithm === 'SHA-256' && bytes && bytes.byteLength > prefix.byteLength &&
      bytes.byteLength <= 4096 && prefix.every((value, index) => bytes[index] === value);
    if (!matched) return originalDigest.call(this, algorithm, data, ...args);
    const delayMs = delayForKey(); assert(Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 100);
    pending++; operations++; maxPending = Math.max(maxPending, pending);
    try {
      return Promise.resolve(originalDigest.call(this, algorithm, data, ...args)).then(value => {
        if (!delayMs) { pending--; return value; }
        delayedOperations++;
        return new Promise(resolve => nativeTimer(() => { pending--; resolve(value); }, delayMs));
      }, error => { pending--; throw error; });
    } catch (error) { pending--; throw error; }
  });
  return { get pending() { return pending; }, get operations() { return operations; },
    get maxPending() { return maxPending; }, get delayedOperations() { return delayedOperations; }, restore: () => mock.mock.restore() };
}

for (const playlistState of ['vod', 'live', 'unknown', 'live-demand-before-have']) test('owned warm reciprocal future owners supply real mixed consumption without duplicate whole source' +
  (playlistState === 'vod' ? '' : ` (${playlistState} playlist)`), { timeout: 15000 }, async t => {
  // Functional-controller policy proof: simulated source/native RTC, real sessions,
  // commitments, Core, ordered protocol bytes, verification and consumption.
  // No source server, preloaded cache/HAVE or claimed WAN rate. Native key-hash
  // scheduling is excluded from this controller's synthetic policy time; the
  // separate manager control retains the original 25 ms cache recovery boundary.
  const pair = await framingPairFixture(t, { pairedState: true }), actors = [], source = [], loaders = new Set(), objects = new Map(), events = new Map();
  const size = 1024 * 1024, secret = generateSecretKey(), seconds = Math.floor(Date.now() / 1000);
  const streamEvent = finalizeEvent({ kind: 30311, created_at: seconds,
    tags: [['d', 'reciprocal-futures'], ['relayswarm', 'redistribute', '1']], content: '' }, secret);
  const keyFor = path => createHash('sha256').update(`${base.swarmId}\n${path}`).digest('hex');
  let diagnosticPhase = 'setup', clock;
  const keyWork = logicalSegmentKeyDigests(t, base.swarmId);
  const settle = promise => clock ? clock.settle(promise) : promise;
  const wait = predicate => clock ? clock.advanceUntil(predicate) : until(predicate);
  const diagnostic = (reason, actor = null, sn = null) => console.log(JSON.stringify({ fixture: 'reciprocal-timeout-diagnostic',
    reason, actor, sn, controllerClock: clock ? 'logical-functional' : 'native', phase: diagnosticPhase, atMs: performance.now(),
    excludedNativeKeyDigestScheduling: true, pendingKeyDigests: keyWork.pending, keyDigestOperations: keyWork.operations, maxPendingKeyDigests: keyWork.maxPending,
    source: source.slice(-16), sourceOmitted: Math.max(0, source.length - 16),
    actors: actors.map((f, actor) => { const m = f.swarm.metrics(); return { actor, warm: m.warmAhead,
      acceptedPeerBytes: m.bytes.peerFirst, core: { state: m.core.state, transfers: m.core.multiHolder.transfers,
        delivered: m.core.multiHolder.delivered, failed: m.core.multiHolder.failed, peerBytes: m.core.multiHolder.peerBytes },
      requests: m.peerRequestDiagnostics.records.slice(-8).map(r => ({ atMs:r.atMs,outcome:r.outcome,elapsedMs:r.elapsedMs,receivedBytes:r.receivedBytes })),
      trace: f.swarm.trace().rows.filter(r => ['load','mixedScope','eligibility','xfer','xferFinish','originStart','origin'].includes(r.k)).slice(-32)
        .map(r => ({ k:r.k,load:r.load,at:r.at,sn:r.sn,reason:r.reason,ms:r.ms,role:r.budgetGeometry?.source,
          phase:r.phase,scope:r.scope,setupRemainingMs:r.setupRemainingMs,originInvoked:r.originInvoked,
          op:r.op,peerOnly:r.peerOnly,exclusiveOrigin:r.exclusiveOrigin,delivered:r.delivered,
          ranged:r.ranged,outcome:r.outcome,bytes:r.bytes,
          commands:r.out?.c?.slice(0,8).map(c=>({t:c.t,p:c.p})) })) }; }) }));

  const getCommitment = ctx => {
    const path = new URL(ctx.url).pathname, data = objects.get(path); assert(data);
    const id = `${path}:${ctx.frag.sn}:${ctx.frag.cc}`;
    if (!events.has(id)) {
      const pieceSize = commitmentPieceSize(data.length), pieces = [];
      for (let at = 0; at < data.length; at += pieceSize) pieces.push(createHash('sha256').update(data.subarray(at, at + pieceSize)).digest('hex'));
      events.set(id, finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds,
        tags: [['x', base.swarmId], ['e', streamEvent.id]], content: commitmentContent({ v: 3,
          streamEventId: streamEvent.id, swarmId: base.swarmId, key: keyFor(path), rendition: '/media/index.m3u8',
          playlist: '/media/index.m3u8', mediaType: 'main', encryption: null, sequence: ctx.frag.sn,
          discontinuity: ctx.frag.cc, part: null, sha256: createHash('sha256').update(data).digest('hex'),
          size: data.length, pieceSize, pieces, expiresAt: seconds + 60 }) }, secret));
    }
    return events.get(id);
  };
  const invoke = (actor, frag) => {
    const f = actors[actor], ctx = { url: frag.url, frag, part: null, type: LoaderContextType.MEDIA_FRAGMENT,
      responseType: 'arraybuffer', headers: {}, rangeStart: 0, rangeEnd: 0 };
    const loader = new f.hls.config.fLoader(f.hls.config), calls = { success: 0, error: 0, abort: 0, timeout: 0 };
    frag.stats = loader.stats;
    const response = new Promise((resolve, reject) => loader.load(ctx, { timeout: 10000 }, {
      onSuccess: value => { calls.success++; resolve(new Uint8Array(value.data)); },
      onError: () => { calls.error++; reject(new Error('reciprocal source error')); },
      onAbort: () => { calls.abort++; reject(new Error('reciprocal source abort')); },
      onTimeout: () => { calls.timeout++; diagnostic('timeout', actor, frag.sn); reject(new Error('reciprocal source timeout')); },
    }));
    response.catch(() => {}); return { response, calls };
  };
  // Install before SDK creation so reentrant stop can clear every fixture timer.
    // Optional native setup admission is separately tested. Here the mandatory
    // owner/protocol proof holds only its async setup phase until ANY original
    // source invocation, whole or range; no favourable result gates time.
    clock = warmFunctionalClock(t, () => keyWork.pending > 0 || actors.some((f, actor) => {
      const rows = f.swarm.trace().rows;
      return [1, 2].some(sn => {
        const load = rows.findLast(row => row.k === 'load' && row.sn === sn && row.budgetGeometry?.source === 'warm-ahead');
        return load && rows.some(row => row.k === 'mixedScope' && row.load === load.load && row.reason === 'entry') &&
          !source.some(row => row.actor === actor && row.sn === sn);
      });
    }));
  try {
    for (const actor of [0, 1]) {
      class Source extends Loader {
        stats = new LoadStats();
        load(ctx, config, callbacks) {
          const data = objects.get(new URL(ctx.url).pathname); assert(data);
          const from = ctx.rangeEnd ? ctx.rangeStart : 0, to = ctx.rangeEnd || data.length;
          const row = { actor, sn: ctx.frag.sn, warm: Boolean(ctx[WARM_AHEAD]), range: ctx.rangeEnd ? [from, to] : null,
            bytes: 0, complete: false, aborted: false, invokedAtMs: performance.now(),
            timeoutMs: config.timeout ?? null, maxLoadTimeMs: config.loadPolicy?.maxLoadTimeMs ?? null }; source.push(row); loaders.add(this);
          this.stats.loading.start = performance.now();
          this.complete = () => {
            if (row.complete || row.aborted) return;
            row.complete = true; row.completedAtMs = performance.now(); row.bytes = to - from; this.stats.loaded = this.stats.total = row.bytes;
            this.stats.loading.first = this.stats.loading.end = performance.now();
            callbacks.onSuccess({ data: data.slice(from, to).buffer, code: row.range ? 206 : 200 }, this.stats, ctx, null);
          };
          this.row = row;
          // Explicit functional service scalars calibrate recovery above the
          // two-second future duration. No native elapsed/rate claim is made.
          if (ctx.frag.sn === 0 || row.range) this.timer = setTimeout(this.complete, ctx.frag.sn === 0 ? 1600 : 20);
          // Whole speculative futures stay pending until their owner ledger is
          // checked, so no holder can have advertised either future yet.
        }
        abort() { clearTimeout(this.timer); if (this.row && !this.row.complete) { this.row.aborted = true; this.row.abortedAtMs = performance.now(); } }
        destroy() { this.abort(); loaders.delete(this); }
      }
      const media = Object.assign(new EventTarget(), { currentTime: 0, paused: false, ended: false, seeking: false,
        readyState: 4, playbackRate: 1, buffered: { length: 0 } });
      actors.push(await settle(pair.make({ OriginLoader: Source, player: { media }, swarmOptions: {
        streamEvent, getCommitment, warmAhead: true, bufferedMixedRanges: true, zeroBudgetPeerRace: true,
        sustainablePeerWait: true, originReserveMs: 2000, maxPeerWaitMs: 2500, traceRequests: 4096 } })));
    }
    await wait(() => actors.every(f => f.swarm.metrics().peers.connected === 1));
    const pubkeys = actors.map(f => f.swarm.metrics().pubkey), winner = path => {
      const key = BigInt('0x' + keyFor(path));
      return (key ^ BigInt('0x' + pubkeys[0])) < (key ^ BigInt('0x' + pubkeys[1])) ? 0 : 1;
    };
    const paths = [];
    for (const owner of [0, 1]) {
      for (let n = 0; n < 256; n++) {
        const path = `/media/future-${owner}-${n}.ts`;
        if (winner(path) === owner) { paths.push(path); break; }
      }
    }
    assert.equal(paths.length, 2, 'actual peer identities yield opposite deterministic future owners');
    // (e) steadyPeerWindow is off here: these source rows and counters are main's, with no steady machinery.
    const flagOff = () => {
      for (const f of actors) assert.equal('steadyPeerWindow' in f.swarm.metrics(), false);
      for (const channel of pair.channels) {
        const grants = channel.sent.filter(row => row?.t === 'fetching' && row.ms > 0), withdrawals = channel.sent.filter(row => row?.t === 'fetching' && row.ms === 0);
        for (const key of new Set(grants.map(row => row.k))) assert(grants.filter(row => row.k === key).length <= withdrawals.filter(row => row.k === key).length + 1,
          'flag off: no FETCH renewal');
      }
    };
    objects.set('/media/lead.ts', new Uint8Array(32768).fill(9));
    paths.forEach((path, index) => objects.set(path, Uint8Array.from({ length: size }, (_, i) => (i * 131 + index * 17) % 251)));
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nlead.ts\n' +
      paths.map(path => `#EXTINF:2,\n${path.split('/').at(-1)}\n`).join('') + (playlistState === 'vod' ? '#EXT-X-ENDLIST\n' : '');
    const details = actors.map(f => {
      const parsed = M3U8Parser.parseLevelPlaylist(playlist, 'https://origin.example/media/index.m3u8', 0, 'main', 0, null);
      assert.equal(parsed.live, playlistState !== 'vod', 'use actual parser live state, rather than a claimed playback label');
      if (playlistState === 'unknown') delete parsed.live;
      f.hls.levels = [{ details: parsed }]; return parsed;
    });
    for (const f of actors) assert.deepEqual([f.swarm.metrics().core.verifier, f.swarm.metrics().core.selection, f.swarm.metrics().core.discovery], ['wasm', 'wasm', 'wasm']);
    const lead = actors.map((_, actor) => invoke(actor, details[actor].fragments[0]));
    await settle(Promise.all(lead.map(x => x.response)));
    for (const f of actors) f.hls.media.buffered = { length: 1, start: () => 0, end: () => 10 };
    await wait(() => source.filter(row => row.sn > 0).length >= 2);
    diagnosticPhase = 'owner-ledger';
    const initial = source.filter(row => row.sn > 0);
    const advertised = pair.channels.flatMap(channel => channel.sent.filter(row => row?.t === 'have').flatMap(row => row.keys ?? row.add ?? []));
    assert(paths.every(path => !advertised.includes(keyFor(path))), 'neither held future body has been seeded or advertised');
    assert(actors.every(f => f.swarm.metrics().bytes.peerFirst === 0 && f.swarm.metrics().warmAhead.verifiedPeerBytes === 0));
    if (playlistState === 'unknown') {
      assert.deepEqual(initial.map(({ actor, sn }) => ({ actor, sn })).sort((a, b) => a.actor - b.actor),
        [{ actor: 0, sn: 1 }, { actor: 1, sn: 1 }], 'unknown playlist keeps both ordinary source paths without optional election');
      for (const f of actors) assert.equal(f.swarm.metrics().warmAhead.sourceYielded, 0);
      for (const loader of loaders) if (loader.row?.sn === 1) loader.complete();
      await wait(() => actors.every(f => f.swarm.metrics().warmAhead.verified >= 1));
      const demands = actors.map((_, actor) => invoke(actor, details[actor].fragments[1]));
      await settle(Promise.all(demands.map(async demand => {
        sameBytes(await demand.response, objects.get(paths[0]));
        assert.deepEqual(demand.calls, { success: 1, error: 0, abort: 0, timeout: 0 });
      })));
      flagOff(); diagnosticPhase = 'done'; return;
    }
    console.log(JSON.stringify({ fixture: 'reciprocal-warm-source-policy', controllerClock: 'logical-functional', simulatedSourceAndRtc: true,
      excludedNativeKeyDigestScheduling: true,
      coreReady: actors.map(f => f.swarm.metrics().core.state), expectedOwners: [{ actor: 0, sn: 1 }, { actor: 1, sn: 2 }],
      actualSourceStarts: initial.map(({ actor, sn, warm, range }) => ({ actor, sn, warm, range })),
      futureHaveCount: paths.filter(path => advertised.includes(keyFor(path))).length }));
    assert.deepEqual(initial.map(({ actor, sn }) => ({ actor, sn })).sort((a, b) => a.actor - b.actor),
      [{ actor: 0, sn: 1 }, { actor: 1, sn: 2 }], 'one deterministic source owner per future; current simultaneous whole duplication is the regression');
    assert(initial.every(row => row.warm && !row.range));
    assert(actors[1].swarm.metrics().warmAhead.sourceYielded > 0, 'actor 1 skipped the unadvertised first future before fetching its own second future');
    if (playlistState === 'live-demand-before-have') {
      const enteredAt = performance.now(), demand = invoke(1, details[1].fragments[1]);
      await wait(() => source.some(row => row.actor === 1 && row.sn === 1));
      const fallback = source.find(row => row.actor === 1 && row.sn === 1);
      assert.equal(fallback.warm, false, 'genuine rank-loser owns an independent source path');
      assert.equal(fallback.range, null);
      assert(fallback.invokedAtMs - enteredAt <= 25, 'the existing mixed setup bound still starts source without waiting for a future HAVE');
      assert(fallback.timeoutMs > 0 && fallback.timeoutMs <= 10000 - (fallback.invokedAtMs - enteredAt));
      assert(!pair.channels.some(channel => channel.sent.some(row => row?.t === 'have' && (row.keys ?? row.add ?? []).includes(keyFor(paths[0])))),
        'no peer has supplied or advertised this object before recovery');
      for (const loader of loaders) if (loader.row === fallback) loader.complete();
      sameBytes(await settle(demand.response), objects.get(paths[0]));
      assert.deepEqual(demand.calls, { success: 1, error: 0, abort: 0, timeout: 0 });
      assert.equal(actors[1].swarm.metrics().bytes.peerFirst, 0);
      flagOff(); diagnosticPhase = 'done'; return;
    }
    if (playlistState === 'live') for (const [actor, f] of actors.entries()) {
      // A real live reload replaces Fragment objects. Routing must use the
      // current parsed window without keeping a previous parser object alive.
      const refreshed = M3U8Parser.parseLevelPlaylist(playlist, 'https://origin.example/media/index.m3u8', 0, 'main', 0, null);
      assert.equal(refreshed.live, true);
      assert.notEqual(refreshed.fragments[1], details[actor].fragments[1]);
      f.hls.levels[0].details = details[actor] = refreshed;
    }
    diagnosticPhase = 'owner-body-completion';
    for (const loader of loaders) if (loader.row?.sn > 0) loader.complete();
    await wait(() => actors.every(f => f.swarm.metrics().warmAhead.verified >= 1));
    await wait(() => paths.every(path => pair.channels.some(channel => channel.sent.some(row => row?.t === 'have' && (row.keys ?? row.add ?? []).includes(keyFor(path))))));
    await wait(() => actors[1].swarm.metrics().warmAhead.haveReconsidered > 0);
    for (const sn of [1, 2]) {
      diagnosticPhase = 'genuine-sn' + sn;
      const demands = actors.map((_, actor) => invoke(actor, details[actor].fragments[sn]));
      const data = objects.get(paths[sn - 1]);
      await settle(Promise.all(demands.map(async demand => { sameBytes(await demand.response, data); assert.deepEqual(demand.calls, { success: 1, error: 0, abort: 0, timeout: 0 }); })));
    }
    diagnosticPhase = 'repeat-cache-consumption';
    for (const actor of [0, 1]) {
      const f = actors[actor], metrics = f.swarm.metrics(), rows = source.filter(row => row.actor === actor && row.sn > 0);
      assert(metrics.bytes.peerFirst > 0 && metrics.bytes.peerFirst < size, JSON.stringify({ actor,
        message: 'reciprocal consumer must exercise partial Core assembly, not an unobserved whole-peer or source fallback',
        peerBytes: metrics.bytes.peerFirst, warm: Object.fromEntries(['started', 'verified', 'coalesced', 'promotions',
          'localReuseBytes', 'verifiedPeerBytes', 'consumedPeerBytes'].map(key => [key, metrics.warmAhead[key]])),
        source: rows.slice(-16), transfers: metrics.core.multiHolder.transfers, delivered: metrics.core.multiHolder.delivered,
        trace: f.swarm.trace().rows.filter(row => ['load', 'eligibility', 'mixedScope', 'xfer', 'xferFinish'].includes(row.k)).slice(-40)
          .map(row => ({ k: row.k, load: row.load, sn: row.sn, op: row.op, reason: row.reason, budgetMs: row.budgetMs,
            role: row.budgetGeometry?.source, exclusiveOrigin: row.exclusiveOrigin, peerOnly: row.peerOnly,
            commands: row.out?.c?.slice(0, 8).map(command => ({ t: command.t, p: command.p })) })) }));
      assert.equal(rows.reduce((sum, row) => sum + row.bytes, 0) + metrics.bytes.peerFirst, 2 * size, 'actual source slices and accepted peer bytes are disjoint');
      assert.equal(rows.filter(row => !row.range).length, 1, 'consumer adds no duplicate future whole GET');
      assert(rows.every(row => row.complete && !row.aborted));
      assert(f.swarm.trace().rows.some(row => row.k === 'xfer' && row.op === 'start' && row.exclusiveOrigin === true &&
        row.out.c.some(command => command.t === 'request') && row.out.c.some(command => command.t === 'origin')), 'actual Core mixed plan consumes the other holder');
      const credit = metrics.bytes.peerFirst, before = source.length;
      sameBytes(await settle(invoke(actor, details[actor].fragments[2]).response), objects.get(paths[1]));
      assert.equal(f.swarm.metrics().bytes.peerFirst, credit, 'reusing the same future cannot credit it twice');
      assert.equal(source.length, before);
    }
    flagOff();
    assert(keyWork.operations > 0, 'the fixed metadata digest phase actually ran');
    assert.equal(keyWork.pending, 0, 'all observed native key digests settled');
    diagnosticPhase = 'done';
  } finally {
    if (diagnosticPhase !== 'done') diagnostic('finally');
    keyWork.restore(); clock?.restore(); pair.close(); for (const loader of [...loaders]) loader.destroy();
  }
});

// --- steady peer window (opt-in steadyPeerWindow) ------------------------------

test('steady peer window requires a boolean and peer-first serving multi-holder loading', () => {
  const signed = signedFixture({ v: 3 });
  const peerFirst = { mode: 'peer-first', streamEvent: signed.options.streamEvent, getCommitment: () => signed.event };
  for (const [options, reason] of [[{ steadyPeerWindow: 1 }, 'invalid-steady-peer-window-option'],
    [{ steadyPeerWindow: 'true' }, 'invalid-steady-peer-window-option'],
    [{ steadyPeerWindow: true }, 'invalid-steady-peer-window-option'],
    [{ ...peerFirst, steadyPeerWindow: true, multiHolder: true }, 'invalid-steady-peer-window-option'],
    [{ ...peerFirst, steadyPeerWindow: true, serve: true }, 'invalid-steady-peer-window-option'],
    [{ ...peerFirst, steadyPeerWindow: true, serve: true, multiHolder: true }, null]]) {
    const swarm = createHlsSwarm({ ...base, relays: ['wss://relay.example'], ...options });
    assert.equal(swarm.metrics().disabledReason, reason, JSON.stringify(options));
    assert.equal('steadyPeerWindow' in swarm.metrics(), options.steadyPeerWindow === true);
    if (reason === null) assert.deepEqual(swarm.metrics().steadyPeerWindow, { opened: 0, closedHeadroom: 0, leaseWaits: 0, waitHave: 0,
      waitLapsed: 0, waitWindowEnd: 0, leasesIgnored: 0, peerOnlyStarted: 0, peerOnlyDelivered: 0, peerOnlyFallback: 0, takeUpWindowEnd: 0, fetchRenewalsSent: 0 });
    swarm.stop();
  }
  const off = createHlsSwarm({ ...base, relays: ['wss://relay.example'] });
  assert.equal('steadyPeerWindow' in off.metrics(), false, 'flag off adds no metrics field');
  off.stop();
});

// Logical send times of the FETCH and HAVE frames a holder channel receives.
function timedControlFrames(channel) {
  const frames = [], send = channel.send.bind(channel);
  channel.send = data => {
    if (typeof data === 'string') {
      const frame = JSON.parse(data);
      if (frame.t === 'fetching' || frame.t === 'have') frames.push({ ...frame, at: performance.now() });
    }
    return send(data);
  };
  return frames;
}

test('steady peer window (a): FETCH renewal keeps a 3,500 ms origin fetch leased and withdraws only after HAVE', async t => {
  for (const flag of [true, false]) await t.test(flag ? 'renewed' : 'flag off: one lease per claim', async t => {
    const clock = warmFunctionalClock(t, () => false);
    let f;
    try {
      f = await clock.settle(multiFixture(t, { holders: [{ silent: true }], wholeOriginDelayMs: 3500,
        swarmOptions: { serve: true, ...(flag ? { steadyPeerWindow: true } : {}) } }));
      f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
      const frames = timedControlFrames(f.channels[0]);
      const started = performance.now();
      sameBytes(await clock.settle(f.load()), f.bytes);
      const done = performance.now(), leases = frames.filter(row => row.t === 'fetching' && row.k === f.key);
      const grants = leases.filter(row => row.ms > 0), withdrawn = leases.findIndex(row => row.ms === 0);
      const advertised = frames.findIndex(row => row.t === 'have' && (row.add ?? row.keys ?? []).includes(f.key));
      assert.equal(f.wholeLoads.length, 1);
      assert(done - started >= 3500, 'the origin fetch outlasts one 2,000 ms lease');
      assert(advertised >= 0 && withdrawn >= 0, JSON.stringify(frames));
      assert(frames.indexOf(leases[withdrawn]) > advertised, 'ms: 0 follows the retained HAVE');
      if (!flag) {
        assert.equal(grants.length, 1, 'flag off keeps today\'s single FETCH per claim');
        assert.equal('steadyPeerWindow' in f.swarm.metrics(), false);
        return;
      }
      assert(grants.length >= 4, JSON.stringify(grants));
      grants.forEach((row, index) => { if (index) assert(row.at - grants[index - 1].at <= 1000 + 10, 'renewed every 1,000 ms'); });
      for (let at = started; at < done; at += 10) assert(grants.some(row => row.at <= at && at < row.at + row.ms), 'lease live at ' + (at - started));
      assert.equal(f.swarm.metrics().steadyPeerWindow.fetchRenewalsSent, grants.length - 1);
      await clock.advance(2000);
      assert.equal(frames.filter(row => row.t === 'fetching' && row.ms > 0).length, grants.length, 'no renewal after release');
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test('steady peer window (a): the mixed origin lane withdraws its FETCH only after the delivered object\'s HAVE', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    lateRaceKeyClock(t);
    f = await clock.settle(multiFixture(t, { size: 1024 * 1024, holders: [{ Channel: PhasedFlowChannel, firstByteMs: 10, flowMs: 350 }],
      originDelayMs: 100, wholeOriginDelayMs: 500, swarmOptions: { bufferedMixedRanges: true, zeroBudgetPeerRace: true,
        sustainablePeerWait: true, maxPeerWaitMs: 2500, serve: true, steadyPeerWindow: true } }));
    f.ctx = { ...multiContext, frag: { ...multiContext.frag, start: 10, duration: .1 } };
    f.hls.media = { currentTime: 10, paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1, buffered: { length: 0 } };
    // Calibrate origin timing on another object, so the measured key is not already held.
    const train = { ...f.ctx, url: 'https://origin.example/media/train.ts', frag: { ...f.ctx.frag, url: 'https://origin.example/media/train.ts' } };
    sameBytes(await clock.settle(f.load(train)), f.bytes);
    for (const pc of f.connections) pc.connectionState = 'connected';
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    assert.equal(f.swarm.metrics().bytes.held, f.bytes.length, 'only the calibration object is held');
    const frames = timedControlFrames(f.channels[0]);
    sameBytes(await clock.settle(f.load(f.ctx)), f.bytes);
    const metrics = f.swarm.metrics();
    assert(f.ranges.length > 0 && metrics.core.multiHolder.delivered >= 1, 'the mixed transfer used its origin lane');
    const leases = frames.filter(row => row.t === 'fetching' && row.k === f.key);
    const advertised = frames.findIndex(row => row.t === 'have' && (row.add ?? row.keys ?? []).includes(f.key));
    const withdrawn = frames.findIndex(row => row.t === 'fetching' && row.k === f.key && row.ms === 0);
    assert(leases.some(row => row.ms > 0) && advertised >= 0 && withdrawn > advertised, JSON.stringify(frames));
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

const STEADY_RENDITION = 'main:/media/index.m3u8';
// A non-owner viewer with 18 s of buffer ahead of the demanded fragment, at
// zero peer budget (sustainablePeerWait with an origin p90 above the fragment
// duration), and serving links whose HAVE and FETCH frames each test controls.
// Origin timing comes from an actual source load of another object; no link
// model, HAVE or lease is seeded. W = min(maxPeerWaitMs 800, ...) = 800 ms.
async function steadyWindowFixture(t, clock, { holders = [{}], swarmOptions = {}, bufferedEnd = 28, ...options } = {}) {
  lateRaceKeyClock(t);
  const f = await clock.settle(multiFixture(t, { size: 512 * 1024, holders, wholeOriginDelayMs: 500, originDelayMs: 50, traceRequests: 4096, ...options,
    swarmOptions: { serve: true, steadyPeerWindow: true, sustainablePeerWait: true, maxPeerWaitMs: 800, ...swarmOptions } }));
  for (const channel of f.channels) channel.receive(JSON.stringify({ t: 'have', keys: [] }));
  f.ctx = { ...multiContext, frag: { ...multiContext.frag, start: 28, duration: .5 } };
  f.hls.levels = [{ details: { live: true } }];
  f.hls.media = { currentTime: 10, paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1, buffered: { length: 0 } };
  const train = { ...f.ctx, url: 'https://origin.example/media/train.ts', frag: { ...f.ctx.frag, url: 'https://origin.example/media/train.ts' } };
  sameBytes(await clock.settle(f.load(train)), f.bytes);
  for (const pc of f.connections) pc.connectionState = 'connected';
  for (const channel of f.channels) channel.receive(JSON.stringify({ t: 'contribution', serving: true, rendition: STEADY_RENDITION }));
  f.hls.media.buffered = { length: 1, start: () => 0, end: () => bufferedEnd };
  f.lease = (ms, channel = f.channels[0]) => channel.receive(JSON.stringify({ t: 'fetching', k: f.key, ms }));
  f.have = (channel = f.channels[0]) => channel.receive(JSON.stringify({ t: 'have', keys: [f.key] }));
  f.trained = f.wholeLoads.length;
  f.steady = () => f.swarm.metrics().steadyPeerWindow;
  // Starts a genuine demand; resolves with the logical ms until its first source invocation.
  f.demand = async (limitMs = 3000) => {
    const before = f.wholeLoads.length + f.ranges.length, started = performance.now(), load = beginCountedMultiLoad(f, f.ctx);
    await clock.advanceUntil(() => f.wholeLoads.length + f.ranges.length > before || load.calls.success.length, limitMs);
    return { ...load, sourceAfterMs: performance.now() - started };
  };
  return f;
}

test('steady peer window: with no lease and no HAVE today\'s path starts at once with its own budgets', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    f = await steadyWindowFixture(t, clock);
    const demand = await f.demand();
    assert(demand.sourceAfterMs <= 10, 'no wait without a live lease'); // one 10 ms logical step for the key digest
    assert.equal(f.wholeLoads.length, f.trained + 1);
    assert.strictEqual(f.wholeLoads.at(-1).config, f.loaderConfig, 'today\'s path keeps the original config');
    sameBytes(await clock.settle(demand.response), f.bytes);
    assert.deepEqual({ ...f.steady(), fetchRenewalsSent: 0 }, { opened: 1, closedHeadroom: 0, leaseWaits: 0, waitHave: 0, waitLapsed: 0,
      waitWindowEnd: 0, leasesIgnored: 0, peerOnlyStarted: 0, peerOnlyDelivered: 0, peerOnlyFallback: 0, takeUpWindowEnd: 0, fetchRenewalsSent: 0 });
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (c): a lease that lapses without HAVE falls back within lapse plus grace on reduced budgets', async t => {
  for (const ending of ['expiry', 'withdrawn']) await t.test(ending, async t => {
    const clock = warmFunctionalClock(t, () => false);
    let f;
    try {
      f = await steadyWindowFixture(t, clock);
      f.lease(ending === 'expiry' ? 300 : 2000);
      if (ending === 'withdrawn') setTimeout(() => f.lease(0), 200);
      const demand = await f.demand();
      const lapse = ending === 'expiry' ? 300 : 200;
      assert(demand.sourceAfterMs >= lapse + 250 && demand.sourceAfterMs <= lapse + 250 + 20, String(demand.sourceAfterMs));
      const row = f.wholeLoads.at(-1);
      assert.equal(f.wholeLoads.length, f.trained + 1); assert.deepEqual(f.ranges, []);
      assert(Math.abs(row.config.loadPolicy.maxLoadTimeMs - (10_000 - demand.sourceAfterMs)) <= 10, 'parent budget less the elapsed time only');
      assert(Math.abs(row.config.loadPolicy.maxTimeToFirstByteMs - (10_000 - demand.sourceAfterMs)) <= 10);
      assert.equal(row.config.maxRetry, 0);
      sameBytes(await clock.settle(demand.response), f.bytes);
      assert.deepEqual([f.steady().opened, f.steady().leaseWaits, f.steady().waitLapsed, f.steady().waitHave, f.steady().waitWindowEnd], [1, 1, 1, 0, 0]);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
      // The miss cooldown: the same link's next lease is ignored, today's path runs at once.
      f.lease(2000);
      const next = await f.demand();
      assert(next.sourceAfterMs <= 10); // one 10 ms logical step for the key digest
      assert.equal(f.steady().leaseWaits, 1); assert.equal(f.steady().leasesIgnored, 1);
      sameBytes(await clock.settle(next.response), f.bytes);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test('steady peer window (R6): a window that ends while the lease is live falls back with no cooldown', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    f = await steadyWindowFixture(t, clock);
    for (const round of [1, 2]) {
      f.lease(2000);
      const demand = await f.demand();
      assert(demand.sourceAfterMs >= 800 && demand.sourceAfterMs <= 810, String(demand.sourceAfterMs));
      sameBytes(await clock.settle(demand.response), f.bytes);
      assert.deepEqual([f.steady().leaseWaits, f.steady().waitWindowEnd, f.steady().waitLapsed, f.steady().leasesIgnored], [round, round, 0, 0]);
    }
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (d): a window closed by headroom runs today\'s path with no wait', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    // 6 s of buffer: 4,000 ms less one recovery and two reserves leaves under 500 ms.
    f = await steadyWindowFixture(t, clock, { bufferedEnd: 16 });
    f.ctx.frag.start = 16;
    f.lease(2000);
    const demand = await f.demand();
    assert(demand.sourceAfterMs <= 10); // one 10 ms logical step for the key digest
    assert.strictEqual(f.wholeLoads.at(-1).config, f.loaderConfig);
    sameBytes(await clock.settle(demand.response), f.bytes);
    assert.deepEqual([f.steady().opened, f.steady().closedHeadroom, f.steady().leaseWaits], [0, 1, 0]);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (f): an old peer\'s single unrenewed lease ends the wait at its lapse and degrades to today\'s source', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    f = await steadyWindowFixture(t, clock);
    f.lease(400); // one FETCH, never renewed; its HAVE comes after lapse plus grace
    setTimeout(() => f.have(), 700);
    const demand = await f.demand();
    assert(demand.sourceAfterMs >= 650 && demand.sourceAfterMs <= 670, String(demand.sourceAfterMs));
    sameBytes(await clock.settle(demand.response), f.bytes);
    assert.equal(f.wholeLoads.length, f.trained + 1); assert.deepEqual(f.ranges, []); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.deepEqual([f.steady().leaseWaits, f.steady().waitLapsed, f.steady().waitHave], [1, 1, 0]);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (g): a spoofed lease that never becomes HAVE costs one bounded wait, then is ignored for 10 s', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    f = await steadyWindowFixture(t, clock);
    f.lease(300);
    const first = await f.demand();
    assert(first.sourceAfterMs <= 300 + 250 + 20, String(first.sourceAfterMs));
    sameBytes(await clock.settle(first.response), f.bytes);
    const cooled = performance.now();
    for (let n = 0; n < 3; n++) {
      f.lease(2000);
      const again = await f.demand();
      assert(again.sourceAfterMs <= 10, 'ignored inside the cooldown'); // one 10 ms logical step for the key digest
      sameBytes(await clock.settle(again.response), f.bytes);
    }
    assert.deepEqual([f.steady().leaseWaits, f.steady().leasesIgnored], [1, 3]);
    await clock.advance(Math.max(0, 10_000 - (performance.now() - cooled)) + 10);
    f.lease(300);
    const later = await f.demand();
    assert(later.sourceAfterMs >= 550, 'honoured again after the cooldown');
    sameBytes(await clock.settle(later.response), f.bytes);
    assert.deepEqual([f.steady().leaseWaits, f.steady().waitLapsed], [2, 2]);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (b): a lease wait then a peer-only take-up delivers with zero source bytes', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    f = await steadyWindowFixture(t, clock);
    f.lease(2000);
    setTimeout(() => f.have(), 300);
    const load = beginCountedMultiLoad(f, f.ctx), started = performance.now();
    sameBytes(await clock.settle(load.response), f.bytes);
    const elapsed = performance.now() - started, metrics = f.swarm.metrics();
    assert(elapsed >= 300 && elapsed < 800, String(elapsed));
    assert.equal(f.wholeLoads.length, f.trained, 'no whole source GET'); assert.deepEqual(f.ranges, [], 'no source range');
    assert.equal(metrics.bytes.peerFirst, f.bytes.length); assert.equal(metrics.core.multiHolder.originBytes, 0);
    assert.deepEqual(load.calls.abort.length + load.calls.error.length, 0);
    assert(f.channels[0].wants.length > 0 && f.channels[0].wants.every(range => Array.isArray(range)));
    assert(f.swarm.trace().rows.some(row => row.k === 'xfer' && row.op === 'start' && row.peerOnly === true &&
      row.out.c.every(command => command.t !== 'origin')), 'a peer-only Core plan with no origin command');
    assert.equal(metrics.segments.zeroBudgetPeerRaces, 0, 'a steady take-up is not a cached race');
    const steady = f.steady();
    assert.deepEqual([steady.opened, steady.leaseWaits, steady.waitHave, steady.peerOnlyStarted, steady.peerOnlyDelivered, steady.peerOnlyFallback],
      [1, 1, 1, 1, 1, 0]);
    // Settled: the next demand finds the exact HAVE at entry and takes it without waiting.
    const next = beginCountedMultiLoad(f, f.ctx), at = performance.now();
    sameBytes(await clock.settle(next.response), f.bytes);
    assert(performance.now() - at < 300); assert.equal(f.wholeLoads.length, f.trained);
    assert.deepEqual([f.steady().leaseWaits, f.steady().peerOnlyDelivered], [1, 2]);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (i): an unknown-model peer-only take-up re-learns the link and the next evaluation fits', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    // Each request flows for 100 ms, below the 300 ms floor; the whole
    // eight-piece object spans more than 300 ms across the Core's batches.
    f = await steadyWindowFixture(t, clock, { holders: [{ Channel: PhasedFlowChannel, firstByteMs: 10, flowMs: 100 }] });
    f.have();
    const before = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(before.verifiedShortBatches, 0); assert.equal(before.lastModel, null, 'no model before the take-up');
    sameBytes(await clock.settle(beginCountedMultiLoad(f, f.ctx).response), f.bytes);
    let flow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(flow.lastModel.rateBytesPerSecond, null, 'the take-up began on an unknown model');
    assert.equal(flow.verifiedShortBatches, 1, 'exactly one qualifying short-flow sample: ' + JSON.stringify(flow));
    assert.equal(f.wholeLoads.length, f.trained); assert.deepEqual(f.ranges, []);
    sameBytes(await clock.settle(beginCountedMultiLoad(f, f.ctx).response), f.bytes);
    flow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(flow.lastModel.decision, 'fit', JSON.stringify(flow.lastModel));
    assert(flow.lastModel.rateBytesPerSecond > 0);
    assert.deepEqual([f.steady().peerOnlyDelivered, f.steady().peerOnlyFallback], [2, 0]);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (k): a peer-only take-up that bans a bad piece falls back to source with no credit for rejected bytes', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    f = await steadyWindowFixture(t, clock, { holders: [{ corrupt: true }] });
    f.lease(2000);
    setTimeout(() => f.have(), 100);
    const load = beginCountedMultiLoad(f, f.ctx);
    sameBytes(await clock.settle(load.response), f.bytes);
    const metrics = f.swarm.metrics();
    assert.equal(f.wholeLoads.length, f.trained + 1, 'one whole source fallback');
    assert(f.wholeLoads.at(-1).config.loadPolicy.maxLoadTimeMs < 10_000, 'on budgets reduced by the elapsed time');
    assert.equal(metrics.peers.banned, 1); assert.equal(metrics.core.multiHolder.bans, 1);
    assert.equal(metrics.bytes.peerFirst, 0); assert.equal(metrics.bytes.fromPeers, 0); assert.equal(metrics.core.multiHolder.peerBytes, 0);
    assert.deepEqual([f.steady().peerOnlyStarted, f.steady().peerOnlyDelivered, f.steady().peerOnlyFallback], [1, 0, 1]);
    assert.equal(load.calls.success.length, 1);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (R6): a take-up refused before any request (commitment unavailable) does not cool the holder', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f, refuse = false;
  try {
    f = await steadyWindowFixture(t, clock, { beforeCommitment: () => { if (refuse) throw new Error('commitment unavailable'); } });
    refuse = true;
    f.lease(2000);
    setTimeout(() => f.have(), 100);
    const first = beginCountedMultiLoad(f, f.ctx);
    sameBytes(await clock.settle(first.response), f.bytes);
    assert.deepEqual(f.channels[0].wants, [], 'no request reached the holder');
    assert.equal(f.wholeLoads.length, f.trained + 1);
    assert.equal(f.swarm.metrics().segments.commitmentUnavailable, 1);
    assert.deepEqual([f.steady().waitHave, f.steady().peerOnlyStarted, f.steady().peerOnlyFallback], [1, 1, 1]);
    refuse = false;
    f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    f.lease(300);
    const next = await f.demand();
    assert(next.sourceAfterMs >= 550, 'the same holder\'s next lease is honoured: ' + next.sourceAfterMs);
    sameBytes(await clock.settle(next.response), f.bytes);
    assert.deepEqual([f.steady().leaseWaits, f.steady().leasesIgnored], [2, 0]);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (R4): a whole-object link model too slow for the object in W returns to today\'s path on budgets less the elapsed time', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f, commitmentMs = 0;
  try {
    // 320 ms per one-piece request: the first take-up moves the whole 128 KiB object in two requests (~205 KB/s).
    f = await steadyWindowFixture(t, clock, { size: 128 * 1024, holders: [{ Channel: PhasedFlowChannel, firstByteMs: 10, flowMs: 320 }],
      beforeCommitment: () => commitmentMs ? new Promise(resolve => setTimeout(resolve, commitmentMs)) : undefined });
    f.have();
    sameBytes(await clock.settle(beginCountedMultiLoad(f, f.ctx).response), f.bytes);
    assert.deepEqual([f.steady().peerOnlyDelivered, f.wholeLoads.length], [1, f.trained], 'the first take-up moved the whole object');
    // A 300 ms commitment leaves ~500 ms of W: the whole-object model cannot fit 128 KiB.
    commitmentMs = 300;
    const wants = f.channels[0].wants.length, sources = f.wholeLoads.length;
    const next = beginCountedMultiLoad(f, f.ctx);
    await clock.advanceUntil(() => f.wholeLoads.length > sources, 1000);
    const model = f.swarm.metrics().core.multiHolder.peerFlow.lastModel;
    assert(model.rateBytesPerSecond > 0, JSON.stringify(model));
    assert.equal(f.channels[0].wants.length, wants, 'no request reached the holder');
    // The commitment fetch spent time from the parent budgets; the hand-back must not restart them.
    const policy = f.wholeLoads.at(-1).config.loadPolicy;
    assert(Math.abs(policy.maxLoadTimeMs - (10_000 - 300)) <= 20, JSON.stringify(policy));
    assert(Math.abs(policy.maxTimeToFirstByteMs - (10_000 - 300)) <= 20, JSON.stringify(policy));
    sameBytes(await clock.settle(next.response), f.bytes);
    assert.deepEqual([f.steady().peerOnlyStarted, f.steady().peerOnlyFallback, f.steady().leasesIgnored], [2, 1, 0]);
    commitmentMs = 0;
    f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    f.lease(300);
    const leased = await f.demand();
    assert(leased.sourceAfterMs >= 550, 'no cooldown for a local capacity refusal: ' + leased.sourceAfterMs);
    sameBytes(await clock.settle(leased.response), f.bytes);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (R5c): a model thinner than one whole object probes and re-trains instead of refusing on capacity', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    // 400 ms per request: the first take-up is cut after one 64 KiB probe (~160 KB/s, far below 512 KiB in 800 ms).
    f = await steadyWindowFixture(t, clock, { holders: [{ Channel: PhasedFlowChannel, firstByteMs: 10, flowMs: 400 }] });
    f.have();
    sameBytes(await clock.settle(beginCountedMultiLoad(f, f.ctx).response), f.bytes);
    assert.equal(f.steady().takeUpWindowEnd, 1);
    const wants = f.channels[0].wants.length;
    sameBytes(await clock.settle(beginCountedMultiLoad(f, f.ctx).response), f.bytes);
    assert(f.channels[0].wants.length > wants, 'the thin model probed again instead of refusing before any request');
    assert.deepEqual([f.steady().peerOnlyStarted, f.steady().takeUpWindowEnd, f.steady().peerOnlyFallback], [2, 2, 0]);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (R6): a lease miss cooldown survives the same author reconnecting', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    f = await steadyWindowFixture(t, clock);
    f.lease(300);
    sameBytes(await clock.settle(beginCountedMultiLoad(f, f.ctx).response), f.bytes);
    assert.equal(f.steady().waitLapsed, 1);
    // Same author, new native connection and channel.
    const channel = new RangedChannel(f.bytes), accepted = f.swarm.metrics().peers.offersAccepted;
    f.channels[0].close();
    f.peers[0].sendSignal(f.swarm.metrics().pubkey, { type: 'offer', transport: 'webrtc', requestId: 'steady-redial', payload: { sdp: 'fixture-offer' } });
    await clock.advanceUntil(() => f.connections.length === 2 && f.swarm.metrics().peers.offersAccepted > accepted, 1000);
    const event = new Event('datachannel'); event.channel = channel; f.connections[1].dispatchEvent(event);
    await clock.advanceUntil(() => f.swarm.metrics().peers.connected === 1, 1000);
    f.connections[1].connectionState = 'connected';
    channel.receive(JSON.stringify({ t: 'contribution', serving: true, rendition: STEADY_RENDITION }));
    f.lease(2000, channel);
    const next = await f.demand();
    assert(next.sourceAfterMs <= 10, 'the redialled author\'s lease is still ignored: ' + next.sourceAfterMs);
    assert.deepEqual([f.steady().leaseWaits, f.steady().leasesIgnored], [1, 1]);
    sameBytes(await clock.settle(next.response), f.bytes);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window (R1): a renewed lease dates the holder wait from its first grant at a receiver without the option', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    lateRaceKeyClock(t);
    // Receiver without steadyPeerWindow, positive budget, typical origin time 3,000 ms.
    f = await clock.settle(multiFixture(t, { holders: [{}], wholeOriginDelayMs: 3000, originFallbackMs: 1500,
      swarmOptions: { maxPeerWaitMs: 1500 } }));
    f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    const train = { ...multiContext, url: 'https://origin.example/media/train.ts', frag: { ...multiContext.frag, url: 'https://origin.example/media/train.ts' } };
    sameBytes(await clock.settle(f.load(train)), f.bytes);
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 30 };
    f.channels[0].receive(JSON.stringify({ t: 'contribution', serving: true, rendition: STEADY_RENDITION }));
    // A renewing owner: grants at 0, 1,000 and 2,000 ms of its fetch.
    for (let grant = 0; grant < 3; grant++) {
      if (grant) await clock.advance(1000);
      f.channels[0].receive(JSON.stringify({ t: 'fetching', k: f.key, ms: 2000 }));
    }
    await clock.advance(500);
    // 2,500 ms into a 3,000 ms typical fetch: 500 ms to wait, which fits the 1,500 ms limit.
    // Dating the fetch from the latest grant would project 2,500 ms and go to origin at once.
    const load = beginCountedMultiLoad(f, multiContext);
    sameBytes(await clock.settle(load.response), f.bytes);
    const counters = f.swarm.metrics().peerEligibilityDiagnostics.counters;
    assert.equal(counters['projected-late'], 0, JSON.stringify(counters));
    assert.equal(counters['no-have-wait'], 1, JSON.stringify(counters));
    assert.equal('steadyPeerWindow' in f.swarm.metrics(), false);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

// A source load whose body this SDK does not retain (an unhandled warm marker):
// its withdrawal waits for a HAVE that never comes from this load.
const unretainedWarmLoad = f => {
  const context = { ...multiContext, [WARM_AHEAD]: { peerBytes: 0 } };
  return new Promise((resolve, reject) => new f.hls.config.fLoader(f.hlsConfig).load(context, f.loaderConfig,
    { onSuccess: resolve, onError: reject, onTimeout: reject, onAbort: reject }));
};

test('steady peer window (R1): a new claim supersedes a deferred withdrawal; one ms: 0 follows the final HAVE', async t => {
  const clock = warmFunctionalClock(t, () => false);
  let f;
  try {
    lateRaceKeyClock(t);
    f = await clock.settle(multiFixture(t, { holders: [{ silent: true }], wholeOriginDelayMs: 300, swarmOptions: { serve: true, steadyPeerWindow: true } }));
    f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    const frames = timedControlFrames(f.channels[0]), started = performance.now();
    await clock.settle(unretainedWarmLoad(f));
    const firstDone = performance.now() - started;
    assert.equal(frames.some(row => row.t === 'fetching' && row.ms === 0), false, 'the unretained body\'s withdrawal is deferred');
    await clock.advance(50);
    sameBytes(await clock.settle(f.load()), f.bytes); // a second claim of the same key while the withdrawal waits
    await clock.advance(2000);
    const withdrawals = frames.filter(row => row.t === 'fetching' && row.k === f.key && row.ms === 0);
    const advertised = frames.findIndex(row => row.t === 'have' && (row.add ?? row.keys ?? []).includes(f.key));
    assert.equal(withdrawals.length, 1, JSON.stringify(frames));
    assert(withdrawals[0].at - started >= firstDone + 50 + 300, 'no ms: 0 while the second claim fetched');
    assert(advertised >= 0 && frames.indexOf(withdrawals[0]) > advertised);
    assert.equal(f.swarm.metrics().errors.total, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('steady peer window: stop during a lease wait and during a deferred withdrawal settles once and sends nothing after', async t => {
  for (const phase of ['window', 'deferral']) await t.test(phase, async t => {
    const clock = warmFunctionalClock(t, () => false);
    let f;
    try {
      f = phase === 'window' ? await steadyWindowFixture(t, clock)
        : (lateRaceKeyClock(t), await clock.settle(multiFixture(t, { holders: [{ silent: true }], wholeOriginDelayMs: 300,
          swarmOptions: { serve: true, steadyPeerWindow: true } })));
      const frames = timedControlFrames(f.channels[0]);
      let load;
      if (phase === 'window') {
        f.lease(2000);
        load = beginCountedMultiLoad(f, f.ctx);
        await clock.advance(200);
        assert.equal(f.steady().leaseWaits, 1);
      } else {
        await clock.settle(unretainedWarmLoad(f));
        assert.equal(frames.some(row => row.t === 'fetching' && row.ms === 0), false);
      }
      const sent = frames.length;
      f.swarm.stop();
      await clock.advance(3000);
      assert.equal(frames.length, sent, 'nothing is sent after stop: ' + JSON.stringify(frames.slice(sent)));
      if (load) assert.equal(load.calls.success.length + load.calls.abort.length + load.calls.error.length, 1, 'one terminal');
      assert.equal(f.swarm.metrics().errors.total, 0, JSON.stringify(f.swarm.metrics().errors));
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test('steady peer window (R5d): a reconsidered take-up joined by genuine demand is bounded by the funded window', async t => {
  for (const variant of ['deep, slow holder', 'shallow, slow holder', 'deep, fast holder']) await t.test(variant, async t => {
    const clock = warmFunctionalClock(t, () => false), slow = variant.includes('slow');
    let f;
    try {
      // Deep: 18 s of buffer, W = 800 ms. Shallow: 6 s, which funds no window.
      f = await steadyWindowFixture(t, clock, { holders: [slow ? { Channel: PhasedFlowChannel, firstByteMs: 5000, flowMs: 100 } : {}],
        bufferedEnd: variant.startsWith('deep') ? 28 : 16,
        swarmOptions: { warmAhead: true, bufferedMixedRanges: true, zeroBudgetPeerRace: true } });
      if (!variant.startsWith('deep')) f.ctx.frag.start = 16;
      f.have();
      // A reconsidered optional row with its full eight seconds left, which a genuine demand has joined.
      const enteredAt = performance.now(), deadline = enteredAt + 8000, signal = new AbortController(), context = { ...f.ctx };
      const genuine = { at: enteredAt, context };
      context[WARM_AHEAD] = { peerBytes: 0, abandon: () => false, work: () => performance.now() < deadline || genuine
        ? { context, enteredAt, deadline, signal: signal.signal, genuine, reconsidered: true } : null };
      const sources = f.wholeLoads.length + f.ranges.length, calls = { success: 0, other: 0 };
      new f.hls.config.fLoader(f.hlsConfig).load(context, f.loaderConfig, { onSuccess: () => calls.success++,
        onError: () => calls.other++, onAbort: () => calls.other++, onTimeout: () => calls.other++ });
      await clock.advanceUntil(() => f.wholeLoads.length + f.ranges.length > sources || calls.success + calls.other > 0, 9000);
      const elapsed = performance.now() - enteredAt, steady = f.steady();
      if (variant === 'deep, fast holder') {
        assert.deepEqual([calls.success, steady.peerOnlyStarted, steady.peerOnlyDelivered], [1, 1, 1], JSON.stringify(steady));
        assert.equal(f.wholeLoads.length + f.ranges.length, sources, 'taken up with no source lane');
      } else if (variant === 'deep, slow holder') {
        assert(elapsed >= 800 && elapsed <= 850, 'the joined demand\'s source starts at the funded bound, not the row deadline: ' + elapsed);
        assert.deepEqual([steady.peerOnlyStarted, steady.takeUpWindowEnd], [1, 1]);
      } else {
        assert(elapsed <= 30, 'an unfunded row skips the take-up and starts source at once: ' + elapsed);
        assert.equal(steady.peerOnlyStarted, 0);
      }
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

/** A holder that refuses every request ("none": not held or not serving now). */
class EmptyAnswerChannel extends RangedChannel {
  send(data) {
    if (typeof data !== 'string' || JSON.parse(data).t !== 'want') return super.send(data);
    RecordedChannel.prototype.send.call(this, data);
    const frame = JSON.parse(data); this.wants.push(frame.p ?? null);
    setTimeout(() => { if (this.readyState === 'open') this.receive(JSON.stringify({ t: 'none', id: frame.id })); }, 5);
  }
}

test('steady peer window (R6): a take-up that fails puts the holder\'s leases in cooldown; one cut by the window end does not', async t => {
  for (const kind of ['failed', 'window-end', 'window-end-fractional']) await t.test(kind, async t => {
    const clock = warmFunctionalClock(t, () => false), windowEnd = kind.startsWith('window-end');
    let f;
    try {
      // window-end: a holder whose first byte comes after the window, and which answers the cancel.
      f = await steadyWindowFixture(t, clock, { holders: [kind === 'failed' ? { Channel: EmptyAnswerChannel }
        : { Channel: PhasedFlowChannel, firstByteMs: 2000, flowMs: 100 }] });
      f.have();
      // A browser's clock is fractional: the Core's peer-only floor (the window
      // end rounded down) then settles the transfer before the window timer.
      if (kind === 'window-end-fractional') await clock.advance(0.5);
      const first = beginCountedMultiLoad(f, f.ctx), started = performance.now();
      if (kind === 'window-end-fractional') {
        await clock.advance(799.5);
        assert.equal(performance.now() - started, 799.5, 'stepped to the Core floor, before the window timer');
      }
      sameBytes(await clock.settle(first.response), f.bytes);
      assert.equal(f.wholeLoads.length, f.trained + 1, 'whole source fallback');
      assert.deepEqual([f.steady().peerOnlyStarted, f.steady().peerOnlyDelivered, f.steady().peerOnlyFallback, f.steady().takeUpWindowEnd,
        f.steady().waitWindowEnd], windowEnd ? [1, 0, 0, 1, 0] : [1, 0, 1, 0, 0], 'a take-up cut by the window end never waited on a lease');
      if (windowEnd) assert(f.wholeLoads.at(-1).config.loadPolicy.maxLoadTimeMs <= 10_000 - 799 + 10);
      // The holder withdraws its HAVE and announces a fresh lease.
      f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
      f.lease(2000);
      const next = await f.demand();
      if (kind === 'failed') {
        assert(next.sourceAfterMs <= 10, 'the failed holder\'s lease is ignored: ' + next.sourceAfterMs);
        assert.deepEqual([f.steady().leaseWaits, f.steady().leasesIgnored], [0, 1]);
      } else {
        assert(next.sourceAfterMs >= 800, 'a window-end miss carries no cooldown: ' + next.sourceAfterMs);
        assert.deepEqual([f.steady().leaseWaits, f.steady().leasesIgnored, f.steady().waitWindowEnd, f.steady().takeUpWindowEnd], [1, 0, 1, 1]);
      }
      sameBytes(await clock.settle(next.response), f.bytes);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
      assert(performance.now() - started < 10_000);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test('steady peer window (j): three real actors; a waiter beyond the owner\'s upload peers falls back to source', { timeout: 20000 }, async t => {
  // Real sessions, signatures, Core links and ordered channels between three
  // swarms. A holds the object and serves at most one upload peer; B takes it
  // peer-only; C, the third viewer, is refused by A and falls back.
  const pair = await framingPairFixture(t, { pairedState: true }), actors = [];
  const clock = warmFunctionalClock(t, () => false);
  try {
    const player = () => ({ levels: [{ details: { live: true } }], media: Object.assign(new EventTarget(), { currentTime: 0, paused: false,
      ended: false, seeking: false, readyState: 4, playbackRate: 1, buffered: { length: 0 } }) });
    const common = { steadyPeerWindow: true, sustainablePeerWait: true, maxPeers: 2 };
    for (const swarmOptions of [{ ...common, maxUploadPeers: 1 }, { ...common, maxUploadBytesPerSession: 0 }, common])
      actors.push(await clock.settle(pair.make({ delay: 1600, player: player(), swarmOptions })));
    const [a, b, c] = actors;
    await clock.advanceUntil(() => a.swarm.metrics().peers.connected === 2 && c.swarm.metrics().peers.connected >= 1);
    // Origin timing for each viewer from another object (1.6 s: zero sustainable budget for 2 s fragments).
    const train = actor => new Promise((resolve, reject) => {
      const frag = M3U8Parser.parseLevelPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\ntrain.ts\n',
        'https://origin.example/media/index.m3u8', 0, 'main', 0, null).fragments[0];
      const loader = new actor.hls.config.fLoader({}); frag.stats = loader.stats;
      loader.load({ url: frag.url, frag, part: null }, { timeout: 4000 }, { onSuccess: resolve, onError: reject, onTimeout: reject });
    });
    for (const actor of [b, c]) await clock.settle(train(actor));
    sameBytes(await clock.settle(a.load()), pair.bytes); // the owner fetches and retains the object
    await clock.advanceUntil(() => pair.channels.some(channel => channel.sent.some(frame => frame?.t === 'have' && (frame.keys ?? frame.add ?? []).includes(pair.key))));
    for (const actor of [b, c]) actor.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    const http = actors.map(actor => actor.http);
    sameBytes(await clock.settle(b.load()), pair.bytes);
    assert.equal(b.http, http[1], 'B took the held object peer-only');
    assert.deepEqual([b.swarm.metrics().steadyPeerWindow.peerOnlyDelivered, b.swarm.metrics().bytes.peerFirst], [1, pair.bytes.length]);
    sameBytes(await clock.settle(c.load()), pair.bytes);
    assert.equal(c.http, http[2] + 1, 'C fell back to one whole source GET');
    assert.deepEqual([c.swarm.metrics().steadyPeerWindow.peerOnlyStarted, c.swarm.metrics().steadyPeerWindow.peerOnlyFallback,
      c.swarm.metrics().bytes.peerFirst], [1, 1, 0]);
    assert.equal(a.swarm.metrics().uploadRefusalDiagnostics.counters['peer-limit'], 1, 'A refused the upload peer beyond its limit');
    assert.equal(a.http, http[0], 'the owner fetched once');
  } finally { clock.restore(); pair.close(); }
});

test('verified piece flow waits for real worker verification and rejects invalidated replies', async t => {
  for (const invalidation of ['none', 'closed-link', 'media-replaced', 'deadline']) await t.test(invalidation, async t => {
    const { WorkerImpl, workers } = transferWorkerFixture(t, { holdFinal: true });
    const record = VerifiedPieceFlow.prototype.record, credited = [];
    t.mock.method(VerifiedPieceFlow.prototype, 'record', function (input) {
      credited.push({ ...input }); return record.call(this, input);
    });
    const f = await multiFixture(t, { size: 65536,
      holders: [{ Channel: PhasedFlowChannel, firstByteMs: 2, flowMs: 80 }],
      originFallbackMs: 1000, originDelayMs: 1000, wholeOriginDelayMs: 5,
      swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } });
    let shift = 0;
    try {
      await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
      const actualNow = performance.now.bind(performance);
      t.mock.method(performance, 'now', () => actualNow() + shift);
      const pending = f.load();
      await until(() => workers[0].finalReply);
      assert.deepEqual(credited, [], 'received bytes cannot train before the real Core verifies them');
      shift = invalidation === 'deadline' ? 10000 : 350;
      if (invalidation === 'closed-link') f.channels[0].close();
      if (invalidation === 'media-replaced') f.hls.media = { currentTime: 0, buffered: { length: 0 } };
      workers[0].releaseFinal();
      sameBytes(await pending, f.bytes);
      if (invalidation === 'none') {
        assert.equal(credited.length, 1);
        assert.equal(credited[0].freshBytes, 65536);
        assert.ok(credited[0].endAt - credited[0].startAt >= 350,
          'the interval starts at payload arrival and includes worker latency');
      } else assert.deepEqual(credited, [], 'invalidated or late verification contributes no flow evidence');
    } finally { shift = 0; await f.close(); }
  });
});

test('verified piece flow rejects fresh valid bytes from a response that also bans its source', async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdBan: true });
  const selection = Object.getPrototypeOf((await loadCore(multiCore)).peerSelection()), observe = selection.observe;
  const batches = [];
  t.mock.method(selection, 'observe', function (input = {}) {
    if (!Number.isFinite(input.firstByteMs)) batches.push({ ...input });
    return observe.call(this, input);
  });
  class MixedCorruptChannel extends PhasedFlowChannel {
    send(data) {
      const frame = typeof data === 'string' ? JSON.parse(data) : null;
      if (!this.corruptNext || frame?.t !== 'want' || frame.p[1] - frame.p[0] < 2) return super.send(data);
      // One corrupt piece alongside valid pieces in the same real range.
      const at = frame.p[0] * commitmentPieceSize(this.bytes.length), saved = this.bytes[at];
      this.bytes[at] ^= 0xff;
      try { return super.send(data); } finally { this.bytes[at] = saved; }
    }
  }
  const f = await multiFixture(t, { size: 4 * 65536,
    holders: [{ Channel: MixedCorruptChannel, firstByteMs: 2, flowMs: 350 }],
    originFallbackMs: 2000, originDelayMs: 1000, wholeOriginDelayMs: 5,
    swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } });
  let shift = 0;
  try {
    await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
    sameBytes(await f.load(), f.bytes);
    assert.ok(f.swarm.metrics().peerRequestDiagnostics.records.some(row => row.elapsedMs - row.firstByteMs >= 300),
      'a real qualifying long piece establishes the multi-piece range model');
    const basePeer = f.swarm.metrics().core.multiHolder.peerBytes;
    batches.length = 0; f.channels[0].corruptNext = true; f.channels[0].firstByteMs = 20; f.channels[0].flowMs = 20;
    const actualNow = performance.now.bind(performance);
    t.mock.method(performance, 'now', () => actualNow() + shift);
    const pending = f.load();
    await until(() => workers[0].banReply);
    const before = f.swarm.metrics().core.multiHolder.peerBytes - basePeer;
    assert.ok(workers[0].banReply.result.verified > before, 'the real Core accepted fresh valid pieces alongside the corrupt piece');
    assert.deepEqual(batches, []);
    shift = 400; workers[0].releaseBan();
    sameBytes(await pending, f.bytes);
    assert.equal(f.swarm.metrics().core.multiHolder.bans, 1);
    assert.deepEqual(batches, [], 'a rejected source cannot publish a qualifying batch before its ban is applied');
  } finally { shift = 0; await f.close(); }
});

test('verified piece flow replaces the captured stale rate using one connection and real short ranges', async t => {
  const selection = Object.getPrototypeOf((await loadCore(multiCore)).peerSelection()), observe = selection.observe;
  const samples = [], seeded = new WeakSet();
  t.mock.method(selection, 'observe', function (input = {}) {
    if (!seeded.has(this)) {
      // Actual captured startup piece:393216 bytes over447.700ms of flow.
      observe.call(this, { firstByteMs: 2, bytes: 393216, flowMs: 447.70000076293945 }); seeded.add(this);
      assert.equal(Math.round(this.rate() * 1000), 878302);
    }
    samples.push({ ...input }); return observe.call(this, input);
  });
  const clock = virtualClock(t); let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024,
      holders: [{ Channel: PhasedFlowChannel, firstByteMs: 2, flowMs: 80 }], originFallbackMs: 3000,
      originDelayMs: 10000, wholeOriginDelayMs: 10000, traceRequests: 4096 }));
    sameBytes(await clock.settle(f.load(), 4000), f.bytes);
    const short = samples.filter(row => Number.isFinite(row.firstByteMs));
    assert(short.length > 4); assert(short.every(row => row.flowMs < 300));
    const batches = samples.filter(row => !Number.isFinite(row.firstByteMs));
    assert(batches.length > 0, 'verified short ranges spanning 300ms must replace the stale startup flow');
    assert(batches.every(row => row.bytes >= 32768 && row.flowMs >= 300));
    assert(batches.reduce((sum, row) => sum + row.bytes, 0) <= f.swarm.metrics().core.multiHolder.peerBytes,
      'each fresh verified byte can enter at most one batch');
    const flow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(flow.verifiedShortBatches, batches.length);
    assert.equal(flow.verifiedShortBytes, batches.reduce((sum, row) => sum + row.bytes, 0));
    assert.deepEqual(flow.lastVerifiedShortBatch, { bytes: batches.at(-1).bytes, spanMs: batches.at(-1).flowMs });
    assert.equal(flow.modelEvaluations.refresh, 1);
    assert.equal(flow.lastModel.decision, 'refresh');
    flow.lastVerifiedShortBatch.bytes = -1; flow.modelEvaluations.refresh = -1; flow.lastModel.pieceSize = -1;
    const freshFlow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(freshFlow.lastVerifiedShortBatch.bytes, batches.at(-1).bytes);
    assert.equal(freshFlow.modelEvaluations.refresh, 1);
    assert.equal(freshFlow.lastModel.pieceSize, f.pieceSize);
    sameBytes(await clock.settle(f.load(), 4000), f.bytes);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.lastModel.decision, 'fit');
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.modelEvaluations.fit, 1);
    const start = f.swarm.trace().rows.filter(row => row.k === 'xfer' && row.op === 'start').at(-1);
    assert(start.sharedRate > 2 * 878.3024331693287, 'shared prediction uses later measured flow');
    assert(start.peers[0][2] > 2 * 878.3024331693287, 'the same connection learns its measured flow too');
    const model = f.swarm.metrics().core.multiHolder.peerFlow.lastModel;
    assert.equal(model.rateBytesPerSecond, start.peers[0][2] * 1000, 'diagnostics copy the model actually sent to Core');
    assert.equal(model.firstByteMs, start.peers[0][1]);
    assert.equal(model.pieceSize, start.pieceSize);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("mixed planning keeps each holder's first byte and payload flow separate after cold startup", async t => {
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024, holders: [
      { Channel: PhasedFlowChannel, firstByteMs: 625, flowMs: 619 },
      { Channel: PhasedFlowChannel, firstByteMs: 1400, flowMs: 173 },
    ], originFallbackMs: 1800, wholeOriginDelayMs: 386, originDelayMs: 400, traceRequests: 4096,
    swarmOptions: { maxPeerWaitMs: 1800 } }));
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    sameBytes(await clock.settle(f.load()), f.bytes);
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    const training = f.swarm.metrics();
    assert.equal(training.peerRequestDiagnostics.counters.payload, 2);
    assert.ok(training.peers.deliveryMeasurements.every(row => row.throughputBytesPerSecond > 0));
    f.hls.media.buffered.end = () => 13.393;
    for (let repeat = 0; repeat < 3; repeat++) {
      const before = f.swarm.metrics(), count = f.channels[0].wants.length;
      sameBytes(await clock.settle(f.load(), 3000), f.bytes);
      const after = f.swarm.metrics();
      assert.ok(after.bytes.peerFirst > before.bytes.peerFirst, "a slow different holder cannot make the useful holder disappear");
      assert.ok(f.channels[0].wants.length > count, "fresh HAVE still produces an actual peer request after the first two payloads");
      const start = f.swarm.trace().rows.filter(row => row.k === "xfer" && row.op === "start").at(-1);
      assert.ok(start.peers.some(([, first, rate]) => first === 625 && rate > 150 && rate < 170),
        `the model uses post-first-byte flow, not completion throughput: ${JSON.stringify(start.peers)}`);
      assert.equal(start.origin[0], 0, "HTTP service timing never borrows a peer's first byte");
    }
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("short or stale holder evidence receives bounded demand-bound refresh and can recover", async t => {
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024,
      holders: [{ Channel: PhasedFlowChannel, firstByteMs: 625, flowMs: 619 }],
      originFallbackMs: 1800, wholeOriginDelayMs: 20, originDelayMs: 20, traceRequests: 4096,
      swarmOptions: { maxPeerWaitMs: 1800 } }));
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    const initial = f.swarm.metrics().peerRequestDiagnostics.records[0];
    assert.ok(initial.receivedBytes >= 32_768 && initial.elapsedMs - initial.firstByteMs >= 300,
      "a real qualifying slow flow must precede the short recovery");
    const requested = f.channels[0].wants.length;
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.8 } };
    for (let repeat = 0; repeat < 3; repeat++) sameBytes(await clock.settle(f.load()), f.bytes);
    assert.equal(f.channels[0].wants.length, requested, "short evidence cannot cause a blind probe on every segment");
    f.channels[0].firstByteMs = 100; f.channels[0].flowMs = 20;
    const before = f.swarm.metrics().bytes.peerFirst;
    await clock.advance(10_001);
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    assert.ok(f.channels[0].wants.length > requested, "a later real HAVE demand can refresh the conservative estimate");
    assert.ok(f.swarm.metrics().bytes.peerFirst > before);
    const refreshed = f.channels[0].wants.length;
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    assert.ok(f.channels[0].wants.length > refreshed, "verified short recovery remains useful despite the previous slow estimate");
    const start = f.swarm.trace().rows.filter(row => row.k === "xfer" && row.op === "start").at(-1);
    assert.equal(start.peers[0][2], null, "short flow does not manufacture a rate below the 300ms observation floor");
    assert.deepEqual(start.probePeers, [start.peers[0][0]], "unknown-rate continuation keeps the explicit one-piece initial bound");
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("large ranged HTTP deliveries refresh byte-scaled origin recovery and sustainable admission", async t => {
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024,
      holders: [{ Channel: PhasedFlowChannel, firstByteMs: 100, flowMs: 400 }],
      originFallbackMs: 1400, wholeOriginDelayMs: 386, originDelayMs: 1800, traceRequests: 4096,
      swarmOptions: { maxPeerWaitMs: 1400, sustainablePeerWait: true, zeroBudgetPeerRace: false } }));
    const ctx = { ...multiContext, frag: { ...multiContext.frag, duration: 2 } };
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    sameBytes(await clock.settle(f.load(ctx)), f.bytes);
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 30 };
    sameBytes(await clock.settle(f.load(ctx), 5000), f.bytes);
    assert.ok(f.swarm.metrics().segments.originLatencyMedianMs >= 1800,
      "a near-whole 1.8s origin range replaces the stale 386ms startup picture");
    const requests = f.channels[0].wants.length;
    sameBytes(await clock.settle(f.load(ctx), 2000), f.bytes);
    const row = f.swarm.metrics().peerEligibilityDiagnostics.records.at(-1);
    assert.equal(row.reason, "no-budget");
    assert.equal(row.budgetGeometry.sustainableMs, 0);
    assert.equal(f.channels[0].wants.length, requests, "the next segment starts ordinary HTTP without another serial peer wait");
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("an origin-winning abort invalidates unknown-flow continuation without charging a holder failure", async t => {
  const selection = Object.getPrototypeOf((await loadCore(multiCore)).peerSelection()), observe = selection.observe;
  const aggregateSamples = [], rates = [];
  t.mock.method(selection, 'observe', function (input = {}) {
    if (!Number.isFinite(input.firstByteMs)) aggregateSamples.push({ ...input });
    const result = observe.call(this, input); rates.push(this.rate()); return result;
  });
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 4 * 65536,
      holders: [{ Channel: PhasedFlowChannel, firstByteMs: 20, flowMs: 20 }],
      originFallbackMs: 1800, wholeOriginDelayMs: 100, originDelayMs: 400,
      swarmOptions: { maxPeerWaitMs: 1800, zeroBudgetPeerRace: true } }));
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    assert.ok(f.swarm.metrics().bytes.peerFirst > 0, "the short-flow link first proves useful with verified media");
    assert.deepEqual(aggregateSamples, [], 'the complete initial transfer stays below the aggregate time floor');
    assert.equal(rates.at(-1), null, 'the aborted continuation must begin with genuinely unknown flow');
    f.channels[0].firstByteMs = 1000;
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    const beforeAbort = f.channels[0].wants.length;
    sameBytes(await clock.settle(f.load(), 1000), f.bytes);
    assert.ok(f.channels[0].wants.length > beforeAbort, "the cancelled request must actually have reached the native channel");
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.records.at(-1).outcome, "abort");
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.lastModel.decision, 'useful-unknown');
    assert.equal(f.swarm.metrics().peers.deliveryMeasurements[0].consecutiveFailures, 0,
      "a faster HTTP winner is not a delivery failure charged to the holder");
    await clock.advance(2);
    f.channels[0].firstByteMs = 20;
    const cancelled = f.channels[0].wants.length;
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    sameBytes(await clock.settle(f.load(), 1500), f.bytes);
    assert.equal(f.channels[0].wants.length, cancelled,
      "unknown-rate usefulness cannot keep bypassing the refresh bound after a newer cancelled attempt");
    const flow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(flow.verifiedShortBatches, 0);
    assert.equal(flow.modelEvaluations['useful-unknown'], 1);
    assert.equal(flow.modelEvaluations['cooldown-blocked'], 1);
    assert.equal(flow.noModelTransfers, 1);
    assert.equal(flow.lastModel.decision, 'cooldown-blocked');
    assert.equal(flow.lastModel.rateBytesPerSecond, null);
    assert.ok(flow.lastModel.probeAgeMs >= 0 && flow.lastModel.probeAgeMs < 10000);
    assert.equal(flow.lastModel.usefulAgeMs, null, 'invalidated usefulness has no finite age');
    assert.deepEqual(flow.lastNoModel, { candidateCount: 1, model: flow.lastModel });
    assert.notStrictEqual(flow.lastNoModel.model, flow.lastModel);
    flow.lastNoModel.model.decision = 'fit'; flow.lastNoModel.candidateCount = 999;
    flow.lastModel.probeAgeMs = -1; flow.modelEvaluations['cooldown-blocked'] = -1;
    const freshFlow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(freshFlow.lastNoModel.model.decision, 'cooldown-blocked');
    assert.equal(freshFlow.lastNoModel.candidateCount, 1);
    assert.ok(freshFlow.lastModel.probeAgeMs >= 0);
    assert.equal(freshFlow.modelEvaluations['cooldown-blocked'], 1);
    await clock.advance(10_001);
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    assert.ok(f.channels[0].wants.length > cancelled, "a later real HAVE demand can still re-probe after the bound");
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.lastModel.decision, 'refresh');
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.modelEvaluations.refresh, 2);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("mixed admission retains repeated verified peer fractions despite a fresh late whole-object estimate", async t => {
  const clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ Channel: PhasedFlowChannel, firstByteMs: 400, flowMs: 350 }], size: 12 * 65_536,
      originFallbackMs: 800, originDelayMs: 50, wholeOriginDelayMs: 50, traceRequests: 4096,
      onPeerDelivery: value => observed.push(value), swarmOptions: { maxPeerWaitMs: 800, sustainablePeerWait: true } }));
    const context = { ...multiContext, frag: { ...multiContext.frag, duration: 2 } };
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    sameBytes(await clock.settle(f.load(context)), f.bytes);
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    sameBytes(await clock.settle(f.load(context)), f.bytes, "a slow one-piece contribution and origin tail must both really verify");
    await clock.advance(2);
    const training = f.swarm.metrics().peerRequestDiagnostics.records[0];
    assert.ok(training.receivedBytes >= 32_768 && training.elapsedMs - training.firstByteMs >= 300,
      `actual slow partial flow, rather than a mocked estimate, trained selection: ${JSON.stringify(training)}`);
    assert.equal(training.outcome, "payload");
    assert.ok(training.elapsedMs < 800, "the actual verified piece fits the unchanged deadline");
    assert.ok(training.firstByteMs + f.bytes.length / (training.receivedBytes / (training.elapsedMs - training.firstByteMs)) > 800,
      "the same measured flow cannot deliver the whole object within that deadline");
    f.channels[0].firstByteMs = 50; f.channels[0].flowMs = 20;
    const transferCount = f.swarm.metrics().core.multiHolder.transfers;
    for (let repeat = 0; repeat < 3; repeat++) {
      // Let any reliable-channel EOF from a losing speculative range drain
      // before the next VOD demand. An actually busy link is not eligible.
      await clock.advance(60);
      const before = f.swarm.metrics(), start = clock.now();
      sameBytes(await clock.settle(f.load(context)), f.bytes);
      const after = f.swarm.metrics();
      assert.ok(after.bytes.peerFirst > before.bytes.peerFirst, `a valid small peer fraction is not rejected because the whole object would be late: ${JSON.stringify({ repeat,
        before: before.bytes.peerFirst, after: after.bytes.peerFirst, multi: after.core.multiHolder, rows: after.peerEligibilityDiagnostics.records.slice(-2), requests: after.peerRequestDiagnostics.records.slice(-3) })}`);
      assert.equal(after.segments.peerProjectedLate, before.segments.peerProjectedLate);
      assert.ok(clock.now() - start < 2_000, "mixed delivery remains within the segment's sustainable time");
    }
    const metrics = f.swarm.metrics();
    assert.equal(metrics.core.multiHolder.transfers, transferCount + 3);
    assert.equal(metrics.segments.originFallbacks, 1, "there is no second whole origin request alongside the mixed ranges");
    assert.ok(metrics.core.multiHolder.peerBytes > 0 && metrics.core.multiHolder.originBytes > 0);
    assert.equal(observed.reduce((sum, value) => sum + value.bytes, 0), metrics.bytes.peerFirst);
    assert.ok(observed.every(value => value.connection === f.connections[0]));
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("recorded VOD coordination requires a live same-key FETCH lease and preserves its deadline", async t => {
  for (const variant of ["no-lease", "other-key", "expired", "live", "live-unavailable"]) await t.test(variant, async t => {
    const playback = peerPlaybackOptions(120), requested = [];
    const f = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(), coreWasm: multiCore });
    let clock;
    try {
      await until(() => f.swarm.metrics().core.state === "ready");
      f.hls.levels = [{ details: { live: false } }];
      const channel = await f.addPeer(new ServingChannel(playback.bytes, 1, requested, "fetching-holder"));
      channel.receive(JSON.stringify({ t: "contribution", serving: true, rendition: "main:0" }));
      synchronousFixtureSegmentKey(t);
      clock = virtualClock(t);
      if (variant !== "no-lease") channel.receive(JSON.stringify({ t: "fetching", k: variant === "other-key" ? "f".repeat(64) : playback.key, ms: variant === "expired" ? 10 : 2000 }));
      if (variant === "expired") await clock.advance(11);
      const began = clock.now(), pending = new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context,
        frag: { ...context.frag, type: "main" } }, {}, { onSuccess: resolve }));
      if (variant === "live") setTimeout(() => channel.receive(JSON.stringify({ t: "have", keys: [playback.key] })), 20);
      await clock.settle(pending, 200);
      const metrics = f.swarm.metrics();
      if (variant.startsWith("live")) {
        assert.equal(metrics.segments.coordinatedWaits, 1);
        assert.ok(clock.now() - began <= 125, "even a lying lease cannot extend the loader deadline");
        assert.equal(metrics.segments.coordinatedPeerLoads, variant === "live" ? 1 : 0);
      } else {
        assert.equal(metrics.segments.coordinatedWaits, 0, "generic contribution, other keys and expired leases are not pending supply");
        assert.equal(metrics.segments.commitmentRequests, 0);
        assert.ok(clock.now() - began < 10, "a prefetch leader does not spend its peer wait on an idle follower");
      }
    } finally { clock?.restore(); await f.close(); }
  });
});

test("live and unknown playlists retain bounded receive-only and ranked coordination", async t => {
  const variants = [
    { name: "live", levels: [{ details: { live: true } }], arrives: true },
    { name: "unknown", arrives: true },
    { name: "exact-live-demand", levels: [{ details: { live: true } }, { details: { live: false } }], currentLevel: 1, arrives: true },
    { name: "exact-vod-demand", levels: [{ details: { live: false } }, { details: { live: true } }], currentLevel: 1, vod: true },
    { name: "alternate-audio", type: "audio", levels: [{ details: { live: false } }] },
    { name: "invalid-negative-level", level: -1, levels: Object.assign([], { "-1": { details: { live: false } } }) },
    { name: "invalid-outside-level", level: 3, levels: [{ details: { live: false } }] },
    { name: "live-ranked-contributor", levels: [{ details: { live: true } }], serve: true },
    { name: "unknown-ranked-contributor", serve: true },
  ];
  for (const variant of variants) await t.test(variant.name, async t => {
    const playback = peerPlaybackOptions(120), requested = [];
    const f = await linkedFixture({ ...playback.options, serve: variant.serve ?? false, WebSocketImpl: memoryRelaySocket(), coreWasm: multiCore });
    let clock;
    try {
      await until(() => f.swarm.metrics().core.state === "ready");
      f.hls.levels = variant.levels; f.hls.currentLevel = variant.currentLevel ?? 0;
      const channel = await f.addPeer(new ServingChannel(playback.bytes, 1, requested, "live-holder"));
      const frag = { ...context.frag, type: variant.type ?? "main", level: variant.level ?? 0 };
      channel.receive(JSON.stringify({ t: "contribution", serving: true, rendition: `${frag.type}:${frag.level}` }));
      let loadContext = { ...context, frag };
      if (variant.serve) {
        const rank = (pubkey, key) => [...pubkey].map((digit, i) => (parseInt(digit, 16) ^ parseInt(key[i], 16)).toString(16)).join("");
        const own = f.swarm.metrics().pubkey, remote = f.peers[0].pubkey;
        for (let n = 0; ; n++) {
          const path = `/live-ranked-${n}.ts`, key = createHash("sha256").update(`${base.swarmId}\n${path}`).digest("hex");
          if (rank(remote, key) < rank(own, key)) { loadContext = { ...loadContext, url: `https://origin.example${path}` }; break; }
          assert.ok(n < 1024, "a bounded deterministic key establishes the contributor rank");
        }
      }
      synchronousFixtureSegmentKey(t);
      clock = virtualClock(t);
      const began = clock.now(), pending = new Promise(resolve => new f.hls.config.fLoader({}).load(loadContext, {}, { onSuccess: resolve }));
      if (variant.arrives) setTimeout(() => channel.receive(JSON.stringify({ t: "have", keys: [playback.key] })), 20);
      await clock.settle(pending, 200);
      const metrics = f.swarm.metrics();
      assert.equal(metrics.segments.coordinatedWaits, variant.vod ? 0 : 1,
        "only an explicit VOD main-demand rendition suppresses legacy coordination");
      assert.equal(metrics.segments.coordinatedPeerLoads, variant.arrives ? 1 : 0);
      assert.ok(clock.now() - began <= 125, "live, unknown and invalid-context waits keep the original deadline");
      if (variant.vod) assert.ok(clock.now() - began < 10, "currentLevel cannot override the exact VOD demand");
      else assert.equal(metrics.segments.commitmentRequests, 1);
    } finally { clock?.restore(); await f.close(); }
  });
});

test("mixed admission retains whole-object projection for valid v1 and v2 commitments", async t => {
  for (const commitmentVersion of [1, 2]) await t.test(`v${commitmentVersion}`, async t => {
    const clock = virtualClock(t);
    let f;
    try {
      f = await clock.settle(multiFixture(t, { commitmentVersion, holders: [{ delayMs: 50 }], wholeOriginDelayMs: 50 }));
      sameBytes(await clock.settle(f.load()), f.bytes, "the legacy commitment and payload must actually verify first");
      const wants = f.channels[0].wants.length, before = f.swarm.metrics();
      f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.02 } };
      sameBytes(await clock.settle(f.load()), f.bytes);
      const after = f.swarm.metrics();
      assert.equal(after.segments.commitmentRejected, 0, "a valid older schema is declined for timing, not mistaken for corruption");
      assert.equal(after.bytes.peerFirst, before.bytes.peerFirst);
      assert.equal(f.channels[0].wants.length, wants, "no whole peer request fits the twenty-millisecond buffer budget");
      assert.equal(after.segments.peerProjectedLate, before.segments.peerProjectedLate + 1);
      assert.equal(after.peerEligibilityDiagnostics.records.at(-1).projection.stage, "commitment", "the signed legacy schema retains its whole-object gate");
      assert.equal(after.core.multiHolder.transfers, 0);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("sustainable peer waits start one cold long HTTP load without borrowing for a delayed Worker", async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdFinal: true }), clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ delayMs: 1 }], size: 8_604_060,
      originFallbackMs: 1_200, originDelayMs: 2_500, wholeOriginDelayMs: 3_000, traceRequests: 256,
      onPeerDelivery: row => observed.push(row), swarmOptions: { sustainablePeerWait: true,
        transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl, maxPeerWaitMs: 2_500 } }));
    await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.state === "ready", 500);
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 30 } };
    const context = { ...multiContext, frag: { ...multiContext.frag, duration: 2.64 } }, started = clock.now();
    assert.equal(f.swarm.metrics().segments.originLatencyMedianMs, null);
    const pending = f.load(context);
    assert.equal(f.wholeLoads.length, 1, "unknown HTTP recovery must start the original whole load synchronously");
    sameBytes(await clock.settle(pending, 3_100), f.bytes);
    assert.ok(clock.now() - started >= 3_000 && clock.now() - started <= 3_001,
      "the first load pays only its real HTTP time plus at most one virtual-clock promise-settlement step");
    const metrics = f.swarm.metrics(), row = f.swarm.trace().rows.find(row => row.k === "eligibility");
    assert.equal(row.budgetMs, 0); assert.equal(row.budgetGeometry.durationMs, 2_640);
    assert.equal(row.budgetGeometry.originRecoveryMs, null); assert.equal(row.budgetGeometry.sustainableMs, 0);
    assert.equal(metrics.segments.originLatencyMedianMs, 3_000, "the ordinary completion calibrates subsequent recovery");
    assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
    assert.equal(metrics.core.multiHolder.transfers, 0, "an uncalibrated load cannot create a mixed Worker transfer");
    assert.equal(metrics.core.transferWorker.transfers, 0); assert.equal(metrics.core.transferWorker.pending, 0);
    assert.equal(workers[0].finalReply, undefined, "there is no late mixed frame to discard and refetch");
    assert.deepEqual(f.channels[0].wants, []); assert.deepEqual(observed, []); assert.equal(metrics.bytes.peerFirst, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("sustainable peer waits bound multi-holder extensions by measured recovery and segment duration", async t => {
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ silent: true }], size: 12 * 65_536,
      originFallbackMs: 1_200, originDelayMs: 1_300, wholeOriginDelayMs: 1_300, traceRequests: 256,
      swarmOptions: { sustainablePeerWait: true, maxPeerWaitMs: 2_500 } }));
    const context = { ...multiContext, frag: { ...multiContext.frag, duration: 2 } };
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 30 } };
    sameBytes(await clock.settle(f.load(context)), f.bytes);
    assert.equal(f.channels[0].wants.length, 0, "a cold segment cannot borrow an unmeasured HTTP recovery interval");
    const cold = f.swarm.trace().rows.find(row => row.k === "eligibility");
    assert.equal(cold.budgetGeometry.sustainableMs, 0);
    assert.equal(cold.budgetGeometry.originRecoveryMs, null);

    const started = clock.now();
    sameBytes(await clock.settle(f.load(context)), f.bytes);
    const elapsed = clock.now() - started;
    const trace = f.swarm.trace().rows, load = trace.filter(row => row.k === "load").at(-1);
    const geometry = load.budgetGeometry;
    assert.equal(geometry.durationMs, 2_000);
    assert.equal(geometry.originRecoveryMs, 1_725, "1.3s observed HTTP plus the existing quarter and 100ms margin");
    assert.equal(geometry.sustainableMs, 275);
    assert.equal(geometry.uncappedMs, 18_000, "the independent buffer reserve stays intact");
    assert.equal(load.budgetMs, 275);
    const transfer = trace.find(row => row.k === "xfer" && row.op === "start" && row.load === load.load);
    assert.ok(transfer, "the real WASM multi-holder path was entered");
    assert.equal(transfer.deadline - load.at, 275, "multi-holder cannot extend the wait to its usual 2.5s ceiling");
    assert.ok(f.channels[0].wants.length > 0, "positive admission still tries the known holder");
    assert.ok(elapsed < 2_000, `the failed peer plus actual origin recovery fits this segment (${elapsed}ms)`);
    assert.equal(f.swarm.metrics().segments.originFallbacks, 1, "origin ranges preserve the transfer instead of reloading the whole object");
    assert.equal(f.swarm.metrics().core.multiHolder.delivered, 1);
    assert.equal(f.swarm.metrics().config.sustainablePeerWait, true);
  } finally {
    if (f) await clock.settle(f.close());
    clock.restore();
  }
});

test("sustainable peer waits preserve independent cached and late-HAVE races before origin calibration", async t => {
  for (const late of [false, true]) await t.test(late ? "late HAVE" : "cached HAVE", async t => {
    const clock = virtualClock(t);
    let f;
    try {
      f = await clock.settle(multiFixture(t, { holders: [{ delayMs: 80 }], size: 12 * 65_536,
        wholeOriginDelayMs: 2_000, traceRequests: 256,
        swarmOptions: { sustainablePeerWait: true, zeroBudgetPeerRace: true, lateHaveRace: late, maxPeerWaitMs: 500 } }));
      f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 30 } };
      const context = { ...multiContext, frag: { ...multiContext.frag, duration: 2.64 } };
      if (late) f.channels[0].receive(JSON.stringify({ t: "have", keys: [] }));
      const pending = f.load(context);
      assert.equal(f.wholeLoads.length, 1, "unknown recovery starts ordinary HTTP synchronously despite a full buffer");
      if (late) {
        await clock.advance(30); assert.deepEqual(f.channels[0].wants, [], "no object is requested before actual HAVE");
        const key = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");
        f.channels[0].receive(JSON.stringify({ t: "have", keys: [key] }));
      }
      sameBytes(await clock.settle(pending), f.bytes);
      const load = f.swarm.trace().rows.find(row => row.k === "load"), metrics = f.swarm.metrics();
      assert.equal(load.budgetMs, 0); assert.equal(load.budgetGeometry.sustainableMs, 0);
      assert.equal(load.budgetGeometry.originRecoveryMs, null);
      assert.equal(load.limitMs, 500, "parallel peer work retains its own window while HTTP runs");
      assert.equal(metrics.segments.zeroBudgetPeerRaceWins, 1); assert.equal(metrics.bytes.peerFirst, f.bytes.length);
      assert.equal(metrics.peerEligibilityDiagnostics.counters[late ? "have-after-wait" : "have-at-entry"], 1);
      assert.equal(f.wholeLoads[0].loader.aborted, true); assert.equal(f.wholeLoads.length, 1);
      assert.deepEqual(f.ranges, [], "parallel races add no second origin download");
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("sustainable peer waits use part duration, reject unknown duration and preserve the default policy", async t => {
  for (const variant of ["part", "part-unknown", "unknown", "invalid", "overflow", "default"]) await t.test(variant, async () => {
    const playback = peerPlaybackOptions(1_200);
    const fixture = await linkedFixture({ ...playback.options, WebSocketImpl: memoryRelaySocket(),
      ...(variant === "default" ? {} : { sustainablePeerWait: true }), swarmParts: true, traceRequests: 32,
      getCommitment: () => assert.fail("no holder has been advertised") });
    try {
      fixture.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 30 } };
      const ctx = { ...context, frag: { ...context.frag, duration: variant === "invalid" ? NaN : 10 } };
      if (variant === "part") ctx.part = { index: 0, start: 12, duration: 0.5 };
      if (variant === "part-unknown") ctx.part = { index: 0, start: 12 };
      if (variant === "unknown") delete ctx.frag.duration;
      if (variant === "overflow") ctx.frag.duration = Number.MAX_VALUE;
      if (variant === "default") Object.defineProperty(ctx.frag, "duration", { get() { assert.fail("the default budget does not read duration"); } });
      await new Promise(resolve => new fixture.hls.config.fLoader({}).load(ctx, {}, { onSuccess: resolve }));
      const row = fixture.swarm.metrics().peerEligibilityDiagnostics.records.at(-1);
      assert.equal(row.budgetMs, variant === "default" ? 1_200 : 0);
      if (variant === "part") assert.equal(row.budgetGeometry.durationMs, 500, "a short part cannot borrow its parent duration");
      if (["part-unknown", "unknown", "invalid", "overflow"].includes(variant)) assert.equal(row.budgetGeometry.durationMs, null);
      if (variant === "default") {
        assert.equal(fixture.swarm.metrics().config.sustainablePeerWait, false);
        assert.equal("sustainableMs" in row.budgetGeometry, false);
      }
    } finally { await fixture.close(); }
  });
});

test("sustainable peer waits require an explicit boolean option", () => {
  for (const sustainablePeerWait of [1, "true", null]) {
    const swarm = createHlsSwarm({ ...base, relays: ["wss://relay.example"], sustainablePeerWait });
    assert.equal(swarm.metrics().mode, "off");
    assert.equal(swarm.metrics().disabledReason, "invalid-sustainable-wait-option");
    swarm.stop();
  }
});

const lateRaceKey = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");

// Only the small fixture key has a deterministic completion time. Signed
// commitments, actual object hashes and every Rust range stay real.
function lateRaceKeyClock(t, delayMs = 0) {
  const subtle = globalThis.crypto.subtle, digest = subtle.digest.bind(subtle);
  const known = Buffer.from(`${base.swarmId}\n/media/seg.ts`);
  t.mock.method(subtle, "digest", (algorithm, input) => {
    if (algorithm !== "SHA-256" || !(input instanceof Uint8Array) || !Buffer.from(input).equals(known)) return digest(algorithm, input);
    const bytes = createHash("sha256").update(input).digest();
    const result = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return delayMs ? new Promise(resolve => setTimeout(() => resolve(result), delayMs)) : Promise.resolve(result);
  });
}

async function lateRaceFixture(t, clock, { swarmOptions = {}, ...options } = {}) {
  const f = await clock.settle(multiFixture(t, { holders: [{}], wholeOriginDelayMs: 150, ...options,
    swarmOptions: { zeroBudgetPeerRace: true, lateHaveRace: true, maxPeerWaitMs: 100, ...swarmOptions } }));
  f.hls.media = { currentTime: 0, buffered: { length: 0 } };
  for (const channel of f.channels) channel.receive(JSON.stringify({ t: "have", keys: [] }));
  return f;
}

test("late-HAVE race requires an explicit boolean and remains disabled by default", () => {
  for (const lateHaveRace of [1, "true", null]) {
    const swarm = createHlsSwarm({ ...base, relays: ["wss://relay.example"], lateHaveRace });
    assert.equal(swarm.metrics().mode, "off");
    assert.equal(swarm.metrics().disabledReason, "invalid-late-have-race-option");
    swarm.stop();
  }
});

test("late-HAVE race leaves the default entry-snapshot contract unchanged", async t => {
  lateRaceKeyClock(t);
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{}], wholeOriginDelayMs: 100,
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 200 } }));
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    f.channels[0].receive(JSON.stringify({ t: "have", keys: [] }));
    const pending = beginCountedMultiLoad(f);
    assert.equal(f.wholeLoads.length, 1);
    setTimeout(() => f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] })), 20);
    sameBytes(await clock.settle(pending.response), f.bytes);
    assert.equal(f.swarm.metrics().config.lateHaveRace, false);
    assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.wholeLoads[0].loader.aborted, false);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("late-HAVE race starts HTTP first and accepts one exact verified Worker object from the entry connection", async t => {
  lateRaceKeyClock(t);
  const { WorkerImpl, workers } = transferWorkerFixture(t), clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await lateRaceFixture(t, clock, { size: 6 * 1024 * 1024, holders: [{ delayMs: 1 }], wholeOriginDelayMs: 600,
      onPeerDelivery: row => observed.push(row),
      swarmOptions: { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl, maxPeerWaitMs: 500 } });
    await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.state === "ready", 500);
    const before = f.swarm.metrics().peers, pending = beginCountedMultiLoad(f);
    assert.equal(f.wholeLoads.length, 1); assert.equal(f.commitmentCalls, 0);
    f.channels[0].receive(JSON.stringify({ t: "fetching", k: lateRaceKey, ms: 2_000 }));
    await clock.advance(30);
    assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, [], "FETCH is not a cached HAVE");
    f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
    sameBytes(await clock.settle(pending.response, 600), f.bytes);
    const metrics = f.swarm.metrics();
    assert.equal(metrics.config.lateHaveRace, true);
    assert.equal(metrics.segments.zeroBudgetPeerRaces, 1); assert.equal(metrics.segments.zeroBudgetPeerRaceWins, 1);
    assert.equal(metrics.segments.coordinatedWaits, 0, "the origin never waited for this HAVE");
    assert.equal(metrics.peerEligibilityDiagnostics.counters["have-after-wait"], 1);
    assert.equal(metrics.bytes.peerFirst, f.bytes.length);
    assert.equal(observed.reduce((sum, row) => sum + row.bytes, 0), f.bytes.length);
    assert.ok(observed.every(row => row.connection === f.connections[0]));
    assert.equal(f.commitmentCalls, 1);
    assert.ok(f.channels[0].wants.length >= 17 && f.channels[0].wants.every(range => Array.isArray(range) && range[1] - range[0] <= 4));
    assert.equal(metrics.core.multiHolder.originRanges, 0); assert.deepEqual(f.ranges, []);
    assert.equal(metrics.peers.dialsStarted, before.dialsStarted, "no neighbour search or new dial supplies the race");
    assert.equal(f.wholeLoads[0].loader.aborted, true); assert.equal(f.wholeLoads.length, 1);
    await clock.advance(650);
    assert.deepEqual([pending.calls.success.length, pending.calls.abort.length, pending.calls.error.length], [1, 0, 0]);
    assert.equal(f.swarm.metrics().core.transferWorker.transfers, 0);
    assert.equal(f.swarm.metrics().core.transferWorker.pending, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  assert.equal(workers[0].terminated, true);
});

test("late-HAVE race rejects wrong, FETCH-only and already-withdrawn availability", async t => {
  for (const variant of ["wrong-key", "fetch-only", "withdrawn"]) await t.test(variant, async t => {
    lateRaceKeyClock(t);
    const clock = virtualClock(t);
    let f;
    try {
      f = await lateRaceFixture(t, clock);
      const pending = beginCountedMultiLoad(f);
      await clock.advance(20);
      if (variant === "fetch-only") f.channels[0].receive(JSON.stringify({ t: "fetching", k: lateRaceKey, ms: 2_000 }));
      else {
        f.channels[0].receive(JSON.stringify({ t: "have", keys: [variant === "wrong-key" ? "b".repeat(64) : lateRaceKey] }));
        if (variant === "withdrawn") f.channels[0].receive(JSON.stringify({ t: "have", keys: [] }));
      }
      sameBytes(await clock.settle(pending.response), f.bytes);
      assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, []);
      assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaces, 0);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
      assert.equal(f.wholeLoads[0].loader.aborted, false); assert.deepEqual(f.ranges, []);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("late-HAVE race excludes new and replaced connections even when they advertise the exact key before the deadline", async t => {
  for (const replacement of [false, true]) await t.test(replacement ? "same author, new native connection" : "new author", async t => {
    lateRaceKeyClock(t);
    const clock = virtualClock(t);
    let f;
    try {
      f = await lateRaceFixture(t, clock, { wholeOriginDelayMs: 800, swarmOptions: { maxPeerWaitMs: 600 } });
      const pending = beginCountedMultiLoad(f), started = clock.now(), channel = new RangedChannel(f.bytes);
      await clock.advance(10);
      if (replacement) {
        f.channels[0].close();
        const accepted = f.swarm.metrics().peers.offersAccepted;
        f.peers[0].sendSignal(f.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "late-replacement",
          payload: { sdp: "fixture-offer" } });
        await clock.advanceUntil(() => f.connections.length === 2 && f.swarm.metrics().peers.offersAccepted > accepted, 300);
        const event = new Event("datachannel"); event.channel = channel; f.connections[1].dispatchEvent(event);
        await clock.advanceUntil(() => f.swarm.metrics().peers.connected === 1, 100);
      } else {
        await clock.settle(f.addPeer(channel), 300);
        f.peers.at(-1).announcePresence({ role: "viewer", open: true,
          transports: [{ type: "webrtc", publicKey: f.peers.at(-1).pubkey, obj: 2 }] });
        await clock.advanceUntil(() => f.swarm.metrics().peers.openPeersKnown === 2, 100);
      }
      assert.ok(clock.now() - started < 600, "the excluded connection arrived inside the original opportunity");
      channel.receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
      sameBytes(await clock.settle(pending.response, 1_000), f.bytes);
      assert.deepEqual(channel.wants, []); assert.equal(f.commitmentCalls, 0);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.equal(f.wholeLoads[0].loader.aborted, false);
      assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("late-HAVE race freezes one holder snapshot and never retries after corruption", async t => {
  lateRaceKeyClock(t);
  const clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await lateRaceFixture(t, clock, { holders: [{ corrupt: true }, {}], onPeerDelivery: row => observed.push(row),
      beforeCommitment: () => f.channels[1].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] })) });
    const pending = beginCountedMultiLoad(f);
    await clock.advance(20); f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
    sameBytes(await clock.settle(pending.response), f.bytes);
    assert.equal(f.commitmentCalls, 1);
    assert.ok(f.channels[0].wants.length > 0); assert.deepEqual(f.channels[1].wants, []);
    assert.equal(f.swarm.metrics().core.multiHolder.bans, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.deepEqual(observed, []);
    assert.equal(f.wholeLoads[0].loader.aborted, false);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("late-HAVE race includes key hashing, waiting, metadata and transfer in one absolute window", async t => {
  lateRaceKeyClock(t, 40);
  const clock = virtualClock(t), observed = [];
  class ReliableDelayedRange extends RangedChannel {
    ordered = true;
    maxRetransmits = null;
    maxPacketLifeTime = null;
  }
  let f;
  try {
    f = await lateRaceFixture(t, clock, { holders: [{ Channel: ReliableDelayedRange, delayMs: 30 }], traceRequests: 256,
      beforeCommitment: () => sleep(20), onPeerDelivery: row => observed.push(row) });
    const pending = beginCountedMultiLoad(f), started = clock.now();
    await clock.advance(70); f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
    sameBytes(await clock.settle(pending.response), f.bytes);
    assert.equal(f.commitmentCalls, 1); assert.ok(f.channels[0].wants.length > 0, "the bounded arm actually began near its deadline");
    const load = f.swarm.trace().rows.find(row => row.k === "load"), start = f.swarm.trace().rows.find(row => row.k === "xfer" && row.op === "start");
    assert.equal(load.limitMs, 100); assert.equal(start.deadline - load.at, 100);
    assert.ok(clock.now() - started >= 150, "only the original normal HTTP response reaches the player");
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.equal(f.swarm.metrics().core.multiHolder.delivered, 0);
    assert.deepEqual(observed, []); assert.equal(f.wholeLoads[0].loader.aborted, false);
    assert.ok(f.channels[0].cancels > 0); assert.deepEqual(f.ranges, []);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("late-HAVE race cannot begin after the original deadline even with delayed key hashing", async t => {
  lateRaceKeyClock(t, 110);
  const clock = virtualClock(t);
  let f;
  try {
    f = await lateRaceFixture(t, clock);
    const pending = beginCountedMultiLoad(f);
    await clock.advance(20); f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
    sameBytes(await clock.settle(pending.response), f.bytes);
    assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.equal(f.wholeLoads[0].loader.aborted, false);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test("late-HAVE race preserves an HTTP winner at every asynchronous boundary", async t => {
  for (const phase of ["key", "HAVE", "metadata", "transfer", "worker-result"]) await t.test(phase, async t => {
    lateRaceKeyClock(t, phase === "key" ? 110 : 0);
    const clock = virtualClock(t), observed = [];
    const worker = phase === "worker-result" ? transferWorkerFixture(t, { holdFinal: true }) : null;
    let f, metadataSignal;
    try {
      f = await lateRaceFixture(t, clock, { holders: [{ delayMs: phase === "transfer" ? 100 : 0 }], wholeOriginDelayMs: 80,
        beforeCommitment: phase === "metadata" ? (_context, { signal }) => { metadataSignal = signal; return sleep(100); } : null,
        onPeerDelivery: row => observed.push(row), swarmOptions: { maxPeerWaitMs: 200,
          ...(worker ? { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl: worker.WorkerImpl } : {}) } });
      if (worker) await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.state === "ready", 500);
      const pending = beginCountedMultiLoad(f);
      assert.equal(f.wholeLoads.length, 1);
      setTimeout(() => f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] })), phase === "HAVE" ? 110 : 20);
      if (worker) await clock.advanceUntil(() => Boolean(worker.workers[0].finalReply), 75);
      sameBytes(await clock.settle(pending.response), f.bytes);
      const before = f.swarm.metrics().core.multiHolder.peerBytes;
      if (worker) worker.workers[0].releaseFinal();
      await clock.advance(150);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.deepEqual(observed, []);
      assert.equal(f.swarm.metrics().core.multiHolder.peerBytes, before, "late replies cannot add piece credit");
      assert.equal(f.swarm.metrics().core.multiHolder.delivered, 0);
      assert.deepEqual([pending.calls.success.length, pending.calls.abort.length, pending.calls.error.length], [1, 0, 0]);
      assert.equal(f.wholeLoads[0].loader.aborted, false); assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
      if (metadataSignal) assert.equal(metadataSignal.aborted, true);
      if (phase === "key" || phase === "HAVE") { assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, []); }
      if (worker) assert.equal(f.swarm.metrics().core.transferWorker.transfers, 0);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("late-HAVE race cancels its waiting arm on progressive HTTP exposure", async t => {
  for (const progressive of [false, true]) await t.test(progressive ? "declared progressive loader" : "unexpected exposed chunk", async t => {
    lateRaceKeyClock(t);
    const clock = virtualClock(t);
    let f;
    try {
      f = await lateRaceFixture(t, clock);
      f.hlsConfig.progressive = progressive;
      const pending = beginCountedMultiLoad(f);
      if (!progressive) f.wholeLoads[0].callbacks.onProgress({}, multiContext, new Uint8Array([1]).buffer, null);
      await clock.advance(20); f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
      sameBytes(await clock.settle(pending.response), f.bytes);
      assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, []);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.equal(f.wholeLoads[0].loader.aborted, false);
      assert.equal(pending.calls.progress.length, progressive ? 0 : 1);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("late-HAVE race cancels waiting on stop, loader abort and destroy with the original HTTP ownership", async t => {
  for (const ending of ["stop", "abort", "destroy"]) await t.test(ending, async t => {
    lateRaceKeyClock(t);
    const clock = virtualClock(t);
    let f;
    try {
      f = await lateRaceFixture(t, clock);
      const pending = beginCountedMultiLoad(f);
      await clock.advance(10);
      if (ending === "stop") f.swarm.stop(); else pending.loader[ending]();
      f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
      if (ending === "stop") sameBytes(await clock.settle(pending.response), f.bytes); else await clock.advance(160);
      assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, []);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
      assert.equal(f.wholeLoads[0].loader.aborted, ending !== "stop");
      assert.equal(pending.calls.success.length, ending === "stop" ? 1 : 0);
      assert.equal(pending.calls.abort.length, ending === "abort" ? 1 : 0);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("late-HAVE race leaves HTTP immediate for an unavailable Worker or an older mixed-only module", async t => {
  for (const oldModule of [false, true]) await t.test(oldModule ? "capability absent" : "Worker warming", async t => {
    lateRaceKeyClock(t);
    if (oldModule) {
      const instantiate = WebAssembly.instantiate;
      t.mock.method(WebAssembly, "instantiate", async (...args) => {
        const instance = await instantiate(...args);
        return args[0] === multiCore ? { exports: { ...instance.exports, rs_xfer_capabilities: () => (instance.exports.rs_xfer_capabilities?.() ?? 0) & ~2 } } : instance;
      });
    }
    const worker = oldModule ? null : transferWorkerFixture(t, { pauseInit: true }), clock = virtualClock(t);
    let f;
    try {
      f = await lateRaceFixture(t, clock, { wholeOriginDelayMs: 150,
        swarmOptions: worker ? { transferWorkerUrl: "https://worker.example/transfer.js", WorkerImpl: worker.WorkerImpl } : {} });
      const pending = beginCountedMultiLoad(f);
      assert.equal(f.wholeLoads.length, 1);
      await clock.advance(20); f.channels[0].receive(JSON.stringify({ t: "have", keys: [lateRaceKey] }));
      sameBytes(await clock.settle(pending.response), f.bytes);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.deepEqual(f.channels[0].wants, []);
      assert.equal(f.swarm.metrics().core.state, "ready"); assert.equal(f.wholeLoads[0].loader.aborted, false);
      assert.equal(f.commitmentCalls, oldModule ? 1 : 0);
      if (oldModule) {
        f.hls.media = { currentTime: 0, buffered: { length: 1, start: () => 0, end: () => 20 } };
        sameBytes(await clock.settle(f.load()), f.bytes);
        assert.ok(f.swarm.metrics().bytes.peerFirst > 0, "the older module still performs its ordinary mixed transfer");
      }
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("zero-budget cached race starts HTTP first and accepts only a complete verified peer winner", async t => {
  const clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{}], wholeOriginDelayMs: 100, onPeerDelivery: value => observed.push(value),
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 500, segmentKey: url => {
        assert.ok(f.wholeLoads.length > 0, "normal HTTP starts before even the local key callback"); return new URL(url).pathname;
      } } }));
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    const load = beginCountedMultiLoad(f);
    assert.equal(f.wholeLoads.length, 1); assert.equal(f.commitmentCalls, 0);
    sameBytes(await clock.settle(load.response), f.bytes);
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaces, 1);
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
    assert.equal(f.wholeLoads[0].loader.aborted, true);
    assert.deepEqual(f.ranges, [], "explicit peer-only mode emits no origin request");
    assert.equal(observed.reduce((sum, value) => sum + value.bytes, 0), f.bytes.length);
    assert.equal(observed[0].connection, f.connections[0]);
    await clock.advance(130);
    assert.deepEqual([load.calls.success.length, load.calls.abort.length, load.calls.error.length], [1, 0, 0], "losing HTTP callbacks stay suppressed");
  } finally {
    if (f) await clock.settle(f.close());
    clock.restore();
  }
});

test("zero-budget cached race never delays a winning HTTP response for uncooperative metadata", async t => {
  let metadataSignal, metadataFinished = false;
  const observed = [];
  const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: 15, onPeerDelivery: value => observed.push(value),
    beforeCommitment: (_context, { signal }) => { metadataSignal = signal; return new Promise(resolve => setTimeout(() => { metadataFinished = true; resolve(); }, 100)); },
    swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 500 } });
  f.hls.media = { currentTime: 0, buffered: { length: 0 } };
  try {
    const load = beginCountedMultiLoad(f);
    sameBytes(await load.response, f.bytes);
    assert.equal(metadataFinished, false, "HTTP success precedes metadata completion");
    assert.equal(metadataSignal.aborted, true);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 0);
    assert.deepEqual(observed, []);
    assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
    await sleep(120); assert.equal(load.calls.success.length, 1);
  } finally { await f.close(); }
});

test("zero-budget cached race clears holder history only for an accepted peer contributor", async t => {
  const discovery = Object.getPrototypeOf((await loadCore(multiCore)).neighbourDiscovery());
  const delivered = [], original = discovery.holderDelivered;
  t.mock.method(discovery, "holderDelivered", function (context, pubkey) {
    delivered.push({ context, pubkey });
    return original.call(this, context, pubkey);
  });
  for (const peerWins of [true, false]) {
    await t.test(peerWins ? "verified peer winner" : "HTTP winner", async t => {
      delivered.length = 0;
      const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: peerWins ? 100 : 15,
        beforeCommitment: peerWins ? null : () => sleep(100),
        swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 500 } });
      f.hls.media = { currentTime: 0, buffered: { length: 0 } };
      try {
        await f.addPeer(new RangedChannel(f.bytes));
        const load = beginCountedMultiLoad(f);
        sameBytes(await load.response, f.bytes);
        if (peerWins) {
          assert.equal(delivered.length, 1, "a connected non-contributor keeps its holder history");
          assert.equal(delivered[0].pubkey, f.peers[0].pubkey);
          assert.equal(delivered[0].context.mediaType, "main");
          assert.equal(f.swarm.metrics().neighbourDiscovery.counters.verified, 1);
        } else {
          await sleep(120);
          assert.deepEqual(delivered, [], "losing metadata or partial peer work never clears holder history");
          assert.equal(f.swarm.metrics().neighbourDiscovery.counters.verified, 0);
        }
      } finally { await f.close(); }
    });
  }
});

test("zero-budget cached race keeps a bursty peer until the real HTTP winner or absolute deadline", async t => {
  class BurstyCachedChannel extends RangedChannel {
    send(data) {
      const request = typeof data === "string" ? JSON.parse(data) : null;
      if (request?.t !== "want") return super.send(data);
      if (this.wants.length) return super.send(data);
      RecordedChannel.prototype.send.call(this, data); this.wants.push(request.p ?? null);
      const piece = commitmentPieceSize(this.bytes.length), from = request.p[0] * piece, to = Math.min(this.bytes.length, request.p[1] * piece);
      const body = this.bytes.slice(from, to);
      setTimeout(() => this.receive(JSON.stringify({ t: "meta", id: request.id, size: body.length, p: request.p })), 0);
      for (let chunk = 0; chunk < 4; chunk++) setTimeout(() => {
        if (this.readyState === "open") this.receive(body.slice(chunk * 16_384, Math.min(body.length, (chunk + 1) * 16_384)).buffer);
      }, 10 + chunk * 200);
      setTimeout(() => {
        if (this.readyState !== "open") return;
        this.receive(JSON.stringify({ t: "eof", id: request.id }));
      }, 700);
    }
  }
  const clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ Channel: BurstyCachedChannel }], size: 1024 * 1024, wholeOriginDelayMs: 900,
      onPeerDelivery: row => observed.push(row), swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 1_000 } }));
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    const pending = beginCountedMultiLoad(f);
    sameBytes(await clock.settle(pending.response, 1_100), f.bytes);
    assert.equal(f.swarm.metrics().segments.peerAbandoned, 0, "the serial recovery projection does not kill the parallel peer arm");
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
    assert.equal(observed.reduce((sum, row) => sum + row.bytes, 0), f.bytes.length);
    assert.equal(observed[0].connection, f.connections[0]);
    assert.equal(f.wholeLoads.length, 1);
    assert.equal(f.wholeLoads[0].loader.aborted, true);
    assert.deepEqual(f.ranges, []);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

class FixedRateChannel extends PhasedFlowChannel {
  constructor(bytes, options = {}) { super(bytes, options); this.rate = options.rate ?? 327_680; }
  send(data) {
    const frame = typeof data === 'string' ? JSON.parse(data) : null;
    if (frame?.t === 'want') {
      const size = commitmentPieceSize(this.bytes.length);
      const from = frame.p ? frame.p[0] * size : 0;
      const to = frame.p ? Math.min(frame.p[1] * size, this.bytes.length) : this.bytes.length;
      this.flowMs = (to - from) / this.rate * 1000;
    }
    return super.send(data);
  }
}

test("known whole-unfit cached peer-only work leaves immediate HTTP alone", async t => {
  const clock = virtualClock(t);
  let f;
  // A six-MiB commitment has 98,304-byte pieces. Carrying one over the
  // existing 300ms measurement floor gives a real measured 327,680B/s flow.
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024,
      holders: [{ Channel: FixedRateChannel, firstByteMs: 450 }], originFallbackMs: 1000,
      originDelayMs: 50, holdWholeOrigin: true, traceRequests: 4096,
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 2500 } }));
    sameBytes(await clock.settle(f.load(), 2000), f.bytes);
    const training = f.swarm.metrics().peerRequestDiagnostics.records.find(row =>
      row.outcome === 'payload' && row.receivedBytes >= 32_768 && row.elapsedMs - row.firstByteMs >= 300);
    assert(training, 'the real signed Core transfer must first measure this accepted holder');
    assert(f.ranges.length > 0, 'ordinary mixed range delivery supplies the calibration object');
    const wants = f.channels[0].wants.length, sources = f.wholeLoads.length, before = f.swarm.metrics();
    f.hls.media = { currentTime: 10, paused: false, ended: false, seeking: false, readyState: 4,
      playbackRate: 1, buffered: { length: 0 } };
    const entry = clock.now(), pending = beginCountedMultiLoad(f);
    assert.equal(f.wholeLoads.length, sources + 1, 'whole HTTP starts synchronously before peer admission');
    const whole = f.wholeLoads.at(-1);
    await clock.advance(2600);
    const model = f.swarm.metrics().core.multiHolder.peerFlow.lastModel;
    assert(model && model.firstByteMs !== null && model.rateBytesPerSecond > 0,
      'the decision uses an actual known same-link flow, not an unknown refresh');
    assert(model.firstByteMs + f.pieceSize / model.rateBytesPerSecond * 1000 < 2500,
      'a single piece fits the peer-only deadline');
    assert(model.firstByteMs + f.bytes.length / model.rateBytesPerSecond * 1000 > 2500,
      'the same known flow cannot complete the signed whole object');
    whole.callbacks.onSuccess({ data: f.bytes.slice().buffer }, whole.loader.stats, multiContext, null);
    sameBytes(await clock.settle(pending.response), f.bytes);
    assert.deepEqual([pending.calls.success.length, pending.calls.abort.length, pending.calls.error.length], [1, 0, 0]);
    assert.equal(f.wholeLoads.length, sources + 1, 'there is still exactly one whole HTTP source');
    const starts = f.swarm.trace().rows.filter(row => row.k === 'xfer' && row.op === 'start' && row.peerOnly);
    t.diagnostic(JSON.stringify({ training: { bytes: training.receivedBytes, firstByteMs: training.firstByteMs,
      flowMs: training.elapsedMs - training.firstByteMs }, model, wholeBytes: f.bytes.length,
      elapsedMs: clock.now() - entry, additionalPeerRequests: f.channels[0].wants.length - wants,
      peerOnlyCoreStarts: starts.length, peerOnlyCommands: starts.map(row => row.out?.c) }));
    assert.equal(f.channels[0].wants.length, wants,
      'a known whole-unfit peer-only transfer must not claim the holder for partial work it cannot deliver');
    const after = f.swarm.metrics();
    assert.equal(after.segments.peerNoFit, before.segments.peerNoFit + 1);
    assert.equal(after.peerAdmission.claims, before.peerAdmission.claims, 'decline occurs before taking a link lease');
    assert.equal(after.core.multiHolder.transfers, before.core.multiHolder.transfers, 'decline occurs before allocating Core work');
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('known whole-unfit demand refresh measures faster actual flow after the existing cooldown', { timeout: 15000 }, async t => {
  // Functional policy timing and simulated paced channel, real signed six-MiB
  // commitment/Core/framing/hash path. Neither model rates nor HAVE are seeded.
  const clock = warmFunctionalClock(t, () => false); let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024,
      holders: [{ Channel: FixedRateChannel, firstByteMs: 450, rate: 327680 }], originFallbackMs: 1000,
      originDelayMs: 50, holdWholeOrigin: true, traceRequests: 4096,
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 2500 } }));
    sameBytes(await clock.settle(f.load()), f.bytes);
    const training = f.swarm.metrics().peerRequestDiagnostics.records.find(row =>
      row.outcome === 'payload' && row.receivedBytes >= 32768 && row.elapsedMs - row.firstByteMs >= 300);
    assert(training, 'the old rate must come from actual qualifying signed-piece payload');
    f.hls.media = { currentTime: 10, paused: false, ended: false, seeking: false, readyState: 4,
      playbackRate: 1, buffered: { length: 0 } };
    const wants = f.channels[0].wants.length, sources = f.wholeLoads.length;
    const initial = beginCountedMultiLoad(f);
    assert.equal(f.wholeLoads.length, sources + 1, 'ordinary HTTP starts synchronously');
    await clock.advance(100);
    const old = f.swarm.metrics().core.multiHolder.peerFlow.lastModel;
    assert(old.firstByteMs + f.pieceSize / old.rateBytesPerSecond * 1000 < 2500);
    assert(old.firstByteMs + f.bytes.length / old.rateBytesPerSecond * 1000 > 2500);
    assert.equal(f.channels[0].wants.length, wants, 'the existing cooldown keeps the known whole-fit rejection');
    const source = f.wholeLoads.at(-1);
    source.callbacks.onSuccess({ data: f.bytes.slice().buffer }, source.loader.stats, multiContext, null);
    sameBytes(await clock.settle(initial.response), f.bytes);
    await clock.advance(10001); // Original ten-second refresh cooldown; still inside 30s model TTL.
    f.channels[0].rate = 4 * 1024 * 1024; f.channels[0].firstByteMs = 20;
    const before = f.swarm.metrics(), from = f.swarm.trace().rows.length, sourceCount = f.wholeLoads.length;
    const at = performance.now(), refreshed = beginCountedMultiLoad(f);
    assert.equal(f.wholeLoads.length, sourceCount + 1, 'refresh never postpones or duplicates whole HTTP');
    await clock.advance(100);
    assert(f.channels[0].wants.length > wants, 'a whole-fit miss may issue one explicit bounded refresh after cooldown');
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst, 'partial calibration cannot claim accepted media');
    const start = f.swarm.trace().rows.slice(from).find(row => row.k === 'xfer' && row.op === 'start');
    assert(start?.peerOnly && start.wholeFitRefresh);
    assert.equal(start.peers.length, 1); assert.deepEqual(start.probePeers, [start.peers[0][0]]);
    assert.deepEqual(start.peers[0].slice(1), [null, null], 'the explicit probe is not a fabricated faster model');
    assert(start.wholeFitRefresh.rateBytesPerSecond > 0 && start.wholeFitRefresh.capacityBytes < f.bytes.length);
    assert(start.deadline - at <= 2500, 'the refresh retains the original absolute peer cap');
    sameBytes(await clock.settle(refreshed.response), f.bytes);
    assert.deepEqual([refreshed.calls.success.length, refreshed.calls.abort.length, refreshed.calls.error.length], [1, 0, 0]);
    const after = f.swarm.metrics();
    assert.equal(after.bytes.peerFirst - before.bytes.peerFirst, f.bytes.length, 'only the complete verified winner earns credit');
    assert.equal(f.wholeLoads.at(-1).loader.aborted, true);
    assert(after.core.multiHolder.peerFlow.verifiedShortBatches > before.core.multiHolder.peerFlow.verifiedShortBatches,
      'actual verified refills establish a qualifying same-transfer flow');
    const lastFrom = f.swarm.trace().rows.length;
    sameBytes(await clock.settle(beginCountedMultiLoad(f).response), f.bytes);
    const learned = f.swarm.metrics().core.multiHolder.peerFlow.lastModel;
    const next = f.swarm.trace().rows.slice(lastFrom).find(row => row.k === 'xfer' && row.op === 'start');
    assert(learned.rateBytesPerSecond > old.rateBytesPerSecond * 2);
    assert(next && !next.wholeFitRefresh && next.probePeers.length === 0, 'later whole-fit work uses the new measured rate');
    assert.deepEqual(f.ranges.slice(1), [], 'the peer-only probe never adds origin ranges');
    console.log(JSON.stringify({ fixture: 'whole-fit-refresh-real-core', controllerClock: 'logical-functional',
      objectBytes: f.bytes.length, oldModel: old, measuredNewModel: learned,
      refreshElapsedMs: performance.now() - at, creditedCompleteObjectBytes: after.bytes.peerFirst - before.bytes.peerFirst }));
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

async function wholeFitRefreshControlFixture(t, { worker = false, beforeCommitment = null } = {}) {
  const clock = warmFunctionalClock(t, () => false);
  const bridge = worker ? transferWorkerFixture(t) : null;
  let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024,
      holders: [{ Channel: FixedRateChannel, firstByteMs: 450, rate: 327680 }], originFallbackMs: 1000,
      originDelayMs: 50, holdWholeOrigin: true, traceRequests: 4096, beforeCommitment,
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 2500,
        ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } }));
    if (worker) await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.state === 'ready');
    sameBytes(await clock.settle(f.load()), f.bytes);
    assert(f.swarm.metrics().peerRequestDiagnostics.records.some(row =>
      row.outcome === 'payload' && row.receivedBytes >= 32768 && row.elapsedMs - row.firstByteMs >= 300));
    f.hls.media = { currentTime: 10, paused: false, ended: false, seeking: false, readyState: 4,
      playbackRate: 1, buffered: { length: 0 } };
    await clock.advance(10001);
    const close = async () => { try { await clock.settle(f.close()); } finally { clock.restore(); } };
    return { f, clock, bridge, close };
  } catch (error) { try { if (f) await clock.settle(f.close()); } finally { clock.restore(); } throw error; }
}

for (const ending of ['deadline', 'abort', 'HTTP-winner']) test(`whole-fit refresh ${ending} cannot credit incomplete calibration or renew the cooldown`, { timeout: 15000 }, async t => {
  const q = await wholeFitRefreshControlFixture(t), { f, clock } = q;
  try {
    const before = f.swarm.metrics(), wants = f.channels[0].wants.length, from = f.swarm.trace().rows.length;
    const entry = performance.now(), pending = beginCountedMultiLoad(f);
    assert(f.wholeLoads.length > 0, 'ordinary source is already active');
    await clock.advanceUntil(() => f.channels[0].wants.length > wants, 100);
    const start = f.swarm.trace().rows.slice(from).find(row => row.k === 'xfer' && row.op === 'start');
    assert(start.wholeFitRefresh); assert(start.deadline - entry <= 2500);
    assert.equal(f.channels[0].wants[wants][1] - f.channels[0].wants[wants][0], 1, 'refresh starts with exactly one signed piece');
    const source = f.wholeLoads.at(-1);
    if (ending === 'abort') pending.loader.abort();
    if (ending === 'HTTP-winner') {
      source.callbacks.onSuccess({ data: f.bytes.slice().buffer }, source.loader.stats, multiContext, null);
      sameBytes(await clock.settle(pending.response), f.bytes);
    }
    await clock.advance(2600);
    if (ending === 'deadline') {
      assert.equal(pending.calls.success.length, 0, 'the original peer deadline cannot deliver a partial object');
      source.callbacks.onSuccess({ data: f.bytes.slice().buffer }, source.loader.stats, multiContext, null);
      sameBytes(await clock.settle(pending.response), f.bytes);
    }
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
    assert.equal(f.swarm.metrics().core.multiHolder.delivered, before.core.multiHolder.delivered);
    assert.equal(pending.calls.success.length, ending === 'abort' ? 0 : 1);
    assert.equal(pending.calls.abort.length, ending === 'abort' ? 1 : 0);
    const ends = f.swarm.trace().rows.slice(from).filter(row => row.k === 'xferFinish');
    assert.equal(ends.length, 1); assert.equal(ends[0].delivered, false);
    assert.equal(ends[0].reason, 'signal-abort');
    const afterWants = f.channels[0].wants.length, afterTransfers = f.swarm.metrics().core.multiHolder.transfers;
    const second = beginCountedMultiLoad(f); const secondSource = f.wholeLoads.at(-1);
    await clock.advance(100);
    assert.equal(f.channels[0].wants.length, afterWants, 'an emitted probe consumes the original cooldown even when it fails');
    assert.equal(f.swarm.metrics().core.multiHolder.transfers, afterTransfers);
    secondSource.callbacks.onSuccess({ data: f.bytes.slice().buffer }, secondSource.loader.stats, multiContext, null);
    sameBytes(await clock.settle(second.response), f.bytes);
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
  } finally { await q.close(); }
});

for (const ending of ['metadata-refusal', 'captured-holder-withdrawal', 'warm-marker']) test(`whole-fit refresh ${ending} performs no optional probe and preserves later genuine eligibility`, { timeout: 15000 }, async t => {
  let deny = false, withdraw = false, current;
  const q = await wholeFitRefreshControlFixture(t, { beforeCommitment: () => {
    if (deny) throw new Error('fixture commitment refused');
    if (withdraw) { withdraw = false; current.channels[0].receive(JSON.stringify({ t: 'have', keys: [] })); }
  } }), { f, clock } = q; current = f;
  try {
    const wants = f.channels[0].wants.length, before = f.swarm.metrics();
    deny = ending === 'metadata-refusal'; withdraw = ending === 'captured-holder-withdrawal';
    const context = ending === 'warm-marker' ? { ...multiContext, frag: { ...multiContext.frag }, [WARM_AHEAD]: { peerBytes: 0 } } : multiContext;
    const pending = beginCountedMultiLoad(f, context); const source = f.wholeLoads.at(-1);
    await clock.advance(100);
    assert.equal(f.channels[0].wants.length, wants);
    assert.equal(f.swarm.metrics().core.multiHolder.transfers, before.core.multiHolder.transfers);
    source.callbacks.onSuccess({ data: f.bytes.slice().buffer }, source.loader.stats, context, null);
    sameBytes(await clock.settle(pending.response), f.bytes);
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
    deny = false;
    f.channels[0].receive(JSON.stringify({ t: 'have', add: [f.key] }));
    const retry = beginCountedMultiLoad(f); const retrySource = f.wholeLoads.at(-1);
    await clock.advanceUntil(() => f.channels[0].wants.length > wants, 100);
    assert(f.swarm.trace().rows.some(row => row.k === 'xfer' && row.wholeFitRefresh),
      'refusal before any REQUEST did not consume the ten-second refresh');
    retrySource.callbacks.onSuccess({ data: f.bytes.slice().buffer }, retrySource.loader.stats, multiContext, null);
    sameBytes(await clock.settle(retry.response), f.bytes);
    await clock.advance(100);
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
  } finally { await q.close(); }
});

test('whole-fit refresh cancelled during actual Worker allocation before REQUEST preserves cooldown eligibility', { timeout: 15000 }, async t => {
  const q = await wholeFitRefreshControlFixture(t, { worker: true }), { f, clock, bridge } = q;
  try {
    const wants = f.channels[0].wants.length, before = f.swarm.metrics();
    bridge.workers[0].holdNew = true;
    const pending = beginCountedMultiLoad(f);
    await clock.advanceUntil(() => bridge.workers[0].newRequests?.length === 1, 500);
    assert.equal(f.channels[0].wants.length, wants, 'the allocated probe has not emitted its first REQUEST');
    pending.loader.abort();
    bridge.workers[0].holdNew = false; bridge.workers[0].releaseNew();
    await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.transfers === 0, 500);
    const retry = beginCountedMultiLoad(f), source = f.wholeLoads.at(-1);
    await clock.advanceUntil(() => f.channels[0].wants.length > wants, 500);
    assert(f.swarm.trace().rows.some(row => row.k === 'xfer' && row.wholeFitRefresh));
    source.callbacks.onSuccess({ data: f.bytes.slice().buffer }, source.loader.stats, multiContext, null);
    sameBytes(await clock.settle(retry.response), f.bytes);
    await clock.advance(100);
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
    assert.deepEqual([pending.calls.success.length, pending.calls.abort.length], [0, 1]);
    assert.deepEqual([retry.calls.success.length, retry.calls.abort.length], [1, 0]);
  } finally { await q.close(); }
});

test("known whole-fit cached peer-only work combines admissible holders", async t => {
  for (const count of [1, 2]) await t.test(`${count} measured holder${count === 1 ? '' : 's'}`, async t => {
    const clock = virtualClock(t); let f;
    try {
      f = await clock.settle(multiFixture(t, { size: count * 65_536,
        holders: Array.from({ length: count }, () => ({ Channel: FixedRateChannel, firstByteMs: 450, rate: 65_536 / .3 })),
        originFallbackMs: 800, holdWholeOrigin: true, traceRequests: 4096,
        swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 800 } }));
      sameBytes(await clock.settle(f.load(), 1_000), f.bytes);
      assert.equal(f.swarm.metrics().peerRequestDiagnostics.counters.payload, count,
        'every holder first supplies an actual verified 300ms flow');
      const wants = f.channels.map(channel => channel.wants.length), before = f.swarm.metrics();
      f.hls.media = { currentTime: 10, buffered: { length: 0 } };
      const entry = clock.now(), pending = beginCountedMultiLoad(f);
      assert.equal(f.wholeLoads.length, 1, 'the original whole HTTP starts synchronously');
      sameBytes(await clock.settle(pending.response, 800), f.bytes);
      const start = f.swarm.trace().rows.find(row => row.k === 'xfer' && row.op === 'start' && row.peerOnly);
      assert(start, 'actual Core peer-only delivery is admitted');
      assert.equal(start.peers.length, count);
      assert(start.peers.every(([, first, rate]) => first === 450 && rate > 0), 'all estimates use measured same-link flow');
      assert.deepEqual(start.probePeers, [], 'the positive case cannot pass through unknown refresh');
      if (count === 2) assert(start.peers.every(([, first, rate]) => first + f.bytes.length / rate > 800),
        'neither holder could deliver this whole object alone');
      assert(start.peers.reduce((sum, [, first, rate]) => sum + Math.max(0, 800 - first) * rate, 0) >= f.bytes.length,
        'the combined measured holders fit without increasing the original deadline');
      assert(f.channels.every((channel, i) => channel.wants.length > wants[i]), 'both admitted holders really serve the object');
      assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, before.segments.zeroBudgetPeerRaceWins + 1);
      assert.equal(f.swarm.metrics().bytes.peerFirst - before.bytes.peerFirst, f.bytes.length);
      assert.equal(f.wholeLoads[0].loader.aborted, true);
      assert.deepEqual(f.ranges, [], 'peer-only success opens no internal HTTP range');
      assert.deepEqual([pending.calls.success.length, pending.calls.abort.length, pending.calls.error.length], [1, 0, 0]);
      assert(clock.now() - entry <= 800);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test("zero-budget cached peer-only ranges cannot be stranded by earlier fast whole-HTTP timing", async t => {
  const clock = virtualClock(t), observed = [];
  let f, releaseMetadata;
  let holdMetadata = true;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ delayMs: 5 }], size: 6 * 1024 * 1024, wholeOriginDelayMs: 2_000,
      traceRequests: 4_096, onPeerDelivery: row => observed.push(row),
      beforeCommitment: () => holdMetadata ? new Promise(resolve => { releaseMetadata = resolve; }) : undefined,
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 500 } }));
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    const first = beginCountedMultiLoad(f);
    await clock.advanceUntil(() => Boolean(releaseMetadata), 100);
    await clock.advance(18);
    const initial = f.wholeLoads[0];
    initial.callbacks.onSuccess({ data: f.bytes.slice().buffer }, initial.loader.stats, multiContext, null);
    sameBytes(await clock.settle(first.response), f.bytes);
    assert.equal(f.channels[0].wants.length, 0, "the fast HTTP winner did not train a peer failure");
    assert.ok(f.swarm.metrics().segments.originLatencyMedianMs < 50);
    holdMetadata = false; releaseMetadata();
    const second = beginCountedMultiLoad(f);
    sameBytes(await clock.settle(second.response, 2_500), f.bytes);
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
    assert.equal(observed.reduce((sum, row) => sum + row.bytes, 0), f.bytes.length);
    assert.ok(observed.every(row => row.connection === f.connections[0]));
    assert.equal(f.wholeLoads.length, 2);
    assert.equal(f.wholeLoads[1].loader.aborted, true);
    assert.deepEqual(f.ranges, [], "the external normal HTTP arm remains the only HTTP source");
    const start = f.swarm.trace().rows.filter(row => row.k === "xfer" && row.op === "start").at(-1);
    assert.equal(start.peerOnly, true);
    assert.equal(start.origin, null, "whole-HTTP latency does not become an internal ranged source");
    assert.ok(f.swarm.trace().rows.filter(row => row.k === "xfer").every(row => !row.out?.c.some(command => command.t === "origin")));
    assert.ok(f.channels[0].wants.length >= 17 && f.channels[0].wants.every(range => Array.isArray(range) && range[1] - range[0] <= 4));
  } finally { releaseMetadata?.(); if (f) await clock.settle(f.close()); clock.restore(); }
});

class PartialFlowChannel extends PhasedFlowChannel {
  partial = true;
  send(data) {
    const frame = typeof data === 'string' ? JSON.parse(data) : null;
    if (frame?.t === 'want') this.firstByteMs = this.partial && this.wants.length > 0 ? 1000 : 20;
    return super.send(data);
  }
}

function heldRealXhrSource(t) {
  assert.equal(Hls.version, '1.7.3');
  const globals = new Map(['self', 'XMLHttpRequest'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const requests = [], instances = [], order = [];
  class HeldXHR {
    readyState = 0; status = 200; responseType = 'arraybuffer'; abortCalls = 0;
    constructor() { requests.push(this); }
    open(_method, url) { this.readyState = 1; this.responseURL = url; }
    setRequestHeader() {}
    getResponseHeader() { return null; }
    getAllResponseHeaders() { return ''; }
    send() {}
    abort() { this.abortCalls++; this.readyState = 0; }
    complete(body, status = 200) { this.status = status; this.response = body; this.readyState = 4; this.onreadystatechange?.(); }
  }
  class OriginLoader extends Hls.DefaultConfig.loader {
    constructor(config) { super(config); instances.push(this); }
    load(context, config, callbacks) {
      return super.load(context, config, { ...callbacks,
        onProgress: (...args) => { order.push('progress'); callbacks.onProgress?.(...args); },
        onSuccess: (...args) => { order.push('success'); callbacks.onSuccess?.(...args); },
      });
    }
  }
  Object.defineProperty(globalThis, 'self', { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: HeldXHR });
  t.after(() => { for (const [name, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  } });
  return { OriginLoader, requests, instances, order };
}

for (const late of [false, true]) test(`actual XHR ${late ? 'late' : 'cached'} completion preserves fresh partial usefulness after its final progress`, async t => {
  const xhr = heldRealXhrSource(t), clock = virtualClock(t); let f, next;
  const context = { ...multiContext, responseType: 'arraybuffer' };
  try {
    f = await clock.settle(multiFixture(t, { OriginLoader: xhr.OriginLoader,
      holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }], size: 2 * 1024 * 1024,
      traceRequests: 4096, swarmOptions: { zeroBudgetPeerRace: true, latePeerRace: late, maxPeerWaitMs: 1000 } }));
    f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
    if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    const first = beginCountedMultiLoad(f, context);
    if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [f.key] }));
    await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
    const creditedAt = performance.now();
    assert.equal(f.swarm.metrics().core.multiHolder.peerBytes, f.pieceSize);
    await clock.advanceUntil(() => f.channels[0].wants.length >= 2, 100);
    await clock.advance(100);
    if (late) assert.ok(f.swarm.metrics().latePeerRace.records.some(row => row.outcome === 'armed'));
    const schedule = queueMicrotask; let scheduled = 0;
    const microtask = t.mock.method(globalThis, 'queueMicrotask', callback => { scheduled++; schedule(callback); });
    xhr.requests[0].complete(f.bytes.slice().buffer); microtask.mock.restore();
    assert.equal(scheduled, 1, 'only one progress retirement is pending for this race');
    sameBytes(await clock.settle(first.response), f.bytes);
    assert.deepEqual(xhr.order, ['progress', 'success'], 'the installed XhrLoader itself emits final progress before success');
    assert.equal(first.calls.success[0][3], xhr.requests[0], 'the Hls callback receives the real HTTP winner');
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 0);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 1);
    await clock.advance(3);
    const before = f.channels[0].wants.length;
    f.channels[0].partial = false; f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    next = beginCountedMultiLoad(f, context); await clock.advance(50);
    const flow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(flow.lastModel.decision, 'useful-unknown'); assert.equal(flow.lastModel.rateBytesPerSecond, null);
    assert.ok(flow.lastModel.usefulAgeMs >= 100 && flow.lastModel.usefulAgeMs <= performance.now() - creditedAt + 1);
    assert.equal(f.channels[0].wants[before][1] - f.channels[0].wants[before][0], 1);
  } finally { next?.loader.abort(); if (f) await clock.settle(f.close()); clock.restore(); }
});

test('actual XHR success prequeued before progress can validate before queued retirement', async t => {
  const xhr = heldRealXhrSource(t), clock = virtualClock(t); let f, first;
  const context = { ...multiContext, responseType: 'arraybuffer' };
  try {
    f = await clock.settle(multiFixture(t, { OriginLoader: xhr.OriginLoader,
      holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }], size: 2 * 1024 * 1024,
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 1000 } }));
    f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
    first = beginCountedMultiLoad(f, context);
    await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
    await clock.advanceUntil(() => f.channels[0].wants.length >= 2, 100); await clock.advance(1);
    queueMicrotask(() => xhr.requests[0].complete(f.bytes.slice().buffer));
    const source = xhr.instances[0];
    source.callbacks.onProgress(source.stats, context, f.bytes.slice(0, 16384).buffer, xhr.requests[0]);
    sameBytes(await clock.settle(first.response), f.bytes);
    assert.deepEqual(xhr.order, ['progress', 'progress', 'success']);
    assert.equal(first.calls.success.length, 1);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 1,
      'the contract is owned success before retirement, including an already queued success');
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 0);
  } finally { first?.loader.abort(); if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const late of [false, true]) test(`actual XHR ${late ? 'late' : 'cached'} progress cannot preserve on failure or retired ownership`, async t => {
  for (const ending of ['progress-only', 'later-error', 'later-success', 'error', 'abort', 'stop', 'replacement', 'expiry', 'throw'])
    await t.test(ending, async t => {
      const xhr = heldRealXhrSource(t), clock = virtualClock(t); let f, first, replacement;
      const context = { ...multiContext, responseType: 'arraybuffer' }, thrown = new Error('host progress callback');
      try {
        f = await clock.settle(multiFixture(t, { OriginLoader: xhr.OriginLoader,
          holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }], size: 2 * 1024 * 1024,
          swarmOptions: { zeroBudgetPeerRace: true, latePeerRace: late, maxPeerWaitMs: 1000 } }));
        f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
        if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
        first = beginCountedMultiLoad(f, context, () => {
          if (ending === 'abort') first.loader.abort();
          if (ending === 'stop') f.swarm.stop();
          if (ending === 'replacement') { first.loader.abort(); replacement = beginCountedMultiLoad(f, context); }
          if (ending === 'throw') throw thrown;
        });
        if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [f.key] }));
        await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
        await clock.advanceUntil(() => f.channels[0].wants.length >= 2, 100); await clock.advance(1);
        if (ending === 'expiry') await clock.advance(1001);
        if (['progress-only', 'later-error', 'later-success'].includes(ending)) {
          // A generic nonterminal chunk is not XhrLoader's synchronous terminal
          // pair. Exercise the supplied callback, then let the microtask retire it.
          const source = xhr.instances[0];
          source.callbacks.onProgress(source.stats, context, f.bytes.slice(0, 16384).buffer, xhr.requests[0]);
          source.callbacks.onProgress(source.stats, context, f.bytes.slice(0, 16384).buffer, xhr.requests[0]);
          if (ending === 'progress-only') {
            // A real native peer response racing after the claim cannot win Hls.
            const want = f.channels[0].sent.findLast(frame => frame.t === 'want');
            const body = f.bytes.slice(want.p[0] * f.pieceSize, Math.min(want.p[1] * f.pieceSize, f.bytes.length));
            for (let at = 0; at < body.length; at += 16384) f.channels[0].receive(body.slice(at, at + 16384).buffer);
            f.channels[0].receive(JSON.stringify({ t: 'eof', id: want.id }));
          }
          await clock.advance(5);
          assert.equal(first.calls.success.length, 0, 'progress alone cannot complete the HTTP owner or hand off peer media');
          if (ending === 'later-error') xhr.requests[0].complete(f.bytes.slice().buffer, 500);
          if (ending === 'later-success') { xhr.requests[0].complete(f.bytes.slice().buffer); await clock.settle(first.response); }
        } else if (ending === 'throw') assert.throws(() => xhr.requests[0].complete(f.bytes.slice().buffer), error => error === thrown);
        else xhr.requests[0].complete(f.bytes.slice().buffer, ending === 'error' ? 500 : 200);
        await clock.advance(5);
        if (ending === 'replacement') {
          await clock.advanceUntil(() => xhr.requests.length === 2, 100);
          xhr.requests[1].complete(f.bytes.slice().buffer); await clock.settle(replacement.response);
          assert.equal(replacement.calls.success.length, 1);
          assert.equal(replacement.calls.abort.length, 0, 'the old deferred retirement cannot abort the replacement owner');
        }
        assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 0);
        assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
        assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 0);
        if (['error', 'later-error'].includes(ending)) assert.equal(first.calls.error.length, 1);
        if (['stop', 'expiry', 'later-success'].includes(ending)) assert.equal(first.calls.success.length, 1, 'source playback remains authoritative');
      } finally { first?.loader.abort(); replacement?.loader.abort(); if (f) await clock.settle(f.close()); clock.restore(); }
    });
});

test('actual XHR mixed binary then nonbinary progress retires immediately after the source claim', async t => {
  for (const late of [false, true]) await t.test(late ? 'late' : 'cached', async t => {
    const xhr = heldRealXhrSource(t), clock = virtualClock(t); let f, first;
    const context = { ...multiContext, responseType: 'arraybuffer' };
    try {
      f = await clock.settle(multiFixture(t, { OriginLoader: xhr.OriginLoader,
        holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }], size: 2 * 1024 * 1024,
        swarmOptions: { zeroBudgetPeerRace: true, latePeerRace: late, maxPeerWaitMs: 1000 } }));
      f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
      if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
      first = beginCountedMultiLoad(f, context);
      if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [f.key] }));
      await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
      await clock.advanceUntil(() => f.channels[0].wants.length >= 2, 100); await clock.advance(1);
      const source = xhr.instances[0];
      source.callbacks.onProgress(source.stats, context, f.bytes.slice(0, 16384).buffer, xhr.requests[0]);
      assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 1, 'binary progress leaves only its one pending retirement');
      let reads = 0;
      source.callbacks.onProgress(source.stats, context, { get byteLength() { reads++; return 1; } }, xhr.requests[0]);
      assert.equal(reads, 1);
      assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0, 'nonbinary progress cancels synchronously even after binary progress claimed HTTP');
      await clock.advance(3);
      xhr.requests[0].complete(f.bytes.slice().buffer); sameBytes(await clock.settle(first.response), f.bytes);
      assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 0, 'later success cannot restore released usefulness');
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    } finally { first?.loader.abort(); if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test('owned HTTP winner retains only this transfer’s fresh verified partial usefulness without a rate or Hls credit', async t => {
  for (const late of [false, true]) await t.test(late ? 'late HAVE owner' : 'cached owner', async t => {
  const clock = virtualClock(t); let f, next;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }], size: 2 * 1024 * 1024,
      holdWholeOrigin: true, traceRequests: 4096, swarmOptions: { zeroBudgetPeerRace: true, latePeerRace: late, maxPeerWaitMs: 1000 } }));
    f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
    if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    const first = beginCountedMultiLoad(f);
    if (late) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [f.key] }));
    await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
    const creditedAt = performance.now(), credited = f.swarm.metrics().core.multiHolder.peerBytes;
    assert.equal(credited, f.pieceSize, 'a real Core-verified piece preceded the whole-source winner');
    await clock.advanceUntil(() => f.channels[0].wants.length >= 2, 100);
    await clock.advance(100);
    const origin = f.wholeLoads[0];
    origin.callbacks.onSuccess({ data: f.bytes.slice().buffer }, origin.loader.stats, multiContext, null);
    sameBytes(await clock.settle(first.response), f.bytes);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.swarm.metrics().core.multiHolder.delivered, 0);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 1);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.verifiedShortBatches, 0);
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.records.at(-1).outcome, 'abort');
    await clock.advance(3); // The holder acknowledges the cancelled range EOF before reuse.
    const before = f.channels[0].wants.length;
    f.channels[0].partial = false;
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    next = beginCountedMultiLoad(f);
    await clock.advance(50);
    const flow = f.swarm.metrics().core.multiHolder.peerFlow;
    assert.equal(flow.lastModel.decision, 'useful-unknown', 'fresh partial verification must avoid unknown-flow cooldown refusal');
    assert.ok(f.channels[0].wants.length > before, 'fresh partial verification permits an unknown-flow continuation inside cooldown');
    assert.equal(flow.lastModel.rateBytesPerSecond, null);
    assert.ok(flow.lastModel.usefulAgeMs >= 100, 'usefulness is anchored to actual fresh credit, not HTTP cancellation');
    assert.ok(flow.lastModel.usefulAgeMs <= performance.now() - creditedAt + 1);
    const start = f.swarm.trace().rows.filter(row => row.k === 'xfer' && row.op === 'start').at(-1);
    assert.equal(start.peers[0][2], null);
    assert.deepEqual(start.probePeers, [start.peers[0][0]]);
    assert.equal(f.channels[0].wants[before][1] - f.channels[0].wants[before][0], 1, 'unknown flow retains its one-piece initial bound');
  } finally { next?.loader.abort(); if (f) await clock.settle(f.close()); clock.restore(); }
  });
});

test('partial usefulness is not retained across nonwinning or invalidated ownership', async t => {
  for (const ending of ['caller-abort', 'deadline', 'seek', 'replacement', 'stop', 'empty', 'unsupported', 'error', 'closed-link', 'throwing-media', 'reentrant-context', 'unknown-playback-flags'])
    await t.test(ending, async t => {
      const clock = virtualClock(t); let f, first, descriptor;
      try {
        f = await clock.settle(multiFixture(t, { holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }],
          size: 2 * 1024 * 1024, holdWholeOrigin: true, swarmOptions: { serve: false, zeroBudgetPeerRace: true, maxPeerWaitMs: 1000 } }));
        f.hls.media = Object.assign(new EventTarget(), { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } });
        if (ending === 'unknown-playback-flags') { delete f.hls.media.ended; delete f.hls.media.seeking; }
        first = beginCountedMultiLoad(f);
        await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
        assert.equal(f.swarm.metrics().core.multiHolder.peerBytes, f.pieceSize);
        await clock.advanceUntil(() => f.channels[0].wants.length >= 2, 100);
        const origin = f.wholeLoads[0];
        if (ending === 'caller-abort') first.loader.abort();
        else if (ending === 'deadline') await clock.advance(1001);
        else if (ending === 'seek') f.hls.media.dispatchEvent(new Event('seeking'));
        else if (ending === 'replacement') f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
        else if (ending === 'stop') f.swarm.stop();
        else if (ending === 'closed-link') f.channels[0].close();
        else if (ending === 'throwing-media') Object.defineProperty(f.hls.media, 'paused', { configurable: true, get() { throw new Error('private guard cannot consume source success'); } });
        else if (ending === 'reentrant-context') {
          descriptor = Object.getOwnPropertyDescriptor(multiContext.frag, 'sn'); let armed = true;
          Object.defineProperty(multiContext.frag, 'sn', { configurable: true, get() {
            if (armed) { armed = false; first.loader.abort(); }
            return 1;
          } });
        }
        if (ending === 'error') origin.callbacks.onError({ code: 500 }, multiContext, null);
        else origin.callbacks.onSuccess({ data: ending === 'empty' ? new ArrayBuffer(0) : ending === 'unsupported' ?
          { byteLength: 8, slice() { return new ArrayBuffer(8); } } : f.bytes.slice().buffer }, origin.loader.stats, multiContext, null);
        await clock.advance(5);
        assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 0);
        assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
        assert.equal(f.swarm.metrics().core.multiHolder.delivered, 0);
        if (['empty', 'unsupported', 'throwing-media'].includes(ending)) assert.equal(first.calls.success.length, 1, 'guard refusal does not alter source callback delivery');
      } finally { if (descriptor) Object.defineProperty(multiContext.frag, 'sn', descriptor); first?.loader.abort(); if (f) await clock.settle(f.close()); clock.restore(); }
    });
});

test('partial usefulness never accepts a real worker verification after its HTTP owner has retired', async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t, { holdDelivered: true });
  const clock = virtualClock(t); let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }],
      size: 2 * 1024 * 1024, holdWholeOrigin: true,
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 1000, transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } }));
    await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.state === 'ready', 1000);
    f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
    const first = beginCountedMultiLoad(f);
    await clock.advanceUntil(() => workers[0].deliveredReplies?.length > 0, 500);
    assert.equal(workers[0].deliveredReplies[0].result.verified, f.pieceSize, 'the committed worker really verified the held range');
    assert.equal(f.swarm.metrics().core.multiHolder.peerBytes, 0, 'unaccepted worker replies provide no physical credit');
    const origin = f.wholeLoads[0];
    origin.callbacks.onSuccess({ data: f.bytes.slice().buffer }, origin.loader.stats, multiContext, null);
    sameBytes(await clock.settle(first.response), f.bytes);
    workers[0].releaseDelivered(); await clock.advance(10);
    assert.equal(f.swarm.metrics().core.multiHolder.peerBytes, 0);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 0);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('a later corrupt piece discards earlier fresh partial usefulness before the HTTP winner', async t => {
  class CorruptLaterFlow extends PhasedFlowChannel {
    send(data) {
      const frame = typeof data === 'string' ? JSON.parse(data) : null;
      if (frame?.t !== 'want' || !this.wants.length) return super.send(data);
      const at = frame.p[0] * commitmentPieceSize(this.bytes.length), saved = this.bytes[at];
      this.bytes[at] ^= 0xff;
      try { return super.send(data); } finally { this.bytes[at] = saved; }
    }
  }
  const clock = virtualClock(t); let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ Channel: CorruptLaterFlow, firstByteMs: 20, flowMs: 20 }],
      size: 2 * 1024 * 1024, holdWholeOrigin: true, swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 1000 } }));
    f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
    const first = beginCountedMultiLoad(f);
    await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
    const earlier = f.swarm.metrics().core.multiHolder.peerBytes;
    assert.equal(earlier, f.pieceSize, 'the first real response verified before the corrupt response');
    await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.bans === 1, 500);
    assert.ok(f.swarm.metrics().core.multiHolder.peerBytes >= earlier && f.swarm.metrics().core.multiHolder.peerBytes < f.bytes.length,
      'a corrupt multi-piece response may also contain fresh valid pieces, without completing the object');
    const origin = f.wholeLoads[0];
    origin.callbacks.onSuccess({ data: f.bytes.slice().buffer }, origin.loader.stats, multiContext, null);
    sameBytes(await clock.settle(first.response), f.bytes);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 0);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('a newer zero-credit HTTP-winning abort invalidates previously preserved partial usefulness', async t => {
  const clock = virtualClock(t); let f, second, third;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ Channel: PartialFlowChannel, firstByteMs: 20, flowMs: 20 }],
      size: 2 * 1024 * 1024, holdWholeOrigin: true, swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 1000 } }));
    f.hls.media = { currentTime: 0, paused: false, ended: false, seeking: false, buffered: { length: 0 } };
    const first = beginCountedMultiLoad(f);
    await clock.advanceUntil(() => f.swarm.metrics().core.multiHolder.peerBytes > 0, 500);
    const original = f.wholeLoads[0];
    original.callbacks.onSuccess({ data: f.bytes.slice().buffer }, original.loader.stats, multiContext, null);
    await clock.settle(first.response); await clock.advance(3);
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 1);
    const before = f.swarm.metrics().core.multiHolder.peerBytes;
    second = beginCountedMultiLoad(f); await clock.advance(30);
    const newer = f.wholeLoads[1];
    newer.callbacks.onSuccess({ data: f.bytes.slice().buffer }, newer.loader.stats, multiContext, null);
    await clock.settle(second.response); await clock.advance(3);
    assert.equal(f.swarm.metrics().core.multiHolder.peerBytes, before, 'the newer attempt received no new verified payload');
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.partialUsefulnessPreserved, 1);
    const requests = f.channels[0].wants.length;
    f.channels[0].partial = false; f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    third = beginCountedMultiLoad(f); await clock.advance(50);
    assert.equal(f.channels[0].wants.length, requests, 'a newer zero-credit abort still enforces the original cooldown');
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.lastModel.decision, 'cooldown-blocked');
    assert.equal(f.swarm.metrics().core.multiHolder.peerFlow.lastModel.usefulAgeMs, null);
  } finally { second?.loader.abort(); third?.loader.abort(); if (f) await clock.settle(f.close()); clock.restore(); }
});

test("zero-budget cached race discards verified partial pieces when HTTP wins the whole object", async t => {
  const observed = [];
  const f = await multiFixture(t, { holders: [{ delayMs: 20 }], size: 2 * 1024 * 1024, wholeOriginDelayMs: 500,
    onPeerDelivery: value => observed.push(value), swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 1_000 } });
  f.hls.media = { currentTime: 0, buffered: { length: 0 } };
  try {
    const load = beginCountedMultiLoad(f);
    await until(() => f.swarm.metrics().core.multiHolder.peerBytes > 0);
    assert.ok(f.swarm.metrics().core.multiHolder.peerBytes < f.bytes.length, "actual verified pieces preceded the HTTP winner");
    assert.ok(f.channels[0].wants.every(Array.isArray), "the cached arm requests bounded ranges");
    assert.equal(f.swarm.metrics().core.multiHolder.delivered, 0);
    const origin = f.wholeLoads[0];
    origin.callbacks.onSuccess({ data: f.bytes.slice().buffer }, origin.loader.stats, multiContext, null);
    sameBytes(await load.response, f.bytes);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 0);
    assert.deepEqual(observed, [], "partial verified pieces did not become an accepted player object");
    assert.equal(origin.loader.aborted, false);
    assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
  } finally { await f.close(); }
});

test("zero-budget cached race excludes a later HAVE even after its initial holder fails integrity", async t => {
  const observed = [], key = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");
  let f;
  f = await multiFixture(t, { holders: [{ corrupt: true, delayMs: 10 }, {}], wholeOriginDelayMs: 150,
    onPeerDelivery: value => observed.push(value), beforeCommitment: () => f.channels[1].receive(JSON.stringify({ t: "have", keys: [key] })),
    swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 500 } });
  try {
    f.channels[1].receive(JSON.stringify({ t: "have", keys: [] }));
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    sameBytes(await beginCountedMultiLoad(f).response, f.bytes);
    assert.ok(f.channels[0].wants.length > 0 && f.channels[0].wants.every(Array.isArray), "only the initial cached holder receives bounded range requests");
    assert.deepEqual(f.channels[1].wants, [], "a later HAVE cannot replace membership captured at load entry");
    assert.equal(f.channels[0].readyState, "closed");
    assert.equal(f.swarm.metrics().segments.peerCorrupt, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.deepEqual(observed, []);
    assert.equal(f.wholeLoads.length, 1);
    assert.deepEqual(f.ranges, []);
  } finally { await f.close(); }
});

test("zero-budget cached race rejects an invalid commitment without requesting peer media", async t => {
  const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: 30,
    swarmOptions: { zeroBudgetPeerRace: true, getCommitment: () => null } });
  f.hls.media = { currentTime: 0, buffered: { length: 0 } };
  try {
    sameBytes(await beginCountedMultiLoad(f).response, f.bytes);
    assert.equal(f.swarm.metrics().segments.commitmentRejected, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
  } finally { await f.close(); }
});

test("zero-budget cached race option requires an explicit boolean", () => {
  for (const zeroBudgetPeerRace of [1, "true", null]) {
    const swarm = createHlsSwarm({ ...base, relays: ["wss://relay.example"], zeroBudgetPeerRace });
    assert.equal(swarm.metrics().disabledReason, "invalid-cached-race-option");
    swarm.stop();
  }
});

test("zero-budget cached race requires explicit opt-in and an already advertised matching HAVE", async t => {
  for (const variant of ["default", "no-have", "late-have", "progressive"]) await t.test(variant, async t => {
    const f = await multiFixture(t, { holders: [{}], wholeOriginDelayMs: 20,
      swarmOptions: variant === "default" ? {} : { zeroBudgetPeerRace: true } });
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    try {
      const key = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");
      if (variant === "no-have") f.channels[0].receive(JSON.stringify({ t: "have", keys: [] }));
      if (variant === "late-have") f.channels[0].receive(JSON.stringify({ t: "have", keys: ["f".repeat(64)] }));
      if (variant === "progressive") f.hlsConfig.progressive = true;
      const load = beginCountedMultiLoad(f);
      if (variant === "late-have") f.channels[0].receive(JSON.stringify({ t: "have", keys: [key] }));
      sameBytes(await load.response, f.bytes);
      assert.equal(f.commitmentCalls, 0); assert.deepEqual(f.channels[0].wants, []);
      assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaces, 0);
      assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
    } finally { await f.close(); }
  });
});

test("zero-budget cached race preserves pending HTTP on stop and cancels both arms on loader abort or destroy", async t => {
  for (const ending of ["stop", "abort", "destroy"]) await t.test(ending, async t => {
    const observed = [];
    const f = await multiFixture(t, { holders: [{ silent: true }], wholeOriginDelayMs: 75, onPeerDelivery: value => observed.push(value),
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 500 } });
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    try {
      const load = beginCountedMultiLoad(f);
      await until(() => f.channels[0].wants.length > 0);
      if (ending === "stop") f.swarm.stop(); else load.loader[ending]();
      if (ending === "stop") sameBytes(await load.response, f.bytes);
      await sleep(100);
      assert.equal(load.calls.success.length, ending === "stop" ? 1 : 0);
      assert.equal(load.calls.abort.length, ending === "abort" ? 1 : 0);
      assert.equal(f.wholeLoads[0].loader.aborted === true, ending !== "stop");
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.deepEqual(observed, []);
      assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
    } finally { await f.close(); }
  });
});

test("zero-budget cached race rejects corrupt pieces and expires only the peer arm", async t => {
  for (const variant of ["corrupt", "timeout"]) await t.test(variant, async t => {
    const clock = virtualClock(t), observed = [];
    let f;
    try {
      f = await clock.settle(multiFixture(t, { holders: [variant === "corrupt" ? { corrupt: true } : { silent: true }], wholeOriginDelayMs: 75,
        onPeerDelivery: value => observed.push(value), swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 30 } }));
      f.hls.media = { currentTime: 0, buffered: { length: 0 } };
      const load = beginCountedMultiLoad(f);
      sameBytes(await clock.settle(load.response), f.bytes);
      assert.ok(f.channels[0].wants.length > 0, "the peer arm was exercised inside its original 30 ms deadline");
      assert.equal(load.calls.success.length, 1); assert.equal(load.calls.abort.length, 0);
      assert.equal(f.wholeLoads[0].loader.aborted === true, false);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.deepEqual(observed, []);
      if (variant === "corrupt") {
        assert.equal(f.swarm.metrics().segments.peerCorrupt, 1);
        assert.equal(f.swarm.metrics().core.multiHolder.bans, 1);
        assert.equal(f.channels[0].readyState, "closed", "the altered whole payload closes its actual holder link");
      }
      assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
    } finally {
      if (f) await clock.settle(f.close());
      clock.restore();
    }
  });
});

test("zero-budget cached race locks to HTTP before forwarding unexpected progressive media", async t => {
  const clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ delayMs: 40 }], wholeOriginDelayMs: 75, onPeerDelivery: value => observed.push(value),
      swarmOptions: { zeroBudgetPeerRace: true, maxPeerWaitMs: 500 } }));
    f.hls.media = { currentTime: 0, buffered: { length: 0 } };
    const load = beginCountedMultiLoad(f);
    await clock.advanceUntil(() => f.channels[0].wants.length > 0, 500);
    f.wholeLoads[0].callbacks.onProgress({}, multiContext, new Uint8Array([1]).buffer, null);
    sameBytes(await clock.settle(load.response), f.bytes);
    assert.equal(load.calls.progress.length, 1); assert.equal(load.calls.success.length, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.deepEqual(observed, []);
    assert.equal(f.wholeLoads.length, 1); assert.deepEqual(f.ranges, []);
  } finally {
    if (f) await clock.settle(f.close());
    clock.restore();
  }
});

test("multi-holder: two framing 2 holders each send pieces of one schema 3 segment", async (t) => {
  const observed = [], aggregateAtObservation = [];
  const f = await multiFixture(t, { holders: [{}, {}], onPeerDelivery: value => {
    observed.push(value); aggregateAtObservation.push(f.swarm.metrics().bytes.peerFirst);
    if (observed.length === 1) throw new Error("the first host observation failed");
  } });
  try {
    assert.equal(f.swarm.metrics().core.multiHolder.enabled, true);
    sameBytes(await f.load(), f.bytes);
    for (const channel of f.channels) assert.ok(channel.wants.length && channel.wants.every((range) => Array.isArray(range)), JSON.stringify(channel.wants));
    const { multiHolder } = f.swarm.metrics().core;
    assert.equal(multiHolder.transfers, 1); assert.equal(multiHolder.delivered, 1);
    // Unmeasured peers plan at the rate floor, so origin may take a tail.
    assert.ok(multiHolder.peerBytes > 0);
    assert.equal(multiHolder.peerBytes + multiHolder.originBytes, f.bytes.length);
    assert.equal(f.swarm.metrics().bytes.fromPeers, multiHolder.peerBytes);
    assert.equal(observed.length, 2, "one observation per contributing holder, despite the first observer throwing");
    assert.deepEqual(new Set(observed.map(value => value.connection)), new Set(f.connections), "exact accepted native connections");
    assert.ok(observed.every(value => Number.isSafeInteger(value.bytes) && value.bytes > 0));
    assert.ok(observed.every(value => Object.keys(value).sort().join(",") === "bytes,connection"));
    assert.equal(observed.reduce((sum, value) => sum + value.bytes, 0), multiHolder.peerBytes);
    assert.deepEqual(aggregateAtObservation, [multiHolder.peerBytes, multiHolder.peerBytes], "all accepted peer bytes are counted before either observation");
    assert.equal(f.swarm.metrics().errors.total, 0);
  } finally { await f.close(); }
});

test("multi-holder: a holder that sends a bad piece is banned and the other completes the segment", async (t) => {
  const observed = [];
  const f = await multiFixture(t, { holders: [{}, { corrupt: true }], onPeerDelivery: value => observed.push(value) });
  try {
    sameBytes(await f.load(), f.bytes);
    assert.equal(f.swarm.metrics().core.multiHolder.bans, 1);
    assert.equal(f.channels[1].readyState, "closed");
    assert.equal(observed.length, 1);
    assert.equal(observed[0].connection, f.connections[0], "corrupt pieces never receive connection credit");
    assert.equal(observed[0].bytes, f.swarm.metrics().bytes.peerFirst);
  } finally { await f.close(); }
});

test("multi-holder: a silent holder's pieces come from origin by range at the deadline", async (t) => {
  // The link truncates remainingMs to an integer timeout, independently of
  // the transfer's floored absolute deadline. With an integer clock the
  // loader's earlier-registered floor timer wins; a fractional clock can
  // put the link timeout one millisecond before it. Pin both valid endings.
  for (const [fraction, outcome] of [[0, "abort"], [0.75, "timeout"]]) {
    await t.test(`${outcome} at clock fraction ${fraction}`, async (t) => {
      const clock = virtualClock(t, fraction);
      const observed = [];
      let f;
      try {
        // One silent trial piece projects past the 400 ms floor. Origin
        // finishes after that floor; the transfer owns it, not a whole load.
        f = await clock.settle(multiFixture(t, { holders: [{}, { silent: true }], size: 12 * 65_536,
          originFallbackMs: 400, originDelayMs: 150, traceRequests: 4096, onPeerDelivery: value => observed.push(value) }));
        sameBytes(await clock.settle(f.load()), f.bytes, "not the origin loader's whole-segment bytes");
        const [silent] = f.channels[1].wants;
        assert.equal(silent[1] - silent[0], 1, "the silent holder had one trial piece");
        const { multiHolder } = f.swarm.metrics().core;
        assert.ok(f.ranges.length > 0 && multiHolder.originRanges === f.ranges.length);
        assert.ok(f.channels[1].wants.length > 0, "the silent holder was asked");
        assert.equal(multiHolder.originBytes + multiHolder.peerBytes, f.bytes.length);
        assert.equal(f.swarm.metrics().bytes.fromPeers, multiHolder.peerBytes);
        assert.ok(multiHolder.originBytes > 0 && multiHolder.peerBytes > 0, "the delivered object combines verified peer and origin pieces");
        assert.ok(multiHolder.unusedBytes > 0, "the origin's overlapping answer contains pieces the fast holder already verified");
        assert.equal(observed.length, 1, "several successful range requests become one contribution observation");
        assert.equal(observed[0].connection, f.connections[0], "the silent holder is not credited");
        assert.equal(observed[0].bytes, multiHolder.peerBytes, "duplicate and origin-winning pieces add no peer credit");
        assert.equal(observed[0].bytes + multiHolder.originBytes, f.bytes.length, "each piece is attributed only once");
        const diagnostics = f.swarm.metrics().peerRequestDiagnostics;
        const silentRequests = diagnostics.records.filter((row) => row.holder === 2);
        assert.equal(silentRequests.length, 1);
        assert.equal(silentRequests[0].outcome, outcome);
        assert.equal(diagnostics.counters.abandoned, 0, "a deadline ending is not early abandonment");
        const calls = f.swarm.trace().rows.filter((row) => row.k === "xfer");
        const cancelled = calls.findIndex((row) => row.out.c.some((command) => command.t === "cancel" && command.peer === 2));
        const failed = calls.findIndex((row) => row.op === "failed" && row.source === 2);
        if (outcome === "abort") {
          assert.ok(cancelled >= 0 && failed > cancelled, "floor cancellation precedes the failed callback");
          assert.equal(calls[cancelled].at, calls[0].deadline, "cancelled exactly at the transfer floor");
        } else {
          assert.equal(cancelled, -1, "the link timeout retires the holder before the floor can cancel it");
          assert.ok(failed >= 0);
          assert.equal(calls[0].deadline - calls[failed].at, 1, "duration truncation puts the link one millisecond earlier");
        }
      } finally {
        if (f) await clock.settle(f.close());
        clock.restore();
      }
    });
  }
});

test("multi-holder: a failed object never observes its already verified peer pieces", async t => {
  const clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{}, { silent: true }], size: 12 * 65_536,
      originFallbackMs: 400, originDelayMs: 150, ignoreRanges: true, onPeerDelivery: value => observed.push(value) }));
    sameBytes(await clock.settle(f.load()), new Uint8Array(32).fill(9), "the failed transfer falls back to the whole origin loader");
    const { multiHolder } = f.swarm.metrics().core;
    assert.ok(multiHolder.peerBytes > 0, "a peer piece was verified before another source failed");
    assert.equal(multiHolder.delivered, 0);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.deepEqual(observed, [], "partial verified pieces were never handed to the player");
  } finally {
    if (f) await clock.settle(f.close());
    clock.restore();
  }
});

test("multi-holder: a slow origin tail keeps the measured recovery reserve instead of falling back after two seconds", async t => {
  const clock = virtualClock(t), observed = [];
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{}, { silent: true }], size: 12 * 65_536,
      originFallbackMs: 400, originDelayMs: 3_000, wholeOriginDelayMs: 3_000, traceRequests: 256,
      onPeerDelivery: value => observed.push(value) }));
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    sameBytes(await clock.settle(f.load()), f.bytes, "first origin load establishes the real three-second recovery time");
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 14.4 } };
    const start = clock.now();
    sameBytes(await clock.settle(f.load()), f.bytes);
    const elapsed = clock.now() - start;
    assert.ok(elapsed > 2_000 && elapsed < 4_400, `the ranged tail completed within the original buffered playback (${elapsed}ms)`);
    const metrics = f.swarm.metrics(), multi = metrics.core.multiHolder;
    assert.equal(metrics.segments.originFallbacks, 1, "no second whole-segment request discards verified peer pieces");
    assert.equal(multi.delivered, 1);
    assert.ok(multi.peerBytes > 0 && multi.originBytes > 0);
    assert.equal(metrics.bytes.peerFirst, observed.reduce((sum, value) => sum + value.bytes, 0));
    assert.equal(multi.originRangeOutcomes.payload, 2);
    assert.equal(multi.originRangeOutcomes.abort, 0, "valid range bodies were not cancelled at the configured two-second limit");
    const load = f.swarm.trace().rows.filter(row => row.k === "load").at(-1);
    assert.equal(load.budgetGeometry.originReserveMs, 3_850, "the measured p90 reserve was retained by this load");
    multi.originRangeOutcomes.payload = 999;
    assert.equal(f.swarm.metrics().core.multiHolder.originRangeOutcomes.payload, 2, "diagnostic snapshots own their fixed counters");
  } finally {
    if (f) await clock.settle(f.close());
    clock.restore();
  }
});

test("multi-holder: fast holders take back origin's pieces and finish before a slow origin", async (t) => {
  // Untested holders plan at the rate floor, so each gets one trial piece
  // and origin the rest. Once the trials verify fast, the holders take
  // origin's pieces back; origin's late answer adds nothing.
  const f = await multiFixture(t, { holders: [{}, {}], size: 12 * 65_536, originFallbackMs: 3_000, originDelayMs: 1_500 });
  try {
    sameBytes(await f.load(), f.bytes);
    assert.ok(f.ranges.length > 0, "origin was given a tail");
    for (const channel of f.channels) assert.ok(channel.wants.length > 1, JSON.stringify(channel.wants));
    const { multiHolder } = f.swarm.metrics().core;
    assert.equal(multiHolder.peerBytes, f.bytes.length);
    // Origin answers after 1.5 s; a delivered transfer ignores it.
    assert.equal(multiHolder.originBytes, 0, "finished before origin answered");
    assert.equal(f.swarm.metrics().bytes.fromPeers, f.bytes.length);
  } finally { await f.close(); }
});

test("multi-holder: a holder too slow for the deadline is abandoned early and its pieces move", async (t) => {
  // About 10 bytes/ms against 64 KiB pieces: hopeless long before the 3 s
  // deadline, which is where the transfer alone would otherwise rescue it.
  // Watch the core selection: a closed holder's late record must be forgotten.
  const selection = Object.getPrototypeOf((await loadCore(multiCore)).peerSelection());
  const calls = [];
  for (const name of ["record", "forget"]) {
    const original = selection[name];
    t.mock.method(selection, name, function (link, ...rest) { calls.push([name, link]); return original.call(this, link, ...rest); });
  }
  const f = await multiFixture(t, { holders: [{}, { trickleMs: 50 }], size: 12 * 65_536, originFallbackMs: 3_000 });
  try {
    const started = performance.now();
    sameBytes(await f.load(), f.bytes);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1_500, `finished early, not at the deadline (${Math.round(elapsed)} ms)`);
    const { multiHolder } = f.swarm.metrics().core;
    assert.equal(multiHolder.abandoned, 1);
    // A reliable channel is asked to cancel; this fixture's channel is not,
    // so the link closes, as for an abandoned single-holder request.
    assert.ok(f.channels[1].cancels === 1 || f.channels[1].readyState === "closed", "the slow holder's request was stopped");
    assert.equal(f.channels[1].wants.length, 1, "and it was given no more work");
    assert.equal(multiHolder.peerBytes + multiHolder.originBytes, f.bytes.length);
    await until(() => calls.some(([name, link]) => name === "record" && link.closed));
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.counters.abandoned, 1, "only the hopeless holder");
    for (const link of new Set(calls.filter(([, link]) => link.closed).map(([, link]) => link))) {
      assert.equal(calls.findLast(([, seen]) => seen === link)[0], "forget", "a closed link ends forgotten");
    }
  } finally { await f.close(); }
});

test("multi-holder: origin ranges go through the player's loader with its config", async (t) => {
  const observed = [];
  const f = await multiFixture(t, { holders: [{ silent: true }], size: 12 * 65_536, originFallbackMs: 400, onPeerDelivery: value => observed.push(value) });
  try {
    sameBytes(await f.load(), f.bytes);
    assert.ok(f.rangeLoaders.length > 0);
    for (const { config, loaderConfig, context } of f.rangeLoaders) {
      assert.equal(config, f.hlsConfig, "the hls.js config, with its xhrSetup");
      assert.equal(loaderConfig, f.loaderConfig, "the fragment's own load policy");
      assert.equal(context.url, multiContext.url);
      assert.equal(context.frag, multiContext.frag);
    }
    assert.equal(multiContext.rangeEnd, undefined, "the player's context is not changed");
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.deepEqual(observed, [], "an all-origin transfer has no peer contribution");
    assert.equal(f.swarm.metrics().segments.firstPeerSegmentAtMs, null);
    assert.equal(f.swarm.metrics().segments.peerLatencyMedianMs, null);
    assert.equal(f.swarm.metrics().neighbourDiscovery.counters.verified, 0);
  } finally { await f.close(); }
});

test("multi-holder: a loader that ignores ranges sends the segment to the whole origin load, and later segments skip ranges", async (t) => {
  // This verifies routing, not host crypto throughput within 400 ms of wall
  // time. Keep the same policy clock while real signatures/bytes still verify.
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ silent: true }], size: 12 * 65_536, originFallbackMs: 400, ignoreRanges: true }));
    // A second framing 2 holder, connected now but holding nothing yet.
    const fresh = await clock.settle(f.addPeer(new RangedChannel(f.bytes)));
    const peer = f.peers.at(-1), key = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");
    sameBytes(await clock.settle(f.load()), new Uint8Array(32).fill(9), "the whole-segment origin bytes");
    assert.equal(f.swarm.metrics().core.multiHolder.delivered, 0);
    assert.equal(f.swarm.metrics().core.multiHolder.originRangesIgnored, 1);
    assert.deepEqual(fresh.wants, [], "the second holder had nothing to give");
    // That origin is now known to ignore ranges. The second holder would
    // start a transfer; instead the segment takes the single-holder path and
    // comes whole from it, with no range from origin.
    const { transfers, originRanges } = f.swarm.metrics().core.multiHolder;
    fresh.receive(JSON.stringify({ t: "have", keys: [key] }));
    peer.announcePresence({ role: "viewer", open: true, have: [key], transports: [{ type: "webrtc", publicKey: peer.pubkey, obj: 2 }] });
    await clock.advance(50);
    sameBytes(await clock.settle(f.load()), f.bytes, "the second holder's bytes");
    const after = f.swarm.metrics().core.multiHolder;
    assert.equal(after.transfers, transfers, "no second transfer");
    assert.equal(after.originRanges, originRanges, "no second ranged origin load");
    assert.deepEqual(fresh.wants, [null], "one whole-object request");
    assert.equal(after.originRangesIgnored, 1);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('multi-holder: slow authority after an ignored range keeps the original 400 ms fallback and never asks the new holder', async t => {
  const clock = virtualClock(t); let f, checks = 0;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ silent: true }], size: 12 * 65_536, originFallbackMs: 400,
      ignoreRanges: true, beforeCommitment: async () => { if (++checks === 2) await sleep(450); } }));
    const fresh = await clock.settle(f.addPeer(new RangedChannel(f.bytes))), peer = f.peers.at(-1);
    sameBytes(await clock.settle(f.load()), new Uint8Array(32).fill(9));
    const before = f.swarm.metrics().core.multiHolder;
    fresh.receive(JSON.stringify({ t: 'have', keys: [f.key] }));
    peer.announcePresence({ role: 'viewer', open: true, have: [f.key], transports: [{ type: 'webrtc', publicKey: peer.pubkey, obj: 2 }] });
    await clock.advance(50);
    const began = clock.now();
    sameBytes(await clock.settle(f.load()), new Uint8Array(32).fill(9), 'ordinary source recovery remains correct when authority misses the deadline');
    assert(clock.now() - began >= 400 && clock.now() - began < 410);
    await clock.advance(100);
    assert.equal(checks, 2); assert.deepEqual(fresh.wants, []);
    const after = f.swarm.metrics();
    assert.equal(after.segments.commitmentUnavailable, 1); assert.equal(after.bytes.peerFirst, 0);
    assert.equal(after.core.multiHolder.transfers, before.transfers);
    assert.equal(after.core.multiHolder.originRanges, before.originRanges);
    assert.equal(after.core.multiHolder.originRangesIgnored, 1);
    assert.equal(after.peerEligibilityDiagnostics.records.at(-1).budgetMs, 400);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('origin trace: synchronous cached HTTP winner has an early numeric alias and one terminal', async t => {
  const f = await multiFixture(t, { holders: [{}], traceRequests: 256,
    swarmOptions: { zeroBudgetPeerRace: true } });
  f.hls.media = { currentTime: 0, buffered: { length: 0 } };
  try {
    const result = await f.load(); assert.equal(result.length, 32);
    const rows=f.swarm.trace().rows, start=rows.find(row=>row.k==='originStart'), terminal=rows.filter(row=>row.k==='origin');
    assert.ok(start && Number.isSafeInteger(start.load), 'HTTP start must have its alias even when inner.load completes synchronously');
    assert.equal(start.leg,'cached');assert.equal(terminal.length,1);assert.equal(terminal[0].load,start.load);assert.equal(terminal[0].outcome,'payload');
    assert.equal(rows.findIndex(row=>row.k==='load')<rows.findIndex(row=>row.k==='originStart'),true);
  } finally { await f.close(); }
});

test('origin trace: immediate fallback captures per-load aliases despite context reuse and late callbacks', async t => {
  const pending=[];class Held extends Loader { load(ctx,config,callbacks){pending.push({ctx,callbacks,stats:this.stats})} }
  const f=await linkedFixture({...peerPlaybackOptions().options,traceRequests:256,WebSocketImpl:memoryRelaySocket()},Held,
    {media:{currentTime:0,buffered:{length:0}}});
  try {
    const ctx={...context,frag:{...context.frag}},loader=new f.hls.config.fLoader({}),calls={success:0,error:0,timeout:0};
    const callbacks={onSuccess:()=>calls.success++,onError:()=>calls.error++,onTimeout:()=>calls.timeout++};
    loader.load(ctx,{},callbacks);loader.load(ctx,{},callbacks);
    assert.equal(pending.length,2);
    pending[0].callbacks.onError({code:500},ctx,null);pending[0].callbacks.onTimeout(pending[0].stats,ctx,null);
    pending[1].callbacks.onSuccess({data:new ArrayBuffer(7)},pending[1].stats,ctx,null);
    const rows=f.swarm.trace().rows,starts=rows.filter(row=>row.k==='originStart'),terms=rows.filter(row=>row.k==='origin');
    assert.equal(starts.length,2);assert.notEqual(starts[0].load,starts[1].load);
    assert.deepEqual(terms.map(row=>[row.load,row.outcome]),[[starts[0].load,'error'],[starts[1].load,'payload']]);
    assert.equal(rows.filter(row=>row.k==='originCallback').length,1,'duplicate terminal is distinct from observed terminal schema');
    assert.equal(terms[0].stale,true);assert.equal(terms[0].loaderLoadedBytes,null);assert.equal(terms[0].loaderTotalBytes,null);
    assert.deepEqual(calls,{success:1,error:1,timeout:1},'diagnostics preserve the original fallback callback contract');
  } finally { await f.close(); }
});

test('origin trace: late copied peer context joins the original HTTP alias', async t => {
  const f=await directLateFixture(t,{swarmOptions:{traceRequests:4096}});await f.add();
  const result=await f.outcome;assert.equal(result.kind,'success');
  const rows=f.swarm.trace().rows,start=rows.find(row=>row.k==='originStart');
  assert.ok(start && Number.isSafeInteger(start.load));
  assert.ok(rows.some(row=>row.k==='request'),'actual verified peer work was recorded');
  assert.ok(rows.filter(row=>['request','xfer'].includes(row.k)).every(row=>row.load===start.load),'copied late context retains original numeric alias');
  assert.equal(rows.filter(row=>row.k==='originAbortRequest').length,1);
});

test('origin trace: peer winner snapshots partial HTTP stats before abort and shared stats reuse without fabricating a terminal', async t => {
  for(const path of ['cached','late']) await t.test(path,async t=>{
    const f=await multiFixture(t,{holders:path==='cached'?[{}]:[],holdWholeOrigin:true,traceRequests:4096,
      swarmOptions:{zeroBudgetPeerRace:true,sustainablePeerWait:true,latePeerRace:path==='late'}});
    f.hls.media=Object.assign(new EventTarget(),{currentTime:0,paused:false,ended:false,buffered:{length:0}});
    try {
      const pending=beginCountedMultiLoad(f),whole=f.wholeLoads[0];
      Object.assign(whole.loader.stats,{loaded:31,total:1000});
      whole.loader.abort=()=>{whole.loader.aborted=true;whole.loader.stats.loaded=777;};
      if(path==='late'){
        const channel=await f.addPeer(new RangedChannel(f.bytes));
        f.peers.at(-1).announcePresence({role:'viewer',open:true,have:[f.key],transports:[{type:'webrtc',publicKey:f.peers.at(-1).pubkey,obj:2}]});
        await until(()=>f.swarm.metrics().peers.openPeersKnown===1);channel.receive(JSON.stringify({t:'have',keys:[f.key]}));
      }
      sameBytes(await pending.response,f.bytes);
      const rows=f.swarm.trace().rows,abort=rows.filter(row=>row.k==='originAbortRequest');
      assert.equal(abort.length,1);assert.equal(abort[0].reason,'peer-won');
      assert.deepEqual([abort[0].loaderLoadedBytes,abort[0].loaderTotalBytes],[31,1000]);
      assert.equal(whole.loader.stats.loaded,f.bytes.length,'the original shared stats have since become accepted peer stats');
      assert.equal(rows.some(row=>row.k==='origin'),false,'abort request alone is not an observed HTTP terminal');
      let staleStatReads=0;for(const key of ['loaded','total'])Object.defineProperty(whole.loader.stats,key,{configurable:true,get(){staleStatReads++;return f.bytes.length}});
      whole.callbacks.onProgress(whole.loader.stats,whole.context,{get byteLength(){throw new Error('private-body-secret')}},null);
      whole.callbacks.onProgress(whole.loader.stats,whole.context,new ArrayBuffer(1),null);
      whole.callbacks.onAbort(whole.loader.stats,whole.context,null);
      let staleBodyReads=0;whole.callbacks.onSuccess({get data(){staleBodyReads++;throw new Error('private-response-secret')}},whole.loader.stats,whole.context,null);
      assert.equal(staleBodyReads,0,'stale success observations do not inspect ignored response bodies');
      assert.equal(staleStatReads,0,'stale progress and terminal observations never read shared peer statistics');
      assert.equal(f.swarm.trace().rows.some(row=>row.k==='originProgress'),false,'ignored progress has no observed positive payload');
      assert.equal(f.swarm.trace().rows.find(row=>row.k==='originCallback').phase,'progress');
      whole.callbacks.onError({code:500},whole.context,null);whole.callbacks.onTimeout(whole.loader.stats,whole.context,null);
      const after=f.swarm.trace().rows;assert.equal(after.filter(row=>row.k==='origin').length,1);
      assert.equal(after.find(row=>row.k==='origin').outcome,'abort');assert.equal(after.find(row=>row.k==='origin').stale,true);
      assert.deepEqual([after.find(row=>row.k==='origin').loaderLoadedBytes,after.find(row=>row.k==='origin').loaderTotalBytes],[null,null],
        'late abort callbacks cannot re-credit mutated peer statistics as HTTP');
      assert.equal(after.filter(row=>row.k==='originCallback').length,1,'duplicate late callbacks have one bounded separate observation');
      assert.deepEqual([pending.calls.success.length,pending.calls.abort.length,pending.calls.error.length],[1,0,0]);
    } finally {await f.close()}
  });
});

test('origin trace: actual error timeout and abort callbacks retain one terminal per HTTP leg', async t => {
  for(const path of ['fallback','cached','late'])for(const outcome of ['error','timeout','abort'])await t.test(path+' '+outcome,async t=>{
    const f=await multiFixture(t,{holders:path==='cached'?[{}]:[],holdWholeOrigin:true,traceRequests:256,
      swarmOptions:{zeroBudgetPeerRace:path!=='fallback',latePeerRace:path==='late'}});
    f.hls.media={currentTime:0,buffered:{length:0}};
    try {
      const calls={error:0,timeout:0,abort:0};new f.hls.config.fLoader(f.hlsConfig).load(multiContext,f.loaderConfig,{
        onError:()=>calls.error++,onTimeout:()=>calls.timeout++,onAbort:()=>calls.abort++});
      const whole=f.wholeLoads[0];Object.assign(whole.loader.stats,{loaded:11,total:99});
      const method={error:'onError',timeout:'onTimeout',abort:'onAbort'}[outcome];
      whole.callbacks[method](outcome==='error'?{code:500}:whole.loader.stats,whole.context,null);
      const rows=f.swarm.trace().rows,terminals=rows.filter(row=>row.k==='origin');
      assert.equal(terminals.length,1);assert.equal(terminals[0].outcome,outcome);assert.equal(calls[outcome],1);
      assert.deepEqual([terminals[0].loaderLoadedBytes,terminals[0].loaderTotalBytes],[11,99]);
      assert.equal(terminals[0].load,rows.find(row=>row.k==='originStart').load);
    } finally {await f.close()}
  });
});

test('origin trace: only the first positive callback progress is sampled and invalid stats stay unknown', async t=>{
  const f=await multiFixture(t,{holders:[{}],holdWholeOrigin:true,traceRequests:256,swarmOptions:{zeroBudgetPeerRace:true}});
  f.hls.media={currentTime:0,buffered:{length:0}};
  try {
    const pending=beginCountedMultiLoad(f),whole=f.wholeLoads[0],stats=whole.loader.stats;
    whole.callbacks.onProgress(stats,whole.context,new ArrayBuffer(0),null);
    Object.assign(stats,{loaded:12,total:99});whole.callbacks.onProgress(stats,whole.context,new ArrayBuffer(3),null);
    Object.assign(stats,{loaded:40,total:99});whole.callbacks.onProgress(stats,whole.context,new ArrayBuffer(8),null);
    Object.defineProperty(stats,'loaded',{get(){throw new Error('private-stat-secret')}});stats.total=Infinity;
    whole.callbacks.onError({code:500},whole.context,null);
    const rows=f.swarm.trace().rows,progress=rows.filter(row=>row.k==='originProgress'),terminal=rows.find(row=>row.k==='origin');
    assert.equal(progress.length,1);assert.equal(progress[0].loaderLoadedBytes,12);assert.equal(progress[0].loaderTotalBytes,99);
    assert.equal(terminal.loaderLoadedBytes,null);assert.equal(terminal.loaderTotalBytes,null);assert.equal(pending.calls.progress.length,3);
    assert.equal(JSON.stringify(rows).includes('private-stat-secret'),false);
  } finally {await f.close()}
});

test('origin trace: a stateful progress payload getter cannot change the existing HTTP ownership decision', async t=>{
  for(const path of ['cached','late'])for(const traceRequests of [0,256])await t.test(path+' trace='+traceRequests,async t=>{
    let metadataSignal,releaseMetadata;
    const f=await multiFixture(t,{holders:path==='cached'?[{}]:[],holdWholeOrigin:true,traceRequests,
      beforeCommitment:(_context,{signal})=>{metadataSignal=signal;return new Promise(resolve=>{releaseMetadata=resolve})},
      swarmOptions:{zeroBudgetPeerRace:true,latePeerRace:path==='late'}});
    f.hls.media=Object.assign(new EventTarget(),{currentTime:0,paused:false,ended:false,buffered:{length:0}});
    try {
      const pending=beginCountedMultiLoad(f),whole=f.wholeLoads[0];
      if(path==='late'){
        const channel=await f.addPeer(new RangedChannel(f.bytes));
        f.peers.at(-1).announcePresence({role:'viewer',open:true,have:[f.key],transports:[{type:'webrtc',publicKey:f.peers.at(-1).pubkey,obj:2}]});
        await until(()=>f.swarm.metrics().peers.openPeersKnown===1);channel.receive(JSON.stringify({t:'have',keys:[f.key]}));
      }
      await until(()=>metadataSignal);let reads=0;
      whole.callbacks.onProgress(whole.loader.stats,whole.context,{get byteLength(){return ++reads===1?1:0}},null);
      assert.equal(metadataSignal.aborted,true,'a positive HTTP progress callback must retain the original HTTP winner with tracing on or off');
      assert.equal(reads,1,'only the existing policy may inspect the payload getter');
      whole.callbacks.onSuccess({data:f.bytes.slice().buffer},whole.loader.stats,whole.context,null);
      sameBytes(await pending.response,f.bytes);assert.equal(f.swarm.metrics().bytes.peerFirst,0);
    } finally {releaseMetadata?.();await f.close()}
  });
});

test('origin trace: held key completion retains its original eligibility alias after context reuse',async t=>{
  const f=await multiFixture(t,{holders:[{}],traceRequests:256});let releaseKey,held=false;
  const subtle=globalThis.crypto.subtle,digest=subtle.digest.bind(subtle),known=Buffer.from(`${base.swarmId}\n/media/seg.ts`);
  t.mock.method(subtle,'digest',(algorithm,input)=>{
    if(!held&&algorithm==='SHA-256'&&input instanceof Uint8Array&&Buffer.from(input).equals(known)){
      held=true;const bytes=createHash('sha256').update(input).digest();
      return new Promise(resolve=>{releaseKey=()=>resolve(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength))});
    }
    return digest(algorithm,input);
  });
  const ctx={...multiContext,frag:{...multiContext.frag}},loader=new f.hls.config.fLoader(f.hlsConfig);
  try {
    loader.load(ctx,f.loaderConfig,{onSuccess(){},onAbort(){}});await until(()=>releaseKey);
    loader.load(ctx,f.loaderConfig,{onSuccess(){},onAbort(){}});releaseKey();
    await until(()=>f.swarm.trace().rows.some(row=>row.k==='eligibility'&&row.reason==='aborted-before-eligibility'));
    const rows=f.swarm.trace().rows,loads=rows.filter(row=>row.k==='load'),retired=rows.find(row=>row.k==='eligibility'&&row.reason==='aborted-before-eligibility');
    assert.equal(loads.length,2);assert.notEqual(loads[0].load,loads[1].load);
    assert.equal(retired.load,loads[0].load,'retired async eligibility must never acquire the new load alias from a reused context');
  } finally {releaseKey?.();loader.abort();await f.close()}
});

test('origin trace: custom loader payload sizes cannot inject nonnumeric trace fields', async t=>{
  let value;class Custom extends Loader {load(ctx,config,callbacks){callbacks.onSuccess({data:{byteLength:value}},this.stats,ctx,null)}}
  const f=await linkedFixture({...peerPlaybackOptions().options,traceRequests:256,WebSocketImpl:memoryRelaySocket()},Custom,
    {media:{currentTime:0,buffered:{length:0}}});
  try {
    for(value of ['private-size-secret',-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1,7]){
      await new Promise(resolve=>new f.hls.config.fLoader({}).load(context,{}, {onSuccess:resolve}));
      assert.equal(f.swarm.trace().rows.filter(row=>row.k==='origin').at(-1).bytes,value===7?7:null);
    }
    assert.equal(JSON.stringify(f.swarm.trace()).includes('private-size-secret'),false);
  } finally {await f.close()}
});

test('origin trace: disabled tracing reads no additional loader byte getters or retains rows', async t=>{
  for(const path of ['fallback','cached','late'])await t.test(path,async t=>{
    const f=await multiFixture(t,{holders:path==='cached'?[{}]:[],holdWholeOrigin:true,
      swarmOptions:{zeroBudgetPeerRace:path!=='fallback',latePeerRace:path==='late'}});
    f.hls.media={currentTime:0,buffered:{length:0}};
    try {
      new f.hls.config.fLoader(f.hlsConfig).load(multiContext,f.loaderConfig,{onError(){}});
      const whole=f.wholeLoads[0];let reads=0;
      for(const key of ['loaded','total'])Object.defineProperty(whole.loader.stats,key,{configurable:true,get(){reads++;return 5}});
      whole.callbacks.onError({code:500},whole.context,null);
      assert.equal(reads,0);assert.deepEqual(f.swarm.trace(),{v:1,capacity:0,dropped:0,rows:[]});
    } finally {await f.close()}
  });
});

test("trace: off by default, bounded, and refused when invalid", async (t) => {
  const f = await multiFixture(t, { holders: [{}, {}] });
  try {
    await f.load();
    assert.deepEqual(f.swarm.trace(), { v: 1, capacity: 0, dropped: 0, rows: [] });
  } finally { await f.close(); }
  for (const traceRequests of [-1, 1.5, 32_769, "64"]) {
    const swarm = createHlsSwarm({ ...base, relays: ["wss://relay.example"], mode: "shadow", traceRequests });
    assert.equal(swarm.metrics().disabledReason, "invalid-trace", String(traceRequests));
    swarm.stop();
  }
  const small = await multiFixture(t, { holders: [{}, {}], traceRequests: 3 });
  try {
    await small.load();
    const trace = small.swarm.trace();
    assert.equal(trace.rows.length, 3);
    assert.ok(trace.dropped > 0);
  } finally { await small.close(); }
});

test("trace: a multi-holder transfer replays from its rows alone to the same commands", async (t) => {
  // A bad holder and a slow one, so the trace carries a ban, an abandonment,
  // progress, origin ranges and ticks.
  const f = await multiFixture(t, { holders: [{}, { corrupt: true }, { trickleMs: 50 }], size: 12 * 65_536, originFallbackMs: 1_500, traceRequests: 4_096 });
  let rows;
  try {
    sameBytes(await f.load(), f.bytes);
    rows = f.swarm.trace().rows;
  } finally { await f.close(); }
  const [load] = rows.filter((row) => row.k === "load");
  assert.ok(load && Number.isSafeInteger(load.sn) && load.limitMs > 0, JSON.stringify(load));
  const calls = rows.filter((row) => row.k === "xfer" && row.load === load.load);
  assert.ok(rows.some((row) => row.k === "request" && row.load === load.load && Array.isArray(row.range)), "request rows join the load");
  assert.ok(rows.some((row) => row.k === "origin" && row.ranged && row.load === load.load), "ranged origin rows join the load");
  const ops = new Set(calls.map((row) => row.op));
  for (const op of ["start", "delivered", "progress"]) assert.ok(ops.has(op), `the trace has ${op}: ${[...ops]}`);
  const commands = calls.flatMap((row) => row.out.c.map((command) => command.t));
  for (const t of ["ban", "abandon", "deliver"]) assert.ok(commands.includes(t), `the trace has ${t}: ${commands}`);

  // Replay: a synthetic object of the recorded size, its own digests, and
  // each recorded call at its recorded time. A delivery the recording
  // answered with a ban is replayed corrupt.
  const [start] = calls;
  assert.equal(start.op, "start");
  const object = Uint8Array.from({ length: start.size }, (_, i) => (i * 7 + 1) & 255);
  const pieces = [];
  for (let at = 0; at < start.size; at += start.pieceSize) pieces.push(createHash("sha256").update(object.subarray(at, at + start.pieceSize)).digest("hex"));
  assert.equal(pieces.length, start.pieces);
  const core = await loadCore(multiCore);
  const transfer = core.transfer({ size: start.size, sha256: createHash("sha256").update(object).digest("hex"), pieces,
    deadline: start.deadline, maxHolders: start.maxHolders, originReserveMs: start.originReserveMs,
    ...(start.peerOnly ? { peerOnly: true } : {}),
    ...(start.exclusiveOrigin === undefined ? {} : { exclusiveOrigin: start.exclusiveOrigin }) });
  const summary = (state) => ({ c: state.commands.map(({ t, peer, p }) => ({ t, ...(peer !== undefined ? { peer } : {}), ...(p ? { p } : {}) })),
    next: state.next, late: state.late, finished: state.finished });
  for (const row of calls) {
    let state;
    if (row.op === "start") state = transfer.start(row.at, { peers: row.peers, origin: row.origin, sharedFirstByteMs: row.sharedFirstByteMs, sharedRate: row.sharedRate, probePeers: row.probePeers });
    else if (row.op === "delivered") {
      const range = { start: row.p[0], end: row.p[1] };
      const bytes = object.slice(range.start * start.pieceSize, Math.min(range.end * start.pieceSize, start.size));
      assert.equal(bytes.byteLength, row.bytes);
      if (row.out.c.some((command) => command.t === "ban" && command.peer === row.source)) bytes[0] ^= 0xff;
      state = transfer.delivered(row.at, row.source, range, bytes);
    } else if (row.op === "failed") state = transfer.failed(row.at, row.source);
    else if (row.op === "progress") state = transfer.progress(row.at, row.source, row.received);
    else if (row.op === "tick") state = transfer.tick(row.at);
    else assert.fail(`unknown op ${row.op}`);
    assert.deepEqual(summary(state), row.out, `${row.op} at ${row.at}`);
  }
  assert.ok(calls.at(-1).out.c.some((command) => command.t === "deliver"));
  transfer.free();
});

test("multi-holder: without the option a schema 3 segment comes whole from one holder", async (t) => {
  const f = await multiFixture(t, { holders: [{}, {}], multiHolder: false });
  try {
    assert.equal(f.swarm.metrics().core.multiHolder.enabled, false);
    sameBytes(await f.load(), f.bytes);
    const wants = f.channels.flatMap((channel) => channel.wants);
    assert.deepEqual(wants, [null]);
  } finally { await f.close(); }
});

test("multi-holder: framing 1 holders keep the whole-object path", async (t) => {
  const f = await multiFixture(t, { holders: [{}, {}], framing: 1 });
  try {
    sameBytes(await f.load(), f.bytes);
    assert.deepEqual(f.channels.flatMap((channel) => channel.wants), [null]);
    assert.equal(f.swarm.metrics().core.multiHolder.transfers, 0);
  } finally { await f.close(); }
});

test("multi-holder: a ranged serve sends and charges only the requested pieces", async () => {
  const object = Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7 + 1) & 255);
  class BigLoader extends Loader { load(ctx, _config, callbacks) { callbacks.onSuccess({ data: object.slice().buffer }, this.stats, ctx, null); } }
  const reserved = [], playback = peerPlaybackOptions(300);
  const f = await linkedFixture({ ...playback.options, serve: true, coreWasm: multiCore, multiHolder: true, WebSocketImpl: memoryRelaySocket(),
    reserveUploadBytes: (bytes) => { reserved.push(bytes); return true; } }, BigLoader);
  try {
    await until(() => f.swarm.metrics().core.state === "ready");
    const channel = await f.addPeer();
    await f.load(); await until(() => f.swarm.metrics().bytes.held === object.length);
    channel.receive(JSON.stringify({ t: "want", id: 7, k: playback.key, p: [1, 3] }));
    await until(() => channel.sent.some((frame) => frame.t === "eof" && frame.id === 7));
    assert.deepEqual(channel.sent.find((frame) => frame.t === "meta"), { t: "meta", id: 7, size: 131_072, p: [1, 3] });
    const body = Buffer.concat(channel.sent.filter((frame) => frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)).map((chunk) => Buffer.from(chunk)));
    sameBytes(body, object.subarray(65_536, 196_608));
    assert.deepEqual(reserved, [131_072]);
    assert.equal(f.swarm.metrics().bytes.uploaded, 131_072);
  } finally { await f.close(); }
});

async function pacedUploadFixture(t, options = {}) {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const object = new Uint8Array(6 * 1024 * 1024).fill(23), playback = peerPlaybackOptions(300);
  class BigLoader extends Loader { load(ctx, _config, cb) { cb.onSuccess({ data: object.slice().buffer }, this.stats, ctx, null); } }
  const f = await linkedFixture({ ...playback.options, serve: true, coreWasm: multiCore, multiHolder: true,
    uploadPacing: true, maxUploadBytesPerSecond: 4 * 1024 * 1024, WebSocketImpl: memoryRelaySocket(), ...options }, BigLoader);
  t.after(() => f.close());
  await until(() => f.swarm.metrics().core.state === 'ready');
  const first = await f.addPeer(), second = await f.addPeer();
  await f.load(); await until(() => f.swarm.metrics().bytes.held === object.length);
  const piece = commitmentPieceSize(object.length), request = (channel, id, end = 4) => channel.receive(JSON.stringify({ t: 'want', id, k: playback.key, p: [0, end] }));
  request(first, 1, 42);
  await until(() => first.sent.some(frame => frame.t === 'eof' && frame.id === 1));
  return { ...f, first, second, piece, request, setClock: at => { clock = at; } };
}

test('upload pacing: two real Core links refill canonical pieces fairly without raising the rate cap', async t => {
  const f = await pacedUploadFixture(t);
  f.request(f.first, 2); f.request(f.second, 3);
  await sleep(20);
  assert(!f.first.sent.some(frame => frame.t === 'none' && frame.id === 2), 'pacing must not turn a temporary refill deficit into NONE');
  assert.equal(f.swarm.metrics().uploadPacing.queued, 2);
  f.setClock(100); await until(() => f.first.sent.some(frame => frame.t === 'eof' && frame.id === 2));
  assert(!f.second.sent.some(frame => frame.t === 'eof' && frame.id === 3));
  f.setClock(200); await until(() => f.second.sent.some(frame => frame.t === 'eof' && frame.id === 3));
  const m = f.swarm.metrics();
  assert.equal(m.bytes.uploaded, 50 * f.piece);
  assert(m.bytes.uploaded <= 4 * 1024 * 1024 * 1.2, 'initial capacity plus actual refill bounds submitted media');
  assert.equal(m.uploadPacing.waited, 2); assert.equal(m.uploadPacing.waitTotalMs, 300); assert.equal(m.uploadPacing.waitMaxMs, 200);
  assert.equal(m.uploadPacing.queued, 0); assert.equal(m.uploadPacing.reservedBytes, 0);
  assert.equal(m.bytes.peerFirst, 0);
});

test('upload pacing: the default-off provider retains immediate rate refusal', async t => {
  const f = await pacedUploadFixture(t, { uploadPacing: false });
  f.request(f.first, 2);
  await until(() => f.first.sent.some(frame => frame.t === 'none' && frame.id === 2));
  assert.equal(f.swarm.metrics().uploadPacing, null);
  assert.equal(f.swarm.metrics().bytes.uploaded, 42 * f.piece);
});

test('upload pacing: real Core CANCEL during refill suppresses payload and refunds only unsent rate', async t => {
  const f = await pacedUploadFixture(t, { maxUploadBytesPerSession: 46 * 98_304 });
  const before = f.first.sent.length;
  f.request(f.first, 2); await until(() => f.swarm.metrics().uploadPacing.queued === 1);
  f.first.receive(JSON.stringify({ t: 'cancel', id: 2 }));
  f.setClock(100);
  await until(() => f.first.sent.some(frame => frame.t === 'none' && frame.id === 2));
  assert(!f.first.sent.slice(before).some(frame => frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)));
  const m = f.swarm.metrics();
  assert.equal(m.bytes.uploadCancelledBytes, 4 * f.piece);
  assert.equal(m.bytes.uploadRemaining, 0, 'accepted session billing stays charged despite remote cancellation');
  assert.equal(m.uploadPacing.reservedBytes, 0);
});

for (const ending of ['stop', 'close', 'revoke']) test(`upload pacing: local ${ending} cancels refill without a late payload`, async t => {
  let allowed = true;
  const f = await pacedUploadFixture(t, ending === 'revoke' ? { admit: () => allowed, ticket: 'fixture-owner' } : {});
  const before = f.first.sent.length;
  f.request(f.first, 2); await until(() => f.swarm.metrics().uploadPacing.queued === 1);
  if (ending === 'stop') f.swarm.stop();
  else if (ending === 'close') f.first.close();
  else allowed = false;
  f.setClock(ending === 'revoke' ? 100 : 500); await sleep(120);
  assert(!f.first.sent.slice(before).some(frame => frame instanceof ArrayBuffer || ArrayBuffer.isView(frame)));
  assert.equal(f.swarm.metrics().uploadPacing.queued, 0);
  assert.equal(f.swarm.metrics().uploadPacing.reservedBytes, 0);
  assert.equal(f.swarm.metrics().bytes.uploaded, 42 * f.piece);
});

for (const ending of ['last-allowance', 'evicted', 'cancel']) test(`upload pacing: ${ending} across a real JS host reservation preserves lookup and billing ownership`, async t => {
  let settle;
  const f = await linkedFixture({ serve: true, uploadPacing: true, maxHeldSegments: 1,
    maxUploadBytesPerSession: ending === 'last-allowance' ? 32 : 64,
    WebSocketImpl: memoryRelaySocket(), reserveUploadBytes: () => new Promise(resolve => { settle = resolve; }) });
  t.after(() => f.close());
  const channel = await f.addPeer(); await f.load(); await until(() => f.swarm.metrics().bytes.held === 32);
  const key = channel.sent.find(frame => frame.t === 'have' && frame.add?.length).add[0];
  channel.receive(JSON.stringify({ t: 'want', id: 1, k: key })); await until(() => settle);
  if (ending === 'evicted') {
    await new Promise(resolve => new f.hls.config.fLoader({}).load({ ...context, url: 'https://origin.example/replacement.ts' }, {}, { onSuccess: resolve }));
    await until(() => channel.sent.some(frame => frame.t === 'have' && frame.del?.includes(key)));
  }
  if (ending === 'cancel') channel.receive(JSON.stringify({ t: 'cancel', id: 1 }));
  settle(true);
  await until(() => channel.sent.some(frame => (frame.t === 'eof' || frame.t === 'none') && frame.id === 1));
  const m = f.swarm.metrics(), binary = channel.sent.filter(frame => frame instanceof ArrayBuffer || ArrayBuffer.isView(frame));
  assert.equal(m.uploadPacing.reservedBytes, 0);
  if (ending === 'last-allowance') { assert.equal(m.bytes.uploaded, 32); assert.equal(m.bytes.held, 0); assert(binary.length); }
  else assert.equal(binary.length, 0);
  if (ending === 'evicted') assert.equal(m.bytes.uploaded, 0);
  if (ending === 'cancel') assert.equal(m.bytes.uploadCancelledBytes, 32);
  assert.equal(m.bytes.uploadRemaining, ending === 'last-allowance' ? 0 : 32);
});

test('upload pacing: explicit host refusal releases only its own session and rate reservation', async t => {
  t.mock.method(performance, 'now', () => 0);
  let calls = 0, settle;
  const f = await linkedFixture({ serve: true, uploadPacing: true, maxUploadBytesPerSession: 64, maxUploadBytesPerSecond: 32,
    WebSocketImpl: memoryRelaySocket(), reserveUploadBytes: () => { calls++; return new Promise(resolve => { settle = resolve; }); } });
  t.after(() => f.close());
  const channel = await f.addPeer(); await f.load(); await until(() => f.swarm.metrics().bytes.held === 32);
  const key = channel.sent.find(frame => frame.t === 'have' && frame.add?.length).add[0];
  for (const id of [1, 2]) {
    channel.receive(JSON.stringify({ t: 'want', id, k: key })); await until(() => calls === id);
    assert.equal(f.swarm.metrics().bytes.uploadRemaining, 32);
    settle(false); await until(() => channel.sent.some(frame => frame.t === 'none' && frame.id === id));
    assert.equal(f.swarm.metrics().bytes.uploadRemaining, 64);
  }
  assert.equal(f.swarm.metrics().bytes.uploaded, 0);
  assert.equal(f.swarm.metrics().uploadPacing.reservedBytes, 0);
});


test("peerSupplyHint reports known HAVE supply only when enabled and never sets a player level", async (t) => {
  for (const enabled of [false, true]) {
    const reported = [];
    let holdCommitment = false, releaseCommitment;
    let commitmentGate = new Promise((resolve) => { releaseCommitment = resolve; });
    const f = await multiFixture(t, { holders: [{}], size: 65_536, originDelayMs: 100, peerSupplyHint: enabled,
      onPlayerHint: (rows) => reported.push(rows), traceRequests: 100,
      beforeCommitment: () => holdCommitment ? commitmentGate : undefined });
    try {
      const other = { ...multiContext.frag, level: 1, url: "https://origin.example/high/seg.ts", baseurl: "https://origin.example/high/index.m3u8" };
      f.hls.levels = [{ details: { fragments: [multiContext.frag] } }, { details: { fragments: [other] } }];
      for (const name of ["currentLevel", "nextLevel", "loadLevel", "nextLoadLevel"]) Object.defineProperty(f.hls, name, { set() { assert.fail(`hint forced ${name}`); } });
      sameBytes(await f.load(), f.bytes);
      // Hint collection and the next request both resolve the segment key.
      // Keep the holder idle until its known-size hint has been observed;
      // a request that wins that race correctly makes the holder ineligible.
      holdCommitment = enabled;
      const secondLoad = f.load();
      if (enabled) await until(() => reported.some((rows) => rows[0].projectedMs !== null));
      releaseCommitment();
      sameBytes(await secondLoad, f.bytes);
      if (enabled) {
        const rows = reported.findLast((rows) => rows[0].projectedMs !== null);
        assert.equal(rows.length, 2);
        assert.equal(rows[0].sizeEstimate, f.bytes.length);
        assert.equal(rows[0].eligibleHolders, 1);
        assert.ok(rows[0].projectedMs > 0);
        assert.equal(rows[1].eligibleHolders, 0);
        assert.equal(rows[1].projectedMs, null, "an unmeasured rendition has no invented finish");
        assert.equal(f.swarm.metrics().neighbourDiscovery.contexts, 1, "no target-rendition discovery");
        assert.ok(f.swarm.trace().rows.some((row) => row.k === "playerHint"));
        const highKey = createHash("sha256").update(`${base.swarmId}\n/high/seg.ts`).digest("hex");
        const before = reported.length;
        other.duration = 2; f.hls.levels[1].bitrate = 262_144;
        f.channels[0].receive(JSON.stringify({ t: "have", keys: [createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex"), highKey] }));
        commitmentGate = new Promise((resolve) => { releaseCommitment = resolve; });
        const highHintLoad = f.load();
        await until(() => reported.length > before);
        releaseCommitment();
        sameBytes(await highHintLoad, f.bytes);
        assert.equal(reported.at(-1)[1].eligibleHolders, 1, "other rendition supply comes from HAVE alone");
        assert.equal(reported.at(-1)[1].sizeEstimateSource, "playlist-bitrate");
        assert.equal(reported.at(-1)[1].sizeEstimate, 65_536);
        assert.ok(reported.at(-1)[1].projectedMs > 0);
        assert.equal(f.swarm.metrics().neighbourDiscovery.contexts, 1);
      } else {
        assert.equal(Object.hasOwn(f.swarm.metrics(), "playerHint"), false);
        assert.deepEqual(reported, []);
        assert.equal(f.swarm.trace().rows.some((row) => row.k === "playerHint"), false);
      }
    } finally { releaseCommitment(); await f.close(); }
  }
});

test("untested-holder trial and rotation-tier diagnostics start at zero and stay out of the operator report", async () => {
  const swarm = createHlsSwarm({ ...base, relays: ["wss://memory-relay.example"] });
  const metrics = swarm.metrics();
  assert.equal(metrics.segments.peerUntestedTrial, 0); assert.equal(metrics.segments.peerUntestedTrialLoaded, 0);
  assert.equal(metrics.peers.evictedUnhelpful, 0); assert.equal(metrics.peers.evictedServing, 0); assert.equal(metrics.peers.evictedConsumer, 0);
  for (const name of ["victimUnhelpful", "victimServing", "victimConsumer", "unmetNoHint", "unmetIneligible"]) {
    assert.equal(metrics.neighbourDiscovery.counters[name], 0, name);
  }
  assert.ok(metrics.peerEligibilityDiagnostics.records.every(row => !("trial" in row)));
  // Local diagnostics only: the numeric operator report builder never names them.
  const source = await readFile(new URL("../demo/client.mjs", import.meta.url), "utf8");
  for (const name of ["peerUntestedTrial", "evictedUnhelpful", "evictedServing", "evictedConsumer", "victim", "unmet"]) assert.ok(!source.includes(name), name);
  swarm.stop();
});

test("an unmet current context with no hinting candidate counts unmetNoHint and choose returns null", () => {
  const f = advisoryFixture(), { state } = f;
  state.candidates.clear(); state.hint(f.pubkey, ["c".repeat(64)], "fixture-ticket");
  assert.equal(state.choose(() => true, () => true, true), null);
  assert.deepEqual([state.counters.unmetNoHint, state.counters.unmetIneligible], [1, 0]);
  // Once per call, however many contexts reach the search.
  state.demand("audio", "audio:0", "d".repeat(64));
  assert.equal(state.choose(() => true, () => true, true), null);
  assert.deepEqual([state.counters.unmetNoHint, state.counters.unmetIneligible], [2, 0]);
  // A candidate seen over sixty seconds ago is not fresh, so it is no hint.
  state.candidates.clear(); state.hint(f.pubkey, [f.key], "fixture-ticket"); f.advance(60_000);
  state.demand("main", "main:0", f.key); state.demand("audio", "audio:0", "d".repeat(64));
  assert.equal(state.choose(() => true, () => true, true), null);
  assert.deepEqual([state.counters.unmetNoHint, state.counters.unmetIneligible], [3, 0]);
});

test("an unmet current context whose hinting candidates are all ineligible counts unmetIneligible and choose returns null", () => {
  const f = advisoryFixture(), { state } = f;
  assert.equal(state.choose(() => false, () => true, true), null);
  assert.deepEqual([state.counters.unmetNoHint, state.counters.unmetIneligible], [0, 1]);
  state.demand("audio", "audio:0", f.key);
  assert.equal(state.choose(() => false, () => true, true), null);
  assert.deepEqual([state.counters.unmetNoHint, state.counters.unmetIneligible], [0, 2], "once per call");
});

test("neither unmet counter moves when the context is met or choose returns a candidate", () => {
  const f = advisoryFixture(), { state } = f;
  assert.equal(state.choose(() => true, () => false, true), null, "a met context");
  assert.equal(state.choose(() => true, () => true, false)?.candidate.pubkey, f.pubkey, "a candidate is returned");
  f.advance(30_001);
  assert.equal(state.choose(() => true, () => true, true), null, "a context that is no longer current");
  const idle = advisoryFixture();
  assert.ok(idle.begin());
  assert.equal(idle.state.choose(() => true, () => true, true), null, "an attempt is already in flight");
  for (const value of [state, idle.state]) assert.deepEqual([value.counters.unmetNoHint, value.counters.unmetIneligible], [0, 0]);
});

// A holder that sends its segment in 16 KiB chunks `gapMs` apart and goes quiet after `stallAfter` of them.
// A tested link that stalls leaves only partial-flow rate evidence behind, as in the field failure.
class ChunkedHolder extends HolderChannel {
  gapMs = 0; stallAfter = Infinity; started = new Set();
  send(data) {
    const frame = typeof data === "string" ? JSON.parse(data) : null;
    // After metadata a holder ends a cancelled response with eof, never `none`.
    if (frame?.t === "cancel" && this.started.has(frame.id)) {
      RecordedChannel.prototype.send.call(this, data);
      return void setTimeout(() => { if (this.readyState === "open") this.receive(JSON.stringify({ t: "eof", id: frame.id })); }, 1);
    }
    if (frame?.t !== "want" || this.delayMs === null || !this.bytes) return super.send(data);
    RecordedChannel.prototype.send.call(this, data); this.trace.push(this.label);
    const chunks = Math.ceil(this.bytes.byteLength / 16384);
    setTimeout(() => {
      if (this.readyState !== "open") return;
      this.started.add(frame.id);
      this.receive(JSON.stringify({ t: "meta", id: frame.id, size: this.bytes.byteLength }));
      for (let i = 0; i < Math.min(chunks, this.stallAfter); i++) setTimeout(() => {
        if (this.readyState !== "open") return;
        this.receive(this.bytes.slice(i * 16384, (i + 1) * 16384).buffer);
        if (i === chunks - 1) this.receive(JSON.stringify({ t: "eof", id: frame.id }));
      }, i * this.gapMs);
    }, this.delayMs);
  }
}

// Link A (`holder`) is slow: it completes a small segment, which is its only rate evidence, and no completed
// transfer is as large as the big segment that follows. Link B (`other`, first in link order) has never been
// asked and serves at once. Both are serving links of the current rendition.
const bigSegment = new Uint8Array(10 * 16384).fill(5), smallSegment = new Uint8Array(3 * 16384).fill(5);
async function trialFixture(t, { gapMs = 200, stallAfter = Infinity, ...options } = {}) {
  const f = await staleHolderFixture(t, { originFallbackMs: 1000, firstServes: true,
    serve: { bytes: bigSegment, delayMs: 5, Channel: ChunkedHolder }, firstServe: { bytes: bigSegment, delayMs: 20, Channel: ChunkedHolder }, ...options });
  Object.assign(f.holderChannel, { gapMs, stallAfter });
  const holds = (key, who, channel, name) => channel.receive(key && who.includes(name) ? haveFrame(key) : haveFrame());
  const hold = (key, ...who) => { holds(key, who, f.holderChannel, "A"); holds(key, who, f.siblingChannel, "B"); };
  const run = async (...who) => {
    const segment = f.next(); f.touch(); f.siblingChannel.receive(serving());
    hold(segment.key, ...who); await f.load(segment.name); await sleep(5); hold(undefined); return segment;
  };
  const setBytes = bytes => { f.commitments.bytes = bytes; for (const channel of [f.holderChannel, f.siblingChannel]) if (channel.bytes) channel.bytes = bytes; };
  // A delivers the small segment slowly (rate evidence, one recorded attempt); the next committed size is large.
  const learn = async () => { setBytes(smallSegment); await run("A"); setBytes(bigSegment); };
  // Then A is declined at the commitment stage for the big segment, which makes 160 KiB the size hint.
  const prime = async () => { await learn(); await run("A"); };
  const measured = pubkey => f.swarm.metrics().peers.deliveryMeasurements.find(value => value.pubkey === pubkey);
  const segments = () => f.swarm.metrics().segments;
  const labels = { A: f.label(f.holderKey), B: f.label(f.peers[0].pubkey) };
  const pubkeys = { A: f.holderKey, B: f.peers[0].pubkey };
  return { f, run, hold, learn, prime, measured, segments, labels, pubkeys };
}

test("an untested holder is asked once when the shared projection is late, and delivers", async t => {
  const { f, run, prime, measured, segments, pubkeys, labels } = await trialFixture(t);
  try {
    await prime();
    assert.equal(measured(pubkeys.A).attempts, 1, "A is tested; its slow small delivery is the rate evidence");
    assert.equal(measured(pubkeys.B).attempts, 0);
    assert.equal(segments().peerUntestedTrial, 0);
    const asked = f.requests.length, charged = f.discovery().heldMiss;
    await run("A", "B");
    assert.deepEqual(f.requests.slice(asked), ["other"], "the untested holder, not the tested one");
    assert.equal(segments().peerUntestedTrial, 1); assert.equal(segments().peerUntestedTrialLoaded, 1);
    assert.equal(segments().peerFirstLoaded, 2, "the small delivery while priming and the trial");
    assert.equal(segments().peerProjectedLate, 1, "only the priming decline: none is counted for a trial");
    assert.deepEqual(f.rows().filter(row => row.reason === "projected-late").map(row => row.projection.stage), ["commitment"]);
    assert.equal(measured(pubkeys.B).attempts, 1, "after its recorded attempt it is no longer untested");
    assert.equal(f.discovery().heldMiss, charged, "a delivery charges nobody");
    const row = f.rows().at(-1);
    assert.equal(row.reason, "have-at-entry"); assert.equal(row.trial, true);
    assert.deepEqual(row.haveHolders, [labels.A, labels.B].sort((a, b) => a - b));
  } finally { await f.close(); }
});

test("a trial that fails charges the asked holder, which is then no longer untested and gets no second trial", async t => {
  const { f, run, prime, measured, segments, pubkeys, labels } = await trialFixture(t, { firstServe: { bytes: bigSegment, delayMs: null } });
  try {
    await prime();
    const asked = f.requests.length, charged = f.discovery().heldMiss;
    await run("B");
    assert.deepEqual(f.requests.slice(asked), ["other"]);
    assert.equal(segments().peerUntestedTrial, 1); assert.equal(segments().peerUntestedTrialLoaded, 0);
    assert.equal(segments().peerAbandoned, 1, "silence on a link with a known first byte is abandoned early");
    assert.equal(segments().peerFirstLoaded, 1, "only the small delivery while priming");
    assert.equal(measured(pubkeys.B).attempts, 1);
    assert.equal(f.discovery().heldMiss, charged + 1, "the trial link was asked, so it is charged as an asked holder");
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders).at(-1), [labels.B]);
    // With an attempt on record, the same holder gets the ordinary decision.
    const before = f.requests.length;
    await run("B");
    assert.equal(f.requests.length, before, "not asked again");
    assert.equal(segments().peerUntestedTrial, 1); assert.equal(segments().peerProjectedLate, 2, "the priming decline and this one");
    const late = f.rows().filter(row => row.reason === "projected-late");
    assert.deepEqual(late.map(row => row.projection.stage), ["commitment", "entry"]); assert.ok(!("trial" in late.at(-1)));
  } finally { await f.close(); }
});

test("a trial row carries the entry projection when the committed size then fits", async t => {
  const { f, run, prime, segments } = await trialFixture(t);
  try {
    await prime();
    // The size hint is 160 KiB, so the entry projection is late; the committed size is 48 KiB, which fits.
    for (const channel of [f.commitments, f.siblingChannel, f.holderChannel]) channel.bytes = smallSegment;
    await run("A", "B");
    const row = f.rows().at(-1);
    assert.equal(row.reason, "have-at-entry"); assert.equal(row.trial, true);
    assert.equal(row.projection.stage, "entry"); assert.ok(row.projection.transferMs > 1500, JSON.stringify(row.projection));
    assert.deepEqual(Object.keys(row.projection).sort(), ["firstByteMs", "holderWaitMs", "rateBytesPerSecond", "roomMs", "stage", "transferMs"]);
    assert.equal(segments().peerUntestedTrial, 1); assert.equal(segments().peerProjectedLate, 1, "only the priming decline");
    assert.equal(f.rows().filter(value => "trial" in value).length, 1, "only the trial row carries the field");
  } finally { await f.close(); }
});

test("a commitment-stage late projection grants the trial and replaces the detail on the have row", async t => {
  const { f, run, learn, segments } = await trialFixture(t);
  try {
    // The size hint is the small segment, so the entry projection fits; the large committed size is late once it is in.
    await learn();
    const asked = f.requests.length;
    await run("A", "B");
    assert.deepEqual(f.requests.slice(asked), ["other"]);
    const row = f.rows().filter(value => value.reason === "have-at-entry").at(-1);
    assert.equal(row.trial, true); assert.equal(row.projection.stage, "commitment"); assert.equal(row.projection.holderWaitMs, 0);
    assert.equal(segments().peerUntestedTrial, 1); assert.equal(segments().peerUntestedTrialLoaded, 1); assert.equal(segments().peerProjectedLate, 0);
    assert.equal(f.rows().filter(value => value.reason === "projected-late").length, 0);
    assert.equal(f.rows().filter(value => "trial" in value).length, 1);
  } finally { await f.close(); }
});

test("an entry grant followed by a commitment-stage late projection is one grant and one trial", async t => {
  const { f, run, prime, segments } = await trialFixture(t);
  try {
    await prime();
    await run("A", "B");
    // The size hint and the committed size agree, so both stages are late; the row ends with the commitment detail.
    const rows = f.rows().filter(row => row.reason === "have-at-entry");
    assert.equal(rows.length, 3);
    assert.ok(!("trial" in rows[0]) && !("trial" in rows[1]));
    assert.equal(rows[2].trial, true); assert.equal(rows[2].projection.stage, "commitment");
    assert.equal(segments().peerUntestedTrial, 1, "a single trial");
    assert.equal(f.requests.filter(value => value === "other").length, 1);
  } finally { await f.close(); }
});

test("rows of loads without a trial have no trial field and keep their ordinary projected-late path", async t => {
  const { f, run, prime, segments } = await trialFixture(t);
  try {
    await prime();
    // The only holder has an attempt on record: the ordinary decision, exactly as without a trial rule.
    const asked = f.requests.length;
    await run("A");
    assert.equal(f.requests.length, asked); assert.equal(segments().peerUntestedTrial, 0);
    assert.equal(segments().peerProjectedLate, 2, "once while priming, once here");
    const late = f.rows().filter(row => row.reason === "projected-late");
    assert.deepEqual(late.map(row => row.projection.stage), ["commitment", "entry"]);
    assert.equal(late[1].matchingHave, true);
    assert.ok(f.rows().every(row => !("trial" in row)));
    assert.equal(f.discovery().heldMiss, 0, "a declined load charges nobody");
  } finally { await f.close(); }
});

test("a stale untested holder gets no trial", async t => {
  const { f, run, prime, segments, measured, pubkeys } = await trialFixture(t);
  try {
    // Four loads nobody can serve end at origin over more than ten seconds: every serving link is stale.
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.5 } };
    for (let i = 0; i < 4; i++) {
      const segment = f.next(); f.touch(); f.siblingChannel.receive(serving());
      await f.load(segment.name); await sleep(5);
    }
    assert.equal(f.discovery().heldMiss, 0); assert.equal(f.outcomes(), 4);
    f.hls.media = undefined; f.shift.ms += 10_001;
    // Fresh rate evidence after the shift, so the projection is late rather than stale-evidence stretch.
    await prime();
    assert.equal(measured(pubkeys.B).attempts, 0);
    const asked = f.requests.length;
    await run("A", "B");
    assert.equal(segments().peerUntestedTrial, 0);
    assert.equal(f.requests.length, asked, "the stale untested holder was not asked");
    assert.ok(f.rows().at(-1).staleHolders.includes(f.label(pubkeys.B)), "B was stale at the decision");
    assert.equal(f.rows().filter(row => row.reason === "projected-late").length, 2, "the priming decline and this one");
    assert.ok(f.rows().every(row => !("trial" in row)));
  } finally { await f.close(); }
});

test("a busy untested holder gets no trial", async t => {
  const { f, prime, segments } = await trialFixture(t, { firstServe: { bytes: bigSegment, delayMs: 600, Channel: ChunkedHolder } });
  try {
    await prime();
    // B is held by a first load's trial request while a second load wants it as well.
    const first = f.next(), second = f.next();
    f.touch(); f.siblingChannel.receive(serving()); f.siblingChannel.receive(haveFrame(first.key, second.key));
    const one = f.load(first.name);
    await until(() => f.requests.includes("other"), 2_000);
    const two = f.load(second.name);
    await Promise.all([one, two]);
    assert.equal(f.requests.filter(value => value === "other").length, 1, "B was asked once");
    assert.equal(segments().peerUntestedTrial, 1); assert.equal(segments().peerProjectedLate, 2, "the priming decline and the second load's ordinary decision");
    const late = f.rows().filter(row => row.reason === "projected-late");
    assert.equal(late.length, 2); assert.ok(late.every(row => !("trial" in row)));
  } finally { await f.close(); }
});

test("a coordinated load gets no trial at either stage", async t => {
  const { f, run, prime, segments, measured, pubkeys } = await trialFixture(t);
  try {
    await prime();
    // Entry: nobody holds the key and the size is known, so the late projection ends the load as before.
    const asked = f.requests.length;
    await run();
    assert.equal(f.requests.length, asked); assert.equal(segments().peerUntestedTrial, 0);
    const late = f.rows().filter(row => row.reason === "projected-late");
    assert.deepEqual(late.map(row => [row.projection.stage, row.matchingHave]), [["commitment", true], ["entry", false]]);
    // Commitment: rendition 1 has no size hint, so the load waits, and B then announces the key.
    f.holderChannel.receive(serving("main:1")); f.siblingChannel.receive(serving("main:1"));
    const segment = f.next(), waits = f.counters()["no-have-wait"];
    const done = f.load(segment.name, 1);
    await until(() => f.counters()["no-have-wait"] === waits + 1, 2_000);
    f.siblingChannel.receive(haveFrame(segment.key)); await done; f.siblingChannel.receive(haveFrame());
    assert.equal(f.requests.length, asked, "B was not asked");
    assert.equal(measured(pubkeys.B).attempts, 0);
    assert.equal(segments().peerUntestedTrial, 0); assert.equal(segments().peerProjectedLate, 3);
    assert.deepEqual(f.rows().filter(row => row.reason === "projected-late").map(row => row.projection.stage), ["commitment", "entry", "commitment"]);
    assert.ok(f.rows().every(row => !("trial" in row)));
  } finally { await f.close(); }
});

test("only one trial per load: a second untested holder is reached by the ordinary choice, not counted as a trial", async t => {
  // B answers `none` at once; C is a second untested holder that serves quickly.
  const { f, prime, segments, measured, pubkeys } = await trialFixture(t, { maxPeers: 3, firstServe: { bytes: null, delayMs: 5 } });
  try {
    const third = await f.addPeer(new ChunkedHolder(bigSegment, 20, f.requests, "third"));
    third.receive(serving());
    await prime();
    const asked = f.requests.length, segment = f.next();
    f.touch(); f.siblingChannel.receive(serving());
    f.siblingChannel.receive(haveFrame(segment.key)); third.receive(haveFrame(segment.key));
    await f.load(segment.name); await sleep(5);
    assert.deepEqual(f.requests.slice(asked), ["other", "third"], "B first in link order, then C by the ordinary choice");
    assert.equal(segments().peerUntestedTrial, 1, "only B was a trial");
    assert.equal(segments().peerUntestedTrialLoaded, 0, "C delivered, but not as a trial");
    assert.equal(segments().peerFirstLoaded, 2); assert.equal(segments().peerProjectedLate, 1, "only the priming decline");
    assert.equal(measured(pubkeys.B).attempts, 1);
  } finally { await f.close(); }
});

test("a trial load with less room than the fastest completed transfer still goes to origin at the pre-request check", async t => {
  const { f, run, segments, measured, pubkeys } = await trialFixture(t, { originFallbackMs: 2500, stallAfter: 10, gapMs: 100 });
  try {
    // A completes the whole segment in about a second: a recorded completion, so a floor of about 1 s.
    await run("A");
    assert.equal(segments().peerFirstLoaded, 1);
    // 700 ms of room: the entry projection is late; the first byte fits, so B is granted a trial, but no
    // completed transfer of this size took under a second, so the pre-request check sends the load to origin.
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12.7 } };
    const asked = f.requests.length;
    await run("A", "B");
    assert.equal(f.requests.length, asked, "nobody was asked");
    assert.equal(segments().peerSkippedLate, 1); assert.equal(segments().peerUntestedTrial, 0);
    assert.equal(measured(pubkeys.B).attempts, 0);
    const row = f.rows().at(-1);
    assert.equal(row.reason, "have-at-entry"); assert.equal(row.trial, true);
    assert.equal(f.counters()["projected-late"], 0);
  } finally { await f.close(); }
});

test("a link remembers what the remote announced, serving or not, bounded to eight renditions", () => {
  const channel = new RecordedChannel(), link = new PeerLink({ pubkey: "a".repeat(64), pc: new PC(), channel, maxSegmentBytes: 1024 });
  const announce = (rendition, isServing) => channel.receive(JSON.stringify({ t: "contribution", serving: isServing, rendition }));
  assert.equal(link.announced.size, 0);
  announce("main:0", true);
  assert.deepEqual([...link.announced.keys()], ["main:0"]); assert.deepEqual([...link.renditions.keys()], ["main:0"]);
  // A non-serving announcement clears `renditions` and the serving flag as before, and keeps `announced`.
  announce("main:0", false);
  assert.equal(link.contribution.serving, false); assert.equal(link.renditions.size, 0);
  assert.deepEqual([...link.announced.keys()], ["main:0"]);
  announce("main:1", false);
  assert.deepEqual([...link.announced.keys()], ["main:0", "main:1"]); assert.equal(link.renditions.size, 0);
  // A serving announcement still fills `renditions` as it did.
  announce("main:2", true);
  assert.deepEqual([...link.renditions.keys()], ["main:2"]); assert.equal(link.contribution.serving, true);
  // No rendition is not recorded, and invalid messages change nothing.
  announce(null, false); channel.receive(JSON.stringify({ t: "contribution", serving: "yes", rendition: "x" })); channel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: 7 }));
  assert.deepEqual([...link.announced.keys()], ["main:0", "main:1", "main:2"]);
  // Eight at most: the oldest goes first, and a repeat refreshes its place.
  for (let i = 3; i < 8; i++) announce(`main:${i}`, false);
  assert.equal(link.announced.size, 8);
  announce("main:0", false);
  announce("audio:0", false);
  assert.equal(link.announced.size, 8);
  assert.equal(link.announced.has("main:0"), true, "refreshed, so not the oldest"); assert.equal(link.announced.has("main:1"), false, "the oldest was dropped");
  announce("audio:1", false);
  assert.equal(link.announced.size, 8); assert.equal(link.announced.has("main:2"), false);
  assert.ok([...link.announced.values()].every(value => Number.isFinite(value)));
  link.close();
  assert.equal(link.announced.size, 0);
});

// A serving viewer that plays main:0, with links of known age: the first link is the oldest. Time can be shifted.
async function tierFixture(t, kinds, { serve = true, ...options } = {}) {
  const realNow = Date.now.bind(Date), shift = { ms: 0 };
  t.mock.method(Date, "now", () => realNow() + shift.ms);
  const f = await linkedFixture({ WebSocketImpl: memoryRelaySocket(), serve, maxPeers: kinds.length, minLinkLifeMs: 1, idleEvictMs: 1, evictionCooldownMs: 1, ...options });
  const channels = [];
  for (const kind of kinds) {
    const channel = await f.addPeer(); channels.push(channel); await sleep(5);
    if (kind === "serving") channel.receive(serving("main:0"));
    else if (kind === "consumer") channel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    else if (kind === "other") channel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "audio:9" }));
  }
  await f.load();
  const counters = () => f.swarm.metrics().peers;
  let n = 0;
  // An incoming offer from a peerless newcomer that finds the viewer full.
  const offer = async () => {
    const before = counters().evicted, peer = new RelaySwarmSession({ pool: f.pool, swarmId: base.swarmId }); peer.start(); f.peers.push(peer);
    peer.sendSignal(f.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: `tier-offer-${n++}`, payload: { sdp: "fixture-offer", peers: 0 } });
    await until(() => counters().evicted === before + 1, 2_000);
    await sleep(5);
    return channels.map(channel => channel.readyState);
  };
  return { ...f, channels, shift, counters, offer };
}
const tiersOf = peers => [peers.evictedUnhelpful, peers.evictedServing, peers.evictedConsumer];

test("an offer eviction drops an unhelpful link, then a serving one, before the consumer that has been idle longest", async t => {
  // The consumer is the oldest link, so without tiers it would go first.
  const f = await tierFixture(t, ["consumer", "serving", "unhelpful"]);
  try {
    assert.deepEqual(tiersOf(f.counters()), [0, 0, 0]);
    assert.deepEqual(await f.offer(), ["open", "open", "closed"]);
    assert.deepEqual(tiersOf(f.counters()), [1, 0, 0]); assert.equal(f.counters().evicted, 1);
    assert.deepEqual(await f.offer(), ["open", "closed", "closed"]);
    assert.deepEqual(tiersOf(f.counters()), [1, 1, 0]); assert.equal(f.counters().evicted, 2);
    assert.equal(f.channels[0].readyState, "open", "the consumer is still linked");
  } finally { await f.close(); }
});

test("a consumer link that is the only eligible one is dropped exactly as before, and counted as a consumer", async t => {
  const f = await tierFixture(t, ["consumer", "consumer"]);
  try {
    assert.deepEqual(await f.offer(), ["closed", "open"], "the one idle longest");
    assert.deepEqual(tiersOf(f.counters()), [0, 0, 1]); assert.equal(f.counters().evicted, 1);
  } finally { await f.close(); }
});

test("only an announcement within two presence intervals of a rendition played within thirty seconds makes a consumer", async t => {
  // A fresh announcement, one just inside and one just outside 2 * 20 s, a rendition no longer played, and a viewer not serving.
  let f = await tierFixture(t, ["consumer", "other"]);
  try {
    assert.deepEqual(await f.offer(), ["open", "closed"], "fresh and played: a consumer outlasts an unhelpful link");
    assert.deepEqual(tiersOf(f.counters()), [1, 0, 0]);
  } finally { await f.close(); }
  f = await tierFixture(t, ["consumer", "other"]);
  try {
    f.shift.ms += 39_000; await f.load();
    assert.deepEqual(await f.offer(), ["open", "closed"], "just under two intervals old still counts");
    assert.deepEqual(tiersOf(f.counters()), [1, 0, 0]);
  } finally { await f.close(); }
  f = await tierFixture(t, ["consumer", "other"]);
  try {
    f.shift.ms += 40_001; await f.load();
    assert.deepEqual(await f.offer(), ["closed", "open"], "an older announcement is ignored, so the oldest idle goes");
    assert.deepEqual(tiersOf(f.counters()), [1, 0, 0]);
  } finally { await f.close(); }
  f = await tierFixture(t, ["consumer", "other"]);
  try {
    f.shift.ms += 30_001;
    assert.deepEqual(await f.offer(), ["closed", "open"], "the viewer has not played that rendition for thirty seconds");
    assert.deepEqual(tiersOf(f.counters()), [1, 0, 0]);
  } finally { await f.close(); }
  f = await tierFixture(t, ["consumer", "other"], { serve: false });
  try {
    assert.deepEqual(await f.offer(), ["closed", "open"], "a viewer that is not serving has no consumers");
    assert.deepEqual(tiersOf(f.counters()), [1, 0, 0]);
  } finally { await f.close(); }
});

test("a non-serving announcement does not stop a link counting as a consumer, and a serving remote is never one", async t => {
  const f = await tierFixture(t, ["serving", "consumer", "other"]);
  try {
    // The serving link withdraws, then is a non-serving remote that announced main:0 earlier: now a consumer.
    f.channels[0].receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    assert.deepEqual(await f.offer(), ["open", "open", "closed"]);
    assert.deepEqual(tiersOf(f.counters()), [1, 0, 0]);
    // Back to serving: tier one, below the consumer.
    f.channels[0].receive(serving("main:0"));
    assert.deepEqual(await f.offer(), ["closed", "open", "closed"]);
    assert.deepEqual(tiersOf(f.counters()), [1, 1, 0]);
  } finally { await f.close(); }
});

test("a discovery replacement drops an unhelpful link before the consumer that has been idle longest, and counts the tier", async t => {
  const f = await discoveryFixture({ serve: true });
  try {
    // The oldest link plays what this viewer can give it; the rest are receivers that announced nothing.
    f.channels[0].receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    f.announce(); await until(() => f.offers.length === 1, 2_500);
    assert.deepEqual(f.channels.map(channel => channel.readyState), ["open", "closed", "open", "open", "open", "open"]);
    const counters = f.swarm.metrics().neighbourDiscovery.counters;
    assert.deepEqual([counters.victimUnhelpful, counters.victimServing, counters.victimConsumer, counters.replacements], [1, 0, 0, 1]);
    const peers = f.swarm.metrics().peers;
    assert.equal(peers.evicted, 1, "evicted still counts every eviction"); assert.deepEqual(tiersOf(peers), [0, 0, 0], "the offer-eviction tiers count offers only");
  } finally { await f.close(); }
});

test("a discovery replacement drops a consumer when every eligible link is one", async t => {
  const f = await discoveryFixture({ serve: true });
  try {
    for (const channel of f.channels) channel.receive(JSON.stringify({ t: "contribution", serving: false, rendition: "main:0" }));
    f.announce(); await until(() => f.offers.length === 1, 2_500);
    assert.deepEqual(f.channels.map(channel => channel.readyState), ["closed", "open", "open", "open", "open", "open"]);
    const counters = f.swarm.metrics().neighbourDiscovery.counters;
    assert.deepEqual([counters.victimUnhelpful, counters.victimServing, counters.victimConsumer], [0, 0, 1]);
  } finally { await f.close(); }
});

test("a granted trial whose room then shrinks below the median first byte goes to origin without asking the holder", async t => {
  // A's first byte takes about 300 ms. Once primed, the commitment fetch is made slow, so the room left after it
  // is shorter than that first byte although the grant, made at entry before the fetch, saw more.
  let slowMs = 0, fixture;
  fixture = await trialFixture(t, { serve: { bytes: bigSegment, delayMs: 300, Channel: ChunkedHolder },
    getCommitment: async context => { if (slowMs) await sleep(slowMs); return fixture.f.commitments.getCommitment(context); } });
  const { f, run, prime, measured, segments, pubkeys } = fixture;
  try {
    await prime();
    assert.ok(f.swarm.metrics().peerEligibilityDiagnostics.records.at(-1).projection.firstByteMs >= 250, "the median first byte is about 300 ms");
    slowMs = 750;
    const asked = f.requests.length, late = segments().peerProjectedLate;
    await run("A", "B");
    assert.equal(f.requests.length, asked, "the untested holder was not asked");
    assert.equal(segments().peerSkippedLate, 1, "stopped by the pre-request first-byte check");
    assert.equal(segments().peerUntestedTrial, 0); assert.equal(segments().peerProjectedLate, late, "no projected-late is counted for the grant");
    assert.equal(measured(pubkeys.B).attempts, 0, "B is still untested");
    const row = f.rows().at(-1);
    assert.equal(row.reason, "have-at-entry"); assert.equal(row.trial, true);
    assert.equal(f.discovery().heldMiss, 0, "a load that asked nobody charges nobody");
  } finally { await f.close(); }
});

test("a holder that failed verification as a trial is banned and closed, and is never given a trial or asked again", async t => {
  // A ban always follows a recorded attempt (the corrupt payload is recorded first), so a banned link is
  // never untested; this pins the outcome a banned holder must have, whichever check excludes it.
  const { f, run, prime, segments, measured, pubkeys } = await trialFixture(t);
  try {
    await prime();
    f.siblingChannel.bytes = new Uint8Array(bigSegment.byteLength).fill(6);
    const asked = f.requests.length;
    await run("B");
    assert.deepEqual(f.requests.slice(asked), ["other"]);
    assert.equal(segments().peerUntestedTrial, 1); assert.equal(segments().peerUntestedTrialLoaded, 0);
    assert.equal(segments().peerCorrupt, 1); assert.equal(f.swarm.metrics().peers.banned, 1);
    assert.equal(f.siblingChannel.readyState, "closed"); assert.equal(f.swarm.metrics().peers.connected, 1);
    assert.equal(measured(pubkeys.B), undefined, "the link is gone");
    // The banned peer offers again and is refused, so it cannot become an untested holder.
    const links = f.swarm.metrics().peers.linksOpened;
    f.peers[0].sendSignal(f.swarm.metrics().pubkey, { type: "offer", transport: "webrtc", requestId: "banned-relink", payload: { sdp: "fixture-offer" } });
    await sleep(100);
    assert.equal(f.swarm.metrics().peers.linksOpened, links); assert.equal(f.swarm.metrics().peers.connected, 1);
    const trials = segments().peerUntestedTrial;
    await run("A");
    assert.equal(segments().peerUntestedTrial, trials); assert.equal(f.requests.filter(value => value === "other").length, 1);
  } finally { await f.close(); }
});


// Real signed/encrypted rendezvous and both public factories; only ordered RTC
// delivery is bridged. No retained relay history or artificial HAVE payloads.
async function framingPairFixture(t, {omitPresenceCapability=false, capability={}, staleAnswer=false, deniedOffer=false, pairedState=false}={}) {
  const pcs=new Map(),channels=[],presences=[],signals=[],swarms=[],pendingSignals=[];let next=0;
  class Ordered extends RecordedChannel {
    readyState='connecting';ordered=true;maxRetransmits=null;maxPacketLifeTime=null;
    send(data){super.send(data);const copy=typeof data==='string'?data:structuredClone(data);
      queueMicrotask(()=>{if(this.readyState==='open'&&this.other.readyState==='open')this.other.receive(copy);});}
    close(){if(this.readyState==='closed')return;super.close();this.other?.close();}
  }
  class BridgedPC extends PC {
    constructor(config){super(config);this.id=String(++next);pcs.set(this.id,this);}
    createDataChannel(){this.channel=new Ordered();channels.push(this.channel);return this.channel;}
    description(type){return {type,sdp:`v=0\r\na=fixture-pc:${this.id}\r\na=candidate:fixture 1 udp 1 fixture.local 9 typ host\r\n`};}
    async createOffer(){return this.description('offer');}
    async createAnswer(){return this.description('answer');}
    async setLocalDescription(description){this.localDescription=description;}
    async setRemoteDescription(description){
      this.remoteDescription=description;const peer=pcs.get(/^a=fixture-pc:(\d+)\r?$/m.exec(description.sdp)?.[1]);assert(peer,'real paired SDP');
      if(description.type==='offer'){
        this.channel=new Ordered();channels.push(this.channel);this.channel.other=peer.channel;peer.channel.other=this.channel;
        const event=new Event('datachannel');event.channel=this.channel;this.dispatchEvent(event);
      }else queueMicrotask(()=>{
        if(pairedState)for(const pc of [this,peer]){pc.connectionState='connected';pc.dispatchEvent(new Event('connectionstatechange'));}
        for(const channel of [this.channel,peer.channel]){channel.readyState='open';channel.dispatchEvent(new Event('open'));}
      });
    }
    close(){super.close();if(pairedState)this.connectionState='closed';this.channel?.close();}
  }
  const Memory=memoryRelaySocket();
  class Socket extends Memory {send(text){const [type,event]=JSON.parse(text);if(type==='EVENT'&&event.kind===24170)presences.push(event);super.send(text);}}
  const original=RelaySwarmSession.prototype.sendSignal;
  t.mock.method(RelaySwarmSession.prototype,'sendSignal',function(to,envelope){
    envelope=structuredClone(envelope);
    if(staleAnswer&&envelope.type==='answer')original.call(this,to,{...envelope,requestId:'stale-'+envelope.requestId,payload:{...envelope.payload,obj:2}});
    const denied=deniedOffer&&envelope.type==='offer'?original.call(this,to,{...envelope,requestId:'denied-'+envelope.requestId,payload:{...envelope.payload,obj:2,ticket:'denied'}}):null;
    if(Object.hasOwn(capability,envelope.type)){
      if(capability[envelope.type]===null)delete envelope.payload.obj;else envelope.payload.obj=capability[envelope.type];
    }
    signals.push({from:this.pubkey,to,...structuredClone(envelope)});
    if(denied){pendingSignals.push(()=>original.call(this,to,envelope));return denied;}
    return original.call(this,to,envelope);
  });
  if(omitPresenceCapability){
    const announce=RelaySwarmSession.prototype.announcePresence;
    t.mock.method(RelaySwarmSession.prototype,'announcePresence',function(payload){return announce.call(this,{...payload,transports:payload.transports.map(({obj,...entry})=>entry)});});
  }
  const bytes=new Uint8Array(32).fill(9),key=createHash('sha256').update(`${base.swarmId}\n/media/seg.ts`).digest('hex');
  const hash=createHash('sha256').update(bytes).digest('hex');
  const signed=signedFixture({v:3,key,sha256:hash,rendition:'/media/index.m3u8',playlist:'/media/index.m3u8',mediaType:'main',encryption:null,pieceSize:commitmentPieceSize(bytes.length),pieces:[hash]});
  const make=async({cold=false,delay=0,legacy=false,admit,OriginLoader=null,swarmOptions={},player={}}={})=>{
    let http=0,bodies=0,aborts=0;class Origin extends Loader {
      stats=new LoadStats();
      load(ctx,config,callbacks){http++;const complete=()=>{bodies++;this.stats.loaded=this.stats.total=bytes.length;callbacks.onSuccess({data:bytes.slice().buffer},this.stats,ctx,null);};
        if(delay)this.timer=setTimeout(complete,delay);else complete();}
      abort(){aborts++;clearTimeout(this.timer);}destroy(){this.abort();}
    }
    const swarm=createHlsSwarm({...base,relays:['wss://memory-relay.example'],WebSocketImpl:Socket,RTCPeerConnectionImpl:BridgedPC,
      mode:'peer-first',coreWasm:multiCore,multiHolder:true,serve:true,maxPeers:1,getCommitment:()=>signed.event,streamEvent:signed.options.streamEvent,
      originReserveMs:100,originFallbackMs:1000,maxPeerWaitMs:1500,traceRequests:128,ticket:"granted",
      ...(legacy?{multiHolder:false}:{}),...(admit?{admit}:{}),
      ...(cold?{sustainablePeerWait:true,zeroBudgetPeerRace:true,lateHaveRace:true,latePeerRace:true,uploadPacing:true}:{}),...swarmOptions});swarms.push(swarm);
    const hls={...player,config:{...player.config,loader:OriginLoader??Origin},media:player.media??{currentTime:0,buffered:{length:cold?0:1,start:()=>0,end:()=>8}}};swarm.attach(hls);
    await until(()=>swarm.metrics().core.state==='ready'&&presences.some(event=>event.pubkey===swarm.metrics().pubkey));
    const frag=M3U8Parser.parseLevelPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:2,\nseg.ts\n','https://origin.example/media/index.m3u8',0,'main',0,null).fragments[0];
    const load=()=>new Promise((resolve,reject)=>{const loader=new hls.config.fLoader({});frag.stats=loader.stats;
      loader.load({url:frag.url,frag,part:null},{timeout:4000},{onSuccess:r=>resolve(new Uint8Array(r.data)),onError:reject,onTimeout:()=>reject(Error('timeout'))});});
    return {swarm,hls,load,get http(){return http;},get bodies(){return bodies;},get aborts(){return aborts;},set delay(value){delay=value;}};
  };
  return {make,bytes,key,presences,signals,channels,releaseSignals(){for(const send of pendingSignals.splice(0))send();},close(){for(const swarm of swarms)swarm.stop();}};
}

test('SDP framing: late factory missing the holder presence accepts verified schema3 before heartbeat',async t=>{
  const f=await framingPairFixture(t);
  try {
    const a=await f.make();sameBytes(await a.load(),f.bytes);await until(()=>a.swarm.metrics().bytes.held===f.bytes.length);
    assert.equal(f.presences.filter(event=>event.pubkey===a.swarm.metrics().pubkey).length,1);
    const b=await f.make();await until(()=>a.swarm.metrics().peers.connected===1&&b.swarm.metrics().peers.connected===1);
    await until(()=>f.channels.some(channel=>channel.sent.some(frame=>frame.t==='have'&&(frame.keys??frame.add??[]).includes(f.key))));
    sameBytes(await b.load(),f.bytes);
    assert.equal(b.http,0,'late B uses actual A retained cache without waiting for a presence heartbeat');
    assert.equal(b.swarm.metrics().segments.peerFirstLoaded,1);assert.equal(a.swarm.metrics().bytes.uploaded,f.bytes.length);
    assert.equal(b.swarm.metrics().core.multiHolder.delivered,1,'missed presence must not force legacy whole-object transfer instead of verified schema3 ranges');
    assert.equal(f.presences.filter(event=>event.pubkey===a.swarm.metrics().pubkey).length,1,'no reannouncement repaired the missing presence');
    assert(f.signals.some(row=>row.type==='offer'));assert(f.signals.some(row=>row.type==='answer'));
  }finally{f.close();}
});


test('SDP framing: cold public races accept held peer bytes before the receiver HTTP body',async t=>{
  const f=await framingPairFixture(t);let clock;
  try {
    const a=await f.make();sameBytes(await a.load(),f.bytes);await until(()=>a.swarm.metrics().bytes.held===f.bytes.length);
    const b=await f.make({cold:true,delay:300});await until(()=>a.swarm.metrics().peers.connected===1&&b.swarm.metrics().peers.connected===1);
    await until(()=>f.channels.some(channel=>channel.sent.some(frame=>frame.t==='have'&&(frame.keys??frame.add??[]).includes(f.key))));
    clock=virtualClock(t);sameBytes(await clock.settle(b.load(),1000),f.bytes);
    assert.equal(b.http,1,'the ordinary cached race still starts its single HTTP backstop');
    assert.equal(b.swarm.metrics().bytes.fromPeers,f.bytes.length,'cold B must consume verified held bytes despite missing A presence');
    assert.equal(b.swarm.metrics().segments.peerFirstLoaded,1);assert.equal(b.bodies,0,'peer result precedes any receiver origin payload');assert(b.aborts>0);
    await clock.advance(350);assert.equal(b.bodies,0,'cancelled HTTP cannot later deliver');
    assert.equal(f.presences.filter(event=>event.pubkey===a.swarm.metrics().pubkey).length,1,'no heartbeat repairs eligibility');
  }finally{clock?.restore();f.close();}
});


test('SDP framing: installed offer and answer enable cold peer races in both directions without presence capability',async t=>{
  const f=await framingPairFixture(t,{omitPresenceCapability:true});let clock;
  try{
    const a=await f.make({cold:true});sameBytes(await a.load(),f.bytes);await until(()=>a.swarm.metrics().bytes.held===32);
    const b=await f.make({cold:true,delay:300});await until(()=>a.swarm.metrics().peers.connected===1&&b.swarm.metrics().peers.connected===1);
    clock=virtualClock(t);sameBytes(await clock.settle(b.load(),1000),f.bytes);
    await clock.advanceUntil(()=>b.swarm.metrics().bytes.held===32,100);a.delay=300;
    sameBytes(await clock.settle(a.load(),1000),f.bytes);
    for(const participant of [a,b]){
      assert.equal(participant.swarm.metrics().bytes.fromPeers,32);assert.equal(participant.swarm.metrics().core.multiHolder.delivered,1);
      assert.equal(participant.swarm.metrics().bytes.uploaded,32);assert(participant.aborts>0);
    }
    assert.equal(a.bodies,1,'only the initial provider HTTP payload');assert.equal(b.bodies,0);
    assert(f.signals.filter(row=>['offer','answer'].includes(row.type)).every(row=>row.payload.obj===2));
    assert.equal(f.presences.length,2,'only the initial presence of each factory, neither advertises obj');
    for(const event of f.presences)assert.equal(JSON.parse(event.content).transports[0].obj,undefined);
  }finally{clock?.restore();f.close();}
});

test('SDP framing: absent or invalid offer metadata never infers ranges from PC or HAVE',async t=>{
  for(const obj of [null,0,1,3,16,2.5,'2',true,{}])await t.test(JSON.stringify(obj),async t=>{
    const f=await framingPairFixture(t,{capability:{offer:obj}});let clock;
    try{
      const a=await f.make();await a.load();await until(()=>a.swarm.metrics().bytes.held===32);
      const b=await f.make({cold:true,delay:80});await until(()=>b.swarm.metrics().peers.connected===1);
      clock=virtualClock(t);sameBytes(await clock.settle(b.load(),1000),f.bytes);
      assert.equal(b.http,1);assert.equal(b.bodies,1);assert.equal(b.swarm.metrics().bytes.fromPeers,0);
      assert.equal(b.swarm.metrics().core.multiHolder.delivered,0);
    }finally{clock?.restore();f.close();}
  });
});

test('SDP framing: disabled local ranges advertises no signal capability',async t=>{
  const f=await framingPairFixture(t);let clock;
  try{
    const a=await f.make({legacy:true});await a.load();await until(()=>a.swarm.metrics().bytes.held===32);
    const b=await f.make({cold:true,delay:80});await until(()=>b.swarm.metrics().peers.connected===1);
    clock=virtualClock(t);await clock.settle(b.load(),1000);
    assert.equal(f.signals.find(row=>row.type==='offer').payload.obj,undefined);
    assert.equal(b.swarm.metrics().bytes.fromPeers,0);assert.equal(b.bodies,1);
  }finally{clock?.restore();f.close();}
});

test('SDP framing: an unadmitted offer cannot prime the subsequent legacy negotiation',async t=>{
  const f=await framingPairFixture(t,{deniedOffer:true,capability:{offer:null}});let clock;
  try{
    const a=await f.make();await a.load();await until(()=>a.swarm.metrics().bytes.held===32);
    const b=await f.make({cold:true,delay:80,admit:(_peer,ticket)=>ticket==='granted'});
    await until(()=>b.swarm.metrics().peers.admitRefused>0);f.releaseSignals();
    await until(()=>b.swarm.metrics().peers.connected===1);
    assert(b.swarm.metrics().peers.admitRefused>0);
    clock=virtualClock(t);await clock.settle(b.load(),1000);
    assert.equal(b.swarm.metrics().bytes.fromPeers,0);assert.equal(b.bodies,1);
  }finally{clock?.restore();f.close();}
});

test('SDP framing: stale answer cannot prime a current answer lacking capability',async t=>{
  const f=await framingPairFixture(t,{omitPresenceCapability:true,staleAnswer:true,capability:{answer:null}});let clock;
  try{
    const a=await f.make({cold:true});await a.load();await until(()=>a.swarm.metrics().bytes.held===32);
    const b=await f.make({cold:true,delay:300});await until(()=>a.swarm.metrics().peers.connected===1&&b.swarm.metrics().peers.connected===1);
    clock=virtualClock(t);sameBytes(await clock.settle(b.load(),1000),f.bytes);
    await clock.advanceUntil(()=>b.swarm.metrics().bytes.held===32,100);a.delay=80;
    sameBytes(await clock.settle(a.load(),1000),f.bytes);
    assert.equal(a.swarm.metrics().bytes.fromPeers,0);assert.equal(a.bodies,2);
    assert.equal(b.swarm.metrics().bytes.fromPeers,32,'the admitted installed offer still authorises the opposite direction');
  }finally{clock?.restore();f.close();}
});

test('buffered mixed setup retains only25ms before ordinary source invocation when authority is pending', async t => {
  const clock = virtualClock(t); let f, release;
  try {
    f = await bufferedMixedFixture(t, clock, { beforeCommitment: () => new Promise(resolve => { release = resolve; }) });
    const baselineWhole = f.wholeLoads.length, baselineWants = f.channels[0].wants.length, begun = clock.now();
    const load = beginCountedMultiLoad(f, f.ctx);
    await clock.advance(24);
    assert.equal(f.wholeLoads.length, baselineWhole, 'the opt-in owns only its declared bounded setup interval');
    await clock.advance(1);
    assert.equal(f.wholeLoads.length, baselineWhole + 1);
    assert.equal(f.wholeLoads.at(-1).config.loadPolicy.maxLoadTimeMs, 10000 - (clock.now() - begun));
    assert.equal(f.channels[0].wants.length, baselineWants); assert.equal(f.ranges.length, 0);
    release?.(); sameBytes(await clock.settle(load.response), f.bytes);
    assert.equal(load.calls.success.length, 1);
  } finally { release?.(); if (f) await clock.settle(f.close()); clock.restore(); }
});

// Observe only the currently executing real timer. The native delay, receiver,
// callback arguments and returned handle are passed through unchanged.
function realTimerInvocationContext() {
  const native = globalThis.setTimeout; let current = null;
  function observed(callback, delay, ...args) {
    if (typeof callback !== 'function') return Reflect.apply(native, this, [callback, delay, ...args]);
    const scheduledAtMs = performance.now();
    return Reflect.apply(native, this, [function (...callbackArgs) {
      const prior = current;
      current = { scheduledAtMs, requestedDelayMs: typeof delay === 'number' && Number.isFinite(delay) ? delay : null,
        firedAtMs: performance.now() };
      try { return Reflect.apply(callback, this, callbackArgs); }
      finally { current = prior; }
    }, delay, ...args]);
  }
  globalThis.setTimeout = observed;
  return { snapshot: () => current ? { ...current } : null,
    restore: () => { globalThis.setTimeout = native; } };
}

const MIXED_SCOPE_CHECKS = ['notStopped', 'hls', 'media', 'generation', 'stream', 'unpaused', 'unended', 'unseeking',
  'unitRate', 'ready', 'fragment', 'start', 'duration', 'identity', 'owns', 'mixed', 'signal', 'currentNotStopped', 'recovery', 'setup'];

// A classifier of actual SDK observations, not an elapsed-time assumption. The
// current() predicate establishes entry+25 as an exact conservative lower bound;
// its rounded diagnostic ms is used only to reject inconsistent evidence.
function mixedScopeSetupProof(trace, expected) {
  try {
    if (trace.dropped !== 0 || !Array.isArray(trace.rows) || !Number.isSafeInteger(expected.load) ||
        !Number.isFinite(expected.enteredAtMs) || !Number.isFinite(expected.invokedAtMs) ||
        ['physicalRangeGets', 'clientRangeLoads', 'peerRequests', 'acceptedPeerBytes'].some(name => expected[name] !== 0)) return null;
    const rows = trace.rows, same = row => row?.load === expected.load;
    const load = rows.findIndex(row => same(row) && row.k === 'load');
    const entry = rows.findIndex(row => same(row) && row.k === 'mixedScope' && row.reason === 'entry');
    const failure = rows.findIndex(row => same(row) && row.k === 'mixedScope' && row.reason === 'current-setup');
    const fallback = rows.findIndex(row => same(row) && row.k === 'mixedScope' && ['peer-result-empty', 'before-origin-invalid'].includes(row.reason));
    const origin = rows.findIndex(row => same(row) && row.k === 'originStart');
    if (!(load >= 0 && load < entry && entry < failure && failure < fallback && fallback < origin)) return null;
    const sequence = [load, entry, failure, fallback, origin].map(index => rows[index]);
    if (sequence.some((row, index) => !Number.isSafeInteger(row.at) || row.at < 0 || index > 0 && row.at < sequence[index - 1].at)) return null;
    if (rows.filter(row => same(row) && row.k === 'load').length !== 1 ||
        ['sn', 'cc', 'level'].some(name => !Number.isSafeInteger(expected[name]) || rows[load][name] !== expected[name])) return null;
    if (rows.some(row => same(row) && row.k === 'request')) return null;
    if (rows.slice(entry + 1, origin).some((row, index) => same(row) && row.k === 'mixedScope' &&
        ![failure, fallback].includes(entry + 1 + index))) return null;
    const rejected = rows[failure], state = rejected.scope, g = rejected.capturedGeometry, current = rejected.currentGeometry;
    if (!state || Object.keys(state).length !== MIXED_SCOPE_CHECKS.length ||
        MIXED_SCOPE_CHECKS.some(name => state[name] !== (name !== 'setup')) ||
        [rows[entry], rejected, rows[fallback]].some(row => row.phase !== 'mixed' || row.originInvoked !== false) ||
        !(rows[entry].ms >= 0 && rejected.ms >= 25 && rows[fallback].ms >= rejected.ms && rejected.setupRemainingMs <= 0)) return null;
    if (!g || !current || g.fragmentStart !== expected.fragmentStart || g.fragmentDurationSeconds !== expected.fragmentDurationSeconds ||
        current.fragmentStart !== g.fragmentStart || current.fragmentDurationSeconds !== g.fragmentDurationSeconds ||
        current.playbackRate !== 1 || !(current.readyState >= 3) || g.durationMs !== expected.fragmentDurationSeconds * 1000) return null;
    if (['currentTime', 'playableEnd', 'fragmentStart', 'durationMs', 'originReserveMs'].some(name =>
        !Number.isFinite(g[name]) || rows[load].budgetGeometry?.[name] !== g[name])) return null;
    const recoveryMs = Math.min(expected.parentMs, (g.playableEnd - g.currentTime) * 1000), firstMs = Math.min(recoveryMs, expected.ttfbMs);
    if (!(Number.isFinite(recoveryMs) && recoveryMs > 25 && Number.isFinite(firstMs) && firstMs > 25 &&
        recoveryMs - g.originReserveMs > 25 && rows[load].budgetMs === 0 && rows[load].limitMs > 25)) return null;
    const proofTime = expected.enteredAtMs + 25, elapsed = expected.invokedAtMs - expected.enteredAtMs;
    if (!(expected.invokedAtMs >= proofTime && expected.remainingLoadMs > 0 && expected.remainingTtfbMs > 0 &&
        expected.remainingLoadMs <= recoveryMs - 25 && expected.remainingLoadMs >= recoveryMs - elapsed &&
        expected.remainingTtfbMs <= firstMs - 25 && expected.remainingTtfbMs >= firstMs - elapsed)) return null;
    const xfers = rows.map((row, index) => ({ row, index })).filter(item => same(item.row) && item.row.k === 'xfer');
    const finishes = rows.map((row, index) => ({ row, index })).filter(item => same(item.row) && item.row.k === 'xferFinish');
    const ranges = rows.map((row, index) => ({ row, index })).filter(item => same(item.row) && item.row.k === 'origin' && item.row.ranged === true);
    // A successful Core RPC can reach receive() before its continuation calls
    // currentValid(). That exact guard runs before apply(state), so this earlier
    // rejection has one allocation but no attempted origin arm or peer command.
    if (rows[fallback].reason === 'peer-result-empty' && expected.coreTransfersDelta === 1) {
      if (xfers.length !== 1 || finishes.length !== 1 || ranges.length || expected.originRangeAttempts !== 0 ||
          rows.slice(entry + 1, origin).some(row => same(row) && row.k === 'origin')) return null;
      const { row: started, index: startIndex } = xfers[0], { row: finished, index: finishIndex } = finishes[0];
      if (![started, finished].every(row => Number.isSafeInteger(row.at)) ||
          !(entry < startIndex && startIndex < failure && failure < finishIndex && finishIndex < fallback && fallback < origin &&
            started.at >= rows[entry].at && started.at <= rejected.at && finished.at >= rejected.at && finished.at <= rows[fallback].at)) return null;
      if (started.op !== 'start' || started.exclusiveOrigin !== true || started.peerOnly === true || started.size !== expected.size ||
          !Number.isSafeInteger(started.pieces) || !Number.isSafeInteger(started.pieceSize) || started.pieceSize <= 0 ||
          Math.ceil(started.size / started.pieceSize) !== started.pieces || !(started.deadline > started.at) ||
          started.out?.finished !== false || typeof started.out?.late !== 'boolean' || !Array.isArray(started.out?.c)) return null;
      const commands = started.out.c, sources = commands.filter(command => command.t === 'origin'), peers = commands.filter(command => command.t === 'request');
      if (commands.length !== 2 || sources.length !== 1 || peers.length !== 1 || commands.some(command =>
          !Array.isArray(command.p) || command.p.length !== 2 || !command.p.every(Number.isSafeInteger) ||
          command.p[0] < 0 || command.p[0] >= command.p[1] || command.p[1] > started.pieces) ||
          !started.peers?.some(([id]) => id === peers[0].peer) ||
          !(sources[0].p[1] <= peers[0].p[0] || peers[0].p[1] <= sources[0].p[0])) return null;
      if (finished.reason !== 'reply-current-invalid' || finished.delivered !== false || finished.bufferedMixed !== true || finished.peerOnly !== false ||
          finished.verifiedBytes !== 0 || finished.originBytes !== 0 || !(finished.peerRemainingMs > 0 && finished.recoveryRemainingMs > 0) ||
          rows[origin].leg !== 'fallback' || rows[origin].ranged !== false || rows[origin].ms !== 0) return null;
      return { stage: 'after-core-reply-before-io', proofTime,
        sequence: [load, entry, startIndex, failure, finishIndex, fallback, origin].map(index => rows[index]) };
    }
    if (rows[fallback].reason === 'peer-result-empty') {
      if (xfers.length || ranges.length || expected.coreTransfersDelta !== 0 || expected.originRangeAttempts !== 0) return null;
      if (!finishes.length) return { stage: 'before-core', proofTime, sequence };
      // A synchronous transfer allocation can return after the setup cutoff.
      // This guard frees it before transfers++, start(), commands or I/O.
      if (finishes.length !== 1 || rows.slice(entry + 1, origin).some(row => same(row) && row.k === 'origin')) return null;
      const { row: finished, index: finishIndex } = finishes[0];
      if (!Number.isSafeInteger(finished.at) || !(failure < finishIndex && finishIndex < fallback &&
          finished.at >= rejected.at && finished.at <= rows[fallback].at) ||
          finished.reason !== 'allocation-state-deadline-authority-holder' || finished.delivered !== false ||
          finished.bufferedMixed !== true || finished.peerOnly !== false || finished.verifiedBytes !== 0 || finished.originBytes !== 0 ||
          ![finished.ms, finished.peerRemainingMs, finished.recoveryRemainingMs].every(Number.isFinite) || finished.ms < 0 ||
          !(finished.peerRemainingMs > 0 && finished.recoveryRemainingMs > 0) ||
          rows[origin].leg !== 'fallback' || rows[origin].ranged !== false || rows[origin].ms !== 0) return null;
      return { stage: 'after-allocation-before-start', proofTime,
        sequence: [load, entry, failure, finishIndex, fallback, origin].map(index => rows[index]) };
    }
    // A Core plan is not physical I/O: the mandatory source arm is attempted
    // first, and its existing beforeLoad guard can retire the whole plan before
    // either a Range loader invocation or the queued peer command is issued.
    if (xfers.length !== 1 || finishes.length !== 1 || ranges.length !== 1 ||
        expected.coreTransfersDelta !== 1 || expected.originRangeAttempts !== 1) return null;
    const { row: started, index: startIndex } = xfers[0], { row: finished, index: finishIndex } = finishes[0],
      { row: range, index: rangeIndex } = ranges[0];
    if ([started, finished, range].some(row => !Number.isSafeInteger(row.at)) || !Number.isFinite(range.ms)) return null;
    if (!(entry < startIndex && startIndex < failure && fallback < finishIndex && finishIndex < origin && finishIndex < rangeIndex &&
        started.at >= rows[entry].at && started.at <= rejected.at && finished.at >= rows[fallback].at && finished.at <= rows[origin].at)) return null;
    if (started.op !== 'start' || started.exclusiveOrigin !== true || started.peerOnly === true || started.size !== expected.size ||
        !Number.isSafeInteger(started.pieces) || !Number.isSafeInteger(started.pieceSize) || started.pieceSize <= 0 ||
        Math.ceil(started.size / started.pieceSize) !== started.pieces || !(started.deadline > started.at) ||
        started.out?.finished !== false || typeof started.out?.late !== 'boolean' || !Array.isArray(started.out?.c)) return null;
    const commands = started.out.c, sources = commands.filter(command => command.t === 'origin'), peers = commands.filter(command => command.t === 'request');
    if (commands.length !== 2 || sources.length !== 1 || peers.length !== 1 || commands.some(command =>
        !Array.isArray(command.p) || command.p.length !== 2 || !command.p.every(Number.isSafeInteger) ||
        command.p[0] < 0 || command.p[0] >= command.p[1] || command.p[1] > started.pieces) ||
        !started.peers?.some(([id]) => id === peers[0].peer) ||
        !(sources[0].p[1] <= peers[0].p[0] || peers[0].p[1] <= sources[0].p[0])) return null;
    if (finished.reason !== 'signal-abort' || finished.delivered !== false || finished.bufferedMixed !== true || finished.peerOnly !== false ||
        finished.verifiedBytes !== 0 || finished.originBytes !== 0 || range.outcome !== 'abort' || range.bytes !== null || range.httpStatus !== null ||
        !Array.isArray(range.range) || range.range.length !== 2 || range.range.some((value, index) => value !== sources[0].p[index]) ||
        !(range.at >= started.at && range.at <= rejected.at && range.ms >= 0)) return null;
    return { stage: 'after-core-before-io', proofTime,
      // Ranged `at` is the operation start; ring order is emission order, so an
      // asynchronous abort observation can appear after the whole originStart.
      sequence: [load, entry, startIndex, failure, fallback, finishIndex, origin, rangeIndex].sort((a, b) => a - b).map(index => rows[index]) };
  } catch { return null; }
}

test('buffered mixed setup scope proof rejects forged or incomplete decline observations', () => {
  // Pure classifier vectors, not elapsed measurements. The real callback case
  // independently has to establish this complete sequence with the actual SDK.
  const geometry = { currentTime: 10, playableEnd: 20, fragmentStart: 10, durationMs: 2000,
    fragmentDurationSeconds: 2, originReserveMs: 3000 };
  const state = Object.fromEntries(MIXED_SCOPE_CHECKS.map(name => [name, name !== 'setup']));
  const vector = {
    trace: { dropped: 0, rows: [
      { k: 'load', load: 7, at: 100, sn: 1, cc: 0, level: 0, budgetMs: 0, limitMs: 2500, budgetGeometry: geometry },
      { k: 'mixedScope', load: 7, at: 100, phase: 'mixed', reason: 'entry', ms: 0, originInvoked: false },
      { k: 'mixedScope', load: 7, at: 130, phase: 'mixed', reason: 'current-setup', ms: 30, setupRemainingMs: -5,
        originInvoked: false, scope: state, capturedGeometry: geometry,
        currentGeometry: { fragmentStart: 10, fragmentDurationSeconds: 2, playbackRate: 1, readyState: 4 } },
      { k: 'mixedScope', load: 7, at: 130, phase: 'mixed', reason: 'peer-result-empty', ms: 30, originInvoked: false },
      { k: 'originStart', load: 7, at: 131, ranged: false },
    ] },
    expected: { load: 7, sn: 1, cc: 0, level: 0, fragmentStart: 10, fragmentDurationSeconds: 2,
      enteredAtMs: 1000, invokedAtMs: 1031, parentMs: 10000, ttfbMs: 10000,
      remainingLoadMs: 9969, remainingTtfbMs: 9969, coreTransfersDelta: 0, originRangeAttempts: 0,
      physicalRangeGets: 0, clientRangeLoads: 0, peerRequests: 0, acceptedPeerBytes: 0 },
  };
  assert.equal(mixedScopeSetupProof(vector.trace, vector.expected)?.proofTime, 1025);
  const controls = [
    ['wrong reason despite late time', v => { v.trace.rows[2].reason = 'scope-ready'; }],
    ['cross load', v => { v.trace.rows[2].load = 8; }],
    ['wrong genuine tuple', v => { v.trace.rows[0].sn = 2; }],
    ['missing load entry', v => { v.trace.rows.splice(0, 1); }],
    ['missing mixed entry', v => { v.trace.rows.splice(1, 1); }],
    ['source before rejection', v => { v.trace.rows.splice(2, 0, v.trace.rows.pop()); }],
    ['early diagnostic time', v => { v.trace.rows[2].ms = 24; }],
    ['setup still current', v => { v.trace.rows[2].scope.setup = true; }],
    ['not owned', v => { v.trace.rows[2].scope.owns = false; }],
    ['missing scope check', v => { delete v.trace.rows[2].scope.identity; }],
    ['another scope check fails', v => { v.trace.rows[2].scope.ready = false; }],
    ['origin already invoked', v => { v.trace.rows[2].originInvoked = true; }],
    ['earlier scope failure', v => { v.trace.rows.splice(2, 0, { k: 'mixedScope', load: 7, at: 120, reason: 'scope-ready' }); }],
    ['preceding peer request', v => { v.trace.rows.splice(2, 0, { k: 'request', load: 7, at: 120 }); }],
    ['Core work', v => { v.trace.rows.splice(2, 0, { k: 'xfer', load: 7, at: 120, op: 'start' }); }],
    ['Core allocation evidence', v => { v.trace.rows.splice(2, 0, { k: 'xferFinish', load: 7, at: 120, reason: 'allocation-empty' }); }],
    ['allocated Core counter', v => { v.expected.coreTransfersDelta = 1; }],
    ['ranged origin work', v => { v.trace.rows.splice(2, 0, { k: 'origin', load: 7, at: 120, ranged: true }); }],
    ['mismatched current geometry', v => { v.trace.rows[2].currentGeometry.fragmentStart = 11; }],
    ['clipped parent', v => { v.expected.parentMs = 20; }],
    ['clipped first byte', v => { v.expected.ttfbMs = 20; }],
    ['renewed parent budget', v => { v.expected.remainingLoadMs = 10000; }],
    ['renewed first byte budget', v => { v.expected.remainingTtfbMs = 10000; }],
    ['trace missingness', v => { v.trace.dropped = 1; }],
  ];
  for (const [name, mutate] of controls) {
    const copy = structuredClone(vector); mutate(copy);
    assert.equal(mixedScopeSetupProof(copy.trace, copy.expected), null, name);
  }
});

test('buffered mixed after-Core setup proof requires the exact aborted transaction and zero physical I/O', () => {
  // Pure metadata vectors; the real paused-constructor case independently
  // proves this sequence through the actual SDK, Core and HTTP loader.
  const geometry = { currentTime: 10, playableEnd: 20, fragmentStart: 10, durationMs: 2000,
    fragmentDurationSeconds: 2, originReserveMs: 3000 };
  const state = Object.fromEntries(MIXED_SCOPE_CHECKS.map(name => [name, name !== 'setup']));
  const vector = { trace: { dropped: 0, rows: [
    { k: 'load', load: 7, at: 100, sn: 1, cc: 0, level: 0, budgetMs: 0, limitMs: 2500, budgetGeometry: geometry },
    { k: 'mixedScope', load: 7, at: 100, phase: 'mixed', reason: 'entry', ms: 0, originInvoked: false },
    { k: 'xfer', load: 7, at: 110, op: 'start', size: 6291456, pieces: 64, pieceSize: 98304, deadline: 2600,
      exclusiveOrigin: true, peers: [[1, null, null]],
      out: { c: [{ t: 'request', peer: 1, p: [0, 1] }, { t: 'origin', p: [1, 60] }], late: true, finished: false } },
    { k: 'mixedScope', load: 7, at: 140, phase: 'mixed', reason: 'current-setup', ms: 40, setupRemainingMs: -15,
      originInvoked: false, scope: state, capturedGeometry: geometry,
      currentGeometry: { fragmentStart: 10, fragmentDurationSeconds: 2, playbackRate: 1, readyState: 4 } },
    { k: 'mixedScope', load: 7, at: 140, phase: 'mixed', reason: 'before-origin-invalid', ms: 40, originInvoked: false },
    { k: 'xferFinish', load: 7, at: 140, reason: 'signal-abort', delivered: false, bufferedMixed: true, peerOnly: false,
      verifiedBytes: 0, originBytes: 0 },
    { k: 'originStart', load: 7, at: 141, ranged: false },
    { k: 'origin', load: 7, at: 111, ms: 30, ranged: true, range: [1, 60], outcome: 'abort', httpStatus: null, bytes: null },
  ] }, expected: { load: 7, sn: 1, cc: 0, level: 0, size: 6291456, fragmentStart: 10, fragmentDurationSeconds: 2,
    enteredAtMs: 1000, invokedAtMs: 1041, parentMs: 10000, ttfbMs: 10000, remainingLoadMs: 9959, remainingTtfbMs: 9959,
    coreTransfersDelta: 1, originRangeAttempts: 1, physicalRangeGets: 0, clientRangeLoads: 0, peerRequests: 0, acceptedPeerBytes: 0 } };
  assert.equal(mixedScopeSetupProof(vector.trace, vector.expected)?.stage, 'after-core-before-io');
  const controls = [
    ['wrong fallback reason', v => { v.trace.rows[4].reason = 'peer-result-empty'; }],
    ['non-setup scope', v => { v.trace.rows[3].reason = 'scope-ready'; }],
    ['cross-load start', v => { v.trace.rows[2].load = 8; }],
    ['wrong terminal', v => { v.trace.rows[5].reason = 'core-fail-command'; }],
    ['delivered terminal', v => { v.trace.rows[5].delivered = true; }],
    ['credited peer', v => { v.expected.acceptedPeerBytes = 1; }],
    ['verified Core bytes', v => { v.trace.rows[5].verifiedBytes = 1; }],
    ['verified source bytes', v => { v.trace.rows[5].originBytes = 1; }],
    ['actual Range GET', v => { v.expected.physicalRangeGets = 1; }],
    ['invoked range loader', v => { v.expected.clientRangeLoads = 1; }],
    ['actual peer WANT', v => { v.expected.peerRequests = 1; }],
    ['physical request trace', v => { v.trace.rows.splice(3, 0, { k: 'request', load: 7, at: 111 }); }],
    ['extra Core call', v => { v.trace.rows.splice(3, 0, { k: 'xfer', load: 7, at: 111, op: 'tick' }); }],
    ['wrong Core mode', v => { v.trace.rows[2].exclusiveOrigin = false; }],
    ['unexpected command', v => { v.trace.rows[2].out.c.push({ t: 'deliver' }); }],
    ['missing origin command', v => { v.trace.rows[2].out.c.pop(); }],
    ['overlapping commands', v => { v.trace.rows[2].out.c[1].p = [0, 60]; }],
    ['outside object', v => { v.trace.rows[2].out.c[1].p[1] = 65; }],
    ['unknown peer', v => { v.trace.rows[2].out.c[0].peer = 2; }],
    ['range already received', v => { v.trace.rows[7].bytes = 1; }],
    ['range has HTTP response', v => { v.trace.rows[7].httpStatus = 206; }],
    ['range outcome mismatch', v => { v.trace.rows[7].outcome = 'timeout'; }],
    ['range identity mismatch', v => { v.trace.rows[7].range = [2, 60]; }],
    ['hidden attempted range', v => { v.expected.originRangeAttempts = 0; }],
  ];
  for (const [name, mutate] of controls) {
    const copy = structuredClone(vector); mutate(copy);
    assert.equal(mixedScopeSetupProof(copy.trace, copy.expected), null, name);
  }
});

test('buffered mixed immutable actual after-Core receipt proves the aborted pre-I/O transaction', async () => {
  const text = (await readFile(new URL('./fixtures/buffered-mixed-after-core-setup.json', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), 'cdcf0280343555f1e52f8f6519f6b37cb67c2b9e4440e6081ab39a03da49d8de');
  const receipt = JSON.parse(text);
  assert.equal(receipt.provenance.sourceCommit, '502dc8c860e8182973ac55e2f8dccf21a9ce34fa');
  assert.equal(receipt.provenance.originalLogSha256, '611430a6cb010212a89de6b5d22fa991f6819ece59ad8e397b1a8051da793ad9');
  assert.equal(receipt.provenance.originalExitCode, 1, 'the archived attempt remains RED under its original classifier');
  const proof = mixedScopeSetupProof(receipt.trace, receipt.expected);
  assert.equal(proof?.stage, 'after-core-before-io');
  assert.equal(receipt.observedCounts.originRangeAttempts, 1);
  assert.equal(receipt.observedCounts.physicalRangeGets, 0); assert.equal(receipt.observedCounts.clientRangeBodies, 0);
  assert.equal(receipt.observedCounts.peerRequests, 0); assert.equal(receipt.observedCounts.acceptedPeerBytes, 0);
  assert.equal(receipt.observedCounts.physicalWholeGets, 2); assert.equal(receipt.observedCounts.successfulCallbacks, 1);
  assert.equal(proof.sequence.find(row => row.k === 'xfer').out.late, true, 'retain the actual planning prediction without treating it as physical I/O');
});

test('buffered mixed immutable actual pre-start allocation receipt proves zero attempted I/O', async () => {
  const text = (await readFile(new URL('./fixtures/buffered-mixed-allocation-setup.json', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), '3cb6b5a67b13f8ccc2aac626a2d0950bfcd9bea26ddf51675abe35c74ba9ed2e');
  const receipt = JSON.parse(text), { expected } = receipt;
  assert.equal(receipt.provenance.sourceCommit, 'a007c075c2477b653b40a359531d3dbf8a2792a0');
  assert.equal(receipt.provenance.originalLogSha256, '2eefe10e1ac781ea6d51db049e2f4ddba2cae992d84696fb6a9646684416ad82');
  assert.equal(receipt.provenance.originalPayloadSha256, '7ecfc2d68fa1b514b579bdb9ea0622d6727a2650f9134581c9e3c899d045d038');
  assert.equal(receipt.provenance.originalExitCode, 1, 'original hosted898/899 result remains RED');
  const proof = mixedScopeSetupProof(receipt.trace, expected);
  assert.equal(proof?.stage, 'after-allocation-before-start');
  assert.equal(proof.proofTime, expected.enteredAtMs + 25);
  assert.deepEqual(proof.sequence.map(row => row.k), ['load', 'mixedScope', 'mixedScope', 'xferFinish', 'mixedScope', 'originStart']);
  assert.equal(receipt.trace.rows.some(row => row.k === 'xfer'), false, 'allocation abort precedes Core start or commands');
  assert.deepEqual(receipt.observedCounts, { coreTransfers: 0, originRangeAttempts: 0, peerRequests: 0, acceptedPeerBytes: 0,
    physicalWholeGets: 2, physicalRangeGets: 0, clientRangeBodies: 0, successfulCallbacks: 1 });
});

test('buffered mixed pre-start allocation proof rejects other transactions and hidden I/O', async () => {
  const vector = JSON.parse(await readFile(new URL('./fixtures/buffered-mixed-allocation-setup.json', import.meta.url), 'utf8'));
  const started = JSON.parse(await readFile(new URL('./fixtures/buffered-mixed-after-core-reply-setup.json', import.meta.url), 'utf8'))
    .trace.rows.find(row => row.k === 'xfer' && row.op === 'start');
  assert.equal(mixedScopeSetupProof(vector.trace, vector.expected)?.stage, 'after-allocation-before-start');
  // Pure counterexamples to an actual immutable receipt, not new traffic or
  // elapsed measurements. None can use the allocation-abort exception.
  const controls = [
    ['wrong finish reason', v => { v.trace.rows[3].reason = 'signal-abort'; }],
    ['extra finish', v => { v.trace.rows.splice(4, 0, structuredClone(v.trace.rows[3])); }],
    ['Core started before rejection', v => { v.trace.rows.splice(2, 0, { ...structuredClone(started), load: 2, at: 2422 }); }],
    ['Core transfer counted', v => { v.expected.coreTransfersDelta = 1; }],
    ['origin attempt counted', v => { v.expected.originRangeAttempts = 1; }],
    ['physical Range GET', v => { v.expected.physicalRangeGets = 1; }],
    ['Range loader invoked', v => { v.expected.clientRangeLoads = 1; }],
    ['peer request sent', v => { v.expected.peerRequests = 1; }],
    ['accepted peer credit', v => { v.expected.acceptedPeerBytes = 1; }],
    ['hidden request command', v => { v.trace.rows.splice(4, 0, { k: 'request', load: 2, at: 2423 }); }],
    ['hidden range callback', v => { v.trace.rows.splice(4, 0, { k: 'origin', load: 2, at: 2423, ranged: true }); }],
    ['source arm before fallback', v => { v.trace.rows.splice(4, 0, { k: 'origin', load: 2, at: 2423, ranged: false }); }],
    ['finish claims delivery', v => { v.trace.rows[3].delivered = true; }],
    ['finish claims verified bytes', v => { v.trace.rows[3].verifiedBytes = 1; }],
    ['finish claims origin bytes', v => { v.trace.rows[3].originBytes = 1; }],
    ['peer-only finish', v => { v.trace.rows[3].peerOnly = true; }],
    ['unrelated signal failure', v => { v.trace.rows[2].scope.signal = false; }],
    ['unrelated authority identity failure', v => { v.trace.rows[2].scope.identity = false; }],
    ['missing current predicate', v => { delete v.trace.rows[2].scope.owns; }],
    ['scope before25ms', v => { v.trace.rows[2].ms = 24; }],
    ['setup still live', v => { v.trace.rows[2].scope.setup = true; }],
    ['positive setup remainder', v => { v.trace.rows[2].setupRemainingMs = 1; }],
    ['other load rejected', v => { v.trace.rows[2].load = 3; }],
    ['other expected load', v => { v.expected.load = 3; }],
    ['finish precedes failed check', v => { v.trace.rows[3].at = 2422; }],
    ['finish after fallback', v => { [v.trace.rows[3], v.trace.rows[4]] = [v.trace.rows[4], v.trace.rows[3]]; }],
    ['expired peer window', v => { v.trace.rows[3].peerRemainingMs = 0; }],
    ['unknown recovery window', v => { v.trace.rows[3].recoveryRemainingMs = null; }],
    ['wrong fallback leg', v => { v.trace.rows[5].leg = 'cached'; }],
    ['ranged fallback', v => { v.trace.rows[5].ranged = true; }],
    ['renewed parent budget', v => { v.expected.remainingLoadMs = 10000; }],
    ['renewed first-byte budget', v => { v.expected.remainingTtfbMs = 10000; }],
    ['source before original cutoff', v => { v.expected.invokedAtMs = v.expected.enteredAtMs + 24; }],
    ['trace evidence dropped', v => { v.trace.dropped = 1; }],
  ];
  for (const [name, mutate] of controls) {
    const copy = structuredClone(vector); mutate(copy);
    assert.equal(mixedScopeSetupProof(copy.trace, copy.expected), null, name);
  }
});

test('buffered mixed immutable actual Core-reply receipt proves zero attempted I/O', async () => {
  const text = (await readFile(new URL('./fixtures/buffered-mixed-after-core-reply-setup.json', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
  assert.equal(createHash('sha256').update(text).digest('hex'), '243b804cc80dfcf006048a61241d6b53db433b19379cce3348824acf4d916f1d');
  const receipt = JSON.parse(text), { expected } = receipt;
  assert.equal(receipt.provenance.sourceCommit, '688f8607365cdbea9d44d06e3204cd55025caba9');
  assert.equal(receipt.provenance.originalLogSha256, '332b46def0c753877dea349a92f9e92e6495158427d37d5bb0690fc6ea4c05ca');
  assert.equal(receipt.provenance.originalExitCode, 1, 'original hosted803/804 result remains RED');
  const proof = mixedScopeSetupProof(receipt.trace, expected);
  assert.equal(proof?.stage, 'after-core-reply-before-io');
  assert.equal(proof.proofTime, expected.enteredAtMs + 25);
  const rpc = receipt.workerRpc.at(-1);
  assert.equal(rpc.op, 'start'); assert.equal(rpc.success, true);
  assert(rpc.replyAtMs < expected.enteredAtMs + 25, 'RPC instrumentation reply precedes cutoff; the later actual scope predicate proves expiry');
  assert.equal(receipt.timer, null);
  assert.deepEqual(receipt.observedCounts, { coreTransfers: 1, originRangeAttempts: 0, peerRequests: 0, acceptedPeerBytes: 0,
    physicalWholeGets: 2, physicalRangeGets: 0, clientRangeBodies: 0, successfulCallbacks: 1 });
});

test('buffered mixed Core-reply setup proof rejects mismatched or hidden I/O evidence', async () => {
  const vector = JSON.parse(await readFile(new URL('./fixtures/buffered-mixed-after-core-reply-setup.json', import.meta.url), 'utf8'));
  assert.equal(mixedScopeSetupProof(vector.trace, vector.expected)?.stage, 'after-core-reply-before-io');
  const controls = [
    ['wrong terminal branch', v => { v.trace.rows[4].reason = 'signal-abort'; }],
    ['later source-attempt branch', v => { v.trace.rows[5].reason = 'before-origin-invalid'; }],
    ['attempted origin range', v => { v.expected.originRangeAttempts = 1; }],
    ['unknown origin attempts', v => { delete v.expected.originRangeAttempts; }],
    ['missing Core allocation', v => { v.expected.coreTransfersDelta = 0; }],
    ['extra Core allocation', v => { v.expected.coreTransfersDelta = 2; }],
    ['physical Range GET', v => { v.expected.physicalRangeGets = 1; }],
    ['invoked Range loader', v => { v.expected.clientRangeLoads = 1; }],
    ['peer WANT', v => { v.expected.peerRequests = 1; }],
    ['accepted peer credit', v => { v.expected.acceptedPeerBytes = 1; }],
    ['credited Core bytes', v => { v.trace.rows[4].verifiedBytes = 1; }],
    ['credited source bytes', v => { v.trace.rows[4].originBytes = 1; }],
    ['delivered Core reply', v => { v.trace.rows[4].delivered = true; }],
    ['wrong physical scope reason', v => { v.trace.rows[3].reason = 'scope-ready'; }],
    ['another failed scope', v => { v.trace.rows[3].scope.recovery = false; }],
    ['missing scope identity', v => { delete v.trace.rows[3].scope.identity; }],
    ['early diagnostic elapsed', v => { v.trace.rows[3].ms = 24; }],
    ['source already invoked', v => { v.trace.rows[3].originInvoked = true; }],
    ['cross-load start', v => { v.trace.rows[2].load++; }],
    ['cross-load terminal', v => { v.trace.rows[4].load++; }],
    ['wrong genuine tuple', v => { v.trace.rows[0].sn++; }],
    ['terminal before scope failure', v => { [v.trace.rows[3], v.trace.rows[4]] = [v.trace.rows[4], v.trace.rows[3]]; }],
    ['fallback before terminal', v => { [v.trace.rows[4], v.trace.rows[5]] = [v.trace.rows[5], v.trace.rows[4]]; }],
    ['hidden request trace', v => { v.trace.rows.splice(3, 0, { k: 'request', load: 2, at: 2199 }); }],
    ['hidden origin trace', v => { v.trace.rows.splice(3, 0, { k: 'origin', load: 2, at: 2199, ranged: true }); }],
    ['extra Core command', v => { v.trace.rows.splice(3, 0, { k: 'xfer', load: 2, at: 2199, op: 'tick' }); }],
    ['overlapping plan', v => { v.trace.rows[2].out.c[1].p[0] = 0; }],
    ['unexpected plan command', v => { v.trace.rows[2].out.c.push({ t: 'deliver' }); }],
    ['wrong object size', v => { v.expected.size--; }],
    ['renewed parent budget', v => { v.expected.remainingLoadMs = 10000; }],
    ['renewed first-byte budget', v => { v.expected.remainingTtfbMs = 10000; }],
    ['trace lost rows', v => { v.trace.dropped = 1; }],
  ];
  for (const [name, mutate] of controls) {
    const copy = structuredClone(vector); mutate(copy);
    assert.equal(mixedScopeSetupProof(copy.trace, copy.expected), null, name);
  }
});

test('buffered mixed timer observer preserves native receiver arguments handle and synchronous scope', async () => {
  const native = globalThis.setTimeout, observer = realTimerInvocationContext(), argument = {};
  try {
    await new Promise((resolve, reject) => {
      const handle = setTimeout(function (first, second) {
        try {
          assert.equal(this, handle); assert.equal(first, argument); assert.equal(second, 7);
          const context = observer.snapshot();
          assert.deepEqual(Object.keys(context), ['scheduledAtMs', 'requestedDelayMs', 'firedAtMs']);
          assert.equal(context.requestedDelayMs, 1); assert(context.firedAtMs >= context.scheduledAtMs);
          resolve();
        } catch (error) { reject(error); }
      }, 1, argument, 7);
      assert.equal(typeof handle.refresh, 'function', 'the native Timeout handle is returned unchanged');
    });
    assert.equal(observer.snapshot(), null, 'context does not survive the synchronous native callback');
  } finally { observer.restore(); }
  assert.equal(globalThis.setTimeout, native);
});

for (const [knownFlow, worker, forceSetupExpiry = false, forceScopeExpiry = false] of [[true, false, false], [true, true, false], [false, false, false], [false, true, false], [false, true, true], [false, false, false, true]]) test(`buffered mixed ${knownFlow ? '' : 'untrained '}six-MiB object retains exact206 assembly or proven bounded setup decline (${worker ? 'committed-WASM worker' : 'main-thread'}${forceSetupExpiry ? ', held allocation' : ''}${forceScopeExpiry ? ', real callback pause' : ''})`, { timeout: 20000 }, async t => {
  const timers = realTimerInvocationContext();
  t.after(() => timers.restore());
  const rpc = [], bridge = worker ? transferWorkerFixture(t, { onRpc: row => rpc.push(row) }) : null;
  const workerOptions = bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {};
  const size = 6 * 1024 * 1024, bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) % 251);
  const { received, requests, url, HttpLoader } = await mixedHttpOrigin(t, bytes, Loader, timers.snapshot);
  class PacedPeer extends PhasedFlowChannel {
    send(data) {
      const frame = typeof data === 'string' ? JSON.parse(data) : null;
      if (frame?.t === 'want') {
        const pieceSize = commitmentPieceSize(this.bytes.length), from = frame.p ? frame.p[0] * pieceSize : 0;
        const to = frame.p ? Math.min(frame.p[1] * pieceSize, this.bytes.length) : this.bytes.length;
        this.firstByteMs = 10; this.flowMs = Math.max(0, to - from) / (.3 * 1024 * 1024) * 1000;
      }
      return super.send(data);
    }
  }
  const callbackPause = { armed: false, calls: 0, startedAtMs: null, finishedAtMs: null };
  const observed = [], f = await multiFixture(t, { size, OriginLoader: HttpLoader, holders: [{ Channel: PacedPeer }],
    traceRequests: 4096, onPeerDelivery: row => observed.push(row),
    ...(forceScopeExpiry ? { beforeCommitment: () => {
      if (!callbackPause.armed) return;
      callbackPause.armed = false; callbackPause.calls++; callbackPause.startedAtMs = performance.now();
      while (performance.now() - callbackPause.startedAtMs < 30) {} // Actual synchronous callback work; no clock/timer changes.
      callbackPause.finishedAtMs = performance.now();
    } } : {}),
    swarmOptions: { bufferedMixedRanges: true, zeroBudgetPeerRace: true, sustainablePeerWait: true, maxPeerWaitMs: 2500, ...workerOptions } });
  try {
    if (worker) await until(() => f.swarm.metrics().core.transferWorker.state === 'ready');
    const ctx = { url, responseType: 'arraybuffer', frag: { ...multiContext.frag, url,
      baseurl: new URL('index.m3u8', url).href, start: 10, duration: 2 } };
    f.hls.media = { currentTime: 10, paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1,
      buffered: { length: 0 } };
    // Measure the actual source with no holder claim; the new demand must
    // calibrate this same admitted link without a seeded rate or prior probe.
    if (!knownFlow) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    sameBytes(await f.load(ctx), bytes, 'actual whole-source control trains origin timing without fabricated samples');
    assert.equal(requests.length, 1); assert.equal(requests[0].status, 200); assert.equal(requests[0].sent, size);
    await sleep(2); // Let the old calibration request's real cancellation EOF retire.
    for (const pc of f.connections) pc.connectionState = 'connected';
    if (!knownFlow) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [f.key] }));
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    const before = f.swarm.metrics(), peerBefore = before.bytes.peerFirst;
    if (knownFlow) assert(before.peerRequestDiagnostics.records.some(row => row.outcome === 'payload' && row.elapsedMs - row.firstByteMs >= 300),
      'established rate must come from real prior qualifying peer payload');
    else assert.equal(before.peerRequestDiagnostics.records.length, 0, 'source calibration must not ask the untrained holder');
    const wantsBefore = f.channels[0].wants.length, observedBefore = observed.length;
    const authority = { media: f.hls.media, buffered: f.hls.media.buffered, frag: ctx.frag,
      start: ctx.frag.start, duration: ctx.frag.duration, pc: f.connections[0], channel: f.channels[0] };
    if (forceSetupExpiry) bridge.workers[0].holdNew = true;
    if (forceScopeExpiry) callbackPause.armed = true;
    const calls = { success: 0, error: 0, abort: 0, timeout: 0 };
    const response = new Promise((resolve, reject) => new f.hls.config.fLoader(f.hlsConfig).load(ctx, f.loaderConfig, {
      onSuccess: value => { calls.success++; resolve(new Uint8Array(value.data)); },
      onError: () => { calls.error++; reject(new Error('fixture source error')); },
      onAbort: () => { calls.abort++; reject(new Error('fixture source abort')); },
      onTimeout: () => { calls.timeout++; reject(new Error('fixture source timeout')); },
    }));
    if (forceSetupExpiry) {
      try { await until(() => bridge.workers[0].newRequests?.length > 0); }
      catch (error) {
        try {
          const number = value => Number.isFinite(value) ? value : null;
          const numbers = (value, names) => Object.fromEntries(names.map(name => [name, number(value?.[name])]));
          const label = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/iu.test(value) && !/^[a-f0-9]{32,}$/iu.test(value) ? value : null;
          const delta = (value, prior) => Number.isFinite(value) && Number.isFinite(prior) ? value - prior : null;
          const trace = f.swarm.trace(), metrics = f.swarm.metrics();
          const selectedLoad = trace.rows.filter(row => row.k === 'mixedScope' && row.reason === 'entry').at(-1)?.load ??
            trace.rows.filter(row => row.k === 'load' && row.sn === ctx.frag.sn && row.cc === ctx.frag.cc && row.level === ctx.frag.level).at(-1)?.load;
          const rows = trace.rows.filter(row => row.load === selectedLoad &&
            ['load', 'mixedScope', 'xfer', 'xferFinish', 'request', 'origin', 'originStart', 'originProgress', 'originTerminal'].includes(row.k));
          const project = row => ({ ...numbers(row, ['load', 'at', 'ms', 'sn', 'cc', 'level', 'budgetMs', 'limitMs', 'size', 'pieces', 'pieceSize',
              'deadline', 'setupRemainingMs', 'peerRemainingMs', 'recoveryRemainingMs', 'mixedRemainingMs', 'nextOriginReserveMs', 'firstByteRemainingMs',
              'verifiedBytes', 'originBytes', 'bytes', 'loaderLoadedBytes', 'loaderTotalBytes']),
            ...Object.fromEntries(['k', 'op', 'phase', 'reason', 'leg', 'outcome'].map(name => [name, label(row[name])])),
            ...Object.fromEntries(['originInvoked', 'ranged', 'delivered', 'bufferedMixed', 'peerOnly', 'exclusiveOrigin'].map(name =>
              [name, typeof row[name] === 'boolean' ? row[name] : null])),
            scope: row.scope ? Object.fromEntries(MIXED_SCOPE_CHECKS.map(name => [name, typeof row.scope[name] === 'boolean' ? row.scope[name] : null])) : null,
            capturedGeometry: row.capturedGeometry ? numbers(row.capturedGeometry, ['currentTime', 'playableEnd', 'fragmentStart', 'durationMs', 'fragmentDurationSeconds', 'originReserveMs']) : null,
            currentGeometry: row.currentGeometry ? numbers(row.currentGeometry, ['fragmentStart', 'fragmentDurationSeconds', 'playbackRate', 'readyState']) : null,
          });
          const summary = values => Object.fromEntries([['whole', false], ['range', true]].map(([name, ranged]) => {
            const selected = values.filter(row => Boolean(row.range) === ranged);
            return [name, { count: selected.length, complete: selected.filter(row => row.complete === true).length,
              aborted: selected.filter(row => row.aborted === true).length,
              statuses: selected.slice(-4).map(row => number(row.status)),
              bytes: selected.reduce((sum, row) => sum + (number(row.bytes ?? row.sent) ?? 0), 0) }];
          }));
          const rpcRows = rpc.slice(-32).map(row => ({ ...numbers(row, ['id', 'sentAtMs', 'replyAtMs']), op: label(row.op), success: row.success === true }));
          const pendingRpc = bridge.workers.flatMap(value => [...(value.rpcSent?.values() ?? [])]).slice(-32)
            .map(row => ({ ...numbers(row, ['id', 'sentAtMs']), op: label(row.op) }));
          const selectedRows = rows.length <= 32 ? rows : [...rows.slice(0, 16), ...rows.slice(-16)];
          const diagnostic = { fixture: 'held-mixed-allocation-precondition', atMs: performance.now(), requiredPredicateObserved: false,
            newRequests: bridge.workers.reduce((sum, value) => sum + (value.newRequests?.length ?? 0), 0),
            totalNewPosts: bridge.workers.reduce((sum, value) => sum + (value.newCount ?? 0), 0), calls: { ...calls },
            rpc: rpcRows, pendingRpc, rpcDropped: bridge.workers.reduce((sum, value) => sum + (value.rpcDropped ?? 0), 0),
            requests: summary(requests), received: summary(received),
            receivedTiming: received.slice(-4).map(row => ({ ...numbers(row, ['sdkEnteredAtMs', 'invokedAtMs', 'completedAtMs', 'maxLoadTimeMs', 'maxTimeToFirstByteMs', 'bytes', 'status']),
              ranged: Boolean(row.range), complete: row.complete === true, aborted: row.aborted === true })),
            metricsDeltas: { coreTransfers: delta(metrics.core.multiHolder.transfers, before.core.multiHolder.transfers),
              originRangeAttempts: delta(metrics.core.multiHolder.originRanges, before.core.multiHolder.originRanges),
              peerRequests: f.channels[0].wants.length - wantsBefore, acceptedPeerBytes: delta(metrics.bytes.peerFirst, peerBefore) },
            trace: { dropped: trace.dropped, selectedLoad: number(selectedLoad), originalRows: rows.length,
              omittedRows: rows.length - selectedRows.length, rows: selectedRows.map(project) } };
          while (Buffer.byteLength(JSON.stringify(diagnostic)) > 16384 && diagnostic.trace.rows.length) {
            diagnostic.trace.rows.splice(Math.floor(diagnostic.trace.rows.length / 2), 1); diagnostic.trace.omittedRows++;
          }
          t.diagnostic(JSON.stringify(diagnostic));
        } catch { t.diagnostic(JSON.stringify({ fixture: 'held-mixed-allocation-precondition', diagnosticUnavailable: true })); }
        throw error; // The required held RPC, original predicate and timeout remain mandatory.
      }
      await sleep(30); // Actual reply unavailability exceeds the original25ms; no clock or deadline is changed.
      bridge.workers[0].releaseNew();
    }
    sameBytes(await response, bytes, 'one complete correct object reaches the genuine demand');
    assert.deepEqual(calls, { success: 1, error: 0, abort: 0, timeout: 0 });
    const trace = f.swarm.trace(), start = trace.rows.filter(row => row.k === 'xfer' && row.op === 'start').at(-1);
    const mixedLoad = trace.rows.filter(row => row.k === 'mixedScope' && row.reason === 'entry').at(-1)?.load;
    const diagnosticRows = trace.rows.filter(row => row.load === mixedLoad &&
      ['load', 'mixedScope', 'xfer', 'xferFinish', 'request', 'origin', 'originStart', 'originProgress', 'originTerminal'].includes(row.k));
    if (forceScopeExpiry) { assert.equal(callbackPause.calls, 1); assert(callbackPause.finishedAtMs - callbackPause.startedAtMs >= 30); }
    if (requests.filter(row => !row.range).length !== 1) {
      const fallback = received.at(-1), metrics = f.swarm.metrics(), enteredAt = fallback.sdkEnteredAtMs, cutoff = enteredAt + 25;
      const timer = fallback.invocationProbe;
      const boundedTimer = timer && Number.isFinite(timer.scheduledAtMs) && timer.scheduledAtMs >= enteredAt &&
        timer.scheduledAtMs <= cutoff && Number.isFinite(timer.requestedDelayMs) && timer.requestedDelayMs >= 0 && timer.requestedDelayMs <= 25 &&
        Number.isFinite(timer.firedAtMs) && timer.firedAtMs >= timer.scheduledAtMs && timer.firedAtMs <= fallback.invokedAtMs;
      const pendingAtTimer = boundedTimer && rpc.find(row => row.success && ['new', 'start'].includes(row.op) &&
        row.sentAtMs >= enteredAt && row.sentAtMs <= timer.firedAtMs && timer.firedAtMs <= row.replyAtMs);
      const lateReply = rpc.find(row => row.success && ['new', 'start'].includes(row.op) &&
        row.sentAtMs >= enteredAt && row.sentAtMs < cutoff && row.replyAtMs >= cutoff && row.replyAtMs <= fallback.invokedAtMs);
      const scopeProof = mixedScopeSetupProof(trace, { load: mixedLoad, sn: ctx.frag.sn, cc: ctx.frag.cc, level: ctx.frag.level,
        fragmentStart: authority.start, fragmentDurationSeconds: authority.duration, enteredAtMs: enteredAt, invokedAtMs: fallback.invokedAtMs,
        parentMs: f.loaderConfig.loadPolicy.maxLoadTimeMs, ttfbMs: f.loaderConfig.loadPolicy.maxTimeToFirstByteMs,
        remainingLoadMs: fallback.maxLoadTimeMs, remainingTtfbMs: fallback.maxTimeToFirstByteMs,
        coreTransfersDelta: metrics.core.multiHolder.transfers - before.core.multiHolder.transfers,
        size, originRangeAttempts: metrics.core.multiHolder.originRanges - before.core.multiHolder.originRanges,
        physicalRangeGets: requests.filter(row => row.range).length, clientRangeLoads: received.filter(row => row.range).length,
        peerRequests: f.channels[0].wants.length - wantsBefore, acceptedPeerBytes: metrics.bytes.peerFirst - peerBefore });
      const proofTime = pendingAtTimer ? timer.firedAtMs : lateReply?.replyAtMs ?? scopeProof?.proofTime;
      assert(Number.isFinite(enteredAt) && enteredAt > 0 && Number.isFinite(proofTime) && (worker && (pendingAtTimer || lateReply) || scopeProof),
        JSON.stringify({ message: 'whole fallback needs an observed pending-RPC timer, completed exact late RPC, or actual same-load setup-scope proof',
          knownFlow, worker, rpc, timer, enteredAt, invokedAtMs: fallback.invokedAtMs,
          remainingLoadMs: fallback.maxLoadTimeMs, remainingTtfbMs: fallback.maxTimeToFirstByteMs,
          callbackPause: forceScopeExpiry ? callbackPause : null, mixedLoad, traceDropped: trace.dropped,
          counters: { coreTransfers: metrics.core.multiHolder.transfers - before.core.multiHolder.transfers,
            originRangeAttempts: metrics.core.multiHolder.originRanges - before.core.multiHolder.originRanges,
            peerRequests: f.channels[0].wants.length - wantsBefore, acceptedPeerBytes: metrics.bytes.peerFirst - peerBefore,
            physicalWholeGets: requests.filter(row => !row.range).length, physicalRangeGets: requests.filter(row => row.range).length,
            clientRangeBodies: received.filter(row => row.range).length, successfulCallbacks: calls.success },
          diagnosticRows: diagnosticRows.length <= 64 ? diagnosticRows : [...diagnosticRows.slice(0, 32), ...diagnosticRows.slice(-32)],
          diagnosticRowsOmitted: Math.max(0, diagnosticRows.length - 64) }));
      assert(fallback.invokedAtMs >= proofTime, 'the real source invocation follows its observed setup-decline proof');
      if (forceSetupExpiry) assert(pendingAtTimer, 'held allocation must exercise the actual timer-context proof');
      if (forceScopeExpiry) assert(scopeProof, 'the real callback pause must exercise the exact SDK scope predicate proof');
      assert.equal(requests.length, 2); assert(requests.every(row => !row.range && row.status === 200 && row.complete && row.sent === size));
      assert.equal(received.length, 2); assert(received.every(row => !row.range && row.complete && row.bytes === size));
      assert.equal(f.channels[0].wants.length, wantsBefore, 'decline issues no demand peer request');
      assert.equal(metrics.bytes.peerFirst, peerBefore); assert.equal(observed.length, observedBefore);
      const attemptedOriginRanges = metrics.core.multiHolder.originRanges - before.core.multiHolder.originRanges;
      assert.equal(attemptedOriginRanges, scopeProof?.stage === 'after-core-before-io' ? 1 : 0,
        'a rejected pre-invocation origin attempt is counted honestly; physical Range GETs remain zero');
      const proofElapsed = proofTime - enteredAt, invokedElapsed = fallback.invokedAtMs - enteredAt;
      assert(fallback.maxLoadTimeMs > 0 && fallback.maxLoadTimeMs <= f.loaderConfig.loadPolicy.maxLoadTimeMs - proofElapsed);
      assert(fallback.maxLoadTimeMs >= f.loaderConfig.loadPolicy.maxLoadTimeMs - invokedElapsed,
        'the parent config is prepared between the observed proof and actual source invocation');
      assert(fallback.maxTimeToFirstByteMs > 0 && fallback.maxTimeToFirstByteMs <= f.loaderConfig.loadPolicy.maxTimeToFirstByteMs - proofElapsed);
      assert(fallback.maxTimeToFirstByteMs >= f.loaderConfig.loadPolicy.maxTimeToFirstByteMs - invokedElapsed,
        'the original first-byte config is prepared in the same observed interval');
      assert(fallback.completedAtMs < enteredAt + Math.min(f.loaderConfig.loadPolicy.maxLoadTimeMs, 10000));
      assert.equal(metrics.core?.state, 'ready'); assert.equal(metrics.core?.transferWorker?.state, worker ? 'ready' : 'off');
      if (worker) { assert.equal(metrics.core.transferWorker.transfers, 0); assert.equal(metrics.core.transferWorker.pending, 0); }
      else assert.deepEqual(metrics.core.transferWorker, before.core.transferWorker, 'main-thread fallback preserves its disabled worker configuration');
      assert.equal(metrics.core.fallbacks, before.core.fallbacks); assert.equal(metrics.errors.total, before.errors.total);
      assert.equal(metrics.segments.commitmentRejected, before.segments.commitmentRejected);
      assert.equal(metrics.segments.commitmentUnavailable, before.segments.commitmentUnavailable);
      assert.equal(f.hls.media, authority.media); assert.equal(ctx.frag, authority.frag);
      assert.equal(ctx.frag.start, authority.start); assert.equal(ctx.frag.duration, authority.duration);
      assert.equal(authority.media.buffered, authority.buffered); assert.equal(authority.buffered.end(0), 20);
      assert.equal(authority.media.currentTime, 10); assert.equal(authority.media.playbackRate, 1);
      assert.equal(authority.media.paused || authority.media.ended || authority.media.seeking, false);
      assert(authority.media.readyState >= 3);
      assert.equal(f.connections[0], authority.pc); assert.equal(authority.pc.connectionState, 'connected');
      assert.equal(f.channels[0], authority.channel); assert.equal(authority.channel.readyState, 'open');
      if (worker) assert(bridge.workers.every(value => !value.rpcDropped));
      assert.deepEqual(calls, { success: 1, error: 0, abort: 0, timeout: 0 });
      console.log(JSON.stringify({ fixture: 'buffered-mixed-206', outcome: pendingAtTimer ? 'observed-timer-yield' : lateReply ? 'proven-exact-late-rpc' : 'proven-setup-scope', knownFlow, worker,
        setupBudgetMs: 25, enteredAtMs: enteredAt, timer, proofTimeMs: proofTime,
        setupRpc: pendingAtTimer || lateReply || null, scopeProof, callbackPause: forceScopeExpiry ? callbackPause : null,
        sourceInvokedAtMs: fallback.invokedAtMs,
        remainingLoadMs: fallback.maxLoadTimeMs, remainingTtfbMs: fallback.maxTimeToFirstByteMs,
        wholeDemandGets: 1, originRangeAttempts: attemptedOriginRanges, physicalRangeGets: 0, clientRangeLoads: 0,
        demandPeerRequests: 0, acceptedDemandPeerBytes: 0 }));
      return;
    }
    assert.equal(forceSetupExpiry, false, 'held allocation must prove the guarded-decline branch');
    assert.equal(forceScopeExpiry, false, 'the real callback pause must prove the SDK setup-scope decline branch');
    if (!start) {
      const m = f.swarm.metrics();
      assert.ok(start, JSON.stringify({ message: 'mixed transfer did not record a Core start', knownFlow, worker,
        traceDropped: trace.dropped, trace: trace.rows.slice(-16).map(({ k, load, at, op, leg, ms, budgetMs, limitMs, reason, outcome, ranged, stale }) =>
          ({ k, load, at, op, leg, ms, budgetMs, limitMs, reason, outcome, ranged, stale })),
        counters: { originFallbacks: m.segments.originFallbacks, peerNoFit: m.segments.peerNoFit,
          commitmentRequests: m.segments.commitmentRequests, commitmentRejected: m.segments.commitmentRejected,
          commitmentUnavailable: m.segments.commitmentUnavailable, coreFallbacks: m.core?.fallbacks ?? null,
          transfers: m.core?.multiHolder?.transfers ?? null, noModelTransfers: m.core?.multiHolder?.peerFlow?.noModelTransfers ?? null },
        workerState: m.core?.transferWorker?.state ?? null,
        http: { requests: requests.length, wholeGets: requests.filter(row => !row.range).length,
          rangeGets: requests.filter(row => row.range).length, completed: received.filter(row => row.complete).length,
          aborted: received.filter(row => row.aborted).length,
          serverSubmittedBytes: requests.reduce((total, row) => total + row.sent, 0),
          clientReceivedBytes: received.reduce((total, row) => total + row.bytes, 0) } }));
    }
    assert.equal(start.exclusiveOrigin, true, 'only the opted mixed plan requests exclusive Core origin ownership');
    if (knownFlow) {
      assert.deepEqual(start.probePeers, [], 'known mixed ownership uses real measured same-link holders');
      assert(start.peers.length && start.peers.every(([, first, rate]) => Number.isFinite(first) && first >= 0 && Number.isFinite(rate) && rate > 0));
    } else {
      assert.deepEqual(start.probePeers, [start.peers[0][0]], 'the genuine unknown-link demand uses the existing one-piece allowance');
      assert(start.peers.every(([, first, rate]) => first === null && rate === null), 'no rate or first-byte estimate is invented');
      const initialPeer = start.out.c.filter(row => row.t === 'request');
      assert.equal(initialPeer.length, 1); assert.equal(initialPeer[0].p[1] - initialPeer[0].p[0], 1);
    }
    assert(start.out.c.some(row => row.t === 'origin') && start.out.c.some(row => row.t === 'request'),
      'the genuine demand must accept its peer fraction alongside disjoint origin ranges');
    const metrics = f.swarm.metrics(), ranged = requests.filter(row => row.range);
    assert.equal(requests.filter(row => !row.range).length, 1, JSON.stringify({ message: 'there is no whole GET beside the mixed range arm',
      requests, transfer: f.swarm.metrics().core.multiHolder, trace: f.swarm.trace().rows.slice(-12) }));
    assert(ranged.length > 0); assert(ranged.every(row => row.status === 206 && row.complete), JSON.stringify(requests));
    const clientRanges = received.filter(row => row.range);
    assert(clientRanges.length > 0 && clientRanges.every(row => row.status === 206 && row.complete && row.bytes === row.range[1] - row.range[0]));
    const clientBodyBytes = clientRanges.reduce((total, row) => total + row.bytes, 0);
    const peer = metrics.bytes.peerFirst - peerBefore, source = ranged.reduce((total, row) => total + row.sent, 0);
    assert(peer > 0 && peer < size);
    const verifiedOrigin = metrics.core.multiHolder.originBytes - before.core.multiHolder.originBytes;
    assert.equal(verifiedOrigin + peer, size, 'only fresh verified origins and peer pieces compose accepted media');
    assert.equal(clientBodyBytes, source, 'complete HTTP client bodies agree with server submitted bytes in this controlled fixture');
    assert.equal(clientBodyBytes + peer, size, 'actual complete source and accepted peer bodies have disjoint ownership');
    assert(source >= verifiedOrigin, 'actual206 bodies include any duplicated/unused range bytes');
    const { replay } = await import('../scripts/trace-report.mjs'), replayCore = await loadCore(multiCore);
    try {
      const calls = f.swarm.trace().rows.filter(row => row.k === 'xfer' && row.load === start.load);
      assert.equal(replay(replayCore, calls), null, 'exclusive ownership survives trace reconstruction');
    } finally { replayCore.retire(); }
    console.log(JSON.stringify({ fixture: 'buffered-mixed-206', knownFlow, worker, actualClient206BodyBytes: clientBodyBytes, serverSubmitted206Bytes: source, objectBytes: size, acceptedPeerBytes: peer,
      freshOriginBytes: verifiedOrigin, actualComplete206BodyBytes: source,
      actual206Bodies: ranged.map(({ sent, status, complete }) => ({ bytes: sent, status, complete })),
      priorWholeSourceBytes: requests[0].sent, additionalWholeGets: requests.filter(row => !row.range).length - 1,
      configuredPeerBytesPerSecond: .3 * 1024 * 1024, configuredOriginBytesPerSecond: 3 * 1024 * 1024 }));
    assert.equal(observed.reduce((sum, row) => sum + row.bytes, 0), peer);
    assert.equal(metrics.segments.zeroBudgetPeerRaceWins, 0, 'mixed delivery is not a peer-only whole-object race');
  } finally { try { await f.close(); } finally { timers.restore(); } }
});

// Functional controller clock, not elapsed/throughput evidence. Ten-ms batches
// avoid one real Windows timer per virtual millisecond, and an ordinary logical
// step yields to the event loop with a captured setImmediate, which does not
// depend on native timer granularity (mock timers here cover only setTimeout
// and Date). A real timer wait remains only while the caller reports that
// actual setup work is pending, or while actual native work is in flight: a
// worker-thread reply (nativeWorkProbes) or a Web Crypto digest observed here.
// Both hold logical time, so work on other threads never costs logical
// milliseconds, and neither is a throughput or latency claim. During the explicitly admitted warm setup
// phase only, leave policy time fixed while real metadata and Worker messages
// complete; source/peer pacing then uses the same clocks and original
// deadlines. No model, HAVE, source body or Core result is seeded.
function warmFunctionalClock(t, awaitingSetup, observeTimers = false) {
  const nativeTimer = setTimeout, nativeImmediate = setImmediate, nativeNow = performance.now.bind(performance);
  const waits = { timer: 0, immediate: 0 };
  const nativeTimerWait = () => new Promise(resolve => { waits.timer++; nativeTimer(resolve, 1); });
  const nativeYield = () => new Promise(resolve => { waits.immediate++; nativeImmediate(resolve); });
  let at = Math.ceil(nativeNow()), heldSince = null, nativeHeldSince = null, setupReleasedAt = null;
  // Count every pending Web Crypto digest. Installed by assignment so that a
  // fixture wrapper installed before or after this one restores independently.
  const subtle = crypto.subtle, outerDigest = subtle.digest;
  let pendingDigests = 0, digestsObserved = true;
  const countedDigest = function (...args) {
    if (!digestsObserved) return Reflect.apply(outerDigest, this, args);
    let result; pendingDigests++;
    try { result = Reflect.apply(outerDigest, this, args); } catch (error) { pendingDigests--; throw error; }
    return Promise.resolve(result).finally(() => { pendingDigests--; });
  };
  subtle.digest = countedDigest;
  const nativeBusy = () => pendingDigests > 0 || [...nativeWorkProbes].some(probe => probe());
  const performanceMock = t.mock.method(performance, 'now', () => at);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  // For the forced-RPC functional control, observe the unchanged timer API
  // after the logical scheduler is installed; this is not a native-time claim.
  const timerObserver = observeTimers ? realTimerInvocationContext() : null;
  const step = async (ms = 10) => {
    await nativeYield();
    if (awaitingSetup()) {
      heldSince ??= nativeNow();
      assert(nativeNow() - heldSince < 2000, 'functional warm setup must finish its actual async work');
      await nativeTimerWait();
      return;
    }
    if (nativeBusy()) {
      nativeHeldSince ??= nativeNow();
      assert(nativeNow() - nativeHeldSince < 2000, 'functional clock native work must finish');
      await nativeTimerWait();
      return;
    }
    nativeHeldSince = null;
    if (observeTimers && heldSince !== null) setupReleasedAt = at;
    heldSince = null;
    // Hit the unchanged setup boundary exactly, then resume ordinary batches.
    const elapsed = setupReleasedAt === null ? null : at - setupReleasedAt;
    const advanceMs = observeTimers && elapsed !== null && elapsed < 25 ? Math.min(ms, 25 - elapsed) : ms;
    at += advanceMs; t.mock.timers.tick(advanceMs);
  };
  const advanceUntil = async (predicate, limitMs = 10000) => {
    const begin = at, wall = nativeNow();
    while (!predicate()) {
      assert(at - begin <= limitMs && nativeNow() - wall < 15000, 'functional warm phase did not settle');
      await step();
    }
  };
  const settle = async promise => {
    let result;
    promise.then(value => { result = { value }; }, error => { result = { error }; });
    await advanceUntil(() => result);
    if (result.error) throw result.error;
    return result.value;
  };
  let restored = false;
  const restore = () => {
    if (!restored) {
      restored = true; digestsObserved = false; if (subtle.digest === countedDigest) subtle.digest = outerDigest;
      timerObserver?.restore(); t.mock.timers.reset(); performanceMock.mock.restore(); } };
  t.after(restore);
  return { settle, advanceUntil, timerSnapshot: timerObserver?.snapshot, nativeWaits: () => ({ ...waits }),
    pendingDigests: () => pendingDigests, nativeBusy,
    advance: async ms => { for (let done = 0; done < ms; done += 10) await step(Math.min(10, ms - done)); }, restore };
}

test('functional clock: an idle ten-second logical advance does not depend on native timer granularity', async t => {
  let awaiting = false;
  const realNow = performance.now.bind(performance); // captured before the clock mocks it
  const clock = warmFunctionalClock(t, () => awaiting);
  try {
    const begin = realNow(), logicalBegin = Date.now();
    await clock.advance(10000);
    const wall = realNow() - begin, waits = clock.nativeWaits();
    assert.equal(Date.now() - logicalBegin, 10000, 'the logical clock moved exactly ten seconds');
    assert.equal(waits.timer, 0, 'an idle advance performs no native timer wait: ' + JSON.stringify(waits));
    assert.equal(waits.immediate, 1000, 'one captured native yield per ten-ms logical step');
    assert(wall < 1000, 'ten logical seconds take well under one second of wall time: ' + wall);
    // A real timer wait is kept only while setup is explicitly awaited.
    awaiting = true; const held = Date.now();
    await clock.advance(30);
    assert.equal(clock.nativeWaits().timer - waits.timer, 3, 'a step that awaits setup keeps its real timer wait');
    assert.equal(Date.now(), held, 'logical time is held while setup work is awaited');
    awaiting = false;
    // Actual native work in flight also holds logical time: a worker-thread
    // probe (two busy steps) and a Web Crypto digest observed by the clock.
    let busy = 2; const probe = () => busy-- > 0, timersBefore = clock.nativeWaits().timer, mark = Date.now();
    nativeWorkProbes.add(probe);
    try { await clock.advance(30); } finally { nativeWorkProbes.delete(probe); }
    assert.equal(clock.nativeWaits().timer - timersBefore, 2, 'busy steps keep one real timer wait each');
    assert.equal(Date.now() - mark, 10, 'only the step after the work finished moved logical time');
    const digest = crypto.subtle.digest('SHA-256', new Uint8Array(8));
    assert.equal(clock.pendingDigests(), 1); assert.equal(clock.nativeBusy(), true);
    await digest; await null;
    assert.equal(clock.pendingDigests(), 0); assert.equal(clock.nativeBusy(), false);
  } finally { clock.restore(); }
});

// Actual real-clock optional admission needs a complete same-load observation,
// not an elapsed-time inference. The incomplete897 diagnostic is NOT such a
// receipt: it omitted the timer schedule, RPC handle and source config budgets.
function warmSetupDeclineProof({ trace, expected, timer, rpc }) {
  try {
    if (trace.dropped !== 0 || !Array.isArray(trace.rows) || expected.rpcDropped !== 0 ||
        expected.rpcOmitted !== 0 || expected.rowsOmitted !== 0 || !Array.isArray(rpc) ||
        ['originRangeAttempts', 'physicalRangeGets', 'clientRangeLoads', 'peerRequests', 'acceptedPeerBytes', 'verifiedWarmPeerBytes']
          .some(name => expected[name] !== 0)) return null;
    const rows = trace.rows.filter(row => row.load === expected.load), load = rows.find(row => row.k === 'load');
    if (!load || load.budgetGeometry?.source !== 'warm-ahead' || load.sn !== expected.sn ||
        load.cc !== expected.cc || load.level !== expected.level || !Number.isSafeInteger(expected.load)) return null;
    if (rows.some(row => row.k === 'mixedScope' && row.scope && row.scope.warmOwner !== true)) return null;
    const normalized = { dropped: trace.dropped, rows: trace.rows.map(row => {
      if (!row.scope) return row;
      const { warmOwner, ...scope } = row.scope;
      return { ...row, scope };
    }) };
    const scope = mixedScopeSetupProof(normalized, expected);
    if (scope) return { ...scope, stage: 'warm-' + scope.stage };
    const entry = rows.findIndex(row => row.k === 'mixedScope' && row.reason === 'entry');
    const fired = rows.findIndex(row => row.k === 'mixedScope' && row.reason === 'setup-timer');
    const origin = rows.findIndex(row => row.k === 'originStart');
    if (!(entry > 0 && entry < fired && fired < origin) || rows.some(row => row.k === 'request' || row.k === 'xfer') ||
        rows.slice(0, origin).some(row => row.k === 'origin') ||
        rows.filter(row => row.k === 'mixedScope' && row.phase === 'mixed').length !== 2) return null;
    const state = rows[fired].scope, checks = [...MIXED_SCOPE_CHECKS, 'warmOwner'];
    if (!state || Object.keys(state).length !== checks.length || checks.some(name => state[name] !== true) ||
        rows[fired].originInvoked !== false || rows[fired].phase !== 'mixed' ||
        rows[origin].leg !== 'fallback' || rows[origin].ranged !== false || rows[origin].ms !== 0) return null;
    const at = expected.enteredAtMs, invoked = expected.invokedAtMs, cutoff = at + 25;
    if (![at, invoked, timer?.scheduledAtMs, timer?.requestedDelayMs, timer?.firedAtMs].every(Number.isFinite) ||
        !(at > 0 && timer.scheduledAtMs >= at && timer.scheduledAtMs <= cutoff && timer.requestedDelayMs >= 0 &&
          timer.requestedDelayMs <= 25 && timer.firedAtMs >= timer.scheduledAtMs && invoked >= timer.firedAtMs)) return null;
    const g = rows[fired].capturedGeometry, current = rows[fired].currentGeometry;
    if (!g || !current || load.budgetMs !== 0 || !(load.limitMs > 25) ||
        g.fragmentStart !== expected.fragmentStart || g.fragmentDurationSeconds !== expected.fragmentDurationSeconds ||
        current.fragmentStart !== g.fragmentStart || current.fragmentDurationSeconds !== g.fragmentDurationSeconds ||
        current.playbackRate !== 1 || !(current.readyState >= 3) ||
        ['currentTime', 'playableEnd', 'fragmentStart', 'durationMs', 'originReserveMs'].some(name =>
          !Number.isFinite(g[name]) || load.budgetGeometry[name] !== g[name])) return null;
    const recovery = Math.min(expected.parentMs, (g.playableEnd - g.currentTime) * 1000), first = Math.min(recovery, expected.ttfbMs);
    const proofElapsed = timer.firedAtMs - at, invokedElapsed = invoked - at;
    if (!(recovery > 25 && first > 25 && expected.remainingLoadMs > 0 && expected.remainingTtfbMs > 0 &&
        expected.remainingLoadMs <= recovery - proofElapsed && expected.remainingLoadMs >= recovery - invokedElapsed &&
        expected.remainingTtfbMs <= first - proofElapsed && expected.remainingTtfbMs >= first - invokedElapsed)) return null;
    const allocated = rpc.filter(row => row.op === 'new' && row.sentAtMs >= at && row.sentAtMs <= invoked);
    if (allocated.length !== 1) return null;
    const allocation = allocated[0], starts = rpc.filter(row => row.op === 'start' && row.sentAtMs >= at && row.sentAtMs <= invoked);
    if (!Number.isSafeInteger(allocation.id) || allocation.id < 1 || allocation.success !== true ||
        !Number.isSafeInteger(allocation.handle) || allocation.handle < 1 || allocation.configSize !== expected.size ||
        allocation.exclusiveOrigin !== true || allocation.peerOnly !== false ||
        allocation.configDeadline !== Math.floor(at + load.limitMs) || starts.length > 1 ||
        starts.some(row => !Number.isSafeInteger(row.id) || row.id <= allocation.id || row.handle !== allocation.handle || row.sentAtMs < allocation.replyAtMs)) return null;
    const pending = [allocation, ...starts].find(row => row.success === true && Number.isFinite(row.sentAtMs) &&
      Number.isFinite(row.replyAtMs) && row.sentAtMs <= timer.firedAtMs && timer.firedAtMs <= row.replyAtMs);
    const finishes = rows.filter(row => row.k === 'xferFinish');
    const finishIndex = rows.findIndex(row => row.k === 'xferFinish');
    // Aborting a pending NEW rejects its awaited allocation on a later
    // microtask. Independent whole-source recovery may already have started;
    // neither a Worker allocation acknowledgement nor cleanup is Core START.
    if (expected.coreTransfersDelta === 0 && pending === allocation && starts.length === 0 &&
        allocation.sentAtMs <= timer.firedAtMs && invoked <= allocation.replyAtMs &&
        fired < origin && origin < finishIndex) {
      const finished = finishes[0], recent = rpc.filter(row => row.sentAtMs >= at);
      if (rows[0] !== load || rows.filter(row => row.k === 'load').length !== 1 || finishes.length !== 1 ||
          rows.filter(row => row.k === 'originStart').length !== 1 || recent.length !== 1 || recent[0] !== allocation ||
          new Set(rpc.map(row => row.id)).size !== rpc.length ||
          rpc.some(row => !['new', 'start'].includes(row.op) || !Number.isSafeInteger(row.id) || row.id < 1 ||
            !Number.isSafeInteger(row.handle) || row.handle < 1 || !Number.isFinite(row.sentAtMs) ||
            !Number.isFinite(row.replyAtMs) || row.sentAtMs > row.replyAtMs || row !== allocation && row.handle === allocation.handle) ||
          rows.some(row => row.k === 'origin' && row.ranged === true) ||
          [rows[0], rows[entry], rows[fired], rows[origin], finished].some((row, i, sequence) =>
            !Number.isSafeInteger(row?.at) || row.at < 0 || i > 0 && row.at < sequence[i - 1].at) ||
          ![expected.parentMs, expected.ttfbMs].every(Number.isFinite) || g.durationMs !== expected.fragmentDurationSeconds * 1000 ||
          finished.reason !== 'allocation-error' || finished.delivered !== false || finished.bufferedMixed !== true ||
          finished.peerOnly !== false || finished.verifiedBytes !== 0 || finished.originBytes !== 0 ||
          ![finished.ms, finished.peerRemainingMs, finished.recoveryRemainingMs].every(Number.isFinite) || finished.ms < 0 ||
          !(finished.peerRemainingMs > 0 && finished.recoveryRemainingMs > 0)) return null;
      return { stage: 'warm-pending-new-cleanup-after-origin', proofTime: timer.firedAtMs, rpc: allocation };
    }
    if (rows.filter(row => row.k === 'load').length !== 1 ||
        [rows[0], rows[entry], rows[fired], rows[finishIndex], rows[origin]].some((row, i, sequence) =>
          !Number.isSafeInteger(row?.at) || row.at < 0 || i > 0 && row.at < sequence[i - 1].at) ||
        !(fired < finishIndex && finishIndex < origin)) return null;
    // Captured cc6: NEW replied before the cutoff, no START was posted, and
    // the original setup timer actually fired after entry+25. No pending RPC
    // is needed to prove that elapsed bound; keep its older proof separate.
    if (!pending && expected.coreTransfersDelta === 1 && starts.length === 0 &&
        Number.isFinite(allocation.sentAtMs) && Number.isFinite(allocation.replyAtMs) &&
        allocation.sentAtMs <= allocation.replyAtMs && allocation.replyAtMs < cutoff && timer.firedAtMs >= cutoff) {
      const finished = finishes[0], recent = rpc.filter(row => row.sentAtMs >= at);
      if (rows[0] !== load || finishes.length !== 1 || recent.length !== 1 || recent[0] !== allocation ||
          rpc.some(row => !['new', 'start'].includes(row.op) || !Number.isSafeInteger(row.id) || row.id < 1 ||
            !Number.isSafeInteger(row.handle) || row.handle < 1 || !Number.isFinite(row.sentAtMs) ||
            !Number.isFinite(row.replyAtMs) || row.sentAtMs > row.replyAtMs || row !== allocation &&
            (row.id === allocation.id || row.op === 'new' && row.handle === allocation.handle)) ||
          rows.some(row => row.k === 'origin' && row.ranged === true) ||
          !Number.isFinite(rows[fired].ms) || rows[fired].ms < 25 ||
          !Number.isFinite(rows[fired].setupRemainingMs) || rows[fired].setupRemainingMs > 0 ||
          ![expected.parentMs, expected.ttfbMs].every(Number.isFinite) || g.durationMs !== expected.fragmentDurationSeconds * 1000 ||
          finished.reason !== 'signal-abort' || finished.delivered !== false || finished.bufferedMixed !== true || finished.peerOnly !== false ||
          finished.verifiedBytes !== 0 || finished.originBytes !== 0 ||
          ![finished.ms, finished.peerRemainingMs, finished.recoveryRemainingMs].every(Number.isFinite) || finished.ms < 0 ||
          !(finished.peerRemainingMs > 0 && finished.recoveryRemainingMs > 0)) return null;
      return { stage: 'warm-protected-timer-after-precutoff-allocation', proofTime: timer.firedAtMs, rpc: allocation };
    }
    if (!pending || finishes.length !== 1 || finishes[0].delivered !== false || finishes[0].bufferedMixed !== true ||
        finishes[0].peerOnly !== false || finishes[0].verifiedBytes !== 0 || finishes[0].originBytes !== 0 ||
        ![0, 1].includes(expected.coreTransfersDelta) ||
        !(expected.coreTransfersDelta === 1 ? finishes[0].reason === 'signal-abort' && pending.op === 'start' :
          ['allocation-error', 'allocation-state-deadline-authority-holder'].includes(finishes[0].reason) && pending.op === 'new')) return null;
    return { stage: 'warm-observed-pending-rpc-timer', proofTime: timer.firedAtMs, rpc: pending };
  } catch { return null; }
}

test('owned warm pending NEW cleanup follows independent source recovery in the immutable capture', async () => {
  const raw = await readFile(new URL('./fixtures/owned-warm-pending-allocation-cleanup.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), '80a0ea59ffde2c95471f765a08ebfcc8eb0f399ff7f2edc32730bb1591c30449');
  const receipt = JSON.parse(raw);
  assert.equal(receipt.provenance.sourceCommit, '0ef581aa927d83d803ca7052eba8f72508ae2290');
  assert.equal(receipt.provenance.rawLogSha256, '1025ce7cb967c768896a9a68f3cf019d77d80b04e6cb7325b92247dff78ada8b');
  const proof = warmSetupDeclineProof(receipt.proofInput);
  assert.equal(proof?.stage, 'warm-pending-new-cleanup-after-origin');
  assert.equal(proof.proofTime, receipt.proofInput.timer.firedAtMs);
});

test('owned warm pending NEW cleanup rejects incomplete or contradictory evidence', async () => {
  const { proofInput: input } = JSON.parse(await readFile(new URL('./fixtures/owned-warm-pending-allocation-cleanup.json', import.meta.url)));
  assert.equal(warmSetupDeclineProof(input)?.stage, 'warm-pending-new-cleanup-after-origin');
  const row = (v, kind) => v.trace.rows.find(r => r.load === v.expected.load && r.k === kind);
  const fired = v => v.trace.rows.find(r => r.load === v.expected.load && r.reason === 'setup-timer');
  const allocation = v => v.rpc.find(r => r.op === 'new' && r.sentAtMs >= v.expected.enteredAtMs);
  const controls = [
    ['missing NEW', v => { v.rpc = v.rpc.filter(r => r !== allocation(v)); }],
    ['duplicate NEW', v => { v.rpc.push({ ...allocation(v) }); }],
    ['wrong NEW operation', v => { allocation(v).op = 'tick'; }],
    ['missing id', v => { delete allocation(v).id; }],
    ['invalid id', v => { allocation(v).id = 0; }],
    ['reused id', v => { allocation(v).id = v.rpc[0].id; }],
    ['missing handle', v => { delete allocation(v).handle; }],
    ['invalid handle', v => { allocation(v).handle = 0; }],
    ['reused handle', v => { allocation(v).handle = v.rpc[0].handle; }],
    ['historical START aliases target handle', v => { v.rpc.find(r => r.op === 'start').handle = allocation(v).handle; }],
    ['failed NEW', v => { allocation(v).success = false; }],
    ['wrong size', v => { allocation(v).configSize++; }],
    ['wrong deadline', v => { allocation(v).configDeadline++; }],
    ['nonexclusive', v => { allocation(v).exclusiveOrigin = false; }],
    ['peer-only', v => { allocation(v).peerOnly = true; }],
    ['not pending at timer', v => { allocation(v).replyAtMs = v.timer.firedAtMs - .1; }],
    ['not pending at source', v => { allocation(v).replyAtMs = (v.timer.firedAtMs + v.expected.invokedAtMs) / 2; }],
    ['NEW sent after timer', v => { allocation(v).sentAtMs = v.timer.firedAtMs + .1; }],
    ['nonfinite RPC time', v => { allocation(v).replyAtMs = NaN; }],
    ['unexpected START', v => { const a = allocation(v); v.rpc.push({ id: a.id + 1, op: 'start', handle: a.handle,
      sentAtMs: a.replyAtMs, replyAtMs: a.replyAtMs + 1, success: true }); }],
    ['Core command', v => { v.trace.rows.push({ k: 'xfer', load: v.expected.load, at: row(v, 'xferFinish').at, op: 'start' }); }],
    ['peer request trace', v => { v.trace.rows.push({ k: 'request', load: v.expected.load, at: row(v, 'xferFinish').at }); }],
    ['range trace', v => { v.trace.rows.push({ k: 'origin', load: v.expected.load, at: row(v, 'xferFinish').at, ranged: true }); }],
    ...['originRangeAttempts', 'physicalRangeGets', 'clientRangeLoads', 'peerRequests', 'acceptedPeerBytes', 'verifiedWarmPeerBytes', 'coreTransfersDelta']
      .map(name => [name, v => { v.expected[name] = 1; }]),
    ['missing source', v => { v.trace.rows = v.trace.rows.filter(r => r !== row(v, 'originStart')); }],
    ['duplicate source', v => { v.trace.rows.push({ ...row(v, 'originStart') }); }],
    ['nonfallback source', v => { row(v, 'originStart').leg = 'cached'; }],
    ['ranged source', v => { row(v, 'originStart').ranged = true; }],
    ['source precedes timer', v => { const r = row(v, 'originStart'); v.trace.rows.splice(v.trace.rows.indexOf(r), 1);
      v.trace.rows.splice(v.trace.rows.indexOf(fired(v)), 0, r); }],
    ['missing finish', v => { v.trace.rows = v.trace.rows.filter(r => r !== row(v, 'xferFinish')); }],
    ['duplicate finish', v => { v.trace.rows.push({ ...row(v, 'xferFinish') }); }],
    ['finish precedes timer', v => { const r = row(v, 'xferFinish'); v.trace.rows.splice(v.trace.rows.indexOf(r), 1);
      v.trace.rows.splice(v.trace.rows.indexOf(fired(v)), 0, r); }],
    ['finish timestamp precedes source', v => { row(v, 'xferFinish').at = row(v, 'originStart').at - 1; }],
    ['wrong finish reason', v => { row(v, 'xferFinish').reason = 'core-fail-command'; }],
    ['delivered', v => { row(v, 'xferFinish').delivered = true; }],
    ['verified bytes', v => { row(v, 'xferFinish').verifiedBytes = 1; }],
    ['origin bytes', v => { row(v, 'xferFinish').originBytes = 1; }],
    ['not mixed', v => { row(v, 'xferFinish').bufferedMixed = false; }],
    ['peer-only finish', v => { row(v, 'xferFinish').peerOnly = true; }],
    ['expired recovery', v => { row(v, 'xferFinish').recoveryRemainingMs = 0; }],
    ['negative finish duration', v => { row(v, 'xferFinish').ms = -1; }],
    ['wrong load', v => { v.expected.load++; }],
    ['wrong fragment', v => { v.expected.sn++; }],
    ['missing scope predicate', v => { delete fired(v).scope.generation; }],
    ...MIXED_SCOPE_CHECKS.concat('warmOwner').map(name => [name, v => { fired(v).scope[name] = false; }]),
    ['missing timer', v => { v.timer = null; }],
    ['late schedule', v => { v.timer.scheduledAtMs = v.expected.enteredAtMs + 26; }],
    ['wrong timer delay', v => { v.timer.requestedDelayMs = 26; }],
    ['source before firing', v => { v.expected.invokedAtMs = v.timer.firedAtMs - 1; }],
    ['nonfinite parent', v => { v.expected.parentMs = Infinity; }],
    ['contradictory duration', v => { fired(v).capturedGeometry.durationMs++; row(v, 'load').budgetGeometry.durationMs++; }],
    ['renewed parent', v => { v.expected.remainingLoadMs = v.expected.parentMs; }],
    ['renewed first byte', v => { v.expected.remainingTtfbMs = v.expected.ttfbMs; }],
    ['underclipped source', v => { v.expected.remainingLoadMs--; }],
    ['trace dropped', v => { v.trace.dropped = 1; }],
    ['RPC dropped', v => { v.expected.rpcDropped = 1; }],
    ['RPC omitted', v => { v.expected.rpcOmitted = 1; }],
    ['rows omitted', v => { v.expected.rowsOmitted = 1; }],
  ];
  for (const [name, mutate] of controls) {
    const v = structuredClone(input); mutate(v); assert.equal(warmSetupDeclineProof(v), null, name);
  }
  console.log(JSON.stringify({ fixture: 'pending-new-cleanup-proof-mutations', rejected: controls.length,
    scope: 'Immutable classifier counterexamples only; not traffic, completion or CI rescore evidence' }));
});

test('owned warm captured precutoff allocation timer proves a protected setup decline', async () => {
  const raw = await readFile(new URL('./fixtures/owned-warm-precutoff-allocation-timer.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'c709ac06143be329e88dc0c676e5a0b579ace2445961975106baccd7dc227c8f');
  const receipt = JSON.parse(raw);
  assert.equal(receipt.provenance.sourceCommit, 'cc6df86ebfa14dbe8825bf33c3d4769d4c6e3f4b');
  assert.equal(receipt.provenance.rawLogSha256, 'c7be5c3b26612050085fe9137e60ca4146d677b98d7256ba853ad8ddffe81813');
  const proof = warmSetupDeclineProof(receipt.proofInput);
  assert.equal(proof?.stage, 'warm-protected-timer-after-precutoff-allocation');
  assert.equal(proof.proofTime, receipt.proofInput.timer.firedAtMs);
});

test('owned warm captured precutoff allocation proof rejects incomplete or contradictory evidence', async () => {
  const receipt = JSON.parse(await readFile(new URL('./fixtures/owned-warm-precutoff-allocation-timer.json', import.meta.url)));
  const input = receipt.proofInput, at = input.expected.enteredAtMs;
  const allocation = v => v.rpc.find(row => row.op === 'new' && row.sentAtMs >= at);
  const row = (v, kind) => v.trace.rows.find(item => item.load === v.expected.load && item.k === kind);
  const fired = v => v.trace.rows.find(item => item.load === v.expected.load && item.reason === 'setup-timer');
  const controls = [
    ['early timer', v => { v.timer.firedAtMs = at + 24; }],
    ['missing timer', v => { v.timer = null; }],
    ['late timer schedule', v => { v.timer.scheduledAtMs = at + 26; }],
    ['wrong timer delay', v => { v.timer.requestedDelayMs = 26; }],
    ['missing allocation', v => { v.rpc = v.rpc.filter(item => item !== allocation(v)); }],
    ['duplicate allocation', v => { v.rpc.push({ ...allocation(v) }); }],
    ['wrong RPC operation', v => { allocation(v).op = 'tick'; }],
    ['failed allocation', v => { allocation(v).success = false; }],
    ['late allocation reply', v => { allocation(v).replyAtMs = at + 26; }],
    ['reversed RPC times', v => { allocation(v).replyAtMs = allocation(v).sentAtMs - 1; }],
    ['nonfinite RPC time', v => { allocation(v).replyAtMs = NaN; }],
    ['missing handle', v => { delete allocation(v).handle; }],
    ['invalid handle', v => { allocation(v).handle = 0; }],
    ['reused previous handle', v => { allocation(v).handle = v.rpc.find(item => item.op === 'new').handle; }],
    ['reused RPC identity', v => { allocation(v).id = v.rpc[0].id; }],
    ['changed object size', v => { allocation(v).configSize++; }],
    ['changed peer deadline', v => { allocation(v).configDeadline++; }],
    ['nonexclusive allocation', v => { allocation(v).exclusiveOrigin = false; }],
    ['peer-only allocation', v => { allocation(v).peerOnly = true; }],
    ['unexpected START', v => { const a = allocation(v); v.rpc.push({ id: a.id + 1, op: 'start', handle: a.handle,
      sentAtMs: a.replyAtMs + 1, replyAtMs: a.replyAtMs + 2, success: true }); }],
    ['Core command trace', v => { v.trace.rows.push({ k: 'xfer', load: v.expected.load, at: 2424, op: 'start' }); }],
    ['range trace', v => { v.trace.rows.push({ k: 'origin', load: v.expected.load, at: 2424, ranged: true }); }],
    ...['originRangeAttempts','physicalRangeGets','clientRangeLoads','peerRequests','acceptedPeerBytes','verifiedWarmPeerBytes']
      .map(name => [name, v => { v.expected[name] = 1; }]),
    ['wrong allocation delta', v => { v.expected.coreTransfersDelta = 0; }],
    ['verified transfer bytes', v => { row(v, 'xferFinish').verifiedBytes = 1; }],
    ['origin transfer bytes', v => { row(v, 'xferFinish').originBytes = 1; }],
    ['delivered transfer', v => { row(v, 'xferFinish').delivered = true; }],
    ['wrong finish reason', v => { row(v, 'xferFinish').reason = 'core-fail-command'; }],
    ['duplicate finish', v => { v.trace.rows.push({ ...row(v, 'xferFinish') }); }],
    ['different load', v => { v.expected.load++; }],
    ['different fragment', v => { v.expected.sn++; }],
    ['lost warm owner', v => { fired(v).scope.warmOwner = false; }],
    ['other false predicate', v => { fired(v).scope.unpaused = false; }],
    ['wrong timer reason', v => { fired(v).reason = 'scope-ready'; }],
    ['nonexpired row', v => { fired(v).setupRemainingMs = 1; }],
    ['nonfinite elapsed row', v => { fired(v).ms = NaN; }],
    ['nonfinite remaining row', v => { fired(v).setupRemainingMs = NaN; }],
    ['nonfinite parent', v => { v.expected.parentMs = Infinity; }],
    ['contradictory duration', v => { fired(v).capturedGeometry.durationMs++;
      row(v, 'load').budgetGeometry.durationMs++; }],
    ['finish precedes timer', v => { const rows = v.trace.rows, index = rows.indexOf(row(v, 'xferFinish'));
      const [finish] = rows.splice(index, 1); rows.splice(rows.indexOf(fired(v)), 0, finish); }],
    ['source precedes timer', v => { const rows = v.trace.rows, index = rows.indexOf(row(v, 'originStart'));
      const [source] = rows.splice(index, 1); rows.splice(rows.indexOf(fired(v)), 0, source); }],
    ['invocation precedes timer', v => { v.expected.invokedAtMs = v.timer.firedAtMs - 1; }],
    ['renewed parent', v => { v.expected.remainingLoadMs = v.expected.parentMs; }],
    ['renewed first byte', v => { v.expected.remainingTtfbMs = v.expected.ttfbMs; }],
    ['underclipped parent', v => { v.expected.remainingLoadMs--; }],
    ['dropped trace', v => { v.trace.dropped = 1; }],
    ['dropped RPC', v => { v.expected.rpcDropped = 1; }],
    ['omitted RPC', v => { v.expected.rpcOmitted = 1; }],
    ['omitted rows', v => { v.expected.rowsOmitted = 1; }],
  ];
  for (const [name, mutate] of controls) {
    const v = structuredClone(input); mutate(v);
    assert.equal(warmSetupDeclineProof(v), null, name);
  }
  console.log(JSON.stringify({ fixture: 'captured-precutoff-allocation-timer-proof', rejected: controls.length,
    scope: 'Receipt classifier counterexamples only; not new traffic or a CI rescore' }));
});

// Mutate the ACTUAL held-response observation below. These controls classify
// evidence only; none introduces or changes controller time or source policy.
function warmDeclineMutationControls(input) {
  assert(warmSetupDeclineProof(input));
  const controls = [
    ['missing timer', v => { v.timer = null; }],
    ['late scheduled timer', v => { v.timer.scheduledAtMs = v.expected.enteredAtMs + 26; }],
    ['wrong requested delay', v => { v.timer.requestedDelayMs = 26; }],
    ['source before firing', v => { v.expected.invokedAtMs = v.timer.firedAtMs - 1; }],
    ['missing allocation handle', v => { delete v.rpc.find(r => r.op === 'new' && r.sentAtMs >= v.expected.enteredAtMs).handle; }],
    ['different start handle', v => { v.rpc.find(r => r.op === 'start' && r.sentAtMs >= v.expected.enteredAtMs).handle++; }],
    ['wrong object', v => { v.expected.size++; }],
    ['wrong peer cap', v => { v.rpc.find(r => r.op === 'new' && r.sentAtMs >= v.expected.enteredAtMs).configDeadline++; }],
    ['nonexclusive', v => { v.rpc.find(r => r.op === 'new' && r.sentAtMs >= v.expected.enteredAtMs).exclusiveOrigin = false; }],
    ['not pending', v => { for (const r of v.rpc) r.replyAtMs = Math.min(r.replyAtMs, v.timer.firedAtMs - 1); }],
    ['failed reply', v => { for (const r of v.rpc) r.success = false; }],
    ['duplicate allocation', v => { v.rpc.push({...v.rpc.find(r => r.op === 'new' && r.sentAtMs >= v.expected.enteredAtMs)}); }],
    ['wrong load', v => { v.expected.load++; }],
    ['wrong role', v => { v.trace.rows.find(r => r.k === 'load' && r.load === v.expected.load).budgetGeometry.source = 'buffer'; }],
    ['lost warm owner', v => { v.trace.rows.find(r => r.reason === 'setup-timer' && r.load === v.expected.load).scope.warmOwner = false; }],
    ['range command', v => { v.expected.originRangeAttempts = 1; }],
    ['actual range', v => { v.expected.physicalRangeGets = 1; }],
    ['range invocation', v => { v.expected.clientRangeLoads = 1; }],
    ['peer request', v => { v.expected.peerRequests = 1; }],
    ['accepted peer', v => { v.expected.acceptedPeerBytes = 1; }],
    ['verified warm bytes', v => { v.expected.verifiedWarmPeerBytes = 1; }],
    ['renewed parent', v => { v.expected.remainingLoadMs = v.expected.parentMs; }],
    ['renewed first byte', v => { v.expected.remainingTtfbMs = v.expected.ttfbMs; }],
    ['delivered', v => { v.trace.rows.find(r => r.k === 'xferFinish' && r.load === v.expected.load).delivered = true; }],
    ['wrong terminal', v => { v.trace.rows.find(r => r.k === 'xferFinish' && r.load === v.expected.load).reason = 'core-fail-command'; }],
    ['hidden rows', v => { v.expected.rowsOmitted = 1; }],
    ['dropped trace', v => { v.trace.dropped = 1; }],
    ['dropped RPC', v => { v.expected.rpcDropped = 1; }],
  ];
  for (const [name, mutate] of controls) {
    const v = structuredClone(input); mutate(v);
    assert.equal(warmSetupDeclineProof(v), null, name);
  }
  console.log(JSON.stringify({ fixture: 'warm-setup-decline-proof-mutations', rejected: controls.length }));
}

test('warm setup proof rejects the immutable incomplete897 failure without reconstructing missing observations', async () => {
  const raw = await readFile(new URL('./fixtures/owned-warm-897-incomplete.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), 'cb9de5a1638cd959cd568a3db0eb260a13accf365f9b99a03d5f1cce66c5f1fa');
  const old = JSON.parse(raw), source = old.targetHttp[0];
  assert.equal(source.range, null); assert.equal(source.complete, false);
  assert(!Object.hasOwn(source, 'invocationProbe'));
  assert(!Object.hasOwn(source, 'maxLoadTimeMs'));
  assert(old.rpc.every(row => !Object.hasOwn(row, 'handle')));
  const input = { trace: { dropped: old.traceDropped, rows: old.rows }, rpc: old.rpc,
    timer: source.invocationProbe, expected: { load: old.load, sn: 1, cc: 0, level: 0, size: 6291456,
      enteredAtMs: source.sdkEnteredAtMs, invokedAtMs: source.invokedAtMs,
      remainingLoadMs: source.maxLoadTimeMs, remainingTtfbMs: source.maxTimeToFirstByteMs,
      rpcDropped: old.rpcDropped, rpcOmitted: old.rpcOmitted, rowsOmitted: old.rowsOmitted,
      originRangeAttempts: old.deltas.originRanges, acceptedPeerBytes: old.deltas.peerAccepted } };
  assert.equal(warmSetupDeclineProof(input), null, 'old RED lacks independent evidence; later controls cannot rescore it');
});

async function realCoreWarmContrast(t, { ownedWarm = false, worker = false, logical = false, realAdmission = false, holdSetup = false, holdNewAllocation = false, holdNewUntilBody = false } = {}) {
  const size = 6 * 1024 * 1024, bytes = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) % 251);
  const secret = generateSecretKey(), seconds = Math.floor(Date.now() / 1000);
  const streamEvent = finalizeEvent({ kind: 30311, created_at: seconds, tags: [['d', 'contrast'], ['relayswarm', 'redistribute', '1']], content: '' }, secret);
  const pieceSize = commitmentPieceSize(size), pieces = [];
  for (let at = 0; at < size; at += pieceSize) pieces.push(createHash('sha256').update(bytes.subarray(at, at + pieceSize)).digest('hex'));
  const sha256 = createHash('sha256').update(bytes).digest('hex'), observations = [];
  // Explicit synthetic pacing, not a transport benchmark or a measured WAN rate.
  class ContrastPeer extends PhasedFlowChannel {
    send(data) {
      const frame = typeof data === 'string' ? JSON.parse(data) : null;
      if (frame?.t === 'want') {
        const from = frame.p ? frame.p[0] * pieceSize : 0, to = frame.p ? Math.min(size, frame.p[1] * pieceSize) : size;
        this.firstByteMs = 10; this.flowMs = (to - from) / (.3 * 1024 * 1024) * 1000;
      }
      return super.send(data);
    }
  }
  for (const warming of ownedWarm ? [true] : [true, false]) {
    let f, received, declined = false, declineProof = null, declineObservation = null, heldAllocationObserved = false;
    const timers = realAdmission && !logical ? realTimerInvocationContext() : null;
    if (timers) t.after(() => timers.restore());
    const keyWork = logical ? logicalSegmentKeyDigests(t, base.swarmId) : null;
    const clock = logical ? warmFunctionalClock(t, () => {
      if (keyWork.pending > 0) return true;
      const rows = f?.swarm.trace().rows ?? [];
      const warm = rows.findLast(row => row.k === 'load' && row.sn === 1 && row.budgetGeometry?.source === 'warm-ahead');
      // The forced-decline control fixes one explicit async setup phase:
      // let actual metadata/allocation reach its REAL posted START, then let
      // the original25ms timer advance while that actual reply is held.
      // Neither range admission nor a favourable Core result controls time.
      if (holdNewAllocation && bridge?.workers[0]?.newRequests?.length) heldAllocationObserved = true;
      return Boolean(warm && (holdSetup ? !bridge?.workers[0]?.heldStartPosted :
        holdNewAllocation ? !heldAllocationObserved : !received.some(row => row.path === '/media/seg.ts' && row.warm)));
    }, holdSetup || holdNewAllocation) : null;
    const settle = promise => clock ? clock.settle(promise) : promise;
    const wait = predicate => clock ? clock.advanceUntil(predicate) : until(predicate);
    let rpcObserved = 0;
    const rpc = [], bridge = worker ? transferWorkerFixture(t, { onRpc: row => { rpcObserved++; if (rpc.length < 64) rpc.push(row); } }) : null;
    const origin = await mixedHttpOrigin(t, bytes, Loader, clock?.timerSnapshot ?? timers?.snapshot), { requests, url } = origin;
    received = origin.received;
    class AccountedHTTP extends origin.HttpLoader {
      load(ctx, config, callbacks) {
        const index = received.length, result = super.load(ctx, config, { ...callbacks,
          onSuccess: (response, stats, ...args) => {
            // This loader records the native HTTP response callback as first.
            received[index].firstResponseAtMs = stats.loading.first;
            callbacks.onSuccess(response, stats, ...args);
          } });
        Object.assign(received[index], { path: new URL(ctx.url).pathname, sn: ctx.frag.sn, warm: Boolean(ctx[WARM_AHEAD]) });
        return result;
      }
    }
    // This fixture supplies prepared publisher metadata. Keep publisher signing
    // outside client admission, while native key hashing, SDK verification and
    // Core work retain the original clocks. The public demo currently signs
    // locally per request; this fixture is not its signing-workload benchmark.
    const commitments = new Map(['/media/lead.ts', '/media/seg.ts'].map((path, sequence) =>
      [`${path}:${sequence}:0`, finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds,
        tags: [['x', base.swarmId], ['e', streamEvent.id]], content: commitmentContent({ v: 3,
          streamEventId: streamEvent.id, swarmId: base.swarmId,
          key: createHash('sha256').update(`${base.swarmId}\n${path}`).digest('hex'),
          rendition: '/media/index.m3u8', playlist: '/media/index.m3u8', mediaType: 'main', encryption: null,
          sequence, discontinuity: 0, part: null, sha256, size, pieceSize, pieces, expiresAt: seconds + 60 }) }, secret)]));
    const commitmentOrigin = new URL(url).origin;
    let commitmentProviderCalls = 0;
    const getCommitment = ctx => {
      commitmentProviderCalls++;
      const target = new URL(ctx.url);
      if (target.origin !== commitmentOrigin || ctx.frag.type !== 'main' || ctx.frag.level !== 0 ||
          !Number.isSafeInteger(ctx.frag.sn) || ctx.frag.cc !== 0 || ctx.part != null ||
          ctx.rangeStart !== undefined && ctx.rangeStart !== 0 || ctx.rangeEnd !== undefined && ctx.rangeEnd !== 0) return null;
      return commitments.get(`${target.pathname}:${ctx.frag.sn}:${ctx.frag.cc}`) ?? null;
    };
    f = await settle(multiFixture(t, { size, OriginLoader: AccountedHTTP, holders: [{ Channel: ContrastPeer }], traceRequests: 4096,
      swarmOptions: { streamEvent, getCommitment, serve: true, warmAhead: warming, bufferedMixedRanges: ownedWarm || !warming,
        ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}),
        zeroBudgetPeerRace: true, sustainablePeerWait: true, maxPeerWaitMs: 2500 } }));
    const invoke = ctx => {
      const loader = new f.hls.config.fLoader(f.hlsConfig), calls = { success: 0, error: 0, abort: 0, timeout: 0 };
      ctx.frag.stats = loader.stats;
      const response = new Promise((resolve, reject) => loader.load(ctx, f.loaderConfig, {
        onSuccess: value => { calls.success++; resolve(new Uint8Array(value.data)); },
        onError: () => { calls.error++; reject(new Error('contrast source error')); },
        onAbort: () => { calls.abort++; reject(new Error('contrast source abort')); },
        onTimeout: () => { calls.timeout++; reject(new Error('contrast source timeout')); },
      }));
      return { response, calls, loader };
    };
    try {
      assert.equal(f.swarm.metrics().core.state, 'ready');
      if (worker) await wait(() => f.swarm.metrics().core.transferWorker.state === 'ready');
      const details = M3U8Parser.parseLevelPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nlead.ts\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n',
        new URL('index.m3u8', url).href, 0, 'main', 0, null);
      const contextFor = frag => ({ url: frag.url, frag, responseType: 'arraybuffer', type: LoaderContextType.MEDIA_FRAGMENT, headers: {}, part: null, rangeStart: 0, rangeEnd: 0 });
      const target = contextFor(details.fragments[1]), lead = contextFor(details.fragments[0]);
      f.hls.media = Object.assign(new EventTarget(), { currentTime: 10, paused: false, ended: false, seeking: false,
        readyState: 4, playbackRate: 1, buffered: { length: 0 } });
      // Neither arm has a future map during identical genuine calibration.
      sameBytes(await settle(invoke(target).response), bytes);
      if (clock) await clock.advance(2); else await sleep(2);
      assert(f.swarm.metrics().peerRequestDiagnostics.records.some(row => row.outcome === 'payload' && row.elapsedMs - row.firstByteMs >= 300),
        'the holder model comes from actual Core-verified qualifying payload');
      for (const pc of f.connections) pc.connectionState = 'connected';
      f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
      f.hls.levels = [{ details }];
      const before = f.swarm.metrics(), beforeReceived = received.length, beforeRequests = requests.length;
      const beforePeerRequests = f.channels.reduce((sum, channel) => sum + channel.wants.length, 0);
      if (holdSetup) { assert(worker && realAdmission); bridge.workers[0].holdStart = true; }
      if (holdNewAllocation) { assert(worker && realAdmission && logical); bridge.workers[0].holdNew = true; }
      const previous = invoke(lead); previous.response.catch(() => {});
      await wait(() => received.some((row, index) => index >= beforeReceived && row.path === '/media/lead.ts'));
      if (warming) await wait(() => received.some((row, index) => index >= beforeReceived && row.path === '/media/seg.ts' && row.warm));
      if (ownedWarm) {
        const targetOrigin = received.slice(beforeReceived).find(row => row.path === '/media/seg.ts');
        if (!targetOrigin.range) {
          const trace = f.swarm.trace(), metrics = f.swarm.metrics();
          const load = trace.rows.findLast(row => row.k === 'load' && row.sn === 1 && row.budgetGeometry?.source === 'warm-ahead')?.load;
          const diagnosticRows = trace.rows.filter(row => row.load === load && ['load', 'mixedScope', 'xfer', 'xferFinish', 'originStart', 'origin'].includes(row.k));
          const pending = bridge?.workers.flatMap(value => [...(value.rpcSent?.values() ?? [])]) ?? [];
          if (realAdmission) {
            declined = true;
            if (holdSetup) {
              await wait(() => bridge.workers[0].startReplies?.length > 0);
              bridge.workers[0].holdStart = false; bridge.workers[0].releaseStart();
            }
            await wait(() => f.swarm.trace().rows.some(row => row.k === 'xferFinish' && row.load === load));
            if (holdNewAllocation) {
              const held = bridge.workers[0].newRequests;
              assert(heldAllocationObserved && held?.length === 1, 'the actual NEW reply remains held across original timer/source recovery');
              const pendingNew = bridge.workers[0].rpcSent.get(held[0].data.id);
              assert.equal(pendingNew?.op, 'new');
              assert.equal(targetOrigin.invocationProbe.firedAtMs, targetOrigin.sdkEnteredAtMs + 25);
              assert(pendingNew.sentAtMs <= targetOrigin.invocationProbe.firedAtMs &&
                targetOrigin.invokedAtMs >= targetOrigin.invocationProbe.firedAtMs);
              assert.equal(targetOrigin.complete, false, 'the live proof is observed before its whole HTTP body completes');
              if (!holdNewUntilBody) { bridge.workers[0].holdNew = false; bridge.workers[0].releaseNew(); }
            }
            const fullTrace = f.swarm.trace(), now = f.swarm.metrics();
            const wants = f.channels.flatMap(channel => channel.wants);
            const proofInput = { trace: fullTrace, timer: targetOrigin.invocationProbe, rpc,
              expected: { load, sn: target.frag.sn, cc: target.frag.cc, level: target.frag.level, size,
                fragmentStart: target.frag.start, fragmentDurationSeconds: target.frag.duration,
                enteredAtMs: targetOrigin.sdkEnteredAtMs, invokedAtMs: targetOrigin.invokedAtMs,
                parentMs: f.loaderConfig.loadPolicy.maxLoadTimeMs, ttfbMs: f.loaderConfig.loadPolicy.maxTimeToFirstByteMs,
                remainingLoadMs: targetOrigin.maxLoadTimeMs, remainingTtfbMs: targetOrigin.maxTimeToFirstByteMs,
                originRangeAttempts: now.core.multiHolder.originRanges - before.core.multiHolder.originRanges,
                physicalRangeGets: requests.slice(beforeRequests).filter(row => row.path === '/media/seg.ts' && row.range).length,
                clientRangeLoads: received.slice(beforeReceived).filter(row => row.path === '/media/seg.ts' && row.range).length,
                peerRequests: wants.length - beforePeerRequests,
                acceptedPeerBytes: now.bytes.peerFirst - before.bytes.peerFirst,
                verifiedWarmPeerBytes: now.warmAhead.verifiedPeerBytes - before.warmAhead.verifiedPeerBytes,
                coreTransfersDelta: now.core.multiHolder.transfers - before.core.multiHolder.transfers,
                rpcDropped: bridge?.workers.reduce((sum, value) => sum + (value.rpcDropped ?? 0), 0) ?? 0,
                rpcOmitted: Math.max(0, rpcObserved - rpc.length), rowsOmitted: 0 } };
            // Preserve the original load/timer/source scalars independently of
            // the live completed-reply ledger. Cancelling NEW can finish its
            // local promise before the actual Worker acknowledgement arrives.
            declineObservation = structuredClone(proofInput);
            if (holdNewUntilBody) assert.equal(warmSetupDeclineProof(declineObservation), null,
              'an incomplete early reply capture must still reject');
          } else assert(targetOrigin.range, JSON.stringify({ message: 'eligible owned warm work starts origin206 before any whole GET', worker,
            load: load ?? null, traceDropped: trace.dropped, rows: diagnosticRows.slice(-64), rowsOmitted: Math.max(0, diagnosticRows.length - 64),
            rpc, rpcOmitted: Math.max(0, rpcObserved - rpc.length), pendingRpc: pending.slice(-32), pendingRpcOmitted: Math.max(0, pending.length - 32),
            rpcDropped: bridge?.workers.reduce((sum, value) => sum + (value.rpcDropped ?? 0), 0) ?? 0,
            targetHttp: received.slice(beforeReceived).filter(row => row.path === '/media/seg.ts').slice(-8).map(({ range, status, bytes, complete, aborted, invokedAtMs, sdkEnteredAtMs }) =>
              ({ range, status, bytes, complete, aborted, invokedAtMs, sdkEnteredAtMs })),
            states: { core: metrics.core.state, worker: metrics.core.transferWorker.state },
            deltas: { transfers: metrics.core.multiHolder.transfers - before.core.multiHolder.transfers,
              originRanges: metrics.core.multiHolder.originRanges - before.core.multiHolder.originRanges,
              peerAccepted: metrics.bytes.peerFirst - before.bytes.peerFirst, warmStarted: metrics.warmAhead.started - before.warmAhead.started } }));
        }
        await wait(() => f.swarm.metrics().warmAhead.verified > before.warmAhead.verified);
        if (declined) assert.equal(f.swarm.metrics().warmAhead.verifiedPeerBytes, before.warmAhead.verifiedPeerBytes);
        else assert(f.swarm.metrics().warmAhead.verifiedPeerBytes > before.warmAhead.verifiedPeerBytes);
        assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst, 'verified warm assembly defers accepted credit before genuine consumption');
        if (declineObservation) {
          if (holdNewUntilBody) {
            const body = received.slice(beforeReceived).find(row => row.path === '/media/seg.ts');
            assert.equal(body.complete, true); assert.equal(body.bytes, size);
            const pending = bridge.workers[0].rpcSent;
            const allocation = [...pending.values()].find(row => row.op === 'new' && row.sentAtMs >= declineObservation.expected.enteredAtMs);
            assert(allocation, 'actual NEW acknowledgement remains held through source-body verification');
            assert(!rpc.some(row => row.id === allocation.id));
            assert.equal(warmSetupDeclineProof(declineObservation), null);
            bridge.workers[0].holdNew = false; bridge.workers[0].releaseNew();
            await wait(() => rpc.some(row => row.id === allocation.id));
          }
          // Close the original warm operation after its existing verified-body
          // observation, before a later genuine request can start independent
          // recovery. Native cases gain no wait or loader call. Keep the full
          // current ledger/I/O visible; incomplete evidence still fails.
          const current = f.swarm.metrics(), pending = bridge?.workers.flatMap(value => [...(value.rpcSent?.values() ?? [])]) ?? [];
          const proofInput = { trace: f.swarm.trace(), timer: declineObservation.timer, rpc: structuredClone(rpc),
            expected: { ...declineObservation.expected,
              originRangeAttempts: current.core.multiHolder.originRanges - before.core.multiHolder.originRanges,
              physicalRangeGets: requests.slice(beforeRequests).filter(row => row.path === '/media/seg.ts' && row.range).length,
              clientRangeLoads: received.slice(beforeReceived).filter(row => row.path === '/media/seg.ts' && row.range).length,
              peerRequests: f.channels.reduce((sum, channel) => sum + channel.wants.length, 0) - beforePeerRequests,
              acceptedPeerBytes: current.bytes.peerFirst - before.bytes.peerFirst,
              verifiedWarmPeerBytes: current.warmAhead.verifiedPeerBytes - before.warmAhead.verifiedPeerBytes,
              coreTransfersDelta: current.core.multiHolder.transfers - before.core.multiHolder.transfers,
              rpcDropped: bridge?.workers.reduce((sum, value) => sum + (value.rpcDropped ?? 0), 0) ?? 0,
              rpcOmitted: Math.max(0, rpcObserved - rpc.length) } };
          declineProof = warmSetupDeclineProof(proofInput);
          assert(declineProof && pending.length === 0, JSON.stringify({
            message: 'real warm fallback requires complete same-load setup proof after verified warm body', proofInput,
            pendingRpc: pending.slice(0, 32), pendingRpcOmitted: Math.max(0, pending.length - 32),
            worker: current.core.transferWorker }));
          if (holdNewAllocation) {
            assert.equal(declineProof.stage, 'warm-pending-new-cleanup-after-origin');
            assert.equal(proofInput.expected.coreTransfersDelta, 0);
            assert(!rpc.some(row => row.op === 'start' && row.sentAtMs >= proofInput.expected.enteredAtMs));
            console.log(JSON.stringify({ fixture: 'actual-warm-held-new-cleanup-proof',
              controllerClock: 'logical-functional', timerClockDomain: 'logical-performance', proofInput, proof: declineProof }));
          }
          if (holdNewUntilBody) {
            assert.equal(warmSetupDeclineProof(declineObservation), null,
              'the later reply cannot backfill the immutable rejected early capture');
            console.log(JSON.stringify({ fixture: 'actual-warm-late-new-observation', controllerClock: 'logical-functional',
              earlyCapture: declineObservation, earlyProof: null, finalCapture: proofInput, finalProof: declineProof,
              sourceBodyBytes: received.slice(beforeReceived).find(row => row.path === '/media/seg.ts').bytes,
              sourceCompleteBeforeAcknowledgement: true, consumersFollowAcknowledgement: true }));
          }
          if (holdSetup) {
            assert.equal(declineProof.stage, 'warm-observed-pending-rpc-timer');
            assert.equal(proofInput.timer.firedAtMs, proofInput.expected.enteredAtMs + 25,
              'functional control expires the original setup timer at exactly25ms');
            warmDeclineMutationControls(proofInput);
            console.log(JSON.stringify({ fixture: 'actual-warm-held-rpc-proof',
              controllerClock: 'logical-functional', timerClockDomain: 'logical-performance',
              proofInput, proof: declineProof }));
          }
        }
      }
      const demand = invoke(target); demand.response.catch(() => {});
      if (warming && !ownedWarm) {
        assert.equal(f.swarm.metrics().warmAhead.coalesced, before.warmAhead.coalesced + 1);
        assert.equal(f.swarm.metrics().warmAhead.promotions, before.warmAhead.promotions + 1);
        assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst, 'pending warm ownership cannot claim accepted peer bytes');
      }
      sameBytes(await settle(demand.response), bytes); sameBytes(await settle(previous.response), bytes);
      assert.deepEqual(demand.calls, { success: 1, error: 0, abort: 0, timeout: 0 });
      const after = f.swarm.metrics(), rows = f.swarm.trace().rows;
      const client = received.slice(beforeReceived).filter(row => row.path === '/media/seg.ts');
      const server = requests.slice(beforeRequests).filter(row => row.path === '/media/seg.ts');
      const peer = after.bytes.peerFirst - before.bytes.peerFirst;
      assert(client.every(row => row.complete && row.bytes === (row.range ? row.range[1] - row.range[0] : size)));
      assert.equal(client.reduce((sum, row) => sum + row.bytes, 0), server.reduce((sum, row) => sum + row.sent, 0));
      const starts = rows.filter(row => row.k === 'xfer' && row.op === 'start' && row.at >= (rows.filter(row => row.k === 'load' && row.sn === 0).at(-1)?.at ?? 0));
      if (declined) {
        assert.equal(client.length, 1); assert.equal(server.length, 1);
        assert.equal(client[0].range, null); assert.equal(client[0].status, 200); assert.equal(client[0].bytes, size);
        assert.equal(peer, 0); assert.equal(after.warmAhead.verifiedPeerBytes, before.warmAhead.verifiedPeerBytes);
        assert(client[0].completedAtMs < client[0].sdkEnteredAtMs + f.loaderConfig.loadPolicy.maxLoadTimeMs);
        assert(client[0].completedAtMs <= client[0].invokedAtMs + client[0].maxLoadTimeMs,
          'the complete fallback body stays within its original reduced source deadline');
        assert(client[0].firstResponseAtMs >= client[0].invokedAtMs &&
          client[0].firstResponseAtMs <= client[0].invokedAtMs + client[0].maxTimeToFirstByteMs,
          'the native HTTP response arrives within its original reduced first-byte deadline');
      } else if (warming && !ownedWarm) {
        assert.equal(client.length, 1); assert.equal(client[0].range, null); assert.equal(client[0].warm, true);
        assert.equal(server.length, 1); assert.equal(server[0].status, 200); assert.equal(peer, 0);
        const warmLoad = rows.findLast(row => row.k === 'load' && row.sn === 1 && row.budgetGeometry?.source === 'warm-ahead');
        assert(warmLoad);
        assert(rows.some(row => row.k === 'xferFinish' && row.load === warmLoad.load && row.peerOnly && row.reason === 'whole-peer-capacity'));
        assert(!rows.some(row => row.k === 'mixedScope' && row.load === warmLoad.load));
        assert.equal(after.warmAhead.consumedPeerBytes, 0); assert.equal(after.warmAhead.reservationBytes, 0);
      } else {
        const strictTargetRanges = client.length > 0 && client.every(row => row.range && row.status === 206);
        let rangeFailure;
        if (!strictTargetRanges) {
          // Failure-only evidence: preserve the native clock, admission policy
          // and strict range requirement; do not infer why a whole GET won.
          const targetLoad = rows.findLast(row => row.k === 'load' && row.sn === target.frag.sn)?.load ?? null;
          const targetLoads = new Set();
          let ancestor = targetLoad;
          while (Number.isSafeInteger(ancestor) && ancestor > 0 && !targetLoads.has(ancestor) && targetLoads.size < 4) {
            targetLoads.add(ancestor);
            ancestor = rows.find(row => row.k === 'load' && row.load === ancestor)?.parentLoad ?? null;
          }
          const targetRows = rows.filter(row => targetLoads.has(row.load) &&
            ['load', 'mixedScope', 'eligibility', 'xfer', 'xferFinish', 'originStart', 'origin'].includes(row.k));
          const retainedRows = targetRows.length <= 48 ? targetRows : [...targetRows.slice(0, 16), ...targetRows.slice(-32)];
          const fields = ['k', 'at', 'load', 'parentLoad', 'sn', 'phase', 'reason', 'ms', 'budgetMs', 'limitMs', 'budgetGeometry',
            'capturedGeometry', 'currentGeometry', 'scope', 'setupRemainingMs', 'originInvoked', 'leg', 'ranged',
            'op', 'exclusiveOrigin', 'peerOnly', 'bufferedMixed', 'delivered', 'verifiedBytes', 'originBytes'];
          rangeFailure = JSON.stringify({ fixture: 'real-core-warm-vs-genuine-mixed-range-failure',
            warming, ownedWarm, worker, controllerClock: logical ? 'logical-functional' : 'real',
            targetLoad, targetLoads: [...targetLoads], unresolvedAncestor: ancestor,
            calls: demand.calls, acceptedPeerBytes: peer, traceDropped: f.swarm.trace().dropped,
            originRangeAttempts: after.core.multiHolder.originRanges - before.core.multiHolder.originRanges,
            coreTransfersDelta: after.core.multiHolder.transfers - before.core.multiHolder.transfers,
            peerRequests: f.channels.reduce((sum, channel) => sum + channel.wants.length, 0) - beforePeerRequests,
            clientRowsOmitted: Math.max(0, client.length - 16), serverRowsOmitted: Math.max(0, server.length - 16),
            traceRowsOmitted: Math.max(0, targetRows.length - 48),
            client: client.slice(0, 16).map(({ range, status, bytes, complete, warm, sdkEnteredAtMs, invokedAtMs,
              completedAtMs, firstResponseAtMs, maxLoadTimeMs, maxTimeToFirstByteMs }) =>
              ({ range, status, bytes, complete, warm, sdkEnteredAtMs, invokedAtMs, completedAtMs,
                firstResponseAtMs, maxLoadTimeMs, maxTimeToFirstByteMs })),
            server: server.slice(0, 16).map(({ range, status, sent }) => ({ range, status, sent })),
            trace: retainedRows.map(row => Object.fromEntries(fields.filter(key => Object.hasOwn(row, key))
              .map(key => [key, row[key]]))) });
        }
        assert(strictTargetRanges, rangeFailure);
        const start = starts.at(-1); assert(start && start.exclusiveOrigin === true);
        assert.deepEqual(start.probePeers, []); assert(start.peers.every(([, first, rate]) => Number.isFinite(first) && Number.isFinite(rate) && rate > 0));
        assert(start.out.c.some(row => row.t === 'origin') && start.out.c.some(row => row.t === 'request'));
        assert(peer > 0 && peer < size); assert.equal(peer + client.reduce((sum, row) => sum + row.bytes, 0), size);
      }
      if (ownedWarm) {
        assert.equal(after.warmAhead.consumedPeerBytes - before.warmAhead.consumedPeerBytes, peer);
        assert.equal(after.core.transferWorker.state, worker ? 'ready' : 'off');
        const again = invoke(target); sameBytes(await settle(again.response), bytes);
        assert.equal(again.calls.success, 1); assert.equal(f.swarm.metrics().bytes.peerFirst, after.bytes.peerFirst, 'repeated consumption cannot double-credit the same warm object');

      }
      if (holdNewAllocation) {
        await wait(() => { const snapshot = f.swarm.metrics().core.transferWorker;
          return snapshot.transfers === 0 && snapshot.pending === 0; });
        const snapshot = f.swarm.metrics().core.transferWorker;
        for (const field of ['transfers', 'activeBytes', 'pending', 'pendingBytes']) assert.equal(snapshot[field], 0, field);
        console.log(JSON.stringify({ fixture: 'actual-warm-held-new-worker-cleanup',
          transfers: snapshot.transfers, activeBytes: snapshot.activeBytes, pending: snapshot.pending, pendingBytes: snapshot.pendingBytes }));
      }
      observations.push({ warming, ownedWarm, worker, optionalAdmissionDeclined: declined, setupProof: declineProof?.stage ?? null, controllerClock: logical ? 'logical-functional' : 'real', objectBytes: size, acceptedPeerBytes: peer,
        commitmentSupplier: 'prepared-signed-fixture-metadata', publisherEventsPrepared: commitments.size, commitmentProviderCalls,
        actualTargetHttpBytes: client.reduce((sum, row) => sum + row.bytes, 0), targetWholeGets: server.filter(row => !row.range).length,
        target206Gets: server.filter(row => row.range).length, targetClientBodies: client.map(({ bytes, status, complete, range, warm }) => ({ bytes, status, complete, range, warm })),
        excludedLeadBodyBytes: received.slice(beforeReceived).filter(row => row.path === '/media/lead.ts').reduce((sum, row) => sum + row.bytes, 0),
        calibrationBodyBytes: received.slice(0, beforeReceived).reduce((sum, row) => sum + row.bytes, 0),
        coreReady: after.core.state, coalesced: after.warmAhead?.coalesced ?? null,
        configuredPeerBytesPerSecond: .3 * 1024 * 1024, configuredSourceBytesPerSecondPerRequest: 3 * 1024 * 1024 });
    } finally { try { await settle(f.close()); } finally { keyWork?.restore(); clock?.restore(); timers?.restore(); } }
  }
  console.log(JSON.stringify({ fixture: 'real-core-warm-vs-genuine-mixed', policyContrastOnly: true, observations }));
}

test('real Core contrasts legacy warm whole source with otherwise eligible genuine mixed ranges', { timeout: 25000 }, t => realCoreWarmContrast(t));

for (const worker of [false, true]) test(`owned steady warm work assembles disjoint206 and defers peer credit until genuine consumption (${worker ? 'worker' : 'main'}, logical controller)`, { timeout: 20000 },
  t => realCoreWarmContrast(t, { ownedWarm: true, worker, logical: true }));

for (const worker of [false, true]) test(`owned steady warm real-clock admission retains strict206 or observed setup decline (${worker ? 'worker' : 'main'})`, { timeout: 20000 },
  t => realCoreWarmContrast(t, { ownedWarm: true, worker, realAdmission: true }));

// Mandatory functional timer/RPC control; no assumption that a native25ms
// optional setup reaches START under arbitrary hosted load. Ordinary real-clock
// cases above still require actual strict206 or a complete observed decline.
test('owned steady warm held Worker reply proves setup-only whole fallback (logical controller)', { timeout: 20000 },
  t => realCoreWarmContrast(t, { ownedWarm: true, worker: true, logical: true, realAdmission: true, holdSetup: true }));


// Functional allocation-cancellation proof: actual committed Worker NEW reply
// is held before advancing the original setup timer. The real whole HTTP body,
// hash/callbacks and reduced source budgets remain mandatory; no elapsed claim.
test('owned steady warm held NEW reply proves cleanup after independent source and complete fallback (logical controller)', { timeout: 20000 },
  t => realCoreWarmContrast(t, { ownedWarm: true, worker: true, logical: true, realAdmission: true, holdNewAllocation: true }));

test('owned steady warm late NEW observation preserves source completion before strict proof (logical controller)', { timeout: 20000 },
  t => realCoreWarmContrast(t, { ownedWarm: true, worker: true, logical: true, realAdmission: true,
    holdNewAllocation: true, holdNewUntilBody: true }));


async function bufferedMixedFixture(t, clock, options = {}) {
  lateRaceKeyClock(t);
  let training = true;
  const f = await clock.settle(multiFixture(t, { size: 1024 * 1024, holders: [{ Channel: PhasedFlowChannel, firstByteMs: 10, flowMs: 350 }],
    originDelayMs: 100, wholeOriginDelayMs: 500, traceRequests: 4096, ...options,
    beforeCommitment: (...args) => training ? undefined : options.beforeCommitment?.(...args),
    swarmOptions: { bufferedMixedRanges: true, zeroBudgetPeerRace: true, sustainablePeerWait: true, maxPeerWaitMs: 2500, ...options.swarmOptions } }));
  f.ctx = { ...multiContext, frag: { ...multiContext.frag, start: 10, duration: .1 } };
  f.hls.media = { currentTime: 10, paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1,
    buffered: { length: 0 } };
  if (options.swarmOptions?.transferWorkerUrl) await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.state === 'ready', 1000);
  if (options.untrained) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
  if (!options.skipTraining) sameBytes(await clock.settle(f.load(f.ctx)), f.bytes);
  if (!options.skipTraining) await clock.advance(2);
  training = false;
  for (const pc of f.connections) pc.connectionState = 'connected';
  if (options.untrained) f.channels[0].receive(JSON.stringify({ t: 'have', keys: [f.key] }));
  f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
  // Request diagnostics retain calibration separately; new assertions count only
  // work begun after this actual source/peer training stage.
  for (const channel of f.channels) channel.wants.length = 0;
  return f;
}

// These SDK integration controls model the internal descriptor supplied by the
// separately tested warm engine. Real Core/signatures/framing/range I/O remain.
function ownedWarmControl(f, clock, remainingMs = 8000) {
  const signal = new AbortController(), enteredAt = clock.now() - (8000 - remainingMs);
  const owner = { valid: true, reads: 0, signal, enteredAt, deadline: enteredAt + 8000, genuine: null };
  const context = { ...f.ctx };
  context[WARM_AHEAD] = { peerBytes: 0, work: () => {
    owner.reads++;
    return owner.valid && !signal.signal.aborted && f.hls.media.paused === false && (clock.now() < owner.deadline || owner.genuine)
      ? { context, enteredAt, deadline: owner.deadline, signal: signal.signal, genuine: owner.genuine } : null;
  } };
  const calls = { success: 0, abort: 0, error: 0, timeout: 0 }, loader = new f.hls.config.fLoader(f.hlsConfig);
  const start = () => {
    let finish;
    const outcome = new Promise(resolve => { finish = resolve; });
    loader.load(context, f.loaderConfig, Object.fromEntries(['success', 'abort', 'error', 'timeout'].map(name =>
      ['on' + name[0].toUpperCase() + name.slice(1), (...args) => { calls[name]++; finish({ kind: name, args }); }])));
    return outcome;
  };
  return { owner, context, calls, loader, start };
}

for (const worker of [false, true]) test(`owned warm mixed reports captured nonmatching HAVE before Core allocation (${worker ? 'worker' : 'main'})`, async t => {
  const clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null; let f;
  try {
    f = await bufferedMixedFixture(t, clock, { swarmOptions: { warmAhead: true, serve: true,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    assert.equal(f.swarm.metrics().core.state, 'ready');
    if (worker) assert.equal(f.swarm.metrics().core.transferWorker.state, 'ready');
    const unrelated = 'f'.repeat(64); assert.notEqual(unrelated, f.key);
    f.channels[0].receive(JSON.stringify({ t: 'have', keys: [unrelated] }));
    const before = f.swarm.metrics(), whole = f.wholeLoads.length, ranges = f.ranges.length;
    const work = ownedWarmControl(f, clock), result = await clock.settle(work.start());
    assert.equal(result.kind, 'success'); sameBytes(new Uint8Array(result.args[0].data), f.bytes);
    assert.equal(f.wholeLoads.length, whole + 1); assert.equal(f.ranges.length, ranges);
    assert.deepEqual(f.channels[0].wants, []); assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
    assert.equal(f.swarm.metrics().core.multiHolder.transfers, before.core.multiHolder.transfers);
    const rows = f.swarm.trace().rows, entry = rows.findLast(row => row.k === 'mixedScope' && row.reason === 'entry');
    assert(entry, 'accepted framing2 with nonempty other-object HAVE entered owned warm setup');
    assert.equal(rows.find(row => row.k === 'load' && row.load === entry.load).budgetGeometry.source, 'warm-ahead');
    const eligibility = rows.find(row => row.k === 'eligibility' && row.load === entry.load && row.reason === 'cached-no-matching-have');
    assert(eligibility, 'the actual cached exact-HAVE refusal must identify why no Core transfer was allocated');
    assert.equal(eligibility.matchingHave, false); assert.equal(eligibility.budgetGeometry.source, 'warm-ahead');
    assert.deepEqual(eligibility.projection, { stage: 'cached-entry', capturedLinks: 1,
      entryChecked: 1, entryMatched: 0, currentChecked: 0, currentMatched: 0, eligibleMatched: 0 });
    assert(!JSON.stringify(eligibility).includes(unrelated)); assert(!JSON.stringify(eligibility).includes(f.key));
    assert.equal(work.calls.success, 1);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const worker of [false, true]) test(`owned warm mixed distinguishes exact entry HAVE withdrawn before key completion (${worker ? 'worker' : 'main'})`, async t => {
  const clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null; let f;
  try {
    f = await bufferedMixedFixture(t, clock, { swarmOptions: { warmAhead: true, serve: true,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    assert.equal(f.swarm.metrics().core.state, 'ready');
    if (worker) assert.equal(f.swarm.metrics().core.transferWorker.state, 'ready');
    const before = f.swarm.metrics(), whole = f.wholeLoads.length, ranges = f.ranges.length;
    const work = ownedWarmControl(f, clock), pending = work.start();
    // load() has synchronously captured the exact entry HAVE, while #segmentKey
    // must yield before matching it against the link's current HAVE snapshot.
    f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    const result = await clock.settle(pending);
    assert.equal(result.kind, 'success'); sameBytes(new Uint8Array(result.args[0].data), f.bytes);
    assert.equal(f.wholeLoads.length, whole + 1); assert.equal(f.ranges.length, ranges);
    assert.deepEqual(f.channels[0].wants, []); assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
    assert.equal(f.swarm.metrics().core.multiHolder.transfers, before.core.multiHolder.transfers);
    const rows = f.swarm.trace().rows, entry = rows.findLast(row => row.k === 'mixedScope' && row.reason === 'entry');
    assert(entry);
    const eligibility = rows.find(row => row.k === 'eligibility' && row.load === entry.load && row.reason === 'cached-no-matching-have');
    assert(eligibility); assert.equal(eligibility.matchingHave, false);
    assert.equal(eligibility.budgetGeometry.source, 'warm-ahead');
    assert.deepEqual(eligibility.projection, { stage: 'cached-entry', capturedLinks: 1,
      entryChecked: 1, entryMatched: 1, currentChecked: 1, currentMatched: 0, eligibleMatched: 0 });
    assert.equal(work.calls.success, 1);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('owned warm mixed reports unavailable range engine before Core allocation', async t => {
  const clock = virtualClock(t); let f;
  try {
    f = await bufferedMixedFixture(t, clock, { untrained: true, swarmOptions: { warmAhead: true, serve: true, multiHolder: false } });
    assert.equal(f.swarm.metrics().core.state, 'ready');
    const before = f.swarm.metrics(), whole = f.wholeLoads.length;
    const work = ownedWarmControl(f, clock), result = await clock.settle(work.start());
    assert.equal(result.kind, 'success'); sameBytes(new Uint8Array(result.args[0].data), f.bytes);
    assert.equal(f.wholeLoads.length, whole + 1); assert.equal(f.ranges.length, 0); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.bytes.peerFirst);
    assert.equal(f.swarm.metrics().core.multiHolder.transfers, before.core.multiHolder.transfers);
    const rows = f.swarm.trace().rows, entry = rows.findLast(row => row.k === 'mixedScope' && row.reason === 'entry');
    assert(entry);
    const eligibility = rows.find(row => row.k === 'eligibility' && row.load === entry.load && row.reason === 'cached-ranges-unavailable');
    assert(eligibility); assert.equal(eligibility.matchingHave, null);
    assert.equal(eligibility.budgetGeometry.source, 'warm-ahead');
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

// Controlled descriptors isolate SDK provenance validation from the separately
// tested warm-row clock. Advancing performance without dispatching timers models
// a synchronous callback arriving on the original eight-second boundary.
for (const worker of [false, true]) test(`owned warm promotion at its original deadline cannot revive source work (${worker ? 'worker' : 'main'})`, async t => {
  const clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null; let f;
  try {
    f = await bufferedMixedFixture(t, clock, { swarmOptions: { warmAhead: true, serve: true,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    assert.equal(f.swarm.metrics().core.state, 'ready');
    if (worker) assert.equal(f.swarm.metrics().core.transferWorker.state, 'ready');
    const before = { whole: f.wholeLoads.length, ranges: f.ranges.length, wants: f.channels[0].wants.length, peer: f.swarm.metrics().bytes.peerFirst };
    const work = ownedWarmControl(f, clock, 10), priorNow = performance.now.bind(performance);
    work.owner.genuine = { at: work.owner.deadline, context: work.context };
    t.mock.method(performance, 'now', () => priorNow() + 10);
    const outcome = work.start();
    assert.equal(work.calls.abort, 1, 'late genuine provenance must be rejected synchronously before any timer dispatch');
    assert.equal((await clock.settle(outcome)).kind, 'abort');
    await clock.advance(40);
    assert.equal(f.wholeLoads.length, before.whole); assert.equal(f.ranges.length, before.ranges);
    assert.equal(f.channels[0].wants.length, before.wants); assert.equal(f.swarm.metrics().bytes.peerFirst, before.peer);
    assert.equal(work.calls.success + work.calls.error + work.calls.timeout, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const worker of [false, true]) test(`owned warm valid promotion crosses row deadline without renewing its transport parent (${worker ? 'worker' : 'main'})`, async t => {
  const clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null; let f;
  try {
    f = await bufferedMixedFixture(t, clock, { swarmOptions: { warmAhead: true, serve: true,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    // Healthy synthetic headroom; this is a policy control, not field timing.
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 24 };
    const before = { whole: f.wholeLoads.length, ranges: f.ranges.length, peer: f.swarm.metrics().bytes.peerFirst };
    const work = ownedWarmControl(f, clock, 10), started = clock.now(), outcome = work.start();
    await clock.advance(5);
    work.owner.genuine = { at: clock.now(), context: work.context };
    assert(work.owner.genuine.at < work.owner.deadline);
    const result = await clock.settle(outcome);
    assert.equal(result.kind, 'success'); sameBytes(new Uint8Array(result.args[0].data), f.bytes);
    assert(clock.now() > work.owner.deadline, 'completion is after the fixed original row deadline');
    assert(clock.now() < started + 10000, 'completion remains within the original transport parent');
    assert.equal(f.wholeLoads.length, before.whole); assert(f.ranges.length > before.ranges);
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.peer, 'the original speculative marker still defers consumption credit');
    assert.equal(work.calls.success, 1); assert.equal(work.calls.abort + work.calls.error + work.calls.timeout, 0);
    const rows = f.swarm.trace().rows.filter(row => row.k === 'mixedScope' && row.load === f.swarm.trace().rows.findLast(row => row.k === 'mixedScope' && row.reason === 'entry').load);
    const ends = rows.map(row => row.ms + row.recoveryRemainingMs);
    assert(ends.every(end => Math.abs(end - 10000) <= 1), 'promotion never resets the original ten-second transport parent');
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const worker of [false, true]) test(`owned warm valid promotion cannot renew a shorter original parent (${worker ? 'worker' : 'main'})`, async t => {
  const clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null; let f;
  try {
    f = await bufferedMixedFixture(t, clock, { swarmOptions: { warmAhead: true, serve: true,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    f.loaderConfig = { ...f.loaderConfig, timeout: 50 };
    const before = { whole: f.wholeLoads.length, ranges: f.ranges.length, peer: f.swarm.metrics().bytes.peerFirst };
    const work = ownedWarmControl(f, clock, 10), started = clock.now(), outcome = work.start();
    await clock.advance(5); work.owner.genuine = { at: clock.now(), context: work.context };
    assert(work.owner.genuine.at < work.owner.deadline);
    assert.equal((await clock.settle(outcome, 100)).kind, 'timeout');
    assert(clock.now() <= started + 51, 'the shorter original parent expires without renewal');
    assert.equal(f.wholeLoads.length, before.whole + 1); assert.equal(f.ranges.length, before.ranges);
    assert(f.wholeLoads.at(-1).config.loadPolicy.maxLoadTimeMs <= 50);
    await clock.advance(550);
    assert.equal(work.calls.success, 0); assert.equal(work.calls.timeout, 1);
    assert.equal(work.calls.abort + work.calls.error, 0);
    assert.equal(f.wholeLoads.length, before.whole + 1); assert.equal(f.swarm.metrics().bytes.peerFirst, before.peer);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const worker of [false, true]) for (const ending of ['expiry', 'pause', 'abort', 'revoked']) {
  test(`owned warm mixed ${ending} during authority wait starts no late I/O (${worker ? 'worker' : 'main'})`, async t => {
    const clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null;
    let f, release, blocked = false;
    try {
      f = await bufferedMixedFixture(t, clock, { swarmOptions: { warmAhead: true, serve: true,
        ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) },
        beforeCommitment: () => new Promise((resolve, reject) => { blocked = true; release = ending === 'revoked' ? () => reject(new Error('revoked')) : resolve; }) });
      assert.equal(f.swarm.metrics().core.state, 'ready');
      if (worker) assert.equal(f.swarm.metrics().core.transferWorker.state, 'ready');
      const before = { whole: f.wholeLoads.length, ranges: f.ranges.length, wants: f.channels[0].wants.length, peer: f.swarm.metrics().bytes.peerFirst };
      const work = ownedWarmControl(f, clock, ending === 'expiry' ? 10 : 8000), outcome = work.start();
      await clock.advanceUntil(() => blocked, 20);
      const entry = f.swarm.trace().rows.findLast(row => row.k === 'mixedScope' && row.reason === 'entry');
      assert(entry, 'the owner passed admission and entered new mixed setup before authority yielded');
      const load = f.swarm.trace().rows.find(row => row.k === 'load' && row.load === entry.load);
      assert.equal(load.budgetGeometry.source, 'warm-ahead'); assert(work.owner.reads > 1);
      if (ending === 'expiry') await clock.advance(11);
      else if (ending === 'pause') f.hls.media.paused = true;
      else if (ending === 'abort') { work.owner.signal.abort(); work.loader.abort(); }
      else work.owner.valid = false;
      release(); await clock.advance(40);
      assert.equal(f.wholeLoads.length, before.whole); assert.equal(f.ranges.length, before.ranges);
      assert.equal(f.channels[0].wants.length, before.wants); assert.equal(f.swarm.metrics().bytes.peerFirst, before.peer);
      assert.equal(work.calls.success, 0);
      const terminals = work.calls.abort + work.calls.error + work.calls.timeout;
      assert.equal(terminals, 1, 'lost ownership settles once without accepting delayed metadata');
      assert.notEqual((await clock.settle(outcome)).kind, 'success');
      await clock.advance(500);
      assert.equal(work.calls.abort + work.calls.error + work.calls.timeout, terminals);
      assert.equal(f.wholeLoads.length, before.whole); assert.equal(f.swarm.metrics().bytes.peerFirst, before.peer);
    } finally { release?.(); if (f) await clock.settle(f.close()); clock.restore(); }
  });
}

for (const worker of [false, true]) test(`owned warm mixed loss after origin invocation rejects stale callbacks (${worker ? 'worker' : 'main'})`, async t => {
  const clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null; let f;
  try {
    f = await bufferedMixedFixture(t, clock, { swarmOptions: { warmAhead: true, serve: true,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    const before = { whole: f.wholeLoads.length, ranges: f.ranges.length, peer: f.swarm.metrics().bytes.peerFirst };
    const work = ownedWarmControl(f, clock), outcome = work.start();
    await clock.advanceUntil(() => f.ranges.length > before.ranges, 25);
    assert(f.swarm.trace().rows.some(row => row.k === 'mixedScope' && row.reason === 'origin-invoked'));
    const rangesAtLoss = f.ranges.length; work.owner.valid = false;
    await clock.advance(600);
    assert.equal(work.calls.success, 0); assert.equal(f.swarm.metrics().bytes.peerFirst, before.peer);
    assert.equal(f.wholeLoads.length, before.whole, 'a stale range reply cannot create a recovery whole GET');
    assert.equal(f.ranges.length, rangesAtLoss, 'no new range may follow lost ownership');
    assert.equal(work.calls.abort + work.calls.error + work.calls.timeout, 1);
    assert.notEqual((await clock.settle(outcome)).kind, 'success');
    assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const worker of [false, true]) test(`owned warm mixed missing capability retains one ordinary source (${worker ? 'worker' : 'main'})`, async t => {
  const bytes = Buffer.from(multiCoreBytes), offset = bytes.indexOf(Buffer.from('rs_xfer_capabilities'));
  assert(offset >= 0); bytes[offset] = bytes[offset + 1] = 0x78;
  const legacy = await WebAssembly.compile(bytes), clock = virtualClock(t), bridge = worker ? transferWorkerFixture(t) : null; let f;
  try {
    f = await bufferedMixedFixture(t, clock, { untrained: true, swarmOptions: { warmAhead: true, serve: true, coreWasm: legacy,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    const before = { whole: f.wholeLoads.length, ranges: f.ranges.length, peer: f.swarm.metrics().bytes.peerFirst };
    const work = ownedWarmControl(f, clock), outcome = await clock.settle(work.start());
    assert.equal(outcome.kind, 'success'); sameBytes(new Uint8Array(outcome.args[0].data), f.bytes);
    assert.equal(f.wholeLoads.length, before.whole + 1); assert.equal(f.ranges.length, before.ranges);
    assert.equal(f.swarm.metrics().bytes.peerFirst, before.peer); assert.equal(work.calls.success, 1);
    assert.equal(f.swarm.metrics().core.state, 'ready');
    if (worker) assert.equal(f.swarm.metrics().core.transferWorker.state, 'ready');
    assert(f.swarm.trace().rows.some(row => row.k === 'mixedScope' && row.reason === 'entry'));
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed scope trace reports the actual fragment rejection before transfer finish without extra getter reads', async t => {
  for (const field of ['start', 'duration']) {
    const counts = [];
    for (const capacity of [0, 128]) {
      const clock = virtualClock(t); let f, reads = 0, changed = false;
      try {
        f = await bufferedMixedFixture(t, clock, { traceRequests: capacity });
        const captured = f.ctx.frag[field], next = captured + .125;
        Object.defineProperty(f.ctx.frag, field, { configurable: true, get() { reads++; return changed ? next : captured; } });
        const pending = beginCountedMultiLoad(f, f.ctx);
        await clock.advance(5); assert(f.ranges.length > 0, 'the current real Core transfer has already issued its source range');
        changed = true;
        sameBytes(await clock.settle(pending.response), f.bytes);
        assert.equal(pending.calls.success.length, 1); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
        const rows = f.swarm.trace().rows;
        if (!capacity) assert.deepEqual(rows, [], 'traceRequests0 retains no observation rows');
        else {
          const rejection = rows.find(row => row.k === 'mixedScope' && row.reason === 'scope-' + field);
          assert(rejection); assert.equal(rejection.scope[field], false);
          const geometryField = field === 'start' ? 'fragmentStart' : 'fragmentDurationSeconds';
          assert.equal(rejection.capturedGeometry[geometryField], captured);
          assert.equal(rejection.currentGeometry[geometryField], next);
          assert.equal(rejection.capturedGeometry.durationMs, 100, 'budget duration remains explicitly milliseconds');
          const terminal = rows.find(row => row.k === 'xferFinish' && row.load === rejection.load);
          assert.equal(terminal?.reason, 'reply-current-invalid'); assert.equal(terminal.delivered, false);
          assert(rows.indexOf(rejection) < rows.indexOf(terminal), 'the evaluated scope failure precedes its terminal observation');
          assert(rows.some(row => row.k === 'mixedScope' && row.load === rejection.load && row.reason === 'peer-result-empty'));
          const text = JSON.stringify(rows.filter(row => ['mixedScope', 'xferFinish'].includes(row.k)));
          assert(!text.includes(f.ctx.url) && !text.includes(f.key) && !text.includes(f.swarm.metrics().pubkey), 'new observations omit URLs, keys and public identities');
        }
        counts.push(reads);
      } finally { if (f) await clock.settle(f.close()); clock.restore(); }
    }
    assert.equal(counts[1], counts[0], field + ' getter is evaluated identically with tracing off and on');
  }
});

test('buffered mixed scope trace retains the actual immediate budget branch and successful transfer terminal', async t => {
  for (const parentMs of [100, 10000]) {
    const clock = virtualClock(t); let f;
    try {
      f = await bufferedMixedFixture(t, clock, { traceRequests: 128 });
      f.loaderConfig.timeout = parentMs;
      const pending = beginCountedMultiLoad(f, f.ctx);
      if (parentMs !== 100) sameBytes(await clock.settle(pending.response), f.bytes);
      const rows = f.swarm.trace().rows, load = rows.filter(row => row.k === 'load').at(-1).load;
      const scoped = rows.filter(row => row.k === 'mixedScope' && row.load === load);
      assert(scoped.some(row => row.reason === 'entry'));
      if (parentMs === 100) {
        assert(scoped.some(row => row.reason === 'entry-peer-budget' && row.ms === 0));
        assert.equal(rows.filter(row => row.k === 'xferFinish' && row.load === load).length, 0, 'an immediate source decline never allocates a Core transfer');
        pending.loader.abort(); assert.equal(pending.calls.abort.length, 1);
      } else {
        const terminal = rows.filter(row => row.k === 'xferFinish' && row.load === load);
        assert.equal(terminal.length, 1); assert.equal(terminal[0].reason, 'delivered'); assert.equal(terminal[0].delivered, true);
        assert.equal(terminal[0].verifiedBytes, f.bytes.length);
        assert(scoped.some(row => row.reason === 'origin-invoked') && scoped.some(row => row.reason === 'peer-result-delivered'));
      }
      assert.equal(pending.calls.success.length, parentMs === 100 ? 0 : 1);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  }
});

test('buffered mixed scope trace cannot change delivery when its observation sink throws', async t => {
  const clock = virtualClock(t), push = Array.prototype.push; let f, rejected = 0;
  try {
    f = await bufferedMixedFixture(t, clock);
    Array.prototype.push = function (...items) {
      if (items.length === 1 && ['mixedScope', 'xferFinish'].includes(items[0]?.k)) { rejected++; throw new Error('fixture trace sink'); }
      return Reflect.apply(push, this, items);
    };
    const pending = beginCountedMultiLoad(f, f.ctx);
    sameBytes(await clock.settle(pending.response), f.bytes);
    assert.equal(pending.calls.success.length, 1); assert(rejected > 0);
    assert(f.swarm.metrics().bytes.peerFirst > 0, 'the same mixed transfer still accepts its verified peer contribution');
  } finally { Array.prototype.push = push; if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const worker of [false, true]) test("buffered mixed missing ownership capability uses one whole source and preserves its engine " + (worker ? "(worker)" : "(main)"), async t => {
  // Keep all real verifier/link exports; hide only this optional capability
  // export to model a module that cannot promise exclusive origin ownership.
  const bytes = Buffer.from(multiCoreBytes), name = Buffer.from('rs_xfer_capabilities'), offset = bytes.indexOf(name);
  assert(offset >= 0 && bytes.indexOf(name, offset + 1) === -1);
  bytes[offset] = bytes[offset + 1] = 0x78;
  const legacy = await WebAssembly.compile(bytes);
  const bridge = worker ? transferWorkerFixture(t) : null, clock = virtualClock(t); let f;
  try {
    f = await bufferedMixedFixture(t, clock, { untrained: true, swarmOptions: { coreWasm: legacy,
      ...(bridge ? { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl: bridge.WorkerImpl } : {}) } });
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.records.length, 0, 'source calibration did not probe the holder');
    const before = f.wholeLoads.length, load = beginCountedMultiLoad(f, f.ctx);
    sameBytes(await clock.settle(load.response), f.bytes);
    assert.equal(f.wholeLoads.length, before + 1); assert.equal(f.ranges.length, 0);
    assert.deepEqual(f.channels[0].wants, []); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.swarm.metrics().core.state, 'ready');
    if (worker) assert.equal(f.swarm.metrics().core.transferWorker.state, 'ready', 'ordinary missing capability does not retire the worker');
    assert.equal(load.calls.success.length, 1);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const exclusion of ['default', 'underflow', 'warm', 'part', 'no-have', 'no-recovery', 'probe-cooldown']) {
  test(`buffered mixed admission preserves immediate ordinary source for ${exclusion}`, async t => {
    const clock = virtualClock(t); let f;
    try {
      f = await bufferedMixedFixture(t, clock, { skipTraining: exclusion === 'no-recovery',
        ...(exclusion === 'probe-cooldown' ? { wholeOriginDelayMs: 100 } : {}),
        swarmOptions: { bufferedMixedRanges: exclusion !== 'default' } });
      let ctx = f.ctx;
      if (exclusion === 'underflow') f.hls.media.readyState = 2;
      if (exclusion === 'warm') ctx = { ...ctx, [WARM_AHEAD]: { peerBytes: 0 } };
      if (exclusion === 'part') ctx = { ...ctx, part: { index: 0, start: 10, duration: .1 } };
      if (exclusion === 'no-have') f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
      const before = f.wholeLoads.length, load = beginCountedMultiLoad(f, ctx);
      assert.equal(f.wholeLoads.length, before + 1, 'excluded paths do not spend the new setup interval');
      assert.equal(f.ranges.length, 0); assert.deepEqual(f.channels[0].wants, []);
      sameBytes(await clock.settle(load.response), f.bytes);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
}

test('buffered mixed late authority, caller abort and replacement fence all delayed setup callbacks', async t => {
  for (const ending of ['abort', 'replacement', 'disconnect', 'revoked']) {
    const clock = virtualClock(t); let f, release;
    try {
      f = await bufferedMixedFixture(t, clock, { untrained: ending === 'revoked',
        beforeCommitment: () => new Promise((resolve, reject) => {
          release = ending === 'revoked' ? () => reject(new Error('authority revoked')) : resolve;
        }) });
      const before = f.wholeLoads.length, pending = beginCountedMultiLoad(f, f.ctx);
      await clock.advance(5); assert.equal(typeof release, 'function');
      if (ending === 'abort') pending.loader.abort();
      if (ending === 'replacement') pending.loader.load(f.ctx, f.loaderConfig, { onSuccess() {} });
      if (ending === 'disconnect') f.connections[0].connectionState = 'disconnected';
      release(); await clock.advance(30);
      assert.deepEqual(f.channels[0].wants, []); assert.equal(f.ranges.length, 0);
      assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
      if (ending === 'abort') { assert.equal(pending.calls.abort.length, 1); assert.equal(f.wholeLoads.length, before); }
      else assert.equal(f.wholeLoads.length, before + 1);
    } finally { release?.(); if (f) await clock.settle(f.close()); clock.restore(); }
  }
});

test('buffered mixed fast Core plan returns to the existing cached winner without a renewed window', async t => {
  const core = await loadCore(multiCore), handle = core.transfer({ size: 1, sha256: '0'.repeat(64),
    pieces: ['0'.repeat(64)], deadline: 10000, maxHolders: 1, originReserveMs: 0 });
  const prototype = Object.getPrototypeOf(handle); handle.free();
  const original = prototype.start; let sawPeerOnly = false;
  const clock = virtualClock(t); let f;
  try {
    f = await bufferedMixedFixture(t, clock, { untrained: true });
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.records.length, 0,
      'source-only training does not invent a fast peer model or bypass the known whole-object fit guard');
    f.channels[0].firstByteMs = 1; f.channels[0].flowMs = 40; // The actual LAN-style body can finish before the source.
    t.mock.method(prototype, 'start', function (at, estimates) {
      const state = original.call(this, at, { ...estimates, probePeers: [],
        peers: estimates.peers.map(([id]) => [id, 0, 1_000_000]), origin: [100000, .001] });
      sawPeerOnly ||= state.commands.some(command => command.t === 'request') && !state.commands.some(command => command.t === 'origin');
      return state;
    });
    const before = f.wholeLoads.length, send = f.channels[0].send.bind(f.channels[0]);
    t.mock.method(f.channels[0], 'send', data => {
      if (typeof data === 'string' && JSON.parse(data).t === 'want') assert.equal(f.wholeLoads.length, before + 1, 'cached source starts before restored peer work');
      return send(data);
    });
    const load = beginCountedMultiLoad(f, f.ctx);
    sameBytes(await clock.settle(load.response), f.bytes);
    assert(sawPeerOnly, 'the negative uses an actual Core-generated peer-only plan');
    assert(f.channels[0].wants.length > 0); assert.equal(f.ranges.length, 0, 'the rejected mixed plan emitted no origin range or peer work');
    assert.equal(f.wholeLoads.length, before + 1); assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length, JSON.stringify(f.swarm.trace().rows.slice(-25)));
    const starts = f.swarm.trace().rows.filter(row => row.k === 'xfer' && row.op === 'start').slice(-2);
    assert.equal(starts.length, 2); assert.equal(starts[0].deadline, starts[1].deadline, 'handoff keeps the exact original peer deadline');
    const rows = f.swarm.trace().rows, originalLoad = rows.findLast(row => row.k === 'mixedScope' && row.reason === 'cached-handoff').load;
    const cachedLoad = rows.find(row => row.k === 'load' && row.load === starts[1].load);
    assert.notEqual(cachedLoad.load, originalLoad); assert.equal(cachedLoad.parentLoad, originalLoad,
      'the new cached trace ID links to its original mixed owner without carrying keys or identities');
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

class BufferedCorruptPeer extends PhasedFlowChannel {
  send(data) {
    const frame = typeof data === 'string' ? JSON.parse(data) : null;
    if (!this.corruptNext || frame?.t !== 'want') return super.send(data);
    const at = (frame.p?.[0] ?? 0) * commitmentPieceSize(this.bytes.length), saved = this.bytes[at];
    this.bytes[at] ^= 255;
    try { return super.send(data); } finally { this.bytes[at] = saved; }
  }
}

for (const bad of ['ignored-range', 'corrupt-peer', 'corrupt-probe']) {
  test(`buffered mixed ${bad} cancels its partial work before bounded source fallback without accepted peer credit`, async t => {
    const clock = virtualClock(t); let f;
    try {
      f = await bufferedMixedFixture(t, clock, bad === 'ignored-range' ? { ignoreRanges: true }
        : { untrained: bad === 'corrupt-probe',
          holders: [{ Channel: BufferedCorruptPeer, firstByteMs: 10, flowMs: 350 }], originDelayMs: 1000 });
      if (bad !== 'ignored-range') f.channels[0].corruptNext = true;
      const before = f.wholeLoads.length, pending = beginCountedMultiLoad(f, f.ctx);
      sameBytes(await clock.settle(pending.response), f.bytes);
      const metrics = f.swarm.metrics();
      assert.equal(metrics.bytes.peerFirst, 0); assert.equal(pending.calls.success.length, 1);
      assert.equal(f.wholeLoads.length, before + 1);
      assert(f.wholeLoads.at(-1).config.loadPolicy.maxLoadTimeMs < 10000, JSON.stringify({message:'fallback receives only the original remaining time',metrics,trace:f.swarm.trace().rows.slice(-20)}));
      if (bad === 'ignored-range') assert.equal(metrics.core.multiHolder.originRangesIgnored, 1);
      else {
        assert.equal(metrics.core.multiHolder.delivered, 0, 'a corrupted batch cannot become a completed peer load');
        assert.equal(metrics.core.multiHolder.bans, 1); assert.equal(metrics.segments.peerCorrupt, 1);
        assert.equal(f.channels[0].readyState, 'closed', 'rejected data still quarantines its source');
      }
      await clock.advance(3000); assert.equal(metrics.bytes.peerFirst, 0); assert.equal(pending.calls.success.length, 1);
    } finally { if (f) await clock.settle(f.close()); clock.restore(); }
  });
}

test('buffered mixed setup clock fence acts before its timer when an awaited authority callback runs late', async t => {
  const clock = virtualClock(t); let f, shift = 0;
  try {
    t.mock.method(performance, 'now', () => clock.now() + shift);
    f = await bufferedMixedFixture(t, clock, { beforeCommitment: () => { shift = 26; } });
    const before = f.wholeLoads.length, pending = beginCountedMultiLoad(f, f.ctx);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(f.wholeLoads.length, before + 1, 'explicit clock check refuses before the25ms timer task runs');
    assert.equal(f.ranges.length, 0); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.wholeLoads.at(-1).config.loadPolicy.maxLoadTimeMs, 9974);
    sameBytes(await clock.settle(pending.response), f.bytes);
  } finally { shift = 0; if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed rechecks the25ms guard after the original range loader constructor before any peer command', async t => {
  const clock = virtualClock(t); let f, shift = 0, constructions = 0, arm = false;
  const bytes = Uint8Array.from({ length: 1024 * 1024 }, (_, i) => (i * 131 + 17) % 251), whole = [], ranges = [];
  class ConstructorRace extends Loader {
    constructor() { super(); constructions++; if (arm) { arm = false; shift = 26; } }
    load(ctx, config, callbacks) {
      (ctx.rangeEnd ? ranges : whole).push({ ctx, config, invokedAtMs: performance.now() });
      setTimeout(() => callbacks.onSuccess({ data: bytes.slice(ctx.rangeStart ?? 0, ctx.rangeEnd ?? bytes.length).buffer }, this.stats, ctx, null), ctx.rangeEnd ? 100 : 500);
    }
  }
  try {
    t.mock.method(performance, 'now', () => clock.now() + shift);
    f = await bufferedMixedFixture(t, clock, { OriginLoader: ConstructorRace });
    const loader = new f.hls.config.fLoader(f.hlsConfig); arm = true;
    const before = f.swarm.metrics(), enteredAtMs = performance.now(); let successfulCallbacks = 0;
    const response = new Promise(resolve => loader.load(f.ctx, f.loaderConfig, { onSuccess: value => { successfulCallbacks++; resolve(value); } }));
    sameBytes(new Uint8Array((await clock.settle(response)).data), f.bytes);
    assert.equal(arm, false, 'the guard is reached inside the origin-range constructor');
    assert.equal(ranges.length, 0); assert.equal(whole.length, 2); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(whole.at(-1).config.loadPolicy.maxLoadTimeMs, 9974);
    assert.equal(successfulCallbacks, 1);
    const trace = f.swarm.trace(), metrics = f.swarm.metrics(), source = whole.at(-1);
    const load = trace.rows.filter(row => row.k === 'mixedScope' && row.reason === 'entry').at(-1).load;
    const proof = mixedScopeSetupProof(trace, { load, sn: f.ctx.frag.sn, cc: f.ctx.frag.cc, level: f.ctx.frag.level,
      size: f.bytes.length, fragmentStart: f.ctx.frag.start, fragmentDurationSeconds: f.ctx.frag.duration,
      enteredAtMs, invokedAtMs: source.invokedAtMs, parentMs: f.loaderConfig.loadPolicy.maxLoadTimeMs,
      ttfbMs: f.loaderConfig.loadPolicy.maxTimeToFirstByteMs, remainingLoadMs: source.config.loadPolicy.maxLoadTimeMs,
      remainingTtfbMs: source.config.loadPolicy.maxTimeToFirstByteMs,
      coreTransfersDelta: metrics.core.multiHolder.transfers - before.core.multiHolder.transfers,
      originRangeAttempts: metrics.core.multiHolder.originRanges - before.core.multiHolder.originRanges,
      physicalRangeGets: 0, clientRangeLoads: ranges.length, peerRequests: f.channels[0].wants.length,
      acceptedPeerBytes: metrics.bytes.peerFirst - before.bytes.peerFirst });
    assert.equal(proof?.stage, 'after-core-before-io', JSON.stringify({ traceDropped: trace.dropped,
      rows: trace.rows.filter(row => row.load === load), enteredAtMs, sourceInvokedAtMs: source.invokedAtMs }));
    console.log(JSON.stringify({ fixture: 'after-core-setup-policy', clockScope: 'logical-policy-inputs-not-elapsed-performance',
      stage: proof.stage, originRangeAttempts: 1, rangeLoaderInvocations: ranges.length, peerRequests: f.channels[0].wants.length,
      acceptedPeerBytes: metrics.bytes.peerFirst - before.bytes.peerFirst, successfulCallbacks, sequence: proof.sequence }));
  } finally { shift = 0; if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed ignores a late real worker allocation reply after the fixed setup cutoff', async t => {
  const nativeSetTimeout = setTimeout;
  let frees = 0;
  const { WorkerImpl, workers } = transferWorkerFixture(t, { onFree: () => { frees++; }, onRpc: () => {} }), clock = virtualClock(t); let f;
  // Real IPC has its own finite wall bound. Policy time stays stationary while
  // the actual Rust worker posts/holds its matching allocation reply; none of
  // these logical25ms observations is an elapsed-performance measurement.
  const waitForIPC = async predicate => {
    const deadline = process.hrtime.bigint() + 2_000_000_000n;
    while (!predicate()) {
      assert(process.hrtime.bigint() < deadline, 'actual worker IPC phase did not occur within its real2s bound');
      await new Promise(resolve => nativeSetTimeout(resolve, 1));
    }
  };
  try {
    f = await bufferedMixedFixture(t, clock, { swarmOptions: { transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } });
    await clock.advanceUntil(() => f.swarm.metrics().core.transferWorker.state === 'ready', 500);
    await waitForIPC(() => { const state = f.swarm.metrics().core.transferWorker; return state.transfers === 0 && state.pending === 0; });
    const worker = workers[0], priorNew = worker.newCount ?? 0, priorFree = frees, before = f.wholeLoads.length,
      originalParent = f.loaderConfig.loadPolicy.maxLoadTimeMs, originalTtfb = f.loaderConfig.loadPolicy.maxTimeToFirstByteMs;
    const began = clock.now(), connection = f.connections[0], channel = f.channels[0];
    worker.holdNew = true;
    const pending = beginCountedMultiLoad(f, f.ctx);
    await waitForIPC(() => (worker.newCount ?? 0) === priorNew + 1 && worker.newRequests?.length === 1);
    assert.equal(clock.now(), began, 'native IPC waits must not consume or move the logical setup clock');
    const held = worker.newRequests[0].data, posted = worker.rpcSent?.get(held.id);
    assert.equal(held.v, 1); assert.equal(held.ok, true); assert.equal(held.result, true);
    assert(posted); assert.equal(posted.id, held.id); assert.equal(posted.op, 'new'); assert.equal(posted.sentAtMs, began);
    assert.equal(worker.newIds.has(held.id), false, 'the actual posted allocation received this exact held reply');
    assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 1);
    assert.equal(f.wholeLoads.length, before); assert.equal(pending.calls.success.length, 0);
    await clock.advance(24); assert.equal(f.wholeLoads.length, before, 'held allocation cannot start recovery before its original cutoff');
    await clock.advance(1);
    assert.equal(clock.now(), began + 25); assert.equal(f.wholeLoads.length, before + 1);
    const source = f.wholeLoads.at(-1);
    assert.equal(source.config.loadPolicy.maxLoadTimeMs, originalParent - 25);
    assert.equal(source.config.loadPolicy.maxTimeToFirstByteMs, originalTtfb - 25);
    assert.equal(f.ranges.length, 0); assert.deepEqual(f.channels[0].wants, []); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    worker.releaseNew();
    await waitForIPC(() => { const state = f.swarm.metrics().core.transferWorker; return state.transfers === 0 && state.pending === 0; });
    assert.equal(clock.now(), began + 25, 'retirement IPC cannot move the source deadline either');
    assert.equal(frees, priorFree + 1); assert.equal(f.swarm.metrics().core.transferWorker.activeBytes, 0);
    assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0, 'the held transaction releases its admitted link lease');
    assert.equal(pending.calls.success.length, 0, 'the source still owns its incomplete whole body when the old reply is released');
    sameBytes(await clock.settle(pending.response), f.bytes);
    await clock.advance(100);
    assert.equal(pending.calls.success.length, 1); assert.equal(pending.calls.error.length, 0); assert.equal(pending.calls.abort.length, 0);
    assert.equal(f.wholeLoads.length, before + 1); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
    assert.equal(f.ranges.length, 0); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(f.swarm.metrics().core.transferWorker.transfers, 0); assert.equal(f.swarm.metrics().core.transferWorker.pending, 0);
    assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0);
    assert.equal(f.connections[0], connection); assert.equal(f.channels[0], channel); assert.equal(channel.readyState, 'open');
    console.log(JSON.stringify({ fixture: 'held-allocation-logical-policy', clockScope: 'logical-policy-inputs-not-elapsed-performance',
      newPosts: worker.newCount - priorNew, matchingHeldReply: true, policyAtPost: began, setupCutoffOffsetMs: 25,
      remainingParentMs: source.config.loadPolicy.maxLoadTimeMs, remainingTtfbMs: source.config.loadPolicy.maxTimeToFirstByteMs,
      wholeFallbacks: f.wholeLoads.length - before, successfulCallbacks: pending.calls.success.length,
      freePosts: frees - priorFree, claimedLinks: f.swarm.metrics().peerAdmission.claimedLinks,
      rangeInvocations: f.ranges.length, peerRequests: channel.wants.length, acceptedPeerBytes: f.swarm.metrics().bytes.peerFirst }));
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed retains a shorter absolute parent deadline through partial origin and late callbacks', async t => {
  const clock = virtualClock(t); let f;
  try {
    // Keep a positive peer interval after the existing 2s recovery reserve;
    // the declared parent still ends before the 10s buffered playback window.
    f = await bufferedMixedFixture(t, clock, { originDelayMs: 4000 });
    f.channels[0].firstByteMs = 1000;
    f.loaderConfig.loadPolicy.maxLoadTimeMs = 3000;
    const calls = { success: 0, timeout: 0, error: 0, abort: 0 };
    const loader = new f.hls.config.fLoader(f.hlsConfig);
    loader.load(f.ctx, f.loaderConfig, { onSuccess: () => calls.success++, onTimeout: () => calls.timeout++,
      onError: () => calls.error++, onAbort: () => calls.abort++ });
    await clock.advance(2999); assert.equal(calls.timeout, 0);
    assert(f.rangeLoaders.length > 0); assert(f.rangeLoaders.every(row => row.loaderConfig.loadPolicy.maxLoadTimeMs <= 3000));
    await clock.advance(1); assert.equal(calls.timeout, 1); assert.equal(calls.success, 0);
    await clock.advance(2000); assert.equal(calls.timeout, 1); assert.equal(calls.success, 0);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.equal(f.wholeLoads.length, 1, 'no fresh whole-source budget appears at an expired parent deadline');
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed whole fallback cannot renew an expired original TTFB after a synchronous key callback', async t => {
  const clock = virtualClock(t); let f, release, shift = 0, keyCalls = 0;
  try {
    t.mock.method(performance, 'now', () => clock.now() + shift);
    f = await bufferedMixedFixture(t, clock, { beforeCommitment: () => new Promise(resolve => { release = resolve; }),
      swarmOptions: { segmentKey: url => { if (++keyCalls === 4) shift = 80; return new URL(url).pathname; } } });
    // The parent can preserve recovery; the original 100ms first-byte bound
    // still expires during the synchronous fallback-key callback.
    f.loaderConfig.timeout = 3000; f.loaderConfig.loadPolicy.maxTimeToFirstByteMs = 100;
    const before = f.wholeLoads.length, calls = { success: 0, timeout: 0, error: 0 };
    new f.hls.config.fLoader(f.hlsConfig).load(f.ctx, f.loaderConfig, {
      onSuccess: () => calls.success++, onTimeout: () => calls.timeout++, onError: () => calls.error++ });
    await clock.advance(25);
    assert.equal(keyCalls, 4, 'the fourth key callback is the whole fallback preparation');
    assert.equal(f.wholeLoads.length, before, 'no original source invocation may receive a renewed first-byte budget');
    assert.equal(calls.timeout, 1); assert.equal(calls.success, 0); assert.equal(calls.error, 0);
    release?.(); await clock.advance(1000); assert.equal(calls.timeout, 1); assert.equal(calls.success, 0);
  } finally { shift = 0; release?.(); if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const parentMs of [100, 3000]) for (const ending of ['expiry', 'throw']) test(`buffered mixed whole fallback ${ending} retires the exact source owner once (parent${parentMs})`, async t => {
  const clock = virtualClock(t); let f, release, saved, reads = 0;
  try {
    f = await bufferedMixedFixture(t, clock, { beforeCommitment: () => new Promise(resolve => { release = resolve; }) });
    f.loaderConfig.timeout = parentMs; f.loaderConfig.loadPolicy.maxTimeToFirstByteMs = 80;
    const loader = new f.hls.config.fLoader(f.hlsConfig), calls = { success: 0, error: 0, timeout: 0 };
    t.mock.method(loader.inner, 'abort', () => {}); // Uncooperative: no onAbort or cancellation acknowledgement.
    t.mock.method(loader.inner, 'load', (ctx, config, callbacks) => {
      saved = { ctx, config, callbacks };
      if (ending === 'throw') throw new Error('fixture invocation failed');
    });
    const before = f.swarm.metrics().bytes.fromOrigin;
    loader.load(f.ctx, f.loaderConfig, { onSuccess: () => calls.success++, onError: () => calls.error++, onTimeout: () => calls.timeout++ });
    const setupMs = parentMs === 100 ? 0 : 25;
    if (setupMs) { await clock.advance(24); assert.equal(saved, undefined, 'valid mixed ownership retains only its setup window'); await clock.advance(1); }
    assert(saved, 'an insufficient-recovery100ms parent invokes source synchronously');
    assert.equal(saved.config.loadPolicy.maxLoadTimeMs, parentMs - setupMs);
    assert.equal(saved.config.loadPolicy.maxTimeToFirstByteMs, 80 - setupMs, 'the original80ms first-byte deadline is preserved');
    if (ending === 'expiry') {
      await clock.advance(parentMs - setupMs - 1); assert.equal(calls.timeout, 0);
      await clock.advance(1); assert.equal(calls.timeout, 1, 'retirement occurs at the exact captured parent deadline');
    }
    else assert.equal(calls.error, 1);
    saved.callbacks.onSuccess({ get data() { reads++; return f.bytes.slice().buffer; } }, loader.inner.stats, saved.ctx, null);
    release?.(); await clock.advance(1000);
    assert.equal(reads, 0, 'late source success cannot read/copy a body after owner retirement');
    assert.equal(calls.success, 0); assert.equal(calls.error + calls.timeout, 1);
    assert.equal(f.swarm.metrics().bytes.fromOrigin, before); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  } finally { release?.(); if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed entry clock includes a synchronous previous-loader abort', async t => {
  const clock = virtualClock(t); let f, shift = 0;
  try {
    t.mock.method(performance, 'now', () => clock.now() + shift);
    f = await bufferedMixedFixture(t, clock);
    const loader = new f.hls.config.fLoader(f.hlsConfig); let invoked;
    t.mock.method(loader.inner, 'abort', () => { shift = 30; });
    t.mock.method(loader.inner, 'load', (_ctx, config) => { invoked = config; });
    loader.load(f.ctx, f.loaderConfig, {});
    assert(invoked, 'exhausted setup invokes ordinary source immediately');
    assert.equal(invoked.loadPolicy.maxLoadTimeMs, 9970);
    assert.equal(f.ranges.length, 0); assert.deepEqual(f.channels[0].wants, []);
    loader.abort();
  } finally { shift = 0; if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const ending of ['connection', 'media', 'authority']) test(`buffered mixed cached handoff retains entry ${ending} fences`, async t => {
  const core = await loadCore(multiCore), handle = core.transfer({ size: 1, sha256: '0'.repeat(64), pieces: ['0'.repeat(64)], deadline: 10000, maxHolders: 1, originReserveMs: 0 });
  const prototype = Object.getPrototypeOf(handle); handle.free();
  const original = prototype.start, clock = virtualClock(t); let f, release, calls = 0;
  try {
    f = await bufferedMixedFixture(t, clock, { beforeCommitment: () => {
      if (++calls === 2) return new Promise((resolve, reject) => { release = ending === 'authority' ? () => reject(new Error('authority revoked')) : resolve; });
    } });
    t.mock.method(prototype, 'start', function (at, estimates) { return original.call(this, at, { ...estimates,
      probePeers: [], peers: estimates.peers.map(([id]) => [id, 0, 1_000_000]), origin: [100000, .001] }); });
    const pending = beginCountedMultiLoad(f, f.ctx);
    await clock.advanceUntil(() => typeof release === 'function', 25);
    if (ending === 'connection') f.connections[0].connectionState = 'disconnected';
    if (ending === 'media') f.hls.media.playbackRate = 2;
    release(); sameBytes(await clock.settle(pending.response), f.bytes);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0); assert.deepEqual(f.channels[0].wants, []);
    assert.equal(pending.calls.success.length, 1);
  } finally { release?.(); if (f) await clock.settle(f.close()); clock.restore(); }
});

class BufferedTailPeer extends PhasedFlowChannel {
  send(data) {
    const frame = typeof data === 'string' ? JSON.parse(data) : null;
    if (this.tailOnly && frame?.t === 'want' && ++this.tailWants > 1) {
      RecordedChannel.prototype.send.call(this, data); this.wants.push(frame.p ?? null); return;
    }
    return super.send(data);
  }
}

// Calibrate recovery through a real SDK source completion, then exercise
// silent peer retirement and verified source completion on the original clock.
for (const boundary of ['near-buffer', 'healthy-buffer', 'short-parent']) test('buffered mixed leaves the next source recovery intact at the ' + boundary, async t => {
  const clock = virtualClock(t); let f, demandAt = null;
  const size = (boundary === 'healthy-buffer' ? 6 : 1) * 1024 * 1024,
    source = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) % 251), sourceCalls = [];
  // Synthetic service, not an unobserved whole-GET counterfactual: calibration
  // and the first ordinary demand take2258ms, its successor2429ms.
  // Ranged bodies share a3329ms completion point for the first demand.
  class CadencedSource extends Loader {
    load(context, config, callbacks) {
      this.aborted = false;
      const from = context.rangeEnd ? context.rangeStart : 0, to = context.rangeEnd || size;
      const row = { from, to, ranged: Boolean(context.rangeEnd), at: clock.now(), completed: false, config }; this.row = row; sourceCalls.push(row);
      this.stats.loading = { start: clock.now(), first: 0, end: 0 };
      const delay = demandAt === null ? 2258 : row.ranged ? Math.max(0, demandAt + 3329 - clock.now()) : context.frag.sn === 1 ? 2258 : 2429;
      setTimeout(() => {
        if (this.aborted) return;
        row.completed = true; row.completedAt = clock.now(); this.stats.loaded = to - from;
        this.stats.loading.first = clock.now(); this.stats.loading.end = clock.now();
        callbacks.onSuccess({ data: source.slice(from, to).buffer, code: row.ranged ? 206 : 200 }, this.stats, context, null);
      }, delay);
    }
    abort() { this.aborted = true; if (this.row) this.row.aborted = true; }
    destroy() { this.destroyed = true; }
  }
  try {
    f = await bufferedMixedFixture(t, clock, { size, untrained: true, OriginLoader: CadencedSource,
      holders: [{ Channel: PhasedFlowChannel, firstByteMs: 10, flowMs: 350 }] });
    assert.equal(f.swarm.metrics().segments.originLatencyMedianMs, 2258);
    // A second genuine demand establishes its known same-link peer model;
    // the first no-HAVE request above supplied the actual source clock.
    f.hls.media.buffered = { length: 0 };
    sameBytes(await clock.settle(f.load(f.ctx)), f.bytes);
    assert(f.swarm.metrics().core.multiHolder.peerBytes > 0, 'genuine calibration verifies peer pieces without seeding a model');
    for (const channel of f.channels) channel.wants.length = 0;
    const reserve = 2258 * 1.25 + 100; assert.equal(reserve, 2922.5);
    let position = 10, end = 10 + (boundary === 'healthy-buffer' ? 12 : 3.446), lastAt = clock.now(), minimumAhead = Infinity;
    const playback = () => {
      const ahead = end - position - (clock.now() - lastAt) / 1000;
      minimumAhead = Math.min(minimumAhead, ahead); position = Math.min(end, position + (clock.now() - lastAt) / 1000); lastAt = clock.now();
      return ahead;
    };
    Object.defineProperty(f.hls.media, 'currentTime', { configurable: true, get() { playback(); return position; } });
    Object.defineProperty(f.hls.media, 'readyState', { configurable: true, get() { return playback() > 0 ? 4 : 2; } });
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => end };
    f.ctx.frag.start = end; f.ctx.frag.duration = 2;
    if (boundary === 'short-parent') f.loaderConfig.loadPolicy.maxLoadTimeMs = 3000;
    const before = sourceCalls.length, transfers = f.swarm.metrics().core.multiHolder.transfers, peerBefore = f.swarm.metrics().bytes.peerFirst;
    demandAt = clock.now(); const first = beginCountedMultiLoad(f, f.ctx);
    sameBytes(await clock.settle(first.response), f.bytes); const firstElapsed = clock.now() - demandAt;
    const afterFirst = playback(); end += 2;
    const demandSources = sourceCalls.slice(before), peer = f.swarm.metrics().bytes.peerFirst - peerBefore;
    f.channels[0].receive(JSON.stringify({ t: 'have', keys: [] }));
    const next = { ...f.ctx, url: 'https://origin.example/media/next.ts', frag: { ...f.ctx.frag, sn: 2, start: end, duration: 2 } };
    const secondAt = clock.now(), second = beginCountedMultiLoad(f, next);
    sameBytes(await clock.settle(second.response), f.bytes); playback(); end += 2;
    console.log(JSON.stringify({ fixture: 'next-source-recovery', boundary, reserveMs: reserve, firstElapsedMs: firstElapsed,
      nextElapsedMs: clock.now() - secondAt, minimumAheadMs: minimumAhead * 1000, peerBytes: peer,
      sourceBodies: demandSources.map(row => ({ ranged: row.ranged, bytes: row.to - row.from, complete: row.completed })) }));
    assert(minimumAhead >= 0, 'sequential genuine demands must not exhaust the captured playable buffer');
    if (boundary === 'healthy-buffer') {
      assert(demandSources.some(row => row.ranged && row.completed), 'healthy headroom actually runs source ranges');
      assert(peer > 0, 'the real committed Core verifies a nonzero peer contribution');
      assert.equal(demandSources.reduce((sum, row) => sum + (row.completed ? row.to - row.from : 0), 0) + peer, size,
        'complete206 bodies and accepted peer bytes retain disjoint ownership');
      assert(afterFirst * 1000 >= reserve, 'successful mixed completion retains the next whole-source recovery');
    } else {
      assert.equal(demandSources.length, 1); assert.equal(demandSources[0].ranged, false, 'near-edge admission starts ordinary whole HTTP');
      assert.equal(f.swarm.metrics().core.multiHolder.transfers, transfers, 'decline occurs before Core allocation');
      assert.equal(peer, 0);
      if (boundary === 'short-parent') assert.equal(demandSources[0].config.loadPolicy.maxLoadTimeMs, 3000,
        'mixed clipping never replaces the original shorter-parent whole budget');
    }
    assert.equal(first.calls.success.length, 1); assert.equal(second.calls.success.length, 1);
    assert.equal(first.calls.abort.length + first.calls.error.length + second.calls.abort.length + second.calls.error.length, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const boundary of ['buffer', 'buffer-with-next-reserve', 'parent', 'parent-without-reserve']) test('buffered mixed preserves measured source recovery at the ' + boundary + ' boundary', async t => {
  const clock = virtualClock(t); let f;
  const size = 1024 * 1024, sourceMs = 1600, source = Uint8Array.from({ length: size }, (_, i) => (i * 131 + 17) % 251), sourceCalls = [];
  class MeasuredSource extends Loader {
    load(context, config, callbacks) {
      this.aborted = false;
      const from = context.rangeEnd ? context.rangeStart : 0, to = context.rangeEnd || size;
      const row = { from, to, ranged: Boolean(context.rangeEnd), at: clock.now(), completed: false, aborted: false, config }; sourceCalls.push(row); this.row = row;
      this.stats.loading = { start: clock.now(), first: 0, end: 0 };
      setTimeout(() => {
        if (this.aborted) return;
        row.completed = true; row.completedAt = clock.now(); this.stats.loading.first = row.completedAt; this.stats.loading.end = row.completedAt;
        callbacks.onSuccess({ data: source.slice(from, to).buffer, code: row.ranged ? 206 : 200 }, this.stats, context, null);
      }, sourceMs * (to - from) / size);
    }
    abort() { this.aborted = true; if (this.row) this.row.aborted = true; }
    destroy() { this.destroyed = true; }
  }
  class SilentDemandPeer extends PhasedFlowChannel {
    send(data) {
      const frame = typeof data === 'string' ? JSON.parse(data) : null;
      if (this.quiet && frame?.t === 'want') {
        RecordedChannel.prototype.send.call(this, data); this.wants.push(frame.p ?? null); return;
      }
      return super.send(data);
    }
  }
  try {
    f = await bufferedMixedFixture(t, clock, { untrained: true, OriginLoader: MeasuredSource,
      holders: [{ Channel: SilentDemandPeer, firstByteMs: 10, flowMs: 350 }] });
    const measured = f.swarm.metrics().segments.originLatencyMedianMs;
    assert.equal(measured, sourceMs, 'recovery comes from the actual completed source calibration');
    const reserve = measured * 1.25 + 100; assert.equal(reserve, 2100);
    const headroomMs = boundary === 'buffer' ? 3000 : boundary === 'buffer-with-next-reserve' ? 5100 : 10000;
    const parentMs = boundary === 'parent' ? 3000 : boundary === 'parent-without-reserve' ? 1800 : 10000;
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 10 + headroomMs / 1000 };
    f.loaderConfig.loadPolicy.maxLoadTimeMs = parentMs;
    f.channels[0].quiet = true;
    const before = sourceCalls.length, start = clock.now(), pending = beginCountedMultiLoad(f, f.ctx);
    if (boundary === 'parent-without-reserve' || boundary === 'buffer') {
      assert.equal(sourceCalls.length, before + 1, 'insufficient current or next recovery starts ordinary source synchronously');
      assert.equal(sourceCalls.at(-1).ranged, false); assert.deepEqual(f.channels[0].wants, []);
      sameBytes(await clock.settle(pending.response, parentMs), f.bytes);
      assert.equal(sourceCalls.length, before + 1); assert.equal(f.swarm.metrics().core.multiHolder.transfers, 0);
    } else {
      await clock.advanceUntil(() => f.channels[0].wants.length > 0, 25);
      assert(sourceCalls.slice(before).some(row => row.ranged), 'the genuine demand starts its source before waiting for the probe');
      const spare = Math.min(parentMs, headroomMs - reserve) - reserve;
      await clock.advance(spare - (clock.now() - start));
      assert(f.channels[0].cancels > 0, 'silent peer must retire before consuming the measured source recovery reserve');
      const wants = f.channels[0].wants.length;
      sameBytes(await clock.settle(pending.response, reserve), f.bytes);
      assert.equal(f.channels[0].wants.length, wants, 'retired peer work cannot restart during source recovery');
      assert(sourceCalls.slice(before).every(row => row.ranged && row.completed), 'existing source ownership completes without another whole GET');
    }
    assert(clock.now() - start < Math.min(parentMs, headroomMs), 'one verified object completes before the unchanged parent/buffer deadline');
    assert.equal(pending.calls.success.length, 1); assert.equal(pending.calls.abort.length + pending.calls.error.length, 0);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0, 'a silent holder supplies no accepted peer bytes');
    await clock.advance(50); assert.equal(pending.calls.success.length, 1);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed retires peer work at its fixed cap while source ranges finish within the original parent', async t => {
  const clock = virtualClock(t); let f;
  try {
    f = await bufferedMixedFixture(t, clock, { originDelayMs: 3000,
      holders: [{ Channel: BufferedTailPeer, firstByteMs: 10, flowMs: 350 }] });
    f.channels[0].tailOnly = true; f.channels[0].tailWants = 0;
    const before = f.wholeLoads.length, start = clock.now(), pending = beginCountedMultiLoad(f, f.ctx);
    await clock.advance(2500);
    assert.equal(pending.calls.success.length, 0, 'unfinished source ranges cannot fabricate a complete object');
    assert.equal(f.wholeLoads.length, before, 'the peer cap must not discard the still-owned origin recovery lane');
    const peerRequests = f.channels[0].wants.length;
    sameBytes(await clock.settle(pending.response, 6000), f.bytes);
    assert(clock.now() - start > 2500 && clock.now() - start < 10000);
    assert.equal(f.channels[0].wants.length, peerRequests, 'no fresh peer request is issued after the original peer cap');
    assert.equal(f.wholeLoads.length, before, 'range completion does not need another whole-object GET');
    assert(f.swarm.metrics().bytes.peerFirst > 0, 'only the final complete object consumes the earlier verified fraction');
    assert(f.channels[0].cancels > 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const untrained of [false, true]) test('buffered mixed verifies a pre-cap ' + (untrained ? 'untrained ' : '') + 'peer body after its cap without renewing peer network work', async t => {
  const { WorkerImpl, workers } = transferWorkerFixture(t), clock = virtualClock(t); let f;
  try {
    f = await bufferedMixedFixture(t, clock, { untrained, originDelayMs: 3000,
      swarmOptions: { maxPeerWaitMs: 600, transferWorkerUrl: 'https://worker.example/transfer.js', WorkerImpl } });
    workers[0].holdDelivered = true;
    const before = f.wholeLoads.length, start = clock.now(), pending = beginCountedMultiLoad(f, f.ctx);
    await clock.advanceUntil(() => workers[0].deliveredReplies?.length > 0, 550);
    assert(clock.now() - start < 600, 'actual peer body completes before the original cap');
    assert(workers[0].deliveredReplies[0].result.verified > 0, 'the committed worker really verified the held peer body');
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0, 'verification is not consumed media');
    await clock.advance(601 - (clock.now() - start));
    const wants = f.channels[0].wants.length;
    workers[0].holdDelivered = false; workers[0].releaseDelivered();
    sameBytes(await clock.settle(pending.response, 6000), f.bytes);
    assert.equal(f.channels[0].wants.length, wants, 'late worker REQUEST commands cannot renew peer work');
    assert.equal(f.wholeLoads.length, before, 'the original source ranges retain their recovery ownership');
    assert(f.swarm.metrics().bytes.peerFirst > 0, 'only assembled verified media consumes the pre-cap fraction');
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

for (const headroomMs of [10000, 14000]) test('buffered mixed discards physical peer completion after its cap while keeping source recovery (' + headroomMs + 'ms buffered)', async t => {
  const clock = virtualClock(t); let f, shift = 0, late = false;
  try {
    t.mock.method(performance, 'now', () => clock.now() + shift);
    f = await bufferedMixedFixture(t, clock, { originDelayMs: 3000 });
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 10 + headroomMs / 1000 };
    const receive = f.channels[0].receive.bind(f.channels[0]);
    t.mock.method(f.channels[0], 'receive', data => {
      if (!late && typeof data === 'string' && JSON.parse(data).t === 'eof') { late = true; shift = 2600; }
      return receive(data);
    });
    const before = f.wholeLoads.length, enteredAt = performance.now(), pending = beginCountedMultiLoad(f, f.ctx);
    // The2600ms performance jump does not advance the mock timer clock. At
    //10s headroom, the source recovery callback reaches modeled8600ms and
    //must use the original1400ms whole fallback; its500ms body is observed
    //within the same original10s parent, rather than renewing that deadline.
    try { sameBytes(await clock.settle(pending.response, headroomMs === 10000 ? 7000 : 6000), f.bytes); }
    catch (error) {
      console.log(JSON.stringify({ fixture: 'late-physical-peer-cap', shift, late, now: performance.now(),
        calls: { success: pending.calls.success.length, abort: pending.calls.abort.length, error: pending.calls.error.length },
        wholeLoads: f.wholeLoads.length, before, ranges: f.ranges,
        decisions: f.swarm.trace().rows.filter(row => ['load', 'mixedScope', 'xferFinish'].includes(row.k)).slice(-16) }));
      throw error;
    }
    assert(late); assert(performance.now() - enteredAt < 10000, 'both outcomes retain the original absolute parent');
    if (headroomMs === 10000) {
      assert.equal(f.wholeLoads.length, before + 1);
      assert.equal(f.wholeLoads.at(-1).config.loadPolicy.maxLoadTimeMs, 1400);
      const rejected = f.swarm.trace().rows.find(row => row.k === 'mixedScope' && row.reason === 'current-recovery');
      assert.equal(rejected.mixedRemainingMs, -600); assert.equal(rejected.recoveryRemainingMs, 1400);
    } else assert.equal(f.wholeLoads.length, before, 'healthy next-recovery headroom preserves the original range owner');
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0, 'post-cap physical completion supplies no accepted peer media');
    assert(f.swarm.metrics().core.multiHolder.unusedBytes > 0, 'discarded late payload remains accounted');
  } finally { shift = 0; if (f) await clock.settle(f.close()); clock.restore(); }
});

test('buffered mixed origin recovery cannot outlive its original absolute parent', async t => {
  const clock = virtualClock(t); let f;
  try {
    f = await bufferedMixedFixture(t, clock, { originDelayMs: 5000, swarmOptions: { maxPeerWaitMs: 600 } });
    f.loaderConfig.timeout = 3000;
    const before = f.wholeLoads.length, calls = { success: 0, timeout: 0 };
    new f.hls.config.fLoader(f.hlsConfig).load(f.ctx, f.loaderConfig, { onSuccess: () => calls.success++, onTimeout: () => calls.timeout++ });
    await clock.advance(2999); assert.equal(calls.timeout, 0); assert.equal(calls.success, 0);
    assert(f.rangeLoaders.length > 0);
    await clock.advance(1); assert.equal(calls.timeout, 1);
    await clock.advance(6000); assert.equal(calls.success, 0); assert.equal(calls.timeout, 1);
    assert.equal(f.wholeLoads.length, before, 'expired recovery never starts another whole source request');
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  } finally { if (f) await clock.settle(f.close()); clock.restore(); }
});

async function cooperativeHaveReconsideration(t, paused = false, withdrawAtConstructor = false, declineMode = null, delayGenuineKeyMs = 0) {
  // Deterministic policy proof: simulated source/native RTC, real sessions,
  // commitments, Core, ordered protocol bytes, verification and consumption.
  // No source server, preloaded cache/HAVE, timing model or claimed WAN rate.
  const pair = await framingPairFixture(t, { pairedState: true }), actors = [], source = [], loaders = new Set(), objects = new Map(), events = new Map();
  let delayNextGenuineKey = false;
  const keyWork = logicalSegmentKeyDigests(t, base.swarmId, () => {
    if (!delayNextGenuineKey) return 0;
    delayNextGenuineKey = false; return delayGenuineKeyMs;
  });
  let clock, revokeOnConstructor = null, metadataHeld = false, metadataHeldAt = null, releaseMetadata, reenterAbort = null, stopAtContribution = false, contributionStopped = false;
  const settle = promise => clock ? clock.settle(promise) : promise;
  const wait = predicate => clock ? clock.advanceUntil(predicate) : until(predicate);
  const size = 1024 * 1024, secret = generateSecretKey(), seconds = Math.floor(Date.now() / 1000);
  const streamEvent = finalizeEvent({ kind: 30311, created_at: seconds,
    tags: [['d', 'reciprocal-futures'], ['relayswarm', 'redistribute', '1']], content: '' }, secret);
  const keyFor = path => createHash('sha256').update(`${base.swarmId}\n${path}`).digest('hex');
  const getCommitment = ctx => {
    const path = new URL(ctx.url).pathname, data = objects.get(path); assert(data);
    const id = `${path}:${ctx.frag.sn}:${ctx.frag.cc}`;
    if (!events.has(id)) {
      const pieceSize = commitmentPieceSize(data.length), pieces = [];
      for (let at = 0; at < data.length; at += pieceSize) pieces.push(createHash('sha256').update(data.subarray(at, at + pieceSize)).digest('hex'));
      events.set(id, finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds,
        tags: [['x', base.swarmId], ['e', streamEvent.id]], content: commitmentContent({ v: 3,
          streamEventId: streamEvent.id, swarmId: base.swarmId, key: keyFor(path), rendition: '/media/index.m3u8',
          playlist: '/media/index.m3u8', mediaType: 'main', encryption: null, sequence: ctx.frag.sn,
          discontinuity: ctx.frag.cc, part: null, sha256: createHash('sha256').update(data).digest('hex'),
          size: data.length, pieceSize, pieces, expiresAt: seconds + 60 }) }, secret));
    }
    return events.get(id);
  };
  const invoke = (actor, frag) => {
    const f = actors[actor], ctx = { url: frag.url, frag, part: null, type: LoaderContextType.MEDIA_FRAGMENT,
      responseType: 'arraybuffer', headers: {}, rangeStart: 0, rangeEnd: 0 };
    const loader = new f.hls.config.fLoader(f.hls.config), calls = { success: 0, error: 0, abort: 0, timeout: 0 };
    frag.stats = loader.stats;
    const response = new Promise((resolve, reject) => loader.load(ctx, { timeout: 10000 }, {
      onSuccess: value => { calls.success++; resolve(new Uint8Array(value.data)); },
      onError: () => { calls.error++; reject(new Error('reciprocal source error')); },
      onAbort: () => { calls.abort++; reject(new Error('reciprocal source abort')); },
      onTimeout: () => { calls.timeout++; reject(new Error('reciprocal source timeout')); },
    }));
    response.catch(() => {}); return { response, calls };
  };
  if (declineMode === 'callback-stop') {
    const original = CoreNeighbourDiscovery.prototype.context;
    t.mock.method(CoreNeighbourDiscovery.prototype, 'context', function (...args) {
      const result = original.apply(this, args);
      if (stopAtContribution) { stopAtContribution = false; contributionStopped = true; actors[1].swarm.stop(); }
      return result;
    });
  }
  // Own SDK/session timers too, including a stop reentered during a callback.
    // Functional controller only: hold actual async setup until either source
    // lane is invoked, without selecting a favourable result or seeding a model.
    clock = warmFunctionalClock(t, () => keyWork.pending > 0 || !metadataHeld && actors.some((f, actor) => {
      const rows = f.swarm.trace().rows;
      const load = rows.findLast(row => row.k === 'load' && row.sn === 1 && row.budgetGeometry?.source === 'warm-ahead');
      return load && rows.some(row => row.k === 'mixedScope' && row.load === load.load && row.reason === 'entry') &&
        !source.some(row => row.actor === actor && row.sn === 1);
    }));
  try {
    for (const actor of [0, 1]) {
      class Source extends Loader {
        stats = new LoadStats();
        constructor(...args) {
          super(...args);
          if (actor === 1 && declineMode === 'callback-stop' && source.some(row => row.actor === 0 && row.sn === 1 && row.complete)) stopAtContribution = true;
          if (actor === 1 && revokeOnConstructor) { const revoke = revokeOnConstructor; revokeOnConstructor = null; revoke(); }
        }
        load(ctx, config, callbacks) {
          const data = objects.get(new URL(ctx.url).pathname); assert(data);
          const from = ctx.rangeEnd ? ctx.rangeStart : 0, to = ctx.rangeEnd || data.length;
          const row = { actor, sn: ctx.frag.sn, warm: Boolean(ctx[WARM_AHEAD]), range: ctx.rangeEnd ? [from, to] : null,
            bytes: 0, complete: false, aborted: false, invokedAtMs: performance.now(),
            maxLoadTimeMs: config.loadPolicy?.maxLoadTimeMs ?? config.timeout }; source.push(row); loaders.add(this);
          this.stats.loading.start = performance.now();
          this.complete = () => {
            if (row.complete || row.aborted) return;
            row.complete = true; row.bytes = to - from; this.stats.loaded = this.stats.total = row.bytes;
            this.stats.loading.first = this.stats.loading.end = performance.now();
            callbacks.onSuccess({ data: data.slice(from, to).buffer, code: row.range ? 206 : 200 }, this.stats, ctx, null);
          };
          this.row = row;
          // Explicit functional-controller service scalars calibrate recovery
          // above two seconds; no native elapsed/performance claim or seeded
          // peer model is made by this logical-clock control.
          if (ctx.frag.sn === 0 || row.range) this.timer = setTimeout(this.complete, ctx.frag.sn === 0 ? 1600 : 20);
          // Whole speculative futures stay pending until their owner ledger is
          // checked, so no holder can have advertised either future yet.
        }
        abort() { clearTimeout(this.timer); if (this.row && !this.row.complete) this.row.aborted = true;
          if (actor === 1 && reenterAbort) { const enter = reenterAbort; reenterAbort = null; enter(); } }
        destroy() { this.abort(); loaders.delete(this); }
      }
      const media = Object.assign(new EventTarget(), { currentTime: 0, paused: false, ended: false, seeking: false,
        readyState: 4, playbackRate: 1, buffered: { length: 0 } });
      const commitment = ctx => {
        const event = getCommitment(ctx);
        if (declineMode && actor === 1 && ctx.frag.sn === 1 && ctx[WARM_AHEAD]?.work && !metadataHeld) {
          metadataHeld = true; metadataHeldAt = performance.now();
          return new Promise(resolve => { releaseMetadata = () => resolve(event); });
        }
        return event;
      };
      actors.push(await settle(pair.make({ OriginLoader: Source, player: { media }, swarmOptions: {
        streamEvent, getCommitment: commitment, warmAhead: true, bufferedMixedRanges: true, zeroBudgetPeerRace: true,
        sustainablePeerWait: true, originReserveMs: 2000, maxPeerWaitMs: 2500, traceRequests: 4096 } })));
    }
    await wait(() => actors.every(f => f.swarm.metrics().peers.connected === 1));
    const pubkeys = actors.map(f => f.swarm.metrics().pubkey), winner = path => {
      const key = BigInt('0x' + keyFor(path));
      return (key ^ BigInt('0x' + pubkeys[0])) < (key ^ BigInt('0x' + pubkeys[1])) ? 0 : 1;
    };
    const paths = [];
    for (const owner of [0]) {
      for (let n = 0; n < 256; n++) {
        const path = `/media/future-${owner}-${n}.ts`;
        if (winner(path) === owner) { paths.push(path); break; }
      }
    }
    assert.equal(paths.length, 1, 'actual peer identities elect actor0 for the single future');
    objects.set('/media/lead.ts', new Uint8Array(32768).fill(9));
    paths.forEach((path, index) => objects.set(path, Uint8Array.from({ length: size }, (_, i) => (i * 131 + index * 17) % 251)));
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10,\nlead.ts\n' +
      paths.map(path => `#EXTINF:2,\n${path.split('/').at(-1)}\n`).join('') + '#EXT-X-ENDLIST\n';
    const details = actors.map(f => {
      const parsed = M3U8Parser.parseLevelPlaylist(playlist, 'https://origin.example/media/index.m3u8', 0, 'main', 0, null);
      f.hls.levels = [{ details: parsed }]; return parsed;
    });
    for (const f of actors) assert.deepEqual([f.swarm.metrics().core.verifier, f.swarm.metrics().core.selection, f.swarm.metrics().core.discovery], ['wasm', 'wasm', 'wasm']);
    const lead = actors.map((_, actor) => invoke(actor, details[actor].fragments[0]));
    await settle(Promise.all(lead.map(x => x.response)));
    for (const f of actors) f.hls.media.buffered = { length: 1, start: () => 0, end: () => 10 };
    await wait(() => source.filter(row => row.sn > 0).length === 1);
    await wait(() => actors[1].swarm.metrics().warmAhead.active === 0 && actors[1].swarm.metrics().warmAhead.queued === 0);
    assert.equal(actors[1].swarm.metrics().warmAhead.started, 0, 'non-owner actually declined optional source before HAVE');
    const initial = source.filter(row => row.sn > 0);
    const advertised = pair.channels.flatMap(channel => channel.sent.filter(row => row?.t === 'have').flatMap(row => row.keys ?? row.add ?? []));
    assert(paths.every(path => !advertised.includes(keyFor(path))), 'neither held future body has been seeded or advertised');
    assert(actors.every(f => f.swarm.metrics().bytes.peerFirst === 0 && f.swarm.metrics().warmAhead.verifiedPeerBytes === 0));
    console.log(JSON.stringify({ fixture: 'reciprocal-warm-source-policy', simulatedSourceAndRtc: true,
      coreReady: actors.map(f => f.swarm.metrics().core.state), expectedOwners: [{ actor: 0, sn: 1 }],
      actualSourceStarts: initial.map(({ actor, sn, warm, range }) => ({ actor, sn, warm, range })),
      futureHaveCount: paths.filter(path => advertised.includes(keyFor(path))).length }));
    assert.deepEqual(initial.map(({ actor, sn }) => ({ actor, sn })).sort((a, b) => a.actor - b.actor),
      [{ actor: 0, sn: 1 }], 'only actual elected owner starts speculative whole source');
    assert(initial.every(row => row.warm && !row.range));
    let exactHaveDelivered = false;
    const listeners = pair.channels.map(channel => {
      const listener = event => { if (typeof event.data !== 'string') return;
        const frame = JSON.parse(event.data);
        if (frame.t === 'have' && (frame.keys ?? frame.add ?? []).includes(keyFor(paths[0]))) exactHaveDelivered = true;
      };
      channel.addEventListener('message', listener); return [channel, listener];
    });
    if (paused) { actors[1].hls.media.paused = true; actors[1].hls.media.dispatchEvent(new Event('pause')); }
    let supplyWithdrawn = false;
    if (withdrawAtConstructor) revokeOnConstructor = () => {
      const sender = pair.channels.find(channel => channel.sent.some(frame => frame?.t === 'have' &&
        (frame.keys ?? frame.add ?? []).includes(keyFor(paths[0]))));
      assert(sender?.other, 'the exact verified HAVE came from the real paired holder');
      sender.other.receive(JSON.stringify({ t: 'have', add: [], del: [keyFor(paths[0])] })); supplyWithdrawn = true;
    };
    for (const loader of loaders) if (loader.row?.actor === 0 && loader.row?.sn === 1) loader.complete();
    await wait(() => actors[0].swarm.metrics().warmAhead.verified === 1 && exactHaveDelivered);
    const atHave = performance.now();
    if (declineMode === 'callback-stop') {
      await wait(() => contributionStopped); await clock.advance(25);
      assert.equal(source.filter(row => row.actor === 1 && row.sn === 1).length, 0,
        'contribution callback stop cannot bypass optional ownership through direct inner.load');
      assert.equal(actors[1].swarm.metrics().bytes.peerFirst, 0); return;
    }
    if (declineMode) {
      await wait(() => metadataHeld);
      assert.equal(actors[1].swarm.metrics().warmAhead.haveReconsidered, 1);
      let demand;
      if (declineMode === 'genuine') demand = invoke(1, details[1].fragments[1]);
      if (declineMode === 'reentrant') reenterAbort = () => { demand = invoke(1, details[1].fragments[1]); };
      await clock.advance(Math.max(0, metadataHeldAt + 25 - performance.now()));
      await wait(() => actors[1].swarm.trace().rows.some(row => row.k === 'mixedScope' && row.reason === 'setup-timer'));
      const optionalStarts = () => source.filter(row => row.actor === 1 && row.sn === 1 && row.warm);
      console.log(JSON.stringify({ fixture: 'reconsidered-warm-setup-decline', controllerClock: 'logical-functional',
        mode: declineMode, elapsedMs: performance.now() - metadataHeldAt,
        optionalSources: optionalStarts().map(({ range, warm, maxLoadTimeMs }) => ({ range, warm, maxLoadTimeMs })),
        warm: actors[1].swarm.metrics().warmAhead }));
      if (declineMode === 'optional') {
        assert.equal(optionalStarts().length, 0, 'pure optional reconsideration must abandon setup decline instead of duplicate whole HTTP');
        assert.equal(actors[1].swarm.metrics().bytes.peerFirst, 0);
      } else {
        assert(demand, 'genuine entry was observed before or during abort cleanup');
        await wait(() => source.some(row => row.actor === 1 && row.sn === 1));
        for (const loader of loaders) if (loader.row?.actor === 1 && loader.row?.sn === 1) loader.complete();
        sameBytes(await settle(demand.response), objects.get(paths[0]));
        assert.deepEqual(demand.calls, { success: 1, error: 0, abort: 0, timeout: 0 });
        if (declineMode === 'genuine') {
          assert.equal(optionalStarts().length, 1); assert.equal(optionalStarts()[0].range, null);
          assert.equal(optionalStarts()[0].maxLoadTimeMs, 9975, 'promotion retains the original10s parent minus25ms setup');
        } else assert.equal(optionalStarts().length, 0, 'reentrant genuine must own new source, not dying optional work');
      }
      releaseMetadata(); await clock.advance(50);
      if (declineMode === 'optional') assert.equal(optionalStarts().length, 0, 'late metadata cannot revive cancelled optional work');
      return;
    }
    // One short observation of an event-driven opportunity. This is not a
    // larger setup/peer/row deadline; no genuine request is made to wake it.
    await clock.advance(100);
    if (!paused && !withdrawAtConstructor) await wait(() => actors[1].swarm.metrics().warmAhead.verified === 1);
    const receiver = actors[1].swarm.metrics(), targetStarts = source.filter(row => row.actor === 1 && row.sn === 1);
    const diagnostic = { fixture: 'exact-have-idle-warm-reconsideration', controllerClock: 'logical-functional', paused, withdrawAtConstructor, supplyWithdrawn,
      simulatedSourceAndRtc: true, actualSignedCommitmentAndCore: true, targetBytes: size,
      exactHaveDelivered, ownerWholeComplete: source.some(row => row.actor === 0 && row.sn === 1 && row.complete),
      observationAfterHaveMs: performance.now() - atHave,
      receiverWarm: receiver.warmAhead, receiverCore: receiver.core.state,
      receiverTargetSources: targetStarts.map(({ range, warm, complete }) => ({ range, warm, complete })),
      receiverAcceptedPeerBytes: receiver.bytes.peerFirst,
      receiverTrace: actors[1].swarm.trace().rows.filter(row => ['load', 'eligibility', 'mixedScope', 'xferFinish'].includes(row.k))
        .map(row => ({ k: row.k, sn: row.sn, role: row.budgetGeometry?.source, reason: row.reason })) };
    console.log(JSON.stringify(diagnostic));
    for (const [channel, listener] of listeners) channel.removeEventListener('message', listener);
    assert.equal(receiver.bytes.peerFirst, 0, 'warm verification before genuine consumption cannot earn accepted credit');
    if (!paused && !withdrawAtConstructor) {
      // After recording the idle result, prove that exact same current target
      // is genuinely eligible for the existing mixed engine when Hls wakes it.
      delayNextGenuineKey = delayGenuineKeyMs > 0;
      const demand = invoke(1, details[1].fragments[1]);
      sameBytes(await settle(demand.response), objects.get(paths[0]));
      assert.deepEqual(demand.calls, { success: 1, error: 0, abort: 0, timeout: 0 });
      const after = actors[1].swarm.metrics(), controlSources = source.filter(row => row.actor === 1 && row.sn === 1);
      assert(after.bytes.peerFirst > 0, 'the same target actually consumes verified peer bytes after a genuine wake');
      assert(controlSources.length > 0 && controlSources.every(row => row.range && row.complete),
        'the same target actually uses origin ranges, never a duplicate whole GET');
      assert.equal(controlSources.reduce((sum, row) => sum + row.bytes, 0) + after.bytes.peerFirst, size);
      console.log(JSON.stringify({ fixture: 'post-idle-genuine-mixed-control',
        acceptedPeerBytes: after.bytes.peerFirst, completeOriginRangeBytes: controlSources.reduce((sum, row) => sum + row.bytes, 0),
        targetBytes: size, coreReady: after.core.state, idleTargetSourceStarts: targetStarts.length,
        excludedNativeKeyDigests: keyWork.operations, deliberatelyDelayedKeyDigests: keyWork.delayedOperations }));
      if (delayGenuineKeyMs) assert.equal(keyWork.delayedOperations, 1);
    }
    if (withdrawAtConstructor) assert.equal(supplyWithdrawn, true, 'the final constructor callback actually withdrew the current exact HAVE');
    if (paused || withdrawAtConstructor) assert.equal(targetStarts.length, 0, 'pause or withdrawn exact supply before entry cannot start whole or ranged I/O');
    else assert(targetStarts.some(row => row.warm && row.range),
      'exact verified HAVE reconsiders the still-current skipped future without a new genuine request');
  } finally { releaseMetadata?.(); keyWork.restore(); clock?.restore(); pair.close(); for (const loader of [...loaders]) loader.destroy(); }
}

test('owned warm exact HAVE wakes an idle skipped future through real Core mixed assembly', { timeout: 15000 },
  t => cooperativeHaveReconsideration(t));
test('owned warm exact HAVE native key delivery cannot spend logical cache authority time', { timeout: 15000 },
  t => cooperativeHaveReconsideration(t, false, false, null, 40));
test('owned warm exact HAVE cannot restart skipped work after pause', { timeout: 15000 },
  t => cooperativeHaveReconsideration(t, true));
test('owned warm exact HAVE withdrawal during final constructor cannot fall through to whole HTTP', { timeout: 15000 },
  t => cooperativeHaveReconsideration(t, false, true));
for (const mode of ['optional', 'genuine', 'reentrant']) test(`owned warm reconsidered setup decline ${mode} retains correct source ownership`, { timeout: 15000 },
  t => cooperativeHaveReconsideration(t, false, false, mode));
test('owned warm reconsidered contribution callback stop cannot bypass source ownership', { timeout: 15000 },
  t => cooperativeHaveReconsideration(t, false, false, 'callback-stop'));
