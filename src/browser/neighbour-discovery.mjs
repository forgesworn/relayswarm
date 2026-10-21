// Internal bounded advisory state. HlsSwarm owns admission, slots and PCs.
import { validTicket } from "../relay-session.mjs";
const HASH = /^[0-9a-f]{64}$/u;
// A serving link is stale for a context once it has lacked the segment this
// viewer demanded, at the deadline, on this many distinct segments over at
// least this long. Internal bounds, not options.
const STALE_HOLDER_MISSES = 4;
const STALE_HOLDER_MS = 10_000;
const MAX_HOLDERS = 8;
export class NeighbourDiscovery {
  constructor(clock = () => Date.now()) {
    this.clock = clock;
    this.contexts = new Map();
    this.candidates = new Map();
    this.window = null;
    this.counters = { checks: 0, replacements: 0, expired: 0, opened: 0, verified: 0, staleHolder: 0, staleBlocked: 0 };
  }

  context(mediaType, rendition) {
    if (!["main", "audio"].includes(mediaType)) return null;
    let context = this.contexts.get(mediaType);
    if (!context || context.rendition !== rendition) {
      context = { mediaType, rendition, keys: [], lastDemandAt: null, activityAt: this.clock(), spent: false, holders: new Map() };
      this.contexts.set(mediaType, context);
    } else {
      const at = this.clock();
      if (at < context.activityAt || at - context.activityAt >= 30_000
        || context.lastDemandAt !== null && (at < context.lastDemandAt || at - context.lastDemandAt >= 30_000)) {
        context.keys = []; context.lastDemandAt = null; context.holders.clear();
      }
      context.activityAt = this.clock();
    }
    return context;
  }

  demand(mediaType, rendition, key) {
    const context = this.context(mediaType, rendition);
    if (!context || !HASH.test(key)) return;
    const pinned = this.live() && this.window.context === context ? this.window.attempt?.key : null;
    context.keys = [...new Set([...(pinned ? [pinned] : []), key, ...context.keys])].slice(0, 2);
    context.lastDemandAt = this.clock();
    return context;
  }

  hint(pubkey, have, ticket) {
    if (!HASH.test(pubkey) || !Array.isArray(have)) return;
    this.candidates.delete(pubkey);
    this.candidates.set(pubkey, { pubkey, have: [...new Set(have.filter(key => typeof key === "string" && HASH.test(key)))].slice(-8), ticket: validTicket(ticket) ? ticket : null, at: this.clock() });
    if (this.candidates.size > 64) this.candidates.delete(this.candidates.keys().next().value);
  }

  // Advisory per-context holder state. HlsSwarm decides what counts as a miss
  // or as ahead; this only records it, anchored to this viewer's own demand.
  #live(context) { return Boolean(context && this.contexts.get(context.mediaType) === context); }

