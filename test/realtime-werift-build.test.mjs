import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { realtimeWeriftPlugin, weriftRealtimeRevision } from "../src/node/realtime-werift-build.mjs";

const packageRoot = process.env.WERIFT_REALTIME_PACKAGE_ROOT;
if (!packageRoot) throw new Error('WERIFT_REALTIME_PACKAGE_ROOT must select the reviewed werift 0.24.4 installation.');
const shim = 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Backend condition timed out'); await sleep(5); }
}
let directory, backend;
test.after(async () => { if (directory) await rm(directory, { recursive: true }); });
test('unknown source is refused before esbuild can use an uncorrected backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relayswarm-backend-invalid-'));
  try {
    await mkdir(join(dir, 'lib'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'werift', version: '0.24.4', license: 'MIT' }));
    await writeFile(join(dir, 'lib/index.mjs'), 'export class RTCPeerConnection {}');
    await assert.rejects(realtimeWeriftPlugin({ packageRoot: dir }), /Unsupported werift realtime/);
  } finally { await rm(dir, { recursive: true }); }
});

test('reviewed backend builds self-contained with MIT notice and refuses browser/external policies', async () => {
  directory = await mkdtemp(join(tmpdir(), 'relayswarm-backend-reviewed-'));
  const file = join(directory, 'backend.mjs');
  const original = await readFile(join(packageRoot, 'lib/index.mjs'));
  await build({ stdin: { contents: 'export {RTCPeerConnection} from "werift";' }, outfile: file,
    platform: 'node', format: 'esm', bundle: true, banner: { js: shim }, plugins: [await realtimeWeriftPlugin({ packageRoot })] });
  const output = await readFile(file, 'utf8');
  assert.ok(output.includes('Copyright (c) 2020 shinyoshiaki')); assert.ok(output.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
  assert.ok(!/from ["']werift["']/u.test(output));
  assert.equal(weriftRealtimeRevision.version, '0.24.4');
  backend = await import(pathToFileURL(file).href);
  assert.deepEqual(await readFile(join(packageRoot, 'lib/index.mjs')), original, 'installed package remains unchanged');
  await assert.rejects(build({ stdin: { contents: 'import "werift";' }, write: false, bundle: true, format: 'esm', platform: 'browser',
    logLevel: 'silent', plugins: [await realtimeWeriftPlugin({ packageRoot })] }), /Unsupported werift/);
});

async function association(t, shouldDrop = () => false) {
  assert.ok(backend, 'reviewed backend build must pass first');
  const pc = new backend.RTCPeerConnection({ iceServers: [] });
  pc.createDataChannel('fixture', { ordered: false, maxRetransmits: 0 });
  const Ctor = pc.sctp.sctp.constructor;
  await pc.close();
  const packets = [], received = [], left = {}, right = {};
  const send = (direction, target) => async data => {
    const packet = Buffer.from(data), type = packet[12], payload = type === 0 ? packet.subarray(28, 12 + packet.readUInt16BE(14)) : Buffer.alloc(0);
    const row = { direction, type, payload: payload.toString(), flags: packet[13], tsn: type === 0 ? packet.readUInt32BE(16) : null };
    packets.push(row);
    // Deliver on a later task, like a UDP receive, after send() has resolved.
    if (!shouldDrop(row)) setTimeout(() => target.onData?.(packet), 1);
  };
  left.send = send('left', right); right.send = send('right', left);
  const a = new Ctor(left), b = new Ctor(right); a.isServer = false; b.isServer = true;
  b.onReceive.subscribe((_stream, _protocol, data) => received.push(data.toString()));
  t.after(async () => {
    await a.stop(); await b.stop();
    assert.equal(a.realtimeExpiryTimer, undefined); assert.equal(b.realtimeExpiryTimer, undefined);
  });
  await b.start(5000); await a.start(5000); await until(() => a.state === 'connected' && b.state === 'connected');
  // Accelerate the retry trigger in this simulated packet fixture. Production
  // RTO values are unchanged; the lifetime timer itself is not accelerated.
  a.rto = .1;
  return { a, b, packets, received };
}

test('actual SCTP wire loss never retransmits a zero-retry message and still delivers its successor', async t => {
  const { a, packets, received } = await association(t, row => row.direction === 'left' && row.type === 0 && row.payload === 'lost');
  await a.send(0, 53, Buffer.from('lost'), { ordered: false, maxRetransmits: 0 });
  await a.send(0, 53, Buffer.from('next'), { ordered: false, maxRetransmits: 0 });
  await until(() => received.includes('next'));
  await until(() => packets.some(row => row.direction === 'left' && row.type === 192));
  assert.equal(packets.filter(row => row.direction === 'left' && row.payload === 'lost').length, 1);
  assert.deepEqual(received, ['next']);
  assert.ok(packets.some(row => row.direction === 'left' && row.type === 192), 'FORWARD TSN advances loss');
});

test('actual SCTP wire expires unsent payload behind zero receive window without ever sending it', async t => {
  const { a, packets, received } = await association(t);
  a.peerAdvertisedRwnd = 0;
  let settled = false;
  const pending = a.send(0, 53, Buffer.from('expired-unsent'), { ordered: false, expiry: performance.now() / 1000 + .05 }).then(() => { settled = true; });
  await until(() => settled); await pending;
  assert.equal(a.outboundQueue.length, 0);
  a.peerAdvertisedRwnd = 65536; await a.transmit(); await sleep(50);
  assert.equal(packets.filter(row => row.type === 0 && row.payload === 'expired-unsent').length, 0);
  assert.deepEqual(received, []);
  await a.send(0, 53, Buffer.from('fresh'), { ordered: false, expiry: performance.now() / 1000 + .5 });
  await until(() => received.includes('fresh'));
});

test('wall-clock rollback cannot extend the private monotonic SCTP media deadline', async t => {
  const { a, packets } = await association(t);
  a.peerAdvertisedRwnd = 0;
  let settled = false;
  const pending = a.send(0, 53, Buffer.from('clock-rollback'), { ordered: false, expiry: performance.now() / 1000 + .05 }).then(() => { settled = true; });
  const wallNow = Date.now;
  // The production media expiry clock is independent of wall-clock corrections.
  Date.now = () => wallNow() - 60_000;
  try { await until(() => settled); await pending; }
  finally { Date.now = wallNow; }
  assert.equal(a.outboundQueue.length, 0);
  assert.equal(packets.filter(row => row.type === 0 && row.payload === 'clock-rollback').length, 0);
});

test('actual SCTP lifetime abandons the expired message rather than a different earlier message', async t => {
  let heldAttempts = 0;
  const { a, packets, received } = await association(t, row => {
    if (row.direction !== 'left' || row.type !== 0) return false;
    if (row.payload === 'held') return ++heldAttempts === 1;
    return row.payload === 'expired';
  });
  await a.send(0, 53, Buffer.from('held'), { ordered: false });
  await a.send(0, 53, Buffer.from('expired'), { ordered: false, expiry: performance.now() / 1000 + .05 });
  await until(() => received.includes('held')); await sleep(150);
  assert.ok(heldAttempts >= 2); assert.equal(received.includes('expired'), false);
  assert.equal(packets.filter(row => row.direction === 'left' && row.payload === 'expired').length, 1);
});

test('actual SCTP fragmented message loss leaves independent neighbouring messages intact', async t => {
  const { a, received, packets } = await association(t, row => row.direction === 'left' && row.type === 0 && row.flags === 4 && row.payload.startsWith('X'));
  await a.send(0, 53, Buffer.from('before'), { ordered: false });
  await a.send(0, 53, Buffer.alloc(3600, 'X'), { ordered: false, maxRetransmits: 0 });
  await a.send(0, 53, Buffer.from('after'), { ordered: false });
  await until(() => received.includes('after'));
  await until(() => packets.some(row => row.direction === 'left' && row.type === 192));
  assert.deepEqual(received, ['before', 'after']);
  assert.equal(packets.filter(row => row.direction === 'left' && row.type === 0 && row.flags === 4 && row.payload.startsWith('X')).length, 1);
});

test('a lost first FORWARD TSN is retried until receiver cumulative progress releases the expired fragment', async t => {
  let forwards = 0;
  const { a, b, received } = await association(t, row => {
    if (row.direction !== 'left') return false;
    if (row.type === 192) return ++forwards === 1;
    return row.type === 0 && row.flags === 4 && row.payload.startsWith('Z');
  });
  await a.send(0, 53, Buffer.alloc(3600, 'Z'), { ordered: false, expiry: performance.now() / 1000 + .05 });
  const skipped = (a.localTsn - 1) >>> 0;
  await until(() => b.lastReceivedTsn === skipped);
  assert.ok(forwards >= 2); assert.deepEqual(received, []);
  assert.equal(a.sentQueue.length, 0);
  await until(() => a.lastSackedTsn === skipped);
  assert.equal(a.flightSize, 0);
});

test('actual data-channel lifetime is captured before waiting in its application queue', async () => {
  const pc = new backend.RTCPeerConnection({ iceServers: [] });
  try {
    const channel = pc.createDataChannel('lifetime', { ordered: false, maxPacketLifeTime: 50 });
    const transport = pc.sctp, sent = [];
    const open = transport.dataChannelQueue[0][2];
    assert.equal(open[1], 0x82, 'DCEP preserves unordered plus timed reliability');
    transport.dataChannelQueue = [];
    transport.sctp.associationState = 4;
    transport.sctp.send = async (_id, _protocol, data) => { sent.push(data.toString()); };
    transport.dataChannelQueue.push([channel, 53, Buffer.from('queued-expired'), performance.now() / 1000 - .001]);
    channel.addBufferedAmount(14);
    await transport.dataChannelFlush();
    assert.deepEqual(sent, []); assert.equal(channel.bufferedAmount, 0);
    transport.sctp.associationState = 1;
    channel.send('waits-before-establishment');
    const queuedExpiry = transport.dataChannelQueue[0][3];
    assert.ok(queuedExpiry > performance.now() / 1000 && queuedExpiry <= performance.now() / 1000 + .051);
  } finally { await pc.close(); }
});
