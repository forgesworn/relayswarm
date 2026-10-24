# Hot-path performance review

[Documentation](README.md) · [Status](STATUS.md) · [Changelog](../CHANGELOG.md)

Measured 24 October 2026, comparing the v0.4.3 source
`6f63fb2f8ae20a51953c80853816311f25980bf0` with the changes listed below. The
loader and publisher rows were measured against the earlier
`ed845ceccca192320f5b40b004ad54b7ffb2417c`; v0.4.3 changes neither the
loader's copy and hash paths nor the publisher. The host was a 4-vCPU x86-64 Linux VM with
Node 22.22.0 and Rust 1.94.1. Every figure is an in-memory micro-benchmark:
no browser, network, relay, device or player is involved, and timer resolution
and shared-host noise move single runs by 10–30%. Ranges are medians from
repeated runs. Compare runs on one host before and after a change; do not
compare absolute numbers across machines.

`npm run bench:hot-paths` reproduces the link, verification, multi-holder and
native-receive rows. It does not measure playback, field networks or battery.

## Changes and measurements

### Peer links and the WebAssembly boundary

| Path | Before | After |
|---|---:|---:|
| Core-backed link moving one 4 MiB object, both ends on one thread | 6.6–9.7 ms | 4.7–5.4 ms |
| Core module memory after two (or four) 4 MiB receives | 29.6 MiB | 17.3 MiB |
| Serving one 4 MiB schema-3 object as 16 piece ranges | 6.6–7.2 ms, 2.5 MiB module memory | 5.2–5.9 ms, 2.2 MiB |
| Multi-holder piece hashing in the core | 8.4–8.7 ms/MiB | 3.7 ms/MiB |
| Final whole-object check of a 4 MiB multi-holder transfer | 35–38 ms | 15–16 ms |

The JavaScript reference link moved the same object in 2.0–2.7 ms before and
after; it was not changed. v0.4.3 already passes only a requested range into
the module when serving; the range row shows the remaining frame copies.

- A link frame is moved, not copied, into the module's result buffer, and a
  resolved object is written into it once. The browser shell reads each event
  out of module memory separately, so a resolved object is copied once into a
  buffer of its exact size instead of copying the frame and then the object.
  The frame format is unchanged, so either module works with either shell.
- A receive whose size the caller expected from a signed commitment reserves
  that size once, on the first byte. A size only the remote declared still
  grows as bytes arrive, so `meta` alone holds no memory.
- The `sha2` crate is compiled at `opt-level = 3` while the rest of the module
  stays at `"z"`. The module grew from 411,690 to 415,896 bytes (152.0 to
  153.4 KB gzip), including the verdict memory below.
- The multi-holder transfer output is copied once, from module memory into its
  own buffer.

### Commitment verification

| Fresh commitment per segment, same stream event | Before | After |
|---|---:|---:|
| JavaScript verifier, author-signed | 3.6–6.1 ms | 1.8–2.0 ms |
| WebAssembly verifier, author-signed | 0.80 ms | 0.51 ms |
| JavaScript verifier, delegate-signed with four revocations | 14.3–15.0 ms | 2.0–2.3 ms |
| WebAssembly verifier, delegate-signed with four revocations | 2.7–2.9 ms | 0.63–0.67 ms |

Both verifiers recheck the unchanged stream event, delegation and every
supplied revocation for every segment. Each now remembers up to 512 Schnorr
signatures it has proved, keyed by the recomputed event hash, public key and
signature. The hash is recomputed on every call, so a changed field is a
different key, and every other check (size bound, kind, tags, times, scope and
revocation matching) still runs on every call. Only proofs are remembered; a
failed signature is checked again. Both verifiers pass all 140 shared vectors
cold and again with every accepted signature remembered.

### Signalling and the native path

- `RelaySwarmSession` derives each peer's NIP-44 conversation key once, in a
  256-entry least-recently-used map cleared by `close()`. Fifty signals to one
  peer took 333 ms before and 162 ms after; the remainder is event signing.
  Signals stay pairwise encrypted.
- `RelayPool` gains `readyOnFirstRelay`. The installed native client uses it,
  so a relay that accepts TCP but never answers no longer holds discovery for
  the whole peer deadline. With one such relay and one healthy relay, a native
  fetch with a 4 s peer deadline completed over HyperDHT in about 0.2 s;
  before, it exhausted the deadline and the peer attempt failed.
- The native client starts Nostr discovery while the DHT bootstraps, and waits
  for both before dialling.
