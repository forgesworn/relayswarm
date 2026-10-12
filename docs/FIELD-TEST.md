# Publisher/player field test

The demo is a runnable publisher and an hls.js player with origin-only,
shadow and authenticated peer-first modes. Uploading starts **off**. Receipts
are downloaded locally; there is no receipt submission or analytics endpoint.
The publisher's signing key stays in the Node process.

## Run locally

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

This publisher supports a single media playlist or a simple SDR master with
local URIs and full segments, including explicit/implicit byte ranges and
discontinuities. Encrypted media, external/query-bearing URIs, alternate audio,
iframe playlists, partial segments, delta playlists, HDCP and mixed codec or
frame-rate families are rejected. It is a deliberately limited example, not
a general HLS ingest service. Init maps are served over HTTP; fMP4 playback
has not yet been exercised by the new regression fixture.

Keys are ephemeral in the CLI. Restarting it creates a new authorisation and
swarm; reload every viewer. A real publisher integration should supply its
author key through its own server-side key management. This demo does not
perform Nostr stream discovery or establish trust in an external publisher.

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
(repeatable) overrides STUN. No TURN or super-peer path is implemented. An
unreachable peer should leave the viewer playing from origin.

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
workflow dispatch with `soak=true` adds a twelve-viewer peer-first run with
three arrival waves, a 180 s final measurement window and sampled resource
bounds. This remains a short loopback soak, not evidence of hours of operation.
Presence remains swarm-wide; encrypted signals are subscribed to by recipient.
Clients also check the subscription's filter before verifying and dispatching
relay frames, so a relay cannot widen it into an all-audience signal feed.

| Gate | Evidence required |
|---|---|
| Desktop Chrome and Firefox on real networks | Baseline/swarm receipts, quality switches, seeks and origin fallback |
| Physical Android and iPhone | Playback engine identified, consent respected, background/resume and metered-data behaviour |
| Home broadband vs mobile carrier | Selected candidate types plus paired receipts from separate networks |
| VPN or hard NAT | Playback continues from origin when direct peers cannot connect |
| Longer sessions and audiences | Hours of resource/cost measurements, larger churn waves and reachability results |
| Independent-client protocol interoperability | A second implementation verifying the experimental contract |

These field gates remain outstanding until their actual receipts are recorded.
No new physical-device or internet-network result is claimed by the automated
Chrome tests.
