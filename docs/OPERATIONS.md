# Pilot operator controls

[Documentation](README.md) · [Broadcaster](BROADCASTING.md) · [Container deployment](../deploy/README.md) · [API](API.md) · [Evidence](STATUS.md)

These controls belong to the **0.2.0 source candidate** and are absent from v0.1.0 assets. The candidate adds bounded admission, durable reporting and crash supervision; final production acceptance remains open. See [production features](PRODUCTION-FEATURES.md) and [Status](STATUS.md).

Before the first broadcast is ready, the root returns an HTTP 200 waiting page with a three-second refresh. Other endpoints return HTTP 503 with `Retry-After: 3`, including the authenticated status route; the waiting listener exposes no session, relay or operator API. The launcher replaces it with the player on the same port when both renditions publish. Waiting-page reachability does not establish fresh media, successful decoding or a verified public deployment.

## Credentials and HTTP routes

The broadcaster creates its private `operator-token` in `--state-dir`. The demo can instead take `--operator-token-file FILE`, the `RELAYSWARM_OPERATOR_TOKEN` environment variable, or the `startDemoServer` JavaScript option `operatorToken`. Prefer a private file; supplying both JavaScript token sources is rejected. Tokens must contain 32–256 non-whitespace characters. Token files require an owner-controlled canonical parent, a 0600 regular single-link file and matching ownership; symlinks and unsafe permissions are rejected.

