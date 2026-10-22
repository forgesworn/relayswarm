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

The contract is [`vectors/commitments.json`](vectors/commitments.json),
generated from the JavaScript verifier by `npm run proto:vectors`. Both
`npm run test:proto` and `cargo test` must reproduce every recorded result.
Change the JavaScript first, regenerate, then make Rust agree.

Known difference: a JSON string containing an unpaired UTF-16 surrogate escape
fails to parse in Rust, so such an event is rejected; JavaScript parses it.

```sh
cd core
cargo test
cargo build --target wasm32-unknown-unknown -p relayswarm-proto
```

The toolchain is pinned in `rust-toolchain.toml`. Builds use `core/target/`.
