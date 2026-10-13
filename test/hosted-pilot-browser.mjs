#!/usr/bin/env node
// Real Chrome contexts against an existing HTTPS demo. This starts no server
// or producer and never accesses operator endpoints or submits numeric reports.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";

const { values } = parseArgs({ options: {
  url: { type: "string", default: "https://relayswarm.forgesworn.dev" },
  "results-dir": { type: "string", default: "artifacts/hosted-pilot" },
  chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
} });
const target = new URL(values.url);
assert.ok(target.protocol === "https:" && !target.username && !target.password && !target.search && !target.hash, "Supply a public HTTPS demo URL without credentials or query parameters");
const log = (message) => console.error(`[hosted-pilot] ${message}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const started = Date.now(), deadline = started + 90000;
const receipt = { v: 1, kind: "relayswarm-hosted-pilot-browser-test", at: new Date().toISOString(), target: target.href, ok: false, failures: [],
  scope: { browser: "desktop Chrome", hostPlatform: process.platform, browserContexts: "four contexts on one host", origin: "real external HTTPS deployment", source: "operator-provided synthetic source", physicalDevices: false, NATDiversity: false, OBS: false, YouTube: false, numericReporting: false, maxJourneyMs: 90000, cleanupBudgetMs: 8000, sameEdge: true, delayedConsumerPlaylistMs: 0, restart: "observation only; operator must trigger any app restart separately" },
  checkpoints: [], sessionSamples: [], pageErrors: [], consoleErrors: [], requests: { insecure: [], failed: [], reportSubmissions: 0 }, websockets: [] };
const pages = [];
let browser, expired = false;
const lifecycle = new AbortController();
const timer = setTimeout(() => { expired = true; lifecycle.abort(); void browser?.close().catch(() => {}); }, 90000);
const remaining = (maximum) => Math.max(1, Math.min(maximum, deadline - Date.now()));
const read = (page) => page.evaluate(() => window.relaySwarmDemo.report());
async function sampleSession() {
  try {
    const response = await fetch(new URL("/session.json", target), { signal: AbortSignal.any([lifecycle.signal, AbortSignal.timeout(5000)]) });
    assert.equal(response.status, 200);
    const session = await response.json(), manifest = new URL(session.manifest, target);
    assert.equal(manifest.protocol, "https:", "HLS manifest must use HTTPS");
    assert.ok(session.relays?.length && session.relays.every((relay) => new URL(relay).protocol === "wss:"), "Signalling relay URLs must use WSS");
    const sample = { at: new Date().toISOString(), ok: true, manifest: manifest.href, relays: session.relays, publisher: session.streamEvent.pubkey, eventId: session.streamEvent.id, swarmId: session.swarmId };
    receipt.sessionSamples.push(sample); return sample;
  } catch (error) { receipt.sessionSamples.push({ at: new Date().toISOString(), ok: false, error: error.message }); throw error; }
}
async function checkpoint(name, measurements = {}) {
  receipt.checkpoints.push({ name, at: new Date().toISOString(), ...measurements, viewers: await Promise.all(pages.map(async ({ name, page, network }) => ({ name, network: { ...network }, receipt: await read(page) }))) });
  log(name);
}
async function viewer(name, upload, level, mode = "peer-first") {
  const context = await browser.newContext(), page = await context.newPage();
  page.setDefaultTimeout(9000); page.setDefaultNavigationTimeout(12000);
  await page.addInitScript(installMediaDiagnostics);
  const network = { mediaRequests: 0, mediaFailures: 0 };
  pages.push({ name, page, network });
  page.on("pageerror", (error) => { if (receipt.pageErrors.length < 50) receipt.pageErrors.push({ viewer: name, message: error.message.slice(0, 2000) }); });
  page.on("console", (message) => { if (["error", "warning"].includes(message.type()) && receipt.consoleErrors.length < 100) receipt.consoleErrors.push({ viewer: name, type: message.type(), message: message.text().slice(0, 2000) }); });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "ws:"].includes(url.protocol) && receipt.requests.insecure.length < 50) receipt.requests.insecure.push({ viewer: name, url: url.href });
    if (url.pathname === "/reports" && request.method() === "POST") receipt.requests.reportSubmissions++;
    if (url.pathname.startsWith("/media/") && !url.pathname.endsWith(".m3u8")) network.mediaRequests++;
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!response.ok() && receipt.requests.failed.length < 100) receipt.requests.failed.push({ viewer: name, url: url.href, status: response.status() });
    if (!response.ok() && url.pathname.startsWith("/media/") && !url.pathname.endsWith(".m3u8")) network.mediaFailures++;
  });
  page.on("websocket", (socket) => {
    const record = { viewer: name, url: socket.url(), framesSent: 0, framesReceived: 0, errors: [] };
    receipt.websockets.push(record);
    socket.on("framesent", () => record.framesSent++); socket.on("framereceived", () => record.framesReceived++);
    socket.on("socketerror", (error) => { if (record.errors.length < 10) record.errors.push(String(error).slice(0, 1000)); });
  });
  await page.goto(target.href, { waitUntil: "domcontentloaded", timeout: remaining(12000) });
  await page.waitForFunction(() => window.relaySwarmDemo?.ready() && !document.getElementById("start").disabled, null, { timeout: remaining(9000) });
  assert.equal(await page.evaluate(() => isSecureContext), true);
  assert.equal(await page.locator("#upload").isChecked(), false);
  assert.equal(await page.locator("#telemetry").isChecked(), false);
  // Fake permission only enables the browser fixture's WebRTC candidates.
  // The product itself does not request a microphone or camera.
  await page.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); for (const track of stream.getTracks()) track.stop(); });
  await page.locator("#mode").selectOption(mode);
  if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
  await page.locator("#start").click();
  await page.waitForFunction(() => !document.getElementById("quality").disabled, null, { timeout: remaining(9000) });
  await page.locator("#quality").selectOption(String(level));
  await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null, null, { timeout: remaining(12000) });
  log(`started ${name}`); return page;
}
async function peerAtLevel(page, level, timeoutMs) {
  try { await page.waitForFunction((level) => window.relaySwarmDemo.report().player.fragments.some((fragment) => fragment.source === "peer" && fragment.level === level), level, { timeout: remaining(timeoutMs) }); return true; }
  catch (error) { if (expired) throw error; return false; }
}
await mkdir(values["results-dir"], { recursive: true });
try {
  const original = await sampleSession();
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, timeout: remaining(15000), args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  receipt.scope.browserVersion = browser.version();
  const low = await viewer("contributor-low", true, 0);
  const high = await viewer("contributor-high", true, 1);
  const baseline = await viewer("origin-baseline", false, 0, "off");
  const consumer = await viewer("receive-only", false, 0);
  await pause(Math.min(5000, remaining(5000)));
  await checkpoint("same-live-edge-unmodified-playlists");
  const lowPeer = await peerAtLevel(consumer, 0, 24000);
  await checkpoint("low-rendition-delivery", { verifiedPeerObserved: lowPeer });
  for (const page of [baseline, consumer]) await page.locator("#quality").selectOption("1");
  const highPeer = await peerAtLevel(consumer, 1, 12000);
  await checkpoint("high-rendition-delivery", { verifiedPeerObserved: highPeer });
  const before = await read(consumer);
  const observationStarted = Date.now();
  await checkpoint("before-optional-operator-restart");
  log("12-second restart observation window open; no restart is initiated by this harness");
  const observeUntil = Math.min(deadline - 8000, Date.now() + 12000);
  while (Date.now() < observeUntil) {
    await pause(Math.min(3000, observeUntil - Date.now()));
    try { await sampleSession(); } catch { /* Record outages, then observe recovery within the fixed window. */ }
  }
  await checkpoint("after-restart-observation-window");
  const finalSession = await sampleSession(), after = await read(consumer);
  receipt.identityStableDuringObservation = ["publisher", "eventId", "swarmId", "manifest"].every((key) => original[key] === finalSession[key]);
  receipt.restartObserved = "not asserted: unchanged identity alone does not prove an app restart";
  assert.ok(receipt.identityStableDuringObservation, "Publisher identity and manifest changed during observation");
  assert.ok(after.player.currentTime > before.player.currentTime + 1 && after.player.fragmentsLoaded > before.player.fragmentsLoaded, "Consumer did not continue playing/loading during observation");
  assert.ok(after.player.currentTime - before.player.currentTime < (Date.now() - observationStarted) / 1000 + 20, "Playback timeline advanced beyond the bounded observation window");
  assert.ok(lowPeer && highPeer, "Both qualities need actual verified peer payloads within the bounded journey");
  assert.equal(after.totals.uploaded, 0); assert.equal(after.current.metrics.serving, false);
  const lowReport = await read(low), highReport = await read(high), baselineReport = await read(baseline);
  assert.ok(lowReport.totals.uploaded > 0 && highReport.totals.uploaded > 0);
  assert.ok(lowReport.player.fragments.some((fragment) => fragment.level === 0));
  assert.ok(highReport.player.fragments.some((fragment) => fragment.level === 1));
  assert.ok([0, 1].every((level) => baselineReport.player.fragments.some((fragment) => fragment.level === level)), "Origin baseline did not load both qualities");
  assert.equal(baselineReport.totals.uploaded, 0);
  for (const { page } of pages) {
    const report = await read(page);
    assert.equal(report.player.fatalErrors, 0); assert.equal(report.environment.secureContext, true);
    assert.equal(await page.evaluate(() => window.relaySwarmDemo.media.error), null);
    assert.deepEqual(await page.evaluate(() => window.relaySwarmMediaDiagnostics), []);
  }
  assert.ok(receipt.websockets.some((socket) => new URL(socket.url).protocol === "wss:" && socket.framesReceived > 0), "No real WSS signalling frames observed");
  assert.ok(receipt.websockets.every((socket) => new URL(socket.url).protocol === "wss:"));
  assert.equal(receipt.requests.insecure.length, 0); assert.equal(receipt.requests.reportSubmissions, 0); assert.equal(receipt.pageErrors.length, 0);
  receipt.ok = true;
} catch (error) { receipt.failures.push(error.stack || error.message); log(`failed: ${error.message}`); }
finally {
  clearTimeout(timer); lifecycle.abort(); receipt.expired = expired;
  receipt.viewers = await Promise.all(pages.map(async ({ name, page, network }) => ({ name, network, receipt: await Promise.race([read(page).catch(() => null), pause(1500).then(() => null)]), mediaDiagnostics: await Promise.race([page.evaluate(() => window.relaySwarmMediaDiagnostics).catch(() => null), pause(1500).then(() => null)]) })));
  if (browser) await Promise.race([browser.close().catch(() => {}), pause(8000)]);
  receipt.elapsedMs = Date.now() - started;
  const payload = `${JSON.stringify(receipt, null, 2)}\n`, file = join(values["results-dir"], `hosted-pilot-${receipt.at.replace(/\D/gu, "")}.json`);
  await writeFile(file, payload); await writeFile(join(values["results-dir"], "hosted-pilot.json"), payload);
  console.log(JSON.stringify({ ok: receipt.ok, receipt: file, failures: receipt.failures, elapsedMs: receipt.elapsedMs, checkpoints: receipt.checkpoints.map(({ name }) => name), viewers: receipt.viewers.map(({ name, network, receipt: report }) => ({ name, network, peerLoads: report?.totals.peerFirstLoads, peerBytes: report?.totals.peerFirstBytes, uploaded: report?.totals.uploaded, fatalErrors: report?.player.fatalErrors, stalls: report?.player.stalls })) }, null, 2));
}
process.exitCode = receipt.ok ? 0 : 1;
