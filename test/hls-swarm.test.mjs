// The guarantees a host page relies on, checked without a browser: the swarm
// never throws at the host, never alters what the player receives, restores
// the loader on stop, and the link protocol rejects what it should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { PeerSelection } from "../src/browser/peer-selection.mjs";

class FakePeerConnection {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, fn) { this.listeners.set(name, fn); }
  close() {}
}

class FakeLoader {
  constructor() { this.stats = { loaded: 0 }; this.context = null; }
  load(context, _config, callbacks) {
    this.context = context;
    const data = new Uint8Array(4096).fill(7).buffer;
    callbacks.onSuccess({ url: context.url, data }, this.stats, context, null);
  }
  abort() {}
  destroy() {}
}

const fragmentContext = (url) => ({ url, frag: { sn: 12, url }, part: null, responseType: "arraybuffer" });

test("a bad configuration yields a disabled swarm, never an exception", () => {
  for (const options of [{}, { swarmId: "short", relays: ["wss://relay.example"] }, { swarmId: "swarm-abcdefgh", relays: [] }]) {
    const swarm = createHlsSwarm(options);
    assert.equal(swarm.metrics().mode, "off");
    assert.ok(swarm.metrics().disabledReason);
    swarm.attach({ config: { loader: FakeLoader } });
    swarm.stop();
  }
  const peerFirst = createHlsSwarm({ swarmId: "swarm-abcdefgh", relays: ["wss://relay.example"], mode: "peer-first", RTCPeerConnectionImpl: FakePeerConnection });
  assert.equal(peerFirst.metrics().disabledReason, "invalid-stream-authorisation");
  const hls = { config: { loader: FakeLoader } };
  peerFirst.attach(hls);
  assert.equal(hls.config.fLoader, undefined, "a disabled swarm leaves the player alone");
});

test("shadow mode hands the player its bytes untouched and restores the loader on stop", async () => {
  const relay = await startLocalRelay();
  let swarm;
  try {
    swarm = createHlsSwarm({
      swarmId: "swarm-abcdefgh",
      relays: [relay.url],
      serve: true,
      shadowSampleRate: 1,
      RTCPeerConnectionImpl: FakePeerConnection,
      segmentKey: (url) => {
        if (url.includes("boom")) throw new Error("host page bug");
        return new URL(url).pathname;
      },
    });
    const hls = { config: { loader: FakeLoader } };
    swarm.attach(hls);
    assert.ok(hls.config.fLoader, "the fragment loader is wrapped");

    const loader = new hls.config.fLoader({});
    let delivered = null;
    let synchronous = false;
    loader.load(fragmentContext("https://origin.example/live/seg1.ts"), {}, {
      onSuccess: (response) => { delivered = response.data; synchronous = true; },
      onError: () => assert.fail("no error expected"),
      onTimeout: () => assert.fail("no timeout expected"),
    });
    assert.equal(synchronous, true, "the player is called back in the same tick");
    assert.equal(delivered.byteLength, 4096, "the buffer the player got is intact");
    assert.equal(new Uint8Array(delivered)[100], 7);

    let reached = false;
    new hls.config.fLoader({}).load(fragmentContext("https://origin.example/boom/seg2.ts"), {}, {
      onSuccess: () => { reached = true; },
      onError: () => {},
      onTimeout: () => {},
    });
    assert.equal(reached, true, "a throwing segmentKey never blocks a fragment");

    const deadline = Date.now() + 5000;
    while (swarm.metrics().bytes.held !== 4096 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    const metrics = swarm.metrics();
    assert.equal(metrics.segments.originLoaded, 1);
    assert.equal(metrics.errors.byStage["begin-race"], 1, "the host page's bug is counted, not thrown");
    assert.equal(metrics.bytes.held, 4096);

    swarm.stop();
    assert.equal(hls.config.fLoader, undefined, "stop restores the original fragment loader");
    assert.equal(swarm.metrics().stopped, true);
    assert.equal(swarm.metrics().bytes.held, 0);
  } finally {
    swarm?.stop();
    await relay.close();
  }
});

function channelPair() {
  const make = () => ({
    readyState: "open",
    bufferedAmount: 0,
    listeners: new Map(),
    addEventListener(name, fn) { (this.listeners.get(name) || this.listeners.set(name, new Set()).get(name)).add(fn); },
    removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); },
    emit(name, event) { for (const fn of this.listeners.get(name) || []) fn(event); },
    close() {
      if (this.readyState === "closed") return;
      this.readyState = "closed";
      this.emit("close");
      this.other?.close();
    },
    send(data) {
      if (this.readyState !== "open") throw new Error("closed");
      const copy = typeof data === "string" ? data : data.slice().buffer;
      queueMicrotask(() => this.other.emit("message", { data: copy }));
    },
  });
  const a = make();
  const b = make();
  a.other = b;
  b.other = a;
  return [a, b];
}

