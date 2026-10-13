import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { publisherStreamEvent } from "../src/publisher-state.mjs";
import { createPublisherAdvertisement, verifyPublisherAdvertisement } from "../src/publisher-advertisement.mjs";
const seconds = 1800000000, now = () => seconds * 1000, key = generateSecretKey();
const streamEvent = publisherStreamEvent(key, "/media/master.m3u8", () => (seconds - 10000) * 1000);
const base = { secretKey: key, streamEvent, swarmId: "advertisement-test-swarm", manifestUrl: "https://media.example/media/master.m3u8", relays: ["wss://relay.example"], now };

test("live and ended advertisements have a separate stable address and retain the commitment authorisation id", () => {
  const live = createPublisherAdvertisement(base);
  assert.ok(verifyPublisherAdvertisement(live, base));
  assert.equal(live.tags.find((tag) => tag[0] === "relayswarm-authorisation")[1], streamEvent.id);
  assert.notEqual(live.tags.find((tag) => tag[0] === "d")[1], streamEvent.tags.find((tag) => tag[0] === "d")[1]);
  const ended = createPublisherAdvertisement({ ...base, status: "ended", starts: seconds - 40, previousEvent: live });
  assert.ok(verifyPublisherAdvertisement(ended, base));
  assert.equal(ended.created_at, live.created_at + 1);
  assert.equal(ended.tags.find((tag) => tag[0] === "d")[1], live.tags.find((tag) => tag[0] === "d")[1]);
  assert.equal(ended.tags.find((tag) => tag[0] === "ends")[1], String(seconds));
  assert.ok(verifyPublisherAdvertisement(live, base), "stable old authorisation has no freshness deadline");
});

test("advertisements require the author and explicit HTTPS/WSS endpoints, with loopback opt-in only", () => {
  assert.throws(() => createPublisherAdvertisement({ ...base, secretKey: generateSecretKey() }), /author/u);
  for (const manifestUrl of ["http://media.example/master.m3u8", "https://user:password@media.example/master.m3u8", "https://media.example/master.m3u8#fragment", "file:///secret"]) assert.throws(() => createPublisherAdvertisement({ ...base, manifestUrl }));
  assert.throws(() => createPublisherAdvertisement({ ...base, relays: ["ws://relay.example"] }));
  assert.throws(() => createPublisherAdvertisement({ ...base, expiresAt: seconds + 301 }));
  assert.throws(() => createPublisherAdvertisement({ ...base, starts: seconds + 1 }));
  const local = { ...base, manifestUrl: "http://127.0.0.1:8787/media/master.m3u8", relays: ["ws://127.0.0.1:8787/relay"], allowLoopback: true };
  assert.ok(verifyPublisherAdvertisement(createPublisherAdvertisement(local), local));
  assert.throws(() => createPublisherAdvertisement({ ...local, allowLoopback: false }));
  assert.throws(() => createPublisherAdvertisement({ ...local, manifestUrl: "http://192.168.1.2/media/master.m3u8" }));
});

test("external advertisement verification rejects tampering, stale updates and mismatched author scope", () => {
  const event = createPublisherAdvertisement(base);
  const cloned = verifyPublisherAdvertisement(event, base); cloned.tags[0][1] = "caller mutation";
  assert.ok(verifyPublisherAdvertisement(event, base));
  for (const override of [{ swarmId: "other-swarm" }, { manifestUrl: "https://media.example/media/other.m3u8" }, { relays: ["wss://different.example"] }, { now: () => (seconds + 301) * 1000 }]) assert.equal(verifyPublisherAdvertisement(event, { ...base, ...override }), null);
  const changed = structuredClone(event); changed.tags[1][1] += "?tampered";
  assert.equal(verifyPublisherAdvertisement(changed, base), null);
  const forged = finalizeEvent({ kind: event.kind, created_at: event.created_at, content: event.content, tags: event.tags }, generateSecretKey());
  assert.equal(verifyPublisherAdvertisement(forged, base), null);
});
