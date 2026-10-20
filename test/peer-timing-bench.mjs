#!/usr/bin/env node
// Peer timing bench. The field-test demo page, two live renditions at field
// segment sizes (about 210 KB low, 670 KB high per 2 s segment), and headless
// Chrome viewers whose peer links carry an emulated round trip of about
// 180 ms and whose origin media fetches are slowed to field-like times, using
// Chrome DevTools network emulation set before any peer connection opens.
//
// It is loopback with emulated delay: it shows whether a loader change helps
// at relayed timing before spending a field cycle. It does not model TLS/TCP
// relay queueing, loss, jitter or NATs, and its results are not field evidence.
// Dev-only; not part of npm test.
//
// Run: node test/peer-timing-bench.mjs [--duration 180] [--switchAt 90]
//   [--p2pLatency 45] [--originLatency 150] [--originBps 800000]
//   [--highContributors 2] [--lowContributors 1] [--receivers 2]
//   [--uploadLimit 512000|128000|1250000] (the demo's per-holder rate choices)
//   [--resultsDir artifacts/peer-timing-bench-<stamp>] [--chrome path]
// --p2pLatency is applied on every page in both directions, so the peer
// round trip is about four times it. Samples are written in the qualifier's
// samples.jsonl row shape so the field analysis scripts read them unchanged.

import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile, readFile, appendFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startDemoServer } from "../demo/server.mjs";

const { values } = parseArgs({ options: {
  chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  resultsDir: { type: "string" }, label: { type: "string", default: "bench" },
  duration: { type: "string", default: "180" }, switchAt: { type: "string" }, warmup: { type: "string", default: "20" },
  p2pLatency: { type: "string", default: "45" }, originLatency: { type: "string", default: "150" }, originBps: { type: "string", default: "800000" },
  highContributors: { type: "string", default: "2" }, lowContributors: { type: "string", default: "1" }, receivers: { type: "string", default: "2" },
  baseline: { type: "string", default: "1" }, sampleEvery: { type: "string", default: "3000" },
  uploadLimit: { type: "string", default: "512000" },
  highKbps: { type: "string", default: "2450" }, lowKbps: { type: "string", default: "650" },
} });
const int = (name, min, max) => { const n = Number(values[name]); if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid --${name}`); return n; };
const DURATION_S = int("duration", 30, 1800), WARMUP_S = int("warmup", 5, 120), SWITCH_S = values.switchAt === undefined ? Math.floor(DURATION_S / 2) : int("switchAt", 0, DURATION_S);
const P2P_LATENCY = int("p2pLatency", 0, 500), ORIGIN_LATENCY = int("originLatency", 0, 5000), ORIGIN_BPS = int("originBps", -1, 1e9);
const HIGH_C = int("highContributors", 1, 4), LOW_C = int("lowContributors", 0, 4), RECEIVERS = int("receivers", 1, 4), BASELINE = int("baseline", 0, 1);
if (!["128000", "512000", "1250000"].includes(values.uploadLimit)) throw new Error("Invalid --uploadLimit; use a demo choice: 128000, 512000 or 1250000.");
const UPLOAD_LIMIT = values.uploadLimit;
const SAMPLE_MS = int("sampleEvery", 1000, 10000), HIGH_KBPS = int("highKbps", 200, 8000), LOW_KBPS = int("lowKbps", 100, 4000);
const stamp = new Date().toISOString().replace(/[:.]/gu, "").slice(0, 15);
const RESULTS = values.resultsDir ?? `artifacts/peer-timing-bench-${stamp}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.error(`[peer-bench] ${message}`);
const pct = (list, q) => { const v = list.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))] : null; };

// Field renditions (src/broadcast-pipeline.mjs) at reduced resolution to keep
// decode cheap on a shared host; constant-bitrate padding keeps segment bytes
// at field size, which is what transfer time follows.
const LEVELS = [
  { name: "low", size: "640x360", bitrate: LOW_KBPS, bandwidth: 850000 },
  { name: "high", size: "854x480", bitrate: HIGH_KBPS, bandwidth: 2800000 },
];
function encoder(output, level) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-re",
    "-f", "lavfi", "-i", `testsrc2=size=${level.size}:rate=30`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-b:v", `${level.bitrate}k`, "-maxrate", `${level.bitrate}k`, "-minrate", `${level.bitrate}k`, "-bufsize", `${level.bitrate * 2}k`,
    "-x264-params", "nal-hrd=cbr:force-cfr=1", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
    "-f", "hls", "-hls_time", "2", "-hls_list_size", "12", "-hls_flags", "delete_segments+independent_segments+temp_file",
    "-hls_segment_filename", output.replace(/\.m3u8$/u, "-%05d.ts"), output];
}

