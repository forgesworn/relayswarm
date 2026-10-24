#!/usr/bin/env node
// Native Chrome proof for a cancelled large ranged response and the next
// request on the same reliable channel. Loopback, without video or signalling.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright-core";

async function scenario(loadCore, PeerLink) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const wait = async (predicate, message, ms = 5_000) => {
    const end = performance.now() + ms;
    while (!predicate()) {
      check(performance.now() < end, message);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const source = Uint8Array.from({ length: 6 * 1024 * 1024 }, (_, index) => (index * 31 + 7) & 255);
  const key = "a".repeat(64), pieceSize = 98_304;
  const pcs = [new RTCPeerConnection({ iceServers: [] }), new RTCPeerConnection({ iceServers: [] })];
  let holder, receiver, active = true;
  const failures = [], cancelledBytes = [], sent = { binary: 0, afterCancel: 0, bufferAtCancel: null };
  try {
    const cores = await Promise.all([loadCore("/core.wasm"), loadCore("/core.wasm")]);
    const holderChannel = pcs[0].createDataChannel("ranges", { ordered: true });
    const remote = new Promise(resolve => pcs[1].addEventListener("datachannel", event => resolve(event.channel), { once: true }));
    await pcs[0].setLocalDescription(await pcs[0].createOffer());
    await wait(() => pcs[0].iceGatheringState === "complete", "offer ICE did not complete");
    await pcs[1].setRemoteDescription(pcs[0].localDescription);
    await pcs[1].setLocalDescription(await pcs[1].createAnswer());
    await wait(() => pcs[1].iceGatheringState === "complete", "answer ICE did not complete");
    await pcs[0].setRemoteDescription(pcs[1].localDescription);
    const receiverChannel = await remote;
    await wait(() => holderChannel.readyState === "open" && receiverChannel.readyState === "open", "channels did not open");
    let cancelSeen = false;
    const nativeSend = holderChannel.send.bind(holderChannel);
    holderChannel.send = data => {
      nativeSend(data);
      if (typeof data !== "string") {
        sent.binary += data.byteLength;
        if (cancelSeen && active) sent.afterCancel += data.byteLength;
      }
    };
    holderChannel.addEventListener("message", event => {
      if (typeof event.data !== "string") return;
      const frame = JSON.parse(event.data);
      if (frame.t === "cancel" && frame.id === 1) {
        cancelSeen = true;
        sent.bufferAtCancel = holderChannel.bufferedAmount;
      }
    });
    holder = cores[0].peerLink({ pubkey: "receiver", pc: pcs[0], channel: holderChannel,
      maxSegmentBytes: source.length, onRequest: () => source,
      onUploadCancelled: (_link, bytes) => cancelledBytes.push(bytes), onClose: link => failures.push(link.closeReason) });
    receiver = cores[1].peerLink({ pubkey: "holder", pc: pcs[1], channel: receiverChannel,
      maxSegmentBytes: source.length, onClose: link => failures.push(link.closeReason) });
    const controller = new AbortController();
    const first = await receiver.request(key, 5_000, { signal: controller.signal, expectedSize: source.length,
      range: { start: 0, end: 64, objectSize: source.length }, onProgress: () => controller.abort(PeerLink.ABANDON_REASON) });
    check(first === null, "cancelled request returned media");
    await wait(() => !receiver.busy && holder.outboundInFlight === 0, "cancelled response never reached its EOF", 2_900);
    check(cancelSeen && cancelledBytes.length === 1, "holder did not acknowledge cancellation");
    check(sent.binary > 0 && sent.binary < source.length, "large response did not stop early");
    check(sent.afterCancel === 0, "holder sent binary media after processing cancellation");
    check(cancelledBytes[0] === source.length - sent.binary, "cancelled byte accounting was inconsistent");
    const cancelledSentBytes = sent.binary;
    // The old upload/request drain deadlines must no longer own this link.
    await new Promise(resolve => setTimeout(resolve, 3_200));
    check(pcs.every(pc => pc.connectionState === "connected") && !holder.closed && !receiver.closed, "cancelled link did not survive its previous drain deadline");
    active = false;
    const next = await receiver.request(key, 5_000, { expectedSize: 4 * pieceSize,
      range: { start: 1, end: 5, objectSize: source.length } });
    check(next?.byteLength === 4 * pieceSize, "next ranged request did not complete");
    const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte => byte.toString(16).padStart(2, "0")).join("");
    check(await digest(next) === await digest(source.slice(pieceSize, 5 * pieceSize)), "next range bytes did not match the source");
    check(!receiver.busy && !holder.closed && !receiver.closed && failures.length === 0, "reused link retained work or failed");
    const result = { ok: true, sourceBytes: source.length, cancelledSentBytes, cancelledUnsentBytes: cancelledBytes[0],
      binaryBytesAfterCancel: sent.afterCancel, nativeBufferedBytesAtCancel: sent.bufferAtCancel,
      nextRangeBytes: next.byteLength, nextRangeSha256: await digest(next), survivedDrainDeadlineMs: 3_200,
      nativeConnectionStates: pcs.map(pc => pc.connectionState), failures: [...failures] };
    holder.close(); receiver.close();
    result.closedConnectionStates = pcs.map(pc => pc.connectionState);
    return result;
  } finally {
    holder?.close(); receiver?.close();
    for (const pc of pcs) pc.close();
  }
}

const root = fileURLToPath(new URL("../", import.meta.url));
const wasm = await readFile(new URL("../src/browser/relayswarm-core.wasm", import.meta.url));
const bundle = await build({ stdin: { contents: `import { loadCore } from './src/browser/core-wasm.mjs';\nimport { PeerLink } from './src/browser/peer-link.mjs';\nwindow.run = () => (${scenario.toString()})(loadCore, PeerLink);`, resolveDir: root },
  bundle: true, platform: "browser", format: "esm", write: false });
const server = createServer((request, response) => {
  if (request.url === "/") response.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><script type="module" src="/fixture.mjs"></script>');
  else if (request.url === "/fixture.mjs") response.writeHead(200, { "content-type": "text/javascript" }).end(bundle.outputFiles[0].contents);
  else if (request.url === "/core.wasm") response.writeHead(200, { "content-type": "application/wasm" }).end(wasm);
  else response.writeHead(404).end();
});
let browser, timer;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => typeof window.run === "function");
  const result = await Promise.race([page.evaluate(() => window.run()), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Native range cancellation fixture exceeded 30 seconds.")), 30_000);
  })]);
  assert.deepEqual(errors, []);
  assert.ok(result.closedConnectionStates.every(state => state === "closed"));
  const receipt = { at: new Date().toISOString(), fixture: "Native Chrome loopback, two actual RTCPeerConnections, no video/signalling", browserVersion: browser.version(), ...result, pageErrors: errors };
  const path = process.argv.indexOf("--receipt");
  if (path >= 0) await writeFile(process.argv[path + 1], `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  clearTimeout(timer);
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
