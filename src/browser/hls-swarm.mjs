// Peer-assisted live HLS for hls.js, shadow mode.
//
// In shadow mode the player is never touched: every fragment still loads
// from the origin exactly as it would without this module. Alongside each
// load the swarm asks connected viewers for the same fragment, hashes what
// they send, and compares it with the bytes the origin gave the player. The
// result is a measurement of what peer delivery would have achieved, taken
// on real networks, at no risk to playback.
//
// Rendezvous is RelaySwarm's: presence (kind 24170) and NIP-44 encrypted
// SDP (kind 24171) over the relays the host page names, under a per-viewer
// ephemeral key. Once a data channel is open, segment availability travels
// on the channel, not the relays, so relay load is presence plus one
// offer/answer pair per connection.
//
// Guarantees the host page can rely on:
//   - attach() only wraps the fragment loader; bytes reach hls.js before any
//     swarm work runs, and no swarm error can reach the player.
//   - upload is capped in peers and bytes per second, and off on cellular
//     connections by default.
//   - stop() restores the original loader and closes every socket and peer.

import { generateSecretKey } from "nostr-tools/pure";
import { RelayPool, RelaySwarmSession } from "../relay-session.mjs";
import { PeerLink } from "./peer-link.mjs";

export const HLS_SWARM_METRICS_VERSION = 1;

const TRANSPORT = "webrtc";
const DEFAULTS = Object.freeze({
  mode: "shadow",
  originFallbackMs: 1_500,
  lateWindowMs: 6_000,
  maxPeers: 6,
  maxUploadPeers: 4,
  maxUploadBytesPerSecond: 1_250_000,
  maxDialsInFlight: 2,
  dialTimeoutMs: 12_000,
  presenceIntervalMs: 20_000,
  metricsIntervalMs: 10_000,
  maxHeldSegments: 12,
  maxHeldBytes: 64 * 1024 * 1024,
  maxSegmentBytes: 16 * 1024 * 1024,
  shadowSampleRate: 1,
  swarmParts: false,
  serveOnCellular: false,
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
});
const SAMPLE_LIMIT = 500;

const now = () => performance.now();
const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
const utf8 = new TextEncoder();

async function sha256Hex(bytes) {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

function defaultSegmentKey(url) {
  const parsed = new URL(url, globalThis.location?.href);
  return parsed.pathname;
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
}

function pushSample(list, value) {
  list.push(value);
  if (list.length > SAMPLE_LIMIT) list.shift();
}

function onCellular() {
  const connection = globalThis.navigator?.connection;
  return Boolean(connection && (connection.type === "cellular" || connection.saveData));
}

function gathered(pc, capMs = 1_200) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    const cap = setTimeout(resolve, capMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(cap);
        resolve();
      }
    });
  });
}

async function candidatePairTypes(pc) {
  try {
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach((report) => {
      if (report.type === "transport" && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId) || pair;
    });
    if (!pair) stats.forEach((report) => {
      if (report.type === "candidate-pair" && report.state === "succeeded" && (report.selected || report.nominated)) pair = report;
    });
    if (!pair) return "unknown";
    return `${stats.get(pair.localCandidateId)?.candidateType || "?"}/${stats.get(pair.remoteCandidateId)?.candidateType || "?"}`;
  } catch {
    return "unknown";
  }
}

function randomRequestId() {
  return hex(globalThis.crypto.getRandomValues(new Uint8Array(12)));
}

/**
 * Create a swarm for one live stream. Never throws: an unusable
 * configuration or browser yields a swarm whose metrics() say why it is off.
 */
export function createHlsSwarm(options = {}) {
  const swarm = new HlsSwarm(options);
  return {
    attach: (hls) => swarm.attach(hls),
    stop: () => swarm.stop(),
    metrics: () => swarm.metrics(),
  };
}

