import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createFetchDiagnostics, appServerTiming } from "../demo/fetch-diagnostics.mjs";

test("caller init/signal/body reach the fetch unchanged; only safe numeric records remain", async () => {
  const signal = new AbortController().signal, input = "https://example.invalid/session.json?private=SECRET", init = { signal, method: "POST", body: "SECRET", headers: { authorization: "SECRET" } };
  let clock = 0;
  const diagnostics = createFetchDiagnostics({ now: () => clock, fetchImpl: async (url, options) => { assert.equal(url, input); assert.equal(options, init); assert.equal(options.signal, signal); clock = 20; return { ok: true, status: 200, headers: { get: () => 'rs-app;dur=4.2, ignored;desc="SECRET"' }, json: async () => { clock = 35; return { private: "SECRET" }; } }; } });
  assert.deepEqual(await diagnostics.json("session", input, init), { private: "SECRET" }); const record = diagnostics.snapshot().records[0];
  assert.equal(record.headerMs, 20); assert.equal(record.bodyMs, 15); assert.equal(record.durationMs, 35); assert.equal(record.appHeadersMs, 4.2); assert.equal(record.outcome, "ok");
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes("SECRET")); diagnostics.close();
});
test("real timeout while JSON body is held closes caller fetch and records cancellation", async (t) => {
  let closed; const socketClosed = new Promise((done) => { closed = done; });
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.write('{"secret":'); response.once("close", closed); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done)); t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  const diagnostics = createFetchDiagnostics(), controller = new AbortController();
  const pending = diagnostics.json("policy", `http://127.0.0.1:${server.address().port}/delivery-policy.json`, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(new Error("SECRET cancellation reason")), 50);
  await assert.rejects(pending); clearTimeout(timer); await socketClosed;
  const snapshot = diagnostics.snapshot(); assert.equal(snapshot.pending, 0); assert.equal(snapshot.records.length, 1); assert.equal(snapshot.records[0].outcome, "cancelled"); assert.ok(!JSON.stringify(snapshot).includes("SECRET")); diagnostics.close();
});
test("overflow/late completion and close never abort signals or retain extra observations", async () => {
  const waits = [], diagnostics = createFetchDiagnostics({ capacity: 2, maxPending: 1, fetchImpl: () => new Promise((done) => waits.push(done)) });
  const response = { ok: true, status: 200, json: async () => ({ ok: true }) }, controller = new AbortController();
  const first = diagnostics.json("policy", "SECRET", { signal: controller.signal }), second = diagnostics.json("session", "SECRET");
  assert.equal(diagnostics.snapshot().pending, 1); assert.equal(diagnostics.snapshot().dropped, 1); controller.abort(); assert.equal(diagnostics.snapshot().pending, 0);
  waits[0](response); waits[1](response); await Promise.all([first, second]); assert.equal(diagnostics.snapshot().records.length, 1); assert.equal(diagnostics.snapshot().records[0].outcome, "cancelled");
  const third = diagnostics.json("report", "SECRET", { signal: new AbortController().signal }); diagnostics.close(); waits[2](response); await third;
  assert.equal(diagnostics.snapshot().records.length, 2); assert.equal(diagnostics.snapshot().records.at(-1).outcome, "closed"); assert.ok(!JSON.stringify(diagnostics.snapshot()).includes("SECRET"));
});
test("HTTP errors skip JSON, errors/unknown labels stay private, numeric retention clips", async () => {
  let ok = false, clock = 0;
  const diagnostics = createFetchDiagnostics({ capacity: 2, now: () => clock, fetchImpl: async () => { clock += 70000; return { ok, status: ok ? 200 : 429, headers: { get: () => "rs-app;dur=Infinity, SECRET" }, json: async () => { if (!ok) throw Error("must not read body"); return {}; } }; } });
  await assert.rejects(diagnostics.json("policy", "SECRET"), /unavailable/u); assert.equal(diagnostics.snapshot().records[0].outcome, "http-error");
  ok = true; for (let i = 0; i < 4; i++) await diagnostics.json("session", "SECRET"); await diagnostics.json("SECRET arbitrary route", "SECRET");
  const snapshot = diagnostics.snapshot(); assert.equal(snapshot.records.length, 2); assert.equal(snapshot.clipped, 5); assert.equal(snapshot.records[0].durationMs, 60000); assert.equal(snapshot.records[0].appHeadersMs, null); assert.ok(!JSON.stringify(snapshot).includes("SECRET")); diagnostics.close();
  for (const value of ["rs-app;dur=Infinity", "rs-app;dur=-1", "rs-app;dur=60001", "rs-app;dur=1e99", "x".repeat(257)]) assert.equal(appServerTiming(value), null);
});
