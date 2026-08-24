#!/usr/bin/env node
// Feasibility spike: sustained live cadence. One seeder pushes a fresh
// 2MB segment to every connected leecher each INTERVAL for DURATION -
// the difference between "moved one segment" and "keeps up with live".
// Star topology, push-to-all, no scheduling: throwaway measurement code.
//
// Run: node spikes/cadence.mjs [--n 3] [--size 2097152] [--interval 4000] [--duration 300]

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
const RELAYS = flag("relay", "").length
  ? [flag("relay", "")]
  : ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
const N = Number(flag("n", 3));
const SIZE = Number(flag("size", 2 * 1024 * 1024));
const INTERVAL = Number(flag("interval", 4000));
const DURATION_S = Number(flag("duration", 300));
const CHUNK = 16 * 1024;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const swarmId = `cadence-${randomBytes(8).toString("hex")}`;
const startedAt = Date.now();
const log = (who, msg) => console.error(`[${String(Date.now() - startedAt).padStart(6)}ms] [${who}] ${msg}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

class RelayPool {
  constructor(urls) {
    this.sockets = [];
    this.handlers = [];
    this.seen = new Set();
    this.openPromise = Promise.allSettled(
      urls.map((url) => new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => { ws.close(); reject(new Error(`${url} timed out`)); }, 8000);
        ws.addEventListener("open", () => { clearTimeout(timer); this.sockets.push(ws); resolve(ws); });
        ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`${url} failed`)); });
        ws.addEventListener("message", (m) => this.onMessage(m.data));
      })),
    ).then(() => { if (!this.sockets.length) throw new Error("no relay reachable"); });
  }
  onMessage(data) {
    let frame;
    try { frame = JSON.parse(String(data)); } catch { return; }
    if (frame[0] === "EVENT" && frame[2]) {
      const ev = frame[2];
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id);
      if (!verifyEvent(ev)) return;
      for (const h of this.handlers) h(ev);
    }
  }
  subscribe(filter) {
    const frame = JSON.stringify(["REQ", randomBytes(4).toString("hex"), filter]);
    for (const ws of this.sockets) ws.send(frame);
  }
  onEvent(h) { this.handlers.push(h); }
  publish(event) {
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
    sendSignal(to, payload) {
      pool.publish(finalizeEvent({ kind: KIND_SIGNAL, created_at: Math.floor(Date.now() / 1000), tags: [[SWARM_TAG, swarmId], ["p", to]], content: JSON.stringify(payload) }, secret));
    },
    announce(role) {
      pool.publish(finalizeEvent({ kind: KIND_PRESENCE, created_at: Math.floor(Date.now() / 1000), tags: [[SWARM_TAG, swarmId]], content: JSON.stringify({ role }) }, secret));
    },
  };
}

async function main() {
  const totalSegments = Math.floor((DURATION_S * 1000) / INTERVAL);
  log("cadence", `swarm ${swarmId}: ${N} leechers, ${SIZE}B every ${INTERVAL}ms for ${DURATION_S}s (${totalSegments} segments)`);

  // Seeder
  const seederPool = new RelayPool(RELAYS);
  await seederPool.openPromise;
  const seeder = makePeer(seederPool);
  const channels = new Map(); // leecher pubkey -> open data channel
  seederPool.onEvent(async (ev) => {
    if (ev.kind !== KIND_SIGNAL || ev.pubkey === seeder.pubkey) return;
    if (!ev.tags.some(([n, v]) => n === "p" && v === seeder.pubkey)) return;
    const payload = JSON.parse(ev.content);
    if (payload.type !== "offer" || channels.has(ev.pubkey)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    channels.set(ev.pubkey, null);
    pc.onDataChannel.subscribe((channel) => {
      channels.set(ev.pubkey, channel);
      log("seeder", `channel open for ${ev.pubkey.slice(0, 8)} (${[...channels.values()].filter(Boolean).length}/${N})`);
    });
    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    seeder.sendSignal(ev.pubkey, { type: "answer", sdp: pc.localDescription.sdp });
  });
  seederPool.subscribe({ kinds: [KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(startedAt / 1000) - 1 });
  seeder.announce("seeder");
  const presenceTimer = setInterval(() => seeder.announce("seeder"), 2000);

  // Leechers: connect once, then receive the pushed stream.
  function runLeecher(index) {
    return new Promise(async (resolve, reject) => {
      const pool = new RelayPool(RELAYS);
      await pool.openPromise;
      const me = makePeer(pool);
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const channel = pc.createDataChannel("segments");
      const segments = [];
      let current = null;
      let dialled = false;
      const timeout = setTimeout(() => reject(new Error(`leecher ${index} stalled`)), (DURATION_S + 60) * 1000);

      channel.onMessage.subscribe((message) => {
        if (typeof message === "string") {
          const p = JSON.parse(message);
          if (p.type === "segment-meta") current = { seq: p.seq, size: p.size, sha256: p.sha256, started: Date.now(), parts: [], bytes: 0 };
          else if (p.type === "segment-eof" && current && p.seq === current.seq) {
            const body = Buffer.concat(current.parts);
            const ok = body.length === current.size && sha256(body) === current.sha256;
            segments.push({ seq: current.seq, verified: ok, transferMs: Date.now() - current.started });
            current = null;
          } else if (p.type === "done") {
            clearTimeout(timeout);
            pc.close().then(() => pool.close());
            resolve({ index, segments });
          }
        } else if (current) { current.parts.push(Buffer.from(message)); current.bytes += message.length; }
      });

      pool.onEvent(async (ev) => {
        if (ev.pubkey === me.pubkey) return;
        if (ev.kind !== KIND_PRESENCE && ev.kind !== KIND_SIGNAL) return;
        let p;
        try {
          p = JSON.parse(ev.content);
        } catch {
          return; // a public swarm tag can carry malformed events; ignore them
        }
        if (ev.kind === KIND_PRESENCE && p.role === "seeder" && !dialled) {
          dialled = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          me.sendSignal(ev.pubkey, { type: "offer", sdp: pc.localDescription.sdp });
        }
        if (ev.kind === KIND_SIGNAL && p.type === "answer") {
          if (!ev.tags.some(([n, v]) => n === "p" && v === me.pubkey)) return;
          await pc.setRemoteDescription({ type: "answer", sdp: p.sdp });
        }
      });
      pool.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(Date.now() / 1000) - 1 });
    });
  }

  const leecherPromises = Array.from({ length: N }, (_, i) => runLeecher(i));

  // Wait for all channels, then push segments on the interval.
  while ([...channels.values()].filter(Boolean).length < N) await new Promise((r) => setTimeout(r, 200));
  clearInterval(presenceTimer);
  log("seeder", `all ${N} channels open, starting cadence`);

  for (let seq = 0; seq < totalSegments; seq++) {
    const tick = Date.now();
    const segment = randomBytes(SIZE);
    const hash = sha256(segment);
    for (const channel of channels.values()) {
      channel.send(JSON.stringify({ type: "segment-meta", seq, size: SIZE, sha256: hash }));
      for (let off = 0; off < SIZE; off += CHUNK) channel.send(segment.subarray(off, off + CHUNK));
      channel.send(JSON.stringify({ type: "segment-eof", seq }));
    }
    if ((seq + 1) % 15 === 0) log("seeder", `pushed segment ${seq + 1}/${totalSegments}`);
    const elapsed = Date.now() - tick;
    if (elapsed < INTERVAL && seq < totalSegments - 1) await new Promise((r) => setTimeout(r, INTERVAL - elapsed));
  }
  for (const channel of channels.values()) channel.send(JSON.stringify({ type: "done" }));

  const results = await Promise.all(leecherPromises);
  seederPool.close();

  const flat = results.flatMap((r) => r.segments);
  const transfers = flat.map((s) => s.transferMs).sort((a, b) => a - b);
  const p = (q) => transfers[Math.min(transfers.length - 1, Math.floor(q * transfers.length))];
  console.log(JSON.stringify({
    ok: flat.every((s) => s.verified) && flat.length === totalSegments * N,
    swarmId,
    leechers: N,
    segmentBytes: SIZE,
    intervalMs: INTERVAL,
    durationS: DURATION_S,
    segmentsExpectedPerLeecher: totalSegments,
    segmentsReceived: flat.length,
    allVerified: flat.every((s) => s.verified),
    deadlineHitRate: Number((flat.filter((s) => s.transferMs < INTERVAL).length / flat.length).toFixed(4)),
    transferMs: { p50: p(0.5), p95: p(0.95), max: transfers.at(-1) },
  }, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error(`FAIL: ${e.message}`); process.exit(1); });
