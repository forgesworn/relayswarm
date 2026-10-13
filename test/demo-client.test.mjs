import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const bundle = await build({ entryPoints: ["demo/client.mjs"], bundle: true, write: false, format: "esm", plugins: [{ name: "fixture", setup(builder) {
  builder.onResolve({ filter: /^(hls\.js|\.\.\/src\/browser\/hls-swarm\.mjs)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path === "hls.js" ? `export default class Hls { static version='fixture'; static Events={}; static isSupported(){return true;} constructor(){this.config={};} on(){} loadSource(){globalThis.fixture.sourceLoads++;} attachMedia(){} }` : `export function createHlsSwarm(options){ const record={options, uploaded:0}; globalThis.fixture.swarms.push(record); return { stop(){record.stopped=true;}, attach(hls){hls.config.fLoader=options.mode==='off'?undefined:'swarm';}, metrics(){return {mode:options.mode, serving:options.serve, bytes:{uploaded:record.uploaded,peerFirst:0},segments:{peerFirstLoaded:0},peers:{connected:0}};} }; }` }));
} }] });
async function page(storage = new Map()) {
  const elements = new Map(), intervals = [], timers = new Map(), windowEvents = new Map(), documentEvents = new Map();
  let clock = 0;
  const element = (id) => { if (!elements.has(id)) elements.set(id, { value: "", checked: false, disabled: false, addEventListener(name, callback) { this[name] = callback; }, append() {} }); return elements.get(id); };
  element("mode").value = "off"; element("limit").value = "512000"; element("allowance").value = "100000000";
  const video = { addEventListener() {}, play: async () => {}, canPlayType: () => false };
  const fixture = { swarms: [], sourceLoads: 0, policy: { mode: null, revision: 0, telemetry: false }, session: { v: 1, swarmId: "old", streamEvent: { id: "old" }, relays: [], manifest: "/media/index.m3u8", commitmentEndpoint: "/commitment" } };
  const context = { fixture, document: { visibilityState: "visible", addEventListener(name, callback) { documentEvents.set(name, callback); }, getElementById: element, querySelector: () => video }, navigator: { locks: { request: async (_name, _options, callback) => callback() } }, crypto: webcrypto, localStorage: { getItem: (name) => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) }, performance: { now: () => clock }, isSecureContext: true, URL, URLSearchParams, AbortSignal, AbortController, TextDecoder, TextEncoder, console,
    fetch: async (url, init) => { const value = fixture.fetch ? await fixture.fetch(url, init) : url === "/session.json" ? fixture.session : fixture.policy; return { ok: true, json: async () => structuredClone(value) }; },
    setTimeout(callback, ms) { const id = Symbol(); timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    setInterval(callback, ms) { intervals.push({ callback, ms }); }, window: { addEventListener(name, callback) { windowEvents.set(name, callback); } } };
  await vm.runInNewContext(`(async()=>{${bundle.outputFiles[0].text}})()`, context);
  return { fixture, element, context, jumpWithoutTimers(ms) { clock += ms; }, windowEvent: (name) => windowEvents.get(name)?.(), visibility(state) { context.document.visibilityState = state; documentEvents.get("visibilitychange")?.(); }, submit: () => element("settings").submit({ preventDefault() {} }), poll: () => intervals.find((entry) => entry.ms === 2000).callback() };
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
