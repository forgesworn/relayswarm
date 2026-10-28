# RelaySwarm API reference

[Documentation](README.md) · [Installation](GETTING-STARTED.md) ·
[hls.js integration](../INTEGRATION.md)

This describes current source, including additions after the experimental
v0.4.0 source snapshot. Package version `0.4.0`, session wire version `3`,
segment-commitment schemas `1`/`2`/`3` (3 experimental) and metrics snapshot
version `2` are different version numbers. Source exports and protocol fields
are not a stable interoperability promise; immutable release assets retain
the API they were built with.

## Module entry points

| Import | Environment | Main exports |
|---|---|---|
| `relayswarm` | Node or a browser bundler | `RelayPool`, `RelaySwarmSession`, `validTicket`, `RELAYSWARM_VERSION`, `KIND_PRESENCE`, `KIND_SIGNAL`, `SWARM_TAG` |
| `relayswarm/hls-swarm` | Browser with hls.js | `createHlsSwarm`, `HLS_SWARM_METRICS_VERSION`, `rotationCandidate`, `retryAfterFor`, `readRefusal` |
| `relayswarm/transfer-worker` | Dedicated module-worker or bundler entry | `createCoreTransferWorkerRuntime`; installs the companion handler when loaded in a dedicated worker. See [packaging and lifecycle](TRANSFER-WORKER.md). |
| `relayswarm/segment-commitment` | Browser or Node | `commitmentContent`, `commitmentPieceSize`, `delegationContent`, `revocationContent`, `validStreamAuthorisation`, `verifyCommitmentDelegation`, `segmentMediaContext`, `verifySegmentCommitment`, `KIND_SEGMENT_COMMITMENT`, `KIND_COMMITMENT_DELEGATION`, `KIND_COMMITMENT_REVOCATION` |
| `relayswarm/hls-publisher` | Node only | `createHlsPublisher`, `PublisherError` |
| `relayswarm/publisher-state` | Node only | `loadPublisherState`, `publisherManifestPath`, `publisherSwarmId`, `publisherStreamEvent`, `validatePublisherStreamEvent`, `createCommitmentDelegation`, `createCommitmentRevocation` |
| `relayswarm/stream-discovery` | Browser or Node | `resolveTrustedStream`, `discoverTrustedStreams`, `StreamDiscoveryError` |
| `relayswarm/broadcast-pipeline` | Node with FFmpeg | `startBroadcastPipeline`, `broadcastEncoderArgs`, `broadcastForwardArgs` |
| `relayswarm/native-client` | Installed Node application | `validateNativeDescriptor`, `fetchNativeObject`, `createNativeObjectSeeder` |
| `relayswarm/publisher-advertisement` | Node or a browser bundler | `createPublisherAdvertisement`, `verifyPublisherAdvertisement` |
| `relayswarm/account-upload-budget` | Node on supported local POSIX storage | `createAccountUploadBudget`, `AccountBudgetError`, `accountBudgetError` |
| `relayswarm/realtime-peer` | Browser; injected connection in tests | `RealtimeDatagramLink`, `RealtimePeer`, `REALTIME_TRANSPORT`, `REALTIME_CHANNEL` |
| `relayswarm/realtime-werift-build` | Node build tool | `realtimeWeriftPlugin`, `weriftRealtimeRevision` |
| `relayswarm/package.json` | Package metadata | Name, version and declared dependencies |

The wildcard export also permits source subpaths such as
`relayswarm/src/native-journey.mjs`. These are implementation paths, not additional
stable named entry points. Do not import HyperDHT, Node filesystem or Buffer-based
object-transfer modules into an ordinary browser page.

## Relay sessions

`RelayPool.connect()` with `reconnect: true` becomes ready on the first usable
relay while the other initial attempts and bounded retries remain owned by
the pool. Without reconnect it waits for all initial attempts and reports an
all-failed connection error, unless `readyOnFirstRelay: true` makes it ready
on the first usable relay; it then still reports the all-failed error, and a
slower relay joins when it opens, with no retry. The installed native client
uses this so one stalled relay cannot spend its whole peer deadline. `close()` cancels attempts, waiters and retries.
`onRelayOpen(handler)` supplies a publish function scoped to that newly opened
socket; it becomes inert after the socket or pool closes.

An active `RelaySwarmSession` retains one copied signed presence and replays
it only to a newly opened or reconnected relay while it remains inside the
session's age window. Existing sockets receive no replay broadcast. Signals
and SDP are never cached or replayed. Expiry or `close()` clears the retained
presence; `close()` also unregisters the relay-open handler.

## Browser loader

`createHlsSwarm(options)` returns
`{ attach(hls), updateTicket(ticket), stop(), metrics(), peerConnections(), peerConnectionDetails(), trace() }`.
`attach` wraps `hls.config.fLoader`; call it before `loadSource`. `stop` is the
origin-only kill switch and closes connections, cancels pending work, releases
held bytes and restores the original loader. Create a new swarm to participate
again. Uploading defaults to off; `mode` defaults to `shadow`.

`peerConnections()` returns a fresh array of the actual `RTCPeerConnection`
references for accepted, active links. It excludes pending dials, offers,
glare negotiations and closed/disconnected links; `stop()` leaves it empty.
Mutating the returned array cannot alter the swarm. Keep native references
local to the host; serialisable metrics contain no connection objects.

The later main-branch `peerConnectionDetails()` returns fresh
`{ connection, pubkey }` records for those same accepted links. Each native
connection is bound to its remote ephemeral signalling key, without an array
ordering assumption. Records cannot mutate membership and disappear when the
link closes or the swarm stops. It creates no new network messages.

While range support is enabled, the existing authenticated, encrypted SDP
offer and answer also carry optional `obj: 2`. The loader records that explicit
capability only for an admitted, still-current negotiation after successful
remote SDP installation and before accepting the link. Missing or invalid
metadata retains conservative presence-derived behaviour; an open connection
or HAVE alone never proves range support. This avoids requiring a late viewer
to receive the holder's next presence before using verified schema-3 ranges.
It adds no signalling event or timer and changes no media verification,
admission, lease or HTTP deadline rule.

