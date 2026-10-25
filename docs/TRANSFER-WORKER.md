# Dedicated transfer worker

This unreleased experimental opt-in moves schema-3 piece verification and
transfer scheduling into one dedicated worker per swarm, for mixed and
explicit peer-only transfers. Both execution paths
share the same small transfer facade and compiled Rust module. Piece hashes,
the whole-object hash, planner, probe caps and returned commands remain Rust's
decisions; there is no additional JavaScript verifier.

## Host integration and packaging

Bundle the companion entry from the same SDK revision as the main adapter and
reviewed WASM module. From this repository, using its installed dependencies:

```sh
npx --no-install esbuild src/browser/core-transfer-worker-runtime.mjs --bundle --platform=browser --format=esm --outfile=public/relayswarm-transfer-worker.mjs
```

Serve that generated file and configure its URL explicitly:

```js
const swarm = createHlsSwarm({
  ...approvedStreamOptions,
  mode: "peer-first",
  coreWasm: "/vendor/relayswarm-core.wasm",
  multiHolder: true,
  transferWorkerUrl: "/relayswarm-transfer-worker.mjs",
});
swarm.attach(hls);
```

`transferWorkerUrl` requires peer-first mode, `coreWasm` and `multiHolder`.
The host's normal explicit peer/upload consent still applies. A relative
`import.meta.url` inside a bundled main library does not guess an adjacent
asset. Existing browser worker/module capabilities and the host's content
policy must permit the supplied URL; refusal goes to HTTP. Installed-package
bundlers can resolve the entry as `relayswarm/transfer-worker`, for example
from a companion entry containing `import "relayswarm/transfer-worker"`.
The SDK release build emits `relayswarm-transfer-worker-VERSION.mjs` with
metadata and a checksum alongside the browser bundle. Existing
immutable release downloads do not contain this unreleased feature.

`loadCore(...)` exposes its already compiled `module`, a
`WebAssembly.Module`. The swarm warms the worker asynchronously from that
module, without a second WASM fetch or holding session/player startup. While
the worker is warming or after a worker failure, configured peer-first loads
use ordinary HTTP before any metadata or coordinated wait. They do not quietly
retry a large Rust transfer on the main thread. The synchronous/native transfer
API and unconfigured swarms retain their existing path. Once the worker is
ready, schemas 1/2 retain their existing path too.

The companion imports only the shared transfer facade. It receives a cloned
compiled module, numeric scheduler inputs, commitment digests and media bytes.
Native peer connections and signalling keys remain in the main host. It
performs no media fetch, creates no peer connection and selects no player.

## Bounds, cancellation and observations

The default bridge permits two active objects, 16 MiB per object, 32 MiB of
active object sizes, 32 pending calls and 32 MiB of pending media payload.
The loader respects its configured segment limit up to the bridge's 32 MiB
per-object maximum. Initialisation and every call have a five-second safety
deadline; the existing HLS peer floor and absolute origin backstop remain in
force independently. Queue or handle exhaustion sends that load to HTTP.
There is no automatic worker retry or unbounded queue.

Media input is copied into an owned transferable buffer so the caller retains
its original bytes for caching, accounting and tracing. Verified output is
transferred back. This moves CPU work and retains an input-copy cost; it does
not prove lower total CPU time or network use.

Per-transfer free/cancel immediately fences its replies, rejects pending
calls and queues Rust handle cleanup; other active transfers continue.
Acknowledgements or operation deadlines still own that queued work, because
only terminating the worker can interrupt a synchronous WASM call. Swarm
stop, worker failure, malformed results or a genuine operation deadline
terminate the worker and reject pending work. The normal pending HTTP arm of
a cached-peer race remains owned by its loader.

The loader keeps generation/abort guards and complete-object acceptance.
An explicit clock check fences worker replies at the absolute backstop even
when its timer has not run; the mixed path retains its origin reserve.
Late worker replies cannot credit peer bytes or call the player. Only
first-verified-copy contributions in an accepted complete object reach
`onPeerDelivery`. `metrics().core.transferWorker` reports state/reason and,
once available, active objects, pending calls and pending media bytes. It
contains no native connection references.

