import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import DHT from "hyperdht";
import { WebSocket } from "ws";
import { generateSecretKey, finalizeEvent } from "nostr-tools/pure";
import { createNativeObjectSeeder, fetchNativeObject, validateNativeDescriptor } from "../src/native-client.mjs";
import { sha256Hex } from "../src/object-transfer.mjs";
import { startLocalDht } from "./support/local-dht.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";
import { NativeDhtTransport } from "../src/native-dht-transport.mjs";
import { RelaySwarmSession } from "../src/relay-session.mjs";

async function fixture(handler, { relayOptions, bytes = Buffer.from("independently trusted native object") } = {}) {
  const relay = await startLocalRelay(relayOptions), dht = await startLocalDht();
  let requests = 0;
  const server = createServer((request, response) => { requests++; handler(request, response); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const descriptor = { v: 1, swarmId: "native-client-test-swarm", sha256: sha256Hex(bytes), size: bytes.length,
    trustedSeeders: ["a".repeat(64)], relayUrls: [relay.url], originUrl: `http://127.0.0.1:${server.address().port}/object` };
  return { bytes, descriptor, relay, dht, requests: () => requests,
    options: { bootstrap: dht.bootstrap, allowLoopback: true, peerTimeoutMs: 200, timeoutMs: 3000 },
    async close() { server.closeAllConnections(); await Promise.all([relay.close(), dht.close(), new Promise((resolve) => server.close(resolve))]); } };
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Expected native fixture observation did not arrive");
    await pause(10);
  }
}

test("native CLI receives verified bytes through live discovery when the relay replays no ephemeral events", { timeout: 20000 }, async () => {
  const bytes = Buffer.from(Array.from({ length: 131097 }, (_, i) => i % 251));
  const context = await fixture((_request, response) => response.end("unexpected fallback"), { relayOptions: { replayEphemeral: false }, bytes });
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-native-live-discovery-"));
  let seeder;
  try {
    seeder = await createNativeObjectSeeder({ bytes, swarmId: context.descriptor.swarmId,
      relayUrls: [context.relay.url], bootstrap: context.dht.bootstrap, allowLoopback: true });
    await until(() => context.relay.events.some((event) => event.kind === 24170));
    const descriptor = join(directory, "object.json"), output = join(directory, "object.bin");
    await writeFile(descriptor, JSON.stringify(seeder.descriptor));
    const result = await promisify(execFile)(process.execPath, ["scripts/native-client.mjs", "--descriptor", descriptor, "--output", output,
      ...context.dht.bootstrap.flatMap((address) => ["--bootstrap", address]), "--allow-loopback", "--peer-timeout", "5000"], { timeout: 15000 });
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.source, "hyperdht-v1"); assert.equal(receipt.sha256Verified, true);
    assert.equal(receipt.objectBytes, bytes.length); assert.deepEqual(await readFile(output), bytes);
    assert.equal(context.requests(), 0);
    assert.equal(context.relay.replayedKinds.some((kind) => kind >= 20000 && kind < 30000), false);
    const presence = context.relay.events.filter((event) => event.kind === 24170).map((event) => JSON.parse(event.content));
    const leecher = presence.find((value) => value.role === "leecher");
    assert.ok(leecher); assert.equal(leecher.open, false); assert.deepEqual(leecher.have, []);
    assert.equal(leecher.transports.length, 1); assert.equal(leecher.transports[0].type, "hyperdht-v1");
    assert.ok(presence.filter((value) => value.role === "seeder").length >= 2, "A live response, rather than stored presence, must reach the receiver");
  } finally { await seeder?.close(); await context.close(); await rm(directory, { recursive: true, force: true }); }
});

