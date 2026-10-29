import { createObservation, publicTimeline } from "./support/broadcast-availability-observer.mjs";
import { transform } from "./support/broadcast-availability-transform.mjs";
import { extractFinal } from "./support/broadcast-final-extraction.mjs";
import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { installFmp4StartupObserver } from "./support/fmp4-startup-observer.mjs";
import { observedFmp4Client } from "./support/fmp4-observed-demo.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import ActualHls from "hls.js";
import { webcrypto } from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountBudgetControls } from "../demo/account-budget.mjs";
import { createOperatorControls } from "../demo/operator.mjs";

const bundle = await build({ entryPoints: ["demo/client.mjs"], bundle: true, write: false, format: "esm", plugins: [{ name: "fixture", setup(builder) {
  builder.onResolve({ filter: /^(hls\.js|\.\.\/src\/browser\/hls-swarm\.mjs)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path === "hls.js" ? `export default class Hls { static version='fixture'; static Events={MANIFEST_PARSED:'manifest',FRAG_LOADED:'fragment',LEVEL_SWITCHED:'level',LEVEL_UPDATED:'update',ERROR:globalThis.fixture.hlsErrorEvent}; static DefaultConfig=globalThis.fixture.hlsDefaults; static isSupported(){return !globalThis.fixture.nativeHls;} constructor(config){this.config={...Hls.DefaultConfig,...config};this.callbacks=new Map();this.levels=[];this.id=globalThis.fixture.players.length;globalThis.fixture.players.push(this);} on(name,callback){this.callbacks.set(name,callback);} emit(name,data){this.callbacks.get(name==='error'?Hls.Events.ERROR:name)?.('',data);} loadSource(){globalThis.fixture.sourceLoads++;globalThis.fixture.playerOperations.push(['load-source',this.id]);} attachMedia(){} destroy(){this.destroyImpl?.();this.destroyed=true;globalThis.fixture.playerOperations.push(['destroy',this.id]);} stopLoad(){globalThis.fixture.playerOperations.push(['stop',this.id]);} startLoad(){globalThis.fixture.playerOperations.push(['start',this.id]);} recoverMediaError(){globalThis.fixture.playerOperations.push(['recover',this.id]);} }` : `export function createHlsSwarm(options){ const record={options, uploaded:0, tickets:[], lifecycle:new AbortController()}; globalThis.fixture.swarms.push(record); return { stop(){record.stopped=true;record.lifecycle.abort();}, updateTicket(ticket){if(record.stopped||globalThis.fixture.rejectTicketUpdates||globalThis.fixture.disabledSwarm)return false; options.ticket=ticket; record.tickets.push(ticket); return true;}, attach(hls){if(globalThis.fixture.disabledSwarm)return;hls.config.fLoader=options.mode==='off'?undefined:'swarm';}, trace(){return {v:1,capacity:options.traceRequests,dropped:0,rows:[{k:'load',load:globalThis.fixture.swarms.indexOf(record)}]};}, metrics(){return {mode:globalThis.fixture.disabledSwarm?'off':options.mode, disabledReason:globalThis.fixture.disabledSwarm?'no-webrtc':null, serving:!globalThis.fixture.disabledSwarm&&options.serve, bytes:{uploaded:record.uploaded,peerFirst:0},segments:{peerFirstLoaded:0},peers:{connected:0}};} }; }` }));
} }] });
async function page(storage = new Map(), { realClock = false, fetchImpl, nativeHls = false, initialTurnCredentials, inlinePolicySession = false, hlsDefaults = ActualHls.DefaultConfig, search = "" } = {}) {
  const elements = new Map(), intervals = [], timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  let clock = 0; const wallStart = Date.now(), performanceStart = performance.now();
  const now = () => realClock ? performance.now() - performanceStart : clock;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [ClockDate.now()])); } static now() { return wallStart + now(); } }
  const element = (id) => { if (!elements.has(id)) elements.set(id, { value: "", checked: false, disabled: false, addEventListener(name, callback) { this[name] = callback; }, append() {} }); return elements.get(id); };
  element("start").disabled = true;
  element("mode").value = "off"; element("limit").value = "512000"; element("allowance").value = "100000000";
  element("account-method").value = "nostr"; element("account-allowance").value = "100000000";
  const videoEvents = new Map();
  const video = { paused: true, currentTime: 0, readyState: 0, error: null,
    addEventListener(name, callback) { videoEvents.set(name, callback); },
    play() { fixture.playCalls++; video.paused = false; return fixture.playImpl ? fixture.playImpl() : Promise.resolve(); },
    pause() { fixture.pauseCalls++; video.paused = true; }, load() { fixture.nativeLoads++; video.error = null; video.readyState = 0; },
    canPlayType: () => nativeHls };
  const fixture = { nativeHls, hlsDefaults, hlsErrorEvent: ActualHls.Events.ERROR, swarms: [], players: [], playerOperations: [], playCalls: 0, pauseCalls: 0, nativeLoads: 0, sourceLoads: 0, policy: { mode: null, revision: 0, telemetry: false }, session: { v: 1, swarmId: "old", streamEvent: { id: "old" }, relays: [], manifest: "/media/index.m3u8", commitmentEndpoint: "/commitment", ...(initialTurnCredentials === undefined ? {} : { turnCredentials: initialTurnCredentials }) } };
  if (inlinePolicySession) Object.assign(fixture.session, { deliveryPolicyEndpoint: "/delivery-policy.json?session=1", deliveryPolicySession: "inline-v1" });
  fixture.requests = [];
  const context = { Date: ClockDate, fixture, location: { origin: "https://viewer.example", search }, document: { visibilityState: "visible", createElement: () => ({}), addEventListener(name, callback) { documentEvents.set(name, callback); }, getElementById: element, querySelector: () => video }, navigator: { locks: { request: async (_name, _options, callback) => callback() } }, crypto: webcrypto, localStorage: { getItem: (name) => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) }, performance: { now }, isSecureContext: true, URL, URLSearchParams, AbortSignal, AbortController, structuredClone, TextDecoder, TextEncoder, queueMicrotask, console,
    fetch: async (url, init) => { fixture.requests.push({ url, init }); if (fetchImpl) return fetchImpl(url, init); if (fixture.response) { const response = await fixture.response(url, init); if (response) return response; } const value = fixture.fetch ? await fixture.fetch(url, init) : url === "/session.json" ? fixture.session : inlinePolicySession ? { ...fixture.policy, session: fixture.session } : fixture.policy; return { ok: true, json: async () => structuredClone(value) }; },
    setTimeout(callback, ms) { const id = realClock ? setTimeout(() => { timers.delete(id); callback(); }, ms) : Symbol(); timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { if (realClock) clearTimeout(id); timers.delete(id); },
    setInterval(callback, ms) { intervals.push({ callback, ms }); }, clearInterval() {}, window: { addEventListener(name, callback) { windowEvents.set(name, callback); } } };
  await vm.runInNewContext(`(async()=>{${bundle.outputFiles[0].text}})()`, context);
  return { fixture, element, context, video, videoEvent: name => videoEvents.get(name)?.(), sendReport: () => intervals.find(entry => entry.ms === 15000).callback(), fireTimer(matches) { const entries = [...timers].filter(([, row]) => matches(row.ms)); assert.equal(entries.length, 1); const [id, row] = entries[0]; timers.delete(id); row.callback(); }, close() { windowEvents.get("pagehide")?.(); if (realClock) for (const id of timers.keys()) clearTimeout(id); timers.clear(); }, jumpWithoutTimers(ms) { clock += ms; }, windowEvent: (name) => windowEvents.get(name)?.(), visibility(state) { context.document.visibilityState = state; documentEvents.get("visibilitychange")?.(); }, submit: () => element("settings").submit({ preventDefault() {} }), poll: () => intervals.find((entry) => entry.ms === 2000).callback() };
}

