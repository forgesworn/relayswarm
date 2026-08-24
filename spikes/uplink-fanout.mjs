#!/usr/bin/env node
// Feasibility spike: how many leechers can one seeder on a REAL uplink serve
// per segment deadline? This is the two-machine harness for the "2-4 served
// peers per home connection" estimate - run the seeder on a home connection
// and leechers on another network (e.g. a phone hotspot), then raise N until
// transfers start missing the deadline.
//
// Deliberately NOT the swarm engine: no scheduling, no backpressure tuning,
// no fallback. One seeder, star topology, same wire protocol as fanout.mjs,
// split into two modes so the sides can run on different machines.
//
// Seeder (machine A, home connection):
//   node spikes/uplink-fanout.mjs --mode seeder --swarm my-test-1
// Leechers (machine B, other network; repeat for N peers):
//   node spikes/uplink-fanout.mjs --mode leecher --swarm my-test-1 --label laptop-b
//
// Leechers print one JSON receipt each (stdout); the seeder prints a JSON
// summary on Ctrl-C or --duration expiry. Default relay is the private one
// per spike policy; pass --relay to use another.

import { RTCPeerConnection } from "werift";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const KIND_PRESENCE = 24170;
const KIND_SIGNAL = 24171;
const SWARM_TAG = "x";
const MODE = flag("mode", "");
const RELAY = flag("relay", "wss://relay.trotters.cc");
const SEGMENT_SIZE = Number(flag("size", 2 * 1024 * 1024));
const DEADLINE_MS = Number(flag("deadline", 4000));
const DURATION_S = Number(flag("duration", 0)); // seeder only; 0 = until Ctrl-C
const TIMEOUT_S = Number(flag("timeout", 120)); // leecher only
const LABEL = flag("label", hostname());
const CHUNK_SIZE = 16 * 1024;
const ICE_SERVERS = [{ urls: flag("stun", "stun:stun.l.google.com:19302") }];

const swarmId = flag("swarm", "");
if (!MODE || !swarmId) {
  console.error("usage: --mode seeder|leecher --swarm <shared-id> [--relay wss://...] [--size N] [--deadline ms] [--duration s] [--timeout s] [--label name]");
  process.exit(2);
}

