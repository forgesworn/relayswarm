import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createHlsPublisher } from "../src/hls-publisher.mjs";
import { parseHlsMedia } from "../src/hls-media-catalogue.mjs";
import { verifySegmentCommitment, segmentMediaContext } from "../src/browser/segment-commitment.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t, files) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-hls-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files)) await writeFile(join(directory, name), body);
  return realpath(directory);
}
const plain = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXTINF:2,\nshared.m4s\n";
function verify(publisher, event, input, decryptdata) {
  const range = input.rangeEnd == null ? "" : `#${input.rangeStart}-${input.rangeEnd}`;
  return verifySegmentCommitment(event, { streamEvent: publisher.streamEvent, swarmId: publisher.swarmId,
    key: digest(`${publisher.swarmId}\n${input.path}${range}`), maxSegmentBytes: 1024,
    context: { frag: { level: input.level, sn: input.sequence, cc: input.discontinuity, type: input.mediaType ?? "main",
      baseurl: `https://example.test${input.playlist}`, decryptdata }, ...(input.part == null ? {} : { part: { index: input.part } }) } });
}

test("mixed codec/frame-rate variants and alternate audio bind exact playlist identities after player filtering", async (t) => {
  const directory = await fixture(t, { "master.m3u8": '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x360,CODECS="hvc1.1.6.L93.B0,mp4a.40.2",FRAME-RATE=60,AUDIO="a"\nhevc.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.42e01e,mp4a.40.2",FRAME-RATE=30,AUDIO="a"\navc.m3u8\n',
    "hevc.m3u8": plain, "avc.m3u8": plain, "audio.m3u8": plain.replace("shared.m4s", "audio.m4s"), "shared.m4s": "video", "audio.m4s": "audio" });
  const publisher = await createHlsPublisher({ mediaDir: directory });
  const input = { path: "/media/shared.m4s", playlist: "/media/hevc.m3u8", mediaType: "main", level: 0, sequence: 10, discontinuity: 0 };
  const event = await publisher.commitment(input); // Host may filter out AVC, renumbering HEVC to zero.
  assert.equal(verify(publisher, event, input).rendition, "/media/hevc.m3u8");
  assert.equal(verify(publisher, event, { ...input, playlist: "/media/avc.m3u8" }), null);
  assert.equal(verify(publisher, event, { ...input, mediaType: "audio" }), null);
  await assert.rejects(publisher.commitment({ ...input, playlist: undefined }), /Exact playlist/u);
  await assert.rejects(publisher.commitment({ ...input, playlist: "/media/audio.m3u8" }));
  const audio = { ...input, path: "/media/audio.m4s", playlist: "/media/audio.m3u8", mediaType: "audio" };
  assert.equal(verify(publisher, await publisher.commitment(audio), audio).sha256, digest("audio"));
});

test("fMP4 init maps use HTTP while complete LL parts sign their exact sequence/index/range", async (t) => {
  const body = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-MAP:URI="init.mp4",BYTERANGE="4@0"\n#EXT-X-PART:DURATION=0.2,URI="shared.m4s",BYTERANGE="4@0"\n#EXT-X-PART:DURATION=0.2,URI="shared.m4s",BYTERANGE="4"\n#EXTINF:2,\nshared.m4s\n#EXT-X-PART:DURATION=0.2,URI="next.m4s"\n#EXT-X-PRELOAD-HINT:TYPE=PART,URI="future.m4s"\n';
  const directory = await fixture(t, { "index.m3u8": body, "init.mp4": "init", "shared.m4s": "abcdefgh", "next.m4s": "next", "future.m4s": "future" });
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  assert.equal(await publisher.media("/media/init.mp4"), join(directory, "init.mp4"));
  const input = { path: "/media/shared.m4s", playlist: "/media/index.m3u8", level: 0, sequence: 10, discontinuity: 0, rangeStart: 4, rangeEnd: 8, part: 1 };
  assert.equal(verify(publisher, await publisher.commitment(input), input).sha256, digest("efgh"));
  await assert.rejects(publisher.commitment({ ...input, part: 0 }));
  await assert.rejects(publisher.commitment({ ...input, path: "/media/init.mp4" }));
  await assert.rejects(publisher.media("/media/future.m4s"));
  assert.equal(JSON.parse((await publisher.commitment({ ...input, path: "/media/next.m4s", sequence: 11, part: 0, rangeStart: null, rangeEnd: null })).content).part, 0);
});