const cleanups = [];
let cleaning = null;
const cleanup = () => cleaning ??= (async () => { for (const fn of cleanups.reverse()) { try { await fn(); } catch (error) { log(`cleanup: ${error.message}`); } } })();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { log(`${signal}: cleaning up`); cleanup().finally(() => process.exit(130)); });

const run = { v: 1, kind: "relayswarm-peer-timing-bench", label: values.label, startedAt: new Date().toISOString(), ok: false, failures: [],
  scope: "Loopback with Chrome DevTools network emulation; not field, NAT or relay evidence.",
  config: { durationS: DURATION_S, warmupS: WARMUP_S, switchAtS: SWITCH_S, sampleMs: SAMPLE_MS, p2pLatencyPerPageMs: P2P_LATENCY, originLatencyMs: ORIGIN_LATENCY, originDownloadBps: ORIGIN_BPS, uploadLimitBytesPerSecond: Number(UPLOAD_LIMIT),
    roles: { highContributors: HIGH_C, lowContributors: LOW_C, receivers: RECEIVERS, baseline: BASELINE }, levels: LEVELS },
  environment: { loadAverageStart: loadavg().map((n) => +n.toFixed(2)) } };
try {
  run.environment.source = { head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirtyRuntime: execFileSync("git", ["status", "--porcelain", "--", "src", "demo"], { encoding: "utf8" }).trim().split("\n").filter(Boolean) };
} catch { run.environment.source = null; }

