# Dedicated transfer worker

This unreleased experimental opt-in moves schema-3 piece verification and
transfer scheduling into one dedicated worker per swarm. Both execution paths
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
the worker is warming or after a worker failure, configured schema-3 loads
use ordinary HTTP. They do not quietly retry a large Rust transfer on the
main thread. The synchronous/native transfer API and unconfigured swarms
retain their existing path; schemas 1/2 retain their existing behaviour.

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

## Focused verification

```sh
node --test test/core-transfer-worker.test.mjs test/core-transfer.test.mjs
node --test --test-name-pattern='transfer worker:' test/browser-hardening.test.mjs
```

The bridge fixture uses a real Node worker thread with the committed WASM,
comparing every six-MiB mixed/corrupt transfer frame and final bytes against
the synchronous core. It covers independent cleanup, limits, stale replies,
deadlines, worker errors and stop. Loader checks cover a six-MiB verified
contribution with exact observations, HTTP during held worker initialisation,
and genuine worker failure with no peer credit or synchronous retry. These
are protocol/lifecycle checks; physical HLS continuity and net network benefit
remain separate acceptance gates.
