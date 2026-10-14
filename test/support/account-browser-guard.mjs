// Test-fixture ownership and deadlines. No browser or process starts on import.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { openSync, writeFileSync, fsyncSync, closeSync, lstatSync, realpathSync } from "node:fs";

export const now = () => process.hrtime.bigint();
export const stamp = () => new Date().toISOString();
export function deadlines(start = now()) {
  return Object.fromEntries(Object.entries({ work: 150000, grace: 165000, reap: 175000, whole: 180000 }).map(([key, ms]) => [key, String(start + BigInt(ms) * 1000000n)]));
}
export function cap(clock, phase, maximum, at = now()) {
  const remaining = Number((BigInt(clock[phase]) - at) / 1000000n);
  assert.ok(Number.isFinite(maximum) && maximum > 0 && remaining > 0, "Original fixture deadline expired");
  return Math.min(Math.floor(maximum), remaining);
}
export async function bounded(operation, clock, phase, maximum) {
  const ms = cap(clock, phase, maximum);
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture operation deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}
export function journal(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
export function birth(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "pgid=", "-o", "lstart="], { encoding: "utf8", timeout: 500, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!value) return null;
    const match = /^(\d+)\s+(.+)$/u.exec(value); assert.ok(match);
    return { pid, pgid: Number(match[1]), birth: match[2] };
  } catch (error) { if (error.status === 1 && !String(error.stdout ?? "").trim() && !String(error.stderr ?? "").trim()) return null; throw error; }
}
export function groupAbsent(id, kill = process.kill) {
  assert.ok(Number.isSafeInteger(id) && id > 1 && id !== process.pid);
  try { kill(-id, 0); return false; } catch (error) {
    if (error.code === "ESRCH") return true;
    // Permission failure does not establish absence. Darwin can also report
    // this while a group has no signal-eligible members; await explicit ESRCH.
    if (error.code === "EPERM") return false;
    throw error;
  }
}
export function signalOwned(owner, signal, { kill = process.kill, readBirth = birth } = {}) {
  assert.ok(owner && owner.pid === owner.pgid && owner.pid !== process.pid);
  if (groupAbsent(owner.pgid, kill)) return false;
  const live = readBirth(owner.pid);
  assert.ok(live && live.pgid === owner.pgid && live.birth === owner.birth, "Owned group leader identity changed");
  try { kill(-owner.pgid, signal); return true; } catch (error) {
    if (error.code === "ESRCH" || error.code === "EPERM") return false;
    throw error;
  }
}
export async function reapOwned(owner, clock, operations) {
  if (!owner) return null;
  if (groupAbsent(owner.pgid, operations?.kill)) return true;
  const leader = (operations?.readBirth ?? birth)(owner.pid);
  if (!leader) {
    const absentEnd = now() + BigInt(cap(clock, "reap", 1500)) * 1000000n;
    while (!groupAbsent(owner.pgid, operations?.kill) && now() < absentEnd) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(groupAbsent(owner.pgid, operations?.kill), "Owned group leader absent; remaining group ownership UNKNOWN");
    return true;
  }
  signalOwned(owner, "SIGTERM", operations);
  const termEnd = now() + BigInt(cap(clock, "reap", 1500)) * 1000000n;
  while (!groupAbsent(owner.pgid, operations?.kill) && now() < termEnd) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!groupAbsent(owner.pgid, operations?.kill)) signalOwned(owner, "SIGKILL", operations);
  while (!groupAbsent(owner.pgid, operations?.kill)) { cap(clock, "reap", 100); await new Promise((resolve) => setTimeout(resolve, 25)); }
  return true;
}
export function identity(path) {
  const stat = lstatSync(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path && (stat.mode & 0o777) === 0o700);
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid };
}
export function sameDirectory(path, expected) { assert.deepEqual(identity(path), expected); }
