import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, rm, chmod, symlink, stat } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startBroadcastPipeline, broadcastEncoderArgs, broadcastForwardArgs } from "../src/broadcast-pipeline.mjs";

const script = fileURLToPath(new URL("../scripts/broadcast.mjs", import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups = new WeakMap();
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-broadcast-guards-")));
  await chmod(directory, 0o700);
  const cleanup = []; cleanups.set(t, cleanup);
  t.after(async () => {
    let failure;
    for (const close of cleanup.reverse()) { try { await close(); } catch (error) { failure ??= error; } }
    await rm(directory, { recursive: true, force: true });
    if (failure) throw failure;
  });
  return directory;
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function until(check, timeoutMs = 1500) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { if (await check()) return; await pause(15); }
  throw new Error("Guard fixture did not reach its expected state before the deadline.");
}
async function pipeline(t, directory, overrides = {}) {
  const value = await startBroadcastPipeline({ mediaDir: directory, ffmpeg: join(directory, "absent-encoder"), publicationIntervalMs: 20, ...overrides });
  cleanups.get(t).push(() => value.close());
  return value;
}
async function currentRun(directory) {
  const entries = await readdir(directory);
  return entries.filter((name) => /^run-\d+-[a-f0-9]{12}$/u.test(name)).sort().at(-1);
}
const segmentName = (sequence) => `segment-${String(sequence).padStart(19, "0")}.ts`;
const rawAt = (start = 20, count = 1) => `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${start}\n${Array.from({ length: count }, (_, index) => `#EXTINF:2,\n${segmentName(start + index)}\n`).join("")}`;
const raw = rawAt();
async function generation(directory, name) {
  for (const level of ["low", "high"]) {
    const path = join(directory, name, level);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await writeFile(join(path, "segment-0000000000000000020.ts"), "bounded fixture segment");
  }
}
async function publishedFixture(directory, name) {
  await generation(directory, name);
  await writeFile(join(directory, ".relayswarm-broadcast"), "1\n", { mode: 0o600 });
  await writeFile(join(directory, ".generation"), "5\n", { mode: 0o600 });
  for (const level of ["low", "high"]) {
    await mkdir(join(directory, level), { mode: 0o700 });
    await writeFile(join(directory, level, "index.m3u8"), raw.replace("#EXT-X-TARGETDURATION:", "#EXT-X-DISCONTINUITY-SEQUENCE:4\n#EXT-X-TARGETDURATION:").replace("segment-", `../${name}/${level}/segment-`));
  }
  await writeFile(join(directory, "master.m3u8"), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=850000,RESOLUTION=640x360\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720\nhigh/index.m3u8\n");
}

// These use absent/stub encoders and hand-authored output, not a remote ingest
// or playback acceptance claim. Real transport/reconnection tests are separate.
test("exclusive writer lock rejects duplicates and is released by idempotent close", { timeout: 5000 }, async (t) => {
  const directory = await fixture(t);
  const first = await pipeline(t, directory);
  await until(() => exists(join(directory, ".generation")));
  const lock = await readFile(join(directory, ".broadcast-lock"), "utf8");
  assert.equal((await stat(join(directory, ".broadcast-lock"))).mode & 0o777, 0o600);
  await assert.rejects(startBroadcastPipeline({ mediaDir: directory, ffmpeg: join(directory, "absent-encoder") }), /locked/u);
  assert.equal(await readFile(join(directory, ".broadcast-lock"), "utf8"), lock);
  await Promise.all([first.close(), first.close()]);
  assert.equal(await exists(join(directory, ".broadcast-lock")), false);
  const second = await pipeline(t, directory);
  await second.close();
  assert.equal(await exists(join(directory, ".broadcast-lock")), false);
});

test("unsafe and unrelated media directories reject without overwriting existing files", { timeout: 5000, skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t);
  const foreign = join(directory, "unrelated-project");
  await mkdir(foreign, { mode: 0o700 });
  const sentinel = join(foreign, "keep.txt");
  await writeFile(sentinel, "unrelated work");
  await assert.rejects(startBroadcastPipeline({ mediaDir: foreign }), /dedicated/u);
  assert.equal(await readFile(sentinel, "utf8"), "unrelated work");
  assert.equal(await exists(join(foreign, ".broadcast-lock")), false);
  assert.equal(await exists(join(foreign, ".relayswarm-broadcast")), false);
  await chmod(foreign, 0o777);
  await assert.rejects(startBroadcastPipeline({ mediaDir: foreign }), /owner-controlled/u);
  assert.equal(await readFile(sentinel, "utf8"), "unrelated work");
  await chmod(foreign, 0o700);
  const alias = join(directory, "symlink-media");
  await symlink(foreign, alias);
  await assert.rejects(startBroadcastPipeline({ mediaDir: alias }), /owner-controlled/u);
  assert.equal(await readFile(sentinel, "utf8"), "unrelated work");
});

test("one incomplete rendition preserves both old aliases until a complete generation exists", { timeout: 5000 }, async (t) => {
  const directory = await fixture(t);
  const old = `run-${Date.now() - 900000}-000000000001`;
  await publishedFixture(directory, old);
  const before = await Promise.all(["low", "high"].map((level) => readFile(join(directory, level, "index.m3u8"), "utf8")));
  const value = await pipeline(t, directory);
  await until(() => value.metrics().hls.state === "failed");
  const run = await currentRun(directory);
  await writeFile(join(directory, run, "low", "index.m3u8"), rawAt(21));
  await writeFile(join(directory, run, "low", segmentName(21)), "next fixture segment");
  await pause(80); // Four polling periods must leave both old aliases intact.
  assert.deepEqual(await Promise.all(["low", "high"].map((level) => readFile(join(directory, level, "index.m3u8"), "utf8"))), before);
  assert.equal(value.metrics().publications, 0);
  await writeFile(join(directory, run, "high", "index.m3u8"), rawAt(21));
  await writeFile(join(directory, run, "high", segmentName(21)), "next fixture segment");
  await until(() => value.metrics().publications === 2);
  await value.ready({ timeoutMs: 100 });
  for (const level of ["low", "high"]) {
    const playlist = await readFile(join(directory, level, "index.m3u8"), "utf8");
    assert.ok(playlist.includes(`../${run}/${level}/`));
    assert.ok(playlist.includes("#EXT-X-DISCONTINUITY-SEQUENCE:5\n"));
  }
});

test("empty retry generations cannot prune published media while unreferenced old generations are removed", { timeout: 5000 }, async (t) => {
  const directory = await fixture(t), at = Date.now();
  const published = `run-${at - 900000}-000000000001`;
  const retained = `run-${at - 180000}-000000000002`;
  const retired = `run-${at - 600000}-000000000003`;
  await publishedFixture(directory, published);
  await generation(directory, retained);
  await generation(directory, retired);
  const value = await pipeline(t, directory, { retainGenerations: 2, generationGraceMs: 60000 });
  await until(async () => !(await exists(join(directory, retired))));
  assert.equal(await exists(join(directory, published, "low", "segment-0000000000000000020.ts")), true);
  assert.equal(await exists(join(directory, published, "high", "segment-0000000000000000020.ts")), true);
  assert.equal(await exists(join(directory, retained)), true);
  const newest = await currentRun(directory);
  assert.ok(newest !== published && newest !== retained);
  assert.deepEqual(await readdir(join(directory, newest, "low")), []);
  assert.equal(value.metrics().publications, 0);
});

async function fixtureEncoder(directory) {
  const executable = join(directory, "position-encoder"), mode = join(directory, "encoder-mode"), attempts = join(directory, "encoder-attempts.jsonl");
  const source = String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const starts = args.flatMap((value, index) => value === '-start_number' ? [Number(args[index + 1])] : []);
const targets = args.filter((value) => value.endsWith('/index.m3u8'));
const mode = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify({ mode, starts }) + '\n');
if (mode === 'empty') process.exit(1);
for (const [level, target] of targets.entries()) {
  const start = starts[level];
  let body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:' + start + '\n';
  for (let offset = 0; offset < 2; offset++) {
    const name = 'segment-' + String(start + offset).padStart(19, '0') + '.ts';
    fs.writeFileSync(path.join(path.dirname(target), name), 'bounded position fixture ' + (start + offset));
    body += '#EXTINF:2,\n' + name + '\n';
  }
  fs.writeFileSync(target + '.tmp', body); fs.renameSync(target + '.tmp', target);
}
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
`;
  await writeFile(executable, source, { mode: 0o700 });
  await writeFile(mode, "publish");
  return { executable, mode, async attempts() {
    try { return (await readFile(attempts, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  } };
}

function playlistPosition(body) {
  return { sequence: Number(body.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/mu)?.[1]),
    discontinuity: Number(body.match(/^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)$/mu)?.[1]),
    segments: body.match(/^#EXTINF:/gmu)?.length ?? 0 };
}

test("restarts continue visible sequence and discontinuity after several empty encoder attempts", { timeout: 12000, skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t), mediaDir = join(directory, "media"), encoder = await fixtureEncoder(directory);
  const options = { ffmpeg: encoder.executable, retryFloorMs: 50, retryCeilingMs: 50 };
  const first = await pipeline(t, mediaDir, options);
  await first.ready({ timeoutMs: 2500 });
  const before = await Promise.all(["low", "high"].map((level) => readFile(join(mediaDir, level, "index.m3u8"), "utf8")));
  assert.deepEqual(before.map(playlistPosition), [{ sequence: 0, discontinuity: 0, segments: 2 }, { sequence: 0, discontinuity: 0, segments: 2 }]);
  await first.close();
  await writeFile(encoder.mode, "empty");
  const failed = await pipeline(t, mediaDir, options);
  await until(async () => (await encoder.attempts()).filter((attempt) => attempt.mode === "empty").length >= 3, 3500);
  await failed.close();
  const attempts = await encoder.attempts();
  assert.ok(attempts.filter((attempt) => attempt.mode === "empty").every((attempt) => attempt.starts[0] === 2 && attempt.starts[1] === 2));
  assert.deepEqual(await Promise.all(["low", "high"].map((level) => readFile(join(mediaDir, level, "index.m3u8"), "utf8"))), before);
  assert.ok(Number(await readFile(join(mediaDir, ".generation"), "utf8")) >= 4);
  await writeFile(encoder.mode, "publish");
  const resumed = await pipeline(t, mediaDir, options);
  await resumed.ready({ timeoutMs: 2500 });
  for (const [level, previous] of ["low", "high"].map((level, index) => [level, before[index]])) {
    const body = await readFile(join(mediaDir, level, "index.m3u8"), "utf8");
    assert.deepEqual(playlistPosition(body), { sequence: 2, discontinuity: 1, segments: 2 });
    assert.notEqual(body.match(/^\.\.\/run-.*$/mu)?.[0], previous.match(/^\.\.\/run-.*$/mu)?.[0]);
  }
  assert.ok(resumed.metrics().generation >= 5);
});

test("restart position uses the furthest published rendition rather than the attempt counter", { timeout: 6000, skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t), mediaDir = join(directory, "media"), encoder = await fixtureEncoder(directory);
  await mkdir(mediaDir, { mode: 0o700 });
  const prior = `run-${Date.now() - 900000}-000000000004`;
  await publishedFixture(mediaDir, prior);
  const higher = rawAt(22, 3).replace("#EXT-X-TARGETDURATION:", "#EXT-X-DISCONTINUITY-SEQUENCE:7\n#EXT-X-TARGETDURATION:").replaceAll("\nsegment-", `\n../${prior}/high/segment-`);
  await writeFile(join(mediaDir, "high", "index.m3u8"), higher);
  for (const sequence of [22, 23, 24]) await writeFile(join(mediaDir, prior, "high", segmentName(sequence)), "older fixture segment");
  const value = await pipeline(t, mediaDir, { ffmpeg: encoder.executable });
  await value.ready({ timeoutMs: 2500 });
  for (const level of ["low", "high"]) assert.deepEqual(playlistPosition(await readFile(join(mediaDir, level, "index.m3u8"), "utf8")), { sequence: 25, discontinuity: 8, segments: 2 });
  assert.equal(value.metrics().generation, 6);
});

test("malformed persisted playlist positions fail closed and preserve the publication", { timeout: 6000 }, async (t) => {
  const directory = await fixture(t);
  const good = raw.replace("#EXT-X-TARGETDURATION:", "#EXT-X-DISCONTINUITY-SEQUENCE:4\n#EXT-X-TARGETDURATION:");
  const invalid = [
    good.replace("#EXT-X-MEDIA-SEQUENCE:20", "#EXT-X-MEDIA-SEQUENCE:-1"),
    good.replace("#EXT-X-MEDIA-SEQUENCE:20", "#EXT-X-MEDIA-SEQUENCE:9007199254740991"),
    good.replace("#EXT-X-DISCONTINUITY-SEQUENCE:4", "#EXT-X-DISCONTINUITY-SEQUENCE:bad"),
    good.replace("#EXT-X-DISCONTINUITY-SEQUENCE:4", "#EXT-X-DISCONTINUITY-SEQUENCE:-1"),
    good.replace("#EXT-X-MEDIA-SEQUENCE:20", "#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-MEDIA-SEQUENCE:21"),
    good.replace("#EXT-X-DISCONTINUITY-SEQUENCE:4", "#EXT-X-DISCONTINUITY-SEQUENCE:4\n#EXT-X-DISCONTINUITY-SEQUENCE:5"),
    good.replace("#EXTM3U\n", "invalid playlist\n"),
  ];
  for (const [index, body] of invalid.entries()) {
    const mediaDir = join(directory, `invalid-${index}`);
    await mkdir(mediaDir, { mode: 0o700 });
    const name = `run-${Date.now() - 900000}-000000000005`;
    await publishedFixture(mediaDir, name);
    await writeFile(join(mediaDir, "low", "index.m3u8"), body);
    const value = await pipeline(t, mediaDir);
    await assert.rejects(value.ready({ timeoutMs: 200 }), /failed|deadline/u, `invalid position ${index}`);
    assert.equal(value.metrics().hls.starts, 0, `invalid position ${index} must not start an encoder`);
    assert.equal(value.metrics().publications, 0);
    assert.equal(await readFile(join(mediaDir, "low", "index.m3u8"), "utf8"), body);
    await value.close();
    assert.equal(await exists(join(mediaDir, ".broadcast-lock")), false);
  }
});

test("missing encoder readiness fails within its bound and leaves cleanup available", { timeout: 5000 }, async (t) => {
  const value = await pipeline(t, await fixture(t));
  const start = performance.now();
  await assert.rejects(value.ready({ timeoutMs: 100 }), /failed|deadline/u);
  assert.ok(performance.now() - start < 1000);
  await value.close();
  assert.equal(value.metrics().hls.state, "stopped");
});

test("encoder arguments share safe sequence origins and forward output explicitly verifies TLS with a timeout", () => {
  const encoder = broadcastEncoderArgs("rtsp://127.0.0.1:8554/live", "/fixture/run", { startNumber: 42 });
  const input = encoder.slice(0, encoder.indexOf("-i"));
  assert.equal(input[input.indexOf("-timeout") + 1], "15000000");
  assert.equal(input.includes("-rw_timeout"), false);
  const starts = encoder.flatMap((value, index) => value === "-start_number" ? [encoder[index + 1]] : []);
  assert.equal(starts.length, 2);
  assert.deepEqual(starts, ["42", "42"]);
  assert.deepEqual(encoder.flatMap((value, index) => value === "-hls_start_number_source" ? [encoder[index + 1]] : []), ["generic", "generic"]);
  const forwarded = broadcastForwardArgs("rtsp://127.0.0.1:8554/live", "rtmps://ingest.example/live/test-fixture");
  const output = forwarded.slice(forwarded.indexOf("-i") + 2);
  assert.equal(output[output.indexOf("-tls_verify") + 1], "1");
  assert.equal(output[output.indexOf("-verifyhost") + 1], "ingest.example");
  assert.equal(output[output.indexOf("-rw_timeout") + 1], "15000000");
  assert.equal(output.at(-1), "rtmps://ingest.example/live/test-fixture");
  const secureInput = broadcastForwardArgs("rtmps://source.example/live", "rtmps://ingest.example/live/test-fixture");
  const secureInputOptions = secureInput.slice(0, secureInput.indexOf("-i"));
  assert.equal(secureInputOptions[secureInputOptions.indexOf("-tls_verify") + 1], "1");
  assert.equal(secureInputOptions[secureInputOptions.indexOf("-verifyhost") + 1], "source.example");
  assert.equal(secureInputOptions[secureInputOptions.indexOf("-rw_timeout") + 1], "15000000");
});

test("unsupported RTSPS input fails before creating pipeline state and never discloses credentials", async (t) => {
  const directory = await fixture(t), mediaDir = join(directory, "uncreated-media");
  const input = "rtsps://fixture-user:private-fixture-value@source.example/live";
  const unsupported = (error) => {
    assert.match(error.message, /RTSPS input is unsupported.*TLS verification/u);
    assert.equal(error.message.includes("private-fixture-value"), false);
    assert.equal(error.message.includes("fixture-user"), false);
    return true;
  };
  assert.throws(() => broadcastEncoderArgs(input, mediaDir), unsupported);
  assert.throws(() => broadcastForwardArgs(input, "rtmps://ingest.example/live/test-fixture"), unsupported);
  await assert.rejects(startBroadcastPipeline({ input, mediaDir }), unsupported);
  assert.equal(await exists(mediaDir), false);
});

test("RTMPS rejects numeric hosts for both input and forwarding", async (t) => {
  const directory = await fixture(t), mediaDir = join(directory, "uncreated-media");
  for (const host of ["127.0.0.1", "[::1]", "192.0.2.1", "[2001:db8::1]", "127.1", "2130706433", "0x7f000001"]) {
    const url = `rtmps://${host}/live`;
    assert.throws(() => broadcastEncoderArgs(url, mediaDir), /DNS hostname/u);
    assert.throws(() => broadcastForwardArgs("rtsp://127.0.0.1/live", url), /DNS hostname/u);
    await assert.rejects(startBroadcastPipeline({ input: url, mediaDir }), /DNS hostname/u);
    await assert.rejects(startBroadcastPipeline({ forwardUrl: url, mediaDir }), /DNS hostname/u);
  }
  assert.equal(await exists(mediaDir), false);
});

