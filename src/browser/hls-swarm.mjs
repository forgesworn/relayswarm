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

import { ORIGIN_CLOCK_SAMPLES, originClockOffsetMs, originClockSummary } from "./origin-clock.mjs";
import { generateSecretKey } from "nostr-tools/pure";
import { RelayPool, RelaySwarmSession, validTicket } from "../relay-session.mjs";
import { PeerLink } from "./peer-link.mjs";
import { PeerSelection } from "./peer-selection.mjs";
import { NeighbourDiscovery } from "./neighbour-discovery.mjs";
import { boundedOperation } from "./bounded-operation.mjs";
import { commitmentPieceSize, validStreamAuthorisation, verifySegmentCommitment, segmentMediaContext } from "./segment-commitment.mjs";
import { loadCore } from "./core-wasm.mjs";
import { createCoreTransferWorker } from "./core-transfer-worker.mjs";
import { fetchOriginRange, loadOriginRange } from "./origin-range.mjs";
import { createWarmAhead, warmContext, WARM_AHEAD } from "./warm-ahead.mjs";
import { createUploadPacer } from "./upload-pacing.mjs";

export const HLS_SWARM_METRICS_VERSION = 2;

const TRANSPORT = "webrtc";
const LINK_TIMING_SAMPLES = 16;
const LINK_TIMING_TTL_MS = 30_000;
const LINK_REFRESH_MS = 10_000;
const MIN_LINK_FLOW_MS = 300;
const MIN_LINK_FLOW_BYTES = 32 * 1024;
const DEFAULTS = Object.freeze({
  mode: "shadow",
  originFallbackMs: 1_500,
  // Peer-first may wait up to this long, beyond originFallbackMs, only when
  // recent peer timing projects the segment needs it and the playback buffer
  // covers that projection while keeping originReserveMs for origin.
  maxPeerWaitMs: 5_000,
  originReserveMs: 2_000,
  // Opt-in: also leave room to recover from origin within the duration this
  // fragment adds, so repeated peer misses need not steadily drain playback.
  sustainablePeerWait: false,
  // Opt-in: one speculative whole-fragment load for this player's next two
  // parsed fragments. Verified bytes share the existing bounded held cache.
  warmAhead: false,
  lateWindowMs: 6_000,
  maxPeers: 6,
  maxUploadPeers: 4,
  maxUploadBytesPerSecond: 1_250_000,
  uploadPacing: false,
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
  // Opt-in: the Rust core's verifier (relayswarm-core.wasm) as a URL, bytes
  // or a compiled WebAssembly.Module. Peer-first only. Until it loads, or if
  // it fails to load or traps, the JavaScript verifier decides.
  coreWasm: undefined,
  // Opt-in companion URL, packaged explicitly by the host. Warm asynchronously
  // from the compiled module; schema-3 loads use HTTP until it is ready.
  transferWorkerUrl: undefined,
  // Experimental, with coreWasm: fetch a schema 3 segment from several
  // framing 2 holders at once, with origin taking a late tail.
  multiHolder: false,
  // Opt-in: when no safe wait remains, race a known cached schema 3 object
  // against immediately started HTTP, without any extra origin request.
  zeroBudgetPeerRace: false,
  // Opt-in with zeroBudgetPeerRace: a load-entry connection may advertise
  // the exact cached object later, within the same original peer window.
  lateHaveRace: false,
  latePeerRace: false,
  // Provisional (CORE-SPEC open question 6): not yet set from a field trace.
  maxHoldersPerObject: 3,
  // Rows kept for trace(): every load, eligibility decision, peer and origin
  // request, and each multi-holder scheduler call. 0 keeps none.
  traceRequests: 0,
  // Peer-first: keep peer-delivered segments out of the hls.js bandwidth and
  // first-byte estimates, so ABR reflects the origin path (CORE-SPEC 6.3.1).
  abrIgnorePeers: false,
  // Experimental, read-only supply observations; never sets a player level.
  peerSupplyHint: false,
  onPlayerHint: null,
  // Observe only accepted, verified peer-first media contributions. The
  // host gets its actual connection reference and a payload byte count.
  onPeerDelivery: null,
});
const TRACE_LIMIT = 32_768;
const SAMPLE_LIMIT = 500;
// The longest the relay session waits for an opted-in core module to load or
// fail. A later module still takes new links, but discovery and selection
// stay in JavaScript once they hold state.
const CORE_WAIT_MS = 2_000;

const now = () => performance.now();
// Wall-clock time of the response's first byte, which is when the origin
// stamped Date. Using completion time would read low by the download time.
const firstByteWallMs = (stats) => {
  const first = stats?.loading?.first;
  return Date.now() - (Number.isFinite(first) && first > 0 && first <= now() ? now() - first : 0);
};
const hex = (buffer) => Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
const utf8 = new TextEncoder();

