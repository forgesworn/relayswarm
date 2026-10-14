import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, realpath, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { createAccountBudgetControls, accountBudgetRequestContent } from "../demo/account-budget.mjs";
import { startDemoServer } from "../demo/server.mjs";

const op = (n) => n.toString(16).padStart(32, "0");
const posixState = { skip: !["darwin", "linux"].includes(process.platform) ? "Durable account state requires a supported local POSIX filesystem; Windows ACL support is not implemented." : false };

test("invalid account HTTP configuration refuses before allocating private state on every platform", () => {
  assert.throws(() => createAccountBudgetControls({ resolveWebsiteAccount: "not a trusted callback" }), /trusted function/u);
  assert.throws(() => createAccountBudgetControls({ activeCapacity: 257 }), /Invalid account HTTP bounds/u);
});
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "relayswarm-account-http-")), statePath = join(dir, "account.json");
  const controls = createAccountBudgetControls({ statePath, ...options });
  let base;
  const server = createServer((request, response) => { controls.handle(request, response, new URL(request.url, base).pathname, base).then((handled) => { if (!handled) response.writeHead(404).end(); }).catch(() => response.destroy()); });
  t.after(async () => { await controls.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); await rm(dir, { recursive: true, force: true }); });
  await controls.ready(); await new Promise((done) => server.listen(0, "127.0.0.1", done)); base = `http://127.0.0.1:${server.address().port}`;
  async function post(path, body, extra = {}) {
    const response = await fetch(base + path, { method: "POST", headers: { origin: base, "content-type": "application/json", ...extra.headers }, body: JSON.stringify(body), signal: extra.signal || AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() };
  }
  async function authorize({ action = "grant", methods = ["nostr"], pageKey = generateSecretKey(), accountKey = generateSecretKey(), settings, headers } = {}) {
    const challenge = await post("/account-budget/challenge", { v: 1, action, methods, pagePubkey: getPublicKey(pageKey), ...(settings ? { settings } : {}) }, { headers });
    assert.equal(challenge.status, 200);
    const input = { v: 1, challenge: challenge.body.challenge, pageProof: finalizeEvent(structuredClone(challenge.body.event), pageKey), ...(methods.includes("nostr") ? { nostrProof: finalizeEvent(structuredClone(challenge.body.event), accountKey) } : {}) };
    const result = await post("/account-budget/authorize", input, { headers });
    return { ...result, pageKey, accountKey, challenge: challenge.body, input };
  }
  function request(grant, key, action, operationId, bytes) {
    return { v: 1, grant, operationId, ...(action === "reserve" ? { bytes } : {}), proof: finalizeEvent({ kind: 27238, created_at: Math.floor(Date.now() / 1000), tags: [],
      content: accountBudgetRequestContent({ origin: base, action, grant, operationId, bytes: action === "reserve" ? bytes : null }) }, key) };
  }
  return { controls, post, authorize, request, statePath, get base() { return base; } };
}