- The native receiver fills one buffer of the trusted size and hashes as bytes
  arrive, instead of keeping every chunk and joining them. A 16 MiB object in
  1,452-byte reads took 88–94 ms before and 23–24 ms after; in whole frames
  it took 22–24 ms before and 19 ms after, and peak memory is one object, not two.
  The size, chunk budget and digest checks are unchanged.

### Browser loader

Synchronous `load()` time per segment, with every counter identical before
and after:

| Case | Before | After |
|---|---:|---:|
| Shadow mode, unsampled, not serving, 2 MiB / 8 MiB | 1.92 / 3.90 ms | 0.12 / 0.14 ms |
| Peer-first HTTP fallback, not serving, 2 MiB / 8 MiB | 0.68 / 1.90 ms | 0.23 / 0.19 ms |

- Shadow mode copies origin bytes only for a sampled comparison or when this
  viewer may serve, and hashes them only for a sampled comparison. With the
  default 0.25 sample rate and serving off, three in four segments previously
  paid a copy and a SHA-256 they never used.
- Peer-first skips whole-segment copies that the held-segment store would
  discard, because serving is off or the object is already held. Whether to
  copy is now decided when the response arrives; if serving is switched on in
  the microtask before the store runs, that one segment is not held.
- The origin-seeding rank comparison is computed once per wait wake rather
  than rebuilding hex strings per candidate: 50 µs to 6 µs with four
  candidates, with the same order on 700,000 randomised comparisons.
- The core-backed neighbour discovery keeps its decoded candidate list until
  a hint or clear changes it. With 64 candidates, `hinted` fell from 123–428 µs
  to 45–52 µs and `choose` from 150–399 µs to 70–78 µs.
- Trace-only clones are skipped when request tracing is off.

### Publisher and demo origin

| Path | Before | After |
|---|---:|---:|
| Catalogue refresh, live, two renditions of 12 segments | 1.1–1.3 ms | 0.8–0.9 ms |
| Catalogue refresh, two renditions of 1,800 segments | 12.8–13.7 ms | 0.9–1.0 ms |
| Commitment, 1,800-segment renditions with cache churn | 31–32 ms | 5.5–6.1 ms |
| 16 / 32 / 64 simultaneous requests for one new segment, limit 8 | 8 / 24 / 56 refused (503) | none refused, one signature |
| Account-allowance reservation at capacity (CPU) | 65 ms | 40 ms |
| Demo page assets, first visit / revalidation | 1.27 MB / 1.27 MB | 385 KB / 0 bytes (304) |
| Demo relay fan-out, 64 clients with two subscriptions | 430 µs per event | 53 µs per event |

- Media playlists are read concurrently, each read sized from its stat size,
  and a refresh whose master and media playlists are byte-identical to the
  previous read returns the previous parse. Every refresh still reads and
  stat-checks every playlist; a playlist with `EXT-X-SKIP` is always parsed,
  because a delta depends on the previous catalogue.
- Identical concurrent commitment requests join the one in flight without
  taking a slot. Each caller receives its own copy, and a failure reaches
  every joined caller and is not kept. The demo's 240-per-10-second request
  budget is unchanged and still counts joined and cached requests.
- Account-allowance validation builds its account and grant indexes once,
  making it linear in the bounded state.
- The demo serves its page, style sheet, client bundle and WebAssembly module
  with Brotli or gzip, a strong ETag per encoding, `cache-control: no-cache`
  and 304 revalidation. Every other route keeps `no-store`, and the security
  headers are sent on 200 and 304 responses.
- The demo relay serialises each event once per fan-out, with byte-identical
  frames, and evicts history without copying it.

## Not changed

These were measured or reviewed and left alone, with the reason.

- Per-chunk link overhead is 5–9 µs in the core-backed link and 2–4 µs in the
  JavaScript link, about 1–2 ms per 4 MiB at both ends.
- Peer selection takes about 2 µs per choice with six links, and scheduler
  ticks about 13 µs.
- Incoming relay events are deduplicated before signature verification, and
  every bounded map in the session and relay pool stays bounded.

## Follow-ups

Ranked by expected effect. None is implemented here.

1. Republish broadcast playlists on a file-system watch instead of the 250 ms
   poll, so blocking playlist reloads release sooner after a segment is written.
2. Group account-allowance writes so concurrent reservations share one durable
   write; each operation must stay atomic and a failed one must not persist.
   Most of the remaining reservation cost is the state clone and full rewrite.
3. Count only signatures, not joined or cached requests, against the demo's
   commitment budget, which otherwise caps a server near 48 viewers.
4. Keep a per-relay retry count so a relay that accepts and then drops each
   connection backs off instead of being redialled every 1–2 s.
