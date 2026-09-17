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

export class PeerLink {
  constructor({ pubkey, pc, channel, maxSegmentBytes, onRequest, onHaveChange, onClose }) {
    this.pubkey = pubkey;
    this.pc = pc;
    this.channel = channel;
    this.maxSegmentBytes = maxSegmentBytes;
    this.onRequest = onRequest;
    this.onHaveChange = onHaveChange;
    this.onClose = onClose;
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
      try { this.#onMessage(event.data); } catch { this.close(); }
    });
    channel.addEventListener("close", () => this.close());
    channel.addEventListener("error", () => this.close());
    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.close();
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

  // Resolves with the bytes, or null when the peer does not serve them in time.
  request(key, timeoutMs) {
    if (this.closed || this.pending) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = this.nextId++;
      const finish = (bytes) => {
        if (this.pending?.id !== id) return;
        clearTimeout(this.pending.timer);
        this.pending = null;
        if (bytes) this.lastDeliveredAt = Date.now();
        resolve(bytes);
      };
      this.pending = { id, key, size: -1, parts: [], received: 0, finish, timer: setTimeout(() => finish(null), Math.max(1, timeoutMs)) };
      if (!this.#sendText({ t: "want", id, k: key })) finish(null);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
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
      this.close();
      return false;
    }
  }

  #onMessage(data) {
    if (typeof data !== "string") {
      const pending = this.pending;
      if (!pending || pending.size < 0) return;
      const chunk = new Uint8Array(data);
      pending.received += chunk.byteLength;
      this.bytesIn += chunk.byteLength;
      if (pending.received > pending.size) return pending.finish(null);
      pending.parts.push(chunk);
      return;
    }
    if (data.length > 64 * 1024) return;
    const message = JSON.parse(data);
    if (!message || typeof message !== "object") return;
    switch (message.t) {
      case "have": return this.#onHave(message);
      case "want": return this.#onWant(message);
      case "meta": {
        const pending = this.pending;
        if (!pending || message.id !== pending.id) return;
        if (!Number.isSafeInteger(message.size) || message.size < 1 || message.size > this.maxSegmentBytes) return pending.finish(null);
        pending.size = message.size;
        return;
      }
      case "eof": {
        const pending = this.pending;
        if (!pending || message.id !== pending.id) return;
        if (pending.received !== pending.size) return pending.finish(null);
        const bytes = new Uint8Array(pending.size);
        let offset = 0;
        for (const part of pending.parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        return pending.finish(bytes);
      }
      case "none":
        if (this.pending && message.id === this.pending.id) this.pending.finish(null);
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
    this.outboundInFlight += 1;
    this.serving = this.serving
      .then(() => this.#serve(message.id, message.k))
      .catch(() => this.close())
      .finally(() => { this.outboundInFlight = Math.max(0, this.outboundInFlight - 1); });
  }

  async #serve(id, key) {
    const bytes = this.closed ? null : this.onRequest?.(this, key);
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
    return new Promise((resolve) => {
      const done = () => {
        this.channel.removeEventListener("bufferedamountlow", done);
        this.channel.removeEventListener("close", done);
        resolve();
      };
      this.channel.addEventListener("bufferedamountlow", done);
      this.channel.addEventListener("close", done);
    });
  }
}
