# Global instructions

## Rust builds

Rust builds reuse the worktree's own `target/`. Never create a fresh
`CARGO_TARGET_DIR` per task or subagent. Do not override `CARGO_INCREMENTAL=0`.

## Clean up after your own work

Disk and RAM are nearly full. Remove only task-created resources once work is
safely merged and its evidence is retained. Remove clean, fully pushed merged
worktrees with `git worktree remove` and `git worktree prune`, never `rm -rf`.
Delete task-owned scratch/tarballs after recording results; retain named release
evidence. Stop own emulators and delete own AVDs, fixture/services processes and
long-running servers even after failure. Preserve unrelated/pre-existing resources.
Report anything intentionally left running and why.

# RelaySwarm

Nostr-rendezvoused, hash-verified peer transfer for HLS video: browsers use
WebRTC signalled over Nostr relays instead of a dedicated tracker, and a
separate native path uses HyperDHT and Noise for installed Node applications.
This is a proof of concept, not a production engine; several features
described in the README (advanced multi-peer/ABR scheduling and a NIP draft)
remain out of scope. The browser loader supports shadow measurement and a
bounded peer-first mode using author-signed segment commitments.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm ci` | Install dependencies |
| `npm run check` | Syntax check (`scripts/check-syntax.mjs`) |
| `npm test` | End-to-end PoC + fan-out, against live Nostr relays |
| `npm run poc` | Two-peer WebRTC PoC (`poc.mjs`) |
| `npm run poc:native` | Two-peer native HyperDHT PoC (`native-poc.mjs`) |
| `npm run test:native` | Native path tests, local relay + local DHT bootstrap |
| `npm run test:swarm` | `src/browser/hls-swarm.mjs` unit tests |
| `npm run test:swarm:core` | Loader hardening suite with peer-first fixtures on the Rust core |
| `npm run test:browser` | hls.js browser test (`--mode shadow` or `--mode peer-first`) |
| `npm run test:publisher` | Publisher context/range and demo HTTP/relay tests |
| `npm run test:operator` | Chrome upload allowance, remote policy and opt-in reports |
| `npm run broadcast:install` | Install platform-pinned MediaMTX test dependency |
| `npm run broadcast` | Supervised live ingest, persistent publisher and optional RTMPS |
| `npm run test:broadcast` | Real ingest/forward recovery and guard tests |
| `npm run test:broadcast:browser` | Real-time two-rendition Chrome playback/reconnect |
| `npm run test:playback` | Two-rendition Chrome playback and field-test demo regression |
| `npm run demo` | Local publisher/player, synthetic live media unless `--media-dir` supplied |
| `npm run audit` | `npm audit --audit-level=high` |
| `npm run test:proto` | Check committed shared vectors against the JavaScript verifier |
| `npm run proto:vectors` | Regenerate `core/vectors/commitments.json` (new signatures each run) |
| `npm run proto:traces` | Write seeded selection/discovery sequences for the Rust tests (`core/target/`) |
| `cargo test` (in `core/`) | Rust core tests, including the shared vectors and traces |
| `npm run core:wasm` | Rebuild `src/browser/relayswarm-core.wasm` from `core/` (paths remapped) |
| `npm run check:docs` | Links, AI-index format and generated-context freshness |
| `npm run docs:generate` | Regenerate `llms-full.txt` from maintained Markdown |

Node 22.13+ is required (the global `WebSocket`); CI runs on Node 24. `npm test`
and `npm run poc` need an internet connection: they signal against real
public Nostr relays and exit non-zero if a transfer fails hash verification.
The native tests do not need the network; they bootstrap a local DHT.

## Structure

```
src/relay-session.mjs          RelayPool, RelaySwarmSession, ticket validation (main export)
src/browser/hls-swarm.mjs      hls.js shadow and peer-first integration (./hls-swarm export)
src/browser/segment-commitment.mjs  experimental signed media commitment contract
src/browser/core-wasm.mjs      loader for the Rust core (relayswarm-core.wasm, committed): verifier, selection
src/browser/core-peer-link.mjs PeerLink with its protocol in the Rust core
src/browser/core-discovery.mjs NeighbourDiscovery with its state in the Rust core
src/browser/peer-link.mjs      browser WebRTC peer link
src/hls-publisher.mjs          Node-only local HLS publisher and signed commitments
demo/                         runnable publisher/player with consent and local receipts
src/native-journey.mjs         native HyperDHT transfer orchestration
src/native-dht-transport.mjs   NativeDhtTransport, HyperDHT wiring
src/object-transfer.mjs        framing, hashing and object transfer primitives
poc.mjs                        two-peer WebRTC proof of concept (CLI)
native-poc.mjs                 two-peer native HyperDHT proof of concept (CLI)
core/relayswarm-proto/         Rust port: commitments, peer-link protocol, selection, discovery (no I/O)
core/vectors/                  JavaScript-generated vectors and link traces both suites check
test/                          e2e and unit tests
spikes/                        throwaway measurement code, see spikes/RESULTS.md
docs/                          NATIVE-TRANSPORT.md, THREAT-MODEL.md, LANDSCAPE.md, FAQ.md
```

## Conventions

- British English in prose and comments.
- Plain, factual claims only: state what is measured or proved, not what is
  planned; the README's "Deliberately out of scope" section lists what the
  PoC does not do.
- The original WebRTC PoC signs but does not encrypt SDP. The separate browser
  loader uses pairwise NIP-44 signalling, and the native path uses NIP-44 dial
  authorisation. Preserve this distinction in claims about encryption.

## Key Files

| File | Purpose |
|------|---------|
| `poc.mjs` | Browser-path PoC entry point |
| `native-poc.mjs` | Native-path PoC entry point |
| `INTEGRATION.md` | Host-page contract, options and kill switch for `hls-swarm.mjs` |
| `docs/NATIVE-TRANSPORT.md` | Native path protocol and security boundary |
| `docs/THREAT-MODEL.md` | Threat model the deliverable engine is tested against |
| `spikes/RESULTS.md` | Full results for the feasibility spikes |
| `docs/FIELD-TEST.md` | Demo, HTTPS configuration, receipt scope and unverified field gates |
| `docs/README.md` | Documentation navigation |
| `docs/GETTING-STARTED.md` | Exact release assets, pinned Git install and demo prerequisites |
| `docs/API.md` | Package exports and publisher/session/native API reference |
| `docs/STATUS.md` | Dated release evidence and remaining acceptance gates |
| `llms.txt`, `llms-full.txt` | Curated public AI index and generated documentation context |
| `docs/MAINTAINING-DOCS.md` | Documentation generation, validation and publication |

## Common Pitfalls

- `npm test` hits live public relays; a red run can mean relay weather, not
  a code fault. Re-run before concluding anything.
- v0.2.1 is the published experimental GitHub prerelease (v0.2.0 before it).
  Confirm a release exists before referring to its assets.
  The npm registry is unpublished; use the exact asset or pinned commit from
  `docs/GETTING-STARTED.md`. Do not move any release tag or replace its artifacts
  when correcting main-branch documentation.
- Do not present the original WebRTC PoC's signalling as encrypted.
- The demo keeps its author key on the server and receipts in the browser.
  Preserve playlist-bound signing and explicit upload consent. Chrome fixture
  tests are loopback; do not describe them as physical-device/NAT validation.
- The Rust core under `core/` is unreleased. Its commitment verifier, peer
  selection, discovery and peer link are used only when a host passes `coreWasm`; the
  demo does. Rebuild and commit `src/browser/relayswarm-core.wasm` with
  `npm run core:wasm` after any change under `core/` that affects
  verification, selection, discovery or links. A change to `peer-link.mjs` needs the
  same change in `core/relayswarm-proto/src/link.rs`, regenerated traces and
  `npm run test:proto` and `npm run test:swarm:core`; a change to
  `peer-selection.mjs` or `neighbour-discovery.mjs` needs the same change in
  `selection.rs` or `discovery.rs` and both commands.
  It must match the JavaScript verifier on every vector; change the JavaScript,
  regenerate the vectors, then make Rust agree. Its toolchain is pinned in
  `core/rust-toolchain.toml`; reuse `core/target/`.
- Package version 0.2.1, session wire version 3, commitment schemas 1/2 and metrics
  version 2 are distinct. Published RelaySwarmKit v0.5.0 supports wire version 3
  and signed media; current SDK/browser interoperability is measured on macOS
  arm64 loopback. Physical Apple devices and public-NAT interop remain unproved.
- Update authored Markdown and `llms.txt`, then run `npm run docs:generate`
  and `npm run check:docs`. Do not hand-edit generated `llms-full.txt`.
- Keep AI material factual: published links do not prove search indexing or
  recommendations. The public surface is GitHub, not a configured docs website.
- Broadcaster/production additions are in v0.2.0 and later and absent from v0.1.0
  assets.
  Live-source sequence numbers continue across published generations; the
  attempt counter is distinct from visible HLS discontinuity.
- Private publisher state and tokens require POSIX file permissions. Permanent
  publication/worker leases supervise parent-crash recovery; a dirty guardian
  marker or legacy lock requires operator inspection. Never delete lease inodes.
