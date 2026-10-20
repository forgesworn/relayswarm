import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { resolveTrustedStream, discoverTrustedStreams } from "../src/browser/stream-discovery.mjs";

const seconds = 1800000000;
const author = generateSecretKey(), other = generateSecretKey();
const baseTags = [["d", "show"], ["streaming", "https://media.example/live/master.m3u8"], ["status", "live"], ["relayswarm", "redistribute", "1"]];
function event({ tags = baseTags, created_at = seconds, kind = 30311, content = "", secretKey = author } = {}) {
  return finalizeEvent({ kind, created_at, tags: structuredClone(tags), content }, secretKey);
}
function policy(overrides = {}) {
  return { trustedAuthors: [getPublicKey(author)], allowedMediaOrigins: ["https://media.example"], relays: ["wss://relay.host.example"],
    swarmId: "host-selected-swarm", now: () => seconds * 1000, ...overrides };
}
function replacedTags(name, value) { return baseTags.map((tag) => tag[0] === name ? [name, value] : tag); }

// Deliberately no sockets or fetches: both APIs use metadata and an explicit
// query callback whose relay implementation remains controlled by the host.
test("resolver returns host-selected configuration without network side effects", (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected fetch."); });
  t.mock.method(globalThis, "WebSocket", () => { throw new Error("Unexpected socket."); });
  const signed = event({ tags: [...baseTags, ["relays", "wss://event-selected.example"], ["ice", "stun:event-selected.example"]] });
  const descriptor = resolveTrustedStream(signed, policy());
  assert.equal(descriptor.manifestUrl, "https://media.example/live/master.m3u8");
  assert.equal(descriptor.streamEvent.id, signed.id);
  assert.equal(descriptor.swarmId, "host-selected-swarm");
  assert.deepEqual(descriptor.relays, ["wss://relay.host.example/"]);
  assert.deepEqual(descriptor.iceServers, []);
  assert.equal(descriptor.config.serve, false);
  assert.deepEqual(descriptor.config.relays, descriptor.relays);
  assert.notEqual(descriptor.streamEvent, signed);
});

test("resolver enforces explicit author trust and fresh cryptographic verification", () => {
  assert.equal(resolveTrustedStream(event({ secretKey: other }), policy()), null);
  const previouslySigned = event();
  previouslySigned.tags[1][1] = "https://media.example/tampered.m3u8";
  assert.equal(resolveTrustedStream(previouslySigned, policy()), null);
  const forged = event({ secretKey: other });
  forged.pubkey = getPublicKey(author);
  assert.equal(resolveTrustedStream(forged, policy()), null);
  assert.equal(resolveTrustedStream(event({ kind: 1 }), policy()), null);
  assert.throws(() => resolveTrustedStream(event(), policy({ trustedAuthors: [] })), /trusted authors/u);
  assert.throws(() => resolveTrustedStream(event(), policy({ trustedAuthors: ["npub1invalid"] })), /author/u);
});

test("resolver requires single identifiers, streaming, live status and redistribution consent", () => {
  for (const name of ["d", "streaming", "status", "relayswarm"]) {
    assert.equal(resolveTrustedStream(event({ tags: baseTags.filter((tag) => tag[0] !== name) }), policy()), null, name);
    assert.equal(resolveTrustedStream(event({ tags: [...baseTags, baseTags.find((tag) => tag[0] === name)] }), policy()), null, `duplicate ${name}`);
  }
  for (const tags of [replacedTags("status", "ended"), replacedTags("status", "planned"), replacedTags("d", ""),
    baseTags.map((tag) => tag[0] === "relayswarm" ? ["relayswarm", "redistribute", "0"] : tag),
    baseTags.map((tag) => tag[0] === "streaming" ? [...tag, "extra"] : tag)]) assert.equal(resolveTrustedStream(event({ tags }), policy()), null);
});

test("resolver allows only approved HTTPS origins and rejects credential, fragment and unsafe URLs", () => {
  for (const url of ["http://media.example/live.m3u8", "https://other.example/live.m3u8", "https://media.example.evil/live.m3u8", "https://media.example:8443/live.m3u8",
    "https://username:password@media.example/live.m3u8", "https://media.example/live.m3u8#fragment", "file:///private/secret", "data:application/x-mpegURL,abc",
    "//media.example/live.m3u8", "https://media.example\\@evil.example/live.m3u8", " https://media.example/live.m3u8", "http://127.0.0.1:3000/live.m3u8"]) {
    assert.equal(resolveTrustedStream(event({ tags: replacedTags("streaming", url) }), policy()), null, url);
  }
  assert.throws(() => resolveTrustedStream(event(), policy({ allowedMediaOrigins: [] })));
  assert.throws(() => resolveTrustedStream(event(), policy({ allowedMediaOrigins: ["https://media.example/path"] })), /origins/u);
  assert.throws(() => resolveTrustedStream(event(), policy({ allowedMediaOrigins: ["http://media.example"] })), /URL/u);
});

