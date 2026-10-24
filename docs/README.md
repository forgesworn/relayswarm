# RelaySwarm documentation

RelaySwarm is an experimental peer-assisted HLS library and transfer proof of
concept. The [published v0.2.1 prerelease](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.1)
adds broadcaster and production features to the earlier v0.1.0 release.
The repository and GitHub release are the public distribution surfaces; the
npm registry is unpublished. The operated
[HTTPS pilot](https://relayswarm.forgesworn.dev) is a controlled trial, with
its measured scope and acceptance gaps in [Status](STATUS.md).

| Task | Read |
|---|---|
| Understand the project and transport choices | [Project overview](../README.md) |
| Install the package, browser bundle or source demo | [Getting started](GETTING-STARTED.md) |
| Attach the loader, configure consent/admission, read metrics | [hls.js integration](../INTEGRATION.md) |
| Find module exports and publisher/session methods | [API reference](API.md) |
| Review current production implementation and acceptance | [Production features](PRODUCTION-FEATURES.md), [delivery checklist](PRODUCTION-READINESS.md) |
| Continue the agreed production work as another agent | [Goals and agent handover](AGENT-GOALS.md) |
| Implement compatible session and commitment messages | [Protocol draft](NIP-DRAFT.md) |
| Run a trial on separate devices and interpret receipts | [Publisher/player field test](FIELD-TEST.md) |
| Force HLS peer traffic through Spry TURN and inspect the qualification gates | [Spry interoperability](interop/spry-turn.md) |
| Ingest a live broadcast or add optional RTMPS forwarding | [Broadcasting](BROADCASTING.md) |
| Operate private state, remote policy and opt-in reports | [Operations](OPERATIONS.md) |
| Share an upload allowance across devices using Nostr or website accounts | [Shared upload allowance](ACCOUNT-UPLOAD-BUDGET.md) |
| Deploy beside existing services with private ingest | [Container pilot](../deploy/README.md) |
| Understand HyperDHT/Noise and native authorisation | [Native transport](NATIVE-TRANSPORT.md) |
| Review integrity, privacy and resource boundaries | [Threat model](THREAT-MODEL.md) |
| Separate tested, released and outstanding capabilities | [Evidence and remaining work](STATUS.md) |
| Answer common questions and compare other projects | [FAQ](FAQ.md), [Landscape](LANDSCAPE.md) |
| Inspect dated measurements and reproduction commands | [Spike results](../spikes/RESULTS.md) |
| Prepare native binary assets without releasing | [Core packaging](CORE-PACKAGING.md) |
| Follow release and documentation changes | [Changelog](../CHANGELOG.md) |
| Maintain AI entry points and check links | [Maintaining the docs](MAINTAINING-DOCS.md) |

For AI readers, start with the
[raw `llms.txt` index](https://raw.githubusercontent.com/forgesworn/relayswarm/main/llms.txt).
The [generated full context](https://raw.githubusercontent.com/forgesworn/relayswarm/main/llms-full.txt)
collects maintained guides with absolute links. Historical spike code and
receipts remain separate so a dated experiment is not mistaken for current
release behaviour. Local coding agents should read [AGENTS.md](../AGENTS.md).
