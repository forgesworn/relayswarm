#!/usr/bin/env node
// Real desktop browser acceptance, with isolated WebDriver sessions. No personal
// browser profiles, permission grants, fake media devices or global driver install.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { createServer } from "node:net";

const run = promisify(execFile);
const { values } = parseArgs({ options: {
  browser: { type: "string" }, driver: { type: "string" }, "download-driver": { type: "boolean", default: false },
  "browser-binary": { type: "string" }, url: { type: "string", default: "https://relayswarm.forgesworn.dev" },
  "expected-client-sha256": { type: "string" }, revision: { type: "string" },
  probe: { type: "boolean", default: false }, "results-dir": { type: "string" },
  "journey-ms": { type: "string", default: "180000" }, "reset-allowance": { type: "boolean", default: false },
} });
assert.ok(["firefox", "safari"].includes(values.browser), "Supply --browser firefox or safari.");
const origin = new URL(values.url), journeyMs = Number(values["journey-ms"]);
assert.ok(origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash,
  "Use a credential-free public HTTPS origin.");
assert.ok(Number.isSafeInteger(journeyMs) && journeyMs >= 30000 && journeyMs <= 300000, "Journey budget must be 30-300 seconds.");
if (values["expected-client-sha256"]) assert.match(values["expected-client-sha256"], /^[a-f0-9]{64}$/u);
if (values.revision) assert.match(values.revision, /^[a-f0-9]{7,40}$/u);
if (!values.probe) assert.ok(values["expected-client-sha256"], "Acceptance requires the expected deployed client SHA-256; use --probe for capabilities only.");
assert.ok(!values["download-driver"] || values.browser === "firefox", "Download is supported only for the pinned Mozilla driver.");
const results = resolve(values["results-dir"] ?? `artifacts/webdriver-${values.browser}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (message) => console.error(`[webdriver-${values.browser}] ${message}`);
const deadline = Date.now() + journeyMs;
let scratch, driverProcess, sessionId, endpoint, driverOutput = "", journeyStarted = false;
let exited = false, driverExit;
const receipt = { v: 1, kind: "relayswarm-real-desktop-webdriver", browser: values.browser, target: origin.origin,
  at: new Date().toISOString(), probe: values.probe, ok: false, checkpoints: [], playbackSamples: [], screenshots: [], interactions: [], failures: [], manualSteps: [],
  scope: { physicalAndroid: false, emulator: false, realInstalledBrowser: true, freshFirefoxProfile: values.browser === "firefox", isolatedSafariAutomationWindow: values.browser === "safari",
    targetScope: "new public RelaySwarm automation tab only", personalProfiles: "never selected", personalPages: "never enumerated or inspected", permissionOverrides: false,
    fakeMedia: false, systemSettingsChanged: false, peerAddresses: "not requested; IP-like diagnostic text redacted", qualitySelection: "DOM select/change automation; no native picker usability claim" },
  selectedCandidateTypes: {}, cleanup: {} };

function redacted(input, key) {
  if (typeof input === "string") return ["userAgent", "browserVersion", "driverVersion"].includes(key) ? input
    : input.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[redacted-ip]")
      .replace(/\b(?:[a-f\d]{1,4}:){3,}[a-f\d:]*\b/giu, "[redacted-ip]");
  if (Array.isArray(input)) return input.map((item) => redacted(item));
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([name, item]) => [name, redacted(item, name)]));
  return input;
}
async function boundedBody(response, maximum = 4 * 1024 * 1024) {
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.byteLength; if (length > maximum) { await response.body.cancel().catch(() => {}); throw Error("HTTP response exceeds inspection bound."); } chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
async function command(method, path, body, timeout = 10000) {
  const response = await fetch(`${endpoint}${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), signal: AbortSignal.timeout(timeout) });
  const data = JSON.parse((await boundedBody(response)).toString("utf8"));
  if (!response.ok || data.value?.error) {
    const error = new Error(`${data.value?.error ?? response.status}: ${String(data.value?.message ?? "WebDriver command failed").slice(0, 1600)}`);
    error.webdriver = data.value?.error; throw error;
  }
  return data.value;
}
async function ownTab() {
  const current = await command("GET", `/session/${sessionId}/url`);
  assert.equal(new URL(current).origin, origin.origin, "The automation tab left RelaySwarm; stop without inspecting another page.");
}
async function evaluate(script, args = []) {
  await ownTab(); return command("POST", `/session/${sessionId}/execute/sync`, { script: `return (${script});`, args });
}
async function report() { return evaluate("window.relaySwarmDemo?.report() ?? null"); }
async function until(check, message, limit = 30000) {
  const end = Math.min(deadline, Date.now() + limit);
  while (Date.now() < end) { if (await check()) return; await pause(400); }
  throw Error(message);
}
async function screenshot(name) {
  await ownTab(); const bytes = await command("GET", `/session/${sessionId}/screenshot`);
  assert.ok(typeof bytes === "string" && bytes.length <= 8 * 1024 * 1024, "Screenshot exceeds its bound.");
  const file = `${name}.png`; await writeFile(join(results, file), Buffer.from(bytes, "base64"));
  receipt.screenshots.push({ name, file, scope: "own public RelaySwarm automation viewport", at: new Date().toISOString() });
}
async function click(id) {
  const layout = await evaluate(`(()=>{const e=document.getElementById(arguments[0]);if(!e)throw Error('Control unavailable');e.scrollIntoView({behavior:'instant',block:'center'});const r=e.getBoundingClientRect();return{rect:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},disabled:e.disabled===true};})()`, [id]);
  assert.ok(!layout.disabled && layout.rect.width > 0 && layout.rect.height > 0, `${id} is disabled or invisible.`);
  const element = await command("POST", `/session/${sessionId}/element`, { using: "css selector", value: `#${id}` });
  const elementId = element["element-6066-11e4-a52e-4f735466cecf"];
  assert.ok(elementId, "WebDriver did not return an element reference.");
  await command("POST", `/session/${sessionId}/element/${elementId}/click`, {});
  receipt.interactions.push({ control: id, method: "WebDriver element click with browser interactability checks", ...layout, at: new Date().toISOString() });
}
async function select(id, value) {
  await evaluate(`(()=>{const e=document.getElementById(arguments[0]);e.value=arguments[1];e.dispatchEvent(new Event('change',{bubbles:true}));})()`, [id, String(value)]);
}
async function checkpoint(name) {
  const state = await report(); receipt.checkpoints.push({ name, at: new Date().toISOString(), receipt: redacted(state) });
  for (const [types, count] of Object.entries(state?.current?.metrics?.peers?.candidatePairs ?? {})) receipt.selectedCandidateTypes[types] = Math.max(receipt.selectedCandidateTypes[types] ?? 0, count);
  log(name);
}
async function playbackSample(name) {
  const state = () => evaluate(`(()=>{const v=window.relaySwarmDemo.media;return{currentTime:v.currentTime,paused:v.paused,readyState:v.readyState,videoWidth:v.videoWidth,videoHeight:v.videoHeight,visibility:document.visibilityState,totalFrames:v.getVideoPlaybackQuality?.().totalVideoFrames??v.webkitDecodedFrameCount??null};})()`);
  const before = await state(); await pause(1800); const after = await state();
  assert.equal(after.paused, false); assert.equal(after.visibility, "visible");
  assert.ok(after.currentTime > before.currentTime + 0.5 && after.videoWidth > 0 && after.videoHeight > 0, "Real browser video did not advance.");
  assert.ok(Number.isFinite(after.totalFrames) && after.totalFrames > before.totalFrames, "Real browser decoded-frame counter did not advance.");
  receipt.playbackSamples.push({ name, before, after }); await screenshot(`video-${name}`);
}
async function freePort() {
  const server = createServer(); await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
async function acquireDriver() {
  // Digest is published by Mozilla's GitHub release API. Keep the pinned digest
  // too, so neither a renamed download nor an unexpected release is executed.
  const version = "0.37.1", name = "geckodriver-v0.37.1-macos-aarch64.tar.gz";
  const expected = "d02b3f7003f999caf90974a2ef5da0286c05d01cee19112c86846d759fdba4f5";
  assert.equal(process.platform, "darwin", "Pinned download supports macOS only.");
  const api = await fetch(`https://api.github.com/repos/mozilla/geckodriver/releases/tags/v${version}`, { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15000) });
  assert.equal(api.status, 200, "Official Mozilla release metadata is unavailable.");
  const metadata = JSON.parse((await boundedBody(api, 1024 * 1024)).toString("utf8"));
  const asset = metadata.assets?.find((item) => item.name === name);
  assert.equal(asset?.digest, `sha256:${expected}`, "Official release checksum changed; refuse execution.");
  const url = `https://github.com/mozilla/geckodriver/releases/download/v${version}/${name}`;
  assert.equal(asset.browser_download_url, url);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); assert.equal(response.status, 200);
  const archive = await boundedBody(response, 8 * 1024 * 1024);
  assert.equal(createHash("sha256").update(archive).digest("hex"), expected, "Official driver archive checksum differs.");
  const file = join(scratch, name); await writeFile(file, archive, { mode: 0o600 });
  const { stdout } = await run("tar", ["-tzf", file], { timeout: 5000 });
  assert.deepEqual(stdout.trim().split("\n"), ["geckodriver"], "Driver archive contains unexpected paths.");
  await run("tar", ["-xzf", file, "-C", scratch, "geckodriver"], { timeout: 5000 });
  const path = join(scratch, "geckodriver"); assert.ok((await stat(path)).isFile()); await chmod(path, 0o700);
  receipt.driverDownload = { version, source: url, archiveSha256: expected, officialDigestVerified: true, globalInstall: false };
  return path;
}
async function startDriver() {
  scratch = await mkdtemp(join(tmpdir(), `relayswarm-webdriver-${values.browser}-`));
  await chmod(scratch, 0o700);
  const port = await freePort(); endpoint = `http://127.0.0.1:${port}`;
  const driver = values.driver ?? (values.browser === "safari" ? "/usr/bin/safaridriver" : values["download-driver"] ? await acquireDriver() : "geckodriver");
  const version = await run(driver, ["--version"], { timeout: 5000 }); receipt.driverVersion = version.stdout.trim().slice(0, 512);
  const args = values.browser === "firefox" ? ["--host", "127.0.0.1", "--port", String(port), "--profile-root", scratch, "--log", "error"] : ["--port", String(port)];
  // Firefox and its driver share our new process group, so failed session
  // creation cannot strand a browser process. Safari itself is a shared app;
  // its automation window is closed only through our session's DELETE.
  driverProcess = spawn(driver, args, { detached: values.browser === "firefox", stdio: ["ignore", "pipe", "pipe"] });
  driverProcess.on("error", (error) => { driverOutput = error.message; exited = true; });
  driverProcess.once("exit", (code, signal) => { exited = true; driverExit = { code, signal }; });
  for (const source of [driverProcess.stdout, driverProcess.stderr]) source.on("data", (data) => { driverOutput = `${driverOutput}${data}`.slice(-8192); });
  await until(async () => {
    if (exited) throw Error(`Owned WebDriver exited before readiness: ${driverOutput.slice(0, 1000)}`);
    try { receipt.driverStatus = await command("GET", "/status", undefined, 800); return true; } catch { return false; }
  }, "Owned WebDriver did not become ready.", 6000);
  const options = values.browser === "firefox" ? { browserName: "firefox", "moz:firefoxOptions": { ...(values["browser-binary"] ? { binary: resolve(values["browser-binary"]) } : {}), args: ["-no-remote"] } } : { browserName: "safari" };
  // Safari's older driver returned true when explicitly given false. Omit this
  // optional capability there, then still require the actual response to be false.
  const certificateCapability = values.browser === "safari" ? {} : { acceptInsecureCerts: false };
  receipt.requestedCertificateCapability = values.browser === "safari" ? "omitted" : false;
  const session = await command("POST", "/session", { capabilities: { alwaysMatch: { ...options, ...certificateCapability } } }, 18000);
  sessionId = session.sessionId; assert.ok(sessionId);
  receipt.capabilities = { browserName: session.capabilities?.browserName, browserVersion: session.capabilities?.browserVersion,
    platformName: session.capabilities?.platformName, acceptInsecureCerts: session.capabilities?.acceptInsecureCerts ?? null,
    setWindowRect: session.capabilities?.setWindowRect === true };
  assert.equal(receipt.capabilities.acceptInsecureCerts, false, "Browser must verify public TLS normally.");
  await command("POST", `/session/${sessionId}/timeouts`, { script: 8000, pageLoad: 15000, implicit: 0 });
  await command("POST", `/session/${sessionId}/url`, { url: origin.href }, 18000);
}

