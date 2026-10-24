#!/usr/bin/env node
// Local micro-benchmarks for the paths a performance change most often
// touches: a peer link moving one object, per-segment commitment checks,
// multi-holder piece hashing and the native object receiver. Everything runs
// in memory: no network, browser or relay. Timings depend on the machine, so
// compare runs on one host before and after a change, not across hosts.
//
//   node scripts/bench-hot-paths.mjs [--core path/to/relayswarm-core.wasm] [--json]

import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { PeerLink } from "../src/browser/peer-link.mjs";
import { loadCore } from "../src/browser/core-wasm.mjs";
import { commitmentContent, commitmentPieceSize, verifySegmentCommitment, KIND_SEGMENT_COMMITMENT } from "../src/browser/segment-commitment.mjs";
import { encodeFrame, FRAME, requestObject } from "../src/object-transfer.mjs";
import { createCommitmentDelegation, createCommitmentRevocation } from "../src/publisher-state.mjs";

const option = (name) => { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : undefined; };
const corePath = option("--core") ?? new URL("../src/browser/relayswarm-core.wasm", import.meta.url);
const compiled = await WebAssembly.compile(await readFile(corePath));
const MiB = 1024 * 1024;
const median = (values) => [...values].sort((a, b) => a - b)[values.length >> 1];
const round = (value, places = 2) => Number(value.toFixed(places));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function timed(runs, warm, body) {
  for (let index = 0; index < warm; index++) await body(index);
  const times = [];
  for (let index = 0; index < runs; index++) {
    const started = performance.now();
    await body(index);
    times.push(performance.now() - started);
  }
  return round(median(times));
}

// Two ends of an ordered, reliable data channel. Sends are copied and
// delivered on a later microtask, and the buffered amount drains as they are.
class ChannelEnd extends EventTarget {
  readyState = "open"; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
  bufferedAmount = 0; bufferedAmountLowThreshold = 0; binaryType = "arraybuffer"; peer = null;
  send(data) {
    // A browser copies what is sent; Buffer#slice would only make a view.
    const copy = typeof data === "string" ? data : Uint8Array.prototype.slice.call(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).buffer;
    const size = typeof data === "string" ? 0 : data.byteLength;
    this.bufferedAmount += size;
    queueMicrotask(() => {
      const before = this.bufferedAmount;
      this.bufferedAmount -= size;
      if (size && before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event("bufferedamountlow"));
      this.peer.dispatchEvent(new MessageEvent("message", { data: copy }));
    });
  }
  close() { if (this.readyState !== "closed") { this.readyState = "closed"; this.dispatchEvent(new Event("close")); } }
}
class Connection extends EventTarget { close() {} }

/** One object over a link pair, requester and holder on the same thread. */
async function linkTransfer(kind, size) {
  const core = kind === "wasm" ? await loadCore(compiled) : null;
  const create = core ? (options) => core.peerLink(options) : (options) => new PeerLink(options);
  const object = randomBytes(size), key = sha256(object), near = new ChannelEnd(), far = new ChannelEnd();
  near.peer = far; far.peer = near;
  const base = { pubkey: "bench", pc: new Connection(), maxSegmentBytes: 16 * MiB };
  const requester = create({ ...base, channel: near });
  const holder = create({ ...base, channel: far, onRequest: () => object });
  const ms = await timed(30, 5, async () => {
    const bytes = await requester.request(key, 60_000, { expectedSize: size });
    if (bytes?.byteLength !== size) throw new Error(`${kind} link transfer failed.`);
  });
  requester.close(); holder.close();
  return ms;
}

/** Per-segment verification: one stream event, a fresh commitment each call.
 * `delegated` signs with a delegate key and supplies four revocations of
 * other delegations, each of which the verifier must check. */
async function verification(verify, { delegated = false } = {}) {
  const secretKey = generateSecretKey(), swarmId = "bench-swarm-0001", at = Date.now(), seconds = Math.floor(at / 1000);
  const streamEvent = finalizeEvent({ kind: 30311, created_at: seconds - 60, content: "bench",
    tags: [["d", "bench"], ["relayswarm", "redistribute", "1"]] }, secretKey);
  const delegateKey = generateSecretKey(), trust = {};
  if (delegated) {
    const delegate = (delegatePubkey) => createCommitmentDelegation({ secretKey, streamEvent, swarmId, delegatePubkey, renditions: ["0"] });
    trust.delegation = delegate(getPublicKey(delegateKey));
    trust.delegationRevocations = Array.from({ length: 4 }, () =>
      createCommitmentRevocation({ secretKey, streamEvent, swarmId, delegation: delegate(getPublicKey(generateSecretKey())) }));
  }
  const segments = Array.from({ length: 60 }, (_, sequence) => {
    const fields = { streamEventId: streamEvent.id, swarmId, key: sha256(`segment-${sequence}`), rendition: "0", sequence,
      discontinuity: 0, part: null, sha256: sha256(`bytes-${sequence}`), size: 1_000_000, expiresAt: seconds + 60 };
    const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds, content: commitmentContent(fields),
      tags: [["x", swarmId], ["e", streamEvent.id], ...(delegated ? [["delegation", trust.delegation.id]] : [])] }, delegated ? delegateKey : secretKey);
    return { event, options: { streamEvent, swarmId, key: fields.key, maxSegmentBytes: 16 * MiB, context: { frag: { sn: sequence, cc: 0, level: 0 } }, ...trust } };
  });
  const times = [];
  for (const { event, options } of segments) {
    const started = performance.now();
    if (!verify(event, options, at)) throw new Error("A benchmark commitment was rejected.");
    times.push(performance.now() - started);
  }
  return round(median(times.slice(10)), 3);
}

