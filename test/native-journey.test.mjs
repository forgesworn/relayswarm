import assert from "node:assert/strict";
import { Duplex, Readable } from "node:stream";
import test from "node:test";
import { WebSocket } from "ws";
import { runNativeJourney } from "../src/native-journey.mjs";
import { NativeDhtTransport } from "../src/native-dht-transport.mjs";
import { decodeFrames, encodeFrame, FRAME, requestObject, sha256Hex } from "../src/object-transfer.mjs";
import { KIND_SIGNAL } from "../src/relay-session.mjs";
import { startLocalDht } from "./support/local-dht.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";

test("Nostr authorizes a STUN-free native transfer whose bytes are independently verified", { timeout: 20_000 }, async () => {
  const relay = await startLocalRelay();
  const dht = await startLocalDht();
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
