#!/usr/bin/env node
// Build the core's UniFFI library, generate its Swift bindings, compile a small
// Swift program against them and check its answers: every shared commitment
// vector, and one transfer from a holder and origin. Needs cargo and swiftc.
//
//   node scripts/ffi-swift-smoke.mjs

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "core");
// The debug build: release strips symbols, and on Linux that removes the
// metadata the binding generator reads.
const library = join(core, "target/debug", process.platform === "darwin" ? "librelayswarm_ffi.dylib" : "librelayswarm_ffi.so");
const work = mkdtempSync(join(tmpdir(), "relayswarm-ffi-"));
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: core, maxBuffer: 64 * 1024 * 1024, ...options });

try {
  run("cargo", ["build", "--locked", "-p", "relayswarm-ffi"], { stdio: "inherit" });
  run("cargo", ["run", "--locked", "--quiet", "--features", "bindgen", "--bin", "uniffi-bindgen", "--",
    "generate", "--library", library, "--language", "swift", "--out-dir", join(work, "bindings")], { stdio: "inherit" });
  if (!existsSync(join(work, "bindings/relayswarm_ffi.swift"))) throw new Error("The binding generator wrote no Swift; check the library still carries its UniFFI metadata.");
  const binary = join(work, "smoke");
  run("swiftc", ["-O", "-module-name", "smoke", "-I", join(work, "bindings"),
    "-Xcc", `-fmodule-map-file=${join(work, "bindings/relayswarm_ffiFFI.modulemap")}`,
    join(work, "bindings/relayswarm_ffi.swift"), join(core, "relayswarm-ffi/swift-smoke/main.swift"),
    "-L", dirname(library), "-lrelayswarm_ffi", "-Xlinker", "-rpath", "-Xlinker", dirname(library), "-o", binary], { stdio: "inherit" });

  const vectors = JSON.parse(readFileSync(join(core, "vectors/commitments.json"), "utf8"));
  // The options each case gives segment-commitment.mjs, with the reduced context.
  const cases = vectors.cases.map((entry) => {
    const options = { streamEvent: entry.streamEvent, swarmId: entry.swarmId, context: entry.normalised };
    for (const name of ["revokedDelegationIds", "delegationRevocations", "key", "maxSegmentBytes", "delegation"]) {
      if (name in entry) options[name] = entry[name];
    }
    return { op: entry.op, event: entry.event ?? null, options };
  });
  const piece = 65_536, size = 6 * piece + 1_000;
  const object = Buffer.from(Array.from({ length: size }, (_, i) => (i * 7 + 1) & 255));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const pieces = [];
  for (let at = 0; at < size; at += piece) pieces.push(sha256(object.subarray(at, at + piece)));
  const transfer = { size, object: object.toString("base64"), sha256: sha256(object), pieces };

  const [first, second] = execFileSync(binary, { input: JSON.stringify({ at: vectors.at, cases, transfer }), maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(first.vectors.length, vectors.cases.length);
  const differ = vectors.cases.filter((entry, index) => JSON.stringify(first.vectors[index]) !== JSON.stringify(entry.expected));
  for (const entry of differ) console.error(entry.name, JSON.stringify(first.vectors[vectors.cases.indexOf(entry)]), JSON.stringify(entry.expected));
  assert.deepEqual(differ.map(({ name }) => name), [], "vectors differ through Swift");
  assert.equal(Buffer.from(second.delivered, "base64").equals(object), true, "the transfer delivers the object");
  assert.ok(second.log.some((line) => line.startsWith("request 1 ")), "the holder is asked for pieces");
  console.log(`Swift bindings: ${vectors.cases.length} vectors match; transfer ${second.log.join(", ")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