test("signed native presence floods coalesce globally, never grant a dial and stop replying after close", { timeout: 15000 }, async (t) => {
  const context = await fixture((_request, response) => response.end("unused"), { relayOptions: { replayEphemeral: false } });
  let seeder, socket;
  const announcements = [], originalAnnounce = RelaySwarmSession.prototype.announcePresence;
  t.mock.method(RelaySwarmSession.prototype, "announcePresence", function (value) {
    const result = originalAnnounce.call(this, value);
    if (value.role === "seeder" && this.swarmId === context.descriptor.swarmId) announcements.push(performance.now());
    return result;
  });
  const originalAuthorize = NativeDhtTransport.prototype.authorize;
  const authorizations = t.mock.method(NativeDhtTransport.prototype, "authorize", function (...args) { return originalAuthorize.apply(this, args); });
  const transportKey = Buffer.from(DHT.keyPair().publicKey).toString("hex");
  const publish = (role = "leecher", type = "hyperdht-v1", swarm = context.descriptor.swarmId, valid = true) => {
    const event = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", swarm]],
      content: JSON.stringify({ v: 3, role, transports: [{ type, publicKey: transportKey }], have: [], open: false }) }, generateSecretKey());
    if (!valid) event.sig = "0".repeat(128);
    socket.send(JSON.stringify(["EVENT", event]));
  };
  try {
    seeder = await createNativeObjectSeeder({ bytes: context.bytes, swarmId: context.descriptor.swarmId,
      relayUrls: [context.relay.url], bootstrap: context.dht.bootstrap, allowLoopback: true });
    socket = new WebSocket(context.relay.url); await once(socket, "open");
    for (let i = 0; i < 32; i++) publish();
    await until(() => announcements.length === 2);
    await pause(100);
    assert.equal(announcements.length, 2, "The signed burst must produce one coalesced reply");
    assert.ok(announcements[1] - announcements[0] >= 1000, "Initial publication and replies share the global publication budget");
    assert.equal(authorizations.mock.callCount(), 0, "Presence cannot create a transport grant");
    for (let i = 0; i < 32; i++) publish();
    await until(() => context.relay.events.filter((event) => event.kind === 24170 && JSON.parse(event.content).role === "leecher").length >= 64);
    await pause(50);
    await seeder.close(); seeder = null;
    await pause(1100);
    assert.equal(announcements.length, 2, "Closing cancels the pending coalesced response");
    publish(); await pause(100);
    assert.equal(announcements.length, 2, "Closed publishers cannot resume replying");
    assert.equal(authorizations.mock.callCount(), 0);
  } finally { socket?.terminate(); await seeder?.close(); await context.close(); }
});

test("native publishers ignore non-native, other-role, other-swarm and unauthentic presence", { timeout: 10000 }, async () => {
  const context = await fixture((_request, response) => response.end("unused"), { relayOptions: { replayEphemeral: false } });
  let seeder, socket;
  try {
    seeder = await createNativeObjectSeeder({ bytes: context.bytes, swarmId: context.descriptor.swarmId,
      relayUrls: [context.relay.url], bootstrap: context.dht.bootstrap, allowLoopback: true });
    await until(() => context.relay.events.some((event) => event.kind === 24170));
    socket = new WebSocket(context.relay.url); await once(socket, "open");
    for (const [role, type, swarm, valid] of [["viewer", "hyperdht-v1", context.descriptor.swarmId, true],
      ["leecher", "webrtc", context.descriptor.swarmId, true], ["leecher", "hyperdht-v1", "another-native-swarm", true],
      ["leecher", "hyperdht-v1", context.descriptor.swarmId, false]]) {
      const event = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", swarm]],
        content: JSON.stringify({ v: 3, role, transports: [{ type, publicKey: "c".repeat(64) }], have: [] }) }, generateSecretKey());
      if (!valid) event.sig = "0".repeat(128);
      socket.send(JSON.stringify(["EVENT", event]));
    }
    await pause(1300);
    assert.equal(context.relay.events.filter((event) => event.kind === 24170 && event.pubkey === seeder.descriptor.trustedSeeders[0]).length, 1);
    assert.equal(context.relay.events.some((event) => event.kind === 24171), false);
  } finally { socket?.terminate(); await seeder?.close(); await context.close(); }
});

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