async function playlistRetryFixture(t, { live = true, errorRetry = ActualHls.DefaultConfig.playlistLoadPolicy.default.errorRetry, defaults = false } = {}) {
  const loads = [];
  class Transport {
    constructor() { this.stats = { loading: { start: 0, first: 0, end: 0 }, retry: 0, loaded: 0 }; }
    load(context, config, callbacks) { Object.assign(this, { context, config, callbacks }); loads.push(this); }
    abort() { this.aborted = true; }
    destroy() { this.destroyed = true; }
  }
  const p = await page(new Map(), { hlsDefaults: { ...ActualHls.DefaultConfig, loader: Transport,
    playlistLoadPolicy: { default: { ...ActualHls.DefaultConfig.playlistLoadPolicy.default, errorRetry } } } });
  await p.submit(); const mounted = p.fixture.players[0]; mounted.latestLevelDetails = { live };
  const timers = new Map();
  const scope = { performance: p.context.performance, URL, console,
    setTimeout(callback, delay) { const id = Symbol(); timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const inScope = callback => {
    const previous = globalThis.self; globalThis.self = scope;
    try { return callback(); } finally { if (previous === undefined) delete globalThis.self; else globalThis.self = previous; }
  };
  // Obtain the installed, compiled LevelController without loading a source,
  // attaching media or starting any I/O. It is not an emulated retry method.
  const probe = inScope(() => new ActualHls({ autoStartLoad: false, enableWorker: false }));
  const LevelController = probe.levelController.constructor; inScope(() => probe.destroy());
  const events = new EventEmitter(), bindings = new Map(); let stops = 0;
  const host = {
    logger: Object.fromEntries(["debug", "log", "warn", "info", "error"].map(name => [name, () => {}])),
    config: { ...mounted.config, ...(defaults ? { playlistLoadPolicy: p.fixture.hlsDefaults.playlistLoadPolicy, errorController: ActualHls.DefaultConfig.errorController } : {}), preserveManualLevelOnError: true },
    levels: [{ url: ["https://viewer.example/media/high/index.m3u8"], uri: "https://viewer.example/media/high/index.m3u8", loadError: 0, fragmentError: 0, details: { live, requestScheduled: 0 }, attrs: {} }],
    loadLevel: 0, currentLevel: 0, minAutoLevel: 0, maxAutoLevel: 0, autoLevelEnabled: false,
    on(name, callback, owner) { const bound = owner ? callback.bind(owner) : callback; bindings.set(callback, bound); events.on(name, bound); },
    off(name, callback) { events.off(name, bindings.get(callback) ?? callback); },
    trigger(name, data) { inScope(() => events.emit(name, name, data)); },
    stopLoad() { stops++; controller.stopLoad(); level.stopLoad(); },
  };
  const controller = new host.config.errorController(host), level = new LevelController(host, null);
  level.currentLevelIndex = 0; level.currentLevel = host.levels[0]; level._levels = host.levels; level.canLoad = true;
  host.on(ActualHls.Events.ERROR, controller.onErrorOut, controller);
  t.after(() => { inScope(() => { level.destroy(); controller.destroy(); }); p.close(); });
  function failure(code = 502, type = "level", url = "https://viewer.example/media/high/index.m3u8", details = ActualHls.ErrorDetails.LEVEL_LOAD_ERROR) {
    const context = { type, level: 0, url }; let result;
    const Loader = mounted.config.pLoader ?? mounted.config.loader, loader = new Loader(mounted.config);
    loader.load(context, { loadPolicy: host.config.playlistLoadPolicy.default }, {
      onError(response, actualContext) {
        result = { type: ActualHls.ErrorTypes.NETWORK_ERROR, details, fatal: false, context: actualContext, response: { url, ...response } };
        host.trigger(ActualHls.Events.ERROR, result); mounted.emit("error", result);
      },
    });
    if (!result) loader.callbacks.onError({ code, text: "Fixture response" }, context, null, loader.stats);
    return result;
  }
  let timedResult;
  host.on(ActualHls.Events.LEVEL_LOADING, (_event, data) => { timedResult = failure(502, "level", data.url); });
  return { p, mounted, host, controller, level, timers, loads, failure, inScope, stops: () => stops,
    fireRetry() { assert.equal(timers.size, 1); const { callback } = [...timers.values()][0]; inScope(callback); return timedResult; },
    updated() { const details = { live }; mounted.latestLevelDetails = details; host.trigger(ActualHls.Events.LEVEL_UPDATED, { details }); mounted.emit("update", { details }); },
  };
}

test("established live playlist retries survive transient restart responses through the real HLS error controller", async (t) => {
  const f = await playlistRetryFixture(t); f.updated();
  for (let second = 0; second <= 40; second += 5) {
    if (second) f.p.jumpWithoutTimers(5000);
    const error = f.failure(second % 10 ? 503 : 502);
    assert.equal(error.fatal, false, "a bounded established-live outage must not exhaust the default two retries");
    assert.equal(error.errorAction.action, 5, "the real controller must choose RetryRequest");
  }
  f.updated();
  assert.equal(f.stops(), 0); assert.equal(f.p.context.window.relaySwarmDemo.report().player.fatalErrors, 0);
  assert.equal(f.p.context.window.relaySwarmDemo.report().player.errorRecords.length, 9, "real nonfatal network errors remain recorded");
  assert.equal(f.failure(504).errorAction.retryCount, 0, "successful LEVEL_UPDATED starts a new episode");
  f.p.jumpWithoutTimers(50000); assert.equal(f.failure(503).fatal, false, "the new episode is independent of the old sixty-second end");
});

test("live playlist original full-chain control exhausts its two retries", async (t) => {
  const f = await playlistRetryFixture(t, { defaults: true }); f.updated();
  assert.equal(f.failure().fatal, false); assert.equal(f.failure().fatal, false); assert.equal(f.failure().fatal, true);
  assert.equal(f.stops(), 1); assert.equal(f.timers.size, 0);
});

test("live playlist retry horizon survives quality-counter resets and still records exhaustion as fatal", async (t) => {
  const f = await playlistRetryFixture(t); f.updated();
  f.failure(); f.p.jumpWithoutTimers(1000); f.failure(); f.p.jumpWithoutTimers(2000); f.failure();
  f.controller.stopLoad(); // hls.js also resets its retry count when changing level.
  f.p.jumpWithoutTimers(50000); assert.equal(f.failure().fatal, false);
  f.p.jumpWithoutTimers(5000); assert.equal(f.failure().fatal, true, "the next two-second delay cannot equal the first failure's60s end");
  assert.equal(f.p.context.window.relaySwarmDemo.report().player.fatalErrors, 1);
  const before = f.loads.length; assert.equal(f.failure().fatal, true);
  assert.equal(f.loads.length, before, "exhaustion cannot restart underlying I/O");
});

test("live playlist retries cap eligible attempts even when HLS resets its counter", async (t) => {
  const f = await playlistRetryFixture(t); f.updated();
  for (let attempt = 1; attempt < 32; attempt++) {
    f.controller.stopLoad(); assert.equal(f.failure().fatal, false);
  }
  f.controller.stopLoad(); assert.equal(f.failure().fatal, true);
  const before = f.loads.length; f.failure(); assert.equal(f.loads.length, before);
});

test("live playlist hidden before extension and original timeout exhaustion remain terminal", async (t) => {
  await t.test("hidden before third failure", async t => {
    const f = await playlistRetryFixture(t); f.updated(); f.failure(); f.failure(); f.p.visibility("hidden");
    assert.equal(f.failure().fatal, true); assert.equal(f.stops(), 1);
    f.p.visibility("visible"); assert.equal(f.failure().fatal, true, "visibility cannot renew the outage horizon");
  });
  await t.test("original timeout policy", async t => {
    const f = await playlistRetryFixture(t); f.updated();
    const fail = () => f.failure(503, "level", undefined, ActualHls.ErrorDetails.LEVEL_LOAD_TIMEOUT);
    assert.equal(fail().fatal, false); assert.equal(fail().fatal, false); assert.equal(fail().fatal, true);
  });
  for (const errorRetry of [null, { ...ActualHls.DefaultConfig.playlistLoadPolicy.default.errorRetry, shouldRetry: () => false }]) {
    await t.test(errorRetry ? "custom policy refusal" : "disabled error retries", async t => {
      const baseline = await playlistRetryFixture(t, { errorRetry, defaults: true }); baseline.updated();
      const expected = Array.from({ length: 3 }, () => baseline.failure().fatal);
      const f = await playlistRetryFixture(t, { errorRetry }); f.updated();
      assert.deepEqual(Array.from({ length: 3 }, () => f.failure().fatal), expected);
    });
  }
});

test("live playlist extended dispatch refuses late, hidden and retired work without hanging a load", async (t) => {
  for (const reason of ["late", "hidden", "retired"]) {
    await t.test(reason, async t => {
      const f = await playlistRetryFixture(t); f.updated(); f.failure(); f.failure(); f.failure();
      if (reason === "late") f.p.jumpWithoutTimers(60000);
      if (reason === "hidden") f.p.visibility("hidden");
      if (reason === "retired") f.p.element("resume").click();
      const before = f.loads.length, error = f.fireRetry();
      assert.equal(f.loads.length, before, "a delayed HLS retry must be fenced before transport.load");
      assert.equal(error.fatal, true, "the real controller receives a terminal completion, not an unresolved load");
      assert.equal(f.timers.size, 0, "terminal dispatch cannot schedule fallback retries");
      if (reason === "hidden") { f.p.visibility("visible"); f.failure(); assert.equal(f.loads.length, before, "visibility alone cannot reopen the closed episode"); }
      if (reason === "retired") assert.equal(f.p.context.window.relaySwarmDemo.report().player.fatalErrors, 0, "retired callbacks cannot corrupt the new player's receipt");
      const Loader = f.mounted.config.pLoader;
      new Loader(f.mounted.config).load({ type: "manifest", url: "https://viewer.example/manifest.m3u8" }, {}, { onError() { assert.fail("ordinary manifest dispatch was intercepted"); } });
      assert.equal(f.loads.length, before + 1, "manifest requests keep the original loader path");
    });
  }
});

test("live playlist retry policy preserves startup, VOD, other statuses and unrelated load policies", async (t) => {
  for (const scenario of ["startup", "vod", 400, 401, 403, 404, 500]) {
    await t.test(String(scenario), async t => {
      const f = await playlistRetryFixture(t, { live: scenario !== "vod" });
      if (scenario === "startup") f.mounted.latestLevelDetails = undefined;
      const status = typeof scenario === "number" ? scenario : 503;
      const baseline = await playlistRetryFixture(t, { live: scenario !== "vod", defaults: true });
      if (scenario === "startup") baseline.mounted.latestLevelDetails = undefined;
      const trace = value => Array.from({ length: 3 }, () => {
        const error = value.failure(status);
        return { fatal: error.fatal, action: error.errorAction.action, resolved: error.errorAction.resolved === true, retries: error.errorAction.retryCount, maximum: error.errorAction.retryConfig?.maxNumRetry, delays: [...value.timers.values()].map(row => row.delay) };
      });
      assert.deepEqual(trace(f), trace(baseline), "ordinary decisions and real LevelController schedules match unmodified HLS");
      const defaults = ActualHls.DefaultConfig;
      assert.equal(f.mounted.config.playlistLoadPolicy.default.timeoutRetry, defaults.playlistLoadPolicy.default.timeoutRetry);
      for (const name of ["manifestLoadPolicy", "fragLoadPolicy", "keyLoadPolicy"]) assert.equal(f.mounted.config[name], defaults[name]);
      assert.equal(f.mounted.config.playlistLoadPolicy.default.maxLoadTimeMs, defaults.playlistLoadPolicy.default.maxLoadTimeMs);
      assert.equal(f.mounted.config.playlistLoadPolicy.default.maxTimeToFirstByteMs, defaults.playlistLoadPolicy.default.maxTimeToFirstByteMs);
      assert.equal(defaults.playlistLoadPolicy.default.errorRetry.maxNumRetry, 2, "global HLS defaults stay immutable");
    });
  }
});

test("inline policy snapshots use one renewal GET without changing the authority bounds", async () => {
  const p = await page(new Map(), { inlinePolicySession: true });
  try {
    assert.deepEqual(p.fixture.requests.map(row => row.url), ["/session.json", "/delivery-policy.json?session=1"]);
    p.fixture.requests.length = 0; await p.poll();
    assert.deepEqual(p.fixture.requests.map(row => row.url), ["/delivery-policy.json?session=1"]);
    assert.equal(p.fixture.requests[0].init.cache, "no-store");
    const r = p.context.window.relaySwarmDemo.report();
    assert.equal(r.policyRenewal.lifetimeMs, 5000); assert.equal(r.policyRenewal.maxPending, 3);
    assert.equal(r.policyRenewal.fresh, true); assert.equal(p.element("upload").checked, false);
    assert.equal(Object.hasOwn(r.deliveryPolicy, "session"), false, "Do not duplicate the public session in numeric policy reports");
  } finally { p.close(); }
});

test("inline policy snapshots reject missing or incompatible sessions without a legacy fallback", async () => {
  for (const malformed of [undefined, null, {}, { v: 2 }, { manifest: "/other.m3u8" }, { iceTransportPolicy: "invalid" }, { turnCredentials: {} }, { deliveryPolicySession: undefined }, { deliveryPolicySession: "future" }]) {
    const p = await page(new Map(), { inlinePolicySession: true });
    try {
      p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
      const current = malformed && Object.keys(malformed).length ? { ...p.fixture.session, ...malformed } : malformed;
      p.fixture.fetch = () => ({ ...p.fixture.policy, session: current }); p.fixture.requests.length = 0;
      assert.equal(await p.poll(), false);
      const r = p.context.window.relaySwarmDemo.report();
      assert.equal(r.policyRenewal.fresh, false); assert.equal(r.current.mode, "off"); assert.equal(p.element("upload").checked, false);
      assert.deepEqual(p.fixture.requests.map(row => row.url), ["/delivery-policy.json?session=1"]);
    } finally { p.close(); }
  }
});

test("inline policy OFF revokes upload and reporting before inspecting a malformed session", async () => {
  const p = await page(new Map(), { inlinePolicySession: true }); let inspected = false;
  try {
    p.fixture.policy = { mode: null, revision: 1, telemetry: true }; await p.poll();
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit(); p.element("telemetry").checked = true;
    p.fixture.response = async () => ({ ok: true, json: async () => ({ mode: "off", revision: 2, telemetry: false,
      get session() { inspected = true; assert.equal(p.element("upload").checked, false); assert.equal(p.element("telemetry").checked, false); throw new Error("Malformed inline session"); } }) });
    assert.equal(await p.poll(), false); assert.equal(inspected, true);
    const r = p.context.window.relaySwarmDemo.report();
    assert.equal(r.current.mode, "off"); assert.equal(r.policyRenewal.fresh, false);
  } finally { p.close(); }
});

test("inline policy expiry rejects late success and never restores upload consent or spent allowance", async () => {
  const p = await page(new Map(), { inlinePolicySession: true }); let release;
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const active = p.fixture.swarms.at(-1); assert.equal(await active.options.reserveUploadBytes(1234), true); active.uploaded = 1234;
    p.fixture.fetch = () => new Promise(resolve => { release = () => resolve({ ...p.fixture.policy, session: p.fixture.session }); });
    const pending = p.poll(); for (let n = 0; n < 30 && !release; n++) await Promise.resolve(); assert.ok(release);
    p.jumpWithoutTimers(5001); assert.equal(p.context.window.relaySwarmDemo.report().policyRenewal.fresh, false);
    release(); assert.equal(await pending, false); assert.equal(p.element("upload").checked, false);
    p.fixture.fetch = undefined; assert.equal(await p.poll(), true);
    const r = p.context.window.relaySwarmDemo.report(); assert.equal(r.uploadBudget.spent, 1234); assert.equal(r.current.metrics.serving, false);
  } finally { release?.(); p.close(); }
});

test("inline policy pending checks remain capped at three and suspension rejects their late completion", async () => {
  const p = await page(new Map(), { inlinePolicySession: true }), releases = [];
  try {
    p.fixture.fetch = () => new Promise(resolve => releases.push(() => resolve({ ...p.fixture.policy, session: p.fixture.session })));
    p.fixture.requests.length = 0;
    const pending = [p.poll(), p.poll(), p.poll()]; for (let n = 0; n < 30 && releases.length < 3; n++) await Promise.resolve();
    assert.equal(releases.length, 3); assert.equal(await p.poll(), false); assert.equal(p.fixture.requests.length, 3);
    assert.equal(p.context.window.relaySwarmDemo.report().policyRenewal.pending, 3);
    p.visibility("hidden"); for (const release of releases) release();
    assert.deepEqual(await Promise.all(pending), [false, false, false]);
    assert.equal(p.context.window.relaySwarmDemo.report().policyRenewal.fresh, false);
  } finally { for (const release of releases) release(); p.close(); }
});

test("inline policy stale identity cannot reinstall an older snapshot after a newer commit", async () => {
  const p = await page(new Map(), { inlinePolicySession: true }); let release;
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const oldSession = structuredClone(p.fixture.session);
    p.fixture.fetch = () => new Promise(resolve => { release = () => resolve({ ...p.fixture.policy, session: oldSession }); });
    const old = p.poll(); for (let n = 0; n < 30 && !release; n++) await Promise.resolve(); assert.ok(release);
    p.fixture.session = { ...p.fixture.session, swarmId: "new", streamEvent: { id: "new" } };
    p.fixture.policy = { mode: null, revision: 1, telemetry: false }; p.fixture.fetch = undefined;
    assert.equal(await p.poll(), true); release(); assert.equal(await old, false);
    const r = p.context.window.relaySwarmDemo.report(); assert.equal(r.stream.swarmId, "new"); assert.equal(p.element("upload").checked, false);
  } finally { release?.(); p.close(); }
});

test("inline policy admission prepared for an older identity cannot undo a committed replacement", async () => {
  const p = await page(new Map(), { inlinePolicySession: true }); let finishB, finishA;
  try {
    const descriptor = epoch => ({ issuer: "issuer", epoch, challengeEndpoint: `/challenge-${epoch}`, ticketEndpoint: `/ticket-${epoch}`, verifyEndpoint: "/verify" });
    const a = { ...p.fixture.session, admission: descriptor("a") }, b = { ...a, swarmId: "new", streamEvent: { id: "new" }, admission: descriptor("b") };
    let racing = false, reads = 0;
    const credential = s => ({ ...s.admission, swarmId: s.swarmId, challenge: "challenge", ticket: `ticket-${s.admission.epoch}`, expiresAt: Math.ceil(Date.now() / 1000) + 10 });
    p.fixture.fetch = async url => {
      if (url === "/delivery-policy.json?session=1") {
        if (racing && ++reads === 1) return new Promise(resolve => { finishB = () => resolve({ ...p.fixture.policy, session: b }); });
        return { ...p.fixture.policy, session: a };
      }
      if (racing && url === "/ticket-a") return new Promise(resolve => { finishA = () => resolve(credential(a)); });
      return credential(url.endsWith("-b") ? b : a);
    };
    await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit(); racing = true;
    const older = p.poll(); for (let n = 0; n < 30 && !finishB; n++) await Promise.resolve(); assert.ok(finishB);
    const newer = p.poll(); for (let n = 0; n < 50 && !finishA; n++) await Promise.resolve(); assert.ok(finishA);
    finishB(); await older; assert.equal(p.context.window.relaySwarmDemo.report().stream.swarmId, "new");
    finishA(); await newer;
    const r = p.context.window.relaySwarmDemo.report(); assert.equal(r.stream.swarmId, "new");
    assert.equal(p.fixture.swarms.at(-1).options.ticket, "ticket-b"); assert.equal(p.element("upload").checked, false);
    assert.ok(r.policyRenewal.records.some(row => row.outcome === "stale"));
  } finally { finishB?.(); finishA?.(); p.close(); }
});

test("Resume playback reloads native origin only on a gesture and retains earlier errors", async () => {
  const p = await page(new Map(), { nativeHls: true });
  try {
    await p.submit(); assert.equal(p.fixture.playCalls, 1);
    p.video.error = { code: 2, message: "earlier media failure" }; p.videoEvent("error");
    p.visibility("hidden"); p.windowEvent("pagehide"); p.visibility("visible"); p.windowEvent("pageshow");
    assert.equal(p.fixture.playCalls, 1, "returning to the page must not auto-play");
    assert.equal(p.fixture.nativeLoads, 0, "returning must not reload the media resource");
    p.element("upload").checked = true; p.element("telemetry").checked = true;
    p.fixture.playImpl = () => {
      assert.equal(p.fixture.nativeLoads, 1, "load precedes play in the click handler");
      assert.equal(p.video.src, p.fixture.session.manifest);
      return Promise.resolve();
    };
    p.element("resume").click(); await delay(0);
    const r = p.context.window.relaySwarmDemo.report();
    assert.equal(p.fixture.playCalls, 2); assert.equal(r.player.nativeErrors.length, 1); assert.equal(r.player.fatalErrors, 1);
    assert.equal(r.player.resumeAttempts, 1); assert.equal(r.player.resumeRecords[0].outcome, "play-request-resolved");
    assert.equal(r.current.mode, "off"); assert.equal(r.current.upload, false);
    assert.equal(p.element("upload").checked, false); assert.equal(p.element("telemetry").checked, false);
    assert.equal(p.fixture.players.length, 0);
  } finally { p.close(); }
});