const KEY = "a".repeat(64);

test("a link serves held segments, and refuses oversize or unknown ones", async () => {
  const [left, right] = channelPair();
  const segment = new Uint8Array(100_000).map((_, i) => i % 251);
  const server = new PeerLink({ pubkey: "s", pc: new FakePeerConnection(), channel: left, maxSegmentBytes: 1_000_000, onRequest: (_link, key) => (key === KEY ? segment : null) });
  const client = new PeerLink({ pubkey: "c", pc: new FakePeerConnection(), channel: right, maxSegmentBytes: 1_000_000 });

  const bytes = await client.request(KEY, 2_000);
  assert.deepEqual(bytes, segment);
  assert.equal(server.bytesOut, segment.byteLength);

  assert.equal(await client.request("b".repeat(64), 2_000), null, "an unknown segment answers none");

  const small = new PeerLink({ pubkey: "c2", pc: new FakePeerConnection(), channel: channelPair()[0], maxSegmentBytes: 10 });
  assert.equal(small.busy, false);
  const [l2, r2] = channelPair();
  new PeerLink({ pubkey: "s2", pc: new FakePeerConnection(), channel: l2, maxSegmentBytes: 1_000_000, onRequest: () => segment });
  const tiny = new PeerLink({ pubkey: "c3", pc: new FakePeerConnection(), channel: r2, maxSegmentBytes: 1_000 });
  assert.equal(await tiny.request(KEY, 2_000), null, "a response larger than the cap is refused");

  client.close();
  assert.equal(await client.request(KEY, 100), null, "a closed link resolves null");
});

test("have messages are validated and bounded", async () => {
  const [left, right] = channelPair();
  const seen = [];
  new PeerLink({ pubkey: "s", pc: new FakePeerConnection(), channel: left, maxSegmentBytes: 1_000 });
  const receiver = new PeerLink({ pubkey: "c", pc: new FakePeerConnection(), channel: right, maxSegmentBytes: 1_000, onHaveChange: (_link, added) => seen.push(...added) });
  left.send(JSON.stringify({ t: "have", keys: [KEY, "not-a-hash", 42] }));
  left.send(JSON.stringify({ t: "have", add: ["c".repeat(64)], del: [KEY] }));
  left.send("{not json");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual([...receiver.have], ["c".repeat(64)]);
  assert.deepEqual(seen, [KEY, "c".repeat(64)]);
});

// --- rotation -----------------------------------------------------------
// The policy that lets a viewer joining an hour late find a peer at all,
// without letting a busy swarm thrash its links.

import { readRefusal, retryAfterFor, rotationCandidate } from "../src/browser/hls-swarm.mjs";

const NOW = 1_000_000;
const POLICY = { minLinkLifeMs: 15_000, idleEvictMs: 20_000, evictionCooldownMs: 10_000, retryFloorMs: 4_000, retryCeilingMs: 45_000, maxReferrals: 2 };
const link = (pubkey, { age = 60_000, idle = 60_000, transferring = false } = {}) => ({
  pubkey,
  transferring,
  openedAt: NOW - age,
  lastUsefulAt: NOW - idle,
});

test("rotation drops the longest-idle link, and nothing it should not", () => {
  const links = [link("busiest", { idle: 1_000 }), link("idle-30s", { idle: 30_000 }), link("idle-90s", { idle: 90_000 })];
  assert.equal(rotationCandidate(links, POLICY, NOW).pubkey, "idle-90s", "the least useful goes first");

  // Mid-transfer, too young, or banned: never.
  assert.equal(rotationCandidate([link("sending", { transferring: true })], POLICY, NOW), null, "a link mid-transfer is never cut");
  assert.equal(rotationCandidate([link("newcomer", { age: 3_000, idle: 3_000 })], POLICY, NOW), null, "a link that just opened is safe");
  assert.equal(rotationCandidate([link("crook")], { ...POLICY, banned: new Set(["crook"]) }, NOW), null);

  // A swarm where everyone is pulling its weight refuses rather than churns.
  assert.equal(rotationCandidate([link("a", { idle: 2_000 }), link("b", { idle: 5_000 })], POLICY, NOW), null);
  assert.equal(rotationCandidate([], POLICY, NOW), null);
});

