#!/usr/bin/env node
// Summarise loader traces (`traceRequests` and `trace()`) for choosing the
// multi-holder defaults: how many holders a transfer used, what each one
// delivered, how long holders took, and how much buffer a load had to spare.
//
//   node scripts/trace-report.mjs [--json] [--what-if 1,2,3,4] file.json...
//
// A file is a harness receipt (`viewers[].trace`), a bare trace
// (`{ v, capacity, dropped, rows }`), or an array of either. Each trace keeps
// its own time base, so timelines are never merged across viewers.
// Field receipts also report per-level switch costs from their player rows,
// including when tracing was off; holder evidence stays unknown if absent.
//
// Every recorded transfer is first replayed through the committed module and
// must give the recorded commands; a mismatch means the trace and the module
// disagree, and the report says so instead of drawing conclusions from it.
//
// --what-if replays transfers with other holder limits, against a model of
// each holder fitted to that transfer's own requests (a fixed first byte and
// a fixed rate, one request at a time). It ignores that holders share their
// uplink and upload allowance with other viewers, so more holders look better
// than they would be: read it as an estimate of whether fewer holders would
// have been enough, not as evidence for more.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { loadCore } from "../src/browser/core-wasm.mjs";

const PROGRESS_MS = 50;

/** Every trace in a parsed file, each as `{ name, rows, dropped }`. */
export function traceSets(input, name = "trace") {
  if (Array.isArray(input)) return input.flatMap((item, index) => traceSets(item, `${name}[${index}]`));
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input.rows)) return [{ name, rows: input.rows, dropped: input.dropped ?? 0 }];
  if (Array.isArray(input.viewers)) {
    return input.viewers.flatMap((viewer, index) => viewer?.trace ? traceSets(viewer.trace, `${name} viewer ${viewer.viewer ?? index}`) : []);
  }
  // A demo field receipt: stopped sessions, then the running one.
  if (Array.isArray(input.sessions) || input.current) {
    return [...(Array.isArray(input.sessions) ? input.sessions : []).flatMap((entry, index) => entry?.trace ? traceSets(entry.trace, `${name} session ${index}`) : []),
      ...(input.current?.trace ? traceSets(input.current.trace, `${name} current`) : [])];
  }
  return input.trace ? traceSets(input.trace, name) : [];
}

// Receipt player times use the page clock; trace and diagnostic times use
// their swarm session's clock. Never combine holder labels across sessions.
function holderObservation(receipt, atMs, level) {
  const entries = [...(receipt.sessions ?? []), ...(receipt.current ? [receipt.current] : [])];
  const candidates = [];
  entries.forEach((entry, session) => {
    const start = entry.startedAtMs, end = entry.endedAtMs ?? receipt.durationMs ?? Infinity;
    if (!Number.isFinite(start) || atMs < start || atMs >= end) return;
    const add = (row, source) => {
      const time = start + row.atMs;
      if (row.level !== level || !Number.isFinite(time) || time > atMs || !Array.isArray(row.holders)) return;
      candidates.push({ session, source, atMs: time, ageMs: atMs - time,
        holders: [...row.holders], haveHolders: Array.isArray(row.haveHolders) ? [...row.haveHolders] : null,
        staleHolders: Array.isArray(row.staleHolders) ? [...row.staleHolders] : null });
    };
    for (const row of entry.trace?.rows ?? []) if (row.k === "eligibility") add({ ...row, atMs: row.at }, "trace-eligibility");
    for (const row of entry.metrics?.peerEligibilityDiagnostics?.records ?? []) add(row, "eligibility-diagnostic");
    for (const snapshot of receipt.snapshots ?? []) {
      if (snapshot.atMs < start || snapshot.atMs >= end) continue;
      for (const row of snapshot.metrics?.peerEligibilityDiagnostics?.records ?? []) add(row, "snapshot-eligibility");
    }
  });
  return candidates.sort((a, b) => b.atMs - a.atMs)[0] ?? null;
}

/** Switch costs from retained receipt rows, with no scheduler simulation.
 * Prefer actual player level-switch events. Older receipts without them use
 * observed fragment-level transitions, explicitly labelled as such. */
