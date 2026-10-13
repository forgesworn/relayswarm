#!/usr/bin/env node
// A real rolling LL-HLS fMP4 journey: independently decodable one-second
// parts, whole media segments, warm delta snapshots and authenticated peers.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startDemoServer } from "../demo/server.mjs";
import { createLlHlsFixture } from "./support/ll-hls-fixture.mjs";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";
const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/ll-browser" } } });
const receipt = { v: 1, kind: "relayswarm-ll-hls-browser", at: new Date().toISOString(), ok: false, failures: [], scope: { browser: "Chrome", network: "loopback", physicalDevices: false, media: "real H.264/AAC fMP4 one-second parts and two-second concatenated media segments", peerParts: "explicit host opt-in", blockingReload: false, delta: "transition after publisher and viewers obtain full snapshots", playlistTimingChangedForPeerDelivery: false }, checkpoints: [] };
await mkdir(values.resultsDir, { recursive: true });
let fixture, demo, browser;
const pages = [];
const watchdog = setTimeout(() => { receipt.expired = true; void browser?.close().catch(() => {}); }, 180000); watchdog.unref();
const read = (page) => page.evaluate(() => window.relaySwarmDemo.report());
const log = (message) => console.error(`[ll-browser] ${message}`);
try {
  fixture = await createLlHlsFixture(); demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [], mediaCapabilities: { parts: true } });
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }); receipt.scope.browserVersion = browser.version();
  async function viewer(name, mode, upload) {
    const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(20000);
    const record = { name, page, context, network: { partMedia: 0, fullMedia: 0, init: 0, preload: 0, deltaResponses: 0, failures: [] }, pageErrors: [] }; pages.push(record);
    await page.addInitScript(installMediaDiagnostics);
    page.on("pageerror", (error) => record.pageErrors.push(error.message));
    page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.includes("/segment-")) record.network.partMedia++; if (path.includes("/full-")) record.network.fullMedia++; if (path.endsWith("init.mp4")) record.network.init++; if (path.includes("/future-")) record.network.preload++; });
    page.on("response", async (response) => { if (!response.ok() && record.network.failures.length < 20) record.network.failures.push({ url: response.url(), status: response.status() }); if (response.url().includes("index.m3u8") && (await response.text().catch(() => "")).includes("#EXT-X-SKIP:")) record.network.deltaResponses++; });
    await page.goto(demo.base); await page.waitForFunction(() => window.relaySwarmDemo?.ready());
    await page.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach((track) => track.stop()); });
    await page.locator("#mode").selectOption(mode); if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
    await page.locator("#start").click(); await page.waitForFunction(() => !document.getElementById("quality").disabled); await page.locator("#quality").selectOption("0");
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null); log(`started ${name}`); return record;
  }
  await viewer("contributor", "peer-first", true); const baseline = await viewer("origin-baseline", "off", false), consumer = await viewer("receive-only", "peer-first", false);
  await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.source === "peer" && frag.part !== null), null, { timeout: 30000 });
  receipt.checkpoints.push({ name: "real-one-second-verified-peer-part", report: await read(consumer.page) });
  const before = await read(consumer.page); await fixture.enableDelta(); log("warm delta playlists enabled");
  await consumer.page.waitForFunction((before) => { const report = window.relaySwarmDemo.report(); return report.player.currentTime > before.player.currentTime + 3 && report.player.fragments.some((frag) => frag.atMs > before.durationMs && frag.source === "peer" && frag.part !== null); }, before, { timeout: 30000 });
  receipt.checkpoints.push({ name: "peer-part-playback-after-warm-delta", report: await read(consumer.page) });
  assert.ok(consumer.network.deltaResponses > 0 && baseline.network.deltaResponses > 0, "both players must consume actual delta snapshots");
  const measured = await read(consumer.page); assert.equal(measured.totals.uploaded, 0); assert.equal(measured.current.metrics.serving, false);
  for (const { page, network, pageErrors } of pages) {
    const measured = await read(page);
    assert.equal(measured.player.fatalErrors, 0);
    assert.equal(measured.player.isLive, true);
    assert.equal(measured.player.targetLatencySeconds, 3, "respect the server PART-HOLD-BACK instead of forcing a whole-segment delay");
    assert.ok(measured.player.liveLatencySeconds >= 0 && measured.player.liveLatencySeconds < 6, "playback remains within three part durations of the declared target");
    assert.equal(await page.evaluate(() => window.relaySwarmDemo.media.error), null); assert.deepEqual(await page.evaluate(() => window.relaySwarmMediaDiagnostics), []); assert.deepEqual(pageErrors, []); assert.deepEqual(network.failures, []); assert.equal(network.preload, 0, "future preload hints must never become peer media or authorised HTTP media");
  }
  receipt.ok = true;
} catch (error) { receipt.failures.push(error.stack || error.message); log(error.message); }
finally {
  clearTimeout(watchdog);
  receipt.publications = fixture?.publications;
  receipt.viewers = await Promise.all(pages.map(async ({ name, page, network, pageErrors }) => ({ name, network, pageErrors, report: await read(page).catch(() => null), diagnostics: await page.evaluate(() => window.relaySwarmMediaDiagnostics).catch(() => null) })));
  await browser?.close(); await demo?.close(); await fixture?.close(); await writeFile(join(values.resultsDir, "ll-browser.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, receipt: join(values.resultsDir, "ll-browser.json"), checkpoints: receipt.checkpoints.map(({ name }) => name) }, null, 2));
}
process.exitCode = receipt.ok ? 0 : 1;
