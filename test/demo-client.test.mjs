import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import vm from "node:vm";

const bundle = await build({ entryPoints: ["demo/client.mjs"], bundle: true, write: false, format: "esm", plugins: [{ name: "fixture", setup(builder) {
  builder.onResolve({ filter: /^(hls\.js|\.\.\/src\/browser\/hls-swarm\.mjs)$/ }, (args) => ({ path: args.path, namespace: "fixture" }));
  builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({ contents: args.path === "hls.js" ? `export default class Hls { static version='fixture'; static Events={}; static isSupported(){return true;} constructor(){this.config={};} on(){} loadSource(){globalThis.fixture.sourceLoads++;} attachMedia(){} }` : `export function createHlsSwarm(options){ const record={options, uploaded:0}; globalThis.fixture.swarms.push(record); return { stop(){record.stopped=true;}, attach(hls){hls.config.fLoader=options.mode==='off'?undefined:'swarm';}, metrics(){return {mode:options.mode, serving:options.serve, bytes:{uploaded:record.uploaded,peerFirst:0},segments:{peerFirstLoaded:0},peers:{connected:0}};} }; }` }));
} }] });
async function page() {
  const elements = new Map(), intervals = [];
  const element = (id) => { if (!elements.has(id)) elements.set(id, { value: "", checked: false, disabled: false, addEventListener(name, callback) { this[name] = callback; }, append() {} }); return elements.get(id); };
  element("mode").value = "off"; element("limit").value = "512000"; element("allowance").value = "100000000";
  const video = { addEventListener() {}, play: async () => {}, canPlayType: () => false };
  const fixture = { swarms: [], sourceLoads: 0, policy: { mode: null, telemetry: false }, session: { v: 1, swarmId: "old", streamEvent: { id: "old" }, relays: [], manifest: "/media/index.m3u8", commitmentEndpoint: "/commitment" } };
  const context = { fixture, document: { getElementById: element, querySelector: () => video }, navigator: {}, performance: { now: () => 0 }, isSecureContext: true, URL, URLSearchParams, AbortSignal, console,
    fetch: async (url) => ({ ok: true, json: async () => structuredClone(url === "/session.json" ? fixture.session : fixture.policy) }),
    setInterval(callback, ms) { intervals.push({ callback, ms }); }, window: { addEventListener() {} } };
  await vm.runInNewContext(`(async()=>{${bundle.outputFiles[0].text}})()`, context);
  return { fixture, element, context, submit: () => element("settings").submit({ preventDefault() {} }), poll: () => intervals.find((entry) => entry.ms === 2000).callback() };
}

test("operator mode cannot defeat viewer origin kill or grant upload consent", async () => {
  const p = await page(); p.fixture.policy.mode = "peer-first"; await p.poll(); p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  p.element("mode").value = "peer-first"; p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.serve, false);
  p.element("kill").click();
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
});

test("settings, kill and publisher identity recovery preserve page allowance and playback instance", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; p.submit();
  p.fixture.swarms.at(-1).uploaded = 1234; p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 1234);
  p.element("kill").click(); p.element("mode").value = "peer-first"; p.submit();
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 1234);
  p.fixture.session.swarmId = "new"; p.fixture.session.streamEvent.id = "new"; await p.poll();
  assert.equal(p.fixture.swarms.at(-1).options.swarmId, "new");
  assert.equal(p.fixture.swarms.at(-1).options.maxUploadBytesPerSession, 100000000 - 1234);
  assert.equal(p.fixture.sourceLoads, 1);
  const count = p.fixture.swarms.length; await p.poll(); assert.equal(p.fixture.swarms.length, count);
});

test("remote disable clears upload consent and later policy enable leaves it off", async () => {
  const p = await page(); p.element("mode").value = "peer-first"; p.element("upload").checked = true; p.submit();
  p.fixture.policy.mode = "off"; await p.poll(); assert.equal(p.element("upload").checked, false);
  assert.equal(p.fixture.swarms.at(-1).options.mode, "off");
  p.fixture.policy.mode = "peer-first"; await p.poll(); assert.equal(p.fixture.swarms.at(-1).options.serve, false);
});
