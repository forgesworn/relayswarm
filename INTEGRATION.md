# Integrating the hls.js swarm in a host page

[Documentation](docs/README.md) · [Installation](docs/GETTING-STARTED.md) ·
[API reference](docs/API.md) · [Release evidence](docs/STATUS.md)

`src/browser/hls-swarm.mjs` adds peer-assisted delivery to an hls.js player.
In **shadow mode** it changes nothing the viewer sees: every fragment still
comes from the origin, and the swarm only measures what peer delivery would
have achieved. That is the mode to deploy first.

The module is browser ESM with a direct runtime dependency on `nostr-tools`.
The published [v0.2.1 GitHub prerelease](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.1)
supplies an installable tarball and a standalone bundle containing the browser
runtime dependencies. The host supplies hls.js. The npm registry is unpublished;
[Getting started](docs/GETTING-STARTED.md) gives exact asset and pinned-Git commands.
v0.2.1 adds the
[production feature work](docs/PRODUCTION-FEATURES.md); those additions are
absent from v0.1.0 assets and retain separate delivery/acceptance gates.

The host selects a trusted stream event, shared swarm id, relay policy and ICE
servers. This module does not perform Nostr stream discovery or automatically
extract relay/STUN policy from a kind-30311 event.

## Attaching

This host-page snippet assumes the application provides `eventId`,
`manifestUrl` and the `video` element. Replace the example relay with your own
tested endpoint. The metrics callback below logs locally; the library does not
submit analytics automatically.

```js
import Hls from "hls.js";
import { createHlsSwarm } from "relayswarm/hls-swarm";

const swarm = createHlsSwarm({
  swarmId: `stage-${eventId}`,        // same string for every viewer of one stream
  relays: ["wss://relay.example"],     // 1-8; the deployment's own relay first
  mode: "shadow",                      // "shadow" | "peer-first" | "off"
  originFallbackMs: 1500,              // "in time" means within this of the load starting
  shadowSampleRate: 0.25,              // race this share of fragments (see Cost)
  onMetrics: (metrics) => console.log(metrics),
});

const hls = new Hls();
swarm.attach(hls);                     // attach BEFORE loadSource
hls.loadSource(manifestUrl);
hls.attachMedia(video);

// later, or when the kill switch says off
swarm.stop();
```

An invalid supported configuration or unsupported browser yields a swarm
whose `metrics().mode` is `"off"` and whose `metrics().disabledReason` says
why (`invalid-swarm-id`, `invalid-relays`, `invalid-mode`, `mode-off`,
`invalid-stream-authorisation`, `missing-commitment-provider`, `invalid-limits`, `no-webcrypto`, `no-webrtc`, `no-websocket`). A
disabled swarm leaves the player untouched, so the host page can attach
unconditionally.

`attach()` replaces `hls.config.fLoader` with a wrapper around the loader that
was configured, and `stop()` puts the original back, closes every peer
connection and relay socket, drops held segments and emits one final
`onMetrics`. Requires a secure context (https, or localhost) for WebCrypto.

For a same-identity admission renewal, `updateTicket(ticket)` replaces only this
viewer's opaque ticket and schedules a bounded presence announcement. Established
links, the loader, held segments, counters and upload reservations remain intact.
It returns `true` for an accepted ticket (including an unchanged one), or `false`
for an invalid ticket or stopped, disabled or ungated swarm. The host must validate
its own credential's issuer, swarm, epoch and expiry before calling it, and retain
expiry checks around asynchronous admission and upload reservations. It does not
validate an opaque credential, extend policy authority or restore upload consent.
Publisher, policy or peer-configuration changes still require reconfiguration.

If an upload arrives during that peer's changed-ticket admission check, it joins
the pending bounded check. Only an accepted decision permits media or an upload
reservation. Rejection, timeout or shutdown prevents delivery. A successful
decision is not cached as permission for later upload requests.

## Options

