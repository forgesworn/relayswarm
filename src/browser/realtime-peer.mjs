// Opaque, deadline-sensitive datagrams. Deliberately separate from PeerLink's
// ordered HLS response protocol. The application authenticates/encrypts media,
// admits participants, fragments frames and supplies any TURN credentials.
export const REALTIME_TRANSPORT = "webrtc-live";
export const REALTIME_CHANNEL = "relayswarm-live-v1";
const HEX64 = /^[0-9a-f]{64}$/u;
const ID = /^[a-zA-Z0-9_-]{8,64}$/u;
const utf8 = new TextEncoder();
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const clock = () => performance.now();
const reasons = new Set(["host", "abort", "timeout", "protocol", "signal", "native", "channel", "send", "handler"]);
const states = {
  connectionState: new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]),
  iceConnectionState: new Set(["new", "checking", "connected", "completed", "failed", "disconnected", "closed"]),
  iceGatheringState: new Set(["new", "gathering", "complete"]),
  signalingState: new Set(["stable", "have-local-offer", "have-remote-offer", "have-local-pranswer", "have-remote-pranswer", "closed"]),
};
function bounded(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function bytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  return null;
}
function realtime(channel, lifetime) {
  return channel.label === REALTIME_CHANNEL && channel.ordered === false && (lifetime === undefined
    ? channel.maxRetransmits === 0 && channel.maxPacketLifeTime === null
    : channel.maxRetransmits === null && channel.maxPacketLifeTime === lifetime);
}

export class RealtimeDatagramLink {
  constructor({ pc, channel, maxDatagramBytes = 16_384, maxBufferedBytes = 262_144, maxReceivePending = 16, maxPacketLifeTimeMs,
    onDatagram, onClose, signal, now = clock } = {}) {
    if (!pc || !channel || maxPacketLifeTimeMs !== undefined && !bounded(maxPacketLifeTimeMs, 1, 1000)
      || !realtime(channel, maxPacketLifeTimeMs) || !bounded(maxDatagramBytes, 1, 65_536)
      || !bounded(maxBufferedBytes, maxDatagramBytes, 4_194_304) || typeof now !== "function"
      || !bounded(maxReceivePending, 1, 256) || typeof onDatagram !== "function") throw new Error("Invalid real-time datagram link.");
    Object.assign(this, { pc, channel, maxDatagramBytes, maxBufferedBytes, maxReceivePending, maxPacketLifeTimeMs, onDatagram, onClose, signal, now });
    this.closed = false;
    this.receivePending = 0;
    this.counters = { sent: 0, received: 0, sentBytes: 0, receivedBytes: 0, backpressureDrops: 0, receiveDrops: 0, deadlineDrops: 0, closedDrops: 0 };
    channel.binaryType = "arraybuffer";
    this.message = (event) => {
      if (this.closed) return;
      const payload = bytes(event.data);
      if (!payload || payload.byteLength === 0 || payload.byteLength > this.maxDatagramBytes) return this.close("protocol");
      if (this.receivePending >= this.maxReceivePending) { this.counters.receiveDrops = increment(this.counters.receiveDrops); return; }
      this.counters.received = increment(this.counters.received);
      this.counters.receivedBytes = Math.min(Number.MAX_SAFE_INTEGER, this.counters.receivedBytes + payload.byteLength);
      this.receivePending++;
      try {
        const result = this.onDatagram(payload);
        if (result && typeof result.then === "function") Promise.resolve(result).catch(() => this.close("handler")).finally(() => { this.receivePending--; });
        else this.receivePending--;
      } catch { this.receivePending--; this.close("handler"); }
    };
    this.ended = () => this.close("channel");
    this.connection = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.close("native");
    };
    this.abort = () => this.close("abort");
    channel.addEventListener("message", this.message);
    channel.addEventListener("close", this.ended);
    channel.addEventListener("error", this.ended);
    pc.addEventListener("connectionstatechange", this.connection);
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.close("abort");
  }

  // deadlineMs is an absolute value on the injected monotonic clock. No
  // transport queue, retry or delayed send can carry expired application data.
  send(value, { deadlineMs = Infinity } = {}) {
    const payload = bytes(value);
    if (!payload || payload.byteLength === 0 || payload.byteLength > this.maxDatagramBytes) throw new Error("Invalid real-time datagram.");
    if (this.closed || this.channel.readyState !== "open") {
      this.counters.closedDrops = increment(this.counters.closedDrops); return false;
    }
    const at = this.now();
    if (!Number.isFinite(at) || !(deadlineMs === Infinity || Number.isFinite(deadlineMs)) || at >= deadlineMs) {
      this.counters.deadlineDrops = increment(this.counters.deadlineDrops); return false;
    }
    const buffered = this.channel.bufferedAmount;
    if (!Number.isFinite(buffered) || buffered < 0 || buffered + payload.byteLength > this.maxBufferedBytes) {
      this.counters.backpressureDrops = increment(this.counters.backpressureDrops); return false;
    }
    try { this.channel.send(payload); }
    catch { this.close("send"); return false; }
    this.counters.sent = increment(this.counters.sent);
    this.counters.sentBytes = Math.min(Number.MAX_SAFE_INTEGER, this.counters.sentBytes + payload.byteLength);
    return true;
  }

  snapshot() { return { ...this.counters, closed: this.closed, maxDatagramBytes: this.maxDatagramBytes,
    maxBufferedBytes: this.maxBufferedBytes, maxReceivePending: this.maxReceivePending, receivePending: this.receivePending,
    delivery: this.maxPacketLifeTimeMs === undefined ? 'zero-retransmit' : 'finite-lifetime', maxPacketLifeTimeMs: this.maxPacketLifeTimeMs ?? null }; }

  close(reason = "host") {
    if (this.closed) return;
    this.closed = true;
    this.channel.removeEventListener("message", this.message);
    this.channel.removeEventListener("close", this.ended);
    this.channel.removeEventListener("error", this.ended);
    this.pc.removeEventListener("connectionstatechange", this.connection);
    this.signal?.removeEventListener("abort", this.abort);
    try { this.channel.close(); } catch {}
    try { this.pc.close(); } catch {}
    try { this.onClose?.(reasons.has(reason) ? reason : "host"); } catch {}
  }
}

