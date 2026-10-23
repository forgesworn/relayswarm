# RelaySwarm through Spry TURN

23 October 2026.  This uses the actual browser loader and generated H.264/AAC
HLS, with ICE forced to `relay`.  It tests composition of the two projects,
separately from either project's protocol or performance tests.

The [scalar receipt](spry-turn-20261023.json) identifies the released Spry
v0.2.0 executable and the RelaySwarm source hashes.  It retains failed gates.
No camera, microphone recording, production room or personal identity was used.

| Client-to-relay transport | Result | What was observed |
| --- | --- | --- |
| UDP | PASS | 34 in-time peer segments, 16,478,764 verified peer bytes, relay/relay paths and tampering rejection. |
| TCP | FAIL | No honest in-time peer segments; peer connections stopped making progress.  HTTP playback continued. |
| TLS | FAIL | Relay/relay paths carried media, but only 8 of 38 settled races were in time, below the existing 50% gate.  HTTP playback continued. |

All three runs completed the harness's resource cleanup checks.  The TLS
fixture uses an explicit self-signed-certificate bypass in Chrome, so it does
not establish public certificate validation.  Neither loopback success nor
continued HTTP playback establishes cross-network, NAT or physical-phone
acceptance.  The broad qualification remains RED; these results do not make
Spry v0.2.0 a qualified replacement for another TURN deployment.

## Reproduce

Obtain the public [Spry source](https://github.com/forgesworn/spry-turn) and
reviewed executable from its [v0.2.0 release](https://github.com/forgesworn/spry-turn/releases/tag/v0.2.0).
Verify its archive with the release's `SHA256SUMS`.  The macOS ARM64 executable
is not a Linux or phone binary; build the reviewed source for another platform.
The runner uses Spry's independent fixture to start an explicitly selected
binary.  It never starts a public relay or credential endpoint.

```sh
npm ci
npm run test:spry-turn -- \
  --spry-repo /path/to/spry-turn \
  --spry-binary /path/to/reviewed/spry-turn \
  --transport udp --seconds 30 \
  --output artifacts/spry-udp-<run-id>
```

Repeat with `--transport tcp` and `tls`, each with a new output directory.
`all` stops at the first failed transport and returns non-zero.  An alternate
Chrome executable can be supplied with `--chrome`.  Logs and complete local
receipts remain under the selected ignored `artifacts/` directory, including
failed trials.  Publish only reviewed scalar fields, without credentials,
real endpoints, SDP, machine paths or media.

The harness requires in-time hash-verified HLS transfer, selected relay/relay
candidates, the requested relay protocol, bounded relay ports, bidirectional
traffic, tampering rejection, continuing playback and resource cleanup.
Short-lived credentials stay in a mode-0600 temporary file and browser memory.
The fixture removes that file and stops its own server on failure as well as
success.  Its recording wrapper uses the loader's existing connection factory
around real browser peer connections; no synthetic transport substitutes for
WebRTC.

Next: fix and requalify the TCP/TLS load behaviour, then test the exact reviewed
candidate on separate networks and physical devices.  A functional browser
smoke test and the M4 UDP throughput comparison do not cover those gates.