async function fixtureTlsProbe(directory, { version = "5.1.6", backend = "gnutls", mode = "version" } = {}) {
  await mkdir(directory, { mode: 0o700 });
  const executable = join(directory, "tls-probe"), attempts = join(directory, "attempts.jsonl");
  const output = `ffmpeg version ${version} fixture\nconfiguration: --enable-${backend}\n`;
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(attempts)}, JSON.stringify({ args, pid: process.pid }) + '\\n');
if (args.length === 1 && args[0] === '-version') {
  if (${JSON.stringify(mode)} === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
  else if (${JSON.stringify(mode)} === 'flood') { process.stderr.write('private-probe-output-fixture'.repeat(4096)); }
  else { process.stdout.write(${JSON.stringify(output)}); }
} else { process.exit(0); }
`, { mode: 0o700 });
  return { executable, async attempts() { return (await readFile(attempts, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); } };
}

const posixProbe = { skip: process.platform === "win32" ? "Probe fixtures require POSIX executable scripts." : false };
test("unsafe TLS builds reject before pipeline state or credential-bearing workers exist", posixProbe, async (t) => {
  const directory = await fixture(t);
  for (const [index, options] of [{ version: "4.4", backend: "gnutls" }, { version: "7.1", backend: "openssl" }, { backend: "unknown" }, { version: "N-unknown", backend: "gnutls" }].entries()) {
    const probe = await fixtureTlsProbe(join(directory, `probe-${index}`), options);
    const mediaDir = join(directory, `uncreated-${index}`), secret = "private-forward-fixture";
    await assert.rejects(startBroadcastPipeline({ mediaDir, ffmpeg: probe.executable, forwardUrl: `rtmps://ingest.example/live/${secret}` }), (error) => {
      assert.match(error.message, /TLS capabilities could not be safely verified/u);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(await exists(mediaDir), false);
    assert.deepEqual((await probe.attempts()).map(({ args }) => args), [["-version"]]);
  }
});