await mkdir(results, { recursive: true });
try {
  if (!values.probe) {
    const response = await fetch(new URL("/client.js", origin), { cache: "no-store", signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); const bytes = await boundedBody(response, 2 * 1024 * 1024);
    const clientSha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(clientSha256, values["expected-client-sha256"], "Public client differs from requested candidate; no browser was started.");
    receipt.deployment = { suppliedRevision: values.revision ?? null, clientSha256, expectedClientHashVerified: true };
  }
  await startDriver();
  await until(async () => await evaluate("window.relaySwarmDemo?.ready()===true && !document.getElementById('start').disabled"), "Hosted RelaySwarm player is not ready.", 15000);
  receipt.environment = await evaluate("({userAgent:navigator.userAgent,secureContext:isSecureContext,webdriver:navigator.webdriver===true,visibility:document.visibilityState,mse:typeof MediaSource!=='undefined',webrtc:typeof RTCPeerConnection!=='undefined',webLocks:!!navigator.locks})");
  assert.equal(receipt.environment.secureContext, true); assert.equal(receipt.environment.visibility, "visible");
  assert.equal(await evaluate("document.getElementById('upload').checked"), false);
  assert.equal(await evaluate("document.getElementById('telemetry').checked"), false);
  await checkpoint("isolated-public-tab-consent-off"); await screenshot("public-readiness");
  if (values.probe) receipt.ok = true;
  else {
    const initialSpent = (await report()).uploadBudget.spent;
    journeyStarted = true; await select("mode", "peer-first"); await click("start");
    await until(async () => (await report()).player.firstPlayingAtMs !== null, "Real browser playback did not start.");
    await playbackSample("initial-playback");
    const native = (await report()).player.engine === "native HLS";
    receipt.peerCapability = native ? "native HLS origin fallback; peer loader unavailable" : "hls.js peer path";
    receipt.acceptanceScope = native ? "native origin playback and seek only" : "verified receive/upload, durable quota, quality, seek and kill";
    if (native) receipt.unavailableJourneys = ["peer receive", "peer upload", "manual hls.js rendition selection", "peer-to-origin kill", "upload reservation across reload"];
    if (!native) {
      await until(async () => (await report()).totals.peerFirstBytes > 0, "No verified peer download. Keep authorised external desktop contributors active; no peer proof is inferred from playback.", 45000);
      assert.equal((await report()).totals.uploaded, 0); await checkpoint("receive-only-verified-peer-payload");
      const qualities = await evaluate("Array.from(document.getElementById('quality').options).map(o=>o.value).filter(v=>Number(v)>=0)");
      assert.ok(qualities.length >= 2, "Two actual published renditions are needed.");
      for (const quality of [qualities.at(-1), qualities[0]]) {
        const at = (await report()).durationMs; await select("quality", quality);
        await until(async () => (await report()).player.fragments.some((f) => f.atMs > at && f.level === Number(quality) && ["video", "main"].includes(f.mediaType)), `No actual video fragment after selecting quality ${quality}.`, 20000);
      }
    }
    await evaluate("(()=>{const v=window.relaySwarmDemo.media;if(v.buffered.length){v.currentTime=Math.max(v.buffered.start(0),Math.min(v.buffered.end(v.buffered.length-1)-1,v.currentTime-3));}})()");
    await until(async () => (await report()).player.seekRecoveryMs.length > 0, "Real browser seek did not recover.");
    await playbackSample("receive-quality-seek"); await checkpoint("real-video-quality-and-seek");
    if (!native) {
      const beforeUpload = (await report()).totals.uploaded;
      await click("upload"); assert.equal(await evaluate("document.getElementById('upload').checked"), true); await click("start");
      await until(async () => (await report()).totals.uploaded > beforeUpload, "No real upload after explicit opt-in. Keep an authorised external receive-only browser requesting the same quality.", 45000);
      const beforeReload = await report(); await checkpoint("explicit-upload-durable-reservation");
      await command("POST", `/session/${sessionId}/refresh`, {}, 18000);
      await until(async () => await evaluate("window.relaySwarmDemo?.ready()===true && !document.getElementById('start').disabled"), "Full reload did not restore readiness.");
      assert.equal(await evaluate("document.getElementById('upload').checked"), false);
      assert.ok((await report()).uploadBudget.spent >= beforeReload.uploadBudget.spent);
      await checkpoint("reload-retains-usage-without-consent"); await select("mode", "peer-first"); await click("start");
      await until(async () => (await report()).player.firstPlayingAtMs !== null, "Playback did not restart after reload.");
    }
    // Native HLS already has origin mode and a disabled peer kill control. Its
    // healthy fallback does not establish that the peer-to-origin action works.
    if (!native) await click("kill");
    await until(async () => (await report()).current?.mode === "off" && (await report()).loaderRestored, "Origin-only playback did not restore loader.");
    const killed = await report(); assert.equal(killed.current.metrics.peers.connected, 0); assert.equal(killed.current.metrics.serving, false);
    assert.equal(killed.player.fatalErrors, 0); assert.equal(killed.player.nativeErrors.length, 0);
    await playbackSample(native ? "native-origin-fallback" : "origin-only-kill");
    await checkpoint(native ? "native-origin-fallback" : "origin-only-kill");
    if (values["reset-allowance"]) {
      assert.equal(initialSpent, 0, "Do not erase pre-existing quota usage."); await click("reset-allowance");
      await until(async () => (await report()).uploadBudget.spent === 0, "Explicit allowance reset did not finish.");
      assert.equal(await evaluate("document.getElementById('upload').checked"), false); await checkpoint("explicit-quota-reset");
    }
    receipt.ok = true;
  }
} catch (error) {
  receipt.failures.push(String(error.message).slice(0, 1800));
  if (values.browser === "safari" && /remote automation|Allow Remote Automation|enable.*automation|not enabled/iu.test(error.message)) {
    receipt.automationSetting = "disabled; unchanged";
    receipt.manualSteps.push("In Safari, open Develop → Developer Settings and enable Allow remote automation if you want this acceptance run. This harness does not change the setting or run safaridriver --enable.");
  }
  log(error.message);
} finally {
  if (sessionId) {
    if (journeyStarted) receipt.finalReport = await report().then(redacted).catch(() => null);
    try { if (journeyStarted) await evaluate("(()=>{const u=document.getElementById('upload');if(u)u.checked=false;window.relaySwarmDemo?.stop();})()"); } catch { /* Scope guard prevents inspection outside our tab. */ }
    try { await command("DELETE", `/session/${sessionId}`, undefined, 10000); receipt.cleanup.sessionDeleted = true; }
    catch (error) { receipt.cleanup.sessionDeleted = false; receipt.cleanup.sessionError = String(error.message).slice(0, 512); receipt.ok = false; }
  }
  if (driverProcess && !exited) {
    driverProcess.kill("SIGTERM"); await Promise.race([new Promise((done) => driverProcess.once("exit", done)), pause(2500)]);
    if (!exited) { driverProcess.kill("SIGKILL"); await Promise.race([new Promise((done) => driverProcess.once("exit", done)), pause(1500)]); }
  }
  if (values.browser === "firefox" && driverProcess?.pid) {
    const alive = () => { try { process.kill(-driverProcess.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } };
    if (alive()) {
      process.kill(-driverProcess.pid, "SIGTERM"); await pause(500);
      if (alive()) process.kill(-driverProcess.pid, "SIGKILL");
      const end = Date.now() + 2000;
      while (alive() && Date.now() < end) await pause(100);
    }
    receipt.cleanup.firefoxProcessGroupStopped = !alive();
    if (!receipt.cleanup.firefoxProcessGroupStopped) { receipt.ok = false; receipt.failures.push("Owned Firefox process group remains; scratch preserved for inspection."); }
  }
  receipt.cleanup.driverStopped = !driverProcess || exited; receipt.cleanup.driverExit = driverExit ?? null;
  if (!receipt.cleanup.driverStopped) { receipt.ok = false; receipt.failures.push("Owned driver did not terminate; scratch preserved for inspection."); }
  // On failed session deletion Firefox might survive its driver. Preserve its
  // profile then; never blindly remove a live browser's state or kill all Firefox.
  if (scratch && receipt.cleanup.driverStopped && receipt.cleanup.firefoxProcessGroupStopped !== false && (!sessionId || receipt.cleanup.sessionDeleted)) {
    await rm(scratch, { recursive: true, force: true }); receipt.cleanup.scratchRemoved = true;
  } else if (scratch) { receipt.cleanup.scratchRemoved = false; receipt.cleanup.scratch = scratch; }
  receipt.recordedAt = new Date().toISOString();
  await writeFile(join(results, "webdriver-browser.json"), `${JSON.stringify(redacted(receipt), null, 2)}\n`);
}
console.log(JSON.stringify({ ok: receipt.ok, browser: values.browser, probe: values.probe, capabilities: receipt.capabilities, failures: receipt.failures, manualSteps: receipt.manualSteps, cleanup: receipt.cleanup, receipt: join(results, "webdriver-browser.json") }, null, 2));
process.exitCode = receipt.ok ? 0 : 1;
