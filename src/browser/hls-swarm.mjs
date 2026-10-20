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
import { NeighbourDiscovery } from "./neighbour-discovery.mjs";
import { boundedOperation } from "./bounded-operation.mjs";
import { validStreamAuthorisation, verifySegmentCommitment, segmentMediaContext } from "./segment-commitment.mjs";

export const HLS_SWARM_METRICS_VERSION = 2;

const TRANSPORT = "webrtc";
const DEFAULTS = Object.freeze({
  mode: "shadow",
  originFallbackMs: 1_500,
  // Peer-first may wait up to this long, beyond originFallbackMs, only when
  // recent peer timing projects the segment needs it and the playback buffer
  // covers that projection while keeping originReserveMs for origin.
  maxPeerWaitMs: 5_000,
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
  iceTransportPolicy: "all",
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

// Local-only, fixed vocabulary: never retain signalling or peer identity here.
const TRANSPORT_EVENTS = Object.freeze({
  created: ["outgoing", "incoming"],
  gathering: ["new", "gathering", "complete", "unknown"],
  ice: ["new", "checking", "connected", "completed", "failed", "disconnected", "closed", "unknown"],
  connection: ["new", "connecting", "connected", "disconnected", "failed", "closed", "unknown"],
  "local-offer": ["complete", "capped", "aborted", "unknown"],
  "local-answer": ["complete", "capped", "aborted", "unknown"],
  "offer-received": ["authenticated"], "answer-received": ["authenticated"],
  "offer-admitted": ["accepted"], "answer-admitted": ["accepted"],
  "remote-installed": ["offer", "answer"],
  "signal-send": ["offer", "answer"], "signal-failed": ["offer", "answer"],
  "channel-open": ["accepted", "stale"],
  negotiation: ["glare-yield"],
  "dial-end": ["timeout", "failed", "rejected", "superseded", "admission", "host-stop"],
  "link-close": ["host", "host-stop", "admission", "rotation", "integrity", "request-timeout", "request-abort",
    "native-failed", "native-closed", "native-disconnected", "channel-close", "channel-error",
    "protocol", "send-error", "serve-error", "upload-queue", "upload-drain-timeout"],
});
const increment = (value) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
const PEER_ELIGIBILITY_REASONS = Object.freeze([
  "no-budget", "aborted-before-eligibility", "no-have-no-wait", "no-have-wait",
  "wait-no-longer-eligible", "wait-aborted", "wait-expired", "have-at-entry", "have-after-wait", "projected-late",
]);
const PEER_REQUEST_OUTCOMES = Object.freeze(["payload", "none", "timeout", "abort", "abandoned", "closed", "busy", "send-error"]);
// A projection from evidence this old may be stale; one attempt within the
// ordinary budget is allowed to renew it.
const PEER_EVIDENCE_STALE_MS = 15_000;
// A holder's scheduling jitter must not read as silence on a short path.
const SILENCE_FLOOR_MS = 250;
const ADMISSION_CALL_SITES = Object.freeze(["presence", "dialStart", "offerBeforeSend", "offerIncoming", "answerIncoming", "glareBeforeRollback", "glareAfterRollback", "answerBeforeSend", "upload", "refresh", "other"]);
const UPLOAD_REFUSAL_REASONS = Object.freeze([
  "admission", "not-held", "not-serving", "banned", "session-allowance", "peer-limit", "rate-limit",
  "reservation-refused", "reservation-inactive",
]);

function gathered(pc, capMs = 1_200, signal, observed) {
  return new Promise((resolve) => {
    const done = (outcome) => { try { observed?.(outcome); } catch {} resolve(outcome); };
    if (pc.iceGatheringState === "complete" || signal?.aborted) return done(signal?.aborted ? "aborted" : "complete");
    const finish = () => {
      clearTimeout(cap);
      pc.removeEventListener("icegatheringstatechange", changed);
      signal?.removeEventListener("abort", finish);
      // Classification is diagnostic only. A getter failure must not prevent
      // the original timer/abort completion from resolving its wait.
      let outcome = "unknown";
      try { outcome = signal?.aborted ? "aborted" : pc.iceGatheringState === "complete" ? "complete" : "capped"; } catch {}
      done(outcome);
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
    updateTicket: (ticket) => swarm.updateTicket(ticket),
    stop: () => swarm.stop(),
    metrics: () => swarm.metrics(),
  };
}

class HlsSwarm {
  constructor(options) {
    this.options = { ...DEFAULTS, ...options };
    if (this.options.iceTransportPolicy === undefined) this.options.iceTransportPolicy = DEFAULTS.iceTransportPolicy;
    this.startedAt = Date.now();
    this.transportStartedAt = now();
    this.transportSequence = 0;
    this.transportRecords = [];
    this.transportDropped = 0;
    this.transportCounters = Object.fromEntries(Object.entries(TRANSPORT_EVENTS).map(([event, values]) =>
      [event, Object.fromEntries(values.map((value) => [value, 0]))]));
    this.transportConnections = new WeakMap();
    this.peerEligibilityRecords = [];
    this.peerEligibilityDropped = 0;
    this.peerEligibilityCounters = Object.fromEntries(PEER_ELIGIBILITY_REASONS.map((reason) => [reason, 0]));
    this.peerRequestRecords = [];
    this.peerRequestDropped = 0;
    this.peerRequestCounters = Object.fromEntries(PEER_REQUEST_OUTCOMES.map((outcome) => [outcome, 0]));
    this.uploadRefusalCounters = Object.fromEntries(UPLOAD_REFUSAL_REASONS.map((reason) => [reason, 0]));
    this.admissionCallCounters = Object.fromEntries(ADMISSION_CALL_SITES.map((site) => [site, 0]));
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
    this.receivedOffers = new Set();
    this.cooldowns = new Map();
    this.retries = new Map();
    this.openPeers = new Map();
    this.discovery = new NeighbourDiscovery();
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
    this.uploadQuotaBytes = 0;
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
      peerSkippedLate: 0,
      peerProjectedLate: 0,
      peerWaitExtended: 0,
      peerAbandoned: 0,
      peerNoFit: 0,
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
      uploadsCancelled: 0,
      uploadCancelledBytes: 0,
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
    // Per rendition: origin load times, and the last committed segment size.
    this.renditionOriginSamples = new Map();
    this.renditionSizes = new Map();
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
    if (!["all", "relay"].includes(this.options.iceTransportPolicy)) return "invalid-ice-transport-policy";
    if (mode === "off") return "mode-off";
    if (mode !== "shadow" && mode !== "peer-first") return "invalid-mode";
    if (mode === "peer-first" && !validStreamAuthorisation(this.options.streamEvent)) return "invalid-stream-authorisation";
    if (mode === "peer-first" && typeof this.options.getCommitment !== "function") return "missing-commitment-provider";
    if (this.options.admit !== undefined && typeof this.options.admit !== "function") return "invalid-admit";
    if (this.options.reserveUploadBytes !== undefined && typeof this.options.reserveUploadBytes !== "function") return "invalid-upload-reservation";
    if (typeof this.options.serve !== "boolean" || typeof this.options.serveOnCellular !== "boolean") return "invalid-serve-option";
    if (this.options.ticket !== undefined && !validTicket(this.options.ticket)) return "invalid-ticket";
    if (this.options.maxUploadBytesPerSession !== undefined && (!Number.isSafeInteger(this.options.maxUploadBytesPerSession) || this.options.maxUploadBytesPerSession < 0)) return "invalid-upload-session-limit";
    for (const key of ["originFallbackMs", "maxPeerWaitMs", "originReserveMs", "lateWindowMs", "maxPeers", "maxUploadPeers", "maxUploadBytesPerSecond", "maxDialsInFlight", "dialTimeoutMs", "presenceIntervalMs", "metricsIntervalMs", "maxHeldSegments", "maxHeldBytes", "maxSegmentBytes", "maxConcurrentRaces", "admissionTimeoutMs"]) {
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

  // The host validates its own credential and lifetime. Replacing that opaque
  // credential grants no new remote authority and must not reset live state.
  updateTicket(ticket) {
    if (this.stopped || this.disabledReason || !this.#gated() || !validTicket(ticket)) return false;
    if (ticket === this.options.ticket) return true;
    this.options.ticket = ticket;
    this.#scheduleReannounce();
    return true;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.#endDiscovery();
    this.discovery.clear();
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
      this.#retireNegotiation(dial);
      this.#endTransport(dial.pc, "dial-end", "host-stop");
      try { dial.pc.close(); } catch {}
    }
    this.dials.clear();
    this.receivedOffers.clear();
    for (const link of [...this.links.values()]) link.close("host-stop");
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
      // IDs are per swarm instance; 0 means no PC allocated/correlated. Signal
      // send records local acceptance, not relay delivery or remote receipt.
      // Additive metrics-v2 field; retained after stop for local receipts. No
      // automatic reporting or new wire data is introduced by this projection.
      transportDiagnostics: {
        capacity: 64,
        dropped: this.transportDropped,
        counters: Object.fromEntries(Object.entries(this.transportCounters).map(([event, values]) => [event, { ...values }])),
        records: this.transportRecords.map((record) => ({ ...record })),
      },
      neighbourDiscovery: this.discovery.snapshot(),
      peerEligibilityDiagnostics: {
        capacity: 64,
        dropped: this.peerEligibilityDropped,
        counters: { ...this.peerEligibilityCounters },
        records: this.peerEligibilityRecords.map((record) => ({ ...record, budgetGeometry: { ...record.budgetGeometry }, ...(record.projection ? { projection: { ...record.projection } } : {}) })),
      },
      peerRequestDiagnostics: {
        capacity: 64,
        dropped: this.peerRequestDropped,
        counters: { ...this.peerRequestCounters },
        records: this.peerRequestRecords.map((record) => ({ ...record })),
      },
      uploadRefusalDiagnostics: { counters: { ...this.uploadRefusalCounters } },
      // Actual host callbacks only, not coalesced waiters. Fixed local counters;
      // no credentials, peer identities or automatic report fields.
      admissionDiagnostics: { calls: { ...this.admissionCallCounters } },
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
        peerSkippedLate: c.peerSkippedLate,
        peerProjectedLate: c.peerProjectedLate,
        peerWaitExtended: c.peerWaitExtended,
        peerAbandoned: c.peerAbandoned,
        peerNoFit: c.peerNoFit,
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
        uploadsCancelled: c.uploadsCancelled,
        uploadCancelledBytes: c.uploadCancelledBytes,
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
        maxPeerWaitMs: this.options.maxPeerWaitMs,
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
        const budgetGeometry = { source: "unobserved", positionSource: null, currentTime: null, bufferedEnd: null, playableEnd: null, fragmentStart: null, originReserveMs: null, uncappedMs: null };
        const budgetMs = swarm.#peerBudget(context, budgetGeometry);
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
              swarm.#renditionSample(swarm.renditionOriginSamples, context, now() - originStarted);
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
        if (budgetMs === 0) {
          swarm.#peerEligibility(context, budgetMs, "no-budget", null, budgetGeometry);
          return fallback();
        }
        timer = setTimeout(fallback, budgetMs);
        swarm.lifecycle.signal.addEventListener("abort", fallback, { once: true });
        // The wait may grow from budgetMs up to the buffer-safe limit, never
        // past the buffered playback less the origin reserve.
        const ceiling = Math.max(swarm.options.originFallbackMs, swarm.options.maxPeerWaitMs);
        const limitMs = Math.max(budgetMs, Math.min(ceiling, budgetGeometry.uncappedMs ?? budgetMs));
        const plan = { deadline: t0 + budgetMs, limit: t0 + limitMs, extend: (to) => {
          const target = Math.min(plan.limit, to);
          if (this.active !== token || target <= plan.deadline) return false;
          plan.deadline = target;
          clearTimeout(timer);
          timer = setTimeout(fallback, Math.max(0, target - now()));
          return true;
        } };
        swarm.#peerFirst(context, controller.signal, plan, budgetMs, budgetGeometry).then((result) => {
          if (this.active !== token || controller.signal.aborted || swarm.stopped) return;
          if (!result || now() >= plan.deadline) return fallback();
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
          if (swarm.discovery.verified(result.discoveryContext)
            && swarm.discovery.window?.context === result.discoveryContext) swarm.#endDiscovery();
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
    this.discovery.context(context.frag.type || "main", rendition);
    this.#expireDiscovery(false);
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

  #peerBudget(context, geometry) {
    const media = this.hls?.media;
    if (!media) { geometry.source = "no-media"; return this.options.originFallbackMs; }
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
          let partStart, bufferedEnd, currentTime;
          const fragStart = (partStart = context?.part?.start) ?? context?.frag?.start;
          const playableEnd = Number.isFinite(fragStart) && fragStart > media.currentTime ? Math.min(bufferedEnd = media.buffered.end(i), fragStart) : (bufferedEnd = media.buffered.end(i));
          const uncappedMs = Math.max(0, (playableEnd - (currentTime = media.currentTime)) * 1000 - originReserve);
          const budgetMs = Math.min(this.options.originFallbackMs, uncappedMs);
          // Capture the values already consumed by the formula, without
          // rereading mutable media/fragment getters or changing their order.
          try {
            const finite = (value) => Number.isFinite(value) ? value : null;
            Object.assign(geometry, { source: "buffer", positionSource: partStart == null ? "fragment" : "part",
              currentTime: finite(currentTime), bufferedEnd: finite(bufferedEnd), playableEnd: finite(playableEnd),
              fragmentStart: finite(fragStart), originReserveMs: finite(originReserve), uncappedMs: finite(uncappedMs) });
          } catch {}
          return budgetMs;
        }
      }
    } catch { geometry.source = "error"; return 0; }
    geometry.source = "no-buffer";
    return 0;
  }

  async #segmentKey(context) {
    const raw = (this.options.segmentKey || defaultSegmentKey)(context.url || context.frag.url, context);
    if (typeof raw !== "string" || !raw) throw new Error("Invalid segment key.");
    const range = context.rangeEnd ? `#${context.rangeStart || 0}-${context.rangeEnd}` : "";
    return sha256Hex(utf8.encode(`${this.options.swarmId}\n${raw}${range}`));
  }

  #peerEligibility(context, budgetMs, reason, matchingHave, budgetGeometry, projection) {
    // Observe only decisions already made. In particular a zero budget must
    // not hash a key or inspect HAVE merely to fill this local diagnostic.
    try {
      if (!PEER_ELIGIBILITY_REASONS.includes(reason)) return;
      const numeric = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
      let cc = null, level = null;
      try { cc = numeric(context?.frag?.cc); } catch {}
      try { level = numeric(context?.frag?.level); } catch {}
      const elapsed = now() - this.transportStartedAt;
      const record = { atMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
        cc, level, budgetMs: Number.isFinite(budgetMs) && budgetMs >= 0 ? budgetMs : null,
        reason, matchingHave: typeof matchingHave === "boolean" ? matchingHave : null, budgetGeometry: { ...budgetGeometry } };
      if (projection) record.projection = { ...projection };
      this.peerEligibilityCounters[reason] = increment(this.peerEligibilityCounters[reason]);
      if (this.peerEligibilityRecords.length === 64) {
        this.peerEligibilityRecords.shift();
        this.peerEligibilityDropped = increment(this.peerEligibilityDropped);
      }
      this.peerEligibilityRecords.push(record);
    } catch {}
  }

  #renditionSample(map, context, value) {
    const rendition = this.#renditionContext(context);
    if (!map.has(rendition) && map.size >= 16) map.delete(map.keys().next().value);
    const list = map.get(rendition) || [];
    pushSample(list, value);
    map.set(rendition, list);
  }

  // Expected time until a same-rendition contributor announces this segment:
  // this viewer's own median origin time for the rendition, less however long
  // an announced origin fetch has already run. Null without a measurement.
  #holderWaitMs(key, rendition) {
    const typical = percentile(this.renditionOriginSamples.get(rendition) || [], 0.5);
    if (typical === null) return null;
    let started = null;
    for (const peer of this.links.values()) {
      const expires = peer.fetching.get(key) || 0;
      // Leases are announced for 2000 ms when an origin fetch starts.
      if (expires > Date.now()) started = Math.min(started ?? Infinity, expires - 2_000);
    }
    return Math.max(0, typical - (started === null ? 0 : Date.now() - started));
  }

  // How long a delivery may wait, from its projection (holder wait plus
  // transfer) against the room left to the buffer-safe limit:
  //   "late"    go to origin now: the holder wait alone leaves no room for a
  //             first byte, or fresh evidence overruns the room by over 25%;
  //   "fits"    wait as long as the projection needs;
  //   "stretch" nearly fits, or the evidence is stale: wait to the limit and
  //             let abandonment decide, since a failed attempt that gives up
  //             early costs less buffer than a segment brings;
  //   "unknown" no evidence: the ordinary budget applies.
  #projection(transferMs, holderWaitMs, plan) {
    const room = plan.limit - now(), firstByte = this.peerSelection.firstByteMs();
    if (holderWaitMs !== null && holderWaitMs + (firstByte ?? 0) > room) return "late";
    if (transferMs === null || holderWaitMs === null) return "unknown";
    const projected = holderWaitMs + transferMs;
    if (projected <= room) return "fits";
    if (Date.now() - this.peerSelection.lastObservedAt >= PEER_EVIDENCE_STALE_MS) return "stretch";
    return projected > room * 1.25 ? "late" : "stretch";
  }

  #applyProjection(decision, projectedMs, plan) {
    const to = decision === "fits" ? now() + projectedMs * 1.25 + 100 : decision === "stretch" ? plan.limit : null;
    if (to !== null && plan.extend(to)) this.counters.peerWaitExtended += 1;
  }

  // Local diagnostic for a projected-late decision: what it was based on.
  #projectionDetail(stage, transferMs, holderWaitMs, plan) {
    const ms = (value) => Number.isFinite(value) ? Math.round(value) : null;
    const rate = this.peerSelection.rate();
    return { stage, transferMs: ms(transferMs), holderWaitMs: ms(holderWaitMs), roomMs: ms(plan.limit - now()),
      firstByteMs: ms(this.peerSelection.firstByteMs()), rateBytesPerSecond: Number.isFinite(rate) ? Math.round(rate * 1000) : null };
  }

  async #peerFirst(context, signal, plan, budgetMs, budgetGeometry) {
    // The initial deadline; plan.deadline may grow from it. Test availability
    // instrumentation (test/support/broadcast-availability-transform.mjs)
    // reads this binding by name.
    const deadline = plan.deadline;
    const discoveryContext = this.discovery.contexts.get(context.frag.type || "main");
    const key = await this.#segmentKey(context);
    if (signal.aborted || this.stopped) {
      this.#peerEligibility(context, budgetMs, "aborted-before-eligibility", null, budgetGeometry);
      return null;
    }
    const rendition = this.#renditionContext(context);
    if (discoveryContext?.rendition === rendition && this.discovery.contexts.get(discoveryContext.mediaType) === discoveryContext) {
      this.discovery.demand(discoveryContext.mediaType, rendition, key);
      this.#seekNeighbours();
    }
    const coordinated = ![...this.links.values()].some((peer) => peer.have.has(key));
    if (coordinated && !this.#shouldWaitForOrigin(key, rendition)) {
      this.#peerEligibility(context, budgetMs, "no-have-no-wait", false, budgetGeometry);
      return null;
    }
    // Go to origin at once, keeping the buffer, when the holder wait and the
    // transfer together cannot fit; otherwise allow the wait they need.
    const sizeHint = this.renditionSizes.get(rendition);
    const holderWait = coordinated ? this.#holderWaitMs(key, rendition) : 0;
    const entryTransfer = sizeHint ? this.peerSelection.projectMs(sizeHint) : null;
    const entry = this.#projection(entryTransfer, holderWait, plan);
    if (entry === "late") {
      this.#peerEligibility(context, budgetMs, "projected-late", !coordinated, budgetGeometry, this.#projectionDetail("entry", entryTransfer, holderWait, plan));
      this.counters.peerProjectedLate += 1;
      return null;
    }
    this.#applyProjection(entry, holderWait + entryTransfer, plan);
    if (coordinated) {
      this.#peerEligibility(context, budgetMs, "no-have-wait", false, budgetGeometry);
      this.counters.coordinatedWaits += 1;
    }
    const commitmentRemaining = plan.deadline - now();
    if (signal.aborted || this.stopped || commitmentRemaining <= 0) return null;
    // Every null/error, load abort and stop reaches the original loader's
    // cancellation path. Catch both outcomes before waiting for HAVE.
    this.counters.commitmentRequests += 1;
    const commitmentResult = boundedOperation((operationSignal) => {
      if (signal.aborted || this.stopped || now() >= plan.deadline) throw new Error("Commitment load no longer active.");
      return this.options.getCommitment(context, { signal: operationSignal });
    }, signal, commitmentRemaining).then((event) => ({ ok: true, event }), () => ({ ok: false }));
    if (coordinated) {
      // No playlist manipulation or origin prefetch. The elected contributor
      // loads normally; all advisory leases expire before the HTTP deadline.
      while (!signal.aborted && !this.stopped && now() < plan.deadline && ![...this.links.values()].some((peer) => peer.have.has(key))) {
        if (!this.#shouldWaitForOrigin(key, rendition)) {
          this.#peerEligibility(context, budgetMs, "wait-no-longer-eligible", false, budgetGeometry);
          return null;
        }
        await this.#waitForHave(key, Math.min(100, plan.deadline - now()), signal);
      }
      const cancelled = signal.aborted || this.stopped;
      if (cancelled || now() >= plan.deadline) {
        this.#peerEligibility(context, budgetMs, cancelled ? "wait-aborted" : "wait-expired", null, budgetGeometry);
        return null;
      }
    }
    this.#peerEligibility(context, budgetMs, coordinated ? "have-after-wait" : "have-at-entry", true, budgetGeometry);
    let commitment;
    try {
      const result = await commitmentResult;
      if (!result.ok) throw new Error("Commitment unavailable.");
      commitment = verifySegmentCommitment(result.event, {
        streamEvent: this.options.streamEvent, swarmId: this.options.swarmId, key, context,
        maxSegmentBytes: this.options.maxSegmentBytes,
        delegation: this.options.delegation, revokedDelegationIds: this.options.revokedDelegationIds, delegationRevocations: this.options.delegationRevocations,
      });
    } catch { if (!this.stopped) this.counters.commitmentUnavailable += 1; return null; }
    if (!commitment) { this.counters.commitmentRejected += 1; return null; }
    if (signal.aborted || this.stopped) return null;
    if (!this.renditionSizes.has(rendition) && this.renditionSizes.size >= 16) this.renditionSizes.delete(this.renditionSizes.keys().next().value);
    this.renditionSizes.set(rendition, commitment.size);
    // The committed size is now known and a holder has it.
    const transfer = this.peerSelection.projectMs(commitment.size);
    const known = this.#projection(transfer, 0, plan);
    if (known === "late") {
      this.#peerEligibility(context, budgetMs, "projected-late", true, budgetGeometry, this.#projectionDetail("commitment", transfer, 0, plan));
      this.counters.peerProjectedLate += 1;
      return null;
    }
    this.#applyProjection(known, transfer, plan);
    const tried = new Set();
    while (!signal.aborted && !this.stopped && now() < plan.deadline && tried.size < this.options.maxPeers) {
      // Candidates are judged against the buffer-safe limit, which the wait
      // may grow to; the chosen link's own estimate then sets the deadline.
      const room = plan.limit - now();
      // Go to origin now, keeping the buffer, rather than ask a holder for a
      // segment no recent transfer could have delivered in the time left, or
      // with too little time left for even a recent first byte to arrive.
      const firstByte = this.peerSelection.firstByteMs();
      if (this.peerSelection.minimumMs(commitment.size) > room || (firstByte ?? 0) > room) {
        this.counters.peerSkippedLate += 1;
        return null;
      }
      const fits = (peer, ms) => this.peerSelection.estimate(peer, commitment.size) === null || this.peerSelection.estimate(peer, commitment.size) * 1.25 + 25 <= ms;
      const link = this.peerSelection.select(this.links.values(), key, tried, commitment.size, room);
      if (!link) {
        if (![...this.links.values()].some((peer) => !peer.closed && !tried.has(peer.pubkey) && peer.have.has(key) && fits(peer, room))) {
          this.counters.peerNoFit += 1;
          return null;
        }
        await this.#waitForHave(key, Math.min(100, plan.deadline - now()), signal);
        continue;
      }
      tried.add(link.pubkey);
      const estimateMs = this.peerSelection.estimate(link, commitment.size);
      if (estimateMs !== null && plan.extend(now() + estimateMs * 1.25 + 25)) this.counters.peerWaitExtended += 1;
      const requestedAt = now();
      const remainingMs = plan.deadline - now();
      const alternatives = [...this.links.values()].filter((peer) => !peer.closed && !peer.busy && !tried.has(peer.pubkey) && peer.have.has(key) && fits(peer, remainingMs)).length;
      // Give an unmeasured route time to complete, retaining the existing
      // 25ms minimum opportunity for up to two quick alternative attempts.
      // Equal slices can time out every cold route before any can be measured.
      const coldAttemptMs = remainingMs - Math.min(2, alternatives) * 25;
      // A measured delivery that fits the original origin deadline must not
      // be cut short by an equal share intended for unmeasured alternatives.
      const attemptMs = estimateMs === null ? Math.min(remainingMs, Math.max(25, coldAttemptMs))
        : Math.min(remainingMs, Math.max(25, remainingMs / Math.min(3, alternatives + 1), estimateMs * 1.25 + 25));
      const attempt = this.#abandonableAttempt(signal, requestedAt, commitment.size, plan, firstByte);
      let bytes;
      try {
        bytes = await link.request(key, Math.max(1, attemptMs), { signal: attempt.signal, expectedSize: commitment.size, onProgress: attempt.progress,
          onResult: (result) => this.#peerRequestResult(context, link, remainingMs, result) });
      } finally { attempt.done(); }
      this.peerSelection.observe(attempt.observation());
      if (attempt.abandoned) {
        this.peerSelection.record(link, now() - requestedAt);
        this.counters.peerAbandoned += 1;
        return null;
      }
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
        link.close("integrity");
        continue;
      }
      if (commitment.expiresAt <= Math.floor(Date.now() / 1000)) return null;
      this.peerSelection.record(link, now() - requestedAt, bytes.byteLength);
      if (coordinated) this.counters.coordinatedPeerLoads += 1;
      return { key, bytes, discoveryContext };
    }
    return null;
  }

  // A request that gives up early, so its failure costs little buffer, but
  // only once it cannot finish by the deadline on generous assumptions: with
  // no first byte yet, not even at the best recent rate if bytes began now;
  // once data flows, not even at double its latest rate (slow start roughly
  // doubles it each round trip) or the best recent rate. Never before three
  // recent first-byte times (and 250 ms) without data, or one round trip
  // after the first byte. The observation it returns is the rate over the latest part of the
  // flow, since a whole-flow average on a fresh path mostly measures slow start.
  #abandonableAttempt(signal, requestedAt, size, plan, firstByteMs) {
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    if (signal.aborted) relay(); else signal.addEventListener("abort", relay, { once: true });
    const points = [];
    const best = this.peerSelection.rate();
    let firstByte = null;
    const state = { abandoned: false, signal: controller.signal };
    const abandon = () => {
      if (state.abandoned || controller.signal.aborted) return;
      state.abandoned = true;
      controller.abort(PeerLink.ABANDON_REASON);
    };
    let silence = null;
    if (firstByteMs !== null) {
      const hopelessAt = best ? plan.deadline - size / best : -Infinity;
      silence = setTimeout(() => { if (firstByte === null) abandon(); }, Math.max(SILENCE_FLOOR_MS, firstByteMs * 3, hopelessAt - now()));
    }
    // Rate from the latest point at least `span` before the newest, so a
    // gap in delivery lowers it; null until 150 ms of flow is observed.
    const windowRate = (span) => {
      const last = points.at(-1);
      if (!last) return null;
      let first = points[0];
      for (const point of points) { if (point[0] <= last[0] - span) first = point; else break; }
      return last[0] - first[0] >= 150 ? { bytes: last[1] - first[1], ms: last[0] - first[0] } : null;
    };
    state.progress = (received, _size, firstByteAt) => {
      const at = now();
      if (firstByte === null) firstByte = Number.isFinite(firstByteAt) ? firstByteAt : at - requestedAt;
      points.push([at, received]);
      if (points.length > 256) points.shift();
      if (at - requestedAt < firstByte * 2) return;
      const recent = windowRate(400);
      if (!recent) return;
      const rate = Math.max(2 * recent.bytes / recent.ms, best ?? 0);
      if (!rate || at + (size - received) / rate > plan.deadline) abandon();
    };
    state.observation = () => {
      const flow = points.length ? points.at(-1)[0] - points[0][0] : 0;
      const recent = windowRate(Math.max(300, flow / 2));
      return { firstByteMs: firstByte, bytes: recent?.bytes ?? 0, flowMs: recent?.ms ?? 0, totalFlowMs: flow };
    };
    state.done = () => { clearTimeout(silence); signal.removeEventListener("abort", relay); };
    return state;
  }

  #peerRequestResult(context, link, remainingMs, result) {
    try {
      if (!PEER_REQUEST_OUTCOMES.includes(result.outcome)) return;
      const numeric = (value) => Number.isFinite(value) && value >= 0 ? value : null;
      const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
      let cc = null, level = null;
      try { cc = integer(context?.frag?.cc); } catch {}
      try { level = integer(context?.frag?.level); } catch {}
      const record = { atMs: Math.max(0, Math.round(now() - this.transportStartedAt)),
        id: this.transportConnections.get(link.pc)?.id || 0, cc, level,
        remainingMs: numeric(remainingMs), outcome: result.outcome,
        elapsedMs: numeric(result.elapsedMs), timeoutMs: numeric(result.timeoutMs),
        expectedBytes: integer(result.expectedBytes), receivedBytes: integer(result.receivedBytes),
        firstByteMs: numeric(result.firstByteMs),
        metadataReceived: result.metadataReceived === true, draining: result.draining === true,
        closeReason: TRANSPORT_EVENTS["link-close"].includes(result.closeReason) ? result.closeReason : null };
      this.peerRequestCounters[result.outcome] = increment(this.peerRequestCounters[result.outcome]);
      if (this.peerRequestRecords.length === 64) {
        this.peerRequestRecords.shift();
        this.peerRequestDropped = increment(this.peerRequestDropped);
      }
      this.peerRequestRecords.push(record);
    } catch {}
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
      race.peerLink.close("integrity");
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
    return !Number.isSafeInteger(limit) || limit < 0 ? null : Math.max(0, limit - this.uploadQuotaBytes);
  }

  #withdrawContribution() {
    this.held.clear();
    this.heldBytes = 0;
    for (const link of this.links.values()) { link.sendHave([]); link.sendContribution(false, this.rendition); }
    this.#announce();
  }

  async #serveRequest(link, key) {
    if (this.options.admit && !(await this.#admits(link.pubkey, this.admitted.get(link.pubkey)?.ticket, "upload"))) {
      this.#refuseUpload("admission");
      link.close("admission");
      return null;
    }
    const bytes = this.held.get(key);
    if (!bytes) { this.#refuseUpload("not-held"); return null; }
    if (!this.#servingAllowed()) { this.#refuseUpload("not-serving"); return null; }
    if (this.banned.has(link.pubkey)) { this.#refuseUpload("banned"); return null; }
    const remaining = this.#uploadRemaining();
    if (remaining !== null && bytes.byteLength > remaining) {
      this.#refuseUpload("session-allowance");
      return null;
    }
    const recentUploaders = [...this.links.values()].filter((candidate) => candidate !== link && (candidate.outboundInFlight > 0 || Date.now() - candidate.lastServedAt < 30_000)).length;
    if (Date.now() - link.lastServedAt >= 30_000 && recentUploaders >= this.options.maxUploadPeers) {
      this.#refuseUpload("peer-limit");
      return null;
    }
    const elapsed = (now() - this.uploadRefilledAt) / 1_000;
    this.uploadRefilledAt = now();
    this.uploadTokens = Math.min(this.options.maxUploadBytesPerSecond * 2, this.uploadTokens + elapsed * this.options.maxUploadBytesPerSecond);
    if (this.uploadTokens < bytes.byteLength) {
      this.#refuseUpload("rate-limit");
      return null;
    }
    this.uploadTokens -= bytes.byteLength;
    // Reserve capacity before yielding, separately from public accepted-upload
    // metrics. Host revocation may archive metrics while its callback is pending.
    this.uploadQuotaBytes += bytes.byteLength;
    if (this.#uploadRemaining() === 0) this.#withdrawContribution();
    if (this.options.reserveUploadBytes) {
      let accepted = false;
      try { accepted = await boundedOperation((signal) => this.options.reserveUploadBytes(bytes.byteLength, { signal }), this.lifecycle.signal, this.options.admissionTimeoutMs) === true; }
      catch { this.#noteError("upload-reservation"); }
      if (!accepted || this.stopped || link.closed || this.options.serve !== true || (!this.options.serveOnCellular && onCellular())) {
        if (!accepted) this.uploadQuotaBytes -= bytes.byteLength;
        this.#refuseUpload(accepted ? "reservation-inactive" : "reservation-refused");
        return null;
      }
    }
    this.counters.bytesUploaded += bytes.byteLength;
    this.counters.uploadsServed += 1;
    if (this.options.testHooks?.corruptUploads) {
      const tampered = bytes.slice();
      tampered[tampered.length >> 1] ^= 0xff;
      return tampered;
    }
    return bytes;
  }

  #refuseUpload(reason) {
    this.counters.uploadsRefused += 1;
    this.uploadRefusalCounters[reason] = increment(this.uploadRefusalCounters[reason]);
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

  #servesRendition(link, rendition) {
    return !link.closed && link.contribution?.serving && (link.renditions.get(rendition) || 0) > Date.now() - 30_000;
  }

  #unmetDiscovery(context) {
    return ![...this.links.values()].some(link => this.#servesRendition(link, context.rendition)
      || context.keys.some(key => link.have.has(key)));
  }

  #discoveryVictim(context) {
    if (context.spent || this.links.size < 2 || Date.now() - this.lastEvictionAt < this.options.evictionCooldownMs) return null;
    // Preserve a useful sibling audio/video neighbour as well as the target.
    const contexts = [...this.discovery.contexts.values()].filter(value => Date.now() - value.activityAt < 30_000);
    return rotationCandidate([...this.links.values()].filter(link => !contexts.some(value =>
      this.#servesRendition(link, value.rendition) || value.keys.some(key => link.have.has(key)))), { ...this.options, banned: this.banned });
  }

  #endDiscovery(window = this.discovery.window, closePending = true) {
    if (!window || !this.discovery.end(window)) return;
    clearTimeout(window.timer); this.timers.delete(window.timer);
    const attempt = window.attempt, dial = attempt?.dial;
    // An incoming glare offer may adopt the same PC with a new negotiation.
    // Only this exact still-owned outgoing generation may be retired here.
    if (closePending && dial && dial.discovery === attempt && dial.negotiation === attempt.negotiation
      && this.dials.get(dial.pubkey) === dial) {
      dial.discovery = null;
      this.#failDial(dial, "superseded");
    }
  }

  #expireDiscovery(checkCandidate = true) {
    const window = this.discovery.window;
    if (window && (!this.discovery.live(window) || !this.discovery.current(window.context)
      || checkCandidate && window.attempt && !this.discovery.valid(window.attempt))) {
      this.discovery.counters.expired++;
      this.#endDiscovery(window);
    }
  }

  #seekNeighbours() {
    if (this.stopped || this.options.mode !== "peer-first") return;
    this.#expireDiscovery();
    if (!this.#hasOutgoingSlot()) return;
    const room = this.links.size + this.dials.size < this.options.maxPeers;
    const choice = this.discovery.choose(candidate => !this.links.has(candidate.pubkey) && !this.dials.has(candidate.pubkey)
      && !this.dialChecks.has(candidate.pubkey) && !this.#coolingDown(candidate.pubkey)
      && (!this.#gated() || validTicket(candidate.ticket))
      && (this.retries.get(candidate.pubkey) || 0) <= this.options.maxRetriesPerPeer,
    context => this.#unmetDiscovery(context) && (room || this.discovery.reserved() || Boolean(this.#discoveryVictim(context))), room);
    if (!choice) return;
    const attempt = this.discovery.begin(choice);
    if (!attempt) return;
    const window = attempt.window;
    if (!window.timer) window.timer = this.#after(Math.max(0, window.expiresAt - Date.now()), () => this.#endDiscovery(window));
    this.#guard("discovery", () => this.#dial(attempt.pubkey, attempt));
  }

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
    this.#expireDiscovery();
    if (this.discovery.reserved()) return false;
    return this.#hasCapacity() || (this.links.size >= 2 && Boolean(this.#rotationCandidate()));
  }

  /**
   * Rotate for a caller with no peers, or a caller seeking an exact object
   * we currently hold and may serve. Keep at least one link of our own.
   * Measured on a swarm whose viewers hold two links each, rotating for
   * anyone who asked cost late joiners far
   * more than it won: an evicted peer re-dials at once and displaces a third,
   * and the cascade leaves everybody re-connecting instead of fetching.
   * A caller with existing peers must therefore name an object held here.
   *
   * The count comes from the caller, who could of course claim to have none.
   * A requested key is untrusted advice, with the same rotation budget as a
   * peerless caller. It grants no permission to upload or accept media.
   */
  #evictForOffer(askerPeers, requestedKey) {
    if (this.discovery.reserved()) return null;
    const heldRepair = Number.isSafeInteger(askerPeers) && askerPeers > 0
      && typeof requestedKey === "string" && /^[0-9a-f]{64}$/u.test(requestedKey)
      && this.held.has(requestedKey) && this.#servingAllowed();
    if (askerPeers !== 0 && !heldRepair) return null;
    if (this.links.size < 2) return null;
    if (Date.now() - this.lastEvictionAt < this.options.evictionCooldownMs) return null;
    const link = this.#rotationCandidate();
    if (!link) return null;
    this.lastEvictionAt = Date.now();
    this.counters.evicted += 1;
    link.close("rotation");
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
        if (this.discovery.reserved()) {
          this.cooldowns.delete(from);
          this.#seekNeighbours();
          return;
        }
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
    this.#expireDiscovery();
    return this.links.size + this.dials.size + (this.discovery.reserved() ? 1 : 0) < this.options.maxPeers;
  }

  #hasOutgoingSlot() {
    return [...this.dials.values()].filter((dial) => dial.outgoing).length + this.dialChecks.size < this.options.maxDialsInFlight;
  }

  #coolingDown(pubkey) {
    return this.discovery.suppresses(pubkey) || this.banned.has(pubkey) || (this.cooldowns.get(pubkey) || 0) > Date.now();
  }

  #gated() {
    return typeof this.options.admit === "function";
  }

  #ownTicket() {
    return validTicket(this.options.ticket) ? this.options.ticket : undefined;
  }

  // Remember credentials for retries, but ask the host again before any SDP
  // is disclosed. An opaque ticket's expiry cannot be inferred by this module.
  async #admits(pubkey, ticket, callsite = "other") {
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
        ok = await boundedOperation((signal) => {
          // Instrument only the callback that actually runs. Diagnostic failure
          // must never alter the host's decision or cancellation ownership.
          try {
            const site = ADMISSION_CALL_SITES.includes(callsite) ? callsite : "other";
            this.admissionCallCounters[site] = increment(this.admissionCallCounters[site]);
          } catch { /* Local diagnostics are best effort. */ }
          return this.options.admit(pubkey, ticket, { signal });
        }, this.lifecycle.signal, this.options.admissionTimeoutMs) === true;
      } catch (error) { this.#noteError("admit", error); }
      if (this.stopped || this.admissionChecks.get(pubkey) !== check) return false;
      if (ok) {
        const candidateTicket = this.admitted.get(pubkey)?.candidateTicket;
        this.admitted.set(pubkey, { ticket, ...(validTicket(candidateTicket) && candidateTicket !== ticket ? { candidateTicket } : {}) });
        if (this.admitted.size > 256) this.admitted.delete(this.admitted.keys().next().value);
      } else {
        const remembered = this.admitted.get(pubkey);
        if (remembered?.ticket === ticket) this.admitted.delete(pubkey);
        else if (remembered?.candidateTicket === ticket) delete remembered.candidateTicket;
        this.counters.admitRefused += 1;
      }
      return ok;
    })().finally(() => {
      if (this.admissionChecks.get(pubkey) !== check) return;
      this.admissionChecks.delete(pubkey);
      // At most one latest presence per already active peer, within the same
      // 16-check bound. Floods replace this value rather than queueing waits.
      const latest = check.latestPresence;
      if (latest && !this.stopped && (this.links.has(pubkey) || this.dials.has(pubkey))) {
        this.#guard("admission-refresh", async () => {
          if (await this.#admits(pubkey, latest.ticket, "refresh")) {
            if (latest.open !== null) this.#rememberOpen(pubkey, latest.open);
          }
        });
      }
    });
    this.admissionChecks.set(pubkey, check);
    return check.promise;
  }

  async #onPresence({ from, payload }) {
    if (this.stopped || payload.role !== "viewer") return;
    if (!payload.transports.some((transport) => transport.type === TRANSPORT)) return;
    if (this.options.mode === "peer-first") {
      this.discovery.hint(from, payload.have, payload.ticket);
      this.#seekNeighbours();
    }
    const active = this.links.has(from) || this.dials.has(from);
    const admitted = this.admitted.get(from);
    // Keep one unvalidated replacement on an existing entry. Recording the
    // latest presence before eligibility checks also supersedes older candidates.
    if (admitted && validTicket(payload.ticket) && payload.ticket !== admitted.ticket) admitted.candidateTicket = payload.ticket;
    const knownCredential = !this.#gated() || admitted && admitted.ticket === payload.ticket;
    if (active && knownCredential) {
      if (payload.open !== null) this.#rememberOpen(from, payload.open);
      return;
    }
    // An unchanged heartbeat grants no new access. Check authority when using
    // SDP or serving bytes, and refresh changed credentials on active links.
    if (!active && (this.#coolingDown(from) || !this.#hasCapacity() || !this.#hasOutgoingSlot())) {
      if (knownCredential && payload.open !== null) this.#rememberOpen(from, payload.open);
      return;
    }
    const pending = this.admissionChecks.get(from);
    if (active && pending) {
      if (validTicket(payload.ticket) && payload.ticket !== pending.ticket) pending.latestPresence = { ticket: payload.ticket, open: payload.open };
      return;
    }
    if (!(await this.#admits(from, payload.ticket, "presence")) || this.stopped) return;
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
      if (!this.#hasOutgoingSlot()) return;
      return this.#dial(from);
    });
  }

  #transport(pc, event, detail, candidates) {
    // Diagnostics cannot affect admission, delivery, or native state handling.
    try {
      if (!TRANSPORT_EVENTS[event]?.includes(detail)) return;
      const meta = this.transportConnections.get(pc);
      if (meta?.ended) return;
      const elapsed = now() - this.transportStartedAt;
      const record = { id: meta?.id ?? 0, atMs: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0, event, detail };
      if (Number.isSafeInteger(candidates) && candidates >= 0 && candidates <= 256) { record.candidates = candidates; record.candidatesCapped = candidates === 256; }
      this.transportCounters[event][detail] = increment(this.transportCounters[event][detail]);
      if (this.transportRecords.length === 64) { this.transportRecords.shift(); this.transportDropped = increment(this.transportDropped); }
      this.transportRecords.push(record);
    } catch {}
  }

  #localDescription(pc, type, outcome) {
    // Only count lines, never parse/store addresses or other SDP fields. Native
    // descriptions above this bound are deliberately reported without a count.
    try {
      let candidates;
      const sdp = pc.localDescription?.sdp;
      if (typeof sdp === "string" && sdp.length <= 256 * 1024) {
        candidates = 0;
        for (const match of sdp.matchAll(/^a=candidate:/gm)) { if (++candidates === 256) break; }
      }
      this.#transport(pc, `local-${type}`, outcome, candidates);
    } catch { this.#transport(pc, `local-${type}`, outcome); }
  }

  #endTransport(pc, event, reason) {
    this.#transport(pc, event, reason);
    const meta = this.transportConnections.get(pc);
    if (!meta || meta.ended) return;
    meta.ended = true;
    for (const [name, listener] of meta.listeners) { try { pc.removeEventListener?.(name, listener); } catch {} }
    meta.listeners.length = 0;
  }

  #newPeerConnection(outgoing) {
    const Impl = this.options.RTCPeerConnectionImpl || globalThis.RTCPeerConnection;
    const pc = new Impl({ iceServers: this.options.iceServers, iceTransportPolicy: this.options.iceTransportPolicy });
    const meta = { id: this.transportSequence < Number.MAX_SAFE_INTEGER ? ++this.transportSequence : 0, listeners: [], ended: false };
    this.transportConnections.set(pc, meta);
    this.#transport(pc, "created", outgoing ? "outgoing" : "incoming");
    for (const [event, property, nativeEvent] of [["gathering", "iceGatheringState", "icegatheringstatechange"], ["ice", "iceConnectionState", "iceconnectionstatechange"], ["connection", "connectionState", "connectionstatechange"]]) {
      const listener = () => {
        try { const value = pc[property]; this.#transport(pc, event, TRANSPORT_EVENTS[event].includes(value) ? value : "unknown"); }
        catch { this.#transport(pc, event, "unknown"); }
      };
      try { pc.addEventListener(nativeEvent, listener); meta.listeners.push([nativeEvent, listener]); listener(); } catch {}
    }
    return pc;
  }

  #currentNegotiation(dial, negotiation) {
    return !this.stopped && this.dials.get(dial.pubkey) === dial && dial.negotiation === negotiation && !negotiation.controller.signal.aborted
      && (!dial.discovery || this.discovery.valid(dial.discovery));
  }

  #retireNegotiation(dial, closeChannel = true) {
    const negotiation = dial.negotiation;
    if (!negotiation) return;
    negotiation.controller.abort();
    if (negotiation.onDataChannel) dial.pc.removeEventListener("datachannel", negotiation.onDataChannel);
    if (negotiation.channel && negotiation.onOpen) negotiation.channel.removeEventListener("open", negotiation.onOpen);
    if (closeChannel) { try { negotiation.channel?.close(); } catch {} }
  }

  #beginNegotiation(dial, requestId, outgoing) {
    if (!outgoing && dial.discovery) {
      this.#endDiscovery(dial.discovery.window, false);
      dial.discovery = null;
    }
    if (dial.negotiation) dial.negotiation.superseded = true;
    this.#retireNegotiation(dial);
    dial.requestId = requestId; dial.outgoing = outgoing;
    const negotiation = { controller: new AbortController(), channel: null, ready: false };
    dial.negotiation = negotiation;
    return negotiation;
  }

  #serialNegotiation(dial, negotiation, operation) {
    // Native calls already in flight cannot be cancelled. A superseding
    // negotiation waits for them, then rechecks its generation before mutation.
    const task = (dial.operations ?? Promise.resolve()).then(() => {
      if (this.#currentNegotiation(dial, negotiation)) return operation();
    });
    dial.operations = task.catch(() => {});
    return task;
  }

  #dialChannel(dial, negotiation, channel) {
    // Retiring a channel must never close a PC adopted by another negotiation.
    if (negotiation.channel === channel) return;
    if (!this.#currentNegotiation(dial, negotiation) || negotiation.channel) { try { channel.close(); } catch {} return; }
    negotiation.channel = channel;
    negotiation.onOpen = () => {
      if (negotiation.ready) this.#guard("link-open", () => this.#linkOpened(dial, negotiation, channel));
    };
    channel.addEventListener("open", negotiation.onOpen);
    if (channel.readyState === "open") negotiation.onOpen();
  }

  #readyDial(dial, negotiation) {
    if (!this.#currentNegotiation(dial, negotiation)) return;
    negotiation.ready = true;
    if (negotiation.channel?.readyState === "open") negotiation.onOpen();
  }

  async #dial(pubkey, discovery = null) {
    if (this.stopped || this.links.has(pubkey) || this.dials.has(pubkey) || this.dialChecks.has(pubkey) || this.#coolingDown(pubkey)
      || !(discovery ? this.discovery.valid(discovery) : this.#hasCapacity()) || !this.#hasOutgoingSlot()) {
      if (discovery) this.discovery.abandoned(discovery);
      return;
    }
    this.dialChecks.add(pubkey);
    try {
      if (!(await this.#admits(pubkey, discovery ? discovery.ticket : this.admitted.get(pubkey)?.candidateTicket ?? this.admitted.get(pubkey)?.ticket, "dialStart"))) {
        if (discovery) { this.discovery.abandoned(discovery); this.cooldowns.set(pubkey, Date.now() + 60_000); }
        return;
      }
    } finally { this.dialChecks.delete(pubkey); }
    if (this.stopped || this.links.has(pubkey) || this.dials.has(pubkey) || this.#coolingDown(pubkey)
      || [...this.dials.values()].filter((dial) => dial.outgoing).length >= this.options.maxDialsInFlight
      || (discovery ? !this.discovery.valid(discovery) || !this.#unmetDiscovery(discovery.window.context) : !this.#hasCapacity())) {
      if (discovery) this.discovery.abandoned(discovery);
      return;
    }
    if (discovery && this.links.size + this.dials.size >= this.options.maxPeers) {
      const victim = this.#discoveryVictim(discovery.window.context);
      if (!victim || !this.discovery.replaced(discovery, victim.pubkey)) { this.discovery.abandoned(discovery); return; }
      this.lastEvictionAt = Date.now(); this.counters.evicted++;
      this.cooldowns.set(victim.pubkey, discovery.window.expiresAt);
      victim.close("rotation");
    }
    const pc = this.#newPeerConnection(true);
    const requestId = randomRequestId();
    const dial = { pubkey, pc, startedAt: now(), offerSentAt: 0 };
    if (discovery) { dial.discovery = discovery; this.discovery.allocated(discovery, dial); }
    this.dials.set(pubkey, dial);
    const negotiation = this.#beginNegotiation(dial, requestId, true);
    if (discovery) discovery.negotiation = negotiation;
    this.counters.dialsStarted += 1;
    dial.timer = this.#after(discovery ? Math.min(this.options.dialTimeoutMs, Math.max(0, discovery.window.expiresAt - Date.now())) : this.options.dialTimeoutMs, () => this.#failDial(dial, "timeout"));
    try {
      this.#dialChannel(dial, negotiation, pc.createDataChannel("relayswarm", { ordered: true }));
      await this.#serialNegotiation(dial, negotiation, async () => {
        const offer = await pc.createOffer();
        if (!this.#currentNegotiation(dial, negotiation)) return;
        await pc.setLocalDescription(offer);
        if (!this.#currentNegotiation(dial, negotiation)) return;
        await gathered(pc, 1_200, negotiation.controller.signal, (outcome) => { if (dial.negotiation === negotiation && !negotiation.superseded) this.#localDescription(pc, "offer", outcome); });
        if (!this.#currentNegotiation(dial, negotiation)) return;
        if (!(await this.#admits(pubkey, this.admitted.get(pubkey)?.candidateTicket ?? this.admitted.get(pubkey)?.ticket, "offerBeforeSend"))) {
          if (this.#currentNegotiation(dial, negotiation)) this.#failDial(dial, "failed", 0, "admission");
          return;
        }
        if (!this.#currentNegotiation(dial, negotiation)) return;
        dial.offerSentAt = now();
        // This still-current discovery names only its exact demanded object.
        // A saturated holder may use that advice for the same bounded rotation.
        const ticket = this.#ownTicket();
        const sent = this.#sendSignal(pubkey, "offer", requestId, { sdp: pc.localDescription.sdp, peers: this.links.size,
          ...(dial.discovery ? { requestedKey: dial.discovery.key } : {}), ...(ticket ? { ticket } : {}) });
        this.#transport(pc, sent ? "signal-send" : "signal-failed", "offer");
        if (!sent) this.#failDial(dial, "failed");
      });
    } catch (error) {
      if (!this.#currentNegotiation(dial, negotiation)) return;
      this.#noteError("dial", error);
      this.#failDial(dial, "failed");
    }
  }

  #failDial(dial, reason, cooldownMs = 0, diagnosticReason = reason) {
    if (this.dials.get(dial.pubkey) !== dial) return;
    this.dials.delete(dial.pubkey);
    this.discovery.failed(dial);
    this.#retireNegotiation(dial);
    clearTimeout(dial.timer);
    this.timers.delete(dial.timer);
    this.#endTransport(dial.pc, "dial-end", diagnosticReason);
    try { dial.pc.close(); } catch {}
    if (reason === "timeout") this.counters.dialsTimedOut += 1;
    else if (reason === "rejected") this.counters.dialsRejected += 1;
    else if (reason !== "superseded") this.counters.dialsFailed += 1;
    if (reason === "superseded") return;
    // A refusal that named a time is a better wait than a flat cooldown: the
    // peer knows when it could rotate somebody out.
    const fallback = reason === "rejected" ? 30_000 : 60_000;
    this.cooldowns.set(dial.pubkey, Date.now() + (cooldownMs > 0 ? cooldownMs : fallback));
    this.#seekNeighbours();
  }

  async #onSignal({ from, payload }) {
    if (this.stopped || payload.transport !== TRANSPORT) return;
    const sdp = typeof payload.payload?.sdp === "string" ? payload.payload.sdp : "";
    if (payload.type === "answer") {
      const dial = this.dials.get(from);
      if (!dial?.outgoing || dial.requestId !== payload.requestId || !sdp) return;
      const negotiation = dial.negotiation;
      if (negotiation.answerPending) return;
      this.#transport(dial.pc, "answer-received", "authenticated");
      if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null, "answerIncoming"))) {
        if (this.#currentNegotiation(dial, negotiation)) this.#failDial(dial, "failed", 0, "admission");
        return;
      }
      if (!this.#currentNegotiation(dial, negotiation) || !dial.outgoing || dial.requestId !== payload.requestId) return;
      if (negotiation.answerPending) return;
      negotiation.answerPending = true;
      this.#transport(dial.pc, "answer-admitted", "accepted");
      dial.answerAt = now();
      try {
        await this.#serialNegotiation(dial, negotiation, async () => {
          await dial.pc.setRemoteDescription({ type: "answer", sdp });
          if (!this.#currentNegotiation(dial, negotiation)) return;
          this.#transport(dial.pc, "remote-installed", "answer");
          this.#readyDial(dial, negotiation);
        });
      } catch (error) {
        if (this.#currentNegotiation(dial, negotiation)) { this.#noteError("answer", error); this.#failDial(dial, "failed"); }
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
    this.#expireDiscovery();
    if (this.discovery.suppresses(from)) return;
    if (this.banned.has(from) || this.links.has(from)) return;
    const offerKey = `${from}:${payload.requestId}`;
    const incoming = this.dials.get(from);
    // A previously admitted request grants no new work. Drop it without a
    // reply or host call, retaining the post-await check for simultaneous offers.
    if ((incoming && !incoming.outgoing && incoming.requestId === payload.requestId) || this.receivedOffers.has(offerKey)) return;
    this.#transport(this.dials.get(from)?.pc, "offer-received", "authenticated");
    // Checked before anything is answered: the answer's SDP carries this
    // viewer's address. An unadmitted offer is dropped without a reply.
    if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null, "offerIncoming")) || this.stopped || this.links.has(from)) return;
    this.#expireDiscovery();
    if (this.discovery.suppresses(from)) return;
    const existing = this.dials.get(from);
    if ((existing && !existing.outgoing && existing.requestId === payload.requestId) || this.receivedOffers.has(offerKey)) return;
    // Retain only admitted request IDs, never SDP. A replay cannot replace the
    // active dial or reset its timer. History is private to this swarm lifetime.
    this.receivedOffers.add(offerKey);
    if (this.receivedOffers.size > 256) this.receivedOffers.delete(this.receivedOffers.values().next().value);
    let dial, reuse = false;
    if (existing?.outgoing) {
      if (existing.negotiation.answerPending) return;
      // Both sides dialled at once: the lower public key keeps its offer.
      if (this.session.pubkey < from) return;
      // Keep only an existing permitted pending slot. Native failure, closure
      // or an incompatible state is never treated as a recovered connection.
      if (this.links.size + this.dials.size > this.options.maxPeers
        || !["new", "connecting"].includes(existing.pc.connectionState)
        || !["new", "checking"].includes(existing.pc.iceConnectionState)
        || !["stable", "have-local-offer"].includes(existing.pc.signalingState)) {
        this.#failDial(existing, "failed"); return;
      }
      dial = existing; reuse = true;
    } else {
      if (existing) this.#failDial(existing, "superseded");
      if (!this.#hasCapacity() && !this.#evictForOffer(payload.payload?.peers, payload.payload?.requestedKey)) {
        this.counters.offersRefused += 1;
        this.counters.evictionsUnavailable += 1;
        this.#sendSignal(from, "reject", payload.requestId, this.#refusalPayload(from));
        return;
      }
      const pc = this.#newPeerConnection(false);
      dial = { pubkey: from, pc, startedAt: now(), offerSentAt: now() };
      this.dials.set(from, dial);
      dial.timer = this.#after(this.options.dialTimeoutMs, () => this.#failDial(dial, "timeout"));
    }
    const pc = dial.pc, negotiation = this.#beginNegotiation(dial, payload.requestId, false);
    if (reuse) this.#transport(pc, "negotiation", "glare-yield");
    this.#transport(pc, "offer-admitted", "accepted");
    negotiation.onDataChannel = (event) => this.#dialChannel(dial, negotiation, event.channel);
    pc.addEventListener("datachannel", negotiation.onDataChannel);
    try {
      await this.#serialNegotiation(dial, negotiation, async () => {
        if (reuse) {
          // Admission at receipt cannot authorise mutation after waiting for an
          // old native call. Keep the same deadline while checking again.
          if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null, "glareBeforeRollback"))) {
            if (this.#currentNegotiation(dial, negotiation)) this.#failDial(dial, "failed", 0, "admission");
            return;
          }
          if (!this.#currentNegotiation(dial, negotiation)) return;
          if (this.links.size + this.dials.size > this.options.maxPeers
            || !["new", "connecting"].includes(pc.connectionState) || !["new", "checking"].includes(pc.iceConnectionState)) throw new Error("Pending connection unavailable.");
          if (pc.signalingState === "have-local-offer") {
            await pc.setLocalDescription({ type: "rollback" });
            if (!this.#currentNegotiation(dial, negotiation)) return;
          }
          if (this.links.size + this.dials.size > this.options.maxPeers || pc.signalingState !== "stable"
            || !["new", "connecting"].includes(pc.connectionState) || !["new", "checking"].includes(pc.iceConnectionState)) throw new Error("Pending negotiation unavailable.");
          // Rollback is itself asynchronous: authority may expire or be revoked
          // while it runs. Recheck before installing the remote description.
          if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null, "glareAfterRollback"))) {
            if (this.#currentNegotiation(dial, negotiation)) this.#failDial(dial, "failed", 0, "admission");
            return;
          }
          if (!this.#currentNegotiation(dial, negotiation)) return;
          if (this.links.size + this.dials.size > this.options.maxPeers || pc.signalingState !== "stable"
            || !["new", "connecting"].includes(pc.connectionState) || !["new", "checking"].includes(pc.iceConnectionState)) throw new Error("Pending negotiation unavailable.");
        }
        await pc.setRemoteDescription({ type: "offer", sdp });
        if (!this.#currentNegotiation(dial, negotiation)) return;
        this.#transport(pc, "remote-installed", "offer");
        const answer = await pc.createAnswer();
        if (!this.#currentNegotiation(dial, negotiation)) return;
        await pc.setLocalDescription(answer);
        if (!this.#currentNegotiation(dial, negotiation)) return;
        await gathered(pc, 1_200, negotiation.controller.signal, (outcome) => { if (dial.negotiation === negotiation && !negotiation.superseded) this.#localDescription(pc, "answer", outcome); });
        if (!this.#currentNegotiation(dial, negotiation)) return;
        if (!(await this.#admits(from, validTicket(payload.payload.ticket) ? payload.payload.ticket : null, "answerBeforeSend"))) {
          if (this.#currentNegotiation(dial, negotiation)) this.#failDial(dial, "failed", 0, "admission");
          return;
        }
        if (!this.#currentNegotiation(dial, negotiation)) return;
        const ticket = this.#ownTicket();
        const sent = this.#sendSignal(from, "answer", payload.requestId, { sdp: pc.localDescription.sdp, ...(ticket ? { ticket } : {}) });
        this.#transport(pc, sent ? "signal-send" : "signal-failed", "answer");
        if (sent) { this.counters.offersAccepted += 1; this.#readyDial(dial, negotiation); }
        else this.#failDial(dial, "failed");
      });
    } catch (error) {
      if (this.#currentNegotiation(dial, negotiation)) { this.#noteError("offer", error); this.#failDial(dial, "failed"); }
    }
  }

  async #linkOpened(dial, negotiation, channel) {
    if (!this.#currentNegotiation(dial, negotiation) || negotiation.channel !== channel || !negotiation.ready) {
      if (this.links.get(dial.pubkey)?.channel !== channel) { try { channel.close(); } catch {} }
      return;
    }
    this.#transport(dial.pc, "channel-open", "accepted");
    this.#retireNegotiation(dial, false);
    const rejectExtraChannel = (event) => { if (event.channel !== channel) { try { event.channel.close(); } catch {} } };
    dial.pc.addEventListener("datachannel", rejectExtraChannel);
    this.dials.delete(dial.pubkey);
    if (dial.discovery) {
      this.discovery.counters.opened++;
      this.#endDiscovery(dial.discovery.window, false);
      dial.discovery = null;
    }
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
      onUploadCancelled: (_link, unsentBytes) => {
        this.counters.uploadsCancelled += 1;
        this.counters.uploadCancelledBytes += unsentBytes;
        // Bytes never sent return to the per-second rate. The session
        // allowance and any host reservation stay charged.
        this.uploadTokens = Math.min(this.options.maxUploadBytesPerSecond * 2, this.uploadTokens + unsentBytes);
      },
      onClose: (closed) => {
        dial.pc.removeEventListener("datachannel", rejectExtraChannel);
        this.#endTransport(dial.pc, "link-close", closed.closeReason);
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
