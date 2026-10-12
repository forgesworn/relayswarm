import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function encoder(output, { live = false, seconds = 24, size = "640x360", bitrate = 1000, singleFile = false, frequency = 440 } = {}) {
  return ["-hide_banner", "-loglevel", "error", "-y", ...(live ? ["-re"] : []),
    "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`, "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000`,
    ...(live ? [] : ["-t", String(seconds)]), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
    "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`, "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "64k", "-f", "hls", "-hls_time", "2", "-hls_list_size", live ? "12" : "0",
    "-hls_flags", singleFile ? "single_file+independent_segments" : live ? "delete_segments+independent_segments+temp_file" : "independent_segments",
    ...(!live ? ["-hls_playlist_type", "vod"] : []), "-hls_segment_filename", output.replace(/\.m3u8$/u, singleFile ? ".ts" : "-%05d.ts"), output];
}

function run(args) {
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  let error = "";
  child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-4000); });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 || signal === "SIGTERM" ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${error}`)));
  });
  // Live processes have no awaited completion until shutdown.
  done.catch(() => {});
  return { child, done };
}

/** Two independent timestamps separated by a discontinuity. Every segment
 * is an explicit byte range, and each rendition has two shared media files. */
export async function createMediaFixture({ live = false, sectionSeconds = 24 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-media-"));
  const jobs = [];
  const close = async () => {
    for (const job of jobs) if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill("SIGTERM");
    await Promise.allSettled(jobs.map((job) => job.done));
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const levels = [{ name: "low", size: "426x240", bitrate: 350, bandwidth: 450000 }, { name: "high", size: "640x360", bitrate: 1000, bandwidth: 1200000 }];
    for (const level of levels) {
      await mkdir(join(directory, level.name));
      if (live) jobs.push(run(encoder(join(directory, level.name, "index.m3u8"), { ...level, live })));
      else {
        for (const [part, frequency] of [["a", 440], ["b", 660]]) {
          const job = run(encoder(join(directory, level.name, `${part}.m3u8`), { ...level, seconds: sectionSeconds, singleFile: true, frequency }));
          jobs.push(job);
          await job.done;
        }
        const a = await readFile(join(directory, level.name, "a.m3u8"), "utf8");
        const b = await readFile(join(directory, level.name, "b.m3u8"), "utf8");
        const body = (text) => text.split(/\r?\n/u).filter((line) => line.startsWith("#EXTINF:") || line.startsWith("#EXT-X-BYTERANGE:") || (line && !line.startsWith("#"))).join("\n");
        await writeFile(join(directory, level.name, "index.m3u8"), `#EXTM3U\n#EXT-X-VERSION:4\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-PLAYLIST-TYPE:VOD\n${body(a)}\n#EXT-X-DISCONTINUITY\n${body(b)}\n#EXT-X-ENDLIST\n`);
      }
    }
    await writeFile(join(directory, "master.m3u8"), `#EXTM3U\n${levels.map((level) => `#EXT-X-STREAM-INF:BANDWIDTH=${level.bandwidth},RESOLUTION=${level.size}\n${level.name}/index.m3u8`).join("\n")}\n`);
    if (live) {
      const deadline = Date.now() + 15000;
      while (true) {
        try {
          const texts = await Promise.all(levels.map((level) => readFile(join(directory, level.name, "index.m3u8"), "utf8")));
          if (texts.every((text) => text.includes("#EXTINF:"))) break;
        } catch {}
        if (Date.now() >= deadline) throw new Error("ffmpeg did not publish live playlists within 15 seconds.");
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    return { directory, manifest: "master.m3u8", close };
  } catch (error) { await close(); throw error; }
}