test("Resume playback replaces the stopped HLS instance and requires a fresh peer Apply", async () => {
  const p = await page();
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const oldPlayer = p.fixture.players[0]; await p.fixture.swarms.at(-1).options.reserveUploadBytes(77);
    p.videoEvent("playing"); p.element("quality").value = "1"; p.element("quality").change(); assert.equal(oldPlayer.nextLevel, 1);
    oldPlayer.emit("error", { fatal: true, type: "networkError", details: "manifestLoadError" });
    p.visibility("hidden"); p.visibility("visible"); p.windowEvent("pageshow");
    assert.equal(p.fixture.players.length, 1); assert.equal(p.fixture.sourceLoads, 1); assert.equal(p.fixture.playCalls, 1);
    p.element("resume").click(); await Promise.resolve();
    const r = p.context.window.relaySwarmDemo.report();
    assert.equal(oldPlayer.destroyed, true); assert.equal(p.fixture.players.length, 2); assert.equal(p.fixture.sourceLoads, 2);
    const destroy = p.fixture.playerOperations.findIndex(row => row[0] === "destroy");
    const reload = p.fixture.playerOperations.findIndex(row => row[0] === "load-source" && row[1] === 1);
    assert(destroy >= 0 && reload > destroy, "old MSE ownership ends before loading the replacement");
    assert.equal(p.element("mode").value, "peer-first", "the viewer's choice remains available for Apply");
    assert.equal(r.current.mode, "off"); assert.equal(r.current.upload, false); assert.equal(r.uploadBudget.spent, 77);
    assert.equal(r.player.fatalErrors, 1); assert.equal(r.player.errorRecords.length, 1);
    p.element("quality").value = "1"; p.element("quality").change();
    assert.equal(p.fixture.players[1].loadLevel, 1); assert.equal(p.fixture.players[1].nextLevel, undefined, "the new player uses the startup quality setter before its first playing event");
    p.videoEvent("playing"); p.element("quality").value = "0"; p.element("quality").change(); assert.equal(p.fixture.players[1].nextLevel, 0);
    await p.poll(); assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
    await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.mode, "peer-first"); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
    assert.equal(p.fixture.sourceLoads, 2, "Apply reuses the new player rather than reloading again");
  } finally { p.close(); }
});

test("Resume playback cancels hidden queued repair without resetting its automatic budget", async () => {
  const p = await page();
  try {
    await p.submit(); const first = p.fixture.players[0];
    first.emit("error", { fatal: true, type: "mediaError", details: "bufferAppendError" });
    p.visibility("hidden"); await Promise.resolve();
    assert.equal(p.fixture.playerOperations.some(row => row[0] === "recover"), false);
    assert.equal(p.context.window.relaySwarmDemo.report().player.mediaRecovery.outcome, "cancelled");
    p.element("resume").click(); assert.equal(p.fixture.players.length, 1, "hidden clicks cannot reload or play");
    p.visibility("visible"); p.element("resume").click(); await Promise.resolve();
    const r = p.context.window.relaySwarmDemo.report();
    assert.equal(r.player.mediaRecovery.attempted, 1); assert.equal(r.player.mediaRecovery.records[0].reason, "page-hidden");
    assert.equal(p.fixture.players.length, 2); assert.equal(p.fixture.playCalls, 2);
    assert.equal(p.fixture.playerOperations.some(row => row[0] === "recover"), false);
  } finally { p.close(); }
});

test("Resume playback fences late play rejection and keeps a fresh account balance", async () => {
  const p = await accountPage(); let reject, rejectInitial;
  try {
    await p.element("account-connect").click();
    p.fixture.playImpl = () => new Promise((_resolve, no) => { rejectInitial = no; }); await p.submit();
    const before = p.context.window.relaySwarmDemo.report().accountBudget;
    p.fixture.playImpl = () => new Promise((_resolve, no) => { reject = no; });
    p.element("resume").click();
    const after = p.context.window.relaySwarmDemo.report().accountBudget;
    assert.equal(after.connected, true); assert.equal(after.spent, before.spent); assert.equal(after.revision, before.revision);
    p.fixture.playImpl = undefined; p.element("resume").click(); await delay(0);
    const message = p.element("resume-status").textContent;
    const playerStatus = p.element("status").textContent;
    reject(new Error("late rejection from replaced resource")); await delay(0);
    rejectInitial(new Error("late rejection from original Start")); await delay(0);
    assert.equal(p.element("resume-status").textContent, message);
    assert.equal(p.element("status").textContent, playerStatus);
    const r = p.context.window.relaySwarmDemo.report(); assert.equal(r.player.resumeRecords[0].superseded, true);
    assert.equal(r.player.resumeRecords[1].outcome, "play-request-resolved"); assert.equal(r.current.upload, false);
  } finally { p.close(); }
});

test("Resume playback fences every retired player callback, including synchronous destroy events", async () => {
  const p = await page();
  try {
    await p.submit(); const old = p.fixture.players[0];
    const fatal = { fatal: true, type: "mediaError", details: "bufferAppendError" };
    old.destroyImpl = () => old.emit("error", fatal);
    p.element("resume").click(); await delay(0);
    const current = p.fixture.players[1];
    current.levels = [{ height: 360, bitrate: 100000 }]; current.emit("manifest");
    const before = JSON.stringify(p.context.window.relaySwarmDemo.report().player);
    const operations = JSON.stringify(p.fixture.playerOperations), status = p.element("status").textContent;
    const quality = { value: p.element("quality").value, disabled: p.element("quality").disabled };
    old.emit("manifest"); old.emit("error", fatal);
    old.emit("update", { details: { get live() { throw new Error("Retired details must not reach recovery"); } } });
    old.emit("level", { level: 7 });
    old.emit("fragment", { frag: { sn: 1, level: 7, type: "main", cc: 1, url: "https://viewer.example/media/a.ts", stats: { loaded: 1, loading: { start: 1, end: 2 } } }, payload: new Uint8Array(1), networkDetails: {} });
    await delay(0);
    assert.equal(JSON.stringify(p.context.window.relaySwarmDemo.report().player), before);
    assert.equal(JSON.stringify(p.fixture.playerOperations), operations); assert.equal(p.fixture.playCalls, 2);
    assert.equal(p.element("status").textContent, status);
    assert.deepEqual({ value: p.element("quality").value, disabled: p.element("quality").disabled }, quality);
    assert.equal(p.context.window.relaySwarmDemo.report().player.fatalErrors, 0, "destroy-time stale errors cannot affect the replacement");
    current.emit("error", { fatal: false, type: "networkError", details: "levelLoadError" });
    assert.equal(p.context.window.relaySwarmDemo.report().player.errors.levelLoadError, 1, "current callbacks still record real errors");
  } finally { p.close(); }
});

test("hidden current-player callbacks retain errors without starting recovery or autoplay", async () => {
  const p = await page();
  try {
    await p.submit(); const current = p.fixture.players[0];
    p.visibility("hidden");
    current.emit("error", { fatal: true, type: "mediaError", details: "bufferAppendError" });
    current.emit("update", { details: { get live() { throw new Error("Hidden updates must not reach recovery"); } } });
    await delay(0);
    const hidden = p.context.window.relaySwarmDemo.report();
    assert.equal(hidden.player.fatalErrors, 1); assert.equal(hidden.player.errorRecords.length, 1);
    assert.equal(hidden.player.mediaRecovery.attempted, 0); assert.equal(p.fixture.playCalls, 1);
    assert.equal(p.fixture.playerOperations.some(row => row[0] === "recover"), false);
    p.visibility("visible"); p.windowEvent("pageshow"); await delay(0);
    assert.equal(p.fixture.playCalls, 1); assert.equal(p.context.window.relaySwarmDemo.report().player.mediaRecovery.attempted, 0);
    current.emit("error", { fatal: true, type: "mediaError", details: "bufferAppendError" }); await delay(0);
    assert.equal(p.context.window.relaySwarmDemo.report().player.mediaRecovery.attempted, 1, "a later visible error keeps the original recovery allowance");
    assert.equal(p.fixture.playerOperations.some(row => row[0] === "recover"), true);
  } finally { p.close(); }
});

test("reporting availability explains operator OFF immediately and never restores opt-in", async () => {
  const p = await page(); let release;
  try {
    await p.submit(); const reports = [];
    p.fixture.fetch = async (url, init) => {
      if (url === "/reports") { reports.push(JSON.parse(init.body)); return {}; }
      return url === "/session.json" ? p.fixture.session : p.fixture.policy;
    };
    assert.equal(p.element("telemetry").disabled, true); assert.match(p.element("telemetry-label").textContent, /switched off by this service/u);
    p.fixture.policy = { mode: null, revision: 1, telemetry: true }; await p.poll();
    assert.equal(p.element("telemetry").disabled, false); assert.equal(p.element("telemetry").checked, false);
    p.element("telemetry").checked = true; await p.sendReport(); assert.equal(reports.length, 1);
    p.fixture.policy = { mode: "off", revision: 2, telemetry: false };
    const original = p.fixture.fetch;
    p.fixture.fetch = (url, init) => url === "/session.json" ? new Promise(resolve => { release = () => resolve(p.fixture.session); }) : original(url, init);
    const pending = p.poll();
    for (let i = 0; i < 50 && !p.element("telemetry").disabled; i++) await Promise.resolve();
    assert.equal(p.element("telemetry").disabled, true); assert.equal(p.element("telemetry").checked, false);
    assert.match(p.element("telemetry-status").textContent, /No numeric measurements will be sent/u);
    await p.sendReport(); assert.equal(reports.length, 1);
    release(); await pending; p.fixture.fetch = original;
    p.fixture.policy = { mode: null, revision: 3, telemetry: true }; await p.poll(); await p.sendReport();
    assert.equal(p.element("telemetry").disabled, false); assert.equal(p.element("telemetry").checked, false); assert.equal(reports.length, 1);
  } finally { release?.(); p.close(); }
});

test("durable startup reporting changes recover policy availability without restoring consent", { skip: process.platform === "win32" }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-client-policy-restart-"))), statePath = join(directory, "operator.json");
  let controls = createOperatorControls({ statePath, telemetry: false }), p;
  t.after(async () => { p?.close(); await controls.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  await controls.ready(); p = await page(new Map(), { inlinePolicySession: true }); await p.submit();
  let unavailable = false, override, reports = 0;
  p.fixture.fetch = url => {
    if (url === "/reports") { reports++; return {}; }
    if (unavailable) throw new Error("Publisher restarting");
    return { ...(override ?? controls.policy()), session: p.fixture.session };
  };
  unavailable = true; assert.equal(await p.poll(), false); p.jumpWithoutTimers(5001);
  assert.equal(p.context.window.relaySwarmDemo.report().deliveryPolicy.unavailable, true);
  await controls.close(); controls = createOperatorControls({ statePath, telemetry: true }); await controls.ready(); unavailable = false;
  assert.equal(await p.poll(), true); assert.equal(p.element("telemetry").disabled, false); assert.equal(p.element("telemetry").checked, false);
  await p.sendReport(); assert.equal(reports, 0);
  p.element("telemetry").checked = true; await p.sendReport(); assert.equal(reports, 1);
  // The client still rejects a changed shape at the accepted revision.
  override = { ...controls.policy(), telemetry: false }; assert.equal(await p.poll(), false);
  assert.equal(p.context.window.relaySwarmDemo.report().deliveryPolicy.unavailable, true); assert.equal(p.element("telemetry").checked, false);
  override = undefined; assert.equal(await p.poll(), true); assert.equal(p.element("telemetry").checked, false);
  await controls.close(); controls = createOperatorControls({ statePath, telemetry: false }); await controls.ready();
  assert.equal(await p.poll(), true); assert.equal(p.element("telemetry").disabled, true); assert.equal(p.element("telemetry").checked, false);
  await p.sendReport(); assert.equal(reports, 1);
});

test("reporting-only OFF clears consent before a held session response without revoking peers", async () => {
  const p = await page(); let release;
  try {
    p.fixture.policy = { mode: null, revision: 1, telemetry: true }; await p.poll();
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    p.element("telemetry").checked = true;
    const active = p.fixture.swarms.at(-1), reports = [];
    p.fixture.fetch = async (url, init) => {
      if (url === "/reports") { reports.push(init.body); return {}; }
      if (url === "/session.json") return new Promise(resolve => { release = () => resolve(p.fixture.session); });
      return p.fixture.policy;
    };
    p.fixture.policy = { mode: null, revision: 2, telemetry: false };
    const pending = p.poll();
    for (let i = 0; i < 50 && !p.element("telemetry").disabled; i++) await Promise.resolve();
    assert.equal(p.element("telemetry").disabled, true); assert.equal(p.element("telemetry").checked, false);
    assert.match(p.element("telemetry-label").textContent, /switched off by this service/u);
    assert.match(p.element("telemetry-status").textContent, /No numeric measurements will be sent/u);
    assert.notEqual(active.stopped, true); assert.equal(p.element("upload").checked, true);
    await p.sendReport(); assert.equal(reports.length, 0);
    release(); await pending;
    assert.equal(p.fixture.swarms.at(-1), active); assert.notEqual(active.stopped, true);
  } finally { release?.(); p.close(); }
});

test("operator mode cannot defeat viewer origin kill or grant upload consent", async () => {
  const p = await page(); p.fixture.policy.mode = "peer-first"; p.fixture.policy.revision++; await p.poll(); await p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  p.element("mode").value = "peer-first"; await p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  p.element("kill").click();
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
});

test("field-run URL options reach the loader and the receipt keeps the latest eight session traces", async () => {
  const plain = await page();
  plain.element("mode").value = "peer-first"; await plain.submit();
  assert.equal(plain.fixture.swarms.at(-1).options.multiHolder, false);
  assert.equal(plain.fixture.swarms.at(-1).options.abrIgnorePeers, false);
  assert.equal(plain.fixture.swarms.at(-1).options.traceRequests, 0);
  const plainReport = plain.context.window.relaySwarmDemo.report();
  assert.equal(plainReport.current.trace, undefined);
  assert.equal(plainReport.sessions.some((entry) => "trace" in entry), false);
  plain.close();
  for (const search of ["?trace=32769", "?trace=-1", "?trace=1.5", "?multiHolder=true", "?abrIgnorePeers=true"]) {
    const p = await page(new Map(), { search }); p.element("mode").value = "peer-first"; await p.submit();
    assert.equal(p.fixture.swarms.at(-1).options.multiHolder, false, search);
    assert.equal(p.fixture.swarms.at(-1).options.abrIgnorePeers, false, search);
    assert.equal(p.fixture.swarms.at(-1).options.traceRequests, 0, search);
    p.close();
  }
  const p = await page(new Map(), { search: "?multiHolder=1&trace=4096&abrIgnorePeers=1" });
  p.element("mode").value = "peer-first";
  for (let i = 0; i < 10; i++) await p.submit();
  const active = p.fixture.swarms.at(-1);
  assert.equal(active.options.multiHolder, true); assert.equal(active.options.abrIgnorePeers, true);
  assert.equal(active.options.traceRequests, 4096);
  const receipt = JSON.parse(JSON.stringify(p.context.window.relaySwarmDemo.report()));
  assert.equal(receipt.current.multiHolder, true); assert.equal(receipt.current.abrIgnorePeers, true); assert.equal(receipt.current.traceRequests, 4096);
  assert.deepEqual(receipt.current.trace.rows, [{ k: "load", load: p.fixture.swarms.length - 1 }]);
  const traced = receipt.sessions.filter((entry) => entry.trace);
  assert.equal(traced.length, 8);
  assert.deepEqual(traced.map((entry) => entry.trace.rows[0].load), receipt.sessions.slice(-8).map((_, index) => p.fixture.swarms.length - 9 + index));
  assert.ok(receipt.sessions.every((entry) => entry.multiHolder === true && entry.traceRequests === 4096));
  p.close();
});

test("ICE policy normalises absent to all and a change requires new Apply and upload consent", async () => {
  const p = await page();
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const first = p.fixture.swarms.at(-1), count = p.fixture.swarms.length;
    assert.equal(first.options.iceTransportPolicy, "all");
    assert.equal(await first.options.reserveUploadBytes(77), true);
    p.fixture.session.iceTransportPolicy = "all"; await p.poll();
    assert.equal(p.fixture.swarms.length, count); assert.notEqual(first.stopped, true);
    p.fixture.session.iceTransportPolicy = "relay"; await p.poll();
    assert.equal(first.stopped, true); assert.equal(p.element("upload").checked, false);
    assert.equal(p.context.window.relaySwarmDemo.report().current, null);
    assert.equal(await first.options.reserveUploadBytes(1), false);
    await p.poll(); assert.equal(p.fixture.swarms.length, count);
    await p.submit();
    const next = p.fixture.swarms.at(-1);
    assert.equal(next.options.iceTransportPolicy, "relay"); assert.equal(next.options.serve, false);
    assert.equal(p.context.window.relaySwarmDemo.report().uploadBudget.spent, 77);
    assert.equal(p.element("telemetry").checked, false);
  } finally { p.close(); }
});

