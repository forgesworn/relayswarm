// Shared by scripts/generate-proto-vectors.mjs and test/proto-vectors.test.mjs.
import { validStreamAuthorisation, verifyCommitmentDelegation, verifySegmentCommitment } from "../src/browser/segment-commitment.mjs";
import { reduceFragmentContext } from "../src/browser/core-wasm.mjs";

/** The reduced fragment context the Rust core receives from its shell. */
export const normaliseContext = (context) => reduceFragmentContext(structuredClone(context));

/** The JavaScript verifier's result for one vector: content, `true`, or null. */
export function runVectorCase(entry, at) {
  const value = structuredClone(entry);
  const trust = { streamEvent: value.streamEvent, swarmId: value.swarmId, revokedDelegationIds: value.revokedDelegationIds,
    delegationRevocations: value.delegationRevocations };
  if (value.op === "stream") return validStreamAuthorisation(value.event) ? true : null;
  if (value.op === "delegation") return verifyCommitmentDelegation(value.event, trust, at);
  if (value.op === "commitment") {
    return verifySegmentCommitment(value.event, { ...trust, key: value.key, context: value.context,
      maxSegmentBytes: value.maxSegmentBytes, delegation: value.delegation }, at);
  }
  throw new Error(`Unknown vector operation ${value.op}.`);
}
