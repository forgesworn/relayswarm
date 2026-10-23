// The Rust multi-holder Transfer and framing 2 through the WebAssembly
// module: ranged requests between real core links over in-memory channels,
// with the module's scheduler deciding who sends which pieces.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadCore } from "../src/browser/core-wasm.mjs";
import { commitmentPieceSize } from "../src/browser/segment-commitment.mjs";
import { stubCore } from "./core-stub.mjs";

const path = process.env.RELAYSWARM_CORE_WASM
  ? resolve(process.env.RELAYSWARM_CORE_WASM) : new URL("../src/browser/relayswarm-core.wasm", import.meta.url);
const compiled = await WebAssembly.compile(await readFile(path));
const KEY = "b".repeat(64);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

class Channel extends EventTarget {
  readyState = "open";
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  bufferedAmount = 0;
  peer = null;
  send(data) {
    const copy = typeof data === "string" ? data : data.slice(0);
    queueMicrotask(() => this.peer?.dispatchEvent(new MessageEvent("message", { data: copy })));
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}
class PC extends EventTarget { close() { this.closed = true; } }

function object(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 17) % 251;
  return bytes;
}
function commitment(bytes) {
  const pieceSize = commitmentPieceSize(bytes.length), pieces = [];
  for (let at = 0; at < bytes.length; at += pieceSize) pieces.push(digest(bytes.subarray(at, at + pieceSize)));
  return { size: bytes.length, sha256: digest(bytes), pieces, pieceSize };
}

/** A requesting link wired to a holder link that serves `serve(key)`. */
function pair(core, serve) {
  const near = new Channel(), far = new Channel();
  near.peer = far; far.peer = near;
  const requester = core.peerLink({ pubkey: "holder", channel: near, pc: new PC(), maxSegmentBytes: 1 << 24 });
  core.peerLink({ pubkey: "viewer", channel: far, pc: new PC(), maxSegmentBytes: 1 << 24, onRequest: async (_link, key) => serve(key) });
  return requester;
}

/** Carry out a transfer's commands until it delivers or fails. */
async function drive(transfer, state, { links, origin, now = 1_000 }) {
  const log = [];
  let delivered = null, failed = false;
  const queue = [state];
  while (queue.length) {
    const current = queue.shift();
    assert.ok(current, "the module did not fail");
    for (const command of current.commands) {
      log.push(command.t === "request" ? `${command.t}:${command.peer}:${command.p}` : command.t === "origin" ? `origin:${command.p}` : `${command.t}${command.peer ?? ""}`);
      if (command.t === "deliver") delivered = current.bytes;
      if (command.t === "fail") failed = true;
      if (command.t === "request") {
        const { start, end } = command.range;
        const bytes = await links.get(command.peer).request(KEY, 5_000, { range: { start, end, objectSize: transfer.size }, expectedSize: transfer.rangeBytes(command.range) });
        queue.push(bytes ? transfer.core.delivered(now, command.peer, command.range, bytes) : transfer.core.failed(now, command.peer));
      }
      if (command.t === "origin") queue.push(transfer.core.delivered(now, "origin", command.range, origin(command.range)));
    }
  }
  return { log, delivered, failed };
}

function setup(core, bytes, options = {}) {
  const c = commitment(bytes);
  const handle = core.transfer({ size: c.size, sha256: c.sha256, pieces: c.pieces, deadline: 1_000 + 10_000, maxHolders: 3, originReserveMs: 2_000, ...options });
  assert.ok(handle, "the module has a scheduler");
  const rangeBytes = ({ start, end }) => Math.min(end * c.pieceSize, c.size) - start * c.pieceSize;
  const slice = ({ start, end }) => bytes.slice(start * c.pieceSize, Math.min(end * c.pieceSize, c.size));
  return { transfer: { core: handle, size: c.size, rangeBytes }, slice };
}

