# RelaySwarm experimental protocol draft

This is a local specification of the implemented RelaySwarm session and browser
object contracts. It is **not an accepted Nostr NIP**. Session wire version 3,
commitment schemas 1 and 2, the browser object framing and native object framing
have separate version boundaries. The original `poc.mjs` uses older plaintext
signalling and must not be described as this encrypted contract.

## Session events

Every event uses NIP-01 canonical serialisation and a valid BIP-340 signature.
The swarm identifier is exactly one `x` tag. Signal events have exactly one `p`
recipient tag. Presence events must not contain recipient tags. Senders use
throwaway Nostr identities; presence does not establish a trusted media author.

| Contract | Implemented value |
|----------|-------------------|
| Presence kind | `24170` |
| Signal kind | `24171` |
| Session version | JSON field `v: 3` |
| Signal encryption | Pairwise NIP-44 v2; mandatory |
| Sender event age | At most 120 seconds old; at most 30 seconds ahead |
| Presence JSON limit | 16 KiB UTF-8 |
| Signal ciphertext limit | 64 KiB UTF-8 |
| Decrypted signal limit | 8 KiB UTF-8 |
| Relay frame limit | 1 MiB |

Presence content has this shape:

```json
{"v":3,"role":"watcher","transports":[{"type":"webrtc","publicKey":"<64 lowercase hex characters>"}],"have":[],"open":true}
```

`role` and transport `type` are lowercase tokens, up to 32 characters, matching
`[a-z0-9][a-z0-9-]*`. `transports` is required and contains at most eight entries.
`have` is required and contains at most 32 lowercase 64-character hexadecimal
object keys. `open` is optional and advisory. An optional opaque `ticket` is a
non-empty string of at most 2 KiB UTF-8; admission is the host's responsibility.
A browser WebRTC capability uses the peer's Nostr public key. A native
`hyperdht-v1` capability uses its DHT transport public key.

Signal plaintext has this shape, then the whole JSON object is NIP-44 encrypted:

```json
{"v":3,"type":"offer","transport":"webrtc","requestId":"<request identifier>","payload":{"sdp":"<complete SDP>"}}
```

`type` and `transport` use the same token rule. `requestId` is 8–64 ASCII
characters from `[a-zA-Z0-9_-]`. `payload` is an object. Browser offers, answers
and rejects must match the pending counterparty, transport and request ID.
SDP appears in `payload.sdp`. Browser admission is checked before revealing an
answer and again after asynchronous negotiation. Native `dial` and `ready`
payloads bind the transport public key, expected SHA-256 and exact object size;
see [Native transport](NATIVE-TRANSPORT.md).

A peer must not reinterpret a missing version or an unsupported version as
plaintext. RelaySwarm's current session rejects version 2. The NIP-44 encryption
version is not the RelaySwarm session version.

## Browser object exchange

A WebRTC data channel carries JSON text controls and binary chunks. At most one
response is in flight in each direction. A binary chunk is at most 16 KiB.

| Message | Meaning |
|---------|---------|
| `{"t":"have","keys":["<key>"]}` | Complete advertised key set, capped at 256 |
| `{"t":"have","add":["<key>"],"del":[]}` | Bounded key-set update |
| `{"t":"want","id":1,"k":"<key>"}` | Request one object |
| `{"t":"meta","id":1,"size":262181}` | Exact response size; chunks follow |
| Binary messages | Response bytes, serialised between `meta` and `eof` |
| `{"t":"eof","id":1}` | Response complete |
| `{"t":"none","id":1}` | Object unavailable or serving declined |

Control text is capped at 64 KiB. Object size is limited by the host's configured
segment cap, at most 16 MiB. `meta` cannot override the independently verified
commitment size. Repeated headers, excessive chunks, empty chunks and response
size overflow fail the transfer. Timeout or cancellation closes a receiving
link, because untagged late binary chunks cannot safely be reused by another
request. Upload queues and backpressure have bounded capacities and deadlines.
Optional `contribution` and `fetching` controls coordinate serving and short
fetch leases; they are advisory and never authorise media or spend upload
allowance.