test("rotation tiers order the links it could already drop, and never make one droppable", () => {
  const tiers = { unhelpful: 0, serving: 1, consumer: 2 };
  const tier = (value) => tiers[value.pubkey.split("-")[0]];
  const links = [link("consumer-90s", { idle: 90_000 }), link("serving-60s", { idle: 60_000 }), link("unhelpful-30s", { idle: 30_000 })];
  // Without a tier, or with an undefined one, the choice is the existing one: idle longest.
  assert.equal(rotationCandidate(links, POLICY, NOW).pubkey, "consumer-90s");
  assert.equal(rotationCandidate(links, { ...POLICY, tier: undefined }, NOW).pubkey, "consumer-90s");
  // With one, the lowest tier goes first, even though an older-idle link of a higher tier is also eligible.
  assert.equal(rotationCandidate(links, { ...POLICY, tier }, NOW).pubkey, "unhelpful-30s", "an older-idle link of a higher tier waits");
  assert.equal(rotationCandidate(links.slice(0, 2), { ...POLICY, tier }, NOW).pubkey, "serving-60s");
  assert.equal(rotationCandidate(links.slice(0, 1), { ...POLICY, tier }, NOW).pubkey, "consumer-90s", "the only eligible link goes, as before");
  // Within a tier, idle longest.
  const twins = [link("unhelpful-40s", { idle: 40_000 }), link("unhelpful-70s", { idle: 70_000 }), link("serving-99s", { idle: 99_000 })];
  assert.equal(rotationCandidate(twins, { ...POLICY, tier }, NOW).pubkey, "unhelpful-70s");
  // Ineligible links stay ineligible whatever their tier.
  const guarded = [link("unhelpful-sending", { idle: 80_000, transferring: true }), link("unhelpful-banned", { idle: 80_000 }),
    link("unhelpful-new", { age: 3_000, idle: 80_000 }), link("unhelpful-busy", { idle: 5_000 }), link("consumer-ok", { idle: 25_000 })];
  assert.equal(rotationCandidate(guarded, { ...POLICY, tier, banned: new Set(["unhelpful-banned"]) }, NOW).pubkey, "consumer-ok");
  assert.equal(rotationCandidate(guarded.slice(0, 4), { ...POLICY, tier, banned: new Set(["unhelpful-banned"]) }, NOW), null);
  // The tier function is consulted only for links that pass the filters.
  const seen = [];
  rotationCandidate(guarded, { ...POLICY, banned: new Set(["unhelpful-banned"]), tier: (value) => { seen.push(value.pubkey); return 0; } }, NOW);
  assert.deepEqual(seen, ["consumer-ok"]);
});

test("a refused newcomer is told when coming back is worth it", () => {
  // Nothing rotatable for another 12s, and nothing is more urgent than that.
  const soon = retryAfterFor([link("young", { age: 3_000, idle: 3_000 })], POLICY, 0, NOW);
  assert.equal(soon, 17_000, "wait until the youngest link is old enough and idle enough");

  // A viewer that has just rotated somebody out waits out its churn budget.
  const churning = retryAfterFor([link("idle", { idle: 90_000 })], POLICY, NOW - 2_000, NOW);
  assert.equal(churning, 8_000);

  // Clamped at both ends: never a spin, never parked for ever.
  assert.equal(retryAfterFor([link("ready", { idle: 90_000 })], POLICY, 0, NOW), POLICY.retryFloorMs);
  assert.equal(retryAfterFor([link("forever", { age: 1, idle: 1 })], { ...POLICY, minLinkLifeMs: 10 ** 7 }, 0, NOW), POLICY.retryCeilingMs);
});

test("a refusal from another peer is believed only within bounds", () => {
  const key = "a".repeat(64);
  assert.deepEqual(readRefusal({ retryAfterMs: 9_000, referrals: [key] }, POLICY), { retryAfterMs: 9_000, referrals: [key] });
  assert.equal(readRefusal({ retryAfterMs: 5_000_000 }, POLICY).retryAfterMs, POLICY.retryCeilingMs, "a peer cannot park us");
  assert.equal(readRefusal({ retryAfterMs: 1 }, POLICY).retryAfterMs, POLICY.retryFloorMs, "a peer cannot make us spin");
  assert.equal(readRefusal({}, POLICY).retryAfterMs, POLICY.retryFloorMs);
  assert.equal(readRefusal(null, POLICY).retryAfterMs, POLICY.retryFloorMs);
  assert.deepEqual(readRefusal({ referrals: ["nope", 42, key, key, key] }, POLICY).referrals, [key, key], "junk out, and no more than the cap");
});

