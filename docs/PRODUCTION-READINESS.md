# Production delivery requirements

This checklist tracks the production work requested on 13 October 2026. It
retains the full scope of the feature review. Implementation, automated tests,
publication, deployment and physical acceptance are separate requirements.
An entry remains open until the evidence described below exists.

The actual deployed application is `0e688470b6746b3a9afe80e1192ac4d46fa6aaea`,
with independent EE permanent HTTP/1.1 proxy provenance and all nine required jobs
green on their first attempt in
[CI run 38500343145](https://github.com/forgesworn/relayswarm/actions/runs/38500343145).
Fresh offline production-only consumption, ten documented exports, installed
independent-process native transfer/verified fallback and rebuilt standalone ESM
passed. Package/source/client hashes are recorded in [status](STATUS.md); local
candidate assets remain unpublished. This checkpoint binds actual 0e, not the
upcoming documentation revision.

The ordinary 60.013 s public check passed all three playback/contribution/verified-
peer gates with 19 loads/6,285,968 peer bytes across both qualities and zero
recorded stalls/fatal/native/page errors. The
[180.015 s renewal check](../spikes/results/0e68847-public-renewal-180-20261014.json)
passed all four declared gates with 90 peer loads/39,608,780 bytes (45 low loads/
9,488,548 bytes; 45 high/30,120,232). Each contributor retained one completed
pre-measurement stall (550/2,372 ms); no new stall occurred during measurement.
All 1,009 controls finished HTTP 200/H1 before cleanup. Passive sampled session,
peer-set/link counters, consent and monotonic quota held across successful own-
ticket renewal for all three peer actors; direct PC object identity is not proved.
Programmatic dropdowns/trusted Start and upload, one browser/four contexts and
host/host links bound this evidence. Setup/nonfatal media aborts remain retained.

The later cross-machine public HLS check was red for sharing over 60.060 s:
playback progressed without recorded stalls/fatal/native/page errors, but both
contributors uploaded zero and the receiver opened zero links/received zero peer
bytes after two dial timeouts. Its 323 controls ultimately finished HTTP 200/H1;
verification status alone does not prove admission. No ICE/transport cause is
established. Separate loopback-origin raw RTC exchanged 8,192 bytes each way
cross-machine but failed in both same-M4 topologies; this does not prove public-
origin HLS or a NAT class. A separate public-origin raw M1-offer → M4-answer
case passed in 7.972 s: both exact 0e public clients exchanged one verified
8,192-byte message each way, gathering completed and each SDP had one mDNS-form
and one IPv4-form candidate. Both apps remained unstarted with no media/admission/
upload consent, and all cleanup passed. M4 VPN remained connected in a read-only
03:14:35 UTC receipt; no settings changed or mDNS/VPN cause was proved. The HLS
sharing red remains separate. A separate reverse M4-offer → M1-answer raw case
passed in 7.566 s, again with one hash-matched 8,192-byte message each way,
complete gathering and one mDNS-form/one IPv4-form candidate per actual SDP.
Apps remained unstarted with no media/admission/upload consent; all cleanup
passed. Neither raw case proves the hosted HLS rendezvous/admission journey or
its failure cause; investigation continues. All owned completed-run browsers/readers/sources are closed; the
installed app awaits ingest. Fourteen-role/7,200-second/22-churn, complete
physical journeys, hard NAT, cost and immutable release/download gates remain open.

The earlier deployed application was `fa79c2260431cf7901921fab4eaca251c4988f4b`,
with independent EE proxy provenance and all nine jobs green in
[CI run 38496983011](https://github.com/forgesworn/relayswarm/actions/runs/38496983011).
The [fresh public short check](../spikes/results/fa79c22-permanent-public-short-20261014.json)
passed all three gates over 60.011 s with 13,206,248 verified peer bytes at both
qualities and zero recorded stalls/errors/withdrawals. All actors/source closed.
M4's zero-churn local check still hit the admission address cap and completed no
peer links; raw two-context RTC also failed. The later 0e renewal evidence is
recorded above; fourteen-role, sustained, device/network/cost and release gates
remain open; see [status](STATUS.md).

The preceding deployed checkpoint is `ee1510d429ac85f3738c03f10a09b753ec4eb037`,
with permanently committed HTTP/1.1 and all nine required jobs green in
[CI run 38492003110](https://github.com/forgesworn/relayswarm/actions/runs/38492003110)
after one failed-job retry. The [fresh ordinary short check](../spikes/results/ee1510d-permanent-public-short-20261014.json)
passed all three gates over 60.014 s with 13,188,200 verified peer bytes across
both qualities. The high contributor retained one 143 ms pre-measurement stall;
all owned actors/source were cleaned. A separate fourteen-viewer local check
stopped red after admission 429s blocked ticket renewal; the new heartbeat
optimisation still needs fresh cohort/deployment acceptance. Two-hour, physical,
varied-network, cost and release gates remain open. See [current status](STATUS.md).

The preceding deployed checkpoint was source `2e1bdeb724eb45e37f7b97604e4f396a73985719`. All nine required jobs passed in
[CI run 38483497575](https://github.com/forgesworn/relayswarm/actions/runs/38483497575);
the optional long soak was skipped. Fresh offline production-only consumption
passed ten documented imports, exact packaged demo/renewal/recovery bytes,
the installed CLI, separate-process verified native transfer and HTTP fallback.
The unpublished tarball contains 190 files, is 847,937 bytes and has
SHA-256 `21103ad4dc0701ed41d07f4393560053a480963995bbe4682bfda76bf4b0c0e1`.
The standalone ESM remains 114,201 bytes, SHA-256
`01de11837fbd08098bf98b6e8be945866ef766f76629030fec89de2318170d19`. Local artifacts do not prove downloaded-release acceptance.

The guarded app-only deployment passed the 51-file UID-1000 image preflight,
clean writer drain, stable identity/private lease/shared-service preservation
and normal-TLS exact-client/fresh-playlist attestation. Image is
`sha256:e73b4a0bb57ca37950abab2ae5c9f22c63a1ab4128880b9c85883d438701d87a`; public client is 728,315 bytes,
SHA-256 `c264287acad81090c8952f99946f75f844e8f5fa718e907899dc77cacf04ef59`. Reporting remained off.

The maintained no-store real-HTTP renewal regression passed, but the deployed
ordinary four-role Chrome 155.0.8059.40 check recorded red for contribution and
verified peers: 60.013 s of requested video/native-audio decode passed, with
zero fatal/native/page errors or stalls, while both contributors uploaded zero
and the receiver verified zero peer bytes. Authority-expiry timing is retained;
the underlying missing-response cause remains unproved.

A subsequent sequential comparison used Chrome 155.0.8059.41 and the same
finite source/client. Adding only `--disable-http2` passed all three short gates
in 60.009 s: the receive-only actor accepted 2,806,464 verified peer bytes at
both qualities, and both contributors retained consent/serving. Successful
fixed-route responses reported HTTP/1.1; the high contributor's one stall is
retained. A fresh default-browser check on the same source measured 60.015 s:
playback passed but both contributors withdrew, uploaded zero, and the receiver
verified zero peer bytes; successful requests used HTTP/2. These sequential
same-desktop checks isolate a useful transport diagnostic, not a proven HTTP/2
implementation cause or default production acceptance. No quota resets,
automatic reconsent, fake media or permission overrides were used.

Browser/provider cleanup passed in all three windows. The independently bounded
source remained Root-owned and separate from observer cleanup. Named evidence:
`artifacts/public-cdp-2e1bdeb-run-20261014`,
`artifacts/public-cdp-2e1bdeb-http1-diagnostic-r2-run-20261014` and
`artifacts/public-cdp-2e1bdeb-http1-window-default-run-20261014`.
The later temporary server-H1 trial used ordinary Chrome 155.0.8059.41 with
no browser transport override and unchanged app/client source. Its 60.009 s
measurement retained a partial red result: playback passed and both contributors
kept consent/serving, but only high delivered peer media (10,082,816 verified
bytes in 15 loads); low delivered zero. Contribution and both-quality peer gates
therefore failed. All 385 successfully completed fixed-route responses in the
four pre-cleanup CDP ledgers reported HTTP/1.1, with no ledger records dropped.
Fatal/native/page errors and sampled zero-frame intervals were zero; the high
contributor's one stall is retained. This short diagnostic does not establish
sustained benefit, a named HTTP/2 defect or permanent H1 readiness.

The first trial preparation failed before proxy mutation because the image's
file-capability binary could not execute with all capabilities dropped. That
setup red remains retained. The isolated r2 preflight passed after copying and
hash-verifying the same public binary bytes without capability attributes in
private tmpfs; non-root/no-network/no-shared-mount/cap-drop/NNP bounds stayed in
place. This setup correction is not a product or transport fix.

Browser/provider cleanup passed despite the overall red outcome. Explicit
controller finish and audit restored the original H1/H2 file and complete runtime
at the same inode, proved the watchdog absent, and separate source cleanup
removed the exact owned source (retained exit code 255). Named evidence is
`artifacts/public-cdp-server-h1-trial-r2-run-20261014`,
`artifacts/caddy-http1-trial-2e1bdeb-r2-preparation-20261014` and
`artifacts/public-proxy-http1-trial-source-2e1bdeb-r2-preparation-20261014`.
No permanent protocol change was made or authorised by this partial trial.

A subsequent r3 trial retained ordinary Chrome 155.0.8059.41 and the same
application/client, with only temporary server H1 and bounded read-only metrics.
All three gates passed in 60.010 s: the receive-only actor accepted 13,205,308
verified peer bytes in 30 loads, comprising 3,151,444 low and 10,053,864 high
bytes. Both contributors kept consent/serving throughout; fatal/native/page
errors, stalls, sampled zero-frame intervals and contribution withdrawals were
zero. All 407 successfully completed fixed-route CDP responses reported
HTTP/1.1. No browser transport override, quota reset or reconsent was used.

Browser/provider cleanup, controller finish/audit and exact source removal
passed. The original H1/H2 file/runtime and inode were restored and the watchdog
was absent. Evidence is retained under
`artifacts/public-cdp-server-h1-trial-metrics-r3-run-20261014`,
`artifacts/caddy-http1-trial-2e1bdeb-r3-preparation-20261014` and
`artifacts/public-proxy-http1-trial-source-2e1bdeb-r3-preparation-20261014`.
This one-minute ordinary-browser result supports selecting H1 as a deployment
mitigation; it does not establish a specific HTTP/2 implementation fault or
replace the r2 partial red. Permanent H1 has not been deployed: it still requires
a new clean commit, all nine exact-source CI jobs, guarded actual application
of the proxy change, and fresh default-browser short and full two-hour gates.
Decoded audio bytes do not prove audible output. Prior red outcomes, sustained
load, full physical/hard-NAT/cost gates, v0.2.0 publication and downloaded-release
acceptance remain open.

The earlier deployed checkpoint is source
`f9990b36956282f3d4e849b55bd64a79eb440151`, whose nine required jobs passed in
[CI run 38449139246](https://github.com/forgesworn/relayswarm/actions/runs/38449139246).
The earlier a023 two-hour load/churn run retains its separate source and scope.
The later proxy-only protocol correction passed pinned-binary validation and
a guarded live reload, while subsequent public contribution remained red.
The earlier candidate checkpoint
`cee92281b20aa5e60fc39d0e0cb2a368daa83747` passed all nine required jobs in
[CI run 38471147105](https://github.com/forgesworn/relayswarm/actions/runs/38471147105).
Its fresh offline production-only package/all ten documented imports, exact
packaged demo/recovery, installed CLI separate-process verified native transfer
and peer-absence origin fallback passed. The tarball is 823,201 bytes, SHA-256
`b847aa0d57f68975aa69bdc70589f1aa5066b757e748001ccb7bb967853a3d3a`;
the standalone ESM is 114,201 bytes, SHA-256
`01de11837fbd08098bf98b6e8be945866ef766f76629030fec89de2318170d19`.
These local artifacts are unpublished; the optional soak at this head was
skipped. Its runtime/dependency inputs were unchanged from f999/6b2, whose original
timed-fixture CI failure is retained separately. The passive f999 CDP
observation retained a 60.015 s playback pass with
contribution/peer failure and no proven transport cause; its owned-resource
cleanup passed, and it does not close sustained acceptance. The
[current acceptance summary](../spikes/results/current-source-acceptance-summary-20261013.json)
retains receipt identities and limits. v0.2.0 release and final downloaded-asset
acceptance remain pending; passing CI does not close the full checklist.
The [f999 public field summary](../spikes/results/f999-public-field-summary-20261013.json)
records the later short/partial-long, TCP relay and Android checks separately.

| ID | Requirement | Evidence required | Current state |
|---|---|---|---|
| P01 | Reliable live-edge peer delivery and adaptive quality | Unmodified live playlists, simultaneous viewers, quality changes and bounded fallback; paired origin baseline | Deployed 0e/independent EE permanent H1, ordinary 60.013 s all-three-gate and 180.015 s all-four-gate renewal checks pass; latter delivered 39,608,780 verified peer bytes across both qualities with pre-measurement stalls retained; later cross-machine 60.060 s playback passed but sharing failed; fourteen-role/two-hour stability and matched field benefit remain open |
| P02 | Resolve intermittent MSE playback failure | Reproduction or supported diagnosis, regression and repeated concurrent hosted playback without fatal media errors | Exact later-retained sparse-AAC bytes reproduce the low-only failure; recovery restored video/audio in 403 ms with the original fatal retained; f999 maintained regression, required CI and repeated short concurrent public playback pass without fatal/native errors; original missing bytes do not establish historical causation, and sustained contribution remains separately open |
| P03 | Wider HLS media support | Signed exact-context tests and actual playback for fMP4, alternate audio, supported encryption, parts/deltas and mixed variants | Current Chrome fixture and exact-source CI evidence pass; physical/browser coverage is recorded separately under P12 |
| P04 | Production admission and adversarial resource defence | Key-bound expiring tickets, revocation, bounded issuance and verification; flood/exhaustion/withholding regressions | Integrated adversarial/exact-source CI and 0e in-place own-ticket renewal pass with unchanged expiry, authority, admission and quota limits; all three peer actors retained sampled session/link/consent state across renewal; prior fourteen-viewer address-limit 429/authority-expiry reds remain unresolved operational capacity evidence under P12 |
| P05 | Durable operational measurements | Private persistence, cumulative-report deduplication, restart recovery, explicit reporting consent and bounded retention | Deployed 768 ordinary-Chrome trusted opt-in, real process restart, duplicate handling and natural five-minute expiry pass; reporting-off/policy/lease preservation and source cleanup pass; first deployed 219 timeout remains separately retained; backend component evidence does not replace new-client opt-in/reporting validation |
| P06 | Upload budgets across reloads and tabs | Atomic persistent reservations, failure handling and actual reload/multiple-tab tests; uploading still requires new consent | Chrome reload/tab and installed Firefox durable quota/fresh-consent evidence pass; complete physical upload journeys remain open |
| P07 | Safe broadcaster crash recovery | Concurrent-process exclusion, forced process termination/restart, stable identity, monotonically separate generations and private state | Same-head guarded parent crash, complete scoped writer audit, preserved lease inodes and explicit dirty-marker operator recovery pass; same page decoded both qualities at continuity 17 and cleanup passed; this is not automatic guardian clean-drain |
| P08 | Delegated signing and stream advertisements | Author-scoped expiring delegation, rejection/revocation tests, complete signed NIP-53 live/ended advertisements and host endpoint policy | Scope/revocation/discovery and exact-source CI evidence pass; caller-owned author trust/revocation freshness and operational advertisement policy remain explicit host responsibilities |
| P09 | Native application delivery | Installable executable entry point, independent-process native transfer, verified HTTP fallback and clean-consumer package test | Exact-0e offline production-only package, ten documented exports, rebuilt standalone ESM, installed CLI and independent-process verified native transfer/HTTP fallback pass; downloaded immutable release assets remain open; WAN success and timeout retain separate scope |
| P10 | Protocol compatibility | Maintained wire/commitment specification, conformance fixtures and successful independent-client journeys | Published Kit v0.5.0 and actual independent public-SDK/browser author/delegate/adversarial journeys pass, including exact-source CI; standards acceptance is not claimed and physical integration is recorded under P12 |
| P11 | Current release and production deployment | All required checks on the final source, immutable release assets/checksums, exact deployed revision, fresh media and rollback/restart verification | Actual deployed 0e passed all nine required CI jobs first attempt, fresh local consumer/rebuilt ESM, non-root image preflight, clean app drain and normal-TLS client/fresh playlists; EE permanent H1 provenance remains independent; 60.013 s short and 180.015 s renewal pass with full owned cleanup; local assets remain unpublished and downloaded-release/full production acceptance pending |
| P12 | Real-world acceptance | Physical Android/iPhone, Safari/Firefox, separate networks/hard NAT, hours of load/churn/cost measurements and authorised OBS/external-platform playback | Separate real OBS/private YouTube and installed Firefox journeys pass; 0e same-browser renewal passes but later cross-machine HLS sharing is red; raw loopback-origin cross-machine RTC pass is not public-HLS/physical/NAT proof; earlier two-hour contribution, Safari/Pixel peer and iPhone background reds remain; complete physical/native application/input, hard NAT, sustained churn and billed-cost gates remain open |

## Evidence rules

The existing pilot is a useful deployment starting point. A waiting page or a
running encoder does not prove media playback. Emulator and loopback receipts
do not prove physical-device or difficult-NAT behaviour. Peer media bytes are
not net wire-data or financial savings. A NIP draft and related codebase are
not proof of external standards acceptance or protocol interoperability.

Record the exact source, browser/device, topology, measurement window and
receipt path for each acceptance result. Preserve failing results until their
cause and regression are established. A completed duration can still fail its
acceptance gate. Connection counts do not establish accepted media payload.
Temporary-policy diagnostics do not establish default-device behaviour.
Update this table as evidence arrives; do not mark the overall work complete
while a required entry remains open.
