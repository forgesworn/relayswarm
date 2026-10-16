import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createOfferBarrier, attachNativeGlareRelay } from "./support/native-glare-relay.mjs";

const peers = ["a".repeat(64), "b".repeat(64)];
const event = (slot, id = String(slot)) => ({ id, pubkey: peers[slot], tags: [["p", peers[1 - slot]]], content: "opaque-original" });
const witness = () => ({ pcCount: 1, offerInstalled: 1, offerSent: 1, signalsReceived: 0,
  signalingState: "have-local-offer", remainingDialMs: 5000, authorityFresh: true, stopped: false });

test("both opaque original envelopes remain withheld until the native offer barrier", () => {
  const delivered = [], barrier = createOfferBarrier({ peers, deliver: value => delivered.push(value) });
  const first = event(0), second = event(1);
  barrier.accept(first); barrier.accept(second); barrier.accept(first);
  assert.deepEqual(delivered, []); assert.equal(barrier.snapshot().held, 2);
  barrier.release([witness(), witness()]);
  assert.strictEqual(delivered[0], first); assert.strictEqual(delivered[1], second);
  assert.equal(barrier.snapshot().held, 0); assert.equal(barrier.snapshot().forwardedEvents, 2);
  assert.equal(barrier.accept(first), false);
  const answer = event(1, "answer"); barrier.accept(answer); assert.strictEqual(delivered[2], answer);
  barrier.close(); assert.throws(() => barrier.accept(event(0, "closed")));
});

test("the barrier refuses incomplete, stale, recreated or already answered native witnesses", () => {
  for (const change of [{ pcCount: 2 }, { offerInstalled: 0 }, { offerSent: 0 }, { signalsReceived: 1 },
    { signalingState: "closed" }, { remainingDialMs: 0 }, { authorityFresh: false }, { stopped: true }]) {
    const delivered = [], barrier = createOfferBarrier({ peers, deliver: value => delivered.push(value) });
    barrier.accept(event(0)); barrier.accept(event(1));
    assert.throws(() => barrier.release([witness(), { ...witness(), ...change }]));
    assert.equal(delivered.length, 0); assert.equal(barrier.snapshot().failed, true); barrier.close();
  }
});

test("original hold expiry, extra signals and wrong routing fail without any release", () => {
  for (const mode of ["expiry", "extra", "route", "incomplete"]) {
    let at = 0; const delivered = [];
    const barrier = createOfferBarrier({ peers, clock: () => at, deliver: value => delivered.push(value) });
    barrier.accept(event(0));
    if (mode === "expiry") { barrier.accept(event(1)); at = 6000; }
    else if (mode !== "incomplete") {
      assert.throws(() => barrier.accept(mode === "extra" ? event(0, "extra") : { ...event(1), tags: [["p", peers[1]]] }));
    }
    assert.throws(() => barrier.release([witness(), witness()]));
    assert.deepEqual(delivered, []); barrier.close();
  }
});

test("released signal deduplication remains bounded and snapshots contain no raw identities or content", () => {
  const barrier = createOfferBarrier({ peers, deliver() {} });
  barrier.accept(event(0)); barrier.accept(event(1)); barrier.release([witness(), witness()]);
  for (let i = 0; i < 6; i++) barrier.accept(event(0, `later-${i}`));
  assert.throws(() => barrier.accept(event(0, "overflow")));
  const snapshot = JSON.stringify(barrier.snapshot());
  assert.ok(!snapshot.includes(peers[0]) && !snapshot.includes("opaque-original") && !snapshot.includes("later"));
  barrier.close();
});

test("a released barrier no longer imposes the six-second hold deadline on normal signals", () => {
  let at = 0; const delivered = [];
  const barrier = createOfferBarrier({ peers, clock: () => at, deliver: value => delivered.push(value) });
  barrier.accept(event(0)); barrier.accept(event(1)); barrier.release([witness(), witness()]);
  at = 6001; const answer = event(1, "normal-answer"); barrier.accept(answer);
  assert.strictEqual(delivered[2], answer); barrier.close();
});

test("actual relay routing keeps signed initial signals out of REQ replay and bounds the complete output enqueue", async () => {
  let transport;
  class Transport extends EventEmitter {
    clients = new Set();
    constructor() { super(); transport = this; }
    close(done) { done(); }
  }
  class Socket extends EventEmitter {
    OPEN = 1; readyState = 1; bufferedAmount = 0; frames = []; terminated = false;
    send(value) { this.frames.push(JSON.parse(value)); }
    terminate() { this.terminated = true; this.readyState = 3; }
    close() { this.terminate(); }
  }
  const secrets = [generateSecretKey(), generateSecretKey()], keys = secrets.map(getPublicKey), server = new EventEmitter();
  const relay = attachNativeGlareRelay(server, { swarmId: "glare-test", origin: () => "http://fixture.invalid", admit: (_key, ticket) => ticket === "ticket", WebSocketServerImpl: Transport });
  relay.setPeers(keys);
  const sockets = keys.map(() => { const socket = new Socket(); transport.clients.add(socket); transport.emit("connection", socket); return socket; });
  const send = (slot, frame) => sockets[slot].emit("message", Buffer.from(JSON.stringify(frame)));
  const signed = (slot, kind, content, tags = []) => finalizeEvent({ kind, content, tags: [["x", "glare-test"], ...tags], created_at: Math.floor(Date.now() / 1000) }, secrets[slot]);
  try {
    for (let slot = 0; slot < 2; slot++) {
      send(slot, ["REQ", "initial", { kinds: [24171], "#x": ["glare-test"], "#p": [keys[slot]] }]);
      send(slot, ["EVENT", signed(slot, 24170, JSON.stringify({ v: 3, ticket: "ticket" }))]);
    }
    const offers = keys.map((_, slot) => signed(slot, 24171, `opaque-${slot}`, [["p", keys[1 - slot]]]));
    offers.forEach((offer, slot) => send(slot, ["EVENT", offer]));
    send(0, ["REQ", "replay", { kinds: [24171], "#x": ["glare-test"], "#p": [keys[0]] }]);
    assert.ok(sockets.every(socket => socket.frames.every(frame => frame[0] !== "EVENT")));
    relay.release([witness(), witness()]);
    const delivered = sockets.flatMap(socket => socket.frames.filter(frame => frame[0] === "EVENT").map(frame => frame[2]));
    assert.ok(delivered.length >= 2); assert.ok(delivered.every(value => offers.some(offer => JSON.stringify(offer) === JSON.stringify(value))));
    const before = sockets[0].frames.length;
    sockets[0].bufferedAmount = 1024 * 1024 - 1;
    send(0, ["REQ", "bounded", { kinds: [24171], "#x": ["glare-test"], "#p": [keys[0]] }]);
    assert.equal(sockets[0].frames.length, before); assert.equal(sockets[0].terminated, true); assert.equal(relay.snapshot().failed, true);
    assert.equal(relay.snapshot().relayFailed, true); assert.equal(relay.snapshot().barrierFailed, false);
  } finally { await relay.close(); }
  assert.equal(server.listenerCount("upgrade"), 0);
});
