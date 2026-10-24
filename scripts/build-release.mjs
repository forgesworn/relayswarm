#!/usr/bin/env node
// Build the GitHub JavaScript/WASM downloads from a clean source commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { CORE_SOURCE_SECTION, coreSourceHash } from "./core-source-hash.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (program, args) => execFileSync(program, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
run("git", ["diff", "--exit-code", "HEAD"]);
assert.equal(run("git", ["ls-files", "--others", "--exclude-standard"]).trim(), "", "Commit source files before packaging");
const sourceCommit = run("git", ["rev-parse", "HEAD"]).trim();
const { version } = JSON.parse(readFileSync(join(root, "package.json")));
assert.match(version, /^\d+\.\d+\.\d+$/u);
const out = join(root, "artifacts/release");
mkdirSync(out, { recursive: true });
const moduleBytes = readFileSync(join(root, "src/browser/relayswarm-core.wasm"));
const module = await WebAssembly.compile(moduleBytes);
const stamps = WebAssembly.Module.customSections(module, CORE_SOURCE_SECTION);
assert.equal(stamps.length, 1, "Expected one WASM source stamp");
assert.equal(Buffer.from(stamps[0]).toString(), coreSourceHash(root), "Rebuild the committed WASM after changing core sources");
assert.deepEqual(WebAssembly.Module.imports(module), []);

// Validate the package list before copying anything into the tarball.
const [preview] = JSON.parse(run("npm", ["pack", "--dry-run", "--json"]));
for (const { path } of preview.files) {
  assert.ok(!/(?:^|\/)(?:node_modules|target|\.build|\.swiftpm|\.interop-sdk|artifacts|state)(?:\/|$)/u.test(path), `Local build/state in package: ${path}`);
  assert.ok(!/\.(?:key|pem)$/u.test(path), `Private key in package: ${path}`);
}
assert.ok(preview.files.some(({ path }) => path === "src/browser/relayswarm-core.wasm"));
const [packed] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", out]));
assert.deepEqual(packed.files, preview.files, "Package changed during the build");
const browser = `relayswarm-hls-swarm-${version}.mjs`, wasm = `relayswarm-core-${version}.wasm`;
const result = await build({ entryPoints: [join(root, "src/browser/hls-swarm.mjs")], bundle: true,
  platform: "browser", format: "esm", target: "es2022", minify: true, metafile: true,
  outfile: join(out, browser) });
assert.ok(Object.values(result.metafile.outputs).every(({ imports }) => imports.length === 0), "Browser bundle has external runtime imports");
copyFileSync(join(root, "src/browser/relayswarm-core.wasm"), join(out, wasm));
const metadata = "BUILD-METADATA-javascript.json";
writeFileSync(join(out, metadata), JSON.stringify({ sourceCommit, packageVersion: version, node: process.version,
  packageMembers: packed.files.length, wasmSourceHash: coreSourceHash(root) }, null, 2) + "\n");
const assets = [packed.filename, browser, wasm, metadata];
writeFileSync(join(out, "SHA256SUMS"), assets.map((file) =>
  `${createHash("sha256").update(readFileSync(join(out, file))).digest("hex")}  ${file}`).join("\n") + "\n");
console.log(JSON.stringify({ sourceCommit, version, packageMembers: packed.files.length, assets: [...assets, "SHA256SUMS"] }, null, 2));
