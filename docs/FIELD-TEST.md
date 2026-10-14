# Publisher/player field test

[Documentation](README.md) · [Installation](GETTING-STARTED.md) ·
[Publisher API](API.md#node-hls-publisher) · [Release evidence](STATUS.md)

The demo is a runnable publisher and an hls.js player with origin-only,
shadow and authenticated peer-first modes. Uploading starts **off**. Receipts
are downloaded locally. Reporting is disabled by default; v0.2.0
can offer explicitly opted-in numeric reports and authenticated
operator controls. See [operations](OPERATIONS.md). The publisher's signing
key stays on the server. v0.1.0 release assets retain their original behaviour.

## Run locally

From the [current source candidate](GETTING-STARTED.md#run-the-source-demo) or a
current main checkout:

```bash
npm ci
npm run demo
```

Open `http://localhost:8787`. Without a media directory, ffmpeg generates
two live H.264/AAC renditions (240p/350 kbps and 360p/1 Mbps video, each with
64 kbps audio and 2 s segments). Requires ffmpeg with libx264 and Node 22+.
Open several browsers, enable uploading on at least one willing participant,
then compare origin-only, shadow and peer-first on another. The demo starts
its own in-memory Nostr relay on `/relay`; it uses the engine's default STUN
unless `--stun` is supplied. It never asks for microphone or camera permission.

`Use origin only` stops the swarm and restores the original fragment loader
while the player continues. Applying settings also stops the previous swarm
before starting another. Uploading and cellular peer traffic require separate
opt-ins. The engine's upload token bucket permits a burst of up to two seconds
of the selected limit; it is not a strict per-second traffic shaper.
Hiding or leaving the page stops its swarm and clears upload and reporting
consent. Returning uses origin until settings are applied again; physical
background/resume playback remains a field gate.

If the host offers a shared account allowance, connecting it is a separate,
explicit action using a Nostr signer or the host's signed-in website account.
It adds the service's cumulative cap to this browser's allowance and leaves
uploading off until a fresh Apply. See [shared upload allowance](ACCOUNT-UPLOAD-BUDGET.md)
for linking, resetting, reconnecting after reload and the service's privacy
boundary. The deployed `8f482b4` pilot offers Nostr sign-in; its host website
account resolver is unconfigured.

The player checks operator policy and publisher identity every two seconds,
with at most three independent checks in flight. A stalled check cannot block
a newer successful check. A fully validated check permits peer delivery for
at most five seconds from its issuance, using both elapsed and wall time;
delayed responses cannot extend that period. Expiry clears upload and reporting
consent and restores origin delivery. A later successful check does not restore
those opt-ins. An operator's origin-only policy stops uploading immediately.
Local receipts retain failed control requests and bounded renewal observations;
these timings do not identify the cause of a network timeout.

## Publish your own media

```bash
npm run demo -- --media-dir /path/to/hls --manifest master.m3u8
```

Use a directory of media you are authorised to redistribute. The directory
is not exposed as a general file server: only the entry playlist, its supported
variant playlists, their media URIs and init maps are served. Symlinks cannot
leave the media directory. Signing requests must match the publisher's current
playlist context; a viewer cannot ask it to sign an arbitrary file or digest.

The Node-only helper is also exported as `relayswarm/hls-publisher`:

```js
import { createHlsPublisher } from 'relayswarm/hls-publisher';

const publisher = await createHlsPublisher({
  mediaDir: '/path/to/hls',
  manifest: 'master.m3u8',
  // secretKey: yourPublisherKey,  // optional; a fresh key is the default
});
const event = await publisher.commitment({
  path: '/media/low/shared.ts',
  level: 0, sequence: 12, discontinuity: 1,
  rangeStart: 188000, rangeEnd: 282000, // end is exclusive, as in hls.js
});
```

Omit both range fields for whole-segment media. The helper derives a fresh,
60 s commitment from the exact file bytes and its playlist records. It coalesces
concurrent catalogue reads and allows at most eight concurrent signing operations. It caps playlists at 256 KiB, variants at eight, fragments
at 4,096 per variant and signed segments at 16 MiB. hls.js level order is height
then bitrate within the supported single codec/frame-rate family.

The current publisher supports local full segments/ranges/discontinuities,
fMP4, alternate audio, mixed variants, complete parts and warm delta playlists.
AES-128 ciphertext requires explicit opt-in; keys and init maps stay on HTTP.
Remote/query assets, DRM/SAMPLE-AES, subtitles, I-frame variants and cold delta
reconstruction remain unsupported. See [production features](PRODUCTION-FEATURES.md)
for exact schema 2 contexts and the scope of actual Chrome media tests.

The example origin can hold complete live playlist reloads until the requested
sequence is published, using the [bounded HTTP contract](API.md#example-origin-http-playlists).
This changes HTTP playlist representations only; imported parts/deltas, ended
streams and mixed unsupported presentations receive no added capability.

Keys are ephemeral by default and in v0.1.0's CLI. Current source optionally
accepts `--publisher-state /private/path/publisher.json`; preserve this 0600
file in an owner-controlled directory for a stable identity across restarts.
Without it, restarting creates a new authorisation and swarm. Current viewers
poll session identity and rejoin while retaining the persistent browser allowance. The demo
does not establish trust in external publishers.

For live OBS ingest and optional independent RTMPS forwarding, use the
[broadcast launcher](BROADCASTING.md), which manages persistent
publisher state automatically. Existing media remains usable without ingest.

## Use separate devices and networks

Remote browsers need an HTTPS address trusted by the devices. Configure an
HTTPS reverse proxy to the loopback server, including WebSocket upgrades, then:

```bash
npm run demo -- --public-url https://trial.example
```

The public URL must be an HTTPS origin with no path or credentials. The demo
uses that explicit origin for session and relay URLs; it does not derive it
from an untrusted Host header. Your proxy must forward `/relay` with
WebSocket upgrade support. Alternatively supply `--tls-key FILE --tls-cert FILE`
and `--host 0.0.0.0` with a certificate trusted by all the devices. A plain HTTP
LAN address is insufficient for browser WebCrypto.

Optional `--relay wss://relay.example` (repeatable, at most eight) chooses external
relays instead of the embedded one. Optional `--stun stun:stun.example:3478`
(repeatable) overrides STUN. Alternatively, `--ice-config FILE` reads a private
STUN/TURN configuration. The same option is available to the broadcaster. The
file is a canonical, owner-controlled POSIX regular file, mode 0600, with one
link and at most 16 KiB; its parent must have no group/world writes or symlinks.
Supply only one of `--stun`, `--ice-config` or the optional renewal setting below.

```json
{
  "v": 1,
  "iceServers": [
    { "urls": "stun:stun.example:3478" },
    {
      "urls": "turns:turn.example:5349?transport=tcp",
      "username": "temporary-user",
      "credential": "temporary-browser-password"
    }
  ]
}
```

The configuration permits at most eight servers, four URLs per server and
512 characters per URL. TURN requires username/password strings of at most
256 characters; keep STUN in a separate entry without credentials. Use only
browser credentials, preferably short-lived: `/session.json` intentionally
discloses them to viewers. Never put a TURN server's shared signing secret in
this file. Restart the server and reload players when the configuration changes.
The CLI configures an existing host-provided service; it supplies no managed
TURN or super-peer deployment. A TCP TURN configuration needs its own actual
transport, capacity and privacy acceptance. An unreachable peer should leave
the viewer playing from origin.

### Optional TURN credential renewal

The demo and broadcaster accept
`--turn-credentials-url https://issuer.example/turn`. It is disabled by default
and uses an existing issuer; it does not deploy TURN. The fixed HTTPS URL must
have no credentials, query or fragment. Its JSON response must contain exactly
`urls` (one to four TURN URLs), `username`, `credential` and integer `ttl`
(5–3,600 seconds). The issuer must mint fresh browser credentials per request.
Its shared signing secret stays outside RelaySwarm.

The server exposes a separate same-origin POST endpoint. Explicit peer
Start/Apply obtains credentials; origin-only/native playback and two-second
session polls do not mint them. A three-hour HttpOnly, SameSite=Strict cookie
isolates each viewer's bounded cache; it is Secure on HTTPS and is not account
authentication. Bounds are 64 viewer caches, 64 active endpoint requests,
10 upstream tasks, a burst of 10 with one token restored per three seconds,
four seconds for upstream headers/body and 16 KiB per response. Excess work
is refused without evicting active viewer state.

The client refreshes at two thirds of the conservative credential lifetime,
with one request at a time and a five-second whole-request limit. New credential
material rebuilds peer connections while retaining valid consent, admission
identity and spent allowances. An identical cached reply keeps the original
lease and peers, does not increment the refresh counter, and uses a bounded
retry without extending expiry. Unexpired credentials can survive a failed
refresh; expiry, configuration changes or page suspension stop peer delivery.
Expiry clears uploading and requires fresh Apply. Returning credentials or
returning to the page cannot restore upload consent. Origin playback remains
available during peer reconnection. Receipts contain fixed lifecycle counters,
not credential values, cookies or issuer addresses.

Focused lifecycle, page-VM and owned HTTP tests pass. The preceding da9 source
also passed mock-issuer Chrome rollover locally and in CI. Fresh browser/CI
coverage of the cached-reply correction, Internet relay renewal and sustained
capacity remain acceptance gates.

The embedded relay is for a controlled trial: at most 64 connections, eight
subscriptions per connection, 24 KiB frames, 80 incoming messages per 10 s per
connection, 512 retained events for up to two minutes, and a 1 MiB outbound
queue limit. The HTTP server allows 32 concurrent media responses and 240
commitment requests per 10 s. These bounds do not turn it into a production
hosting service or a Sybil-resistant relay.

## Collect comparable receipts

1. Keep the source, selected quality, device and playback window the same.
2. Play origin-only for at least two minutes and download a baseline receipt.
3. Reload, choose shadow or peer-first, and keep at least one opted-in seeder
   ahead of the viewer. Use the same playback window and download its receipt.
4. Repeat on a different network, then with quality changes, seeks, a late
   joiner, one seeder leaving, and a brief relay outage.
5. Use origin-only during playback and confirm it continues; download the
   receipt so the previous session's stopped resource counts are retained.

Record your device and network labels before downloading. The labels are
viewer-supplied; they do not prove the network topology. A receipt includes
the browser version, startup time, stalls, seek recovery, fragment contexts,
resource timings and engine metrics. It records no peer addresses or private
signing key, but an ephemeral public key can correlate it with relay activity.
Nothing is submitted automatically.

`totals.peerFirstBytes` measures verified media delivered instead of starting
an origin fragment request. It excludes commitment traffic, signalling and
peer protocol overhead, so it is **not net connection data saved**. Shadow
results measure extra sampled transfers and cannot be labelled origin savings.
The upload allowance counter (`bytes.uploaded`) counts full media payloads
accepted for serving, including any transfer later interrupted. Pending or
refused reservations do not enter this counter; durable quota can retain charges
for media never handed to the transport. Neither counter measures acknowledged
bytes or total network data.
Use device/network measurements for actual data cost.
Resource timings count same-origin media requests, including init segments
and cache hits. Native-HLS browsers use origin-only playback and report origin
resource measurements as unavailable rather than zero.

Aggregate counts cover the whole page session. Detail is bounded to the last
256 fragments, 60 snapshots (five-minute window) and 64 mode sessions; older
session totals are retained. Stalls exclude user seeks, whose recovery is
recorded separately. Startup begins at the Start playback action.

## Automated coverage and remaining field gates

```bash
npm run test:publisher
npm run test:playback -- --resultsDir artifacts/playback
```

The playback test drives these same controls in real Chrome, using two VOD
renditions with 2 s shared-file ranges and a timestamp reset after 24 s.
It checks both renditions receive verified peer bytes, forward/backward seeks,
discontinuity delivery, range responses, retained hls.js statistics, receive-only
behaviour, relay reconnect, the kill switch and the downloaded receipt. It
compares playback stalls with an origin-only player. Forced quality switches
and returning to automatic selection are covered; optimal or broadly adaptive
ABR scheduling is not established. Loopback tests grant a fake microphone
permission to unlock interfaces; the demo itself does not.

GitHub CI runs this regression alongside both live harness modes. A manual
workflow dispatch with `soak=true` adds twelve viewer roles in three arrival
waves. `soak_duration` selects a 180 s or 7,200 s measurement window; the longer
choice includes repeated departures/rejoins and sampled resource bounds. Both
are loopback fixtures. The 13 October two-hour result and its instrumentation
limits are recorded below; they do not establish deployed or physical acceptance.
The v0.1.0 [completed soak](STATUS.md#release-verification) recorded zero
stalls/fatal errors and 68.7% peer-first fragment loads, with uneven per-viewer
benefits. Its recorded receipt does not establish separate-network performance.
The live peer-first fixture caps forward buffering at 4 s (maximum 6 s), keeps
its tampering seeder ahead in availability, and waits for an observed ban
before adding other peers. Its origin-only baseline uses the same buffer
settings. A playhead lead alone does not guarantee that a live-prefetching
viewer will ask the tampering seeder for bytes.
Presence remains swarm-wide; encrypted signals are subscribed to by recipient.
Clients also check the subscription's filter before verifying and dispatching
relay frames, so a relay cannot widen it into an all-audience signal feed.

| Gate | Evidence required |
|---|---|
| Desktop Chrome and Firefox on real networks | Current installed Firefox journey passes; paired matched network/cost receipts and broader coverage remain open |
| Physical Android and iPhone | Playback engine identified, consent respected, background/resume and metered-data behaviour |
| Home broadband vs mobile carrier | Selected candidate types plus paired receipts from separate networks |
| VPN or hard NAT | Playback continues from origin when direct peers cannot connect |
| Longer sessions and audiences | Loopback two-hour churn passes; deployed two-hour sustained-contribution gate red; attributable wire/cost measurements remain open |
| Independent-client protocol interoperability | Current public Swift SDK/browser journey passes; actual native application/input and wider physical integration remain open |

These field gates remain outstanding until their actual receipts are recorded.
No new physical-device or internet-network result is claimed by the automated
Chrome tests.

## Earlier completed fixture checkpoint: 07 on 14 October 2026

[Exact 07 CI 38616043417](https://github.com/forgesworn/relayswarm/actions/runs/38616043417)
passed all nine required jobs on attempt 1; optional soak was skipped. Its Linux
Chrome 155.0.8059.79 injected broadcast fixture passed four checkpoints with six
verified peer loads/3,125,876 bytes (low/high uploads 221,840/2,904,036).
All 239 numeric observation rows and four final extractions passed without
drops/unknowns/unlabelled objects. Each donor retained one stall; consumer and
baseline had none, and fatal/native/append failures were zero. The raw receipt
has no full actor/API or OS-reaping cleanup flags. This is automated headless
loopback coverage with declared RTC/fake-media settings, not physical acceptance.

Prior abb Windows RED and 426 media RED remain separate; no historical cause or
playback repair is established. Package/ESM proofs belong to 426, with no fresh
07 package proof yet. Deployed 8f is unchanged. Static credentials still limit
exact 07; that CI does not qualify the later optional renewal candidate.
The [07 summary](../spikes/results/07ea96b-ci-checkpoint-20261014.json) retains
these scopes; P01–P12, long/churn/physical/hard-NAT/cost and release gates stay open.

## Earlier controlled checks: 426 on 14 October 2026

The deployed pilot remains 8f. Later exact source 426 passed fresh offline
package/ESM and installed native/fallback checks, but
[CI 38607468217](https://github.com/forgesworn/relayswarm/actions/runs/38607468217)
finished eight required PASS/one media FAIL at the first low-quality peer gate.
A separate 33.759 s local injected diagnostic passed with six total peer loads/
3,107,076 bytes across both qualities; only the last high object was observed
post-restart, completing 366.123 ms before its recorded deadline. Its Mac Chrome
155.0.8059.41 differs from CI Linux 155.0.8059.79. Maintained queued/accepted HAVE
test observations add evidence; they do not repair playback or replace that RED.

One controlled test used an existing shared Internet TLS TURN service, two
headless pages, local synthetic HLS/Nostr, injected relay policy and trusted
Start/upload. In 90.005 s measured/105.150 s whole, the receiver recorded
34 complete verified peer fragments/3,956,272 bytes and the contributor recorded
4,175,104 uploaded bytes. Both pages reported positive selected TLS pairs in
67 of 91 samples. Each constructed two PCs; the final seven samples had no
active PC while video/time continued. Recorded stall/fatal/native projections
were zero, with missing-field zero defaults retained as a limitation. The
fixed low-quality control did not retain per-fragment level identifiers; this
is not both-rendition or continuous 90 s TLS evidence.

The CLIs read `--ice-config` once, session responses repeat the initial array,
and new peer connections use captured options. There is no supported ICE
refresh path. The observed 3,600 s issuer TTL leaves fresh allocations or
reconnections during a 7,200 s session unproved, without establishing that
already-created allocations die at credential expiry. The 90 s result does not
close that gap; an optional server-owned, expiry-aware refresh path remains
follow-up work with consent/admission/spend retained and origin fallback.

Client/group/scratch cleanup and separate issued private ICE file/directory
removal passed. The shared service, firewall and provider settings were not
changed. Its actual server quotas/allocation absence, physical devices, difficult
NAT, wider networks, sustained cohorts/churn and matched wire/cost remain
unproved. This result is separate from the earlier SSH-only simulation and Till
inventory. See the [sanitised checkpoint](../spikes/results/42608f7-source-and-tls-checkpoint-20261014.json).
Later exact-07 CI passed separately above; the full P01–P12/release gates remain open.

## Current field checkpoint: 8f on 14 October 2026

The deployed source is `8f482b4528a671acfe9f1afc336cce5743aaaefd`; all nine required
CI jobs, fresh local consumer/ESM checks and guarded deployment pass. See
[status](STATUS.md#current-deployed-checkpoint-8f-on-14-october-2026) and the
[8f summary](../spikes/results/8f482b4-current-checkpoint-20261014.json).

Ordinary cross-Mac playback passed over 60.119 s, but contribution and both-quality
peer delivery failed: no channel opened and verified peer bytes were zero. All
120 populated retained buffer geometries matched the existing calculation.
Original cleanup failed its 0.5 s process probe and strict M4 watcher command
comparison; later exact absence/removal and source cleanup are separate proofs.
A further prelaunch interpreter capture refused a remote timestamp 68 ms ahead;
no workload, clock change, timeout extension or repair is claimed by that result.

The earlier TURN test used an SSH tunnel and its temporary server was removed.
Fresh Till metadata confirmed no known running TURN service on that host; the
later existing shared-service TLS result is recorded separately above. Hard-NAT
and complete field acceptance remain open. Physical/Safari, same-topology 300 s,
7,200 s/22 churn, matched wire/cost and release/download gates also remain open.

## Previous field checkpoint: df51 on 14 October 2026

The deployed source is `df51cbed1ebb3bd09ef1b521c451d6b47989a664`, with all nine
required CI jobs and guarded pilot deployment passing. Both shared account
methods are implemented; the pilot offers Nostr, while a website supplies its
own authenticated resolver. See [status](STATUS.md#previous-deployed-checkpoint-df51-on-14-october-2026)
and the [df51 evidence summary](../spikes/results/df51cbe-current-checkpoint-20261014.json).

The ordinary 60.110 s four-role check passed playback but opened no peer channel
and received zero verified peer bytes. Positive 1,500 ms budgets and no matching
HAVE were observed; a scheduler/cache cause was not proved. A separate 60.027 s
heap/native-stats diagnostic retained in-progress UDP pairs with positive ICE
request counters and zero observed replies. Repeated observations are not unique
pairs or traffic deltas; eight completed latest snapshots remain unobserved.
This identifies a connection-check boundary, without establishing a network cause
or ordinary qualification. No phone, privacy or VPN setting was changed.

Original M4 controller cleanup remains unknown and watcher cleanup false in
both checks. The diagnostic's strict command comparison refused before TERM;
birth/PGID matched, but the replacement command was not captured. Later exact
process/group absence and stage removal are separate observations. M1 and both
source-cleanup-v2 proofs passed; the finite sources are removed. Complete device,
Safari, separate-network/hard-NAT, 300 s qualification, 7,200 s/22-churn, matched
wire/cost and immutable-release gates remain open.

## Previous field checkpoint: 2dd on 14 October 2026

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

### Previous f393 field checkpoint

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

### Earlier bb90 checkpoint

Source `bb90bd6a54cabc163846ee1737ac3fe28b63eaa2` was deployed after all nine
required jobs passed in
[CI run 38478501111](https://github.com/forgesworn/relayswarm/actions/runs/38478501111),
fresh local consumer/ESM gates, a 51-file non-root image preflight and guarded
app-only clean drain. Normal-TLS public client SHA-256 is
`25a8416911bc51b1f6764a784d4444295db02c12396c59ddd82450bf56fff58c`
(728,262 bytes). Identity, private leases and shared service/proxy configuration
were preserved; reporting stayed off.

Its ordinary four-role public Chrome check measured 60.010 s: requested video
and native-audio decode passed with zero fatal/native/page errors, while both
contributors uploaded zero and the receiver verified zero peer bytes. Each
contributor recorded one stall. Both native upload opt-ins were witnessed and
recorded rows stayed visible/focused. Withdrawal closely matched issuance plus
the five-second authority lifetime; later overlapping checks delayed about
three seconds before send and completed after expiry. Expiry is a supported
timing inference; no reason code or underlying cache/protocol/transport/host
cause was proved. A later admission-verification cancellation followed withdrawal.
Browser and provider cleanup passed, with finite-source cleanup verified
separately by Root. Decode does not prove audible output, and this short same-
desktop check does not close the sustained, physical, hard-NAT or cost gates.
Named evidence is retained under
`artifacts/public-cdp-bb90bd6-r3-analysis-20261014` and
`artifacts/public-cdp-bb90bd6-r3-run-20261013`; the public-safe analysis manifest
SHA-256 is `bd2d5ad098ca639f83398aff5a8b4b23994817b67a892d723193439fd439c926`.


A later ordinary-Chrome local real-HTTP comparison held the first policy
response before headers. The default client sent the later same-URL request to
the server after 5,002 ms and lost consent; a no-store treatment sent it after
2,001 ms and retained consent/serving, while both kept the five-second deadline.
No route interception, cache flags, fake media or permission overrides were used.
The final maintained
three-fetch correction passed real-server policy/session arrivals at 2,000/2,001 ms
while the previous response remained held, plus full-outage expiry and recovery
with consent off. Root's combined local suite/source hashes passed, and resource
closes completed without a separate kernel inventory. Later 2e1 field results
are recorded above; the initial public missing response remains unexplained and
the earlier bb90 contribution remains red. Final receipt:
`artifacts/policy-cache-integration-20261014/validation.json`.

The earlier verified pilot checkpoint used source `f9990b36956282f3d4e849b55bd64a79eb440151`,
client SHA-256 `b746f45216d3ac6e5d1bd21b5748f91c0115c71d00ee678c930070596bbef50d`
(723,954 bytes), with nine required jobs green in
[CI run 38449139246](https://github.com/forgesworn/relayswarm/actions/runs/38449139246).
A later proxy-only h1/h2 and `Alt-Svc: clear` configuration passed pinned-binary
validation and a guarded in-place reload, with fresh HTTP/1.1 and HTTP/2 checks
and unchanged application identity. It does not establish the cause of the
recorded policy timeout. The [f999 public field summary](../spikes/results/f999-public-field-summary-20261013.json) records the later measurements. These receipts describe past test windows, not a final release.
The [13 October acceptance summary](../spikes/results/current-source-acceptance-summary-20261013.json)
retains the earlier a023 load/churn and field results with their original identity.
Its named raw receipts remain local evidence; the summary excludes private
device identifiers, credentials and personal filesystem paths.

| Journey | Measured outcome | Remaining boundary |
|---|---|---|
| 0e ordinary public 60.013 s | Playback, contribution and both-quality verified peers green; 19 loads/6,285,968 bytes, recorded stalls/fatal/native/page errors zero; 369 completed controls HTTP 200/H1 | Four commitment aborts retained; programmatic dropdowns/trusted Start/upload; one-browser short scope; owned cleanup passed |
| f393 ordinary forward M1 donors → M4 receiver, 60.050 s | All three gates green; 28 verified loads/12,763,132 bytes across low/high; zero link closures, one superseded dial; no stalls/fatal/native/page errors or consent loss | 383 H1 controls: one cancelled commitment after HTTP 200, 382 finished; finite VPN observations only; all actor/source-v2 cleanup passed; [summary](../spikes/results/f393abf-ordinary-cross-machine-20261014.json) |
| f393 ordinary reverse M4 donors → M1 receiver, 60.023 s | All three gates green; 17 verified loads/8,179,316 bytes across low/high; two request-timeout closures then replacement connections, two initial post-SDP dial timeouts, two donor channel errors | 387 H1 responses: 386 finished, one post-200 admission verification terminal unknown; no stalls/fatal/native/page errors or consent loss; all cleanup passed; no underlying cause, fourteen-role or sustained claim |
| f393 distributed R4, fourteen total roles | All fourteen decoded; measurement stopped RED after 57.222 s on two verification failures without HTTP status; zero observed HTTP refusals/429s; resource limits held | Seven/eight positive contributor counters and two/four positive receivers in latest pre-failure rows; incomplete quality/renewal gates; all owned/source-v2 cleanup passed; [summary](../spikes/results/f393abf-distributed-qualification-20261014.json) |
| f393 distributed R5 diagnostic successor | Stopped RED after 19.404 s; seven status-unknown verification cancellations, zero HTTP refusals; first local fetch cancelled at 3,004.9 ms | Exact-code/lifecycle inference identifies the first three-second timer; missing-header cause and other abort sources remain unproved; resources and all owned/source-v2 cleanup passed; no long qualification |
| f393 distributed R6 passive network diagnostics | Stopped RED after 26.930 s; twelve status-unknown verification failures, zero HTTP refusals; all ten M4 roles also had a failed policy/session poll, including both origin-only baselines | No browser/queue/VPN/network/server cause established; later snapshot was already origin-only; all owned/source-v2 cleanup passed; 24 pending requests at observation shutdown have unknown terminal results |
| f393 distributed R7, two M4 Chrome profiles | Same fourteen roles and combined resource caps; stopped RED after 13.539 s with four unknown verifications confined to M4-B; both origin baselines retained late successful controls | No mitigation or shared-profile cause proved; three admission observations still pending; all three profile/actor/source-v2 cleanup passed; new topology does not qualify the existing long-run proposal |
| f393 desktop Safari 26.6.2 session creation | Creation timed out before application navigation; both HTTP workers reaped and owned driver exited; no session ID returned | Session allocation/deletion unknown; exact owned scratch removed after archival and guarded checks, shared Safari untouched, source cleanup passed; [summary](../spikes/results/f393abf-safari26-session-creation-20261014.json); no playback or physical-device result |
| f393 desktop Safari 17.6 startup | Session creation succeeded; startup stopped before mode selection or Start; zero media measurement | Individual failed readiness term unrecorded; separately reviewed M1 union limit 3 GiB/48 processes; exact-session and all actor/source cleanup passed; [summary](../spikes/results/f393abf-safari17-startup-20261014.json); no Safari media/input acceptance |
| 0e ordinary public renewal 180.015 s | All four gates green; 90 peer loads/39,608,780 bytes (45 low/9,488,548; 45 high/30,120,232); three peer actors retained sampled session/peer-set/link counters and consent through own-ticket renewal; 1,009 controls HTTP 200/H1 | One completed pre-measurement stall per contributor, none added during measurement; 89 unique segment contexts, one completed twice; passive equality is not PC-object identity; all owned cleanup/source-v2 audit passed; [summary](../spikes/results/0e68847-public-renewal-180-20261014.json) |
| 0e cross-machine public HLS 60.060 s | Playback/video/native-audio decode green, recorded stalls/fatal/native/page errors zero; contributors consented/serving but uploaded zero; receiver two timeouts/zero opened links/zero peer bytes | Sharing red; 323 controls ultimately HTTP 200/H1 does not prove every admission accepted; ICE/SDP phase and cause unproved; both-machine browser/provider/source cleanup passed |
| 0e public-origin raw RTC M1-offer → M4-answer | One verified 8,192-byte message each way in 7.972 s; exact deployed client loaded at both endpoints, complete gathering, each SDP one mDNS-form/one IPv4-form candidate; owned cleanup passed | Apps unstarted, no media/Nostr/admission/upload consent; VPN still connected/no settings changed; does not resolve cross-HLS red or prove a named cause |
| 0e public-origin raw RTC M4-offer → M1-answer | Separate reverse case passed in 7.566 s; one hash-matched 8,192-byte message each way, complete gathering, every actual SDP one mDNS-form/one IPv4-form candidate; all owned cleanup passed | Apps unstarted, no media/admission/upload consent; not the hosted HLS rendezvous/admission journey, does not close its sharing red or establish cause |
| 0e restored-VPN instrumented public HLS 60.074 s | Three gates green; 22 verified loads/10,151,436 bytes across both qualities, zero recorded stalls/errors/withdrawals | Whole-heap PC-state sampling; finite Connected observations; sequential pass does not establish heap or VPN causation; same-source ordinary red retained |
| 0e restored-VPN ordinary public HLS 60.020 s | Playback green; receiver four high-only verified loads/2,697,988 bytes, low zero; zero recorded stalls/fatal/native/page/freezes/withdrawals | Sharing red; high 4,038,428 accepted/reserved bytes/6 served/1 refused are not delivered wire bytes; one post-header commitment abort; all actors/provider/source-v2 cleanup passed |
| Same-M4 raw RTC owner VPN comparison | Disconnected: 6.517 s pass/8,192 verified bytes each way; restored Connected: 27.113 s red; complete gathering in both, error 701 also in pass | Owner changed/restored setting, fixture did not; literal loopback/no HLS/Nostr/admission; one case per state does not prove mechanism/sole cause or qualify public peers; owned cleanup passed |
| Raw RTC topology comparison | Literal loopback-origin cross-machine M1/M4 exchanged 8,192 verified bytes each way; same-M4 single/separate-process cases transferred zero despite complete gathering | Different topology/Chrome patch versions; no HLS/Nostr/admission or public-origin proof; error 701 also present in pass; no named network/browser/NAT cause; owned cleanup completed, including explicit historical scratch recovery |
| 2e1 ordinary public 60.013 s | Requested video/native-audio decode green; both contributor uploads and receiver peer bytes zero; fatal/native/page/stall counts zero | Sharing red; expiry timing retained, underlying transport cause unproved |
| 2e1 same-source HTTP/1 browser diagnostic versus default | Chrome 155.0.8059.41: 60.009 s diagnostic accepted 2,806,464 verified peer bytes across both qualities; fresh 60.015 s default check accepted zero | Browser `--disable-http2` diagnostic only; high's one stall retained; sequential same-source/default comparison; later ordinary server-H1 trial partial red; no sustained/physical/hard-NAT/cost proof |
| 2e1 temporary server-H1 ordinary 60.009 s | Consent/serving held; high delivered 10,082,816 verified bytes/15 loads, low zero; playback green, all 385 completed control responses HTTP/1.1 | Partial red for contribution/both-quality peers; high one stall retained; exact H1/H2 runtime/inode restored, watchdog absent/source removed; no permanent change |
| 2e1 r3 temporary server-H1 ordinary 60.010 s | All three gates green; 13,205,308 verified bytes/30 loads across low/high, consent/serving held, all stalls/errors/withdrawals zero | One-minute same-desktop trial, exact H1/H2 runtime restored; later permanent deployment remains separate evidence |
| EE permanent H1/app ordinary 60.014 s | All three short gates green; 13,188,200 verified bytes/30 loads across both qualities, consent/serving held, fatal/native/page errors zero; 405 completed controls HTTP/1.1 | High retained one 143 ms pre-measurement stall; programmatic dropdowns/trusted Start and upload; full owned cleanup; two-hour/physical/NAT/cost/publication remain open; [summary](../spikes/results/ee1510d-permanent-public-short-20261014.json) |
| EE fourteen-viewer local M4 qualification | Fresh 300 s plan stopped red after 98.945 s: admission 429s prevented ticket renewal while policy/session remained fast; RSS below declared 12 GiB cap | Same-address synthetic local workload with 22 accelerated churn cycles; not public peer or cost proof; earlier 8 GiB resource red retained, full owned cleanup |
| bb90 ordinary public 60.010 s | Requested video/native-audio decode green; contribution and verified peer red, both contributors uploaded zero/receiver peer zero, all fatal/native/page errors zero | Authority-expiry timing and delayed sends retained; underlying cause unproved; short desktop scope, historical reds remain |
| CI two-hour load/churn | Twelve honest roles, 22 replacements, zero retained stalls/fatal hls.js errors and clean resource stops | Loopback flags and host candidates; native media errors not separately instrumented |
| Deployed 7,205 s four-context run | Completed but red: policy timeout withdrew contribution before quota exhaustion; 34 zero-frame intervals and stalls retained | Same Mac/headless contexts; separate support audiences prevent controlled traffic attribution |
| f999 ordinary public 60.008 s | Requested video/audio qualities, both contributors and verified receive-only payload passed; 10,576,128 peer bytes, zero uploads/fatal/native errors/stalls | One same-laptop `host/host` browser process; short result does not close sustained/hard-NAT/cost gates |
| f999 attempted public two-hour rerun | Stopped after 644.855 s whole/611.134 s measured; high upload cleared during warmup following a five-second policy fetch cancellation; low receiver retained 60,508,176 peer bytes | No high receiver phase or 7,200 s completion; individual transport/proxy/browser cause unproved; historical reds retained |
| f999 public 60.120 s after proxy correction | Decode passed; contribution and peer payload at both qualities failed; receiver accepted 2,731,076 low peer bytes/13 loads; first high session timeout preceded measurement | Empty requested NetLog capture; underlying cause unproved, stalls retained, all owned actors/readers/source cleaned |
| TCP TURN over owned SSH forward | 224,096 signed media bytes/two segments verified in 5.036 s; browser and later explicit cleanup audit passed | Forced relay-policy data-channel/self-routing simulation, not direct Internet TURN, physical playback or hard-NAT proof; original controller red retained |
| Installed Firefox with ordinary contributors | Verified receive/upload, quality, seek, quota across reload, fresh consent and origin kill passed | One installed-browser journey; native-picker/human usability and hard NAT not proved |
| Visible Safari with ordinary contributors | Origin video played; five RTC links but zero peer payload inside gate | Complete verified receive/upload/reload/kill journey remains red |
| Physical Pixel/Vanadium | Later f999 actual origin frames, low/high quality, seek and background/resume passed; upload off and privacy unchanged | Peer unmeasured without a contributor in this check; original raw overall false plus default/temporary-policy reds retained; phone access closed |
| Physical iPhone/Safari | Owner observed moving origin video and audible tone | Owner background/Play return remained stopped; engine diagnosis, peer and complete input journey open |
| a023 host parent crash | Explicit audited dirty-marker recovery; same page progressed low/high at continuity 17, final 15 s frames and cleanup passed | One short origin-only observer, with stall and transient HTTP errors; no automatic clean-drain claim |
| Resource/network supplement | Exact owned-process/container and partial isolated HTTPS TCP counters retained | Missing windows, resets and other audiences; total wire and billed cost unproved |
| Deployed 219 reporting | Trusted reporting opt-in followed by a 17 s response timeout; reporting-off restoration and owned-source cleanup verified | No accepted-report/restart/retention checkpoint; original request lifecycle and later control state unavailable |
| Later sparse-AAC replay | Actual retained bytes reproduce a missing audio SourceBuffer; current one-shot repair resumed through another rendition in 603 ms | Constructed VOD differs from original failing live window; low-only recovery and original cause unproved |

The [investigation summary](../spikes/results/control-path-media-investigation-summary-20261013.json)
records those later observations and the local diagnostics-candidate tests.

Physical and separate-network tests require their own evidence for each control,
engine, contribution policy, background/resume and metered/battery behaviour.
Browser RTC links, SDK loopback interoperability, an origin video observation
and a passing local soak are separate claims. The complete P01–P12 requirements
remain in [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md); these observations
do not declare a release or close historical failed records.
