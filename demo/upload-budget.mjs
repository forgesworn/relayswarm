const STORAGE_KEY = "relayswarm-upload-budget-v1", LOCK = "relayswarm-upload-budget-v1";
const validLimit = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;

/** Origin-wide media reservations. Consent and signing keys are never stored. */
export function createPersistentUploadBudget({ storage, locks, defaultLimit = 100000000 } = {}) {
  let failed = false, state = { v: 1, spent: 0, limit: defaultLimit, revision: 0 };
  if (!validLimit(defaultLimit)) throw new Error("Invalid default upload allowance.");
  const valid = (value) => value && Object.keys(value).length === 4 && value.v === 1 && validLimit(value.limit) && validLimit(value.spent) && Number.isSafeInteger(value.revision) && value.revision >= 0;
  function read() {
    const text = storage.getItem(STORAGE_KEY);
    const value = text === null ? { v: 1, spent: 0, limit: defaultLimit, revision: 0 } : JSON.parse(text);
    if (!valid(value)) throw new Error("Invalid persistent upload allowance.");
    state = value; return value;
  }
  function snapshot() {
    try { if (!storage || typeof locks?.request !== "function") throw new Error("Persistent upload allowance is unavailable."); read(); }
    catch { failed = true; }
    return { ...state, available: !failed, remaining: failed ? 0 : Math.max(0, state.limit - state.spent) };
  }
  async function transaction(update, { signal } = {}) {
    if (failed || !storage || typeof locks?.request !== "function") { failed = true; return false; }
    try {
      return await locks.request(LOCK, { mode: "exclusive", ...(signal ? { signal } : {}) }, () => {
        if (signal?.aborted || failed) return false;
        const current = read(), next = update(current);
        if (!next) return false;
        next.revision = current.revision + 1;
        if (!valid(next)) throw new Error("Invalid upload reservation.");
        const text = JSON.stringify(next); storage.setItem(STORAGE_KEY, text);
        if (storage.getItem(STORAGE_KEY) !== text) throw new Error("Upload reservation was not persisted.");
        state = next; return true;
      });
    } catch (error) { if (!signal?.aborted) failed = true; return false; }
  }
  snapshot();
  return {
    snapshot,
    // Only an explicit viewer settings submission may change the limit.
    setLimit(limit) { if (!validLimit(limit)) return Promise.resolve(false); return transaction((current) => ({ ...current, limit })); },
    async reset(limit = state.limit) {
      if (!validLimit(limit) || !storage || typeof locks?.request !== "function") return false;
      try {
        return await locks.request(LOCK, { mode: "exclusive" }, () => {
          let revision = 0; try { const previous = JSON.parse(storage.getItem(STORAGE_KEY)); if (valid(previous)) revision = previous.revision; } catch { /* Explicit reset may replace a corrupt record. */ }
          const next = { v: 1, spent: 0, limit, revision: revision + 1 }, text = JSON.stringify(next);
          if (!valid(next)) return false;
          storage.setItem(STORAGE_KEY, text); if (storage.getItem(STORAGE_KEY) !== text) throw new Error("Upload reset was not persisted.");
          state = next; failed = false; return true;
        });
      } catch { failed = true; return false; }
    },
    reserve(amount, options) {
      if (!Number.isSafeInteger(amount) || amount < 1) return Promise.resolve(false);
      return transaction((current) => amount <= Math.max(0, current.limit - current.spent) ? { ...current, spent: current.spent + amount } : null, options);
    },
  };
}
