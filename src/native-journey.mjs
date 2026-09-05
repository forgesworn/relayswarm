import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { NativeDhtTransport, NATIVE_TRANSPORT } from "./native-dht-transport.mjs";
import { requestObject, serveAuthorizedObject, sha256Hex } from "./object-transfer.mjs";
import { RelayPool, RelaySwarmSession } from "./relay-session.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function nowMs(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function runNativeJourney({
  relayUrls,
  bootstrap,
  bytes = randomBytes(1024 * 1024),
  WebSocketImpl = WebSocket,
  timeoutMs = 15_000,
  log = () => {},
} = {}) {
  if (!Array.isArray(relayUrls) || relayUrls.length === 0) throw new Error("At least one Nostr relay is required.");
  const object = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const expected = { sha256: sha256Hex(object), size: object.length };
  const requestId = randomBytes(16).toString("base64url");
  const swarmId = `native-${randomBytes(16).toString("hex")}`;
  const startedAt = performance.now();
  const timingsMs = {};

  const seederPool = new RelayPool(relayUrls, { label: "seeder", WebSocketImpl, connectTimeoutMs: timeoutMs });
  const leecherPool = new RelayPool(relayUrls, { label: "leecher", WebSocketImpl, connectTimeoutMs: timeoutMs });
  const seederSession = new RelaySwarmSession({ pool: seederPool, swarmId });
  const leecherSession = new RelaySwarmSession({ pool: leecherPool, swarmId });
  const seederTransport = new NativeDhtTransport({ bootstrap, connectionTimeoutMs: timeoutMs });
  const leecherTransport = new NativeDhtTransport({ bootstrap, connectionTimeoutMs: timeoutMs });
  const served = deferred();
  const fatal = deferred();
  const handledRequests = new Set();
  served.promise.catch(() => {});
  fatal.promise.catch(() => {});

  try {
    log("bootstrapping native DHT and Nostr relay sessions");
    await Promise.all([
      seederTransport.ready(),
      leecherTransport.ready(),
      seederPool.connect(),
      leecherPool.connect(),
    ]);
    timingsMs.infrastructureReady = nowMs(startedAt);
    log("native DHT and Nostr relay sessions ready");

    await seederTransport.listen(async (socket, authorization) => {
      try {
        log("seeder accepted the authorized Noise key");
        const result = await serveAuthorizedObject(socket, authorization, async () => object);
        log("seeder wrote the authorized object and EOF");
        served.resolve(result);
      } catch (error) {
        served.reject(error);
        throw error;
      }
    });
    log("seeder listening on its authenticated native key");

    seederSession.onError(fatal.reject);
    leecherSession.onError(fatal.reject);
    seederSession.onSignal(({ from, payload }) => {
      if (payload.type !== "dial" || payload.transport !== NATIVE_TRANSPORT) return;
      const { transportPublicKey, sha256, size } = payload.payload;
      const replayKey = `${from}:${payload.requestId}`;
      if (sha256 !== expected.sha256 || size !== expected.size || handledRequests.has(replayKey)) return;
      try {
        seederTransport.authorize({
          transportPublicKey,
          nostrPubkey: from,
          requestId: payload.requestId,
          sha256,
          size,
        });
      } catch {
        return;
      }
      handledRequests.add(replayKey);
      seederSession.sendSignal(from, {
        type: "ready",
        transport: NATIVE_TRANSPORT,
        requestId: payload.requestId,
        payload: { transportPublicKey: seederTransport.publicKey, sha256, size },
      });
    });
    seederSession.start();
    leecherSession.start();

    const presencePromise = leecherSession.waitForPresence(({ payload }) => (
      payload.role === "seeder"
      && payload.have.includes(expected.sha256)
      && payload.transports.some(({ type }) => type === NATIVE_TRANSPORT)
    ), timeoutMs);
    seederSession.announcePresence({
      role: "seeder",
      transports: [{ type: NATIVE_TRANSPORT, publicKey: seederTransport.publicKey }],
      have: [expected.sha256],
    });
    const presence = await Promise.race([presencePromise, fatal.promise]);
    const capability = presence.payload.transports.find(({ type }) => type === NATIVE_TRANSPORT);
    timingsMs.seederDiscovered = nowMs(startedAt);
    log("leecher discovered signed seeder presence");

    const readyPromise = leecherSession.waitForSignal(({ from, payload }) => (
      from === presence.from
      && payload.type === "ready"
      && payload.transport === NATIVE_TRANSPORT
      && payload.requestId === requestId
    ), timeoutMs);
    leecherSession.sendSignal(presence.from, {
      type: "dial",
      transport: NATIVE_TRANSPORT,
      requestId,
      payload: {
        transportPublicKey: leecherTransport.publicKey,
        sha256: expected.sha256,
        size: expected.size,
      },
    });
    const ready = await Promise.race([readyPromise, fatal.promise]);
    if (ready.payload.payload.transportPublicKey !== capability.publicKey
      || ready.payload.payload.sha256 !== expected.sha256
      || ready.payload.payload.size !== expected.size) {
      throw new Error("Seeder readiness did not match its signed presence or requested object.");
    }
    timingsMs.authorized = nowMs(startedAt);
    log("seeder issued encrypted one-shot dial authorization");

    const socket = await seederSafeConnect(leecherTransport, capability.publicKey);
    timingsMs.peerConnected = nowMs(startedAt);
    log("Noise-authenticated native stream connected");
    const transferStartedAt = performance.now();
    const [received] = await withTimeout(Promise.all([
      requestObject(socket, { requestId, ...expected }),
      Promise.race([served.promise, fatal.promise]),
    ]), timeoutMs, "Native object transfer timed out.");
    timingsMs.transfer = Math.round(performance.now() - transferStartedAt);
    timingsMs.endToEnd = nowMs(startedAt);
    log("receiver completed size and SHA-256 verification");

    const verified = received.length === expected.size && sha256Hex(received) === expected.sha256;
    if (!verified) throw new Error("Receiver verification failed after transfer.");
    return {
      ok: true,
      swarmId,
      transport: NATIVE_TRANSPORT,
      relayUrls: seederPool.urls,
      objectBytes: expected.size,
      sha256: expected.sha256,
      sha256Verified: true,
      stunServers: 0,
      turnServers: 0,
      timingsMs,
    };
  } finally {
    seederSession.close();
    leecherSession.close();
    seederPool.close();
    leecherPool.close();
    await Promise.allSettled([seederTransport.close(), leecherTransport.close()]);
  }
}

async function seederSafeConnect(transport, publicKey) {
  try {
    return await transport.connect(publicKey);
  } catch (error) {
    throw new Error(`Authorized native peer connection failed: ${error.message}`, { cause: error });
  }
}
