#!/usr/bin/env node
// Generate core/vectors/commitments.json from the JavaScript verifier and
// core/vectors/link-traces.json from the real PeerLink.
// Signatures use random auxiliary data, so regenerating changes the file;
// test/proto-vectors.test.mjs checks the committed vectors instead.

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { commitmentContent, commitmentPieceSize, delegationContent, revocationContent, validStreamAuthorisation,
  verifyCommitmentDelegation, verifySegmentCommitment } from "../src/browser/segment-commitment.mjs";
import { normaliseContext, runVectorCase } from "../test/proto-vectors.mjs";
import { runLinkTrace } from "../test/link-traces.mjs";
import { linkTraceCases } from "./link-trace-cases.mjs";

const output = new URL("../core/vectors/commitments.json", import.meta.url);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = (label) => Uint8Array.from(Buffer.from(digest(`relayswarm-vector-${label}`), "hex"));
const author = secret("author"), delegate = secret("delegate"), stranger = secret("stranger");
const AT = 1_792_000_000_000, S = Math.floor(AT / 1000);
const SWARM = "vector-swarm", PLAYLIST = "/media/high/index.m3u8", PATH = "/media/high/segment-7.ts";
const KEY = digest(`${SWARM}\n${PATH}`), SHA = digest("segment bytes");
const sign = (template, key = author) => finalizeEvent(structuredClone(template), key);
const clone = (value) => structuredClone(value);

const streamEvent = sign({ kind: 30311, created_at: S - 3600, tags: [["d", "vectorstream"], ["relayswarm", "redistribute", "1"]], content: "RelaySwarm experimental publisher" });

function commitmentFields(overrides = {}) {
  return { streamEventId: streamEvent.id, swarmId: SWARM, key: KEY, rendition: "0", sequence: 7, discontinuity: 0, part: null,
    sha256: SHA, size: 4096, expiresAt: S + 60, ...overrides };
}
function wideFields(overrides = {}) {
  return commitmentFields({ v: 2, rendition: PLAYLIST, playlist: PLAYLIST, mediaType: "main", encryption: null, ...overrides });
}
function commitment(fields, { key = author, createdAt = S, tags, content } = {}) {
  return sign({ kind: 24172, created_at: createdAt, tags: tags ?? [["x", SWARM], ["e", streamEvent.id]], content: content ?? commitmentContent(fields) }, key);
}
function delegationEvent(overrides = {}, { createdAt = S - 10, tags, content, key = author } = {}) {
  const scope = { streamEventId: streamEvent.id, swarmId: SWARM, delegatePubkey: getPublicKey(delegate), notBefore: createdAt,
    expiresAt: createdAt + 600, renditions: ["0", PLAYLIST], mediaTypes: ["main"], allowParts: false, maxSegmentBytes: 1024 * 1024, ...overrides };
  return sign({ kind: 24173, created_at: createdAt, tags: tags ?? [["x", SWARM], ["e", streamEvent.id]], content: content ?? delegationContent(scope) }, key);
}
function revocationEvent(delegation, { createdAt = S - 5, key = author, tags, content } = {}) {
  return sign({ kind: 24174, created_at: createdAt, tags: tags ?? [["x", SWARM], ["e", delegation.id]],
    content: content ?? revocationContent({ streamEventId: streamEvent.id, swarmId: SWARM, delegationId: delegation.id }) }, key);
}
function delegatedCommitment(delegation, fields, options = {}) {
  return commitment(fields, { key: delegate, tags: [["x", SWARM], ["e", streamEvent.id], ["delegation", delegation.id]], ...options });
}

const frag = (overrides = {}) => ({ baseurl: `https://publisher.test${PLAYLIST}`, type: "main", level: 0, sn: 7, cc: 0, ...overrides });
const aes = { method: "AES-128", uri: "/media/keys/k1", keyFormat: "identity", iv: Array.from({ length: 16 }, (_, index) => index) };
const aesFields = { method: "AES-128", keyPath: "/media/keys/k1", iv: "000102030405060708090a0b0c0d0e0f", keyFormat: "identity" };
const flip = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

