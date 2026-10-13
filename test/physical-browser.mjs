#!/usr/bin/env node
// An existing physical Android browser tab only. No permission grants, fake
// media devices, browser launch, private pages, cookies or network changes.
import { parseArgs, promisify } from "node:util";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import WebSocket from "ws";

const command = promisify(execFile);
const { values } = parseArgs({ options: {
  "expected-client-sha256": { type: "string" }, revision: { type: "string" },
  url: { type: "string", default: "https://relayswarm.forgesworn.dev" }, cdp: { type: "string", default: "http://127.0.0.1:19329" },
  "ssh-host": { type: "string", ...(process.env.RELAYSWARM_ANDROID_SSH_HOST ? { default: process.env.RELAYSWARM_ANDROID_SSH_HOST } : {}) },
  adb: { type: "string", default: process.env.RELAYSWARM_ADB || "adb" },
  serial: { type: "string", default: process.env.RELAYSWARM_ANDROID_SERIAL }, "browser-package": { type: "string", default: "app.vanadium.browser" },
  "device-port": { type: "string", default: "61330" },
  "results-dir": { type: "string", default: "artifacts/physical-android" }, probe: { type: "boolean", default: false },
  "background-journey": { type: "boolean", default: false }, "reset-allowance": { type: "boolean", default: false }, "capture-viewport": { type: "boolean", default: false }, "journey-ms": { type: "string", default: "180000" },
} });
const target = new URL(values.url), cdp = new URL(values.cdp), journeyMs = Number(values["journey-ms"]), devicePort = Number(values["device-port"]);
assert.ok(target.protocol === "https:" && !target.username && !target.password && target.pathname === "/" && !target.search && !target.hash, "Use a credential-free public HTTPS origin.");
assert.ok(cdp.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(cdp.hostname) && !cdp.username && !cdp.password, "Use the authorised loopback CDP tunnel.");
assert.ok(values.serial, "Supply --serial or RELAYSWARM_ANDROID_SERIAL for the authorised physical device.");
assert.ok(typeof values["ssh-host"] === "string" && /^[a-zA-Z0-9._-]+$/u.test(values["ssh-host"])
  && /^[a-zA-Z0-9]+$/u.test(values.serial) && /^[a-zA-Z0-9_.]+$/u.test(values["browser-package"]), "Supply a valid --ssh-host or RELAYSWARM_ANDROID_SSH_HOST and device arguments.");
