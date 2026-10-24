# Experimental real-time transport

The source-only `relayswarm/realtime-peer` export carries opaque datagrams
over an explicitly selected WebRTC peer. It reuses `RelaySwarmSession` wire
version 3's signed pairwise NIP-44 signalling with a separate `webrtc-live`
transport token. HLS `PeerLink` and the loader keep their ordered reliable
protocol unchanged. This module is not included in the immutable v0.2.1
release or its browser bundle.

This is a transport component for a new call adapter, not an SFU, codec,
media-key service or room implementation. The application must authenticate
and encrypt media before sending it, authorise recipients, reassemble bounded
fragments, enforce frame deadlines and request video recovery after loss.
DTLS protects each link but does not by itself hide media from a forwarder
which terminates that link. No logging, recording, discovery announcement,
credential issuer or automatic peer/service selection is added here.

## API

```js
import { RealtimePeer } from 'relayswarm/realtime-peer';

// pool and session are host-selected and connected/started already.
// Resolve the selected peer's key through the application's trust policy.
const peer = new RealtimePeer({
  session,
  peerPubkey: selectedPeerPubkey,
  initiator: true,
  iceServers: deviceSelectedIceServers,
  iceTransportPolicy: 'relay',
  onDatagram: bytes => admitToBoundedFrameReceiver(bytes),
  onClose: reason => handleTransportClosure(reason),
  signal: cancellation.signal,
});
await peer.start(); // also available as peer.ready
const sent = peer.send(alreadyEncryptedFragment, {
  deadlineMs: performance.now() + 100,
});
if (!sent) requestApplicationRecovery();
// Numeric counters only, with no SDP, addresses, credentials or payloads.
const counters = peer.snapshot();
peer.close();
```

Construct the receiving side with `initiator: false` and its explicit sender
key, then start it before the initiator. Both sides can be given the same
`requestId` (8 to 64 URL-safe ASCII characters) when the host already has a
fresh negotiation capability. Otherwise the initiator generates a random ID
and the receiver binds to the first offer from its pinned peer. Replacement
uses a new peer instance. Caller admission remains necessary: knowing a
Nostr public key is not proof of room entitlement.

`start()` returns the same `ready` promise, resolving with its
`RealtimeDatagramLink`. The native connection is available as `peer.pc` for
caller read-only statistics. `send(Uint8Array | ArrayBuffer, { deadlineMs })`
returns a boolean. `deadlineMs` uses the same monotonic millisecond clock as
the optional injected `now()` callback; omitted deadlines have no transport
expiry. Once SCTP accepts bytes, the application cannot recall them. A
receiver must still reject an expired complete frame.

`RealtimeDatagramLink` can wrap an application-negotiated `pc`/`channel`
directly. It requires the label `relayswarm-live-v1` and `ordered: false`.
The default mode requires `maxRetransmits: 0` and `maxPacketLifeTime: null`.
An explicit `maxPacketLifeTimeMs` option (integer 1 to 1000) instead requires
`maxRetransmits: null` and exactly the selected `maxPacketLifeTime` value.
Both endpoints must select the same mode and lifetime. Ordered, reliable,
different-lifetime and different-mode channels are refused; there is no
automatic switch or HLS fallback. The same constraints apply to channels
received by `RealtimePeer`. Snapshots name the selected delivery mode and
lifetime without exposing credentials or payloads.

For a media forwarding service, explicitly selecting 50 ms lifetime bounds
unsent and retransmission eligibility in a correctly implemented backend.
Zero retries alone does not impose an unsent queue deadline. Negotiated flags
do not prove backend conformance; use the guarded Node correction below.

## Bounds and lifetime

- Default datagrams are at most 16 KiB; the configurable hard maximum is
  64 KiB. Larger media frames need application fragmentation.
- Default SCTP buffered-data allowance is 256 KiB, configurable up to 4 MiB.
  A send that would exceed the allowance is dropped, without an application
  transport queue, retry or deferred send.
- Async receive callbacks are capped at 16 in flight by default on the link.
  Additional datagrams are dropped; callback rejection closes with a generic
  reason. A synchronous admission callback can hand bytes to a separately
  bounded receiver. Closing cannot cancel an already-running callback, so
  callers must check their own cancellation before applying async results.
- Each peer accepts at most 128 ICE candidates per direction, at most 4 KiB
  per candidate and 6 KiB SDP. Candidate-before-description and replica
  reordering are retained only inside those bounds. The default connection
  deadline is 15 seconds (configurable up to 60 seconds).
- Abort, timeout, native/channel failure or explicit close removes listeners,
  clears candidate queues, closes channel/connection and rejects unfinished
  readiness with a generic error. The caller owns the shared session/pool;
  closing one peer does not close those shared resources.
- `iceServers` and `iceTransportPolicy` are supplied by the host. The policy
  defaults to `relay` with no ICE servers. No root TURN secret or default
  service is supplied. An empty relay configuration cannot establish a path.

## Verification scope

