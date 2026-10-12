import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { commitmentContent, KIND_SEGMENT_COMMITMENT } from "./browser/segment-commitment.mjs";

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
export async function createHlsPublisher({ mediaDir, manifest = "master.m3u8", secretKey = generateSecretKey(), swarmId, now = Date.now } = {}) {
  const root = await realpath(resolve(mediaDir));
  const manifestPath = mediaPath(manifest, PREFIX);
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(now() / 1000), tags: [["d", digest(manifestPath).slice(0, 24)], ["relayswarm", "redistribute", "1"]], content: "RelaySwarm experimental publisher" }, secretKey);
  swarmId ||= `publisher-${streamEvent.id.slice(0, 32)}`;
  if (typeof swarmId !== "string" || swarmId.length < 8 || swarmId.length > 128) throw new PublisherError("Invalid swarm id.");
  let snapshot, refreshedAt = -Infinity, pendingRefresh, signing = 0;

  async function localFile(path) {
    if (!path.startsWith(PREFIX)) throw new PublisherError("Unknown media.", 404);
    const file = await realpath(resolve(root, path.slice(PREFIX.length)));
    const rel = relative(root, file);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new PublisherError("Media leaves the published directory.", 403);
    return file;
  }
  async function playlist(path) {
    const handle = await open(await localFile(path), "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_PLAYLIST) throw new PublisherError("Excessive playlist.");
      const bytes = Buffer.alloc(MAX_PLAYLIST + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_PLAYLIST) throw new PublisherError("Excessive playlist.");
      return bytes.subarray(0, size).toString("utf8");
    } finally { await handle.close(); }
  }
  async function refresh() {
    if (snapshot && now() - refreshedAt < 200) return snapshot;
    if (pendingRefresh) return pendingRefresh;
    pendingRefresh = (async () => {
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
      snapshot = { records, assets };
      refreshedAt = now();
      return snapshot;
    })().finally(() => { pendingRefresh = null; });
    return pendingRefresh;
  }

  await refresh();
  return {
    swarmId, streamEvent, manifestPath,
    async media(path) {
      if (!(await refresh()).assets.has(path)) throw new PublisherError("Unknown media.", 404);
      return localFile(path);
    },
    async commitment(input) {
      if (signing >= 8) throw new PublisherError("Publisher busy.", 503);
      signing++;
      try {
        const level = integer(input.level), sequence = integer(input.sequence), discontinuity = integer(input.discontinuity);
        const rangeStart = input.rangeStart === undefined || input.rangeStart === null ? null : integer(input.rangeStart);
        const rangeEnd = input.rangeEnd === undefined || input.rangeEnd === null ? null : integer(input.rangeEnd);
        if (input.part !== undefined && input.part !== null) throw new PublisherError("Parts are not supported.");
        const record = (await refresh()).records.find((entry) => entry.path === input.path && entry.level === level && entry.sequence === sequence
          && entry.discontinuity === discontinuity && entry.rangeStart === rangeStart && entry.rangeEnd === rangeEnd);
        if (!record) throw new PublisherError("Context is absent from the published playlists.", 404);
        const handle = await open(await localFile(record.path), "r");
        let bytes;
        try {
          const stat = await handle.stat();
          const start = record.rangeStart ?? 0, end = record.rangeEnd ?? stat.size, size = end - start;
          if (!stat.isFile() || size < 1 || size > MAX_SEGMENT || end > stat.size) throw new PublisherError("Media size is outside bounds.");
          bytes = Buffer.alloc(size);
          let offset = 0;
          while (offset < size) {
            const { bytesRead } = await handle.read(bytes, offset, size - offset, start + offset);
            if (!bytesRead) throw new PublisherError("Media changed during reading.", 503);
            offset += bytesRead;
          }
        } finally { await handle.close(); }
        const seconds = Math.floor(now() / 1000);
        const range = record.rangeEnd === null ? "" : `#${record.rangeStart}-${record.rangeEnd}`;
        const fields = { streamEventId: streamEvent.id, swarmId, key: digest(`${swarmId}\n${record.path}${range}`), rendition: String(level), sequence, discontinuity, part: null,
          sha256: digest(bytes), size: bytes.length, expiresAt: seconds + 60 };
        return finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds, tags: [["x", swarmId], ["e", streamEvent.id]], content: commitmentContent(fields) }, secretKey);
      } finally { signing--; }
    },
  };
}
