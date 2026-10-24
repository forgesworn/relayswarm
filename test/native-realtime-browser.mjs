// Explicit native dependency qualification. Missing/wrong versions fail;
// this command has no successful skipped mode and captures no real media.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { createNativeRealtimeBackend, NATIVE_REALTIME_PACKAGE_VERSION } from '../src/node/native-realtime.mjs';
import { RelayPool, RelaySwarmSession } from '../src/relay-session.mjs';
import { RealtimePeer } from '../src/browser/realtime-peer.mjs';
import { startLocalRelay } from './support/local-relay.mjs';

let backend, peer, browser, relay, http, pool, session;
let phase = 'dependencies';
async function until(check, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Native real-time qualification timed out.');
}
try {
  assert(process.env.E2E_NATIVE_PACKAGE_ROOT, 'Supply an explicit pinned native package directory');
  const packageRoot = resolve(process.env.E2E_NATIVE_PACKAGE_ROOT);
  const metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'node-datachannel'); assert.equal(metadata.version, NATIVE_REALTIME_PACKAGE_VERSION);
  const require = createRequire(join(packageRoot, 'package.json'));
  backend = await createNativeRealtimeBackend({ nodeDataChannel: require(packageRoot), packageVersion: metadata.version });
  phase = 'local-relay';
  const bundle = await build({ stdin: { contents: `
    export {RelayPool,RelaySwarmSession} from './src/relay-session.mjs';
    export {RealtimePeer} from './src/browser/realtime-peer.mjs';`, resolveDir: new URL('../', import.meta.url).pathname },
    bundle: true, platform: 'browser', format: 'esm', write: false });
  relay = await startLocalRelay();
  http = createServer((request, response) => {
    if (request.url === '/runtime.js') { response.setHeader('content-type', 'text/javascript'); response.end(bundle.outputFiles[0].text); }
    else if (request.url === '/') { response.setHeader('content-type', 'text/html'); response.end('<script type="module">import * as runtime from "/runtime.js";window.runtime=runtime</script>'); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
  pool = new RelayPool([relay.url]); await pool.connect();
  session = new RelaySwarmSession({ pool, swarmId: 'native-initiator-live-v1' }); session.start();
  phase = 'browser';
  browser = await chromium.launch({ headless: true,
    ...(process.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.E2E_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${http.address().port}/`); await page.waitForFunction(() => window.runtime);
  const browserKey = await page.evaluate(async ({ relayUrl, operator }) => {
    window.pool = new window.runtime.RelayPool([relayUrl]); await window.pool.connect();
    window.session = new window.runtime.RelaySwarmSession({ pool: window.pool, swarmId: 'native-initiator-live-v1' }); window.session.start();
    window.received = [];
    window.peer = new window.runtime.RealtimePeer({ session: window.session, peerPubkey: operator, initiator: false,
      iceServers: [], iceTransportPolicy: 'all', maxPacketLifeTimeMs: 250, timeoutMs: 15000,
      onDatagram: bytes => window.received.push([...bytes]) });
    window.receiverReady = window.peer.start(); window.receiverReady.catch(() => {});
    return window.session.pubkey;
  }, { relayUrl: relay.url, operator: session.pubkey });
  phase = 'native-offer-browser-answer';
  const received = [];
  peer = new RealtimePeer({ session, peerPubkey: browserKey, initiator: true, iceServers: [], iceTransportPolicy: 'all',
    maxPacketLifeTimeMs: 250, timeoutMs: 15000, RTCPeerConnectionImpl: backend.RTCPeerConnectionImpl,
    onDatagram: bytes => received.push([...bytes]) });
  await Promise.all([peer.start(), page.evaluate(() => window.receiverReady)]);
  const actual = await page.evaluate(() => ({ ordered: window.peer.channel.ordered,
    maxPacketLifeTime: window.peer.channel.maxPacketLifeTime, maxRetransmits: window.peer.channel.maxRetransmits,
    label: window.peer.channel.label }));
  assert.deepEqual(actual, { ordered: false, maxPacketLifeTime: 250, maxRetransmits: null, label: 'relayswarm-live-v1' });
  phase = 'generated-binary-exchange';
  assert(peer.send(new Uint8Array([0, 11, 255, 4])));
  await page.waitForFunction(() => window.received.length === 1, { timeout: 5000 });
  assert.deepEqual(await page.evaluate(() => window.received), [[0, 11, 255, 4]]);
  assert(await page.evaluate(() => window.peer.send(new Uint8Array([33, 0, 255, 7]))));
  await until(() => received.length === 1); assert.deepEqual(received, [[33, 0, 255, 7]]);
  const readySnapshot = backend.snapshot();
  phase = 'unknown-incoming-channel-refusal';
  await page.evaluate(() => { window.extra = window.peer.pc.createDataChannel('unknown-incoming', { ordered: true }); });
  await until(() => backend.snapshot().ownedPeers === 0);
  assert.equal(peer.closed, true);
  console.log(JSON.stringify({ passed: true, generatedDatagramsOnly: true, nativeInitiator: true,
    browserAnswerer: true, browserObservedDcep: actual, binaryBidirectional: true, unknownIncomingChannelRefused: true,
    certificateBypass: false, ice: 'loopback-direct', publicNat: false, physicalDevice: false,
    packageVersion: metadata.version, native: readySnapshot, cleanupOwnedPeers: backend.snapshot().ownedPeers }));
  await page.evaluate(() => { window.peer.close(); window.session.close(); window.pool.close(); });
} catch {
  console.error(`Native real-time browser qualifier failed at ${phase}.`); process.exitCode = 1;
} finally {
  peer?.close(); session?.close(); pool?.close(); backend?.closeOwnedPeers();
  await browser?.close();
  if (http?.listening) await new Promise(resolve => http.close(resolve));
  await relay?.close();
  // Dedicated, finite qualification process only. Never do this for an
  // individual call in an embedding process with unrelated native peers.
  backend?.disposeForProcessExit();
}
