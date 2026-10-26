# RelaySwarm changelog

## Unreleased

- Replace UniFFI with a versioned C ABI, thin JNI Kotlin facade and direct
  C-import Swift facade. Public records, enums, objects and functions retain
  their existing shapes; Android packages no longer require JNA.
- Add experimental `lateHaveRace`, disabled by default. With a zero-budget
  cached race, normal whole HTTP starts immediately while existing accepted
  connections may advertise an exact HAVE within the original deadline.
  Freeze one holder snapshot and run at most one existing peer-only arm;
  FETCH, new connections and withdrawn HAVE do not qualify. HTTP wins,
  progressive exposure and cancellation retain their existing ownership.
  No origin range, discovery request, dial or deadline extension is added.
- Add explicit originless `peerOnly` Rust transfers for the zero-budget cached
  arm. Pending pieces refill after verified calibration; no fast whole-HTTP
  estimate, invented origin lane or ignored origin command can strand them.
  The independent HTTP arm, initial cached identity, hashes, hard deadline and
  existing per-range upload limits remain. Older modules safely decline the
  optional mode without retiring healthy mixed transfers. The failed native
  whole-object fallback control remains recorded; final performance and
  playback qualification use the unchanged acceptance gates.
- Add opt-in `transferWorkerUrl`: warm one explicitly packaged worker from
  the already compiled core, then run the shared Rust schema-3 transfer
  facade off the main thread. Startup, resource limits and genuine worker
  failure retain HTTP; late/cancelled replies cannot credit peer delivery.
  Existing synchronous/native APIs remain compatible. The companion is a
  separate release asset and `relayswarm/transfer-worker` bundler entry.
- Keep multi-holder first-byte and post-first-byte flow measurements per
  connection, separately from HTTP service timing. Substantial ranged HTTP
  loads refresh byte-scaled, rendition-specific origin recovery estimates.
- Allow demand-bound recovery of a pessimistic or stale holder estimate with
  an explicit one-piece probe, at most once per connection every ten seconds.
  Other routes' bandwidth cannot expand that probe. Fresh verified data can
  unlock ordinary bounded requests; unsuccessful later attempts remove the
  allowance to continue useful short-flow delivery. The retained rate still
  needs at least 300 ms and 32 KiB of flow evidence.
- Use a measured lane's own first-byte time before the shared silence fallback.
  Preserve existing native transfer signatures; older WASM modules skip sources
  requiring the optional bounded-probe capability safely.
- Retain the speed-optimised SHA-256 path while keeping the remaining module
  size-optimised. Device playback and net network benefit remain separate
  acceptance gates.
- Republish broadcast rendition playlists when a directory watch reports the
  encoder's playlist rename, keeping the 250 ms interval as the fallback.
  Measured publication delay fell from a 135 ms mean to 6 ms. Closing the
  pipeline during a publication no longer waits for another interval.
- Let allowance operations that queue behind an in-flight write share the
  next durable write. Operations still apply and settle in arrival order, a
  refused operation leaves no trace, cancellation is checked as before, and
  no acceptance, refusal or read is returned before a write it may depend on
  completes; concurrent reservations completed about four times faster in the
  measured profile.
- Reduce hot-path work, measured in [Performance](docs/PERFORMANCE.md):
  - Remember proved Schnorr signatures in both commitment verifiers, keyed by
    the recomputed event hash, public key and signature. The unchanged stream
    event, delegation and revocations are no longer re-proved per segment;
    every other check still runs on every call.
  - Copy a received peer object once across the WebAssembly boundary and
    reserve a commitment-expected receive size once. The link frame format
    is unchanged.
  - Compile the core's SHA-256 at `opt-level = 3`, halving multi-holder piece
    and object hashing time for about 0.7 KB more gzip module.
  - Derive each peer's NIP-44 conversation key once per session.
  - Add `RelayPool` `readyOnFirstRelay`; the installed native client uses it
    so one stalled relay no longer spends its peer deadline, and overlaps the
    DHT bootstrap with Nostr discovery.
  - Receive native objects into one buffer of the trusted size, hashing as
    bytes arrive.
  - Copy and hash origin segments in the loader only when a sampled
    comparison or serving needs them, and cache the core discovery's
    candidate list until a hint or clear changes it.
  - Join identical in-flight commitment requests instead of refusing them at
    the concurrency limit; each joined request is still checked against a
    catalogue and file read after it arrived. Read media playlists
    concurrently, and reuse the previous parse when every playlist is
    byte-identical (never for `EXT-X-SKIP` deltas). Add the
    `commitmentJoins` publisher counter.
  - Make account-allowance validation linear in its bounded state.
  - Serve the demo page assets compressed with ETag revalidation; other
    routes keep `no-store`. Serialise demo relay fan-out frames once.
  - Add `npm run bench:hot-paths` for local before/after comparisons.

## v0.4.4 (24 October 2026)

