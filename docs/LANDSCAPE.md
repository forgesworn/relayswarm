# RelaySwarm landscape

[Documentation](README.md) · [FAQ](FAQ.md) · [Current scope](STATUS.md)

Documentation comparison refreshed on 12 October 2026 from the linked primary
sources. This is a comparison of documented roles, not a performance benchmark,
an exhaustive novelty claim or evidence of integration between projects.

| Project | Documented role | Relationship to RelaySwarm |
|---|---|---|
| [P2P Media Loader](https://github.com/Novage/p2p-media-loader) | Peer-assisted media delivery; its [FAQ](https://github.com/Novage/p2p-media-loader/blob/main/FAQ.md#what-is-tracker) specifies WebTorrent-compatible trackers for WebRTC signalling | Closest HLS-engine comparison; RelaySwarm uses Nostr rendezvous and an experimental stream-author commitment contract |
| [Trystero](https://github.com/dmotz/trystero) | Generic WebRTC matchmaking and data/media APIs across several signalling strategies; the default package uses Nostr | Nostr-signalled browser transfer already exists; an HLS host still needs media-context, deadlines, provenance and consent integration |
| [MoQ working group](https://datatracker.ietf.org/wg/moq/about/) | Media transport over QUIC with relay-capable distribution | A different transport/distribution design; RelaySwarm has no MoQ implementation |
| [Snowflake](https://snowflake.torproject.org/) | Volunteer proxies supporting access to Tor | A different application of volunteer connectivity; it does not establish HLS scheduling or RelaySwarm reachability |
| [RelaySwarmKit](https://github.com/forgesworn/relayswarm-kit) | Swift Nostr rendezvous and encrypted SDP with a separate data-channel transport | Related implementation, but its README describes wire version 2 while the shared session here uses version 3; current interoperability is unverified |

P2P Media Loader's FAQ recommends operated tracker infrastructure for production;
multiple trackers can be selected. Nostr relays are also operated infrastructure
whose policy and capacity must be tested. Neither design removes the HTTP origin.

## The project's scope

RelaySwarm evaluates application-selected Nostr relays as the rendezvous path for
peer-assisted HLS. [NIP-53](https://github.com/nostr-protocol/nips/blob/master/53.md)
kind-30311 events can advertise relay information. The current host passes its
trusted stream event and network policy explicitly; automatic stream discovery
and policy extraction are not implemented.

The release adds a bounded hls.js loader, origin deadlines, admission callbacks,
upload opt-in, an origin-only mode and author-signed media commitments. Those
capabilities are documented in [INTEGRATION.md](../INTEGRATION.md). They do not
establish an accepted NIP, broad ABR scheduling, production readiness or
compatibility with another implementation.

## Historical relay measurements

The August 2026 CLI/fan-out runs recorded acceptance of experimental kinds
24170/24171 on relay.damus.io, nos.lol and relay.primal.net and approximately
0.57 s average fan-out signalling. Recorded Chrome/Safari transfers finished
inside a common four-second segment. These are dated feasibility observations,
not relay service guarantees or mobile-loader validation; the original CLI
signalled plaintext SDP. [Spike results](../spikes/RESULTS.md) retain provenance.

Current release evidence includes desktop Chrome playback and a twelve-viewer
loopback soak. Separate-network performance and stronger adversarial tests
remain outstanding, as listed in [Status](STATUS.md).