test("real HTTP Nostr authorisation requires both exact proofs; independent pages share spending", posixState, async (t) => {
  const f = await fixture(t, { defaultLimit: 100 }); const stable = generateSecretKey();
  const a = await f.authorize({ accountKey: stable }), b = await f.authorize({ accountKey: stable });
  assert.equal(a.status, 200); assert.equal(a.body.snapshot.limit, 100); assert.equal(a.body.requiresFreshUploadConsent, true);
  assert.equal(a.body.delegationExpiresAt, JSON.parse(a.challenge.event.content).delegationExpiresAt);
  assert.equal((await f.post("/account-budget/authorize", a.input)).status, 403);
  const [x, y] = await Promise.all([f.post("/account-budget/reserve", f.request(a.body.grant, a.pageKey, "reserve", op(1), 70)), f.post("/account-budget/reserve", f.request(b.body.grant, b.pageKey, "reserve", op(2), 70))]);
  assert.deepEqual([x.status, y.status], [200, 200]);
  assert.deepEqual([x.body.accepted, y.body.accepted].sort(), [false, true], "exactly one concurrent reservation fits, regardless of HTTP arrival order");
  assert.equal(x.body.reservedBytes + y.body.reservedBytes, 70);
  assert.equal(x.body.snapshot.spent, 70); assert.equal(y.body.snapshot.spent, 70);
  const replay = await f.post("/account-budget/reserve", f.request(a.body.grant, a.pageKey, "reserve", op(1), 70));
  assert.equal(replay.body.duplicate, true); assert.equal(replay.body.accepted, x.body.accepted); assert.equal(replay.body.snapshot.spent, 70);
  assert.equal((await f.post("/account-budget/reserve", f.request(a.body.grant, generateSecretKey(), "reserve", op(3), 1))).status, 403);
  assert.equal((await f.post("/account-budget/reserve", f.request(a.body.grant, a.pageKey, "reserve", op(1), 71))).status, 409);
  const snapshot = await f.post("/account-budget/status", f.request(b.body.grant, b.pageKey, "status", op(4)));
  assert.equal(snapshot.body.snapshot.spent, 70); assert(!JSON.stringify(snapshot.body).includes(getPublicKey(stable)));
});

test("website identity comes only from fresh trusted host authentication, and explicit dual proof links", posixState, async (t) => {
  const resolver = async (request) => request.headers.cookie === "fixture-account=alice" ? { issuer: "fixture-host", subject: "private-alice-subject" } : null;
  const f = await fixture(t, { defaultLimit: 100, resolveWebsiteAccount: resolver }); const stable = generateSecretKey(), cookie = { cookie: "fixture-account=alice" };
  const web = await f.authorize({ methods: ["website"], headers: cookie }); assert.equal(web.status, 200);
  const nostr = await f.authorize({ accountKey: stable });
  await f.post("/account-budget/reserve", f.request(web.body.grant, web.pageKey, "reserve", op(1), 40));
  await f.post("/account-budget/reserve", f.request(nostr.body.grant, nostr.pageKey, "reserve", op(2), 35));
  const linked = await f.authorize({ action: "link", methods: ["nostr", "website"], accountKey: stable, headers: cookie });
  assert.equal(linked.status, 200); assert.equal(linked.body.snapshot.spent, 75); assert.equal(linked.body.snapshot.limit, 100);
  assert.deepEqual(linked.body.snapshot.linkedMethods, ["nostr", "website"]);
  assert.equal((await f.post("/account-budget/status", f.request(web.body.grant, web.pageKey, "status", op(3)))).status, 403);
  const renewal = await f.post("/account-budget/renew", f.request(linked.body.grant, linked.pageKey, "renew", op(4)), { headers: cookie });
  assert.equal(renewal.status, 200); assert.equal(renewal.body.requiresFreshUploadConsent, false); assert.equal(renewal.body.delegationExpiresAt, linked.body.delegationExpiresAt);
  assert.equal((await f.post("/account-budget/renew", f.request(renewal.body.grant, linked.pageKey, "renew", op(5)))).status, 403);
  const saved = await readFile(f.statePath, "utf8"); assert(!saved.includes("private-alice-subject")); assert(!saved.includes(getPublicKey(stable)));
});

test("grant-only possession cannot change settings; fresh signed exact intent required", posixState, async (t) => {
  const f = await fixture(t); const stable = generateSecretKey(); const a = await f.authorize({ accountKey: stable });
  const fake = f.request(a.body.grant, a.pageKey, "status", op(1)); fake.settings = { limit: 1e12, reset: true };
  assert.equal((await f.post("/account-budget/status", fake)).status, 400);
  const settings = await f.authorize({ action: "settings", accountKey: stable, settings: { limit: 19, reset: true } });
  assert.equal(settings.status, 200); assert.equal(settings.body.snapshot.limit, 19); assert.equal(settings.body.snapshot.spent, 0); assert.equal(settings.body.requiresFreshUploadConsent, true);
  assert.equal((await f.post("/account-budget/status", f.request(a.body.grant, a.pageKey, "status", op(2)))).status, 403);
});

