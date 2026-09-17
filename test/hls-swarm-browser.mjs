#!/usr/bin/env node
// Shadow mode, for real: a live HLS stream from ffmpeg, a local Nostr relay,
// and several headless Chrome viewers each playing it through hls.js with the
// swarm attached. One extra viewer plays without the swarm as a baseline, and
// one serves deliberately corrupted bytes.
//
// Viewers arrive in waves, because an audience does: the swarm is full by the
// time the later waves knock, and whether those viewers get served by peers or
// fall back to the origin for ever is the thing this measures.
//
// Everything runs on one machine, so it proves the integration works and is
// safe for the player; it does not measure real networks or NATs.
//
// Run: node test/hls-swarm-browser.mjs [--viewers 12] [--duration 90]
//      [--stagger 3000] [--waves 3] [--waveGap 30000] [--chrome /path/to/chrome]
// --duration is the measuring window after the last wave has joined.
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
const VIEWERS = Number(flag("viewers", 12));
const DURATION_S = Number(flag("duration", 90));
const STAGGER_MS = Number(flag("stagger", 3000));
const WAVES = Math.max(1, Number(flag("waves", 3)));
const WAVE_GAP_MS = Number(flag("waveGap", 30000));
// Scaled down on purpose: an audience is always far larger than any one
// viewer's peer limit, and that is the condition rotation exists for. Six
// peers among nine viewers is not full; two is.
const MAX_PEERS = Number(flag("maxPeers", 6));
// The corrupt peer earns a ban, and every ban frees a slot on whoever banned
// it. Useful for the integrity assertion, noise for the rotation one, so a
// saturation run turns it off.
const CORRUPT_PEER = flag("corruptPeer", "1") !== "0";
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
  // Wave 0 also carries the corrupt peer and the no-swarm baseline; the later
  // waves are the ones knocking on a swarm that is already full.
  const perWave = Math.ceil(VIEWERS / WAVES);
  const roles = [];
  for (let i = 0; i < VIEWERS; i++) roles.push({ viewer: `v${i}`, swarm: true, corrupt: false, wave: Math.floor(i / perWave) });
  if (CORRUPT_PEER) roles.push({ viewer: "corrupt", swarm: true, corrupt: true, wave: 0 });
  roles.push({ viewer: "baseline", swarm: false, corrupt: false, wave: 0 });

  const joinViewer = async (role) => {
    const context = await browser.newContext();
    const tab = await context.newPage();
    tab.on("pageerror", (error) => pageErrors.push({ viewer: role.viewer, message: String(error.message || error) }));
    const query = new URLSearchParams({
      viewer: role.viewer, swarm: role.swarm ? "1" : "0", corrupt: role.corrupt ? "1" : "0",
      swarmId, relay: relay.url, src: `${base}/hls/index.m3u8`, fallbackMs: String(FALLBACK_MS), unlockInterfaces: "1",
      rotation: process.env.RELAYSWARM_NO_ROTATION === "1" ? "0" : "1",
      maxPeers: String(MAX_PEERS),
    });
    await tab.goto(`${base}/?${query}`);
    pages.push({ role, tab });
    log(`joined ${role.viewer} (wave ${role.wave})`);
  };

  for (let wave = 0; wave < WAVES; wave++) {
    const cohort = roles.filter((role) => role.wave === wave);
    if (!cohort.length) continue;
    if (wave > 0) {
      log(`wave ${wave} waits ${WAVE_GAP_MS / 1000}s so the swarm is already full`);
      await sleep(WAVE_GAP_MS);
    }
    for (const role of cohort) {
      await joinViewer(role);
      await sleep(STAGGER_MS);
    }
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
  // Per wave: the later ones are the question this harness exists to answer.
  const waveRows = [];
  for (let wave = 0; wave < WAVES; wave++) {
    const cohort = honest.filter((r) => r.wave === wave);
    if (!cohort.length) continue;
    const field = (name) => cohort.reduce((total, r) => total + (r.swarm.segments[name] || 0), 0);
    const peerField = (name) => cohort.reduce((total, r) => total + (r.swarm.peers[name] || 0), 0);
    const settled = field("peerInTime") + field("peerLate") + field("peerMiss") + field("peerCorrupt");
    waveRows.push({
      wave,
      viewers: cohort.length,
      linksOpened: peerField("linksOpened"),
      offersRefused: peerField("offersRefused"),
      evicted: peerField("evicted"),
      retriesScheduled: peerField("retriesScheduled"),
      referralsFollowed: peerField("referralsFollowed"),
      noPeers: field("noPeers"),
      peerInTime: field("peerInTime"),
      peerMiss: field("peerMiss"),
      peerCorrupt: field("peerCorrupt"),
      inTimeShare: settled ? Number((field("peerInTime") / settled).toFixed(3)) : 0,
      viewersServedByAPeer: cohort.filter((r) => r.swarm.segments.peerInTime > 0).length,
      // What joining late actually costs: seconds of playing from the origin
      // before the swarm carried anything for this viewer.
      secondsToFirstPeerSegment: cohort
        .map((r) => (r.swarm.segments.firstPeerSegmentAtMs === null ? null : Math.round(r.swarm.segments.firstPeerSegmentAtMs / 100) / 10))
        .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b)),
      secondsToFirstLink: cohort
        .map((r) => (r.swarm.peers.firstLinkAtMs === null ? null : Math.round(r.swarm.peers.firstLinkAtMs / 100) / 10))
        .sort((a, b) => (a === null ? 1 : b === null ? -1 : a - b)),
    });
  }

  const summary = {
    ok: false,
    at: new Date().toISOString(),
    rotation: process.env.RELAYSWARM_NO_ROTATION === "1" ? "off" : "on",
    shape: { viewers: VIEWERS, waves: WAVES, waveGapMs: WAVE_GAP_MS, maxPeers: MAX_PEERS, corruptPeer: CORRUPT_PEER, plusCorruptPeer: CORRUPT_PEER ? 1 : 0, plusBaselineWithoutSwarm: 1, durationS: DURATION_S, staggerMs: STAGGER_MS, segmentSeconds: 2, videoKbps: 1500, originFallbackMs: FALLBACK_MS },
    waves: waveRows,
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
  const lastWave = waveRows[waveRows.length - 1];
  if (summary.aggregate.peerInTime === 0) failures.push("no peer delivered a segment in time");
  if (summary.rotation === "on") {
    if (!lastWave || lastWave.peerInTime === 0) failures.push("the last wave was never served by a peer");
    if (lastWave && lastWave.viewersServedByAPeer < lastWave.viewers) {
      failures.push(`${lastWave.viewers - lastWave.viewersServedByAPeer} of ${lastWave.viewers} late viewers fell back to the origin throughout`);
    }
    if (lastWave && lastWave.inTimeShare < 0.5) failures.push(`late-wave in-time share ${lastWave.inTimeShare} below 0.5`);
  }
  if (summary.aggregate.inTimeShare < 0.5) failures.push(`in-time share ${summary.aggregate.inTimeShare} below 0.5`);
  if (honest.some((r) => r.player.fatalErrors > 0 || r.player.currentTime < DURATION_S * 0.5)) failures.push("a swarm viewer did not keep playing");
  if (stopChecks.some((c) => !c.loaderRestored)) failures.push("stop() did not restore the fragment loader");
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);
  if (summary.aggregate.swarmErrors > 0) failures.push(`${summary.aggregate.swarmErrors} swarm error(s)`);
  summary.ok = failures.length === 0;
  summary.failures = failures;

  const resultsDir = join(here, "../spikes/results");
  await mkdir(resultsDir, { recursive: true });
  const stamp = summary.at.replace(/[-:]/g, "").replace(/\..+/, "");
  const file = join(resultsDir, `hls-swarm-waves-rotation-${summary.rotation}-${stamp}Z.json`);
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
