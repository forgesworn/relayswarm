#!/usr/bin/env node
// Concrete loopback Chrome journeys for the visible viewer controls. This is
// separate from the two-rendition/seek/discontinuity playback regression.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createMediaFixture } from "../demo/media-fixture.mjs";
import { startDemoServer } from "../demo/server.mjs";

const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/operator-browser" } } });
const log = (message) => console.error(`[operator-browser] ${message}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const token = "loopback-operator-browser-test-token-32-characters";
const reportFields = ["durationMs", "peerBytes", "uploadedBytes", "originMediaRequests", "originMediaBytes", "stalls", "stallMs", "fatalErrors"];
const pages = [], errors = [], submitted = [];
const receipt = { v: 1, kind: "relayswarm-operator-browser-test", at: new Date().toISOString(), ok: false, failures: [], scope: { network: "loopback", browser: "Chrome", physicalDevices: false, media: "synthetic two-rendition HLS byte ranges", allowance: "accepted media payload, including interrupted transfers; protocol traffic is additional" }, checkpoints: [] };
let fixture, demo, browser;
await mkdir(values.resultsDir, { recursive: true });
try {
  fixture = await createMediaFixture({ sectionSeconds: 60 });
  demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [], operatorToken: token, telemetry: true });
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  receipt.scope.browserVersion = browser.version();
  const read = (page) => page.evaluate(() => window.relaySwarmDemo.report());
  async function viewer(name, upload = false) {
    const context = await browser.newContext(); const page = await context.newPage();
    page.setDefaultTimeout(12000);
    pages.push({ name, page });
    page.on("pageerror", (error) => errors.push({ name, message: error.message }));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/reports") submitted.push({ viewer: name, method: request.method(), values: request.postDataJSON() });
    });
    await page.goto(demo.base);
    await page.waitForFunction(() => window.relaySwarmDemo?.ready() && !document.getElementById("start").disabled);
    // Fake permission is a loopback WebRTC harness accommodation. The product
    // page itself does not request camera or microphone access.
    await page.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); for (const track of stream.getTracks()) track.stop(); });
    assert.equal(await page.locator("#upload").isChecked(), false);
    assert.equal(await page.locator("#telemetry").isChecked(), false);
    await page.locator("#mode").selectOption("peer-first");
    await page.locator("#allowance").selectOption("10000000");
    if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
    await page.locator("#start").click();
    await page.waitForFunction(() => !document.getElementById("quality").disabled);
    await page.locator("#quality").selectOption("0");
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
    log(`started ${name}`); return page;
  }
  const seeder = await viewer("contributor", true);
  await pause(4500);
  const consumer = await viewer("receive-only");
  const checkpoint = async (name) => {
    receipt.checkpoints.push({ name, viewers: await Promise.all(pages.map(async ({ name, page }) => ({ name, receipt: await read(page), allowanceText: await page.locator("#allowance-used").innerText(), policyText: await page.locator("#policy-status").innerText() }))) });
    log(name);
  };
  await consumer.waitForFunction(() => window.relaySwarmDemo.report().totals.peerFirstLoads > 0, null, { timeout: 20000 });
  await seeder.waitForFunction(() => window.relaySwarmDemo.report().totals.uploaded > 0, null, { timeout: 20000 });
  const beforeApply = await read(seeder);
  await seeder.locator("#start").click();
  const applied = await read(seeder);
  assert.ok(applied.totals.uploaded >= beforeApply.totals.uploaded);
  assert.equal(applied.current.metrics.config.maxUploadBytesPerSession, 10000000 - (applied.uploadBudget.spent - applied.current.metrics.bytes.uploaded));
  await seeder.locator("#kill").click();
  const killed = await read(seeder);
  assert.ok(killed.loaderRestored); assert.equal(killed.current.mode, "off");
  await seeder.locator("#mode").selectOption("peer-first"); await seeder.locator("#start").click();
  const rejoined = await read(seeder);
  assert.ok(rejoined.totals.uploaded >= killed.totals.uploaded);
  assert.equal(rejoined.current.metrics.config.maxUploadBytesPerSession, 10000000 - (rejoined.uploadBudget.spent - rejoined.current.metrics.bytes.uploaded));
  await seeder.waitForFunction(() => document.getElementById("allowance-meter").value === Math.min(window.relaySwarmDemo.report().uploadBudget.spent, 10000000));
  assert.equal(await seeder.locator("#allowance-meter").getAttribute("max"), "10000000");
  assert.match(await seeder.locator("#allowance-used").innerText(), /of 10\.0 MB reserved in this browser/u);
  await checkpoint("visible-cumulative-allowance-after-apply-kill-rejoin");

  // Wait through a complete real reporting interval without changing timers.
  log("waiting through the default reporting interval");
  await consumer.waitForFunction(() => window.relaySwarmDemo.report().durationMs >= 16000, null, { timeout: 20000 });
  assert.equal(submitted.length, 0, "numeric reporting must remain silent until viewer consent");
  log("default reporting stayed silent; checking authenticated collector");
  assert.equal((await fetch(`${demo.base}/operator/status`)).status, 401);
  const status = async () => {
    const response = await fetch(`${demo.base}/operator/status`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await status()).reports.samples, 0);
  log("opting the receive-only viewer into numeric reports");
  await consumer.locator("#network").selectOption("home-broadband");
  await consumer.locator("#device").fill("private-loopback-label");
  const responsePromise = consumer.waitForResponse((response) => new URL(response.url()).pathname === "/reports" && response.request().method() === "POST", { timeout: 17000 });
  await consumer.locator("#telemetry").check();
  const reportResponse = await responsePromise;
  assert.equal(reportResponse.status(), 200);
  // The page does not consume this fetch response body. Check its HTTP outcome
  // and the authenticated collector without waiting for protocol body retrieval.
  assert.ok(submitted.length > 0);
  for (const report of submitted) {
    assert.equal(report.viewer, "receive-only"); assert.equal(report.method, "POST");
    assert.deepEqual(Object.keys(report.values).sort(), ["reportId", "sequence", "v", "values"]);
    assert.match(report.values.reportId, /^[a-f0-9]{32}$/u);
    assert.deepEqual(Object.keys(report.values.values).sort(), [...reportFields].sort());
    assert.ok(Object.values(report.values.values).every((value) => Number.isSafeInteger(value) && value >= 0));
    assert.ok(!JSON.stringify(report.values).includes("private-loopback-label"));
  }
  assert.ok((await status()).reports.samples > 0);
  await consumer.locator("#telemetry").uncheck();
  await checkpoint("explicit-numeric-report-consent");

  async function policy(mode) {
    const response = await fetch(`${demo.base}/operator/policy`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: demo.base }, body: JSON.stringify({ mode }) });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.mode, mode); return result.revision;
  }
  const offRevision = await policy("off");
  for (const page of [seeder, consumer]) await page.waitForFunction((revision) => { const report = window.relaySwarmDemo.report(); return report.deliveryPolicy.revision === revision && report.current.mode === "off" && report.loaderRestored; }, offRevision);
  const beforeOff = await read(consumer);
  await consumer.evaluate(() => { window.relaySwarmDemo.media.currentTime = 70; });
  await consumer.waitForFunction(() => window.relaySwarmDemo.report().player.currentTime > 71 && !window.relaySwarmDemo.media.paused);
  const afterOff = await read(consumer);
  assert.ok(afterOff.network.originMediaRequests > beforeOff.network.originMediaRequests, "remote off must load unbuffered media from origin");
  for (const page of [seeder, consumer]) {
    const report = await read(page); assert.equal(await page.locator("#upload").isChecked(), false);
    for (const value of [report.current.metrics.peers.connected, report.current.metrics.peers.dialling, report.current.metrics.relays.connected, report.current.metrics.bytes.held]) assert.equal(value, 0);
  }
  await checkpoint("authenticated-remote-off-restores-origin-playback");
  const onRevision = await policy("peer-first");
  for (const page of [seeder, consumer]) {
    await page.waitForFunction((revision) => { const report = window.relaySwarmDemo.report(); return report.deliveryPolicy.revision === revision && report.current.mode === "peer-first"; }, onRevision);
    assert.equal(await page.locator("#upload").isChecked(), false);
    assert.equal((await read(page)).current.metrics.serving, false);
  }
  await consumer.locator("#kill").click();
  const shadowRevision = await policy("shadow");
  await consumer.waitForFunction((revision) => window.relaySwarmDemo.report().deliveryPolicy.revision === revision, shadowRevision);
  assert.equal((await read(consumer)).current.mode, "off", "operator on cannot override the viewer's origin-only choice");
  assert.ok((await read(consumer)).loaderRestored);
  await checkpoint("remote-on-preserves-upload-opt-in-and-viewer-off");

  await seeder.route("**/delivery-policy.json", (route) => route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"test policy outage"}' }));
  await seeder.waitForFunction(() => { const report = window.relaySwarmDemo.report(); return report.deliveryPolicy.unavailable && report.current.mode === "off" && report.loaderRestored; });
  const beforeOutage = await read(seeder);
  await seeder.evaluate(() => { window.relaySwarmDemo.media.currentTime = 90; });
  await seeder.waitForFunction(() => window.relaySwarmDemo.report().player.currentTime > 91 && !window.relaySwarmDemo.media.paused);
  const duringOutage = await read(seeder);
  assert.ok(duringOutage.network.originMediaRequests > beforeOutage.network.originMediaRequests);
  assert.equal(await seeder.locator("#upload").isChecked(), false);
  assert.equal(await seeder.locator("#telemetry").isChecked(), false);
  await checkpoint("policy-outage-origin-fallback");
  await seeder.unroute("**/delivery-policy.json");
  await seeder.waitForFunction(() => { const report = window.relaySwarmDemo.report(); return !report.deliveryPolicy.unavailable && report.current.mode === "shadow"; });
  assert.equal((await read(seeder)).current.metrics.serving, false);
  assert.equal((await read(consumer)).current.mode, "off");
  assert.equal(await seeder.locator("#upload").isChecked(), false);
  for (const { page } of pages) assert.equal((await read(page)).player.fatalErrors, 0);
  assert.equal(errors.length, 0);
  await checkpoint("policy-recovery-retains-consent-boundaries");
  // A complete browser reload carries quota reservations, never consent.
  const spentBeforeReload = (await read(seeder)).uploadBudget.spent;
  await seeder.reload();
  await seeder.waitForFunction(() => window.relaySwarmDemo?.ready() && !document.getElementById("start").disabled);
  assert.equal(await seeder.locator("#upload").isChecked(), false);
  assert.ok((await read(seeder)).uploadBudget.spent >= spentBeforeReload);
  const secondTab = await seeder.context().newPage();
  await secondTab.goto(demo.base);
  await secondTab.waitForFunction(() => window.relaySwarmDemo?.ready());
  assert.equal((await read(secondTab)).uploadBudget.spent, (await read(seeder)).uploadBudget.spent);
  assert.equal(await secondTab.locator("#upload").isChecked(), false);
  await secondTab.close();
  await seeder.locator("#reset-allowance").click();
  await seeder.waitForFunction(() => window.relaySwarmDemo.report().uploadBudget.spent === 0);
  assert.equal((await read(seeder)).uploadBudget.spent, 0);
  assert.equal(await seeder.locator("#upload").isChecked(), false);
  await checkpoint("full-reload-cross-tab-budget-and-explicit-reset");
  receipt.reports = submitted;
  receipt.operatorStatus = await status();
  receipt.ok = true;
} catch (error) {
  log(`failed: ${error.message}`);
  receipt.failures.push(error.stack || error.message);
} finally {
  receipt.pageErrors = errors;
  receipt.viewers = await Promise.all(pages.map(async ({ name, page }) => ({ name, receipt: await page.evaluate(() => window.relaySwarmDemo?.report()).catch(() => null) })));
  await writeFile(join(values.resultsDir, "operator-browser.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  await browser?.close(); await demo?.close(); await fixture?.close();
}
console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, receipt: join(values.resultsDir, "operator-browser.json"), checkpoints: receipt.checkpoints.map(({ name }) => name), reports: receipt.reports?.length }, null, 2));
process.exitCode = receipt.ok ? 0 : 1;