test("loopback HTTP and WS require explicit opt-in and exact allowed origin", () => {
  const signed = event({ tags: replacedTags("streaming", "http://127.0.0.1:3000/master.m3u8") });
  const options = policy({ allowedMediaOrigins: ["http://127.0.0.1:3000"], relays: ["ws://127.0.0.1:4000/relay"], allowLoopback: true });
  assert.equal(resolveTrustedStream(signed, options).manifestUrl, "http://127.0.0.1:3000/master.m3u8");
  assert.equal(resolveTrustedStream(event({ tags: replacedTags("streaming", "http://127.0.0.1:3001/master.m3u8") }), options), null);
  assert.throws(() => resolveTrustedStream(signed, { ...options, allowLoopback: false }));
  assert.throws(() => resolveTrustedStream(signed, policy({ allowLoopback: true, allowedMediaOrigins: ["http://192.168.1.5"] })));
});

test("host relay and ICE policies cannot be widened by event suggestions", () => {
  const iceServers = [{ urls: ["turns:turn.host.example:443?transport=tcp"], username: "host", credential: "private-host-credential" }];
  const descriptor = resolveTrustedStream(event({ tags: [...baseTags, ["relays", "ws://127.0.0.1/private"], ["stun", "stun:attacker.example"]] }), policy({ iceServers }));
  assert.deepEqual(descriptor.iceServers, iceServers);
  descriptor.iceServers[0].urls[0] = "stun:modified.example";
  assert.equal(iceServers[0].urls[0], "turns:turn.host.example:443?transport=tcp");
  assert.throws(() => resolveTrustedStream(event(), policy({ relays: [] })));
  assert.throws(() => resolveTrustedStream(event(), policy({ relays: ["ws://public.example"] })));
  assert.throws(() => resolveTrustedStream(event(), policy({ relays: ["wss://user:password@public.example"] })));
  assert.throws(() => resolveTrustedStream(event(), policy({ iceServers: [{ urls: "https://unwanted.example" }] })));
  assert.throws(() => resolveTrustedStream(event(), policy({ swarmId: undefined })));
});

test("resolver rejects stale, future, expired and already-ended live metadata", () => {
  assert.equal(resolveTrustedStream(event({ created_at: seconds - 3601 }), policy()), null);
  assert.equal(resolveTrustedStream(event({ created_at: seconds + 31 }), policy()), null);
  assert.ok(resolveTrustedStream(event({ created_at: seconds - 3599 }), policy()));
  assert.ok(resolveTrustedStream(event({ created_at: seconds + 30 }), policy()));
  for (const tag of [["expiration", String(seconds)], ["ends", String(seconds - 1)], ["starts", String(seconds + 31)], ["expiration", "invalid"]]) {
    assert.equal(resolveTrustedStream(event({ tags: [...baseTags, tag] }), policy()), null);
  }
  assert.ok(resolveTrustedStream(event({ tags: [...baseTags, ["starts", String(seconds - 5)], ["expiration", String(seconds + 30)]] }), policy()));
});

test("resolver bounds signed event sizes in bytes, including multibyte content", () => {
  assert.equal(resolveTrustedStream(event({ content: "x".repeat(17000) }), policy()), null);
  assert.equal(resolveTrustedStream(event({ content: "😀".repeat(4500) }), policy()), null);
  assert.equal(resolveTrustedStream({ ...event(), tags: Array.from({ length: 2049 }, () => ["t", "x"]) }, policy()), null);
});

test("discovery sends explicit bounded filters and selected relays to the host query", async () => {
  let received;
  const signed = event();
  const results = await discoverTrustedStreams({ ...policy(), query: async (input) => { received = input; return [signed]; } });
  assert.equal(results[0].streamEvent.id, signed.id);
  assert.deepEqual(received.relays, ["wss://relay.host.example/"]);
  assert.deepEqual(received.filters, [{ kinds: [30311], authors: [getPublicKey(author)], since: seconds - 3600, until: seconds + 30, limit: 256 }]);
  assert.equal(received.filters[0]["#status"], undefined);
  assert.equal(received.signal.aborted, true); // query lifecycle is complete
});

