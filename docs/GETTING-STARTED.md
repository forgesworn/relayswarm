# Getting started with RelaySwarm

[Documentation](README.md) · [API](API.md) · [hls.js integration](../INTEGRATION.md)

The supported release is an experimental
[v0.1.0 GitHub prerelease](https://github.com/forgesworn/relayswarm/releases/tag/v0.1.0).
Node 22+ is required; CI runs Node 24. `npm install relayswarm` is not the
documented distribution path: the npm registry is unpublished.

## Install for a host application

```sh
npm install https://github.com/forgesworn/relayswarm/releases/download/v0.1.0/relayswarm-0.1.0.tgz
npm install hls.js
```

```js
import Hls from 'hls.js';
import { createHlsSwarm } from 'relayswarm/hls-swarm';
```

The host owns stream discovery, trusted publisher selection, network policy,
viewer consent, page lifecycle and the commitment endpoint. The full attach,
stop and peer-first contract is in [INTEGRATION.md](../INTEGRATION.md).
Browser peer participation requires HTTPS or a loopback secure context,
WebCrypto, WebRTC data channels and WebSocket. Native HLS alone does not attach
this hls.js loader.

A Git dependency can also be pinned to the released commit:

```sh
npm install 'git+https://github.com/forgesworn/relayswarm.git#3e480e19dfe4d675f14bcb2968f3dc4926fbca25'
```

## Use the standalone browser bundle

Download
[`relayswarm-hls-swarm-0.1.0.mjs`](https://github.com/forgesworn/relayswarm/releases/download/v0.1.0/relayswarm-hls-swarm-0.1.0.mjs)
and serve it from your own application:

```js
import { createHlsSwarm } from './relayswarm-hls-swarm-0.1.0.mjs';
```

The bundle contains the loader's runtime dependencies; hls.js remains the
host's dependency. Prefer vendoring the verified file to relying on GitHub
release-download URLs as a JavaScript CDN. The separate publisher helper uses
Node filesystem/crypto APIs and does not belong in a browser bundle.

The release's [`SHA256SUMS`](https://github.com/forgesworn/relayswarm/releases/download/v0.1.0/SHA256SUMS)
covers both assets. Download all three into one directory and verify:

```sh
shasum -a 256 -c SHA256SUMS
```

## Run the source demo

```sh
git clone --branch v0.1.0 --depth 1 https://github.com/forgesworn/relayswarm.git
cd relayswarm
npm ci
npm run demo
```

Open `http://localhost:8787`. Synthetic live media requires ffmpeg with
libx264. Existing media does not require ffmpeg:

```sh
npm run demo -- --media-dir /path/to/hls --manifest master.m3u8
```

Keep uploading off until a viewer opts in. The demo has no participant admission
service and is intended for controlled trials. See [FIELD-TEST.md](FIELD-TEST.md)
for supported playlist features, TLS/reverse-proxy setup, relay/ICE choices and
baseline/swarm receipts. For documentation tooling introduced after the release,
use a current `main` checkout rather than the immutable `v0.1.0` source tag.

## Run the transfer proofs

From a source checkout after `npm ci`:

```sh
npm run poc                         # WebRTC CLI, public Nostr relays
npm run poc:native                  # HyperDHT CLI, public relays and DHT
npm run test:native                 # deterministic local relay and DHT
```

The original WebRTC CLI publishes signed plaintext SDP and uses the seeder's
own digest; it is a transport proof, not the browser peer-first integrity
contract. The native journey must obtain expected object identity from a
trusted source in a real application. Its CLI has no automatic HTTP fallback.
See [Native transport](NATIVE-TRANSPORT.md) for those boundaries.

## Troubleshooting

| Symptom | Check |
|---|---|
| Synthetic demo fails to start | `ffmpeg -version`; build must include libx264, or supply existing media |
| Remote page remains origin-only | Use device-trusted HTTPS; plain LAN HTTP lacks browser WebCrypto |
| No peer-first fragments | Opted-in seeder availability, shared swarm/context, trusted signed event and a working commitment endpoint; startup uses origin |
| No direct connection across networks | Relay/ICE policy and NAT reachability; TURN and super-peers are not implemented |
| `metrics().mode` is `off` | Inspect `disabledReason`; see integration options and validation |
| Public-relay test fails | Re-run before treating policy/availability changes as a code regression |

Current evidence and remaining device/network gates are in [STATUS.md](STATUS.md).
