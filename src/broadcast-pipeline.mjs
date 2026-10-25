import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile, rename, readdir, lstat, realpath, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";

import { startBroadcastWorkerControl } from "./broadcast-worker-control.mjs";
import { acquireExclusiveStateLease } from "./exclusive-state-lease.mjs";

const RENDITIONS = Object.freeze([
  Object.freeze({ name: "low", width: 640, height: 360, bitrate: 700, bandwidth: 850000 }),
  Object.freeze({ name: "high", width: 1280, height: 720, bitrate: 2500, bandwidth: 2800000 }),
]);
const localHost = (value) => ["localhost", "127.0.0.1", "[::1]"].includes(value);
const inspectExecutable = promisify(execFile);

function requireTlsHostname(url) {
  if (url.protocol !== "rtmps:") return;
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  // HTTP URL parsing also normalises alternate IPv4 spellings such as 127.1.
  let normalised;
  try { normalised = new URL(`http://${url.hostname}/`).hostname; } catch { throw new Error("RTMPS requires a DNS hostname for verified TLS."); }
  if (isIP(hostname) || isIP(normalised)) throw new Error("RTMPS requires a DNS hostname for verified TLS.");
}

async function requireVerifiedTlsBuild(ffmpeg) {
  const unsafe = () => new Error("RTMPS requires FFmpeg 5+ with GnuTLS or FFmpeg 8+ with OpenSSL; its TLS capabilities could not be safely verified.");
  let stdout;
  try {
    ({ stdout } = await inspectExecutable(ffmpeg, ["-version"], { encoding: "utf8", timeout: 5000, maxBuffer: 32768, killSignal: "SIGKILL", windowsHide: true }));
  } catch { throw unsafe(); }
  const major = Number(stdout.match(/^ffmpeg version (\d+)(?:[.\s-]|$)/mu)?.[1]);
  const configuration = stdout.match(/^configuration:\s*(.*)$/mu)?.[1] ?? "";
  const gnutls = /(?:^|\s)--enable-gnutls(?:\s|$)/u.test(configuration);
  const openssl = /(?:^|\s)--enable-openssl(?:\s|$)/u.test(configuration);
  if (!Number.isSafeInteger(major) || !(major >= 5 && gnutls || major >= 8 && openssl)) throw unsafe();
}

function inputAddress(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Broadcast input must be an explicit network URL."); }
  if (url.protocol === "rtsps:") throw new Error("RTSPS input is unsupported because TLS verification is not portable across supported FFmpeg versions.");
  if (!["rtsp:", "rtmp:", "rtmps:", "srt:"].includes(url.protocol) || !url.hostname || url.hash) throw new Error("Unsupported broadcast input protocol.");
  requireTlsHostname(url);
  return url;
}

function outputAddress(value, allowInsecureLoopbackForward) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Forwarding requires an RTMPS URL."); }
  if (url.protocol !== "rtmps:" && !(allowInsecureLoopbackForward && url.protocol === "rtmp:" && localHost(url.hostname))) throw new Error("Forwarding requires RTMPS; plaintext loopback is a test-only option.");
  if (!url.hostname || url.hash) throw new Error("Invalid forwarding URL.");
  requireTlsHostname(url);
  return url;
}

const tlsOptions = (url) => ["-tls_verify", "1", "-verifyhost", url.hostname.replace(/^\[|\]$/gu, "")];
const inputOptions = (url) => [...(url.protocol === "rtsp:" ? ["-timeout", "15000000", "-rtsp_transport", "tcp"] : ["-rw_timeout", "15000000"]), ...(url.protocol === "rtmps:" ? tlsOptions(url) : []), "-i", url.href];

