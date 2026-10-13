# Container pilot beside existing services

This package prepares a RelaySwarm broadcaster on an existing Docker host. It does not provision or change a Hetzner server. The app uses Node 24.21.0 and Debian ffmpeg; the private ingest router is MediaMTX 1.21.2. Both base images use verified multi-platform manifest digests; Debian package updates still depend on the current authenticated package index. Neither service binds host ports 80 or 443. Reuse an existing HTTPS reverse proxy and a dedicated hostname.

The app runs as uid/gid 1000, with a read-only image and a private named `/state` volume. Docker initialises that volume from the image's owner-controlled 0700 directory; the launcher creates 0600 publisher identity and operator token files. Keep this volume private and preserve it across upgrades. The app has 2 CPU/1536 MB limits; the router has 0.5 CPU/128 MB limits. These are starting limits, not throughput evidence. Measure encoding latency, memory and disk usage on the actual host before increasing load.

The image makes only copied public runtime code readable and its directories
traversable, removes group/other write and preserves existing executable files.
This also supports source contexts extracted with private filesystem modes.
Private state, credentials and configuration are outside that normalisation.
Before replacing a running app, check the built image as its non-root user,
including module imports and the actual entry point; an image label alone does
not prove usable installed code.

## Prepare and start

From the repository root, create the configuration and inspect it before starting:

```sh
cp deploy/.env.example deploy/.env
# Edit PUBLIC_URL; choose unused APP_PORT and INGEST_PORT if necessary.
docker compose --env-file deploy/.env -f deploy/compose.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yml build
```

Use a distinct Compose project name if deploying another instance. The default project is `relayswarm-pilot`. Set `APP_TAG` to a meaningful local release identifier, set `SOURCE_REVISION` to the source commit for the image provenance label, and retain the previous image for rollback. `RELAYS` accepts comma-separated `wss://` URLs without credentials; an empty value uses the app's built-in relay over the same HTTPS origin. `STUN_URL` is optional. This package does not configure a TURN service or prove cross-network connectivity. Reporting is off; no telemetry flag is added.

After checking existing host listeners and reverse-proxy configuration, the operator can start this stack:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml up -d
```

The root serves an HTTP 200 waiting page before ingest, checking again every three seconds. Other endpoints return HTTP 503 with `Retry-After: 3` until the source supplies both video and audio and both HLS renditions publish. The launcher then replaces the waiting listener with the player on the same port. Absent initial input does not require an initial proxy 502; a 502 indicates the listener/proxy is unavailable. The healthcheck also stays unready until a source publishes; after its initial two-minute grace it marks absent/stale media unhealthy. It checks authenticated publication status without logging credentials. Compose does not automatically restart a merely unhealthy container. The launcher waits rather than repeatedly restarting. Send H.264 video and AAC audio from OBS to `rtmp://127.0.0.1:1935/live`, with an empty stream key (use your configured host ingest port).

RTMP is mapped only to host loopback. RTSP has no host port mapping. The router and app share an internal `ingest` Docker network. The router also has a separate normal `ingress` bridge so Docker can publish its loopback RTMP mapping; only the router joins that bridge. The app has a separate `egress` bridge for Nostr relays and optional RTMPS forwarding. These normal bridges are private to this Compose project, not internal-network isolation guarantees; the router can also reach outbound networks. No RTSP port is published on the host. There is no public plaintext RTMP listener. For an external OBS workstation, use SSH forwarding:

```sh
ssh -N -L 1935:127.0.0.1:1935 deploy@your-host
```

OBS then targets its own `127.0.0.1:1935`. Choose another local port if already occupied. Authorised host users and containers attached to the private ingest network can publish; that is the ingress trust boundary. Do not attach unrelated containers to either router network. The router refuses a second publisher for the same live path.

## Existing HTTPS reverse proxy

