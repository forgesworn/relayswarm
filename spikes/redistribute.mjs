#!/usr/bin/env node
// Feasibility spike: leecher-becomes-seeder. The load-bearing swarm claim is
// that a viewer who already holds a segment can redistribute it - "the
// viewers are the CDN". Every other spike is a star (one seeder, N
// leechers); this one is a chain: origin seeder -> leecher A -> leecher B,
// where B's copy provably never touches the origin, because the origin
// announces once at the start and then falls silent, A announces only after
// verifying its own copy, and B subscribes with a `since` filter that
// excludes the origin's announcement.
//
// Deliberately NOT the swarm engine: two-hop chain, no scheduling, no
// chunk-level piece exchange. Throwaway measurement code (see
// grants/GUARDRAILS.md G36 - feasibility spikes are foundation).
//
// Run: node spikes/redistribute.mjs [--size 2097152]

import { RTCPeerConnection } from "werift";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const KIND_PRESENCE = 24170;
const KIND_SIGNAL = 24171;
const SWARM_TAG = "x";
const RELAYS = [flag("relay", "wss://relay.trotters.cc")];
const SEGMENT_SIZE = Number(flag("size", 2 * 1024 * 1024));
const CHUNK_SIZE = 16 * 1024;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const swarmId = `redist-${randomBytes(8).toString("hex")}`;
const startedAt = Date.now();
const log = (who, msg) => console.error(`[${String(Date.now() - startedAt).padStart(6)}ms] [${who}] ${msg}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

class RelayPool {
  constructor(urls, label) {
    this.label = label;
    this.sockets = [];
    this.handlers = [];
    this.seen = new Set();
    this.published = 0;
    this.writes = 0;
    this.openPromise = Promise.allSettled(
      urls.map(
        (url) =>
          new Promise((resolve, reject) => {
            const ws = new WebSocket(url);
            const timer = setTimeout(() => { ws.close(); reject(new Error(`${url} timed out`)); }, 8000);
            ws.addEventListener("open", () => { clearTimeout(timer); this.sockets.push(ws); resolve(ws); });
            ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${url} failed`)); });
            ws.addEventListener("message", (m) => this.onMessage(m.data));
          }),
      ),
    ).then((results) => {
      if (!this.sockets.length) throw new Error(`No relay reachable: ${results.map((r) => r.reason?.message).join("; ")}`);
    });
  }
  onMessage(data) {
    let frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    if (frame[0] === "EVENT" && frame[2]) {
      const event = frame[2];
      if (this.seen.has(event.id)) return;
      this.seen.add(event.id);
      if (!verifyEvent(event)) return;
      for (const handler of this.handlers) handler(event);
    }
  }
  subscribe(filter) {
    const frame = JSON.stringify(["REQ", randomBytes(4).toString("hex"), filter]);
    for (const ws of this.sockets) ws.send(frame);
  }
  onEvent(handler) { this.handlers.push(handler); }
  publish(event) {
    this.published += 1;
    this.writes += this.sockets.length;
    const frame = JSON.stringify(["EVENT", event]);
    for (const ws of this.sockets) ws.send(frame);
  }
  close() { for (const ws of this.sockets) ws.close(); }
}

function makePeer(pool) {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    pubkey,
    sendSignal(toPubkey, payload) {
      pool.publish(finalizeEvent({
        kind: KIND_SIGNAL,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[SWARM_TAG, swarmId], ["p", toPubkey]],
        content: JSON.stringify(payload),
      }, secret));
    },
    announcePresence(role) {
      pool.publish(finalizeEvent({
        kind: KIND_PRESENCE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[SWARM_TAG, swarmId]],
        content: JSON.stringify({ role }),
      }, secret));
    },
  };
}

// A serving peer: answers offers with a data channel that sends `segment`.
function serveOn(pool, me, segment, label) {
  const pcs = new Map();
  pool.onEvent(async (event) => {
    if (event.kind !== KIND_SIGNAL) return;
    if (event.pubkey === me.pubkey) return;
    if (!event.tags.some(([n, v]) => n === "p" && v === me.pubkey)) return;
    let payload;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return;
    }
    if (payload.type !== "offer" || pcs.has(event.pubkey)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcs.set(event.pubkey, pc);
    pc.onDataChannel.subscribe((channel) => {
      channel.onMessage.subscribe((message) => {
        if ((typeof message === "string" ? message : "") !== "want-segment") return;
        channel.send(JSON.stringify({ type: "meta", size: segment.length, sha256: sha256(segment) }));
        for (let off = 0; off < segment.length; off += CHUNK_SIZE) {
          channel.send(segment.subarray(off, off + CHUNK_SIZE));
        }
        channel.send(JSON.stringify({ type: "eof" }));
        log(label, `served ${event.pubkey.slice(0, 8)}`);
      });
    });
    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    me.sendSignal(event.pubkey, { type: "answer", sdp: pc.localDescription.sdp });
  });
  return pcs;
}

