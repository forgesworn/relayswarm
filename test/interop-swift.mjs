#!/usr/bin/env node
// Real Swift/JavaScript v3 session and WebRTC transfer using a test-only Swift
// adapter over the pinned, untouched RelaySwarmKit components. Stock Kit v2 is
// deliberately tested separately and must remain incompatible with v3 defaults.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import { RTCPeerConnection } from "werift";
import { generateSecretKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { v2 as nip44 } from "nostr-tools/nip44";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { createHlsPublisher } from "../src/hls-publisher.mjs";
import { commitmentContent } from "../src/browser/segment-commitment.mjs";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";

const execute = promisify(execFile), digest = (value) => createHash("sha256").update(value).digest("hex");
const scratch = resolve("artifacts/protocol-swift-kit");
const evidenceFlag = process.argv.indexOf("--evidence");
const evidencePath = resolve(evidenceFlag < 0 ? "artifacts/relayswarm-swift-interop-current.json" : process.argv[evidenceFlag + 1]);
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The pinned toolkit's libdatachannel binary requires macOS arm64; no cross-platform success is inferred.");
const implementationFiles = ["src/relay-session.mjs", "src/browser/peer-link.mjs", "src/browser/segment-commitment.mjs", "src/hls-publisher.mjs",
  "src/hls-media-catalogue.mjs", "src/publisher-state.mjs", "src/publisher-advertisement.mjs", "test/interop-swift/main.swift", "test/interop-swift.mjs", "scripts/protocol-fetch-swift-kit.mjs"];
const initialImplementationHashes = {};
for (const path of implementationFiles) initialImplementationHashes[path] = digest(await readFile(path));
const deadline = (promise, milliseconds, message) => new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), milliseconds);
  Promise.resolve(promise).then(resolvePromise, reject).finally(() => clearTimeout(timer));
});
async function build() {
  // The fetched kit component source/binary files are exact revision snapshots.
  // A custom scratch package adds only this repo's explicit test adapter.
  await execute(process.execPath, ["scripts/protocol-fetch-swift-kit.mjs", scratch], { timeout: 120000, maxBuffer: 1024 * 1024 });
  await copyFile("test/interop-swift/main.swift", join(scratch, "Sources/InteropHarness/main.swift"));
  await execute("swift", ["build", "--package-path", scratch, "-c", "debug", "--jobs", "4"], { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
}
function childClient(configuration) {
  const process = spawn(join(scratch, ".build/debug/interop-harness"), [configuration], { stdio: ["ignore", "pipe", "pipe"] });
  const messages = [], waiters = new Set(); let pending = "", errors = "";
  process.stdout.on("data", (chunk) => {
    pending += String(chunk);
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n"), line = pending.slice(0, end); pending = pending.slice(end + 1);
      let value; try { value = JSON.parse(line); } catch { continue; }
      messages.push(value);
      for (const waiter of [...waiters]) if (waiter.type === value.type) { waiters.delete(waiter); waiter.resolve(value); }
    }
  });
  process.stderr.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-16384); });
  const exit = new Promise((resolvePromise, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(); else reject(new Error(`Swift fixture exited ${code ?? signal}: ${errors}`));
      for (const waiter of waiters) waiter.reject(new Error("Swift fixture ended before expected receipt.")); waiters.clear();
    });
  });
  exit.catch(() => {});
  return { process, messages, exit,
    wait(type) { const known = messages.find((value) => value.type === type); return known ? Promise.resolve(known) : deadline(new Promise((resolvePromise, reject) => waiters.add({ type, resolve: resolvePromise, reject })), 35000, `Swift ${type} deadline.`); },
    async close() { if (process.exitCode === null) process.kill("SIGTERM"); await deadline(exit.catch(() => {}), 3000, "Swift fixture cleanup deadline."); },
  };
}
function channelAdapter(native, pc) {
  const channel = new EventTarget(), connection = new EventTarget();
  Object.defineProperties(channel, { readyState: { get: () => native.readyState }, bufferedAmount: { get: () => native.bufferedAmount } });
  channel.send = (value) => native.send(typeof value === "string" ? value : Buffer.from(value));
  channel.close = () => native.close(); connection.close = () => pc.close();
  native.onMessage.subscribe((value) => channel.dispatchEvent(new MessageEvent("message", { data: typeof value === "string" ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) })));
  native.stateChanged.subscribe((state) => { if (state === "closed") channel.dispatchEvent(new Event("close")); });
  pc.connectionStateChange.subscribe(() => { connection.connectionState = pc.connectionState; connection.dispatchEvent(new Event("connectionstatechange")); });
  return { channel, pc: connection };
}

