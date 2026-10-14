import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { posix } from "node:path";
import { performance } from "node:perf_hooks";

const tools = new Set(["/bin/df", "/usr/sbin/diskutil", "/usr/bin/plutil"]);
const diskNode = /^\/dev\/disk[0-9]+(?:s[0-9]+){0,4}$/u;
const clock = () => performance.now();
const toolFailures = new Set(["tool-deadline", "tool-input", "tool-launch", "tool-output", "tool-exit", "tool-reap"]);

// One original deadline includes launch, bounded reads and child reaping. No
// paths, tool output or underlying OS error messages escape the verifier.
export async function readFilesystemTool(file, args, input, { end, now = clock, spawnProcess = spawn } = {}) {
  if (!tools.has(file) || !Number.isFinite(end) || now() >= end - 250) throw new Error("tool-deadline");
  if (input !== undefined && (typeof input !== "string" || Buffer.byteLength(input) > 32768)) throw new Error("tool-input");
  return await new Promise((done, reject) => {
    let child, timer, reapTimer, failure = null, stdout = [], outBytes = 0, errBytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(reapTimer);
      if (error) reject(error); else done(value);
    };
    const stop = (code) => {
      failure ??= new Error(code);
      try { child.kill("SIGKILL"); } catch { /* close/error still decides ownership */ }
    };
    try {
      // Recheck immediately before the only child-creating operation.
      if (now() >= end - 250) { finish(new Error("tool-deadline")); return; }
      child = spawnProcess(file, args, { stdio: ["pipe", "pipe", "pipe"], shell: false, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" } });
      child.once("error", () => { failure ??= new Error("tool-launch"); });
      child.once("close", (code, signal) => finish(failure || (now() >= end ? new Error("tool-deadline") : code !== 0 || signal ? new Error("tool-exit") : null), Buffer.concat(stdout).toString("utf8")));
      timer = setTimeout(() => stop("tool-deadline"), Math.max(0, end - 250 - now()));
      // Install the owning reap timer before any pipe setup can fail.
      reapTimer = setTimeout(() => { stop("tool-deadline"); finish(new Error("tool-reap")); }, Math.max(0, end - now()));
      child.stdout.on("data", (chunk) => {
        outBytes += chunk.length;
        if (outBytes > 32768) stop("tool-output"); else stdout.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => { errBytes += chunk.length; if (errBytes > 4096) stop("tool-output"); });
      child.stdout.on("error", () => stop("tool-output"));
      child.stderr.on("error", () => stop("tool-output"));
      child.stdin.on("error", () => stop("tool-input"));
      // Failure to observe close inside the original reap reserve is UNKNOWN,
      // never a successful probe. SIGKILL has already been attempted.
      child.stdin.end(input);
    } catch {
      if (!child) finish(new Error("tool-launch"));
      else stop("tool-launch");
    }
  });
}

const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.rdev === b.rdev;
const directorySafe = (v, uid) => v.isDirectory() && !(v.mode & 0o022) && v.uid === uid;

/** Private Darwin-only proof; injected IO is for deterministic contract tests. */
export async function verifyDarwinStateFilesystem(parent, original, numericType, {
  inspect = lstat, canonical = realpath, run = readFilesystemTool, now = clock,
  uid = process.getuid?.(), end = now() + 5000,
} = {}) {
  let stage = "parent";
  const checkTime = () => { if (now() >= end - 250) throw new Error("deadline"); };
  try {
    checkTime();
    if (!directorySafe(original, uid) || await canonical(parent) !== parent || !same(original, await inspect(parent))) throw new Error("parent");
    stage = "df"; checkTime();
    const df = await run("/bin/df", ["-P", parent], undefined, { end, now }); checkTime();
    const lines = df.trim().split(/\r?\n/u);
    const row = lines.length === 2 && lines[1].match(/^(\/dev\/disk[0-9]+(?:s[0-9]+){0,4})\s+\d+\s+\d+\s+\d+\s+\d+%\s+(.+)$/u);
    if (!row) throw new Error("shape");
    const [, device, mount] = row;
    stage = "device"; checkTime();
    const beforeDevice = await inspect(device);
    if (!diskNode.test(device) || !beforeDevice.isBlockDevice() || await canonical(device) !== device || beforeDevice.rdev !== original.dev) throw new Error("device");
    stage = "diskutil"; checkTime();
    const plist = await run("/usr/sbin/diskutil", ["info", "-plist", device], undefined, { end, now }); checkTime();
    stage = "plist";
    const json = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], plist, { end, now }); checkTime();
    const info = JSON.parse(json);
    if (!info || Array.isArray(info) || !["apfs", "hfs"].includes(info.FilesystemType) || info.GlobalPermissionsEnabled !== true || info.Writable !== true) throw new Error("unsupported");
    stage = "identity";
    if (info.DeviceNode !== device || info.MountPoint !== mount || typeof mount !== "string" || !mount.startsWith("/") || posix.resolve(mount) !== mount) throw new Error("identity");
    const mounted = await inspect(mount), finalDevice = await inspect(info.DeviceNode), finalParent = await inspect(parent);
    if (!mounted.isDirectory() || mounted.dev !== original.dev || await canonical(mount) !== mount || !same(beforeDevice, finalDevice) || !finalDevice.isBlockDevice() || finalDevice.rdev !== original.dev || !same(original, finalParent) || !directorySafe(finalParent, uid) || await canonical(parent) !== parent) throw new Error("identity");
    checkTime();
    // APFS firmlinks need not share a textual prefix with MountPoint; the
    // exact block-device and st_dev equality above establish that binding.
    return Object.freeze({ platform: "darwin", numericType, filesystem: info.FilesystemType, proof: "same-device-named-filesystem" });
  } catch (cause) {
    const reason = toolFailures.has(cause?.message) ? cause.message : "verification";
    const error = new Error(`State lease refuses unsupported or distributed filesystems (platform=darwin type=${Number.isSafeInteger(numericType) ? numericType : "unknown"} stage=${stage} reason=${reason}).`);
    error.code = "ERR_STATE_FILESYSTEM";
    error.filesystem = Object.freeze({ platform: "darwin", numericType: Number.isSafeInteger(numericType) ? numericType : null, stage, reason });
    throw error;
  }
}
