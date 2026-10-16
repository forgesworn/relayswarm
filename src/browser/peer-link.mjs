// One data channel between two viewers, and the small protocol on it.
//
// Text frames are JSON control messages; binary frames are segment chunks.
// Responses on a link are serialised, so the chunks between a `meta` and its
// `eof` always belong to that one response.
//
//   {"t":"have","keys":[hash...]}        full set of held segment keys
//   {"t":"have","add":[hash],"del":[]}   incremental change
//   {"t":"want","id":n,"k":hash}          request one segment
//   {"t":"meta","id":n,"size":bytes}      response header, chunks follow
//   {"t":"eof","id":n}                    response complete
//   {"t":"none","id":n}                   not held, or not serving now
//
// Integrity is not decided here: the caller hashes what arrives.

const HEX64 = /^[0-9a-f]{64}$/u;
const CHUNK_BYTES = 16 * 1024;
const HIGH_WATER_BYTES = 1024 * 1024;
const LOW_WATER_BYTES = 256 * 1024;
const MAX_HAVE_KEYS = 256;
const CLOSE_REASONS = new Set([
  "host", "host-stop", "admission", "rotation", "integrity", "request-timeout", "request-abort",
  "native-failed", "native-closed", "native-disconnected", "channel-close", "channel-error",
  "protocol", "send-error", "serve-error", "upload-queue", "upload-drain-timeout",
]);

