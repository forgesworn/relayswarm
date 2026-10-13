#!/usr/bin/env node
// Actual same-origin HTTP holds: page.route would disable the cache being tested.
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { parseArgs } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";
import { createMediaFixture } from "../demo/media-fixture.mjs";
import { startDemoServer } from "../demo/server.mjs";

const { values } = parseArgs({ options: {
  chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  resultsDir: { type: "string", default: "artifacts/policy-cache-browser" },
} });
await mkdir(values.resultsDir, { recursive: true });
const receiptPath = join(values.resultsDir, "policy-cache-browser.json");
try { await readFile(receiptPath); throw new Error("Preserve the existing receipt; supply a fresh --resultsDir."); } catch (error) { if (error.code !== "ENOENT") throw error; }
const receipt = { v: 1, kind: "policy-cache-browser", ok: false, startedUTC: new Date().toISOString(),
  scope: "Loopback real HTTP before-header holds; ordinary Chrome/native consent and Start; no routing, cache flags, fake media or permissions; no physical/NAT claim",
  deadlineScope: "100s best-effort journey deadline triggers cleanup; process-group termination is not independently proved",
  sourceHashes: {}, cases: [], cleanup: { browser: "not-started", demo: "not-started", media: "not-started" } };
for (const file of ["demo/client.mjs", "demo/policy-renewal.mjs", "demo/fetch-diagnostics.mjs", "test/policy-cache-browser.mjs"]) {
  receipt.sourceHashes[file] = createHash("sha256").update(await readFile(new URL(`../${file}`, import.meta.url))).digest("hex");
}
let browser, demo, fixture, server, holdRoute, heldOnce = false, outage = false, closing;
const arrivals = [], held = new Set(), pageErrors = [];
async function cleanup() {
  if (closing) return closing;
  closing = (async () => {
    for (const entry of held) { clearTimeout(entry.timer); entry.response.destroy(); }
    const resources = [
      { name: "browser", resource: browser, success: "closed" },
      { name: "demo", resource: demo, success: "http-and-relay-closed" },
      { name: "media", resource: fixture, success: "processes-stopped-and-scratch-removed" },
    ].filter(({ resource }) => resource);
    const results = await Promise.allSettled(resources.map(({ resource }) => Promise.resolve().then(() => resource.close())));
    results.forEach((result, index) => {
      const { name, success } = resources[index];
      receipt.cleanup[name] = result.status === "fulfilled" ? success : "close-failed";
      if (result.status === "rejected") { receipt.ok = false; receipt.cleanupFailed = true; }
    });
  })();
  return closing;
}
const save = () => writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
const deadline = setTimeout(() => {
  receipt.failureClass = "Overall100SecondDeadline";
  cleanup().then(save).finally(() => { process.exitCode = 1; });
}, 100000);
const shortReport = async (page) => page.evaluate(() => {
  const r = window.relaySwarmDemo.report(), video = document.querySelector("video");
  return { atMs: Date.now(), upload: document.querySelector("#upload").checked, visible: document.visibilityState === "visible",
    serving: r.current?.metrics.serving ?? false, unavailable: r.deliveryPolicy.unavailable, budget: r.uploadBudget,
    frames: video.getVideoPlaybackQuality().totalVideoFrames, fatal: r.player.fatalErrors, nativeErrors: r.player.nativeErrors.length,
    renewal: r.policyRenewal, controlTimings: r.controlTimings };
});
try {
  fixture = await createMediaFixture({ sectionSeconds: 30 }); receipt.cleanup.media = "running";
  // Capture only this server in this isolated CLI process. Restore the factory
  // before opening Chrome; app, relay and admission keep their real origin.
  const createServer = http.createServer;
  try {
    http.createServer = (...args) => { server = createServer(...args); return server; };
    syncBuiltinESMExports();
    demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [] }); receipt.cleanup.demo = "running";
  } finally { http.createServer = createServer; syncBuiltinESMExports(); }
  assert.equal(server.address().port, Number(new URL(demo.base).port), "Wrap only the server returned by this fixture");
  const handlers = server.listeners("request"); assert.equal(handlers.length, 1);
  server.removeListener("request", handlers[0]);
  server.on("request", (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    const route = path === "/delivery-policy.json" ? "policy" : path === "/session.json" ? "session" : null;
    if (route) {
      const entry = { route, atMs: Date.now(), held: false }; arrivals.push(entry);
      if (outage) { response.writeHead(503, { "cache-control": "no-store" }); response.end(); return; }
      if (route === holdRoute && !heldOnce) {
        heldOnce = true; entry.held = true;
        const resource = { response }; held.add(resource);
        response.on("close", () => { entry.closedAtMs = Date.now(); clearTimeout(resource.timer); held.delete(resource); });
        resource.timer = setTimeout(() => response.destroy(), 6500);
        return; // No headers are sent; later requests encounter ordinary caching.
      }
    }
    handlers[0](request, response);
  });
  browser = await chromium.launch({ executablePath: values.chrome, headless: true }); receipt.cleanup.browser = "running";
  receipt.browserVersion = browser.version();
  const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(12000);
  page.on("pageerror", () => pageErrors.push("PageError"));
  await page.goto(demo.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.relaySwarmDemo?.ready() && !document.querySelector("#start").disabled);
  await page.evaluate(() => {
    window.ownControlWitnesses = [];
    for (const control of ["upload", "start"]) document.getElementById(control).addEventListener("click", (event) => window.ownControlWitnesses.push({ control, trusted: event.isTrusted }));
  });
  await page.locator("#mode").selectOption("peer-first"); await page.locator("#allowance").selectOption("10000000");
  await page.locator("#upload").check(); await page.locator("#start").click();
  await page.waitForFunction(() => window.relaySwarmDemo.report().current?.metrics.serving && window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
  receipt.witnesses = await page.evaluate(() => window.ownControlWitnesses);
  assert.deepEqual(receipt.witnesses, [{ control: "upload", trusted: true }, { control: "start", trusted: true }]);
  for (const route of ["policy", "session"]) {
    const before = await shortReport(page), start = Date.now(), samples = [];
    holdRoute = route; heldOnce = false;
    while (Date.now() - start < 10000) {
      const sample = await shortReport(page); samples.push(sample);
      assert.equal(sample.upload, true); assert.equal(sample.serving, true); assert.equal(sample.unavailable, false);
      assert.equal(sample.budget.limit, before.budget.limit); assert.ok(sample.budget.spent >= before.budget.spent);
      await page.waitForTimeout(100);
    }
    holdRoute = undefined;
    const after = await shortReport(page), first = arrivals.find((entry) => entry.route === route && entry.held && entry.atMs >= start);
    assert.ok(first); const next = arrivals.find((entry) => entry.route === route && !entry.held && entry.atMs > first.atMs);
    assert.ok(next); assert.ok(next.atMs - first.atMs < 3000, "Later renewal must reach the real server while its predecessor is held");
    assert.ok(first.closedAtMs > next.atMs, "Independent request arrives before held request closes");
    assert.ok(after.controlTimings.records.some((entry) => entry.route === route && entry.outcome === "cancelled" && entry.durationMs >= 4500), "Retain held request cancellation");
    assert.ok(after.renewal.records.some((entry) => entry.outcome === "cancelled" && entry.durationMs >= 4900));
    assert.ok(after.frames > before.frames); assert.equal(after.fatal, 0); assert.equal(after.nativeErrors, 0);
    receipt.cases.push({ route, first, next, before, after, samples: samples.map(({ renewal, controlTimings, ...sample }) => sample) });
  }
  const beforeOutage = await shortReport(page); outage = true;
  await page.waitForFunction(() => window.relaySwarmDemo.report().deliveryPolicy.unavailable && !document.querySelector("#upload").checked, null, { timeout: 6000 });
  receipt.outage = await shortReport(page); assert.equal(receipt.outage.serving, false); assert.equal(receipt.outage.renewal.fresh, false);
  assert.equal(receipt.outage.budget.limit, beforeOutage.budget.limit); assert.ok(receipt.outage.budget.spent >= beforeOutage.budget.spent);
  outage = false;
  await page.waitForFunction(() => !window.relaySwarmDemo.report().deliveryPolicy.unavailable, null, { timeout: 5000 });
  receipt.recovered = await shortReport(page); assert.equal(receipt.recovered.upload, false); assert.equal(receipt.recovered.serving, false);
  assert.equal(receipt.recovered.fatal, 0); assert.equal(receipt.recovered.nativeErrors, 0); assert.deepEqual(pageErrors, []);
  receipt.ok = !receipt.cleanupFailed && !receipt.failureClass;
} catch (error) { receipt.failureClass = error.name; receipt.failure = error instanceof assert.AssertionError ? error.message : "Bounded browser setup or journey failed"; }
finally { clearTimeout(deadline); await cleanup(); receipt.endedUTC = new Date().toISOString(); receipt.arrivals = arrivals; await save(); }
console.log(JSON.stringify({ ok: receipt.ok, cases: receipt.cases.map(({ route, first, next }) => ({ route, laterRequestDelayMs: next.atMs - first.atMs })), cleanup: receipt.cleanup }));
process.exitCode = receipt.ok ? 0 : 1;
