#!/usr/bin/env node
// Same-identity admission renewal over native SCTP and the committed WASM
// core. Synthetic loader bytes on loopback; no video, TURN or field claim.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { commitmentContent, KIND_SEGMENT_COMMITMENT } from "../src/browser/segment-commitment.mjs";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { startLocalRelay } from "./support/local-relay.mjs";

function browserFixture(createHlsSwarm) {
  const connections = [], channels = [], reservations = [], deliveries = [];
  let swarm, hls, role, bootstrap, baseline, loading;
  const observe = channel => {
    const record = { channel, have: new Set(), wants: 0 }; channels.push(record);
    channel.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data);
      if (frame.t === "want") record.wants++;
      if (frame.t === "have") {
        if (frame.keys) record.have = new Set(frame.keys);
        for (const key of frame.add || []) record.have.add(key);
        for (const key of frame.del || []) record.have.delete(key);
      }
    });
    return channel;
  };
  class ObservedPC extends RTCPeerConnection {
    constructor(config) { super(config); connections.push(this); this.addEventListener("datachannel", event => observe(event.channel)); }
    createDataChannel(...args) { return observe(super.createDataChannel(...args)); }
  }
  class HttpLoader {
    stats = { loaded: 0, loading: { start: 0, first: 0, end: 0 } };
    load(context, _config, callbacks) {
      this.controller = new AbortController();
      this.stats.loading.start = performance.now();
      fetch(context.url, { signal: this.controller.signal }).then(async response => {
        const data = await response.arrayBuffer();
        this.stats.loaded = this.stats.total = data.byteLength;
        this.stats.loading.first = this.stats.loading.end = performance.now();
        callbacks.onSuccess({ url: context.url, data }, this.stats, context, response);
      }).catch(error => { if (!this.controller.signal.aborted) callbacks.onError({ text: error.message }, context); });
    }
    abort() { this.controller?.abort(); }
    destroy() { this.abort(); }
  }
  const snapshot = () => {
    const metrics = swarm.metrics(), details = swarm.peerConnectionDetails();
    return { pubkey: metrics.pubkey, peers: metrics.peers, bytes: metrics.bytes, serving: metrics.serving, core: metrics.core,
      sameConnection: !!baseline && details.length === 1 && details[0].connection === baseline.connection && details[0].pubkey === baseline.pubkey,
      sameLoader: !!baseline && hls.config.fLoader === baseline.loader, sameIdentity: !!baseline && metrics.pubkey === baseline.ownPubkey,
      connections: details.map(detail => ({ id: connections.indexOf(detail.connection), pubkey: detail.pubkey, state: detail.connection.connectionState })),
      wants: channels.reduce((sum, record) => sum + record.wants, 0), reservations: [...reservations], deliveries: [...deliveries],
      transport: metrics.transportDiagnostics, admission: metrics.admissionDiagnostics, eligibility: metrics.peerEligibilityDiagnostics,
      requests: metrics.peerRequestDiagnostics, segments: metrics.segments, loading };
  };
  window.fixture = {
    async start(value) {
      role = value;
      bootstrap = await fetch("/bootstrap.json").then(response => response.json());
      // Match the existing native-signalling fixture's explicit local-network
      // permission; all tracks close immediately and no media is recorded.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      hls = { config: { loader: HttpLoader }, media: { currentTime: 0,
        buffered: { length: 1, start: () => 0, end: () => 60 } } };
      swarm = createHlsSwarm({ mode: "peer-first", swarmId: bootstrap.swarmId, relays: [bootstrap.relay], streamEvent: bootstrap.streamEvent,
        coreWasm: "/core.wasm", serve: role === "holder", ticket: `${role}-0`,
        RTCPeerConnectionImpl: ObservedPC, iceServers: [], maxPeers: 1, maxUploadPeers: 1, maxDialsInFlight: 1,
        maxHeldSegments: 8, maxUploadBytesPerSession: bootstrap.payloadBytes * 6, maxUploadBytesPerSecond: 16 * 1024 * 1024,
        originFallbackMs: 2_000, presenceIntervalMs: 1_000, reannounceDebounceMs: 1, minReannounceGapMs: 0,
        segmentKey: url => new URL(url).pathname,
        getCommitment: async context => bootstrap.commitments[context.frag.sn - 1],
        admit: async (pubkey, ticket, { signal }) => {
          const response = await fetch("/verify", { method: "POST", signal, body: JSON.stringify({ observer: role, pubkey, ticket }) });
          return (await response.json()).admitted;
        },
        reserveUploadBytes: size => { reservations.push(size); return true; },
        onPeerDelivery: value => deliveries.push({ bytes: value.bytes, connection: connections.indexOf(value.connection) }),
      });
      swarm.attach(hls);
    },
    initialised() { return swarm.metrics().core.state === "ready" && swarm.metrics().relays.connected === 1; },
    ready() { return swarm.peerConnectionDetails().length === 1 && (role === "holder" || channels.some(record => bootstrap.keys.every(key => record.have.has(key)))); },
    capture() {
      const detail = swarm.peerConnectionDetails()[0];
      baseline = { ...detail, loader: hls.config.fLoader, ownPubkey: swarm.metrics().pubkey };
      return snapshot();
    },
    renew(generation) { return swarm.updateTicket(`${role}-${generation}`); },
    snapshot,
    async load(sn) {
      const before = swarm.metrics(), deliveriesBefore = deliveries.length;
      // This protocol fixture supplies an explicit simulated playback position
      // and buffer so each request has its ordinary peer-first budget.
      hls.media.currentTime = (sn - 1) * 2;
      const url = `${location.origin}/media/segment-${sn}.m4s?role=${role}`;
      const context = { url, responseType: "arraybuffer", part: null,
        frag: { sn, cc: 0, level: 0, type: "main", start: (sn - 1) * 2, duration: 2, url, baseurl: `${location.origin}/media/index.m3u8` } };
      const callbacks = { success: 0, error: 0, abort: 0 };
      const loader = new hls.config.fLoader(hls.config);
      const data = await new Promise((resolve, reject) => loader.load(context, {}, {
        onSuccess(response) { callbacks.success++; resolve(response.data); },
        onError(error) { callbacks.error++; reject(new Error(error.text || "loader error")); },
        onTimeout() { reject(new Error("loader timeout")); },
        onAbort() { callbacks.abort++; reject(new Error("unexpected player abort")); },
      }));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
      return { sn, bytes: data.byteLength, sha256: hash, callbacks, peerBytes: swarm.metrics().bytes.peerFirst - before.bytes.peerFirst,
        deliveries: deliveries.slice(deliveriesBefore) };
    },
    beginLoad(sn) {
      loading = { state: "pending", sn };
      this.load(sn).then(result => { loading = { state: "complete", result }; }, error => { loading = { state: "error", message: error.message }; });
    },
    stop() { swarm.stop(); return { states: connections.map(pc => pc.connectionState), accepted: swarm.peerConnectionDetails().length }; },
  };
}

