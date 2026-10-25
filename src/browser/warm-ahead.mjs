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

export function createWarmAhead({ Loader, next, authorise, verify, reserve = () => true, onVerified, onReuse, allowed = () => true }) {
  let closed = false, generation = 0, active = null, scope = null, queued = [], config, loaderConfig;
  const cache = new Map(), demand = new Set();
  const counters = { started: 0, verified: 0, rejected: 0, cancelled: 0, coalesced: 0, localReuseBytes: 0,
    verifiedBytes: 0, verifiedPeerBytes: 0, consumedPeerBytes: 0,
    cacheBytes: 0, highWaterBytes: 0, reservationBytes: 0 };
  const drop = key => { const row = cache.get(key); if (row) { counters.cacheBytes -= row.data.byteLength; cache.delete(key); } };
  const clear = () => {
    generation++; queued = [];
    const old = active; active = null;
    if (old) { counters.cancelled++; old.cancel(); }
    counters.reservationBytes = 0;
    for (const key of cache.keys()) drop(key);
  };
  const pump = () => {
    if (closed || active || !allowed() || !queued.length || demand.size > 1) return;
    const item = queued.shift();
    if (cache.has(item.key)) { queueMicrotask(pump); return; }
    const controller = new AbortController(), revision = generation;
    let loader, timer, finish;
    const row = { ...item, promise: new Promise(resolve => { finish = resolve; }), cancel() {
      controller.abort(); clearTimeout(timer); try { loader?.abort(); loader?.destroy(); } catch {} finish(null);
    } };
    active = row;
    timer = setTimeout(() => { if (active === row) { counters.cancelled++; row.cancel(); active = null; counters.reservationBytes = 0; pump(); } }, DEADLINE_MS);
    void (async () => {
      try {
        const permit = await authorise(item.context, controller.signal);
        if (controller.signal.aborted || closed || revision !== generation || active !== row || !allowed()) return null;
        if (!permit || !Number.isSafeInteger(permit.size) || permit.size < 1 || permit.size > MAX_BYTES) { counters.rejected++; return null; }
        while (cache.size >= MAX_OBJECTS || counters.cacheBytes + permit.size > MAX_BYTES) drop(cache.keys().next().value);
        counters.reservationBytes = permit.size;
        if (!reserve(permit.size)) { counters.rejected++; return null; }
        counters.highWaterBytes = Math.max(counters.highWaterBytes, counters.cacheBytes + permit.size);
        const warm = item.context[WARM_AHEAD] = { peerBytes: 0 };
        loader = new Loader(config); counters.started++;
        const response = await new Promise(resolve => loader.load(item.context, loaderConfig, {
          onSuccess: (response, stats, _context, details) => resolve({ response, stats, details }),
          onError: () => resolve(null), onTimeout: () => resolve(null), onAbort: () => resolve(null),
          onProgress: stats => { if (stats?.loaded > permit.size) { controller.abort(); try { loader.abort(); } catch {} resolve(null); } },
        }));
        if (!response || controller.signal.aborted || closed || revision !== generation || active !== row ||
            !await verify(permit, response.response.data, item.context, controller.signal)) { counters.rejected++; return null; }
        if (controller.signal.aborted || closed || revision !== generation || active !== row) return null;
        const data = response.response.data;
        if (data.byteLength !== permit.size) { counters.rejected++; return null; }
        counters.reservationBytes = 0;
        if (onVerified?.(permit, data, item.context) === false) return null;
        const result = { ...response, data, permit, peerBytes: warm.peerBytes, accept: warm.accept };
        cache.set(item.key, result); counters.cacheBytes += data.byteLength; counters.verified++;
        counters.verifiedBytes += data.byteLength; counters.verifiedPeerBytes += warm.peerBytes;
        return result;
      } catch { if (!controller.signal.aborted) counters.rejected++; return null; }
      finally { clearTimeout(timer); try { loader?.destroy(); } catch {} }
    })().then(result => {
      finish(result);
      if (active === row) { active = null; counters.reservationBytes = 0; queueMicrotask(pump); }
    });
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
    if (active && !keep.has(active.key)) { const old = active; active = null; old.cancel(); counters.cancelled++; counters.reservationBytes = 0; }
    queued = upcoming;
    return own;
  };
  const Wrapped = class WarmAheadLoader {
    static relayswarmShadow = true;
    constructor(cfg) { this.config = cfg; this.inner = new Loader(cfg); this.stats = this.inner.stats; this.context = null; this.token = 0; }
    load(context, policy, callbacks) {
      this.abort(); this.context = context;
      const token = ++this.token, own = noteDemand(context, this.config, policy);
      const existing = own && (cache.get(own.key) ?? (active?.key === own.key ? active.promise : null));
      if (existing) {
        if (existing instanceof Promise) counters.coalesced++;
        this.reuseAbort = new AbortController();
        Promise.resolve(existing).then(async row => {
          if (token !== this.token) return;
          if (closed) return this.start(context, policy, callbacks, token);
          if (!row) return this.start(context, policy, callbacks, token);
          // A cache entry authenticates bytes, not continuing authority. Read
          // the host's current commitment/delegation/revocation view again.
          let permit;
          try { permit = await authorise(context, this.reuseAbort.signal); } catch {}
          if (token !== this.token) return;
          if (closed) return this.start(context, policy, callbacks, token);
          if (!permit || permit.key !== row.permit.key || permit.size !== row.permit.size || permit.sha256 !== row.permit.sha256) {
            drop(own.key); return this.start(context, policy, callbacks, token);
          }
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
      if (demand.size > 1 && active) { const old = active; active = null; old.cancel(); counters.cancelled++; counters.reservationBytes = 0; }
      const end = () => { demand.delete(this); queueMicrotask(pump); };
      const wrapped = { ...callbacks };
      for (const name of ['onSuccess', 'onError', 'onTimeout', 'onAbort']) wrapped[name] = (...args) => {
        end(); if (token === this.token) callbacks[name]?.(...args);
      };
      this.inner.load(context, policy, wrapped);
    }
    abort() { this.token++; this.reuseAbort?.abort(); demand.delete(this); this.inner.abort(); }
    destroy() { this.token++; this.reuseAbort?.abort(); demand.delete(this); this.inner.destroy(); }
    getCacheAge() { return this.inner.getCacheAge?.() ?? null; }
    getResponseHeader(name) { return this.inner.getResponseHeader?.(name) ?? null; }
  };
  return { Loader: Wrapped, clear, release(key) { for (const [id, row] of cache) if (row.permit.key === key) drop(id); },
    stop() { closed = true; clear(); }, snapshot: () => ({ ...counters,
    active: Number(Boolean(active)), queued: queued.length, cacheObjects: cache.size,
    limits: { objects: MAX_OBJECTS, bytes: MAX_BYTES, speculativeWholeRequests: 1, deadlineMs: DEADLINE_MS } }) };
}