The token is never in the player page, `/session.json`, public policy or operator status. Keep it separate from publisher signing secrets and forwarding credentials. The [deployment guide](../deploy/README.md#operator-access-and-private-identity) shows private header-file extraction and curl commands without printing the token or placing it in arguments.

| Route | Method/authentication | Result |
|---|---|---|
| `/operator/status` | GET, `Authorization: Bearer TOKEN` | Policy, origin HTTP counters, publisher work/cache metrics, report aggregate, bounded request diagnostics and optional redacted broadcast worker/publication status |
| `/operator/policy` | POST, bearer token, `application/json` | Accepts only `{"mode":null}`, `{"mode":"off"}`, `{"mode":"shadow"}` or `{"mode":"peer-first"}`; returns incremented policy revision |
| `/delivery-policy.json` | GET, public | Mode, revision and reporting availability; no token or publisher secret |
| `/reports` | POST, explicit server enablement and same-origin browser request | Accepts only bounded numeric measurement fields |
| `/operator/admission` | POST, bearer token | Revokes a key or rotates the ticket epoch |
| `/admission/challenge`, `/admission/ticket`, `/admission/verify` | POST, same-origin | Bounded key-possession challenge, short-lived ticket and live verification |

Unconfigured operator controls return 503; absent/incorrect credentials return 401. Cross-site Origin/Fetch-Metadata requests are rejected. Operator bodies are capped at 2,048 bytes and reject unknown fields/invalid modes; wrong methods and content types are rejected. Authentication is not a replacement for HTTPS, host protection or restricting administrative exposure at the reverse proxy. The bearer token grants policy/status access, not media-source credentials or shell access.

## Policy and viewer consent

`mode: null` leaves mode choice to the viewer. `off` requests origin-only playback. `shadow` or `peer-first` selects behaviour **only after the viewer has chosen a peer mode**: viewer origin-only selection and `Use origin only` always win. A policy can never opt the viewer into uploading. Valid publisher-signed redistribution authorisation is also required by the browser engine; operator policy is not an authorisation bypass.

The page polls policy and the publisher session every two seconds, with a single in-flight poll and five-second fetch budgets. Disablement is cooperative browser behaviour, not an immediate revocation of already delivered media or a claim that every client honours policy. On operator off or policy/session failure, it restores origin loading and clears the upload checkbox. Later enablement leaves uploading off until the viewer opts in again. Playback's video instance remains running; origin availability still determines whether playback can continue. Session identity changes on the same manifest trigger swarm rejoining without resetting page counters or reloading the playback instance. A changed manifest requires an appropriate host-page transition; this page fails to origin rather than guessing.

## Upload and measurement limits

The page offers 10 MB, 100 MB (default) or 1 GB of cumulative **media payload** allowance, plus a separate upload rate choice. Web Locks and origin storage reserve payloads atomically across settings, rejoining, reloads and tabs. Interrupted sends are not refunded; oversized next segments do not spend the smaller balance. Exhaustion stops contribution while playback continues. Storage failure disables uploading. Consent is requested anew after reload; the viewer can explicitly raise or reset the allowance. This local allowance covers one browser profile at the origin.

The current source also offers an optional [shared account allowance](ACCOUNT-UPLOAD-BUDGET.md), using explicit Nostr sign-in or the integrating website's authenticated account. Devices using one identity and ledger share cumulative reservations in addition to their local allowances. Account connection, linking, settings changes and resets leave uploading off until fresh viewer consent. Keep the private ledger through upgrades; disconnecting or reloading does not refund its charges. Neither allowance counts complete physical wire traffic. The deployed `2dd156e` checkpoint predates the account service.

The library option is `maxUploadBytesPerSession`; omission means unlimited and zero means no media uploads. Its metrics expose configured cap, remaining allowance and exhaustion. Host applications that recreate a swarm must carry their own cumulative allowance forward, as the page does. Rate limits use a token bucket with up to a two-second burst. Signalling, transport overhead, commitment fetches and shadow downloads are additional traffic; an upload media cap is not a wire-traffic limit.

Server `origin` counters separate `/media/` requests/body bytes from commitment requests/body bytes. Media counts include playlists, init segments, ranges and error responses; HEAD contributes no response body. Body bytes are bytes handed to HTTP responses, not confirmed physical-wire totals or network overhead. Browser resource timings have their own scope and exclude native-HLS requests. Verified peer payload records media accepted from peers; shadow mode adds peer traffic alongside origin loading. None of these counters alone establish net traffic/cost savings.

Publisher metrics include signing/hashing/cache activity, concurrent work and rejections. Broadcast metrics include worker states/restarts, rendition shape, generation and last publication time; they contain no input/output URLs or stream keys. A running process does not prove a fresh source, successful decoding or platform acceptance.

## Diagnosing control-path timeouts

The source candidate adds a numeric `Server-Timing: rs-app;dur=...` header to
session, policy, admission, report and commitment responses. It measures handler
entry to response headers. It excludes queueing before the handler, network
transport and response-body receipt. Media responses are not instrumented.

Authenticated status includes `requestDiagnostics`: seven fixed route labels,
128 active observations, a 30-second observation expiry and the latest 120
one-second windows. Histograms distinguish headers from terminal outcomes
(finished, cancelled or expired). A server finish means handing the response to
the HTTP stack, rather than confirmation that the browser received it. Event-loop
delay, scheduler drift and utilisation accompany each completed window. The
sampler is unreferenced and closes with the server. No request identities, IPs,
URLs, query strings, headers, bodies or credentials are stored in these aggregates.

Downloaded page receipts include `controlTimings`, with at most 64 numeric
observations and 64 pending observations, measuring headers and JSON-body time
separately. Application-header duration is included when available. Caller
signals, timeouts and single-request behaviour remain unchanged. These local
timings are not submitted as numeric reports and do not grant upload or reporting
consent. Durations above one minute are clipped and counted.

For matched probes, run the following **on the server hosting the loopback
endpoint**, using its configured public origin:

```sh
node scripts/probe-control-path.mjs \
  --public-origin https://trial.example \
  --loopback-origin http://127.0.0.1:8787 \
  --duration 60000 --interval 5000 --timeout 5000
```

The probe is bounded to five minutes, verifies public TLS, retains numeric
observations only and discards response bodies after a byte limit. Its fresh
HTTP/1.1 connections differ from browser HTTP/2. Pair these observations with
actual failure timestamps; the instrumentation cannot retroactively diagnose
an earlier incident or establish a network cause from a healthy later sample.

## Optional numeric reporting

Reporting is **off by default**. Enable it server-side using `--telemetry` or `startDemoServer({telemetry:true})`; each viewer must then check the separate reporting opt-in. The page sends cumulative numeric snapshots every fifteen seconds after playback starts. Downloadable field receipts remain separate and are not submitted.

Reports use `{v:1, reportId, sequence, values}`. The temporary page ID is 32 hex characters; sequence increases for new cumulative snapshots. Values contain exactly `durationMs`, `peerBytes`, `uploadedBytes`, `originMediaRequests`, `originMediaBytes`, `stalls`, `stallMs` and `fatalErrors`, non-negative safe integers up to 10¹². No account, browser version, device/network labels or peer IP addresses are accepted. Infrastructure still sees connection addresses; there is no third-party report endpoint.

The collector permits 240 requests per ten seconds, caps bodies at 2,048 bytes and requires same-origin requests. Retention defaults to 256 page IDs for five minutes; `reportCapacity` and `reportTtlMs` bound it. With `operatorState` (CLI `--operator-state`) enabled, private state survives restart and expiry is applied after reopening. Retries are idempotent, stale sequences do not add traffic again, and decreased counters are refused. The pending durable write queue defaults to 64; overload returns 503. Reports remain untrusted observations, not unique-viewer totals or billing evidence. Broadcasters enable private operational persistence automatically.

## Resources and admission boundary

The HTTP example caps active media responses at 32, connections at 128, header size at 8 KiB and request/header timeouts at ten seconds. Commitment requests have a separate 240-per-ten-second budget. Publisher defaults permit eight concurrent commitment operations and 512 entries in each hash/commitment cache; playlist/catalogue/segment bounds are documented in the [API](API.md). Cancellation releases media file handles and response slots even while lookup/opening is pending.

The [container package](../deploy/README.md) sets CPU, memory, process and log limits, loopback ingest/player mappings and private network boundaries. Its healthcheck requires a recent publication and publishing worker state; it becomes unhealthy without input or during a prolonged source outage. Compose restart policies recover container exits, not unhealthy status alone. Measure actual host capacity before broadening a pilot.

The candidate demo supplies a bounded ticket issuer and live revocation checks. The embedded relay rejects unadmitted presence/signals and caps aggregate messages. Open issuance establishes bounded keys, not unique people or paid subscriptions; broader Sybil and real-network acceptance remain separate gates.

## Restart and recovery

Preserve the dedicated state directory/volume to retain publisher identity and operator credentials. Shut down normally so workers, file handles and the exclusive `.broadcast-lock` are released. Do not run two pipelines against one media directory, mount the state into unrelated services, or delete private state during an upgrade.

On supported local POSIX storage, permanent publication/worker lease inodes and a guardian permit automatic parent-crash recovery after all worker groups are reaped. A dirty guardian marker or legacy pre-lease lock requires explicit operator inspection. Never delete lease database files to force acquisition. A namespace-local PID is insufficient evidence; retain private backups and leave uncertain ownership closed. The [deployment guide](../deploy/README.md#exclusive-volume-ownership-and-crash-recovery) describes the recovery boundary.

Publisher state contains the signing secret; a whole-volume backup can also contain generated media. Use access-controlled encrypted backups. Forwarding credentials live in a separate private file and are read at launch; trusted process administrators can inspect ffmpeg's full URL arguments. Never put these secrets in a browser receipt, repository, public status response or issue attachment.
