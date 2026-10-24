import test from "node:test";
import assert from "node:assert/strict";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { RealtimeDatagramLink, RealtimePeer, REALTIME_CHANNEL, REALTIME_TRANSPORT } from "../src/browser/realtime-peer.mjs";

class Channel extends EventTarget {
  label = REALTIME_CHANNEL;
  ordered = false; maxRetransmits = 0; maxPacketLifeTime = null;
  bufferedAmount = 0; readyState = "open"; sent = [];
  send(value) {
    this.sent.push(value.slice());
    if (this.other) queueMicrotask(() => this.other.receive(value.slice().buffer));
  }
  receive(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed"; this.dispatchEvent(new Event("close"));
  }
}
class PC extends EventTarget {
  static instances = [];
  localDescription = null; remoteDescription = null; connectionState = "new"; candidates = [];
  constructor(configuration) { super(); this.configuration = configuration; this.id = PC.instances.push(this) - 1; }
  createDataChannel(label, options) {
    this.channelOptions = { label, ...options }; this.channel = new Channel();
    if (options.maxPacketLifeTime !== undefined) { this.channel.maxPacketLifeTime = options.maxPacketLifeTime; this.channel.maxRetransmits = null; }
    return this.channel;
  }
  async createOffer() { return { type: "offer", sdp: `offer-pc-${this.id}` }; }
  async createAnswer() { return { type: "answer", sdp: `answer-pc-${this.id}` }; }
  async setLocalDescription(value) { this.localDescription = value; }
  async setRemoteDescription(value) {
    this.remoteDescription = value;
    if (value.type === "offer") {
      const id = Number(value.sdp.split("-").at(-1));
      this.other = PC.instances[id]; this.other.other = this;
      this.channel = new Channel(); this.channel.readyState = "connecting";
      this.channel.maxPacketLifeTime = this.other.channel.maxPacketLifeTime; this.channel.maxRetransmits = this.other.channel.maxRetransmits;
      this.channel.other = this.other.channel; this.other.channel.other = this.channel;
      this.other.channel.readyState = "connecting";
      const event = new Event("datachannel"); event.channel = this.channel; this.dispatchEvent(event);
    } else {
      for (const pc of [this, this.other]) {
        pc.channel.readyState = "open"; pc.channel.dispatchEvent(new Event("open"));
      }
    }
  }
  async addIceCandidate(candidate) { this.candidates.push(candidate); }
  close() { this.connectionState = "closed"; this.closed = true; }
}
function fixture(t, options = {}) {
  const pc = new PC(), channel = new Channel(), received = [], closed = [];
  const link = new RealtimeDatagramLink({ pc, channel, onDatagram: data => received.push([...data]),
    onClose: reason => closed.push(reason), ...options });
  t.after(() => link.close()); return { pc, channel, received, closed, link };
}
test("live link bounds buffered bytes, drops expired data and never queues retries", t => {
  let at = 100;
  const { link, channel } = fixture(t, { maxDatagramBytes: 16, maxBufferedBytes: 32, now: () => at });
  assert.equal(link.send(new Uint8Array([1]), { deadlineMs: 101 }), true);
  at = 101; assert.equal(link.send(new Uint8Array([2]), { deadlineMs: 101 }), false);
  channel.bufferedAmount = 32; assert.equal(link.send(new Uint8Array([3])), false);
  channel.bufferedAmount = 31; assert.equal(link.send(new Uint8Array([4])), true);
  channel.bufferedAmount = 0;
  assert.deepEqual(channel.sent.map(x => [...x]), [[1], [4]]);
  assert.equal(link.snapshot().deadlineDrops, 1); assert.equal(link.snapshot().backpressureDrops, 1);
  assert.throws(() => link.send(new Uint8Array(17)), /Invalid real-time datagram/);
});
test("live link rejects reliable, ordered, timed or wrong-labelled channel instead of downgrading", () => {
  for (const settings of [{ ordered: true }, { maxRetransmits: null }, { maxRetransmits: 1 }, { maxPacketLifeTime: 10 }, { label: "relayswarm" }]) {
    const channel = Object.assign(new Channel(), settings);
    assert.throws(() => new RealtimeDatagramLink({ channel, pc: new PC(), onDatagram() {} }), /Invalid/);
  }
});
test("explicit finite lifetime requires an exact unreliable mode match and never falls back", t => {
  const channel = Object.assign(new Channel(), { maxRetransmits: null, maxPacketLifeTime: 50 });
  const { link } = fixture(t, { channel, maxPacketLifeTimeMs: 50 });
  assert.equal(link.snapshot().delivery, 'finite-lifetime'); assert.equal(link.snapshot().maxPacketLifeTimeMs, 50);
  for (const settings of [{ maxRetransmits: 0, maxPacketLifeTime: null }, { maxRetransmits: null, maxPacketLifeTime: 51 },
    { maxRetransmits: null, maxPacketLifeTime: null }, { ordered: true, maxRetransmits: null, maxPacketLifeTime: 50 }]) {
    assert.throws(() => new RealtimeDatagramLink({ pc: new PC(), channel: Object.assign(new Channel(), settings), maxPacketLifeTimeMs: 50, onDatagram() {} }), /Invalid/);
  }
  for (const lifetime of [0, 1001, 1.5, NaN]) assert.throws(() => new RealtimeDatagramLink({ pc: new PC(), channel, maxPacketLifeTimeMs: lifetime, onDatagram() {} }), /Invalid/);
});
test("abort closes once, removes receive listeners and never leaks callback error details", t => {
  const signal = new AbortController(), { link, channel, closed, received, pc } = fixture(t, { signal: signal.signal });
  channel.receive(new Uint8Array([3]).buffer); assert.deepEqual(received, [[3]]);
  signal.abort(); signal.abort(); link.close("anything-private");
  channel.receive(new Uint8Array([4]).buffer);
  assert.deepEqual(received, [[3]]); assert.deepEqual(closed, ["abort"]); assert.equal(pc.closed, true);
  assert.equal(link.send(new Uint8Array([4])), false);
});
test("oversize or text messages close rather than retaining unbounded frames", t => {
  for (const value of ["secret payload", new Uint8Array(17).buffer, new ArrayBuffer(0)]) {
    const { channel, link, received, closed } = fixture(t, { maxDatagramBytes: 16 });
    channel.receive(value); assert.equal(link.closed, true); assert.deepEqual(received, []); assert.deepEqual(closed, ["protocol"]);
  }
});
test("async receive work is bounded and handler rejection closes generically", async t => {
  let release;
  const { channel, link, closed } = fixture(t, { maxReceivePending: 1, onDatagram: () => new Promise((_, reject) => { release = reject; }) });
  channel.receive(new Uint8Array([1]).buffer); channel.receive(new Uint8Array([2]).buffer);
  assert.equal(link.snapshot().receivePending, 1); assert.equal(link.snapshot().receiveDrops, 1);
  release(new Error("private provider detail")); await settle();
  assert.deepEqual(closed, ["handler"]); assert.equal(link.snapshot().receivePending, 0);
  assert.equal(JSON.stringify(link.snapshot()).includes("private"), false);
});
function session() {
  const handlers = new Set();
  return { pubkey: "1".repeat(64), handlers, onSignal(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    sendSignal() {}, receive(payload, from = "2".repeat(64)) { for (const fn of handlers) fn({ from, payload }); } };
}
async function settle() { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); }
test("encrypted session envelope pins peer, transport and negotiation ID; early candidates remain bounded", async t => {
  const s = session(), p = new RealtimePeer({ session: s, peerPubkey: "2".repeat(64), initiator: false, RTCPeerConnectionImpl: PC, onDatagram() {} });
  t.after(() => p.close()); p.start();
  const envelope = { type: "candidate", transport: REALTIME_TRANSPORT, requestId: "selected-123", payload: { candidate: { candidate: "candidate-1" } } };
  s.receive(envelope, "3".repeat(64)); s.receive({ ...envelope, transport: "webrtc" });
  assert.equal(p.earlyCandidates.length, 0);
  s.receive(envelope); s.receive({ ...envelope, requestId: "unrelated-123" });
  const offerer = new PC(); offerer.channel = new Channel();
  s.receive({ ...envelope, type: "offer", payload: { sdp: `offer-pc-${offerer.id}` } });
  await settle();
  assert.deepEqual(p.pc.candidates, [{ candidate: "candidate-1" }]);
  s.receive({ ...envelope, requestId: "unrelated-123" }); await settle();
  assert.equal(p.pc.candidates.length, 1);
  for (let i = 0; i < 128; i++) s.receive(envelope);
  assert.equal(p.closed, true); assert.equal(s.handlers.size, 0);
});
test("timeout and pre-abort retire native resources and session subscription", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = session(), p = new RealtimePeer({ session: s, peerPubkey: "2".repeat(64), initiator: false, RTCPeerConnectionImpl: PC, timeoutMs: 50, onDatagram() {} });
  p.start(); t.mock.timers.tick(50); await assert.rejects(p.ready, /^Error: Real-time peer closed\.$/);
  assert.equal(p.pc.closed, true); assert.equal(s.handlers.size, 0);
  const controller = new AbortController(); controller.abort();
  const aborted = new RealtimePeer({ session: s, peerPubkey: "2".repeat(64), initiator: false, RTCPeerConnectionImpl: PC, signal: controller.signal, onDatagram() {} });
  await assert.rejects(aborted.start(), /Real-time peer closed/); assert.equal(s.handlers.size, 0);
});
function memoryRelaySocket(events) {
  const sockets = new Set();
  return class extends EventTarget {
    subscriptions = new Set();
    constructor() { super(); sockets.add(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
    send(text) {
      const [type, id] = JSON.parse(text);
      if (type === "REQ") this.subscriptions.add(id);
      else if (type === "CLOSE") this.subscriptions.delete(id);
      else if (type === "EVENT") {
        events.push(id);
        for (const socket of sockets) for (const subscription of socket.subscriptions) queueMicrotask(() => {
          if (sockets.has(socket)) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(["EVENT", subscription, id]) }));
        });
      }
    }
    close() { sockets.delete(this); this.dispatchEvent(new Event("close")); }
  };
}
for (const lifetime of [undefined, 50]) test(`real RelayPool and NIP-44 session negotiate ${lifetime ?? 'zero-retry'} live datagrams with injected ICE and encrypted SDP`, async t => {
  const events = [], Socket = memoryRelaySocket(events), pools = [], sessions = [], peers = [], received = [];
  t.after(() => { for (const p of peers) p.close(); for (const s of sessions) s.close(); for (const p of pools) p.close(); });
  for (let i = 0; i < 2; i++) {
    const pool = new RelayPool(["wss://relay.example"], { WebSocketImpl: Socket }); pools.push(pool); await pool.connect();
    const s = new RelaySwarmSession({ pool, swarmId: "opaque-call-fixture" }); sessions.push(s); s.start();
  }
  const iceServers = [{ urls: "turn:relay.example:3478?transport=udp", username: "ephemeral-test", credential: "not-a-root-secret" }];
  for (let i = 0; i < 2; i++) peers.push(new RealtimePeer({ session: sessions[i], peerPubkey: sessions[1 - i].pubkey,
    initiator: i === 0, iceServers, iceTransportPolicy: "relay", RTCPeerConnectionImpl: PC,
    maxPacketLifeTimeMs: lifetime, onDatagram: value => received.push({ i, value: [...value] }) }));
  peers[1].start(); peers[0].start(); await Promise.all(peers.map(p => p.ready));
  assert.deepEqual(peers[0].pc.channelOptions, { label: REALTIME_CHANNEL, ordered: false,
    ...(lifetime === undefined ? { maxRetransmits: 0 } : { maxPacketLifeTime: lifetime }) });
  for (const p of peers) assert.deepEqual(p.pc.configuration, { iceServers, iceTransportPolicy: "relay" });
  assert.equal(peers[0].send(new Uint8Array([7, 8])), true); await settle();
  assert.deepEqual(received, [{ i: 1, value: [7, 8] }]);
  assert.ok(events.length >= 2); assert.ok(events.every(e => !e.content.includes("offer-pc") && !e.content.includes("answer-pc")));
  assert.equal(JSON.stringify(peers.map(p => p.snapshot())).includes("not-a-root-secret"), false);
  peers[0].close(); assert.equal(sessions[0].signalHandlers.size, 0);
});
