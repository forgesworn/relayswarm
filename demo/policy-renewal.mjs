/** Bounded independent checks. Authority expires from issuance, never response arrival. */
export function createPolicyRenewal({ load, commit, revoke, eligible = () => true, now = () => performance.now(), wallNow = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (![load, commit, revoke, eligible, now, wallNow, setTimer, clearTimer].every((v) => typeof v === "function")) throw new Error("Invalid policy renewal callbacks.");
  const lifetimeMs = 5000, maxPending = 3, pending = new Map(), records = [];
  let sequence = 0, accepted = 0, floor = 0, revision = -1, policyShape, authority, expiryTimer, paused = false, closed = false;
  let lastWall = wallNow();
  const remaining = (a) => Math.min(lifetimeMs - (now() - a.issued), lifetimeMs - (wallNow() - a.wallIssued));
  // Some engines pause performance.now during system sleep. Either clock can
  // expire authority; a backwards wall adjustment must never extend it.
  const expired = (a) => now() < a.issued || wallNow() < a.wallIssued || remaining(a) <= 0;
  const record = (attempt, outcome) => { records.push({ attempt: attempt.id, outcome, issuedAtMs: attempt.issued, durationMs: Math.max(0, now() - attempt.issued) }); if (records.length > 64) records.shift(); };
  function revokeAuthority(reason, policy) {
    clearTimer(expiryTimer); expiryTimer = undefined;
    const hadAuthority = Boolean(authority); authority = undefined;
    if (hadAuthority || reason !== "expired") revoke(reason, policy);
  }
  function fresh() {
    const wall = wallNow(), rollback = wall < lastWall; lastWall = wall;
    if (rollback) { floor = Math.max(floor, sequence + 1); for (const a of pending.values()) a.controller.abort(); revokeAuthority("clock-rollback"); }
    if (authority && expired(authority)) revokeAuthority("expired");
    return !closed && !paused && Boolean(authority);
  }
  function checkExpiry() { if (fresh()) expiryTimer = setTimer(checkExpiry, Math.max(1, remaining(authority))); }
  function invalidate(reason, id = sequence, policy) {
    floor = Math.max(floor, id); revokeAuthority(reason, policy);
    for (const a of pending.values()) if (a.id < floor) a.controller.abort();
  }
  function policyFor(a, value) {
    fresh();
    if (a.controller.signal.aborted || a.id < floor) return false;
    if (!value || ![null, "off", "shadow", "peer-first"].includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.telemetry !== "boolean") {
      if (a.id >= accepted) invalidate("invalid-policy", a.id); throw new Error("Invalid policy.");
    }
    if (value.revision < revision) return false;
    if (a.id < accepted && value.revision === revision) return false;
    const shape = JSON.stringify([value.mode, value.telemetry]);
    if (value.revision === revision && shape !== policyShape) { invalidate("conflicting-policy", a.id); throw new Error("Policy revision conflict."); }
    revision = value.revision; policyShape = shape; a.policy = { revision, shape, off: value.mode === "off" };
    // Stop contribution as soon as an eligible OFF is observed, before session/admission work.
    if (value.mode === "off") invalidate("operator-off", a.id, { mode: value.mode, revision: value.revision, telemetry: value.telemetry });
    return true;
  }
  async function renew() {
    fresh();
    if (closed || paused || pending.size >= maxPending) return false;
    const a = { id: ++sequence, issued: now(), wallIssued: wallNow(), controller: new AbortController() }; pending.set(a.id, a);
    let timer, abort, committing = false;
    const cancelled = new Promise((_, reject) => { abort = () => reject(new Error("Policy check cancelled.")); a.controller.signal.addEventListener("abort", abort, { once: true }); });
    timer = setTimer(() => a.controller.abort(), lifetimeMs);
    try {
      const candidate = await Promise.race([Promise.resolve().then(() => load({ signal: a.controller.signal,
        policy: (value) => policyFor(a, value),
        invalidate: (reason) => { if (a.id >= floor && a.id >= accepted && !a.controller.signal.aborted) invalidate(reason, a.id); },
      })), cancelled]);
      fresh();
      if (closed || paused || a.controller.signal.aborted || expired(a) || a.id < floor || a.id < accepted || !a.policy || a.policy.revision !== revision || a.policy.shape !== policyShape || !candidate || !eligible(candidate)) { record(a, "stale"); return false; }
      // All validation and admission preparation finished while this issuance is still fresh.
      accepted = a.id; authority = a; clearTimer(expiryTimer);
      expiryTimer = setTimer(checkExpiry, Math.max(1, remaining(a)));
      committing = true; commit(candidate); committing = false; record(a, "accepted"); return true;
    } catch {
      if (committing) invalidate("commit-failed", a.id);
      else if (!closed && !paused && a.policy?.off && a.id >= floor && a.id >= accepted && a.policy.revision === revision && a.policy.shape === policyShape) invalidate("incomplete-off-check", a.id);
      record(a, a.controller.signal.aborted ? "cancelled" : "failed"); fresh(); return false;
    } finally { clearTimer(timer); a.controller.signal.removeEventListener("abort", abort); pending.delete(a.id); }
  }
  function suspend(reason = "page-hidden") { paused = true; invalidate(reason); for (const a of pending.values()) a.controller.abort(); }
  return { renew, fresh, suspend, resume() { if (!closed) paused = false; }, close() { if (closed) return; suspend("closed"); closed = true; },
    snapshot() { const available = fresh(); return { v: 1, lifetimeMs, maxPending, pending: pending.size, fresh: available, remainingMs: available ? Math.max(0, remaining(authority)) : 0, revision, paused, closed, records: records.map((r) => ({ ...r })) }; } };
}
