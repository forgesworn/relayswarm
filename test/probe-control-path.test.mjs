import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeControlPaths } from "../scripts/probe-control-path.mjs";
import { createRequestDiagnostics } from "../demo/request-diagnostics.mjs";
let opensslAvailable = false;
try { execFileSync("openssl", ["version"], { stdio: "ignore", timeout: 5000 }); opensslAvailable = true; } catch {}
async function listen(t, server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); return new Promise((done) => server.close(done)); });
  return server.address().port;
}
test("matched actual HTTPS/local HTTP probes retain only numeric data and verify TLS", { skip: !opensslAvailable ? "Test-only local TLS certificate requires OpenSSL; no insecure TLS fallback." : false }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-control-probe-tls-")); t.after(() => rm(directory, { recursive: true, force: true }));
  // Test-only key/certificate never printed or committed; normal verification uses this CA.
  const config = join(directory, "openssl.cnf");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n", { mode: 0o600 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"), "-config", config], { stdio: "ignore", timeout: 10000 });
  const cert = await readFile(join(directory, "cert.pem")), key = await readFile(join(directory, "key.pem"));
  const diagnostics = createRequestDiagnostics(); t.after(() => diagnostics.close());
  const handler = (request, response) => { diagnostics.observe(request, response); setTimeout(() => response.end('{"secret":"DO-NOT-RETAIN-BODY"}'), 35); };
  const publicPort = await listen(t, https.createServer({ cert, key }, handler)), localPort = await listen(t, http.createServer(handler));
  const publicOrigin = `https://127.0.0.1:${publicPort}`, loopbackOrigin = `http://127.0.0.1:${localPort}`;
  const rejected = await probeControlPaths({ publicOrigin, loopbackOrigin });
  assert.equal(rejected.rows.filter((r) => r.location === "public").every((r) => r.outcome === "error"), true);
  const calls = [], controller = new AbortController();
  const result = await probeControlPaths({ publicOrigin, loopbackOrigin, signal: controller.signal, requestImpl: (url, options, callback) => {
    calls.push({ route: url.pathname, signal: options.signal, protocol: url.protocol });
    return (url.protocol === "https:" ? https : http).request(url, { ...options, ...(url.protocol === "https:" ? { ca: cert } : {}) }, callback);
  } });
  assert.equal(result.rows.length, 4); assert.equal(calls.every((call) => call.signal === controller.signal), true);
  assert.equal(result.rows.every((r) => r.outcome === "ok" && r.status === 200 && r.appHeadersMs >= 25), true);
  assert.ok(result.rows.every((r) => r.startOffsetMs < 50)); assert.ok(!JSON.stringify(result).includes("DO-NOT-RETAIN")); assert.ok(!JSON.stringify(result).includes("127.0.0.1"));
});
test("actual held responses cancel/expire and oversized bodies stop without storing data", async (t) => {
  let closed = 0;
  const local = await listen(t, http.createServer((request, response) => { response.once("close", () => closed++); if (request.url === "/session.json") response.end("PRIVATE".repeat(100)); else { response.writeHead(200); response.write("{"); } }));
  // Test transport injection maps both validated origins to this real HTTP fixture.
  const requestImpl = (url, options, callback) => http.request(new URL(url.pathname, `http://127.0.0.1:${local}`), options, callback);
  const options = { publicOrigin: "https://public.example", loopbackOrigin: `http://127.0.0.1:${local}`, requestImpl, maxBytes: 16, timeoutMs: 50 };
  const result = await probeControlPaths(options); assert.equal(result.rows.filter((r) => r.route === "session").every((r) => r.outcome === "body-limit" && r.bytes === 17), true);
  assert.equal(result.rows.filter((r) => r.route === "policy").every((r) => r.outcome === "timeout"), true); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  const controller = new AbortController(), pending = probeControlPaths({ ...options, signal: controller.signal, timeoutMs: 2000 });
  const timer = setTimeout(() => controller.abort(), 20); const cancelled = await pending; clearTimeout(timer);
  assert.equal(cancelled.rows.filter((r) => r.route === "policy").every((r) => r.outcome === "cancelled"), true);
  await new Promise((done) => setTimeout(done, 20)); assert.equal(closed, 8);
});
test("probe targets/numeric limits refuse credentials, query, nonloopback and insecure public URLs", async () => {
  const base = { publicOrigin: "https://public.example", loopbackOrigin: "http://127.0.0.1" };
  for (const options of [{ publicOrigin: "http://public.example" }, { publicOrigin: "https://secret:token@public.example" }, { publicOrigin: "https://public.example?ticket=secret" }, { loopbackOrigin: "http://not-loopback.example" }, { loopbackOrigin: "http://localhost" }, { loopbackOrigin: "http://127.0.0.1/path" }, { maxBytes: 1048577 }, { timeoutMs: 10001 }]) await assert.rejects(probeControlPaths({ ...base, ...options }));
  let calls = 0; const signal = AbortSignal.abort();
  const result = await probeControlPaths({ ...base, signal, requestImpl: () => { calls++; throw Error("must not dial"); } });
  assert.equal(calls, 0); assert.equal(result.rows.every((r) => r.outcome === "cancelled"), true);
});