export class PeerLink {
  #uploadDrainTimedOut = false;
  constructor({ pubkey, pc, channel, maxSegmentBytes, onRequest, onHaveChange, onScheduleChange, onClose, maxQueuedRequests = 4, drainTimeoutMs = 3_000 }) {
    this.pubkey = pubkey;
    this.pc = pc;
    this.channel = channel;
    this.maxSegmentBytes = maxSegmentBytes;
    this.onRequest = onRequest;
    this.onHaveChange = onHaveChange;
    this.onScheduleChange = onScheduleChange;
    this.contribution = { serving: false, rendition: null, at: 0 };
    this.fetching = new Map();
    this.renditions = new Map();
    this.onClose = onClose;
    this.maxQueuedRequests = maxQueuedRequests;
    this.drainTimeoutMs = drainTimeoutMs;
    this.maxChunks = Math.max(1, Math.ceil(maxSegmentBytes / CHUNK_BYTES) * 4);
    this.have = new Set();
    this.pending = null;
    this.nextId = 1;
    this.serving = Promise.resolve();
    this.closed = false;
    this.openedAt = Date.now();
    this.lastServedAt = 0;
    // When this peer last gave us bytes we asked for. With lastServedAt it is
    // what rotation reads: a link that has been useful in neither direction
    // recently is the one to drop when somebody new needs a slot.
    this.lastDeliveredAt = 0;
    this.outboundInFlight = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    channel.addEventListener("message", (event) => {
      try { this.#onMessage(event.data); } catch { this.close("protocol"); }
    });
    channel.addEventListener("close", () => this.close("channel-close"));
    channel.addEventListener("error", () => this.close("channel-error"));
    pc.addEventListener("connectionstatechange", () => {
      const state = pc.connectionState;
      if (["failed", "closed", "disconnected"].includes(state)) this.close(`native-${state}`);
    });
  }

  get busy() {
    return this.pending !== null;
  }

  /** Mid-transfer in either direction: never a candidate for rotation. */
  get transferring() {
    return this.pending !== null || this.outboundInFlight > 0;
  }

  /** When this link was last worth having, in either direction. */
  get lastUsefulAt() {
    return Math.max(this.lastDeliveredAt, this.lastServedAt, this.openedAt);
  }

  sendHave(keys) {
    this.#sendText({ t: "have", keys: keys.slice(-MAX_HAVE_KEYS) });
  }

  sendHaveChange(add = [], del = []) {
    if (add.length || del.length) this.#sendText({ t: "have", add, del });
  }

  // Advisory coordination only; commitments still authenticate every payload.
  sendContribution(serving, rendition) {
    this.#sendText({ t: "contribution", serving, rendition });
  }

  sendFetching(key, leaseMs = 0) {
    this.#sendText({ t: "fetching", k: key, ms: leaseMs });
  }

  // Resolves with the bytes, or null when the peer does not serve them in time.
  request(key, timeoutMs, { signal, expectedSize } = {}) {
    if (this.closed || this.pending || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      const settle = (bytes) => {
        clearTimeout(this.pending.timer);
        signal?.removeEventListener("abort", cancel);
        resolve(bytes);
      };
      const finish = (bytes) => {
        if (this.pending?.id !== id) return;
        const drained = this.pending.draining;
        settle(bytes);
        this.pending = null;
        if (bytes) this.lastDeliveredAt = Date.now();
        if (drained && !this.closed) this.onScheduleChange?.(this);
      };
      const abandon = (reason) => {
        const pending = this.pending;
        if (!pending || pending.id !== id || pending.draining) return;
        // Untagged binary chunks may only be discarded up to a definitive
        // response boundary on a known ordered, fully reliable channel.
        let reliable = false;
        try {
          reliable = this.channel.ordered === true && this.channel.maxRetransmits === null &&
            this.channel.maxPacketLifeTime === null && this.channel.readyState === "open";
        } catch {}
        if (!reliable) { finish(null); this.close(reason); return; }
        pending.draining = true;
        pending.parts.length = 0;
        settle(null);
        pending.timer = setTimeout(() => {
          if (this.pending === pending && pending.draining) this.close(reason);
        }, this.drainTimeoutMs);
      };
      const cancel = () => abandon("request-abort");
      const timeout = () => abandon("request-timeout");
      this.pending = { id, key, expectedSize, size: -1, parts: [], chunks: 0, received: 0, draining: false, finish, timer: setTimeout(timeout, Math.max(1, timeoutMs)) };
      signal?.addEventListener("abort", cancel, { once: true });
      if (!this.#sendText({ t: "want", id, k: key })) finish(null);
    });
  }

  close(reason = "host") {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = CLOSE_REASONS.has(reason) ? reason : "host";
    this.fetching.clear();
    this.renditions.clear();
    this.pending?.finish(null);
    try { this.channel.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.onClose?.(this);
  }

  #sendText(message) {
    if (this.closed || this.channel.readyState !== "open") return false;
    try {
      this.channel.send(JSON.stringify(message));
      return true;
    } catch {
      this.close("send-error");
      return false;
    }
  }

  #onMessage(data) {
    if (this.closed) return;
    if (typeof data !== "string") {
      const pending = this.pending;
      if (!pending) return;
      if (pending.size < 0) return this.close("protocol");
      const chunk = new Uint8Array(data);
      if (!chunk.byteLength || chunk.byteLength > CHUNK_BYTES || pending.chunks >= this.maxChunks) return this.close("protocol");
      pending.chunks += 1;
      pending.received += chunk.byteLength;
      this.bytesIn += chunk.byteLength;
      if (pending.received > pending.size) return this.close("protocol");
      if (!pending.draining) pending.parts.push(chunk);
      return;
    }
    if (data.length > 64 * 1024) return this.close("protocol");
    const message = JSON.parse(data);
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "contribution": {
        if (typeof message.serving !== "boolean" || (message.rendition !== null && (typeof message.rendition !== "string" || message.rendition.length > 2048))) return;
        this.contribution = { serving: message.serving, rendition: message.rendition, at: Date.now() };
        if (!message.serving) { this.fetching.clear(); this.renditions.clear(); }
        else if (message.rendition !== null) {
          for (const [rendition, seen] of this.renditions) if (seen < Date.now() - 30_000) this.renditions.delete(rendition);
          if (this.renditions.has(message.rendition) || this.renditions.size < 8) this.renditions.set(message.rendition, Date.now());
        }
        this.onScheduleChange?.(this);
        return;
      }
      case "fetching": {
        if (typeof message.k !== "string" || !HEX64.test(message.k) || !Number.isSafeInteger(message.ms) || message.ms < 0 || message.ms > 2000) return;
        for (const [key, expires] of this.fetching) if (expires <= Date.now()) this.fetching.delete(key);
        if (message.ms === 0) this.fetching.delete(message.k);
        else if (this.contribution.serving && (this.fetching.has(message.k) || this.fetching.size < 24)) this.fetching.set(message.k, Date.now() + message.ms);
        this.onScheduleChange?.(this);
        return;
      }
      case "have": return this.#onHave(message);
      case "want": return this.#onWant(message);
      case "meta": {
        const pending = this.pending;
        if (!pending) return;
        if (message.id !== pending.id) return pending.draining ? this.close("protocol") : undefined;
        if (pending.size !== -1) return this.close("protocol");
        if (pending.expectedSize !== undefined && message.size !== pending.expectedSize) return this.close("protocol");
        if (!Number.isSafeInteger(message.size) || message.size < 1 || message.size > this.maxSegmentBytes) return this.close("protocol");
        pending.size = message.size;
        return;
      }
      case "eof": {
        const pending = this.pending;
        if (!pending) return;
        if (message.id !== pending.id) return pending.draining ? this.close("protocol") : undefined;
        if (pending.received !== pending.size) return this.close("protocol");
        if (pending.draining) return pending.finish(null);
        const bytes = new Uint8Array(pending.size);
        let offset = 0;
        for (const part of pending.parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        return pending.finish(bytes);
      }
      case "none":
        if (this.pending) {
          if (message.id !== this.pending.id) return this.pending.draining ? this.close("protocol") : undefined;
          if (this.pending.size !== -1) return this.close("protocol");
          this.pending.finish(null);
        }
        return;
      default:
        return;
    }
  }

