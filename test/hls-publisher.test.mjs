import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rename, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createHlsPublisher } from "../src/hls-publisher.mjs";
import { verifySegmentCommitment } from "../src/browser/segment-commitment.mjs";
import { httpRange } from "../demo/server.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const media = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-DISCONTINUITY-SEQUENCE:2\n#EXTINF:2,\n#EXT-X-BYTERANGE:4@0\nshared.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\n#EXT-X-BYTERANGE:4\nshared.ts\n#EXT-X-ENDLIST\n";
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-publisher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.m3u8"), media);
  await writeFile(join(directory, "shared.ts"), "abcdefgh");
  return directory;
}

test("publisher signs the exact playlist range and binds sequence and discontinuity", async (t) => {
  const publisher = await createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8" });
  const event = await publisher.commitment({ path: "/media/shared.ts", level: "0", sequence: "21", discontinuity: "3", rangeStart: "4", rangeEnd: "8" });
  const key = digest(`${publisher.swarmId}\n/media/shared.ts#4-8`);
  const verified = verifySegmentCommitment(event, { streamEvent: publisher.streamEvent, swarmId: publisher.swarmId, key,
    context: { frag: { level: 0, sn: 21, cc: 3 } }, maxSegmentBytes: 16 });
  assert.equal(verified.sha256, digest("efgh"));
  assert.equal(verified.size, 4);
  for (const override of [{ sequence: 20 }, { discontinuity: 2 }, { level: 1 }, { rangeStart: 0, rangeEnd: 8 }, { rangeStart: null, rangeEnd: null }, { path: "/media/private.key" }, { sequence: -1 }, { sequence: "21x" }, { part: 0 }]) {
    await assert.rejects(publisher.commitment({ path: "/media/shared.ts", level: 0, sequence: 21, discontinuity: 3, rangeStart: 4, rangeEnd: 8, ...override }));
  }
});

