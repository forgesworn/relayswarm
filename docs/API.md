# RelaySwarm API reference

[Documentation](README.md) · [Installation](GETTING-STARTED.md) ·
[hls.js integration](../INTEGRATION.md)

This describes v0.2.1, the published experimental prerelease. The earlier v0.1.0
assets do not include the newer production feature work. Package version `0.2.1`,
session wire version `3`, segment-commitment schemas `1`/`2` and metrics snapshot
version `2` are different version numbers. Source exports and protocol fields
are not a stable interoperability promise.

## Module entry points

| Import | Environment | Main exports |
|---|---|---|
| `relayswarm` | Node or a browser bundler | `RelayPool`, `RelaySwarmSession`, `validTicket`, `RELAYSWARM_VERSION`, `KIND_PRESENCE`, `KIND_SIGNAL`, `SWARM_TAG` |
| `relayswarm/hls-swarm` | Browser with hls.js | `createHlsSwarm`, `HLS_SWARM_METRICS_VERSION`, `rotationCandidate`, `retryAfterFor`, `readRefusal` |
| `relayswarm/segment-commitment` | Browser or Node | `commitmentContent`, `commitmentPieceSize`, `delegationContent`, `revocationContent`, `validStreamAuthorisation`, `verifyCommitmentDelegation`, `segmentMediaContext`, `verifySegmentCommitment`, `KIND_SEGMENT_COMMITMENT`, `KIND_COMMITMENT_DELEGATION`, `KIND_COMMITMENT_REVOCATION` |
| `relayswarm/hls-publisher` | Node only | `createHlsPublisher`, `PublisherError` |
| `relayswarm/publisher-state` | Node only | `loadPublisherState`, `publisherManifestPath`, `publisherSwarmId`, `publisherStreamEvent`, `validatePublisherStreamEvent`, `createCommitmentDelegation`, `createCommitmentRevocation` |
| `relayswarm/stream-discovery` | Browser or Node | `resolveTrustedStream`, `discoverTrustedStreams`, `StreamDiscoveryError` |
| `relayswarm/broadcast-pipeline` | Node with FFmpeg | `startBroadcastPipeline`, `broadcastEncoderArgs`, `broadcastForwardArgs` |
| `relayswarm/native-client` | Installed Node application | `validateNativeDescriptor`, `fetchNativeObject`, `createNativeObjectSeeder` |
| `relayswarm/publisher-advertisement` | Node or a browser bundler | `createPublisherAdvertisement`, `verifyPublisherAdvertisement` |
| `relayswarm/account-upload-budget` | Node on supported local POSIX storage | `createAccountUploadBudget`, `AccountBudgetError`, `accountBudgetError` |
| `relayswarm/package.json` | Package metadata | Name, version and declared dependencies |

The wildcard export also permits source subpaths such as
`relayswarm/src/native-journey.mjs`. These are implementation paths, not additional
stable named entry points. Do not import HyperDHT, Node filesystem or Buffer-based
object-transfer modules into an ordinary browser page.

## Browser loader

`createHlsSwarm(options)` returns
`{ attach(hls), updateTicket(ticket), stop(), metrics(), trace() }`.
`attach` wraps `hls.config.fLoader`; call it before `loadSource`. `stop` is the
origin-only kill switch and closes connections, cancels pending work, releases
held bytes and restores the original loader. Create a new swarm to participate
again. Uploading defaults to off; `mode` defaults to `shadow`.

`trace()` returns `{ v: 1, capacity, dropped, rows }`, the rows kept under
`traceRequests` (none by default): each peer-first load, eligibility
decision, peer request and origin request (whole or ranged), joined by a load
ID, and each multi-holder scheduler call with its inputs and the commands it
returned, so a recorded transfer replays against the module offline. Times are
whole milliseconds from the swarm's creation; holders are session labels, not
keys. It is kept out of `metrics()`, which receipts snapshot repeatedly.

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
reporting a completed load.

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
| `pieceCommitments` | `false` | Experimental: sign exact-playlist contexts as schema 3 (one SHA-256 per piece) instead of schema 2. v0.2.1 and RelaySwarmKit v0.5.0 receivers reject schema 3 and load those segments from origin |
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
  changed-read, bounded playlist-retry and concurrency counters. A playlist
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
Default input is the local RTSP live path; `mediaDir` is required and must be a
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
it; the publisher signs it only with `pieceCommitments: true`, and the loader
does not yet use the pieces.

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
(8,000), `reconnect` (false), and `reconnectMaxMs` (30,000). Methods:

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