const cases = [];
function add(name, intent, input) {
  const entry = { name, intent, ...clone(input) };
  if (entry.context) entry.normalised = normaliseContext(entry.context);
  entry.expected = runVectorCase(entry, AT);
  const outcome = entry.expected === null ? "reject" : "accept";
  if (outcome !== intent) throw new Error(`Vector "${name}" was expected to ${intent} but the JavaScript verifier would ${outcome}.`);
  cases.push(entry);
}
const commit = (name, intent, event, extra = {}) => add(name, intent, { op: "commitment", event, streamEvent, swarmId: SWARM, key: KEY,
  maxSegmentBytes: 1024 * 1024, context: { frag: frag() }, revokedDelegationIds: [], delegationRevocations: [], ...extra });
const delegate_ = (name, intent, event, extra = {}) => add(name, intent, { op: "delegation", event, streamEvent, swarmId: SWARM,
  revokedDelegationIds: [], delegationRevocations: [], ...extra });
const stream = (name, intent, event) => add(name, intent, { op: "stream", event });

// Stream authorisation.
stream("stream: valid", "accept", streamEvent);
stream("stream: uppercase signature hex", "accept", { ...streamEvent, sig: streamEvent.sig.toUpperCase() });
stream("stream: missing redistribute consent", "reject", sign({ kind: 30311, created_at: S, tags: [["d", "x"]], content: "" }));
stream("stream: two d tags", "reject", sign({ kind: 30311, created_at: S, tags: [["d", "x"], ["d", "y"], ["relayswarm", "redistribute", "1"]], content: "" }));
stream("stream: d tag with extra element", "reject", sign({ kind: 30311, created_at: S, tags: [["d", "x", "y"], ["relayswarm", "redistribute", "1"]], content: "" }));
stream("stream: wrong kind", "reject", sign({ kind: 30312, created_at: S, tags: [["d", "x"], ["relayswarm", "redistribute", "1"]], content: "" }));
stream("stream: bad signature", "reject", { ...streamEvent, sig: flip(streamEvent.sig) });
stream("stream: id mismatch", "reject", { ...streamEvent, id: flip(streamEvent.id) });
stream("stream: uppercase id", "reject", { ...streamEvent, id: streamEvent.id.toUpperCase() });
stream("stream: non-string content", "reject", { ...streamEvent, content: 5 });
stream("stream: numeric tag element", "reject", { ...streamEvent, tags: [["d", 5], ...streamEvent.tags.slice(1)] });
stream("stream: oversize", "reject", sign({ kind: 30311, created_at: S, tags: [["d", "x"], ["relayswarm", "redistribute", "1"], ["pad", "p".repeat(16 * 1024)]], content: "" }));
stream("stream: fractional created_at", "accept", sign({ kind: 30311, created_at: S + 0.5, tags: [["d", "x"], ["relayswarm", "redistribute", "1"]], content: "" }));
stream("stream: escapes and non-ASCII", "accept", sign({ kind: 30311, created_at: S, tags: [["d", "swärm \t\"\\\u0001"], ["relayswarm", "redistribute", "1"]], content: "é😀\n" }));