const samplesPath = join(RESULTS, "browser", "samples.jsonl");
const pages = [];
try {
  await mkdir(join(RESULTS, "browser"), { recursive: true, mode: 0o700 });
  await writeFile(samplesPath, "", { mode: 0o600 });

  // --- live media ---------------------------------------------------------
  const mediaDir = await mkdtemp(join(tmpdir(), "relayswarm-bench-"));
  cleanups.push(() => rm(mediaDir, { recursive: true, force: true }));
  const encoders = [];
  for (const level of LEVELS) {
    await mkdir(join(mediaDir, level.name));
    const child = spawn("ffmpeg", encoder(join(mediaDir, level.name, "index.m3u8"), level), { stdio: ["ignore", "ignore", "pipe"] });
    let error = ""; child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-2000); });
    const exited = new Promise((resolve) => child.once("exit", resolve));
    encoders.push({ level, child, error: () => error });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; });
  }
  await writeFile(join(mediaDir, "master.m3u8"), `#EXTM3U\n${LEVELS.map((l) => `#EXT-X-STREAM-INF:BANDWIDTH=${l.bandwidth},RESOLUTION=${l.size}\n${l.name}/index.m3u8`).join("\n")}\n`);
  for (const deadline = Date.now() + 20000; ;) {
    const ready = await Promise.all(LEVELS.map((l) => readFile(join(mediaDir, l.name, "index.m3u8"), "utf8").then((t) => (t.match(/#EXTINF:/gu) || []).length >= 3, () => false)));
    if (ready.every(Boolean)) break;
    for (const e of encoders) if (e.child.exitCode !== null) throw new Error(`ffmpeg ${e.level.name} exited: ${e.error()}`);
    if (Date.now() > deadline) throw new Error("Live playlists did not reach three segments within 20 s.");
    await sleep(250);
  }

  // --- origin and browser -------------------------------------------------
  const demo = await startDemoServer({ mediaDir, iceServers: [] });
  cleanups.push(() => demo.close());
  const rules = [
    { urlPattern: `${demo.base.replace(/\/$/u, "")}/media/*`, latency: ORIGIN_LATENCY, downloadThroughput: ORIGIN_BPS, uploadThroughput: -1 },
    // Empty pattern: everything else, and Chrome applies it to peer sockets.
    { urlPattern: "", latency: P2P_LATENCY, downloadThroughput: -1, uploadThroughput: -1 },
  ];
  run.config.rules = rules;
  const browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  cleanups.push(() => browser.close());
  run.environment.chrome = browser.version();

  async function start(role) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    // Must precede page load: Chrome attaches p2p throttling when a socket opens.
    await cdp.send("Network.emulateNetworkConditionsByRule", { matchedNetworkConditions: rules });
    const entry = { ...role, page, errors: [] }; pages.push(entry);
    page.on("pageerror", (error) => entry.errors.push(error.message));
    await page.goto(demo.base);
    await page.waitForFunction(() => window.relaySwarmDemo?.ready());
    // Loopback harness accommodation only (host candidates); the field page never asks.
    await page.evaluate(async () => { const media = await navigator.mediaDevices.getUserMedia({ audio: true }); for (const track of media.getTracks()) track.stop(); });
    await page.locator("#mode").selectOption(role.mode);
    if (role.upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption(UPLOAD_LIMIT); }
    await page.locator("#start").click();
    await page.locator("#quality").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.getElementById("quality").disabled);
    await page.locator("#quality").selectOption(String(role.level));
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null, null, { timeout: 30000 });
    log(`started ${role.name}`);
  }
  const contributors = [...Array.from({ length: HIGH_C }, (_, i) => ({ name: `contributor-high-${i + 1}`, quality: "high", level: 1 })),
    ...Array.from({ length: LOW_C }, (_, i) => ({ name: `contributor-low-${i + 1}`, quality: "low", level: 0 }))].map((r) => ({ ...r, upload: true, mode: "peer-first" }));
  const receivers = Array.from({ length: RECEIVERS }, (_, i) => ({ name: `receiver-${i + 1}`, quality: i % 2 ? "high" : "low", level: i % 2, upload: false, mode: "peer-first" }));
  const baselines = BASELINE ? [{ name: "origin-baseline-high", quality: "high", level: 1, upload: false, mode: "off" }] : [];
  for (const role of contributors) await start(role);
  await sleep(5000);
  for (const role of [...receivers, ...baselines]) await start(role);
  log(`warming up ${WARMUP_S} s`);
  await sleep(WARMUP_S * 1000);

  // --- measurement --------------------------------------------------------
  const collect = (entry) => entry.page.evaluate(() => {
    const r = window.relaySwarmDemo.report();
    return { durationMs: r.durationMs, mode: r.current?.mode ?? "off", deliveryDiagnostics: r.current?.metrics ?? null, peerBytes: r.totals.peerFirstBytes, uploaded: r.totals.uploaded,
      stalls: r.player.stalls, stallMs: r.player.stallMs, activeStallMs: r.player.activeStallMs, time: r.player.currentTime, bufferedSeconds: r.player.bufferedSeconds,
      liveLatencySeconds: r.player.liveLatencySeconds, fatal: r.player.fatalErrors, fragments: r.player.fragments.slice(-40) };
  });
  const sample = async (label) => {
    const rows = [];
    for (const entry of pages) {
      try { rows.push({ role: entry.name, quality: entry.quality, upload: entry.upload, ...(await collect(entry)), sampledAtMs: Date.now() - measureStart }); }
      catch (error) { rows.push({ role: entry.name, error: error.message }); }
    }
    await appendFile(samplesPath, JSON.stringify({ atUTC: new Date().toISOString(), label, rows }) + "\n");
    return rows;
  };
  let measureStart = Date.now();
  const first = await sample("measure-start");
  const startOf = Object.fromEntries(first.map((row) => [row.role, row]));
  const all = [first];
  let switched = SWITCH_S === 0;
  if (switched) await switchReceivers();
  async function switchReceivers() {
    for (const entry of pages.filter((p) => p.name.startsWith("receiver-"))) {
      entry.level = 1 - entry.level; entry.quality = entry.level ? "high" : "low";
      await entry.page.locator("#quality").selectOption(String(entry.level));
    }
    run.switchedAtMs = Date.now() - measureStart; log(`receivers switched at ${Math.round(run.switchedAtMs / 1000)} s`);
  }
  while (Date.now() - measureStart < DURATION_S * 1000) {
    await sleep(SAMPLE_MS);
    if (!switched && Date.now() - measureStart >= SWITCH_S * 1000) { switched = true; await switchReceivers(); }
    all.push(await sample("measure"));
  }
  run.environment.loadAverageEnd = loadavg().map((n) => +n.toFixed(2));

  // Segment bytes actually served, from what remains in the live window.
  run.segmentBytes = {};
  for (const level of LEVELS) {
    const names = (await readdir(join(mediaDir, level.name))).filter((n) => n.endsWith(".ts"));
    const sizes = []; for (const n of names) { try { sizes.push((await stat(join(mediaDir, level.name, n))).size); } catch {} }
    run.segmentBytes[level.name] = { n: sizes.length, p10: pct(sizes, 0.1), p50: pct(sizes, 0.5), p90: pct(sizes, 0.9) };
  }

  // --- summary ------------------------------------------------------------
  const summary = {};
  for (const entry of pages) {
    const s0 = startOf[entry.name] ?? {};
    const rows = all.flat().filter((row) => row.role === entry.name && !row.error);
    const last = rows.at(-1) ?? {};
    const frags = new Map();
    for (const row of rows) for (const f of row.fragments ?? []) if (f.atMs > (s0.durationMs ?? 0)) frags.set(`${f.level}:${f.sequence}:${f.atMs}`, f);
    const by = (source, level) => [...frags.values()].filter((f) => f.source === source && f.level === level);
    const before = new Set(); for (const x of s0.deliveryDiagnostics?.peerRequestDiagnostics?.records ?? []) before.add(`${x.atMs}:${x.id}:${x.level}:${x.outcome}`);
    const reqs = new Map();
    for (const row of rows) for (const x of row.deliveryDiagnostics?.peerRequestDiagnostics?.records ?? []) { const k = `${x.atMs}:${x.id}:${x.level}:${x.outcome}`; if (!before.has(k)) reqs.set(k, x); }
    const requests = {};
    for (const level of [0, 1]) {
      const rs = [...reqs.values()].filter((x) => x.level === level);
      const outcomes = {}; for (const x of rs) outcomes[x.outcome] = (outcomes[x.outcome] || 0) + 1;
      const timeouts = rs.filter((x) => x.outcome === "timeout");
      requests[LEVELS[level].name] = { n: rs.length, outcomes, timeoutsNoBytes: timeouts.filter((x) => !x.receivedBytes).length,
        remainingMsP50: pct(rs.map((x) => x.remainingMs), 0.5), timeoutMsP50: pct(rs.map((x) => x.timeoutMs), 0.5),
        payloadElapsedMsP50: pct(rs.filter((x) => x.outcome === "payload").map((x) => x.elapsedMs), 0.5),
        timeoutFractionP50: pct(timeouts.filter((x) => x.expectedBytes).map((x) => (x.receivedBytes || 0) / x.expectedBytes), 0.5) };
    }
    summary[entry.name] = { mode: entry.mode, upload: entry.upload, finalQuality: entry.quality,
      peer: { low: { n: by("peer", 0).length, bytes: by("peer", 0).reduce((a, f) => a + f.size, 0) }, high: { n: by("peer", 1).length, bytes: by("peer", 1).reduce((a, f) => a + f.size, 0) } },
      origin: { low: { n: by("origin", 0).length, loadingMsP50: pct(by("origin", 0).map((f) => f.loadingMs), 0.5) }, high: { n: by("origin", 1).length, loadingMsP50: pct(by("origin", 1).map((f) => f.loadingMs), 0.5) } },
      stalls: (last.stalls ?? 0) - (s0.stalls ?? 0), stallMs: (last.stallMs ?? 0) - (s0.stallMs ?? 0), bufferedSecondsP50: pct(rows.map((r) => r.bufferedSeconds), 0.5),
      uploadedBytes: (last.uploaded ?? 0) - (s0.uploaded ?? 0), requests, pageErrors: entry.errors.slice(0, 5) };
  }
  const recv = Object.entries(summary).filter(([name]) => name.startsWith("receiver-"));
  run.gate = { eachReceiverBothQualityPeer: recv.every(([, s]) => s.peer.low.bytes > 0 && s.peer.high.bytes > 0),
    note: "Bench analogue of each4BothQualityPeer: peer bytes in both qualities inside the measurement window." };
  run.summary = summary;
  run.ok = true;
} catch (error) {
  run.failures.push(error.stack || error.message);
} finally {
  await cleanup();
  run.endedAt = new Date().toISOString();
  run.cleanup = "ffmpeg, demo server, browser and temporary media removed by the bench.";
  await writeFile(join(RESULTS, "run.json"), JSON.stringify(run, null, 1) + "\n", { mode: 0o600 }).catch((error) => log(`write: ${error.message}`));
  log(`${run.ok ? "done" : "failed"}: ${RESULTS}/run.json`);
  if (run.gate) log(`gate ${run.gate.eachReceiverBothQualityPeer ? "PASS" : "FAIL"}`);
  process.exitCode = run.ok ? 0 : 1;
}
