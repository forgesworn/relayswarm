# RelaySwarm API reference

[Documentation](README.md) · [Installation](GETTING-STARTED.md) ·
[hls.js integration](../INTEGRATION.md)

This describes the current experimental source, including the unreleased
broadcaster pilot. The immutable v0.1.0 assets do not include the new publisher
state, discovery or broadcast entry points. Package version `0.1.0`,
session wire version `3`, segment-commitment schema `1` and metrics snapshot
version `2` are different version numbers. Source exports and protocol fields
are not a stable interoperability promise.

## Module entry points

| Import | Environment | Main exports |
|---|---|---|
| `relayswarm` | Node or a browser bundler | `RelayPool`, `RelaySwarmSession`, `validTicket`, `RELAYSWARM_VERSION`, `KIND_PRESENCE`, `KIND_SIGNAL`, `SWARM_TAG` |
| `relayswarm/hls-swarm` | Browser with hls.js | `createHlsSwarm`, `HLS_SWARM_METRICS_VERSION`, `rotationCandidate`, `retryAfterFor`, `readRefusal` |
| `relayswarm/segment-commitment` | Browser or Node | `commitmentContent`, `validStreamAuthorisation`, `verifySegmentCommitment`, `KIND_SEGMENT_COMMITMENT` |
| `relayswarm/hls-publisher` | Node only | `createHlsPublisher`, `PublisherError` |
| `relayswarm/publisher-state` | Node only, unreleased | `loadPublisherState`, `publisherManifestPath`, `publisherSwarmId`, `publisherStreamEvent`, `validatePublisherStreamEvent` |
| `relayswarm/stream-discovery` | Browser or Node, unreleased | `resolveTrustedStream`, `discoverTrustedStreams`, `StreamDiscoveryError` |
| `relayswarm/broadcast-pipeline` | Node with FFmpeg, unreleased | `startBroadcastPipeline`, `broadcastEncoderArgs`, `broadcastForwardArgs` |
| `relayswarm/package.json` | Package metadata | Name, version and declared dependencies |

The wildcard export also permits source subpaths such as
`relayswarm/src/native-journey.mjs`. These are implementation paths, not additional
stable named entry points. Do not import HyperDHT, Node filesystem or Buffer-based
object-transfer modules into an ordinary browser page.

## Browser loader

`createHlsSwarm(options)` returns `{ attach(hls), stop(), metrics() }`.
`attach` wraps `hls.config.fLoader`; call it before `loadSource`. `stop` is the
origin-only kill switch and closes connections, cancels pending work, releases
held bytes and restores the original loader. Create a new swarm to participate
again. Uploading defaults to off; `mode` defaults to `shadow`.

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

The returned object contains:

- `swarmId`: selected swarm identifier.
- `streamEvent`: signed kind-30311 event with a `d` tag and the experimental
  redistribution authorisation; this is not a stream-discovery service.
- `manifestPath`: published path under `/media/`.
- `await media(path)`: resolves a currently listed media path to its contained
  real local filename. It does not serve HTTP itself.
- `await commitment(context)`: signs a kind-24172 commitment derived from a
  matching playlist record and the exact bytes on disk.
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
  the signed event. Capabilities are `{ type, publicKey }`; `have` contains digests.
- `sendSignal(toPubkey, { type, transport, requestId, payload? })` returns a
  signed NIP-44-encrypted event addressed to that session key.
- `waitForPresence(predicate, timeoutMs?)` / `waitForSignal(predicate,
  timeoutMs?)` resolve matching `{ from, event, payload }`; default deadline 15 s.

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