An object key identifies the host's canonical media URL/range within a swarm;
it is **not** the content digest. The local publisher uses SHA-256 over
`swarmId + "\n" + path`, appending `#start-end` for an exclusive-end byte range.
Hosts with CDN aliases or query-bearing URLs must define their trust policy
explicitly. A peer's `have` claim or `meta` message never establishes provenance.

## Signed media commitments

Commitments use kind `24172`, one `x` swarm tag and one `e` tag naming the stable
stream authorisation event. That event is signed by the trusted media author,
has kind `30311`, one `d` identifier and explicit
`["relayswarm","redistribute","1"]` consent.

Schema 1 uses domain `relayswarm-segment-v1` and binds the stream event ID, swarm,
object key, numeric rendition, sequence, discontinuity, part index or `null`,
SHA-256, exact size and expiry. Schema 2 uses `relayswarm-segment-v2` and adds
`playlist`, `mediaType` and `encryption`; its `rendition` is the exact playlist
identity. This avoids treating player level indices, which codec filtering can
renumber, as trusted media identities. Content must equal the canonical field
order emitted by `commitmentContent` in
[segment-commitment.mjs](../src/browser/segment-commitment.mjs).

The receiver independently matches every context field. Commitments are at
most 120 seconds old, at most 30 seconds ahead and expire within 300 seconds of
verification. The local publisher normally signs for 60 seconds. Size is
positive and within the host's segment cap. The actual received bytes must
match the signed size and SHA-256 before delivery to the player.

Schema 2 permits alternate audio and complete LL-HLS parts. Delta playlists
require a bounded previously verified catalogue; a cold delta cannot establish
omitted contexts. Init maps remain HTTP assets. Identity AES-128 requires an
explicit publication policy and signs ciphertext plus exact key URI/IV
metadata. Content keys stay on the HTTP path and are never peer objects.
SAMPLE-AES, DRM, subtitle and I-frame rendition publication are unsupported.

## Scoped commitment delegation

Kind `24173`, domain `relayswarm-commitment-delegation-v1`, authorises one
commitment public key under the trusted author's signature. Its canonical
content binds `streamEventId`, `swarmId`, `delegatePubkey`, `notBefore`,
`expiresAt`, `renditions`, `mediaTypes`, `allowParts` and `maxSegmentBytes`.
Scopes contain at most 40 exact rendition identifiers. Delegation expires no
later than one hour after issuance. A delegated commitment includes
`["delegation","<delegation event ID>"]`, matches every scope restriction and
cannot outlive the delegation.

Kind `24174`, domain `relayswarm-commitment-revocation-v1`, revokes an exact
delegation ID under the same author's signature, stream and swarm. Hosts supply
a bounded current revocation view or explicit revoked IDs. Verifiers do not
query relays and absence from a supplied view does not prove global absence of
revocation. Replacing the trusted stream authorisation also invalidates scopes
bound to its old event ID. A delegate is not authorised to sign live metadata.

## Live metadata and stable authorisation

The local publisher keeps the minimal commitment authorisation stable across
restarts. A separate full NIP-53 kind `30311` advertisement uses address
`live-<stable authorisation event ID>`, so renewing live status does not replace
the event to which commitments and delegations bind. Its signed tags include
`streaming`, `status`, `starts`, `expiration`, `relays`,
`relayswarm-authorisation` and `relayswarm-swarm`. Ended advertisements include
`ends`. The RelaySwarm-specific linking tags are experimental extensions.

