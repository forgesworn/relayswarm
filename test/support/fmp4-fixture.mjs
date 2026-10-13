import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function createFmp4Fixture({ seconds = 90, alternateAudio = false, encrypted = false, mixedCodecs = false, segmentSeconds = 2 } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-fmp4-"));
  try {
    if (encrypted) {
      await writeFile(join(directory, "key.key"), randomBytes(16));
      await writeFile(join(directory, "key-info"), `../key.key\n${join(directory, "key.key")}\n`);
    }
    for (const [name, size, bitrate] of [["low", "426x240", 350], ["high", "640x360", 1000]]) {
      await mkdir(join(directory, name));
      await new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=30`,
          "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", String(seconds), "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-tune", "zerolatency",
          "-pix_fmt", "yuv420p", "-profile:v", "baseline", "-level:v", "3.1", "-b:v", `${bitrate}k`, "-maxrate", `${bitrate}k`, "-bufsize", `${bitrate * 2}k`, "-g", String(segmentSeconds * 30), "-sc_threshold", "0",
          ...(alternateAudio ? ["-an"] : ["-c:a", "aac", "-b:a", "64k"]), "-f", "hls", "-hls_time", String(segmentSeconds), "-hls_list_size", "0", "-hls_playlist_type", "vod", "-hls_segment_type", encrypted ? "mpegts" : "fmp4", ...(encrypted ? ["-hls_key_info_file", join(directory, "key-info")] : []),
          "-hls_flags", "independent_segments", "-hls_segment_filename", join(directory, name, `segment-%05d.${encrypted ? "ts" : "m4s"}`), join(directory, name, "index.m3u8")], { stdio: ["ignore", "ignore", "pipe"] });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); }); child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`fMP4 encoder exited ${code}: ${stderr}`)); });
      });
    }
    async function encodeExtra(name, args) {
      await mkdir(join(directory, name));
      await new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args, "-t", String(seconds), "-f", "hls", "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
          "-hls_flags", "independent_segments", "-hls_segment_filename", join(directory, name, "segment-%05d.m4s"), join(directory, name, "index.m3u8")], { stdio: ["ignore", "ignore", "pipe"] });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 60000);
        let stderr = ""; child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
        child.once("error", (error) => { clearTimeout(timeout); reject(error); }); child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`extra HLS encoder exited ${code}: ${stderr}`)); });
      });
    }
    if (alternateAudio) await encodeExtra("audio", ["-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000", "-c:a", "aac", "-b:a", "64k"]);
    if (mixedCodecs) await encodeExtra("hevc", ["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-b:v", "180k", "-g", "60", "-tag:v", "hvc1", "-x265-params", "pools=2:frame-threads=2:keyint=60:min-keyint=60:scenecut=0", "-c:a", "aac", "-b:a", "64k"]);
    const audio = alternateAudio ? '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Tone",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"\n' : "";
    let hevcCodec, avcCodec;
    if (mixedCodecs) {
      // Derive the master declaration from the actual hvc1/avc1 init objects,
      // including profile, compatibility, constraints and level bytes.
      const init = await readFile(join(directory, "hevc", "init.mp4"));
      if (!init.includes(Buffer.from("hvc1"))) throw new Error("HEVC fixture must contain an hvc1 sample entry");
      const marker = init.indexOf(Buffer.from("hvcC")), box = init.subarray(marker + 4, marker - 4 + init.readUInt32BE(marker - 4));
      let reverse = 0; const compatibility = box.readUInt32BE(2);
      for (let bit = 0; bit < 32; bit++) reverse = (reverse << 1) | (compatibility >>> bit & 1);
      const constraint = [...box.subarray(6, 12)]; while (constraint.at(-1) === 0) constraint.pop();
      hevcCodec = `hvc1.${["", "A", "B", "C"][box[1] >> 6]}${box[1] & 31}.${(reverse >>> 0).toString(16).toUpperCase()}.${box[1] & 32 ? "H" : "L"}${box[12]}${constraint.map((value) => `.${value.toString(16).toUpperCase()}`).join("")}`;
      const avcInit = await readFile(join(directory, "low", "init.mp4")), avcMarker = avcInit.indexOf(Buffer.from("avcC"));
      avcCodec = `avc1.${avcInit.subarray(avcMarker + 5, avcMarker + 8).toString("hex")}`;
    }
    const hevc = mixedCodecs ? `#EXT-X-STREAM-INF:BANDWIDTH=220000,RESOLUTION=320x180,CODECS="${hevcCodec},mp4a.40.2"\nhevc/index.m3u8\n` : "";
    const audioGroup = alternateAudio ? ',AUDIO="audio"' : "";
    const codec = mixedCodecs ? ` ,CODECS="${avcCodec},mp4a.40.2"`.trim() : "";
    await writeFile(join(directory, "master.m3u8"), `#EXTM3U\n${audio}${hevc}#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=426x240${audioGroup}${codec}\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360${audioGroup}${codec}\nhigh/index.m3u8\n`);
    return { directory, codecs: mixedCodecs ? { hevc: hevcCodec, avc: avcCodec } : null, close: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
