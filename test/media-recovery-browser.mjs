#!/usr/bin/env node
// Corrupt actual fMP4 HTTP payloads, retaining valid box framing but referencing
// an undeclared track. Acceptance requires a real asynchronous MSE error.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { startDemoServer } from "../demo/server.mjs";
import { createFmp4Fixture } from "./support/fmp4-fixture.mjs";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";

const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/media-recovery-browser" } } });
const receipt = { v: 1, at: new Date().toISOString(), kind: "real-mse-bounded-recovery", ok: false, failures: [], scope: { network: "loopback HTTP", corruption: "fMP4 tfhd references undeclared track ID", historicalCauseEstablished: false, physicalDevices: false }, journeys: [] };
await mkdir(values.resultsDir, { recursive: true });
let fixture, demo, proxy, browser, current, currentPage;
const holds = new Set();
const read = (page) => page.evaluate(() => window.relaySwarmDemo.report());
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const watchdog = setTimeout(() => { receipt.expired = true; void browser?.close(); proxy?.closeAllConnections(); }, 180000); watchdog.unref();
function corrupt(bytes) {
  const copy = Buffer.from(bytes), marker = copy.indexOf(Buffer.from("tfhd"));
  assert.ok(marker >= 4 && marker + 12 <= copy.length, "actual fMP4 track fragment required");
  const previousTrackId = copy.readUInt32BE(marker + 8);
  copy.writeUInt32BE(0x7fffffff, marker + 8);
  return { bytes: copy, previousTrackId };
}
try {
  fixture = await createFmp4Fixture({ seconds: 24 });
  demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [] });
  proxy = createServer(async (request, response) => {
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const headers = request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {};
      if (request.method === "POST") {
        // Translate only this fixture's actual same-origin browser requests to
        // the inner loopback server's origin; its admission checks stay intact.
        if (request.headers.origin !== base) { response.writeHead(403).end(); return; }
        headers.origin = new URL(demo.base).origin; headers["sec-fetch-site"] = "same-origin";
      }
      const upstream = await fetch(new URL(request.url, demo.base), { method: request.method, body: chunks.length ? Buffer.concat(chunks) : undefined, headers, signal: controller.signal });
      let bytes = Buffer.from(await upstream.arrayBuffer());
      const path = new URL(request.url, demo.base).pathname;
      if (path.endsWith(".m3u8") && current?.live) bytes = Buffer.from(bytes.toString().replace(/#EXT-X-PLAYLIST-TYPE:VOD\n|#EXT-X-ENDLIST\n/g, ""));
      if (path.endsWith(".m4s")) {
        const journey = current; journey.mediaRequests++;
        // Keep corrupting through hls.js's own rendition/reset retries. Only
        // repair once the real fatal has reached the application's one attempt.
        const attempted = (await read(currentPage)).player.mediaRecovery.attempted;
        if (!attempted || journey.name === "repeated-corruption") {
          const damaged = corrupt(bytes); bytes = damaged.bytes;
          journey.corruptions.push({ path, previousTrackId: damaged.previousTrackId, replacementTrackId: 0x7fffffff, bytes: bytes.length });
        } else if (journey.name === "cancel-recovery" || journey.name === "progress-timeout") {
          journey.heldRequests++;
          await new Promise((resolve) => { holds.add(resolve); controller.signal.addEventListener("abort", () => { holds.delete(resolve); journey.cancelledRequests++; resolve(); }, { once: true }); });
          if (controller.signal.aborted) return;
        }
      }
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/octet-stream", "cache-control": "no-store" }); response.end(bytes);
    } catch (error) { if (!controller.signal.aborted) { current?.proxyErrors.push(error.message); response.writeHead(502).end(); } }
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const base = `http://127.0.0.1:${proxy.address().port}`;
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required"] }); receipt.browserVersion = browser.version();
  for (const name of ["vod-repaired", "live-repaired", "repeated-corruption", "cancel-recovery", "progress-timeout"]) {
    current = { name, live: name === "live-repaired", mediaRequests: 0, heldRequests: 0, cancelledRequests: 0, corruptions: [], proxyErrors: [] }; receipt.journeys.push(current);
    const context = await browser.newContext(), page = await context.newPage(); currentPage = page; page.setDefaultTimeout(18000);
    await page.addInitScript(installMediaDiagnostics);
    await page.addInitScript(() => localStorage.setItem("relayswarm-upload-budget-v1", JSON.stringify({ v: 1, spent: 1234, limit: 100000000, revision: 1 })));
    try {
      await page.goto(base); await page.waitForFunction(() => window.relaySwarmDemo?.ready());
      await page.locator("#mode").selectOption("peer-first"); await page.locator("#upload").check(); await page.locator("#start").click();
      await page.waitForFunction(() => window.relaySwarmDemo.report().player.mediaRecovery.attempted === 1);
      if (name === "cancel-recovery") {
        const deadline = Date.now() + 5000;
        while (!current.heldRequests && Date.now() < deadline) await pause(25);
        assert.ok(current.heldRequests > 0, "cancel an actual in-flight recovery request");
        await page.locator("#kill").click();
        await page.waitForFunction(() => window.relaySwarmDemo.report().player.mediaRecovery.outcome === "cancelled");
      } else await page.waitForFunction((expected) => window.relaySwarmDemo.report().player.mediaRecovery.outcome === expected, name.endsWith("repaired") ? "recovered" : "failed");
      const terminalRequests = current.mediaRequests;
      await pause(1200);
      current.report = await read(page);
      current.diagnostics = await page.evaluate(() => window.relaySwarmMediaDiagnostics);
      current.controls = await page.evaluate(() => ({ upload: document.getElementById("upload").checked, mode: document.getElementById("mode").value, status: document.getElementById("status").textContent, nativeError: window.relaySwarmDemo.media.error && { code: window.relaySwarmDemo.media.error.code, message: window.relaySwarmDemo.media.error.message } }));
      const report = current.report, recovery = report.player.mediaRecovery;
      assert.equal(recovery.attempted, 1); assert.equal(recovery.records.length, 1);
      assert.ok(report.player.fatalErrors >= 1);
      assert.equal(report.player.errorRecords.filter((error) => error.fatal).length, report.player.fatalErrors);
      assert.ok(current.diagnostics.some((entry) => entry.kind === "source-buffer-error"), "real asynchronous SourceBuffer error required");
      assert.equal(current.controls.upload, false); assert.equal(current.controls.mode, "off");
      assert.equal(report.uploadBudget.spent, 1234); assert.equal(report.totals.uploaded, 0); assert.equal(report.loaderRestored, true);
      assert.ok(report.sessions.some((session) => session.upload), "contribution was initially enabled before recovery revoked it");
      if (name.endsWith("repaired")) { assert.equal(current.controls.nativeError, null); assert.equal(recovery.records[0].live, current.live); assert.ok(report.player.currentTime > recovery.records[0].requestedPosition + 0.25); }
      else {
        assert.equal(report.player.paused, true); assert.equal(current.mediaRequests, terminalRequests, "terminal recovery must not keep requesting media");
        if (name === "repeated-corruption") { assert.ok(report.player.fatalErrors >= 2); assert.ok(report.player.nativeErrors.length >= 1, "native decoder failure remains recorded"); }
        else { assert.ok(current.heldRequests >= 1); assert.equal(current.cancelledRequests, current.heldRequests, "stopping recovery aborts held HTTP requests"); }
      }
      if (name === "progress-timeout") {
        const record = recovery.records[0]; assert.equal(record.reason, "progress-timeout");
        assert.ok(record.endedAtMs - record.attemptedAtMs >= 10000 && record.endedAtMs - record.attemptedAtMs < 12000);
      }
      assert.deepEqual(current.proxyErrors, []); current.ok = true;
      console.error(`[media-recovery] ${name}: ${recovery.outcome}`);
    } finally {
      current.report ??= await read(page).catch(() => null);
      current.diagnostics ??= await page.evaluate(() => window.relaySwarmMediaDiagnostics).catch(() => null);
      current.transitions = await page.evaluate(() => window.relaySwarmMediaTransitions).catch(() => null);
      await context.close(); for (const release of holds) release(); holds.clear();
    }
  }
  receipt.ok = true;
} catch (error) { receipt.failures.push(error.stack || error.message); }
finally {
  clearTimeout(watchdog); for (const release of holds) release(); holds.clear();
  await browser?.close(); proxy?.closeAllConnections(); if (proxy) await new Promise((resolve) => proxy.close(resolve));
  await demo?.close(); await fixture?.close();
  await writeFile(join(values.resultsDir, "media-recovery.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ok: receipt.ok, failures: receipt.failures, receipt: join(values.resultsDir, "media-recovery.json") }, null, 2));
}
process.exitCode = receipt.ok ? 0 : 1;