test("verified GnuTLS 5 and OpenSSL 8 builds permit DNS RTMPS input and forwarding", posixProbe, async (t) => {
  const directory = await fixture(t);
  for (const [index, options] of [{ version: "5.1.6", backend: "gnutls" }, { version: "8.0.1", backend: "openssl" }].entries()) {
    const probe = await fixtureTlsProbe(join(directory, `probe-${index}`), options);
    const value = await pipeline(t, join(directory, `media-${index}`), { ffmpeg: probe.executable, input: "rtmps://source.example/live", forwardUrl: "rtmps://ingest.example/live/fixture", retryFloorMs: 50, retryCeilingMs: 50 });
    await until(async () => value.metrics().hls.starts > 0 && value.metrics().forward.starts > 0 && (await probe.attempts()).length >= 3);
    await value.close();
    const attempts = await probe.attempts();
    assert.deepEqual(attempts[0].args, ["-version"]);
    assert.ok(attempts.length >= 3);
    assert.ok(attempts.slice(1).every(({ args }) => args.includes("-i") && args.includes("-tls_verify")));
    assert.equal(await exists(join(value.mediaDir, ".broadcast-lock")), false);
  }
});

test("TLS capability probe times out, kills its child and leaves state absent", { ...posixProbe, timeout: 10000 }, async (t) => {
  const directory = await fixture(t), probe = await fixtureTlsProbe(join(directory, "probe"), { mode: "hang" });
  const mediaDir = join(directory, "uncreated-media"), start = performance.now();
  await assert.rejects(startBroadcastPipeline({ ffmpeg: probe.executable, mediaDir, input: "rtmps://source.example/live/private-probe-output-fixture" }), /TLS capabilities could not be safely verified/u);
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 4500 && elapsed < 8000, `Probe must fail within its 5-second bound, observed ${Math.round(elapsed)}ms.`);
  assert.equal(await exists(mediaDir), false);
  const attempts = await probe.attempts();
  assert.deepEqual(attempts.map(({ args }) => args), [["-version"]]);
  assert.throws(() => process.kill(attempts[0].pid, 0), { code: "ESRCH" });
});

