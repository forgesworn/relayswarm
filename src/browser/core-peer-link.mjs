// PeerLink backed by the Rust core's link state machine (relayswarm-core.wasm).
// The core decides the protocol; this shell owns the channel, the timer and
// the callbacks, with the same constructor, methods and fields as
// peer-link.mjs, which remains the reference implementation.

import { PeerLink } from "./peer-link.mjs";

const OP = { text: 0, binary: 1, request: 2, abort: 3, close: 4, tick: 5, serve: 6, bufferedLow: 7,
  sendHave: 8, sendHaveChange: 9, sendContribution: 10, sendFetching: 11, state: 12, sets: 13, requestRange: 14 };
const EVENT = { sendText: 1, sendBinary: 2, closed: 3, report: 4, resolved: 5, haveChanged: 6,
  scheduleChanged: 7, serveRequest: 8, uploadCancelled: 9, progress: 10, serveRange: 11 };
const HEADER = 13;
const HIGH_WATER_BYTES = 128 * 1024;
const LOW_WATER_BYTES = 32 * 1024;
const CLOSE_REASONS = new Set([
  "host", "host-stop", "admission", "rotation", "integrity", "request-timeout", "request-abort",
  "native-failed", "native-closed", "native-disconnected", "channel-close", "channel-error",
  "protocol", "send-error", "serve-error", "upload-queue", "upload-drain-timeout",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(0);

const clockNow = () => { try { return globalThis.performance.now(); } catch { return null; } };
// setTimeout treats a delay beyond 2^31 - 1 ms, or not a number, as 1 ms.
const timerMs = (value) => { const ms = Math.trunc(Math.max(1, value)); return ms >= 1 && ms <= 2 ** 31 - 1 ? ms : 1; };

export class CorePeerLink {
  /** Framing 2: this link can request and serve piece ranges. */
  get supportsRanges() { return !this.closed; }

  static ABANDON_REASON = PeerLink.ABANDON_REASON;
  #host;
  #handle;
  #version = -1;
  #timer = null;
  #deadline = null;
  // Latest time given to the core; timers advance it as their own durations
  // do in peer-link.mjs, even when the wall clock lags or steps back.
  #floor = 0;
  #busy = false;
  #transferring = false;
  #requests = new Map();
  #starting = null;
  #sendFailed = false;
  #frames = 0;

  constructor({ pubkey, pc, channel, maxSegmentBytes, onRequest, onHaveChange, onScheduleChange, onClose, onUploadCancelled, maxQueuedRequests = 4, drainTimeoutMs = 3_000 }, host) {
    this.pubkey = pubkey;
    this.pc = pc;
    this.channel = channel;
    this.maxSegmentBytes = maxSegmentBytes;
    this.onRequest = onRequest;
    this.onHaveChange = onHaveChange;
    this.onScheduleChange = onScheduleChange;
    this.onClose = onClose;
    this.onUploadCancelled = onUploadCancelled;
    this.maxQueuedRequests = maxQueuedRequests;
    this.drainTimeoutMs = drainTimeoutMs;
    this.contribution = { serving: false, rendition: null, at: 0 };
    this.fetching = new Map();
    this.renditions = new Map();
    this.have = new Set();
    this.announced = new Map();
    this.closed = false;
    this.closeReason = undefined;
    this.openedAt = Date.now();
    this.lastServedAt = 0;
    this.lastDeliveredAt = 0;
    this.outboundInFlight = 0;
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.#host = host;
    this.#floor = this.openedAt;
    this.#handle = host.newLink(maxSegmentBytes, maxQueuedRequests, drainTimeoutMs, this.#reliable(), this.openedAt);
    host.links.add(this);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = LOW_WATER_BYTES;
    channel.addEventListener("message", (event) => {
      if (this.closed) return;
      const { data } = event;
      if (typeof data === "string") this.#call(OP.text, { bytes: encoder.encode(data) });
      else this.#call(OP.binary, { bytes: data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : EMPTY });
    });
    channel.addEventListener("close", () => this.close("channel-close"));
    channel.addEventListener("error", () => this.close("channel-error"));
    channel.addEventListener("bufferedamountlow", () => {
      if (!this.closed) this.#call(OP.bufferedLow, { a: this.#buffered() });
    });
    pc.addEventListener("connectionstatechange", () => {
      const state = pc.connectionState;
      if (["failed", "closed", "disconnected"].includes(state)) this.close(`native-${state}`);
    });
  }

  get kind() { return "wasm"; }
  get busy() { return this.#busy; }
  /** Mid-transfer in either direction: never a candidate for rotation. */
  get transferring() { return this.#transferring; }
  /** When this link was last worth having, in either direction. */
  get lastUsefulAt() { return Math.max(this.lastDeliveredAt, this.lastServedAt, this.openedAt); }

  sendHave(keys) {
    if (!this.closed) this.#call(OP.sendHave, { bytes: encoder.encode(JSON.stringify([...keys])) });
  }

  sendHaveChange(add = [], del = []) {
    if (!this.closed) this.#call(OP.sendHaveChange, { bytes: encoder.encode(JSON.stringify({ add: [...add], del: [...del] })) });
  }

  sendContribution(serving, rendition) {
    if (!this.closed) this.#call(OP.sendContribution, { a: serving ? 1 : 0, bytes: encoder.encode(JSON.stringify(typeof rendition === "string" ? rendition : null)) });
  }

  sendFetching(key, leaseMs = 0) {
    if (!this.closed) this.#call(OP.sendFetching, { a: leaseMs, bytes: encoder.encode(String(key)) });
  }

  // `range` ({ start, end, objectSize }) asks a framing 2 holder for pieces
  // start..end of a schema 3 object; `expectedSize` is then those pieces' bytes.
  request(key, timeoutMs, { signal, expectedSize, onResult, onProgress, range } = {}) {
    const startedAt = clockNow();
    let reported = false;
    const report = (outcome, row = null) => {
      if (reported) return;
      reported = true;
      if (typeof onResult !== "function") return;
      try {
        let elapsedMs = null;
        if (Number.isFinite(startedAt)) { const at = clockNow(); if (Number.isFinite(at)) elapsedMs = at - startedAt; }
        const receivedBytes = row?.receivedBytes ?? 0;
        const firstByteMs = Number.isFinite(entry?.firstByteAt) && Number.isFinite(startedAt) ? entry.firstByteAt - startedAt : null;
        onResult({ outcome,
          elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
          timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : null,
          expectedBytes: Number.isSafeInteger(expectedSize) && expectedSize >= 0 ? expectedSize : null,
          receivedBytes: Number.isSafeInteger(receivedBytes) && receivedBytes >= 0 ? receivedBytes : null,
          firstByteMs: Number.isFinite(firstByteMs) && firstByteMs >= 0 ? firstByteMs : null,
          metadataReceived: row?.metadataReceived === true,
          draining: row?.draining === true,
          closeReason: CLOSE_REASONS.has(this.closeReason) ? this.closeReason : null });
      } catch {}
    };
    let entry = null;
    if (this.closed || this.#busy || signal?.aborted) {
      const result = Promise.resolve(null);
      report(this.closed ? "closed" : this.#busy ? "busy" : "abort");
      return result;
    }
    return new Promise((resolve) => {
      const cancel = () => {
        if (entry.id !== null && !this.closed) this.#call(OP.abort, { a: entry.id, b: signal?.reason === CorePeerLink.ABANDON_REASON ? 1 : 0 });
      };
      entry = { id: null, firstByteAt: null, settled: false, report, onProgress, startedAt,
        settle: (bytes) => {
          if (entry.settled) return;
          entry.settled = true;
          signal?.removeEventListener("abort", cancel);
          resolve(bytes);
        } };
      // undefined: no expected size; anything else that is not a size never matches.
      const expected = expectedSize === undefined ? NaN : Number.isSafeInteger(expectedSize) && expectedSize >= 0 ? expectedSize : -1;
      this.#starting = entry;
      try {
        if (range) this.#call(OP.requestRange, { a: timerMs(timeoutMs), b: range.objectSize, bytes: encoder.encode(JSON.stringify([String(key), range.start, range.end])) });
        else this.#call(OP.request, { a: timerMs(timeoutMs), b: expected, bytes: encoder.encode(String(key)) });
      }
      finally { this.#starting = null; }
      if (entry.id === null) {
        // The core never accepted it (the module failed): settle as closed.
        entry.settle(null);
        report("closed");
        return;
      }
      if (!entry.settled) signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  close(reason = "host") {
    if (this.closed) return;
    if (this.#handle === null) return this.#die("host");
    this.#call(OP.close, { bytes: encoder.encode(typeof reason === "string" ? reason : "host") });
  }

  /** Close without the core, as when the module has failed. */
  die() { this.#die("host"); }

  #die(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.#handle = null;
    this.#host.links.delete(this);
    this.#clearTimer();
    this.fetching.clear();
    this.renditions.clear();
    this.announced.clear();
    this.#busy = false;
    this.#transferring = false;
    for (const entry of this.#requests.values()) { entry.settle(null); entry.report("closed"); }
    this.#requests.clear();
    try { this.channel.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.onClose?.(this);
  }

  // Read before every call, as peer-link.mjs reads them when it needs them.
  #channelOpen() {
    try { return this.channel.readyState === "open"; } catch { return false; }
  }

  #reliable() {
    try { return this.channel.ordered === true && this.channel.maxRetransmits === null && this.channel.maxPacketLifeTime === null; } catch { return false; }
  }

  #now() {
    this.#floor = Math.max(this.#floor, Date.now());
    return this.#floor;
  }

  #call(op, { a = 0, b = 0, bytes = EMPTY, now = this.#now() } = {}) {
    if (this.#handle === null) return;
    const frame = this.#host.call(this.#handle, op, now, (this.#channelOpen() ? 1 : 0) | (this.#reliable() ? 2 : 0), a, b, bytes);
    if (frame) this.#process(frame);
  }

  #process(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = Array.from({ length: HEADER }, (_, index) => view.getFloat64(index * 8, true));
    const [version, closed, busy, transferring, inFlight, bytesIn, bytesOut, openedAt, lastServedAt, lastDeliveredAt, deadline, requestId, waiting] = header;
    this.closed = closed === 1;
    this.#busy = busy === 1;
    this.#transferring = transferring === 1;
    this.outboundInFlight = inFlight;
    this.bytesIn = bytesIn;
    this.bytesOut = bytesOut;
    this.openedAt = openedAt;
    this.lastServedAt = lastServedAt;
    this.lastDeliveredAt = lastDeliveredAt;
    if (!Number.isNaN(requestId) && this.#starting) {
      this.#starting.id = requestId;
      this.#requests.set(requestId, this.#starting);
    }
    if (version !== this.#version) this.#sync(version);
    if (this.closed) this.announced.clear();
    const frame = ++this.#frames;
    for (let offset = HEADER * 8; offset < bytes.byteLength;) {
      const tag = bytes[offset], length = view.getUint32(offset + 1, true);
      const payload = bytes.subarray(offset + 5, offset + 5 + length);
      offset += 5 + length;
      this.#event(tag, payload);
    }
    // A call made from a callback has already scheduled from a later frame.
    if (frame === this.#frames && this.#handle !== null) {
      this.#schedule(deadline);
      // The core counts what it sends; peer-link.mjs waits only while the
      // channel itself reports more than the high-water mark queued.
      if (waiting === 1 && this.#buffered() <= HIGH_WATER_BYTES) return this.#call(OP.bufferedLow, { a: this.#buffered() });
    }
    if (this.closed && !this.#transferring && this.#handle !== null) {
      this.#host.free(this.#handle);
      this.#handle = null;
      this.#host.links.delete(this);
      this.#clearTimer();
    }
  }

  #sync(version) {
    const sets = this.#host.sets(this.#handle);
    if (!sets) return;
    this.#version = version;
    this.have.clear();
    for (const key of sets.have) this.have.add(key);
    this.fetching.clear();
    for (const [key, expires] of sets.fetching) this.fetching.set(key, expires);
    this.renditions.clear();
    for (const [rendition, seen] of sets.renditions) this.renditions.set(rendition, seen);
    if (sets.serving !== this.contribution.serving || sets.rendition !== this.contribution.rendition || sets.at !== this.contribution.at) {
      this.contribution = { serving: sets.serving, rendition: sets.rendition, at: sets.at };
      if (sets.rendition !== null) {
        this.announced.delete(sets.rendition);
        if (this.announced.size >= 8) this.announced.delete(this.announced.keys().next().value);
        this.announced.set(sets.rendition, sets.at);
      }
    }
    if (sets.closeReason !== null) this.closeReason = sets.closeReason;
  }

  #event(tag, payload) {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    switch (tag) {
      case EVENT.sendText: {
        if (this.#sendFailed) return;
        const text = decoder.decode(payload);
        try { this.channel.send(text); } catch { this.#sendFailed = true; this.close("send-error"); }
        return;
      }
      case EVENT.sendBinary: {
        if (this.#sendFailed) return;
        try { this.channel.send(payload); } catch { this.#sendFailed = true; this.close("serve-error"); }
        return;
      }
      case EVENT.closed: {
        this.closeReason = decoder.decode(payload);
        this.#clearTimer();
        try { this.channel.close(); } catch {}
        try { this.pc.close(); } catch {}
        this.onClose?.(this);
        return;
      }
      case EVENT.report: {
        const row = JSON.parse(decoder.decode(payload));
        const entry = row.id === null ? this.#starting : this.#requests.get(row.id);
        if (!entry) return;
        entry.report(row.outcome, row);
        if (entry.settled && row.id !== null) this.#requests.delete(row.id);
        return;
      }
      case EVENT.resolved: {
        const id = view.getFloat64(0, true), has = payload[8] === 1;
        const entry = Number.isNaN(id) ? this.#starting : this.#requests.get(id);
        if (!entry) return;
        entry.settle(has ? payload.slice(9) : null);
        return;
      }
      case EVENT.haveChanged: {
        const added = JSON.parse(decoder.decode(payload));
        this.onHaveChange?.(this, added);
        return;
      }
      case EVENT.scheduleChanged: {
        this.onScheduleChange?.(this);
        return;
      }
      case EVENT.serveRequest:
      case EVENT.serveRange: {
        let key, range;
        if (tag === EVENT.serveRange) { const [rangeKey, start, end] = JSON.parse(decoder.decode(payload)); key = rangeKey; range = { start, end }; }
        else key = decoder.decode(payload);
        Promise.resolve()
          .then(() => this.closed ? null : range ? this.onRequest?.(this, key, range) : this.onRequest?.(this, key))
          .then((bytes) => this.#serve(bytes), () => { this.close("serve-error"); this.#serve(null); });
        return;
      }
      case EVENT.uploadCancelled: {
        this.onUploadCancelled?.(this, view.getFloat64(0, true));
        return;
      }
      case EVENT.progress: {
        const received = view.getFloat64(0, true), size = view.getFloat64(8, true);
        for (const entry of this.#requests.values()) {
          if (entry.settled) continue;
          if (entry.firstByteAt === null) entry.firstByteAt = clockNow();
          if (typeof entry.onProgress === "function") {
            try { entry.onProgress(received, size, Number.isFinite(entry.startedAt) ? entry.firstByteAt - entry.startedAt : null); } catch {}
          }
        }
        return;
      }
      default:
        throw new Error(`Unknown core link event ${tag}.`);
    }
  }

  #buffered() {
    try { return Math.max(0, Number(this.channel.bufferedAmount) || 0); } catch { return 0; }
  }

  #serve(bytes) {
    if (this.#handle === null) return;
    const buffered = this.#buffered();
    const view = !bytes ? null : bytes instanceof Uint8Array ? bytes : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null;
    if (bytes && !view) { this.close("serve-error"); return this.#call(OP.serve, { a: 0, b: buffered }); }
    this.#call(OP.serve, { a: view ? 1 : 0, b: buffered, bytes: view ?? EMPTY });
  }

  #schedule(deadline) {
    if (Number.isNaN(deadline)) return this.#clearTimer();
    if (this.#timer !== null && this.#deadline === deadline) return;
    this.#clearTimer();
    this.#deadline = deadline;
    this.#timer = globalThis.setTimeout(() => {
      this.#timer = null;
      this.#deadline = null;
      // The timer ran its whole duration: the core's clock reaches its deadline.
      this.#floor = Math.max(this.#floor, deadline);
      this.#call(OP.tick);
    }, Math.max(0, deadline - this.#now()));
  }

  #clearTimer() {
    if (this.#timer !== null) globalThis.clearTimeout(this.#timer);
    this.#timer = null;
    this.#deadline = null;
  }
}
