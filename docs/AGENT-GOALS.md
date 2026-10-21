# RelaySwarm goals and agent handover

Snapshot: 19 October 2026. Repository: this checkout.

## Assignment

Finish the agreed production work, verify it against the acceptance requirements,
and ship RelaySwarm 0.2.0. The owner asked to get the work finished and into
production. Preserve the full P01–P12 scope below; do not declare completion
because implementation, CI or deployment passes alone.

RelaySwarm provides peer-assisted HLS: browsers exchange hash-verified media over
WebRTC, use Nostr for rendezvous/signalling, and retain HTTP fallback. A separate
installed Node path uses HyperDHT/Noise. Optional RTMPS forwarding to YouTube is
a broadcaster output, separate from viewer peer delivery.

Read [AGENTS.md](../AGENTS.md) before working. Use the
[delivery checklist](PRODUCTION-READINESS.md#delivery-checklist) for the full
acceptance requirements and [production features](PRODUCTION-FEATURES.md) for
implemented behaviour. This handover records a newer deployment than the
`3f706a9` current-checkpoint prose in those guides. Reconcile that prose after
reviewing the newer evidence; retain the historical failures.

## Starting position

The agreed source feature surfaces are implemented. **Production acceptance and
the 0.2.0 release are incomplete.**

| Item | Position at handover |
|---|---|
| Branch and source | `feat/broadcaster-pilot`, `46494d5acba88654cf7a93aaa26685bce25467e2`; this handover is a later documentation edit |
| Pull request | [PR 8](https://github.com/forgesworn/relayswarm/pull/8), open and unmerged; head verified when writing this handover |
| Required CI | All nine jobs passed on that exact source in [run 39180173046](https://github.com/forgesworn/relayswarm/actions/runs/39180173046); optional soak was skipped |
| Package consumption | Fresh install/import, native transfer/HTTP fallback, ledger and browser bundle checks passed; 283 package members |
| Pilot | Last deployment record: source `46494d5` on Till at `https://relayswarm.forgesworn.dev`; HTTPS client hash and two fresh playlists matched |
| Deployment cleanup | Deployment lifecycle and its local finaliser passed; separate fresh post-cleanup review is still pending |
| Pilot account support | Nostr enabled; authenticated host-supplied account API implemented, with no website resolver configured |
| Pilot reporting and forwarding | Both off after the recorded deployment |
| Public release | Only v0.1.0 experimental prerelease is published; 0.2.0 is a source candidate; no npm publication |
| Swift client | RelaySwarmKit v0.5.0 published with wire-v3/signed-media interoperability; physical Apple/public-NAT interoperability remains unproved |

The deployment entry above comes from retained execution records, not a fresh
host observation during this write-up. Recheck runtime and resources before
running another acceptance test.

## What has been built and verified

- Browser peer-first and shadow loaders, signed exact-context commitments,
  encrypted browser signalling, bounded peer work and HTTP fallback.
- Live ingest producing two HLS renditions, persistent publisher identity,
  supervised encoders and optional TLS-verified RTMPS forwarding. The authorised
  private YouTube test was completed and deleted; its keys were removed.
- Broader supported HLS media, delegated signing, signed stream advertisements,
  admission tickets, revocation and operator controls. Supported-media limits
  remain explicit in the feature guide.
- Persistent browser upload allowances and an optional private shared-account
  ledger. Both Nostr and a host-supplied authenticated account API are required
  and implemented. No named website integration or human wallet is required.
- Durable, idempotent, explicitly opted-in numeric reports. The real-browser
  reporting check passed on `3f706a9`, including same-volume restart and natural
  expiry after 304.105 seconds; repeat it on the new candidate as described below.
- Permanent publication/worker leases, guardian cleanup and guarded recovery;
  installed native transfer with verified HTTP fallback; protocol fixtures and
  independent Swift SDK/browser journeys within their recorded scope.
- The latest fix bounds established-live playlist HTTP 502/503/504 recovery to
  one 60-second episode and preserves an origin-only player across an admission
  epoch change. Final focused suites passed 141 tests and 21 full-controller
  tests. Real Chrome passed recovery after a 35-second outage, cancellation and
  deadline failure. Actual deployed parent-crash playback still needs retesting.

These results have different scopes. Loopback, simulator, unit, package and CI
results do not establish physical-device, difficult-network or sustained-load
acceptance.

## Goals and completion criteria

| ID | Goal | Evidence still needed or responsibility to preserve |
|---|---|---|
| P01 | Reliable live-edge peer delivery and quality changes | Matching short and sustained field qualification, every receiver obtaining verified peer media at both qualities, and a paired origin baseline |
| P02 | Playback recovery without hiding failures | Preserve reproduced media regressions and fatal records; repeat concurrent hosted playback, including the deployed restart journey |
| P03 | Supported wider HLS media | Preserve exact-context/media tests; complete the outstanding browser/device coverage of the supported subset |
| P04 | Admission and bounded adversarial work | Preserve tickets, revocation and exhaustion tests; qualify the selected field profile within its original resource limits |
| P05 | Durable operational measurements | Repeat trusted opt-in, idempotence, restart persistence and natural expiry on the current candidate; restore reporting off and verify cleanup |
| P06 | Persistent and shared upload budgets | Complete the original 3 MB both-quality/exhaustion and account lifecycle trial; preserve reload/tab/device spend, failure handling and fresh upload consent |
| P07 | Safe broadcaster crash recovery | Pass actual parent termination, writer audit, guarded recovery, stable identity/state/leases and decoded/audio playback after restart within the original bounds |
| P08 | Delegated signing and advertisements | Preserve scope, expiry, revocation and signed live/ended tests; document caller-owned author trust and revocation freshness |
| P09 | Installed native delivery | Preserve independent-process native/fallback and clean-consumer checks; verify the final downloaded release assets |
| P10 | Protocol compatibility | Preserve wire-v3/schema conformance and independent SDK journeys; complete physical/public-network integration evidence under P12 |
| P11 | Release and production deployment | Final-source required CI and consumption, completed field gates, merge/release, immutable checksums/assets, downloaded-asset verification and deployment/readback |
| P12 | Real-world acceptance and benefit | Remaining physical Android/iPhone, Safari/Firefox, separate-network/hard-NAT, sustained/churn/TURN-expiry and matched wire/cost checks |

No separately completed 37-item review ledger has been located. Do not turn old
references to 37 review items into a claim that such a ledger is complete.

## Progress on 19 October 2026 (after the snapshot above)

Steps 1 to 3 below are complete on source `46494d5`, pilot on Till, M1 browser
host. Each has an actor result and a separate independent review.

| Step | Verdict | Evidence |
|---|---|---|
| 1. Deployment cleanup review | PASS, fresh Till read 07:05:32 UTC | `artifacts/independent-deployment-46494d5-review-20261019/review.json` |
| 2. P05 reporting lifecycle | Actor pass 379 s; natural expiry 304.4 s; reporting restored off. Independent OWN review PASS | `artifacts/p05-46494d5-run-r2-20261019/`, `artifacts/independent-p05-46494d5-positive-own-review-20261019/review.json` |
| 3. P07 parent crash | Actor pass 122 s; kill to healthy 24.6 s; Root marker decision 9.2 s; both qualities decoded video and audio on new continuity. Independent native review PASS | `artifacts/p07-46494d5-run-20261019/`, `artifacts/independent-p07-46494d5-positive-native-review-20261019/review.json`, `artifacts/p07-46494d5-outage-timeline-20261019.json` |
| 4. Short qualifier R57 | RED before any browser: M4 endpoint died at launch. Harness locale fault, see below | `artifacts/distributed-fourteen-qualifier-46494d5-r57-diagnosis-20261019.json` |
| 4. Short qualifier R58 | RED in setup, zero measurement: all 14 roles started but the fixed 90 s setup deadline expired 10 s after the last start | `artifacts/distributed-fourteen-qualifier-46494d5-r58-run-20261019/`, `artifacts/distributed-fourteen-qualifier-46494d5-r58-setup-diagnosis-20261019.json`, `artifacts/distributed-fourteen-qualifier-46494d5-r58-root-cleanup-check-20261019.json` |
| 4. Short qualifier R59 | RED after 304.4 s of measurement: setup passed (82.5 s); 15 of 16 gates pass; `each4BothQualityPeer` fails, as in R54. Receivers 1 to 3 obtained peer media only at low quality | `artifacts/distributed-fourteen-qualifier-46494d5-r59-run-20261019/`, `artifacts/distributed-fourteen-qualifier-46494d5-r59-result-20261019.json`, `artifacts/distributed-fourteen-qualifier-46494d5-r59-path-monitor-20261019/` |

Pilot app after P07: `124e3bcc…`, started 07:27:09 UTC, reporting and forwarding off.
Docker reports it `unhealthy` whenever no test source is ingesting; the health
check requires a publication within 45 seconds, so this is the idle state.

Findings for the next agent:

- **Harness locale fault (R57).** `owned-chrome.mjs` `identity()` parses
  `/bin/ps -o lstart=` with a US-order regex and runs raw `ps` on M4. macOS
  `ssh` forwards `LANG`; with `en_GB.UTF-8` M4 prints `Mon 19 Oct …` and the
  endpoint throws before writing any receipt. Launch qualifier drivers with
  `LANG=en_US.UTF-8` and no `LC_*` overrides (verified on M4). A code fix such
  as pinning `LC_ALL=C` for that `execFile` would change frozen pins and needs
  its own review cycle. R57's leftover M4 stage was removed by Root after
  identity, nonce and live-process checks, not by an independent review.
- **Setup slowdown (R58).** R54 on `3515d5b` started all 14 roles in 35 s;
  R58 took 80.6 s and R59 71.5 s. The observer runs on M4, so M1 load cannot
  slow the M4-only viewer phase. Per viewer, page creation and load took about
  1 s in R54 against 2 to 8 s in R58 and 2 to 6 s in R59; click to ready rose
  similarly. The setup read pass stayed under 0.7 s, control request rates are
  unchanged, Till was idle and sent less than in R54, and the new playlist
  retry acts only on failed loads. Earlier "2 to 4 times slower" figures were
  per-role maxima; netlog medians for R58 were 1.2 to 1.6 times R54.
- **Network environment (R59 path monitor).** M1 and M4 both use Wi-Fi and
  route all default traffic through a full-tunnel VPN. During R59,
  M4's TCP connect median to the pilot rose from 38 ms to 94 ms in setup and
  101 ms in measurement (90th percentile about 240 ms), then returned to 37 ms
  after the run; M1 rose from 40 ms to 54 ms. This was measured on one run and
  is consistent with the run's own traffic congesting the path, mostly on M4,
  which hosts 11 browsers. Relay-only TURN over TLS/TCP sends peer traffic
  between browsers on the same host out through the VPN and back. Changing the
  VPN or wiring is the user's decision; launch gates and the external path
  monitor are recorded in the R59 authorisation and result.
- **Both-quality receiver gate (R54, R59).** Contributors served for the whole
  window without budget limits, but R59 uploaded 182 MB against 15.4 MB of
  verified peer receipt. Against R54, receivers had far more expired waits
  (38 to 54 against mostly 10 or fewer), more no-budget decisions and fewer
  segments obtained after waiting. R43 on `7d7f676` had similar expired waits
  and passed, so these counts do not decide the gate.
- **The gate is marginal on every complete run.** It passed in 2 of 9 runs
  that completed measurement (R16, R43); R43 and R50 ran the same source and
  split. Receivers got 1 to 59 of about 170 segments from peers, and all
  viewers 1.7 to 5.5 per cent of bytes. Per-request records show completed
  high-quality transfers at 4 to 7 Mbit/s in 0.9 to 1.4 s, but most requests
  start with only 0.6 to 1.0 s left of a budget capped at 1.5 s
  (`originFallbackMs`; the demo does not override it), because a holder must
  first fetch the segment from origin. No high request starting with under
  900 ms left completed (0 of 217 in R54 and R59). A timed-out response still
  arrives in full, since the link protocol has no cancel: in R59 about 155 MB
  of the 167 MB of unused upload was abandoned responses, sharing the uplink
  and relay with useful transfers. Receiver 3 started high and had no high
  peer segment in its first 150 s, so this is not a switch-timing artefact.
  A network change can shift the odds but not make high-quality peer delivery
  reliable. Levers and costs, including a read-only UDP probe of the relay:
  `artifacts/both-quality-peer-gate-diagnosis-46494d5-20261019.json`.
- **Peer request floor, local commit `5ae817d`, not pushed.** Peer selection
  keeps the sizes and payload rates of the last 16 completed transfers on any
  link; the loader goes to origin, counting `segments.peerSkippedLate`, when
  the time left is below what the fastest completion at least as large would
  need for the committed size. Smaller completions never limit a larger
  request, since a low-only history would otherwise block every first
  high-quality request; without such a completion there is no limit. It stops
  requests that could not finish and their wasted upload. It gives high
  transfers no more time, so a requalification on this source alone would
  most likely still fail the both-quality gate; any gain from less congestion
  is unproved. On M4 the swarm suite passed 178 of 178, and Chrome playback
  and the account journey passed (the first version also passed all four
  operator cases); a mutation check showed the loader test depends on the
  floor. A demo cap of 3000 ms for `originFallbackMs` was tried and dropped:
  it stopped peer delivery in the loopback account-budget journey twice, for
  a reason not identified, while the floor alone passed. The qualifier
  projection does not record `peerSkippedLate`. A new source needs CI,
  deployment, the deployment review, P05, P07 and a rebuilt qualifier before
  any field result. Evidence:
  `artifacts/peer-floor-91357aa-local-tests-20261019/SUMMARY.json`.
- **Cancel and smaller send buffer, local branch `fix/peer-cancel`, not
  pushed.** Two commits on `5ae817d`, made in a scratch worktree:
  `51d992d` (a receiver that starts draining sends `{"t":"cancel","id":n}`; a
  holder declines with `none` before `meta` or stops at its next chunk and
  sends EOF early; a short EOF is accepted only after sending cancel; holders
  count `bytes.uploadsCancelled` and `bytes.uploadCancelledBytes`, with no
  refund of charged allowance; `docs/NIP-DRAFT.md` and `INTEGRATION.md`
  updated) and `4178c26` (a holder queues more only while at most 128 KiB is
  waiting, resuming at 32 KiB, instead of 1 MiB and 256 KiB; without this a
  670 KB high segment was queued in one pass and a cancel had nothing left to
  stop). The Swift kit (`relayswarm-kit` 2f0b26a) is receive-only and never
  serves, drains or cancels. On M4 all suites passed, including real-Chrome
  peer-first with no loss of peer share; loopback peers never timed out, so
  cancel itself is proved only by unit and loader tests. Mutation checks
  covered each path. The qualifier observer records only `totals.uploaded`;
  measuring the saving in the field needs the rebuilt qualifier to keep
  `bytes.uploadCancelledBytes`. Evidence:
  `artifacts/peer-cancel-4178c26-local-tests-20261019/SUMMARY.json`.
- **`4178c26` cycle, in progress (user approved, 19 October).**
  `feat/broadcaster-pilot` was fast-forwarded to `4178c26` and pushed at
  16:18 UTC. CI run 39284440433 passed all nine required jobs (optional soak
  skipped) during a GitHub Actions incident:
  `artifacts/ci-4178c26-39284440433-20261019/ci-terminal-success.json`. Fresh
  consumption PASS (archive `a9b98c50`, package `f82ca82a` with 283 members,
  demo client 777134 B `a8d22a0b`, TMPDIR removed), from an exact-binding
  rebase of the executed 46494d5 helpers:
  `artifacts/clean-consumer-4178c26-20261019/package-review.json`.
  **Deployed 16:54 UTC, local closure PASS.** App `db17ed0f` (revision
  4178c26, image `faa4520b`) replaced `124e3bcc`; the public client is the
  consumer build (777134 B, `a8d22a0b`); profile unchanged. The packet is an
  exact rebase of the executed 46494d5 deployment with one appended typed
  guard branch for the positive P07 handover (kind
  `P07-parent-crash-finite900-app-transition-v1`, validated by the reviewed
  qualifier `p07_prerequisite.py`) and its intake test (6 of 6). The
  inventory went 62 to 62 with three changed `src/browser` files. Live
  `operator.json` and `account-budget.json` inodes had changed by atomic
  replacement since P07, which the guards permit; the four lease inodes were
  unchanged. Result:
  `artifacts/deployment-4178c26-peer-cancel-result-20261019.json`.
  **Independent post-cleanup deployment review PASS** (17:00 UTC, one
  1.7 s read-only Till read, 116 pins, six predicates):
  `artifacts/independent-deployment-4178c26-review-20261019/review.json`.
  The first preparation refused at a missed literal before creating any
  output (`artifacts/deployment-cleanup-review-4178c26-prepare-attempt1-20261019.json`);
  the r2 packet fixed it. **P05 attempt 1 RED (17:04 to 17:06 UTC).** The
  worker stopped after ten exchanges with an AssertionError consistent with
  a torn read of `request.json` (the actor replaces it by atomic rename while
  the worker polls it with an identity check); the 4178c26 code is not
  involved. Restore and cleanup ran: reporting is off, the P05 control
  directory is gone, browser cleanup is complete, the lease inodes are
  unchanged, and the live app is now `7ff2b4ec` (same image). Because the
  run replaced the app, a plain rerun would refuse; the reviewed P05 schema
  accepts the failed partial run as a `p05-owned-journal-v1` predecessor
  after an independent cleanup review. Record:
  `artifacts/p05-4178c26-root-run-attempt1-20261019.json`. **P05 r2 PASS
  (17:21 to 17:28 UTC, 385 s of 540 s).** Attempt 1 was closed by an
  independent cleanup-only review (PASS, reporting acceptance false) and
  bound as a typed `p05-owned-journal-v1` predecessor through one new runner
  path; the actor is byte-identical to attempt 1. A torn-read retry for the
  actor was prepared and dropped because the original method-protection
  test forbids changing the worker lifecycle. Natural expiry 304 s,
  telemetry restored false, 44 host operations, live app `de1e594d`.
  Independent review PASS with reporting acceptance true:
  `artifacts/independent-p05-4178c26-positive-own-review-20261019/review.json`.
  **P07 attempt 1 RED and pilot outage 17:29:58 to 18:44:08 UTC.** The run
  reached operator-decision after the parent crash and waited for a root
  recovery authority that was not placed (no watch was running); it ended
  without restarting. With the user's choice, the pilot was restored by a
  guarded operator recovery outside the expired window: fresh complete
  writer audit, the reviewed `explicit-marker-recovery.mjs` under all four
  leases (dirty marker and v2 lock removed, leases and publisher state
  preserved), app recreated from its own compose files with `unless-stopped`.
  Live app `59ba62eb` (4178c26, image `faa4520b`), lease inodes unchanged,
  public `/` 200 waiting page (no source running). Records:
  `artifacts/p07-4178c26-root-run-attempt1-20261019.json`,
  `artifacts/p07-4178c26-operator-recovery-20261019.json`. Because the live
  app no longer descends from any harness proof, every next harness run
  (P07 r2, P05 or the qualifier) needs a typed handover for this recovery
  before it can start. The R61 qualifier preparation is built
  (`artifacts/distributed-fourteen-qualifier-4178c26-r61-preparation-20261019`,
  identity rebase plus a labelled observer field for the cancel counters;
  two stale topology test cases fail identically on the 46494d5 base) and is
  not yet bound. Steps that need a clean
  checkout stash the handover docs and restore them by checksum.
  **P07 r2 prepared (recorded method change, user-approved).** A new typed
  handover `p07-negative-operator-recovery-transition-v1`
  (`artifacts/parent-crash-p07-4178c26-r2-source-preparation-20261019`,
  index `112351af…`, record `OPERATOR-RECOVERY-HANDOVER.json`) replays
  attempt 1 and the operator recovery from 26 pinned files and moves only the
  app namespace and restart policy to `59ba62eb`; the P05 tuple stays exact.
  Changed: new `current_handover.py`, the P05 wrapper, tests and resealed pure
  pins; actor, host protocol, observer and all bounds are byte-identical.
  Pures 14/14 (`artifacts/p07-4178c26-r2-pure-20261019/RESULTS.json`), each
  of 34 per-fact refusals checked to fail on its own line. Attempt 1 left its
  Chrome profile and child temporary roots on disk (receipt cleanup `{}`);
  they were removed under an identity check
  (`artifacts/p07-4178c26-attempt1-browser-root-removal-20261019.json`).
  Driver r2 (`artifacts/p07-4178c26-root-driver-r2-source-20261019`, fresh
  r2 DATA, results, Till control and source names) and native review r2
  (`artifacts/p07-4178c26-r2-native-review-source-20261019`, actor pointer
  only) are built; a dry check passed the whole chain, including the live app
  fields. The r2 run uses a background recovery watch that places the one-use
  authority by atomic rename only if all eligibility checks pass.
  **P07 r2 PASS (19:23:23 to 19:25:08 UTC).** Actor 104 s; the watch passed
  all 13 checks and placed the authority 5 ms after the actor requested it;
  kill to healthy 16.0 s; the M1 observer decoded video and audio at both
  qualities on the new continuity, no fatal errors. Independent native review
  PASS
  (`artifacts/independent-p07-4178c26-r2-positive-native-review-20261019/P07-NATIVE-PROOF.json`,
  sha `54a66394…`). Live app `7d0ae914`, started 19:24:20 UTC,
  `unless-stopped`, lease inodes unchanged. Record:
  `artifacts/p07-4178c26-r2-result-20261019.json`.
- **R61 is RED on the same single gate (19:30:44 to 19:37:27 UTC).** Source
  4178c26, Till app 7d0ae914 unrestarted, 3 roles on M1 and 11 on M4, 302 s
  measured. The launch waited for the unchanged gate (19:28 refused on M4
  load). 15 of 16 gates passed; `each4BothQualityPeer` failed and is weaker
  than R60: no receiver received high quality from peers (receiver 2 received
  no peer media), 0 of 425 high-quality peer requests completed, and verified
  peer media fell to 6.3 MB (R60 14.2 MB). Cancel is active: 353 responses
  cancelled and 129 MB never sent. `bytes.uploaded` charges the whole segment
  on acceptance and is not refunded, so its 222 MB includes that 129 MB;
  from the two counters about 92.9 MB was actually sent (one session per
  contributor).
  High-quality requests still start with as little as 24 ms left (p10); the
  late-request floor cannot limit them without a completed high-quality
  transfer, and the observer does not record `peerSkippedLate`. The R61
  observer change (cancel counters only) is labelled in the authorisation.
  External path monitors (not harness evidence): M4 median connect rose from
  65 to 112 ms during measurement, as in R60, but M1 load1 peaked at 6.6
  (R60 51.6), so M1 load does not explain the result.
  Cleanup confirmed on M1, M4 and Till; docs restored by checksum. Result:
  `artifacts/distributed-fourteen-qualifier-4178c26-r61-result-20261019.json`.
  The 7,200 s run stays blocked; the next step is a high-quality delivery
  change, which needs its own cycle.
  **Read-only diagnosis (`artifacts/r61-throughput-diagnosis-20261019/DIAGNOSIS.json`),
  corrected by the structural analysis below.** Holder links peaked at
  3.9 Mbit/s (R60 15.2, R59 9.1) and no high-quality request ran faster than
  2.75 Mbit/s (R60 5.17). Cancelled responses keep their charge against the
  512 000 B/s upload token bucket, so the busiest holder refused 137 requests
  (R60: 7) after 77 MB of charged bytes were never sent. The first version
  said the environment did not explain the drop and led with the 128 KiB
  send buffer; both are corrected below.
  The concurrent session on this Mac is working on Spotlight
  indexing, which explains much of M1's load.
  **Structural analysis
  (`artifacts/high-quality-peer-structure-analysis-20261019/ANALYSIS.json`,
  read-only, R59 to R61).** Findings:
  - *Playback regression in R61.* Every peer-first viewer at high quality
    stalled: receivers 5 to 8 times (7 to 14 s), high contributors 9 to 15
    times on 3 of 4. Origin-only baselines barely stalled; R60 had almost
    none. The frame/audio gate still passed. The stalls followed quality and
    peer-first mode, not host: low-quality contributors on M4 stalled once
    or twice for under a second. That points to the high-quality wait loop
    rather than the path alone, but the records cannot separate 4178c26
    from the slower path.
  - *The 1.5 s cap, not playback, bounded R60.* At high-quality decisions,
    R60 receivers had a median 7.9 s of buffer. With the 2 s origin reserve
    kept, 87% could have waited at least 3.5 s. In R61 the high buffer had
    collapsed to 3.5 s, so the cap bound only about 15% of decisions there.
  - *A high segment needs far more than 1.5 s.* About 0.7 s goes on waiting
    for a holder (budget left at request p50 739 to 783 ms). Typical requests
    then ramp the same way in R60 and R61, gaining about 0.37 of a segment
    per second after a slow start. A whole segment needs roughly 2.5 to 3 s
    from the request. The smaller send buffer lowered the fastest links but
    not the typical request, so it is one unproved contributor, not the
    lead cause.
  - *The environment was worse in R61, contrary to the first diagnosis.*
    High-quality HTTP fetches by peer-first roles were 40 to 65% slower on
    3 of 4 high contributors; low-quality fetches were unchanged. Both runs
    were without the VPN. Origin timing per request was not recorded, so path
    capacity and self-inflicted fallback bursts cannot be separated.
  - *Likely feedback loop (inferred).* A failed high wait costs up to 1.5 s
    plus the HTTP fetch, close to the 2 s segment in R60 and over it in R61.
    The buffer then drains toward the reserve, the budget shrinks toward
    zero, and requests start with little time left. R61 had 96 high requests
    given under 400 ms (p50 25 ms), 91 of which received nothing. The code
    charges each accepted request a whole segment before sending. Records
    carry no holder id, and the timing correlation with refusals (0.38) is
    no stronger than for other timeouts, so the size of this drain is
    unproved.
  - *Gate arithmetic.* Each receiver needs one verified high peer segment in
    about 150 s at high (about 60 attempts). A 5% per-attempt completion
    rate gives about 95% per receiver; R60 managed 1%, R59 4%, R61 0%.
  - *Projection.* From each timeout's own partial rate (pessimistic), a cap
    of 3 to 5 s would let 18 to 32% of R60's high timeouts finish, but only
    where the buffer allows it.
  - *Receiver 2 in R61.* It had four links and no dial or admission
    failures; its only peer segment arrived before measurement.
  - *Loopback cap failure.* The 3000 ms cap failure in the loopback journey
    is still unexplained.
  - *Process.* Floor, cancel and the smaller buffer were each proved only
    on loopback, where peers never time out. No local bench reproduces a
    160 to 200 ms relayed round trip.
  The analysis lists the levers and their costs: wait cap, request floor,
  charge semantics, early give-up, buffer depth, segment size, send buffer,
  UDP relay addresses and cut-through sending.
- **Peer timing bench and candidate `eb8a62f` (20 October, local, not
  pushed).** The user chose "bench first".
  - *Bench.* `test/peer-timing-bench.mjs` (dev-only, committed with the
    candidate): the demo page, two live renditions at field segment sizes
    (about 208 KB and 668 KB), and Chrome DevTools network emulation set
    before any peer connection opens (60 ms per page, a peer round trip of
    about 250 ms; origin 150 ms + 800000 B/s or 200 ms + 530000 B/s). On 4178c26
    it reproduces the field: 0 to 1 per cent high-quality completions, the R60
    ramp, and the R61 drain when only the origin slows. Loopback with
    emulated delay, not field evidence. Calibration:
    `artifacts/peer-timing-bench-calibration-20261019/CALIBRATION.json`.
  - *Cap alone.* A 3000 ms `originFallbackMs` drained high-quality viewers
    further and completed no high transfer (EXPERIMENTS.json there).
  - *Candidate.* Branch `perf/peer-no-drain`, one commit on 4178c26:
    projected waits bounded by the buffer less the origin reserve (new
    `maxPeerWaitMs`, 5000), early abandonment, a holder refund of unsent
    bytes to the per-second rate, first-byte timing and new counters;
    INTEGRATION.md updated. Five iterations; v5 was reverted.
  - *Result, 300 s runs, matched settings.* Current code: 0 high and 5 to 8
    low peer completions, receivers at 2.5 to 3.0 s of buffer at high
    decisions. Candidate: 2 to 11 high and 185 to 217 low completions,
    receivers' median buffer 3.1 to 6.7 s, no stalls in any run. The bench
    gate passed 1 of 6 candidate runs; each failure left one receiver with
    no high peer segment. High delivery is bounded by holder uplink: a high
    viewer needs about 335 kB/s against the demo's 512 kB/s limit.
    `maxPeerWaitMs` bound the room where the buffer allowed about 5.9 s.
    Record: `artifacts/peer-timing-bench-candidate-20261019/CANDIDATE.json`.
  - *Local tests.* Unit 214/214, playback, resume, all four operator cases
    (both account-budget journeys) and the CI-shape browser runs passed on
    M1: `artifacts/candidate-3321b3b-local-tests-20261020/SUMMARY.json`.
  - *Holder upload rate (user's choice, "bench at 1.25 MB/s first").* With
    contributors at the demo's 1.25 MB/s choice (bench commit `3407eb8`), the
    candidate passed the bench gate in both regimes (22 and 11 high
    completions, no rate-limit refusals, no stalls); current code still
    failed both with no high completion. One run per regime; the slow-origin
    pass left one receiver with a single high segment. The pilot profile
    records 512 kB/s, so the field equivalent is a profile change needing
    fresh consent. Record:
    `artifacts/peer-timing-bench-upload-1250000-20261020/RESULT.json`.
- **`c5672e5` cycle, in progress (user chose "candidate + 1.25 MB/s", 20
  October).** The candidate and bench option were squashed to `8279c23`;
  `feat/broadcaster-pilot` was fast-forwarded from 4178c26 and pushed. CI
  39380893462 failed: (1) `test:broadcast:browser`, a code fault: the test's
  availability instrumentation reads `deadline` in `#peerFirst`, which the
  change had replaced, so every instrumented peer-first load threw (production
  builds unaffected); (2) one Windows timing test (`serial peer attempts…`,
  120 ms budget against 15.6 ms timer steps), passing 15/15 locally and on
  Ubuntu/macOS. Record: `artifacts/ci-8279c23-39380893462-20261020/FAILURE-RECORD.json`.
  Fix `c5672e5` (keeps an initial `deadline` binding; broadcast browser test
  passes locally) pushed as a fast-forward; CI 39382996962 running. Consumer
  preparation for c5672e5 is built (exact rebase of the executed 4178c26
  helpers, same edit counts):
  `artifacts/clean-consumer-c5672e5-source-preparation-20261020` (SOURCE-PINS
  `f50c2228…`). Deployment findings: the runtime inventory excludes `test/`,
  so it stays 62 with the same three changed files; the existing positive-P07
  typed branch (`P07-parent-crash-finite900-app-transition-v1`) accepts the
  4178c26 r2 native proof unchanged in a pure check (derives app `7d0ae914`,
  18 records), so the deployment is a rebase with predecessor 4178c26, not a
  new method. The qualifier profile change is `SETTINGS.rate` 512000 to
  1250000 in `actor-model.mjs`, to be labelled in R62 with the new counters.
  CI 39382996962 on c5672e5 then failed only on an over-tight assertion in a
  new test (first byte `>= 600` against a 600 ms timer); fixed in `5f2ece0`
  (test only) and pushed. **CI 39384666332 on 5f2ece0 PASS**, all nine
  required jobs including live relays, soak skipped:
  `artifacts/ci-5f2ece0-39384666332-20261020/ci-terminal-success.json`
  (`f56b24e3…`). **Fresh consumption PASS (07:29 UTC, M1, 13 s)**: archive
  `979522a7` (287 members), package `aff72af3` (284 members), demo client
  782466 B `92b3f56f`, standalone `8a1161cb`; supervisor exit 0, TMPDIR
  removed, docs restored by checksum. Deviation: the offline audit ran once
  under a plain 15 s timeout, not the recorded wrapper (stated in
  `analysis/AUDIT-EXECUTION.json`). Review:
  `artifacts/clean-consumer-5f2ece0-20261020/package-review.json`.
  **Deployed 07:43 UTC, local closure PASS.** Packet: rebase of the executed
  4178c26 deployment (host-common/snapshot rebound, inventory constants
  regenerated against the 4178c26 map, pure test rebound to the 4178c26 r2
  P07; proof-guards, host-entry and namespace adapter exact copies), pure
  6/6: `artifacts/deployment-5f2ece0-peer-wait-source-preparation-20261020`.
  One chained Root run (`artifacts/deployment-5f2ece0-peer-wait-root-chain-20261020.sh`):
  snapshot, fresh M1/Till reads, stage 07:43:03 to :16, deploy/attest/cleanup
  to :55, finalise. App `d33b0421` (revision 5f2ece0, image `e088cec7`)
  replaced `7d0ae914`, started 07:43:42 UTC; client 782466 B `92b3f56f`;
  profile unchanged (relay TLS/TCP, 32/900); four lease inodes unchanged.
  Contract `202b5564…`:
  `artifacts/deployment-5f2ece0-peer-wait-20261020/runtime-contract.json`.
  **Independent post-cleanup deployment review PASS** (07:47 UTC, one 1.7 s
  read-only Till read, 115 pins, six predicates; literal rebase of the 4178c26
  r2 review protocol with the positive-P07 checks rebound to the 4178c26 r2
  app): `artifacts/independent-deployment-5f2ece0-review-20261020/review.json`
  (`df9fed1c…`).
  **P05 PASS on the third invocation (07:55 to 08:01:37 UTC, 379 s of 540 s).**
  Source: identity rebase of the 4178c26 r1 bound copy (no predecessor branch
  needed). Two earlier invocations refused locally before any host action:
  attempt 1, the generator had set the actor's two native helpers to 0600
  (base 0500), refused at native resource identity; attempt 2, Chrome's
  hard-link count changed 44 to 43 between Root's executable snapshot and the
  actor's check (another session's Chrome instance closed). Records:
  `artifacts/p05-5f2ece0-root-run-attempt1-20261020.json`,
  `artifacts/p05-5f2ece0-root-run-attempt2-20261020.json`. Attempt 3
  (`artifacts/p05-5f2ece0-source-bound-r3-20261020`, launched after the Chrome
  link count held for 5 s): 45 host operations ok, natural expiry 302.7 s,
  telemetry false restored, live app `9a265f56` started 08:01:22 UTC.
  Independent OWN review PASS, reporting acceptance true (one M1 and one Till
  read, 34 direct pins):
  `artifacts/independent-p05-5f2ece0-positive-own-review-20261020/review.json`
  (`5842f8bf…`).
  **P07 attempt 1 RED before the crash (08:11:32 to 08:12:15 UTC).** Sources
  (identity rebases of the 4178c26 attempt-1 P07 source, driver and native
  review, pures 11/11): `artifacts/parent-crash-p07-5f2ece0-source-preparation-20261020`
  (index `ebd52de1…`). The recovery watch was polling and Chrome's link count
  steady before launch. The M1 observer played both qualities with decoded
  progress, then its Node-side `publicState()` fetch of `/session.json` or
  `/client.js` from the public pilot hit its 5 s/8 s timeout; the run ended
  before the parent signal. Host operations: prepare, restore-policy,
  cleanup-source. No crash, no recovery request, watch placed nothing,
  browser cleanup complete. Live app unchanged: `9a265f56`, unless-stopped.
  Record: `artifacts/p07-5f2ece0-root-run-attempt1-20261020.json`. The user
  chose a rerun. Attempt 2 (r2 driver names) refused at actor validation,
  Chrome hard-link count changed, no host action. Attempt 3 (r3 names, launched
  only when no other browser process ran and the count held 10 s) failed like
  attempt 1: both qualities decoded, then `publicState()` timed out about 7.5 s
  after readiness; no crash, cleanup complete, app `9a265f56` unchanged. In
  attempt 1 a browser segment in the same window took 7.5 s (others 0.1 to
  0.7 s), suggesting a path stall; `publicState()` is byte-identical to the
  passing 4178c26 r2 observer. Records:
  `artifacts/p07-5f2ece0-root-run-attempt2-20261020.json`,
  `artifacts/p07-5f2ece0-root-run-attempt3-20261020.json`. Diagnosis: the r3
  timeout was the observer's single 8 s fetch of the 782 KB `/client.js` (the
  pilot proxy logged the aborted response); a quiet probe of 30 such fetches
  from M1 had median 0.70 s but one 7.2 s body stall
  (`artifacts/p07-5f2ece0-path-diagnosis-20261020.json`). M1 was on Wi-Fi.
  The user paused P07 after attempt 3, then asked to carry on; M1 was still on
  Wi-Fi, so reruns used the unchanged harness behind local read-only gates.
  Attempt 4 (r4, link gate passed) refused before any host action: the Till
  policy/clock read took 1689 ms against the 1000 ms bound
  (`artifacts/p07-5f2ece0-root-run-attempt4-20261020.json`).
  **P07 r5 PASS (08:49:32 to 08:51:11 UTC).** Link and SSH gates clean; actor
  98 s; the watch placed the authority at 08:50:18; independent native review
  PASS (`artifacts/independent-p07-5f2ece0-r5-positive-native-review-20261020/P07-NATIVE-PROOF.json`,
  sha `19869d43…`; review `8547424d…`). The chain wrote the read authorisation
  with mode 0644, so `produce-review.py` refused after both reads; Root set
  0600 (content unchanged) and reran only that step inside the window. Live app
  `8534fff7` (5f2ece0, image `e088cec7`), started 08:50:23 UTC,
  `unless-stopped`. Record: `artifacts/p07-5f2ece0-r5-result-20261020.json`.
  **R62 prepared and bound.** Preparation
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r62-preparation-20261020`
  (generator beside it; manifest `3c1c5013…`) is the R61 build rebased to
  5f2ece0 with three labelled changes: `SETTINGS.rate` 512000 to 1250000 (the
  existing 1.25 MB/s option), peer-wait counters (`peerSkippedLate`,
  `peerProjectedLate`, `peerWaitExtended`, `peerAbandoned`, `peerNoFit`) in each
  observer sample, and Chrome pins refreshed to 155.0.8059.85 (`6e156f22…`,
  same bytes on M1 and M4; M4 whole-app strict signature still RED as before;
  `artifacts/qualifier-chrome-155.0.8059.85-observation-20261020.json`). Local
  tests equal the R61 base file by file, with the same failing test names
  (`artifacts/distributed-fourteen-qualifier-5f2ece0-r62-local-tests-20261020.json`).
  Deployment bound (`1303387c…`); `prepare-run` PASS with the P07 r5 proof
  (data `4e7ea41f…`, root driver `fa86cb17…`, identical to R61's apart from
  deployment, archive, contract, review, CI and P07 pins). The R61 root
  scripts were copied out of the session scratchpad to
  `artifacts/r61-root-scripts-20261019/`; R62's are in
  `artifacts/r62-root-scripts-20261020/` (launch gate adds M1 `client.js`
  <= 0.8 s to the R60 gate).
- **R62 is RED, stopped early by the observer's own health read (09:52:51 to
  09:58:02 UTC).** The gate waited about 40 minutes while another session's
  fuzz campaign saturated M1, then met at 09:52:19. At 09:57:41.8, 178 s into
  the 300 s measurement, the observer on M4 timed out (2 s) reading M1's local
  `/resource-health` through the SSH tunnel; the sample a second earlier was
  healthy. The cause is not isolated between a stall on the M4-to-M1 path (M1
  on Wi-Fi) and one slow reply from M1's health server: M1's sample lag stayed
  flat (about 1 s) up to the failure, and M1 was busier than in R61 (load1
  median 6.7, maximum 12.3; R61 4.5, 8.0). The run finalised RED, so the receipt holds only the
  three admission gates that need a completed measurement (all false) and the
  per-role gates were not evaluated. Admission verifies: 1979 of 1982 returned
  200. Partial peer evidence (178 s, not gate-comparable): high-quality peer
  requests delivered 4 of 18 (R61: 0 of 425 over 300 s); low 93 of 174 (R61:
  30 of 169); median budget left at request start 1.36 to 1.39 s (R61: 0.74
  to 1.0 s); receivers 1 and 3 received high from peers, receiver 2 low only,
  receiver 4 none. The new peer-wait counters were recorded in every sample.
  Cleanup complete on M1, M4 and Till; live app `8534fff7` unchanged. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r62-result-20261020.json`.
- **R62 r2 is RED (10:34:29 to 10:38:15 UTC).** The user chose a fresh-name
  rerun; the r2 preparation is the R62 generator with only names changed
  (every program byte-identical). At 10:38:04, 107 s into measurement, the
  actor model refused an unplanned origin-only interval: M4-contributor-high-2's
  short-lived peer authority lapsed for 0.95 s while its renewal was pending,
  and the page dropped to off and back, losing its peer links. The M4 path
  monitor shows M4-wide degradation from 10:37:55 to 10:38:03 (pilot TCP
  connect 0.7 to 0.95 s against about 40 ms, TURN connect up to 1.1 s,
  `session.json` 2.06 s) while M1's connects stayed normal; M1 load1 was 69 to
  76 from other sessions. Harness uploads were not the cause (aggregate M4 peer
  upload about 0 MB/s then). R62's own failure also coincided with a smaller M4
  spike. M4's default route is a VPN tunnel over Wi-Fi, and M1 was recorded
  as on Wi-Fi but most likely also used a tunnel (see R63). R61's launch notes
  record a no-VPN baseline, so the paths differ from R61's. Partial peer evidence was weak (low 11 of 44, high 0 of 8; only
  receiver 1 received peer media). Cleanup complete; live app `8534fff7`
  unchanged. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r62-r2-result-20261020.json`.
- **R62 r3 is RED on 2 of 16 gates after a complete 304 s measurement (11:35:33
  to 11:42:43 UTC).** The user said "carry on regardless"; r3 is the same
  programs with fresh names. The first gate window (10:44 to 11:30) was never
  met (M1 load from other sessions, M4 `client.js` over 0.8 s), with no host
  action; the second met at 11:35:25. Failed: `each4BothQualityPeer`
  (receivers 1 to 3 received both qualities from peers, receiver 4 high only)
  and `observedInPlaceRenewal` (M4-contributor-low-1 had no peer links at its
  first ticket renewal, having lost its last two four seconds earlier).
  Against R61's full run: high-quality peer requests delivered 28 of 66 (R61 0
  of 425), low 149 of 278 (R61 30 of 169), verified peer bytes 50.1 MB (R61
  6.3 MB) with fewer uploaded bytes (157 MB against 222 MB). Link churn rose
  about five-fold (166 links closed against 34; 36 dial timeouts against 0),
  led by upload drain timeouts (52 against 9) and the matching channel errors,
  consistent with the 1.25 MB/s limit overdriving relayed links on the current
  Wi-Fi/VPN paths but not isolated from the network change; `steadyNoChurn`
  passed. Cleanup complete; live app `8534fff7` unchanged. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r62-r3-result-20261020.json`.
  The user chose a rerun at 512 kB/s to isolate the rate (R63).
- **R63 is RED in setup, before any measurement (12:02:30 to 12:03:45 UTC).**
  R63 is the R62 preparation without the rate change: `actor-model.mjs` is
  byte-identical to R61's (`rate:512000`), the Chrome pins and peer-wait
  counters stay, and local tests match R62's
  (`artifacts/distributed-fourteen-qualifier-5f2ece0-r63-local-tests-20261020.json`).
  The gate met at 12:02:22 after 9 checks. M4-contributor-high-1 (M4 profile
  A) started receive-only at 12:03:19 and was not ready within the page's 12 s
  default limit (unchanged since R61). Playback never began, a policy read
  took 2.3 s and one admission verify failed at 3.0 s. Six contributors had
  started. M4's path degraded through the window. Pilot TCP connects rose from
  about 120 ms to 1.07 s between 12:03:07 and 12:03:27, and `session.json`
  took 1.33 s, then timed out. The monitor paused for 8 s while M4 load1 was
  3.5 to 4.6. M4 has slowed in every setup since R61 (`session.json` up to 1.6
  to 2.3 s against at most 0.53 s in R61's setup), but R63 was the worst
  (connect p90 850 ms against 187 to 346 ms). Rate is not the setup factor,
  since three setups at 1.25 MB/s passed. The rate question is still
  unanswered.
- **M1 also routes through a VPN tunnel.** Its default route was Wi-Fi (en1)
  at 08:43 UTC today. A tunnel system extension process started at 08:59:03,
  and the route was confirmed through the tunnel at 12:06. Nothing observed
  the route in between. M4's tunnel extension started at 20:14 UTC on 19
  October, after R61 ended. So every R62-series run and R63 most likely sent
  through a VPN tunnel on both Macs, and R61 on neither. The P07 r5 and
  R62-series records describe M1 as on Wi-Fi because the tunnel was not
  checked; P07 r5 passed, and no verdict changes. M1 load1 rose from about 8
  at the gate to 22 to 32 during setup (not attributed).
- **R63 cleanup.** Both stages are absent with no owned processes. Till keeps
  only `journal.json`, and the live app `8534fff7` is unchanged (restart count
  0). The browser receipt does not prove browser cleanup: only 7 of 14
  contexts were acquired (all 7 closed, CDP detached). The outer guardian
  reports `ok: false` with the worker reaped and the owned group absent. The
  metadata helper ended by signal with an invalid record. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r63-result-20261020.json`.
  The user chose "Tunnels off, then rerun". Both tunnels were off by 12:22:14
  (M1 en1, M4 en0).
- **R63 r2 is RED at the setup progress check, before measurement (12:35:20
  to 12:37:06 UTC).** R63 r2 is the R63 programs with fresh names (all 92
  byte-identical). Its authorisation adds a Root-side check that refused to
  launch if the default, origin or TURN route on either Mac was a tunnel; it
  passed. All 14 roles started. The progress check requires every page to
  advance frames, media time and decoded audio over 10 s (unchanged since
  R61). Two high-quality pages on M4 failed it: M4-contributor-high-2 and
  receiver-3. Their frames and audio stayed flat while media time jumped
  about 16 s, which suggests the player skipping forward after a stall. The
  origin-only high-quality page on M4 also stalled. M4's pilot connects rose
  to 100 to 270 ms, with spikes of 1.2 and 2.2 s, and `session.json` took
  1.6 s. What M4's pages pulled from the origin in that window has fallen
  across the runs: R60 2.90 MB/s, R61 2.32, R62 2.25, R62 r2 1.53, R62 r3
  1.87, R63 r2 1.09. M1's three roles were served steadily (0.50 to
  0.57 MB/s), which points at M4's side. The fall is not explained by the
  tunnel alone or by the contributor rate. M4 is a laptop on Wi-Fi only
  (channel 60, -48 dBm, 780 Mbit/s when checked afterwards). M1 is on Wi-Fi
  with its Ethernet port not carrying the route. The rate question is still
  unanswered. Cleanup complete and proved (14 of 14 contexts closed); live
  app `8534fff7` unchanged. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r63-r2-result-20261020.json`.
  The user chose to investigate peer startup locally.
- **The setup stalls come from M4's origin downloads, not from peer waits
  (analysis of retained records, no host action).** The stalled
  high-quality pages on M4 were loading from the origin. Since R61 most of
  their decisions were "no budget" (buffer already below the origin
  reserve), and the few bounded peer attempts fell back to the origin. R60's
  pages tried peers more often and did not stall. In R63 r2's netlog, M4's
  origin requests went out at once (0 to 1 ms queued), and the time went on
  transfer: high segments at about 100 to 290 kB/s against the about
  325 kB/s real time needs. M1 fetched the same segments from the same origin
  at 0.65 to 4.2 MB/s. The end-of-measurement netlog windows compare like
  for like: median per-segment high transfer on M4 was 1.0 to 1.1 MB/s in R60
  and 0.23 to 0.72 MB/s in R61 to R62 r3, while M1 stayed at 0.9 to 2.0 MB/s.
  A single HTTP transfer does not depend on the peer loader, so M4's
  network path has slowed since R60. The 11 M4 roles need about 2.5 MB/s
  from the origin, because peers deliver almost nothing during setup (R60
  included). M4 has supplied that or less since R61. Each role is its own
  browser context, so the HTTP/1.1 connection limit is per role and not
  shared. The R60 to R61 loader changes do not alter how origin requests
  are made. Fresh test profiles also download Chrome components at startup
  (4.89 MB against 4.53 MB of media on one M4 browser in R63 r2's last
  11 s). Why M4's path slowed is not identified: R60 ran at a different
  time of day, and other traffic on M4 was not measured. Record:
  `artifacts/qualifier-setup-stall-analysis-20261020.json`.
- **Origin probe (13:09 to 13:11 UTC, outside the harness, read-only).** With
  the harness idle, M4 is no slower than M1. Six parallel `client.js` streams
  gave 2.73 MB/s on M4 and 2.05 MB/s on M1 when run separately, and 2.87 and
  3.01 MB/s when run together (5.88 MB/s combined, so no shared
  bottleneck). Each fetch opens a new TLS connection, so these understate
  capacity. In R63 r2's setup the same path fell to 0.1 to 0.3 MB/s per
  transfer, with connects up to 1 to 2 s. So M4 congests under the
  qualifier's own load: 11 pages, about 2.5 MB/s of origin media plus
  start-up buffering, Chrome component downloads of about 5 MB per browser,
  and relay and control traffic. R60 carried the same load without
  congesting, and what differs is not identified. Record:
  `artifacts/origin-download-probe-20261020.json`.
- **R63 r3 is RED at the 90 s setup deadline, before measurement (13:15:14
  to 13:17:15 UTC).** The user chose "Rerun now, measure M4": the R63
  programs again with fresh names, tunnels off, plus a per-process network
  sampler on M4 outside the harness. All 14 roles started, but over 75 s
  (R60 40 s, R61 50 s, R63 r2 54 s), and the deadline expired inside the
  10 s progress check.
  M4's Wi-Fi download sat at a flat 4.0 to 4.4 MB/s for the last minute of
  setup, which means it was saturated. It took in 311 MB in 85 s, at least
  224 MB of it through the two test browsers, but the pages' origin media
  came to only 57 MB. Another Chrome on M4 used 0.1 to 0.4 MB/s, the
  harness's observer and SSH session up to about 0.2 MB/s each, and nothing
  else was significant. In the M4 netlog, a long request that started
  before the window read 6.86 MB in 8.3 s over QUIC. The origin serves
  HTTP/1.1 only, so it was not from the origin. A similar one read 5.73 MB
  in 11 s in R63 r2, while R60's and R61's end-of-run windows show almost no
  QUIC traffic. Component updates also downloaded. A guess that it was
  Chrome's on-device AI model went against the evidence: M1's regular Chrome
  holds that 4 GB model and M4's does not. The harness
  launches Chrome without `--disable-background-networking` or
  `--disable-component-update`, so every fresh profile runs its background
  downloads during setup. The large download's URL is not in the retained
  window. Cleanup: both stages are absent, the Chrome groups gone and the
  profiles removed. Till keeps only `journal.json`, and the live app
  `8534fff7` is unchanged. The observer receipt holds no browser-cleanup
  fields, because its setup deadline ended it first. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r63-r3-result-20261020.json`.
  The user chose to identify the download.
- **Every fresh test profile downloads about 54 MB of Chrome's own models
  and updates in its first 90 s (probe at 14:25 UTC, between runs, outside
  the harness).** One fresh headless Chrome per Mac ran with the harness's
  exact launch flags, idled for 90 s and was then removed. Both downloaded
  about 41 MB of Optimization Guide models from Google over QUIC, starting
  12 to 14 s after launch; the largest, the passage embedder, is 33.6 MB.
  About 13 MB of component updates followed from about 60 s. None of it
  relates to the test. M4 runs two profiles, so about 110 MB lands on its
  Wi-Fi early in setup. That matches the QUIC downloads in the R63 r2 and r3
  netlogs and much of R63 r3's non-media traffic. Whether R60 and R61
  profiles downloaded the same is not known. Record:
  `artifacts/chrome-background-probe-20261020/SUMMARY.json`.
- **Flags verified; R64 prepared, not run.** The user chose "Verify flags,
  then build R64". With `--disable-background-networking`,
  `--disable-component-update` and
  `--disable-features=OptimizationGuideModelDownloading,OptimizationHints,OptimizationTargetPrediction`,
  a fresh profile's background downloads fall from about 54 MB to 0.01 MB on
  both Macs. The first two flags alone left the 41 MB of models
  (`artifacts/chrome-background-probe-flags-20261020`, M4; the M1 half of
  that probe passed the flags as one argument and is invalid). Final probe:
  `artifacts/chrome-background-probe-flags2-20261020`. R64 is the R63
  programs plus one labelled change: those three flags in `model.mjs`, the
  only one of the 92 programs that differs from R63
  (`artifacts/distributed-fourteen-qualifier-5f2ece0-r64-preparation-20261020/R64-METHOD-DELTA.patch`).
  Local tests equal R62 file by file after one rerun of `netlog-capture`,
  whose single extra failure did not recur and whose files are byte-identical
  to R62's
  (`artifacts/distributed-fourteen-qualifier-5f2ece0-r64-local-tests-20261020.json`).
  Bind and prepare-run pass, and the root pins the flagged `model.mjs`.
  The user approved running it.
- **R64 cleared setup, then went RED 106 s into measurement (14:54:10 to
  14:57:51 UTC).** Setup passed for the first time since R62 r3. All 14
  roles started in 36.5 s (R60 39.9 s, R63 r3 75.1 s), every page advanced
  in the progress check, and peer readiness was green with 43 links. During
  setup M4 took in 2.49 MB/s with no flat ceiling, and the test browsers
  received about as much as their pages' origin media (83 MB against
  82 MB). So the launch flags removed the background downloads. At
  14:57:07.7 the observer's 2 s health read of M1 timed out. M1's load had
  climbed from about 10 to 144 during the run and was still about 100
  afterwards, which points to other work on M1 rather than the harness
  (its M1 tree stayed at 24 to 25 processes). Partial peer evidence, not
  gate-comparable: low-quality peer requests 97 of 136 delivered, high 0 of
  42, as in R61 and unlike R62 r3's 28 of 66 at 1.25 MB/s. Early link churn
  does not clearly follow the rate (6.9 closes per minute in R64 and 17.7 in
  R61 at 512 kB/s, against 9.6 to 31.3 at 1.25 MB/s). The partial evidence
  points to the 512 kB/s limit, not churn, as what blocks high-quality peer
  delivery, but the comparison is not matched.
- **R64 cleanup is incomplete on M1.** The harness cleanup stopped at
  `read-endpoint-receipt` (TimeoutExpired) under that load. The runner was
  reaped, the Chrome group is gone, and nothing references the stage, but
  three folders remain: the stage (174 KB), the Chrome profile (21.7 MB)
  and an empty child temp folder. Their records are copied to
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r64-run-20261020/M1-leftover-stage-evidence/`;
  at the user's request they were then removed by literal path after inode
  checks, a manual cleanup deviation (`MANUAL-CLEANUP.json` there). M4 and
  Till are clean, and the live app `8534fff7` is unchanged. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r64-result-20261020.json`.
- **R65 prepared and run after a second gate wait.** The user chose "Matched
  1.25 MB/s run": the R64 programs with the contributor limit at 1.25 MB/s,
  so R65 differs from R62 only in the three launch flags. The first
  45-minute gate wait (15:30 to 16:16 UTC) passed none of 123 checks: M1
  load1 reached 169 from other projects' builds, test browsers and a virtual
  machine, and M4's load stayed mostly above 5 from the owner's own apps.
  Nothing was stopped. At the user's request the gate was re-armed with
  unchanged limits; it was met at 16:42:08.
- **R65 completed the 300 s measurement and is RED on two strict gates
  (16:42:18 to 16:48:55 UTC).** 14 of 16 gates passed, including steady
  churn, consent, renewal, admission and resource gates. All 14 roles
  started in 34.9 s, every page advanced at least 308 frames in the progress
  check, and M4 took in 2.19 MB/s during setup. `all8ActuallyUploaded`
  failed: M4-contributor-high-2 served one 666 kB upload during setup and
  none during measurement, although it was serving with 3 to 4 links and
  refused nothing. `each4BothQualityPeer` failed: only receiver-3 received
  high-quality peer media. Receivers 1, 2 and 4 asked for high-quality
  segments, mostly waited for a holder and fell back to origin; only the
  four high-quality contributors hold that media. M1's load rose to 18.6
  during measurement and the run still completed.
- **Matched rate comparison.** On the same method (launch flags, no
  tunnels), high-quality peer requests completed only at 1.25 MB/s: 9 of 16
  in R65's first 106 s of measurement against 0 of 26 in R64, and 36 of 52
  over R65's 300 s against 0 of 416 in R61. R64's earlier "0 of 42" included
  setup records. Link churn did not follow the rate: over the first 106 s,
  4.3 closes per minute in R65 and 6.9 in R64; over 300 s, 3.6 in R65
  against 32.9 in R62 r3, which ran at the same rate with tunnels and the
  background downloads. The higher limit is needed for high-quality peer
  delivery but is not sufficient. Request counts are lower bounds, because
  each sample carries only the last 16 page records.
- **Open question: single transfers run well below the limit.**
  High-quality payloads ran at a median 2.1 Mbit/s against the 10 Mbit/s
  limit (low quality 1.5 Mbit/s, R64 1.2), timed from request, so first-byte
  delay is included. The limiter is one token bucket per contributor with a
  two-second burst, shared across its links, and a holder queues at most
  128 KiB (since `4178c26`). M4's Wi-Fi took in 3.22 MB/s during R65's
  measurement and 3.17 MB/s in R64's. All 48 links open at the end of R65
  were relay to relay over TLS, as the recorded relay-only profile requires,
  so every peer byte went to Till and back over TLS/TCP. The round trip to
  the TURN service was about 84 ms from M1 and 102 ms from M4, roughly 170
  to 200 ms per link. That path is the leading candidate, not yet tested.
  The high rendition is about 2.6 Mbit/s, so a single high-quality peer
  transfer at the observed median runs slower than real time. Addendum:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r65-result-addendum-20261020.json`.
  Cleanup passed on M1, M4 and Till, the live app `8534fff7` is unchanged,
  and the docs stash was restored with matching checksums. Record:
  `artifacts/distributed-fourteen-qualifier-5f2ece0-r65-result-20261020.json`.
  Awaiting the user's decision.
- **UDP relay addresses, not chosen.** The relay answered a STUN binding over
  UDP 3478 from M4; the demo already supports `--turn-url-projection issued`,
  still relay-only, but that changes the recorded pilot profile and requires
  fresh Apply and upload consent, so it is the user's decision.
- **Local link bench (20 October, 19:10 to 21:24 UTC, local only, no host
  action; its TCP figure is overstated, see the field probe below).** The user asked to test
  the transfer rate at about 200 ms locally. Two headless Chrome pages ran
  the 5f2ece0 PeerLink. Chrome DevTools latency proved lossy (6 to 8% of
  peer packets), so delay came from a counted UDP relay on loopback. At a
  196.5 ms round trip with no loss, a high segment ran at 6.5 Mbit/s and a
  low one at 2.8 Mbit/s, about 1.0 s and 0.6 s from the request. The
  pre-4178c26 1 MiB queue reached 8.9 Mbit/s on high segments (1 of 3 runs
  valid; the others lost packets on loopback). Through a local coturn of
  Till's image (`coturn/coturn:4.17.2-r0`) at 197 ms, TURN over TCP ran at
  1.0 Mbit/s in two checks, with 35 and 39 packets lost and none in netem
  or Chrome; a third check's link failed with a channel error. coturn's
  source drops relayed data bound for a TCP/TLS client, without counting or
  logging it, once 32 KiB is queued (always on), and every R65 link went
  through a coturn TLS leg. TURN over UDP reached 3.3 Mbit/s, a lower
  bound, because that cell lost 3.5% between Docker's UDP forwarding and
  coturn. A UDP relay avoids the drop rule but not field loss: 1% seeded
  loss alone gave 0.6 Mbit/s, then the holder's 3 s drain deadline closed
  the link. The pilot's `tls-tcp` projection keeps only the issued TLS
  address; `issued` keeps UDP, TCP and TLS, so a browser would use UDP where
  it works. R65's records also show (inferred, no holder identity recorded)
  receiver-1 waiting on a same-quality link that was never ahead, with
  neighbour discovery making no checks, while receivers 2 and 4 got haves
  but no high transfer fitted their budget. Record:
  `artifacts/link-throughput-bench-20261020/FINDINGS.md`. Awaiting the
  user's decision.
- **Field probe: one TLS relay link through Till runs at 3 to 4 Mbit/s, and
  UDP relay does not help (20 October, 21:38 to 22:19 UTC).** The user
  approved the single-link probe ("do it"). Holder Chrome on M1, receiver
  Chrome on M4 in a fresh profile over SSH, relay-only through the shared
  TURN service with one issued URL per cell, both Macs on Wi-Fi with no
  tunnel, one fresh issuer credential per repetition (values not recorded,
  files deleted). Nothing in the pilot, consent or Till changed. A high
  segment ran at a median 3.15 and 3.8 Mbit/s over TLS and 4.2 and
  3.35 Mbit/s over TCP, 18 of 18 requests each, losing 0.2 to 0.6%. UDP ran
  at 3.35 Mbit/s with 1.6% loss; in a second cell the holder's 3 s drain
  deadline closed the link after 7 of 18 requests, and the smoke check lost
  7.7%. The path was jittery (ping spread 64 to 149 ms) and background
  traffic was not controlled; M4's load reached 70 from the owner's work in
  one cell. Two repetitions completed; a third and a first attempt stopped
  at the M1 quiet gate. So R65's 2.1 Mbit/s comes from what the qualifier
  adds (concurrent uploads sharing the house uplink, 11 roles on M4's
  Wi-Fi, admission, loss under load), not from one TLS link, and switching
  to UDP relay addresses is not supported. Cleanup proved on both Macs.
  Record: `artifacts/link-throughput-bench-20261020/FINDINGS.md`. Awaiting
  the user's decision.
- **v0.2.0 published as an experimental GitHub prerelease (21 October,
  about 00:25 UTC).** The user said "commit push merge ship" and chose a
  v0.2.0 prerelease. The handover docs and a release-preparation docs commit
  (`fd046f5`) passed all nine required CI jobs; PR 8 merged as `bf43940`
  (merge commit, tree identical to `fd046f5`), whose main CI run 39514327948
  also passed. Annotated tag `v0.2.0` points to `bf43940`. Assets (tarball,
  standalone bundle, `SHA256SUMS`) were built from a clean archive with the
  recipe that rebuilds v0.1.0's bundle byte for byte, then downloaded from the
  public URLs and verified; see [Status](STATUS.md#release-verification).
  Field gates stay open: the qualifier is RED and the pilot still runs
  `5f2ece0` without the release's clock-skew diagnostics. No npm publish.
- **R60 is RED on the same single gate (19 October, 15:34 to 15:40 UTC).**
  Source 46494d5, Till app 124e3bcc unrestarted, 3 roles on M1 and 11 on M4,
  302 s measured, both Macs on the LAN with no VPN carrying the default route.
  15 of 16 gates passed; `each4BothQualityPeer` failed (only receiver 2 had
  both qualities from peers). 3 of 309 high-quality peer requests completed,
  none of the 236 that started with under 1100 ms left; 14.2 MB verified peer
  media against 189 MB uploaded. Removing the VPN did not rescue the gate on
  this source. Launch deviation: R59's M4 connect bound (45 ms) was set on the
  VPN path; without it both Macs connect in a steady 57 to 71 ms, so the launch
  used that baseline, recorded in the authorisation. The checkout was detached
  at 46494d5 for the run and restored (checksums matched). Cleanup confirmed on
  M1, M4 and Till; the Till control directory keeps its journal like R57 to
  R59. The app health check fails whenever no source is publishing, which is
  idle state between runs. Result:
  `artifacts/distributed-fourteen-qualifier-46494d5-r60-result-20261019.json`.
- R58 and R59 cleanup were confirmed by Root fresh read-only checks on M1, M4
  and Till; the formal independent cleanup review method (R55 lineage) was not
  rebased.
- Scope: steps 1 to 3 used one M1 Chrome against the live pilot over the real
  network. They do not test multi-viewer peer delivery (P01).

Deviations to keep visible: the CI receipt
`artifacts/ci-46494d5-39180173046-20261019/ci-terminal-success.json` was changed
from mode 0644 to 0600 (contents unchanged; the frozen P05 index still pins 420).
P05 used a bound copy (`artifacts/p05-46494d5-source-bound-20261019`) with `-r2`
data/result paths after attempt 1 refused at local input pinning
(`artifacts/p05-46494d5-root-run-attempt1-20261019.json`, no host action). Intake
pure r1 failed on a Root seal-order fault; r2 and r3 passed. The P07 root driver
(`artifacts/p07-46494d5-root-driver-source-20261019`) is new: 24 counted edits to
the R4 driver, dropping the negative handover. The OWN and native review sources
are identity rebases of the 3f706a9 versions.

## Progress on 21 October 2026 (source 140c256)

Source `140c256` is on `fix/holder-discovery` ([PR 9](https://github.com/forgesworn/relayswarm/pull/9),
open, unmerged): holder labels in local diagnostics (`368b860`), then the fix
that stops a never-ahead holder suppressing neighbour discovery. Paths are
relative to a checkout holding the local `artifacts/` tree.

| Run | Verdict | Evidence |
|---|---|---|
| CI, fresh consumer, deployment, deployment review | PASS: nine required jobs in [run 39529800310](https://github.com/forgesworn/relayswarm/actions/runs/39529800310) (attempt 2 reran only the hls.js playback job after a runner apt 403 before any test step); 286 package members from the committed source; independent deployment review | `artifacts/cycle-140c256-record-20261021.json`, `artifacts/ci-140c256-39529800310-20261021/`, `artifacts/clean-consumer-140c256-20261021/package-review.json`, `artifacts/independent-deployment-140c256-review-20261021/review.json` |
| P05 reporting lifecycle | PASS, natural expiry 303,923 ms, reporting restored off | `artifacts/cycle-140c256-record-20261021.json` |
| P07 parent crash | PASS, independent native review | `artifacts/cycle-140c256-record-20261021.json` |
| R66 short qualifier | GREEN, 16 of 16 gates, 302.823 s, including `each4BothQualityPeer` and `all8ActuallyUploaded`; first green fourteen-role qualifier | `artifacts/distributed-fourteen-qualifier-140c256-r66-result-20261021.json` |
| R66 wire and cost | Receivers used 31.5% less origin traffic than matched baselines; TURN host carried about 319 MB egress; marginal cost not determined | `artifacts/r66-wire-cost-20261021/HOST-CHECK.json` (its correction governs over `WORKER4-REPORT.md`) |
| R37 sustained | RED at the first churn event on a harness assertion about retained renewals | `artifacts/distributed-long-three-eleven-140c256-r37-result-20261021.json` |
| R38 sustained | RED after 640,110 ms of measurement; first failure is a harness race in `rejoin()` (read 7 ms after clicking Start, before the page applied its settings; diagnosis confidence high) | `artifacts/distributed-long-three-eleven-140c256-r38-result-20261021.json`, `artifacts/distributed-long-three-eleven-140c256-r38-result-addendum-20261021.json` |
| P06 3 MB shared-cap lifecycle | RED, `RED_HIGH_QUALITY_NO_VERIFIED_COMPLETION_BEFORE_SHARED_CAP_REFUSAL`; finite-source cleanup review PASS | `artifacts/p06-140c256-result-20261021.json`, `artifacts/p06-140c256-result-addendum-20261021.json`, `artifacts/p06-140c256-result-addendum-2-20261021.json`, `artifacts/p06-140c256-red-diagnosis-20261021/DIAGNOSIS.md`, `artifacts/p06-140c256-user-decision-20261021.json`, `artifacts/independent-p06-140c256-source-cleanup-review-20261021/review.json` |
| Desktop D1 Firefox 152.0.6 (M1) | PASS, six of six checkpoints; 663,828 B verified peer at the receive checkpoint, 413,600 B uploaded | `artifacts/desktop-journeys-140c256-result-20261021.json` |
| Desktop D2 Safari 17.6 (M1) | RED: no verified peer download within 45 s, no selected ICE candidate pair; cause not determined; not retried | `artifacts/desktop-journeys-140c256-result-20261021.json` |
| Desktop D3 Safari 26.6.2 (M4) | PASS, six of six checkpoints; 667,212 B verified peer, 213,004 B uploaded; first Safari pass | `artifacts/desktop-journeys-140c256-result-20261021.json`; finite-source cleanup review PASS in `artifacts/independent-desktop-140c256-source-cleanup-review-20261021/review.json` |

Pilot app after P07: `38eb5c2d`, started 02:59:29 UTC, reporting and forwarding
off; served client 787,462 bytes. Repo-tracked summary:
[checkpoint record](../spikes/results/140c256-current-delivery-checkpoint-20261021.json).

Findings for the next agent:

- **R66 was run at the R65 profile** (contributors at 1,250,000 B/s, four
  neighbours, relay-only TURN over TLS/TCP, no VPN tunnel on either Mac, checked
  by the authorisation) on the rebuilt source. It is a short desktop-class
  result; it says nothing about 7,200 s, devices or a separate network.
- **TURN is a separate host from the origin.** The origin served about 226 MB
  less than all-origin delivery over R66's 302 s window, but total egress across
  both hosts rose by roughly 85 to 100 MB. Do not describe this as a bill
  saving: the hosts' plan terms are not recorded.
- **R38's rejoin race is a harness fault.** `rejoin()` in the long lineage reads
  the actor straight after clicking Start; the page applies settings
  asynchronously. A fix needs its own review cycle and a new run. No earlier long
  run reached a rejoin, so the rejoin itself has no evidence either way.
- **P06's role summary fields do not update.** Do not cite `videoQualities`,
  `verifiedPeerQualities`, `zeroFrameIntervals` or `contributionWithdrawn` for
  P06 or a416f7e; the observer never assigns `measurementStarted`. Use the raw
  samples.
- **P06 is a design limitation, not a product defect.** The shared allowance
  behaved as documented in [Account upload budget](ACCOUNT-UPLOAD-BUDGET.md).
  About 660 KB high-quality segments did not complete within the receiver's
  buffer-safe wait on the relay path (about 255 KB/s on the best link), so three
  accepted reservations consumed the cap before the fourth was refused.
- **Decisions.** The user chose to record Item 5 and P06 as RED and open and to
  move on; P06 is not to be re-run on this source.

## Next work, in dependency order

Position on 21 October 2026: v0.2.1 is a published experimental GitHub
prerelease of merge commit `1d54538` (PR 9), deployed to the pilot (app
`ce410033`). Its loader source `140c256` passed CI, consumption, guarded
deployment and its review, P05, P07 and the short qualifier R66 (GREEN, 16 of
16). The owner decided to publish v0.2.1 with Item 5, P06 and Safari 17.6 RED
and open, as v0.2.0 shipped with its qualifier RED. Those items stay RED and
open. Release and deployment evidence is in
[Status](STATUS.md#release-verification).

1. **PR 9 is merged and released as v0.2.1.** The next finite source or
   deployment chains on the `1d54538` deployment's independent cleanup review.
2. **Item 5, the sustained 7,200 s run (RED, open).** Fix the harness `rejoin()`
   race and prove the fix in its own review cycle, then run on the same qualified
   source, topology and profile: 7,200 seconds, 22 churn events, two
   3,600-second windows and natural TURN expiry/renewal under unchanged limits.
   Do not shorten the run or substitute fake credential expiry. Only the user
   decides to resume it.
3. **P06, the 3 MB both-quality shared-cap lifecycle (RED, open).** Re-running
   the same scenario on this source is not wanted. Any further attempt needs a
   scenario or throughput change that the user chooses, and the result must not
   be cited through the dead role-summary fields.
4. **Remaining browser, device and network coverage (open).** Safari 17.6
   desktop is RED with the cause undetermined. Physical iPhone is unavailable;
   physical Android and device Safari/Firefox need the owner; hard NAT and a
   separate network need another network. Report each as open until it passes.
5. **Cost.** Marginal cost on the hosts' plans is not determined. Record the
   plan terms before any cost statement; distinguish saved traffic from actual
   marginal cost.
6. **Releases.** v0.2.1 is published, its downloaded assets verified and its
   merge commit deployed. Keep the v0.2.1, v0.2.0 and v0.1.0 tags and assets
   unchanged. npm publication is out of scope.

The short and long builders are prepared source. Review their changes and pure
checks before materialising them. Frozen source manifests must remain intact:
make a fresh copy when binding new evidence.

## Known failures to retain

- Item 5: R37 and R38 are RED. R37 failed at the first churn event on a harness
  renewals assertion; R38 failed on the `rejoin()` race after 640,110 ms of
  measurement. The 7,200 s run has not completed on any source.
- P06 on `140c256` is RED with high-quality delivery unverified before the shared
  cap refused a reservation (same class as the a416f7e third run). Public
  shared-account API and the focused LOW lifecycle passed earlier.
- Safari 17.6 on the desktop is RED on `140c256` (no verified peer download, no
  selected candidate pair, cause not determined). Earlier Safari REDs (f393abf,
  2dd156e) and Firefox and Safari results at a023 stay history.
- Earlier short-qualifier REDs R54 to R65 stay on record as history. R66 is the
  first green run and does not change them.
- Simulator playback/resume passed but did not reproduce the physical iPhone's
  stopped-video fault. It cannot close physical iPhone recovery acceptance.

## Evidence and prepared sources

Paths below are relative to this checkout. `artifacts/` contains local evidence
and private operational material; it is not generally available in a fresh
GitHub clone. An agent on another machine needs the relevant reviewed evidence
as well as this document. Do not publish credentials or copy the whole private
artifact tree into a public handover.

| Purpose | Local path |
|---|---|
| Mutable session checkpoint; includes historical values | `artifacts/resume-20261016-root-checkpoint/checkpoint.json` |
| Exact-source CI receipt (current, 4178c26) | `artifacts/ci-4178c26-39284440433-20261019/ci-terminal-success.json` |
| Fresh consumption (current) | `artifacts/clean-consumer-4178c26-20261019/package-review.json` |
| Actual deployment, lifecycle and cleanup (current) | `artifacts/deployment-4178c26-peer-cancel-20261019/` |
| Independent deployment review (current) | `artifacts/independent-deployment-4178c26-review-20261019/review.json` |
| Positive P05 and independent review (current) | `artifacts/p05-4178c26-run-r2-20261019/`, `artifacts/independent-p05-4178c26-positive-own-review-20261019/review.json` |
| P07 attempt 1 (RED) and operator recovery | `artifacts/p07-4178c26-root-run-attempt1-20261019.json`, `artifacts/p07-4178c26-operator-recovery-20261019.json` |
| P07 r2 actor source, run and native review (PASS) | `artifacts/parent-crash-p07-4178c26-r2-source-preparation-20261019/SOURCE-PINS.json`, `artifacts/p07-4178c26-r2-result-20261019.json`, `artifacts/independent-p07-4178c26-r2-positive-native-review-20261019/` |
| Short qualifier R61 (RED), preparation and result | `artifacts/distributed-fourteen-qualifier-4178c26-r61-preparation-20261019/`, `artifacts/distributed-fourteen-qualifier-4178c26-r61-result-20261019.json` |
| Previous candidate 46494d5: CI, deployment, P05, P07 and R57 to R60 | `artifacts/ci-46494d5-39180173046-20261019/`, `artifacts/deployment-46494d5-live-playlist-retry-20261019/`, `artifacts/p07-46494d5-run-20261019/`, `artifacts/distributed-fourteen-qualifier-46494d5-r60-result-20261019.json` |
| Long qualification, source only | `artifacts/46494d5-long-r35-builder-source-20261019/SOURCE-PINS.json` |
| Final recovery unit results | `artifacts/recovery-root-unit-final-r2-20261019/RESULTS.json` |
| Full-controller retry results | `artifacts/demo-live-playlist-retry-final-full-chain-green-20261019/RESULTS.json` |
| Real Chrome recovery/cancellation/deadline binding | `artifacts/network-retry-real-browser-20261019/treatment-final-r2/COMMITTED-COMPONENT-BINDING.json` |
| Older actual P05 pass and independent review | `artifacts/p05-3f706a9-run-20261018/`, `artifacts/independent-p05-3f706a9-positive-own-review-20261018/` |
| Older actual P07 failure and cleanup | `artifacts/p07-3f706a9-run-r4-20261019/` |

Recorded runtime anchors for recognising drift:

```text
source: 4178c2602e6ca04dadf8b9d760de852888bcbe32
image: sha256:faa4520b24b665ac0fb59b56ee00af87ba99aacccf8ecb27c18acde05048988d
client: 777134 bytes
client SHA-256: a8d22a0b549440ca6a10ebfa1ce010972dc8e5c3a4707ebe521e78f553fad155
runtime-contract.json SHA-256: c4150172693e000f2c9ae7b74207b007eb202c098871f6cc298846c12798305b
live app after P07 r2: 7d0ae914e13d3d2a7c9e8ebeaa62269f80fba802fb81afd614604fe60c1828ea (started 2026-10-19T19:24:20Z)
```

Prepared review/test directories include their own README, manifests and bounds.
Read them before execution. Null future results or synthetic pure-test inputs
are not live proof. Use current provenance and private input pins; do not run an
old bound command against a replacement container.

## Working constraints and reporting

- Other jobs on M1/M4 must keep running. Do not kill unrelated processes, ask the
  owner to pause their work, or raise resource/process limits to make tests pass.
- The physical iPhone is currently unavailable. Continue independent work and
  leave that acceptance item explicitly open; do not repeat unlock/cable requests.
- Preserve explicit upload/reporting consent, spent quota, private publisher and
  account state, permanent lease inodes, and the independent router/proxy.
- The recorded pilot uses relay-only TLS/TCP TURN through the existing service,
  admission address limits of 32 tickets and 900 requests, and four demo
  neighbours. The SDK default remains six. Recheck the runtime contract rather
  than silently changing this profile or treating it as six-neighbour capacity.
- Restore any test-owned temporary privacy, reporting or network changes. Stop
  owned fixtures/browsers/emulators and remove owned scratch after retaining
  evidence. Leave the permanent pilot/router/proxy running intentionally.
- Keep the original acceptance windows and cleanup reserves. Failure or resource
  pressure calls for diagnosis, not relaxed requirements or erased fatal records.
- Preserve supported-media boundaries. A custom ABR engine, DRM/SAMPLE-AES,
  durable media storage and an accepted RelaySwarm NIP are not existing features.
- Report each result with source, runtime, topology/device, duration, verdict,
  evidence path and cleanup. Separate implementation, local tests, CI, deployment,
  physical acceptance and publication. Report actual progress and remaining gates
  plainly; do not present another preparation pass as completed field acceptance.

Start with `git status --short --branch`, refresh `origin`, and confirm the PR
head before relying on this snapshot. For documentation edits, update authored
Markdown and `llms.txt`, then run `npm run docs:generate` and
`npm run check:docs`. Node 22.13+ is required; CI uses Node 24. Preserve all
unrelated work and follow the repository's resource-cleanup instructions.