test("strict origin/purpose/settings/key/tag checks reject substitution without revealing identities", posixState, async (t) => {
  const f = await fixture(t); const page = generateSecretKey(), stable = generateSecretKey();
  const c = await f.post("/account-budget/challenge", { v: 1, action: "settings", methods: ["nostr"], pagePubkey: getPublicKey(page), settings: { limit: 100, reset: false } });
  const tampered = { ...c.body.event, content: c.body.event.content.replace('"limit":100', '"limit":101') };
  let result = await f.post("/account-budget/authorize", { v: 1, challenge: c.body.challenge, pageProof: finalizeEvent(structuredClone(c.body.event), page), nostrProof: finalizeEvent(tampered, stable) });
  assert.equal(result.status, 403);
  result = await f.post("/account-budget/authorize", { v: 1, challenge: c.body.challenge, pageProof: finalizeEvent({ ...c.body.event, tags: [["extra", "private"]] }, page), nostrProof: finalizeEvent(structuredClone(c.body.event), stable) });
  assert.equal(result.status, 403);
  result = await f.post("/account-budget/challenge", { v: 1, action: "grant", methods: ["nostr"], pagePubkey: getPublicKey(page) }, { headers: { origin: "https://foreign.invalid" } });
  assert.equal(result.status, 403);
  result = await f.post("/account-budget/challenge", { v: 1, action: "grant", methods: ["nostr"], pagePubkey: getPublicKey(page), accountId: "forged" });
  assert.equal(result.status, 400); assert(!JSON.stringify(result.body).includes("forged"));
});

test("changed website session after challenge refuses; close aborts a withheld host resolver", posixState, async (t) => {
  let subject = "first", hold = false, observedSignal, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { resolveWebsiteAccount: async (_request, { signal }) => {
    if (hold) { observedSignal = signal; entered(); return new Promise(() => {}); }
    return { issuer: "fixture", subject };
  } });
  const page = generateSecretKey(); const c = await f.post("/account-budget/challenge", { v: 1, action: "grant", methods: ["website"], pagePubkey: getPublicKey(page) });
  subject = "changed";
  assert.equal((await f.post("/account-budget/authorize", { v: 1, challenge: c.body.challenge, pageProof: finalizeEvent(structuredClone(c.body.event), page) })).status, 403);
  hold = true;
  const pending = f.post("/account-budget/challenge", { v: 1, action: "grant", methods: ["website"], pagePubkey: getPublicKey(page) }).catch(() => null);
  await started; await f.controls.close(); await pending; assert.equal(observedSignal.aborted, true);
  const saved = JSON.parse(await readFile(f.statePath, "utf8")); assert.equal(saved.accounts.length, 0); assert.equal(saved.grants.length, 0);
});

test("host errors stay private; bounded challenges, bodies and concurrent authentication refuse safely", posixState, async (t) => {
  const marker = "private-host-error-do-not-disclose";
  const broken = await fixture(t, { resolveWebsiteAccount: async () => { throw Object.assign(new Error(marker), { status: 418, code: marker }); } });
  const input = { v: 1, action: "grant", methods: ["website"], pagePubkey: getPublicKey(generateSecretKey()) };
  const refused = await broken.post("/account-budget/challenge", input);
  assert.deepEqual(refused, { status: 503, body: { error: "account-budget-unavailable" } });
  const bounded = await fixture(t, { challengeCapacity: 1 });
  assert.equal((await bounded.post("/account-budget/challenge", { ...input, methods: ["nostr"] })).status, 200);
  assert.equal((await bounded.post("/account-budget/challenge", { ...input, methods: ["nostr"] })).status, 429);
  assert.equal((await bounded.post("/account-budget/challenge", { ...input, padding: "x".repeat(9000) })).status, 413);
  let entered; const started = new Promise((resolve) => { entered = resolve; });
  const active = await fixture(t, { activeCapacity: 1, resolveWebsiteAccount: (_request, { signal }) => { entered(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(marker)), { once: true })); } });
  const pending = active.post("/account-budget/challenge", input).catch(() => null);
  await started;
  assert.equal((await active.post("/account-budget/challenge", input)).status, 429);
  await active.controls.close(); await pending;
  assert.equal(JSON.parse(await readFile(active.statePath, "utf8")).accounts.length, 0);
});