The opt-in `zeroBudgetPeerRace: true` races an already advertised cached
schema 3 object against immediately started normal HTTP when no safe peer
wait remains. It requires `coreWasm`/`multiHolder` framing eligibility and the
optional peer-only transfer capability. The Rust piece planner has no origin
lane in this mode, adding no ranged HTTP or invented origin estimate; only
eligible cached peers can refill its pending ranges. Candidates stay inside
the initial cached snapshot and current HAVE. Existing rate and session limits
apply to every bounded request. Older modules decline the peer arm safely;
only a complete verified peer winner counts as peer media.
Normal HTTP never waits for metadata; stopping the swarm cancels its peer
arm while that pending HTTP request continues. Progressive hls.js loads skip
the race. See the [options and lifecycle contract](../INTEGRATION.md#options).

The additional experimental `lateHaveRace: true` observes actual matching
HAVE on those connections accepted at load entry when no initial cached
snapshot matches. HTTP starts immediately. At most one later holder snapshot
starts the existing peer-only arm; hashing, observation, metadata and delivery
must all fit the original `maxPeerWaitMs`. FETCH, new or replaced connections
and stale availability cannot supply it. HTTP wins and exposed progressive
data cancel the arm. The default entry-snapshot behaviour is unchanged;
verified peer credit alone does not establish network savings or continuity.

The opt-in `sustainablePeerWait: true` additionally bounds serial peer waits
and multi-holder extensions by each fragment/part's duration minus measured
whole-origin recovery time with a 25% and 100 ms margin. The ordinary
buffer reserve remains in force. Unknown origin recovery, unknown duration or
no spare duration starts HTTP immediately; an enabled cached/late-HAVE race retains its independent
window. This is an admission bound, not a smooth-playback guarantee.

The unreleased experimental `warmAhead: true` option requires peer-first and
explicit `serve: true`. It observes this player's actual parsed main-media
fragments, loads at most the next two, and keeps one speculative whole-object
HTTP arm in flight. Existing demanded whole/range request limits still apply;
this is not a two-request global HTTP limit. Demand starts immediately and
joins already-running exact-object work instead of downloading it again.
That work becomes genuine demand and frees the single speculative slot, so
the following object can load concurrently. The combined cache and in-flight
set remains bounded to three distinct objects and 24 MiB; all in-flight
reservations reduce the existing held-cache budget together.
This option alone adds no startup gate, pause, hidden player, clock offset or automatic seek.

The separate unreleased `startupBufferTarget` option defaults to `null`. A host
may supply a synchronous function returning its fresh raw HLS target time in
seconds. Return `null` when the player, room epoch or playback intent is no
longer current. This enables a one-shot buffer before the first genuine main
fragment reaches HLS demuxing. The original attached media element and pending
trusted play request remain owned by the host.

The first held body and verified upcoming fragments share a startup reservoir
of at most four objects. `startupBufferMaxBytes` defaults to 24 MiB; a host may
explicitly select a safe integer byte allowance from 24 MiB through 32 MiB,
requiring `startupBufferTarget` for a non-default value. The original response
counts towards this aggregate. Cached and in-flight future bytes retain a
separate 24 MiB limit; steady warm-ahead retains its three-object limit.
Before first HTTP, the host must admit the entire chosen allowance against
its existing held budget; insufficient available capacity fails explicitly.
This bounds the encoded reservoir, not total browser memory. The original first response is handed to HLS unchanged and
is not retained as an extra shared-cache seed; its reservation is released.
Release requires a contiguous verified interval covering the
fresh target plus at least the origin reserve or measured p90 whole-origin
recovery with its 25% and 100 ms margin, whichever is greater. Startup is
bounded to twelve seconds from the original first-fragment load entry, or the shorter parent load deadline. Ordinary speculative requests
retain their separate eight-second expiry. Invalid ownership,
insufficient capacity or expiration fails the loader explicitly; it does not
release stale media or renew the deadline on automatic HLS retries. A separate
new adapter may start again after an explicit user retry.

Fresh parsed start/duration values may contain arithmetic round-off after an
Hls.js playlist refresh. Geometry equality tolerates up to 32 machine epsilons
scaled to the compared values, capped at one nanosecond. Media key and scope
remain exact; meaningful geometry changes still cancel the pending operation.
This does not lower the required recovery headroom or extend its deadline.

While that first callback remains pending, a bounded 100 ms poll reads the
host's fresh target. Admission can skip an unrequested parsed fragment already
behind the required recovery horizon, with at most one metadata hop per poll.
When available, the last verified future fragment's measured whole-load time
adds a scheduling lead to that admission horizon. This is a time observation,
not a throughput estimate or a change to the required release headroom.
The fourth-slot successor extending two contiguous verified futures covering
the current target is retained instead of being skipped by that horizon. Its
bytes still pass the existing reservation, verification and final release checks.
Completed obsolete future data can give its slot to a currently parsed
successor. If the first body and both planned futures have fully verified,
and both futures contribute to contiguous coverage of the fresh target but
still lack recovery headroom, startup retains that useful prefix and may admit
one additional parsed contiguous future within the same byte reservation.
The original first interval need not still cover the target: its unchanged
response continues to occupy one of the four residency slots. Capacity is considered
before retiring a useful completed prefix. An adequate window or a timeline gap
does not trigger this extension. Otherwise the existing rolling policy may
retire its completed, unpinned first future when it contains the target.
Once a future window starts ahead of the actual target, its start stays fixed;
release waits for the real target and verified coverage to meet again.
Startup contains at most four objects within its chosen byte allowance. Future requests remain serial,
and insufficient capacity cannot release unsafe media or extend the deadline.
In-flight work and authority pins keep their reservations.
The rolling plan stores metadata only, without retaining discarded payloads.
Polling stops on release, failure or cancellation and pauses its target reads
while the commit hook is pending. It never changes the host's clock or renews
the original deadline.
`metrics().startupBuffer.planningServiceMs` reports the active verified timing
sample, or `null` when unavailable. Failed, cancelled, stale and partial loads
do not train it; ending startup clears it. A new sample cannot move an already
selected future window while the actual target remains before that window.

The optional `startupBufferCommit` function defaults to `null` and requires
`startupBufferTarget`. It runs once after the encoded reservoir passes the
readiness checks, before held callbacks or consumed-media credit reach HLS.
Its frozen argument contains only the original startup `AbortSignal`; it may
return a promise. For example, a host can prepare a new room locally at zero,
publish its start after verified media is ready, and await acknowledgement.
An existing room must retain its advancing clock.

The original twelve-second/parent startup deadline and held reservations
remain in force while the host acknowledges. Cancellation retires the operation; late resolution
or rejection cannot release media. A current hook failure reports
`commit-refused`. After success, the loader repeats fresh target, authority,
context, parsed-fragment and resident-coverage checks. Insufficient headroom
does not recall the hook or extend the deadline. The hook establishes encoded
reservoir readiness, not decoded frames or accepted playback. The SDK itself
does not publish, start, pause or reanchor any room.
The signal also ends after successful HLS handoff. A host must detach its
pending-acknowledgement listener once acknowledged, so normal operation cleanup
does not cancel an established room. The final authority verdict and HLS
callback share one synchronous turn; success cleanup follows actual delivery.

With `warmAhead: false`, startup may preload the parsed upcoming fragments and
retain them for genuine consumption, then stops speculative fetching. Peer
consumption credit is deferred until the corresponding genuine callback is
released. `metrics().startupBuffer` distinguishes buffering, release, failure
and cancellation and reports reservoir use, target and recovery headroom. It
does not establish decoded playback, shared-clock accuracy or device acceptance.

The separate unreleased `latePeerRace: true` option defaults to false and
requires peer-first plus `zeroBudgetPeerRace`. When a whole main-fragment
HTTP request began without any peer plan, its first peer arm may use a newly
accepted framing-2 connection advertising that exact object. Ordinary
speculation cannot arm it: a warm object needs a genuine hls.js consumer. The
window starts at that earliest genuine demand, including promotion before the
inner loader is ready. An existing or expired peer plan is never renewed.

HTTP starts immediately and keeps its original request and network timers.
The peer arm ends by the earliest of four seconds from genuine demand,
`lateWindowMs`, 2.5 seconds from arming, `maxPeerWaitMs`, and the known original
HTTP load deadline. Unknown load deadlines and progressive delivery retain the
ordinary path. Fresh admission, signed authority, exact immutable context and
current connection identity gate peer work and final delivery. Nonempty HTTP
progress locks the response to HTTP. Only one complete authorised result can
win; this creates no second HTTP request or playback-clock adjustment.

Dormant metadata and active cached races share `maxConcurrentRaces`.
Pause, end, epoch/rendition/ticket change, abort, stop and original HTTP
termination retire the watcher. `metrics().latePeerRace` exposes entered,
armed, won, expired, retired and refused counts plus at most 64 numeric timing
records. Waiting and arming create no peer credit. Existing load-entry
`lateHaveRace` membership remains unchanged when this separate option is off.

When startup buffering is explicitly enabled, its required parsed future
fragments may instead carry a `startup-buffer-dependency` role while the real
first HLS terminal remains owned and pending. This leaves `genuineAt` unset;
the future object has not been consumed by HLS. Its existing HTTP-entry window,
peer-arm limit, parent deadline and original first startup deadline all apply.
The startup abort signal retires the role immediately on release or cancellation.
Steady speculative work receives no such role, and accepted-byte counters still
wait for the actual HLS callback.

Verified peer reception updates physical link usefulness independently from
player consumption. An individual flow below the unchanged 300 ms floor
does not train a rate. Newly verified short pieces may form a bounded batch
within the same transfer and connection.
Both 300 ms and 32 KiB must be observed before a flow-only rate sample is
recorded. The elapsed interval includes gaps and verification time. Origin
bytes, duplicate credit and other transfers or connections cannot train it;
an emitted batch never reuses its bytes. Cancellation, failure or invalidation
discards pending batches. Existing qualifying long-piece handling is retained,
and batching does not create a first-byte timing observation. Discovery delivery,
consumed bytes and external delivery notifications still require actual player
acceptance. This avoids using deferred playback credit as a prerequisite for
the next startup transfer.

Future bytes need a current signed commitment and matching SHA-256 before
entering the shared held cache. At most three warm references and 24 MiB of
warm data/reservations fit inside the existing `maxHeldBytes` budget. The warm
map references the held buffer; delivery to hls.js receives a transfer-safe
copy. Normal player/decoder memory and transient demand buffers remain
separate. Speculation expires after eight seconds. Promotion retires that
speculation-only timer; the already-running parent's timeout still runs from
its original start. A parent error or timeout settles the genuine demand
through its original callback, without an implicit fresh request or reset
deadline. Pause, unrelated seek, ticket change,
rendition change and stop clear speculative state; unrelated work yields to a
new demanded position. Gap, ranged, encrypted and alternate-audio fragments
retain the ordinary loader path.

Seeks inside the existing appended buffer retain current and future work,
including shared-clock alignment.
An unbuffered target also retains already-tracked work when it falls inside
an exact warm fragment's finite media interval in the active rendition scope.
This covers initial alignment into a next object before its append; it creates
no new request. Targets outside both the playable buffer and tracked warm
intervals still clear speculative state. Normal hls.js abort handling and the
next actual demand continue to prune unrelated contexts.

Before the first append, the last genuine parsed-demand interval can also
retain its unchanged same-scope next window after HTTP has already completed.
Its normalised identity and finite interval are snapshots, distinct from an
active request. Changed parsed next metadata, invalid/new demand, unsuccessful
termination, clear and stop retire that record. This creates no work, extends
no deadline and does not change permission or byte accounting.

Every demand reuse checks the host's current commitment/delegation/revocation
view. Only actual buffer beyond the normal origin recovery reserve permits
waiting for that check, capped at 25 ms. Unknown/empty headroom starts the
ordinary source immediately; otherwise source recovery starts when this small
budget expires. The first authorised cache result or source result wins and
cancels the other arm. Refusal leaves source recovery running. Thus buffered,
promptly authorised cache reuse avoids another HTTP request, while underflow
recovery can make another request; actual traffic remains counted. Stopping
does not wait for an unresponsive cache provider. Exhausting upload allowance
also clears warm references and reservations.

`metrics().warmAhead`
reports `verifiedBytes`, `verifiedPeerBytes`, `consumedPeerBytes`,
`localReuseBytes`, active speculative work, promoted demand, tracked objects,
cache bytes and aggregate reservations. Raw peer reception
is recorded once; `bytes.peerFirst` and `onPeerDelivery` receive speculative
peer credit only when real hls.js demand consumes it. Local reuse does not
create network bytes. These source tests do not establish sustained cold-cache
4K, a public TURN route, network savings or physical-device continuity.

Multi-holder admission reserves its candidate links synchronously before
asynchronous worker creation. Other download selectors respect those leases.
Only warm work may wait once for an already-captured candidate to become free,
within its original peer window and speculation lifetime; its existing HTTP
arm continues. Abort, failure and settlement release ownership. This does not
add a request, admit another peer or extend a playback recovery deadline.

The unreleased `uploadPacing: true` option is disabled by default. Canonical
piece ranges can wait in one global FIFO for the existing token bucket to
refill: at most one waiter per link, `min(maxUploadPeers, maxPeers)` waiters
overall, and a fixed 250 ms absolute queue deadline. A delayed event loop
expires overdue work instead of granting it. Rate and twice-rate burst caps
stay unchanged; unsupported whole-object requests still refuse immediately.
Queue rows retain no bulk media buffer. Current held data, host admission,
serving policy and allowance are rechecked before delivery; the final lookup
follows every host await. An owned rate reservation is refunded once when
nothing is submitted. Explicit host refusal releases its session reservation;
accepted or unknown host outcomes retain conservative session billing.

The existing provider callback exposes no remote request cancellation signal.
Remote CANCEL therefore cannot immediately end this short refill wait: the
unchanged Core/JavaScript framing suppresses late output and returns unsent
rate capacity, while accepted session/host reservations stay charged. Local
stop or link closure cancels immediately. `metrics().uploadPacing` reports
queued work, reserved rate bytes, grants/refusals/expiry/cancellation and total
and maximum deferred queue milliseconds (including time behind the head).
Observed expiry can exceed 250 ms when the event loop is delayed; the grant
deadline stays fixed. Host-policy time and payload time are not queue time.
`metrics().peerAdmission` reports held link leases and bounded waiter outcomes.
Neither waiting nor reservation creates peer delivery credit or rate evidence.

The unreleased opt-in `transferWorkerUrl` warms one explicitly packaged
companion worker asynchronously after `coreWasm` loads. With `multiHolder`,
schema-3 verification and planning use the same Rust transfer facade in that
worker. Configured loads use HTTP during warm-up or after failure, without a
large synchronous transfer retry. Queue/object limits and late-reply fences
preserve the ordinary origin path and accepted-only peer observations.
`loadCore(...).module` exposes the already compiled module for this use;
the worker fetches no second copy. See the [worker integration guide](TRANSFER-WORKER.md)
for the companion bundle, resource bounds, metrics and asynchronous low-level API.

For eligible already-HAVE framing-2 holders, a verified schema-3 commitment
can enter mixed piece planning without passing a whole-object peer forecast.
The planner may use only a bounded peer fraction alongside origin pieces;
valid schemas 1/2 retain their whole-object projection. Waiting for unavailable
known-VOD main media requires a live same-key FETCH lease from a fresh serving
contributor. VOD is read from the exact demanded main level's `details.live ===
false`; live, unknown and alternate-audio contexts retain their bounded
coordination. The current player level does not override the demand's level.
These changes preserve the estimator floor, integrity checks and existing
deadline/reserve bounds; the committed core module is unchanged.

`trace()` returns `{ v: 1, capacity, dropped, rows }`, the rows kept under
`traceRequests` (none by default): each peer-first load, eligibility
decision, peer request and origin request (whole or ranged), joined by a load
ID, and each multi-holder scheduler call with its inputs and the commands it
returned, so a recorded transfer replays against the module offline. Times are
whole milliseconds from the swarm's creation; holders are session labels, not
keys. It is kept out of `metrics()`, which receipts snapshot repeatedly.
Whole HTTP legs have an early numeric load alias, including synchronous cached
HTTP winners, immediate fallback and the immutable context of a late peer arm.
Their fixed `leg` is `fallback`, `cached` or `late`. `originStart` observes
entry into the original loader; `originProgress` is the first positive payload
callback observed in cached/late races, reusing the existing ownership decision
without reading the payload again. Ordinary fallback omits this payload-progress
observation because its SDK path has no such decision. This is not the first
network packet. `originAbortRequest` observes
the SDK requesting cancellation, before the inner abort and shared statistics
are reused for peer delivery. It is not a network-terminal event.

Only an actually observed success/error/timeout/abort callback produces one
`k: "origin"` terminal row with its existing `outcome` and `bytes` fields.
One ignored/duplicate callback may produce `originCallback`, with fixed
`phase: "progress" | "terminal"` (progress has a null outcome). This distinct
row must not be counted as another terminal. Late observations carry `stale: true`;
shared loader byte statistics are then `null` without reading them. Otherwise
`loaderLoadedBytes` and `loaderTotalBytes` are nonnegative safe integers or
`null`, observed from loader statistics. They are not wire-byte measurements
or proof of received partial response bodies. In hls.js 1.7.3 XhrLoader these
statistics can change before a payload callback. Independent browser/network
instrumentation is needed to determine actual partial HTTP cost.

A late load's `limitMs` is the original parent HTTP lifetime upper bound;
actual `xfer` deadlines remain authoritative for the later peer arm. Trace
rows retain the configured capacity/drop policy. With `traceRequests: 0`,
these observers read no additional loader byte statistics, retain no rows and
add no queries or timers. Tracing changes no callback forwarding, HTTP request,
peer eligibility, verification, budget or deadline policy.
`node scripts/trace-report.mjs file.json...` summarises saved traces (from a
harness receipt, a demo field receipt, a bare trace or a list of any of them): it replays every
transfer against the committed module and reports a mismatch, then gives
holders offered and used, bytes by holder rank, origin and redundant shares,
slack at finish, request timing and buffer ahead of the playhead.
`--what-if 1,2,3` replays transfers with other holder limits against each
holder's measured timing; it ignores shared uplinks, so it is an estimate of
whether fewer holders would do, not evidence for more.

`updateTicket(ticket)` refreshes this viewer's bounded opaque admission ticket
without rebuilding connections, the loader or upload accounting. It returns
`true` for an accepted ticket, including the current ticket, and `false` for an
invalid ticket or stopped, disabled or ungated swarm. The host must first
validate the credential's identity and expiry. Remote admission checks before
SDP and media serving remain required; this method grants no new authority and
does not restore consent. Use a new swarm when the publisher, policy or peer
configuration changes.

The complete options, callback contract, metrics and peer-first validation are
in [INTEGRATION.md](../INTEGRATION.md). The host must honour upload consent and
pass a trusted signed stream event. The optional discovery adapter below
resolves events under an explicit host policy; the loader itself opens no
discovery query.
The peer loader updates hls.js's retained statistics object and sends one
`onAbort` callback for an aborted pending peer load. `destroy` cancels without
reporting a completed load. For an accepted verified peer object, disposal of
the losing HTTP loader preserves the same stats reference and an incoming
`aborted: false`, including hls.js 1.7.3's synchronous success cleanup. It does
not normalise caller aborts or true/unknown flags; ordinary HTTP disposal and
cleanup exceptions retain their semantics. This is a correctness fix, with no
measured performance benefit.

The optional `onPeerDelivery({ connection, bytes })` callback attributes
verified peer-first media to its actual `RTCPeerConnection`. A single-holder
delivery fires once with its whole payload. A multi-holder delivery fires once
per contributing connection with only its first-verified-copy piece bytes;
origin-winning and duplicate pieces are excluded. `bytes` is a positive media
payload byte count, and all observations for an object sum to its increase in
`bytes.peerFirst`. The complete object must be accepted for the player first;
verified pieces of an incomplete or rejected object emit nothing. It runs
after all aggregate counters change and immediately before the player's success
callback. Observer exceptions and rejected promises cannot cause fallback,
prevent playback or suppress other contributions. Protocol traffic, shadow
measurements, origin fallback, failed verification and aborted or late
deliveries do not fire it. Connection
references stay local to the host; the callback supplies no URL, peer identity,
SDP or media buffer. See the [callback contract](../INTEGRATION.md#metrics).

The rotation/refusal helpers are exported for the loader's policy and tests;
most hosts only need `createHlsSwarm` and `HLS_SWARM_METRICS_VERSION`.

## Shared account upload allowance

`createAccountUploadBudget(options)` supplies the private durable reservation
ledger. Its `identity`, `authorize`, `inspectGrant`, `reserve`, `renew` and
`revokeGrant` methods are trusted server operations, not a public authentication
interface. Await `ready()` before use and `close()` during shutdown. The required
`statePath` has the private filesystem requirements described in the
[account allowance guide](ACCOUNT-UPLOAD-BUDGET.md).

The example HTTP integration is `startDemoServer({accountBudget: {...}})`.
Omitting `accountBudget` omits the service. Configure `statePath` and optionally
`resolveWebsiteAccount(request, {signal})`, which must resolve the host's
authenticated session to `{issuer, subject}`. Nostr proof verification is
supplied by the example; website authentication belongs to the host. Neither
method enables uploading, resets spend or enrols other devices automatically.

Defaults are `defaultLimit: 100000000`, `grantTtlSeconds: 120` and
`delegationTtlSeconds: 10800`. Limits accept zero through 10¹² bytes; grants
accept 30–300 seconds; delegation accepts the grant duration through 86,400
seconds. Account, identity, grant, replay-operation and pending-write bounds
refuse excess work rather than evicting recorded spend. The HTTP adapter also
bounds challenges, active requests and authentication time. This is a serial,
durable payload ledger; no high-volume capacity or physical wire metering is
claimed.

The same-origin POST routes under `/account-budget/` use a private versioned
proof contract and short-lived page-bound grants. Keep them behind HTTPS and
the configured origin; do not expose the trusted ledger methods directly or
accept viewer-supplied account subjects as authentication. The session
descriptor contains supported methods, bounds and fixed endpoint paths only.

## Example policy and session renewal

The source demo advertises `deliveryPolicySession: "inline-v1"` with
`deliveryPolicyEndpoint: "/delivery-policy.json?session=1"`. Its GET response
contains the existing policy fields plus `session`, built synchronously from
the same public descriptor used by `/session.json`, after operator readiness.
The bare policy URL and operator routes retain their existing response shapes.
The opt-in route uses exact buffered JSON, `Content-Length` and `no-store`.

The example client uses one request for an advertised inline snapshot and two
parallel requests for legacy descriptors. It applies observed OFF first, then
validates the session and prepares admission under the existing five-second
issuance lifetime. Missing or incompatible advertised data fails closed without
a legacy retry. The two-second cadence, three-pending cap and consent rules are
unchanged. `startDemoServer({policySessionSnapshot: false})` selects the legacy
contract programmatically; it has no CLI or viewer switch. This reduces renewal
requests and does not establish field reliability. See [operations](OPERATIONS.md#policy-and-viewer-consent).

## ICE transport policy

The core swarm and `startDemoServer` accept `iceTransportPolicy: "all" | "relay"`,
default `"all"`. Both demo and broadcaster CLIs expose
`--ice-transport-policy all|relay`. Invalid values are rejected before host
state or services start. A demo policy change stops peers and requires fresh
Apply and upload consent; an absent legacy descriptor means `"all"`.
Relay-only is an explicit operator privacy/compatibility choice, not a TLS
selection or a proved transfer repair. It never downgrades to `"all"`; if usable
relay connectivity is unavailable, playback retains its existing origin fallback.

## Optional demo TURN renewal

`startDemoServer({turnCredentials: {url: 'https://issuer.example/turn'}})` enables
the demo's bounded, per-viewer credential adapter. Omit it for the existing
static/default ICE path; it is mutually exclusive with `iceServers`. The demo
and broadcaster CLIs expose the same choice as `--turn-credentials-url`.
The [field guide](FIELD-TEST.md#optional-turn-credential-renewal) describes the
issuer response, limits, cookie and consent behaviour. The descriptor in
`/session.json` contains only the fixed same-origin endpoint contract.

This integration replaces demo swarms when accepted credential material changes.
An identical cached reply preserves the original lease and peers and schedules
a bounded retry; it does not extend expiry or increment the refresh counter. The core
`createHlsSwarm({iceServers})` option remains a configuration captured when the
swarm is created; no seamless ICE-restart API is added.

### Optional TLS-over-TCP URL projection

Set `turnCredentials.urlProjection: "tls-tcp"` (default `"issued"`) or use
`--turn-url-projection tls-tcp` together with `--turn-credentials-url`. This
operator selection is independent of `iceTransportPolicy`. Invalid choices or
CLI TLS projection without an issuer are rejected before private reads/state.
The default session descriptor stays unchanged; explicit selection adds only
`urlProjection: "tls-tcp"` to its TURN descriptor.

The adapter retains the raw issued URLs and lease in its private cache. In its
response it preserves explicit `turns:host[:port]?transport=tcp`, appends
`?transport=tcp` only to a valid transport-unspecified `turns:host[:port]`, and
excludes plain `turn:` and explicit UDP. Hostname, port, credentials and original
expiry/refresh boundaries are preserved. Empty/invalid projections refuse peer
configuration without unrestricted retry; origin fallback remains. The client
independently requires explicit secure TCP URLs. A selection change fences old
pending work, stops peers and withdraws upload until fresh Apply.

This is application-selected configuration, distinguishable from the original
issuer response. [RFC5928 section3](https://www.rfc-editor.org/rfc/rfc5928.html#section-3)
defines user/application transport preferences;
[RFC7350 section4.6](https://www.rfc-editor.org/rfc/rfc7350.html#section-4.6)
allows TLS or DTLS for unspecified `turns:`. Explicit TCP narrows that selection;
it does not prove issuer/server compatibility. The selected URI is then resolved
unchanged under [RFC7065](https://www.rfc-editor.org/rfc/rfc7065.html#section-3.1)
and supplied as [WebRTC ICE configuration](https://www.w3.org/TR/webrtc/#dom-rtciceserver).
TLS describes the client-to-TURN hop, not every relay-to-peer hop. Actual selected
transport and verified payload still require measurement; no delivery repair,
cost or field qualification follows from this option.

## Node HLS publisher

```js
import { createHlsPublisher } from 'relayswarm/hls-publisher';

const publisher = await createHlsPublisher({
  mediaDir: '/path/to/hls',
  manifest: 'master.m3u8',
});
```

| Option | Default | Meaning |
|---|---|---|
| `mediaDir` | required | Real local directory containing the supported playlists/media |
| `manifest` | `master.m3u8` | Entry playlist, relative to that directory |
| `secretKey` | fresh ephemeral key | Publisher's 32-byte Nostr signing key; keep server-side |
| `streamEvent` | fresh signed event | Restore a valid authorisation signed by this key and bound to this manifest |
| `swarmId` | derived from signed stream event id | Shared id, 8–128 characters |
| `now` | `Date.now` | Clock returning milliseconds; useful for deterministic tests |
| `maxConcurrent` | `8` | Simultaneous signing work, configurable from 1 to 64 |
| `maxCacheEntries` | `512` | Entries in each bounded hash/commitment cache, configurable from 1 to 4,096 |
| `allowEncryptedMedia` | `false` | Explicit AES-128 ciphertext publication; local keys remain HTTP-only |
| `pieceCommitments` | `false` | Experimental: sign exact-playlist contexts as schema 3 (one SHA-256 per piece) instead of schema 2. v0.2.1 and RelaySwarmKit v0.5.0 receivers reject schema 3; Kit v0.6.0 has an explicit schema-3 piece API |
| `commitmentSecretKey` / `delegation` | author key / none | Author-scoped delegated commitment signing; an externally authored event permits operation without the author secret |
| `revokedDelegationIds` / `delegationRevocations` | empty arrays | Host-trusted current revocation view; no automatic global lookup |

`commitment` accepts `playlist`, `mediaType` and `part` for schema 2 exact
media identity. Use `segmentMediaContext(context)` to derive the playlist,
type and encryption from hls.js. `advertisement({manifestUrl, relays, status,
starts, previousEvent, allowLoopback})` creates full linked live metadata;
delegate-only publishers must supply an externally author-signed `event`.
See [production features](PRODUCTION-FEATURES.md) and the
[protocol draft](NIP-DRAFT.md) for scope and compatibility.

The returned object contains:

- `swarmId`: selected swarm identifier.
- `streamEvent`: signed kind-30311 event with a `d` tag and the experimental
  redistribution authorisation; this is not a stream-discovery service.
- `manifestPath`: published path under `/media/`.
- `await media(path)`: resolves a currently listed media path to its contained
  real local filename. It does not serve HTTP itself.
- `await commitment(context)`: signs a kind-24172 commitment derived from a
  matching playlist record and the exact bytes on disk.
- `await playlistSnapshot(path, {fresh = false})`: returns a copied playlist
  buffer, its canonical file, presentation paths and media-playlist texts from
  the bounded authorised catalogue. `fresh` settles any earlier shared refresh
  before starting or joining the next one; it supports watch-before-read HTTP
  handling without exposing media or encryption-key bodies.
- `getMetrics()`: request, cache, streamed hashing, signing, renewal, eviction,
  changed-read, bounded playlist-retry and concurrency counters.
  `commitmentJoins` counts requests that joined an identical one already in
  flight; joined requests take no concurrency slot and are each checked
  against a catalogue and file read after they arrived. A playlist
  rejected by the byte/stat change guard gets one fresh full-catalogue retry;
  invalid data and changed segment bytes still reject. These counters do not
  measure network delivery.

Commitment input is `{ path, level, sequence, discontinuity, rangeStart?,
rangeEnd?, part? }`. The path is the published `/media/...` path; level is the
hls.js rendition index, and sequence/discontinuity match its fragment. Omit
both range fields for whole segments; otherwise use a start-inclusive,
end-exclusive range. Only a null/absent `part` is supported. Callers do not
choose the digest, size, author or expiry. Contexts absent from the current
playlist are rejected. The signed expiry is 60 seconds after the publisher clock.

`PublisherError` carries an HTTP-style `status` for expected validation/capacity
errors. Filesystem failures can also occur; a public server should mask internal
paths as the demo does. Catalogue/signing bounds and the exact supported HLS
subset are in [FIELD-TEST.md](FIELD-TEST.md#publish-your-own-media).

## Example origin HTTP playlists

`startDemoServer` supports blocking reload of compatible complete live media
playlists with target durations from one to three seconds. Its
`blockingPlaylistReload` option defaults to `true`; setting it to `false` retains
conventional playlist polling. Capability advertising is
presentation-wide: unsupported parts, delta, ended or mixed presentations do
not receive a partial blocking-reload promise. Raw pipeline files and media
bytes are unchanged.

Direct directory watches cover every currently authorised playlist basename,
including the master and other renditions, and the directory's own rename.
Named temporary files and media segments do not invalidate playlist snapshots.
Changes to filename coverage require a fresh read within the existing three
revalidation limit. On Windows, shallow watches of immediate parents also observe
playlist-directory moves and ignore unrelated siblings and named metadata events.
Missing filenames or unknown event types fail closed. If a presentation requires more than
41 watched directories, it retains its original bytes without added blocking
capability. Arbitrary ancestor-tree moves are outside this coverage.

A valid `_HLS_msn` request waits for a fresh authorised playlist containing that
sequence or a later one. Requests for sequences already removed return the
latest full playlist. Malformed directives and excessive future sequences are
rejected; ended playlists ignore sequence and part directives. Blocking has a
deadline of three initial target durations, cancellation on disconnect/shutdown
and a 24-waiter limit within the existing 32-media-request ceiling. It does not
change the loader's peer budget, origin reserve, segment durations or playback holdback.
See the [HLS blocking-reload draft contract](https://datatracker.ietf.org/doc/html/draft-pantos-hls-rfc8216bis-22#section-6.2.5.2).

The focused suite includes actual HTTP publication, capacity, timeout, abort
and shutdown checks. One injected headless Chrome loopback pair passed both
qualities and producer-restart sharing with this option enabled and disabled.
The [paired results](../spikes/results/blocking-playlist-reload-paired-browser-20261014.json)
retain recoverable 503 errors seen only with the option enabled; reliability
improvement, ordinary public and physical acceptance remain unproved.

`demo.playlistReloadMetrics()` exposes the policy, waiter limit, current blocked
requests/watchers and numeric start, release, abort, timeout, watcher-error and
rejection counts. These counters do not prove browser use or media delivery.

## Private publisher state

`await loadPublisherState(path, { manifest = 'master.m3u8', swarmId?, now? })`
returns `{ secretKey, streamEvent, swarmId }` to spread into `createHlsPublisher`.
The parent must be an existing owner-controlled directory; the state must be
a private regular 0600 file with one link. Creation publishes one complete
identity atomically, including concurrent callers. Invalid state, identity,
manifest or explicit swarm mismatches fail without overwriting it.

This helper requires POSIX file permissions; Windows ACL storage is not
implemented and fails before file access. This file contains the signing
secret. Keep it on the server and preserve it
across orderly restarts. Without this opt-in, the publisher remains ephemeral.
The other exports are validation/construction helpers; they do not manage
backups or key rotation. See [operations](OPERATIONS.md).

## Trusted stream adapter

`resolveTrustedStream(event, policy)` returns a descriptor or `null`.
`policy` requires `trustedAuthors` (at most 64 hex public keys),
`allowedMediaOrigins` (at most 32 exact HTTPS origins), `swarmId`, and 1–8
host-selected `relays`. `iceServers` defaults to an empty list, avoiding
event-selected network services; `allowLoopback: true` permits local HTTP/WS
fixtures. Invalid host configuration throws `TypeError`.

The adapter verifies the signed kind-30311 event, bounded size, one address
identifier, live status, streaming URL, time bounds and experimental
redistribution authorisation. Event-advertised relays never replace the host's
policy. A descriptor contains `{ manifestUrl, streamEvent, swarmId, relays,
iceServers, config }`. `config` starts with `serve: false`; the host supplies
mode, commitment provider and consent separately.

`await discoverTrustedStreams({ ...policy, query, signal?, timeoutMs?,
maxEvents?, maxResults?, maxTotalBytes? })` calls the host's
`query({ filters, relays, signal })`, accepting an array or asynchronous iterable.
Defaults are 5 s, 256 events, 32 results and 2 MiB total; per-event size is capped
at 16 KiB. The latest signed address update is selected before live filtering,
so an ended update suppresses an older live event. Equal timestamps select
the lowest event id. Floods, cancellation and timeout throw
`StreamDiscoveryError`, including `EVENT_LIMIT`, `ABORTED` and `TIMEOUT`.

This helper owns no sockets or fetches. The host query must close its resources
on cancellation. The host must still enforce allowed origins on redirects and
playlist assets, distinguish swarms for different streams, and establish
publisher trust. The demo's minimal authorisation event does not advertise a
complete discoverable NIP-53 broadcast.

## Broadcast pipeline

`await startBroadcastPipeline({ input, mediaDir, ffmpeg?, forwardUrl?,
allowInsecureLoopbackForward?, retryFloorMs?, retryCeilingMs?,
publicationIntervalMs?, retainGenerations?, generationGraceMs? })` returns
`{ mediaDir, manifest, metrics(), ready({ timeoutMs? }), close() }`.
Rendition playlists are republished when a directory watch on the current
generation reports the encoder's playlist rename; `publicationIntervalMs`
(250) is the fallback interval where watching is unavailable or an event is
missed, and `close()` does not wait for it. Default input is the local RTSP live path; `mediaDir` is required and must be a
dedicated owner-controlled directory. The pipeline holds an exclusive lock
until close. Unclean process termination needs operator lock recovery.
Supported inputs are RTSP, RTMP, RTMPS and SRT. Use plaintext inputs on a private
network or secure their transport separately. RTSPS is rejected because TLS
verification through that demuxer differs between supported FFmpeg versions.

FFmpeg creates 360p/700 kbps and 720p/2,500 kbps H.264 video with AAC audio,
30 fps, 2 s full MPEG-TS segments and a 12-segment live window. Both source
tracks are required. Independent input readers supervise HLS and optional
forwarding; retries default to 1–15 s, bounded to at most 60 s. Forwarding
requires RTMPS with explicit certificate/hostname verification and a 15 s
output I/O timeout. Plaintext loopback forwarding is an explicit test option.
RTMPS requires a DNS hostname and a verified TLS implementation: the supervisor
accepts FFmpeg 5 or newer with GnuTLS, or FFmpeg 8 or newer with OpenSSL, after a
bounded capability check. Earlier OpenSSL implementations do not check hostnames.

Stable playlist URLs retain continuous media sequence numbers and advance
discontinuity after a complete published generation. New generation URLs
prevent media aliasing; pruning protects media referenced by stable playlists.
`ready` defaults to a 120 s deadline; zero waits until source or shutdown.
`close` is idempotent. Metrics describe processes/publications and never include
upstream credentials; a running forward process is not platform acceptance.
The HLS worker also exposes a bounded numeric progress snapshot (frames, fps,
encoding speed, output time and sample timestamp) for actual host measurements.

`broadcastEncoderArgs(input, runDirectory, { startNumber = 0 })` and
`broadcastForwardArgs(input, output, options?)` construct argument arrays
without a shell. They do not create directories or launch processes. The
caller must enforce the same FFmpeg TLS prerequisites when launching these
arrays directly. The supervisor derives the next encoder start number from
published playlists.
See [broadcast setup](BROADCASTING.md) and [container deployment](../deploy/README.md).

## Segment commitments

`commitmentContent(fields)` returns canonical JSON with the domain
`relayswarm-segment-v1`, schema `v: 1` and fixed field order. It serialises fields;
it does not sign an event or validate media bytes.

`commitmentPieceSize(size)` returns the piece size that experimental schema 3
(`v: 3`, `relayswarm-segment-v3`) requires: at least 64 KiB, at most 64 pieces
per segment, rounded up to a multiple of 16 KiB. Schema 3 adds `pieceSize` and
one lowercase SHA-256 per piece in `pieces` to schema 2. The verifier accepts
it; the publisher signs it only with `pieceCommitments: true`. The loader
fetches and verifies pieces from several holders only with `multiHolder`
(see `INTEGRATION.md`).

`validStreamAuthorisation(event)` checks the signed kind-30311 event, a `d` tag,
bounded event size and the exact redistribution tag.

`verifySegmentCommitment(event, { streamEvent, swarmId, key, context,
maxSegmentBytes }, at = Date.now())` returns the verified fields or `null`.
It verifies the signer, tags, canonical content, timestamp/expiry and exact
fragment identity. The caller must separately hash and size-check received
media. `context` uses hls.js's `{ frag, part? }` shape, not publisher input.
See [the signed contract](../INTEGRATION.md#authenticated-peer-first-loading)
for every field and timestamp constraint.

## Relay pool and session

```js
import { RelayPool, RelaySwarmSession } from 'relayswarm';

const pool = new RelayPool(['wss://relay.example'], { reconnect: true });
const session = new RelaySwarmSession({ pool, swarmId: 'example-stream' });
try {
  await pool.connect();
  session.start();
  // Register handlers and publish presence/signals for your transport.
} finally {
  session.close();
  pool.close();
}
```

This illustrates lifetime management; `relay.example` is a placeholder.

`new RelayPool(urls, options)` requires 1–8 `wss://` relay URLs (`ws://` is
allowed on loopback). Options are `label`, `WebSocketImpl`, `connectTimeoutMs`
(8,000), `reconnect` (false), `reconnectMaxMs` (30,000) and
`readyOnFirstRelay` (false). Methods:

- `await connect()`, `close()`.
- `subscribe(filter)` → subscription id; `unsubscribe(id)` sends CLOSE.
- `onEvent(handler)` / `onReject(handler)` → unsubscribe callback.
- `publish(signedEvent)` sends to connected relays; it is not a delivery receipt.

Live subscription ids and filters are checked before signature validation and
dispatch. Reconnect mode restores active subscriptions.

`new RelaySwarmSession({ pool, swarmId, secretKey?, maxEventAgeSeconds? })`
uses a fresh ephemeral key by default; maximum event age defaults to 120 s.
`pubkey` is the session key. Methods:

- `start()` / `close()` manage a presence subscription and recipient-filtered
  signal subscription; closing the session does not close its shared pool.
- `onPresence`, `onSignal`, `onError` register handlers and return unsubscribe callbacks.
- `announcePresence({ role, transports?, have?, open?, ticket? })` returns
  the signed event. Capabilities are `{ type, publicKey, obj? }`; `have` contains
  digests. Experimental `obj` is the object framing version, an integer 1 to 15
  (absent means 1); received presence keeps a valid `obj` and drops any other.
  Session wire version 3 is unchanged, and v0.2.1 peers ignore the field.
- `sendSignal(toPubkey, { type, transport, requestId, payload? })` returns a
  signed NIP-44-encrypted event addressed to that session key.
