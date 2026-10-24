// PeerLink backed by the Rust core against peer-link.mjs, for what the
// committed link traces cannot show: channels that drain silently, refuse
// sends or are closing, callbacks that call back in, and the timing fields
// reported to the caller. Every scenario runs on both and must agree.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { loadCore } from "../src/browser/core-wasm.mjs";
import { runLinkTrace } from "./link-traces.mjs";
import { stubCore } from "./core-stub.mjs";

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
