#!/usr/bin/env node
// Apply the review proposal only to this task-owned snapshot and test it.
// This script never changes a separate RelaySwarmKit checkout or public branch.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
const execute = promisify(execFile), revision = "7eb042ee0fc0e960780c61d755a2ec50f1a8be40", scratch = resolve("artifacts/protocol-swift-kit");
const patchPath = resolve("docs/interop/relayswarm-kit-v3.patch"), receiptPath = resolve("artifacts/relayswarm-kit-v3-proposal-tests.json");
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Proposed full Kit transport tests require macOS arm64.");
let recorded = false;
try {
  const resume = process.argv.includes("--resume");
  if (!resume) {
  await execute(process.execPath, ["scripts/protocol-fetch-swift-kit.mjs", scratch], { timeout: 120000, maxBuffer: 1024 * 1024 });
  const tree = JSON.parse((await execute("gh", ["api", `repos/forgesworn/relayswarm-kit/git/trees/${revision}?recursive=1`], { timeout: 30000 })).stdout);
  for (const entry of tree.tree.filter((item) => item.type === "blob" && (item.path.startsWith("Tests/") || item.path.startsWith("Sources/RelaySwarmTestSupport/")))) {
    const { stdout } = await execute("gh", ["api", "--header", "Accept: application/vnd.github.raw", `repos/forgesworn/relayswarm-kit/contents/${entry.path}?ref=${revision}`], { timeout: 30000, maxBuffer: 1024 * 1024 });
    const file = join(scratch, entry.path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, stdout);
  }
  }
  const provenance = JSON.parse(await readFile(join(scratch, "source-provenance.json"), "utf8"));
  const expected = JSON.parse(await readFile("docs/interop/relayswarm-kit-v3-sources.json", "utf8"));
  const patch = await readFile(patchPath);
  if (createHash("sha256").update(patch).digest("hex") !== expected.patchSha256) throw new Error("Proposal patch differs from its review manifest.");
  for (const [path, hashes] of Object.entries(expected.files)) if (!resume && hashes.originalSha256 !== null) {
    const source = await readFile(join(scratch, path));
    if (createHash("sha256").update(source).digest("hex") !== hashes.originalSha256) throw new Error(`Proposal base source mismatch: ${path}`);
  }
  if (!resume) await execute("patch", ["-p1", "--batch", "-d", scratch, "-i", patchPath], { timeout: 10000 });
  for (const [path, hashes] of Object.entries(expected.files)) {
    const source = await readFile(join(scratch, path));
    if (createHash("sha256").update(source).digest("hex") !== hashes.proposedSha256) throw new Error(`Proposal result differs from review source: ${path}`);
  }
  // Use the same pinned dependency and actual Kit target graph; the unrelated
  // stock-v2 interop executable is deliberately not a target in this proposal.
  await writeFile(join(scratch, "Package.swift"), `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "RelaySwarmKitReview", platforms: [.macOS(.v14)],
  dependencies: [.package(url: "https://github.com/21-DOT-DEV/swift-secp256k1.git", revision: "${provenance.secpRevision}")], targets: [
    .target(name: "RelaySwarmSignalling", dependencies: [.product(name: "P256K", package: "swift-secp256k1")]),
    .binaryTarget(name: "CDataChannel", path: "build/DataChannel.xcframework"),
    .target(name: "RelaySwarmTransport", dependencies: ["RelaySwarmSignalling", "CDataChannel"], linkerSettings: [.linkedLibrary("c++")]),
    .target(name: "RelaySwarmTestSupport", dependencies: ["RelaySwarmSignalling"]),
    .testTarget(name: "RelaySwarmSignallingTests", dependencies: ["RelaySwarmSignalling", "RelaySwarmTestSupport"]),
    .testTarget(name: "RelaySwarmTransportTests", dependencies: ["RelaySwarmTransport", "RelaySwarmTestSupport"])
  ])
`);
  const output = await execute("swift", ["test", "--package-path", scratch, "--jobs", "4"], { timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
  const receipt = { v: 1, measuredAt: new Date().toISOString(), baseKitRevision: revision, patchSha256: expected.patchSha256,
    externalRepositoryChanged: false, published: false, scope: "Proposed SDK wire-v3 migration tested in task-owned snapshot only", output: output.stdout + output.stderr };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`); recorded = true;
  console.log(JSON.stringify({ ok: true, baseKitRevision: revision, patchSha256: expected.patchSha256, receiptPath, externalRepositoryChanged: false }));
} catch (error) {
  process.stderr.write(String(error.stdout ?? "") + String(error.stderr ?? "")); throw error;
} finally {
  // Preserve owned scratch on failure for diagnosis/reuse. Remove it only
  // after the concrete review receipt is recorded; no unrelated paths touched.
  if (recorded) await rm(scratch, { recursive: true, force: true });
}
