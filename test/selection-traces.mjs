// Randomised operation sequences for PeerSelection and NeighbourDiscovery,
// recorded from the JavaScript. The Rust tests replay the recorded operations
// and compare every output. Shared by the generator and the freshness test.

import { PeerSelection } from "../src/browser/peer-selection.mjs";
import { NeighbourDiscovery } from "../src/browser/neighbour-discovery.mjs";

export const SELECTION_EPOCH_MS = 1_792_000_000_000;

/** Small deterministic PRNG (mulberry32). */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const LINKS = ["l0", "l1", "l2", "l3", "l4"];
const pubkeyOf = (name) => name.slice(1).padStart(64, "e");
const KEYS = ["k0", "k1", "k2"].map((name) => name.slice(1).padStart(64, "d"));

/** Generate selection operations from a seed. */
export function selectionOps(seed, count) {
  const next = random(seed), pick = (list) => list[Math.floor(next() * list.length)];
  const number = (max, fractional = true) => (fractional ? next() * max : Math.floor(next() * max));
  const ops = [];
  for (let index = 0; index < count; index++) {
    const roll = next();
    if (roll < 0.1) ops.push({ op: "advance", ms: number(5000, false) });
    else if (roll < 0.35) {
      ops.push({ op: "observe", firstByteMs: next() < 0.2 ? null : next() < 0.05 ? -1 : number(3000), bytes: next() < 0.3 ? number(40000, false) : number(800000, false),
        flowMs: next() < 0.2 ? number(400) : number(8000), totalFlowMs: next() < 0.3 ? undefined : number(12000) });
    } else if (roll < 0.37) ops.push({ op: "forget", link: pick(LINKS) });
    else if (roll < 0.6) ops.push({ op: "record", link: pick(LINKS), elapsedMs: next() < 0.05 ? 0 : next() < 0.05 ? 90000 : number(9000), bytes: next() < 0.4 ? 0 : number(900000, false) });
    else {
      ops.push({ op: "select", key: pick(KEYS), size: next() < 0.1 ? 0 : number(900000, false), deadlineMs: next() < 0.2 ? null : next() < 0.1 ? number(100) : number(10000),
        links: LINKS.filter(() => next() < 0.85).map((name) => ({ name, closed: next() < 0.1, busy: next() < 0.15, has: KEYS.filter(() => next() < 0.7) })),
        tried: LINKS.filter(() => next() < 0.15).map(pubkeyOf) });
    }
  }
  return ops;
}

/** Run selection operations and record every output. `create` makes the PeerSelection. */
export function runSelectionOps(ops, create = () => new PeerSelection()) {
  let now = SELECTION_EPOCH_MS;
  const saved = Date.now;
  Date.now = () => now;
  try {
    const selection = create();
    const links = new Map(LINKS.map((name) => [name, { name, pubkey: pubkeyOf(name), closed: false, busy: false, have: new Set() }]));
    const out = [];
    for (const op of ops) {
      let result = null;
      if (op.op === "advance") now += op.ms;
      else if (op.op === "observe") selection.observe({ firstByteMs: op.firstByteMs, bytes: op.bytes, flowMs: op.flowMs, ...(op.totalFlowMs === undefined ? {} : { totalFlowMs: op.totalFlowMs }) });
      else if (op.op === "forget") selection.forget(links.get(op.link));
      else if (op.op === "record") selection.record(links.get(op.link), op.elapsedMs, op.bytes);
      else {
        const view = op.links.map((state) => Object.assign(links.get(state.name), { closed: state.closed, busy: state.busy, have: new Set(state.has) }));
        result = selection.select(view, op.key, new Set(op.tried), op.size, op.deadlineMs ?? Infinity)?.name ?? null;
      }
      out.push({ result, firstByteMs: selection.firstByteMs(), rate: selection.rate(), project: [0, 1000, 670000].map((size) => selection.projectMs(size)),
        minimum: selection.minimumMs(670000), lastObservedAt: selection.lastObservedAt, turn: selection.turn, order: selection.order,
        links: LINKS.map((name) => ({ ...selection.summary(links.get(name)), estimate: selection.estimate(links.get(name), 670000) })) });
    }
    return out;
  } finally { Date.now = saved; }
}

const MEDIA = ["main", "audio", "video"], RENDITIONS = ["low", "high"];
const PEERS = ["p0", "p1", "p2", "p3"].map((name) => name.slice(1).padStart(64, "c"));
const HINT_KEYS = ["h0", "h1", "h2", "h3", "h4"].map((name) => name.slice(1).padStart(64, "b"));