- `waitForPresence(predicate, timeoutMs?)` / `waitForSignal(predicate,
  timeoutMs?)` resolve matching `{ from, event, payload }`; default deadline 15 s.
- `clockDiagnostics()` returns local counts `{ aheadRejected, staleRejected,
  maxAheadSeconds, signalSamples, signalAgeMedianSeconds }`: swarm events outside
  the age window, and arrival age of up to 64 recent signals that decrypted and
  validated. Acceptance rules are unchanged.

`validTicket(ticket)` validates the opaque ticket's shape/size, not permission,
signature, identity or expiry. Host admission policy supplies those decisions.

## Native transfer primitives

From `relayswarm/src/native-dht-transport.mjs`, `NativeDhtTransport` exposes
`ready`, `listen`, `authorize`, `connect` and `close`, plus its Noise `publicKey`.
Authorisation binds one remote Noise key and Nostr key to request id, digest,
size and lifetime. The default limits are 256 pending authorisations, 16 incoming
connections, 15 s connection setup and 30 s transfer lifetime. See
[the native protocol](NATIVE-TRANSPORT.md) for the security boundary.

`runNativeJourney({ relayUrls, bootstrap?, bytes?, WebSocketImpl?, timeoutMs?,
log? })` from `relayswarm/src/native-journey.mjs` starts two peers, transfers
and verifies an object, returns its measurement summary and closes resources.
It is a test/CLI orchestration helper, not a long-lived native HLS scheduler.

