import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
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
  for (const body of [media.replaceAll("shared.ts", "../private.ts"), media.replaceAll("shared.ts", "https://cdn.example/seg.ts"), media.replace("4@0", "4"), media.replace("#EXTINF:2,", '#EXT-X-KEY:METHOD=AES-128,URI="key"\n#EXTINF:2,'), media.replace("#EXTINF:2,", '#EXT-X-PART:DURATION=0.2,URI="part.ts"\n#EXTINF:2,')]) {
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
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  const input = { path: "/media/shared.ts", level: 0, sequence: 20, discontinuity: 2, rangeStart: 0, rangeEnd: 4 };
  const pending = Array.from({ length: 8 }, () => publisher.commitment(input));
  await assert.rejects(publisher.commitment(input), { status: 503 });
  await Promise.all(pending);
  await publisher.commitment(input); // Rejected work does not retain a slot.
  await writeFile(join(directory, "index.m3u8"), `${media}${"# padding\n".repeat(30000)}`);
  await assert.rejects(createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" }), /Excessive playlist/u);
  await writeFile(join(directory, "index.m3u8"), media.replace("4@0", "16777217@0"));
  await assert.rejects(createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" }), /Excessive byte range/u);
});
