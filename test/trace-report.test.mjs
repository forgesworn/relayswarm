// scripts/trace-report.mjs against a trace recorded here through the
// committed module, in the loader's row format.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadCore } from "../src/browser/core-wasm.mjs";
import { measure, replay, report, traceSets, transfers } from "../scripts/trace-report.mjs";

const core = await loadCore(await WebAssembly.compile(await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url))));
const PIECE = 65_536, SIZE = 6 * PIECE + 1_000;

// One transfer, two holders and origin, answered at fixed delays. Rows are
// written exactly as the loader writes them.
function recordTrace() {
  const object = Uint8Array.from({ length: SIZE }, (_, i) => (i * 7 + 1) & 255);
  const pieces = [];
  for (let at = 0; at < SIZE; at += PIECE) pieces.push(createHash("sha256").update(object.subarray(at, at + PIECE)).digest("hex"));
  const deadline = 4_000;
  const transfer = core.transfer({ size: SIZE, sha256: createHash("sha256").update(object).digest("hex"), pieces, deadline, maxHolders: 3, originReserveMs: 0 });
  const rows = [{ k: "load", load: 1, at: 0, budgetMs: 1_500, budgetGeometry: { currentTime: 8, bufferedEnd: 12 } }];
  const queue = [];
  const delay = { 1: 40, 2: 90, origin: 30 };
  const record = (op, at, input, state) => {
    rows.push({ k: "xfer", load: 1, op, at, ...input, out: { c: state.commands.map(({ t, peer, p }) => ({ t, ...(peer !== undefined ? { peer } : {}), ...(p ? { p: [...p] } : {}) })),
      next: state.next, late: state.late, finished: state.finished } });
    for (const command of state.commands) {
      if (command.t === "request" || command.t === "origin") queue.push({ at: at + delay[command.peer ?? "origin"], source: command.peer ?? "origin", p: command.p });
    }
  };
  const estimates = { peers: [[1, null, 1_000], [2, null, null]], origin: [null, 500], sharedFirstByteMs: 20, sharedRate: 1_000 };
  record("start", 10, { size: SIZE, pieces: pieces.length, pieceSize: PIECE, deadline, maxHolders: 3, originReserveMs: 0, ...estimates, holders: [[1, 5], [2, 6]] },
    transfer.start(10, estimates));
  while (queue.length) {
    queue.sort((a, b) => a.at - b.at);
    const { at, source, p } = queue.shift();
    if (source !== "origin") record("progress", at - 5, { source, received: 1 }, transfer.progress(at - 5, source, 1));
    const bytes = object.slice(p[0] * PIECE, Math.min(p[1] * PIECE, SIZE));
    const state = transfer.delivered(at, source, { start: p[0], end: p[1] }, bytes);
    record("delivered", at, { source, p, bytes: bytes.byteLength }, state);
    if (state.finished) break;
  }
  transfer.free();
  return { v: 1, capacity: 4_096, dropped: 0, rows };
}

test("traces are found in receipts, bare traces and lists", () => {
  const trace = recordTrace();
  assert.equal(traceSets(trace).length, 1);
  assert.equal(traceSets({ viewers: [{ viewer: 0 }, { viewer: 1, trace }, { viewer: 2, trace: { ...trace, rows: [] } }] }).length, 2);
  assert.equal(traceSets([trace, { trace }]).length, 2);
  assert.deepEqual(traceSets(null), []);
});

test("a recorded transfer replays to its commands, and a changed row is caught", () => {
  const [calls] = transfers(recordTrace().rows);
  assert.equal(calls[0].op, "start");
  assert.equal(replay(core, calls), null);
  const changed = structuredClone(calls);
  changed[0].peers[0][2] = 1;
  assert.match(replay(core, changed), /start at 10 gave different commands/);
});

test("direct measures count each piece once and keep holder timing", () => {
  const [calls] = transfers(recordTrace().rows);
  const measured = measure(calls);
  assert.equal(measured.holders, 2);
  assert.equal(measured.untested, 1);
  assert.equal(measured.failed, false);
  assert.equal(measured.peerNewBytes.reduce((a, b) => a + b, 0) + measured.originBytes, SIZE);
  assert.equal(measured.redundantBytes, 0);
  assert.ok(measured.slackMs > 0 && measured.slackMs < 4_000);
  for (const request of measured.requests) assert.ok(request.firstByteMs === 35 || request.firstByteMs === 85, JSON.stringify(request));
});

test("the report replays every transfer and labels the what-if as an estimate", async () => {
  const out = await report(traceSets(recordTrace()), { whatIf: [1, 2, 3], core });
  assert.deepEqual(out.replayMismatches, []);
  assert.equal(out.transfers, 1);
  assert.deepEqual(out.bufferAheadS, { n: 1, median: 4, p90: 4 });
  assert.match(out.whatIf.note, /^Estimate/);
  assert.equal(out.whatIf.transfers, 1);
  assert.equal(out.whatIf.recorded.maxHolders, 3);
  assert.deepEqual(out.whatIf.limits.map((limit) => limit.maxHolders), [1, 2, 3]);
  for (const limit of out.whatIf.limits) assert.equal(limit.failed, 0);
});
