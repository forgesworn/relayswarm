// The SHA-256 of the Rust sources that shape the WebAssembly module, so a
// committed module can be checked against the sources beside it. Line endings
// are normalised, so a Windows checkout gives the same hash.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const CORE_SOURCE_SECTION = "relayswarm-source";

function rustFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? rustFiles(path) : entry.name.endsWith(".rs") ? [path] : [];
  });
}

export function coreSourceHash(root) {
  const core = join(root, "core");
  const crates = ["relayswarm-proto", "relayswarm-wasm"];
  const files = [
    ...["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].map((name) => join(core, name)),
    ...crates.flatMap((crate) => [join(core, crate, "Cargo.toml"), ...rustFiles(join(core, crate, "src"))]),
  ].map((path) => relative(root, path).split("\\").join("/")).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");
    hash.update(`${file}\n${Buffer.byteLength(text)}\n`).update(text);
  }
  return hash.digest("hex");
}

// A WebAssembly custom section: id 0, size, then the length-prefixed name and the payload.
export function customSection(name, payload) {
  const leb = (value) => { const out = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value); return Buffer.from(out); };
  const body = Buffer.concat([leb(Buffer.byteLength(name)), Buffer.from(name), Buffer.from(payload)]);
  return Buffer.concat([Buffer.from([0]), leb(body.length), body]);
}
