// NeighbourDiscovery backed by the Rust core. The swarm compares contexts,
// windows and attempts by identity and keeps its own fields on them (a
// window's timer, an attempt's dial and negotiation), so this keeps one
// JavaScript object per core ID and updates it in place after every change.
// The swarm's callbacks run here, before each call, and cross as lists.
import { NeighbourDiscovery } from "./neighbour-discovery.mjs";
import { validTicket } from "../relay-session.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const OP = { context: 0, demand: 1, hint: 2, holderMiss: 3, holderAhead: 4, stale: 5, forget: 6, current: 7, candidates: 8,
  choose: 9, hinted: 10, begin: 11, valid: 12, replaced: 13, allocated: 14, abandoned: 15, failed: 16, end: 17, verified: 18,
  live: 19, reserved: 20, suppresses: 21, snapshot: 22, clear: 23, rearm: 24 };
const CANDIDATE_FRESH_MS = 60_000;
const REPLACEMENT_REARM_MS = 20_000;
const BOOLEAN = new Set([OP.stale, OP.current, OP.valid, OP.live, OP.reserved, OP.suppresses]);

// Only a failure inside the core retires it; a throwing callback from the
// swarm propagates as it would from neighbour-discovery.mjs.
class CoreFailure extends Error {
  constructor(cause) { super("Core discovery failed.", { cause }); }
}

export class CoreNeighbourDiscovery {
  #call;
  #onFailure;
  #fallback = null;
  #contexts = new Map();
  #contextById = new Map();
  #contextIds = new WeakMap();
  #window = null;
  #windowId = null;
  #attemptIds = new WeakMap();
  #dialIds = new WeakMap();
  #primitiveDialIds = new Map();
  #nextDial = 1;
  #found = null;

  /**
   * `call(op, now, args)` runs one core operation and returns its parsed
   * result, throwing on a trap or a refusal. `fail(error)` reports one.
   */
  constructor(call, fail, clock = () => Date.now()) {
    this.#call = call;
    this.#onFailure = fail;
    this.clock = clock;
    // The swarm counts expired, opened, staleHolder and staleBlocked here
    // itself; the core's checks, replacements and verified are copied in.
    this.counters = { checks: 0, replacements: 0, expired: 0, opened: 0, verified: 0, staleHolder: 0, staleBlocked: 0, heldMiss: 0, rearmed: 0, victimUnhelpful: 0, victimServing: 0, victimConsumer: 0, unmetNoHint: 0, unmetIneligible: 0 };
  }

