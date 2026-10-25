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
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";
import { loadCore } from "../src/browser/core-wasm.mjs";
import { originClockOffsetMs, originClockSummary } from "../src/browser/origin-clock.mjs";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { commitmentContent, commitmentPieceSize, KIND_SEGMENT_COMMITMENT, verifySegmentCommitment } from "../src/browser/segment-commitment.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";
import { boundedOperation } from "../src/browser/bounded-operation.mjs";
import { NeighbourDiscovery } from "../src/browser/neighbour-discovery.mjs";
import { CoreNeighbourDiscovery } from "../src/browser/core-discovery.mjs";
import { PeerSelection } from "../src/browser/peer-selection.mjs";
import { createOperatorControls } from "../demo/operator.mjs";

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
    assert.deepEqual(metrics.core, { state: "ready", verifier: "wasm", selection: "wasm", discovery: "wasm", links: { wasm: 1, js: 0 }, fallbacks: 0, decided: { wasm: 2, js: 0 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
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
      assert.deepEqual(metrics.core, { state: "failed", verifier: "js", selection: "js", discovery: "js", links: { wasm: 0, js: 1 }, fallbacks, decided: { wasm: 0, js: 1 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
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
    assert.deepEqual({ ...core, links: core.links.wasm + core.links.js }, { state: "failed", verifier: "js", selection: "js", discovery: "js", links: 1, fallbacks: 1, decided: { wasm: 0, js: 0 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
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
  assert.deepEqual(swarm.metrics().core, { state: "off", verifier: "js", selection: "js", discovery: "js", links: { wasm: 0, js: 0 }, fallbacks: 0, decided: { wasm: 0, js: 0 }, transferWorker: { state: "off", reason: null }, multiHolder: { enabled: false, transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0, originRangeOutcomes: { payload: 0, "invalid-request": 0, "wrong-size": 0, error: 0, timeout: 0, abort: 0, exception: 0 }, timings: { durationMs: { p50: null, p90: null }, slowestRequestMs: { p50: null, p90: null }, requests: { p50: null, p90: null } } } });
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
    for (let i = 0; i < 3; i++) await f.fail(via);
    assert.equal(f.discovery().heldMiss, 3, "one held miss per demanded key");
    assert.equal(f.counters()["have-at-entry"], 3);
    assert.ok(f.rows().filter(row => row.reason === "have-at-entry").every(row => row.matchingHave === true && row.staleHolders.length === 0));
    assert.deepEqual(f.rows().filter(row => row.heldMissHolders?.length).map(row => row.heldMissHolders), [[label], [label], [label]]);
    await f.fail(via);
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
    for (let i = 0; i < 3; i++) await f.fail(via);
    assert.equal(f.discovery().heldMiss, 3);
    f.shift.ms += 10_001; f.touch();
    assert.deepEqual((await f.trigger(via)).staleHolders, [], "the neutral loads added no misses");
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

test("a request skipped because no recent transfer could finish charges no holder", async t => {
  const f = await staleHolderFixture(t, { originFallbackMs: 1000, serve: { bytes: bytes32, delayMs: 20 } });
  try {
    const via = f.candidate();
    f.holderChannel.bodyDelayMs = 250;
    await f.deliver(via);
    // Stay inside the projection's stretch tier using the actual completed
    // measurement. A fixed 220 ms can cross into projected-late on a busy
    // runner, before the minimum-completion guard under test is reached.
    const measured = f.swarm.metrics().peers.deliveryMeasurements.find(row => row.pubkey === f.holderKey).latencyMs;
    assert.ok(measured > 0);
    const room = measured * 0.9;
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 12 + room / 1000 } };
    await f.fail(via);
    assert.equal(f.swarm.metrics().segments.peerSkippedLate, 1);
    assert.equal(f.requests.length, 1, "the holder was not asked");
    assert.equal(f.discovery().heldMiss, 0);
    assert.ok(f.rows().every(row => !row.heldMissHolders?.length));
  } finally { await f.close(); }
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

const multiCore = await WebAssembly.compile(await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url)));

function transferWorkerFixture(t, { pauseInit = false, failDelivery = false, holdFinal = false } = {}) {
  const workers = [];
  class WorkerImpl extends EventTarget {
    constructor() {
      super(); workers.push(this);
      this.thread = new WorkerThread(new URL("./support/core-transfer-worker-thread.mjs", import.meta.url));
      this.exit = new Promise(resolve => this.thread.once("exit", resolve));
      this.thread.on("message", data => {
        if (holdFinal && data.result?.commands?.some(command => command.t === "deliver")) { this.finalReply = data; return; }
        this.dispatchEvent(new MessageEvent("message", { data }));
      });
      this.thread.on("error", () => this.dispatchEvent(new Event("error")));
    }
    postMessage(data, transfer) {
      if (pauseInit && data.op === "init") { this.init = data; return; }
      if (failDelivery && data.op === "delivered") { queueMicrotask(() => this.dispatchEvent(new Event("error"))); return; }
      this.thread.postMessage(data, transfer);
    }
    releaseInit() { this.thread.postMessage(this.init); }
    releaseFinal() { this.dispatchEvent(new MessageEvent("message", { data: this.finalReply })); }
    terminate() { this.terminated = true; return this.thread.terminate(); }
  }
  t.after(async () => { await Promise.all(workers.map(worker => worker.terminate())); await Promise.all(workers.map(worker => worker.exit)); });
  return { WorkerImpl, workers };
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

async function multiFixture(t, { holders, size = 200_000, multiHolder = true, framing = 2, commitmentVersion = 3, originFallbackMs = 3_000, originDelayMs = 0, wholeOriginDelayMs = 0, ignoreRanges = false, traceRequests = 0, peerSupplyHint = false, onPlayerHint = null, beforeCommitment = null, onPeerDelivery = null, swarmOptions = {} }) {
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
    segmentKey: (url) => new URL(url).pathname, coreWasm: multiCore, multiHolder, traceRequests, peerSupplyHint, onPlayerHint, onPeerDelivery, WebSocketImpl: memoryRelaySocket(), ...swarmOptions }, RangeLoader);
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
  return { ...f, bytes, channels, load, pieceSize, ranges, rangeLoaders, wholeLoads, hlsConfig, loaderConfig, get commitmentCalls() { return commitmentCalls; } };
}

function beginCountedMultiLoad(f) {
  const calls = { success: [], abort: [], error: [], progress: [] };
  let resolve;
  const response = new Promise(done => { resolve = done; });
  const loader = new f.hls.config.fLoader(f.hlsConfig);
  loader.load(multiContext, f.loaderConfig, {
    onSuccess: (...args) => { calls.success.push(args); resolve(new Uint8Array(args[0].data)); },
    onAbort: (...args) => calls.abort.push(args), onError: (...args) => calls.error.push(args),
    onProgress: (...args) => calls.progress.push(args),
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
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { size: 6 * 1024 * 1024,
      holders: [{ Channel: PhasedFlowChannel, firstByteMs: 20, flowMs: 20 }],
      originFallbackMs: 1800, wholeOriginDelayMs: 100, originDelayMs: 400,
      swarmOptions: { maxPeerWaitMs: 1800, zeroBudgetPeerRace: true } }));
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    assert.ok(f.swarm.metrics().bytes.peerFirst > 0, "the short-flow link first proves useful with verified media");
    f.channels[0].firstByteMs = 1000;
    f.hls.media = { currentTime: 10, buffered: { length: 0 } };
    const beforeAbort = f.channels[0].wants.length;
    sameBytes(await clock.settle(f.load(), 1000), f.bytes);
    assert.ok(f.channels[0].wants.length > beforeAbort, "the cancelled request must actually have reached the native channel");
    assert.equal(f.swarm.metrics().peerRequestDiagnostics.records.at(-1).outcome, "abort");
    assert.equal(f.swarm.metrics().peers.deliveryMeasurements[0].consecutiveFailures, 0,
      "a faster HTTP winner is not a delivery failure charged to the holder");
    await clock.advance(2);
    f.channels[0].firstByteMs = 20;
    const cancelled = f.channels[0].wants.length;
    f.hls.media.buffered = { length: 1, start: () => 0, end: () => 20 };
    sameBytes(await clock.settle(f.load(), 1500), f.bytes);
    assert.equal(f.channels[0].wants.length, cancelled,
      "unknown-rate usefulness cannot keep bypassing the refresh bound after a newer cancelled attempt");
    await clock.advance(10_001);
    sameBytes(await clock.settle(f.load(), 3000), f.bytes);
    assert.ok(f.channels[0].wants.length > cancelled, "a later real HAVE demand can still re-probe after the bound");
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
    assert.equal(f.channels[0].wants.length, 0, "a cold two-second segment reserves two seconds for origin");
    const cold = f.swarm.trace().rows.find(row => row.k === "eligibility");
    assert.equal(cold.budgetGeometry.sustainableMs, 0);
    assert.equal(cold.budgetGeometry.originRecoveryMs, 2_000);

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

test("sustainable peer waits preserve the independent cached-race window and verified contribution", async t => {
  const clock = virtualClock(t);
  let f;
  try {
    f = await clock.settle(multiFixture(t, { holders: [{ delayMs: 80 }], size: 12 * 65_536,
      wholeOriginDelayMs: 2_000, traceRequests: 256,
      swarmOptions: { sustainablePeerWait: true, zeroBudgetPeerRace: true, maxPeerWaitMs: 500 } }));
    f.hls.media = { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 30 } };
    const context = { ...multiContext, frag: { ...multiContext.frag, duration: 2 } };
    const pending = f.load(context);
    assert.equal(f.wholeLoads.length, 1, "zero sustainable wait starts ordinary HTTP synchronously despite a full buffer");
    sameBytes(await clock.settle(pending), f.bytes);
    const load = f.swarm.trace().rows.find(row => row.k === "load");
    assert.equal(load.budgetMs, 0); assert.equal(load.budgetGeometry.sustainableMs, 0);
    assert.equal(load.limitMs, 500, "cached peer work retains its own window while HTTP runs");
    assert.equal(f.swarm.metrics().segments.zeroBudgetPeerRaceWins, 1);
    assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
    assert.equal(f.wholeLoads[0].loader.aborted, true);
    assert.deepEqual(f.ranges, [], "cached races add no second origin download");
  } finally {
    if (f) await clock.settle(f.close());
    clock.restore();
  }
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
  const f = await multiFixture(t, { holders: [{ silent: true }], size: 12 * 65_536, originFallbackMs: 400, ignoreRanges: true });
  try {
    // A second framing 2 holder, connected now but holding nothing yet.
    const fresh = await f.addPeer(new RangedChannel(f.bytes));
    const peer = f.peers.at(-1), key = createHash("sha256").update(`${base.swarmId}\n/media/seg.ts`).digest("hex");
    sameBytes(await f.load(), new Uint8Array(32).fill(9), "the whole-segment origin bytes");
    assert.equal(f.swarm.metrics().core.multiHolder.delivered, 0);
    assert.equal(f.swarm.metrics().core.multiHolder.originRangesIgnored, 1);
    assert.deepEqual(fresh.wants, [], "the second holder had nothing to give");
    // That origin is now known to ignore ranges. The second holder would
    // start a transfer; instead the segment takes the single-holder path and
    // comes whole from it, with no range from origin.
    const { transfers, originRanges } = f.swarm.metrics().core.multiHolder;
    fresh.receive(JSON.stringify({ t: "have", keys: [key] }));
    peer.announcePresence({ role: "viewer", open: true, have: [key], transports: [{ type: "webrtc", publicKey: peer.pubkey, obj: 2 }] });
    await sleep(50);
    sameBytes(await f.load(), f.bytes, "the second holder's bytes");
    const after = f.swarm.metrics().core.multiHolder;
    assert.equal(after.transfers, transfers, "no second transfer");
    assert.equal(after.originRanges, originRanges, "no second ranged origin load");
    assert.deepEqual(fresh.wants, [null], "one whole-object request");
    assert.equal(after.originRangesIgnored, 1);
  } finally { await f.close(); }
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
    ...(start.peerOnly ? { peerOnly: true } : {}) });
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