Advertisements expire within five minutes and require HTTPS/WSS endpoints.
Loopback HTTP/WS requires explicit test opt-in. Discovery pins the linked
stable authorisation using `streamAuthorisations`, checks the same author and
host-selected swarm, and preserves the host's allowed origins, relay and ICE
policies. Event-suggested endpoints cannot expand those policies. The latest
ended, withdrawn or unsafe update suppresses older live metadata. The host
must obtain current metadata; a stable signature alone does not prove that a
stream is still live. `previousEvent` gives immediate lifecycle updates a later
creation timestamp within the allowed clock tolerance, avoiding an addressable
event ID tie. Standard NIP-53 fields are described in the
[upstream draft](https://github.com/nostr-protocol/nips/blob/master/53.md).

## Measured Swift interoperability boundary

On 13 October 2026, `test/interop-swift.mjs` tested public RelaySwarmKit revision
[`7eb042ee0fc0e960780c61d755a2ec50f1a8be40`](https://github.com/forgesworn/relayswarm-kit/tree/7eb042ee0fc0e960780c61d755a2ec50f1a8be40)
with its pinned secp256k1 dependency and macOS arm64 libdatachannel binary.

| Gate | Measured result |
|------|-----------------|
| Unmodified Kit `SwarmSignaller` ↔ RelaySwarm v3 | Incompatible in both directions |
| Kit NIP-44/signatures ↔ JavaScript | Compatible in the exercised encrypted session |
| Explicit Swift v3 fixture adapter ↔ JavaScript session | Encrypted presence/offer/answer journey passed |
| Kit libdatachannel ↔ JavaScript werift/production `PeerLink` | 262,181-byte transfer in 17 chunks passed |
| Independent Swift commitment verification | 12 schema/context/signature/expiry cases passed |
| Corrupted bytes over the real WebRTC channel | Rejected against the signed commitment |
| Plaintext and malformed encrypted session probes | Rejected by the fixture adapter |
| Published Swift v3 client, physical devices, NAT variety | Not proved |
| Kit ↔ HyperDHT native transport | Unsupported by the inspected Kit |

The test adapter uses unchanged pinned toolkit crypto, relay and WebRTC
components, but adds a separate strict v3 envelope parser and browser object
receiver inside this repository. Its passing journey **does not establish
compatibility of the unmodified or released Kit client**. The stock Kit uses
presence version 2, signal version tags and top-level `type`/`sdp`, and retains a
plaintext fallback. Current RelaySwarm accepts none of those as v3 sessions.

Run `node test/interop-swift.mjs --evidence artifacts/relayswarm-swift-interop-current.json`
on macOS arm64 with Swift and authenticated read-only `gh` access. It fetches
exact public component sources into an owned scratch package, compiles with four
jobs, records source hashes and results, then removes its downloads/build and
fixture services after success. The named receipt is retained. A failed build
keeps owned scratch for diagnosis and reuse; remove it once its evidence is
recorded. No external repository is edited.

### Concrete Kit migration proposal

Changes are required in the separate RelaySwarmKit repository before claiming
stock cross-client compatibility:

1. Update `Sources/RelaySwarmSignalling/Swarm.swift` to emit/require `v:3`,
   transport, request ID and nested payloads; require NIP-44 for every signal.
   Remove automatic plaintext fallback from the default API. If legacy support
   remains, expose it through a separately named opt-in API and never negotiate
   down from v3.
2. Extend presence with bounded transport capabilities, object keys, optional
   upload availability and opaque host admission tickets. Apply the v3 age,
   recipient uniqueness, payload and byte limits before dispatch.
3. Update `Sources/RelaySwarmTransport/SwarmHost.swift` so answers preserve the
   pending request ID and transport, with admission before disclosing SDP.
   Supply bounded `have`/`want`/`meta`/binary/`eof` framing rather than assuming
   arbitrary host broadcasts are authenticated HLS objects.
4. Add an independent signed commitment module covering schemas 1 and 2,
   current author/delegation/revocation trust, exact fragment context and byte
   verification. Preserve receive-only/upload-consent semantics in the consuming
   application; a verified commitment is not viewer consent to serve.
5. Run this real interop journey against the updated public APIs, without the
   fixture adapter, and add Swift negative tests for version downgrade,
   misrouted/replayed events, context confusion, chunk floods and cancellation.
   Release and pin that tested Kit revision before publishing compatibility
   claims. HyperDHT support would be a separate transport implementation.


The concrete [Kit review proposal](interop/README.md) includes an exact-source
patch and SHA-256 manifest. Its full local SDK suite passed 25 tests with one
public-relay test skipped. That proposal is unapplied to the external repository;
merging/releasing it and proving a published HLS consumer remain separate gates.
