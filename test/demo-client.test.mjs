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
  const elements = new Map(), intervals = [];
  const element = (id) => { if (!elements.has(id)) elements.set(id, { value: "", checked: false, disabled: false, addEventListener(name, callback) { this[name] = callback; }, append() {} }); return elements.get(id); };
  element("mode").value = "off"; element("limit").value = "512000"; element("allowance").value = "100000000";
  const video = { addEventListener() {}, play: async () => {}, canPlayType: () => false };
  const fixture = { swarms: [], sourceLoads: 0, policy: { mode: null, telemetry: false }, session: { v: 1, swarmId: "old", streamEvent: { id: "old" }, relays: [], manifest: "/media/index.m3u8", commitmentEndpoint: "/commitment" } };
  const context = { fixture, document: { getElementById: element, querySelector: () => video }, navigator: { locks: { request: async (_name, _options, callback) => callback() } }, crypto: webcrypto, localStorage: { getItem: (name) => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) }, performance: { now: () => 0 }, isSecureContext: true, URL, URLSearchParams, AbortSignal, TextDecoder, TextEncoder, console,
    fetch: async (url) => ({ ok: true, json: async () => structuredClone(url === "/session.json" ? fixture.session : fixture.policy) }),
    setInterval(callback, ms) { intervals.push({ callback, ms }); }, window: { addEventListener() {} } };
  await vm.runInNewContext(`(async()=>{${bundle.outputFiles[0].text}})()`, context);
  return { fixture, element, context, submit: () => element("settings").submit({ preventDefault() {} }), poll: () => intervals.find((entry) => entry.ms === 2000).callback() };
}

test("operator mode cannot defeat viewer origin kill or grant upload consent", async () => {
  const p = await page(); p.fixture.policy.mode = "peer-first"; await p.poll(); await p.submit();
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
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 1234);
  assert.equal(p.fixture.sourceLoads, 1);
  const count = p.fixture.swarms.length; await p.poll(); assert.equal(p.fixture.swarms.length, count);
});

test("remote disable clears upload consent and later policy enable leaves it off", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; await p.submit();
  p.fixture.policy.mode = "off"; await p.poll(); assert.equal(p.element("upload").checked, false);
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
  p.fixture.policy.mode = "peer-first"; await p.poll(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
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