test("invalid refreshed ICE policy revokes peers instead of falling back to all", async () => {
  const p = await page();
  try {
    p.fixture.session.iceTransportPolicy = "relay"; await p.poll();
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const first = p.fixture.swarms.at(-1);
    p.fixture.session.iceTransportPolicy = "invalid"; await p.poll();
    assert.equal(first.stopped, true); assert.equal(p.element("upload").checked, false);
    assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
    assert.equal(p.fixture.swarms.at(-1).options.serve, false);
    assert.ok(p.fixture.swarms.every(({ options }) => options.iceTransportPolicy === "relay"));
  } finally { p.close(); }
});

test("ICE policy change fences an Apply awaiting its old admission ticket", async () => {
  const p = await page(); let finishTicket, hold = true;
  try {
    p.fixture.session.admission = { issuer: "issuer", epoch: "epoch", challengeEndpoint: "/challenge", ticketEndpoint: "/ticket", verifyEndpoint: "/verify" };
    p.fixture.fetch = async (url) => {
      if (url === "/session.json") return p.fixture.session;
      if (url === "/delivery-policy.json") return p.fixture.policy;
      const result = { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: "ticket", expiresAt: Math.ceil(Date.now() / 1000) + 300 };
      if (url === "/ticket" && hold) return new Promise(resolve => { finishTicket = () => resolve(result); });
      return result;
    };
    await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true;
    const applying = p.submit(); for (let i = 0; i < 20 && !finishTicket; i++) await Promise.resolve(); assert.ok(finishTicket);
    p.fixture.session.iceTransportPolicy = "relay"; await p.poll();
    hold = false; finishTicket(); await applying;
    assert.equal(p.fixture.sourceLoads, 0); assert.equal(p.element("upload").checked, false);
    await p.submit();
    assert.equal(p.fixture.swarms.at(-1).options.iceTransportPolicy, "relay");
    assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  } finally { p.close(); }
});

async function accountPage(storage = new Map()) {
  const p = await page(storage), stable = generateSecretKey();
  let grant = "a".repeat(64), spent = 200, revision = 1, generation = 1, cap = 100000000, delegation, expires, intent;
  const calls = [], state = () => ({ v: 1, limit: cap, spent, remaining: Math.max(0, cap - spent), revision, generation, linkedMethods: ["nostr"] });
  p.fixture.session.accountBudget = { v: 1, methods: ["nostr", "website"], defaultLimit: 100000000, grantTtlSeconds: 120, delegationTtlSeconds: 10800,
    ...Object.fromEntries(["challenge", "authorize", "reserve", "status", "renew", "logout"].map(v => [`${v}Endpoint`, `/account-budget/${v}`])) };
  p.fixture.accountSignatures = 0;
  p.context.window.nostr = { async getPublicKey() { return getPublicKey(stable); }, async signEvent(event) { p.fixture.accountSignatures++; if (p.fixture.accountSignHold) await p.fixture.accountSignHold(); return finalizeEvent(JSON.parse(JSON.stringify(event)), stable); } };
  p.fixture.fetch = async (url, init) => {
    if (url === "/session.json") return p.fixture.session;
    if (url === "/delivery-policy.json") return p.fixture.policy;
    const body = JSON.parse(init.body); calls.push({ url, body }); const now = p.context.Date.now();
    if (p.fixture.accountFetch) return p.fixture.accountFetch(url, body, init);
    if (url.endsWith("/challenge")) {
      delegation = now + 10800000; intent = body;
      const content = { v: 1, purpose: "relayswarm-account-budget-authorize", origin: "https://viewer.example", challenge: "b".repeat(48), action: body.action, pagePubkey: body.pagePubkey, methods: body.methods, settings: body.settings ?? null, expiresAt: now + 30000, delegationExpiresAt: delegation };
      return { v: 1, challenge: content.challenge, expiresAt: content.expiresAt, event: { kind: 27237, created_at: Math.floor(now / 1000), tags: [], content: JSON.stringify(content) } };
    }
    if (url.endsWith("/authorize")) {
      if (intent.settings) { cap = intent.settings.limit; if (intent.settings.reset) { spent = 0; generation++; } revision++; }
      expires = now + 120000;
      return { v: 1, grant, expiresAt: expires, delegationExpiresAt: delegation, epoch: revision, requiresFreshUploadConsent: true, snapshot: state() };
    }
    if (url.endsWith("/reserve")) { spent += body.bytes; return { v: 1, accepted: true, duplicate: false, reservedBytes: body.bytes, snapshot: state() }; }
    if (url.endsWith("/renew")) { grant = "c".repeat(64); expires = now + 120000; return { v: 1, grant, expiresAt: expires, delegationExpiresAt: delegation, epoch: revision, requiresFreshUploadConsent: false, snapshot: state() }; }
    if (url.endsWith("/logout")) return { v: 1, revoked: true };
    return { v: 1, expiresAt: expires, delegationExpiresAt: delegation, epoch: revision, snapshot: state() };
  };
  await p.poll(); return { ...p, calls };
}

test("account UI connection never grants upload; both caps reserve and ambiguous failure stays closed", async () => {
  const p = await accountPage();
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    await p.fixture.swarms.at(-1).options.reserveUploadBytes(101);
    await p.element("account-connect").click();
    assert.equal(p.context.window.relaySwarmDemo.report().accountBudget.connected, true, `account route stages: ${p.calls.map(v => v.url).join(",")}; signer calls: ${p.fixture.accountSignatures}`);
    assert.equal(p.element("upload").checked, false); assert.equal(p.context.window.relaySwarmDemo.report().current, null);
    assert.equal(p.context.window.relaySwarmDemo.report().accountBudget.spent, 200);
    await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
    p.element("upload").checked = true; await p.submit();
    assert.equal(await p.fixture.swarms.at(-1).options.reserveUploadBytes(77), true);
    let report = p.context.window.relaySwarmDemo.report();
    assert.equal(report.uploadBudget.spent, 178); assert.equal(report.accountBudget.spent, 277);
    const serialized = JSON.stringify(report);
    for (const call of p.calls) for (const secret of [call.body.grant, call.body.nostrProof?.pubkey]) if (secret) assert.ok(!serialized.includes(secret));
    p.fixture.accountFetch = async () => { throw Error("private-account-identifier"); };
    assert.equal(await p.fixture.swarms.at(-1).options.reserveUploadBytes(33), false);
    assert.equal(p.element("upload").checked, false);
    report = p.context.window.relaySwarmDemo.report(); assert.equal(report.uploadBudget.spent, 211);
    assert.equal(report.accountBudget.required, true); assert.equal(report.accountBudget.available, false);
    await p.poll(); p.element("upload").checked = true; await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
    assert.equal(p.fixture.accountSignatures, 1); assert.ok(!JSON.stringify(report).includes("private-account-identifier"));
  } finally { p.close(); }
});

test("account UI link/settings/reset stop upload and require fresh proof without resetting browser usage", async () => {
  const p = await accountPage();
  try {
    await p.element("account-connect").click(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    await p.fixture.swarms.at(-1).options.reserveUploadBytes(99);
    await p.element("account-link").click(); assert.equal(p.element("upload").checked, false); assert.equal(p.fixture.accountSignatures, 2);
    p.element("upload").checked = true; await p.submit(); await p.element("account-settings").click();
    assert.equal(p.element("upload").checked, false); assert.equal(p.context.window.relaySwarmDemo.report().accountBudget.spent, 299);
    p.element("upload").checked = true; await p.submit(); await p.element("account-reset").click();
    const report = p.context.window.relaySwarmDemo.report();
    assert.equal(p.element("upload").checked, false); assert.equal(p.fixture.accountSignatures, 4);
    assert.equal(report.accountBudget.spent, 0); assert.equal(report.uploadBudget.spent, 99);
    await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  } finally { p.close(); }
});

test("account UI renewal keeps existing consent only while fresh; reload retains no account authority", async () => {
  const storage = new Map(), p = await accountPage(storage);
  try {
    await p.element("account-connect").click(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    await p.fixture.swarms.at(-1).options.reserveUploadBytes(500);
    for (let i = 0; i < 51; i++) { p.jumpWithoutTimers(2000); await p.poll(); }
    assert.equal(p.fixture.accountSignatures, 1); assert.equal(p.element("upload").checked, true);
    assert.equal(p.context.window.relaySwarmDemo.report().accountBudget.spent, 700);
    p.jumpWithoutTimers(120001); const expired = p.context.window.relaySwarmDemo.report();
    assert.equal(p.element("upload").checked, false); assert.equal(expired.current?.metrics.serving ?? false, false); assert.equal(expired.accountBudget.available, false);
    const next = await accountPage(storage);
    try { const report = next.context.window.relaySwarmDemo.report(); assert.equal(report.accountBudget.required, false); assert.equal(report.accountBudget.connected, false); assert.equal(report.uploadBudget.spent, 500); assert.equal(next.fixture.accountSignatures, 0); assert.equal(next.element("upload").checked, false); }
    finally { next.close(); }
  } finally { p.close(); }
});

test("account UI disconnect clears upload and preserves both spent counters without anonymous fallback", async () => {
  const p = await accountPage();
  try {
    await p.element("account-connect").click(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    await p.fixture.swarms.at(-1).options.reserveUploadBytes(70);
    await p.element("account-disconnect").click();
    const report = p.context.window.relaySwarmDemo.report();
    assert.equal(p.element("upload").checked, false); assert.equal(report.current, null);
    assert.equal(report.uploadBudget.spent, 70); assert.equal(report.accountBudget.spent, 270);
    assert.equal(report.accountBudget.connected, false); assert.equal(report.accountBudget.required, true);
    p.element("upload").checked = true; await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
    assert.equal(p.calls.filter(v => v.url.endsWith("/logout")).length, 1); assert.equal(p.fixture.accountSignatures, 1);
  } finally { p.close(); }
});

test("account UI Apply during a pending signer cannot become post-grant upload consent", async () => {
  const p = await accountPage(); let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  p.fixture.accountSignHold = () => new Promise(resolve => { release = resolve; entered(); });
  try {
    const connecting = p.element("account-connect").click(); await ready;
    assert.equal(p.element("start").disabled, true);
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    assert.equal(p.fixture.sourceLoads, 0); assert.equal(p.fixture.swarms.length, 0);
    release(); await connecting; assert.equal(p.element("upload").checked, false);
    p.fixture.policy.revision++; await p.poll(); assert.equal(p.fixture.swarms.length, 0);
    p.element("upload").checked = true; await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.serve, true);
  } finally { p.close(); }
});

test("settings, kill and publisher identity recovery preserve page allowance and playback instance", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  await p.fixture.swarms.at(-1).options.reserveUploadBytes(1234); p.fixture.swarms.at(-1).uploaded = 1234; await p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 1234);
  p.element("kill").click(); p.element("mode").value = "peer-first"; await p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 1234);
  p.fixture.session.swarmId = "new"; p.fixture.session.streamEvent.id = "new"; await p.poll();
  assert.equal(p.fixture.swarms.at(-1).options.swarmId, "new");
  assert.equal(p.element("upload").checked, false);
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 1234);
  assert.equal(p.fixture.sourceLoads, 1);
  const count = p.fixture.swarms.length; await p.poll(); assert.equal(p.fixture.swarms.length, count);
});

test("remote disable clears upload consent and later policy enable leaves it off", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  p.fixture.policy.mode = "off"; p.fixture.policy.revision++; await p.poll(); assert.equal(p.element("upload").checked, false);
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
  p.fixture.policy.mode = "peer-first"; p.fixture.policy.revision++; await p.poll(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
});

test("full reload retains spent allowance but never restores upload consent", async () => {
  const storage = new Map(), first = await page(storage);
  first.element("mode").value = "peer-first"; first.element("upload").checked = true; await first.submit();
  assert.equal(await first.fixture.swarms.at(-1).options.reserveUploadBytes(999), true);
  const second = await page(storage); second.element("mode").value = "peer-first"; await second.submit();
  assert.equal(second.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 999);
  assert.equal(second.fixture.swarms.at(-1).options.serve, false);
  second.element("upload").checked = true; await second.submit();
  await second.element("reset-allowance").click();
  assert.equal(second.element("upload").checked, false);
  assert.equal(second.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000);
});

test("explicit apply after delayed expiry cannot serve or restore consent", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  await p.fixture.swarms.at(-1).options.reserveUploadBytes(4321); const active = p.fixture.swarms.at(-1);
  p.jumpWithoutTimers(5001);
  assert.equal(await active.options.reserveUploadBytes(1), false);
  await p.submit(); assert.equal(p.element("upload").checked, false); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 4321); assert.equal(p.fixture.sourceLoads, 1);
  await p.poll(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
});

test("pagehide clears both consents; pageshow renewal preserves quota and never regrants upload", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  await p.fixture.swarms.at(-1).options.reserveUploadBytes(99); p.element("telemetry").checked = true;
  p.windowEvent("pagehide"); assert.equal(p.element("upload").checked, false); assert.equal(p.element("telemetry").checked, false);
  const count = p.fixture.swarms.length; await p.poll(); assert.equal(p.fixture.swarms.length, count);
  p.windowEvent("pageshow"); await p.poll(); assert.equal(p.fixture.swarms.at(-1).options.serve, false); assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 99); assert.equal(p.fixture.sourceLoads, 1);
});

