export const CONTROL_ROUTE_LABELS = Object.freeze(["session", "policy", "admissionChallenge", "admissionTicket", "admissionVerify", "report", "commitment"]);
const paths = Object.freeze({ "/session.json": "session", "/delivery-policy.json": "policy", "/admission/challenge": "admissionChallenge", "/admission/ticket": "admissionTicket", "/admission/verify": "admissionVerify", "/reports": "report", "/commitment": "commitment" });
const limit = (value) => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(60000, value)) * 10) / 10 : null;
export function controlRouteLabel(raw) {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  try { return paths[new URL(raw, "http://localhost").pathname] ?? null; } catch { return null; }
}
export function appServerTiming(value) {
  if (typeof value !== "string" || value.length > 256) return null;
  const match = /(?:^|,)\s*rs-app\s*;\s*dur=(\d+(?:\.\d+)?)(?=\s*(?:;|,|$))/u.exec(value);
  const duration = match ? Number(match[1]) : NaN;
  return Number.isFinite(duration) && duration >= 0 && duration <= 60000 ? duration : null;
}

/** Local numeric observations only. Caller fetch, signal and deadlines are unchanged. */
export function createFetchDiagnostics({ fetchImpl = globalThis.fetch, now = () => performance.now(), capacity = 64, maxPending = 64 } = {}) {
  if (typeof fetchImpl !== "function" || typeof now !== "function" || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256) throw new Error("Invalid fetch diagnostic limits.");
  const records = [], pending = new Set();
  let closed = false, dropped = 0, clipped = 0;
  const add = (record) => { records.push(record); if (records.length > capacity) records.shift(); };
  async function json(label, input, init = {}) {
    const route = CONTROL_ROUTE_LABELS.includes(label) ? label : null;
    let finish = () => {}, headerAt, status = null, serverMs = null;
    const start = now();
    if (!closed && route && pending.size < maxPending) {
      const entry = { stop: null };
      let completed = false;
      const cancel = () => finish("cancelled");
      finish = (outcome) => {
        if (completed) return;
        completed = true; pending.delete(entry); init.signal?.removeEventListener("abort", cancel);
        const end = now(), duration = end - start;
        if (duration > 60000) clipped = Math.min(Number.MAX_SAFE_INTEGER, clipped + 1);
        add({ route, atMs: Math.round(end), outcome, status, headerMs: headerAt === undefined ? null : limit(headerAt - start),
          bodyMs: headerAt === undefined || outcome === "http-error" ? null : limit(end - headerAt), durationMs: limit(duration), appHeadersMs: serverMs });
      };
      entry.stop = () => finish("closed"); pending.add(entry);
      if (init.signal?.aborted) cancel(); else init.signal?.addEventListener("abort", cancel, { once: true });
    } else if (!closed && route) dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1);
    try {
      // Pass the original init and AbortSignal, including any caller-owned timeout.
      const response = await fetchImpl(input, init);
      headerAt = now(); status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
      serverMs = appServerTiming(response.headers?.get?.("server-timing"));
      if (!response.ok) { finish("http-error"); throw new Error("Control response unavailable."); }
      const value = await response.json(); finish("ok"); return value;
    } catch (error) { finish(init.signal?.aborted ? "cancelled" : "error"); throw error; }
  }
  return { json, snapshot: () => ({ v: 1, capacity, maxPending, pending: pending.size, dropped, clipped, closed,
    records: records.map((entry) => ({ ...entry })), scope: "Local fixed-route numeric fetch/JSON timings; no URLs, identities, headers, bodies or errors. Duration capped at60s; appHeadersMs excludes pre-handler queueing and transport." }),
    close() { if (closed) return; closed = true; for (const entry of [...pending]) entry.stop(); } };
}
