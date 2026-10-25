import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile, chmod, realpath, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccountUploadBudget } from "../src/account-upload-budget.mjs";

const page = "a".repeat(64), second = "b".repeat(64);
const nostr = { method: "nostr", issuer: "nostr:v1", subject: "c".repeat(64) };
const website = { method: "website", issuer: "test-host", subject: "private-website-account" };
const op = (n) => n.toString(16).padStart(32, "0");
const posixState = { skip: !["darwin", "linux"].includes(process.platform) ? "Durable account state requires a supported local POSIX filesystem; Windows ACL support is not implemented." : false };

test("invalid account options refuse synchronously before opening durable state on every platform", () => {
  for (const options of [{ defaultLimit: -1 }, { grantTtlSeconds: 301 }, { delegationTtlSeconds: 29 }, { mutationCapacity: 257 }]) {
    assert.throws(() => createAccountUploadBudget({ statePath: "never-open-invalid-account-options.json", ...options }), /Invalid account budget options/u);
  }
});

test("Windows refuses account state before creating a ledger or private lease", { skip: process.platform !== "win32" ? "Exercises the actual unsupported Windows ACL boundary on Windows." : false }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-account-windows-refusal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ledger = createAccountUploadBudget({ statePath: join(directory, "account.json") });
  await assert.rejects(ledger.ready(), /Private durable state requires POSIX permissions/u);
  await ledger.close().catch(() => {});
  assert.deepEqual(await readdir(directory), [], "Neither ledger nor lease may be created on the unsupported platform.");
});
async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "relayswarm-account-budget-")), statePath = join(dir, "account.json");
  let at = 1000000, mono = 0;
  const config = { statePath, now: () => at, monotonicNow: () => mono, ...options }, ledger = createAccountUploadBudget(config);
  t.after(async () => { await ledger.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); });
  await ledger.ready();
  const authorize = (identities = [nostr], extra = {}) => ledger.authorize(identities, { pagePubkey: page, methods: identities.map((i) => i.method),
    delegationExpiresAt: at + (options.delegationTtlSeconds ?? 10800) * 1000, authorisationExpiresAt: at + 30000, ...extra });
  return { ledger, authorize, config, statePath, advance: (ms) => { at += ms; mono += Math.max(0, ms); }, elapse: (ms) => { mono += ms; } };
}

test("two devices share one atomically durable allowance; duplicate/conflict/reopen preserve charges", posixState, async (t) => {
  const f = await fixture(t, { defaultLimit: 100 });
  const a = await f.authorize(), b = await f.authorize([nostr], { pagePubkey: second });
  const decisions = await Promise.all([f.ledger.reserve(a.grant, op(1), 60), f.ledger.reserve(b.grant, op(2), 60)]);
  assert.deepEqual(decisions.map((d) => d.accepted), [true, false]);
  assert.equal((await f.ledger.reserve(a.grant, op(1), 60)).duplicate, true);
  await assert.rejects(f.ledger.reserve(a.grant, op(1), 61), { code: "account-operation-conflict" });
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(saved.accounts[0].spent, 60); assert.equal(saved.operations.length, 2);
  assert(!JSON.stringify(saved).includes(nostr.subject));
  await f.ledger.close();
  const reopened = createAccountUploadBudget(f.config);
  try { await reopened.ready(); assert.equal((await reopened.reserve(a.grant, op(1), 60)).duplicate, true); assert.equal((await reopened.inspectGrant(b.grant)).snapshot.spent, 60); }
  finally { await reopened.close(); }
});

test("linking sums spent, takes no higher limit, preserves aliases/dedup and revokes old grants", posixState, async (t) => {
  const f = await fixture(t);
  const a = await f.authorize([nostr], { settings: { limit: 100, reset: false } });
  const b = await f.authorize([website], { settings: { limit: 150, reset: false } });
  await f.ledger.reserve(a.grant, op(1), 60); await f.ledger.reserve(b.grant, op(2), 70);
  const linked = await f.authorize([nostr, website], { link: true });
  assert.equal(linked.snapshot.limit, 100); assert.equal(linked.snapshot.spent, 130); assert.equal(linked.snapshot.remaining, 0);
  assert.deepEqual(linked.snapshot.linkedMethods, ["nostr", "website"]);
  await assert.rejects(f.ledger.reserve(a.grant, op(3), 1), { status: 403 });
  await assert.rejects(f.ledger.reserve(b.grant, op(3), 1), { status: 403 });
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(saved.accounts.filter((a) => a.aliasTo).length, 1); assert.equal(saved.operations.length, 2);
  assert(!JSON.stringify(saved).includes(website.subject));
  const later = await f.authorize([website]); assert.equal(later.snapshot.spent, 130); assert.equal(later.snapshot.limit, 100);
});

