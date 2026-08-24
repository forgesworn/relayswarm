#!/usr/bin/env node
// Feasibility spike: one seeder, N leechers, star topology, over public
// Nostr relays. Answers: does relay signalling hold up when N peers arrive
// at once, and does one uploader survive N simultaneous transfers?
//
// Deliberately NOT the swarm engine: no scheduling, no segment assignment,
// no choke/unchoke, no fallback. Throwaway measurement code.
//
// Run: node spikes/fanout.mjs [--n 5] [--size 2097152] [--stagger 400]

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
const N = Number(flag("n", 5));
const SEGMENT_SIZE = Number(flag("size", 2 * 1024 * 1024));
const STAGGER_MS = Number(flag("stagger", 400));
const CHUNK_SIZE = 16 * 1024;
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const swarmId = `fanout-${randomBytes(8).toString("hex")}`;
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
    this.published = 0; // unique signed events this pool created
    this.writes = 0; // event frames sent (published x connected relays)
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

async function main() {
  log("fanout", `swarm ${swarmId}, ${N} leechers, ${SEGMENT_SIZE} bytes each, stagger ${STAGGER_MS}ms`);
  const segment = randomBytes(SEGMENT_SIZE);
  const segmentHash = sha256(segment);

  // ---- Seeder: one pool, one pc per leecher ------------------------------
  const seederPool = new RelayPool(RELAYS, "seeder");
  await seederPool.openPromise;
  const seeder = makePeer(seederPool);
  const seederPcs = new Map(); // leecher pubkey -> pc
  let bytesOut = 0;
  let transfersServed = 0;

  seederPool.onEvent(async (event) => {
    if (event.kind !== KIND_SIGNAL) return;
    if (event.pubkey === seeder.pubkey) return;
    if (!event.tags.some(([n, v]) => n === "p" && v === seeder.pubkey)) return;
    const payload = JSON.parse(event.content);
    if (payload.type !== "offer" || seederPcs.has(event.pubkey)) return;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    seederPcs.set(event.pubkey, pc);
    pc.onDataChannel.subscribe((channel) => {
      channel.onMessage.subscribe((message) => {
        if ((typeof message === "string" ? message : "") !== "want-segment") return;
        channel.send(JSON.stringify({ type: "meta", size: segment.length, sha256: segmentHash }));
        for (let off = 0; off < segment.length; off += CHUNK_SIZE) {
          channel.send(segment.subarray(off, off + CHUNK_SIZE));
          bytesOut += Math.min(CHUNK_SIZE, segment.length - off);
        }
        channel.send(JSON.stringify({ type: "eof" }));
        transfersServed += 1;
        log("seeder", `served leecher ${event.pubkey.slice(0, 8)} (${transfersServed}/${N})`);
      });
    });
    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    seeder.sendSignal(event.pubkey, { type: "answer", sdp: pc.localDescription.sdp });
  });

  seeder.announcePresence("seeder");
  const presenceTimer = setInterval(() => seeder.announcePresence("seeder"), 2000);

  // ---- Leechers: staggered arrivals --------------------------------------
  async function runLeecher(index) {
    const t0 = Date.now();
    const marks = {};
    const mark = (name) => { marks[name] = Date.now() - t0; };
    const pool = new RelayPool(RELAYS, `leecher${index}`);
    await pool.openPromise;
    mark("relaysConnected");
    const me = makePeer(pool);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = pc.createDataChannel("segments");
    const received = [];
    let meta = null;

    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`leecher ${index} timed out`)), 90_000);
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
            const ok = meta && body.length === meta.size && sha256(body) === meta.sha256;
            clearTimeout(timeout);
            if (ok) resolve({ verified: true });
            else reject(new Error(`leecher ${index} hash mismatch`));
          }
        } else received.push(Buffer.from(message));
      });
    });

    let dialled = false;
    pool.onEvent(async (event) => {
      if (event.pubkey === me.pubkey) return;
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
    pool.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(t0 / 1000) - 1 });

    try {
      await result;
      mark("done");
      return {
        index,
        verified: true,
        signallingMs: marks.channelOpen - marks.seederDiscovered,
        transferMs: marks.transferComplete - marks.transferStarted,
        throughputMBps: Number((SEGMENT_SIZE / 1024 / 1024 / ((marks.transferComplete - marks.transferStarted) / 1000)).toFixed(2)),
        endToEndMs: marks.done,
        eventsPublished: pool.published,
        relayWrites: pool.writes,
        marks,
      };
    } finally {
      await pc.close();
      pool.close();
    }
  }

  const seederSince = Math.floor(Date.now() / 1000) - 1;
  seederPool.subscribe({ kinds: [KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: seederSince });

  const wallStart = Date.now();
  const leechers = [];
  for (let i = 0; i < N; i++) {
    leechers.push(runLeecher(i));
    await sleep(STAGGER_MS);
  }
  const settled = await Promise.allSettled(leechers);
  const wallMs = Date.now() - wallStart;
  clearInterval(presenceTimer);
  for (const pc of seederPcs.values()) await pc.close();
  seederPool.close();

  const succeeded = settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
  const failed = settled.filter((s) => s.status === "rejected").map((s) => s.reason?.message);
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  console.log(JSON.stringify({
    ok: failed.length === 0,
    swarmId,
    relays: RELAYS,
    leechers: N,
    segmentBytes: SEGMENT_SIZE,
    staggerMs: STAGGER_MS,
    wallMs,
    seeder: { transfersServed, bytesOut, eventsPublished: seederPool.published, relayWrites: seederPool.writes },
    signalling: {
      // unique signed events vs frames written; leecher offers counted per pool
      seederEventsPublished: seederPool.published,
      leecherEventsPublished: succeeded.reduce((a, l) => a + l.eventsPublished, 0),
      uniqueEventsTotal: seederPool.published + succeeded.reduce((a, l) => a + l.eventsPublished, 0),
      relayWritesTotal: seederPool.writes + succeeded.reduce((a, l) => a + l.relayWrites, 0),
    },
    perLeecher: succeeded,
    failures: failed,
    aggregate: {
      succeeded: succeeded.length,
      avgSignallingMs: avg(succeeded.map((l) => l.signallingMs)),
      avgTransferMs: avg(succeeded.map((l) => l.transferMs)),
      avgThroughputMBps: succeeded.length ? Number((succeeded.reduce((a, l) => a + l.throughputMBps, 0) / succeeded.length).toFixed(2)) : null,
      aggregateSeederMBps: Number((bytesOut / 1024 / 1024 / (wallMs / 1000)).toFixed(2)),
    },
  }, null, 2));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => { console.error(`FAIL: ${error.message}`); process.exit(1); });
