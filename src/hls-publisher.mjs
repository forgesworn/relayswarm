import { createHash } from "node:crypto";
import { open, realpath, stat as fileStat } from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { commitmentContent, commitmentPieceSize, KIND_SEGMENT_COMMITMENT, verifyCommitmentDelegation } from "./browser/segment-commitment.mjs";
import { publisherManifestPath, publisherSwarmId, publisherStreamEvent, validatePublisherStreamEvent } from "./publisher-state.mjs";

import { createPublisherAdvertisement, verifyPublisherAdvertisement } from "./publisher-advertisement.mjs";
import { parseHlsMaster, parseHlsMedia, hlsInteger } from "./hls-media-catalogue.mjs";

const PREFIX = "/media/";
const MAX_PLAYLIST = 256 * 1024;
const MAX_SEGMENT = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 4096;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export class PublisherError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const integer = hlsInteger;

/** Node-only publisher for local HLS segments and complete parts. Keeps the signing key on
 * the server and derives the signed context from its playlists, never from an
 * arbitrary path/digest submitted by a viewer. See docs/FIELD-TEST.md. */
const stamp = (stat) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const contextKey = (record) => JSON.stringify([record.path, record.level, record.sequence, record.discontinuity, record.rangeStart, record.rangeEnd, record.playlist ?? null, record.mediaType ?? "main", record.part ?? null, record.encryption ?? null]);
const assetKey = (record) => JSON.stringify([record.path, record.rangeStart, record.rangeEnd]);

