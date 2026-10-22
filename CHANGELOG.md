# RelaySwarm changelog

## Unreleased

- Add `core/relayswarm-proto`, a Rust port of signed segment commitment,
  scoped delegation and revocation verification (schemas 1 and 2). It performs
  no I/O and builds for WebAssembly. It is not used by the browser loader or
  the native path yet.
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
  (`src/browser/relayswarm-core.wasm`, 200,458 bytes, 87,373 gzip). The
  JavaScript verifier decides until it loads, and for the rest of the session
  if it fails to load or traps. A new metrics field, `core`, reports which
  verifier decided. The demo serves the module, uses it, and allows
  `'wasm-unsafe-eval'` in its Content Security Policy.

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
