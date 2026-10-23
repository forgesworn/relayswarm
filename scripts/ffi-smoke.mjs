#!/usr/bin/env node
// Build the core's UniFFI library, generate Swift or Kotlin bindings, compile
// a small program against them and check its answers: every shared commitment
// vector, one transfer from a holder and origin, a piece range exchanged
// between two peer links, the link's channel-state calls, and every recorded
// peer link trace. Swift needs swiftc; Kotlin needs kotlinc and java, and downloads a
// pinned JNA jar into core/target.
//
//   node scripts/ffi-smoke.mjs swift|kotlin
//
// The program reads one line per input and prints one JSON line per result.
// Strings travel as "." plus base64, so no field is empty; "-" is none.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commitmentPieceSize } from "../src/browser/segment-commitment.mjs";

const language = process.argv[2];
if (language !== "swift" && language !== "kotlin") throw new Error("usage: ffi-smoke.mjs swift|kotlin");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "core");
const ffi = join(core, "relayswarm-ffi");
// The debug build: release strips symbols, and on Linux that removes the
// metadata the binding generator reads.
const libraryDir = join(core, "target/debug");
const library = join(libraryDir, process.platform === "darwin" ? "librelayswarm_ffi.dylib" : "librelayswarm_ffi.so");
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: core, maxBuffer: 256 * 1024 * 1024, ...options });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const JNA = {
  url: "https://repo1.maven.org/maven2/net/java/dev/jna/jna/5.14.0/jna-5.14.0.jar",
  sha256: "34ed1e1f27fa896bca50dbc4e99cf3732967cec387a7a0d5e3486c09673fe8c6",
  path: join(core, "target/jna-5.14.0.jar"),
};

