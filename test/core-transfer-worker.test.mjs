import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Worker as Thread } from "node:worker_threads";
import { createCoreTransferWorker } from "../src/browser/core-transfer-worker.mjs";
import { loadCore } from "../src/browser/core-wasm.mjs";
import { commitmentPieceSize } from "../src/browser/segment-commitment.mjs";
import { CORE_FUNCTIONS, stubCore } from "./core-stub.mjs";
import { loadOriginRange } from "../src/browser/origin-range.mjs";
import { mixedHttpOrigin } from "./support/mixed-http-origin.mjs";

const module = await WebAssembly.compile(await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url)));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const object = size => Uint8Array.from({ length: size }, (_, index) => (index * 131 + 17) % 251);
const frame = () => ({ commands: [], next: null, late: false, finished: false, verified: 0, bytes: null });
function config(bytes, extra = {}) {
  const pieceSize = commitmentPieceSize(bytes.length), pieces = [];
  for (let at = 0; at < bytes.length; at += pieceSize) pieces.push(digest(bytes.subarray(at, at + pieceSize)));
  return { size: bytes.length, sha256: digest(bytes), pieces, deadline: 11_000, maxHolders: 3, originReserveMs: 2_000, ...extra };
}

class WorkerThread extends EventTarget {
  constructor() {
    super();
    this.thread = new Thread(new URL("./support/core-transfer-worker-thread.mjs", import.meta.url));
    this.exit = new Promise(resolve => this.thread.once("exit", resolve));
    this.thread.on("message", data => this.dispatchEvent(new MessageEvent("message", { data })));
    this.thread.on("error", () => this.dispatchEvent(new Event("error")));
  }
  postMessage(data, transfer) { this.thread.postMessage(data, transfer); }
  terminate() { this.terminated = true; return this.thread.terminate(); }
}

class HeldWorker extends EventTarget {
  requests = [];
  constructor({ hold = [] } = {}) { super(); this.hold = new Set(hold); }
  postMessage(data, transfer) {
    const message = structuredClone(data, { transfer });
    this.requests.push(message);
    if (!this.hold.has(message.op)) queueMicrotask(() => this.reply(message));
  }
  reply(message, result = ["init", "new", "free"].includes(message.op) ? true : frame()) {
    this.dispatchEvent(new MessageEvent("message", { data: { v: 1, id: message.id, ok: true, result } }));
  }
  terminate() { this.terminated = true; }
}

async function real(t, options = {}) {
  const workers = [];
  const client = await createCoreTransferWorker({ module, workerFactory: () => {
    const worker = new WorkerThread(); workers.push(worker); return worker;
  }, ...options });
  t.after(async () => { client.stop(); await Promise.all(workers.map(worker => worker.exit)); });
  return { client, workers };
}
async function held(t, options = {}, workerOptions) {
  const worker = new HeldWorker(workerOptions);
  const client = await createCoreTransferWorker({ module, workerFactory: () => worker, ...options });
  t.after(() => client.stop());
  return { client, worker };
}

