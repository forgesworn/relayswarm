// Ranged origin fetches for schema 3 multi-holder transfer: pieces of one
// segment by HTTP Range. The caller verifies every piece against the signed
// commitment, so this checks only the response's shape.
//
// `loadOriginRange` goes through the player's own fragment loader, which
// sends `Range` from `rangeStart`/`rangeEnd` as for an EXT-X-BYTERANGE
// segment, so headers and credentials set through hls.js `xhrSetup`,
// `fetchSetup` or a custom loader apply. `fetchOriginRange` is plain `fetch`,
// for when no loader is known.
//
// Offsets are within the segment. A segment that is itself a byte range of a
// larger file (EXT-X-BYTERANGE) adds its own start, as hls.js's loader
// context gives it (`rangeStart`, with `rangeEnd` exclusive).

/** Byte offsets of the file to request: `{ first, last }` inclusive. */
export function originRangeFor(context, from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from) return null;
  const ranged = Number.isSafeInteger(context?.rangeEnd) && context.rangeEnd > 0;
  const base = ranged && Number.isSafeInteger(context.rangeStart) ? context.rangeStart : 0;
  if (ranged && base + to > context.rangeEnd) return null;
  return { first: base + from, last: base + to - 1 };
}

/**
 * Load bytes `from..to` (end exclusive) of the segment through a new
 * instance of the player's loader: `origin` is `{ Loader, config,
 * loaderConfig }` as hls.js gave them. Resolves to the bytes, or null on any
 * error, abort or a body that is not exactly the range (a server that
 * ignored `Range` sends the whole segment). A successful load of any other
 * length also calls `onIgnored`: the loader has already downloaded it, so
 * the caller should stop asking that origin for ranges.
 * `onResult` observes one fixed-enum outcome with expected/received byte counts
 * and a numeric HTTP status when available; no URL or error text is supplied.
 */
function reportRange(onResult, outcome, from, to, receivedBytes = null, httpStatus = null) {
  if (typeof onResult !== "function") return;
  try {
    const result = onResult({ outcome, expectedBytes: Number.isSafeInteger(to - from) && to > from ? to - from : null,
      receivedBytes: Number.isSafeInteger(receivedBytes) && receivedBytes >= 0 ? receivedBytes : null,
      httpStatus: Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null });
    if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {});
  } catch {}
}

export function loadOriginRange(origin, context, from, to, { signal, onIgnored, onResult, beforeLoad } = {}) {
  const range = originRangeFor(context, from, to);
  if (!range || typeof origin?.Loader !== "function" || typeof context?.url !== "string" || signal?.aborted) {
    reportRange(onResult, signal?.aborted ? "abort" : "invalid-request", from, to);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let loader = null, settled = false;
    const settle = (bytes, outcome, receivedBytes = bytes?.byteLength ?? null, httpStatus = null) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try { loader?.destroy?.(); } catch {}
      reportRange(onResult, outcome, from, to, receivedBytes, httpStatus);
      resolve(bytes);
    };
    const onAbort = () => { try { loader?.abort?.(); } catch {} settle(null, "abort"); };
    const exact = (data) => {
      const view = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      return view && view.byteLength === to - from ? view.slice() : null;
    };
    try {
      loader = new origin.Loader(origin.config);
      signal?.addEventListener("abort", onAbort, { once: true });
      const load = loader.load, loadContext = { ...context, responseType: "arraybuffer", rangeStart: range.first, rangeEnd: range.last + 1 };
      const loadConfig = origin.loaderConfig ?? {};
      const callbacks = {
        onSuccess: (response) => {
          if (signal?.aborted) return settle(null, "abort");
          const bytes = exact(response?.data);
          if (!bytes && !settled) { try { onIgnored?.(); } catch {} }
          settle(bytes, bytes ? "payload" : "wrong-size", response?.data?.byteLength ?? null, response?.code);
        },
        onError: error => settle(null, signal?.aborted ? "abort" : "error", null, error?.code),
        onTimeout: () => settle(null, signal?.aborted ? "abort" : "timeout"), onAbort: () => settle(null, "abort"),
      };
      if (beforeLoad && beforeLoad() !== true || signal?.aborted) return settle(null, "abort");
      load.call(loader, loadContext, loadConfig, callbacks);
    } catch { settle(null, "exception"); }
  });
}

/** `bytes first-last/total` with the requested first and last, or false. */
function matchingContentRange(header, { first, last }) {
  if (header === null) return true; // not exposed to this origin: the hashes decide
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(header.trim());
  return !!match && Number(match[1]) === first && Number(match[2]) === last;
}

/**
 * Fetch bytes `from..to` (end exclusive) of the segment at `context.url`.
 * Resolves to the bytes, or null when the origin ignored or misanswered the
 * range: a 200 is never sliced, since the server did not honour `Range`.
 * A 200, or a 206 that is not the range asked for, also calls `onIgnored`.
 */
export async function fetchOriginRange(context, from, to, { signal, onIgnored, onResult, fetchImpl = globalThis.fetch } = {}) {
  const range = originRangeFor(context, from, to);
  if (!range || typeof context?.url !== "string" || typeof fetchImpl !== "function" || signal?.aborted) {
    reportRange(onResult, signal?.aborted ? "abort" : "invalid-request", from, to); return null;
  }
  let response;
  try {
    response = await fetchImpl(context.url, { headers: { Range: `bytes=${range.first}-${range.last}` }, signal, credentials: "same-origin" });
  } catch { reportRange(onResult, signal?.aborted ? "abort" : "error", from, to); return null; }
  const ignored = (receivedBytes = null) => { try { onIgnored?.(); } catch {} reportRange(onResult, "wrong-size", from, to, receivedBytes, response.status); return null; };
  try {
    if (response.status !== 206 || !matchingContentRange(response.headers.get("content-range"), range)) {
      try { await response.body?.cancel(); } catch {}
      if (response.status === 200 || response.status === 206) return ignored();
      reportRange(onResult, "error", from, to, null, response.status); return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== to - from) return ignored(bytes.byteLength);
    reportRange(onResult, "payload", from, to, bytes.byteLength, response.status); return bytes;
  } catch { reportRange(onResult, signal?.aborted ? "abort" : "error", from, to, null, response?.status); return null; }
}
