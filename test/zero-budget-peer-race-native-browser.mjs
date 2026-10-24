#!/usr/bin/env node
// Native loopback protocol proof, not video, public-NAT or throughput qualification.
// Two independent browser contexts use the real HLS loader wrapper, Nostr
// signalling, Rust/WASM scheduler and native SCTP. The explicit holder warms
// its cache through ordinary prior HTTP loader requests.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { commitmentContent, commitmentPieceSize, KIND_SEGMENT_COMMITMENT } from "../src/browser/segment-commitment.mjs";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { startLocalRelay } from "./support/local-relay.mjs";

function browserFixture(createHlsSwarm) {
  const wait = async (predicate, message, ms = 12_000) => {
    const deadline = performance.now() + ms;
    while (!predicate()) {
      if (performance.now() >= deadline) throw new Error(message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  const connections = [], channels = [], trace = [], loads = [], observations = [];
  let swarm, hls, role, currentLoad = null, holdPresence = false;
  const presence = new Map(), heldPresence = [];
  class ObservedWebSocket extends WebSocket {
    constructor(...args) {
      super(...args);
      // Delay actual signed presence frames, leaving SDP signalling and the
      // native data channel untouched. HAVE can arrive before capabilities.
      this.addEventListener("message", event => {
        let frame;
        try { frame = JSON.parse(event.data); } catch { return; }
        if (frame[0] !== "EVENT" || frame[2]?.kind !== 24170) return;
        if (holdPresence) {
          heldPresence.push({ socket: this, data: event.data, pubkey: frame[2].pubkey });
          event.stopImmediatePropagation();
          return;
        }
        presence.set(frame[2].pubkey, JSON.parse(frame[2].content));
      });
    }
  }
  const readiness = keys => {
    const peers = swarm.peerConnectionDetails().map(({ pubkey }) => ({ pubkey,
      framing: presence.get(pubkey)?.transports.find(transport => transport.type === "webrtc")?.obj ?? null,
      pendingPresence: heldPresence.filter(frame => frame.pubkey === pubkey).length }));
    const cached = swarm.metrics().peers.connected === 1 && channels.some(record => record.channel.readyState === "open" && keys.every(key => record.have.has(key)));
    return { cached, ready: cached && peers.some(peer => peer.framing >= 2), peers };
  };
  const observeChannel = channel => {
    const record = { channel, have: new Set() }; channels.push(record);
    channel.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.t !== "have") return;
        if (frame.keys) record.have = new Set(frame.keys);
        for (const key of frame.add || []) record.have.add(key);
        for (const key of frame.del || []) record.have.delete(key);
      } catch {}
    });
    return channel;
  };
  class ObservedPC extends RTCPeerConnection {
    constructor(config) { super(config); connections.push(this); this.addEventListener("datachannel", event => observeChannel(event.channel)); }
    createDataChannel(...args) { return observeChannel(super.createDataChannel(...args)); }
  }
  // Observe key hashing without replacing its asynchronous implementation.
  const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = (algorithm, bytes) => {
    if (currentLoad && bytes.byteLength < 512 && new TextDecoder().decode(bytes).includes("\n/media/")) {
      trace.push({ load: currentLoad, event: "key-hash", at: performance.now() });
    }
    return nativeDigest(algorithm, bytes);
  };
  class HttpLoader {
    constructor() { this.stats = { loaded: 0, loading: { start: 0, first: 0, end: 0 } }; }
    load(context, _config, callbacks) {
      this.context = context;
      this.controller = new AbortController();
      this.pending = true;
      this.record = { name: currentLoad, bytes: 0, aborted: false, callbacks: { success: 0, abort: 0 } };
      loads.push(this.record);
      trace.push({ load: currentLoad, event: "origin-start", at: performance.now() });
      this.stats.loading.start = performance.now();
      const range = context.rangeEnd ? { Range: `bytes=${context.rangeStart || 0}-${context.rangeEnd - 1}` } : {};
      fetch(context.url, { signal: this.controller.signal, headers: range }).then(async response => {
        const chunks = [], reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!this.stats.loading.first) this.stats.loading.first = performance.now();
          chunks.push(value); this.stats.loaded += value.byteLength; this.record.bytes += value.byteLength;
          // Like a non-progressive player loader, byte counts are observable
          // without passing playable chunk data to the player.
          callbacks.onProgress?.(this.stats, context, null, response);
        }
        if (!this.pending) return;
        this.pending = false; this.stats.loading.end = performance.now(); this.stats.total = this.stats.loaded;
        const data = new Uint8Array(this.stats.loaded); let offset = 0;
        for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
        this.record.callbacks.success++;
        callbacks.onSuccess({ url: context.url, data: data.buffer }, this.stats, context, response);
      }).catch(error => {
        if (!this.pending) return;
        this.pending = false;
        callbacks.onError?.({ code: 0, text: error.message }, context, null, this.stats);
      });
    }
    abort() {
      if (!this.pending) return;
      this.pending = false; this.record.aborted = true; this.stats.aborted = true;
      this.controller.abort();
    }
    destroy() { this.abort(); }
  }
  window.fixture = {
    async start(value) {
      role = value;
      holdPresence = role === "receiver";
      const bootstrap = await fetch("/bootstrap.json").then(response => response.json());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
      } catch {}
      hls = { config: { loader: HttpLoader, progressive: false }, media: { currentTime: 0, buffered: { length: 0, start() { throw new Error("empty"); }, end() { throw new Error("empty"); } } } };
      swarm = createHlsSwarm({ mode: "peer-first", swarmId: bootstrap.swarmId, relays: [bootstrap.relay], streamEvent: bootstrap.streamEvent,
        coreWasm: "/core.wasm", multiHolder: true, zeroBudgetPeerRace: role === "receiver", serve: true,
        maxPeers: 1, maxUploadPeers: 1, maxDialsInFlight: 1, iceServers: [], RTCPeerConnectionImpl: ObservedPC, WebSocketImpl: ObservedWebSocket,
        maxPeerWaitMs: 5_000, originFallbackMs: 1_200, presenceIntervalMs: 1_000,
        maxHeldBytes: 32 * 1024 * 1024, maxUploadBytesPerSecond: 64 * 1024 * 1024, traceRequests: 512,
        segmentKey: url => new URL(url).pathname,
        getCommitment: async (context, { signal }) => {
          // A fast origin deterministically wins before metadata for that
          // object's peer arm is ready. No peer payload is fabricated.
          if (context.frag.sn === 2 && role === "receiver") await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 300);
            signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("commitment cancelled")); }, { once: true });
          });
          if (signal.aborted) throw new Error("commitment cancelled");
          return bootstrap.commitments[context.frag.sn - 1];
        },
        onPeerDelivery: value => observations.push({ bytes: value.bytes, connection: connections.indexOf(value.connection), native: value.connection instanceof RTCPeerConnection }),
      });
      swarm.attach(hls);
      await wait(() => swarm.metrics().core.state === "ready" && swarm.metrics().relays.connected === 1, "WASM/relay did not initialise");
      return { bufferedRanges: hls.media.buffered.length, core: swarm.metrics().core.state };
    },
    readiness,
    ready(keys) { return readiness(keys).ready; },
    releasePresence() {
      holdPresence = false;
      const pending = heldPresence.splice(0);
      for (const { socket, data } of pending) socket.dispatchEvent(new MessageEvent("message", { data }));
      return pending.length;
    },
    async load(sn) {
      currentLoad = `${role}-${sn}`;
      const label = currentLoad, before = swarm.metrics(), hookBefore = observations.length;
      const channelState = channels.map(({ channel, have }) => ({ readyState: channel.readyState, bufferedAmount: channel.bufferedAmount, have: [...have] }));
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
      const hash = await digest(data);
      await new Promise(resolve => setTimeout(resolve, 80));
      const after = swarm.metrics();
      currentLoad = null;
      return { label, size: data.byteLength, sha256: hash, callbacks, bufferedRanges: hls.media.buffered.length,
        origin: loads.filter(load => load.name === label), trace: trace.filter(row => row.load === label),
        hook: observations.slice(hookBefore), peerBytes: after.bytes.peerFirst - before.bytes.peerFirst,
        races: after.segments.zeroBudgetPeerRaces - before.segments.zeroBudgetPeerRaces,
        wins: after.segments.zeroBudgetPeerRaceWins - before.segments.zeroBudgetPeerRaceWins,
        linksOpened: after.peers.linksOpened, linksClosed: after.peers.linksClosed,
        connected: after.peers.connected, nativeStates: connections.map(pc => pc.connectionState),
        core: after.core, peerRequests: after.peerRequestDiagnostics.counters, errors: after.errors,
        before, channelState, eligibility: after.peerEligibilityDiagnostics, loaderTrace: swarm.trace(),
      };
    },
    diagnostics() { return { role, currentLoad, metrics: swarm?.metrics(), loaderTrace: swarm?.trace(), trace, loads,
      presence: [...presence], heldPresence: heldPresence.map(({ pubkey }) => ({ pubkey })),
      channels: channels.map(({ channel, have }) => ({ readyState: channel.readyState, bufferedAmount: channel.bufferedAmount, have: [...have] })),
      nativeStates: connections.map(pc => pc.connectionState) }; },
    async settled() {
      await wait(() => channels.every(({ channel }) => channel.readyState !== "open" || channel.bufferedAmount === 0), "native channel did not drain");
      await new Promise(resolve => setTimeout(resolve, 100));
    },
    stop() { swarm?.stop(); return connections.map(pc => pc.connectionState); },
  };
}