/** Argument construction only: RTMPS requires FFmpeg 5+ GnuTLS or 8+ OpenSSL. */
export function broadcastEncoderArgs(input, runDirectory, { startNumber = 0 } = {}) {
  const url = inputAddress(input);
  if (!Number.isSafeInteger(startNumber) || startNumber < 0) throw new Error("Invalid broadcast media sequence.");
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-progress", "pipe:1", "-stats_period", "1", ...inputOptions(url)];
  for (const level of RENDITIONS) {
    args.push("-map", "0:v:0", "-map", "0:a:0", "-vf", `scale=${level.width}:${level.height}:force_original_aspect_ratio=decrease,pad=${level.width}:${level.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`,
      "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p", "-profile:v", "main", "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
      "-b:v", `${level.bitrate}k`, "-maxrate", `${level.bitrate}k`, "-bufsize", `${level.bitrate * 2}k`, "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
      "-f", "hls", "-hls_time", "2", "-hls_list_size", "12", "-hls_delete_threshold", "12", "-hls_start_number_source", "generic", "-start_number", String(startNumber),
      "-hls_flags", "delete_segments+independent_segments+temp_file+program_date_time+omit_endlist", "-hls_segment_filename", join(runDirectory, level.name, "segment-%019d.ts"), join(runDirectory, level.name, "index.m3u8"));
  }
  return args;
}

/** Argument construction only: RTMPS requires FFmpeg 5+ GnuTLS or 8+ OpenSSL. */
export function broadcastForwardArgs(input, output, { allowInsecureLoopbackForward = false } = {}) {
  const source = inputAddress(input), target = outputAddress(output, allowInsecureLoopbackForward);
  // This branch has its own reader/process and cannot block HLS encoding.
  // The supported broadcaster input is H.264/AAC with both tracks present.
  return ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...inputOptions(source), "-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-f", "flv", "-rw_timeout", "15000000", ...(target.protocol === "rtmps:" ? tlsOptions(target) : []), target.href];
}

