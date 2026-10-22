#!/usr/bin/env node
// Exercises the field-test player itself: real hls.js, two renditions,
// shared-file ranges, reset timestamps, quality changes, seeks and relay loss.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createMediaFixture } from "../demo/media-fixture.mjs";
import { startDemoServer } from "../demo/server.mjs";

const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/playback" } } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => console.error(`[hls-playback] ${message}`);
await mkdir(values.resultsDir, { recursive: true });
const fixture = await createMediaFixture();
let demo, browser;
const pages = [], pageErrors = [], receipt = { v: 1, kind: "relayswarm-playback-test", at: new Date().toISOString(), ok: false, failures: [], shape: { network: "loopback", browser: "Chrome", renditions: 2, sectionSeconds: 24, sections: 2, segments: "2s MPEG-TS byte ranges", independentTimestampReset: true }, checkpoints: [] };
try {
  demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [] });
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  receipt.shape.browserVersion = browser.version();
  async function viewer(name, { mode = "peer-first", upload = false, level = 0 } = {}) {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const network = { mediaRequests: 0, rangedRequests: 0, fullRequests: 0, rangeFailures: 0 };
    const result = { name, page, network }; pages.push(result);
    page.on("pageerror", (error) => pageErrors.push({ viewer: name, message: error.message }));
    page.on("request", (request) => {
      if (!request.url().includes("/media/") || request.url().includes(".m3u8")) return;
      network.mediaRequests++; if (request.headers().range) network.rangedRequests++; else network.fullRequests++;
    });
    page.on("response", (response) => { if (response.request().headers().range && response.status() !== 206) network.rangeFailures++; });
    await page.goto(demo.base);
    await page.waitForFunction(() => window.relaySwarmDemo?.ready());
    // This permission is a loopback harness accommodation only. The actual
    // field-test page never asks for a microphone or camera.
    await page.evaluate(async () => { const media = await navigator.mediaDevices.getUserMedia({ audio: true }); for (const track of media.getTracks()) track.stop(); });
    assert.equal(await page.locator("#upload").isChecked(), false);
    await page.locator("#mode").selectOption(mode);
    if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
    await page.locator("#start").click();
    await page.locator("#quality").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.getElementById("quality").disabled);
    await page.locator("#quality").selectOption(String(level));
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
    log(`started ${name}`); return result;
  }
  await viewer("low-seeder", { upload: true, level: 0 });
  await viewer("high-seeder", { upload: true, level: 1 });
  await sleep(4500);
  const baseline = await viewer("baseline", { mode: "off" });
  const consumer = await viewer("consumer");
  await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().current.metrics.peers.connected > 0);
  const checkpoint = async (name) => {
    receipt.checkpoints.push({ name, viewers: await Promise.all([baseline, consumer].map(async ({ name: viewerName, page }) => {
      const report = await page.evaluate(() => window.relaySwarmDemo.report());
      return { name: viewerName, currentTime: report.player.currentTime, fragmentsLoaded: report.player.fragmentsLoaded,
        stalls: report.player.stalls, fatalErrors: report.player.fatalErrors, seeks: report.player.seeks, seekRecoveryMs: report.player.seekRecoveryMs,
        totals: report.totals, mode: report.current?.mode, peers: report.current?.metrics.peers.connected, relays: report.current?.metrics.relays.connected };
    })) });
  };
  const verifiedPeerLevel = async (level, afterMs = -1) => {
    const started = Date.now();
    await consumer.page.waitForFunction(({ level, afterMs }) => window.relaySwarmDemo.report().player.fragments.some((frag) =>
      frag.level === level && frag.atMs > afterMs && frag.source === "peer" && frag.statsLoaded === frag.size && frag.loadingMs > 0),
    { level, afterMs }, { timeout: 20000 });
    const report = await consumer.page.evaluate(() => window.relaySwarmDemo.report());
    const fragment = report.player.fragments.find((frag) => frag.level === level && frag.atMs > afterMs && frag.source === "peer");
    (receipt.verifiedQualityCheckpoints ??= []).push({ level, afterMs, waitedMs: Date.now() - started, fragment });
  };
  await sleep(5000); await verifiedPeerLevel(0); await checkpoint("initial-low-rendition");
  const qualityChangeAtMs = await consumer.page.evaluate(() => window.relaySwarmDemo.report().durationMs);
  for (const viewer of [baseline, consumer]) await viewer.page.locator("#quality").selectOption("1");
  // The seeder's bounded cache can already have evicted the early high-quality
  // segments. Prove this quality's peer delivery before intentionally seeking;
  // a fixed four-second delay previously interrupted the first opportunity.
  // This observation bound changes no media, origin or peer request deadline.
  await verifiedPeerLevel(1, qualityChangeAtMs); await checkpoint("quality-change-high");
  for (const viewer of [baseline, consumer]) await viewer.page.evaluate(() => { window.relaySwarmDemo.media.currentTime = 30; });
  await sleep(4500); await checkpoint("seek-past-timestamp-reset");
  log("relay unavailable for three seconds"); demo.relay.pause(); await sleep(3000); demo.relay.resume();
  await consumer.page.waitForFunction(() => window.relaySwarmDemo.report().current.metrics.relays.connected > 0, null, { timeout: 20000 });
  for (const viewer of [baseline, consumer]) await viewer.page.evaluate(() => { window.relaySwarmDemo.media.currentTime = 16; });
  await sleep(4500); await checkpoint("backward-seek-and-relay-recovery");
  // Returning to automatic selection exercises the ABR controller too. This
  // is a playback/control regression, not proof of an optimal ABR scheduler.
  for (const viewer of [baseline, consumer]) await viewer.page.locator("#quality").selectOption("-1");
  await sleep(2500);
  const beforeKill = await consumer.page.evaluate(() => window.relaySwarmDemo.report());
  assert.equal(beforeKill.current.metrics.bytes.uploaded, 0, "receive-only consumer uploaded media");
  assert.equal(beforeKill.current.metrics.serving, false);
  assert.ok(beforeKill.totals.peerFirstLoads > 0, "consumer received no verified peer-first fragments");
  assert.ok(beforeKill.player.fragments.some((frag) => frag.level === 0) && beforeKill.player.fragments.some((frag) => frag.level === 1), "both renditions were not loaded");
  assert.ok(beforeKill.player.fragments.some((frag) => frag.discontinuity === 1), "timestamp-reset section was never loaded");
  assert.ok(beforeKill.player.fragments.every((frag) => frag.rangeEnd > frag.rangeStart), "a fragment did not use a byte range");
  const peerFragments = beforeKill.player.fragments.filter((frag) => frag.source === "peer");
  assert.ok(peerFragments.some((frag) => frag.level === 0) && peerFragments.some((frag) => frag.level === 1), "peer delivery did not cover both renditions");
  assert.ok(peerFragments.some((frag) => frag.discontinuity === 1), "no peer fragment crossed the timestamp reset");
  assert.ok(peerFragments.every((frag) => frag.statsLoaded === frag.size && frag.loadingMs > 0), "hls.js retained incomplete statistics for peer delivery");
  assert.ok(consumer.network.mediaRequests < beforeKill.player.fragmentsLoaded, "peer delivery did not displace HTTP requests");
  await consumer.page.locator("#kill").click();
  await sleep(3500);
  const afterKill = await consumer.page.evaluate(() => window.relaySwarmDemo.report());
  const stopped = afterKill.sessions.at(-1).metrics;
  assert.ok(afterKill.player.currentTime > beforeKill.player.currentTime + 1, "kill switch interrupted playback");
  assert.ok(afterKill.loaderRestored, "kill switch did not restore the original loader");
  for (const value of [stopped.peers.connected, stopped.peers.dialling, stopped.relays.connected, stopped.bytes.held]) assert.equal(value, 0, "kill switch left resources alive");
  const downloadPromise = consumer.page.waitForEvent("download"); await consumer.page.locator("#download").click();
  const download = await downloadPromise; await download.saveAs(join(values.resultsDir, "field-receipt.json"));
  const downloaded = JSON.parse(await readFile(join(values.resultsDir, "field-receipt.json"), "utf8"));
  assert.equal(downloaded.kind, "relayswarm-field-receipt");
  assert.equal(downloaded.environment.automated, true);
  assert.ok(downloaded.totals.peerFirstBytes > 0 && downloaded.loaderRestored);
  receipt.viewers = await Promise.all(pages.map(async ({ name, page, network }) => ({ name, network, receipt: await page.evaluate(() => window.relaySwarmDemo.report()) })));
  const reference = receipt.viewers.find((viewer) => viewer.name === "baseline").receipt.player;
  const measured = receipt.viewers.find((viewer) => viewer.name === "consumer").receipt.player;
  assert.equal(measured.fatalErrors, 0); assert.equal(reference.fatalErrors, 0);
  const consumerReport = receipt.viewers.find((viewer) => viewer.name === "consumer").receipt;
  const peerFirstSessions = [...consumerReport.sessions, ...(consumerReport.current ? [consumerReport.current] : [])].filter((session) => session.metrics.mode === "peer-first");
  assert.ok(peerFirstSessions.length > 0, "the consumer never ran peer-first");
  for (const session of peerFirstSessions) assert.deepEqual(session.metrics.core, { state: "ready", verifier: "wasm", fallbacks: 0 }, "the consumer did not verify with the Rust core");
  assert.ok(measured.stalls <= reference.stalls, `consumer stalled ${measured.stalls} times vs baseline ${reference.stalls}`);
  assert.ok(measured.startupMs <= reference.startupMs + 2000, "peer mode added more than two seconds to startup");
  assert.ok(measured.seeks >= 2 && measured.seekRecoveryMs.length >= 2, "seek recovery was not recorded");
  assert.ok(measured.seekRecoveryMs.slice(-2).every((time, index) => time <= reference.seekRecoveryMs.slice(-2)[index] + 2000), "peer mode added more than two seconds to a seek recovery");
  for (const viewer of receipt.viewers) { assert.equal(viewer.network.fullRequests, 0, "entire shared media file was downloaded"); assert.equal(viewer.network.rangeFailures, 0, "HTTP range did not return 206"); }
  assert.equal(pageErrors.length, 0, "uncaught page errors");
  receipt.ok = true;
} catch (error) { receipt.failures.push(error.stack || error.message); if (pages.length) receipt.viewers = await Promise.all(pages.map(async ({ name, page, network }) => ({ name, network, receipt: await page.evaluate(() => window.relaySwarmDemo.report()).catch(() => null) }))); }
finally {
  receipt.pageErrors = pageErrors;
  await mkdir(values.resultsDir, { recursive: true });
  await writeFile(join(values.resultsDir, "hls-playback.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await browser?.close(); await demo?.close(); await fixture.close();
}
console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, receipt: join(values.resultsDir, "hls-playback.json"), viewers: receipt.viewers?.map(({ name, network, receipt: result }) => ({ name, network, savedBytes: result?.totals.peerFirstBytes, peerFirstLoads: result?.totals.peerFirstLoads, stalls: result?.player.stalls, seekRecoveryMs: result?.player.seekRecoveryMs })) }, null, 2));
process.exitCode = receipt.ok ? 0 : 1;
