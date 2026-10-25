// Optional, bounded work for the same visible player's next parsed fragments.
// No media clock, playback command, timer-driven background holder or alternate
// rendition is created here. The supplied loader remains the SDK's loader.
export const WARM_AHEAD = Symbol('relayswarm-warm-ahead');
const MAX_BYTES = 24 * 1024 * 1024, MAX_OBJECTS = 3, DEADLINE_MS = 8_000;

export function warmContext(context) {
  try {
    const frag = context?.frag;
    if (!frag || frag.sn === 'initSegment' || !Number.isSafeInteger(frag.sn) || frag.sn < 0 ||
        context.part || frag.gap ||
        [context.rangeStart, context.rangeEnd, frag.byteRangeStartOffset, frag.byteRangeEndOffset].some(value => value !== undefined && value !== 0) ||
        frag.type !== 'main' || !Number.isSafeInteger(frag.level) || frag.level < 0 ||
        !Number.isSafeInteger(frag.cc ?? 0) || (frag.decryptdata?.method && frag.decryptdata.method !== 'NONE')) return null;
    const url = new URL(context.url ?? frag.url), baseurl = frag.baseurl ?? frag.base?.url;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || typeof baseurl !== 'string') return null;
    const snapshot = { ...context, url: url.href, frag: { sn: frag.sn, cc: frag.cc ?? 0, type: frag.type, level: frag.level,
      url: url.href, baseurl, start: frag.start, duration: frag.duration,
      byteRangeStartOffset: frag.byteRangeStartOffset, byteRangeEndOffset: frag.byteRangeEndOffset }, part: null, responseType: 'arraybuffer' };
    return { context: snapshot, key: JSON.stringify([url.href, baseurl, frag.type, frag.level, frag.sn, frag.cc ?? 0,
      0, 0]), scope: JSON.stringify([baseurl, frag.type, frag.level]) };
  } catch { return null; }
}

