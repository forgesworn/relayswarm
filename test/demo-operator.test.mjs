import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtemp, writeFile, chmod, symlink, rm, realpath, open, appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOperatorControls, readOperatorTokenFile } from "../demo/operator.mjs";

test("numeric report collector expires samples and enforces bounded request budget", async () => {
  let time = 10000;
  const controls = createOperatorControls({ telemetry: true, reportCapacity: 2, reportTtlMs: 1000, now: () => time });
  const value = { durationMs: 1, peerBytes: 2, uploadedBytes: 3, originMediaRequests: 4, originMediaBytes: 5, stalls: 6, stallMs: 7, fatalErrors: 8 };
  let sequence = 0;
  const send = async () => {
    const request = Readable.from([Buffer.from(JSON.stringify({ v: 1, reportId: "a".repeat(32), sequence: ++sequence, values: value }))]);
    Object.assign(request, { method: "POST", headers: { origin: "https://demo.example", "content-type": "application/json" } });
    let code;
    const response = { writeHead(status) { code = status; return this; }, end() {} };
    await controls.handle(request, response, "/reports", "https://demo.example", {});
    return code;
  };
  for (let i = 0; i < 240; i++) assert.equal(await send(), 200);
  assert.equal(controls.summary().samples, 1);
  assert.equal(await send(), 429);
  time += 1000;
  assert.equal(controls.summary().samples, 0);
  time += 9000;
  assert.equal(await send(), 200);
});

test("operator configuration rejects weak credentials and unbounded collector settings", () => {
  assert.throws(() => createOperatorControls({ token: "short" }), /32-256/u);
  assert.throws(() => createOperatorControls({ reportCapacity: 4097 }), /retention/u);
  assert.throws(() => createOperatorControls({ reportTtlMs: 3600001 }), /retention/u);
});


test("operator token files reject public permissions and symlinks", { skip: process.platform === "win32" ? "Private operator token files require POSIX permissions; Windows ACL support is not implemented." : false }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-token-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "token"), token = "private-operator-token-with-32-characters";
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  assert.equal(await readOperatorTokenFile(path), token);
  await chmod(path, 0o644); await assert.rejects(readOperatorTokenFile(path), /0600/u);
  await chmod(path, 0o600); await symlink(path, join(directory, "link")); await assert.rejects(readOperatorTokenFile(join(directory, "link")));
  await chmod(directory, 0o777); await assert.rejects(readOperatorTokenFile(path), /owner-controlled/u);
});


test("operator token loader rejects oversized files and FIFO promptly", { timeout: 5000, skip: process.platform === "win32" ? "FIFO and private file permission checks require POSIX." : false }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-token-bounds-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "token");
  await writeFile(path, "a".repeat(513), { mode: 0o600 });
  await assert.rejects(readOperatorTokenFile(path), /0600 regular file/u);
  const fifo = join(directory, "fifo");
  await promisify(execFile)("mkfifo", ["-m", "600", fifo]);
  await assert.rejects(Promise.race([
    readOperatorTokenFile(fifo),
    new Promise((_resolve, reject) => { const timeout = setTimeout(() => reject(new Error("FIFO open blocked")), 1000); timeout.unref(); }),
  ]), /0600 regular file/u);
});

test("operator token loader rejects growth, replacement and permission changes after its bounded read", { skip: process.platform === "win32" ? "Private operator token files require POSIX permissions." : false }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-token-mutation-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "token"), replacement = join(directory, "replacement");
  await writeFile(path, "a".repeat(40), { mode: 0o600 });
  const probe = await open(path, "r"), prototype = Object.getPrototypeOf(probe), originalRead = prototype.read;
  await probe.close();
  for (const mutate of [
    () => appendFile(path, "b".repeat(513)),
    async () => { await writeFile(replacement, "b".repeat(40), { mode: 0o600 }); await rename(replacement, path); },
    () => chmod(path, 0o644),
  ]) {
    await chmod(path, 0o600); await writeFile(path, "a".repeat(40));
    const mocked = t.mock.method(prototype, "read", async function (...args) {
      assert.equal(args[0].length, 513);
      const result = await originalRead.apply(this, args);
      await mutate();
      return result;
    });
    try { await assert.rejects(readOperatorTokenFile(path), /changed while reading/u); }
    finally { mocked.mock.restore(); }
  }
});

