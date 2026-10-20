#!/usr/bin/env node
// Controlled origin-only comparison against one unchanged hosted HLS source.
// Candidate JavaScript is routed only into the test's browser contexts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";

const { values } = parseArgs({ options: { url: { type: "string", default: "https://relayswarm.forgesworn.dev" }, resultsDir: { type: "string", default: "artifacts/hosted-mse-diagnosis" }, seconds: { type: "string", default: "90" }, chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } } });
const target = new URL(values.url), seconds = Number(values.seconds);
assert.ok(target.protocol === "https:" && target.pathname === "/" && !target.search && !target.hash && !target.username && !target.password);
assert.ok(Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= 180);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(operation, ms = 3000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Browser diagnostic deadline exceeded")), ms); })]); }
  finally { clearTimeout(timer); }
}
const receipt = { v: 1, kind: "hosted-mse-controlled-comparison", at: new Date().toISOString(), target: target.href, ok: false, failures: [],
  scope: { delivery: "origin-only for both arms", source: "same unchanged external HTTPS HLS origin", physicalDevices: false, peerDelivery: false, serverRestart: false, playlistManipulation: false, clientNetworkOutageMs: 3000, snapshotIntervalMs: 250, maxSnapshotsPerViewer: 1000, observationSeconds: seconds,
    candidateOverride: "candidate client.js only; hidden missing reset-allowance button added to old HTML for the new client handler" }, actions: [], viewers: [] };