test("a real worker preserves every Rust frame and six-MiB hash through mixed/corrupt piece delivery", async t => {
  const { client } = await real(t), core = await loadCore(module), bytes = object(6 * 1024 * 1024), options = config(bytes);
  const direct = core.transfer(options), remote = await client.transfer(options), pieceSize = commitmentPieceSize(bytes.length);
  t.after(() => { direct.free(); core.retire(); });
  const input = { peers: [[1, 50, null], [2, 50, null]], origin: [0, 500], sharedRate: 20_000, probePeers: [1, 2] };
  let at = 1_000;
  const same = async (op, args) => {
    const expected = direct[op](...args), actual = await remote[op](...args);
    assert.deepEqual(actual, expected, `${op} has exactly the same Rust commands, timing, verified count and bytes`);
    return actual;
  };
  let current = await same("start", [at, input]);
  const queue = [...current.commands], commands = [];
  while (queue.length && !current.finished) {
    const command = queue.shift(); commands.push(command.t);
    if (!["request", "origin"].includes(command.t)) continue;
    const source = command.peer ?? "origin", range = command.range;
    const response = bytes.subarray(range.start * pieceSize, Math.min(range.end * pieceSize, bytes.length)).slice();
    if (source === 2) response[0] ^= 1;
    if (source !== "origin") {
      current = await same("progress", [at += 5, source, 1]);
      queue.push(...current.commands);
    }
    current = await same("delivered", [at += 10, source, range, response]);
    assert.ok(response.byteLength > 0, "posting into the worker retains the caller's original media buffer");
    queue.push(...current.commands);
  }
  assert.ok(commands.includes("origin") && commands.includes("request"));
  assert.ok(commands.includes("ban"), "the real Rust verifier rejects the altered holder's piece");
  assert.ok(current.finished && current.commands.some(command => command.t === "deliver"));
  assert.deepEqual(current.bytes, bytes);
  assert.equal(digest(current.bytes), options.sha256);
  assert.equal(await remote.free(), true);
  assert.equal(client.snapshot().transfers, 0);
});

test("exclusive origin assembles six MiB with an untrained real worker and actual disjoint206 bodies", { timeout: 20000 }, async t => {
  const { client } = await real(t), core = await loadCore(module), bytes = object(6 * 1024 * 1024);
  const options = config(bytes, { exclusiveOrigin: true, deadline: 3500, originReserveMs: 0 });
  const direct = core.transfer(options), remote = await client.transfer(options), pieceSize = commitmentPieceSize(bytes.length);
  t.after(async () => { direct.free(); await remote.free(); core.retire(); });
  const http = await mixedHttpOrigin(t, bytes), pending = new Set(), ranges = [], peerBodies = [];
  // These are native API operation inputs, not elapsed HTTP/worker metrics.
  // The Hls real-clock tests separately enforce its unchanged25ms admission.
  let at = 1000, current;
  const same = async (op, args) => {
    const expected = direct[op](...args), actual = await remote[op](...args);
    assert.deepEqual(actual, expected, 'the real worker preserves every Rust frame and verified byte');
    return actual;
  };
  const issue = state => {
    for (const command of state.commands) {
      if (!['request', 'origin'].includes(command.t)) continue;
      const source = command.peer ?? 'origin', { start, end } = command.range;
      ranges.push({ source, start, end });
      if (source !== 'origin') assert(end - start <= 4 && (end - start) * pieceSize <= 512 * 1024);
      const task = { source, range: command.range };
      const body = source === 'origin'
        ? loadOriginRange({ Loader: http.HttpLoader, loaderConfig: {} }, { url: http.url }, start * pieceSize, Math.min(end * pieceSize, bytes.length))
        : Promise.resolve(bytes.slice(start * pieceSize, Math.min(end * pieceSize, bytes.length)));
      task.promise = body.then(value => ({ task, body: value })); pending.add(task);
      if (source !== 'origin') peerBodies.push(Math.min(end * pieceSize, bytes.length) - start * pieceSize);
    }
  };
  current = await same('start', [at, { peers: [[1, null, null]], origin: [0, null],
    sharedFirstByteMs: null, sharedRate: null, probePeers: [1] }]);
  assert.equal(current.commands.find(command => command.t === 'request').range.end, 1, 'unknown begins with exactly one piece');
  issue(current); await http.firstRequest;
  assert.equal(http.requests[0].complete, false, 'the real source prefix is already in flight before probe acceptance');
  let turns = 0;
  while (!current.finished && pending.size && turns++ < 128) {
    const { task, body } = await Promise.race([...pending].map(value => value.promise)); pending.delete(task);
    assert.ok(body?.byteLength);
    if (task.source !== 'origin') {
      const progress = await same('progress', [at += 5, task.source, 1]); issue(progress);
    }
    current = await same('delivered', [at += 10, task.source, task.range, body]); issue(current);
  }
  await Promise.all([...pending].map(value => value.promise));
  assert.ok(current.finished && current.commands.some(command => command.t === 'deliver'));
  assert.deepEqual(current.bytes, bytes); assert.equal(digest(current.bytes), options.sha256);
  assert(peerBodies.length > 1, 'a verified unknown probe must actually refill, never decline this functional test');
  assert(http.requests.length && http.requests.every(row => row.range && row.status === 206 && row.complete), 'no whole GET or incomplete source body');
  const sourceBytes = http.received.reduce((sum, row) => sum + row.bytes, 0), peerBytes = peerBodies.reduce((sum, size) => sum + size, 0);
  console.log(JSON.stringify({ fixture: 'exclusive-core-worker-206', coreClock: 'logical-operation-inputs-not-elapsed-metrics',
    exclusiveOrigin: options.exclusiveOrigin, sourceBytes, peerBytes, objectBytes: bytes.length, peerRequests: peerBodies.length }));
  assert.equal(sourceBytes + peerBytes, bytes.length, 'actual206 and peer bodies have disjoint ownership');
  const owners = new Array(options.pieces.length).fill(0);
  for (const range of ranges) for (let index = range.start; index < range.end; index++) owners[index]++;
  assert(owners.every(count => count === 1), 'every physical piece was requested exactly once');
});

