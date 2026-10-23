# RelaySwarm changelog

## Unreleased

- Add `core/relayswarm-proto`, a Rust port of signed segment commitment,
  scoped delegation and revocation verification (schemas 1 and 2; schema 3
  below). It performs no I/O and builds for WebAssembly. The browser loader
  uses it only with `coreWasm` (below); the native path does not use it.
- Add 120 shared vectors generated from the JavaScript verifier
  (`core/vectors/commitments.json`). The Rust and JavaScript test suites both
  check them, and a new CI job runs both with the Rust lint and WebAssembly
  build.
- Port the browser data-channel protocol (`peer-link.mjs`) to
  `relayswarm_proto::link`, a state machine with no I/O. 48 traces recorded
  from the real `PeerLink` check its events and state step by step.
- Port peer selection and neighbour discovery to `relayswarm_proto::selection`
  and `relayswarm_proto::discovery`. Seeded random and scripted operation
  sequences from the JavaScript check every output and state after each step.
- Add the opt-in `coreWasm` loader option: peer-first viewers verify segment
  commitments with the Rust core compiled to WebAssembly
  (`src/browser/relayswarm-core.wasm`, then 200,458 bytes, 87,373 gzip). The
  JavaScript verifier decides until it loads, and for the rest of the session
  if it fails to load or traps. A new metrics field, `core`, reports which
  verifier decided. The demo serves the module, uses it, and allows
  `'wasm-unsafe-eval'` in its Content Security Policy.
- With `coreWasm`, peer selection also runs in the Rust core: each swarm
  binds it when the module loads, provided no peer has been chosen yet. A
  trap anywhere in the module hands both selection and verification to
  JavaScript, and selection starts again without link history. The module is
  now 227,541 bytes (94,900 gzip). `core.selection` in the metrics reports
  which one chooses peers.
- With `coreWasm`, links opened once the module is ready run the peer link
  protocol in the Rust core (`src/browser/core-peer-link.mjs` keeps the
  channel, timer and callbacks). All 48 committed link traces match through
  the module. A trap closes the links it ran, and later links are
  JavaScript. `core.links` counts links of each kind. The module is now
  274,837 bytes (112,644 gzip). `npm run test:swarm:core` runs the loader
  hardening suite with every peer-first fixture on the module.
- With `coreWasm`, neighbour discovery also runs in the Rust core
  (`src/browser/core-discovery.mjs` keeps one object per context, window
  and attempt, as the swarm compares them by identity). Each swarm binds it
  when the module loads, provided discovery holds no context, hint or window
  yet. The seeded and scripted discovery sequences match through the module.
  A trap hands discovery to a fresh JavaScript instance that keeps the
  counters. `core.discovery` in the metrics reports which one runs. The
  module is now 315,803 bytes (122,029 gzip).
- With `coreWasm`, the relay session starts once the module has loaded or
  failed, waiting at most 2 seconds; the relay connection opens meanwhile.
  Fragments loaded during the wait go to origin and leave discovery empty, so
  discovery, selection and links start in the module. One CI viewer had
  kept discovery in JavaScript after hints arrived before the module loaded.
- Experimental commitment schema 3 (`relayswarm-segment-v3`): schema 2 plus
  `pieceSize` and one SHA-256 per piece, at most 64 pieces. Both verifiers
  accept it and `commitmentPieceSize` is exported; 19 new shared vectors
  (139 in all).
- Add piece-range requests (framing 2, `"p"` on `want` and `meta`) to the
  Rust link, and `relayswarm_proto::scheduler`, which plans one schema 3
  object across up to three holders with origin for a late tail and runs the
  transfer with per-piece verification. The loader uses both only with
  `multiHolder` (below); the holder and lookahead defaults are provisional.
- Add the publisher option `pieceCommitments` and the demo flag
  `--piece-commitments` (both off by default): exact-playlist contexts are
  signed as schema 3 instead of schema 2, with piece digests from the same
  read pass. Schema 3 replaces schema 2 rather than being published beside
  it, so v0.2.1 and RelaySwarmKit v0.5.0 receivers load those segments from
  origin.
- Add the experimental loader option `multiHolder` (with `coreWasm`): a
  schema 3 segment comes from up to `maxHoldersPerObject` framing 2 holders
  at once by piece range, run by the core's scheduler, with ranged HTTP
  fetches from origin for a late tail and for pieces still outstanding at
  the deadline. Presence carries `obj: 2` only while every link runs in the
  core. Off by default. A ranged upload is charged against upload allowances
  and `reserveUploadBytes` by the bytes it sends, not the whole segment.
- Under `multiHolder`, abandon a silent or too-slow holder early, by the
  single-holder rules, and move its pieces, instead of waiting for the
  deadline; counted as `core.multiHolder.abandoned`. Unlike the single-holder
  path, a flow that stops after its first byte is also rechecked every 250 ms.