test("latest ended, withdrawn consent or unsafe manifest suppresses an older live update", async () => {
  const oldLive = event({ created_at: seconds - 10 });
  for (const latest of [event({ tags: [["d", "show"], ["status", "ended"]] }),
    event({ tags: baseTags.filter((tag) => tag[0] !== "relayswarm") }), event({ tags: replacedTags("streaming", "https://unsafe.example/live.m3u8") })]) {
    for (const values of [[oldLive, latest], [latest, oldLive]]) {
      assert.deepEqual(await discoverTrustedStreams({ ...policy(), query: async () => values }), []);
    }
  }
});

test("replaceable ties use lowest event id regardless of query order", async () => {
  const live = event(), ended = event({ tags: [["d", "show"], ["status", "ended"]] });
  const expected = live.id < ended.id ? [live.id] : [];
  for (const values of [[live, ended], [ended, live]]) {
    const results = await discoverTrustedStreams({ ...policy(), query: async () => values });
    assert.deepEqual(results.map((result) => result.streamEvent.id), expected);
  }
});

test("discovery ignores forged and untrusted updates and limits deterministically ordered results", async () => {
  const valid = Array.from({ length: 4 }, (_, index) => event({ created_at: seconds - index, tags: replacedTags("d", `show-${index}`) }));
  const forged = event({ created_at: seconds, tags: [["d", "show-0"], ["status", "ended"]] });
  forged.sig = "0".repeat(128);
  const untrusted = event({ secretKey: other });
  const results = await discoverTrustedStreams({ ...policy(), maxResults: 2, query: async () => [...valid.reverse(), forged, untrusted] });
  assert.deepEqual(results.map((result) => result.streamEvent.created_at), [seconds, seconds - 1]);
});

test("oversized events, count floods and total byte floods reject the complete discovery", async () => {
  await assert.rejects(discoverTrustedStreams({ ...policy(), query: async () => [event({ content: "x".repeat(17000) })] }), { code: "EVENT_LIMIT" });
  await assert.rejects(discoverTrustedStreams({ ...policy(), maxEvents: 1, query: async () => [event(), event()] }), { code: "EVENT_LIMIT" });
  await assert.rejects(discoverTrustedStreams({ ...policy(), maxTotalBytes: 1024, query: async () => [event(), event({ content: "second".repeat(50) })] }), { code: "EVENT_LIMIT" });
  let closed = false;
  async function* flood() { try { for (;;) yield event(); } finally { closed = true; } }
  await assert.rejects(discoverTrustedStreams({ ...policy(), maxEvents: 2, query: async () => flood() }), { code: "EVENT_LIMIT" });
  assert.equal(closed, true);
});

test("host query rejection and invalid responses propagate without connection defaults", async () => {
  await assert.rejects(discoverTrustedStreams({ ...policy(), query: async () => { throw new Error("Host query failed."); } }), /Host query failed/u);
  await assert.rejects(discoverTrustedStreams({ ...policy(), query: async () => ({}) }), /array or async iterable/u);
  await assert.rejects(discoverTrustedStreams(policy()), /query/u);
  await assert.rejects(discoverTrustedStreams({ ...policy(), query: async () => [], maxEvents: 1025 }), /count/u);
});

test("timeout aborts hanging host queries and ignores their later rejection", async () => {
  let received, rejectLater;
  await assert.rejects(discoverTrustedStreams({ ...policy(), timeoutMs: 15,
    query: ({ signal }) => { received = signal; return new Promise((_, reject) => { rejectLater = reject; }); } }), { code: "TIMEOUT" });
  assert.equal(received.aborted, true);
  rejectLater(new Error("Late rejection."));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("caller abort works before query and during an uncooperative async iterator", async () => {
  const before = new AbortController(); before.abort();
  let called = false;
  await assert.rejects(discoverTrustedStreams({ ...policy(), signal: before.signal, query: async () => { called = true; return []; } }), { code: "ABORTED" });
  assert.equal(called, false);
  const controller = new AbortController();
  let querySignal, returned = false;
  const pending = discoverTrustedStreams({ ...policy(), signal: controller.signal, query: async ({ signal }) => {
    querySignal = signal;
    return { [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); }, return() { returned = true; return new Promise(() => {}); } };
  } });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { code: "ABORTED" });
  assert.equal(querySignal.aborted, true);
  assert.equal(returned, true);
});

