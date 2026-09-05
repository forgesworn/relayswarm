# Native transport spike

RelaySwarm now has a second, experimental data path for installed Node
applications. It uses Nostr for rendezvous and one-shot authorization, then
moves the bytes over a Noise-encrypted HyperDHT stream. It does not configure,
contact or emulate a STUN or TURN server.

This is deliberately a bounded spike. It proves that WebRTC is not a protocol
requirement for native RelaySwarm nodes. It does not prove that arbitrary home
networks are reachable, that data remains available after every seeder leaves,
or that a normal browser can open this transport.

## Protocol flow

Protocol version 3 continues to use experimental ephemeral kinds 24170 and
24171. They are not an accepted NIP and must not be treated as stable wire
assignments.

1. Each process creates an independent ephemeral Nostr key and an independent
   HyperDHT Noise key. Neither is the user's social identity.
2. The seeder publishes a signed presence event containing the swarm id, its
   Noise public key and the SHA-256 digest it can serve.
3. The leecher sends a `dial` signal to that ephemeral Nostr key. The signal is
   signed and NIP-44 encrypted. It binds the leecher's Noise key to one request
   id, digest and byte count.
4. The seeder validates the signal, installs a short-lived, one-use firewall
   authorization for that exact Noise key, then returns an encrypted `ready`
   signal.
5. HyperDHT locates the seeder and attempts direct UDP traversal. The resulting
   duplex stream is encrypted and mutually authenticated by Noise keys.
6. The leecher requests the already-authorized object. The sender re-checks its
   local bytes before serving them. The receiver enforces the expected byte
   count and computes SHA-256 itself before accepting the result.

The relay never receives the object bytes or plaintext dial details. It still
sees event metadata, swarm tags, ephemeral Nostr public keys, timing and source
IP addresses.

## What this replaces

For an installed RelaySwarm process, `hyperdht-v1` can replace the WebRTC data
channel and ICE/STUN signalling. HyperDHT supplies its own DHT routing, UDP hole
punching and Noise transport.

It does not remove infrastructure:

- Nostr relays remain the signed rendezvous and authorization path.
- HyperDHT needs bootstrap/routing nodes. The default client uses HyperDHT's
  public bootstrap set; tests inject a private local bootstrapper. A deployment
  can operate several independent bootstrappers and pass them with
  `--bootstrap host:port`.
- UDP-blocking and difficult symmetric NATs can still prevent a direct path.
  There is no relay fallback in this spike. Failure must fall back to the HTTPS
  origin, Blossom, or another explicitly selected source.

That is a much nicer dependency shape than TURN for native nodes, but it is not
the abolition of networking.

## What this does not replace

Ordinary browser pages cannot open arbitrary UDP sockets or run HyperDHT. The
existing WebRTC path therefore remains necessary for browser-to-browser peer
assist. A packaged desktop application, local companion process, browser
extension with a native host, or suitably privileged installed web app could
bridge the native path, but each has a distribution and trust cost.

This is also not yet a decentralised storage network. The process serves an
in-memory content-addressed object while it is online; it does not persist,
pin, replicate, repair or promise availability. A useful Blossom replacement
would need all of those policies plus quotas, abuse controls, garbage
collection and proof that enough independent nodes retain each object.

## Security boundary

The spike fails closed on the following boundaries:

- relay events must have a valid Nostr signature, the exact swarm tag, bounded
  age and bounded payload sizes;
- non-loopback relay URLs must use `wss://`;
- dial details are pairwise NIP-44 encrypted;
- the native listener rejects Noise keys that do not have an unexpired Nostr
  authorization, and consumes authorization on first connection;
- request id, digest and size must match across the encrypted Nostr signal,
  firewall authorization and transfer request;
- individual frames are capped at 64 KiB and objects at 256 MiB;
- the receiver's expected digest is authoritative. Metadata supplied by the
  serving peer cannot change it.

The application still has to obtain that expected digest from a trusted source,
such as a streamer-signed manifest or a trusted HTTPS/Blossom descriptor. A
malicious publisher can legitimately sign a malicious object. Hash checking is
integrity, not truth or moderation.

The current receiver buffers the complete object before returning it. That is
reasonable for the spike and small media segments, not for large durable blobs.
A production implementation needs streaming-to-disk, per-chunk verification,
resource accounting, peer reputation, cancellation and origin fallback.

## Run it

Node 24 is the tested runtime.

```bash
npm ci
npm run test:native
npm run poc:native
npm run poc:native -- --relay wss://your.relay --size 1048576
npm run poc:native -- --bootstrap bootstrap.example:49737
```

The deterministic tests start a loopback Nostr relay and a loopback HyperDHT
bootstrap node. They prove the complete authorization and transfer path without
using external infrastructure. CI is configured to run them on current GitHub
Windows, Linux and macOS runners. Until those jobs have run, only the local
macOS result is evidence, not three-platform proof.

Still required before choosing this for production:

- real home-to-home tests across varied NATs, VPNs, IPv4/IPv6 and UDP-blocked
  networks;
- suspend/resume, sleep, network change and long-running resource tests;
- executable packaging and firewall-prompt testing on all three operating
  systems;
- protocol interop with a genuinely independent implementation;
- dependency and native-binary supply-chain review;
- a signed content manifest and a durable storage/replication policy.
