import { randomBytes, createHmac } from "node:crypto";
import { openPrivateJsonState } from "./private-json-state.mjs";
import { acquireExclusiveStateLease } from "./exclusive-state-lease.mjs";

const hex = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value);
const amount = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1e12;
const methodsValid = (value) => Array.isArray(value) && ['["nostr"]', '["website"]', '["nostr","website"]'].includes(JSON.stringify(value));
export class AccountBudgetError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }
export const accountBudgetError = (code, status = 400) => new AccountBudgetError(code, status);
const refuse = (code, status) => { throw accountBudgetError(code, status); };

/** One private, exclusively owned ledger. Charges count authorised payload, not wire delivery. */
export function createAccountUploadBudget({ statePath, defaultLimit = 100000000, grantTtlSeconds = 120, delegationTtlSeconds = 10800,
  accountCapacity = 256, identityCapacity = 512, grantCapacity = 1024, operationCapacity = 8192, mutationCapacity = 64, now = Date.now, monotonicNow = () => performance.now() } = {}) {
  if (typeof statePath !== "string" || !statePath || !amount(defaultLimit)
    || !Number.isSafeInteger(grantTtlSeconds) || grantTtlSeconds < 30 || grantTtlSeconds > 300
    || !Number.isSafeInteger(delegationTtlSeconds) || delegationTtlSeconds < grantTtlSeconds || delegationTtlSeconds > 86400
    || [accountCapacity, identityCapacity, grantCapacity, operationCapacity, mutationCapacity].some((n) => !Number.isSafeInteger(n) || n < 1)
    || accountCapacity > 4096 || identityCapacity > 8192 || grantCapacity > 8192 || operationCapacity > 32768 || mutationCapacity > 256) throw new Error("Invalid account budget options.");
  let state, store, lease, broken = false, stopping = false, pending = 0, queue = Promise.resolve(), closePromise, highestWall = 0;
  const expiries = new Map();
  function time() { const at = now(); if (!Number.isSafeInteger(at) || at < highestWall) refuse("account-clock-unavailable", 503); highestWall = at; return at; }
  const readyPromise = (async () => {
    store = await openPrivateJsonState(statePath);
    lease = await acquireExclusiveStateLease(`${statePath}.lease.sqlite`);
    state = await store.read();
    if (state === null) {
      state = { v: 1, secret: randomBytes(32).toString("hex"), lastWall: time(), accounts: [], identities: [], grants: [], operations: [] };
      await store.write(state);
    }
    highestWall = Math.max(highestWall, state.lastWall || 0); validate(state);
    const at = time(), mono = monotonicNow();
    for (const g of state.grants) expiries.set(g.token, { grant: mono + Math.min(grantTtlSeconds * 1000, Math.max(0, g.expiresAt - at)), delegation: mono + Math.min(delegationTtlSeconds * 1000, Math.max(0, g.delegationExpiresAt - at)) });
  })();
  readyPromise.catch(() => { broken = true; lease?.close(); });
  function canonical(data, id) {
    const visited = new Set();
    for (;;) {
      if (visited.has(id)) refuse("account-state-invalid", 503);
      visited.add(id);
      const value = data.accounts.find((entry) => entry.id === id);
      if (!value) refuse("account-state-invalid", 503);
      if (!value.aliasTo) return value;
      id = value.aliasTo;
    }
  }
  function validate(data) {
    if (!data || data.v !== 1 || !hex(data.secret, 64) || Object.keys(data).length !== 7 || !Number.isSafeInteger(data.lastWall) || data.lastWall < 0 || time() < data.lastWall
      || !Array.isArray(data.accounts) || data.accounts.length > accountCapacity || !Array.isArray(data.identities) || data.identities.length > identityCapacity
      || !Array.isArray(data.grants) || data.grants.length > grantCapacity || !Array.isArray(data.operations) || data.operations.length > operationCapacity) refuse("account-state-invalid", 503);
    for (const [rows, field] of [[data.accounts, "id"], [data.identities, "id"], [data.grants, "token"]]) if (new Set(rows.map((r) => r[field])).size !== rows.length) refuse("account-state-invalid", 503);
    for (const a of data.accounts) {
      if (!hex(a.id, 32) || (a.aliasTo ? !hex(a.aliasTo, 32) || Object.keys(a).length !== 2
        : !amount(a.limit) || !Number.isSafeInteger(a.spent) || a.spent < 0 || !Number.isSafeInteger(a.revision) || a.revision < 1 || !Number.isSafeInteger(a.generation) || a.generation < 1)) refuse("account-state-invalid", 503);
      canonical(data, a.id);
    }
    for (const i of data.identities) if (!hex(i.id, 64) || !["nostr", "website"].includes(i.method) || !data.accounts.some((a) => a.id === i.accountId)) refuse("account-state-invalid", 503);
    for (const g of data.grants) if (!hex(g.token, 64) || !hex(g.pagePubkey, 64) || !methodsValid(g.methods)
      || !data.accounts.some((a) => a.id === g.accountId) || !Number.isSafeInteger(g.epoch) || !Number.isSafeInteger(g.expiresAt) || !Number.isSafeInteger(g.delegationExpiresAt)
      || g.expiresAt > g.delegationExpiresAt || typeof g.revoked !== "boolean" || (g.websiteIdentity !== null && !hex(g.websiteIdentity, 64))
      || (g.renewal !== null && (!hex(g.renewal.operationId, 32) || !hex(g.renewal.token, 64)))) refuse("account-state-invalid", 503);
    const operations = new Set();
    for (const o of data.operations) {
      const id = `${o.grant}:${o.operationId}`;
      if (operations.has(id) || !data.grants.some((g) => g.token === o.grant) || !hex(o.operationId, 32) || !amount(o.bytes) || o.bytes < 1 || typeof o.accepted !== "boolean") refuse("account-state-invalid", 503);
      operations.add(id);
    }
  }
  function identityId(data, value) {
    if (!value || !["nostr", "website"].includes(value.method) || typeof value.issuer !== "string" || !value.issuer || value.issuer.length > 128
      || typeof value.subject !== "string" || !value.subject || Buffer.byteLength(value.subject) > 512) refuse("account-identity-unavailable", 403);
    return createHmac("sha256", Buffer.from(data.secret, "hex")).update(JSON.stringify([1, value.method, value.issuer, value.subject])).digest("hex");
  }
  function prune(data) {
    // Accounts, aliases and spent never expire. Only dead replay scopes are pruned.
    data.grants = data.grants.filter((g) => g.expiresAt + 30000 > time());
    const live = new Set(data.grants.map((g) => g.token));
    data.operations = data.operations.filter((o) => live.has(o.grant));
    for (const token of expiries.keys()) if (!live.has(token)) expiries.delete(token);
  }
  function snapshot(data, account) {
    return { v: 1, limit: account.limit, spent: account.spent, remaining: Math.max(0, account.limit - account.spent), revision: account.revision, generation: account.generation,
      linkedMethods: [...new Set(data.identities.filter((i) => canonical(data, i.accountId).id === account.id).map((i) => i.method))].sort() };
  }
  function grant(data, token) {
    const value = data.grants.find((g) => g.token === token);
    const expiry = expiries.get(token), mono = monotonicNow();
    if (!value || value.revoked || value.expiresAt <= time() || value.delegationExpiresAt <= time() || !expiry || mono >= expiry.grant || mono >= expiry.delegation) refuse("account-grant-unavailable", 403);
    const account = canonical(data, value.accountId);
    if (account.revision !== value.epoch) refuse("account-grant-unavailable", 403);
    return { value, account };
  }
  function grantResponse(data, value, fresh) {
    return { v: 1, grant: value.token, expiresAt: value.expiresAt, delegationExpiresAt: value.delegationExpiresAt, epoch: value.epoch,
      requiresFreshUploadConsent: fresh, snapshot: snapshot(data, canonical(data, value.accountId)) };
  }
  function issue(data, account, { pagePubkey, methods, delegationExpiresAt, websiteIdentity = null, token: priorToken }) {
    if (data.grants.length >= grantCapacity) refuse("account-grant-capacity", 429);
    const value = { token: randomBytes(32).toString("hex"), accountId: account.id, pagePubkey, methods: [...methods], websiteIdentity, epoch: account.revision,
      expiresAt: Math.min(time() + grantTtlSeconds * 1000, delegationExpiresAt), delegationExpiresAt, revoked: false, renewal: null };
    const mono = monotonicNow();
    expiries.set(value.token, { grant: mono + Math.max(0, value.expiresAt - time()), delegation: priorToken ? expiries.get(priorToken).delegation : mono + Math.max(0, delegationExpiresAt - time()) });
    data.grants.push(value); return value;
  }
  function transact(operation, { signal, write = true } = {}) {
    if (stopping || broken) return Promise.reject(accountBudgetError("account-budget-unavailable", 503));
    if (pending >= mutationCapacity) return Promise.reject(accountBudgetError("account-budget-queue-capacity", 503));
    pending++;
    const task = queue.then(async () => {
      try {
        await readyPromise;
        if (broken || signal?.aborted) refuse("account-operation-cancelled", 503);
        if (time() < state.lastWall) refuse("account-clock-unavailable", 503);
        const candidate = write ? structuredClone(state) : state;
        if (write) prune(candidate);
        const result = operation(candidate);
        if (signal?.aborted) refuse("account-operation-cancelled", 503);
        if (write) {
          candidate.lastWall = time();
          validate(candidate);
          try { await store.write(candidate); state = candidate; }
          catch { broken = true; refuse("account-persistence-unavailable", 503); }
        }
        // Once persisted, cancellation cannot refund or undo this decision.
        return result;
      } finally { pending--; }
    });
    queue = task.catch(() => {}); return task;
  }
  return {
    ready: () => readyPromise,
    parameters: { defaultLimit, grantTtlSeconds, delegationTtlSeconds },
    async identity(value) { await readyPromise; return identityId(state, value); },
    authorize(identities, { pagePubkey, methods, delegationExpiresAt, authorisationExpiresAt, settings, link = false, signal } = {}) {
      return transact((data) => {
        if (!hex(pagePubkey, 64) || !methodsValid(methods) || !Array.isArray(identities) || identities.length !== methods.length
          || identities.some((v, i) => v.method !== methods[i]) || !Number.isSafeInteger(delegationExpiresAt) || delegationExpiresAt <= time()
          || delegationExpiresAt > time() + delegationTtlSeconds * 1000 || !Number.isSafeInteger(authorisationExpiresAt) || authorisationExpiresAt <= time() || link !== (identities.length === 2)
          || (settings !== undefined && (!amount(settings.limit) || typeof settings.reset !== "boolean"))) refuse("account-authorisation-invalid", 400);
        const records = identities.map((i) => {
          const id = identityId(data, i); let record = data.identities.find((entry) => entry.id === id);
          if (!record) {
            if (data.identities.length >= identityCapacity || data.accounts.length >= accountCapacity) refuse("account-capacity", 429);
            const account = { id: randomBytes(16).toString("hex"), limit: defaultLimit, spent: 0, revision: 1, generation: 1 };
            data.accounts.push(account); record = { id, method: i.method, accountId: account.id }; data.identities.push(record);
          }
          return record;
        });
        let account = canonical(data, records[0].accountId);
        if (link) {
          const other = canonical(data, records[1].accountId);
          if (other.id !== account.id) {
            if (!Number.isSafeInteger(account.spent + other.spent)) refuse("account-spend-overflow", 409);
            account.spent += other.spent; account.limit = Math.min(account.limit, other.limit);
            account.revision = Math.max(account.revision, other.revision) + 1; account.generation = Math.max(account.generation, other.generation) + 1;
            const oldId = other.id; data.accounts[data.accounts.indexOf(other)] = { id: oldId, aliasTo: account.id };
          } else account.revision++;
        }
        if (settings !== undefined) { account.limit = settings.limit; if (settings.reset) { account.spent = 0; account.generation++; } account.revision++; }
        if (link || settings !== undefined) for (const g of data.grants) if (canonical(data, g.accountId).id === account.id) g.revoked = true;
        const website = records.find((record) => record.method === "website");
        const issued = issue(data, account, { pagePubkey, methods, delegationExpiresAt, websiteIdentity: website?.id ?? null });
        return grantResponse(data, issued, true);
      }, { signal });
    },
    inspectGrant(token, options) {
      return transact((data) => {
        const { value, account } = grant(data, token);
        return { pagePubkey: value.pagePubkey, methods: [...value.methods], websiteIdentity: value.websiteIdentity, expiresAt: value.expiresAt,
          delegationExpiresAt: value.delegationExpiresAt, epoch: value.epoch, snapshot: snapshot(data, account) };
      }, { ...options, write: false });
    },
    reserve(token, operationId, bytes, options) {
      return transact((data) => {
        const { account } = grant(data, token);
        if (!hex(operationId, 32) || !amount(bytes) || bytes < 1) refuse("account-reservation-invalid", 400);
        const previous = data.operations.find((o) => o.grant === token && o.operationId === operationId);
        if (previous && previous.bytes !== bytes) refuse("account-operation-conflict", 409);
        if (!previous && data.operations.length >= operationCapacity) refuse("account-operation-capacity", 429);
        const decision = previous || { grant: token, operationId, bytes, accepted: bytes <= Math.max(0, account.limit - account.spent) };
        if (!previous) { if (decision.accepted) account.spent += bytes; data.operations.push(decision); }
        return { v: 1, accepted: decision.accepted, duplicate: Boolean(previous), reservedBytes: decision.accepted ? bytes : 0,
          ...(!decision.accepted ? { reason: "exhausted" } : {}), snapshot: snapshot(data, account) };
      }, options);
    },
    renew(token, operationId, websiteIdentity, options) {
      return transact((data) => {
        const { value, account } = grant(data, token);
        if (!hex(operationId, 32) || value.websiteIdentity !== (websiteIdentity ?? null)) refuse("account-renewal-invalid", 403);
        if (value.renewal) {
          if (value.renewal.operationId !== operationId) refuse("account-renewal-conflict", 409);
          const next = grant(data, value.renewal.token).value; return grantResponse(data, next, false);
        }
        const next = issue(data, account, value); value.renewal = { operationId, token: next.token };
        return grantResponse(data, next, false);
      }, options);
    },
    revokeGrant(token, options) { return transact((data) => {
      const { value, account } = grant(data, token);
      // Disconnect ends this page's original delegation, including retained renewal tokens.
      for (const g of data.grants) if (canonical(data, g.accountId).id === account.id && g.pagePubkey === value.pagePubkey && g.delegationExpiresAt === value.delegationExpiresAt) g.revoked = true;
      return { v: 1, revoked: true };
    }, options); },
    close() { if (!closePromise) { stopping = true; closePromise = (async () => {
      try { await readyPromise; await queue; if (!broken && highestWall > state.lastWall) { const next = { ...state, lastWall: highestWall }; await store.write(next); state = next; } }
      finally { lease?.close(); expiries.clear(); }
    })(); } return closePromise; },
  };
}
