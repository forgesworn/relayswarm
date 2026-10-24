import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeRealtimeBackend, NATIVE_REALTIME_PACKAGE_VERSION } from '../src/node/native-realtime.mjs';
import { REALTIME_CHANNEL } from '../src/browser/realtime-peer.mjs';

function fixture() {
  const peers = [], logs = [];
  let cleanups = 0;
  class Channel {
    callbacks = {}; sent = []; amount = 0; closed = 0; open = false; sendResult = true;
    getLabel() { return REALTIME_CHANNEL; }
    getProtocol() { return ''; }
    getId() { return 1; }
    isOpen() { return this.open; }
    bufferedAmount() { return this.amount; }
    maxMessageSize() { return 16_384; }
    setBufferedAmountLowThreshold(value) { this.threshold = value; }
    onOpen(callback) { this.callbacks.open = callback; }
    onClosed(callback) { this.callbacks.close = callback; }
    onError(callback) { this.callbacks.error = callback; }
    onMessage(callback) { this.callbacks.message = callback; }
    onBufferedAmountLow(callback) { this.callbacks.low = callback; }
    sendMessageBinary(value) { assert(Buffer.isBuffer(value)); this.sent.push([...value]); return this.sendResult; }
    close() { this.closed++; }
  }
  class Peer {
    callbacks = {}; stateValue = 'new'; local = null; remote = null; candidates = []; closed = 0;
    constructor(name, config) { this.name = name; this.config = config; peers.push(this); }
    onLocalDescription(callback) { this.callbacks.description = callback; }
    onLocalCandidate(callback) { this.callbacks.candidate = callback; }
    onStateChange(callback) { this.callbacks.state = callback; }
    onIceStateChange(callback) { this.callbacks.ice = callback; }
    onGatheringStateChange(callback) { this.callbacks.gather = callback; }
    onSignalingStateChange(callback) { this.callbacks.signal = callback; }
    onDataChannel(callback) { this.callbacks.channel = callback; }
    createDataChannel(label, config) {
      this.channel = new Channel(); this.request = { label, config };
      this.local = { type: 'offer', sdp: 'generated-offer' }; this.callbacks.description(this.local.sdp, 'offer');
      return this.channel;
    }
    state() { return this.stateValue; }
    iceState() { return 'new'; }
    gatheringState() { return 'new'; }
    signalingState() { return this.remote ? 'stable' : 'have-local-offer'; }
    localDescription() { return this.local; }
    setRemoteDescription(sdp, type) { this.remote = { sdp, type }; }
    addRemoteCandidate(candidate, mid) { this.candidates.push({ candidate, mid }); }
    close() { this.closed++; this.stateValue = 'closed'; }
  }
  const native = { PeerConnection: Peer, initLogger: level => logs.push(level), getLibraryVersion: () => '0.24.5', cleanup: () => { cleanups++; } };
  return { peers, logs, native, Channel, cleanups: () => cleanups };
}
async function backend(f, options = {}) {
  return createNativeRealtimeBackend({ nodeDataChannel: f.native, packageVersion: NATIVE_REALTIME_PACKAGE_VERSION, ...options });
}
const config = () => ({ iceServers: [], iceTransportPolicy: 'all' });
const delivery = () => ({ ordered: false, maxPacketLifeTime: 250 });

test('native initiator creates only the requested bounded finite-lifetime channel and applies a browser answer', async t => {
  const f = fixture(), b = await backend(f); t.after(() => b.closeOwnedPeers());
  const pc = new b.RTCPeerConnectionImpl(config()), channel = pc.createDataChannel(REALTIME_CHANNEL, delivery());
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  assert.deepEqual(offer, { type: 'offer', sdp: 'generated-offer' });
  assert.deepEqual(f.peers[0].request, { label: REALTIME_CHANNEL, config: { unordered: true, maxPacketLifeTime: 250 } });
  assert.equal(channel.ordered, false); assert.equal(channel.maxPacketLifeTime, 250); assert.equal(channel.maxRetransmits, null);
  await pc.setRemoteDescription({ type: 'answer', sdp: 'browser-answer' });
  assert.deepEqual(f.peers[0].remote, { type: 'answer', sdp: 'browser-answer' });
  assert.deepEqual(pc.remoteDescription, { type: 'answer', sdp: 'browser-answer' });
  assert.deepEqual(f.logs, ['None']); assert.equal(f.cleanups(), 0);
  assert.equal(f.peers[0].config.disableFingerprintVerification, false);
});

