# RelaySwarm FAQ

[Documentation](README.md) · [Getting started](GETTING-STARTED.md) ·
[Evidence and gaps](STATUS.md)

## What is released?

[v0.1.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.1.0) is an
experimental GitHub prerelease with an installable tarball, a standalone browser
ESM bundle and checksums. It includes the browser loader, local publisher/player
and native transfer PoC. The npm registry remains unpublished; the release does
not provision hosting. Later broadcaster work is unreleased source. See
[Getting started](GETTING-STARTED.md) and [the broadcaster guide](BROADCASTING.md).

## Why use Nostr instead of a tracker?

RelaySwarm reuses application-selected Nostr relays for peer discovery and
signalling. It still needs rendezvous infrastructure. P2P Media Loader instead
uses [WebTorrent-compatible trackers](https://github.com/Novage/p2p-media-loader/blob/main/FAQ.md#what-is-tracker),
which may also be redundant or self-hosted. The distinction is the discovery
protocol and its fit with Nostr applications, not the elimination of operators.

## Why not combine Trystero and P2P Media Loader?

Those projects provide useful building blocks. A host would still need to
integrate stream identity, signed segment provenance, origin deadlines,
admission, upload consent and lifecycle handling. RelaySwarm implements a
bounded example of that layer; it does not claim that the alternatives cannot
implement it. [Landscape](LANDSCAPE.md) compares their documented roles.

## Does it support MoQ or replace a CDN?

The current paths are WebRTC and native HyperDHT. MoQ integration is unimplemented.
The HTTP origin or CDN still supplies manifests, initial media and fallback;
RelaySwarm can reduce particular origin media loads when suitable peers exist.
It does not remove ingest, origin hosting or operator costs.

## Does NIP-53 automatically configure the swarm?

No. The host selects trusted authors, allowed media origins, the swarm id, relays
and ICE servers. The released loader accepts the selected event. An optional
adapter in unreleased source filters a host-supplied query using those explicit
allowlists; it does not choose infrastructure or establish trust in arbitrary
publishers. NIP-53 can carry relay information; the redistribution tag and
commitment kind are RelaySwarm's experimental contract.

## Can it send a broadcast to YouTube?

The unreleased broadcaster can send the same H.264/AAC source to a separately
configured RTMPS endpoint while producing HLS for RelaySwarm viewers. That
forwarder has its own process and retries. A valid platform stream key, account
configuration and an actual platform playback test are still needed. YouTube
does not participate in the viewer peer swarm. See [broadcasting](BROADCASTING.md).

## Is signalling encrypted?

The original `poc.mjs` signs **plaintext SDP**. The browser loader and shared
version-3 `RelaySwarmSession` use pairwise NIP-44-encrypted signals. The native
path encrypts its dial authorisation and transfers bytes over Noise.
WebRTC data-channel encryption and SDP encryption are separate properties.
Relays still see event kinds, tags, timing and connecting addresses.

## Can a peer poison a video segment?

The browser peer-first path accepts bytes only after verifying an expiring
commitment signed by the selected stream-event author and matching the exact
stream, rendition, sequence, discontinuity, part, segment key, size and digest.
Invalid bytes are discarded and the peer is banned; failures use the original
HTTP loader. The publisher must authorise redistribution explicitly.

Shadow mode compares peer bytes with origin bytes. The original CLI's
same-peer digest detects corruption but cannot authenticate a malicious
seeder. The native receiver needs a digest from a trusted application source.
Hashes do not establish whether content is truthful or safe.

## Can I upload without the viewer opting in?

Contribution defaults to off. A host must obtain explicit opt-in before setting
`serve: true`; the demo has a separate upload checkbox and limit selector.
Known cellular connections are excluded by default, but connection detection
is advisory and missing in some browsers. Publisher permission and viewer
consent are both required. The upload token bucket permits a burst of up to
two seconds of its configured allowance.

## Does receive-only mean private?

Receive-only disables uploading, but still joins the swarm and can reveal the
viewer's address to connected peers. Ephemeral keys provide pseudonymity,
not anonymity. A public swarm identifier lets observers correlate presence.
`mode: 'off'` or `stop()` provides origin-only playback without swarm sockets,
events or peer connections. The origin still sees ordinary HLS requests.

## Do phones and Safari work?

The earlier spikes recorded desktop Chrome/Safari transfers and limited phone
origin-playback observations. They did not validate the current signed
peer-first loader on iPhone or Android. The new regression uses desktop Chrome
on loopback. The demo uses native origin-only HLS where the browser supports
it but hls.js does not; origin resource measurements then report unavailable.
Physical playback, consent, metered data and background/resume remain
[field gates](FIELD-TEST.md#automated-coverage-and-remaining-field-gates).

## What happens when peers, relays or WebRTC are blocked?

The original HTTP fragment loader remains the fallback. Missing availability,
invalid commitments, corruption and peer deadlines lead to origin. An origin
outage can still stop playback; the swarm is not durable storage. Relays may
change policies, reject kinds or rate-limit. Historical public-relay acceptance
does not guarantee future service. A deployment should choose and test its own
relay and ICE policy.

## Does it use STUN, TURN or super-peers?

The browser loader defaults to Google's public STUN endpoint and accepts host
`iceServers`; the demo accepts `--stun`. It implements no TURN or super-peer
strategy. Difficult NATs can fall back to origin. Native HyperDHT uses its own
bootstrap/routing infrastructure rather than STUN/TURN and has no automatic
origin fallback in its CLI journey. See [Native transport](NATIVE-TRANSPORT.md).

## Can I use HyperDHT in a normal browser?

No. This native implementation requires installed Node applications and UDP
access. Browser pages use WebRTC. Installed companion processes would need
their own integration and distribution work.

## Does RelaySwarmKit interoperate with this release?

That has not been established. The separate
[Swift project's README](https://github.com/forgesworn/relayswarm-kit) describes
version-2 signalling; this repository uses version 3 for the shared session.
Shared event kinds and successful NIP-44 vectors do not prove matching wire
envelopes, native transport or signed HLS commitments. No RelaySwarm NIP is
accepted yet.

## Do the receipts measure money or data saved?

`peerFirstBytes` measures verified media delivered in place of starting an
origin fragment load. It excludes commitment, signalling and protocol traffic.
Shadow transfers add traffic. `bytes.uploaded` counts full payloads accepted
against the quota, including interrupted transfers; it is not acknowledged
network delivery. Receipts stay local until downloaded. Use paired device/network
measurements to establish total data cost. See [receipt interpretation](FIELD-TEST.md#collect-comparable-receipts).

## What remains before production?

Physical devices, separate-network/NAT trials, sustained resource and cost
measurements, broader adaptive bitrate and fMP4 coverage, stronger adversarial
testing and independent-client interoperability. [Status](STATUS.md) records
which evidence exists. There is no prediction that audience upload capacity
will cover a given deployment.

## What permission does a contributing viewer need?

A contributing viewer redistributes media. The publisher authorisation tag
expresses the publisher's opt-in; it does not establish ownership of every
right or settle a viewer's legal/contractual obligations. The demo should be
used with media participants are authorised to redistribute. Host policy and
explicit viewer consent remain application responsibilities.