export function switchCosts(input, name = "receipt") {
  if (Array.isArray(input)) return input.flatMap((value, index) => switchCosts(value, `${name}[${index}]`));
  if (!input || typeof input !== "object") return [];
  if (Array.isArray(input.viewers)) return input.viewers.flatMap((viewer, index) => switchCosts(viewer, `${name} viewer ${viewer.viewer ?? index}`));
  if (!Array.isArray(input.player?.fragments)) return [];
  const fragments = input.player.fragments.filter((row) => Number.isFinite(row.atMs) && Number.isSafeInteger(row.level)
    && row.level >= 0 && row.part == null && (!row.mediaType || row.mediaType === "main" || row.mediaType === "video"))
    .sort((a, b) => a.atMs - b.atMs);
  const events = (input.player.levelChanges ?? []).filter((row) => Number.isFinite(row.atMs) && Number.isSafeInteger(row.level) && row.level >= 0)
    .sort((a, b) => a.atMs - b.atMs);
  const basis = events.length ? "player-level-event" : "fragment-level-transition";
  const changes = [];
  let previous = null;
  for (const row of events.length ? events : fragments) {
    if (previous !== null && previous !== row.level) changes.push({ atMs: row.atMs, fromLevel: previous, toLevel: row.level });
    previous = row.level;
  }
  const switches = changes.map((change, index) => {
    const untilMs = changes[index + 1]?.atMs ?? (Number.isFinite(input.durationMs) ? input.durationMs : null);
    const after = fragments.filter((row) => row.atMs >= change.atMs && (untilMs === null || row.atMs < untilMs) && row.level === change.toLevel);
    const counts = { peer: 0, origin: 0, unknown: 0 };
    for (const row of after) counts[row.source === "peer" || row.source === "origin" ? row.source : "unknown"]++;
    const peer = after.find((row) => row.source === "peer");
    return { ...change, untilMs, segments: counts, firstPeerMs: peer ? peer.atMs - change.atMs : null,
      bandwidthEstimate: after.find((row) => Number.isFinite(row.bandwidthEstimate))?.bandwidthEstimate ?? null,
      holdersAtSwitch: holderObservation(input, change.atMs, change.toLevel) };
  });
  return [{ name, basis, scope: "Retained main/video whole-fragment loads at the target level, from the switch through the next switch (exclusive). Initial level announcements are not switches. Parts and audio are excluded. Counts use receipt source labels, not byte shares. Null firstPeerMs means none observed in that interval. Holder rows are the latest recorded target-level observation at or before the switch, with its age; they are not a complete live inventory. Missing holder evidence is null.",
    switches }];
}

/** The scheduler calls of each multi-holder transfer in one trace, by load. */
export function transfers(rows) {
  const byLoad = new Map();
  for (const row of rows) {
    if (row.k !== "xfer") continue;
    if (row.op === "start") byLoad.set(row.load, []);
    byLoad.get(row.load)?.push(row);
  }
  return [...byLoad.values()].filter((calls) => calls[0]?.op === "start");
}

const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const spread = (values) => ({ n: values.length, median: quantile(values, 0.5), p90: quantile(values, 0.9) });
const round = (value) => value === null ? null : Math.round(value * 1000) / 1000;

function objectFor(start) {
  const object = Uint8Array.from({ length: start.size }, (_, i) => (i * 7 + 1) & 255);
  const pieces = [];
  for (let at = 0; at < start.size; at += start.pieceSize) pieces.push(createHash("sha256").update(object.subarray(at, at + start.pieceSize)).digest("hex"));
  return { object, pieces, sha256: createHash("sha256").update(object).digest("hex") };
}

const bytesOf = (start, [from, to]) => Math.min(to * start.pieceSize, start.size) - from * start.pieceSize;
const summary = (state) => state && ({ c: state.commands.map(({ t, peer, p }) => ({ t, ...(peer !== undefined ? { peer } : {}), ...(p ? { p } : {}) })),
  next: state.next, late: state.late, finished: state.finished });

