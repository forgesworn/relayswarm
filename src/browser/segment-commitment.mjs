import { verifyEvent } from "nostr-tools/pure";

// Experimental assignments, not an accepted NIP. Delegates require an explicit
// author-signed scope and a host-provided revocation view; no relay is queried.
export const KIND_SEGMENT_COMMITMENT = 24172;
export const KIND_COMMITMENT_DELEGATION = 24173;
export const KIND_COMMITMENT_REVOCATION = 24174;
const HEX64 = /^[0-9a-f]{64}$/u;
const DOMAIN = "relayswarm-segment-v1";
const DOMAIN_V2 = "relayswarm-segment-v2";
const encoder = new TextEncoder();

function validSignature(event) {
  return verifyEvent({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig });
}
function bounded(event) { return encoder.encode(JSON.stringify(event)).length <= 16 * 1024; }
function tag(event, name) {
  const matches = event.tags.filter((value) => value[0] === name);
  return matches.length === 1 && matches[0].length === 2 ? matches[0][1] : null;
}
function safePath(path) { return typeof path === "string" && /^\/media\/[a-z0-9_./-]+$/iu.test(path) && !path.split("/").includes(".."); }

export function commitmentContent(value) {
  const wide = value.v === 2;
  return JSON.stringify({ domain: wide ? DOMAIN_V2 : DOMAIN, v: wide ? 2 : 1,
    streamEventId: value.streamEventId, swarmId: value.swarmId, key: value.key,
    rendition: value.rendition, sequence: value.sequence, discontinuity: value.discontinuity,
    part: value.part, sha256: value.sha256, size: value.size, expiresAt: value.expiresAt,
    ...(wide ? { playlist: value.playlist, mediaType: value.mediaType, encryption: value.encryption } : {}),
  });
}
export function delegationContent(value) {
  return JSON.stringify({ domain: "relayswarm-commitment-delegation-v1", v: 1, streamEventId: value.streamEventId,
    swarmId: value.swarmId, delegatePubkey: value.delegatePubkey, notBefore: value.notBefore, expiresAt: value.expiresAt,
    renditions: value.renditions, mediaTypes: value.mediaTypes, allowParts: value.allowParts, maxSegmentBytes: value.maxSegmentBytes });
}
export function revocationContent(value) {
  return JSON.stringify({ domain: "relayswarm-commitment-revocation-v1", v: 1, streamEventId: value.streamEventId,
    swarmId: value.swarmId, delegationId: value.delegationId });
}
export function validStreamAuthorisation(event) {
  try {
    return event.kind === 30311 && bounded(event) && validSignature(event) && typeof tag(event, "d") === "string"
      && event.tags.some((value) => value.length === 3 && value[0] === "relayswarm" && value[1] === "redistribute" && value[2] === "1");
  } catch { return false; }
}
/** A missing revocation is not proof of its absence. Hosts must supply their
 * current trusted stream event and revocation view; expiry bounds offline use. */
export function verifyCommitmentDelegation(event, { streamEvent, swarmId, revokedDelegationIds = [], delegationRevocations = [] }, at = Date.now()) {
  try {
    const seconds = Math.floor(at / 1000);
    if (!validStreamAuthorisation(streamEvent) || !event || !bounded(event) || event.kind !== KIND_COMMITMENT_DELEGATION
      || event.pubkey !== streamEvent.pubkey || !validSignature(event) || tag(event, "x") !== swarmId || tag(event, "e") !== streamEvent.id
      || !Number.isSafeInteger(event.created_at) || event.created_at > seconds + 30
      || !Array.isArray(revokedDelegationIds) || revokedDelegationIds.length > 256 || revokedDelegationIds.includes(event.id)
      || !Array.isArray(delegationRevocations) || delegationRevocations.length > 256) return null;
    const value = JSON.parse(event.content);
    if (event.content !== delegationContent(value) || value.domain !== "relayswarm-commitment-delegation-v1" || value.v !== 1
      || value.streamEventId !== streamEvent.id || value.swarmId !== swarmId || !HEX64.test(value.delegatePubkey)
      || !Number.isSafeInteger(value.notBefore) || value.notBefore < event.created_at || value.notBefore > seconds
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= seconds || value.expiresAt <= value.notBefore || value.expiresAt > event.created_at + 3600
      || !Array.isArray(value.renditions) || !value.renditions.length || value.renditions.length > 40 || new Set(value.renditions).size !== value.renditions.length
      || value.renditions.some((entry) => !(safePath(entry) || /^(?:0|[1-9][0-9]{0,3})$/u.test(entry)))
      || !Array.isArray(value.mediaTypes) || !value.mediaTypes.length || value.mediaTypes.length > 2 || new Set(value.mediaTypes).size !== value.mediaTypes.length || value.mediaTypes.some((entry) => !["main", "audio"].includes(entry))
      || typeof value.allowParts !== "boolean" || !Number.isSafeInteger(value.maxSegmentBytes) || value.maxSegmentBytes < 1 || value.maxSegmentBytes > 16 * 1024 * 1024) return null;
    for (const revocation of delegationRevocations) {
      // Untrusted/forged revocations cannot revoke an authorisation.
      if (!revocation || !bounded(revocation) || revocation.kind !== KIND_COMMITMENT_REVOCATION || revocation.pubkey !== streamEvent.pubkey
        || !Number.isSafeInteger(revocation.created_at) || revocation.created_at < event.created_at || revocation.created_at > seconds + 30
        || !validSignature(revocation) || tag(revocation, "e") !== event.id || tag(revocation, "x") !== swarmId) continue;
      const revoked = JSON.parse(revocation.content);
      if (revocation.content === revocationContent(revoked) && revoked.domain === "relayswarm-commitment-revocation-v1" && revoked.v === 1
        && revoked.streamEventId === streamEvent.id && revoked.swarmId === swarmId && revoked.delegationId === event.id) return null;
    }
    return value;
  } catch { return null; }
}
/** Extract only an exact local playlist identity. Query-bearing media playlists
 * allow the three HLS delivery directives; other queries need host adaptation. */
