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
