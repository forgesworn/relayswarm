import { randomBytes, createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const key = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const sameOrigin = (request, base) => {
  if (request.headers.origin !== base || request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin") throw fail("Same-origin admission required.", 403);
};
async function json(request) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw fail("Use application/json.", 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 4096) throw fail("Admission body too large.", 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("Invalid admission JSON."); }
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  response.writeHead(status, { "content-type": "application/json", "content-length": body.length }).end(body);
}

/** Tickets authorise bounded keys, not unique people. Forwarded IP headers are never trusted. */
export function createAdmissionControls({ secretKey = generateSecretKey(), swarmId, now = Date.now, ticketTtlSeconds = 120, capacity = 512,
  perAddressTickets = 12, globalTickets = 120, requestCapacity = 2048, perAddressRequests = 600 } = {}) {
  if (typeof swarmId !== "string" || !swarmId || swarmId.length > 256 || !Number.isSafeInteger(ticketTtlSeconds) || ticketTtlSeconds < 30 || ticketTtlSeconds > 300
      || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096 || !Number.isSafeInteger(perAddressTickets) || perAddressTickets < 1 || perAddressTickets > 120
      || !Number.isSafeInteger(globalTickets) || globalTickets < 1 || globalTickets > 1000 || !Number.isSafeInteger(requestCapacity) || requestCapacity < 1 || requestCapacity > 10000 || !Number.isSafeInteger(perAddressRequests) || perAddressRequests < 1 || perAddressRequests > 10000) throw new Error("Invalid admission limits.");
  const issuer = getPublicKey(secretKey), challenges = new Map(), tickets = new Map(), addresses = new Map(), revoked = new Map();
  let epoch = randomBytes(16).toString("hex"), windowAt = now(), requests = 0, issued = 0;
  function prune() {
    const at = now();
    for (const [id, value] of challenges) if (value.expiresAt <= at) challenges.delete(id);
    for (const [id, value] of tickets) if (value.expiresAt <= at) tickets.delete(id);
    for (const [id, value] of revoked) if (value <= at) revoked.delete(id);
    if (at - windowAt >= 60000) { windowAt = at; requests = 0; issued = 0; addresses.clear(); }
  }
  function address(request) { return createHash("sha256").update(request.socket?.remoteAddress || "unknown").digest("hex"); }
  function budget(request) {
    prune(); if (++requests > requestCapacity) throw fail("Admission request budget exceeded.", 429);
    const id = address(request);
    if (!addresses.has(id) && addresses.size >= capacity) throw fail("Admission address capacity reached.", 429);
    const entry = addresses.get(id) || { requests: 0, issued: 0 };
    addresses.set(id, entry);
    if (++entry.requests > perAddressRequests) throw fail("Admission address request budget exceeded.", 429);
    return { id, entry };
  }
  function descriptor() { return { v: 1, issuer, epoch, swarmId, ticketTtlSeconds, challengeEndpoint: "/admission/challenge", ticketEndpoint: "/admission/ticket", verifyEndpoint: "/admission/verify" }; }
  function verify(pubkey, ticket) {
    prune(); if (!key(pubkey) || typeof ticket !== "string" || Buffer.byteLength(ticket) > 2048 || revoked.has(pubkey)) return false;
    const record = tickets.get(ticket);
    return Boolean(record && record.pubkey === pubkey && record.expiresAt > now());
  }
  function revoke(pubkey) {
    if (!key(pubkey)) throw fail("Supply a hexadecimal pubkey.");
    prune(); if (!revoked.has(pubkey) && revoked.size >= capacity) throw fail("Revocation capacity reached; rotate admission epoch.", 429);
    revoked.set(pubkey, now() + ticketTtlSeconds * 1000);
    for (const [ticket, record] of tickets) if (record.pubkey === pubkey) tickets.delete(ticket);
    return { revoked: true, pubkey, until: Math.ceil(revoked.get(pubkey) / 1000) };
  }
  function rotate() { tickets.clear(); challenges.clear(); revoked.clear(); epoch = randomBytes(16).toString("hex"); return descriptor(); }
  async function handle(request, response, path, base) {
    if (!["/admission/challenge", "/admission/ticket", "/admission/verify"].includes(path)) return false;
    try {
      if (request.method !== "POST") { response.writeHead(405, { allow: "POST" }).end(); return true; }
      sameOrigin(request, base); const { id, entry } = budget(request); const input = await json(request);
      let result;
      if (path === "/admission/challenge") {
        if (!input || Object.keys(input).length !== 1 || !key(input.pubkey)) throw fail("Supply only pubkey.");
        if (revoked.has(input.pubkey)) throw fail("Key temporarily revoked.", 403);
        if (challenges.size >= capacity || [...challenges.values()].filter((value) => value.address === id).length >= Math.min(32, capacity)) throw fail("Challenge capacity reached.", 429);
        const challenge = randomBytes(24).toString("hex"), expiresAt = now() + 30000;
        challenges.set(challenge, { pubkey: input.pubkey, address: id, expiresAt });
        result = { challenge, expiresAt, ...descriptor() };
      } else if (path === "/admission/ticket") {
        if (issued >= globalTickets || entry.issued >= perAddressTickets || tickets.size >= capacity) throw fail("Ticket issuance budget exceeded.", 429);
        const proof = input?.proof;
        if (!proof || Object.keys(input).length !== 1 || !key(proof.pubkey) || proof.kind !== 27235 || typeof proof.content !== "string" || Buffer.byteLength(proof.content) > 512
            || !Array.isArray(proof.tags) || proof.tags.length !== 0 || !Number.isSafeInteger(proof.created_at) || Math.abs(Math.floor(now() / 1000) - proof.created_at) > 30) throw fail("Invalid key possession proof.");
        let claim; try { claim = JSON.parse(proof.content); } catch { throw fail("Invalid key possession proof."); }
        const challenge = challenges.get(claim.challenge);
        if (!challenge || challenge.address !== id || challenge.pubkey !== proof.pubkey || challenge.expiresAt <= now() || claim.swarmId !== swarmId || claim.epoch !== epoch || revoked.has(proof.pubkey)) throw fail("Admission challenge unavailable.", 403);
        // Cheap limits and exact challenge binding precede signature work.
        if (!verifyEvent(proof)) throw fail("Invalid key possession signature.", 403);
        challenges.delete(claim.challenge); issued++; entry.issued++;
        const expiresAt = Math.floor(now() / 1000) + ticketTtlSeconds;
        const event = finalizeEvent({ kind: 27236, created_at: Math.floor(now() / 1000), tags: [["p", proof.pubkey], ["x", swarmId], ["expiration", String(expiresAt)]], content: JSON.stringify({ v: 1, epoch }) }, secretKey);
        const ticket = JSON.stringify(event);
        tickets.set(ticket, { pubkey: proof.pubkey, expiresAt: expiresAt * 1000 });
        result = { ticket, expiresAt, ...descriptor() };
      } else {
        if (!input || Object.keys(input).length !== 2 || !key(input.pubkey) || typeof input.ticket !== "string" || Buffer.byteLength(input.ticket) > 2048) throw fail("Supply pubkey and bounded ticket.");
        result = { admitted: verify(input.pubkey, input.ticket), epoch };
      }
      sendJson(response, 200, result);
    } catch (error) { sendJson(response, error.status || 500, { error: error.status ? error.message : "Admission unavailable." }); }
    return true;
  }
  return { descriptor, handle, verify, revoke, rotate, metrics: () => { prune(); return { tickets: tickets.size, challenges: challenges.size, revoked: revoked.size, capacity, ticketTtlSeconds, perAddressTickets, globalTickets, perAddressRequests, requestCapacity }; } };
}