test("a receive-only viewer never offers to serve", () => {
  const base = { swarmId: "swarm-abcdefgh", relays: ["wss://relay.example"], RTCPeerConnectionImpl: FakePeerConnection };
  const serving = createHlsSwarm({ ...base, serve: true });
  assert.equal(serving.metrics().serving, true);
  assert.equal(serving.metrics().config.serve, true);
  const receiveOnly = createHlsSwarm({ ...base, serve: false });
  assert.equal(receiveOnly.metrics().serving, false);
  assert.equal(receiveOnly.metrics().config.serve, false);
  assert.equal(receiveOnly.metrics().mode, "shadow", "receive-only still races peers");
  serving.stop();
  receiveOnly.stop();
});

test("session upload allowances validate safe integers and retain receive-only defaults", () => {
  const base = { swarmId: "swarm-abcdefgh", relays: ["wss://relay.example"], RTCPeerConnectionImpl: FakePeerConnection };
  for (const limit of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "32", null, 1n, Symbol("allowance"), { valueOf() { throw new Error("must not coerce host input"); } }]) {
    const swarm = createHlsSwarm({ ...base, maxUploadBytesPerSession: limit });
    assert.equal(swarm.metrics().disabledReason, "invalid-upload-session-limit");
    assert.doesNotThrow(() => JSON.stringify(swarm.metrics()), "invalid allowance types leave serialisable disabled metrics");
    swarm.stop();
  }
  for (const limit of [undefined, 0, 32, Number.MAX_SAFE_INTEGER]) {
    const swarm = createHlsSwarm({ ...base, serve: true, maxUploadBytesPerSession: limit });
    assert.equal(swarm.metrics().disabledReason, null);
    assert.equal(swarm.metrics().config.maxUploadBytesPerSession, limit ?? null);
    assert.equal(swarm.metrics().bytes.uploadRemaining, limit ?? null);
    assert.equal(swarm.metrics().bytes.uploadExhausted, limit === 0);
    assert.equal(swarm.metrics().serving, limit !== 0);
    swarm.stop();
  }
  const receiveOnly = createHlsSwarm({ ...base, maxUploadBytesPerSession: 32 });
  assert.equal(receiveOnly.metrics().serving, false);
  assert.equal(receiveOnly.metrics().bytes.uploadRemaining, 32);
  receiveOnly.stop();
});

test("peer selection ranks measured completion and payload rate, penalises failures, and filters eligibility", () => {
  const policy = new PeerSelection();
  const candidate = (pubkey) => ({ pubkey, have: new Set([KEY]), busy: false, closed: false });
  const slow = candidate("slow"), fast = candidate("fast"), failing = candidate("failing");
  policy.record(slow, 300, 1000);
  policy.record(fast, 40, 1000);
  for (let i = 0; i < 16; i++) policy.record(failing, 1);
  assert.equal(policy.select([slow, failing, fast], KEY, new Set(), 1000), fast);
  assert.equal(policy.select([slow, fast], KEY, new Set(["fast"]), 1000), slow);
  fast.busy = true;
  assert.equal(policy.select([fast], KEY, new Set(), 1000), null);
  fast.busy = false; fast.closed = true;
  assert.equal(policy.select([fast], KEY, new Set(), 1000), null);
  // Equal small-object completion times can conceal very different rates.
  const highRate = candidate("high-rate"), lowRate = candidate("low-rate");
  policy.record(highRate, 40, 100_000); policy.record(lowRate, 40, 1000);
  assert.equal(policy.select([lowRate, highRate], KEY, new Set(), 100_000), highRate);
  for (let i = 0; i < 1000; i++) policy.record(fast, 20, 1000);
  assert.equal(policy.summary(fast).attempts, 32, "measurements retain bounded scalar state");
});

test("peer selection reports the time the fastest recent completion at least as large needs, across links", () => {
  const policy = new PeerSelection();
  const first = { pubkey: "first", have: new Set([KEY]) }, second = { pubkey: "second", have: new Set([KEY]) };
  assert.equal(policy.minimumMs(100_000), 0, "no completed transfer gives no floor");
  policy.record(first, 900);
  assert.equal(policy.minimumMs(100_000), 0, "a failure is not a completion");
  policy.record(first, 100, 10_000);
  assert.equal(policy.minimumMs(100_000), 0, "a smaller completion never constrains a larger request");
  assert.equal(policy.minimumMs(10_000), 100);
  policy.record(first, 400, 100_000);
  policy.record(second, 200, 100_000);
  assert.equal(policy.minimumMs(100_000), 200, "the fastest large completion on any link sets the floor");
  assert.equal(policy.minimumMs(10_000), 20, "a larger completion's rate also bounds a smaller request");
  assert.equal(policy.minimumMs(100_001), 0);
  assert.equal(policy.minimumMs(0), 0);
  for (let i = 0; i < 16; i++) policy.record(first, 1000, 100_000);
  assert.equal(policy.minimumMs(100_000), 1000, "only the last 16 completions count");
});

