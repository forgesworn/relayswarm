#!/usr/bin/env node
// A pinned, hash-verified test dependency. It is not part of the browser bundle.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, rm, realpath, lstat, mkdtemp, rename } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const version = "1.21.2";
const assets = {
  "darwin-arm64": "7d0d0c5c11527cbd10bde1c3d728864eb0334a9b653566cd73c0259750cbf093",
  "darwin-x64": "87a00062b6a588aa1158f875504a3b56c80d62e2611dc450b83d0534e1b49198",
  "linux-x64": "121be6e00397e473a95d83c75f4fcd3819a6af3b0e1a50889cba43ab4fab6a27",
  "linux-arm64": "180a235374a548d9133cdd5e20f5dbd8b01317be1c86e0d7e66df585dc42ed6f",
};
const key = `${process.platform}-${process.arch}`, checksum = assets[key];
if (!checksum) throw new Error("Pinned MediaMTX test install supports macOS/Linux x64 and arm64. Supply MEDIAMTX_PATH on another platform.");
const directory = resolve(`artifacts/tools/mediamtx-v${version}`), executable = join(directory, "mediamtx"), receipt = join(directory, "verified.json");
await mkdir(directory, { recursive: true, mode: 0o700 });
const directoryStat = await lstat(directory);
if (!directoryStat.isDirectory() || await realpath(directory) !== directory || (directoryStat.mode & 0o022) || (typeof process.getuid === "function" && directoryStat.uid !== process.getuid())) throw new Error("MediaMTX cache must be owner-controlled without symlinks.");
await chmod(directory, 0o700);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let verified = false;
try {
  const previousStat = await lstat(receipt), binaryStat = await lstat(executable);
  if (!previousStat.isFile() || previousStat.size > 4096 || previousStat.nlink !== 1 || (previousStat.mode & 0o777) !== 0o600 || !binaryStat.isFile() || binaryStat.nlink !== 1 || (binaryStat.mode & 0o022)
      || (typeof process.getuid === "function" && (previousStat.uid !== process.getuid() || binaryStat.uid !== process.getuid()))) throw new Error("Untrusted cache.");
  // A cache receipt is trusted local state, not independent upstream proof.
  const previous = JSON.parse(await readFile(receipt, "utf8")); verified = previous.archiveSha256 === checksum && previous.binarySha256 === hash(await readFile(executable));
} catch {}
if (!verified) {
  const arch = process.arch === "x64" ? "amd64" : "arm64", filename = `mediamtx_v${version}_${process.platform}_${arch}.tar.gz`;
  const response = await fetch(`https://github.com/bluenviron/mediamtx/releases/download/v${version}/${filename}`, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`MediaMTX download failed (${response.status}).`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error("Excessive MediaMTX archive."); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== checksum) throw new Error("MediaMTX archive failed its pinned SHA-256 check.");
  const archive = join(directory, `${randomBytes(8).toString("hex")}.tar.gz`);
  const extraction = await mkdtemp(join(directory, "verified-"));
  try {
    await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
    const result = spawnSync("tar", ["-xzf", archive, "-C", extraction, "mediamtx"], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Could not extract MediaMTX.");
    const extracted = join(extraction, "mediamtx");
    if (!(await lstat(extracted)).isFile()) throw new Error("Verified archive did not contain a regular binary.");
    await chmod(extracted, 0o700);
    const verifiedReceipt = join(extraction, "verified.json");
    await writeFile(verifiedReceipt, JSON.stringify({ version, archiveSha256: checksum, binarySha256: hash(await readFile(extracted)) }) + "\n", { flag: "wx", mode: 0o600 });
    await rename(extracted, executable);
    await rename(verifiedReceipt, receipt);
  } finally { await rm(archive, { force: true }); await rm(extraction, { recursive: true, force: true }); }
}
console.log(executable);
