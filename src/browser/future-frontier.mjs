// Position knowledge for the optional future source election in hls-swarm.mjs.
// Nothing here touches the wire. Positions are learned only from signed permits
// the manager itself resolved, so a peer can neither create nor move an
// object's position; it can only advertise which of our known objects it holds.
//
// A peer's frontier is derived when an election runs, from the keys it currently
// advertises, so a HAVE that arrived before the local side authorised an object
// counts as soon as the authorisation lands. Nothing is stored per link.
//
// The map is bounded and local. `now` is passed in, so callers keep their clock.

export const POSITION_LIMIT = 512;
export const POSITION_TTL_MS = 60_000;

export class FutureFrontier {
  #positions = new Map();

  /** Record that `key` is sequence number `sn` of `rendition`. First in, first out. */
  note(key, rendition, sn, now) {
    if (typeof key !== "string" || typeof rendition !== "string" || !Number.isSafeInteger(sn)) return;
    this.#positions.delete(key);
    for (const [held, position] of this.#positions) {
      if (position.at >= now - POSITION_TTL_MS && this.#positions.size < POSITION_LIMIT) break;
      this.#positions.delete(held);
    }
    this.#positions.set(key, { rendition, sn, at: now });
  }

  /**
   * The largest sequence number of `rendition` among the advertised keys that
   * map to a live position, or null when none does. Unmapped and malformed keys
   * are ignored. A link holds at most 256 keys, so this is at most 256 lookups.
   */
  frontier(advertised, rendition, now) {
    if (!this.#positions.size || typeof advertised?.[Symbol.iterator] !== "function") return null;
    let best = null;
    for (const key of advertised) {
      const position = typeof key === "string" ? this.#positions.get(key) : undefined;
      if (!position || position.rendition !== rendition || position.at < now - POSITION_TTL_MS) continue;
      if (best === null || position.sn > best) best = position.sn;
    }
    return best;
  }

  /** True only for a known frontier more than one object behind `sn`. */
  behind(advertised, rendition, sn, now) {
    const frontier = this.frontier(advertised, rendition, now);
    return frontier !== null && frontier < sn - 1;
  }

  clear() { this.#positions.clear(); }

  get size() { return this.#positions.size; }
}
