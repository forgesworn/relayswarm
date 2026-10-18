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
  send(data) { this.sent.push(JSON.parse(data)); }
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
  const { elapsedMs, ...fields } = row;
  assert.equal(typeof elapsedMs, "number"); assert.ok(Number.isFinite(elapsedMs) && elapsedMs >= 0);
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
  assert.equal(await link.request(KEY, 1500), null); assert.equal(channel.sent.length, 1);
  channel.chunk([3, 4]); channel.chunk([5, 6]);
  assert.equal(pending.parts.length, 0); assert.equal(pending.received, 6);
  assert.equal(await link.request(KEY, 1500), null); assert.equal(channel.sent.length, 1);
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
    (c) => { c.control("meta", { size: 2 }); c.chunk([1]); c.control("eof"); },
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
        receivedBytes: 3, metadataReceived: true, draining: false, closeReason: null }]);
      assert.equal(link.busy, false); assert.equal(link.closed, false); assert.equal(channel.sent.length, 1);
      t.mock.timers.tick(100); channel.control("eof"); assert.equal(rows.length, 1);
    } finally { time.mock.restore(); }
  }
});
