#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { startDemoServer } from "../demo/server.mjs";
import { installMediaDiagnostics } from "./support/browser-media-diagnostics.mjs";
const { values } = parseArgs({ options: { chrome: { type: "string", default: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }, resultsDir: { type: "string", default: "artifacts/sparse-aac-recovery-browser" } } });
const dir = values.resultsDir, source = fileURLToPath(new URL("./fixtures/sparse-aac/", import.meta.url));
await mkdir(dir, { recursive: true });
const hash = (b) => createHash("sha256").update(b).digest("hex");
const work = await mkdtemp(join(tmpdir(), "relayswarm-sparse-recovery-"));
const r = { startedAt: (/* @__PURE__ */ new Date()).toISOString(), scope: { singleRun: true, originOnly: true, loopbackHTTP: true, normalBrowserPermissions: true, fakeFlags: false, trustedStartRequired: true, rawBytesUnchanged: true, originalLowVariantMetadata: true, originalMasterUnchanged: false, constructedSingleVariantMaster: true, highVariantAbsent: true, constructedTwoSegmentVOD: true, historicalCauseEstablished: false, testOnlyObserverOverlay: true }, inputs: [], responses: [], snapshots: [], failures: [], cleanup: {} };
let browser, demo, page;
let expired = false;
const watchdog = setTimeout(() => {
  expired = true;
  void browser?.close();
}, 105e3);
try {
  const master = Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=850000,RESOLUTION=640x360,FRAME-RATE=30\nlow/index.m3u8\n");
  await writeFile(join(work, "master.m3u8"), master);
  await writeFile(`${dir}/constructed-low-only-master.m3u8`, master);
  r.masterSHA256 = hash(master);
  r.master = master.toString();
  for (const [level, start] of [["low", 784]]) {
    await mkdir(join(work, level));
    const lines = ["#EXTM3U", "#EXT-X-VERSION:6", "#EXT-X-DISCONTINUITY-SEQUENCE:2", "#EXT-X-TARGETDURATION:2", `#EXT-X-MEDIA-SEQUENCE:${start}`, "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS"];
    for (let n = 0; n < 2; n++) {
      const b = await readFile(join(source, `${start + n}.ts`)), name = `segment-${start + n}.ts`;
      assert.equal(hash(b), n === 0 ? "ab187fe08ee205c5542c7d4b66fa2af56339e237de5b95b0b45c8a4654bd1639" : "3656399c37ecf2ff9ebf58ac00e34d2251ad22d44014da4bff057e9a274acaad");
      await writeFile(join(work, level, name), b);
      r.inputs.push({ level, sequence: start + n, bytes: b.length, sha256: hash(b), source: `test/fixtures/sparse-aac/${start + n}.ts`, scope: level === "low" ? "tested exact784\u2192785" : "unused original high media; catalogue only" });
      lines.push("#EXTINF:2.000000,", name);
    }
    lines.push("#EXT-X-ENDLIST", "");
    await writeFile(join(work, level, "index.m3u8"), lines.join("\n"));
    await writeFile(`${dir}/constructed-${level}.m3u8`, lines.join("\n"));
  }
  const original = await readFile("demo/client.mjs", "utf8");
  r.clientSourceSHA256 = hash(original);
  r.recoverySourceSHA256 = hash(await readFile("demo/media-recovery.mjs"));
  const observer = String.raw`
      window.__replayHlsEvents=[];
      const replayFrag=f=>f?{sequence:f.sn,cc:f.cc,start:f.start,duration:f.duration,type:f.type,level:f.level}:null;
      window.__replayHlsState=()=>({currentTime:video.currentTime,live:hls.latestLevelDetails?.live??null,latestLevelDetails:hls.latestLevelDetails?{live:hls.latestLevelDetails.live,startSN:hls.latestLevelDetails.startSN,endSN:hls.latestLevelDetails.endSN,startCC:hls.latestLevelDetails.startCC,endCC:hls.latestLevelDetails.endCC,fragmentStart:hls.latestLevelDetails.fragmentStart,edge:hls.latestLevelDetails.edge,fragments:hls.latestLevelDetails.fragments.map(replayFrag)}:null});
      for(const event of Object.values(Hls.Events))hls.on(event,(_name,data)=>{const trace=window.__replayHlsEvents,entry={atMs:performance.now(),event,frag:replayFrag(data?.frag)};if(event===Hls.Events.ERROR)Object.assign(entry,{type:data.type,details:data.details,fatal:data.fatal,error:data.error?{name:data.error.name,message:data.error.message}:null,reason:data.reason,state:window.__replayHlsState()});if(event===Hls.Events.BUFFER_CODECS)entry.tracks=Object.fromEntries(Object.entries(data).filter(([k])=>k!=='tracks').map(([k,v])=>[k,{codec:v.codec,container:v.container}]));trace.push(entry);if(trace.length>600)trace.shift();});
`;
  assert.equal(original.split("      initialLoader = hls.config.fLoader;").length, 2);
  const instrumented = original.replace("      initialLoader = hls.config.fLoader;", observer + "      initialLoader = hls.config.fLoader;");
  await writeFile(`${dir}/observer.txt`, observer);
  const bundle = await build({ entryPoints: [resolve("demo/client.mjs")], bundle: true, format: "esm", platform: "browser", write: false, minify: true, logLevel: "silent", plugins: [{ name: "test-only-read-observer", setup(b) {
    b.onLoad({ filter: /demo\/client\.mjs$/ }, () => ({ contents: instrumented, loader: "js", resolveDir: resolve("demo") }));
  } }] });
  r.observedBundleSHA256 = hash(bundle.outputFiles[0].contents);
  demo = await startDemoServer({ mediaDir: work, iceServers: [] });
  browser = await chromium.launchPersistentContext(join(work, "profile"), { executablePath: values.chrome, headless: true, ignoreHTTPSErrors: false });
  r.browserVersion = browser.browser().version();
  page = await browser.newPage();
  page.setDefaultTimeout(15e3);
  r.pageErrors = [];
  r.requestFailures = [];
  page.on("pageerror", (e) => r.pageErrors.push({ name: e.name, message: e.message }));
  page.on("requestfailed", (q) => r.requestFailures.push({ path: new URL(q.url()).pathname, error: q.failure()?.errorText }));
  const cdp = await page.context().newCDPSession(page);
  r.audioDecoderProperties = [];
  await cdp.send("Media.enable");
  cdp.on("Media.playerPropertiesChanged", ({ properties }) => {
    for (const property of properties) {
      if (["kAudioDecoderName", "kIsPlatformAudioDecoder", "kAudioTracks"].includes(property.name) && r.audioDecoderProperties.length < 24) r.audioDecoderProperties.push({ name: property.name, value: property.value.slice(0, 2048) });
    }
  });
  await page.addInitScript(installMediaDiagnostics);
  await page.addInitScript(() => {
    localStorage.setItem("relayswarm-upload-budget-v1", JSON.stringify({ v: 1, spent: 1234, limit: 1e8, revision: 1 }));
    window.__replayInput = [];
    document.addEventListener("click", (e) => {
      if (e.target?.id === "start") window.__replayInput.push({ trusted: e.isTrusted, atMs: performance.now() });
    }, true);
  });
  await page.route("**/client.js", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: Buffer.from(bundle.outputFiles[0].contents) }));
  const captures = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (path.endsWith(".ts")) captures.push(response.body().then((b) => r.responses.push({ path, status: response.status(), bytes: b.length, sha256: hash(b) })).catch(() => r.responses.push({ path, bodyUnavailable: true })));
  });
  await page.goto(demo.base, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.relaySwarmDemo?.ready());
  assert.deepEqual(r.pageErrors, [], "module execution must be healthy beforeStart");
  await page.locator("#mode").selectOption("off");
  assert.equal(await page.locator("#upload").isChecked(), false);
  assert.equal(await page.locator("#telemetry").isChecked(), false);
  await page.locator("#start").click();
  await page.waitForFunction(() => !document.getElementById("quality").disabled);
  r.singleVariantNoQualityOverride = true;
  const end = Date.now() + 25e3;
  while (!expired && Date.now() < end) {
    await page.waitForTimeout(250);
    const s = await page.evaluate(() => ({ atMs: performance.now(), player: window.relaySwarmDemo.report().player, frames: window.relaySwarmDemo.media.getVideoPlaybackQuality().totalVideoFrames }));
    r.snapshots.push(s);
    if (s.player.mediaRecovery.attempted && ["failed", "cancelled", "recovered"].includes(s.player.mediaRecovery.outcome)) {
      await page.waitForTimeout(1800);
      break;
    }
  }
  await Promise.allSettled(captures);
  r.final = await page.evaluate(() => ({ report: window.relaySwarmDemo.report(), frames: window.relaySwarmDemo.media.getVideoPlaybackQuality().totalVideoFrames, audioDecodedBytes: Number.isFinite(window.relaySwarmDemo.media.webkitAudioDecodedByteCount) ? window.relaySwarmDemo.media.webkitAudioDecodedByteCount : null, events: window.__replayHlsEvents, hlsState: window.__replayHlsState(), mse: window.relaySwarmMediaDiagnostics, transitions: window.relaySwarmMediaTransitions, input: window.__replayInput, controls: { mode: document.getElementById("mode").value, upload: document.getElementById("upload").checked, telemetry: document.getElementById("telemetry").checked } }));
  await page.screenshot({ path: `${dir}/final.png` });
  const f = r.final, p = f.report.player;
  assert.ok(f.input.some((e) => e.trusted));
  assert.ok(p.fatalErrors >= 1);
  assert.equal(p.mediaRecovery.attempted, 1);
  assert.equal(p.mediaRecovery.records.length, 1);
  assert.equal(f.report.uploadBudget.spent, 1234);
  assert.equal(f.controls.upload, false);
  assert.equal(f.controls.telemetry, false);
  assert.equal(f.controls.mode, "off");
  assert.equal(f.report.totals.uploaded, 0);
  assert.equal(r.responses.filter((x) => x.path.includes("/high/")).length, 0);
  assert.equal(r.responses.filter((x) => x.path.endsWith("/segment-784.ts")).length, 1, "Recovery must not reload the video-only prefix");
  assert.equal(r.pageErrors.length, 0);
  for (const response of r.responses) assert.equal(response.sha256, r.inputs.find((i) => response.path.endsWith(`segment-${i.sequence}.ts`)).sha256);
  assert.equal(p.fatalErrors, 1);
  assert.equal(p.nativeErrors.length, 0);
  assert.equal(p.mediaRecovery.outcome, "recovered");
  assert.equal(p.mediaRecovery.records[0].requestedPosition, 2);
  assert.ok(f.frames > p.mediaRecovery.records[0].framesAfterReattach);
  assert.ok(f.audioDecodedBytes > 0, "Chrome must decode actual AAC bytes after recovery");
  assert.ok(f.transitions.some((t) => t.kind === "source-buffer-created" && t.mime.startsWith("audio/")));
  assert.ok(p.currentTime > 2.25);
  assert.ok(f.events.some((e) => e.event === "hlsFragBuffered" && e.frag?.sequence === 785));
  r.oneShotInvariantChecksPassed = true;
  r.outcome = p.mediaRecovery.outcome;
  r.lowOnlyRecoveryMeasured = { outcome: p.mediaRecovery.outcome, frames: f.frames, finalTime: p.currentTime, secondFragmentBuffered: f.events.some((e) => e.event === "hlsFragBuffered" && e.frag?.sequence === 785), highMediaRequests: r.responses.filter((x) => x.path.includes("/high/")).length };
  await page.evaluate(() => window.relaySwarmDemo.stop());
} catch (e) {
  r.failures.push({ name: e.name, message: e.message });
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  if (page && !r.final) r.final = await page.evaluate(() => ({ report: window.relaySwarmDemo?.report(), events: window.__replayHlsEvents })).catch(() => null);
  const closeOwned = async (name, resource) => {
    if (!resource) { r.cleanup[name] = "not-started"; return true; }
    try { await resource.close(); r.cleanup[name] = true; return true; }
    catch (error) {
      r.cleanup[name] = false;
      r.failures.push({ stage: "cleanup", resource: name, name: error.name });
      process.exitCode = 1; return false;
    }
  };
  const browserClosed = await closeOwned("browserClosed", browser);
  const demoClosed = await closeOwned("demoHTTPAndRelayClosed", demo);
  if (browserClosed && demoClosed) {
    try {
      await rm(work, { recursive: true, force: true });
      r.cleanup.profileAndMediaScratchRemoved = true;
    } catch (error) {
      r.cleanup.profileAndMediaScratchRemoved = false;
      r.failures.push({ stage: "cleanup", resource: "scratch", name: error.name });
      process.exitCode = 1;
    }
  } else r.cleanup.profileAndMediaScratchRemoved = false;
  if (expired) process.exitCode = 1;
  r.expired = expired;
  r.endedAt = (/* @__PURE__ */ new Date()).toISOString();
  await writeFile(`${dir}/receipt.json`, JSON.stringify(r, null, 2) + "\n");
  console.log(JSON.stringify({ outcome: r.outcome, oneShotInvariantChecksPassed: r.oneShotInvariantChecksPassed, failures: r.failures, cleanup: r.cleanup, endedAt: r.endedAt }));
}
