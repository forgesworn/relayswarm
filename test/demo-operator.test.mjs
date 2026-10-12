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
  const send = async () => {
    const request = Readable.from([Buffer.from(JSON.stringify(value))]);
    Object.assign(request, { method: "POST", headers: { origin: "https://demo.example", "content-type": "application/json" } });
    let code;
    const response = { writeHead(status) { code = status; return this; }, end() {} };
    await controls.handle(request, response, "/reports", "https://demo.example", {});
    return code;
  };
  for (let i = 0; i < 240; i++) assert.equal(await send(), 200);
  assert.equal(controls.summary().samples, 2);
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
