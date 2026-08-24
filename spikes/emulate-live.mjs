#!/usr/bin/env node
// Local emulation: an origin "hosts" a live stream and viewers join over
// time - the deployment shape the thesis claims, run on one machine.
// The origin publishes a new segment every interval; each viewer, for each
// segment, tries a peer that already holds it first and falls back to the
// origin, verifies by hash, then re-serves to later joiners. The receipt's
// load-bearing numbers: how many viewers the ORIGIN had to serve per
// segment (the thesis says ~1 - the edge - however big the crowd gets),
// and whether every viewer stayed inside the segment deadline.
//
// Deliberately NOT the swarm engine: the fetch policy is the simplest
// thing that emulates the shape (first peer seen, origin after a short
// wait or on failure) - no scheduling, no budgets, no churn handling.
// Throwaway measurement code, same mechanism as fanout/redistribute
// (grants/GUARDRAILS.md G36 - feasibility spikes are foundation).
// Hash authority here is the origin's announced hash, matching the PoC's
// documented caveat: it proves transport, not provenance.
//
// Run: node spikes/emulate-live.mjs [--viewers 5] [--duration 60]
//      [--interval 4000] [--segment-size 524288] [--stagger 2500]

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
const RELAY = flag("relay", "wss://relay.trotters.cc");
const VIEWERS = Number(flag("viewers", 5));
const DURATION_S = Number(flag("duration", 60));
const INTERVAL_MS = Number(flag("interval", 4000));
const SEGMENT_SIZE = Number(flag("segment-size", 512 * 1024));
const STAGGER_MS = Number(flag("stagger", 2500));
// How long a viewer waits for a non-origin holder before dialling the
// origin, and the per-viewer jitter added to it. The jitter is what makes
// the emulation honest: without it every viewer's wait expires at the same
// moment and the origin serves the whole crowd; with it, quick viewers pull
// from the origin and become holders while slower ones find peer announces
// inside their window - the tiered fan-out the thesis predicts.
const PEER_WAIT_MS = Number(flag("peer-wait", 500));
const PEER_SPREAD_MS = Number(flag("peer-spread", 500));
const CHUNK_SIZE = 16 * 1024;
const ICE_SERVERS = [{ urls: flag("stun", "stun:stun.l.google.com:19302") }];

