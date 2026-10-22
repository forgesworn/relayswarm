# RelaySwarm core (Rust)

Unreleased. A Rust port of RelaySwarm's protocol rules, intended to become one
engine shared by the browser loader (WebAssembly), Swift and Kotlin clients and
native shells. Nothing in the published package uses it yet.

`relayswarm-proto` holds signed segment commitment (schemas 1 and 2), scoped
delegation and revocation verification, ported from
[`segment-commitment.mjs`](../src/browser/segment-commitment.mjs). It performs
no I/O and reads no clock; callers pass the time. It reproduces the JavaScript
semantics the verifier relies on, including `JSON.stringify` output, strict
equality and `Number.isSafeInteger`.

`relayswarm_proto::link` is the browser data-channel protocol from
[`peer-link.mjs`](../src/browser/peer-link.mjs) as a state machine: requests
with `meta`/chunks/`eof`/`none`, timeout and abandonment with `cancel` and
bounded draining, the serialised upload queue with backpressure, and the
`have`, `contribution` and `fetching` controls. The shell sends what it emits,
answers its serve requests and reports timers and channel draining. The native
HyperDHT framing in `object-transfer.mjs` stays with the Node adapter.

`relayswarm_proto::selection` (from `peer-selection.mjs`) chooses a link and
projects transfer times from recent first-byte times, rates and completions,
with the same double-precision arithmetic. `relayswarm_proto::discovery` (from
`neighbour-discovery.mjs`) keeps demand, hints, holder misses and the single
replacement window, with IDs where the JavaScript compares object identity.

The contracts are [`vectors/commitments.json`](vectors/commitments.json) and
[`vectors/link-traces.json`](vectors/link-traces.json), the second recorded by
driving the real `PeerLink` with a fake channel and clock. Both are
generated from the JavaScript by `npm run proto:vectors`. Both
`npm run test:proto` and `cargo test` must reproduce every recorded result,
including the link's events and state after each step. Selection and
discovery are checked against seeded random and scripted operation sequences
that `npm run proto:traces` regenerates deterministically under
`core/target/js-traces/`; they are too large to commit. Without that file the
Rust test skips locally; CI sets `RELAYSWARM_REQUIRE_JS_TRACES` so it cannot.
Change the JavaScript first, regenerate, then make Rust agree.

Known difference: a JSON string containing an unpaired UTF-16 surrogate escape
fails to parse in Rust, so such an event is rejected and such a control
message closes the link as `protocol`; JavaScript parses both.

`relayswarm-wasm` builds the commitment verifiers as a WebAssembly module with
no imports and a plain C ABI, so any WebAssembly host can call it without
generated glue: `rs_alloc` and `rs_free` manage input bytes, `rs_call(op, ptr,
len)` takes `[event, options, atMs]` as JSON and returns the result's length
(-1 for rejection), and `rs_result_ptr` locates the result.

Peer selection uses plain numbers instead, so doubles and infinities cross
unchanged and NaN stands for JavaScript `null`: `rs_sel_observe`,
`rs_sel_record`, `rs_sel_forget`, `rs_sel_select` (little-endian u32 link
handles in, the chosen handle or -1 out), `rs_sel_project`, `rs_sel_minimum`
and `rs_sel_estimate` return a double, and `rs_sel_state` and
`rs_sel_summary` return the address of six doubles. Each instance holds one
selection state, so each swarm instantiates its own. The caller filters
links for open, idle, untried and holding the key; the core does the rest.

The browser loader is `src/browser/core-wasm.mjs`; hosts opt in with
`coreWasm` (see `INTEGRATION.md`). Its `PeerSelection` stand-in replays
the seeded selection sequences through the committed module and matches the
JavaScript at every step.

`npm run core:wasm` builds it with the release profile and writes
`src/browser/relayswarm-core.wasm`, which is committed so Git installs need no
Rust. Source paths are remapped, and the script fails if the module names a
local directory. `npm run test:proto` runs all 120 vectors through the
committed module; CI also builds a fresh one and runs them through that. A
fresh module's bytes may differ by host; its verdicts may not.

Measured on 22 October 2026:

| Build | Raw bytes | gzip -9 |
|---|---|---|
| `relayswarm-core.wasm` with selection (committed, no `wasm-opt`) | 227,541 | 94,900 |
| The same after `wasm-opt -Oz` (version 133, current features enabled) | 186,384 | 92,203 |
| Verifiers only (committed before selection) | 200,458 | 87,373 |
| Verifiers only after `wasm-opt -Oz` | 165,047 | 84,193 |
| Earlier `wasm-bindgen` build after `wasm-opt`, for comparison | 159,136 | 81,720 |
| Demo client bundle (esbuild, minified), before the loader change | 787,462 | 250,814 |

The module is fetched separately rather than inlined: inlining it as base64
measured 1,002,411 bytes (352,844 gzip) for the demo client.

```sh
cd core
cargo test
cargo build --target wasm32-unknown-unknown -p relayswarm-proto
cd .. && npm run core:wasm
```

The toolchain is pinned in `rust-toolchain.toml`. Builds use `core/target/`.
