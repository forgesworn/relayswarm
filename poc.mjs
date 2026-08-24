#!/usr/bin/env node

// Proof of concept: WebRTC peer-assisted delivery of an HLS segment where
// peer discovery and signalling run entirely over public Nostr relays -- no
// tracker, no signalling server, no STUN coordination service beyond ICE
// itself. Two peers (a seeder holding a segment and a leecher wanting it)
// find each other via ephemeral Nostr events, negotiate a WebRTC data
// channel, and move the segment peer-to-peer. The transfer is verified by
// hash and timed.
//
// What this proves: the load-bearing claim of the proposal -- that the Nostr
// relay network the stream already uses (NIP-53) can replace the centralised
// tracker every existing peer-assisted HLS deployment depends on.
//
// What it deliberately does not do yet: NIP-44 encryption of signalling
// payloads, multi-peer swarm scheduling, hls.js integration, NAT traversal
// beyond STUN. Those are the project deliverables, not the PoC.
//
// Run: node poc.mjs [--relay wss://...] [--size 614400] [--stun stun:host:port]

import { RTCPeerConnection } from "werift";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

// Ephemeral kind range (20000-29999): relays relay them but do not store
// them, which is exactly right for presence and SDP -- they are worthless
// seconds later.
const KIND_PRESENCE = 24170;
const KIND_SIGNAL = 24171;
const SWARM_TAG = "x";

const relayFlag = flag("relay", "");
const RELAYS = relayFlag.length
  ? [relayFlag]
  : ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const SEGMENT_SIZE = Number(flag("size", 600 * 1024));
const CHUNK_SIZE = 16 * 1024;
// STUN's only job here is to tell a peer its own public address; no media
// or signalling transits it. The operator sees an IP and a timestamp, which
// the swarm already exposes to peers. Default is Google's for demo
// reliability; the NIP lets a stream name its own STUN servers (self-hosted
// coturn is a one-line deploy) exactly as it names chat relays today.
const ICE_SERVERS = [{ urls: flag("stun", "stun:stun.l.google.com:19302") }];

const swarmId = `poc-${randomBytes(8).toString("hex")}`;
const startedAt = Date.now();
const marks = {};
function mark(name) {
  marks[name] = Date.now() - startedAt;
}

function log(who, message) {
  console.error(`[${String(Date.now() - startedAt).padStart(6)}ms] [${who}] ${message}`);
}

// --- Minimal Nostr client: publish + subscribe over raw WebSockets --------

class RelayPool {
  constructor(urls, label) {
    this.label = label;
    this.sockets = [];
    this.handlers = [];
    this.seen = new Set();
    this.openPromise = Promise.allSettled(
      urls.map(
        (url) =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
              ws.close();
              reject(new Error(`${url} timed out`));
            }, 8000);
            ws.addEventListener("open", () => {
              clearTimeout(timer);
              this.sockets.push(ws);
              log(this.label, `connected to ${url}`);
              resolve(ws);
            });
            ws.addEventListener("error", () => {
              clearTimeout(timer);
              reject(new Error(`${url} failed to connect`));
            });
            ws.addEventListener("message", (message) => this.onMessage(url, message.data));
          }),
      ),
    ).then((results) => {
      if (!this.sockets.length) {
        const reasons = results.map((r) => r.reason?.message).join("; ");
        throw new Error(`No relay reachable: ${reasons}`);
      }
    });
  }

  onMessage(url, data) {
    let frame;
    try {
      frame = JSON.parse(String(data));
    } catch {
      return;
    }
    if (frame[0] === "EVENT" && frame[2]) {
      const event = frame[2];
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);
      if (!verifyEvent(event)) return;
      for (const handler of this.handlers) handler(event);
    }
  }

  subscribe(filter) {
    const subId = randomBytes(4).toString("hex");
    const frame = JSON.stringify(["REQ", subId, filter]);
    for (const ws of this.sockets) ws.send(frame);
  }

  onEvent(handler) {
    this.handlers.push(handler);
  }

  publish(event) {
    const frame = JSON.stringify(["EVENT", event]);
    for (const ws of this.sockets) ws.send(frame);
  }

  close() {
    for (const ws of this.sockets) ws.close();
  }
}

// --- A peer: identity + signalling over the pool --------------------------

function makePeer(label, pool) {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    label,
    pubkey,
    sendSignal(toPubkey, payload) {
      const event = finalizeEvent(
        {
          kind: KIND_SIGNAL,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            [SWARM_TAG, swarmId],
            ["p", toPubkey],
          ],
          // Plaintext for the PoC; the deliverable wraps this in NIP-44 so
          // relays cannot read the SDP payload. Event kinds, tags and timing
          // stay visible to relays regardless - NIP-44 hides bodies, not metadata.
          content: JSON.stringify(payload),
        },
        secret,
      );
      pool.publish(event);
    },
    announcePresence(role, extra = {}) {
      const event = finalizeEvent(
        {
          kind: KIND_PRESENCE,
          created_at: Math.floor(Date.now() / 1000),
          tags: [[SWARM_TAG, swarmId]],
          content: JSON.stringify({ role, ...extra }),
        },
        secret,
      );
      pool.publish(event);
    },
  };
}