const root = fileURLToPath(new URL("../", import.meta.url));
const payload = Uint8Array.from({ length: 6 * 1024 * 1024 }, (_, index) => (index * 131 + 17) % 251);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const expectedHash = sha256(payload), pieceSize = commitmentPieceSize(payload.length), pieces = [];
for (let at = 0; at < payload.length; at += pieceSize) pieces.push(sha256(payload.subarray(at, at + pieceSize)));
const secret = generateSecretKey(), swarmId = `native-cached-race-${randomBytes(8).toString("hex")}`;
const now = Math.floor(Date.now() / 1000);
const streamEvent = finalizeEvent({ kind: 30311, created_at: now, tags: [["d", "native-cached-race"], ["relayswarm", "redistribute", "1"]], content: "" }, secret);
const keys = [1, 2, 3].map(sn => sha256(`${swarmId}\n/media/segment-${sn}.m4s`));
const commitments = keys.map((key, index) => finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: now, tags: [["x", swarmId], ["e", streamEvent.id]],
  content: commitmentContent({ v: 3, streamEventId: streamEvent.id, swarmId, key, sequence: index + 1, discontinuity: 0, part: null,
    rendition: "/media/index.m3u8", playlist: "/media/index.m3u8", mediaType: "main", encryption: null,
    sha256: expectedHash, size: payload.length, expiresAt: now + 240, pieceSize, pieces }) }, secret));