test("peer selection projects a transfer from completions, else from rates after first byte", () => {
  const policy = new PeerSelection();
  const link = { pubkey: "link", have: new Set([KEY]) };
  assert.equal(policy.projectMs(100_000), null, "no evidence gives no projection");
  assert.equal(policy.firstByteMs(), null);
  policy.observe({ firstByteMs: 200, bytes: 1000, flowMs: 1000 });
  assert.equal(policy.firstByteMs(), 200);
  assert.equal(policy.projectMs(100_000), null, "a flow under 32 KiB measures the first round trip, not the path");
  policy.observe({ firstByteMs: 300, bytes: 64 * 1024, flowMs: 200 });
  assert.equal(policy.projectMs(100_000), null, "a flow under 300 ms is not a rate");
  assert.equal(policy.lastObservedAt, 0);
  policy.observe({ firstByteMs: 250, bytes: 50_000, flowMs: 500 });
  assert.ok(policy.lastObservedAt > 0);
  assert.equal(policy.firstByteMs(), 250, "median recent first byte");
  assert.equal(policy.projectMs(100_000), 250 + 1000, "first byte plus size at the median rate");
  policy.record(link, 400, 100_000);
  assert.equal(policy.projectMs(100_000), 400, "a completion at least as large includes its first byte and wins");
  assert.equal(policy.projectMs(200_000), 250 + 2000, "a smaller completion never projects a larger transfer");
  assert.equal(policy.projectMs(0), null);
  for (const rate of [50, 60, 200]) policy.observe({ bytes: rate * 1000, flowMs: 1000 });
  assert.equal(policy.rate(), 200, "the upper quartile of recent rates, not the median");
  assert.equal(policy.projectMs(200_000), 250 + 1000);
  for (let i = 0; i < 16; i++) policy.observe({ firstByteMs: 100 });
  assert.equal(policy.firstByteMs(), 100, "only the last 16 first bytes count");
  const flows = new PeerSelection();
  flows.observe({ firstByteMs: 300, bytes: 40_000, flowMs: 400 });
  for (const rate of [300, 400]) flows.observe({ firstByteMs: 300, bytes: rate * 400, flowMs: 400, totalFlowMs: 2000 });
  for (let i = 0; i < 4; i++) flows.observe({ firstByteMs: 300, bytes: 40_000, flowMs: 400 });
  assert.equal(flows.rate(), 400, "flows of three first-byte times or more decide once two exist");
  const short = new PeerSelection();
  short.observe({ firstByteMs: 300, bytes: 400 * 400, flowMs: 400, totalFlowMs: 2000 });
  for (let i = 0; i < 4; i++) short.observe({ firstByteMs: 300, bytes: 40_000, flowMs: 400 });
  assert.equal(short.rate(), 100, "one long flow is not enough to set aside the rest");
});

test("instant failures cannot make a previously quick peer outrank a healthy measured peer", () => {
  const policy = new PeerSelection();
  const failed = { pubkey: "failed", have: new Set([KEY]) }, healthy = { pubkey: "healthy", have: new Set([KEY]) };
  policy.record(failed, 1, 1000); policy.record(healthy, 20, 1000);
  policy.record(failed, 1);
  for (let i = 0; i < 8; i++) assert.equal(policy.select([failed, healthy], KEY, new Set(), 1000), healthy);
  healthy.busy = true;
  assert.equal(policy.select([failed, healthy], KEY, new Set(), 1000), failed, "the failed peer remains retryable when no healthy link is free");
  policy.record(failed, 2, 1000); healthy.busy = false;
  assert.equal(policy.select([failed, healthy], KEY, new Set(), 1000), failed, "verified recovery restores normal ranking");
});

test("cold eligible links get fair exploration without displacing measured peers on every choice", () => {
  const policy = new PeerSelection();
  const candidates = ["known", "cold-a", "cold-b"].map((pubkey) => ({ pubkey, have: new Set([KEY]) }));
  policy.record(candidates[0], 20, 1000);
  const choices = Array.from({ length: 8 }, () => policy.select(candidates, KEY, new Set(), 1000).pubkey);
  assert.deepEqual(choices, ["cold-a", "known", "known", "known", "cold-b", "known", "known", "known"]);
});

