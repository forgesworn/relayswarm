# Production delivery requirements

This checklist tracks the production work requested on 13 October 2026. It
retains the full scope of the feature review. Implementation, automated tests,
publication, deployment and physical acceptance are separate requirements.
An entry remains open until the evidence described below exists.

The deployed checkpoint is source
`219719843f3f7175725d16535749b303c8e34cc4`, whose nine required jobs passed in
[CI run 38420116433](https://github.com/forgesworn/relayswarm/actions/runs/38420116433).
The earlier a023 two-hour load/churn run retains its separate source and scope.
Later control-request diagnostics and private ICE-file configuration form a new
candidate and require their own exact-source CI. The
[current acceptance summary](../spikes/results/current-source-acceptance-summary-20261013.json)
retains receipt identities and limits. v0.2.0 release and final downloaded-asset
acceptance remain pending; passing CI does not close the full checklist.

| ID | Requirement | Evidence required | Current state |
|---|---|---|---|
| P01 | Reliable live-edge peer delivery and adaptive quality | Unmodified live playlists, simultaneous viewers, quality changes and bounded fallback; paired origin baseline | Local Chrome and exact-source CI pass; deployed two-hour run completed red after policy timeouts withdrew contribution, so sustained peer delivery and matched field benefit remain open |
| P02 | Resolve intermittent MSE playback failure | Reproduction or supported diagnosis, regression and repeated concurrent hosted playback without fatal media errors | Exact later-retained sparse-AAC bytes reproduce the low-only failure; the next repair recovered video/audio in 403 ms with the original fatal retained and has a maintained regression; final CI and repeated updated hosted playback remain pending, and original missing bytes do not establish historical causation |
| P03 | Wider HLS media support | Signed exact-context tests and actual playback for fMP4, alternate audio, supported encryption, parts/deltas and mixed variants | Current Chrome fixture and exact-source CI evidence pass; physical/browser coverage is recorded separately under P12 |
| P04 | Production admission and adversarial resource defence | Key-bound expiring tickets, revocation, bounded issuance and verification; flood/exhaustion/withholding regressions | Integrated adversarial/Chrome and exact-source CI evidence pass within the documented threat/resource bounds; operational capacity is recorded under P12 |
| P05 | Durable operational measurements | Private persistence, cumulative-report deduplication, restart recovery, explicit reporting consent and bounded retention | Deployed 768 ordinary-Chrome trusted opt-in, real process restart, duplicate handling and natural five-minute expiry pass; reporting-off/policy/lease preservation and source cleanup pass; first deployed 219 timeout remains separately retained |
| P06 | Upload budgets across reloads and tabs | Atomic persistent reservations, failure handling and actual reload/multiple-tab tests; uploading still requires new consent | Chrome reload/tab and installed Firefox durable quota/fresh-consent evidence pass; complete physical upload journeys remain open |
| P07 | Safe broadcaster crash recovery | Concurrent-process exclusion, forced process termination/restart, stable identity, monotonically separate generations and private state | Same-head guarded parent crash, complete scoped writer audit, preserved lease inodes and explicit dirty-marker operator recovery pass; same page decoded both qualities at continuity 17 and cleanup passed; this is not automatic guardian clean-drain |
| P08 | Delegated signing and stream advertisements | Author-scoped expiring delegation, rejection/revocation tests, complete signed NIP-53 live/ended advertisements and host endpoint policy | Scope/revocation/discovery and exact-source CI evidence pass; caller-owned author trust/revocation freshness and operational advertisement policy remain explicit host responsibilities |
| P09 | Native application delivery | Installable executable entry point, independent-process native transfer, verified HTTP fallback and clean-consumer package test | Exact-768 production-only package/all exports/bundle/installed directory-alias ICE CLI/separate-process transfer/fallback pass; next candidate and final downloaded release assets require fresh verification; WAN success and timeout remain separately recorded |
| P10 | Protocol compatibility | Maintained wire/commitment specification, conformance fixtures and successful independent-client journeys | Published Kit v0.5.0 and actual independent public-SDK/browser author/delegate/adversarial journeys pass, including exact-source CI; standards acceptance is not claimed and physical integration is recorded under P12 |
| P11 | Current release and production deployment | All required checks on the final source, immutable release assets/checksums, exact deployed revision, fresh media and rollback/restart verification | Deployed 768 passed all nine required CI jobs, non-root runtime byte/entrypoint preflight, normal-TLS client/fresh-media checks and guarded reporting restarts; failed initial image and audited rollback retained; next recovery/image changes, v0.2.0 assets, fresh downloaded consumers and final release/deployment remain pending |
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
