import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { createFmp4Fixture } from "./fmp4-fixture.mjs";

// True encoded 1-second fMP4 parts, with 2-second full media segments made
// from their unchanged fragments. A rolling publication reveals only complete
// parts, and delta output starts only after the publisher/browser are warm.
export async function createLlHlsFixture() {
  const fixture = await createFmp4Fixture({ seconds: 80, segmentSeconds: 1 });
  let ticks = 15, delta = false, timer, pending = Promise.resolve(), stopped = false;
  const publications = [];
  try {
    for (const name of ["low", "high"]) {
      for (let sequence = 0; sequence < 40; sequence++) {
        const parts = await Promise.all([sequence * 2, sequence * 2 + 1].map((part) => readFile(join(fixture.directory, name, `segment-${String(part).padStart(5, "0")}.m4s`))));
        await writeFile(join(fixture.directory, name, `full-${String(sequence).padStart(5, "0")}.m4s`), Buffer.concat(parts));
      }
    }
    async function publish() {
      if (stopped) return;
      const complete = Math.min(39, Math.floor(ticks / 2)), start = Math.max(0, complete - 6), useDelta = delta && start >= 0;
      for (const name of ["low", "high"]) {
        let text = `#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:${start}\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12.0,PART-HOLD-BACK=3.0\n#EXT-X-PART-INF:PART-TARGET=1.0\n#EXT-X-MAP:URI="init.mp4"\n`;
        if (useDelta) text += "#EXT-X-SKIP:SKIPPED-SEGMENTS=2\n";
        for (let sequence = start + (useDelta ? 2 : 0); sequence < complete; sequence++) {
          // Keep parts near the edge, including complete segment parts, as a
          // real LL playlist does. Full segment bytes contain the same samples.
          if (sequence >= complete - 3) for (let part = 0; part < 2; part++) text += `#EXT-X-PART:DURATION=1.0,URI="segment-${String(sequence * 2 + part).padStart(5, "0")}.m4s",INDEPENDENT=YES\n`;
          text += `#EXTINF:2.000000,\nfull-${String(sequence).padStart(5, "0")}.m4s\n`;
        }
        if (ticks % 2) text += `#EXT-X-PART:DURATION=1.0,URI="segment-${String(complete * 2).padStart(5, "0")}.m4s",INDEPENDENT=YES\n`;
        // The future hint is deliberately not written or authorised as media.
        text += `#EXT-X-PRELOAD-HINT:TYPE=PART,URI="future-${ticks}.m4s"\n`;
        const target = join(fixture.directory, name, "index.m3u8"); await writeFile(`${target}.next`, text); await rename(`${target}.next`, target);
      }
      if (publications.length < 120) publications.push({ ticks, start, complete, delta: useDelta });
    }
    await publish();
    timer = setInterval(() => { ticks++; pending = pending.then(publish); pending.catch(() => {}); }, 1000); timer.unref();
    return { directory: fixture.directory, publications,
      async enableDelta() { delta = true; pending = pending.then(publish); await pending; },
      async close() { stopped = true; clearInterval(timer); await pending.catch(() => {}); await fixture.close(); } };
  } catch (error) { clearInterval(timer); await fixture.close(); throw error; }
}
