#!/usr/bin/env node
// Downloads a pinned, read-only public toolkit snapshot into task-owned scratch.
// No external checkout is modified. Remove this scratch after recording evidence.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
export const KIT_REVISION = "7eb042ee0fc0e960780c61d755a2ec50f1a8be40";
export const SECP_REVISION = "8c62aba8a3011c9bcea232e5ee007fb0b34a15e2";
const destination = resolve(process.argv[2] ?? "artifacts/protocol-swift-kit");
const ownership = "relayswarm-protocol-interop-scratch-v1\n";
const existing = await stat(destination).catch(() => null);
const marker = await readFile(join(destination, ".task-owned-scratch"), "utf8").catch(() => null);
const oldProvenance = await readFile(join(destination, "source-provenance.json"), "utf8").then(JSON.parse).catch(() => null);
if (existing && marker !== ownership && oldProvenance?.kitRevision !== KIT_REVISION) throw new Error("Refusing to reuse an unowned interop scratch directory.");
await mkdir(destination, { recursive: true });
await writeFile(join(destination, ".task-owned-scratch"), ownership);
if (oldProvenance?.kitRevision === KIT_REVISION && oldProvenance?.secpRevision === SECP_REVISION) {
  let verified = true;
  for (const [path, hash] of Object.entries(oldProvenance.sourceFilesSha256)) {
    const bytes = await readFile(join(destination, path)).catch(() => null);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hash) { verified = false; break; }
  }
  if (verified) {
    await writeFile(join(destination, "Sources/InteropHarness/main.swift"), await readFile("test/interop-swift/main.swift"));
    console.log(JSON.stringify({ kitRevision: KIT_REVISION, destination, sourceCacheVerified: true }));
    process.exit(0);
  }
}
const tree = JSON.parse(execFileSync("gh", ["api", `repos/forgesworn/relayswarm-kit/git/trees/${KIT_REVISION}?recursive=1`], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
const selected = tree.tree.filter((entry) => entry.type === "blob" && (entry.path.startsWith("Sources/RelaySwarmSignalling/")
  || entry.path.startsWith("Sources/RelaySwarmTransport/") || entry.path.startsWith("build/DataChannel.xcframework/")
  || ["LICENSE", "build/DataChannel.provenance"].includes(entry.path)));
const hashes = {};
for (const entry of selected) {
  const file = join(destination, entry.path);
  await mkdir(dirname(file), { recursive: true });
  const bytes = execFileSync("gh", ["api", "--header", "Accept: application/vnd.github.raw", `repos/forgesworn/relayswarm-kit/contents/${entry.path}?ref=${KIT_REVISION}`], { maxBuffer: 64 * 1024 * 1024 });
  await writeFile(file, bytes);
  hashes[entry.path] = createHash("sha256").update(bytes).digest("hex");
}
await mkdir(join(destination, "Sources/InteropHarness"), { recursive: true });
await writeFile(join(destination, "Sources/InteropHarness/main.swift"), await readFile("test/interop-swift/main.swift"));
await writeFile(join(destination, "Package.swift"), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "RelaySwarmInteropFixture", platforms: [.macOS(.v14)],
  products: [.executable(name: "interop-harness", targets: ["InteropHarness"])],
  dependencies: [.package(url: "https://github.com/21-DOT-DEV/swift-secp256k1.git", revision: "${SECP_REVISION}")],
  targets: [
    .target(name: "RelaySwarmSignalling", dependencies: [.product(name: "P256K", package: "swift-secp256k1")]),
    .binaryTarget(name: "CDataChannel", path: "build/DataChannel.xcframework"),
    .target(name: "RelaySwarmTransport", dependencies: ["RelaySwarmSignalling", "CDataChannel"], linkerSettings: [.linkedLibrary("c++")]),
    .executableTarget(name: "InteropHarness", dependencies: ["RelaySwarmSignalling", "RelaySwarmTransport"])
  ])
`);
await writeFile(join(destination, "source-provenance.json"), JSON.stringify({ kitRevision: KIT_REVISION, secpRevision: SECP_REVISION, sourceFilesSha256: hashes }, null, 2));
console.log(JSON.stringify({ kitRevision: KIT_REVISION, destination, fetchedFiles: selected.length }));