const startedAt = Date.now();
const log = (who, msg) => console.error(`[${String(Date.now() - startedAt).padStart(6)}ms] [${who}] ${msg}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Candidate TYPES only (e.g. {local: "srflx", remote: "srflx"}) - proof of
// the path the media took, without recording a single address in a receipt.
function icePairTypes(pc) {
  try {
    const transport = pc.iceTransport ?? pc.sctpTransport?.dtlsTransport?.iceTransport;
    const pair = transport?.connection?.nominated;
    if (!pair) return null;
    return { local: pair.localCandidate?.type ?? null, remote: pair.remoteCandidate?.type ?? null };
  } catch {
    return null;
  }
}

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

async function runSeeder() {
  const segment = randomBytes(SEGMENT_SIZE);
  const segmentHash = sha256(segment);
  const pool = new RelayPool([RELAY], "seeder");
  await pool.openPromise;
  const seeder = makePeer(pool);
  log("seeder", `swarm ${swarmId}, serving ${SEGMENT_SIZE} bytes via ${RELAY}; Ctrl-C to stop and summarise`);

  const pcs = new Map(); // leecher pubkey -> pc
  const served = []; // { peer, serveMs, bytes }
  pool.onEvent(async (event) => {
    if (event.kind !== KIND_SIGNAL) return;
    if (event.pubkey === seeder.pubkey) return;
    if (!event.tags.some(([n, v]) => n === "p" && v === seeder.pubkey)) return;
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
        const t0 = Date.now();
        channel.send(JSON.stringify({ type: "meta", size: segment.length, sha256: segmentHash }));
        for (let off = 0; off < segment.length; off += CHUNK_SIZE) {
          channel.send(segment.subarray(off, off + CHUNK_SIZE));
        }
        channel.send(JSON.stringify({ type: "eof" }));
        const serveMs = Date.now() - t0;
        served.push({ peer: event.pubkey.slice(0, 8), serveMs, bytes: segment.length });
        log("seeder", `served ${event.pubkey.slice(0, 8)} in ${serveMs}ms (${served.length} total, ${pcs.size} connected)`);
      });
    });
    await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    seeder.sendSignal(event.pubkey, { type: "answer", sdp: pc.localDescription.sdp });
  });
  pool.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(Date.now() / 1000) - 1 });
  seeder.announcePresence("seeder");
  const presenceTimer = setInterval(() => seeder.announcePresence("seeder"), 2000);

  const summary = () => {
    clearInterval(presenceTimer);
    console.log(JSON.stringify({
      mode: "seeder", swarm: swarmId, relay: RELAY, segmentBytes: SEGMENT_SIZE,
      connectedPeers: pcs.size, servedCount: served.length, served,
      wallMs: Date.now() - startedAt,
    }, null, 2));
    pool.close();
    process.exit(0);
  };
  process.on("SIGINT", summary);
  if (DURATION_S > 0) setTimeout(summary, DURATION_S * 1000);
}

async function runLeecher() {
  const pool = new RelayPool([RELAY], "leecher");
  await pool.openPromise;
  const me = makePeer(pool);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const channel = pc.createDataChannel("segments");
  const marks = {};
  const mark = (name) => { marks[name] = Date.now() - startedAt; };

  const finish = (receipt, code) => {
    console.log(JSON.stringify(receipt, null, 2));
    pool.close();
    process.exit(code);
  };
  const timeout = setTimeout(() => {
    finish({ ok: false, mode: "leecher", label: LABEL, swarm: swarmId, error: `timed out after ${TIMEOUT_S}s`, marks }, 1);
  }, TIMEOUT_S * 1000);

  let meta = null;
  const received = [];
  channel.stateChanged.subscribe((state) => {
    if (state === "open") {
      mark("channelOpen");
      channel.send("want-segment");
      mark("requestSent");
    }
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
        mark("transferStarted");
      } else if (payload.type === "eof") {
        mark("transferComplete");
        clearTimeout(timeout);
        const body = Buffer.concat(received);
        const hash = sha256(body);
        const ok = meta && body.length === meta.size && hash === meta.sha256;
        const transferMs = marks.transferComplete - marks.transferStarted;
        finish({
          ok, mode: "leecher", label: LABEL, swarm: swarmId, relay: RELAY,
          segmentBytes: body.length, sha256Verified: ok,
          timingsMs: { seederDiscovered: marks.seederDiscovered, channelOpen: marks.channelOpen, transfer: transferMs },
          throughputMBps: Number((body.length / 1048576 / (transferMs / 1000)).toFixed(2)),
          deadlineMs: DEADLINE_MS,
          deadlineHit: ok && transferMs <= DEADLINE_MS,
          deadlineHit6s: ok && transferMs <= 6000,
          pair: icePairTypes(pc),
          endToEndMs: marks.transferComplete,
        }, ok ? 0 : 1);
      }
    } else {
      received.push(Buffer.from(message));
    }
  });

  let dialled = false;
  pool.onEvent(async (event) => {
    if (event.pubkey === me.pubkey) return;
    if (event.kind !== KIND_PRESENCE && event.kind !== KIND_SIGNAL) return;
    let payload;
    try {
      payload = JSON.parse(event.content);
    } catch {
      return;
    }
    if (event.kind === KIND_PRESENCE && payload.role === "seeder" && !dialled) {
      dialled = true;
      mark("seederDiscovered");
      log("leecher", `seeder ${event.pubkey.slice(0, 8)} discovered, offering`);
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
  pool.subscribe({ kinds: [KIND_PRESENCE, KIND_SIGNAL], [`#${SWARM_TAG}`]: [swarmId], since: Math.floor(Date.now() / 1000) - 1 });
  log("leecher", `swarm ${swarmId}, waiting for seeder via ${RELAY} (deadline ${DEADLINE_MS}ms)`);
}

try {
  if (MODE === "seeder") await runSeeder();
  else if (MODE === "leecher") await runLeecher();
  else {
    console.error(`unknown --mode ${MODE}`);
    process.exit(2);
  }
} catch (error) {
  console.error(`fatal: ${error.message}`);
  process.exit(1);
}