test('ICE defaults contain no STUN service and structured TURN keeps opaque credentials intact', async t => {
  const f = fixture(), b = await backend(f); t.after(() => b.closeOwnedPeers());
  new b.RTCPeerConnectionImpl(config());
  assert.deepEqual(f.peers[0].config.iceServers, []);
  new b.RTCPeerConnectionImpl({ iceTransportPolicy: 'relay', iceServers: [{
    urls: ['turn:relay.invalid:3478?transport=udp', 'turn:relay.invalid:3479?transport=tcp', 'turns:[2001:db8::1]:5349?transport=tcp'],
    username: 'expiry:opaque/label', credential: 'opaque:+/=password',
  }] });
  assert.deepEqual(f.peers[1].config.iceServers, [
    { hostname: 'relay.invalid', port: 3478, username: 'expiry:opaque/label', password: 'opaque:+/=password', relayType: 'TurnUdp' },
    { hostname: 'relay.invalid', port: 3479, username: 'expiry:opaque/label', password: 'opaque:+/=password', relayType: 'TurnTcp' },
    { hostname: '2001:db8::1', port: 5349, username: 'expiry:opaque/label', password: 'opaque:+/=password', relayType: 'TurnTls' },
  ]);
  assert.equal(f.peers[1].config.iceTransportPolicy, 'relay');
});

test('configuration and version failures allocate no peers and never relax relay or DTLS policy', async () => {
  const f = fixture();
  await assert.rejects(() => backend(f, { packageVersion: '0.33.3' }));
  for (const value of [0, 1001, NaN]) await assert.rejects(() => backend(f, { maxPacketLifeTimeMs: value }));
  const b = await backend(f);
  for (const value of [{ iceServers: [] }, { iceServers: [], iceTransportPolicy: 'guess' },
    { ...config(), disableFingerprintVerification: true }, { ...config(), iceServers: [{ urls: 'https://relay.invalid/' }] },
    { ...config(), iceServers: [{ urls: 'turns:relay.invalid?transport=udp', username: 'u', credential: 'p' }] },
    { ...config(), iceServers: [{ urls: 'turn:relay.invalid' }] }]) assert.throws(() => new b.RTCPeerConnectionImpl(value));
  assert.equal(f.peers.length, 0); b.closeOwnedPeers();
});

test('reliable, ordered, different-lifetime and second channels are refused rather than relabelled', async t => {
  const f = fixture(), b = await backend(f); t.after(() => b.closeOwnedPeers());
  const pc = new b.RTCPeerConnectionImpl(config());
  for (const options of [{ ordered: true, maxPacketLifeTime: 250 }, { ordered: false, maxRetransmits: 0 },
    { ordered: false, maxPacketLifeTime: 251 }, { ...delivery(), negotiated: true }, { ...delivery(), id: 4 }]) {
    assert.throws(() => pc.createDataChannel(REALTIME_CHANNEL, options));
  }
  assert.throws(() => pc.createDataChannel('other-channel', delivery()));
  pc.createDataChannel(REALTIME_CHANNEL, delivery());
  assert.throws(() => pc.createDataChannel(REALTIME_CHANNEL, delivery()));
  assert.deepEqual(f.peers[0].request.config, { unordered: true, maxPacketLifeTime: 250 });
});

test('remote offers, answer creation and unknown incoming channels close the initiator', async t => {
  const f = fixture(), b = await backend(f); t.after(() => b.closeOwnedPeers());
  const offered = new b.RTCPeerConnectionImpl(config()); offered.createDataChannel(REALTIME_CHANNEL, delivery());
  await assert.rejects(() => offered.setRemoteDescription({ type: 'offer', sdp: 'remote-offer' }));
  assert.equal(offered.connectionState, 'closed');
  const answerer = new b.RTCPeerConnectionImpl(config()); await assert.rejects(() => answerer.createAnswer());
  assert.equal(answerer.connectionState, 'closed');
  const unexpected = new b.RTCPeerConnectionImpl(config()); unexpected.createDataChannel(REALTIME_CHANNEL, delivery());
  let exposed = 0; unexpected.addEventListener('datachannel', () => { exposed++; });
  const incoming = new f.Channel(); f.peers[2].callbacks.channel(incoming);
  assert.equal(incoming.closed, 1); assert.equal(unexpected.connectionState, 'closed'); assert.equal(exposed, 0);
  assert.equal(b.snapshot().ownedPeers, 0);
});