async function atomicText(path, value) {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try { await writeFile(temporary, value, { flag: "wx", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function startBroadcastPipeline({ input = "rtsp://127.0.0.1:8554/live", mediaDir, ffmpeg = "ffmpeg", forwardUrl, allowInsecureLoopbackForward = false,
  retryFloorMs = 1000, retryCeilingMs = 15000, publicationIntervalMs = 250, retainGenerations = 3, generationGraceMs = 120000, watchDirectory = watch } = {}) {
  const source = inputAddress(input);
  const target = forwardUrl ? outputAddress(forwardUrl, allowInsecureLoopbackForward) : undefined;
  if (!mediaDir || typeof ffmpeg !== "string" || !ffmpeg || !Number.isSafeInteger(retryFloorMs) || retryFloorMs < 50 || !Number.isSafeInteger(retryCeilingMs) || retryCeilingMs < retryFloorMs || retryCeilingMs > 60000
      || !Number.isSafeInteger(publicationIntervalMs) || publicationIntervalMs < 20 || publicationIntervalMs > 5000 || !Number.isSafeInteger(retainGenerations) || retainGenerations < 2 || retainGenerations > 16
      || !Number.isSafeInteger(generationGraceMs) || generationGraceMs < 60000) throw new Error("Invalid broadcast pipeline limits.");
  if (source.protocol === "rtmps:" || target?.protocol === "rtmps:") await requireVerifiedTlsBuild(ffmpeg);
  const root = resolve(mediaDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || await realpath(root) !== root || (rootStat.mode & 0o022) || (typeof process.getuid === "function" && rootStat.uid !== process.getuid())) throw new Error("Broadcast media directory must be owner-controlled without symlinks.");
  const lock = join(root, ".broadcast-lock"), leasePath = join(root, ".broadcast-lease.sqlite");
  const lease = await acquireExclusiveStateLease(leasePath);
  let recordedOwnership = false, workerControl, guardianLost = false, failureFencing = Promise.resolve();
  try {
    try {
      const previousStat = await lstat(lock);
      if (!previousStat.isFile() || previousStat.nlink !== 1 || (previousStat.mode & 0o777) !== 0o600 || previousStat.size > 2048 || process.getuid && previousStat.uid !== process.getuid()) throw new Error("Unsafe broadcaster ownership record.");
      const previous = JSON.parse(await readFile(lock, "utf8"));
      if (previous.guardianLost === true) throw new Error("Worker guardian failed; operator recovery must prove all previous workers have stopped.");
      if (previous.v !== 2 || previous.leaseDevice !== lease.device || previous.leaseInode !== lease.inode) throw new Error("Legacy broadcaster lock requires operator recovery; exclusive prior ownership cannot be proved.");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    // Metadata is recovered only while the permanent lease inode is locked.
    await atomicText(lock, `${JSON.stringify({ v: 2, leaseDevice: lease.device, leaseInode: lease.inode, startedAt: new Date().toISOString() })}\n`);
    recordedOwnership = true;
    workerControl = await startBroadcastWorkerControl(join(root, ".broadcast-workers.sqlite"));
  for (const level of RENDITIONS) {
    const directory = join(root, level.name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory() || await realpath(directory) !== directory) throw new Error("Broadcast rendition directories must not contain symlinks.");
  }
  const marker = join(root, ".relayswarm-broadcast");
  try { const stat = await lstat(marker); if (!stat.isFile() || stat.size !== 2) throw new Error("Invalid broadcast directory marker."); const content = await readFile(marker, "utf8"); if (content !== "1\n") throw new Error("Invalid broadcast directory marker."); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const entries = await readdir(root);
    if (entries.some((name) => name !== ".broadcast-lock" && name !== ".broadcast-lease.sqlite" && name !== ".broadcast-lease.sqlite-journal" && name !== ".broadcast-workers.sqlite" && name !== ".broadcast-workers.sqlite-journal" && name !== ".broadcast-workers.sqlite.dirty" && !RENDITIONS.some((level) => level.name === name))) throw new Error("Use an empty, dedicated broadcast media directory.");
    for (const level of RENDITIONS) if ((await readdir(join(root, level.name))).length) throw new Error("Use an empty, dedicated broadcast media directory.");
    await writeFile(marker, "1\n", { mode: 0o600, flag: "wx" });
  }
  const counters = { hls: { state: "starting", starts: 0, restarts: 0, exitCode: null, progress: null }, forward: { state: forwardUrl ? "starting" : "disabled", starts: 0, restarts: 0, exitCode: null }, publications: 0, lastPublishedAt: null, generation: 0 };
  let stopped = false, generation, lastCopies = new Map(), stopPromise;
  const children = new Set(), wakeups = new Set();
  const pause = (ms) => new Promise((done) => {
    const finish = () => { clearTimeout(timer); wakeups.delete(finish); done(); };
    const timer = setTimeout(finish, ms); wakeups.add(finish);
  });

  async function publishedPosition() {
    let nextSequence = 0, nextDiscontinuity = 0;
    for (const level of RENDITIONS) {
      const path = join(root, level.name, "index.m3u8");
      let body;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size > 256 * 1024) throw new Error("Invalid published broadcast playlist.");
        body = await readFile(path, "utf8");
      } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const sequences = body.match(/^#EXT-X-MEDIA-SEQUENCE.*$/gmu) ?? [];
      const discontinuities = body.match(/^#EXT-X-DISCONTINUITY-SEQUENCE.*$/gmu) ?? [];
      const sequence = sequences[0]?.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)$/u);
      const discontinuity = discontinuities[0]?.match(/^#EXT-X-DISCONTINUITY-SEQUENCE:(\d+)$/u);
      const segments = body.match(/^#EXTINF:/gmu)?.length ?? 0;
      const start = Number(sequence?.[1]), cc = Number(discontinuity?.[1] ?? 0);
      if (!body.startsWith("#EXTM3U\n") || sequences.length !== 1 || discontinuities.length > 1 || (discontinuities.length && !discontinuity)
          || !sequence || !segments || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(start + segments) || !Number.isSafeInteger(cc) || cc < 0 || cc >= Number.MAX_SAFE_INTEGER)
        throw new Error("Invalid published broadcast position.");
      nextSequence = Math.max(nextSequence, start + segments);
      nextDiscontinuity = Math.max(nextDiscontinuity, cc + 1);
    }
    return { nextSequence, nextDiscontinuity };
  }

  async function nextGeneration() {
    const entry = `run-${Date.now()}-${randomBytes(6).toString("hex")}`;
    const directory = join(root, entry);
    for (const level of RENDITIONS) await mkdir(join(directory, level.name), { recursive: true, mode: 0o700 });
    const generationFile = join(root, ".generation");
    const previous = await (async () => {
      try { const stat = await lstat(generationFile); if (!stat.isFile() || stat.size > 32) throw new Error("Invalid broadcast generation state."); return await readFile(generationFile, "utf8"); }
      catch (error) { if (error.code === "ENOENT") return "0"; throw error; }
    })();
    const sequence = Number(previous);
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence >= Number.MAX_SAFE_INTEGER - 1) throw new Error("Invalid broadcast generation state.");
    counters.generation = sequence + 1;
    await atomicText(join(root, ".generation"), `${counters.generation}\n`);
    const position = await publishedPosition();
    generation = { entry, directory, discontinuity: position.nextDiscontinuity, startNumber: position.nextSequence };
    lastCopies = new Map();
    // Watch the new directories before the encoder writes its first playlist.
    requestPublication();
    return directory;
  }

  async function runWorker(name) {
    let delay = retryFloorMs;
    while (!stopped) {
      const status = counters[name];
      let args;
      try {
        if (name === "hls") { const directory = await nextGeneration(); args = broadcastEncoderArgs(input, directory, { startNumber: generation.startNumber }); }
        else args = broadcastForwardArgs(input, forwardUrl, { allowInsecureLoopbackForward });
      }
      catch { status.state = "failed"; status.exitCode = null; return; }
      if (stopped) break;
      status.state = "connecting"; status.starts++; status.restarts = status.starts - 1;
      const launchedAt = Date.now();
      const child = workerControl.spawn(ffmpeg, args, { captureStdout: name === "hls" });
      children.add(child);
      if (name === "hls") {
        status.progress = null;
        let buffer = "", values = {};
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (data) => {
          buffer = (buffer + data).slice(-8192);
          const lines = buffer.split("\n"); buffer = lines.pop();
          for (const line of lines) {
            const match = line.match(/^(frame|fps|speed|out_time_us|progress)=(.*)$/u);
            if (!match) continue;
            if (match[1] === "progress") { status.progress = { ...values, at: new Date().toISOString() }; values = {}; continue; }
            const value = Number(match[2].replace(/x$/u, "").trim());
            if (!Number.isFinite(value) || value < 0) continue;
            values[{ frame: "frames", fps: "fps", speed: "speed", out_time_us: "outTimeMs" }[match[1]]] = match[1] === "out_time_us" ? value / 1000 : value;
          }
        });
      }
      // Errors can contain upstream credentials. Consume them without sending
      // them to operator metrics, logs or browser responses.
      child.stderr.on("data", () => {});
      child.once("spawn", () => { if (name === "forward") status.state = "running"; });
      const result = await new Promise((done) => { child.once("error", (error) => done({ code: null, spawnError: error.code })); child.once("close", (code) => done({ code })); });
      children.delete(child);
      status.exitCode = result.code;
      if (stopped) { status.state = "stopped"; break; }
      if (result.spawnError === "ENOENT" || result.spawnError === "EACCES") { status.state = "failed"; return; }
      status.state = "retrying";
      if (Date.now() - launchedAt >= 30000) delay = retryFloorMs;
      await pause(delay);
      delay = Math.min(retryCeilingMs, delay * 2);
    }
    counters[name].state = "stopped";
  }

  async function publish() {
    if (!generation) return;
    const current = generation;
    const pending = new Map();
    for (const level of RENDITIONS) {
      let raw;
      try { raw = await readFile(join(current.directory, level.name, "index.m3u8"), "utf8"); }
      catch (error) { if (error.code === "ENOENT") return; throw error; }
      if (raw.length > 256 * 1024 || !raw.startsWith("#EXTM3U\n") || !raw.includes("#EXTINF:")) return;
      const body = raw.split("\n").map((line) => {
        if (!line || line.startsWith("#")) return line;
        if (!/^segment-\d+\.ts$/u.test(line)) throw new Error("Unexpected encoder media filename.");
        return `../${current.entry}/${level.name}/${line}`;
      });
      body.splice(2, 0, `#EXT-X-DISCONTINUITY-SEQUENCE:${current.discontinuity}`);
      pending.set(level.name, { raw, body: body.join("\n") });
    }
    // Publish a generation only after both renditions exist. Failed retries
    // keep the last complete publication available for origin fallback.
    for (const level of RENDITIONS) {
      if (generation !== current || stopped) return;
      const { raw, body } = pending.get(level.name);
      if (lastCopies.get(level.name) === raw) continue;
      await atomicText(join(root, level.name, "index.m3u8"), body);
      if (generation !== current || stopped) return;
      lastCopies.set(level.name, raw); counters.publications++; counters.lastPublishedAt = new Date().toISOString();
      counters.hls.state = "publishing";
    }
    if (lastCopies.size === RENDITIONS.length && !stopped) {
      const master = `#EXTM3U\n#EXT-X-VERSION:3\n${RENDITIONS.map((level) => `#EXT-X-STREAM-INF:BANDWIDTH=${level.bandwidth},RESOLUTION=${level.width}x${level.height},FRAME-RATE=30\n${level.name}/index.m3u8\n`).join("")}`;
      if (!await readFile(join(root, "master.m3u8"), "utf8").then((value) => value === master).catch(() => false)) await atomicText(join(root, "master.m3u8"), master);
    }
  }

  async function prune() {
    const published = new Set();
    for (const level of RENDITIONS) {
      try { const playlist = await readFile(join(root, level.name, "index.m3u8"), "utf8"); for (const match of playlist.matchAll(/\.\.\/(run-\d+-[a-f0-9]{12})\//gu)) published.add(match[1]); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const entries = (await readdir(root)).filter((name) => /^run-\d+-[a-f0-9]{12}$/u.test(name)).sort().reverse();
    for (const name of entries.slice(retainGenerations)) {
      const age = Date.now() - Number(name.split("-")[1]);
      const path = join(root, name), rel = relative(root, path);
      if (age < generationGraceMs || name === generation?.entry || published.has(name) || isAbsolute(rel) || rel.startsWith("..") || (await lstat(path)).isSymbolicLink()) continue;
      await rm(path, { recursive: true, force: true });
    }
  }

  let fatalResolve;
  const failure = new Promise((done) => { fatalResolve = done; });
  workerControl.onFailure(() => {
    guardianLost = true;
    failureFencing = atomicText(lock, `${JSON.stringify({ v: 2, leaseDevice: lease.device, leaseInode: lease.inode, guardianLost: true })}\n`);
    failureFencing.catch(() => {});
    fatalResolve(new Error("Broadcast worker guardian stopped; operator recovery is required.")); control.close().catch(() => {});
  });
  // The encoder renames each rendition playlist into place when a segment
  // completes. A directory watch on the current generation starts publication
  // at once; the interval remains the fallback where watching is unavailable
  // or an event is missed. Events only wake the loop, which rereads the files.
  let watched = null, watchers = [], publicationRequested = false, wakePublication = null, unnamedTimer = null;
  const requestPublication = () => { publicationRequested = true; wakePublication?.(); };
  // Some platforms omit the filename. Those events cannot be told apart from
  // segment writes, so they wake publication at most every 10 ms.
  const requestPublicationSoon = () => { unnamedTimer ??= setTimeout(() => { unnamedTimer = null; requestPublication(); }, 10); };
  function closeWatchers() {
    for (const watcher of watchers) { try { watcher.close(); } catch {} }
    watchers = []; watched = null; clearTimeout(unnamedTimer); unnamedTimer = null;
  }
  function watchGeneration() {
    if (stopped || !generation || watched === generation.entry) return;
    closeWatchers(); watched = generation.entry;
    for (const level of RENDITIONS) {
      try {
        const watcher = watchDirectory(join(generation.directory, level.name), { persistent: false },
          (_event, filename) => { if (filename === null || filename === undefined) requestPublicationSoon(); else if (String(filename) === "index.m3u8") requestPublication(); });
        watcher.on("error", () => { try { watcher.close(); } catch {} });
        watchers.push(watcher);
      } catch { /* The interval still publishes. */ }
    }
  }
  const publicationPause = (ms) => new Promise((done) => {
    const finish = () => { clearTimeout(timer); wakeups.delete(finish); if (wakePublication === finish) wakePublication = null; done(); };
    const timer = setTimeout(finish, ms); wakeups.add(finish); wakePublication = finish;
  });
  const workers = [runWorker("hls"), ...(forwardUrl ? [runWorker("forward")] : [])];
  const publisher = (async () => {
    let lastPrune = 0;
    try {
      while (!stopped) {
        publicationRequested = false;
        try { await publish(); if (Date.now() - lastPrune > 30000) { await prune(); lastPrune = Date.now(); } }
        catch { counters.hls.state = "publication-error"; }
        watchGeneration();
        // A playlist renamed during this publication is read on the next pass.
        if (!stopped && !publicationRequested) await publicationPause(publicationIntervalMs);
      }
    } finally { closeWatchers(); }
  })();
  const control = {
    failure, mediaDir: root, manifest: "master.m3u8",
    metrics() { return { v: 1, hls: { ...counters.hls, progress: counters.hls.progress ? { ...counters.hls.progress } : null }, forward: { ...counters.forward }, publications: counters.publications, lastPublishedAt: counters.lastPublishedAt, generation: counters.generation,
      renditions: RENDITIONS.map((value) => ({ ...value })), scope: "process/publication status; forwarding connection acceptance and platform playback are not measured" }; },
    async ready({ timeoutMs = 120000 } = {}) {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error("Invalid broadcast startup timeout.");
      const deadline = timeoutMs ? Date.now() + timeoutMs : Infinity;
      while (!stopped) {
        if (lastCopies.size === RENDITIONS.length) {
          try { await readFile(join(root, "master.m3u8")); return; } catch {}
        }
        if (counters.hls.state === "failed") throw new Error("Broadcast output preparation failed.");
        if (Date.now() >= deadline) throw new Error("Broadcast source did not publish both renditions before the startup deadline.");
        await pause(Math.min(250, publicationIntervalMs));
      }
      throw new Error("Broadcast pipeline stopped.");
    },
    close() {
      if (stopPromise) return stopPromise;
      stopped = true;
      for (const finish of [...wakeups]) finish();
      stopPromise = (async () => {
        // Start the guardian shutdown in the same transition as stopping
        // publication, before waiting for individual worker close messages.
        // A clean acknowledgement proves process groups and the dirty marker
        // were cleared. An unexpected exit never becomes successful close.
        const workerShutdown = workerControl.close();
        try { await Promise.all([workerShutdown, ...workers, publisher]); }
        catch (error) {
          guardianLost = true;
          failureFencing = atomicText(lock, `${JSON.stringify({ v: 2, leaseDevice: lease.device, leaseInode: lease.inode, guardianLost: true })}\n`);
          failureFencing.catch(() => {});
          throw error;
        } finally {
          try { await failureFencing; if (!guardianLost) await rm(lock, { force: true }); }
          finally { lease.close(); }
        }
        counters.hls.state = "stopped"; if (forwardUrl) counters.forward.state = "stopped";
      })();
      return stopPromise;
    },
  };
  return control;
  } catch (error) { try { await workerControl?.close(); if (recordedOwnership) await rm(lock, { force: true }); } finally { lease.close(); } throw error; }
}
