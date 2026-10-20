import { randomBytes } from "node:crypto";
import { verifyEvent } from "nostr-tools/pure";
import { createAccountUploadBudget, accountBudgetError, AccountBudgetError } from "../src/account-upload-budget.mjs";
import { boundedOperation } from "../src/browser/bounded-operation.mjs";

const hex = (value, n) => typeof value === "string" && new RegExp(`^[a-f0-9]{${n}}$`, "u").test(value);
const exact = (value, names) => value && !Array.isArray(value) && typeof value === "object" && Object.keys(value).sort().join() === [...names].sort().join();
const fail = (code, status = 400) => { throw accountBudgetError(code, status); };
const methodsValid = (value) => Array.isArray(value) && ['["nostr"]', '["website"]', '["nostr","website"]'].includes(JSON.stringify(value));
export function accountBudgetRequestContent({ origin, action, grant, operationId, bytes = null }) {
  return JSON.stringify({ v: 1, purpose: "relayswarm-account-budget-request", origin, action, grant, operationId, bytes });
}

/** Optional private account authority. No stable identity or account grant enters swarm wire data. */
export function createAccountBudgetControls({ resolveWebsiteAccount, now = Date.now, challengeCapacity = 512, requestCapacity = 12000,
  activeCapacity = 64, operationTimeoutMs = 3000, ...options } = {}) {
  if (resolveWebsiteAccount !== undefined && typeof resolveWebsiteAccount !== "function") throw new Error("A website account resolver must be a trusted function.");
  if (!Number.isSafeInteger(challengeCapacity) || challengeCapacity < 1 || challengeCapacity > 4096
    || !Number.isSafeInteger(requestCapacity) || requestCapacity < 1 || requestCapacity > 20000
    || !Number.isSafeInteger(activeCapacity) || activeCapacity < 1 || activeCapacity > 256
    || !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 10 || operationTimeoutMs > 3000) throw new Error("Invalid account HTTP bounds.");
  const ledger = createAccountUploadBudget({ ...options, now });
  const challenges = new Map(), active = new Set(), connections = new Map();
  let windowAt = now(), requests = 0, stopping = false, closePromise;
  const paths = { challengeEndpoint: "/account-budget/challenge", authorizeEndpoint: "/account-budget/authorize", reserveEndpoint: "/account-budget/reserve",
    statusEndpoint: "/account-budget/status", renewEndpoint: "/account-budget/renew", logoutEndpoint: "/account-budget/logout" };
  function descriptor() { return { v: 1, methods: ["nostr", ...(resolveWebsiteAccount ? ["website"] : [])], ...ledger.parameters, ...paths }; }
  function verify(proof, content, kind, pubkey) {
    if (!exact(proof, ["id", "pubkey", "sig", "kind", "created_at", "tags", "content"]) || !hex(proof.id, 64) || !hex(proof.pubkey, 64) || !hex(proof.sig, 128)
      || proof.kind !== kind || proof.content !== content || Buffer.byteLength(proof.content) > 2048 || !Array.isArray(proof.tags) || proof.tags.length !== 0
      || !Number.isSafeInteger(proof.created_at) || Math.abs(Math.floor(now() / 1000) - proof.created_at) > 30 || (pubkey && proof.pubkey !== pubkey)) fail("account-proof-invalid", 403);
    if (!verifyEvent(proof)) fail("account-proof-invalid", 403);
  }
  async function website(request, signal) {
    if (!resolveWebsiteAccount) fail("account-website-unavailable", 403);
    const value = await boundedOperation((operationSignal) => resolveWebsiteAccount(request, { signal: operationSignal }), signal, operationTimeoutMs);
    if (!value || !exact(value, ["issuer", "subject"]) || typeof value.issuer !== "string" || !value.issuer || value.issuer.length > 128
      || typeof value.subject !== "string" || !value.subject || Buffer.byteLength(value.subject) > 512 || signal.aborted) fail("account-website-unavailable", 403);
    return { method: "website", issuer: value.issuer, subject: value.subject };
  }
  async function body(request, signal) {
    if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") fail("account-json-required", 415);
    let size = 0; const chunks = [];
    for await (const chunk of request) { if (signal.aborted) fail("account-operation-cancelled", 503); size += chunk.length; if (size > 8192) fail("account-body-too-large", 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("account-json-invalid", 400); }
  }
  async function operation(request, path, origin, signal) {
    await ledger.ready();
    const input = await body(request, signal);
    for (const [id, record] of challenges) if (record.expiresAt <= now()) challenges.delete(id);
    if (path === paths.challengeEndpoint) {
      if (!exact(input, ["v", "action", "methods", "pagePubkey", ...(input?.action === "settings" ? ["settings"] : [])]) || input.v !== 1
        || !["grant", "settings", "link"].includes(input.action) || !hex(input.pagePubkey, 64) || !methodsValid(input.methods)
        || (input.action === "link" ? input.methods.join() !== "nostr,website" : input.methods.length !== 1)
        || input.methods.some((m) => !descriptor().methods.includes(m))
        || (input.action === "settings" && (!exact(input.settings, ["limit", "reset"]) || !Number.isSafeInteger(input.settings.limit) || input.settings.limit < 0 || input.settings.limit > 1e12 || typeof input.settings.reset !== "boolean"))) fail("account-challenge-invalid", 400);
      if (challenges.size >= challengeCapacity) fail("account-challenge-capacity", 429);
      const websiteIdentity = input.methods.includes("website") ? await ledger.identity(await website(request, signal)) : null;
      const challenge = randomBytes(24).toString("hex"), issuedAt = now(), expiresAt = issuedAt + 30000, delegationExpiresAt = issuedAt + ledger.parameters.delegationTtlSeconds * 1000;
      const content = JSON.stringify({ v: 1, purpose: "relayswarm-account-budget-authorize", origin, challenge, action: input.action, pagePubkey: input.pagePubkey,
        methods: input.methods, settings: input.action === "settings" ? { limit: input.settings.limit, reset: input.settings.reset } : null, expiresAt, delegationExpiresAt });
      const event = { kind: 27237, created_at: Math.floor(issuedAt / 1000), tags: [], content };
      if (signal.aborted || stopping) fail("account-operation-cancelled", 503);
      if (challenges.size >= challengeCapacity) fail("account-challenge-capacity", 429);
      challenges.set(challenge, { ...input, origin, expiresAt, delegationExpiresAt, content, websiteIdentity });
      return { v: 1, challenge, expiresAt, event };
    }
    if (path === paths.authorizeEndpoint) {
      if (!exact(input, ["v", "challenge", "pageProof", ...(input?.nostrProof ? ["nostrProof"] : [])]) || input.v !== 1 || !hex(input.challenge, 48)) fail("account-authorisation-invalid", 400);
      const c = challenges.get(input.challenge);
      if (!c || c.origin !== origin || c.expiresAt <= now() || c.methods.includes("nostr") !== Boolean(input.nostrProof)) fail("account-challenge-unavailable", 403);
      verify(input.pageProof, c.content, 27237, c.pagePubkey);
      const identities = [];
      if (c.methods.includes("nostr")) {
        verify(input.nostrProof, c.content, 27237);
        if (input.nostrProof.pubkey === c.pagePubkey) fail("account-separate-page-key-required", 403);
        identities.push({ method: "nostr", issuer: "nostr:v1", subject: input.nostrProof.pubkey });
      }
      if (c.methods.includes("website")) {
        const value = await website(request, signal);
        if (await ledger.identity(value) !== c.websiteIdentity) fail("account-website-changed", 403);
        identities.push(value);
      }
      // Recheck after host authentication yields; consume before ledger work.
      if (challenges.get(input.challenge) !== c || c.expiresAt <= now() || signal.aborted || stopping) fail("account-challenge-unavailable", 403);
      challenges.delete(input.challenge);
      return ledger.authorize(identities, { pagePubkey: c.pagePubkey, methods: c.methods, delegationExpiresAt: c.delegationExpiresAt, authorisationExpiresAt: c.expiresAt,
        ...(c.action === "settings" ? { settings: c.settings } : {}), link: c.action === "link", signal });
    }
    const action = Object.entries(paths).find(([, value]) => value === path)?.[0].replace("Endpoint", "");
    if (!exact(input, ["v", "grant", "operationId", "proof", ...(action === "reserve" ? ["bytes"] : [])]) || input.v !== 1 || !hex(input.grant, 64) || !hex(input.operationId, 32)
      || (action === "reserve" && (!Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 1e12))) fail("account-request-invalid", 400);
    const g = await ledger.inspectGrant(input.grant, { signal });
    verify(input.proof, accountBudgetRequestContent({ origin, action, grant: input.grant, operationId: input.operationId, bytes: action === "reserve" ? input.bytes : null }), 27238, g.pagePubkey);
    if (signal.aborted || stopping) fail("account-operation-cancelled", 503);
    if (action === "reserve") return ledger.reserve(input.grant, input.operationId, input.bytes, { signal });
    if (action === "status") return { v: 1, expiresAt: g.expiresAt, delegationExpiresAt: g.delegationExpiresAt, epoch: g.epoch, snapshot: g.snapshot };
    if (action === "logout") return ledger.revokeGrant(input.grant, { signal });
    if (action === "renew") {
      const identity = g.websiteIdentity === null ? null : await ledger.identity(await website(request, signal));
      return ledger.renew(input.grant, input.operationId, identity, { signal });
    }
    fail("account-route-invalid", 404);
  }
  async function handle(request, response, path, base) {
    if (!Object.values(paths).includes(path)) return false;
    let controller, timer, task;
    const disconnect = () => { if (!response.writableEnded) controller?.abort(); };
    try {
      if (stopping) fail("account-budget-unavailable", 503);
      if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return true; }
      const origin = new URL(base).origin;
      if (request.headers.origin !== origin || (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) fail("account-same-origin-required", 403);
      if (now() - windowAt >= 60000) { requests = 0; windowAt = now(); }
      if (++requests > requestCapacity || active.size >= activeCapacity) fail("account-request-capacity", 429);
      controller = new AbortController();
      connections.set(controller, request);
      request.once("aborted", disconnect); response.once("close", disconnect);
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); request.destroy(); reject(accountBudgetError("account-operation-timeout", 503)); }, operationTimeoutMs); timer.unref?.(); });
      task = operation(request, path, origin, controller.signal); active.add(task); task.finally(() => active.delete(task)).catch(() => {});
      const result = await Promise.race([task, timeout]);
      if (controller.signal.aborted || response.destroyed) return true;
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof AccountBudgetError;
      if (!response.destroyed && !response.headersSent) response.writeHead(known ? error.status : 503, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify({ error: known ? error.code : "account-budget-unavailable" }));
    } finally { clearTimeout(timer); connections.delete(controller); request.removeListener("aborted", disconnect); response.removeListener("close", disconnect); }
    return true;
  }
  return { descriptor, handle, ready: ledger.ready,
    close() { if (!closePromise) { stopping = true; challenges.clear(); for (const [controller, request] of connections) { controller.abort(); request.destroy(); } closePromise = (async () => { await Promise.allSettled([...active]); await ledger.close(); })(); } return closePromise; },
  };
}