- Under `multiHolder`, load ranged origin pieces through the player's own
  fragment loader, so headers and credentials from `xhrSetup`, `fetchSetup`
  or a custom loader apply; a body that is not exactly the range is discarded.
- Under `multiHolder`, stop asking an origin for ranges once it has answered
  one with something else, and send its later segments down the
  single-holder path for the session; counted as
  `core.multiHolder.originRangesIgnored`. A loader downloads the whole body
  before the length check can reject it, and a failed origin piece fails the
  transfer, so without this every such segment came from origin twice.
  Cloudflare Stream answered a probe for a segment range with the whole
  segment (200); Apple's, Mux's and Unified Streaming's test streams
  answered 206.
- Add the loader option `traceRequests` (off by default) and `trace()`: a
  bounded ring of loads, eligibility decisions, peer and origin requests and
  every multi-holder scheduler call with its inputs and commands. A test
  replays a recorded transfer through the module and gets the same commands.
  The Chrome harness takes `--trace N` and stores each viewer's trace.
- Add `scripts/trace-report.mjs`, which replays saved traces against the
  module and summarises holder use, origin share, request timing and buffer
  ahead, with an optional what-if over other holder limits (an estimate that
  ignores shared uplinks).
- Document commitment schema 3, object framing 2 and the presence `obj`
  field in `docs/NIP-DRAFT.md`.
- The demo player takes `multiHolder=1` and `trace=N` page URL parameters
  and keeps the latest scheduler traces in its receipt, which
  `scripts/trace-report.mjs` reads.
- `abrIgnorePeers` (off by default) keeps peer-delivered fragments out of the
  hls.js bandwidth and first-byte estimates; without it the time a peer
  delivery took, holder waits included, is sampled as origin throughput. The
  demo takes it as `abrIgnorePeers=1`, and its receipt records hls.js's
  bandwidth estimate with each fragment.
- The Rust verifier now rejects a commitment whose content omits `part`, as
  the JavaScript one does (a new shared vector, 140 in all). Under
  `multiHolder`, an untested holder is planned with the shared first-byte
  time rather than none, origin stays live once peers verify its pieces,
  requests stopped because the segment is done or another holder won count
  as aborts rather than abandonments, and a closed link's last result no
  longer leaves an entry in the core's peer selection.
- Add `core/relayswarm-ffi`, a UniFFI facade over the Rust core for Swift and
  Kotlin: the commitment verifiers (JSON in and out), the schema 3 piece
  helpers, the multi-holder transfer scheduler, the peer link protocol, peer
  selection and neighbour discovery. `npm run test:ffi:swift` and
  `npm run test:ffi:kotlin` check all 140 vectors, all 48 recorded link
  traces, a transfer, a piece range exchange and the seeded selection and
  discovery sequences through generated bindings, and CI runs both.
  `npm run build:ffi:apple` packages it as a Swift package with an
  arm64 XCFramework for iPhone, the iOS simulator and macOS (iOS 16, macOS 14);
  `npm run test:ffi:apple` runs the same checks against the package on macOS
  and in an iPhone simulator, and links it for iPhone. RelaySwarmKit does not
  use it yet. `npm run build:ffi:android` packages it as an Android library
  (AAR) for arm64-v8a, armeabi-v7a and x86_64, API 26 and later;
  `npm run test:ffi:android` builds an app against it with the Android Gradle
  plugin, and the same checks pass on an API 35 arm64 emulator.

## v0.2.1 (21 October 2026)

