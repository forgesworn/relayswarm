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
//   {"t":"cancel","id":n}                 receiver no longer wants response n
//
// A holder that honours `cancel` answers with `none` before `meta`, or stops
// sending chunks and sends `eof` early. Peers without it ignore the message
// and send the response in full.
//
// Integrity is not decided here: the caller hashes what arrives.

const HEX64 = /^[0-9a-f]{64}$/u;
// Abort reason a caller gives when it abandons a request it projects to be
// late; recorded as "abandoned" rather than an ordinary abort. Exposed as
// PeerLink.ABANDON_REASON; the module keeps its single PeerLink export.
const ABANDON_REASON = "relayswarm-abandon";
const CHUNK_BYTES = 16 * 1024;
// A response is handed to the channel only while little is queued, so a
// cancel can stop most of the rest; bytes already queued cannot be recalled.
const HIGH_WATER_BYTES = 128 * 1024;
const LOW_WATER_BYTES = 32 * 1024;
const MAX_HAVE_KEYS = 256;
const CLOSE_REASONS = new Set([
  "host", "host-stop", "admission", "rotation", "integrity", "request-timeout", "request-abort",
  "native-failed", "native-closed", "native-disconnected", "channel-close", "channel-error",
  "protocol", "send-error", "serve-error", "upload-queue", "upload-drain-timeout",
]);

