// Real RTMP ingestion, RTSP readers, two live HLS encodes and a separate forward.
// Synthetic loopback media is not an OBS workstation or platform acceptance test.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as tlsServer } from "node:tls";
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startBroadcastPipeline, broadcastForwardArgs } from "../src/broadcast-pipeline.mjs";
import { startDemoServer } from "../demo/server.mjs";

const routerBinary = resolve(process.env.MEDIAMTX_PATH || "artifacts/tools/mediamtx-v1.21.2/mediamtx");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await sleep(100); } while (Date.now() < deadline);
  throw new Error("Timed out: " + label);
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function child(command, args) {
  const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [process.stdout, process.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-32768); });
  const ended = new Promise((done) => { process.once("error", (error) => done({ error })); process.once("close", (code, signal) => done({ code, signal })); });
  return { process, ended, output: () => output, async stop() {
    if (process.exitCode !== null || process.signalCode !== null) return ended;
    process.kill("SIGTERM");
    const force = setTimeout(() => process.kill("SIGKILL"), 3000);
    try { return await ended; } finally { clearTimeout(force); }
  } };
}
async function probe(url) {
  const job = child("ffprobe", ["-v", "error", "-rtsp_transport", "tcp", "-timeout", "5000000", "-show_entries", "stream=codec_name,codec_type", "-of", "json", url]);
  const force = setTimeout(() => job.process.kill("SIGKILL"), 8000);
  try {
    const result = await job.ended;
    if (result.code !== 0) return null;
    return JSON.parse(job.output()).streams;
  } finally { clearTimeout(force); }
}
function producer(url) {
  return child("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-re", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-re", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-g", "60",
    "-b:v", "1800k", "-c:a", "aac", "-b:a", "128k", "-f", "flv", url]);
}
const tracks = (streams) => streams?.some((s) => s.codec_type === "video" && s.codec_name === "h264") && streams.some((s) => s.codec_type === "audio" && s.codec_name === "aac");

