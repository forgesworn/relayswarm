# RelaySwarm

Nostr-rendezvoused, hash-verified peer transfer for HLS video: browsers use
WebRTC signalled over Nostr relays instead of a dedicated tracker, and a
separate native path uses HyperDHT and Noise for installed Node applications.
This is a proof of concept, not a production engine; several features
described in the README (advanced multi-peer/ABR scheduling and a NIP draft)
remain out of scope. The browser loader supports shadow measurement and a
bounded peer-first mode using author-signed segment commitments.

## Build & Test

| Command | Purpose |
|---------|---------|
| `npm ci` | Install dependencies |
| `npm run check` | Syntax check (`scripts/check-syntax.mjs`) |
| `npm test` | End-to-end PoC + fan-out, against live Nostr relays |
| `npm run poc` | Two-peer WebRTC PoC (`poc.mjs`) |
| `npm run poc:native` | Two-peer native HyperDHT PoC (`native-poc.mjs`) |
| `npm run test:native` | Native path tests, local relay + local DHT bootstrap |
| `npm run test:swarm` | `src/browser/hls-swarm.mjs` unit tests |
| `npm run test:browser` | hls.js browser test (`--mode shadow` or `--mode peer-first`) |
| `npm run test:publisher` | Publisher context/range and demo HTTP/relay tests |
| `npm run test:operator` | Chrome upload allowance, remote policy and opt-in reports |
| `npm run broadcast:install` | Install platform-pinned MediaMTX test dependency |
| `npm run broadcast` | Supervised live ingest, persistent publisher and optional RTMPS |
| `npm run test:broadcast` | Real ingest/forward recovery and guard tests |
| `npm run test:broadcast:browser` | Real-time two-rendition Chrome playback/reconnect |
| `npm run test:playback` | Two-rendition Chrome playback and field-test demo regression |
| `npm run demo` | Local publisher/player, synthetic live media unless `--media-dir` supplied |
| `npm run audit` | `npm audit --audit-level=high` |
| `npm run check:docs` | Links, AI-index format and generated-context freshness |
| `npm run docs:generate` | Regenerate `llms-full.txt` from maintained Markdown |

Node 22+ is required (the global `WebSocket`); CI runs on Node 24. `npm test`
and `npm run poc` need an internet connection: they signal against real
public Nostr relays and exit non-zero if a transfer fails hash verification.
The native tests do not need the network; they bootstrap a local DHT.

## Structure

```
src/relay-session.mjs          RelayPool, RelaySwarmSession, ticket validation (main export)
src/browser/hls-swarm.mjs      hls.js shadow and peer-first integration (./hls-swarm export)
src/browser/segment-commitment.mjs  experimental signed media commitment contract
src/browser/peer-link.mjs      browser WebRTC peer link
src/hls-publisher.mjs          Node-only local HLS publisher and signed commitments
demo/                         runnable publisher/player with consent and local receipts
src/native-journey.mjs         native HyperDHT transfer orchestration
src/native-dht-transport.mjs   NativeDhtTransport, HyperDHT wiring
src/object-transfer.mjs        framing, hashing and object transfer primitives
poc.mjs                        two-peer WebRTC proof of concept (CLI)
native-poc.mjs                 two-peer native HyperDHT proof of concept (CLI)
test/                          e2e and unit tests
spikes/                        throwaway measurement code, see spikes/RESULTS.md
docs/                          NATIVE-TRANSPORT.md, THREAT-MODEL.md, LANDSCAPE.md, FAQ.md
```

## Conventions

- British English in prose and comments.
- Plain, factual claims only: state what is measured or proved, not what is
  planned; the README's "Deliberately out of scope" section lists what the
  PoC does not do.
- The original WebRTC PoC signs but does not encrypt SDP. The separate browser
  loader uses pairwise NIP-44 signalling, and the native path uses NIP-44 dial
  authorisation. Preserve this distinction in claims about encryption.

## Key Files

| File | Purpose |
|------|---------|
| `poc.mjs` | Browser-path PoC entry point |
| `native-poc.mjs` | Native-path PoC entry point |
| `INTEGRATION.md` | Host-page contract, options and kill switch for `hls-swarm.mjs` |
| `docs/NATIVE-TRANSPORT.md` | Native path protocol and security boundary |
| `docs/THREAT-MODEL.md` | Threat model the deliverable engine is tested against |
| `spikes/RESULTS.md` | Full results for the feasibility spikes |
| `docs/FIELD-TEST.md` | Demo, HTTPS configuration, receipt scope and unverified field gates |
| `docs/README.md` | Documentation navigation |
| `docs/GETTING-STARTED.md` | Exact release assets, pinned Git install and demo prerequisites |
| `docs/API.md` | Package exports and publisher/session/native API reference |
| `docs/STATUS.md` | Dated release evidence and remaining acceptance gates |
| `llms.txt`, `llms-full.txt` | Curated public AI index and generated documentation context |
| `docs/MAINTAINING-DOCS.md` | Documentation generation, validation and publication |

## Common Pitfalls

- `npm test` hits live public relays; a red run can mean relay weather, not
  a code fault. Re-run before concluding anything.
- v0.1.0 is a GitHub prerelease with a tarball and standalone browser bundle.
  The npm registry is unpublished; use the exact asset or pinned commit from
  `docs/GETTING-STARTED.md`. Do not move the release tag or replace its artifacts
  when correcting main-branch documentation.
- Do not present the original WebRTC PoC's signalling as encrypted.
- The demo keeps its author key on the server and receipts in the browser.
  Preserve playlist-bound signing and explicit upload consent. Chrome fixture
  tests are loopback; do not describe them as physical-device/NAT validation.
- Package version 0.1.0, session wire version 3, commitment schema 1 and metrics
  version 2 are distinct. RelaySwarmKit's README describes wire version 2;
  current cross-client interoperability has not been proved.
- Update authored Markdown and `llms.txt`, then run `npm run docs:generate`
  and `npm run check:docs`. Do not hand-edit generated `llms-full.txt`.
- Keep AI material factual: published links do not prove search indexing or
  recommendations. The public surface is GitHub, not a configured docs website.
- Broadcaster additions are unreleased source, absent from v0.1.0 assets.
  Live-source sequence numbers continue across published generations; the
  attempt counter is distinct from visible HLS discontinuity.
- Private publisher state and tokens require POSIX file permissions. An
  unclean broadcaster exit preserves its exclusive lock for operator recovery.
