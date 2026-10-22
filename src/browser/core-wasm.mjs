// The Rust core's commitment verifiers, compiled to WebAssembly
// (relayswarm-core.wasm, built by scripts/build-core-wasm.mjs from core/).
// The module has no imports. Each call passes `[event, options, atMs]` as
// JSON and reads JSON back; a rejection is null, exactly as in
// segment-commitment.mjs, which remains the reference implementation.

import { segmentMediaContext } from "./segment-commitment.mjs";

const OP_STREAM = 0;
const OP_DELEGATION = 1;
const OP_COMMITMENT = 2;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The fragment fields the core verifier reads from an hls.js load context. */
export function reduceFragmentContext(context) {
  return {
    sequence: context.frag.sn ?? null,
    discontinuity: context.frag.cc ?? 0,
    part: context.part?.index ?? null,
    level: String(context.frag.level),
    fragType: context.frag.type ?? null,
    decryptMethod: context.frag.decryptdata?.method ?? null,
    media: segmentMediaContext(context),
  };
}

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return WebAssembly.instantiate(source, {});
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return (await WebAssembly.instantiate(source, {})).instance;
  const url = source instanceof URL ? source.href : source;
  if (typeof url !== "string") throw new TypeError("coreWasm must be a URL, bytes or a WebAssembly.Module.");
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Core module unavailable (${response.status}).`);
  // A host serving the wrong media type still works, compiled from bytes.
  if (typeof WebAssembly.instantiateStreaming === "function") {
    try { return (await WebAssembly.instantiateStreaming(response.clone(), {})).instance; } catch { /* fall through */ }
  }
  return (await WebAssembly.instantiate(await response.arrayBuffer(), {})).instance;
}

/**
 * Load the core verifiers. `source` is a URL, the module's bytes or a
 * compiled WebAssembly.Module. The result mirrors segment-commitment.mjs.
 * A trap inside the module throws; rejection returns null.
 */
export async function loadCoreVerifier(source) {
  const exports = (await instantiate(source)).exports;
  for (const name of ["memory", "rs_alloc", "rs_free", "rs_call", "rs_result_ptr"]) {
    if (!exports[name]) throw new Error(`Core module lacks ${name}.`);
  }

  function call(op, input) {
    let bytes;
    try { bytes = encoder.encode(JSON.stringify(input)); } catch { return null; }
    const pointer = exports.rs_alloc(bytes.length);
    try {
      new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
      const length = exports.rs_call(op, pointer, bytes.length);
      if (length < 0) return null;
      return JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, exports.rs_result_ptr(), length)));
    } finally {
      exports.rs_free(pointer, bytes.length);
    }
  }

  const trust = ({ streamEvent, swarmId, revokedDelegationIds = [], delegationRevocations = [] }) =>
    ({ streamEvent, swarmId, revokedDelegationIds, delegationRevocations });

  return Object.freeze({
    kind: "wasm",
    validStreamAuthorisation: (event) => call(OP_STREAM, [event]) === true,
    verifyCommitmentDelegation: (event, options, at = Date.now()) => call(OP_DELEGATION, [event ?? null, trust(options), at]),
    verifySegmentCommitment(event, options, at = Date.now()) {
      let context;
      try { context = reduceFragmentContext(options.context); } catch { return null; }
      return call(OP_COMMITMENT, [event ?? null, { ...trust(options), key: options.key, context,
        maxSegmentBytes: options.maxSegmentBytes, delegation: options.delegation ?? null }, at]);
    },
  });
}