const swarmId = `live-${randomBytes(8).toString("hex")}`;
const startedAt = Date.now();
const log = (who, msg) => console.error(`[${String(Date.now() - startedAt).padStart(6)}ms] [${who}] ${msg}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RelayPool {
  constructor(urls, label) {
    this.label = label;
    this.sockets = [];
    this.handlers = [];
    this.seen = new Set();
    this.published = 0;
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
      for (const handler of [...this.handlers]) handler(event);
    }
  }
  subscribe(filter) {
    const frame = JSON.stringify(["REQ", randomBytes(4).toString("hex"), filter]);
    for (const ws of this.sockets) ws.send(frame);
  }
  onEvent(handler) {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }
  publish(event) {
    this.published += 1;
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
    announce(payload) {
      pool.publish(finalizeEvent({
        kind: KIND_PRESENCE,
        created_at: Math.floor(Date.now() / 1000),
        tags: [[SWARM_TAG, swarmId]],
        content: JSON.stringify(payload),
      }, secret));
    },
  };
}

// A peer that can serve every segment it holds: `held` maps hash -> Buffer.
function serveOn(peer) {
  peer.pool.onEvent(async (event) => {
    if (event.kind !== KIND_SIGNAL) return;
    if (event.pubkey === peer.me.pubkey) return;
    if (!event.tags.some(([n, v]) => n === "p" && v === peer.me.pubkey)) return;
    let payload;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return;
    }
    if (payload.type !== "offer") return;
    // Viewers fetch every segment with a fresh offer (one pc per fetch in
    // this emulation), so a repeat offer replaces the previous connection.
    const previous = peer.pcs.get(event.pubkey);
    if (previous) previous.close().catch(() => {});
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peer.pcs.set(event.pubkey, pc);
    pc.onDataChannel.subscribe((channel) => {
      channel.onMessage.subscribe((message) => {
        const text = typeof message === "string" ? message : "";
        if (!text.startsWith("want:")) return;
        const segment = peer.held.get(text.slice(5));
        if (!segment) return;
        channel.send(JSON.stringify({ type: "meta", size: segment.length, sha256: sha256(segment) }));
        for (let off = 0; off < segment.length; off += CHUNK_SIZE) {
          channel.send(segment.subarray(off, off + CHUNK_SIZE));
        }
        channel.send(JSON.stringify({ type: "eof" }));
        peer.serves += 1;
        peer.bytesOut += segment.length;
      });
    });
    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    peer.me.sendSignal(event.pubkey, { type: "answer", sdp: pc.localDescription.sdp });
  });
}

async function connectPeer(label) {
  const pool = new RelayPool([RELAY], label);
  await pool.openPromise;
  const peer = { label, pool, me: makePeer(pool), pcs: new Map(), held: new Map(), serves: 0, bytesOut: 0 };
  serveOn(peer);
  peer.pool.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(Date.now() / 1000) - 1 });
  return peer;
}

// Dial a holder, pull one segment, verify against the announced hash.
// Resolves with the verified bytes; rejects on timeout or mismatch.
function fetchSegment(viewer, holderPubkey, hash, timeoutMs) {
  return new Promise((resolve, reject) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = pc.createDataChannel("segments");
    const received = [];
    let meta = null;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      offSignal();
      pc.close().catch(() => {});
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(reason));
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    channel.stateChanged.subscribe((state) => {
      if (state === "open") channel.send(`want:${hash}`);
    });
    channel.onMessage.subscribe((message) => {
      if (typeof message === "string") {
        let payload;
        try {
          payload = JSON.parse(message);
        } catch {
          return;
        }
        if (payload.type === "meta") {
          meta = payload;
        } else if (payload.type === "eof") {
          const body = Buffer.concat(received);
          const ok = meta && body.length === meta.size && sha256(body) === hash && meta.sha256 === hash;
          if (!ok) return fail("hash mismatch");
          if (!settled) {
            settled = true;
            cleanup();
            resolve(body);
          }
        }
      } else received.push(Buffer.from(message));
    });
    const offSignal = viewer.pool.onEvent(async (event) => {
      if (event.kind !== KIND_SIGNAL || event.pubkey !== holderPubkey) return;
      if (!event.tags.some(([n, v]) => n === "p" && v === viewer.me.pubkey)) return;
      let payload;
      try {
        payload = JSON.parse(event.content);
      } catch {
        return;
      }
      if (payload.type !== "answer") return;
      await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
    });
    (async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      viewer.me.sendSignal(holderPubkey, { type: "offer", sdp: pc.localDescription.sdp });
    })().catch(fail);
  });
}

async function runViewer(index, originPubkey) {
  const label = `viewer-${index}`;
  const peer = await connectPeer(label);
  const myWait = PEER_WAIT_MS + index * PEER_SPREAD_MS;
  const fetching = new Set(); // seq currently being fetched
  const done = new Set(); // seq already held
  const segments = []; // per-segment receipt rows
  const stats = { servedByOrigin: 0, servedByPeer: 0, fallbacks: 0, misses: 0, hashFailures: 0 };

  async function obtain(seq, hash, targetPubkey, servedBy, tSeen, fellBack) {
    const body = await fetchSegment(peer, targetPubkey, hash, INTERVAL_MS);
    // Verify-then-announce ordering matters: only holders may re-seed.
    peer.held.set(hash, body);
    done.add(seq);
    if (servedBy === "origin") stats.servedByOrigin += 1;
    else stats.servedByPeer += 1;
    const latencyMs = Date.now() - tSeen;
    segments.push({ seq, servedBy, fellBack, latencyMs, hit: latencyMs <= INTERVAL_MS });
    peer.me.announce({ role: "viewer", seq, hash });
  }

  peer.pool.onEvent(async (event) => {
    if (event.kind !== KIND_PRESENCE) return;
    if (event.pubkey === peer.me.pubkey) return;
    let payload;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return;
    }
    const { seq, hash, role } = payload;
    if (typeof seq !== "number" || !hash) return;
    if (done.has(seq) || fetching.has(seq)) return;
    const tSeen = Date.now();
    const fromOrigin = event.pubkey === originPubkey;

    if (!fromOrigin) {
      // Peer holder seen: fetch immediately, origin as the fallback.
      fetching.add(seq);
      try {
        await obtain(seq, hash, event.pubkey, "peer", tSeen, false);
      } catch {
        stats.fallbacks += 1;
        try {
          await obtain(seq, hash, originPubkey, "origin", tSeen, true);
        } catch (error) {
          stats.misses += 1;
          if (error.message === "hash mismatch") stats.hashFailures += 1;
          log(label, `seq ${seq}: MISS (${error.message})`);
        }
      } finally {
        fetching.delete(seq);
      }
    } else {
      // Origin announced: give peers a viewer-specific window to show up.
      await sleep(myWait);
      if (done.has(seq) || fetching.has(seq)) return;
      fetching.add(seq);
      try {
        await obtain(seq, hash, originPubkey, "origin", tSeen, false);
      } catch (error) {
        stats.misses += 1;
        if (error.message === "hash mismatch") stats.hashFailures += 1;
        log(label, `seq ${seq}: MISS from origin (${error.message})`);
      } finally {
        fetching.delete(seq);
      }
    }
  });

  return { peer, stats, segments };
}

async function main() {
  log("emulate", `swarm ${swarmId}: origin + ${VIEWERS} viewers, ${SEGMENT_SIZE}B every ${INTERVAL_MS}ms for ${DURATION_S}s, via ${RELAY}`);

  // ---- Origin: hosts the stream ------------------------------------------
  const origin = await connectPeer("origin");
  log("origin", `hosting; pubkey ${origin.me.pubkey.slice(0, 8)}`);

  // ---- Viewers join on a stagger ------------------------------------------
  const viewerRuns = [];
  for (let i = 0; i < VIEWERS; i++) {
    viewerRuns.push(runViewer(i, origin.me.pubkey));
    if (i < VIEWERS - 1) await sleep(STAGGER_MS);
  }
  const viewers = await Promise.all(viewerRuns);

  // ---- Stream: one segment per interval, first one immediately ------------
  let seq = 0;
  const tick = () => {
    seq += 1;
    const segment = randomBytes(SEGMENT_SIZE);
    const hash = sha256(segment);
    origin.held.set(hash, segment);
    origin.me.announce({ role: "origin", seq, hash });
    if (seq === 1 || seq % 5 === 0) log("origin", `segment ${seq} announced (${origin.serves} serves so far)`);
  };
  tick();
  const streamTimer = setInterval(tick, INTERVAL_MS);

  await sleep(DURATION_S * 1000);
  clearInterval(streamTimer);
  await sleep(INTERVAL_MS); // grace: let in-flight fetches finish

  // ---- Receipt ---------------------------------------------------------------
  const totalSegments = seq;
  const allRows = viewers.flatMap((v) => v.segments);
  const allVerified = viewers.every((v) => v.stats.misses === 0 && v.stats.hashFailures === 0);
  const summary = {
    ok: allVerified,
    swarmId,
    relay: RELAY,
    config: { viewers: VIEWERS, segmentBytes: SEGMENT_SIZE, intervalMs: INTERVAL_MS, durationS: DURATION_S, staggerMs: STAGGER_MS, peerWaitMs: PEER_WAIT_MS },
    totalSegments,
    viewers: viewers.map((v, i) => ({
      index: i,
      segmentsHeld: v.segments.length,
      servedByOrigin: v.stats.servedByOrigin,
      servedByPeer: v.stats.servedByPeer,
      fallbacks: v.stats.fallbacks,
      misses: v.stats.misses,
      deadlineHits: v.segments.filter((s) => s.hit).length,
      reServed: v.peer.serves,
    })),
    origin: {
      serves: origin.serves,
      egressBytes: origin.bytesOut,
      servesPerSegment: totalSegments ? Number((origin.serves / totalSegments).toFixed(2)) : 0,
    },
    aggregate: {
      fetches: allRows.length,
      servedByOrigin: allRows.filter((r) => r.servedBy === "origin").length,
      servedByPeer: allRows.filter((r) => r.servedBy === "peer").length,
      deadlineHitRate: allRows.length ? Number((allRows.filter((r) => r.hit).length / allRows.length).toFixed(3)) : 0,
      allVerified,
    },
  };
  console.log(JSON.stringify(summary, null, 2));

  origin.pool.close();
  for (const v of viewers) v.peer.pool.close();
  process.exit(allVerified ? 0 : 1);
}

main().catch((error) => { console.error(`FAIL: ${error.message}`); process.exit(1); });