test("background visibility stops peers until explicit apply; the first expired report is consistent", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  p.jumpWithoutTimers(5001); const expired = p.context.window.relaySwarmDemo.report();
  assert.equal(expired.policyRenewal.fresh, false); assert.equal(expired.deliveryPolicy.unavailable, true); assert.equal(expired.current.mode, "off");
  await p.poll(); p.element("upload").checked = true; await p.submit(); p.visibility("hidden"); const count = p.fixture.swarms.length;
  assert.equal(p.element("upload").checked, false); p.visibility("visible"); await p.poll(); assert.equal(p.fixture.swarms.length, count); assert.equal(p.context.window.relaySwarmDemo.report().current, null);
  await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.mode, "peer-first"); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
});

test("operator peer-off preserves separate numeric report consent while policy is available", async () => {
  const p = await page(); p.fixture.policy.telemetry = true; p.fixture.policy.revision++; await p.poll();
  p.element("mode").value = "peer-first"; p.element("upload").checked = true; p.element("telemetry").checked = true; await p.submit();
  p.fixture.policy.mode = "off"; p.fixture.policy.revision++; await p.poll();
  assert.equal(p.element("upload").checked, false); assert.equal(p.element("telemetry").checked, true); assert.equal(p.element("telemetry").disabled, false);
  const r = p.context.window.relaySwarmDemo.report(); assert.equal(r.deliveryPolicy.unavailable, false); assert.equal(r.current.mode, "off");
});

test("late admission result remains bound to the configured session and admitted boolean", async () => {
  const p = await page(); let finishVerify;
  p.fixture.session.admission = { issuer: "issuer", epoch: "epoch-a", challengeEndpoint: "/challenge", ticketEndpoint: "/ticket", verifyEndpoint: "/verify" };
  p.fixture.fetch = async (url) => {
    if (url === "/session.json") return p.fixture.session;
    if (url === "/delivery-policy.json") return p.fixture.policy;
    if (url === "/verify") return new Promise(resolve => { finishVerify = resolve; });
    return { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: "ticket", expiresAt: Math.ceil(Date.now() / 1000) + 300 };
  };
  await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  const old = p.fixture.swarms.at(-1), signal = new AbortController().signal;
  const denied = old.options.admit("peer", "ticket", { signal }); finishVerify({ admitted: false, epoch: "epoch-a" }); assert.equal(await denied, false);
  const pending = old.options.admit("peer", "ticket", { signal });
  p.fixture.session = { ...p.fixture.session, swarmId: "new", streamEvent: { id: "new" }, admission: { ...p.fixture.session.admission, epoch: "epoch-b" } };
  await p.poll(); finishVerify({ admitted: true, epoch: "epoch-a" }); assert.equal(await pending, false);
  assert.equal(p.element("upload").checked, false); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
});

async function admittedPage(ttl = 120, fixtureOptions = {}) {
  const p = await page(); Object.assign(p.fixture, fixtureOptions); let issued = 0;
  p.fixture.session.admission = { issuer: "issuer", epoch: "epoch-a", challengeEndpoint: "/challenge", ticketEndpoint: "/ticket", verifyEndpoint: "/verify" };
  p.fixture.fetch = async (url, init) => {
    if (url === "/session.json") return p.fixture.session;
    if (url === "/delivery-policy.json") return p.fixture.policy;
    if (p.fixture.admissionFetch) return p.fixture.admissionFetch(url, init);
    if (url === "/verify") return { admitted: true, epoch: p.fixture.session.admission.epoch };
    return { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: url === "/ticket" ? `ticket-${++issued}` : "challenge", expiresAt: Math.ceil(p.context.Date.now() / 1000) + ttl };
  };
  await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  return p;
}

test("same-config ticket renewal preserves the swarm, loader and spent allowance without reconsent", async () => {
  const p = await admittedPage(), active = p.fixture.swarms.at(-1), count = p.fixture.swarms.length;
  assert.equal(await active.options.reserveUploadBytes(4321), true); active.uploaded = 4321;
  for (let i = 0; i < 51; i++) { p.jumpWithoutTimers(2000); await p.poll(); }
  assert.equal(p.fixture.swarms.length, count); assert.equal(active.stopped, undefined);
  assert.deepEqual(Array.from(active.tickets), ["ticket-2"]); assert.equal(active.options.ticket, "ticket-2");
  assert.equal(p.context.window.relaySwarmDemo.report().uploadBudget.spent, 4321);
  assert.equal(p.element("upload").checked, true); assert.equal(active.options.serve, true); assert.equal(p.fixture.sourceLoads, 1);
  p.fixture.policy.mode = "off"; p.fixture.policy.revision++; await p.poll();
  assert.equal(active.stopped, true); assert.equal(p.element("upload").checked, false);
  p.fixture.policy.mode = "peer-first"; p.fixture.policy.revision++; await p.poll();
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 4321);
});

test("same-identity configuration changes rebuild rather than repurpose a live ticket update", async () => {
  const p = await admittedPage(), active = p.fixture.swarms.at(-1);
  p.fixture.session = { ...p.fixture.session, relays: ["wss://changed.example"], admission: { ...p.fixture.session.admission, verifyEndpoint: "/new-verify" } };
  await p.poll(); assert.equal(active.stopped, true); assert.equal(active.tickets.length, 0);
  assert.equal(p.fixture.swarms.at(-1).options.relays[0], "wss://changed.example");
});

test("a refused in-place ticket update fails closed without returning spent allowance", async () => {
  const p = await admittedPage(10), active = p.fixture.swarms.at(-1);
  await active.options.reserveUploadBytes(123); p.fixture.rejectTicketUpdates = true; await p.poll();
  assert.equal(active.stopped, true); assert.equal(p.element("upload").checked, false);
  const receipt = JSON.parse(JSON.stringify(p.context.window.relaySwarmDemo.report()));
  assert.equal(receipt.policyRenewal.fresh, false); assert.equal(receipt.uploadBudget.spent, 123);
  assert.equal(receipt.current.mode, "off");
});

test("disabled peer fallback renews its credential without declaring delivery policy unavailable", async () => {
  const p = await admittedPage(10, { disabledSwarm: true }), prior = p.fixture.swarms.at(-1);
  assert.equal(prior.options.mode, "peer-first", "the viewer requested peers while the implementation falls back to origin");
  assert.equal(p.context.window.relaySwarmDemo.report().current.metrics.disabledReason, "no-webrtc");
  await p.poll();
  const current = p.fixture.swarms.at(-1), receipt = p.context.window.relaySwarmDemo.report();
  assert.notEqual(current, prior); assert.equal(prior.stopped, true);
  assert.equal(current.options.ticket, "ticket-2"); assert.equal(prior.tickets.length, 0);
  assert.equal(receipt.policyRenewal.fresh, true); assert.equal(receipt.deliveryPolicy.unavailable, false);
  assert.equal(receipt.current.metrics.mode, "off"); assert.equal(receipt.current.metrics.disabledReason, "no-webrtc");
  assert.equal(receipt.current.metrics.serving, false); assert.equal(receipt.loaderRestored, true);
  assert.equal(p.fixture.sourceLoads, 1, "renewal preserves the origin playback instance");
});

test("a renewal that loses credential CAS cannot replace a later explicit Apply ticket", async () => {
  const p = await admittedPage(10); let finishTicket, tickets = 1;
  p.fixture.admissionFetch = async (url) => {
    if (url === "/verify") return { admitted: true, epoch: "epoch-a" };
    const credential = { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: `ticket-${url === "/ticket" ? ++tickets : tickets}`, expiresAt: Math.ceil(p.context.Date.now() / 1000) + 120 };
    if (url === "/ticket" && tickets === 2) return new Promise((resolve) => { finishTicket = () => resolve(credential); });
    return credential;
  };
  const pending = p.poll(); for (let i = 0; i < 40 && !finishTicket; i++) await Promise.resolve(); assert.ok(finishTicket);
  await p.submit(); const current = p.fixture.swarms.at(-1);
  assert.equal(current.options.ticket, "ticket-3"); finishTicket(); await pending;
  assert.equal(p.fixture.swarms.at(-1), current); assert.equal(current.options.ticket, "ticket-3"); assert.equal(current.tickets.length, 0);
});

test("a pending renewal cannot restore a hidden page's peer authority or upload consent", async () => {
  const p = await admittedPage(10), active = p.fixture.swarms.at(-1); let finish;
  await active.options.reserveUploadBytes(123);
  p.fixture.admissionFetch = async (url) => {
    const credential = { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: "late-renewal", expiresAt: Math.ceil(p.context.Date.now() / 1000) + 120 };
    return url === "/ticket" ? new Promise((resolve) => { finish = () => resolve(credential); }) : credential;
  };
  const pending = p.poll(); for (let i = 0; i < 40 && !finish; i++) await Promise.resolve(); assert.ok(finish);
  p.visibility("hidden"); const count = p.fixture.swarms.length; finish(); await pending; p.fixture.admissionFetch = undefined;
  p.visibility("visible"); await p.poll();
  assert.equal(p.fixture.swarms.length, count); assert.equal(active.stopped, true); assert.equal(active.tickets.length, 0);
  assert.equal(p.element("upload").checked, false); assert.equal(p.context.window.relaySwarmDemo.report().uploadBudget.spent, 123);
  await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
});

test("own credential expiry before and after admission I/O clears contribution without renewal consent", async () => {
  for (const expiryBefore of [true, false]) {
    const p = await admittedPage(1), active = p.fixture.swarms.at(-1); let finish;
    p.fixture.admissionFetch = (url) => url === "/verify" ? new Promise((resolve) => { finish = resolve; }) : assert.fail("unexpected admission request");
    if (expiryBefore) p.jumpWithoutTimers(2000);
    const pending = active.options.admit("peer", "remote-ticket", { signal: new AbortController().signal });
    if (!expiryBefore) { assert.ok(finish); p.jumpWithoutTimers(2000); finish({ admitted: true, epoch: "epoch-a" }); }
    assert.equal(await pending, false); assert.equal(active.stopped, true); assert.equal(p.element("upload").checked, false);
    assert.equal(await active.options.reserveUploadBytes(1), false);
    assert.equal(p.context.window.relaySwarmDemo.report().uploadBudget.spent, 0);
  }
});

test("own expiry after a persisted upload reservation cannot refund it or restore consent", async () => {
  const p = await admittedPage(1), active = p.fixture.swarms.at(-1); let finish;
  p.context.navigator.locks.request = async (_name, _options, callback) => {
    const reserved = callback(); await new Promise((resolve) => { finish = resolve; }); return reserved;
  };
  const pending = active.options.reserveUploadBytes(123);
  assert.ok(finish); p.jumpWithoutTimers(2000); finish(); assert.equal(await pending, false);
  assert.equal(active.stopped, true); assert.equal(p.element("upload").checked, false);
  assert.equal(p.context.window.relaySwarmDemo.report().uploadBudget.spent, 123);
});

test("Apply awaiting a ticket cannot undo a newer hide/resume rejoin barrier", async () => {
  const p = await page(); let finishTicket, hold = true;
  p.fixture.session.admission = { issuer: "issuer", epoch: "epoch-a", challengeEndpoint: "/challenge", ticketEndpoint: "/ticket", verifyEndpoint: "/verify" };
  p.fixture.fetch = async (url) => {
    if (url === "/session.json") return p.fixture.session;
    if (url === "/delivery-policy.json") return p.fixture.policy;
    const result = { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: "ticket", expiresAt: Math.ceil(Date.now() / 1000) + 300 };
    if (url === "/ticket" && hold) return new Promise(resolve => { finishTicket = () => resolve(result); });
    return result;
  };
  await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true;
  const applying = p.submit(); for (let i = 0; i < 20 && !finishTicket; i++) await Promise.resolve(); assert.ok(finishTicket);
  p.visibility("hidden"); p.visibility("visible"); hold = false; finishTicket(); await applying; await p.poll();
  assert.equal(p.fixture.sourceLoads, 0); assert.equal(p.context.window.relaySwarmDemo.report().current, null); assert.equal(p.element("upload").checked, false);
  await p.submit(); assert.equal(p.fixture.sourceLoads, 1); assert.equal(p.fixture.swarms.at(-1).options.mode, "peer-first"); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
});

test("newer-issued old-identity admission cannot reinstall A after another check commits B", async () => {
  const p = await page();
  const descriptor = (epoch) => ({ issuer: "issuer", epoch, challengeEndpoint: `/challenge-${epoch}`, ticketEndpoint: `/ticket-${epoch}`, verifyEndpoint: "/verify" });
  const a = { ...p.fixture.session, admission: descriptor("a") }, b = { ...a, swarmId: "new", streamEvent: { id: "new" }, admission: descriptor("b") };
  p.fixture.session = a; let racing = false, sessionReads = 0, finishB, finishA;
  const credential = (s) => ({ ...s.admission, swarmId: s.swarmId, challenge: "challenge", ticket: `ticket-${s.admission.epoch}`, expiresAt: Math.ceil(Date.now() / 1000) + 10 });
  p.fixture.fetch = async (url) => {
    if (url === "/delivery-policy.json") return p.fixture.policy;
    if (url === "/session.json") {
      if (!racing) return a;
      if (++sessionReads === 1) return new Promise(resolve => { finishB = () => resolve(b); });
      return a;
    }
    if (racing && url === "/ticket-a") return new Promise(resolve => { finishA = () => resolve(credential(a)); });
    return credential(url.endsWith("-b") ? b : a);
  };
  await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit(); racing = true;
  const older = p.poll(); for (let i = 0; i < 20 && !finishB; i++) await Promise.resolve(); assert.ok(finishB);
  const newer = p.poll(); for (let i = 0; i < 30 && !finishA; i++) await Promise.resolve(); assert.ok(finishA);
  finishB(); await older; assert.equal(p.context.window.relaySwarmDemo.report().stream.swarmId, "new");
  finishA(); await newer;
  const result = p.context.window.relaySwarmDemo.report(); assert.equal(result.stream.swarmId, "new"); assert.equal(p.fixture.swarms.at(-1).options.ticket, "ticket-b"); assert.equal(p.element("upload").checked, false);
  assert.ok(result.policyRenewal.records.some(r => r.outcome === "stale"));
});

test("OFF followed by failed session validation remains off and marks authority unavailable", async () => {
  const p = await page(); p.fixture.policy.telemetry = true; p.fixture.policy.revision++; await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; p.element("telemetry").checked = true; await p.submit();
  p.fixture.policy.mode = "off"; p.fixture.policy.revision++;
  p.fixture.fetch = async (url) => { if (url === "/session.json") throw Error("Session withheld"); return p.fixture.policy; };
  await p.poll(); const r = p.context.window.relaySwarmDemo.report(); assert.equal(r.deliveryPolicy.unavailable, true); assert.equal(r.policyRenewal.fresh, false); assert.equal(r.current.mode, "off"); assert.equal(p.element("upload").checked, false); assert.equal(p.element("telemetry").checked, false);
});