Experimental [GitHub prerelease](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.1) of the source from
[PR 9](https://github.com/forgesworn/relayswarm/pull/9), following v0.2.0. Field
acceptance remains open: the sustained 7,200 s run, the 3 MB both-quality
shared-cap lifecycle and Safari 17.6 desktop are RED, and physical-device,
difficult-network and downloaded-release gates have not passed. The prerelease
was published by owner decision with those open. See
[Status](docs/STATUS.md).

- Add local holder labels to the peer diagnostics. Labels are session-local
  counters, not keys, and are for local diagnostics only.
- Stop a linked holder that is never ahead from suppressing neighbour
  discovery, so such a holder is no longer treated as enough; bounded peer work,
  deadlines and HTTP fallback are unchanged.
- Field results on this source (21 October 2026, desktop and relay-only scope):
  the fourteen-role short qualifier passed 16 of 16 gates for the first time,
  and Firefox 152.0.6 and Safari 26.6.2 desktop journeys passed. The sustained
  7,200 s run and the 3 MB both-quality shared-cap lifecycle are RED and open,
  and Safari 17.6 desktop is RED. Physical devices, hard NAT and a separate
  network are not tested. See [Status](docs/STATUS.md#current-delivery-checkpoint).

## v0.2.0 (21 October 2026)

Experimental [GitHub prerelease](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.0) adding the supervised
broadcaster and production feature work to v0.1.0. Field acceptance remains
open: the fourteen-role qualifier is RED (R65 passed 14 of 16 gates), and the
sustained, natural-expiry, physical-device, difficult-network, measured-benefit
and downloaded-release gates have not passed. The pilot runs `5f2ece0`; this
release also includes the later loader clock-skew diagnostics. See
[Status](docs/STATUS.md).

- Report swarm events rejected by the age window, and the age of recent live
  signals, in `signalling.clock`, with an origin `Date` offset estimate
  (`clock.origin`) and `relays.sinceDropped` / `relays.rejectedTimestamp`
  counters (additive within metrics version 2). Local counts only;
  acceptance rules and wire format are unchanged.
- Set app and waiting-listener HTTP keep-alive to 130 seconds so Caddy's
  default 120-second upstream pool retires them first. The 128-connection cap
  and ten-second request/header deadlines remain. A real 121-second regression
  verifies original-socket reuse, exact replies and prompt close/handover;
  distributed repair remains unproved.
- Negotiate a coherent policy/public-session response so the example player
  needs one renewal GET instead of two. Legacy servers retain parallel reads;
  malformed advertised snapshots fail closed. Expiry, early OFF, admission
  and consent rules remain unchanged; field repair is unproved.
- Discover bounded rendition neighbours when existing peer slots do not offer
  the current media context, using signed advisory presence and existing peer,
  admission, consent and retry limits.
- Preserve useful time for a cold peer attempt instead of equally dividing its
  deadline across unmeasured alternatives. Total deadlines, measured-peer
  allocation, verification and fallback remain unchanged.
- Expose the broadcaster's existing per-socket-address request allowance through
  `--admission-per-address-requests` (1–10,000, default 600). Other admission
  limits remain unchanged; field acceptance is separate.
- Reclaim settled TURN viewer entries after their credential cache expires or
  initial issuance fails. Fresh credentials and unresolved issuance keep their
  slots; the viewer, request, issuer and rate limits remain unchanged.
- Retain renewed admission tickets while peer retry or connection limits delay
  their next validation, without replacing a newer pending ticket when older
  work settles.
- Measure account authority against the signed issuer lifetime and conservative
  elapsed time, so small device/server clock differences do not reject a valid
  challenge. Keep the original grant/delegation limits, rollback revocation and
  server proof checks; issue all challenge timestamps from one clock sample.
- Add an explicit Resume playback action to rebuild suspended media from the
  origin, preserve errors/spend and require fresh Apply/upload consent before
  peer contribution. Explain disabled reporting when the server has it off.
- Retain an abandoned response on known ordered, reliable peer channels only
  until its validated response boundary or the existing drain timeout. Origin
  fallback stays prompt; late payload is discarded before connection reuse.
  Wire framing, playback deadlines and signed media verification are unchanged.
- Add redacted TURN lease provenance and conservative monotonic response timing
  for lifecycle measurement, retaining cached leases without moving their
  anchors. A passive debug getter exposes only epoch, ordinal and timestamp;
  it does not check or grant credential freshness.

- Add optional `issued`/`tls-tcp` TURN URL projection to the demo and broadcaster
  credential adapter. Explicit secure TCP is retained; only transport-unspecified
  secure URLs gain a TCP selection. Raw leases, expiry and upload consent remain
  bounded. This is configuration support, not selected-path or field proof.
- Add explicit `all`/`relay` ICE transport policy to the swarm, demo and
  broadcaster, defaulting to `all`. Relay-only does not force TLS or establish
  a delivery repair; changed demo policy requires fresh viewer Apply and consent.
- Refuse redundant stop IPC after a broadcaster worker's first force request
  or drain witness, preserving its original cleanup proof and deadlines.
- Expose the broadcaster's per-socket-address admission ticket limit through
  `--admission-per-address-tickets` (1–120, default 12), without changing other
  admission limits or establishing multi-viewer acceptance.
- Keep a live process-group wrapper for broadcaster worker shutdown, using its
  original private IPC channel instead of signalling a reaped leader's numeric
  PID. Preserve output, inner exit status and the existing dirty recovery fence.
- Added complete live-playlist blocking reload across compatible renditions,
  with bounded waits, disconnect/shutdown cleanup, directory replacement
  revalidation and snapshot-consistent HEAD/range responses.
- Filter unrelated named file events from playlist reload watches while retaining
  authorisation coverage, directory replacement checks and bounded revalidation.
- Reuse the pending browser connection when simultaneous offers require it to
  yield, with fresh admission checks, fenced callbacks and its original dial
  deadline. Native browser and Internet qualification remain separate gates.

- Added an optional durable account upload allowance supporting Nostr sign-in,
  host website accounts, explicit linking and short-lived page authority.
  Account actions preserve cumulative charges and require fresh upload consent.
- Added bounded numeric peer-eligibility observations to distinguish deadline
  and availability decisions without changing peer selection or its budgets.
  Records retain the original buffer geometry; the broadcast fixture observes
  existing request timings with explicit pending and missing measurements.
- Separated in-flight upload quota from accepted-upload metrics so a pending
  or refused host reservation cannot be archived as an uploaded payload.

- Added fresh live-media coordination, measured fallback reserves and actual
  fMP4/adaptive, audio, AES-128, mixed-codec and low-latency-part journeys.
- Added exact schema 2 media commitments, scoped signing delegation/revocation
  and linked signed NIP-53 advertisements without changing stable authorisation.
- Added bounded admission, persistent cross-tab upload budgets, idempotent
  durable reports and two-lease worker supervision with tested crash cleanup.
- Added an installed native client with verified HTTP fallback, acknowledged
  connection readiness and an absolute completion deadline. Native presence
  discovery accepts valid cached announcements without widening signal replay.
- Upgraded and published RelaySwarmKit v0.5.0; its public SDK passes author,
  delegate, corruption and revocation journeys against the actual browser sender.
- Added one bounded origin-only media repair, cancellation and timeout handling;
  fatal records and spent upload allowance remain in the receipt.
- Fixed Windows hash-cache deduplication, malformed relay-filter crashes,
  discovery eviction, worker descendant cleanup and pending-write queue bounds.
- Fixed expired host callbacks leaving HTTP requests outstanding, and added
  bounded native discovery when relays replay no ephemeral presence history.
- Reproduced and repaired a nonfatal live-playback stall after an interrupted
  quality switch and a new media continuity. A fresh live window and ten
  seconds without decoded-frame progress permit the existing single origin
  repair; cancellation, allowance usage and original errors remain preserved.
- Made playback checks prove each rendition's peer delivery before seeking,
  and added physical iPhone targeting and scoped Safari-window focus to the
  acceptance harness.
- Added bounded numeric control-request diagnostics, private STUN/TURN browser
  configuration and failed-TLS-startup cleanup.
- Fixed demo, broadcaster and probe commands silently doing nothing when
  launched through an absolute filesystem alias. Imports still leave their
  commands stopped.
- Fixed the single VOD repair repeating a video-only prefix after a later
  fragment introduced audio. It waits for media reattachment before resuming
  at the validated failing fragment; original errors and allowance remain.
- Made container public code readable and directories traversable when a build
  context uses private modes, while retaining private state permissions.

### Earlier 0.2.0 broadcaster work (12 October 2026)

The earlier intermittent hosted MSE failure and physical-device, separate-network,
sustained-operation and external-platform acceptance remain open.

- Added a supervised H.264/AAC broadcast bridge with two HLS renditions,
  continuous sequence numbers, source recovery and independent RTMPS forwarding.
- Added private persistent publisher identity, bounded hash/signature caches,
  cumulative viewer media upload allowances and measured peer selection.
- Added authenticated operator status/policy and explicitly opted-in bounded
  numeric reporting; fixed cancelled HTTP media response cleanup.
- Added a host-scoped trusted Nostr stream adapter and an isolated container
  pilot package, with real transport/browser checks and documented acceptance gaps.
- Included the broadcaster/demo runtime dependencies in production installs and
  excluded local IDE metadata and private state from the package.
- Refreshed the documentation for the GitHub distribution and measured
  browser/native capabilities; separated planned work and historical observations.
- Added a documentation index, getting-started guide, module API reference and
  release evidence/status page.
- Reworked `llms.txt` with direct public Markdown links, added generated
  `llms-full.txt`, and added documentation freshness/link checks.
- Corrected RelaySwarmKit compatibility, phone validation, network-policy and
  measurement-cost claims; normalised repository metadata and discovery keywords.

## v0.1.0 — 12 October 2026

First [experimental GitHub release](https://github.com/forgesworn/relayswarm/releases/tag/v0.1.0),
commit `3e480e19dfe4d675f14bcb2968f3dc4926fbca25`.

- Original Nostr-signalled WebRTC CLI and separate native HyperDHT/Noise journey.
- Browser shadow and bounded peer-first HLS loading with author-signed commitments.
- Admission, connection/transfer bounds, consent defaults, rotation/referrals,
  lifecycle hardening and restored loader statistics/abort semantics.
- Local HLS publisher/player with exact-context signing, upload controls,
  origin-only kill switch, local receipts and controlled HTTPS trial configuration.
- Real Chrome regressions, native OS matrix, public-relay tests and an optional
  twelve-viewer soak; [evidence and remaining work](docs/STATUS.md).
- Installable package tarball, standalone browser ESM bundle and checksums.

The npm registry remains unpublished. This release is a proof of concept.
