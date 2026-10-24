#!/usr/bin/env node
// Build and package native core artefacts, or verify downloaded CI artefacts.
// No tags, releases or uploads are created by this script.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2];
if (!["apple", "android", "verify"].includes(command) || process.argv.length > 4) throw new Error("usage: package-core-release.mjs apple|android [output-dir] | verify [artefact-dir]");
const run = (program, args, options = {}) => execFileSync(program, args, { cwd: root, stdio: "pipe", maxBuffer: 64 * 1024 * 1024, ...options });
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});
const sourceCommit = run("git", ["rev-parse", "HEAD"]).toString().trim();

if (command === "verify") {
  const directory = resolve(process.argv[3] ?? join(root, "artifacts/core-release"));
  const files = walk(directory), allowed = new Set();
  for (const platform of ["apple", "android"]) {
    const matches = files.filter((path) => basename(path) === `SHA256SUMS-${platform}`);
    if (matches.length !== 1) throw new Error(`Expected one ${platform} checksum manifest`);
    allowed.add(matches[0]);
    const base = dirname(matches[0]), listed = new Set();
    for (const line of readFileSync(matches[0], "utf8").trim().split("\n")) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/u.exec(line);
      if (!match || listed.has(match[2])) throw new Error(`Invalid checksum row: ${line}`);
      listed.add(match[2]); allowed.add(join(base, match[2]));
      if (sha256(join(base, match[2])) !== match[1]) throw new Error(`Checksum mismatch: ${match[2]}`);
    }
    const expected = platform === "apple"
      ? ["relayswarm-core.xcframework.zip", "relayswarm-core.xcframework.zip.checksum", "relayswarm-core-swift-bindings.zip", "BUILD-METADATA-apple.json"]
      : ["relayswarm-core.aar", "BUILD-METADATA-android.json"];
    if (expected.length !== listed.size || expected.some((file) => !listed.has(file))) throw new Error(`Incomplete ${platform} artefacts`);
    const metadata = JSON.parse(readFileSync(join(base, `BUILD-METADATA-${platform}.json`)));
    if (metadata.sourceCommit !== sourceCommit || metadata.platform !== platform) throw new Error(`${platform} artefacts are not from this commit`);
    if (platform === "apple" && readFileSync(join(base, "relayswarm-core.xcframework.zip.checksum"), "utf8").trim() !== sha256(join(base, "relayswarm-core.xcframework.zip"))) throw new Error("SwiftPM checksum differs from the archive");
  }
  if (files.some((file) => !allowed.has(file))) throw new Error("Unexpected files beside the native artefacts");
  console.log(`Verified Apple and Android artefacts for ${sourceCommit}`);
  process.exit(0);
}

if (command === "apple" && process.platform !== "darwin") throw new Error("Apple packaging requires macOS and Xcode");
run("git", ["diff", "--exit-code", "HEAD", "--", "core"]);
const out = resolve(process.argv[3] ?? join(root, "artifacts/core-release", command));
// Each invocation owns these fixed output files, not the surrounding directory.
mkdirSync(out, { recursive: true });
const privatePaths = [homedir(), root, process.env.CARGO_HOME ?? join(homedir(), ".cargo")];
const inherited = process.env.CARGO_ENCODED_RUSTFLAGS?.split("\x1f") ?? (process.env.RUSTFLAGS ?? "").split(/\s+/u).filter(Boolean);
const flags = [...inherited, ...privatePaths.map((path, index) => `--remap-path-prefix=${path}=${["/build/home", "/relayswarm", "/cargo"][index]}`)];
const env = { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") };
run("npm", ["run", `build:ffi:${command}`], { env, stdio: "inherit" });
const outputFiles = [];
const safe = (paths) => {
  for (const file of paths) {
    const bytes = readFileSync(file);
    if (privatePaths.some((path) => bytes.includes(Buffer.from(path)))) throw new Error(`Native output contains a local source path: ${basename(file)}`);
  }
};
const zip = (name, cwd, inputs) => {
  const file = join(out, name);
  rmSync(file, { force: true });
  run("zip", ["-q", "-X", "-y", "-r", file, ...inputs], { cwd });
  run("unzip", ["-tq", file]); outputFiles.push(name); return file;
};
if (command === "apple") {
  const apple = join(root, "core/apple"), framework = "relayswarm_ffiFFI.xcframework";
  safe([...walk(join(apple, framework)), join(apple, "Sources/RelaySwarmCore/relayswarm_ffi.swift")]);
  // Compile the generated Swift wrapper against the actual packaged slices.
  run("swift", ["build", "--package-path", apple, "--configuration", "release"], { stdio: "inherit" });
  const archive = zip("relayswarm-core.xcframework.zip", apple, [framework]);
  const checksum = run("swift", ["package", "compute-checksum", archive]).toString().trim();
  if (!/^[a-f0-9]{64}$/u.test(checksum) || checksum !== sha256(archive)) throw new Error("SwiftPM checksum is invalid");
  writeFileSync(join(out, "relayswarm-core.xcframework.zip.checksum"), checksum + "\n");
  outputFiles.push("relayswarm-core.xcframework.zip.checksum");
  // Extract this beside the XCFramework to consume the existing path package.
  // Package.swift is copied as-is; no URL dependency is introduced.
  zip("relayswarm-core-swift-bindings.zip", apple, ["Package.swift", "Sources"]);
} else {
  const directory = join(root, "core/target/android"), library = join(directory, "relayswarm-core.aar");
  if (!existsSync(library)) throw new Error("The Android build left no AAR");
  safe(walk(join(directory, "aar")));
  const classes = run("unzip", ["-p", join(directory, "aar/classes.jar")]);
  if (privatePaths.some((path) => classes.includes(Buffer.from(path)))) throw new Error("Android classes contain a local source path");
  const entries = run("unzip", ["-Z1", library]).toString().split("\n");
  for (const file of ["AndroidManifest.xml", "classes.jar", "proguard.txt", ...["arm64-v8a", "armeabi-v7a", "x86_64"].map((abi) => `jni/${abi}/librelayswarm_ffi.so`)]) {
    if (!entries.includes(file)) throw new Error(`AAR is missing ${file}`);
  }
  run("unzip", ["-tq", library]);
  cpSync(library, join(out, "relayswarm-core.aar")); outputFiles.push("relayswarm-core.aar");
}
const metadata = `BUILD-METADATA-${command}.json`;
writeFileSync(join(out, metadata), JSON.stringify({ sourceCommit, platform: command, packageVersion: JSON.parse(readFileSync(join(root, "package.json"))).version,
  node: process.version, rust: run("rustc", ["--version"], { cwd: join(root, "core") }).toString().trim() }, null, 2) + "\n");
outputFiles.push(metadata);
writeFileSync(join(out, `SHA256SUMS-${command}`), outputFiles.map((file) => `${sha256(join(out, file))}  ${file}`).join("\n") + "\n");
console.log(`Packaged ${command}: ${outputFiles.join(", ")}`);
