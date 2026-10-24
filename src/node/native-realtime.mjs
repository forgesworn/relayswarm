import { REALTIME_CHANNEL } from '../browser/realtime-peer.mjs';

export const NATIVE_REALTIME_PACKAGE_VERSION = '0.33.4';
export const NATIVE_REALTIME_LIBRARY_VERSION = '0.24.5-forgesworn-turn-close.1';
const MAX_DATAGRAM_BYTES = 16_384;
const encoder = new TextEncoder();
const failure = () => new Error('Native real-time transport refused the operation.');

function event(target, type, properties = {}) {
  const value = Object.assign(new Event(type), properties);
  target.dispatchEvent(value);
  const handler = target[`on${type}`];
  if (typeof handler === 'function') handler.call(target, value);
}
function bounded(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function text(value, maximum) { return typeof value === 'string' && encoder.encode(value).length <= maximum; }
function configuration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['iceServers', 'iceTransportPolicy'].includes(key))
    || !Array.isArray(value.iceServers) || value.iceServers.length > 8
    || !['all', 'relay'].includes(value.iceTransportPolicy)) throw failure();
  const iceServers = [];
  for (const server of value.iceServers) {
    const urls = typeof server?.urls === 'string' ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 8) throw failure();
    for (const uri of urls) {
      if (!text(uri, 2048) || /[\u0000-\u0020\u007f]/.test(uri)) throw failure();
      const match = /^(stun|turn|turns):([^/?#]+)(?:\?transport=(udp|tcp))?$/.exec(uri);
      if (!match || !/^(?:\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::[0-9]{1,5})?$/.test(match[2])) throw failure();
      const authority = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(match[2]);
      const hostname = new URL(`http://${match[2]}`).hostname.replace(/^\[|\]$/g, '');
      const port = authority[2] === undefined ? (match[1] === 'turns' ? 5349 : 3478) : Number(authority[2]);
      if (!bounded(port, 1, 65535) || hostname.length > 253 || match[1] === 'stun' && match[3] === 'tcp'
        || match[1] === 'turns' && match[3] === 'udp') throw failure();
      if (match[1] === 'stun') iceServers.push({ hostname, port });
      else {
        // This pinned libdatachannel build uses libjuice, which supports
        // TURN/UDP only and otherwise silently ignores TCP/TLS servers.
        // Refuse that configuration before any peer can fall back to direct.
        if (match[1] !== 'turn' || match[3] === 'tcp') throw failure();
        if (!text(server.username, 2048) || !server.username.length || !text(server.credential, 2048) || !server.credential.length
          || server.credentialType !== undefined && server.credentialType !== 'password') throw failure();
        // Structured ICE preserves opaque REST usernames/passwords, including
        // colons, slashes and plus signs. They never become URI user-info.
        iceServers.push({ hostname, port, username: server.username, password: server.credential,
          relayType: 'TurnUdp' });
      }
      if (iceServers.length > 16) throw failure();
    }
  }
  return { iceServers, iceTransportPolicy: value.iceTransportPolicy, maxMessageSize: MAX_DATAGRAM_BYTES,
    disableFingerprintVerification: false };
}

/** Inject the pinned dependency from the dedicated operator process. Importing
 * RelaySwarm does not install/load native code, codecs or media APIs.
 *
 * This backend ONLY initiates. Its channel attributes describe its own exact
 * native create request. The browser answerer checks real remote DCEP values.
 * Unknown incoming channels and remote offers are closed, never relabelled. */
