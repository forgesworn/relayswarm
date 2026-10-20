# RelaySwarm threat model

[Documentation](README.md) · [Release evidence](STATUS.md) ·
[Integration](../INTEGRATION.md)

This describes the implemented experimental boundaries and the remaining
adversarial work at v0.2.0. Passing named regression cases does not establish
production security or completion of the threat model. The original CLI,
browser loader and native path have different trust assumptions.

## Implemented boundaries

The browser peer-first loader verifies an author-signed, canonical and
expiring segment commitment, including stream/rendition/sequence/discontinuity/
part and object identity. It checks the experimental publisher redistribution
tag; current source also permits explicitly author-scoped delegated signers.
The original CLI PoC is unchanged.

Regression tests cover request floods, empty/excessive chunks, upload stalls,
expired admission on retries, delayed admission during shutdown, relay startup
recovery, late reconnects, commitment substitution and origin fallback. Real
Chrome tests require tampering detection, compare playback stalls with a
baseline, check shutdown resources and prove peer-first avoids origin requests.
Native nodes bound pending authorisations and active transfers.

The example Node publisher signs only a full-segment context present in its
local playlists, including the exact byte range and discontinuity. It serves
listed media rather than arbitrary directory files and rejects symlink escapes.
Its key stays on the server; current source can persist a private identity
in an owner-controlled 0600 file. This is an example publisher,
not a trusted-stream discovery service: a real host must still establish which
stream author it trusts. The demo's relay and HTTP endpoints have resource bounds. Current source
adds key-possession tickets and live revocation; open issuance does not prove
unique participants or complete Sybil resistance. Receipts
stay in the browser until downloaded; optional reporting requires viewer
opt-in and accepts only bounded numeric summaries, without a swarm public key.
These controls do not establish unique participants or net cost.

The example origin's [complete-playlist blocking reload](API.md#example-origin-http-playlists)
uses the current authorised catalogue and a fixed deadline of three initial
target durations. At most 24 requests may wait inside the existing 32-media
request limit. Disconnect/shutdown releases waiters and shared directory
watchers; media bytes, signing scope and peer deadlines are unchanged. Required
coverage is limited to 41 directories per request, including shallow Windows
parent watches; excess coverage retains ordinary HTTP without added capability.
Direct watches cover all authorised playlist basenames and directory renames;
unrelated named media/temporary-file events are ignored. Filename coverage changes
consume the existing bounded revalidation budget. Parent-only watches ignore
unrelated siblings and named metadata events; missing filenames or unknown
event types fail closed. These limits do not
establish Internet capacity or hard cancellation of kernel I/O.

Broadcaster workers use a detached wrapper that remains their process-group
leader until draining finishes. Only that executing wrapper signals its own
group; the guardian sends commands over the original private IPC channel and
uses numeric group IDs only for absence probes. Clean shutdown requires a drain
witness, closed output pipes, settled IPC sends and observed group absence within
the existing deadline. Missing evidence retains the dirty recovery fence.
Guardian death and whole-host loss still require operator recovery. There are
four logical worker slots and one additional Node wrapper per occupied slot;
local sampled resource checks do not establish production capacity.

The optional [account allowance](ACCOUNT-UPLOAD-BUDGET.md) introduces a separate
private trust boundary: its service learns a stable Nostr identity or the host's
authenticated website subject and can correlate participating devices. Explicit
linking reveals the association between those identities. The private ledger
stores service-scoped pseudonyms and durable cumulative reservations; its
secret and grant records require protection as account data. Stable identities
and grants are excluded from swarm events, SDP, peer messages and downloaded or
submitted reports. Host authentication, HTTPS and ledger preservation remain
required. An open Nostr account service cannot establish unique humans or
prevent someone deliberately using unrelated identities.

These are specific tested boundaries, not completion of the adversarial suite
below. Sybil resistance, broad NAT/mobile coverage and independent-client
protocol interoperability remain outstanding.

## Assets

- **Segment integrity** - a viewer must never play bytes the streamer did
  not produce.
- **Viewer availability** - peer assistance must degrade to plain HLS, not
  to a broken player.
- **Viewer privacy floor** - swarm events must carry no social npub and use
  independent per-session keys, and non-participation (origin-only mode)
  must be free. This is pseudonymity, not anonymity; relays and network
  observers may still correlate swarm activity with a viewer's other Nostr
  use through shared connections, IP addresses and timing, and a client
  that reuses one relay connection for both makes that correlation trivial.
  The browser loader creates its own swarm relay pool, but shared IPs/timing
  still permit correlation; applications using the lower-level session API
  must also consider which connections they share.
- **Origin capacity** - the resource the swarm exists to protect.

## The core defence: authenticated segment commitments

The original PoC verifies a SHA-256 hash supplied by the sending peer. That
proves transport, not provenance: a malicious seeder controls bytes and hash.
Shadow mode instead compares with origin bytes, while the browser peer-first
loader requires a commitment signed by the **same author as the selected
kind-30311 stream event**. It binds stream/event identity, swarm, rendition,
sequence, discontinuity, part, segment key, digest, size and expiry. Wrong
bytes fail verification, the peer is banned, and the normal origin loader is
the fallback. Receiving a digest over HTTPS alone does not satisfy the
current peer-first signature contract.

The verifier requires fixed field order and exact canonical JSON with the
`relayswarm-segment-v1` domain and schema version 1. It rejects altered fields,
other signers, expired/stale events and substituted media contexts. The precise
contract is in [INTEGRATION.md](../INTEGRATION.md#authenticated-peer-first-loading).
Current source implements author-scoped expiring commitment keys and a
host-supplied revocation view; [production features](PRODUCTION-FEATURES.md)
describes the trust and availability boundary.
The host still establishes which publisher it trusts. A malicious authorised
publisher can sign harmful bytes; cryptographic integrity is not moderation.

Streams also carry an explicit **peer-redistribution authorised** flag;
absent it, clients do not form a swarm. Peer assistance is something a
publisher opts into for their own stream, not something viewers may switch
on for any HLS URL.

## Adversarial suite

These are areas for the full adversarial suite. Some individual cases are
already regressed above; broader combinations remain outstanding:

- Wrong bytes under every digest arrangement (peer-supplied, stale,
  cross-rendition, cross-stream).
- Replay of expired segments and cross-rendition substitution.
- Sybil presence floods - thousands of fake peers announcing.
- Malformed and oversized SDP payloads.
- Resource exhaustion - connection floods, chunk floods, slow-loris peers.
- Relay withholding and selective event dropping.
- A compromised super-peer serving many viewers.

## Client-side resource defence

Event spam is not only the relays' rate-limiting problem; a client must
defend itself. The engine bounds its subscriptions, enforces event-size
limits, budgets concurrent dials and caps queues. Relay frames must match a
live subscription id/filter before signature validation and dispatch; signals
are subscribed to by recipient, while presence remains swarm-wide. The loader
bounds admission checks and transfers and uses availability, rotation/referrals
and deadlines. This is not an implemented reputation or Sybil-resistance system:
validly signed fake presence can still consume bounded client work.

## Out of scope, stated plainly

- **Metadata privacy.** NIP-44 hides event payloads, not metadata; relays
  see kinds, tags, timing and connecting IPs, and anyone who knows a public
  stream's identifier can observe its swarm activity. See the privacy
  section of the [README](../README.md).
- **WebRTC protocol fingerprinting.** A state that filters DTLS takes the
  swarm down to plain-HLS fallback; resistance is future work, not quietly
  claimed here.
- **A hidden origin.** The swarm distributes egress, not ingest. No dedicated
  onion-service support or origin-concealment feature is implemented.