| Option | Default | What it does |
|---|---|---|
| `swarmId` | required | Groups viewers of one stream. 8-128 characters. |
| `relays` | required | 1-8 relay URLs (`wss://`, or `ws://` on loopback). |
| `mode` | `"shadow"` | `"off"` disables; `"peer-first"` requires a signed stream authorisation and commitment provider. |
| `secretKey` | fresh per viewer | Ephemeral signing key for presence and signalling. Never the viewer's own identity. |
| `originFallbackMs` | `1500` | The in-time budget a peer delivery is measured against, and peer-first's ordinary wait. |
| `maxPeerWaitMs` | `5000` | Peer-first may wait past `originFallbackMs`, up to this, only while recent peer timing projects the segment needs it and the playback buffer covers the wait with `originReserveMs` to spare. |
| `originReserveMs` | `2000` | Minimum buffered playback reserved for origin recovery; measured p90 HTTP time can increase it. Multi-holder origin tails retain that same per-load reserve and its absolute recovery deadline. An empty buffer goes directly to origin. |
| `sustainablePeerWait` | `false` | Opt-in: also cap the initial peer wait and every extension by the fragment/part duration minus measured p90 whole-object origin time with a 25% and 100 ms recovery margin. Substantial origin ranges update this estimate after scaling by their actual byte count. Unknown origin timing or duration leaves no serial peer wait. This limits repeated failed waits from consuming more playback than each segment adds. Independent cached/late-HAVE races keep their window beside immediate HTTP. |
| `warmAhead` | `false` | Experimental peer-first option, requiring `serve: true`: use the same player's next two parsed, unencrypted, whole main-media fragments for bounded speculative loading. A warmed object promoted to genuine demand frees the sole speculative slot. Existing demand/range limits are unchanged. Verified future objects share the held cache; at most three distinct cached/in-flight objects and 24 MiB of warm data plus all reservations fit within `maxHeldBytes`. Fresh cache permission may wait only within actual buffer headroom, up to 25 ms, before ordinary source recovery proceeds independently. |
| `startupBufferTarget` | `null` | Experimental one-shot startup buffer for peer-first serving: a synchronous function returns the current player's fresh raw HLS target time in seconds, or `null` when its ownership/epoch is invalid. Hold the first main-fragment callback until verified contiguous upcoming media covers that target and measured origin-recovery headroom. While pending, a 100 ms poll advances a bounded parsed future window toward that horizon, skipping unrequested near-tip work and reclaiming completed unowned coverage only when needed. A window ahead of the actual target waits for it; in-flight work and authority pins retain their reservations. When both verified futures contribute to contiguous coverage of the current target but still lack recovery headroom, preserve that useful prefix and admit one additional parsed successor, even if the held original first interval is obsolete. Startup permits at most four objects within `startupBufferMaxBytes` (24 MiB by default); steady warm-ahead remains at three. Future requests remain serial. The startup deadline is twelve seconds from the original first-fragment load entry, or the shorter parent load deadline; retries do not renew it. Ordinary speculative requests retain their separate eight-second expiry. Works with `warmAhead: false` to stop speculative fetching after startup. It never pauses, plays, seeks or changes the room clock; bounded failure reports a loader error instead of releasing unsafe media. |
| `startupBufferMaxBytes` | `25165824` | Encoded startup aggregate including the retained original response. Safe integer from 24 MiB through 32 MiB; a non-default value requires `startupBufferTarget`. Reserve the full chosen allowance against the shared held budget before HTTP. Cached/in-flight future bytes separately remain within 24 MiB, as do existing per-object checks. Object limits, recovery and deadlines are unchanged; this is not total browser memory. |
| `startupBufferCommit` | `null` | Optional async host hook, requiring `startupBufferTarget`, called once with frozen `{ signal }` after verified reservoir readiness and before releasing HLS callbacks. The host may acknowledge a new room start here. The original startup deadline and resource limits continue; cancellation ignores late settlement. Fresh target, authority, context and resident coverage are checked again afterwards. The SDK never creates or reanchors the room clock. |
| `uploadPacing` | `false` | Experimental canonical-piece upload refill deferral: one FIFO waiter per link, at most `min(maxUploadPeers, maxPeers)` waiters, and a fixed 250 ms queue deadline. The existing per-second rate, twice-rate burst, session allowance and wire remain unchanged. Whole-object deficits still refuse immediately. Queue rows contain identity and numeric geometry; held bytes and current host permission are checked after waiting. |
| `latePeerRace` | `false` | Experimental peer-first option requiring `zeroBudgetPeerRace`: permit the first peer arm of still-running whole-main-fragment HTTP with no prior peer plan to use a newly accepted, current exact-HAVE holder. Warm work needs a genuine consumer or an owned pending startup-buffer dependency. Genuine demand keeps its earliest demand window; startup dependencies keep the original HTTP-entry window and first startup deadline. Both retain `min(lateWindowMs, 4000)`, arming plus `min(maxPeerWaitMs, 2500)`, and the known original HTTP load deadline. Same HTTP request/timers, fresh authority and current immutable identity; no retries or extra GET. Dormant watchers share `maxConcurrentRaces`; lifecycle changes retire them. Numeric `latePeerRace` metrics do not create delivery credit. |
| `lateWindowMs` | `6000` | How long a race keeps asking peers before it counts as missed. |
| `maxPeers` | `6` | Connections in and out. The demo selects four explicitly. |
| `maxDialsInFlight` / `dialTimeoutMs` | `2` / `12000` | Simultaneous outbound dials and setup deadline. |
| `maxUploadPeers` | `4` | Distinct peers served in any 30 s. |
| `maxUploadBytesPerSecond` | `1250000` | Upload token bucket. Bytes a receiver's cancel kept from being sent return to it. |
| `maxUploadBytesPerSession` | unlimited | Optional non-negative safe integer, including zero. Reserves full accepted media payloads; interrupted transfers do not refund the allowance. |
| `reserveUploadBytes` | none | Optional async `(bytes, {signal}) => boolean` host reservation before serving; refusal/error/timeout stops the send. Use for persistent cross-tab budgets. |
| `serveOnCellular` | `false` | With `false`, detected cellular or `saveData` connections neither upload nor fetch peer media. Detection is advisory and does not identify every metered connection. |
| `serve` | `false` | Set `true` only after the viewer opts into uploading. With `false`, the viewer is receive-only: it takes from peers but never uploads or advertises what it holds. Use it where the connection type cannot be read (Safari), so a phone on cellular is never asked to upload. |
| `ticket` | none | An opaque string (up to 2 KB) this viewer presents in its presence and in every offer and answer, typically a short-lived credential the origin signed for this viewer's swarm key. |
| `admit` | none | `(pubkey, ticket) => boolean \| Promise<boolean>`. With it set, a viewer never dials, answers or follows a referral to a peer it has not admitted, so its address (carried in the SDP) only reaches ticket holders. The host is called again before each dial and SDP publication, including retries and referrals; it must check expiry. A third argument provides an operation-specific abort `signal`, cancelled on its deadline or swarm stop. At most 16 checks run concurrently and each has a 3 s deadline. |
| `shadowSampleRate` | `0.25` | Share of fragments raced. |
| `streamEvent` / `getCommitment` | required for peer-first | Signed kind-30311 stream event and `(context, { signal }) => signedCommitment`. See below. |
| `delegation` / `revokedDelegationIds` / `delegationRevocations` | none / empty | Explicit author-signed scope and current host revocation view for delegated commitments. |
| `maxConcurrentRaces` | `24` | Maximum retained shadow races. |
| `admissionTimeoutMs` | `3000` | Deadline for a host admission check. |
| `swarmParts` | `false` | Include low-latency HLS parts. Parts are small; leave off. |
| `maxHeldSegments` / `maxHeldBytes` | `12` / 64 MiB | What a viewer keeps to serve others. |
| `maxSegmentBytes` | 16 MiB | Maximum accepted/retained segment payload. |
| `minLinkLifeMs` / `idleEvictMs` / `evictionCooldownMs` | `15000` / `20000` / `10000` | Minimum link lifetime, bidirectional idle threshold and rotation cooldown. |
| `retryFloorMs` / `retryCeilingMs` / `maxRetriesPerPeer` | `4000` / `45000` / `3` | Refusal retry bounds and retry attempts per peer. |
| `maxReferrals` | `2` | Maximum referrals offered after a refusal. |
| `reannounceDebounceMs` / `minReannounceGapMs` | `4000` / `12000` | Bound capacity-change presence announcements. |
| `presenceIntervalMs` | `20000` | Presence heartbeat, jittered 30%. |
| `metricsIntervalMs` | `10000` | How often `onMetrics` fires. |
| `onPeerDelivery` | none | Optional `({ connection, bytes }) => void` observation for each accepted, verified peer-first media contribution. `connection` is the actual `RTCPeerConnection`; `bytes` is the positive media payload byte count. A single-holder delivery fires once with its whole payload; a multi-holder delivery fires once per contributing connection with only its first-verified-copy bytes, excluding origin and duplicate pieces. It fires only after the complete verified object is accepted for the player. Aggregate peer-first counters are updated first, then all contributions are observed immediately before the player's success callback. Host exceptions and rejected promises are ignored without changing playback or other observations. It does not fire for protocol traffic, shadow measurement, origin fallback, corrupt/rejected media, an incomplete multi-holder object or loads aborted, stopped or too late for the peer-first handoff. |
| `iceServers` | one public STUN | Host-provided STUN/TURN configuration captured at swarm creation. Browser TURN credentials are disclosed to the client; no managed TURN deployment is supplied. The demo/broadcaster accepts a private `--ice-config FILE` or a separate optional [renewal adapter](docs/FIELD-TEST.md#optional-turn-credential-renewal) that replaces demo swarms. |
| `iceTransportPolicy` | `"all"` | `"all"` or `"relay"`, captured at creation and passed to every native connection. `"relay"` restricts peer ICE to relayed candidates; it never retries with `"all"`. Usable TURN configuration is required for peer connectivity. This does not select TLS, change consent or extend a peer deadline; origin fallback remains available. |
| `coreWasm` | unset | Experimental and opt-in. Peer-first only: the Rust core's commitment verifier, peer selection, neighbour discovery and peer link protocol, `src/browser/relayswarm-core.wasm`, as a URL, its bytes or a compiled `WebAssembly.Module`. Serve the file as `application/wasm`; a page with a Content Security Policy needs `'wasm-unsafe-eval'` in `script-src`. The relay session starts once the module has loaded or failed, after at most 2 seconds; fragments loaded meanwhile go to origin. JavaScript decides until the module loads, and for the rest of the session if it fails to load or traps; a trap closes the links the module ran, and later links are JavaScript. A rejection from the module stands. See `core` in the metrics. |
| `transferWorkerUrl` | unset | Experimental opt-in with peer-first, `coreWasm` and `multiHolder`. Explicit URL of a separately bundled companion worker from the same SDK revision. It warms asynchronously from the already compiled module and runs the same Rust schema-3 transfer facade off the main thread. While warming, after worker failure or at resource limits, those loads use HTTP; no silent large synchronous transfer retry. Existing absolute deadlines and complete-object credit checks remain. [Packaging, bounds and lifecycle](docs/TRANSFER-WORKER.md). |
| `multiHolder` | `false` | Experimental; needs `coreWasm`. A schema 3 segment (signed with the publisher's `pieceCommitments`) is fetched from several holders at once by piece range, with an HTTP `Range` fetch from origin for any tail the peers are projected to miss; a holder that proves fast once idle takes back pieces origin has not yet sent, and the first verified copy wins; every piece is verified against the commitment before the segment is delivered. A holder that stays silent or whose flow cannot finish its range in time is abandoned early, by the single-holder rules, and its pieces move to the other sources; unlike the single-holder path, a flow that stops after its first byte is also checked every 250 ms rather than left to its timeout. Used only with holders whose presence advertises object framing 2, and the viewer advertises it only while every one of its links runs in the core. Ranged origin requests go through the player's own fragment loader with `rangeStart` and `rangeEnd` set, as for an `EXT-X-BYTERANGE` segment, so headers and credentials from hls.js `xhrSetup`, `fetchSetup` or a custom loader apply. A body that is not exactly the range (a server that ignored `Range` and sent the whole segment) is discarded, and a refused range sends the segment to the whole-segment origin load. After one such answer the origin (scheme, host and port) is not asked for ranges again in that session, and its segments take the single-holder path. A ranged upload is charged by the bytes it sends. |
| `zeroBudgetPeerRace` | `false` | Experimental opt-in with `coreWasm` and `multiHolder`. When buffered playback leaves no safe peer wait, start normal whole-segment HTTP immediately and race a schema 3 object already advertised in a connected framing 2 holder's HAVE at load entry. The Rust transfer requires the optional peer-only capability: no origin lane or origin estimate exists inside that transfer. Cold holders get bounded calibration; verified progress refills pending ranges, each piece and the whole object hash must match. Candidates remain inside the initial snapshot and current HAVE. Older modules safely decline this arm while HTTP continues. No new neighbour search or ranged HTTP request is added. Key hashing and commitment verification never delay HTTP. The first complete verified peer object or normal HTTP response wins; losing callbacks are suppressed. Peer work stops at `maxPeerWaitMs`. Existing upload rate/session limits apply to each bounded request. Progressive hls.js delivery skips this race; unexpected nonempty HTTP progress locks the load to HTTP. Accepted peer bytes alone do not establish network savings. |
| `lateHaveRace` | `false` | Experimental opt-in alongside `zeroBudgetPeerRace`. When no entry-snapshot HAVE matches, observe actual matching HAVE only on the accepted, eligible framing 2 connections captured at load entry. Normal whole HTTP already runs. The first qualifying holder snapshot starts at most one existing peer-only arm; key hashing, HAVE observation, metadata and transfer all share the original `maxPeerWaitMs` deadline. FETCH, new or replaced connections and withdrawn HAVE do not qualify. No new discovery, dial, HTTP request, origin range or deadline extension is added. HTTP success, exposed progressive data, abort and stop cancel observation and peer work under the same ownership rules. This can use overlapping source downloads; it does not guarantee throughput, continuity or network savings. |
| `maxHoldersPerObject` | `3` | Holders per segment under `multiHolder`, 1 to 8. Provisional: not yet set from a replayed field trace. |
| `abrIgnorePeers` | `false` | Peer-first. Keeps a peer-delivered fragment out of the hls.js bandwidth and first-byte estimates, so automatic quality follows the origin path; otherwise the time a peer delivery took, including any wait for a holder, is sampled as if it were an origin download. The loader skips the estimator's samples only while hls.js dispatches `FRAG_LOADED` and `FRAG_BUFFERED` for that fragment, and puts hls.js back on `stop()`. The one sample it cannot withhold is the first-byte sample hls.js's own timer takes when a load has waited past half a segment with no byte, the check that can switch quality down mid-load. A fragment fetched under `multiHolder` counts as peer-delivered even when origin sent part of it. `metrics().segments.abrPeerSamplesWithheld` counts the skipped samples. Needs the default hls.js ABR controller; with another one it does nothing. |
| `traceRequests` | `0` | Rows kept for `trace()`, 0 to 32,768, oldest dropped first: loads, eligibility decisions, peer and origin requests and multi-holder scheduler calls, enough to replay a transfer offline. For field runs that need a replayable input; it is not part of `metrics()`, so a receipt must take `trace()` itself. |
| `segmentKey` | URL pathname | Maps a fragment URL to the key peers index by. Must agree across viewers, so strip per-viewer query strings and CDN tokens. |
| `RTCPeerConnectionImpl` / `WebSocketImpl` / `WorkerImpl` | globals | Constructor injection points for tests; the worker remains explicitly configured through `transferWorkerUrl`. |

Cancelled warm jobs retain their speculative slot and any byte reservation while
an awaited authorisation or verifier still owns the work. Late settlement cannot
publish or deliver cancelled data; the slot and reservation are released when
that operation settles. Cancelled rows do not count as current playback coverage
or reusable pending data. Cancellation does not increase the existing limits.

Offer and answer gathering retain the 1.2-second soft cap when the local SDP
already contains a candidate. If it is still empty at that point, gathering
waits for the first candidate or native completion, within the same negotiation
and original absolute `dialTimeoutMs` deadline. Native completion without a
candidate fails the dial rather than publishing empty SDP. Cancellation and
admission checks retain their existing ownership; this adds no hard timer,
trickle messages, public option or default change.

The pending glare-reuse correction keeps the existing lower-public-key offer
when both peers dial simultaneously. The yielding peer may adopt only its
still-pending outgoing connection for the winning admitted offer. Native
operations are serialised and old negotiation/channel callbacks are fenced;
the same capacity slot and original absolute `dialTimeoutMs` deadline remain.
The host admission check runs again before rollback, after asynchronous rollback
immediately before remote SDP, and before answer publication. These checks share
the existing dial deadline and bounded admission policy. Established, failed or
unsupported native states are not reused; failure retains normal origin fallback.
Recent admitted offer IDs are retained privately up to 256 entries per swarm;
active incoming duplicates do not allocate or restart a timer. Incoming distinct
requests still supersede pending incoming connections. Wire version, public
options and existing limits stay unchanged. The correction has passed 121 unit
tests; native rollback/SCTP and Internet renewal remain unproved. See the
[current checkpoint](docs/STATUS.md#current-delivery-checkpoint).

## Cost, and what to tell viewers

Shadow mode downloads a raced fragment **twice**: once from the origin for the
player, once from a peer to measure. That is the price of measuring with no
playback risk. Keep `shadowSampleRate` low enough that the extra data is
acceptable (0.25 gives a useful sample), and leave `serveOnCellular` false.
Contribution is off by default. Say plainly that `serve: true` redistributes
media, and obtain the viewer's opt-in before enabling it. Cellular detection
is advisory: browsers can omit connection information, so it cannot replace
consent. Receive-only still discovers peers and exposes its address to them;
`mode: "off"` or `stop()` provides origin-only playback.

## Metrics

`onPeerDelivery` and `peerConnections()` are included from v0.4.0. The
immutable v0.3.0 release assets do not include them. The opt-in
`zeroBudgetPeerRace` and measured origin-recovery reserve below are later
main-branch additions; consume a commit that contains those changes.

`peerConnections()` returns a fresh array of the actual `RTCPeerConnection`
objects for accepted, active peer links. Pending offers, dials, glare
negotiations and closed/disconnected links are excluded. It returns an empty
array after `stop()`. Changing the returned array does not change the swarm's
membership. Use this snapshot to draw connected peers; observing native
constructors also sees negotiations that never become peers. Connection
references are deliberately separate from serialisable `metrics()` data.

`peerConnectionDetails()` is a later main-branch addition. It returns fresh
`{ connection, pubkey }` records for the same accepted links. `pubkey` is the
remote peer's ephemeral signalling key, explicitly associated with that native
connection. Neither array order nor a local connection counter identifies a
remote peer. The records disappear on link closure or `stop()`, and changing a
record cannot change membership. This read-only projection adds no wire traffic.
Keep native references local; a room participant's claim to a signalling key
remains a self-report unless the application establishes its own binding.

Use `onPeerDelivery` to attribute verified video to its contributing connections.
For a multi-holder delivery, each connection is observed once with the bytes
its pieces contributed to the completed object. The first verified copy of
each piece wins; duplicate or origin-winning pieces add no peer credit. All
contributions sum to the increase in `bytes.peerFirst`. An incomplete or
rejected object emits no observation even if some pieces verified. Aggregate
counters include the whole delivery before its first observation runs.
Keep connection references in local maps rather
than serialising them into receipts. The callback provides no URL, peer key,
SDP or payload buffer, and does not add a network request or change a deadline.
It observes bytes accepted for the player, not the segment currently playing
from its buffer. Browser RTC byte statistics include connection and protocol
messages and must not be presented as verified video delivery. Likewise, the
`payload` outcome in `peerRequestDiagnostics` precedes hash verification and
is not an alternative to this callback.

`segments.zeroBudgetPeerRaces` counts matching cached-HAVE race attempts;
`zeroBudgetPeerRaceWins` counts only complete peer objects accepted by the
player. With `lateHaveRace`, the zero-budget `have-after-wait` eligibility
row records actual later HAVE admission while HTTP runs; it is not a serial
origin wait. Verified pieces of an origin-winning or incomplete object add no
accepted peer bytes and emit no delivery callback. `stop()` cancels the peer
arm while pending normal HTTP continues for playback; loader `abort()` or
`destroy()` cancels both arms. Run `npm run test:cached-peer-race:browser`
([fixture](test/zero-budget-peer-race-native-browser.mjs)) for two native
browser contexts exchanging a signed six-MiB object, both winners, one HTTP
request per load, partial HTTP cancellation and connection reuse. It is a
loopback integration proof; the deployment's media/network acceptance remains
separate.

`onMetrics(metrics)` and `metrics()` return a version-2 snapshot: `v`, `swarmId`,
`mode`, `disabledReason`, `stopped`, `pubkey` (the ephemeral swarm key,
not an identity), `uptimeMs`, `serving`, plus:

- `peers`: `connected`, `dialling`, `dialsStarted`, `dialsAccepted`,
  `dialsFailed`, `dialsTimedOut`, `dialsRejected`, `offersAccepted`,
  `offersRefused`, `linksOpened`, `linksClosed`, `banned`,
  `candidatePairs` (counts keyed `local/remote` candidate type, the NAT
  outcome: `host/host`, `srflx/srflx`, `relay/...`, `unknown`).
- `signalling`: `samples`, `medianMs`, `p90Ms` from offer sent to channel open.
  `signalling.clock` holds local age-window counts: `aheadRejected` (swarm
  events dated more than 30 s ahead), `staleRejected` (older than the 60 s
  window, including relay history), `maxAheadSeconds`, and `signalSamples` with
  `signalAgeMedianSeconds` from at most 64 recent live signals that decrypted
  and validated. A median far from zero suggests this device's clock differs from its peers'; it is relay
  delay plus skew in whole seconds, not a clock measurement. No identities.
  `signalling.clock.origin` is `{ samples, offsetSeconds }` from the HTTP `Date`
  (plus `Age`, when present) of up to 16 recent origin fragment loads, timed
  at first byte, as origin minus this device; positive means the origin is ahead. It needs a
  readable `Date`: same-origin, or `Access-Control-Expose-Headers: Date`;
  otherwise `samples` stays 0 and `offsetSeconds` is null. `Date` has one-second
  resolution and delay only lowers a sample, so `offsetSeconds` is the largest
  recent sample, rounded. It is a diagnostic, not a clock correction. Without a
  session the session fields are null and `origin` is still reported.
- `segments`: `originLoaded`, `raced`, `noPeers`, `sampledOut`, `skipped`,
  `aborted`, `peerInTime`, `peerLate`, `peerMiss`, `peerCorrupt`,
  `peerUnverified`, `inTimeShare`, `sampledInTimeShare`, `observedInTimeShare`,
  `sampledInTimeByteShare`, `observedInTimeByteShare`, `peerFirstLoaded`,
  `originFallbacks`, `peerSkippedLate`, `peerProjectedLate`, `peerWaitExtended`,
  `peerAbandoned`, `peerNoFit`, `peerUntestedTrial`, `peerUntestedTrialLoaded`,
  `commitmentRequests`, `commitmentRejected`, `commitmentUnavailable`, `peerFirstShare`, `peerFirstByteShare`, `peerLatencyMedianMs`,
  `peerLatencyP90Ms`, `originLatencyMedianMs`.
- `bytes`: `fromOrigin`, `fromPeers`, `peerFirst`, `uploaded`, `uploadsServed`,
  `uploadsRefused`, `uploadsCancelled`, `uploadCancelledBytes`, `held`,
  `uploadRemaining` (null when unlimited), `uploadExhausted`.
  `uploadsCancelled` counts responses this viewer stopped early because the
  receiver cancelled them; `uploadCancelledBytes` is the part of `uploaded` that
  was therefore not sent. Those bytes return to the per-second upload rate; the
  session allowance and any host reservation already charged are not refunded.
- `peers.deliveryMeasurements`: bounded measurements for active links,
  including completion time, payload rate and failures.
- `relays`: `connected`, `presenceSent`, `signalsSent`, `published`,
  `rejected`, `rejectedTimestamp` (the `rejected` frames whose message mentions
  a timestamp), `sinceDropped` (events dropped only by the subscription `since`
  filter, unverified and so unauthenticated; a device clock ahead of its peers
  raises it), `publishErrors`.
- `errors`: `total` and `byStage`. A module named by `coreWasm` that fails to
  load or traps counts once under `core`.
- `core`: `state` (`off`, `loading`, `ready` or `failed`), `verifier` (`wasm`
  or `js`, whichever decides the next commitment), `selection` (`wasm` or
  `js`, whichever chooses peers), `discovery` (`wasm` or `js`, whichever
  runs neighbour discovery), `links` (`wasm` and `js`: how many links
  each opened; links opened before the module loads are JavaScript),
  `fallbacks` (traps that handed the core's
  work to JavaScript) and `decided` (`wasm` and `js`: how many commitments
  each verifier decided). Selection moves to the core when it loads only if
  no peer has been chosen yet, and back to a fresh JavaScript selection,
  without link history, after a trap. Discovery moves to the core only while
  it holds no context, hint or window, and after a trap to a fresh JavaScript
  instance that keeps its counters. `multiHolder` reports whether framing 2
  is advertised (`enabled`) and counts `transfers`, `delivered`, `late`
  (planned past the deadline even with origin), `failed`, `bans`,
  `abandoned` (holders dropped early as silent or too slow), the bytes
  each source was first to verify (`peerBytes`, `originBytes`), the bytes
  received that verified nothing new, such as the slower copy of a piece
  sent by both a holder and origin (`unusedBytes`), `originRanges`,
  and `originRangesIgnored`, the origins that answered a range with
  something else (each once).
  `originRangeOutcomes` contains fixed counters for `payload`, `invalid-request`,
  `wrong-size`, `error`, `timeout`, `abort` and `exception`, so an origin tail
  cancelled by the library differs from an HTTP failure or ignored range.
  Counters saturate and snapshots own their copies. Optional bounded origin
  trace rows also include a numeric `httpStatus`; no error text or URL is added.
  `timings` gives p50 and p90 over the last 128 delivered transfers of their
  duration, their slowest single request and their request count.
  Peer byte totals elsewhere count only a transfer's peer share. An additive
  metrics-v2 field.
- `config`: the effective settings, so a receipt says what produced it.

Snapshots contain no IP addresses, user agent or long-term key, but the
ephemeral public key can correlate a receipt with public swarm activity.
Keep receipts local unless the viewer explicitly agrees to reporting. The
current demo's optional reporting endpoint accepts a numeric summary rather
than this full snapshot; see [operations](docs/OPERATIONS.md).

`peerEligibilityDiagnostics` is an additive local version-2 snapshot field in
the current source. Its fixed reason `counters` survive eviction from the
64-record ring; `capacity` and `dropped` describe that ring. Each row contains
elapsed `atMs`, numeric `cc` and `level` (null when unavailable), the already
computed initial `budgetMs`, `reason` and `matchingHave` (boolean or null).
`no-budget` records HAVE as **null/unobserved**: the loader does not compute a
segment key or inspect peer availability to populate this diagnostic. The
original origin fallback may still compute its normal key afterwards.
Positive-budget reasons distinguish `no-have-no-wait`, `no-have-wait`,
`wait-no-longer-eligible`, `wait-aborted`, `wait-expired`, `have-at-entry` and
`have-after-wait`; `aborted-before-eligibility` means cancellation after the
existing key computation, before the HAVE decision. `projected-late` means
recent peer timing projected that the delivery could not fit before the buffer
limit (see [peer-first loading](#authenticated-peer-first-loading)); such a row adds `projection`:
`stage` (`entry`, before availability, or `commitment`, after), `transferMs`,
`holderWaitMs`, `roomMs`, `firstByteMs` and `rateBytesPerSecond`, each a
number or null. Wait expiry/cancellation
also leaves HAVE null rather than claiming it was still absent. One load can
produce both a wait-entry and a wait-outcome row: counters count decisions,
not distinct segments. Budget is the initial allowance, not remaining request
time. Rows contain no segment keys, hashes, URLs, peer public keys or addresses.
Rows for decisions made after the key computation and link inspection (every
positive-budget reason except `aborted-before-eligibility`; never `no-budget`)
also carry four sorted arrays of at most eight holder labels: `holders`
(links serving this rendition now), `haveHolders` (links whose HAVE contains
the demanded key now), `staleHolders` (the serving links that neighbour
discovery treats as stale for this rendition, see below) and `heldMissHolders`
(the links recorded as a held miss on this decision, see below; empty until the
load ends, then filled on the decision's last row). The first three are read
after the decision and change no decision, timer or deadline; if reading them
fails the row is still written with the arrays null. The `have-at-entry` row of
a load that was granted an untested-holder trial (see
[peer-first loading](#authenticated-peer-first-loading)) also carries
`trial: true` and the `projection` detail of the later late stage (the commitment
detail when both stages were late); no other row has a `trial` field. A holder label is a positive integer that this instance assigns to each
remote peer when it first becomes a link, in first-link order, kept across
connection replacement in a map of at most 64 peers (oldest evicted; `0` means
unknown). It is a local counter, not a key or address: it is never derived from
a key and never sent to a peer, placed in presence or signalling, or added to
the numeric operator report. A full local receipt can still join the label to
the ephemeral public key through `peers.deliveryMeasurements[].holder`, which
the snapshot already exposes with that key, so treat rows with the same
consent as the rest of the receipt.
Each row also carries `budgetGeometry`: the calculation's final `currentTime`,
`bufferedEnd`, `playableEnd`, `fragmentStart` (seconds), computed
`originReserveMs`, and `uncappedMs`, the buffered playback less that reserve
before `originFallbackMs` caps it. These are the values consumed by the original calculation,
without additional media or context getter reads. Finite signed values are
retained; unavailable or nonfinite values are null. The fixed `source` is
`buffer`, `no-media`, `no-buffer`, `error` or `unobserved`; `positionSource` is
`part`, `fragment` or null. Non-buffer sources leave the numeric fields null.
With `sustainablePeerWait` enabled, the geometry additionally includes
`durationMs`, `originRecoveryMs` and `sustainableMs`. These explain the
separate per-segment cap; `uncappedMs` continues to describe only the buffer
calculation. Unknown duration or origin recovery is null and permits no serial
peer wait.
Wait outcomes retain their original geometry, rather than sampling the later
buffer. Each row and returned snapshot owns a copy. These values explain the
initial budget calculation, not donor availability or remaining request time.
They remain readable after stop and use the existing local/reporting-consent
boundary; they add no requests, authority checks or deadline changes. These
observations do not establish the cause of a failed peer transfer.

`peerRequestDiagnostics` records the outcome of each peer-first transport
request, after peer selection. Its fixed counters distinguish `payload`, `none`,
`timeout`, `abort`, `abandoned`, `closed`, `busy` and `send-error`. At most 64 rows are retained;
`dropped` counts evicted rows. Rows contain elapsed `atMs`, the same page-local
connection `id` as transport diagnostics, numeric `cc` and `level`, the
deadline's `remainingMs` at selection (after any extension), the actual request
`timeoutMs`, request `elapsedMs`, `expectedBytes`, `receivedBytes`,
`firstByteMs` (request to first payload chunk), `metadataReceived`, `draining`,
a fixed `closeReason` or null, and `holder`, the local label (see above) of the
link the request went to. `abandoned` is a request the loader gave up
as unable to finish in time. Unavailable numeric values are null. A
`payload` means the transport assembled bytes; signature, size, hash, expiry
and final loader-deadline checks still decide whether playback accepts them.
Each logical request contributes one outcome. A timeout or abort may leave an
ordered reliable channel draining late bytes; those bytes and its later EOF do
not contribute another outcome or turn that request into a delivered segment.
This field does not count eligibility decisions or commitment failures before
selection, and shadow-mode requests are outside its scope.

`uploadRefusalDiagnostics.counters` classifies the existing upload refusal
branches: `admission`, `not-held`, `not-serving`, `banned`, `session-allowance`,
`peer-limit`, `rate-limit`, `reservation-refused` and `reservation-inactive`.
These count local decisions, not wire delivery or remote receipt. Both fields
are local metrics, contain no media keys, URLs, peer public keys or addresses
(the eligibility and request rows carry only the local holder label described
above), and are excluded from automatic numeric reporting. They add no network traffic,
timers, retries, upload permission or deadline changes. Returned snapshots own
their copies, and retained outcomes remain readable after stop.

`admissionDiagnostics.calls` counts actual host `admit` callback invocations
at the fixed sites `presence`, `dialStart`, `offerBeforeSend`, `offerIncoming`,
`answerIncoming`, `glareBeforeRollback`, `glareAfterRollback`, `answerBeforeSend`,
`upload`, `refresh` and `other`. Coalesced waiters and operations cancelled before
the callback starts add no call. A callback that refuses or throws still counts.
Counters saturate at `Number.MAX_SAFE_INTEGER`; snapshots own their copies.
These local counters contain no credentials or identities, add no requests and
are excluded from automatic reports. They do not cache admission or establish
which server budget, network condition or peer caused a failed request.

Deployed source `f393abf` includes `transportDiagnostics` within metrics version
2. It contains fixed-enum
`counters`, a ring of at most 64 `records`, `capacity` and an eviction `dropped`
count. Records contain a page-local, per-swarm numeric connection `id` (0 when
no PC is allocated/correlated), elapsed milliseconds in `atMs`, and fixed `event`/
`detail` values for gathering, native states, signalling stages and close reasons.
Unreadable native state uses the fixed `unknown` classification.
Local-description records may add `candidates` (count only, capped at 256) and
`candidatesCapped`; they contain no addresses, SDP, peer keys or request IDs.
`signal-send` means local signalling acceptance, not relay delivery or remote
receipt. The ring and counters remain readable after `stop()`; native listeners
are detached when their dial/link ends. No automatic reporting, signalling change
or connectivity fix is implied. Keep this diagnostic receipt local under the same
reporting-consent boundary as other metrics. The two ordinary cross-machine
short checks retained actual supersession, post-SDP dial timeout and established-
link request-timeout stages; their [public summary](spikes/results/f393abf-ordinary-cross-machine-20261014.json)
is evidence of observation, not a connectivity repair. Numeric IDs do not identify
the remote role. Union sampled records by `(id, atMs, event, detail)` within each
swarm instance; never sum repeated ring snapshots as new events. A request-timeout
close identifies the branch, not the request start, available budget or reason
bytes missed it.

The pending correction adds fixed `negotiation` / `glare-yield` observations
for adoption of a pending outgoing connection. Its numeric connection ID remains
the same: this is neither a new native construction nor a completed link.
Superseded negotiation callbacks cannot label the adopted connection's later
description as an earlier offer. Existing close reasons and reporting consent
remain unchanged; this event does not prove successful native rollback or media.

`inTimeShare` remains conditional on having peers. `sampledInTimeShare`
includes sampled fragments with no peers; its byte equivalent weights by
fragment size. The `observed` shares divide verified in-time samples by all
origin-loaded fragments/bytes and are lower bounds when sampling is below 1.
Use sampled coverage alongside `noPeers` and `candidatePairs` when assessing
reachability. In peer-first mode, `bytes.peerFirst` counts verified bytes
actually delivered to hls.js instead of starting an origin fragment request;
`originFallbacks` counts loads delegated to the original loader. Shadow
coverage fields are null in peer-first mode.

`bytes.uploaded` counts payloads accepted for serving after the upload token
bucket, any host reservation callback, and the subsequent live-state checks.
Pending or refused host reservations never increment it. Session capacity is
reserved internally before awaiting that callback, so concurrent requests cannot
overspend; an accepted reservation remains charged if the link closes before
serving. Consequently `uploadRemaining` can include charges absent from
`uploaded`. An interrupted accepted transfer can send less than its counted
payload; signalling and protocol overhead are excluded. These counters are not
wire metering or acknowledged delivery, and durable host-ledger spend may exceed
accepted serving totals.

The session allowance is additive within metrics version 2. Exhaustion
withdraws media availability and stops serving while receiving remains
available. The library counts one swarm instance; a host recreating instances
must retain accepted totals. The demo uses an origin-wide Web Lock and
storage reservation across Apply, rejoin, publisher refresh, reloads and tabs.
Consent is never persisted. Storage failure disables uploading; an explicit
viewer reset or increase can change the quota.

Peer-first ranks eligible advertised media by measured completion time,
payload rate and failure history. Healthy measured peers take priority over
fast refusals. A cold route gets the remaining time minus 25 ms for each of
up to two alternatives that also pass the selector's measured deadline-fit
check; excluded alternatives reserve no time. This reserves quick retries while allowing an unknown
route to complete and acquire a measurement. A known delivery gets headroom
within the original peer deadline, rather than an equal share of it.
Attempts remain serial and capped by `maxPeers` and the original deadline.
A timed-out or cancelled request resolves promptly for origin fallback. On a
known ordered, fully reliable channel, the link stays busy while discarding
that response up to a matching validated EOF, or a refusal before metadata.
Only then can another request use the channel. The receiver also sends
`cancel`; a holder that honours it stops adding binary data and queues EOF
behind the bytes already sent, including when it is waiting for the channel's
buffer-low event, or refuses before metadata. Holders without `cancel` send the response in full.
A holder queues more of a response only while at most 128 KiB is waiting to
be sent on the channel, so chunks queued before a cancel arrives still flow. The existing drain limit closes
an incomplete response; host stop and admission withdrawal close immediately.
Schema 3 multi-holder peer requests verify progress in batches of at most four
canonical pieces and 512 KiB; a canonical piece larger than that is requested
alone. The remaining pieces stay queued for that holder, so a later abandoned
request preserves earlier verified pieces. Origin keeps its contiguous HTTP
ranges. Multi-holder planning keeps each connection's first-byte delay separate
from its payload flow and from HTTP service time. The model retained between
objects keeps up to 16 samples per connection for 30 seconds; its rate needs
at least 32 KiB and 300 ms after the first byte. Substantial HTTP ranges (at least half the object and 32 KiB)
refresh the rendition's whole-object recovery estimate, scaled by bytes; tiny
tails do not become whole-object latency samples.

A stale or pessimistic multi-holder estimate can receive one demand-bound
refresh per connection every ten seconds, only when that connection already
advertises the requested object. The first request is explicitly limited to
one canonical piece, independently of another connection's fast rate, while
origin starts the remainder. Fresh verified probe data can unlock ordinary
bounded requests within the existing deadline. An accepted short-flow refresh
can discard an older pessimistic rate without creating a rate below the
300 ms floor; subsequent unknown-rate demands keep the one-piece initial
limit. A newer unsuccessful attempt removes that useful-delivery allowance.
Older WASM modules without the optional bounded-probe capability skip these
probe sources safely and retain origin and ordinary measured holders. No
background media fetch or additional timer is added.

Run `npm run test:core-link:browser` for native Chrome loopback coverage
of a cancelled six-MiB ranged response and a subsequent hash-checked range on
the same reliable connection.
Fresh-origin coordination is bounded by safe buffered playback and measured
HTTP fallback time. hls.js owns quality selection. These mechanisms do not
prove optimal internet scheduling or net savings.

For an eligible already-advertised framing-2 object, schema-3 mixed admission
does not require the whole object to fit a peer-only forecast. After verifying
the commitment, the bounded piece planner may assign a smaller peer fraction
and obtain the rest from origin. Closed, busy, banned, stale or non-range
holders do not gain this exception. An unavailable range path or valid schema
1/2 still uses the whole-object projection; all existing deadlines and
verification remain in force. This does not force peer traffic when an
already-running normal HTTP/cache response wins a cached-peer race.

When a peer-first viewer's current rendition has no linked serving neighbour
or matching HAVE, bounded local discovery can replace one old idle unsuitable
link to seek an admitted peer advertising an exact requested key. Signed
presence HAVE and serving hints remain untrusted; the existing fresh admission
checks precede SDP, and commitments and payload hashes still authenticate media.
The existing peer, outgoing-dial and admission-check limits remain unchanged.
Victim selection protects active receiving, draining and queued/active uploads,
minimum link life, bidirectional idle time, the shared rotation cooldown and
useful sibling audio/video neighbours. At least one established link remains.

Among the links that rotation could already drop (not mid-transfer, not banned,
at least `minLinkLifeMs` old and idle for `idleEvictMs`), both this victim choice
and the idle rotation for an incoming offer now go in tier order before idle
time. Tier 0 (unhelpful) is a non-serving remote that is not a consumer. Tier 1
(serving) is a remote that is serving. Tier 2 (consumer) is a non-serving remote
when this viewer is serving, if that remote announced, in a contribution message
within two `presenceIntervalMs`, a rendition this viewer plays within 30 s: it
plays what this viewer can give it, though it may not have asked yet. The lowest
tier goes first, and idle longest within it. A discovery replacement still
leaves out the links useful to an active context before it orders the rest.
This is an ordering, not an exemption. If the link to a consumer is the only
eligible link it is dropped exactly as before, so a receiver that never asks
still cannot hold a slot indefinitely, and the ordering does not make discovery
run when no candidate hints a demanded key. Rotation cadence, the number of
rotations, `minLinkLifeMs`, `idleEvictMs` and `evictionCooldownMs` are
unchanged. Each link keeps, for at most eight renditions, when the remote last
announced each one, serving or not; this is local state and no message
changes. `peers.evictedUnhelpful`, `evictedServing` and `evictedConsumer` count
offer evictions by the victim's tier, `neighbourDiscovery.counters.victimUnhelpful`,
`victimServing` and `victimConsumer` count discovery replacements, and
`peers.evicted` still counts every eviction.

Held-miss charging and the untested-holder trial below govern the single-holder
whole-object path. Schema-3 multi-holder loads retain the core piece scheduler;
their accepted, first-verified peer contributors clear holder history. An
all-origin assembly does not renew a peer replacement or become a peer timing
or ABR sample. Neither path changes the signed-media acceptance checks.

A serving link normally counts as a neighbour for its rendition even before it
holds any segment, which keeps discovery off. Each load that reached the HAVE
check is decided once, when it ends. If a verified segment came from a link, that
link's history is dropped and no other link is changed. If the load went to
origin, only the links that were judged are charged, with a miss called a held
miss. These are the serving links that were asked and did not deliver a verified
segment in time (the request was abandoned, timed out or failed, or the payload
arrived after the deadline), and, when no link could fit the time left
(`peerNoFit`), the serving links that held the key and whose own timing estimate
did not fit. A decline made on swarm-wide estimates or on the buffer charges no
holder: a `projected-late` decision while some link held the key, or a request
skipped because no recent transfer could finish. A link that was never asked is
left alone. When no link held the key, every serving link takes a miss, as before: at
a `wait-expired` outcome (or a `wait-aborted` outcome that the deadline timer
itself caused, which keeps its row reason) and at an entry-stage `projected-late`
decision. Holding the key at entry or after the wait no longer clears a link
by itself. Four
misses on distinct segments, "distinct" meaning a different key from the last
missed key (consecutive keys), at least ten seconds after the first, make the
link stale for that context: it no longer meets the context and is no longer
protected as a useful neighbour, so discovery may seek a peer hinting the exact
demanded key and may replace it. The count is kept per `main` or `audio`
context, only from loads that reached the HAVE check (zero-budget,
aborted-before-eligibility and no-longer-eligible loads neither count nor
reset). A load that is aborted by the caller (an hls.js abort) or by `stop()`, an
unavailable, rejected or expired commitment do not count. A corrupt payload is
never charged to the link that sent it: that link is banned and closed, and the
size and digest check is made first even when the deadline has passed, though
another holder asked by a later step of the same load can still be charged. A
payload that would have verified but arrives after the deadline goes to origin
and charges the link that was asked. A link's history is dropped only when a verified segment from that
link reaches this viewer's loader in time, when the link closes, when the
rendition changes, or when the context sees no demand for 30 seconds. A stale
link is still asked for any segment it does hold.
The thresholds are internal constants, not options, and the wait, deadlines,
HTTP fallback, `maxPeers`, the single 15-second window, the rotation cooldown
and every upload limit are unchanged. In a full
neighbourhood the allowance still bounds this to one replacement per context
generation until a verified delivery or the twenty-second re-arm below renews
it, so a replacement that is also never ahead or never delivers leaves the
viewer on origin for that rendition between attempts. The additive
`neighbourDiscovery.counters.staleHolder` counts attempts that began because
every serving link was stale; `staleBlocked` counts loads where a fresh eligible
candidate hinted a demanded key for such a context but a bound (spent allowance,
no room or victim, no outgoing slot, an attempt in flight) began no attempt;
`heldMiss` counts one per link and demanded key for a held miss. `unmetNoHint`
counts, at most once per candidate search, a current unmet context for which no
fresh candidate hinted a demanded key, and `unmetIneligible` one for which fresh
candidates did but every one was ineligible (cooldown, retries, already
dialling); neither changes the search. They count only contexts that also pass
discovery's existing room, reservation or victim condition, so an unmet context
with no room and no victim is not counted, and they count per context, so one
search can count a context and still return a candidate for another. All are local
counts in the local snapshot, are not added to the numeric operator report, and
do not show that delivery improved. A stale link's HAVE does not count: a link
that still advertises a demanded key but is stale for that context neither keeps
the context met nor is protected as a useful neighbour. A link that is not stale
still counts through its HAVE, as before.

Discovery retains at most two requested keys for each selected `main` and
`audio` context, 64 candidate hints of at most eight hashes, and one opportunity
with an absolute maximum of 15 seconds. Quality changes invalidate only that
media type, including zero-budget loads; those loads add no key hashing or HAVE
lookup. A refused attempt may reuse its single vacancy before that same deadline.
The reservation and scoped victim reconnect suppression then expire even if
loads continue. An accepted commitment/hash-verified delivery for the exact
selected context generation renews its one-replacement allowance; PC-open,
HAVE, sibling progress and inactivity do not. Without a delivery, a spent
allowance also renews once at least twenty seconds (an internal constant,
`neighbourDiscovery.replacementRearmMs`) after it was spent, if the context is
still current and every link serving its rendition is stale or none serves it;
`neighbourDiscovery.counters.rearmed` counts these. That allows at most one
replacement per twenty seconds per context. The single 15-second window, one
attempt at a time, the rotation cooldown, `maxPeers` and ticket gating still
apply, so two contexts that re-arm together do not rotate links in quick
succession. Per-piece origin fallback remains unchanged.

A still-current discovery offer can include the exact demanded `requestedKey`
inside its existing pairwise NIP-44 payload, alongside the truthful peer count.
After fresh incoming admission, a full recipient may apply the existing idle
rotation policy when it currently holds that exact key and serving is allowed.
The same cooldown, link lifetime, idle, transfer, reserved-slot and keep-one
guards apply. The digest is untrusted advice, not upload or media authority;
it is not echoed in presence or rejections. Older peers ignore this optional
wire-version-3 field and retain their existing full-recipient behaviour.

This offers a bounded chance to reach a peer during that interval.
A permanently full or misleading remote can still refuse; after expiry and
refill the unchanged unmet episode cannot force another eviction. It does not
guarantee all-rendition connectivity or establish the cause of previously missed
field delivery. `neighbourDiscovery` metrics contain bounded counts and remaining time,
not keys, tickets or remote identities, under the existing reporting consent.

## Authenticated peer-first loading

The runnable publisher/player example and the Node-only
`relayswarm/hls-publisher` helper are documented in
[`docs/FIELD-TEST.md`](docs/FIELD-TEST.md). The helper signs only contexts
present in its own local playlists, including exact byte ranges and
discontinuities; its supported HLS subset is deliberately limited.

```js
const swarm = createHlsSwarm({
  swarmId,
  relays,
  mode: "peer-first",
  streamEvent: signedLiveEvent,
  getCommitment: (context, { signal }) =>
    fetch(commitmentUrl(context), { signal }).then((response) => response.json()),
  serve: viewerHasOptedIntoUploading,
  originFallbackMs: 1500,
});
```

The host obtains a kind-30311 event from its trusted stream discovery flow.
The event must have a valid signature and the experimental tag
`["relayswarm", "redistribute", "1"]`. This opts the publisher into peer
redistribution. These assignments are a RelaySwarm contract, not an accepted
NIP or an interoperability claim.

The commitment is a Nostr event of experimental kind 24172, signed by the
same author or a trusted scoped delegate, tagged `x` with the swarm id and `e` with the exact stream event
id. Its content is the exact output of `commitmentContent(fields)` exported
by `relayswarm/segment-commitment`. Fixed field order and the
`relayswarm-segment-v1` domain bind the signature to this use:

```js
commitmentContent({
  streamEventId: signedLiveEvent.id,
  swarmId,
  key,                 // SHA-256 of swarmId + "\n" + segmentKey + byte range
  rendition: "0",      // String(context.frag.level)
  sequence: 123,       // context.frag.sn
  discontinuity: 0,    // context.frag.cc, default 0
  part: null,          // context.part.index, otherwise null
  sha256,              // digest of the exact media bytes
  size,                // exact byte count, within maxSegmentBytes
  expiresAt,           // Unix seconds, future and at most five minutes away
});
```

The default segment key is the URL pathname; a byte-range request adds
`#start-end`, matching the loader context. Publisher and viewer must agree
on this mapping. A commitment older than two minutes, a different stream,
rendition, discontinuity, sequence or part, an expired commitment, or a
signature from an unauthorised key is rejected. Author-scoped delegation and
the host's current revocation view are supported; see
[delegated signing](docs/PRODUCTION-FEATURES.md#signing-and-discovery).

Signature validation, peer discovery, transfer and SHA-256 verification must
all finish within the loader's wait. The ordinary wait is `originFallbackMs`,
shortened with a thin playback buffer so that `originReserveMs` of playback
remains for origin loading. Startup, an empty buffer, or a fragment with
neither advertised availability nor an eligible contributor goes directly to
origin.

The loader projects each delivery from recent peer timing on any link: the
median time to first byte, the upper-quartile payload rate after first byte
measured over the latest part of recent transfers (completed, timed out or
abandoned; flows of at least three first-byte times decide once two exist),
and, when no holder has the segment yet, this viewer's median origin time for
the rendition less however long an announced origin fetch has run. The buffer
limit is the buffered playback less the origin reserve, at most
`maxPeerWaitMs`, and the wait never passes it. A projection that fits may
extend the wait to cover it with a quarter to spare; one that overruns the room
by no more than a quarter, or rests on evidence older than 15 s, waits to the
limit; one that overruns by more, or whose holder wait leaves no time for a
first byte, goes to origin at once (`peerProjectedLate`). `peerWaitExtended`
counts extensions. Without evidence the ordinary wait applies.

An individual wait can fit the current buffer while repeated misses still
drain it: for example, a 2.5 s peer wait followed by a 1.3 s HTTP recovery
takes longer than a two-second segment adds. The opt-in
`sustainablePeerWait: true` also limits both the initial wait and every
extension, including multi-holder transfers, to
`max(0, duration * 1000 - (p90OriginMs * 1.25 + 100))`.
For a two-second segment and 1,300 ms measured HTTP, that cap is 275 ms.
The existing buffer-safe reserve and configured caps still apply. Before
whole-object origin service has been measured, HTTP starts immediately;
`originReserveMs` is not treated as an observed recovery time. Substantial
origin ranges can supply that measurement after byte scaling. Missing or
invalid duration also permits no serial wait.
Parts use their own duration. This admission rule cannot guarantee smooth
playback when later origin, peer or decoder performance changes. A zero
result can still use `zeroBudgetPeerRace`, whose independent peer timer
runs alongside immediate normal HTTP and retains its configured window.

The loader also goes to origin without asking a peer when the time left to the
limit is less than the fastest of its last 16 completed transfers at least as
large as the segment would need, or less than a recent first byte
(`peerSkippedLate`), and when no link with the segment could fit (`peerNoFit`).
Once a link is chosen, the wait may grow to cover that link's own estimate,
within the limit. A request is abandoned, and the load goes to origin, when it
can no longer finish by the deadline on generous assumptions: without a first
byte, after three recent first-byte times (at least 250 ms) and once even an
immediate first byte at the best recent rate would be late; with data flowing,
from two first-byte times in, when neither double its latest rate nor the best
recent rate would finish in time. `peerAbandoned` counts these. The holder is
asked to stop and returns the unsent bytes to its per-second rate.

A holder that has never been asked gets one request. The projection rests on one
pool of timing evidence for the whole viewer, so a single slow holder's partial
transfers can make every decision late, including the decision about a holder
that has not been tried. When the entry or the commitment projection would send
a load to origin as `projected-late`, some link held the key at entry (the load
is not coordinated), and the room to the buffer limit is longer than the median
first byte, the loader looks for an untested holder: an open, free, unbanned
link whose HAVE holds the key, that has no recorded attempt, and that is not
stale for the load's context. If there is one, the load waits to the buffer
limit as a nearly fitting projection does, and its first request goes to that
link if it still qualifies at that moment (the first in link order, since an
untested link has no observation to rank by), otherwise to the ordinary choice. `peerUntestedTrial` counts the request and `peerUntestedTrialLoaded`
a request that returned a segment verified against its commitment. For that
decision no `projected-late` row is written and `peerProjectedLate` is not
counted. A load gets at most one trial and a link is untested only until its
first recorded attempt, so it gets at most one in its life. A stale link, a busy
or banned one, and a coordinated load get none. The rest of the attempt is
unchanged: the pre-request checks above still send a load to origin
(`peerSkippedLate`), the attempt is abandoned on its own progress, a link that
was asked and did not deliver is charged as a held miss, and later requests in
the same load use the ordinary choice. There is no completion-rate condition. The
option considered was to allow a trial only when the median completed transfer
time fits the room, but a receiver whose only evidence is partial transfers has
no completed transfer to take a median of, so that condition would not apply in
the case the trial is for. The safeguards are the existing ones: the buffer
limit, the pre-request first-byte and fastest-completion checks, and abandonment
on the attempt's own progress. This gives an untested holder one chance. It does
not make a segment fit a room shorter than a relayed transfer needs, and a load
with less room than that still goes to origin.

For a recorded main-rendition segment, the loader waits only if an eligible
same-rendition contributor has a live FETCH lease for that exact key. Known VOD
means `context.frag.type === "main"` and the exact demanded integer level's
`hls.levels[level].details.live === false`; `currentLevel` is not consulted.
Bare serving presence or rendezvous rank is insufficient because the contributor
may be behind this viewer's VOD prefetch frontier. Live and unknown playlists
retain bounded receive-only/rendezvous coordination for synchronous segment
release. Alternate audio remains unknown here because its level indexes a
different track family. The loader requests its signed commitment while
waiting for availability. It
verifies the commitment after availability arrives, before requesting peer
bytes. Both operations share the loader's deadline. An eligible wait may make
one commitment request even if availability never arrives. A failed commitment
request still falls back to origin, without a commitment retry.

For a successful owned whole-origin response whose key is already known, the
loader retains eligible bytes and announces HAVE before withdrawing FETCH,
including when hls.js synchronously destroys the completed loader. Abort,
failure or refusal to retain bytes supplies no new HAVE. This changes neither
the lease duration nor the receiver's signed-commitment and hash checks, and
adds no key-hash wait before the player's success callback. Availability is
not a promise that a peer transfer will fit the receiver's deadline.

If peer work fails or exceeds its budget, the original loader starts and owns
its usual HTTP retries and errors. Invalid peer bytes are discarded
and the peer is banned. Init segments and, by default, low-latency parts use
the original loader directly. `abort()`, `destroy()` and `stop()` cancel
pending peer work; stopping also immediately releases a waiting load to its
original loader. No late peer completion can invoke a second success callback.
Peer success updates the statistics object retained by hls.js, including loaded
bytes and timestamps. Its known `aborted: false` survives disposal of the losing
HTTP loader, including hls.js's synchronous success cleanup. This preserves the
accepted stats reference; it makes no performance claim. Caller aborts and
unknown or already-aborted flags retain their existing semantics.
Aborting a pending peer load invokes `onAbort` once;
destroying it cancels without a completion callback. The playback regression
checks these behaviours alongside ranges, seeks and discontinuities.

## The kill switch

The host page owns the mode. Read it from your own stage status or config
(`off` / `shadow` / `peer-first`), create the swarm accordingly, and when a live change
flips it to `off`, call `stop()`. After `stop()` the player is exactly as it
would have been without the module, and a new swarm can be created later if
the switch flips back. Nothing in the module reaches back to the host to
decide its own mode.

## Known limits

- **Limited peer-first scheduling.** Each load asks one available peer at a
  time within a fixed deadline. Origin seeders can contribute substantially
  without receiving any peer-first segments themselves; per-viewer benefits
  are uneven. Fresh media coordination and measured deadlines are implemented;
  internet-scale scheduling, released independent-client interop and physical
  mobile/NAT measurements remain open. See the production delivery checklist.
- **Bounded peer resources.** A link queues at most four uploads, rejects
  empty or excessive chunks and has a 3 s backpressure deadline. These bounds
  limit particular attacks; they do not prove resistance to every Sybil or
  resource-exhaustion attack.
- **Rotation is narrow on purpose.** A peer at `maxPeers` rotates a link out
  only for a caller that has no peers at all, only when it would still keep one
  of its own, at most one per `evictionCooldownMs`, and never a link that is
  mid-transfer or younger than `minLinkLifeMs`. Rotating for anyone who asked
  was measured to cost late joiners more than it won, because an evicted peer
  re-dials at once and displaces a third. Among the links it may drop it takes
  the lowest tier first, so a link to a receiver that plays what it can give goes
  last, not never. Other refusals carry a
  `retryAfterMs` and up to two referrals instead. `peers.evicted`,
  `peers.evictionsUnavailable`, `peers.retriesScheduled`,
  `peers.referralsFollowed`, `offersRefused` and `segments.noPeers` show what
  is happening, and `segments.firstPeerSegmentAtMs` says how long a viewer
  waited before the swarm was any use to it.
- **Hard NATs.** Symmetric NAT and some VPN egresses will not connect with
  STUN alone. A host can supply TURN credentials through `iceServers`; no
  managed TURN or super-peer service is supplied. When peer connection fails,
  viewers play from the origin.
- **Relays.** Presence is one event per viewer per 20 s plus two events per
  connection. Point at a relay you control; a public relay may rate-limit.
  Sessions subscribe to swarm-wide presence and only their own recipient-tagged
  signals. Relay frames must match a live subscription before signature work
  and dispatch; reconnect restores both subscriptions.


## Experimental peer supply hint

With `coreWasm` in peer-first mode, opt in with `peerSupplyHint: true`.
`metrics().playerHint` and optional `onPlayerHint(rows)` report one advisory
`PlayerHint` row per hls.js level at the next demanded segment's sequence and
discontinuity. Without the option the field, callbacks and trace rows are absent.
The adapter never assigns a player level. A host may use a hint only as a
tie-breaker between two levels its **origin-only** estimate can sustain; keep
`abrIgnorePeers: true` when evaluating that estimate. Never force a level from
peer capacity or treat the hint as a bandwidth sample.

Each row carries `rendition`, `level`, `sequence`, `eligibleHolders`,
`projectedMs`, `sizeEstimate`, `sizeEstimateSource` and `knowledge: "linked-have"`. The projection is
milliseconds from the observation, using the core scheduler, current peer
budget and holder limit; origin joins when the peer plan would be late.
Size comes from the previous verified commitment or origin load for that
rendition, falling back to playlist bitrate times segment duration. The source
is labelled `observed` or `playlist-bitrate` (null if neither is available).
Origin timing comes from that rendition's earlier origin loads, falling back
to this viewer's measured origin rate across renditions.
These are estimates for the next segment, not knowledge of its signed size.
Unknown size or unavailable sources yield `projectedMs: null`; an unloaded
playlist has `sequence: null`. Cold peers retain the scheduler's 32 KiB/s floor.
Only open, idle, unbanned, non-stale framing-2 links advertising the segment's
HAVE count. The count can exceed `maxHoldersPerObject`, which limits the plan.

Discovery still keeps one context per media type, for the playing rendition.
Other rendition supply is limited to already linked holders advertising HAVE;
the option fetches no playlists or commitments, starts no target discovery,
and prepares no switch. An unavailable core produces no hints. Whole segments
only; LL-HLS parts produce no new hint. This is experimental in-process and
loopback behaviour, with no field or physical-device acceptance yet.
`traceRequests` records replayable `playerHint` inputs and commands for
`scripts/trace-report.mjs`.
