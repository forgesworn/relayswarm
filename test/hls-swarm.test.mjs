// The guarantees a host page relies on, checked without a browser: the swarm
// never throws at the host, never alters what the player receives, restores
// the loader on stop, and the link protocol rejects what it should.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";

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
  assert.equal(peerFirst.metrics().disabledReason, "peer-first-not-available");
  const hls = { config: { loader: FakeLoader } };
  peerFirst.attach(hls);
  assert.equal(hls.config.fLoader, undefined, "a disabled swarm leaves the player alone");
});

test("shadow mode hands the player its bytes untouched and restores the loader on stop", async () => {
  const relay = await startLocalRelay();
  try {
    const swarm = createHlsSwarm({
      swarmId: "swarm-abcdefgh",
      relays: [relay.url],
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

    await new Promise((resolve) => setTimeout(resolve, 200));
    const metrics = swarm.metrics();
    assert.equal(metrics.segments.originLoaded, 1);
    assert.equal(metrics.errors.byStage["begin-race"], 1, "the host page's bug is counted, not thrown");
    assert.equal(metrics.bytes.held, 4096);

    swarm.stop();
    assert.equal(hls.config.fLoader, undefined, "stop restores the original fragment loader");
    assert.equal(swarm.metrics().stopped, true);
    assert.equal(swarm.metrics().bytes.held, 0);
  } finally {
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
  const serving = createHlsSwarm(base);
  assert.equal(serving.metrics().serving, true);
  assert.equal(serving.metrics().config.serve, true);
  const receiveOnly = createHlsSwarm({ ...base, serve: false });
  assert.equal(receiveOnly.metrics().serving, false);
  assert.equal(receiveOnly.metrics().config.serve, false);
  assert.equal(receiveOnly.metrics().mode, "shadow", "receive-only still races peers");
  serving.stop();
  receiveOnly.stop();
});

test("a gated viewer dials only peers whose ticket the host page admits", async () => {
  const relay = await startLocalRelay();
  const swarms = [];
  const admitted = [];
  const join = (options) => {
    const swarm = createHlsSwarm({
      swarmId: "swarm-abcdefgh",
      relays: [relay.url],
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
