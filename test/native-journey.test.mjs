import assert from "node:assert/strict";
import { Duplex, Readable } from "node:stream";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { runNativeJourney } from "../src/native-journey.mjs";
import { NativeDhtTransport } from "../src/native-dht-transport.mjs";
import { decodeFrames, encodeFrame, FRAME, requestObject, serveAuthorizedObject, sha256Hex } from "../src/object-transfer.mjs";
import { KIND_SIGNAL } from "../src/relay-session.mjs";
import { startLocalDht } from "./support/local-dht.mjs";
import { startNativeTestInfrastructure } from "./support/native-fixture.mjs";

test("native connect waits for acknowledged live readiness within one deadline", { timeout: 5000 }, async () => {
  const key = "a".repeat(64);
  for (const mode of ["acknowledged", "refused", "closed", "stalled"]) {
    const transport = new NativeDhtTransport({ bootstrap: [], connectionTimeoutMs: 80 });
    let acknowledge, settled = false;
    const socket = new EventEmitter();
    socket.remotePublicKey = Buffer.from(key, "hex"); socket.destroyed = false; socket.destroying = false;
    socket.flush = () => new Promise((done) => { acknowledge = done; });
    socket.destroy = () => { socket.destroyed = true; };
    transport.dht.connect = () => { queueMicrotask(() => socket.emit("open")); return socket; };
    try {
      const pending = transport.connect(key);
      pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((done) => setImmediate(done));
      assert.equal(settled, false, "Noise open alone must not permit an object request");
      assert.equal(typeof acknowledge, "function");
      if (mode === "acknowledged") { acknowledge(true); assert.equal(await pending, socket); }
      else {
        if (mode === "refused") acknowledge(false);
        if (mode === "closed") { socket.destroyed = true; acknowledge(true); }
        await assert.rejects(pending, /readiness|timed out/u);
        assert.equal(socket.destroyed, true);
      }
    } finally { socket.destroy(); await transport.close(); }
  }
});

test("Nostr authorizes a STUN-free native transfer whose bytes are independently verified", { timeout: 20_000 }, async () => {
  const { relay, dht } = await startNativeTestInfrastructure();
  try {
    const bytes = Buffer.alloc(1024 * 1024, 0x5a);
    const result = await runNativeJourney({
      relayUrls: [relay.url],
      bootstrap: dht.bootstrap,
      WebSocketImpl: WebSocket,
      bytes,
      timeoutMs: 8_000,
    });

    assert.equal(result.ok, true);
    assert.equal(result.objectBytes, bytes.length);
    assert.equal(result.sha256Verified, true);
    assert.equal(result.transport, "hyperdht-v1");
    assert.equal(result.stunServers, 0);
    assert.equal(result.turnServers, 0);

    const signals = relay.events.filter(({ kind }) => kind === KIND_SIGNAL);
    assert.equal(signals.length, 2);
    for (const signal of signals) {
      assert.throws(() => JSON.parse(signal.content));
      assert.equal(signal.content.includes("hyperdht-v1"), false);
      assert.equal(signal.content.includes(result.sha256), false);
    }
  } finally {
    await Promise.allSettled([relay.close(), dht.close()]);
  }
});

test("the native listener rejects a Noise key that Nostr did not authorize", { timeout: 15_000 }, async () => {
  const dht = await startLocalDht();
  const server = new NativeDhtTransport({ bootstrap: dht.bootstrap, connectionTimeoutMs: 4_000 });
  const stranger = new NativeDhtTransport({ bootstrap: dht.bootstrap, connectionTimeoutMs: 4_000 });
  try {
    await Promise.all([server.ready(), stranger.ready()]);
    await server.listen(async () => {
      assert.fail("an unauthorized native connection reached the object handler");
    });
    await assert.rejects(async () => {
      const socket = await stranger.connect(server.publicKey);
      await new Promise((resolve, reject) => {
        socket.once("data", resolve);
        socket.once("close", () => reject(new Error("unauthorized connection closed")));
        socket.once("error", reject);
        socket.write("should-not-pass");
      });
    });
  } finally {
    await Promise.allSettled([server.close(), stranger.close(), dht.close()]);
  }
});

test("the frame decoder rejects an oversized declared payload before buffering it", async () => {
  const header = Buffer.alloc(8);
  header.write("RS", 0, "ascii");
  header[2] = 1;
  header[3] = FRAME.CHUNK;
  header.writeUInt32BE(64 * 1024 + 1, 4);
  await assert.rejects(async () => {
    for await (const _frame of decodeFrames(Readable.from([header]))) {
      // No valid frame should be yielded.
    }
  }, /too large/iu);
});

test("the receiver rejects bytes that do not match the independently expected digest", async () => {
  const expectedBytes = Buffer.from("the object the application authorized");
  const tamperedBytes = Buffer.from(expectedBytes);
  tamperedBytes[0] ^= 0xff;
  const expected = {
    requestId: "digest-test-request",
    sha256: sha256Hex(expectedBytes),
    size: expectedBytes.length,
  };
  let answered = false;
  const peer = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      if (!answered) {
        answered = true;
        this.push(encodeFrame(FRAME.META, JSON.stringify({ sha256: expected.sha256, size: expected.size })));
        this.push(encodeFrame(FRAME.CHUNK, tamperedBytes));
        this.push(encodeFrame(FRAME.EOF));
      }
      callback();
    },
  });
  await assert.rejects(requestObject(peer, expected), /wrong SHA-256 digest/iu);
  peer.destroy();
});

test("native authorisations are capped, expired entries are reclaimed and closed nodes reject new grants", async () => {
  const transport = new NativeDhtTransport({ bootstrap: [], maxAuthorizations: 1 });
  const grant = { transportPublicKey: "a".repeat(64), nostrPubkey: "b".repeat(64), requestId: "bounded-request", sha256: "c".repeat(64), size: 1 };
  try {
    transport.authorize(grant);
    assert.throws(() => transport.authorize({ ...grant, transportPublicKey: "d".repeat(64) }), /capacity/);
    transport.authorizations.get(grant.transportPublicKey).expiresAt = 0;
    transport.authorize({ ...grant, transportPublicKey: "d".repeat(64) });
    assert.equal(transport.authorizations.size, 1);
    assert.throws(() => transport.authorize({ ...grant, size: 256 * 1024 * 1024 + 1 }), /size/);
  } finally { await transport.close(); }
  assert.throws(() => transport.authorize(grant), /closed/);
});

test("an authorised native peer that never requests bytes is closed at the transfer deadline", { timeout: 15_000 }, async () => {
  const dht = await startLocalDht();
  const server = new NativeDhtTransport({ bootstrap: dht.bootstrap, transferTimeoutMs: 500 });
  const client = new NativeDhtTransport({ bootstrap: dht.bootstrap });
  const bytes = Buffer.from("object");
  try {
    await Promise.all([server.ready(), client.ready()]);
    await server.listen((socket, grant) => serveAuthorizedObject(socket, grant, () => bytes));
    server.authorize({ transportPublicKey: client.publicKey, nostrPubkey: "a".repeat(64), requestId: "slow-peer-request", sha256: sha256Hex(bytes), size: bytes.length });
    const socket = await client.connect(server.publicKey);
    await new Promise((resolve) => socket.once("close", resolve));
    assert.equal(server.connections.size, 0);
  } finally { await Promise.allSettled([server.close(), client.close(), dht.close()]); }
});
