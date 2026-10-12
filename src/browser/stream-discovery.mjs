import { verifyEvent } from "nostr-tools/pure";

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const utf8 = new TextEncoder();
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class StreamDiscoveryError extends Error {
  constructor(message, code) { super(message); this.name = "StreamDiscoveryError"; this.code = code; }
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Invalid discovery ${name}.`);
  return value;
}

function list(value, maximum, name) {
  if (!(Array.isArray(value) || value instanceof Set)) throw new TypeError(`Explicit ${name} are required.`);
  if ((!value.size && !value.length) || (value.size ?? value.length) > maximum) throw new TypeError(`Invalid discovery ${name}.`);
  return [...value];
}

function safeUrl(value, protocols, allowLoopback, insecureProtocol) {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\s\\]/u.test(value)) throw new TypeError("Invalid discovery URL.");
  const url = new URL(value);
  if (url.username || url.password || url.hash || !url.hostname
    || (!protocols.includes(url.protocol) && !(allowLoopback && url.protocol === insecureProtocol && LOOPBACK.has(url.hostname)))) throw new TypeError("Unsafe discovery URL.");
  return url;
}

function icePolicy(value = []) {
  if (!Array.isArray(value) || value.length > 8) throw new TypeError("Invalid discovery ICE servers.");
  let count = 0;
  return value.map((server) => {
    if (!server || typeof server !== "object") throw new TypeError("Invalid discovery ICE server.");
    const urls = Array.isArray(server.urls) ? [...server.urls] : [server.urls];
    if (!urls.length || urls.length > 8 || (count += urls.length) > 16
      || urls.some((url) => typeof url !== "string" || url.length > 2048 || !/^(?:stun|stuns|turn|turns):[^\s\\#]+$/u.test(url))) throw new TypeError("Invalid discovery ICE URL.");
    const result = { urls: Array.isArray(server.urls) ? urls : urls[0] };
    for (const name of ["username", "credential"]) {
      if (server[name] !== undefined) {
        if (typeof server[name] !== "string" || server[name].length > 512) throw new TypeError("Invalid discovery ICE credential.");
        result[name] = server[name];
      }
    }
    return result;
  });
}

function compilePolicy(policy) {
  if (!policy || typeof policy !== "object") throw new TypeError("An explicit discovery policy is required.");
  const authors = list(policy.trustedAuthors, 64, "trusted authors");
  if (authors.some((author) => typeof author !== "string" || !HEX64.test(author))) throw new TypeError("Invalid trusted discovery author.");
  if (typeof policy.swarmId !== "string" || policy.swarmId.length < 8 || policy.swarmId.length > 128) throw new TypeError("An explicit discovery swarm id is required.");
  if (policy.allowLoopback !== undefined && typeof policy.allowLoopback !== "boolean") throw new TypeError("Invalid discovery loopback policy.");
  const allowLoopback = policy.allowLoopback === true;
  const origins = list(policy.allowedMediaOrigins, 32, "allowed media origins").map((origin) => {
    const url = safeUrl(origin, ["https:"], allowLoopback, "http:");
    if (url.pathname !== "/" || url.search) throw new TypeError("Discovery media allowlist requires exact origins.");
    return url.origin;
  });
  const relays = [...new Set(list(policy.relays, 8, "relays").map((relay) => safeUrl(relay, ["wss:"], allowLoopback, "ws:").href))];
  const now = policy.now ?? Date.now;
  if (typeof now !== "function") throw new TypeError("Invalid discovery clock.");
  const seconds = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new TypeError("Invalid discovery time.");
  return {
    authors: new Set(authors), origins: new Set(origins), relays, swarmId: policy.swarmId, iceServers: icePolicy(policy.iceServers), allowLoopback, seconds,
    maxAgeSeconds: boundedInteger(policy.maxAgeSeconds, 3600, 1, 86400, "age limit"),
    maxFutureSeconds: boundedInteger(policy.maxFutureSeconds, 30, 0, 300, "future tolerance"),
    maxEventBytes: boundedInteger(policy.maxEventBytes, 16384, 1024, 16384, "event size"),
  };
}

function single(event, name, length = 2) {
  const tags = event.tags.filter((tag) => tag[0] === name);
  return tags.length === 1 && tags[0].length === length ? tags[0] : null;
}

function oversize() { return new StreamDiscoveryError("Discovery event exceeds the size limit.", "EVENT_LIMIT"); }

function wireEvent(value, maximum) {
  if (!value || typeof value !== "object" || !Array.isArray(value.tags) || typeof value.content !== "string") return null;
  if (value.content.length > maximum || value.tags.length > 2048) throw oversize();
  if (typeof value.id !== "string" || !HEX64.test(value.id) || typeof value.pubkey !== "string" || !HEX64.test(value.pubkey)
    || typeof value.sig !== "string" || !HEX128.test(value.sig) || value.kind !== 30311
    || !Number.isSafeInteger(value.created_at) || value.created_at < 0) return null;
  let characters = value.content.length;
  const tags = [];
  for (const tag of value.tags) {
    if (!Array.isArray(tag) || !tag.length) return null;
    if (tag.length > 128) throw oversize();
    const copy = [];
    for (const field of tag) {
      if (typeof field !== "string") return null;
      characters += field.length + 3;
      if (characters > maximum) throw oversize();
      copy.push(field);
    }
    tags.push(copy);
  }
  const event = { id: value.id, pubkey: value.pubkey, created_at: value.created_at, kind: value.kind, tags, content: value.content, sig: value.sig };
  const bytes = utf8.encode(JSON.stringify(event)).length;
  if (bytes > maximum) throw oversize();
  return { event, bytes };
}

function trustedAddress(event, policy) {
  const identifier = single(event, "d")?.[1];
  if (!policy.authors.has(event.pubkey) || !identifier || identifier.length > 256
    || event.created_at > policy.seconds + policy.maxFutureSeconds || !verifyEvent(event)) return null;
  return JSON.stringify([event.pubkey, identifier]);
}

function timestampTag(event, name) {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (!matches.length) return undefined;
  if (matches.length !== 1 || matches[0].length !== 2 || !/^\d+$/u.test(matches[0][1])) return NaN;
  const value = Number(matches[0][1]);
  return Number.isSafeInteger(value) ? value : NaN;
}

function resolveEvent(event, policy) {
  if (!trustedAddress(event, policy) || event.created_at < policy.seconds - policy.maxAgeSeconds
    || single(event, "status")?.[1] !== "live" || single(event, "relayswarm", 3)?.slice(1).join(":") !== "redistribute:1") return null;
  const starts = timestampTag(event, "starts"), ends = timestampTag(event, "ends"), expiration = timestampTag(event, "expiration");
  if ((starts !== undefined && (!Number.isFinite(starts) || starts > policy.seconds + policy.maxFutureSeconds))
    || (ends !== undefined && (!Number.isFinite(ends) || ends <= policy.seconds))
    || (expiration !== undefined && (!Number.isFinite(expiration) || expiration <= policy.seconds))) return null;
  const streaming = single(event, "streaming")?.[1];
  if (!streaming) return null;
  let manifest;
  try { manifest = safeUrl(streaming, ["https:"], policy.allowLoopback, "http:"); } catch { return null; }
  if (!policy.origins.has(manifest.origin)) return null;
  const streamEvent = structuredClone(event), relays = [...policy.relays], iceServers = structuredClone(policy.iceServers);
  return { manifestUrl: manifest.href, streamEvent, swarmId: policy.swarmId, relays, iceServers,
    config: { swarmId: policy.swarmId, relays: [...relays], iceServers: structuredClone(iceServers), streamEvent: structuredClone(streamEvent), serve: false } };
}

/** Resolve signed NIP-53 metadata under explicit host trust and endpoint policy.
 * This requires full streaming/status metadata; the demo's minimal signed
 * authorisation remains a separate, valid commitment-authorisation contract.
 * No fetches, sockets, player or swarm are created. Redirects and playlist
 * asset URLs still require enforcement by the host's eventual HTTP loader. */
export function resolveTrustedStream(value, policy) {
  const compiled = compilePolicy(policy);
  try { const wire = wireEvent(value, compiled.maxEventBytes); return wire ? resolveEvent(wire.event, compiled) : null; }
  catch { return null; }
}

function compare(a, b) { return b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

/** The host supplies query({filters, relays, signal}), returning an event array
 * or async iterable. Query all statuses: selecting live first could resurrect
 * an older update after the author ended the same addressable stream. A count
 * or size overflow rejects the whole query, never returns a partial selection. */
export async function discoverTrustedStreams({ query, signal, timeoutMs = 5000, maxEvents = 256, maxResults = 32, maxTotalBytes = 2 * 1024 * 1024, ...policy } = {}) {
  const compiled = compilePolicy(policy);
  if (typeof query !== "function") throw new TypeError("An explicit host discovery query is required.");
  timeoutMs = boundedInteger(timeoutMs, 5000, 1, 60000, "timeout");
  maxEvents = boundedInteger(maxEvents, 256, 1, 1024, "event count");
  maxResults = boundedInteger(maxResults, 32, 1, 128, "result count");
  maxTotalBytes = boundedInteger(maxTotalBytes, 2 * 1024 * 1024, 1024, 16 * 1024 * 1024, "total size");
  if (signal !== undefined && (!(signal instanceof AbortSignal))) throw new TypeError("Invalid discovery abort signal.");
  const controller = new AbortController();
  const filters = [{ kinds: [30311], authors: [...compiled.authors].sort(), since: Math.max(0, compiled.seconds - compiled.maxAgeSeconds),
    until: compiled.seconds + compiled.maxFutureSeconds, limit: maxEvents }];
  let iterator, timer, onAbort;
  const deadline = performance.now() + timeoutMs;
  const abort = (error) => { if (!controller.signal.aborted) controller.abort(error); };
  const cancelled = new Promise((_, reject) => {
    const fail = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", fail, { once: true });
    onAbort = () => abort(new StreamDiscoveryError("Stream discovery was aborted.", "ABORTED"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => abort(new StreamDiscoveryError("Stream discovery timed out.", "TIMEOUT")), timeoutMs);
  });
  const work = (async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const source = await query({ filters: structuredClone(filters), relays: [...compiled.relays], signal: controller.signal });
    if (controller.signal.aborted) {
      if (source?.return) { try { Promise.resolve(source.return()).catch(() => {}); } catch {} }
      throw controller.signal.reason;
    }
    if (Array.isArray(source)) {
      if (source.length > maxEvents) throw new StreamDiscoveryError("Discovery event count exceeds the limit.", "EVENT_LIMIT");
      iterator = source[Symbol.iterator]();
    } else if (source && typeof source[Symbol.asyncIterator] === "function") iterator = source[Symbol.asyncIterator]();
    else throw new TypeError("Discovery query must return an array or async iterable.");
    const latest = new Map();
    let count = 0, totalBytes = 0;
    for (;;) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (performance.now() >= deadline) throw new StreamDiscoveryError("Stream discovery timed out.", "TIMEOUT");
      const item = await iterator.next();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (item.done) break;
      if (++count > maxEvents) throw new StreamDiscoveryError("Discovery event count exceeds the limit.", "EVENT_LIMIT");
      const wire = wireEvent(item.value, compiled.maxEventBytes);
      if (wire) {
        totalBytes += wire.bytes;
        if (totalBytes > maxTotalBytes) throw new StreamDiscoveryError("Discovery byte count exceeds the limit.", "EVENT_LIMIT");
        const address = trustedAddress(wire.event, compiled), previous = latest.get(address);
        if (address && (!previous || compare(wire.event, previous) < 0)) latest.set(address, wire.event);
      }
      // Let cancellation/timers run even for an immediately yielding flood.
      if (count % 16 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    compiled.seconds = Math.floor((policy.now ?? Date.now)() / 1000);
    if (!Number.isSafeInteger(compiled.seconds) || compiled.seconds < 0) throw new TypeError("Invalid discovery time.");
    const results = [];
    for (const event of [...latest.values()].sort(compare)) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (performance.now() >= deadline) throw new StreamDiscoveryError("Stream discovery timed out.", "TIMEOUT");
      const resolved = resolveEvent(event, compiled);
      if (resolved) results.push(resolved);
      if (results.length === maxResults) break;
    }
    return results;
  })();
  try { return await Promise.race([work, cancelled]); }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    abort(new StreamDiscoveryError("Stream discovery finished.", "FINISHED"));
    // An uncooperative async iterator must not hold up timeout or cancellation.
    if (iterator?.return) { try { Promise.resolve(iterator.return()).catch(() => {}); } catch {} }
  }
}