let work, relay, server, pool, session, succeeded = false; const children = [], connections = [];
try {
  await build();
  work = await mkdtemp(join(tmpdir(), "relayswarm-swift-interop-"));
  const bytes = randomBytes(256 * 1024 + 37), authorKey = generateSecretKey();
  await writeFile(join(work, "index.m3u8"), "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-DISCONTINUITY-SEQUENCE:2\n#EXTINF:2,\nobject.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(work, "object.ts"), bytes);
  const publisher = await createHlsPublisher({ mediaDir: work, manifest: "index.m3u8", secretKey: authorKey });
  const expected = { path: "/media/object.ts", playlist: "/media/index.m3u8", mediaType: "main", level: 0, sequence: 20, discontinuity: 2 };
  const v2 = await publisher.commitment(expected), v1 = await publisher.commitment({ ...expected, playlist: undefined });
  const fields = JSON.parse(v2.content), key = fields.key;
  const cases = [{ name: "schema-1", event: v1, expectedValid: true }, { name: "schema-2", event: v2, expectedValid: true }];
  for (const [name, override] of Object.entries({ sequence: { sequence: 21 }, discontinuity: { discontinuity: 3 }, part: { part: 0 }, key: { key: "0".repeat(64) },
    playlist: { playlist: "/media/other.m3u8", rendition: "/media/other.m3u8" }, type: { mediaType: "audio" }, size: { size: 1048577 }, expiry: { expiresAt: Math.floor(Date.now() / 1000) - 1 } })) {
    cases.push({ name, event: finalizeEvent({ kind: 24172, created_at: v2.created_at, tags: v2.tags, content: commitmentContent({ ...fields, ...override }) }, authorKey), expectedValid: false });
  }
  cases.push({ name: "wrong-author", event: finalizeEvent({ kind: 24172, created_at: v2.created_at, tags: v2.tags, content: v2.content }, generateSecretKey()), expectedValid: false });
  cases.push({ name: "signature-mutation", event: { ...v2, content: v2.content.replace('"sequence":20', '"sequence":21') }, expectedValid: false });
  relay = await startLocalRelay();
  server = createServer(async (_request, response) => {
    try { const event = await publisher.commitment(expected); response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(event)); }
    catch { response.writeHead(503).end(); }
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  pool = new RelayPool([relay.url]); await pool.connect(); session = new RelaySwarmSession({ pool, swarmId: publisher.swarmId }); session.start();
  const configuration = { relayUrl: relay.url, swarmId: publisher.swarmId, nodePubkey: session.pubkey,
    commitmentUrl: `http://127.0.0.1:${server.address().port}/commitment`, streamEvent: publisher.streamEvent, expected, cases };
  const stockPath = join(work, "stock.json"); await writeFile(stockPath, JSON.stringify({ ...configuration, mode: "stock" }), { mode: 0o600 });
  let stockPresence = 0, stockSignals = 0;
  const offPresence = session.onPresence(() => { stockPresence++; }), offSignal = session.onSignal(() => { stockSignals++; });
  const stock = childClient(stockPath); children.push(stock);
  const stockReady = await stock.wait("stock-ready");
  session.announcePresence({ role: "seeder", transports: [{ type: "webrtc", publicKey: session.pubkey }], have: [key] });
  session.sendSignal(stockReady.pubkey, { type: "offer", transport: "webrtc", requestId: randomBytes(16).toString("hex"), payload: { sdp: "v3-private-challenge" } });
  const stockReceipt = await stock.wait("stock-receipt"); await stock.exit; offPresence(); offSignal();
  assert.equal(stockReceipt.v3SignalsAccepted, 0); assert.equal(stockPresence, 0); assert.equal(stockSignals, 0);
  const stockEvents = relay.events.filter((event) => event.pubkey === stockReady.pubkey);
  const stockSignal = stockEvents.find((event) => event.kind === 24171);
  assert.ok(stockSignal && verifyEvent(stockSignal));
  const stockPlaintext = nip44.decrypt(stockSignal.content, nip44.utils.getConversationKey(session.secretKey, stockReady.pubkey));
  assert.equal(JSON.parse(stockPlaintext).sdp, "stock-swift-v2-private-sdp");
  assert.ok(stockSignal.tags.some(([name, value]) => name === "v" && value === "2"));

  const journeys = [];
  for (const corrupt of [false, true]) {
    const mode = corrupt ? "corrupt" : "adapter", configPath = join(work, `${mode}.json`);
    await writeFile(configPath, JSON.stringify({ ...configuration, mode }), { mode: 0o600 });
    const presences = new Map();
    const unsubscribePresence = session.onPresence((value) => presences.set(value.from, value));
    const client = childClient(configPath); children.push(client);
    const ready = await client.wait("adapter-ready");
    const presence = presences.get(ready.pubkey) ?? await session.waitForPresence(({ from }) => from === ready.pubkey, 10000);
    unsubscribePresence();
    assert.equal(presence.from, ready.pubkey); assert.equal(presence.payload.v, 3);
    const pc = new RTCPeerConnection({ iceServers: [] }); connections.push(pc);
    const nativeChannel = pc.createDataChannel("relayswarm-segments"), adapted = channelAdapter(nativeChannel, pc);
    const served = corrupt ? Buffer.from(bytes) : bytes; if (corrupt) served[100] ^= 0xff;
    const link = new PeerLink({ ...adapted, pubkey: ready.pubkey, maxSegmentBytes: 1024 * 1024, onRequest: (_peer, requested) => requested === key ? served : null });
    nativeChannel.stateChanged.subscribe((state) => { if (state === "open") link.sendHave([key]); });
    session.announcePresence({ role: "seeder", transports: [{ type: "webrtc", publicKey: session.pubkey }], have: [key] });
    // Invalid v2/plaintext and malformed encrypted v3 cannot activate the adapter.
    pool.publish(finalizeEvent({ kind: 24171, created_at: Math.floor(Date.now() / 1000), tags: [["x", publisher.swarmId], ["p", ready.pubkey]], content: JSON.stringify({ v: 2, type: "offer", sdp: "unsafe-plaintext" }) }, session.secretKey));
    pool.publish(finalizeEvent({ kind: 24171, created_at: Math.floor(Date.now() / 1000), tags: [["x", publisher.swarmId], ["p", ready.pubkey]],
      content: nip44.encrypt(JSON.stringify({ v: 3, type: "offer", transport: "webrtc", requestId: "invalid-request-format!", payload: {} }), nip44.utils.getConversationKey(session.secretKey, ready.pubkey)) }, session.secretKey));
    const requestId = randomBytes(16).toString("hex"), answer = session.waitForSignal(({ from, payload }) => from === ready.pubkey && payload.type === "answer" && payload.requestId === requestId, 15000);
    await pc.setLocalDescription(await pc.createOffer());
    session.sendSignal(ready.pubkey, { type: "offer", transport: "webrtc", requestId, payload: { sdp: pc.localDescription.sdp } });
    const accepted = await answer; await pc.setRemoteDescription({ type: "answer", sdp: accepted.payload.payload.sdp });
    const receipt = await client.wait("adapter-receipt"); await client.exit;
    assert.equal(receipt.ok, !corrupt, JSON.stringify(receipt)); assert.equal(receipt.integrityRejected, corrupt);
    assert.equal(receipt.objectBytes, bytes.length); assert.equal(receipt.presenceVerified, true); assert.equal(receipt.commitmentVerified, true);
    assert.equal(receipt.invalidSignalsRejected >= 2, true); assert.equal(link.bytesOut, bytes.length);
    journeys.push({ scenario: mode, ...receipt }); link.close();
  }
  const signals = relay.events.filter((event) => event.kind === 24171);
  assert.ok(signals.filter((event) => !event.content.startsWith("{")).length >= 5);
  assert.equal(signals.filter((event) => event.content.includes("v=0") || event.content.includes("stock-swift-v2-private-sdp") || event.content.includes("v3-private-challenge")).length, 0);
  for (const path of implementationFiles) assert.equal(digest(await readFile(path)), initialImplementationHashes[path], `Implementation changed during the interop fixture: ${path}`);
  const implementationHashes = initialImplementationHashes;
  const baseCommit = (await execute("git", ["rev-parse", "HEAD"])).stdout.trim();
  const provenance = JSON.parse(await readFile(join(scratch, "source-provenance.json"), "utf8"));
  const evidence = { v: 1, measuredAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, implementation: { baseCommit, workingTreeFileHashes: implementationHashes }, toolkit: provenance,
    unmodifiedToolkit: { compatible: false, presenceAcceptedByV3: stockPresence, signalsAcceptedByV3: stockSignals, v3SignalsAcceptedByKit: stockReceipt.v3SignalsAccepted,
      nip44CryptographyCompatible: true, wireVersion: 2 }, adapter: { released: false, scope: "test-only Swift v3 adapter using untouched toolkit crypto/relay/libdatachannel components", commitmentConformanceCases: cases.length, journeys },
    plaintextNetworkSdpOnRelay: false, adversarialPlaintextProbeSignals: 2, transport: "loopback WebRTC only; no HyperDHT, physical-device or NAT interoperability claim" };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  succeeded = true;
} finally {
  for (const child of children) await child.close().catch(() => {});
  for (const connection of connections) await connection.close().catch(() => {});
  session?.close(); pool?.close(); await relay?.close();
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  if (work) await rm(work, { recursive: true, force: true });
  // Only the scratch package created by protocol-fetch-swift-kit is removed.
  // The named evidence receipt is deliberately kept for release review.
  if (succeeded && await readFile(join(scratch, ".task-owned-scratch"), "utf8").catch(() => "") === "relayswarm-protocol-interop-scratch-v1\n") await rm(scratch, { recursive: true, force: true });
}
