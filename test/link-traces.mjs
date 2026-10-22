// Drive the real PeerLink with a fake data channel and clock, and record what
// it does at each step. Shared by scripts/generate-proto-vectors.mjs and
// test/proto-vectors.test.mjs; the Rust link tests replay the same steps.

import { createHash } from "node:crypto";
import { PeerLink } from "../src/browser/peer-link.mjs";

export const TRACE_EPOCH_MS = 1_792_000_000_000;

/** Deterministic payload bytes: byte i is (seed + 31i) mod 256. */
export function traceBytes(length, seed) {
  return Uint8Array.from({ length }, (_, index) => (seed + index * 31) & 255);
}
const fingerprint = (bytes) => ({ len: bytes.byteLength, sha: createHash("sha256").update(bytes).digest("hex").slice(0, 16) });

class FakeClock {
  now = TRACE_EPOCH_MS;
  timers = [];
  sequence = 0;
  setTimeout = (callback, ms) => {
    const timer = { at: this.now + Math.max(0, Number(ms) || 0), sequence: this.sequence++, callback };
    this.timers.push(timer);
    return timer;
  };
  clearTimeout = (timer) => { this.timers = this.timers.filter((entry) => entry !== timer); };
  next(limit) {
    const due = this.timers.filter((timer) => timer.at <= limit).sort((a, b) => a.at - b.at || a.sequence - b.sequence)[0];
    if (due) this.timers = this.timers.filter((timer) => timer !== due);
    return due;
  }
}

class FakeChannel {
  readyState = "open";
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  bufferedAmount = 0;
  listeners = new Map();
  constructor(log, reliable) {
    this.log = log;
    if (!reliable) this.maxRetransmits = 0;
  }
  addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(handler); }
  removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); }
  dispatch(type, event = {}) { for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event); }
  send(data) {
    if (typeof data === "string") this.log.push({ sendText: data });
    else { this.bufferedAmount += data.byteLength; this.log.push({ sendBinary: fingerprint(data) }); }
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    queueMicrotask(() => this.dispatch("close"));
  }
}

const flush = async () => { for (let index = 0; index < 20; index++) await new Promise((resolve) => setImmediate(resolve)); };

/** Run one trace and return the per-step logs and state snapshots. */
export async function runLinkTrace(trace, create = (options) => new PeerLink(options)) {
  const clock = new FakeClock();
  const saved = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, now: Date.now };
  const log = [], resolutions = [], serveQueue = [];
  const channel = new FakeChannel(log, trace.config.reliable !== false);
  const pc = { addEventListener() {}, close() {} };
  let controller = null;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  Date.now = () => clock.now;
  try {
    const link = create({ pubkey: "f".repeat(64), pc, channel, maxSegmentBytes: trace.config.maxSegmentBytes,
      maxQueuedRequests: trace.config.maxQueuedRequests, drainTimeoutMs: trace.config.drainTimeoutMs,
      onRequest: (_link, key) => new Promise((resolve) => { log.push({ serveRequest: key }); serveQueue.push(resolve); }),
      onHaveChange: (_link, added) => log.push({ haveChanged: [...added] }),
      onScheduleChange: () => log.push({ scheduleChanged: true }),
      onClose: (closed) => log.push({ closed: closed.closeReason }),
      onUploadCancelled: (_link, bytes) => log.push({ uploadCancelled: bytes }) });
    const steps = [];
    for (const step of trace.steps) {
      const input = step.in;
      if ("text" in input) channel.dispatch("message", { data: input.text });
      else if ("binary" in input) channel.dispatch("message", { data: traceBytes(input.binary.len, input.binary.seed).buffer });
      else if ("request" in input) {
        controller = new AbortController();
        const { key, timeoutMs, expectedSize } = input.request;
        link.request(key, timeoutMs, { signal: controller.signal, expectedSize,
          onResult: (result) => log.push({ result: { outcome: result.outcome, receivedBytes: result.receivedBytes,
            metadataReceived: result.metadataReceived, draining: result.draining, closeReason: result.closeReason } }),
          onProgress: (received, size) => log.push({ progress: [received, size] }) })
          .then((bytes) => resolutions.push({ resolved: bytes ? fingerprint(bytes) : null }));
      } else if ("abort" in input) controller?.abort(input.abort === "abandon" ? PeerLink.ABANDON_REASON : undefined);
      else if ("advance" in input) {
        const target = clock.now + input.advance;
        for (let timer = clock.next(target); timer; timer = clock.next(target)) {
          clock.now = timer.at;
          timer.callback();
          await flush();
        }
        clock.now = target;
      } else if ("serve" in input) {
        const resolve = serveQueue.shift();
        if (!resolve) throw new Error(`Trace ${trace.name} serves with no outstanding request.`);
        resolve(input.serve === null ? null : traceBytes(input.serve.len, input.serve.seed));
      } else if ("drain" in input) { channel.bufferedAmount = 0; channel.dispatch("bufferedamountlow"); }
      else if ("close" in input) link.close(input.close);
      else if ("sendHave" in input) link.sendHave(input.sendHave);
      else if ("sendHaveChange" in input) link.sendHaveChange(input.sendHaveChange.add, input.sendHaveChange.del);
      else if ("sendContribution" in input) link.sendContribution(input.sendContribution.serving, input.sendContribution.rendition);
      else if ("sendFetching" in input) link.sendFetching(input.sendFetching.k, input.sendFetching.ms);
      else throw new Error(`Unknown trace input ${JSON.stringify(input)}.`);
      await flush();
      const events = [...log.splice(0), ...resolutions.splice(0)];
      steps.push({ events, state: {
        have: [...link.have], fetching: [...link.fetching], renditions: [...link.renditions],
        serving: link.contribution.serving, rendition: link.contribution.rendition,
        busy: link.busy, outboundInFlight: link.outboundInFlight, closed: link.closed,
        bytesIn: link.bytesIn, bytesOut: link.bytesOut } });
    }
    return steps;
  } finally {
    globalThis.setTimeout = saved.setTimeout;
    globalThis.clearTimeout = saved.clearTimeout;
    Date.now = saved.now;
  }
}
