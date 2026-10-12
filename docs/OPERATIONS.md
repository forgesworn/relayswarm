# Pilot operator controls

[Documentation](README.md) · [Broadcaster](BROADCASTING.md) · [Container deployment](../deploy/README.md) · [API](API.md) · [Evidence](STATUS.md)

These controls are included in the **experimental v0.2.0 release** and are absent from the immutable v0.1.0 assets. They support a bounded pilot; they do not establish production readiness or a hosted admission service. Public playback evidence and its limits are recorded in [Status](STATUS.md).

Before the first broadcast is ready, the root returns an HTTP 200 waiting page with a three-second refresh. Other endpoints return HTTP 503 with `Retry-After: 3`, including the authenticated status route; the waiting listener exposes no session, relay or operator API. The launcher replaces it with the player on the same port when both renditions publish. Waiting-page reachability does not establish fresh media, successful decoding or a verified public deployment.

## Credentials and HTTP routes

The broadcaster creates its private `operator-token` in `--state-dir`. The demo can instead take `--operator-token-file FILE`, the `RELAYSWARM_OPERATOR_TOKEN` environment variable, or the `startDemoServer` JavaScript option `operatorToken`. Prefer a private file; supplying both JavaScript token sources is rejected. Tokens must contain 32–256 non-whitespace characters. Token files require an owner-controlled canonical parent, a 0600 regular single-link file and matching ownership; symlinks and unsafe permissions are rejected.