test("actual demo keeps accounts optional and private; failed TLS startup releases the account lease", posixState, async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "relayswarm-account-server-"));
  const statePath = join(directory, "account.json"); let demo;
  t.after(async () => { await demo?.close(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "segment.ts"), "fixture");
  const options = { mediaDir: directory, manifest: "index.m3u8", iceServers: [] };
  demo = await startDemoServer(options);
  assert.equal((await fetch(`${demo.base}/session.json`).then((r) => r.json())).accountBudget, undefined);
  assert.equal((await fetch(`${demo.base}/account-budget/challenge`)).status, 404);
  await demo.close(); demo = null;
  const key = join(directory, "bad-key"), cert = join(directory, "bad-cert");
  await writeFile(key, "invalid", { mode: 0o600 }); await writeFile(cert, "invalid", { mode: 0o600 });
  await assert.rejects(startDemoServer({ ...options, accountBudget: { statePath }, tlsKey: key, tlsCert: cert }));
  demo = await startDemoServer({ ...options, accountBudget: { statePath } });
  const session = await fetch(`${demo.base}/session.json`).then((r) => r.json());
  assert.deepEqual(session.accountBudget.methods, ["nostr"]);
  assert.equal(session.accountBudget.defaultLimit, 100000000);
  assert.equal(JSON.stringify(session).includes(statePath), false);
  assert.equal((await fetch(`${demo.base}${session.accountBudget.challengeEndpoint}`, { method: "POST", headers: { origin: demo.base, "content-type": "application/json" },
    body: JSON.stringify({ v: 1, action: "grant", methods: ["nostr"], pagePubkey: getPublicKey(generateSecretKey()) }) })).status, 200);
});

test("concurrent authenticated website challenges recheck capacity after the resolver yields", posixState, async (t) => {
  let count = 0, release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const bothEntered = new Promise((resolve) => { entered = resolve; });
  const f = await fixture(t, { challengeCapacity: 1, resolveWebsiteAccount: async () => {
    if (++count === 2) entered();
    await held;
    return { issuer: "fixture", subject: "same-account" };
  } });
  const input = { v: 1, action: "grant", methods: ["website"], pagePubkey: getPublicKey(generateSecretKey()) };
  const pending = [f.post("/account-budget/challenge", input), f.post("/account-budget/challenge", input)];
  try { await bothEntered; } finally { release(); }
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
  assert.equal(results.find((r) => r.status === 429).body.error, "account-challenge-capacity");
});

test("account close persistence failure still shuts HTTP and releases the independent operator lease", posixState, async (t) => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "relayswarm-account-close-"));
  const statePath = join(directory, "account.json"), operatorState = join(directory, "operator.json");
  let demo, replacement, at = 1000000;
  t.after(async () => { await demo?.close().catch(() => {}); await replacement?.close(); await chmod(statePath, 0o600); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "segment.ts"), "fixture");
  const options = { mediaDir: directory, manifest: "index.m3u8", iceServers: [], operatorToken: "a".repeat(64), operatorState };
  demo = await startDemoServer({ ...options, accountBudget: { statePath, now: () => at } });
  const base = demo.base;
  at += 1000;
  const response = await fetch(`${base}/account-budget/status`, { method: "POST", headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ v: 1, grant: "b".repeat(64), operationId: op(1), proof: {} }) });
  assert.equal(response.status, 403);
  await chmod(statePath, 0o400);
  await assert.rejects(demo.close(), /Unsafe durable state file/u);
  await assert.rejects(fetch(`${base}/session.json`, { signal: AbortSignal.timeout(1000) }));
  replacement = await startDemoServer(options);
  assert.equal((await fetch(`${replacement.base}/delivery-policy.json`)).status, 200);
});
