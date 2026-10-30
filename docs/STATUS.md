# RelaySwarm evidence and remaining work

[Documentation](README.md) · [Field-test guide](FIELD-TEST.md) ·
[Changelog](../CHANGELOG.md)

Checkpoint: 24 October 2026. The prepared experimental shared-core prerelease is
[v0.4.4](https://github.com/forgesworn/relayswarm/releases/tag/v0.4.4).
The [changelog](../CHANGELOG.md#v044-24-october-2026) records its source changes;
the [installation guide](GETTING-STARTED.md) describes JavaScript/WASM and
native downloads and checksum verification. The npm registry is unpublished.
Earlier release and pilot evidence below retains its date and source.

## Private LAN two-viewer field result for the size-aware build (30 October 2026)

One authorised private attempt ran the exact b102ff4 SDK and worker on the
unchanged public site, as two headless Chrome contexts on one M4 with native
host candidates, controlled in-process signalling and a cold browser cache. No
TURN, operator or public rendezvous was involved; the owner deferred the
TURN-over-TLS route gate to a separate test and left every other gate as it was.
Viewer 0 reached a trusted 3840x2160 frame in 3.899 s and the late joiner in
10.613 s. Both played 340 s with zero stalls, player errors, dropped frames or
waits, advanced 339.29 s of media each, passed a natural wrap with 83 s observed
after it, and kept native sample gaps at or below 1.02 s. The late joiner
accepted 13.63 % of its media from the leader (146,257,386 bytes) over a
host-to-host link measured at 12.7 MB/s; its planner-selected startup futures
were won by the existing cached and late peer races because the leader already
held them. The leader accepted 1.91 % (21,021,971 bytes) from the late joiner,
below the unchanged 5 % per-viewer gate, so the combined audit is RED on that
one criterion and PASS on playback, observation and route evidence.

An earlier labelled smoke under heavier machine and link load failed the late
joiner's 12 s startup at 1.5 to 1.9 MB/s from the origin with zero peer bytes:
peer-first has no wait budget during startup and the leader then held only the
fragments the planner had to skip. That structural lead (peer-aware startup
admission, link-aware upload pacing) is recorded with the packet; it is not
built. This result is one Mac behind one link; it is not public, NAT, TLS
relay route, physical phone or merge qualification.

## Unreleased frontier-aware future source election (30 October 2026)

The private LAN two-viewer run above ended with the leader yielding 162 optional
future objects and the late joiner 70, while the late joiner accepted 13.63 % of
its media from the leader. The rank rule in the optional future source election
ignored which viewer was ahead: when the leader lost the object-key XOR it
yielded to a peer that, being behind, could not fetch the object before the
leader's own deadline, so the leader fetched it from the origin anyway.

The election now drops any peer whose advertised objects end more than one object
behind the candidate. The manager maps object keys to positions only through
signed permits it resolved itself (at most 512, entries older than 60 s
ignored). A peer's frontier is derived when the election runs, as the largest
sequence number among the keys it currently advertises that map to a known
position; nothing is stored per link, so a HAVE that arrived before the local
authorisation of that object counts once the object is authorised. A peer with
no mapped key stays in the election, as does one still advertising an old high
sequence number after a wrap. When every peer is behind the viewer proceeds.
`warmAhead.peersBehindProceeds` counts election decisions the exclusion turned
into a proceed where the rank rule over all candidates would have skipped; the
hook can decide again for one object and warm-ahead can still decline it, so the
count may exceed the objects fetched. No wire message, core or WASM file
changed. A first version stored a frontier per link at HAVE arrival; independent
review showed it kept a stale view when the HAVE came before the local
authorisation, so the late joiner could exclude the leader wrongly and fetch
from the origin, and it was replaced by the derivation above.

Proved: the controlled two-actor fixture on the real core shows the behind peer
excluded, the adjacent peer still deciding by rank with its descriptor retained
and exact-HAVE reconsideration unchanged, an unknown frontier keeping today's
yield, an exact HAVE still proceeding uncounted, an older high key keeping the
peer a candidate, the early-HAVE case above, and that another rendition's
objects give no frontier. The behind/adjacent, unknown-frontier and exact-HAVE
cases run with either actor as the evaluator; the rest run with one. The
512-entry bound and the 60 s window are proved by a direct unit test. Not
proved: any field effect. The expected effect in a two-viewer shared-position
room is that the leader's `sourceYielded` falls while the late joiner is behind,
its promotions fall, and its lead is kept, so the late joiner's accepted peer
share should rise. The leader's own accepted peer share does not rise and may
fall; the 5 % per-viewer gate for the leader is a gate-wording decision, not
something this change targets. Yields fall but need not reach zero, since level
viewers still decide by rank. Nothing here changes a remote forced-relay
topology where every peer byte crosses one link twice. A new private field run
is required.

## Unreleased size-aware startup admission (30 October 2026)

The private 4K failure below followed a request order of SN1, SN4, SN6 and
SN7 under an advancing room target. The scalar planning lead treated every
candidate as costing the last whole-load time, so the planner skipped two
smaller reachable fragments, admitted the largest one, and its longer service
raised the measured recovery requirement beyond what the remaining lifetime
could cover. Startup now keeps one frozen same-origin service profile (first
byte and body time of a verified complete source body, reported as
`startupBuffer.sourceProfile`) and, when a candidate's origin has one, defers
the skip decision until that candidate's own signed size is freshly authorised,
projecting its service from the measured profile. Peer-delivered, cached
same-instant, partial, aborted, non-200 or different-origin responses form no
profile, and a later verified future without valid timing clears it, returning
admission to the previous scalar rule. Parsed identity is still checked before
authority; frozen windows, contiguous extensions, the one-hop-per-poll budget,
reservations, release headroom and the original deadline are unchanged.

An offline replay of the retained viewer-1 capture, using its catalogue sizes
and measured SN1 timing, now requests SN1, SN5 and SN6 and releases before the
deadline under the named conditional service rates; the scalar seed's earlier
adverse scenario stays green, the slowest observed rate remains an honest
failure, and the invalid-timing, peer, cache, mutation and other-origin
controls preserve the previous policy. Unobserved fragment service costs are
still assumptions. This is a logical scheduling change with synthetic bodies and
always-current permits; it is not field throughput, decoded playback,
contribution or device evidence, and fresh CI plus a new private field run
remain required.

## Unreleased refresh after whole-object capacity rejection (30 October 2026)

A measured peer rate can fit one signed piece while remaining too slow for a
whole object. That case previously kept rejecting peer-only work until the
measurement expired, even after the existing refresh cooldown had elapsed.
Genuine demand can now use that existing refresh opportunity on one captured
holder. Stored measurements remain intact; the per-transfer trace explicitly
identifies the calibration. Warm speculation is excluded, source HTTP still
starts immediately, and the original cooldown, absolute peer deadline, resource
limits, integrity checks and deferred credit remain unchanged.

A controlled regression first failed on the previous source. With actual signed
pieces and the committed Core, a simulated paced channel establishes a slow
measurement, becomes faster, then refreshes after the original ten-second
cooldown. Only the fully verified six-MiB winner earns accepted credit, and the
following request uses its newly measured flow. This uses a logical controller
clock and simulated channel pacing; it is not native-network throughput, a
field contribution result, or a fix for the startup failure below. Fresh CI
and field acceptance remain required for this source change.

## Current private 4K startup failure (30 October 2026)

At `f2ca77f`, all 21 required main CI jobs and both realtime jobs passed,
including browser transport against live relays. A fresh two-viewer private M4
field run on that exact SDK remains **RED**. Viewer 0 reached a trusted
3840×2160 frame in 5.593 seconds. Viewer 1 never reached its first frame: its
original twelve-second startup-manager deadline expired, followed by
`fragLoadError`. The sustained observation and contribution tests never began.

Viewer 1 verified 20,414,494 bytes, but these bodies did not form enough
contiguous video ahead of the advancing room target. At two retained checkpoints,
forward coverage was 717ms and 1089ms; both fall below even the original
two-second minimum, as well as the measured 5496.25ms recovery requirement.
Reducing that estimate would not justify release. The live future-ownership path
did execute (`sourceYielded: 3`), but field performance benefit is unproved.
The measured peer model also rejected whole-object transfers that did not fit;
no faster peer capacity is established by this capture. A bounded manager replay
reproduces the observed request order and deadline failure. Seeding the forecast
with the first body's service duration conditionally helps, but another explicit
rate scenario makes that candidate regress. Unobserved fragment service costs
remain unknown, so that heuristic has not been adopted as a product fix.

Both automatic private credential requests returned successful, valid leases.
This does not qualify public visitors: the deployed public page has no issuer or
TURN route configured, and its older SDK does not include the candidate's local
candidate retry API. An independent authorised operator and actual public TLS
connectivity, lease renewal and recovery checks remain necessary. The owner's
paired Archy relay stays private; the temporary listener did not change it.

All 32 sealed files were independently rehashed (1,805,381 bytes total; 622,958
largest). Owned browser profiles, host and browser stages, rendered credentials
and the archive were removed, with the paired relay and firewall unchanged.
The new rejection is retained alongside all 22 earlier failed or incomplete
receipts. Older physical iPhone evidence does not qualify this revision. No
candidate has been deployed, and the full goal remains incomplete.

## Unreleased fixture operation and metadata boundaries (30 October 2026)

At `24bb6a7`, 15 required main jobs and both realtime jobs passed; five main
jobs failed, including two dependent aggregates, and the required live-relay
job skipped. The new late-NEW control conflated an original warm allocation
with a later genuine cache-recovery allocation. A separate ordinary native
positive safely declined at 26ms and completed six MiB from HTTP200, failing
its strict206 assertion. Windows also failed complete-client-body and later
cooperative source-path assertions. Its exact extra source row was not
recorded, so the route and cause remain unknown. This run and all earlier
failures remain RED; nothing is rescored.

The setup proof now closes at the existing verified warm-body boundary before
another genuine request begins. It retains the original timer, load, geometry
and source-budget values, full current trace/RPC/I/O and original baseline.
Ordinary native cases gain no wait or loader call. The strict validator stays
byte-identical, and unresolved records still fail. The controlled NEW reply
remains held through complete body verification, then is released before the
subsequent genuine and repeat consumers. All later body/hash, deadline,
callback, source-byte and accepted-once credit assertions remain mandatory.
This is an operation-scoped setup proof, not a claim that the entire later
session has no independent recovery work.

The native comparison fixture now prepares real publisher signatures for its
exact fixed context identities before loading/calibration. It preserves event
content, identifiers and original expiry, calls the provider on each request,
and retains native client key hashing, verification and Core work. It seeds no
media, HAVE, timing model or SDK authorisation verdict. The actual public demo still
signs commitments locally per request; this prepared supplier is a functional
fixture, not a reproduction of that signing workload or a native performance
benchmark. Publisher signing was measured separately on a local M1, not at the
CI failure; it is not an established unique cause of the 26ms decline.

Logical policy controls share the existing bounded segment-key digest observer:
only exact-namespace SHA-256 inputs of at most 4096 bytes hold logical time while
the real digest completes. Real inputs, results and rejections are retained;
payload hashes and ordinary native clocks are unchanged. The original two-second
native-work bound and forced 25ms decline/cancellation controls remain. A fixed
40ms native key-delivery control first produced excess source-plus-peer bytes
under the old logical clock, then passed with that metadata phase observed.
This is a controlled scheduling contrast, not reconstruction of Windows' missing
source row. Current `f2ca77f` CI passed; private field, public-operation and physical
iPhone acceptance remain required. No candidate has been deployed.

## Unreleased live future ownership (30 October 2026)

The previous optional source election required a parsed VOD playlist. The demo's
recorded-live playlist generator emits rolling windows without ENDLIST. A new
two-SDK regression using the actual Hls parser first reproduced both viewers
starting the same future whole-source request for `live: true`, while its VOD
control elected distinct owners. Optional election now accepts explicitly
parsed boolean live state, retaining ordinary loading when that state is unknown.
Genuine live rendezvous, startup, source deadlines, resource bounds and credit
rules are unchanged. The focused control verifies opposite future owners,
actual HAVE reconsideration and mixed Core consumption after a live parser
refresh. Its source/RTC are simulated and its controller clock is logical;
this is functional evidence, not a field throughput or physical-phone result.

An earlier actual private M4 field used preceding source `bdf0e80`, whose 21
required main CI jobs and both realtime jobs passed. Both trusted 4K first frames
arrived in 4.798s / 3.918s, but the field is **RED**: accepted peer media was
4,038,216 / 98,304 bytes (0.392668% / 0.008865%), below the original 5% and eight-MiB
requirements. Viewer 0 also recorded five stalls (12.5663s), six player errors,
36 dropped frames and only 326.677077s media advance; viewer 1 advanced
339.306767s with zero health events. Actual observation was 340000.164ms
monotonic / 340035ms wall, with natural wrap plus 79.305s. Both observed HTTP
captures are complete. Succeeded selected relay/TLS pairs existed at both
boundaries, but connections changed; full-window route retention is unproved.
Temporary resources and credentials were removed and the paired private relay
and firewall were unchanged. The failed capture is retained without rescoring.

Retained diagnostics show one mixed load finishing about 34ms beyond its fixed
mixed-completion deadline; that reserve remains intact. No source yields or
HAVE reconsiderations were observed in that field. These facts motivate the
live-playlist correction but do not establish a unique stall cause or prove
the correction improves field playback. Fresh current-source CI and private
field qualification, independent public TURN operation and physical iPhone
acceptance remain open. No new candidate has been deployed.

## Unreleased reachable startup window (29 October 2026)

Startup forecast skipping now preserves the last parsed future reachable within
the original remaining lifetime at normal room-clock speed. Two already
verified contiguous futures ahead of the target can use the existing fourth
slot when their start remains reachable and their span is shorter than measured
recovery. Admission estimates never substitute for fresh actual-target coverage
and authority at release. Byte limits, serial requests and the original
twelve-second/shorter-parent deadline remain unchanged. A host lookahead that
changes the queued context cancels before authorisation or source loading.

A logical scheduling regression first fails on the preceding source in all
three feasible cases. It retains the later private test's observed geometry,
SN1/4/8/9 service scalars and recovery requirement. Only the previously
unrequested SN7 completion is hypothetical; the bodies are four-byte fixtures,
not decoded media. Slow SN7 cases must still fail at the original deadline.
All 216 warm/startup checks pass, including unverified/gapped/unreachable
windows, aggregate byte and reservation refusal, and callback cancellation.
Two earlier scheduling expectations now describe the intentional reachable
window/fourth-slot behaviour while retaining their original parent limits
and explicit actual-target recovery assertions.
These controller checks do not establish throughput, useful peer contribution
or physical-device playback. The subsequent private field observation below
records the current runtime's measured result.

## Private reachable-startup field observation (29 October 2026)

Full [e2e CI](https://github.com/forgesworn/relayswarm/actions/runs/40964038776)
and [realtime CI](https://github.com/forgesworn/relayswarm/actions/runs/40964038705)
passed at `399ab4f`. Its runtime objects equal the compiled `a85f8134` candidate.
The previously intermittent HTTP-renewal and browser credential-rollover checks
passed in this run; their earlier failures remain unexplained.

One fresh, restricted private Spry test on the M4 produced trusted 3840×2160
first frames in 4.93 and 7.95 seconds. Both viewers completed 340.002 seconds
of monotonic observation and 340.015 seconds of wall observation, advancing
339.29 and 339.23 seconds through natural track wrap and another 79.8 seconds.
Neither recorded post-qualification waiting, stalls, player errors or dropped
frames. Automatic credentials and literal selected succeeded local relay/TLS
and remote-relay pairs were observed at both original boundaries.

The overall verdict remains **RED**. Accepted peer media was 294,912 and
5,544,673 bytes: 0.02645% and 0.5054% of accepted peer plus loaded source media,
below the original 5% and eight-MiB requirements. Viewer 1 also exceeded the
HTTP recorder's 131,072 data-event cap; later body events were not aggregated,
so its inclusive HTTP total remains unknown. These observations establish
neither traffic savings nor a physical-phone, public-default or NAT result.
The original failed receipt remains unchanged. All 32 sealed files were
reverified; temporary relay, browser profiles, raw credential input and rendered
secrets were removed, with the paired private relay and firewall unchanged.

## Unreleased exact-HAVE reconsideration (29 October 2026)

A focused two-SDK/Core fixture reproduces a missed optional opportunity:
the elected owner verifies an object and delivers its exact HAVE, but an idle
viewer that previously skipped that future starts no warm work. The same
object then completes on genuine demand using 327,680 verified peer bytes and
720,896 source-range bytes, with no duplicate whole GET. This uses simulated
source and native RTC; it proves the source-policy opportunity, not field
causality or throughput.

Skipped futures now retain at most two metadata-only routing descriptors.
An exact added HAVE can reconsider each once within its original deadline,
through fresh context, authority, holder and resource checks. Deferred work
keeps the one-shot marker. This adds no timer, source wait or playback credit;
genuine demand remains independent. A fresh field measurement is still needed
to establish whether this change meets the original contribution requirement.
All 15 manager guards and the complete 231-test manager suite pass. Eight
scoped SDK/Core controls pass, including idle mixed assembly with deferred
credit, pause and constructor-time supply withdrawal, the earlier reciprocal
owner case, full six-MiB main/Worker positives and capability fallbacks. These
are functional controller/protocol checks, not native throughput measurements.

The subsequent `cc6df86` e2e run remains failed: macOS passed 939 of 940
checks, and the Windows mixed partition passed 46 of 47. A native local
reproduction exposed a purely speculative HAVE retry falling back to a whole
GET after its original 25 ms setup decline. The reciprocal protocol fixture
deliberately held that unexpected whole body, so genuine demand later joined
it and reached the unchanged parent timeout. That reproduction establishes
the local mechanism; the original Windows log lacks that internal trace.

Purely speculative reconsiderations now abandon work on mixed admission
failure instead of duplicating the owner's completed body. Cancellation marks
the outer row retired before abort callbacks can reenter genuine demand.
Controlled tests first observed one unwanted whole GET, then zero with this
change. Genuine promotion keeps normal fallback with the original reduced
parent; callback-reentered genuine demand starts its own ordinary source path.
Six focused cancellation controls and all 237 manager checks pass.

The macOS failure records allocation replying before the setup cutoff, no
START RPC or optional I/O, and the original timer firing afterwards. A separate
strict captured-input proof recognises that ordering; the existing pending-RPC
proof is unchanged. Its 54 hostile controls reject incomplete or contradictory
inputs. An unchanged native Worker check subsequently completed exact mixed
assembly and the original whole-body/hash/callback assertions. Neither that
run nor the classifier rescored the earlier CI failure; its internal scheduling
delay remains unknown.

The reciprocal owner/mixed protocol fixture now uses an explicitly functional
controller with its original payloads, deadlines and assertions. Its logical
clock is installed before its SDK sessions so callback-driven stop can clean
up those same timers. All six native six-MiB cases and both ordinary native
warm callsites remain unchanged. The final 22-case selection passes, including
those native cases, mandatory main/Worker assembly and the ownership/proof
controls. These results still require fresh CI and field qualification.

## Setup-proof and native CI scheduling correction (29 October 2026)

The `a007c07` hosted run passed its reciprocal future-owner and existing
main/Worker warm mixed positives. Its required CI verdict still failed:
macOS rejected a protected setup decline that allocated and freed a Core
transfer before any start or I/O; Ubuntu reached its ten-minute job limit
although all reported test steps had passed. Those original failed/cancelled
results remain unchanged.

The test-only proof classifier now recognises that exact same-load pre-start
allocation-abort shape. It still requires the original setup cutoff, all other
current predicates, zero transfer starts, attempted ranges, peer requests and
accepted credit, plus correctly reduced source deadlines. An immutable CI-input
regression first fails with the old helper; 14 focused controls then pass,
including 34 rejecting mutations, all six real-clock six-MiB cases and the
mandatory actual Core/Worker mixed positive. Application code, clocks, budgets
and the required actual range-transfer assertions are unchanged.

Publisher tests now run separately on each original Ubuntu/macOS platform.
The required per-platform checks require both the original native suite and
publisher job to succeed, rejecting failed, cancelled, skipped or missing jobs.
Original commands, platform coverage and job caps are retained; Windows
partitions remain unchanged. In the `897927f` hosted run, Ubuntu and Windows
required gates passed, along with both publisher jobs, browser playback,
Core/package checks and realtime transport. The overall e2e verdict failed:
one macOS warm/Worker positive required mixed admission even though its
optional 25 ms setup timer had already selected whole-source recovery. That
capture lacks enough timer and invocation metadata to prove a protected
decline; it remains failed. No field result is qualified by these CI checks.

The follow-up test-only correction separates mandatory mixed assembly from
optional real-clock admission. Full six-MiB main/Worker positives still use
the actual warm manager, commitments, Core and HTTP206, and require exact
disjoint assembly with deferred once-only credit. Their explicitly functional
controller clock yields to actual setup I/O before advancing policy timers;
it is not elapsed-time or throughput evidence. Two separate real-clock cases
require either full mixed assembly or complete same-load setup-decline proof,
zero attempted ranges/peer requests/credit and an exact whole-source body
within reduced original deadlines. A separate functional control holds an
actual Worker reply and advances its logical scheduler to the original 25 ms
boundary, checking fallback and rejecting 28 altered receipts. It makes no
native elapsed-time claim. The incomplete original macOS input remains a
rejecting fixture; six existing real-clock six-MiB tuples are unchanged.

The `a85f8134` full hosted run failed two new test assumptions: macOS passed
921 of 922 checks but its forced native-time control never observed the START
reply it expected to hold; that optional setup window does not guarantee a
START. Its exact internal branch is unknown. Windows base passed 601 of 602
checks; checkout CRLF conversion changed the immutable JSON receipt's hash.
The forced control now uses the explicitly functional scheduler described
above, while ordinary real-clock checks remain unchanged. One file-specific
Git attribute preserves the original LF receipt bytes and expected hash; an
actual Git checkout with `core.autocrlf=true` reproduces the old mismatch and
passes after that correction. The three affected controls, immutable negative
and two mandatory assembly positives pass locally. The original hosted failures
remain failed; a new full CI run is required. Product code and timing, original
fixture timeouts and field thresholds are unchanged.

The later `1206505` macOS run passed 921 of 922 checks. An older ACK controller
fixture mixed mocked timers with real monotonic time and never observed its
commit signal. A native delayed-timer specimen reproduces that fixture failure;
a separate real-time guard control correctly rejects an expired 25 ms startup
without calling the hook or renewing through late completion. Five logical
short-deadline fixtures now advance their timer and monotonic clocks together.
Their original parents and assertions remain; the ACK case additionally checks
that ownership is live at 24 ms and aborted at 25 ms. All five controls and
216 manager checks pass locally. These are controller and unit-level deadline
proofs; the failed hosted verdict and field acceptance remain separate.

At `39e28b1`, the complete macOS native gate passed. Two other hosted cases
failed: Windows policy/session renewal was not fresh at its original issuance
checkpoint, and the browser TURN-rollover journey observed refreshed credentials
but no accepted peer media in its latest swarm generation. Each unchanged local
journey subsequently passed once. Those runs do not explain or rescore either
hosted failure, and no product correction is claimed. Bounded test diagnostics
now retain native request/renewal timing and redacted per-generation demand,
media-state and pending-source history. Original authority, delays, media,
predicates and supervisor limits remain unchanged; hosted diagnosis is pending.

## Unreleased cooperative VOD futures (29 October 2026)

When both warm-ahead and buffered mixed ranges are enabled on explicit main
VOD, optional future source work now chooses a per-key contributor rather than
always starting the same whole fetch on every viewer. Only current connected,
serving, admitted range peers participate; unavailable local Core/Worker paths
retain the existing warming behaviour. Exact cached holders can still feed
mixed delivery. Startup coverage and genuine or already-promoted demand do
not wait for owner agreement, and all original budgets and credit rules remain.

A two-SDK regression first records both viewers starting the same future whole
source before either has advertised that object. With the new policy, distinct
future owners supply reciprocal actual Core mixed transfers, with disjoint
source slices and verified peer bytes, exact object hashes and no duplicate
whole future source or repeated accepted credit. Source and native transport
are simulated; sessions, commitments, protocol bytes, Core verification and
consumption are real. Genuine zero-wait eligibility comes from actual delayed
source callbacks and measured recovery, without seeding rates or clocks.
The full warm-manager suite passes 199 checks; 20 focused SDK checks also pass,
including existing framing and main/Worker mixed positives. These local checks
are not a field-throughput or public/physical-device qualification.

## Latest private playback and contribution result (29 October 2026)

The later `a007c07` cooperative-futures candidate failed its fresh private
two-browser test during startup. Viewer A reached a trusted 3840x2160 frame in
4.51 seconds. Viewer B exhausted its original twelve-second startup barrier
without presenting a frame; the required 340-second observation never began.
Its source GETs completed, but verified media did not safely cover the moving
target plus recovery headroom. The cooperative owner policy is excluded while
startup is buffering, so this is not evidence that source ownership caused the
failure. The immutable capture and strict audit remain failed. Temporary
credentials, profiles and services were cleaned; the paired private relay was
preserved. No sustained contribution, TURN-route or physical-phone acceptance
is claimed for that run.

### Earlier sustained private test

The `f5c0760` runtime candidate completed a real two-browser private test with
340.001 seconds of wall observation and 340.001 seconds of monotonic observation
(rounded). Each player advanced 339.278 seconds. First 3840x2160 frames arrived
in approximately 4.8 and 6.0 seconds. Both recorded zero post-qualification
waiting, stalls, errors and dropped frames, including a natural wrap followed
by 79.5 seconds of playback. Both initially selected local relay/TLS and literal
remote-relay candidates with succeeded pairs.

The overall result remains failed. Accepted peer media was 5,788,148 bytes
(0.519%) and 884,736 bytes (0.0802%), below the unchanged 5% and 8 MiB per-viewer
requirements. One final selected pair was `in-progress`, failing the required
final succeeded-pair proof despite its connected PC/ICE/SCTP/DTLS. The driver
therefore failed its final assertion after the observation. These results are
private desktop-browser evidence, not public operator, physical iPhone or
source-traffic savings qualification. Temporary test resources were removed;
the paired private relay was preserved.

Both viewers completed real range responses, so the low contribution does not
show a global range-transfer failure. Of 109 matching first whole-source
objects, 97 started on both viewers before either response completed. Incomplete
retained HAVE and warm-reuse history prevents a complete causal attribution.
The next local candidate coordinates optional future source ownership while
preserving immediate genuine demand and the original deadlines. Its local
policy controls do not qualify the field contribution target.

## Unreleased local-candidate retry notification (29 October 2026)

An explicit host notification can retry remembered local no-candidate gather
failures after the host makes a new configuration available to its future
connection factory. The bounded one-shot API retains ordinary current
admission, capacity and discovery checks. It does not update existing peers or
release unrelated cooldowns, and it adds no timer or automatic presence retry.

A regression first fails for the missing API after a real SDK no-candidate
gather failure. Twenty-four focused signalling controls then pass, including
future-constructor configuration, incoming and outgoing failures, same-millisecond
generic cooldown replacement, repeated notification, connected links,
admission revocation, timeout/refusal preservation and stop across an awaited
admission. Two additional regressions first reject the old treatment of an
unreadable native description as a definite empty gather; after correction,
both retain the ordinary cooldown and exact original SDP read count. Native RTC
and relay transport boundaries are simulated; signed and
encrypted SDK/session handling is real. This unit proves local lifecycle
behaviour, not browser ICE, field playback, useful contribution or release
qualification. Earlier fixture setup failures and field failures remain retained.

## Unreleased cached setup diagnostics (29 October 2026)

Cached mixed setup now identifies a missing exact captured HAVE and an
unavailable range engine at their existing pre-Core return branches. Cached
handoff load IDs link to their earlier mixed owner. The change adds bounded
local diagnostic fields only; transport, authority, scheduling, deadlines,
selection and accepted credit retain their existing behaviour.

Regressions first fail for the missing refusal row and initial claim counts.
Ten focused Core controls pass after the diagnostic repair, including
main/Worker actual HTTP206 assembly, absent versus withdrawn exact-HAVE claims,
refusal without a new transfer, unchanged cached deadlines, and existing
getter/throwing-sink checks. A repaired private capture preserves the warm role,
initial predicate counts and linked load history within its original byte limits;
its 13 controls pass. These checks establish observation behaviour, not a field fix.

## Current-source private field diagnostic (29 October 2026)

One further full-context Core run passes 876 checks with zero failures and one
Core-inapplicable JavaScript-selection skip. Both warm main-thread and Worker
HTTP206 positives pass. The earlier intermittent Worker whole-source failure
does not recur; its cause remains unexplained and its failed receipt is retained.

A fresh private two-viewer trial uses the exact current build. Both browsers
verify all four substituted module bodies and reach actual 3840x2160 frames in
4.97 and 5.04 seconds. Both receive separate short-lived credentials and connect
native ICE/SCTP within 0.92 seconds. The strict readiness stage nevertheless
fails: one transport-selected remote candidate remains `prflx`, while the
required type is `relay`. Its local relay/TLS path, DTLS and candidate pair
succeed; this does not satisfy the unchanged remote-relay gate. SDP messages
were sent with one candidate before gathering completed, but no retained
candidate-membership evidence proves why the native type differs.

The 340-second observation never starts. Final reports record zero accepted
peer bytes on both viewers, and both complete HTTP captures contain no Range
requests or HTTP206 responses. One viewer records a 47.5 ms seek-associated wait
while 5.009 seconds remain buffered; it resumes before the nearby source body
completes. The other records no health event. There is no reproduced eight-second
discard/refetch episode. A retained mixed entry omits the warm-owner role and
some refusal rows, so it cannot establish that warm-owned mixed delivery ran.
No coordination or underflow cause is inferred from those missing observations.

All 32 captured files and 17 run inputs reverify within the original limits.
Cleanup removes the temporary relay/issuer, exact browser profiles and stages,
rendered private material and archive, while preserving the paired relay and
firewall. This is a failed private diagnostic, not sustained playback,
public-operator, physical-phone or traffic-saving qualification. The next
measurement must retain the existing warm-role/refusal fields and privately
compare candidate membership without publishing addresses or SDP.

## Draft steady warm mixed delivery (29 October 2026)

The draft now lets eligible steady future work choose disjoint source ranges
and verified peer pieces before a whole GET starts, when both existing opt-ins
are enabled. Startup work keeps its existing transport. The internal work owner
retains the original speculative expiry and cancellation signal; promotion
keeps the original parent deadline. Accepted peer credit waits for genuine
consumption of the complete verified object.

All 193 warm/startup checks pass. Controlled passing main-thread and
committed-WASM Worker warm mixed runs use 688,128 verified peer
bytes and 5,603,328 HTTP206 body bytes per 6 MiB target, with no whole GET. Credit remains zero
before genuine consumption and is not duplicated by repeated reuse. The legacy
whole-source versus genuine-mixed comparison also passes. Explicit synthetic
pacing and separately accounted calibration/lead bodies make these policy
checks, not a sustained playback, physical-device or public-operator result.

Eighteen additional SDK controls pass on the main thread and committed Worker.
They cover lost ownership during authority waits, expiry, pause, abort,
revocation, stale range replies, missing capability, valid promotion beyond the
speculative deadline and shorter original parents. The internal descriptor is
modelled in those controls; actual warm-engine and HTTP assembly proofs are
separate. Twenty-five existing mixed fallback/deadline controls also pass.

Review exposed a late-promotion bug: if JavaScript delayed the timer callback,
a first genuine request at or after eight seconds could clear an expired
speculative timer. Both exact-boundary and boundary-plus-one regressions fail
before the warm-engine correction. The SDK also rejects late promotion
provenance. Valid earlier promotion preserves the original parent timeout.
The original Linux CI reservation assertion is retained as failed evidence;
its fixture now holds the next future explicitly, checks its reservation and
verifies zero reservations after pause instead of assuming global quiescence.

The first broad Core swarm run records 874 passes, two scope-proof failures
and one JavaScript-selection-only skip. Ordinary loads were emitting an extra
warm-only trace field; the strict scope validator correctly rejected that
shape. The SDK now emits that field only for actual warm owners. Both failing
cases and the warm checks pass in a new 28/28 selection without changing the
validator. The complete corrected-source rerun records 875 passes, one
failure and that same skip: its warm Worker target unexpectedly starts whole
HTTP instead of ranges. The failure has no branch trace, so its cause remains
unknown. A bounded assertion payload now retains scope/transfer/HTTP and Worker
RPC evidence without relaxing the HTTP206 requirement or deadlines. One isolated
diagnostic run passes actual assembly; it neither explains nor rescinds the
full-run failure. No further blind reruns were used to claim a fix. A fresh
finite field run, physical-device acceptance and a public operator remain
pending. No experimental SDK is deployed; this PR is not ready to merge.

## Unreleased promoted-source admission (29 October 2026)

A promoted genuine source no longer automatically admits a second speculative
HTTP request. Its consumer must have measured recovery headroom. Admission
rechecks after authority and reservation callbacks; missing context, unavailable
headroom and lifecycle changes leave new speculation deferred. The existing
source keeps its parent deadline. Deferred metadata retains its original
eight-second expiry and recovers the current parsed loader fields before
transport starts. Genuine completion or cancellation resumes admission without
polling. Cache, object and reservation limits remain unchanged.

Two low-headroom regressions fail before this correction and pass afterwards.
A separate actual-SDK regression catches missing loader fields during deferral
and passes after restoring them from current parsed metadata. The final focused
selection passes 20/20; all 171 warm/startup checks pass with the committed Core
selected where applicable. Direct engine controls remain JavaScript policy
tests. Current main-thread and committed-WASM Worker controls both complete
actual disjoint HTTP206 and verified peer assembly.

A controlled real-Core comparison retains the legacy whole-source control:
with mixed ranges disabled, the warm/coalesced target uses one 6 MiB whole GET
and accepts no peer bytes;
the otherwise eligible genuine target uses 5,603,328 HTTP206 body bytes plus
688,128 verified peer bytes, with no target whole GET. Both arms use the same
explicit synthetic pacing, media geometry and deadlines; calibration and lead
traffic are accounted separately. This is policy evidence, not a field speed or
traffic-saving qualification. Warm mixed planning must own its source ranges
before a whole GET starts. The draft implementation described above addresses that path; it does not
establish a sustained playback improvement. The draft remains unqualified.

## Unreleased moving-room startup admission (29 October 2026)

Additional composition controls exercise steady warming after startup release,
deferred consumption credit, cached reuse and pause cancellation. A separate
combined-options integration case explicitly asserts the committed Core is
ready and verifies a warmed object's HAVE advertisement, upload and local reuse.
The focused eight-control selection passes with the correct Core environment;
direct warm-engine controls remain JavaScript policy tests. This is not a new
full-suite run or mixed-transfer performance qualification.

A further actual-Core overlap control waits for the exact future object's peer
request before completing HTTP. On an explicitly ordered, reliable fixture
channel it verifies one HTTP success, the matching peer cancellation and drain
boundary, continued HAVE advertisement and local reuse without peer credit.
The focused nine-control selection passes. A separate unknown-reliability
fixture closes deliberately when its active request is aborted: HTTP warming
still verifies, but that closed link cannot receive HAVE. This explains the
controlled diagnostic's missing announcement; the original timing is not
retained, and its failed result remains unchanged. No runtime change or field
performance improvement is established by these controls.

When the original fragment is obsolete, merely selecting metadata ahead of the
room target no longer freezes a window before it passes the existing recovery
and verified-service projection. Freezing follows successful reservation and
current ownership; a cancellation during that check stops before future HTTP.
Verified original coverage, contiguous fourth-slot extensions and already
admitted windows retain their behaviour. Deadlines and capacity limits are
unchanged.

A controlled moving-target regression fails the original twelve-second deadline
before the fix and releases at 9.91 seconds afterwards. Captured scalar inputs
are identified separately from synthetic one-second services for unrequested
fragments; this is not a field counterfactual. All 149 warm/startup tests pass.
Four older fixture starting positions now make their claimed windows genuinely
admissible; their recovery requirements, durations, budgets and assertions remain.
The existing logical-policy held-allocation test also now requires a matching
real Worker reply before advancing its policy clock, then verifies the exact
25 ms fallback, unchanged budgets and retirement without credit or a leaked lease.
This is policy coverage, not elapsed-performance evidence.

Hosted checks on the preceding `b77f9c4` head passed the macOS and Linux native
jobs, Rust and interoperability checks. The low-latency browser job failed,
the Windows native job was cancelled, and dependent live-relay coverage was
skipped. The browser capture stalls even with peers disabled and
later records playlist HTTP500s; the first stall precedes those responses, and
the underlying server exception was not retained. Warm/startup and mixed ranges
were disabled in that fixture. Its failure remains unresolved.

A fresh mixed-disabled control of the admission fix reached both first 4K
frames in 7.1 and 5.6 seconds, but sustained playback failed badly: the final
reports record 30/25 stalls totalling 167.1/95.6 seconds and no accepted peer
media. Initial Hls underflows preceded automatic native-HLS fallback. Both
players then used recorded VOD without a RelaySwarm adapter, so later HTTP206s
are not evidence of SDK mixed transfers. This is a failed field result, not a
performance qualification. Physical-device and public-operator gates remain.

A subsequent private two-viewer candidate enables both steady warming and
buffered mixed ranges against the updated website. First 4K frames arrive in
4.7 and 8.1 seconds; cumulative native observations record zero waits, stalls,
player errors or dropped frames, including a track wrap and at least 79 seconds
afterwards. Both retain the Hls/MediaSource adapter. This is an unmatched
diagnostic, so it does not isolate which option or source conditions produced
that healthy playback.

The overall candidate still fails. Accepted peer media is only 0.044% and
0.118%, with maximum reported verified TLS-route media of 0.47 and 1.22 MiB,
below the unchanged 5% and 8 MiB requirements. The start route capture records
nominated, connected relay/TLS pairs still in the ICE `in-progress` state;
the final pairs succeed, but the required start proof is missing. Monotonic
observation is 340002 ms while wall observation is 339996 ms, below its separate
340000 ms minimum. The failed capture remains unchanged. The temporary issuer,
relay, browser profiles and rendered credentials were removed, and the paired
private relay and firewall are unchanged. No experimental SDK was deployed.

A separate forty-second diagnostic retains bounded channel-control and warm
cache observations. Both start TLS proofs succeed; one ordered, reliable
channel per viewer stays open. Three observed cancellations receive matching
EOF within 393, 543 and 2241 ms. This does not explain the earlier closures.
Warm reuse reaches about 110/155 MB, with no verified or consumed peer bytes
from warming. Of 29/34 SDK loads, 22/27 are marked warm-ahead, including the
held startup originals. Every retained transfer finish is peer-only, and the
HTTP captures contain no ranges: no origin-backed mixed transfer ran in this
episode, although peer piece probes and refills did run.

The forty-second run still records two stalls, two player errors and fifteen
dropped frames on one viewer; the other records zero. Both accept no peer
media. One speculative source request reaches its eight-second cap after
receiving 5.44 MB, then a genuine whole-object refetch overlaps a stall. That
observed duplication warrants a controlled ownership and scheduling test; it
does not justify increasing the cap or identify a complete field fix. The
diagnostic stops intentionally and cannot pass the original 340-second gate.
Its temporary resources are removed and its evidence remains separate from
the earlier full observation.

## Unreleased room-start publication boundary (29 October 2026)

An optional startup commit hook now requires verified coverage strictly above
the measured recovery requirement before publication, including after awaited
authority checks. Exact equality cannot survive a positive acknowledgement
delay once the room clock advances. No-hook and post-acknowledgement validation
retain their existing minimum-headroom rule and original deadlines.

A controlled regression reproduces the prior twelve-second startup failure and
releases once at 7.91 seconds after the correction. Its first two source service
times reproduce captured timings; subsequent one-second services and a ten-ms
acknowledgement are explicit synthetic inputs. All 146 warm/startup checks pass.
This is local regression evidence, not a new field or physical-device result.

The latest sustained two-viewer private 4K diagnostic still fails acceptance:
one viewer recorded four waits totalling 0.877 seconds, three player errors and
2.16% accepted peer media; the other accepted none. A later mixed-disabled
control failed startup and motivated this boundary correction. A fresh
mixed-disabled control with the correction started one viewer in 6.4 seconds,
but that viewer recorded three waits totalling 5.159 seconds and the other
reached the unchanged startup deadline without a frame. This does not isolate
the remaining problem to mixed transfers or establish sufficient source cadence.

The test classifier now recognises the exact Core-reply setup rejection before
any transfer command is applied. An immutable actual CI receipt and 32 hostile
mutations cover this zero-I/O branch; the original failed run remains failed.
The bounded integration selection remains red at 14/15: its held-allocation
case did not observe the required RPC before its fixture timeout, and fallback
completion was not captured. The branch remains draft; sustained playback,
useful contribution, independently operated public credential issuing and
physical iPhone acceptance remain open. Production and the paired private
relay are unchanged.

A subsequent diagnostic-only attempt retains that held-case failure and records
setup expiry before allocation, zero RPCs/ranges/peer requests, and one successful
whole-source fallback callback. It explains that attempt without satisfying the
required held-RPC coverage or changing its original timeout.

A separate source-only Chrome probe on the same test Mac fetched four complete,
catalogue-hash-verified objects over HTTP/3 in 0.68–1.50 seconds each, totalling
24,331,115 bytes. It used no SDK, player or video decoding. Different objects,
request order and run time prevent a matched comparison with playback; this
point-in-time observation does not identify the field bottleneck.

## Unreleased first-candidate SDP gathering (28 October 2026)

The browser loader retains its 1.2-second gathering soft cap when local offer
or answer SDP already contains a candidate. An empty description at that cap
keeps waiting for the first candidate or native completion, bounded by the
existing negotiation cancellation and original dial deadline. Native completion
without a candidate fails closed. Admission and publication ownership remain;
there is no new hard timer, trickle message or public default.

A passive browser diagnostic observed an answer with no candidates at the
1.2-second boundary, followed by a relay candidate about 982 ms later. This
identifies a publication-order problem; it does not establish successful media
delivery after the change. The earlier failed 4K attempt remains failed and is
not rescored. Eight focused signalling cases failed on the previous runtime
and pass after the correction. The local JavaScript loader suite passes 736
tests; the committed WASM-backed hardening suite passes 524, with one
JavaScript-prototype-specific case skipped there and covered by the JavaScript
suite. These are local correctness checks. Renewed sustained playback and
physical-phone qualification remain pending.

## Unreleased XHR progress/success ownership compatibility (28 October 2026)

The installed hls.js 1.7.3 XhrLoader calls final body progress before synchronous
HTTP success. Immediate peer cancellation at progress disposed of the partial
usefulness proof before that success could validate it. The wrapper now claims
HTTP immediately and queues one guarded microtask for genuine binary progress's
unproven peer retirement. Positive nonbinary progress still cancels immediately,
even after an earlier binary claim; the payload length decision is read once.
Owned positive-body success observed before queued retirement can validate
before lease release, including a success already queued before progress.
Nonterminal progress, failure or success after retirement cannot. Late proof validation
retains every existing context/admission/deadline predicate while distinguishing
HTTP ownership from peer-handoff eligibility.

This corrects a callback-order compatibility gap. It creates no rate or Hls peer
credit and extends no peer window or deadline. Actual-XhrLoader and committed-Core
fixtures exercise the callback sequence; they do not qualify sustained playback,
source savings or explain each cancellation in the previous failed field run.

## Unreleased partial-usefulness correction (28 October 2026)

The correction retains physical usefulness from fresh verified pieces in the
current peer-only transfer when its own successful positive binary HTTP response
wins. Proof binds the transfer, link, request controller and current authority,
connection, media, generation and worker state. It is consumed before releasing
the still-owned lease; no usefulness is restored afterwards. The timestamp is
anchored to actual verified credit, and a newer zero-credit abort still clears it.
The bounded `core.multiHolder.peerFlow.partialUsefulnessPreserved` counter records
actual applications without identities or new timing fields.

This changes which later genuine demands can use the existing unknown-flow
continuation. It adds no Hls credit or rate, lowers no observation floor, extends
no deadline and changes no cooldown duration or initial unknown-flow piece bound.
Stop, seek/replacement, expiry, failure, corruption and stale worker results do
not qualify. The prior capture measured partial credit followed by refusals, but
did not record each transfer's cancellation owner. Local checks passed 702 swarm
tests, 31 focused regressions and 20 Core integration checks. Field-causality
and playback-performance qualification remain open.

## Unreleased peer-flow and fit-model diagnostics (28 October 2026)

`metrics().core.multiHolder.peerFlow` now counts emitted verified short-flow
batches and the existing link-model decisions, with only the latest numeric
model and no-model rejection snapshot. Model evaluations are not requests;
verified estimator samples are not consumed Hls media or traffic savings.
Snapshots are copied and contain no peer identity or payload. The field exposes
whether the estimator trained and why a candidate model was retained or refused;
it does not change usefulness, cooldowns, admission, callbacks or deadlines.
This diagnostic addition is not a performance fix or a new playback qualification.
Previously captured reports that omit it cannot establish short-batch training
or the exact cause of a per-load model refusal.

## Unreleased verified short-piece flow observations (28 October 2026)

A slow qualifying piece can leave a pessimistic throughput estimate in place
when every later piece is individually faster than the 300 ms observation
floor. Recording those completions alone does not provide a new rate sample.
The browser loader now accumulates newly verified peer bytes separately for
each existing transfer and connection. A batch qualifies only after both the
unchanged 300 ms and 32 KiB floors. It includes elapsed gaps and verification
time, excludes origin and duplicate bytes, and never combines other links or
transfers. Published batches do not reuse bytes; failure, cancellation or
invalidation discards pending observations. Existing qualifying long-piece
handling remains unchanged, and no first-byte timing sample is invented.

This changes host measurement inputs through existing JavaScript and committed
WASM APIs. It adds no requests, timers, wire messages or playback credit, and
does not change the Rust/WASM binary. Source regressions establish estimator
behaviour; sustained 4K playback, traffic savings and device qualification
remain separate gates. The preceding deployed 330-second two-browser check
still recorded stalls and is not reclassified by this correction.

## Unreleased explicit startup byte allowance (27 October 2026)

`startupBufferMaxBytes` lets a host explicitly choose an encoded startup
reservoir between 24 MiB (the unchanged default) and 32 MiB. A source-only
4K check still missed its late-join deadline after the contiguous-admission
fix. Its sampled 21,136,364 held bytes match the original fragment plus two
verified futures; the next signed successor would require 27,195,621 bytes,
exceeding the old aggregate cap. The exact refusal branch was not captured.
An audit of the pinned recording's catalogue gives a conservative maximum
of 30,602,204 bytes for any original plus three contiguous futures, below
32 MiB. These sizes establish a capacity requirement, not playback success.

The chosen allowance must fit the host's shared held budget before HTTP.
Future bytes alone retain their separate 24 MiB cap, including reservations,
so startup cannot leave a larger steady cache after releasing its original.
Per-object limits, four-object startup residency, serial future loading,
authority, recovery and deadlines remain unchanged. This is an encoded
reservoir bound; decoding, transport copies and other browser memory are
additional. Real-source and physical-device qualification remain open.

## Unreleased contiguous startup admission (27 October 2026)

After the moving target reaches a selected future window, the admission
horizon can skip the fourth-slot successor even when it would extend two
verified futures covering that target. The previous future's measured service
time can trigger this independently of available buffer capacity. This
contiguous extension now retains its place; selecting a new forward window still
uses the existing horizon. Release still requires fresh verified coverage
and recovery headroom within the same authority, capacity and deadline
checks. Encoded-loader regressions cover the selection error; sustained
real-source playback and physical-device acceptance remain separate gates.

## Unreleased parsed-timestamp round-off (27 October 2026)

A playlist refresh can represent the same fragment start as `10.64` and
`10.640000000000004`. Strict equality incorrectly treats that arithmetic noise
as changed media and cancels pending startup. Geometry comparisons now accept
only bounded machine precision, with a hard one-nanosecond ceiling. Media keys
and scope stay exact. Regressions preserve the original response, statistics
and context exactly once across a harmless refresh, while real start/duration
changes and a large-timeline case still cancel. Recovery, capacity, authority,
ACK and absolute deadline checks remain unchanged. This correctness fix alone
does not establish sustained playback, traffic savings or device acceptance.

## Unreleased startup load budget (27 October 2026)

The one-shot startup reservoir now has twelve seconds from the original
first-fragment load entry, clipped to the shorter parent load deadline.
Ordinary speculative requests still expire after eight seconds. A cold browser
4K check of the preceding eight-second policy decoded no frames: its initial
two overlapping fragment requests took about six seconds each, and the fourth
fragment was still arriving at expiry. All four pinned catalogue object sizes fit the
existing 24 MiB budget. The cancelled response's eventual completion time is
unknown; allowing a longer bounded wait does not establish that it would have
succeeded. Four startup objects, serial future requests, measured recovery
headroom, fresh authority checks and the original ACK deadline are retained.
Source regression checks distinguish safe completion after eight seconds,
absolute expiry and a shorter parent deadline. Real-source startup, sustained
playback and physical-device qualification remain separate acceptance gates.

## Unreleased SDP object capability (27 October 2026)

The existing encrypted offer/answer exchange advertises optional object framing
2 while range support is enabled. An admitted current negotiation records it
after remote SDP installation. A two-factory signed-session fixture reproduces
a late viewer missing the holder's initial presence: the old positive-budget
whole-object peer path still works, but the cold cached-range race falls back
to HTTP. With the capability, verified peer bytes win the unchanged single HTTP
backstop before its payload; both directions work without another presence.
Missing/invalid capability, unadmitted offers and stale answers do not grant
range eligibility. These are committed-Core tests with ordered transport
substitutes. A separate native loopback Chrome/WASM check completes its first
verified 6 MiB peer receipt while signed presence remains withheld, aborting
the one partially received HTTP backstop. After presence release, the original
HTTP-win and reused-peer cases still pass. This is synthetic protocol evidence,
not real 4K startup, traffic savings or device qualification.

## Unreleased origin availability handoff (27 October 2026)

When an owned whole-origin response completes and its key is already known,
the loader retains eligible source bytes and announces HAVE before withdrawing
its FETCH claim. This preserves the handoff across hls.js's synchronous loader
disposal in ordinary, cached-race and late-race paths. Playback does not wait
for another key hash. Cache limits, serving permission, receiver verification,
wire messages and lease duration remain unchanged. Actual hls.js 1.7.3
regressions reproduce the old withdrawal-before-availability ordering.
This correctness change does not establish traffic savings, increased peer
contribution, smooth playback or physical-device qualification.

## Unreleased startup buffer capacity (27 October 2026)

A startup target can need more recovery headroom than its verified window
provides, including when it has passed the original first fragment. After the
first body and both planned futures verify, startup may retain the useful
contiguous future prefix and admit one parsed successor before retiring that
prefix. The original response remains held unchanged even when its interval
is obsolete. Startup is bounded to four objects and the same 24 MiB; steady
warm-ahead stays at three, future requests stay serial, and the then-current
eight-second/parent deadline, authority and ACK checks were unchanged.
Source fixtures cover feasible completion, an obsolete first interval, byte
refusal, cancellation and fresh target checks. The additional request must finish within the original deadline;
byte capacity alone does not guarantee time to complete it. These checks do not
establish decoded playback, device qualification or a performance benefit.

## Unreleased accepted-peer stats disposal (27 October 2026)

An accepted verified peer object's known `aborted: false` now survives disposal
of its losing HTTP loader. The actual hls.js 1.7.3 FragmentLoader and XhrLoader
regressions reproduce the old mutation during synchronous success cleanup and
check cached and late peer wins, retained stats identity, late HTTP suppression,
ordinary HTTP, pending/caller aborts, unsafe flags and disposal exceptions.
The change adds no transfer policy and claims no performance improvement or
new physical-device, public-NAT or release qualification.

## Measured startup and recording wrap (26 October 2026)

The paired site at `a0db0e63`, using SDK `bea813a`, passed real 60-second and
330-second full-4K runs on two fresh visible M4 Chrome contexts. Browser HTTP
caching was disabled; CDN state was not asserted cold. Both viewers had zero
post-first-frame stalls and dropped frames. The separate whole-window 0.75-second sync audit
passed; maximum drift in the long run was 0.343 and 0.116 seconds. Actual
programme rollover and CC0-to-CC1 transitions were followed by over 61 seconds
of clean periodic samples. This used startup-only buffering with steady
`warmAhead` disabled; it does not qualify steady speculation.

The first room prepared verified media locally before publishing its start;
the later viewer joined the advancing epoch. Accepted peer shares were
11.08%/19.72% in the short run and 12.02%/6.65% in the long run. The unchanged
harness qualifies its selected receiver, not every viewer above 10%. Peer
share is not net HTTP saving, wire cost or a competitor comparison. Both
viewers used native host-to-host UDP on one Mac; physical iPhone, public-NAT
and independently operated public TURN acceptance remain separate.

The [privacy-safe measurement summary](https://github.com/forgesworn/forgesworn.dev/blob/main/docs/evidence/prepared-room-4k-20261026.json)
records source and raw-receipt hashes, protocol scope and per-viewer results.
Earlier failures below remain historical evidence rather than the latest
startup-only qualification result. Release assets remain version 0.4.4;
these opt-in source changes are not substituted into existing release files.

## Unreleased per-connection timing and bounded recovery (25 October 2026)

An M4 comparison with steady speculation disabled still had one 0.88-second
startup interruption; its other viewer had none. Both received useful peer
media, but the interrupted viewer failed the shared-clock audit. Its first
freshly aligned position left 0.68 seconds of buffered media while the next
whole-fragment source request took 1.73 seconds. No peer wait or subsequent
clock seek caused that underflow. The experimental, default-null
`startupBufferTarget` contract therefore holds the first encoded callback
until verified upcoming media covers a fresh host target plus measured
recovery headroom, within the existing reservoir and deadlines. This is
unreleased work; at that stage real continuity, shared-clock and physical-device
acceptance remained pending.

The first startup-buffer M4 run kept one viewer playing for 73 seconds with
zero waits or dropped frames and at most 0.283 seconds of room drift. The
other viewer never presented a frame: a required future HTTP request could
not use a peer accepted after load entry, and its first verified short peer
transfer did not establish link usefulness until player consumption. That
formed a startup dependency cycle. The media gate remained RED and overall
sync was unqualified. The follow-up changes distinguish owned startup-buffer
dependencies and verified transport usefulness from actual HLS consumption,
with the original memory, rate and deadline limits. Fresh real playback
qualification was still required before the later results above.

The next M4 run failed before the first viewer presented a frame; a second
viewer never joined. All three contiguous bodies (18.27 MB) completed, but the
first room's clock had advanced before media preparation. At the last coverage
check, the verified tail provided 2.388 seconds ahead of the target against
3.076 seconds of measured recovery headroom. The original eight-second startup
deadline expired. This remains RED, with no observation samples and unqualified
sync. Follow-up work adds an optional bounded host acknowledgement hook so a
new room can prepare before publishing its start, without reanchoring an
existing room or changing the media acceptance gates. Real playback was still
pending before the later results above.

The experimental `warmAhead` option is disabled by default. Signed-commitment
loader tests using actual hls.js 1.7.3 parsed Fragment objects cover future
object verification, exact-demand reuse/coalescing, current-authority refusal,
cache/reservation limits, cancellation and the untouched default path. Its
speculative map shares the existing held byte budget, and local reuse is
reported separately from accepted peer payload. Sustained cold-cache 4K,
useful peer contribution, shared-clock behaviour and physical iPhone acceptance
require fresh browser/device measurements before enabling it in a deployment.
An initial 60-second public-4K candidate run remained RED despite local cache
reuse. Promoting an in-flight warm object to actual demand now frees the
speculative slot for its successor, with aggregate reservations and an
independent buffer-bounded source recovery path. These causal source fixes
still require another unchanged cold-cache playback comparison.
The subsequent M4 comparison also remained RED. Its trace identified an
in-buffer clock alignment cancelling needed loads, and promoted current
requests still using the eight-second speculative cap. Source regressions
now retain useful work for buffered seeks and preserve the original parent's
deadline/error callback on promotion. A subsequent 60.269-second M4 run retained
both peer-assisted players with no dropped frames, but remained strictly RED:
buffered shared-clock seeks produced one 13 ms and one 39 ms wait. Accepted
peer shares were 14.5% and 16.9%. Partial-inclusive HTTP bodies were 5.61% and
7.27% below accepted media bytes; this is not a matched origin-only comparison,
wire savings or production/device acceptance. The trace showed initial
alignment using a manifest-time target about two seconds behind the room clock.
The SDK now also retains an exact already-tracked, same-scope warm interval
when a seek enters it before append. Real parsed-fragment regressions cover
verified/in-flight reuse and invalid or unrelated seek cancellation. This
paired SDK/site startup-alignment candidate subsequently passed a 60-second
continuity gate with no stalls/drops and 16.1% receiver peer contribution.
The unchanged 330-second gate remained RED with early interruptions, despite
82.2% receiver peer contribution. The short pass does not establish close
room synchronisation or physical-phone acceptance. Its startup trace also
showed a seek inside the completed genuine first fragment, before append,
discarding a verified next object and downloading its full body again.
Source regressions now retain only that last genuine fragment's unchanged
parsed next window, retiring it on incompatible metadata, unsuccessful
termination or lifecycle changes. This additional fix remains unmeasured.

The longer trace also exposed concurrent asynchronous worker admissions
selecting the same free-looking link, followed by token-bucket refusal during
piece upload. High-level source regressions now reserve link ownership before
the worker await and permit only bounded warm contention waiting. The new
default-off `uploadPacing` option defers canonical-piece refill in a bounded
250 ms FIFO without increasing rate, burst or quota. Tests exercise actual
committed-Core worker/provider contracts and unchanged cancellation framing;
they do not establish smooth full-track playback or close room synchronisation.

The subsequent 60-second M4 candidate with these retention, admission and
pacing changes remained RED on continuity and whole-window synchronisation:
one viewer had two waits totalling 2.49 seconds and seven dropped frames; the
other had none. Accepted peer shares were approximately 36% and 1.9%.
Pacing reported no refusal or expiry. The trace instead showed a needed HTTP
object starting before a peer connected, then continuing through an underflow
while that peer completed the same object. Its exact HAVE arrival was not
captured. A newly implemented, default-off `latePeerRace` permits only a first
peer arm for such genuine demand, with fresh authority and the original HTTP
left running. Source tests cover late accepted exact-HAVE adoption, bounded
windows, stale context and cancellation; actual playback and synchronisation
with this option remain unmeasured. No wire-savings, public-NAT, production or
physical-device pass is claimed.

Cold-cache physical diagnostics exposed two distinct timing errors: a
holder's completion rate already included startup, yet the piece planner
also added a viewer-wide first-byte delay from another connection; HTTP
service timing could borrow that peer delay too. Large ranged origin loads
did not refresh the earlier whole-origin estimate. The working source now
keeps per-connection startup and qualifying payload flow separately, uses
HTTP service timing independently, and scales substantial HTTP ranges by
their actual bytes for rendition-specific recovery estimates.

A pessimistic or stale connection may get one explicit canonical-piece
probe per ten seconds on a real matching HAVE demand. Origin starts the
remainder immediately. Another route's fast rate cannot enlarge the probe;
only fresh verified data can unlock ordinary bounded requests. Accepted
short-flow recovery can discard an older pessimistic rate without creating
a retained rate below the 300 ms/32 KiB observation floor. A newer
unsuccessful request invalidates that useful-delivery allowance. The
optional WASM capability is additive, with safe origin/known-holder fallback
for older modules and unchanged existing native start signatures.

SHA-256 uses the throughput-oriented optimisation override; the remaining core retains its size-oriented release profile. These
source changes are unreleased. Focused tests cover actual verified small
fractions, origin-winning cancellation, corrupt and late probes, old-module
compatibility, per-lane silence and replay of the bounded-probe inputs.
The matching Rust workspace passes. The complete real-WASM loader sweep
passes 315 tests with one expected JavaScript-prototype-only skip; the
protocol/ABI/source-stamp suite passes all 46 checks. Initial fixture failures
are retained: two quiet-peer controls needed explicitly unknown startup,
one new test accidentally terminated its transfer through an origin failure,
and the loader replay needed the new start input. The repeated-contribution
fixture now verifies a 65,536-byte piece in 750 ms against its unchanged
800 ms deadline before testing later useful fractions; its whole-object
projection remains late. Its integrity and byte-accounting assertions remain.
Cold-cache sustained contribution, complete device playback continuity and
net network benefit remain open field gates.

## Cached mixed admission and fetch-backed waits (24 October 2026)

A fresh slow partial-flow estimate could reject an entire large object before
the schema-3 mixed planner ran, although a contributor held the requested
media and could supply a smaller useful fraction. Eligible already-HAVE
framing-2 holders now reach that planner after commitment verification. The
planner, sustainable deadline and origin reserve still bound peer work;
valid schemas 1/2 retain their whole-object projection. The 300 ms estimator
floor, integrity verifier, wire and committed WASM bytes are unchanged.

For known-VOD main media, an unavailable object is waited for only while a
fresh same-rendition serving contributor advertises a live FETCH lease for
that exact key. A contributor behind a recorded-media prefetch leader no longer
causes a wait merely by serving or ranking ahead. VOD is the exact demanded
main level's explicit `details.live === false`, rather than `currentLevel`;
live, unknown, alternate-audio and invalid-level contexts retain the previous
bounded coordination. A lying or expired lease cannot move the deadline.

Twenty focused real-WASM checks cover repeated mixed delivery after an actual
slow partial flow, both valid legacy schemas, missing/wrong/expired leases,
valid availability, a bounded lying lease, live/unknown compatibility and
exact-level/track-family classification. The same corrected fixture on
the previous `6f63fb2` source fails the mixed-admission and missing-lease
controls. Test channels model native reliable/ordered SCTP and allow losing
EOF frames to drain before the next eligible demand.
The initial candidate's complete WASM loader sweep passed 301 tests with one expected
JavaScript-prototype-only skip (302 total). Syntax and authored/generated
documentation checks passed. The first parallel JavaScript loader sweep had
four timed holder-accounting failures; the same four passed on both previous
and candidate source in quiet isolation without changing their assertions.
Its complete serial JavaScript loader rerun then passed all 370 tests with
zero failures in 125.875 seconds.

The initial hosted broadcast fixture exposed a synchronous live-release race:
donor HAVE arrived 29–58 ms after the consumer's decision, while the first
candidate admitted waits only after observing FETCH. The recorded-media scope
above preserves the prior live coordination and the unchanged strict peer
playback assertion; that failed initial attempt remains recorded.

Physical candidate checks used original 2160p HLS on Pixel/Vanadium and an
M4 browser, actual Nostr signalling and the owner's existing Archy Spry TLS
service with private expiring credentials. Selected DTLS fingerprints and
native data-channel byte counts establish the paired transport. With separate
website clock/first-frame fixes, the final staged 45.5-second window passed:
both decoded 3842×2160, Pixel accepted 6,553,600 verified peer bytes, M4 recorded
7,602,176 uploaded media bytes, and both reported zero post-first-frame stalls
and zero dropped frames. This is bounded physical application evidence.
An earlier 100-second run accepted 24,739,840 peer bytes but retained clock-seek
and recording-loop interruptions; those failures remain recorded.
Some ordinary HTTP responses were served from browser cache, so accepted
origin media bytes are not wire traffic or net network savings. Cold-follower
and default-buffer observations remain distinct from cached and tiered trials.
Phone privacy settings and the existing service were preserved; profiles
stayed private. Sustained continuity and net network benefit remain open.
A later cold-consumer window verified each HTTP response's network/cache
classification but delivered only about 245 KiB of peer media: its usable
native link arrived about 67 seconds into the 100-second observation. That
qualification remains failed and reliable cold discovery remains open.

## Sustainable peer waits and range-sized WASM uploads (24 October 2026)

The opt-in `sustainablePeerWait` bounds serial peer waits and multi-holder
extensions by the requested fragment/part duration minus measured p90
whole-origin recovery with a 25% and 100 ms margin. A two-second segment
with a 1,300 ms measured origin load leaves 275 ms for serial peer work.
The independent cached-peer race retains its window alongside immediate
HTTP. Existing buffer reserves, integrity checks and defaults remain intact.

The matching WASM upload ABI accepts only the requested range. Previously a
512 KiB ranged upload could first copy a roughly 6 MiB held object into the
module and clone it before slicing. This removes that repeated whole-object
input work without changing peer messages, range validation or upload charges.
It is not a measured throughput, CPU-time or smooth-playback claim.

The focused Node loader sweep passed 32 tests covering the new measured
deadline, complete verified cached-peer contribution, cancellation and the
existing origin-recovery reserve. It uses real committed WASM and simulated
browser connections. The combined `npm run test:swarm:core` sweep against the
rebuilt module passed 291 tests, with one expected skip and zero failures
(292 total). That skip patches JavaScript selection's prototype, which the
WASM selection path does not use. The protocol/ABI suite passed 42 tests;
13 Rust range tests also passed. The actual WASM allocation regression sends
the same 6 MiB object in 16 ranges: boundary input falls from 96 MiB
with the legacy ABI to 6 MiB with the new ABI. This is a byte-copy measurement
using synthetic links, not a device or streaming throughput comparison.
These checks do not establish actual iPhone/iPad,
Pixel/Vanadium, varied-NAT or sustained distributed continuity. The v0.4.2
failed hosted-browser attempts below remain historical RED.

## Admission-renewal overlap release (24 October 2026)

v0.4.2 also exposes accepted peer connection identities with
`peerConnectionDetails()` for distinguishing retained links from replacements.
No service or pilot deployment is part of this library prerelease.

A media request arriving during a peer's changed-ticket admission check could
close the live link: the upload checked the old ticket while the new ticket
already owned the per-peer check. Uploads now join that bounded online decision
before reserving allowance or sending media. Rejection, timeout and shutdown
still prevent delivery; subsequent requests check authority online again.

`npm run test:ticket-renewal:browser` exercises two independent Chrome contexts,
local Nostr signalling, real HTTP admission, native SCTP and the committed WASM
core. Three ticket rotations on each side retain the exact accepted connection,
peer identity, loader, held bytes, host upload opt-in and spent allowance. One
real admission response is held while media is requested: no bytes or quota are spent before
acceptance. Four verified 256 KiB loads use the retained connection; later online
revocation sends zero peer bytes and the loader falls back to HTTP. The JavaScript
and WASM hardening regressions also cover refusal, timeout and late acceptance
after stop or channel closure. See the
[source and local evidence](../spikes/results/core-ticket-renewal-20261024.json).

This is a synthetic-byte loopback protocol check. R70 remains RED: its retained
diagnosis attributed the lost link to far-end neighbour replacement during the
renewal observation window. Distributed retention, TURN renewal, physical devices,
public NAT and sustained playback remain open.

## Cached-peer race release (24 October 2026)

v0.4.1 includes the opt-in `zeroBudgetPeerRace` loader option. It starts the
normal HTTP request immediately and races only an object already advertised
by an eligible cached schema-3 peer. A complete verified winner owns delivery;
progressive loads skip the race. Stopping the swarm leaves pending HTTP
running, while loader cancellation stops both arms. The default remains off.
The multi-holder origin tail also retains the measured per-load recovery
reserve, with bounded range-outcome diagnostics.

The native Chrome fixture checks both winners, exact verified bytes, one
whole HTTP request per load and reuse of the same connection. It uses two
contexts on one machine with synthetic protocol data. Accepted peer bytes do
not prove net savings: an aborted HTTP arm may already have transferred bytes.
No public service or pilot is deployed. The field and device gates below
remain open; publishing these libraries does not close them.

### Cached-peer fixture readiness correction (24 October 2026)

The [v0.4.2 tag workflow](https://github.com/forgesworn/relayswarm/actions/runs/40100436726)
failed the HTTP-before-key-hash assertion on both attempts. Those historical
failures remain RED; the later renewal and broadcast steps were skipped.
An instrumented local run reproduced the assertion on the first receiver load:
the native channel advertised all three objects, but no cached-peer race ran.
An incoming connection can deliver HAVE before the holder's next presence
supplies its framing-2 capability. The ordinary zero-budget HTTP fallback
then legitimately hashes its accounting key before starting the HTTP loader.

Current main's fixture requires framing-2 presence from the accepted peer's
identity as well as connected/HAVE readiness. It withholds actual signed
presence frames while allowing real SDP and native SCTP through, asserts that
HAVE alone is insufficient, then releases those unchanged frames and runs the
original three-load assertions. The old readiness predicate fails this control;
the corrected fixture passes two verified 6 MiB peer wins, one HTTP win and
same-connection reuse. Failures now retain the offending load, HTTP/hash order,
eligibility diagnostics and loader trace. See the
[local evidence](../spikes/results/cached-race-readiness-20261024.json).
This changes test readiness, not the loader, wire protocol, core or immutable
v0.4.2 release assets. The original CI logs lack per-load diagnostics, so their
missing prerequisite cannot be read back directly from those logs.

## Integrated library release (24 October 2026)

v0.4.0 integrates holder recovery with Rust/WASM/native discovery, accepted
connection snapshots and verified-media observations, partial-progress retention,
reliable-channel cancellation draining and first-healthy-relay recovery. Native
real-time source support added after v0.3.0 is included. No public service or
pilot deployment is part of this library release. Operators choose media,
relays, upload consent and transport policy.

The old JavaScript R70 qualifier at `20693ea` passed 15 of 16 gates: in-place
renewal failed, with a thin high-quality delivery margin. Those historical
results are retained. The integrated source has not rerun that distributed
profile. Physical devices, public NAT, sustained quality and net benefit remain
unproved; local/CI regressions do not close those gates.

## Shared-core release checkpoint (24 October 2026)

PRs [14](https://github.com/forgesworn/relayswarm/pull/14),
[15](https://github.com/forgesworn/relayswarm/pull/15),
[16](https://github.com/forgesworn/relayswarm/pull/16),
[17](https://github.com/forgesworn/relayswarm/pull/17),
[18](https://github.com/forgesworn/relayswarm/pull/18) and
[19](https://github.com/forgesworn/relayswarm/pull/19) merged after their
required CI jobs passed. Integration also advances the peer link's wall clock
with the loader's virtual clock in the deadline regression; both pinned
outcomes pass without loosening byte accounting or deadline assertions. The
hint regression holds commitment delivery until its idle-HAVE snapshot has
been observed, so key-resolution timing cannot make the holder busy first.

Native packaging's [dispatch dry run](https://github.com/forgesworn/relayswarm/actions/runs/40051822407)
built and verified both platforms on its packaging PR source; attachment was
skipped. Release downloads carry the actual tagged source commit in their
metadata. The packaging guide describes exact-source verification; a dry run
is not tagged-release or physical-device evidence.

The core, multi-holder path and peer supply hint remain opt-in. The hint is
advisory and reports known HAVE supply. Signature checks remain in the core
following the [measured comparison](CORE-SIGNATURE-BUDGET.md). The scheduler
keeps the 32 KiB/s floor and three-holder default. RelaySwarmKit v0.6.0 adopts
the released core for verification, framing and explicit schema-3 scheduling.
A separate native application and physical-device/public-NAT acceptance remain
open. Publishing the libraries does not deploy or qualify a pilot.

## Swift core adoption (24 October 2026)

[Kit v0.6.0](https://github.com/forgesworn/relayswarm-kit/releases/tag/v0.6.0)
consumes the v0.3.0 XCFramework by URL/checksum and retains its unedited UniFFI
wrapper and exact 140 verifier vectors and 48 link traces. Swift retains the
application's author/admission gates, exclusive channel ownership, timers,
cancellation and host-supplied origin policy. Native buffered amount and
low-water callbacks pace opt-in uploads; no synthetic empty queue is used.

The 54-test Kit suite passes with one opt-in public-relay test skipped. It
includes a real 3 MiB ranged upload over multiple native queue windows, corrupt
holder bans, exact origin ranges, final trust checks and joined cancellation.
The current-SDK Chrome fixture covers both schema-2 whole-object reception and
schema-3 two-holder assembly. Author/delegate cases deliver verified generated
H.264/AAC fMP4 bytes. Corruption, signature tampering and both pre-request and
in-flight revocation return zero media. No Swift wire adapter is used.
The piece fixture labels its controlled timing estimates; they are not measured
network rates. CI pins the SDK source and retains receipts with source hashes.

This is macOS arm64/Chrome loopback evidence. It does not prove physical Apple
devices, public NAT, sustained field quality or net hosting benefit. Kit's
transport binary remains macOS arm64 only despite the core's iOS slices.
RelaySwarm and Kit are libraries and require no ForgeSworn-hosted backend.
Applications supply their own media, relays and policy. Test fixtures are
temporary loopback listeners; no public pilot is required or deployed here.

## Experimental core supply hint, 24 October 2026

The next-source loader has an opt-in `peerSupplyHint` advisory command through
WASM and UniFFI. It reports eligible linked HAVE holders and estimated
peer-plus-origin completion duration per rendition's next segment, without
assigning a player level. Hosts may use it only to break ties between
origin-sustainable levels. Discovery retains one playing context per media
type; target-rendition preparation is not implemented. Unknown sizes or timing
remain explicit. Shared Rust/WASM replay and loader on/off tests exercise the
contract; physical devices, public NAT and field acceptance remain open.
See [integration details](../INTEGRATION.md#experimental-peer-supply-hint).

## Silent-holder deadline classification, 24 October 2026

The silent-holder regression now pins two timer orders using virtual time.
The loader registers its floor timer before issuing link requests. At an
integer clock time it cancels the silent request at the floor (`abort`).
With a fractional start, the link truncates its remaining duration separately
from the transfer's floored absolute deadline; the link can time out one
millisecond earlier (`timeout`). Both paths preserve verified delivery, origin
fallback, source accounting and zero early-abandonment charges.

Origin take-back adds verified deliveries and re-arms the transfer timer as
work moves. Those extra callbacks can change timer registration phases under
host load; the relative frequency of either ending is not a scheduler
invariant. The two deadline contracts are unchanged.
The regression asserts the request outcome and trace ordering/timestamps for
each phase, advancing `Date.now()` with `performance.now()` and timers so
the core link and loader share the controlled clock. This is an in-process
clock/ordering check, not a field timing or physical-device result.

## Current delivery checkpoint

Checkpoint: 21 October 2026. [PR 9](https://github.com/forgesworn/relayswarm/pull/9)
merged as `1d54538`, which is published as experimental prerelease
[v0.2.1](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.1) and
deployed to the pilot. Its loader change is `140c256`: it adds local holder
labels to the peer diagnostics (`368b860`) and stops a linked holder that is
never ahead from suppressing neighbour discovery. Most field results below were
measured on the `140c256` deployment of the same loader; P06 at 6 MB and the
short qualifiers R67 and R68 ran on the deployed `1d54538`. v0.2.1 is released
by owner decision while field acceptance remains open: Item 5, P06, Safari 17.6
and v0.2.1's own short qualifier R68 are RED.

**Passed on this source.**

- All nine required
  [CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/39529800310)
  succeeded. Attempt 2 reran only the hls.js playback job, after the runner's
  Chrome install hit an apt 403 before any test step.
- Fresh consumption of the exact committed source (not downloaded release
  assets) passed with 286 package members. The served client is 787,462 bytes.
  The release merge commit `1d54538` passed its own fresh consumption with 287
  members (one added evidence file) and builds the same client.
- Guarded deployment to the pilot passed its independent deployment review.
  After P07 the pilot app was `38eb5c2d`, started 02:59:29 UTC. The release
  merge commit `1d54538` was then deployed through the same guarded cycle and
  passed its own independent deployment review: the pilot app is `ce410033`,
  started 14:56:56 UTC, with reporting and forwarding off. Its runtime differs
  from `140c256` only in the `package.json` and `package-lock.json` version
  fields, and it serves the same client.
- P05 reporting lifecycle passed, with natural expiry after 303,923 ms. P07
  parent-crash recovery passed, with an independent native review.
- **Fourteen-role short qualifier R66 is GREEN, 16 of 16 gates**, including
  `each4BothQualityPeer` and `all8ActuallyUploaded`. This is the first green
  fourteen-role qualifier. It ran 302.823 s with contributors at 1,250,000 B/s,
  relay-only TURN over TLS/TCP and no VPN tunnel carrying the default route.
  It passed `each4BothQualityPeer` by one high-quality peer segment (receiver-1
  received exactly one after switching to high), so it is a narrow pass, not
  repeatable evidence. R68 on the deployed v0.2.1 did not repeat it (below).
- Desktop installed-browser journeys passed for Firefox 152.0.6 on one Mac and
  Safari 26.6.2 on another (all six checkpoints each: verified receive, quality
  and seek, explicit upload, reload retains usage without consent, origin-only
  kill). The Safari 26.6.2 pass is the first Safari pass. Scope is macOS arm64
  desktop with one dedicated 1,800 s finite source and three owned Chrome 155
  actors per browser; it is not physical-device, hard-NAT or separate-network
  evidence.
- Finite-source cleanup reviews for the P06 and desktop sources passed.

**Matched wire and cost (R66, 302 s window, two origin-only baseline roles).**
Receivers used 31.5% less origin traffic than their matched baselines (185.9 MB
against 271.2 MB, model error about ±4%). The origin served about 226 MB less
than all-origin delivery. TURN runs on a separate host, which carried about
319 MB egress (280 to 365 MB, endpoint-side estimate) and about 323 MB ingress,
so total egress across both hosts rose by roughly 85 to 100 MB. Marginal cost on
the hosts' plans is not determined because the plan terms are not recorded.
Nostr signalling bytes were not separable.

**RED or open.**

- **Item 5, the sustained 7,200 s run (22 churn events, natural TURN expiry and
  renewal), is RED and stopped by decision.** R37 failed at the first churn
  event on a harness assertion about retained renewals, which was fixed. R38
  failed after 640,110 ms of measurement on a harness race: `rejoin()` read the
  page 7 ms after clicking Start, before the page applied its settings
  (diagnosis confidence high). A fix that waits for the applied state, as the
  setup path does, is prepared but has not run. The long run requires a GREEN
  matching short qualifier on the deployed source, and none exists on
  `1d54538`. R67 stopped at controller binding before any browser started,
  because the harness preparation still pinned the 0.2.0 `package-lock.json`
  hash: a harness defect with no product evidence. R68 is RED (next item). The
  7,200 s run has not completed on any source.
- **The fourteen-role short qualifier on the deployed v0.2.1 (R68) is RED, 15 of
  16 gates.** It completed 303.088 s of measurement. `each4BothQualityPeer`
  failed because receiver-1 and receiver-2, which switch from low to high
  quality about 150 s in, then received no high-quality segment from a peer:
  every high transfer was declined as projected to arrive late or missed its
  deadline, and the origin served their high phase. The runtime is identical to
  R66's apart from the version fields. An independent diagnosis (high confidence
  on the mechanism, low on the trigger) found a product mechanism with a
  one-segment margin, tipped over by origin media fetches 1.5 to 2 times slower
  than in R66. The late-arrival projection uses the viewer's own origin latency
  as the holder wait, so each origin fallback raises the next estimate; there is
  no back-off; high-quality segments of about 670 KB over the relay are
  abandoned at the deadline; and a spent neighbour replacement resets only after
  a verified high-quality segment. Verified peer bytes were 138.6 MB, against
  225.9 MB in R66. These are findings, not fixes. R68 was not re-run, by
  decision.
- **P06, the 3 MB both-quality shared-cap lifecycle, is RED and open**
  (`RED_HIGH_QUALITY_NO_VERIFIED_COMPLETION_BEFORE_SHARED_CAP_REFUSAL`, the same
  class as the a416f7e third run). Low-quality verified peer media reached the
  receiver (216,952 B at 9.75 s). Three 720p reservations (659,128, 673,604 and
  659,692 B) were accepted and charged, but none completed as verified peer
  media within the receiver's buffer-safe wait on the relay path (about 255 KB/s
  on the best link). The fourth (661,948 B) was refused as exhausted at
  2,625,232 of 3,000,000 B, and the only high-quality holder stopped. The shared
  allowance behaved as documented in
  [Account upload budget](ACCOUNT-UPLOAD-BUDGET.md): the client reserves its full
  payload before sending, and an accepted reservation stays charged after
  cancellation. This is a design limitation under relay throughput, one
  high-quality holder and a 3 MB cap, not a recorded product defect. It is
  recorded RED and open. The owner then raised the starting allowance to 6 MB
  for one run on the deployed `1d54538`: high-quality peer media from the shared
  account completed (seven of eight 720p reservations verified, 4,689,096 B), but
  the lifecycle stayed RED at natural exhaustion
  (`RED_LOCAL_SESSION_CAP_BELOW_SEGMENT_NO_ACCOUNT_REFUSAL`). Each uploading page
  takes the smaller of its local allowance and the account's remaining allowance
  when uploading is applied, and refuses locally once a segment exceeds its own
  remainder, so the account never received the request it would have refused. A
  different cap cannot reach that stage; P06 is stopped by decision.
- **Safari 17.6 on the desktop is RED.** No verified peer download within 45 s
  and no selected ICE candidate pair was recorded; every fragment came from the
  origin. The cause is not determined and the journey was not retried.
- Physical iPhone (unavailable), physical Android and device Safari or Firefox
  (these need the owner), hard NAT and a separate network (these need another
  network) remain open and unverified. npm publication is out of scope.
- Release: v0.2.1 is published as an experimental prerelease by owner decision
  while field acceptance remains open: Item 5, P06, Safari 17.6 and the v0.2.1
  short qualifier R68 are RED. See
  [Release verification](#release-verification).

Run-by-run evidence is in [Goals and agent handover](AGENT-GOALS.md). See the
[checkpoint record](../spikes/results/140c256-current-delivery-checkpoint-20261021.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Previous checkpoint: 20 October 2026 (5f2ece0)

Checkpoint: 20 October 2026. The pilot runs
`5f2ece0bc8e0a78e9a7eca5c56f5ca9141df4669`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/39384666332),
fresh consumption of 284 package members, guarded deployment and its
independent review passed, followed by reporting lifecycle acceptance (P05) and
parent-crash recovery (P07 r5). The fourteen-role qualifier is RED from R62 to
R65: R65 completed its 300-second measurement with 14 of 16 gates, failing
`each4BothQualityPeer` and `all8ActuallyUploaded`. A one-link probe through the
pilot's TURN service, with no qualifier load, moved high-quality segments at 3 to
4 Mbit/s over TLS; UDP relay addresses were no faster and lost more. Run-by-run
evidence is in [Goals and agent handover](AGENT-GOALS.md).

Earlier checkpoint: 19 October 2026. The pilot
runs `3f706a9bc4a895d17345be26b77006cf13093c46`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/39169937465),
fresh consumption of 280 package members and guarded deployment passed.
The 773,458-byte browser client is unchanged. Nostr allowances are enabled;
the host-supplied account API is implemented, with no website resolver
configured. Reporting and forwarding remain off.

**Durable reporting acceptance passed.** A real browser remained silent before
opt-in, sent an accepted report after trusted user input, and handled duplicate
reports idempotently. A same-volume restart preserved the report and policy;
the report then expired naturally after 304.105 seconds. No clock or retention
override was used. Reporting was restored to off, and browser and finite-source
cleanup passed independent review. This closes the current P05 reporting
check; it does not qualify the remaining load or device requirements.

**Crash-recovery acceptance remains RED.** The latest test passed the
parent-only crash, strict writer audit, guarded marker recovery and server
restart. Publisher state, all four permanent leases and the original restart
policy were preserved. Browser playback did not recover: six playlist HTTP 502
responses exhausted hls.js's retry budget before the server became healthy.
The fatal network error remains in the receipt. No post-restart decoded
progress was proved. Owned browser and verification-source cleanup passed;
the failed acceptance window was not extended.

An existing browser regression also reproduces the failure against the
unchanged source with a 35-second HTTP 503 outage: playback stays at the same
frame count after service returns. The retry correction and a separately
reproduced origin-only admission-epoch correction are being verified. The
specific reason the actual crash test lost its current swarm report remains
unproved. See the [latest recovery checkpoint](../spikes/results/3f706a9-parent-crash-recovery-checkpoint-20261019.json).

The fourteen-viewer short qualifier has not passed. R55 stopped during setup;
the earlier R54 both-quality peer-coverage failure remains unresolved on the
current field configuration. The two-hour/churn/TURN-expiry run remains
ineligible. After an earlier outage, a bounded M4 connection check at 23:15 UTC
on 18 October succeeded. Fresh resource and runtime checks remain required;
other work must keep running.

P01–P12 source surfaces are implemented; production acceptance and release
remain incomplete. The remaining work is crash/restart acceptance, matching
short and sustained qualification, both-quality shared-budget lifecycle,
browser/device/network coverage, matched bandwidth benefit and final release
checks. See the [checkpoint record](../spikes/results/3f706a9-current-delivery-checkpoint-20261019.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Historical a02d5ec checkpoint

Checkpoint: 18 October 2026. The experimental pilot runs
`a02d5ec4d5408c8c196e0c259d07c7fc68e965d6`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/39160708033),
fresh consumption of 278 package members and guarded HTTPS deployment passed.
The 773,458-byte browser client matched its image. Private state, permanent
leases and the independent proxy were preserved. Nostr account allowances
are enabled; the authenticated host-supplied account API is implemented.
Reporting and forwarding remain off.

**The short qualifier remains unproved.** R55 stopped during setup at its sixth
browser navigation, before any measurement. Its six acquired contexts and
owned source, processes and temporary files passed independent cleanup review.
This supplies no fourteen-viewer or 300-second qualification. M4 subsequently
became unreachable from this Mac, so distributed checks remain pending while
other work continues.

**Durable reporting acceptance also remains RED.** A later single-browser test
ran for 85.580 s. Playback progressed and the server enabled reporting, but the
browser refused the changed telemetry setting at the unchanged policy revision.
The reporting opt-in control stayed disabled and no report request was sent.
Restart durability and natural five-minute expiry were not reached. Reporting
was restored to off; full browser and finite-source cleanup passed independent
review. The server's persisted policy revision needs to include startup
telemetry changes; the browser's conflict and consent checks remain required.

The source correction persists the telemetry setting and advances its policy
revision before serving a changed setting. Focused operator and bundled-client
regressions pass, including migration, malformed-state preservation and consent
([local results](../spikes/results/operator-policy-revision-20261018.json)).
CI, deployment and the reporting acceptance rerun remain pending for that fix.

P01–P12 source surfaces are implemented; production acceptance and release
remain incomplete. Matching short qualification, two-hour/churn/natural expiry,
both-quality account lifecycle, durable reports and crash recovery,
browser/device/network breadth, matched wire/cost benefit and final
release/download checks remain open. See the
[checkpoint record](../spikes/results/a02d5ec-current-delivery-checkpoint-20261018.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Historical 3515d5b delivery checkpoint

Checkpoint: 18 October 2026. The experimental pilot runs exact
`3515d5b0acad4d18811ed08e4d9f7648781e55cf`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/39157143848),
fresh consumption of 277 package members and guarded HTTPS deployment passed.
The 773,254-byte browser client matched its image. Private state, permanent
leases and the independent proxy were preserved. Nostr account allowances
are enabled; the authenticated host-supplied account API is implemented.
Reporting and forwarding remain off.

**R54 remains RED after 303.647 s of measurement.** Fifteen of sixteen gates
passed: all fourteen viewers progressed video and audio, all eight
contributors uploaded, both qualities decoded, and consent, resources,
in-place renewal and all admission checks passed. The requirement for every
receiver to obtain verified peer media at both qualities failed: receiver 2
had no measured LOW peer bytes; receiver 3 had no measured HIGH peer bytes.
The successful elapsed window does not supply strict qualification. The
two-hour run remains ineligible.

The deployed demo explicitly selects four neighbours; the SDK default stays
six. Provider observations recorded zero admission refusals and a peak of 731
calls per aligned minute against the selected 900-request address budget.
This is a healthy measured run, not proof of six-neighbour capacity or the
individual effect of replay dropping versus the changed profile. The original
fourteen-viewer, eight-contributor, every-receiver both-quality and resource
requirements remain unchanged.

The complete receiver request tails reconcile with all cumulative outcome
counters. Receiver 2 made no LOW request, with 88 `no-have-no-wait`
observations. Receiver 3 recorded 34 HIGH timeouts, 27 with partial bodies;
its only HIGH completion occurred before measurement. Upload refusals were
exclusively token-bucket rate refusals. These observations do not identify a
specific network, queue, CPU or receiver-to-uploader cause.

All fourteen contexts and the owned processes, profiles, stages and finite
source passed independent cleanup review. The public pilot, router and proxy
remain running intentionally. Other work on the Macs remains untouched.

A later local correction lets an admitted discovery caller advise the exact
requested key to a full serving peer. It permits the same bounded idle
replacement when the peer holds that key, without changing admission, consent,
rotation or connection limits. A two-swarm regression fails on the original
source and passes after the correction; malformed advice and serving withdrawal
during admission are refused. All 196 combined loader, discovery and receiver
tests pass. This is separate from R54: neither its precise cause nor a field
repair is established. The correction still requires CI and deployment.

P01–P12 source surfaces are implemented; production acceptance and release
remain incomplete. Matching short qualification, two-hour/churn/natural
expiry, both-quality account lifecycle, durable reports and crash recovery,
browser/device/network breadth, matched wire/cost benefit and final
release/download checks remain open. See the
[checkpoint record](../spikes/results/3515d5b-current-delivery-checkpoint-20261018.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Historical c0f337d delivery checkpoint

Checkpoint: 18 October 2026. The experimental pilot runs exact
`c0f337d0fe0439c64b05aed847e9d49ee4350e15`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/39152159082),
fresh consumption of 276 package members and guarded HTTPS deployment passed.
The 772,551-byte client matched its image. The selected relay-only TLS/TCP
TURN configuration and admission budgets remain unchanged. Nostr account
allowances are enabled; the authenticated host-supplied account API is
implemented. Reporting and forwarding remain off. Private state, permanent
leases and the independent proxy were preserved.

**Neither field run passed.** R52 stopped after 156.325 s when its resource
monitor rejected a timestamp as future. All fourteen viewers had progressed
video and audio; this partial run grants no full qualification. A separate
controlled regression reproduced fractional-versus-integer millisecond
comparison failure. The corrected monitor passes eight checks while retaining
the original freshness limits; the failing R52 clock values were not retained,
so this does not establish its exact cause.

R53, with the corrected monitor, stopped after 17.135 s of measurement on
admission refusal. Browser records contain twelve HTTP 429 responses, with
no public-observer unknown or capacity overflow. Provider counters show 900
accepted admission calls, then twelve refusals and a return to successful
responses. This supports exhaustion of the configured 900-per-address
60-second budget; the server error body and exact bucket state were not
retained. Both runs passed independent finite-source and browser cleanup.
The full short qualifier has not passed, so the two-hour run remains ineligible.

R52's new diagnostics recorded partial bytes in 84 of 94 HIGH receiver
timeouts. LOW requests completed more often. Transport assembly, verified
playback acceptance and wire costs remain separate; these observations do
not establish a network cause or a performance repair.

The local candidate drops already-seen offers before redundant host admission
work, while retaining the checks after pending admission completes. It adds
eleven fixed local counters for actual host callback sites. The settled-replay
regression fails before the correction and passes afterwards; sixteen focused
and all 194 combined loader, discovery and receiver tests pass. This does not
establish how often R53 replayed offers or demonstrate a field repair.

The local candidate selects four demo neighbours rather than the SDK default
six. This is an explicit configuration change awaiting CI, deployment and
field checks. The same fourteen-viewer, eight-contributor, every-receiver
both-quality and resource requirements remain in force. It does not establish
six-neighbour capacity or guarantee an admission-rate reduction.

P01–P12 source surfaces are implemented; production acceptance and release
remain incomplete. Both-quality account lifecycle, durable reporting,
crash recovery, natural expiry/churn, browser/device/network breadth,
matched wire/cost benefit and final release/download checks remain open.
Other work on the Macs must keep running. See the
[checkpoint record](../spikes/results/c0f337d-current-delivery-checkpoint-20261018.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Historical 2911ea5 delivery checkpoint

Checkpoint: 18 October 2026. The experimental pilot runs exact
`2911ea55f1bd21335a979df8a3fd38ed83cc6bee`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/39148186931),
fresh consumption of 275 package members and guarded HTTPS deployment passed.
The 769,958-byte client matched its image. Relay-only ICE, TLS/TCP TURN,
admission 32 and the selected 900-request address budget remain configured.
Nostr account allowances are enabled; the authenticated host-supplied account
API is implemented. Reporting and forwarding remain off. Private state,
permanent leases and the independent proxy were preserved.

**R51 remains RED after 306.350 s.** All fourteen roles progressed video and
audio, all eight contributors uploaded, and in-place renewal, admission,
reconciliation, recovery and resource checks passed. Only the requirement
that each receiver obtain verified peer media at both qualities failed:
receivers 1 and 2 obtained both; receiver 3 obtained only LOW; receiver 4 only
HIGH. All owned contexts, processes, profiles, tunnels and the finite source
passed independent cleanup review. Cleanup does not change the failed verdict.
The matching short qualifier has not passed, so the two-hour run is ineligible.

Receiver 3 saw positive HAVE and valid commitments without completing HIGH
peer delivery. Its observed wait-to-HAVE median was 651 ms, leaving at most
849 ms of the initial 1,500 ms budget before further work. Receiver 4 recorded
80 LOW decisions with no eligible neighbour; its bounded replacement dial
was rejected. Precise transfer/refusal and network causes remain unproved.

Later local source changes add bounded request-outcome and upload-refusal
diagnostics and correct a separate allocation inconsistency: alternatives
already excluded by the selector's measured deadline-fit rule reserve no time
from a cold peer. A controlled 670 kB delivery at 1,470 ms fails before the
correction and passes afterwards within the unchanged 1,500 ms deadline.
All 187 combined loader, discovery and receiver tests pass. These changes are
not deployed or field-qualified at this checkpoint and do not prove an R51 fix.

The P01–P12 source surfaces are implemented; production acceptance and the
0.2.0 release remain incomplete. Both-quality account lifecycle, durable
reporting, crash recovery, natural expiry/churn, browser/device breadth,
difficult networks, matched wire/cost benefit and downloaded-release checks
remain open at their declared evidence gates. Other work on the Macs must
keep running; the test resource limits remain unchanged. See the
[checkpoint record](../spikes/results/2911ea5-current-delivery-checkpoint-20261018.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Historical 44b21d6 delivery checkpoint

Checkpoint: 16 October 2026. The experimental pilot runs exact
`44b21d69dd924fea648c2dc214df02dafa8e690c`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38859102559),
fresh consumption of 273 package members and guarded deployment passed.
Normal HTTPS matched the 769,303-byte client to the candidate image and read
both fresh playlists. Relay-only ICE, TLS/TCP TURN projection, admission 32
and the explicitly selected 900-request address budget are deployed. The
default request budget remains 600 and the global capacity 2,048.
Private publisher/account state, permanent lease identities and the independent
EE proxy were preserved. Reporting and forwarding remain off. Verification-source
cleanup and a fresh independent server review passed; actual source exit 255
is retained.

Bounded rendition-neighbour discovery and cold-peer deadline allocation are
deployed. The latter preserves useful time for an unmeasured peer while keeping
the existing total deadline and bounded alternatives. Its original-source
regression fails; five focused checks and all 160 swarm tests pass. These local
checks do not establish the cause or repair of an earlier field failure.

**R30 remains RED, with 36,188 ms measured.** All fourteen roles started;
setup observed 64 connected links and 1,323,896 verified peer bytes globally.
The failing contributor recorded an unplanned origin-only interval lasting
82 ms before peer-first recovered. Recovery does not satisfy uninterrupted
authority. The same page recorded a session request taking 5,146 ms; retained
network observations include a five-second cancellation without headers and
later connection-pool delay. Their timing fits expiry before a subsequent
renewal completed, but exact clock/request joins and the downstream cause
remain unproved. Final admission coverage, reconciliation and caller-abort
recovery checks passed. All fourteen contexts, owned processes, profiles,
tunnels and the finite source passed independent cleanup review.

The defined P01–P12 feature surfaces are implemented. Nostr and an authenticated
host-supplied account API are supported; the Nostr-only pilot is valid. Prior
account API, focused LOW lifecycle, native iOS Simulator and Internet TURN
component passes retain their original revisions and limits. The historical
full-window R28 still failed both-quality coverage for two receivers; R29
stopped at 117.240 s. Neither is a matching successful qualifier for this build.
The matched-cost comparison remains inconclusive; payload counters do not
establish wire or bill savings.

No matching full 300 s, 7,200 s/22-churn or natural expiry acceptance exists.
The longer run is ineligible until the short qualifier and its cleanup pass.
Physical/browser breadth, difficult networks, matched wire/cost benefit and
final release/download acceptance remain open. PR 8 remains open; v0.1.0 is
published and 0.2.0 remains the source candidate. See the
[checkpoint record](../spikes/results/44b21d6-current-delivery-checkpoint-20261016.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Historical afbf052 delivery checkpoint

Checkpoint: 16 October 2026. The experimental pilot runs exact
`afbf052df93d6b4902703dddb4b5987ec6119e6e`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38821621670),
fresh consumption of 271 package members and guarded HTTPS deployment passed.
The 762,188-byte browser client remains byte-identical to 18bb; the runtime
change reclaims settled TURN viewer entries after lease expiry or failed
initial issuance. Fresh leases and unresolved issuance retain their slots.
Two original-source regressions fail; the corrected service passes 16 tests,
and 49 combined TURN checks pass. Private state, permanent account/publisher
leases and the independent EE proxy were preserved. The temporary verification
source was removed, retaining its actual exit 255; independent cleanup passed.

The defined P01–P12 feature surfaces are implemented. Both Nostr and an
authenticated host-supplied account API are supported; the Nostr-only pilot is
valid. Prior account API, focused LOW lifecycle, native iOS Simulator and
Internet TURN component passes retain their original source and scope. The
18bb Internet cohort remains historical component evidence for this source.

**R20 remains RED, with 0 ms measured.** All fourteen contexts were acquired,
and all twelve intended peer participants had peer-first mode and available
TURN in their latest preflight snapshots. Subsequent control failures stopped
setup: 37 admission verifies returned HTTP 429 before cleanup, 38 finally,
and two requests failed. Delayed session bodies align with policy expiry and
an OFF session for receiver 3; a separate HTTP 200 verify body did not complete
before its three-second abort. Policy-expiry attribution is a supported timing
inference, not an exact cancellation-hook join. All fourteen contexts and
owned processes/profiles/stages/source passed independent cleanup review.

Offline replay of the unchanged admission counter reproduces exactly 600
accepted requests and 37 address-budget refusals from 637 calls in one window.
Caddy presents one backend socket address; forwarded IP headers are not trusted.
This exposes the shared 600-per-minute address budget, while the global budget
remains 2,048. Adding startup spacing alone does not establish a repair: even
optimistic timing counterfactuals retain refusals. The source candidate exposes
operator configuration of the existing address-request limit: 16 CLI checks
and four admission tests pass, default 600 is retained, and a measured-cohort
pilot setting of 900 is planned. New
configuration CI, deployment and field evidence remain required.

A separate idle control-path check completed 48 ordinary HTTP/1.1 requests
across both Macs, server public HTTPS and server loopback. All returned 200;
maximum observed body times were 1.9/11.7/0.9/2.0 ms respectively. These fresh
connections do not reproduce the loaded browser delays or establish a cause.

No matching full 300 s, 7,200 s/22-churn or natural expiry acceptance exists.
Physical/browser breadth, difficult networks, matched wire/cost benefit and
immutable release/download acceptance remain open. PR 8 remains open;
v0.1.0 is published and 0.2.0 remains the source candidate. R13–R20 retain their
original RED verdicts and declared contracts. Automatic surviving-guardian
worker drain is implemented; guardian/host catastrophe requires inspection.

See the [checkpoint record](../spikes/results/afbf052-current-delivery-checkpoint-20261016.json)
and [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist).

## Historical a416f7e delivery checkpoint

The experimental pilot runs exact
`a416f7e1ee2d73acc6535b313baac018f2baab8a`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38775128822)
and fresh offline consumption of 269 exact-source package members passed.
The installed CLI, eleven imports, durable ledger and native/HTTP fallback pass.
The consumer resolves the declared production dependency ranges; the separate
standalone ESM is bound to the root lock. Normal HTTPS attestation matched the
761,854-byte client, SHA-256
`570f12f862e9d8609c8d8f207abbc5a22346f4ed7fde0d099fc256244507d671`,
from image
`sha256:cf44c19870338976f0a0bfd6e1bc22ca177f54ca6b6d4418bbafc5755349bcda`.
Relay-only ICE, TLS/TCP TURN selection, admission 32 and Nostr account budgets
are configured; reporting and forwarding are off. Private state, permanent
leases and the independent EE proxy survived deployment. Verification-source
cleanup passed all five guards, retaining actual exit **255**.

The selected account scope is **Nostr plus an authenticated host-supplied
resolver API**. No named external website or human-wallet integration is a
required feature; the Nostr-only pilot is valid. The public cross-Mac account
API trial passed the shared cap, overlapping client reservations, replay,
conflict, reopen and grant fencing with a disposable owner. Client overlap
does not prove simultaneous server arrival. Its final limit was zero/spent 100;
the disposable ledger row is intentionally retained.

The focused LOW browser lifecycle passed all seven component gates in
**74.412 s**: one verified low fragment/213,756 bytes and a real M1 production
reservation; actual reload with a new page key, retained local/shared spend and
upload still off after reconnect; fresh trusted Apply followed by a new
206,424-byte reservation; M4 active serving-state Disconnect; and LAST UI
10 MB/reset:false Settings with no subsequent fixture resume. All four contexts,
exchanges, CDP, endpoint profiles and source cleanup passed. The final real
zero-cap/logout retained spent 1,901,244 and cleared owned key buffers.
This is not high-quality delivery, identified in-flight cancellation or the
original both-quality/exhaustion acceptance. That original 3 MB trial remains
RED: both donors accepted serving, but no high fragment completed verification
before natural shared-cap refusal. Its later lifecycle gates were unmeasured.

Native iOS 26.5 Simulator Safari passed trusted Start, Home/return and Resume,
with advancing video clock/pixels and frame deltas 59/61, zero fatal/native/page
errors and upload/report consents off. Cleanup and all 38 pre-existing Simulator
states passed independent review. Return was still playing (`paused: false`),
so the physical stopped-video fault was **not reproduced**. Physical-device,
audible-audio, public-peer and enabled-upload-withdrawal acceptance remain separate.

The original 4+10 R10 capacity attempt remains RED at 33 observed processes
against M1's unchanged cap of 32, before measurement; its original M4 receipt-read
failure and later fenced recovery remain separate. The new 3+11 R12 attempt
started all fourteen roles but measured only **97.691 s** before an observed
runtime admission refusal. Resource/shared-reader gates and all owned cleanup
passed; the underlying cause is unproved. The source now retains a bounded
replacement admission ticket and validates it before a new dial, preserving
later candidates across earlier validation. The original source failed the
maintained cooldown-renewal regression; the corrected source passed all 12 focused
regressions and all 137 swarm tests. This local correction has no new CI or
deployment proof and has not been established as the R12 cause. No matching
300 s or 7,200 s/22-churn acceptance exists. Historical 533 short public/Internet passes below retain
their exact revision and do not become new a416 cohorts.

See the [current checkpoint record](../spikes/results/a416f7e-current-delivery-checkpoint-20261015.json)
for exact evidence hashes. The full [P01–P12 requirements](PRODUCTION-READINESS.md#delivery-checklist)
and 37-review-item scope remain open: complete both-quality/shared-budget and
physical/browser coverage, difficult networks, natural expiry, matching capacity
and sustained/churn operation, matched wire/cost benefit and immutable release
acceptance. PR 8 remains open; v0.1.0 is the published prerelease and 0.2.0 the
source candidate. No completed separate 37-row ledger is claimed.

## Historical 5334091 delivery checkpoint

The experimental pilot runs exact
`53340911d3bb973fb392c1bad1f8f72aec2aa8bd`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38741613596)
and fresh offline consumption of 267 exact-source package members passed.
Guarded deployment served the 759,084-byte client, SHA-256
`ca2d08ad1c4c2459658d5a2d0a6e045bf5ff7b464491b0bd49180ca1cacdd6f0`,
from image
`sha256:9d911f23d618cc5f78f79b5817a119f6b38439938a356f60a717763258d787a4`.
Relay-only ICE, TLS/TCP selection, admission 32 and Nostr account allowances
remain configured; website authentication, reporting and forwarding are off.

The ordinary public check passed all three original application gates over
60.034 s, independently replayed from retained samples. The receiver verified
one low and one high fragment, 868,936 bytes total, or 5.8896% of its measured
encoded media payload. All four players had zero observed fatal/native media
errors or stalls. Twelve requests were accepted for serving; only two verified
completions were proved. The other ten causes remain unknown. This is neither
sustained reliability, a matched baseline benefit nor wire/cost savings.
All owned cleanup passed. The separate genuine Internet TURN diagnostic passed
90.043 s/40 verified fragments; its first local lease was shortened to 60 s
against real 3,600 s credentials, so natural expiry remains unproved.

The latest fourteen-role attempt stopped after 24.522 s at the unchanged M1
32-process limit, with three players started and no measurement window. Its
original M4 cleanup-receipt read failed; subsequent fenced recovery proved
endpoint/profile cleanup, archived the owned stage and removed it after fresh
absence checks. Original browser-context closure remains unknown. No matching
300 s capacity qualifier or two-hour/22-churn result exists.

The cross-Mac account API diagnostic failed before reservations: M4 received
a valid challenge but measured 30.016 s against the client's strict 30 s upper
bound. A final zero-cap/spent-zero policy was observed; missing-token revocation
remains unknown, while both actors exited and cleared their owned key buffers.
The unreleased source corrects issuer-relative lifetime measurement without
extending grant/delegation limits, and provides explicit media recovery after
background suspension. Local regressions and a trusted-click Chrome check pass.
The latter reloads media, proves decoded video/audio progress, retains errors
and spend, and leaves both consents off; explicit Apply rejoins receive-only.
This synthetic pause/reload check does not reproduce the physical Safari
failure. These checks remain separate from deployment,
real owner/website authentication, upload enforcement and iPhone acceptance.
See the [checkpoint record](../spikes/results/5334091-public-and-account-checkpoint-20261015.json).

The complete [P01–P12 requirements](PRODUCTION-READINESS.md#delivery-checklist)
remain open, including sustained sharing, physical/Safari and hard-NAT checks,
natural expiry, shared-account field acceptance, matched wire/cost evidence and
immutable release/download checks. PR 8 remains open; v0.1.0 is still the only
published prerelease. Historical failures below retain their original scope.

## Historical 3e52294 delivery checkpoint

The experimental pilot runs exact
`3e52294c2e1f44ab9cbed13adf43e94e995f1e2d`. All nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38701249959)
and fresh offline consumption of 262 exact-source package members passed.
The installed CLI/native HTTP fallback, durable ledger and rebuilt standalone
ESM checks retain their own scope; hosted browser checks are injected headless
loopback evidence, not ordinary public or physical acceptance.

Guarded deployment and normal HTTPS attestation passed. The image is
`sha256:2e20d5dd2eb96f7505d03c3b018565e5756d27941b1ea5c5396d1206c95751ea`;
the served client is 757,269 bytes, SHA-256
`b561859c7b1b5167a5843d41569d0309915773a1c8dc91f7b1732cf138c35882`.
The attestation matched image/client/identity and read two fresh HLS playlists.
Exact deployed options are `--ice-transport-policy relay`,
`--turn-url-projection tls-tcp` and `--admission-per-address-tickets 32`, alongside
the existing server-owned issuer. Nostr account allowances are enabled; the
website account resolver remains unconfigured. Reporting and forwarding stay
off. Private state and permanent lease/token identities survived the orderly
drain; account JSON atomic replacement is allowed. The temporary source was
removed under all five cleanup-v2 guards, retaining its actual exit code **255**.
Admission 32 is configuration evidence, not fourteen-role capacity acceptance.

The separate `selected-send-and-resolved-transport-v1` Internet renewal cohort
passed 90.031 s/88 samples: 40 verified fragments/4,631,756 bytes, including
23 fragments/2,656,252 bytes after the renewed transport boundary. Independent
replay also passes the unchanged original strict state machine on this same
cohort (initial 7.298 s, boundary 40.059 s, final 90.031 s). Two local isolated
headless Chrome pages used prepared synthetic HLS/local rendezvous and genuine
Internet TURN. Three genuine issuances had 3,600 s leases; the first local lease
was shortened to 60 s. The rebuilt 127,516-byte diagnostic candidate is distinct
from the exact standalone ESM. All seven worker/six supervisor cleanup flags
and fresh three-group/scratch absence checks passed. This is not a journey
against the deployed pilot, natural expiry or exact ingress attribution.
Earlier intermittent timeouts remain unexplained; no product repair or browser
bug is inferred, and previous RED cohorts remain RED.

**Ordinary public peer delivery remains RED.** The latest 60.038 s measured
four-role journey passed frame/audio decoding at both requested qualities and
contribution, with no fatal/native media errors or stalls. The receiver verified
zero peer fragments/bytes. Seven matching-HAVE requests reached valid metadata
and partial payload, but no EOF was observed before channel closure; six product
timeout closures and one abort were recorded separately. Their exact native-to-
product reason correlation and underlying send-queue/network cause remain
unproved. Donors accepted 633,184 low and 2,685,768 high bytes for serving; these
are not completed network delivery.

All four contexts, both CDP connections, owned worker/group/helper, endpoint
resources/stages and source cleanup passed. The actual source exit was 255.
M1 peaked at 39 processes under this check's 64-process cap; this does not
qualify the long scenario's 32-process cap. The [public result summary](../spikes/results/3e52294-ordinary-public-20261015.json)
retains exact evidence hashes and limits. Earlier preparation refusals, native
monitor failures and historical exact-54 delivery/cleanup failures remain
separate retained results.

Exact retained provenance is in
`deployment-3e52294-directional-proof-bound-20261015/ROOT-DEPLOYMENT-EVIDENCE-MANIFEST.json`,
`existing-turn-renewal-3e52294-directional-r5-run-20261015` and
`public-cross-hls-eligibility-3e52294-seventh-root-20261015` under
`artifacts/`. Deployment, forced-renewal cohort and ordinary public delivery
are separate proof classes.

The full [P01–P12 checklist](PRODUCTION-READINESS.md#delivery-checklist) and
37-review-item scope remain open; no separate completed 37-row ledger is claimed.
Ordinary public peer delivery, complete physical/Safari journeys, hard NAT,
website resolver integration, natural expiry/reconnection, cross-device budget
field evidence, fourteen-role capacity, 7,200 s/22-churn operation, matched
wire/cost benefit and immutable release/download acceptance remain outstanding.
v0.1.0 remains the published release; 0.2.0 is the source candidate. Package
0.2.0, session wire 3, commitment schemas 1/2 and metrics 2 are distinct.
The original CLI signs plaintext SDP; the browser loader uses pairwise NIP-44
signalling. Deployment does not close final production or release acceptance.

## Connection reuse and lease observations included in 5334091

The branch adds bounded draining of an abandoned response on known ordered,
fully reliable peer channels. The request still resolves promptly; the link
remains busy until a validated terminal response or the existing drain timeout.
Signed verification, wire framing and playback/fallback deadlines are unchanged.
Redacted TURN lease provenance and a passive three-scalar getter support later
natural-renewal observation without fetching credentials or granting freshness.

All 170 focused maintained-source checks pass, including 12 new framing/drain
cases and 33 lease-observation cases, with guarded cleanup and fresh worker-group
absence. The [source-check summary](../spikes/results/peer-link-response-drain-source-checks-20261015.json)
retains exact file hashes. The later 5334091 CI, deployment and short ordinary
public pass are recorded above. They do not establish causal improvement over
the unchanged historical 3e failure or natural expiry from pure witnesses.

## Historical implementation and delivery checkpoints

The following dated results retain their original source, topology, failures
and limits. Their statements about then-current deployment or pending options
do not describe the current pilot above. Later passes do not rewrite a RED.

The optional TURN adapter now supports explicit `issued`/`tls-tcp` URL selection.
It keeps the raw issued lease and expiry, selects TCP only for secure URLs whose
transport was unspecified, and independently checks the projected client response.
Selection changes require fresh Apply/upload consent. Invalid refreshed descriptors
revoke the prior policy immediately, including at the same unexpired clock.

Twenty-nine credential/service tests passed. The first focused run remained RED
at two new initial-state assertions that misread the disabled optional adapter's
availability flag. A test-only correction checks actual peer authority and the
initially disabled Start button; all 52 demo-client tests then passed in 7.942 s.
Runtime bytes were unchanged between runs, and all recorded outer cleanup checks
passed within the original bounds. The [TURN URL checkpoint](../spikes/results/turn-url-projection-checks-20261015.json)
retains both scopes. This option has no Internet allocation, deployment or public
delivery qualification yet.

The swarm, demo and broadcaster now expose explicit `all`/`relay` ICE candidate
policy, defaulting to `all`. A changed policy stops peers, clears upload consent
and fences an Apply awaiting old admission. Fourteen focused tests, syntax for
142 modules and documentation checks passed in 7.219 s within the unchanged
40/60 s guard. All five recorded outer cleanup checks passed. The
[ICE policy checkpoint](../spikes/results/ice-transport-policy-checks-20261015.json)
records that local scope. Relay-only does not force TLS or prove a delivery repair;
the option has not been deployed or publicly qualified.

Exact `e7330694dbcd7a16d5ac305dbde74f95162fbdc7` subsequently passed all nine
required [CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38699590666)
and fresh consumption of all 261 committed package members. Its hosted loopback
broadcast receipt verified five peer loads/2,695,920 bytes across four checkpoints,
including 842,804 bytes after restart. The two contributors each recorded one
buffer stall and one console 404 was retained. These results predate the TURN URL
selection above and do not establish ordinary public or physical acceptance.

The latest worker shutdown correction refuses further TERM/KILL IPC after its
first force request or an accepted drain witness. Two regressions reproduce
EPIPE with the preceding source; all 21 focused lease/controller tests pass
with the correction. The 6.645 s guarded run retained the original time and
resource bounds, with all five recorded outer cleanup checks passing. Syntax
for 142 modules passed separately.

The earlier combined local suite remains RED: a 6 s playlist fixture timeout
preceded the original 40 s work cutoff, and initial group absence failed. The
confirmed remaining task TLS probe was subsequently stopped after fresh exact
identity and fixture checks; its absence and group absence were then proved.
This later recovery does not change the original result. The
[stop-message correction checkpoint](../spikes/results/worker-stop-send-fence-checks-20261015.json)
records the separate scopes; the focused pass is not a full-suite pass.

Exact `f3eeef340213a009f7986f1d8d69073e7e0edda1` passed fresh 259-member
package consumption. Its [CI run](https://github.com/forgesworn/relayswarm/actions/runs/38691157253)
passed eight required jobs and failed the RTMPS capability guard's orderly
close with `worker-group-probe` / `unknown`; the later broadcast browser step
did not run. That hosted failure's cause remains unproved. Corrected-source
CI and fresh package consumption subsequently passed on exact
`91423b2e7eb1576f67265b64208023d565f8c5f8`: all nine required
[jobs](https://github.com/forgesworn/relayswarm/actions/runs/38694780028) passed,
and the clean consumer verified 260 package members. Its hosted loopback
broadcast check verified six peer loads/3,298,836 bytes across four checkpoints,
including 756,888 bytes after restart. Those results predate the new ICE option;
they do not establish ordinary public delivery or final production acceptance.

The broadcaster exposes `--admission-per-address-tickets` (1–120, default 12)
for the existing per-socket-address quota. Viewers behind a proxy can share
that address. The focused admission and broadcaster checks passed all 33 tests,
with syntax for 142 modules, in a 28.445 s guarded run. Other quotas and ticket
expiry retain their defaults. This option has not been deployed or qualified
with fourteen viewers.

Exact `54da3840a6a057d2112945b3b465704a030aac32` passed all nine required
[CI jobs](https://github.com/forgesworn/relayswarm/actions/runs/38663487490), fresh
258-member package consumption and the complete 90.006 s forced-early Internet
TURN renewal check. The receiver verified 40 fragments/4,632,696 bytes, including
23 fragments/2,654,936 bytes after the renewed transport boundary. Real
credentials lasted 3,600 seconds; the first local lease was conservatively
shortened to 60 seconds. This does not prove natural expiry or prolonged load.

The experimental pilot now runs exact 54 with server-owned credentials from the
existing TURN service. Normal HTTPS attestation matched the live client to the
image and read both fresh HLS playlists. Identity and permanent leases matched;
private budget files were retained across the orderly drain. The account JSON
inode changed during an atomic write. The temporary source was stopped and
removed with its actual exit code 255 retained.

The subsequent ordinary four-role public check remains RED after 60.072 s.
Playback and accepted contribution passed; the receiver verified zero peer
loads/bytes at both qualities. Five matching-have opportunities reached five
commitment requests and five request timeouts. Donor counters record accepted
serves, not completed wire delivery. The original M4 cleanup failed its strict
full-command comparison. Its same-read witness retained the Python launcher to
runtime command-name change; later original-birth/group absence and owned-stage
removal passed without signals. All task-owned actors and the finite source
were then absent. No request-timeout cause or cleanup repair is claimed.

A later response-phase diagnostic stopped before measurement when the unchanged
0.5 s ownership process probe timed out. It provides no new peer result. The
M4 endpoint's ten cleanup flags passed with the direct kernel runtime; its
original controller assertion remains separate from later actor/stage absence
and source removal proof.

A further diagnostic reached 50.513 s of the required 60 s before the unchanged
0.5 s group-membership probe timed out. Its application gates remain unmeasured;
all original endpoint and outer cleanup checks passed. Three receiver responses
had matching metadata but no matching EOF when JavaScript entered channel close:
two had no chunks and one had 114,688 of 204,356 declared bytes. Product timeout,
abort and channel-error counters are separate observations; native channel
ordinals were not joined to product request reasons. This narrows the observed
phase to incomplete responses without establishing a cause or a passing run.

The [pilot and acceptance checkpoint](../spikes/results/pilot-turn-acceptance-20261015.json)
records these separate scopes. Ordinary sharing, Safari/physical devices,
natural expiry, sustained/churn, matched wire/cost and immutable release gates
remain open. Earlier RED results remain unchanged.

<a id="current-correction-checkpoint"></a>

## Historical correction checkpoint

The broadcaster guardian now keeps a live wrapper as each worker's process-group
leader. It commands that wrapper through its original IPC channel, avoiding
TERM/KILL against a numeric group after the leader has been reaped. Unknown IPC
or cleanup evidence retains the dirty fence. The four worker slots, 1,500 ms
force timer and 5,000 ms drain deadline are unchanged; each occupied slot adds
one Node wrapper.

The reviewed source passed syntax for 142 modules and a combined publisher and
broadcast-guard run: 305 passes, two platform skips and no failures or
cancellations. Real-process cases cover parent termination, redirected
descendants, exact 128 KiB output and inner exit code 19, followed by lease
handoff. The 28.521 s run retained 27 resource samples, peaking at 1,293,959,168
bytes/22 processes with at least 40% free memory. Worker/group/birth and probe
reaping passed; detached test-group and scratch absence are outside that outer
guard's proof. The later exact-54 CI, package and pilot results are recorded above. The [worker correction checkpoint](../spikes/results/worker-live-group-checks-20261015.json)
records the exact source and retained evidence. Natural TURN expiry, ordinary public peer delivery, Safari/physical journeys,
sustained operation, immutable publication and final production acceptance remain open.

## Earlier watcher correction checkpoint

The follow-up watcher correction filters named temporary/media-file events,
covers all authorised playlist names and case aliases, and revalidates changed
filename coverage within the unchanged three-pass bound. The native-client test
fixture also closes acquired resources on partial setup failure. Native tests now
emit TAP failure details; the real directory-replacement test retains a bounded
categorical trace if it fails. Neither instrumentation identifies the earlier
hosted failures' causes.

One serial local qualification first reproduced the new noise regression's 503
against exact-1b watcher code, then passed syntax for 141 modules, all 29 native
tests and 269 publisher tests with two platform skips. There were no corrected
suite failures or cancellations. The outer run took 27.375 s within the original
40/60 s guard; 26 resource samples peaked at 1,368,113,152 bytes/20 processes with
at least 47% free memory. Worker/group/birth and probe reaping passed. This does
not establish detached-group/scratch absence, native Windows qualification or
any remaining field gate. The [local correction checkpoint](../spikes/results/playlist-filter-and-native-fixture-checks-20261015.json)
records the exact source and retained manifest. Exact
`274cd4dd193047ddd606fa22cdfee2fe1b22e309` subsequently passed all nine required
jobs in [CI 38659745211](https://github.com/forgesworn/relayswarm/actions/runs/38659745211)
and fresh offline consumption of all 256 committed package members. That result
predates the worker-wrapper correction above and does not qualify it.

Exact `1b096a060abf5bc9bdadb320fa32243048522985` remains unreleased.
[CI 38657013063](https://github.com/forgesworn/relayswarm/actions/runs/38657013063)
finished with six required jobs passing, Windows failing the directory-replacement
publisher test, macOS cancelled during native tests, and dependent live-relay
checks skipped. Windows passed all 121 swarm tests; its publisher result was
222 passes, one failure and 43 platform skips. The macOS log records a failed
HTTP-fallback test before cancellation, without a retained assertion or final
test totals. Neither failure's native event chronology is established.

Fresh offline consumption of exact 1b passes all 254 committed package members,
the eleven imports, installed CLI/demo, durable ledger replay, separate-process
native transfer/HTTP fallback and standalone browser ESM. The unpublished
1,150,413-byte tarball has SHA-256
`870580a268b7a32143341146f079a1bff550274a5edd0dccbbc5ae91c712f99d`;
the 124,612-byte standalone ESM has SHA-256
`13291cbb1727d85144ddce6a4a2c49c0c2f0bc27e25bb54c2a7cf06fb22fb043`.
The independent audit is retained in
`artifacts/clean-consumer-1b096a0-diagnostics-preparation-20261014/analysis`.

The instrumented real Chrome collision test on exact 1b remains RED. Both
connections completed their offer/answer operations, including the yielding
connection's rollback, but stayed in ICE checking until their original dial
deadlines. Neither channel opened. The retained post-failure snapshot identifies
these states without establishing the cause or its exact instant. No settings
were changed. All worker/supervisor cleanup flags passed; audit:
`artifacts/native-chrome-glare-1b096a0-run-20261015/analysis`.

The subsequent R5 check used the existing Internet TURN service and the exact
1b standalone bundle. It remains RED at the initial transport prerequisite:
each endpoint retained 36 selected relay/TLS candidate-pair rows with known
zero received bytes. Missing selected-pair references remain unknown. Seventeen
complete peer fragments/1,981,896 bytes were verified before credential rotation;
that media does not establish the required positive counters on the selected
pair. Three real credential issuances succeeded and the donor accepted its new
lease, with two lifetime connections per page and no constructor refusal.
The test stopped at the missing prerequisite, so post-renewal media was not
assessed. Consent and nondecreasing spend were retained. All seven worker and
six supervisor cleanup flags passed within the unchanged time/resource bounds.
The independent audit is retained in
`artifacts/existing-turn-renewal-1b096a0-r5-run-20261015/analysis`.
No browser defect, server quota or product renewal cause is established.
The [public checkpoint](../spikes/results/internet-renewal-and-ci-checkpoint-20261015.json)
records these exact-source outcomes and retained audit hashes.

The following earlier checkpoints retain their original scope; they do not
qualify the later source or reclassify these failures.

Exact `cf479ebd7bd42df3a08a0fba6bc2ed0fb6f42b44` completed all nine required
jobs in [CI 38651823241](https://github.com/forgesworn/relayswarm/actions/runs/38651823241),
including Windows, both HLS modes and the media/broadcast journey. The optional
twelve-viewer soak was skipped. The retained broadcast receipt passes all four
original checkpoints with six verified peer fragments/3,249,204 bytes, including
post-restart high sequence 9/discontinuity 1 at 738,464 bytes. Peer deadlines and
the 2,000 ms origin reserve were unchanged; the smallest observed completion
margin was 35.506 ms. Each role retained one recoverable playlist HTTP 503;
both donors stalled once, baseline/consumer had no stalls, and fatal/native/
append errors were zero. Actual server close left zero blocked reloads/watchers.
This injected headless loopback result has no independent OS resource/reaping
journal and does not qualify ordinary public, physical-device or sustained use.
The offline audit is retained in
`artifacts/candidate-cf479eb-ci-observation-20261014/analysis`.

Fresh offline production-only consumption of the same exact source passed all
247 package members against committed bytes, eleven documented imports, the
installed CLI/demo, durable ledger replay, separate-process verified native
transfer/HTTP fallback and rebuilt browser ESM. The unpublished tarball is
1,124,565 bytes, SHA-256
`d1d2125e8e4641a67f0f78ea562a7f13a4143511640309d4a7639ab2377a0a5c`.
Owned phase groups, sampled probe children and recorded scratch cleanup passed.
Receipts are in `artifacts/clean-consumer-cf479eb-diagnostics-preparation-20261014`.
Publication, downloaded-release consumption and final deployment acceptance
remain pending.

The pending glare-reuse correction builds on that source. When simultaneous
offers make a viewer yield under the existing public-key tie-break, it reuses
only that peer's still-pending outgoing connection, with serial native operations,
negotiation-generation fences and the original absolute deadline/capacity slot.
Admission is checked before and after asynchronous rollback and before answering;
unsupported/failed rollback falls back without a replacement connection. Its
initial reviewed source/test SHA-256 pins are:

| File | SHA-256 |
|---|---|
| `src/browser/hls-swarm.mjs` | `bf729d7fcc08d3d1e599053e5eff789e98195878130c037ad24cb2fa08d49004` |
| `test/browser-hardening.test.mjs` | `71187521d2d50738577c59c82419c06bb3a133ff6f84e35039bf0f0d9d7f9188` |

All 121 maintained swarm tests passed with no failures, cancellations or skips
in a 19.781 s outer run, within the original 40/60 s and sampled
3 GiB/64-process/minimum-25%-free bounds. Worker/group/birth and probe reaping
passed. This is stateful fake-RTC/in-memory-signalling unit qualification;
native browser rollback/SCTP/channel reuse and genuine Internet renewal/media
remain unproved. The exact-CF CI/package results above do not cover this pending
source. Evidence: `artifacts/glare-reuse-r2-unit-validation-20261015/analysis`.

A subsequent real Chrome 155.0.8059.41 collision test on exact `b9a9be4`
remains RED. Both pages reached native local offers on one connection each,
with fresh admission and over 11.839 s left on their original dial deadlines.
The link checkpoint then failed. The receipt retained no failure-state snapshot,
so rollback, ICE, channel and admission causes remain unproved. All six worker
and six supervisor cleanup flags passed in 16.972 s; sampled resources stayed
within the original bounds. The retained audit is in
`artifacts/native-chrome-glare-b9a9be4-run-20261015/analysis`. The follow-up
fixture retains bounded read-only failure snapshots and passive native-state
counts; this instrumentation is no runtime repair.

Exact-b9a Windows CI separately passed 120 of 121 swarm tests, then failed the
existing own-ticket-renewal test's second-upload EOF wait. Its readiness predicate
observed an HTTP request rather than accepted admission. A fixture correction
holds that response and waits for a public acceptance marker within the same
five-second budget, preserving the original upload and revocation assertions.
The actual Windows response order and failure cause were not retained. Product
admission/presence code is unchanged from exact CF. The corrected full local
swarm suite passes 121 tests with no failures, cancellations or skips; syntax
passes for 141 modules. The combined outer run completed in 20.962 s within the
original guard, with recorded worker/group/birth and probe reaping. Windows
subsequently passed this suite on exact 1b, before its separate publisher failure
above. These follow-up results are recorded in the
[browser and admission checkpoint](../spikes/results/glare-browser-and-admission-checkpoint-20261015.json).

Separately, 30 pure observer/model tests passed in 355 ms, preserving unknown
selected-pair counters as null/status rather than zero and retaining the strict
positive selected relay/TLS gate. Evidence:
`artifacts/turn-selected-pair-observation-r2-pure-validation-20261015`.
The actual Internet R4 remains RED: accepted refreshed credentials and preserved
consent/spend did not prove post-renewal TLS/media, and its selected-pair counter
ambiguity cannot be repaired retrospectively. Native browser, Internet renewal,
ordinary public contribution, sustained/churn and full field gates remain open.

Earlier failures remain separate. Exact `83f72de` Windows native/swarm passed
before two publisher failures: directory replacement exhausted the unchanged
revalidation budget, and the master-removal mock selected a parent watcher
without a filename. The correction narrowed Windows parent metadata events and
fixed the mock; its local publisher suite passed 264 tests with two skips.
The native fourth-pass event chronology remains unproved. Exact `4aa87c7`
[CI 38646569729](https://github.com/forgesworn/relayswarm/actions/runs/38646569729)
retains three publisher-matrix failures. An intervening local 260-pass/one-fail/
two-skip run failed guardian descendant cleanup; later diagnostics and the
263-pass/two-skip suite did not identify that failure's cause. The
[correction evidence](../spikes/results/playlist-ci-and-guardian-correction-20261014.json)
retains those source hashes and outcomes. No prior RED is reclassified by the
current passes.

## Complete-playlist blocking reload candidate

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

## Shared account allowance implementation checkpoint

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

<a id="current-deployed-checkpoint-8f-on-14-october-2026"></a>

## Historical deployed checkpoint: 8f on 14 October 2026

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

### v0.2.1 (21 October 2026)

[v0.2.1](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.1) is an
experimental GitHub prerelease of merge commit
`1d54538c56179387b7541924e068d0d9c41d18e6` (PR 9), with an annotated `v0.2.1`
tag, published by owner decision with Item 5, P06 and Safari 17.6 RED and open.
[Main CI run 39601445318](https://github.com/forgesworn/relayswarm/actions/runs/39601445318)
passed all nine required jobs on that commit (soak skipped); attempt 2 reran
only the hls.js playback job after the account-budget TURN renewal browser case
timed out in attempt 1. The merged tree is identical to PR head `55c0f68`, which
passed [run 39589990218](https://github.com/forgesworn/relayswarm/actions/runs/39589990218)
on attempt 2 after one wall-clock-bound unit test failed on the macOS runner.
Fresh consumption of the merge commit passed with 287 package members. Assets
were built from a clean `git archive` of the commit after `npm ci`, with the
v0.2.0 commands; the same bundle command rebuilds the published v0.2.0 bundle
byte for byte.

| Asset | SHA-256 |
|---|---|
| `relayswarm-0.2.1.tgz` (287 files, 1,420,583 bytes) | `9f67a5f3ea8f5dffdf2e574d33703dfe952e01069a57635ae8349dd6d85455cb` |
| `relayswarm-hls-swarm-0.2.1.mjs` (148,439 bytes) | `358a026a563d645498faa1461d76ad44e64ae9cfe3d8de234c25c6e78025cda2` |

After publication, all three assets were downloaded from their public URLs into
an empty directory and passed `shasum -a 256 -c SHA256SUMS`. Installing the
tarball by URL into a clean production consumer imported the package; the
downloaded tarball imported all ten public export paths; and the bundle loaded
in headless Chrome 155 with `createHlsSwarm` exported and no page errors. These
are distribution checks on macOS arm64 and close no field gate.

The merge commit was then deployed to the pilot through the guarded cycle, with
`140c256` as the predecessor and its positive P07 as the incoming handover, and
passed its independent deployment review. The pilot app is `ce410033`, started
14:56:56 UTC. Normal HTTPS attestation matched the 787,462-byte client and read
two fresh rendition playlists, and the deployment's verification source was
removed. Reporting and forwarding remain off. The runtime of `1d54538` differs
from `140c256` only in the package version fields. After deployment, P06 at
6 MB (RED), R67 (stopped at controller binding on a harness pin) and R68 (RED,
15 of 16 gates) ran on `1d54538`; see the
[current delivery checkpoint](#current-delivery-checkpoint). The v0.2.0 record
below is unchanged.

### v0.2.0 (21 October 2026)

[v0.2.0](https://github.com/forgesworn/relayswarm/releases/tag/v0.2.0) is an
experimental GitHub prerelease of merge commit
`bf4394031809abb37b6a534d6be86aae3a3c556b` (PR 8), with an annotated `v0.2.0`
tag. [Main CI run 39514327948](https://github.com/forgesworn/relayswarm/actions/runs/39514327948)
passed all nine required jobs on that commit (soak skipped). The merged tree is
identical to PR head `fd046f5`, which passed
[run 39512633566](https://github.com/forgesworn/relayswarm/actions/runs/39512633566).
Assets were built from a clean `git archive` of the commit after `npm ci`:
`npm pack`, and esbuild 0.28.2 with `src/browser/hls-swarm.mjs --bundle
--format=esm --platform=browser --minify --legal-comments=inline`. The same
command rebuilds v0.1.0's bundle byte for byte from its tag.

| Asset | SHA-256 |
|---|---|
| `relayswarm-0.2.0.tgz` (286 files, 1,394,299 bytes) | `221324ea5e6cb8f9a56ee67c8dc60f9bd91c3ee0f302b7901b93eef046c214b7` |
| `relayswarm-hls-swarm-0.2.0.mjs` (145,696 bytes) | `376cf5296b298a41e00de85f460ea9141200794036863c979ee7fabe81c06d13` |

After publication, all three assets were downloaded from their public URLs into
an empty directory and passed `shasum -a 256 -c SHA256SUMS`. Installing the
tarball by URL into a clean production consumer imported the package; the built
tarball imported all ten public export paths; and the bundle loaded in headless
Chrome 155 with `createHlsSwarm` exported and no page errors. These are
distribution checks on macOS arm64 and close no field gate. The public pilot
still runs `5f2ece0`; the release's later loader clock-skew diagnostics are not
deployed.

### v0.1.0

This subsection records v0.1.0's release checks.

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

**v0.2.0** includes the additions below. These changes are absent from
v0.1.0's immutable release assets. Release and merged source do not establish
production readiness.

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
