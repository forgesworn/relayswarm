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
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { commitmentContent, KIND_SEGMENT_COMMITMENT } from "../src/browser/segment-commitment.mjs";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { startLocalRelay } from "./support/local-relay.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const MODE = flag("mode", "shadow");
const VIEWERS = Number(flag("viewers", 12));
const DURATION_S = Number(flag("duration", 90));
const CHURN_EVERY_S = Number(flag("churnEvery", 0));
const CHURN_COUNT = Number(flag("churnCount", 2));
if (!Number.isSafeInteger(DURATION_S) || DURATION_S < 15 || DURATION_S > 7200
  || !Number.isSafeInteger(CHURN_EVERY_S) || CHURN_EVERY_S !== 0 && (CHURN_EVERY_S < 30 || CHURN_EVERY_S > 1800)
  || !Number.isSafeInteger(CHURN_COUNT) || CHURN_COUNT < 1 || CHURN_COUNT > 4) throw new Error("Invalid bounded soak duration or churn options.");
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
// Peer-first viewers verify commitments with the Rust core unless --core js.
const CORE = flag("core", "wasm");
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
  const swarmId = `harness-${randomBytes(8).toString("hex")}`;
  const streamKey = generateSecretKey();
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000), tags: [["d", "harness"], ["relayswarm", "redistribute", "1"]], content: "" }, streamKey);

  const bundle = await build({
    entryPoints: [join(here, "browser/viewer.mjs")],
    bundle: true, format: "esm", platform: "browser", write: false, minify: false,
    logLevel: "silent",
  });
  const bundleText = bundle.outputFiles[0].text;
  const coreModule = await readFile(join(here, "../src/browser/relayswarm-core.wasm"));
  const page = `<!doctype html><meta charset="utf-8"><video playsinline muted autoplay width="320"></video><script type="module" src="/viewer.js"></script>`;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(page);
    if (url.pathname === "/authorisation.json") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(streamEvent));
    if (url.pathname === "/commitment") {
      const path = url.searchParams.get("path") || "";
      if (!/^\/hls\/seg[0-9]+\.ts$/.test(path)) return res.writeHead(400).end();
      try {
        const bytes = await readFile(join(hlsDir, path.slice(5)));
        const digest = (value) => createHash("sha256").update(value).digest("hex");
        const fields = {
          streamEventId: streamEvent.id, swarmId, key: digest(`${swarmId}\n${path}`),
          rendition: url.searchParams.get("bad") === "1" ? "wrong-rendition" : url.searchParams.get("level"), sequence: Number(url.searchParams.get("sequence")),
          discontinuity: Number(url.searchParams.get("cc")), part: null,
          sha256: digest(bytes), size: bytes.length, expiresAt: Math.floor(Date.now() / 1000) + 30,
        };
        const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: Math.floor(Date.now() / 1000), tags: [["x", swarmId], ["e", streamEvent.id]], content: commitmentContent(fields) }, streamKey);
        return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(event));
      } catch { return res.writeHead(404).end(); }
    }
    if (url.pathname === "/relayswarm-core.wasm") return res.writeHead(200, { "content-type": "application/wasm" }).end(coreModule);
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

  // Both live targets must fit before the first viewer joins. A short initial
  // playlist collapses the corrupt seeder's one-segment lead: nobody asks it
  // for advertised bytes, so the integrity assertion is never exercised.
  const initialSegments = MODE === "peer-first" && CORRUPT_PEER ? 8 : 3;
  const streamDeadline = Date.now() + 40000;
  while (true) {
    try {
      const text = await readFile(join(hlsDir, "index.m3u8"), "utf8");
      if ((text.match(/^#EXTINF:/gmu) || []).length >= initialSegments) break;
    } catch {}
    if (Date.now() >= streamDeadline) throw new Error(`Live fixture did not publish ${initialSegments} segments within 40 s.`);
    await sleep(250);
  }
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

  const pageErrors = [];
  const pages = [];
  // Wave 0 also carries the corrupt peer and the no-swarm baseline; the later
  // waves are the ones knocking on a swarm that is already full.
  const perWave = Math.ceil(VIEWERS / WAVES);
  const roles = [];
  for (let i = 0; i < VIEWERS; i++) roles.push({ viewer: `v${i}`, swarm: true, corrupt: false, wave: Math.floor(i / perWave) });
  if (CORRUPT_PEER) roles.unshift({ viewer: "corrupt", swarm: true, corrupt: true, wave: 0 });
  roles.push({ viewer: "baseline", swarm: false, corrupt: false, wave: 0 });

  const joinViewer = async (role) => {
    const context = await browser.newContext();
    const tab = await context.newPage();
    tab.on("pageerror", (error) => pageErrors.push({ viewer: role.viewer, message: String(error.message || error) }));
    const query = new URLSearchParams({
      mode: role.corrupt ? "shadow" : MODE, viewer: role.viewer, swarm: role.swarm ? "1" : "0", corrupt: role.corrupt ? "1" : "0",
      commitmentFaults: MODE === "peer-first" && role.viewer === "v1" ? "1" : "0",
      swarmId, relay: relay.url, src: `${base}/hls/index.m3u8`, fallbackMs: String(FALLBACK_MS), unlockInterfaces: "1",
      rotation: process.env.RELAYSWARM_NO_ROTATION === "1" ? "0" : "1",
      maxPeers: String(MAX_PEERS),
      core: CORE === "wasm" ? "1" : "0",
    });
    const network = { originSegmentRequests: 0 };
    tab.on("request", (request) => { if (/\/hls\/seg[0-9]+\.ts/.test(request.url())) network.originSegmentRequests++; });
    await tab.goto(`${base}/?${query}`);
    pages.push({ role, tab, network, context, joinedAt: Date.now() });
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
      // Give the first honest viewer only the tampering peer to ask. This
      // makes corruption detection an exercised requirement, not luck in a
      // larger swarm's peer selection.
      if (CORRUPT_PEER && role.viewer === "v0") {
        // Wait for an observed challenge, rather than assuming that eight
        // seconds of two-player playback caused a request to the bad seeder.
        // The final assertion still fails if it was never exercised.
        await pages.find((page) => page.role.viewer === "v0").tab.waitForFunction(() => window.__viewer.report().swarm.peers.banned > 0, null, { timeout: 25000 }).catch(() => {});
      }
    }
  }

  log(`running for ${DURATION_S}s`);
  const churn = [], observationAt = Date.now(), observationUntil = observationAt + DURATION_S * 1000;
  let nextChurn = CHURN_EVERY_S ? observationAt + CHURN_EVERY_S * 1000 : Infinity, churnIndex = 0;
  while (Date.now() < observationUntil) {
    await sleep(Math.min(30000, observationUntil - Date.now(), nextChurn - Date.now()));
    if (Date.now() >= nextChurn && nextChurn + 30000 <= observationUntil) {
      // Keep v0/v1 and the corrupt seeder for deterministic integrity probes.
      const eligible = pages.filter(({ role }) => role.swarm && !role.corrupt && role.wave > 0);
      for (let i = 0; i < Math.min(CHURN_COUNT, eligible.length); i++) {
        const leaving = eligible[(churnIndex + i) % eligible.length];
        const final = await leaving.tab.evaluate(() => window.__viewer.report());
        await leaving.tab.evaluate(() => window.__viewer.stop());
        const stopped = await leaving.tab.evaluate(() => ({ metrics: window.__viewer.stoppedMetrics(), loaderRestored: window.__viewer.loaderRestored() }));
        if (stopped.metrics.peers.connected || stopped.metrics.peers.dialling || stopped.metrics.relays.connected || stopped.metrics.bytes.held || !stopped.loaderRestored) throw new Error("Churn departure retained swarm resources.");
        await leaving.context.close(); pages.splice(pages.indexOf(leaving), 1);
        churn.push({ elapsedMs: Date.now() - observationAt, viewer: leaving.role.viewer,
          player: { stalls: final.player.stalls, fatalErrors: final.player.fatalErrors, currentTime: final.player.currentTime },
          resourceHighWater: final.resourceHighWater, bytes: final.swarm.bytes, originSegmentRequests: leaving.network.originSegmentRequests, cleanStop: true });
        await joinViewer(leaving.role);
      }
      churnIndex += CHURN_COUNT;
      log(`churn departures/rejoins: ${churn.length}`);
      nextChurn += CHURN_EVERY_S * 1000;
    } else if (Date.now() >= nextChurn) nextChurn = Infinity;
  }

  const reports = [];
  for (const { role, tab, network, joinedAt } of pages) reports.push({ ...role, network,
    observedSeconds: (Date.now() - joinedAt) / 1000, ...(await tab.evaluate(() => window.__viewer.report())) });
  const stopChecks = [];
  for (const { role, tab } of pages) {
    if (!role.swarm) continue;
    await tab.evaluate(() => window.__viewer.stop());
    stopChecks.push({ viewer: role.viewer, metrics: await tab.evaluate(() => window.__viewer.stoppedMetrics()), loaderRestored: await tab.evaluate(() => window.__viewer.loaderRestored()) });
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
      peerFirstLoaded: field("peerFirstLoaded"),
      inTimeShare: MODE === "shadow" && settled ? Number((field("peerInTime") / settled).toFixed(3)) : null,
      sampledInTimeShare: MODE === "shadow" && settled + field("noPeers") ? Number((field("peerInTime") / (settled + field("noPeers"))).toFixed(3)) : null,
      peerFirstShare: MODE === "peer-first" ? Number((field("peerFirstLoaded") / Math.max(1, field("originLoaded") + field("peerFirstLoaded"))).toFixed(3)) : null,
      viewersServedByAPeer: cohort.filter((r) => MODE === "peer-first" ? r.swarm.segments.peerFirstLoaded > 0 : r.swarm.segments.peerInTime > 0).length,
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
    mode: MODE,
    rotation: process.env.RELAYSWARM_NO_ROTATION === "1" ? "off" : "on",
    shape: { liveSyncDurationCount: MODE === "peer-first" ? 4 : 3, ...(MODE === "peer-first" ? { maxBufferLength: 4, maxMaxBufferLength: 6 } : {}), viewers: VIEWERS, waves: WAVES, waveGapMs: WAVE_GAP_MS, maxPeers: MAX_PEERS, corruptPeer: CORRUPT_PEER, plusCorruptPeer: CORRUPT_PEER ? 1 : 0, plusBaselineWithoutSwarm: 1, durationS: DURATION_S, staggerMs: STAGGER_MS, segmentSeconds: 2, videoKbps: 1500, originFallbackMs: FALLBACK_MS },
    waves: waveRows,
    churn: { intervalSeconds: CHURN_EVERY_S, countPerInterval: CHURN_COUNT, departures: churn, observationMs: Date.now() - observationAt },
    aggregate: {
      originLoaded: sum("originLoaded"),
      peerFirstLoaded: sum("peerFirstLoaded"),
      originFallbacks: sum("originFallbacks"),
      peerFirstBytes: honest.reduce((total, report) => total + report.swarm.bytes.peerFirst, 0),
      raced: sum("raced"),
      noPeers: sum("noPeers"),
      peerInTime: sum("peerInTime"),
      peerLate: sum("peerLate"),
      peerMiss: sum("peerMiss"),
      peerCorrupt: sum("peerCorrupt"),
      inTimeShare: MODE === "shadow" && resolved ? Number((sum("peerInTime") / resolved).toFixed(3)) : null,
      sampledInTimeShare: MODE === "shadow" && resolved + sum("noPeers") ? Number((sum("peerInTime") / (resolved + sum("noPeers"))).toFixed(3)) : null,
      peerFirstShare: MODE === "peer-first" ? Number((sum("peerFirstLoaded") / Math.max(1, sum("originLoaded") + sum("peerFirstLoaded"))).toFixed(3)) : null,
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
      coreVerifiers: Object.fromEntries(["wasm", "js"].map((kind) => [kind, honest.filter((r) => r.swarm.core?.verifier === kind).length])),
      coreLinks: honest.reduce((total, r) => ({ wasm: total.wasm + (r.swarm.core?.links?.wasm ?? 0), js: total.js + (r.swarm.core?.links?.js ?? 0) }), { wasm: 0, js: 0 }),
      coreSelections: Object.fromEntries(["wasm", "js"].map((kind) => [kind, honest.filter((r) => (r.swarm.core?.selection ?? "js") === kind).length])),
    },
    player: {
      withSwarm: honest.map((r) => ({ viewer: r.viewer, observedSeconds: r.observedSeconds, stalls: r.player.stalls, fatalErrors: r.player.fatalErrors, currentTime: Number(r.player.currentTime.toFixed(1)) })),
      baseline: { stalls: baseline.player.stalls, fatalErrors: baseline.player.fatalErrors, currentTime: Number(baseline.player.currentTime.toFixed(1)) },
    },
    stopChecks,
    pageErrors,
    viewers: reports,
  };
  const failures = [];
  const lastWave = waveRows[waveRows.length - 1];
  if (MODE === "shadow" && summary.aggregate.peerInTime === 0) failures.push("no peer delivered a segment in time");
  if (MODE === "shadow" && summary.rotation === "on") {
    if (!lastWave || lastWave.peerInTime === 0) failures.push("the last wave was never served by a peer");
    if (lastWave && lastWave.viewersServedByAPeer < lastWave.viewers) {
      failures.push(`${lastWave.viewers - lastWave.viewersServedByAPeer} of ${lastWave.viewers} late viewers fell back to the origin throughout`);
    }
    if (lastWave && lastWave.inTimeShare < 0.5) failures.push(`late-wave in-time share ${lastWave.inTimeShare} below 0.5`);
  }
  if (MODE === "shadow" && summary.aggregate.inTimeShare < 0.5) failures.push(`in-time share ${summary.aggregate.inTimeShare} below 0.5`);
  if (honest.some((r) => r.player.fatalErrors > 0 || r.player.currentTime < r.observedSeconds * 0.5)) failures.push("a swarm viewer did not keep playing");
  if (CORRUPT_PEER && summary.aggregate.corruptPeerBannedBy === 0) failures.push("the tampering peer was never detected and banned");
  if (honest.some((report) => report.player.stalls > baseline.player.stalls)) failures.push("a swarm viewer stalled more often than the baseline");
  if (baseline.player.fatalErrors > 0 || baseline.player.currentTime < DURATION_S * 0.5) failures.push("the baseline did not keep playing");
  if (MODE === "peer-first" && (!summary.aggregate.peerFirstBytes || !honest.some((report) => report.network.originSegmentRequests < report.player.fragsLoaded))) failures.push("peer-first did not replace any origin segment requests");
  if (MODE === "peer-first") {
    const late = honest.filter((report) => report.wave > 0);
    if (late.length && !late.some((report) => report.swarm.segments.peerFirstLoaded > 0)) failures.push("the late cohort received no authenticated peer-first segments");
    if (summary.aggregate.peerFirstShare < 0.1) failures.push("peer-first replaced fewer than 10% of fragment loads");
    // Fresh segments still need origin seeders. A viewer that uploads those
    // bytes to consumers can legitimately receive every own segment by HTTP.
  }
  if (MODE === "peer-first" && CORE === "wasm" && honest.some((report) => report.swarm.core?.verifier !== "wasm" || report.swarm.core.selection !== "wasm" || !report.swarm.core.links?.wasm || report.swarm.core.links.js || report.swarm.core.fallbacks || !report.swarm.core.decided.wasm)) failures.push("a peer-first viewer did not link, verify or select with the Rust core");
  if (MODE === "peer-first" && VIEWERS >= 2) {
    const faulted = honest.find((report) => report.viewer === "v1");
    if (!faulted?.swarm.segments.commitmentRejected || !faulted?.swarm.segments.commitmentUnavailable) failures.push("invalid and stalled commitments were not exercised");
  }
  if (stopChecks.some((check) => check.metrics.peers.connected || check.metrics.peers.dialling || check.metrics.relays.connected || check.metrics.bytes.held)) failures.push("stop() left swarm resources alive");
  if (stopChecks.some((c) => !c.loaderRestored)) failures.push("stop() did not restore the fragment loader");
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s)`);
  if (summary.aggregate.swarmErrors > 0) failures.push(`${summary.aggregate.swarmErrors} swarm error(s)`);
  if (reports.filter((report) => report.swarm).some((report) => report.resourceSamples.some((sample) => sample.connected + sample.dialling > MAX_PEERS
    || sample.heldBytes > 64 * 1024 * 1024 || sample.relays > 1))) failures.push("a sampled resource exceeded the configured limit");
  if ([...reports.filter((report) => report.swarm), ...churn].some(({ resourceHighWater: sample }) => sample.activePeers > MAX_PEERS
    || sample.heldBytes > 64 * 1024 * 1024 || sample.relays > 1)) failures.push("a whole-run resource high-water measurement exceeded the configured limit");
  if (churn.some(({ player }) => player.fatalErrors > 0)) failures.push("a departed viewer had a fatal playback error");
  summary.ok = failures.length === 0;
  summary.failures = failures;

  const resultsDir = flag("resultsDir", join(here, "../spikes/results"));
  await mkdir(resultsDir, { recursive: true });
  const stamp = summary.at.replace(/[-:]/g, "").replace(/\..+/, "");
  const file = join(resultsDir, `hls-swarm-${MODE}-rotation-${summary.rotation}-${stamp}Z.json`);
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
