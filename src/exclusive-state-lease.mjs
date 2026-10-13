import { constants } from "node:fs";
import { open, lstat, realpath, statfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";

// Local Linux filesystems plus macOS HFS/APFS. Distributed volumes cannot
// provide the file-locking guarantee used here and are refused explicitly.
const localFilesystems = new Set([0xef53, 0x9123683e, 0x58465342, 0x01021994, 0x794c7630, 0x2fc12fc1, 0x1a, 0x11]);

/** Hold a kernel-backed SQLite EXCLUSIVE transaction on a permanent inode. */
export async function acquireExclusiveStateLease(path) {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Automatic state recovery requires a supported local POSIX filesystem.");
  const target = resolve(path), parent = dirname(target), directory = await lstat(parent);
  if (!directory.isDirectory() || await realpath(parent) !== parent || directory.mode & 0o022 || process.getuid && directory.uid !== process.getuid()) throw new Error("State lease requires an owner-controlled directory without symlinks.");
  if (!localFilesystems.has((await statfs(parent)).type)) throw new Error("State lease refuses unsupported or distributed filesystems.");
  const safe = (stat) => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && (!process.getuid || stat.uid === process.getuid()) && stat.size <= 1024 * 1024;
  let handle;
  try { handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); await handle.sync(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { await handle?.close(); }
  const before = await lstat(target);
  if (!safe(before)) throw new Error("State lease must be a private single-link regular file.");
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    try { if (!safe(await lstat(`${target}${suffix}`))) throw new Error("Unsafe state lease sidecar."); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  let database;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(target, { timeout: 0 });
    database.exec("PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;");
    const after = await lstat(target);
    if (!safe(after) || before.dev !== after.dev || before.ino !== after.ino) throw new Error("State lease inode changed while acquiring ownership.");
  } catch (error) { database?.close(); throw new Error("State is locked or its exclusive lease cannot be safely acquired.", { cause: error }); }
  let closed = false;
  return { inode: before.ino, device: before.dev, close() { if (closed) return; closed = true; try { database.exec("ROLLBACK"); } finally { database.close(); } } };
}