class HlsSwarm {
  constructor(options) {
    this.options = { ...DEFAULTS, ...options };
    this.startedAt = Date.now();
    this.disabledReason = this.#validate();
    this.stopped = false;
    this.hls = null;
    this.originalFragmentLoader = undefined;
    this.pool = null;
    this.session = null;
    this.timers = new Set();
    this.links = new Map();
    this.dials = new Map();
    this.cooldowns = new Map();
    this.banned = new Set();
    this.held = new Map();
    this.heldBytes = 0;
    this.races = new Set();
    this.haveWaiters = new Set();
    this.uploadTokens = this.options.maxUploadBytesPerSecond;
    this.uploadRefilledAt = now();
    this.counters = {
      originLoaded: 0,
      raced: 0,
      noPeers: 0,
      sampledOut: 0,
      skipped: 0,
      peerInTime: 0,
      peerLate: 0,
      peerMiss: 0,
      peerCorrupt: 0,
      peerUnverified: 0,
      aborted: 0,
      bytesFromOrigin: 0,
      bytesFromPeers: 0,
      bytesUploaded: 0,
      uploadsServed: 0,
      uploadsRefused: 0,
      dialsStarted: 0,
      dialsAccepted: 0,
      dialsFailed: 0,
      dialsTimedOut: 0,
      dialsRejected: 0,
      offersAccepted: 0,
      offersRefused: 0,
      linksOpened: 0,
      linksClosed: 0,
      presenceSent: 0,
      signalsSent: 0,
      publishErrors: 0,
      errors: 0,
    };
    this.pairTypes = {};
    this.signallingSamples = [];
    this.peerLatencySamples = [];
    this.originLatencySamples = [];
    this.errorsByStage = {};
  }