test("a gated viewer dials only peers whose ticket the host page admits", async () => {
  const relay = await startLocalRelay();
  const swarms = [];
  const admitted = [];
  const join = (options) => {
    const swarm = createHlsSwarm({
      swarmId: "swarm-abcdefgh",
      relays: [relay.url],
      serve: true,
      shadowSampleRate: 1,
      RTCPeerConnectionImpl: FakePeerConnection,
      presenceIntervalMs: 200,
      ...options,
    });
    swarm.attach({ config: { loader: FakeLoader } });
    swarms.push(swarm);
    return swarm;
  };
  const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    const gated = join({
      ticket: "good",
      admit: async (pubkey, ticket) => {
        admitted.push(ticket);
        return ticket === "good";
      },
    });
    join({ ticket: "forged" });
    join({});
    await settle(2_500);
    assert.equal(gated.metrics().peers.dialsStarted, 0, "no dial to a peer with a bad or missing ticket");
    assert.ok(gated.metrics().peers.admitRefused >= 2, "both were refused");
    assert.equal(gated.metrics().config.admit, true);
    assert.ok(!admitted.includes(undefined), "a missing ticket never reaches the host page's check");

    join({ ticket: "good" });
    await settle(2_500);
    assert.ok(gated.metrics().peers.dialsStarted >= 1, "a ticket holder is dialled");
  } finally {
    for (const swarm of swarms) swarm.stop();
    await relay.close();
  }
});


test("ABR-sized objects avoid measured peers that cannot meet the playback deadline", () => {
  const policy = new PeerSelection();
  const candidate = (pubkey) => ({ pubkey, have: new Set([KEY]), busy: false, closed: false });
  const smallFast = candidate("small-fast"), largeFast = candidate("large-fast"), cold = candidate("cold");
  policy.record(smallFast, 10, 1000); policy.record(largeFast, 40, 100_000);
  assert.equal(policy.select([smallFast, largeFast], KEY, new Set(), 100_000, 100), largeFast);
  assert.equal(policy.select([smallFast], KEY, new Set(), 100_000, 100), null);
  assert.equal(policy.select([cold, largeFast], KEY, new Set(), 100_000, 90), largeFast, "short playback budgets prefer observed delivery over exploration");
});

