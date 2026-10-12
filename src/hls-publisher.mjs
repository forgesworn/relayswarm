import { createHash } from "node:crypto";
import { open, realpath, stat as fileStat } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { commitmentContent, KIND_SEGMENT_COMMITMENT } from "./browser/segment-commitment.mjs";
import { publisherManifestPath, publisherSwarmId, publisherStreamEvent, validatePublisherStreamEvent } from "./publisher-state.mjs";

const PREFIX = "/media/";
const MAX_PLAYLIST = 256 * 1024;
const MAX_SEGMENT = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 4096;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export class PublisherError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function integer(value) {
  const parsed = typeof value === "number" ? value : /^\d+$/u.test(value || "") ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PublisherError("Invalid media context.");
  return parsed;
}

function mediaPath(uri, parent) {
  if (!uri || /[?%#\\\s]/u.test(uri) || /^[a-z]+:/iu.test(uri) || uri.startsWith("//")) throw new PublisherError("Only local media URIs are supported.");
  const path = new URL(uri, `https://publisher.invalid${parent}`).pathname;
  if (!path.startsWith(PREFIX) || !/^[a-z0-9_./-]+$/iu.test(path)) throw new PublisherError("Media URI leaves the published directory.");
  return path;
}

function lines(text) {
  if (!text.startsWith("#EXTM3U")) throw new PublisherError("Invalid HLS playlist.");
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function variants(text, path) {
  const result = [];
  let attributes;
  for (const line of lines(text)) {
    if (/^#EXT-X-(MEDIA:|I-FRAME-STREAM-INF:)/u.test(line)) throw new PublisherError("Alternate audio and iframe playlists are not supported by this publisher.");
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      attributes = Object.fromEntries([...line.slice(18).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/gu)].map((match) => [match[1], match[2].replace(/^"|"$/gu, "")]));
    } else if (!line.startsWith("#") && attributes) {
      const dimensions = /^(\d+)x(\d+)$/u.exec(attributes.RESOLUTION || "");
      const bandwidth = integer(attributes["AVERAGE-BANDWIDTH"] || attributes.BANDWIDTH);
      if (!bandwidth || !dimensions) throw new PublisherError("Variant requires bandwidth and resolution.");
      if (attributes["HDCP-LEVEL"] || (attributes["VIDEO-RANGE"] && attributes["VIDEO-RANGE"] !== "SDR")) throw new PublisherError("Only SDR variants without HDCP constraints are supported.");
      result.push({ path: mediaPath(line, path), bandwidth, height: Number(dimensions[2]), codecs: attributes.CODECS || "", frameRate: attributes["FRAME-RATE"] || "" });
      attributes = null;
    }
  }
  if (attributes || result.length > 8) throw new PublisherError("Invalid or excessive variants.");
  // hls.js orders levels by height, frame rate, codec and bitrate. This
  // small publisher requires one codec/frame-rate family and sorts by the
  // remaining fields, so request-supplied level numbers cannot choose a digest.
  if (result.some((entry) => entry.codecs !== result[0].codecs || entry.frameRate !== result[0].frameRate)) throw new PublisherError("Variants must use one codec and frame-rate family.");
  return result.sort((a, b) => a.height - b.height || a.bandwidth - b.bandwidth);
}

function fragments(text, path, level) {
  const records = [];
  const assets = new Set();
  let sequence = 0, discontinuity = 0, range = null, previous = null, hasDuration = false;
  for (const line of lines(text)) {
    if (line.startsWith("#EXT-X-KEY:") && !line.includes("METHOD=NONE")) throw new PublisherError("Encrypted HLS is not supported by this publisher.");
    if (/^#EXT-X-(PART:|SKIP:)/u.test(line)) throw new PublisherError("Partial and delta playlists are not supported by this publisher.");
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) sequence = integer(line.slice(22));
    else if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) discontinuity = integer(line.slice(30));
    else if (line === "#EXT-X-DISCONTINUITY") discontinuity++;
    else if (line.startsWith("#EXTINF:")) hasDuration = true;
    else if (line.startsWith("#EXT-X-MAP:")) {
      const uri = /URI="([^"]+)"/u.exec(line)?.[1];
      assets.add(mediaPath(uri, path));
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const match = /^(\d+)(?:@(\d+))?$/u.exec(line.slice(17));
      if (!match || range) throw new PublisherError("Invalid byte range.");
      range = { size: integer(match[1]), start: match[2] === undefined ? null : integer(match[2]) };
      if (!range.size || range.size > MAX_SEGMENT) throw new PublisherError("Excessive byte range.");
    } else if (!line.startsWith("#")) {
      if (!hasDuration) throw new PublisherError("Media URI has no duration.");
      const uri = mediaPath(line, path);
      let start = null, end = null;
      if (range) {
        start = range.start ?? (previous?.path === uri ? previous.rangeEnd : null);
        if (start === null) throw new PublisherError("Implicit byte range has no predecessor.");
        end = integer(start + range.size);
      }
      const record = { path: uri, level, sequence: sequence++, discontinuity, rangeStart: start, rangeEnd: end };
      records.push(record);
      assets.add(uri);
      previous = record;
      range = null;
      hasDuration = false;
      if (records.length > MAX_FRAGMENTS) throw new PublisherError("Excessive playlist length.");
    }
  }
  if (range || hasDuration || !records.length) throw new PublisherError("Incomplete media playlist.");
  return { records, assets };
}

