import test from "node:test";
import assert from "node:assert/strict";
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { createAccountBudgetClient } from "../demo/account-budget-client.mjs";

const origin = "https://viewer.example";
const accountDescriptor = { v: 1, methods: ["nostr", "website"], defaultLimit: 100000000, grantTtlSeconds: 120, delegationTtlSeconds: 10800,
  ...Object.fromEntries(["challenge", "authorize", "reserve", "status", "renew", "logout"].map(v => [`${v}Endpoint`, `/account-budget/${v}`])) };

function fixture(descriptor = accountDescriptor, { clientOffset = 0 } = {}) {
  const secretKey = generateSecretKey(), stable = generateSecretKey(), requests = [], templates = new Map();
  let wall = Date.now(), monotonic = 0, signatures = 0, pubkeyReads = 0, revocations = 0, sequence = 0;
  let grant, delegation, expires, spent = 0, cap = descriptor.defaultLimit, revision = 1, generation = 1, linkedMethods = ["nostr"];
  const state = () => ({ v: 1, limit: cap, spent, remaining: Math.max(0, cap - spent), revision, generation, linkedMethods });
  const response = fresh => ({ v: 1, grant, expiresAt: expires, delegationExpiresAt: delegation, epoch: revision, requiresFreshUploadConsent: fresh, snapshot: state() });
  const api = { requests, transform: null, held: null, signer: null };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url, body, init });
    assert.equal(init.credentials, "same-origin"); assert.equal(init.cache, "no-store"); assert.ok(init.signal);
    let value;
    if (url.endsWith("/challenge")) {
      const challenge = (++sequence).toString(16).padStart(48, "0"); delegation = wall + descriptor.delegationTtlSeconds * 1000;
      const content = { v: 1, purpose: "relayswarm-account-budget-authorize", origin, challenge, action: body.action, pagePubkey: body.pagePubkey, methods: body.methods, settings: body.settings ?? null, expiresAt: wall + 30000, delegationExpiresAt: delegation };
      value = { v: 1, challenge, expiresAt: content.expiresAt, event: { kind: 27237, created_at: Math.floor(wall / 1000), tags: [], content: JSON.stringify(content) } };
      templates.set(challenge, value.event);
    } else if (url.endsWith("/authorize")) {
      assert.ok(verifyEvent(body.pageProof)); const template = templates.get(body.challenge);
      assert.equal(body.pageProof.content, template.content);
      const intent = JSON.parse(template.content); linkedMethods = intent.methods;
      if (intent.methods.includes("nostr")) { assert.ok(verifyEvent(body.nostrProof)); assert.equal(body.nostrProof.content, template.content); }
      else assert.equal(body.nostrProof, undefined);
      if (intent.settings) { cap = intent.settings.limit; if (intent.settings.reset) { spent = 0; generation++; } revision++; }
      grant = (++sequence).toString(16).padStart(64, "0"); expires = wall + descriptor.grantTtlSeconds * 1000; value = response(true);
    } else {
      assert.ok(verifyEvent(body.proof)); const action = url.split("/").at(-1);
      assert.equal(body.proof.content, JSON.stringify({ v: 1, purpose: "relayswarm-account-budget-request", origin, action, grant: body.grant, operationId: body.operationId, bytes: action === "reserve" ? body.bytes : null }));
      if (action === "reserve") {
        const accepted = body.bytes <= cap - spent; if (accepted) spent += body.bytes;
        value = { v: 1, accepted, duplicate: false, reservedBytes: accepted ? body.bytes : 0, ...(!accepted ? { reason: "exhausted" } : {}), snapshot: state() };
      } else if (action === "renew") { grant = (++sequence).toString(16).padStart(64, "0"); expires = Math.min(wall + descriptor.grantTtlSeconds * 1000, delegation); value = response(false); }
      else if (action === "logout") value = { v: 1, revoked: true };
      else value = { v: 1, expiresAt: expires, delegationExpiresAt: delegation, epoch: revision, snapshot: state() };
    }
    if (api.held) await api.held(url, init, value);
    return { ok: true, json: async () => api.transform ? api.transform(url, value) : value };
  };
  api.client = createAccountBudgetClient({ secretKey, origin, fetchImpl, now: () => wall + clientOffset, mono: () => monotonic,
    signer: () => ({ getPublicKey: async () => { pubkeyReads++; return getPublicKey(stable); }, signEvent: async event => { signatures++; return api.signer ? api.signer(event) : finalizeEvent(event, stable); } }), onRevoke: () => revocations++ });
  api.client.configure(descriptor);
  Object.assign(api, { advance(ms, frozenMono = false) { wall += ms; if (!frozenMono) monotonic += ms; },
    shiftMonotonic(ms) { monotonic += ms; },
    signatures: () => signatures, pubkeyReads: () => pubkeyReads, revocations: () => revocations, spent: () => spent, stable, secretKey });
  return api;
}

