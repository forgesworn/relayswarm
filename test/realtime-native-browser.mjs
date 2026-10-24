// Actual Chromium initiator -> werift answerer. Opaque generated datagrams,
// loopback ICE/signalling only; no camera, TURN, WAN or performance claim.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { RTCPeerConnection } from "werift";
import { RelayPool, RelaySwarmSession } from "../src/relay-session.mjs";
import { RealtimePeer } from "../src/browser/realtime-peer.mjs";
import { startLocalRelay } from "./support/local-relay.mjs";

let relay, http, pool, session, browser, peer;
try {
  const bundle = await build({ stdin: { contents: `
    export {RelayPool, RelaySwarmSession} from './src/relay-session.mjs';
    export {RealtimePeer} from './src/browser/realtime-peer.mjs';`,
    resolveDir: new URL("../", import.meta.url).pathname }, bundle: true,
    format: "esm", platform: "browser", write: false });
  relay = await startLocalRelay();
  http = createServer((request, response) => {
    if (request.url === "/runtime.js") {
      response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0].text);
    } else if (request.url === "/") {
      response.setHeader("content-type", "text/html");
      response.end('<script type="module">import * as runtime from "/runtime.js";window.runtime=runtime</script>');
    } else { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  pool = new RelayPool([relay.url]); await pool.connect();
  session = new RelaySwarmSession({ pool, swarmId: "chrome-native-realtime-fixture" }); session.start();
  browser = await chromium.launch({ headless: true,
    ...(process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${http.address().port}/`); await page.waitForFunction(() => window.runtime);
  const browserKey = await page.evaluate(async (relayUrl) => {
    window.pool = new window.runtime.RelayPool([relayUrl]); await window.pool.connect();
    window.session = new window.runtime.RelaySwarmSession({ pool: window.pool, swarmId: "chrome-native-realtime-fixture" });
    window.session.start(); window.received = []; return window.session.pubkey;
  }, relay.url);
  const nativeReceived = [];
  peer = new RealtimePeer({ session, peerPubkey: browserKey, initiator: false,
    RTCPeerConnectionImpl: RTCPeerConnection, iceTransportPolicy: "all", iceServers: [], timeoutMs: 15_000,
    onDatagram: (bytes) => { nativeReceived.push([...bytes]); peer.send(new Uint8Array([4, 5])); } });
  const nativeReady = peer.start();
  await Promise.all([nativeReady, page.evaluate(async (operator) => {
    window.peer = new window.runtime.RealtimePeer({ session: window.session, peerPubkey: operator,
      initiator: true, iceTransportPolicy: "all", iceServers: [], timeoutMs: 15_000,
      onDatagram: bytes => window.received.push([...bytes]) });
    await window.peer.start(); window.peer.send(new Uint8Array([1, 2, 3]));
  }, session.pubkey)]);
  await page.waitForFunction(() => window.received.length === 1, { timeout: 5_000 });
  assert.deepEqual(nativeReceived, [[1, 2, 3]]);
  assert.deepEqual(await page.evaluate(() => window.received), [[4, 5]]);
  assert.equal(peer.channel.ordered, false); assert.equal(peer.channel.maxRetransmits, 0); assert.equal(peer.channel.maxPacketLifeTime, null);
  console.log(JSON.stringify({ passed: true, chromiumToNative: true, generatedDatagramsOnly: true,
    ordered: false, maxRetransmits: 0, certificateBypass: false, ice: "loopback-direct",
    native: peer.snapshot(), browser: await page.evaluate(() => window.peer.snapshot()) }));
  await page.evaluate(() => { window.peer.close(); window.session.close(); window.pool.close(); });
} catch {
  console.error("Chromium-to-native real-time qualifier failed."); process.exitCode = 1;
} finally {
  peer?.close(); session?.close(); pool?.close(); await browser?.close();
  if (http?.listening) await new Promise(resolve => http.close(resolve));
  await relay?.close();
}
