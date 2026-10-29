// Optional, bounded work for the same visible player's next parsed fragments.
// A bounded poll exists only while the first genuine startup terminal waits;
// no media clock, playback command, background holder or alternate rendition
// is created here. The supplied loader remains the SDK's loader.
export const WARM_AHEAD = Symbol('relayswarm-warm-ahead');
const MAX_BYTES = 24 * 1024 * 1024, MAX_OBJECTS = 3, MAX_STARTUP_OBJECTS = 4, DEADLINE_MS = 8_000, STARTUP_DEADLINE_MS = 12_000, STARTUP_POLL_MS = 100;
const validInterval = item => {
  const { start, duration } = item?.context?.frag ?? {};
  return Number.isFinite(start) && start >= 0 && Number.isFinite(duration) && duration > 0 && Number.isFinite(start + duration);
};
const inside = (item, time) => validInterval(item) && item.context.frag.start <= time && time < item.context.frag.start + item.context.frag.duration;
// Allow bounded floating-point roundoff when Hls refreshes parsed geometry.
const sameTime = (a, b) => a === b || Math.abs(a - b) <= Math.min(1e-9,
  32 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)));
const samePosition = (a, b) => a?.key === b?.key && a?.scope === b?.scope && validInterval(a) && validInterval(b) &&
  sameTime(a.context.frag.start, b.context.frag.start) && sameTime(a.context.frag.duration, b.context.frag.duration);
