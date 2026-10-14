import { watch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { PublisherError } from "../src/hls-publisher.mjs";

const MAX_BYTES = 256 * 1024, BLOCKED_LIMIT = 24;
const unavailable = () => new PublisherError("Playlist reload unavailable.", 503);
const invalid = () => new PublisherError("Invalid playlist reload directive.", 400);

// Complete-segment mode only. Imported low-latency/delta/VOD representations
// retain their bytes and are never given a capability this server cannot fulfil.
export function completePlaylist(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_BYTES || !/^#EXTM3U(?:\r?\n|$)/u.test(text)) return null;
  const lines = text.split(/\r?\n/u).map(line => line.trim());
  if (lines[0] !== "#EXTM3U" || lines.includes("#EXT-X-ENDLIST") || lines.some(line => line.startsWith("#EXT-X-PLAYLIST-TYPE:") && line !== "#EXT-X-PLAYLIST-TYPE:EVENT") || lines.some(line => /^#EXT-X-(?:PART|PART-INF|PRELOAD-HINT|SKIP|RENDITION-REPORT):/u.test(line))) return null;
  const targets = lines.filter(line => line.startsWith("#EXT-X-TARGETDURATION:"));
  const sequences = lines.filter(line => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
  if (targets.length !== 1 || sequences.length > 1 || !/^#EXT-X-TARGETDURATION:[1-3]$/u.test(targets[0])) return null;
  const sequence = sequences.length ? sequences[0].slice(22) : "0";
  if (!/^\d+$/u.test(sequence) || !Number.isSafeInteger(Number(sequence))) return null;
  const count = lines.filter(line => line && !line.startsWith("#")).length;
  const last = Number(sequence) + count - 1;
  if (!count || !Number.isSafeInteger(last) || !Number.isSafeInteger(last + 2)) return null;
  const controls = lines.filter(line => line.startsWith("#EXT-X-SERVER-CONTROL:"));
  if (controls.length > 1) return null;
  const attrs = new Map();
  if (controls.length) {
    const input = controls[0].slice(22); let offset = 0;
    for (const match of input.matchAll(/([A-Z-]+)=([^,]+)(?:,|$)/gu)) {
      if (match.index !== offset || attrs.has(match[1]) || !["CAN-BLOCK-RELOAD", "HOLD-BACK"].includes(match[1])) return null;
      if (match[1] === "CAN-BLOCK-RELOAD" && !["YES", "NO"].includes(match[2])) return null;
      if (match[1] === "HOLD-BACK" && (!/^\d+(?:\.\d+)?$/u.test(match[2]) || !Number.isFinite(Number(match[2])) || Number(match[2]) < 3 * Number(targets[0].slice(22)))) return null;
      attrs.set(match[1], match[2]); offset = match.index + match[0].length;
    }
    if (offset !== input.length || !attrs.size) return null;
  }
  attrs.set("CAN-BLOCK-RELOAD", "YES");
  const control = [...attrs].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join(",");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const replacement = `#EXT-X-SERVER-CONTROL:${control}`;
  const body = controls.length ? text.replace(/^[ \t]*#EXT-X-SERVER-CONTROL:[^\r\n]*/mu, replacement)
    : text.replace(/^(#EXTM3U)(\r?\n|$)/u, `$1${eol}${replacement}${eol}`);
  if (Buffer.byteLength(body) > MAX_BYTES) return null;
  return { last, targetDuration: Number(targets[0].slice(22)), control, body };
}

function representation(snapshot, enabled) {
  if (!enabled || !snapshot.isMedia) return null;
  const media = snapshot.mediaPlaylists.map(entry => completePlaylist(entry.text));
  if (!media.length || media.some(entry => !entry || entry.control !== media[0].control)) return null;
  return completePlaylist(snapshot.bytes.toString("utf8"));
}

// Range offsets and HEAD length refer to the transformed representation.
export async function sendPlaylistResponse(response, bytes, { range = null, head = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const done = (error) => {
      response.off("finish", finished); response.off("close", finished); response.off("error", failed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const finished = () => done(), failed = error => done(error);
    const aborted = () => { try { response.destroy(); } catch (error) { done(error); } };
    response.once("finish", finished); response.once("close", finished); response.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    try {
      if (response.destroyed || response.writableFinished) { done(); return; }
      if (signal?.aborted) { aborted(); return; }
      const start = range?.start ?? 0, end = range?.end ?? bytes.length - 1;
      response.writeHead(range ? 206 : 200, { "content-type": "application/vnd.apple.mpegurl", "content-length": end - start + 1,
        "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}) });
      response.end(head ? undefined : bytes.subarray(start, end + 1));
    } catch (error) { done(error); }
  });
}

/** No polling or seed fetches: one shared parent-directory watch per directory,
 * armed before a fresh publisher catalogue read. Every wake reauthorises the
 * current presentation and returns the very buffer whose sequence was checked. */
export function createBlockingPlaylistReload({ publisher, enabled = true, platform = process.platform, watchDirectory = watch, directoryIdentity = async directory => {
  const value = await stat(directory, { bigint: true });
  if (!value.isDirectory()) throw unavailable();
  return `${value.dev}:${value.ino}`;
}, now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (typeof enabled !== "boolean") throw new TypeError("Invalid blocking playlist policy.");
  const directories = new Map(), liveWatchers = new Set(), tasks = new Set(), wakeups = new Set();
  const counts = { activeBlocked: 0, started: 0, released: 0, aborted: 0, timedOut: 0, watchErrors: 0, rejected: 0 };
  let closed = false, revision = 0;
  function wake() { revision++; for (const callback of [...wakeups]) callback(); }
  function closeWatch(watcher) {
    if (!watcher) return;
    watcher.close(); watcher.removeAllListeners(); liveWatchers.delete(watcher);
  }
  function coverage(files) {
    const result = new Map();
    const entry = directory => { if (!result.has(directory)) result.set(directory, { direct: false, children: new Set() }); return result.get(directory); };
    for (const file of files) entry(dirname(file)).direct = true;
    if (platform === "win32") for (const [directory] of [...result]) {
      const parent = dirname(directory);
      if (parent !== directory) entry(parent).children.add(basename(directory).toLowerCase());
    }
    return result;
  }
  function notify(entry, _event, filename) {
    const subscriptions = [...entry.subscriptions.values()];
    if (subscriptions.some(value => value.direct)) { wake(); return; }
    // A Windows shallow ancestor sees child-directory moves even when the
    // directory's own watcher does not. Ignore unrelated sibling activity.
    if (typeof filename !== "string" || filename.length > 4096) { entry.failed = true; counts.watchErrors++; wake(); return; }
    if (subscriptions.some(value => value.children.has(filename.toLowerCase()))) wake();
  }
  function acquire(directory, token, subscription) {
    let entry = directories.get(directory);
    if (!entry) {
      entry = { users: 0, failed: false, watcher: null, identity: null, rearming: null, subscriptions: new Map() };
      directories.set(directory, entry);
    }
    entry.users++; entry.subscriptions.set(token, subscription); return entry;
  }
  async function ensureWatch(directory, entry) {
    if (entry.failed) throw unavailable();
    let current;
    try { current = await directoryIdentity(directory); } catch { throw unavailable(); }
    // A delayed stat result must join a replacement already being installed;
    // matching the old identity cannot authorise bypassing that handover.
    if (entry.rearming) { await entry.rearming; return true; }
    if (current === entry.identity) return false;
    entry.rearming = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await directoryIdentity(directory);
        let candidate, failed = false;
        try {
          candidate = watchDirectory(directory, { persistent: false }, (event, filename) => notify(entry, event, filename));
          liveWatchers.add(candidate);
          candidate.on("error", () => { failed = true; counts.watchErrors++; if (candidate === entry.watcher) entry.failed = true; wake(); });
          const after = await directoryIdentity(directory);
          if (before !== after) { closeWatch(candidate); continue; }
          if (failed || entry.failed) throw unavailable();
          // Install and identity-check the new watch before closing the old one.
          // Shared readers hold this entry, never a stale watcher reference.
          const previous = entry.watcher;
          entry.watcher = candidate; entry.identity = after; closeWatch(previous);
          wake(); return;
        } catch { closeWatch(candidate); throw unavailable(); }
      }
      throw unavailable();
    })();
    try { await entry.rearming; return true; } finally { entry.rearming = null; }
  }
  function release(directory, token) {
    const entry = directories.get(directory);
    entry?.subscriptions.delete(token);
    if (entry && --entry.users === 0) { closeWatch(entry.watcher); directories.delete(directory); }
  }
  function check(signal) {
    if (signal?.aborted) throw new PublisherError("Playlist request cancelled.", 499);
    if (closed) throw unavailable();
  }
  function pause(version, deadline, signal) {
    return new Promise((resolve) => {
      let timer;
      const done = () => { clearTimer(timer); wakeups.delete(done); signal?.removeEventListener("abort", done); resolve(); };
      wakeups.add(done); signal?.addEventListener("abort", done, { once: true });
      timer = setTimer(done, Math.max(0, deadline - now()));
      if (closed || signal?.aborted || revision !== version) done();
    });
  }
  async function read(path, query = new URLSearchParams(), { signal, startedAt = now() } = {}) {
    if (tasks.size >= 32) { counts.rejected++; throw unavailable(); }
    let settle;
    const task = new Promise(resolve => { settle = resolve; }); tasks.add(task);
    const held = new Map(), token = Symbol(); let blocked = false, deadline;
    try {
      check(signal);
      let readRevision = revision;
      let snapshot = await publisher.playlistSnapshot(path);
      check(signal);
      // Disabled control profile has no watchers or directive interpretation.
      if (!enabled) return snapshot.bytes;
      let changes = 0;
      for (;;) {
        check(signal);
        const scopes = coverage(snapshot.playlistFiles), wanted = new Set(scopes.keys());
        // Eligibility is presentation-wide and independent of concurrent load.
        // Unsupported Windows coverage keeps valid HTTP bytes, without a claim.
        if (wanted.size > 41) return snapshot.bytes;
        const pathsChanged = [...wanted].some(directory => !held.has(directory)) || [...held.keys()].some(directory => !wanted.has(directory));
        for (const directory of wanted) {
          if (!held.has(directory)) held.set(directory, acquire(directory, token, scopes.get(directory)));
          else held.get(directory).subscriptions.set(token, scopes.get(directory));
        }
        for (const directory of held.keys()) if (!wanted.has(directory)) { release(directory, token); held.delete(directory); }
        let rearmed = false;
        for (const [directory, entry] of held) if (await ensureWatch(directory, entry)) rearmed = true;
        check(signal);
        if (pathsChanged || rearmed || revision !== readRevision) {
          if (++changes > 3) throw unavailable();
          // Recheck both directory identity and catalogue generation before any
          // return, including an already-ready response after a watch event.
          readRevision = revision;
          snapshot = await publisher.playlistSnapshot(path, { fresh: true });
          continue;
        }
        const version = readRevision, info = representation(snapshot, enabled);
        // ENDLIST, master and unsupported presentations keep the original bytes.
        if (!info) return snapshot.bytes;
        const body = Buffer.from(info.body);
        const msns = query.getAll("_HLS_msn"), parts = query.getAll("_HLS_part");
        if (parts.length || msns.length > 1 || msns.length && (!/^\d+$/u.test(msns[0]) || !Number.isSafeInteger(Number(msns[0])))) throw invalid();
        if (!msns.length) return body;
        const msn = Number(msns[0]);
        if (msn > info.last + 2) throw invalid();
        if (msn <= info.last) { if (blocked) counts.released++; return body; }
        if (!blocked) {
          if (counts.activeBlocked >= BLOCKED_LIMIT) { counts.rejected++; throw unavailable(); }
          deadline = startedAt + info.targetDuration * 3000;
          blocked = true; counts.activeBlocked++; counts.started++;
        }
        // This snapshot is also the final fresh read after the deadline wake.
        if (now() >= deadline) { counts.timedOut++; throw unavailable(); }
        await pause(version, deadline, signal);
        check(signal);
        readRevision = revision;
        snapshot = await publisher.playlistSnapshot(path, { fresh: true });
      }
    } catch (error) {
      if (signal?.aborted) counts.aborted++;
      throw error;
    } finally {
      if (blocked) counts.activeBlocked--;
      for (const directory of held.keys()) release(directory, token);
      tasks.delete(task); settle();
    }
  }
  return { read, snapshot: () => ({ enabled, blockedLimit: BLOCKED_LIMIT, ...counts, watchers: liveWatchers.size }),
    async close() { closed = true; wake(); await Promise.all([...tasks]); } };
}
