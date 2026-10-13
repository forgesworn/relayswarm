# Publisher/player field test

[Documentation](README.md) · [Installation](GETTING-STARTED.md) ·
[Publisher API](API.md#node-hls-publisher) · [Release evidence](STATUS.md)

The demo is a runnable publisher and an hls.js player with origin-only,
shadow and authenticated peer-first modes. Uploading starts **off**. Receipts
are downloaded locally. Reporting is disabled by default; v0.2.0
can offer explicitly opted-in numeric reports and authenticated
operator controls. See [operations](OPERATIONS.md). The publisher's signing
key stays on the server. v0.1.0 release assets retain their original behaviour.

## Run locally

From the [current source candidate](GETTING-STARTED.md#run-the-source-demo) or a
current main checkout:

```bash
npm ci
npm run demo
```

Open `http://localhost:8787`. Without a media directory, ffmpeg generates
two live H.264/AAC renditions (240p/350 kbps and 360p/1 Mbps video, each with
64 kbps audio and 2 s segments). Requires ffmpeg with libx264 and Node 22+.
Open several browsers, enable uploading on at least one willing participant,
then compare origin-only, shadow and peer-first on another. The demo starts
its own in-memory Nostr relay on `/relay`; it uses the engine's default STUN
unless `--stun` is supplied. It never asks for microphone or camera permission.

`Use origin only` stops the swarm and restores the original fragment loader
while the player continues. Applying settings also stops the previous swarm
before starting another. Uploading and cellular peer traffic require separate
opt-ins. The engine's upload token bucket permits a burst of up to two seconds
of the selected limit; it is not a strict per-second traffic shaper.
Leaving the page stops its swarm. A page restored from the browser's back/forward
cache uses origin until settings are applied again; physical background/resume
behaviour is still a field gate.

## Publish your own media

```bash
npm run demo -- --media-dir /path/to/hls --manifest master.m3u8
```

Use a directory of media you are authorised to redistribute. The directory
is not exposed as a general file server: only the entry playlist, its supported
variant playlists, their media URIs and init maps are served. Symlinks cannot
leave the media directory. Signing requests must match the publisher's current
playlist context; a viewer cannot ask it to sign an arbitrary file or digest.

The Node-only helper is also exported as `relayswarm/hls-publisher`:

```js
import { createHlsPublisher } from 'relayswarm/hls-publisher';

const publisher = await createHlsPublisher({
  mediaDir: '/path/to/hls',
  manifest: 'master.m3u8',
  // secretKey: yourPublisherKey,  // optional; a fresh key is the default
});
const event = await publisher.commitment({
  path: '/media/low/shared.ts',
  level: 0, sequence: 12, discontinuity: 1,
  rangeStart: 188000, rangeEnd: 282000, // end is exclusive, as in hls.js
});
```

Omit both range fields for whole-segment media. The helper derives a fresh,
60 s commitment from the exact file bytes and its playlist records. It reloads
the catalogue at most once per 200 ms and allows at most eight concurrent
signing operations. It caps playlists at 256 KiB, variants at eight, fragments
at 4,096 per variant and signed segments at 16 MiB. hls.js level order is height
then bitrate within the supported single codec/frame-rate family.

The current publisher supports local full segments/ranges/discontinuities,
fMP4, alternate audio, mixed variants, complete parts and warm delta playlists.
AES-128 ciphertext requires explicit opt-in; keys and init maps stay on HTTP.
Remote/query assets, DRM/SAMPLE-AES, subtitles, I-frame variants and cold delta
reconstruction remain unsupported. See [production features](PRODUCTION-FEATURES.md)
for exact schema 2 contexts and the scope of actual Chrome media tests.

Keys are ephemeral by default and in v0.1.0's CLI. Current source optionally
accepts `--publisher-state /private/path/publisher.json`; preserve this 0600
file in an owner-controlled directory for a stable identity across restarts.
Without it, restarting creates a new authorisation and swarm. Current viewers
poll session identity and rejoin while retaining the persistent browser allowance. The demo
does not establish trust in external publishers.

For live OBS ingest and optional independent RTMPS forwarding, use the
[broadcast launcher](BROADCASTING.md), which manages persistent
publisher state automatically. Existing media remains usable without ingest.

## Use separate devices and networks

Remote browsers need an HTTPS address trusted by the devices. Configure an
HTTPS reverse proxy to the loopback server, including WebSocket upgrades, then:

```bash
npm run demo -- --public-url https://trial.example
```

The public URL must be an HTTPS origin with no path or credentials. The demo
uses that explicit origin for session and relay URLs; it does not derive it
from an untrusted Host header. Your proxy must forward `/relay` with
WebSocket upgrade support. Alternatively supply `--tls-key FILE --tls-cert FILE`
and `--host 0.0.0.0` with a certificate trusted by all the devices. A plain HTTP
LAN address is insufficient for browser WebCrypto.

Optional `--relay wss://relay.example` (repeatable, at most eight) chooses external
relays instead of the embedded one. Optional `--stun stun:stun.example:3478`
(repeatable) overrides STUN. Alternatively, `--ice-config FILE` reads a private
STUN/TURN configuration. The same option is available to the broadcaster. The
file is a canonical, owner-controlled POSIX regular file, mode 0600, with one
link and at most 16 KiB; its parent must have no group/world writes or symlinks.
Supply either `--stun` or `--ice-config`, rather than both.

```json
{
  "v": 1,
  "iceServers": [
    { "urls": "stun:stun.example:3478" },
    {
      "urls": "turns:turn.example:5349?transport=tcp",
      "username": "temporary-user",
      "credential": "temporary-browser-password"
    }
  ]
}
```

The configuration permits at most eight servers, four URLs per server and
512 characters per URL. TURN requires username/password strings of at most
256 characters; keep STUN in a separate entry without credentials. Use only
browser credentials, preferably short-lived: `/session.json` intentionally
discloses them to viewers. Never put a TURN server's shared signing secret in
this file. Restart the server and reload players when the configuration changes.
The CLI configures an existing host-provided service; it supplies no managed
TURN or super-peer deployment. A TCP TURN configuration needs its own actual
transport, capacity and privacy acceptance. An unreachable peer should leave
the viewer playing from origin.

The embedded relay is for a controlled trial: at most 64 connections, eight
subscriptions per connection, 24 KiB frames, 80 incoming messages per 10 s per
connection, 512 retained events for up to two minutes, and a 1 MiB outbound
queue limit. The HTTP server allows 32 concurrent media responses and 240
commitment requests per 10 s. These bounds do not turn it into a production
hosting service or a Sybil-resistant relay.

## Collect comparable receipts

1. Keep the source, selected quality, device and playback window the same.
2. Play origin-only for at least two minutes and download a baseline receipt.
3. Reload, choose shadow or peer-first, and keep at least one opted-in seeder
   ahead of the viewer. Use the same playback window and download its receipt.
4. Repeat on a different network, then with quality changes, seeks, a late
   joiner, one seeder leaving, and a brief relay outage.
5. Use origin-only during playback and confirm it continues; download the
   receipt so the previous session's stopped resource counts are retained.

Record your device and network labels before downloading. The labels are
viewer-supplied; they do not prove the network topology. A receipt includes
the browser version, startup time, stalls, seek recovery, fragment contexts,
resource timings and engine metrics. It records no peer addresses or private
signing key, but an ephemeral public key can correlate it with relay activity.
Nothing is submitted automatically.

`totals.peerFirstBytes` measures verified media delivered instead of starting
an origin fragment request. It excludes commitment traffic, signalling and
peer protocol overhead, so it is **not net connection data saved**. Shadow
results measure extra sampled transfers and cannot be labelled origin savings.
The upload allowance counter (`bytes.uploaded`) counts full media payloads
accepted for serving, including any transfer later interrupted. It measures
the engine's quota consumption, not acknowledged bytes or total network data.
Use device/network measurements for actual data cost.
Resource timings count same-origin media requests, including init segments
and cache hits. Native-HLS browsers use origin-only playback and report origin
resource measurements as unavailable rather than zero.

Aggregate counts cover the whole page session. Detail is bounded to the last
256 fragments, 60 snapshots (five-minute window) and 64 mode sessions; older
session totals are retained. Stalls exclude user seeks, whose recovery is
recorded separately. Startup begins at the Start playback action.

## Automated coverage and remaining field gates

```bash
npm run test:publisher
npm run test:playback -- --resultsDir artifacts/playback
```

The playback test drives these same controls in real Chrome, using two VOD
renditions with 2 s shared-file ranges and a timestamp reset after 24 s.
It checks both renditions receive verified peer bytes, forward/backward seeks,
discontinuity delivery, range responses, retained hls.js statistics, receive-only
behaviour, relay reconnect, the kill switch and the downloaded receipt. It
compares playback stalls with an origin-only player. Forced quality switches
and returning to automatic selection are covered; optimal or broadly adaptive
ABR scheduling is not established. Loopback tests grant a fake microphone
permission to unlock interfaces; the demo itself does not.

GitHub CI runs this regression alongside both live harness modes. A manual
workflow dispatch with `soak=true` adds twelve viewer roles in three arrival
waves. `soak_duration` selects a 180 s or 7,200 s measurement window; the longer
choice includes repeated departures/rejoins and sampled resource bounds. Both
are loopback fixtures. The current two-hour result and its instrumentation
limits are recorded below; they do not establish deployed or physical acceptance.
The v0.1.0 [completed soak](STATUS.md#release-verification) recorded zero
stalls/fatal errors and 68.7% peer-first fragment loads, with uneven per-viewer
benefits. Its recorded receipt does not establish separate-network performance.
The live peer-first fixture caps forward buffering at 4 s (maximum 6 s), keeps
its tampering seeder ahead in availability, and waits for an observed ban
before adding other peers. Its origin-only baseline uses the same buffer
settings. A playhead lead alone does not guarantee that a live-prefetching
viewer will ask the tampering seeder for bytes.
Presence remains swarm-wide; encrypted signals are subscribed to by recipient.
Clients also check the subscription's filter before verifying and dispatching
relay frames, so a relay cannot widen it into an all-audience signal feed.

| Gate | Evidence required |
|---|---|
| Desktop Chrome and Firefox on real networks | Current installed Firefox journey passes; paired matched network/cost receipts and broader coverage remain open |
| Physical Android and iPhone | Playback engine identified, consent respected, background/resume and metered-data behaviour |
| Home broadband vs mobile carrier | Selected candidate types plus paired receipts from separate networks |
| VPN or hard NAT | Playback continues from origin when direct peers cannot connect |
| Longer sessions and audiences | Loopback two-hour churn passes; deployed two-hour sustained-contribution gate red; attributable wire/cost measurements remain open |
| Independent-client protocol interoperability | Current public Swift SDK/browser journey passes; actual native application/input and wider physical integration remain open |

These field gates remain outstanding until their actual receipts are recorded.
No new physical-device or internet-network result is claimed by the automated
Chrome tests.

## Current field checkpoint: 13 October 2026

The latest verified pilot checkpoint used source `f9990b36956282f3d4e849b55bd64a79eb440151`,
client SHA-256 `b746f45216d3ac6e5d1bd21b5748f91c0115c71d00ee678c930070596bbef50d`
(723,954 bytes), with nine required jobs green in
[CI run 38449139246](https://github.com/forgesworn/relayswarm/actions/runs/38449139246).
A later proxy-only h1/h2 and `Alt-Svc: clear` configuration passed pinned-binary
validation and a guarded in-place reload, with fresh HTTP/1.1 and HTTP/2 checks
and unchanged application identity. It does not establish the cause of the
recorded policy timeout. The [f999 public field summary](../spikes/results/f999-public-field-summary-20261013.json) records the later measurements. These receipts describe past test windows, not a final release.
The [current acceptance summary](../spikes/results/current-source-acceptance-summary-20261013.json)
retains the earlier a023 load/churn and field results with their original identity.
Its named raw receipts remain local evidence; the summary excludes private
device identifiers, credentials and personal filesystem paths.

| Journey | Measured outcome | Remaining boundary |
|---|---|---|
| CI two-hour load/churn | Twelve honest roles, 22 replacements, zero retained stalls/fatal hls.js errors and clean resource stops | Loopback flags and host candidates; native media errors not separately instrumented |
| Deployed 7,205 s four-context run | Completed but red: policy timeout withdrew contribution before quota exhaustion; 34 zero-frame intervals and stalls retained | Same Mac/headless contexts; separate support audiences prevent controlled traffic attribution |
| f999 ordinary public 60.008 s | Requested video/audio qualities, both contributors and verified receive-only payload passed; 10,576,128 peer bytes, zero uploads/fatal/native errors/stalls | One same-laptop `host/host` browser process; short result does not close sustained/hard-NAT/cost gates |
| f999 attempted public two-hour rerun | Stopped after 644.855 s whole/611.134 s measured; high upload cleared during warmup following a five-second policy fetch cancellation; low receiver retained 60,508,176 peer bytes | No high receiver phase or 7,200 s completion; individual transport/proxy/browser cause unproved; historical reds retained |
| f999 public 60.120 s after proxy correction | Decode passed; contribution and peer payload at both qualities failed; receiver accepted 2,731,076 low peer bytes/13 loads; first high session timeout preceded measurement | Empty requested NetLog capture; underlying cause unproved, stalls retained, all owned actors/readers/source cleaned |
| TCP TURN over owned SSH forward | 224,096 signed media bytes/two segments verified in 5.036 s; browser and later explicit cleanup audit passed | Forced relay-policy data-channel/self-routing simulation, not direct Internet TURN, physical playback or hard-NAT proof; original controller red retained |
| Installed Firefox with ordinary contributors | Verified receive/upload, quality, seek, quota across reload, fresh consent and origin kill passed | One installed-browser journey; native-picker/human usability and hard NAT not proved |
| Visible Safari with ordinary contributors | Origin video played; five RTC links but zero peer payload inside gate | Complete verified receive/upload/reload/kill journey remains red |
| Physical Pixel/Vanadium | Later f999 actual origin frames, low/high quality, seek and background/resume passed; upload off and privacy unchanged | Peer unmeasured without a contributor in this check; original raw overall false plus default/temporary-policy reds retained; phone access closed |
| Physical iPhone/Safari | Owner observed moving origin video and audible tone | Owner background/Play return remained stopped; engine diagnosis, peer and complete input journey open |
| a023 host parent crash | Explicit audited dirty-marker recovery; same page progressed low/high at continuity 17, final 15 s frames and cleanup passed | One short origin-only observer, with stall and transient HTTP errors; no automatic clean-drain claim |
| Resource/network supplement | Exact owned-process/container and partial isolated HTTPS TCP counters retained | Missing windows, resets and other audiences; total wire and billed cost unproved |
| Deployed 219 reporting | Trusted reporting opt-in followed by a 17 s response timeout; reporting-off restoration and owned-source cleanup verified | No accepted-report/restart/retention checkpoint; original request lifecycle and later control state unavailable |
| Later sparse-AAC replay | Actual retained bytes reproduce a missing audio SourceBuffer; current one-shot repair resumed through another rendition in 603 ms | Constructed VOD differs from original failing live window; low-only recovery and original cause unproved |

The [investigation summary](../spikes/results/control-path-media-investigation-summary-20261013.json)
records those later observations and the local diagnostics-candidate tests.

Physical and separate-network tests require their own evidence for each control,
engine, contribution policy, background/resume and metered/battery behaviour.
Browser RTC links, SDK loopback interoperability, an origin video observation
and a passing local soak are separate claims. The complete P01–P12 requirements
remain in [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md); these observations
do not declare a release or close historical failed records.
