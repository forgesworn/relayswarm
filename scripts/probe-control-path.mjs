#!/usr/bin/env node
import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { appServerTiming } from "../demo/fetch-diagnostics.mjs";
import { isCliEntry } from "../src/cli-entry.mjs";

function origin(raw, local) {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || !(local ? ["http:", "https:"].includes(url.protocol) : url.protocol === "https:")) throw new Error("Supply credential-free origins; public probes require HTTPS.");
  if (local && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Local probes require a literal loopback origin.");
  return url;
}
const elapsed = (start) => Math.round(Math.max(0, Math.min(60000, performance.now() - start)) * 10) / 10;
const defaultRequest = (url, options, callback) => (url.protocol === "https:" ? https : http).request(url, options, callback);

/** Concurrent normal-TLS HTTP/1.1 probes. No redirects, auth, queries or stored bodies. */
export async function probeControlPaths({ publicOrigin, loopbackOrigin, signal, timeoutMs = 5000, maxBytes = 65536,
  requestImpl = defaultRequest } = {}) {
  const targets = { public: origin(publicOrigin, false), loopback: origin(loopbackOrigin, true) };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 20 || timeoutMs > 10000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024 || typeof requestImpl !== "function") throw new Error("Invalid probe limits.");
  const at = new Date().toISOString(), batchStart = performance.now();
  const rows = await Promise.all(Object.entries(targets).flatMap(([location, base]) => ["session", "policy"].map((route) => new Promise((resolve) => {
    const start = performance.now(), row = { location, route, startOffsetMs: elapsed(batchStart), status: null, headerMs: null, durationMs: null, bytes: 0, appHeadersMs: null, outcome: null };
    let request, response, settled = false, timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel);
      row.durationMs = elapsed(start); row.outcome = outcome; resolve(row);
    };
    const cancel = () => { finish("cancelled"); response?.destroy(); request?.destroy(); };
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => { finish("timeout"); response?.destroy(); request?.destroy(); }, timeoutMs); timer.unref();
    try {
      request = requestImpl(new URL(route === "session" ? "/session.json" : "/delivery-policy.json", base), { method: "GET", agent: false, signal }, (incoming) => {
        response = incoming;
        if (settled) { response.destroy(); return; }
        row.status = response.statusCode; row.headerMs = elapsed(start); row.appHeadersMs = appServerTiming(response.headers["server-timing"]);
        response.on("data", (chunk) => {
          row.bytes = Math.min(maxBytes + 1, row.bytes + chunk.length);
          if (row.bytes > maxBytes) { finish("body-limit"); response.destroy(); request.destroy(); }
        });
        response.once("end", () => finish(row.status >= 200 && row.status < 300 ? "ok" : "http-error"));
        response.once("error", () => finish(signal?.aborted ? "cancelled" : "error"));
        response.once("close", () => { if (!response.complete) finish("incomplete"); });
      });
      request.once("error", () => finish(signal?.aborted ? "cancelled" : "error"));
      if (settled) request.destroy(); else request.end();
    } catch { finish(signal?.aborted ? "cancelled" : "error"); response?.destroy(); request?.destroy(); }
  }))));
  return { v: 1, at, timeoutMs, maxBytes, customTransport: requestImpl !== defaultRequest, rows,
    scope: "Concurrent HTTP/1.1 GETs to explicit public HTTPS and same-machine loopback origins. Default transport verifies TLS and uses fresh connections; custom transport is labelled and its TLS must be established separately. Transport differs from browser HTTP/2. No addresses/origins/queries/credentials/bodies/errors retained. Loopback means the machine running this helper." };
}

async function main() {
  const { values } = parseArgs({ options: { "public-origin": { type: "string" }, "loopback-origin": { type: "string" }, duration: { type: "string", default: "60000" }, interval: { type: "string", default: "5000" }, timeout: { type: "string", default: "5000" } } });
  const duration = Number(values.duration), interval = Number(values.interval), timeoutMs = Number(values.timeout);
  if (!Number.isSafeInteger(duration) || duration < 100 || duration > 300000 || !Number.isSafeInteger(interval) || interval < 100 || interval > 60000) throw new Error("Bound probes to100ms–5min, interval100ms–60s.");
  const cancellation = new AbortController(), stop = () => cancellation.abort();
  const bound = setTimeout(stop, duration); bound.unref();
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  const deadline = performance.now() + duration;
  try {
    while (performance.now() < deadline && !cancellation.signal.aborted) {
      const start = performance.now(), remaining = Math.max(20, Math.floor(deadline - start));
      const record = await probeControlPaths({ publicOrigin: values["public-origin"], loopbackOrigin: values["loopback-origin"], signal: cancellation.signal, timeoutMs: Math.min(timeoutMs, remaining) });
      process.stdout.write(`${JSON.stringify(record)}\n`);
      if (!cancellation.signal.aborted) await new Promise((done) => { const timer = setTimeout(finish, Math.max(0, Math.min(deadline - performance.now(), interval - (performance.now() - start)))); function finish() { clearTimeout(timer); cancellation.signal.removeEventListener("abort", finish); done(); } cancellation.signal.addEventListener("abort", finish, { once: true }); });
    }
  } finally { clearTimeout(bound); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (await isCliEntry(import.meta.url)) main().catch(() => { console.error("Control probe failed; verify explicit origins and numeric bounds."); process.exitCode = 1; });
