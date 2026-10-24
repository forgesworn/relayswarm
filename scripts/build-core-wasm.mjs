#!/usr/bin/env node
// Build the Rust core's WebAssembly module and copy it beside the browser
// loader. Source paths are remapped so the binary names no local directory,
// and a custom section records the SHA-256 of the sources it was built from.
//
//   node scripts/build-core-wasm.mjs [--out path]

import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { CORE_SOURCE_SECTION, coreSourceHash, customSection } from "./core-source-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = join(root, "core");
const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? resolve(process.argv[outIndex + 1]) : join(root, "src/browser/relayswarm-core.wasm");
const cargoHome = process.env.CARGO_HOME || join(homedir(), ".cargo");

// rustc applies the last matching prefix, so the most specific comes last.
const remaps = [[homedir(), "/home"], [root, "/relayswarm"], [core, "/relayswarm/core"], [cargoHome, "/cargo"]];
execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown", "-p", "relayswarm-wasm"], {
  cwd: core,
  stdio: "inherit",
  env: { ...process.env, CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS: remaps.map(([from, to]) => `--remap-path-prefix=${from}=${to}`).join(" ") },
});

const built = join(core, "target/wasm32-unknown-unknown/release/relayswarm_wasm.wasm");
const bytes = readFileSync(built);
const text = bytes.toString("latin1");
for (const local of [homedir(), root, cargoHome]) {
  if (text.includes(local)) throw new Error(`The module still names a local path (${local.length} characters); check the remapping.`);
}
// Bytes differ between hosts, so the module records which sources built it.
const stamped = Buffer.concat([bytes, customSection(CORE_SOURCE_SECTION, coreSourceHash(root))]);
writeFileSync(out, stamped);
console.log(`${out}: ${statSync(out).size} bytes, ${gzipSync(stamped, { level: 9 }).length} gzip`);