/** Generate discovery operations from a seed. Handles are indices into earlier results. */
export function discoveryOps(seed, count) {
  const next = random(seed), pick = (list) => list[Math.floor(next() * list.length)];
  const ops = [];
  for (let index = 0; index < count; index++) {
    const roll = next();
    if (roll < 0.12) ops.push({ op: "advance", ms: pick([0, 500, 4000, 9000, 16000, 31000, 61000]) });
    else if (roll < 0.27) ops.push({ op: "demand", mediaType: pick(MEDIA), rendition: next() < 0.85 ? "low" : "high", key: next() < 0.05 ? "bad" : pick(HINT_KEYS) });
    else if (roll < 0.32) ops.push({ op: "context", mediaType: pick(MEDIA), rendition: pick(RENDITIONS) });
    else if (roll < 0.45) ops.push({ op: "hint", pubkey: next() < 0.05 ? "bad" : pick(PEERS), have: HINT_KEYS.filter(() => next() < 0.4).concat(next() < 0.1 ? [5, "bad"] : []), ticket: next() < 0.7 ? "t" : next() < 0.5 ? "" : null });
    else if (roll < 0.55) ops.push({ op: "holderMiss", mediaType: pick(MEDIA), pubkey: pick(PEERS), key: pick(HINT_KEYS) });
    else if (roll < 0.58) ops.push({ op: "holderAhead", mediaType: pick(MEDIA), pubkey: pick(PEERS) });
    else if (roll < 0.61) ops.push({ op: "forget", pubkey: pick(PEERS) });
    else if (roll < 0.73) ops.push({ op: "choose", eligible: PEERS.filter(() => next() < 0.8), unmet: MEDIA.filter(() => next() < 0.8), room: next() < 0.5, begin: next() < 0.8 });
    else if (roll < 0.79) ops.push({ op: "replaced", victim: next() < 0.3 ? null : pick(PEERS) });
    else if (roll < 0.83) ops.push({ op: "allocated", dial: Math.floor(next() * 3) });
    else if (roll < 0.86) ops.push({ op: "abandoned" });
    else if (roll < 0.9) ops.push({ op: "failed", dial: Math.floor(next() * 3) });
    else if (roll < 0.93) ops.push({ op: "end" });
    else if (roll < 0.97) ops.push({ op: "verified", mediaType: pick(MEDIA) });
    else ops.push({ op: next() < 0.2 ? "clear" : "noop" });
  }
  return ops;
}

/** Run discovery operations and record every output. */
export function runDiscoveryOps(ops) {
  let now = SELECTION_EPOCH_MS;
  const discovery = new NeighbourDiscovery(() => now);
  // Old context objects stay addressable per media type, as a caller holding one would.
  const held = new Map();
  let attempt = null;
  const out = [];
  for (const op of ops) {
    let result = null;
    const ctx = (mediaType) => held.get(mediaType) ?? null;
    switch (op.op) {
      case "advance": now += op.ms; break;
      case "context": { const context = discovery.context(op.mediaType, op.rendition); if (context) held.set(op.mediaType, context); result = Boolean(context); break; }
      case "demand": { const context = discovery.demand(op.mediaType, op.rendition, op.key); if (context) held.set(op.mediaType, context); result = context ? [...context.keys] : null; break; }
      case "hint": discovery.hint(op.pubkey, op.have, op.ticket); break;
      case "holderMiss": discovery.holderMiss(ctx(op.mediaType), op.pubkey, op.key); result = discovery.stale(ctx(op.mediaType), op.pubkey); break;
      case "holderAhead": discovery.holderAhead(ctx(op.mediaType), op.pubkey); break;
      case "forget": discovery.forget(op.pubkey); break;
      case "choose": {
        const found = discovery.choose((candidate) => op.eligible.includes(candidate.pubkey), (context) => op.unmet.includes(context.mediaType), op.room);
        result = found ? { mediaType: found.context.mediaType, pubkey: found.candidate.pubkey, key: found.key } : null;
        if (found && op.begin) { const begun = discovery.begin(found); if (begun) attempt = begun; result.begun = Boolean(begun); }
        break;
      }
      case "replaced": result = attempt ? discovery.replaced(attempt, op.victim) : null; break;
      case "allocated": if (attempt) discovery.allocated(attempt, op.dial); break;
      case "abandoned": if (attempt) discovery.abandoned(attempt); break;
      case "failed": discovery.failed(op.dial); break;
      case "end": result = discovery.end(); break;
      case "verified": result = discovery.verified(ctx(op.mediaType)); break;
      case "clear": discovery.clear(); held.clear(); attempt = null; break;
      default: break;
    }
    const window = discovery.window;
    out.push({ result, valid: attempt ? discovery.valid(attempt) : null, live: discovery.live(), reserved: discovery.reserved(),
      suppresses: PEERS.map((pubkey) => discovery.suppresses(pubkey)),
      stale: MEDIA.map((mediaType) => PEERS.map((pubkey) => discovery.stale(ctx(mediaType), pubkey))),
      current: MEDIA.map((mediaType) => (ctx(mediaType) ? discovery.current(ctx(mediaType)) : null)),
      window: window ? { mediaType: window.context.mediaType, createdAt: window.createdAt, expiresAt: window.expiresAt, vacant: window.vacant,
        victim: window.victim, attempt: window.attempt ? { pubkey: window.attempt.pubkey, key: window.attempt.key, ticket: window.attempt.ticket, dial: window.attempt.dial } : null } : null,
      contexts: [...discovery.contexts.values()].map((context) => ({ mediaType: context.mediaType, rendition: context.rendition, keys: [...context.keys],
        lastDemandAt: context.lastDemandAt, activityAt: context.activityAt, spent: context.spent,
        holders: [...context.holders].map(([pubkey, entry]) => [pubkey, entry.firstMissAt, entry.misses, entry.lastKey]) })),
      candidates: [...discovery.candidates.values()].map((candidate) => [candidate.pubkey, candidate.have, candidate.ticket, candidate.at]),
      snapshot: discovery.snapshot() });
  }
  return out;
}