export async function createNativeRealtimeBackend({ nodeDataChannel, packageVersion,
  maxPacketLifeTimeMs = 250, maxPeers = 64 } = {}) {
  const native = nodeDataChannel?.default ?? nodeDataChannel;
  if (packageVersion !== NATIVE_REALTIME_PACKAGE_VERSION || !bounded(maxPacketLifeTimeMs, 1, 1000)
    || !bounded(maxPeers, 1, 64) || typeof native?.PeerConnection !== 'function'
    || typeof native.initLogger !== 'function' || typeof native.cleanup !== 'function'
    || typeof native.getLibraryVersion !== 'function') throw failure();
  // v0.33.4's native implementation maps "None" to rtc::LogLevel::None,
  // despite the published TypeScript LogLevel union omitting that spelling.
  // Its JS wrapper forwards an undefined second argument when omitted, which
  // the native overload rejects. An inert callback with level None emits none.
  native.initLogger('None', () => {});
  if (native.getLibraryVersion() !== NATIVE_REALTIME_LIBRARY_VERSION) throw failure();
  const owned = new Set();
  let stopped = false, disposed = false;

  class NativeChannel extends EventTarget {
    #native;
    #closed = false;
    #state = 'connecting';
    #binaryType = 'arraybuffer';
    #threshold = 0;
    constructor(channel, peer) {
      super(); this.#native = channel;
      if (channel.getLabel() !== REALTIME_CHANNEL) throw failure();
      Object.defineProperties(this, { label: { value: channel.getLabel(), enumerable: true },
        ordered: { value: false, enumerable: true }, maxPacketLifeTime: { value: maxPacketLifeTimeMs, enumerable: true },
        maxRetransmits: { value: null, enumerable: true }, negotiated: { value: false },
        protocol: { value: channel.getProtocol() } });
      if (channel.isOpen()) this.#state = 'open';
      channel.onOpen(() => { if (!this.#closed) { this.#state = 'open'; event(this, 'open'); } });
      channel.onClosed(() => { if (!this.#closed) { this.#closed = true; this.#state = 'closed'; event(this, 'close'); } });
      channel.onError(() => { if (!this.#closed) { event(this, 'error'); peer.close(); } });
      channel.onBufferedAmountLow(() => { if (!this.#closed) event(this, 'bufferedamountlow'); });
      channel.onMessage(message => {
        if (this.#closed) return;
        const bytes = message instanceof ArrayBuffer ? new Uint8Array(message)
          : message instanceof Uint8Array ? message : null;
        if (!bytes || bytes.byteLength < 1 || bytes.byteLength > MAX_DATAGRAM_BYTES) { peer.close(); return; }
        // Never expose a pooled Buffer's unrelated bytes to an endpoint.
        event(this, 'message', { data: new Uint8Array(bytes).buffer });
      });
    }
    get id() { const id = this.#native.getId(); return id < 0 ? null : id; }
    get readyState() { return this.#closed ? 'closed' : this.#state; }
    get binaryType() { return this.#binaryType; }
    set binaryType(value) { if (value !== 'arraybuffer') throw failure(); this.#binaryType = value; }
    get bufferedAmount() { return this.#closed ? 0 : this.#native.bufferedAmount(); }
    get bufferedAmountLowThreshold() { return this.#threshold; }
    set bufferedAmountLowThreshold(value) {
      if (!bounded(value, 0, 4_194_304) || this.#closed) throw failure();
      this.#native.setBufferedAmountLowThreshold(value); this.#threshold = value;
    }
    send(value) {
      const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;
      if (this.readyState !== 'open' || !bytes || bytes.byteLength < 1
        || bytes.byteLength > Math.min(MAX_DATAGRAM_BYTES, this.#native.maxMessageSize())) throw failure();
      // libdatachannel send(false) means accepted into its buffer, not failure.
      // The shared datagram link checks bufferedAmount before this standard
      // void send operation. Native exceptions still refuse the operation.
      try { this.#native.sendMessageBinary(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)); }
      catch { throw failure(); }
    }
    close() {
      if (this.#closed) return;
      this.#closed = true; this.#state = 'closed';
      try { this.#native.close(); } catch { /* Complete peer cleanup. */ }
      event(this, 'close');
    }
  }

  class NativeInitiatorPeerConnection extends EventTarget {
    #native;
    #channel = null;
    #closed = false;
    #local = null;
    #remote = null;
    #offer;
    #resolveOffer;
    #rejectOffer;
    constructor(config = { iceServers: [], iceTransportPolicy: 'relay' }) {
      super();
      if (stopped || owned.size >= maxPeers) throw failure();
      let converted;
      try { converted = configuration(config); } catch { throw failure(); }
      this.#offer = new Promise((resolve, reject) => { this.#resolveOffer = resolve; this.#rejectOffer = reject; });
      this.#offer.catch(() => {});
      try {
        this.#native = new native.PeerConnection('realtime-operator', converted);
        owned.add(this);
        this.#native.onLocalDescription((sdp, type) => {
          if (this.#closed) return;
          if (type !== 'offer' || !text(sdp, 6144) || !sdp.length) { this.close(); return; }
          this.#local = { type: 'offer', sdp }; this.#resolveOffer({ ...this.#local });
        });
        this.#native.onLocalCandidate((candidate, sdpMid) => {
          if (this.#closed) return;
          if (!text(candidate, 4096) || !text(sdpMid, 256)) { this.close(); return; }
          event(this, 'icecandidate', { candidate: { candidate, sdpMid, sdpMLineIndex: 0 } });
        });
        for (const [method, type] of [['onStateChange', 'connectionstatechange'], ['onIceStateChange', 'iceconnectionstatechange'],
          ['onGatheringStateChange', 'icegatheringstatechange'], ['onSignalingStateChange', 'signalingstatechange']]) {
          this.#native[method](() => { if (!this.#closed) event(this, type); });
        }
        this.#native.onDataChannel(channel => {
          // This backend cannot inspect remote DCEP reliability. It refuses
          // incoming channels rather than inventing their negotiated mode.
          try { channel.close(); } catch { /* Still close this peer. */ }
          this.close();
        });
      } catch { this.close(); throw failure(); }
    }
    get connectionState() { return this.#closed ? 'closed' : this.#native.state(); }
    get iceConnectionState() { return this.#closed ? 'closed' : this.#native.iceState(); }
    get iceGatheringState() { return this.#closed ? 'complete' : this.#native.gatheringState(); }
    get signalingState() { return this.#closed ? 'closed' : this.#native.signalingState(); }
    get localDescription() { return this.#closed ? this.#local : this.#native.localDescription() ?? this.#local; }
    get remoteDescription() { return this.#remote; }
    getConfiguration() { throw failure(); }
    createDataChannel(label, options) {
      if (this.#closed || this.#channel || label !== REALTIME_CHANNEL || !options || options.ordered !== false
        || options.maxPacketLifeTime !== maxPacketLifeTimeMs || options.maxRetransmits != null
        || options.negotiated === true || options.protocol && options.protocol !== '' || options.id !== undefined) throw failure();
      let channel;
      try {
        channel = this.#native.createDataChannel(label, { unordered: true, maxPacketLifeTime: maxPacketLifeTimeMs });
        this.#channel = new NativeChannel(channel, this); return this.#channel;
      } catch { try { channel?.close(); } catch {} this.close(); throw failure(); }
    }
    async createOffer() { if (this.#closed || !this.#channel) throw failure(); return this.#offer; }
    async createAnswer() { this.close(); throw failure(); }
    async setLocalDescription(description) {
      if (this.#closed || description?.type !== 'offer' || !this.#local || description.sdp !== this.#local.sdp) { this.close(); throw failure(); }
      // Native channel creation already negotiated and applied this offer.
    }
    async setRemoteDescription(description) {
      if (this.#closed || !this.#channel || !this.#local || description?.type !== 'answer'
        || !text(description.sdp, 6144) || !description.sdp.length || this.#remote) { this.close(); throw failure(); }
      try { this.#native.setRemoteDescription(description.sdp, 'answer'); this.#remote = { type: 'answer', sdp: description.sdp }; }
      catch { this.close(); throw failure(); }
    }
    async addIceCandidate(candidate) {
      if (this.#closed) throw failure();
      if (candidate == null || candidate.candidate === '') return;
      if (!this.#remote || !text(candidate.candidate, 4096) || !text(candidate.sdpMid, 256) || !candidate.sdpMid.length) throw failure();
      try { this.#native.addRemoteCandidate(candidate.candidate, candidate.sdpMid); } catch { throw failure(); }
    }
    close() {
      if (this.#closed) return;
      this.#closed = true; owned.delete(this); this.#rejectOffer(failure());
      try { this.#channel?.close(); } catch { /* Continue native peer cleanup. */ }
      try { this.#native?.close(); } catch { /* A failed close cannot retain ownership. */ }
      event(this, 'connectionstatechange');
    }
  }
  const closeOwnedPeers = () => { stopped = true; for (const peer of [...owned]) peer.close(); };
  return { RTCPeerConnectionImpl: NativeInitiatorPeerConnection, closeOwnedPeers,
    snapshot: () => ({ ownedPeers: owned.size, closed: stopped, disposed, packageVersion, libraryVersion: NATIVE_REALTIME_LIBRARY_VERSION,
      role: 'initiator-only', maxPacketLifeTimeMs }),
    disposeForProcessExit() {
      if (disposed) return;
      disposed = true; closeOwnedPeers(); native.cleanup();
    } };
}