assert.ok(Number.isSafeInteger(journeyMs) && journeyMs >= 30000 && journeyMs <= 300000, "Journey budget must be 30-300 seconds.");
if (values["expected-client-sha256"]) assert.match(values["expected-client-sha256"], /^[a-f0-9]{64}$/u);
if (values.revision) assert.match(values.revision, /^[a-f0-9]{7,40}$/u);
assert.ok(Number.isSafeInteger(devicePort) && devicePort > 0 && devicePort <= 65535, "Invalid authorised Android CDP port.");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const log = (message) => console.error(`[physical-android] ${message}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const deadline = Date.now() + journeyMs;
let peerSocket, requestId = 0, journeyStarted = false;
const pending = new Map();
const receipt = { v: 1, kind: "relayswarm-physical-android-browser", at: new Date().toISOString(), target: target.origin, ok: false, probe: values.probe,
  scope: { physicalDevice: true, emulator: false, adbSerial: values.serial, browserPackage: values["browser-package"], fakeMedia: false, permissionOverrides: false,
    targetScope: "existing public RelaySwarm tab only", networkChanges: false, peerAddresses: "never requested; IP-like diagnostic text redacted", sameNetworkClaim: "not inferred from address masking", journeyMs, touchEvidence: "CDP-generated touch events delivered to the real Android target; no human usability claim", qualitySelection: "DOM select/change automation; native Android picker usability is not tested" },
  interactions: [], screenshots: [], playbackSamples: [], checkpoints: [], failures: [], manualSteps: [], selectedCandidateTypes: {}, permissionRequests: "none granted by this harness" };
async function adb(args, timeout = 8000) {
  const remote = `${quote(values.adb)} -s ${quote(values.serial)} ${args.map(quote).join(" ")}`;
  const { stdout } = await command("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", values["ssh-host"], remote], { timeout, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}
async function foreground() {
  const raw = await adb(["shell", "dumpsys", "activity", "activities"]);
  return raw.match(/topResumedActivity=.*?\su\d+\s+([^\s}]+)/u)?.[1] ?? null;
}
async function deviceSnapshot() {
  const [battery, connectivity, power] = await Promise.all([adb(["shell", "dumpsys", "battery"]), adb(["shell", "dumpsys", "connectivity"]), adb(["shell", "dumpsys", "power"])]);
  const number = (name) => Number(battery.match(new RegExp(`^\\s*${name}:\\s*(\\d+)`, "mu"))?.[1] ?? NaN);
  const activeId = connectivity.match(/Active default network:\s*(\d+)/u)?.[1];
  const active = connectivity.split("\n").find((line) => activeId && line.includes(`network{${activeId}}`)) ?? "";
  const transport = /Transports:\s*WIFI/u.test(active) ? "Wi-Fi" : /Transports:\s*CELLULAR/u.test(active) ? "cellular" : "unknown";
  return { at: new Date().toISOString(), display: { wakefulness: power.match(/mWakefulness=(\w+)/u)?.[1] ?? null, state: power.match(/Display Power: state=(\w+)/u)?.[1] ?? null }, battery: { levelPercent: number("level"), scale: number("scale"), temperatureC: number("temperature") / 10, status: number("status"),
    powered: /(?:AC|USB|Wireless|Dock) powered: true/u.test(battery) }, network: { transport, metered: transport === "unknown" ? null : !active.includes("NOT_METERED"), labelsSource: "Android active default network; no SSID, address or carrier recorded" } };
}
function redacted(value) {
  // Browser error text can contain candidate addresses. No SDP/getStats address
  // fields are requested, and accidental IP-like diagnostic text is scrubbed.
  const clean = (input, field) => {
    if (typeof input === "string" && ["userAgent", "browserVersion"].includes(field)) return input;
    if (typeof input === "string") return input.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[redacted-ip]").replace(/\b(?:[a-f\d]{1,4}:){3,}[a-f\d:]*\b/giu, "[redacted-ip]").replace(/(?<![a-z\d])(?=[a-f\d:]*::)(?:[a-f\d]{0,4}:){2,}[a-f\d:.]*(?![a-z\d])/giu, "[redacted-ip]");
    if (Array.isArray(input)) return input.map(clean);
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([name, item]) => [name, clean(item, name)]));
    return input;
  };
  return clean(value);
}
async function cdpCommand(method, params = {}, timeout = 8000) {
  if (!peerSocket || peerSocket.readyState !== WebSocket.OPEN) throw new Error("Physical browser debugging connection is unavailable.");
  const id = ++requestId;
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Physical browser ${method} timed out.`)); }, timeout);
    pending.set(id, { done: (result) => { clearTimeout(timer); done(result); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    peerSocket.send(JSON.stringify({ id, method, params }), (error) => { if (error) { pending.delete(id); clearTimeout(timer); reject(error); } });
  });
}
async function evaluate(expression) {
  const result = await cdpCommand("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error("RelaySwarm page evaluation failed.");
  return result.result?.value;
}
async function assertOurTab() { assert.equal(new URL(await evaluate("location.href")).origin, target.origin, "The selected tab left RelaySwarm; stop without inspecting another page."); }
async function report() { await assertOurTab(); return evaluate("window.relaySwarmDemo?.report() ?? null"); }
async function until(check, message, limit = 30000) {
  const end = Math.min(deadline, Date.now() + limit);
  while (Date.now() < end) { if (await check()) return; await pause(350); }
  throw new Error(message);
}
async function screenshot(name) {
  await assertOurTab();
  const result = await cdpCommand("Page.captureScreenshot", { format: "jpeg", quality: 75, captureBeyondViewport: false });
  const file = `${name}.jpg`;
  await writeFile(join(values["results-dir"], file), Buffer.from(result.data, "base64"));
  receipt.screenshots.push({ name, file, scope: "selected public RelaySwarm page viewport only", at: new Date().toISOString() });
}
async function controlLayout(id, scroll = false) {
  await assertOurTab();
  return evaluate(`(async()=>{
    const e=document.getElementById(${JSON.stringify(id)});if(!e)throw Error('Control unavailable');
    if(${scroll})e.scrollIntoView({behavior:'instant',block:'center',inline:'center'});
    await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
    const r=e.getBoundingClientRect(),v=visualViewport;
    const viewport={left:v?.offsetLeft??0,top:v?.offsetTop??0,width:v?.width??innerWidth,height:v?.height??innerHeight,scale:v?.scale??1,devicePixelRatio};
    const left=Math.max(r.left,viewport.left),top=Math.max(r.top,viewport.top),right=Math.min(r.right,viewport.left+viewport.width),bottom=Math.min(r.bottom,viewport.top+viewport.height);
    const visible=right>left&&bottom>top,x=(left+right)/2,y=(top+bottom)/2,hit=visible?document.elementFromPoint(x,y):null;
    return{target:{x:r.x,y:r.y,width:r.width,height:r.height},viewport,intersection:{left,top,right,bottom},point:{x,y},visible,
      fullyVisible:r.left>=viewport.left&&r.top>=viewport.top&&r.right<=viewport.left+viewport.width&&r.bottom<=viewport.top+viewport.height,
      hitTarget:!!hit&&(e===hit||e.contains(hit)||!!hit.closest('label')?.contains(e)),disabled:e.disabled===true,checked:typeof e.checked==='boolean'?e.checked:null};
  })()`);
}
async function tap(id) {
  const layout = await controlLayout(id, true);
  assert.ok(layout.visible && layout.hitTarget && !layout.disabled, `Physical ${id} control is clipped, occluded or disabled; no bypass click was attempted.`);
  receipt.interactions.push({ control: id, at: new Date().toISOString(), method: "Input.dispatchTouchEvent", ...layout });
  if (!receipt.screenshots.some((entry) => entry.name === `touch-${id}`)) await screenshot(`touch-${id}`);
  await cdpCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: layout.point.x, y: layout.point.y }] });
  await cdpCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pause(150);
}
async function playbackSample(name) {
  await assertOurTab();
  const sample = await evaluate(`(async()=>{
    const video=window.relaySwarmDemo.media;video.scrollIntoView({behavior:'instant',block:'center'});
    const state=()=>({currentTime:video.currentTime,paused:video.paused,readyState:video.readyState,videoWidth:video.videoWidth,videoHeight:video.videoHeight,
      visibility:document.visibilityState,decodedFrames:video.webkitDecodedFrameCount??null,totalFrames:video.getVideoPlaybackQuality?.().totalVideoFrames??null});
    const frame=()=>new Promise((done,reject)=>{
      if(!video.requestVideoFrameCallback){done({method:'playbackQuality',...state()});return;}
      let callback;const timer=setTimeout(()=>{video.cancelVideoFrameCallback?.(callback);reject(Error('No presented video frame'));},5000);
      callback=video.requestVideoFrameCallback((_now,metadata)=>{clearTimeout(timer);done({method:'requestVideoFrameCallback',presentedFrames:metadata.presentedFrames,mediaTime:metadata.mediaTime,width:metadata.width,height:metadata.height,...state()});});
    });
    const before=await frame();await new Promise(done=>setTimeout(done,1200));const after=await frame();return{before,after};
  })()`);
  assert.equal(sample.after.visibility, "visible"); assert.equal(sample.after.paused, false);
  assert.ok(sample.after.currentTime > sample.before.currentTime + 0.5, "Physical video clock did not progress.");
  if (sample.after.method === "requestVideoFrameCallback") assert.ok(sample.after.presentedFrames > sample.before.presentedFrames, "No new video frames were presented.");
  else assert.ok(sample.after.totalFrames > sample.before.totalFrames, "Video frame counter did not progress.");
  receipt.playbackSamples.push({ name, at: new Date().toISOString(), ...sample });
  await screenshot(`video-${name}`);
  return sample;
}
async function select(id, value) {
  await assertOurTab();
  await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)});e.value=${JSON.stringify(String(value))};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function checkpoint(name) {
  const state = await report();
  receipt.checkpoints.push({ name, at: new Date().toISOString(), receipt: redacted(state) });
  for (const [types, count] of Object.entries(state?.current?.metrics?.peers?.candidatePairs ?? {})) receipt.selectedCandidateTypes[types] = Math.max(receipt.selectedCandidateTypes[types] ?? 0, count);
  log(name);
}
async function connectExistingTab() {
  const response = await fetch(new URL("/json/list", cdp), { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Physical browser target discovery failed.");
  const text = await response.text(); if (text.length > 512000) throw new Error("Physical browser target discovery exceeds its bound.");
  const targets = JSON.parse(text);
  const own = targets.find((entry) => { try { return entry.type === "page" && new URL(entry.url).origin === target.origin; } catch { return false; } });
  if (!own?.webSocketDebuggerUrl) throw new Error("No existing RelaySwarm tab has an available debugging connection.");
  const endpoint = new URL(own.webSocketDebuggerUrl); endpoint.hostname = cdp.hostname; endpoint.port = cdp.port;
  peerSocket = new WebSocket(endpoint.href, { maxPayload: 2 * 1024 * 1024 });
  peerSocket.on("message", (buffer) => {
    const message = JSON.parse(buffer.toString("utf8")); if (!message.id) return;
    const request = pending.get(message.id); if (!request) return; pending.delete(message.id);
    if (message.error) request.reject(new Error(`CDP command refused: ${message.error.code}`)); else request.done(message.result);
  });
  peerSocket.on("close", () => { for (const request of pending.values()) request.reject(new Error("Physical browser debugging connection closed.")); pending.clear(); });
  await new Promise((done, reject) => { const timer = setTimeout(() => reject(new Error("Physical browser debugging connection timed out.")), 5000); peerSocket.once("open", () => { clearTimeout(timer); done(); }); peerSocket.once("error", (error) => { clearTimeout(timer); reject(error); }); });
  await assertOurTab(); await cdpCommand("Page.enable");
}
await mkdir(values["results-dir"], { recursive: true });
try {
  receipt.before = await deviceSnapshot();
  receipt.device = { model: await adb(["shell", "getprop", "ro.product.model"]), androidRelease: await adb(["shell", "getprop", "ro.build.version.release"]), qemu: await adb(["shell", "getprop", "ro.kernel.qemu"]) };
  receipt.device.browserVersion = (await adb(["shell", "dumpsys", "package", values["browser-package"]])).match(/versionName=(\S+)/u)?.[1] ?? null;
  assert.notEqual(receipt.device.qemu, "1", "This harness refuses Android emulator acceptance.");
  const forwards = await adb(["forward", "--list"]);
  assert.ok(forwards.split("\n").some((line) => line.trim() === `${values.serial} tcp:${devicePort} localabstract:chrome_devtools_remote`), "The authorised physical-device CDP forward is missing.");
  receipt.device.cdpForwardVerified = true;
  receipt.preflight = { foreground: await foreground() };
  if (!receipt.preflight.foreground?.startsWith(`${values["browser-package"]}/`)) {
    receipt.manualSteps.push(`Bring the existing ${target.origin} tab to the foreground in Vanadium on the Pixel when other device fixtures have stopped. No unrelated app was interrupted.`);
    throw new Error("Vanadium is not foreground; physical testing is waiting for device availability.");
  }
  if (receipt.before.display.wakefulness && receipt.before.display.wakefulness !== "Awake") {
    receipt.manualSteps.push("Wake and unlock the authorised Pixel, then leave the existing RelaySwarm Vanadium tab visible. The harness does not change the lock screen or another app.");
    throw new Error("Physical device display is not awake.");
  }
  await connectExistingTab(); receipt.preflight.cdp = "connected to RelaySwarm page target only";
  receipt.preflight.hostedPlayerReady = await evaluate("window.relaySwarmDemo?.ready()===true");
  receipt.environment = await evaluate("({userAgent:navigator.userAgent,secureContext:isSecureContext,webdriver:navigator.webdriver===true,connection:navigator.connection?{type:navigator.connection.type??null,effectiveType:navigator.connection.effectiveType??null,saveData:navigator.connection.saveData===true}:null,visibility:document.visibilityState})");
  assert.ok(receipt.environment.userAgent.includes("Android"), "The attached browser does not report Android; do not call a desktop CDP session physical evidence.");
  assert.equal(receipt.environment.visibility, "visible", "The public RelaySwarm tab is not visible; select it manually without interrupting another tab.");
  if (values.probe) {
    if (values["capture-viewport"]) {
      receipt.controlLayouts = await evaluate("Array.from(document.querySelectorAll('button,input,select')).map(e=>({id:e.id,disabled:e.disabled===true,rect:(()=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()}))");
      receipt.viewport = await evaluate("({width:innerWidth,height:innerHeight,visualWidth:visualViewport?.width??null,visualHeight:visualViewport?.height??null,scale:visualViewport?.scale??null,devicePixelRatio})");
      await screenshot("readiness-viewport");
    }
    receipt.ok = true;
  }
  else {
    assert.ok(values["expected-client-sha256"], "Physical acceptance requires the expected deployed client SHA-256; use --probe for readiness only.");
    if (values["expected-client-sha256"]) {
      const response = await fetch(new URL("/client.js", target), { cache: "no-store", signal: AbortSignal.timeout(8000) });
      assert.equal(response.status, 200, "Fresh public browser bundle is unavailable.");
      const body = await response.arrayBuffer(); assert.ok(body.byteLength <= 2 * 1024 * 1024, "Public browser bundle exceeds its inspection bound.");
      const clientSha256 = createHash("sha256").update(Buffer.from(body)).digest("hex");
      assert.equal(clientSha256, values["expected-client-sha256"], "Public browser bundle does not match the requested deployed candidate.");
      receipt.deployment = { suppliedRevision: values.revision ?? null, clientSha256, expectedClientHashVerified: true };
    } else receipt.deployment = { suppliedRevision: values.revision ?? null, expectedClientHashVerified: false };
    // Start acceptance with the current deployed code, preserving the exact
    // existing tab and its durable quota rather than an earlier loaded bundle.
    await cdpCommand("Page.reload", { ignoreCache: true });
    await until(async () => await evaluate("window.relaySwarmDemo?.ready() && !document.getElementById('start').disabled"), "Hosted RelaySwarm has not made its player ready.");
    assert.equal(await evaluate("document.getElementById('upload').checked"), false, "Upload consent must begin off.");
    assert.equal(await evaluate("document.getElementById('telemetry').checked"), false, "Reporting consent must begin off.");
    const initialSpent = (await report()).uploadBudget.spent;
    await checkpoint("initial-consent-off");
    journeyStarted = true; await select("mode", "peer-first"); await tap("start");
    await until(async () => (await report())?.player?.firstPlayingAtMs !== null, "Physical origin playback did not start.");
    await playbackSample("initial-origin-playback");
    await until(async () => (await report())?.totals?.peerFirstBytes > 0, "No verified physical peer download was measured. Keep an authorised desktop contributor active; if Vanadium requests permission, grant it manually for this site.", 45000);
    assert.equal((await report()).totals.uploaded, 0); await playbackSample("receive-only"); await checkpoint("physical-receive-only-peer-payload");
    const availableQualities = await evaluate("Array.from(document.getElementById('quality').options).map(option=>option.value).filter(value=>Number(value)>=0)");
    assert.ok(availableQualities.length >= 2, "The physical quality journey needs two real published renditions.");
    for (const quality of [availableQualities.at(-1), availableQualities[0]]) {
      const atMs = (await report()).durationMs;
      await select("quality", quality);
      await until(async () => (await report()).player.fragments.some((fragment) => fragment.atMs > atMs && fragment.level === Number(quality) && ["video", "main"].includes(fragment.mediaType)), `No physical video fragment was loaded after selecting quality ${quality}.`, 20000);
    }
    await evaluate("(()=>{const v=window.relaySwarmDemo.media;if(v.buffered.length){const start=v.buffered.start(0),end=v.buffered.end(v.buffered.length-1);v.currentTime=Math.max(start,Math.min(end-1,v.currentTime-4));}})()");
    await until(async () => (await report()).player.seekRecoveryMs.length > 0, "Physical seek did not recover.");
    await playbackSample("quality-and-seek");
    await checkpoint("physical-quality-and-seek");
    const beforeUpload = (await report()).totals.uploaded;
    await tap("upload"); assert.equal(await evaluate("document.getElementById('upload').checked"), true); await tap("start");
    await until(async () => (await report()).totals.uploaded > beforeUpload, "No physical upload was measured after explicit opt-in. Keep an authorised desktop receive-only viewer requesting the same quality.", 45000);
    const beforeReload = await report(); await checkpoint("physical-explicit-upload-and-durable-reservation");
    await cdpCommand("Page.reload", { ignoreCache: false });
    await until(async () => await evaluate("window.relaySwarmDemo?.ready() && !document.getElementById('start').disabled"), "Physical full reload did not restore the player.");
    assert.equal(await evaluate("document.getElementById('upload').checked"), false); assert.ok((await report()).uploadBudget.spent >= beforeReload.uploadBudget.spent);
    await checkpoint("physical-reload-retains-usage-without-consent");
    await select("mode", "peer-first"); await tap("start");
    await until(async () => (await report()).player.firstPlayingAtMs !== null, "Physical playback did not restart after reload.");
    if (values["background-journey"]) {
      assert.ok((await foreground())?.startsWith(`${values["browser-package"]}/`), "Device foreground changed; leave unrelated activity alone.");
      const component = (await adb(["shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER", values["browser-package"]])).split("\n").find((line) => line.startsWith(`${values["browser-package"]}/`));
      assert.ok(component, "Vanadium launcher component could not be resolved.");
      const playbackBeforeBackground = (await report()).player.currentTime;
      await adb(["shell", "input", "keyevent", "KEYCODE_HOME"]); await pause(6000);
      await adb(["shell", "am", "start", "-n", component]);
      await until(async () => await evaluate("document.visibilityState==='visible'"), "Physical browser did not resume the RelaySwarm tab.");
      assert.equal(await evaluate("document.getElementById('upload').checked"), false);
      await until(async () => { const state = await report(); return !state.player.paused && state.player.currentTime > playbackBeforeBackground + 1; }, "Physical playback did not advance after background/resume.", 15000);
      await checkpoint("physical-background-and-resume");
      await tap("start");
    } else receipt.manualSteps.push("Background and resume was not requested for this run; run with --background-journey when the physical device is reserved for this fixture.");
    await tap("kill"); await until(async () => (await report()).current?.mode === "off" && (await report()).loaderRestored, "Origin-only kill did not restore the physical loader.");
    const killed = await report(); assert.equal(killed.current.metrics.peers.connected, 0); assert.equal(killed.current.metrics.serving, false);
    assert.equal(killed.player.fatalErrors, 0); await checkpoint("physical-origin-only-kill");
    await playbackSample("origin-only");
    if (values["reset-allowance"]) {
      assert.equal(initialSpent, 0, "Reset would erase pre-existing browser usage; preserve it and omit --reset-allowance.");
      await tap("reset-allowance");
      await until(async () => (await report()).uploadBudget.spent === 0, "Explicit physical quota reset did not finish.");
      assert.equal(await evaluate("document.getElementById('upload').checked"), false);
      await checkpoint("physical-explicit-quota-reset");
    }
    receipt.ok = true;
  }
} catch (error) {
  receipt.failures.push(error.message);
  if (error.message.includes("device") && error.message.includes("not found")) receipt.manualSteps.push("Restore the authorised Pixel USB debugging connection to m4; accept its debugging authorisation prompt if the phone displays one. No ADB server reset was attempted.");
  log(error.message);
} finally {
  if (peerSocket?.readyState === WebSocket.OPEN) {
    if (journeyStarted) receipt.finalReport = await report().then(redacted).catch(() => null);
    try { if (journeyStarted) { await assertOurTab(); await evaluate("(()=>{const u=document.getElementById('upload');if(u)u.checked=false;window.relaySwarmDemo?.stop();})()"); } } catch { /* Never inspect another target to recover cleanup. */ }
    if (journeyStarted) {
      try {
        await assertOurTab(); await cdpCommand("Page.reload", { ignoreCache: false });
        receipt.cleanup = { selectedPublicTabReloaded: true, reason: "Stop fixture media and return to a fresh page with upload consent off; durable usage retained." };
      } catch { receipt.cleanup = { selectedPublicTabReloaded: false }; }
    }
    peerSocket.close(); const closed = new Promise((done) => peerSocket.once("close", done));
    await Promise.race([closed, pause(1000)]); if (peerSocket.readyState !== WebSocket.CLOSED) peerSocket.terminate();
  }
  receipt.after = await deviceSnapshot().catch(() => null);
  receipt.recordedAt = new Date().toISOString();
  await writeFile(join(values["results-dir"], "physical-browser.json"), `${JSON.stringify(redacted(receipt), null, 2)}\n`);
}
console.log(JSON.stringify({ ok: receipt.ok, probe: receipt.probe, physicalDevice: receipt.device, network: receipt.before?.network, failures: receipt.failures, manualSteps: receipt.manualSteps, receipt: join(values["results-dir"], "physical-browser.json") }, null, 2));
process.exitCode = receipt.ok ? 0 : 1;
