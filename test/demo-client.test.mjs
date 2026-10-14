import { readFile } from "node:fs/promises";
import { installFmp4StartupObserver } from "./support/fmp4-startup-observer.mjs";
import { observedFmp4Client } from "./support/fmp4-observed-demo.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";

const bundle = await build({ entryPoints: ["demo/client.mjs"], bundle: true, write: false, format: "esm", plugins: [{ name: "fixture", setup(builder) {
  builder.onResolve({ filter: /^(hls\.js|\.\.\/src\/browser\/hls-swarm\.mjs)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path === "hls.js" ? `export default class Hls { static version='fixture'; static Events={}; static isSupported(){return true;} constructor(){this.config={};} on(){} loadSource(){globalThis.fixture.sourceLoads++;} attachMedia(){} }` : `export function createHlsSwarm(options){ const record={options, uploaded:0, tickets:[]}; globalThis.fixture.swarms.push(record); return { stop(){record.stopped=true;}, updateTicket(ticket){if(record.stopped||globalThis.fixture.rejectTicketUpdates||globalThis.fixture.disabledSwarm)return false; options.ticket=ticket; record.tickets.push(ticket); return true;}, attach(hls){if(globalThis.fixture.disabledSwarm)return;hls.config.fLoader=options.mode==='off'?undefined:'swarm';}, metrics(){return {mode:globalThis.fixture.disabledSwarm?'off':options.mode, disabledReason:globalThis.fixture.disabledSwarm?'no-webrtc':null, serving:!globalThis.fixture.disabledSwarm&&options.serve, bytes:{uploaded:record.uploaded,peerFirst:0},segments:{peerFirstLoaded:0},peers:{connected:0}};} }; }` }));
} }] });
async function page(storage = new Map(), { realClock = false, fetchImpl } = {}) {
  const elements = new Map(), intervals = [], timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  let clock = 0; const wallStart = Date.now(), performanceStart = performance.now();
  const now = () => realClock ? performance.now() - performanceStart : clock;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [ClockDate.now()])); } static now() { return wallStart + now(); } }
  const element = (id) => { if (!elements.has(id)) elements.set(id, { value: "", checked: false, disabled: false, addEventListener(name, callback) { this[name] = callback; }, append() {} }); return elements.get(id); };
  element("mode").value = "off"; element("limit").value = "512000"; element("allowance").value = "100000000";
  element("account-method").value = "nostr"; element("account-allowance").value = "100000000";
  const video = { addEventListener() {}, play: async () => {}, canPlayType: () => false };
  const fixture = { swarms: [], sourceLoads: 0, policy: { mode: null, revision: 0, telemetry: false }, session: { v: 1, swarmId: "old", streamEvent: { id: "old" }, relays: [], manifest: "/media/index.m3u8", commitmentEndpoint: "/commitment" } };
  const context = { Date: ClockDate, fixture, location: { origin: "https://viewer.example" }, document: { visibilityState: "visible", addEventListener(name, callback) { documentEvents.set(name, callback); }, getElementById: element, querySelector: () => video }, navigator: { locks: { request: async (_name, _options, callback) => callback() } }, crypto: webcrypto, localStorage: { getItem: (name) => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) }, performance: { now }, isSecureContext: true, URL, URLSearchParams, AbortSignal, AbortController, TextDecoder, TextEncoder, console,
    fetch: async (url, init) => { if (fetchImpl) return fetchImpl(url, init); const value = fixture.fetch ? await fixture.fetch(url, init) : url === "/session.json" ? fixture.session : fixture.policy; return { ok: true, json: async () => structuredClone(value) }; },
    setTimeout(callback, ms) { const id = realClock ? setTimeout(() => { timers.delete(id); callback(); }, ms) : Symbol(); timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { if (realClock) clearTimeout(id); timers.delete(id); },
    setInterval(callback, ms) { intervals.push({ callback, ms }); }, window: { addEventListener(name, callback) { windowEvents.set(name, callback); } } };
  await vm.runInNewContext(`(async()=>{${bundle.outputFiles[0].text}})()`, context);
  return { fixture, element, context, close() { windowEvents.get("pagehide")?.(); if (realClock) for (const id of timers.keys()) clearTimeout(id); timers.clear(); }, jumpWithoutTimers(ms) { clock += ms; }, windowEvent: (name) => windowEvents.get(name)?.(), visibility(state) { context.document.visibilityState = state; documentEvents.get("visibilitychange")?.(); }, submit: () => element("settings").submit({ preventDefault() {} }), poll: () => intervals.find((entry) => entry.ms === 2000).callback() };
}

