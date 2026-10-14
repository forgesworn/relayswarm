// Optional private TURN state. Importing or configuring never requests credentials.
const invalid = () => new Error("TURN credentials unavailable.");
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && value >= 0;
function credentialResponse(value) {
  if (!exact(value, ["v", "iceServers", "ttlSeconds", "issuedAt", "expiresAt", "refreshAt", "serverTime"]) || value.v !== 1
    || !Number.isInteger(value.ttlSeconds) || value.ttlSeconds < 5 || value.ttlSeconds > 3600
    || ![value.issuedAt, value.expiresAt, value.refreshAt, value.serverTime].every(integer)
    || value.issuedAt % 1000 !== 0 || value.expiresAt !== value.issuedAt + value.ttlSeconds * 1000
    || value.refreshAt !== value.issuedAt + Math.floor(value.ttlSeconds * 1000 * 2 / 3)
    || value.serverTime < value.issuedAt || value.serverTime >= value.expiresAt
    || !Array.isArray(value.iceServers) || value.iceServers.length !== 1) throw invalid();
  const server = value.iceServers[0], secret = value => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);
  if (!exact(server, ["urls", "username", "credential"]) || !secret(server.username) || !secret(server.credential)
    || !Array.isArray(server.urls) || server.urls.length < 1 || server.urls.length > 4) throw invalid();
  for (const value of server.urls) {
    if (typeof value !== "string" || value.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw invalid();
    const url = new URL(value);
    if (!["turn:", "turns:"].includes(url.protocol) || value.includes("#") || url.username || url.password || url.host
      || !/^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::[0-9]+)?$/iu.test(url.pathname)
      || value.includes("?") && !/^\?transport=(?:udp|tcp)$/u.test(url.search)) throw invalid();
    // URL parsing checks bracketed IPv6 and port bounds without DNS or I/O.
    const address = new URL(`http://${url.pathname}`);
    if (address.port === "0") throw invalid();
  }
  return { servers: [{ urls: [...server.urls], username: server.username, credential: server.credential }],
    lifetime: value.expiresAt - value.serverTime, refreshAfter: Math.max(0, value.refreshAt - value.serverTime) };
}