const P = (index) => index.toString(16).padStart(64, "c");
const H = (index) => index.toString(16).padStart(64, "b");
const choose = (eligible, extra = {}) => ({ op: "choose", eligible, unmet: ["main", "audio"], room: true, begin: true, ...extra });

/** Scripted discovery sequences for boundaries random sequences rarely reach. */
export const discoveryScenarios = [
  { name: "holder becomes stale at four keys and ten seconds", ops: [
    { op: "demand", mediaType: "main", rendition: "low", key: H(0) },
    { op: "holderMiss", mediaType: "main", pubkey: P(0), key: H(0) },
    { op: "holderMiss", mediaType: "main", pubkey: P(0), key: H(0) },
    { op: "advance", ms: 3000 }, { op: "holderMiss", mediaType: "main", pubkey: P(0), key: H(1) },
    { op: "advance", ms: 3000 }, { op: "holderMiss", mediaType: "main", pubkey: P(0), key: H(2) },
    { op: "advance", ms: 3999 }, { op: "holderMiss", mediaType: "main", pubkey: P(0), key: H(3) },
    { op: "advance", ms: 1 }, { op: "noop" },
    { op: "holderAhead", mediaType: "main", pubkey: P(0) },
    ...Array.from({ length: 9 }, (_, index) => ({ op: "holderMiss", mediaType: "main", pubkey: P(index + 1), key: H(0) })),
    { op: "forget", pubkey: P(9) },
  ] },
  { name: "candidate capacity and freshness boundary", ops: [
    ...Array.from({ length: 66 }, (_, index) => ({ op: "hint", pubkey: P(index + 10), have: [H(0)], ticket: "t" })),
    { op: "hint", pubkey: P(12), have: [H(1), H(0), H(1), H(2), H(3), H(4), H(5), H(6), H(7), H(8)], ticket: "x".repeat(2049) },
    { op: "demand", mediaType: "main", rendition: "low", key: H(0) },
    { op: "advance", ms: 29999 }, { op: "demand", mediaType: "main", rendition: "low", key: H(0) },
    { op: "advance", ms: 29999 }, { op: "demand", mediaType: "main", rendition: "low", key: H(0) },
    { op: "advance", ms: 1 }, { op: "demand", mediaType: "main", rendition: "low", key: H(0) },
    choose([P(13)], { begin: false }),
    { op: "advance", ms: 1 }, choose([P(13)], { begin: false }),
    choose([P(12)], { begin: false }),
  ] },
  { name: "replacement, allocation, failure and re-arm", ops: [
    { op: "demand", mediaType: "main", rendition: "low", key: H(0) },
    { op: "hint", pubkey: P(0), have: [H(0)], ticket: "t" },
    { op: "hint", pubkey: P(1), have: [H(0)], ticket: null },
    choose([P(0)]),
    choose([P(1)]),
    { op: "demand", mediaType: "main", rendition: "low", key: H(1) },
    { op: "replaced", victim: P(2) },
    { op: "replaced", victim: P(3) },
    { op: "allocated", dial: 1 },
    { op: "failed", dial: 2 },
    { op: "failed", dial: 1 },
    choose([P(1)], { room: false }),
    { op: "replaced", victim: null },
    { op: "abandoned" },
    { op: "end" }, { op: "end" },
    choose([P(1)], { room: false }),
    { op: "verified", mediaType: "main" },
    choose([P(1)], { room: false }),
    { op: "replaced", victim: null },
    { op: "advance", ms: 15000 }, { op: "noop" },
    { op: "end" },
  ] },
  { name: "replaced context and audio window", ops: [
    { op: "demand", mediaType: "main", rendition: "low", key: H(0) },
    { op: "demand", mediaType: "audio", rendition: "en", key: H(1) },
    { op: "hint", pubkey: P(0), have: [H(0), H(1)], ticket: "t" },
    choose([P(0)], { unmet: ["audio"] }),
    { op: "holderMiss", mediaType: "main", pubkey: P(0), key: H(0) },
    { op: "demand", mediaType: "main", rendition: "high", key: "bad" },
    { op: "holderMiss", mediaType: "main", pubkey: P(0), key: H(1) },
    { op: "verified", mediaType: "main" },
    { op: "demand", mediaType: "audio", rendition: "fr", key: H(2) },
    { op: "replaced", victim: P(1) },
    choose([P(0)]),
    { op: "advance", ms: 30000 }, { op: "context", mediaType: "main", rendition: "low" },
    { op: "clear" },
  ] },
];
