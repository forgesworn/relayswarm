# Native operator real-time backend

Experimental, initiator-only transport for opaque datagrams. It does not
capture, encode, decrypt, record or play media. The existing browser adapter,
NIP-44 session, application admission and media queues remain separate.

`src/node/native-realtime.mjs` loads no native dependency on import. A dedicated
operator supplies **node-datachannel 0.33.4**, whose native library identifies
itself as **libdatachannel 0.24.5**. Both versions are checked. Dependency
installation belongs to the embedding application; RelaySwarm does not add
this dependency to every browser or native consumer.

## API and ownership

```js
import * as nodeDataChannel from 'node-datachannel';
import { createNativeRealtimeBackend } from './src/node/native-realtime.mjs';

const backend = await createNativeRealtimeBackend({
  nodeDataChannel,
  packageVersion: '0.33.4', // Read the installed package metadata in the host.
  maxPacketLifeTimeMs: 250,
  maxPeers: 16,
});

// Pass backend.RTCPeerConnectionImpl to RealtimePeer on the operator side,
// with initiator:true and the same explicit finite lifetime. The browser
// installs its answerer before the operator starts sending an offer.
// ICE servers and all/relay policy remain explicit application inputs.

backend.closeOwnedPeers();
// Only at dedicated process exit, after every call has closed:
backend.disposeForProcessExit();
```

The factory returns `RTCPeerConnectionImpl`, `closeOwnedPeers`, `snapshot` and
`disposeForProcessExit`. `closeOwnedPeers` closes all peers it created and
refuses new ones. It does not call the dependency's process-global cleanup.
`disposeForProcessExit` also invokes that global cleanup exactly once; it is
unsuitable as the cleanup operation for one call in a shared native process.

The facade implements the subset used by `RealtimePeer`: offer creation,
local offer application, remote answer application, trickled ICE, state and
data-channel events, bounded binary sends, buffering observations and close.
It is not a complete browser RTCPeerConnection polyfill. Native automatic
channel negotiation has already applied an offer when `createOffer` resolves.

## Initiator boundary

The upstream 0.33.4 polyfill caches channel reliability attributes from
constructor options. For an incoming channel it supplies no options, so
those attributes describe defaults rather than the actual remote DCEP mode.
The native binding exposes no reliability getter. This adapter therefore
**refuses remote offers, answer creation and all incoming channels**.

It creates one exact `relayswarm-live-v1` channel locally, requesting unordered
delivery and the configured finite lifetime. Its exposed attributes describe
that local native request. The actual browser answerer independently checks
the remote channel's negotiated DCEP values and refuses mismatches. The
operator must not select this backend as an answerer or relabel unknown
remote channels to pass the shared policy gate.

ICE starts with no default STUN server. The host must supply `iceServers`
and `iceTransportPolicy`; relay policy is not downgraded. TURN credentials
use the native structured ICE API, preserving opaque colons, slashes and plus
signs instead of interpolating them into URI user-info. DTLS fingerprint
verification remains enabled. Native logging is initialised at `None`; there
is no per-call log writer in this module. Host/provider logging is separate.

Native `send(false)` means the message was accepted into a buffer, not refused.
The shared datagram link checks native `bufferedAmount` before sending. This
facade preserves the standard void-send behaviour and treats native
exceptions as failure. Finite transport expiry and receiver observations
remain relevant; accepted-send counters alone do not prove delivery.

## Qualification

```sh
node --test test/native-realtime.test.mjs
E2E_NATIVE_PACKAGE_ROOT=/absolute/path/to/node_modules/node-datachannel \
  node test/native-realtime-browser.mjs
```

The browser command requires an explicit installed package and fails on a
missing/wrong version. There is no successful skipped mode. An optional
`E2E_CHROMIUM_EXECUTABLE` selects a host-installed test browser. It exercises
the real native initiator against a real Chromium answerer through encrypted
RelaySwarm signalling and verifies actual browser DCEP reliability, binary
datagrams containing NUL/255 in both directions and rejection of an unexpected
incoming channel. Its finite process closes peers, relay, browser and native
runtime. It captures no camera, microphone, screen or media recording.

Initial macOS arm64 loopback qualification passed on the development Mac
and M4 with Node 24, package 0.33.4 and native library 0.24.5. The M4 run used
an isolated temporary source copy and existing dependencies without changing
shared installations. [Retained observations](evidence/native-realtime-loopback-20261024.json)
record the exact gate. This is not Linux runtime acceptance,
public-NAT performance, multi-participant media acceptance or a release.

## Dependency and licence boundary

This adapter's original source follows RelaySwarm's MIT licence. The native
dependency is separately **MPL-2.0**; the combined distribution must not be
labelled MIT-only. Binary packaging must retain its licence/notices and make
the covered source, including any modifications, available as required by
that licence. The binary's remaining dependency notices need an inventory
before distribution. This work modifies no upstream native/SCTP source.

Primary pinned sources:

- [node-datachannel 0.33.4 package](https://registry.npmjs.org/node-datachannel/0.33.4)
- [Native binding source and licence](https://github.com/murat-dogan/node-datachannel/tree/v0.33.4)
- [Pinned native build configuration](https://github.com/murat-dogan/node-datachannel/blob/v0.33.4/CMakeLists.txt)
- [libdatachannel 0.24.5 source and licence](https://github.com/paullouisageneau/libdatachannel/tree/v0.24.5)
- [Buffered-send contract](https://github.com/paullouisageneau/libdatachannel/blob/v0.24.5/include/rtc/channel.hpp)

Neither native implementation, operator independence nor absent call logs
establishes an Online Safety Act exemption.