  holderMiss(context, pubkey, key) {
    if (!this.#live(context) || !HASH.test(pubkey) || !HASH.test(key)) return;
    const entry = context.holders.get(pubkey);
    if (entry) {
      if (entry.lastKey === key) return;
      entry.misses++; entry.lastKey = key;
      return;
    }
    if (context.holders.size >= MAX_HOLDERS) context.holders.delete(context.holders.keys().next().value);
    context.holders.set(pubkey, { firstMissAt: this.clock(), misses: 1, lastKey: key });
  }

  holderAhead(context, pubkey) { if (this.#live(context)) context.holders.delete(pubkey); }

  stale(context, pubkey) {
    const entry = this.#live(context) ? context.holders.get(pubkey) : null;
    return Boolean(entry) && entry.misses >= STALE_HOLDER_MISSES && this.clock() - entry.firstMissAt >= STALE_HOLDER_MS;
  }

  forget(pubkey) { for (const context of this.contexts.values()) context.holders.delete(pubkey); }

  current(context) {
    const at = this.clock();
    return this.contexts.get(context.mediaType) === context && at >= context.activityAt && at - context.activityAt < 30_000
      && context.lastDemandAt !== null && at >= context.lastDemandAt && at - context.lastDemandAt < 30_000;
  }

  choose(eligible, unmet, room) {
    if (this.window?.attempt) return null;
    const contexts = this.window ? [this.window.context] : [...this.contexts.values()];
    for (const context of contexts) {
      if (!this.current(context) || !unmet(context) || (!room && context.spent && !this.window?.vacant)) continue;
      const found = this.hinted(context, eligible);
      if (found) return found;
    }
    return null;
  }

  // A fresh eligible candidate hinting a key this context demands, or null.
  hinted(context, eligible) {
    for (const candidate of this.candidates.values()) {
      if (this.clock() < candidate.at || this.clock() - candidate.at >= 60_000 || !eligible(candidate)) continue;
      const key = context.keys.find(value => candidate.have.includes(value));
      if (key) return { context, candidate, key };
    }
    return null;
  }

  begin({ context, candidate, key }) {
    let window = this.window;
    if (!window) {
      const createdAt = this.clock();
      window = { context, createdAt, expiresAt: Math.min(createdAt + 15_000, candidate.at + 60_000, context.lastDemandAt + 30_000),
        attempt: null, vacant: false, victim: null, timer: null };
      this.window = window;
    }
    if (window.context !== context || window.attempt || this.clock() >= window.expiresAt) return null;
    const attempt = { window, pubkey: candidate.pubkey, ticket: candidate.ticket, key, dial: null, negotiation: null };
    window.attempt = attempt;
    this.counters.checks++;
    return attempt;
  }

  valid(attempt) {
    const window = attempt?.window, candidate = this.candidates.get(attempt?.pubkey);
    return Boolean(window && this.live(window) && window.attempt === attempt
      && this.current(window.context) && candidate && this.clock() >= candidate.at && this.clock() - candidate.at < 60_000
      && candidate.ticket === attempt.ticket && candidate.have.includes(attempt.key));
  }

  replaced(attempt, victim) {
    if (!this.valid(attempt) || attempt.window.context.spent) return false;
    attempt.window.context.spent = true;
    attempt.window.vacant = true;
    attempt.window.victim = victim;
    this.counters.replacements++;
    return true;
  }

  allocated(attempt, dial) { attempt.dial = dial; attempt.window.vacant = false; }
  abandoned(attempt) {
    if (this.window?.attempt === attempt) this.window.attempt = null;
  }
  failed(dial) {
    const attempt = this.window?.attempt;
    if (!attempt || attempt.dial !== dial) return;
    attempt.window.attempt = null;
    attempt.window.vacant = attempt.window.victim !== null;
  }
  end(window = this.window) {
    if (!window || this.window !== window) return false;
    this.window = null;
    return true;
  }
  verified(context) {
    if (!context || this.contexts.get(context.mediaType) !== context) return false;
    context.spent = false; this.counters.verified++;
    return true;
  }
  live(window = this.window) { return Boolean(window && this.window === window && this.clock() >= window.createdAt && this.clock() < window.expiresAt); }
  reserved() { return Boolean(this.live() && this.window.vacant && this.current(this.window.context)); }
  suppresses(pubkey) { return Boolean(this.live() && this.window.victim === pubkey); }
  snapshot() {
    return { v: 1, candidateCapacity: 64, candidates: this.candidates.size, contexts: this.contexts.size,
      requestedKeys: [...this.contexts.values()].reduce((sum, context) => sum + context.keys.length, 0),
      replacementSpent: [...this.contexts.values()].filter(context => context.spent).length,
      opportunityActive: this.live(), remainingMs: this.live() ? Math.min(15_000, this.window.expiresAt - this.clock()) : 0,
      vacancyReserved: this.reserved(), counters: { ...this.counters } };
  }
  clear() { this.window = null; this.contexts.clear(); this.candidates.clear(); }
}
