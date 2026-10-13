# RelaySwarm evidence and remaining work

[Documentation](README.md) · [Field-test guide](FIELD-TEST.md) ·
[Changelog](../CHANGELOG.md)

Checkpoint: 13 October 2026. The published experimental release is
[v0.1.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.1.0), which points to
`3e480e19dfe4d675f14bcb2968f3dc4926fbca25`. The 0.2.0 production feature
candidate remains on PR 8 pending final checks and release. Later documentation corrections
on `main` do not change that tag or its immutable downloaded assets.

## Published v0.1.0 capabilities

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

This section records v0.1.0's release checks; v0.2.0 broadcaster evidence
appears below.

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

The **0.2.0 source broadcaster candidate** includes the additions below.
These changes are absent from v0.1.0's immutable release assets. Release and
merged source do not establish production readiness.

## Current source acceptance on 13 October

The last verified public pilot upgrade used source
`219719843f3f7175725d16535749b303c8e34cc4`, whose nine required jobs passed in
[CI run 38420116433](https://github.com/forgesworn/relayswarm/actions/runs/38420116433).
Its client bundle SHA-256 is
`3e97b497acf0fc7ff6d79781e48a0d54d1ca7c70a05f9cf41585ec8d390c0ce9`.
The earlier source `a0231aadcdd81fe67fe702ac7214042d196eb39f` passed ten jobs,
including the optional two-hour soak, in
[CI run 38392804791](https://github.com/forgesworn/relayswarm/actions/runs/38392804791).
Each result applies to its tested source. Later control-request diagnostics and
private ICE-file configuration form a separate candidate requiring their own CI.
v0.2.0 release assets and fresh downloaded-consumer verification remain pending.

The a023 CI soak measured 7,200.366 s after its final arrival wave, with twelve
honest viewer roles, one corrupt peer and one origin-only baseline. Twenty-two
departures/rejoins replaced eight roles; it was not twelve uninterrupted
two-hour sessions. Final incarnations accepted 8,268,934,096 peer bytes, and
departed incarnations separately recorded 7,396,517,088. All twelve honest
roles banned the corrupt peer. Retained final/departed stall and fatal hls.js
counts were zero, and resource/loader cleanup passed. Native media errors were
not separately instrumented, so no independent zero-native-error claim follows.
This was a single-Chrome loopback fixture with fake microphone/permission flags,
an mDNS override and `host/host` candidates, not public-network acceptance.

The deployed a023 HTTPS/WSS four-context run completed 7,205.094 s but **failed
sustained contribution**. After policy timeouts around 13:24:57 UTC, both
contributors withdrew with allowance remaining. No automatic reconsent or
quota reset was applied. The receipt retains 34 of 2,932 sampled intervals
without decoded-frame progress, plus 23/20/45/15 stalls for low/high/baseline/
receive-only roles. Fatal hls.js errors, separately observed native media errors
and repair attempts stayed zero. The receive-only role accepted 572,731,284
peer bytes with zero uploads, including receiving from separately recorded
support actors after formal contribution stopped. The red result is not
reclassified as a sustained peer or production-capacity pass.

An installed Firefox 152.0.6 public journey with ordinary Chrome contributors
passed verified receiving/uploading, quality and seek, durable quota across
reload, fresh consent and origin-only kill. Its pre-reload checkpoint recorded
2,524,652 received peer bytes and 219,020 uploaded bytes. No fake media or
permission overrides were used. The corrected visible Safari 26.6.2 journey
played video without reported media errors but received zero verified peer
payload within 45 s despite five RTC links; its complete peer journey remains
red. The earlier Safari journey's peer bytes and later pause are retained
separately and do not close that gate.

Physical Pixel/Vanadium peer acceptance remains red. A separately authorised
temporary public-interface-only WebRTC policy test also missed its 45 s peer
gate; the original restrictive policy was restored and verified by 14:37:34 UTC.
All retained links in that diagnostic matched known non-serving formal roles,
not the ordinary serving support actors. Connections alone are not peer transfer
or proof that the device can reach every serving actor. The iPhone owner
confirmed moving origin video and an audible tone, then reported that playback
did not resume after backgrounding or an explicit Play action. Engine/error
diagnosis, complete peer/background journeys and automated native
input remain unproved.

The a023 host parent-crash observer closed green over 309.682 s. A guarded
main-process `SIGKILL` stopped the old container namespace. A complete scoped
writer/volume/descriptor audit established absence before explicit operator
recovery of the retained dirty marker while holding both permanent leases.
Publisher identity, client hash and both lease inodes were preserved. The same
origin-only page decoded low and high video/audio after continuity advanced
from 16 to 17; its final 15 s check advanced 475 frames. One 285 ms stall,
transient HTTP 502/503 responses and level-load errors remain recorded; fatal
and native media errors were zero. The observer/profile cleanup passed. This
proves the measured explicit recovery path, not automatic guardian clean-drain.

Scoped resource observations collected 111 exact-container/owned-Chrome samples
and 87 isolated HTTPS active-socket samples, with all readers stopped before
the run deadline. The main counter prefix missed 8m30s; closed/short socket
terminal bytes and browser counter resets leave further gaps. Sampled app raw
memory peaked at 308,580,352 bytes. The observed HTTPS acknowledged TCP counter
deltas sum to 4,509,684,301 bytes, covering all audiences and excluding complete
IP/link overhead. Internal bridge counters are not summed as Internet egress.
There is no matched origin-only network baseline or provider billing evidence:
total wire reduction and net cash saving remain unproved.

Later retained MPEG-TS segments reproduced a fatal hls.js AAC track-discovery
error: the first segment contained video without AAC, and the next introduced
audio after only a video SourceBuffer existed. The current one-shot repair
recovered through the alternate rendition in 603 ms, retaining the fatal error
and leaving uploading/reporting off. The constructed VOD clips differ from the
original failing live window; recovery in the low rendition alone and the cause
of the original missing segments remain unproved.

The diagnostics candidate passes 93 publisher tests with one opt-in skip and
serial Chrome operator/playback checks. Playback accepted 28 verified peer loads
(7,805,572 bytes), both renditions, with zero observed stalls, fatal/native errors
or uploads by the receiver. Those existing loopback fixtures use fake-media and
mDNS accommodations. A failed-TLS-startup regression also verifies timer and
private operational-lease cleanup. Local results do not inherit the deployed
source's CI or establish physical acceptance.

The first deployed 219 reporting attempt recorded trusted Start and reporting
opt-in, then timed out before a report response within 17 s. Root verified
reporting-off restoration and removal of its temporary source. Request lifecycle
and later checkbox/policy state were not retained, so no collector or transport
cause is inferred. A fresh diagnostic setup subsequently lost host connectivity
before a browser started; its remote outcome requires inspection when access
returns. The [investigation summary](../spikes/results/control-path-media-investigation-summary-20261013.json)
retains the media, local-candidate and reporting evidence separately.

The [current acceptance summary](../spikes/results/current-source-acceptance-summary-20261013.json)
names the receipts, source and scope. Historical MSE causation, sustained
contribution, complete Safari/physical-device journeys, varied/hard NAT,
resource/cost attribution and released-asset acceptance remain open. The
[P01–P12 checklist](PRODUCTION-READINESS.md) retains the full requested scope.


## Earlier production checkpoints on 13 October

The [feature guide](PRODUCTION-FEATURES.md) describes the implemented changes;
the [delivery checklist](PRODUCTION-READINESS.md) retains their full acceptance
scope. Local receipts record unmodified-playlist live peer delivery and actual
fMP4 automatic quality changes under network shaping. Alternate-audio,
authorised AES-128 and mixed HEVC/AVC journeys each have a passing current
receipt. Low-latency playback includes verified one-second parts before and
after warm delta playlists; the consumer received four peer parts (209,514
bytes) with zero uploads, stalls or fatal/native errors and 3.704 s live lag
against a 3 s target. These are desktop Chrome fixtures, not physical acceptance.

New integrated adversarial tests cover malformed remote filters, admission
and signed-presence churn, oversized frames, cancelled HTTP work, concurrent
commitments, relay withholding and stalled native-origin bodies. Forced
parent termination tests verify supervised worker groups are killed/reaped
before a new broadcaster owns publication. Guardian failure leaves a durable
fence for explicit recovery. The Windows cache race has a deterministic local
regression; actual Windows CI must still verify the final source.

The next native candidate passes 14 tests on both macOS and Linux. Its
separate-process CLI uses the unchanged five-second peer budget. The earlier
Linux failure traced to an isolated one-node DHT whose NAT analysis aborted
before the server received the object request. Four independent local
responders passed 20 consecutive diagnostic transfers; the fixture now
models that populated network. This does not require multiple bootstrap URLs
as a public-client policy or prove real-network NAT traversal. The
[native review summary](../spikes/results/native-readiness-summary-20261013.json)
also records cached-presence discovery, a shared open/ACK deadline and late
completion rejection. Final-source CI remains required.

A historical Swift adapter using unchanged Kit v2 components completed an
encrypted session and a verified 262,181-byte transfer. The subsequent authorised
upgrade is published as [RelaySwarmKit v0.5.0](https://github.com/forgesworn/relayswarm-kit/releases/tag/v0.5.0)
at `2f0b26a`, with PR/main CI green (39 tests, one opt-in skip) and all five
public assets checksum-verified. Its actual public SDK and the production
browser sender completed author/delegate transfers of 108,950 fMP4 bytes;
corruption, tampering and both pre-request/EOF revocation returned zero bytes.
That macOS arm64/Chrome loopback journey uses no wire adapter. The
[protocol draft](NIP-DRAFT.md) and [interop guide](interop/README.md) distinguish
the published SDK from the historical incompatible v2 baseline.

The player now retains fatal/native error records and permits one bounded
origin-only MSE repair per viewing session. Five real corrupt-fMP4 Chrome
journeys verify live/VOD recovery, repeated-error termination, cancellation
and a ten-second no-progress timeout. Recovery stops contribution and preserves
spent allowance; successful repair is recorded separately from the fatal error.
This impact treatment does not establish the historical hosted failure's cause.

All nine required [CI jobs at `4bffa96`](https://github.com/forgesworn/relayswarm/actions/runs/38375824009)
passed. That exact image runs on the public pilot; its browser bundle matches
the committed source. The old app stopped cleanly, and an encrypted private
state backup passed an isolated identity/token/generation and permission
restore check. An actual fifteen-minute four-context HTTPS/WSS diagnostic
received both peer qualities (145,183,188 bytes), with zero receiver upload
and zero fatal/native errors. All 372 sampled intervals advanced decoded
frames. Stalls and one explicit reconsent following a policy timeout remain
recorded. This is short, same-Mac synthetic-source evidence.

The subsequent host-callback correction aborts each expired operation's HTTP
request; real withholding tests show no outstanding request accumulation.
Native discovery also works with zero ephemeral-history replay: a separate
process verified 131,097 bytes. Both changes retain the existing deadlines,
authorisation and consent rules. All nine standard jobs passed at
[`8d5cae3`](https://github.com/forgesworn/relayswarm/actions/runs/38383249960),
and its exact image and committed browser bundle run on the public pilot.
The playback job required an unchanged-source rerun. A later dispatch repeated
the high-rendition miss: the fixture sought before that rendition's peer
opportunity completed. Bounded per-rendition checkpoints now precede the
intentional seek; the actual corrected test received 31 peer loads
(8,662,100 bytes), with zero stalls or fatal/native errors.
Separately, one native WAN retry accepted all bytes within 8,873 ms, while
another timed out before a UDP route/Noise handoff. That variability remains
open and is not explained by the ephemeral-history discovery correction.

The Pixel is connected again and initial origin playback started, but its
first acceptance run received no verified peer media. Firefox also missed
peer delivery in its first run. Safari automation is now enabled: omitting
its optional certificate capability returned `acceptInsecureCerts: false`,
and selecting its own automation window passed visible-tab readiness with
consent off. Complete device/browser journeys remain open. The authorised
private YouTube test reported excellent stream health; its owner watch page
decoded 428 more video frames and 232,756 more audio bytes over 14.268 s.
The stream ended, the archive was deleted and verified unavailable, forwarding
was disabled and both temporary credential copies were removed. The channel's
default stream key was unchanged. This proves synthetic-source external
platform acceptance, with no public broadcast or OBS workstation claim.

A separate installed OBS 32.1.2 test used only a generated video/audio scene,
the localhost-only SSH ingest forward and an isolated task configuration.
Over 92.7 s the public origin-only player decoded both qualities and audio,
with zero stalls, fatal/native errors or uploads. OBS closed and the temporary
configuration routes were restored. This is real OBS ingest acceptance; it
does not combine OBS and YouTube into one measured run or prove physical
audibility, screen/camera capture or peer delivery.

An actual same-volume `4bffa96` to `8d5cae3` upgrade, rollback and second
upgrade retained public identity, increasing sequences and both permanent
lease inodes after clean worker shutdown. The same origin-only page recovered
both qualities after the first two switches, but remained stalled after the
last despite fresh playlists and zero fatal/native errors. Read-only library
inspection and a real rolling-playlist control reproduced the obsolete
continuity selection. The correction shares the existing one-attempt repair
budget, revokes uploading and observes real decoded-frame progress. Treatment,
actual held-request cancellation and the ten-second deadline pass locally;
the new runtime still needs host acceptance. Old-source long runs were
cancelled and are not final sustained-operation evidence.

The [private-platform and live-restart summary](../spikes/results/youtube-live-restart-summary-20261013.json)
retains these outcomes. The earlier hosted H.264 MSE cause, varied NAT, hours
of audience/cost evidence and final release/deployment acceptance remain open.
Initial wider-media failures and later passes are retained;
corrected codec-fixture metadata and startup quality handling do not by
themselves establish the cause of the earlier hosted failure.

## Recorded broadcaster pilot evidence from 12 October

The table and receipts below describe that earlier checkpoint; newer source
changes and their acceptance are recorded above.

| Addition | Recorded local evidence | Remaining boundary at that checkpoint |
|---|---|---|
| Live ingest and forwarding | Synthetic H.264/AAC over actual local RTMP/RTSP, two HLS encodes, separate forward loss/recovery, untrusted RTMPS certificate rejection | Actual OBS workstation and external platform acceptance |
| Publisher persistence/cache | Private POSIX state, stable authorisation/swarm after orderly restart, deduplicated streamed hashes and bounded signatures | Windows ACL support; automatic recovery after unclean process termination |
| Viewer allowance/scheduler | Concurrent/interrupted payload reservations, cumulative page allowance, healthy-peer preference and measured deadline budget | Full page reload resets allowance; real-network cost and live-edge peer coverage |
| Operator controls/reports | Actual Chrome default report silence, explicit numeric reporting, remote off/on, viewer-off priority and policy outage recovery | Admission/Sybil resistance, persistent aggregated operations data |
| Trusted stream adapter | Signed latest-update selection, author/origin allowlists, host relay/ICE policy, query flood/timeout/abort bounds | Host query/resource lifecycle, redirects/assets, publisher trust and complete NIP-53 advertisements |
| Broadcast browser journey | Actual Chrome, both qualities, source reconnect, continuous visible sequence/CC and stable publisher identity | Synthetic loopback producer; receiving-viewer playlists wait for real peer availability advertisements |
| Container package | Non-root image build, pinned router/proxy manifests, private ingest, resource/log bounds, Compose configuration | Sustained host capacity, disaster recovery and independent audience acceptance |

An earlier local broadcast Chrome run, using a fixed 600 ms receiving-viewer
playlist delay, recorded five verified peer loads,
3,053,872 media payload bytes and zero consumer upload. All four players had
zero stalls/fatal errors; its receiving viewer made three media HTTP requests
versus ten for the baseline. Those counts exclude signalling, commitments and
wire overhead. A separate run at a synchronised live edge received no peer
media. An earlier concurrent fixture attempt reported MSE append failures
including on the origin-only baseline; its cause remains unresolved. The
later isolated success does not close that load/decoder gate.

The [current local broadcast receipt](../spikes/results/broadcast-browser-readiness-summary-20261012T143123Z.json)
records six verified peer loads (3,065,716 bytes), both qualities and peer
delivery after producer reconnection, zero consumer upload and zero fatal
errors across all four players. The consumer recorded one 799 ms restart
stall. The fixture now releases each unchanged playlist snapshot after its
last four segment keys arrive in real peer HAVE frames, with a 10 s bound;
all eleven availability checks succeeded. This controls segment availability
for the transfer regression. It does not establish synchronised live-edge
coverage, uninterrupted playback or net bandwidth savings.

Current checks include 53 swarm/discovery tests, 39 passing publisher/operator
tests with one Windows-only test skipped on macOS, 21 broadcast fixture/transport
tests, six native tests, Chrome operator/
playback/broadcast receipts and public-relay transfers. These are local checks;
the existing release CI links above cover the earlier release checkpoint.
Broadcaster feature checks are available on
[broadcaster pilot PR 8](https://github.com/forgesworn/relayswarm/pull/8).
The initial branch CI found a TLS test that incorrectly required GnuTLS to
reject a certificate before completing negotiation. The corrected test
measures zero RTMP application bytes plus prompt certificate failure; it
passes on actual macOS/OpenSSL and Linux/GnuTLS. A separate peer-first job
was cancelled during package installation before its browser test started.
A later branch run passed the Windows atomic-playlist regression using a
real in-place mutation when Windows denied rename with `EPERM`. Its sole
failure was the broadcast browser's low-rendition peer deadline: the consumer
requested fresh segments before either contributor held them. The fixed
600 ms playlist delay did not establish availability; the bounded HAVE
barrier above replaces that timing assumption.
[Branch CI run 38264629670](https://github.com/forgesworn/relayswarm/actions/runs/38264629670)
passed all eight required jobs for source `0d8ebd2`; the optional soak was
skipped. Its Linux broadcast receipt verifies both qualities and producer
reconnect, with zero consumer upload/fatal errors/stalls. Contributor stalls
during the source outage remain recorded in the
[final pilot summary](../spikes/results/broadcaster-pilot-final-summary-20261012T144924Z.json).

An external pilot is available at
[relayswarm.forgesworn.dev](https://relayswarm.forgesworn.dev) on the existing
Hetzner host Till. HTTPS uses a verified certificate; RTMP remains host-loopback
only and the test source arrived through SSH. The
[hosted summary](../spikes/results/hosted-pilot-summary-20261012T131905Z.json)
records four Mac Chrome contexts, both video qualities, actual HTTPS HLS/WSS
signalling, three verified peer loads (1,563,784 bytes), zero consumer uploads
and zero stalls/fatal errors. No playlist delay was needed for that success.
A preceding run lacked low-rendition peer payload within its deadline; peer
coverage remains variable. A later four-context run against source image
`30ffd2c` failed: both contributors and the origin-only baseline recorded
fatal MSE append errors, the receiving viewer stalled, and the 90 s watchdog
ended the journey. Those failures remain open. A subsequent instrumented
25 s origin-only probe recovered from a catalogue-refresh HTTP 503 without
a fatal error; a four-context probe had healthy readable samples before
all browser evaluation polls timed out during its final ten seconds.
Neither diagnostic probe closes the earlier failure. The observed atomic
playlist replacement race now has one bounded fresh-catalogue retry, with
deterministic mutation/signature regressions; that fix does not establish
the cause of the MSE failure. Raw origin request totals have staggered viewer
starts and do not establish matched-interval or net bandwidth savings.

The [final-image external check](../spikes/results/broadcaster-pilot-final-summary-20261012T144924Z.json)
ran once against deployed image `pilot-0d8ebd2` for 51.6 s including setup and
cleanup. Four independent contexts on one Mac Chrome host recorded both-quality
origin and verified peer playback, five peer loads (2,955,548 bytes), zero
consumer upload and zero stalls/fatal/native media errors. No playlist delay
or availability barrier was applied. Actual HTTPS/WSS and stable public
identity passed; the publisher matched the earlier pilot. This passing sample
does not explain or close the earlier hosted MSE failure.

A separate orderly app-container restart restored the same publisher,
authorisation, swarm and manifest in 5.4 s. No browser was connected during
that restart. Five encoding-only samples over 32 s recorded 30.15–30.29 fps,
1.01x speed, 74.46–90.78% of one CPU core and 122.4–123.6 MiB app memory.
These short measurements do not close sustained audience capacity, physical
devices, peer NAT diversity or external platform acceptance. The pilot displays
a waiting page until a source publishes. The synthetic acceptance source and
its SSH tunnel are stopped; the final image was restarted orderly to its
verified HTTPS waiting page. Its healthcheck remains unready until fresh media
arrives.

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
