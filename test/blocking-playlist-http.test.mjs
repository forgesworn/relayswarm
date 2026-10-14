import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rename, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { startDemoServer } from "../demo/server.mjs";

const playlist = (sequence = 4, extra = "") => `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n${extra}#EXTINF:1,\nsegment.ts\n`;
async function until(predicate) {
  const deadline = performance.now() + 2000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, "HTTP checkpoint reached within two seconds");
    await pause(5);
  }
}
async function fixture(t, options = {}) {
  const deadline = performance.now() + 10000; // Existing outer test envelope, never restarted by retry.
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-block-http-"));
  const pending = new Set(), publications = new AbortController();
  const observe = promise => { pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise)); return promise; };
  let demo;
  t.after(async () => {
    let failure;
    publications.abort();
    const drained = Promise.allSettled([...pending]);
    try {
      try { await demo?.close(); } catch (error) { failure = error; }
      await drained;
    } finally {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  });
  await writeFile(join(directory, "index.m3u8"), playlist());
  await writeFile(join(directory, "segment.ts"), "abcdefgh");
  demo = await startDemoServer({ mediaDir: directory, manifest: "index.m3u8", iceServers: [], ...options });
  return { demo, directory, url: `${demo.base}/media/index.m3u8`, request: (...args) => observe(fetch(...args)),
    publish(sequence, extra) {
      return observe((async () => {
        if (publications.signal.aborted || performance.now() >= deadline) throw new Error("Fixture publication expired.");
        await writeFile(join(directory, "next.m3u8"), playlist(sequence, extra));
        let refusal;
        for (;;) {
          if (publications.signal.aborted) throw new Error("Fixture publication cancelled.");
          if (performance.now() >= deadline) throw refusal ?? new Error("Fixture publication expired.");
          try { await rename(join(directory, "next.m3u8"), join(directory, "index.m3u8")); return; }
          catch (error) {
            if (process.platform !== "win32" || error.code !== "EPERM") throw error;
            refusal ??= error;
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw refusal;
            await pause(Math.min(5, remaining), undefined, { signal: publications.signal });
          }
        }
      })());
    } };
}

test("HTTP playlists advertise compatible blocking and retain exact HEAD/range/media responses", { timeout: 10000 }, async t => {
  const { demo, directory, url, request } = await fixture(t);
  const response = await request(url), body = await response.text();
  assert.equal(response.status, 200); assert.match(body, /CAN-BLOCK-RELOAD=YES/u);
  assert.equal(await readFile(join(directory, "index.m3u8"), "utf8"), playlist());
  const head = await request(url, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(body));
  assert.equal(await head.text(), "");
  const range = await request(url, { headers: { range: "bytes=4-12" } });
  assert.equal(range.status, 206); assert.equal(range.headers.get("content-range"), `bytes 4-12/${Buffer.byteLength(body)}`);
  assert.equal(await range.text(), body.slice(4, 13));
  const invalidRange = await request(url, { headers: { range: `bytes=${Buffer.byteLength(body)}-` } });
  assert.equal(invalidRange.status, 416); assert.equal(invalidRange.headers.get("content-range"), `bytes */${Buffer.byteLength(body)}`);
  for (const query of ["_HLS_msn=-1", "_HLS_msn=7", "_HLS_msn=4&_HLS_msn=4", "_HLS_part=0"]) {
    const invalid = await request(`${url}?${query}`); assert.equal(invalid.status, 400); await invalid.arrayBuffer();
  }
  const stale = await request(`${url}?_HLS_msn=0&_HLS_skip=YES`);
  assert.equal(stale.status, 200); assert.equal(await stale.text(), body);
  const media = await request(`${demo.base}/media/segment.ts`, { headers: { range: "bytes=2-5" } });
  assert.equal(media.status, 206); assert.equal(await media.text(), "cdef");
});

test("HTTP GET and HEAD wait for actual atomic publication and return its authorised representation", { timeout: 10000 }, async t => {
  const { demo, url, publish, request } = await fixture(t);
  const get = request(`${url}?_HLS_msn=5`), head = request(`${url}?_HLS_msn=5`, { method: "HEAD" });
  await until(() => demo.playlistReloadMetrics().activeBlocked === 2);
  await publish(5);
  const response = await get, headResponse = await head, body = await response.text();
  assert.equal(response.status, 200); assert.match(body, /MEDIA-SEQUENCE:5/u);
  assert.equal(headResponse.status, 200); assert.equal(await headResponse.text(), "");
  assert.equal(Number(headResponse.headers.get("content-length")), Buffer.byteLength(body));
  assert.equal(demo.playlistReloadMetrics().released, 2);
  await until(() => demo.playlistReloadMetrics().watchers === 0);
});

test("HTTP blocked capacity preserves byte service, disconnect releases a slot, and shutdown drains watchers", { timeout: 10000 }, async t => {
  const { demo, url, request } = await fixture(t);
  const controllers = Array.from({ length: 24 }, () => new AbortController());
  const requests = controllers.map(controller => request(`${url}?_HLS_msn=5`, { signal: controller.signal }));
  const settled = Promise.allSettled(requests);
  t.after(() => { for (const controller of controllers) controller.abort(); });
  await until(() => demo.playlistReloadMetrics().activeBlocked === 24);
  const excess = await request(`${url}?_HLS_msn=5`); assert.equal(excess.status, 503); await excess.arrayBuffer();
  const media = await request(`${demo.base}/media/segment.ts`); assert.equal(media.status, 200); assert.equal(await media.text(), "abcdefgh");
  controllers[0].abort();
  await until(() => demo.playlistReloadMetrics().activeBlocked === 23);
  await demo.close();
  await settled;
  const metrics = demo.playlistReloadMetrics();
  assert.equal(metrics.activeBlocked, 0); assert.equal(metrics.watchers, 0);
  assert.ok(metrics.aborted >= 1); assert.equal(metrics.rejected, 1);
});

test("HTTP timeout returns 503 after three target durations and leaves no blocked resources", { timeout: 10000 }, async t => {
  const { demo, url, request } = await fixture(t), started = performance.now();
  const response = await request(`${url}?_HLS_msn=5`);
  assert.equal(response.status, 503); await response.arrayBuffer();
  assert.ok(performance.now() - started >= 2900);
  const metrics = demo.playlistReloadMetrics();
  assert.equal(metrics.timedOut, 1); assert.equal(metrics.activeBlocked, 0); assert.equal(metrics.watchers, 0);
});

test("HTTP ended and legacy profiles retain original bytes and ignore delivery directives", { timeout: 10000 }, async t => {
  const ended = await fixture(t); await ended.publish(5, "#EXT-X-ENDLIST\n");
  const final = await ended.request(`${ended.url}?_HLS_msn=bad&_HLS_part=bad`);
  assert.equal(final.status, 200); assert.equal(await final.text(), playlist(5, "#EXT-X-ENDLIST\n"));
  const legacy = await fixture(t, { blockingPlaylistReload: false });
  const response = await legacy.request(`${legacy.url}?_HLS_msn=999&_HLS_part=bad`);
  assert.equal(response.status, 200); assert.equal(await response.text(), playlist());
  assert.equal(legacy.demo.playlistReloadMetrics().enabled, false);
  assert.equal(legacy.demo.playlistReloadMetrics().started, 0);
  assert.equal(legacy.demo.playlistReloadMetrics().watchers, 0);
});