async function jna() {
  if (!existsSync(JNA.path) || sha256(readFileSync(JNA.path)) !== JNA.sha256) {
    const response = await fetch(JNA.url);
    if (!response.ok) throw new Error(`JNA download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== JNA.sha256) throw new Error("JNA jar does not match its pinned SHA-256");
    mkdirSync(dirname(JNA.path), { recursive: true });
    writeFileSync(JNA.path, bytes);
  }
  return JNA.path;
}

// --- input -------------------------------------------------------------------

const str = (value) => (value == null ? "-" : `.${Buffer.from(value, "utf8").toString("base64")}`);
const raw = (bytes) => (bytes == null ? "-" : `.${Buffer.from(bytes).toString("base64")}`);
const list = (items) => (items.length === 0 ? "-" : items.map(str).join(","));
const flag = (value) => (value ? "1" : "0");
// The trace recorder's bytes for a `{len, seed}` spec.
const traceBytes = ({ len, seed }) => Uint8Array.from({ length: len }, (_, index) => (seed + index * 31) & 255);

const vectors = JSON.parse(readFileSync(join(core, "vectors/commitments.json"), "utf8"));
const traces = JSON.parse(readFileSync(join(core, "vectors/link-traces.json"), "utf8")).traces;
const EPOCH = 1_792_000_000_000;

const piece = 65_536, size = 6 * piece + 1_000;
const object = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + 1) & 255));
const pieces = [];
for (let at = 0; at < size; at += piece) pieces.push(sha256(object.subarray(at, at + piece)));
// Pieces 2 to 6, the last one short.
const span = { start: 2, end: 7 };

function step(input) {
  const [[op, value]] = Object.entries(input);
  switch (op) {
    case "text": return `text ${str(value)}`;
    case "binary": return `binary ${raw(traceBytes(value))}`;
    case "request": return `request ${str(value.key)} ${value.timeoutMs} ${value.expectedSize ?? "-"}`;
    case "abort": return `abort ${flag(value === "abandon")}`;
    case "advance": return `advance ${value}`;
    case "serve": return `serve ${raw(value && traceBytes(value))}`;
    case "drain": return "drain";
    case "close": return `close ${str(value)}`;
    case "sendHave": return `sendHave ${list(value)}`;
    case "sendHaveChange": return `sendHaveChange ${list(value.add)} ${list(value.del)}`;
    case "sendContribution": return `sendContribution ${flag(value.serving)} ${str(value.rendition)}`;
    case "sendFetching": return `sendFetching ${str(value.k)} ${value.ms}`;
    default: throw new Error(`unknown trace input ${op}`);
  }
}

function input() {
  const lines = [`at ${vectors.at}`];
  for (const entry of vectors.cases) {
    // The options segment-commitment.mjs takes, with the reduced context.
    const options = { streamEvent: entry.streamEvent, swarmId: entry.swarmId, context: entry.normalised };
    for (const name of ["revokedDelegationIds", "delegationRevocations", "key", "maxSegmentBytes", "delegation"]) {
      if (name in entry) options[name] = entry[name];
    }
    lines.push(`case ${entry.op} ${str(JSON.stringify(entry.event ?? null))} ${str(JSON.stringify(options))}`);
  }
  lines.push(`transfer ${size} ${raw(object)} ${sha256(object)} ${pieces.join(",")}`);
  lines.push(`range ${size} ${raw(object)} ${sha256(object)} ${span.start} ${span.end}`);
  for (const trace of traces) {
    const { maxSegmentBytes, maxQueuedRequests, drainTimeoutMs, reliable } = trace.config;
    lines.push(`trace ${EPOCH} ${maxSegmentBytes} ${maxQueuedRequests} ${drainTimeoutMs} ${flag(reliable)}`);
    for (const { in: entry } of trace.steps) lines.push(step(entry));
    lines.push("end");
  }
  return `${lines.join("\n")}\n`;
}

// --- output ------------------------------------------------------------------

const fingerprint = (base64) => {
  const bytes = Buffer.from(base64, "base64");
  return { len: bytes.length, sha: sha256(bytes).slice(0, 16) };
};
// Swift prints `sendError`, Kotlin `SEND_ERROR`; the recorder `send-error`.
const outcome = (name) => name.replace(/([a-z])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();

/// Events in the recorder's order: resolutions land after the step's other
/// events, as promise settlement does.
function record(events) {
  const log = [], resolutions = [];
  for (const [kind, ...args] of events) {
    switch (kind) {
      case "sendText": log.push({ sendText: args[0] }); break;
      case "sendBinary": log.push({ sendBinary: fingerprint(args[0]) }); break;
      case "closed": log.push({ closed: args[0] }); break;
      case "result": {
        const [name, receivedBytes, metadataReceived, draining, closeReason] = args;
        log.push({ result: { outcome: outcome(name), receivedBytes, metadataReceived, draining, closeReason } });
        break;
      }
      case "resolved": resolutions.push({ resolved: args[0] === null ? null : fingerprint(args[0]) }); break;
      case "haveChanged": log.push({ haveChanged: args[0] }); break;
      case "scheduleChanged": log.push({ scheduleChanged: true }); break;
      case "serveRequest": log.push({ serveRequest: args[0] }); break;
      case "serveRange": log.push({ serveRange: args }); break;
      case "uploadCancelled": log.push({ uploadCancelled: args[0] }); break;
      case "progress": log.push({ progress: args }); break;
      default: throw new Error(`unknown event ${kind}`);
    }
  }
  return [...log, ...resolutions];
}

function state([have, fetching, renditions, serving, rendition, busy, outboundInFlight, closed, bytesIn, bytesOut]) {
  return { have, fetching, renditions, serving, rendition, busy, outboundInFlight, closed, bytesIn, bytesOut };
}

function check(output) {
  const [first, second, third, ...links] = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(first.vectors.length, vectors.cases.length);
  const differ = vectors.cases.filter((entry, index) => JSON.stringify(first.vectors[index]) !== JSON.stringify(entry.expected));
  for (const entry of differ) console.error(entry.name, JSON.stringify(first.vectors[vectors.cases.indexOf(entry)]), JSON.stringify(entry.expected));
  assert.deepEqual(differ.map(({ name }) => name), [], `vectors differ through ${language}`);

  assert.equal(Buffer.from(second.delivered, "base64").equals(object), true, "the transfer delivers the object");
  assert.ok(second.log.some((line) => line.startsWith("request 1 ")), "the holder is asked for pieces");

  const pieceSize = commitmentPieceSize(size);
  const wanted = object.subarray(span.start * pieceSize, Math.min(span.end * pieceSize, size));
  const { range, ...channel } = third;
  assert.ok(range !== null && Buffer.from(range, "base64").equals(wanted), "the holder serves the piece range");
  assert.deepEqual(channel, { closedSends: 0, openSends: 1, unreliableAbortCloses: true, reliableAbortCloses: false },
    "channel state reaches the link");

  assert.equal(links.length, traces.length, "one result per link trace");
  const differences = [];
  traces.forEach((trace, index) => {
    trace.expected.forEach((expected, at) => {
      const [events, snapshot] = links[index].steps[at];
      const got = { events: record(events), state: state(snapshot) };
      for (const part of ["events", "state"]) {
        if (JSON.stringify(got[part]) !== JSON.stringify(expected[part])) {
          differences.push(`${trace.name} step ${at}: ${part}\n  expected ${JSON.stringify(expected[part])}\n  got      ${JSON.stringify(got[part])}`);
        }
      }
    });
  });
  assert.deepEqual(differences, [], `link traces differ through ${language}:\n${differences.join("\n")}`);
  const steps = traces.reduce((sum, trace) => sum + trace.steps.length, 0);
  console.log(`${language} bindings: ${vectors.cases.length} vectors match; ${traces.length} link traces (${steps} steps) match; transfer ${second.log.join(", ")}; range of ${wanted.length} bytes`);
}

// --- build and run -----------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), "relayswarm-ffi-"));
try {
  run("cargo", ["build", "--locked", "-p", "relayswarm-ffi"], { stdio: "inherit" });
  const bindings = join(work, "bindings");
  run("cargo", ["run", "--locked", "--quiet", "--features", "bindgen", "--bin", "uniffi-bindgen", "--",
    "generate", "--library", library, "--language", language, "--no-format", "--out-dir", bindings], { stdio: "inherit" });
  const generated = language === "swift" ? join(bindings, "relayswarm_ffi.swift") : join(bindings, "uniffi/relayswarm_ffi/relayswarm_ffi.kt");
  if (!existsSync(generated)) throw new Error(`The binding generator wrote no ${language}; check the library still carries its UniFFI metadata.`);

  let program;
  if (language === "swift") {
    const binary = join(work, "smoke");
    run("swiftc", ["-O", "-module-name", "smoke", "-I", bindings,
      "-Xcc", `-fmodule-map-file=${join(bindings, "relayswarm_ffiFFI.modulemap")}`,
      generated, join(ffi, "smoke/main.swift"),
      "-L", libraryDir, "-lrelayswarm_ffi", "-Xlinker", "-rpath", "-Xlinker", libraryDir, "-o", binary], { stdio: "inherit" });
    program = [binary, []];
  } else {
    const jar = await jna();
    const smoke = join(work, "smoke.jar");
    run("kotlinc", ["-nowarn", "-include-runtime", "-cp", jar, "-d", smoke, generated, join(ffi, "smoke/Main.kt")], { stdio: "inherit" });
    program = ["java", [`-Djna.library.path=${libraryDir}`, "-cp", [smoke, jar].join(delimiter), "MainKt"]];
  }
  const [command, args] = program;
  check(execFileSync(command, args, { input: input(), maxBuffer: 256 * 1024 * 1024 }).toString("utf8"));
} finally {
  rmSync(work, { recursive: true, force: true });
}
