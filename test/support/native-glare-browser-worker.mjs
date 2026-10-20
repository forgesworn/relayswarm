// Explicit worker entry; importing this module starts no fixture.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createHlsPublisher } from "../../src/hls-publisher.mjs";
import { createAdmissionControls } from "../../demo/admission.mjs";
import { attachNativeGlareRelay } from "./native-glare-relay.mjs";
import { bounded, cap, journal, stamp } from "./account-browser-guard.mjs";

export async function runNativeGlareWorker(input) {
  await new Promise(resolveStart => {
    const lost = () => process.exit(1);
    process.once("disconnect", lost);
    process.once("message", message => { process.removeListener("disconnect", lost); if (message?.start === true) resolveStart(); else process.exit(1); });
    process.send({ ready: true });
  });
  const { clock } = input, contexts = [], pages = [];
  const receipt = { v: 1, kind: "native-chrome-glare", sourceSha: input.sourceSha, ok: false,
    scope: { dedicatedCollision: true, nativeRTC: true, headless: true, loopback: true, browserFlags: [],
      lifetimePCsPerPage: 1, lifetimePCsTotal: 2, decodedPlayback: false, publicOrigin: false, NAT: false, TURN: false, syntheticEvents: false },
    checkpoints: [], failures: [], cleanup: {} };
  let server, relay, browserServer, browser, base, stopped = false, stage = "setup", served = 0, pageErrors = 0;
  const budget = maximum => cap(clock, "work", maximum);
  const run = (operation, maximum = 15000) => bounded(operation, clock, "work", maximum);
  const stop = () => { stopped = true; void browser?.close().catch(() => {}); };
  const alarm = setTimeout(stop, budget(150000));
  process.on("disconnect", stop); process.on("message", message => { if (message?.stop) stop(); });
  const read = page => page.evaluate(() => window.nativeGlare.snapshot());
  const checkpoint = async name => {
    const viewers = await run(() => Promise.all(pages.map(read)));
    receipt.checkpoints.push({ name, viewers }); return viewers;
  };
  try {
    cap(clock, "work", 1);
    const media = join(input.root, "media"); await mkdir(media, { mode: 0o700 });
    const payload = Buffer.alloc(8192, 90), expectedHash = createHash("sha256").update(payload).digest("hex");
    await writeFile(join(media, "master.m3u8"), "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=32768\nindex.m3u8\n", { flag: "wx" });
    await writeFile(join(media, "index.m3u8"), "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nseg.ts\n#EXT-X-ENDLIST\n", { flag: "wx" });
    await writeFile(join(media, "seg.ts"), payload, { flag: "wx" });
    const publisher = await run(() => createHlsPublisher({ mediaDir: media }));
    const admission = createAdmissionControls({ swarmId: publisher.swarmId });
    const bundle = await run(() => readFile(input.values.bundle)); assert.ok(bundle.length <= 8 * 1024 * 1024);
    stage = "http"; cap(clock, "work", 1);
    server = createServer(async (request, response) => {
      try {
        if (await admission.handle(request, response, request.url, base)) return;
        if (request.method !== "GET") { response.writeHead(405).end(); return; }
        if (request.url === "/") {
          response.setHeader("content-type", "text/html");
          response.end('<!doctype html><label><input id="upload" type="checkbox">Contribute fixture bytes</label><button id="start">Start owned test</button><script type="module" src="/page.mjs"></script>');
        } else if (request.url === "/page.mjs") { response.setHeader("content-type", "text/javascript"); response.end(bundle); }
        else if (request.url === "/configuration") {
          response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ swarmId: publisher.swarmId,
            streamEvent: publisher.streamEvent, admission: admission.descriptor(), relay: base.replace("http:", "ws:") + "/relay" }));
        } else if (request.url === "/commitment") {
          const event = await publisher.commitment({ path: "/media/seg.ts", level: 0, sequence: 0, discontinuity: 0 });
          response.setHeader("content-type", "application/json"); response.end(JSON.stringify(event));
        } else if (request.url === "/media/seg.ts") {
          await publisher.media("/media/seg.ts"); served++;
          response.setHeader("content-type", "application/octet-stream"); response.end(payload);
        } else response.writeHead(404).end();
      } catch { response.writeHead(503).end(); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await run(() => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); }));
    base = `http://127.0.0.1:${server.address().port}`;
    relay = attachNativeGlareRelay(server, { origin: () => base, swarmId: publisher.swarmId, admit: admission.verify });
    stage = "chrome"; cap(clock, "work", 1);
    journal(input.chromeIntent, { nonce: input.nonce, at: stamp() });
    browserServer = await run(() => chromium.launchServer({ executablePath: input.chromeWrapper, headless: true, args: [], timeout: budget(15000) }));
    const owner = JSON.parse(await readFile(input.chromeJournal, "utf8"));
    assert.equal(owner.nonce, input.nonce); assert.equal(browserServer.process().pid, owner.pid);
    browser = await run(() => chromium.connect(browserServer.wsEndpoint(), { timeout: budget(15000) }));
    receipt.scope.browserVersion = browser.version();
    stage = "pages";
    for (let index = 0; index < 2; index++) {
      const context = await run(() => browser.newContext()); contexts.push(context);
      const page = await run(() => context.newPage()); pages.push(page); page.setDefaultTimeout(budget(15000));
      page.on("pageerror", () => { pageErrors++; });
      await run(() => page.goto(base, { timeout: budget(15000) }));
      await run(() => page.waitForFunction(() => !!window.nativeGlare, null, { timeout: budget(15000) }));
    }
    const keys = await run(() => Promise.all(pages.map(page => page.evaluate(() => window.nativeGlare.identify()))));
    relay.setPeers(keys); // Public fixture identities stay in memory, never in the receipt.
    for (const page of pages) await run(() => page.locator("#upload").check());
    stage = "initial-offers";
    await run(() => Promise.all(pages.map(page => page.locator("#start").click())));
    await run(() => Promise.all(pages.map(page => page.waitForFunction(() => {
      const value = window.nativeGlare.snapshot();
      return value.pcCount === 1 && value.offerInstalled === 1 && value.offerSent === 1 && value.signalingState === "have-local-offer";
    }, null, { timeout: budget(6000) }))), 6000);
    const initial = await checkpoint("two-native-local-offers");
    assert.equal(relay.snapshot().held, 2); relay.release(initial);
    stage = "native-rollback-link";
    await run(() => Promise.all(pages.map(page => page.waitForFunction(() => window.nativeGlare.snapshot().peers?.connected === 1,
      null, { timeout: budget(12000) }))), 12000);
    const linked = await checkpoint("one-link-per-original-pc");
    const yielding = keys[0] > keys[1] ? 0 : 1;
    for (const [index, view] of linked.entries()) {
      assert.equal(view.pcCount, 1); assert.equal(view.trustedStart, true); assert.equal(view.uploadChecked, true);
      assert.equal(view.counts.pcRefused, 0); assert.equal(view.peers.linksOpened, 1);
      assert.equal(view.peers.linksClosed, 0); assert.equal(view.peers.dialsTimedOut, 0); assert.equal(view.peers.admitRefused, 0);
      assert.equal(view.counts.channelOpen, 1); assert.equal(view.counts.peakOpen, 1); assert.equal(view.counts.operationFailed, 0);
      assert.equal(view.counts.dropped, 0); assert.equal(view.setupFailed, false); assert.equal(view.errors, 0);
      assert.equal(view.counts.rollback, index === yielding ? 1 : 0); assert.equal(view.counts.rollbackCompleted, index === yielding ? 1 : 0);
      assert.equal(view.counts.remoteOffer, index === yielding ? 1 : 0); assert.equal(view.counts.remoteAnswer, index === yielding ? 0 : 1);
      if (index === yielding) { assert.equal(view.channels.length, 2); assert.equal(view.channels[0].state, "closed"); }
    }
    stage = "verified-payload";
    const seed = await run(() => pages[0].evaluate(() => window.nativeGlare.load()));
    assert.deepEqual(seed, { bytes: 8192, sha256: expectedHash });
    await run(() => pages[1].waitForFunction(() => window.nativeGlare.snapshot().matchingHave, null, { timeout: budget(5000) }), 5000);
    const transfer = await run(() => pages[1].evaluate(() => window.nativeGlare.load()));
    assert.deepEqual(transfer, seed);
    const final = await checkpoint("hash-verified-peer-loader-payload");
    assert.equal(final[1].peerLoads, 1); assert.equal(final[1].bytes.peerFirst, 8192); assert.equal(final[0].bytes.uploaded, 8192);
    assert.equal(served, 1); assert.equal(pageErrors, 0); assert.equal(relay.snapshot().failed, false);
    for (const view of final) assert.ok(view.authorityFresh && !view.setupFailed && view.pcCount === 1 && view.counts.pcRefused === 0
      && view.peers.connected === 1 && view.peers.linksOpened === 1 && view.peers.linksClosed === 0 && view.counts.peakOpen === 1 && view.counts.dropped === 0);
    receipt.payload = { bytes: 8192, sha256: expectedHash, seedRequests: served, verifiedPeerLoads: 1 };
    receipt.relay = relay.snapshot(); receipt.ok = !stopped;
  } catch (error) {
    // Retain the original gate first. Diagnostic failure cannot replace it.
    let errorName = "unknown";
    try { const value = error?.name; if (["TimeoutError", "AssertionError", "Error", "TypeError"].includes(value)) errorName = value; } catch {}
    receipt.failures.push({ stage, category: "assertion-or-operation-failed", errorName });
    const observation = { viewers: Array.from({ length: 2 }, (_, index) => ({ page: index + 1,
      status: pages[index] ? "pending" : "not-created", snapshot: null })), relay: { status: "not-created", snapshot: null } };
    receipt.failureObservation = observation;
    if (relay) {
      try { cap(clock, "work", 1); observation.relay = { status: "retained", snapshot: relay.snapshot() }; }
      catch { observation.relay.status = "refused-or-unavailable"; }
    }
    await Promise.all(pages.map(async (page, index) => {
      const entry = observation.viewers[index];
      try { cap(clock, "work", 1); }
      catch { entry.status = "refused-original-deadline"; return; }
      try {
        entry.snapshot = await bounded(() => page.evaluate(() => window.nativeGlare.snapshot(true)), clock, "work", 1000);
        entry.status = "retained";
      } catch { entry.status = "unavailable-or-timeout"; }
    }));
  }
  finally {
    clearTimeout(alarm); process.removeListener("disconnect", stop);
    const close = async (name, exists, action) => {
      receipt.cleanup[name] = exists ? false : null;
      if (!exists) return;
      try { await bounded(action, clock, "grace", 5000); receipt.cleanup[name] = true; }
      catch { receipt.failures.push({ stage: "cleanup", category: name }); }
    };
    await close("pagesStoppedAndNativeClosed", pages.length > 0, async () => {
      const outcomes = await Promise.allSettled(pages.map(async page => {
        try {
          await page.evaluate(() => window.nativeGlare.stop());
          await page.waitForFunction(() => { const view = window.nativeGlare.snapshot(); return view.stopped && view.pcClosed && view.hlsDestroyed === true && view.channels.every(channel => channel.state === "closed"); }, null, { timeout: cap(clock, "grace", 4000) });
        } finally { await page.evaluate(() => window.nativeGlare.detach()); }
      }));
      assert.ok(outcomes.every(value => value.status === "fulfilled"));
    });
    await close("contextsClosed", contexts.length > 0, async () => {
      const outcomes = await Promise.allSettled(contexts.map(context => context.close()));
      assert.ok(outcomes.every(value => value.status === "fulfilled"));
    });
    await close("browserClosed", !!browser, () => browser.close());
    await close("chromeServerClosed", !!browserServer, () => browserServer.close());
    await close("relayClosed", !!relay, () => relay.close());
    await close("httpClosed", !!server, () => new Promise((resolveClose, reject) => { server.close(error => error ? reject(error) : resolveClose()); server.closeAllConnections(); }));
    receipt.ok = receipt.ok && receipt.failures.length === 0 && Object.values(receipt.cleanup).every(value => value === true);
    await bounded(() => writeFile(input.workerReceipt, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" }), clock, "grace", 3000);
  }
  return receipt.ok;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const input = JSON.parse(await readFile(process.env.RELAYSWARM_ACCOUNT_INPUT, "utf8"));
    process.exit(await runNativeGlareWorker(input) ? 0 : 1);
  } catch { process.exit(1); }
}