The low-level [`createCoreTransferWorker`](../src/browser/core-transfer-worker.mjs)
bridge also accepts a compiled `module` and explicit `workerUrl`, with bounded
limits, a lifecycle `signal` and `onFailure`. Its `transfer(config, { signal })`
returns asynchronous `start`, `progress`, `delivered`, `failed` and `tick`
methods with the synchronous core's arguments and frames. `free`/`cancel`
release one handle; `stop` terminates the worker. `WorkerImpl` on the HLS
options is a constructor injection point for tests or an equivalent host
worker transport.

## Explicit peer-only cached race

When no safe serial wait remains, `zeroBudgetPeerRace` starts one normal
whole-object HTTP request immediately. The competing Rust transfer is created
with `peerOnly: true`: there is no origin lane, origin estimate or ignored
origin command inside it. Fast whole-HTTP history cannot strand ranges behind
work that performs no I/O. Candidate identity stays inside the initial cached
snapshot and current HAVE by default.

Cold holders receive bounded one-piece calibration. Remaining unverified,
uncovered pieces stay pending until verified progress refills bounded peer
requests. Failed or corrupt holders return only unfinished work to that pool.
No speculative serial-recovery abandonment kills this already-parallel arm;
the real HTTP winner, peer floor and host cancellation own its lifetime.
At the floor, Rust cancels peers and fails this transfer while normal HTTP
continues. Piece and whole-object hashes, request size, holder, worker queue
and upload allowance bounds remain in force. Normal mixed transfers retain
their origin lane and existing abandonment rules.

The optional capability mask is `2` (alongside bounded-probe mask `1`).
Low-level callers request `peerOnly: true` in transfer creation, then supply
`origin: null` at start. Existing constructor/C/native signatures remain
compatible. A synchronous core without the capability declines before
allocation; a worker declines that handle without retiring healthy mixed
transfers. HLS retains its already-running HTTP arm. No synthetic origin
latency is substituted.

Ranged requests are charged by their actual bounded size under unchanged
rate and session limits. Unlike a whole-object upload, an entire large media
object need not fit one two-second rate bucket. The temporary whole-object
fallback was hash-safe but lost the same-M4 native first-load comparison;
that failed control is retained. New mode qualification still requires the
unchanged native three-load win/HTTP-win/win assertion and physical playback
evidence; the capability alone is not a performance guarantee.

### Optional late HAVE

With `zeroBudgetPeerRace` and the separate experimental `lateHaveRace: true`,
an already-running whole HTTP load can race an object advertised later on a
connection accepted at load entry. This uses the existing key-filtered HAVE
notifications. FETCH is not cached data; no neighbour search or new connection
is admitted. The first actual matching holder snapshot is frozen once, and
failure or corruption does not start a second arm.

Key hashing, HAVE observation, commitment verification and peer delivery all
consume the same original `maxPeerWaitMs` window. HTTP never waits and no
origin range is created. Its success or exposed progressive chunk cancels
the observation and worker handle; swarm stop preserves pending normal HTTP,
while loader abort or destroy cancels both arms. Upload and worker bounds
remain unchanged. The zero-budget `have-after-wait` diagnostic marks a real
later HAVE, not deferred HTTP. A peer winner can still leave partial HTTP
traffic; the host must measure that traffic before claiming network savings.

## Focused verification

```sh
node --test test/core-transfer-worker.test.mjs test/core-transfer.test.mjs
node --test --test-name-pattern='transfer worker:' test/browser-hardening.test.mjs
node --test --test-name-pattern='^late-HAVE race' test/browser-hardening-core.mjs
```

The bridge fixture uses a real Node worker thread with the committed WASM,
comparing every six-MiB mixed/corrupt transfer frame and final bytes against
the synchronous core. It covers independent cleanup, limits, stale replies,
deadlines, worker errors and stop. Loader checks cover a six-MiB verified
contribution with exact observations, HTTP during held initialisation with a
real FETCH/no HAVE, delayed replies within and past the origin reserve,
ordinary HTTP surviving peer shutdown, and genuine worker failure with no
peer credit or synchronous retry. These
are protocol/lifecycle checks; physical HLS continuity and net network benefit
remain separate acceptance gates.
