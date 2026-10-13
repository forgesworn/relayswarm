import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { createNativeObjectSeeder, fetchNativeObject, validateNativeDescriptor } from "../src/native-client.mjs";
import { sha256Hex } from "../src/object-transfer.mjs";
import { startLocalDht } from "./support/local-dht.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";

async function fixture(handler) {
  const relay = await startLocalRelay(), dht = await startLocalDht();
  let requests = 0;
  const server = createServer((request, response) => { requests++; handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bytes = Buffer.from("independently trusted native object");
  const descriptor = { v: 1, swarmId: "native-client-test-swarm", sha256: sha256Hex(bytes), size: bytes.length,
    trustedSeeders: ["a".repeat(64)], relayUrls: [relay.url], originUrl: `http://127.0.0.1:${server.address().port}/object` };
  return { bytes, descriptor, relay, dht, requests: () => requests,
    options: { bootstrap: dht.bootstrap, allowLoopback: true, peerTimeoutMs: 200, timeoutMs: 3000 },
    async close() { server.closeAllConnections(); await Promise.all([relay.close(), dht.close(), new Promise((resolve) => server.close(resolve))]); } };
}

test("native installed client discovers cached presence, transfers in a separate process and never overwrites output", { timeout: 20000 }, async () => {
  const context = await fixture((_request, response) => response.end("unexpected fallback"));
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-native-cli-"));
  let seeder;
  try {
    const secretKey = generateSecretKey();
    seeder = await createNativeObjectSeeder({ bytes: context.bytes, swarmId: context.descriptor.swarmId,
      secretKey, relayUrls: [context.relay.url], bootstrap: context.dht.bootstrap, allowLoopback: true });
    const historyDeadline = Date.now() + 3000;
    while (!context.relay.events.some((event) => event.kind === 24170) && Date.now() < historyDeadline) await new Promise((done) => setTimeout(done, 10));
    const presenceIndex = context.relay.events.findIndex((event) => event.kind === 24170);
    assert.ok(presenceIndex >= 0);
    context.relay.events[presenceIndex] = finalizeEvent({ ...context.relay.events[presenceIndex],
      created_at: Math.floor(Date.now() / 1000) - 10 }, secretKey);
    const descriptorPath = join(directory, "object.json"), output = join(directory, "object.bin");
    await writeFile(descriptorPath, JSON.stringify(seeder.descriptor));
    const args = ["scripts/native-client.mjs", "--descriptor", descriptorPath, "--output", output,
      ...context.dht.bootstrap.flatMap((address) => ["--bootstrap", address]), "--allow-loopback", "--peer-timeout", "5000"];
    const result = await promisify(execFile)(process.execPath, args, { timeout: 15000 });
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.source, "hyperdht-v1"); assert.equal(receipt.sha256Verified, true);
    assert.deepEqual(await readFile(output), context.bytes); assert.equal(context.requests(), 0);
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(promisify(execFile)(process.execPath, args, { timeout: 15000 }));
    assert.deepEqual(await readFile(output), context.bytes);
  } finally { await seeder?.close(); await context.close(); await rm(directory, { recursive: true, force: true }); }
});

test("native peer absence falls back automatically to size and digest verified HTTP", { timeout: 10000 }, async () => {
  const context = await fixture((_request, response) => response.end("independently trusted native object"));
  try {
    const result = await fetchNativeObject(context.descriptor, context.options);
    assert.deepEqual(result.bytes, context.bytes); assert.equal(result.receipt.fallback, true);
    assert.equal(result.receipt.sha256Verified, true); assert.equal(context.requests(), 1);
  } finally { await context.close(); }
});

test("fallback rejects substituted bytes, excess bytes and redirects without returning media", { timeout: 15000 }, async () => {
  const cases = [
    (_request, response) => response.end("x".repeat(34)),
    (_request, response) => { response.write("independently trusted native object"); response.end("extra"); },
    (_request, response) => response.writeHead(302, { location: "/different-trust-boundary" }).end(),
  ];
  for (const handler of cases) {
    const context = await fixture(handler);
    try { await assert.rejects(fetchNativeObject(context.descriptor, context.options)); assert.equal(context.requests(), 1); }
    finally { await context.close(); }
  }
});

test("cancelling a native attempt never starts the configured origin fallback", { timeout: 10000 }, async () => {
  const context = await fixture((_request, response) => response.end("unexpected"));
  try {
    const controller = new AbortController();
    const request = fetchNativeObject(context.descriptor, { ...context.options, peerTimeoutMs: 2000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("owner cancelled")), 50);
    await assert.rejects(request, /owner cancelled/u); assert.equal(context.requests(), 0);
  } finally { await context.close(); }
});

test("uncooperative HTTP headers, reader and cancellation cannot defeat the overall deadline", { timeout: 10000 }, async () => {
  const context = await fixture((_request, response) => response.end("unused"));
  try {
    for (const fetchImpl of [
      () => new Promise(() => {}),
      async () => ({ ok: true, headers: new Headers(), body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: () => new Promise(() => {}), releaseLock() {} }), cancel: () => new Promise(() => {}) } }),
    ]) {
      const started = performance.now();
      await assert.rejects(fetchNativeObject(context.descriptor, { ...context.options, peerTimeoutMs: 50, timeoutMs: 250, fetchImpl }));
      assert.ok(performance.now() - started < 1500, "HTTP adapter cleanup must not hang cancellation");
    }
  } finally { await context.close(); }
});

test("a synchronous reader cannot return verified bytes after the total deadline", { timeout: 5000 }, async () => {
  const context = await fixture((_request, response) => response.end("unused"));
  try {
    const wait = new Int32Array(new SharedArrayBuffer(4));
    const fetchImpl = async () => {
      let delivered = false;
      return { ok: true, headers: new Headers(), body: { getReader: () => ({
        async read() {
          if (!delivered) { delivered = true; return { done: false, value: context.bytes }; }
          Atomics.wait(wait, 0, 0, 250);
          return { done: true };
        },
        async cancel() {}, releaseLock() {},
      }) } };
    };
    await assert.rejects(fetchNativeObject(context.descriptor, { ...context.options,
      peerTimeoutMs: 50, timeoutMs: 200, fetchImpl }), { name: "TimeoutError" });
    assert.equal(context.requests(), 0);
  } finally { await context.close(); }
});

test("native endpoint and expected-size policies are validated before I/O", () => {
  const descriptor = { v: 1, swarmId: "native-client-policy", sha256: "a".repeat(64), size: 4,
    relayUrls: ["wss://relay.example"], trustedSeeders: ["b".repeat(64)], originUrl: "https://origin.example/segment" };
  assert.equal(validateNativeDescriptor(descriptor).size, 4);
  for (const originUrl of ["http://origin.example/file", "https://user:secret@origin.example/file", "file:///etc/passwd", "https://origin.example/file#fragment"]) {
    assert.throws(() => validateNativeDescriptor({ ...descriptor, originUrl }));
  }
  assert.throws(() => validateNativeDescriptor({ ...descriptor, size: 5 }, { maxObjectBytes: 4 }));
  assert.throws(() => validateNativeDescriptor({ ...descriptor, trustedSeeders: [] }));
});
