import test from "node:test";
import assert from "node:assert/strict";
import { PeerLink } from "../src/browser/peer-link.mjs";

const KEY = "a".repeat(64);
class Channel extends EventTarget {
  readyState = "open";
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  bufferedAmount = 0;
  sent = [];
  send(data) { this.sent.push(typeof data === "string" ? JSON.parse(data) : { bytes: data.byteLength }); }
  receive(data) { this.dispatchEvent(new MessageEvent("message", { data })); }
  control(t, extra = {}) { this.receive(JSON.stringify({ t, id: 1, ...extra })); }
  chunk(bytes) { this.receive(Uint8Array.from(bytes).buffer); }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
class PC extends EventTarget {
  close() { this.closed = true; }
}
function fixture(t, options = {}) {
  const channel = new Channel(), pc = new PC(), closed = [], scheduled = [];
  const link = new PeerLink({ pubkey: "peer", channel, pc, maxSegmentBytes: 32768,
    onClose: (peer) => closed.push(peer.closeReason),
    onScheduleChange: (peer) => scheduled.push({ busy: peer.busy, closed: peer.closed }), ...options });
  t.after(() => link.close());
  return { channel, pc, link, closed, scheduled };
}
function clock(t) { t.mock.timers.enable({ apis: ["setTimeout"] }); }
function result(row, expected) {
  const { elapsedMs, firstByteMs, ...fields } = row;
  assert.equal(typeof elapsedMs, "number"); assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
  // First byte is the first accepted payload chunk, never later than the result.
  if (row.receivedBytes) assert.ok(Number.isFinite(firstByteMs) && firstByteMs >= 0 && firstByteMs <= elapsedMs);
  else assert.equal(firstByteMs, null);
  assert.deepEqual(fields, expected);
  assert.equal(JSON.stringify(row).includes(KEY), false, "result contains no requested key");
}

// Exercise the actual receiver with untagged binary frames; the second WANT
// must not be sent until the abandoned first response has a valid boundary.
test("reliable timeout releases payload promptly, drains late chunks and reuses only after matching EOF", async (t) => {
  clock(t);
  const { channel, link, closed, scheduled } = fixture(t);
  const first = link.request(KEY, 1500, { expectedSize: 6 });
  const pending = link.pending, retainedParts = pending.parts;
  channel.control("meta", { size: 6 }); channel.chunk([1, 2]);
  t.mock.timers.tick(1500);
  assert.equal(await first, null);
  assert.equal(link.pending, pending); assert.equal(pending.draining, true);
  assert.equal(retainedParts.length, 0); assert.equal(pending.received, 2); assert.equal(pending.chunks, 1);
  assert.equal(link.busy, true); assert.equal(link.transferring, true);
  assert.equal(link.lastDeliveredAt, 0); assert.deepEqual(closed, []);
  assert.deepEqual(channel.sent, [{ t: "want", id: 1, k: KEY }, { t: "cancel", id: 1 }]);
  assert.equal(await link.request(KEY, 1500), null); assert.equal(channel.sent.length, 2);
  channel.chunk([3, 4]); channel.chunk([5, 6]);
  assert.equal(pending.parts.length, 0); assert.equal(pending.received, 6);
  assert.equal(await link.request(KEY, 1500), null); assert.equal(channel.sent.length, 2);
  channel.control("eof");
  assert.equal(link.busy, false); assert.equal(link.transferring, false);
  assert.deepEqual(scheduled, [{ busy: false, closed: false }]);
  assert.equal(link.lastDeliveredAt, 0, "discarded bytes are not a delivered segment");
  const second = link.request(KEY, 1500, { expectedSize: 3 });
  assert.equal(channel.sent.at(-1).id, 2);
  channel.control("meta", { id: 2, size: 3 }); channel.chunk([7, 8, 9]); channel.control("eof", { id: 2 });
  assert.deepEqual(await second, new Uint8Array([7, 8, 9]));
  assert.equal(link.bytesIn, 9); assert.ok(link.lastDeliveredAt > 0);
  t.mock.timers.tick(3000); assert.equal(link.closed, false, "old drain timer was cleared");
});

test("abort before metadata quarantines a late full response without retaining its payload", async (t) => {
  clock(t);
  const { channel, link, closed } = fixture(t), controller = new AbortController();
  const request = link.request(KEY, 1500, { signal: controller.signal, expectedSize: 3 });
  controller.abort(); assert.equal(await request, null); assert.equal(link.busy, true);
  channel.control("meta", { size: 3 }); channel.chunk([1, 2, 3]);
  assert.equal(link.pending.parts.length, 0); channel.control("eof");
  assert.equal(link.busy, false); assert.deepEqual(closed, []);
});

test("a matching none before metadata ends quarantine and permits another request", async (t) => {
  clock(t);
  const { channel, link } = fixture(t);
  const request = link.request(KEY, 1500);
  t.mock.timers.tick(1500); assert.equal(await request, null);
  channel.control("none"); assert.equal(link.busy, false);
  const next = link.request(KEY, 1500); channel.control("none", { id: 2 });
  assert.equal(await next, null); assert.equal(link.closed, false);
});

test("a timed-out request sends cancel and an early eof from the holder ends the drain", async (t) => {
  clock(t);
  const { channel, link, closed, scheduled } = fixture(t);
  const first = link.request(KEY, 1500, { expectedSize: 6 });
  channel.control("meta", { size: 6 }); channel.chunk([1, 2]);
  t.mock.timers.tick(1500); assert.equal(await first, null);
  assert.deepEqual(channel.sent, [{ t: "want", id: 1, k: KEY }, { t: "cancel", id: 1 }]);
  channel.chunk([3]); channel.control("eof");
  assert.equal(link.busy, false); assert.deepEqual(closed, []);
  assert.deepEqual(scheduled, [{ busy: false, closed: false }]);
  assert.equal(link.lastDeliveredAt, 0, "a cancelled response is not a delivered segment");
  t.mock.timers.tick(3000); assert.equal(link.closed, false, "the drain timer was cleared");
  const second = link.request(KEY, 1500, { expectedSize: 1 });
  channel.control("meta", { id: 2, size: 1 }); channel.chunk([9]); channel.control("eof", { id: 2 });
  assert.deepEqual(await second, new Uint8Array([9]));
});

test("a failed cancel send closes the link once and keeps the single timeout result", async (t) => {
  clock(t);
  const { channel, link, closed } = fixture(t), rows = [];
  const request = link.request(KEY, 10, { onResult: (row) => rows.push(row) });
  t.mock.method(channel, "send", () => { throw new Error("private transport detail"); });
  t.mock.timers.tick(10); assert.equal(await request, null);
  assert.deepEqual(closed, ["send-error"]); assert.equal(link.pending, null);
  assert.equal(rows.length, 1); assert.equal(rows[0].outcome, "timeout");
  t.mock.timers.tick(3000); assert.equal(closed.length, 1);
});

test("drain uses the original 3000ms bound with no renewal from chunks or repeated abort", async (t) => {
  clock(t);
  const { channel, link, closed } = fixture(t), controller = new AbortController();
  const request = link.request(KEY, 1500, { signal: controller.signal });
  channel.control("meta", { size: 4 }); controller.abort(); assert.equal(await request, null);
  t.mock.timers.tick(2999); channel.chunk([1]); controller.abort();
  assert.equal(link.closed, false); t.mock.timers.tick(1);
  assert.equal(link.closed, true); assert.deepEqual(closed, ["request-abort"]);
  assert.equal(link.pending, null);
});

test("timeout drain expiry reports an actual close once and clears the retained record", async (t) => {
  clock(t);
  const { link, closed, scheduled, pc } = fixture(t, { drainTimeoutMs: 25 });
  const request = link.request(KEY, 10); t.mock.timers.tick(10); assert.equal(await request, null);
  assert.deepEqual(closed, []); t.mock.timers.tick(25);
  assert.deepEqual(closed, ["request-timeout"]); assert.equal(pc.closed, true);
  assert.equal(link.pending, null); assert.deepEqual(scheduled, []);
  t.mock.timers.tick(5000); assert.equal(closed.length, 1);
});

test("only explicitly ordered fully reliable open channels may quarantine", async (t) => {
  clock(t);
  for (const settings of [ { ordered: false }, { ordered: undefined }, { maxRetransmits: 0 },
    { maxRetransmits: 1 }, { maxRetransmits: undefined }, { maxPacketLifeTime: 0 },
    { maxPacketLifeTime: 100 }, { maxPacketLifeTime: undefined }, "throw" ]) {
    const { channel, link, closed } = fixture(t), controller = new AbortController();
    if (settings === "throw") Object.defineProperty(channel, "ordered", { get() { throw new Error("unavailable"); } });
    else Object.assign(channel, settings);
    const request = link.request(KEY, 1500, { signal: controller.signal }); controller.abort();
    assert.equal(await request, null); assert.equal(link.closed, true); assert.equal(link.busy, false);
    assert.deepEqual(closed, ["request-abort"]);
  }
  const { channel, link, closed } = fixture(t), controller = new AbortController();
  const request = link.request(KEY, 1500, { signal: controller.signal });
  channel.readyState = "closing"; controller.abort();
  assert.equal(await request, null); assert.deepEqual(closed, ["request-abort"]);
});

test("draining rejects malformed metadata, boundaries and untagged chunks", async (t) => {
  clock(t);
  const attacks = [
    (c) => c.chunk([1]),
    (c) => c.control("eof"),
    (c) => c.control("meta", { id: 2, size: 2 }),
    (c) => c.control("eof", { id: 2 }),
    (c) => c.control("none", { id: 2 }),
    (c) => c.control("meta", { size: 0 }),
    (c) => c.control("meta", { size: 32769 }),
    (c) => c.control("meta", { size: 1.5 }),
    (c) => { c.control("meta", { size: 2 }); c.control("meta", { size: 2 }); },
    (c) => { c.control("meta", { size: 2 }); c.control("none"); },
    (c) => { c.control("meta", { size: 2 }); c.chunk([1, 2, 3]); },
    (c) => { c.control("meta", { size: 2 }); c.chunk([]); },
    (c) => { c.control("meta", { size: 32768 }); c.chunk(new Uint8Array(16385)); },
    (c) => c.receive("{invalid"),
  ];
  for (const attack of attacks) {
    const { channel, link, closed, scheduled } = fixture(t);
    const request = link.request(KEY, 10); t.mock.timers.tick(10); assert.equal(await request, null);
    attack(channel); assert.equal(link.closed, true); assert.deepEqual(closed, ["protocol"]);
    assert.equal(link.pending, null); assert.deepEqual(scheduled, []);
  }
});

test("drain validates late authoritative size and counts chunks received before cancellation", async (t) => {
  clock(t);
  const wrong = fixture(t), pending = wrong.link.request(KEY, 10, { expectedSize: 4 });
  t.mock.timers.tick(10); assert.equal(await pending, null);
  wrong.channel.control("meta", { size: 5 }); assert.equal(wrong.link.closeReason, "protocol");
  const { link, channel } = fixture(t), request = link.request(KEY, 10);
  channel.control("meta", { size: 100 });
  for (let i = 0; i < 4; i++) channel.chunk([1]);
  t.mock.timers.tick(10); assert.equal(await request, null);
  for (let i = 0; i < 4; i++) channel.chunk([1]);
  assert.equal(link.pending.chunks, link.maxChunks); assert.equal(link.pending.parts.length, 0);
  channel.chunk([1]); assert.equal(link.closeReason, "protocol");
});

test("host stop, admission, channel failure and native failure immediately clear quarantine", async (t) => {
  clock(t);
  for (const reason of ["host-stop", "admission", "channel-error", "native-disconnected"]) {
    const { channel, pc, link, closed, scheduled } = fixture(t);
    const request = link.request(KEY, 10); t.mock.timers.tick(10); assert.equal(await request, null);
    if (reason === "channel-error") channel.dispatchEvent(new Event("error"));
    else if (reason === "native-disconnected") { pc.connectionState = "disconnected"; pc.dispatchEvent(new Event("connectionstatechange")); }
    else link.close(reason);
    assert.equal(link.closed, true); assert.equal(link.pending, null); assert.deepEqual(closed, [reason]);
    assert.deepEqual(scheduled, []); t.mock.timers.tick(3000); assert.equal(closed.length, 1);
  }
});

test("a queued old drain callback cannot close a reused link or its next request", async (t) => {
  const timers = [], cleared = new Set();
  t.mock.method(globalThis, "setTimeout", (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; });
  t.mock.method(globalThis, "clearTimeout", (timer) => cleared.add(timer));
  const { channel, link } = fixture(t);
  const first = link.request(KEY, 1500); timers[0].fn(); assert.equal(await first, null);
  const drainTimer = timers[1]; assert.equal(drainTimer.ms, 3000);
  channel.control("none"); assert.ok(cleared.has(drainTimer));
  const second = link.request(KEY, 1500);
  drainTimer.fn(); timers[0].fn(); assert.equal(link.closed, false); assert.equal(link.pending.id, 2);
  channel.control("meta", { id: 2, size: 2 }); channel.chunk([8, 9]); channel.control("eof", { id: 2 });
  assert.deepEqual(await second, new Uint8Array([8, 9])); assert.equal(link.closed, false);
});

test("drain completion frees the slot before its single scheduling callback", async (t) => {
  clock(t);
  let next, notifications = 0;
  const { channel, link } = fixture(t, { onScheduleChange(peer) {
    notifications++;
    assert.equal(peer.busy, false);
    next = peer.request(KEY, 1500, { expectedSize: 1 });
  } });
  const first = link.request(KEY, 10); t.mock.timers.tick(10); assert.equal(await first, null);
  channel.control("none");
  assert.equal(notifications, 1); assert.equal(link.pending.id, 2);
  channel.control("meta", { id: 2, size: 1 }); channel.chunk([5]); channel.control("eof", { id: 2 });
  assert.deepEqual(await next, new Uint8Array([5])); assert.equal(notifications, 1);
});

test("active invalid responses also fail closed instead of freeing an untagged stream", async (t) => {
  clock(t);
  for (const attack of [
    (c) => c.control("meta", { size: 0 }),
    (c) => { c.control("meta", { size: 1 }); c.chunk([1, 2]); },
    (c) => { c.control("meta", { size: 2 }); c.chunk([1]); c.control("eof"); },
  ]) {
    const { channel, link } = fixture(t), request = link.request(KEY, 1500);
    attack(channel); assert.equal(await request, null); assert.equal(link.closeReason, "protocol");
  }
});

test("request results retain timeout progress before metadata or partial payload without a second late result", async (t) => {
  clock(t);
  for (const partial of [false, true]) {
    const { channel, link } = fixture(t), rows = [];
    const request = link.request(KEY, 10, { expectedSize: 4, onResult: row => rows.push(row) });
    if (partial) { channel.control("meta", { size: 4 }); channel.chunk([1, 2]); }
    t.mock.timers.tick(10);
    assert.equal(await request, null); assert.equal(rows.length, 1);
    result(rows[0], { outcome: "timeout", timeoutMs: 10, expectedBytes: 4,
      receivedBytes: partial ? 2 : 0, metadataReceived: partial, draining: true, closeReason: null });
    if (!partial) channel.control("meta", { size: 4 });
    channel.chunk(partial ? [3, 4] : [1, 2, 3, 4]); channel.control("eof");
    assert.equal(link.busy, false); assert.equal(rows.length, 1);
    assert.equal(rows[0].receivedBytes, partial ? 2 : 0, "late bytes do not rewrite the logical timeout");
    assert.equal(rows[0].metadataReceived, partial);
    t.mock.timers.tick(3000); assert.equal(link.closed, false);
    link.close("host-stop"); assert.equal(rows.length, 1);
  }
});

test("request results distinguish none from a completed payload and retain the original payload promise", async (t) => {
  clock(t);
  const { channel, link } = fixture(t), rows = [], busyAtResult = [];
  const onResult = row => { busyAtResult.push(link.busy); rows.push(row); };
  const unavailable = link.request(KEY, 100, { onResult }); channel.control("none");
  assert.equal(await unavailable, null);
  result(rows[0], { outcome: "none", timeoutMs: 100, expectedBytes: null,
    receivedBytes: 0, metadataReceived: false, draining: false, closeReason: null });
  const delivered = link.request(KEY, 100, { expectedSize: 3, onResult });
  channel.control("meta", { id: 2, size: 3 }); channel.chunk([7, 8, 9]); channel.control("eof", { id: 2 });
  assert.deepEqual(await delivered, new Uint8Array([7, 8, 9])); assert.equal(rows.length, 2);
  result(rows[1], { outcome: "payload", timeoutMs: 100, expectedBytes: 3,
    receivedBytes: 3, metadataReceived: true, draining: false, closeReason: null });
  assert.deepEqual(busyAtResult, [false, false], "normal completion frees the slot before diagnostics");
  t.mock.timers.tick(3100); link.close(); assert.equal(rows.length, 2);
});

test("request abort results distinguish reliable draining from immediate unreliable closure", async (t) => {
  clock(t);
  for (const reliable of [true, false]) {
    const { channel, link } = fixture(t), rows = [], controller = new AbortController();
    channel.ordered = reliable;
    const request = link.request(KEY, 100, { signal: controller.signal, expectedSize: 4, onResult: row => rows.push(row) });
    channel.control("meta", { size: 4 }); channel.chunk([1]); controller.abort();
    assert.equal(await request, null); assert.equal(rows.length, 1);
    result(rows[0], { outcome: "abort", timeoutMs: 100, expectedBytes: 4,
      receivedBytes: 1, metadataReceived: true, draining: reliable, closeReason: reliable ? null : "request-abort" });
    controller.abort(); t.mock.timers.tick(3000); assert.equal(rows.length, 1);
    assert.equal(link.closed, true);
  }
});

test("active protocol and host closure report their fixed reason with observed request progress", async (t) => {
  clock(t);
  for (const protocol of [true, false]) {
    const { channel, link } = fixture(t), rows = [];
    const request = link.request(KEY, 100, { expectedSize: 4, onResult: row => rows.push(row) });
    channel.control("meta", { size: 4 }); channel.chunk([1]);
    if (protocol) channel.control("eof"); else link.close("host-stop");
    assert.equal(await request, null); assert.equal(rows.length, 1);
    result(rows[0], { outcome: "closed", timeoutMs: 100, expectedBytes: 4,
      receivedBytes: 1, metadataReceived: true, draining: false, closeReason: protocol ? "protocol" : "host-stop" });
    t.mock.timers.tick(3100); assert.equal(rows.length, 1);
  }
});

test("early busy, aborted and closed requests report only their own result without another WANT", async (t) => {
  clock(t);
  const { channel, link } = fixture(t), rows = [];
  const first = link.request(KEY, 100, { expectedSize: 4 });
  channel.control("meta", { size: 4 }); channel.chunk([1, 2]);
  assert.equal(await link.request(KEY, 20, { expectedSize: 2, onResult: row => rows.push(row) }), null);
  result(rows[0], { outcome: "busy", timeoutMs: 20, expectedBytes: 2,
    receivedBytes: 0, metadataReceived: false, draining: false, closeReason: null });
  channel.chunk([3, 4]); channel.control("eof"); await first;
  const controller = new AbortController(); controller.abort();
  assert.equal(await link.request(KEY, Number.NaN, { signal: controller.signal,
    expectedSize: Infinity, onResult: row => rows.push(row) }), null);
  result(rows[1], { outcome: "abort", timeoutMs: null, expectedBytes: null,
    receivedBytes: 0, metadataReceived: false, draining: false, closeReason: null });
  link.close("private arbitrary reason");
  assert.equal(await link.request(KEY, 20, { onResult: row => rows.push(row) }), null);
  result(rows[2], { outcome: "closed", timeoutMs: 20, expectedBytes: null,
    receivedBytes: 0, metadataReceived: false, draining: false, closeReason: "host" });
  assert.equal(channel.sent.length, 1); assert.equal(rows.length, 3);
});

test("send failures report once whether the channel throws or is no longer open", async (t) => {
  clock(t);
  for (const throws of [true, false]) {
    const { channel, link } = fixture(t), rows = [];
    if (throws) t.mock.method(channel, "send", () => { throw new Error("private transport detail"); });
    else channel.readyState = "closing";
    assert.equal(await link.request(KEY, 100, { onResult: row => rows.push(row) }), null);
    assert.equal(rows.length, 1);
    result(rows[0], { outcome: "send-error", timeoutMs: 100, expectedBytes: null,
      receivedBytes: 0, metadataReceived: false, draining: false, closeReason: throws ? "send-error" : null });
    assert.equal(link.closed, throws); assert.equal(link.busy, false);
    t.mock.timers.tick(3100); assert.equal(rows.length, 1);
  }
});

test("a throwing request result callback cannot change payload delivery, refusal or timeout drain", async (t) => {
  clock(t);
  const { channel, link } = fixture(t); let callbacks = 0;
  const onResult = () => { callbacks++; throw new Error("diagnostic consumer failed"); };
  const payload = link.request(KEY, 100, { onResult });
  channel.control("meta", { size: 1 }); channel.chunk([5]); channel.control("eof");
  assert.deepEqual(await payload, new Uint8Array([5])); assert.equal(link.closed, false);
  const none = link.request(KEY, 100, { onResult }); channel.control("none", { id: 2 });
  assert.equal(await none, null);
  const timeout = link.request(KEY, 10, { onResult }); t.mock.timers.tick(10);
  assert.equal(await timeout, null); assert.equal(link.pending.draining, true);
  assert.equal(await link.request(KEY, 100, { onResult }), null);
  channel.control("none", { id: 3 }); assert.equal(link.busy, false);
  assert.equal(callbacks, 4); assert.equal(link.closed, false);
});

test("diagnostic start or settlement clock failures preserve payload and one result with unknown elapsed time", async (t) => {
  clock(t);
  for (const failedRead of ["start", "settlement"]) {
    const { channel, link } = fixture(t), rows = [];
    let clockFails = failedRead === "start";
    const time = t.mock.method(performance, "now", () => {
      if (clockFails) throw new Error("diagnostic clock unavailable");
      return 1000;
    });
    try {
      const request = link.request(KEY, 100, { expectedSize: 3, onResult: row => rows.push(row) });
      clockFails = failedRead === "settlement";
      channel.control("meta", { size: 3 }); channel.chunk([1, 2, 3]); channel.control("eof");
      assert.deepEqual(await request, new Uint8Array([1, 2, 3]));
      assert.deepEqual(rows, [{ outcome: "payload", elapsedMs: null, timeoutMs: 100, expectedBytes: 3,
        receivedBytes: 3, firstByteMs: null, metadataReceived: true, draining: false, closeReason: null }]);
      assert.equal(link.busy, false); assert.equal(link.closed, false); assert.equal(channel.sent.length, 1);
      t.mock.timers.tick(100); channel.control("eof"); assert.equal(rows.length, 1);
    } finally { time.mock.restore(); }
  }
});

// Holder side. Macrotask turns let the serialised response promise chain run.
const turn = () => new Promise((resolve) => setImmediate(resolve));
function holder(t, bytes, options = {}) {
  const requested = [], cancelled = [];
  const peer = fixture(t, { maxSegmentBytes: 1 << 22, onRequest: async (_link, key) => { requested.push(key); return bytes; },
    onUploadCancelled: (_link, unsent) => cancelled.push(unsent), ...options });
  return { ...peer, requested, cancelled };
}

test("a holder stops a response at the next chunk after a matching cancel and ends it with eof", async (t) => {
  clock(t);
  const { channel, link, cancelled } = holder(t, new Uint8Array(40_000).fill(7));
  const send = channel.send.bind(channel);
  // The first chunk fills the send buffer, so the holder waits before the second.
  channel.send = (data) => { send(data); if (typeof data !== "string") channel.bufferedAmount = 2 * 1024 * 1024; };
  channel.receive(JSON.stringify({ t: "want", id: 5, k: KEY })); await turn();
  assert.deepEqual(channel.sent, [{ t: "meta", id: 5, size: 40_000 }, { bytes: 16_384 }]);
  channel.receive(JSON.stringify({ t: "cancel", id: 5 }));
  channel.bufferedAmount = 0; channel.dispatchEvent(new Event("bufferedamountlow")); await turn();
  assert.deepEqual(channel.sent, [{ t: "meta", id: 5, size: 40_000 }, { bytes: 16_384 }, { t: "eof", id: 5 }]);
  assert.deepEqual(cancelled, [40_000 - 16_384]); assert.equal(link.bytesOut, 16_384);
  assert.equal(link.closed, false); assert.equal(link.outboundInFlight, 0); assert.equal(link.uploads.size, 0);
});

test("a cancel before the holder starts declines with none and never asks the host", async (t) => {
  clock(t);
  const { channel, requested, cancelled } = holder(t, new Uint8Array(10));
  channel.receive(JSON.stringify({ t: "want", id: 3, k: KEY }));
  channel.receive(JSON.stringify({ t: "cancel", id: 3 })); await turn();
  assert.deepEqual(channel.sent, [{ t: "none", id: 3 }]);
  assert.deepEqual(requested, []); assert.deepEqual(cancelled, [0]);
});

test("a cancel while the host decides declines with none and counts the charged bytes", async (t) => {
  clock(t);
  let release;
  const { channel, link, cancelled } = holder(t, null, { onRequest: () => new Promise((resolve) => { release = resolve; }) });
  channel.receive(JSON.stringify({ t: "want", id: 4, k: KEY })); await turn();
  channel.receive(JSON.stringify({ t: "cancel", id: 4 })); release(new Uint8Array(10)); await turn();
  assert.deepEqual(channel.sent, [{ t: "none", id: 4 }]);
  assert.deepEqual(cancelled, [10]); assert.equal(link.bytesOut, 0); assert.equal(link.closed, false);
});

test("unmatched, malformed and late cancels are ignored", async (t) => {
  clock(t);
  const { channel, link, cancelled } = holder(t, new Uint8Array(20).fill(1));
  channel.receive(JSON.stringify({ t: "want", id: 1, k: KEY }));
  for (const id of [2, "1", 1.5, null, undefined]) channel.receive(JSON.stringify({ t: "cancel", id }));
  await turn();
  assert.deepEqual(channel.sent, [{ t: "meta", id: 1, size: 20 }, { bytes: 20 }, { t: "eof", id: 1 }]);
  channel.receive(JSON.stringify({ t: "cancel", id: 1 })); await turn();
  assert.equal(channel.sent.length, 3); assert.deepEqual(cancelled, []);
  assert.equal(link.closed, false); assert.equal(link.bytesOut, 20);
});

test("paired links end a cancelled response early and then serve the next request in full", async (t) => {
  clock(t);
  const toHolder = new Channel(), toReceiver = new Channel(), cancelled = [];
  const deliver = (data) => typeof data === "string" ? data : data.slice().buffer;
  toHolder.send = (data) => { toHolder.sent.push(typeof data === "string" ? JSON.parse(data) : { bytes: data.byteLength }); toReceiver.receive(deliver(data)); };
  toReceiver.send = (data) => {
    toReceiver.sent.push(typeof data === "string" ? JSON.parse(data) : { bytes: data.byteLength });
    toHolder.receive(deliver(data));
    if (typeof data !== "string" && toReceiver.holdAfterChunk) toReceiver.bufferedAmount = 2 * 1024 * 1024;
  };
  const payload = new Uint8Array(40_000).fill(3);
  const receiver = new PeerLink({ pubkey: "holder", channel: toHolder, pc: new PC(), maxSegmentBytes: 1 << 20 });
  const served = new PeerLink({ pubkey: "receiver", channel: toReceiver, pc: new PC(), maxSegmentBytes: 1 << 20,
    onRequest: async () => payload, onUploadCancelled: (_link, unsent) => cancelled.push(unsent) });
  t.after(() => { receiver.close(); served.close(); });
  toReceiver.holdAfterChunk = true;
  const first = receiver.request(KEY, 1500, { expectedSize: payload.byteLength }); await turn();
  assert.equal(receiver.pending.received, 16_384);
  t.mock.timers.tick(1500); assert.equal(await first, null); assert.equal(receiver.busy, true);
  toReceiver.holdAfterChunk = false; toReceiver.bufferedAmount = 0;
  toReceiver.dispatchEvent(new Event("bufferedamountlow")); await turn();
  assert.equal(receiver.busy, false); assert.equal(receiver.closed, false); assert.equal(served.closed, false);
  assert.deepEqual(cancelled, [40_000 - 16_384]);
  const second = receiver.request(KEY, 1500, { expectedSize: payload.byteLength }); await turn();
  assert.deepEqual(await second, payload); assert.equal(served.bytesOut, 16_384 + 40_000);
});

test("a holder queues at most about 128 KiB of a response before waiting, so a cancel stops the rest", async (t) => {
  clock(t);
  const size = 300_000, { channel, cancelled } = holder(t, new Uint8Array(size));
  const send = channel.send.bind(channel);
  // Nothing drains: every chunk stays queued until the test lowers it.
  channel.send = (data) => { send(data); if (typeof data !== "string") channel.bufferedAmount += data.byteLength; };
  channel.receive(JSON.stringify({ t: "want", id: 1, k: KEY })); await turn();
  const chunks = () => channel.sent.filter((frame) => frame.bytes).length;
  assert.equal(chunks(), 9, "eight full chunks reach 128 KiB; the ninth crosses it");
  channel.receive(JSON.stringify({ t: "cancel", id: 1 }));
  channel.bufferedAmount = 0; channel.dispatchEvent(new Event("bufferedamountlow")); await turn();
  assert.equal(chunks(), 9); assert.deepEqual(channel.sent.at(-1), { t: "eof", id: 1 });
  assert.deepEqual(cancelled, [size - 9 * 16_384]);
});

test("progress reports each accepted chunk with its first byte, and an abandon is recorded as abandoned", async (t) => {
  clock(t);
  const { channel, link } = fixture(t), rows = [], progress = [];
  const controller = new AbortController();
  const request = link.request(KEY, 100, { signal: controller.signal, expectedSize: 4, onResult: row => rows.push(row),
    onProgress: (received, size, firstByteMs) => progress.push({ received, size, firstByte: Number.isFinite(firstByteMs) && firstByteMs >= 0 }) });
  channel.control("meta", { size: 4 });
  assert.deepEqual(progress, [], "metadata alone is not a first byte");
  channel.chunk([1]); channel.chunk([2]);
  assert.deepEqual(progress, [{ received: 1, size: 4, firstByte: true }, { received: 2, size: 4, firstByte: true }]);
  controller.abort(PeerLink.ABANDON_REASON);
  assert.equal(await request, null);
  result(rows[0], { outcome: "abandoned", timeoutMs: 100, expectedBytes: 4,
    receivedBytes: 2, metadataReceived: true, draining: true, closeReason: null });
  assert.deepEqual(channel.sent, [{ t: "want", id: 1, k: KEY }, { t: "cancel", id: 1 }]);
  channel.chunk([3]);
  assert.equal(progress.length, 2, "a draining request reports no further progress");
  channel.control("eof"); assert.equal(link.busy, false); assert.equal(rows.length, 1);
});

test("a throwing progress callback cannot break the transfer", async (t) => {
  clock(t);
  const { channel, link } = fixture(t);
  const request = link.request(KEY, 100, { expectedSize: 2, onProgress: () => { throw new Error("host failure"); } });
  channel.control("meta", { size: 2 }); channel.chunk([1, 2]); channel.control("eof");
  assert.deepEqual(await request, new Uint8Array([1, 2])); assert.equal(link.closed, false);
});
