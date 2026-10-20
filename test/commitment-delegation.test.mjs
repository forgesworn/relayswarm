import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createHlsPublisher } from "../src/hls-publisher.mjs";
import { publisherStreamEvent, createCommitmentDelegation, createCommitmentRevocation } from "../src/publisher-state.mjs";
import { verifyCommitmentDelegation, verifySegmentCommitment, commitmentContent } from "../src/browser/segment-commitment.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const swarmId = "delegated-publisher-test";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-delegation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\nsegment.ts\n");
  await writeFile(join(directory, "segment.ts"), "media");
  return directory;
}
const input = { path: "/media/segment.ts", playlist: "/media/index.m3u8", level: 0, sequence: 0, discontinuity: 0 };
function options(streamEvent, delegation, extra = {}) {
  return { streamEvent, delegation, swarmId, key: digest(`${swarmId}\n/media/segment.ts`),
    maxSegmentBytes: 1024, context: { frag: { baseurl: "https://publisher.test/media/index.m3u8", type: "main", level: 0, sn: 0, cc: 0 } }, ...extra };
}

test("delegated publisher uses only the delegate key and exact author scope without retaining the author secret", async (t) => {
  const author = generateSecretKey(), delegate = generateSecretKey(), at = Date.now();
  const streamEvent = publisherStreamEvent(author, "/media/index.m3u8", () => at);
  const delegation = createCommitmentDelegation({ secretKey: author, streamEvent, swarmId, delegatePubkey: getPublicKey(delegate), renditions: ["/media/index.m3u8"], now: () => at });
  const publisher = await createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8", streamEvent,
    swarmId, commitmentSecretKey: delegate, delegation, now: () => at });
  const event = await publisher.commitment(input);
  assert.equal(event.pubkey, getPublicKey(delegate));
  assert.equal(verifySegmentCommitment(event, options(streamEvent, delegation), at).sha256, digest("media"));
  assert.equal(verifySegmentCommitment(event, options(streamEvent, undefined), at), null);
  const otherStream = publisherStreamEvent(author, "/media/other.m3u8", () => at);
  assert.equal(verifySegmentCommitment(event, options(otherStream, delegation), at), null);
  assert.equal(JSON.stringify(publisher).includes(Buffer.from(author).toString("hex")), false);
  const tampered = structuredClone(delegation); tampered.content = tampered.content.replace("index", "other");
  assert.equal(verifySegmentCommitment(event, options(streamEvent, tampered), at), null);
  await assert.rejects(createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8", streamEvent, swarmId,
    commitmentSecretKey: generateSecretKey(), delegation, now: () => at }), /absent, expired or revoked/u);
});

test("delegation expiry caps commitments and cached responses honour explicit and signed revocation", async (t) => {
  const author = generateSecretKey(), delegate = generateSecretKey(); let at = Date.now();
  const streamEvent = publisherStreamEvent(author, "/media/index.m3u8", () => at), seconds = Math.floor(at / 1000);
  const delegation = createCommitmentDelegation({ secretKey: author, streamEvent, swarmId, delegatePubkey: getPublicKey(delegate),
    renditions: ["/media/index.m3u8"], expiresAt: seconds + 20, now: () => at });
  const revokedDelegationIds = [], delegationRevocations = [];
  const publisher = await createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8", streamEvent, swarmId,
    commitmentSecretKey: delegate, delegation, revokedDelegationIds, delegationRevocations, now: () => at });
  const event = await publisher.commitment(input);
  assert.equal(JSON.parse(event.content).expiresAt, seconds + 20);
  revokedDelegationIds.push(delegation.id);
  await assert.rejects(publisher.commitment(input), { status: 403 });
  assert.equal(verifySegmentCommitment(event, options(streamEvent, delegation, { revokedDelegationIds }), at), null);
  revokedDelegationIds.length = 0;
  const revocation = createCommitmentRevocation({ secretKey: author, streamEvent, swarmId, delegation, now: () => at });
  const forged = finalizeEvent({ kind: revocation.kind, created_at: revocation.created_at, tags: revocation.tags, content: revocation.content }, generateSecretKey());
  assert.ok(verifySegmentCommitment(event, options(streamEvent, delegation, { delegationRevocations: [forged] }), at));
  delegationRevocations.push(revocation);
  await assert.rejects(publisher.commitment(input), { status: 403 });
  assert.equal(verifySegmentCommitment(event, options(streamEvent, delegation, { delegationRevocations }), at), null);
  delegationRevocations.length = 0;
  at += 21000;
  await assert.rejects(publisher.commitment(input), { status: 403 });
  assert.equal(verifyCommitmentDelegation(delegation, { streamEvent, swarmId }, at), null);
});

