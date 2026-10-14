// Peer-assisted live HLS for hls.js: shadow measurement and authenticated
// peer-first loading with a bounded wait before the original HTTP loader.
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
//   - shadow mode keeps the original loader in the playback path.
//   - peer-first bytes reach the player only after signature and hash checks.
//   - upload is capped in peers and bytes per second, and off on cellular
//     connections by default.
//   - stop() restores the original loader and closes every socket and peer.
//
// Peers rotate rather than refusing flatly once they are full: a viewer that
// joins an hour into a stream would otherwise meet nothing but full peers and
// play from the origin for ever, which is the failure that makes peer-assist
// look useless exactly when an audience is growing.

import { generateSecretKey } from "nostr-tools/pure";
import { RelayPool, RelaySwarmSession, validTicket } from "../relay-session.mjs";
import { PeerLink } from "./peer-link.mjs";
import { PeerSelection } from "./peer-selection.mjs";
import { boundedOperation } from "./bounded-operation.mjs";
import { validStreamAuthorisation, verifySegmentCommitment, segmentMediaContext } from "./segment-commitment.mjs";

export const HLS_SWARM_METRICS_VERSION = 2;

const TRANSPORT = "webrtc";
const DEFAULTS = Object.freeze({
  mode: "shadow",
  originFallbackMs: 1_500,
  originReserveMs: 2_000,
  lateWindowMs: 6_000,
  maxPeers: 6,
  maxUploadPeers: 4,
  maxUploadBytesPerSecond: 1_250_000,
  maxUploadBytesPerSession: undefined,
  maxDialsInFlight: 2,
  dialTimeoutMs: 12_000,
  presenceIntervalMs: 20_000,
  metricsIntervalMs: 10_000,
  maxHeldSegments: 12,
  maxHeldBytes: 64 * 1024 * 1024,
  maxSegmentBytes: 16 * 1024 * 1024,
  shadowSampleRate: 0.25,
  maxConcurrentRaces: 24,
  admissionTimeoutMs: 3_000,
  swarmParts: false,
  serveOnCellular: false,
  // Contribution requires explicit host opt-in. Connection type detection is
  // advisory and unavailable in some browsers, including Safari.
  serve: false,
  // Admission. `ticket` is what this viewer presents (in its presence and in
  // every offer and answer); `admit(pubkey, ticket)` is the host page's check
  // on everyone else's. With `admit` set, a viewer never dials, answers or
  // refers a peer it has not admitted, so its address (which the SDP carries)
  // only ever reaches ticket holders. Both are opaque to the swarm.
  ticket: undefined,
  admit: undefined,
  // Rotation. A link is only ever dropped for a newcomer when it has been
  // useless in both directions for idleEvictMs, has lived at least
  // minLinkLifeMs (so a link that just opened, including one a newcomer was
  // just given, is safe), and is not mid-transfer. One drop per
  // evictionCooldownMs bounds churn however many offers arrive.
  minLinkLifeMs: 15_000,
  idleEvictMs: 20_000,
  evictionCooldownMs: 10_000,
  // What a refused newcomer is told: come back in this long, and try these.
  retryFloorMs: 4_000,
  retryCeilingMs: 45_000,
  maxRetriesPerPeer: 3,
  maxReferrals: 2,
  // A newcomer hears "I have room" sooner than the next beacon, without the
  // swarm turning churn into a relay storm.
  reannounceDebounceMs: 4_000,
  minReannounceGapMs: 12_000,
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

function gathered(pc, capMs = 1_200, signal) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete" || signal?.aborted) return resolve();
    const finish = () => {
      clearTimeout(cap);
      pc.removeEventListener("icegatheringstatechange", changed);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const changed = () => { if (pc.iceGatheringState === "complete") finish(); };
    const cap = setTimeout(finish, capMs);
    pc.addEventListener("icegatheringstatechange", changed);
    signal?.addEventListener("abort", finish, { once: true });
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
 * The link to drop for a newcomer, or null. Idle longest wins: a peer that has
 * given nothing and taken nothing for `idleEvictMs` is the one least likely to
 * be useful next. Bytes served would favour whoever joined first, which is the
 * very bias that starves late joiners. A link mid-transfer, one younger than
 * `minLinkLifeMs` (including the one a newcomer was just given) and a banned
 * one are never candidates.
 *
 * Exported for tests; the swarm calls it with its own links.
 */
export function rotationCandidate(links, { minLinkLifeMs, idleEvictMs, banned = new Set() } = {}, at = Date.now()) {
  let worst = null;
  for (const link of links) {
    if (link.transferring || banned.has(link.pubkey)) continue;
    if (at - link.openedAt < minLinkLifeMs) continue;
    if (at - link.lastUsefulAt < idleEvictMs) continue;
    if (!worst || link.lastUsefulAt < worst.lastUsefulAt) worst = link;
  }
  return worst;
}

/**
 * How long a refused newcomer should wait: the sooner of this viewer's churn
 * budget and the moment its nearest link becomes rotatable, clamped so a peer
 * can neither spin nor be parked for ever.
 */
export function retryAfterFor(links, options, lastEvictionAt = 0, at = Date.now()) {
  const churnWait = Math.max(0, options.evictionCooldownMs - (at - lastEvictionAt));
  let candidateWait = options.retryCeilingMs;
  for (const link of links) {
    const wait = Math.max(
      options.minLinkLifeMs - (at - link.openedAt),
      options.idleEvictMs - (at - link.lastUsefulAt),
      0,
    );
    candidateWait = Math.min(candidateWait, wait);
  }
  return Math.min(options.retryCeilingMs, Math.max(options.retryFloorMs, churnWait, candidateWait));
}

/**
 * A refusal as received. Adversarial input: another peer could name a silly
 * wait or a list of strangers, so both are bounded before they are believed.
 */
export function readRefusal(payload, options) {
  const raw = Number(payload?.retryAfterMs);
  const retryAfterMs = Number.isFinite(raw)
    ? Math.min(options.retryCeilingMs, Math.max(options.retryFloorMs, raw))
    : options.retryFloorMs;
  const referrals = Array.isArray(payload?.referrals)
    ? payload.referrals.filter((key) => typeof key === "string" && /^[0-9a-f]{64}$/u.test(key)).slice(0, options.maxReferrals)
    : [];
  return { retryAfterMs, referrals };
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
    this.lifecycle = new AbortController();
    this.admissionChecks = new Map();
    this.dialChecks = new Set();
    this.hls = null;
    this.originalFragmentLoader = undefined;
    this.pool = null;
    this.session = null;
    this.timers = new Set();
    this.links = new Map();
    this.peerSelection = new PeerSelection();
    this.dials = new Map();
    this.cooldowns = new Map();
    this.retries = new Map();
    this.openPeers = new Map();
    this.lastEvictionAt = 0;
    this.lastAnnouncedAt = 0;
    this.reannounceTimer = null;
    this.banned = new Set();
    this.admitted = new Map();
    this.held = new Map();
    this.heldBytes = 0;
    this.races = new Set();
    this.haveWaiters = new Set();
    this.rendition = null;
    this.renditions = new Map();
    this.originFetches = new Map();
    this.uploadTokens = this.options.maxUploadBytesPerSecond;
    this.uploadRefilledAt = now();
    this.counters = {
      originLoaded: 0,
      sampledOriginBytes: 0,
      peerInTimeBytes: 0,
      peerFirstLoaded: 0,
      peerFirstBytes: 0,
      originFallbacks: 0,
      coordinatedWaits: 0,
      coordinatedPeerLoads: 0,
      commitmentRequests: 0,
      commitmentRejected: 0,
      commitmentUnavailable: 0,
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
      admitRefused: 0,
      evicted: 0,
      evictionsUnavailable: 0,
      retriesScheduled: 0,
      referralsSent: 0,
      referralsFollowed: 0,
      linksOpened: 0,
      linksClosed: 0,
      presenceSent: 0,
      signalsSent: 0,
      publishErrors: 0,
      errors: 0,
    };
    // How long this viewer played before the swarm was any use to it: the
    // number that says whether joining late is a disadvantage.
    this.firstLinkAtMs = null;
    this.firstPeerSegmentAtMs = null;
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
    try {
      for (const value of relays) {
        const url = new URL(value);
        if (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return "invalid-relays";
      }
    } catch { return "invalid-relays"; }
    if (mode === "off") return "mode-off";
    if (mode !== "shadow" && mode !== "peer-first") return "invalid-mode";
    if (mode === "peer-first" && !validStreamAuthorisation(this.options.streamEvent)) return "invalid-stream-authorisation";
    if (mode === "peer-first" && typeof this.options.getCommitment !== "function") return "missing-commitment-provider";
    if (this.options.admit !== undefined && typeof this.options.admit !== "function") return "invalid-admit";
    if (this.options.reserveUploadBytes !== undefined && typeof this.options.reserveUploadBytes !== "function") return "invalid-upload-reservation";
    if (typeof this.options.serve !== "boolean" || typeof this.options.serveOnCellular !== "boolean") return "invalid-serve-option";
    if (this.options.ticket !== undefined && !validTicket(this.options.ticket)) return "invalid-ticket";
    if (this.options.maxUploadBytesPerSession !== undefined && (!Number.isSafeInteger(this.options.maxUploadBytesPerSession) || this.options.maxUploadBytesPerSession < 0)) return "invalid-upload-session-limit";
    for (const key of ["originFallbackMs", "originReserveMs", "lateWindowMs", "maxPeers", "maxUploadPeers", "maxUploadBytesPerSecond", "maxDialsInFlight", "dialTimeoutMs", "presenceIntervalMs", "metricsIntervalMs", "maxHeldSegments", "maxHeldBytes", "maxSegmentBytes", "maxConcurrentRaces", "admissionTimeoutMs"]) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1) return "invalid-limits";
    }
    if (!Number.isFinite(this.options.shadowSampleRate) || this.options.shadowSampleRate < 0 || this.options.shadowSampleRate > 1) return "invalid-sample-rate";
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
      const BaseLoader = hls.config.fLoader || hls.config.loader;
      hls.config.fLoader = this.options.mode === "peer-first" ? this.#peerFirstLoader(BaseLoader) : this.#shadowLoader(BaseLoader);
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
    this.lifecycle.abort();
    this.admissionChecks.clear();
    this.admitted.clear();
    this.dialChecks.clear();
    for (const race of this.races) { race.settled = true; race.controller.abort(); }
    this.races.clear();
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
    this.originFetches.clear();
    this.renditions.clear();
    try { this.session?.close(); } catch {}
    try { this.pool?.close(); } catch {}
    try { this.options.onMetrics?.(this.metrics()); } catch {}
  }

  metrics() {
    const c = this.counters;
    const shadow = this.options.mode === "shadow";
    const resolved = shadow ? c.peerInTime + c.peerLate + c.peerMiss + c.peerCorrupt : 0;
    const sampled = resolved + c.noPeers;
    const share = (part, total) => total ? Number((part / total).toFixed(3)) : null;
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
        admitRefused: c.admitRefused,
        evicted: c.evicted,
        evictionsUnavailable: c.evictionsUnavailable,
        retriesScheduled: c.retriesScheduled,
        referralsSent: c.referralsSent,
        referralsFollowed: c.referralsFollowed,
        openPeersKnown: this.#openPeerKeys().length,
        linksOpened: c.linksOpened,
        linksClosed: c.linksClosed,
        banned: this.banned.size,
        firstLinkAtMs: this.firstLinkAtMs,
        candidatePairs: { ...this.pairTypes },
        deliveryMeasurements: [...this.links.values()].map((link) => ({ pubkey: link.pubkey, ...this.peerSelection.summary(link) })),
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
        inTimeShare: share(c.peerInTime, resolved),
        sampledInTimeShare: share(c.peerInTime, sampled),
        observedInTimeShare: shadow ? share(c.peerInTime, c.originLoaded) : null,
        sampledInTimeByteShare: share(c.peerInTimeBytes, c.sampledOriginBytes),
        observedInTimeByteShare: shadow ? share(c.peerInTimeBytes, c.bytesFromOrigin) : null,
        peerFirstShare: shadow ? null : share(c.peerFirstLoaded, c.peerFirstLoaded + c.originLoaded),
        peerFirstByteShare: shadow ? null : share(c.peerFirstBytes, c.peerFirstBytes + c.bytesFromOrigin),
        peerFirstLoaded: c.peerFirstLoaded,
        originFallbacks: c.originFallbacks,
        coordinatedWaits: c.coordinatedWaits,
        coordinatedPeerLoads: c.coordinatedPeerLoads,
        commitmentRequests: c.commitmentRequests,
        commitmentRejected: c.commitmentRejected,
        commitmentUnavailable: c.commitmentUnavailable,
        firstPeerSegmentAtMs: this.firstPeerSegmentAtMs,
        peerLatencyMedianMs: percentile(this.peerLatencySamples, 0.5),
        peerLatencyP90Ms: percentile(this.peerLatencySamples, 0.9),
        originLatencyMedianMs: percentile(this.originLatencySamples, 0.5),
      },
      bytes: {
        fromOrigin: c.bytesFromOrigin,
        fromPeers: c.bytesFromPeers,
        peerFirst: c.peerFirstBytes,
        uploaded: c.bytesUploaded,
        uploadsServed: c.uploadsServed,
        uploadsRefused: c.uploadsRefused,
        uploadRemaining: this.#uploadRemaining(),
        uploadExhausted: this.#uploadRemaining() === 0,
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
        originReserveMs: this.options.originReserveMs,
        lateWindowMs: this.options.lateWindowMs,
        maxPeers: this.options.maxPeers,
        maxUploadPeers: this.options.maxUploadPeers,
        maxUploadBytesPerSecond: this.options.maxUploadBytesPerSecond,
        maxUploadBytesPerSession: Number.isSafeInteger(this.options.maxUploadBytesPerSession) && this.options.maxUploadBytesPerSession >= 0 ? this.options.maxUploadBytesPerSession : null,
        serve: this.options.serve === true,
        admit: typeof this.options.admit === "function",
        shadowSampleRate: this.options.shadowSampleRate,
        minLinkLifeMs: this.options.minLinkLifeMs,
        idleEvictMs: this.options.idleEvictMs,
        evictionCooldownMs: this.options.evictionCooldownMs,
        relays: Array.isArray(this.options.relays) ? [...this.options.relays] : [],
      },
    };
  }

  // --- guards and timers ----------------------------------------------------

  #noteError(stage, _error) {
    if (this.stopped) return;
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
        try { fn(); } finally { schedule(); }
      });
    };
    schedule();
  }

  // --- the player side ------------------------------------------------------

  #peerFirstLoader(BaseLoader) {
    const swarm = this;
    return class RelaySwarmPeerFirstLoader {
      static relayswarmShadow = true;
      constructor(config) {
        this.inner = new BaseLoader(config);
        this.active = null;
        this.peerStats = null;
        this.peerContext = null;
        this.pendingCallbacks = null;
      }
      get stats() { return this.peerStats || this.inner.stats; }
      get context() { return this.peerContext || this.inner.context; }
      load(context, config, callbacks) {
        this.abort();
        this.releaseFetch = null;
        this.peerStats = null;
        this.peerContext = context;
        const budgetMs = swarm.#peerBudget(context);
        swarm.#contributionContext(context);
        if (swarm.stopped || !context.frag || context.frag.sn === "initSegment" || (context.part && !swarm.options.swarmParts)
          || (!swarm.options.serveOnCellular && onCellular())) return this.inner.load(context, config, callbacks);
        const controller = new AbortController();
        const token = {};
        this.active = token;
        const t0 = now();
        // hls.js assigns frag.stats before calling load(). Preserve that
        // reference for the peer path, including aborts and ABR estimates.
        Object.assign(this.inner.stats, { aborted: false, loaded: 0, total: 0, chunkCount: 0, bwEstimate: 0,
          loading: { start: t0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } });
        this.pendingCallbacks = { callbacks, context };
        let timer;
        const cleanup = () => {
          clearTimeout(timer);
          swarm.lifecycle.signal.removeEventListener("abort", fallback);
        };
        this.cancel = () => {
          const pending = this.active === token;
          this.active = null;
          cleanup();
          controller.abort();
          return pending;
        };
        const fallback = () => {
          if (this.active !== token) return;
          this.active = null;
          this.pendingCallbacks = null;
          cleanup();
          controller.abort();
          swarm.counters.originFallbacks += 1;
          // The unused hls.js loader requires a zero start timestamp on its
          // first load. Its normal HTTP statistics replace the pending wait.
          this.inner.stats.loading.start = 0;
          // Fallback delegates errors, retries and progressive loading to the
          // host's original loader. Only one path can call the player back.
          const originStarted = now();
          let completed = false;
          swarm.#segmentKey(context).then((key) => {
            if (!completed && !swarm.stopped) this.releaseFetch = swarm.#claimOrigin(key);
          }).catch(() => {});
          const finishOrigin = () => { completed = true; this.releaseFetch?.(); this.releaseFetch = null; };
          this.inner.load(context, config, {
            ...callbacks,
            onError: (...args) => { finishOrigin(); callbacks.onError?.(...args); },
            onTimeout: (...args) => { finishOrigin(); callbacks.onTimeout?.(...args); },
            onAbort: (...args) => { finishOrigin(); callbacks.onAbort?.(...args); },
            onSuccess: (response, stats, ctx, details) => {
              let copy = null;
              try { if (response.data?.byteLength) copy = response.data.slice(0); } catch {}
              completed = true;
              pushSample(swarm.originLatencySamples, now() - originStarted);
              callbacks.onSuccess(response, stats, ctx, details);
              if (copy && !swarm.stopped) swarm.#guard("peer-first-origin", async () => {
                swarm.counters.originLoaded += 1;
                swarm.counters.bytesFromOrigin += copy.byteLength;
                try {
                  const key = await swarm.#segmentKey(context);
                  if (!swarm.stopped) swarm.#hold(key, new Uint8Array(copy));
                } finally { finishOrigin(); }
              });
              else finishOrigin();
            },
          });
        };
        if (budgetMs === 0) return fallback();
        timer = setTimeout(fallback, budgetMs);
        swarm.lifecycle.signal.addEventListener("abort", fallback, { once: true });
        swarm.#peerFirst(context, controller.signal, t0 + budgetMs).then((result) => {
          if (this.active !== token || controller.signal.aborted || swarm.stopped) return;
          if (!result || now() >= t0 + budgetMs) return fallback();
          this.active = null;
          this.pendingCallbacks = null;
          cleanup();
          const end = now();
          const size = result.bytes.byteLength;
          this.peerStats = this.inner.stats;
          Object.assign(this.peerStats, {
            aborted: false, loaded: size, total: size, chunkCount: 1,
            bwEstimate: size * 8_000 / Math.max(1, end - t0),
            loading: { start: t0, first: end, end },
            parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 },
          });
          swarm.counters.peerFirstLoaded += 1;
          swarm.counters.peerFirstBytes += size;
          swarm.counters.bytesFromPeers += size;
          if (swarm.firstPeerSegmentAtMs === null) swarm.firstPeerSegmentAtMs = Date.now() - swarm.startedAt;
          pushSample(swarm.peerLatencySamples, end - t0);
          swarm.#hold(result.key, result.bytes.slice());
          callbacks.onSuccess({ url: context.url, data: result.bytes.buffer, code: 200 }, this.peerStats, context, null);
        }).catch((error) => {
          if (this.active === token) {
            swarm.#noteError("peer-first", error);
            fallback();
          }
        });
      }
      abort() {
        this.releaseFetch?.(); this.releaseFetch = null;
        const pending = this.cancel?.();
        if (pending && this.pendingCallbacks) {
          const { callbacks, context } = this.pendingCallbacks;
          this.pendingCallbacks = null;
          this.inner.stats.aborted = true;
          swarm.counters.aborted += 1;
          callbacks.onAbort?.(this.inner.stats, context, null);
        } else this.inner.abort();
      }
      destroy() { this.releaseFetch?.(); this.releaseFetch = null; this.cancel?.(); this.pendingCallbacks = null; this.inner.destroy(); }
      getCacheAge() { return this.peerStats ? null : this.inner.getCacheAge?.() ?? null; }
      getResponseHeader(name) { return this.peerStats ? null : this.inner.getResponseHeader?.(name) ?? null; }
    };
  }

  #renditionContext(context) {
    const media = segmentMediaContext(context);
    return media ? `${media.mediaType}:${media.playlist}` : `${context.frag.type || "main"}:${context.frag.level}`;
  }

  #contributionContext(context) {
    if (this.stopped || !context.frag || context.frag.sn === "initSegment") return;
    const rendition = this.#renditionContext(context);
    const previous = this.renditions.get(rendition);
    for (const [identity, seen] of this.renditions) if (seen < Date.now() - 30_000) this.renditions.delete(identity);
    if (!this.renditions.has(rendition) && this.renditions.size >= 8) this.renditions.delete(this.renditions.keys().next().value);
    this.renditions.set(rendition, Date.now());
    this.rendition = rendition;
    if (!previous) for (const link of this.links.values()) link.sendContribution(this.#servingAllowed(), rendition);
  }

  #shouldWaitForOrigin(key, rendition) {
    const candidates = [...this.links.values()].filter((peer) => !peer.closed && peer.contribution?.serving
      && (peer.renditions.get(rendition) || 0) > Date.now() - 30_000);
    if (!candidates.length) return false;
    if (candidates.some((peer) => (peer.fetching.get(key) || 0) > Date.now())) return true;
    if (!this.#servingAllowed()) return true;
    // Per-object rendezvous ordering spreads origin seed work across serving
    // viewers. Different neighbourhoods can still seed duplicates safely.
    const rank = (pubkey) => [...pubkey].map((digit, i) => (parseInt(digit, 16) ^ parseInt(key[i], 16)).toString(16)).join("");
    return candidates.some((peer) => rank(peer.pubkey) < rank(this.session.pubkey));
  }

  #claimOrigin(key) {
    if (!this.#servingAllowed() || this.originFetches.size >= this.options.maxConcurrentRaces) return () => {};
    const count = this.originFetches.get(key) || 0;
    this.originFetches.set(key, count + 1);
    for (const link of this.links.values()) link.sendFetching(key, 2000);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.originFetches.get(key) || 1) - 1;
      if (remaining > 0) this.originFetches.set(key, remaining);
      else {
        this.originFetches.delete(key);
        for (const link of this.links.values()) link.sendFetching(key, 0);
      }
    };
  }

  #peerBudget(context) {
    const media = this.hls?.media;
    if (!media) return this.options.originFallbackMs;
    try {
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) > media.currentTime) {
          // Leave measured origin recovery time and a reserve for appending.
          // A newly selected ABR rendition uses its fragment's actual playback
          // position, rather than borrowing an unrelated long buffer tail.
          const originReserve = Math.max(this.options.originReserveMs, (percentile(this.originLatencySamples, 0.9) || 0) * 1.25 + 100);
          // A later LL-HLS part has its own playback position. Using the
          // parent's start discards already buffered earlier parts and can
          // reduce every safe peer opportunity to a zero-length budget.
          const fragStart = context?.part?.start ?? context?.frag?.start;
          const playableEnd = Number.isFinite(fragStart) && fragStart > media.currentTime ? Math.min(media.buffered.end(i), fragStart) : media.buffered.end(i);
          return Math.min(this.options.originFallbackMs, Math.max(0, (playableEnd - media.currentTime) * 1000 - originReserve));
        }
      }
    } catch {}
    return 0;
  }

  async #segmentKey(context) {
    const raw = (this.options.segmentKey || defaultSegmentKey)(context.url || context.frag.url, context);
    if (typeof raw !== "string" || !raw) throw new Error("Invalid segment key.");
    const range = context.rangeEnd ? `#${context.rangeStart || 0}-${context.rangeEnd}` : "";
    return sha256Hex(utf8.encode(`${this.options.swarmId}\n${raw}${range}`));
  }

  async #peerFirst(context, signal, deadline) {
    const key = await this.#segmentKey(context);
    if (signal.aborted || this.stopped) return null;
    const rendition = this.#renditionContext(context);
    const coordinated = ![...this.links.values()].some((peer) => peer.have.has(key));
    if (coordinated) {
      if (!this.#shouldWaitForOrigin(key, rendition)) return null;
      this.counters.coordinatedWaits += 1;
      // No playlist manipulation or origin prefetch. The elected contributor
      // loads normally; all advisory leases expire before the HTTP deadline.
      while (!signal.aborted && !this.stopped && now() < deadline && ![...this.links.values()].some((peer) => peer.have.has(key))) {
        if (!this.#shouldWaitForOrigin(key, rendition)) return null;
        await this.#waitForHave(key, Math.min(100, deadline - now()), signal);
      }
      if (signal.aborted || this.stopped || now() >= deadline) return null;
    }
    let commitment;
    try {
      this.counters.commitmentRequests += 1;
      const event = await boundedOperation((operationSignal) => this.options.getCommitment(context, { signal: operationSignal }), signal, Math.max(1, deadline - now()));
      commitment = verifySegmentCommitment(event, {
        streamEvent: this.options.streamEvent, swarmId: this.options.swarmId, key, context,
        maxSegmentBytes: this.options.maxSegmentBytes,
        delegation: this.options.delegation, revokedDelegationIds: this.options.revokedDelegationIds, delegationRevocations: this.options.delegationRevocations,
      });
    } catch { if (!this.stopped) this.counters.commitmentUnavailable += 1; return null; }
    if (!commitment) { this.counters.commitmentRejected += 1; return null; }
    if (signal.aborted || this.stopped) return null;
    const tried = new Set();
    while (!signal.aborted && !this.stopped && now() < deadline && tried.size < this.options.maxPeers) {
      const link = this.peerSelection.select(this.links.values(), key, tried, commitment.size, deadline - now());
      if (!link) {
        if (![...this.links.values()].some((peer) => !peer.closed && !tried.has(peer.pubkey) && peer.have.has(key)
          && (this.peerSelection.estimate(peer, commitment.size) === null || this.peerSelection.estimate(peer, commitment.size) * 1.25 + 25 <= deadline - now()))) return null;
        await this.#waitForHave(key, Math.min(100, deadline - now()), signal);
        continue;
      }
      tried.add(link.pubkey);
      const requestedAt = now();
      const alternatives = [...this.links.values()].filter((peer) => !peer.closed && !peer.busy && !tried.has(peer.pubkey) && peer.have.has(key)).length;
      const remainingMs = deadline - now();
      const estimateMs = this.peerSelection.estimate(link, commitment.size);
      // A measured delivery that fits the original origin deadline must not
      // be cut short by an equal share intended for unmeasured alternatives.
      const attemptMs = Math.min(remainingMs, Math.max(25, remainingMs / Math.min(3, alternatives + 1), estimateMs === null ? 0 : estimateMs * 1.25 + 25));
      const bytes = await link.request(key, Math.max(1, attemptMs), { signal, expectedSize: commitment.size });
      if (!bytes || signal.aborted || this.stopped) {
        if (!signal.aborted && !this.stopped) this.peerSelection.record(link, now() - requestedAt);
        continue;
      }
      const digest = await sha256Hex(bytes);
      if (signal.aborted || this.stopped) return null;
      if (bytes.byteLength !== commitment.size || digest !== commitment.sha256) {
        this.peerSelection.record(link, now() - requestedAt);
        this.counters.peerCorrupt += 1;
        this.banned.add(link.pubkey);
        link.close();
        continue;
      }
      if (commitment.expiresAt <= Math.floor(Date.now() / 1000)) return null;
      this.peerSelection.record(link, now() - requestedAt, bytes.byteLength);
      if (coordinated) this.counters.coordinatedPeerLoads += 1;
      return { key, bytes };
    }
    return null;
  }

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
        swarm.#contributionContext(context);
        const race = swarm.#beginRace(context);
        this.race = race;
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
            race.originSucceeded = true;
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

      abort() { if (this.race) swarm.#originFailed(this.race); return this.inner.abort(); }
      destroy() { if (this.race && !this.race.originSucceeded && !this.race.originDone) swarm.#originFailed(this.race); return this.inner.destroy(); }
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
      if (this.stopped || this.races.size >= this.options.maxConcurrentRaces) return null;
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
        controller: new AbortController(),
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
    race.keyPromise = sha256Hex(utf8.encode(race.keyText));
    race.key = await race.keyPromise;
    if (this.stopped) return;
    if (!race.sampled || (!this.options.serveOnCellular && onCellular())) {
      race.peerDone = true;
      race.skipPeers = true;
      return this.#guard("settle", () => this.#settle(race));
    }
    const deadline = race.t0 + this.options.lateWindowMs;
    const tried = new Set();
    let sawPeer = race.peersAtStart > 0;
    while (!this.stopped && !race.settled && !race.originFailed && now() < deadline) {
      if (this.links.size) sawPeer = true;
      const link = this.peerSelection.select(this.links.values(), race.key, tried);
      if (!link) {
        await this.#waitForHave(race.key, deadline - now(), race.controller.signal);
        continue;
      }
      tried.add(link.pubkey);
      const requestedAt = now();
      const bytes = await link.request(race.key, deadline - now(), { signal: race.controller.signal });
      if (bytes && !this.stopped) {
        race.requestMs = now() - requestedAt;
        race.peerBytes = bytes;
        race.peerAt = now();
        race.peerLink = link;
        break;
      }
      if (!race.controller.signal.aborted && !this.stopped) this.peerSelection.record(link, now() - requestedAt);
    }
    race.peerDone = true;
    race.sawPeer = sawPeer || this.links.size > 0;
    this.#guard("settle", () => this.#settle(race));
  }

  #waitForHave(key, timeoutMs, signal) {
    return new Promise((resolve) => {
      let timer = null;
      const waiter = (added) => {
        if (added && !added.includes(key)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.haveWaiters.delete(waiter);
        resolve();
      };
      const cancel = () => waiter();
      if (signal?.aborted) return resolve();
      signal?.addEventListener("abort", cancel, { once: true });
      timer = setTimeout(waiter, Math.max(0, Math.min(timeoutMs, 1_000)));
      this.haveWaiters.add(waiter);
    });
  }

  async #originLoaded(race, buffer) {
    if (this.stopped || race.originFailed) return;
    const bytes = new Uint8Array(buffer);
    const t1 = now();
    this.counters.originLoaded += 1;
    this.counters.bytesFromOrigin += bytes.byteLength;
    race.originBytes = bytes.byteLength;
    pushSample(this.originLatencySamples, t1 - race.t0);
    race.originDigest = await sha256Hex(bytes);
    race.originDone = true;
    await race.keyPromise;
    if (this.stopped) return;
    this.#hold(race.key, bytes);
    this.#guard("settle", () => this.#settle(race));
  }

  #originFailed(race) {
    if (race.settled || race.originDone) return;
    race.controller.abort();
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
    c.sampledOriginBytes += race.originBytes || 0;
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
      this.peerSelection.record(race.peerLink, race.requestMs);
      c.peerCorrupt += 1;
      this.banned.add(race.peerLink.pubkey);
      race.peerLink.close();
      return;
    }
    const latency = race.peerAt - race.t0;
    this.peerSelection.record(race.peerLink, race.requestMs, race.peerBytes.byteLength);
    if (this.firstPeerSegmentAtMs === null) this.firstPeerSegmentAtMs = Date.now() - this.startedAt;
    pushSample(this.peerLatencySamples, latency);
    c.bytesFromPeers += race.peerBytes.byteLength;
    if (latency <= this.options.originFallbackMs) { c.peerInTime += 1; c.peerInTimeBytes += race.peerBytes.byteLength; }
    else c.peerLate += 1;
  }

  // --- held segments and upload --------------------------------------------

  #hold(key, bytes) {
    if (!this.#servingAllowed() || this.held.has(key) || bytes.byteLength > this.options.maxSegmentBytes) return;
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
    return !this.stopped && !this.disabledReason && this.options.serve === true && this.#uploadRemaining() !== 0 && (this.options.serveOnCellular || !onCellular());
  }

  #uploadRemaining() {
    const limit = this.options.maxUploadBytesPerSession;
    return !Number.isSafeInteger(limit) || limit < 0 ? null : Math.max(0, limit - this.counters.bytesUploaded);
  }

  #withdrawContribution() {
    this.held.clear();
    this.heldBytes = 0;
    for (const link of this.links.values()) { link.sendHave([]); link.sendContribution(false, this.rendition); }
    this.#announce();
  }

  async #serveRequest(link, key) {
    if (this.options.admit && !(await this.#admits(link.pubkey, this.admitted.get(link.pubkey)?.ticket))) {
      this.counters.uploadsRefused += 1;
      link.close();
      return null;
    }
    const bytes = this.held.get(key);
    if (!bytes || !this.#servingAllowed() || this.banned.has(link.pubkey)) {
      this.counters.uploadsRefused += 1;
      return null;
    }
    const remaining = this.#uploadRemaining();
    if (remaining !== null && bytes.byteLength > remaining) {
      this.counters.uploadsRefused += 1;
      return null;
    }
    const recentUploaders = [...this.links.values()].filter((candidate) => candidate !== link && (candidate.outboundInFlight > 0 || Date.now() - candidate.lastServedAt < 30_000)).length;
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
    this.counters.bytesUploaded += bytes.byteLength;
    // Reserve the full accepted payload before PeerLink can yield. Interrupted
    // uploads keep their reservation, so concurrent requests cannot overspend.
    if (this.#uploadRemaining() === 0) this.#withdrawContribution();
    if (this.options.reserveUploadBytes) {
      let accepted = false;
      try { accepted = await boundedOperation((signal) => this.options.reserveUploadBytes(bytes.byteLength, { signal }), this.lifecycle.signal, this.options.admissionTimeoutMs) === true; }
      catch { this.#noteError("upload-reservation"); }
      if (!accepted || this.stopped || link.closed || this.options.serve !== true || (!this.options.serveOnCellular && onCellular())) {
        if (!accepted) this.counters.bytesUploaded -= bytes.byteLength;
        this.counters.uploadsRefused += 1;
        return null;
      }
    }
    this.counters.uploadsServed += 1;
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
        have: this.#servingAllowed() ? [...this.held.keys()].slice(-8) : [],
        open: this.#canTakeAnotherPeer(),
        ...(this.#ownTicket() ? { ticket: this.#ownTicket() } : {}),
      });
      this.counters.presenceSent += 1;
      for (const [identity, seen] of this.renditions) {
        if (seen < Date.now() - 30_000) { this.renditions.delete(identity); continue; }
        for (const link of this.links.values()) link.sendContribution(this.#servingAllowed(), identity);
      }
      this.lastAnnouncedAt = Date.now();
    } catch (error) {
      this.counters.publishErrors += 1;
      this.#noteError("announce", error);
    }
  }

  /**
   * Say so once a slot has opened, rather than leaving a newcomer to wait for
   * the next beacon. Debounced, and never more often than minReannounceGapMs,
   * so a burst of churn is still one extra event.
   */
  #scheduleReannounce() {
    if (this.stopped || !this.session || this.reannounceTimer) return;
    const sinceLast = Date.now() - this.lastAnnouncedAt;
    const wait = Math.max(this.options.reannounceDebounceMs, this.options.minReannounceGapMs - sinceLast);
    this.reannounceTimer = this.#after(wait, () => {
      this.reannounceTimer = null;
      this.#announce();
    });
  }

  // --- rotation -------------------------------------------------------------

  #rememberOpen(pubkey, open) {
    this.openPeers.set(pubkey, { open, at: Date.now() });
    if (this.openPeers.size > 64) this.openPeers.delete(this.openPeers.keys().next().value);
  }

  /** Peers that said they had room recently, newest first. */
  #openPeerKeys() {
    const cutoff = Date.now() - 60_000;
    return [...this.openPeers.entries()]
      .filter(([pubkey, seen]) => seen.open && seen.at >= cutoff && !this.banned.has(pubkey))
      .sort((a, b) => b[1].at - a[1].at)
      .map(([pubkey]) => pubkey);
  }

  #rotationCandidate() {
    return rotationCandidate(this.links.values(), { ...this.options, banned: this.banned });
  }

  /** Room now, or a rotation a caller with no peers at all could trigger. */
  #canTakeAnotherPeer() {
    return this.#hasCapacity() || (this.links.size >= 2 && Boolean(this.#rotationCandidate()));
  }

  /**
   * Rotate only for a caller with no peers at all, and only while we would
   * still be left with a link of our own. Measured on a swarm whose viewers
   * hold two links each, rotating for anyone who asked cost late joiners far
   * more than it won: an evicted peer re-dials at once and displaces a third,
   * and the cascade leaves everybody re-connecting instead of fetching. A
   * viewer topping up from one peer to two can wait for a free slot; a viewer
   * with none is the case this exists for.
   *
   * The count comes from the caller, who could of course claim to have none.
   * What that buys is one rotation per evictionCooldownMs, of a link that was
   * idle anyway - the same thing an honest newcomer gets, and bounded by the
   * same budget.
   */
  #evictForOffer(askerPeers) {
    if (askerPeers !== 0) return null;
    if (this.links.size < 2) return null;
    if (Date.now() - this.lastEvictionAt < this.options.evictionCooldownMs) return null;
    const link = this.#rotationCandidate();
    if (!link) return null;
    this.lastEvictionAt = Date.now();
    this.counters.evicted += 1;
    link.close();
    return link;
  }

  /** What a refused newcomer is told: when to come back, and who else to ask. */
  #refusalPayload(asker) {
    const retryAfterMs = retryAfterFor(this.links.values(), this.options, this.lastEvictionAt);
    const referrals = this.#openPeerKeys().filter((pubkey) => pubkey !== asker).slice(0, this.options.maxReferrals);
    if (referrals.length) this.counters.referralsSent += referrals.length;
    return { retryAfterMs, referrals };
  }

  #sendSignal(to, type, requestId, payload = {}) {
    try {
      if (this.stopped) return false;
      this.session.sendSignal(to, { type, transport: TRANSPORT, requestId, payload });
      this.counters.signalsSent += 1;
      return true;
    } catch (error) {
      this.counters.publishErrors += 1;
      this.#noteError("signal-send", error);
      return false;
    }
  }

  #readRefusal(payload) {
    return readRefusal(payload, this.options);
  }

  /** One retry at the time the refusing peer named, and its referrals tried once. */
  #afterRefusal(from, { retryAfterMs, referrals }) {
    const attempts = (this.retries.get(from) || 0) + 1;
    if (attempts <= this.options.maxRetriesPerPeer) {
      this.retries.set(from, attempts);
      this.counters.retriesScheduled += 1;
      this.#after(retryAfterMs + Math.random() * 1_000, () => {
        if (this.links.has(from) || this.dials.has(from) || this.banned.has(from) || !this.#hasCapacity()) return;
        this.cooldowns.delete(from);
        return this.#dial(from);
      });
    }
    for (const referral of referrals) {
      if (referral === this.session?.pubkey) continue;
      // A referral carries no ticket: only follow one already admitted.
      if (this.#gated() && !this.admitted.has(referral)) continue;
      if (this.links.has(referral) || this.dials.has(referral) || this.#coolingDown(referral) || !this.#hasCapacity()) continue;
      if ([...this.dials.values()].filter((dial) => dial.outgoing).length >= this.options.maxDialsInFlight) break;
      this.counters.referralsFollowed += 1;
      this.#guard("referral", () => this.#dial(referral));
    }
  }

  #hasCapacity() {
    return this.links.size + this.dials.size < this.options.maxPeers;
  }

  #coolingDown(pubkey) {
    return this.banned.has(pubkey) || (this.cooldowns.get(pubkey) || 0) > Date.now();
  }

  #gated() {
    return typeof this.options.admit === "function";
  }

  #ownTicket() {
    return validTicket(this.options.ticket) ? this.options.ticket : undefined;
  }

  // Remember credentials for retries, but ask the host again before any SDP
  // is disclosed. An opaque ticket's expiry cannot be inferred by this module.
  async #admits(pubkey, ticket) {
    if (this.stopped) return false;
    if (!this.#gated()) return true;
    if (!validTicket(ticket)) { this.counters.admitRefused += 1; return false; }
    const pending = this.admissionChecks.get(pubkey);
    if (pending) return pending.ticket === ticket ? pending.promise : false;
    if (this.admissionChecks.size >= 16) return false;
    const check = { ticket, promise: null };
    check.promise = (async () => {
      let ok = false;
      try {
        ok = await boundedOperation((signal) => this.options.admit(pubkey, ticket, { signal }), this.lifecycle.signal, this.options.admissionTimeoutMs) === true;
      } catch (error) { this.#noteError("admit", error); }
      if (this.stopped) return false;
      if (ok) {
        this.admitted.set(pubkey, { ticket });
        if (this.admitted.size > 256) this.admitted.delete(this.admitted.keys().next().value);
      } else {
        this.admitted.delete(pubkey);
        this.counters.admitRefused += 1;
      }
      return ok;
    })().finally(() => {
      if (this.admissionChecks.get(pubkey) === check) this.admissionChecks.delete(pubkey);
    });
    this.admissionChecks.set(pubkey, check);
    return check.promise;
  }

  async #onPresence({ from, payload }) {
    if (this.stopped || payload.role !== "viewer") return;
    if (!payload.transports.some((transport) => transport.type === TRANSPORT)) return;
    const active = this.links.has(from) || this.dials.has(from);
    const admitted = this.admitted.get(from);
    const knownCredential = !this.#gated() || admitted && admitted.ticket === payload.ticket;
    if (active && knownCredential) {
      if (payload.open !== null) this.#rememberOpen(from, payload.open);
      return;
    }
    // An unchanged heartbeat grants no new access. Check authority when using
    // SDP or serving bytes, and refresh changed credentials on active links.
    if (!active && (this.#coolingDown(from) || !this.#hasCapacity())) {
      if (knownCredential && payload.open !== null) this.#rememberOpen(from, payload.open);
      return;
    }
    if (!(await this.#admits(from, payload.ticket)) || this.stopped) return;
    if (payload.open !== null) this.#rememberOpen(from, payload.open);
    if (this.links.has(from) || this.dials.has(from) || this.#coolingDown(from) || !this.#hasCapacity()) return;
    // The `open` hint is not a gate. Skipping peers that say they are full cost
    // more than it saved: in a swarm where nearly every peer is full, a viewer
    // holding one link stopped dialling altogether and stayed on one link,
    // while a viewer that simply asks lands a slot the moment one frees up.
    // The hint is used to choose referrals, and nothing else.
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
    if (this.stopped || this.dialChecks.has(pubkey) || this.#coolingDown(pubkey)) return;
    this.dialChecks.add(pubkey);
    try {
      if (!(await this.#admits(pubkey, this.admitted.get(pubkey)?.ticket))) return;
    } finally { this.dialChecks.delete(pubkey); }
    if (this.stopped || this.links.has(pubkey) || this.dials.has(pubkey) || !this.#hasCapacity()
      || [...this.dials.values()].filter((dial) => dial.outgoing).length >= this.options.maxDialsInFlight) return;
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
      await gathered(pc, 1_200, this.lifecycle.signal);
      if (this.stopped || this.dials.get(pubkey) !== dial) return;
      if (!(await this.#admits(pubkey, this.admitted.get(pubkey)?.ticket))) return this.#failDial(dial, "failed");
      if (this.stopped || this.dials.get(pubkey) !== dial) return;
      dial.offerSentAt = now();
      // The offer says how alone the caller is: a peer with none at all is the
      // only one worth rotating somebody out for.
      const ticket = this.#ownTicket();
      if (!this.#sendSignal(pubkey, "offer", requestId, { sdp: pc.localDescription.sdp, peers: this.links.size, ...(ticket ? { ticket } : {}) })) this.#failDial(dial, "failed");
    } catch (error) {
      this.#noteError("dial", error);
      this.#failDial(dial, "failed");
    }
  }

  #failDial(dial, reason, cooldownMs = 0) {
    if (this.dials.get(dial.pubkey) !== dial) return;
    this.dials.delete(dial.pubkey);
    clearTimeout(dial.timer);
    this.timers.delete(dial.timer);
    try { dial.pc.close(); } catch {}
    if (reason === "timeout") this.counters.dialsTimedOut += 1;
    else if (reason === "rejected") this.counters.dialsRejected += 1;
    else if (reason !== "superseded") this.counters.dialsFailed += 1;
    if (reason === "superseded") return;
    // A refusal that named a time is a better wait than a flat cooldown: the
    // peer knows when it could rotate somebody out.
    const fallback = reason === "rejected" ? 30_000 : 60_000;
    this.cooldowns.set(dial.pubkey, Date.now() + (cooldownMs > 0 ? cooldownMs : fallback));
  }

  async #onSignal({ from, payload }) {
    if (this.stopped || payload.transport !== TRANSPORT) return;
    const sdp = typeof payload.payload?.sdp === "string" ? payload.payload.sdp : "";
    if (payload.type === "answer") {
      const dial = this.dials.get(from);
      if (!dial?.outgoing || dial.requestId !== payload.requestId || !sdp) return;
      if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null))) {
        this.#failDial(dial, "failed");
        return;
      }
      if (this.stopped || this.dials.get(from) !== dial) return;
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
      if (!dial?.outgoing || dial.requestId !== payload.requestId) return;
      const refusal = this.#readRefusal(payload.payload);
      this.#failDial(dial, "rejected", refusal.retryAfterMs);
      this.#rememberOpen(from, false);
      this.#afterRefusal(from, refusal);
      return;
    }
    if (payload.type !== "offer" || !sdp) return;
    if (this.banned.has(from) || this.links.has(from)) return;
    // Checked before anything is answered: the answer's SDP carries this
    // viewer's address. An unadmitted offer is dropped without a reply.
    if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null)) || this.stopped || this.links.has(from)) return;
    const existing = this.dials.get(from);
    if (existing) {
      // Both sides dialled at once: the lower public key keeps its offer.
      if (existing.outgoing && this.session.pubkey < from) return;
      this.#failDial(existing, "superseded");
    }
    if (!this.#hasCapacity() && !this.#evictForOffer(payload.payload?.peers)) {
      this.counters.offersRefused += 1;
      this.counters.evictionsUnavailable += 1;
      this.#sendSignal(from, "reject", payload.requestId, this.#refusalPayload(from));
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
      if (this.stopped || this.dials.get(from) !== dial) return;
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, 1_200, this.lifecycle.signal);
      if (this.stopped || this.dials.get(from) !== dial) return;
      if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null))) return this.#failDial(dial, "failed");
      if (this.stopped || this.dials.get(from) !== dial) return;
      const ticket = this.#ownTicket();
      if (this.#sendSignal(from, "answer", payload.requestId, { sdp: pc.localDescription.sdp, ...(ticket ? { ticket } : {}) })) this.counters.offersAccepted += 1;
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
      onScheduleChange: () => { for (const waiter of [...this.haveWaiters]) waiter(); },
      onClose: (closed) => {
        if (this.links.get(closed.pubkey) === closed) {
          this.links.delete(closed.pubkey);
          this.counters.linksClosed += 1;
          this.#guard("reannounce", () => this.#scheduleReannounce());
        }
      },
    });
    this.links.set(dial.pubkey, link);
    if (this.firstLinkAtMs === null) this.firstLinkAtMs = Date.now() - this.startedAt;
    link.sendContribution(this.#servingAllowed(), this.rendition);
    for (const identity of this.renditions.keys()) if (identity !== this.rendition) link.sendContribution(this.#servingAllowed(), identity);
    if (this.#servingAllowed()) {
      link.sendHave([...this.held.keys()]);
      for (const key of this.originFetches.keys()) link.sendFetching(key, 2000);
    }
    const pair = await candidatePairTypes(dial.pc);
    this.pairTypes[pair] = (this.pairTypes[pair] || 0) + 1;
    for (const waiter of [...this.haveWaiters]) waiter();
  }
}
