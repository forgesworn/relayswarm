# Production delivery requirements

This checklist tracks the production work requested on 13 October 2026. It
retains the full scope of the feature review. Implementation, automated tests,
publication, deployment and physical acceptance are separate requirements.
An entry remains open until the evidence described below exists.

## Current deployed pilot: 21 October 2026

Exact `140c256` (PR 9, unmerged) passed all nine required CI jobs, fresh
286-member consumption of the committed source, guarded deployment with
independent review, P05 reporting acceptance (natural expiry after 303,923 ms)
and P07 parent-crash recovery with an independent native review. The pilot app
is `38eb5c2d`, the served client is 787,462 bytes, and reporting and forwarding
remain off. The fourteen-role short qualifier R66 is GREEN, 16 of 16 gates,
the first green fourteen-role qualifier.

Two items are RED and open. The sustained 7,200 s run (Item 5) has not
completed: R37 and R38 failed on harness faults, and no product evidence came
from them either way. The P06 3 MB both-quality shared-cap lifecycle failed
again as in the a416f7e third run: three accepted 720p reservations were
charged but none completed as verified peer media over the relay path before
the fourth was refused as exhausted. It is a design limitation under relay
throughput, one high-quality holder and a 3 MB cap, with the allowance behaving
as documented. Desktop Firefox 152.0.6 and Safari 26.6.2 passed their journeys
(macOS arm64 desktop scope only); Safari 17.6 is RED with the cause not
determined. Physical devices, hard NAT, a separate network, marginal cost on the
hosts' plans and the release remain open. See
[current status](STATUS.md#current-delivery-checkpoint), the
[checkpoint record](../spikes/results/140c256-current-delivery-checkpoint-20261021.json)
and the [delivery checklist](#delivery-checklist).

## Previous deployed pilot: 19 October 2026

Exact `3f706a9` passed all nine required CI jobs, fresh 280-member consumption,
guarded HTTPS deployment and independent verification-source cleanup. The
browser client remains 773,458 bytes. Nostr accounts are enabled; the
authenticated host-supplied account API is implemented, with no website
resolver configured. Reporting and forwarding remain off.

P05 durable reporting acceptance now passes: trusted opt-in, duplicate
idempotence, same-volume restart persistence and natural expiry after
304.105 seconds. Reporting-off restoration and full browser/source cleanup
also passed independent review.

P07 crash acceptance remains RED. The latest test passed the parent-only
crash, strict writer audit, guarded marker recovery and server restart, while
preserving the original restart policy and permanent leases. The browser
exhausted its playlist retry budget on HTTP 502 responses before the server
returned; post-restart playback was not proved. An unchanged-source browser
regression also reproduces stopped playback after a 35-second HTTP 503 outage.
Browser and finite-source cleanup passed, and the acceptance window was not
extended. Retry and origin-only reconfiguration corrections are being verified;
see the [recovery checkpoint](../spikes/results/3f706a9-parent-crash-recovery-checkpoint-20261019.json).

The matching fourteen-viewer qualifier remains unproved, so the two-hour run
is still ineligible. Both-quality shared-budget lifecycle, device/network
coverage, matched benefit and final release remain open. Other work must
keep running and the original resource limits remain unchanged. See
[current status](STATUS.md#current-delivery-checkpoint), the
[checkpoint record](../spikes/results/3f706a9-current-delivery-checkpoint-20261019.json)
and the [delivery checklist](#delivery-checklist).

## Historical a02d5ec checkpoint

Exact `a02d5ec` passed all nine required CI jobs, fresh 278-member consumption,
guarded HTTPS deployment and independent verification-source cleanup.
Private state, permanent leases and the proxy were preserved. Nostr accounts
are enabled; the authenticated host-supplied API is implemented. Reporting and
forwarding remain off. The demo selects four neighbours; the SDK default is six.

R55 stopped during its sixth browser setup, with zero measurement. Independent
finite cleanup passed; the expected fourteen-viewer cohort was incomplete.
The earlier R54 both-quality peer failure remains RED, and the two-hour run
remains ineligible. M4 subsequently became unreachable from this Mac; other
work must keep running and the original resource limits remain unchanged.

A single-browser reporting retry remained RED after 85.580 s. The server
enabled reporting, but reused the same policy revision after changing its
startup telemetry setting. The browser refused that conflict and kept opt-in
disabled; no report request was sent. Reporting was restored to off, and full
browser and finite-source cleanup passed independent review. Restart durability,
natural report expiry and subsequent crash-recovery acceptance remain open.
The source revision correction passes focused operator and bundled-client
regressions; its CI, deployment and acceptance rerun remain pending.

P01–P12 source surfaces are implemented; production acceptance and release
remain incomplete. See [current status](STATUS.md#current-delivery-checkpoint),
the [checkpoint record](../spikes/results/a02d5ec-current-delivery-checkpoint-20261018.json)
and the [delivery checklist](#delivery-checklist).

## Historical 3515d5b checkpoint

Exact `3515d5b` passed all nine required CI jobs, fresh 277-member consumption,
guarded HTTPS deployment and independent verification-source cleanup.
Private state, permanent leases and the proxy were preserved. Nostr accounts
are enabled; the authenticated host-supplied API is implemented. Reporting and
forwarding remain off. The demo selects four neighbours; the SDK default is six.

R54 completed 303.647 seconds of measurement but remains RED. Fifteen gates
passed, including all fourteen viewers, eight contributors, both-quality
decode, consent, resources, renewal and admission. Only every receiver's
both-quality peer coverage failed: receiver 2 lacked measured LOW peer bytes;
receiver 3 lacked measured HIGH peer bytes. Provider observations recorded
zero refusals and a peak of 731 admission calls per aligned minute against
the selected 900-request address limit. Independent finite cleanup passed;
it does not change the failed qualification.

P01–P12 source surfaces are implemented. Matching short qualification,
two-hour/churn/natural expiry, both-quality account lifecycle, durable-report
and crash-recovery acceptance, browser/device/network breadth, matched
wire/cost benefit and final release/download checks remain open. Long
eligibility requires a matching successful short qualifier. Other work must
keep running; the original resource limits remain unchanged. See
[current status](STATUS.md#current-delivery-checkpoint) and the
[checkpoint record](../spikes/results/3515d5b-current-delivery-checkpoint-20261018.json).

## Historical c0f337d checkpoint

Exact `c0f337d` passed all nine required CI jobs, fresh 276-member consumption
and guarded HTTPS deployment. Private state, permanent leases and the
independent proxy were preserved. Nostr accounts are enabled, with an
implemented host-supplied authenticated account API; reporting and forwarding
remain off.

R52 stopped after 156.325 s on an unknown/future resource timestamp. A separate
controlled millisecond-domain regression and eight-check correction pass;
R52's exact failed clock values remain unknown. R53 used the corrected monitor
and stopped after 17.135 s on admission refusal. Twelve HTTP 429 responses and
the provider's 900-success/refusal/reset pattern support address-budget
exhaustion, without a retained server error body. Both runs passed independent
finite cleanup. Neither is a successful short qualifier.

The local replay-drop/callback-diagnostic candidate passes sixteen focused and
194 combined tests, including an original-source replay regression. Its effect
on field admission load remains unproved. It explicitly selects four demo
neighbours; the SDK default
remains six. The same fourteen-viewer/eight-contributor/both-quality gates and
original resource bounds remain required. This profile is not yet deployed
or field-qualified and does not establish six-neighbour capacity.

P01–P12 source surfaces are implemented. The successful matching short
qualifier, two-hour/churn/natural-expiry run, both-quality account lifecycle,
durable-report/crash-recovery acceptance, browser/device/network breadth,
matched wire/cost benefit and final release/download acceptance remain open.
The long run is ineligible until a matching short qualifier passes. Other
work on the Macs must keep running; resource limits remain unchanged. See
[current status](STATUS.md#current-delivery-checkpoint) and the
[checkpoint record](../spikes/results/c0f337d-current-delivery-checkpoint-20261018.json).

## Historical 44b21d6 checkpoint

Exact `44b21d6` passed all nine required CI jobs, fresh 273-member consumption
and guarded HTTPS deployment. Bounded rendition-neighbour discovery and
cold-peer deadline allocation are deployed, with the existing deadlines and
resource limits. The pilot selects 900 address requests per minute; the
default remains 600 and the global capacity 2,048. Private state, permanent
leases and the independent proxy were preserved. Deployment and finite-source
cleanup passed independent fresh reviews.

R30 remains RED after 36.188 s of measurement. All fourteen roles started, but
one contributor recorded an 82 ms origin-only interval before recovering.
The continuity requirement remains unchanged. A delayed session check and
subsequent renewal timings fit the interruption; exact request/clock joins
and the downstream cause remain unproved. All fourteen contexts and owned
processes, profiles, tunnels and source were closed and independently checked.

The defined P01–P12 source feature surfaces are implemented. Matching capacity,
7,200 s/22-churn, natural expiry, physical/browser breadth, difficult networks,
matched wire/cost benefit and final release/download acceptance remain open.
The long run requires a matching successful short qualifier first. v0.1.0
remains published and 0.2.0 the source candidate. See
[current status](STATUS.md#current-delivery-checkpoint) and the
[checkpoint record](../spikes/results/44b21d6-current-delivery-checkpoint-20261016.json).

## Historical afbf052 checkpoint

Exact `afbf052` passed all nine required CI jobs, fresh 271-member consumption
and guarded HTTPS deployment. The TURN cache correction is deployed with its
original limits; private state, permanent leases and the independent proxy
were preserved. Verification-source cleanup passed independent review.

R20 remains setup RED with zero measurement. All twelve intended peers had
available TURN and peer-first mode in their latest preflight snapshots, but
HTTP 429 admission refusals and delayed control bodies stopped qualification.
The unchanged counter replay reproduces the observed 37 refusals above the
shared 600-request window. Configurable operator request budgeting passes local checks; its default and the global limit remain unchanged. Idle control probes
were healthy, without reproducing loaded-browser delays. All R20 owned cleanup
passed; no previous acceptance verdict is changed.

The defined P01–P12 source feature surfaces are implemented. Matching capacity,
7,200 s/22-churn, natural expiry, physical/browser breadth, difficult networks,
matched wire/cost benefit and final release/download acceptance remain open.
v0.1.0 remains published and 0.2.0 the source candidate. See
[current status](STATUS.md#current-delivery-checkpoint) and the
[checkpoint record](../spikes/results/afbf052-current-delivery-checkpoint-20261016.json).

## Historical a416f7e checkpoint

Exact `a416f7e` is deployed: nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38775128822),
fresh 269-member consumption and normal HTTPS attestation pass. Private state,
permanent leases and the EE proxy were preserved; owned verification-source
cleanup passed all five guards with actual exit 255. Deployment is separate
from field, capacity and release acceptance.

Nostr plus an authenticated host-supplied resolver API is the selected account
scope; no named website or human wallet is required. The public cross-Mac API
trial passed its shared-cap/fencing checks. The focused LOW browser component
passed seven gates in 74.412 s, including verified low media, real reservations,
reload/new-key/spend retention, reconnect with upload off, fresh consent,
serving-state Disconnect and LAST 10 MB Settings without fixture resume.
The original both-quality/exhaustion trial remains RED with no high verified
completion; the component does not replace it.

Native iOS 26.5 Simulator Start/Home/return/Resume passed clock/pixels/frame59/61,
zero media/page errors, consents off and cleanup. Return was still playing, so
the physical stopped-video fault remains unreproduced. Original 4+10 R10 cap33
RED remains; new 3+11 R12 measured 97.691 s before runtime admission refusal,
with healthy resource/reader gates and all cleanup. Cause remains unknown;
the remembered-admission source correction passed 12 focused regressions and
137 swarm tests after the original-source regression RED. New CI/deployment and
field repair remain unproved.
No matching 300 s/7,200 s/22-churn, natural expiry, physical or matched-cost acceptance
exists. See [current status](STATUS.md#current-delivery-checkpoint) and the
[checkpoint record](../spikes/results/a416f7e-current-delivery-checkpoint-20261015.json).
The full P01–P12/37-review scope and final release remain open.

## Historical 5334091 checkpoint

The pilot at this checkpoint was exact `5334091`, with all nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38741613596),
267-member fresh consumption and guarded deployment passing. The ordinary
public check passed playback, contribution and low/high verified peer delivery
over 60.034 s: two fragments/868,936 bytes, 5.8896% of receiver media payload.
This does not establish sustained reliability, matched wire savings or cost.
The separate forced-early Internet TURN check passed 90.043 s; natural expiry
remains unproved. Reporting/forwarding and website authentication remain off.

The latest fourteen-role attempt stopped at 33 observed processes against the
unchanged 32-process M1 cap, before any measurement window. Endpoint/profile
cleanup was recovered separately after the original M4 receipt-read failure;
browser-context closure remains unknown. No 300 s qualifier or two-hour/churn
acceptance exists. The cross-Mac account test identified a valid challenge
rejected over a 16 ms clock difference; issuer-lifetime and explicit playback
recovery corrections are in the unreleased source, pending field acceptance.
See the [checkpoint record](../spikes/results/5334091-public-and-account-checkpoint-20261015.json)
and [current status](STATUS.md#current-delivery-checkpoint). The full P01–P12
scope remains open; v0.1.0 is the published prerelease.

## Historical 3e52294 checkpoint

Exact `3e52294` passed all nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38701249959),
fresh 262-member package/standalone consumption and guarded pilot deployment.
Normal HTTPS matched the 757,269-byte client to the image and read both fresh
playlists. The pilot now uses relay-only ICE, TLS/TCP TURN projection and
admission limit 32, with Nostr account allowances and no configured website
resolver. Private state, permanent leases, identity and the independent EE
proxy were preserved. Reporting/forwarding remain off. Owned verification-source
cleanup passed all five guards and retained actual exit 255; capacity is unproved.

A separate rebuilt diagnostic candidate passed the 90.031 s Internet TURN
renewal cohort with 40 verified fragments/4,631,756 bytes, including 23 fragments
and 2,656,252 bytes after the renewed transport boundary. Independent unchanged strict state machine
replay also passes that same cohort. Two local Chrome pages and synthetic
HLS/local rendezvous used genuine Internet TURN; the first local lease was
60 s against real 3,600 s credentials. This is not deployed public playback,
exact-standalone Internet qualification, natural expiry or a product-fix claim.
Earlier Internet and ordinary public REDs remain RED.

The latest ordinary public journey measured **60.038 s**: playback and
contribution passed, but the receiver verified zero peer fragments/bytes at
either quality. Seven requests reached matching metadata and partial payload
without EOF before closure. Four-player media errors/stalls were zero and all
owned cleanup passed. The [result summary](../spikes/results/3e52294-ordinary-public-20261015.json)
retains the unchanged gates, resource limits and unresolved delivery cause.
See [current status](STATUS.md#current-delivery-checkpoint) for exact image,
client and retained deployment/Internet/cleanup provenance.

The complete P01–P12 and 37-review-item scope remains open: ordinary public
peer delivery, complete Safari/physical and hard-NAT journeys, host website
resolver integration, natural expiry/reconnection and cross-device budget
field evidence, fourteen-role capacity, 7,200 s/22 churn, matched wire/cost and
immutable release/download acceptance. A separate completed 37-row ledger is
not claimed. v0.1.0 remains the published release; 0.2.0 is a source candidate.

The remaining checkpoint sections before the delivery checklist are historical.
Their deployment and pending-work statements belong to their named source/date;
they do not override the current 44b21d6 summary or reclassify retained REDs.

## Historical complete-playlist blocking reload candidate

The example origin now supports bounded blocking reload for compatible complete
live playlists, consistently across all renditions. The [API contract](API.md#example-origin-http-playlists)
keeps raw media, peer deadlines, origin reserve and playback holdback unchanged.
Independent review addressed shared directory-watch replacement/rearm races,
observed-change reauthorisation and response-slot retention until transmission
finishes. All 49 focused tests pass, including five actual loopback HTTP cases;
worker reaping and group/birth absence passed. This focused guard has no resource
sampler. The [source-check summary](../spikes/results/blocking-playlist-reload-source-checks-20261014.json)
records exact file hashes and scope.

Exact `dd953eeffb36f16674b8afaa01d29cbe2a7f0deb` then passed one fully serial
[paired browser journey](../spikes/results/blocking-playlist-reload-paired-browser-20261014.json)
with blocking reload enabled and disabled. Both passed low/high peer delivery
and producer-restart sharing under the original guards. Candidate: six verified
loads/3,245,444 bytes in 29.285 s; control: six loads/3,079,252 bytes in 28.715 s.
The candidate served 17 blocked reloads, with no blocked requests or watchers
left after actual server close. All seven worker and six supervisor cleanup
flags passed; the original resource bounds held.

Each donor stalled once in both runs; baseline/consumer had no stalls and all
fatal/native errors were zero. Candidate players each recovered from one HTTP
503 playlist error during restart; control players had none. Its cause remains
unproved and is retained as a transient restart risk. This single injected,
headless loopback pair does not establish a reliability improvement, causality,
ordinary public/physical acceptance or sustained benefit. Required hosted CI
and the remaining field gates are separate from these local results.

The preceding exact `fc39e32` check passed eight of nine required jobs in
[CI 38640084885](https://github.com/forgesworn/relayswarm/actions/runs/38640084885).
The broadcast failed initial low-quality peer delivery, before high-quality or
restart checkpoints. Healthy connections and late donor availability did not
establish a runtime fault or a polling cause. That failure remains separate
from the older all-green 7a check below; this capability is not yet a proved fix.
Release, deployment and the remaining field gates stay open.

## Earlier source checkpoint: 7a

Exact `7a5de06a97baf14c00e3a420944b75a730042c85` passed all nine required
jobs on attempt 1 of
[CI 38625083620](https://github.com/forgesworn/relayswarm/actions/runs/38625083620);
optional soak skipped. The injected loopback broadcast passed both qualities
and restart sharing: six verified loads/3,240,180 bytes, including one high
CC1 fragment/791,856 bytes with 1,291.1 ms deadline spare. One stall per donor
and the absence of full broadcast API/OS cleanup proof remain explicit. The
optional credential adapter was off; this PASS does not repair or relabel da9 RED.

Fresh exact-7a offline production-only package/consumer/ESM passes cover 239
exact-source members, eleven imports, installed CLI, sequential ledger replay
and independent-process verified native/fallback. Assets remain unpublished;
earlier smoke failures and source histories are retained.

Mock-issuer browser renewal passes separately. Actual existing-service
forced-renewal R3/R4 remain RED: R3 lacks the failed sample; R4 records three
constructor refusals under the original two-lifetime-PC cap after initial
glare. Refresh 2/new 3,600 s credentials were accepted with consent/spend
retained, but no post-renewal transport/media or strictly selected positive
TLS sample was proved. Owned client/fixture cleanup passed; shared allocation
absence was not inspected. No runtime-failure or server-quota cause is inferred.

The separate M4 Safari 26.6.2 tooling check returned driver ready, then timed
out creating a session before any page/application test. Owned driver, wire
workers and scratch cleanup passed; exact session destruction remains unknown.
The M4 resource observation was before the blocked request, not continuous.

The [7a summary](../spikes/results/7a5de06-ci-consumer-and-renewal-checkpoint-20261014.json)
retains exact hashes and scope. Last-attested pilot 8f is unchanged; ordinary
sharing, complete Safari/physical, sustained/churn, expiry/reconnection,
wire/cost, immutable release/download and full P01–P12 acceptance remain open.

Earlier source `a2c99a9` passed eight of nine required CI jobs; its loopback
broadcast test recovered playback after producer restart but failed the
unchanged new-discontinuity peer-fragment gate. The
[retained failure](../spikes/results/a2c99a9-ci-restart-failure-20261014.json)
and [current observations](STATUS.md#earlier-source-checks-restart-sharing-failures)
are separate from the deployed checkpoint below. No playback-latency or
deadline change has been made to increase sharing.
The instrumented `d283071` run also failed the unchanged sharing gate. Native
request timings confirm matched donor requests started after receiver completion;
the [summary](../spikes/results/d283071-ci-observations-20261014.json) separates
that result from its macOS cancellation-test precondition correction.

## Cached TURN credential correction

The follow-up client preserves its original lease when the credential endpoint
returns the same cached material. It does not rebuild peers or increment the
refresh counter, and uses the existing bounded retry. One deterministic da9
reproduction is retained; the corrected eleven lifecycle and four page-VM
cases pass with worker/group/birth absence. The focused guard has no resource
sampler. Exact-7a CI/package and separate RED Internet-renewal attempts are
recorded above; the [correction summary](../spikes/results/turn-cached-lease-fix-20261014.json)
does not replace the source-bound da9 evidence below or close field acceptance.

## Optional TURN renewal candidate

Exact `da9ac9202fd8794a68d6d707a1ab5d8109bbbb34` completed
[CI 38620173084](https://github.com/forgesworn/relayswarm/actions/runs/38620173084)
with eight required PASS/media FAIL; optional soak skipped. The unchanged
post-restart peer gate remains RED despite recovered origin playback. All 31
consumer discontinuity-1 decisions had zero peer budget: 1,159–1,202 ms playable
ahead versus the unchanged 2,000 ms reserve. Donors were ahead in the retained
object timings; this does not establish a correctness repair or justify a
playback-policy change. One stall per donor is retained; broadcast recorder
cleanup does not prove actor/API or OS reaping.

The off-by-default [credential adapter](FIELD-TEST.md#optional-turn-credential-renewal)
has eleven server/owned-HTTP, ten lifecycle and four page-VM passes. Separate
real Chrome mock-issuer rollover fixtures pass locally (47.010 s) and in CI
(50.433 s), preserving consent/spend and verifying new-swarm peer payload,
link/restart/reset and scoped cleanup. They use 15 s fake credentials and
loopback host WebRTC, not an actual TURN relay. Existing-service Internet renewal
was pending at da9; the later exact-7a
RED attempts appear above. Sustained expiry/reconnection remains unproved.

Exact-da9 fresh offline production-only consumption passes all 237 package
members, eleven documented imports, installed CLI, sequential durable ledger
replay, independent-process native/fallback and rebuilt ESM. The first smoke
failure remains separate; corrected R2 passes do not rewrite it. Assets remain
unpublished. The pilot is still 8f, v0.1.0 remains published, and all P01–P12
acceptance remains open. See the
[da9 summary](../spikes/results/da9ac92-ci-and-consumer-checkpoint-20261014.json)
for exact assets, CI and scope limits.

## Earlier completed CI source checks: 07

Exact `07ea96becce44fec6baa0b41f7719e0e99ee4031` passed all nine required jobs
on attempt 1 of
[CI 38616043417](https://github.com/forgesworn/relayswarm/actions/runs/38616043417);
the optional soak was skipped. The broadcast diagnostic passed four checkpoints
with six verified loads/3,125,876 bytes. All 239 observation rows and four final
extractions were retained without drops/unknowns/unlabelled objects. Each donor
recorded one stall; baseline/consumer recorded none, with zero fatal/native/append
failures. Declared injected/headless loopback fixture scope applies, and the raw
receipt does not prove full actor/API or OS cleanup.

The earlier abb Windows failure and 426 media failure remain. Fresh package
proof belongs to 426; fresh 07 package/consumer/ESM has not run. The pilot remains
8f and published release v0.1.0; all P01–P12/release acceptance stays open. Exact
07 retains the static TURN lifecycle gap below; its CI does not qualify the
later optional renewal candidate. See the
[07 summary](../spikes/results/07ea96b-ci-checkpoint-20261014.json).

## Earlier source checks: 426

[Exact 426 CI](https://github.com/forgesworn/relayswarm/actions/runs/38607468217)
finished with eight required jobs passing and the media job RED at its 30 s
first low-quality peer-load gate. Fresh production-only package/ESM, eleven
imports, durable ledger replay and installed native/fallback checks pass at
that exact source. Later candidates maintain bounded queued/accepted HAVE
test observations; their separate results above make no playback repair claim.

A separate injected Mac diagnostic passed in 33.759 s: six total peer loads/
3,107,076 bytes, with only the last high object observed after restart and
366.123 ms deadline spare. Its Chrome/platform/injection differ from failed CI.
One existing shared-service TLS-relay check passed 90.005 s measured/105.150 s
whole, with 34 complete verified peer fragments/3,956,272 receiver bytes.
Both pages had positive selected TLS pairs in 67/91 samples, constructed four
PCs in total, and had no active PC in the final seven samples. Video/time
continued; this is not continuous TLS, both-quality, physical, hard-NAT, server
quota or matched-cost acceptance. Client cleanup and separate issued-credential
removal passed; the shared service and network rules were unchanged. See
[status](STATUS.md#earlier-source-checkpoint-426-on-14-october-2026) and the
[scope summary](../spikes/results/42608f7-source-and-tls-checkpoint-20261014.json).
Static ICE configuration has no supported credential renewal: the observed
3,600 s issuer TTL does not prove fresh allocations/reconnections throughout the
7,200 s goal. Existing-allocation behaviour at expiry is unproved; the short TLS
pass does not close this lifecycle gate.

The deployed pilot remains 8f; all P01–P12 and release gates remain open.

<a id="current-deployed-checkpoint-8f"></a>

## Historical deployed checkpoint: 8f

The deployed application is `8f482b4528a671acfe9f1afc336cce5743aaaefd`. All nine
required jobs passed on attempt 1 of
[CI run 38578315372](https://github.com/forgesworn/relayswarm/actions/runs/38578315372);
the optional soak was skipped. Fresh production-only package/standalone proofs
and guarded deployment passed, preserving private state and the independent
EE HTTP/1.1 proxy. The pilot offers Nostr; a host supplies its website resolver.
Exact assets and receipts are in [status](STATUS.md#historical-deployed-checkpoint-8f-on-14-october-2026)
and the [8f summary](../spikes/results/8f482b4-current-checkpoint-20261014.json).

The ordinary 60.119 s cross-Mac check passed playback but failed contribution
and both-quality peer payload, with zero peer channels/bytes. Six dials reached
remote SDP installation and ICE checking before timeout. The 120 populated
whole-journey budget geometries matched the existing formula. Original cleanup
failures, later exact absence/removal and successful source cleanup remain
separate. A further interpreter capture refused before workload because its
remote clock was 68 ms ahead; no clock or freshness limit changed.

The temporary SSH TURN fixture was removed after its scoped test. Fresh Till
metadata found no known running TURN service on that host while the image
remains cached. The later existing shared-service TLS check above is separate;
hard-NAT, provider-policy and full field acceptance remain open.
No current same-topology 300 s qualifier, two-hour/churn, complete physical/Safari,
hard-NAT, matched wire/cost or immutable-release/download pass exists. Full
P01–P12 remains open, PR 8 is open and v0.1.0 remains published. Documentation
updates do not change the deployed application source. No separate 37-row
ledger was located and no 37-item completion is asserted.

## Previous deployed checkpoint: df51

The deployed application is `df51cbed1ebb3bd09ef1b521c451d6b47989a664`. All nine
required jobs passed on attempt 1 of
[CI run 38554223220](https://github.com/forgesworn/relayswarm/actions/runs/38554223220);
the optional soak was skipped. Fresh production-only package/standalone checks
and guarded pilot deployment passed. Both shared account methods are implemented;
the pilot offers Nostr sign-in, while integrating websites supply their own
authenticated account resolver. Private state and the independent EE H1 proxy
were preserved. Exact assets and evidence are in [status](STATUS.md#previous-deployed-checkpoint-df51-on-14-october-2026)
and the [df51 summary](../spikes/results/df51cbe-current-checkpoint-20261014.json).

The ordinary 60.110 s check passed playback but failed contribution and
both-quality peer payload: no channel opened and verified peer bytes were zero.
A separate 60.027 s heap/native-stats diagnostic observed positive ICE check
request counters and zero replies in retained snapshots. It narrows the failure
stage, without proving its cause or ordinary qualification. Original M4 cleanup
failure/unknown, later exact absence/removal and successful source cleanup are
kept separate. No production connectivity fix is established.

The full P01–P12 checklist remains open. No current same-topology 300 s qualifier,
two-hour/churn, complete physical/Safari, hard-NAT, matched wire/cost or release
pass exists. Earlier references to 37 review items have no separately located
row-by-row ledger; no 37-item completion is asserted. PR 8 remains open and
v0.1.0 remains the published RelaySwarm release.

## Previous deployed checkpoint: 2dd

The deployed application checkpoint is `2dd156e64f86e6f18b616e7d87159aee1c43eac2`. All nine required
jobs passed on attempt 1 of [CI run 38525990386](https://github.com/forgesworn/relayswarm/actions/runs/38525990386).
The optional CI soak was skipped; it is not a new sustained pass. The normal-TLS public client
is 734,604 bytes, SHA-256
`34259c97f1317c3ae4668c2634df6d57287ca8a40b4c8a249088c0400f3c1a61`; the image is
`sha256:200807d127f0e8cac781b1d9bd36ddfb0541285cc3eae2db96590d5410dc189c`. Guarded deployment preserved publisher identity and private
state. The permanent HTTP/1.1 proxy retains independent EE provenance; a later
documentation commit does not change the recorded application source.

The ordinary four-role public check remains **RED** over 60.049 s: playback
passed, but contribution and both-quality verified payload failed. The receiver
accepted 15 low-quality loads/3,169,304 bytes and no high-quality peer payload;
both contributors retained consent/serving, while the high donor uploaded zero.
All 358 fixed-route controls finished HTTP 200/H1; HTTP 200 does not prove
an admitted response body. There were no new measured stalls, fatal/native/page errors
or zero-frame intervals. The high donor's earlier 1,247 ms stall remains recorded.
Actor/provider/controller/outer and actual source-cleanup-v2 proofs passed;
source exit 255 is retained. No connectivity cause or fix was established.

The fourteen-role R7/R9/R10/R11 attempts remain RED: respectively an unknown
resource-probe timeout, process-limit failures under their original declared
limits, and zero-peer readiness before measurement. Safari 17 R2/R4/R5 remain
bootstrap-only; physical iPhone USB R2 produced no page evaluation and unknown
lockdown closure. Original cleanup failures and later exact-ownership recovery
are recorded separately. No new long, physical, hard-NAT or cost pass exists.
See [current 2dd evidence summary](../spikes/results/2dd156e-current-checkpoint-20261014.json) and [status](STATUS.md) for exact assets, counters and boundaries.
The full P01–P12 and 37-item scope remains open.

## Previous f393 checkpoint

The previous deployed application checkpoint was `f393abf3d55215bdf58241a4a2af74245d646117`.
All nine required jobs passed on their first attempt in
[CI run 38511479806](https://github.com/forgesworn/relayswarm/actions/runs/38511479806).
The optional twelve-viewer CI soak was skipped, not a new sustained pass.
The permanent HTTP/1.1 proxy retains independent EE provenance. The normal-TLS
served client is 734,441 bytes, SHA-256
`4fdb2861b08f42e4c82788a5940e0b2b436be52af84bc264998d41cf81938fcb`.
Fresh production-only package and standalone ESM checks passed; exact image,
package and source hashes are recorded in [status](STATUS.md). These local assets
remain unpublished and do not prove downloaded-release acceptance.

[Both ordinary cross-machine short checks](../spikes/results/f393abf-ordinary-cross-machine-20261014.json)
passed playback, contribution and both-quality verified payload. Forward M1
contributors → M4 receiver measured 60.050 s: 28 loads/12,763,132 bytes
(13 low/2,732,956; 15 high/10,030,176), with zero link closures and one outgoing
dial superseded by a crossed offer. Reverse M4 contributors → M1 receiver
measured 60.023 s: 17 loads/8,179,316 bytes (seven low/1,476,364;
ten high/6,702,952). It retained two initial donor dial timeouts after admitted
remote SDP installation/ICE checking, two receiver request-timeout link closures
followed by replacement connections, and two donor channel-error closures.
Numeric PC IDs do not identify remote roles; these records do not establish the
underlying routing or request-budget cause. No connectivity fix is claimed.

All roles recorded zero stalls/fatal/native/page errors or frame-freeze intervals,
and both contributors retained consent/serving in each run. Forward controls:
383 HTTP/1.1 responses, 382 finished and one commitment GET cancelled after
HTTP 200 headers. Reverse controls: 387 HTTP/1.1 responses, 386 finished and one
admission verification still pending after HTTP 200 in the final observer
snapshot; its terminal result is unknown. HTTP 200 does not prove an admitted
response body. Each run retained a pre-measurement media abort. Start/upload
consent was trusted; dropdowns were programmatic, with no native-menu claim.
No extra RTC/media/permission flags or whole-heap inspection were used.

All actor/provider/controller cleanup passed. Source cleanup v2 matched stable
identity, helper/input pins and start/cleanup journal receipt hashes; the reverse
review did not independently reread the raw remote journal. VPN Connected was
observed before and after each run only, not continuously. Bounded local transport
metrics are now deployed; they add observation without changing transport policy.
The earlier ordinary sharing reds below remain unexplained.
[Distributed fourteen-role qualification](../spikes/results/f393abf-distributed-qualification-20261014.json)
remains RED; sustained 7,200-second/22-churn,
physical/native-input, hard-NAT, matched field-benefit, cost and immutable-release
gates remain open across the full P01–P12 and 37-review-item scope.

The previous deployed 0e checkpoint passed its own nine-job first-attempt
[CI run 38500343145](https://github.com/forgesworn/relayswarm/actions/runs/38500343145),
production-only package and standalone checks.

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

The earlier 0e ordinary restored-VPN cross-machine HLS check remained sharing-red
for 60.020 s: four high-only verified loads/2,697,988 bytes, low zero, despite
both contributors retaining consent/serving; playback and all recorded error/
stall/withdrawal counts passed. High's 4,038,428 accepted/reserved bytes are not
receiver delivery or wire bytes. A preceding whole-heap-instrumented 60.074 s
check on the same finite source passed with 22 loads/10,151,436 bytes across
both qualities. These sequential results establish no heap/VPN cause. Separate
same-M4 raw RTC passed with the owner-disconnected VPN (6.517 s/8,192 bytes each
way), then failed after restoration (27.113 s); it is not HLS/admission/NAT proof.
Both ordinary-run VPN observations were Connected; all browser/provider/source
cleanup passed. Named receipts and precise counters are in [status](STATUS.md).

Documentation checkpoint `8c09478` passed all nine required CI jobs in
[run 38506350320](https://github.com/forgesworn/relayswarm/actions/runs/38506350320);
that documentation-only checkpoint did not change the then-deployed 0e runtime.
The later f393 deployment above includes bounded local transport metrics; see
[integration](../INTEGRATION.md#metrics). All earlier reds and full scope remain.

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

The preceding deployed checkpoint was `ee1510d429ac85f3738c03f10a09b753ec4eb037`,
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
[13 October acceptance summary](../spikes/results/current-source-acceptance-summary-20261013.json)
retains receipt identities and limits. v0.2.0 release and final downloaded-asset
acceptance remain pending; passing CI does not close the full checklist.
The [f999 public field summary](../spikes/results/f999-public-field-summary-20261013.json)
records the later short/partial-long, TCP relay and Android checks separately.

## Delivery checklist

Current state cells below use the checkpoint above; historical component evidence
retains its narrower scope. A passing component check does not close the other
requirements for production acceptance.

| ID | Requirement | Evidence required | Current state |
|---|---|---|---|
| P01 | Reliable live-edge peer delivery and adaptive quality | Unmodified live playlists, simultaneous viewers, quality changes and bounded fallback; paired origin baseline | 21 October, `140c256`: nine-job CI, 286-member consumption, guarded deployment and its review pass. Short qualifier R66 GREEN, 16 of 16 gates including `each4BothQualityPeer` (302.823 s, 1,250,000 B/s contributors, relay-only TURN over TLS/TCP). Receivers used 31.5% less origin traffic than matched baselines; total egress across the origin and TURN hosts rose by roughly 85 to 100 MB, and marginal cost is not determined. The sustained 7,200 s/churn run (Item 5) is RED and open after harness faults in R37 and R38 |
| P02 | Resolve intermittent MSE playback failure | Reproduction or supported diagnosis, regression and repeated concurrent hosted playback without fatal media errors | Exact later-retained sparse-AAC bytes reproduce the low-only failure; recovery restored video/audio in 403 ms with the original fatal retained; f999 maintained regression, required CI and repeated short concurrent public playback pass without fatal/native errors; original missing bytes do not establish historical causation, and sustained contribution remains separately open |
| P03 | Wider HLS media support | Signed exact-context tests and actual playback for fMP4, alternate audio, supported encryption, parts/deltas and mixed variants | Current Chrome fixture and exact-source CI evidence pass; physical/browser coverage is recorded separately under P12 |
| P04 | Production admission and adversarial resource defence | Key-bound expiring tickets, revocation, bounded issuance and verification; flood/exhaustion/withholding regressions | Exact3f selects four demo neighbours and address budget900, retaining SDKdefault6/default600/global2048. Historical R54 admission checks pass with0refusals/unknowns and provider peak731/alignedminute; full field capacity remains unqualified |
| P05 | Durable operational measurements | Private persistence, cumulative-report deduplication, restart recovery, explicit reporting consent and bounded retention | Real-browser acceptance PASS on `3f706a9` and again on `140c256` (natural expiry after 303,923 ms; reporting restored OFF; independent review). Other browser/load requirements remain under P12 |
| P06 | Persistent upload budgets and their device/account scope | Atomic persistent reservations, failure handling and actual reload/multiple-tab tests; a shared account cap across devices; uploading still requires new consent | Nostr and authenticated host-supplied account API supported; Nostr-only pilot valid, no named website/human wallet required. Public cross-Mac shared-cap API PASS and focused LOW lifecycle PASS (74.412 s/seven gates) cover low verified media/reservations, reload/new key/spend, reconnect OFF/fresh consent and state withdrawal. The 3 MB both-quality shared-cap lifecycle is RED and open on `140c256` (21 October): low verified peer media reached the receiver, three accepted 720p reservations (659,128, 673,604 and 659,692 B) were charged without completing as verified peer media, and the fourth was refused as exhausted at 2,625,232 of 3,000,000 B. Same class as the a416f7e third run; a design limitation under relay throughput (about 255 KB/s best link), one high-quality holder and a 3 MB cap, with the allowance behaving as documented. No re-run on this source. Desktop Firefox 152.0.6 and Safari 26.6.2 explicit-upload and reload-retains-usage checkpoints pass within desktop scope. Complete shared-media/physical acceptance remains open |
| P07 | Safe broadcaster crash recovery | Concurrent-process exclusion, forced process termination/restart, stable identity, monotonically separate generations and private state | `140c256` actual parent-crash test PASS with independent native review (21 October), following the earlier `5f2ece0` pass. Guardian/host catastrophe still requires operator inspection |
| P08 | Delegated signing and stream advertisements | Author-scoped expiring delegation, rejection/revocation tests, complete signed NIP-53 live/ended advertisements and host endpoint policy | Scope/revocation/discovery and exact-source CI evidence pass; caller-owned author trust/revocation freshness and operational advertisement policy remain explicit host responsibilities |
| P09 | Native application delivery | Installable executable entry point, independent-process native transfer, verified HTTP fallback and clean-consumer package test | Exact `140c256` fresh 286-member consumption/install/import/native/HTTP smoke checks pass. Consumer semver resolutions differ from root lock; standalone ESM is root-lock bound. Final publication and downloaded-release acceptance remain open |
| P10 | Protocol compatibility | Maintained wire/commitment specification, conformance fixtures and successful independent-client journeys | Published Kit v0.5.0 and actual independent public-SDK/browser author/delegate/adversarial journeys pass, including exact-source CI; standards acceptance is not claimed and physical integration is recorded under P12 |
| P11 | Current release and production deployment | All required checks on the final source, immutable release assets/checksums, exact deployed revision, fresh media and rollback/restart verification | Exact `140c256` nine-job CI, 286-member consumption, guarded deployment/HTTPS with independent review, P05 and P07 pass; private state, permanent leases and proxy preserved. v0.2.1 is published from merge commit `1d54538` (nine-job main CI, 287-member consumption, downloaded assets verified) by owner decision while Item 5, P06 and Safari 17.6 are RED; the merge commit is deployed with guarded deployment/HTTPS and independent review (app `ce410033`). Final acceptance remains open |
| P12 | Real-world acceptance | Physical Android/iPhone, Safari/Firefox, separate networks/hard NAT, hours of load/churn/cost measurements and authorised OBS/external-platform playback | 21 October, `140c256`, macOS arm64 desktop scope (one 1,800 s finite source, three owned Chrome 155 actors per browser, relay-only TURN over TLS/TCP): Firefox 152.0.6 PASS and Safari 26.6.2 PASS (first Safari pass), all six checkpoints each; Safari 17.6 RED (no verified peer download in 45 s, no selected candidate pair, cause not determined, not retried). R66 short qualifier GREEN. Sustained 7,200 s/churn/natural-expiry (Item 5) RED and open; marginal cost not determined. Physical iPhone (unavailable), physical Android and device Safari/Firefox (need the owner), hard NAT and a separate network (need another network) remain open. Prior Simulator/account/LOW lifecycle/Internet TURN passes retain original scopes |

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
