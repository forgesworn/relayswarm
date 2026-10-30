// Position and frontier knowledge for the optional future source election in
// hls-swarm.mjs. Nothing here touches the wire: positions are learned only from
// signed permits the manager itself resolved, and a link's frontier is derived
// from the keys its HAVE messages carry, so a peer can neither create nor move
// an object's position, only report which of our own known objects it holds.
//
// Both stores are bounded and local. `now` is passed in, so callers keep their
// own clock.

export const POSITION_LIMIT = 512;
export const POSITION_TTL_MS = 60_000;
export const FRONTIER_TTL_MS = 30_000;
export const FRONTIER_RENDITIONS = 8;

export class FutureFrontier {
  #positions = new Map();
  #frontiers = new Map();

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
   * One HAVE message from `link`. For each rendition the message maps into, the
   * largest mapped sequence number becomes that link's frontier. The latest
   * message wins outright, so a smaller number moves the frontier back. Keys
   * that do not map change nothing.
   */
  observe(link, added, now) {
    if (!Array.isArray(added) || !this.#positions.size) return;
    const best = new Map();
    for (const key of added) {
      const position = typeof key === "string" ? this.#positions.get(key) : undefined;
      if (!position || position.at < now - POSITION_TTL_MS) continue;
      if (!(best.get(position.rendition) >= position.sn)) best.set(position.rendition, position.sn);
    }
    if (!best.size) return;
    let frontiers = this.#frontiers.get(link);
    if (!frontiers) this.#frontiers.set(link, frontiers = new Map());
    for (const [rendition, sn] of best) {
      frontiers.delete(rendition);
      for (const [held, frontier] of frontiers) {
        if (frontier.at >= now - FRONTIER_TTL_MS && frontiers.size < FRONTIER_RENDITIONS) break;
        frontiers.delete(held);
      }
      frontiers.set(rendition, { sn, at: now });
    }
  }

  /** True only for a known, unexpired frontier more than one object behind `sn`. */
  behind(link, rendition, sn, now) {
    const frontier = this.#frontiers.get(link)?.get(rendition);
    return frontier !== undefined && frontier.at >= now - FRONTIER_TTL_MS && frontier.sn < sn - 1;
  }

  forget(link) { this.#frontiers.delete(link); }

  clear() { this.#positions.clear(); this.#frontiers.clear(); }

  get size() { return { positions: this.#positions.size, links: this.#frontiers.size }; }
}