test("TLS capability probe bounds output and never exposes captured text", posixProbe, async (t) => {
  const directory = await fixture(t), probe = await fixtureTlsProbe(join(directory, "probe"), { mode: "flood" });
  const mediaDir = join(directory, "uncreated-media");
  await assert.rejects(startBroadcastPipeline({ ffmpeg: probe.executable, mediaDir, forwardUrl: "rtmps://ingest.example/live/fixture" }), (error) => {
    assert.match(error.message, /TLS capabilities could not be safely verified/u);
    assert.equal(error.message.includes("private-probe-output-fixture"), false);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(await exists(mediaDir), false);
  const attempts = await probe.attempts();
  assert.deepEqual(attempts.map(({ args }) => args), [["-version"]]);
  assert.throws(() => process.kill(attempts[0].pid, 0), { code: "ESRCH" });
});

test("non-network ingest, insecure forwarding and out-of-range limits are rejected", async (t) => {
  for (const input of ["/private/fixture", "file:///private/fixture", "https://source.example/live.m3u8", "rtsp://source.example/live#fragment"]) assert.throws(() => broadcastEncoderArgs(input, "/fixture"));
  for (const output of ["/fixture", "file:///fixture", "https://ingest.example/live", "rtmp://ingest.example/live", "rtmp://127.0.0.1/live", "rtmps://ingest.example/live#fragment"]) assert.throws(() => broadcastForwardArgs("rtsp://127.0.0.1/live", output));
  assert.throws(() => broadcastForwardArgs("rtsp://127.0.0.1/live", "rtmp://ingest.example/live", { allowInsecureLoopbackForward: true }));
  assert.ok(broadcastForwardArgs("rtsp://127.0.0.1/live", "rtmp://127.0.0.1/live", { allowInsecureLoopbackForward: true }));
  for (const startNumber of [-1, "0", 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => broadcastEncoderArgs("rtsp://127.0.0.1/live", "/fixture", { startNumber }));
  const directory = await fixture(t);
  for (const limits of [{ retryFloorMs: 49 }, { retryCeilingMs: 2147483648 }, { publicationIntervalMs: 19 }, { publicationIntervalMs: 5001 },
    { retainGenerations: 1 }, { retainGenerations: 17 }, { generationGraceMs: 59999 }]) await assert.rejects(startBroadcastPipeline({ mediaDir: directory, ...limits }), /limits/u);
  assert.equal(await exists(join(directory, ".broadcast-lock")), false);
});

function cli(t, args, entry = script) {
  const child = spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-16384); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-16384); });
  const result = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
  cleanups.get(t).push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      try { await boundedResult(result, 3500); } catch { child.kill("SIGKILL"); await boundedResult(result, 1000); }
    }
  });
  return { child, result, stdout: () => stdout };
}
async function boundedResult(value, timeoutMs = 3000) {
  let timer;
  try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("CLI did not finish within its guard deadline.")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

for (const value of ["0", "121", "-1", "1.5", "NaN", "Infinity"]) {
  test(`CLI rejects admission tickets per address ${value} before creating state`, { timeout: 5000 }, async (t) => {
    const directory = await fixture(t), state = join(directory, "uncreated-state");
    const outcome = await boundedResult(cli(t, ["--state-dir", state, `--admission-per-address-tickets=${value}`]).result);
    assert.equal(outcome.code, 1);
    assert.ok(outcome.stderr.includes("Broadcaster could not start."));
    assert.equal(await exists(state), false);
  });
}

test("CLI help advertises the admission option without creating state", { timeout: 5000 }, async (t) => {
  const directory = await fixture(t), state = join(directory, "uncreated-state");
  const outcome = await boundedResult(cli(t, ["--state-dir", state, "--admission-per-address-tickets=32", "--help"]).result);
  assert.equal(outcome.code, 0);
  assert.ok(outcome.stdout.includes("--admission-per-address-tickets 12"));
  assert.equal(await exists(state), false);
});

for (const [name, entry] of [["broadcaster", script], ["demo", fileURLToPath(new URL("../demo/server.mjs", import.meta.url))]]) {
  test(`${name} CLI rejects invalid ICE policy before startup state`, { timeout: 5000 }, async (t) => {
    const directory = await fixture(t), state = join(directory, "uncreated-state");
    const args = name === "broadcaster" ? ["--state-dir", state] : ["--publisher-state", join(state, "publisher.json"), "--ice-config", join(directory, "absent-private-ice")];
    const outcome = await boundedResult(cli(t, [...args, "--ice-transport-policy=Relay"], entry).result);
    assert.equal(outcome.code, 1); assert.equal(await exists(state), false);
    if (name === "demo") assert.match(outcome.stderr, /Invalid ICE transport policy/u);
  });
  test(`${name} CLI help advertises inert ICE policy choice`, { timeout: 5000 }, async (t) => {
    const directory = await fixture(t), state = join(directory, "uncreated-state");
    const args = name === "broadcaster" ? ["--state-dir", state] : ["--publisher-state", join(state, "publisher.json")];
    const outcome = await boundedResult(cli(t, [...args, "--help"], entry).result);
    assert.equal(outcome.code, 0); assert.ok(outcome.stdout.includes("--ice-transport-policy all|relay"));
    assert.equal(await exists(state), false);
  });
}

test("CLI rejects a FIFO secret promptly instead of blocking on open", { timeout: 5000, skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t), path = join(directory, "fifo-fixture");
  const made = spawnSync("mkfifo", ["-m", "600", path], { encoding: "utf8", timeout: 1000 });
  assert.equal(made.status, 0);
  const started = performance.now();
  const outcome = await boundedResult(cli(t, ["--state-dir", join(directory, "state"), "--youtube-url-file", path]).result);
  assert.equal(outcome.code, 1);
  assert.ok(performance.now() - started < 3000);
  assert.ok(outcome.stderr.includes("Broadcaster could not start."));
});