const wasm = await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url));
const bundle = await build({ stdin: { contents: `import { createHlsSwarm } from './src/browser/hls-swarm.mjs';\n(${browserFixture.toString()})(createHlsSwarm);`, resolveDir: root }, bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent" });
const requests = [], timers = new Set();
let relay, server, browser, guard, pages = [];
const results = [], errors = [];
const receiptIndex = process.argv.indexOf("--receipt");
const saveReceipt = async value => {
  if (receiptIndex >= 0) await writeFile(process.argv[receiptIndex + 1], `${JSON.stringify(value, null, 2)}\n`);
};
try {
  relay = await startLocalRelay({ replayEphemeral: false });
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") return response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><title>Native cached race protocol fixture</title><script type="module" src="/fixture.mjs"></script>');
    if (url.pathname === "/fixture.mjs") return response.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles[0].contents);
    if (url.pathname === "/core.wasm") return response.writeHead(200, { "content-type": "application/wasm" }).end(wasm);
    if (url.pathname === "/bootstrap.json") return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ swarmId, streamEvent, commitments, relay: relay.url }));
    if (!/^\/media\/segment-[123]\.m4s$/u.test(url.pathname)) return response.writeHead(404).end();
    const record = { path: url.pathname, role: url.searchParams.get("role"), range: request.headers.range ?? null, written: 0, closed: false, finished: false };
    requests.push(record);
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length, "cache-control": "no-store" });
    response.on("finish", () => { record.finished = true; });
    response.on("close", () => { record.closed = true; if (record.timer) { clearTimeout(record.timer); timers.delete(record.timer); } });
    if (record.role !== "receiver" || url.pathname.endsWith("-2.m4s")) { record.written = payload.length; return response.end(payload); }
    const send = () => {
      if (response.destroyed) return;
      const end = Math.min(payload.length, record.written + 65_536);
      response.write(payload.subarray(record.written, end)); record.written = end;
      if (end === payload.length) return response.end();
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 24);
      record.timer = timer; timers.add(timer);
    };
    send();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true,
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const contexts = await Promise.all([browser.newContext({ permissions: ["microphone"] }), browser.newContext({ permissions: ["microphone"] })]);
  pages = await Promise.all(contexts.map(context => context.newPage()));
  pages.forEach(page => page.on("pageerror", error => errors.push(error.message)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await Promise.all(pages.map(page => page.goto(base)));
  await Promise.all(pages.map(page => page.waitForFunction(() => !!window.fixture)));
  const run = async () => {
    await pages[0].evaluate(() => window.fixture.start("holder"));
    for (const sn of [1, 2, 3]) {
      const warm = await pages[0].evaluate(sn => window.fixture.load(sn), sn);
      assert.equal(warm.sha256, expectedHash); assert.equal(warm.size, payload.length);
    }
    await pages[1].evaluate(() => window.fixture.start("receiver"));
    await pages[1].waitForFunction(keys => {
      const state = window.fixture.readiness(keys);
      return state.cached && state.peers.some(peer => peer.pendingPresence > 0);
    }, keys, { timeout: 15_000 });
    const beforePresence = await pages[1].evaluate(keys => ({ ...window.fixture.readiness(keys), ready: window.fixture.ready(keys) }), keys);
    assert.equal(beforePresence.cached, true, "native connection already advertises all cached objects");
    assert.equal(beforePresence.ready, false, "HAVE alone is insufficient before framing capabilities arrive");
    assert.ok(beforePresence.peers.every(peer => peer.framing === null));
    const releasedPresence = await pages[1].evaluate(() => window.fixture.releasePresence());
    assert.ok(releasedPresence > 0);
    await pages[1].waitForFunction(keys => window.fixture.ready(keys), keys, { timeout: 15_000 });
    const afterPresence = await pages[1].evaluate(keys => window.fixture.readiness(keys), keys);
    for (const sn of [1, 2, 3]) {
      const result = await pages[1].evaluate(sn => window.fixture.load(sn), sn);
      // Retain the failing load as well as earlier successes in CI artefacts.
      results.push(result);
      assert.equal(result.size, payload.length); assert.equal(result.sha256, expectedHash);
      assert.deepEqual(result.callbacks, { success: 1, error: 0, abort: 0 });
      assert.equal(result.bufferedRanges, 0); assert.equal(result.connected, 1);
      assert.equal(result.core.links.wasm, 1); assert.equal(result.core.links.js, 0);
      assert.equal(result.origin.length, 1, "each load creates exactly one normal HTTP loader");
      const originIndex = result.trace.findIndex(row => row.event === "origin-start");
      const keyIndex = result.trace.findIndex(row => row.event === "key-hash");
      assert.ok(originIndex >= 0 && keyIndex > originIndex, "normal HTTP starts before asynchronous segment-key hashing");
      if (sn === 2) {
        assert.equal(result.peerBytes, 0); assert.deepEqual(result.hook, []); assert.equal(result.wins, 0);
        assert.equal(result.origin[0].bytes, payload.length); assert.equal(result.origin[0].aborted, false);
      } else {
        assert.equal(result.races, 1); assert.equal(result.wins, 1); assert.equal(result.peerBytes, payload.length);
        assert.equal(result.hook.reduce((sum, value) => sum + value.bytes, 0), payload.length);
        assert.ok(result.hook.every(value => value.native && value.connection >= 0));
        assert.equal(result.origin[0].aborted, true);
        assert.ok(result.origin[0].bytes > 0 && result.origin[0].bytes < payload.length, "peer winner aborts a genuinely partial origin response");
      }
      await Promise.all(pages.map(page => page.evaluate(() => window.fixture.settled())));
    }
    assert.equal(results[0].hook[0].connection, results[2].hook[0].connection, "next peer load uses the same native connection");
    assert.equal(results[2].linksOpened, results[0].linksOpened); assert.equal(results[2].linksClosed, 0);
    await new Promise(resolve => setTimeout(resolve, 150));
    const receiverRequests = requests.filter(record => record.role === "receiver");
    assert.equal(receiverRequests.length, 3, "peer-only races never create a second HTTP request");
    assert.ok(receiverRequests.every(record => record.range === null));
    for (const record of receiverRequests.filter(record => !record.path.endsWith("-2.m4s"))) {
      assert.ok(record.closed && !record.finished && record.written < payload.length, "aborted origin response stops producing its remaining body");
    }
    const stopped = await Promise.all(pages.map(page => page.evaluate(() => window.fixture.stop())));
    assert.ok(stopped.flat().every(state => state === "closed")); assert.deepEqual(errors, []);
    return { ok: true, at: new Date().toISOString(), fixture: "Two independent Chrome contexts, local Nostr signalling, native SCTP and WASM; synthetic protocol data, not video/NAT qualification",
      browserVersion: browser.version(), payloadBytes: payload.length, sha256: expectedHash, pieceSize,
      presenceReadiness: { beforePresence, releasedPresence, afterPresence }, results, requests: requests.map(({ timer, ...record }) => record), stopped, pageErrors: errors };
  };
  const result = await Promise.race([run(), new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("Native cached race fixture exceeded 60 seconds.")), 60_000); })]);
  await saveReceipt(result);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  let diagnosticGuard;
  let diagnostics;
  try {
    diagnostics = await Promise.race([
      Promise.allSettled(pages.map(page => page.evaluate(() => window.fixture?.diagnostics()))),
      new Promise(resolve => { diagnosticGuard = setTimeout(() => resolve([{ status: "rejected", reason: "Browser diagnostics exceeded 2 seconds." }]), 2_000); }),
    ]);
  } finally { clearTimeout(diagnosticGuard); }
  const failure = { ok: false, at: new Date().toISOString(), browserVersion: browser?.version(),
    error: { name: error.name, message: error.message, stack: error.stack }, results,
    diagnostics: diagnostics.map(result => result.status === "fulfilled" ? result.value : { error: String(result.reason) }),
    requests: requests.map(({ timer, ...record }) => record), pageErrors: errors };
  await saveReceipt(failure);
  console.error(JSON.stringify(failure, null, 2));
  throw error;
} finally {
  clearTimeout(guard); for (const timer of timers) clearTimeout(timer);
  await browser?.close();
  server?.closeAllConnections();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await relay?.close();
}