test("master levels follow hls.js height and bitrate order rather than URI order", async (t) => {
  const directory = await fixture(t);
  await writeFile(join(directory, "master.m3u8"), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240\nlow.m3u8\n");
  await writeFile(join(directory, "high.m3u8"), media.replaceAll("shared.ts", "high.ts"));
  await writeFile(join(directory, "low.m3u8"), media);
  await writeFile(join(directory, "high.ts"), "12345678");
  const publisher = await createHlsPublisher({ mediaDir: directory });
  const request = { level: 0, sequence: 20, discontinuity: 2, rangeStart: 0, rangeEnd: 4 };
  assert.equal(JSON.parse((await publisher.commitment({ ...request, path: "/media/shared.ts" })).content).sha256, digest("abcd"));
  await assert.rejects(publisher.commitment({ ...request, path: "/media/high.ts" }));
  assert.equal(JSON.parse((await publisher.commitment({ ...request, level: 1, path: "/media/high.ts" })).content).sha256, digest("1234"));
});

test("publisher removes retired live contexts and rejects unlisted files", async (t) => {
  let at = Date.now();
  const directory = await fixture(t);
  await writeFile(join(directory, "private.key"), "must never be served");
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8", now: () => at });
  await assert.rejects(publisher.media("/media/private.key"));
  const input = { path: "/media/shared.ts", level: 0, sequence: 20, discontinuity: 2, rangeStart: 0, rangeEnd: 4 };
  await publisher.commitment(input);
  await writeFile(join(directory, "index.m3u8"), media.replace("SEQUENCE:20", "SEQUENCE:22")); at += 201;
  await assert.rejects(publisher.commitment(input));
  assert.equal(JSON.parse((await publisher.commitment({ ...input, sequence: 22 })).content).sequence, 22);
});

test("publisher rejects directory escapes, ambiguous ranges and unsupported manifests", async (t) => {
  const directory = await fixture(t);
  for (const body of [media.replaceAll("shared.ts", "../private.ts"), media.replaceAll("shared.ts", "https://cdn.example/seg.ts"), media.replace("4@0", "4"), media.replace("#EXTINF:2,", '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,'), media.replace("#EXTINF:2,", '#EXT-X-PART:DURATION=0,URI="part.ts"\n#EXTINF:2,')]) {
    await writeFile(join(directory, "index.m3u8"), body);
    await assert.rejects(createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" }));
  }
});

test("listed symlinks cannot expose files outside the media directory", { skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t);
  const outside = await mkdtemp(join(tmpdir(), "relayswarm-outside-test-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "secret.ts"), "private");
  await symlink(join(outside, "secret.ts"), join(directory, "escape.ts"));
  await writeFile(join(directory, "index.m3u8"), media.replaceAll("shared.ts", "escape.ts"));
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  await assert.rejects(publisher.media("/media/escape.ts"), /leaves/u);
  await assert.rejects(publisher.commitment({ path: "/media/escape.ts", level: 0, sequence: 20, discontinuity: 2, rangeStart: 0, rangeEnd: 4 }), /leaves/u);
});

test("HTTP range handling uses inclusive HTTP ends and rejects multiple or invalid ranges", () => {
  assert.deepEqual(httpRange("bytes=4-7", 8), { start: 4, end: 7 });
  assert.deepEqual(httpRange("bytes=4-", 8), { start: 4, end: 7 });
  assert.deepEqual(httpRange("bytes=4-100", 8), { start: 4, end: 7 });
  for (const range of ["bytes=8-9", "bytes=-4", "bytes=7-4", "bytes=0-1,4-7", "bytes=9007199254740993-"]) assert.throws(() => httpRange(range, 8), { status: 416 });
});

test("publisher bounds concurrent signing and refuses oversized playlists and ranges", async (t) => {
  const directory = await fixture(t);
  // Nine distinct contexts: identical requests share one slot.
  await writeFile(join(directory, "index.m3u8"), `#EXTM3U\n${Array.from({ length: 9 }, (_, index) => `#EXTINF:2,\n#EXT-X-BYTERANGE:1@${index}\nshared.ts\n`).join("")}#EXT-X-ENDLIST\n`);
  await writeFile(join(directory, "shared.ts"), "abcdefghi");
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  const input = (sequence) => ({ path: "/media/shared.ts", level: 0, sequence, discontinuity: 0, rangeStart: sequence, rangeEnd: sequence + 1 });
  const pending = Array.from({ length: 8 }, (_, sequence) => publisher.commitment(input(sequence)));
  await assert.rejects(publisher.commitment(input(8)), { status: 503 });
  pending.push(publisher.commitment(input(0)));
  await Promise.all(pending);
  assert.equal(publisher.getMetrics().busyRejected, 1);
  assert.equal(publisher.getMetrics().commitmentJoins, 1);
  await publisher.commitment(input(8)); // Rejected work does not retain a slot.
  await writeFile(join(directory, "index.m3u8"), `${media}${"# padding\n".repeat(30000)}`);
  await assert.rejects(createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" }), /Excessive playlist/u);
  await writeFile(join(directory, "index.m3u8"), media.replace("4@0", "16777217@0"));
  await assert.rejects(createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" }), /Excessive byte range/u);
});

const firstRange = { path: "/media/shared.ts", level: 0, sequence: 20, discontinuity: 2, rangeStart: 0, rangeEnd: 4 };

test("publisher caches immutable events, deduplicates hashes and renews expired commitments", async (t) => {
  let at = Date.now();
  const publisher = await createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8", now: () => at });
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => publisher.commitment(firstRange)));
  assert.ok(concurrent.every((event) => event.id === concurrent[0].id));
  assert.equal(publisher.getMetrics().hashReads, 1);
  assert.equal(publisher.getMetrics().commitmentsSigned, 1);
  const original = concurrent[0].id;
  concurrent[0].content = "caller mutation";
  publisher.streamEvent.id = "caller mutation";
  assert.equal((await publisher.commitment(firstRange)).id, original);
  const hashCacheHitsBeforeRenewal = publisher.getMetrics().hashCacheHits;
  at += 61000;
  const renewed = await publisher.commitment(firstRange);
  assert.notEqual(renewed.id, original);
  assert.equal(JSON.parse(renewed.content).expiresAt, Math.floor(at / 1000) + 60);
  assert.equal(publisher.getMetrics().hashReads, 1);
  assert.equal(publisher.getMetrics().hashCacheHits, hashCacheHitsBeforeRenewal + 1);
  assert.equal(publisher.getMetrics().renewals, 1);
  assert.equal(publisher.getMetrics().inFlight, 0);
});

test("publisher invalidates same-path changes immediately and keeps ranges distinct", async (t) => {
  const directory = await fixture(t);
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  const initial = await publisher.commitment(firstRange);
  const second = { ...firstRange, sequence: 21, discontinuity: 3, rangeStart: 4, rangeEnd: 8 };
  assert.equal(JSON.parse((await publisher.commitment(second)).content).sha256, digest("efgh"));
  await writeFile(join(directory, "shared.ts"), "12345678");
  const changed = await publisher.commitment(firstRange);
  assert.equal(JSON.parse(changed.content).sha256, digest("1234"));
  assert.notEqual(changed.id, initial.id);
  await writeFile(join(directory, "index.m3u8"), media.replace("SEQUENCE:20", "SEQUENCE:22"));
  await assert.rejects(publisher.commitment(firstRange), { status: 404 });
  assert.equal(publisher.getMetrics().commitmentCacheEntries, 0);
  assert.equal(publisher.getMetrics().hashCacheEntries, 2);
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\nother.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "other.ts"), "other");
  await publisher.media("/media/other.ts");
  assert.equal(publisher.getMetrics().hashCacheEntries, 0);
});

test("publisher bounds cache entries and concurrent work without retaining rejected slots", async (t) => {
  const publisher = await createHlsPublisher({ mediaDir: await fixture(t), manifest: "index.m3u8", maxCacheEntries: 1, maxConcurrent: 2 });
  const pending = [publisher.commitment(firstRange), publisher.commitment({ ...firstRange, sequence: 21, discontinuity: 3, rangeStart: 4, rangeEnd: 8 })];
  await assert.rejects(publisher.commitment({ ...firstRange, playlist: "/media/index.m3u8", mediaType: "main" }), { status: 503 });
  await Promise.all(pending);
  await publisher.commitment({ ...firstRange, sequence: 21, discontinuity: 3, rangeStart: 4, rangeEnd: 8 });
  assert.equal(publisher.getMetrics().hashCacheEntries, 1);
  assert.equal(publisher.getMetrics().commitmentCacheEntries, 1);
  assert.equal(publisher.getMetrics().peakInFlight, 2);
  assert.equal(publisher.getMetrics().busyRejected, 1);
  assert.ok(publisher.getMetrics().cacheEvictions >= 2);
  assert.equal(publisher.getMetrics().inFlight, 0);
});

test("publisher rejects bytes mutated during a successful full-length read", async (t) => {
  const { open } = await import("node:fs/promises");
  const directory = await fixture(t);
  const file = join(directory, "shared.ts");
  const probe = await open(file, "r");
  const prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  let mutated = false;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await originalRead.apply(this, args);
    if (!mutated && args[0].length === 4) {
      mutated = true;
      await writeFile(file, "12345678");
    }
    return result;
  });
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  await assert.rejects(publisher.commitment(firstRange), /changed during reading/u);
  assert.equal(publisher.getMetrics().changedReads, 1);
  assert.equal(publisher.getMetrics().commitmentsSigned, 0);
  assert.equal(publisher.getMetrics().hashCacheEntries, 0);
  assert.equal(publisher.getMetrics().inFlight, 0);
});