The token is never in the player page, `/session.json`, public policy or operator status. Keep it separate from publisher signing secrets and forwarding credentials. The [deployment guide](../deploy/README.md#operator-access-and-private-identity) shows private header-file extraction and curl commands without printing the token or placing it in arguments.

| Route | Method/authentication | Result |
|---|---|---|
| `/operator/status` | GET, `Authorization: Bearer TOKEN` | Policy, origin HTTP counters, publisher work/cache metrics, report aggregate and optional redacted broadcast worker/publication status |
| `/operator/policy` | POST, bearer token, `application/json` | Accepts only `{"mode":null}`, `{"mode":"off"}`, `{"mode":"shadow"}` or `{"mode":"peer-first"}`; returns incremented policy revision |
| `/delivery-policy.json` | GET, public | Mode, revision and reporting availability; no token or publisher secret |
| `/reports` | POST, explicit server enablement and same-origin browser request | Accepts only bounded numeric measurement fields |

Unconfigured operator controls return 503; absent/incorrect credentials return 401. Cross-site Origin/Fetch-Metadata requests are rejected. Operator bodies are capped at 2,048 bytes and reject unknown fields/invalid modes; wrong methods and content types are rejected. Authentication is not a replacement for HTTPS, host protection or restricting administrative exposure at the reverse proxy. The bearer token grants policy/status access, not media-source credentials or shell access.

## Policy and viewer consent

`mode: null` leaves mode choice to the viewer. `off` requests origin-only playback. `shadow` or `peer-first` selects behaviour **only after the viewer has chosen a peer mode**: viewer origin-only selection and `Use origin only` always win. A policy can never opt the viewer into uploading. Valid publisher-signed redistribution authorisation is also required by the browser engine; operator policy is not an authorisation bypass.

The page polls policy and the publisher session every two seconds, with a single in-flight poll and five-second fetch budgets. Disablement is cooperative browser behaviour, not an immediate revocation of already delivered media or a claim that every client honours policy. On operator off or policy/session failure, it restores origin loading and clears the upload checkbox. Later enablement leaves uploading off until the viewer opts in again. Playback's video instance remains running; origin availability still determines whether playback can continue. Session identity changes on the same manifest trigger swarm rejoining without resetting page counters or reloading the playback instance. A changed manifest requires an appropriate host-page transition; this page fails to origin rather than guessing.

## Upload and measurement limits

The page offers 10 MB, 100 MB (default) or 1 GB of cumulative **media payload** allowance, plus a separate upload rate choice. Applying settings, using the kill switch or rejoining retains the page's consumed allowance. Each new swarm receives only the remaining budget. Accepted sends reserve their complete payload before transport; interrupted sends are not refunded. An oversized next segment is refused without consuming the smaller remaining allowance. Exact exhaustion stops serving and withdraws held availability, while receiving/playback can continue. Reloading the page starts a new page allowance; this is not an account-wide or device-wide cap. A viewer can deliberately raise the selected allowance.

The library option is `maxUploadBytesPerSession`; omission means unlimited and zero means no media uploads. Its metrics expose configured cap, remaining allowance and exhaustion. Host applications that recreate a swarm must carry their own cumulative allowance forward, as the page does. Rate limits use a token bucket with up to a two-second burst. Signalling, transport overhead, commitment fetches and shadow downloads are additional traffic; an upload media cap is not a wire-traffic limit.

Server `origin` counters separate `/media/` requests/body bytes from commitment requests/body bytes. Media counts include playlists, init segments, ranges and error responses; HEAD contributes no response body. Body bytes are bytes handed to HTTP responses, not confirmed physical-wire totals or network overhead. Browser resource timings have their own scope and exclude native-HLS requests. Verified peer payload records media accepted from peers; shadow mode adds peer traffic alongside origin loading. None of these counters alone establish net traffic/cost savings.

Publisher metrics include signing/hashing/cache activity, concurrent work and rejections. Broadcast metrics include worker states/restarts, rendition shape, generation and last publication time; they contain no input/output URLs or stream keys. A running process does not prove a fresh source, successful decoding or platform acceptance.

## Optional numeric reporting

Reporting is **off by default**. Enable it server-side using `--telemetry` or `startDemoServer({telemetry:true})`; each viewer must then check the separate reporting opt-in. The page sends cumulative numeric snapshots every fifteen seconds after playback starts. Downloadable field receipts remain separate and are not submitted.

Reports contain exactly `durationMs`, `peerBytes`, `uploadedBytes`, `originMediaRequests`, `originMediaBytes`, `stalls`, `stallMs` and `fatalErrors`, each a non-negative safe integer no greater than 10¹². Browser version, device/network labels, identities and peer IP addresses are not accepted. There is no third-party report endpoint. HTTP transport/proxy infrastructure necessarily sees request addresses; the report collector does not retain them as sample fields. Review any independent reverse-proxy access-log policy separately.

The collector permits 240 requests per ten seconds, caps each body at 2,048 bytes, requires the configured same-origin Origin and rejects cross-site Fetch Metadata. Default memory retention is at most 256 snapshots for five minutes. JavaScript options `reportCapacity` (1–4,096) and `reportTtlMs` (1,000–3,600,000) adjust those bounds. Expired entries are removed on collection/status; process restart clears memory. Reports are untrusted viewer-supplied observations. Repeated cumulative snapshots are **not deduplicated** and aggregate sums are not unique-viewer totals, additive bandwidth savings or billing evidence.

## Resources and admission boundary

The HTTP example caps active media responses at 32, connections at 128, header size at 8 KiB and request/header timeouts at ten seconds. Commitment requests have a separate 240-per-ten-second budget. Publisher defaults permit eight concurrent commitment operations and 512 entries in each hash/commitment cache; playlist/catalogue/segment bounds are documented in the [API](API.md). Cancellation releases media file handles and response slots even while lookup/opening is pending.

The [container package](../deploy/README.md) sets CPU, memory, process and log limits, loopback ingest/player mappings and private network boundaries. Its healthcheck requires a recent publication and publishing worker state; it becomes unhealthy without input or during a prolonged source outage. Compose restart policies recover container exits, not unhealthy status alone. Measure actual host capacity before broadening a pilot.

Browser peer caps and optional admission callbacks do not themselves provide a deployed ticket issuer or Sybil resistance. The demo has no integrated admission service. Fake signed presence floods and real-network participation remain separate acceptance gates; signatures establish key possession, not a unique human or trusted subscriber.

## Restart and recovery

Preserve the dedicated state directory/volume to retain publisher identity and operator credentials. Shut down normally so workers, file handles and the exclusive `.broadcast-lock` are released. Do not run two pipelines against one media directory, mount the state into unrelated services, or delete private state during an upgrade.

After an unclean exit, a retained lock deliberately prevents a new writer. Stop this stack, inspect every possible process/container/mount using its volume, establish that no broadcaster still uses it, keep a private consistent backup, then remove only the stale lock. A namespace-local PID is insufficient evidence. If exclusive ownership cannot be established, leave the lock in place. The [deployment guide](../deploy/README.md#exclusive-volume-ownership-and-crash-recovery) gives the container recovery boundary and rollback procedure.

Publisher state contains the signing secret; a whole-volume backup can also contain generated media. Use access-controlled encrypted backups. Forwarding credentials live in a separate private file and are read at launch; trusted process administrators can inspect ffmpeg's full URL arguments. Never put these secrets in a browser receipt, repository, public status response or issue attachment.
