// The committed WebAssembly module against the JavaScript verifier, through
// the same loader the browser uses. RELAYSWARM_CORE_WASM names another build
// to check instead (CI checks a fresh one as well as the committed file).
import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCore, loadCoreVerifier } from "../src/browser/core-wasm.mjs";
import { PeerSelection } from "../src/browser/peer-selection.mjs";
import { runVectorCase } from "./proto-vectors.mjs";
import { CORE_FUNCTIONS, stubCore } from "./core-stub.mjs";
import { discoveryOps, discoveryScenarios, runDiscoveryOps, runSelectionOps, selectionOps } from "./selection-traces.mjs";
import { NeighbourDiscovery } from "../src/browser/neighbour-discovery.mjs";
import { CORE_SOURCE_SECTION, coreSourceHash } from "../scripts/core-source-hash.mjs";
import { fileURLToPath } from "node:url";

const path = process.env.RELAYSWARM_CORE_WASM
  ? resolve(process.env.RELAYSWARM_CORE_WASM) : new URL("../src/browser/relayswarm-core.wasm", import.meta.url);
const bytes = await readFile(path);
const vectors = JSON.parse(await readFile(new URL("../core/vectors/commitments.json", import.meta.url), "utf8"));
const core = await loadCoreVerifier(bytes);

function runCore(entry, at) {
  const value = structuredClone(entry);
  const trust = { streamEvent: value.streamEvent, swarmId: value.swarmId, revokedDelegationIds: value.revokedDelegationIds,
    delegationRevocations: value.delegationRevocations };
  if (value.op === "stream") return core.validStreamAuthorisation(value.event) ? true : null;
  if (value.op === "delegation") return core.verifyCommitmentDelegation(value.event, trust, at);
  return core.verifySegmentCommitment(value.event, { ...trust, key: value.key, context: value.context,
    maxSegmentBytes: value.maxSegmentBytes, delegation: value.delegation }, at);
}

test("the module has no imports and the expected exports", async () => {
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  for (const name of ["memory", ...Object.keys(CORE_FUNCTIONS)]) {
    assert.ok(WebAssembly.Module.exports(module).some((entry) => entry.name === name), name);
  }
});

test("the module was built from the Rust sources beside it", async () => {
  const sections = WebAssembly.Module.customSections(await WebAssembly.compile(bytes), CORE_SOURCE_SECTION);
  assert.equal(sections.length, 1, "one source stamp");
  const stamped = Buffer.from(sections[0]).toString("utf8");
  assert.equal(stamped, coreSourceHash(fileURLToPath(new URL("..", import.meta.url))),
    "core/ changed since the module was built: run npm run core:wasm");
});

test("every shared vector verifies identically through WebAssembly", () => {
  assert.ok(vectors.cases.length > 100);
  for (const entry of vectors.cases) assert.deepEqual(runCore(entry, vectors.at), entry.expected, entry.name);
});

test("host inputs the JSON boundary changes still match the JavaScript verifier", () => {
  const delegated = vectors.cases.find((entry) => entry.op === "commitment" && entry.delegation && entry.expected !== null);
  const authored = vectors.cases.find((entry) => entry.op === "commitment" && !entry.delegation && entry.expected !== null);
  assert.ok(delegated && authored);
  const variants = [
    (entry) => ({ ...entry, revokedDelegationIds: null }),
    (entry) => ({ ...entry, delegationRevocations: null }),
    (entry) => ({ ...entry, revokedDelegationIds: "not-a-list" }),
    (entry) => ({ ...entry, revokedDelegationIds: undefined, delegationRevocations: undefined }),
    (entry) => ({ ...entry, delegation: undefined }),
    (entry) => ({ ...entry, maxSegmentBytes: undefined }),
    (entry) => ({ ...entry, key: undefined }),
    (entry) => ({ ...entry, event: undefined }),
    (entry) => ({ ...entry, event: { ...entry.event, extra: 10n } }),
  ];
  for (const entry of [delegated, authored]) {
    for (const [index, variant] of variants.entries()) {
      const value = variant(entry);
      let expected;
      try { expected = runVectorCase(value, vectors.at); } catch { expected = null; }
      assert.deepEqual(runCore(value, vectors.at), expected, `${entry.name} variant ${index}`);
    }
  }
});