test("server-issued account lifetimes tolerate different device clocks without extending expiry", async () => {
  for (const clientOffset of [-15000, -16, 16, 15000]) {
    const f = fixture(accountDescriptor, { clientOffset });
    await f.client.ownerAction("grant", ["nostr"]);
    assert.equal(await f.client.reserve(19), true);
    f.advance(100001); assert.equal(await f.client.maintain(), true);
    assert.equal(f.signatures(), 1); assert.equal(f.client.snapshot().spent, 19);
    f.advance(120001); const before = f.requests.length;
    assert.equal(await f.client.reserve(1), false); assert.equal(f.requests.length, before);
    assert.equal(f.client.snapshot().available, false);
  }
});

test("challenge round trip and signing time count against the original issuer lifetime", async () => {
  for (const stage of ["challenge", "signer"]) {
    const f = fixture(accountDescriptor, { clientOffset: -16 });
    if (stage === "challenge") f.held = async url => { if (url.endsWith("/challenge")) f.advance(30001); };
    else f.signer = event => { f.advance(30001); return finalizeEvent(event, f.stable); };
    await assert.rejects(f.client.ownerAction("grant", ["nostr"]));
    assert.equal(f.requests.filter(v => v.url.endsWith("/authorize")).length, 0);
    assert.equal(f.client.snapshot().available, false);
  }
});

test("device-clock tolerance does not accept incoherent or longer signed challenge authority", async () => {
  for (const field of ["issuedAt", "delegationExpiresAt"]) {
    const f = fixture(accountDescriptor, { clientOffset: -16 });
    f.transform = (url, value) => {
      if (!url.endsWith("/challenge")) return value;
      const content = JSON.parse(value.event.content);
      if (field === "issuedAt") { value.expiresAt += 1000; content.expiresAt += 1000; }
      else content.delegationExpiresAt += 1;
      value.event.content = JSON.stringify(content); return value;
    };
    await assert.rejects(f.client.ownerAction("grant", ["nostr"]));
    assert.equal(f.signatures(), 0); assert.equal(f.requests.length, 1);
  }
});

test("grant renewal retains the original delegation deadline across device-clock differences", async () => {
  const f = fixture({ ...accountDescriptor, delegationTtlSeconds: 600 }, { clientOffset: -15000 });
  await f.client.ownerAction("grant", ["nostr"]);
  for (let i = 0; i < 5; i++) { f.advance(100001); assert.equal(await f.client.maintain(), true); }
  f.advance(100001); const before = f.requests.length;
  assert.equal(await f.client.reserve(1), false); assert.equal(f.requests.length, before);
  assert.equal(f.client.snapshot().available, false); assert.equal(f.signatures(), 1);
});

test("authority rejects clock rollback after a later observation and counts delayed grant responses", async () => {
  const f = fixture(); await f.client.ownerAction("grant", ["nostr"]);
  f.advance(10000); f.client.snapshot(); f.shiftMonotonic(-1);
  const before = f.requests.length;
  assert.equal(await f.client.reserve(1), false); assert.equal(f.requests.length, before);
  const g = fixture(accountDescriptor, { clientOffset: -15000 });
  g.held = async url => { if (url.endsWith("/authorize")) g.advance(5000); };
  await g.client.ownerAction("grant", ["nostr"]);
  g.advance(115001); assert.equal(await g.client.reserve(1), false);
  assert.equal(g.client.snapshot().available, false);
});

test("account client requires explicit owner action, signs exact intent and exposes only budget fields", async () => {
  const f = fixture(); assert.equal(await f.client.reserve(10), true); assert.equal(f.requests.length, 0); assert.equal(f.signatures(), 0);
  assert.equal(await f.client.reserve(NaN), false); assert.equal(await f.client.reserve(1, { signal: AbortSignal.abort() }), false);
  const result = await f.client.ownerAction("grant", ["nostr"]);
  assert.equal(result.required, true); assert.equal(result.connected, true); assert.equal(f.signatures(), 1); assert.equal(f.revocations(), 1);
  assert.equal(await f.client.reserve(123), true); assert.equal(f.client.snapshot().spent, 123);
  assert.deepEqual(Object.keys(f.client.snapshot()).sort(), ["required", "connected", "available", "limit", "spent", "remaining", "revision", "generation"].sort());
  const serialised = JSON.stringify(f.client.snapshot());
  for (const r of f.requests) for (const privateValue of [r.body.grant, r.body.proof?.pubkey, r.body.nostrProof?.pubkey]) if (privateValue) assert.ok(!serialised.includes(privateValue));
  f.client.suspend();
});

