# RelaySwarm through Spry TURN

24 October 2026.  This uses the actual browser loader and generated H.264/AAC
HLS, with ICE forced to `relay`.  It tests composition of the two projects,
separately from either project's protocol or performance tests.

The [current scalar receipt](spry-turn-20261024.json) identifies the released
Spry v0.2.1 executable and the RelaySwarm source hashes.  It retains failed gates.
No camera, microphone recording, production room or personal identity was used.

| Client-to-relay transport | Result | What was observed |
| --- | --- | --- |
| UDP | PASS | 34 in-time peer segments, 15,648,744 verified peer bytes and 81.0% in-time delivery. |
| TCP | FAIL | 10 in-time peer segments, 7,633,740 verified peer bytes and 27.0% in-time delivery, below the existing 50% gate. |
| TLS | FAIL | 14 in-time peer segments, 8,830,548 verified peer bytes and 37.8% in-time delivery. Also no active bidirectional selected path at the final sample. |

All three used distinct short-lived TURN principals per viewer, with Spry's
default per-user allocation limit of eight.  No ICE error codes were observed.
UDP and TCP had active relay/relay paths using the requested client transport
and bounded ports at the final sample. TLS recorded earlier relay/relay
connections and verified media, but no active selected path at that sample;
its final-path gate also failed. HTTP playback and tampering rejection passed.

All three runs completed the harness's resource cleanup checks.  The TLS
fixture uses an explicit self-signed-certificate bypass in Chrome, so it does
not establish public certificate validation.  Neither loopback success nor
continued HTTP playback establishes cross-network, NAT or physical-phone
acceptance.  The broad composition qualification remains RED.  The remaining
timing failure has not been isolated to either implementation.  Spry's separate
[standalone qualification](https://github.com/forgesworn/spry-turn/blob/v0.2.1/docs/qualification-0.2.1.md)
measures a different workload.

## Shared-credential fixture correction

The [earlier v0.2.0 receipt](spry-turn-20261023.json) remains as recorded.
That fixture incorrectly gave all viewers one TURN principal.  A v0.2.1 TCP
diagnostic reproduced the stalled connectivity and recorded twelve TURN 486
errors, `Allocation Quota Reached`.  Sharing a principal also shared its
eight-allocation limit.  Those earlier results do not isolate a Spry transport
defect and are superseded for composition qualification by the table above.

Giving each viewer its own principal removed the quota errors and restored
TCP media transfer without raising server limits.  TCP and TLS still miss the
unchanged delivery-time gate, and TLS also fails the final active-path check.  The raw private evidence also retains the first
v0.2.1 UDP attempt, which timed out without a completed browser receipt, and
the shared-credential TCP/TLS trials.  No failed trial was counted as a pass.

## Reproduce

Obtain the public [Spry source](https://github.com/forgesworn/spry-turn) and
reviewed executable from its [v0.2.1 release](https://github.com/forgesworn/spry-turn/releases/tag/v0.2.1).
Verify its archive with the release's `SHA256SUMS`.  The macOS ARM64 executable
is not a Linux or phone binary; build the reviewed source for another platform.
The runner uses Spry's independent fixture to start an explicitly selected
binary.  The recorded run freezes `tests/interop.py` from v0.2.0 and supplies
the exact v0.2.1 executable; both fixture and executable hashes are recorded.
It never starts a public relay or credential endpoint.

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
Each viewer receives only its own short-lived credential.  Credentials stay
in a mode-0600 temporary file and the matching browser context's memory.
Numeric ICE error codes are retained, without error URLs, addresses or SDP.
The fixture removes that file and stops its own server on failure as well as
success.  Its recording wrapper uses the loader's existing connection factory
around real browser peer connections; no synthetic transport substitutes for
WebRTC.

Next: isolate the remaining TCP/TLS timing failure and requalify, then test the
exact reviewed candidate on separate networks and physical devices.  Preserve
the independent peer-margin work in progress.  A functional browser smoke test
and standalone M4 throughput comparisons do not cover these composition gates.