  #validate() {
    const { swarmId, relays, mode } = this.options;
    if (typeof swarmId !== "string" || swarmId.length < 8 || swarmId.length > 128) return "invalid-swarm-id";
    if (!Array.isArray(relays) || relays.length < 1 || relays.length > 8) return "invalid-relays";
    if (mode === "off") return "mode-off";
    if (mode === "peer-first") return "peer-first-not-available";
    if (mode !== "shadow") return "invalid-mode";
    if (!globalThis.crypto?.subtle) return "no-webcrypto";
    if (typeof (this.options.RTCPeerConnectionImpl || globalThis.RTCPeerConnection) !== "function") return "no-webrtc";
    if (typeof (this.options.WebSocketImpl || globalThis.WebSocket) !== "function") return "no-websocket";
    return "";
  }

  attach(hls) {
    if (this.stopped || this.hls || this.disabledReason || !hls?.config) return;
    try {
      this.hls = hls;
      this.originalFragmentLoader = hls.config.fLoader;
      hls.config.fLoader = this.#shadowLoader(hls.config.fLoader || hls.config.loader);
      this.#guard("start", () => this.#start());
      if (typeof this.options.onMetrics === "function") {
        this.#every(this.options.metricsIntervalMs, 0, () => this.options.onMetrics(this.metrics()));
      }
    } catch (error) {
      this.#noteError("attach", error);
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try {
      if (this.hls && this.hls.config.fLoader?.relayswarmShadow) this.hls.config.fLoader = this.originalFragmentLoader;
    } catch {}
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const waiter of this.haveWaiters) waiter();
    this.haveWaiters.clear();
    for (const dial of this.dials.values()) {
      try { dial.pc.close(); } catch {}
    }
    this.dials.clear();
    for (const link of [...this.links.values()]) link.close();
    this.links.clear();
    this.held.clear();
    this.heldBytes = 0;
    try { this.session?.close(); } catch {}
    try { this.pool?.close(); } catch {}
    try { this.options.onMetrics?.(this.metrics()); } catch {}
  }

  metrics() {
    const c = this.counters;
    const resolved = c.peerInTime + c.peerLate + c.peerMiss + c.peerCorrupt;
    return {
      v: HLS_SWARM_METRICS_VERSION,
      swarmId: this.options.swarmId,
      mode: this.disabledReason ? "off" : this.options.mode,
      disabledReason: this.disabledReason || null,
      stopped: this.stopped,
      pubkey: this.session?.pubkey || null,
      uptimeMs: Date.now() - this.startedAt,
      serving: this.#servingAllowed(),
      peers: {
        connected: this.links.size,
        dialling: this.dials.size,
        dialsStarted: c.dialsStarted,
        dialsAccepted: c.dialsAccepted,
        dialsFailed: c.dialsFailed,
        dialsTimedOut: c.dialsTimedOut,
        dialsRejected: c.dialsRejected,
        offersAccepted: c.offersAccepted,
        offersRefused: c.offersRefused,
        linksOpened: c.linksOpened,
        linksClosed: c.linksClosed,
        banned: this.banned.size,
        candidatePairs: { ...this.pairTypes },
      },
      signalling: {
        samples: this.signallingSamples.length,
        medianMs: percentile(this.signallingSamples, 0.5),
        p90Ms: percentile(this.signallingSamples, 0.9),
      },
      segments: {
        originLoaded: c.originLoaded,
        raced: c.raced,
        noPeers: c.noPeers,
        sampledOut: c.sampledOut,
        skipped: c.skipped,
        aborted: c.aborted,
        peerInTime: c.peerInTime,
        peerLate: c.peerLate,
        peerMiss: c.peerMiss,
        peerCorrupt: c.peerCorrupt,
        peerUnverified: c.peerUnverified,
        inTimeShare: resolved ? Number((c.peerInTime / resolved).toFixed(3)) : null,
        peerLatencyMedianMs: percentile(this.peerLatencySamples, 0.5),
        peerLatencyP90Ms: percentile(this.peerLatencySamples, 0.9),
        originLatencyMedianMs: percentile(this.originLatencySamples, 0.5),
      },
      bytes: {
        fromOrigin: c.bytesFromOrigin,
        fromPeers: c.bytesFromPeers,
        uploaded: c.bytesUploaded,
        uploadsServed: c.uploadsServed,
        uploadsRefused: c.uploadsRefused,
        held: this.heldBytes,
      },
      relays: {
        connected: this.pool?.sockets.length ?? 0,
        presenceSent: c.presenceSent,
        signalsSent: c.signalsSent,
        published: this.pool?.published ?? 0,
        rejected: this.pool?.rejected ?? 0,
        publishErrors: c.publishErrors,
      },
      errors: { total: c.errors, byStage: { ...this.errorsByStage } },
      config: {
        originFallbackMs: this.options.originFallbackMs,
        lateWindowMs: this.options.lateWindowMs,
        maxPeers: this.options.maxPeers,
        maxUploadPeers: this.options.maxUploadPeers,
        maxUploadBytesPerSecond: this.options.maxUploadBytesPerSecond,
        shadowSampleRate: this.options.shadowSampleRate,
        relays: [...this.options.relays],
      },
    };
  }

  // --- guards and timers ----------------------------------------------------

  #noteError(stage, _error) {
    this.counters.errors += 1;
    this.errorsByStage[stage] = (this.errorsByStage[stage] || 0) + 1;
  }

  #guard(stage, fn) {
    try {
      const result = fn();
      if (result && typeof result.catch === "function") result.catch((error) => this.#noteError(stage, error));
    } catch (error) {
      this.#noteError(stage, error);
    }
  }

  #after(ms, fn) {
    if (this.stopped) return null;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) this.#guard("timer", fn);
    }, Math.max(0, ms));
    this.timers.add(timer);
    return timer;
  }

  #every(intervalMs, jitterFraction, fn) {
    const schedule = () => {
      const jitter = intervalMs * jitterFraction * (Math.random() * 2 - 1);
      this.#after(intervalMs + jitter, () => {
        fn();
        schedule();
      });
    };
    schedule();
  }

  // --- the player side ------------------------------------------------------

  #shadowLoader(BaseLoader) {
    const swarm = this;
    class RelaySwarmShadowLoader {
      static relayswarmShadow = true;

      constructor(config) {
        this.inner = new BaseLoader(config);
      }

      get stats() { return this.inner.stats; }
      get context() { return this.inner.context; }

      load(context, config, callbacks) {
        const race = swarm.#beginRace(context);
        if (!race) return this.inner.load(context, config, callbacks);
        const progress = [];
        const tapped = {
          ...callbacks,
          onProgress: callbacks.onProgress
            ? (stats, ctx, data, details) => {
                try { if (data?.byteLength) progress.push(data.slice(0)); } catch {}
                callbacks.onProgress(stats, ctx, data, details);
              }
            : undefined,
          onSuccess: (response, stats, ctx, details) => {
            // Copy before hls.js sees the buffer: it may transfer it to a worker.
            let copy = null;
            try {
              const data = response?.data;
              if (data?.byteLength) copy = data.slice(0);
              else if (progress.length) copy = RelaySwarmShadowLoader.join(progress);
            } catch {}
            callbacks.onSuccess(response, stats, ctx, details);
            if (copy) swarm.#guard("origin-loaded", () => swarm.#originLoaded(race, copy));
            else swarm.#guard("origin-empty", () => swarm.#originFailed(race));
          },
          onError: (...args) => {
            swarm.#guard("origin-error", () => swarm.#originFailed(race));
            callbacks.onError(...args);
          },
          onTimeout: (...args) => {
            swarm.#guard("origin-timeout", () => swarm.#originFailed(race));
            callbacks.onTimeout(...args);
          },
        };
        if (callbacks.onAbort) {
          tapped.onAbort = (...args) => {
            swarm.#guard("origin-abort", () => swarm.#originFailed(race));
            callbacks.onAbort(...args);
          };
        }
        return this.inner.load(context, config, tapped);
      }

      abort() { return this.inner.abort(); }
      destroy() { return this.inner.destroy(); }
      getCacheAge() { return this.inner.getCacheAge?.() ?? null; }
      getResponseHeader(name) { return this.inner.getResponseHeader?.(name) ?? null; }

      static join(parts) {
        const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          out.set(new Uint8Array(part), offset);
          offset += part.byteLength;
        }
        return out.buffer;
      }
    }
    return RelaySwarmShadowLoader;
  }

  // Called synchronously from the loader, so it must stay cheap and never throw.
  #beginRace(context) {
    try {
      if (this.stopped) return null;
      const frag = context?.frag;
      if (!frag || frag.sn === "initSegment" || (context.part && !this.options.swarmParts)) {
        this.counters.skipped += 1;
        return null;
      }
      const url = context.url || frag.url;
      const rawKey = (this.options.segmentKey || defaultSegmentKey)(url, context);
      if (typeof rawKey !== "string" || !rawKey) {
        this.counters.skipped += 1;
        return null;
      }
      const range = context.rangeEnd ? `#${context.rangeStart || 0}-${context.rangeEnd}` : "";
      const race = {
        t0: now(),
        keyText: `${this.options.swarmId}\n${rawKey}${range}`,
        key: null,
        sampled: Math.random() < this.options.shadowSampleRate,
        peersAtStart: this.links.size,
        originDigest: null,
        originDone: false,
        originFailed: false,
        peerBytes: null,
        peerAt: 0,
        peerLink: null,
        peerDone: false,
        settled: false,
      };
      this.races.add(race);
      this.#guard("race", () => this.#runRace(race));
      return race;
    } catch (error) {
      this.#noteError("begin-race", error);
      return null;
    }
  }

  async #runRace(race) {
    race.key = await sha256Hex(utf8.encode(race.keyText));
    if (this.stopped) return;
    if (!race.sampled || onCellular()) {
      race.peerDone = true;
      race.skipPeers = true;
      return this.#guard("settle", () => this.#settle(race));
    }
    const deadline = race.t0 + this.options.lateWindowMs;
    const tried = new Set();
    let sawPeer = race.peersAtStart > 0;
    while (!this.stopped && !race.settled && now() < deadline) {
      if (this.links.size) sawPeer = true;
      const link = [...this.links.values()].find((candidate) => !candidate.busy && !tried.has(candidate.pubkey) && candidate.have.has(race.key));
      if (!link) {
        await this.#waitForHave(race.key, deadline - now());
        continue;
      }
      tried.add(link.pubkey);
      const bytes = await link.request(race.key, deadline - now());
      if (bytes && !this.stopped) {
        race.peerBytes = bytes;
        race.peerAt = now();
        race.peerLink = link;
        break;
      }
    }
    race.peerDone = true;
    race.sawPeer = sawPeer || this.links.size > 0;
    this.#guard("settle", () => this.#settle(race));
  }

  #waitForHave(key, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null;
      const waiter = (added) => {
        if (added && !added.includes(key)) return;
        clearTimeout(timer);
        this.haveWaiters.delete(waiter);
        resolve();
      };
      timer = setTimeout(waiter, Math.max(0, Math.min(timeoutMs, 1_000)));
      this.haveWaiters.add(waiter);
    });
  }

  async #originLoaded(race, buffer) {
    const bytes = new Uint8Array(buffer);
    const t1 = now();
    this.counters.originLoaded += 1;
    this.counters.bytesFromOrigin += bytes.byteLength;
    pushSample(this.originLatencySamples, t1 - race.t0);
    race.originDigest = await sha256Hex(bytes);
    race.originDone = true;
    while (!race.key && !this.stopped) await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.stopped) return;
    this.#hold(race.key, bytes);
    this.#guard("settle", () => this.#settle(race));
  }

  #originFailed(race) {
    race.originDone = true;
    race.originFailed = true;
    this.#guard("settle", () => this.#settle(race));
  }

  async #settle(race) {
    if (race.settled || !race.originDone || !race.peerDone) return;
    race.settled = true;
    this.races.delete(race);
    const c = this.counters;
    if (race.skipPeers) return void (c.sampledOut += 1);
    if (race.originFailed) {
      if (race.peerBytes) c.peerUnverified += 1;
      else c.aborted += 1;
      return;
    }
    if (!race.peerBytes) {
      if (race.sawPeer) {
        c.raced += 1;
        c.peerMiss += 1;
      } else {
        c.noPeers += 1;
      }
      return;
    }
    c.raced += 1;
    const peerDigest = await sha256Hex(race.peerBytes);
    if (peerDigest !== race.originDigest) {
      c.peerCorrupt += 1;
      this.banned.add(race.peerLink.pubkey);
      race.peerLink.close();
      return;
    }
    const latency = race.peerAt - race.t0;
    pushSample(this.peerLatencySamples, latency);
    c.bytesFromPeers += race.peerBytes.byteLength;
    if (latency <= this.options.originFallbackMs) c.peerInTime += 1;
    else c.peerLate += 1;
  }

  // --- held segments and upload --------------------------------------------

  #hold(key, bytes) {
    if (this.held.has(key) || bytes.byteLength > this.options.maxSegmentBytes) return;
    this.held.set(key, bytes);
    this.heldBytes += bytes.byteLength;
    const evicted = [];
    while (this.held.size > this.options.maxHeldSegments || this.heldBytes > this.options.maxHeldBytes) {
      const [oldKey, oldBytes] = this.held.entries().next().value;
      this.held.delete(oldKey);
      this.heldBytes -= oldBytes.byteLength;
      evicted.push(oldKey);
    }
    if (!this.#servingAllowed()) return;
    for (const link of this.links.values()) link.sendHaveChange([key], evicted);
  }

  #servingAllowed() {
    return !this.stopped && !this.disabledReason && (this.options.serveOnCellular || !onCellular());
  }

  #serveRequest(link, key) {
    const bytes = this.held.get(key);
    if (!bytes || !this.#servingAllowed() || this.banned.has(link.pubkey)) {
      this.counters.uploadsRefused += 1;
      return null;
    }
    const recentUploaders = [...this.links.values()].filter((candidate) => candidate !== link && Date.now() - candidate.lastServedAt < 30_000).length;
    if (Date.now() - link.lastServedAt >= 30_000 && recentUploaders >= this.options.maxUploadPeers) {
      this.counters.uploadsRefused += 1;
      return null;
    }
    const elapsed = (now() - this.uploadRefilledAt) / 1_000;
    this.uploadRefilledAt = now();
    this.uploadTokens = Math.min(this.options.maxUploadBytesPerSecond * 2, this.uploadTokens + elapsed * this.options.maxUploadBytesPerSecond);
    if (this.uploadTokens < bytes.byteLength) {
      this.counters.uploadsRefused += 1;
      return null;
    }
    this.uploadTokens -= bytes.byteLength;
    this.counters.uploadsServed += 1;
    this.counters.bytesUploaded += bytes.byteLength;
    if (this.options.testHooks?.corruptUploads) {
      const tampered = bytes.slice();
      tampered[tampered.length >> 1] ^= 0xff;
      return tampered;
    }
    return bytes;
  }

  // --- rendezvous -----------------------------------------------------------

  async #start() {
    const secretKey = this.options.secretKey || generateSecretKey();
    this.pool = new RelayPool(this.options.relays, {
      label: "hls-swarm",
      WebSocketImpl: this.options.WebSocketImpl || globalThis.WebSocket,
      reconnect: true,
    });
    await this.pool.connect();
    if (this.stopped) return this.pool.close();
    this.session = new RelaySwarmSession({ pool: this.pool, swarmId: this.options.swarmId, secretKey, maxEventAgeSeconds: 60 });
    this.session.onPresence((presence) => this.#guard("presence", () => this.#onPresence(presence)));
    this.session.onSignal((signal) => this.#guard("signal", () => this.#onSignal(signal)));
    this.session.onError((error) => this.#noteError("session", error));
    this.session.start();
    this.#announce();
    this.#every(this.options.presenceIntervalMs, 0.3, () => this.#announce());
  }

  #announce() {
    if (!this.session || this.stopped) return;
    try {
      this.session.announcePresence({
        role: "viewer",
        transports: [{ type: TRANSPORT, publicKey: this.session.pubkey }],
        have: [...this.held.keys()].slice(-8),
      });
      this.counters.presenceSent += 1;
    } catch (error) {
      this.counters.publishErrors += 1;
      this.#noteError("announce", error);
    }
  }

  #sendSignal(to, type, requestId, payload = {}) {
    try {
      this.session.sendSignal(to, { type, transport: TRANSPORT, requestId, payload });
      this.counters.signalsSent += 1;
      return true;
    } catch (error) {
      this.counters.publishErrors += 1;
      this.#noteError("signal-send", error);
      return false;
    }
  }

  #hasCapacity() {
    return this.links.size + this.dials.size < this.options.maxPeers;
  }

  #coolingDown(pubkey) {
    return this.banned.has(pubkey) || (this.cooldowns.get(pubkey) || 0) > Date.now();
  }

  #onPresence({ from, payload }) {
    if (this.stopped || payload.role !== "viewer") return;
    if (!payload.transports.some((transport) => transport.type === TRANSPORT)) return;
    if (this.links.has(from) || this.dials.has(from) || this.#coolingDown(from) || !this.#hasCapacity()) return;
    // Everyone with room hears a newcomer at once; spread the dials out so
    // the newcomer is not handed more offers than it can take.
    this.#after(Math.random() * 1_500, () => {
      if (this.links.has(from) || this.dials.has(from) || this.#coolingDown(from) || !this.#hasCapacity()) return;
      if ([...this.dials.values()].filter((dial) => dial.outgoing).length >= this.options.maxDialsInFlight) return;
      return this.#dial(from);
    });
  }

  #newPeerConnection() {
    const Impl = this.options.RTCPeerConnectionImpl || globalThis.RTCPeerConnection;
    return new Impl({ iceServers: this.options.iceServers });
  }

  async #dial(pubkey) {
    const pc = this.#newPeerConnection();
    const requestId = randomRequestId();
    const dial = { pubkey, pc, requestId, outgoing: true, startedAt: now(), offerSentAt: 0 };
    this.dials.set(pubkey, dial);
    this.counters.dialsStarted += 1;
    const channel = pc.createDataChannel("relayswarm", { ordered: true });
    dial.timer = this.#after(this.options.dialTimeoutMs, () => this.#failDial(dial, "timeout"));
    channel.addEventListener("open", () => this.#guard("link-open", () => this.#linkOpened(dial, channel)));
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (this.dials.get(pubkey) !== dial) return;
      dial.offerSentAt = now();
      if (!this.#sendSignal(pubkey, "offer", requestId, { sdp: pc.localDescription.sdp })) this.#failDial(dial, "failed");
    } catch (error) {
      this.#noteError("dial", error);
      this.#failDial(dial, "failed");
    }
  }

  #failDial(dial, reason) {
    if (this.dials.get(dial.pubkey) !== dial) return;
    this.dials.delete(dial.pubkey);
    clearTimeout(dial.timer);
    this.timers.delete(dial.timer);
    try { dial.pc.close(); } catch {}
    if (reason === "timeout") this.counters.dialsTimedOut += 1;
    else if (reason === "rejected") this.counters.dialsRejected += 1;
    else if (reason !== "superseded") this.counters.dialsFailed += 1;
    if (reason !== "superseded") this.cooldowns.set(dial.pubkey, Date.now() + (reason === "rejected" ? 30_000 : 60_000));
  }

  async #onSignal({ from, payload }) {
    if (this.stopped || payload.transport !== TRANSPORT) return;
    const sdp = typeof payload.payload?.sdp === "string" ? payload.payload.sdp : "";
    if (payload.type === "answer") {
      const dial = this.dials.get(from);
      if (!dial?.outgoing || dial.requestId !== payload.requestId || !sdp) return;
      dial.answerAt = now();
      try {
        await dial.pc.setRemoteDescription({ type: "answer", sdp });
      } catch (error) {
        this.#noteError("answer", error);
        this.#failDial(dial, "failed");
      }
      return;
    }
    if (payload.type === "reject") {
      const dial = this.dials.get(from);
      if (dial?.outgoing && dial.requestId === payload.requestId) this.#failDial(dial, "rejected");
      return;
    }
    if (payload.type !== "offer" || !sdp) return;
    if (this.banned.has(from) || this.links.has(from)) return;
    const existing = this.dials.get(from);
    if (existing) {
      // Both sides dialled at once: the lower public key keeps its offer.
      if (existing.outgoing && this.session.pubkey < from) return;
      this.#failDial(existing, "superseded");
    }
    if (!this.#hasCapacity()) {
      this.counters.offersRefused += 1;
      this.#sendSignal(from, "reject", payload.requestId);
      return;
    }
    const pc = this.#newPeerConnection();
    const dial = { pubkey: from, pc, requestId: payload.requestId, outgoing: false, startedAt: now(), offerSentAt: now() };
    this.dials.set(from, dial);
    dial.timer = this.#after(this.options.dialTimeoutMs, () => this.#failDial(dial, "timeout"));
    pc.addEventListener("datachannel", (event) => {
      const channel = event.channel;
      if (channel.readyState === "open") this.#guard("link-open", () => this.#linkOpened(dial, channel));
      else channel.addEventListener("open", () => this.#guard("link-open", () => this.#linkOpened(dial, channel)));
    });
    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      if (this.dials.get(from) !== dial) return;
      if (this.#sendSignal(from, "answer", payload.requestId, { sdp: pc.localDescription.sdp })) this.counters.offersAccepted += 1;
      else this.#failDial(dial, "failed");
    } catch (error) {
      this.#noteError("offer", error);
      this.#failDial(dial, "failed");
    }
  }

  async #linkOpened(dial, channel) {
    if (this.dials.get(dial.pubkey) !== dial || this.stopped) {
      try { dial.pc.close(); } catch {}
      return;
    }
    this.dials.delete(dial.pubkey);
    clearTimeout(dial.timer);
    this.timers.delete(dial.timer);
    if (dial.outgoing) this.counters.dialsAccepted += 1;
    this.counters.linksOpened += 1;
    if (dial.offerSentAt) pushSample(this.signallingSamples, now() - dial.offerSentAt);
    const link = new PeerLink({
      pubkey: dial.pubkey,
      pc: dial.pc,
      channel,
      maxSegmentBytes: this.options.maxSegmentBytes,
      onRequest: (from, key) => this.#serveRequest(from, key),
      onHaveChange: (_link, added) => {
        for (const waiter of [...this.haveWaiters]) waiter(added);
      },
      onClose: (closed) => {
        if (this.links.get(closed.pubkey) === closed) {
          this.links.delete(closed.pubkey);
          this.counters.linksClosed += 1;
        }
      },
    });
    this.links.set(dial.pubkey, link);
    if (this.#servingAllowed()) link.sendHave([...this.held.keys()]);
    const pair = await candidatePairTypes(dial.pc);
    this.pairTypes[pair] = (this.pairTypes[pair] || 0) + 1;
    for (const waiter of [...this.haveWaiters]) waiter();
  }
}