export class PeerLink {
  static ABANDON_REASON = ABANDON_REASON;
  #uploadDrainTimedOut = false;
  constructor({ pubkey, pc, channel, maxSegmentBytes, onRequest, onHaveChange, onScheduleChange, onClose, onUploadCancelled, maxQueuedRequests = 4, drainTimeoutMs = 3_000 }) {
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
    this.onUploadCancelled = onUploadCancelled;
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
    // Responses queued or being sent, at most maxQueuedRequests.
    this.uploads = new Set();
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
  // Optional diagnostics describe that logical result once, before any late drain.
  // onProgress(received, size, firstByteMs) runs after each accepted chunk.
  request(key, timeoutMs, { signal, expectedSize, onResult, onProgress } = {}) {
    let startedAt = null;
    try { startedAt = performance.now(); } catch {}
    let reported = false;
    const report = (outcome, pending = null) => {
      if (reported) return;
      reported = true;
      if (typeof onResult !== "function") return;
      try {
        let elapsedMs = null;
        if (Number.isFinite(startedAt)) { try { elapsedMs = performance.now() - startedAt; } catch {} }
        const receivedBytes = pending?.received ?? 0;
        const firstByteMs = Number.isFinite(pending?.firstByteAt) && Number.isFinite(startedAt) ? pending.firstByteAt - startedAt : null;
        onResult({ outcome,
          elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
          timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : null,
          expectedBytes: Number.isSafeInteger(expectedSize) && expectedSize >= 0 ? expectedSize : null,
          receivedBytes: Number.isSafeInteger(receivedBytes) && receivedBytes >= 0 ? receivedBytes : null,
          firstByteMs: Number.isFinite(firstByteMs) && firstByteMs >= 0 ? firstByteMs : null,
          metadataReceived: pending ? pending.size >= 0 : false,
          draining: pending?.draining === true,
          closeReason: CLOSE_REASONS.has(this.closeReason) ? this.closeReason : null });
      } catch {}
    };
    if (this.closed || this.pending || signal?.aborted) {
      const result = Promise.resolve(null);
      report(this.closed ? "closed" : this.pending ? "busy" : "abort");
      return result;
    }
    return new Promise((resolve) => {
      const id = this.nextId++;
      const settle = (bytes) => {
        clearTimeout(this.pending.timer);
        signal?.removeEventListener("abort", cancel);
        resolve(bytes);
      };
      const finish = (bytes, outcome = bytes ? "payload" : "none", reportNow = true) => {
        if (this.pending?.id !== id) return;
        const pending = this.pending, drained = pending.draining;
        settle(bytes);
        this.pending = null;
        if (bytes) this.lastDeliveredAt = Date.now();
        if (drained && !this.closed) this.onScheduleChange?.(this);
        if (reportNow) report(outcome, pending);
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
        const outcome = reason !== "request-abort" ? "timeout" : signal?.reason === ABANDON_REASON ? "abandoned" : "abort";
        if (!reliable) {
          finish(null, outcome, false);
          try { this.close(reason); } finally { report(outcome, pending); }
          return;
        }
        pending.draining = true;
        pending.parts.length = 0;
        settle(null);
        pending.timer = setTimeout(() => {
          if (this.pending === pending && pending.draining) this.close(reason);
        }, this.drainTimeoutMs);
        report(outcome, pending);
        // Ask the holder to stop. Only after this may its eof end early.
        pending.cancelled = this.#sendText({ t: "cancel", id });
      };
      const cancel = () => abandon("request-abort");
      const timeout = () => abandon("request-timeout");
      const progress = typeof onProgress === "function" ? (pending) => {
        try { onProgress(pending.received, pending.size, Number.isFinite(startedAt) ? pending.firstByteAt - startedAt : null); } catch {}
      } : null;
      this.pending = { id, key, expectedSize, size: -1, parts: [], chunks: 0, received: 0, firstByteAt: null, progress, draining: false, cancelled: false, finish, timer: setTimeout(timeout, Math.max(1, timeoutMs)) };
      signal?.addEventListener("abort", cancel, { once: true });
      if (!this.#sendText({ t: "want", id, k: key })) finish(null, "send-error");
    });
  }

  close(reason = "host") {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = CLOSE_REASONS.has(reason) ? reason : "host";
    this.fetching.clear();
    this.renditions.clear();
    this.pending?.finish(null, this.closeReason === "send-error" ? "send-error" : "closed");
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
      if (pending.draining) return;
      if (pending.firstByteAt === null) { try { pending.firstByteAt = performance.now(); } catch {} }
      pending.parts.push(chunk);
      // May abandon this request; a draining request discards later chunks.
      pending.progress?.(pending);
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
      case "cancel": {
        if (!Number.isSafeInteger(message.id)) return;
        for (const upload of this.uploads) if (upload.id === message.id) upload.cancelled = true;
        return;
      }
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
        if (pending.cancelled && pending.size >= 0) return pending.finish(null);
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
    const upload = { id: message.id, cancelled: false };
    this.uploads.add(upload);
    this.serving = this.serving
      .then(() => this.#serve(upload, message.k))
      .catch(() => this.close(this.#uploadDrainTimedOut ? "upload-drain-timeout" : "serve-error"))
      .finally(() => {
        this.uploads.delete(upload);
        this.outboundInFlight = Math.max(0, this.outboundInFlight - 1);
      });
  }

  async #serve(upload, key) {
    const { id } = upload;
    if (upload.cancelled) {
      this.onUploadCancelled?.(this, 0);
      return void this.#sendText({ t: "none", id });
    }
    const bytes = this.closed ? null : await this.onRequest?.(this, key);
    if (!bytes) return void this.#sendText({ t: "none", id });
    // Upload already charged for a cancelled response is not refunded.
    if (upload.cancelled) {
      this.onUploadCancelled?.(this, bytes.byteLength);
      return void this.#sendText({ t: "none", id });
    }
    if (!this.#sendText({ t: "meta", id, size: bytes.byteLength })) return;
    let sent = 0;
    while (sent < bytes.byteLength) {
      if (this.closed) return;
      if (this.channel.bufferedAmount > HIGH_WATER_BYTES) await this.#drained();
      if (this.closed) return;
      if (upload.cancelled) break;
      const end = Math.min(sent + CHUNK_BYTES, bytes.byteLength);
      this.channel.send(bytes.subarray(sent, end));
      sent = end;
    }
    this.bytesOut += sent;
    this.lastServedAt = Date.now();
    if (sent < bytes.byteLength) this.onUploadCancelled?.(this, bytes.byteLength - sent);
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
