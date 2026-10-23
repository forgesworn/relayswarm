# RelaySwarm core (Rust)

Unreleased. A Rust port of RelaySwarm's protocol rules, intended to become one
engine shared by the browser loader (WebAssembly), Swift and Kotlin clients and
native shells. Nothing in the published package uses it yet.

`relayswarm-proto` holds signed segment commitment (schemas 1 to 3), scoped
delegation and revocation verification, ported from
[`segment-commitment.mjs`](../src/browser/segment-commitment.mjs). Schema 3
(`relayswarm-segment-v3`) is schema 2 plus `pieceSize` and one SHA-256 per
piece in `pieces`, for multi-holder transfer; the piece size is fixed by the
segment size (at least 64 KiB, at most 64 pieces, a multiple of 16 KiB). The
publisher signs it with `pieceCommitments`; no receiver uses its pieces yet. It performs
no I/O and reads no clock; callers pass the time. It reproduces the JavaScript
semantics the verifier relies on, including `JSON.stringify` output, strict
equality and `Number.isSafeInteger`.

`relayswarm_proto::link` is the browser data-channel protocol from
[`peer-link.mjs`](../src/browser/peer-link.mjs) as a state machine: requests
with `meta`/chunks/`eof`/`none`, timeout and abandonment with `cancel` and
bounded draining, the serialised upload queue with backpressure, and the
`have`, `contribution` and `fetching` controls. Framing 2, which is not in the
JavaScript link, adds a piece range to `want` and `meta` (`"p":[start,end]`):
`Link::request_range` asks for pieces of an object, the holder slices its
held object by the schema 3 piece size, and a `meta` that does not echo the
range with its exact length closes the link. `relayswarm_proto::pieces` holds
the offsets; `tests/link_ranges.rs` covers it, as there is no JavaScript
reference to record traces from.

`relayswarm_proto::scheduler` plans one schema 3 object across holders
(CORE-SPEC section 6). `plan` splits the needed pieces so every source is
projected to finish together, from each source's first byte and rate, with
at most `max_holders` peers; when peers alone would be late, each keeps what
it can finish in time (an untested peer at least one trial piece) and origin
takes the rest of the tail. `Transfer` issues the ranged requests, verifies each piece
against the commitment, bans a holder that sends a bad piece, reassigns
failed work, moves outstanding pieces to origin at the deadline less
`originReserveMs`, duplicates the last two pieces of a lagging source, and
delivers only when the whole object matches. Fed each request's progress, it
abandons a peer early by the single-holder loader's rules: no first byte
within three recent first-byte times (and 250 ms), or a flow that cannot
finish its range by the floor even at twice its recent rate or the best
shared rate; a tick catches a flow that stops. `DEFAULT_MAX_HOLDERS` (3) and
`DEFAULT_LOOKAHEAD_SEGMENTS` (2) are the spec's proposals, not yet set from a
replayed field trace. The loader uses it only under the experimental
`multiHolder` option.