/** The core's multi-holder transfer: hashing per delivered range and the final object check. */
async function pieceHashing(size) {
  const core = await loadCore(compiled), object = randomBytes(size), pieceSize = commitmentPieceSize(size), pieces = [];
  for (let at = 0; at < size; at += pieceSize) pieces.push(sha256(object.subarray(at, at + pieceSize)));
  const ranges = [], finals = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const transfer = core.transfer({ size, sha256: sha256(object), pieces, deadline: 1e12, maxHolders: 3, originReserveMs: 0 });
    const queue = transfer.start(1_000, { peers: [[1, 10, 1_000], [2, 10, 1_000], [3, 10, 1_000]], origin: [10, 10] }).commands.filter((command) => command.t === "request");
    let finished = false, now = 1_001;
    while (queue.length && !finished) {
      const { peer, range } = queue.shift(), bytes = object.subarray(range.start * pieceSize, Math.min(range.end * pieceSize, size));
      const started = performance.now(), state = transfer.delivered(now++, peer, range, bytes), elapsed = performance.now() - started;
      if (state.bytes) { finals.push(elapsed); finished = true; } else ranges.push(elapsed / (bytes.byteLength / MiB));
      queue.push(...state.commands.filter((command) => command.t === "request"));
    }
    transfer.free();
    if (!finished) throw new Error("The benchmark transfer did not finish.");
  }
  return { rangeMsPerMiB: round(median(ranges)), finalDeliveryMs: round(median(finals)) };
}

/** requestObject over an in-memory stream, delivered in `readBytes` pieces. */
async function nativeReceive(size, readBytes) {
  const object = randomBytes(size), digest = sha256(object), frames = [encodeFrame(FRAME.META, JSON.stringify({ sha256: digest, size }))];
  for (let at = 0; at < size; at += 64 * 1024) frames.push(encodeFrame(FRAME.CHUNK, object.subarray(at, at + 64 * 1024)));
  frames.push(encodeFrame(FRAME.EOF));
  const wire = Buffer.concat(frames);
  return timed(10, 2, async () => {
    const stream = new Duplex({ read() {}, write(_chunk, _encoding, done) {
      done();
      queueMicrotask(() => { for (let at = 0; at < wire.length; at += readBytes) this.push(wire.subarray(at, at + readBytes)); });
    } });
    const bytes = await requestObject(stream, { requestId: "bench-request", sha256: digest, size });
    if (bytes.length !== size) throw new Error("Native receive failed.");
  });
}

const wasm = await loadCore(compiled);
const results = {
  node: process.version,
  linkTransfer4MiBMs: { js: await linkTransfer("js", 4 * MiB), wasm: await linkTransfer("wasm", 4 * MiB) },
  verifyPerSegmentMs: { js: await verification(verifySegmentCommitment), wasm: await verification(wasm.verifier.verifySegmentCommitment) },
  verifyDelegatedPerSegmentMs: { js: await verification(verifySegmentCommitment, { delegated: true }),
    wasm: await verification(wasm.verifier.verifySegmentCommitment, { delegated: true }) },
  multiHolder4MiB: await pieceHashing(4 * MiB),
  nativeReceive16MiBMs: { smallReads: await nativeReceive(16 * MiB, 1452), wholeFrames: await nativeReceive(16 * MiB, 64 * 1024 + 8) },
};
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
else {
  const lines = [
    `Node ${results.node}`,
    `Peer link, 4 MiB object:            JS ${results.linkTransfer4MiBMs.js} ms, WASM ${results.linkTransfer4MiBMs.wasm} ms`,
    `Commitment check per segment:       JS ${results.verifyPerSegmentMs.js} ms, WASM ${results.verifyPerSegmentMs.wasm} ms`,
    `  delegated, four revocations:      JS ${results.verifyDelegatedPerSegmentMs.js} ms, WASM ${results.verifyDelegatedPerSegmentMs.wasm} ms`,
    `Multi-holder piece hashing:         ${results.multiHolder4MiB.rangeMsPerMiB} ms/MiB, final 4 MiB check ${results.multiHolder4MiB.finalDeliveryMs} ms`,
    `Native receive, 16 MiB:             ${results.nativeReceive16MiBMs.smallReads} ms in 1,452-byte reads, ${results.nativeReceive16MiBMs.wholeFrames} ms in whole frames`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}
