import { randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { v2 as nip44 } from "nostr-tools/nip44";

export const RELAYSWARM_VERSION = 3;
export const KIND_PRESENCE = 24170;
export const KIND_SIGNAL = 24171;
export const SWARM_TAG = "x";

const HEX64 = /^[0-9a-f]{64}$/u;
const TOKEN = /^[a-z0-9](?:[a-z0-9-]{0,31})$/u;
const MAX_RELAY_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_PRESENCE_BYTES = 16 * 1024;
const MAX_SIGNAL_CIPHERTEXT_BYTES = 64 * 1024;
const MAX_SIGNAL_PLAINTEXT_BYTES = 8 * 1024;

function byteLength(value) {
  if (typeof value === "string") return Buffer.byteLength(value);
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  return Buffer.byteLength(String(value));
}

function eventTagValues(event, name) {
  if (!Array.isArray(event?.tags)) return [];
  return event.tags
    .filter((tag) => Array.isArray(tag) && tag.length >= 2 && tag[0] === name && typeof tag[1] === "string")
    .map((tag) => tag[1]);
}

function uniqueTag(event, name) {
  const values = eventTagValues(event, name);
  return values.length === 1 ? values[0] : null;
}

function parseObject(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value;
}

function validToken(value) {
  return typeof value === "string" && TOKEN.test(value);
}

function validRequestId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 64 && /^[a-zA-Z0-9_-]+$/u.test(value);
}

function validateRelayUrl(value) {
  const url = new URL(String(value));
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback)) {
    throw new Error("Relay URLs must use wss://, except for loopback tests.");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url.toString();
}

export class RelayPool {
  constructor(urls, { label = "relay", WebSocketImpl = globalThis.WebSocket, connectTimeoutMs = 8_000 } = {}) {
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 8) throw new Error("RelayPool requires between one and eight relay URLs.");
    if (typeof WebSocketImpl !== "function") throw new Error("RelayPool requires a WebSocket implementation.");
    this.urls = [...new Set(urls.map(validateRelayUrl))];
    this.label = label;
    this.WebSocketImpl = WebSocketImpl;
    this.connectTimeoutMs = connectTimeoutMs;
    this.sockets = [];
    this.handlers = new Set();
    this.seen = new Set();
    this.connected = false;
  }

  async connect() {
    if (this.connected) return;
    const results = await Promise.allSettled(this.urls.map((url) => this.#connectOne(url)));
    if (this.sockets.length === 0) {
      const reasons = results.map((result) => result.status === "rejected" ? result.reason?.message : "").filter(Boolean);
      throw new Error(`No relay reachable${reasons.length ? `: ${reasons.join("; ")}` : "."}`);
    }
    this.connected = true;
  }

  #connectOne(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new this.WebSocketImpl(url);
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(socket);
      };
      const timer = setTimeout(() => {
        try { socket.close(); } catch {}
        finish(new Error(`${url} timed out`));
      }, this.connectTimeoutMs);
      socket.addEventListener("open", () => {
        this.sockets.push(socket);
        finish();
      });
      socket.addEventListener("error", () => finish(new Error(`${url} failed to connect`)));
      socket.addEventListener("message", (message) => this.#onMessage(message.data));
      socket.addEventListener("close", () => {
        this.sockets = this.sockets.filter((candidate) => candidate !== socket);
      });
    });
  }

  #onMessage(data) {
    if (byteLength(data) > MAX_RELAY_FRAME_BYTES) return;
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame[0] !== "EVENT" || !frame[2] || typeof frame[2] !== "object") return;
    const event = frame[2];
    if (typeof event.id !== "string" || this.seen.has(event.id) || !verifyEvent(event)) return;
    this.seen.add(event.id);
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value);
    for (const handler of this.handlers) handler(event);
  }

  subscribe(filter) {
    if (!this.connected || this.sockets.length === 0) throw new Error("RelayPool is not connected.");
    const subscriptionId = randomBytes(8).toString("hex");
    const frame = JSON.stringify(["REQ", subscriptionId, filter]);
    for (const socket of this.sockets) socket.send(frame);
    return subscriptionId;
  }

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publish(event) {
    if (!this.connected || this.sockets.length === 0) throw new Error("RelayPool has no connected relay.");
    const frame = JSON.stringify(["EVENT", event]);
    for (const socket of this.sockets) socket.send(frame);
  }

  close() {
    this.connected = false;
    for (const socket of this.sockets) {
      try { socket.close(); } catch {}
    }
    this.sockets = [];
    this.handlers.clear();
  }
}