test("durable reports reopen idempotently, bound identities and reject counter rewind", { skip: process.platform === "win32" }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-ops-")));
  t.after(async () => { await controls?.close(); await rm(directory, { recursive: true, force: true }); });
  const options = { telemetry: true, statePath: join(directory, "operator.json"), reportCapacity: 2, token: "durable-test-operator-token-32-characters" };
  let controls = createOperatorControls(options); await controls.ready();
  const values = { durationMs: 10, peerBytes: 20, uploadedBytes: 30, originMediaRequests: 4, originMediaBytes: 50, stalls: 6, stallMs: 70, fatalErrors: 8 };
  async function send(reportId, sequence, next = values) {
    const request = Readable.from([Buffer.from(JSON.stringify({ v: 1, reportId, sequence, values: next }))]);
    Object.assign(request, { method: "POST", headers: { origin: "https://demo.example", "content-type": "application/json" } });
    let status; const response = { writeHead(code) { status = code; return this; }, end() {} };
    await controls.handle(request, response, "/reports", "https://demo.example", {}); return status;
  }
  assert.equal(await send("a".repeat(32), 1), 200);
  assert.equal(await send("a".repeat(32), 1), 200);
  assert.equal(controls.summary().totals.peerBytes, 20);
  controls.origin.mediaRequests = 123;
  const policyRequest = Readable.from([Buffer.from(JSON.stringify({ mode: "off" }))]);
  Object.assign(policyRequest, { method: "POST", headers: { origin: "https://demo.example", "content-type": "application/json", authorization: `Bearer ${options.token}` } });
  await controls.handle(policyRequest, { writeHead(code) { assert.equal(code, 200); return this; }, end() {} }, "/operator/policy", "https://demo.example", {});
  await Promise.all([controls.close(), controls.close()]); controls = createOperatorControls(options); await controls.ready();
  assert.equal(controls.policy().mode, "off"); assert.equal(controls.origin.mediaRequests, 123);

  assert.equal(await send("a".repeat(32), 1), 200);
  assert.equal(controls.summary().totals.peerBytes, 20);
  assert.equal(await send("a".repeat(32), 2, { ...values, peerBytes: 15 }), 409);
  assert.equal(await send("a".repeat(32), 2, { ...values, peerBytes: 25 }), 200);
  assert.equal(await send("a".repeat(32), 1), 200);
  assert.equal(controls.summary().totals.peerBytes, 25);
  assert.equal(await send("b".repeat(32), 1), 200);
  assert.equal(await send("c".repeat(32), 1), 429);
  const duplicateOwner = createOperatorControls(options); await assert.rejects(duplicateOwner.ready(), /locked/u);
});

test("expired durable reports are erased during idle retention and malformed state is never overwritten", { skip: !["darwin", "linux"].includes(process.platform), timeout: 5000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-retention-"))), statePath = join(directory, "ops.json");
  let controls;
  t.after(async () => { await controls?.close().catch(() => {}); await rm(directory, { recursive: true, force: true }); });
  let time = 10000; controls = createOperatorControls({ statePath, telemetry: true, reportTtlMs: 1000, now: () => time }); await controls.ready();
  const values = { durationMs: 1, peerBytes: 2, uploadedBytes: 3, originMediaRequests: 4, originMediaBytes: 5, stalls: 6, stallMs: 7, fatalErrors: 8 };
  const request = Readable.from([Buffer.from(JSON.stringify({ v: 1, reportId: "a".repeat(32), sequence: 1, values }))]);
  Object.assign(request, { method: "POST", headers: { origin: "https://demo.example", "content-type": "application/json" } });
  await controls.handle(request, { writeHead(code) { assert.equal(code, 200); return this; }, end() {} }, "/reports", "https://demo.example", {});
  time += 1001;
  const { readFile } = await import("node:fs/promises");
  const deadline = Date.now() + 3000;
  while (JSON.parse(await readFile(statePath, "utf8")).reports.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).reports, []);
  await controls.close(); await writeFile(statePath, '{"invalid":true}', { mode: 0o600 });
  controls = createOperatorControls({ statePath }); await assert.rejects(controls.ready(), /Invalid durable/u);
  assert.equal(await readFile(statePath, "utf8"), '{"invalid":true}');
});

test("concurrent durable report intake bounds its mutation queue and close drains accepted writes", { skip: !["darwin", "linux"].includes(process.platform), timeout: 10000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-ops-queue-"))), statePath = join(directory, "operator.json");
  const controls = createOperatorControls({ statePath, telemetry: true, mutationCapacity: 16 });
  t.after(async () => { await controls.close(); await rm(directory, { recursive: true, force: true }); });
  await controls.ready();
  const values = { durationMs: 1, peerBytes: 2, uploadedBytes: 3, originMediaRequests: 4, originMediaBytes: 5, stalls: 6, stallMs: 7, fatalErrors: 8 };
  const responses = await Promise.all(Array.from({ length: 64 }, async (_value, index) => {
    const request = Readable.from([Buffer.from(JSON.stringify({ v: 1, reportId: index.toString(16).padStart(32, "0"), sequence: 1, values }))]);
    Object.assign(request, { method: "POST", headers: { origin: "https://demo.example", "content-type": "application/json" } });
    let code;
    await controls.handle(request, { writeHead(status) { code = status; return this; }, end() {} }, "/reports", "https://demo.example", {});
    return code;
  }));
  assert.ok(responses.includes(503)); assert.ok(responses.every((status) => status === 200 || status === 503));
  await controls.close();
  const { readFile } = await import("node:fs/promises");
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).reports.length, responses.filter((status) => status === 200).length);
  assert.equal(controls.summary().pendingMutations, 0);
});
