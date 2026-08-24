#!/usr/bin/env node
// Standalone Node seeder (werift) for browser interop tests: seeds one swarm
// id, serves any number of leechers, exits after --ttl seconds.
// Run: node spikes/seeder.mjs --swarm <id> [--size 2097152] [--ttl 120]

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
const SWARM = flag("swarm", "");
const SIZE = Number(flag("size", 2 * 1024 * 1024));
const TTL_S = Number(flag("ttl", 120));
const CHUNK = 16 * 1024;
if (!SWARM) { console.error("--swarm required"); process.exit(2); }

const t0 = Date.now();
const log = (msg) => console.error(`[${String(Date.now() - t0).padStart(6)}ms] [seeder] ${msg}`);
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const segment = randomBytes(SIZE);
const segmentHash = sha256(segment);
const secret = generateSecretKey();
const pubkey = getPublicKey(secret);

const sockets = [];
const handlers = [];
const seen = new Set();
await Promise.allSettled(RELAYS.map((url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  const timer = setTimeout(() => { ws.close(); reject(); }, 8000);
  ws.addEventListener("open", () => { clearTimeout(timer); sockets.push(ws); log(`connected ${url}`); resolve(); });
  ws.addEventListener("error", () => { clearTimeout(timer); reject(); });
  ws.addEventListener("message", (m) => {
    let frame; try { frame = JSON.parse(String(m.data)); } catch { return; }
    if (frame[0] === "EVENT" && frame[2]) {
      const ev = frame[2];
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      if (!verifyEvent(ev)) return;
      for (const h of handlers) h(ev);
    }
  });
})));
if (!sockets.length) { console.error("FAIL: no relay reachable"); process.exit(1); }

const publish = (kind, tags, content) => {
  const ev = finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), tags, content }, secret);
  const frame = JSON.stringify(["EVENT", ev]);
  for (const ws of sockets) ws.send(frame);
};
const frame = JSON.stringify(["REQ", randomBytes(4).toString("hex"), { kinds: [KIND_SIGNAL], [`#${SWARM_TAG}`]: [SWARM], since: Math.floor(t0 / 1000) - 1 }]);
for (const ws of sockets) ws.send(frame);

const pcs = new Map();
let served = 0;
handlers.push(async (ev) => {
  if (ev.pubkey === pubkey || ev.kind !== KIND_SIGNAL) return;
  if (!ev.tags.some(([n, v]) => n === "p" && v === pubkey)) return;
  let payload;
  try {
    payload = JSON.parse(ev.content);
  } catch {
    return; // a public swarm tag can carry malformed events; ignore them
  }
  if (payload.type !== "offer" || pcs.has(ev.pubkey)) return;
  log(`offer from ${ev.pubkey.slice(0, 8)}, answering`);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  pcs.set(ev.pubkey, pc);
  pc.onDataChannel.subscribe((channel) => {
    channel.onMessage.subscribe((message) => {
      if ((typeof message === "string" ? message : "") !== "want-segment") return;
      channel.send(JSON.stringify({ type: "meta", size: segment.length, sha256: segmentHash }));
      for (let off = 0; off < segment.length; off += CHUNK) channel.send(segment.subarray(off, off + CHUNK));
      channel.send(JSON.stringify({ type: "eof" }));
      served += 1;
      log(`served ${ev.pubkey.slice(0, 8)} (total ${served})`);
    });
  });
  await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  publish(KIND_SIGNAL, [[SWARM_TAG, SWARM], ["p", ev.pubkey]], JSON.stringify({ type: "answer", sdp: pc.localDescription.sdp }));
});

publish(KIND_PRESENCE, [[SWARM_TAG, SWARM]], JSON.stringify({ role: "seeder" }));
const presenceTimer = setInterval(() => publish(KIND_PRESENCE, [[SWARM_TAG, SWARM]], JSON.stringify({ role: "seeder" })), 2000);
log(`seeding swarm ${SWARM}, ${SIZE} bytes, ttl ${TTL_S}s`);

setTimeout(async () => {
  clearInterval(presenceTimer);
  for (const pc of pcs.values()) await pc.close();
  for (const ws of sockets) ws.close();
  console.log(JSON.stringify({ swarm: SWARM, served }));
  process.exit(0);
}, TTL_S * 1000);