/** One explicitly selected peer, signalled by an already-started
 * RelaySwarmSession. Never announces presence or adopts an event's services.
 * Construct both sides, then call start(); only the initiator makes an offer.
 * The receiver accepts one negotiation ID from its pinned peer. Replacement
 * requires a new instance, so an old answer cannot mutate the replacement.
 */
export class RealtimePeer {
  constructor({ session, peerPubkey, initiator, iceServers = [], iceTransportPolicy = "relay",
    RTCPeerConnectionImpl = globalThis.RTCPeerConnection, requestId,
    timeoutMs = 15_000, maxDatagramBytes, maxBufferedBytes, maxPacketLifeTimeMs, onDatagram, onClose, signal, now = clock } = {}) {
    if (!session || !HEX64.test(peerPubkey) || peerPubkey === session.pubkey || typeof initiator !== "boolean"
      || !["all", "relay"].includes(iceTransportPolicy) || !Array.isArray(iceServers) || iceServers.length > 8
      || typeof RTCPeerConnectionImpl !== "function" || typeof onDatagram !== "function" || typeof now !== "function"
      || !bounded(timeoutMs, 1, 60_000) || requestId !== undefined && !ID.test(requestId)
      || !bounded(maxDatagramBytes ?? 16_384, 1, 65_536)
      || !bounded(maxBufferedBytes ?? 262_144, maxDatagramBytes ?? 16_384, 4_194_304)
      || maxPacketLifeTimeMs !== undefined && !bounded(maxPacketLifeTimeMs, 1, 1000)) throw new Error("Invalid real-time peer.");
    Object.assign(this, { session, peerPubkey, initiator, onDatagram, onClose, signal, now,
      maxDatagramBytes, maxBufferedBytes, maxPacketLifeTimeMs, timeoutMs });
    this.requestId = initiator ? requestId ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("") : requestId ?? null;
    this.pc = new RTCPeerConnectionImpl({ iceServers, iceTransportPolicy });
    this.closed = false; this.started = false; this.link = null; this.channel = null;
    this.pendingCandidates = []; this.earlyCandidates = []; this.localCandidates = []; this.candidates = 0; this.sentCandidates = 0;
    this.offerSeen = false; this.answerSeen = false; this.descriptionSent = false; this.operations = Promise.resolve();
    this.ready = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // Retain caller-visible rejection without an unhandled rejection when
    // abort happens before the caller has begun waiting for readiness.
    this.ready.catch(() => {});
    this.abort = () => this.close("abort");
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.close("abort");
  }