/** Replay recorded calls; null when they match, else the first mismatch. */
export function replay(core, calls) {
  const [start] = calls;
  if (start.pieces !== Math.ceil(start.size / start.pieceSize)) return "piece count does not match the size";
  const { object, pieces, sha256 } = objectFor(start);
  const transfer = core.transfer({ size: start.size, sha256, pieces, deadline: start.deadline, maxHolders: start.maxHolders, originReserveMs: start.originReserveMs });
  if (!transfer) return "the module refused the transfer";
  try {
    for (const row of calls) {
      let state;
      if (row.op === "start") state = transfer.start(row.at, { peers: row.peers, origin: row.origin, sharedFirstByteMs: row.sharedFirstByteMs, sharedRate: row.sharedRate });
      else if (row.op === "delivered") {
        const bytes = object.slice(row.p[0] * start.pieceSize, Math.min(row.p[1] * start.pieceSize, start.size));
        if (row.out?.c.some((command) => command.t === "ban" && command.peer === row.source)) bytes[0] ^= 0xff;
        state = transfer.delivered(row.at, row.source, { start: row.p[0], end: row.p[1] }, bytes);
      } else if (row.op === "failed") state = transfer.failed(row.at, row.source);
      else if (row.op === "progress") state = transfer.progress(row.at, row.source, row.received);
      else if (row.op === "tick") state = transfer.tick(row.at);
      else return `unknown op ${row.op}`;
      if (JSON.stringify(summary(state)) !== JSON.stringify(row.out)) return `${row.op} at ${row.at} gave different commands`;
    }
    return null;
  } finally { transfer.free(); }
}

/** Direct measures of one transfer from its rows; no model involved. */
export function measure(calls) {
  const [start] = calls;
  const issued = new Map(), requests = [], banned = new Set(), verified = new Set();
  const bySource = new Map();
  const source = (id) => bySource.get(id) ?? bySource.set(id, { pieces: 0, newBytes: 0, redundantBytes: 0, requested: 0 }).get(id);
  let finishedAt = null, failed = false, abandons = 0, cancels = 0;
  const take = (row) => {
    for (const command of row.out?.c ?? []) {
      if (command.t === "request" || command.t === "origin") {
        const id = command.t === "origin" ? "origin" : command.peer;
        source(id).requested += 1;
        if (id !== "origin") issued.set(id, { at: row.at, p: command.p, firstAt: null });
      } else if (command.t === "ban") banned.add(command.peer);
      else if (command.t === "abandon") abandons += 1;
      else if (command.t === "cancel") cancels += 1;
      else if (command.t === "deliver") finishedAt = row.at;
      else if (command.t === "fail") { failed = true; finishedAt = row.at; }
    }
  };
  for (const row of calls) {
    if (row.op === "progress" && row.received > 0) {
      const open = issued.get(row.source);
      if (open && open.firstAt === null) open.firstAt = row.at;
    }
    if (row.op === "delivered") {
      const stats = source(row.source);
      const bad = row.out?.c.some((command) => command.t === "ban" && command.peer === row.source);
      if (!bad) {
        for (let index = row.p[0]; index < row.p[1]; index++) {
          const size = bytesOf(start, [index, index + 1]);
          if (verified.has(index)) stats.redundantBytes += size;
          else { verified.add(index); stats.newBytes += size; stats.pieces += 1; }
        }
      }
      const open = issued.get(row.source);
      if (open && open.p[0] === row.p[0] && open.p[1] === row.p[1]) {
        requests.push({ firstByteMs: open.firstAt === null ? null : open.firstAt - open.at, totalMs: row.at - open.at, bytes: row.bytes });
        issued.delete(row.source);
      }
    }
    take(row);
  }
  const peers = [...bySource].filter(([id]) => id !== "origin").map(([, stats]) => stats).sort((a, b) => b.newBytes - a.newBytes);
  return {
    holders: start.peers.length,
    untested: start.peers.filter(([, , rate]) => rate === null).length,
    used: peers.filter((stats) => stats.requested > 0).length,
    late: Boolean(calls[0].out?.late),
    failed,
    slackMs: finishedAt === null ? null : start.deadline - finishedAt,
    durationMs: finishedAt === null ? null : finishedAt - start.at,
    size: start.size,
    originBytes: bySource.get("origin")?.newBytes ?? 0,
    peerNewBytes: peers.map((stats) => stats.newBytes),
    redundantBytes: [...bySource.values()].reduce((sum, stats) => sum + stats.redundantBytes, 0),
    abandons, cancels, bans: banned.size, requests,
  };
}

