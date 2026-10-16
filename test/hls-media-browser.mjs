#!/usr/bin/env node
// Separate browser journeys for HLS audio groups, authorised AES-128
// ciphertext and mixed-codec playlist identity. All media goes through the
// ordinary demo publisher/player; init objects and keys remain HTTP-only.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startDemoServer } from "../demo/server.mjs";
import { createFmp4Fixture } from "./support/fmp4-fixture.mjs";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";

const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/media-browser" } } });
const receipt = { v: 1, kind: "relayswarm-media-browser", at: new Date().toISOString(), ok: false, failures: [], scope: { browser: "Chrome", network: "loopback", physicalDevices: false, playlistsChangedForPeerDelivery: false }, journeys: [] };
await mkdir(values.resultsDir, { recursive: true });
let browser;
const watchdog = setTimeout(() => { receipt.expired = true; void browser?.close().catch(() => {}); }, 180000); watchdog.unref();
const report = (page) => page.evaluate(() => window.relaySwarmDemo.report());
const log = (message) => console.error(`[media-browser] ${message}`);
async function journey(name, options) {
  const result = { name, options, ok: false, failures: [], viewers: [] }; receipt.journeys.push(result);
  let fixture, demo;
  const viewers = [];
  try {
    fixture = await createFmp4Fixture({ seconds: 48, ...options });
    result.actualCodecs = fixture.codecs;
    demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [], allowEncryptedMedia: options.encrypted === true });
    async function viewer(name, mode, upload, height) {
      const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(25000);
      const record = { name, context, page, network: { keys: 0, init: 0, media: 0, failed: [] }, pageErrors: [] }; viewers.push(record);
      await page.addInitScript(installMediaDiagnostics);
      page.on("pageerror", (error) => record.pageErrors.push(error.message));
      page.on("request", (request) => { const path = new URL(request.url()).pathname; if (path.endsWith("key.key")) record.network.keys++; if (path.endsWith("init.mp4")) record.network.init++; if (/\.(?:m4s|ts)$/u.test(path)) record.network.media++; });
      page.on("response", (response) => { if (!response.ok() && record.network.failed.length < 20) record.network.failed.push({ url: response.url(), status: response.status() }); });
      await page.goto(demo.base); await page.waitForFunction(() => window.relaySwarmDemo?.ready());
      await page.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach((track) => track.stop()); });
      await page.locator("#mode").selectOption(mode); if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
      await page.locator("#start").click(); await page.waitForFunction(() => !document.getElementById("quality").disabled);
      const levels = await page.locator("#quality option").evaluateAll((elements) => elements.map((element) => ({ value: element.value, text: element.textContent })));
      const target = levels.find((level) => level.text.startsWith(`${height}p`)); assert.ok(target, `No ${height}p supported quality`);
      await page.locator("#quality").selectOption(target.value);
      await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
      record.levels = levels; log(`started ${name}`); return record;
    }
    await viewer("contributor-low", "peer-first", true, 240); await viewer("contributor-high", "peer-first", true, 360);
    const baseline = await viewer("origin-baseline", "off", false, 240), consumer = await viewer("receive-only", "peer-first", false, 240);
    await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.source === "peer" && frag.playlist?.endsWith("/low/index.m3u8") && frag.mediaType === "main"));
    if (options.alternateAudio) await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.source === "peer" && frag.playlist?.endsWith("/audio/index.m3u8") && frag.mediaType === "audio"));
    for (const { page } of [baseline, consumer]) {
      const high = await page.locator("#quality option").evaluateAll((elements) => elements.find((element) => element.textContent.startsWith("360p"))?.value);
      await page.locator("#quality").selectOption(high);
    }
    await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((frag) => frag.source === "peer" && frag.playlist?.endsWith("/high/index.m3u8") && frag.mediaType === "main"));
    const before = await report(consumer.page);
    await consumer.page.waitForFunction((time) => window.relaySwarmDemo.media.currentTime > time + 1, before.player.currentTime);
    const measured = await report(consumer.page); assert.equal(measured.totals.uploaded, 0); assert.equal(measured.current.metrics.serving, false);
    if (options.encrypted) assert.ok(consumer.network.keys > 0 && baseline.network.keys > 0, "AES keys must use normal HTTP requests");
    if (options.mixedCodecs) {
      result.filteredOrRenumberedLevels = consumer.levels;
      assert.ok(measured.player.fragments.filter((frag) => frag.source === "peer").every((frag) => ["/media/low/index.m3u8", "/media/high/index.m3u8"].includes(frag.playlist)), "mixed-codec filtered levels require the correct signed playlist context");
    }
    for (const { page, pageErrors, network } of viewers) {
      assert.equal((await report(page)).player.fatalErrors, 0); assert.equal(await page.evaluate(() => window.relaySwarmDemo.media.error), null);
      assert.deepEqual(await page.evaluate(() => window.relaySwarmMediaDiagnostics), []); assert.deepEqual(pageErrors, []); assert.deepEqual(network.failed, []);
    }
    result.ok = true;
  } catch (error) { result.failures.push(error.stack || error.message); log(`${name}: ${error.message}`); }
  finally {
    result.viewers = await Promise.all(viewers.map(async ({ name, page, network, levels }) => ({ name, network, levels, report: await report(page).catch(() => null), diagnostics: await page.evaluate(() => window.relaySwarmMediaDiagnostics).catch(() => null) })));
    for (const { context } of viewers) await context.close(); await demo?.close(); await fixture?.close();
  }
}
try {
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] }); receipt.scope.browserVersion = browser.version();
  await journey("alternate-audio", { alternateAudio: true }); await journey("AES-128-opt-in", { encrypted: true }); await journey("mixed-HEVC-AVC", { mixedCodecs: true });
  receipt.ok = receipt.journeys.every((result) => result.ok);
} catch (error) { receipt.failures.push(error.stack || error.message); }
finally { clearTimeout(watchdog); await browser?.close(); await writeFile(join(values.resultsDir, "media-browser.json"), `${JSON.stringify(receipt, null, 2)}\n`); console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, journeys: receipt.journeys.map(({ name, ok, failures }) => ({ name, ok, failures })), receipt: join(values.resultsDir, "media-browser.json") }, null, 2)); }
process.exitCode = receipt.ok ? 0 : 1;
