#!/usr/bin/env node
// Actual fMP4 init/media loading, verified peer payloads and hls.js's own
// automatic bandwidth adaptation under Chrome network shaping. No playlist
// delay or HAVE barrier is used to obtain peer delivery.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startObservedFmp4Demo } from "./support/fmp4-observed-demo.mjs";
import { createFmp4Fixture } from "./support/fmp4-fixture.mjs";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";

import { cap, bounded, journal } from "./support/account-browser-guard.mjs";
const guardInput = process.env.RELAYSWARM_FMP4_INPUT ? JSON.parse(await readFile(process.env.RELAYSWARM_FMP4_INPUT, "utf8")) : null;
if (guardInput) await new Promise((resolve) => {
  process.once("disconnect", () => process.exit(1));
  process.once("message", (message) => { if (message?.start === true) resolve(); else process.exit(1); });
  process.send({ ready: true });
});
const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/fmp4-browser" } } });
if (guardInput) Object.assign(values, guardInput.values);
const receipt = { v: 1, kind: "relayswarm-fmp4-abr-browser", at: new Date().toISOString(), ok: false, failures: [],
  scope: { browser: "Chrome", network: "loopback", media: "H.264/AAC fMP4 with EXT-X-MAP", playlistTimingChanged: false, physicalDevices: false,
    adaptivePlayback: "hls.js automatic levels, actual CDP network throttle; no manual quality selection on adaptive baseline" }, checkpoints: [] };
const pages = [];
let fixture, demo, browser;
const watchdog = setTimeout(() => { receipt.expired = true; void browser?.close().catch(() => {}); }, guardInput ? cap(guardInput.clock, "work", 150000) : 180000); watchdog.unref();
const report = (page) => page.evaluate(() => window.relaySwarmDemo.report());
const log = (message) => console.error(`[fmp4-browser] ${message}`);
await mkdir(values.resultsDir, { recursive: true });
try {
  fixture = await createFmp4Fixture(); demo = await startObservedFmp4Demo({ mediaDir: fixture.directory, iceServers: [] });
  receipt.scope.startupObservation = demo.observation;
  if (guardInput) {
    const resource = JSON.parse(await readFile(guardInput.resourcePath, "utf8"));
    assert.ok(resource.ok && Date.now() - resource.atMs >= 0 && Date.now() - resource.atMs <= 5000 && Date.now() - resource.pressureAtMs <= 15000);
    cap(guardInput.clock, "work", 1); journal(guardInput.chromeIntent, { nonce: guardInput.nonce });
  }
  browser = await chromium.launch({ executablePath: guardInput?.chromeWrapper ?? values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  receipt.scope.browserVersion = browser.version();
  async function viewer(name, mode, upload, level = null) {
    const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(20000);
    const record = { name, page, context, network: { initRequests: 0, mediaRequests: 0, failed: [] }, errors: [] }; pages.push(record);
    await page.addInitScript(installMediaDiagnostics);
    page.on("pageerror", (error) => record.errors.push(error.message));
    page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.endsWith("init.mp4")) record.network.initRequests++; if (path.endsWith(".m4s")) record.network.mediaRequests++; });
    page.on("response", (response) => { if (!response.ok() && record.network.failed.length < 20) record.network.failed.push({ url: response.url(), status: response.status() }); });
    await page.goto(demo.base); await page.waitForFunction(() => window.relaySwarmDemo?.ready());
    await page.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach((track) => track.stop()); });
    await page.locator("#mode").selectOption(mode); if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
    await page.locator("#start").click(); await page.waitForFunction(() => !document.getElementById("quality").disabled);
    if (level !== null) await page.locator("#quality").selectOption(String(level));
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
    log(`started ${name}`); return record;
  }
  await viewer("contributor-low", "peer-first", true, 0); await viewer("contributor-high", "peer-first", true, 1);
  const consumer = await viewer("receive-only", "peer-first", false, 0);
  await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.source === "peer" && frag.level === 0));
  await consumer.page.locator("#quality").selectOption("1");
  await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.source === "peer" && frag.level === 1));
  receipt.checkpoints.push({ name: "verified-fmp4-both-qualities", report: await report(consumer.page) });
  const adaptive = await viewer("automatic-origin-baseline", "off", false);
  assert.equal(await adaptive.page.locator("#quality").inputValue(), "-1");
  await adaptive.page.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.level === 1));
  const beforeSlow = await report(adaptive.page), slowAt = beforeSlow.durationMs;
  const cdp = await adaptive.context.newCDPSession(adaptive.page); await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 30, downloadThroughput: 60_000, uploadThroughput: 1_000_000 });
  log("automatic baseline bandwidth limited to 60,000 bytes/s");
  await adaptive.page.waitForFunction((at) => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.atMs > at && frag.level === 0), slowAt, { timeout: 30000 });
  const constrained = await report(adaptive.page); receipt.checkpoints.push({ name: "native-hls-automatic-downshift", bandwidthBytesPerSecond: 60000, report: constrained });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  log("automatic baseline bandwidth restored");
  await adaptive.page.waitForFunction((at) => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.atMs > at && frag.level === 1), constrained.durationMs, { timeout: 30000 });
  receipt.checkpoints.push({ name: "native-hls-automatic-upshift", report: await report(adaptive.page) });
  const measured = await report(consumer.page);
  assert.equal(measured.totals.uploaded, 0); assert.ok(measured.totals.peerFirstBytes > 0); assert.ok(consumer.network.initRequests >= 2, "both fMP4 initialisation objects must use HTTP");
  assert.ok(measured.player.fragments.filter((frag) => frag.source === "peer").every((frag) => frag.statsLoaded === frag.size && frag.loadingMs > 0), "verified peer delivery must preserve hls.js loader statistics");
  for (const { page, errors, network } of pages) { assert.equal((await report(page)).player.fatalErrors, 0); assert.equal(await page.evaluate(() => window.relaySwarmDemo.media.error), null); assert.deepEqual(errors, []); assert.deepEqual(network.failed, []); assert.deepEqual(await page.evaluate(() => window.relaySwarmMediaDiagnostics), []); }
  await consumer.page.locator("#kill").click();
  assert.ok((await report(consumer.page)).loaderRestored); receipt.ok = true;
} catch (error) { receipt.failures.push(error.stack || error.message); log(error.message); }
finally {
  clearTimeout(watchdog);
  receipt.viewers = await Promise.all(pages.map(async ({ name, page, network, errors }) => ({ name, network, errors, report: await report(page).catch(() => null), startup: await page.evaluate(() => window.relaySwarmFmp4Startup?.()).catch(() => null), diagnostics: await page.evaluate(() => window.relaySwarmMediaDiagnostics).catch(() => null) })));
  receipt.cleanup = {};
  for (const [name, resource] of [["browserClosed", browser], ["demoClosed", demo], ["fixtureRemoved", fixture]]) {
    receipt.cleanup[name] = resource ? false : null;
    if (!resource) continue;
    try { if (guardInput) await bounded(() => resource.close(), guardInput.clock, "grace", 12000); else await resource.close(); receipt.cleanup[name] = true; } catch { receipt.cleanup[name] = false; }
  }
  receipt.ok &&= Object.values(receipt.cleanup).every((value) => value === true);
  if (guardInput) await writeFile(guardInput.workerReceipt, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  await writeFile(join(values.resultsDir, "fmp4-browser.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, receipt: join(values.resultsDir, "fmp4-browser.json"), checkpoints: receipt.checkpoints.map(({ name }) => name) }, null, 2));
}
process.exitCode = receipt.ok ? 0 : 1;
if (guardInput) process.exit(process.exitCode);
