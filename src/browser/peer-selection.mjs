// Recent observations only: link measurements disappear with the link. These
// are completion times and payload rates, not network RTT or ABR estimates.
const RECENT_COMPLETIONS = 16;
const MIN_RATE_BYTES = 32 * 1024;
const MIN_RATE_FLOW_MS = 300;

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
const median = (values) => quantile(values, 0.5);

export class PeerSelection {
  constructor() {
    this.observations = new WeakMap();
    this.turn = 0;
    this.order = 0;
    // Sizes and payload rates of recent completed transfers on any link.
    // Links are often replaced after a timeout, so this survives turnover.
    this.recentCompletions = [];
    // Time to first byte and payload rate after it, from any attempt that
    // received data, completed or not. Most large transfers on a slow path
    // never complete, so completions alone would never inform a projection.
    this.recentFirstBytes = [];
    this.recentRates = [];
    // When the latest rate evidence arrived (Date.now()), 0 before any.
    this.lastObservedAt = 0;
  }

  /**
   * One attempt's timing: first byte (ms), then a rate as bytes over ms from
   * the latest part of its flow, and how long the whole flow ran.
   */
  observe({ firstByteMs = null, bytes = 0, flowMs = 0, totalFlowMs = flowMs } = {}) {
    if (Number.isFinite(firstByteMs) && firstByteMs >= 0) {
      this.recentFirstBytes.push(Math.min(60_000, firstByteMs));
      if (this.recentFirstBytes.length > RECENT_COMPLETIONS) this.recentFirstBytes.shift();
    }
    // A short flow mostly measures the first round trip, not the path.
    if (bytes >= MIN_RATE_BYTES && flowMs >= MIN_RATE_FLOW_MS) {
      this.recentRates.push({ rate: Math.min(1_000_000, bytes / flowMs), flowMs: Math.max(flowMs, totalFlowMs || 0) });
      if (this.recentRates.length > RECENT_COMPLETIONS) this.recentRates.shift();
      this.lastObservedAt = Date.now();
    }
  }

  /** Median recent time to first byte, or null before any data arrived. */
  firstByteMs() {
    return median(this.recentFirstBytes);
  }

  /**
   * Upper-quartile recent payload rate after first byte (bytes per ms), or
   * null. Rates come from the latest part of each flow. A short flow ends in
   * slow start and reports low, so flows of at least three first-byte times
   * decide when there are two or more of them.
   */
  rate() {
    const firstByte = this.firstByteMs();
    const long = firstByte === null ? [] : this.recentRates.filter(({ flowMs }) => flowMs >= firstByte * 3);
    return quantile((long.length >= 2 ? long : this.recentRates).map(({ rate }) => rate), 0.75);
  }

  /**
   * Projected time for a whole transfer of this size, first byte included,
   * or null without evidence: the sooner of the fastest completion at least
   * as large (its time includes its first byte) and the recent first byte
   * plus the size at the upper-quartile rate.
   */
  projectMs(size) {
    if (!size) return null;
    const firstByte = this.firstByteMs(), rate = this.rate();
    const projections = [this.minimumMs(size), firstByte !== null && rate ? firstByte + size / rate : 0].filter(Boolean);
    return projections.length ? Math.min(...projections) : null;
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
    this.markSelected(selected);
    return selected;
  }

  /** Drop a closed link's history. */
  forget(link) {
    this.observations.delete(link);
  }

  /** Record that a link was chosen for a request, as select() does for its pick. */
  markSelected(link) {
    const value = this.summary(link);
    value.lastSelected = ++this.order;
    this.observations.set(link, value);
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
      this.lastObservedAt = Date.now();
      if (this.recentCompletions.length > RECENT_COMPLETIONS) this.recentCompletions.shift();
    }
    this.observations.set(link, value);
  }
}