// A leeching peer: dials the first seeder presence it sees, verifies hash.
async function leechFrom(pool, me, wantHash, label, t0) {
  const marks = {};
  const mark = (name) => { marks[name] = Date.now() - t0; };
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("segments");
  const received = [];
  let meta = null;
  let dialed = null;

  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 90_000);
    channel.stateChanged.subscribe((state) => {
      if (state === "open") { mark("channelOpen"); channel.send("want-segment"); }
    });
    channel.onMessage.subscribe((message) => {
      if (typeof message === "string") {
        const payload = JSON.parse(message);
        if (payload.type === "meta") { meta = payload; mark("transferStarted"); }
        else if (payload.type === "eof") {
          mark("transferComplete");
          const body = Buffer.concat(received);
          const ok = meta && body.length === meta.size && sha256(body) === wantHash && meta.sha256 === wantHash;
          clearTimeout(timeout);
          if (ok) resolve();
          else reject(new Error(`${label} hash mismatch`));
        }
      } else received.push(Buffer.from(message));
    });
  });

  pool.onEvent(async (event) => {
    if (event.pubkey === me.pubkey) return;
    if (event.kind !== KIND_PRESENCE && event.kind !== KIND_SIGNAL) return;
    let payload;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return;
    }
    if (event.kind === KIND_PRESENCE && payload.role === "seeder" && !dialed) {
      dialed = event.pubkey;
      mark("seederDiscovered");
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      me.sendSignal(event.pubkey, { type: "offer", sdp: pc.localDescription.sdp });
    }
    if (event.kind === KIND_SIGNAL && payload.type === "answer") {
      if (!event.tags.some(([n, v]) => n === "p" && v === me.pubkey)) return;
      mark("answerReceived");
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    }
  });

  await result;
  mark("done");
  return { servedBy: dialed, marks };
}

async function main() {
  const segment = randomBytes(SEGMENT_SIZE);
  const segmentHash = sha256(segment);
  log("redist", `swarm ${swarmId}, chain: origin -> A -> B, ${SEGMENT_SIZE} bytes`);

  // ---- Origin seeder: announces until it has served its first peer, then
  // falls silent for the rest of the run. (Ephemeral kinds are not stored,
  // so A needs the repeat announcements; B starts after the origin stops,
  // so the only seeder B can ever discover is A.)
  const originPool = new RelayPool(RELAYS, "origin");
  await originPool.openPromise;
  const origin = makePeer(originPool);
  const originPcs = serveOn(originPool, origin, segment, "origin");
  originPool.subscribe({ kinds: [KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(Date.now() / 1000) - 1 });
  origin.announcePresence("seeder");
  const originAnnounce = setInterval(() => {
    if (originPcs.size === 0) origin.announcePresence("seeder");
  }, 2000);
  log("origin", "announcing until first peer served, then silent");

  // ---- Leecher A: downloads from origin, verifies, becomes seeder -------
  const tA = Date.now();
  const poolA = new RelayPool(RELAYS, "A");
  await poolA.openPromise;
  const a = makePeer(poolA);
  poolA.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(tA / 1000) - 1 });
  const aResult = await leechFrom(poolA, a, segmentHash, "A", tA);
  const aVerifiedAt = Date.now();
  log("A", `verified copy from ${aResult.servedBy.slice(0, 8)} (origin is ${origin.pubkey.slice(0, 8)}), now seeding`);

  // ---- A reseeds: serve + announce (repeating - ephemeral kinds are only
  // delivered live, and B has not connected yet) ---------------------------
  const aPcs = serveOn(poolA, a, segment, "A");
  a.announcePresence("seeder");
  const aAnnounce = setInterval(() => {
    if (aPcs.size === 0) a.announcePresence("seeder");
  }, 2000);

  // ---- Leecher B: starts only after A verified and the origin has gone
  // silent. The only seeder B can ever discover is A, so B's verified copy
  // provably did not come from the origin. --------------------------------
  const tB = Date.now();
  const poolB = new RelayPool(RELAYS, "B");
  await poolB.openPromise;
  const b = makePeer(poolB);
  poolB.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(aVerifiedAt / 1000) });
  const bResult = await leechFrom(poolB, b, segmentHash, "B", tB);

  clearInterval(originAnnounce);
  clearInterval(aAnnounce);

  const bServedByA = bResult.servedBy === a.pubkey;
  log("B", `verified copy from ${bResult.servedBy.slice(0, 8)} (A is ${a.pubkey.slice(0, 8)}, origin is ${origin.pubkey.slice(0, 8)})`);

  const summary = {
    ok: bServedByA,
    swarmId,
    relays: RELAYS,
    segmentBytes: SEGMENT_SIZE,
    chain: "origin -> A -> B",
    hop1: {
      servedByOrigin: aResult.servedBy === origin.pubkey,
      signallingMs: aResult.marks.channelOpen - aResult.marks.seederDiscovered,
      transferMs: aResult.marks.transferComplete - aResult.marks.transferStarted,
      endToEndMs: aResult.marks.done,
    },
    hop2: {
      servedByA: bServedByA,
      servedByOrigin: bResult.servedBy === origin.pubkey,
      originSilentDuringHop2: true,
      signallingMs: bResult.marks.channelOpen - bResult.marks.seederDiscovered,
      transferMs: bResult.marks.transferComplete - bResult.marks.transferStarted,
      endToEndMs: bResult.marks.done,
    },
    eventsPublished: originPool.published + poolA.published + poolB.published,
  };
  console.log(JSON.stringify(summary, null, 2));

  originPool.close(); poolA.close(); poolB.close();
  process.exit(summary.ok ? 0 : 1);
}

main().catch((error) => { console.error(`FAIL: ${error.message}`); process.exit(1); });