test("live ingest recovers, forwarding is isolated, and publisher identity survives restart", { timeout: 180000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-broadcast-integration-")));
  const media = join(directory, "media");
  const jobs = [];
  let pipeline, demo, source, forwardRouter;
  t.after(async () => { await demo?.close(); await pipeline?.close(); await Promise.all(jobs.map((job) => job.stop())); await rm(directory, { recursive: true, force: true }); });
  async function router(name) {
    const rtmp = await freePort(), rtsp = await freePort();
    const configuration = join(directory, name + ".yml");
    await writeFile(configuration, ["logLevel: warn", "rtmp: true", "rtmpAddress: 127.0.0.1:" + rtmp, "rtsp: true", "rtspAddress: 127.0.0.1:" + rtsp,
      "rtspTransports: [tcp]", "hls: false", "webrtc: false", "moq: false", "srt: false", "api: false", "metrics: false",
      "authInternalUsers:", "  - user: any", "    ips: [127.0.0.1, '::1']", "    permissions:", "      - action: publish", "        path: live", "      - action: read", "        path: live",
      "paths:", "  live:", "    source: publisher", "    overridePublisher: false", ""].join("\n"));
    const launch = () => { const job = child(routerBinary, [configuration]); jobs.push(job); return job; };
    return { rtmp: "rtmp://127.0.0.1:" + rtmp + "/live", rtsp: "rtsp://127.0.0.1:" + rtsp + "/live", launch };
  }
  const ingest = await router("ingest"), target = await router("forward");
  const ingestRouter = ingest.launch(); forwardRouter = target.launch();
  await sleep(500);
  source = producer(ingest.rtmp); jobs.push(source);
  await until(async () => {
    if (ingestRouter.process.exitCode !== null) throw new Error("Ingest router failed: " + ingestRouter.output());
    if (source.process.exitCode !== null) throw new Error("Synthetic source failed: " + source.output());
    return tracks(await probe(ingest.rtsp));
  }, "source with both tracks");
  pipeline = await startBroadcastPipeline({ input: ingest.rtsp, mediaDir: media, forwardUrl: target.rtmp, allowInsecureLoopbackForward: true,
    retryFloorMs: 200, retryCeilingMs: 1000, publicationIntervalMs: 50 });
  await pipeline.ready({ timeoutMs: 45000 });
  await until(() => pipeline.metrics().hls.progress?.frames > 0 && pipeline.metrics().hls.progress?.speed > 0, "numeric encoder progress");
  assert.ok(tracks(await until(() => probe(target.rtsp), "forwarded tracks")), "forward did not carry both codecs");
  const token = "broadcast-integration-operator-token-at-least-32";
  const state = join(directory, "publisher.json");
  demo = await startDemoServer({ mediaDir: media, publisherState: state, operatorToken: token, operatorExtraStatus: () => pipeline.metrics(), iceServers: [] });
  const event = demo.publisher.streamEvent, swarmId = demo.publisher.swarmId;
  let changingCatalogueResponses = 0;
  const playlist = async (level) => until(async () => {
    const response = await fetch(demo.base + "/media/" + level + "/index.m3u8", { signal: AbortSignal.timeout(5000) });
    if (response.status === 503) { changingCatalogueResponses++; await response.text(); return null; }
    assert.equal(response.status, 200);
    return response.text();
  }, "stable published playlist", 6000);
  const firstLow = await playlist("low"), firstHigh = await playlist("high");
  const number = (body, tag) => Number(body.match(new RegExp(tag + ":(\\d+)"))[1]);
  assert.equal(number(firstLow, "#EXT-X-MEDIA-SEQUENCE"), number(firstHigh, "#EXT-X-MEDIA-SEQUENCE"));
  const beforeForwardFailure = pipeline.metrics().publications;
  await forwardRouter.stop();
  await until(() => pipeline.metrics().forward.restarts >= 1, "forwarding retries after target loss");
  await until(() => pipeline.metrics().publications >= beforeForwardFailure + 4, "HLS continues while forwarding is down");
  assert.equal(ingestRouter.process.exitCode, null);
  forwardRouter = target.launch();
  await until(async () => tracks(await probe(target.rtsp)), "forwarding reconnects with both tracks");
  const priorGeneration = pipeline.metrics().generation;
  const priorDiscontinuity = number(await playlist("low"), "#EXT-X-DISCONTINUITY-SEQUENCE");
  await source.stop();
  await until(() => pipeline.metrics().generation > priorGeneration, "encoder retries after input loss");
  source = producer(ingest.rtmp); jobs.push(source);
  await until(async () => tracks(await probe(ingest.rtsp)), "resumed broadcaster source");
  await until(async () => number(await playlist("low"), "#EXT-X-DISCONTINUITY-SEQUENCE") > priorDiscontinuity, "new published HLS discontinuity");
  assert.equal(demo.publisher.streamEvent.id, event.id);
  assert.equal(demo.publisher.swarmId, swarmId);
  const low = await playlist("low");
  const segment = low.split("\n").find((line) => line && !line.startsWith("#"));
  const segmentUrl = new URL(segment, demo.base + "/media/low/index.m3u8");
  const bytes = await fetch(segmentUrl).then((response) => { assert.equal(response.status, 200); return response.arrayBuffer(); });
  assert.ok(bytes.byteLength > 0);
  const parameters = new URLSearchParams({ path: segmentUrl.pathname, level: "0", sequence: String(number(low, "#EXT-X-MEDIA-SEQUENCE")), cc: String(number(low, "#EXT-X-DISCONTINUITY-SEQUENCE")) });
  const signed = await fetch(demo.base + "/commitment?" + parameters).then((r) => { assert.equal(r.status, 200); return r.json(); });
  assert.equal(signed.pubkey, event.pubkey);
  assert.equal(JSON.parse(signed.content).size, bytes.byteLength);

  // A real TLS endpoint with an untrusted certificate must be rejected before
  // an RTMP handshake; the test never contacts an external platform.
  const cert = join(directory, "untrusted.crt"), key = join(directory, "untrusted.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const tls = tlsServer({ key: await readFile(key), cert: await readFile(cert) });
  let secureConnections = 0, applicationBytes = 0;
  const tlsSockets = new Set();
  tls.on("connection", (socket) => { tlsSockets.add(socket); socket.once("close", () => tlsSockets.delete(socket)); });
  tls.on("secureConnection", (socket) => {
    secureConnections++;
    tlsSockets.add(socket); socket.once("close", () => tlsSockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (bytes) => { applicationBytes += bytes.length; });
  });
  tls.on("tlsClientError", () => {});
  await new Promise((done) => tls.listen(0, "127.0.0.1", done));
  try {
    const rejectForward = child("ffmpeg", broadcastForwardArgs(ingest.rtsp, "rtmps://localhost:" + tls.address().port + "/live/synthetic-test"));
    jobs.push(rejectForward);
    const force = setTimeout(() => rejectForward.process.kill("SIGKILL"), 15000);
    let result;
    try { result = await rejectForward.ended; } finally { clearTimeout(force); }
    assert.ok(result.code !== 0 && result.signal === null, "RTMPS did not fail promptly on an untrusted certificate");
    assert.match(rejectForward.output(), /certificate|verification|verify failed/iu);
    // GnuTLS can complete TLS negotiation before verifying the peer. The
    // security boundary is that no RTMP application bytes reach this server.
    t.diagnostic(`Untrusted TLS endpoint: ${secureConnections} completed TLS connections, ${applicationBytes} application bytes.`);
    assert.equal(applicationBytes, 0, "Untrusted RTMPS endpoint received application bytes");
  } finally {
    for (const socket of tlsSockets) socket.destroy();
    await new Promise((done) => tls.close(done));
  }

  await demo.close(); demo = null;
  await pipeline.close();
  pipeline = await startBroadcastPipeline({ input: ingest.rtsp, mediaDir: media, retryFloorMs: 200, retryCeilingMs: 1000, publicationIntervalMs: 50 });
  await pipeline.ready({ timeoutMs: 45000 });
  demo = await startDemoServer({ mediaDir: media, publisherState: state, operatorToken: token, iceServers: [] });
  assert.equal(demo.publisher.streamEvent.id, event.id);
  assert.equal(demo.publisher.swarmId, swarmId);
  const receipt = { v: 1, kind: "relayswarm-broadcast-integration", at: new Date().toISOString(), ok: true,
    scope: "synthetic H.264/AAC over loopback RTMP/RTSP; no OBS workstation, remote NAT or YouTube acceptance",
    checks: ["two-rendition HLS", "independent forward failure and recovery", "source interruption and recovery", "playlist-bound signed commitment", "untrusted TLS rejected", "stable publisher identity after orderly restart"],
    changingCatalogueResponses, metrics: pipeline.metrics() };
  await mkdir("artifacts/broadcast", { recursive: true });
  await writeFile("artifacts/broadcast/integration.json", JSON.stringify(receipt, null, 2) + "\n");
});