test("CLI rejects oversized secret files without logging their contents", { timeout: 5000 }, async (t) => {
  const directory = await fixture(t), path = join(directory, "oversized-fixture");
  const sentinel = "oversized-private-test-fixture";
  await writeFile(path, sentinel.repeat(200), { mode: 0o600 });
  const outcome = await boundedResult(cli(t, ["--state-dir", join(directory, "state"), "--youtube-url-file", path]).result);
  assert.equal(outcome.code, 1);
  assert.ok(outcome.stderr.includes("Broadcaster could not start."));
  assert.equal(`${outcome.stdout}${outcome.stderr}`.includes(sentinel), false);
  assert.equal(await readFile(path, "utf8"), sentinel.repeat(200));
});

test("CLI stops cleanly while waiting for an encoder that supplies no HLS output", { timeout: 7000, skip: process.platform === "win32" }, async (t) => {
  const directory = await fixture(t), encoder = join(directory, "stub-encoder"), pidFile = join(directory, "encoder-pid");
  await writeFile(encoder, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\nprocess.on('SIGTERM', () => process.exit(0));\n`, { mode: 0o700 });
  cleanups.get(t).push(async () => {
    if (await exists(pidFile)) { const pid = Number(await readFile(pidFile, "utf8")); try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  });
  const state = join(directory, "state"), running = cli(t, ["--state-dir", state, "--ffmpeg", encoder]);
  await until(async () => running.stdout().includes("Waiting for a broadcast") && await exists(pidFile), 3000);
  const pid = Number(await readFile(pidFile, "utf8"));
  running.child.kill("SIGTERM");
  const outcome = await boundedResult(running.result, 4000);
  assert.equal(outcome.code, 0);
  assert.equal(outcome.signal, null);
  assert.equal(await exists(join(state, "media", ".broadcast-lock")), false);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(await exists(join(state, "media", "master.m3u8")), false);
});

test("kernel lease excludes another process and recovers after SIGKILL without consulting PIDs", { timeout: 10000, skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const directory = await fixture(t), mediaDir = join(directory, "media");
  const moduleUrl = new URL("../src/broadcast-pipeline.mjs", import.meta.url).href;
  const code = `import { startBroadcastPipeline } from ${JSON.stringify(moduleUrl)}; const p = await startBroadcastPipeline({mediaDir:process.argv[1],ffmpeg:process.argv[2],publicationIntervalMs:20}); process.stdout.write('owned\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, mediaDir, join(directory, "absent-encoder")], { stdio: ["ignore", "pipe", "pipe"] });
  let text = ""; child.stdout.on("data", (data) => { text += data; }); child.stderr.on("data", () => {});
  const closed = new Promise((done) => child.once("close", done));
  cleanups.get(t).push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await closed; });
  await until(() => text.includes("owned"), 5000);
  await until(() => exists(join(mediaDir, ".generation")));
  const before = JSON.parse(await readFile(join(mediaDir, ".broadcast-lock"), "utf8"));
  const firstGeneration = Number(await readFile(join(mediaDir, ".generation"), "utf8"));
  await assert.rejects(startBroadcastPipeline({ mediaDir, ffmpeg: join(directory, "absent-encoder") }), /locked/u);
  child.kill("SIGKILL"); await closed;
  assert.equal(await exists(join(mediaDir, ".broadcast-lock")), true);
  // A namespace PID is irrelevant. The kernel transaction on the same inode
  // is the only proof that the previous publisher no longer owns the state.
  await writeFile(join(mediaDir, ".broadcast-lock"), JSON.stringify({ ...before, pid: process.pid }), { mode: 0o600 });
  const recovered = await pipeline(t, mediaDir);
  await until(async () => Number(await readFile(join(mediaDir, ".generation"), "utf8")) > firstGeneration);
  const after = JSON.parse(await readFile(join(mediaDir, ".broadcast-lock"), "utf8"));
  assert.equal(after.leaseInode, before.leaseInode); assert.equal(after.leaseDevice, before.leaseDevice);
  await recovered.close();
  assert.equal(await exists(join(mediaDir, ".broadcast-lease.sqlite")), true, "the locked inode must never be unlinked between owners");
});

