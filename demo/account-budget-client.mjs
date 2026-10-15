import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { boundedOperation } from "../src/browser/bounded-operation.mjs";

const paths = Object.freeze({ challengeEndpoint: "/account-budget/challenge", authorizeEndpoint: "/account-budget/authorize", reserveEndpoint: "/account-budget/reserve", statusEndpoint: "/account-budget/status", renewEndpoint: "/account-budget/renew", logoutEndpoint: "/account-budget/logout" });
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const limit = (v) => integer(v) && v <= 1e12;
const hex = (v, n) => typeof v === "string" && new RegExp(`^[a-f0-9]{${n}}$`, "u").test(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === [...keys].sort().join();
const methodsValid = (v) => same(v, ["nostr"]) || same(v, ["website"]) || same(v, ["nostr", "website"]);
const unavailable = () => new Error("Account allowance unavailable.");

/** Page-only authority. No account identity, token or signing key is persisted or returned in snapshots. */
export function createAccountBudgetClient({ secretKey, origin, fetchImpl = globalThis.fetch, signer = () => globalThis.window?.nostr,
  now = Date.now, mono = () => performance.now(), onRevoke = () => {}, random = () => crypto.getRandomValues(new Uint8Array(16)) } = {}) {
  const pagePubkey = getPublicKey(secretKey);
  if (new URL(origin).origin !== origin || !["http:", "https:"].includes(new URL(origin).protocol)) throw unavailable();
  let descriptor = null, required = false, credential = null, state = null, failed = false, busy = false;
  let generation = 0, life = new AbortController(), pending = 0, maintenance = false, lastStatus = 0, lastWall = now(), lastMono = mono();
  function revoke() { failed = true; credential = null; generation++; life.abort(); life = new AbortController(); onRevoke(); }
  function clockPoint() {
    const wall = now(), monotonic = mono(), rollback = wall < lastWall || monotonic < lastMono;
    lastWall = wall; lastMono = monotonic;
    if (!integer(wall) || !Number.isFinite(monotonic) || monotonic < 0 || rollback) throw unavailable();
    return { wall, monotonic };
  }
  function elapsed(start, end) {
    const duration = Math.max(end.wall - start.wall, end.monotonic - start.monotonic);
    if (!Number.isFinite(duration) || end.wall < start.wall || end.monotonic < start.monotonic) throw unavailable();
    return duration;
  }
  // The signed challenge identifies the issuer's clock. Count the whole request
  // round trip as elapsed: this expires authority early rather than extending it
  // when the page and server clocks differ. Renewal retains this original anchor.
  const issuerTime = (clock, at) => clock.issuedAt + elapsed(clock.started, at);
  function fresh() {
    try {
      const at = clockPoint();
      if (credential && (issuerTime(credential.clock, at) >= Math.min(credential.expiresAt, credential.delegationExpiresAt)
        || elapsed(credential.received, at) >= credential.remainingMs)) revoke();
    } catch { if (credential) revoke(); }
    return !required || Boolean(credential && !failed);
  }
  function snapshot() {
    fresh();
    return { required, connected: Boolean(credential), available: !required || Boolean(credential && !failed),
      limit: state?.limit ?? null, spent: state?.spent ?? null, remaining: required && !credential ? 0 : state?.remaining ?? null,
      revision: state?.revision ?? null, generation: state?.generation ?? null };
  }
  function configure(value) {
    if (value === undefined || value === null) {
      if (descriptor && required) revoke(); descriptor = null; return;
    }
    if (value.v !== 1 || !Array.isArray(value.methods) || value.methods.length < 1 || value.methods.length > 2 || new Set(value.methods).size !== value.methods.length || value.methods.some(v => !["nostr", "website"].includes(v)) || !limit(value.defaultLimit) || !integer(value.grantTtlSeconds) || value.grantTtlSeconds < 30 || value.grantTtlSeconds > 300 || !integer(value.delegationTtlSeconds) || value.delegationTtlSeconds < value.grantTtlSeconds || value.delegationTtlSeconds > 86400 || Object.entries(paths).some(([key, path]) => value[key] !== path)) throw unavailable();
    const next = { ...value, methods: [...value.methods] };
    if (descriptor && same(descriptor, next)) return;
    if (descriptor && !same(descriptor, next) && required) revoke();
    descriptor = next;
  }
  function validateState(value) {
    if (!exact(value, ["v", "limit", "spent", "remaining", "revision", "generation", "linkedMethods"]) || value.v !== 1 || !limit(value.limit) || !integer(value.spent) || value.remaining !== Math.max(0, value.limit - value.spent) || !integer(value.revision) || value.revision < 1 || !integer(value.generation) || value.generation < 1 || !methodsValid(value.linkedMethods)) throw unavailable();
    return { limit: value.limit, spent: value.spent, remaining: value.remaining, revision: value.revision, generation: value.generation };
  }
  function acceptState(value) {
    const next = validateState(value);
    if (state && next.generation === state.generation && next.revision === state.revision) {
      if (next.limit !== state.limit) throw unavailable();
      next.spent = Math.max(next.spent, state.spent); next.remaining = Math.max(0, next.limit - next.spent);
    }
    if (!state || next.generation > state.generation || next.generation === state.generation && next.revision >= state.revision) state = next;
  }
  async function post(endpoint, body, signal) {
    if (pending >= 8 || !Object.values(paths).includes(endpoint)) throw unavailable();
    pending++;
    try {
      return await boundedOperation(async owned => {
        const response = await fetchImpl(endpoint, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: owned });
        if (!response.ok) throw unavailable();
        const value = await response.json(); if (owned.aborted) throw unavailable(); return value;
      }, signal, 5000);
    } finally { pending--; }
  }
  function install(value, renewal, old, clock, requested) {
    const at = clockPoint(), issuerNow = issuerTime(clock, at), ttl = descriptor.grantTtlSeconds * 1000;
    if (value?.v !== 1 || !hex(value.grant, 64) || !integer(value.expiresAt) || value.expiresAt <= issuerNow || value.expiresAt > issuerNow + ttl || !integer(value.delegationExpiresAt) || value.delegationExpiresAt < value.expiresAt || !integer(value.epoch) || value.epoch < 1 || value.requiresFreshUploadConsent !== !renewal) throw unavailable();
    if (value.snapshot?.revision !== value.epoch || renewal && (value.delegationExpiresAt !== old.delegationExpiresAt || value.epoch !== old.epoch || value.snapshot?.generation !== state?.generation)) throw unavailable();
    const remainingMs = Math.min(ttl - elapsed(requested, at), value.expiresAt - issuerNow, value.delegationExpiresAt - issuerNow);
    if (!(remainingMs > 0)) throw unavailable();
    acceptState(value.snapshot);
    credential = { grant: value.grant, epoch: value.epoch, expiresAt: value.expiresAt, delegationExpiresAt: value.delegationExpiresAt,
      clock, received: at, remainingMs };
    failed = false; lastStatus = at.wall;
  }
  function requestBody(action, current, amount) {
    const operationId = Array.from(random(), b => b.toString(16).padStart(2, "0")).join("");
    if (!hex(operationId, 32)) throw unavailable();
    const content = JSON.stringify({ v: 1, purpose: "relayswarm-account-budget-request", origin, action, grant: current.grant, operationId, bytes: action === "reserve" ? amount : null });
    return { v: 1, grant: current.grant, operationId, ...(action === "reserve" ? { bytes: amount } : {}),
      proof: finalizeEvent({ kind: 27238, created_at: Math.floor(issuerTime(current.clock, clockPoint()) / 1000), tags: [], content }, secretKey) };
  }
  async function ownerAction(action, methods, settings) {
    if (busy || !descriptor || !methodsValid(methods) || methods.some(v => !descriptor.methods.includes(v)) || (action === "link") !== (methods.length === 2) || !["grant", "settings", "link"].includes(action) || action === "settings" && (!exact(settings, ["limit", "reset"]) || !limit(settings.limit) || typeof settings.reset !== "boolean")) throw unavailable();
    busy = true; required = true; revoke(); const attempt = generation, configured = descriptor;
    try {
      return await boundedOperation(async signal => {
        const started = clockPoint();
        const challenge = await post(paths.challengeEndpoint, { v: 1, action, methods, pagePubkey, ...(action === "settings" ? { settings } : {}) }, signal);
        const template = challenge?.event, at = clockPoint(); let content;
        try { content = JSON.parse(template.content); } catch { throw unavailable(); }
        const expected = { v: 1, purpose: "relayswarm-account-budget-authorize", origin, challenge: challenge.challenge, action, pagePubkey, methods, settings: action === "settings" ? settings : null, expiresAt: challenge.expiresAt, delegationExpiresAt: content.delegationExpiresAt };
        const issuedAt = challenge.expiresAt - 30000, clock = { issuedAt, started }, issuerNow = issuerTime(clock, at);
        if (challenge.v !== 1 || !hex(challenge.challenge, 48) || !integer(challenge.expiresAt) || !integer(issuedAt) || challenge.expiresAt <= issuerNow || !integer(content.delegationExpiresAt) || content.delegationExpiresAt <= issuerNow || content.delegationExpiresAt > issuedAt + configured.delegationTtlSeconds * 1000 || !exact(template, ["kind", "created_at", "tags", "content"]) || template.kind !== 27237 || !integer(template.created_at) || Math.abs(template.created_at * 1000 - at.wall) > 30000 || Math.floor(issuedAt / 1000) !== template.created_at || !same(template.tags, []) || template.content !== JSON.stringify(expected)) throw unavailable();
        let nostrProof;
        if (methods.includes("nostr")) {
          const provider = signer(); if (typeof provider?.signEvent !== "function" || typeof provider?.getPublicKey !== "function") throw unavailable();
          const expectedPubkey = await provider.getPublicKey();
          if (!hex(expectedPubkey, 64) || signal.aborted || attempt !== generation) throw unavailable();
          const signed = await provider.signEvent({ ...template, tags: [] });
          // Copy the wire fields into this realm and discard library verification
          // cache symbols supplied by an extension before checking its signature.
          nostrProof = { id: signed?.id, pubkey: signed?.pubkey, sig: signed?.sig, kind: signed?.kind,
            created_at: signed?.created_at, tags: signed?.tags, content: signed?.content };
          if (!nostrProof || nostrProof.content !== template.content || nostrProof.kind !== template.kind || nostrProof.created_at !== template.created_at || !same(nostrProof.tags, []) || nostrProof.pubkey !== expectedPubkey || !verifyEvent(nostrProof)) throw unavailable();
        }
        if (signal.aborted || attempt !== generation || descriptor !== configured || issuerTime(clock, clockPoint()) >= challenge.expiresAt) throw unavailable();
        const pageProof = finalizeEvent({ kind: template.kind, created_at: template.created_at, tags: [], content: template.content }, secretKey);
        const requested = clockPoint();
        const value = await post(paths.authorizeEndpoint, { v: 1, challenge: challenge.challenge, pageProof, ...(nostrProof ? { nostrProof } : {}) }, signal);
        if (signal.aborted || attempt !== generation || descriptor !== configured || value.delegationExpiresAt !== content.delegationExpiresAt) throw unavailable();
        // A deliberate new account action may select a different ledger.
        state = null; install(value, false, null, clock, requested); return snapshot();
      }, life.signal, 30000);
    } catch { if (attempt === generation) revoke(); throw unavailable(); }
    finally { busy = false; }
  }
  async function reserve(amount, { signal } = {}) {
    if (!limit(amount) || amount < 1 || signal?.aborted) return false;
    if (!required) return true;
    if (!fresh()) return false;
    const current = credential, attempt = generation;
    try {
      const combined = signal ? AbortSignal.any([signal, life.signal]) : life.signal;
      const value = await post(paths.reserveEndpoint, requestBody("reserve", current, amount), combined);
      if (combined.aborted || attempt !== generation || credential !== current || !fresh()) return false;
      if (value?.v !== 1 || typeof value.accepted !== "boolean" || typeof value.duplicate !== "boolean" || !integer(value.reservedBytes) || value.accepted && value.reservedBytes !== amount || !value.accepted && (value.reservedBytes !== 0 || value.reason !== "exhausted") || value.snapshot?.revision !== current.epoch || value.snapshot?.generation !== state?.generation) throw unavailable();
      acceptState(value.snapshot);
      if (!value.accepted) { revoke(); return false; }
      return true;
    } catch { if (attempt === generation) revoke(); return false; }
  }
  async function maintain() {
    if (!required || busy || maintenance || !fresh()) return false;
    const current = credential, attempt = generation;
    maintenance = true;
    try {
      const requested = clockPoint();
      const renewal = current.remainingMs - elapsed(current.received, requested) <= 20000;
      if (!renewal && requested.wall - lastStatus < 15000) return true;
      const value = await post(renewal ? paths.renewEndpoint : paths.statusEndpoint, requestBody(renewal ? "renew" : "status", current), life.signal);
      if (attempt !== generation || credential !== current || !fresh()) return false;
      if (renewal) install(value, true, current, current.clock, requested);
      else {
        if (value?.v !== 1 || value.epoch !== current.epoch || value.snapshot?.revision !== current.epoch || value.expiresAt !== current.expiresAt || value.delegationExpiresAt !== current.delegationExpiresAt || value.snapshot?.generation !== state?.generation) throw unavailable();
        acceptState(value.snapshot); lastStatus = clockPoint().wall;
      }
      if (state.remaining === 0) revoke();
      return fresh();
    } catch { if (attempt === generation) revoke(); return false; }
    finally { maintenance = false; }
  }
  async function disconnect() {
    if (busy) return false;
    const current = credential;
    required = true; revoke();
    if (!current) return false;
    busy = true;
    try {
      const value = await post(paths.logoutEndpoint, requestBody("logout", current), life.signal);
      return value?.v === 1 && value.revoked === true;
    } catch { return false; }
    finally { busy = false; }
  }
  return { configure, snapshot, ownerAction, reserve, maintain, disconnect, providers: () => [...(descriptor?.methods ?? [])],
    suspend() { if (required) revoke(); }, busy: () => busy };
}