test("two holders and the module's scheduler deliver a verified object over ranged requests", async () => {
  const failures = [], core = await loadCore(compiled, { onFailure: (error) => failures.push(error) });
  const bytes = object(5 * 65_536 + 1_000);
  const { transfer, slice } = setup(core, bytes);
  const links = new Map([[1, pair(core, () => bytes)], [2, pair(core, () => bytes)]]);
  const state = transfer.core.start(1_000, { peers: [[1, 50, 200], [2, 50, 200]], origin: [100, 500] });
  const { log, delivered } = await drive(transfer, state, { links, origin: slice });
  assert.ok(log.some((entry) => entry.startsWith("request:1:")) && log.some((entry) => entry.startsWith("request:2:")), log.join(" "));
  assert.ok(!log.some((entry) => entry.startsWith("origin:")), "origin is not needed on time");
  assert.deepEqual(delivered, bytes);
  assert.deepEqual(failures, []);
  transfer.core.free();
});

test("a holder serving altered bytes is banned and its pieces come from the other holder", async () => {
  const core = await loadCore(compiled);
  const bytes = object(4 * 65_536), altered = bytes.slice();
  altered[3 * 65_536 + 5] ^= 0xff;
  const { transfer, slice } = setup(core, bytes);
  const links = new Map([[1, pair(core, () => bytes)], [2, pair(core, () => altered)]]);
  const state = transfer.core.start(1_000, { peers: [[1, 50, 200], [2, 50, 200]], origin: [100, 500] });
  const { log, delivered } = await drive(transfer, state, { links, origin: slice });
  assert.ok(log.includes("ban2"), log.join(" "));
  assert.deepEqual(delivered, bytes);
});

test("peers that would be late hand the tail to a ranged origin fetch", async () => {
  const core = await loadCore(compiled);
  const bytes = object(675_108);
  const { transfer, slice } = setup(core, bytes, { deadline: 1_000 + 1_860 + 2_000 });
  const links = new Map([[1, pair(core, () => bytes)]]);
  const state = transfer.core.start(1_000, { peers: [[1, 700, 190]], origin: [150, 1_000] });
  assert.equal(state.late, false);
  const { log, delivered } = await drive(transfer, state, { links, origin: slice });
  const last = commitment(bytes).pieces.length;
  assert.ok(log.some((entry) => entry.startsWith("origin:") && entry.endsWith(`,${last}`)), log.join(" "));
  assert.deepEqual(delivered, bytes);
});

test("progress too slow for the floor abandons the peer and moves its pieces", async () => {
  const core = await loadCore(compiled);
  const bytes = object(6 * 65_536);
  const { transfer } = setup(core, bytes, { deadline: 1_000 + 4_000 });
  const state = transfer.core.start(1_000, { peers: [[1, null, 200], [2, null, 200]], origin: [100, 500], sharedFirstByteMs: 50 });
  const slow = state.commands.find((command) => command.t === "request" && command.peer === 2);
  assert.ok(slow, JSON.stringify(state.commands));
  const commands = [];
  for (const [at, received] of [[1_050, 1_000], [1_300, 2_000], [1_500, 3_000]]) commands.push(...transfer.core.progress(at, 2, received).commands);
  assert.ok(commands.some((command) => command.t === "abandon" && command.peer === 2), JSON.stringify(commands));
  assert.ok(!commands.some((command) => command.t === "request" && command.peer === 2), "no more work for the slow peer");
  transfer.core.free();
});

test("a module without a scheduler offers no transfer", async () => {
  const core = await loadCore(await WebAssembly.compile(stubCore([])));
  assert.equal(core.transfer({ size: 1, sha256: "a".repeat(64), pieces: ["a".repeat(64)], deadline: 1, maxHolders: 3, originReserveMs: 0 }), null);
});

test("pieces that do not fit the size are refused", async () => {
  const core = await loadCore(compiled);
  assert.equal(core.transfer({ size: 200_000, sha256: "a".repeat(64), pieces: ["a".repeat(64)], deadline: 1, maxHolders: 3, originReserveMs: 0 }), null);
});