  get kind() { return this.#fallback ? "js" : "wasm"; }
  get contexts() { return this.#fallback ? this.#fallback.contexts : this.#contexts; }
  get window() { return this.#fallback ? this.#fallback.window : this.#window; }
  get candidates() {
    if (this.#fallback) return this.#fallback.candidates;
    return new Map(this.#query(OP.candidates, []).map((candidate) => [candidate.pubkey, candidate]));
  }

  /** Stop using the core, as after a trap elsewhere in the same instance. */
  retire() {
    if (this.#fallback) return;
    // State is not transferred; objects the swarm holds read as stale.
    this.#fallback = new NeighbourDiscovery(this.clock);
    this.#fallback.counters = this.counters;
  }

  #run(wasm, js) {
    if (this.#fallback) return js(this.#fallback);
    try {
      return wasm();
    } catch (error) {
      if (!(error instanceof CoreFailure)) throw error;
      this.retire();
      try { this.#onFailure?.(error.cause); } catch {}
      return js(this.#fallback);
    }
  }

  #query(op, args) {
    try {
      const value = this.#call(op, this.clock(), args);
      if (op === OP.candidates) return value.map(([pubkey, have, ticket, at]) => ({ pubkey, have, ticket, at }));
      if (BOOLEAN.has(op) && typeof value !== "boolean") throw new TypeError(`Core discovery answered operation ${op} with ${typeof value}.`);
      return value;
    } catch (error) { throw new CoreFailure(error); }
  }

  #mutate(op, args) {
    try {
      const { r, s } = this.#call(op, this.clock(), args);
      this.#sync(s);
      return r;
    } catch (error) { throw new CoreFailure(error); }
  }

  #sync({ c, w, n }) {
    const live = new Map();
    this.#contexts = new Map();
    for (const value of c) {
      let context = this.#contextById.get(value.id);
      if (!context) {
        context = { mediaType: value.mediaType, rendition: value.rendition, keys: [], lastDemandAt: null, activityAt: 0, spent: false };
        this.#contextIds.set(context, value.id);
      }
      if (context.keys.length !== value.keys.length || context.keys.some((key, index) => key !== value.keys[index])) context.keys = value.keys;
      Object.assign(context, { lastDemandAt: value.lastDemandAt, activityAt: value.activityAt, spent: value.spent, spentAt: value.spentAt });
      live.set(value.id, context);
      this.#contexts.set(value.mediaType, context);
    }
    if (!w) {
      this.#window = null;
      this.#windowId = null;
    } else {
      // A window keeps the context it opened for, even once that is replaced.
      const context = live.get(w.context) ?? this.#contextById.get(w.context);
      if (context) live.set(w.context, context);
      if (this.#windowId !== w.id) {
        this.#window = { context, createdAt: w.createdAt, expiresAt: w.expiresAt, attempt: null, vacant: false, victim: null, timer: null };
        this.#windowId = w.id;
      }
      const window = this.#window;
      Object.assign(window, { context, expiresAt: w.expiresAt, vacant: w.vacant, victim: w.victim });
      if (!w.attempt) window.attempt = null;
      else if (!window.attempt || this.#attemptIds.get(window.attempt) !== w.attempt.id) {
        window.attempt = { window, pubkey: w.attempt.pubkey, ticket: w.attempt.ticket, key: w.attempt.key, dial: null, negotiation: null };
        this.#attemptIds.set(window.attempt, w.attempt.id);
      }
    }
    this.#contextById = live;
    [this.counters.checks, this.counters.replacements, this.counters.verified, this.counters.rearmed, this.counters.unmetNoHint, this.counters.unmetIneligible] = n;
  }

  #contextId(context) { return context ? this.#contextIds.get(context) ?? null : null; }

  #dialId(dial, create) {
    const primitive = dial === null || (typeof dial !== "object" && typeof dial !== "function");
    const ids = primitive ? this.#primitiveDialIds : this.#dialIds;
    let id = ids.get(dial);
    if (id === undefined && create) ids.set(dial, id = this.#nextDial++);
    return id;
  }

  #candidates(eligible) {
    const now = this.clock();
    return this.#query(OP.candidates, []).filter((candidate) => now >= candidate.at && now - candidate.at < CANDIDATE_FRESH_MS && eligible(candidate))
      .map((candidate) => candidate.pubkey);
  }

  #foundFrom(value) {
    if (!value) return this.#found = null;
    const [pubkey, have, ticket, at] = value.candidate;
    const context = this.#contextById.get(value.context);
    return this.#found = context ? { context, candidate: { pubkey, have, ticket, at }, key: value.key } : null;
  }

  context(mediaType, rendition) {
    if (mediaType !== "main" && mediaType !== "audio") return null;
    return this.#run(() => { const id = this.#mutate(OP.context, [mediaType, String(rendition)]); return this.#contextById.get(id) ?? null; },
      (js) => js.context(mediaType, rendition));
  }

  demand(mediaType, rendition, key) {
    return this.#run(() => {
      if (typeof key !== "string") { this.context(mediaType, rendition); return undefined; }
      if (mediaType !== "main" && mediaType !== "audio") return undefined;
      const id = this.#mutate(OP.demand, [mediaType, String(rendition), key]);
      return this.#contextById.get(id) ?? undefined;
    }, (js) => js.demand(mediaType, rendition, key));
  }