test("freeing one real Rust handle preserves a second active transfer and its bytes", async t => {
  const { client, workers } = await real(t), bytes = object(200_000), options = config(bytes);
  const first = await client.transfer(options), second = await client.transfer(options);
  assert.equal(await first.cancel(), true);
  assert.equal(first.closed, true);
  await assert.rejects(first.tick(1_000), { code: "closed-transfer" });
  const initial = await second.start(1_000, { peers: [], origin: [0, 1_000] });
  const command = initial.commands.find(command => command.t === "origin");
  const complete = await second.delivered(1_010, "origin", command.range, bytes);
  assert.equal(complete.finished, true);
  assert.deepEqual(complete.bytes, bytes);
  assert.equal(workers[0].terminated, undefined, "ordinary cancellation does not terminate the swarm's worker");
  await second.free();
});

test("peer-only worker frames preserve exact Rust range verification with no origin source", async t => {
  const { client } = await real(t), core = await loadCore(module), bytes = object(6 * 1024 * 1024);
  const options = config(bytes, { peerOnly: true, originReserveMs: 0 }), direct = core.transfer(options), remote = await client.transfer(options);
  assert.ok(direct, "rebuild the committed WASM for explicit peer-only transfer capability");
  const pieceSize = commitmentPieceSize(bytes.length), input = { peers: [[1, 10, null], [2, 10, null]], origin: null, sharedRate: null, probePeers: [1, 2] };
  let at = 1_000, delivered = null, count = 0;
  const same = async (op, args) => {
    const expected = direct[op](...args), actual = await remote[op](...args);
    assert.deepEqual(actual, expected);
    assert.ok(!actual.commands.some(command => command.t === "origin"), "no ignored or invented origin command crosses the worker boundary");
    return actual;
  };
  try {
    let state = await same("start", [at, input]), queue = [...state.commands];
    while (queue.length && !state.finished && count++ < 128) {
      const command = queue.shift();
      if (command.t !== "request") continue;
      assert.ok(command.range.end - command.range.start <= 4);
      state = await same("progress", [at += 5, command.peer, 1]); queue.push(...state.commands);
      const body = bytes.slice(command.range.start * pieceSize, Math.min(command.range.end * pieceSize, bytes.length));
      state = await same("delivered", [at += 10, command.peer, command.range, body]); queue.push(...state.commands);
      if (state.commands.some(command => command.t === "deliver")) delivered = state.bytes;
    }
    assert.deepEqual(delivered, bytes);
    assert.equal(digest(delivered), options.sha256);
    assert.ok(count >= 17, "the full six-MiB object really traversed bounded native ranges");
  } finally { await remote.free(); direct.free(); core.retire(); }
});

