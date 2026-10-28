// Internal scalar batch for one transfer/connection. These are the existing
// selection observation floors; no sub-floor rate or payload is retained.
const MIN_BYTES = 32 * 1024, MIN_MS = 300;
export class VerifiedPieceFlow {
  #bytes = 0;
  #startAt = null;
  #afterAt = -Infinity;
  discard(at) {
    this.#bytes = 0; this.#startAt = null;
    if (Number.isFinite(at)) this.#afterAt = Math.max(this.#afterAt, at);
  }
  record({ freshBytes, startAt, endAt }) {
    if (freshBytes === 0) return null;
    if (!Number.isSafeInteger(freshBytes) || freshBytes < 0 || !Number.isSafeInteger(this.#bytes + freshBytes) ||
        !Number.isFinite(startAt) || startAt < 0 || !Number.isFinite(endAt) || endAt < startAt || startAt < this.#afterAt) {
      this.discard(endAt); return null;
    }
    // A later credited range can have an earlier payload start. Keep the
    // whole wall interval, including all gaps and verification latency.
    this.#startAt = this.#startAt === null ? startAt : Math.min(this.#startAt, startAt);
    this.#bytes += freshBytes;
    const flowMs = endAt - this.#startAt;
    if (flowMs < MIN_MS || this.#bytes < MIN_BYTES) return null;
    const sample = { bytes: this.#bytes, flowMs };
    this.discard(endAt);
    return sample;
  }
}
