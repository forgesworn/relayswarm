import test from "node:test";
import assert from "node:assert/strict";
import { renameSync, watch } from "node:fs";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, writeFile, rename, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createHlsPublisher } from "../src/hls-publisher.mjs";
import { completePlaylist, createBlockingPlaylistReload, sendPlaylistResponse } from "../demo/blocking-playlist-reload.mjs";
import { httpRange } from "../demo/server.mjs";

const playlist = (sn = 4, extra = "", td = 2) => `#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-TARGETDURATION:${td}\n#EXT-X-MEDIA-SEQUENCE:${sn}\n${extra}#EXTINF:2,\nseg${sn}.ts\n`;
const params = (msn) => new URLSearchParams({ _HLS_msn: String(msn) });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await flush(); } assert.fail("Bounded test checkpoint not reached."); }
async function fixture(t, master = false) {
  const deadline = performance.now() + 5000; // Original real-FS test envelope.
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-block-reload-")));
  const reloads = new Set(), pending = new Set(), readiness = new Map(), publications = new AbortController();
  const observe = (promise) => {
    pending.add(promise); promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise; // Observe immediately; the caller still receives the original rejection.
  };
  t.after(async () => {
    let failure;
    try {
      publications.abort();
      const drained = Promise.allSettled([...pending]);
      const closed = await Promise.allSettled([...reloads].map(reload => reload.close()));
      await drained;
      failure = closed.find(result => result.status === "rejected")?.reason;
    } catch (error) { failure = error; }
    finally {
      try { await rm(directory, { recursive: true, force: true }); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  });
  await writeFile(join(directory, "index.m3u8"), master ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhigh.m3u8\n' : playlist());
  if (master) for (const name of ["low", "high"]) await writeFile(join(directory, `${name}.m3u8`), playlist());
  const publisher = await createHlsPublisher({ mediaDir: directory, manifest: "index.m3u8" });
  function createReload(options = {}) {
    const events = new EventEmitter();
    const reload = createBlockingPlaylistReload({ publisher, ...options, setTimer(callback, delay) {
      const timer = setTimeout(callback, delay);
      events.emit("waiting"); // Existing production pause has registered its actual waiter.
      return timer;
    } });
    const read = reload.read.bind(reload);
    reload.read = (...args) => {
      const promise = observe(read(...args));
      promise.catch(error => events.emit("readFailure", error));
      return promise;
    };
    reloads.add(reload); readiness.set(reload, events); return reload;
  }
  const reload = createReload();
  function blocked(count, instance = reload) {
    const events = readiness.get(instance);
    return new Promise((resolve, reject) => {
      const done = error => { events.off("waiting", check); events.off("readFailure", failed); if (error) reject(error); else resolve(); };
      const check = () => { if (instance.snapshot().activeBlocked >= count) done(); };
      const failed = error => done(error);
      events.on("waiting", check); events.on("readFailure", failed); check();
    });
  }
  function publish(sequence, text = playlist(sequence)) {
    return observe((async () => {
      if (publications.signal.aborted || performance.now() >= deadline) throw new Error("Fixture publication expired.");
      await writeFile(join(directory, "next.m3u8"), text);
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
  }
  return { directory, publisher, reload, createReload, blocked, publish };
}
function fake(t, { text = playlist(), beforeRead, ...options } = {}) {
  let current = text, reads = 0, at = 0; const events = [], timers = new Map();
  const publisher = { async playlistSnapshot(_path, options) {
    reads++; const captured = current;
    await beforeRead?.(reads, () => { for (const event of events) event.emitChange("change", "index.m3u8"); }, options);
    return { file: "/fixture/index.m3u8", bytes: Buffer.from(captured), isMedia: true,
      playlistFiles: ["/fixture/index.m3u8"], mediaPlaylists: [{ file: "/fixture/index.m3u8", text: captured }] };
  } };
  const reload = createBlockingPlaylistReload({ publisher, platform: "darwin", now: () => at, directoryIdentity: async directory => directory,
    watchDirectory(directory, _options, changed) { const event = new EventEmitter(); event.directory = directory; event.closed = false; event.close = () => { event.closed = true; }; event.emitChange = changed; events.push(event); return event; },
    setTimer(callback, delay) { const timer = {}; timers.set(timer, { callback, due: at + delay }); return timer; }, clearTimer(timer) { timers.delete(timer); }, ...options });
  t.after(() => reload.close());
  return { reload, timers, events, publisher, get reads() { return reads; }, set(body) { current = body; for (const event of events) if (!event.closed) event.emitChange("change", "index.m3u8"); },
    advance(ms) { at += ms; for (const { callback, due } of [...timers.values()]) if (due <= at) callback(); } };
}

test("complete-live representation preserves media entries/version/CRLF and merges compatible control", () => {
  const original = playlist(4, "#EXT-X-SERVER-CONTROL:HOLD-BACK=6,CAN-BLOCK-RELOAD=NO\n").replaceAll("\n", "\r\n");
  const info = completePlaylist(original);
  assert.equal(info.last, 4); assert.equal(info.targetDuration, 2);
  assert.match(info.body, /CAN-BLOCK-RELOAD=YES,HOLD-BACK=6/u);
  assert.equal(info.body.replace(/#EXT-X-SERVER-CONTROL:[^\r\n]*/u, "CONTROL"), original.replace(/#EXT-X-SERVER-CONTROL:[^\r\n]*/u, "CONTROL"));
  assert.match(info.body, /#EXT-X-VERSION:6\r\n/u);
  const indented = completePlaylist(playlist(4, "  #EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=NO\n"));
  assert.ok(!indented.body.includes("CAN-BLOCK-RELOAD=NO"));
  assert.equal((indented.body.match(/SERVER-CONTROL/gu) || []).length, 1);
  for (const body of [playlist(4, "#EXT-X-PLAYLIST-TYPE:VOD\n"), ` ${playlist()}`, playlist().replace("#EXTM3U\n", "#EXTM3U  \n"), playlist(4, `#EXT-X-SERVER-CONTROL:HOLD-BACK=${"9".repeat(400)}\n`), playlist(4, "#EXT-X-ENDLIST\n"), playlist(4, '#EXT-X-PART:DURATION=1,URI="p.ts"\n'), playlist(4, "#EXT-X-SKIP:SKIPPED-SEGMENTS=1\n"), playlist(4, "", 4), playlist(4, "#EXT-X-SERVER-CONTROL:CAN-SKIP-UNTIL=12\n"), `${playlist()}${"#".repeat(256 * 1024)}`]) assert.equal(completePlaylist(body), null);
});

test("real atomic publication wakes a waiter and returns the ready snapshot; raw files stay unchanged", { timeout: 5000 }, async t => {
  const { directory, reload, blocked, publish } = await fixture(t);
  const pending = reload.read("/media/index.m3u8", params(5));
  await blocked(1);
  await publish(5);
  const ready = await pending;
  assert.match(ready.toString(), /MEDIA-SEQUENCE:5/u);
  assert.match(ready.toString(), /CAN-BLOCK-RELOAD=YES/u);
  assert.equal(await readFile(join(directory, "index.m3u8"), "utf8"), playlist(5));
  assert.equal(reload.snapshot().released, 1); assert.equal(reload.snapshot().watchers, 0);
});

test("watch-before-read and revision check cover publication during the fresh read before waiter registration", async t => {
  let state;
  state = fake(t, { beforeRead(reads, changed, options) { if (reads > 1) assert.equal(options.fresh, true); if (reads === 2) { state.set(playlist(5)); changed(); } } });
  const body = await state.reload.read("/media/index.m3u8", params(5));
  assert.match(body.toString(), /MEDIA-SEQUENCE:5/u);
  assert.equal(state.reads, 3); assert.equal(state.timers.size, 0); assert.equal(state.reload.snapshot().watchers, 0);
});

test("presentation-wide eligibility excludes mixed VOD/parts/unsupported TD and incompatible controls", async t => {
  const { directory, reload } = await fixture(t, true);
  assert.match((await reload.read("/media/low.m3u8")).toString(), /CAN-BLOCK-RELOAD=YES/u);
  for (const body of [playlist(4, "#EXT-X-ENDLIST\n"), playlist(4, '#EXT-X-PART:DURATION=1,URI="part.ts"\n'), playlist(4, "", 4), playlist(4, "#EXT-X-SERVER-CONTROL:HOLD-BACK=6\n")]) {
    await writeFile(join(directory, "high.m3u8"), body);
    assert.equal((await reload.read("/media/low.m3u8")).toString(), playlist());
    assert.equal((await reload.read("/media/high.m3u8")).toString(), body);
  }
  const master = await reload.read("/media/index.m3u8", params("invalid"));
  assert.ok(!master.toString().includes("SERVER-CONTROL"));
});

test("stale MSN returns full current playlist; malformed/duplicate/far-future/part directives refuse", async t => {
  const { reload } = fake(t);
  assert.match((await reload.read("/media/index.m3u8", params(0))).toString(), /seg4.ts/u);
  for (const query of ["_HLS_msn=-1", "_HLS_msn=4&_HLS_msn=4", "_HLS_msn=7", "_HLS_msn=1.5", "_HLS_msn=9007199254740992", "_HLS_part=0", "_HLS_msn=5&_HLS_part=0"]) await assert.rejects(reload.read("/media/index.m3u8", new URLSearchParams(query)), { status: 400 });
  assert.match((await reload.read("/media/index.m3u8", new URLSearchParams("_HLS_skip=YES&cache=bare"))).toString(), /seg4.ts/u);
  assert.equal(reload.snapshot().activeBlocked, 0);
});

test("ENDLIST ignores directives; explicit disabled profile preserves bytes and zero blocking metrics", async t => {
  const body = playlist(4, "#EXT-X-ENDLIST\n"), ended = fake(t, { text: body });
  assert.equal((await ended.reload.read("/media/index.m3u8", new URLSearchParams("_HLS_msn=bad&_HLS_part=bad"))).toString(), body);
  const disabled = fake(t, { enabled: false });
  assert.equal((await disabled.reload.read("/media/index.m3u8", params(99))).toString(), playlist());
  assert.deepEqual(disabled.reload.snapshot(), { enabled: false, blockedLimit: 24, activeBlocked: 0, started: 0, released: 0, aborted: 0, timedOut: 0, watchErrors: 0, rejected: 0, watchers: 0 });
  assert.equal(disabled.events.length, 0);
});

test("disconnect and server close release waiters, shared watcher and timers independently", async t => {
  const state = fake(t), signal = new AbortController();
  const first = state.reload.read("/media/index.m3u8", params(5), { signal: signal.signal });
  const second = state.reload.read("/media/index.m3u8", params(5));
  const settled = Promise.allSettled([first, second]);
  await until(() => state.reload.snapshot().activeBlocked === 2);
  assert.equal(state.events.length, 1); signal.abort(); await state.reload.close();
  const results = await settled; assert.equal(results[0].reason.status, 499); assert.equal(results[1].reason.status, 503);
  assert.equal(state.reload.snapshot().activeBlocked, 0); assert.equal(state.reload.snapshot().watchers, 0);
  assert.equal(state.timers.size, 0); assert.ok(state.events.every(event => event.closed));
});

test("blocked subset caps at 24 while ordinary playlist reads remain available", async t => {
  const state = fake(t), pending = Array.from({ length: 24 }, () => state.reload.read("/media/index.m3u8", params(5)));
  const settled = Promise.allSettled(pending);
  await until(() => state.reload.snapshot().activeBlocked === 24);
  await assert.rejects(state.reload.read("/media/index.m3u8", params(5)), { status: 503 });
  assert.match((await state.reload.read("/media/index.m3u8")).toString(), /seg4.ts/u);
  await state.reload.close(); await settled;
  assert.equal(state.reload.snapshot().activeBlocked, 0); assert.equal(state.timers.size, 0);
});

test("initial target duration fixes monotonic timeout; final fresh read may satisfy at the boundary", async t => {
  const state = fake(t), pending = state.reload.read("/media/index.m3u8", params(5));
  const rejected = assert.rejects(pending, { status: 503 });
  await until(() => state.reload.snapshot().activeBlocked === 1);
  state.advance(5999); await flush(); assert.equal(state.reload.snapshot().timedOut, 0);
  state.advance(1); await rejected; assert.equal(state.reload.snapshot().timedOut, 1); assert.ok(state.reads >= 3);
  const ready = fake(t), atBoundary = ready.reload.read("/media/index.m3u8", params(5));
  await until(() => ready.reload.snapshot().activeBlocked === 1); ready.set(playlist(5)); ready.advance(6000);
  assert.match((await atBoundary).toString(), /seg5.ts/u); assert.equal(ready.reload.snapshot().timedOut, 0);
});

test("watch failures and lost catalogue authorisation fail closed without old snapshot fallback", async t => {
  const state = fake(t), pending = state.reload.read("/media/index.m3u8", params(5));
  const rejected = assert.rejects(pending, { status: 503 });
  await until(() => state.reload.snapshot().activeBlocked === 1); state.events[0].emit("error", new Error("private path"));
  await rejected; assert.equal(state.reload.snapshot().watchErrors, 1); assert.equal(state.reload.snapshot().watchers, 0);
  const real = await fixture(t, true), waiting = real.reload.read("/media/low.m3u8", params(5));
  const absent = assert.rejects(waiting, { status: 404 });
  await real.blocked(1);
  await real.publish(0, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhigh.m3u8\n');
  await absent;
});

test("new canonical directory is watched then reread, and excessive path churn refuses", async t => {
  const state = fake(t); let reads = 0;
  state.publisher.playlistSnapshot = async () => {
    reads++; const file = reads <= 2 ? "/fixture/index.m3u8" : "/new/index.m3u8";
    return { file, bytes: Buffer.from(playlist(reads < 3 ? 4 : 5)), isMedia: true, playlistFiles: [file], mediaPlaylists: [{ file, text: playlist(reads < 3 ? 4 : 5) }] };
  };
  const pending = state.reload.read("/media/index.m3u8", params(5));
  await until(() => state.reload.snapshot().activeBlocked === 1); state.set(playlist(5));
  assert.match((await pending).toString(), /seg5.ts/u); assert.equal(state.events.length, 2); assert.equal(state.reload.snapshot().watchers, 0);
  const churn = fake(t); let id = 0;
  churn.publisher.playlistSnapshot = async () => { const file = `/dir${id++}/index.m3u8`; return { file, bytes: Buffer.from(playlist()), isMedia: true, playlistFiles: [file], mediaPlaylists: [{ file, text: playlist() }] }; };
  await assert.rejects(churn.reload.read("/media/index.m3u8", params(5)), { status: 503 });
  assert.equal(churn.reload.snapshot().watchers, 0);
});

test("publisher snapshot refuses oversized and unauthorised reads and caller buffer mutation cannot poison it", async t => {
  const { directory, publisher, reload } = await fixture(t);
  await assert.rejects(reload.read("/media/private.m3u8"), { status: 404 });
  const before = await publisher.playlistSnapshot("/media/index.m3u8"); before.bytes.fill(0);
  assert.equal((await publisher.playlistSnapshot("/media/index.m3u8")).bytes.toString(), playlist());
  await writeFile(join(directory, "index.m3u8"), `${playlist()}${"#".repeat(256 * 1024)}`);
  await assert.rejects(reload.read("/media/index.m3u8"), /Excessive playlist/u);
});

test("HEAD and HTTP ranges describe the same transformed bytes, including bare polling", async t => {
  const state = fake(t), bytes = await state.reload.read("/media/index.m3u8", new URLSearchParams("bare"));
  function response() { return Object.assign(new EventEmitter(), { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; this.emit("finish"); } }); }
  const full = response(); await sendPlaylistResponse(full, bytes); assert.deepEqual(full.body, bytes); assert.equal(full.headers["content-length"], bytes.length);
  const head = response(); await sendPlaylistResponse(head, bytes, { head: true }); assert.equal(head.body, undefined); assert.equal(head.headers["content-length"], bytes.length);
  const partial = response(); await sendPlaylistResponse(partial, bytes, { range: httpRange("bytes=4-12", bytes.length) });
  assert.equal(partial.status, 206); assert.deepEqual(partial.body, bytes.subarray(4, 13)); assert.equal(partial.headers["content-range"], `bytes 4-12/${bytes.length}`);
  assert.throws(() => httpRange(`bytes=${bytes.length}-`, bytes.length), { status: 416 });
});


test("same-path directory inode replacement rearms a shared watcher before later atomic publication", { timeout: 5000 }, async t => {
  const { directory, createReload, blocked, publish } = await fixture(t);
  let watches = 0, secondWatchCreated;
  const rearmed = new Promise(resolve => { secondWatchCreated = resolve; });
  const reload = createReload({ watchDirectory(...args) { const watcher = watch(...args); if (args[0] === directory && ++watches === 2) secondWatchCreated(); return watcher; } });
  const replacement = `${directory}-replacement`, previous = `${directory}-previous`;
  t.after(async () => { await rm(replacement, { recursive: true, force: true }); await rm(previous, { recursive: true, force: true }); });
  await mkdir(replacement); await writeFile(join(replacement, "index.m3u8"), playlist());
  const pending = [reload.read("/media/index.m3u8", params(5)), reload.read("/media/index.m3u8", params(5))];
  const results = Promise.all(pending); results.catch(() => {});
  await blocked(2, reload);
  // Consecutive synchronous renames prevent a test-only absent-path gap.
  renameSync(directory, previous); renameSync(replacement, directory);
  await rearmed;
  assert.equal(reload.snapshot().activeBlocked, 2);
  await publish(5);
  for (const bytes of await results) assert.match(bytes.toString(), /MEDIA-SEQUENCE:5/u);
  assert.equal(reload.snapshot().released, 2); assert.equal(reload.snapshot().watchers, 0);
});

test("a ready snapshot is reauthorised after a concurrent master removal, not returned from stale membership", async t => {
  const { directory, publisher, createReload } = await fixture(t, true);
  let calls = 0, changed;
  const reload = createReload({ publisher: { async playlistSnapshot(...args) {
    const snapshot = await publisher.playlistSnapshot(...args);
    if (++calls === 2) {
      await writeFile(join(directory, "index.m3u8"), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2\nhigh.m3u8\n');
      changed();
    }
    return snapshot;
  } }, watchDirectory(_path, _options, callback) { changed = callback; const event = new EventEmitter(); event.close = () => {}; return event; } });
  await assert.rejects(reload.read("/media/low.m3u8", params(4)), { status: 404 });
  assert.equal(calls, 2); // The third fresh publisher read itself refuses membership.
  assert.equal(reload.snapshot().watchers, 0);
  const churn = fake(t, { beforeRead(reads, notify) { if (reads > 1) notify(); } });
  await assert.rejects(churn.reload.read("/media/index.m3u8", params(4)), { status: 503 });
  assert.ok(churn.reads <= 4); assert.equal(churn.reload.snapshot().watchers, 0);
});

test("slow response retains its caller slot until finish or close and removes all own listeners", async t => {
  const bytes = Buffer.from(playlist());
  for (const terminal of ["finish", "close", "abort", "error"]) {
    const response = Object.assign(new EventEmitter(), {
      writeHead() {}, end() { this.ended = true; }, destroy() { this.destroyed = true; this.emit("close"); },
    });
    const signal = new AbortController(); let active = 1;
    const sentinel = new Error("retained response failure");
    const pending = (async () => { try { await sendPlaylistResponse(response, bytes, { signal: signal.signal }); } finally { active--; } })();
    const observed = pending.catch(error => error);
    await flush(); assert.equal(response.ended, true); assert.equal(active, 1);
    assert.equal(response.listenerCount("finish"), 1); assert.equal(response.listenerCount("close"), 1);
    if (terminal === "abort") signal.abort();
    else if (terminal === "error") response.emit("error", sentinel);
    else response.emit(terminal);
    const error = await observed;
    assert.equal(error, terminal === "error" ? sentinel : undefined); assert.equal(active, 0);
    for (const event of ["finish", "close", "error"]) assert.equal(response.listenerCount(event), 0);
  }
  // The actual server branch must await the shared response function before its
  // existing finally releases global media admission. No HTTP actor is needed.
  const source = await readFile(new URL("../demo/server.mjs", import.meta.url), "utf8");
  assert.match(source, /await sendPlaylistResponse\(response, bytes,/u);
});


test("directory identity churn during watch installation refuses and closes every provisional watch", async t => {
  let identity = 0;
  const state = fake(t, { directoryIdentity: async () => String(identity++) });
  await assert.rejects(state.reload.read("/media/index.m3u8", params(5)), { status: 503 });
  assert.equal(state.events.length, 3); assert.ok(state.events.every(event => event.closed));
  assert.equal(state.reload.snapshot().watchers, 0); assert.equal(state.reload.snapshot().activeBlocked, 0);
});


test("a delayed matching old directory stat joins an in-progress shared replacement before ready return", async t => {
  let phase = 0, releaseOld, releaseInstall, oldEntered, installEntered;
  const oldHeld = new Promise(resolve => { releaseOld = resolve; });
  const installHeld = new Promise(resolve => { releaseInstall = resolve; });
  const oldStarted = new Promise(resolve => { oldEntered = resolve; });
  const installStarted = new Promise(resolve => { installEntered = resolve; });
  const state = fake(t, { directoryIdentity: async () => {
    if (phase === 0) return "old";
    if (phase === 1) { phase = 2; return "old"; } // Joining reader's first check.
    if (phase === 2) { phase = 3; oldEntered(); await oldHeld; return "old"; }
    if (phase === 3) { phase = 4; return "new"; } // Installer detects replacement.
    if (phase === 4) { phase = 5; installEntered(); await installHeld; return "new"; }
    return "new";
  } });
  const seed = state.reload.read("/media/index.m3u8", params(5));
  const pending = [seed];
  try {
    await until(() => state.reload.snapshot().activeBlocked === 1);
    phase = 1; let oldReturned = false;
    const delayed = state.reload.read("/media/index.m3u8", params(4)).then(bytes => { oldReturned = true; return bytes; });
    pending.push(delayed); await oldStarted;
    const installer = state.reload.read("/media/index.m3u8", params(4)); pending.push(installer);
    await installStarted; releaseOld();
    await flush(); await flush();
    assert.equal(oldReturned, false, "An old identity result cannot bypass the known installation.");
    releaseInstall();
    assert.match((await delayed).toString(), /seg4.ts/u); await installer;
    state.set(playlist(5)); await seed;
    assert.equal(state.reload.snapshot().watchers, 0); assert.equal(state.timers.size, 0);
  } finally {
    releaseOld(); releaseInstall(); state.set(playlist(5)); await Promise.allSettled(pending);
  }
});


test("Windows shallow parent coverage observes directory replacement and ignores unrelated siblings", async t => {
  let identity = "before";
  const state = fake(t, { platform: "win32", directoryIdentity: async directory => directory === "/fixture" ? identity : directory });
  const pending = state.reload.read("/media/index.m3u8", params(5));
  const observed = pending.catch(error => error);
  await until(() => state.reload.snapshot().activeBlocked === 1);
  const parent = state.events.find(event => event.directory === "/");
  assert.ok(parent); const before = state.reads;
  parent.emitChange("rename", "unrelated-fixture"); await flush();
  assert.equal(state.reads, before, "A parent-only watch must ignore other temporary directories.");
  identity = "after"; parent.emitChange("rename", "fixture");
  await until(() => state.events.filter(event => event.directory === "/fixture").length === 2);
  state.set(playlist(5));
  assert.match((await observed).toString(), /seg5.ts/u);
  assert.equal(state.reload.snapshot().watchers, 0); assert.equal(state.timers.size, 0);
});

test("Windows excess shallow coverage declines capability for the whole presentation without losing HTTP bytes", async t => {
  const files = Array.from({ length: 21 }, (_, index) => `/root${index}/leaf/index.m3u8`);
  for (const platform of ["win32", "darwin"]) {
    const state = fake(t, { platform });
    state.publisher.playlistSnapshot = async () => ({ file: files[0], bytes: Buffer.from(playlist()), isMedia: true,
      playlistFiles: files, mediaPlaylists: files.map(file => ({ file, text: playlist() })) });
    const bytes = await state.reload.read("/media/index.m3u8", params(4));
    if (platform === "win32") { assert.equal(bytes.toString(), playlist()); assert.equal(state.events.length, 0); }
    else assert.match(bytes.toString(), /CAN-BLOCK-RELOAD=YES/u);
    assert.equal(state.reload.snapshot().watchers, 0);
  }
});