`relayswarm/src/object-transfer.mjs` exports `sha256Hex`, `encodeFrame`,
`decodeFrames`, `serveAuthorizedObject`, `requestObject`, `FRAME` and
`DEFAULT_MAX_OBJECT_BYTES` (256 MiB). These Buffer/stream primitives enforce
the supplied object identity and frame bounds; trusted digest discovery,
durable storage and application origin fallback remain outside them.

## Installed native client

`fetchNativeObject(descriptor, options)` returns `{bytes, receipt}` only after
independent size/digest verification. A version-1 descriptor requires
`swarmId`, `sha256`, `size`, `relayUrls`, `trustedSeeders` and optionally
`originUrl`. HTTPS/WSS are required; `allowLoopback: true` permits HTTP/WS
solely for loopback tests. The host supplies `bootstrap`, optional cancellation,
`peerTimeoutMs` (default 10,000), `timeoutMs` (30,000) and `maxObjectBytes`
(at most 256 MiB). A failed peer attempt automatically uses the configured
trusted origin; redirects and substituted content are refused.

`createNativeObjectSeeder({bytes, swarmId, relayUrls, bootstrap, secretKey,
originUrl, allowLoopback, timeoutMs})` returns `{descriptor, close}`. Serving
requires an explicit application call. Descriptors from untrusted seeders
cannot establish provenance. `validateNativeDescriptor` validates the same
policy without opening network resources.