/** Per-holder model from the transfer's own requests: first byte and rate. */
function fit(calls, measured) {
  const [start] = calls;
  const issued = new Map(), samples = new Map();
  for (const row of calls) {
    if (row.op === "progress" && row.received > 0) {
      const open = issued.get(row.source);
      if (open && open.firstAt === null) open.firstAt = row.at;
    }
    if (row.op === "delivered" && typeof row.source === "number") {
      const open = issued.get(row.source);
      if (open && open.p[0] === row.p[0] && open.p[1] === row.p[1]) {
        const firstByte = open.firstAt === null ? 0 : open.firstAt - open.at;
        const list = samples.get(row.source) ?? samples.set(row.source, []).get(row.source);
        list.push({ firstByte, bytes: row.bytes, ms: Math.max(1, row.at - open.at - firstByte) });
        issued.delete(row.source);
      }
    }
    for (const command of row.out?.c ?? []) if (command.t === "request") issued.set(command.peer, { at: row.at, p: command.p, firstAt: null });
  }
  const model = new Map();
  for (const [id] of start.peers) {
    const list = samples.get(id);
    if (!list?.length) return null;
    model.set(id, { firstByte: quantile(list.map((s) => s.firstByte), 0.5), rate: list.reduce((a, s) => a + s.bytes, 0) / list.reduce((a, s) => a + s.ms, 0) });
  }
  const originRows = calls.filter((row) => row.op === "delivered" && row.source === "origin");
  const [originFirstByte, originRate] = start.origin;
  model.set("origin", { firstByte: originFirstByte ?? 0, rate: originRate ?? (originRows.length ? measured.size / Math.max(1, measured.durationMs ?? 1) : 1) });
  return model;
}

/** Simulate one transfer with another holder limit against a fitted model. */
export function simulate(core, calls, model, maxHolders) {
  const [start] = calls;
  const { object, pieces, sha256 } = objectFor(start);
  const transfer = core.transfer({ size: start.size, sha256, pieces, deadline: start.deadline, maxHolders, originReserveMs: start.originReserveMs });
  const events = [];
  let clock = start.at, done = null, originBytes = 0, peerBytes = 0, guard = 0;
  const schedule = (at, run, peer = null) => events.push({ at, run, peer });
  const ask = (source, p, at) => {
    const { firstByte, rate } = model.get(source);
    const bytes = bytesOf(start, p), firstAt = at + firstByte, endAt = firstAt + bytes / rate;
    if (source !== "origin") for (let t = firstAt; t < endAt; t += PROGRESS_MS) schedule(Math.floor(t), (now) => transfer.progress(now, source, Math.max(1, Math.floor((t - firstAt) * rate))), source);
    schedule(Math.ceil(endAt), (now) => {
      if (source === "origin") originBytes += bytes; else peerBytes += bytes;
      return transfer.delivered(now, source, { start: p[0], end: p[1] }, object.slice(p[0] * start.pieceSize, Math.min(p[1] * start.pieceSize, start.size)));
    }, source === "origin" ? null : source);
  };
  let timer = null;
  const apply = (state, at) => {
    if (!state) return;
    for (const command of state.commands) {
      if (command.t === "request") ask(command.peer, command.p, at);
      else if (command.t === "origin") ask("origin", command.p, at);
      else if (command.t === "cancel" || command.t === "abandon") {
        for (let i = events.length - 1; i >= 0; i--) if (events[i].peer === command.peer) events.splice(i, 1);
      } else if (command.t === "deliver") done = { at, ok: true };
      else if (command.t === "fail") done = { at, ok: false };
    }
    if (timer) events.splice(events.indexOf(timer), 1);
    timer = state.next === null ? null : { at: state.next, run: (now) => transfer.tick(now), peer: null, tick: true };
    if (timer) events.push(timer);
  };
  apply(transfer.start(start.at, { peers: start.peers, origin: start.origin, sharedFirstByteMs: start.sharedFirstByteMs, sharedRate: start.sharedRate }), start.at);
  while (!done && events.length && guard++ < 100_000) {
    events.sort((a, b) => a.at - b.at);
    const event = events.shift();
    if (event === timer) timer = null;
    clock = Math.max(clock, event.at);
    apply(event.run(clock), clock);
  }
  transfer.free();
  return { ok: done?.ok ?? false, slackMs: done ? start.deadline - done.at : null, originBytes, peerBytes };
}

