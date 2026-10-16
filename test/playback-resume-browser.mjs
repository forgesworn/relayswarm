#!/usr/bin/env node
// A trusted control check using the real player and original media fixture.
// Synthetic pause/reload is not a reproduction of Safari's background failure.
import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createMediaFixture } from "../demo/media-fixture.mjs";
import { startDemoServer } from "../demo/server.mjs";

const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/playback-resume" } } });
const receipt = { v: 1, kind: "relayswarm-playback-resume-control", ok: false, scope: { network: "loopback", contexts: 1, media: "original two-rendition byte-range fixture", autoplayOverride: false, syntheticPause: true, physicalSafari: false, audio: "decoded bytes, not audible output" }, cleanup: {}, failures: [] };
let fixture, demo, browser, context, page;
let manifests = 0, masters = 0, reports = 0;
const errors = [];
await mkdir(values.resultsDir, { recursive: true });
try {
  fixture = await createMediaFixture();
  demo = await startDemoServer({ mediaDir: fixture.directory, iceServers: [], telemetry: false });
  browser = await chromium.launch({ executablePath: values.chrome, headless: true, timeout: 10000 });
  receipt.scope.browserVersion = browser.version();
  context = await browser.newContext(); page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on("pageerror", error => { if (errors.length < 16) errors.push(error.message.slice(0, 256)); });
  page.on("request", request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith(".m3u8")) manifests++;
    if (path === "/media/master.m3u8") masters++;
    if (path === "/reports") reports++;
  });
  // Observe the synchronous call boundary without altering its arguments,
  // receiver, return value or exceptions. No extra playback or network action.
  await page.addInitScript(() => {
    const witness = { registrations: 0, clicks: [], plays: [], dropped: 0 }; let resumeClick = false;
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, callback, options) {
      if (this instanceof Element && this.id === "resume" && type === "click" && typeof callback === "function") {
        witness.registrations++;
        const wrapped = function (...args) {
          const previous = resumeClick; resumeClick = args[0]?.isTrusted === true;
          try {
            if (witness.clicks.length < 8) witness.clicks.push({ trusted: resumeClick, active: navigator.userActivation?.isActive === true });
            else witness.dropped++;
            return Reflect.apply(callback, this, args);
          } finally { resumeClick = previous; }
        };
        return Reflect.apply(add, this, [type, wrapped, options]);
      }
      return Reflect.apply(add, this, [type, callback, options]);
    };
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      try { if (witness.plays.length < 8) witness.plays.push({ resumeClick, mainVideo: this === document.querySelector("video"), active: navigator.userActivation?.isActive === true }); else witness.dropped++; } catch {}
      return Reflect.apply(original, this, args);
    };
    Object.defineProperty(window, "resumeControlWitness", { value: () => structuredClone(witness) });
  });
  await page.goto(demo.base);
  await page.waitForFunction(() => window.relaySwarmDemo?.ready() && !document.getElementById("start").disabled);
  assert.equal(await page.locator("#telemetry").isDisabled(), true);
  assert.match(await page.locator("#telemetry-label").textContent(), /switched off by this service/u);
  await page.locator("#mode").selectOption("peer-first"); await page.locator("#upload").check();
  await page.locator("#start").click();
  await page.waitForFunction(() => {
    const video = window.relaySwarmDemo.media;
    return !video.paused && video.currentTime > 0.25 && video.getVideoPlaybackQuality().totalVideoFrames > 5 && video.webkitAudioDecodedByteCount > 0;
  });
  const read = () => page.evaluate(() => {
    const video = window.relaySwarmDemo.media;
    return { report: window.relaySwarmDemo.report(), time: video.currentTime, frames: video.getVideoPlaybackQuality().totalVideoFrames, audioBytes: video.webkitAudioDecodedByteCount, witness: window.resumeControlWitness() };
  });
  const before = await read(); receipt.before = before; const manifestsBefore = manifests;
  assert.equal(before.report.current.mode, "peer-first"); assert.equal(before.report.current.upload, true);
  await page.evaluate(() => window.relaySwarmDemo.media.pause());
  await page.locator("#resume").click();
  await page.waitForFunction(() => {
    const r = window.relaySwarmDemo.report(), video = window.relaySwarmDemo.media;
    return r.player.resumeRecords.at(-1)?.outcome === "play-request-resolved" && !video.paused && video.currentTime > 0.25 && video.getVideoPlaybackQuality().totalVideoFrames > 5 && video.webkitAudioDecodedByteCount > 0;
  });
  const restarted = await read();
  await page.waitForFunction(({ time, frames, audioBytes }) => {
    const v = window.relaySwarmDemo.media;
    return !v.paused && v.currentTime > time + 0.25 && v.getVideoPlaybackQuality().totalVideoFrames > frames && v.webkitAudioDecodedByteCount > audioBytes;
  }, restarted);
  const resumed = await read(); receipt.resumed = resumed;
  assert.ok(manifests > manifestsBefore, "Resume must request the replacement HLS resource");
  assert.equal(resumed.report.player.resumeAttempts, 1); assert.equal(resumed.report.current.mode, "off");
  assert.equal(resumed.report.current.upload, false); assert.equal(resumed.report.current.metrics.serving, false);
  assert.equal(await page.locator("#mode").inputValue(), "peer-first");
  for (const id of ["upload", "telemetry"]) assert.equal(await page.locator(`#${id}`).isChecked(), false);
  assert.equal(resumed.report.uploadBudget.spent, before.report.uploadBudget.spent);
  assert.equal(resumed.report.player.fatalErrors, before.report.player.fatalErrors);
  assert.deepEqual(resumed.report.player.errorRecords, before.report.player.errorRecords);
  const click = resumed.witness.clicks.at(-1);
  const ownedPlays = resumed.witness.plays.filter(row => row.resumeClick);
  assert.equal(resumed.witness.registrations, 1); assert.equal(resumed.witness.dropped, 0);
  assert.equal(resumed.witness.clicks.length, 1); assert.equal(click.trusted, true); assert.equal(click.active, true);
  assert.ok(ownedPlays.some(row => row.active && row.mainVideo), "the real trusted Resume handler must synchronously call play on the player");
  const mastersAfterResume = masters;
  await page.locator("#start").click();
  await page.waitForFunction(() => window.relaySwarmDemo.report().current?.mode === "peer-first");
  const applied = await read(); receipt.applied = applied;
  assert.equal(applied.report.current.upload, false); assert.equal(applied.report.current.metrics.serving, false);
  assert.equal(applied.witness.plays.filter(row => row.resumeClick).length, ownedPlays.length, "Apply must not invoke the Resume handler");
  assert.equal(masters, mastersAfterResume, "Apply must not reload the master resource"); assert.equal(reports, 0); assert.equal(errors.length, 0);
  assert.equal(applied.report.player.fatalErrors, 0); receipt.ok = true;
} catch (error) {
  receipt.failures.push(error.stack || error.message);
  if (page) receipt.failureReport = await page.evaluate(() => window.relaySwarmDemo?.report()).catch(() => null);
} finally {
  receipt.requests = { manifests, masters, reports }; receipt.pageErrors = errors;
  for (const [name, resource] of [["context", context], ["browser", browser], ["demo", demo], ["fixture", fixture]]) {
    if (!resource) { receipt.cleanup[name] = "not-created"; continue; }
    try { await resource.close(); receipt.cleanup[name] = true; }
    catch (error) { receipt.cleanup[name] = false; receipt.ok = false; receipt.failures.push(`${name} cleanup: ${error.name}`); }
  }
  await writeFile(join(values.resultsDir, "playback-resume.json"), `${JSON.stringify(receipt, null, 2)}\n`);
}
console.log(JSON.stringify({ ok: receipt.ok, cleanup: receipt.cleanup, failures: receipt.failures, receipt: join(values.resultsDir, "playback-resume.json") }));
process.exitCode = receipt.ok ? 0 : 1;
