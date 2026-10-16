// Existing Playwright event metadata only. Private object paths/ranges never leave this recorder.
const LIMITS = Object.freeze({ pages: 4, objects: 512, rowsPerPage: 256, activePerPage: 64 });
const TIMING_FIELDS = ["startTime", "domainLookupStart", "domainLookupEnd", "connectStart", "secureConnectionStart", "connectEnd", "requestStart", "responseStart", "responseEnd"];
const number = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;

export function createBroadcastRequestTimings({ origin, epochMs, now = Date.now, objectCapacity = LIMITS.objects, rowCapacity = LIMITS.rowsPerPage, activeCapacity = LIMITS.activePerPage }) {
  const base = new URL(origin);
  if (!["http:", "https:"].includes(base.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(base.hostname)
    || base.username || base.password || base.pathname !== "/" || base.search || base.hash || number(epochMs) === null) throw Error("Owned loopback origin required");
  for (const [value, max] of [[objectCapacity, LIMITS.objects], [rowCapacity, LIMITS.rowsPerPage], [activeCapacity, LIMITS.activePerPage]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error("Invalid request observation bounds");
  }
  const objects = new Map(), pages = new Map();
  let unlabelledObjects = 0, closed = false;
  const at = () => { try { return number(now() - epochMs); } catch { return null; } };
  function classify(request, totals) {
    try {
      const raw = request.url();
      if (typeof raw !== "string" || raw.length > 8192) throw Error();
      const url = new URL(raw);
      if (url.origin !== base.origin || !url.pathname.startsWith("/media/")) return null;
      if (url.pathname.length > 2048) throw Error();
      let range = null;
      try { range = request.headers().range ?? ""; } catch { totals.metadataUnknown++; }
      const rangeKnown = typeof range === "string" && range.length <= 128 && (!range || /^bytes=\d*-\d*$/u.test(range));
      const category = url.pathname.endsWith(".m3u8") ? "playlist" : url.pathname.endsWith(".ts") ? "segment" : "other-media";
      const low = /\/low\//u.test(url.pathname), high = /\/high\//u.test(url.pathname);
      const rendition = category === "playlist" && url.pathname === "/media/master.m3u8" ? "master" : low !== high ? (low ? "low" : "high") : "unknown";
      // Query strings do not select media bytes on this fixture's pathname-only server.
      return { category, rendition, key: rangeKnown ? `${url.pathname}\n${range}` : null, rangePresent: rangeKnown ? Boolean(range) : null };
    } catch { totals.classificationUnknown++; return null; }
  }
  function objectLabel(key) {
    if (key === null) { unlabelledObjects++; return null; }
    if (objects.has(key)) return objects.get(key);
    if (objects.size === objectCapacity) { unlabelledObjects++; return null; }
    const id = objects.size + 1; objects.set(key, id); return id;
  }
  function page(role) {
    if (closed || pages.has(role) || !["contributor-low", "contributor-high", "baseline", "consumer"].includes(role) || pages.size >= LIMITS.pages) throw Error("Invalid owned page");
    const rows = [], active = new Map(); let nextId = 0, detach, finalSnapshot, listenersDetached = false;
    const totals = { started: 0, responses: 0, finished: 0, failed: 0, retainedDetailEvictions: 0, activeOverflow: 0, responseWithoutTrackedStart: 0, terminalWithoutTrackedStart: 0,
      classificationUnknown: 0, metadataUnknown: 0, rangeUnknown: 0, statusUnknownAtTerminal: 0, timingUnknownAtTerminal: 0 };
    const statusClasses = { informational: 0, success: 0, redirect: 0, clientError: 0, serverError: 0, unknown: 0 };
    function timing(request, row) {
      try { const value = request.timing(); row.timing = Object.fromEntries(TIMING_FIELDS.map((field) => {
        const observed = value?.[field];
        // Playwright uses zero as the not-yet-populated epoch placeholder;
        // zero remains valid for relative request/response durations.
        return [field, field === "startTime" && observed === 0 ? null : number(observed)];
      })); }
      catch { row.timing = Object.fromEntries(TIMING_FIELDS.map((field) => [field, null])); totals.metadataUnknown++; }
    }
    function request(request) {
      if (closed) return;
      const item = classify(request, totals); if (!item) return;
      totals.started++;
      if (active.size === activeCapacity) { totals.activeOverflow++; return; }
      if (active.has(request)) return;
      let method = "unknown"; try { const value = request.method(); method = ["GET", "HEAD"].includes(value) ? value : "other"; } catch { totals.metadataUnknown++; }
      if (item.rangePresent === null) totals.rangeUnknown++;
      const row = { id: ++nextId, object: objectLabel(item.key), category: item.category, rendition: item.rendition, rangePresent: item.rangePresent, method,
        requestObservedMs: at(), responseObservedMs: null, terminalObservedMs: null, status: null, outcome: "pending", timing: null };
      timing(request, row); active.set(request, row);
      if (rows.length === rowCapacity) { rows.shift(); totals.retainedDetailEvictions++; }
      rows.push(row);
    }
    function response(response) {
      if (closed) return;
      try {
        const request = response.request(), row = active.get(request);
        if (!row && !classify(request, totals)) return;
        totals.responses++;
        let rawStatus; try { rawStatus = response.status(); } catch { totals.metadataUnknown++; }
        const status = Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599 ? rawStatus : null;
        statusClasses[status === null ? "unknown" : ["informational", "success", "redirect", "clientError", "serverError"][Math.floor(status / 100) - 1]]++;
        if (!row) { totals.responseWithoutTrackedStart++; return; }
        row.responseObservedMs = at(); row.status = status;
        if (status === null) totals.metadataUnknown++;
        timing(request, row);
      } catch { totals.metadataUnknown++; }
    }
    function terminal(request, failed) {
      if (closed) return;
      const row = active.get(request);
      if (!row) { if (classify(request, totals)) { totals[failed ? "failed" : "finished"]++; totals.terminalWithoutTrackedStart++; } return; }
      active.delete(request); totals[failed ? "failed" : "finished"]++;
      row.terminalObservedMs = at(); row.outcome = failed ? "failed" : "finished"; timing(request, row);
      if (row.status === null) totals.statusUnknownAtTerminal++;
      if (row.timing.responseEnd === null) totals.timingUnknownAtTerminal++;
    }
    function snapshot() {
      if (finalSnapshot) return structuredClone(finalSnapshot);
      const copy = (row) => ({ ...row, timing: { ...row.timing } });
      return { role, totals: { ...totals }, statusClasses: { ...statusClasses }, pending: active.size,
        untrackedPendingLowerBound: Math.max(0, totals.started - totals.finished - totals.failed - active.size), rows: rows.map(copy), pendingRows: [...active.values()].map(copy) };
    }
    const api = { request, response, finished: (request) => terminal(request, false), failed: (request) => terminal(request, true), snapshot,
      attach(target) {
        if (detach) throw Error("Already attached");
        const handlers = { request, response, requestfinished: api.finished, requestfailed: api.failed };
        for (const [name, handler] of Object.entries(handlers)) target.on(name, handler);
        detach = () => { let ok = true; for (const [name, handler] of Object.entries(handlers)) { try { target.off(name, handler); } catch { totals.metadataUnknown++; ok = false; } } return ok; };
      }, release() { listenersDetached = detach ? detach() : true; detach = null; finalSnapshot = snapshot(); active.clear(); rows.length = 0; }, retainedHandles: () => active.size, listenersDetached: () => listenersDetached };
    pages.set(role, api); return api;
  }
  function snapshot() { return { v: 1, scope: "Existing own-loopback media request events; no body reads, additional requests or playback changes. Object labels correlate pathname/range only within this run, not parsed playlist continuity or sequence.",
    timingClock: "startTime is Playwright epoch milliseconds; other timing fields are relative milliseconds, unavailable values are null; event observations are relative to fixture epoch", limits: { pages: LIMITS.pages, objects: objectCapacity, rowsPerPage: rowCapacity, activePerPage: activeCapacity },
    statusDoesNotProveBodySuccess: true, objectLabels: objects.size, unlabelledObjectObservations: unlabelledObjects, pages: [...pages.values()].map((p) => p.snapshot()) }; }
  return { page, snapshot, close() { const result = snapshot(); closed = true; for (const p of pages.values()) p.release(); objects.clear();
    return { ...result, pages: [...pages.values()].map((p) => p.snapshot()), cleanup: { listenersDetached: [...pages.values()].every((p) => p.listenersDetached()), retainedRequestHandles: [...pages.values()].reduce((sum, p) => sum + p.retainedHandles(), 0), objectLookupReleased: objects.size === 0 } }; } };
}