test('send(false) is buffered acceptance, bytes are not duplicated and pooled receive buffers stay bounded', async t => {
  const f = fixture(), b = await backend(f); t.after(() => b.closeOwnedPeers());
  const pc = new b.RTCPeerConnectionImpl(config()), channel = pc.createDataChannel(REALTIME_CHANNEL, delivery()), native = f.peers[0].channel;
  native.open = true; native.callbacks.open(); native.sendResult = false;
  assert.doesNotThrow(() => channel.send(new Uint8Array([1, 2, 3])));
  assert.deepEqual(native.sent, [[1, 2, 3]]);
  let received;
  channel.addEventListener('message', event => { received = [...new Uint8Array(event.data)]; });
  const pooled = Buffer.from([99, 4, 5, 88]); native.callbacks.message(pooled.subarray(1, 3));
  assert.deepEqual(received, [4, 5]); pooled.fill(0); assert.deepEqual(received, [4, 5]);
  native.amount = 123; assert.equal(channel.bufferedAmount, 123);
  channel.bufferedAmountLowThreshold = 10; assert.equal(native.threshold, 10);
  assert.throws(() => channel.send(new Uint8Array(16385)));
  assert.throws(() => channel.send('text'));
});

test('malformed native input closes the peer and later callbacks cannot deliver data', async t => {
  const f = fixture(), b = await backend(f); t.after(() => b.closeOwnedPeers());
  for (const bad of ['untrusted text', new Uint8Array(), new Uint8Array(16385)]) {
    const pc = new b.RTCPeerConnectionImpl(config()), channel = pc.createDataChannel(REALTIME_CHANNEL, delivery()), native = f.peers.at(-1).channel;
    let count = 0; channel.addEventListener('message', () => { count++; });
    native.callbacks.message(bad); native.callbacks.message(new Uint8Array([1]));
    assert.equal(pc.connectionState, 'closed'); assert.equal(count, 0);
  }
});

test('native ICE callbacks trickle bounded candidates and accept them only after a remote answer', async t => {
  const f = fixture(), b = await backend(f); t.after(() => b.closeOwnedPeers());
  const pc = new b.RTCPeerConnectionImpl(config()); pc.createDataChannel(REALTIME_CHANNEL, delivery());
  let received; pc.addEventListener('icecandidate', event => { received = event.candidate; });
  f.peers[0].callbacks.candidate('candidate:generated', '0');
  assert.deepEqual(received, { candidate: 'candidate:generated', sdpMid: '0', sdpMLineIndex: 0 });
  await assert.rejects(() => pc.addIceCandidate(received));
  await pc.setRemoteDescription({ type: 'answer', sdp: 'generated-answer' });
  await pc.addIceCandidate(received); assert.deepEqual(f.peers[0].candidates, [{ candidate: 'candidate:generated', mid: '0' }]);
  await pc.addIceCandidate(null);
});

test('factory closes all owned peers once, bounds capacity and reserves global cleanup for explicit process exit', async () => {
  const f = fixture(), b = await backend(f, { maxPeers: 2 });
  const first = new b.RTCPeerConnectionImpl(config()); first.createDataChannel(REALTIME_CHANNEL, delivery());
  new b.RTCPeerConnectionImpl(config());
  assert.throws(() => new b.RTCPeerConnectionImpl(config()));
  b.closeOwnedPeers(); b.closeOwnedPeers();
  assert.equal(b.snapshot().ownedPeers, 0); assert.equal(f.cleanups(), 0);
  assert.deepEqual(f.peers.map(peer => peer.closed), [1, 1]);
  assert.equal(f.peers[0].channel.closed, 1);
  assert.throws(() => new b.RTCPeerConnectionImpl(config()));
  b.disposeForProcessExit(); b.disposeForProcessExit(); assert.equal(f.cleanups(), 1);
});
