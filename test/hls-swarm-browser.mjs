#!/usr/bin/env node
// Shadow mode, for real: a live HLS stream from ffmpeg, a local Nostr relay,
// and several headless Chrome viewers each playing it through hls.js with the
// swarm attached. One extra viewer plays without the swarm as a baseline, and
// one serves deliberately corrupted bytes.
//
// Everything runs on one machine, so it proves the integration works and is
// safe for the player; it does not measure real networks or NATs.
//
// Run: node test/hls-swarm-browser.mjs [--viewers 8] [--duration 90]
//      [--stagger 3000] [--chrome /path/to/chrome]
// Needs ffmpeg with libx264 and a Chrome that plays H.264 (Chromium builds
// without proprietary codecs cannot).

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { startLocalRelay } from "./support/local-relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const VIEWERS = Number(flag("viewers", 8));
const DURATION_S = Number(flag("duration", 90));
const STAGGER_MS = Number(flag("stagger", 3000));
const FALLBACK_MS = Number(flag("fallback", 1500));
const CHROME = flag("chrome", process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.error(`[hls-swarm] ${message}`);

const work = await mkdtemp(join(tmpdir(), "hls-swarm-"));
const hlsDir = join(work, "hls");
await mkdir(hlsDir);
const cleanups = [];
const cleanup = async () => {
  for (const fn of cleanups.reverse()) {
    try { await fn(); } catch {}
  }
  await rm(work, { recursive: true, force: true });
};

try {
  // --- the stream ---------------------------------------------------------
  const ffmpeg = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-re",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-b:v", "1500k", "-maxrate", "1500k", "-bufsize", "3000k", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "96k",
    "-f", "hls", "-hls_time", "2", "-hls_list_size", "8", "-hls_flags", "delete_segments+independent_segments",
    "-hls_segment_filename", join(hlsDir, "seg%05d.ts"), join(hlsDir, "index.m3u8"),
  ], { stdio: ["ignore", "inherit", "inherit"] });
  cleanups.push(() => ffmpeg.kill("SIGKILL"));

  // --- the relay and the page server ---------------------------------------
  const relay = await startLocalRelay();
  cleanups.push(() => relay.close());

  const bundle = await build({
    entryPoints: [join(here, "browser/viewer.mjs")],
    bundle: true, format: "esm", platform: "browser", write: false, minify: false,
    logLevel: "silent",
  });
  const bundleText = bundle.outputFiles[0].text;
  const page = `<!doctype html><meta charset="utf-8"><video playsinline muted autoplay width="320"></video><script type="module" src="/viewer.js"></script>`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (url.pathname === "/viewer.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(bundleText);
    if (url.pathname.startsWith("/hls/")) {
      const file = normalize(join(hlsDir, url.pathname.slice(5)));
      if (!file.startsWith(hlsDir)) return res.writeHead(403).end();
      try {
        const body = await readFile(file);
        const type = extname(file) === ".m3u8" ? "application/vnd.apple.mpegurl" : "video/mp2t";
        return res.writeHead(200, {
          "content-type": type,
          "access-control-allow-origin": "*",
          "cache-control": extname(file) === ".m3u8" ? "no-cache" : "max-age=60",
        }).end(body);
      } catch {
        return res.writeHead(404).end();
      }
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://localhost:${server.address().port}`;

  for (let i = 0; i < 40 && !existsSync(join(hlsDir, "index.m3u8")); i++) await sleep(250);
  await sleep(4500); // a few segments in the playlist before anyone joins
  log(`stream up, relay ${relay.url}, pages at ${base}`);

  // --- the viewers ----------------------------------------------------------
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  cleanups.push(() => browser.close());

  const swarmId = `harness-${randomBytes(8).toString("hex")}`;
  const pageErrors = [];
  const pages = [];
  const roles = [
    ...Array.from({ length: VIEWERS }, (_, i) => ({ viewer: `v${i}`, swarm: true, corrupt: false })),
    { viewer: "corrupt", swarm: true, corrupt: true },
    { viewer: "baseline", swarm: false, corrupt: false },
  ];
  for (const role of roles) {
    const context = await browser.newContext();
    const tab = await context.newPage();
    tab.on("pageerror", (error) => pageErrors.push({ viewer: role.viewer, message: String(error.message || error) }));
    const query = new URLSearchParams({
      viewer: role.viewer, swarm: role.swarm ? "1" : "0", corrupt: role.corrupt ? "1" : "0",
      swarmId, relay: relay.url, src: `${base}/hls/index.m3u8`, fallbackMs: String(FALLBACK_MS), unlockInterfaces: "1",
    });
    await tab.goto(`${base}/?${query}`);
    pages.push({ role, tab });
    log(`joined ${role.viewer}`);
    await sleep(STAGGER_MS);
  }

  log(`running for ${DURATION_S}s`);
  await sleep(DURATION_S * 1000);

  const reports = [];
  for (const { role, tab } of pages) reports.push({ ...role, ...(await tab.evaluate(() => window.__viewer.report())) });
  const stopChecks = [];
  for (const { role, tab } of pages) {
    if (!role.swarm) continue;
    await tab.evaluate(() => window.__viewer.stop());
    stopChecks.push({ viewer: role.viewer, loaderRestored: await tab.evaluate(() => window.__viewer.loaderRestored()) });
  }

  // --- the receipt ----------------------------------------------------------
  const honest = reports.filter((r) => r.swarm && !r.corrupt);
  const sum = (field) => honest.reduce((total, r) => total + (r.swarm.segments[field] || 0), 0);
  const resolved = sum("peerInTime") + sum("peerLate") + sum("peerMiss") + sum("peerCorrupt");
  const latencies = honest.map((r) => r.swarm.segments.peerLatencyMedianMs).filter((v) => v !== null);
  const baseline = reports.find((r) => r.viewer === "baseline");
  const summary = {
    ok: false,
    at: new Date().toISOString(),
    shape: { viewers: VIEWERS, plusCorruptPeer: 1, plusBaselineWithoutSwarm: 1, durationS: DURATION_S, staggerMs: STAGGER_MS, segmentSeconds: 2, videoKbps: 1500, originFallbackMs: FALLBACK_MS },
    aggregate: {
      originLoaded: sum("originLoaded"),
      raced: sum("raced"),
      noPeers: sum("noPeers"),
      peerInTime: sum("peerInTime"),
      peerLate: sum("peerLate"),
      peerMiss: sum("peerMiss"),
      peerCorrupt: sum("peerCorrupt"),
      inTimeShare: resolved ? Number((sum("peerInTime") / resolved).toFixed(3)) : 0,
      medianOfViewerPeerLatencyMs: latencies.length ? latencies.sort((a, b) => a - b)[latencies.length >> 1] : null,
      bytesFromPeers: honest.reduce((t, r) => t + r.swarm.bytes.fromPeers, 0),
      bytesUploaded: reports.filter((r) => r.swarm).reduce((t, r) => t + r.swarm.bytes.uploaded, 0),
      candidatePairs: honest.reduce((pairs, r) => {
        for (const [k, v] of Object.entries(r.swarm.peers.candidatePairs)) pairs[k] = (pairs[k] || 0) + v;
        return pairs;
      }, {}),
      swarmErrors: reports.filter((r) => r.swarm).reduce((t, r) => t + r.swarm.errors.total, 0),
      relayEventsPublished: reports.filter((r) => r.swarm).reduce((t, r) => t + r.swarm.relays.published, 0),
      corruptPeerBannedBy: honest.filter((r) => r.swarm.peers.banned > 0).length,
    },
    player: {
      withSwarm: honest.map((r) => ({ viewer: r.viewer, stalls: r.player.stalls, fatalErrors: r.player.fatalErrors, currentTime: Number(r.player.currentTime.toFixed(1)) })),
      baseline: { stalls: baseline.player.stalls, fatalErrors: baseline.player.fatalErrors, currentTime: Number(baseline.player.currentTime.toFixed(1)) },
    },
    stopChecks,
    pageErrors,
    viewers: reports,
  };
  const failures = [];
  if (summary.aggregate.peerInTime === 0) failures.push("no peer delivered a segment in time");
  if (summary.aggregate.inTimeShare < 0.5) failures.push(`in-time share ${summary.aggregate.inTimeShare} below 0.5`);
  if (honest.some((r) => r.player.fatalErrors > 0 || r.player.currentTime < DURATION_S * 0.5)) failures.push("a swarm viewer did not keep playing");
  if (stopChecks.some((c) => !c.loaderRestored)) failures.push("stop() did not restore the fragment loader");
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);
  if (summary.aggregate.swarmErrors > 0) failures.push(`${summary.aggregate.swarmErrors} swarm error(s)`);
  summary.ok = failures.length === 0;
  summary.failures = failures;

  const resultsDir = join(here, "../spikes/results");
  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, `hls-swarm-shadow-${summary.at.replace(/[-:]/g, "").replace(/\..+/, "")}Z.json`);
  await writeFile(file, `${JSON.stringify(summary, null, 2)}\n`);
  const { viewers: _omit, ...printable } = summary;
  console.log(JSON.stringify(printable, null, 2));
  log(`receipt ${file}`);
  await cleanup();
  process.exit(summary.ok ? 0 : 1);
} catch (error) {
  console.error(`FAIL: ${error.stack || error.message}`);
  await cleanup();
  process.exit(1);
}