test("legacy ownership records cannot be automatically reclaimed", { skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const directory = await fixture(t), original = JSON.stringify({ pid: 9999999, startedAt: "old" });
  await writeFile(join(directory, ".broadcast-lock"), original, { mode: 0o600 });
  await assert.rejects(startBroadcastPipeline({ mediaDir: directory, ffmpeg: join(directory, "absent-encoder") }), /Legacy/u);
  assert.equal(await readFile(join(directory, ".broadcast-lock"), "utf8"), original);
});

test("parent SIGKILL stops encoder and forwarder before automatic ownership handoff", { timeout: 10000, skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const directory = await fixture(t), mediaDir = join(directory, "media"), encoder = join(directory, "worker.mjs");
  await writeFile(encoder, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; const role=process.argv.includes('flv')?'forward':'hls'; writeFileSync(${JSON.stringify(directory)}+'/'+role+'.pid',String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);\n`, { mode: 0o700 });
  const moduleUrl = new URL("../src/broadcast-pipeline.mjs", import.meta.url).href;
  const code = `import {startBroadcastPipeline} from ${JSON.stringify(moduleUrl)}; await startBroadcastPipeline({mediaDir:process.argv[1],ffmpeg:process.argv[2],forwardUrl:'rtmp://127.0.0.1:1935/output',allowInsecureLoopbackForward:true,publicationIntervalMs:20}); process.stdout.write('owned\\n');setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", code, mediaDir, encoder], { stdio: ["ignore", "pipe", "pipe"] });
  parent.stdout.on("data", () => {}); parent.stderr.on("data", () => {});
  const closed = new Promise((done) => parent.once("close", done));
  cleanups.get(t).push(async () => { if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL"); await closed; });
  await until(async () => await exists(join(directory, "hls.pid")) && await exists(join(directory, "forward.pid")), 5000);
  const pids = await Promise.all(["hls", "forward"].map(async (role) => Number(await readFile(join(directory, `${role}.pid`), "utf8"))));
  parent.kill("SIGKILL"); await closed;
  const recovered = await pipeline(t, mediaDir);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "old workers must be reaped before the new owner is ready");
  await recovered.close();
  assert.equal(await exists(join(mediaDir, ".broadcast-workers.sqlite.dirty")), false);
});


for (const [name, entry] of [["broadcaster", script], ["demo", fileURLToPath(new URL("../demo/server.mjs", import.meta.url))]]) {
  test(`${name} CLI rejects an unknown TURN projection before startup state`, { timeout: 5000 }, async t => {
    const directory = await fixture(t), state = join(directory, "uncreated-projection-state");
    const args = name === "broadcaster" ? ["--state-dir", state] : ["--publisher-state", join(state, "publisher.json")];
    const outcome = await boundedResult(cli(t, [...args, "--turn-url-projection=invalid"], entry).result);
    assert.equal(outcome.code, 1); assert.equal(await exists(state), false);
    if (name === "demo") assert.match(outcome.stderr, /Invalid TURN URL projection/u);
  });
  test(`${name} CLI requires an issuer for TLS projection before private ICE reads or state`, { timeout: 5000 }, async t => {
    const directory = await fixture(t), state = join(directory, "uncreated-projection-state");
    // This valid static file would permit startup if the issuer requirement were
    // removed; only the real parser/early configuration path is exercised.
    const ice = join(directory, "static-ice.json");
    await writeFile(ice, '{"v":1,"iceServers":[{"urls":"stun:relay.invalid"}]}', { mode: 0o600 });
    const args = name === "broadcaster" ? ["--state-dir", state] : ["--publisher-state", join(state, "publisher.json")];
    const outcome = await boundedResult(cli(t, [...args, "--ice-config", ice, "--turn-url-projection=tls-tcp"], entry).result);
    assert.equal(outcome.code, 1); assert.equal(await exists(state), false);
    if (name === "demo") assert.match(outcome.stderr, /requires --turn-credentials-url/u);
  });
  test(`${name} CLI help advertises inert TURN projection`, { timeout: 5000 }, async t => {
    const directory = await fixture(t), state = join(directory, "uncreated-projection-state");
    const args = name === "broadcaster" ? ["--state-dir", state] : ["--publisher-state", join(state, "publisher.json")];
    const outcome = await boundedResult(cli(t, [...args, "--turn-url-projection=tls-tcp", "--help"], entry).result);
    assert.equal(outcome.code, 0); assert.ok(outcome.stdout.includes("--turn-url-projection issued|tls-tcp"));
    assert.equal(await exists(state), false);
  });
}