// --- The transfer protocol over one data channel --------------------------

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function main() {
  log("poc", `swarm ${swarmId}, segment ${SEGMENT_SIZE} bytes, relays: ${RELAYS.join(", ")}`);

  // One pool per peer: each peer keeps its own relay connections, as two
  // real viewers would.
  const seederPool = new RelayPool(RELAYS, "seeder-relay");
  const leecherPool = new RelayPool(RELAYS, "leecher-relay");
  await Promise.all([seederPool.openPromise, leecherPool.openPromise]);
  mark("relaysConnected");

  const segment = randomBytes(SEGMENT_SIZE);
  const segmentHash = sha256(segment);

  const seeder = makePeer("seeder", seederPool);
  const leecher = makePeer("leecher", leecherPool);

  // Both sides subscribe to the swarm's ephemeral events from "now".
  const since = Math.floor(Date.now() / 1000) - 1;
  seederPool.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since });
  leecherPool.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since });

  const done = { resolve: null, reject: null };
  const finished = new Promise((resolve, reject) => {
    done.resolve = resolve;
    done.reject = reject;
  });
  const timeout = setTimeout(() => done.reject(new Error("PoC timed out after 60s")), 60_000);

  // ---- Seeder side -------------------------------------------------------

  const seederPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  seederPc.onDataChannel.subscribe((channel) => {
    log("seeder", `data channel "${channel.label}" open`);
    channel.onMessage.subscribe((message) => {
      const text = typeof message === "string" ? message : "";
      if (text === "want-segment") {
        mark("requestReceived");
        log("seeder", `sending ${segment.length} bytes in ${Math.ceil(segment.length / CHUNK_SIZE)} chunks`);
        channel.send(JSON.stringify({ type: "meta", size: segment.length, sha256: segmentHash }));
        for (let offset = 0; offset < segment.length; offset += CHUNK_SIZE) {
          channel.send(segment.subarray(offset, offset + CHUNK_SIZE));
        }
        channel.send(JSON.stringify({ type: "eof" }));
      }
    });
  });

  seederPool.onEvent(async (event) => {
    if (event.pubkey === seeder.pubkey) return;
    if (event.kind !== KIND_SIGNAL) return;
    if (!event.tags.some(([name, value]) => name === "p" && value === seeder.pubkey)) return;
    const payload = JSON.parse(event.content);
    if (payload.type === "offer") {
      mark("offerReceived");
      log("seeder", "offer received via relay, answering");
      await seederPc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await seederPc.createAnswer();
      await seederPc.setLocalDescription(answer);
      // Non-trickle: werift's local description embeds gathered host/STUN
      // candidates; one answer event is the whole reply.
      seeder.sendSignal(event.pubkey, { type: "answer", sdp: seederPc.localDescription.sdp });
    }
  });

  // The seeder announces itself the way the first viewer with a segment
  // would; re-announced on an interval because ephemeral events reach only
  // subscribers connected at that moment.
  seeder.announcePresence("seeder", { have: [segmentHash] });
  const presenceTimer = setInterval(() => seeder.announcePresence("seeder", { have: [segmentHash] }), 2000);

  // ---- Leecher side ------------------------------------------------------

  const leecherPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = leecherPc.createDataChannel("segments");

  let meta = null;
  const received = [];
  channel.stateChanged.subscribe((state) => {
    if (state === "open") {
      mark("channelOpen");
      log("leecher", "data channel open, requesting segment");
      channel.send("want-segment");
    }
  });
  channel.onMessage.subscribe((message) => {
    if (typeof message === "string") {
      const payload = JSON.parse(message);
      if (payload.type === "meta") {
        meta = payload;
        mark("transferStarted");
      } else if (payload.type === "eof") {
        mark("transferComplete");
        const body = Buffer.concat(received);
        const hash = sha256(body);
        const ok = meta && body.length === meta.size && hash === meta.sha256;
        if (ok) {
          log("leecher", `segment verified: ${body.length} bytes, sha256 ${hash.slice(0, 16)}...`);
          done.resolve({ bytes: body.length, hash });
        } else {
          done.reject(new Error(`Segment mismatch: ${body.length}/${meta?.size} bytes, ${hash} vs ${meta?.sha256}`));
        }
      }
    } else {
      received.push(Buffer.from(message));
    }
  });

  let dialled = false;
  leecherPool.onEvent(async (event) => {
    if (event.pubkey === leecher.pubkey) return;
    if (event.kind !== KIND_PRESENCE && event.kind !== KIND_SIGNAL) return;
    let payload;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return; // a public swarm tag can carry malformed events; ignore them
    }
    if (event.kind === KIND_PRESENCE && payload.role === "seeder" && !dialled) {
      dialled = true;
      mark("seederDiscovered");
      log("leecher", `seeder ${event.pubkey.slice(0, 8)} discovered via relay, sending offer`);
      const offer = await leecherPc.createOffer();
      await leecherPc.setLocalDescription(offer);
      leecher.sendSignal(event.pubkey, { type: "offer", sdp: leecherPc.localDescription.sdp });
    }
    if (event.kind === KIND_SIGNAL && payload.type === "answer") {
      if (!event.tags.some(([name, value]) => name === "p" && value === leecher.pubkey)) return;
      mark("answerReceived");
      log("leecher", "answer received via relay, connecting");
      await leecherPc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    }
  });

  try {
    const result = await finished;
    clearTimeout(timeout);
    clearInterval(presenceTimer);
    const summary = {
      ok: true,
      swarmId,
      relays: RELAYS,
      segmentBytes: result.bytes,
      sha256Verified: true,
      timingsMs: {
        relaysConnected: marks.relaysConnected,
        seederDiscovered: marks.seederDiscovered,
        offerToAnswer: marks.answerReceived - marks.offerReceived || null,
        signallingTotal: marks.channelOpen - marks.seederDiscovered,
        transferMs: marks.transferComplete - marks.transferStarted,
        endToEnd: marks.transferComplete,
      },
      throughputMBps: Number((result.bytes / 1024 / 1024 / ((marks.transferComplete - marks.transferStarted) / 1000)).toFixed(2)),
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    clearInterval(presenceTimer);
    await seederPc.close();
    await leecherPc.close();
    seederPool.close();
    leecherPool.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  },
);
