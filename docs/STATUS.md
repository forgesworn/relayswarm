# RelaySwarm evidence and remaining work

[Documentation](README.md) · [Field-test guide](FIELD-TEST.md) ·
[Changelog](../CHANGELOG.md)

Checkpoint: 12 October 2026. Release
[v0.1.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.1.0) points to
`3e480e19dfe4d675f14bcb2968f3dc4926fbca25`. Later documentation corrections
on `main` do not change that tag or its immutable downloaded assets.

| Capability | Implementation and evidence | Remaining boundary |
|---|---|---|
| Original WebRTC CLI | Signed relay rendezvous, transfer and same-peer SHA-256 verification; public-relay tests | Plaintext SDP; no authenticated malicious-seeder defence |
| Browser shadow mode | hls.js keeps origin in the playback path; sampled verified peer measurements | Adds traffic; results are not origin savings |
| Browser peer-first | Author-signed exact-context commitments, bounded deadline, normal HTTP fallback | Limited scheduling; benefits differ by viewer |
| Publisher/player | Local playlist-bound signing, full segments/ranges/discontinuities, server-only key, explicit upload consent and local receipts | Limited HLS subset; no production hosting/admission service |
| Playback regression | Real Chrome, two renditions, seeks, timestamp reset, byte-range HTTP, relay reconnect and kill switch | Loopback desktop test, not physical-phone acceptance |
| Native HyperDHT | Local relay/DHT tests on Linux/macOS/Windows; Noise and one-use dial authorisation | No executable packaging, real-NAT acceptance or automatic HTTP fallback |
| GitHub distribution | Public installable tarball, standalone browser bundle and SHA-256 manifest; downloads verified | Prerelease, npm registry unpublished |
| AI documentation | Curated `llms.txt`, generated `llms-full.txt`, public Markdown and repository/package metadata | Publication does not establish crawler discovery, indexing or recommendations |

## Release verification

[Main CI run 38233694634](https://github.com/forgesworn/relayswarm/actions/runs/38233694634)
passed seven standard jobs: native suites on three operating systems, shadow and
peer-first Chrome harnesses, the publisher/player regression and live public-relay
transport tests. Local suites recorded 25 swarm/hardening tests, ten publisher/
HTTP/relay tests and six native tests. These counts describe that release checkpoint.

The recorded local [two-rendition playback receipt](../spikes/results/hls-playback-20261012T091818Z.json)
reports 27 peer-first fragments (7,290,640 bytes), zero stalls/fatal errors,
zero consumer uploading, verified delivery in both levels and across the
discontinuity, and restored origin loading after the kill switch.

[Hosted soak run 38231951028, attempt 2](https://github.com/forgesworn/relayswarm/actions/runs/38231951028/attempts/2)
tested twelve honest viewers, a tampering seeder and an origin-only baseline,
with three arrival waves and a 180 s final measurement window. Its
`hls-soak-receipts` artifact and [committed summary](../spikes/results/hls-soak-summary-20261012T100026Z.json) record:

- 923 of 1,343 fragment loads from verified peers (68.7%), 385,107,472 media bytes.
- Zero stalls/fatal errors for all twelve viewers and the baseline; zero swarm/page errors.
- Seven viewers banned the tampering peer. Two honest viewers used origin throughout.
- 571 samples: at most four connected/dialling peers, 5,091,228 held bytes and one relay.
- All stopped swarms released resources and restored the original loader.

The short soak used loopback `host/host` candidates and capped honest/baseline
forward buffering at 4 s (maximum 6 s). It is not evidence of hours of operation,
internet throughput or net data savings. Older [spike measurements](../spikes/RESULTS.md)
retain their own dates, topology, code and integrity assumptions.

## Outstanding gates

| Gate | Evidence needed |
|---|---|
| Physical Android/iPhone | Actual playback engine, consent, background/resume, battery and metered-data receipts |
| Separate networks and hard NAT | Paired baseline/swarm measurements, candidate types, origin fallback under failed peer reachability |
| Firefox and broader Safari coverage | Current loader journeys on actual browsers/devices |
| Sustained sessions and larger churn | Hours of resource/cost measurements with peer arrivals, departures and relay/network changes |
| Broader media/ABR | fMP4 playback, alternate media arrangements and evidence-led scheduling beyond the tested subset |
| Adversarial coverage | Larger Sybil floods, selective relay withholding and combined exhaustion cases |
| Independent implementation | Matching current wire envelopes, signed commitments and successful cross-client journeys |
| Protocol/release maturity | Accepted NIP, stable compatibility policy and production distribution/operations evidence |

Use [FIELD-TEST.md](FIELD-TEST.md) to collect receipts. A second related codebase,
successful local tests or a published prerelease does not close these gates.