for (const mode of ["peerOnly", "exclusiveOrigin"]) test("unsupported " + (mode === "peerOnly" ? "peer-only" : "exclusive origin") + " mode preserves a real worker and its ordinary mixed handles", async t => {
  const additions = {
    rs_xfer_new: [[0x7c, 0x7c, 0x7c, 0x7c, 0x7f, 0x7f], [0x7f]],
    rs_xfer_call: [[0x7f, 0x7f, 0x7c, 0x7c, 0x7c, 0x7c, 0x7f, 0x7f], [0x7f]],
    rs_xfer_free: [[0x7f], []],
  };
  const previous = new Map(Object.keys(additions).map(key => [key, CORE_FUNCTIONS[key]]));
  let legacy;
  try {
    Object.assign(CORE_FUNCTIONS, additions);
    legacy = await WebAssembly.compile(stubCore([], { rs_xfer_new: 1 }));
  } finally { for (const [key, value] of previous) { if (value === undefined) delete CORE_FUNCTIONS[key]; else CORE_FUNCTIONS[key] = value; } }
  const failures = [], { client, workers } = await real(t, { module: legacy, onFailure: error => failures.push(error) });
  const options = config(object(1_024));
  await assert.rejects(client.transfer({ ...options, [mode]: true }), { code: "invalid-transfer" });
  assert.equal(client.snapshot().state, "ready");
  assert.equal(client.snapshot().transfers, 0);
  const mixed = await client.transfer(options);
  assert.equal(await mixed.free(), true, "the pre-existing mixed constructor/free ABI remains usable");
  assert.equal(workers[0].terminated, undefined);
  assert.deepEqual(failures, []);
});

test("exclusive origin worker config preserves only valid explicit opt-ins before posting", async t => {
  const { client, worker } = await held(t), options = config(object(1_024));
  for (const exclusiveOrigin of [null, 1, "true", {}, []])
    await assert.rejects(client.transfer({ ...options, exclusiveOrigin }), { code: "invalid-transfer" });
  await assert.rejects(client.transfer({ ...options, exclusiveOrigin: true, peerOnly: true }), { code: "invalid-transfer" });
  assert.equal(worker.requests.filter(row => row.op === "new").length, 0);
  const exclusive = await client.transfer({ ...options, exclusiveOrigin: true });
  assert.equal(worker.requests.find(row => row.op === "new").input.exclusiveOrigin, true);
  await exclusive.free();
  const ordinary = await client.transfer(options);
  assert.equal(Object.hasOwn(worker.requests.filter(row => row.op === "new").at(-1).input, "exclusiveOrigin"), false);
  await ordinary.free();
});

test("transfers and cumulative active bytes have independent finite limits", async t => {
  for (const limits of [{ maxTransfers: 1 }, { maxTransfers: 2, maxActiveBytes: 1_024 }]) {
    const { client } = await held(t, limits), options = config(object(1_024));
    const first = await client.transfer(options);
    await assert.rejects(client.transfer(options), { code: "transfer-limit" });
    assert.equal(client.snapshot().transfers, 1);
    assert.equal(client.snapshot().activeBytes, 1_024);
    await first.free();
    const next = await client.transfer(options); await next.free();
    assert.equal(client.snapshot().activeBytes, 0);
  }
});

test("queued work is bounded and a cancelled reply cannot revive a handle or harm another", async t => {
  const { client, worker } = await held(t, { maxPending: 1 }, { hold: ["tick"] }), options = config(object(1_024));
  const first = await client.transfer(options), second = await client.transfer(options);
  const pending = first.tick(1_000);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(first.progress(1_001, 1, 1), { code: "queue-limit" });
  await rejected;
  const late = worker.requests.find(message => message.op === "tick");
  worker.reply(late, { ...frame(), finished: true, bytes: new Uint8Array([1]) });
  await first.free();
  assert.equal(client.snapshot().state, "ready");
  assert.equal(first.closed, true);
  assert.deepEqual(await second.failed(1_002, 1), frame());
  assert.equal(worker.terminated, undefined);
  await second.free();
});