test("repeated calls give the same answers", () => {
  for (let round = 0; round < 500; round += 1) {
    for (const entry of vectors.cases.slice(0, 8)) assert.deepEqual(runCore(entry, vectors.at), entry.expected, entry.name);
  }
});

// One selection state per instance: a fresh instance for every sequence.
const compiled = await WebAssembly.compile(bytes);
const coreSelection = async () => (await loadCore(compiled, { onFailure: () => { throw new Error("core selection trapped"); } })).peerSelection();

test("seeded selection sequences match the JavaScript through WebAssembly", async () => {
  for (let seed = 1; seed <= 24; seed++) {
    const ops = selectionOps(seed, 300);
    const selection = await coreSelection();
    assert.deepEqual(runSelectionOps(ops, () => selection), runSelectionOps(ops), `seed ${seed}`);
    assert.equal(selection.kind, "wasm");
  }
});

test("selection arguments the loader can pass match the JavaScript", async () => {
  const run = (selection) => {
    const links = ["a", "b", "c"].map((pubkey) => ({ pubkey, closed: false, busy: false, have: new Set(["k"]) }));
    const out = [];
    // The race path passes no size or deadline; observations may lack fields.
    out.push(selection.select(links, "k", new Set())?.pubkey);
    selection.record(links[0], 120, 300_000);
    selection.observe({ firstByteMs: null, bytes: 300_000, flowMs: 900, totalFlowMs: null });
    selection.observe({ bytes: 40_000, flowMs: 500 });
    selection.observe();
    selection.record(links[1], NaN);
    selection.record(links[2], undefined, undefined);
    for (const [size, deadline] of [[undefined, undefined], [0, Infinity], [500_000, 10], [500_000, 1e9], [Infinity, 5000], [NaN, 5000]]) {
      out.push(selection.select(links, "k", new Set(["c"]), size, deadline)?.pubkey ?? null);
      out.push(selection.projectMs(size), selection.minimumMs(size), selection.estimate(links[0], size));
    }
    selection.forget(links[0]);
    out.push(links.map((link) => selection.summary(link)), selection.firstByteMs(), selection.rate(), selection.turn, selection.order);
    return out;
  };
  assert.deepEqual(run(await coreSelection()), run(new PeerSelection()));
});

test("a selection trap hands over to a fresh JavaScript selection", async () => {
  const failures = [];
  const traps = Object.keys(CORE_FUNCTIONS).filter((name) => name.startsWith("rs_sel_"));
  const selection = (await loadCore(stubCore(traps), { onFailure: (error) => failures.push(error) })).peerSelection();
  const link = { pubkey: "a", closed: false, busy: false, have: new Set(["k"]) };
  assert.equal(selection.kind, "wasm");
  selection.record(link, 100, 1000);
  assert.equal(selection.kind, "js");
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof WebAssembly.RuntimeError);
  // The fallback answers the call that trapped and keeps no earlier history.
  assert.equal(selection.summary(link).attempts, 1);
  assert.equal(selection.select([link], "k", new Set(), 1000, 5000), link);
  assert.equal(failures.length, 1);
  await assert.rejects((async () => { const core = await loadCore(compiled); core.peerSelection(); core.peerSelection(); })(), /already has/);
});


// One discovery state per instance, like selection.
const coreDiscovery = async (clock, onFailure = () => { throw new Error("core discovery trapped"); }) =>
  (await loadCore(compiled, { onFailure })).neighbourDiscovery(clock);
// The core keeps holder entries to itself; `stale` reports them in every row.
const withoutHolders = (rows) => rows.map((row) => ({ ...row, contexts: row.contexts.map(({ holders, ...context }) => context) }));