test("atomic playlist races retry fresh verified data once, evict old contexts and bound repeated mutation", async (t) => {
  const { open } = await import("node:fs/promises");
  const directory = await fixture(t), path = join(directory, "index.m3u8");
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  const retired = await publisher.commitment(firstRange);
  await writeFile(join(directory, "fresh.ts"), "ijklmnop");
  const replacement = media.replace("SEQUENCE:20", "SEQUENCE:22").replaceAll("shared.ts", "fresh.ts");
  const freshRange = { ...firstRange, path: "/media/fresh.ts", sequence: 22 };
  const probe = await open(path, "r"), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  let mode = "once", reads = 0, mutations = 0, replacementBody = replacement, reportedRenameError = false;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await originalRead.apply(this, args);
    if (args[3] === 0 && result.bytesRead && args[0].subarray(0, 7).toString() === "#EXTM3U") {
      reads++;
      if (mode !== "idle") {
        mutations++;
        if (mode === "once") mode = "idle";
        // Rename after the old bytes were read and before their stat checks.
        const temporary = join(directory, "replacement.tmp");
        const body = `${replacementBody}\n# replacement ${mutations}\n`;
        await writeFile(temporary, body);
        try {
          await rename(temporary, path);
        } catch (error) {
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          if (!reportedRenameError) {
            t.diagnostic(`Windows open-playlist replacement returned ${error.code}; testing a real in-place mutation instead.`);
            reportedRenameError = true;
          }
          // Some Windows filesystems reject replacing an open destination.
          // Still mutate its bytes before verification and exercise the same guard.
          await writeFile(path, body);
          await rm(temporary);
        }
      }
    }
    return result;
  });

  const results = await Promise.allSettled([publisher.media("/media/fresh.ts"), publisher.commitment(freshRange), publisher.commitment(firstRange)]);
  assert.equal(results[0].status, "fulfilled", results[0].reason?.stack);
  assert.equal(results[1].status, "fulfilled", results[1].reason?.stack);
  assert.equal(results[2].status, "rejected");
  assert.equal(results[2].reason.status, 404); // Never return the cached retired commitment.
  const event = results[1].value;
  const verified = verifySegmentCommitment(event, { streamEvent: publisher.streamEvent, swarmId: publisher.swarmId,
    key: digest(`${publisher.swarmId}\n/media/fresh.ts#0-4`), context: { frag: { level: 0, sn: 22, cc: 2 } }, maxSegmentBytes: 16 });
  assert.equal(verified.sha256, digest("ijkl"));
  assert.equal(verified.size, 4);
  assert.equal(event.pubkey, retired.pubkey);
  assert.notEqual(event.id, retired.id);
  assert.equal(mutations, 1);
  assert.equal(publisher.getMetrics().playlistRetries, 1);
  assert.equal(publisher.getMetrics().changedReads, 1);
  assert.equal(publisher.getMetrics().commitmentCacheEntries, 1);
  assert.equal(publisher.getMetrics().hashCacheEntries, 1);

  mode = "repeat";
  const before = publisher.getMetrics(), readsBefore = reads;
  const rejected = await Promise.allSettled([publisher.media("/media/fresh.ts"), publisher.commitment(freshRange)]);
  assert.ok(rejected.every((result) => result.status === "rejected" && result.reason.status === 503 && /changed during reading/u.test(result.reason.message)));
  assert.equal(reads - readsBefore, 2); // Concurrent callers share the same two attempts.
  assert.equal(publisher.getMetrics().playlistRetries - before.playlistRetries, 1);
  assert.equal(publisher.getMetrics().changedReads - before.changedReads, 2);
  assert.equal(publisher.getMetrics().cacheHits, before.cacheHits);
  assert.equal(publisher.getMetrics().hashReads, before.hashReads);
  assert.equal(publisher.getMetrics().commitmentsSigned, before.commitmentsSigned);
  assert.equal(publisher.getMetrics().inFlight, 0);
  mode = "idle";
  assert.equal((await publisher.commitment(freshRange)).id, event.id); // Fresh successful validation releases the failed refresh.

  mode = "once";
  replacementBody = "#EXTM3U\n#EXTINF:2,\nhttps://untrusted.example/private.ts\n";
  const invalidReadsBefore = reads, retriesBefore = publisher.getMetrics().playlistRetries;
  await assert.rejects(publisher.commitment(freshRange), { status: 400, message: "Only local media URIs are supported." });
  assert.equal(reads - invalidReadsBefore, 2);
  assert.equal(publisher.getMetrics().playlistRetries - retriesBefore, 1);
  const ordinaryReadsBefore = reads;
  await assert.rejects(publisher.media("/media/fresh.ts"), { status: 400 });
  assert.equal(reads - ordinaryReadsBefore, 1); // Stable invalid data is never retried or served from cache.
  assert.equal(publisher.getMetrics().playlistRetries - retriesBefore, 1);
});

