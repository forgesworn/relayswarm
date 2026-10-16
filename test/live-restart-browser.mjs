#!/usr/bin/env node
// Actual rolling MPEG-TS playlists, HTTP outage and a new discontinuity whose
// sequence window no longer overlaps the fragments buffered before the outage.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { build } from "esbuild";
import { createMediaFixture } from "../demo/media-fixture.mjs";
import { startDemoServer } from "../demo/server.mjs";

const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/live-restart-browser" }, baseline: { type: "boolean", default: false }, "outage-ms": { type: "string", default: "2000" } } });
const outageMs = Number(values["outage-ms"]); assert.ok(Number.isSafeInteger(outageMs) && outageMs >= 1000 && outageMs <= 35000);
const receipt = { v: 1, at: new Date().toISOString(), kind: "rolling-live-discontinuity-recovery", ok: false, failures: [], journeys: [], scope: { network: "loopback", actualMedia: "MPEG-TS byte ranges", outage: "HTTP503 followed by a non-overlapping sequence and continuity window", historicalMSECauseEstablished: false } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (page) => page.evaluate(() => window.relaySwarmDemo.report());
let fixture, demo, proxy, browser, journey;
const controllers = new Set();
await mkdir(values.resultsDir, { recursive: true });
const watchdog = setTimeout(() => { receipt.expired = true; void browser?.close(); proxy?.closeAllConnections(); }, 240000); watchdog.unref();
try {
  fixture = await createMediaFixture({ sectionSeconds: 60 });
  demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [] });
  const baselineBundle = values.baseline ? (await build({ entryPoints: ["demo/client.mjs"], bundle: true, format: "esm", platform: "browser", write: false, plugins: [{ name: "disabled-live-repair-control", setup(builder) {
    builder.onLoad({ filter: /\/demo\/media-recovery\.mjs$/ }, async ({ path }) => {
      const source = await readFile(path, "utf8"), marker = "function observeLive(details, { lastFragmentCC, fatalErrors = 0 } = {}) {";
      assert.ok(source.includes(marker)); return { contents: source.replace(marker, `${marker} return false;`) };
    });
  } }] })).outputFiles[0].contents : null;
  const playlists = {};
  for (const quality of ["low", "high"]) for (const part of ["a", "b"]) {
    const text = await readFile(join(fixture.directory, quality, `${part}.m3u8`), "utf8");
    playlists[`${quality}/${part}`] = [...text.matchAll(/#EXTINF:[^\n]+\n#EXT-X-BYTERANGE:[^\n]+\n[^#\n]+/gu)].map((match) => match[0]);
    assert.ok(playlists[`${quality}/${part}`].length >= 28);
  }
  proxy = createServer(async (request, response) => {
    const controller = new AbortController(); controllers.add(controller);
    response.on("close", () => { controllers.delete(controller); controller.abort(); });
    try {
      const path = new URL(request.url, demo.base).pathname;
      if (path === "/client.js" && baselineBundle) { response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(baselineBundle); return; }
      if (/\/media\/(low|high)\/index\.m3u8$/u.test(path)) {
        journey.playlistRequests++;
        if (journey.outage) { journey.http503++; response.writeHead(503, { "cache-control": "no-store" }).end(); return; }
        const quality = path.split("/")[2], generation = journey.generation;
        const offset = Math.min(17, Math.floor((Date.now() - journey.phaseStarted) / 2000));
        const sequence = (generation ? 136 : 100) + offset;
        const parts = playlists[`${quality}/${generation ? "b" : "a"}`].slice(offset, offset + 12);
        journey.lastPublished = { sequence, cc: generation, at: Date.now() };
        response.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "cache-control": "no-store" }).end(`#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXT-X-DISCONTINUITY-SEQUENCE:${generation}\n#EXT-X-INDEPENDENT-SEGMENTS\n${parts.join("\n")}\n`); return;
      }
      if (path.endsWith(".ts")) {
        journey.mediaRequests++;
        if (journey.holdNewMedia && journey.generation > 0) {
          journey.heldMediaRequests++;
          await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
          journey.abortedHeldRequests++;
          return;
        }
        if (journey.outage) { journey.http503++; response.writeHead(503).end(); return; } }
      const headers = {};
      if (request.headers.range) headers.range = request.headers.range;
      if (request.headers["content-type"]) headers["content-type"] = request.headers["content-type"];
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      if (request.method === "POST") { headers.origin = new URL(demo.base).origin; headers["sec-fetch-site"] = "same-origin"; }
      const upstream = await fetch(new URL(request.url, demo.base), { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, signal: controller.signal });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/octet-stream", ...(upstream.headers.get("content-range") ? { "content-range": upstream.headers.get("content-range") } : {}), "cache-control": "no-store" }).end(bytes);
    } catch (error) { if (!controller.signal.aborted) { journey.proxyErrors.push(error.message); response.writeHead(502).end(); } }
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] }); receipt.browserVersion = browser.version();
  for (const name of values.baseline ? ["baseline"] : ["repaired", "cancelled", "deadline"]) {
  journey = { name, holdNewMedia: name !== "baseline" && name !== "repaired", heldMediaRequests: 0, abortedHeldRequests: 0, generation: 0, outage: false, phaseStarted: Date.now(), playlistRequests: 0, mediaRequests: 0, http503: 0, proxyErrors: [] }; receipt.journeys.push(journey);
  const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(20000);
  await page.goto(`http://127.0.0.1:${proxy.address().port}`); await page.waitForFunction(() => window.relaySwarmDemo?.ready());
  await page.locator("#mode").selectOption("off"); await page.locator("#start").click();
  await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
  await page.locator("#quality").selectOption("1"); await pause(8000);
  journey.before = await report(page); journey.outage = true;
  // A real quality change while the publisher is unavailable exercises the
  // same level-loading reset as the retained hosted restart observer.
  await page.locator("#quality").selectOption("0"); await pause(outageMs);
  journey.generation = 1; journey.phaseStarted = Date.now(); journey.outage = false;
  const media = () => page.evaluate(() => { const v = window.relaySwarmDemo.media; return { time: v.currentTime, frames: v.getVideoPlaybackQuality().totalVideoFrames, readyState: v.readyState, paused: v.paused }; });
  journey.restored = await media();
  if (journey.holdNewMedia) {
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.mediaRecovery.outcome === "recovering");
    const holdDeadline = Date.now() + 3000;
    while (!journey.heldMediaRequests && Date.now() < holdDeadline) await pause(20);
    assert.ok(journey.heldMediaRequests > 0, "recovery must request actual media before cancellation/timeout");
    if (name === "cancelled") await page.locator("#kill").click();
    else await page.waitForFunction(() => window.relaySwarmDemo.report().player.mediaRecovery.outcome === "failed", null, { timeout: 12000 });
    journey.terminal = await report(page); journey.requestsAtTerminal = journey.mediaRequests;
    await pause(3000);
  } else { await pause(12000); journey.settled = await media(); await pause(6000); }
  journey.after = await media(); journey.report = await report(page);
  journey.newContinuityLoaded = journey.report.player.fragments.some((fragment) => fragment.discontinuity === 1);
  assert.ok(journey.http503 > 0, "browser must encounter actual outage responses");
  assert.deepEqual(journey.proxyErrors, []);
  if (values.baseline) {
    journey.stalled = !journey.newContinuityLoaded && journey.after.frames === journey.settled.frames;
    assert.ok(journey.stalled, "baseline must reproduce no frame progress and no fresh-continuity fragments");
  } else if (!journey.holdNewMedia) {
    assert.ok(journey.newContinuityLoaded && journey.after.frames > journey.restored.frames + 30, "recovery must load new continuity and decode progressing frames");
    assert.equal(journey.report.player.mediaRecovery.attempted, 1);
    assert.equal(journey.report.player.mediaRecovery.outcome, "recovered");
    assert.equal(journey.report.player.mediaRecovery.records[0].kind, "live-window-stall");
    assert.equal(journey.report.player.mediaRecovery.records[0].reason, "playback-advanced");
    assert.ok(journey.report.player.errors.levelLoadError >= 1, "original network failures remain recorded");
    assert.equal(journey.report.uploadBudget.spent, journey.before.uploadBudget.spent, "repair must not reset the upload budget");
    assert.equal(await page.locator("#upload").isChecked(), false);
    assert.equal(await page.locator("#mode").inputValue(), "off");
    assert.equal(journey.report.loaderRestored, true);
  } else {
    assert.equal(journey.report.player.mediaRecovery.attempted, 1);
    assert.equal(journey.report.player.mediaRecovery.outcome, name === "cancelled" ? "cancelled" : "failed");
    assert.equal(journey.report.player.mediaRecovery.records[0].reason, name === "cancelled" ? "viewer-cancelled" : "progress-timeout");
    assert.equal(journey.after.paused, true);
    assert.equal(journey.abortedHeldRequests, journey.heldMediaRequests, "stop must abort every held media request");
    assert.equal(journey.mediaRequests, journey.requestsAtTerminal, "terminal recovery must not silently start another request");
    assert.equal(journey.report.uploadBudget.spent, journey.before.uploadBudget.spent);
    assert.equal(journey.report.loaderRestored, true);
    assert.equal(await page.locator("#upload").isChecked(), false);
  }
  assert.equal(journey.report.player.fatalErrors, 0); assert.equal(journey.report.player.nativeErrors.length, 0);
  await context.close();
  }
  receipt.ok = true;
} catch (error) { receipt.failures.push(error.stack || error.message); }
finally {
  clearTimeout(watchdog); await browser?.close(); for (const controller of controllers) controller.abort();
  proxy?.closeAllConnections(); if (proxy?.listening) await new Promise((resolve) => proxy.close(resolve));
  await demo?.close(); await fixture?.close(); receipt.cleanup = { browserClosed: true, fixturesClosed: true };
  await writeFile(join(values.resultsDir, "live-restart.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, journeys: receipt.journeys.map(({ name, http503, restored, after, stalled, newContinuityLoaded }) => ({ name, http503, restored, after, stalled, newContinuityLoaded })) }, null, 2));
process.exitCode = receipt.ok ? 0 : 1;