/** Node-only publisher for local, full-segment HLS. Keeps the signing key on
 * the server and derives the signed context from its playlists, never from an
 * arbitrary path/digest submitted by a viewer. See docs/FIELD-TEST.md. */
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const contextKey = (record) => JSON.stringify([record.path, record.level, record.sequence, record.discontinuity, record.rangeStart, record.rangeEnd]);
const assetKey = (record) => JSON.stringify([record.path, record.rangeStart, record.rangeEnd]);

export async function createHlsPublisher({ mediaDir, manifest = "master.m3u8", secretKey = generateSecretKey(), swarmId, streamEvent: restoredStreamEvent,
  now = Date.now, maxCacheEntries = 512, maxConcurrent = 8 } = {}) {
  secretKey = Uint8Array.from(secretKey);
  const root = await realpath(resolve(mediaDir));
  const manifestPath = publisherManifestPath(manifest);
  const streamEvent = restoredStreamEvent ? validatePublisherStreamEvent(restoredStreamEvent, secretKey, manifestPath) : publisherStreamEvent(secretKey, manifestPath, now);
  swarmId = publisherSwarmId(swarmId ?? `publisher-${streamEvent.id.slice(0, 32)}`);
  for (const [value, maximum] of [[maxCacheEntries, MAX_FRAGMENTS], [maxConcurrent, 64]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new PublisherError("Invalid publisher resource limit.");
  }
  const hashes = new Map(), commitments = new Map(), pendingHashes = new Map();
  const changedPlaylists = new WeakSet();
  const metrics = { requests: 0, cacheHits: 0, hashCacheHits: 0, hashReads: 0, hashesComputed: 0, commitmentsSigned: 0,
    renewals: 0, cacheEvictions: 0, changedReads: 0, playlistRetries: 0, busyRejected: 0, inFlight: 0, peakInFlight: 0 };
  let snapshot, pendingRefresh;
  function retain(map, key, value) {
    map.delete(key); map.set(key, value);
    while (map.size > maxCacheEntries) { map.delete(map.keys().next().value); metrics.cacheEvictions++; }
  }
  function changed(isPlaylist = false) {
    metrics.changedReads++;
    const error = new PublisherError("Media changed during reading.", 503);
    if (isPlaylist) changedPlaylists.add(error);
    return error;
  }
  async function localFile(path) {
    if (!path.startsWith(PREFIX)) throw new PublisherError("Unknown media.", 404);
    const file = await realpath(resolve(root, path.slice(PREFIX.length)));
    const rel = relative(root, file);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new PublisherError("Media leaves the published directory.", 403);
    return file;
  }
  async function unchanged(handle, file, before, isPlaylist = false) {
    const after = await handle.stat({ bigint: true });
    const current = await fileStat(file, { bigint: true });
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(current)) throw changed(isPlaylist);
  }
  async function playlist(path) {
    const file = await localFile(path), handle = await open(file, "r");
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_PLAYLIST)) throw new PublisherError("Excessive playlist.");
      const bytes = Buffer.alloc(MAX_PLAYLIST + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_PLAYLIST) throw new PublisherError("Excessive playlist.");
      await unchanged(handle, file, before, true);
      if (BigInt(size) !== before.size) throw changed(true);
      return bytes.subarray(0, size).toString("utf8");
    } finally { await handle.close(); }
  }
  async function catalogue() {
    const text = await playlist(manifestPath);
    const levels = variants(text, manifestPath);
    const entries = levels.length ? levels : [{ path: manifestPath }];
    const records = [], assets = new Set([manifestPath]);
    for (const [level, entry] of entries.entries()) {
      assets.add(entry.path);
      const media = fragments(levels.length ? await playlist(entry.path) : text, entry.path, level);
      records.push(...media.records);
      for (const asset of media.assets) assets.add(asset);
    }
    const contexts = new Map(records.map((record) => [contextKey(record), record]));
    const authorisedAssets = new Set(records.map(assetKey));
    return { records, assets, contexts, authorisedAssets };
  }
  async function refresh() {
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        let next;
        try { next = await catalogue(); }
        catch (error) {
          if (attempt !== 0 || !changedPlaylists.has(error)) throw error;
          // An atomic playlist replacement may race its stat checks. Re-read
          // the whole catalogue once; no previous snapshot authorises fallback.
          metrics.playlistRetries++;
          continue;
        }
        for (const key of commitments.keys()) if (!next.contexts.has(key)) { commitments.delete(key); metrics.cacheEvictions++; }
        for (const key of hashes.keys()) if (!next.authorisedAssets.has(key)) { hashes.delete(key); metrics.cacheEvictions++; }
        snapshot = next;
        return snapshot;
      }
    })().finally(() => { pendingRefresh = null; });
    return pendingRefresh;
  }
  async function hashRecord(record, file, handle, before) {
    const key = assetKey(record), version = stamp(before);
    const cached = hashes.get(key);
    if (cached?.version === version) { metrics.hashCacheHits++; retain(hashes, key, cached); return cached; }
    const pendingKey = `${key}\n${version}`;
    if (pendingHashes.has(pendingKey)) return pendingHashes.get(pendingKey);
    const task = (async () => {
      const start = record.rangeStart ?? 0, end = record.rangeEnd ?? Number(before.size), size = end - start;
      if (!before.isFile() || size < 1 || size > MAX_SEGMENT || BigInt(end) > before.size) throw new PublisherError("Media size is outside bounds.");
      const hash = createHash("sha256"), bytes = Buffer.alloc(Math.min(size, 64 * 1024));
      metrics.hashReads++;
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, size - offset), start + offset);
        if (!bytesRead) throw changed();
        hash.update(bytes.subarray(0, bytesRead)); offset += bytesRead;
      }
      await unchanged(handle, file, before);
      metrics.hashesComputed++;
      return { version, sha256: hash.digest("hex"), size };
    })();
    pendingHashes.set(pendingKey, task);
    try { return await task; } finally { pendingHashes.delete(pendingKey); }
  }

  await refresh();
  return {
    swarmId, streamEvent: structuredClone(streamEvent), manifestPath,
    getMetrics() { return { ...metrics, hashCacheEntries: hashes.size, commitmentCacheEntries: commitments.size,
      maxConcurrent, maxCacheEntries }; },
    async media(path) {
      if (!(await refresh()).assets.has(path)) throw new PublisherError("Unknown media.", 404);
      return localFile(path);
    },
    async commitment(input) {
      metrics.requests++;
      if (metrics.inFlight >= maxConcurrent) { metrics.busyRejected++; throw new PublisherError("Publisher busy.", 503); }
      metrics.inFlight++; metrics.peakInFlight = Math.max(metrics.peakInFlight, metrics.inFlight);
      try {
        const level = integer(input.level), sequence = integer(input.sequence), discontinuity = integer(input.discontinuity);
        const rangeStart = input.rangeStart === undefined || input.rangeStart === null ? null : integer(input.rangeStart);
        const rangeEnd = input.rangeEnd === undefined || input.rangeEnd === null ? null : integer(input.rangeEnd);
        if (input.part !== undefined && input.part !== null) throw new PublisherError("Parts are not supported.");
        const key = contextKey({ path: input.path, level, sequence, discontinuity, rangeStart, rangeEnd });
        const record = (await refresh()).contexts.get(key);
        if (!record) throw new PublisherError("Context is absent from the published playlists.", 404);
        const file = await localFile(record.path), handle = await open(file, "r");
        try {
          const before = await handle.stat({ bigint: true }), version = stamp(before);
          const seconds = Math.floor(now() / 1000), cached = commitments.get(key);
          if (cached?.version === version && cached.expiresAt > seconds + 5 && cached.event.created_at <= seconds + 30 && cached.event.created_at >= seconds - 120) {
            if (!(await refresh()).contexts.has(key)) throw new PublisherError("Context is absent from the published playlists.", 404);
            await unchanged(handle, file, before);
            metrics.cacheHits++; retain(commitments, key, cached);
            return structuredClone(cached.event);
          }
          const hash = await hashRecord(record, file, handle, before);
          await unchanged(handle, file, before);
          if (!(await refresh()).contexts.has(key)) throw new PublisherError("Context is absent from the published playlists.", 404);
          await unchanged(handle, file, before);
          retain(hashes, assetKey(record), hash);
          // Another caller may have signed this same digest while we awaited IO.
          const signedAt = Math.floor(now() / 1000), ready = commitments.get(key);
          if (ready?.version === version && ready.expiresAt > signedAt + 5 && ready.event.created_at <= signedAt + 30 && ready.event.created_at >= signedAt - 120) {
            metrics.cacheHits++; return structuredClone(ready.event);
          }
          const range = record.rangeEnd === null ? "" : `#${record.rangeStart}-${record.rangeEnd}`;
          const fields = { streamEventId: streamEvent.id, swarmId, key: digest(`${swarmId}\n${record.path}${range}`), rendition: String(level), sequence, discontinuity, part: null,
            sha256: hash.sha256, size: hash.size, expiresAt: signedAt + 60 };
          const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: signedAt, tags: [["x", swarmId], ["e", streamEvent.id]], content: commitmentContent(fields) }, secretKey);
          if (cached?.version === version) metrics.renewals++;
          metrics.commitmentsSigned++;
          retain(commitments, key, { version, expiresAt: fields.expiresAt, event });
          return structuredClone(event);
        } finally { await handle.close(); }
      } finally { metrics.inFlight--; }
    },
  };
}