test("verified hashes remain deduplicated while an earlier caller waits on post-hash validation", async (t) => {
  const { open } = await import("node:fs/promises");
  const directory = await fixture(t), probe = await open(join(directory, "shared.ts"), "r");
  const prototype = Object.getPrototypeOf(probe), originalStat = prototype.stat;
  await probe.close();
  let firstFd, calls = 0, release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const gap = new Promise((resolve) => { reached = resolve; });
  t.mock.method(prototype, "stat", async function (...args) {
    const value = await originalStat.apply(this, args);
    if (value.size === 8n) {
      firstFd ??= this.fd;
      if (this.fd === firstFd && ++calls === 3) { reached(); await gate; }
    }
    return value;
  });
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  const first = publisher.commitment(firstRange);
  await gap;
  try {
    // An identical request joins the waiting one; another schema for the same
    // bytes completes from the verified digest without reading them again.
    const joined = publisher.commitment(firstRange);
    const late = await publisher.commitment({ ...firstRange, playlist: "/media/index.m3u8", mediaType: "main" });
    assert.equal(publisher.getMetrics().hashReads, 1);
    assert.equal(publisher.getMetrics().commitmentJoins, 1);
    release();
    const [early, shared] = await Promise.all([first, joined]);
    assert.equal(early.id, shared.id);
    assert.equal(JSON.parse(late.content).sha256, JSON.parse(early.content).sha256);
    assert.notEqual(late.id, early.id);
  } finally { release(); }
});