The module exposes it as `rs_xfer_new`, `rs_xfer_call` and `rs_xfer_free`
(commands as JSON, a delivered object's bytes after them), and ranged link
requests as `rs_link_call` operation 14. `core.transfer()` and the `range`
option of `CorePeerLink.request` wrap them; `test/core-transfer.test.mjs`
drives a transfer between core links through the module. The shell sends what it emits,
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

Peer links live behind handles that are never reused: `rs_link_new` and
`rs_link_free`, and `rs_link_call(handle, op, now, channel, a, b, ptr, len)`
for every input, where `channel` carries whether the channel is open (bit 0)
and ordered and fully reliable (bit 1), read before each call as
`peer-link.mjs` reads them. A call returns a frame: thirteen doubles (state
version, closed, busy, transferring, uploads in flight, bytes in and out,
opened, last served and last delivered times, next deadline, a new request's
ID and whether an upload waits for the channel to drain), then events as a
tag, a u32 length and a payload. The shell copies the frame out before
running any callback, since a callback may call in again.

Neighbour discovery takes JSON: `rs_disc_call(op, now, ptr, len)` reads an
array of arguments and returns the length of a JSON result. Queries answer a
bare value; changes answer `{"r": result, "s": state}`, where the state lists
every context, the open window and its attempt, and the three counters the
core keeps (checks, replacements, verified). Contexts, windows and attempts
are numeric IDs. A host's eligibility and need checks run before the call and
cross as lists of public keys and media types, and `begin` starts from the
latest `choose` or `hinted` result. Each instance holds one discovery state.

The browser loader is `src/browser/core-wasm.mjs`; hosts opt in with
`coreWasm` (see `INTEGRATION.md`). Its `PeerSelection` stand-in replays
the seeded selection sequences through the committed module and matches the
JavaScript at every step. `src/browser/core-peer-link.mjs` is a `PeerLink`
that owns the channel, the one timer and the callbacks and leaves the
protocol to the core; all 48 committed link traces match through it.
`src/browser/core-discovery.mjs` is a `NeighbourDiscovery` that keeps one
JavaScript object per context, window and attempt, updated in place, so the
swarm's identity checks and its own fields on them (a window's timer, an
attempt's dial and negotiation) hold; the seeded and scripted discovery
sequences match through it, apart from holder entries, which the core keeps to
itself and which `stale` reports.

Known differences in the link: the core counts a response in `bytesOut` as
it emits the chunks, so a channel that refuses a chunk leaves the closed
link's `bytesOut` higher than `peer-link.mjs` would; and the core paces
uploads by the bytes it has sent since the channel last reported its queue,
resuming at once when the channel reports little queued, which matches
`peer-link.mjs` whenever `bufferedAmount` grows with each send.

`npm run core:wasm` builds it with the release profile and writes
`src/browser/relayswarm-core.wasm`, which is committed so Git installs need no
Rust. Source paths are remapped, and the script fails if the module names a
local directory, and appends a `relayswarm-source` custom section holding
the SHA-256 of the Rust sources it was built from. `npm run test:proto` runs
all 140 vectors through the committed module and fails if that hash no
longer matches `core/`; CI also builds a fresh one and runs them through
that. A fresh module's bytes may differ by host; its verdicts may not.

Measured on 22 and 23 October 2026:

| Build | Raw bytes | gzip -9 |
|---|---|---|
| `relayswarm-core.wasm` with selection, links, discovery and the scheduler (committed, no `wasm-opt`) | 400,116 | 147,914 |
| With selection, links and discovery, before the scheduler | 315,803 | 122,029 |
| The same after `wasm-opt -Oz` (version 133, current features enabled) | 253,619 | 120,570 |
| With selection and links, before discovery | 274,837 | 112,644 |
| With selection and links after `wasm-opt -Oz` | 223,262 | 109,259 |
| With selection, before links | 227,541 | 94,900 |
| With selection after `wasm-opt -Oz` | 186,384 | 92,203 |
| Verifiers only (committed before selection) | 200,458 | 87,373 |
| Verifiers only after `wasm-opt -Oz` | 165,047 | 84,193 |
| Earlier `wasm-bindgen` build after `wasm-opt`, for comparison | 159,136 | 81,720 |
| Demo client bundle (esbuild, minified), before the loader change | 787,462 | 250,814 |

The module is fetched separately rather than inlined: inlining it as base64
measured 1,002,411 bytes (352,844 gzip) for the demo client.

`relayswarm-ffi` is the UniFFI facade (spec step 4) for Swift and Kotlin.
It exposes the commitment verifiers, taking the event and the options
`segment-commitment.mjs` takes as JSON text and returning the verified content
as JSON or nothing; the schema 3 piece helpers; the multi-holder `Transfer`;
`PeerLink`, the data channel protocol; `PeerSelection`, which chooses a
link from the shell's numeric link handles; and `NeighbourDiscovery`, the
demand, hint and replacement-window state. Objects take and return typed
records. Each `PeerLink` call returns the events to act on in order, the
request ID it assigned, and the link's scalar state; `sets()` returns what the
remote has announced and need be read only when `version` changes. Request
keys are the object's SHA-256 in lowercase hex; a holder ignores a `want`
with any other key. The shell
reports the channel's state with `set_channel_open` and `set_reliable`, sets
its low-water threshold from `link_limits()`, and closes the link with
`close_link(reason)`; in Kotlin, `close()` frees the object instead. The facade restores the
loader's key order in the fragment context's `media` and `encryption` before
verifying, because the core compares `encryption` as `JSON.stringify` text and
a host serialising a dictionary may reorder it. Discovery takes media types
as the strings HLS uses and has no context for any but `main` and `audio`, as
in JavaScript; contexts and attempts are numeric IDs, and `begin` starts an
attempt on the holder the latest `choose` or `hinted` returned, as the
WebAssembly bridge does; a call that finds no holder clears it, and each
result begins at most once. UniFFI exports no constants,
so `default_transfer_settings()` and `link_limits()` return the core's values.

`cargo test` runs the shared vectors and every recorded link trace through
the facade, and replays a scripted transfer and a piece range exchange through
both the facade and the core, expecting the same commands and events.
`npm run test:ffi:swift` and `npm run test:ffi:kotlin` build the debug
library, generate bindings, compile a small program against them and check
every vector, every link trace, one transfer and a piece range exchanged
between two links, that a full send buffer holds the range's data until a
drain, that the channel's open and reliable flags change what the link
sends and how an abort ends, and every seeded selection and discovery
sequence that `npm run proto:traces` records from the JavaScript (the script
records them first if they are missing); CI runs both on Linux. The
Kotlin check downloads JNA 5.14.0 from Maven Central into `core/target/` and
verifies its SHA-256. Generate bindings from an unstripped build: the release
profile strips symbols, and on Linux that removes the UniFFI metadata.
There is no packaged Apple
framework or Android library, and RelaySwarmKit does not use it yet. Release
builds abort on panic, so a panic in the core ends the host process rather
than raising an error.

```sh
cd core
cargo test
cargo build --target wasm32-unknown-unknown -p relayswarm-proto
cd .. && npm run core:wasm
npm run test:ffi:swift
npm run test:ffi:kotlin
```

The toolchain is pinned in `rust-toolchain.toml`. Builds use `core/target/`.
