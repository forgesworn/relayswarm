// Optional refill waiting around the existing token bucket. Queue entries hold
// only identities/geometry; the provider looks up held bytes after every await.
export function createUploadPacer({ now, take, give, delay, validate, refuse, maxWaiters }) {
  const queued = new Map(), reserved = new Set();
  const counts = { waited: 0, waitTotalMs: 0, waitMaxMs: 0, granted: 0, expired: 0, cancelled: 0, refused: 0 };
  let closed = false, timer = null;
  const recordWait = row => {
    if (!row.waiting) return;
    const elapsed = Math.max(0, now() - row.queuedAt);
    counts.waited++; counts.waitTotalMs += elapsed; counts.waitMaxMs = Math.max(counts.waitMaxMs, elapsed);
  };
  const remove = (row, reason) => {
    if (queued.get(row.link) !== row) return;
    queued.delete(row.link); recordWait(row); counts[reason]++;
    refuse(reason); row.resolve(null);
  };
  const finish = (row, sent = false) => {
    if (!reserved.delete(row)) return;
    row.active = false;
    if (!sent) give(row.charge);
    queueMicrotask(pump);
  };
  const pump = () => {
    clearTimeout(timer); timer = null;
    if (closed) return;
    while (queued.size) {
      const row = queued.values().next().value;
      if (now() >= row.deadline) { remove(row, 'expired'); continue; }
      if (!validate(row)) { remove(row, 'cancelled'); continue; }
      if (!take(row.charge)) {
        row.waiting = true;
        const remaining = row.deadline - now();
        timer = setTimeout(pump, Math.max(1, Math.ceil(Math.min(remaining, delay(row.charge)))));
        return;
      }
      queued.delete(row.link); recordWait(row); row.active = true; row.controller = new AbortController();
      reserved.add(row); counts.granted++; row.resolve(row);
    }
  };
  const cancel = link => {
    for (const row of [...queued.values()]) if (!link || row.link === link) remove(row, 'cancelled');
    for (const row of [...reserved]) if (!link || row.link === link) {
      counts.cancelled++;
      row.controller.abort(); finish(row);
    }
    pump();
  };
  return {
    acquire(link, geometry) {
      if (closed || queued.has(link) || [...reserved].some(row => row.link === link) || queued.size >= maxWaiters) {
        counts.refused++; refuse('refused'); return Promise.resolve(null);
      }
      // Whole-object requests keep immediate refusal; refill waiting applies
      // only to the existing canonical-piece range path.
      if (!geometry.range && (queued.size || delay(geometry.charge) > 0)) {
        counts.refused++; refuse('refused'); return Promise.resolve(null);
      }
      return new Promise(resolve => {
        const queuedAt = now();
        queued.set(link, { link, key: geometry.key, size: geometry.size, charge: geometry.charge,
          range: geometry.range ? { start: geometry.range.start, end: geometry.range.end } : null,
          queuedAt, deadline: queuedAt + 250, resolve, waiting: queued.size > 0, active: false });
        pump();
      });
    },
    finish, cancel, recheck: pump,
    stop() { closed = true; cancel(); clearTimeout(timer); timer = null; },
    snapshot: () => ({ enabled: true, ...counts, queued: queued.size,
      reservedBytes: [...reserved].reduce((sum, row) => sum + row.charge, 0),
      limits: { waitMs: 250, waiters: maxWaiters, perLink: 1 } }),
  };
}
