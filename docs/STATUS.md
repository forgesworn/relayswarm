# RelaySwarm evidence and remaining work

[Documentation](README.md) · [Field-test guide](FIELD-TEST.md) ·
[Changelog](../CHANGELOG.md)

Checkpoint: 14 October 2026. The published experimental release is
[v0.1.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.1.0), which points to
`3e480e19dfe4d675f14bcb2968f3dc4926fbca25`. The 0.2.0 production feature
candidate remains on PR 8 pending final checks and release. Later documentation corrections
on `main` do not change that tag or its immutable downloaded assets.

## Complete-playlist blocking reload candidate

The example origin now supports bounded blocking reload for compatible complete
live playlists, consistently across all renditions. The [API contract](API.md#example-origin-http-playlists)
keeps raw media, peer deadlines, origin reserve and playback holdback unchanged.
Independent review addressed shared directory-watch replacement/rearm races,
observed-change reauthorisation and response-slot retention until transmission
finishes. All 49 focused tests pass, including five actual loopback HTTP cases;
worker reaping and group/birth absence passed. This focused guard has no resource
sampler. The [source-check summary](../spikes/results/blocking-playlist-reload-source-checks-20261014.json)
records exact file hashes and scope. Paired real broadcast acceptance is pending.

The preceding exact `fc39e32` check passed eight of nine required jobs in
[CI 38640084885](https://github.com/forgesworn/relayswarm/actions/runs/38640084885).
The broadcast failed initial low-quality peer delivery, before high-quality or
restart checkpoints. Healthy connections and late donor availability did not
establish a runtime fault or a polling cause. That failure remains separate
from the older all-green 7a check below; this capability is not yet a proved fix.
Release, deployment and the remaining field gates stay open.

## Earlier source checkpoint: 7a on 14 October 2026

Exact `7a5de06a97baf14c00e3a420944b75a730042c85` passed all nine required
jobs on attempt 1 of
[CI 38625083620](https://github.com/forgesworn/relayswarm/actions/runs/38625083620);
the optional soak was skipped. The injected loopback broadcast passed both
qualities and producer-restart sharing: six verified loads/3,240,180 bytes,
including one post-restart high fragment/791,856 bytes. That fragment finished
1,291.1 ms before its original deadline with the unchanged 2,000 ms reserve.
Each donor recorded one stall; baseline/consumer recorded none. Fatal, native
and append failures were zero. All 246 observation rows and four extractions
were retained without drops/unknowns/unlabelled objects. Recorder release does
not prove missing actor/API or OS reaping. TURN renewal was off in this fixture;
its PASS does not establish that the cache correction repaired broadcast recovery.
The da9 media RED and deterministic cache reproduction remain unchanged.

Fresh exact-7a offline production-only consumption passes all 239 package
members against committed paths/modes/bytes, eleven documented imports,
installed CLI, sequential durable ledger replay, separate-process verified
native transfer/HTTP fallback and rebuilt ESM. The unpublished tarball is
1,088,342 bytes, SHA-256
`10e2c0e972ecc176754d12db3ca1bbe31cec2489efe300a80b1c9e17d12816d3`;
the fresh ESM is 121,478 bytes, SHA-256
`612f5f502964462d8eba8909e5041db1030da96edbaea7dd5caa1088d1eac171`.
Owned phase groups, sampled direct-child probes and scratch cleanup pass.
Earlier da9 consumer R1 RED/R2 PASS remain separate.

The hosted mock-issuer renewal fixture passed in 50.904 s, retaining consent
and spend through new-swarm peer delivery, account linking, restart and reset.
It uses 15 s fake credentials and loopback host WebRTC, not an Internet relay.
Actual existing-service forced-renewal attempts R3 and R4 remain **RED**. R3
omitted its failed sample, so the exact terminal assertion remains unknown.
R4 retained the failure: three constructor refusals under its unchanged
maximum of two lifetime PCs per page, after legitimate initial glare consumed
the donor's first PC and serving used its second. The client accepted refresh 2
and a new 3,600 s lease, retaining checked consent and nondecreasing spend;
no new PC or post-renewal TLS/media was proved. R4 recorded 16 prior verified
fragments/1,861,388 bytes but no strictly selected positive TLS-pair sample.
All owned worker/fixture/group/scratch cleanup flags passed; shared allocation
absence was not inspected. These attempts do not diagnose a product renewal
failure, server quota refusal or the earlier connection-closure cause.

A separate installed Safari 26.6.2 tooling check on M4 remains **RED**. Driver
status returned ready, but POST/session reached its 14,506.1 ms whole-call
deadline without a response or session ID. No page navigation, button click or
RelaySwarm test ran. The owned driver and two wire workers were reaped; runner,
guardian and group absence and inert scratch removal passed. Session destruction
remains unknown. M4's resource observation preceded the blocked call and does
not prove continuous monitoring during it.

The [7a checkpoint](../spikes/results/7a5de06-ci-consumer-and-renewal-checkpoint-20261014.json)
keeps these source-bound results separate. The last-attested pilot remains 8f,
with reporting/forwarding off; no fresh deployment is claimed. v0.1.0 remains
published, candidate assets unpublished and PR 8/P01–P12 open. Ordinary
sharing, complete Safari/physical devices, sustained 7,200 s/22 churn,
natural expiry/reconnection, matched wire/cost and final release acceptance
remain open.

## Cached TURN credential correction

A deterministic clock test at da9 reproduced an unchanged cached reply
rebuilding peers and moving the conservative local expiry. The follow-up client
keeps the original lease for identical credential material, skips the refresh
counter and callback, and retries within the existing bounds. All expiry,
generation, suspension and consent checks still run before acceptance.

Eleven lifecycle and four page-VM cases pass in one 481 ms focused run. The
worker was reaped and its group and original birth were absent. This focused
guard has no RSS/pressure sampler; no such resource proof is claimed. The
[correction checkpoint](../spikes/results/turn-cached-lease-fix-20261014.json)
records the exact source digests and preserved reproduction. Exact-7a CI/package
results and the separate RED Internet-renewal attempts
are recorded above; the da9 results below belong to the preceding source.
The pilot is unchanged.

## Optional TURN renewal candidate

Exact source `da9ac9202fd8794a68d6d707a1ab5d8109bbbb34` completed attempt 1 of
[CI 38620173084](https://github.com/forgesworn/relayswarm/actions/runs/38620173084)
with eight required jobs PASS and the media job RED; the optional soak was
skipped. Both low/high peer checkpoints passed, but the unchanged 60 s
post-producer-restart peer-fragment gate timed out. All 31 consumer fragments
at discontinuity 1 came from origin. Their peer budgets were zero: playable
ahead was 1,159–1,202 ms against the unchanged 2,000 ms reserve, even though
matching donor completions preceded consumer loading. Accepted HAVE rows do
not reconstruct current membership. This is a policy observation, not a
playback repair or a reason to relax the gate. Each donor recorded one stall;
baseline/consumer recorded none, with zero fatal/native/append failures.
Broadcast recorder release does not establish missing actor/API or OS cleanup.

The optional server-owned [credential adapter](FIELD-TEST.md#optional-turn-credential-renewal)
is off by default. Eleven server/owned-HTTP tests, ten client lifecycle tests
and four page-VM cases pass. The retained retry-liveness finding is closed by
the separately reviewed R2 correction. A real local Chrome fixture passed in
47.010 s, and the equivalent hosted fixture passed in 50.433 s. Both use an
owned fake issuer, 15 s credentials and real loopback WebRTC host media; the
TURN endpoint is unavailable loopback port 9. Rollover retains consent and
accepted spend, delivers new-swarm peer media, and passes link/restart/reset
checks with scoped worker/API/group/scratch cleanup. These are browser
integration passes, not Internet TURN renewal. At that da9 checkpoint the
existing-service renewal check was pending;
the later exact-7a attempts are recorded separately above.

Fresh exact-da9 offline production-only consumption passes eleven documented
imports, installed CLI, sequential durable ledger replay and separate-process
verified native transfer/HTTP fallback. All 237 package member paths, modes
and bytes match committed source. The unpublished tarball is 1,082,277 bytes,
SHA-256 `6d618c25d15032a79cb07a5050dd51f2aa9273575f511c1b83a1b1906e475412`;
the rebuilt ESM is 121,478 bytes, SHA-256
`612f5f502964462d8eba8909e5041db1030da96edbaea7dd5caa1088d1eac171`.
Owned phase groups, sampled direct-child probes and scratch cleanup pass.
The first consumer attempt remains RED: its new smoke assertion expected
POST 404 where the unchanged disabled-route method contract returns 405;
the corrected R2 proof does not relabel that attempt.

The [da9 checkpoint](../spikes/results/da9ac92-ci-and-consumer-checkpoint-20261014.json)
retains exact hashes and fixture limits. The deployed pilot remains 8f with
reporting/forwarding off; v0.1.0 is published, candidate assets are unpublished,
and PR 8/P01–P12 remain open. Ordinary sharing, physical devices, sustained
load/churn, real credential-expiry/reconnection, matched wire/cost and release
acceptance remain separate gates. Earlier source evidence below is unchanged.

## Earlier completed CI source: 07 on 14 October 2026

Exact source `07ea96becce44fec6baa0b41f7719e0e99ee4031` passed all nine
required jobs on attempt 1 of
[CI run 38616043417](https://github.com/forgesworn/relayswarm/actions/runs/38616043417);
the optional soak was skipped. The Windows CRLF observation-test correction
retains six meaningful cases and the byte-exact LF diagnostic bundle.

The Linux Chrome 155.0.8059.79 broadcast diagnostic passed all four checkpoints,
including producer restart, with six verified peer loads/3,125,876 bytes.
Low/high contributors recorded 221,840/2,904,036 uploaded bytes. All 239
observation rows (77/82/20/60) were retained with zero drops, unknowns or
unlabelled objects, and all four final extractions passed. Each contributor
recorded one stall (2,938/1,968 ms); baseline and consumer recorded none.
Fatal, native and append failures were zero. This uses an injected diagnostic
bundle and declared loopback/headless/fake-media RTC fixture settings. It does
not establish ordinary/physical qualification or repair the earlier failures.
The raw receipt has no full actor/API or OS-reaping cleanup flags; recorder
release does not replace that missing proof.

The earlier `abb5de7` CI remains seven required PASS/Windows FAIL, with the
media job PASS and dependent live-relay/optional soak skipped. The 426 CI's
eight required PASS/media FAIL also remains. Exact-426 package/consumer/ESM
proofs below remain bound to 426; fresh 07 package proof has not run. The
[07 summary](../spikes/results/07ea96b-ci-checkpoint-20261014.json) records these
separate results. The deployed pilot stays 8f; v0.1.0 is published and PR 8/P01–P12
remain open. Exact 07 retains the static TURN credential limitation below;
the later renewal candidate's component evidence is separate.

## Earlier source checkpoint: 426 on 14 October 2026

Exact source `42608f758919628dfa86dee667f6c7f3050fbcc4` completed
[CI run 38607468217](https://github.com/forgesworn/relayswarm/actions/runs/38607468217)
with eight required jobs passing and one media job failing its first low-quality
peer-load gate after 30 s. That RED remains. The later test-only diagnostic
adds observation, preserving playback policy, peer deadlines, origin reserve
and upload consent; its later CI results are recorded separately above.

The separate local injected HAVE/deadline diagnostic passed in 33.759 s with
six total verified peer loads/3,107,076 bytes across both qualities. Only the
last observed high-quality object was post-restart. Its load completed
366.123 ms before the recorded deadline. All 277 observation rows were retained
without drops. This used Mac Chrome 155.0.8059.41 and an injected diagnostic
bundle; the failed Linux CI used 155.0.8059.79 without that injection. It neither
reproduces the CI failure nor establishes a repair. The queued/accepted HAVE
observations are now maintained test instrumentation only.

Fresh exact-426 offline production-only consumption passed eleven documented
imports, sequential durable ledger replay, installed CLI and separate-process
verified native transfer/HTTP fallback. All 226 package member paths, modes and
bytes match committed source, including the new Darwin filesystem verifier.
The unpublished tarball is 1,044,255 bytes, SHA-256
`78edf82d98481e0a4452f4f9c1aaa06f162adf3c6ce2c001328de4ee4c9c9935`;
the rebuilt ESM is 121,478 bytes, SHA-256
`612f5f502964462d8eba8909e5041db1030da96edbaea7dd5caa1088d1eac171`.
Both workers, their groups, sampler children and scratch cleanup passed. These
proofs belong to 426, not 07, another documentation/test commit or a release.

An existing shared TURN service was then confirmed separately from the earlier
Till inventory. One controlled RelaySwarm TLS-relay check passed over 90.005 s
of measurement (105.150 s whole): the receiver recorded 34 complete verified
peer fragments/3,956,272 bytes; the contributor recorded 4,175,104 uploaded bytes.
Both pages showed positive selected TLS-relay pairs in 67 of 91 samples. Each
constructed two peer connections; the final seven samples had no active peer
connection while video/time continued. This is not continuous 90 s TLS, one
stable connection, both-rendition, physical-device or hard-NAT proof. Recorded
stall/fatal/native projections were zero; unavailable fields can project to zero.
The run used two headless pages, local synthetic HLS/Nostr and injected relay
policy, with trusted Start/upload and programmatic dropdowns. Server quotas,
shared allocation absence and matched wire/billing remain unproved.

Both CLIs read `--ice-config` once; session responses reuse that array and new
outgoing/incoming peer connections use captured options. No supported ICE
credential renewal exists. The observed issuer TTL is 3,600 s against the
7,200 s goal, so fresh allocations/reconnections after expiry remain unproved;
this does not establish that existing allocations die at that TTL. An optional
server-owned credential endpoint and expiry-aware client refresh remain
follow-up work, retaining consent, admission and durable spend, with origin
fallback on failure.

Client/worker/group/scratch cleanup passed, and the issued private ICE file and
directory were removed separately. The existing service and network rules were
unchanged; no new infrastructure or Till/provider exposure was created. The
[426 evidence summary](../spikes/results/42608f7-source-and-tls-checkpoint-20261014.json)
retains the exact scopes. The deployed pilot remains 8f, with reporting and
forwarding off; PR 8, P01–P12 and final release acceptance remain open.

## Current source: shared account allowance

The current branch adds both requested account methods: explicit Nostr sign-in
and an integrating website's authenticated account. One private durable ledger
serialises reservations across devices. Explicit linking adds spend and retains
the lower limit; settings, reset, linking and connection leave uploading off.
See [shared upload allowance](ACCOUNT-UPLOAD-BUDGET.md).

The [controlled Chrome result](../spikes/results/account-budget-implementation-20261014.json)
passes in 55.780 s with both authentication methods, verified peer media at both
qualities, short-grant renewal, linking, server restart/reconnection, reset and
disconnect. At linking, receiver bytes, committed upload totals and merged
spend equal 6,337,480 bytes; the same balance survives restart. All browser,
server, media, owned-group/reap and scratch cleanup checks pass. This uses
disposable Nostr signatures, an owned website session and explicit loopback RTC
fixture flags, not physical phones or a real owner's signer. Local tests pass:
177 publisher cases (two Windows-only skips) and 92 swarm cases.

The earlier 49.043 s pass is retained with its provisional upload-counter
caveat. The corrected source separates pending quota from committed uploads.
One intervening full-suite guard test failed on `EPERM`; its original cleanup
remains unknown because its exact PID was not retained. A later read-only check
found no matching test program; this does not reconstruct original cleanup.
The final guard waits for explicit absence within the unchanged deadline, and
the corrected full suite passes. Original failures are not replaced by later
passes.

The deployed `8f482b4` checkpoint below includes this account service. All nine
required CI jobs, clean package consumption and guarded pilot deployment pass.
The pilot offers Nostr sign-in; integrating sites supply their own authenticated
website resolver. Actual owner authentication, complete physical journeys and
network/sustained/release acceptance remain open.

## Earlier source checks: restart sharing failures

Checkpoint `a2c99a9` finished attempt 1 of
[CI run 38569064323](https://github.com/forgesworn/relayswarm/actions/runs/38569064323)
with eight of nine required jobs passing. The playback job failed its unchanged
60 s post-producer-restart peer-fragment assertion. Both pre-restart peer
qualities passed. After restart baseline and consumer playback progressed
without stalls, fatal/native errors or append failures, but the consumer
loaded all 30 completed new-discontinuity fragments from origin. Its 31 measured
peer waits had initial budgets of 286.846–337.173 ms: 17 aborted, 13 expired and
one remained pending. Established links and upload consent remained active.

Thirty matching donor fragment-completion events occurred 53–108 ms after
consumer origin completion, subject to the retained cross-page clock limits.
This does not establish a lost notification, key mismatch or exact scheduling
cause. Per-load buffer geometry and actual request start timings were absent.
The [original failure summary](../spikes/results/a2c99a9-ci-restart-failure-20261014.json)
retains that failure and its cleanup limits. Later observations are separate
results. Playback policy, fallback cap and origin reserve remain unchanged;
at that checkpoint the deployed pilot was still `df51cbe`.

Current source adds bounded numeric `budgetGeometry` to the existing local
eligibility records using only values already read by the calculation. Wait
outcomes retain the original values, and returned snapshots own copies. The
full 94-case swarm suite passes locally; an independent source review found no
getter-order, formula, deadline or authority change. See the
[metrics contract](../INTEGRATION.md). This observation is not a sharing repair
or new hosted/physical acceptance result.
The broadcast fixture also records cached request lifecycle timings without
extra requests or body reads; ten pure observation tests pass, including release
after each possible teardown rejection. Its original
startup, waits, launch flags and peer assertions are preserved. The
[broadcasting guide](BROADCASTING.md#verification-boundary) describes the bounds
and diagnostic scope.

The instrumented `d283071` attempt of
[CI run 38575462650](https://github.com/forgesworn/relayswarm/actions/runs/38575462650)
finished with six required jobs passing, two failing and the dependent live-relay
job skipped; the optional soak was also skipped. The unchanged post-restart
peer assertion failed again. Its 31 initial waits had 2,268.463–2,329.467 ms
of playable buffer and the unchanged 2,000 ms reserve, leaving 268.463–329.467 ms.
For all 30 matched high-quality segment objects, cached native request timings
place the donor request start 46.694–102.418 ms after consumer response completion.
These donor HTTP intervals did not overlap the receiver's origin interval;
the newly loaded bytes were too late for the preceding peer wait. This does
not identify the exact playlist scheduling cause or a lost HAVE notification.

The other failure was an existing macOS HTTP cancellation test: immediate
invalid policy could legally cancel a session before server ingress, while
the assertion required ingress first. A test-only phase gate establishes that
precondition, preserving the real start/cancellation checks, hidden-page phase
and all deadlines. All four focused real HTTP cases pass locally, and an
independent source review passes. The
[d283 observation and correction summary](../spikes/results/d283071-ci-observations-20261014.json)
retains both original failures, exact inputs and limitations. Neither correction
nor later CI removes the restart-sharing gate; these checks did not change the then-deployed pilot.

## Current deployed checkpoint: 8f on 14 October 2026

The deployed application is `8f482b4528a671acfe9f1afc336cce5743aaaefd`.
All nine required jobs passed on attempt 1 of
[CI run 38578315372](https://github.com/forgesworn/relayswarm/actions/runs/38578315372);
the optional soak was skipped. The non-root image passed 54 runtime-file checks
before guarded replacement, preserving publisher identity, permanent leases,
private account state and the independent EE HTTP/1.1 proxy. The normal-TLS
public client is 746,875 bytes, SHA-256
`70e92c18234375ae437b0ad3d9c1ba47d4ecbd6a12836e15540b1ce34111a87f`.
The image is
`sha256:c89bbed80eaa89b750f91f594a7c2c08940ccfa9b7188cf7e4264a8225b27cfd`.
Both fresh rendition playlists were attested. Reporting and forwarding remain
off, and the verification source was removed. The pilot offers Nostr sign-in;
its website account resolver remains unconfigured.

Fresh production-only consumption passed eleven documented imports, durable
ledger replay, the installed CLI and separate-process verified native transfer
and HTTP fallback. The unpublished package is 1,024,043 bytes/219 files,
SHA-256 `3505d8b086c4be44a414bee829872915fb4383ae94251f44e24b856fcdef9198`.
The archive is 3,758,080 bytes, SHA-256
`591ea9994fcc7a03d77f8820c50b31bf6820ea29408ba547abfca91a51201cf2`;
the standalone ESM is 121,478 bytes, SHA-256
`612f5f502964462d8eba8909e5041db1030da96edbaea7dd5caa1088d1eac171`.
These local proofs do not establish published/downloaded-release acceptance.

The CI broadcast fixture verified both peer renditions before producer restart,
then one 819,868-byte high-quality fragment afterwards. Receiver and origin
baseline recorded no stalls, fatal/native errors or append failures. Explicit
RTC/fake-media fixture flags and loopback topology limit that result; earlier
restart-sharing failures remain separate.

The ordinary cross-Mac R2 check measured 60.119 s: playback passed, contribution
and both-quality peer delivery failed, with zero peer channels or verified peer
bytes. Six dials installed remote SDP and reached ICE checking before timeout.
All 335 retained control requests finished HTTP 200 over HTTP/1.1; status alone
does not prove an admitted response body. Across the retained whole journey,
all 120 buffer geometries matched the existing budget formula; three startup
rows remained unknown. No peer wait entered or expired. The two measured
high-donor zero budgets had less playable time than the actual dynamic reserve.
This does not establish a scheduler or connectivity defect or justify changing
playback policy, origin reserve or deadlines.

Original execution cleanup remains red. The outer ownership probe exceeded its
unchanged 0.5 s limit; M4 refused watcher termination because the full command
changed while birth and process group matched. The actual differing command was
not retained, so the canonical interpreter pin has not proved a repair. Later
exact owned process/group/path absence and helper-stage removal are separate
proofs; they do not reconstruct original watcher reaping. Source cleanup v2
matched all five provenance guards and removed the finite encoder, retaining
its observed exit 255. A preceding R1 capture refusal launched no browser;
its original cause remains unknown.

A separate R3 attempt stopped before source or browser workload: its authenticated
interpreter capture exited normally, but the freshness validator rejected a
remote timestamp 68 ms ahead of this Mac's clock. That specific refusal is
recorded; it does not establish the earlier R1 cause or a completed correction.
No system clock or freshness limit changed.

The earlier temporary coturn fixture passed two verified segments through an
owned SSH tunnel, then its service and credentials were removed. A fresh
read-only Till observation found no known TURN service or standard TURN
listeners, while the pinned image remains cached. That scoped Till inventory
did not cover the separate existing shared service tested in the latest
checkpoint above. The SSH result remains separate from direct Internet TLS
evidence and hard-NAT acceptance; no new public TURN service started.

The [8f checkpoint summary](../spikes/results/8f482b4-current-checkpoint-20261014.json)
records exact artifacts, separate cleanup results and retained local receipt
hashes. All P01–P12 acceptance remains open, including the same-topology 300 s
qualifier, two-hour/churn, physical/Safari, hard NAT, matched wire/cost and final
release/download checks. PR 8 remains open; v0.1.0 remains the published release.
This documentation checkpoint does not change the deployed runtime source.

## Previous deployed checkpoint: df51 on 14 October 2026

The deployed application is `df51cbed1ebb3bd09ef1b521c451d6b47989a664`.
All nine required jobs passed on attempt 1 of
[CI run 38554223220](https://github.com/forgesworn/relayswarm/actions/runs/38554223220);
the optional soak was skipped. The normal-TLS public client is 746,356 bytes,
SHA-256 `875d1a24c90cac5ea0df5b9a1dd2557df606aa0c5ba75ff1a60216ad12b0c6dc`.
The image is
`sha256:bec569791de3ed2b077a83a79eb26d6a3741d051fda265336e97919b17f191c1`.
Guarded deployment preserved publisher identity, private account state and the
independent EE HTTP/1.1 proxy. Both fresh rendition playlists were attested;
finite verification sources are now removed, so this is no ongoing-ingest claim.

The fresh offline production-only consumer passed eleven documented imports,
durable account-ledger replay, installed CLI and separate-process verified
native transfer/HTTP fallback. The unpublished package is 993,652 bytes/212 files,
SHA-256 `ad57ea048ba9f098aec5ecd9028f9b5a5c7d1168b21a9957ee1b53d4b3fc9db4`.
The source archive is 3,645,440 bytes, SHA-256
`b3607b6fc069a14330c75fd1426205f8e3c76df0f848af4d93df7e0f1c5880de`;
the standalone ESM is 120,957 bytes, SHA-256
`50647647b96a0ce4a89fdfb0a42b053601d2cd5b10c2525cc57e283af2900c63`.
These local assets do not prove downloaded immutable-release acceptance.

The later documentation checkpoint `e144b8c` recorded a macOS CI test failure:
one eligibility case expected two peer requests but observed one. Its real
60 ms branch budget competed with cryptographic work, while identical fixture
origin/peer bytes could conceal fallback. A test-only correction retains real
signatures/hashes and the same 60 ms budget, drives virtual time at observed
phases, and requires two peer deliveries plus exactly one origin fallback.
Four focused cases and the full 92-case swarm suite pass locally. Real timers
are restored before closing the fixture; an intermediate delayed exit remains
recorded. No production code or deployed runtime changed, and the exact CI
scheduling cause was not reproduced locally. See the
[retained failure and correction](../spikes/results/e144b8c-ci-test-timing-20261014.json);
new-head hosted checks are a separate result.

Checkpoint `18729eb` then passed all 92 swarm cases on macOS, including that
eligibility case. Its publisher suite exposed a different test assumption: two
concurrent HTTP reservations returned one refusal and one acceptance in the
opposite order to the assertion. The correction requires exactly one acceptance,
70 bytes reserved/spent and an unchanged replay decision, without requiring an
HTTP arrival order. All ten account HTTP cases pass locally. Production code,
limits and deployment are unchanged; the
[original failure and test correction](../spikes/results/18729eb-ci-account-http-order-20261014.json)
remain distinct from later CI.

The ordinary four-role check remains **RED** over 60.110 s: requested video and
native audio progressed, but no peer channel opened and verified peer/upload
bytes were zero. All 91 measured eligibility decisions had a positive 1,500 ms
budget and no matching advisory HAVE; none failed for zero budget. All 335
controls finished HTTP 200/H1, which does not itself prove admitted bodies.
Six dials timed out after remote SDP installation and ICE checking. Missing
HAVE with no channel does not establish a cache defect or justify a budget change.

A separate 60.027 s heap/native-stats diagnostic also passed playback and failed
sharing. Twelve retained pair observations across four page-local PC labels
showed UDP host/host or host/srflx pairs in progress, request counters 22–80 and
zero observed received requests/responses. These include repeated snapshots,
not twelve unique pairs or traffic deltas; selection was unknown. Fifty batches
completed, but only 42 latest snapshots were retained; eight remain unobserved.
All diagnostic handles were released and contexts closed. This narrows the
observed failure to unanswered ICE checks, without identifying its network cause.
Heap/native inspection means this is diagnostic evidence, not ordinary qualification.

Original M4 controller cleanup timed out in both checks; recovered endpoint
watcher cleanup was false. The diagnostic's guard refused before TERM because
full command text differed despite matching birth/PGID. Its replacement command
and cause were not captured. Later exact PID/group absence, profile/TMP removal
and owned-stage removal were proved separately without signals. They do not
prove original parent reaping. M1 cleanup and both separate source-cleanup-v2
proofs passed; source exit 255 remains recorded. Private duplicate archives were
removed; named originals and review evidence remain.

See the [df51 evidence summary](../spikes/results/df51cbe-current-checkpoint-20261014.json).
The full P01–P12 checklist remains open, including the same-source/topology
300 s qualifier, 7,200 s/22 churn, complete physical/native-input/Safari journeys,
hard NAT, matched wire/cost measurements and final release acceptance. Earlier
references to 37 review items have no separately located row-by-row ledger;
no 37-item completion is asserted. PR 8 remains open; no new release is published.

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

## Previous deployed checkpoint: 2dd on 14 October 2026

The deployed application checkpoint is `2dd156e64f86e6f18b616e7d87159aee1c43eac2`. All nine required
jobs passed on attempt 1 of [CI run 38525990386](https://github.com/forgesworn/relayswarm/actions/runs/38525990386).
The optional CI soak was skipped; it is not a new sustained pass. The normal-TLS public client
is 734,604 bytes, SHA-256
`34259c97f1317c3ae4668c2634df6d57287ca8a40b4c8a249088c0400f3c1a61`; the image is
`sha256:200807d127f0e8cac781b1d9bd36ddfb0541285cc3eae2db96590d5410dc189c`. Guarded deployment preserved publisher identity and private
state. The permanent HTTP/1.1 proxy retains independent EE provenance; a later
documentation commit does not change the recorded application source.

The fresh offline production-only consumer passed ten documented imports,
byte-exact packaged demo/browser modules, installed CLI configuration and
separate-process verified native transfer/HTTP fallback. The local tarball is
924,153 bytes/197 files, SHA-256
`b1b35376140af23aedb021598f33dbd4d1da69568405853b1d257a9549804ae3`. The exact source archive is
3,358,720 bytes, SHA-256
`bdb50144f30d089a6fee2baa9ffe6aa98005e1b76b45d282951a6a988a335d04`. The rebuilt standalone ESM is
119,525 bytes, SHA-256
`c3df43a8d16bb1a4bd7e6fb2373b9f5e70e9c70871b6763c079136beed4e5a24`. These assets remain unpublished;
local checks do not prove downloaded immutable-release acceptance.

The ordinary four-role public check remains **RED** over 60.049 s: playback
passed, but contribution and both-quality verified payload failed. The receiver
accepted 15 low-quality loads/3,169,304 bytes and no high-quality peer payload;
both contributors retained consent/serving, while the high donor uploaded zero.
All 358 fixed-route controls finished HTTP 200/H1; HTTP 200 does not prove
an admitted response body. There were no new measured stalls, fatal/native/page errors
or zero-frame intervals. The high donor's earlier 1,247 ms stall remains recorded.
Actor/provider/controller/outer and actual source-cleanup-v2 proofs passed;
source exit 255 is retained. No connectivity cause or fix was established.

The same-source distributed checks used fourteen total roles: four M1
contributors in one Chrome process, and ten M4 roles in two Chrome processes
(four contributors, four receivers and two origin baselines). They used installed
headless Chrome, trusted DOM Start/upload and programmatic dropdowns, without
extra RTC/network/permission flags. Their outcomes remain separate:

| Case | Actual stopping condition | Result and retained limitation |
|---|---|---|
| R7 | M4 descendant-resource probe timed out after 52.501 s of measurement | RED; last accepted RSS 8,375,910,400 bytes, process highwater 48/96 and reported free memory 78%; no observed cap crossing or rejected-probe RSS proof; all actor/source cleanup passed |
| R9 | M1 process count 33 exceeded the declared 32 after 6.453 s | RED; rejected instant RSS unknown; original explicit browser context-close acknowledgements were false, separately proved endpoint/profile/process/stage/source removal retained |
| R10 | Complete M1 orchestration tree count 41 exceeded 40 during setup | RED before measurement; endpoint-only process highwater 33 is a different scope; original unfinished browser cleanup and failed M4 receipt read remain unknown/false, with later exact-identity M4 recovery/removal and source cleanup separately proved |
| R11 | Peer-readiness preflight found zero links and zero verified payload | RED before measurement; all fourteen decoded video/native audio in setup, but 300 s/both-quality/two-renewal gates never ran; resource and all original actor/source cleanup proofs passed |

R11's separately declared M1 process cap was 64 with the same 3 GiB limit;
its complete-tree sampled highwaters were 46 processes/2,590,523,392 bytes.
M4 remained at 12 GiB/96 processes, with sampled highwaters 8,060,862,464 bytes/
52 processes. Reported free-memory minima were 29%/77%. Summed sampled RSS is
neither unique physical RAM nor an unsampled peak. Earlier resource REDs remain
RED; changing a declared later limit does not retroactively qualify them.

R11 retained 133 local peer-connection IDs: 120 timed out after remote SDP was
installed and ICE checking observed, with zero opened channels or observed
native failure before the engine timeout. These are local endpoints, not unique
cross-page peer pairs. All 1,211 fixed-route statuses were 200; 1,210 had terminal
CDP completion, with one post-200 policy request still unobserved at shutdown.
All 483 admission observations finished without refusal/unknown status; 227
accounted detail evictions do not provide a complete timeline or admitted-body
proof. The underlying reachability cause remains unresolved; neither a timeout
increase nor a production connectivity fix is supported by these records.

Installed M1 Safari 17.6 R2/R4/R5 were **bootstrap-only REDs**, with zero media
measurement and no Start/upload action. R2 retained hidden/unfocused readiness
snapshots; a fractional-timeout harness defect was reproduced separately without
proving the exact terminal cause. R4 refused a maximise route in its own worker
allowlist before readiness; that is not proof Safari lacks maximise support.
R5 reached its readiness deadline: the last 15 snapshots were hidden/unfocused,
50 earlier predicates were evicted, and late authority withdrawal remains
recorded. Exact owned sessions, drivers, workers, stages and outer processes were
cleaned; these checks do not establish Safari playback, input or phone acceptance.

The actual physical-iPhone read-only USB R2 attempt stopped RED at usb-lockdown
in 2.464 s, before any Runtime.evaluate or numeric sample. Its original operation
error was not retained separately from cleanup-incomplete; lockdown closure
remains unknown. The exact worker/group, private SDK scratch and empty pairing
cache were removed. This is no phone playback/gesture/peer acceptance. A prepared
diagnostic successor is not an executed test. No further phone result is claimed.

See the [current 2dd evidence summary](../spikes/results/2dd156e-current-checkpoint-20261014.json). Earlier f393 short passes and older dated Kit, OBS and
private-YouTube results below retain their source, date and scope; none is a
current 2dd field pass. The full P01–P12 and 37-review-item scope remains open,
including a completed same-topology 300 s qualifier, 7,200 s/22-churn operation,
complete physical/native-input journeys, Safari, hard NAT, matched total-wire/
actual-cost evidence and immutable-release acceptance. No production-ready or
new publication claim is made; completed finite sources are not a live-ingest claim.

## Previous f393 checkpoint on 14 October

The previous deployed application checkpoint was `f393abf3d55215bdf58241a4a2af74245d646117`.
All nine required jobs passed on their first attempt in
[CI run 38511479806](https://github.com/forgesworn/relayswarm/actions/runs/38511479806).
The optional twelve-viewer CI soak was skipped, not a new sustained pass.
The permanent HTTP/1.1 proxy retains independent EE provenance. The normal-TLS
served client is 734,441 bytes, SHA-256
`4fdb2861b08f42e4c82788a5940e0b2b436be52af84bc264998d41cf81938fcb`.
The exact image is
`sha256:d3bba4a8e8c991cf38d89a3d3a619868851842cda4187c2c0e58c58d4ca5a626`.
Its 51-file non-root preflight and actual guarded deployment/public-client
attestation passed, preserving publisher identity and private state.

The fresh offline production-only consumer passed ten documented imports,
byte-exact packaged demo/browser modules, actual installed CLI configuration,
independent-process verified native transfer and verified HTTP fallback.
The unpublished package is 902,933 bytes/193 files, SHA-256
`f978dcb53dfa7a6e2db9d6c9af23f95e805a75d92a71a1644220853be8b22294`.
The exact Git archive is 3,276,800 bytes, SHA-256
`ccf46b011da5fad21a518f4ee8ade29a160bfc8ad4d8dea4fdf22ad006ca6646`.
The rebuilt standalone ESM is 119,525 bytes, SHA-256
`c3df43a8d16bb1a4bd7e6fb2373b9f5e70e9c70871b6763c079136beed4e5a24`.
Six repository inputs and 20 locked dependency input files, expected exports,
absence of external imports, actual import and retained 64-record diagnostics
were checked. These local assets remain unpublished and do not prove downloaded-
release acceptance. Named receipts are `clean-consumer-f393abf-20261014` and
`standalone-esm-f393abf-20261014`; public-client attestation is separate.

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

The first distributed attempt (R2) stopped before measurement after a resource
assertion whose rejected numeric sample was not retained; original cleanup errors
and independent stage recovery remain separate. R3 retained an endpoint subtree
RSS rejection of 2,318,106,624 bytes against 2 GiB, at 20 processes and reported
free memory 35%. This summed RSS is neither unique RAM nor a simultaneous outer
tree peak, and does not retroactively explain R2. R3 actor/source cleanup passed.

These distributed checks use installed Chrome in headless mode with loopback
remote debugging. They retain trusted DOM Start/upload input and programmatic
dropdowns; they do not establish physical input or native-menu acceptance.

A separately reviewed R4 changed only M1's complete-tree RSS cap to 3 GiB,
keeping the 25% headroom guard, process limits and all admission/authority/deadline
gates. All fourteen players started and decoded; measurement stopped RED after
57.222 s on two admission-verification requests without HTTP status. The
1,046 observations retained zero HTTP refusals/429s, two failed unknown-status
verifications, 790 accounted detail evictions and no pending overflow. The
underlying cancellation/network cause remains unproved. Latest rows precede
those failures: seven of eight contributors had positive accepted/reserved
upload accounting, two of four receivers had verified payload, and all fourteen
had frame/audio decode progress without recorded fatal/native/integrity/policy
errors. Aggregate readiness is not complete per-actor qualification.

The R4 complete M1 tree sampled at most 2,753,413,120 bytes and M4 endpoint tree
6,650,544,128 bytes, within their declared limits. All browser/context/CDP,
endpoint/controller/provider/outer group and stage cleanup passed. Actual source
cleanup v2 removed its source, retaining exit 255; a 35-check independent retained
proof audit passed, with raw remote journal bodies not independently reread.
VPN Connected was observed before and after only. No fourteen-role, two-hour,
churn or production-readiness pass follows from these partial results.

The R5 diagnostic successor retained seven status-unknown verification failures,
zero HTTP refusals and 19.404 s of measurement before stopping RED. Its first
failed request was browser-labelled aborted after 3,001 ms; the local fetch record
was cancelled after 3,004.9 ms without headers/status. The subsequent own-page
snapshot still had the same active swarm, no archived sessions, serving enabled
and fresh policy. Exact executed-code review excludes the monotonic stopped
lifecycle for this first call, leaving its three-second bounded-operation timer
as the inferred abort source. The signal reason itself was not recorded. Why
headers had not arrived, and whether all seven cancellations share that source,
remain unproved. Resources and all owned/source-v2 cleanup passed; exit 255 is
retained. The original conservative audit and separate code-inference addendum
remain distinct. No long or production-readiness pass is claimed.

R6 stopped RED after 26.930 measured seconds with twelve status-unknown
verification failures and zero observed HTTP refusals. Passive browser-network
events retained request creation and cancelled terminal events for those calls,
with no request-extra or response metadata. All ten M4 roles also retained a
failed policy or session poll, including both origin-only baselines; all four
M1 roles retained later successful policy/session polls. Separate M1 commitment
cancellations remain recorded. This broadens the observed completion gap beyond
admission but establishes no browser, queue, VPN, network or server cause. The
first later snapshot was already origin-only, so R5's timer inference cannot be
reused. All 56 diagnostic lifecycle operations acknowledged; 24 requests still
pending when observation stopped have unknown terminal results. Resource and
all owned/source-v2 cleanup passed. The linked distributed summary retains these
limits and the earlier failures.

R7 tested the same fourteen roles with M4's ten contexts split between two
independently owned Chrome profiles, five each. The combined 12 GiB/96-process
M4 cap, M1 cap, consent, authority and timing gates stayed unchanged. It stopped
RED after 13.539 measured seconds with four status-unknown verifications, all in
M4-B; M4-A had none. Both origin baselines retained late successful policy/session
polls without control failures. This establishes neither a shared failure across
both profiles nor a successful mitigation. Two failed verifications had browser
request-extra metadata, none had response metadata; wire/server arrival remains
unproved. The first later snapshot was already origin-only, leaving lifecycle
cancellation possible. Three admission observations remained pending at shutdown
(two with HTTP 200, one without status). All three profiles, resources, coordinated
actor/provider/controller/outer cleanup and separate source-v2 removal passed.
The existing long-run proposal rejects this new topology; no sustained pass follows.

The separate [desktop Safari 26.6.2 attempt](../spikes/results/f393abf-safari26-session-creation-20261014.json)
failed before application navigation: session creation reached its 14.5 s I/O
deadline, and the outer attempt ended after 18.810 s. Both HTTP workers were
reaped and the exact owned driver exited. No session ID returned, so allocation
and session deletion remain unknown. Later guarded checks proved the old
processes/socket absent; the nine-file owned scratch stage was archived, verified
and removed. No shared Safari process was signalled. The separate source cleanup
passed; a single bounded exact-driver log read found no matching events. This
does not establish a playback, codec, peer or physical-device result.

The separate [desktop Safari 17.6 attempt](../spikes/results/f393abf-safari17-startup-20261014.json)
created its session and passed resource checks, then stopped before its first
mode selection or Start command. The 32.973 s outer attempt completed no media
measurement; the individual failed readiness predicate was not retained. This
case used a separately reviewed 48-process M1 aggregate limit, retaining the
3 GiB memory cap and 25% headroom guard. Exact-session deletion, owned driver,
wire workers, both endpoint stages, provider, outer group and source removal
passed. It does not close the earlier M4 Safari 26 unknown-session result or
establish Safari media/input acceptance.

The subsequent 2dd deployed checkpoint above starts the policy and publisher-session GETs
concurrently, retaining no-store reads, two-second polling, five-second authority
from issuance and at most three pending checks. Eligible operator OFF is applied
before waiting for the session result; session/identity/admission validation and
consent rules remain unchanged. A regression using the actual compiled client,
fixture media/swarm and real loopback HTTP reproduced expiry with sequential
two-second policy plus two-second session responses, then passed with concurrent
reads. All 37 focused client/renewal/fetch tests and the maintained Chrome cache
regression passed; four HTTP races were independently rerun. Held-session OFF,
early session failure before OFF, cancellation, real-outage withdrawal and
recovery without restored consent passed. This component evidence does not
establish the cause or resolution of the public fourteen-role failures, and the
older f393 field records remain separate from the later 2dd deployment and RED checks above.

Earlier deployed `0e688470b6746b3a9afe80e1192ac4d46fa6aaea` passed all nine
required jobs on its first attempt in
[CI run 38500343145](https://github.com/forgesworn/relayswarm/actions/runs/38500343145).
Documentation checkpoint `8c09478830e80f781dd01779181174e2cf8693be` subsequently
passed [CI run 38506350320](https://github.com/forgesworn/relayswarm/actions/runs/38506350320)
without changing that deployed runtime. The following 0e observations retain their
original scope and results; f393 diagnostics do not retroactively explain them.

The ordinary four-role public short check passed playback, contribution and
verified peer payload over 60.013 s: 19 peer loads/6,285,968 bytes across both
qualities, with zero recorded stalls/fatal/native/page errors or freezes. Its
369 completed controls returned HTTP 200 over HTTP/1.1; four commitment request
aborts remain recorded. The initial wrong-Node-path invocation refused before
creating a browser and remains separate evidence.

The [180.015 s public renewal check](../spikes/results/0e68847-public-renewal-180-20261014.json)
then passed all four declared gates, including own-ticket renewal for all three
peer actors. The receive-only actor accepted 90 completed peer loads/39,608,780
bytes: 45 low/9,488,548 bytes and 45 high/30,120,232 bytes, matching donor uploads.
These are 89 unique segment contexts; one high context completed twice. Each
contributor retained one completed post-warm-up, pre-measurement stall (550 ms
low, 2,372 ms high); neither added a stall during measurement, and baseline and
receiver recorded none. Fatal/native/page errors and sampled frame freezes were
zero. A setup media abort and a nonfatal receiver abort near the quality switch
remain recorded.

First settled renewal witnesses were at 02:45:39.198 UTC for both contributors
and 02:45:59.232 UTC for the receiver on 14 October. Sampled session/stream/key,
complete peer-set and link-counter equality held around successful renewal;
each peer actor retained two connected links, two opened and zero closed.
Consent, serving, monotonic uptime and spent allowance were preserved without
reset or reconsent. These passive observations do not prove direct credential
CAS or RTCPeerConnection object identity. All 1,009 pre-cleanup controls finished
HTTP 200 over HTTP/1.1, with zero failed/pending/dropped controls; initial loading
policy-unknown samples occurred before Start. Dropdowns were programmatic;
Start/upload input was trusted. Muted native audio decode does not prove audibility.
The single-browser, four-context host/host scope does not qualify fourteen roles,
7,200 seconds/22 churn cycles, physical devices, hard NAT or financial savings.

A later cross-machine public HLS check on the same 0e revision completed
60.060 s with playback green but contribution and verified peers red. M1
contributors remained consented/serving but uploaded zero; the M4 receiver had
two outgoing dial timeouts, zero opened links and zero peer bytes, using origin
fallback. All recorded stalls/fatal/native/page errors/freezes/withdrawals were
zero. Of 323 controls, 321 had finished HTTP 200/H1 before cleanup and two pending
policy requests finished HTTP 200 later; HTTP 200 alone does not prove admission.
The observer did not retain gathering completeness, individual ICE states or
end-to-end SDP identity, so the failed phase and transport cause remain unproved.
Named evidence is `public-cross-hls-0e-analysis-20261014`.

The separate raw RTC topology comparison used literal loopback HTTP origins,
without HLS/Nostr/admission: cross-machine M1/M4 exchanged 8,192 verified bytes
each way in 5.989 s, while same-M4 single-process (fa79) and separate-process
(0e) cases transferred zero. Gathering completed in all three; ICE error 701
also occurred in the successful case. Chrome patch versions/topology differ,
so neither separate processes nor a named browser/network/mDNS/NAT cause is
established.

A separate public-origin raw M1-offer → M4-answer case then passed in 7.972 s
(`public-origin-raw-rtc-0e-20261014`). Both pages loaded the exact deployed 0e
client above and exchanged one hash-verified 8,192-byte message each way.
Gathering completed; each actual SDP contained one mDNS-form and one IPv4-form
candidate. Both applications remained unstarted, with no media, admission or
upload consent; all owned cleanup passed. A read-only receipt still showed the
M4 VPN connected at 03:14:35 UTC, with no setting changes. This single raw case
does not resolve the separate public HLS sharing red or prove an mDNS/VPN cause.
The separate reverse-direction M4-offer → M1-answer case also passed in 7.566 s
(`public-origin-reverse-raw-rtc-0e-20261014`): one hash-matched 8,192-byte message
each way, complete gathering, and one mDNS-form/one IPv4-form candidate in each
actual SDP. Both apps remained unstarted with no media, admission or upload
consent; all owned cleanup passed. These raw cases do not reproduce the hosted
HLS rendezvous/admission journey or identify its failed phase; investigation
continues.

A later instrumented restored-VPN cross-machine check passed all three gates
for 60.074 s, with 22 verified peer loads/10,151,436 bytes across both qualities
and zero recorded stalls/errors/withdrawals. Its whole-heap PC-state sampling
could affect timing. The subsequent ordinary check on the same finite source
remained red for sharing over 60.020 s: only four high loads/2,697,988 verified
bytes (three unique contexts, one completed twice), low zero. Both contributors
retained consent/serving. High's 4,038,428-byte/6-served/1-refused counters measure
accepted/reserved accounting, not verified receiver delivery or wire bytes.
All recorded stalls/fatal/native/page errors/freezes/withdrawals were zero.
Of 357 controls, 356 finished; one receiver commitment aborted after HTTP 200/H1
headers. No policy/session failure was recorded. VPN service observations were
Connected before ordinary at 04:11:36.953324 UTC and afterward at 04:17:22.016533.
These finite, sequential observations establish neither a heap-instrumentation
cause nor a VPN mechanism. Named evidence is
`independent-ordinary-restored-vpn-0e-analysis-20261014` and
`public-passive-hls-restored-vpn-analysis-20261014`.

A separate same-M4, two-process raw comparison passed in 6.517 s while the owner
had disconnected the VPN, then failed in 27.113 s after confirmed restoration.
The pass exchanged one verified 8,192-byte message each way; gathering completed
in both cases and ICE error 701 occurred even in the pass. Literal loopback
origins, no HLS/Nostr/admission, one attempt per state and owner-managed setting
changes limit the result; no sole-cause or public-HLS qualification follows.
Receipts are retained in `m4-raw-vpn-restoration-comparison-20261014`. The ordinary
run's browser/controller/provider cleanup and actual source cleanup-v2 all passed,
including 34 independent retained identity/helper/input/journal checks. This does
not upgrade raw remote journal digest claims to an independent host rehash.

All owned browsers, readers, test services and finite sources for these completed
checks are closed. Renewal source cleanup-v2 matched actual source identity,
helper/input pins and before/after journal digest claims; an independent audit
passed 29 checks. Raw remote journal bodies were not independently rehashed.
At that checkpoint the installed pilot awaited another ingest; no live source was claimed.
The earlier public reds, local fourteen-viewer admission reds and original
physical/Safari/hard-NAT/cost/7,200-second/release gates remain open.

The earlier deployed application was `fa79c2260431cf7901921fab4eaca251c4988f4b`, with
all nine required jobs green on their first attempt in
[CI run 38496983011](https://github.com/forgesworn/relayswarm/actions/runs/38496983011).
The independent permanent HTTP/1.1 proxy remains attested to EE. The new image
passed non-root preflight, clean writer drain, stable identity/lease checks and
normal-TLS attestation. Its public client is 728,551 bytes, SHA-256
`398ac43764774747fa2fa9a3d15805d66c30101057f664212c05f56cf5250702`.

The [fresh fa79 public short check](../spikes/results/fa79c22-permanent-public-short-20261014.json)
passed all three gates over 60.011 s: 30 verified peer loads and 13,206,248 bytes
across both qualities. All recorded stalls, fatal/native/page errors, freezes and
consent withdrawals were zero. All 393 completed controls used HTTP/1.1 and
returned HTTP 200. Actual deployment/source identity and cleanup-v2 helper,
input and journal provenance passed independent checks. All actors/source closed.

Its offline production-only consumer passed all ten imports, packaged demo,
installed CLI, verified separate-process native transfer and HTTP fallback.
The unpublished tarball is 867,160 bytes/191 files, SHA-256
`149eda2cea6abeb440e3a3d9a993bc2aadc302b5975dc9da79ae776be9e2eed9`.
The rebuilt standalone ESM is 114,437 bytes, SHA-256
`cb8e14ee74bf8eeaf6fbb88b9026b00de005190b23b6e7e4ceecd4d8a683b00e`.
These remain local artifacts; publication/downloaded-release checks are open.

M4 qualification remains red. The accelerated run completed 22 stop/rejoin
cycles in 91.208 s before authority expiry; a separate zero-churn steady run
stopped after 91.990 of 300 s on seven observed admission address-limit HTTP 429s.
It observed zero completed peer links/payload and healthy resource headroom.
A burst followed successful ticket renewals; the existing client rebuilt each
swarm on renewal. A raw two-context M4 RTC diagnostic also selected no candidate
pair and transferred zero bytes, without Nostr or admission. These results do not
identify a VPN, browser or transport implementation cause. All owned test
resources were removed, including a separately audited scratch-directory recovery.

The subsequent 0e source adds in-place opaque-ticket renewal and early outgoing-
capacity checks. Host identity/expiry checks, remote online admission, consent,
limits and five-second authority remain enforced. Its dated CI/package/public
renewal evidence is recorded above; fourteen-role capacity and sustained acceptance
remain open. M4 peer connectivity and the earlier admission demand failure are
not established as resolved.

The preceding deployed application and permanent HTTP/1.1 proxy checkpoint is
`ee1510d429ac85f3738c03f10a09b753ec4eb037`. All nine required jobs passed in
[CI run 38492003110](https://github.com/forgesworn/relayswarm/actions/runs/38492003110)
after one failed-job retry. The original fMP4 startup timeout remains recorded;
its cancellation owner is unproved. A preceding Windows cache-hit fixture failure
was corrected by measuring expiry renewal relative to its own baseline, preserving
the single-read and deduplication assertions. Runtime code was unchanged by that
fixture correction.

Permanent proxy commit/audit preserved the original inode and shared services.
App deployment passed the 51-file non-root preflight, clean writer drain, stable
identity/lease checks and normal-TLS client/fresh-media attestation. The image is
`sha256:b42b383fbd95bcf6628ade7d0e0acc803b1bb393e210b4c3b9b900f7737b4275`;
the public client remains 728,315 bytes, SHA-256
`c264287acad81090c8952f99946f75f844e8f5fa718e907899dc77cacf04ef59`.

The [fresh permanent-deployment short check](../spikes/results/ee1510d-permanent-public-short-20261014.json)
passed all three original gates over 60.014 s in ordinary Chrome 155.0.8059.41:
13,188,200 verified peer bytes in 30 loads, comprising 15 low loads
(3,151,256 bytes) and 15 high loads (10,036,944 bytes). Both contributors retained
consent/serving. Fatal/native/page errors and sampled frame freezes were zero.
The high contributor retained one 143 ms stall before measurement; no new stall
was recorded during measurement. All 405 completed fixed-route CDP responses
used HTTP/1.1. Dropdowns were programmatic; Start/upload clicks had trusted
witnesses. Browser/provider/group cleanup and exact finite-source removal passed.
This short desktop result does not close sustained, physical/NAT or cost gates.

A separate fourteen-viewer M4 qualification remains red. The fresh 300 s attempt
stopped after 98.945 s when admission HTTP 429 responses prevented ticket renewal
and authority expired. Policy/session responses stayed fast. Summed RSS peaked at
8,987,213,824 bytes below its declared 12 GiB cap; all 13 memory-pressure probes
reported at least 80% free. Summed RSS is not unique physical memory. The earlier
8 GiB resource-stop result is retained separately. Admission heartbeat traffic
and the shared-address limiter are under investigation; no limiter or authority
deadline has been relaxed. All owned qualification resources were removed.

The loader now skips redundant admission requests for unchanged credentials on
connected/dialling peers and for unknown peers while full or cooling down.
Changed credentials on active peers still refresh. Every SDP/retry and served
object retains its online admission check; no positive-authority cache is added.
The new source requires fresh cohort and deployment acceptance before this
qualification failure can be considered resolved.

Fresh offline consumption of the deployed head passed ten imports, packaged demo,
installed CLI, separate-process verified native transfer and HTTP fallback. Its
unpublished 190-file tarball is 859,013 bytes, SHA-256
`575e443e3bbe73fa811151ff8ae73c421067e65fa653faeb3523eaf226ec5490`.
The unchanged standalone ESM hash is recorded below. Downloaded-release acceptance
and v0.2.0 publication remain pending.

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

## Earlier bb90 checkpoint and no-store regression

The earlier deployed checkpoint is source
`bb90bd6a54cabc163846ee1737ac3fe28b63eaa2`. All nine required jobs passed in
[CI run 38478501111](https://github.com/forgesworn/relayswarm/actions/runs/38478501111);
the optional long soak was skipped. Fresh offline production-only consumption
passed all ten documented imports, exact packaged demo/renewal/recovery bytes,
the installed CLI and independent-process verified native transfer plus HTTP
fallback. The unpublished tarball contains 188 files, is 837,701 bytes and has
SHA-256 `7358efafe3e3332d749e8ea515a70d8d2e8b8bb5721f97d2054e962170dce49e`.
The standalone ESM is 114,201 bytes, SHA-256
`01de11837fbd08098bf98b6e8be945866ef766f76629030fec89de2318170d19`.
These local candidates do not prove downloaded-release acceptance.

The guarded app-only deployment passed exact archive-byte verification, a
51-file UID-1000 no-network/no-state-mount image preflight and a clean drain
with all scoped old writers gone. Stable publisher identity, private lease/token
metadata, shared services and the active TCP-only proxy configuration were
preserved. The actual image is
`sha256:1e63daaf47dd4e41cd28713838112e816a679a6017d1d440ce9e70a7a400a592`;
its app started at 22:49:26.883960902 UTC on 13 October. Normal-TLS public client
bytes matched SHA-256
`25a8416911bc51b1f6764a784d4444295db02c12396c59ddd82450bf56fff58c`
(728,262 bytes), both fresh playlists passed and reporting stayed off.

The subsequent ordinary four-role Chrome 155.0.8059.40 public check measured
60.010 s. Requested video/native-audio decode passed with zero fatal, native
or page errors in every role; each contributor retained one stall. Both
contributors uploaded zero bytes and the receiver verified zero peer bytes,
so contribution and peer acceptance remain **red**. Trusted input enabled both
upload controls, and recorded contributor rows stayed visible/focused. Their
withdrawals closely matched the last completed renewal's issuance plus the
five-second authority lifetime. Later overlapping policy requests showed about
three seconds of delay before send and completed too late to preserve authority.
This supports expiry as the withdrawal boundary, without a captured reason code
or a proven cache, protocol, transport or host cause. The initial cancelled
requests had no response, extra-info, protocol or send timing; successful
neighbours used reused HTTP/2. A later admission-verification cancellation
occurred after withdrawal and cannot explain its onset.

Named receipts are `artifacts/public-cdp-bb90bd6-r3-analysis-20261014/analysis.json`
and `artifacts/public-cdp-bb90bd6-r3-run-20261013/wrapper-receipt.json`.
The public-safe analysis manifest SHA-256 is
`bd2d5ad098ca639f83398aff5a8b4b23994817b67a892d723193439fd439c926`.
Browser/provider cleanup passed. The observer intentionally did not remove
Root's finite source; separate guarded cleanup passed in
`artifacts/public-m4-phone-source-bb90bd6-preparation-20261013/host-cleanup.json`.
This short desktop check does not close sustained, physical, hard-NAT or cost
gates. v0.2.0 publication and downloaded-release acceptance remain pending.


A separate local real-HTTP comparison on 14 October held the first policy
response before headers. With the default client, the next identical-URL
request reached the server after 5,002 ms and consent expired. An in-memory
no-store comparison reached the server after 2,001 ms while the first request
was still held, preserving consent and serving. Both retained the original
five-second request timeout (5,000.4/5,000.8 ms observed). Ordinary Chrome,
trusted native controls and real server arrival evidence were used, without
route interception, cache flags, fake media or permission overrides.

The supported production change adds `cache: 'no-store'` to three authoritative
policy/session fetch calls; authority lifetimes, request deadlines and admission
checks are unchanged. Prepared client SHA-256 is
`b0bc1f84f9c24cdf210bbfdfec9eb25cbfdd07521fad0b43c90f299c66b8b2b8`.
The comparison receipt is
`artifacts/policy-cache-lock-20261014-run-r2/receipt.json`; its original failed
setup and the earlier maintained-harness result remain separate. This establishes
a local identical-request scheduling defect and a supported correction; it does
not identify why the initial public request had no response. The final corrected
maintained regression passed: later policy/session requests reached the real
server after 2,000/2,001 ms while their predecessors were held. Full 503 outage
expired authority and cleared consent; restored policy left consent off. Root's
combined suite exited zero with eight existing operator checkpoints, 117
publisher tests passed/one skipped and syntax checks for 105 modules. Source and
evidence hashes were rechecked unchanged in
`artifacts/policy-cache-integration-20261014/validation.json`. Browser/demo/relay/
media closes were awaited; no independent kernel inventory was captured.
The later exact-2e1 CI, package and deployment gates are recorded above.
The earlier bb90 contribution result remains red, and the no-store regression
does not close the later ordinary public sharing gate.

The earlier candidate checkpoint is source
`cee92281b20aa5e60fc39d0e0cb2a368daa83747`. All nine required jobs passed in
[CI run 38471147105](https://github.com/forgesworn/relayswarm/actions/runs/38471147105);
the optional two-hour soak was skipped at this head. Fresh offline,
production-only package consumption passed all ten documented imports including
metadata, exact packaged demo/recovery bytes, the installed ICE CLI and actual
separate-process native delivery of 131,097 verified bytes. Native delivery used
zero HTTP origin requests; peer absence then produced one verified loopback
origin fallback. Owned services and scratch were removed, and HEAD stayed clean.
The tarball contains 186 files, is 823,201 bytes and has SHA-256
`b847aa0d57f68975aa69bdc70589f1aa5066b757e748001ccb7bb967853a3d3a`.
The standalone ESM candidate is 114,201 bytes, SHA-256
`01de11837fbd08098bf98b6e8be945866ef766f76629030fec89de2318170d19`,
with the expected five exports, no external imports and a successful local
import/off-mode check. These are local candidate artifacts, not published or
freshly downloaded release assets.

At the cee checkpoint, all 48 runtime/package/lock inputs were unchanged from
f999 and 6b2; the six browser inputs and resulting ESM bytes were identical. The preceding 6b2
Ubuntu job's native suite passed 17 tests but its publisher fixture failed a
server-relative body timing assertion. That original CI red is retained. The
narrow test-only correction holds the real HTTP body after client header
observation and preserves the timing assertions, including an 80 ms delayed
client continuation. The cee checkpoint does not replace the deployed f999
application or close its sustained public contribution/device/cost gates.

The earlier verified public pilot checkpoint used source
`f9990b36956282f3d4e849b55bd64a79eb440151`, whose nine required jobs passed in
[CI run 38449139246](https://github.com/forgesworn/relayswarm/actions/runs/38449139246).
Its image is `sha256:20199491827b9ea69ac560ac50be5eed5376aab30fbd0a07227544ce8898b243`;
its public client SHA-256 is
`b746f45216d3ac6e5d1bd21b5748f91c0115c71d00ee678c930070596bbef50d`
(723,954 bytes). Normal public TLS, both fresh rendition playlists and retained
publisher identity were verified. The image permission challenge extracted
public directories as 0700 and files as 0600, then proved all 50 copied files,
module imports and actual entry-point help readable by UID 1000 without network
or state mounts. The permanent Dockerfile defence normalises copied public
runtime permissions while leaving private state untouched. Clean production-only
package consumption and the standalone ESM candidate also passed locally.
These facts bind the f999 application snapshot. A later proxy-only change was
validated with the pinned Caddy 2.11.7 binary and reloaded in place: the TCP-only
overlay now enables HTTP/1.1 and HTTP/2 and returns `Alt-Svc: clear`. Fresh normal-TLS
checks passed for both protocols with the same client identity. The Caddyfile
inode, app/router/proxy container identities and mounts remained unchanged; no
UDP 443 listener remained and the rollback watchdog was reaped. This corrects an
unavailable HTTP/3 advertisement; it does not establish the cause of previous
policy timeouts. The cee candidate CI and local package/bundle gates above
are green; v0.2.0 publication, fresh downloaded-release consumers and final
exact-source deployment acceptance remain pending.

The earlier `768a3a4f20d91bf2194513181354be70f6a8e5da` passed nine required jobs in
[CI run 38439565770](https://github.com/forgesworn/relayswarm/actions/runs/38439565770).
Its first image failed before startup because archived public directories were
unreadable by UID 1000. Explicit audited rollback restored the previous image
without deleting state or fences; the corrected image passed its non-root
50-file/import/entry-point preflight before replacement. Source
`a0231aadcdd81fe67fe702ac7214042d196eb39f` passed ten jobs, including the optional
two-hour soak, in
[CI run 38392804791](https://github.com/forgesworn/relayswarm/actions/runs/38392804791).
Each result retains its original tested source.

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

A later f999 public ordinary-Chrome observer measured 60.008 s and passed its
three separate gates: video/native-audio decode at the requested qualities,
both explicit contributors remaining serving, and verified receive-only peer
payload at low and high. Contributors reserved 3,151,256 and 8,106,372 media
bytes; the receiver accepted 10,576,128 bytes in 26 verified loads with zero
upload. Fatal/native/page errors and stalls were zero. No fake media, permission,
mDNS, RTC or TLS overrides were used. This short same-laptop `host/host` result
does not close the deployed two-hour gate. The preceding public contribution red
and first diagnostic observer's receipt-file race remain preserved separately.

The next f999 public two-hour attempt was stopped incomplete after 644.855 s
whole observer lifetime and 611.134 s measured, rather than 7,200 s. High
contribution failed during warmup: `/delivery-policy.json` started at
20:18:17.082 UTC, returned no observed headers or body, and was cancelled by the
existing five-second deadline. At 20:18:22.308, the own DOM showed policy
unavailable, upload unchecked and origin fallback. At 20:18:24.323 the policy
was available again, with upload still unchecked. No reconsent or quota reset
was applied. The request is the demonstrated withdrawal trigger; aggregate
server windows showed fast handler work, but cannot establish whether this
individual request reached the app or identify transport, proxy or browser
scheduling as the cause. Partial video/audio progress and zero fatal/native
errors/stalls were retained; the receiver accepted 60,508,176 low-quality peer
bytes. There was no measured high receiver phase or completed sustained pass.
The first source-expiry refusal created no Chrome actor. All owned sources,
browser groups, profiles and readers from these checks were subsequently
removed/stopped with guarded receipts; the pilot awaits its next ingest.

A subsequent public Chrome check after the proxy change measured 60.120 s.
Video/audio decode passed; contribution and peer payload at both qualities
failed. A five-second session fetch cancellation withdrew high contribution
during warmup, and a later policy cancellation withdrew low contribution.
The receiver accepted 2,731,076 low-quality peer bytes in 13 loads, with no
upload or verified high-quality loads. Fatal/native errors were zero; stalls
were 1/2/0/1 across low/high/origin/receiver. The requested private NetLog capture
was empty, so protocol and queue attribution remain unavailable. All owned
browsers, readers and the finite source were stopped/removed. The independent
proxy correction does not close sustained contribution or identify the cause.

The subsequent passive CDP observation of f999 measured 60.015 s: playback
passed, contribution and verified peer payload failed. Both contributors
uploaded zero bytes, the receiver accepted zero peer bytes, fatal/native errors
were zero and high recorded one stall. The first policy requests at
22:05:38.226/22:05:38.230 UTC cancelled about five seconds later without a
response or response-extra-info event, even after cleanup. Adjacent successful
responses reused HTTP/2; the failed requests' protocol remains unknown.
Nearby server windows recorded eight completed policy requests with at most
2.2 ms app header work, without an individual request identity match. Browser,
provider and source cleanup passed. The transport/queue cause remains unproved;
the later renewal-resilience candidate is not deployed by this observation.

The renewal-resilience implementation keeps unexpired policy
and admission authority during one transient refresh cancellation. It stops
serving when that authority expires; a later successful refresh leaves upload
consent off. The maintained local Chrome operator regression recorded a
5,000.8 ms policy cancellation while all 63 observations retained consent and
serving, with 461,352 uploaded bytes and unchanged quota accounting. A full
503 outage expired authority and stopped serving; later recovery did not
restore consent. Eight operator checkpoints, 25 focused tests and syntax
checks for 103 modules passed; the publisher suite passed 117 tests with one
skip. This loopback fixture uses its existing fake WebRTC permission/media
flags and does not prove public, physical or NAT behaviour. Normal exit followed
all close awaits; no separate kernel process inventory was captured. The
bb90 committed-source CI, package and guarded deployment passed as recorded
above; its public contribution/peer gate and the historical f999 failures remain
open.

A separate TCP TURN test accepted 224,096 signed, verified media bytes in two
segments during 5.036 s. It used actual temporary browser credentials and a
forced relay policy over an operator-owned SSH TCP forward to the relay host's
self-routing fixture. It was a data-channel simulation with a local publisher,
not direct Internet TURN, hard-NAT or physical playback proof. The browser
receipt passed, while the original controller cleanup stayed red; a later
explicit root audit verified fixture/container/credential/listener removal and
unchanged project services/firewall rules. An observed existing firewall set
membership difference was retained without a proven expiry cause.

An installed Firefox 152.0.6 public journey with ordinary Chrome contributors
passed verified receiving/uploading, quality and seek, durable quota across
reload, fresh consent and origin-only kill. Its pre-reload checkpoint recorded
2,524,652 received peer bytes and 219,020 uploaded bytes. No fake media or
permission overrides were used. The corrected visible Safari 26.6.2 journey
played video without reported media errors but received zero verified peer
payload within 45 s despite five RTC links; its complete peer journey remains
red. The earlier Safari journey's peer bytes and later pause are retained
separately and do not close that gate.

A later physical Pixel/Vanadium check against f999 passed actual origin frames
at low and high quality, seek and background/resume. Uploading stayed off, the
existing UDP privacy policy was unchanged, and the owned phone access was closed
by 20:12:38 UTC. Peer payload was zero because no contributor actor was available
for that check; peer acceptance is unmeasured. Its raw overall receipt stays
false and the earlier default/temporary-policy peer reds are retained.

Physical Pixel/Vanadium peer acceptance from the earlier tests remains red. A separately authorised
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
audio after only a video SourceBuffer existed. The earlier one-shot repair
recovered through the alternate rendition in 603 ms. A constructed single-variant
VOD then reproduced the same low-only failure: resetting MSE immediately reloaded
the video-only prefix and failed again. The next repair waits for the actual media
attachment, then resumes at the validated failing fragment. Exact unchanged low
bytes recovered in 403 ms with 60 decoded video frames and 4,206 decoded audio
bytes; the original fatal error remained. Uploading/reporting stayed off and the
spent allowance stayed at 1,234 bytes. The maintained browser regression uses
those synthetic bytes. This supported case differs from the original failing
live window, whose missing bytes still prevent a causal claim.

The diagnostics/CLI source passed 95 publisher tests with one opt-in skip and
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
before a browser started; later inspection found no resources from that
interrupted attempt. The subsequent deployed 768 reporting check passed with
ordinary Chrome, normal TLS and trusted Start/reporting opt-in. The numeric
measurement survived a real same-volume process restart; exact duplicates
preserved totals and acceptance time. Its entry remained at age 295,610 ms and
expired naturally at 301,767 ms. Reporting-off restoration, original policy,
lease inodes and temporary-source cleanup passed. No clock, timestamp or retention
override was applied. The first red attempt's cause remains unknown. The
[later acceptance summary](../spikes/results/recovery-reporting-acceptance-summary-20261013.json)
records the separate source and scope of these results; the earlier
[investigation summary](../spikes/results/control-path-media-investigation-summary-20261013.json)
remains unchanged.

The [13 October acceptance summary](../spikes/results/current-source-acceptance-summary-20261013.json)
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
