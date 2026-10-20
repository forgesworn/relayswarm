# Broadcaster source workflow

[Documentation](README.md) · [Operations](OPERATIONS.md) · [Container deployment](../deploy/README.md) · [Evidence](STATUS.md)

This guide describes the v0.2.0 broadcaster workflow, persistent publisher state and operator/reporting controls. Install [v0.2.0](GETTING-STARTED.md); the immutable v0.1.0 assets do not include these additions. Publication of a guide does not establish deployed playback or platform acceptance.

## Local source and dependencies

Use Node 24 and ffmpeg with libx264 and AAC. RTMPS input/forwarding additionally requires a DNS hostname and FFmpeg major version 5 or later built with GnuTLS, or major version 8 or later built with OpenSSL. Install the source dependencies and the pinned MediaMTX router:

```sh
npm ci
npm run broadcast:install
```

The installer downloads MediaMTX 1.21.2 for macOS/Linux x64 or arm64, checks the archive against a platform-specific pinned SHA-256 before extraction, and prints the executable path. Its owner-controlled cache is `artifacts/tools/mediamtx-v1.21.2`; a private receipt records the extracted binary digest. A cached receipt is trusted local state, not independent upstream attestation. On another platform supply your own compatible router executable.

Start the bundled local router and broadcaster from the repository root:

```sh
npm run broadcast -- \
  --mediamtx artifacts/tools/mediamtx-v1.21.2/mediamtx \
  --state-dir artifacts/broadcast
```

Configure OBS Custom streaming with server `rtmp://127.0.0.1:1935/live` and an empty stream key. Supply **both H.264 video and AAC audio**. The bundled router listens only on loopback, refuses a second publisher for `live`, and exposes its RTSP read path at `rtsp://127.0.0.1:8554/live`. The launcher reads that path over TCP. Without `--mediamtx`, run the router separately or provide `--input` for an existing supported network source. Supported input schemes are RTSP, RTMP, RTMPS and SRT. RTSPS is rejected because verified TLS behaviour is not portable across supported FFmpeg versions; scheme acceptance does not prove compatibility with every source.

The launcher first binds a waiting listener and prints its address, normally `http://localhost:8787`. The root page returns HTTP 200 and checks again every three seconds. Before both HLS renditions publish, other endpoints return bounded HTTP 503 responses with `Retry-After: 3`; there is no session, relay or operator API on the waiting listener. Once output is ready, the launcher replaces that listener with the player on the same port. A waiting page proves HTTP availability, not media playback. Stop with Ctrl-C for orderly listener, worker and router shutdown.

An external OBS workstation can use an authorised SSH tunnel rather than a public plaintext RTMP listener:

```sh
ssh -N -L 1935:127.0.0.1:1935 deploy@your-host
```