// Only the policy/session transport is real here. The maintained bundled client
// runs with fixture media/swarm, real issuance clocks and no browser process.
async function policyHTTP(t, { inlinePolicySession = false, boundedH1 = inlinePolicySession, observeTiming = false } = {}) {
  const state = { phase: "bootstrap", policyDelay: 0, sessionDelay: 0, holdSession: false, sessionStatus: 200, policyAfterSessionIngress: false,
    policy: { mode: null, revision: 0, telemetry: false },
    session: { v: 1, swarmId: "old", streamEvent: { id: "old" }, relays: [], manifest: "/media/index.m3u8", commitmentEndpoint: "/commitment" } };
  if (inlinePolicySession) Object.assign(state.session, { deliveryPolicyEndpoint: "/delivery-policy.json?session=1", deliveryPolicySession: "inline-v1" });
  const records = [], clientRecords = [], open = new Set(), timers = new Set(), gatedPolicies = new Map(); let p, clientDropped = 0;
  const agent = boundedH1 ? new http.Agent({ keepAlive: true, maxSockets: 2 }) : null;
  const server = http.createServer((request, response) => {
    const route = request.url === "/delivery-policy.json" || request.url === "/delivery-policy.json?session=1" ? "policy" : request.url === "/session.json" ? "session" : null;
    if (!route) { response.writeHead(404).end(); return; }
    const record = { route, phase: state.phase, httpVersion: request.httpVersion, arrived: performance.now(), ended: null, closed: null };
    records.push(record); open.add(response); let timer;
    if (observeTiming) { record.finished = null; response.once("finish", () => { record.finished = performance.now(); }); }
    response.once("close", () => { open.delete(response); record.closed = performance.now(); clearTimeout(timer); timers.delete(timer); gatedPolicies.delete(record); });
    if (route === "session") for (const [policy, send] of gatedPolicies) if (policy.phase === record.phase) { gatedPolicies.delete(policy); send(); }
    if (route === "session" && state.holdSession) return;
    const send = () => {
      timers.delete(timer); if (response.destroyed) return;
      record.ended = performance.now(); response.writeHead(route === "session" ? state.sessionStatus : 200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(route === "policy" && request.url === "/delivery-policy.json?session=1" ? { ...state.policy, session: state.session } : state[route]));
    };
    const sendAfterIngress = () => {
      if (route === "policy" && state.policyAfterSessionIngress && !records.some(item => item.phase === record.phase && item.route === "session")) gatedPolicies.set(record, send);
      else send();
    };
    const wait = route === "policy" ? state.policyDelay : state.sessionDelay;
    if (wait) { timer = setTimeout(sendAfterIngress, wait); timers.add(timer); } else sendAfterIngress();
  });
  t.after(async () => {
    p?.close(); agent?.destroy(); for (const timer of timers) clearTimeout(timer); for (const response of open) response.destroy(); gatedPolicies.clear();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (observeTiming) t.diagnostic(JSON.stringify({ kind: "policy-http-owned-cleanup", openResponses: open.size, serverListening: server.listening }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const transport = agent ? (url, init) => new Promise((resolve, reject) => {
    const request = http.get(new URL(url, origin), { agent, signal: init.signal }, response => {
      const chunks = []; let size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 65536) response.destroy(new Error("Policy fixture response exceeded its bound.")); else chunks.push(chunk); });
      response.on("error", reject); response.on("aborted", () => reject(new Error("Policy fixture response aborted.")));
      response.on("end", () => resolve({ ok: response.statusCode === 200, status: response.statusCode,
        json: async () => JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject);
  }) : (url, init) => fetch(new URL(url, origin), init);
  const fetchImpl = !observeTiming ? transport : (url, init) => {
    const row = clientRecords.length < 32 ? { route: url === "/session.json" ? "session" : "policy",
      phase: state.phase === "bootstrap" || state.phase === "delayed" ? state.phase : "other",
      issuedAtHostMs: performance.now(), issuedAtClientMs: p?.context.performance.now() ?? null,
      settledAtHostMs: null, settledAtClientMs: null, outcome: null } : null;
    if (row) clientRecords.push(row); else clientDropped++;
    const settle = outcome => { if (row) { row.settledAtHostMs = performance.now(); row.settledAtClientMs = p?.context.performance.now() ?? null; row.outcome = outcome; } };
    let pending;
    try { pending = transport(url, init); } catch (error) { settle("throw"); throw error; }
    pending.then(() => settle("fulfilled"), () => settle("rejected"));
    return pending;
  };
  p = await page(new Map(), { realClock: true, fetchImpl });
  return { p, state, records, open, clientRecords, clientDropped: () => clientDropped };
}

test("real HTTP inline renewal succeeds without entering a withheld separate session endpoint", { timeout: 3000 }, async t => {
  const f = await policyHTTP(t, { inlinePolicySession: true }), { p, state, records } = f;
  state.phase = "inline-with-separate-session-held"; state.holdSession = true;
  const pending = p.poll();
  try {
    const renewed = await Promise.race([pending, delay(250).then(() => false)]);
    assert.equal(renewed, true, "Negotiated inline renewal must not await the separate session endpoint");
    assert.deepEqual(records.filter(row => row.phase === state.phase).map(row => row.route), ["policy"]);
    assert(records.every(row => row.httpVersion === "1.1"));
    assert.equal(p.context.window.relaySwarmDemo.report().policyRenewal.fresh, true);
  } finally { p.close(); await pending; await waitForHTTP(() => f.open.size === 0); }
});
async function waitForHTTP(predicate, ms = 1500) {
  const deadline = performance.now() + ms;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert(predicate(), "Required owned HTTP observation did not arrive within fixture bound");
}

test("real HTTP pair completes within the existing issuance overlap", { timeout: 12000 }, async t => {
  const f = await policyHTTP(t, { observeTiming: true }), { p, state, records } = f;
  p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  const active = p.fixture.swarms.at(-1), count = p.fixture.swarms.length;
  assert(await active.options.reserveUploadBytes(1234)); active.uploaded = 1234;
  const report = p.context.window.relaySwarmDemo.report();
  const issuance = report.policyRenewal.records.filter(x => x.outcome === "accepted").at(-1).issuedAtMs;
  state.phase = "delayed"; state.policyDelay = state.sessionDelay = 2000;
  const pollTimes = [], polls = new Set(), interval = setInterval(() => {
    const row = { issuedAtMs: p.context.performance.now(), settledAtMs: null, result: null };
    if (pollTimes.length < 8) pollTimes.push(row);
    const pending = p.poll(); polls.add(pending); pending.then(value => {
      row.settledAtMs = p.context.performance.now(); row.result = value === true; polls.delete(pending);
    }, () => { row.settledAtMs = p.context.performance.now(); row.result = false; polls.delete(pending); });
  }, 2000);
  try {
    await delay(Math.max(0, issuance + 5300 - p.context.performance.now()));
    const current = p.context.window.relaySwarmDemo.report();
    t.diagnostic(JSON.stringify({ kind: "policy-http-original-overlap-checkpoint", clientAtMs: p.context.performance.now(), hostAtMs: performance.now(),
      initialIssuanceAtMs: issuance, initialExpiryAtMs: issuance + 5000, checkpointAtMs: issuance + 5300,
      policyDelayMs: state.policyDelay, sessionDelayMs: state.sessionDelay, pollingMs: 2000,
      pollTimes, clientRecords: f.clientRecords, clientDropped: f.clientDropped(),
      clientSettleScope: "Native fetch promise settlement; body completion is in controlTimings. Host and page clocks have different origins.",
      serverRecords: records.slice(0, 32).map(row => ({ route: row.route, phase: row.phase === "bootstrap" || row.phase === "delayed" ? row.phase : "other",
        arrivedAtHostMs: row.arrived, sentAtHostMs: row.ended, finishedAtHostMs: row.finished, closedAtHostMs: row.closed })),
      serverDropped: Math.max(0, records.length - 32), policyRenewal: current.policyRenewal, controlTimings: current.controlTimings }));
    assert.equal(current.policyRenewal.fresh, true, "Sequential policy+session latency must not exhaust the unchanged5s issuance authority");
    assert.equal(p.element("upload").checked, true); assert.equal(p.fixture.swarms.length, count); assert.equal(active.stopped, undefined);
    assert.equal(current.uploadBudget.spent, 1234);
    const firstPolicy = records.find(x => x.phase === "delayed" && x.route === "policy");
    const firstSession = records.find(x => x.phase === "delayed" && x.route === "session");
    assert(firstPolicy && firstSession && firstSession.arrived < firstPolicy.ended, "Session must reach actual HTTP while its paired policy is still withheld");
  } finally {
    clearInterval(interval); p.close(); await Promise.allSettled([...polls]); await waitForHTTP(() => f.open.size === 0);
    t.diagnostic(JSON.stringify({ kind: "policy-http-overlap-finally", pendingPolls: polls.size, openResponses: f.open.size }));
  }
});

test("real HTTP OFF revokes immediately while its session is withheld", { timeout: 6000 }, async t => {
  const f = await policyHTTP(t), { p, state, records } = f;
  p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  state.phase = "off"; state.policy = { mode: "off", revision: 1, telemetry: false }; state.holdSession = true; state.policyDelay = 50;
  const pending = p.poll();
  try {
    await waitForHTTP(() => !p.element("upload").checked);
    assert.equal(p.context.window.relaySwarmDemo.report().current.mode, "off");
    assert(records.some(x => x.phase === "off" && x.route === "session" && x.ended === null));
    assert.equal(p.context.window.relaySwarmDemo.report().policyRenewal.fresh, false);
  } finally { p.close(); await pending; await waitForHTTP(() => f.open.size === 0); }
});

test("real HTTP early session503 cannot suppress delayed eligible OFF", { timeout: 6000 }, async t => {
  const f = await policyHTTP(t), { p, state, records } = f;
  p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  state.phase = "off-after-session-failure"; state.policy = { mode: "off", revision: 1, telemetry: false }; state.policyDelay = 100; state.sessionStatus = 503;
  await p.poll();
  assert.equal(p.element("upload").checked, false); assert.equal(p.context.window.relaySwarmDemo.report().current.mode, "off");
  const requests = records.filter(x => x.phase === state.phase);
  assert(requests.find(x => x.route === "session").ended < requests.find(x => x.route === "policy").ended, "Failure must precede policy response in the real HTTP transport");
  p.close(); await waitForHTTP(() => f.open.size === 0);
});

test("real HTTP invalid policy and hidden page cancel both owned pair requests", { timeout: 6000 }, async t => {
  const f = await policyHTTP(t), { p, state, records } = f;
  state.phase = "invalid-policy"; state.policy = { mode: "invalid", revision: 1, telemetry: false }; state.holdSession = true; state.policyAfterSessionIngress = true;
  await p.poll();
  await waitForHTTP(() => f.open.size === 0);
  assert(records.some(x => x.phase === "invalid-policy" && x.route === "session" && x.ended === null), "Unused session must have started and then been cancelled");
  assert(records.find(x => x.phase === "invalid-policy" && x.route === "policy").ended >= records.find(x => x.phase === "invalid-policy" && x.route === "session").arrived);
  state.phase = "hidden"; state.policy = { mode: null, revision: 2, telemetry: false }; state.policyDelay = 4000; state.policyAfterSessionIngress = false;
  const pending = p.poll();
  await waitForHTTP(() => records.filter(x => x.phase === "hidden").length === 2);
  p.visibility("hidden"); await pending; await waitForHTTP(() => f.open.size === 0);
  assert.equal(p.context.window.relaySwarmDemo.report().policyRenewal.fresh, false);
  assert(records.filter(x => x.phase === "hidden").every(x => x.ended === null));
});

function fmp4ObserverFixture() {
 const callbacks = new Map(), quality = new EventTarget(), media = new EventTarget();
 quality.value = '1'; Object.assign(media,{currentTime:0,readyState:0,networkState:2,paused:false,ended:false,error:null,buffered:{length:0}});
 const hls = {streamController:{state:'FRAG_LOADING',level:1,startFragRequested:true,fragCurrent:{sn:0,level:1,cc:0,start:0,duration:2,loader:{stats:{aborted:true,loaded:0}},url:'PRIVATE_URL'}},levelController:{currentLevelIndex:1,manualLevelIndex:1},on(name,cb){callbacks.set(name,cb)}};
 const events = new Proxy({}, { get: (_, key)=>key });
 const observer = installFmp4StartupObserver(()=>hls,media,quality,()=>10);observer.attach(hls,events);return{observer,hls,quality,media,callbacks};
}
test('fMP4 observer: read-only startup observations retain aborted init/media ordering and redact payloads',()=>{
 const f=fmp4ObserverFixture();f.quality.dispatchEvent(new Event('change'));f.callbacks.get('FRAG_LOADING')('',{frag:{sn:'initSegment',level:1,url:'PRIVATE_URL',decryptdata:'PRIVATE_KEY'}});f.callbacks.get('ERROR')('',{details:'aborted',fatal:false,frag:f.hls.streamController.fragCurrent,error:Error('PRIVATE_MESSAGE')});
 const x=f.observer.snapshot();assert.equal(x.records[1].event,'quality-change');assert.equal(x.records[2].fragment.sequence,'init');assert.equal(x.records[3].detail,'aborted');assert.equal(x.state.stream.current.aborted,true);assert.equal(x.state.media.currentTime,0);assert.ok(!JSON.stringify(x).includes('PRIVATE'));
});
test('fMP4 observer: ring is bounded, snapshots independent, unknown values stay unknown, getter failures contained',()=>{
 const f=fmp4ObserverFixture();for(let i=0;i<140;i++)f.callbacks.get('FRAG_LOADING')('',{frag:{sn:i,level:1}});let x=f.observer.snapshot();assert.equal(x.records.length,128);assert.equal(x.dropped,13);x.records[0].fragment.level=99;assert.equal(f.observer.snapshot().records[0].fragment.level,1);f.hls.streamController.state='PRIVATE_STATE';assert.equal(f.observer.snapshot().state.stream.state,'unknown');
 Object.defineProperty(f.hls,'streamController',{get(){throw Error('PRIVATE')}});assert.equal(f.observer.snapshot().state.unavailable,true);assert.doesNotThrow(()=>f.callbacks.get('ERROR')('',{get frag(){throw Error('PRIVATE')}}));assert.equal(f.observer.snapshot().records.at(-1).event,'observation-unavailable');
});
test('fMP4 observer: only asserted observation seams transform; original source reconstructs exactly',async()=>{
 const source=await readFile(new URL('../demo/client.mjs',import.meta.url),'utf8');const out=observedFmp4Client(source);let restored=out.replace('import { installFmp4StartupObserver } from "../test/support/fmp4-startup-observer.mjs";\n','').replace('\nconst startupObserver = installFmp4StartupObserver(() => hls, video, byId("quality"));','').replace('\n      startupObserver.attach(hls, Hls.Events);','').replace('\nObject.defineProperty(window, "relaySwarmFmp4Startup", { value: () => startupObserver.snapshot() });\n','');assert.equal(restored,source);assert.throws(()=>observedFmp4Client(''));assert.throws(()=>observedFmp4Client(source+source));
});

test('fMP4 observer: observations never invoke computed Hls level getters or accessor-backed raw level fields',()=>{
 const f=fmp4ObserverFixture();let calls=0;
 for(const key of ['loadLevel','nextLoadLevel','startLevel','autoLevelEnabled'])Object.defineProperty(f.hls,key,{get(){calls++;throw Error('computed getter must remain untouched')}});
 f.quality.dispatchEvent(new Event('change'));f.callbacks.get('FRAG_LOADING')('',{});
 const x=f.observer.snapshot();assert.equal(calls,0);assert.equal(x.state.loadLevel,1);assert.equal(x.state.autoLevel,false);assert.equal('nextLoadLevel' in x.state,false);assert.equal('startLevel' in x.state,false);
 Object.defineProperty(f.hls.levelController,'currentLevelIndex',{get(){calls++;return 9}});
 Object.defineProperty(f.hls.levelController,'manualLevelIndex',{get(){calls++;return -1}});
 const y=f.observer.snapshot();assert.equal(y.state.loadLevel,null);assert.equal(y.state.autoLevel,null);assert.equal(calls,0);
});

// Pure availability observation regressions; included by test:publisher.
{
const ROOT = new URL("../", import.meta.url), key = "a".repeat(64);
test("broadcast availability: current-source seams are unique and inverse recovers all three sources exactly", async () => {
  for (const [kind, path] of [["client", "demo/client.mjs"], ["swarm", "src/browser/hls-swarm.mjs"], ["peer", "src/browser/peer-link.mjs"]]) {
    const checkedOut = await readFile(new URL(path, ROOT), "utf8");
    const lf = checkedOut.replaceAll("\r\n", "\n"), crlf = lf.replaceAll("\n", "\r\n");
    for (const original of [lf, crlf]) {
      const changed = transform(kind, original);
      assert.equal(changed.undo(changed.source), original); assert.equal(changed.undo(changed.source), original);
      assert.throws(() => transform(kind, original + original)); assert.throws(() => transform(kind, ""));
      const amended = "// legitimate future source edit\n" + original;
      const next = transform(kind, amended); assert.equal(next.undo(next.source), amended);
    }
    assert.throws(() => transform(kind, lf + crlf), /Unique/u);
  }
});
test("broadcast availability: existing PeerLink sends original once and only successful sends record queued HAVE", async () => {
  const original = await readFile(new URL("src/browser/peer-link.mjs", ROOT), "utf8");
  const source = transform("peer", original).source.replace(/^import[^\n]+\n/u, "").replace("export class PeerLink", "class PeerLink");
  let tick = 0, throws = false, sends = 0, closed = 0;
  const observation = createObservation(() => tick++, 1000), PeerLink = new Function("availabilityObservation", source + "\nreturn PeerLink;")(observation);
  const callbacks = new Map(), channel = { readyState: "open", addEventListener(n, cb) { callbacks.set(n, cb); }, send(value) { sends++; assert.equal(typeof value, "string"); if (throws) throw Error("original-failure"); }, close() {} };
  const link = new PeerLink({ pubkey: "PRIVATE", pc: { addEventListener() {}, close() {} }, channel, maxSegmentBytes: 1e6, onHaveChange(_link, added) { assert.deepEqual(added, [key]); }, onClose() { closed++; } });
  link.sendHave([key]); assert.equal(sends, 1);
  callbacks.get("message")({ data: JSON.stringify({ t: "have", add: [key, "bad"] }) }); assert.ok(link.have.has(key));
  throws = true; link.sendHave([key]); assert.equal(sends, 2); assert.equal(closed, 1); assert.equal(link.closed, true);
  const out = publicTimeline([{ role: "consumer", value: observation.takePrivate() }]);
  assert.equal(out.pages[0].rows.filter(r => r.phase === "have-full-queued").length, 1);
  assert.equal(out.pages[0].rows.filter(r => r.phase === "have-key-accepted").length, 1);
  assert.ok(!JSON.stringify(out).includes(key)); assert.ok(!JSON.stringify(out).includes("PRIVATE"));
});
test("broadcast availability: captured and unresolved origin keys are emitted before retained HAVE is queued", async () => {
  const original = (await readFile(new URL("src/browser/hls-swarm.mjs", ROOT), "utf8")).replaceAll("\r\n", "\n");
  for (const eol of ["\n", "\r\n"]) {
    // Transform both checkout formats; normalise only the execution fixture's
    // substring boundaries. The inverse test still checks exact original bytes.
    const swarm = transform("swarm", original.replaceAll("\n", eol)).source.replaceAll("\r\n", "\n");
    const peer = transform("peer", await readFile(new URL("src/browser/peer-link.mjs", ROOT), "utf8")).source
      .replace(/^import[^\n]+\n/u, "").replace("export class PeerLink", "class PeerLink");
    const knownStart = swarm.indexOf("            // Publish retained source bytes before Hls synchronously disposes");
    const unknownStart = swarm.indexOf("                const key = await keyPromise;");
    const snippets = [swarm.slice(knownStart, swarm.indexOf("            if (!finishOrigin()) return;", knownStart)),
      swarm.slice(unknownStart, swarm.indexOf("\n              }\n            });", unknownStart))];
    for (const known of [true, false]) for (const retain of [true, false]) {
      let tick = 0, sends = 0;
      const observation = createObservation(() => tick++, 1000), context = { frag: { sn: 1, cc: 0, level: 0 } };
      const PeerLink = new Function("availabilityObservation", peer + "\nreturn PeerLink;")(observation);
      const channel = { readyState: "open", addEventListener() {}, send() { sends++; }, close() {} };
      const link = new PeerLink({ pubkey: "fixture", pc: { addEventListener() {}, close() {} }, channel, maxSegmentBytes: 1e6 });
      const body = snippets[known ? 0 : 1].replaceAll("swarm.#hold", "swarm.hold");
      await new Function("availabilityObservation", "originKey", "keyPromise", "copy", "swarm", "context", `return (async () => {${body}})();`)(
        observation, key, Promise.resolve(key), retain ? new ArrayBuffer(8) : null,
        { stopped: false, hold(held, bytes) { assert.equal(held, key); assert.equal(bytes.length, 8); link.sendHaveChange([held]); } }, context);
      const out = publicTimeline([{ role: "baseline", value: observation.takePrivate() }]).pages[0];
      assert.deepEqual(out.rows.map(row => row.phase), retain ? ["origin-key-ready", "have-frame-queued", "have-add-queued"] : ["origin-key-ready"]);
      assert.equal(sends, Number(retain)); assert.equal(out.unknown, 0);
      assert.equal(out.rows[0].object, 1); assert.equal(out.rows[0].fragment, 1);
      link.close();
    }
  }
});
test("broadcast availability: Hls events and exact supplied deadline join shared objects without reading context getters", () => {
  let tick = 0, getterCalls = 0; const a = createObservation(() => tick++, 1000), b = createObservation(() => tick++, 1000), callbacks = new Map();
  const frag = { sn: 1, cc: 0, level: 0 }, context = { frag }; Object.defineProperty(frag, "url", { get() { getterCalls++; throw Error(); } });
  a.attach({ on(name, cb) { callbacks.set(name, cb); } }, { FRAG_LOADING: "loading", FRAG_LOADED: "loaded" });
  callbacks.get("loading")("", { frag }); a.key(context, key, 1501.25, 1500); callbacks.get("loaded")("", { frag });
  b.key(context, key); b.queued({}, { t: "have", add: [key], del: [] });
  const out = publicTimeline([{ role: "consumer", value: a.takePrivate() }, { role: "contributor-low", value: b.takePrivate() }]);
  assert.equal(getterCalls, 0); assert.equal(out.pages[0].rows[0].object, out.pages[1].rows[0].object);
  assert.equal(out.pages[0].rows[1].deadlineMs, 1501.25); assert.equal(out.pages[0].rows[1].budgetMs, 1500);
});
test("broadcast availability: bounded memory, drops and unknowns remain explicit; public output excludes extra properties", () => {
  const o = createObservation(() => 1, 1000);
  for (let i = 0; i < 600; i++) o.key({ frag: {} }, i.toString(16).padStart(64, "0"), 10, 0);
  const value = o.takePrivate(); assert.equal(value.rows.length, 512); assert.equal(value.keys.length, 512); assert.ok(value.dropped > 0); assert.ok(value.unknown > 0);
  value.rows[0].secret = "PRIVATE"; const out = publicTimeline([{ role: "consumer", value }]); assert.ok(!JSON.stringify(out).includes("PRIVATE"));
  assert.throws(() => publicTimeline(Array(5).fill({}))); assert.throws(() => publicTimeline([{ role: "private-role", value }]));
  const accessor = createObservation(() => 1, 1000); accessor.key(Object.defineProperty({}, "frag", { get() { throw Error(); } }), key, 1, 1); assert.equal(accessor.takePrivate().rows[0].fragment, null);
});

const secret = "private-error-" + key;
const bound = operation => operation();
test("broadcast availability: final extraction evaluates once per page and joins private keys before serialisation", async () => {
  let calls = 0; const raw = [];
  const pages = ["contributor-low", "consumer"].map(name => {
    const observation = createObservation(() => 1, 10); observation.key({ frag: {} }, key, 1501, 1500);
    const result = { receipt: { v: 1 }, appendFailures: [], mediaDiagnostics: [], privateAvailability: observation.takePrivate() }; raw.push(result);
    return { name, network: {}, page: { evaluate() { calls++; return result; } } };
  });
  const result = await extractFinal(pages, bound);
  assert.equal(calls, 2); assert.equal(result.extraction.ok, true);
  assert.equal(result.availability.pages[0].rows[0].object, result.availability.pages[1].rows[0].object);
  assert.ok(raw.every(value => !("privateAvailability" in value)));
  assert.equal(JSON.stringify(result).includes(key), false);
});
test("broadcast availability: private extraction and conversion failures never export raw error or private values", async () => {
  const raw = { receipt: { v: 1 }, privateAvailability: { keys: [key], rows: [{ phase: secret }], fragmentKeys: [] } };
  const result = await extractFinal([
    { name: "consumer", page: { evaluate() { throw Error(secret); } } },
    { name: "contributor-low", page: { evaluate() { return raw; } } },
  ], bound);
  assert.equal(result.extraction.ok, false); assert.equal(result.availability, null);
  assert.equal(result.extraction.failureClass, "TimelineInvalid");
  assert.equal(result.extraction.pages[0].failureClass, "ExtractionUnavailable");
  assert.equal(JSON.stringify(result).includes(key), false); assert.equal("privateAvailability" in raw, false);
});
}

const turnDescriptor = { v: 1, endpoint: "/turn-credentials", method: "POST" };
const settleTurn = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
async function turnPage(p) {
  p ??= await page();
  const calls = []; p.fixture.session.turnCredentials = turnDescriptor;
  p.fixture.response = async (url, init) => {
    if (url !== "https://viewer.example/turn-credentials") return null;
    calls.push(init); if (p.fixture.turnResponse) return p.fixture.turnResponse(init);
    const serverTime = p.context.Date.now(), issuedAt = Math.floor(serverTime / 1000) * 1000;
    return new Response(JSON.stringify({ v: 1, ttlSeconds: 6, issuedAt, serverTime, expiresAt: issuedAt + 6000, refreshAt: issuedAt + 4000,
      iceServers: [{ urls: ["turns:private-relay.test:5349?transport=tcp"], username: "private-turn-user", credential: `private-turn-secret-${calls.length}` }] }), { headers: { "content-type": "application/json" } });
  };
  await p.poll(); return { ...p, turnCalls: calls };
}
test("TURN demo mints only on explicit peer Apply, never pre-Start, policy polls, origin or native HLS", async () => {
  const p = await turnPage();
  try {
    await p.poll(); await p.poll(); assert.equal(p.turnCalls.length, 0);
    await p.submit(); assert.equal(p.turnCalls.length, 0); assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const options = p.fixture.swarms.at(-1).options;
    assert.equal(p.turnCalls.length, 1); assert.equal(options.serve, true); assert.equal(options.iceServers[0].credential, "private-turn-secret-1");
    await p.poll(); assert.equal(p.turnCalls.length, 1);
    const report = JSON.stringify(p.context.window.relaySwarmDemo.report());
    for (const value of ["private-turn", "private-relay", "/turn-credentials"]) assert.equal(report.includes(value), false);
  } finally { p.close(); }
  const native = await turnPage(await page(new Map(), { nativeHls: true }));
  try { native.element("mode").value = "peer-first"; await native.submit(); assert.equal(native.turnCalls.length, 0); assert.equal(native.context.window.relaySwarmDemo.report().player.engine, "native HLS"); }
  finally { native.close(); }
});
test("TURN demo refresh recycles active peers while preserving consent, admission and both spent ledgers", async () => {
  const p = await turnPage(await accountPage());
  try {
    await p.element("account-connect").click();
    p.fixture.session.iceTransportPolicy = "relay";
    p.fixture.session.turnCredentials = { ...turnDescriptor, urlProjection: "tls-tcp" };
    p.fixture.session.admission = { issuer: "issuer", epoch: "epoch", challengeEndpoint: "/admission-challenge", ticketEndpoint: "/admission-ticket", verifyEndpoint: "/admission-verify" };
    const fetchAccount = p.fixture.fetch;
    p.fixture.fetch = (url, init) => url.startsWith("/admission-") ? { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: "private-admission-ticket", expiresAt: Math.floor(p.context.Date.now() / 1000) + 300 } : fetchAccount(url, init);
    await p.poll(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const first = p.fixture.swarms.at(-1); assert.equal(await first.options.reserveUploadBytes(77), true);
    assert.equal(first.options.iceTransportPolicy, "relay");
    p.jumpWithoutTimers(4000); await p.poll(); p.fireTimer(ms => ms > 3000 && ms <= 4000); await settleTurn();
    const next = p.fixture.swarms.at(-1), report = p.context.window.relaySwarmDemo.report();
    assert.notEqual(next, first); assert.equal(first.stopped, true); assert.equal(next.options.serve, true); assert.equal(p.element("upload").checked, true);
    assert.equal(next.options.ticket, first.options.ticket); assert.equal(next.options.secretKey, first.options.secretKey);
    assert.equal(next.options.iceServers[0].credential, "private-turn-secret-2");
    assert.equal(next.options.iceTransportPolicy, "relay");
    assert.equal(report.uploadBudget.spent, 77); assert.equal(report.accountBudget.spent, 277); assert.equal(p.fixture.accountSignatures, 1);
    assert.equal(p.fixture.sourceLoads, 1); assert.equal(p.turnCalls.length, 2);
  } finally { p.close(); }
});

test("origin-only playback survives a same-publisher admission epoch change without peer authority", async () => {
  const p = await turnPage();
  try {
    p.fixture.session.streamEvent.pubkey = "fixed-publisher";
    p.fixture.session.admission = { issuer: "issuer", epoch: "epoch-a", challengeEndpoint: "/origin-challenge", ticketEndpoint: "/origin-ticket", verifyEndpoint: "/origin-verify" };
    p.fixture.fetch = url => url === "/session.json" ? p.fixture.session : url === "/delivery-policy.json" ? p.fixture.policy
      : { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: "fresh-ticket", expiresAt: Math.ceil(p.context.Date.now() / 1000) + 120 };
    await p.poll(); await p.submit();
    const player = p.fixture.players.at(-1), off = p.fixture.swarms.at(-1);
    assert.equal(off.options.mode, "off"); assert.equal(p.turnCalls.length, 0);
    assert.equal(p.fixture.sourceLoads, 1); assert.equal(p.video.paused, false);

    p.fixture.session = { ...p.fixture.session, admission: { ...p.fixture.session.admission, epoch: "epoch-b" } };
    await p.poll();
    const report = p.context.window.relaySwarmDemo.report();
    assert.equal(report.current?.mode, "off", "An irrelevant peer epoch must not remove the active OriginOnly configuration");
    assert.equal(report.current.upload, false); assert.equal(report.current.metrics.serving, false);
    assert.equal(report.current.metrics.peers.connected, 0); assert.equal(report.loaderRestored, true);
    assert.equal(report.totals.peerFirstBytes, 0); assert.equal(report.totals.uploaded, 0);
    assert.equal(p.element("upload").checked, false); assert.equal(p.element("telemetry").checked, false);
    assert.equal(p.fixture.players.at(-1), player); assert.equal(player.destroyed, undefined);
    assert.equal(p.fixture.sourceLoads, 1); assert.equal(p.video.paused, false); assert.equal(p.turnCalls.length, 0);
    assert.equal(off.stopped, true, "The stale peer configuration is still retired");

    p.element("mode").value = "peer-first";
    await p.poll();
    assert.equal(p.context.window.relaySwarmDemo.report().current.mode, "off", "A policy poll cannot substitute for Apply");
    assert.equal(p.turnCalls.length, 0);
    await p.submit();
    assert.equal(p.fixture.swarms.at(-1).options.mode, "peer-first");
    assert.equal(p.fixture.swarms.at(-1).options.serve, false); assert.equal(p.turnCalls.length, 1);
    assert.equal(p.fixture.sourceLoads, 1, "Explicit peer Apply keeps the original playback instance");
  } finally { p.close(); }
});

// The account HTTP transport and durable charge are real; media and Swarm are
// fixtures, including the same stop→lifecycle abort used by the maintained SDK.
test("TURN refresh settles an already charged account reservation without granting an aborted upload", {
  skip: !["darwin", "linux"].includes(process.platform) ? "Durable account state requires POSIX file permissions." : false,
  timeout: 5000,
}, async t => {
  let p, controls, server, directory, held, release, charged;
  const committed = new Promise(resolve => { charged = resolve; });
  t.after(async () => {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => p?.close()),
      Promise.resolve().then(async () => {
        held?.destroy(); server?.closeAllConnections();
        if (server?.listening) await new Promise(resolve => server.close(resolve));
      }),
      Promise.resolve().then(() => controls?.close()),
    ]);
    if (directory) await rm(directory, { recursive: true, force: true });
    assert.ok(cleanup.every(row => row.status === "fulfilled"), "Every owned overlap fixture must close");
  });
  p = await page();
  directory = await mkdtemp(join(await realpath(tmpdir()), "relayswarm-turn-account-overlap-"));
  const statePath = join(directory, "account.json");
  controls = createAccountBudgetControls({ statePath, now: () => p.context.Date.now() });
  await controls.ready();
  let holdNext = true;
  server = http.createServer((request, response) => {
    const path = new URL(request.url, "https://viewer.example").pathname;
    if (path === "/account-budget/reserve" && holdNext) {
      holdNext = false;
      const end = response.end.bind(response);
      response.end = (body, ...args) => {
        held = response;
        const value = JSON.parse(String(body));
        release = () => { if (!response.destroyed) end(body, ...args); };
        charged(value); return response;
      };
    }
    // The VM's configured public origin is preserved; only its transport maps
    // to this loopback listener. No origin/signature/ledger check is bypassed.
    controls.handle(request, response, path, "https://viewer.example").then(handled => {
      if (!handled) response.writeHead(404).end();
    }).catch(() => response.destroy());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${server.address().port}`, stable = generateSecretKey(); let signatures = 0;
  p.fixture.session.accountBudget = controls.descriptor();
  p.fixture.session.admission = { issuer: "issuer", epoch: "epoch", challengeEndpoint: "/admission-challenge", ticketEndpoint: "/admission-ticket", verifyEndpoint: "/admission-verify" };
  p.fixture.fetch = url => url.startsWith("/admission-")
    ? { ...p.fixture.session.admission, swarmId: p.fixture.session.swarmId, challenge: "challenge", ticket: "private-overlap-ticket", expiresAt: Math.floor(p.context.Date.now() / 1000) + 300 }
    : url === "/session.json" ? p.fixture.session : p.fixture.policy;
  p = await turnPage(p);
  const turnResponse = p.fixture.response;
  p.fixture.response = (url, init) => url.startsWith("/account-budget/")
    ? fetch(new URL(url, base), { ...init, headers: { ...init.headers, origin: "https://viewer.example" } })
    : turnResponse(url, init);
  p.context.window.nostr = { getPublicKey: async () => getPublicKey(stable), signEvent: async event => {
    signatures++; return finalizeEvent(JSON.parse(JSON.stringify(event)), stable);
  } };
  await p.element("account-connect").click();
  p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  const first = p.fixture.swarms.at(-1), before = p.context.window.relaySwarmDemo.report();
  assert.equal(first.options.serve, true); assert.equal(before.accountBudget.available, true);
  const pending = first.options.reserveUploadBytes(77, { signal: first.lifecycle.signal });
  const decision = await committed;
  assert.equal(decision.accepted, true); assert.equal(decision.reservedBytes, 77);
  assert.equal(decision.snapshot.spent, 77);
  const durable = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(durable.accounts.reduce((sum, account) => sum + (account.spent ?? 0), 0), 77);
  p.jumpWithoutTimers(4000); await p.poll();
  p.fireTimer(ms => ms > 3000 && ms <= 4000); await settleTurn();
  assert.equal(first.stopped, true); assert.equal(first.lifecycle.signal.aborted, true);
  release();
  assert.equal(await pending, false, "A committed account charge cannot authorise the stopped media operation");
  const next = p.fixture.swarms.at(-1), report = p.context.window.relaySwarmDemo.report();
  assert.equal(report.accountBudget.available, true, "Normal TURN refresh must not revoke the independent account grant");
  assert.equal(report.accountBudget.spent, 77); assert.equal(report.uploadBudget.spent, 77);
  assert.equal(report.accountBudget.generation, before.accountBudget.generation);
  assert.equal(p.element("upload").checked, true); assert.equal(next.options.serve, true); assert.notEqual(next, first);
  assert.equal(next.options.secretKey, first.options.secretKey); assert.equal(next.options.ticket, first.options.ticket);
  assert.equal(report.turnCredentials.refreshes, 2); assert.equal(signatures, 1); assert.equal(report.totals.uploaded, 0);
  assert.equal(await next.options.reserveUploadBytes(5, { signal: next.lifecycle.signal }), true);
  const after = p.context.window.relaySwarmDemo.report();
  assert.equal(after.accountBudget.spent, 82); assert.equal(after.uploadBudget.spent, 82);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).accounts.reduce((sum, account) => sum + (account.spent ?? 0), 0), 82);
});

test("TURN demo expiry and page suspension stay fail-closed until fresh explicit Apply without restoring upload", async () => {
  const p = await turnPage();
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    await p.fixture.swarms.at(-1).options.reserveUploadBytes(88);
    p.jumpWithoutTimers(4000); await p.poll(); p.jumpWithoutTimers(2100);
    const expired = p.context.window.relaySwarmDemo.report();
    assert.equal(expired.turnCredentials.available, false); assert.equal(expired.current, null); assert.equal(p.element("upload").checked, false);
    const count = p.fixture.swarms.length; await p.poll(); assert.equal(p.fixture.swarms.length, count); assert.equal(p.turnCalls.length, 1);
    await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.serve, false); assert.equal(p.turnCalls.length, 2);
    assert.equal(p.context.window.relaySwarmDemo.report().uploadBudget.spent, 88);
    p.visibility("hidden"); p.visibility("visible"); await p.poll();
    assert.equal(p.context.window.relaySwarmDemo.report().current, null); assert.equal(p.turnCalls.length, 2);
    let release; p.fixture.turnResponse = () => new Promise(resolve => { release = resolve; });
    const applying = p.submit(); await settleTurn(); assert.equal(typeof release, "function");
    p.visibility("hidden"); await applying; release(new Response("{}", { headers: { "content-type": "application/json" } })); await settleTurn();
    p.visibility("visible"); await p.poll(); assert.equal(p.context.window.relaySwarmDemo.report().current, null);
    assert.equal(p.element("upload").checked, false);
  } finally { p.close(); }
});
test("TURN demo descriptor removal stops active peers; unchanged static ICE never requests credentials", async () => {
  const p = await turnPage();
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    delete p.fixture.session.turnCredentials; p.fixture.session.iceServers = [{ urls: "stun:static.test" }]; await p.poll();
    assert.equal(p.context.window.relaySwarmDemo.report().current, null); assert.equal(p.element("upload").checked, false);
    await p.submit(); assert.equal(p.fixture.swarms.at(-1).options.iceServers[0].urls, "stun:static.test"); assert.equal(p.turnCalls.length, 1);
    assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  } finally { p.close(); }
});


test("TURN projection defaults are equivalent but a selection change stops peers and preserves both spent ledgers until fresh Apply", async () => {
  const p = await turnPage(await accountPage());
  try {
    await p.element("account-connect").click(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
    const first = p.fixture.swarms.at(-1), count = p.fixture.swarms.length;
    assert.equal(await first.options.reserveUploadBytes(77), true);
    p.fixture.session.turnCredentials = { ...turnDescriptor, urlProjection: "issued" }; await p.poll();
    assert.equal(p.fixture.swarms.length, count); assert.notEqual(first.stopped, true); assert.equal(p.turnCalls.length, 1);
    p.fixture.session.turnCredentials = { ...turnDescriptor, urlProjection: "tls-tcp" }; await p.poll();
    assert.equal(first.stopped, true); assert.equal(p.element("upload").checked, false); assert.equal(p.turnCalls.length, 1);
    assert.equal(p.context.window.relaySwarmDemo.report().current, null);
    assert.equal(await first.options.reserveUploadBytes(1), false);
    await p.poll(); assert.equal(p.fixture.swarms.length, count);
    await p.submit(); const next = p.fixture.swarms.at(-1), report = p.context.window.relaySwarmDemo.report();
    assert.notEqual(next, first); assert.equal(next.options.serve, false); assert.equal(p.turnCalls.length, 2);
    assert.deepEqual(Array.from(next.options.iceServers[0].urls), ["turns:private-relay.test:5349?transport=tcp"]);
    assert.equal(report.uploadBudget.spent, 77); assert.equal(report.accountBudget.spent, 277); assert.equal(p.fixture.accountSignatures, 1);
    for (const value of ["private-turn", "private-relay", "tls-tcp"]) assert.equal(JSON.stringify(report).includes(value), false);
  } finally { p.close(); }
});

test("TURN projection change during initial acquisition fences late completion and never restores old upload consent", async () => {
  const p = await turnPage(); let release;
  try {
    p.element("mode").value = "peer-first"; p.element("upload").checked = true;
    p.fixture.turnResponse = () => new Promise(resolve => { release = resolve; });
    const applying = p.submit(); await settleTurn(); assert.equal(typeof release, "function");
    p.fixture.session.turnCredentials = { ...turnDescriptor, urlProjection: "tls-tcp" }; await p.poll(); await applying;
    assert.equal(p.element("upload").checked, false); assert.equal(p.fixture.sourceLoads, 0);
    release(new Response("{}", { headers: { "content-type": "application/json" } })); await settleTurn();
    assert.equal(p.context.window.relaySwarmDemo.report().current, null); assert.equal(p.turnCalls.length, 1);
    p.fixture.turnResponse = null; await p.submit(); assert.equal(p.turnCalls.length, 2);
    assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  } finally { p.close(); }
});

for (const [kind, invalidDescriptor] of [["unknown enum", { ...turnDescriptor, urlProjection: "invalid" }], ["extra field", { ...turnDescriptor, urlProjection: "tls-tcp", extra: true }]]) {
  test(`invalid initial TURN projection ${kind} cannot establish peer authority`, async () => {
    const p = await page(new Map(), { initialTurnCredentials: invalidDescriptor });
    try {
      const report = p.context.window.relaySwarmDemo.report();
      assert.equal(report.policyRenewal.fresh, false); assert.equal(report.current, null);
      assert.equal(report.turnCredentials.enabled, false); assert.equal(report.turnCredentials.active, false);
      assert.equal(report.turnCredentials.pending, false); assert.equal(report.turnCredentials.refreshes, 0);
      assert.equal(p.element("start").disabled, true);
      assert.equal(p.fixture.swarms.length, 0); assert.equal(p.fixture.sourceLoads, 0); assert.equal(p.element("upload").checked, false);
      assert.match(p.element("status").textContent, /publisher is unavailable/u);
    } finally { p.close(); }
  });
  test(`invalid refreshed TURN projection ${kind} revokes immediately at the same fresh clock`, async () => {
    const p = await turnPage();
    try {
      p.fixture.session.turnCredentials = { ...turnDescriptor, urlProjection: "tls-tcp" }; await p.poll();
      p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
      const first = p.fixture.swarms.at(-1), calls = p.turnCalls.length, clock = p.context.performance.now();
      assert.equal(p.context.window.relaySwarmDemo.report().policyRenewal.fresh, true);
      assert.equal(await first.options.reserveUploadBytes(77), true);
      p.fixture.session.turnCredentials = invalidDescriptor; await p.poll();
      assert.equal(p.context.performance.now(), clock, "No expiry/timer advance may explain the revocation");
      assert.equal(first.stopped, true); assert.equal(p.element("upload").checked, false); assert.equal(p.turnCalls.length, calls);
      assert.equal(await first.options.reserveUploadBytes(1), false);
      const report = p.context.window.relaySwarmDemo.report();
      assert.equal(report.policyRenewal.fresh, false); assert.equal(report.uploadBudget.spent, 77);
      assert.equal(p.fixture.swarms.at(-1).options.mode, "off"); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
    } finally { p.close(); }
  });
}