test("seeded discovery sequences and scenarios match the JavaScript through WebAssembly", async () => {
  const sequences = Array.from({ length: 24 }, (_, index) => ({ name: `seed ${index + 1}`, ops: discoveryOps(index + 1, 300) }))
    .concat(discoveryScenarios);
  for (const { name, ops } of sequences) {
    const core = await loadCore(compiled, { onFailure: () => { throw new Error("core discovery trapped"); } });
    let discovery;
    const rows = withoutHolders(runDiscoveryOps(ops, (clock) => discovery = core.neighbourDiscovery(clock)));
    const expected = withoutHolders(runDiscoveryOps(ops));
    const first = rows.findIndex((row, index) => !isDeepStrictEqual(row, expected[index]));
    assert.deepEqual(rows[first], expected[first], `${name}, step ${first}: ${JSON.stringify(ops[first])}`);
    assert.equal(discovery.kind, "wasm", name);
  }
});

test("discovery keeps one object per context, window and attempt, with the swarm's own fields", async () => {
  let now = 1_792_000_000_000;
  const discovery = await coreDiscovery(() => now);
  const pubkey = "c".repeat(64), key = "b".repeat(64);
  const context = discovery.context("main", "main:0");
  assert.equal(discovery.demand("main", "main:0", key), context);
  assert.equal(discovery.contexts.get("main"), context);
  assert.deepEqual(context.keys, [key]);
  discovery.hint(pubkey, [key], "ticket");
  const found = discovery.choose(() => true, () => true, true);
  assert.equal(found.context, context);
  assert.deepEqual(found.candidate, { pubkey, have: [key], ticket: "ticket", at: now });
  const attempt = discovery.begin(found);
  const window = discovery.window;
  assert.equal(attempt.window, window);
  assert.equal(window.context, context);
  window.timer = "timer";
  attempt.negotiation = "negotiation";
  const dial = { pubkey };
  discovery.allocated(attempt, dial);
  now += 1000;
  discovery.demand("main", "main:0", "d".repeat(64));
  assert.equal(discovery.window, window);
  assert.equal(window.attempt, attempt);
  assert.equal(window.timer, "timer");
  assert.equal(attempt.negotiation, "negotiation");
  assert.equal(attempt.dial, dial);
  assert.equal(discovery.valid(attempt), true);
  assert.equal(discovery.begin(found), null, "a choice begins once");
  discovery.failed({ pubkey });
  assert.equal(window.attempt, attempt, "only the allocated dial fails the attempt");
  discovery.failed(dial);
  assert.equal(window.attempt, null);
  assert.equal(discovery.valid(attempt), false);
  // A new rendition is a new context; the window keeps the one it opened for.
  const next = discovery.context("main", "main:1");
  assert.notEqual(next, context);
  assert.equal(discovery.window.context, context);
  assert.equal(discovery.current(context), false);
  assert.equal(discovery.verified(context), false);
  assert.equal(discovery.end(window), true);
  assert.equal(discovery.end(window), false);
  discovery.counters.expired++;
  discovery.counters.staleBlocked += 2;
  const counters = discovery.snapshot().counters;
  assert.deepEqual(counters, { checks: 1, replacements: 0, expired: 1, opened: 0, verified: 0, staleHolder: 0, staleBlocked: 2 });
});