test("tampered origin, action or settings is rejected before a stable signer is called", async () => {
  for (const field of ["origin", "action", "settings", "pagePubkey", "methods", "delegationExpiresAt"]) {
    const f = fixture(); f.transform = (url, v) => {
      if (url.endsWith("/challenge")) { const c = JSON.parse(v.event.content); c[field] = "changed"; v.event.content = JSON.stringify(c); }
      return v;
    };
    await assert.rejects(f.client.ownerAction("grant", ["nostr"]));
    assert.equal(f.signatures(), 0); assert.equal(f.client.snapshot().available, false); assert.equal(await f.client.reserve(1), false);
    assert.equal(f.requests.length, 1);
  }
});

test("website connection never asks Nostr and settings/link always need fresh owner approval", async () => {
  const f = fixture(); await f.client.ownerAction("grant", ["website"]); assert.equal(f.signatures(), 0);
  await f.client.reserve(20); await f.client.ownerAction("settings", ["website"], { limit: 10000000, reset: false });
  assert.equal(f.client.snapshot().spent, 20); assert.equal(f.signatures(), 0);
  await f.client.ownerAction("link", ["nostr", "website"]); assert.equal(f.signatures(), 1); assert.equal(f.revocations(), 3);
  await f.client.ownerAction("settings", ["nostr"], { limit: 10000000, reset: true });
  assert.equal(f.signatures(), 2); assert.equal(f.client.snapshot().spent, 0); f.client.suspend();
});

test("signer verification cache cannot authorise a changed signature", async () => {
  const f = fixture(); f.signer = event => { const signed = finalizeEvent(event, f.stable); signed.sig = "0".repeat(128); return signed; };
  await assert.rejects(f.client.ownerAction("grant", ["nostr"]));
  assert.equal(f.requests.length, 1); assert.equal(f.client.snapshot().available, false);
});

test("ephemeral renewal preserves original delegation and never invokes stable signer or revokes consent", async () => {
  const f = fixture(); await f.client.ownerAction("grant", ["nostr"]); await f.client.reserve(111);
  f.advance(100001); assert.equal(await f.client.maintain(), true);
  assert.equal(f.signatures(), 1); assert.equal(f.revocations(), 1); assert.equal(f.client.snapshot().spent, 111);
  assert.ok(f.requests.at(-1).url.endsWith("/renew"));
  f.advance(100001); f.transform = (_url, value) => ({ ...value, delegationExpiresAt: value.delegationExpiresAt + 1000 });
  assert.equal(await f.client.maintain(), false); assert.equal(f.client.snapshot().available, false); assert.equal(f.signatures(), 1);
});

test("wall expiry, frozen monotonic clock and wall rollback revoke before reserve with no retry", async () => {
  for (const shift of [120001, -1]) {
    const f = fixture(); await f.client.ownerAction("grant", ["nostr"]); const before = f.requests.length;
    f.advance(shift, true); assert.equal(await f.client.reserve(1), false); assert.equal(f.requests.length, before);
    assert.equal(f.client.snapshot().required, true); assert.equal(f.client.snapshot().available, false);
  }
});

test("unknown or aborted reservations retain charges, clear authority and cannot fall back to anonymous", async () => {
  const f = fixture(); await f.client.ownerAction("grant", ["nostr"]);
  let entered; const ready = new Promise(r => { entered = r; });
  f.held = async (url, init) => { if (url.endsWith("/reserve")) { entered(); await new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Error("private server error")), { once: true })); } };
  const controller = new AbortController(), reservation = f.client.reserve(55, { signal: controller.signal });
  await ready; controller.abort(); assert.equal(await reservation, false); assert.equal(f.spent(), 55);
  const count = f.requests.length; assert.equal(await f.client.reserve(1), false); assert.equal(f.requests.length, count); assert.equal(f.client.snapshot().available, false);
});

test("late signing after page suspension cannot install a grant; identical descriptor polls do not cancel a live prompt", async () => {
  const f = fixture(); let release, entered; const ready = new Promise(r => { entered = r; });
  f.signer = event => new Promise(r => { release = () => r(finalizeEvent(event, f.stable)); entered(); });
  const operation = f.client.ownerAction("grant", ["nostr"]); await ready;
  f.client.configure(structuredClone(accountDescriptor)); release(); await operation;
  const second = f.client.ownerAction("grant", ["nostr"]); await new Promise(r => setTimeout(r, 0));
  f.client.suspend(); release(); await assert.rejects(second); assert.equal(f.client.snapshot().connected, false);
  assert.equal(f.requests.filter(r => r.url.endsWith("/authorize")).length, 1);
});