// Author-signed schema 1.
const v1 = commitment(commitmentFields());
commit("v1: valid", "accept", v1);
commit("v1: extra event property", "accept", { ...v1, relays: ["wss://relay.example"] });
commit("v1: wrong swarm option", "reject", v1, { swarmId: "other" });
commit("v1: wrong key option", "reject", v1, { key: digest("other") });
commit("v1: sequence mismatch", "reject", v1, { context: { frag: frag({ sn: 8 }) } });
commit("v1: discontinuity mismatch", "reject", v1, { context: { frag: frag({ cc: 1 }) } });
commit("v1: absent discontinuity reads as zero", "accept", v1, { context: { frag: frag({ cc: undefined }) } });
commit("v1: part in context only", "reject", v1, { context: { frag: frag(), part: { index: 2 } } });
commit("v1: part matches", "accept", commitment(commitmentFields({ part: 2 })), { context: { frag: frag(), part: { index: 2 } } });
commit("v1: negative part", "reject", commitment(commitmentFields({ part: -1 })), { context: { frag: frag(), part: { index: -1 } } });
commit("v1: rendition differs from level", "reject", v1, { context: { frag: frag({ level: 1 }) } });
commit("v1: audio fragment", "reject", v1, { context: { frag: frag({ type: "audio" }) } });
commit("v1: empty fragment type", "accept", v1, { context: { frag: frag({ type: "" }) } });
commit("v1: encrypted fragment", "reject", v1, { context: { frag: frag({ decryptdata: aes }) } });
commit("v1: NONE encryption", "accept", v1, { context: { frag: frag({ decryptdata: { method: "NONE" } }) } });
commit("v1: created 120 s ago", "accept", commitment(commitmentFields(), { createdAt: S - 120 }));
commit("v1: created 121 s ago", "reject", commitment(commitmentFields(), { createdAt: S - 121 }));
commit("v1: created 30 s ahead", "accept", commitment(commitmentFields(), { createdAt: S + 30 }));
commit("v1: created 31 s ahead", "reject", commitment(commitmentFields(), { createdAt: S + 31 }));
commit("v1: fractional created_at", "reject", commitment(commitmentFields(), { createdAt: S + 0.5 }));
commit("v1: expires now", "reject", commitment(commitmentFields({ expiresAt: S })));
commit("v1: expires in 300 s", "accept", commitment(commitmentFields({ expiresAt: S + 300 })));
commit("v1: expires in 301 s", "reject", commitment(commitmentFields({ expiresAt: S + 301 })));
commit("v1: zero size", "reject", commitment(commitmentFields({ size: 0 })));
commit("v1: size at limit", "accept", commitment(commitmentFields({ size: 1024 * 1024 })));
commit("v1: size over limit", "reject", commitment(commitmentFields({ size: 1024 * 1024 + 1 })));
commit("v1: zero segment limit", "reject", v1, { maxSegmentBytes: 0 });
commit("v1: segment limit above 16 MiB", "reject", v1, { maxSegmentBytes: 16 * 1024 * 1024 + 1 });
commit("v1: fractional segment limit", "reject", v1, { maxSegmentBytes: 1024.5 });
commit("v1: uppercase sha256", "reject", commitment(commitmentFields({ sha256: SHA.toUpperCase() })));
commit("v1: sha256 as one-element array", "accept", commitment(commitmentFields({ sha256: [SHA] })));
commit("v1: string sequence", "reject", commitment(commitmentFields({ sequence: "7" })), { context: { frag: frag({ sn: "7" }) } });
commit("v1: fields reordered", "reject", commitment(null, { content: JSON.stringify({ v: 1, domain: "relayswarm-segment-v1", ...commitmentFields() }) }));
commit("v1: whitespace in content", "reject", commitment(null, { content: commitmentContent(commitmentFields()).replace(":", ": ") }));
commit("v1: extra content field", "reject", commitment(null, { content: commitmentContent(commitmentFields()).replace("}", ",\"extra\":1}") }));
commit("v1: version 3", "reject", commitment(null, { content: commitmentContent(commitmentFields()).replace("\"v\":1", "\"v\":3") }));
commit("v1: wrong domain", "reject", commitment(null, { content: commitmentContent(commitmentFields()).replace("segment-v1", "segment-v9") }));
commit("v1: content not JSON", "reject", commitment(null, { content: "{" }));
commit("v1: content null", "reject", commitment(null, { content: "null" }));
commit("v1: duplicate x tag", "reject", commitment(commitmentFields(), { tags: [["x", SWARM], ["x", SWARM], ["e", streamEvent.id]] }));
commit("v1: missing e tag", "reject", commitment(commitmentFields(), { tags: [["x", SWARM]] }));
commit("v1: wrong e tag", "reject", commitment(commitmentFields(), { tags: [["x", SWARM], ["e", flip(streamEvent.id)]] }));
commit("v1: wrong kind", "reject", sign({ ...v1, kind: 24171, id: undefined, sig: undefined, pubkey: undefined }));
commit("v1: bad signature", "reject", { ...v1, sig: flip(v1.sig) });
commit("v1: invalid stream authorisation", "reject", v1, { streamEvent: { ...streamEvent, sig: flip(streamEvent.sig) } });
commit("v1: stranger signs without delegation", "reject", commitment(commitmentFields(), { key: stranger }));
commit("v1: oversize", "reject", commitment(commitmentFields(), { tags: [["x", SWARM], ["e", streamEvent.id], ["pad", "p".repeat(16 * 1024)]] }));
const odd = "swärm \t\"\\\u0001";
commit("v1: escaped swarm identifier", "accept", commitment(commitmentFields({ swarmId: odd }), { tags: [["x", odd], ["e", streamEvent.id]] }), { swarmId: odd });