test("explicit settings/reset alone change limits or spent; login and logout never reset", posixState, async (t) => {
  const f = await fixture(t, { defaultLimit: 100 }); const first = await f.authorize();
  await f.ledger.reserve(first.grant, op(1), 40); await f.ledger.revokeGrant(first.grant);
  const login = await f.authorize(); assert.equal(login.snapshot.spent, 40); assert.equal(login.snapshot.limit, 100);
  const changed = await f.authorize([nostr], { settings: { limit: 30, reset: false } });
  assert.equal(changed.snapshot.spent, 40); assert.equal(changed.snapshot.remaining, 0);
  await assert.rejects(f.ledger.inspectGrant(login.grant), { status: 403 });
  const reset = await f.authorize([nostr], { settings: { limit: 30, reset: true } });
  assert.equal(reset.snapshot.spent, 0); assert.equal(reset.snapshot.generation, 2); assert.equal(reset.requiresFreshUploadConsent, true);
});

test("renewal keeps the original delegation bound and spend; old scopes never regain expiry", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize(); await f.ledger.reserve(a.grant, op(1), 17);
  f.advance(90000); const b = await f.ledger.renew(a.grant, op(2), null);
  assert.equal(b.delegationExpiresAt, a.delegationExpiresAt); assert.equal(b.expiresAt, a.expiresAt + 90000);
  assert.equal(b.snapshot.spent, 17); assert.equal(b.requiresFreshUploadConsent, false);
  assert.equal((await f.ledger.renew(a.grant, op(2), null)).grant, b.grant);
  await assert.rejects(f.ledger.renew(a.grant, op(3), null), { status: 409 });
  f.advance(40000); await assert.rejects(f.ledger.reserve(a.grant, op(1), 17), { status: 403 });
});

test("pre-commit cancellation and private-state persistence failure refuse; accepted charges never refund", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize(); const signal = AbortSignal.abort();
  await assert.rejects(f.ledger.reserve(a.grant, op(1), 10, { signal }), { code: "account-operation-cancelled" });
  assert.equal((await f.ledger.inspectGrant(a.grant)).snapshot.spent, 0);
  await f.ledger.reserve(a.grant, op(2), 19); assert.equal((await f.ledger.inspectGrant(a.grant)).snapshot.spent, 19);
  await chmod(f.statePath, 0o400);
  await assert.rejects(f.ledger.reserve(a.grant, op(3), 20), { code: "account-persistence-unavailable" });
  await chmod(f.statePath, 0o600);
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).accounts[0].spent, 19);
  await assert.rejects(f.ledger.reserve(a.grant, op(4), 1), { status: 503 });
});

test("account and operation capacity refuse without evicting counters; writer lease excludes a second owner", posixState, async (t) => {
  const f = await fixture(t, { accountCapacity: 1, operationCapacity: 1 }); const a = await f.authorize();
  await f.ledger.reserve(a.grant, op(1), 10);
  await assert.rejects(f.ledger.reserve(a.grant, op(2), 1), { code: "account-operation-capacity" });
  await assert.rejects(f.authorize([website]), { code: "account-capacity" });
  assert.equal((await f.ledger.inspectGrant(a.grant)).snapshot.spent, 10);
  const other = createAccountUploadBudget(f.config); await assert.rejects(other.ready()); await other.close().catch(() => {});
});

test("wall-clock rollback refuses both live operations and reopening durable state", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize(); f.advance(-1);
  await assert.rejects(f.ledger.reserve(a.grant, op(1), 1), { code: "account-clock-unavailable" });
  await f.ledger.close(); const other = createAccountUploadBudget(f.config); await assert.rejects(other.ready()); await other.close().catch(() => {});
});

test("disconnect revokes retained renewal tokens without affecting another device or refunding", posixState, async (t) => {
  const f = await fixture(t); const first = await f.authorize(), other = await f.authorize([nostr], { pagePubkey: second });
  await f.ledger.reserve(first.grant, op(1), 13);
  const renewed = await f.ledger.renew(first.grant, op(2), null);
  await f.ledger.revokeGrant(renewed.grant);
  await assert.rejects(f.ledger.reserve(first.grant, op(3), 1), { status: 403 });
  await assert.rejects(f.ledger.inspectGrant(renewed.grant), { status: 403 });
  assert.equal((await f.ledger.inspectGrant(other.grant)).snapshot.spent, 13);
});

test("concurrent reservations commit in arrival order and stop exactly at the limit", posixState, async (t) => {
  const f = await fixture(t, { defaultLimit: 100 }); const a = await f.authorize();
  const decisions = await Promise.all(Array.from({ length: 12 }, (_, index) => f.ledger.reserve(a.grant, op(index + 1), 10)));
  assert.deepEqual(decisions.map((d) => d.accepted), [...Array(10).fill(true), false, false]);
  assert.deepEqual(decisions.map((d) => d.snapshot.spent), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 100, 100]);
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(saved.accounts[0].spent, 100); assert.equal(saved.operations.length, 12);
  await f.ledger.close();
  const reopened = createAccountUploadBudget(f.config);
  try { await reopened.ready(); assert.equal((await reopened.reserve(a.grant, op(12), 10)).duplicate, true); assert.equal((await reopened.inspectGrant(a.grant)).snapshot.spent, 100); }
  finally { await reopened.close(); }
});

