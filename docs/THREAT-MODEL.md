# Threat model - outline

The PoC is deliberately not production-secure; it proves feasibility, not
robustness. This outline states what the deliverable engine must defend and
how it will be tested, ahead of implementation, so the adversarial suite is
a commitment rather than an afterthought. The full written threat model
ships with the engine.

## Implemented boundaries

The browser peer-first loader verifies an author-signed, canonical and
expiring segment commitment, including stream/rendition/sequence/discontinuity/
part and object identity. It checks the experimental publisher redistribution
tag; delegated signers are not supported. The original CLI PoC is unchanged.

Regression tests cover request floods, empty/excessive chunks, upload stalls,
expired admission on retries, delayed admission during shutdown, relay startup
recovery, late reconnects, commitment substitution and origin fallback. Real
Chrome tests require tampering detection, compare playback stalls with a
baseline, check shutdown resources and prove peer-first avoids origin requests.
Native nodes bound pending authorisations and active transfers.

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
  Connection separation is an engine design question, not a solved one.
- **Origin capacity** - the resource the swarm exists to protect.

## The core defence: authenticated segment commitments

The PoC verifies a transfer against a SHA-256 hash supplied by the sending
peer. That proves transport, not provenance - a malicious seeder controls
both the bytes and the hash. The engine therefore accepts a peer-delivered
segment only against a digest **signed by an authorised signer or fetched
from the HTTPS origin**, bound to the stream, the rendition, the media
sequence number and an expiry. Wrong bytes fail the check and the segment
is refetched from origin; poisoning costs the attacker bandwidth and consumes
part of the viewer's bounded peer-retry budget before origin fallback.

"Authorised signer" needs defining precisely, or the design is only
conceptually right. Exactly one of:

1. the **author of the NIP-53 stream event** (kind 30311) the swarm is
   bound to; or
2. a **short-lived commitment key explicitly delegated by that author** in
   a signed, expiring authorisation the viewer can verify against the
   stream event.

Nothing else counts, and a commitment whose signer chain does not resolve
to the stream author is treated as hostile. Two further requirements the
spec must carry, since an interoperable security protocol cannot leave
them to implementers: a **canonical encoding** of the commitment (a fixed
field order and serialisation, so two implementations hash identical bytes)
and **domain separation** (a scheme-specific prefix in the signed message,
so a commitment signature can never be replayed as any other Nostr
signature and vice versa).

Streams also carry an explicit **peer-redistribution authorised** flag;
absent it, clients do not form a swarm. Peer assistance is something a
publisher opts into for their own stream, not something viewers may switch
on for any HLS URL.

## Adversarial suite

Each of these is a test the engine must pass, not a paragraph:

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
limits, budgets concurrent dials, caps queues, and validates cheaply
(signature, tags, size) before allocating any WebRTC resource. Fake
presence announcements cost the attacker signatures and cost the client at
most a capped dial budget; the scheduler scores peers and prefers proven
ones.

## Out of scope, stated plainly

- **Metadata privacy.** NIP-44 hides event payloads, not metadata; relays
  see kinds, tags, timing and connecting IPs, and anyone who knows a public
  stream's identifier can observe its swarm activity. See the privacy
  section of the [README](../README.md).
- **WebRTC protocol fingerprinting.** A state that filters DTLS takes the
  swarm down to plain-HLS fallback; resistance is future work, not quietly
  claimed here.
- **A hidden origin.** The swarm distributes egress, not ingest; onion
  service support gives at-risk viewers a fetch path, it does not conceal
  where the stream is made.
