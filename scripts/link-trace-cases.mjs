// Scripted inputs for the PeerLink traces in core/vectors/link-traces.json.
const K = "a".repeat(64), K2 = "b".repeat(64), K3 = "c".repeat(64);
const hex = (index) => index.toString(16).padStart(64, "0");
const json = (value) => JSON.stringify(value);
const text = (value) => ({ in: { text: typeof value === "string" ? value : json(value) } });
const binary = (len, seed = 1) => ({ in: { binary: { len, seed } } });
const request = (key = K, timeoutMs = 5000, expectedSize) => ({ in: { request: { key, timeoutMs, ...(expectedSize === undefined ? {} : { expectedSize }) } } });
const advance = (ms) => ({ in: { advance: ms } });
const serve = (len, seed = 7) => ({ in: { serve: len === null ? null : { len, seed } } });
const want = (id, k = K) => text({ t: "want", id, k });
const config = (overrides = {}) => ({ maxSegmentBytes: 64 * 1024, maxQueuedRequests: 2, drainTimeoutMs: 3000, reliable: true, ...overrides });
const trace = (name, steps, overrides) => ({ name, config: config(overrides), steps });

export const linkTraceCases = [
  trace("payload in two chunks", [request(K, 5000, 20000), text({ t: "meta", id: 1, size: 20000 }), binary(16384, 1), binary(3616, 2), text({ t: "eof", id: 1 })]),
  trace("integral float identifiers", [request(), text('{"t":"meta","id":1.0,"size":10}'), binary(10), text('{"t":"eof","id":1e0}')]),
  trace("none before meta", [request(), text({ t: "none", id: 1 })]),
  trace("none after meta closes", [request(), text({ t: "meta", id: 1, size: 10 }), text({ t: "none", id: 1 })]),
  trace("meta differs from expected size", [request(K, 5000, 100), text({ t: "meta", id: 1, size: 101 })]),
  trace("meta above segment cap", [request(), text({ t: "meta", id: 1, size: 64 * 1024 + 1 })]),
  trace("meta zero size", [request(), text({ t: "meta", id: 1, size: 0 })]),
  trace("repeated meta", [request(), text({ t: "meta", id: 1, size: 10 }), text({ t: "meta", id: 1, size: 10 })]),
  trace("meta for another request ignored", [request(), text({ t: "meta", id: 9, size: 10 }), text({ t: "meta", id: 1, size: 10 }), binary(10), text({ t: "eof", id: 1 })]),
  trace("binary before meta", [request(), binary(10)]),
  trace("binary without a request ignored", [binary(10)]),
  trace("oversize chunk", [request(), text({ t: "meta", id: 1, size: 20000 }), binary(16385)]),
  trace("empty chunk", [request(), text({ t: "meta", id: 1, size: 20000 }), binary(0)]),
  trace("received exceeds size", [request(), text({ t: "meta", id: 1, size: 10 }), binary(11)]),
  trace("early eof without cancel", [request(), text({ t: "meta", id: 1, size: 10 }), binary(5), text({ t: "eof", id: 1 })]),
  trace("too many chunks", [request(), text({ t: "meta", id: 1, size: 16384 }), binary(1), binary(1), binary(1), binary(1), binary(1)], { maxSegmentBytes: 16384 }),
  trace("timeout drains then early eof after cancel", [request(), text({ t: "meta", id: 1, size: 30000 }), binary(10000), advance(5000), binary(2000), text({ t: "eof", id: 1 }), request(K2)]),
  trace("timeout drains then none before meta", [request(), advance(5000), text({ t: "none", id: 1 })]),
  trace("timeout drain expires", [request(), text({ t: "meta", id: 1, size: 30000 }), advance(4999), advance(1), request(K2), advance(3000)]),
  trace("abandon then foreign meta while draining", [request(), text({ t: "meta", id: 1, size: 30000 }), binary(100), { in: { abort: "abandon" } }, text({ t: "meta", id: 2, size: 10 })]),
  trace("draining completes in full", [request(), text({ t: "meta", id: 1, size: 300 }), { in: { abort: "abort" } }, binary(300), text({ t: "eof", id: 1 })]),
  trace("abort on an unreliable channel closes", [request(), text({ t: "meta", id: 1, size: 300 }), binary(100), { in: { abort: "abort" } }], { reliable: false }),
  trace("timeout on an unreliable channel closes", [request(), advance(5000)], { reliable: false }),
  trace("busy while pending", [request(), request(K2)]),
  trace("request after close", [{ in: { close: "rotation" } }, request()]),
  trace("close with a pending request", [request(), text({ t: "meta", id: 1, size: 300 }), binary(100), { in: { close: "admission" } }, text({ t: "eof", id: 1 })]),
  trace("unknown close reason reads as host", [{ in: { close: "something" } }]),
  trace("abort after completion does nothing", [request(), text({ t: "none", id: 1 }), { in: { abort: "abandon" } }]),
  trace("have sets", [
    text({ t: "have", keys: [K, "nothex", K2.toUpperCase(), K2, 5, K] }),
    text({ t: "have", add: [K3, K], del: [K2] }),
    text({ t: "have", keys: "not a list", add: [K2] }),
    text({ t: "have", keys: [] }),
    text({ t: "have", keys: Array.from({ length: 300 }, (_, index) => hex(index)) }),
    text({ t: "have", add: [K] }),
    text({ t: "have", del: [hex(0)], add: [K] }),
  ]),
  trace("contribution and renditions", [
    text({ t: "contribution", serving: "yes", rendition: null }),
    text({ t: "contribution", serving: true, rendition: "x".repeat(2049) }),
    text({ t: "contribution", serving: true, rendition: "é".repeat(2048) }),
    ...Array.from({ length: 9 }, (_, index) => text({ t: "contribution", serving: true, rendition: `r${index}` })),
    advance(30001),
    text({ t: "contribution", serving: true, rendition: "late" }),
    text({ t: "contribution", serving: true, rendition: null }),
    text({ t: "contribution", serving: false, rendition: "r1" }),
  ]),
  trace("fetching leases", [
    text({ t: "fetching", k: K, ms: 500 }),
    text({ t: "contribution", serving: true, rendition: null }),
    text({ t: "fetching", k: K, ms: 500 }),
    text({ t: "fetching", k: K2, ms: 2001 }),
    text({ t: "fetching", k: K2, ms: 1.5 }),
    text({ t: "fetching", k: K2, ms: 2000 }),
    ...Array.from({ length: 24 }, (_, index) => text({ t: "fetching", k: hex(index), ms: 1000 })),
    text({ t: "fetching", k: K, ms: 700 }),
    text({ t: "fetching", k: K, ms: 0 }),
    advance(1500),
    text({ t: "fetching", k: K3, ms: 100 }),
  ]),
  trace("serve one response", [want(1), serve(40000), want(2, K2), serve(null)]),
  trace("serve empty bytes", [want(1), serve(0)]),
  trace("serve waits for the channel to drain", [want(1), serve(200000), { in: { drain: true } }, { in: { drain: true } }]),
  trace("cancel before bytes arrive", [want(4), text({ t: "cancel", id: 4 }), serve(1000)]),
  trace("cancel while waiting to drain", [want(1), serve(200000), text({ t: "cancel", id: 1 }), { in: { drain: true } }]),
  trace("queued request cancelled before it starts", [want(1), want(2, K2), text({ t: "cancel", id: 2 }), serve(100)]),
  trace("queued requests run in order", [want(1), want(2, K2), serve(100, 1), serve(200, 2)]),
  trace("upload queue overflow", [want(1), want(2, K2), want(3, K3)]),
  trace("upload drain timeout", [want(1), serve(200000), advance(3000)]),
  trace("close while awaiting bytes", [want(1), { in: { close: "host" } }, serve(100)]),
  trace("close while awaiting cancelled bytes", [want(1), text({ t: "cancel", id: 1 }), { in: { close: "host" } }, serve(100)]),
  trace("invalid want ignored", [want(1.5), text({ t: "want", id: 1, k: "short" }), text({ t: "cancel", id: "1" })]),
  trace("malformed and unknown text", [text("5"), text("[]"), text("null"), text({ t: "other" }), text("{")]),
  trace("text length counts UTF-16 units", [text(json({ t: "have", keys: [], pad: "é".repeat(65000) })), text(json({ t: "have", keys: [], pad: "😀".repeat(33000) }))]),
  trace("text over 64 KiB", [text(json({ t: "x", pad: "x".repeat(65536) }))]),
  trace("outgoing control messages", [
    { in: { sendHave: Array.from({ length: 300 }, (_, index) => hex(index)) } },
    { in: { sendHaveChange: { add: [], del: [] } } },
    { in: { sendHaveChange: { add: [K], del: [K2] } } },
    { in: { sendContribution: { serving: true, rendition: "/media/high/index.m3u8" } } },
    { in: { sendFetching: { k: K, ms: 800 } } },
  ]),
  trace("progress and payload across a drain timer", [request(K, 5000), text({ t: "meta", id: 1, size: 16385 }), binary(16384), advance(4000), binary(1), text({ t: "eof", id: 1 }), advance(10000)]),
];
