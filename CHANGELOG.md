# RelaySwarm changelog

## Unreleased

The 0.2.0 candidate remains unreleased pending final CI and acceptance.

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

## 0.2.0 source candidate — broadcaster work on 12 October 2026

This source work has not yet been published as a release.
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