// Author-signed schema 2.
const v2 = commitment(wideFields());
commit("v2: valid", "accept", v2);
commit("v2: playlist query directive", "accept", v2, { context: { frag: frag({ baseurl: `https://publisher.test${PLAYLIST}?_HLS_msn=7&_HLS_part=1` }) } });
commit("v2: unsupported playlist query", "reject", v2, { context: { frag: frag({ baseurl: `https://publisher.test${PLAYLIST}?token=1` }) } });
commit("v2: rendition differs from playlist", "reject", commitment(wideFields({ rendition: "/media/low/index.m3u8" })));
commit("v2: playlist differs from context", "reject", v2, { context: { frag: frag({ baseurl: "https://publisher.test/media/low/index.m3u8" }) } });
commit("v2: audio", "accept", commitment(wideFields({ mediaType: "audio" })), { context: { frag: frag({ type: "audio" }) } });
commit("v2: media type differs", "reject", commitment(wideFields({ mediaType: "audio" })));
commit("v2: AES-128", "accept", commitment(wideFields({ encryption: aesFields })), { context: { frag: frag({ decryptdata: aes }) } });
commit("v2: AES-128 keys reordered", "reject", commitment(wideFields({ encryption: { keyPath: aesFields.keyPath, method: aesFields.method, iv: aesFields.iv, keyFormat: aesFields.keyFormat } })), { context: { frag: frag({ decryptdata: aes }) } });
commit("v2: encryption absent from content", "reject", commitment(null, { content: commitmentContent(wideFields()).replace(",\"encryption\":null", "") }));
commit("v2: encryption claimed on clear media", "reject", commitment(wideFields({ encryption: aesFields })));

// Delegation.
const delegation = delegationEvent();
delegate_("delegation: valid", "accept", delegation);
delegate_("delegation: kelvin sign and long s in a path", "accept", delegationEvent({ renditions: ["/media/Key/ſegment.m3u8"] }));
delegate_("delegation: dot-dot segment", "reject", delegationEvent({ renditions: ["/media/../secret.m3u8"] }));
delegate_("delegation: numeric rendition coerced from an array", "accept", delegationEvent({ renditions: [["12"]] }));
delegate_("delegation: five-digit rendition", "reject", delegationEvent({ renditions: ["12345"] }));
delegate_("delegation: leading-zero rendition", "reject", delegationEvent({ renditions: ["01"] }));
delegate_("delegation: delegate key coerced from an array", "accept", delegationEvent({ delegatePubkey: [getPublicKey(delegate)] }));
delegate_("delegation: duplicate renditions", "reject", delegationEvent({ renditions: ["0", "0"] }));
delegate_("delegation: 41 renditions", "reject", delegationEvent({ renditions: Array.from({ length: 41 }, (_, index) => String(index)) }));
delegate_("delegation: invalid media type", "reject", delegationEvent({ mediaTypes: ["video"] }));
delegate_("delegation: duplicate media types", "reject", delegationEvent({ mediaTypes: ["main", "main"] }));
delegate_("delegation: allowParts not boolean", "reject", delegationEvent({ allowParts: 1 }));
delegate_("delegation: max bytes above 16 MiB", "reject", delegationEvent({ maxSegmentBytes: 16 * 1024 * 1024 + 1 }));
delegate_("delegation: expired", "reject", delegationEvent({ expiresAt: S }, { createdAt: S - 100 }));
delegate_("delegation: longer than an hour", "reject", delegationEvent({ expiresAt: S + 3591 }));
delegate_("delegation: notBefore in the future", "reject", delegationEvent({ notBefore: S + 1 }));
delegate_("delegation: notBefore before issuance", "reject", delegationEvent({ notBefore: S - 11 }));
delegate_("delegation: created 31 s ahead", "reject", delegationEvent({ notBefore: S }, { createdAt: S + 31 }));
delegate_("delegation: signed by a stranger", "reject", delegationEvent({}, { key: stranger }));
delegate_("delegation: wrong swarm tag", "reject", delegationEvent({}, { tags: [["x", "other"], ["e", streamEvent.id]] }));
delegate_("delegation: revoked by identifier", "reject", delegation, { revokedDelegationIds: [delegation.id] });
delegate_("delegation: 257 revoked identifiers", "reject", delegation, { revokedDelegationIds: Array.from({ length: 257 }, (_, index) => digest(String(index))) });
delegate_("delegation: signed revocation", "reject", delegation, { delegationRevocations: [revocationEvent(delegation)] });
delegate_("delegation: forged revocation ignored", "accept", delegation, { delegationRevocations: [revocationEvent(delegation, { key: stranger })] });
delegate_("delegation: revocation before delegation ignored", "accept", delegation, { delegationRevocations: [revocationEvent(delegation, { createdAt: S - 11 })] });
delegate_("delegation: revocation for another swarm ignored", "accept", delegation, { delegationRevocations: [revocationEvent(delegation, { tags: [["x", "other"], ["e", delegation.id]] })] });
delegate_("delegation: malformed revocation ignored", "accept", delegation, { delegationRevocations: [{ ...revocationEvent(delegation), tags: "x" }, null, 5] });
delegate_("delegation: revocation with non-JSON content rejects", "reject", delegation, { delegationRevocations: [revocationEvent(delegation, { content: "{" })] });
delegate_("delegation: revocation with null content rejects", "reject", delegation, { delegationRevocations: [revocationEvent(delegation, { content: "null" })] });
delegate_("delegation: revocation with numeric content ignored", "accept", delegation, { delegationRevocations: [revocationEvent(delegation, { content: "5" })] });

