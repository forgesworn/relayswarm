# RelaySwarm

Nostr-rendezvoused, hash-verified peer transfer for HLS video: browsers use
WebRTC signalled over Nostr relays instead of a dedicated tracker, and a
separate native path uses HyperDHT and Noise for installed Node applications.
This is a proof of concept, not a production engine; several features
described in the README (multi-peer scheduling, an hls.js loader plugin, a
NIP draft) are explicitly out of scope for the code in this repository.

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
| `npm run test:browser` | hls.js shadow-mode browser test |
| `npm run audit` | `npm audit --audit-level=high` |

Node 22+ is required (the global `WebSocket`); CI runs on Node 24. `npm test`
and `npm run poc` need an internet connection: they signal against real
public Nostr relays and exit non-zero if a transfer fails hash verification.
The native tests do not need the network; they bootstrap a local DHT.

## Structure

```
src/relay-session.mjs          RelayPool, RelaySwarmSession, ticket validation (main export)
src/browser/hls-swarm.mjs      hls.js shadow-mode integration (./hls-swarm export)
src/browser/peer-link.mjs      browser WebRTC peer link
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
- The original WebRTC PoC signs but does not encrypt SDP; only the native
  spike's dial authorisation is NIP-44 encrypted. Do not describe the WebRTC
  path as encrypted.

## Key Files

| File | Purpose |
|------|---------|
| `poc.mjs` | Browser-path PoC entry point |
| `native-poc.mjs` | Native-path PoC entry point |
| `INTEGRATION.md` | Host-page contract, options and kill switch for `hls-swarm.mjs` |
| `docs/NATIVE-TRANSPORT.md` | Native path protocol and security boundary |
| `docs/THREAT-MODEL.md` | Threat model the deliverable engine is tested against |
| `spikes/RESULTS.md` | Full results for the feasibility spikes |

## Common Pitfalls

- `npm test` hits live public relays; a red run can mean relay weather, not
  a code fault. Re-run before concluding anything.
- There is no npm release yet: `INTEGRATION.md`'s example pins a git
  dependency at a commit rather than an npm version.
- Do not present the WebRTC signalling path as encrypted; only the native
  dial authorisation is.
