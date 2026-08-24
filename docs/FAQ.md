# FAQ

Honest answers, including the ones that concede things.

**Why not MoQ?** MoQ scales fan-out through operated relay clusters;
someone still runs the infrastructure. Complementary transport, not
audience peer-assist; a MoQ origin behind a peer swarm is a fine future
topology. See [LANDSCAPE](LANDSCAPE.md).

**Why not use P2P Media Loader as-is?** Its discovery is
WebTorrent-compatible tracker infrastructure
([FAQ](https://github.com/Novage/p2p-media-loader/blob/main/FAQ.md#what-is-tracker));
several trackers can be listed and two public defaults ship, but each is a
dedicated application-specific service somebody operates, speaking nothing a
Nostr client already speaks. Take the trackers away and viewers fall back onto
the origin, recreating the original failure. RelaySwarm does not abolish
rendezvous infrastructure - it swaps that dedicated tracker for redundant,
stream-selected Nostr relays. The build plan still evaluates extending P2P
Media Loader versus a lean core, by measurement, before writing an engine from
scratch.

**Why not wire Trystero into P2P Media Loader?** The glue is the work;
neither piece gives ABR-aware scheduling, origin-authenticated digests,
live-edge expiry, fallback budgets, churn handling, privacy tiers, or a
spec a second client can implement without either library. Full answer in
[LANDSCAPE](LANDSCAPE.md).

**Won't relays ban the traffic?** Ephemeral kinds are relayed, not stored;
acceptance is measured on relay.damus.io, nos.lol and relay.primal.net
([RESULTS](../spikes/RESULTS.md)); and the protocol lets a stream name its
own swarm relays, so no stream depends on the tolerance of relays it did
not choose.

**Browsers are harder than Node.** Measured; Chrome and Safari complete
the full flow with native WebRTC, and two browser tabs on separate machines
exchanged a verified segment with no server-side peer. What remains is NAT
variety at scale, tab behaviour and mobile tuning - deliverable work, and
said so.

**Most viewers are on phones.** By design phones consume and rarely
contribute (wifi and charging only); capacity comes from the
well-connected minority - an estimated 2-4 served peers per home
connection from typical upload asymmetry (measurement spike pending).
Playback is confirmed on iPhone Safari (ManagedMediaSource) and GrapheneOS
Vanadium.

**Is this actually decentralised?** The swarm layer has no
protocol-mandated central operator; relays are stream-named, STUN is
stream-named and often unnecessary where super-peers are reachable, and
there is no dedicated tracker and no TURN by default. The origin remains
central - the swarm distributes egress, not ingest - and the README says so
plainly.

**What if a state blocks the relays themselves?** Relays are
stream-named, so the streamer picks relays their audience can reach,
including their own. A hostile relay can drop the swarm kinds, but only for
streams that chose it; if every named relay is blocked, the swarm is gone and
the player falls back to plain HLS. The swarm inherits Nostr's
relay-censorship story and adds no new single point of failure to it.

**What if WebRTC itself is blocked or fingerprinted?** Then the swarm is
gone and viewers fall back to plain HLS; the floor is today's behaviour.
This is a real adversary capability - Russia has filtered Snowflake's DTLS
handshake, most recently from March 2026
([net4people/bbs #603](https://github.com/net4people/bbs/issues/603)).
Fingerprint resistance is future work, not quietly claimed. The more common
adversary is throttling a faraway origin. Where domestic WebRTC connectivity
remains usable, local peer reuse can reduce traffic across that bottleneck.

**Shouldn't the project run its own STUN servers?** A project-run default
would concentrate the one list nobody should hold - every swarm user's
address and join timing, under one operator. A generic public STUN server
sees an IP, a timestamp and the usual protocol attributes; it receives no
stream identifier and no media or signalling traffic, so it cannot tell
which stream (or that a stream) is involved. The decentralised answer is
stream-named STUN, a deployment guide that ships coturn, and super-peers that
make STUN unnecessary where they are reachable.

**Can a hostile peer poison or flood the swarm?** Wrong bytes fail the
origin-authenticated digest and are refetched from origin, so poisoning
costs the attacker bandwidth and consumes part of the viewer's bounded
peer-retry budget before origin fallback; the PoC's same-peer hash only proves
transport, and the docs say so. Spam is defended on both sides; relays
rate-limit, and the client bounds subscriptions, enforces event-size limits,
budgets dials, caps queues and validates cheaply before allocating any WebRTC
resource. See [THREAT-MODEL](THREAT-MODEL.md).

**Doesn't presence reveal who is watching?** Swarm events contain no social
npub and use independent per-session keys - but this is pseudonymity, not
anonymity. Anyone who knows a public stream's identifier can observe and
enumerate its ephemeral swarm activity; relays and network observers may
correlate that activity with a viewer's other Nostr use through shared
connections, IP addresses and timing; connected peers see each other's
network addresses; and NIP-44 hides payloads, not metadata
([NIP-44 limitations](https://github.com/nostr-protocol/nips/blob/master/44.md#limitations)).
Viewers who must not be observed use origin-only mode, which never touches
the swarm.

**Why not just put the origin behind a commercial CDN?** A CDN is a bigger
origin with the same two failure modes; the provider can still cut the
account, the bill still scales with the audience, and the CDN is a single
compellable party.

**What about native mobile clients (Amethyst, Damus)?** The NIP is the
interop boundary; any native client can implement from the spec and test
vectors. The loader plugin targets hls.js because that is where web live
viewing happens today; native adoption is evidence-led future work.

**Is contributing bandwidth legally risky for viewers?** Legal and
contractual risk varies by jurisdiction and by content, and a contributing
viewer is redistributing media, not merely receiving it. RelaySwarm is
intended for streams whose publisher authorises peer redistribution - the
protocol carries an explicit publisher flag for exactly that - and
contribution stays opt-in behind an interface that says plainly the viewer
is redistributing. Phones contribute nothing by default, and at-risk
viewers use origin-only mode.