export function segmentMediaContext(context) {
  try {
    const raw = context.frag.baseurl || context.frag.base?.url;
    if (typeof raw !== "string" || raw.length > 4096) return null;
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || new Set([...url.searchParams.keys()]).size !== [...url.searchParams.keys()].length) return null;
    if (url.username || url.password || url.hash || [...url.searchParams].some(([name, value]) => !["_HLS_msn", "_HLS_part", "_HLS_skip"].includes(name) || !/^(?:[0-9]+|YES|v2)$/u.test(value))) return null;
    if (!safePath(url.pathname)) return null;
    const mediaType = context.frag.type ?? "main";
    if (!["main", "audio"].includes(mediaType)) return null;
    const decrypt = context.frag.decryptdata;
    let encryption = null;
    if (decrypt?.method && decrypt.method !== "NONE") {
      if (decrypt.method !== "AES-128" || (decrypt.keyFormat && decrypt.keyFormat !== "identity")) return null;
      const key = new URL(decrypt.uri, url);
      if (key.origin !== url.origin || key.search || key.hash || !safePath(key.pathname) || !decrypt.iv || decrypt.iv.length !== 16 || Array.from(decrypt.iv).some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
      encryption = { method: "AES-128", keyPath: key.pathname, iv: Array.from(decrypt.iv, (byte) => byte.toString(16).padStart(2, "0")).join(""), keyFormat: "identity" };
    }
    return { playlist: url.pathname, mediaType, encryption };
  } catch { return null; }
}

export function verifySegmentCommitment(event, { streamEvent, swarmId, key, context, maxSegmentBytes,
  delegation, revokedDelegationIds, delegationRevocations }, at = Date.now()) {
  try {
    const seconds = Math.floor(at / 1000);
    if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < 1 || maxSegmentBytes > 16 * 1024 * 1024
      || !validStreamAuthorisation(streamEvent) || !event || event.kind !== KIND_SEGMENT_COMMITMENT || !bounded(event)
      || !Number.isSafeInteger(event.created_at) || event.created_at > seconds + 30 || event.created_at < seconds - 120
      || !validSignature(event) || tag(event, "x") !== swarmId || tag(event, "e") !== streamEvent.id) return null;
    const value = JSON.parse(event.content), wide = value.v === 2;
    if (event.content !== commitmentContent(value) || value.domain !== (wide ? DOMAIN_V2 : DOMAIN) || ![1, 2].includes(value.v)
      || value.streamEventId !== streamEvent.id || value.swarmId !== swarmId || value.key !== key
      || value.sequence !== context.frag.sn || value.discontinuity !== (context.frag.cc ?? 0) || value.part !== (context.part?.index ?? null)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isSafeInteger(value.discontinuity) || value.discontinuity < 0
      || (value.part !== null && (!Number.isSafeInteger(value.part) || value.part < 0)) || !HEX64.test(value.sha256)
      || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maxSegmentBytes
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= seconds || value.expiresAt > seconds + 300) return null;
    if (wide) {
      const expected = segmentMediaContext(context);
      if (!expected || value.rendition !== expected.playlist || value.playlist !== expected.playlist || value.mediaType !== expected.mediaType
        || JSON.stringify(value.encryption) !== JSON.stringify(expected.encryption)) return null;
    } else if (value.rendition !== String(context.frag.level) || (context.frag.type && context.frag.type !== "main") || context.frag.decryptdata?.method && context.frag.decryptdata.method !== "NONE") return null;
    if (event.pubkey !== streamEvent.pubkey) {
      const scope = verifyCommitmentDelegation(delegation, { streamEvent, swarmId, revokedDelegationIds, delegationRevocations }, at);
      if (!scope || event.pubkey !== scope.delegatePubkey || tag(event, "delegation") !== delegation.id || event.created_at < scope.notBefore
        || value.expiresAt > scope.expiresAt || !scope.renditions.includes(value.rendition) || !scope.mediaTypes.includes(wide ? value.mediaType : "main")
        || value.part !== null && !scope.allowParts || value.size > scope.maxSegmentBytes) return null;
    }
    return value;
  } catch { return null; }
}