Prepared experimental library prerelease following
[v0.4.3](https://github.com/forgesworn/relayswarm/releases/tag/v0.4.3).
Sustained physical-device continuity and net network benefit remain open.

- Let eligible already-advertised, framing-2 schema-3 media reach the bounded
  mixed piece planner even when the whole-object peer estimate is late.
  The planner can take a small verified peer fraction and load the remainder
  from origin. Schemas 1/2 retain their whole-object timing check. Integrity,
  sustainable deadlines, origin reserve and the estimator's 300 ms flow floor
  remain unchanged; no Rust/WASM rebuild or wire change is required.
- Require a live same-key FETCH lease from a fresh same-rendition serving
  contributor before waiting for unavailable recorded main-rendition media.
  The exact demanded rendition must explicitly report VOD; live, unknown and
  alternate-audio contexts retain bounded rendezvous coordination. Bare
  serving presence and key rank no longer hold a known-VOD prefetch leader.
- Retain real-WASM regressions and the previous-source failing control.
  Paired with separate website clock/first-frame fixes, a physical Pixel/M4
  candidate passed a bounded 45.5-second original-4K window: 6,553,600 verified
  peer bytes, zero reported post-first-frame stalls and zero dropped frames.
  Earlier longer-window seek/loop interruptions remain recorded; sustained
  continuity and net network benefit remain open.

## v0.4.3 (24 October 2026)

Prepared experimental library prerelease following
[v0.4.2](https://github.com/forgesworn/relayswarm/releases/tag/v0.4.2).
Physical iPhone/iPad and Android/Vanadium continuity, public NAT, sustained
distributed playback and net benefit remain unverified. No service is deployed.

- Add opt-in `sustainablePeerWait`: bound serial peer waits and all extensions
  by each fragment/part's duration minus measured whole-origin recovery with
  a 25% and 100 ms margin. Existing buffer reserves remain in force; the
  independent cached-peer race still runs alongside immediate HTTP.
- Pass only requested range bytes into the WASM upload path when the matching
  core supports it. Previously each small range copied the entire held object
  into WASM before slicing. The peer wire protocol and upload charging remain
  unchanged; older committed cores retain the existing whole-object ABI.
- Retain the historical v0.4.2 failed cached-race CI attempts. Local loader
  regressions establish the new wait bound, not physical-phone playback.

- Make the native cached-peer race fixture wait for framing-2 presence from
  the accepted peer as well as its cached-object advertisement. A controlled
  delayed heartbeat proves that a connected channel with HAVE is insufficient.
  Retain failing-load traces and eligibility diagnostics in CI receipts.

## v0.4.2 (24 October 2026)

Experimental library prerelease following [v0.4.1](https://github.com/forgesworn/relayswarm/releases/tag/v0.4.1).
No service is deployed; R70 distributed retention, TURN renewal, physical-device,
public-NAT and sustained acceptance remain open. See [Status](docs/STATUS.md).

- Let uploads arriving during a changed-ticket admission check join its bounded
  online decision before spending allowance or sending media. Previously the
  remembered old ticket could cause the live link to close. Rejection, timeout,
  stop and channel closure still prevent delivery; later uploads check online again.
- Expose accepted peer identities and connection references through
  `peerConnectionDetails()` so observers can distinguish retention from replacement.
- Retain a native Chrome/WASM ticket-renewal receipt in CI. Three rotations on
  both sides retain the exact connection while delivering four verified 256 KiB
  objects; later revocation sends zero peer bytes. This is synthetic loopback
  protocol evidence, not distributed field acceptance.
- Exclude local native real-time build output from the JavaScript tarball.

## v0.4.1 (24 October 2026)

Experimental library prerelease following [v0.4.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.4.0).
No service is deployed; physical-device, public-NAT and distributed field
acceptance remain open. See [Status](docs/STATUS.md).

- Preserve the measured per-load HTTP recovery reserve when a multi-holder
  deadline moves unfinished pieces to origin. Retain bounded, URL-free range
  outcome counters so aborts, timeouts and incorrect response sizes are distinct.
- Add opt-in `zeroBudgetPeerRace`: start the normal HTTP request immediately
  and race only an already advertised cached schema-3 object. Only a complete
  verified winner reaches the player; stopping the swarm leaves pending HTTP
  running, while loader cancellation stops both arms. Defaults are unchanged.
- Retain a native Chrome cached-race receipt in CI, proving both winners and
  reuse of the same connection with synthetic protocol data on loopback.
- Apply accepted-contributor holder recovery to both normal peer-first loads
  and cached races; all-origin and unsuccessful peer work remain neutral.

## v0.4.0 (24 October 2026)

The old JavaScript field qualifier R70 passed 15 of 16 gates at `20693ea`;
in-place link renewal failed. This integration with the current core is not
field-qualified. High-quality delivery margin and sustained acceptance remain
open. See [Status](docs/STATUS.md).

- Count a linked holder that was asked for a segment and did not deliver it in
  time as a miss. Previously a holder whose HAVE held the key was treated as
  ahead and cleared, so one that was ahead but too slow was never stale and kept
  neighbour discovery off. Each single-holder load is decided once, when it ends. A verified delivery clears only the link it came from. A load that goes
  to origin charges only the links that were judged: those that were asked and
  did not deliver in time, and at `peerNoFit` those whose own estimate did not
  fit. Declines made on swarm-wide estimates or the buffer charge no holder, and
  every serving link takes a miss only when no link held the key. A stale link's
  HAVE no longer keeps a context met or the link protected as a victim. Loader
  aborts, `stop()`, commitment failures and integrity failures record nothing
  against the link concerned. The thresholds (four misses on distinct segments
  over at least ten seconds) are unchanged.
- Let a spent replacement re-arm once, at most every twenty seconds per context,
  when no verified peer delivery has happened since it was spent and every link
  serving that rendition is stale or none serves it. The 15-second discovery
  window, one attempt at a time, the eviction cooldown, `maxPeers` and ticket
  gating are unchanged. The interval is an internal constant, not an option.
- Add local diagnostics: `neighbourDiscovery.counters.heldMiss` and `rearmed`,
  `neighbourDiscovery.replacementRearmMs`, and `heldMissHolders` on the
  eligibility rows that carry holder labels. They sit in the local snapshot and
  are not part of the numeric operator report.
- Give a linked holder that holds the demanded key but has never been asked one
  request when the viewer's shared projection is late. One slow holder's partial
  transfers set the projected rate for every link, so a later holder could be
  declined unasked. Only when some link held the key at entry, the room exceeds
  the median first byte and the holder is open, free, unbanned and not stale. At
  most one trial per load and per link; the pre-request checks, abandonment and
  held-miss charging apply as before. There is no completion-rate condition,
  because a receiver whose only evidence is partial transfers has no completed
  transfer to measure. This is one chance, not a promise that the segment fits.
- Order rotation victims by tier before idle time: a non-serving remote that is
  not a consumer, then a serving remote, then a non-serving remote that announced
  a rendition this serving viewer plays. This is an ordering of links rotation
  could already drop, not an exemption, so a consumer link is still dropped when
  it is the only eligible one. Rotation cadence, `minLinkLifeMs`, `idleEvictMs`,
  `evictionCooldownMs` and the wire messages are unchanged.
- Add local diagnostics: `segments.peerUntestedTrial` and
  `peerUntestedTrialLoaded`, `peers.evictedUnhelpful`, `evictedServing` and
  `evictedConsumer`, `neighbourDiscovery.counters.victimUnhelpful`,
  `victimServing`, `victimConsumer`, `unmetNoHint` and `unmetIneligible`, and
  `trial: true` on the eligibility row of a granted trial. They sit in the local
  snapshot and are not part of the numeric operator report.
- The late-arrival projection, deadlines, abandonment, bounded peer work,
  admission and HTTP fallback are unchanged.

- Expose accepted native connections with `peerConnections()` and attribute
  first-verified accepted media through `onPeerDelivery`, including multi-holder
  contributions. Wire/control traffic and unsuccessful media receive no credit.
- Preserve partially verified scheduler progress when origin has reserved the
  tail, and keep reliable channels alive while cancelled responses drain.
- Start a reconnecting pool on its first healthy relay and replay only current
  presence to later relays; pending sockets and retries retain bounded ownership.
- Carry the holder re-arm state, trial selection and diagnostics through Rust,
  WASM and generated native bindings. Keep the existing framing and signed-media
  schemas; update the matching binary and bindings together.
- Include the native real-time source integration added after v0.3.0, with
  guarded backend preparation and bounded TURN teardown. Native core packages
  do not provide that separate WebRTC transport.

## v0.3.0 (24 October 2026)

Experimental shared-core release. JavaScript/WASM, Apple and Android downloads
have source metadata and checksum manifests. The native package retains its
local-path Swift dependency; RelaySwarmKit adoption and field acceptance remain
open. Session wire version 3 and metrics version 2 are unchanged.

- Add opt-in advisory peer supply hints through Rust, WASM, the browser loader
  and UniFFI; report known HAVE supply without forcing player quality.
- Report receipt rendition-switch costs and holder observations in the trace
  reporter, and pin deadline and gated-viewer test ordering.
- Measure signature verification size and Chrome call cost; keep core
  verification, with no production verifier switch.
- Add tag-gated native release packaging, actual SwiftPM checksums and exact
  source/hash verification, plus a reproducible JavaScript/WASM asset builder.
- Exclude native build directories from JavaScript package tarballs.


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
- Under `multiHolder`, a holder whose first request proves it fast takes
  back pieces origin has not yet delivered, as many as it can finish before
  origin is projected to, leaving busy holders their share; the first
  verified copy wins and origin's request keeps running. Before, untested
  holders got one trial piece each and origin the rest in one request, and
  nothing moved that work back: over RelaySwarmKit's data channels, with
  8 MB and origin at 300 bytes per ms, 60 of 62 pieces came from origin in
  27.9 s against a 10 s deadline. `core.multiHolder.peerBytes` and
  `originBytes` now count the bytes each source was first to verify, and the
  new `unusedBytes` counts received bytes that verified nothing new.
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