test("out-of-order reservation responses cannot decrease shared spend at the same policy revision", async () => {
  const f = fixture(); await f.client.ownerAction("grant", ["nostr"]); let release, entered; const ready = new Promise(r => { entered = r; });
  f.held = async url => { if (url.endsWith("/reserve") && !release) { entered(); await new Promise(r => { release = r; }); } };
  const first = f.client.reserve(40); await ready; assert.equal(await f.client.reserve(60), true);
  release(); assert.equal(await first, true); assert.equal(f.client.snapshot().spent, 100); f.client.suspend();
});

test("explicit disconnect attempts exactly one revocation, preserves spend and cannot enable anonymous upload", async () => {
  for (const confirmed of [true, false]) {
    const f = fixture(); await f.client.ownerAction("grant", ["nostr"]); await f.client.reserve(87);
    f.transform = (url, value) => url.endsWith("/logout") ? { v: 1, revoked: confirmed } : value;
    assert.equal(await f.client.disconnect(), confirmed);
    const result = f.client.snapshot(); assert.equal(result.spent, 87); assert.equal(result.required, true); assert.equal(result.connected, false);
    assert.equal(await f.client.reserve(1), false); assert.equal(f.requests.filter(v => v.url.endsWith("/logout")).length, 1);
    assert.equal(f.signatures(), 1); assert.equal(f.spent(), 87);
  }
});

test("exhausted account refuses whole payload without refunds and revoked website renewal stays unavailable", async () => {
  const f = fixture(); await f.client.ownerAction("settings", ["website"], { limit: 10, reset: false });
  assert.equal(await f.client.reserve(8), true); assert.equal(await f.client.reserve(3), false);
  assert.equal(f.spent(), 8); assert.equal(f.client.snapshot().available, false);
  const g = fixture(); await g.client.ownerAction("grant", ["website"]); g.advance(100001);
  g.transform = url => { if (url.endsWith("/renew")) throw Error("website-session-revoked"); };
  assert.equal(await g.client.maintain(), false); assert.equal(g.signatures(), 0); assert.equal(g.client.snapshot().available, false);
  assert.equal(await g.client.maintain(), false); assert.equal(g.requests.filter(v => v.url.endsWith("/renew")).length, 1);
});

test("linked spend may exceed the maximum cap while zero policy revisions remain invalid", async () => {
  const f = fixture(); f.transform = (url, value) => url.endsWith("/authorize") ? { ...value, snapshot: { ...value.snapshot, spent: 2000000000000, remaining: 0 } } : value;
  await f.client.ownerAction("link", ["nostr", "website"]);
  assert.equal(f.client.snapshot().spent, 2000000000000); assert.equal(f.client.snapshot().remaining, 0); f.client.suspend();
  for (const field of ["revision", "generation"]) {
    const g = fixture(); g.transform = (url, value) => url.endsWith("/authorize") ? { ...value, snapshot: { ...value.snapshot, [field]: 0 } } : value;
    await assert.rejects(g.client.ownerAction("grant", ["nostr"])); assert.equal(g.client.snapshot().available, false);
  }
});

test("bounded nondefault descriptors govern grant expiry without extending authority", async () => {
  for (const grantTtlSeconds of [30, 300]) {
    const f = fixture({ ...accountDescriptor, defaultLimit: 0, grantTtlSeconds, delegationTtlSeconds: 600 });
    await f.client.ownerAction("grant", ["nostr"]); assert.equal(f.client.snapshot().limit, 0);
    f.advance(grantTtlSeconds * 1000 + 1); assert.equal(await f.client.reserve(1), false); assert.equal(f.client.snapshot().available, false);
  }
  for (const fields of [{ grantTtlSeconds: 29 }, { grantTtlSeconds: 301 }, { delegationTtlSeconds: 119 }, { defaultLimit: 1e12 + 1 }]) {
    const f = fixture(); assert.throws(() => f.client.configure({ ...accountDescriptor, ...fields })); assert.equal(f.requests.length, 0);
  }
});

test("stable signer account switch between public-key approval and signing cannot authorize", async () => {
  const f = fixture(); f.signer = event => finalizeEvent(event, generateSecretKey());
  await assert.rejects(f.client.ownerAction("grant", ["nostr"]));
  assert.equal(f.pubkeyReads(), 1); assert.equal(f.signatures(), 1); assert.equal(f.requests.length, 1); assert.equal(f.client.snapshot().available, false);
});
