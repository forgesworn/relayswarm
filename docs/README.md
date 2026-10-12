# RelaySwarm documentation

RelaySwarm is an experimental peer-assisted HLS library and transfer proof of
concept. The released code is [v0.1.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.1.0);
this source documentation includes subsequent corrections and an unreleased
broadcaster pilot. The repository
and GitHub release are the public distribution surfaces; there is no hosted
RelaySwarm service or npm-registry publication.

| Task | Read |
|---|---|
| Understand the project and transport choices | [Project overview](../README.md) |
| Install the package, browser bundle or source demo | [Getting started](GETTING-STARTED.md) |
| Attach the loader, configure consent/admission, read metrics | [hls.js integration](../INTEGRATION.md) |
| Find module exports and publisher/session methods | [API reference](API.md) |
| Run a trial on separate devices and interpret receipts | [Publisher/player field test](FIELD-TEST.md) |
| Ingest a live broadcast or add optional RTMPS forwarding | [Broadcasting](BROADCASTING.md) |
| Operate private state, remote policy and opt-in reports | [Operations](OPERATIONS.md) |
| Deploy beside existing services with private ingest | [Container pilot](../deploy/README.md) |
| Understand HyperDHT/Noise and native authorisation | [Native transport](NATIVE-TRANSPORT.md) |
| Review integrity, privacy and resource boundaries | [Threat model](THREAT-MODEL.md) |
| Separate tested, released and outstanding capabilities | [Evidence and remaining work](STATUS.md) |
| Answer common questions and compare other projects | [FAQ](FAQ.md), [Landscape](LANDSCAPE.md) |
| Inspect dated measurements and reproduction commands | [Spike results](../spikes/RESULTS.md) |
| Follow release and documentation changes | [Changelog](../CHANGELOG.md) |
| Maintain AI entry points and check links | [Maintaining the docs](MAINTAINING-DOCS.md) |

For AI readers, start with the
[raw `llms.txt` index](https://raw.githubusercontent.com/forgesworn/relayswarm/main/llms.txt).
The [generated full context](https://raw.githubusercontent.com/forgesworn/relayswarm/main/llms-full.txt)
collects maintained guides with absolute links. Historical spike code and
receipts remain separate so a dated experiment is not mistaken for current
release behaviour. Local coding agents should read [AGENTS.md](../AGENTS.md).
