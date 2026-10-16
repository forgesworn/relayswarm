import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { validStreamAuthorisation } from "./browser/segment-commitment.mjs";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const encoder = new TextEncoder();
const single = (event, name) => {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0].length === 2 ? matches[0][1] : null;
};
function endpoint(raw, secure, insecure, allowLoopback) {
  if (typeof raw !== "string" || !raw || raw.length > 2048 || /[\s\\]/u.test(raw)) throw new TypeError("Invalid advertisement endpoint.");
  const url = new URL(raw);
  if (url.username || url.password || url.hash || (url.protocol !== secure && !(allowLoopback && url.protocol === insecure && LOOPBACK.has(url.hostname)))) throw new TypeError("Unsafe advertisement endpoint.");
  return url.href;
}
function policy({ streamEvent, swarmId, manifestUrl, relays, status = "live", starts, expiresAt, now = Date.now, allowLoopback = false }) {
  if (!validStreamAuthorisation(streamEvent) || typeof swarmId !== "string" || swarmId.length < 8 || swarmId.length > 128
    || typeof allowLoopback !== "boolean" || !["live", "ended"].includes(status) || typeof now !== "function") throw new TypeError("Invalid advertisement policy.");
  const seconds = Math.floor(now() / 1000);
  starts ??= seconds; expiresAt ??= seconds + 300;
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(starts) || starts < 0 || starts > seconds
    || !Number.isSafeInteger(expiresAt) || expiresAt <= seconds || expiresAt > seconds + 300) throw new TypeError("Invalid advertisement time.");
  if (!Array.isArray(relays) || !relays.length || relays.length > 8) throw new TypeError("Explicit advertisement relays are required.");
  return { seconds, starts, expiresAt, status, manifestUrl: endpoint(manifestUrl, "https:", "http:", allowLoopback),
    relays: [...new Set(relays.map((url) => endpoint(url, "wss:", "ws:", allowLoopback)))] };
}
/** A separate NIP-53 address: updating live metadata must never replace the
 * durable minimal event whose ID authorises commitments and delegates. */
export function createPublisherAdvertisement({ secretKey, streamEvent, swarmId, previousEvent, ...options } = {}) {
  const value = policy({ streamEvent, swarmId, ...options });
  if (!secretKey || getPublicKey(secretKey) !== streamEvent.pubkey) throw new TypeError("Only the stream author may sign live advertisements.");
  let createdAt = value.seconds;
  if (previousEvent) {
    if (encoder.encode(JSON.stringify(previousEvent)).length > 16 * 1024 || previousEvent.pubkey !== streamEvent.pubkey || previousEvent.kind !== 30311
      || single(previousEvent, "d") !== `live-${streamEvent.id}` || single(previousEvent, "relayswarm-authorisation") !== streamEvent.id
      || single(previousEvent, "relayswarm-swarm") !== swarmId || !Number.isSafeInteger(previousEvent.created_at) || previousEvent.created_at < 0
      || previousEvent.created_at >= value.seconds + 30
      || !verifyEvent({ id: previousEvent.id, pubkey: previousEvent.pubkey, created_at: previousEvent.created_at, kind: previousEvent.kind, tags: previousEvent.tags, content: previousEvent.content, sig: previousEvent.sig })) throw new TypeError("Invalid previous advertisement.");
    // Nostr addressable ties select the lowest event ID. Ensure an immediate
    // ended update wins over live, while respecting the 30-second clock budget.
    createdAt = Math.max(createdAt, previousEvent.created_at + 1);
  }
  return finalizeEvent({ kind: 30311, created_at: createdAt, content: "", tags: [
    ["d", `live-${streamEvent.id}`], ["streaming", value.manifestUrl], ["status", value.status], ["starts", String(value.starts)],
    ["expiration", String(value.expiresAt)], ...(value.status === "ended" ? [["ends", String(value.seconds)]] : []),
    ["relays", ...value.relays], ["relayswarm", "redistribute", "1"], ["relayswarm-authorisation", streamEvent.id], ["relayswarm-swarm", swarmId],
  ] }, secretKey);
}
/** Verify an externally signed advertisement without gaining access to the
 * author's private key. Freshness is bounded; this does not prove global latest. */
export function verifyPublisherAdvertisement(event, { streamEvent, swarmId, manifestUrl, relays, now = Date.now, allowLoopback = false } = {}) {
  try {
    if (!validStreamAuthorisation(streamEvent) || !event || event.kind !== 30311 || event.pubkey !== streamEvent.pubkey
      || encoder.encode(JSON.stringify(event)).length > 16 * 1024
      || !verifyEvent({ id: event.id, pubkey: event.pubkey, created_at: event.created_at, kind: event.kind, tags: event.tags, content: event.content, sig: event.sig })
      || single(event, "d") !== `live-${streamEvent.id}` || single(event, "relayswarm-authorisation") !== streamEvent.id || single(event, "relayswarm-swarm") !== swarmId) return null;
    const seconds = Math.floor(now() / 1000), status = single(event, "status");
    const starts = Number(single(event, "starts")), expiresAt = Number(single(event, "expiration"));
    if (!Number.isSafeInteger(event.created_at) || event.created_at > seconds + 30 || event.created_at < seconds - 300
      || !/^\d+$/u.test(single(event, "starts") || "") || !/^\d+$/u.test(single(event, "expiration") || "")) return null;
    const relayTags = event.tags.filter((tag) => tag[0] === "relays");
    if (relayTags.length !== 1) return null;
    const value = policy({ streamEvent, swarmId, manifestUrl: single(event, "streaming"), relays: relayTags[0].slice(1), status, starts, expiresAt, now, allowLoopback });
    if (expiresAt > event.created_at + 300 || starts > event.created_at + 30 || event.tags.filter((tag) => tag[0] === "relayswarm").length !== 1
      || !event.tags.some((tag) => tag.length === 3 && tag[0] === "relayswarm" && tag[1] === "redistribute" && tag[2] === "1")) return null;
    if (status === "ended" && (!/^\d+$/u.test(single(event, "ends") || "") || Number(single(event, "ends")) > seconds + 30 || Number(single(event, "ends")) < starts)) return null;
    if (status === "live" && event.tags.some((tag) => tag[0] === "ends")) return null;
    if (manifestUrl !== undefined && value.manifestUrl !== endpoint(manifestUrl, "https:", "http:", allowLoopback)) return null;
    if (relays !== undefined) {
      const expected = policy({ streamEvent, swarmId, manifestUrl: value.manifestUrl, relays, status, starts, expiresAt, now, allowLoopback }).relays;
      if (JSON.stringify(value.relays) !== JSON.stringify(expected)) return null;
    }
    return structuredClone(event);
  } catch { return null; }
}