export function createTurnCredentials({ origin, fetchImpl = globalThis.fetch, now = () => performance.now(), wallNow = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, onRefresh = () => {}, onUnavailable = () => {} } = {}) {
  const base = new URL(origin); if (base.origin !== origin || !["http:", "https:"].includes(base.protocol)) throw invalid();
  if (![fetchImpl, now, wallNow, setTimer, clearTimer, onRefresh, onUnavailable].every(value => typeof value === "function")) throw invalid();
  let descriptor = null, identity, generation = 0, current = null, active = false, closed = false, pending = null, refreshTimer, expiryTimer;
  let lastWall = wallNow(), refreshes = 0, failures = 0, outcome = "disabled";
  const count = value => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const left = (record, duration = record.lifetime) => Math.min(duration - (now() - record.mono), duration - (wallNow() - record.wall));
  const clearTimers = () => { clearTimer(refreshTimer); clearTimer(expiryTimer); refreshTimer = expiryTimer = undefined; };
  function abort() { generation++; pending?.controller.abort(); }
  function unavailable(reason) {
    const had = Boolean(current); current = null; active = false; clearTimers(); abort(); outcome = reason;
    if (had) onUnavailable(reason);
  }
  function fresh() {
    if (!descriptor) return !closed;
    const wall = wallNow(), rollback = wall < lastWall; lastWall = wall;
    if (rollback || current && (now() < current.mono || wall < current.wall || left(current) <= 0)) unavailable(rollback ? "clock-rollback" : "expired");
    return !closed && Boolean(current);
  }
  function schedule(retry = false) {
    clearTimers(); if (!current || !fresh()) return;
    expiryTimer = setTimer(() => { if (fresh()) schedule(); }, Math.max(1, left(current)));
    if (active) {
      const delay = retry ? Math.min(5000, Math.max(1, left(current) / 2)) : Math.max(1, left(current, current.refreshAfter));
      refreshTimer = setTimer(() => { void renew(false); }, delay);
    }
  }
  async function readResponse(response, signal) {
    const discard = async () => { try { await response.body?.cancel(); } catch { /* Already closed or locked. */ } };
    if (!response.ok || response.redirected || !response.body?.getReader
      || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers?.get("content-type") ?? "")) { await discard(); throw invalid(); }
    const length = response.headers?.get("content-length");
    if (length !== null && length !== undefined && (!/^\d+$/u.test(length) || Number(length) > 16384)) { await discard(); throw invalid(); }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      while (true) {
        if (signal.aborted) throw invalid();
        const part = await reader.read(); if (signal.aborted) throw invalid();
        if (part.done) break;
        size += part.value.byteLength; if (size > 16384) { await reader.cancel(); throw invalid(); }
        chunks.push(part.value);
      }
      const body = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return credentialResponse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
    } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  }
  function renew(explicit) {
    fresh();
    if (!descriptor || closed || !active) return Promise.resolve(!descriptor && !closed);
    if (pending) return pending.result;
    const attempt = { generation, mono: now(), wall: wallNow(), controller: new AbortController(), hadCurrent: Boolean(current), explicit };
    const { signal } = attempt.controller; pending = attempt; let timer, cancel;
    const deadline = new Promise((_, reject) => {
      cancel = () => reject(invalid()); signal.addEventListener("abort", cancel, { once: true });
      timer = setTimer(() => attempt.controller.abort(), 5000);
    });
    const task = Promise.resolve().then(async () => {
      if (signal.aborted) throw invalid();
      const response = await fetchImpl(new URL(descriptor.endpoint, origin).href, { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { "content-type": "application/json" }, body: '{"v":1}', signal });
      return readResponse(response, signal);
    });
    let settled = false, completed = false;
    const release = () => {
      settled = true; if (pending === attempt) pending = null;
      // A retry may have fired while timed-out work still held the slot.
      // Rearm only after actual settlement, with the original authority intact.
      try {
        if (completed && !explicit && attempt.hadCurrent && generation === attempt.generation && active && !closed && current && fresh()) schedule(true);
      } catch { /* Settlement must never create an unhandled rejection or grant authority. */ }
    };
    // A timed-out fetch/body may ignore abort. Keep its single-flight slot until
    // the underlying work settles; never overlap requests after a logical timeout.
    task.then(release, release);
    attempt.result = Promise.race([task, deadline]).then(value => {
      const wasFresh = fresh();
      if (closed || !active || signal.aborted || generation !== attempt.generation || now() < attempt.mono || wallNow() < attempt.wall
        || left(attempt, 5000) <= 0 || left(attempt, value.lifetime) <= 0) throw invalid();
      current = { ...value, mono: attempt.mono, wall: attempt.wall }; outcome = "accepted"; refreshes = count(refreshes); schedule();
      if (!explicit && attempt.hadCurrent && wasFresh) onRefresh();
      return true;
    }).catch(() => {
      failures = count(failures);
      if (generation === attempt.generation && active && !closed) {
        outcome = signal.aborted ? "cancelled" : "unavailable";
        if (fresh() && current) schedule(true);
      }
      return false;
    }).finally(() => {
      completed = true; clearTimer(timer); signal.removeEventListener("abort", cancel); attempt.controller.abort();
      if (settled && pending === attempt) pending = null;
    });
    return attempt.result;
  }
  return {
    configure(value, nextIdentity) {
      if (closed) return;
      const shape = value === undefined || value === null ? null : value;
      const valid = shape === null || exact(shape, ["v", "endpoint", "method"]) && shape.v === 1 && shape.endpoint === "/turn-credentials" && shape.method === "POST";
      const unchanged = valid && identity === nextIdentity && JSON.stringify(descriptor) === JSON.stringify(shape);
      if (unchanged) return;
      const had = Boolean(current) || Boolean(descriptor); clearTimers(); abort(); current = null; active = false; identity = nextIdentity;
      descriptor = valid ? shape && { ...shape } : { v: 1, endpoint: null, method: "POST" }; outcome = !valid ? "invalid-descriptor" : descriptor ? "waiting" : "disabled";
      if (had || descriptor) onUnavailable("configuration-changed");
    },
    async acquire() {
      if (closed) return false;
      if (!descriptor) return true;
      if (!descriptor.endpoint) return false;
      const available = fresh(); active = true;
      if (available) { schedule(); return true; }
      return renew(true);
    },
    setActive(value) {
      if (closed || !descriptor) return;
      active = value === true;
      if (!active) abort();
      schedule();
    },
    fresh,
    servers() { return descriptor && fresh() ? structuredClone(current.servers) : undefined; },
    suspend() { active = false; clearTimers(); abort(); current = null; if (descriptor) outcome = "suspended"; },
    close() { this.suspend(); closed = true; outcome = "closed"; },
    snapshot() { const available = fresh(); return { v: 1, enabled: Boolean(descriptor), available, active, pending: Boolean(pending), remainingMs: current ? Math.max(0, Math.floor(left(current))) : 0, refreshes, failures, outcome, closed }; },
  };
}
