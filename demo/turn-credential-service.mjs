import { randomBytes } from "node:crypto";
import { validateIceConfig } from "../src/ice-config.mjs";
import { boundedOperation } from "../src/browser/bounded-operation.mjs";

const ENDPOINT = "/turn-credentials", COOKIE = "relayswarm_turn", VIEWER_MS = 10800000;
const exact = (value, keys) => value && !Array.isArray(value) && typeof value === "object"
  && Object.keys(value).sort().join() === [...keys].sort().join();
class TurnError extends Error {
  constructor(code, status = 503) { super("TURN credentials unavailable."); this.code = code; this.status = status; }
}
const fail = (code = "turn-unavailable", status = 503) => { throw new TurnError(code, status); };
export function validateTurnCredentialsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("TURN credential issuer must be a credential-free HTTPS URL."); }
  if (typeof value !== "string" || value.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(value)
    || url.protocol !== "https:" || url.username || url.password || value.includes("?") || value.includes("#")) {
    throw new Error("TURN credential issuer must be a credential-free HTTPS URL.");
  }
  return url.href;
}

export function validateTurnUrlProjection(value = "issued") {
  if (!["issued", "tls-tcp"].includes(value)) throw new Error("Invalid TURN URL projection; use issued or tls-tcp.");
  return value;
}