test("an operation cancelled while queued behind a write leaves no charge", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize(), controller = new AbortController();
  const first = f.ledger.reserve(a.grant, op(1), 5);
  // Let the first write start, so the others queue behind it.
  await new Promise((resume) => setImmediate(resume));
  const queued = f.ledger.reserve(a.grant, op(2), 7, { signal: controller.signal });
  const after = f.ledger.reserve(a.grant, op(3), 11);
  controller.abort();
  assert.equal((await first).accepted, true);
  await assert.rejects(queued, { code: "account-operation-cancelled" });
  assert.equal((await after).snapshot.spent, 16);
  assert.equal(JSON.parse(await readFile(f.statePath, "utf8")).operations.length, 2);
});

test("outcomes settle in arrival order, a refusal only after the write it depends on", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize(), settled = [];
  const onDisk = () => JSON.parse(readFileSync(f.statePath, "utf8"));
  const charge = f.ledger.reserve(a.grant, op(1), 5), conflict = f.ledger.reserve(a.grant, op(1), 6);
  const revoke = f.ledger.revokeGrant(a.grant), inspect = f.ledger.inspectGrant(a.grant);
  charge.then(() => settled.push("charge"));
  conflict.catch((error) => settled.push(`conflict ${error.code} ${onDisk().operations.length}`));
  revoke.then(() => settled.push("revoke"));
  inspect.catch((error) => settled.push(`inspect ${error.code} ${onDisk().grants[0].revoked}`));
  // A caller that awaits in turn handles each refusal as it reaches it.
  assert.equal((await charge).accepted, true);
  await assert.rejects(conflict, { code: "account-operation-conflict" });
  await revoke;
  await assert.rejects(inspect, { code: "account-grant-unavailable" });
  assert.deepEqual(settled, ["charge", "conflict account-operation-conflict 1", "revoke", "inspect account-grant-unavailable true"]);
});

test("a failed shared write refuses every operation in it and persists none", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize();
  await f.ledger.reserve(a.grant, op(1), 3);
  await chmod(f.statePath, 0o400);
  const results = await Promise.allSettled([4, 5, 6].map((bytes, index) => f.ledger.reserve(a.grant, op(index + 2), bytes)));
  await chmod(f.statePath, 0o600);
  assert.deepEqual(results.map((result) => result.reason?.code), Array(3).fill("account-persistence-unavailable"), "the three operations shared one write");
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(saved.accounts[0].spent, 3); assert.equal(saved.operations.length, 1);
  await assert.rejects(f.ledger.reserve(a.grant, op(9), 1), { code: "account-budget-unavailable" });
});

test("a refusal that depends on a change whose write fails is not released", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize();
  await chmod(f.statePath, 0o400);
  const results = await Promise.allSettled([f.ledger.reserve(a.grant, op(1), 4), f.ledger.reserve(a.grant, op(1), 5),
    f.ledger.revokeGrant(a.grant), f.ledger.reserve(a.grant, op(2), 1), f.ledger.inspectGrant(a.grant)]);
  await chmod(f.statePath, 0o600);
  // Neither the conflict with the unsaved charge nor the unsaved revocation is reported.
  assert.deepEqual(results.map((result) => result.reason?.code), Array(5).fill("account-persistence-unavailable"));
  const saved = JSON.parse(await readFile(f.statePath, "utf8"));
  assert.equal(saved.operations.length, 0); assert.equal(saved.grants[0].revoked, false);
});

test("pending mutation cap refuses excess before allocating queued work", posixState, async (t) => {
  const f = await fixture(t, { mutationCapacity: 1 }); const a = await f.authorize();
  const accepted = f.ledger.reserve(a.grant, op(1), 3);
  await assert.rejects(f.ledger.reserve(a.grant, op(2), 4), { code: "account-budget-queue-capacity" });
  assert.equal((await accepted).snapshot.spent, 3);
  assert.equal((await f.ledger.inspectGrant(a.grant)).snapshot.spent, 3);
});

test("stalled wall time cannot extend live grant or original renewal delegation", posixState, async (t) => {
  const f = await fixture(t, { grantTtlSeconds: 30, delegationTtlSeconds: 60 });
  const a = await f.authorize(); f.elapse(20000);
  const b = await f.ledger.renew(a.grant, op(1), null); f.elapse(20000);
  const c = await f.ledger.renew(b.grant, op(2), null);
  assert.equal(c.delegationExpiresAt, a.delegationExpiresAt);
  f.elapse(21000); await assert.rejects(f.ledger.reserve(c.grant, op(3), 1), { status: 403 });
});

test("expired read followed by orderly close persists observed wall highwater", posixState, async (t) => {
  const f = await fixture(t); const a = await f.authorize(); f.advance(130000);
  await assert.rejects(f.ledger.inspectGrant(a.grant), { status: 403 });
  await f.ledger.close(); f.advance(-120000);
  const reopened = createAccountUploadBudget(f.config); await assert.rejects(reopened.ready()); await reopened.close().catch(() => {});
});
