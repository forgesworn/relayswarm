# RelaySwarmKit interoperability

## Current core-backed SDK

[Kit v0.6.0](https://github.com/forgesworn/relayswarm-kit/releases/tag/v0.6.0)
adopts RelaySwarm's v0.3.0 Rust core through a checksum-pinned XCFramework and
the release's unedited UniFFI wrapper. Its 54-test suite (one opt-in skip)
replays all 140 verifier vectors and 48 link traces, and exercises actual
libdatachannel upload pacing, cancellation and schema-3 source accounting.
Its transport remains macOS arm64 only. Core iOS slices do not add iOS WebRTC.

`test/interop-current-sdk-browser.mjs` uses public SDK APIs without a wire
adapter. The default run covers schema-2 whole-object reception through
`SwarmGuest`, `MediaDataChannel` and `SignedMediaTransfer`. `--pieces` connects
two Chrome HAVE holders through framing-2 admission and uses `CoreMediaPeer`
and `SignedPieceTransfer`. Production browser code supplies generated real
H.264/AAC fMP4 media. Author/delegate cases verify the complete object; corrupt
media, signature tampering and pre-request/in-flight revocation deliver zero
media. Positive piece cases credit both holders and zero origin bytes. The
piece fixture uses explicitly labelled timing estimates, not measured rates.

```sh
npm run test:interop:kit -- --evidence artifacts/current-sdk-browser.json
npm run test:interop:kit -- --pieces --evidence artifacts/current-sdk-pieces-browser.json
```

Use the pinned SDK checkout in `../relayswarm-kit`, or set
`RELAYSWARM_KIT_DIR`. CI pins its full commit and retains both receipts with
source hashes. Temporary local relay and HTTP listeners bind to loopback and
are closed after the test. Publishing or consuming either library does not
require a ForgeSworn-hosted service. Applications choose media, relays,
admission, trust, consent and origin-range handling. Physical Apple devices,
public NAT, long-running field quality and net hosting benefit remain unproved.

## Historical v0.5.0 SDK checkpoint

Published [Kit v0.5.0](https://github.com/forgesworn/relayswarm-kit/releases/tag/v0.5.0)
points to `2f0b26ace4096a5dca87baf715274f91c331ac3a`. Its PR and merged-head CI
pass, including 39 tests with one opt-in public-relay test skipped. The SDK
supplies mandatory encrypted v3 signalling, bounded media framing and independent
author/delegation/revocation verification. All five release assets were
downloaded anonymously and checked against their SHA-256 manifest. GitHub
reports the release's `immutable` flag as false; checksum-pinned bytes are
verified, but platform-enforced locking is not claimed.

`test/interop-current-sdk-browser.mjs` uses the public `SwarmGuest`,
`MediaDataChannel` and `SignedMediaTransfer` APIs with the production browser
loader. At JavaScript source `c3dabf6` and the same SDK tree as the release,
author and delegate transfers each returned 108,950 real fMP4 HLS bytes.
Corruption, tampering, pre-request revocation and revocation at EOF each returned
zero bytes. There is no Swift wire adapter. This is macOS arm64 and desktop
Chrome on loopback; it does not establish physical Apple-device, public-NAT
or native HLS decoding acceptance.

The consuming application owns publisher trust, revocation freshness, origin
fallback, playback and upload consent.

## Historical v2 review proposal

The baseline below was incompatible with encrypted session v3. A test-only
adapter proved its unchanged crypto, relay and libdatachannel components could
participate in a real v3 session and verified binary transfer. The retained
proposal was prepared before the separate repository upgrade; it is not the
complete diff of the published v0.5.0 SDK.

- Base Kit revision: `7eb042ee0fc0e960780c61d755a2ec50f1a8be40`.
- Review patch: [relayswarm-kit-v3.patch](relayswarm-kit-v3.patch).
- Original/proposed file hashes: [relayswarm-kit-v3-sources.json](relayswarm-kit-v3-sources.json).
- Patch SHA-256: `23c471a9dcbf528471146ff54caa6c430752eae160fd374c1ce769ad4e747d77`.

The patch makes NIP-44 mandatory, replaces the session v2 format with v3's
transport/request ID/nested payload contract, removes plaintext fallback and
requires bounded presence descriptors. It checks exact recipient/swarm tags,
120-second age/30-second future tolerance and byte limits. It bounds cached
conversation keys at 64, live SDK host peers at 16 and relay messages at 1 MiB.
Host answers preserve their offer's request ID; guests accept only their pending
counterparty, request ID and transport. SDK host presence changes from `origin`
to `seeder`, matching RelaySwarm's current native/browser session policy.

This is a breaking API migration: `SwarmSignaller.send(type:sdp:to:requestID:transport:ticket:)`
requires a request ID. A matching answer passes `signal.requestID` and
`signal.transport`. Applications using `rawJSON` must read the nested payload,
and callers cannot rely on automatic legacy decoding. Update the Kit README,
consumer examples and release notes alongside any approved upstream application
of the patch; those external publication changes are outside this proposal.

## Recorded validation

On 13 October 2026, the review script applied the patch to a task-owned snapshot,
verified every before/after source hash and compiled the actual Kit target graph
against its pinned secp256k1 revision. The full SDK suite executed 26 tests:
25 passed, one public-relay test was explicitly skipped, and none failed.
Coverage includes real SDK host/guest loopback WebRTC, binary channels, canonical
Nostr/NIP-44 crypto tests and new v3 downgrade, malformed envelope, duplicate tag,
recency, descriptor and resource tests.

The retained local receipt is
`artifacts/relayswarm-kit-v3-proposal-tests.json`. Reproduce the review on macOS
arm64 with Swift and read-only authenticated `gh` access:

```sh
node scripts/protocol-check-kit-patch.mjs
```

The script downloads exact public component/test sources and patches only its
owned scratch package. It removes that package after recording a passing
receipt. A failure retains scratch for diagnosis. `--resume` requires every
patched source to match the review manifest before testing a retained snapshot.
Do not run it concurrently with the base interop fixture; both deliberately
reuse `artifacts/protocol-swift-kit`.

The independent JavaScript/Swift fixture is separate:

```sh
node test/interop-swift.mjs --evidence artifacts/relayswarm-swift-interop-current.json
```

Its retained 13 October receipt records incompatible stock v2 signalling and a
successful explicit Swift v3 adapter journey: 262,181 bytes in 17 WebRTC chunks,
12 independently decoded commitment cases and rejection of corrupted bytes.
It includes exact toolkit/dependency revisions and hashes for the tested
working-tree implementation. This proves the fixture/component boundary,
not interoperability of a published Kit v3 client.

## Historical proposal boundary and remaining acceptance

The subsequent authorised upgrade added media verification/framing and public
API documentation, passed exact-head checks and released the pinned SDK above.
Current compatibility evidence uses its public APIs; the earlier adapter receipt
remains historical component evidence.

The original proposal updated rendezvous and SDK negotiation. It did not add an HLS
consumer, a trusted author/delegation/revocation resolver, signed media framing
or viewer upload-consent policy. The released SDK now verifies signed media and
bounds its framing; the application still supplies current trust and admission
policies. A valid Nostr event
alone is not permission to join a stream or redistribute content. Physical
Apple devices, real NAT combinations and long-running cross-client operation
remain unverified. HyperDHT is a different transport and is not implemented by
the inspected Kit.