Clients subscribe before announcing receive-only native presence (`open: false`,
empty `have`). Seeders coalesce replies globally with a minimum one-second
publication gap and cancel the pending timer on close. This permits discovery
without ephemeral history replay. Presence discloses the temporary Nostr/native
public-key link but never authorises a dial or implies an inbound service.

The installed `relayswarm-native` executable accepts `--descriptor`,
`--output`, repeated `--bootstrap`, `--peer-timeout` and `--allow-loopback`.
It requires Node and atomically creates a new verified output without
replacing an existing path. `npm run native:fetch -- --help` shows usage.


## Experimental PlayerHint command

The browser loader accepts `peerSupplyHint: true` with `coreWasm` in
peer-first mode and optional `onPlayerHint(rows)`. It exposes the same rows in
`metrics().playerHint`; the field is absent when disabled. See the
[host contract](../INTEGRATION.md#experimental-peer-supply-hint) for row fields,
unknown estimates and the restriction to tie-breaking between levels the
origin already sustains. No hls.js level is assigned by this adapter.

`loadCore(...).playerHint(supply)` returns
`{ t: "playerHint", rendition, eligibleHolders, projectedMs }` or null if the
core is unavailable. Supply contains `rendition`, `size` (nullable estimate),
`peers` (`[id, firstByteMs, bytesPerMs]`), `origin`
(`[firstByteMs, bytesPerMs]`, both null if unknown), `sharedFirstByteMs`,
`sharedRate`, `availableMs` and `maxHolders`. Times are durations in milliseconds;
the projection is not a wall-clock finish timestamp. The host filters eligible
HAVE holders before the call. The function does no I/O and reserves no pieces.

The native facade exposes `player_hint(PlayerSupply) -> PlayerCommand::PlayerHint`,
with `PlayerSupplyHint { rendition, eligible_holders, projected_ms }`. `PlayerSupply`
uses typed `PeerTiming`, optional origin `Timing`, shared `Timing`, optional
size, available milliseconds and maximum holders. Swift and Kotlin use their
platform naming conventions. Native hosts retain origin-sustainability checks
and the same eligibility filters. Discovery remains one context per media type;
other rendition counts reflect linked HAVE advertisements only. This API is
experimental and has no field acceptance evidence.