// Delegated commitments.
commit("delegated v1: valid", "accept", delegatedCommitment(delegation, commitmentFields()), { delegation });
commit("delegated v1: no delegation supplied", "reject", delegatedCommitment(delegation, commitmentFields()));
commit("delegated v1: missing delegation tag", "reject", commitment(commitmentFields(), { key: delegate }), { delegation });
commit("delegated v1: delegation tag names another event", "reject", commitment(commitmentFields(), { key: delegate, tags: [["x", SWARM], ["e", streamEvent.id], ["delegation", flip(delegation.id)]] }), { delegation });
commit("delegated v1: signed by a different delegate", "reject", commitment(commitmentFields(), { key: stranger, tags: [["x", SWARM], ["e", streamEvent.id], ["delegation", delegation.id]] }), { delegation });
commit("delegated v1: revoked", "reject", delegatedCommitment(delegation, commitmentFields()), { delegation, revokedDelegationIds: [delegation.id] });
commit("delegated v1: signed revocation", "reject", delegatedCommitment(delegation, commitmentFields()), { delegation, delegationRevocations: [revocationEvent(delegation)] });
commit("delegated v1: rendition outside scope", "reject", delegatedCommitment(delegation, commitmentFields({ rendition: "1" })), { delegation, context: { frag: frag({ level: 1 }) } });
commit("delegated v1: part not allowed", "reject", delegatedCommitment(delegation, commitmentFields({ part: 0 })), { delegation, context: { frag: frag(), part: { index: 0 } } });
const partsDelegation = delegationEvent({ allowParts: true });
commit("delegated v1: part allowed", "accept", delegatedCommitment(partsDelegation, commitmentFields({ part: 0 })), { delegation: partsDelegation, context: { frag: frag(), part: { index: 0 } } });
const smallDelegation = delegationEvent({ maxSegmentBytes: 4095 });
commit("delegated v1: size above scope", "reject", delegatedCommitment(smallDelegation, commitmentFields()), { delegation: smallDelegation });
const shortDelegation = delegationEvent({ expiresAt: S + 30 });
commit("delegated v1: outlives delegation", "reject", delegatedCommitment(shortDelegation, commitmentFields({ expiresAt: S + 31 })), { delegation: shortDelegation });
commit("delegated v1: ends with delegation", "accept", delegatedCommitment(shortDelegation, commitmentFields({ expiresAt: S + 30 })), { delegation: shortDelegation });
const lateDelegation = delegationEvent({ notBefore: S - 5 });
commit("delegated v1: signed before notBefore", "reject", delegatedCommitment(lateDelegation, commitmentFields(), { createdAt: S - 6 }), { delegation: lateDelegation });
commit("delegated v2: valid", "accept", delegatedCommitment(delegation, wideFields()), { delegation });
commit("delegated v2: audio outside scope", "reject", delegatedCommitment(delegation, wideFields({ mediaType: "audio" })), { delegation, context: { frag: frag({ type: "audio" }) } });
const audioDelegation = delegationEvent({ mediaTypes: ["main", "audio"] });
commit("delegated v2: audio in scope", "accept", delegatedCommitment(audioDelegation, wideFields({ mediaType: "audio" })), { delegation: audioDelegation, context: { frag: frag({ type: "audio" }) } });

