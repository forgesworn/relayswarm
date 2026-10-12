# RelaySwarm API reference

[Documentation](README.md) · [Installation](GETTING-STARTED.md) ·
[hls.js integration](../INTEGRATION.md)

This describes the experimental v0.1.0 implementation. Package version `0.1.0`,
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
pass a trusted signed stream event; the library does not perform discovery.
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
| `swarmId` | derived from signed stream event id | Shared id, 8–128 characters |
| `now` | `Date.now` | Clock returning milliseconds; useful for deterministic tests |

The returned object contains:

- `swarmId`: selected swarm identifier.
- `streamEvent`: signed kind-30311 event with a `d` tag and the experimental
  redistribution authorisation; this is not a stream-discovery service.
- `manifestPath`: published path under `/media/`.
- `await media(path)`: resolves a currently listed media path to its contained
  real local filename. It does not serve HTTP itself.
- `await commitment(context)`: signs a kind-24172 commitment derived from a
  matching playlist record and the exact bytes on disk.

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