test("identical concurrent commitments share one slot, return private copies and never retain failures", async (t) => {
  const { open } = await import("node:fs/promises");
  const directory = await fixture(t), file = join(directory, "shared.ts");
  const probe = await open(file, "r"), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  let mutate = false;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await originalRead.apply(this, args);
    if (mutate && args[0].length === 4) { mutate = false; await writeFile(file, "12345678"); }
    return result;
  });
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8", maxConcurrent: 1 });
  const events = await Promise.all(Array.from({ length: 16 }, () => publisher.commitment(firstRange)));
  assert.ok(events.every((event) => event.id === events[0].id));
  const metrics = publisher.getMetrics();
  assert.deepEqual([metrics.busyRejected, metrics.peakInFlight, metrics.commitmentJoins, metrics.commitmentsSigned, metrics.hashReads, metrics.inFlight], [0, 1, 15, 1, 1, 0]);
  events[0].content = "caller mutation";
  assert.equal(events[1].content, events[2].content);
  assert.notEqual(events[1].content, "caller mutation");
  assert.equal((await publisher.commitment(firstRange)).content, events[1].content);
  // Joined callers get copies too, not the cached event or each other's.
  const signed = events[2].content;
  assert.notStrictEqual(events[1], events[2]);
  events[1].content = "joined mutation";
  assert.equal(events[2].content, signed);
  assert.equal((await publisher.commitment(firstRange)).content, signed);

  // A shared failure reaches every joined caller once; the next request starts afresh.
  mutate = true;
  const second = { ...firstRange, sequence: 21, discontinuity: 3, rangeStart: 4, rangeEnd: 8 };
  const before = publisher.getMetrics();
  const failed = await Promise.allSettled(Array.from({ length: 4 }, () => publisher.commitment(second)));
  assert.ok(failed.every((result) => result.status === "rejected" && result.reason.status === 503 && /changed during reading/u.test(result.reason.message)));
  assert.equal(publisher.getMetrics().changedReads - before.changedReads, 1);
  assert.equal(publisher.getMetrics().commitmentJoins - before.commitmentJoins, 3);
  assert.equal(publisher.getMetrics().busyRejected, 0);
  assert.equal(publisher.getMetrics().inFlight, 0);
  assert.equal(JSON.parse((await publisher.commitment(second)).content).sha256, digest("5678"));
});

