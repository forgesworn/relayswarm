# Integrating the hls.js swarm in a host page

`src/browser/hls-swarm.mjs` adds peer-assisted delivery to an hls.js player.
In **shadow mode** it changes nothing the viewer sees: every fragment still
comes from the origin, and the swarm only measures what peer delivery would
have achieved. That is the mode to deploy first.

The module is browser ESM with one runtime dependency (`nostr-tools`), so any
bundler that resolves bare specifiers can take it. There is no npm release
yet: pin a git dependency at a commit, or vendor the bundled file.

## Attaching

```js
import Hls from "hls.js";
import { createHlsSwarm } from "relayswarm/hls-swarm";

const swarm = createHlsSwarm({
  swarmId: `stage-${eventId}`,        // same string for every viewer of one stream
  relays: ["wss://relay.example"],     // 1-8; the deployment's own relay first
  mode: "shadow",                      // "shadow" | "off"
  originFallbackMs: 1500,              // "in time" means within this of the load starting
  shadowSampleRate: 0.25,              // race this share of fragments (see Cost)
  onMetrics: (metrics) => post(metrics),
});

const hls = new Hls();
swarm.attach(hls);                     // attach BEFORE loadSource
hls.loadSource(manifestUrl);
hls.attachMedia(video);

// later, or when the kill switch says off
swarm.stop();
```

`createHlsSwarm` never throws. An unusable option or browser yields a swarm
whose `metrics().mode` is `"off"` and whose `metrics().disabledReason` says
why (`invalid-swarm-id`, `invalid-relays`, `invalid-mode`, `mode-off`,
`peer-first-not-available`, `no-webcrypto`, `no-webrtc`, `no-websocket`). A
disabled swarm leaves the player untouched, so the host page can attach
unconditionally.

`attach()` replaces `hls.config.fLoader` with a wrapper around the loader that
was configured, and `stop()` puts the original back, closes every peer
connection and relay socket, drops held segments and emits one final
`onMetrics`. Requires a secure context (https, or localhost) for WebCrypto.

## Options

| Option | Default | What it does |
|---|---|---|
| `swarmId` | required | Groups viewers of one stream. 8-128 characters. |
| `relays` | required | 1-8 relay URLs (`wss://`, or `ws://` on loopback). |
| `mode` | `"shadow"` | `"off"` disables; `"peer-first"` is not implemented yet and disables. |
| `secretKey` | fresh per viewer | Ephemeral signing key for presence and signalling. Never the viewer's own identity. |
| `originFallbackMs` | `1500` | The in-time budget a peer delivery is measured against. |
| `lateWindowMs` | `6000` | How long a race keeps asking peers before it counts as missed. |
| `maxPeers` | `6` | Connections in and out. |
| `maxUploadPeers` | `4` | Distinct peers served in any 30 s. |
| `maxUploadBytesPerSecond` | `1250000` | Upload token bucket. |
| `serveOnCellular` | `false` | With `false`, a viewer on a metered connection neither uploads nor races. |
| `shadowSampleRate` | `1` | Share of fragments raced. |
| `swarmParts` | `false` | Include low-latency HLS parts. Parts are small; leave off. |
| `maxHeldSegments` / `maxHeldBytes` | `12` / 64 MB | What a viewer keeps to serve others. |
| `presenceIntervalMs` | `20000` | Presence heartbeat, jittered 30%. |
| `metricsIntervalMs` | `10000` | How often `onMetrics` fires. |
| `iceServers` | one public STUN | Pass the deployment's own STUN. |
| `segmentKey` | URL pathname | Maps a fragment URL to the key peers index by. Must agree across viewers, so strip per-viewer query strings and CDN tokens. |
| `RTCPeerConnectionImpl` / `WebSocketImpl` | globals | Injection points for tests. |

## Cost, and what to tell viewers

Shadow mode downloads a raced fragment **twice**: once from the origin for the
player, once from a peer to measure. That is the price of measuring with no
playback risk. Keep `shadowSampleRate` low enough that the extra data is
acceptable (0.25 gives a useful sample), and leave `serveOnCellular` false.
A viewer who is helping is uploading, so say so in the interface and offer a
way to switch it off, which is `stop()`.

## Metrics

`onMetrics(metrics)` and `metrics()` return the same snapshot: `v`, `swarmId`,
`mode`, `disabledReason`, `stopped`, `pubkey` (the ephemeral swarm key,
not an identity), `uptimeMs`, `serving`, plus:

- `peers`: `connected`, `dialling`, `dialsStarted`, `dialsAccepted`,
  `dialsFailed`, `dialsTimedOut`, `dialsRejected`, `offersAccepted`,
  `offersRefused`, `linksOpened`, `linksClosed`, `banned`,
  `candidatePairs` (counts keyed `local/remote` candidate type, the NAT
  outcome: `host/host`, `srflx/srflx`, `relay/...`, `unknown`).
- `signalling`: `samples`, `medianMs`, `p90Ms` from offer sent to channel open.
- `segments`: `originLoaded`, `raced`, `noPeers`, `sampledOut`, `skipped`,
  `aborted`, `peerInTime`, `peerLate`, `peerMiss`, `peerCorrupt`,
  `peerUnverified`, `inTimeShare`, `peerLatencyMedianMs`,
  `peerLatencyP90Ms`, `originLatencyMedianMs`.
- `bytes`: `fromOrigin`, `fromPeers`, `uploaded`, `uploadsServed`,
  `uploadsRefused`, `held`.
- `relays`: `connected`, `presenceSent`, `signalsSent`, `published`,
  `rejected`, `publishErrors`.
- `errors`: `total` and `byStage`.
- `config`: the effective settings, so a receipt says what produced it.

Nothing in a snapshot identifies the viewer: no IP addresses, no user agent,
no long-term key. Post it to the host's own endpoint on an interval and once
more on `stop()`, and keep the payload small enough for `sendBeacon`.

The two numbers that decide whether peer-first is worth turning on are
`segments.inTimeShare` and `peers.candidatePairs`: the first is how much of
the stream peers could have carried, the second how many viewers can reach
each other at all.

## The kill switch

The host page owns the mode. Read it from your own stage status or config
(`off` / `shadow`), create the swarm accordingly, and when a live change
flips it to `off`, call `stop()`. After `stop()` the player is exactly as it
would have been without the module, and a new swarm can be created later if
the switch flips back. Nothing in the module reaches back to the host to
decide its own mode.

## Known limits

- **No peer-first delivery yet.** Peers are never in the playback path, so
  there is no bandwidth saving yet, only measurement. Peer-first additionally
  needs a trustworthy source of segment digests: a peer supplies both bytes
  and hash today, which detects corruption but not a malicious peer. Options
  are digests signed by the streamer or fetched from the origin.
- **No peer rotation.** Once viewers reach `maxPeers` they refuse newcomers,
  who then race with no peers and play from the origin. `offersRefused` and
  `segments.noPeers` show when that is happening.
- **Hard NATs.** Symmetric NAT and some VPN egresses will not connect with
  STUN alone, and no TURN or super-peer path exists yet. Those viewers simply
  play from the origin.
- **Relays.** Presence is one event per viewer per 20 s plus two events per
  connection. Point at a relay you control; a public relay may rate-limit.
