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

## Options

| Option | Default | What it does |
|---|---|---|
| `swarmId` | required | Groups viewers of one stream. 8-128 characters. |
| `relays` | required | 1-8 relay URLs (`wss://`, or `ws://` on loopback). |
| `mode` | `"shadow"` | `"off"` disables; `"peer-first"` requires a signed stream authorisation and commitment provider. |
| `secretKey` | fresh per viewer | Ephemeral signing key for presence and signalling. Never the viewer's own identity. |
| `originFallbackMs` | `1500` | The in-time budget a peer delivery is measured against, and peer-first's ordinary wait. |
| `maxPeerWaitMs` | `5000` | Peer-first may wait past `originFallbackMs`, up to this, only while recent peer timing projects the segment needs it and the playback buffer covers the wait with `originReserveMs` to spare. |
| `originReserveMs` | `2000` | Peer-first reserves this much buffered playback for the origin; an empty buffer goes directly to origin. |
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
| `iceServers` | one public STUN | Host-provided STUN/TURN configuration captured at swarm creation. Browser TURN credentials are disclosed to the client; no managed TURN deployment is supplied. The demo/broadcaster accepts a private `--ice-config FILE` or a separate optional [renewal adapter](docs/FIELD-TEST.md#optional-turn-credential-renewal) that replaces demo swarms. |
| `iceTransportPolicy` | `"all"` | `"all"` or `"relay"`, captured at creation and passed to every native connection. `"relay"` restricts peer ICE to relayed candidates; it never retries with `"all"`. Usable TURN configuration is required for peer connectivity. This does not select TLS, change consent or extend a peer deadline; origin fallback remains available. |
| `coreWasm` | unset | Experimental and opt-in. Peer-first only: the Rust core's commitment verifier, peer selection, neighbour discovery and peer link protocol, `src/browser/relayswarm-core.wasm`, as a URL, its bytes or a compiled `WebAssembly.Module`. Serve the file as `application/wasm`; a page with a Content Security Policy needs `'wasm-unsafe-eval'` in `script-src`. The relay session starts once the module has loaded or failed, after at most 2 seconds; fragments loaded meanwhile go to origin. JavaScript decides until the module loads, and for the rest of the session if it fails to load or traps; a trap closes the links the module ran, and later links are JavaScript. A rejection from the module stands. See `core` in the metrics. |
| `multiHolder` | `false` | Experimental; needs `coreWasm`. A schema 3 segment (signed with the publisher's `pieceCommitments`) is fetched from several holders at once by piece range, with an HTTP `Range` fetch from origin for any tail the peers are projected to miss; every piece is verified against the commitment before the segment is delivered. Used only with holders whose presence advertises object framing 2, and the viewer advertises it only while every one of its links runs in the core. Origin must answer `Range` with 206; a 200 is never sliced. Ranged origin requests use `fetch` with same-origin credentials, not the player's loader, so headers added through hls.js `xhrSetup` or `fetchSetup` are not sent; a refused range sends the segment to the whole-segment origin load. A ranged upload is charged by the bytes it sends. |
| `maxHoldersPerObject` | `3` | Holders per segment under `multiHolder`, 1 to 8. Provisional: not yet set from a replayed field trace. |
| `segmentKey` | URL pathname | Maps a fragment URL to the key peers index by. Must agree across viewers, so strip per-viewer query strings and CDN tokens. |
| `RTCPeerConnectionImpl` / `WebSocketImpl` | globals | Injection points for tests. |

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
  `peerAbandoned`, `peerNoFit`, `commitmentRequests`, `commitmentRejected`,
  `commitmentUnavailable`, `peerFirstShare`, `peerFirstByteShare`, `peerLatencyMedianMs`,
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
  (planned past the deadline even with origin), `failed`, `bans`, and the
  bytes from peers and origin (`peerBytes`, `originBytes`, `originRanges`).
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
also carry three sorted arrays of at most eight holder labels: `holders`
(links serving this rendition now), `haveHolders` (links whose HAVE contains
the demanded key now) and `staleHolders` (the serving links that neighbour
discovery treats as stale for this rendition, see below). They are read after the decision and change no decision, timer
or deadline; if reading them fails the row is still written with the arrays
null. A holder label is a positive integer that this instance assigns to each
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
`cancel`; a holder that honours it stops at its next chunk and sends EOF early,
or refuses before metadata. Holders without `cancel` send the response in full.
A holder queues more of a response only while at most 128 KiB is waiting to
be sent on the channel, so chunks queued before a cancel arrives still flow. The existing drain limit closes
an incomplete response; host stop and admission withdrawal close immediately.
Fresh-origin coordination is bounded by safe buffered playback and measured
HTTP fallback time. hls.js owns quality selection. These mechanisms do not
prove optimal internet scheduling or net savings.

When a peer-first viewer's current rendition has no linked serving neighbour
or matching HAVE, bounded local discovery can replace one old idle unsuitable
link to seek an admitted peer advertising an exact requested key. Signed
presence HAVE and serving hints remain untrusted; the existing fresh admission
checks precede SDP, and commitments and payload hashes still authenticate media.
The existing peer, outgoing-dial and admission-check limits remain unchanged.
Victim selection protects active receiving, draining and queued/active uploads,
minimum link life, bidirectional idle time, the shared rotation cooldown and
useful sibling audio/video neighbours. At least one established link remains.

A serving link normally counts as a neighbour for its rendition even before it
holds any segment, which keeps discovery off. A link that serves the current
rendition but lacks this viewer's demanded segment is given a miss when the wait
reaches its deadline (a `wait-expired` outcome, or a `wait-aborted` outcome that
the deadline timer itself caused, which keeps its row reason) and when an
entry-stage `projected-late` decision finds that no link held the key. Four
misses on distinct segments, "distinct" meaning a different key from the last
missed key (consecutive keys), at least ten seconds after the first, make the
link stale for that context: it no longer meets the context and is no longer
protected as a useful neighbour, so discovery may seek a peer hinting the exact
demanded key and may replace it. The count is kept per `main` or `audio`
context, only from loads that reached the HAVE check (zero-budget,
aborted-before-eligibility and no-longer-eligible loads neither count nor
reset). A load that is aborted by the caller (an hls.js abort) or by `stop()`
does not count. A link's history is dropped when one of this viewer's loads
finds the demanded key in that link's HAVE at entry or before the wait deadline,
when the link closes, when the rendition changes, or when the context sees no
demand for 30 seconds. A stale link is still asked for any segment it does hold.
The thresholds are internal constants, not options, and the wait, deadlines,
HTTP fallback, `maxPeers`, the single 15-second window, the one-replacement
allowance, the rotation cooldown and every upload limit are unchanged. In a full
neighbourhood the allowance still bounds this to one replacement per context
generation until a verified delivery renews it, so a replacement that is also
never ahead leaves the viewer on origin for that rendition. The additive
`neighbourDiscovery.counters.staleHolder` counts attempts that began because
every serving link was stale; `staleBlocked` counts loads where a fresh eligible
candidate hinted a demanded key for such a context but a bound (spent allowance,
no room or victim, no outgoing slot, an attempt in flight) began no attempt. Both
are local counts and do not show that delivery improved.

Discovery retains at most two requested keys for each selected `main` and
`audio` context, 64 candidate hints of at most eight hashes, and one opportunity
with an absolute maximum of 15 seconds. Quality changes invalidate only that
media type, including zero-budget loads; those loads add no key hashing or HAVE
lookup. A refused attempt may reuse its single vacancy before that same deadline.
The reservation and scoped victim reconnect suppression then expire even if
loads continue. Only an accepted commitment/hash-verified delivery for the exact
selected context generation renews its one-replacement allowance; PC-open,
HAVE, sibling progress and inactivity do not. Per-piece origin fallback remains
unchanged.

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

When an eligible same-rendition contributor is fetching a new segment, the
loader requests its signed commitment while waiting for availability. It
verifies the commitment after availability arrives, before requesting peer
bytes. Both operations share the loader's deadline. An eligible wait may make
one commitment request even if availability never arrives. A failed commitment
request still falls back to origin, without a commitment retry.

If peer work fails or exceeds its budget, the original loader starts and owns
its usual HTTP retries and errors. Invalid peer bytes are discarded
and the peer is banned. Init segments and, by default, low-latency parts use
the original loader directly. `abort()`, `destroy()` and `stop()` cancel
pending peer work; stopping also immediately releases a waiting load to its
original loader. No late peer completion can invoke a second success callback.
Peer success updates the statistics object retained by hls.js, including loaded
bytes and timestamps. Aborting a pending peer load invokes `onAbort` once;
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
  re-dials at once and displaces a third. Other refusals carry a
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