test("discovery arguments the loader can pass match the JavaScript", async () => {
  const run = (discovery) => {
    const key = "b".repeat(64), peers = ["c", "d", "e"].map((value) => value.repeat(64));
    const out = [];
    out.push(discovery.context("video", "x"), discovery.demand("main", "r", 7) === undefined, discovery.demand("main", "r", "bad") === undefined);
    discovery.hint(peers[0], "not-a-list", "t");
    discovery.hint(peers[0], [key, 5, null, key, "bad", { key }], "x".repeat(3000));
    discovery.hint(peers[1], [key], 42);
    discovery.hint(peers[2], [key], "");
    discovery.hint(5, [key], "t");
    discovery.hint("bad", [key], "t");
    out.push([...discovery.candidates.values()].map(({ pubkey, have, ticket }) => [pubkey, have, ticket]));
    const context = discovery.demand("main", "r", key);
    for (const pubkey of [peers[0], 5, undefined]) {
      discovery.holderMiss(context, pubkey, key);
      discovery.holderMiss(null, pubkey, key);
      discovery.holderMiss({ mediaType: "main" }, pubkey, key);
      out.push(discovery.stale(context, pubkey), discovery.stale(undefined, pubkey), discovery.suppresses(pubkey));
      discovery.holderAhead(context, pubkey);
      discovery.forget(pubkey);
    }
    out.push(discovery.current({ mediaType: "main" }), discovery.verified(null), discovery.verified({ mediaType: "main" }));
    out.push(discovery.valid(null), discovery.valid({}), discovery.replaced(null, "x"), discovery.end(null), discovery.end({}), discovery.live({}));
    discovery.abandoned(null);
    discovery.failed(undefined);
    discovery.failed(0);
    const found = discovery.choose(() => true, () => true, 1);
    out.push(found && [found.candidate.pubkey, found.key]);
    const attempt = discovery.begin(found);
    out.push(discovery.replaced(attempt, 5), discovery.reserved(), discovery.live(), discovery.snapshot());
    discovery.clear();
    out.push(discovery.snapshot(), discovery.window, discovery.contexts.size);
    return out;
  };
  const now = () => 1_792_000_000_000;
  assert.deepEqual(run(await coreDiscovery(now)), run(new NeighbourDiscovery(now)));
});

test("a callback that throws propagates without retiring the core", async () => {
  const failures = [];
  const discovery = await coreDiscovery(() => 1_792_000_000_000, (error) => failures.push(error));
  discovery.demand("main", "r", "b".repeat(64));
  discovery.hint("c".repeat(64), ["b".repeat(64)], "t");
  assert.throws(() => discovery.choose(() => { throw new Error("host bug"); }, () => true, true), /host bug/);
  assert.throws(() => discovery.choose(() => true, () => { throw new Error("host bug"); }, true), /host bug/);
  assert.equal(discovery.kind, "wasm");
  assert.deepEqual(failures, []);
});

test("a discovery trap hands over to a fresh JavaScript discovery and keeps the counters", async () => {
  const failures = [];
  const core = await loadCore(stubCore(["rs_disc_call"]), { onFailure: (error) => failures.push(error) });
  const discovery = core.neighbourDiscovery(() => 1_792_000_000_000);
  const counters = discovery.counters;
  counters.opened = 3;
  assert.equal(discovery.kind, "wasm");
  const context = discovery.demand("main", "r", "b".repeat(64));
  assert.equal(discovery.kind, "js");
  assert.equal(core.retired, true);
  assert.equal(failures.length, 1);
  assert.ok(failures[0] instanceof WebAssembly.RuntimeError);
  // The fallback answers the call that trapped.
  assert.equal(discovery.contexts.get("main"), context);
  assert.deepEqual(context.keys, ["b".repeat(64)]);
  assert.equal(discovery.counters, counters);
  assert.equal(discovery.snapshot().counters.opened, 3);
  discovery.hint("c".repeat(64), ["b".repeat(64)], "t");
  assert.ok(discovery.choose(() => true, () => true, true));
  assert.equal(failures.length, 1);
  await assert.rejects((async () => { const core = await loadCore(compiled); core.neighbourDiscovery(); core.neighbourDiscovery(); })(), /already has/);
});

test("a core that answers malformed discovery results retires on first use", async () => {
  const failures = [];
  // rs_disc_call returns 0: an empty result, which is not JSON.
  const core = await loadCore(stubCore([]), { onFailure: (error) => failures.push(error) });
  const discovery = core.neighbourDiscovery(() => 1_792_000_000_000);
  assert.equal(discovery.context("main", "r").rendition, "r");
  assert.equal(discovery.kind, "js");
  assert.equal(failures.length, 1);
});