export function createWarmAhead({ Loader, next, authorise, verify, reserve = () => true, onVerified, onReuse,
  reuseBudget = () => 0, allowed = () => true }) {
  let closed = false, generation = 0, active = null, scope = null, queued = [], config, loaderConfig;
  const cache = new Map(), demand = new Set(), jobs = new Map(), promoted = new Set(), reuseWaiters = new Set(), pins = new Map();
  const counters = { started: 0, verified: 0, rejected: 0, cancelled: 0, coalesced: 0, promotions: 0, localReuseBytes: 0,
    verifiedBytes: 0, verifiedPeerBytes: 0, consumedPeerBytes: 0, cacheBytes: 0, highWaterBytes: 0 };
  const reserved = () => [...jobs.values()].reduce((sum, row) => sum + row.reserved, 0);
  const tracked = () => new Set([...cache.keys(), ...jobs.keys()]).size;
  const live = row => jobs.get(row.key) === row && !row.finished;
  const drop = key => { const row = cache.get(key); if (row) { counters.cacheBytes -= row.data.byteLength; cache.delete(key); } };
  const finishJob = (row, result) => {
    if (!live(row)) return;
    row.finished = true; jobs.delete(row.key); promoted.delete(row);
    if (active === row) active = null;
    row.reserved = 0; row.finish(result);
    queueMicrotask(pump);
  };
  const cancelJob = row => { if (live(row)) { counters.cancelled++; row.cancel(); finishJob(row, null); } };
  const clear = () => {
    generation++; queued = [];
    for (const row of [...jobs.values()]) cancelJob(row);
    for (const key of cache.keys()) drop(key);
    for (const resume of [...reuseWaiters]) resume(true);
  };
  const pump = () => {
    if (closed || active || !allowed() || !queued.length || demand.size + promoted.size > 1) return;
    const item = queued.shift();
    if (cache.has(item.key) || jobs.has(item.key)) { queueMicrotask(pump); return; }
    while (tracked() >= MAX_OBJECTS && cache.size) drop(cache.keys().next().value);
    if (tracked() >= MAX_OBJECTS) return;
    const controller = new AbortController(), revision = generation, cfg = config, policy = loaderConfig;
    let loader, timer, finish;
    const row = { ...item, reserved: 0, finished: false, waiters: new Set(), promise: new Promise(resolve => { finish = resolve; }),
      promote() { clearTimeout(timer); },
      finish: result => finish(result), cancel() {
        controller.abort(); clearTimeout(timer); try { loader?.abort(); loader?.destroy(); } catch {}
      } };
    active = row; jobs.set(row.key, row);
    timer = setTimeout(() => cancelJob(row), DEADLINE_MS);
    void (async () => {
      try {
        const permit = await authorise(item.context, controller.signal);
        if (controller.signal.aborted || closed || revision !== generation || !live(row) || !allowed()) return null;
        if (!permit || !Number.isSafeInteger(permit.size) || permit.size < 1 || permit.size > MAX_BYTES) { counters.rejected++; return null; }
        while (counters.cacheBytes + reserved() + permit.size > MAX_BYTES && cache.size) drop(cache.keys().next().value);
        if (counters.cacheBytes + reserved() + permit.size > MAX_BYTES) { counters.rejected++; return null; }
        row.reserved = permit.size;
        if (!reserve(reserved())) { row.reserved = 0; counters.rejected++; return null; }
        counters.highWaterBytes = Math.max(counters.highWaterBytes, counters.cacheBytes + reserved());
        const warm = item.context[WARM_AHEAD] = { peerBytes: 0 };
        loader = new Loader(cfg); counters.started++;
        const response = await new Promise(resolve => loader.load(item.context, policy, {
          onSuccess: (response, stats, _context, details) => resolve({ response, stats, details }),
          onError: (...args) => resolve({ failure: { name: 'onError', args, stats: loader.stats } }),
          onTimeout: (...args) => resolve({ failure: { name: 'onTimeout', args, stats: loader.stats } }),
          onAbort: (...args) => resolve({ failure: { name: 'onAbort', args, stats: loader.stats } }),
          onProgress: stats => { if (stats?.loaded > permit.size) { controller.abort(); try { loader.abort(); } catch {} resolve(null); } },
        }));
        if (response?.failure) {
          if (controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
          counters.rejected++; return response;
        }
        if (!response || controller.signal.aborted || closed || revision !== generation || !live(row) ||
            !await verify(permit, response.response.data, item.context, controller.signal)) { counters.rejected++; return null; }
        if (controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
        const data = response.response.data;
        if (data.byteLength !== permit.size) { counters.rejected++; return null; }
        row.reserved = 0;
        if (onVerified?.(permit, data, item.context) === false) return null;
        const result = { ...response, context: item.context, scope: item.scope, data, permit, peerBytes: warm.peerBytes, accept: warm.accept };
        cache.set(item.key, result); counters.cacheBytes += data.byteLength; counters.verified++;
        counters.verifiedBytes += data.byteLength; counters.verifiedPeerBytes += warm.peerBytes;
        return result;
      } catch { if (!controller.signal.aborted) counters.rejected++; return null; }
      finally { clearTimeout(timer); try { loader?.destroy(); } catch {} }
    })().then(result => finishJob(row, result));
  };
  const noteDemand = (context, cfg, policy) => {
    const own = warmContext(context);
    if (!own || closed) return null;
    if (scope !== own.scope) { clear(); scope = own.scope; }
    config = cfg; loaderConfig = policy;
    let upcoming = [];
    try { upcoming = next(context).map(warmContext).filter(Boolean).filter(item => item.scope === scope).slice(0, 2); }
    catch { /* Malformed future metadata cannot break the demanded load. */ }
    const keep = new Set([own.key, ...upcoming.map(item => item.key)]);
    for (const key of cache.keys()) if (!keep.has(key)) drop(key);
    for (const row of [...jobs.values()]) if (!keep.has(row.key)) cancelJob(row);
    queued = upcoming;
    return own;
  };
  const Wrapped = class WarmAheadLoader {
    static relayswarmShadow = true;
    constructor(cfg) { this.config = cfg; this.inner = new Loader(cfg); this.stats = this.inner.stats; this.context = null; this.token = 0; }
    load(context, policy, callbacks) {
      this.abort(); this.context = context;
      const terminal = { context, callbacks: { ...callbacks }, settled: false };
      this.pendingTerminal = terminal;
      callbacks = { ...callbacks };
      for (const name of ['onSuccess', 'onError', 'onTimeout', 'onAbort'])
        callbacks[name] = (...args) => this.complete(terminal, name, args);
      const token = ++this.token, own = noteDemand(context, this.config, policy), cached = own && cache.get(own.key);
      const pending = !cached && own && jobs.get(own.key), existing = cached ?? pending?.promise;
      if (existing) {
        if (pending) {
          counters.coalesced++;
          pending.waiters.add(this); this.warmPending = pending;
          if (active === pending && promoted.size === 0) { active = null; promoted.add(pending); pending.promote(); counters.promotions++; }
        }
        this.reuseAbort = new AbortController();
        const revision = generation;
        let winner = null, timer, pinned = null;
        const current = () => token === this.token;
        const cleanup = () => {
          clearTimeout(timer); reuseWaiters.delete(startOrigin);
          if (pinned !== null) { const count = pins.get(pinned) - 1; if (count > 0) pins.set(pinned, count); else pins.delete(pinned); pinned = null; }
        };
        const startOrigin = (invalidated = false) => {
          if (invalidated) { cleanup(); this.reuseAbort.abort(); }
          if (!current() || winner || this.originStarted) return;
          this.originStarted = true; clearTimeout(timer);
          const wrapped = { ...callbacks, onProgress: (...args) => {
            if (!current() || winner === 'cache') return;
            if (args[2]?.byteLength > 0) { winner = 'origin'; this.reuseAbort.abort(); cleanup(); }
            callbacks.onProgress?.(...args);
          } };
          for (const name of ['onSuccess', 'onError', 'onTimeout', 'onAbort']) wrapped[name] = (...args) => {
            if (!current() || winner === 'cache') return;
            winner = 'origin'; this.reuseAbort.abort(); cleanup(); callbacks[name]?.(...args);
          };
          this.start(context, policy, wrapped, token);
        };
        this.cancelReuse = () => { cleanup(); this.reuseAbort.abort(); };
        reuseWaiters.add(startOrigin);
        Promise.resolve(existing).then(async row => {
          if (!current()) return;
          this.releasePending();
          if (closed || !row || revision !== generation) return startOrigin(true);
          if (row.failure) {
            const { name, args, stats } = row.failure;
            winner = 'origin'; cleanup(); this.reuseAbort.abort();
            if (stats) Object.assign(this.stats, stats);
            if (name === 'onError') callbacks.onError(args[0], context, args[2], this.stats);
            else callbacks[name](this.stats, context, args[2]);
            return;
          }
          pinned = row.permit.key; pins.set(pinned, (pins.get(pinned) ?? 0) + 1);
          const budget = Math.max(0, Math.min(25, reuseBudget(context) || 0));
          if (budget > 0) timer = setTimeout(startOrigin, budget); else startOrigin();
          // Cached bytes do not imply continuing authority. Source recovery
          // proceeds independently when the actual buffer cannot cover this check.
          let permit;
          try { permit = await authorise(context, this.reuseAbort.signal); } catch {}
          if (!current() || winner === 'origin') return;
          if (closed || revision !== generation) return startOrigin(true);
          if (!permit || permit.key !== row.permit.key || permit.size !== row.permit.size || permit.sha256 !== row.permit.sha256) {
            drop(own.key); return startOrigin();
          }
          winner = 'cache'; cleanup();
          if (this.originStarted) this.inner.abort();
          Object.assign(this.stats, row.stats);
          const data = row.data.slice(0);
          counters.localReuseBytes += data.byteLength;
          if (!row.accepted) { row.accepted = true; row.accept?.(context); counters.consumedPeerBytes += row.peerBytes; }
          onReuse?.(context, data.byteLength, row.peerBytes);
          callbacks.onSuccess({ ...row.response, data }, this.stats, context, row.details);
          queueMicrotask(pump);
        });
      } else this.start(context, policy, callbacks, token);
      queueMicrotask(pump);
    }
    start(context, policy, callbacks, token) {
      demand.add(this);
      if (demand.size + promoted.size > 1 && active) cancelJob(active);
      const end = () => { demand.delete(this); queueMicrotask(pump); };
      const wrapped = { ...callbacks };
      for (const name of ['onSuccess', 'onError', 'onTimeout', 'onAbort']) wrapped[name] = (...args) => {
        end(); if (token === this.token) callbacks[name]?.(...args);
      };
      this.inner.load(context, policy, wrapped);
    }
    releasePending() {
      const row = this.warmPending; this.warmPending = null;
      if (row) { row.waiters.delete(this); if (promoted.has(row) && !row.waiters.size) cancelJob(row); }
    }
    complete(terminal, name, args) {
      if (!terminal || terminal.settled || this.pendingTerminal !== terminal) return;
      // hls.js resets/destroys the loader synchronously from onSuccess.
      // Retire ownership first so that cleanup cannot invent an abort.
      terminal.settled = true; this.pendingTerminal = null;
      terminal.callbacks[name]?.(...args);
    }
    cancel(destroy) {
      const terminal = this.pendingTerminal;
      this.token++; this.originStarted = false; this.cancelReuse?.(); this.releasePending(); demand.delete(this);
      if (terminal) this.stats.aborted = true;
      if (destroy && terminal) { terminal.settled = true; this.pendingTerminal = null; }
      try { if (destroy) this.inner.destroy(); else this.inner.abort(); }
      finally { if (!destroy) this.complete(terminal, 'onAbort', [this.stats, terminal?.context, null]); }
    }
    abort() { this.cancel(false); }
    destroy() { this.cancel(true); }
    getCacheAge() { return this.inner.getCacheAge?.() ?? null; }
    getResponseHeader(name) { return this.inner.getResponseHeader?.(name) ?? null; }
  };
  return { Loader: Wrapped, clear,
    contains(time) {
      if (closed || !allowed() || !Number.isFinite(time)) return false;
      for (const row of [...jobs.values(), ...cache.values()]) {
        const frag = row.context?.frag, start = frag?.start, duration = frag?.duration, end = start + duration;
        if (row.scope === scope && Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration > 0 &&
            Number.isFinite(end) && start <= time && time < end) return true;
      }
      return false;
    },
    pinned: key => pins.has(key), release(key) { for (const [id, row] of cache) if (row.permit.key === key) drop(id); },
    stop() { closed = true; clear(); }, snapshot: () => ({ ...counters,
      reservationBytes: reserved(), active: Number(Boolean(active)), promoted: promoted.size, trackedObjects: tracked(),
      queued: queued.length, cacheObjects: cache.size,
      limits: { objects: MAX_OBJECTS, bytes: MAX_BYTES, speculativeWholeRequests: 1, deadlineMs: DEADLINE_MS, revalidationMs: 25 } }) };
}