export class RelaySwarmSession {
  constructor({ pool, swarmId, secretKey = generateSecretKey(), maxEventAgeSeconds = 120 } = {}) {
    if (!pool) throw new Error("RelaySwarmSession requires a relay pool.");
    if (typeof swarmId !== "string" || swarmId.length < 8 || swarmId.length > 128) throw new Error("Invalid swarm identifier.");
    this.pool = pool;
    this.swarmId = swarmId;
    this.secretKey = secretKey;
    this.pubkey = getPublicKey(secretKey);
    this.maxEventAgeSeconds = maxEventAgeSeconds;
    this.presenceHandlers = new Set();
    this.signalHandlers = new Set();
    this.errorHandlers = new Set();
    this.started = false;
    this.unsubscribe = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.unsubscribe = this.pool.onEvent((event) => this.#receive(event));
    this.pool.subscribe({
      kinds: [KIND_PRESENCE, KIND_SIGNAL],
      [`#${SWARM_TAG}`]: [this.swarmId],
      since: Math.floor(Date.now() / 1000) - 2,
    });
  }

  onPresence(handler) {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  onSignal(handler) {
    this.signalHandlers.add(handler);
    return () => this.signalHandlers.delete(handler);
  }

  onError(handler) {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  announcePresence({ role, transports = [], have = [] } = {}) {
    if (!validToken(role)) throw new Error("Invalid presence role.");
    if (!Array.isArray(transports) || transports.length > 8) throw new Error("Invalid transport capability list.");
    if (!Array.isArray(have) || have.length > 32 || have.some((hash) => !HEX64.test(hash))) throw new Error("Invalid object hash list.");
    const normalizedTransports = transports.map((transport) => {
      if (!transport || typeof transport !== "object" || !validToken(transport.type) || !HEX64.test(transport.publicKey)) {
        throw new Error("Invalid transport capability.");
      }
      return { type: transport.type, publicKey: transport.publicKey };
    });
    const content = JSON.stringify({ v: RELAYSWARM_VERSION, role, transports: normalizedTransports, have: [...new Set(have)] });
    if (Buffer.byteLength(content) > MAX_PRESENCE_BYTES) throw new Error("Presence payload is too large.");
    const event = finalizeEvent({
      kind: KIND_PRESENCE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[SWARM_TAG, this.swarmId]],
      content,
    }, this.secretKey);
    this.pool.publish(event);
    return event;
  }

  sendSignal(toPubkey, { type, transport, requestId, payload = {} } = {}) {
    if (!HEX64.test(toPubkey)) throw new Error("Invalid signal recipient.");
    if (!validToken(type) || !validToken(transport) || !validRequestId(requestId)) throw new Error("Invalid signal envelope.");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid signal payload.");
    const plaintext = JSON.stringify({ v: RELAYSWARM_VERSION, type, transport, requestId, payload });
    if (Buffer.byteLength(plaintext) > MAX_SIGNAL_PLAINTEXT_BYTES) throw new Error("Signal payload is too large.");
    const conversationKey = nip44.utils.getConversationKey(this.secretKey, toPubkey);
    const content = nip44.encrypt(plaintext, conversationKey);
    const event = finalizeEvent({
      kind: KIND_SIGNAL,
      created_at: Math.floor(Date.now() / 1000),
      tags: [[SWARM_TAG, this.swarmId], ["p", toPubkey]],
      content,
    }, this.secretKey);
    this.pool.publish(event);
    return event;
  }

  waitForPresence(predicate, timeoutMs = 15_000) {
    return this.#wait(this.presenceHandlers, predicate, timeoutMs, "Timed out waiting for RelaySwarm presence.");
  }

  waitForSignal(predicate, timeoutMs = 15_000) {
    return this.#wait(this.signalHandlers, predicate, timeoutMs, "Timed out waiting for RelaySwarm signal.");
  }

  #wait(handlers, predicate, timeoutMs, message) {
    return new Promise((resolve, reject) => {
      const handler = (value) => {
        let matches = false;
        try { matches = predicate(value); } catch (error) {
          clearTimeout(timer);
          handlers.delete(handler);
          reject(error);
          return;
        }
        if (!matches) return;
        clearTimeout(timer);
        handlers.delete(handler);
        resolve(value);
      };
      const timer = setTimeout(() => {
        handlers.delete(handler);
        reject(new Error(message));
      }, timeoutMs);
      handlers.add(handler);
    });
  }

  #receive(event) {
    if (event.pubkey === this.pubkey || (event.kind !== KIND_PRESENCE && event.kind !== KIND_SIGNAL)) return;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isSafeInteger(event.created_at) || event.created_at > now + 30 || event.created_at < now - this.maxEventAgeSeconds) return;
    if (uniqueTag(event, SWARM_TAG) !== this.swarmId) return;
    try {
      if (event.kind === KIND_PRESENCE) this.#receivePresence(event);
      else this.#receiveSignal(event);
    } catch {
      // Public relays are adversarial input. Invalid events are ignored.
    }
  }

  #receivePresence(event) {
    if (Buffer.byteLength(event.content) > MAX_PRESENCE_BYTES || eventTagValues(event, "p").length !== 0) return;
    const payload = parseObject(event.content);
    if (payload.v !== RELAYSWARM_VERSION || !validToken(payload.role)) return;
    if (!Array.isArray(payload.transports) || payload.transports.length > 8) return;
    if (!Array.isArray(payload.have) || payload.have.length > 32 || payload.have.some((hash) => !HEX64.test(hash))) return;
    const transports = payload.transports.map((transport) => {
      if (!transport || typeof transport !== "object" || !validToken(transport.type) || !HEX64.test(transport.publicKey)) {
        throw new Error("Invalid transport capability.");
      }
      return { type: transport.type, publicKey: transport.publicKey };
    });
    this.#dispatch(this.presenceHandlers, { from: event.pubkey, event, payload: { ...payload, transports } });
  }

  #receiveSignal(event) {
    if (Buffer.byteLength(event.content) > MAX_SIGNAL_CIPHERTEXT_BYTES || uniqueTag(event, "p") !== this.pubkey) return;
    const conversationKey = nip44.utils.getConversationKey(this.secretKey, event.pubkey);
    const payload = parseObject(nip44.decrypt(event.content, conversationKey));
    if (payload.v !== RELAYSWARM_VERSION || !validToken(payload.type) || !validToken(payload.transport) || !validRequestId(payload.requestId)) return;
    if (!payload.payload || typeof payload.payload !== "object" || Array.isArray(payload.payload)) return;
    this.#dispatch(this.signalHandlers, { from: event.pubkey, event, payload });
  }

  #dispatch(handlers, value) {
    for (const handler of handlers) {
      Promise.resolve().then(() => handler(value)).catch((error) => {
        for (const errorHandler of this.errorHandlers) errorHandler(error);
      });
    }
  }

  close() {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.started = false;
    this.presenceHandlers.clear();
    this.signalHandlers.clear();
    this.errorHandlers.clear();
  }
}