async function sha256Hex(bytes) {
  return hex(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

function defaultSegmentKey(url) {
  const parsed = new URL(url, globalThis.location?.href);
  return parsed.pathname;
}

function urlOrigin(url) {
  try { return new URL(url, globalThis.location?.href).origin; } catch { return String(url); }
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
}

function measuredQuantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

/** p50 and p90 of a sample list, or nulls when it is empty. */
function percentiles(values) {
  return { p50: percentile(values, 0.5), p90: percentile(values, 0.9) };
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
// Ranged-request progress goes to the multi-holder transfer at most this often.
const PROGRESS_REPORT_MS = 50;
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
 * With an optional `tier(link)` (a number), the lowest tier among the eligible
 * links goes first and idle longest decides within it. A tier only orders links
 * that are already eligible; it never makes one eligible or exempt. Without it
 * the choice is exactly the one above.
 *
 * Exported for tests; the swarm calls it with its own links.
 */
export function rotationCandidate(links, options, at = Date.now()) {
  return rotationChoice(links, options, at)?.link ?? null;
}

// The same choice with the tier it was ordered by, so a caller that counts the
// victim's tier counts the value that decided, not a second reading.
function rotationChoice(links, { minLinkLifeMs, idleEvictMs, banned = new Set(), tier } = {}, at = Date.now()) {
  let worst = null, worstTier = 0;
  for (const link of links) {
    if (link.transferring || banned.has(link.pubkey)) continue;
    if (at - link.openedAt < minLinkLifeMs) continue;
    if (at - link.lastUsefulAt < idleEvictMs) continue;
    const rank = tier ? tier(link) : 0;
    if (!worst || rank < worstTier || (rank === worstTier && link.lastUsefulAt < worst.lastUsefulAt)) { worst = link; worstTier = rank; }
  }
  return worst && { link: worst, tier: worstTier };
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
    peerConnections: () => swarm.peerConnections(),
    peerConnectionDetails: () => swarm.peerConnectionDetails(),
    trace: () => swarm.trace(),
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
    // Session-local holder labels for local diagnostics only: small counters in
    // first-link order, never derived from a key and never sent to any peer.
    this.holderLabels = new Map();
    this.traceRows = [];
    this.traceDropped = 0;
    this.traceLoads = new WeakMap();
    this.traceLoadNext = 1;
    this.traceBase = Math.floor(now());
    this.holderLabelNext = 1;
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
    this.peerLeases = new Map();
    this.peerLeaseWaiters = new Set();
    this.peerAdmission = { claims: 0, waited: 0, granted: 0, expired: 0, cancelled: 0 };
    this.latePeerOwners = new Map();
    this.latePeerGeneration = 0;
    this.latePeerNextId = 1;
    this.latePeerRows = [];
    this.latePeerDropped = 0;
    this.latePeerCounts = { entered: 0, armed: 0, won: 0, expired: 0, retired: 0, refused: 0 };
    this.peerSelection = new PeerSelection();
    this.linkTimings = new WeakMap();
    this.core = null;
    this.coreVerifier = null;
    this.coreState = "off";
    this.transferWorker = null;
    this.transferWorkerState = this.options.transferWorkerUrl === undefined ? "off" : "waiting-core";
    this.transferWorkerReason = null;
    // Settles when the session may start: the core has loaded or failed, or
    // CORE_WAIT_MS has passed. Null when no core was requested.
    this.coreWait = null;
    this.coreRelease = null;
    // Each peer's object framing version from its latest presence.
    this.remoteFraming = new Map();
    this.transferIds = new WeakMap();
    this.nextTransferId = 1;
    this.multiHolder = { transfers: 0, delivered: 0, late: 0, failed: 0, bans: 0, abandoned: 0, peerBytes: 0, originBytes: 0, unusedBytes: 0, originRanges: 0, originRangesIgnored: 0 };
    this.originRangeOutcomes = Object.fromEntries(["payload", "invalid-request", "wrong-size", "error", "timeout", "abort", "exception"].map(outcome => [outcome, 0]));
    // Origins (scheme, host and port) that answered a range with something
    // else; multi-holder transfer skips their segments for the session.
    this.originsWithoutRanges = new Set();
    // Per delivered transfer: total ms, the slowest single request's ms, and
    // the requests it made. Bounded, newest last.
    this.multiHolderTimings = [];
    this.coreFallbacks = 0;
    this.coreDecided = { wasm: 0, js: 0 };
    this.coreLinks = { wasm: 0, js: 0 };
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
    this.cachedRaces = new Set();
    this.haveWaiters = new Set();
    this.rendition = null;
    this.renditions = new Map();
    this.originFetches = new Map();
    this.uploadQuotaBytes = 0;
    this.uploadTokens = this.options.maxUploadBytesPerSecond;
    this.uploadRefilledAt = now();
    this.uploadPacer = this.options.uploadPacing ? createUploadPacer({ now,
      maxWaiters: Math.min(this.options.maxUploadPeers, this.options.maxPeers),
      take: charge => { this.#refillUploadRate(); if (this.uploadTokens < charge) return false; this.uploadTokens -= charge; return true; },
      give: charge => { this.uploadTokens = Math.min(this.options.maxUploadBytesPerSecond * 2, this.uploadTokens + charge); },
      delay: charge => { this.#refillUploadRate(); return Math.max(0, (charge - this.uploadTokens) * 1000 / this.options.maxUploadBytesPerSecond); },
      validate: row => this.#pacedUploadAllowed(row),
      refuse: reason => this.#refuseUpload(reason === 'cancelled' ? 'not-serving' : 'rate-limit'),
    }) : null;
    this.playerHints = [];
    this.hintSizes = new Map();
    this.hintOriginRates = [];
    this.hintGeneration = 0;
    this.peerFragments = new WeakSet();
    this.originalTrigger = null;
    this.counters = {
      originLoaded: 0,
      sampledOriginBytes: 0,
      peerInTimeBytes: 0,
      peerFirstLoaded: 0,
      peerFirstBytes: 0,
      zeroBudgetPeerRaces: 0,
      zeroBudgetPeerRaceWins: 0,
      abrPeerSamplesWithheld: 0,
      originFallbacks: 0,
      coordinatedWaits: 0,
      coordinatedPeerLoads: 0,
      peerSkippedLate: 0,
      peerProjectedLate: 0,
      peerWaitExtended: 0,
      peerAbandoned: 0,
      peerNoFit: 0,
      peerUntestedTrial: 0,
      peerUntestedTrialLoaded: 0,
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
      evictedUnhelpful: 0,
      evictedServing: 0,
      evictedConsumer: 0,
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
    this.originClockSamples = [];
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
    const core = this.options.coreWasm;
    if (core !== undefined && !(typeof core === "string" || core instanceof URL || core instanceof ArrayBuffer || ArrayBuffer.isView(core)
      || (typeof WebAssembly === "object" && core instanceof WebAssembly.Module))) return "invalid-core-wasm";
    if (typeof this.options.multiHolder !== "boolean" || !Number.isSafeInteger(this.options.maxHoldersPerObject)
      || this.options.maxHoldersPerObject < 1 || this.options.maxHoldersPerObject > 8) return "invalid-multi-holder";
    const workerUrl = this.options.transferWorkerUrl;
    if (workerUrl !== undefined && (mode !== "peer-first" || !this.options.multiHolder || core === undefined
      || !(workerUrl instanceof URL || (typeof workerUrl === "string" && workerUrl.length > 0 && workerUrl.length <= 2_048)))) return "invalid-transfer-worker";
    if (this.options.WorkerImpl !== undefined && typeof this.options.WorkerImpl !== "function") return "invalid-transfer-worker";
    if (!Number.isSafeInteger(this.options.traceRequests) || this.options.traceRequests < 0 || this.options.traceRequests > TRACE_LIMIT) return "invalid-trace";
    if (typeof this.options.peerSupplyHint !== "boolean" || (this.options.onPlayerHint !== null && typeof this.options.onPlayerHint !== "function")) return "invalid-player-hint-option";
    if (typeof this.options.abrIgnorePeers !== "boolean") return "invalid-abr-option";
    if (typeof this.options.zeroBudgetPeerRace !== "boolean") return "invalid-cached-race-option";
    if (typeof this.options.lateHaveRace !== "boolean") return "invalid-late-have-race-option";
    if (typeof this.options.latePeerRace !== 'boolean' || this.options.latePeerRace && (mode !== 'peer-first' || !this.options.zeroBudgetPeerRace)) return 'invalid-late-peer-race-option';
    if (typeof this.options.sustainablePeerWait !== "boolean") return "invalid-sustainable-wait-option";
    if (typeof this.options.warmAhead !== "boolean" || this.options.warmAhead && (mode !== "peer-first" || this.options.serve !== true)) return "invalid-warm-ahead-option";
    if (this.options.admit !== undefined && typeof this.options.admit !== "function") return "invalid-admit";
    if (this.options.reserveUploadBytes !== undefined && typeof this.options.reserveUploadBytes !== "function") return "invalid-upload-reservation";
    if (typeof this.options.serve !== "boolean" || typeof this.options.serveOnCellular !== "boolean") return "invalid-serve-option";
    if (typeof this.options.uploadPacing !== 'boolean') return 'invalid-upload-pacing';
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
      if (this.options.warmAhead) {
        this.warmAhead = createWarmAhead({ Loader: hls.config.fLoader,
          allowed: () => this.#servingAllowed() && hls.media?.paused !== true && !onCellular(),
          next: context => {
            const fragments = hls.levels?.[context.frag?.level]?.details?.fragments;
            if (!Array.isArray(fragments)) return [];
            const index = fragments.findIndex(frag => frag.sn === context.frag.sn && (frag.cc ?? 0) === (context.frag.cc ?? 0));
            return index < 0 ? [] : fragments.slice(index + 1, index + 3).map(frag => ({ url: frag.url, frag,
              type: "media-fragment", headers: {}, part: null, responseType: "arraybuffer",
              rangeStart: frag.byteRangeStartOffset, rangeEnd: frag.byteRangeEndOffset }));
          },
          authorise: async (context, signal) => {
            const key = await this.#segmentKey(context);
            const event = await boundedOperation(operationSignal => this.options.getCommitment(context, { signal: operationSignal }), signal, 1_000);
            if (signal.aborted || this.stopped) return null;
            const commitment = this.#verifyCommitment(event, { streamEvent: this.options.streamEvent, swarmId: this.options.swarmId,
              key, context, maxSegmentBytes: this.options.maxSegmentBytes, delegation: this.options.delegation,
              revokedDelegationIds: this.options.revokedDelegationIds, delegationRevocations: this.options.delegationRevocations });
            return commitment && commitment.size <= this.options.maxHeldBytes ? { ...commitment, key } : null;
          },
          verify: async (permit, data, _context, signal) => data instanceof ArrayBuffer && data.byteLength === permit.size &&
            !signal.aborted && await sha256Hex(data) === permit.sha256,
          reserve: size => { this.#trimHeld(this.options.maxHeldBytes - size); return !this.stopped && this.heldBytes + size <= this.options.maxHeldBytes; },
          reuseBudget: context => {
            try {
              const media = hls.media, time = media.currentTime;
              const recovery = Math.max(this.options.originReserveMs, (percentile(this.#originSamples(context), 0.9) || 0) * 1.25 + 100);
              for (let i = 0; i < media.buffered.length; i++) {
                const end = media.buffered.end(i);
                if (Number.isFinite(end) && media.buffered.start(i) <= time && end > time)
                  return Math.min(25, Math.max(0, (end - time) * 1000 - recovery));
              }
            } catch {}
            return 0;
          },
          onVerified: (permit, data) => { this.#dropHeld(permit.key); this.#hold(permit.key, new Uint8Array(data)); return this.held.has(permit.key); },
          onReuse: (context, _bytes, peerBytes) => { if (peerBytes > 0 && context.frag) this.peerFragments.add(context.frag); },
        });
        hls.config.fLoader = this.warmAhead.Loader;
        const media = hls.media;
        const cancelWarm = () => this.warmAhead?.clear();
        for (const name of ["pause", "ended"]) media?.addEventListener?.(name, cancelWarm, { signal: this.lifecycle.signal });
        media?.addEventListener?.("seeking", () => {
          try {
            const time = media.currentTime;
            for (let i = 0; i < media.buffered.length; i++) {
              const start = media.buffered.start(i), end = media.buffered.end(i);
              if (Number.isFinite(time) && Number.isFinite(start) && Number.isFinite(end) && start <= time && time < end) return;
            }
            // Initial shared-clock alignment can enter the next fragment before
            // it is appended. Keep that exact already-tracked work, too.
            if (this.warmAhead?.contains(time)) return;
          } catch {}
          cancelWarm();
        }, { signal: this.lifecycle.signal });
      }
      if (this.options.mode === "peer-first" && this.options.abrIgnorePeers) this.#withholdPeerAbrSamples(hls);
      if (this.options.mode === "peer-first" && this.options.coreWasm !== undefined) {
        let release;
        const settled = new Promise((resolve) => { release = resolve; });
        // A tracked timer, so stop() clears it; stop() also releases the wait.
        const timer = this.#after(CORE_WAIT_MS, release);
        this.coreRelease = release;
        this.coreWait = settled.then(() => {
          clearTimeout(timer);
          this.timers.delete(timer);
          this.coreWait = null;
          this.coreRelease = null;
        });
        this.#guard("core", () => this.#loadCore().finally(release));
      }
      this.#guard("start", () => this.#start());
      if (typeof this.options.onMetrics === "function") {
        this.#every(this.options.metricsIntervalMs, 0, () => this.options.onMetrics(this.metrics()));
      }
    } catch (error) {
      this.#noteError("attach", error);
    }
  }

  // hls.js samples bandwidth and first byte while it dispatches FRAG_LOADED
  // and FRAG_BUFFERED. For a peer-delivered fragment those samples are
  // dropped for the length of that dispatch only; the estimator is looked up
  // each time because hls.js replaces it on an emergency switch.
  #withholdPeerAbrSamples(hls) {
    const swarm = this, trigger = hls.trigger;
    if (typeof trigger !== "function") return;
    this.originalTrigger = trigger;
    this.triggerWasOwn = Object.hasOwn(hls, "trigger");
    this.withheldTrigger = function (event, data) {
      const estimator = (event === "hlsFragLoaded" || event === "hlsFragBuffered") && data?.frag && swarm.peerFragments.has(data.frag)
        ? hls.abrController?.bwEstimator : null;
      if (!estimator || typeof estimator.sample !== "function" || typeof estimator.sampleTTFB !== "function") return trigger.call(this, event, data);
      const skip = () => { swarm.counters.abrPeerSamplesWithheld += 1; };
      const saved = ["sample", "sampleTTFB"].map((name) => [name, Object.getOwnPropertyDescriptor(estimator, name)]);
      estimator.sample = skip;
      estimator.sampleTTFB = skip;
      try { return trigger.call(this, event, data); } finally {
        for (const [name, own] of saved) { if (own) Object.defineProperty(estimator, name, own); else delete estimator[name]; }
      }
    };
    hls.trigger = this.withheldTrigger;
  }

  // The host validates its own credential and lifetime. Replacing that opaque
  // credential grants no new remote authority and must not reset live state.
  updateTicket(ticket) {
    if (this.stopped || this.disabledReason || !this.#gated() || !validTicket(ticket)) return false;
    if (ticket === this.options.ticket) return true;
    this.latePeerGeneration++;
    this.#retireLatePeers('ticket');
    this.warmAhead?.clear();
    this.options.ticket = ticket;
    this.#scheduleReannounce();
    return true;
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.#retireLatePeers('stop');
    this.uploadPacer?.stop();
    this.warmAhead?.stop();
    this.#endDiscovery();
    this.discovery.clear();
    this.lifecycle.abort();
    for (const waiter of [...this.peerLeaseWaiters]) waiter();
    this.peerLeases.clear();
    this.transferWorker?.stop();
    if (this.options.transferWorkerUrl !== undefined) this.transferWorkerState = "stopped";
    this.cachedRaces.clear();
    this.admissionChecks.clear();
    this.admitted.clear();
    this.dialChecks.clear();
    for (const race of this.races) { race.settled = true; race.controller.abort(); }
    this.races.clear();
    try {
      if (this.hls && this.hls.config.fLoader?.relayswarmShadow) this.hls.config.fLoader = this.originalFragmentLoader;
    } catch {}
    try {
      if (this.originalTrigger && this.hls?.trigger === this.withheldTrigger) {
        if (this.triggerWasOwn) this.hls.trigger = this.originalTrigger; else delete this.hls.trigger;
      }
    } catch {}
    this.originalTrigger = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.coreRelease?.();
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
    this.playerHints = [];
    this.hintSizes.clear();
    this.hintOriginRates = [];
    try { this.session?.close(); } catch {}
    try { this.pool?.close(); } catch {}
    try { this.options.onMetrics?.(this.metrics()); } catch {}
  }

  /**
   * The request trace kept under `traceRequests`: rows in order, times in
   * whole milliseconds since the swarm was created, holders by the same
   * session labels as the diagnostics. Multi-holder `xfer` rows are each
   * scheduler call with its inputs and the commands it returned, so a trace
   * replays against another scheduler configuration.
   */
  trace() {
    return { v: 1, capacity: this.options.traceRequests, dropped: this.traceDropped, rows: this.traceRows.map((row) => structuredClone(row)) };
  }

  #trace(row) {
    if (!this.options.traceRequests) return;
    try {
      if (this.traceRows.length >= this.options.traceRequests) { this.traceRows.shift(); this.traceDropped = increment(this.traceDropped); }
      this.traceRows.push(row);
    } catch {}
  }

  #traceAt(at = now()) { return Math.floor(at) - this.traceBase; }

  // A load ID for the peer-first loader's context, so its rows join.
  #traceLoad(context) {
    try { return (context && this.traceLoads.get(context)) ?? null; } catch { return null; }
  }

  #traceBegin(context, budgetMs, limitMs, budgetGeometry) {
    if (!this.options.traceRequests) return;
    try {
      const load = this.traceLoadNext++;
      this.traceLoads.set(context, load);
      const integer = (value) => Number.isSafeInteger(value) ? value : null;
      this.#trace({ k: "load", load, at: this.#traceAt(), sn: integer(context.frag?.sn), level: integer(context.frag?.level), cc: integer(context.frag?.cc),
        budgetMs: Math.round(budgetMs), limitMs: Math.round(limitMs), budgetGeometry: { ...budgetGeometry } });
    } catch {}
  }

  // Native references are deliberately separate from serialisable metrics.
  // A pending dial or a glare negotiation is not an accepted peer link.
  peerConnections() {
    return this.peerConnectionDetails().map(detail => detail.connection);
  }

  // Explicitly bind each accepted native connection to its signalling identity.
  // Callers must not infer this association from separate metrics array orders.
  peerConnectionDetails() {
    const connections = [];
    for (const link of this.links.values()) {
      try {
        if (!link.closed && link.channel.readyState === "open"
          && !["failed", "closed", "disconnected"].includes(link.pc.connectionState)) {
          connections.push({ connection: link.pc, pubkey: link.pubkey });
        }
      } catch { /* An unavailable native state is not an active link. */ }
    }
    return connections;
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
      warmAhead: this.warmAhead?.snapshot() ?? null,
      peerAdmission: { ...this.peerAdmission, claimedLinks: this.peerLeases.size, waiting: this.peerLeaseWaiters.size },
      uploadPacing: this.uploadPacer?.snapshot() ?? null,
      latePeerRace: { enabled: this.options.latePeerRace, ...this.latePeerCounts, pending: this.latePeerOwners.size,
        dropped: this.latePeerDropped, records: this.latePeerRows.map(row => ({ ...row, ...(row.holders ? { holders: [...row.holders] } : {}) })),
        limits: { windowMs: Math.min(4000, this.options.lateWindowMs), peerMs: Math.min(2500, this.options.maxPeerWaitMs), owners: this.options.maxConcurrentRaces } },
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
        evictedUnhelpful: c.evictedUnhelpful,
        evictedServing: c.evictedServing,
        evictedConsumer: c.evictedConsumer,
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
        deliveryMeasurements: [...this.links.values()].map((link) => ({ pubkey: link.pubkey, holder: this.#holderLabel(link.pubkey), ...this.peerSelection.summary(link) })),
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
      ...(this.options.peerSupplyHint ? { playerHint: structuredClone(this.playerHints) } : {}),
      peerEligibilityDiagnostics: {
        capacity: 64,
        dropped: this.peerEligibilityDropped,
        counters: { ...this.peerEligibilityCounters },
        records: this.peerEligibilityRecords.map((record) => ({ ...record, budgetGeometry: { ...record.budgetGeometry },
          ...("holders" in record ? { holders: record.holders && [...record.holders], haveHolders: record.haveHolders && [...record.haveHolders],
            staleHolders: record.staleHolders && [...record.staleHolders],
            heldMissHolders: record.heldMissHolders && [...record.heldMissHolders] } : {}),
          ...(record.projection ? { projection: { ...record.projection } } : {}) })),
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
        // Additive metrics-v2 field: local age-window counts, no identities.
        // Without a session the session fields are null; origin is still reported.
        clock: {
          ...(this.session ? this.session.clockDiagnostics() : { aheadRejected: null, staleRejected: null, maxAheadSeconds: null, signalSamples: null, signalAgeMedianSeconds: null }),
          origin: originClockSummary(this.originClockSamples),
        },
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
        zeroBudgetPeerRaces: c.zeroBudgetPeerRaces,
        zeroBudgetPeerRaceWins: c.zeroBudgetPeerRaceWins,
        abrPeerSamplesWithheld: c.abrPeerSamplesWithheld,
        originFallbacks: c.originFallbacks,
        coordinatedWaits: c.coordinatedWaits,
        coordinatedPeerLoads: c.coordinatedPeerLoads,
        peerSkippedLate: c.peerSkippedLate,
        peerProjectedLate: c.peerProjectedLate,
        peerWaitExtended: c.peerWaitExtended,
        peerAbandoned: c.peerAbandoned,
        peerNoFit: c.peerNoFit,
        peerUntestedTrial: c.peerUntestedTrial,
        peerUntestedTrialLoaded: c.peerUntestedTrialLoaded,
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
        rejectedTimestamp: this.pool?.rejectedTimestamp ?? 0,
        sinceDropped: this.pool?.sinceDropped ?? 0,
        publishErrors: c.publishErrors,
      },
      errors: { total: c.errors, byStage: { ...this.errorsByStage } },
      // Additive metrics-v2 field: which commitment verifier and peer selection run.
      core: { state: this.coreState, verifier: this.coreVerifier ? "wasm" : "js", selection: this.peerSelection.kind ?? "js", discovery: this.discovery.kind ?? "js", links: { ...this.coreLinks }, fallbacks: this.coreFallbacks, decided: { ...this.coreDecided },
        transferWorker: { ...(this.transferWorker?.snapshot() ?? {}), state: this.transferWorkerState, reason: this.transferWorkerReason },
        multiHolder: { enabled: this.#rangesEnabled(), ...this.multiHolder, originRangeOutcomes: { ...this.originRangeOutcomes },
          timings: { durationMs: percentiles(this.multiHolderTimings.map((row) => row[0])), slowestRequestMs: percentiles(this.multiHolderTimings.map((row) => row[1])),
            requests: percentiles(this.multiHolderTimings.map((row) => row[2])) } } },
      config: {
        originFallbackMs: this.options.originFallbackMs,
        maxPeerWaitMs: this.options.maxPeerWaitMs,
        originReserveMs: this.options.originReserveMs,
        sustainablePeerWait: this.options.sustainablePeerWait,
        zeroBudgetPeerRace: this.options.zeroBudgetPeerRace,
        lateHaveRace: this.options.lateHaveRace,
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

  #noteOriginClock(details, receivedMs) {
    try {
      const offset = originClockOffsetMs(details, receivedMs);
      if (offset === null) return;
      this.originClockSamples.push(offset);
      if (this.originClockSamples.length > ORIGIN_CLOCK_SAMPLES) this.originClockSamples.shift();
    } catch {}
  }

  #peerFirstLoader(BaseLoader) {
    const swarm = this;
    return class RelaySwarmPeerFirstLoader {
      static relayswarmShadow = true;
      constructor(config) {
        this.inner = new BaseLoader(config);
        this.hlsConfig = config;
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
        if (context?.frag) swarm.peerFragments.delete(context.frag);
        const budgetGeometry = { source: "unobserved", positionSource: null, currentTime: null, bufferedEnd: null, playableEnd: null, fragmentStart: null, originReserveMs: null, uncappedMs: null };
        const budgetMs = swarm.#peerBudget(context, budgetGeometry);
        swarm.#contributionContext(context);
        if (swarm.options.peerSupplyHint) swarm.#guard("player-hint", () => swarm.#reportPlayerHints(context, budgetMs));
        if (swarm.stopped || !context.frag || context.frag.sn === "initSegment" || (context.part && !swarm.options.swarmParts)
          || (!swarm.options.serveOnCellular && onCellular())) return this.inner.load(context, config, callbacks);
        if (budgetMs === 0 && swarm.options.zeroBudgetPeerRace && !this.hlsConfig.progressive
          && swarm.#rangesEnabled() && swarm.#peerRaceCapacity()) {
          const cached = new Map([...swarm.links.values()].filter(link => swarm.#peerEntryAvailable(link, context) && link.supportsRanges
            && (swarm.remoteFraming.get(link.pubkey) ?? 1) >= 2 && !swarm.banned.has(link.pubkey) && (link.have.size || swarm.options.lateHaveRace))
            .map(link => [link, new Set(link.have)]));
          if (cached.size) return this.loadCachedRace(context, config, callbacks, budgetGeometry, cached);
        }
        const parentMs = config?.loadPolicy?.maxLoadTimeMs ?? config?.timeout;
        if (budgetMs === 0 && swarm.options.latePeerRace && !this.hlsConfig.progressive && warmContext(context) &&
            Number.isFinite(parentMs) && parentMs > 0 && swarm.#peerRaceCapacity()) {
          return this.loadLatePeerRace(context, config, callbacks, budgetGeometry, parentMs);
        }
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
          const traceOrigin = (outcome, bytes = null) => swarm.options.traceRequests && swarm.#trace({ k: "origin", load: swarm.#traceLoad(context), at: swarm.#traceAt(originStarted),
            ms: Math.round(now() - originStarted), ranged: false, outcome, bytes });
          this.inner.load(context, config, {
            ...callbacks,
            onError: (...args) => { traceOrigin("error"); finishOrigin(); callbacks.onError?.(...args); },
            onTimeout: (...args) => { traceOrigin("timeout"); finishOrigin(); callbacks.onTimeout?.(...args); },
            onAbort: (...args) => { traceOrigin("abort"); finishOrigin(); callbacks.onAbort?.(...args); },
            onSuccess: (response, stats, ctx, details) => {
              const receivedMs = firstByteWallMs(stats);
              const { copy, size } = swarm.#originCopy(response, context);
              traceOrigin("payload", size || null);
              completed = true;
              pushSample(swarm.originLatencySamples, now() - originStarted);
              swarm.#renditionSample(swarm.renditionOriginSamples, context, now() - originStarted);
              if (swarm.options.peerSupplyHint && size) {
                const rendition = swarm.#renditionContext(context);
                if (!swarm.hintSizes.has(rendition) && swarm.hintSizes.size >= 16) swarm.hintSizes.delete(swarm.hintSizes.keys().next().value);
                swarm.hintSizes.set(rendition, size);
                const elapsedMs = now() - originStarted;
                if (elapsedMs > 0) pushSample(swarm.hintOriginRates, size / elapsedMs);
              }
              callbacks.onSuccess(response, stats, ctx, details);
              swarm.#noteOriginClock(details, receivedMs);
              if (size && !swarm.stopped) swarm.#guard("peer-first-origin", async () => {
                swarm.counters.originLoaded += 1;
                swarm.counters.bytesFromOrigin += size;
                try {
                  const key = await swarm.#segmentKey(context);
                  if (copy && !swarm.stopped) swarm.#hold(key, new Uint8Array(copy));
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
        // Both timer arms mark the plan as deadline-driven before falling back,
        // so a wait ended by the deadline differs from a caller abort or stop.
        // A multi-holder transfer owns the deadline while it runs: it moves
        // outstanding pieces to origin itself rather than reload the whole.
        const atDeadline = () => { if (plan.onDeadline?.()) return; plan.expired = true; fallback(); };
        timer = setTimeout(atDeadline, budgetMs);
        swarm.lifecycle.signal.addEventListener("abort", fallback, { once: true });
        // The wait may grow from budgetMs up to the buffer-safe limit, never
        // past the buffered playback less the origin reserve.
        const ceiling = Math.max(swarm.options.originFallbackMs, swarm.options.maxPeerWaitMs);
        const limitMs = Math.max(budgetMs, Math.min(ceiling, budgetGeometry.uncappedMs ?? budgetMs,
          budgetGeometry.sustainableMs ?? Infinity));
        swarm.#traceBegin(context, budgetMs, limitMs, budgetGeometry);
        // Ranged origin pieces go through the player's loader, as the whole would.
        const origin = { Loader: BaseLoader, config: this.hlsConfig, loaderConfig: config };
        const plan = { deadline: t0 + budgetMs, limit: t0 + limitMs,
          originReserveMs: budgetGeometry.originReserveMs ?? swarm.options.originReserveMs,
          expired: false, onDeadline: null, origin, extend: (to) => {
          const target = Math.min(plan.limit, to);
          if (this.active !== token || target <= plan.deadline) return false;
          plan.deadline = target;
          clearTimeout(timer);
          timer = setTimeout(atDeadline, Math.max(0, target - now()));
          return true;
        } };
        swarm.#peerFirst(context, controller.signal, plan, budgetMs, budgetGeometry).then((result) => {
          if (this.active !== token || controller.signal.aborted || swarm.stopped) return;
          if (result && !result.multi && now() >= plan.deadline) swarm.#recordOutcome(result.demand);
          if (!result || (now() >= plan.deadline && !result.multi)) return fallback();
          this.active = null;
          this.pendingCallbacks = null;
          cleanup();
          swarm.#completePeerLoad(this, result, context, callbacks, t0);
        }).catch((error) => {
          if (this.active === token) {
            swarm.#noteError("peer-first", error);
            fallback();
          }
        });
      }
      loadCachedRace(context, config, callbacks, budgetGeometry, cached) {
        const token = {}, controller = new AbortController(), t0 = now();
        let originPending = true, originClaimed = false, timer;
        this.active = token;
        this.pendingCallbacks = { callbacks, context };
        Object.assign(this.inner.stats, { aborted: false, loaded: 0, total: 0, chunkCount: 0,
          loading: { start: 0, first: 0, end: 0 } });
        const stopPeer = () => {
          clearTimeout(timer);
          swarm.lifecycle.signal.removeEventListener("abort", stopPeer);
          swarm.cachedRaces.delete(controller);
          controller.abort();
        };
        swarm.cachedRaces.add(controller);
        swarm.lifecycle.signal.addEventListener("abort", stopPeer, { once: true });
        this.cancel = () => {
          const pending = originPending && this.active === token;
          originPending = false; this.active = null;
          stopPeer();
          try { this.inner.abort(); } catch {}
          return pending;
        };
        const finishOrigin = () => {
          if (!originPending || this.active !== token) return false;
          originPending = false; this.active = null; this.pendingCallbacks = null;
          stopPeer();
          this.releaseFetch?.(); this.releaseFetch = null;
          return true;
        };
        timer = setTimeout(stopPeer, swarm.options.maxPeerWaitMs);
        swarm.counters.originFallbacks += 1;
        swarm.#peerEligibility(context, 0, "no-budget", null, budgetGeometry);
        // Start HTTP before hashing a key or fetching/verifying metadata.
        try { this.inner.load(context, config, {
          ...callbacks,
          onProgress: (...args) => {
            if (!originPending || this.active !== token) return;
            if (args[2]?.byteLength > 0) { originClaimed = true; stopPeer(); }
            callbacks.onProgress?.(...args);
          },
          onError: (...args) => { if (finishOrigin()) callbacks.onError?.(...args); },
          onTimeout: (...args) => { if (finishOrigin()) callbacks.onTimeout?.(...args); },
          onAbort: (...args) => { if (finishOrigin()) callbacks.onAbort?.(...args); },
          onSuccess: (response, stats, ctx, details) => {
            if (!finishOrigin()) return;
            const receivedMs = firstByteWallMs(stats);
            const { copy, size } = swarm.#originCopy(response, context);
            pushSample(swarm.originLatencySamples, now() - t0);
            swarm.#renditionSample(swarm.renditionOriginSamples, context, now() - t0);
            callbacks.onSuccess(response, stats, ctx, details);
            swarm.#noteOriginClock(details, receivedMs);
            if (size && !swarm.stopped) swarm.#guard("cached-race-origin", async () => {
              swarm.counters.originLoaded += 1; swarm.counters.bytesFromOrigin += size;
              const key = await swarm.#segmentKey(context);
              if (copy && !swarm.stopped) swarm.#hold(key, new Uint8Array(copy));
            });
          },
        }); } catch (error) { finishOrigin(); throw error; }
        if (!originPending) return;
        swarm.#segmentKey(context).then(key => {
          if (originPending && !swarm.stopped) this.releaseFetch = swarm.#claimOrigin(key);
        }).catch(() => {});
        const plan = { deadline: t0 + swarm.options.maxPeerWaitMs, limit: t0 + swarm.options.maxPeerWaitMs,
          originReserveMs: 0, expired: false, onDeadline: null, cachedOnly: cached, lateHaveRace: swarm.options.lateHaveRace,
          peerOnly: true, extend: () => false };
        swarm.#traceBegin(context, 0, swarm.options.maxPeerWaitMs, budgetGeometry);
        swarm.#peerFirst(context, controller.signal, plan, 0, budgetGeometry).then(result => {
          if (!result || !originPending || originClaimed || this.active !== token || controller.signal.aborted || swarm.stopped || now() >= plan.limit) return;
          originPending = false; this.active = null; this.pendingCallbacks = null;
          stopPeer();
          this.releaseFetch?.(); this.releaseFetch = null;
          // The losing HTTP arm must never surface its abort/error callback.
          try { this.inner.abort(); } catch {}
          swarm.counters.zeroBudgetPeerRaceWins += 1;
          swarm.#completePeerLoad(this, result, context, callbacks, t0);
        }).catch(error => {
          if (originPending && !controller.signal.aborted && !swarm.stopped) swarm.#noteError("cached-race", error);
        }).finally(stopPeer);
      }
      loadLatePeerRace(context, config, callbacks, budgetGeometry, parentMs) {
        const token = {}, controller = new AbortController(), t0 = now();
        let originPending = true, originClaimed = false, watch;
        this.active = token; this.pendingCallbacks = { callbacks, context };
        Object.assign(this.inner.stats, { aborted: false, loaded: 0, total: 0, chunkCount: 0, loading: { start: 0, first: 0, end: 0 } });
        const current = () => originPending && !originClaimed && this.active === token && !swarm.stopped;
        const finishOrigin = reason => {
          if (!originPending || this.active !== token) return false;
          originPending = false; this.active = null; this.pendingCallbacks = null;
          watch?.close(reason); this.releaseFetch?.(); this.releaseFetch = null;
          return true;
        };
        this.cancel = () => {
          const pending = originPending && this.active === token;
          originPending = false; this.active = null; watch?.close('caller-abort');
          this.releaseFetch?.(); this.releaseFetch = null;
          try { this.inner.abort(); } catch {}
          return pending;
        };
        watch = swarm.#watchLatePeer({ context, controller, entryAt: t0, parentDeadline: t0 + parentMs, current,
          arm: (peerContext, plan) => swarm.#peerFirst(peerContext, controller.signal, plan, 0, budgetGeometry).then(result => {
            if (!result || !current() || controller.signal.aborted || now() >= plan.limit || !watch.valid() ||
                typeof plan.revalidateAuthority !== 'function' || !plan.revalidateAuthority()) return false;
            originPending = false; this.active = null; this.pendingCallbacks = null;
            watch.close('peer-won', 'won'); this.releaseFetch?.(); this.releaseFetch = null;
            try { this.inner.abort(); } catch {}
            swarm.counters.zeroBudgetPeerRaceWins++;
            // A promoted warm object keeps its original accounting role; only
            // the real hls.js consumer later accepts its verified peer bytes.
            swarm.#completePeerLoad(this, result, context, callbacks, t0);
            return true;
          }),
        });
        swarm.counters.originFallbacks++;
        swarm.#peerEligibility(context, 0, 'no-budget', null, budgetGeometry);
        try { this.inner.load(context, config, {
          ...callbacks,
          onProgress: (...args) => {
            if (!originPending || this.active !== token) return;
            if (args[2]?.byteLength > 0) { originClaimed = true; watch?.close('origin-progress'); }
            callbacks.onProgress?.(...args);
          },
          onError: (...args) => { if (finishOrigin('origin-error')) callbacks.onError?.(...args); },
          onTimeout: (...args) => { if (finishOrigin('origin-timeout')) callbacks.onTimeout?.(...args); },
          onAbort: (...args) => { if (finishOrigin('origin-abort')) callbacks.onAbort?.(...args); },
          onSuccess: (response, stats, ctx, details) => {
            if (!finishOrigin('origin-success')) return;
            const receivedMs = firstByteWallMs(stats), { copy, size } = swarm.#originCopy(response, context);
            pushSample(swarm.originLatencySamples, now() - t0);
            swarm.#renditionSample(swarm.renditionOriginSamples, context, now() - t0);
            callbacks.onSuccess(response, stats, ctx, details); swarm.#noteOriginClock(details, receivedMs);
            if (size && !swarm.stopped) swarm.#guard('late-race-origin', async () => {
              swarm.counters.originLoaded++; swarm.counters.bytesFromOrigin += size;
              const key = await swarm.#segmentKey(context);
              if (copy && !swarm.stopped) swarm.#hold(key, new Uint8Array(copy));
            });
          },
        }); } catch (error) { finishOrigin('origin-throw'); throw error; }
        if (!originPending) return;
        watch?.keyPromise.then(key => {
          if (originPending && this.active === token && !swarm.stopped) this.releaseFetch = swarm.#claimOrigin(key);
        }).catch(() => {});
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

  // An origin response's size, and a copy of its bytes only when #hold may
  // keep them. Copied before the player sees the buffer, which it may transfer.
  #originCopy(response, context) {
    try {
      const data = response.data, size = data?.byteLength;
      if (!size) return { copy: null, size: 0 };
      return { copy: this.#mayServe() && !context?.[WARM_AHEAD] ? data.slice(0) : null, size };
    } catch { return { copy: null, size: 0 }; }
  }

  #peerRaceCapacity() {
    return this.cachedRaces.size + [...this.latePeerOwners.values()].filter(owner => !owner.attempted).length < this.options.maxConcurrentRaces;
  }

  #latePeerEvent(owner, outcome, reason, holders) {
    this.latePeerCounts[outcome]++;
    if (this.latePeerRows.length === 64) { this.latePeerRows.shift(); this.latePeerDropped++; }
    const frag = owner.identity.context.frag, relative = value => value === null ? null : Math.max(0, Math.round(value - this.transportStartedAt));
    this.latePeerRows.push({ id: owner.id, atMs: relative(now()), sequence: frag.sn, cc: frag.cc, level: frag.level,
      genuineAtMs: relative(owner.genuineAt), windowEndAtMs: relative(owner.windowEnd), armedAtMs: relative(owner.armedAt ?? null),
      deadlineAtMs: relative(owner.peerLimit ?? null), outcome, reason,
      ...(holders ? { holders: holders.map(link => this.#holderLabel(link.pubkey)) } : {}) });
  }

  #retireLatePeers(reason) {
    for (const owner of [...this.latePeerOwners.values()]) owner.close(reason);
  }

  #checkLatePeers() {
    for (const owner of [...this.latePeerOwners.values()]) owner.refresh();
  }

  #watchLatePeer(input) {
    const identity = warmContext(input.context);
    if (!identity || !this.#peerRaceCapacity()) return null;
    const warm = input.context[WARM_AHEAD], directAt = input.entryAt, media = this.hls?.media;
    const owner = { ...input, identity, id: this.latePeerNextId++, generation: this.latePeerGeneration,
      streamId: this.options.streamEvent?.id, genuineAt: null, windowEnd: null, attempted: false, closed: false, key: null, timer: null };
    const watching = new AbortController();
    const clearTimer = () => { clearTimeout(owner.timer); this.timers.delete(owner.timer); owner.timer = null; };
    owner.close = (reason, outcome = 'retired') => {
      if (owner.closed) return;
      owner.closed = true; clearTimer(); watching.abort();
      if (warm?.onGenuine === owner.refresh) delete warm.onGenuine;
      this.latePeerOwners.delete(owner.id); this.cachedRaces.delete(owner.controller);
      owner.controller.abort(); this.#latePeerEvent(owner, outcome, reason);
    };
    const genuine = () => warm ? warm.genuine?.() : { at: directAt, context: input.context };
    const eligible = (link, context) => this.links.get(link.pubkey) === link && this.#peerEntryAvailable(link, context) &&
      link.supportsRanges === true && (this.remoteFraming.get(link.pubkey) ?? 1) >= 2 && !this.banned.has(link.pubkey) && link.have.has(owner.key);
    const currentContext = () => {
      const demand = genuine();
      if (!demand || !Number.isFinite(demand.at) || warmContext(demand.context)?.key !== identity.key) return null;
      return warm ? { ...demand.context, [WARM_AHEAD]: warm } : demand.context;
    };
    owner.valid = () => !owner.closed && input.current() && !this.stopped && owner.generation === this.latePeerGeneration &&
      owner.streamId === this.options.streamEvent?.id && currentContext() !== null && !media?.paused && !media?.ended &&
      now() < (owner.peerLimit ?? owner.windowEnd ?? input.parentDeadline) &&
      [...(owner.validatedPeers ?? [])].every(([link, ticket]) => this.links.get(link.pubkey) === link && !link.closed &&
        !this.banned.has(link.pubkey) && (!this.options.admit || this.admitted.get(link.pubkey)?.ticket === ticket));
    owner.refresh = () => {
      if (owner.closed) return;
      if (!input.current() || this.stopped || owner.generation !== this.latePeerGeneration || owner.streamId !== this.options.streamEvent?.id) return owner.close('inactive');
      const demand = genuine();
      if (!demand) { if (owner.genuineAt !== null) owner.close('no-genuine-consumer'); return; }
      const context = currentContext();
      if (!context || media?.paused || media?.ended) return owner.close('context-or-playback');
      if (owner.genuineAt === null) {
        owner.genuineAt = demand.at;
        owner.windowEnd = Math.min(input.parentDeadline, demand.at + Math.min(4000, this.options.lateWindowMs));
        this.#latePeerEvent(owner, 'entered', 'genuine-demand');
        owner.timer = this.#after(Math.max(0, owner.windowEnd - now()), () => owner.close('window-expired', 'expired'));
      }
      if (now() >= owner.windowEnd) return owner.close('window-expired', 'expired');
      if (owner.attempted || !owner.key || !this.#rangesEnabled()) return;
      const captured = [...this.links.values()].filter(link => eligible(link, context));
      if (!captured.length) return;
      // This is the first peer arm, not a retry or renewal of an old plan.
      // Reserve it before admission/commitment/worker work can yield.
      owner.attempted = true;
      const limit = Math.min(owner.windowEnd, now() + Math.min(2500, this.options.maxPeerWaitMs), input.parentDeadline);
      owner.armedAt = now(); owner.peerLimit = limit;
      clearTimer(); owner.timer = this.#after(Math.max(0, limit - now()), () => owner.close('peer-expired', 'expired'));
      this.cachedRaces.add(owner.controller); this.#latePeerEvent(owner, 'armed', 'accepted-exact-have', captured);
      void (async () => {
        const admitted = await Promise.all(captured.map(async link => {
          if (!this.options.admit) return link;
          const ticket = this.admissionChecks.get(link.pubkey)?.ticket ?? this.admitted.get(link.pubkey)?.ticket;
          let accepted = false;
          try { accepted = await boundedOperation(() => this.#admits(link.pubkey, ticket, 'other'), owner.controller.signal,
            Math.max(0, Math.min(this.options.admissionTimeoutMs, limit - now()))) === true; } catch {}
          if (!accepted && !owner.closed) link.close('admission');
          return accepted ? link : null;
        }));
        if (owner.closed) return;
        const fresh = currentContext();
        if (!input.current() || !fresh || now() >= limit || owner.generation !== this.latePeerGeneration) return owner.close('inactive-after-admission');
        const peers = admitted.filter(link => link && eligible(link, fresh));
        if (!peers.length) return owner.close('admission-or-have-refused', 'refused');
        owner.validatedPeers = new Map(peers.map(link => [link, this.admitted.get(link.pubkey)?.ticket]));
        const immutable = warmContext(fresh)?.context;
        if (!immutable || !owner.valid()) return owner.close('context-after-admission');
        const plan = { deadline: limit, limit, originReserveMs: 0, expired: false, onDeadline: null,
          knownKey: owner.key, cachedOnly: new Map(peers.map(link => [link, new Set([owner.key])])),
          lateHaveRace: false, peerOnly: true, extend: () => false, currentValid: owner.valid, revalidateAuthority: true };
        const won = await input.arm(immutable, plan);
        if (!won && !owner.closed) owner.close('peer-no-result', 'refused');
      })().catch(() => { if (!owner.closed) owner.close('peer-error', 'refused'); });
    };
    this.latePeerOwners.set(owner.id, owner);
    if (warm) warm.onGenuine = owner.refresh;
    for (const name of ['pause', 'ended', 'emptied']) media?.addEventListener?.(name, () => owner.close(`media-${name}`), { signal: watching.signal });
    owner.keyPromise = this.#segmentKey(input.context).then(key => {
      owner.key = key; if (!owner.closed) owner.refresh(); return key;
    }, error => { owner.close('key-refused', 'refused'); throw error; });
    owner.keyPromise.catch(() => {});
    owner.refresh();
    return owner;
  }

  #completePeerLoad(loader, result, context, callbacks, t0) {
    const end = now(), size = result.bytes.byteLength;
    loader.peerStats = loader.inner.stats;
    Object.assign(loader.peerStats, { aborted: false, loaded: size, total: size, chunkCount: 1,
      bwEstimate: size * 8_000 / Math.max(1, end - t0), loading: { start: t0, first: end, end },
      parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 } });
    const peerBytes = result.multi ? result.peerBytes : size;
    // Network reception is recorded once. Speculation is not a delivery to
    // hls.js until the genuine player later consumes that verified object.
    this.counters.bytesFromPeers += peerBytes;
    const accept = acceptedContext => {
      if (peerBytes > 0) this.counters.peerFirstLoaded += 1;
      this.counters.peerFirstBytes += peerBytes;
      if (peerBytes > 0) {
        if (!result.multi) {
          this.discovery.holderDelivered(result.holderContext, result.pubkey);
          this.#noteUsefulLink(this.links.get(result.pubkey), size);
        }
        else {
          const contributed = new Map(result.contributions.filter(row => row.bytes > 0).map(row => [row.connection, row.bytes]));
          const refreshed = new Map((result.shortRefreshes || []).map(row => [row.connection, row.at]));
          for (const link of this.links.values()) if (contributed.has(link.pc)) {
            this.discovery.holderDelivered(result.holderContext, link.pubkey);
            this.#noteUsefulLink(link, contributed.get(link.pc), refreshed.get(link.pc));
          }
        }
        if (this.discovery.verified(result.discoveryContext) && this.discovery.window?.context === result.discoveryContext) this.#endDiscovery();
        if (this.firstPeerSegmentAtMs === null) this.firstPeerSegmentAtMs = Date.now() - this.startedAt;
        pushSample(this.peerLatencySamples, end - t0);
        if (acceptedContext.frag) this.peerFragments.add(acceptedContext.frag);
      }
      if (typeof this.options.onPeerDelivery === "function") {
        const contributions = result.multi ? result.contributions : [{ connection: result.connection, bytes: size }];
        for (const { connection, bytes } of contributions) {
          if (bytes <= 0) continue;
          try {
            const observed = this.options.onPeerDelivery({ connection, bytes });
            if (observed && typeof observed.then === "function") Promise.resolve(observed).catch(() => {});
          } catch {}
        }
      }
    };
    if (context[WARM_AHEAD]) Object.assign(context[WARM_AHEAD], { peerBytes, accept });
    else accept(context);
    // #hold keeps nothing while serving is off or the key is already held.
    if (!context[WARM_AHEAD] && this.#servingAllowed() && !this.held.has(result.key)) this.#hold(result.key, result.bytes.slice());
    callbacks.onSuccess({ url: context.url, data: result.bytes.buffer, code: 200 }, loader.peerStats, context, null);
  }

  // Observe the next demanded timeline position in each loaded rendition.
  // Other playlists are never fetched here. HAVE knowledge is all we have
  // for another rendition: discovery retains only the playing context.
  async #reportPlayerHints(context, availableMs) {
    if (!context?.frag || context.frag.sn === "initSegment" || context.part || this.stopped) return;
    const generation = ++this.hintGeneration;
    const levels = this.hls?.levels || [];
    const contexts = levels.length ? levels.map((level, index) => {
      if (index === context.frag.level) return context;
      const frag = level.details?.fragments?.find((frag) => frag.sn === context.frag.sn && frag.cc === context.frag.cc);
      return frag ? { url: frag.url, frag, rangeStart: frag.byteRangeStartOffset, rangeEnd: frag.byteRangeEndOffset } : null;
    }) : [context];
    const rows = await Promise.all(contexts.map(async (candidate, index) => {
      const rendition = candidate ? this.#renditionContext(candidate) : `main:${index}`;
      const key = candidate ? await this.#segmentKey(candidate) : null;
      if (this.stopped || generation !== this.hintGeneration) return null;
      const discovery = candidate && this.discovery.contexts.get(candidate.frag.type || "main");
      const peers = key ? [...this.links.values()].filter((link) => this.#peerFree(link) && link.have.has(key)
        && link.supportsRanges === true && (this.remoteFraming.get(link.pubkey) ?? 1) >= 2 && !this.banned.has(link.pubkey)
        && !(discovery?.rendition === rendition && this.discovery.stale(discovery, link.pubkey))).map((link, index) => {
        const rate = this.peerSelection.summary(link).throughputBytesPerSecond;
        return [index + 1, null, rate ? rate / 1000 : null];
      }) : [];
      // Size and origin timing are estimates from this rendition's previous
      // loads, with playlist bitrate/segment duration as the size fallback,
      // not a claim to know an unrequested commitment. Unknown stays null.
      const observedSize = candidate ? this.renditionSizes.get(rendition) ?? this.hintSizes.get(rendition) ?? null : null;
      const bitrateSize = candidate ? Math.ceil((levels[index]?.bitrate ?? 0) * (candidate.frag.duration ?? 0) / 8) : 0;
      const size = observedSize ?? (bitrateSize > 0 && bitrateSize <= this.options.maxSegmentBytes ? bitrateSize : null);
      const originMs = percentile(this.renditionOriginSamples.get(rendition) || [], 0.5);
      const supply = { rendition, size, peers, origin: [null, size && originMs ? size / originMs : percentile(this.hintOriginRates, 0.5)],
        sharedFirstByteMs: this.peerSelection.firstByteMs(), sharedRate: this.peerSelection.rate(),
        availableMs, maxHolders: this.options.maxHoldersPerObject };
      const command = this.core?.playerHint(supply);
      if (command && this.options.traceRequests) this.#trace({ k: "playerHint", at: this.#traceAt(), input: supply, out: command });
      return command ? { ...command, level: candidate?.frag.level ?? index, sequence: candidate?.frag.sn ?? null,
        sizeEstimate: size, sizeEstimateSource: observedSize !== null ? "observed" : size !== null ? "playlist-bitrate" : null, knowledge: "linked-have" } : null;
    }));
    if (this.stopped || generation !== this.hintGeneration) return;
    this.playerHints = rows.filter(Boolean);
    if (this.playerHints.length) this.options.onPlayerHint?.(structuredClone(this.playerHints));
  }

  #renditionContext(context) {
    const media = segmentMediaContext(context);
    return media ? `${media.mediaType}:${media.playlist}` : `${context.frag.type || "main"}:${context.frag.level}`;
  }

  #contributionContext(context) {
    if (this.stopped || !context.frag || context.frag.sn === "initSegment") return;
    // Discovery may move into the core only while it holds no state.
    if (this.coreWait) return;
    const rendition = this.#renditionContext(context);
    if (this.latePeerOwners.size && context.frag.type === 'main') {
      const scope = warmContext(context)?.scope;
      if (scope) for (const owner of [...this.latePeerOwners.values()]) if (owner.identity.scope !== scope) owner.close('rendition');
    }
    this.discovery.context(context.frag.type || "main", rendition);
    this.#expireDiscovery(false);
    const previous = this.renditions.get(rendition);
    for (const [identity, seen] of this.renditions) if (seen < Date.now() - 30_000) this.renditions.delete(identity);
    if (!this.renditions.has(rendition) && this.renditions.size >= 8) this.renditions.delete(this.renditions.keys().next().value);
    this.renditions.set(rendition, Date.now());
    this.rendition = rendition;
    if (!previous) for (const link of this.links.values()) link.sendContribution(this.#servingAllowed(), rendition);
  }

  #shouldWaitForOrigin(key, rendition, context) {
    const at = Date.now();
    const candidates = [...this.links.values()].filter((peer) => !peer.closed && peer.contribution?.serving
      && (peer.renditions.get(rendition) || 0) > at - 30_000);
    if (!candidates.length) return false;
    if (candidates.some((peer) => (peer.fetching.get(key) || 0) > at)) return true;
    // A VOD contributor may be behind this viewer's prefetch frontier. Only
    // the exact main rendition's explicit ENDLIST state establishes VOD;
    // alternate audio indexes audioTracks, not levels. Live and unknown
    // playlists retain bounded rendezvous coordination for synchronous release.
    const frag = context?.frag;
    if (frag?.type === "main" && Number.isInteger(frag.level) && frag.level >= 0
      && this.hls?.levels?.[frag.level]?.details?.live === false) return false;
    if (!this.#servingAllowed()) return true;
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
    // Speculation never reserves a positive peer-only wait or asks a mixed
    // transfer to create origin ranges. Cached peers can still race the one
    // immediately started whole-object HTTP request through the usual path.
    if (context?.[WARM_AHEAD]) { geometry.source = "warm-ahead"; return 0; }
    const media = this.hls?.media;
    let sustainableMs = Infinity;
    if (this.options.sustainablePeerWait) {
      let durationMs = null;
      try {
        const part = context?.part, duration = part ? part.duration : context?.frag?.duration;
        if (Number.isFinite(duration) && duration > 0 && Number.isFinite(duration * 1_000)) durationMs = duration * 1_000;
      } catch {}
      const originP90 = percentile(this.#originSamples(context), 0.9);
      const originRecoveryMs = originP90 === null ? null : originP90 * 1.25 + 100;
      // An assumed reserve cannot calibrate cold HTTP recovery. Missing
      // timing/geometry or no spare duration starts HTTP immediately; the
      // separate cached/late-HAVE peer race retains its parallel window.
      sustainableMs = durationMs === null || originRecoveryMs === null ? 0 : Math.max(0, durationMs - originRecoveryMs);
      Object.assign(geometry, { durationMs, originRecoveryMs, sustainableMs });
    }
    if (!media) { geometry.source = "no-media"; return Math.min(this.options.originFallbackMs, sustainableMs); }
    try {
      for (let i = 0; i < media.buffered.length; i++) {
        if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) > media.currentTime) {
          // Leave measured origin recovery time and a reserve for appending.
          // A newly selected ABR rendition uses its fragment's actual playback
          // position, rather than borrowing an unrelated long buffer tail.
          const originReserve = Math.max(this.options.originReserveMs, (percentile(this.#originSamples(context), 0.9) || 0) * 1.25 + 100);
          // A later LL-HLS part has its own playback position. Using the
          // parent's start discards already buffered earlier parts and can
          // reduce every safe peer opportunity to a zero-length budget.
          let partStart, bufferedEnd, currentTime;
          const fragStart = (partStart = context?.part?.start) ?? context?.frag?.start;
          const playableEnd = Number.isFinite(fragStart) && fragStart > media.currentTime ? Math.min(bufferedEnd = media.buffered.end(i), fragStart) : (bufferedEnd = media.buffered.end(i));
          const uncappedMs = Math.max(0, (playableEnd - (currentTime = media.currentTime)) * 1000 - originReserve);
          const budgetMs = Math.min(this.options.originFallbackMs, uncappedMs, sustainableMs);
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

  // A holder label is a local counter, not a key. It is assigned when a remote
  // peer first becomes a link and kept across PC replacement, in a bounded map.
  #assignHolderLabel(pubkey) {
    if (this.holderLabels.has(pubkey)) return;
    this.holderLabels.set(pubkey, this.holderLabelNext++);
    if (this.holderLabels.size <= 64) return;
    // Evict the oldest label of a peer that is not linked now, so a live link
    // keeps its label. If every entry is linked, evict the oldest regardless.
    const evicted = [...this.holderLabels.keys()].find((held) => !this.links.has(held)) ?? this.holderLabels.keys().next().value;
    this.holderLabels.delete(evicted);
  }

  #holderLabel(pubkey) { return this.holderLabels.get(pubkey) ?? 0; }

  // Labels for a diagnostic row: serving links, links holding the key, the
  // serving links that are stale, and the links recorded as a held miss on this
  // decision (filled in when the load ends). Reads only; no decision depends on it.
  #holderDiagnostics({ key, rendition, context }) {
    const small = (labels) => labels.sort((a, b) => a - b).slice(0, 8);
    const holders = [], haveHolders = [], staleHolders = [];
    for (const link of this.links.values()) {
      const label = this.#holderLabel(link.pubkey);
      if (this.#servesRendition(link, rendition)) {
        holders.push(label);
        if (this.discovery.stale(context, link.pubkey)) staleHolders.push(label);
      }
      if (link.have.has(key)) haveHolders.push(label);
    }
    return { holders: small(holders), haveHolders: small(haveHolders), staleHolders: small(staleHolders), heldMissHolders: [] };
  }

  // The outcome of a load that went to origin, recorded once per load.
  //  - Nobody held the key (and the caller says the wait or entry projection ended
  //    with nobody ahead): every serving link takes a miss.
  //  - Otherwise only a link that was judged takes a held miss: one that was asked
  //    and did not deliver a verified segment in time, or one named in `unfit`
  //    (it held the key and its own estimate did not fit the room). A decline made
  //    on swarm-wide estimates or on the buffer (projected-late, skipped-late)
  //    charges no holder, and a link that was never asked is left alone.
  // Delivered, aborted and other neutral outcomes never reach here. Advisory.
  #recordOutcome(demand, { everyServing = false, unfit = [] } = {}) {
    const { key, rendition, context } = demand;
    if (!context || demand.recorded) return;
    demand.recorded = true;
    try {
      const serving = [...this.links.values()].filter((link) => this.#servesRendition(link, rendition));
      if (everyServing && ![...this.links.values()].some((link) => link.have.has(key))) {
        for (const link of serving) this.discovery.holderMiss(context, link.pubkey, key);
        return;
      }
      const judged = serving.filter((link) => demand.asked.has(link.pubkey) || unfit.includes(link.pubkey));
      const labels = [];
      for (const link of judged) {
        if (!this.discovery.holderMiss(context, link.pubkey, key)) continue;
        this.discovery.counters.heldMiss++;
        labels.push(this.#holderLabel(link.pubkey));
      }
      if (labels.length && demand.row?.heldMissHolders) demand.row.heldMissHolders = labels.sort((a, b) => a - b).slice(0, 8);
    } catch {}
  }

  // The demand-time seek began no attempt although the context is unmet only
  // because its serving links are stale and a fresh eligible candidate hints a
  // demanded key: a bound (spent allowance, no room or victim, no outgoing
  // slot, an attempt in flight) held it back, rather than a lack of candidates.
  #noteStaleBlocked(context, checksBefore) {
    if (this.stopped || this.options.mode !== "peer-first" || this.discovery.counters.checks !== checksBefore) return;
    if (!this.discovery.current(context) || !this.#unmetDiscovery(context) || !this.#onlyStaleServing(context)) return;
    if (this.discovery.hinted(context, (candidate) => this.#discoveryEligible(candidate))) this.discovery.counters.staleBlocked++;
  }

  #peerEligibility(context, budgetMs, reason, matchingHave, budgetGeometry, projection, demand, trial = false) {
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
      // Set only on the row that records an untested-holder trial grant.
      if (trial === true) record.trial = true;
      // Only decisions that already computed the key and inspected links.
      if (demand) {
        try { Object.assign(record, this.#holderDiagnostics(demand)); }
        catch { Object.assign(record, { holders: null, haveHolders: null, staleHolders: null, heldMissHolders: null }); }
        // The latest row of this decision is the one a held miss annotates.
        demand.row = record;
      }
      this.peerEligibilityCounters[reason] = increment(this.peerEligibilityCounters[reason]);
      if (this.peerEligibilityRecords.length === 64) {
        this.peerEligibilityRecords.shift();
        this.peerEligibilityDropped = increment(this.peerEligibilityDropped);
      }
      this.peerEligibilityRecords.push(record);
      if (this.options.traceRequests) this.#trace({ k: "eligibility", load: this.#traceLoad(context), at: this.#traceAt(), ...structuredClone(record) });
    } catch {}
  }

  #renditionSample(map, context, value) {
    const rendition = this.#renditionContext(context);
    if (!map.has(rendition) && map.size >= 16) map.delete(map.keys().next().value);
    const list = map.get(rendition) || [];
    pushSample(list, value);
    map.set(rendition, list);
  }

  #originSamples(context) {
    try {
      const own = context?.frag && this.renditionOriginSamples.get(this.#renditionContext(context));
      return own?.length ? own : this.originLatencySamples;
    } catch { return this.originLatencySamples; }
  }

  #observeOriginRange(context, elapsedMs, bytes, objectSize) {
    // A substantial range measures HTTP service for this rendition. Scale by
    // its actual byte count: a short tail is not a whole-object latency sample.
    // Ignore tiny endgame ranges, whose startup cost would be amplified.
    if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs) || bytes < Math.max(MIN_LINK_FLOW_BYTES, objectSize / 2)) return;
    const equivalentMs = Math.min(60_000, elapsedMs * objectSize / bytes);
    pushSample(this.originLatencySamples, equivalentMs);
    this.#renditionSample(this.renditionOriginSamples, context, equivalentMs);
  }

  #linkTimingState(link) {
    let state = this.linkTimings.get(link);
    if (!state) {
      state = { firstBytes: [], flows: [], probeAt: -Infinity, usefulAt: -Infinity };
      this.linkTimings.set(link, state);
    }
    return state;
  }

  #observeLinkTiming(link, result) {
    if (this.stopped || link.closed) return;
    if (["abort", "timeout", "abandoned", "none", "send-error"].includes(result.outcome)) {
      const prior = this.linkTimings.get(link);
      if (prior) { prior.usefulAt = -Infinity; prior.probeAt = now(); }
    }
    if (!["payload", "timeout", "abandoned"].includes(result.outcome)) return;
    const first = result.firstByteMs, elapsed = result.elapsedMs, bytes = result.receivedBytes;
    if (!Number.isFinite(first) || first < 0 || !Number.isFinite(elapsed) || elapsed < first || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    const state = this.#linkTimingState(link), at = now();
    state.firstBytes.push({ value: Math.min(60_000, first), at });
    if (state.firstBytes.length > LINK_TIMING_SAMPLES) state.firstBytes.shift();
    const flowMs = elapsed - first;
    if (flowMs >= MIN_LINK_FLOW_MS && bytes >= MIN_LINK_FLOW_BYTES) {
      state.flows.push({ value: Math.min(1_000_000, bytes / flowMs), flowMs, at });
      if (state.flows.length > LINK_TIMING_SAMPLES) state.flows.shift();
    }
  }

  #noteUsefulLink(link, bytes, refreshedAt = null) {
    if (!link || link.closed || !Number.isSafeInteger(bytes) || bytes <= 0) return;
    const state = this.#linkTimingState(link);
    // A refresh that actually contributes fast short-flow media disproves the
    // old pessimistic rate. Return to unknown, rather than inventing a rate
    // below the flow floor; retain any later qualifying observations.
    if (Number.isFinite(refreshedAt)) state.flows = state.flows.filter(row => row.at >= refreshedAt);
    state.usefulAt = now();
  }

  #linkTransferEstimate(link, availableMs, pieceSize) {
    const state = this.#linkTimingState(link), at = now();
    state.firstBytes = state.firstBytes.filter(row => at - row.at <= LINK_TIMING_TTL_MS);
    state.flows = state.flows.filter(row => at - row.at <= LINK_TIMING_TTL_MS);
    // Another link's startup latency must never become this link's latency.
    const firstByteMs = state.firstBytes.reduce((estimate, row) => estimate === null ? row.value : (estimate + row.value) / 2, null);
    const long = state.flows.filter(row => row.flowMs >= (firstByteMs ?? 0) * 3);
    const rate = measuredQuantile((long.length >= 2 ? long : state.flows).map(row => row.value), 0.75);
    const fits = rate !== null && (firstByteMs ?? 0) + pieceSize / rate <= availableMs;
    // Verified useful short flows may continue without inventing a rate below
    // the 300ms floor. Otherwise a stale or pessimistic model gets at most one
    // demand-bound refresh per link per ten seconds, with an explicit one-piece
    // core allowance. No timer or speculative media fetch is added.
    const usefulUnknown = rate === null && (firstByteMs ?? 0) < availableMs && at - state.usefulAt <= LINK_TIMING_TTL_MS;
    if (!fits && !usefulUnknown) {
      if (at - state.probeAt >= LINK_REFRESH_MS) return { state, firstByteMs: null, rate: null, refresh: true };
      if (rate === null) return null;
    }
    return { state, firstByteMs, rate, refresh: false };
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

  // A link that is open, free, not banned, holds the key, has never had an
  // attempt recorded and is not stale for this context. The first such link in
  // link order: an untested link has no observation to order by.
  #untestedHolder(key, context) {
    for (const link of this.links.values()) {
      if (!this.#peerFree(link) || this.banned.has(link.pubkey) || !link.have.has(key)) continue;
      if (this.peerSelection.summary(link).attempts !== 0) continue;
      if (context && this.discovery.stale(context, link.pubkey)) continue;
      return link;
    }
    return null;
  }

  // A trial needs an untested holder and room for at least a typical first byte.
  #trialAvailable(demand, plan) {
    return plan.limit - now() > (this.peerSelection.firstByteMs() ?? 0) && Boolean(this.#untestedHolder(demand.key, demand.context));
  }

  async #peerFirst(context, signal, plan, budgetMs, budgetGeometry) {
    // The initial deadline; plan.deadline may grow from it. Test availability
    // instrumentation (test/support/broadcast-availability-transform.mjs)
    // reads this binding by name.
    const deadline = plan.deadline;
    // Worker opt-in cannot wait for future supply while its chosen transfer
    // engine is unavailable. The ordinary origin wrapper still owns caching
    // and statistics; unconfigured live/VOD coordination is unchanged.
    if (this.options.transferWorkerUrl !== undefined && this.transferWorkerState !== "ready") return null;
    const discoveryContext = this.discovery.contexts.get(context.frag.type || "main");
    const key = plan.knownKey ?? await this.#segmentKey(context);
    if (signal.aborted || this.stopped || plan.currentValid && !plan.currentValid()) {
      this.#peerEligibility(context, budgetMs, "aborted-before-eligibility", null, budgetGeometry);
      return null;
    }
    if (plan.cachedOnly) {
      const matching = (atEntry) => [...plan.cachedOnly].filter(([link, have]) => (!atEntry || have.has(key)) && link.have.has(key)
        && this.links.get(link.pubkey) === link && this.#peerEntryAvailable(link, context) && !this.banned.has(link.pubkey)
        && link.supportsRanges === true && (this.remoteFraming.get(link.pubkey) ?? 1) >= 2).map(([link]) => link);
      let holders = matching(true);
      if (!holders.length && plan.lateHaveRace) {
        // HTTP is already running. Observe actual HAVE on the accepted
        // load-entry links, never FETCH, a new neighbour or a replacement.
        holders = matching(false);
        while (!holders.length && !signal.aborted && !this.stopped && now() < plan.limit) {
          await this.#waitForHave(key, plan.limit - now(), signal);
          holders = matching(false);
        }
        plan.lateHaveMatched = holders.length > 0;
      }
      if (signal.aborted || this.stopped || now() >= plan.limit) return null;
      // Freeze once. Failure or corruption does not open another late-HAVE
      // trial or admit a holder that appeared after this snapshot.
      plan.cachedHolders = new Set(holders);
      if (!plan.cachedHolders.size || !this.#rangesEnabled()) return null;
      this.counters.zeroBudgetPeerRaces += 1;
    }
    const rendition = this.#renditionContext(context);
    const holderContext = discoveryContext?.rendition === rendition && this.discovery.contexts.get(discoveryContext.mediaType) === discoveryContext
      ? discoveryContext : null;
    if (holderContext && !plan.cachedOnly) {
      this.discovery.demand(discoveryContext.mediaType, rendition, key);
      const checks = this.discovery.counters.checks;
      this.#seekNeighbours();
      try { this.#noteStaleBlocked(holderContext, checks); } catch {}
    }
    // What the diagnostic rows and the holder bookkeeping below refer to.
    const demand = { key, rendition, context: holderContext, recorded: false, asked: new Set(), row: null };
    const coordinated = ![...this.links.values()].some((peer) => peer.have.has(key));
    if (coordinated && !this.#shouldWaitForOrigin(key, rendition, context)) {
      this.#peerEligibility(context, budgetMs, "no-have-no-wait", false, budgetGeometry, undefined, demand);
      return null;
    }
    // Go to origin at once, keeping the buffer, when the holder wait and the
    // transfer together cannot fit; otherwise allow the wait they need.
    const sizeHint = this.renditionSizes.get(rendition);
    const holderWait = coordinated ? this.#holderWaitMs(key, rendition) : 0;
    const entryTransfer = sizeHint ? this.peerSelection.projectMs(sizeHint) : null;
    // A mixed transfer need not obtain the whole object from a peer: the
    // piece planner can assign only a small bounded fraction and fetch the
    // rest from origin in parallel. Defer its admission until the signed
    // schema is known; v1/v2 and unavailable range paths retain the whole-
    // object projection below. No HAVE means no such exception.
    const mixedCandidate = !coordinated && this.#rangesEnabled() && [...this.links.values()].some((link) =>
      this.#peerEntryAvailable(link, context) && link.supportsRanges === true && link.have.has(key) && !this.banned.has(link.pubkey)
      && (this.remoteFraming.get(link.pubkey) ?? 1) >= 2 && !(holderContext && this.discovery.stale(holderContext, link.pubkey)));
    let entry = plan.cachedOnly || mixedCandidate ? "unknown" : this.#projection(entryTransfer, holderWait, plan);
    // One try for a holder that has never been asked (see #untestedHolder). The
    // detail is kept for the have-at-entry row, which is the row this load writes next.
    let trial = null;
    if (entry === "late" && !coordinated && this.#trialAvailable(demand, plan)) {
      trial = this.#projectionDetail("entry", entryTransfer, holderWait, plan);
      entry = "stretch";
    }
    if (entry === "late") {
      this.#peerEligibility(context, budgetMs, "projected-late", !coordinated, budgetGeometry, this.#projectionDetail("entry", entryTransfer, holderWait, plan), demand);
      // Nobody held the key at entry: a miss for every serving link. Otherwise
      // only the serving links that held it take a held miss.
      this.#recordOutcome(demand, { everyServing: true });
      this.counters.peerProjectedLate += 1;
      return null;
    }
    this.#applyProjection(entry, holderWait + entryTransfer, plan);
    if (coordinated) {
      this.#peerEligibility(context, budgetMs, "no-have-wait", false, budgetGeometry, undefined, demand);
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
      // No playlist manipulation or origin prefetch. The origin contributor
      // loads normally; coordination never moves the HTTP deadline.
      while (!signal.aborted && !this.stopped && now() < plan.deadline && ![...this.links.values()].some((peer) => peer.have.has(key))) {
        if (!this.#shouldWaitForOrigin(key, rendition, context)) {
          this.#peerEligibility(context, budgetMs, "wait-no-longer-eligible", false, budgetGeometry, undefined, demand);
          return null;
        }
        await this.#waitForHave(key, Math.min(100, plan.deadline - now()), signal);
      }
      const cancelled = signal.aborted || this.stopped;
      if (cancelled || now() >= plan.deadline) {
        this.#peerEligibility(context, budgetMs, cancelled ? "wait-aborted" : "wait-expired", null, budgetGeometry, undefined, demand);
        // A miss is the wait reaching its deadline, whether the loop or the
        // fallback timer saw it first. A loader abort or stop says nothing about
        // the holder. Decided by cause (plan.expired), never by comparing clocks.
        if (!cancelled || (plan.expired && !this.stopped)) this.#recordOutcome(demand, { everyServing: true });
        return null;
      }
    }
    this.#peerEligibility(context, budgetMs, coordinated || plan.lateHaveMatched ? "have-after-wait" : "have-at-entry", true, budgetGeometry, trial ?? undefined, demand, trial !== null);
    // Holding the key is not a delivery: leave every holder entry alone until a
    // verified segment arrives.
    let commitment, authorityEvent;
    try {
      const result = await commitmentResult;
      if (!result.ok) throw new Error("Commitment unavailable.");
      authorityEvent = result.event;
      commitment = this.#verifyCommitment(result.event, {
        streamEvent: this.options.streamEvent, swarmId: this.options.swarmId, key, context,
        maxSegmentBytes: this.options.maxSegmentBytes,
        delegation: this.options.delegation, revokedDelegationIds: this.options.revokedDelegationIds, delegationRevocations: this.options.delegationRevocations,
      });
    } catch { if (!this.stopped) this.counters.commitmentUnavailable += 1; return null; }
    if (!commitment) { this.counters.commitmentRejected += 1; return null; }
    if (plan.currentValid && !plan.currentValid()) return null;
    if (plan.revalidateAuthority === true) plan.revalidateAuthority = () => Boolean(this.#verifyCommitment(authorityEvent, {
      streamEvent: this.options.streamEvent, swarmId: this.options.swarmId, key, context,
      maxSegmentBytes: this.options.maxSegmentBytes, delegation: this.options.delegation,
      revokedDelegationIds: this.options.revokedDelegationIds, delegationRevocations: this.options.delegationRevocations,
    }));
    if (signal.aborted || this.stopped) return null;
    if (plan.cachedOnly && commitment.v !== 3) return null;
    if (!this.renditionSizes.has(rendition) && this.renditionSizes.size >= 16) this.renditionSizes.delete(this.renditionSizes.keys().next().value);
    this.renditionSizes.set(rendition, commitment.size);
    if (commitment.v === 3 && this.options.multiHolder) {
      const multi = await this.#multiHolder(context, signal, plan, key, commitment, discoveryContext);
      if (multi !== undefined) {
        if (multi && coordinated) this.counters.coordinatedPeerLoads += 1;
        return multi ? { ...multi, holderContext } : multi;
      }
    }
    if (plan.cachedOnly) return null;
    // The committed size is now known and a holder has it.
    const transfer = this.peerSelection.projectMs(commitment.size);
    let known = this.#projection(transfer, 0, plan);
    // The same single trial: a grant made at entry continues here, and otherwise one is
    // granted if available. The latest row of this decision takes the commitment detail.
    // An entry grant is not a second grant; the request loop re-checks the holder.
    if (known === "late" && !coordinated && (trial !== null || this.#trialAvailable(demand, plan))) {
      trial = this.#projectionDetail("commitment", transfer, 0, plan);
      known = "stretch";
      if (demand.row) { demand.row.projection = { ...trial }; demand.row.trial = true; }
    }
    if (known === "late") {
      // Judged on swarm-wide estimates, not on any link's own: no holder is charged.
      this.#peerEligibility(context, budgetMs, "projected-late", true, budgetGeometry, this.#projectionDetail("commitment", transfer, 0, plan), demand);
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
      // The first request of a load granted a trial goes to an untested holder.
      const trialLink = trial && tried.size === 0 ? this.#untestedHolder(key, demand.context) : null;
      if (trialLink) this.peerSelection.markSelected(trialLink);
      const link = trialLink ?? this.peerSelection.select([...this.links.values()].filter(peer => this.#peerFree(peer)), key, tried, commitment.size, room);
      if (!link) {
        if (![...this.links.values()].some((peer) => !peer.closed && !tried.has(peer.pubkey) && peer.have.has(key) && fits(peer, room))) {
          this.counters.peerNoFit += 1;
          // Holders whose own estimate does not fit, and links already asked and failed.
          this.#recordOutcome(demand, { unfit: [...this.links.values()].filter((peer) => !peer.closed && !tried.has(peer.pubkey) && peer.have.has(key) && !fits(peer, room)).map((peer) => peer.pubkey) });
          return null;
        }
        await this.#waitForHave(key, Math.min(100, plan.deadline - now()), signal);
        continue;
      }
      tried.add(link.pubkey); demand.asked.add(link.pubkey);
      if (trialLink) this.counters.peerUntestedTrial += 1;
      const estimateMs = this.peerSelection.estimate(link, commitment.size);
      if (estimateMs !== null && plan.extend(now() + estimateMs * 1.25 + 25)) this.counters.peerWaitExtended += 1;
      const requestedAt = now();
      const remainingMs = plan.deadline - now();
      const alternatives = [...this.links.values()].filter((peer) => this.#peerFree(peer) && !tried.has(peer.pubkey) && peer.have.has(key) && fits(peer, remainingMs)).length;
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
        this.#recordSelection(link, now() - requestedAt);
        this.counters.peerAbandoned += 1;
        this.#recordOutcome(demand);
        return null;
      }
      if (!bytes || signal.aborted || this.stopped) {
        if (!signal.aborted && !this.stopped) this.#recordSelection(link, now() - requestedAt);
        continue;
      }
      const digest = await sha256Hex(bytes);
      if (this.stopped) return null;
      if (bytes.byteLength !== commitment.size || digest !== commitment.sha256) {
        // Bad payloads are banned before cancellation and never charged as held misses.
        this.#recordSelection(link, now() - requestedAt);
        this.counters.peerCorrupt += 1;
        this.banned.add(link.pubkey);
        demand.asked.delete(link.pubkey);
        link.close("integrity");
        if (signal.aborted) {
          // An earlier asked link may still have failed in time: record once, as at the loop's end.
          if (plan.expired) this.#recordOutcome(demand);
          return null;
        }
        continue;
      }
      if (signal.aborted) {
        // The payload would have verified but the origin timer's deadline had passed: a to-origin outcome.
        if (plan.expired) this.#recordOutcome(demand);
        return null;
      }
      if (commitment.expiresAt <= Math.floor(Date.now() / 1000)) return null;
      this.#recordSelection(link, now() - requestedAt, bytes.byteLength);
      if (coordinated) this.counters.coordinatedPeerLoads += 1;
      if (trialLink) this.counters.peerUntestedTrialLoaded += 1;
      return { key, bytes, discoveryContext, holderContext, pubkey: link.pubkey, demand, connection: link.pc };
    }
    // The deadline passed or every holder tried failed. The origin timer's abort
    // (plan.expired) is the deadline; a caller abort or stop is neutral.
    if (!this.stopped && (!signal.aborted || plan.expired)) this.#recordOutcome(demand);
    return null;
  }

  #transferId(link) {
    let id = this.transferIds.get(link);
    if (id === undefined) { id = this.nextTransferId++; this.transferIds.set(link, id); }
    return id;
  }

  #peerFree(link) { return !link.closed && !link.busy && !this.peerLeases.has(link); }

  #peerEntryAvailable(link, context) {
    return this.#peerFree(link) || Boolean(context?.[WARM_AHEAD] && !link.closed && this.peerLeases.has(link));
  }

  #waitForPeerLease(candidates, deadline, signal) {
    this.peerAdmission.waited++;
    return new Promise(resolve => {
      let timer;
      const finish = reason => {
        if (!this.peerLeaseWaiters.delete(check)) return;
        clearTimeout(timer); this.timers.delete(timer);
        signal.removeEventListener('abort', cancel);
        this.peerAdmission[reason]++;
        resolve(reason === 'granted');
      };
      const cancel = () => finish('cancelled');
      const check = () => {
        if (this.stopped || signal.aborted) return cancel();
        if (now() >= deadline) return finish('expired');
        if (candidates.some(link => this.links.get(link.pubkey) === link && this.#peerFree(link))) finish('granted');
      };
      this.peerLeaseWaiters.add(check);
      signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish('expired'), Math.max(0, deadline - now())); this.timers.add(timer);
      check();
    });
  }

  // Schema 3 across framing 2 holders, with origin for a late tail, run by
  // the core's Transfer (CORE-SPEC section 6). Undefined when it does not
  // apply, so the single-holder path runs; null sends the load to origin.
  async #multiHolder(context, signal, plan, key, commitment, discoveryContext) {
    if (plan.currentValid && !plan.currentValid()) return null;
    const worker = this.options.transferWorkerUrl !== undefined;
    // An explicit worker opt-in must never quietly retry a large transfer on
    // the main thread after worker startup, policy, resource or runtime failure.
    if (worker && (!this.#rangesEnabled() || this.transferWorkerState !== "ready")) return null;
    if (!this.#rangesEnabled() || !Array.isArray(commitment.pieces)) return undefined;
    // An origin that once ignored a range sends whole segments, so a piece
    // from it would cost a full download and then fail the transfer.
    const originHost = urlOrigin(context.url);
    if (!plan.peerOnly && this.originsWithoutRanges.has(originHost)) return worker ? null : undefined;
    const eligible = link => this.links.get(link.pubkey) === link && !link.closed && link.supportsRanges === true && link.have.has(key)
      && !this.banned.has(link.pubkey) && (this.remoteFraming.get(link.pubkey) ?? 1) >= 2 && (!plan.cachedHolders || plan.cachedHolders.has(link));
    const captured = [...this.links.values()].filter(link => eligible(link) && this.#peerEntryAvailable(link, context));
    const available = () => captured.filter(link => eligible(link) && this.#peerFree(link));
    let candidates = available();
    if (!candidates.length && context?.[WARM_AHEAD] && captured.some(link => this.peerLeases.has(link))) {
      await this.#waitForPeerLease(captured, plan.limit, signal);
      candidates = available();
    }
    if (this.stopped || signal.aborted || now() >= plan.limit ||
        typeof plan.revalidateAuthority === 'function' && !plan.revalidateAuthority()) return null;
    if (!candidates.length) return worker ? null : undefined;
    const models = new Map(candidates.map(link => [link, this.#linkTransferEstimate(link, Math.max(0, plan.limit - now()), commitment.pieceSize)])
      .filter(([, model]) => model !== null));
    if (!models.size) { this.counters.peerNoFit += 1; return null; }
    const holders = [...models.keys()];
    const lease = {};
    for (const link of holders) this.peerLeases.set(link, lease);
    this.peerAdmission.claims += holders.length;
    const release = () => {
      signal.removeEventListener('abort', release);
      for (const link of holders) if (this.peerLeases.get(link) === lease) this.peerLeases.delete(link);
      // Let the completed genuine load publish its accepted-link observation
      // before speculative admission re-evaluates that same link's model.
      for (const waiter of [...this.peerLeaseWaiters]) this.#after(0, waiter);
      if (this.latePeerOwners.size) this.#after(0, () => this.#checkLatePeers());
    };
    signal.addEventListener('abort', release, { once: true });
    try {
    const ids = new Map(holders.map((link) => [this.#transferId(link), link]));
    // Peers may hold pieces until the buffer-safe limit; what is left then
    // goes to origin by range, within the origin reserve the limit keeps.
    const deadline = Math.floor(plan.limit);
    const hardDeadline = plan.peerOnly ? plan.limit : plan.limit + plan.originReserveMs;
    const config = { size: commitment.size, sha256: commitment.sha256, pieces: commitment.pieces,
      deadline, maxHolders: this.options.maxHoldersPerObject, originReserveMs: 0, ...(plan.peerOnly ? { peerOnly: true } : {}) };
    let transfer;
    try { transfer = worker ? await this.transferWorker.transfer(config, { signal }) : this.core.transfer(config); }
    catch { return null; }
    if (this.stopped || signal.aborted || (worker && now() >= deadline) || plan.currentValid && !plan.currentValid() ||
        typeof plan.revalidateAuthority === 'function' && !plan.revalidateAuthority() ||
        holders.some(link => !eligible(link) || link.busy || this.peerLeases.get(link) !== lease)) { transfer?.free(); return null; }
    if (!transfer) return worker || plan.peerOnly ? null : undefined;
    this.multiHolder.transfers += 1;
    // Each scheduler call, with its time, inputs and returned commands, so
    // the trace replays it (times relative to the trace base).
    const load = this.#traceLoad(context), base = this.traceBase;
    const xfer = (op, input, call) => {
      const at = Math.floor(now());
      const record = state => {
      if (this.options.traceRequests) this.#trace({ k: "xfer", load, op, at: at - base, ...input, out: state && {
        c: state.commands.map(({ t, peer, p }) => ({ t, ...(peer !== undefined ? { peer } : {}), ...(p ? { p: [...p] } : {}) })),
        next: state.next === null ? null : state.next - base, late: state.late, finished: state.finished } });
      return state;
      };
      const state = call(at);
      return state?.then ? state.then(record) : record(state);
    };
    plan.extend(plan.limit);
    const pieceSize = commitment.pieceSize;
    const bytesOf = ({ start, end }) => [start * pieceSize, Math.min(end * pieceSize, commitment.size)];
    const peers = [...ids].map(([id, link]) => [id, models.get(link).firstByteMs, models.get(link).rate]);
    const originMs = plan.peerOnly ? null : percentile(this.#originSamples(context), 0.5);
    // This is a whole HTTP service rate, already including HTTP startup.
    // A null first-byte value would borrow the unrelated peer median again.
    const origin = plan.peerOnly ? null : [0, originMs ? commitment.size / originMs : null];
    return await new Promise((resolve) => {
      const requests = new Map(), originRequests = new Set(), abandoned = new WeakSet(), contributions = new Map(), shortRefreshes = new Map();
      let finished = false, tickTimer = null, backstop = null, releaseOrigin = null, originShare = 0, verified = 0;
      // A source is credited only with the bytes its delivery newly
      // verified: a holder and origin can both send a piece, and the first
      // verified copy wins. The rest is counted as unused.
      const credit = (state, received) => {
        const fresh = state?.verified == null ? 0 : Math.max(0, state.verified - verified);
        if (state?.verified != null) verified = Math.max(verified, state.verified);
        this.multiHolder.unusedBytes += received - fresh;
        return fresh;
      };
      const begunAt = now();
      let slowestMs = 0, requestCount = 0;
      const clear = (timer) => { if (timer !== null) { clearTimeout(timer); this.timers.delete(timer); } return null; };
      const finish = (result) => {
        if (finished) return;
        finished = true;
        tickTimer = clear(tickTimer); backstop = clear(backstop);
        // Only a hopeless holder counts as abandoned; leftovers are plain aborts.
        for (const controller of [...requests.values(), ...originRequests]) controller.abort();
        releaseOrigin?.();
        plan.onDeadline = null;
        signal.removeEventListener("abort", onAbort);
        transfer.free();
        resolve(result);
      };
      const onAbort = () => finish(null);
      signal.addEventListener("abort", onAbort, { once: true });
      const submit = (op, input, call, accept = apply) => {
        if (finished) return;
        const receive = state => {
          if (finished) return;
          if (plan.currentValid && !plan.currentValid()) return finish(null);
          // A suspended/throttled page may process a worker message before
          // its already-expired timer. Fence all credit and commands using
          // the same absolute origin backstop, not timer task ordering.
          if ((worker || plan.peerOnly) && now() >= hardDeadline) return finish(null);
          if (!state) finish(null); else accept(state);
        };
        try {
          const result = xfer(op, input, call);
          if (result?.then) result.then(receive, () => finish(null)); else receive(result);
        } catch { finish(null); }
      };
      const run = (command, state) => {
        if (command.t === "request") {
          const link = ids.get(command.peer), controller = new AbortController();
          requests.set(command.peer, controller);
          const [from, to] = bytesOf(command.range), startedAt = now(), remainingMs = Math.max(1, deadline - startedAt);
          let report = null, reportedAt = -Infinity;
          requestCount += 1;
          if (models.get(link).refresh) {
            models.get(link).refreshStartedAt ??= now();
            models.get(link).state.probeAt = now();
          }
          // The transfer judges the flow, as the single-holder path does, so
          // a hopeless request is abandoned before the floor.
          const onProgress = (received) => {
            const at = now();
            if (finished || requests.get(command.peer) !== controller || at - reportedAt < PROGRESS_REPORT_MS) return;
            reportedAt = at;
            submit("progress", { source: command.peer, received }, (floored) => transfer.progress(floored, command.peer, received));
          };
          link.request(key, remainingMs, { signal: controller.signal, expectedSize: to - from, onProgress,
            range: { start: command.range.start, end: command.range.end, objectSize: commitment.size },
            onResult: (result) => { report = result; this.#peerRequestResult(context, link, remainingMs, result, command.range); } }).then((bytes) => {
            if (requests.get(command.peer) === controller) requests.delete(command.peer);
            slowestMs = Math.max(slowestMs, now() - startedAt);
            if (finished) return;
            if (report?.firstByteMs !== null && report?.elapsedMs !== null && report?.receivedBytes) {
              this.peerSelection.observe({ firstByteMs: report.firstByteMs, bytes: report.receivedBytes, flowMs: report.elapsedMs - report.firstByteMs });
            }
            if (bytes) {
              this.#recordSelection(link, now() - startedAt, bytes.byteLength);
              submit("delivered", { source: command.peer, p: [command.range.start, command.range.end], bytes: bytes.byteLength },
                (at) => transfer.delivered(at, command.peer, command.range, bytes), state => {
              const fresh = credit(state, bytes.byteLength);
              this.multiHolder.peerBytes += fresh;
              if (fresh > 0) contributions.set(link.pc, (contributions.get(link.pc) ?? 0) + fresh);
              const flowMs = report?.elapsedMs - report?.firstByteMs;
              if (fresh > 0 && models.get(link).refresh && report?.receivedBytes >= MIN_LINK_FLOW_BYTES
                && Number.isFinite(flowMs) && flowMs >= 0 && flowMs < MIN_LINK_FLOW_MS) {
                shortRefreshes.set(link.pc, models.get(link).refreshStartedAt);
              }
              apply(state);
              });
            } else {
              if (!controller.signal.aborted || abandoned.has(controller)) this.#recordSelection(link, now() - startedAt);
              submit("failed", { source: command.peer }, (at) => transfer.failed(at, command.peer));
            }
          }, () => { if (!finished) submit("failed", { source: command.peer }, (at) => transfer.failed(at, command.peer)); });
        } else if (command.t === "origin") {
          // The explicit mode must never emit an origin command. Fail closed
          // if an incompatible module violates it; never ignore fake work.
          if (plan.peerOnly) { this.multiHolder.failed += 1; finish(null); return; }
          releaseOrigin ??= this.#claimOrigin(key);
          const controller = new AbortController(), [from, to] = bytesOf(command.range), originAt = now();
          let rangeResult = null;
          const onResult = result => {
            rangeResult = result;
            this.originRangeOutcomes[result.outcome] = increment(this.originRangeOutcomes[result.outcome]);
          };
          originRequests.add(controller);
          this.multiHolder.originRanges += 1;
          const onIgnored = () => {
            if (this.originsWithoutRanges.has(originHost)) return;
            this.originsWithoutRanges.add(originHost);
            this.multiHolder.originRangesIgnored += 1;
          };
          (plan.origin?.Loader ? loadOriginRange(plan.origin, context, from, to, { signal: controller.signal, onIgnored, onResult })
            : fetchOriginRange(context, from, to, { signal: controller.signal, onIgnored, onResult })).then((bytes) => {
            originRequests.delete(controller);
            if (this.options.traceRequests) this.#trace({ k: "origin", load, at: this.#traceAt(originAt), ms: Math.round(now() - originAt), ranged: true,
              range: [command.range.start, command.range.end], outcome: rangeResult?.outcome ?? (bytes ? "payload" : finished ? "abort" : "none"),
              httpStatus: rangeResult?.httpStatus ?? null, bytes: bytes?.byteLength ?? null });
            if (finished) return;
            const p = [command.range.start, command.range.end];
            if (!bytes) return submit("failed", { source: "origin" }, (at) => transfer.failed(at, "origin"));
            this.#observeOriginRange(context, now() - originAt, bytes.byteLength, commitment.size);
            this.counters.bytesFromOrigin += bytes.byteLength;
            submit("delivered", { source: "origin", p, bytes: bytes.byteLength }, (at) => transfer.delivered(at, "origin", command.range, bytes), state => {
            const fresh = credit(state, bytes.byteLength);
            this.multiHolder.originBytes += fresh;
            originShare += fresh;
            apply(state);
            });
          });
        } else if (command.t === "cancel" || command.t === "abandon") {
          const controller = requests.get(command.peer);
          if (command.t === "abandon") {
            this.multiHolder.abandoned += 1;
            if (controller) abandoned.add(controller);
          }
          controller?.abort(command.t === "abandon" ? PeerLink.ABANDON_REASON : undefined);
        } else if (command.t === "ban") {
          const link = ids.get(command.peer);
          this.multiHolder.bans += 1;
          this.counters.peerCorrupt += 1;
          this.banned.add(link.pubkey);
          link.close("integrity");
        } else if (command.t === "deliver") {
          this.multiHolder.delivered += 1;
          this.multiHolderTimings.push([now() - begunAt, slowestMs, requestCount]);
          if (this.multiHolderTimings.length > 128) this.multiHolderTimings.shift();
          // The core hands over a buffer of exactly the object; copy only a view.
          const bytes = state.bytes.byteOffset === 0 && state.bytes.byteLength === state.bytes.buffer.byteLength ? state.bytes : state.bytes.slice();
          finish(commitment.expiresAt <= Math.floor(Date.now() / 1000) ? null : {
            key, bytes, discoveryContext, multi: true, peerBytes: Math.max(0, commitment.size - originShare),
            contributions: [...contributions].map(([connection, bytes]) => ({ connection, bytes })),
            shortRefreshes: [...shortRefreshes].map(([connection, at]) => ({ connection, at })),
          });
        } else if (command.t === "fail") {
          this.multiHolder.failed += 1;
          finish(null);
        }
      };
      const apply = (state) => {
        if (finished) return;
        if (!state) return finish(null); // the module failed
        for (const command of state.commands) { run(command, state); if (finished) return; }
        tickTimer = clear(tickTimer);
        if (state.next !== null) tickTimer = this.#after(Math.max(0, state.next - now()), () => { tickTimer = null; submit("tick", {}, (at) => transfer.tick(at)); });
      };
      // At the loader's deadline the transfer hands its pieces to origin and
      // has the origin reserve to finish before the whole-segment fallback.
      plan.onDeadline = () => {
        if (finished) return false;
        submit("tick", {}, (at) => transfer.tick(at));
        // Keep the measured reserve captured by this load, without moving its
        // absolute recovery deadline if the peer-floor timer itself ran late.
        if (!finished && backstop === null) backstop = this.#after(Math.max(0, plan.limit + plan.originReserveMs - now()), () => { backstop = null; finish(null); });
        return true;
      };
      // Refreshing an unknown/stale path must not be cancelled using another
      // link's startup time. Its ordinary fixed floor still bounds the trial.
      const sharedFirstByteMs = [...models.values()].some(model => model.refresh || model.firstByteMs === null)
        ? null : this.peerSelection.firstByteMs();
      const probePeers = [...ids].filter(([, link]) => models.get(link).rate === null).map(([id]) => id);
      const estimates = { peers, origin, sharedFirstByteMs, sharedRate: this.peerSelection.rate(), probePeers };
      // The input is for the trace only.
      submit("start", this.options.traceRequests ? { size: commitment.size, pieces: commitment.pieces.length, pieceSize, deadline: deadline - base,
        maxHolders: this.options.maxHoldersPerObject, originReserveMs: 0, ...(plan.peerOnly ? { peerOnly: true } : {}), ...structuredClone(estimates),
        holders: [...ids].map(([id, link]) => [id, this.#holderLabel(link.pubkey)]) } : null, (at) => transfer.start(at, estimates), started => {
      if (started?.late) this.multiHolder.late += 1;
      apply(started);
      });
    });
    } finally { release(); }
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

  // A closed link was forgotten on close; its last request can finish later,
  // so forget it again rather than leave an entry the core keeps for good.
  #recordSelection(link, elapsedMs, bytes) {
    this.peerSelection.record(link, elapsedMs, bytes);
    if (link.closed) this.peerSelection.forget(link);
  }

  #peerRequestResult(context, link, remainingMs, result, range = null) {
    try {
      if (!PEER_REQUEST_OUTCOMES.includes(result.outcome)) return;
      this.#observeLinkTiming(link, result);
      const numeric = (value) => Number.isFinite(value) && value >= 0 ? value : null;
      const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
      let cc = null, level = null;
      try { cc = integer(context?.frag?.cc); } catch {}
      try { level = integer(context?.frag?.level); } catch {}
      const record = { atMs: Math.max(0, Math.round(now() - this.transportStartedAt)),
        id: this.transportConnections.get(link.pc)?.id || 0, holder: this.#holderLabel(link.pubkey), cc, level,
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
      this.#trace({ k: "request", load: this.#traceLoad(context), at: this.#traceAt(), range: range ? [range.start, range.end] : null, ...record });
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
        let progressBytes = 0;
        // Bytes are kept only for a sampled comparison or for serving. Chunks
        // are kept or not for the whole load, so a join is never partial.
        const keepChunks = race.sampled || swarm.#mayServe();
        const tapped = {
          ...callbacks,
          onProgress: callbacks.onProgress
            ? (stats, ctx, data, details) => {
                try { if (data?.byteLength) { if (keepChunks) progress.push(data.slice(0)); progressBytes += data.byteLength; } } catch {}
                callbacks.onProgress(stats, ctx, data, details);
              }
            : undefined,
          onSuccess: (response, stats, ctx, details) => {
            const receivedMs = firstByteWallMs(stats);
            // Copy before hls.js sees the buffer: it may transfer it to a worker.
            let copy = null, size = 0;
            try {
              const data = response?.data;
              if (data?.byteLength) {
                if (keepChunks) copy = data.slice(0);
                size = data.byteLength;
              } else if (progressBytes) {
                if (keepChunks) copy = RelaySwarmShadowLoader.join(progress);
                size = progressBytes;
              }
            } catch { copy = null; size = 0; }
            race.originSucceeded = true;
            callbacks.onSuccess(response, stats, ctx, details);
            swarm.#noteOriginClock(details, receivedMs);
            if (size) swarm.#guard("origin-loaded", () => swarm.#originLoaded(race, copy, size));
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
      if (!race.controller.signal.aborted && !this.stopped) this.#recordSelection(link, now() - requestedAt);
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

  // `buffer` is null when neither a sampled comparison nor serving needs it.
  async #originLoaded(race, buffer, size) {
    if (this.stopped || race.originFailed) return;
    const bytes = buffer && new Uint8Array(buffer);
    const t1 = now();
    this.counters.originLoaded += 1;
    this.counters.bytesFromOrigin += size;
    race.originBytes = size;
    pushSample(this.originLatencySamples, t1 - race.t0);
    // Only a sampled race compares digests.
    if (race.sampled) race.originDigest = await sha256Hex(bytes);
    race.originDone = true;
    await race.keyPromise;
    if (this.stopped) return;
    if (bytes) this.#hold(race.key, bytes);
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
      this.#recordSelection(race.peerLink, race.requestMs);
      c.peerCorrupt += 1;
      this.banned.add(race.peerLink.pubkey);
      race.peerLink.close("integrity");
      return;
    }
    const latency = race.peerAt - race.t0;
    this.#recordSelection(race.peerLink, race.requestMs, race.peerBytes.byteLength);
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
    const evicted = this.#trimHeld(this.options.maxHeldBytes - (this.warmAhead?.snapshot().reservationBytes ?? 0), false);
    if (!this.#servingAllowed()) return;
    for (const link of this.links.values()) link.sendHaveChange(this.held.has(key) ? [key] : [], evicted);
  }

  #dropHeld(key) {
    const bytes = this.held.get(key);
    if (!bytes) return;
    this.held.delete(key); this.heldBytes -= bytes.byteLength;
    this.warmAhead?.release(key);
    for (const link of this.links.values()) link.sendHaveChange([], [key]);
  }

  #trimHeld(limit, announce = true) {
    const evicted = [];
    while (this.held.size && (this.held.size > this.options.maxHeldSegments || this.heldBytes > Math.max(0, limit))) {
      const entry = this.warmAhead ? [...this.held].find(([key]) => !this.warmAhead.pinned(key)) : this.held.entries().next().value;
      if (!entry) break;
      const [key, bytes] = entry;
      this.held.delete(key); this.heldBytes -= bytes.byteLength;
      this.warmAhead?.release(key); evicted.push(key);
    }
    if (announce && evicted.length) for (const link of this.links.values()) link.sendHaveChange([], evicted);
    return evicted;
  }

  // Whether serving could be allowed by the time #hold runs. Allowance and
  // network type can change during a load; consent, validity and stop cannot.
  #mayServe() {
    return !this.stopped && !this.disabledReason && this.options.serve === true;
  }

  #servingAllowed() {
    return !this.stopped && !this.disabledReason && this.options.serve === true && this.#uploadRemaining() !== 0 && (this.options.serveOnCellular || !onCellular());
  }

  #uploadRemaining() {
    const limit = this.options.maxUploadBytesPerSession;
    return !Number.isSafeInteger(limit) || limit < 0 ? null : Math.max(0, limit - this.uploadQuotaBytes);
  }

  #withdrawContribution() {
    this.warmAhead?.clear();
    for (const controller of this.cachedRaces) controller.abort();
    this.held.clear();
    this.heldBytes = 0;
    this.uploadPacer?.recheck();
    for (const link of this.links.values()) { link.sendHave([]); link.sendContribution(false, this.rendition); }
    this.#announce();
  }

  // `range` (framing 2) asks for pieces of the held object: the link sends
  // only those, so only their bytes are charged.
  async #serveRequest(link, key, range = null) {
    if (this.uploadPacer) return this.#servePacedRequest(link, key, range);
    // A changed-ticket presence can already own this peer's bounded online
    // check. Join that decision instead of refusing the previously admitted
    // ticket merely because a different credential is being checked. No bytes
    // or allowance are spent unless that check accepts the credential.
    const ticket = this.admissionChecks.get(link.pubkey)?.ticket ?? this.admitted.get(link.pubkey)?.ticket;
    if (this.options.admit && !(await this.#admits(link.pubkey, ticket, "upload"))) {
      this.#refuseUpload("admission");
      link.close("admission");
      return null;
    }
    if (link.closed) return null;
    const bytes = this.held.get(key);
    if (!bytes) { this.#refuseUpload("not-held"); return null; }
    let charge = bytes.byteLength;
    if (range) {
      const pieceSize = commitmentPieceSize(bytes.byteLength);
      const from = range.start * pieceSize, to = Math.min(range.end * pieceSize, bytes.byteLength);
      if (!(from < to)) { this.#refuseUpload("not-held"); return null; }
      charge = to - from;
    }
    if (!this.#servingAllowed()) { this.#refuseUpload("not-serving"); return null; }
    if (this.banned.has(link.pubkey)) { this.#refuseUpload("banned"); return null; }
    const remaining = this.#uploadRemaining();
    if (remaining !== null && charge > remaining) {
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
    if (this.uploadTokens < charge) {
      this.#refuseUpload("rate-limit");
      return null;
    }
    this.uploadTokens -= charge;
    // Reserve capacity before yielding, separately from public accepted-upload
    // metrics. Host revocation may archive metrics while its callback is pending.
    this.uploadQuotaBytes += charge;
    if (this.#uploadRemaining() === 0) this.#withdrawContribution();
    if (this.options.reserveUploadBytes) {
      let accepted = false;
      try { accepted = await boundedOperation((signal) => this.options.reserveUploadBytes(charge, { signal }), this.lifecycle.signal, this.options.admissionTimeoutMs) === true; }
      catch { this.#noteError("upload-reservation"); }
      if (!accepted || this.stopped || link.closed || this.options.serve !== true || (!this.options.serveOnCellular && onCellular())) {
        if (!accepted) this.uploadQuotaBytes -= charge;
        this.#refuseUpload(accepted ? "reservation-inactive" : "reservation-refused");
        return null;
      }
    }
    this.counters.bytesUploaded += charge;
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

  #refillUploadRate() {
    const at = now(), elapsed = Math.max(0, at - this.uploadRefilledAt) / 1000;
    this.uploadRefilledAt = at;
    this.uploadTokens = Math.min(this.options.maxUploadBytesPerSecond * 2, this.uploadTokens + elapsed * this.options.maxUploadBytesPerSecond);
  }

  #uploadGeometry(key, range) {
    const size = this.held.get(key)?.byteLength;
    if (!Number.isSafeInteger(size) || size < 1) return null;
    if (!range) return { key, size, charge: size, range: null };
    const pieceSize = commitmentPieceSize(size);
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > Math.ceil(size / pieceSize)) return null;
    const charge = Math.min(range.end * pieceSize, size) - range.start * pieceSize;
    return { key, size, charge, range: { start: range.start, end: range.end } };
  }

  #pacedUploadAllowed(row, ownQuota = false) {
    if (this.stopped || this.disabledReason || !this.options.serve || row.link.closed || this.links.get(row.link.pubkey) !== row.link ||
        (!this.options.serveOnCellular && onCellular()) || this.banned.has(row.link.pubkey)) return false;
    const geometry = this.#uploadGeometry(row.key, row.range);
    if (!geometry || geometry.size !== row.size || geometry.charge !== row.charge) return false;
    const remaining = this.#uploadRemaining();
    if (!ownQuota && remaining !== null && row.charge > remaining) return false;
    const recent = [...this.links.values()].filter(peer => peer !== row.link && (peer.outboundInFlight > 0 || Date.now() - peer.lastServedAt < 30_000)).length;
    return Date.now() - row.link.lastServedAt < 30_000 || recent < this.options.maxUploadPeers;
  }

  async #servePacedRequest(link, key, range) {
    const geometry = this.#uploadGeometry(key, range);
    if (!geometry) { this.#refuseUpload('not-held'); return null; }
    const reservation = await this.uploadPacer.acquire(link, geometry);
    if (!reservation) return null;
    let quota = false, hostAccepted = null, sent = false;
    const signal = reservation.controller.signal;
    const current = () => reservation.active && !signal.aborted && this.#pacedUploadAllowed(reservation, quota);
    try {
      if (!current()) return null;
      // No held buffer survives refill or host-policy waits. Remote CANCEL
      // has no provider signal in the existing wire; its shell suppresses the
      // eventual response and returns unsent rate capacity as before.
      const ticket = this.admissionChecks.get(link.pubkey)?.ticket ?? this.admitted.get(link.pubkey)?.ticket;
      if (this.options.admit && !await boundedOperation(() => this.#admits(link.pubkey, ticket, 'upload'), signal, this.options.admissionTimeoutMs)) {
        this.#refuseUpload('admission'); link.close('admission'); return null;
      }
      if (!current()) return null;
      this.uploadQuotaBytes += reservation.charge; quota = true;
      if (this.options.reserveUploadBytes) {
        try { hostAccepted = await boundedOperation(operationSignal => this.options.reserveUploadBytes(reservation.charge, { signal: operationSignal }), signal, this.options.admissionTimeoutMs) === true; }
        catch { this.#noteError('upload-reservation'); }
        if (hostAccepted !== true) { this.#refuseUpload('reservation-refused'); return null; }
      } else hostAccepted = true;
      if (!current() || this.options.admit && this.admitted.get(link.pubkey)?.ticket !== ticket) {
        this.#refuseUpload('reservation-inactive'); return null;
      }
      // The final lookup follows every await. Quota zero already prevents new
      // admissions; withdraw only now so its reserved final object can return
      // synchronously without retaining bulk bytes across a policy wait.
      const bytes = this.held.get(key);
      if (!bytes || bytes.byteLength !== reservation.size) { this.#refuseUpload('not-held'); return null; }
      this.counters.bytesUploaded += reservation.charge; this.counters.uploadsServed++;
      sent = true;
      if (this.options.testHooks?.corruptUploads) { const tampered = bytes.slice(); tampered[tampered.length >> 1] ^= 0xff; return tampered; }
      return bytes;
    } catch { return null; }
    finally {
      // An explicit refusal releases its own session reservation exactly once.
      // Accepted or unknown host outcomes keep conservative session billing.
      if (quota && hostAccepted === false) this.uploadQuotaBytes -= reservation.charge;
      if (quota && this.#uploadRemaining() === 0) this.#withdrawContribution();
      this.uploadPacer.finish(reservation, sent);
    }
  }

  // --- the Rust core ---------------------------------------------------------

  async #loadCore() {
    this.coreState = "loading";
    try {
      const core = await loadCore(this.options.coreWasm, { onFailure: (error) => this.#coreTrapped(error) });
      if (this.stopped) return;
      this.core = core;
      this.coreVerifier = core.verifier;
      // Selection state is not transferred: the core takes over only before
      // the first choice, which is normally well after the module loads.
      if (this.peerSelection.order === 0) this.peerSelection = core.peerSelection();
      // Discovery likewise, while it holds no context, hint or window.
      const discovery = this.discovery;
      if (discovery.contexts.size === 0 && discovery.candidates.size === 0 && !discovery.window) {
        this.discovery = core.neighbourDiscovery();
        Object.assign(this.discovery.counters, discovery.counters);
      }
      this.coreState = "ready";
      if (this.options.transferWorkerUrl !== undefined) void this.#warmTransferWorker(core);
    } catch (error) {
      this.coreState = "failed";
      if (this.options.transferWorkerUrl !== undefined) { this.transferWorkerState = "failed"; this.transferWorkerReason = "core-failed"; }
      this.#noteError("core", error);
    }
  }

  async #warmTransferWorker(core) {
    this.transferWorkerState = "loading";
    try {
      const WorkerImpl = this.options.WorkerImpl;
      const worker = await createCoreTransferWorker({ module: core.module, workerUrl: this.options.transferWorkerUrl,
        workerFactory: WorkerImpl ? (url, options) => new WorkerImpl(url, options) : undefined,
        signal: this.lifecycle.signal, maxSegmentBytes: Math.min(32 * 1024 * 1024, this.options.maxSegmentBytes),
        onFailure: error => this.#transferWorkerFailed(error) });
      if (this.stopped || this.core !== core || core.retired) { worker.stop(); return; }
      this.transferWorker = worker;
      this.transferWorkerState = "ready";
    } catch (error) { if (!this.stopped) this.#transferWorkerFailed(error); }
  }

  #transferWorkerFailed(error) {
    if (this.stopped || this.transferWorkerState === "failed") return;
    this.transferWorkerState = "failed";
    this.transferWorkerReason = typeof error?.code === "string" ? error.code : "worker-failed";
    this.#noteError("transfer-worker", error);
  }

  // A trap anywhere in the module retires it for the rest of the session:
  // selection and discovery move to fresh JavaScript instances and core
  // links close.
  #coreTrapped(error) {
    const ranged = this.#rangesEnabled();
    this.core?.retire();
    this.transferWorker?.stop();
    if (this.options.transferWorkerUrl !== undefined) { this.transferWorkerState = "failed"; this.transferWorkerReason = "core-failed"; }
    this.coreVerifier = null;
    this.coreState = "failed";
    this.coreFallbacks += 1;
    this.#noteError("core", error);
    // Peers must stop sending ranged requests to links that cannot serve them.
    if (ranged) this.#announce();
  }

  // Framing 2 is advertised only while every link runs the core's protocol.
  #rangesEnabled() {
    return this.options.multiHolder === true && this.options.mode === "peer-first" && !!this.core && !this.core.retired
      && this.coreLinks.js === 0;
  }

  // Links opened once the core is ready run its protocol; earlier links, and
  // every link after a trap, are JavaScript.
  #createLink(options) {
    if (this.core && !this.core.retired) {
      try {
        const link = this.core.peerLink(options);
        this.coreLinks.wasm += 1;
        return link;
      } catch (error) { this.#coreTrapped(error); }
    }
    this.coreLinks.js += 1;
    return new PeerLink(options);
  }

  // A null result is a verdict and stands; only a trap hands over to the
  // JavaScript verifier, for the rest of the session.
  #verifyCommitment(event, options) {
    if (this.coreVerifier) {
      try {
        const result = this.coreVerifier.verifySegmentCommitment(event, options);
        this.coreDecided.wasm += 1;
        return result;
      } catch (error) {
        this.#coreTrapped(error);
      }
    }
    this.coreDecided.js += 1;
    return verifySegmentCommitment(event, options);
  }

  // --- rendezvous -----------------------------------------------------------

  async #start() {
    const secretKey = this.options.secretKey || generateSecretKey();
    this.pool = new RelayPool(this.options.relays, {
      label: "hls-swarm",
      WebSocketImpl: this.options.WebSocketImpl || globalThis.WebSocket,
      reconnect: true,
    });
    // Connect while an opted-in core loads; the session, and with it every
    // hint, link and choice, starts once the core has settled.
    await Promise.all([this.pool.connect(), this.coreWait]);
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
        transports: [{ type: TRANSPORT, publicKey: this.session.pubkey, ...(this.#rangesEnabled() ? { obj: 2 } : {}) }],
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
    // A link meets the context when it serves the rendition or its HAVE holds a
    // demanded key, but only while it is not stale for that context: a stale link
    // may still advertise a key it never delivers.
    return ![...this.links.values()].some(link => !this.discovery.stale(context, link.pubkey)
      && (this.#servesRendition(link, context.rendition) || context.keys.some(key => link.have.has(key))));
  }

  // At least one link serves this context's rendition and every one is stale.
  #onlyStaleServing(context) {
    const serving = [...this.links.values()].filter(link => this.#servesRendition(link, context.rendition));
    return serving.length > 0 && serving.every(link => this.discovery.stale(context, link.pubkey));
  }

  // No link serves this context's rendition, or every one that does is stale.
  #noFreshServing(context) {
    return [...this.links.values()].filter(link => this.#servesRendition(link, context.rendition))
      .every(link => this.discovery.stale(context, link.pubkey));
  }

  #discoveryEligible(candidate) {
    return !this.links.has(candidate.pubkey) && !this.dials.has(candidate.pubkey)
      && !this.dialChecks.has(candidate.pubkey) && !this.#coolingDown(candidate.pubkey)
      && (!this.#gated() || validTicket(candidate.ticket))
      && (this.retries.get(candidate.pubkey) || 0) <= this.options.maxRetriesPerPeer;
  }

  // The victim and the tier it was ordered by, or null.
  #discoveryVictim(context) {
    if (this.discovery.spent(context) || this.links.size < 2 || Date.now() - this.lastEvictionAt < this.options.evictionCooldownMs) return null;
    // Preserve a useful sibling audio/video neighbour as well as the target.
    const contexts = [...this.discovery.contexts.values()].filter(value => Date.now() - value.activityAt < 30_000);
    return rotationChoice([...this.links.values()].filter(link => !contexts.some(value =>
      !this.discovery.stale(value, link.pubkey) && (this.#servesRendition(link, value.rendition) || value.keys.some(key => link.have.has(key))))),
    { ...this.options, banned: this.banned, tier: link => this.#rotationTier(link) });
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
    for (const context of this.discovery.contexts.values()) this.discovery.rearm(context, () => this.#noFreshServing(context));
    const room = this.links.size + this.dials.size < this.options.maxPeers;
    const choice = this.discovery.choose(candidate => this.#discoveryEligible(candidate),
    context => this.#unmetDiscovery(context) && (room || this.discovery.reserved() || Boolean(this.#discoveryVictim(context))), room);
    if (!choice) return;
    const attempt = this.discovery.begin(choice);
    if (!attempt) return;
    // The old rule would have kept this attempt off: its serving links are all stale.
    if (this.#onlyStaleServing(choice.context)) this.discovery.counters.staleHolder++;
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

  // The link to drop for an offer and the tier it was ordered by, or null.
  #rotationCandidate() {
    return rotationChoice(this.links.values(), { ...this.options, banned: this.banned, tier: link => this.#rotationTier(link) });
  }

  // The order in which rotation may drop links it could already drop:
  //   0 unhelpful  a non-serving remote that is not a consumer of this viewer;
  //   1 serving    the remote is serving;
  //   2 consumer   this viewer is serving, the remote is not, and the remote announced
  //                (within two presence intervals) a rendition this viewer plays now,
  //                so it is playing what this viewer can give it.
  // An ordering, never an exemption: it changes which eligible link goes first only.
  #rotationTier(link) {
    if (link.contribution?.serving === true) return 1;
    if (!this.#servingAllowed()) return 0;
    const at = Date.now(), recently = 2 * this.options.presenceIntervalMs;
    for (const [rendition, announcedAt] of link.announced ?? []) {
      if (at - announcedAt > recently) continue;
      const played = this.renditions.get(rendition);
      if (played !== undefined && at - played <= 30_000) return 2;
    }
    return 0;
  }

  #noteVictimTier(counters, tier, prefix) {
    const name = ["Unhelpful", "Serving", "Consumer"][tier];
    counters[`${prefix}${name}`]++;
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
    const choice = this.#rotationCandidate();
    if (!choice) return null;
    const link = choice.link;
    this.lastEvictionAt = Date.now();
    this.counters.evicted += 1;
    this.#noteVictimTier(this.counters, choice.tier, "evicted");
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
    const transport = payload.transports.find((entry) => entry.type === TRANSPORT);
    if (!transport) return;
    this.remoteFraming.delete(from);
    this.remoteFraming.set(from, transport.obj ?? 1);
    if (this.remoteFraming.size > 1024) this.remoteFraming.delete(this.remoteFraming.keys().next().value);
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
      this.#checkLatePeers();
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
    this.#checkLatePeers();
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
      const choice = this.#discoveryVictim(discovery.window.context), victim = choice?.link;
      if (!victim || !this.discovery.replaced(discovery, victim.pubkey)) { this.discovery.abandoned(discovery); return; }
      this.lastEvictionAt = Date.now(); this.counters.evicted++;
      this.#noteVictimTier(this.discovery.counters, choice.tier, "victim");
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
    const link = this.#createLink({
      pubkey: dial.pubkey,
      pc: dial.pc,
      channel,
      maxSegmentBytes: this.options.maxSegmentBytes,
      onRequest: (from, key, range) => this.#serveRequest(from, key, range),
      onHaveChange: (_link, added) => {
        for (const waiter of [...this.haveWaiters]) waiter(added);
        this.#checkLatePeers();
      },
      onScheduleChange: () => {
        for (const waiter of [...this.haveWaiters]) waiter();
        for (const waiter of [...this.peerLeaseWaiters]) waiter();
        this.#checkLatePeers();
      },
      onUploadCancelled: (_link, unsentBytes) => {
        this.counters.uploadsCancelled += 1;
        this.counters.uploadCancelledBytes += unsentBytes;
        // Bytes never sent return to the per-second rate. The session
        // allowance and any host reservation stay charged.
        this.uploadTokens = Math.min(this.options.maxUploadBytesPerSecond * 2, this.uploadTokens + unsentBytes);
        this.uploadPacer?.recheck();
      },
      onClose: (closed) => {
        this.uploadPacer?.cancel(closed);
        this.peerLeases.delete(closed);
        for (const waiter of [...this.peerLeaseWaiters]) waiter();
        dial.pc.removeEventListener("datachannel", rejectExtraChannel);
        this.#endTransport(dial.pc, "link-close", closed.closeReason);
        this.peerSelection.forget(closed);
        if (this.links.get(closed.pubkey) === closed) {
          this.links.delete(closed.pubkey);
          this.discovery.forget(closed.pubkey);
          this.counters.linksClosed += 1;
          this.#guard("reannounce", () => this.#scheduleReannounce());
        }
      },
    });
    this.links.set(dial.pubkey, link);
    this.#assignHolderLabel(dial.pubkey);
    this.#checkLatePeers();
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