OBS then targets its own loopback address. The container router uses an internal app/router network plus a separate normal bridge needed for its loopback RTMP port publication; RTSP has no published host port. Container ingest mappings and the existing/new HTTPS proxy choices are in the [deployment guide](../deploy/README.md). Remote browsers require configured TLS or an explicit `--public-url https://your-hostname` behind an HTTPS proxy. The public origin must match browser Origin headers. Configure repeated `--relay wss://...` options if using external relays; otherwise the server supplies its own bounded relay at `/relay`. `--stun` accepts a STUN URL. Alternatively, `--ice-config FILE` loads private host-provided STUN/TURN browser credentials; the [field guide](FIELD-TEST.md#use-separate-devices-and-networks) gives the bounded format and disclosure boundary. No TURN deployment is supplied.

For an existing short-lived credential issuer, use
`--turn-credentials-url https://issuer.example/turn` instead of `--stun` or
`--ice-config`. The optional [renewal adapter](FIELD-TEST.md#optional-turn-credential-renewal)
is off by default. It obtains separate viewer credentials, refreshes active
peer sessions and retains consent and spent allowances. It supplies no TURN
deployment; expired credentials leave playback on origin until fresh Apply.

Admission defaults to 12 tickets per minute for each socket address. Viewers
behind a reverse proxy can share that address. Set
`--admission-per-address-tickets 32` when the operator intends that capacity;
accepted values are integers 1–120, default 12. The launcher validates the value
before creating state or starting services. This changes no global issuance,
request, expiry or consent limit, and does not trust forwarded-address headers.
Choosing a limit does not establish a passing multi-viewer qualification.

Admission also defaults to 600 requests per minute for each socket address,
shared by challenge, ticket and verification requests. Configure
`--admission-per-address-requests 900` only when the operator intends that
allowance; accepted values are integers 1–10,000, default 600. Validation runs
before state creation or service startup. Behind Caddy or another reverse proxy,
viewers can share one backend socket address; forwarded-address headers remain
untrusted. The global request limit remains 2,048 per minute, global ticket
issuance remains 120 per minute, and all other admission limits remain unchanged.
The pilot plans an explicit 900 after observing 637 startup admission requests
within a minute, allowing headroom over that observation. This setting has not
yet been deployed or qualified; configuring it does not prove field capacity or
resolve the separate delayed-response observations.

The broadcaster and demo accept `--ice-transport-policy all|relay`, default
`all`. Choose `relay` explicitly to restrict peer ICE to relayed candidates;
provide usable TURN configuration or the existing credential adapter. The
choice does not force TLS: by default the adapter preserves all validated issuer
URLs. It never falls back to `all`, changes the peer deadline or grants upload
consent. Playback keeps its existing origin fallback. A changed demo session
policy stops peers and requires fresh Apply and upload consent. This option
does not establish improved delivery, measured privacy or field acceptance.

With the optional credential issuer, `--turn-url-projection tls-tcp` selects
secure TCP configuration independently of the ICE candidate policy. Default
`issued` preserves the existing descriptor and issued URLs. The adapter retains
its original raw cache/lease, preserves explicit secure TCP URLs, and appends
`?transport=tcp` only where a valid `turns:` URI left transport unspecified.
It excludes plain TURN and explicit UDP; it changes no host, port, credentials,
issuer TTL or refresh boundary. The client enforces the projected response too.
No supported result means origin fallback, never unrestricted retry. Changing
selection stops peers and requires fresh Apply/upload consent. This is an
application-selected URI, not the unchanged issuer response or a capability
proof; see the [API contract and primary standards](API.md#optional-tls-over-tcp-url-projection).
No existing issuer/service configuration is changed by this option.

## Output and recovery

Add `--account-budget` to offer the optional shared upload allowance. It keeps
`account-budget.json` in the private state directory and supports explicit
Nostr sign-in. Website account authentication uses the JavaScript host callback,
not a viewer-supplied account identifier. The Compose template enables the
offer through `ACCOUNT_BUDGET_ENABLED=1`; viewers still choose whether to connect
an account and separately opt into uploading. Preserve the ledger and its
permanent lease files. See [shared upload allowance](ACCOUNT-UPLOAD-BUDGET.md).

The encoder produces two fixed H.264/AAC renditions:

| Rendition | Frame shape/rate | Target video rate | Audio |
|---|---|---|---|
| low | 640 × 360, 30 fps | 700 kbps | AAC, 128 kbps, 48 kHz stereo |
| high | 1280 × 720, 30 fps | 2,500 kbps | AAC, 128 kbps, 48 kHz stereo |

Scaling preserves aspect ratio and pads to the fixed frame shape. Each rendition uses a two-second segment target and a twelve-segment live playlist: approximately **24 seconds of listed media**, not a 120-second playlist. ffmpeg retains an additional deletion tail; prior process generations have a separate two-minute pruning grace by default. These durations are storage/publication policy, not a measured end-to-end latency guarantee. Both renditions belong to one supported codec/frame-rate family; this is a fixed ladder, not a general encoding service.

The HLS worker and optional forwarding worker retry independently, with bounded exponential delay. Each HLS process generation uses a distinct segment directory and a persisted discontinuity sequence. Variant/master publication uses atomic file replacement. Source loss leaves the last published playlists available while workers reconnect; old HTTP availability does not establish fresh media or successful decoder recovery. Inspect publication age in operator status.

Use a dedicated canonical state directory owned by the launching user, preferably mode **0700**, with no symlink components or group/world writes. New directories use 0700. The launcher keeps `publisher.json` and `operator-token` as owner-only **0600**, regular, single-link files. The publisher file contains a private signing key and its signed redistribution authorisation; neither secret is delivered in browser sessions or operator status. Existing malformed/mismatched publisher state is rejected rather than replaced. Restarting with the same state retains publisher identity, swarm ID and authorisation; starting with another state directory creates another identity.

Only one pipeline may use a media directory. `/state/media/.broadcast-lock` in the container, or `STATE_DIR/media/.broadcast-lock` natively, is acquired exclusively. Orderly close removes it. An unclean exit may leave it and the next start fails closed. Stop all possible users of that volume/directory and establish exclusive ownership before manual stale-lock removal; never infer safety from a PID in a different namespace or delete locks automatically. See [operations](OPERATIONS.md#restart-and-recovery).

## Optional RTMPS forwarding

Create a private, owner-controlled directory outside the checkout. In it, use a private editor to write one line containing the complete RTMPS ingest URL to a regular, single-link file owned by the launching user, mode **0600**. Keep the parent mode **0700** and use its canonical path. Start with:

```sh
npm run broadcast -- \
  --mediamtx artifacts/tools/mediamtx-v1.21.2/mediamtx \
  --state-dir artifacts/broadcast \
  --youtube-url-file /absolute/private/directory/youtube-url
```

The file supplies the URL without putting the stream key in environment variables or launcher arguments. For RTMPS input or forwarding, the pipeline first checks the selected executable’s version/build configuration with a five-second, 32 KiB output budget, before creating media state or workers. Direct callers of the argument builders must perform equivalent capability validation themselves. Forwarding has its own ffmpeg process and source reader, copies the H.264/AAC tracks into FLV, requires RTMPS, explicitly enables TLS certificate/hostname verification and sets a 15-second output I/O timeout. It does not transcode for a platform's separate compatibility rules. A forwarding outage cannot block the HLS process, although both still depend on the same source and host resources.

Trusted host/container administrators can inspect ffmpeg's process arguments, which contain the full ingest URL. The implementation consumes upstream stderr without publishing credentials in logs, metrics or browser sessions. Protect the host, secret file and process-inspection permissions accordingly. Restart the broadcaster to read a changed URL. A process marked running/connecting or repeated restarts is **not** evidence that YouTube accepted the stream or that viewers can play it; confirm that separately in an authorised platform test.

## Verification boundary

The source includes native process/publication tests and actual Chrome fixtures.
The dated [status](STATUS.md) retains the authorised OBS and private YouTube
tests; that YouTube broadcast was stopped and deleted. Current deployed `8f482b4`
playback passed its ordinary short check, while both-quality peer delivery and
the fourteen-role qualification remain red. Complete physical-device,
separate-network/hard-NAT, sustained-operation and final release acceptance
remain open. Earlier passes retain their original source and scope.

The broadcast browser fixture uses loopback Chrome, synthetic media and explicit
RTC/fake-media fixture flags. Its receipt adds bounded observations of existing
media request events: at most four pages, 512 shared object labels, 256 retained
rows and 64 tracked active requests per page. Labels correlate the same private
pathname/range within one run; they do not reveal paths, queries or parsed
playlist sequence/continuity. Fixed media/rendition categories and numeric cached
Playwright timings distinguish request start, response and completion. Unavailable
values remain null; evictions, overflow and pending requests remain explicit.
The unpopulated native epoch placeholder is null; zero remains valid for
relative timings.
Snapshots before and after browser close are separate observations. The recorder
adds no requests or body reads and changes no playback deadline or assertion.
It is diagnostic evidence, not ordinary network or physical-device qualification.