// These regressions exercise the real swarm, signed presence and encrypted
// signalling over the existing local relay. Only native WebRTC is replaced.
async function admissionEventually(predicate, message, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function admissionDeferred() {
  const state = { settled: false };
  state.promise = new Promise(done => { state.resolve = value => { state.settled = true; done(value); }; });
  return state;
}
async function rememberedAdmissionFixture(t, { phase = null, admit, ...options } = {}) {
  const relay = await startLocalRelay(), connections = [], offers = [], trace = [];
  const entered = admissionDeferred(), release = admissionDeferred();
  class AdmissionChannel extends EventTarget {
    readyState = "connecting";
    close() { this.readyState = "closed"; }
  }
  class AdmissionConnection extends EventTarget {
    iceGatheringState = phase === "gather" ? "gathering" : "complete";
    iceConnectionState = "new";
    connectionState = "new";
    signalingState = "stable";
    localDescription = null;
    closes = 0;
    constructor() { super(); connections.push(this); trace.push("allocate"); }
    addEventListener(name, listener, options) {
      super.addEventListener(name, listener, options);
      // This is the actual gathered() listener, installed after local SDP.
      if (phase === "gather" && name === "icegatheringstatechange" && this.localDescription) entered.resolve();
    }
    createDataChannel() { this.channel = new AdmissionChannel(); return this.channel; }
    async createOffer() {
      if (phase === "createOffer") { entered.resolve(); await release.promise; }
      return { type: "offer", sdp: "v=0\r\na=fixture-offer\r\n" };
    }
    async setLocalDescription(description) {
      if (phase === "setLocalDescription") { entered.resolve(); await release.promise; }
      this.localDescription = description; this.signalingState = "have-local-offer";
    }
    close() { this.closes++; this.connectionState = "closed"; }
  }
  const swarmId = "remembered-admission-fixture";
  const swarm = createHlsSwarm({ swarmId, relays: [relay.url], ticket: "own-ticket", shadowSampleRate: 0,
    RTCPeerConnectionImpl: AdmissionConnection, ...options,
    admit: async (_pubkey, ticket, context) => {
      trace.push(`check:${ticket}:start`);
      const allowed = await admit(ticket, context, connections.length);
      trace.push(`check:${ticket}:${allowed ? "accepted" : "refused"}`);
      return allowed;
    } });
  const pool = new RelayPool([relay.url]);
  const peer = new RelaySwarmSession({ pool, swarmId });
  const witness = new RelaySwarmSession({ pool, swarmId });
  const seen = new Set(); let announcement = 0;
  t.after(async () => {
    swarm.stop(); release.resolve(); peer.close(); witness.close(); pool.close(); await relay.close();
  });
  swarm.attach({ config: { loader: FakeLoader } });
  await pool.connect(); peer.start(); witness.start();
  await admissionEventually(() => swarm.metrics().pubkey, "swarm did not start");
  peer.onSignal(({ payload }) => {
    if (payload.type === "offer") { offers.push(payload); trace.push("offer"); }
  });
  witness.onPresence(({ from, payload }) => { if (from === peer.pubkey) seen.add(payload.ticket); });
  const announce = ticket => peer.announcePresence({ role: "viewer", ticket, open: true,
    transports: [{ type: "webrtc", publicKey: peer.pubkey }],
    have: [(++announcement).toString(16).padStart(64, "0")] });
  return { swarm, peer, trace, offers, connections, seen, announce, entered,
    release() {
      release.resolve();
      if (phase === "gather") {
        const pc = connections[0]; pc.iceGatheringState = "complete";
        pc.dispatchEvent(new Event("icegatheringstatechange"));
      }
    } };
}

test("remembered admission checks a blocked renewal before allocating the retry PC", async t => {
  for (const accepted of [true, false]) await t.test(accepted ? "renewal accepted" : "renewal refused", async t => {
    let currentAllowed = true;
    const checks = [];
    const f = await rememberedAdmissionFixture(t, { retryFloorMs: 1_000, retryCeilingMs: 1_000, maxRetriesPerPeer: 1,
      admit(ticket, _context, allocated) {
        checks.push({ ticket, allocated });
        return ticket === "B" ? accepted : ticket === "A" && currentAllowed;
      } });
    f.announce("A");
    await admissionEventually(() => f.offers.length === 1, "initial A offer was not sent");
    f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "reject", transport: "webrtc",
      requestId: f.offers[0].requestId, payload: { retryAfterMs: 1_000 } });
    await admissionEventually(() => f.swarm.metrics().peers.dialsRejected === 1, "initial dial was not rejected");
    currentAllowed = false;
    const before = checks.length;
    f.announce("B");
    await admissionEventually(() => f.seen.has("B"), "signed renewed presence did not reach the local relay witness");
    assert.equal(checks.length, before, "an inactive cooling peer must not trigger a presence admission request");
    assert.equal(f.connections.length, 1);
    await admissionEventually(() => checks.some(row => row.ticket === "B"), "scheduled retry did not check the remembered renewal");
    assert.deepEqual(checks[before], { ticket: "B", allocated: 1 }, "renewal must be checked before a replacement PC exists");
    if (accepted) {
      await admissionEventually(() => f.offers.length === 2, "authorised renewal did not reach an outgoing offer");
      assert.equal(f.connections.length, 2);
      assert.ok(f.trace.lastIndexOf("check:B:accepted") < f.trace.lastIndexOf("offer"));
    } else {
      await admissionEventually(() => f.swarm.metrics().peers.admitRefused === 1, "renewal refusal was not recorded");
      assert.equal(f.connections.length, 1, "a refused candidate cannot allocate a retry PC");
      assert.equal(f.offers.length, 1, "a refused candidate cannot disclose another SDP");
    }
    assert.equal(f.connections[0].closes, 1);
  });
});

test("remembered admission lets a later eligible presence supersede a blocked renewal", async t => {
  const checks = [];
  const f = await rememberedAdmissionFixture(t, { retryFloorMs: 1_000, retryCeilingMs: 1_000, maxRetriesPerPeer: 0,
    admit(ticket) { checks.push(ticket); return ticket === "A" || ticket === "C"; } });
  f.announce("A");
  await admissionEventually(() => f.offers.length === 1, "initial A offer was not sent");
  f.peer.sendSignal(f.swarm.metrics().pubkey, { type: "reject", transport: "webrtc",
    requestId: f.offers[0].requestId, payload: { retryAfterMs: 1_000 } });
  await admissionEventually(() => f.swarm.metrics().peers.dialsRejected === 1, "initial dial was not rejected");
  const before = checks.length;
  f.announce("B");
  await admissionEventually(() => f.seen.has("B"), "blocked renewal did not reach the relay witness");
  assert.equal(checks.length, before, "cooldown must not trigger an eager admission check");
  await new Promise(resolve => setTimeout(resolve, 1_050));
  f.announce("C");
  await admissionEventually(() => f.offers.length === 2, "the later authorised presence did not permit another offer");
  assert.ok(checks.slice(before).length >= 3, "C is checked on presence, before allocation and before SDP");
  assert.ok(checks.slice(before).every(ticket => ticket === "C"), "a superseded candidate must not replace the latest verified ticket");
  assert.equal(f.connections.length, 2);
  assert.equal(f.swarm.metrics().peers.admitRefused, 0);
});

