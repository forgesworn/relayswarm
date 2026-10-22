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

`relayswarm-wasm` exposes the commitment verifiers to JavaScript through
`wasm-bindgen` (pinned to `=0.2.129`, which must equal the CLI). Values cross
as JSON text. It is not wired into the loader yet. Measured on 22 October 2026
with the release profile, `wasm-bindgen --target web` and `wasm-opt -Oz`
(version 133):

| Build | Raw bytes | gzip -9 |
|---|---|---|
| `relayswarm_wasm_bg.wasm` after `wasm-opt` | 159,136 | 81,720 |
| The same without the BIP-340 verifier (`k256`) | 131,918 | 69,125 |
| Glue (`relayswarm_wasm.js`, unminified) | 8,799 | |
| Demo client bundle (esbuild, minified) | 787,462 | 250,814 |
| Demo client with the module inlined as base64 | 1,002,411 | 352,844 |

Through the WebAssembly build, all 120 commitment vectors match the
JavaScript.

```sh
cd core
cargo test
cargo build --target wasm32-unknown-unknown -p relayswarm-proto
cargo build --release --target wasm32-unknown-unknown -p relayswarm-wasm
wasm-bindgen --target web --out-dir target/js-wasm --no-typescript \
  target/wasm32-unknown-unknown/release/relayswarm_wasm.wasm
```

The toolchain is pinned in `rust-toolchain.toml`. Builds use `core/target/`.
