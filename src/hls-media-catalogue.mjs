// Local HLS catalogue only: remote/query-bearing URIs cannot widen publication.
// Complete parts and AES-128 ciphertext are assets; preload hints and key bytes
// are never authorised peer objects. DRM and SAMPLE-AES are deliberately rejected.
const MAX_RECORDS = 4096, MAX_SEGMENT = 16 * 1024 * 1024;
export class HlsCatalogueError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const fail = (message) => { throw new HlsCatalogueError(message); };
export function hlsInteger(value) {
  const number = typeof value === "number" ? value : /^\d+$/u.test(value || "") ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) fail("Invalid media context.");
  return number;
}
export function localMediaPath(uri, parent) {
  if (!uri || /[?%#\\\s]/u.test(uri) || /^[a-z]+:/iu.test(uri) || uri.startsWith("//")) fail("Only local media URIs are supported.");
  const path = new URL(uri, `https://publisher.invalid${parent}`).pathname;
  if (!path.startsWith("/media/") || !/^[a-z0-9_./-]+$/iu.test(path)) fail("Media URI leaves the published directory.");
  return path;
}
function lines(text) {
  if (!text.startsWith("#EXTM3U")) fail("Invalid HLS playlist.");
  return text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}
function attributes(text) {
  const result = {}; let offset = 0;
  for (const match of text.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)(?:,|$)/gu)) {
    if (match.index !== offset || Object.hasOwn(result, match[1])) fail("Invalid HLS attributes.");
    result[match[1]] = match[2].replace(/^"|"$/gu, ""); offset = match.index + match[0].length;
  }
  if (offset !== text.length) fail("Invalid HLS attributes.");
  return result;
}
export function parseHlsMaster(text, path) {
  const variants = [], audio = []; let pending;
  for (const line of lines(text)) {
    if (line.startsWith("#EXT-X-I-FRAME-STREAM-INF:")) fail("Iframe variants are not supported by this publisher.");
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = attributes(line.slice(13));
      if (attrs.TYPE !== "AUDIO") fail("Only alternate audio renditions are supported.");
      if (!attrs["GROUP-ID"] || !attrs.NAME) fail("Audio rendition requires a group and name.");
      if (attrs.URI) audio.push({ path: localMediaPath(attrs.URI, path), mediaType: "audio", group: attrs["GROUP-ID"] });
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      if (pending) fail("Incomplete variant.");
      pending = attributes(line.slice(18));
    } else if (!line.startsWith("#") && pending) {
      const dimensions = /^(\d+)x(\d+)$/u.exec(pending.RESOLUTION || "");
      const bandwidth = hlsInteger(pending["AVERAGE-BANDWIDTH"] || pending.BANDWIDTH);
      if (!bandwidth || (pending.RESOLUTION && !dimensions)) fail("Variant requires valid bandwidth and resolution.");
      if (pending["HDCP-LEVEL"] || pending["VIDEO-RANGE"] && pending["VIDEO-RANGE"] !== "SDR") fail("Only SDR variants without HDCP constraints are supported.");
      const frameRate = Number(pending["FRAME-RATE"] || 0);
      if (!Number.isFinite(frameRate) || frameRate < 0 || frameRate > 240) fail("Invalid variant frame rate.");
      variants.push({ path: localMediaPath(line, path), bandwidth, height: dimensions ? Number(dimensions[2]) : 0,
        codecs: pending.CODECS || "", frameRate, mediaType: "main", audioGroup: pending.AUDIO });
      pending = null;
    }
  }
  if (pending || variants.length > 8 || audio.length > 32 || audio.length && !variants.length) fail("Invalid or excessive variants.");
  const wide = audio.length > 0 || variants.some((entry) => entry.codecs !== variants[0].codecs || entry.frameRate !== variants[0].frameRate);
  variants.sort((a, b) => a.height - b.height || a.frameRate - b.frameRate || a.bandwidth - b.bandwidth);
  return { variants, audio, wide };
}
function byteRange(text, path, previous) {
  const match = /^(\d+)(?:@(\d+))?$/u.exec(text);
  if (!match) fail("Invalid byte range.");
  const size = hlsInteger(match[1]);
  if (!size || size > MAX_SEGMENT) fail("Excessive byte range.");
  const start = match[2] === undefined ? previous?.path === path ? previous.rangeEnd : null : hlsInteger(match[2]);
  if (start === null || start === undefined) fail("Implicit byte range has no predecessor.");
  return { rangeStart: start, rangeEnd: hlsInteger(start + size) };
}
function encryptedContext(key, sequence) {
  if (!key) return null;
  return { method: "AES-128", keyPath: key.keyPath, iv: key.iv || BigInt(sequence).toString(16).padStart(32, "0"), keyFormat: "identity" };
}
export function parseHlsMedia(text, path, level, { mediaType = "main", allowEncryptedMedia = false, previousCatalogue } = {}) {
  const records = [], assets = new Set(), keys = new Set();
  let sequence = 0, discontinuity = 0, range, previous, duration = false, partIndex = 0, key = null, map = null, skipSeen = false, mediaSeen = false;
  const add = (record) => {
    records.push(record); assets.add(record.path);
    if (record.map) assets.add(record.map.path);
    if (record.encryption) keys.add(record.encryption.keyPath);
    if (records.length > MAX_RECORDS) fail("Excessive playlist length.");
  };
  const record = (uri, rangeText, part) => {
    const mediaPath = localMediaPath(uri, path);
    return { path: mediaPath, playlist: path, mediaType, level, sequence, discontinuity, part,
      ...(rangeText ? byteRange(rangeText, mediaPath, previous) : { rangeStart: null, rangeEnd: null }), encryption: encryptedContext(key, sequence), map };
  };
  for (const line of lines(text)) {
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) { if (mediaSeen || skipSeen) fail("Late media sequence."); sequence = hlsInteger(line.slice(22)); }
    else if (line.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE:")) { if (mediaSeen || skipSeen) fail("Late discontinuity sequence."); discontinuity = hlsInteger(line.slice(30)); }
    else if (line === "#EXT-X-DISCONTINUITY") discontinuity++;
    else if (line.startsWith("#EXT-X-KEY:")) {
      const attrs = attributes(line.slice(11));
      if (attrs.METHOD === "NONE") { key = null; continue; }
      if (!allowEncryptedMedia) fail("Encrypted HLS requires explicit key publication consent.");
      if (attrs.METHOD !== "AES-128" || attrs.KEYFORMAT && attrs.KEYFORMAT !== "identity" || attrs.KEYFORMATVERSIONS && attrs.KEYFORMATVERSIONS !== "1") fail("Only identity AES-128 encryption is supported.");
      if (attrs.IV && !/^0x[0-9a-f]{32}$/iu.test(attrs.IV)) fail("Invalid encryption IV.");
      key = { keyPath: localMediaPath(attrs.URI, path), iv: attrs.IV ? attrs.IV.slice(2).toLowerCase() : null };
      keys.add(key.keyPath);
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = attributes(line.slice(11)), uri = localMediaPath(attrs.URI, path);
      if (key && !key.iv) fail("Encrypted init maps require an explicit IV.");
      map = { path: uri, ...(attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, uri, null) : { rangeStart: null, rangeEnd: null }) };
      assets.add(uri);
    } else if (line.startsWith("#EXT-X-SKIP:")) {
      if (skipSeen || mediaSeen) fail("Invalid delta playlist ordering.");
      const count = hlsInteger(attributes(line.slice(12))["SKIPPED-SEGMENTS"]);
      if (!count || count > MAX_RECORDS || !previousCatalogue) fail("Delta playlist has no verified predecessor.");
      const endSequence = hlsInteger(sequence + count);
      let last;
      for (let sn = sequence; sn < endSequence; sn++) {
        const restored = previousCatalogue.records.filter((entry) => entry.sequence === sn);
        last = restored.find((entry) => entry.part === null);
        if (!last) fail("Delta playlist skips unavailable contexts.");
        for (const entry of restored) add(entry);
      }
      // A delta inherits the state immediately following its skipped segments.
      // The previous catalogue was obtained through the same bounded/stat-checked
      // playlist path; a cold start cannot authorise omitted data.
      previous = last; discontinuity = last.discontinuity; key = last.encryption ? { keyPath: last.encryption.keyPath, iv: last.keyIv ?? null } : null; map = last.map;
      sequence = hlsInteger(sequence + count); skipSeen = true;
    } else if (line.startsWith("#EXT-X-PART:")) {
      const attrs = attributes(line.slice(12));
      if (!(Number(attrs.DURATION) > 0) || !Number.isFinite(Number(attrs.DURATION))) fail("Invalid part duration.");
      if (attrs.GAP === "YES") {
        if (++partIndex > 1024) fail("Excessive parts per segment.");
        continue;
      }
      const part = record(attrs.URI, attrs.BYTERANGE, partIndex++); part.keyIv = key?.iv ?? null;
      add(part); previous = part; mediaSeen = true;
      if (partIndex > 1024) fail("Excessive parts per segment.");
    } else if (line.startsWith("#EXTINF:")) { if (duration || !(Number(line.slice(8).split(",")[0]) > 0)) fail("Invalid segment duration."); duration = true; }
    else if (line.startsWith("#EXT-X-BYTERANGE:")) { if (range) fail("Invalid byte range."); range = line.slice(17); }
    else if (!line.startsWith("#")) {
      if (!duration) fail("Media URI has no duration.");
      const segment = record(line, range, null); segment.keyIv = key?.iv ?? null;
      add(segment); previous = segment; sequence = hlsInteger(sequence + 1); partIndex = 0; range = null; duration = false; mediaSeen = true;
    }
  }
  if (range || duration || !records.length) fail("Incomplete media playlist.");
  // A key may be published over HTTP only and never double as a peer object.
  for (const keyPath of keys) if (assets.has(keyPath) || keyPath === path) fail("Encryption keys cannot be media assets.");
  return { records, assets, keys };
}
