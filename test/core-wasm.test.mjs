// The committed WebAssembly module against the JavaScript verifier, through
// the same loader the browser uses. RELAYSWARM_CORE_WASM names another build
// to check instead (CI checks a fresh one as well as the committed file).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCore, loadCoreVerifier } from "../src/browser/core-wasm.mjs";
import { PeerSelection } from "../src/browser/peer-selection.mjs";
import { runVectorCase } from "./proto-vectors.mjs";
import { CORE_FUNCTIONS, stubCore } from "./core-stub.mjs";
import { runSelectionOps, selectionOps } from "./selection-traces.mjs";

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
const coreSelection = async () => (await loadCore(compiled)).peerSelection(() => { throw new Error("core selection trapped"); });

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
  const selection = (await loadCore(stubCore(traps))).peerSelection((error) => failures.push(error));
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

