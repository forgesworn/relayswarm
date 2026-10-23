// Ranged origin fetches for schema 3 multi-holder transfer: pieces of one
// segment by HTTP Range. The caller verifies every piece against the signed
// commitment, so this checks only the response's shape.
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
