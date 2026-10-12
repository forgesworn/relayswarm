import { open, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, dirname } from "node:path";
import { timingSafeEqual } from "node:crypto";

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
export function createOperatorControls({ token, telemetry = false, reportCapacity = 256, reportTtlMs = 300000, now = Date.now, operatorExtraStatus } = {}) {
  if (token !== undefined && (typeof token !== "string" || token.length < 32 || token.length > 256 || /\s/u.test(token))) throw new Error("Operator token must contain 32-256 non-whitespace characters.");
  if (!Number.isSafeInteger(reportCapacity) || reportCapacity < 1 || reportCapacity > 4096 || !Number.isSafeInteger(reportTtlMs) || reportTtlMs < 1000 || reportTtlMs > 3600000) throw new Error("Invalid report retention limits.");
  const credential = token ? Buffer.from(token) : null;
  let mode = null, revision = 0, reports = [], reportWindow = 0, reportCount = 0;
  const origin = { mediaRequests: 0, mediaResponseBytes: 0, commitmentRequests: 0, commitmentResponseBytes: 0 };
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
    reports = reports.filter((entry) => now() - entry.at < reportTtlMs);
    const totals = Object.fromEntries(fields.map((name) => [name, 0]));
    for (const entry of reports) for (const name of fields) totals[name] += entry.values[name];
    return { enabled: Boolean(telemetry), samples: reports.length, capacity: reportCapacity, ttlMs: reportTtlMs, totals, scope: "Opted-in cumulative page snapshots; repeated snapshots are not unique viewers or additive savings." };
  }
  async function handle(request, response, path, base, publisher) {
    if (!["/delivery-policy.json", "/operator/status", "/operator/policy", "/reports"].includes(path)) return false;
    try {
      const method = path === "/operator/policy" || path === "/reports" ? "POST" : "GET";
      if (request.method !== method) { response.writeHead(405, { allow: method }).end(); return true; }
      if (path.startsWith("/operator/")) authenticate(request, base);
      let result;
      if (path === "/delivery-policy.json") result = policy();
      if (path === "/operator/status") result = { policy: policy(), origin: { ...origin }, publisher: publisher.getMetrics?.() ?? null, reports: summary(), ...(operatorExtraStatus ? { broadcast: operatorExtraStatus() } : {}) };
      if (path === "/operator/policy") {
        const input = await json(request);
        if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "mode") || ![null, "off", "shadow", "peer-first"].includes(input.mode)) throw fail("Supply only mode: null, off, shadow or peer-first.", 400);
        mode = input.mode; revision++; result = policy();
      }
      if (path === "/reports") {
        if (!telemetry) throw fail("Reporting is disabled.", 403);
        if (request.headers.origin !== base || request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") throw fail("Same-origin reporting required.", 403);
        if (now() - reportWindow >= 10000) { reportWindow = now(); reportCount = 0; }
        if (++reportCount > 240) throw fail("Reporting request budget exceeded.", 429);
        const input = await json(request);
        if (Object.keys(input).length !== fields.length || Object.keys(input).some((key) => !fields.includes(key)) || fields.some((key) => !Number.isSafeInteger(input[key]) || input[key] < 0 || input[key] > 1e12)) throw fail("Invalid numeric report.", 400);
        reports = reports.filter((entry) => now() - entry.at < reportTtlMs);
        reports.push({ at: now(), values: input }); if (reports.length > reportCapacity) reports.shift(); result = { accepted: true };
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    } catch (error) { response.writeHead(error.status ?? 500, { "content-type": "application/json" }).end(JSON.stringify({ error: error.status ? error.message : "Operator unavailable." })); }
    return true;
  }
  return { handle, policy, summary, origin };
}