/** The report for a set of traces. */
export async function report(sets, { whatIf = [], core = null, receipts = [] } = {}) {
  core ??= await loadCore(await WebAssembly.compile(await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url))));
  const all = [], loads = [], eligibility = {}, mismatches = [];
  let dropped = 0, rows = 0;
  for (const set of sets) {
    dropped += set.dropped; rows += set.rows.length;
    for (const row of set.rows) {
      // Seconds buffered ahead of the playhead when the load began: the room
      // a lookahead could prefetch into.
      const geometry = row.budgetGeometry;
      if (row.k === "load" && Number.isFinite(geometry?.bufferedEnd) && Number.isFinite(geometry?.currentTime)) {
        loads.push({ aheadS: round(geometry.bufferedEnd - geometry.currentTime), budgetMs: row.budgetMs });
      }
      if (row.k === "eligibility") eligibility[row.reason ?? "eligible"] = (eligibility[row.reason ?? "eligible"] ?? 0) + 1;
    }
    for (const calls of transfers(set.rows)) {
      const mismatch = replay(core, calls);
      if (mismatch) { mismatches.push(`${set.name} load ${calls[0].load}: ${mismatch}`); continue; }
      all.push({ calls, measured: measure(calls) });
    }
  }
  const measured = all.map((entry) => entry.measured);
  const totalBytes = measured.reduce((sum, m) => sum + m.size, 0);
  const holderShare = [0, 1, 2, 3].map((rank) => {
    const used = measured.filter((m) => m.peerNewBytes.length > rank);
    return { rank: rank + 1, transfers: used.length, bytesShare: round(used.reduce((s, m) => s + m.peerNewBytes[rank], 0) / Math.max(1, totalBytes)) };
  }).filter((entry) => entry.transfers > 0);
  const requests = measured.flatMap((m) => m.requests);
  const out = {
    traces: sets.length, rows, dropped, replayMismatches: mismatches,
    switchCosts: receipts.flatMap(({ input, name }) => switchCosts(input, name)),
    transfers: measured.length,
    failed: measured.filter((m) => m.failed).length,
    lateAtStart: measured.filter((m) => m.late).length,
    untestedHolders: measured.reduce((s, m) => s + m.untested, 0),
    holdersOffered: spread(measured.map((m) => m.holders)),
    holdersUsed: spread(measured.map((m) => m.used)),
    holderShare,
    originShare: round(measured.reduce((s, m) => s + m.originBytes, 0) / Math.max(1, totalBytes)),
    redundantShare: round(measured.reduce((s, m) => s + m.redundantBytes, 0) / Math.max(1, totalBytes)),
    abandons: measured.reduce((s, m) => s + m.abandons, 0),
    bans: measured.reduce((s, m) => s + m.bans, 0),
    slackMs: spread(measured.filter((m) => m.slackMs !== null).map((m) => m.slackMs)),
    requestFirstByteMs: spread(requests.filter((r) => r.firstByteMs !== null).map((r) => r.firstByteMs)),
    requestTotalMs: spread(requests.map((r) => r.totalMs)),
    requestBytesPerMs: spread(requests.filter((r) => r.totalMs > 0).map((r) => round(r.bytes / r.totalMs))),
    bufferAheadS: spread(loads.map((load) => load.aheadS)),
    eligibility,
  };
  if (whatIf.length) {
    const fitted = all.map((entry) => ({ ...entry, model: fit(entry.calls, entry.measured) })).filter((entry) => entry.model);
    const fittedSize = fitted.reduce((s, entry) => s + entry.measured.size, 0);
    out.whatIf = {
      note: "Estimate: each holder keeps its measured first byte and rate whatever else it serves. Shared uplinks make extra holders look better than they are.",
      transfers: fitted.length,
      // The same transfers as recorded, to set against the model at the recorded limit.
      recorded: { maxHolders: spread(fitted.map((entry) => entry.calls[0].maxHolders)).median,
        slackMs: spread(fitted.filter((entry) => entry.measured.slackMs !== null).map((entry) => entry.measured.slackMs)),
        originShare: round(fitted.reduce((s, entry) => s + entry.measured.originBytes, 0) / Math.max(1, fittedSize)) },
      limits: whatIf.map((maxHolders) => {
        const runs = fitted.map((entry) => simulate(core, entry.calls, entry.model, maxHolders));
        const size = fitted.reduce((s, entry) => s + entry.measured.size, 0);
        return { maxHolders, failed: runs.filter((r) => !r.ok).length, slackMs: spread(runs.filter((r) => r.ok).map((r) => r.slackMs)),
          originShare: round(runs.reduce((s, r) => s + r.originBytes, 0) / Math.max(1, size)) };
      }),
    };
  }
  return out;
}

