import test from "node:test";
import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequestDiagnostics, controlRouteLabel } from "../demo/request-diagnostics.mjs";
import { createFetchDiagnostics, appServerTiming } from "../demo/fetch-diagnostics.mjs";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function server(t, handler) {
  const value = createServer(handler); await new Promise((done) => value.listen(0, "127.0.0.1", done));
  t.after(() => { value.closeAllConnections(); return new Promise((done) => value.close(done)); });
  return `http://127.0.0.1:${value.address().port}`;
}
function totals(snapshot, route) {
  return [...snapshot.windows, snapshot.current].reduce((out, window) => { for (const name of ["started", "finished", "cancelled", "expired", "dropped", "headersCount"]) out[name] = (out[name] ?? 0) + window.routes[route][name]; return out; }, {});
}
test("real delayed headers/body separate application timing from fetch body duration", async (t) => {
  const diagnostics = createRequestDiagnostics({ intervalMs: 20, retainWindows: 20 }); t.after(() => diagnostics.close());
  const base = await server(t, (request, response) => { diagnostics.observe(request, response); setTimeout(() => { response.writeHead(200, { "content-type": "application/json" }); response.write('{"ok":'); setTimeout(() => response.end('true}'), 40); }, 45); });
  const fetches = createFetchDiagnostics(); assert.deepEqual(await fetches.json("session", `${base}/session.json?never-store-this-query`), { ok: true });
  const sample = fetches.snapshot().records[0]; assert.ok(sample.appHeadersMs >= 35); assert.ok(sample.headerMs >= sample.appHeadersMs); assert.ok(sample.bodyMs >= 30);
  assert.equal(totals(diagnostics.snapshot(), "session").finished, 1); assert.equal(diagnostics.snapshot().active, 0);
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes("never-store-this-query")); fetches.close();
});
test("real disconnect counts once and keeps original HTTP headers/writeHead overloads", async (t) => {
  const diagnostics = createRequestDiagnostics(); t.after(() => diagnostics.close());
  const base = await server(t, (request, response) => { diagnostics.observe(request, response); response.writeHead(200, "OK", ["server-timing", "existing;dur=7", "content-type", "application/json"]); response.write('{"pending":'); });
  await new Promise((done, reject) => { const request = get(`${base}/session.json`, (response) => { assert.equal(response.headers["server-timing"], "existing;dur=7"); assert.equal(appServerTiming(response.headers["server-timing"]), null); response.once("data", () => { request.destroy(); done(); }); }); request.on("error", reject); });
  await pause(20); const counts = totals(diagnostics.snapshot(), "session"); assert.equal(counts.cancelled, 1); assert.equal(counts.finished, 0); assert.equal(diagnostics.snapshot().active, 0);
});
test("pending expiry, overflow, retention and close stay bounded without cancelling responses", async () => {
  let clock = 0;
  const diagnostics = createRequestDiagnostics({ now: () => clock, wallNow: () => clock, intervalMs: 20, retainWindows: 2, maxActive: 1, maxAgeMs: 20 });
  class Response extends EventEmitter { statusCode = 200; headers = {}; writeHead() { return this; } hasHeader(name) { return Object.hasOwn(this.headers, name); } setHeader(name, value) { this.headers[name] = value; } }
  const first = new Response(), second = new Response(), original = first.writeHead;
  assert.equal(diagnostics.observe({ url: "/commitment?ticket=SECRET&peer=198.51.100.44" }, first), true);
  assert.equal(diagnostics.observe({ url: "/session.json" }, second), false);
  clock = 25; await pause(25); let snapshot = diagnostics.snapshot(); assert.equal(snapshot.active, 0); assert.equal(totals(snapshot, "commitment").expired, 1); assert.equal(totals(snapshot, "session").dropped, 1);
  assert.equal(first.writeHead, original); assert.equal(first.listenerCount("close"), 0); assert.equal(first.listenerCount("finish"), 0);
  first.emit("close"); assert.equal(totals(diagnostics.snapshot(), "commitment").cancelled, 0);
  await pause(65); snapshot = diagnostics.snapshot(); assert.equal(snapshot.windows.length, 2); assert.ok(!JSON.stringify(snapshot).includes("SECRET")); assert.ok(!JSON.stringify(snapshot).includes("198.51"));
  assert.equal(diagnostics.observe({ url: "/secret/arbitrary/path" }, second), false);
  diagnostics.observe({ url: "/reports" }, second); diagnostics.close(); diagnostics.close(); assert.equal(diagnostics.snapshot().active, 0); assert.equal(diagnostics.snapshot().closed, true); assert.equal(second.listenerCount("close"), 0);
});
test("actual event-loop blocking appears in delay and utilisation samples", async () => {
  const diagnostics = createRequestDiagnostics({ intervalMs: 30, retainWindows: 10 });
  try { await pause(35); const until = performance.now() + 90; while (performance.now() < until) {} await pause(70);
    const samples = diagnostics.snapshot().windows.map((window) => window.eventLoop); assert.ok(samples.some((s) => s.schedulerDriftMs >= 50)); assert.ok(samples.some((s) => s.utilisation > 0.4));
  } finally { diagnostics.close(); }
});
test("fixed route classifier and configuration reject unbounded diagnostic state", () => {
  assert.equal(controlRouteLabel("/session.json?key=private"), "session"); assert.equal(controlRouteLabel("/media/low/index.m3u8"), null); assert.equal(controlRouteLabel("/operator/status"), null);
  for (const options of [{ retainWindows: 601 }, { maxActive: 257 }, { intervalMs: 0 }, { maxAgeMs: 60001 }, { serverTiming: "yes" }]) assert.throws(() => createRequestDiagnostics(options), /limits/u);
});
test("diagnostic sampler does not keep an otherwise idle Node process alive", { timeout: 3000 }, async () => {
  const module = new URL("../demo/request-diagnostics.mjs", import.meta.url).href;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import {createRequestDiagnostics} from ${JSON.stringify(module)}; createRequestDiagnostics();`], { timeout: 1500 });
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
});
