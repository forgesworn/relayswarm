# Native operator real-time backend

Experimental, initiator-only transport for opaque datagrams. It does not
capture, encode, decrypt, record or play media. The existing browser adapter,
NIP-44 session, application admission and media queues remain separate.

`src/node/native-realtime.mjs` loads no native dependency on import. A dedicated
operator supplies a source-built **node-datachannel 0.33.4** addon whose
native library identifies itself as **0.24.5-forgesworn-turn-close.1**. Both
versions are checked. The stock npm binary is refused. Browser consumers
load no native code; explicit preparation belongs to the operator build.

## API and ownership

```js
import { createRequire } from 'node:module';
import { readPreparedNativeRealtime } from './scripts/build-native-realtime.mjs';
const directory = '/absolute/path/to/prepared-native';
const { receipt } = await readPreparedNativeRealtime(directory);
const binding = directory + '/native-addon.node';
const nodeDataChannel = createRequire(binding)(binding);
import { createNativeRealtimeBackend } from './src/node/native-realtime.mjs';

const backend = await createNativeRealtimeBackend({
  nodeDataChannel,
  packageVersion: receipt.bindingVersion,
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

The pinned native libjuice backend supports **TURN over UDP only**. This
facade refuses TURN/TCP and TURN/TLS configuration before allocating a peer,
including under `all` policy, so unsupported servers cannot be silently
ignored in favour of a direct connection. This limit belongs to the native
backend; it is not a claim that the browser or Spry lacks those transports.

Native `send(false)` means the message was accepted into a buffer, not refused.
The shared datagram link checks native `bufferedAmount` before sending. This
facade preserves the standard void-send behaviour and treats native
exceptions as failure. Finite transport expiry and receiver observations
remain relevant; accepted-send counters alone do not prove delivery.

## Qualification

```sh
node --test test/native-realtime.test.mjs
node scripts/build-native-realtime.mjs --output target/realtime-native
E2E_NATIVE_ARTIFACT=/absolute/path/to/target/realtime-native \
  node test/native-realtime-browser.mjs
E2E_NATIVE_BINDING=/absolute/path/to/target/realtime-native/native-addon.node \
  python3 test/native-turn-lifecycle.py
```

The browser command verifies the explicit prepared receipt and binary, then
fails on missing, altered or mismatched inputs. There is no successful skipped mode. An optional
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

### Stock TURN allocation-release finding

The stock 0.33.4/0.24.5 native backend failed a separate allocation-release
gate against an authenticated synthetic loopback TURN server. Both the raw
binding and this facade obtained a relay candidate, returned from close and
process-global cleanup, and released their local UDP socket while the process
was still alive. Neither sent `Refresh(lifetime=0)`. Socket ownership cleanup
therefore does not establish prompt release of a server allocation.
[Retained observations](evidence/native-turn-close-stock-20261024.json) keep
that failure distinct from the passing browser/datagram gate.

`test/native-turn-release.py` reproduces the check with fixture credentials;
it contacts no live relay and exits unsuccessfully when release is missing.
It requires an explicit exact `E2E_NATIVE_PACKAGE_ROOT`; `PROBE_MODE=facade`
selects the owned wrapper and `E2E_NATIVE_BINDING` can explicitly select a
separately built sidecar. A native-source correction needs independent
identity, source/patch/binary receipts and release qualification. Reissuing
credentials, increasing quota or restarting a relay does not repair teardown.

## Dependency and licence boundary

This adapter's original source follows RelaySwarm's MIT licence. The native
dependency is separately **MPL-2.0**; the combined distribution must not be
labelled MIT-only. Binary packaging must retain its licence/notices and make
the covered source, including any modifications, available as required by
that licence. The prepared artifact includes the reviewed dependency licence inventory,
exact source revisions, complete patches and hashes of its emitted files.
Modified MPL-covered files are libjuice `src/agent.c`, `src/agent.h` and
libdatachannel `include/rtc/version.h`; SCTP source is unchanged.

Primary pinned sources:

- [node-datachannel 0.33.4 package](https://registry.npmjs.org/node-datachannel/0.33.4)
- [Native binding source and licence](https://github.com/murat-dogan/node-datachannel/tree/v0.33.4)
- [Pinned native build configuration](https://github.com/murat-dogan/node-datachannel/blob/v0.33.4/CMakeLists.txt)
- [libdatachannel 0.24.5 source and licence](https://github.com/paullouisageneau/libdatachannel/tree/v0.24.5)
- [Buffered-send contract](https://github.com/paullouisageneau/libdatachannel/blob/v0.24.5/include/rtc/channel.hpp)

### Source-built allocation teardown

Explicit preparation builds only pinned source inputs with at most two jobs.
Each invocation owns fresh source and derived directories; it never trusts an
existing OpenSSL/CMake cache or modifies an installed npm prebuild. The
receipt and library version identify a modified binary. Preparation downloads
sources; importing the verifier or starting an operator never does.

The libjuice change sends explicit authenticated `Refresh(lifetime=0)` on the
existing allocation socket before destroying it. Receive processing remains
alive for stale-nonce challenges; a single closing loop owns retries and
transaction IDs. Each agent has a 500ms deadline and at most six requests per
allocation. A 438 updates the nonce and starts a fresh transaction. Validated
success with explicit lifetime zero, or allocation-mismatch 437, completes
release. Success validation uses upstream transaction IDs and MESSAGE-INTEGRITY;
upstream error handling does not require error-response integrity. This patch
does not introduce a general TURN response-source validation change.

Release is best effort under packet loss or partition: an unreachable server
can retain its allocation until expiry. Eight serial fully blackholed agents
can consume approximately four seconds plus scheduling overhead. This bound
is per agent, not per process. No credential rotation or quota increase is a
substitute for cleanup.

`test/native-turn-lifecycle.py` uses only authenticated synthetic loopback TURN
with a cap of eight and one unchanged fixture credential. It checks normal
and dropped-request `8 → 0 → 8 → 0` reuse, delayed 350ms stale-nonce challenges,
invalid-HMAC and wrong-transaction success replies, lost/late acknowledgements,
and bounded whole-process cleanup when all release packets are blackholed.
[The retained macOS arm64 lifecycle run](evidence/native-turn-lifecycle-20261024.json)
passed all eight scenarios. Normal, dropped-first-two and delayed-nonce cases
each released and reused eight slots twice. All-eight blackhole cleanup
returned in 4254ms while the fake server correctly retained eight allocations.
[Patched native/browser qualification](evidence/native-realtime-patched-loopback-20261024.json)
also passed actual unordered 250ms DCEP and binary exchange. These are
synthetic loopback gates; Linux runtime and public Spry lifecycle acceptance
remain separate.

Every accepted release request must carry the correct HMAC, realm, username,
nonce and original client UDP tuple. Blackhole allocation retention is an
expected limitation, reported separately from successful release.

Neither native implementation, operator independence nor absent call logs
establishes an Online Safety Act exemption.
