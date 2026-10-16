import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { CONTROL_ROUTE_LABELS, controlRouteLabel } from "./fetch-diagnostics.mjs";
export { controlRouteLabel } from "./fetch-diagnostics.mjs";

const buckets = Object.freeze([10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000]);
const ms = (value) => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(60000, value)) * 10) / 10 : null;
const increment = (object, key) => { object[key] = Math.min(Number.MAX_SAFE_INTEGER, object[key] + 1); };
const routeStats = () => ({ started: 0, finished: 0, cancelled: 0, expired: 0, dropped: 0, headersCount: 0, headerMaxMs: 0, terminalMaxMs: 0,
  headersHistogram: buckets.map(() => 0), terminalHistogram: buckets.map(() => 0), statusClasses: [0, 0, 0, 0, 0, 0] });

/** Bounded operator-only aggregates; public response header contains only elapsed ms. */
export function createRequestDiagnostics({ now = () => performance.now(), wallNow = Date.now, intervalMs = 1000, retainWindows = 120,
  maxActive = 128, maxAgeMs = 30000, serverTiming = true } = {}) {
  if (typeof now !== "function" || typeof wallNow !== "function" || !Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 10000
      || !Number.isSafeInteger(retainWindows) || retainWindows < 1 || retainWindows > 600 || !Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 256
      || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 20 || maxAgeMs > 60000 || typeof serverTiming !== "boolean") throw new Error("Invalid request diagnostic limits.");
  const active = new Map(), windows = [], histogram = monitorEventLoopDelay({ resolution: Math.min(20, intervalMs) });
  histogram.enable();
  let closed = false, elu = performance.eventLoopUtilization(), sampledAt = performance.now();
  let current = freshWindow();
  function freshWindow() { return { startedAtMs: Math.round(wallNow()), routes: Object.fromEntries(CONTROL_ROUTE_LABELS.map((label) => [label, routeStats()])) }; }
  function recordHistogram(target, duration) { increment(target, String(Math.max(0, buckets.findIndex((upper) => duration <= upper)))); }
  function headers(record, response, args) {
    if (record.headerAt !== undefined || record.done) return;
    record.headerAt = now();
    const duration = ms(record.headerAt - record.start), stats = current.routes[record.route];
    increment(stats, "headersCount"); stats.headerMaxMs = Math.max(stats.headerMaxMs, duration); recordHistogram(stats.headersHistogram, duration);
    // Preserve writeHead overloads, caller headers and existing Server-Timing.
    const supplied = args[2] ?? (typeof args[1] === "object" ? args[1] : null);
    const suppliesTiming = supplied && (Array.isArray(supplied) ? supplied.some((value, i) => i % 2 === 0 && String(value).toLowerCase() === "server-timing")
      : Object.keys(supplied).some((name) => name.toLowerCase() === "server-timing"));
    if (serverTiming && !response.headersSent && !response.hasHeader("server-timing") && !suppliesTiming) response.setHeader("server-timing", `rs-app;dur=${duration}`);
  }
  function finish(record, outcome) {
    if (record.done) return;
    record.done = true; active.delete(record.response);
    const { response } = record;
    response.off("finish", record.onFinish); response.off("close", record.onClose);
    if (response.writeHead === record.wrapper) response.writeHead = record.original;
    const stats = current.routes[record.route], duration = ms(now() - record.start);
    increment(stats, outcome); stats.terminalMaxMs = Math.max(stats.terminalMaxMs, duration); recordHistogram(stats.terminalHistogram, duration);
    const status = Number(response.statusCode), category = response.headersSent && Number.isInteger(status) && status >= 100 && status < 600 ? Math.floor(status / 100) : 0;
    increment(stats.statusClasses, String(category));
  }
  function sample() {
    if (closed) return;
    for (const record of active.values()) if (now() - record.start >= maxAgeMs) finish(record, "expired");
    const sampleAt = performance.now(), schedulerDriftMs = ms(Math.max(0, sampleAt - sampledAt - intervalMs)); sampledAt = sampleAt;
    const next = performance.eventLoopUtilization(), delta = performance.eventLoopUtilization(next, elu); elu = next;
    current.endedAtMs = Math.round(wallNow()); current.eventLoop = { samples: histogram.count, delayMeanMs: histogram.count ? ms(histogram.mean / 1e6) : null,
      delayP99Ms: histogram.count ? ms(histogram.percentile(99) / 1e6) : null, delayMaxMs: histogram.count ? ms(histogram.max / 1e6) : null,
      schedulerDriftMs, utilisation: Math.round(Math.max(0, Math.min(1, delta.utilization || 0)) * 10000) / 10000 };
    histogram.reset(); windows.push(current); if (windows.length > retainWindows) windows.shift(); current = freshWindow();
  }
  const timer = setInterval(sample, intervalMs); timer.unref();
  return {
    observe(request, response) {
      const route = controlRouteLabel(request.url);
      if (closed || !route || active.has(response)) return false;
      const stats = current.routes[route]; increment(stats, "started");
      if (active.size >= maxActive) { increment(stats, "dropped"); return false; }
      const record = { route, response, start: now(), done: false, original: response.writeHead };
      record.wrapper = function (...args) { headers(record, this, args); return record.original.apply(this, args); };
      record.onFinish = () => finish(record, "finished"); record.onClose = () => finish(record, "cancelled");
      active.set(response, record); response.writeHead = record.wrapper;
      response.once("finish", record.onFinish); response.once("close", record.onClose); return true;
    },
    snapshot: () => ({ v: 1, intervalMs, retainWindows, maxActive, maxAgeMs, active: active.size, closed, durationBucketsMs: [...buckets], statusClassLabels: ["noHeadersOrUnknown", "1xx", "2xx", "3xx", "4xx", "5xx"],
      windows: structuredClone(windows), current: structuredClone(current),
      scope: "Fixed control routes only; rolling numeric aggregates, no request identities/paths/query/headers/bodies. rs-app header is handler entry→headers; terminal timings include finish, early close and diagnostic expiry; finish is server stream handoff, not client receipt. Event-loop delay includes sampling resolution; elapsed durations capped60s." }),
    close() { if (closed) return; sample(); closed = true; clearInterval(timer); histogram.disable(); for (const record of [...active.values()]) finish(record, "cancelled"); },
  };
}
