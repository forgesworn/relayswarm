import DHT from "hyperdht";

export const NATIVE_TRANSPORT = "hyperdht-v1";

const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_AUTHORIZATION_MS = 60_000;

function hex(value) {
  return Buffer.from(value).toString("hex");
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

export class NativeDhtTransport {
  constructor({ bootstrap, keyPair = DHT.keyPair(), connectionTimeoutMs = 15_000 } = {}) {
    this.keyPair = keyPair;
    this.publicKey = hex(keyPair.publicKey);
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.authorizations = new Map();
    this.server = null;
    this.connectionHandler = null;
    this.closed = false;
    this.dht = new DHT({ ...(bootstrap ? { bootstrap } : {}), keyPair });
  }

  async ready() {
    if (this.closed) throw new Error("Native transport is closed.");
    await withTimeout(this.dht.fullyBootstrapped(), this.connectionTimeoutMs, "Native DHT bootstrap timed out.");
  }

  async listen(connectionHandler) {
    if (this.server) throw new Error("Native transport is already listening.");
    if (typeof connectionHandler !== "function") throw new Error("Native transport requires a connection handler.");
    this.connectionHandler = connectionHandler;
    this.server = this.dht.createServer({
      firewall: (remotePublicKey) => {
        const key = hex(remotePublicKey);
        const authorization = this.authorizations.get(key);
        if (!authorization || authorization.expiresAt <= Date.now()) {
          this.authorizations.delete(key);
          return true;
        }
        return false;
      },
    });
    this.server.on("connection", (socket) => this.#accept(socket));
    this.server.on("error", () => {});
    await withTimeout(this.server.listen(this.keyPair), this.connectionTimeoutMs, "Native DHT server did not start.");
    return this.publicKey;
  }

  authorize({ transportPublicKey, nostrPubkey, requestId, sha256, size, lifetimeMs = 30_000 } = {}) {
    if (!HEX64.test(transportPublicKey) || !HEX64.test(nostrPubkey) || !HEX64.test(sha256)) throw new Error("Invalid native transport authorization.");
    if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 64) throw new Error("Invalid native transport request identifier.");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid native transport object size.");
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1_000 || lifetimeMs > MAX_AUTHORIZATION_MS) throw new Error("Invalid native transport authorization lifetime.");
    this.authorizations.set(transportPublicKey, {
      transportPublicKey,
      nostrPubkey,
      requestId,
      sha256,
      size,
      expiresAt: Date.now() + lifetimeMs,
    });
  }

  async #accept(socket) {
    socket.on("error", () => {});
    const remotePublicKey = hex(socket.remotePublicKey);
    const authorization = this.authorizations.get(remotePublicKey);
    this.authorizations.delete(remotePublicKey);
    if (!authorization || authorization.expiresAt <= Date.now()) {
      socket.destroy(new Error("Native transport connection was not authorized."));
      return;
    }
    try {
      await this.connectionHandler(socket, authorization);
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error("Native transport handler failed."));
    }
  }

  async connect(remotePublicKey) {
    if (!HEX64.test(remotePublicKey)) throw new Error("Invalid native transport peer key.");
    if (this.closed) throw new Error("Native transport is closed.");
    const socket = this.dht.connect(Buffer.from(remotePublicKey, "hex"), { keyPair: this.keyPair });
    socket.on("error", () => {});
    await withTimeout(new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    }), this.connectionTimeoutMs, "Native peer connection timed out.").catch((error) => {
      socket.destroy();
      throw error;
    });
    if (hex(socket.remotePublicKey) !== remotePublicKey) {
      socket.destroy();
      throw new Error("Native peer authenticated a different transport key.");
    }
    return socket;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.authorizations.clear();
    if (this.server) {
      await this.server.close().catch(() => {});
      this.server = null;
    }
    await this.dht.destroy({ force: true }).catch(() => {});
  }
}
