// PeerLink backed by the Rust core against peer-link.mjs, for what the
// committed link traces cannot show: channels that drain silently, refuse
// sends or are closing, callbacks that call back in, and the timing fields
// reported to the caller. Every scenario runs on both and must agree.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { loadCore } from "../src/browser/core-wasm.mjs";
import { runLinkTrace } from "./link-traces.mjs";
import { stubCore } from "./core-stub.mjs";
import { commitmentPieceSize } from "../src/browser/segment-commitment.mjs";

const path = process.env.RELAYSWARM_CORE_WASM
  ? resolve(process.env.RELAYSWARM_CORE_WASM) : new URL("../src/browser/relayswarm-core.wasm", import.meta.url);
const compiled = await WebAssembly.compile(await readFile(path));
const traces = JSON.parse(await readFile(new URL("../core/vectors/link-traces.json", import.meta.url), "utf8"));

const KEY = "a".repeat(64);
class Channel extends EventTarget {
  readyState = "open";
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  bufferedAmount = 0;
  sent = [];
  failText = false;
  failBinary = false;
  send(data) {
    if (typeof data === "string") {
      if (this.failText) throw new Error("text refused");
      this.sent.push(JSON.parse(data));
    } else {
      if (this.failBinary) throw new Error("binary refused");
      this.bufferedAmount += data.byteLength;
      this.sent.push({ bytes: data.byteLength });
    }
  }
  receive(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  control(t, extra = {}) { this.receive(JSON.stringify({ t, ...extra })); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
class PC extends EventTarget { close() { this.closed = true; } }
const tick = async () => { for (let index = 0; index < 10; index++) await new Promise((done) => setImmediate(done)); };

const kinds = {
  js: async () => ({ create: (options) => new PeerLink(options), failures: [] }),
  wasm: async () => {
    const failures = [];
    const core = await loadCore(compiled, { onFailure: (error) => failures.push(error) });
    return { create: (options) => core.peerLink(options), failures };
  },
};

/** Run `scenario` on both implementations and return both logs. */
async function both(scenario) {
  const logs = {};
  for (const [kind, make] of Object.entries(kinds)) {
    const { create, failures } = await make();
    const channel = new Channel(), pc = new PC(), log = [];
    const link = create({ pubkey: "peer", channel, pc, maxSegmentBytes: 1 << 20,
      onRequest: (_link, key) => { log.push({ serve: key.slice(0, 4) }); return scenario.serve?.(key) ?? null; },
      onClose: (closed) => log.push({ closed: closed.closeReason }),
      onUploadCancelled: (_link, bytes) => log.push({ uploadCancelled: bytes }) });
    await scenario.run({ link, channel, log });
    await tick();
    assert.deepEqual(failures, [], `${kind}: the core failed`);
    logs[kind] = structuredClone({ log, sent: channel.sent, closed: link.closed, busy: link.busy, inFlight: link.outboundInFlight, bytesOut: link.bytesOut });
    link.close();
  }
  for (const field of scenario.differs ?? []) { delete logs.wasm[field]; delete logs.js[field]; }
  assert.deepEqual(logs.wasm, logs.js);
  return logs.js;
}

test("every committed link trace matches through the core", async () => {
  for (const trace of traces.traces) {
    const core = await loadCore(compiled, { onFailure: (error) => assert.fail(`${trace.name}: ${error}`) });
    assert.deepEqual(await runLinkTrace(trace, (options) => core.peerLink(options)), trace.expected, trace.name);
  }
});

test("many small responses on a channel that drains without bufferedamountlow keep flowing", async () => {
  const outcome = await both({
    serve: () => new Uint8Array(20_000),
    async run({ channel }) {
      for (let id = 1; id <= 12; id++) {
        channel.control("want", { id, k: KEY });
        await tick();
        // Sent and drained below the low-water mark: no event fires.
        channel.bufferedAmount = 0;
      }
    },
  });
  assert.equal(outcome.closed, false);
  assert.equal(outcome.sent.filter((message) => message.t === "eof").length, 12);
  assert.equal(outcome.bytesOut, 240_000);
});

test("an onProgress that abandons on the first chunk drains to an early eof", async () => {
  const outcome = await both({
    async run({ link, channel, log }) {
      const controller = new AbortController();
      const result = link.request(KEY, 5000, { signal: controller.signal, expectedSize: 40_000,
        onProgress: (received) => { log.push({ progress: received }); controller.abort(PeerLink.ABANDON_REASON); },
        onResult: (row) => log.push({ outcome: row.outcome, received: row.receivedBytes, draining: row.draining }) });
      channel.control("meta", { id: 1, size: 40_000 });
      channel.receive(new Uint8Array(16_384).buffer);
      log.push({ resolved: await result });
      channel.receive(new Uint8Array(16_384).buffer);
      channel.control("eof", { id: 1 });
      log.push({ busyAfterEof: link.busy });
    },
  });
  assert.deepEqual(outcome.sent.map((message) => message.t), ["want", "cancel"]);
  assert.ok(outcome.log.some((entry) => entry.outcome === "abandoned" && entry.draining === true));
  assert.ok(outcome.log.some((entry) => entry.busyAfterEof === false));
});

test("a cancelled six MiB ranged upload ends behind queued bytes and reuses the reliable core link", async t => {
  const core = await loadCore(compiled), source = new Uint8Array(6 * 1024 * 1024).fill(37);
  const holderChannel = new Channel(), receiverChannel = new Channel(), queued = [], cancelled = [];
  const holderSend = holderChannel.send.bind(holderChannel), receiverSend = receiverChannel.send.bind(receiverChannel);
  holderChannel.send = data => {
    holderSend(data);
    queued.push(typeof data === "string" ? data : data.slice().buffer);
  };
  receiverChannel.send = data => {
    receiverSend(data);
    queueMicrotask(() => holderChannel.receive(data));
  };
  const holder = core.peerLink({ pubkey: "receiver", channel: holderChannel, pc: new PC(), maxSegmentBytes: source.length,
    onRequest: () => source, onUploadCancelled: (_link, bytes) => cancelled.push(bytes) });
  const receiver = core.peerLink({ pubkey: "holder", channel: receiverChannel, pc: new PC(), maxSegmentBytes: source.length });
  t.after(() => { holder.close(); receiver.close(); });
  const controller = new AbortController();
  const first = receiver.request(KEY, 5_000, { signal: controller.signal, expectedSize: source.length,
    range: { start: 0, end: 64, objectSize: source.length },
    onProgress: () => controller.abort(PeerLink.ABANDON_REASON) });
  await tick();
  assert.ok(holderChannel.bufferedAmount > 128 * 1024);
  assert.equal(holder.outboundInFlight, 1);
  const queuedBinaryBytes = holderChannel.sent.reduce((sum, message) => sum + (message.bytes ?? 0), 0);
  holderChannel.control("cancel", { id: 99 });
  assert.equal(holderChannel.sent.filter(message => message.t === "eof").length, 0, "unmatched cancel cannot wake an upload");
  receiverChannel.receive(queued.shift()); // metadata
  receiverChannel.receive(queued.shift()); // first binary chunk triggers cancellation
  assert.equal(await first, null);
  await tick();
  assert.equal(holderChannel.sent.at(-1).t, "eof", "matching cancel appends EOF without a bufferedamountlow event");
  assert.equal(holderChannel.sent.reduce((sum, message) => sum + (message.bytes ?? 0), 0), queuedBinaryBytes, "cancel adds no binary bytes");
  assert.deepEqual(cancelled, [source.length - queuedBinaryBytes]);
  assert.equal(receiver.busy, true, "the requester still quarantines queued untagged binary bytes");
  assert.equal(await receiver.request(KEY, 5_000), null, "no next request can interleave before matching EOF");
  while (queued.length) receiverChannel.receive(queued.shift());
  assert.equal(receiver.busy, false);
  assert.equal(holder.closed || receiver.closed, false);
  holderChannel.bufferedAmount = 0;
  holderChannel.dispatchEvent(new Event("bufferedamountlow"));
  const second = receiver.request(KEY, 5_000, { expectedSize: 98_304, range: { start: 0, end: 1, objectSize: source.length } });
  await tick();
  while (queued.length) receiverChannel.receive(queued.shift());
  assert.deepEqual(await second, source.slice(0, 98_304));
  assert.equal(holder.closed || receiver.closed, false);
  assert.equal(holder.outboundInFlight, 0);
  assert.equal(receiver.busy, false);
});

test("a refused text send closes as send-error and a refused chunk as serve-error", async () => {
  const text = await both({
    async run({ link, channel }) { channel.failText = true; link.sendHave([KEY]); },
  });
  assert.deepEqual(text.log, [{ closed: "send-error" }]);
  // Known difference: the core counts a response in bytesOut as it emits the
  // chunks, before the shell finds the channel refusing them; peer-link.mjs
  // counts nothing. The link is closed either way.
  const binary = await both({
    differs: ["bytesOut"],
    serve: () => new Uint8Array(40_000),
    async run({ channel }) { channel.failBinary = true; channel.control("want", { id: 7, k: KEY }); await tick(); },
  });
  assert.deepEqual(binary.log, [{ serve: "aaaa" }, { closed: "serve-error" }]);
});

test("a request on a closing channel reports send-error and leaves the link open", async () => {
  const outcome = await both({
    async run({ link, channel, log }) {
      channel.readyState = "closing";
      log.push({ resolved: await link.request(KEY, 1000, { onResult: (row) => log.push({ outcome: row.outcome, closeReason: row.closeReason }) }) });
    },
  });
  assert.deepEqual(outcome.log, [{ outcome: "send-error", closeReason: null }, { resolved: null }]);
  assert.equal(outcome.closed, false);
});

test("the reported timing fields match peer-link.mjs", async () => {
  const saved = globalThis.performance;
  try {
    let clock = 1000;
    globalThis.performance = { now: () => clock };
    const outcome = await both({
      async run({ link, channel, log }) {
        clock = 1000;
        const result = link.request(KEY, 2500.5, { expectedSize: 20_000, onResult: (row) => log.push(row),
          onProgress: (received, size, firstByteMs) => log.push({ received, size, firstByteMs }) });
        clock = 1040;
        channel.control("meta", { id: 1, size: 20_000 });
        channel.receive(new Uint8Array(16_384).buffer);
        clock = 1090;
        channel.receive(new Uint8Array(3_616).buffer);
        clock = 1100;
        channel.control("eof", { id: 1 });
        log.push({ bytes: (await result).byteLength });
      },
    });
    assert.deepEqual(outcome.log, [
      { received: 16_384, size: 20_000, firstByteMs: 40 },
      { received: 20_000, size: 20_000, firstByteMs: 40 },
      { outcome: "payload", elapsedMs: 100, timeoutMs: 2500.5, expectedBytes: 20_000, receivedBytes: 20_000, firstByteMs: 40,
        metadataReceived: true, draining: false, closeReason: null },
      { bytes: 20_000 },
    ]);
  } finally { globalThis.performance = saved; }
});

test("a trap retires the core: its links close as host and new requests read closed", async () => {
  const failures = [];
  const core = await loadCore(compiled, { onFailure: (error) => failures.push(error) });
  const channel = new Channel(), pc = new PC(), closed = [];
  const link = core.peerLink({ pubkey: "peer", channel, pc, maxSegmentBytes: 1 << 20, onClose: (peer) => closed.push(peer.closeReason) });
  const outcomes = [];
  const pending = link.request(KEY, 5000, { onResult: (row) => outcomes.push(row.outcome) });
  core.retire();
  assert.equal(await pending, null);
  assert.deepEqual(closed, ["host"]);
  assert.deepEqual(outcomes, ["closed"]);
  assert.equal(pc.closed, true);
  assert.equal(channel.readyState, "closed");
  assert.equal(await link.request(KEY, 5000), null);
  assert.deepEqual(failures, []);
  assert.throws(() => core.peerLink({ pubkey: "late", channel: new Channel(), pc: new PC(), maxSegmentBytes: 1024 }), /retired/);
});

test("a core whose links answer malformed frames retires before the first request", async () => {
  const failures = [];
  // Every link call answers an empty frame, shorter than the header.
  const core = await loadCore(stubCore([], { rs_link_new: 1 }), { onFailure: (error) => failures.push(error) });
  const channel = new Channel(), pc = new PC(), closed = [];
  const link = core.peerLink({ pubkey: "peer", channel, pc, maxSegmentBytes: 1 << 20, onClose: (peer) => closed.push(peer.closeReason) });
  assert.equal(await link.request(KEY, 5000), null);
  assert.equal(core.retired, true);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /refused operation/);
  assert.deepEqual(closed, ["host"]);
  assert.equal(channel.sent.length, 0);
});

// Observe the real module's upload ABI and allocator without changing production
// options. Only the optional export is hidden in the legacy compatibility arm.
async function trackedUploadCore(legacy = false) {
  const instantiate = WebAssembly.instantiate, uploads = [], failures = [];
  let allocated = null, supportsRanges = false;
  WebAssembly.instantiate = async (...args) => {
    const instance = await instantiate(...args);
    if (args[0] !== compiled) return instance;
    const original = instance.exports;
    supportsRanges = typeof original.rs_link_serve_range === "function";
    const exports = { ...original,
      rs_alloc(length) { allocated = length; return original.rs_alloc(length); },
      rs_link_call(...values) {
        if (values[1] === 6 && values[4] !== 0) uploads.push({ ranged: false, bytes: values[7], allocated });
        return original.rs_link_call(...values);
      },
    };
    if (legacy) delete exports.rs_link_serve_range;
    else if (supportsRanges) exports.rs_link_serve_range = (...values) => {
      uploads.push({ ranged: true, bytes: values[6], allocated });
      return original.rs_link_serve_range(...values);
    };
    return { exports };
  };
  try {
    const core = await loadCore(compiled, { onFailure: error => failures.push(error) });
    return { core, uploads, failures, supportsRanges };
  } finally { WebAssembly.instantiate = instantiate; }
}

async function uploadRanges({ size, ranges, legacy = false, viewKind = "uint8" }) {
  const tracked = await trackedUploadCore(legacy);
  assert.equal(tracked.supportsRanges, true, "rebuild the committed WASM for range-sized upload support");
  const backing = new Uint8Array(size + 37), source = backing.subarray(13, 13 + size);
  for (let index = 0; index < size; index++) source[index] = (index * 31 + (index >>> 16)) & 255;
  const channel = new Channel(), pc = new PC(), chunks = [], requests = [];
  const send = channel.send.bind(channel);
  channel.send = data => { send(data); if (typeof data !== "string") chunks.push(Buffer.from(data)); };
  const link = tracked.core.peerLink({ pubkey: "range-holder", channel, pc, maxSegmentBytes: size,
    onRequest(_link, key, range) {
      assert.equal(key, KEY); requests.push(range);
      return viewKind === "dataview" ? new DataView(source.buffer, source.byteOffset, source.byteLength) : source;
    } });
  const pieceSize = commitmentPieceSize(size), parts = [], started = performance.now();
  try {
    for (const [index, range] of ranges.entries()) {
      const sentAt = channel.sent.length;
      channel.control("want", { id: index + 1, k: KEY, ...(range ? { p: [range.start, range.end] } : {}) });
      await tick();
      for (let drains = 0; link.outboundInFlight && drains < 100; drains++) {
        channel.bufferedAmount = 0;
        channel.dispatchEvent(new Event("bufferedamountlow"));
        await tick();
      }
      assert.equal(link.outboundInFlight, 0, "the range finishes on the same link");
      const from = range ? range.start * pieceSize : 0;
      const to = range ? Math.min(size, range.end * pieceSize) : size;
      const body = Buffer.concat(chunks.splice(0));
      assert.deepEqual(body, Buffer.from(source.subarray(from, to)), "wire bytes equal only the requested portion of the offset source view");
      const text = channel.sent.slice(sentAt).filter(row => !Object.hasOwn(row, "bytes"));
      assert.deepEqual(text[0], { t: "meta", id: index + 1, size: to - from, ...(range ? { p: [range.start, range.end] } : {}) });
      assert.deepEqual(text.at(-1), { t: "eof", id: index + 1 });
      parts.push(body);
    }
    assert.equal(link.closed, false);
    assert.deepEqual(tracked.failures, []);
    assert.deepEqual(requests, ranges, "onRequest keeps its whole-object callback contract and original range hint");
    assert.ok(tracked.uploads.every(row => row.bytes === row.allocated), "each observed ABI input matches its real WASM allocation");
    return { bytes: Buffer.concat(parts), uploads: tracked.uploads, ms: performance.now() - started };
  } finally { link.close("host-stop"); tracked.core.retire(); }
}

test("range-sized WASM uploads preserve middle and short final pieces from offset views", async () => {
  const size = 200_000, piece = commitmentPieceSize(size);
  for (const viewKind of ["uint8", "dataview"]) {
    const result = await uploadRanges({ size, ranges: [{ start: 1, end: 3 }, { start: 3, end: 4 }], viewKind });
    assert.deepEqual(result.uploads.map(row => row.bytes), [2 * piece, size - 3 * piece]);
    assert.ok(result.uploads.every(row => row.ranged));
  }
});

test("whole-object uploads retain the existing ABI", async () => {
  const result = await uploadRanges({ size: 200_000, ranges: [undefined] });
  assert.deepEqual(result.uploads.map(({ bytes, ranged }) => ({ bytes, ranged })), [{ bytes: 200_000, ranged: false }]);
});

test("actual WASM range uploads copy object bytes once instead of once per request", async t => {
  const size = 6 * 1024 * 1024, piece = commitmentPieceSize(size), count = Math.ceil(size / piece);
  const piecesPerRequest = Math.max(1, Math.min(4, Math.floor(512 * 1024 / piece)));
  const ranges = Array.from({ length: Math.ceil(count / piecesPerRequest) }, (_, index) => ({
    start: index * piecesPerRequest, end: Math.min(count, (index + 1) * piecesPerRequest),
  }));
  const legacy = await uploadRanges({ size, ranges, legacy: true });
  const bounded = await uploadRanges({ size, ranges });
  assert.deepEqual(bounded.bytes, legacy.bytes);
  assert.equal(bounded.bytes.length, size);
  const legacyCopied = legacy.uploads.reduce((sum, row) => sum + row.bytes, 0);
  const boundedCopied = bounded.uploads.reduce((sum, row) => sum + row.bytes, 0);
  assert.equal(legacyCopied, size * ranges.length, "an older pinned ABI remains usable, with its original copy cost");
  assert.equal(boundedCopied, size);
  assert.ok(bounded.uploads.every(row => row.ranged && row.bytes <= 512 * 1024));
  t.diagnostic(JSON.stringify({ scope: "actual-WASM-synthetic-link-copy-microbenchmark-no-media-or-network",
    objectBytes: size, requests: ranges.length, pieceSize: piece, largestInputBytes: Math.max(...bounded.uploads.map(row => row.bytes)),
    legacyInputBytes: legacyCopied, rangeInputBytes: boundedCopied, inputReductionFactor: legacyCopied / boundedCopied,
    legacyMs: Math.round(legacy.ms * 100) / 100, rangeMs: Math.round(bounded.ms * 100) / 100,
    sha256: createHash("sha256").update(bounded.bytes).digest("hex") }));
});
