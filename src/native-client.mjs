import { randomBytes } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { WebSocket } from "ws";
import { NativeDhtTransport, NATIVE_TRANSPORT } from "./native-dht-transport.mjs";
import { DEFAULT_MAX_OBJECT_BYTES, requestObject, serveAuthorizedObject, sha256Hex } from "./object-transfer.mjs";
import { RelayPool, RelaySwarmSession } from "./relay-session.mjs";

const HEX64 = /^[0-9a-f]{64}$/u;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function integer(value, minimum, maximum, name) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Invalid native ${name}.`);
  return value;
}

/** The application supplies the independently trusted digest/size and endpoints.
 * A descriptor received from an untrusted peer does not establish provenance. */
export function validateNativeDescriptor(value, { maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES, allowLoopback = false } = {}) {
  integer(maxObjectBytes, 0, DEFAULT_MAX_OBJECT_BYTES, "object limit");
  if (!value || value.v !== 1 || typeof value.swarmId !== "string" || value.swarmId.length < 8 || value.swarmId.length > 128
    || typeof value.sha256 !== "string" || !HEX64.test(value.sha256)) throw new TypeError("Invalid native object descriptor.");
  integer(value.size, 0, maxObjectBytes, "object size");
  if (!Array.isArray(value.relayUrls) || !value.relayUrls.length || value.relayUrls.length > 8) throw new TypeError("Invalid native relay policy.");
  const endpoint = (raw, secure, local) => {
    if (typeof raw !== "string" || raw.length > 2048 || /[\s\\]/u.test(raw)) throw new TypeError("Invalid native endpoint.");
    const url = new URL(raw);
    if (url.username || url.password || url.hash || (url.protocol !== secure && !(allowLoopback && url.protocol === local && LOOPBACK.has(url.hostname)))) throw new TypeError("Unsafe native endpoint.");
    return url.href;
  };
  const relayUrls = [...new Set(value.relayUrls.map((raw) => endpoint(raw, "wss:", "ws:")))];
  if (!Array.isArray(value.trustedSeeders) || !value.trustedSeeders.length || value.trustedSeeders.length > 64
    || value.trustedSeeders.some((key) => typeof key !== "string" || !HEX64.test(key))) throw new TypeError("Explicit trusted native seeders are required.");
  return { v: 1, swarmId: value.swarmId, sha256: value.sha256, size: value.size, relayUrls,
    trustedSeeders: [...new Set(value.trustedSeeders)], ...(value.originUrl === undefined ? {} : { originUrl: endpoint(value.originUrl, "https:", "http:") }) };
}

function cancellable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function waitFor(session, method, predicate, signal) {
  return cancellable(new Promise((resolve, reject) => {
    let unsubscribe;
    const cleanup = () => { unsubscribe?.(); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(signal.reason); };
    unsubscribe = session[method]((value) => {
      try { if (predicate(value)) { cleanup(); resolve(value); } }
      catch (error) { cleanup(); reject(error); }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  }), signal);
}

async function peerObject(descriptor, { bootstrap, signal, peerTimeoutMs, WebSocketImpl, maxObjectBytes }) {
  // One stalled relay must not spend the whole peer deadline before discovery.
  const pool = new RelayPool(descriptor.relayUrls, { WebSocketImpl, connectTimeoutMs: peerTimeoutMs, readyOnFirstRelay: true });
  const session = new RelaySwarmSession({ pool, swarmId: descriptor.swarmId });
  const transport = new NativeDhtTransport({ bootstrap, connectionTimeoutMs: peerTimeoutMs });
  let socket;
  try {
    // Discovery needs only the transport's public key, so the DHT bootstrap
    // overlaps the presence round trip; the dial still waits for both.
    const transportReady = transport.ready();
    transportReady.catch(() => {});
    // A DHT failure still ends the relay wait at once, as the joint wait did.
    const transportFailed = new Promise((_, reject) => { transportReady.catch(reject); });
    transportFailed.catch(() => {});
    await cancellable(Promise.race([pool.connect(), transportFailed]), signal);
    const presence = waitFor(session, "onPresence", ({ from, payload }) => descriptor.trustedSeeders.includes(from)
      && payload.role === "seeder" && payload.have.includes(descriptor.sha256)
      && payload.transports.some(({ type }) => type === NATIVE_TRANSPORT), signal);
    // A startup/publication failure must not leave an unobserved wait rejection.
    presence.catch(() => {});
    session.start();
    if (signal.aborted) throw signal.reason;
    // Ephemeral presence may have no relay history. Request a live announcement
    // after subscribing, without advertising an inbound service or held objects.
    session.announcePresence({ role: "leecher", transports: [{ type: NATIVE_TRANSPORT, publicKey: transport.publicKey }],
      have: [], open: false });
    // Either failing ends the attempt at once.
    const [seeder] = await Promise.all([presence, cancellable(transportReady, signal)]);
    const key = seeder.payload.transports.find(({ type }) => type === NATIVE_TRANSPORT).publicKey;
    const requestId = randomBytes(16).toString("hex");
    const ready = waitFor(session, "onSignal", ({ from, payload }) => from === seeder.from
      && payload.type === "ready" && payload.transport === NATIVE_TRANSPORT && payload.requestId === requestId, signal);
    ready.catch(() => {});
    session.sendSignal(seeder.from, { type: "dial", transport: NATIVE_TRANSPORT, requestId,
      payload: { transportPublicKey: transport.publicKey, sha256: descriptor.sha256, size: descriptor.size } });
    const response = (await ready).payload.payload;
    if (response.transportPublicKey !== key || response.sha256 !== descriptor.sha256 || response.size !== descriptor.size) throw new Error("Native readiness does not match the trusted request.");
    socket = await cancellable(transport.connect(key), signal);
    return await cancellable(requestObject(socket, { requestId, sha256: descriptor.sha256, size: descriptor.size }, { maxObjectBytes }), signal);
  } finally {
    socket?.destroy(); session.close(); pool.close(); await transport.close();
  }
}

async function originObject(descriptor, { signal, fetchImpl }) {
  // Redirects require a new explicit trust decision; never follow them here.
  const pending = Promise.resolve().then(() => fetchImpl(descriptor.originUrl, { redirect: "error", signal, headers: { "accept-encoding": "identity" } }));
  const cancelBody = (response) => { try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {} };
  pending.then((lateResponse) => { if (signal.aborted) cancelBody(lateResponse); }, () => {});
  const response = await cancellable(pending, signal);
  if (!response.ok) { cancelBody(response); throw new Error("Native fallback origin is unavailable."); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) !== descriptor.size)) {
    cancelBody(response); throw new Error("Native fallback size differs from the trusted descriptor.");
  }
  const bytes = Buffer.allocUnsafe(descriptor.size);
  let size = 0, chunks = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const result = await cancellable(reader.read(), signal);
        if (result.done) break;
        size += result.value.byteLength;
        if (size > descriptor.size) throw new Error("Native fallback exceeded the trusted object size.");
        bytes.set(result.value, size - result.value.byteLength);
        // Tiny immediately available chunks must not starve cancellation timers.
        if (++chunks % 64 === 0) { await yieldToEventLoop(); if (signal.aborted) throw signal.reason; }
      }
    } catch (error) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} throw error; }
    finally { try { reader.releaseLock(); } catch {} }
  }
  if (size !== descriptor.size || sha256Hex(bytes) !== descriptor.sha256) throw new Error("Native fallback failed size or SHA-256 verification.");
  return bytes;
}

/** A bounded authenticated native attempt followed by verified HTTP fallback.
 * No bytes are returned until their independently expected digest is verified. */
export async function fetchNativeObject(input, { bootstrap, signal, peerTimeoutMs = 10000, timeoutMs = 30000,
  maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES, allowLoopback = false, WebSocketImpl = WebSocket, fetchImpl = globalThis.fetch } = {}) {
  integer(peerTimeoutMs, 1, 60000, "peer deadline"); integer(timeoutMs, peerTimeoutMs, 120000, "total deadline");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid native cancellation signal.");
  if (typeof fetchImpl !== "function") throw new TypeError("Invalid native HTTP implementation.");
  const descriptor = validateNativeDescriptor(input, { maxObjectBytes, allowLoopback });
  const started = performance.now();
  const overall = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  function checkDeadline() {
    if (overall.aborted) throw overall.reason;
    // Synchronous hashing or a custom reader can delay the abort timer.
    if (performance.now() - started >= timeoutMs) throw new DOMException("Native transfer deadline exceeded.", "TimeoutError");
  }
  checkDeadline();
  const peerSignal = AbortSignal.any([overall, AbortSignal.timeout(peerTimeoutMs)]);
  let bytes, source;
  try {
    bytes = await peerObject(descriptor, { bootstrap, signal: peerSignal, peerTimeoutMs, WebSocketImpl, maxObjectBytes }); source = NATIVE_TRANSPORT;
  } catch (error) {
    checkDeadline();
    if (!descriptor.originUrl) throw new Error("Native peer attempt failed and no trusted origin fallback is configured.", { cause: error });
    bytes = await originObject(descriptor, { signal: overall, fetchImpl }); source = new URL(descriptor.originUrl).protocol === "https:" ? "https-origin" : "http-loopback-origin";
  }
  checkDeadline();
  return { bytes, receipt: { v: 1, ok: true, source, objectBytes: bytes.length, sha256: descriptor.sha256, sha256Verified: true,
    elapsedMs: Math.round(performance.now() - started), fallback: source !== NATIVE_TRANSPORT } };
}

/** Explicit application-owned serving of one object with bounded one-use grants. */
export async function createNativeObjectSeeder({ bytes, swarmId, relayUrls, bootstrap, secretKey, originUrl, allowLoopback = false,
  timeoutMs = 10000, WebSocketImpl = WebSocket } = {}) {
  integer(timeoutMs, 1000, 60000, "seeder deadline");
  if (!(bytes instanceof Uint8Array) || bytes.length > DEFAULT_MAX_OBJECT_BYTES) throw new TypeError("Invalid native seeder bytes.");
  const object = Buffer.from(bytes), pool = new RelayPool(relayUrls, { WebSocketImpl, connectTimeoutMs: timeoutMs });
  const session = new RelaySwarmSession({ pool, swarmId, ...(secretKey ? { secretKey } : {}) });
  const descriptor = validateNativeDescriptor({ v: 1, swarmId, relayUrls, sha256: sha256Hex(object), size: object.length,
    trustedSeeders: [session.pubkey], ...(originUrl ? { originUrl } : {}) }, { allowLoopback });
  const transport = new NativeDhtTransport({ bootstrap, connectionTimeoutMs: timeoutMs });
  const handled = new Map();
  let heartbeat, presenceTimer, unsubscribePresence, closing;
  let stopped = false, lastAnnouncementAt = -Infinity;
  const announce = () => {
    if (stopped) return;
    try {
      session.announcePresence({ role: "seeder", transports: [{ type: NATIVE_TRANSPORT, publicKey: transport.publicKey }], have: [descriptor.sha256] });
    } finally { lastAnnouncementAt = performance.now(); }
  };
  const schedulePresence = () => {
    if (stopped || presenceTimer !== undefined) return;
    const publishWhenDue = () => {
      presenceTimer = undefined;
      if (stopped) return;
      const remaining = 1000 - (performance.now() - lastAnnouncementAt);
      if (remaining > 0) {
        presenceTimer = setTimeout(publishWhenDue, Math.ceil(remaining));
        presenceTimer.unref();
        return;
      }
      try { announce(); } catch { /* A relay failure does not escape a timer callback. */ }
    };
    presenceTimer = setTimeout(publishWhenDue, Math.max(0, Math.ceil(1000 - (performance.now() - lastAnnouncementAt))));
    presenceTimer.unref();
  };
  const close = () => {
    if (closing) return closing;
    stopped = true; clearInterval(heartbeat); clearTimeout(presenceTimer);
    presenceTimer = undefined; unsubscribePresence?.(); session.close(); pool.close();
    closing = transport.close();
    return closing;
  };
  try {
    await Promise.all([pool.connect(), transport.ready()]);
    await transport.listen((socket, authorization) => serveAuthorizedObject(socket, authorization, () => object));
    session.onSignal(({ from, payload }) => {
      if (stopped) return;
      if (payload.type !== "dial" || payload.transport !== NATIVE_TRANSPORT || payload.payload.sha256 !== descriptor.sha256 || payload.payload.size !== descriptor.size) return;
      const replayKey = `${from}:${payload.requestId}`, now = Date.now();
      for (const [key, expires] of handled) if (expires <= now) handled.delete(key);
      if (handled.has(replayKey) || handled.size >= 256) return;
      try {
        transport.authorize({ transportPublicKey: payload.payload.transportPublicKey, nostrPubkey: from,
          requestId: payload.requestId, sha256: descriptor.sha256, size: descriptor.size });
        handled.set(replayKey, now + 120000);
        session.sendSignal(from, { type: "ready", transport: NATIVE_TRANSPORT, requestId: payload.requestId,
          payload: { transportPublicKey: transport.publicKey, sha256: descriptor.sha256, size: descriptor.size } });
      } catch { /* Exhausted or invalid grants do not create an unbounded queue. */ }
    });
    // This readiness hint only coalesces a public announcement. A signed dial
    // with the exact object identity still creates each one-use transport grant.
    unsubscribePresence = session.onPresence(({ payload }) => {
      if (payload.role === "leecher" && payload.transports.some(({ type }) => type === NATIVE_TRANSPORT)) schedulePresence();
    });
    session.start();
    announce(); heartbeat = setInterval(schedulePresence, 20000); heartbeat.unref();
    return { descriptor, close };
  } catch (error) { await close(); throw error; }
}