test("linked live advertisements resolve to a host-pinned stable authorisation while retaining current metadata", async () => {
  const { publisherStreamEvent } = await import("../src/publisher-state.mjs");
  const { createPublisherAdvertisement } = await import("../src/publisher-advertisement.mjs");
  const stable = publisherStreamEvent(author, "/media/master.m3u8", () => (seconds - 10000) * 1000);
  const live = createPublisherAdvertisement({ secretKey: author, streamEvent: stable, swarmId: "host-selected-swarm",
    manifestUrl: "https://media.example/live/master.m3u8", relays: ["wss://event-relay.example"], now: () => seconds * 1000 });
  const configured = policy({ streamAuthorisations: [stable] });
  const resolved = resolveTrustedStream(live, configured);
  assert.equal(resolved.streamEvent.id, stable.id);
  assert.equal(resolved.liveEvent.id, live.id);
  assert.equal(resolved.config.streamEvent.id, stable.id);
  assert.deepEqual(resolved.relays, ["wss://relay.host.example/"]);
  assert.equal(resolveTrustedStream(live, policy()), null);
  assert.equal(resolveTrustedStream(event(), configured), null, "pinned authorisation policy does not downgrade to unlinked metadata");
  assert.equal(resolveTrustedStream(live, policy({ streamAuthorisations: [stable], swarmId: "wrong-host-swarm" })), null);
  const otherStable = publisherStreamEvent(author, "/media/other.m3u8", () => seconds * 1000);
  assert.equal(resolveTrustedStream(live, policy({ streamAuthorisations: [otherStable] })), null);
  resolved.streamEvent.tags[0][1] = "caller mutation";
  assert.equal(resolveTrustedStream(live, configured).streamEvent.id, stable.id);
  const malformed = structuredClone(stable); malformed.content += "mutation";
  assert.throws(() => resolveTrustedStream(live, policy({ streamAuthorisations: [malformed] })), /authorisation/u);
});

test("latest linked ended, expired and withdrawn advertisements suppress earlier live updates without retiring stable identity", async () => {
  const { publisherStreamEvent } = await import("../src/publisher-state.mjs");
  const { createPublisherAdvertisement } = await import("../src/publisher-advertisement.mjs");
  const stable = publisherStreamEvent(author, "/media/master.m3u8", () => (seconds - 10000) * 1000);
  const base = { secretKey: author, streamEvent: stable, swarmId: "host-selected-swarm", manifestUrl: "https://media.example/live/master.m3u8", relays: ["wss://event-relay.example"] };
  const live = createPublisherAdvertisement({ ...base, now: () => (seconds - 10) * 1000 });
  const ended = createPublisherAdvertisement({ ...base, status: "ended", now: () => seconds * 1000 });
  const expired = event({ created_at: seconds, tags: live.tags.map((tag) => tag[0] === "expiration" ? ["expiration", String(seconds)] : tag) });
  const withdrawn = event({ created_at: seconds, tags: live.tags.filter((tag) => tag[0] !== "relayswarm") });
  for (const latest of [ended, expired, withdrawn]) {
    assert.deepEqual(await discoverTrustedStreams({ ...policy({ streamAuthorisations: [stable] }), query: async () => [live, latest, stable] }), []);
  }
});


test("an immediate linked end supersedes live metadata in the same wall-clock second", async () => {
  const { publisherStreamEvent } = await import("../src/publisher-state.mjs");
  const { createPublisherAdvertisement } = await import("../src/publisher-advertisement.mjs");
  const stable = publisherStreamEvent(author, "/media/master.m3u8", () => seconds * 1000);
  const base = { secretKey: author, streamEvent: stable, swarmId: "host-selected-swarm", manifestUrl: "https://media.example/live/master.m3u8", relays: ["wss://event-relay.example"], now: () => seconds * 1000 };
  const live = createPublisherAdvertisement(base);
  const ended = createPublisherAdvertisement({ ...base, status: "ended", previousEvent: live });
  assert.equal(ended.created_at, live.created_at + 1);
  assert.deepEqual(await discoverTrustedStreams({ ...policy({ streamAuthorisations: [stable] }), query: async () => [live, ended] }), []);
});