const root = fileURLToPath(new URL("../", import.meta.url));
const payload = Uint8Array.from({ length: 256 * 1024 }, (_, index) => (index * 131 + 17) % 251);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const expectedHash = sha256(payload), secret = generateSecretKey(), swarmId = `native-renewal-${randomBytes(8).toString("hex")}`;
const now = Math.floor(Date.now() / 1000);
const streamEvent = finalizeEvent({ kind: 30311, created_at: now, tags: [["d", "native-renewal"], ["relayswarm", "redistribute", "1"]], content: "" }, secret);
const keys = [1, 2, 3, 4, 5].map(sn => sha256(`${swarmId}\n/media/segment-${sn}.m4s`));
const commitments = keys.map((key, index) => finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: now, tags: [["x", swarmId], ["e", streamEvent.id]],
  content: commitmentContent({ v: 2, streamEventId: streamEvent.id, swarmId, key, sequence: index + 1, discontinuity: 0, part: null,
    rendition: "/media/index.m3u8", playlist: "/media/index.m3u8", mediaType: "main", encryption: null,
    sha256: expectedHash, size: payload.length, expiresAt: now + 240 }) }, secret));
const wasm = await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url));
const sourceSHA256 = Object.fromEntries(await Promise.all([
  "src/browser/hls-swarm.mjs", "src/browser/core-peer-link.mjs", "src/browser/core-wasm.mjs",
  "src/browser/segment-commitment.mjs", "test/ticket-renewal-native-browser.mjs",
].map(async path => [path, sha256(await readFile(new URL(`../${path}`, import.meta.url)))])));
const bundle = await build({ stdin: { contents: `import { createHlsSwarm } from './src/browser/hls-swarm.mjs';\n(${browserFixture.toString()})(createHlsSwarm);`, resolveDir: root },
  bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" });
const verifications = [], mediaRequests = [], identities = new Map();
let relay, server, browser, guard, heldResponse, renewalHeld = false, revoked = false;
const json = (response, value) => response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
const wait = async (predicate, message) => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 10)); }
};
try {
  relay = await startLocalRelay({ replayEphemeral: false });
  server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") return response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><title>Admission renewal protocol fixture</title><script type="module" src="/fixture.mjs"></script>');
    if (url.pathname === "/fixture.mjs") return response.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles[0].contents);
    if (url.pathname === "/core.wasm") return response.writeHead(200, { "content-type": "application/wasm" }).end(wasm);
    if (url.pathname === "/bootstrap.json") return json(response, { swarmId, streamEvent, commitments, keys, payloadBytes: payload.length, relay: relay.url });
    if (url.pathname === "/verify" && request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks)), owner = /^(holder|receiver)-[0-3]$/u.exec(input.ticket)?.[1];
      if (owner && !identities.has(owner)) identities.set(owner, input.pubkey);
      const admitted = !!owner && identities.get(owner) === input.pubkey && !revoked;
      const record = { ...input, admitted, completed: false, startedAt: Date.now() }; verifications.push(record);
      const finish = () => { record.completed = true; record.finishedAt = Date.now(); json(response, { admitted }); };
      if (input.observer === "holder" && input.ticket === "receiver-1" && !renewalHeld) {
        renewalHeld = true; heldResponse = finish;
      } else finish();
      return;
    }
    if (/^\/media\/segment-[1-5]\.m4s$/u.test(url.pathname)) {
      mediaRequests.push({ path: url.pathname, role: url.searchParams.get("role") });
      return response.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length, "cache-control": "no-store" }).end(payload);
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const contexts = await Promise.all([browser.newContext({ permissions: ["microphone"] }), browser.newContext({ permissions: ["microphone"] })]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  const errors = []; pages.forEach(page => page.on("pageerror", error => errors.push(error.message)));
  await Promise.all(pages.map(page => page.goto(`http://127.0.0.1:${server.address().port}`)));
  await Promise.all(pages.map(page => page.waitForFunction(() => !!window.fixture)));
  const run = async () => {
    const [holder, receiver] = pages;
    await holder.evaluate(() => window.fixture.start("holder"));
    await holder.waitForFunction(() => window.fixture.initialised());
    for (const sn of [1, 2, 3, 4, 5]) assert.equal((await holder.evaluate(sn => window.fixture.load(sn), sn)).sha256, expectedHash);
    await receiver.evaluate(() => window.fixture.start("receiver"));
    await Promise.all(pages.map(page => page.waitForFunction(() => window.fixture.ready(), null, { timeout: 15_000 })));
    const baseline = await Promise.all(pages.map(page => page.evaluate(() => window.fixture.capture())));
    assert.equal(identities.get("holder"), baseline[0].pubkey); assert.equal(identities.get("receiver"), baseline[1].pubkey);
    const retained = snapshots => {
      for (const [index, snapshot] of snapshots.entries()) {
        assert.ok(snapshot.sameConnection && snapshot.sameLoader && snapshot.sameIdentity, "accepted native connection, loader and identity survive renewal");
        assert.equal(snapshot.connections[0].pubkey, baseline[1 - index].pubkey);
        assert.equal(snapshot.peers.connected, 1); assert.equal(snapshot.peers.linksOpened, 1); assert.equal(snapshot.peers.linksClosed, 0);
        assert.equal(snapshot.core.links.wasm, 1); assert.equal(snapshot.core.links.js, 0);
        assert.equal(snapshot.serving, index === 0); assert.equal(snapshot.bytes.held, index === 0 ? payload.length * 5 : 0);
      }
    };
    const checkLoad = (result, peerBytes) => {
      assert.equal(result.sha256, expectedHash); assert.equal(result.bytes, payload.length); assert.equal(result.peerBytes, peerBytes);
      assert.deepEqual(result.callbacks, { success: 1, error: 0, abort: 0 });
      assert.equal(result.deliveries.reduce((sum, value) => sum + value.bytes, 0), peerBytes);
      if (peerBytes) assert.equal(result.deliveries[0].connection, baseline[1].connections[0].id);
    };
    const results = [await receiver.evaluate(() => window.fixture.load(1))]; checkLoad(results[0], payload.length);
    const windows = [];
    for (const generation of [1, 2, 3]) {
      const before = await Promise.all(pages.map(page => page.evaluate(() => window.fixture.snapshot())));
      assert.deepEqual(await Promise.all(pages.map(page => page.evaluate(value => window.fixture.renew(value), generation))), [true, true]);
      await wait(() => verifications.some(record => record.observer === "holder" && record.ticket === `receiver-${generation}`), "holder did not observe renewed receiver credential");
      await wait(() => verifications.some(record => record.observer === "receiver" && record.ticket === `holder-${generation}` && record.completed), "receiver did not accept renewed holder credential");
      let pending = null;
      if (generation === 1) {
        await receiver.evaluate(() => window.fixture.beginLoad(2));
        await holder.waitForFunction(() => window.fixture.snapshot().wants >= 2, null, { timeout: 2_000 });
        pending = await Promise.all(pages.map(page => page.evaluate(() => window.fixture.snapshot())));
        retained(pending);
        assert.equal(pending[1].loading.state, "pending");
        assert.equal(pending[0].bytes.uploaded, before[0].bytes.uploaded);
        assert.deepEqual(pending[0].reservations, before[0].reservations, "pending admission grants neither media nor quota");
        assert.ok(heldResponse); heldResponse(); heldResponse = null;
        await receiver.waitForFunction(() => window.fixture.snapshot().loading.state !== "pending");
        const loaded = await receiver.evaluate(() => window.fixture.snapshot().loading);
        assert.equal(loaded.state, "complete"); results.push(loaded.result);
      } else results.push(await receiver.evaluate(sn => window.fixture.load(sn), generation + 1));
      checkLoad(results.at(-1), payload.length);
      const after = await Promise.all(pages.map(page => page.evaluate(() => window.fixture.snapshot()))); retained(after);
      assert.equal(after[0].bytes.uploaded, payload.length * (generation + 1));
      assert.equal(after[0].bytes.uploadRemaining, payload.length * (5 - generation));
      assert.deepEqual(after[0].reservations, Array(generation + 1).fill(payload.length));
      assert.equal(after[1].bytes.uploaded, 0); assert.deepEqual(after[1].reservations, []);
      windows.push({ generation, before, pending, after });
    }
    // A real online rejection must still close the native link and return no
    // peer bytes. The loader's ordinary origin fallback owns final delivery.
    revoked = true;
    const beforeRejection = verifications.length;
    const denied = await receiver.evaluate(() => window.fixture.load(5)); checkLoad(denied, 0);
    await holder.waitForFunction(() => window.fixture.snapshot().peers.linksClosed === 1);
    const rejected = await holder.evaluate(() => window.fixture.snapshot());
    assert.equal(rejected.transport.counters["link-close"].admission, 1);
    assert.equal(rejected.bytes.uploaded, payload.length * 4); assert.equal(rejected.reservations.length, 4);
    assert.ok(verifications.slice(beforeRejection).some(record => record.observer === "holder" && record.ticket === "receiver-3" && record.completed && !record.admitted), "a later upload rechecks the renewed credential online");
    assert.deepEqual(mediaRequests.filter(record => record.role === "receiver"), [{ path: "/media/segment-5.m4s", role: "receiver" }]);
    const stopped = await Promise.all(pages.map(page => page.evaluate(() => window.fixture.stop())));
    assert.ok(stopped.every(value => value.accepted === 0 && value.states.every(state => state === "closed"))); assert.deepEqual(errors, []);
    return { ok: true, at: new Date().toISOString(), fixture: "Two Chrome contexts, local Nostr/HTTP admission, native SCTP and WASM; synthetic bytes, no video/TURN/public-NAT or R70 qualification",
      browserVersion: browser.version(), sourceSHA256, wasmSha256: sha256(wasm), payloadBytes: payload.length, payloadSha256: expectedHash,
      baseline, results, windows, denied, rejected, verifications, mediaRequests, stopped, pageErrors: errors };
  };
  const result = await Promise.race([run(), new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("Native admission renewal fixture exceeded 60 seconds.")), 60_000); })]);
  const receipt = process.argv.indexOf("--receipt");
  if (receipt >= 0) await writeFile(process.argv[receipt + 1], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ ok: result.ok, browserVersion: result.browserVersion, renewals: result.windows.length,
    verifiedPeerBytes: result.results.reduce((sum, value) => sum + value.peerBytes, 0), revokedPeerBytes: result.denied.peerBytes, stopped: result.stopped }));
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    console.error(JSON.stringify(await page.evaluate(() => window.fixture?.snapshot()).catch(() => null)));
  }
  console.error(JSON.stringify({ verifications, mediaRequests }));
  throw error;
} finally {
  clearTimeout(guard);
  await browser?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await relay?.close();
}