test("a caller that joins after the leader's last check is held to a catalogue and file read after it arrived", async (t) => {
  const { writeFileSync, renameSync } = await import("node:fs");
  const live = (sequence) => `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:2,\nseg${sequence}.ts\n#EXTINF:2,\nseg${sequence + 1}.ts\n`;
  for (const mode of ["playlist", "segment"]) await t.test(mode, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "relayswarm-publisher-join-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    for (const sequence of [20, 21, 22]) await writeFile(join(directory, `seg${sequence}.ts`), `bytes-${sequence}`);
    await writeFile(join(directory, "index.m3u8"), live(20));
    let hook = null, calls = 0, late = null;
    const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8", now: () => { hook?.(++calls); return Date.now(); } });
    const input = { path: "/media/seg20.ts", level: 0, sequence: 20, discontinuity: 0 };
    // The leader's third clock read is its signing time, after its final
    // catalogue and stat checks. The change and the joiner both follow it.
    hook = (call) => {
      if (call !== 3) return;
      hook = null;
      const [temporary, target, body] = mode === "playlist" ? ["next.m3u8", "index.m3u8", live(21)] : ["next.ts", "seg20.ts", "replaced-20"];
      writeFileSync(join(directory, temporary), body); renameSync(join(directory, temporary), join(directory, target));
      late = publisher.commitment(input);
      late.catch(() => {});
    };
    const leader = await publisher.commitment(input);
    assert.equal(JSON.parse(leader.content).sha256, digest("bytes-20"));
    assert.equal(publisher.getMetrics().commitmentJoins, 1);
    if (mode === "playlist") await assert.rejects(late, { status: 404 });
    else {
      await assert.rejects(late, { status: 503 });
      assert.equal(JSON.parse((await publisher.commitment(input)).content).sha256, digest("replaced-20"));
    }
  });
});

test("unchanged playlists reuse their parsed catalogue but every request rereads and compares exact bytes", async (t) => {
  const { open, stat, utimes } = await import("node:fs/promises");
  const directory = await fixture(t);
  await writeFile(join(directory, "master.m3u8"), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360\nhigh.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240\nlow.m3u8\n");
  await writeFile(join(directory, "high.m3u8"), media.replaceAll("shared.ts", "high.ts"));
  await writeFile(join(directory, "low.m3u8"), media);
  await writeFile(join(directory, "high.ts"), "12345678");
  const probe = await open(join(directory, "low.m3u8"), "r"), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  let playlistReads = 0;
  t.mock.method(prototype, "read", async function (...args) {
    const result = await originalRead.apply(this, args);
    if (args[3] === 0 && result.bytesRead && args[0].subarray(0, 7).toString() === "#EXTM3U") playlistReads++;
    return result;
  });
  const publisher = await createHlsPublisher({ mediaDir: directory });
  const low = { path: "/media/shared.ts", level: 0, sequence: 20, discontinuity: 2, rangeStart: 0, rangeEnd: 4 };
  const high = { ...low, level: 1, path: "/media/high.ts" };
  playlistReads = 0;
  for (let index = 0; index < 3; index++) await publisher.media("/media/high.ts");
  assert.equal(playlistReads, 9); // Master and both renditions on every refresh.
  assert.equal(JSON.parse((await publisher.commitment(high)).content).sha256, digest("1234"));
  // A same-size rewrite with restored modification time is still detected.
  const path = join(directory, "high.m3u8"), times = await stat(path);
  await writeFile(path, media.replace("SEQUENCE:20", "SEQUENCE:30").replaceAll("shared.ts", "high.ts"));
  await utimes(path, times.atime, times.mtime);
  await assert.rejects(publisher.commitment(high), { status: 404 });
  assert.equal(JSON.parse((await publisher.commitment({ ...high, sequence: 30 })).content).sequence, 30);
  // The unchanged rendition keeps its contexts when another rendition changes.
  assert.equal(JSON.parse((await publisher.commitment(low)).content).sha256, digest("abcd"));
  assert.equal(publisher.getMetrics().changedReads, 0);
  assert.equal(publisher.getMetrics().playlistRetries, 0);
});