Add the following location to the existing Nginx HTTPS virtual host for `PUBLIC_URL`. Preserve its existing certificate, listener and other site configuration. If using a different proxy, forward WebSocket upgrades for `/relay` and preserve the Host header.

```nginx
# In the existing http block, once:
map $http_upgrade $relayswarm_connection_upgrade {
    default upgrade;
    '' close;
}

# In the existing HTTPS server block for the dedicated hostname:
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $relayswarm_connection_upgrade;
    proxy_read_timeout 75s;
    proxy_buffering off;
}
```

Replace 8787 with `APP_PORT`. Validate the proxy's configuration using its normal procedure before reloading it. The configured public HTTPS origin must match browser Origin headers; the app does not derive trust from forwarded headers. A reverse proxy running in another container cannot reach the host's loopback mapping directly: connect it to the app network deliberately and proxy `app:8787`, or use the existing host proxy. Do not bind the app to a public host interface to work around that distinction.

## Optional standalone HTTPS on an unused host

If the chosen host has no HTTPS proxy, `compose.caddy.yml` supplies a separate Caddy service. It is disabled unless both that overlay and the `standalone-https` profile are explicitly selected. The base configuration never takes ports 80/443. Confirm the dedicated hostname and DNS first, check that those ports are unused, and authorise any firewall changes separately. The pinned Caddy image version/digest was read from its official registry manifest.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml \
  -f deploy/compose.caddy.yml --profile standalone-https config --quiet
# Only after hostname, DNS and free ports are confirmed:
docker compose --env-file deploy/.env -f deploy/compose.yml \
  -f deploy/compose.caddy.yml --profile standalone-https up -d
```

The overlay publishes TCP ports 80 and 443. The Caddyfile explicitly enables HTTP/1.1 and HTTP/2 and sends `Alt-Svc: clear` so clients invalidate previously advertised HTTP/3 alternatives. It does not publish a UDP listener. These settings follow [Caddy's server protocol options](https://caddyserver.com/docs/caddyfile/options#servers) and [RFC 7838's cache invalidation rule](https://www.rfc-editor.org/rfc/rfc7838#section-3).

Caddy obtains certificates for `PUBLIC_URL` and proxies WebSockets/media directly to the app on its outbound Docker network. Its named certificate volume contains private TLS keys. Preserve it privately across restarts; this does not replace an existing proxy. Use the same overlay/profile when stopping the stack so Caddy is included. To remove the optional proxy while preserving the broadcaster, stop/remove only the `https` service through that overlay; do not remove certificate volumes as part of routine rollback. Combining the Caddy and YouTube overlays is supported by including both `-f` arguments.

Before changing a running proxy, preserve its current Caddyfile privately and validate the candidate with the pinned Caddy version. Reload only the `https` service using `caddy reload`; a proxy configuration change does not require restarting the broadcaster. The Caddyfile is a file bind mount: preserve its inode when updating it, because replacing the host file by rename can leave the container reading the old inode. Verify the mounted bytes before reloading and retain the original bytes for a guarded rollback. Keep certificate volumes, app state and port mappings intact. See [Caddy's validation and reload commands](https://caddyserver.com/docs/command-line).

## Operator access and private identity

The operator token is created at `/state/operator-token` before ingest begins. To extract an authorisation header into a private local file without printing the token or putting it in process arguments:

```sh
umask 077
docker compose --env-file deploy/.env -f deploy/compose.yml exec -T app \
  node -e "process.stdout.write('Authorization: Bearer '+require('node:fs').readFileSync('/state/operator-token','utf8').trim()+'\\n')" \
  > operator-header
curl --fail --header @operator-header https://stream.example.org/operator/status
curl --fail --header @operator-header --header 'Content-Type: application/json' \
  --data '{"mode":"off"}' https://stream.example.org/operator/policy
