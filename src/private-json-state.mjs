import { constants } from "node:fs";
import { open, lstat, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Bounded private snapshots. A single owner must hold the enclosing service lease. */
export async function openPrivateJsonState(path, { maxBytes = 2 * 1024 * 1024 } = {}) {
  if (process.platform === "win32") throw new Error("Private durable state requires POSIX permissions.");
  const target = resolve(path), parent = dirname(target), directory = await lstat(parent);
  if (!directory.isDirectory() || await realpath(parent) !== parent || (directory.mode & 0o077) || process.getuid && directory.uid !== process.getuid()) throw new Error("Durable state requires a private owner-controlled directory without symlinks.");
  const safe = (stat) => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600 && (!process.getuid || stat.uid === process.getuid()) && stat.size <= maxBytes;
  async function read() {
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await handle.stat(); if (!safe(before)) throw new Error("Unsafe durable state file.");
      const buffer = Buffer.alloc(maxBytes + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const after = await handle.stat(), current = await lstat(target);
      if (bytesRead !== before.size || bytesRead > maxBytes || !safe(after) || !safe(current) || current.ino !== before.ino || current.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Durable state changed while reading.");
      return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    finally { await handle?.close(); }
  }
  async function write(value) {
    const text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Durable state capacity exceeded.");
    try { if (!safe(await lstat(target))) throw new Error("Unsafe durable state file."); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, target);
      const parentHandle = await open(parent, constants.O_RDONLY); try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    } finally { await handle?.close(); await rm(temporary, { force: true }); }
  }
  return { read, write };
}
