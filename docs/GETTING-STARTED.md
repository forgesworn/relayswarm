# Getting started with RelaySwarm

[Documentation](README.md) · [API](API.md) · [hls.js integration](../INTEGRATION.md)

These installation instructions target the prepared experimental
[v0.4.4 GitHub prerelease](https://github.com/forgesworn/relayswarm/releases/tag/v0.4.4).
Confirm that tag and its checksum-listed assets have been published before
using these pinned commands; a prepared version is not a verified download.
Node 22.13+ is required; CI runs Node 24. `npm install relayswarm` is not the
documented distribution path: the npm registry is unpublished.

## Install for a host application

```sh
npm install https://github.com/forgesworn/relayswarm/releases/download/v0.4.4/relayswarm-0.4.4.tgz
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

A Git dependency can also be pinned to the versioned release tag:

```sh
npm install 'git+https://github.com/forgesworn/relayswarm.git#v0.4.4'
```

## Use the standalone browser bundle

Download
[`relayswarm-hls-swarm-0.4.4.mjs`](https://github.com/forgesworn/relayswarm/releases/download/v0.4.4/relayswarm-hls-swarm-0.4.4.mjs)
and serve it from your own application:

```js
import { createHlsSwarm } from './relayswarm-hls-swarm-0.4.4.mjs';
```

The bundle contains the loader's runtime dependencies; hls.js remains the
host's dependency. Prefer vendoring the verified file to relying on GitHub
release-download URLs as a JavaScript CDN. The separate publisher helper uses
Node filesystem/crypto APIs and does not belong in a browser bundle.

The release's [`SHA256SUMS`](https://github.com/forgesworn/relayswarm/releases/download/v0.4.4/SHA256SUMS)
covers the tarball, browser bundle, WASM module and JavaScript build metadata.
Download those four files and the manifest into one directory and verify:

```sh
shasum -a 256 -c SHA256SUMS
```

## Use the optional shared core

Download [`relayswarm-core-0.4.4.wasm`](https://github.com/forgesworn/relayswarm/releases/download/v0.4.4/relayswarm-core-0.4.4.wasm)
and serve it beside the browser bundle with `Content-Type: application/wasm`.
Pass its URL through `coreWasm`; enable experimental `multiHolder` and
`peerSupplyHint` only when the host intends to use them. A Content Security
Policy must permit WebAssembly compilation, for example with
`'wasm-unsafe-eval'` in `script-src`. See [Integration](../INTEGRATION.md) for
fallback, feature requirements and the advisory hint callback.
The tarball also contains the committed module under `src/browser/`.

## Use the native core assets

The [v0.4.4 release](https://github.com/forgesworn/relayswarm/releases/tag/v0.4.4)
includes `relayswarm-core.xcframework.zip`, its `.checksum`,
`relayswarm-core-swift-bindings.zip` and `relayswarm-core.aar`. Download the
platform's `SHA256SUMS-apple` or `SHA256SUMS-android` and every file listed in
it, then run `shasum -a 256 -c SHA256SUMS-apple` (or the Android manifest).
Native metadata identifies the same tagged source as the JavaScript metadata.

Extract both Apple archives beside one another to use the local-path Swift
package; its minimums are iOS 16 and macOS 14, arm64 only. The AAR requires
Android API 26+, Kotlin 2.2+ and `net.java.dev.jna:jna:5.14.0@aar`.
See [Native core packaging](CORE-PACKAGING.md) for the complete dependency,
build and verification contract. These are core bindings, with no native
WebRTC adapter or client application. RelaySwarmKit v0.6.0 separately consumes the v0.3.0 core; its existing WebRTC transport remains macOS arm64 only.

## Run the source demo

```sh
git clone --branch v0.4.4 --depth 1 https://github.com/forgesworn/relayswarm.git
cd relayswarm
npm ci
npm run demo
```

Open `http://localhost:8787`. Synthetic live media requires ffmpeg with
libx264. Existing media does not require ffmpeg:

```sh
npm run demo -- --media-dir /path/to/hls --manifest master.m3u8
```

Keep uploading off until a viewer opts in. The published demo is intended for
controlled trials; current source adds bounded ticket admission. See [FIELD-TEST.md](FIELD-TEST.md)
for supported playlist features, TLS/reverse-proxy setup, relay/ICE choices and
baseline/swarm receipts. Current source adds the broadcaster workflow; it is
absent from v0.1.0. See [Broadcasting](BROADCASTING.md) for live input and
optional independent RTMPS forwarding.

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
| No direct connection across networks | Relay/ICE policy and NAT reachability; hosts may supply TURN credentials, but managed TURN and super-peers are absent |
| `metrics().mode` is `off` | Inspect `disabledReason`; see integration options and validation |
| Public-relay test fails | Re-run before treating policy/availability changes as a code regression |

Current evidence and remaining device/network gates are in [STATUS.md](STATUS.md).

## Development source

The published commands above install v0.4.4. Later development lands on
`main`, a mutable reference; its
[production features](PRODUCTION-FEATURES.md) and
[delivery requirements](PRODUCTION-READINESS.md) have separate evidence.
For the latest source:

```sh
git clone --depth 1 https://github.com/forgesworn/relayswarm.git
cd relayswarm
npm ci
npm run demo
```

Both v0.4.4 and current development source include the installed native
executable, verified HTTP fallback and wider-media tests:

```sh
npm run native:fetch -- --help
npm run test:media-browser
npm run test:media-recovery          # actual corrupt-media repair/cancel/deadline journeys
npm run test:interop
npm run test:interop:kit             # published SDK API, not the historical adapter
npm run test:interop:kit -- --pieces # schema-3, two browser holders, released core
```

The historical adapter fixture requires macOS arm64 and read-only authenticated
`gh` access to its pinned public sources. The current SDK fixture uses published
Kit v0.6.0 in `../relayswarm-kit` (or `RELAYSWARM_KIT_DIR`) and requires Swift 6,
macOS arm64, Chrome and ffmpeg. Its verified transfer and acceptance boundaries
are in the [interop guide](interop/README.md).
