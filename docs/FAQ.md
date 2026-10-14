# RelaySwarm FAQ

[Documentation](README.md) · [Getting started](GETTING-STARTED.md) ·
[Evidence and gaps](STATUS.md)

## What is released?

[v0.2.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.0) is an
experimental GitHub prerelease with an installable tarball, a standalone browser
ESM bundle and checksums. It includes the browser loader, local publisher/player
and native transfer PoC, plus the live broadcaster, private publisher state and
operator controls. The npm registry remains unpublished; the release does
not provision hosting. See
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
adapter in v0.2.0 filters a host-supplied query using those explicit
allowlists; it does not choose infrastructure or establish trust in arbitrary
publishers. NIP-53 can carry relay information; the redistribution tag and
commitment kind are RelaySwarm's experimental contract.

## Can it send a broadcast to YouTube?

The v0.2.0 broadcaster can send the same H.264/AAC source to a separately
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
`iceServers`; the demo accepts `--stun`. Hosts can supply TURN credentials
through `iceServers`; no managed TURN or super-peer service is supplied.
Difficult NATs can fall back to origin. Native HyperDHT uses its own
bootstrap/routing infrastructure rather than STUN/TURN and has no automatic
origin fallback in its CLI journey. See [Native transport](NATIVE-TRANSPORT.md).

## Can I use HyperDHT in a normal browser?

No. This native implementation requires installed Node applications and UDP
access. Browser pages use WebRTC. Installed companion processes would need
their own integration and distribution work.

## Does RelaySwarmKit interoperate with this release?

The current 0.2.0 source candidate passes author, delegated-signing and
adversarial transfer journeys with the published RelaySwarmKit v0.5.0 public
SDK. These are macOS arm64/Chrome loopback checks, not physical iPhone
acceptance. The earlier version-2 Kit baseline is incompatible with the
candidate's version-3 signalling. Published RelaySwarm v0.1.0 assets keep their
original protocol; do not infer compatibility from matching event kinds alone.
See [the recorded SDK evidence](STATUS.md) and [interop guide](interop/README.md).
No RelaySwarm NIP is accepted yet.

## Can one upload allowance cover my phone and computers?

The current source offers an optional [shared account allowance](ACCOUNT-UPLOAD-BUDGET.md).
Devices explicitly connect using the same Nostr identity or an account
authenticated by the host website, and use one durable ledger. Both methods
are supported; linking them requires fresh proof of both. Their recorded spend
is added and the lower cap is retained. Local browser allowances still apply,
and each page separately requests upload consent. The deployed `8f482b4` pilot
offers Nostr sign-in; integrating sites supply their own website resolver.
Actual owner and complete physical acceptance remain open. The allowance counts
reserved media payload rather than total device traffic.

## Do the receipts measure money or data saved?

`peerFirstBytes` measures verified media delivered in place of starting an
origin fragment load. It excludes commitment, signalling and protocol traffic.
Shadow transfers add traffic. `bytes.uploaded` counts full payloads accepted
for serving after any host reservation callback succeeds and current serving
checks pass. Pending or refused callbacks do not enter that counter. Interrupted
accepted transfers can send less; durable allowances can also retain charges
for media never handed to the transport. These are not acknowledged network
delivery totals. Receipts stay local until downloaded. Use paired device/network
measurements to establish total data cost. See [receipt interpretation](FIELD-TEST.md#collect-comparable-receipts).

## What remains before production?

Complete physical-device journeys, separate-network/hard-NAT trials, sustained
resource/churn and matched cost measurements, and final immutable release
acceptance remain open. Current deployed sharing and fourteen-role qualification
are red; earlier short passes retain their own source and scope. Wider-media
and independent SDK fixtures have passing evidence, which does not close those
field gates. [Status](STATUS.md) records both results. There is no prediction
that audience upload capacity will cover a given deployment.

## What permission does a contributing viewer need?

A contributing viewer redistributes media. The publisher authorisation tag
expresses the publisher's opt-in; it does not establish ownership of every
right or settle a viewer's legal/contractual obligations. The demo should be
used with media participants are authorised to redistribute. Host policy and
explicit viewer consent remain application responsibilities.

## What does the current production candidate add?

[Production features](PRODUCTION-FEATURES.md) covers wider HLS, scoped delegation,
full linked stream advertisements, bounded admission, persistent browser upload
budgets, durable idempotent reports, worker supervision and native HTTP fallback.
[Delivery requirements](PRODUCTION-READINESS.md) separates implementation from
publication, physical devices, varied networks and sustained acceptance.
