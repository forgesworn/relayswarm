import { verifyEvent } from "nostr-tools/pure";

// Experimental assignments, not an accepted NIP. Only the stream author may
// sign commitments in this implementation; delegated signing is future work.
export const KIND_SEGMENT_COMMITMENT = 24172;
const HEX64 = /^[0-9a-f]{64}$/u;
const DOMAIN = "relayswarm-segment-v1";
const encoder = new TextEncoder();

function validSignature(event) {
  // nostr-tools caches verdicts on a Symbol. Verify the wire fields afresh so
  // a host's previously verified object cannot retain trust after mutation.
  return verifyEvent({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig });
}

export function commitmentContent(value) {
  return JSON.stringify({
    domain: DOMAIN,
    v: 1,
    streamEventId: value.streamEventId,
    swarmId: value.swarmId,
    key: value.key,
    rendition: value.rendition,
    sequence: value.sequence,
    discontinuity: value.discontinuity,
    part: value.part,
    sha256: value.sha256,
    size: value.size,
    expiresAt: value.expiresAt,
  });
}

function tag(event, name) {
  const matches = event.tags.filter((value) => value[0] === name);
  return matches.length === 1 ? matches[0][1] : null;
}

export function validStreamAuthorisation(event) {
  try {
    return event.kind === 30311 && encoder.encode(JSON.stringify(event)).length <= 16 * 1024
      && validSignature(event) && typeof tag(event, "d") === "string"
      && event.tags.some((value) => value.length === 3 && value[0] === "relayswarm" && value[1] === "redistribute" && value[2] === "1");
  } catch { return false; }
}

export function verifySegmentCommitment(event, { streamEvent, swarmId, key, context, maxSegmentBytes }, at = Date.now()) {
  try {
    const seconds = Math.floor(at / 1000);
    if (!validStreamAuthorisation(streamEvent) || !event || event.kind !== KIND_SEGMENT_COMMITMENT
      || event.pubkey !== streamEvent.pubkey || encoder.encode(JSON.stringify(event)).length > 16 * 1024
      || !Number.isSafeInteger(event.created_at) || event.created_at > seconds + 30 || event.created_at < seconds - 120
      || !validSignature(event) || tag(event, "x") !== swarmId || tag(event, "e") !== streamEvent.id) return null;
    const value = JSON.parse(event.content);
    if (event.content !== commitmentContent(value) || value.domain !== DOMAIN || value.v !== 1
      || value.streamEventId !== streamEvent.id || value.swarmId !== swarmId || value.key !== key
      || value.rendition !== String(context.frag.level) || value.sequence !== context.frag.sn
      || value.discontinuity !== (context.frag.cc ?? 0) || value.part !== (context.part?.index ?? null)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 0
      || !Number.isSafeInteger(value.discontinuity) || value.discontinuity < 0
      || (value.part !== null && (!Number.isSafeInteger(value.part) || value.part < 0))
      || !HEX64.test(value.sha256) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maxSegmentBytes
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= seconds || value.expiresAt > seconds + 300) return null;
    return value;
  } catch { return null; }
}