  start() {
    if (this.started || this.closed) return this.ready;
    this.started = true;
    this.timer = setTimeout(() => this.close("timeout"), this.timeoutMs);
    try { this.unlisten = this.session.onSignal((event) => this.#receive(event)); }
    catch { this.close("signal"); return this.ready; }
    this.ice = (event) => {
      if (!event.candidate || this.closed) return;
      if (++this.sentCandidates > 128) return this.close("protocol");
      const value = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
      if (utf8.encode(JSON.stringify(value)).byteLength > 4096) return this.close("protocol");
      if (this.descriptionSent) this.#signal("candidate", { candidate: value });
      else this.localCandidates.push(value);
    };
    this.datachannel = (event) => this.#channel(event.channel);
    this.connection = () => {
      if (["failed", "closed", "disconnected"].includes(this.pc.connectionState)) this.close("native");
    };
    this.pc.addEventListener("icecandidate", this.ice);
    this.pc.addEventListener("datachannel", this.datachannel);
    this.pc.addEventListener("connectionstatechange", this.connection);
    if (this.initiator) {
      try { this.#channel(this.pc.createDataChannel(REALTIME_CHANNEL, this.maxPacketLifeTimeMs === undefined
        ? { ordered: false, maxRetransmits: 0 } : { ordered: false, maxPacketLifeTime: this.maxPacketLifeTimeMs })); }
      catch { this.close("channel"); return this.ready; }
      this.#serial(async () => {
        const offer = await this.pc.createOffer(); if (this.closed) return;
        await this.pc.setLocalDescription(offer); if (this.closed) return;
        this.#description("offer");
      });
    }
    return this.ready;
  }

  #serial(operation) {
    this.operations = this.operations.then(() => { if (!this.closed) return operation(); }).catch(() => this.close("signal"));
  }

  #signal(type, payload) {
    if (this.closed) return;
    try { this.session.sendSignal(this.peerPubkey, { type, transport: REALTIME_TRANSPORT, requestId: this.requestId, payload }); }
    catch { this.close("signal"); }
  }

  #description(type) {
    const sdp = this.pc.localDescription?.sdp;
    if (typeof sdp !== "string" || utf8.encode(sdp).byteLength > 6144) return this.close("protocol");
    this.#signal(type, { sdp }); this.descriptionSent = true;
    for (const candidate of this.localCandidates.splice(0)) this.#signal("candidate", { candidate });
  }

  #receive({ from, payload: envelope } = {}) {
    if (this.closed || from !== this.peerPubkey || envelope?.transport !== REALTIME_TRANSPORT || !ID.test(envelope.requestId)) return;
    const { type, payload } = envelope;
    if (this.requestId === null) {
      // Relay replicas can deliver a candidate before the offer. Retain only
      // bounded candidates from the pinned peer until an offer selects its ID.
      if (type === "candidate") {
        if (++this.candidates > 128 || !this.#validCandidate(payload?.candidate)) return this.close("protocol");
        this.earlyCandidates.push({ requestId: envelope.requestId, candidate: payload.candidate }); return;
      }
      if (this.initiator || type !== "offer") return;
      this.requestId = envelope.requestId;
      this.pendingCandidates.push(...this.earlyCandidates.filter(value => value.requestId === this.requestId).map(value => value.candidate));
      this.earlyCandidates.length = 0;
    }
    if (envelope.requestId !== this.requestId || !payload || typeof payload !== "object") return;
    if (type === "candidate") {
      if (++this.candidates > 128 || !this.#validCandidate(payload.candidate)) return this.close("protocol");
      const candidate = payload.candidate;
      if (!this.pc.remoteDescription) this.pendingCandidates.push(candidate);
      else this.#serial(async () => { await this.pc.addIceCandidate(candidate); });
      return;
    }
    if (!["offer", "answer"].includes(type)) return;
    if (type === "offer" ? this.initiator || this.offerSeen : !this.initiator || this.answerSeen) return;
    if (typeof payload.sdp !== "string" || utf8.encode(payload.sdp).byteLength > 6144) return this.close("protocol");
    if (type === "offer") this.offerSeen = true; else this.answerSeen = true;
    this.#serial(async () => {
      await this.pc.setRemoteDescription({ type, sdp: payload.sdp }); if (this.closed) return;
      for (const candidate of this.pendingCandidates.splice(0)) { await this.pc.addIceCandidate(candidate); if (this.closed) return; }
      if (type === "offer") {
        const answer = await this.pc.createAnswer(); if (this.closed) return;
        await this.pc.setLocalDescription(answer); if (this.closed) return;
        this.#description("answer");
      }
      this.#opened();
    });
  }

  #validCandidate(candidate) {
    try { return candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && typeof candidate.candidate === "string" && utf8.encode(JSON.stringify(candidate)).byteLength <= 4096; }
    catch { return false; }
  }

  #channel(channel) {
    if (this.closed || this.channel || !realtime(channel, this.maxPacketLifeTimeMs)) {
      try { channel.close(); } catch {}
      return this.close("protocol");
    }
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    this.open = () => this.#opened(); this.channelEnded = () => this.close("channel");
    channel.addEventListener("open", this.open);
    channel.addEventListener("close", this.channelEnded);
    channel.addEventListener("error", this.channelEnded);
    this.#opened();
  }

  #opened() {
    if (this.closed || this.link || this.channel?.readyState !== "open" || !this.pc.remoteDescription) return;
    this.link = new RealtimeDatagramLink({ pc: this.pc, channel: this.channel,
      maxDatagramBytes: this.maxDatagramBytes, maxBufferedBytes: this.maxBufferedBytes, maxPacketLifeTimeMs: this.maxPacketLifeTimeMs, now: this.now,
      onDatagram: this.onDatagram, onClose: (reason) => this.close(reason) });
    clearTimeout(this.timer); this.resolve(this.link);
  }

  send(value, options) { return this.link?.send(value, options) ?? false; }
  #nativeState() {
    const value = {};
    for (const [name, allowed] of Object.entries(states)) {
      try { value[name] = allowed.has(this.pc[name]) ? this.pc[name] : 'unknown'; }
      catch { value[name] = 'unknown'; }
    }
    const channelState = this.channel?.readyState;
    value.channelState = ['connecting', 'open', 'closing', 'closed'].includes(channelState) ? channelState : 'unknown';
    value.localDescriptionSet = Boolean(this.pc.localDescription);
    value.remoteDescriptionSet = Boolean(this.pc.remoteDescription);
    return value;
  }
  snapshot() { return { closed: this.closed, ready: Boolean(this.link), ...(this.link?.snapshot() ?? {}),
    delivery: this.maxPacketLifeTimeMs === undefined ? 'zero-retransmit' : 'finite-lifetime',
    maxPacketLifeTimeMs: this.maxPacketLifeTimeMs ?? null,
    closeReason: this.closeReason ?? null, native: this.#nativeState(), nativeBeforeClose: this.nativeBeforeClose ?? null,
    localCandidates: this.sentCandidates, remoteCandidates: this.candidates,
    pendingLocalCandidates: this.localCandidates.length, pendingRemoteCandidates: this.pendingCandidates.length + this.earlyCandidates.length,
    descriptionSent: this.descriptionSent }; }

  close(reason = "host") {
    if (this.closed) return;
    this.closeReason = reasons.has(reason) ? reason : 'host';
    this.nativeBeforeClose = this.#nativeState();
    this.closed = true; clearTimeout(this.timer); this.unlisten?.();
    this.signal?.removeEventListener("abort", this.abort);
    this.pc.removeEventListener("icecandidate", this.ice);
    this.pc.removeEventListener("datachannel", this.datachannel);
    this.pc.removeEventListener("connectionstatechange", this.connection);
    this.channel?.removeEventListener("open", this.open);
    this.channel?.removeEventListener("close", this.channelEnded);
    this.channel?.removeEventListener("error", this.channelEnded);
    this.pendingCandidates.length = 0; this.earlyCandidates.length = 0; this.localCandidates.length = 0;
    this.link?.close(reason);
    try { this.channel?.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.reject(new Error("Real-time peer closed."));
    try { this.onClose?.(reasons.has(reason) ? reason : "host"); } catch {}
  }
}
