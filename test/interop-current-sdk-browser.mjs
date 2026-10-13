#!/usr/bin/env node
// Current, unadapted public SDK APIs consuming signed real HLS bytes from Chrome
// running the production hls.js/RelaySwarm loader. No Swift wire adapter exists.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createHlsPublisher } from "../src/hls-publisher.mjs";
import { createCommitmentDelegation, createCommitmentRevocation } from "../src/publisher-state.mjs";
import { createFmp4Fixture } from "./support/fmp4-fixture.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";
const execute = promisify(execFile), digest = (value) => createHash("sha256").update(value).digest("hex");
const sdk = resolve(process.env.RELAYSWARM_KIT_DIR ?? "../relayswarm-kit");
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const evidenceFlag = process.argv.indexOf("--evidence"), evidencePath = resolve(evidenceFlag < 0 ? "artifacts/current-sdk-browser-interop.json" : process.argv[evidenceFlag + 1]);
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The current SDK transport binary requires macOS arm64.");
const sourceFiles = ["src/relay-session.mjs", "src/browser/hls-swarm.mjs", "src/browser/peer-link.mjs", "src/browser/segment-commitment.mjs", "src/hls-publisher.mjs", "src/hls-media-catalogue.mjs", "src/publisher-state.mjs"];
const javascriptHead = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (path) => [path, digest(await readFile(path))])));
const viewerSource = `import Hls from "hls.js";
import {createHlsSwarm} from "${resolve("src/browser/hls-swarm.mjs")}";
const config=await fetch('/configuration.json').then(r=>r.json()), scenario=new URLSearchParams(location.search).get('scenario');
const microphone=await navigator.mediaDevices.getUserMedia({audio:true});microphone.getTracks().forEach(t=>t.stop());
let checks=0;
const swarm=createHlsSwarm({mode:'shadow',swarmId:config.swarmId,relays:[config.relayUrl],streamEvent:config.streamEvent,serve:true,
 maxPeers:2,maxUploadPeers:2,maxUploadBytesPerSession:4*1024*1024,maxUploadBytesPerSecond:2*1024*1024,iceServers:[],shadowSampleRate:1,
 presenceIntervalMs:1000,ticket:'browser-admission',admit:async(_pub,ticket)=>{if(ticket!=='fixture-admission')return false;checks++;
 if(scenario==='revoke-during'&&checks===3){await fetch('/revoke-during',{method:'POST'});await new Promise(r=>setTimeout(r,500));}return true;},
 testHooks:{corruptUploads:scenario==='corrupt'}});
const video=document.querySelector('video'),hls=new Hls({enableWorker:false,startLevel:0,autoStartLoad:true,maxBufferLength:30,maxMaxBufferLength:30});
let fragments=0;hls.on(Hls.Events.FRAG_LOADED,()=>fragments++);swarm.attach(hls);hls.loadSource('/media/master.m3u8');hls.attachMedia(video);video.muted=true;video.play().catch(()=>{});
window.interop={swarm,hls,video,fragments:()=>fragments,checks:()=>checks};`;
function client(path) {
  const process = spawn(join(sdk, ".build/debug/relayswarm-interop"), [path], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "";
  process.stdout.on("data", (chunk) => { output += String(chunk); if (output.length > 65536) process.kill("SIGTERM"); });
  process.stderr.on("data", (chunk) => { error = (error + String(chunk)).slice(-4000); });
  const done = new Promise((resolvePromise, reject) => {
    process.once("error", reject); process.once("exit", (code) => code === 0 ? resolvePromise(output.trim().split("\n").map((line) => JSON.parse(line))) : reject(new Error(`Current SDK fixture exited ${code}: ${error}`)));
  }); done.catch(() => {});
  return { process, done };
}
let work, fixture, relay, server, browser; const clients = [];
const sdkHead = (await execute("git", ["-C", sdk, "rev-parse", "HEAD"])).stdout.trim();
const sdkFiles = (await execute("git", ["-C", sdk, "ls-files", "--cached", "--others", "--exclude-standard", "Sources", "Tests/Interop", "Package.swift", "Package.resolved"])).stdout.trim().split("\n");
const sdkSourceHashes = Object.fromEntries(await Promise.all(sdkFiles.map(async (path) => [path, digest(await readFile(join(sdk, path)))])));
try {
  await execute("swift", ["build", "--package-path", sdk, "--jobs", "4", "--product", "relayswarm-interop"], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  work = await mkdtemp(join(tmpdir(), "current-sdk-interop-"));
  fixture = await createFmp4Fixture({ seconds: 8 });
  const authorKey = generateSecretKey(), delegateKey = generateSecretKey();
  const publisher = await createHlsPublisher({ mediaDir: fixture.directory, secretKey: authorKey });
  const expected = { path: "/media/low/segment-00000.m4s", playlist: "/media/low/index.m3u8", level: 0, sequence: 0, discontinuity: 0, mediaType: "main" };
  const realBytes = await readFile(join(fixture.directory, "low/segment-00000.m4s"));
  const delegation = createCommitmentDelegation({ secretKey: authorKey, streamEvent: publisher.streamEvent, swarmId: publisher.swarmId, delegatePubkey: getPublicKey(delegateKey), renditions: [expected.playlist] });
  const delegated = await createHlsPublisher({ mediaDir: fixture.directory, streamEvent: publisher.streamEvent, swarmId: publisher.swarmId, commitmentSecretKey: delegateKey, delegation });
  const revocation = createCommitmentRevocation({ secretKey: authorKey, streamEvent: publisher.streamEvent, swarmId: publisher.swarmId, delegation });
  relay = await startLocalRelay();
  const bundle = await build({ stdin: { contents: viewerSource, resolveDir: process.cwd(), sourcefile: "current-sdk-viewer.mjs" }, bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent" });
  let revocations = [];
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    try {
      if (url.pathname === "/") return response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><video autoplay muted playsinline></video><script type="module" src="/viewer.js"></script>');
      if (url.pathname === "/viewer.js") return response.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles[0].contents);
      if (url.pathname === "/configuration.json") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ swarmId: publisher.swarmId, streamEvent: publisher.streamEvent, relayUrl: relay.url }));
      if (url.pathname === "/revoke-during") { revocations = [revocation]; return response.writeHead(200).end(); }
      if (url.pathname === "/policy.json") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ revocations }));
      if (url.pathname === "/commitment") {
        const scenario = url.searchParams.get("scenario");
        const event = await (scenario?.startsWith("delegate") || scenario?.startsWith("revoke") ? delegated : publisher).commitment(expected);
        if (scenario === "tampered") event.content += " ";
        return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(event));
      }
      if (url.pathname.startsWith("/media/")) {
        const file = await publisher.media(url.pathname), bytes = await readFile(file);
        return response.writeHead(200, { "content-type": file.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : file.endsWith("mp4") ? "video/mp4" : "application/octet-stream" }).end(bytes);
      }
      response.writeHead(404).end();
    } catch { response.writeHead(503).end(); }
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const results = [];
  for (const scenario of ["author", "delegate", "corrupt", "tampered", "revoked", "revoke-during"]) {
    revocations = [];
    const page = await browser.newPage();
    await page.goto(`${base}/?scenario=${scenario}`);
    await page.waitForFunction(() => window.interop?.fragments() >= 2 && window.interop.video.currentTime > 0 && window.interop.swarm.metrics().pubkey, { timeout: 15000 });
    const peer = await page.evaluate(() => window.interop.swarm.metrics().pubkey);
    const wantedKey = digest(`${publisher.swarmId}\n${expected.path}`), presenceDeadline = Date.now() + 5000;
    while (!relay.events.some((event) => event.kind === 24170 && event.pubkey === peer && JSON.parse(event.content).have?.includes(wantedKey))) {
      if (Date.now() > presenceDeadline) throw new Error("Browser did not advertise its held HLS media through the public session contract.");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    const config = { scenario, relayUrl: relay.url, swarmId: publisher.swarmId, peerPubkey: peer, trustedAuthor: publisher.streamEvent.pubkey,
      streamEvent: publisher.streamEvent, delegation: scenario.startsWith("delegate") || scenario.startsWith("revoke") ? delegation : null,
      revocations: scenario === "revoked" ? [revocation] : [], policyUrl: scenario === "revoke-during" ? `${base}/policy.json` : null,
      commitmentUrl: `${base}/commitment?scenario=${scenario}`, expected };
    const path = join(work, `${scenario}.json`); await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    const sdkClient = client(path); clients.push(sdkClient);
    const timeout = setTimeout(() => sdkClient.process.kill("SIGTERM"), 30000);
    const messages = await sdkClient.done.finally(() => clearTimeout(timeout)), receipt = messages.find((message) => message.type === "sdk-receipt");
    const shouldPass = ["author", "delegate"].includes(scenario);
    assert.equal(receipt?.ok, shouldPass, JSON.stringify({ scenario, messages }));
    if (shouldPass) { assert.equal(receipt.sha256, digest(realBytes)); assert.equal(receipt.objectBytes, realBytes.length); }
    if (scenario === "corrupt") assert.equal(receipt.error, "integrity");
    if (scenario.startsWith("revoke")) assert.equal(receipt.error, "revoked");
    if (scenario === "tampered") assert.equal(receipt.error, "invalidCommitment");
    assert.equal(receipt.wireAdapter, false);
    const uploadedBytes = await page.evaluate(() => window.interop.swarm.metrics().bytes.uploaded);
    if (["author", "delegate", "corrupt", "revoke-during"].includes(scenario)) assert.equal(uploadedBytes, realBytes.length, `Expected actual Chrome media transfer for ${scenario}`);
    else assert.equal(uploadedBytes, 0);
    results.push({ ...receipt, browser: { currentTime: await page.evaluate(() => window.interop.video.currentTime), uploadedBytes, admissionChecks: await page.evaluate(() => window.interop.checks()) } });
    await page.evaluate(() => { window.interop.swarm.stop(); window.interop.hls.destroy(); }); await page.close();
  }
  assert.equal((await execute("git", ["-C", sdk, "rev-parse", "HEAD"])).stdout.trim(), sdkHead, "SDK commit changed during acceptance");
  for (const path of sdkFiles) assert.equal(digest(await readFile(join(sdk, path))), sdkSourceHashes[path], `SDK source changed during acceptance: ${path}`);
  for (const path of sourceFiles) assert.equal(digest(await readFile(path)), sourceHashes[path], `JavaScript module changed during current SDK acceptance: ${path}`);
  const evidence = { v: 1, measuredAt: new Date().toISOString(), toolkit: { baseCommit: sdkHead, sourceHashes: sdkSourceHashes }, javascript: { baseCommit: javascriptHead, sourceHashes },
    currentSDKAPIs: true, wireAdapter: false, chromePlayback: true, generatedMedia: "fMP4 HLS H.264/AAC", actualMediaBytes: realBytes.length,
    scope: "macOS arm64 Swift SDK and desktop Chrome, loopback only", results,
    plaintextNetworkSdpOnRelay: !relay.events.filter((event) => event.kind === 24171).every((event) => !event.content.includes("v=0") && !event.content.includes("candidate:")) };
  assert.equal(evidence.plaintextNetworkSdpOnRelay, false);
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const child of clients) if (child.process.exitCode === null) child.process.kill("SIGTERM");
  await Promise.allSettled(clients.map((child) => child.done));
  await browser?.close(); await relay?.close();
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  await fixture?.close(); if (work) await rm(work, { recursive: true, force: true });
}