test("remembered admission verifies a renewal arriving during each native offer phase before SDP", async t => {
  for (const phase of ["createOffer", "setLocalDescription", "gather"]) await t.test(phase, async t => {
    const renewed = admissionDeferred(); let enteredRenewal = false;
    const f = await rememberedAdmissionFixture(t, { phase,
      admit(ticket) { if (ticket === "B") { enteredRenewal = true; return renewed.promise; } return ticket === "A"; } });
    t.after(() => renewed.resolve(false));
    f.announce("A");
    await admissionEventually(() => f.connections.length === 1, "initial PC was not allocated");
    await admissionEventually(() => f.entered.settled, "native offer phase was not reached");
    f.announce("B");
    await admissionEventually(() => enteredRenewal, "changed presence was not checked during the native operation");
    f.release();
    // Drain the released native continuation while its actual host check is
    // still pending. No fake time, private swarm state or native PC is used.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.offers.length, 0);
    assert.equal(f.swarm.metrics().relays.signalsSent, 0);
    renewed.resolve(true);
    await admissionEventually(() => f.offers.length === 1, "verified renewal did not permit the offer");
    assert.equal(f.connections.length, 1, "renewal must not replace the pending native connection");
    assert.ok(f.trace.lastIndexOf("check:B:accepted") < f.trace.indexOf("offer"));
    assert.equal(f.swarm.metrics().peers.admitRefused, 0);
  });
});

test("remembered admission refuses both a rejected renewal and revoked current ticket before SDP", async t => {
  for (const phase of ["createOffer", "setLocalDescription", "gather"]) await t.test(phase, async t => {
    let currentAllowed = true;
    const f = await rememberedAdmissionFixture(t, { phase,
      admit(ticket) { return ticket === "A" && currentAllowed; } });
    f.announce("A");
    await admissionEventually(() => f.connections.length === 1, "initial PC was not allocated");
    await admissionEventually(() => f.entered.settled, "native offer phase was not reached");
    currentAllowed = false;
    f.announce("B");
    await admissionEventually(() => f.swarm.metrics().peers.admitRefused === 1, "invalid renewal was not refused");
    assert.equal(f.connections.length, 1);
    assert.equal(f.offers.length, 0);
    f.release();
    await admissionEventually(() => f.swarm.metrics().peers.dialsFailed === 1, "revoked current authority did not fail the pending dial");
    assert.ok(f.trace.includes("check:B:refused"));
    assert.ok(f.trace.includes("check:A:refused"), "rejecting an untrusted renewal cannot turn stale A into approval");
    assert.equal(f.swarm.metrics().peers.admitRefused, 2);
    assert.equal(f.swarm.metrics().relays.signalsSent, 0);
    assert.equal(f.offers.length, 0);
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].closes, 1);
    assert.equal(f.swarm.metrics().peers.connected, 0);
  });
});

test("origin loads populate signalling.clock.origin from the Date header, in both modes", async () => {
  const date = new Date(Date.now() + 42_000).toUTCString();
  class DatedLoader extends FakeLoader {
    load(context, config, callbacks) {
      const data = new Uint8Array(1024).fill(1).buffer;
      const details = { getResponseHeader: (name) => name === "Date" ? date : null };
      callbacks.onSuccess({ url: context.url, data }, this.stats, context, details);
    }
  }
  for (const mode of ["shadow", "peer-first"]) {
    const relay = await startLocalRelay();
    const swarm = createHlsSwarm({ swarmId: "swarm-abcdefgh", relays: [relay.url], mode, shadowSampleRate: 1, originFallbackMs: 0, RTCPeerConnectionImpl: FakePeerConnection, segmentKey: (url) => new URL(url).pathname });
    try {
      assert.deepEqual(swarm.metrics().signalling.clock.origin, { samples: 0, offsetSeconds: null });
      if (swarm.metrics().mode !== mode) continue; // peer-first needs signed-stream options; shadow is the end-to-end case
      const hls = { config: { loader: DatedLoader } };
      swarm.attach(hls);
      new hls.config.fLoader({}).load(fragmentContext("https://origin.example/live/seg1.ts"), {}, { onSuccess() {}, onError() {}, onTimeout() {} });
      const origin = swarm.metrics().signalling.clock.origin;
      assert.equal(origin.samples, 1);
      assert.ok(origin.offsetSeconds >= 41 && origin.offsetSeconds <= 42);
      assert.equal(swarm.metrics().relays.sinceDropped, 0);
      assert.equal(swarm.metrics().relays.rejectedTimestamp, 0);
    } finally { swarm.stop(); await relay.close?.(); }
  }
});