rm operator-header
```

Use your actual HTTPS origin. `mode: off` requests origin-only delivery; viewer upload consent cannot be enabled remotely. Operator endpoints reject cross-site browser requests. Never commit the token, header file, publisher identity or volume backup. `/state/publisher.json` contains the signing secret: preserve it privately for stable authorisation across restarts. Rotating it changes the publisher identity. A whole-volume backup includes private identity and generated media; use encrypted, access-controlled storage and an application-stopped backup for consistency.

## Optional YouTube forwarding

Forwarding is a separate ffmpeg process and source reader. RTMPS input/forwarding requires a DNS hostname and FFmpeg major 5+ built with GnuTLS or major 8+ built with OpenSSL. The pipeline checks the selected executable with a five-second, 32 KiB preflight before media-state creation or worker spawning; direct argument-builder callers must enforce that prerequisite themselves. Supported inputs are RTSP, RTMP, RTMPS and SRT; RTSPS is rejected. The URL is supplied through a private read-only file, never an environment value. Platform acceptance and playback need a real authorised broadcast test.

Prepare an absolute host directory outside the repository, owned by uid/gid 1000 and mode 0700. Place one line containing the complete `rtmps://` ingestion URL in `youtube-url`, owned by uid/gid 1000 and mode 0600. Use a private editor; do not paste the URL into shell commands, logs or a Compose file. The directory must contain only this secret and must have no symlink components. Set `YOUTUBE_SECRET_DIR` in `deploy/.env` to that directory's absolute path. Root-owned Compose secret files fail the launcher's owner check, so the bind mount intentionally preserves the required ownership.

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml \
  -f deploy/compose.youtube.yml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yml \
  -f deploy/compose.youtube.yml up -d
```

The overlay contains only the pathname and mounts its directory read-only. To stop forwarding, recreate the app using only the base Compose file. Rotate the URL in the private file and recreate the app to pick up a new value. ffmpeg must receive the URL as a process argument; trusted host/container administrators can inspect it. The package suppresses upstream stderr and does not place the URL in operator status or browser sessions.

## Exclusive volume ownership and crash recovery

Run exactly one broadcaster against each local state volume. Current source uses permanent private publication and worker SQLite lease inodes plus a worker guardian. After parent termination, the guardian kills and reaps encoders/forwarders before releasing ownership, allowing a new parent to recover. Lease databases must never be removed or replaced. Distributed filesystems are refused; Node 22.13+ and supported local POSIX storage are required.

If the guardian or host fails, its durable dirty marker closes automatic recovery. A legacy pre-lease `.broadcast-lock` also requires inspection. Stop this stack and inspect every possible process, container and mount using the volume; establish that no broadcaster or forwarding descendant remains and retain a private backup. Remove only the explicitly stale ownership marker identified by the source/runbook, retaining permanent lease databases and publisher state. A namespace-local PID is insufficient proof. Restart and verify fresh publication, retained identity and completed worker cleanup; uncertain ownership remains closed.

## Stop, upgrade and rollback

Use `docker compose ... stop` to stop the two services without deleting state. `down` removes this project's containers/networks but preserves its named volume; **do not use `down -v`**. It destroys the retained publisher identity and operator token.

Before an upgrade, retain the previous tagged image and configuration, stop this stack and take a private consistent volume backup if changing storage behaviour. Rebuild under a new `APP_TAG`, then recreate only this stack. On failure, restore the previous `APP_TAG` and matching configuration and run `up -d --no-build`; reuse the same volume for a compatible rollback. If storage format compatibility is uncertain, stop and restore the private backup first. The proxy and other hosted services remain independent. Remove only this dedicated hostname's proxy route if abandoning the pilot.

Monitor `docker compose ... ps`, bounded service logs and authenticated operator status. HTTP media/commitment counts and verified peer payload measurements are separate; they do not establish net bandwidth savings. Restart policies recover container exits, while independent internal workers retry ingest/forwarding failures. This package does not prove remote OBS, a particular NAT path, YouTube playback, host capacity or production readiness.