test("media payload queue bounds are checked without detaching the caller's offset view", async t => {
  const { client, worker } = await held(t, { maxPendingBytes: 1_024 }), transfer = await client.transfer(config(object(2_048)));
  const backing = object(2_100), view = backing.subarray(17, 2_065), original = view.slice();
  await assert.rejects(transfer.delivered(1_000, "origin", { start: 0, end: 1 }, view), { code: "queue-limit" });
  assert.deepEqual(view, original);
  assert.equal(backing.byteLength, 2_100);
  assert.ok(!worker.requests.some(message => message.op === "delivered"));
  await transfer.free();
  assert.equal(client.snapshot().pendingBytes, 0);
});

test("a genuine operation deadline terminates the worker and rejects every pending transfer", async t => {
  const failures = [];
  const { client, worker } = await held(t, { operationTimeoutMs: 20, onFailure: error => failures.push(error.code) }, { hold: ["tick"] });
  const first = await client.transfer(config(object(1_024))), second = await client.transfer(config(object(1_024)));
  const firstPending = first.tick(1_000), secondPending = second.tick(1_000);
  await Promise.all([assert.rejects(firstPending, { code: "operation-timeout" }), assert.rejects(secondPending, { code: "operation-timeout" })]);
  assert.equal(worker.terminated, true);
  assert.deepEqual(failures, ["operation-timeout"]);
  assert.deepEqual(client.snapshot(), { state: "failed", reason: "operation-timeout", transfers: 0, activeBytes: 0, pending: 0, pendingBytes: 0 });
});

test("swarm abort terminates promptly and preserves no pending media or handles", async t => {
  const abort = new AbortController(), failures = [];
  const { client, worker } = await held(t, { signal: abort.signal, onFailure: error => failures.push(error) }, { hold: ["delivered"] });
  const transfer = await client.transfer(config(object(2_048))), view = object(2_048);
  const pending = transfer.delivered(1_000, "origin", { start: 0, end: 1 }, view);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  assert.equal(client.snapshot().pendingBytes, view.length);
  abort.abort(); await rejection;
  assert.equal(view.byteLength, 2_048);
  assert.equal(worker.terminated, true);
  assert.equal(client.snapshot().pending, 0);
  assert.equal(client.snapshot().activeBytes, 0);
  assert.deepEqual(failures, [], "an ordinary host stop is not reported as a worker failure");
});

test("initialisation has a deadline and unavailable implicit companion assets are refused", async () => {
  const worker = new HeldWorker({ hold: ["init"] });
  await assert.rejects(createCoreTransferWorker({ module, workerFactory: () => worker, initTimeoutMs: 20 }), { code: "init-timeout" });
  assert.equal(worker.terminated, true);
  await assert.rejects(createCoreTransferWorker({ module }), { code: "worker-unavailable" });
});

test("worker failure and malformed result frames retire pending work instead of claiming delivery", async t => {
  for (const malformed of [false, true]) {
    const failures = [];
    const { client, worker } = await held(t, { onFailure: error => failures.push(error.code) }, { hold: ["tick"] });
    const transfer = await client.transfer(config(object(1_024))), pending = transfer.tick(1_000);
    const rejection = assert.rejects(pending, { code: malformed ? "invalid-response" : "worker-error" });
    if (malformed) worker.reply(worker.requests.find(message => message.op === "tick"), { ...frame(), bytes: new Uint8Array(1_025) });
    else worker.dispatchEvent(new Event("error"));
    await rejection;
    assert.equal(worker.terminated, true);
    assert.equal(client.snapshot().pending, 0);
    assert.equal(client.snapshot().activeBytes, 0);
    assert.deepEqual(failures, [malformed ? "invalid-response" : "worker-error"]);
  }
});
