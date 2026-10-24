# Core signature verification budget

Measured 24 October 2026 at source `cd92d3690b9e32b7f5932ea0b703f42a41a13eb9`.
This is an isolated experiment; the shipping Rust, JavaScript and committed
WASM module are unchanged. The [raw measurements](../spikes/results/core-signature-budget-20261024.json)
include asset hashes, per-round timings and tool versions.

## Recommendation

Keep signature verification in the core for now, with the WASM module served
as a separate compressed asset. Delegating checks to the already-bundled
`nostr-tools` saved about 3% of the combined compressed client/module bytes,
but the measured imported-verifier path took longer per commitment. It also
adds a host import to the currently import-free module. This result supports
retaining one verifier across browser and native targets; it does not establish
which isolated Schnorr implementation is intrinsically faster.

## Asset sizes

Both variants use the demo's minified browser ESM build, the same pinned Rust
release configuration (`opt-level=z`, LTO, no `wasm-opt`) and a separately fetched
module. Compression is gzip level 9 and Brotli quality 11. Totals sum the two
separately compressed assets; they exclude HTTP headers and cache effects.
The rebuilt baseline module is byte-identical to the committed module.

| Asset | Core checks: raw / gzip / Brotli bytes | Imported nostr-tools checks: raw / gzip / Brotli bytes |
|---|---:|---:|
| Demo client | 823,969 / 261,901 / 216,987 | 824,082 / 261,922 / 216,961 |
| WASM module | 406,612 / 150,394 / 122,190 | 369,884 / 137,844 / 112,356 |
| Combined | 1,230,581 / 412,295 / 339,177 | 1,193,966 / 399,766 / 329,317 |

The prototype saves 36,615 raw bytes, 12,529 gzip bytes or 9,860 Brotli bytes
across the pair. The client already includes `nostr-tools` for relay/session
verification; moving commitment checks does not remove it from the baseline.

## Verification time

Apple M1, macOS arm64, headless Chrome 155.0.8059.85, Node 24.21.0 for building and Rust
1.94.1, nostr-tools 2.24.1 and esbuild 0.28.2. Each variant passed all 140 shared commitment/delegation/revocation
vectors through Node/WASM and through actual Chrome before timing.

| Direct-author commitment | Core mean / median / p95 ms | Imported nostr-tools mean / median / p95 ms |
|---|---:|---:|
| Schema 2, 970-byte event | 0.521 / 0.500 / 0.600 | 0.850 / 0.800 / 1.000 |
| Schema 3, 64 piece hashes, 5,422-byte event | 0.649 / 0.600 / 0.700 | 1.038 / 1.000 / 1.200 |

These measure the complete `verifySegmentCommitment` browser call, including
JSON marshalling, validation, signature checks and returned-content decoding.
The schema-3 event commits to a 4 MiB segment; the segment payload is not hashed
or transferred in this timing. Each profile/variant has 50 warm-up calls and
600 timed calls in six alternating-order rounds of 100. The vector timestamp
is fixed for replay. Timings exclude network transfer, module compilation and
player startup; Chrome's timer resolution limits individual-call precision.

## Experiment boundary

The baseline keeps BIP-340 checks inside `event::verify_event`. In the isolated
prototype, the WASM implementation of that function serialises the event to a
host import. The host parses it and calls `nostr-tools/pure.verifyEvent`,
returning the verdict; native Rust keeps its existing implementation. The
prototype browser adapter supplies that import. Both demo clients are built
with identical esbuild settings. Temporary source edits are restored after
the experiment, and neither experimental module nor adapter is shipped.

Every callback parses a fresh event object, so `nostr-tools` cannot reuse an
object's cached verification symbol. The timing includes this JSON callback
cost and all checks the current core invokes. A different import format,
authorisation cache or direct JavaScript verifier could change the result;
those alternatives were not measured. Timing covers two direct-author
profiles, while the conformance check covers all 140 shared vectors.

This is one desktop loopback measurement. It does not measure mobile battery,
physical iPhone/Android devices, public NAT, player-level latency or field load.
It changes no release, tag, package dependency or production verification path.