test("operator mode cannot defeat viewer origin kill or grant upload consent", async () => {
  const p = await page(); p.fixture.policy.mode = "peer-first"; p.fixture.policy.revision++; await p.poll(); await p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  p.element("mode").value = "peer-first"; await p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  p.element("kill").click();
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
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
  const receipt = p.context.window.relaySwarmDemo.report();
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
async function policyHTTP(t) {
  const state = { phase: "bootstrap", policyDelay: 0, sessionDelay: 0, holdSession: false, sessionStatus: 200, policyAfterSessionIngress: false,
    policy: { mode: null, revision: 0, telemetry: false },
    session: { v: 1, swarmId: "old", streamEvent: { id: "old" }, relays: [], manifest: "/media/index.m3u8", commitmentEndpoint: "/commitment" } };
  const records = [], open = new Set(), timers = new Set(), gatedPolicies = new Map(); let p;
  const server = http.createServer((request, response) => {
    const route = request.url === "/delivery-policy.json" ? "policy" : request.url === "/session.json" ? "session" : null;
    if (!route) { response.writeHead(404).end(); return; }
    const record = { route, phase: state.phase, arrived: performance.now(), ended: null, closed: null };
    records.push(record); open.add(response); let timer;
    response.once("close", () => { open.delete(response); record.closed = performance.now(); clearTimeout(timer); timers.delete(timer); gatedPolicies.delete(record); });
    if (route === "session") for (const [policy, send] of gatedPolicies) if (policy.phase === record.phase) { gatedPolicies.delete(policy); send(); }
    if (route === "session" && state.holdSession) return;
    const send = () => {
      timers.delete(timer); if (response.destroyed) return;
      record.ended = performance.now(); response.writeHead(route === "session" ? state.sessionStatus : 200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(state[route]));
    };
    const sendAfterIngress = () => {
      if (route === "policy" && state.policyAfterSessionIngress && !records.some(item => item.phase === record.phase && item.route === "session")) gatedPolicies.set(record, send);
      else send();
    };
    const wait = route === "policy" ? state.policyDelay : state.sessionDelay;
    if (wait) { timer = setTimeout(sendAfterIngress, wait); timers.add(timer); } else sendAfterIngress();
  });
  t.after(async () => {
    p?.close(); for (const timer of timers) clearTimeout(timer); for (const response of open) response.destroy(); gatedPolicies.clear();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  p = await page(new Map(), { realClock: true, fetchImpl: (url, init) => fetch(new URL(url, origin), init) });
  return { p, state, records, open };
}
async function waitForHTTP(predicate, ms = 1500) {
  const deadline = performance.now() + ms;
  while (!predicate() && performance.now() < deadline) await delay(5);
  assert(predicate(), "Required owned HTTP observation did not arrive within fixture bound");
}

test("real HTTP pair completes within the existing issuance overlap", { timeout: 12000 }, async t => {
  const f = await policyHTTP(t), { p, state, records } = f;
  p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  const active = p.fixture.swarms.at(-1), count = p.fixture.swarms.length;
  assert(await active.options.reserveUploadBytes(1234)); active.uploaded = 1234;
  const report = p.context.window.relaySwarmDemo.report();
  const issuance = report.policyRenewal.records.filter(x => x.outcome === "accepted").at(-1).issuedAtMs;
  state.phase = "delayed"; state.policyDelay = state.sessionDelay = 2000;
  const polls = new Set(), interval = setInterval(() => { const pending = p.poll(); polls.add(pending); pending.then(() => polls.delete(pending), () => polls.delete(pending)); }, 2000);
  try {
    await delay(Math.max(0, issuance + 5300 - p.context.performance.now()));
    const current = p.context.window.relaySwarmDemo.report();
    assert.equal(current.policyRenewal.fresh, true, "Sequential policy+session latency must not exhaust the unchanged5s issuance authority");
    assert.equal(p.element("upload").checked, true); assert.equal(p.fixture.swarms.length, count); assert.equal(active.stopped, undefined);
    assert.equal(current.uploadBudget.spent, 1234);
    const firstPolicy = records.find(x => x.phase === "delayed" && x.route === "policy");
    const firstSession = records.find(x => x.phase === "delayed" && x.route === "session");
    assert(firstPolicy && firstSession && firstSession.arrived < firstPolicy.ended, "Session must reach actual HTTP while its paired policy is still withheld");
  } finally {
    clearInterval(interval); p.close(); await Promise.allSettled([...polls]); await waitForHTTP(() => f.open.size === 0);
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
