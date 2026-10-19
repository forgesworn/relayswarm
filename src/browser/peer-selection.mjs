// Recent observations only: link measurements disappear with the link. These
// are completion times and payload rates, not network RTT or ABR estimates.
const RECENT_COMPLETIONS = 16;

export class PeerSelection {
  constructor() {
    this.observations = new WeakMap();
    this.turn = 0;
    this.order = 0;
    // Sizes and payload rates of recent completed transfers on any link.
    // Links are often replaced after a timeout, so this survives turnover.
    this.recentCompletions = [];
  }

  // Time the fastest recent completion at least this large would need for
  // this size; 0 without one. Smaller transfers carry more fixed overhead per
  // byte, so they never constrain a larger request. A request with less time
  // left cannot be expected to finish, yet a holder still sends it in full.
  minimumMs(size) {
    if (!size) return 0;
    let fastest = 0;
    for (const { bytes, rate } of this.recentCompletions) if (bytes >= size && rate > fastest) fastest = rate;
    return fastest ? size / fastest : 0;
  }

  summary(link) {
    const value = this.observations.get(link);
    return value ? { ...value } : { attempts: 0, latencyMs: null, throughputBytesPerSecond: null, failureRate: 0, consecutiveFailures: 0, lastSelected: 0 };
  }

  estimate(link, size) {
    const value = this.summary(link);
    if (value.latencyMs === null) return null;
    const transferMs = size && value.throughputBytesPerSecond ? size * 1000 / value.throughputBytesPerSecond : 0;
    return Math.max(value.latencyMs, transferMs);
  }

  select(links, key, tried, size, deadlineMs = Infinity) {
    const eligible = [...links].filter((link) => !link.closed && !link.busy && !tried.has(link.pubkey) && link.have.has(key)
      && (this.estimate(link, size) === null || this.estimate(link, size) * 1.25 + 25 <= deadlineMs));
    if (!eligible.length) return null;
    const cold = eligible.filter((link) => !this.observations.get(link)?.attempts);
    const measured = eligible.filter((link) => this.observations.get(link)?.attempts);
    const healthy = measured.filter((link) => this.summary(link).consecutiveFailures === 0);
    // One in four choices explores an unmeasured eligible link. Until any
    // observation exists, choose the least recently selected cold link.
    const explore = cold.length && (!healthy.length || this.turn === 0 && deadlineMs >= 100);
    this.turn = (this.turn + 1) % 4;
    // A quick refusal is not evidence of quick media delivery. Failed links
    // can recover when healthy alternatives are busy or lack this object.
    const candidates = explore ? cold : healthy.length ? healthy : measured;
    const score = (link) => {
      const value = this.summary(link);
      if (explore) return value.lastSelected;
      return (this.estimate(link, size) ?? 1000) * (1 + value.failureRate * 4);
    };
    const selected = candidates.reduce((best, link) => score(link) < score(best) ? link : best);
    const value = this.summary(selected);
    value.lastSelected = ++this.order;
    this.observations.set(selected, value);
    return selected;
  }

  record(link, elapsedMs, bytes = 0) {
    const value = this.summary(link);
    const blend = (previous, next) => previous === null ? next : previous * 0.75 + next * 0.25;
    const elapsed = Math.min(60_000, Math.max(1, elapsedMs));
    value.attempts = Math.min(32, value.attempts + 1);
    value.failureRate = value.failureRate * 0.75 + (bytes ? 0 : 0.25);
    value.consecutiveFailures = bytes ? 0 : Math.min(32, value.consecutiveFailures + 1);
    if (bytes) {
      value.latencyMs = blend(value.latencyMs, elapsed);
      value.throughputBytesPerSecond = blend(value.throughputBytesPerSecond, Math.min(1_000_000_000, bytes * 1000 / elapsed));
      this.recentCompletions.push({ bytes, rate: Math.min(1_000_000, bytes / elapsed) });
      if (this.recentCompletions.length > RECENT_COMPLETIONS) this.recentCompletions.shift();
    }
    this.observations.set(link, value);
  }
}