await mkdir(values.resultsDir, { recursive: true });
const read = (page) => bounded(page.evaluate(() => window.relaySwarmDemo.report()));
let browser;
const contexts = [];
const deadline = setTimeout(() => { receipt.expired = true; void browser?.close().catch(() => {}); }, (seconds + 90) * 1000); deadline.unref();
try {
  const [oldScript, oldHtml, initialSession, candidate] = await Promise.all([
    fetch(new URL("/client.js", target), { signal: AbortSignal.timeout(10000) }).then((r) => { assert.ok(r.ok); return r.text(); }),
    fetch(target, { signal: AbortSignal.timeout(10000) }).then((r) => { assert.ok(r.ok); return r.text(); }),
    fetch(new URL("/session.json", target), { signal: AbortSignal.timeout(10000) }).then((r) => r.json()),
    build({ entryPoints: ["demo/client.mjs"], bundle: true, format: "esm", platform: "browser", write: false, minify: true, logLevel: "silent" }),
  ]);
  const candidateScript = candidate.outputFiles[0].text;
  receipt.scripts = { hosted: { sha256: hash(oldScript), bytes: Buffer.byteLength(oldScript) }, candidate: { sha256: hash(candidateScript), bytes: Buffer.byteLength(candidateScript) } };
  receipt.authorisation = { eventId: initialSession.streamEvent.id, publisher: initialSession.streamEvent.pubkey, swarmId: initialSession.swarmId, manifest: initialSession.manifest };
  receipt.initialManifest = await fetch(new URL(initialSession.manifest, target), { signal: AbortSignal.timeout(10000) }).then((r) => r.text());
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
  receipt.browserVersion = browser.version();
  async function viewer(arm, quality) {
    const record = { arm, initialQuality: quality, startupFailure: null, errors: [], failedRequests: [], scriptSha256: receipt.scripts[arm].sha256 };
    const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(15000);
    const cdp = await context.newCDPSession(page); await cdp.send("Performance.enable");
    contexts.push({ context, page, record, cdp }); receipt.viewers.push(record);
    await page.addInitScript(installMediaDiagnostics);
    await page.addInitScript(() => {
      window.relaySwarmSoakSamples = [];
      let previous = performance.now();
      setInterval(() => {
        const video = document.querySelector("video"), at = performance.now();
        if (!video || window.relaySwarmSoakSamples.length >= 1000) return;
        const buffered = []; for (let i = 0; i < video.buffered.length; i++) buffered.push([video.buffered.start(i), video.buffered.end(i)]);
        window.relaySwarmSoakSamples.push({ at, intervalMs: at - previous, time: video.currentTime, readyState: video.readyState, networkState: video.networkState, paused: video.paused, buffered, nativeError: video.error && { code: video.error.code, message: video.error.message } }); previous = at;
      }, 250);
    });
    // Freeze both arms' script bytes so a concurrent deployment cannot mix
    // versions inside this comparison. Media/session/policy remain real HTTPS.
    await context.route(new URL("/client.js", target).href, (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: arm === "candidate" ? candidateScript : oldScript }));
    if (arm === "candidate" && !oldHtml.includes('id="reset-allowance"')) await context.route(target.href, (route) => route.fulfill({ status: 200, contentType: "text/html", body: oldHtml.replace("</body>", '<button hidden id="reset-allowance"></button></body>') }));
    page.on("pageerror", (error) => { if (record.errors.length < 30) record.errors.push(error.message.slice(0, 1000)); });
    page.on("response", (response) => { if (!response.ok() && record.failedRequests.length < 50) record.failedRequests.push({ path: new URL(response.url()).pathname, status: response.status() }); });
    try {
      await page.goto(target.href); await page.waitForFunction(() => window.relaySwarmDemo?.ready());
      await page.locator("#mode").selectOption("off"); await page.locator("#start").click();
      await page.waitForFunction(() => !document.getElementById("quality").disabled);
      record.qualities = await page.locator("#quality option").evaluateAll((options) => options.map((option) => ({ value: option.value, text: option.textContent })));
      await page.locator("#quality").selectOption(String(quality));
      await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
      record.start = await read(page);
    } catch (error) { record.startupFailure = error.message; }
    console.error(`[hosted-mse] ${arm} quality ${quality}: ${record.startupFailure || "playing"}`);
  }
  await Promise.all([viewer("hosted", 0), viewer("candidate", 0), viewer("hosted", 1), viewer("candidate", 1), viewer("hosted", -1), viewer("candidate", -1)]);
  const observationAt = performance.now();
  const action = async (name, fn) => {
    const value = { name, elapsedMs: Math.round(performance.now() - observationAt), outcomes: [] }; receipt.actions.push(value);
    for (const item of contexts) { try { value.outcomes.push({ arm: item.record.arm, initialQuality: item.record.initialQuality, result: await fn(item) }); } catch (error) { value.outcomes.push({ arm: item.record.arm, initialQuality: item.record.initialQuality, error: error.message }); } }
    console.error(`[hosted-mse] ${name}`);
  };
  await pause(15000);
  await action("opposite-manual-quality", async ({ page, record }) => { const level = record.initialQuality === 1 ? "0" : "1"; await page.locator("#quality").selectOption(level); return { level }; });
  await pause(15000);
  await action("seek-within-live-buffer", ({ page }) => page.evaluate(() => { const video = window.relaySwarmDemo.media; const before = video.currentTime; if (video.seekable.length) video.currentTime = Math.max(video.seekable.start(0), before - 2); return { before, requested: video.currentTime }; }));
  await pause(15000);
  await action("return-to-automatic", async ({ page }) => { await page.locator("#quality").selectOption("-1"); return { level: "-1" }; });
  await pause(5000);
  await action("client-network-offline", async ({ cdp, page, record }) => {
    record.beforeReconnect = await read(page);
    await bounded(cdp.send("Network.enable"));
    await bounded(cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }));
    return { offline: true };
  });
  await pause(3000);
  await action("client-network-restored", async ({ cdp }) => {
    await bounded(cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }));
    return { offline: false };
  });
  await pause(Math.max(0, seconds * 1000 - (performance.now() - observationAt)));
  receipt.observationMs = Math.round(performance.now() - observationAt);
  const finalSession = await fetch(new URL("/session.json", target), { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
  receipt.authorisationStable = finalSession.streamEvent.id === receipt.authorisation.eventId;
  receipt.finalHostedScriptSha256 = await fetch(new URL("/client.js", target), { signal: AbortSignal.timeout(10000) }).then((r) => r.text()).then(hash);
  receipt.hostedScriptStable = receipt.finalHostedScriptSha256 === receipt.scripts.hosted.sha256;
} catch (error) { receipt.failures.push(error.stack || error.message); }
finally {
  clearTimeout(deadline);
  for (const { page, record } of contexts) {
    record.final = await read(page).catch(() => null);
    const details = await bounded(page.evaluate(() => ({ diagnostics: window.relaySwarmMediaDiagnostics, transitions: window.relaySwarmMediaTransitions, samples: window.relaySwarmSoakSamples }))).catch(() => ({}));
    Object.assign(record, details);
    record.ok = !record.startupFailure && record.final?.player.fatalErrors === 0 && !record.errors.length && details.diagnostics?.length === 0
      && !details.samples?.some((sample) => sample.nativeError) && record.final.player.currentTime > (record.start?.player.currentTime ?? 0) + 20
      && record.beforeReconnect && record.final.player.currentTime > record.beforeReconnect.player.currentTime + 3;
  }
  receipt.ok = !receipt.failures.length && receipt.authorisationStable === true && receipt.hostedScriptStable === true && receipt.viewers.length === 6 && receipt.viewers.every((viewer) => viewer.ok)
    && receipt.actions.length === 5 && receipt.actions.every((action) => action.outcomes.length === 6 && action.outcomes.every((outcome) => !outcome.error));
  for (const { cdp, record } of contexts) {
    record.browserPerformance = await bounded(cdp.send("Performance.getMetrics")).then(({ metrics }) => Object.fromEntries(metrics.filter(({ name }) => ["TaskDuration", "ScriptDuration", "LayoutDuration", "JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "Documents"].includes(name)).map(({ name, value }) => [name, value]))).catch((error) => ({ error: error.message }));
    const intervals = (record.samples || []).map((sample) => sample.intervalMs).sort((a, b) => a - b);
    record.sampler = { samples: intervals.length, intervalP90Ms: intervals[Math.floor(intervals.length * 0.9)] ?? null, maxIntervalMs: intervals.at(-1) ?? null };
  }
  await bounded(browser?.close(), 8000).catch((error) => { receipt.failures.push(error.message); receipt.ok = false; });
  await writeFile(join(values.resultsDir, "hosted-mse.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, receipt: join(values.resultsDir, "hosted-mse.json"), scripts: receipt.scripts, viewers: receipt.viewers.map(({ arm, initialQuality, ok, startupFailure, final, diagnostics }) => ({ arm, initialQuality, ok, startupFailure, fatal: final?.player.fatalErrors, stalls: final?.player.stalls, stallMs: final?.player.stallMs, diagnostics: diagnostics?.length })) }, null, 2));
}
process.exitCode = receipt.ok ? 0 : 1;