  hint(pubkey, have, ticket) {
    if (typeof pubkey !== "string" || !HASH.test(pubkey) || !Array.isArray(have)) return;
    this.#run(() => { this.#query(OP.hint, [pubkey, have.filter((key) => typeof key === "string"), validTicket(ticket) ? ticket : null]); },
      (js) => js.hint(pubkey, have, ticket));
  }

  holderMiss(context, pubkey, key) {
    if (typeof pubkey !== "string" || typeof key !== "string") return;
    return this.#run(() => this.#query(OP.holderMiss, [this.#contextId(context), pubkey, key]), (js) => js.holderMiss(context, pubkey, key));
  }

  holderDelivered(context, pubkey) { this.holderAhead(context, pubkey); }

  spent(context) { return this.#fallback ? this.#fallback.spent(context) : context?.spentAt !== null && context?.spentAt !== undefined; }

  rearm(context, allStale) {
    return this.#run(() => {
      const id = this.#contextId(context);
      const now = this.clock();
      if (id === null || !this.spent(context) || now < context.spentAt
        || now - context.spentAt < REPLACEMENT_REARM_MS || !this.current(context)) return false;
      return this.#mutate(OP.rearm, [id, Boolean(allStale())]);
    }, (js) => js.rearm(context, allStale));
  }

  holderAhead(context, pubkey) {
    if (typeof pubkey !== "string") return;
    this.#run(() => { this.#query(OP.holderAhead, [this.#contextId(context), pubkey]); }, (js) => js.holderAhead(context, pubkey));
  }

  stale(context, pubkey) {
    if (typeof pubkey !== "string") return false;
    return this.#run(() => this.#query(OP.stale, [this.#contextId(context), pubkey]), (js) => js.stale(context, pubkey));
  }

  forget(pubkey) {
    if (typeof pubkey !== "string") return;
    this.#run(() => { this.#query(OP.forget, [pubkey]); }, (js) => js.forget(pubkey));
  }

  current(context) {
    return this.#run(() => this.#contextId(context) !== null && this.#query(OP.current, [this.#contextId(context)]), (js) => js.current(context));
  }

  choose(eligible, unmet, room) {
    return this.#run(() => {
      if (this.#window?.attempt) return this.#found = null;
      const contexts = this.#window ? [this.#window.context] : [...this.#contexts.values()];
      // unmet runs only for a current context, as in neighbour-discovery.mjs.
      const wanted = contexts.filter((context) => this.#query(OP.current, [this.#contextId(context)]) && unmet(context)).map((context) => context.mediaType);
      if (wanted.length === 0) return this.#found = null;
      return this.#foundFrom(this.#mutate(OP.choose, [this.#candidates(eligible), wanted, Boolean(room)]));
    }, (js) => js.choose(eligible, unmet, room));
  }

  hinted(context, eligible) {
    return this.#run(() => {
      const id = this.#contextId(context);
      if (id === null) return this.#found = null;
      return this.#foundFrom(this.#query(OP.hinted, [id, this.#candidates(eligible)]));
    }, (js) => js.hinted(context, eligible));
  }

  /** Begins only from the latest choose or hinted result. */
  begin(found) {
    return this.#run(() => {
      if (!found || found !== this.#found) return null;
      this.#found = null;
      const id = this.#mutate(OP.begin, []);
      return id === null ? null : this.#window?.attempt ?? null;
    }, (js) => js.begin(found));
  }

  valid(attempt) {
    return this.#run(() => {
      const id = attempt ? this.#attemptIds.get(attempt) : undefined;
      return id !== undefined && this.#query(OP.valid, [id]);
    }, (js) => js.valid(attempt));
  }

  replaced(attempt, victim) {
    return this.#run(() => {
      const id = attempt ? this.#attemptIds.get(attempt) : undefined;
      return id !== undefined && this.#mutate(OP.replaced, [id, typeof victim === "string" ? victim : null]);
    }, (js) => js.replaced(attempt, victim));
  }

  allocated(attempt, dial) {
    this.#run(() => {
      attempt.dial = dial;
      attempt.window.vacant = false;
      const id = this.#attemptIds.get(attempt);
      if (id !== undefined) this.#mutate(OP.allocated, [id, this.#dialId(dial, true)]);
    }, (js) => js.allocated(attempt, dial));
  }

  abandoned(attempt) {
    this.#run(() => {
      const id = attempt ? this.#attemptIds.get(attempt) : undefined;
      if (id !== undefined) this.#mutate(OP.abandoned, [id]);
    }, (js) => js.abandoned(attempt));
  }

  failed(dial) {
    this.#run(() => {
      const id = this.#dialId(dial, false);
      if (id !== undefined) this.#mutate(OP.failed, [id]);
    }, (js) => js.failed(dial));
  }

  end(window = this.window) {
    return this.#run(() => Boolean(window) && window === this.#window && this.#mutate(OP.end, []), (js) => js.end(window));
  }

  verified(context) {
    return this.#run(() => {
      const id = this.#contextId(context);
      return id !== null && this.#contexts.get(context.mediaType) === context && this.#mutate(OP.verified, [id]);
    }, (js) => js.verified(context));
  }

  live(window = this.window) {
    return this.#run(() => Boolean(window) && window === this.#window && this.#query(OP.live, []), (js) => js.live(window));
  }

  reserved() { return this.#run(() => this.#query(OP.reserved, []), (js) => js.reserved()); }

  suppresses(pubkey) {
    if (typeof pubkey !== "string") return false;
    return this.#run(() => this.#query(OP.suppresses, [pubkey]), (js) => js.suppresses(pubkey));
  }

  snapshot() {
    return this.#run(() => ({ ...this.#query(OP.snapshot, []), counters: { ...this.counters } }), (js) => js.snapshot());
  }

  clear() {
    this.#run(() => { this.#found = null; this.#mutate(OP.clear, []); }, (js) => js.clear());
  }
}