test("delegation restricts rendition, type, parts, sizes, lifetime and commitment expiry", async (t) => {
  const author = generateSecretKey(), delegate = generateSecretKey(), at = Date.now(), seconds = Math.floor(at / 1000);
  const streamEvent = publisherStreamEvent(author, "/media/index.m3u8", () => at);
  const base = { secretKey: author, streamEvent, swarmId, delegatePubkey: getPublicKey(delegate), renditions: ["/media/index.m3u8"], now: () => at };
  for (const invalid of [{ expiresAt: seconds + 3601 }, { renditions: ["https://cdn.test/index"] }, { mediaTypes: ["subtitle"] }, { maxSegmentBytes: 16777217 }, { allowParts: "true" }]) assert.throws(() => createCommitmentDelegation({ ...base, ...invalid }));
  const tiny = createCommitmentDelegation({ ...base, maxSegmentBytes: 4 });
  const publisher = await createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8", streamEvent, swarmId,
    commitmentSecretKey: delegate, delegation: tiny, now: () => at });
  await assert.rejects(publisher.commitment(input), { status: 403 });
  const scope = createCommitmentDelegation(base);
  const fields = { v: 2, streamEventId: streamEvent.id, swarmId, key: digest(`${swarmId}\n/media/segment.ts`), rendition: "/media/index.m3u8",
    playlist: "/media/index.m3u8", mediaType: "main", encryption: null, sequence: 0, discontinuity: 0, part: null, sha256: digest("media"), size: 5, expiresAt: seconds + 60 };
  for (const override of [{ expiresAt: seconds + 301 }, { rendition: "/media/other.m3u8", playlist: "/media/other.m3u8" }, { part: 0 }, { mediaType: "audio" }]) {
    const event = finalizeEvent({ kind: 24172, created_at: seconds, tags: [["x", swarmId], ["e", streamEvent.id], ["delegation", scope.id]], content: commitmentContent({ ...fields, ...override }) }, delegate);
    const context = { frag: { baseurl: `https://publisher.test${override.playlist ?? fields.playlist}`, type: override.mediaType ?? "main", sn: 0, cc: 0, level: 0 }, ...(override.part != null ? { part: { index: override.part } } : {}) };
    assert.equal(verifySegmentCommitment(event, options(streamEvent, scope, { context }), at), null);
  }
});

test("delegate-only publishers accept verified externally authored advertisements and cannot sign live metadata", async (t) => {
  const { createPublisherAdvertisement } = await import("../src/publisher-advertisement.mjs");
  const author = generateSecretKey(), delegate = generateSecretKey(), at = Date.now();
  const streamEvent = publisherStreamEvent(author, "/media/index.m3u8", () => at);
  const delegation = createCommitmentDelegation({ secretKey: author, streamEvent, swarmId, delegatePubkey: getPublicKey(delegate), renditions: ["/media/index.m3u8"], now: () => at });
  const publisher = await createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8", streamEvent, swarmId,
    commitmentSecretKey: delegate, delegation, now: () => at });
  const opts = { manifestUrl: "https://example.test/media/index.m3u8", relays: ["wss://relay.example"] };
  assert.throws(() => publisher.advertisement(opts), { status: 403 });
  const advertisement = createPublisherAdvertisement({ secretKey: author, streamEvent, swarmId, ...opts, now: () => at });
  assert.equal(publisher.advertisement({ ...opts, event: advertisement }).id, advertisement.id);
  assert.throws(() => publisher.advertisement({ ...opts, event: advertisement, status: "ended" }), { status: 403 });
});