/** Optional issuer proxy. Cookies isolate bounded viewer caches; they are not account authentication. */
export function createTurnCredentialService({ url, urlProjection = "issued", fetchImpl = globalThis.fetch, now = Date.now, monotonicNow = () => performance.now(),
  capacity = 64, activeCapacity = 64, timeoutMs = 4000 } = {}) {
  validateTurnUrlProjection(urlProjection);
  const issuer = validateTurnCredentialsUrl(url);
  if (typeof fetchImpl !== "function" || typeof now !== "function" || typeof monotonicNow !== "function"
    || !Number.isInteger(capacity) || capacity < 1 || capacity > 64 || !Number.isInteger(activeCapacity) || activeCapacity < 1 || activeCapacity > 64
    || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 4000) throw new Error("Invalid TURN credential service bounds.");
  const viewers = new Map(), connections = new Set(), issuing = new Set(), rawTasks = new Set(), handles = new Set();
  let closing = false, closePromise, highestWall = -Infinity, highestMono = -Infinity, clockFault = false, tokens = 10, refillAt;
  function clock() {
    const wall = now(), mono = monotonicNow();
    if (clockFault || !Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(mono) || mono < 0 || wall < highestWall || mono < highestMono) {
      clockFault = true; fail();
    }
    highestWall = wall; highestMono = mono;
    return { wall, mono };
  }
  refillAt = clock().mono;
  function prune(time) {
    for (const [token, entry] of viewers) {
      if (entry.untilWall <= time.wall || entry.untilMono <= time.mono) {
        entry.pending?.controller.abort(); viewers.delete(token);
      } else if (entry.cache && (entry.cache.expiresAt <= time.wall || entry.cache.expiresMono <= time.mono)) entry.cache = null;
    }
  }
  function viewer(request, response, origin, time) {
    const cookies = request.headers.cookie || "";
    if (typeof cookies !== "string" || cookies.length > 4096) fail("turn-cookie-invalid", 400);
    const matches = cookies.split(";").map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
    if (matches.length > 1 || matches[0] && !new RegExp(`^${COOKIE}=[a-f0-9]{64}$`, "u").test(matches[0])) fail("turn-cookie-invalid", 400);
    const prior = matches[0]?.slice(COOKIE.length + 1), existing = viewers.get(prior);
    if (existing) return existing;
    if (viewers.size >= capacity) fail("turn-viewer-capacity", 429);
    const token = randomBytes(32).toString("hex");
    const entry = { token, untilWall: time.wall + VIEWER_MS, untilMono: time.mono + VIEWER_MS, cache: null, pending: null };
    viewers.set(token, entry);
    response.setHeader("set-cookie", `${COOKIE}=${token}; Path=${ENDPOINT}; HttpOnly; SameSite=Strict; Max-Age=10800${origin.startsWith("https:") ? "; Secure" : ""}`);
    return entry;
  }
  async function readBody(request, signal) {
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") fail("turn-json-required", 415);
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0, timer, finished = false;
      const finish = (error, value) => {
        if (finished) return; finished = true;
        clearTimeout(timer); request.off("data", data); request.off("end", end); request.off("error", abort); signal.removeEventListener("abort", abort);
        if (error) { request.resume(); reject(error); } else resolve(value);
      };
      const abort = () => finish(new TurnError());
      const data = chunk => { size += chunk.length; if (size > 128) finish(new TurnError("turn-body-too-large", 413)); else chunks.push(chunk); };
      const end = () => {
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return finish(new TurnError("turn-json-invalid", 400)); }
        if (!exact(value, ["v"]) || value.v !== 1) return finish(new TurnError("turn-request-invalid", 400));
        finish(null, value);
      };
      if (signal.aborted) return abort();
      request.on("data", data); request.once("end", end); request.once("error", abort); signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => finish(new TurnError("turn-body-timeout")), 1000);
    });
  }
  function issue(entry, time) {
    tokens = Math.min(10, tokens + (time.mono - refillAt) / 3000); refillAt = time.mono;
    if (tokens < 1 || issuing.size >= 10) fail("turn-issuer-throttled", 429);
    tokens--;
    const record = { controller: new AbortController(), waiters: 0, promise: null, rawStarted: false };
    entry.pending = record; issuing.add(record);
    record.promise = boundedOperation(signal => {
      record.rawStarted = true;
      const task = (async () => {
        let reader, result, response;
        const io = new AbortController();
        try {
          response = await fetchImpl(issuer, { method: "GET", cache: "no-store", redirect: "error", credentials: "omit", signal: AbortSignal.any([signal, io.signal]),
            headers: { accept: "application/json" } });
          if (signal.aborted || closing || response.status !== 200 || response.redirected || response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") fail();
          const declared = response.headers.get("content-length");
          if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > 16384)) fail();
          reader = response.body?.getReader(); if (!reader) fail();
          const chunks = []; let size = 0;
          while (true) {
            const part = await reader.read();
            if (signal.aborted || closing) fail();
            if (part.done) break;
            if (!part.value?.byteLength) fail();
            size += part.value.byteLength; if (size > 16384) fail(); chunks.push(part.value);
          }
          let body; try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(); }
          if (!exact(body, ["urls", "username", "credential", "ttl"]) || !Number.isSafeInteger(body.ttl) || body.ttl < 5 || body.ttl > 3600
            || !Array.isArray(body.urls) || body.urls.length < 1 || body.urls.length > 4 || body.urls.some(value => typeof value !== "string" || !/^turns?:/u.test(value))) fail();
          let iceServers;
          try { iceServers = validateIceConfig({ v: 1, iceServers: [{ urls: body.urls, username: body.username, credential: body.credential }] }); } catch { fail(); }
          const issuedAt = Math.floor(time.wall / 1000) * 1000, expiresAt = issuedAt + body.ttl * 1000, refreshAt = issuedAt + Math.floor(body.ttl * 1000 * 2 / 3);
          const current = clock(), expiresMono = time.mono + expiresAt - time.wall, refreshMono = time.mono + refreshAt - time.wall;
          if (signal.aborted || closing || viewers.get(entry.token) !== entry || current.wall >= expiresAt || current.mono >= expiresMono) fail();
          result = { iceServers, ttlSeconds: body.ttl, issuedAt, expiresAt, refreshAt, expiresMono, refreshMono };
        } finally {
          if (!result || signal.aborted || closing) io.abort();
          try {
            if (reader) { try { await reader.cancel(); } finally { reader.releaseLock(); } }
            else await response?.body?.cancel();
          } catch (error) { io.abort(); throw error; }
        }
        const current = clock();
        if (signal.aborted || closing || viewers.get(entry.token) !== entry || current.wall >= result.expiresAt || current.mono >= result.expiresMono) fail();
        entry.cache = result;
        return result;
      })();
      rawTasks.add(task); task.finally(() => {
        rawTasks.delete(task); issuing.delete(record); if (entry.pending === record) entry.pending = null;
      }).catch(() => {});
      return task;
    }, record.controller.signal, timeoutMs).finally(() => {
      // Logical timeout is not proof the upstream task settled. Retain the
      // same rejected single flight until its actual body/cancel task ends.
      if (!record.rawStarted) { if (entry.pending === record) entry.pending = null; issuing.delete(record); }
    });
    record.promise.catch(() => {});
    return record;
  }
  async function credential(entry, signal) {
    const time = clock(), cached = entry.cache;
    if (cached && time.wall < cached.refreshAt && time.mono < cached.refreshMono) return cached;
    const pending = entry.pending || issue(entry, time);
    pending.waiters++;
    let cancel;
    try {
      if (signal.aborted) fail();
      return await Promise.race([pending.promise, new Promise((_, reject) => { cancel = () => reject(new TurnError()); signal.addEventListener("abort", cancel, { once: true }); })]);
    } finally {
      signal.removeEventListener("abort", cancel); pending.waiters--;
      if (pending.waiters === 0) pending.controller.abort();
    }
  }
  function responseServers(result) {
    if (urlProjection === "issued") return result.iceServers;
    // Select TCP only where the issuer left a secure URI's transport unspecified.
    // The issued/cache entry and its original lease are never modified.
    const servers = result.iceServers.map(server => ({ ...server, urls: server.urls.flatMap(value => {
      if (!value.startsWith("turns:")) return [];
      if (!value.includes("?")) return [`${value}?transport=tcp`];
      return value.endsWith("?transport=tcp") ? [value] : [];
    }) })).filter(server => server.urls.length > 0);
    if (servers.length === 0) fail("turn-tls-tcp-unavailable");
    try { return validateIceConfig({ v: 1, iceServers: servers }); } catch { fail("turn-tls-tcp-unavailable"); }
  }
  async function serve(request, response, path, base) {
    if (path !== ENDPOINT) return false;
    let controller;
    const disconnect = () => { if (!response.writableEnded) controller?.abort(); };
    try {
      if (closing) fail();
      if (request.method !== "POST") { response.writeHead(405, { allow: "POST", "cache-control": "no-store" }).end(); return true; }
      const origin = new URL(base).origin;
      if (request.headers.origin !== origin || request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") fail("turn-same-origin-required", 403);
      if (connections.size >= activeCapacity) fail("turn-request-capacity", 429);
      controller = new AbortController(); connections.add(controller);
      request.once("aborted", disconnect); response.once("close", disconnect);
      await readBody(request, controller.signal);
      const time = clock(); prune(time);
      if (closing || controller.signal.aborted) fail();
      const entry = viewer(request, response, origin, time), result = await credential(entry, controller.signal), current = clock();
      if (closing || controller.signal.aborted || response.destroyed || current.wall >= result.expiresAt || current.mono >= result.expiresMono) fail();
      const iceServers = responseServers(result);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ v: 1,
        iceServers, ttlSeconds: result.ttlSeconds, issuedAt: result.issuedAt, expiresAt: result.expiresAt, refreshAt: result.refreshAt, serverTime: current.wall }));
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        const known = error instanceof TurnError, status = known ? error.status : 503;
        response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...(status === 429 ? { "retry-after": "3" } : {}), ...(!request.complete ? { connection: "close" } : {}) })
          .end(JSON.stringify({ error: known ? error.code : "turn-unavailable" }));
      }
    } finally { connections.delete(controller); request.off("aborted", disconnect); response.off("close", disconnect); }
    return true;
  }
  return { descriptor: () => ({ v: 1, endpoint: ENDPOINT, method: "POST", ...(urlProjection === "tls-tcp" ? { urlProjection } : {}) }),
    handle(...args) {
      const task = serve(...args); handles.add(task); task.finally(() => handles.delete(task)).catch(() => {}); return task;
    },
    close() {
      if (!closePromise) {
        closing = true; for (const controller of connections) controller.abort(); for (const record of issuing) record.controller.abort(); viewers.clear();
        closePromise = (async () => {
          let timer;
          try {
            const settled = await Promise.race([Promise.allSettled([...rawTasks, ...handles]).then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 250); })]);
            if (!settled) throw new Error("TURN issuer cancellation remains unresolved.");
          } finally { clearTimeout(timer); }
        })();
      }
      return closePromise;
    } };
}
