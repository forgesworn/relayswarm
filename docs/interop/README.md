# RelaySwarmKit v3 review proposal

The current public Kit revision is incompatible with RelaySwarm's encrypted
session v3. A test-only adapter proved that its unchanged crypto, relay and
libdatachannel components can participate in a real v3 session and verified
binary transfer. This directory contains a concrete migration proposal for the
separate Kit repository. No external checkout, branch or release was changed.

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

## Remaining upstream/client gates

Applying this patch is a deliberate cross-repository scope decision. After
approval, run the external repository's exact-head checks, update its public
API documentation, release and pin the resulting revision, and replace the
fixture adapter with the published APIs before claiming current stock-client
compatibility.

The proposal updates rendezvous and SDK negotiation. It does not add an HLS
consumer, a trusted author/delegation/revocation resolver, signed media framing
or viewer upload-consent policy to the Kit. Those checks remain application
responsibilities. Host admission before SDP disclosure and bounded buffering of
application data also need explicit production policies; a valid Nostr event
alone is not permission to join a stream or redistribute content. Physical
Apple devices, real NAT combinations and long-running cross-client operation
remain unverified. HyperDHT is a different transport and is not implemented by
the inspected Kit.
