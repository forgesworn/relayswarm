import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, realpath, lstat, statfs, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { verifyDarwinStateFilesystem, readFilesystemTool } from "../src/private-state-filesystem.mjs";
import { acquireExclusiveStateLease } from "../src/exclusive-state-lease.mjs";

function fixture() {
  let at = 0;
  const parent = "/private/fixture", mount = "/System/Volumes/Data", device = "/dev/disk3s5";
  const dir = { dev: 77, ino: 9, mode: 0o40700, uid: 501, rdev: 0, isDirectory: () => true };
  const block = { dev: 1, ino: 12, mode: 0o60600, uid: 0, rdev: 77, isBlockDevice: () => true };
  const info = { FilesystemType: "apfs", DeviceNode: device, MountPoint: mount, GlobalPermissionsEnabled: true, Writable: true };
  const calls = [], objects = new Map([[parent, dir], [mount, { ...dir, ino: 10 }], [device, block]]);
  const options = {
    uid: 501, now: () => at, end: 5000,
    inspect: async (path) => { if (!objects.has(path)) throw new Error("private path"); return objects.get(path); },
    canonical: async (path) => path,
    run: async (file, args, input, config) => {
      calls.push({ file, args, input, end: config.end });
      if (file === "/bin/df") return `Filesystem 512-blocks Used Available Capacity Mounted on\n${device} 100 10 90 10% ${mount}\n`;
      if (file === "/usr/sbin/diskutil") return "private plist";
      return JSON.stringify(info);
    },
  };
  return { parent, mount, device, dir, block, info, calls, objects, options, advance: (value) => { at = value; }, verify: () => verifyDarwinStateFilesystem(parent, dir, 0x1a, options) };
}

test("Darwin named proof binds devices across firmlinks, with one unchanged deadline", async () => {
  const f = fixture();
  assert.equal(f.parent.startsWith(f.mount), false);
  assert.deepEqual(await f.verify(), { platform: "darwin", numericType: 26, filesystem: "apfs", proof: "same-device-named-filesystem" });
  assert.deepEqual(f.calls.map((v) => v.file), ["/bin/df", "/usr/sbin/diskutil", "/usr/bin/plutil"]);
  assert.deepEqual(f.calls.map((v) => v.end), [5000, 5000, 5000]);
  f.info.FilesystemType = "hfs"; assert.equal((await f.verify()).filesystem, "hfs");
});

test("Darwin registration-number collisions never authorise unsupported names or permissions", async () => {
  for (const name of ["nfs", "smbfs", "tmpfs", "APFS", "", null]) {
    const f = fixture(); f.info.FilesystemType = name;
    await assert.rejects(f.verify(), { code: "ERR_STATE_FILESYSTEM" });
  }
  for (const field of ["GlobalPermissionsEnabled", "Writable"]) {
    for (const value of [false, undefined, "true", 1]) {
      const f = fixture(); f.info[field] = value; await assert.rejects(f.verify());
    }
  }
});

test("Darwin refuses forged devices, stale parent identity, mismatched mounts and non-block sources", async () => {
  const mutations = [
    (f) => { f.block.rdev = 78; },
    (f) => { f.block.isBlockDevice = () => false; },
    (f) => { f.info.DeviceNode = "/dev/disk4s5"; },
    (f) => { f.info.MountPoint = "/unrelated"; },
    (f) => { f.objects.set(f.mount, { ...f.dir, dev: 78 }); },
    (f) => { f.objects.set(f.parent, { ...f.dir, ino: 99 }); },
    (f) => { f.options.canonical = async () => "/symlink-target"; },
    (f) => { const inspect = f.options.inspect; let visits = 0; f.options.inspect = async (path) => path === f.parent && ++visits > 1 ? { ...f.dir, ino: 88 } : inspect(path); },
    (f) => { const inspect = f.options.inspect; let visits = 0; f.options.inspect = async (path) => path === f.device && ++visits > 1 ? { ...f.block, ino: 88 } : inspect(path); },
    (f) => { f.options.run = async () => "Filesystem\nserver:/remote 100 10 90 10% /remote\n"; },
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); await assert.rejects(f.verify()); }
});

