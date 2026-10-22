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

The contracts are [`vectors/commitments.json`](vectors/commitments.json) and
[`vectors/link-traces.json`](vectors/link-traces.json), the second recorded by
driving the real `PeerLink` with a fake channel and clock. Both are
generated from the JavaScript by `npm run proto:vectors`. Both
`npm run test:proto` and `cargo test` must reproduce every recorded result,
including the link's events and state after each step.
Change the JavaScript first, regenerate, then make Rust agree.

Known difference: a JSON string containing an unpaired UTF-16 surrogate escape
fails to parse in Rust, so such an event is rejected and such a control
message closes the link as `protocol`; JavaScript parses both.

```sh
cd core
cargo test
cargo build --target wasm32-unknown-unknown -p relayswarm-proto
```

The toolchain is pinned in `rust-toolchain.toml`. Builds use `core/target/`.