test("delta playlists inherit only bounded previously verified skipped contexts and fail closed at cold start", async (t) => {
  const full = plain + "#EXT-X-DISCONTINUITY\n#EXTINF:2,\nnext.m4s\n";
  const delta = "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nnext.m4s\n";
  const directory = await fixture(t, { "index.m3u8": full, "shared.m4s": "old", "next.m4s": "fresh" });
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  await writeFile(join(directory, "index.m3u8"), delta);
  const input = { path: "/media/next.m4s", playlist: "/media/index.m3u8", level: 0, sequence: 11, discontinuity: 1 };
  assert.equal(verify(publisher, await publisher.commitment(input), input).sha256, digest("fresh"));
  await assert.rejects(createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" }), /verified predecessor/u);
  await writeFile(join(directory, "index.m3u8"), delta.replace("SEGMENTS=1", "SEGMENTS=3"));
  await assert.rejects(publisher.commitment(input), /unavailable contexts/u);
  assert.throws(() => parseHlsMedia(delta.replace("SEQUENCE:10", "SEQUENCE:9007199254740991"), "/media/index.m3u8", 0, { previousCatalogue: { records: [] } }));
});

test("AES-128 is explicit ciphertext publication, keys remain HTTP-only, IV changes invalidate context", async (t) => {
  const body = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-KEY:METHOD=AES-128,URI="content.key"\n#EXTINF:2,\nshared.m4s\n';
  const directory = await fixture(t, { "index.m3u8": body, "content.key": Buffer.alloc(16, 1), "shared.m4s": Buffer.alloc(16, 2) });
  await assert.rejects(createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" }), /explicit/u);
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8", allowEncryptedMedia: true });
  const input = { path: "/media/shared.m4s", playlist: "/media/index.m3u8", level: 0, sequence: 10, discontinuity: 0 };
  const decrypt = { method: "AES-128", uri: "https://example.test/media/content.key", iv: Uint8Array.from(Buffer.from("0000000000000000000000000000000a", "hex")) };
  const event = await publisher.commitment(input);
  assert.equal(verify(publisher, event, input, decrypt).sha256, digest(Buffer.alloc(16, 2)));
  assert.equal(verify(publisher, event, input, { ...decrypt, iv: Buffer.alloc(16) }), null);
  assert.equal(await publisher.media("/media/content.key"), join(directory, "content.key"));
  await assert.rejects(publisher.commitment({ ...input, path: "/media/content.key" }));
  await assert.rejects(publisher.commitment({ ...input, playlist: undefined }));
  await writeFile(join(directory, "content.key"), "oversize secret signing material");
  await assert.rejects(publisher.media("/media/content.key"), /exactly 16/u);
  for (const replacement of ['METHOD=SAMPLE-AES,URI="content.key"', 'METHOD=AES-128,URI="https://remote.test/key"', 'METHOD=AES-128,URI="shared.m4s"']) {
    await writeFile(join(directory, "index.m3u8"), body.replace('METHOD=AES-128,URI="content.key"', replacement));
    await assert.rejects(publisher.commitment(input));
  }
});

test("context extraction excludes unknown queries, remote keys, invalid protocols and subtitles", () => {
  const context = { frag: { baseurl: "https://example.test/media/index.m3u8?_HLS_msn=12&_HLS_skip=YES", type: "audio" } };
  assert.deepEqual(segmentMediaContext(context), { playlist: "/media/index.m3u8", mediaType: "audio", encryption: null });
  for (const baseurl of ["https://example.test/media/index.m3u8?token=secret", "file:///media/index.m3u8", "https://example.test/media/index.m3u8?_HLS_msn=1&_HLS_msn=2"]) assert.equal(segmentMediaContext({ frag: { baseurl } }), null);
  assert.equal(segmentMediaContext({ frag: { ...context.frag, type: "subtitle" } }), null);
});