Run `npm run test:realtime`. The tests exercise bounds, late data, protocol
refusal, cancellation, timeout, pinned peers/IDs, candidate reordering and an
actual `RelayPool`/NIP-44 session exchange through an in-memory relay. The
native peer connection in these unit tests is a fixture, so they do not prove
browser SCTP behaviour, WAN/NAT traversal, real media playback or a complete
Spry/Sapflow/KithMoot call. Those require the consuming adapter's integration
tests. This component establishes no legal exemption for the combined offering.

`npm run test:realtime:native` additionally runs an actual Chromium initiator
against a Node werift 0.24.3 answerer, with real WebRTC and encrypted session
signalling over a loopback relay. Both directions carry generated datagrams
and the native incoming channel must be unordered with zero retransmits.
The qualifier requires the matching Playwright Chromium installation (or
`E2E_CHROMIUM_EXECUTABLE`). It passed on the development Mac. It does not
exercise TURN, remote networks, audiovisual decoding or phone devices.

The original uncorrected Node qualifier role is **answerer only**. Werift 0.24.3's outgoing DCEP
encoding overwrites the unordered channel bit when maxRetransmits is set;
an initiating werift peer therefore fails the strict receiver check. Do not
weaken that check to make a Node initiator pass. The browser initiates each
connection to an independent Node forwarding operator. The receiver accepts
the browser's correctly encoded unordered channel and sends on that channel.

Always pass explicit ICE configuration to the Node implementation. Werift
otherwise supplies a default STUN service; it selects the first supplied
STUN and TURN URL rather than establishing browser-like multi-server
fallback. Source inspection maps relay policy to its `forceTurn` option;
that inspection is not a live TURN qualification. Operator wrappers must
also disable/reject inherited dependency debugging (`DEBUG`) before opening
connections: dependency diagnostics can include ICE credentials. The
transport module itself adds no logger.

## Guarded Node backend build

The opt-in `relayswarm/realtime-werift-build` module corrects one exact
werift 0.24.4 ESM source revision during an esbuild Node build. It neither
edits installed packages nor changes another application's dependency.
The exported `weriftRealtimeRevision` records the reviewed upstream file
SHA-256 values. Unknown metadata/source, browser builds, external-package
builds and unsupported werift subpath imports are refused. There is no
uncorrected fallback.

```js
import { build } from 'esbuild';
import { realtimeWeriftPlugin } from 'relayswarm/realtime-werift-build';

await build({
  entryPoints: ['operator-entry.mjs'], // imports RTCPeerConnection from werift
  outfile: 'operator.mjs',
  platform: 'node', format: 'esm', bundle: true,
  // Supply the normal createRequire shim if bundled dependencies require it.
  plugins: [await realtimeWeriftPlugin({ packageRoot: reviewedWeriftDirectory })],
});
```

The changes preserve unordered DCEP mode bits, recognise zero retransmits,
capture lifetime in monotonic seconds when the data-channel send is enqueued, discard
expired application-queue data, and refuse expired SCTP data before first
send or retransmission. A single timer per association expires queued media
even without a window-opening event. Abandonment identifies the exact DATA
chunk and its message fragments rather than another message with the same
chunk type. Flight-byte accounting follows abandonment and retransmission.
The latest FORWARD TSN control skip is retained until cumulative acknowledgement
and retried using the unchanged control timer if lost; expired media is not
retransmitted. Association closure cancels its added expiry timer.
The upstream MIT notice is retained explicitly in the generated bundle,
alongside dependency legal comments. The published npm package omitted its
licence file; the notice comes from the
[upstream repository licence](https://github.com/shinyoshiaki/werift-webrtc/blob/develop/LICENSE).
The guard does not independently pin all transitive dependencies: retain the
consuming application's lockfile and build provenance as separate inputs.

Run the conformance tests with the reviewed installation supplied explicitly:

```sh
WERIFT_REALTIME_PACKAGE_ROOT=/path/to/reviewed/node_modules/werift npm run test:realtime:backend
```

Without that variable the conformance command fails; it cannot turn green
by skipping the backend cases. With the reviewed source, the tests build the
corrected module and exercise actual serialised SCTP packets through a finite
in-memory lossy transport. They prove zero-retry loss recovery, expiry behind
a zero receive window, correct message selection, fragmented-message loss
and lifetime-unit/application-queue handling. They also cover wall-clock
rollback, lost control-skip recovery and expiry timer cleanup. The packet fixture accelerates
the retransmission trigger; production retry timers, ICE consent and native
resource limits remain unchanged. This is SCTP wire proof, not WAN or physical
device qualification.

The Chromium-to-native qualifier can consume the generated module explicitly:

```sh
E2E_REALTIME_BACKEND_MODULE=/path/to/corrected-backend.mjs E2E_REALTIME_LIFETIME_MS=50 npm run test:realtime:native
```

That path is a mandatory explicit selection when qualifying finite-lifetime
native forwarding. An omitted backend path retains the historical direct
upstream diagnostic; it does not establish corrected loss/expiry behaviour.