// Author-signed schema 3: schema 2 plus one SHA-256 per piece.
const pieceHashes = (size) => Array.from({ length: Math.ceil(size / commitmentPieceSize(size)) }, (_, index) => digest(`piece ${index}`));
function pieceFields(overrides = {}) {
  const size = overrides.size ?? 200_000;
  return wideFields({ v: 3, size, pieceSize: commitmentPieceSize(size), pieces: pieceHashes(size), ...overrides });
}
const v3 = pieceFields();
commit("v3: valid, short last piece", "accept", commitment(v3));
commit("v3: audio", "accept", commitment(pieceFields({ mediaType: "audio" })), { context: { frag: frag({ type: "audio" }) } });
commit("v3: one piece", "accept", commitment(pieceFields({ size: 4096 })));
commit("v3: size at limit", "accept", commitment(pieceFields({ size: 1024 * 1024 })));
commit("v3: 64 pieces at 4 MiB", "accept", commitment(pieceFields({ size: 4 * 1024 * 1024 })), { maxSegmentBytes: 16 * 1024 * 1024 });
commit("v3: 64 pieces at 16 MiB", "accept", commitment(pieceFields({ size: 16 * 1024 * 1024 })), { maxSegmentBytes: 16 * 1024 * 1024 });
commit("v3: piece size grows past 4 MiB", "accept", commitment(pieceFields({ size: 4 * 1024 * 1024 + 1 })), { maxSegmentBytes: 16 * 1024 * 1024 });
commit("v3: piece size off the formula", "reject", commitment(pieceFields({ pieceSize: 65_536 + 16_384, pieces: pieceHashes(200_000).slice(0, 3) })));
commit("v3: piece size as string", "reject", commitment(pieceFields({ pieceSize: "65536" })));
commit("v3: one piece too few", "reject", commitment(pieceFields({ pieces: pieceHashes(200_000).slice(1) })));
commit("v3: one piece too many", "reject", commitment(pieceFields({ pieces: [...pieceHashes(200_000), SHA] })));
commit("v3: uppercase piece", "reject", commitment(pieceFields({ pieces: pieceHashes(200_000).map((hash, index) => index === 2 ? hash.toUpperCase() : hash) })));
commit("v3: piece as one-element array", "reject", commitment(pieceFields({ pieces: pieceHashes(200_000).map((hash, index) => index === 0 ? [hash] : hash) })));
commit("v3: pieces as object", "reject", commitment(pieceFields({ pieces: { 0: SHA, 1: SHA, 2: SHA, 3: SHA, length: 4 } })));
commit("v3: pieces absent from content", "reject", commitment(null, { content: commitmentContent(v3).replace(/,"pieces":\[[^\]]*\]/u, "") }));
commit("v3: schema 2 domain", "reject", commitment(null, { content: commitmentContent(v3).replace("segment-v3", "segment-v2") }));
commit("v3: rendition differs from playlist", "reject", commitment(pieceFields({ rendition: "/media/low/index.m3u8" })));
commit("v2: piece fields in content", "reject", commitment(null, { content: commitmentContent(v3).replace("segment-v3", "segment-v2").replace("\"v\":3", "\"v\":2") }));
commit("delegated v3: valid", "accept", delegatedCommitment(delegation, pieceFields()), { delegation });

// Cross-check the helpers used by the generator against the module under test.
if (!validStreamAuthorisation(streamEvent) || !verifyCommitmentDelegation(delegation, { streamEvent, swarmId: SWARM }, AT)
  || !verifySegmentCommitment(v1, { streamEvent, swarmId: SWARM, key: KEY, maxSegmentBytes: 1024 * 1024, context: { frag: frag() } }, AT)) {
  throw new Error("Generator fixtures do not verify.");
}

await writeFile(output, `${JSON.stringify({ description: "Generated by scripts/generate-proto-vectors.mjs from src/browser/segment-commitment.mjs. Do not edit by hand.", at: AT, cases }, null, 1)}\n`);
const traces = [];
for (const trace of linkTraceCases) traces.push({ ...trace, expected: await runLinkTrace(trace) });
await writeFile(new URL("../core/vectors/link-traces.json", import.meta.url), `${JSON.stringify({ description: "Generated by scripts/generate-proto-vectors.mjs from src/browser/peer-link.mjs. Do not edit by hand.", traces }, null, 1)}\n`);
process.stdout.write(`wrote ${cases.length} vectors and ${traces.length} link traces\n`);