test("Darwin expiry, malformed tool data and tool failures refuse without leaking values", async () => {
  for (const run of [async () => { throw new Error("SECRET device/path"); }, async () => "not df", async () => "x".repeat(32769)]) {
    const f = fixture(); f.options.run = run;
    await assert.rejects(f.verify(), (error) => error.code === "ERR_STATE_FILESYSTEM" && !/SECRET|device\/path|not df|xxx/u.test(JSON.stringify(error) + error.message));
  }
  const f = fixture(), originalRun = f.options.run;
  f.options.run = async (...args) => { const result = await originalRun(...args); f.advance(5000); return result; };
  await assert.rejects(f.verify()); assert.equal(f.calls.length, 1);
});

function fakeSpawn(action) {
  const observations = { spawned: 0, kills: 0, closed: 0 };
  return { observations, spawnProcess() {
    observations.spawned++;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const close = (code = 0, signal = null) => { observations.closed++; child.emit("close", code, signal); };
    child.kill = () => { observations.kills++; queueMicrotask(() => close(null, "SIGKILL")); return true; };
    queueMicrotask(() => action(child, close)); return child;
  } };
}

test("bounded tools reject stdout/stderr overflow only after observing owned-child close", async () => {
  for (const [stream, size] of [["stdout", 32769], ["stderr", 4097]]) {
    const fake = fakeSpawn((child) => child[stream].emit("data", Buffer.alloc(size)));
    await assert.rejects(readFilesystemTool("/bin/df", ["-P", "/fixture"], undefined, { end: performance.now() + 1000, ...fake }), /tool-output/u);
    assert.deepEqual(fake.observations, { spawned: 1, kills: 1, closed: 1 });
  }
});

test("bounded tools refuse expired launch, nonzero exit and hung reads within original reap envelope", async () => {
  let spawned = 0;
  await assert.rejects(readFilesystemTool("/bin/df", [], undefined, { end: 250, now: () => 0, spawnProcess: () => { spawned++; } })); assert.equal(spawned, 0);
  let reads = 0;
  await assert.rejects(readFilesystemTool("/bin/df", [], undefined, { end: 1000, now: () => ++reads === 1 ? 0 : 1000, spawnProcess: () => { spawned++; } }), /tool-deadline/u); assert.equal(spawned, 0);
  await assert.rejects(readFilesystemTool("/usr/bin/plutil", [], "x".repeat(32769), { end: 1000, now: () => 0, spawnProcess: () => { spawned++; } }), /tool-input/u); assert.equal(spawned, 0);
  const failure = fakeSpawn((_child, close) => close(1));
  await assert.rejects(readFilesystemTool("/bin/df", [], undefined, { end: performance.now() + 1000, ...failure }), /tool-exit/u);
  const hung = fakeSpawn(() => {}), started = performance.now();
  await assert.rejects(readFilesystemTool("/bin/df", [], undefined, { end: started + 300, ...hung }), /tool-deadline/u);
  assert.equal(hung.observations.kills, 1); assert.equal(hung.observations.closed, 1);
  assert.ok(performance.now() - started < 1000);
});

test("bounded tools retain unobserved reaping as a distinct safe refusal", async () => {
  const fake = fakeSpawn((child) => { child.kill = () => { fake.observations.kills++; return true; }; });
  await assert.rejects(readFilesystemTool("/bin/df", [], undefined, { end: performance.now() + 300, ...fake }), /tool-reap/u);
  assert.equal(fake.observations.closed, 0);
  const f = fixture(); f.options.run = async () => { throw new Error("tool-reap"); };
  await assert.rejects(f.verify(), (error) => error.filesystem.reason === "tool-reap" && error.filesystem.stage === "df");
});

test("real private temporary lease reacquires the permanent inode with safe filesystem diagnostics", { skip: !["linux", "darwin"].includes(process.platform), timeout: 20000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-fs-proof-")));
  let first, second;
  t.after(async () => { first?.close(); second?.close(); await rm(directory, { recursive: true, force: true }); });
  const type = (await statfs(directory)).type;
  if (process.platform === "darwin") {
    const proof = await verifyDarwinStateFilesystem(directory, await lstat(directory), type);
    t.diagnostic(JSON.stringify(proof));
  } else t.diagnostic(JSON.stringify({ platform: "linux", numericType: type, proof: "existing-linux-magic-policy" }));
  first = await acquireExclusiveStateLease(join(directory, "lease")); const inode = first.inode; first.close();
  second = await acquireExclusiveStateLease(join(directory, "lease")); assert.equal(second.inode, inode); second.close();
});