function print(out) {
  const line = (label, value) => console.log(`${label.padEnd(26)} ${typeof value === "object" ? JSON.stringify(value) : value}`);
  line("traces / rows / dropped", `${out.traces} / ${out.rows} / ${out.dropped}`);
  if (out.replayMismatches.length) line("replay mismatches", out.replayMismatches);
  line("transfers", `${out.transfers} (failed ${out.failed}, late at start ${out.lateAtStart})`);
  line("holders offered", out.holdersOffered);
  line("holders used", out.holdersUsed);
  line("untested holders", out.untestedHolders);
  line("bytes by holder rank", out.holderShare);
  line("origin / redundant share", `${out.originShare} / ${out.redundantShare}`);
  line("abandons / bans", `${out.abandons} / ${out.bans}`);
  line("slack at finish (ms)", out.slackMs);
  line("request first byte (ms)", out.requestFirstByteMs);
  line("request total (ms)", out.requestTotalMs);
  line("request bytes/ms", out.requestBytesPerMs);
  line("buffer ahead (s)", out.bufferAheadS);
  line("eligibility", out.eligibility);
  for (const receipt of out.switchCosts) {
    line("level switches", `${receipt.name} (${receipt.basis})`);
    line("  scope", receipt.scope);
    for (const change of receipt.switches) line(`  ${change.fromLevel} -> ${change.toLevel} at ${change.atMs}ms`, change);
  }
  if (out.whatIf) {
    console.log(`\nwhat-if over ${out.whatIf.transfers} transfers. ${out.whatIf.note}`);
    line(`  recorded (${out.whatIf.recorded.maxHolders})`, { slackMs: out.whatIf.recorded.slackMs, originShare: out.whatIf.recorded.originShare });
    for (const limit of out.whatIf.limits) line(`  maxHolders ${limit.maxHolders}`, { failed: limit.failed, slackMs: limit.slackMs, originShare: limit.originShare });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const whatIfAt = args.indexOf("--what-if");
  const whatIf = whatIfAt >= 0 ? args[whatIfAt + 1].split(",").map(Number) : [];
  const files = args.filter((arg, index) => !arg.startsWith("--") && (whatIfAt < 0 || index !== whatIfAt + 1));
  if (!files.length) { console.error("usage: trace-report.mjs [--json] [--what-if 1,2,3] file.json..."); process.exit(2); }
  const sets = [], receipts = [];
  for (const file of files) {
    const input = JSON.parse(await readFile(file, "utf8"));
    sets.push(...traceSets(input, file)); receipts.push({ input, name: file });
  }
  const out = await report(sets, { whatIf, receipts });
  if (json) console.log(JSON.stringify(out, null, 2)); else print(out);
  if (out.replayMismatches.length) process.exitCode = 1;
}
