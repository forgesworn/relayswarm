// Inert test-bundle module. No installation, requests, timers or native hooks.
const HEX = /^[0-9a-f]{64}$/u;
const finite = v => typeof v === "number" && Number.isFinite(v) ? v : null;
const own = (o, k) => o && Object.getOwnPropertyDescriptor(o, k)?.value;
export function createObservation(clock = () => performance.now(), timeOrigin = performance.timeOrigin) {
  const rows = [], keys = [], keyIds = new Map(), fragments = new WeakMap(), links = new WeakMap(), fragmentKeys = new Map();
  let fragmentCount = 0, linkCount = 0, dropped = 0, unknown = 0, closed = false;
  const safe = fn => (...args) => { if (closed) return; try { fn(...args); } catch { unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1); } };
  function id(map, object, kind) {
    if (!object || typeof object !== "object") return null;
    if (map.has(object)) return map.get(object);
    const count = kind === "fragment" ? fragmentCount : linkCount, cap = kind === "fragment" ? 512 : 16;
    if (count === cap) { unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1); return null; }
    const n = count + 1; map.set(object, n);
    if (kind === "fragment") fragmentCount = n; else linkCount = n;
    return n;
  }
  function keyId(key) {
    if (typeof key !== "string" || !HEX.test(key)) { unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1); return null; }
    if (keyIds.has(key)) return keyIds.get(key);
    if (keys.length === 512) { unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1); return null; }
    const n = keys.length + 1; keys.push(key); keyIds.set(key, n); return n;
  }
  function record(phase, values = {}) {
    if (rows.length === 512) { rows.shift(); dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); }
    rows.push({ phase, atMs: finite(clock()), ...values });
  }
  const key = safe((context, value, deadline = null, budgetMs = null) => {
    const fragment = id(fragments, own(context, "frag"), "fragment"), object = keyId(value);
    if (fragment !== null && object !== null) {
      if (fragmentKeys.has(fragment) && fragmentKeys.get(fragment) !== object) { fragmentKeys.set(fragment, null); unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1); }
      else fragmentKeys.set(fragment, object);
    }
    record(deadline === null ? "origin-key-ready" : "peer-deadline", { fragment, object, deadlineMs: finite(deadline), budgetMs: finite(budgetMs) });
  });
  const hls = safe((phase, data) => {
    const frag = own(data, "frag");
    record(phase, { fragment: id(fragments, frag, "fragment"), level: finite(own(frag, "level")), cc: finite(own(frag, "cc")), sequence: finite(own(frag, "sn")) });
  });
  const queued = safe((link, message) => {
    if (own(message, "t") !== "have") return;
    const channel = id(links, link, "link");
    record("have-frame-queued", { channel });
    for (const [field, phase] of [["keys", "have-full-queued"], ["add", "have-add-queued"], ["del", "have-delete-queued"]]) {
      const list = own(message, field); if (!Array.isArray(list)) continue;
      if (list.length > 256) unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1);
      for (const value of list.slice(0, 256)) record(phase, { channel, object: keyId(value) });
    }
  });
  const accepted = safe((link, added) => {
    const channel = id(links, link, "link");
    if (!Array.isArray(added)) { unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1); return; }
    if (added.length > 512) unknown = Math.min(Number.MAX_SAFE_INTEGER, unknown + 1);
    record("have-frame-accepted", { channel, count: Math.min(added.length, 512) });
    for (const value of added.slice(0, 512)) record("have-key-accepted", { channel, object: keyId(value) });
  });
  return { key, queued, accepted,
    attach(h, events) { h.on(events.FRAG_LOADING, (_event, data) => hls("hls-loading", data)); h.on(events.FRAG_LOADED, (_event, data) => hls("hls-loaded", data)); },
    // PRIVATE TRANSIENT: caller must relabel all pages before any serialisation.
    takePrivate() { closed = true; const result = { timeOriginMs: finite(timeOrigin), rows: structuredClone(rows), keys: keys.slice(), fragmentKeys: [...fragmentKeys], dropped, unknown }; rows.length = 0; keys.length = 0; keyIds.clear(); fragmentKeys.clear(); return result; },
  };
}
export const availabilityObservation = createObservation();

const PHASES = new Set(["origin-key-ready", "peer-deadline", "hls-loading", "hls-loaded", "have-frame-queued", "have-full-queued", "have-add-queued", "have-delete-queued", "have-frame-accepted", "have-key-accepted"]);
// All raw keys stay in this synchronous controller-memory join and are discarded.
export function publicTimeline(pages) {
  if (!Array.isArray(pages) || pages.length > 4) throw Error("Invalid page bound");
  const objects = new Map(), roles = new Set(); let unlabelled = 0;
  const output = pages.map(({ role, value }) => {
    if (!["contributor-low", "contributor-high", "baseline", "consumer"].includes(role) || !value || value.keys.length > 512 || value.rows.length > 512 || value.fragmentKeys.length > 512) throw Error("Invalid observation");
    if (roles.has(role)) throw Error("Duplicate role"); roles.add(role);
    const labels = value.keys.map(key => {
      if (typeof key !== "string" || !HEX.test(key)) throw Error("Invalid key");
      if (!objects.has(key)) { if (objects.size === 512) { unlabelled++; return null; } objects.set(key, objects.size + 1); }
      return objects.get(key);
    });
    const byFragment = new Map(value.fragmentKeys);
    const rows = value.rows.map(row => {
      if (!PHASES.has(row.phase)) throw Error("Invalid phase");
      const local = row.object ?? byFragment.get(row.fragment);
      const result = { phase: row.phase, object: Number.isInteger(local) ? labels[local - 1] ?? null : null };
      for (const name of ["atMs", "deadlineMs", "budgetMs", "fragment", "channel", "level", "cc", "sequence", "count"]) if (name in row) result[name] = finite(row[name]);
      return result;
    });
    return { role, timeOriginMs: finite(value.timeOriginMs), dropped: finite(value.dropped), unknown: finite(value.unknown), rows };
  });
  objects.clear();
  return { v: 1, diagnosticOnly: true, ordinaryQualificationEvidence: false, injectedTestBundle: true, limits: { pages: 4, rowsPerPage: 512, keysPerPage: 512, sharedObjects: 512 }, unlabelled, pages: output };
}
