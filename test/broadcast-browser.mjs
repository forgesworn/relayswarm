#!/usr/bin/env node
// A synthetic real-time producer, local MediaMTX routing, the native FFmpeg
// pipeline and real Chrome players. This does not exercise OBS or YouTube.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, lstat, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";
import { createBroadcastRequestTimings } from "./support/broadcast-request-timings.mjs";
import { startBroadcastPipeline, broadcastEncoderArgs } from "../src/broadcast-pipeline.mjs";
import { startDemoServer } from "../demo/server.mjs";

const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/broadcast-browser" }, mediamtx: { type: "string", default: process.env.MEDIAMTX_PATH || process.env.MEDIAMTX_BINARY || "artifacts/tools/mediamtx-v1.21.2/mediamtx" }, "verify-mediamtx-only": { type: "boolean", default: false } } });
const pinnedArchives = {
  "darwin-arm64": "7d0d0c5c11527cbd10bde1c3d728864eb0334a9b653566cd73c0259750cbf093",
  "darwin-x64": "87a00062b6a588aa1158f875504a3b56c80d62e2611dc450b83d0534e1b49198",
  "linux-x64": "121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27",
  "linux-arm64": "180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f",
};
async function verifyRouter(binary) {
  const directory = dirname(binary), directoryStat = await lstat(directory);
  assert.ok(directoryStat.isDirectory() && await realpath(directory) === directory && !(directoryStat.mode & 0o022)
    && (typeof process.getuid !== "function" || directoryStat.uid === process.getuid()), "MediaMTX cache must be an owner-controlled directory without symlinks");
  async function regularFile(path, maxBytes, receiptFile = false) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= maxBytes && !(stat.mode & 0o022)
        && (!receiptFile || (stat.mode & 0o777) === 0o600)
        && (typeof process.getuid !== "function" || stat.uid === process.getuid()), "MediaMTX binary and receipt must be bounded owner-controlled regular files");
      return await handle.readFile();
    } finally { await handle.close(); }
  }
  const archiveSha256 = pinnedArchives[`${process.platform}-${process.arch}`];
  assert.ok(archiveSha256, "No pinned MediaMTX archive exists for this test platform");
  const verified = JSON.parse((await regularFile(join(directory, "verified.json"), 4096, true)).toString("utf8"));
  const binarySha256 = createHash("sha256").update(await regularFile(binary, 128 * 1024 * 1024)).digest("hex");
  assert.equal(verified.version, "1.21.2");
  assert.equal(verified.archiveSha256, archiveSha256, "MediaMTX installer receipt must match the pinned platform archive");
  assert.equal(verified.binarySha256, binarySha256, "MediaMTX binary must match its installer receipt");
  // This receipt is trusted local cache state. A fresh installer download
  // verifies the upstream archive; the receipt is not independent proof.
  return { routerBinarySha256: binarySha256, routerArchiveSha256: archiveSha256, routerVerification: "owner-controlled installer cache receipt" };
}
if (values["verify-mediamtx-only"]) {
  console.log(JSON.stringify(await verifyRouter(resolve(values.mediamtx)), null, 2));
  process.exit(0);
}
const log = (message) => console.error(`[broadcast-browser] ${message}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const children = [], pages = [], pageErrors = [], consoleErrors = [];
const receipt = { v: 1, kind: "relayswarm-broadcast-browser-test", at: new Date().toISOString(), ok: false, failures: [], scope: { network: "loopback", producer: "FFmpeg synthetic real-time H.264/AAC", router: "MediaMTX", ingress: "RTMP", pipelineInput: "RTSP over TCP", output: "two-rendition live HLS", browser: "Chrome", OBS: false, YouTube: false, physicalDevices: false }, checkpoints: [] };
Object.assign(receipt.scope, { automatedHeadlessChrome: true, autoplayUserGestureOverride: true, fakeMediaDeviceAndPermissionUI: true, getUserMediaWarmup: true, mdnsHidingDisabled: true,
  ordinaryDefaultTransportEvidence: false, requestTimingMetadataOnly: true, additionalMediaRequestsOrBodyReads: false });
let root, router, producer, pipeline, demo, browser, requestTimings, closingBrowser = false;
function child(command, args) {
  const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const record = { process, stdout: "", stderr: "", done: null, error: null };
  process.stdout.on("data", (data) => { record.stdout = (record.stdout + data).slice(-4000); });
  process.stderr.on("data", (data) => { record.stderr = (record.stderr + data).slice(-4000); });
  record.done = new Promise((done) => { process.once("error", (error) => { record.error = error.message; done(); }); process.once("close", (code, signal) => { record.code = code; record.signal = signal; done(); }); });
  children.push(record); return record;
}
async function stop(record) {
  if (!record || record.process.exitCode !== null || record.process.signalCode !== null) return;
  record.process.kill("SIGTERM");
  const force = setTimeout(() => record.process.kill("SIGKILL"), 2500);
  try { await record.done; } finally { clearTimeout(force); }
}
async function ports() {
  const sockets = [createServer(), createServer()];
  await Promise.all(sockets.map((socket) => new Promise((done, reject) => { socket.once("error", reject); socket.listen(0, "127.0.0.1", done); })));
  const result = sockets.map((socket) => socket.address().port);
  await Promise.all(sockets.map((socket) => new Promise((done) => socket.close(done))));
  return result;
}
async function until(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) { if (Date.now() >= deadline) throw new Error(`Timed out: ${label}.`); await pause(100); }
}
function listening(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.setTimeout(300, () => finish(false)); socket.once("error", () => finish(false)); socket.once("connect", () => finish(true));
  });
}
await mkdir(values.resultsDir, { recursive: true });
try {
  root = await mkdtemp(join(await realpath(tmpdir()), "relayswarm-broadcast-browser-"));
  const [rtmpPort, rtspPort] = await ports();
  const binary = resolve(values.mediamtx);
  Object.assign(receipt.scope, await verifyRouter(binary));
  const config = join(root, "mediamtx.yml");
  await writeFile(config, `logLevel: warn\nrtsp: yes\nrtspAddress: 127.0.0.1:${rtspPort}\nrtspTransports: [tcp]\nrtmp: yes\nrtmpAddress: 127.0.0.1:${rtmpPort}\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\nauthInternalUsers:\n- user: any\n  ips: [127.0.0.1, '::1']\n  permissions:\n  - action: publish\n    path: browser-live\n  - action: read\n    path: browser-live\npaths:\n  browser-live:\n    source: publisher\n    overridePublisher: false\n`, { mode: 0o600 });
  router = child(binary, [config]);
  await until(async () => {
    if (router.error || router.process.exitCode !== null) throw new Error(`MediaMTX could not start: ${router.error || router.stderr}`);
    return await listening(rtmpPort) && await listening(rtspPort);
  }, 10000, "local router listeners");
  const startProducer = () => child("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-re", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-re", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-b:v", "2000k", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-f", "flv", `rtmp://127.0.0.1:${rtmpPort}/browser-live`]);
  producer = startProducer();
  const input = `rtsp://127.0.0.1:${rtspPort}/browser-live`;
  log("waiting for the routed H.264/AAC producer tracks");
  await until(async () => {
    if (producer.process.exitCode !== null) throw new Error(`Synthetic producer exited: ${producer.stderr}`);
    const probe = child("ffprobe", ["-v", "error", "-rtsp_transport", "tcp", "-timeout", "5000000", "-show_entries", "stream=codec_name,codec_type", "-of", "json", input]);
    await until(() => probe.process.exitCode !== null || probe.error, 7000, "RTSP track probe").catch(async (error) => { await stop(probe); throw error; });
    if (probe.process.exitCode !== 0) { await pause(300); return false; }
    const streams = JSON.parse(probe.stdout).streams;
    if (streams.some((stream) => stream.codec_type === "video" && stream.codec_name === "h264") && streams.some((stream) => stream.codec_type === "audio" && stream.codec_name === "aac")) { receipt.sourceStreams = streams; return true; }
    return false;
  }, 30000, "H.264/AAC source");
  pipeline = await startBroadcastPipeline({ input, mediaDir: join(root, "media"), retryFloorMs: 500, retryCeilingMs: 2000 });
  log("waiting for both real-time HLS renditions");
  try { await pipeline.ready({ timeoutMs: 60000 }); }
  catch (error) {
    // Only this harness's credential-free loopback source is diagnosed. The
    // pipeline deliberately keeps arbitrary upstream error text private.
    const diagnosticDirectory = join(root, "diagnostic");
    for (const name of ["low", "high"]) await mkdir(join(diagnosticDirectory, name), { recursive: true });
    const diagnostic = child("ffmpeg", broadcastEncoderArgs(input, diagnosticDirectory));
    await pause(1500); await stop(diagnostic);
    throw new Error(`${error.message} Loopback encoder diagnostic: ${diagnostic.stderr}`);
  }
  const state = join(root, "publisher.json");
  demo = await startDemoServer({ mediaDir: pipeline.mediaDir, publisherState: state, operatorToken: "broadcast-browser-loopback-token-32-characters", iceServers: [], operatorExtraStatus: () => pipeline.metrics() });
  requestTimings = createBroadcastRequestTimings({ origin: demo.base, epochMs: Date.parse(receipt.at) });
  const session = async () => { const response = await fetch(`${demo.base}/session.json`, { signal: AbortSignal.timeout(5000) }); assert.equal(response.status, 200); return response.json(); };
  const original = await session();
  receipt.identity = { eventId: original.streamEvent.id, pubkey: original.streamEvent.pubkey, swarmId: original.swarmId, manifest: original.manifest };
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  receipt.scope.browserVersion = browser.version();
  const read = (page) => page.evaluate(() => window.relaySwarmDemo.report());
  async function viewer(name, mode, upload, level) {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(20000);
    const timing = requestTimings.page(name); timing.attach(page);
    const network = { mediaRequests: 0, failedMediaRequests: 0 };
    pages.push({ name, page, network, timing });
    page.on("pageerror", (error) => pageErrors.push({ name, message: error.message }));
    page.on("console", (message) => { if (["error", "warning"].includes(message.type()) && consoleErrors.length < 100) consoleErrors.push({ viewer: name, type: message.type(), text: message.text().slice(0, 2000) }); });
    await page.addInitScript(installMediaDiagnostics);
    await page.addInitScript(() => {
      window.broadcastAppendFailures = [];
      const append = SourceBuffer.prototype.appendBuffer;
      SourceBuffer.prototype.appendBuffer = function (bytes) {
        try { return append.call(this, bytes); }
        catch (error) { window.broadcastAppendFailures.push({ name: error.name, message: error.message, bytes: bytes.byteLength, updating: this.updating, timestampOffset: this.timestampOffset }); throw error; }
      };
    });
    page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/media/") && !request.url().includes(".m3u8")) network.mediaRequests++; });
    page.on("response", (response) => { if (new URL(response.url()).pathname.startsWith("/media/") && !response.url().includes(".m3u8") && !response.ok()) network.failedMediaRequests++; });
    await page.goto(demo.base); await page.waitForFunction(() => window.relaySwarmDemo?.ready() && !document.getElementById("start").disabled);
    await page.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); for (const track of stream.getTracks()) track.stop(); });
    assert.equal(await page.locator("#upload").isChecked(), false);
    await page.locator("#mode").selectOption(mode);
    if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
    await page.locator("#start").click(); await page.waitForFunction(() => !document.getElementById("quality").disabled);
    await page.locator("#quality").selectOption(String(level));
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
    log(`started ${name}`); return page;
  }
  const low = await viewer("contributor-low", "peer-first", true, 0);
  const high = await viewer("contributor-high", "peer-first", true, 1);
  await pause(6000);
  const baseline = await viewer("baseline", "off", false, 0);
  const consumer = await viewer("consumer", "peer-first", false, 0);
  const checkpoint = async (name) => { receipt.checkpoints.push({ name, pipeline: pipeline.metrics(), viewers: await Promise.all(pages.map(async ({ name, page, network, timing }) => ({ name, network: { ...network }, requestTimings: timing.snapshot(), receipt: await read(page) }))) }); log(name); };
  await consumer.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((fragment) => fragment.source === "peer" && fragment.level === 0), null, { timeout: 30000 });
  await checkpoint("real-time-low-rendition-peer-playback");
  for (const page of [baseline, consumer]) await page.locator("#quality").selectOption("1");
  await consumer.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((fragment) => fragment.source === "peer" && fragment.level === 1), null, { timeout: 30000 });
  await baseline.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((fragment) => fragment.level === 1));
  await checkpoint("real-time-high-rendition-peer-playback");
  const beforeRestart = await Promise.all([baseline, consumer].map(read));
  receipt.checkpoints.push({ name: "before-producer-restart", viewers: beforeRestart.map((report, index) => ({
    name: index === 0 ? "baseline" : "consumer", receipt: report,
  })) });
  const restartAt = Date.now();
  const publications = pipeline.metrics().publications, generation = pipeline.metrics().generation;
  log("restarting the synthetic RTMP producer"); await stop(producer); await pause(1000); producer = startProducer();
  await until(() => pipeline.metrics().generation > generation && pipeline.metrics().publications > publications && pipeline.metrics().hls.state === "publishing", 60000, "publication after producer reconnect");
  const resumed = await session();
  assert.equal(resumed.manifest, original.manifest); assert.equal(resumed.streamEvent.id, original.streamEvent.id); assert.equal(resumed.streamEvent.pubkey, original.streamEvent.pubkey); assert.equal(resumed.swarmId, original.swarmId);
  for (const [index, page] of [baseline, consumer].entries()) await page.waitForFunction((before) => { const report = window.relaySwarmDemo.report(); return report.player.currentTime > before.currentTime + 1 && report.player.fragmentsLoaded > before.fragmentsLoaded && report.player.fragments.some((fragment) => fragment.discontinuity > before.discontinuity && (!before.requirePeer || fragment.source === "peer")); }, { currentTime: beforeRestart[index].player.currentTime, fragmentsLoaded: beforeRestart[index].player.fragmentsLoaded, discontinuity: Math.max(...beforeRestart[index].player.fragments.map((fragment) => fragment.discontinuity)), requirePeer: index === 1 }, { timeout: 60000 });
  for (const [index, page] of [baseline, consumer].entries()) assert.ok((await read(page)).player.currentTime - beforeRestart[index].player.currentTime < (Date.now() - restartAt) / 1000 + 20, "reconnection must not extrapolate a years-long media timeline from sequence numbers");
  await checkpoint("producer-reconnect-stable-manifest-and-identity");
  const measured = await read(consumer);
  assert.ok(measured.totals.peerFirstBytes > 0 && measured.totals.peerFirstLoads > 0);
  assert.equal(measured.totals.uploaded, 0); assert.equal(measured.current.metrics.serving, false);
  assert.ok(measured.player.fragments.some((fragment) => fragment.source === "peer" && fragment.level === 0));
  assert.ok(measured.player.fragments.some((fragment) => fragment.source === "peer" && fragment.level === 1));
  assert.ok((await read(low)).totals.uploaded > 0); assert.ok((await read(high)).totals.uploaded > 0);
  for (const { page } of pages) assert.equal((await read(page)).player.fatalErrors, 0);
  assert.equal(receipt.scope.consumerPlaylistReadiness, undefined, "Playback must use unmodified live playlists");
  assert.equal(pageErrors.length, 0); receipt.ok = true;
} catch (error) { log(`failed: ${error.message}`); receipt.failures.push(error.stack || error.message); }
finally {
  receipt.pageErrors = pageErrors;
  receipt.consoleErrors = consoleErrors;
  receipt.pipeline = pipeline?.metrics();
  receipt.viewers = await Promise.all(pages.map(async ({ name, page, network }) => ({ name, network, receipt: await page.evaluate(() => window.relaySwarmDemo?.report()).catch(() => null), appendFailures: await page.evaluate(() => window.broadcastAppendFailures).catch(() => []), mediaDiagnostics: await page.evaluate(() => window.relaySwarmMediaDiagnostics).catch(() => []) })));
  if (pipeline) receipt.playlists = Object.fromEntries(await Promise.all(["master.m3u8", "low/index.m3u8", "high/index.m3u8"].map(async (path) => [path, await readFile(join(pipeline.mediaDir, path), "utf8").catch(() => null)])));
  receipt.requestTimingsBeforeBrowserClose = requestTimings?.snapshot();
  closingBrowser = true;
  try { await browser?.close(); await demo?.close(); await pipeline?.close(); await stop(producer); await stop(router); }
  finally { receipt.requestTimingsAfterBrowserClose = requestTimings?.close(); }
  receipt.childProcesses = children.map(({ code, signal, error, stderr, stdout }) => ({ code, signal, error, ...(receipt.ok ? {} : { stderr, stdout }) }));
  const payload = `${JSON.stringify(receipt, null, 2)}\n`;
  await writeFile(join(values.resultsDir, `broadcast-browser-${receipt.at.replace(/\D/gu, "")}.json`), payload);
  await writeFile(join(values.resultsDir, "broadcast-browser.json"), payload);
  if (root) await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, receipt: join(values.resultsDir, "broadcast-browser.json"), checkpoints: receipt.checkpoints.map(({ name }) => name), viewers: receipt.viewers?.map(({ name, network, receipt: value }) => ({ name, network, peerFirstLoads: value?.totals.peerFirstLoads, peerFirstBytes: value?.totals.peerFirstBytes, uploaded: value?.totals.uploaded, fatalErrors: value?.player.fatalErrors, stalls: value?.player.stalls })) }, null, 2));
process.exitCode = receipt.ok ? 0 : 1;
