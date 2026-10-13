import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { acquireExclusiveStateLease } from "../src/exclusive-state-lease.mjs";
import { openPrivateJsonState } from "../src/private-json-state.mjs";

export async function readOperatorTokenFile(path) {
  const target = resolve(path), parent = dirname(target);
  const directory = await lstat(parent);
  if (!directory.isDirectory() || await realpath(parent) !== parent || directory.mode & 0o022 || process.getuid && directory.uid !== process.getuid()) throw new Error("Operator token directory must be owner-controlled and contain no symlinks.");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
  const privateFile = (stat) => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600
    && (!process.getuid || stat.uid === process.getuid()) && stat.size <= 512;
  try {
    const before = await handle.stat();
    if (!privateFile(before)) throw new Error("Operator token file must be an owner-only 0600 regular file.");
    const buffer = Buffer.alloc(513);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(), current = await lstat(target);
    const unchanged = (stat) => privateFile(stat) && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
      && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (bytesRead > 512 || bytesRead !== before.size || !unchanged(after) || !unchanged(current)) throw new Error("Operator token file changed while reading.");
    return buffer.subarray(0, bytesRead).toString("utf8").trim();
  } finally { await handle.close(); }
}

const fields = ["durationMs", "peerBytes", "uploadedBytes", "originMediaRequests", "originMediaBytes", "stalls", "stallMs", "fatalErrors"];
const fail = (message, status) => Object.assign(new Error(message), { status });
export function createOperatorControls({ token, telemetry = false, reportCapacity = 256, reportTtlMs = 300000, now = Date.now, operatorExtraStatus, requestDiagnostics, statePath, admission, mutationCapacity = 64 } = {}) {
  if (token !== undefined && (typeof token !== "string" || token.length < 32 || token.length > 256 || /\s/u.test(token))) throw new Error("Operator token must contain 32-256 non-whitespace characters.");
  if (!Number.isSafeInteger(reportCapacity) || reportCapacity < 1 || reportCapacity > 4096 || !Number.isSafeInteger(reportTtlMs) || reportTtlMs < 1000 || reportTtlMs > 3600000) throw new Error("Invalid report retention limits.");
  if (!Number.isSafeInteger(mutationCapacity) || mutationCapacity < 1 || mutationCapacity > 256) throw new Error("Invalid operator mutation queue limit.");
  if (requestDiagnostics !== undefined && typeof requestDiagnostics !== "function") throw new Error("Invalid request diagnostics provider.");
  const credential = token ? Buffer.from(token) : null;
  let mode = null, revision = 0, reports = [], reportWindow = 0, reportCount = 0, store, lease, persistenceFailure = null;
  let mutations = Promise.resolve(), pendingMutations = 0;
  const valuesValid = (value) => value && Object.keys(value).length === fields.length && Object.keys(value).every((key) => fields.includes(key)) && fields.every((key) => Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 1e12);
  let originFlushTimer, retentionTimer, closePromise, stopping = false;
  const origin = new Proxy({ mediaRequests: 0, mediaResponseBytes: 0, commitmentRequests: 0, commitmentResponseBytes: 0 }, {
    set(target, name, value) {
      target[name] = value;
      if (store && !stopping && !originFlushTimer && !persistenceFailure) {
        originFlushTimer = setTimeout(() => { originFlushTimer = undefined; mutate(() => {}).catch(() => {}); }, 1000);
        originFlushTimer.unref?.();
      }
      return true;
    },
  });
  const readyPromise = (async () => {
    if (!statePath) return;
    store = await openPrivateJsonState(statePath);
    lease = await acquireExclusiveStateLease(`${statePath}.lease.sqlite`);
    const saved = await store.read();
    if (!stopping) retentionTimer = setInterval(() => {
      if (reports.some((entry) => now() - entry.at >= reportTtlMs)) mutate(() => { reports = reports.filter((entry) => now() - entry.at < reportTtlMs); }).catch(() => {});
    }, Math.min(reportTtlMs, 1000));
    retentionTimer.unref?.();
    if (!saved) return;
    if (saved.v !== 1 || ![null, "off", "shadow", "peer-first"].includes(saved.mode) || !Number.isSafeInteger(saved.revision) || saved.revision < 0
      || !Array.isArray(saved.reports) || saved.reports.length > reportCapacity || !saved.origin || Object.keys(origin).some((name) => !Number.isSafeInteger(saved.origin[name]) || saved.origin[name] < 0)
      || saved.reports.some((entry) => !/^[a-f0-9]{32}$/u.test(entry.id) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Number.isSafeInteger(entry.at) || entry.at > now() || !valuesValid(entry.values))
      || new Set(saved.reports.map((entry) => entry.id)).size !== saved.reports.length) throw new Error("Invalid durable operator state.");
    mode = saved.mode; revision = saved.revision; Object.assign(origin, saved.origin);
    reports = saved.reports.filter((entry) => now() - entry.at < reportTtlMs);
  })();
  readyPromise.catch(() => { clearInterval(retentionTimer); lease?.close(); });
  async function persist() { if (store) await store.write({ v: 1, mode, revision, origin, reports }); }
  function mutate(operation, { shutdown = false } = {}) {
    if (stopping && !shutdown) return Promise.reject(fail("Operator controls are closing.", 503));
    if (pendingMutations >= mutationCapacity) return Promise.reject(fail("Operator write queue capacity reached.", 503));
    pendingMutations++;
    const pending = mutations.then(async () => {
      try { await readyPromise; if (persistenceFailure) throw persistenceFailure; const result = operation(); try { await persist(); } catch (error) { persistenceFailure = error; throw error; } return result; }
      finally { pendingMutations--; }
    });
    mutations = pending.catch(() => {}); return pending;
  }
  function policy() { return { v: 1, mode, revision, telemetry: Boolean(telemetry) }; }
  function authenticate(request, base) {
    if (!credential) throw fail("Operator controls are not configured.", 503);
    if (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(request.headers["sec-fetch-site"])) throw fail("Cross-site request refused.", 403);
    if (request.headers.origin && request.headers.origin !== base) throw fail("Cross-site request refused.", 403);
    const value = request.headers.authorization;
    const supplied = Buffer.from(typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "");
    if (supplied.length !== credential.length || !timingSafeEqual(supplied, credential)) throw fail("Unauthorised.", 401);
  }
  async function json(request) {
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw fail("Use application/json.", 415);
    let size = 0, chunks = [];
    for await (const chunk of request) { size += chunk.length; if (size > 2048) throw fail("Request body too large.", 413); chunks.push(chunk); }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("Invalid JSON.", 400); }
    if (!value || Array.isArray(value) || typeof value !== "object") throw fail("Expected a JSON object.", 400);
    return value;
  }
  function summary() {
    const retained = reports.filter((entry) => now() - entry.at < reportTtlMs);
    const totals = Object.fromEntries(fields.map((name) => [name, 0]));
    for (const entry of retained) for (const name of fields) totals[name] += entry.values[name];
    return { enabled: Boolean(telemetry), samples: retained.length, capacity: reportCapacity, ttlMs: reportTtlMs, totals, durable: Boolean(store), pendingMutations, mutationCapacity, scope: "Latest cumulative snapshot per temporary opted-in page report identity within retention; retries are idempotent. Identities are not unique viewers or additive savings." };
  }
  async function handle(request, response, path, base, publisher) {
    if (!["/delivery-policy.json", "/operator/status", "/operator/policy", "/operator/admission", "/reports"].includes(path)) return false;
    try {
      if (stopping) throw fail("Operator controls are closing.", 503);
      await readyPromise;
      const method = ["/operator/policy", "/operator/admission", "/reports"].includes(path) ? "POST" : "GET";
      if (request.method !== method) { response.writeHead(405, { allow: method }).end(); return true; }
      if (path.startsWith("/operator/")) authenticate(request, base);
      let result;
      if (path === "/delivery-policy.json") result = policy();
      if (path === "/operator/status") result = { policy: policy(), origin: { ...origin }, publisher: publisher.getMetrics?.() ?? null, reports: summary(), ...(admission ? { admission: admission.metrics() } : {}), ...(operatorExtraStatus ? { broadcast: operatorExtraStatus() } : {}), ...(requestDiagnostics ? { requestDiagnostics: requestDiagnostics() } : {}) };
      if (path === "/operator/policy") {
        const input = await json(request);
        if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "mode") || ![null, "off", "shadow", "peer-first"].includes(input.mode)) throw fail("Supply only mode: null, off, shadow or peer-first.", 400);
        result = await mutate(() => { mode = input.mode; revision++; return policy(); });
      }
      if (path === "/operator/admission") {
        if (!admission) throw fail("Admission is unavailable.", 503);
        const input = await json(request);
        if (input?.rotate === true && Object.keys(input).length === 1) result = admission.rotate();
        else if (typeof input?.pubkey === "string" && Object.keys(input).length === 1) result = admission.revoke(input.pubkey);
        else throw fail("Supply only pubkey or rotate: true.", 400);
      }
      if (path === "/reports") {
        if (!telemetry) throw fail("Reporting is disabled.", 403);
        if (request.headers.origin !== base || request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") throw fail("Same-origin reporting required.", 403);
        if (now() - reportWindow >= 10000) { reportWindow = now(); reportCount = 0; }
        if (++reportCount > 240) throw fail("Reporting request budget exceeded.", 429);
        const input = await json(request);
        if (input.v !== 1 || Object.keys(input).length !== 4 || !/^[a-f0-9]{32}$/u.test(input.reportId) || !Number.isSafeInteger(input.sequence) || input.sequence < 1 || !valuesValid(input.values)) throw fail("Invalid numeric report envelope.", 400);
        result = await mutate(() => {
          reports = reports.filter((entry) => now() - entry.at < reportTtlMs);
          const previous = reports.find((entry) => entry.id === input.reportId);
          if (previous) {
            if (input.sequence < previous.sequence) return { accepted: true, stale: true };
            if (input.sequence === previous.sequence) {
              if (fields.some((name) => input.values[name] !== previous.values[name])) throw fail("Report sequence conflicts with accepted snapshot.", 409);
              return { accepted: true, duplicate: true };
            }
            if (fields.some((name) => input.values[name] < previous.values[name])) throw fail("Cumulative report counters decreased.", 409);
            Object.assign(previous, { at: now(), sequence: input.sequence, values: input.values });
          } else {
            if (reports.length >= reportCapacity) throw fail("Report retention capacity reached.", 429);
            reports.push({ id: input.reportId, at: now(), sequence: input.sequence, values: input.values });
          }
          return { accepted: true };
        });
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) { response.writeHead(error.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.status ? error.message : "Operator unavailable." })); }
    return true;
  }
  return { handle, policy, summary, origin, ready: () => readyPromise, flush: () => mutate(() => { reports = reports.filter((entry) => now() - entry.at < reportTtlMs); }), close: () => { if (closePromise) return closePromise; stopping = true; clearInterval(retentionTimer); clearTimeout(originFlushTimer); originFlushTimer = undefined; closePromise = (async () => { try { await mutations; await mutate(() => { reports = reports.filter((entry) => now() - entry.at < reportTtlMs); }, { shutdown: true }); } finally { lease?.close(); } })(); return closePromise; } };
}