const futureServiceTime = (stats, size, entry, success) => {
  try {
    const { start, end } = stats.loading;
    return stats.aborted !== true && stats.loaded === size &&
      [entry, success, start, end].every(Number.isFinite) && entry >= 0 &&
      entry <= start && start < end && end <= success ? end - start : null;
  } catch { return null; }
};

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
  reuseBudget = () => 0, allowed = () => true, prefetch = () => true, steady = true, startupTarget = null, startupCommit = null, startupMaxBytes = MAX_BYTES, startupRecovery = () => 2_000 }) {
  if (!Number.isSafeInteger(startupMaxBytes) || startupMaxBytes < MAX_BYTES || startupMaxBytes > 32 * 1024 * 1024 ||
      startupMaxBytes !== MAX_BYTES && typeof startupTarget !== 'function') throw new RangeError('Invalid startup byte budget');
  let closed = false, generation = 0, active = null, scope = null, queued = [], config, loaderConfig, latestDemand = null, loadId = 0;
  const cache = new Map(), demand = new Set(), jobs = new Map(), promoted = new Set(), reuseWaiters = new Set(), pins = new Map();
  const startup = { enabled: typeof startupTarget === 'function', state: startupTarget ? 'idle' : 'off', reason: null,
    owner: null, terminal: null, own: null, permit: null, response: null, verified: false, reserved: 0,
    controller: null, timer: null, poll: null, plan: [], cursor: null, frozenStart: null, hopAvailable: true, checking: false, targetTime: null, verifiedStart: null, verifiedEnd: null,
    requiredHeadroomMs: null, planningServiceMs: null, released: 0, failures: 0, cancellations: 0, commitStarted: false, commitCompleted: false };
  const counters = { started: 0, verified: 0, rejected: 0, cancelled: 0, coalesced: 0, promotions: 0, localReuseBytes: 0,
    verifiedBytes: 0, verifiedPeerBytes: 0, consumedPeerBytes: 0, cacheBytes: 0, highWaterBytes: 0 };
  const futureReserved = () => [...jobs.values()].reduce((sum, row) => sum + row.reserved, 0);
  const reserved = () => startup.reserved + futureReserved();
  const byteLimit = () => startup.state === 'buffering' ? startupMaxBytes : MAX_BYTES;
  const bytesFit = size => counters.cacheBytes + futureReserved() + size <= MAX_BYTES &&
    counters.cacheBytes + reserved() + size <= byteLimit();
  const tracked = () => new Set([...cache.keys(), ...jobs.keys(), ...(startup.owner ? [startup.own.key] : [])]).size;
  const objectLimit = () => startup.state === 'buffering' ? MAX_STARTUP_OBJECTS : MAX_OBJECTS;
  const owns = row => jobs.get(row.key) === row && !row.finished;
  const live = row => owns(row) && !row.cancelled;
  const drop = key => { const row = cache.get(key); if (row) { counters.cacheBytes -= row.data.byteLength; cache.delete(key); } };
  const finishJob = (row, result) => {
    if (!owns(row)) return;
    row.finished = true; jobs.delete(row.key); promoted.delete(row);
    if (active === row) active = null;
    row.reserved = 0; row.finish(result);
    if (startup.checking) startup.recheck = true;
    void checkStartup();
    queueMicrotask(pump);
  };
  const cancelJob = row => {
    if (!live(row)) return;
    counters.cancelled++; row.cancelled = true; row.cancel();
    // An awaited validator may still own its body. Do not lend that slot or
    // reservation to replacement work until the actual await settles.
    if (!row.validating) finishJob(row, null);
  };
  const clear = () => {
    if (startup.state === 'idle' || startup.state === 'buffering') endStartup('cancelled', 'cleared', !closed);
    startup.planningServiceMs = null;
    generation++; queued = []; latestDemand = null;
    for (const row of [...jobs.values()]) cancelJob(row);
    for (const key of cache.keys()) drop(key);
    for (const resume of [...reuseWaiters]) resume(true);
  };
  const promotedHeadroom = () => {
    const revision = generation, latest = latestDemand;
    for (const row of promoted) {
      if (!live(row)) continue;
      const genuine = row.genuine();
      try { if (!genuine || !(reuseBudget(genuine.context) > 0)) return false; }
      catch { return false; }
      if (closed || revision !== generation || latest !== latestDemand || !live(row)) return false;
    }
    return !closed && revision === generation && latest === latestDemand;
  };
  const pump = () => {
    if (closed || active || !allowed() || !queued.length || demand.size + promoted.size > 1 ||
        (!steady && startup.state !== 'buffering') || (startup.state === 'buffering' && (!startup.permit || !startup.verified || startup.checking))) return;
    const pumpRevision = generation, latest = latestDemand;
    if (!promotedHeadroom() || !allowed() || closed || active || pumpRevision !== generation || latest !== latestDemand || !queued.length) return;
    if (startup.state === 'buffering' && !prepareStartupAdmission()) return;
    // A pending bootstrap may replace obsolete future rows, but cannot evict
    // current coverage (or an authority pin) simply to admit another object.
    if (startup.state === 'buffering' && tracked() >= objectLimit()) return;
    let item = queued.shift();
    if (cache.has(item.key) || jobs.has(item.key)) { queueMicrotask(pump); return; }
    const deadline = item.deadline ?? performance.now() + DEADLINE_MS;
    if (performance.now() >= deadline) { queueMicrotask(pump); return; }
    if (item.deadline !== undefined) {
      const revision = generation, latest = latestDemand, pendingQueue = queued;
      let current;
      try { current = latest && parsedNext(latest.own).find(future => samePosition(future, item)); } catch {}
      if (closed || active || revision !== generation || latest !== latestDemand || pendingQueue !== queued) return;
      if (!current || performance.now() >= deadline) { queueMicrotask(pump); return; }
      item = { ...current, deadline };
    }
    while (tracked() >= MAX_OBJECTS && cache.size && startup.state !== 'buffering') drop(cache.keys().next().value);
    if (tracked() >= objectLimit()) return;
    const controller = new AbortController(), revision = generation, cfg = config, policy = loaderConfig;
    const workContext = item.context, workFragment = workContext.frag, workIdentity = metadataOnly(item);
    let loader, timer, finish;
    const row = { ...item, deadline, reserved: 0, finished: false, waiters: new Set(), genuineAt: null,
      promise: new Promise(resolve => { finish = resolve; }),
      noteDemand(at) {
        row.genuineAt ??= at;
        item.context[WARM_AHEAD]?.onGenuine?.();
      },
      genuine() {
        if (!live(row)) return null;
        const waiter = [...row.waiters].find(loader => loader.pendingTerminal && warmContext(loader.context)?.key === row.key);
        return waiter && row.genuineAt !== null ? { at: row.genuineAt, context: waiter.context } : null;
      },
      promote() { clearTimeout(timer); },
      finish: result => finish(result), cancel() {
        controller.abort(); clearTimeout(timer); try { loader?.abort(); loader?.destroy(); } catch {}
      } };
    active = row; jobs.set(row.key, row);
    timer = setTimeout(() => cancelJob(row), Math.max(0, deadline - performance.now()));
    const deferSpeculation = () => {
      if (row.genuine()) return false;
      const room = promotedHeadroom();
      if (!allowed() || controller.signal.aborted || closed || revision !== generation || !live(row)) return true;
      if (row.genuine() || room) return false;
      // Only metadata returns to the current parsed plan; no body, permit or
      // validator escapes its owner, and re-admission cannot renew eight seconds.
      const latest = latestDemand, wanted = latest?.upcoming.some(future => samePosition(future, item));
      const deferred = wanted && performance.now() < deadline ? { ...metadataOnly(item), deadline } : null;
      const pendingQueue = queued, index = queued.findIndex(future => samePosition(future, item));
      const genuine = row.genuine();
      if (controller.signal.aborted || closed || revision !== generation || !live(row)) return true;
      if (genuine) return false;
      if (latest !== latestDemand || pendingQueue !== queued) return true;
      row.reserved = 0;
      if (deferred) {
        if (index < 0) queued.unshift(deferred); else queued[index] = deferred;
      }
      return true;
    };
    void (async () => {
      try {
        let permit;
        row.validating = true;
        try { permit = await authorise(item.context, controller.signal); }
        finally { row.validating = false; }
        if (controller.signal.aborted || closed || revision !== generation || !live(row) || !allowed()) return null;
        if (!permit || !Number.isSafeInteger(permit.size) || permit.size < 1 || permit.size > MAX_BYTES) { counters.rejected++; return null; }
        if (deferSpeculation()) return null;
        // Only optional steady work may yield to another contributor. Startup
        // coverage and a genuine demand promoted during authorisation retain
        // their existing source path, without a wait or a renewed deadline.
        if ((startup.state === 'off' || startup.state === 'ready') && !row.genuine()) {
          let proceed = false;
          try { proceed = prefetch(item.context, permit) === true; } catch {}
          if (!row.genuine() && !proceed) return null;
          if (controller.signal.aborted || closed || revision !== generation || !live(row) || !allowed()) return null;
        }
        while (!bytesFit(permit.size) && cache.size && startup.state !== 'buffering') drop(cache.keys().next().value);
        if (!bytesFit(permit.size)) { counters.rejected++; return null; }
        row.reserved = permit.size;
        if (!reserve(reserved())) { row.reserved = 0; counters.rejected++; return null; }
        if (controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
        if (deferSpeculation()) return null;
        if (controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
        // Freeze only an admitted, reserved future, never a skipped metadata
        // candidate or a request refused by the object/byte budget.
        if (startup.state === 'buffering') {
          if (!startupCurrent()) return null;
          if (startup.frozenStart === null && item.context.frag.start > startup.targetTime)
            startup.frozenStart = item.context.frag.start;
        }
        counters.highWaterBytes = Math.max(counters.highWaterBytes, counters.cacheBytes + reserved());
        const warm = item.context[WARM_AHEAD] = { peerBytes: 0, genuine: () => row.genuine(),
          ...(steady && startup.state !== 'buffering' ? { work: () => {
            try {
              if (!allowed()) return null;
              const current = warmContext(workContext), genuine = row.genuine();
              const identityCurrent = item.context === workContext && workContext.frag === workFragment &&
                workContext.url === workIdentity.context.url && workFragment.url === workIdentity.context.frag.url &&
                samePosition(current, workIdentity);
              if (!identityCurrent || closed || revision !== generation || !live(row) || controller.signal.aborted ||
                  scope !== workIdentity.scope || !genuine && performance.now() >= deadline) return null;
              return { context: workContext, enteredAt: deadline - DEADLINE_MS, deadline, signal: controller.signal, genuine };
            } catch { return null; }
          } } : {}),
          startupDependency: () => {
            if (!startupCurrent() || !live(row) || !allowed() || !startupFutureCurrent(item)) return null;
            try {
              if (readStartupTarget() === null || !startupCurrent()) return null;
              return { at: startup.entryAt, deadline: startup.deadline, signal: startup.controller.signal, context: item.context };
            } catch { return null; }
          } };
        loader = new Loader(cfg);
        if (controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
        counters.started++;
        const requestEntry = performance.now();
        const response = await new Promise(resolve => loader.load(item.context, policy, {
          // Keep only an elapsed scalar before destroy/reuse can mutate stats.
          // It becomes planning evidence only after this whole future verifies.
          onSuccess: (response, stats, _context, details) => resolve({ response, stats, details,
            serviceMs: futureServiceTime(stats, permit.size, requestEntry, performance.now()) }),
          onError: (...args) => resolve({ failure: { name: 'onError', args, stats: loader.stats } }),
          onTimeout: (...args) => resolve({ failure: { name: 'onTimeout', args, stats: loader.stats } }),
          onAbort: (...args) => resolve({ failure: { name: 'onAbort', args, stats: loader.stats } }),
          onProgress: stats => { if (stats?.loaded > permit.size) { controller.abort(); try { loader.abort(); } catch {} resolve(null); } },
        }));
        if (response?.failure) {
          if (controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
          counters.rejected++; return response;
        }
        if (!response || controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
        let valid;
        row.validating = true;
        try { valid = await verify(permit, response.response.data, item.context, controller.signal); }
        finally { row.validating = false; }
        if (!valid) { counters.rejected++; return null; }
        if (controller.signal.aborted || closed || revision !== generation || !live(row)) return null;
        const data = response.response.data;
        if (data.byteLength !== permit.size) { counters.rejected++; return null; }
        row.reserved = 0;
        if (onVerified?.(permit, data, item.context) === false) return null;
        const result = { ...response, context: item.context, scope: item.scope, data, permit, peerBytes: warm.peerBytes, accept: warm.accept };
        cache.set(item.key, result); counters.cacheBytes += data.byteLength; counters.verified++;
        counters.verifiedBytes += data.byteLength; counters.verifiedPeerBytes += warm.peerBytes;
        if (startupCurrent() && live(row) && generation === revision && item.scope === scope && startupFutureCurrent(item))
          startup.planningServiceMs = response.serviceMs;
        return result;
      } catch { if (!controller.signal.aborted) counters.rejected++; return null; }
      finally { clearTimeout(timer); try { loader?.destroy(); } catch {} }
    })().then(result => finishJob(row, result));
  };
  const noteDemand = (context, cfg, policy, owner) => {
    latestDemand = null;
    const own = warmContext(context);
    if (!own || closed) return null;
    if (scope !== own.scope) { if (scope !== null) clear(); scope = own.scope; }
    config = cfg; loaderConfig = policy;
    let upcoming = [];
    try { upcoming = next(context).map(warmContext).filter(Boolean).filter(item => item.scope === scope).slice(0, 2); }
    catch { /* Malformed future metadata cannot break the demanded load. */ }
    const keep = new Set([own.key, ...upcoming.map(item => item.key)]);
    for (const key of cache.keys()) if (!keep.has(key)) drop(key);
    for (const row of [...jobs.values()]) if (!keep.has(row.key)) cancelJob(row);
    queued = upcoming.map(item => {
      const deferred = queued.find(previous => previous.deadline !== undefined && samePosition(previous, item));
      return deferred ? { ...item, deadline: deferred.deadline } : item;
    });
    if (validInterval(own) && upcoming.every(validInterval))
      latestDemand = { own: metadataOnly(own), upcoming: upcoming.map(metadataOnly), owner };
    return own;
  };
  const startupCurrent = () => {
    if (startup.state !== 'buffering' || closed || startup.revision !== generation ||
        startup.owner?.pendingTerminal !== startup.terminal || startup.terminal.settled) return false;
    let valid = false;
    try {
      valid = samePosition(warmContext(startup.terminal.context), startup.identity) &&
        samePosition(warmContext(startup.own.context), startup.identity) &&
        startup.terminal.context.url === startup.contextUrl && startup.terminal.context.frag.url === startup.fragUrl;
    } catch {}
    if (!valid) { endStartup('cancelled', 'context-changed'); return false; }
    return true;
  };
  const startupError = reason => ({ code: 0, text: 'RelaySwarm startup buffer unavailable', startupBufferReason: reason });
  const parsedNext = item => next(item.context).map(warmContext).filter(Boolean)
    .filter(future => future.scope === scope && validInterval(future)).slice(0, 2);
  const metadataOnly = item => {
    const { key, scope, context: { url, frag } } = warmContext(item.context);
    // warmContext preserves loader fields, including WARM_AHEAD closures. A
    // plan/cursor must never keep that runtime object, its response promise or
    // an arbitrary host reference after the corresponding cache row is gone.
    return { key, scope, context: { url, frag, part: null, responseType: 'arraybuffer' } };
  };
  const planFuture = (item, parent) => ({ ...metadataOnly(item), identity: metadataOnly(item), parent: metadataOnly(parent) });
  const plannedCurrent = item => {
    try {
      return samePosition(warmContext(item.context), item.identity) &&
        parsedNext(item.parent).some(future => samePosition(future, item.identity));
    } catch { return false; }
  };
  const startupFutureCurrent = item => {
    if (!startupCurrent() || latestDemand?.owner !== startup.terminal.id) return false;
    const planned = startup.plan.find(future => samePosition(future.identity, item));
    return Boolean(planned && plannedCurrent(planned));
  };
  const endStartup = (state, reason, notify = true) => {
    if (!['idle', 'buffering'].includes(startup.state)) return;
    const owner = startup.owner, terminal = startup.terminal;
    startup.state = state; startup.reason = reason;
    if (state === 'failed') startup.failures++;
    if (state === 'cancelled') startup.cancellations++;
    clearTimeout(startup.timer); startup.timer = null; clearTimeout(startup.poll); startup.poll = null;
    startup.controller?.abort(); startup.releasePins?.();
    startup.owner = null; startup.terminal = null; startup.response = null; startup.reserved = 0;
    queued = []; startup.plan = []; startup.cursor = null; startup.frozenStart = null; startup.planningServiceMs = null;
    for (const row of [...jobs.values()]) cancelJob(row);
    for (const key of cache.keys()) drop(key);
    if (!owner || !terminal || terminal.settled || owner.pendingTerminal !== terminal) return;
    // Retire before abort: the host loader may synchronously call onAbort.
    terminal.settled = true; owner.pendingTerminal = null; owner.token++; owner.stats.aborted = true;
    try { owner.inner.abort(); } catch {}
    if (!notify || closed) return;
    if (state === 'cancelled') terminal.callbacks.onAbort?.(owner.stats, terminal.context, null);
    else terminal.callbacks.onError?.(startupError(reason), terminal.context, null, owner.stats);
  };
  const readStartupTarget = () => {
    let value;
    try { value = startupTarget(); } catch { endStartup('failed', 'target-threw'); return null; }
    if (value === null) { endStartup('cancelled', 'target-unavailable'); return null; }
    if (!Number.isFinite(value) || value < 0) { endStartup('failed', 'invalid-target'); return null; }
    startup.targetTime = value; return value;
  };
  const readStartupRecovery = () => {
    let recovery;
    try { recovery = startupRecovery(startup.own.context); } catch {}
    if (!Number.isFinite(recovery) || recovery < 0) { endStartup('failed', 'invalid-recovery'); return null; }
    startup.requiredHeadroomMs = recovery; return recovery;
  };
  const rollStartup = (target, recovery) => {
    if (!startupCurrent() || startup.checking) return;
    if (startup.frozenStart !== null && target >= startup.frozenStart) startup.frozenStart = null;
    if (startup.plan.some(item => !plannedCurrent(item)) || startup.cursor && !plannedCurrent(startup.cursor))
      return endStartup('cancelled', 'context-changed');
    // Retain one metadata cursor when both futures pass behind the room clock.
    // Its parent is a single snapshot, not an ever-growing chain of old rows.
    while (startup.plan.length) {
      const item = startup.plan[0], row = cache.get(item.key), job = jobs.get(item.key);
      // A job may still own a full response inside an awaited verifier. Keep
      // its slot/reservation until finishJob, even after its interval expires.
      if (item.context.frag.start + item.context.frag.duration > target || job ||
          row && pins.has(row.permit.key) ||
          [...demand].some(loader => loader.pendingTerminal && warmContext(loader.context)?.key === item.key)) break;
      if (!row) { if (!startup.hopAvailable) return; startup.hopAvailable = false; }
      startup.cursor = item; startup.plan.shift();
      queued = queued.filter(future => future.key !== item.key);
      if (!startupCurrent() || startup.checking) return;
      drop(item.key);
    }
    // Preserve a fully verified contiguous future prefix when the fourth
    // startup residency slot can extend it. The original held first body
    // still owns a slot even after its interval is behind the room target.
    let futureLimit = 2;
    if (startup.verified && startup.response && startup.plan.length === 2 && cache.size === 2 &&
        !active && !jobs.size && !demand.size && !promoted.size &&
        startup.plan.every(item => cache.has(item.key) && !pins.has(cache.get(item.key).permit.key))) {
      const covered = coverage(target);
      if (covered.end !== null && startup.plan.every(item => covered.rows.includes(cache.get(item.key))) &&
          (covered.end - target) * 1000 < recovery) futureLimit = MAX_STARTUP_OBJECTS - 1;
    }
    // Without a usable contiguous prefix, preserve the original rolling
    // policy: free its first future once and wait for the new window start.
    const first = startup.plan[0];
    if (futureLimit === 2 && startup.verified && startup.response && startup.plan.length === 2 && cache.size === 2 &&
        !active && !jobs.size && !demand.size && !promoted.size && inside(first, target) &&
        startup.plan.every(item => cache.has(item.key) && !pins.has(cache.get(item.key).permit.key))) {
      const covered = coverage(target);
      if (covered.end !== null && (covered.end - target) * 1000 < recovery) {
        startup.cursor = first; startup.plan.shift(); drop(first.key);
        startup.frozenStart = startup.plan[0].context.frag.start;
      }
    }
    while (startup.plan.length < futureLimit) {
      const last = startup.plan.at(-1);
      const parent = startup.cursor && (!last || startup.cursor.context.frag.start > last.context.frag.start)
        ? startup.cursor : last ?? startup.own;
      let item;
      try { item = parsedNext(parent)[0]; } catch { return endStartup('cancelled', 'context-changed'); }
      if (!item) return;
      const boundary = parent.context.frag.start + parent.context.frag.duration;
      if (Math.abs(item.context.frag.start - boundary) > 0.001 || item.key === startup.own.key ||
          startup.plan.some(future => future.key === item.key)) return endStartup('cancelled', 'context-changed');
      const planned = planFuture(item, parent);
      if (item.context.frag.start + item.context.frag.duration <= target) {
        // At most one unrequested obsolete hop per poll. Never download an old
        // fragment or scan an arbitrary horizon to chase a distant target.
        if (!startup.hopAvailable) return;
        startup.hopAvailable = false; startup.cursor = planned; return;
      }
      startup.plan.push(planned);
      // The loader can add markers to its own context. Keep that context
      // separate from the payload-free plan and its latest-demand snapshot.
      queued.push(item);
    }
  };
  const prepareStartupAdmission = () => {
    if (!startupCurrent() || startup.checking) return false;
    const target = readStartupTarget(); if (target === null || !startupCurrent()) return false;
    const recovery = readStartupRecovery(); if (recovery === null || !startupCurrent()) return false;
    rollStartup(target, recovery);
    if (!startupCurrent() || startup.checking || !queued.length) return false;
    // Once a future window starts ahead of the real target, fill it without
    // chasing another projected horizon. Release still needs actual coverage.
    if (startup.frozenStart !== null && target < startup.frozenStart) return true;
    const item = queued[0], index = startup.plan.findIndex(future => future.key === item.key);
    if (index < 0) { endStartup('cancelled', 'context-changed'); return false; }
    // Keep the fourth-slot extension of two verified contiguous futures;
    // a previous service sample cannot turn their successor into a gap.
    if (startup.verified) {
      const covered = coverage(target);
      if (covered.rows.some(row => row.context === startup.own.context) &&
          Math.abs(item.context.frag.start - covered.end) <= 0.001) return true;
      if (covered.end !== null && covered.rows.filter(row => row.context !== startup.own.context).length >= 2 &&
          Math.abs(item.context.frag.start - covered.end) <= 0.001) return true;
    }
    if (item.context.frag.start + item.context.frag.duration <= target + (recovery + (startup.planningServiceMs ?? 0)) / 1000) {
      if (!startup.hopAvailable) return false;
      startup.hopAvailable = false;
      startup.cursor = startup.plan[index]; startup.plan.splice(index, 1); queued.shift();
      rollStartup(target, recovery);
      // Do not recurse through metadata. The existing bounded poll is the
      // only source of another skip allowance; no deadline is renewed.
      return false;
    }
    return true;
  };
  const scheduleStartupPoll = () => {
    if (startup.poll !== null || !startupCurrent()) return;
    const remaining = startup.deadline - performance.now();
    if (remaining <= 0) return endStartup('failed', 'deadline');
    startup.poll = setTimeout(() => {
      startup.poll = null;
      if (!startupCurrent()) return;
      // The commit hook legitimately moves prepared -> publishing -> active.
      // Its original deadline/signal stay live; fresh checks follow its ACK.
      if (!startup.checking) {
        startup.hopAvailable = true;
        const target = readStartupTarget();
        if (target === null || !startupCurrent()) return;
        if (!allowed()) return endStartup('cancelled', 'not-allowed');
        const recovery = readStartupRecovery(); if (recovery === null || !startupCurrent()) return;
        rollStartup(target, recovery);
        if (!startupCurrent()) return;
        void checkStartup(target); queueMicrotask(pump);
      }
      scheduleStartupPoll();
    }, Math.min(STARTUP_POLL_MS, remaining));
  };
  const coverage = (target, checkedRows = null) => {
    const first = startup.verified && startup.response ? [{ ...startup.own, permit: startup.permit }] : [];
    const rows = (checkedRows ?? [...first, ...cache.values()]).filter(row => row.scope === scope && validInterval(row))
      .sort((a, b) => a.context.frag.start - b.context.frag.start);
    let start = null, end = null; const used = [];
    for (const row of rows) {
      const a = row.context.frag.start, z = a + row.context.frag.duration;
      if (start === null) { if (a <= target && target < z) { start = a; end = z; used.push(row); } }
      else if (a <= end + 0.001 && z > end) { end = z; used.push(row); }
    }
    startup.verifiedStart = start; startup.verifiedEnd = end;
    return { start, end, rows: used };
  };
  const startupHeadroomSufficient = (covered, target, recovery) => {
    if (covered.end === null) return false;
    const headroomMs = (covered.end - target) * 1000;
    // Publishing starts an advancing room clock. Exact equality cannot survive
    // a positive ACK delay; keep it valid for no-hook and post-ACK handoffs.
    return !startup.commitStarted && typeof startupCommit === 'function' ? headroomMs > recovery : headroomMs >= recovery;
  };
  const startupCandidate = (target = undefined) => {
    if (!startupCurrent()) return null;
    if (target === undefined) target = readStartupTarget();
    if (target === null || !startupCurrent()) return;
    if (!allowed()) return endStartup('cancelled', 'not-allowed');
    let recovery;
    try { recovery = startupRecovery(startup.own.context); } catch {}
    if (!Number.isFinite(recovery) || recovery < 0) return endStartup('failed', 'invalid-recovery');
    startup.requiredHeadroomMs = recovery;
    const covered = coverage(target);
    if (!startupHeadroomSufficient(covered, target, recovery)) return;
    return { covered, recovery };
  };
  const waitStartupCommit = signal => new Promise((resolve, reject) => {
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort);
      if (accepted) resolve(); else reject(null);
    };
    const abort = () => finish(false);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    try { Promise.resolve(startupCommit(Object.freeze({ signal }))).then(() => finish(true), () => finish(false)); }
    catch { finish(false); }
  });
  const checkStartup = async (target = undefined) => {
    if (!startupCurrent() || startup.checking || !startup.verified) return;
    const candidate = startupCandidate(target); if (!candidate) return;
    startup.checking = true;
    const owner = startup.owner, terminal = startup.terminal, revision = generation;
    const resident = new Map(), pinKeys = [];
    let pinned = true;
    const releasePins = () => {
      if (!pinned) return;
      pinned = false;
      for (const key of pinKeys) {
        const count = (pins.get(key) ?? 0) - 1;
        if (count > 0) pins.set(key, count); else pins.delete(key);
      }
      if (startup.releasePins === releasePins) startup.releasePins = null;
    };
    startup.releasePins = releasePins;
    const residentCurrent = () => {
      if ([...resident.values()].some(({ key, row, identity }) => cache.get(key) !== row ||
          !samePosition(warmContext(row.context), identity) || row.data.byteLength !== row.permit.size)) {
        endStartup('failed', 'coverage-evicted'); return false;
      }
      if ([...resident.values()].some(({ key, row }) => !startupFutureCurrent({ key, scope: row.scope, context: row.context }))) {
        endStartup('cancelled', 'context-changed'); return false;
      }
      return true;
    };
    const validate = async ({ covered }) => {
      for (const [key, row] of cache) if (covered.rows.includes(row) && !resident.has(row)) {
        resident.set(row, { key, row, identity: warmContext(row.context) });
        pinKeys.push(row.permit.key); pins.set(row.permit.key, (pins.get(row.permit.key) ?? 0) + 1);
      }
      const checks = [{ context: startup.own.context, permit: startup.permit },
        ...covered.rows.filter(row => row.context !== startup.own.context)];
      const permits = await Promise.all(checks.map(row => authorise(row.context, startup.controller.signal)));
      // Return the final verdict, rather than running it inside this async
      // function: its caller's await is another microtask boundary. No such
      // boundary may separate current authority from the actual handoff.
      return () => {
        if (!startupCurrent() || generation !== revision) return;
        if (permits.some((permit, i) => !permit || permit.key !== checks[i].permit.key ||
            permit.size !== checks[i].permit.size || permit.sha256 !== checks[i].permit.sha256))
          return endStartup('failed', 'authority-changed');
        const fresh = readStartupTarget(); if (fresh === null || !startupCurrent()) return;
        if (!allowed()) return endStartup('cancelled', 'not-allowed');
        let recovery;
        try { recovery = startupRecovery(startup.own.context); } catch {}
        if (!Number.isFinite(recovery) || recovery < 0) return endStartup('failed', 'invalid-recovery');
        startup.requiredHeadroomMs = recovery;
        // A permission obtained early in the batch can expire or be revoked
        // while another row yields. Recheck its same signed authority now,
        // synchronously, with no new metadata request or renewed deadline.
        if (permits.some((permit, i) => typeof permit.current !== 'function' || permit.current(checks[i].context) !== true))
          return endStartup('failed', 'authority-changed');
        if (!startupCurrent()) return;
        if (performance.now() >= startup.deadline) return endStartup('failed', 'deadline');
        if (!residentCurrent()) return;
        const final = coverage(fresh, covered.rows);
        if (!startupHeadroomSufficient(final, fresh, recovery)) return;
        return true;
      };
    };
    try {
      let current = await validate(candidate);
      if (!current()) return;
      if (typeof startupCommit === 'function' && !startup.commitStarted) {
        startup.commitStarted = true;
        try { await waitStartupCommit(startup.controller.signal); }
        catch { if (startupCurrent()) endStartup('failed', 'commit-refused'); return; }
        if (!startupCurrent()) return;
        if (performance.now() >= startup.deadline) return endStartup('failed', 'deadline');
        startup.commitCompleted = true;
        if (!residentCurrent()) return;
        // ACK may establish a new clock target or retire this scope. Keep the
        // same held objects/pins and recheck all authority and geometry before
        // any player callback or consumed credit. Never invoke the hook again.
        const afterCommit = startupCandidate();
        if (!afterCommit) return;
        current = await validate(afterCommit);
        if (!current()) return;
      }
      // Same pending play and same response/context/stats. Only now can the
      // first verified peer object become accepted-player contribution.
      const args = startup.response;
      const mark = terminal.context[WARM_AHEAD];
      onReuse?.(terminal.context, args[0].data.byteLength, mark?.peerBytes ?? 0);
      if (!startupCurrent()) return;
      if (!allowed()) return endStartup('cancelled', 'not-allowed');
      // Internal accounting has no host notification. Keep cancellation
      // ownership until the exact terminal callback is committed to Hls.
      (mark?.commit ?? mark?.accept)?.(terminal.context);
      if (!startupCurrent()) return;
      if (mark?.peerBytes > 0) counters.consumedPeerBytes += mark.peerBytes;
      startup.state = 'ready'; startup.reason = null; startup.released++;
      startup.planningServiceMs = null;
      clearTimeout(startup.timer); startup.timer = null; clearTimeout(startup.poll); startup.poll = null; startup.reserved = 0;
      const completedController = startup.controller;
      startup.owner = null; startup.terminal = null; startup.response = null; startup.plan = []; startup.cursor = null; startup.frozenStart = null;
      if (!steady) { queued = []; for (const row of [...jobs.values()]) cancelJob(row); }
      try { owner.deliver(terminal, 'onSuccess', args); }
      finally {
        // The hook exposes this signal to host code. Its normal cleanup may
        // reenter stop/destroy, so only abort it after the exact Hls handoff.
        try { completedController.abort(); } finally { mark?.notify?.(); }
      }
    } catch { if (startupCurrent()) endStartup('failed', 'authority-refused'); }
    finally {
      releasePins();
      startup.checking = false;
      if (startup.state === 'buffering') {
        queueMicrotask(pump);
        if (startup.recheck) { startup.recheck = false; queueMicrotask(checkStartup); }
      }
    }
  };
  const beginStartup = (owner, terminal, own, policy) => {
    if (!startup.enabled) return true;
    if (startup.state === 'failed' || startup.state === 'cancelled') {
      if (startup.state === 'cancelled') owner.stats.aborted = true;
      owner.deliver(terminal, startup.state === 'cancelled' ? 'onAbort' : 'onError', startup.state === 'cancelled'
        ? [owner.stats, terminal.context, null] : [startupError(startup.reason), terminal.context, null, owner.stats]);
      return false;
    }
    if (!own) {
      if (startup.state === 'idle' && terminal.context.frag?.type === 'main' && terminal.context.frag.sn !== 'initSegment') {
        startup.state = 'failed'; startup.reason = 'unsupported-context'; startup.failures++;
        owner.deliver(terminal, 'onError', [startupError(startup.reason), terminal.context, null, owner.stats]);
        return false;
      }
      return true;
    }
    if (startup.state === 'buffering') {
      endStartup('cancelled', 'superseded');
      owner.deliver(terminal, 'onAbort', [owner.stats, terminal.context, null]);
      return false;
    }
    if (startup.state !== 'idle') return true;
    const at = performance.now(), parent = policy?.loadPolicy?.maxLoadTimeMs ?? policy?.timeout;
    Object.assign(startup, { state: 'buffering', owner, terminal, own, revision: generation, reserved: startupMaxBytes, entryAt: at,
      identity: { key: own.key, scope: own.scope, context: { frag: { start: own.context.frag.start, duration: own.context.frag.duration } } },
      contextUrl: terminal.context.url, fragUrl: terminal.context.frag.url,
      controller: new AbortController(), deadline: at + Math.min(STARTUP_DEADLINE_MS, Number.isFinite(parent) && parent > 0 ? parent : STARTUP_DEADLINE_MS) });
    startup.plan = (latestDemand?.upcoming ?? []).map(item => planFuture(item, own));
    if (latestDemand?.owner === terminal.id) latestDemand.rolling = startup.plan;
    startup.cursor = null;
    terminal.context[WARM_AHEAD] = { peerBytes: 0, genuine: () => startupCurrent() ? { at, context: terminal.context } : null };
    if (!validInterval(own) || !allowed()) { endStartup('failed', 'not-allowed'); return false; }
    if (owner.config.progressive === true) { endStartup('failed', 'progressive-unsupported'); return false; }
    if (readStartupTarget() === null) return false;
    if (!startupCurrent()) return false;
    // Authorisation may yield while HTTP is already delivering a whole body.
    // Admit its worst case against the shared held-cache cap first.
    try {
      if (!reserve(reserved())) { endStartup('failed', 'reservation-refused'); return false; }
    } catch { endStartup('failed', 'reservation-refused'); return false; }
    if (!startupCurrent()) return false;
    if (!allowed()) { endStartup('cancelled', 'not-allowed'); return false; }
    startup.timer = setTimeout(() => endStartup('failed', 'deadline'), Math.max(0, startup.deadline - performance.now()));
    scheduleStartupPoll();
    // Keep the first normal HTTP load synchronous; metadata work follows it.
    void Promise.resolve().then(() => startupCurrent() ? authorise(own.context, startup.controller.signal) : null).then(permit => {
      if (!startupCurrent()) return;
      if (!permit || !Number.isSafeInteger(permit.size) || permit.size < 1 || permit.size > MAX_BYTES)
        return endStartup('failed', 'first-authority-refused');
      startup.permit = permit; startup.reserved = permit.size;
      if (!reserve(reserved())) return endStartup('failed', 'reservation-refused');
      counters.highWaterBytes = Math.max(counters.highWaterBytes, counters.cacheBytes + reserved());
      void verifyStartup(); queueMicrotask(pump);
    }).catch(() => { if (startupCurrent()) endStartup('failed', 'first-authority-refused'); });
    return true;
  };
  const verifyStartup = async () => {
    if (!startupCurrent() || !startup.response || !startup.permit || startup.verifying || startup.verified) return;
    startup.verifying = true;
    try {
      const data = startup.response[0].data, permit = startup.permit;
      if (!(data instanceof ArrayBuffer) || data.byteLength !== permit.size ||
          !await verify(permit, data, startup.own.context, startup.controller.signal))
        return startupCurrent() && endStartup('failed', 'first-integrity');
      if (!startupCurrent()) return;
      // The original first buffer goes to hls.js, which may transfer it.
      // Keep it only in this reservoir; future objects use the normal shared
      // warm/held cache and its player-facing copy on genuine reuse.
      startup.verified = true; counters.verified++;
      counters.verifiedBytes += data.byteLength;
      counters.verifiedPeerBytes += startup.terminal.context[WARM_AHEAD]?.peerBytes ?? 0;
      void checkStartup();
      queueMicrotask(pump);
    } catch { if (startupCurrent()) endStartup('failed', 'first-integrity'); }
    finally { startup.verifying = false; }
  };
  const Wrapped = class WarmAheadLoader {
    static relayswarmShadow = true;
    constructor(cfg) { this.config = cfg; this.inner = new Loader(cfg); this.stats = this.inner.stats; this.context = null; this.token = 0; }
    load(context, policy, callbacks) {
      this.abort(); this.context = context;
      const terminal = { id: ++loadId, context, callbacks: { ...callbacks }, settled: false };
      this.pendingTerminal = terminal;
      callbacks = { ...callbacks };
      for (const name of ['onSuccess', 'onError', 'onTimeout', 'onAbort'])
        callbacks[name] = (...args) => this.complete(terminal, name, args);
      const token = ++this.token, own = noteDemand(context, this.config, policy, terminal.id), cached = own && cache.get(own.key);
      if (!beginStartup(this, terminal, own, policy)) return;
      const pendingRow = !cached && own && jobs.get(own.key);
      const demandAt = performance.now();
      if (pendingRow && live(pendingRow) && !pendingRow.genuine() && demandAt >= pendingRow.deadline) {
        cancelJob(pendingRow);
        if (token !== this.token || this.pendingTerminal !== terminal || terminal.settled) return;
      }
      const pending = pendingRow && live(pendingRow) ? pendingRow : null, existing = cached ?? pending?.promise;
      if (existing) {
        if (pending) {
          counters.coalesced++;
          pending.waiters.add(this); this.warmPending = pending;
          pending.noteDemand(demandAt);
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
      const terminal = this.pendingTerminal;
      const end = () => { demand.delete(this); queueMicrotask(pump); };
      const wrapped = { ...callbacks };
      wrapped.onProgress = (...args) => {
        if (closed || token !== this.token || !terminal || terminal.settled || this.pendingTerminal !== terminal) return;
        if (startup.owner === this && (args[0]?.loaded > (startup.permit?.size ?? MAX_BYTES) ||
            args[2]?.byteLength > (startup.permit?.size ?? MAX_BYTES)))
          return endStartup('failed', 'first-oversize');
        if (startup.owner === this && args[2] !== null && args[2] !== undefined) {
          // Non-progressive XHR also reports the full body here. No payload
          // may reach demux before the verified terminal release.
          startupCurrent(); return;
        }
        callbacks.onProgress?.(...args);
      };
      for (const name of ['onSuccess', 'onError', 'onTimeout', 'onAbort']) wrapped[name] = (...args) => {
        end(); if (token === this.token) callbacks[name]?.(...args);
      };
      this.inner.load(context, policy, wrapped);
    }
    releasePending() {
      const row = this.warmPending; this.warmPending = null;
      if (row) {
        row.waiters.delete(this);
        if (!row.waiters.size) row.context[WARM_AHEAD]?.onGenuine?.();
        if (promoted.has(row) && !row.waiters.size) cancelJob(row);
      }
    }
    complete(terminal, name, args) {
      if (!terminal || terminal.settled || this.pendingTerminal !== terminal) return;
      if (startup.owner === this && startup.terminal === terminal && startup.state === 'buffering') {
        if (name === 'onSuccess') {
          const data = args[0]?.data;
          if (!(data instanceof ArrayBuffer) || data.byteLength > (startup.permit?.size ?? MAX_BYTES))
            return endStartup('failed', 'first-oversize');
          startup.response = args; void verifyStartup(); return;
        }
        // Preserve the original transport error; the bootstrap deadline cannot
        // restart when hls.js creates a retry loader in this same adapter.
        startup.state = name === 'onAbort' ? 'cancelled' : 'failed';
        startup.reason = name === 'onAbort' ? 'origin-abort' : 'origin-error';
        if (name === 'onAbort') startup.cancellations++; else startup.failures++;
        clearTimeout(startup.timer); clearTimeout(startup.poll); startup.poll = null;
        startup.controller?.abort(); startup.releasePins?.(); startup.owner = null; startup.terminal = null;
        startup.response = null; startup.reserved = 0; queued = []; startup.plan = []; startup.cursor = null; startup.frozenStart = null; startup.planningServiceMs = null;
        for (const row of [...jobs.values()]) cancelJob(row);
        for (const key of cache.keys()) drop(key);
      }
      this.deliver(terminal, name, args);
    }
    deliver(terminal, name, args) {
      if (!terminal || terminal.settled || this.pendingTerminal !== terminal) return;
      if (name !== 'onSuccess' && latestDemand?.owner === terminal.id) latestDemand = null;
      // hls.js resets/destroys the loader synchronously from onSuccess.
      // Retire ownership first so that cleanup cannot invent an abort.
      terminal.settled = true; this.pendingTerminal = null;
      terminal.callbacks[name]?.(...args);
    }
    cancel(destroy) {
      const terminal = this.pendingTerminal;
      if (startup.owner === this && startup.terminal === terminal) endStartup('cancelled', 'caller-abort', !destroy && !closed);
      if (terminal && latestDemand?.owner === terminal.id) latestDemand = null;
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
    startupSnapshot: () => ({ enabled: startup.enabled, state: startup.state, reason: startup.reason,
      heldObjects: startup.state === 'buffering' ? tracked() : 0,
      heldBytes: startup.state === 'buffering' ? counters.cacheBytes + reserved() : 0,
      targetTime: startup.targetTime, verifiedStart: startup.verifiedStart, verifiedEnd: startup.verifiedEnd,
      requiredHeadroomMs: startup.requiredHeadroomMs, planningServiceMs: startup.planningServiceMs,
      released: startup.released, failures: startup.failures,
      cancellations: startup.cancellations, commitStarted: startup.commitStarted, commitCompleted: startup.commitCompleted,
      limits: { objects: MAX_STARTUP_OBJECTS, bytes: startupMaxBytes, futureBytes: MAX_BYTES, deadlineMs: STARTUP_DEADLINE_MS } }),
    contains(time) {
      if (closed || !allowed() || !Number.isFinite(time)) return false;
      const currentJobs = [...jobs].filter(([, row]) => live(row));
      for (const row of [...currentJobs.map(([, row]) => row), ...cache.values()]) {
        if (row.scope === scope && inside(row, time)) return true;
      }
      const latest = latestDemand;
      if (!latest || latest.own.scope !== scope || !inside(latest.own, time)) return false;
      try {
        const upcoming = latest.rolling ?? next(latest.own.context).map(warmContext).filter(Boolean).filter(item => item.scope === scope).slice(0, 2);
        const planned = new Map([latest.own, ...upcoming].map(item => [item.key, item]));
        if ((latest.rolling ? upcoming.some(item => !plannedCurrent(item)) :
          upcoming.length !== latest.upcoming.length || upcoming.some((item, i) => !samePosition(item, latest.upcoming[i]))) ||
            [...currentJobs, ...cache].some(([key, row]) => !samePosition({ ...row, key }, planned.get(key)))) {
          latestDemand = null; return false;
        }
        // Successful HTTP can precede the first append. Retain only that last
        // genuine demand's bounded, still-parsed next window, without new work.
        return true;
      } catch { latestDemand = null; }
      return false;
    },
    pinned: key => pins.has(key), release(key) { for (const [id, row] of cache) if (row.permit.key === key) drop(id); },
    stop() { closed = true; clear(); }, snapshot: () => ({ ...counters,
      reservationBytes: reserved(), active: Number(Boolean(active)), promoted: promoted.size, trackedObjects: tracked(),
      queued: queued.length, cacheObjects: cache.size,
      limits: { objects: objectLimit(), bytes: byteLimit(), speculativeWholeRequests: 1, deadlineMs: startup.state === 'buffering' ? STARTUP_DEADLINE_MS : DEADLINE_MS, revalidationMs: 25 } }) };
}
