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
 * ignored `Range` sends the whole segment).
 */
export function loadOriginRange(origin, context, from, to, { signal } = {}) {
  const range = originRangeFor(context, from, to);
  if (!range || typeof origin?.Loader !== "function" || typeof context?.url !== "string" || signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    let loader = null, settled = false;
    const settle = (bytes) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try { loader?.destroy?.(); } catch {}
      resolve(bytes);
    };
    const onAbort = () => { try { loader?.abort?.(); } catch {} settle(null); };
    const exact = (data) => {
      const view = data instanceof ArrayBuffer ? new Uint8Array(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      return view && view.byteLength === to - from ? view.slice() : null;
    };
    try {
      loader = new origin.Loader(origin.config);
      signal?.addEventListener("abort", onAbort, { once: true });
      loader.load({ ...context, responseType: "arraybuffer", rangeStart: range.first, rangeEnd: range.last + 1 }, origin.loaderConfig ?? {}, {
        onSuccess: (response) => settle(exact(response?.data)),
        onError: () => settle(null), onTimeout: () => settle(null), onAbort: () => settle(null),
      });
    } catch { settle(null); }
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
 */
export async function fetchOriginRange(context, from, to, { signal, fetchImpl = globalThis.fetch } = {}) {
  const range = originRangeFor(context, from, to);
  if (!range || typeof context?.url !== "string" || typeof fetchImpl !== "function") return null;
  let response;
  try {
    response = await fetchImpl(context.url, { headers: { Range: `bytes=${range.first}-${range.last}` }, signal, credentials: "same-origin" });
  } catch { return null; }
  try {
    if (response.status !== 206 || !matchingContentRange(response.headers.get("content-range"), range)) {
      try { await response.body?.cancel(); } catch {}
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength === to - from ? bytes : null;
  } catch { return null; }
}
