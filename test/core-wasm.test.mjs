// The committed WebAssembly module against the JavaScript verifier, through
// the same loader the browser uses. RELAYSWARM_CORE_WASM names another build
// to check instead (CI checks a fresh one as well as the committed file).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCoreVerifier } from "../src/browser/core-wasm.mjs";
import { runVectorCase } from "./proto-vectors.mjs";

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
  for (const name of ["memory", "rs_alloc", "rs_free", "rs_call", "rs_result_ptr"]) {
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
