# Production feature work

[Documentation](README.md) · [Delivery requirements](PRODUCTION-READINESS.md) ·
[Evidence](STATUS.md) · [Protocol draft](NIP-DRAFT.md)

These changes belong to v0.2.0, the published experimental prerelease. They are
absent from the earlier v0.1.0 assets. Production acceptance remains a separate
gate; consult the delivery checklist for its current state.

## Browser delivery and media

Connected viewers exchange bounded contributor/rendition interests and short
origin-fetch leases. A contributor fetches fresh live media from HTTP while
other interested viewers may wait for verified peer availability within their
playback deadline. Peer claims are advisory: lack of availability, expiry,
invalid signatures or insufficient playback buffer use the HTTP loader.
Measured HTTP latency raises the origin reserve; peer transfer estimates
cannot spend the time retained for fallback. hls.js retains bitrate selection.

Commitment, admission and persistent-reservation host callbacks receive an
operation-specific signal. A deadline aborts that signal and stops waiting
for the result. Host callbacks must honour the signal to cancel their I/O.
The bundled demo passes it to its HTTP requests; stopped or expired operations
fence late results.

The demo retains fatal/native decoder records and allows one deferred attempt
to recover a fatal append/MediaSource-reset error. It restores the HTTP loader,
stops contribution, clears upload consent and retries the current live/VOD
position. Advancing playback must be observed within ten seconds; repeated
failure, user cancellation or publisher changes stop recovery. Budget state
is preserved. A recovered outcome does not erase the fatal error or establish
the cause of an earlier unrelated failure.

The same single repair budget also covers a reproduced nonfatal live stall:
successful playlists advance to a new continuity outside the current buffer,
while decoded frames and playback time remain stopped for ten seconds. The
demo restarts loading at the fresh live position through hls.js's public API.
Actual rolling-playlist tests retain the failing control, recovered video,
cancelled held requests and a ten-second no-progress failure. This does not
establish the cause of the older hosted MSE append error.

For an established live main playlist, the demo extends HTTP 502/503/504
retries within one fixed 60-second window from the first eligible failure;
the 32nd eligible failure refuses another retry. Quality changes do not renew the window;
a successful playlist update does. Scheduled extended retries are checked
again before dispatch, so hiding or replacing the player, or reaching the
deadline, prevents new retry I/O. Startup, VOD, other HTTP errors, request
timeouts, fragments and keys retain their original policies. Permanent
outages can therefore take longer to become fatal. Fatal records, peer
deadlines, account allowances and upload consent remain unchanged.

The publisher supports exact local playlist identities for mixed codec and
frame-rate variants, alternate audio, fMP4 maps, complete low-latency parts and
warm delta playlists. Schema 1 remains valid for its original contexts.
Schema 2 binds the exact playlist, media type and encryption context rather
than relying on a player's filtered level number. Init maps and keys remain
on HTTP. A part-capable host explicitly enables `swarmParts`; the demo exposes
that choice through `mediaCapabilities.parts`. Its 500 ms part reserve is
specific to the tested one-second-part/three-second-hold-back configuration;
the library default remains 2,000 ms and measured HTTP latency can raise it.

AES-128 ciphertext publication requires `allowEncryptedMedia: true`. A
commitment binds the local key path and IV; it neither publishes the key to
peers nor grants rights to redistribute protected media. DRM/SAMPLE-AES,
subtitles, I-frame variants, remote/query-bearing publisher assets and cold
delta reconstruction remain unsupported. Preload hints do not authorise
incomplete bytes for peer delivery.

## Signing and discovery

An author can sign a short-lived commitment delegation scoped to a stream,
swarm, delegate, rendition/media types, parts and maximum size. The signing
server can then operate with the delegate secret and the signed authorisation
without retaining the author's secret. Clients enforce scope, expiry and the
host's current revocation view. They do not infer that an offline revocation
list proves the absence of a newer revocation.

Full signed NIP-53 advertisements use a separate addressable identifier and
link the persistent commitment authorisation. Live/ended updates carry an
explicit streaming URL, relays, start time and bounded expiry. They do not
change the stable commitment identity. Discovery can require host-pinned
authorisations; event-selected relays and ICE servers do not replace host
endpoint policy. `/stream.json` exposes the current signed advertisement.

## Admission and upload allowance

The demo issues short-lived swarm/key-bound tickets after a signed one-use
possession challenge. Issuance, challenges and verification have separate
bounds. Revocation and epoch rotation are authenticated operator actions;
browser admission is checked again before connections, signalling and media
uploads. The embedded relay refuses unadmitted presence and signals and has
both connection and aggregate message bounds. These controls constrain work
and participating keys; they do not establish unique people or make an open
ticket endpoint a subscription service. Proxy headers do not establish a
trusted client address.

The browser saves media reservations under an origin-wide Web Lock and
origin storage record. Reloads and concurrent tabs share spent bytes;
upload consent and signing keys are never saved. Blocked, corrupt or
unavailable storage disables contribution. Viewers may deliberately increase
or reset the allowance. The quota covers reserved media payload, including
interrupted sends, rather than complete connection traffic.

An optional private account ledger adds reservations shared across devices.
The example supports explicit Nostr sign-in and a host-supplied authenticated
website account. Linking requires both proofs, adds recorded spend and retains
the lower limit. Connection and account changes leave upload consent off;
grants and identities stay outside swarm traffic and receipts. See the
[account allowance guide](ACCOUNT-UPLOAD-BUDGET.md) for persistence, privacy,
failure behaviour and the remaining acceptance scope.

## Operations and recovery

Opt-in reports carry a temporary page report identifier and sequence alongside
numeric cumulative values. Retries are idempotent, older snapshots do not
double-count, and decreasing counters are rejected. Private bounded state
retains policy, origin counters and the latest reports across orderly restart.
Origin counters use a short write debounce; they are observations rather than
an exact crash-proof billing ledger. Retention limits apply after reopening.

Broadcaster publication and worker supervision use two permanent SQLite lease
inodes on supported local POSIX filesystems. A worker guardian owns encoder
and forwarder process groups. On parent termination it kills and waits for
those workers before releasing its lease. An independent dirty marker is
written before launch and cleared only after cleanup. A killed guardian or
host catastrophe leaves recovery closed for explicit operator inspection;
PID namespace guesses and timed stale-lock deletion are not used. Distributed
volumes and Windows private-state ACLs are unsupported. Node 22.13+ is required.

## Installed native client

The installable package supplies `relayswarm-native` and the
`relayswarm/native-client` API. An application supplies a trusted descriptor
with digest, size, swarm, relay endpoints, allowed seeders and an optional HTTPS
origin. A bounded HyperDHT/Noise attempt precedes automatic verified HTTP
fallback. Redirects are refused. Exact size and SHA-256 are checked before
bytes are returned or a new output file is published. Cancellation does not
start fallback, and existing output files are never replaced.

Connections require the expected Noise key and acknowledged handshake writes
within one connection deadline. Final completion checks the absolute transfer
deadline even when synchronous work delays an abort timer. Discovery accepts
valid presence within its configured age bound while encrypted signals retain
their shorter subscription window.

The receiver subscribes before announcing receive-only native presence, with
no held objects and `open: false`. A seeder coalesces live replies globally to
at most one per second, using one timer and no requester map; close cancels a
pending reply. Relay history is optional for ephemeral events. This public
readiness metadata links the temporary Nostr identity and native public key;
only an exact signed dial can grant a transfer.

This entry point requires installed Node; it is not a self-contained binary.
The original `native-poc.mjs` remains a separate two-peer proof, with its
original failure-reporting behaviour. Neither client is durable media storage.
