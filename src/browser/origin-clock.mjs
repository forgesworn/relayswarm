// Diagnostic only, not a package export: origin clock offset from HTTP Date.
export const ORIGIN_CLOCK_SAMPLES = 16;
const ORIGIN_CLOCK_LIMIT_MS = 7 * 24 * 3600 * 1000;

/**
 * Diagnostic only (exported for tests, not part of the package API). Reads the
 * origin's HTTP Date (and Age) from hls.js networkDetails, an XMLHttpRequest or
 * a Response, and returns origin-minus-local milliseconds, or null when the
 * headers are unreadable (cross-origin without Access-Control-Expose-Headers),
 * unparsable or absurd.
 */
export function originClockOffsetMs(details, receivedMs) {
  try {
    const read = (name) => {
      if (!details) return null;
      const value = typeof details.getResponseHeader === "function" ? details.getResponseHeader(name) : details.headers?.get?.(name);
      return typeof value === "string" ? value : null;
    };
    // HTTP dates are UTC. Only zoned forms are parsed: the obsolete asctime
    // form has no zone, and Date.parse would read it as device local time.
    const header = read("Date");
    const date = typeof header === "string" && /\sGMT$/u.test(header.trim()) ? Date.parse(header) : NaN;
    if (!Number.isFinite(date)) return null;
    const age = Number(read("Age"));
    const offset = date + (Number.isFinite(age) && age > 0 ? age * 1000 : 0) - receivedMs;
    return Number.isFinite(offset) && Math.abs(offset) <= ORIGIN_CLOCK_LIMIT_MS ? offset : null;
  } catch { return null; }
}

// Date is floored to the second, and network or cache delay only make a sample
// read low, so the upper envelope of recent samples is the best estimate, like
// minimum-delay filtering in NTP. Positive: the origin is ahead of this device.
export function originClockSummary(samples) {
  return {
    samples: samples.length,
    offsetSeconds: samples.length ? Math.round(Math.max(...samples) / 1000) : null,
  };
}