  #onHave(message) {
    const valid = (list) => Array.isArray(list) ? list.filter((key) => typeof key === "string" && HEX64.test(key)).slice(0, MAX_HAVE_KEYS) : [];
    const added = [];
    if (Array.isArray(message.keys)) {
      this.have.clear();
      for (const key of valid(message.keys)) this.have.add(key);
      added.push(...this.have);
    }
    for (const key of valid(message.add)) {
      if (this.have.size >= MAX_HAVE_KEYS) break;
      this.have.add(key);
      added.push(key);
    }
    for (const key of valid(message.del)) this.have.delete(key);
    if (added.length) this.onHaveChange?.(this, added);
  }

  #onWant(message) {
    if (!Number.isSafeInteger(message.id) || typeof message.k !== "string" || !HEX64.test(message.k)) return;
    if (this.outboundInFlight >= this.maxQueuedRequests) return this.close("upload-queue");
    this.outboundInFlight += 1;
    this.serving = this.serving
      .then(() => this.#serve(message.id, message.k))
      .catch(() => this.close(this.#uploadDrainTimedOut ? "upload-drain-timeout" : "serve-error"))
      .finally(() => { this.outboundInFlight = Math.max(0, this.outboundInFlight - 1); });
  }

  async #serve(id, key) {
    const bytes = this.closed ? null : await this.onRequest?.(this, key);
    if (!bytes) return void this.#sendText({ t: "none", id });
    if (!this.#sendText({ t: "meta", id, size: bytes.byteLength })) return;
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      if (this.closed) return;
      if (this.channel.bufferedAmount > HIGH_WATER_BYTES) await this.#drained();
      if (this.closed) return;
      this.channel.send(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)));
    }
    this.bytesOut += bytes.byteLength;
    this.lastServedAt = Date.now();
    this.#sendText({ t: "eof", id });
  }

  #drained() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.#uploadDrainTimedOut = true;
        reject(new Error("Peer upload stalled."));
      }, this.drainTimeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.channel.removeEventListener("bufferedamountlow", done);
        this.channel.removeEventListener("close", done);
      };
      const done = () => {
        cleanup();
        resolve();
      };
      this.channel.addEventListener("bufferedamountlow", done);
      this.channel.addEventListener("close", done);
    });
  }
}
