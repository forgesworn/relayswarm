# Production delivery requirements

This checklist tracks the production work requested on 13 October 2026. It
retains the full scope of the feature review. Implementation, automated tests,
publication, deployment and physical acceptance are separate requirements.
An entry remains open until the evidence described below exists.

The current deployed checkpoint is source
`bb90bd6a54cabc163846ee1737ac3fe28b63eaa2`, with all nine required jobs green in
[CI run 38478501111](https://github.com/forgesworn/relayswarm/actions/runs/38478501111).
Its production-only consumer, ten imports, installed separate-process native
transfer/fallback and standalone ESM pass locally; these artifacts remain
unpublished. Actual app-only deployment passed a 51-file non-root image
preflight, clean writer drain, stable identity/lease/service preservation and
normal-TLS exact-client/fresh-playlist attestation. Its ordinary public four-role
60.010 s check passed requested video/native-audio decode with zero fatal/native/
page errors, but both contributors uploaded zero and the receiver verified zero
peer bytes. The five-second authority-expiry boundary and delayed later sends
are retained; their underlying transport/cache/host cause is unproved. Browser,
provider and separately Root-owned source cleanup passed. Sustained public
sharing, final publication/downloaded assets and the full field scope remain open.

The later local real-HTTP comparison reproduced delayed identical-URL renewal
(default server arrival 5,002 ms versus no-store 2,001 ms), with the original
five-second timeout retained and consent preserved only in the treatment. A
three-call no-store correction passed final maintained real-HTTP policy/session
arrivals at 2,000/2,001 ms, outage expiry and recovery without consent restoration;
source hashes, eight existing operator checkpoints, publisher 117 pass/one skip
and syntax 105 passed. New committed-source and field gates remain pending. It does not explain the initial public missing
response or replace the deployed bb90 red.

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
| P01 | Reliable live-edge peer delivery and adaptive quality | Unmodified live playlists, simultaneous viewers, quality changes and bounded fallback; paired origin baseline | bb90 CI/deployment pass but its public contribution/peer gate is red; later no-store correction passes ordinary local real-HTTP renewal/expiry/recovery regression, with new committed-source/public gates pending; initial public missing-response cause unproved; prior two-hour reds, sustained delivery and matched field benefit remain open |
| P02 | Resolve intermittent MSE playback failure | Reproduction or supported diagnosis, regression and repeated concurrent hosted playback without fatal media errors | Exact later-retained sparse-AAC bytes reproduce the low-only failure; recovery restored video/audio in 403 ms with the original fatal retained; f999 maintained regression, required CI and repeated short concurrent public playback pass without fatal/native errors; original missing bytes do not establish historical causation, and sustained contribution remains separately open |
| P03 | Wider HLS media support | Signed exact-context tests and actual playback for fMP4, alternate audio, supported encryption, parts/deltas and mixed variants | Current Chrome fixture and exact-source CI evidence pass; physical/browser coverage is recorded separately under P12 |
| P04 | Production admission and adversarial resource defence | Key-bound expiring tickets, revocation, bounded issuance and verification; flood/exhaustion/withholding regressions | Integrated adversarial/Chrome and exact-source CI evidence pass within the documented threat/resource bounds; operational capacity is recorded under P12 |
| P05 | Durable operational measurements | Private persistence, cumulative-report deduplication, restart recovery, explicit reporting consent and bounded retention | Deployed 768 ordinary-Chrome trusted opt-in, real process restart, duplicate handling and natural five-minute expiry pass; reporting-off/policy/lease preservation and source cleanup pass; first deployed 219 timeout remains separately retained; backend component evidence does not replace new-client opt-in/reporting validation |
| P06 | Upload budgets across reloads and tabs | Atomic persistent reservations, failure handling and actual reload/multiple-tab tests; uploading still requires new consent | Chrome reload/tab and installed Firefox durable quota/fresh-consent evidence pass; complete physical upload journeys remain open |
| P07 | Safe broadcaster crash recovery | Concurrent-process exclusion, forced process termination/restart, stable identity, monotonically separate generations and private state | Same-head guarded parent crash, complete scoped writer audit, preserved lease inodes and explicit dirty-marker operator recovery pass; same page decoded both qualities at continuity 17 and cleanup passed; this is not automatic guardian clean-drain |
| P08 | Delegated signing and stream advertisements | Author-scoped expiring delegation, rejection/revocation tests, complete signed NIP-53 live/ended advertisements and host endpoint policy | Scope/revocation/discovery and exact-source CI evidence pass; caller-owned author trust/revocation freshness and operational advertisement policy remain explicit host responsibilities |
| P09 | Native application delivery | Installable executable entry point, independent-process native transfer, verified HTTP fallback and clean-consumer package test | Exact-bb90 offline production-only package/ten documented imports/standalone ESM/installed directory-alias ICE CLI/separate-process verified transfer and origin fallback pass; downloaded release assets remain open; WAN success and timeout retain their separate scope |
| P10 | Protocol compatibility | Maintained wire/commitment specification, conformance fixtures and successful independent-client journeys | Published Kit v0.5.0 and actual independent public-SDK/browser author/delegate/adversarial journeys pass, including exact-source CI; standards acceptance is not claimed and physical integration is recorded under P12 |
| P11 | Current release and production deployment | All required checks on the final source, immutable release assets/checksums, exact deployed revision, fresh media and rollback/restart verification | Deployed bb90 passed all nine required CI jobs, fresh local consumer/ESM, non-root runtime byte/entrypoint preflight, guarded app-only drain/replacement and normal-TLS exact client/fresh playlists; short playback passes but sharing remains red; earlier proxy/image rollback/reporting evidence retained; v0.2.0 immutable publication, downloaded consumers and full production acceptance remain pending |
| P12 | Real-world acceptance | Physical Android/iPhone, Safari/Firefox, separate networks/hard NAT, hours of load/churn/cost measurements and authorised OBS/external-platform playback | Separate real OBS and private YouTube video/audio/end/deletion pass; installed Firefox ordinary-actor journey passes; deployed two-hour contribution gate red, Safari/Pixel peer gates red, iPhone origin owner pass but background owner red; partial network/resource counters do not prove billing, varied/hard NAT or full device acceptance |

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