export async function createHlsPublisher({ mediaDir, manifest = "master.m3u8", secretKey, swarmId, streamEvent: restoredStreamEvent,
  now = Date.now, maxCacheEntries = 512, maxConcurrent = 8, allowEncryptedMedia = false, commitmentSecretKey, delegation,
  revokedDelegationIds = [], delegationRevocations = [], pieceCommitments = false } = {}) {
  const externalAuthor = !secretKey && !!restoredStreamEvent && !!commitmentSecretKey && !!delegation;
  secretKey = externalAuthor ? null : Uint8Array.from(secretKey ?? generateSecretKey());
  const signingKey = commitmentSecretKey ? Uint8Array.from(commitmentSecretKey) : secretKey;
  const signerPubkey = getPublicKey(signingKey);
  delegation = delegation ? structuredClone(delegation) : undefined;
  if (typeof allowEncryptedMedia !== "boolean") throw new PublisherError("Invalid encrypted-media policy.");
  if (typeof pieceCommitments !== "boolean") throw new PublisherError("Invalid piece commitment policy.");
  const root = await realpath(resolve(mediaDir));
  const manifestPath = publisherManifestPath(manifest);
  const streamEvent = restoredStreamEvent ? validatePublisherStreamEvent(restoredStreamEvent, secretKey, manifestPath, { allowExternalAuthor: externalAuthor }) : publisherStreamEvent(secretKey, manifestPath, now);
  swarmId = publisherSwarmId(swarmId ?? `publisher-${streamEvent.id.slice(0, 32)}`);
  for (const [value, maximum] of [[maxCacheEntries, MAX_FRAGMENTS], [maxConcurrent, 64]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new PublisherError("Invalid publisher resource limit.");
  }
  function signingScope(at) {
    if (signerPubkey === streamEvent.pubkey) return null;
    const scope = verifyCommitmentDelegation(delegation, { streamEvent, swarmId, revokedDelegationIds, delegationRevocations }, at);
    if (!scope || scope.delegatePubkey !== signerPubkey) throw new PublisherError("Commitment delegation is absent, expired or revoked.", 403);
    return scope;
  }
  signingScope(now());
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
      return { file, bytes: bytes.subarray(0, size), text: bytes.subarray(0, size).toString("utf8") };
    } finally { await handle.close(); }
  }
  async function catalogue() {
    const initial = await playlist(manifestPath), text = initial.text;
    const playlists = new Map([[manifestPath, initial]]);
    const master = parseHlsMaster(text, manifestPath);
    const entries = master.variants.length ? [...master.variants, ...master.audio] : [{ path: manifestPath, mediaType: "main" }];
    const records = [], assets = new Set([manifestPath]), keys = new Set(), mediaCatalogues = new Map();
    for (const [level, entry] of entries.entries()) {
      assets.add(entry.path);
      const body = master.variants.length ? await playlist(entry.path) : initial;
      playlists.set(entry.path, body);
      const media = parseHlsMedia(body.text, entry.path, level,
        { mediaType: entry.mediaType, allowEncryptedMedia, previousCatalogue: snapshot?.mediaCatalogues.get(entry.path) });
      mediaCatalogues.set(entry.path, media);
      records.push(...media.records);
      for (const asset of media.assets) assets.add(asset);
      for (const key of media.keys) keys.add(key);
    }
    if (records.length > MAX_FRAGMENTS) throw new PublisherError("Excessive catalogue length.");
    for (const key of keys) if (assets.has(key)) throw new PublisherError("Encryption keys cannot be media assets.");
    const contexts = new Map(records.map((record) => [contextKey(record), record]));
    const authorisedAssets = new Set(records.map(assetKey));
    return { records, assets, contexts, authorisedAssets, keys, mediaCatalogues, playlists, wide: master.wide };
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
        for (const key of commitments.keys()) if (!next.contexts.has(key.slice(3))) { commitments.delete(key); metrics.cacheEvictions++; }
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
      // Schema 3: one digest per piece, from the same read pass.
      const pieceSize = pieceCommitments ? commitmentPieceSize(size) : 0, pieces = [];
      let piece = pieceCommitments ? createHash("sha256") : null, pieceFill = 0;
      metrics.hashReads++;
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, size - offset), start + offset);
        if (!bytesRead) throw changed();
        const chunk = bytes.subarray(0, bytesRead);
        hash.update(chunk); offset += bytesRead;
        for (let at = 0; piece && at < chunk.length;) {
          const take = Math.min(chunk.length - at, pieceSize - pieceFill);
          piece.update(chunk.subarray(at, at + take)); at += take; pieceFill += take;
          if (pieceFill === pieceSize) { pieces.push(piece.digest("hex")); piece = createHash("sha256"); pieceFill = 0; }
        }
      }
      if (piece && pieceFill) pieces.push(piece.digest("hex"));
      await unchanged(handle, file, before);
      metrics.hashesComputed++;
      const result = { version, sha256: hash.digest("hex"), size, ...(pieceCommitments ? { pieceSize, pieces } : {}) };
      // Publish the verified digest before releasing the pending task. A late
      // caller may arrive while the first caller revalidates its playlist.
      retain(hashes, key, result);
      return result;
    })();
    pendingHashes.set(pendingKey, task);
    try { return await task; } finally { pendingHashes.delete(pendingKey); }
  }

  await refresh();
  return {
    swarmId, streamEvent: structuredClone(streamEvent), manifestPath,
    ...(delegation ? { delegation: structuredClone(delegation) } : {}),
    advertisement({ event, previousEvent, manifestUrl, relays, status = "live", starts, expiresAt, allowLoopback = false } = {}) {
      if (event) {
        const verified = verifyPublisherAdvertisement(event, { streamEvent, swarmId, manifestUrl, relays, now, allowLoopback });
        if (!verified || verified.tags.find((tag) => tag[0] === "status")?.[1] !== status) throw new PublisherError("Invalid externally signed advertisement.", 403);
        return verified;
      }
      if (!secretKey) throw new PublisherError("Delegate-only publishers require externally signed advertisements.", 403);
      return createPublisherAdvertisement({ secretKey, streamEvent, swarmId, previousEvent, manifestUrl, relays, status, starts, expiresAt, now, allowLoopback });
    },
    getMetrics() { return { ...metrics, hashCacheEntries: hashes.size, commitmentCacheEntries: commitments.size,
      maxConcurrent, maxCacheEntries }; },
    // HTTP playlist representations reuse the same bounded, stat-checked reads
    // as authorisation. No segment/key body is exposed through this snapshot.
    async playlistSnapshot(path, { fresh = false } = {}) {
      // A directory watch may have been installed after a shared refresh began.
      // Settle that read before starting/joining the next coalesced catalogue.
      if (fresh && pendingRefresh) await pendingRefresh;
      const next = await refresh(), body = next.playlists.get(path);
      if (!body || !next.assets.has(path)) throw new PublisherError("Unknown playlist.", 404);
      if (await localFile(path) !== body.file) throw changed(true);
      return { file: body.file, bytes: Buffer.from(body.bytes), playlistFiles: [...next.playlists.values()].map(entry => entry.file), isMedia: next.mediaCatalogues.has(path),
        mediaPlaylists: [...next.mediaCatalogues.keys()].map((key) => ({ file: next.playlists.get(key).file, text: next.playlists.get(key).text })) };
    },
    async media(path) {
      const catalogue = await refresh();
      if (catalogue.keys.has(path)) {
        // Explicit publication consent permits identity AES-128 keys over HTTP
        // only. Their fixed size is validated separately from segment objects.
        const file = await localFile(path), stat = await fileStat(file);
        if (!stat.isFile() || stat.size !== 16) throw new PublisherError("AES-128 key must contain exactly 16 bytes.");
        return file;
      }
      if (!catalogue.assets.has(path)) throw new PublisherError("Unknown media.", 404);
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
        const part = input.part === undefined || input.part === null ? null : integer(input.part);
        const next = await refresh(), wide = input.playlist !== undefined && input.playlist !== null;
        const mediaType = input.mediaType ?? "main";
        if (!["main", "audio"].includes(mediaType)) throw new PublisherError("Invalid media type.");
        if (!wide && (next.wide || mediaType !== "main")) throw new PublisherError("Exact playlist identity is required for these renditions.");
        const record = next.records.find((entry) => entry.path === input.path && entry.sequence === sequence && entry.discontinuity === discontinuity
          && entry.rangeStart === rangeStart && entry.rangeEnd === rangeEnd && entry.part === part
          && (wide ? entry.playlist === input.playlist && entry.mediaType === mediaType : entry.level === level && !entry.encryption));
        if (!record) throw new PublisherError("Context is absent from the published playlists.", 404);
        // Piece commitments need exact playlist identity, as schema 2 does.
        const schema = wide ? (pieceCommitments ? 3 : 2) : 1;
        const contextId = contextKey(record), key = `v${schema}:${contextId}`, scope = signingScope(now());
        const rendition = wide ? record.playlist : String(level);
        if (scope && (!scope.renditions.includes(rendition) || !scope.mediaTypes.includes(record.mediaType) || part !== null && !scope.allowParts)) throw new PublisherError("Media is outside the commitment delegation scope.", 403);
        const file = await localFile(record.path), handle = await open(file, "r");
        try {
          const before = await handle.stat({ bigint: true }), version = stamp(before);
          const seconds = Math.floor(now() / 1000), cached = commitments.get(key);
          if (cached?.version === version && cached.expiresAt > seconds + 5 && (!scope || cached.expiresAt <= scope.expiresAt) && cached.event.created_at <= seconds + 30 && cached.event.created_at >= seconds - 120) {
            if (!(await refresh()).contexts.has(contextId)) throw new PublisherError("Context is absent from the published playlists.", 404);
            await unchanged(handle, file, before);
            signingScope(now());
            metrics.cacheHits++; retain(commitments, key, cached);
            return structuredClone(cached.event);
          }
          const hash = await hashRecord(record, file, handle, before);
          await unchanged(handle, file, before);
          if (!(await refresh()).contexts.has(contextId)) throw new PublisherError("Context is absent from the published playlists.", 404);
          await unchanged(handle, file, before);
          retain(hashes, assetKey(record), hash);
          // Another caller may have signed this same digest while we awaited IO.
          const signedAt = Math.floor(now() / 1000), ready = commitments.get(key);
          if (ready?.version === version && ready.expiresAt > signedAt + 5 && (!scope || ready.expiresAt <= scope.expiresAt) && ready.event.created_at <= signedAt + 30 && ready.event.created_at >= signedAt - 120) {
            signingScope(now());
            metrics.cacheHits++; return structuredClone(ready.event);
          }
          const range = record.rangeEnd === null ? "" : `#${record.rangeStart}-${record.rangeEnd}`;
          const currentScope = signingScope(now());
          if (currentScope && hash.size > currentScope.maxSegmentBytes) throw new PublisherError("Media exceeds the delegation size limit.", 403);
          const fields = { ...(wide ? { v: schema, playlist: record.playlist, mediaType: record.mediaType, encryption: record.encryption } : {}),
            ...(schema === 3 ? { pieceSize: hash.pieceSize, pieces: hash.pieces } : {}), streamEventId: streamEvent.id, swarmId, key: digest(`${swarmId}\n${record.path}${range}`), rendition, sequence, discontinuity, part,
            sha256: hash.sha256, size: hash.size, expiresAt: Math.min(signedAt + 60, currentScope?.expiresAt ?? Infinity) };
          const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: signedAt, tags: [["x", swarmId], ["e", streamEvent.id], ...(currentScope ? [["delegation", delegation.id]] : [])], content: commitmentContent(fields) }, signingKey);
          if (cached?.version === version) metrics.renewals++;
          metrics.commitmentsSigned++;
          retain(commitments, key, { version, expiresAt: fields.expiresAt, event });
          return structuredClone(event);
        } finally { await handle.close(); }
      } finally { metrics.inFlight--; }
    },
  };
}
