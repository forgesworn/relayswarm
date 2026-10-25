import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { M3U8Parser, LoaderContextType } from 'hls.js';
import { warmContext } from '../src/browser/warm-ahead.mjs';
import { commitmentContent, KIND_SEGMENT_COMMITMENT } from '../src/browser/segment-commitment.mjs';
import { startLocalRelay } from './support/local-relay.mjs';
import { RelayPool, RelaySwarmSession } from '../src/relay-session.mjs';
const { createHlsSwarm } = await import(process.env.TEST_SWARM_MODULE ?? '../src/browser/hls-swarm.mjs');
const coreWasm = process.env.RELAYSWARM_TEST_CORE === '1'
  ? await WebAssembly.compile(await readFile(new URL('../src/browser/relayswarm-core.wasm', import.meta.url))) : undefined;
const sha = data => createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(5); } assert.fail('Expected bounded loader state was not reached'); };

async function fixture(t, options = {}) {
  const relay = await startLocalRelay();
  const bytes = Uint8Array.from({ length: options.size ?? 1024 }, (_, i) => i % 251);
  const requests = [], sk = generateSecretKey(), swarmId = 'warm-ahead-fixture';
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000),
    tags: [['d', swarmId], ['relayswarm', 'redistribute', '1']], content: '' }, sk);
  // Use real hls.js 1.7.3 Fragment getters/base.url identity rather than a
  // convenient plain-object approximation of the application's parser.
  const playlist = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n' +
    Array.from({ length: 12 }, (_, sn) => `#EXTINF:2,\ns${sn}.m4s\n`).join('');
  const fragments = M3U8Parser.parseLevelPlaylist(playlist, 'https://origin.example/media/index.m3u8', 0, 'main', 0, null).fragments;
  const events = new Map();
  const state = { refuse: false, expired: false, stall: false, blockedChecks: 0, onBlock: null };
  class Loader {
    stats = { loaded: 0, loading: { start: 0, first: 0, end: 0 } };
    load(context, config, callbacks) {
      this.context = context;
      const row = { context, config, callbacks, loader: this, aborted: false, completed: false, started: performance.now(), finish: (body = bytes) => {
        if (row.aborted) return;
        row.completed = true;
        Object.assign(this.stats, { loaded: body.length, total: body.length, loading: { start: row.started, first: row.started, end: performance.now() } });
        callbacks.onSuccess({ url: context.url, data: body.slice().buffer, code: 200 }, this.stats, context, null);
      } };
      this.row = row; requests.push(row);
      if (!options.held?.includes(context.frag.sn)) row.finish();
    }
    abort() { if (this.row && !this.row.completed && !this.row.aborted) { this.row.aborted = true; this.stats.aborted = true; this.row.callbacks.onAbort?.(this.stats, this.context, null); } }
    destroy() { this.abort(); }
  }
  const connections = [];
  class PC extends EventTarget {
    iceGatheringState = 'complete'; localDescription = { sdp: 'fixture-sdp' };
    constructor() { super(); connections.push(this); }
    close() {} async createAnswer() { return { type: 'answer', sdp: 'fixture-sdp' }; }
    async setLocalDescription() {} async setRemoteDescription() {}
  }
  const media = Object.assign(new EventTarget(), { paused: false, currentTime: 0,
    buffered: options.buffered === false ? { length: 0 } : { length: 1, start: () => 0, end: () => 20 } });
  const getCommitment = async context => {
    if (state.stall) { state.blockedChecks++; state.onBlock?.(); return new Promise(() => {}); }
    if (state.refuse) return null;
    const seconds = Math.floor(Date.now() / 1000), key = sha(`${swarmId}\n${new URL(context.url).pathname}`);
    const cacheKey = `${key}:${context.frag.sn}:${context.frag.cc}:${state.expired}`;
    if (events.has(cacheKey)) return events.get(cacheKey);
    const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds, tags: [['x', swarmId], ['e', streamEvent.id]],
      content: commitmentContent({ v: 2, streamEventId: streamEvent.id, swarmId, key, rendition: '/media/index.m3u8',
        playlist: '/media/index.m3u8', mediaType: 'main', encryption: null, sequence: context.frag.sn, discontinuity: context.frag.cc,
        part: null, sha256: options.badHash ? 'f'.repeat(64) : sha(bytes), size: bytes.length, expiresAt: seconds + (state.expired ? -1 : 120) }) }, sk);
    events.set(cacheKey, event); return event;
  };
  const swarm = createHlsSwarm({ swarmId, mode: 'peer-first', serve: true, warmAhead: options.enabled ?? true,
    streamEvent, getCommitment, RTCPeerConnectionImpl: PC, relays: [relay.url], ...(coreWasm ? { coreWasm } : {}),
    maxHeldBytes: options.maxHeldBytes ?? 64 * 1024 * 1024, maxHeldSegments: options.maxHeldSegments ?? 12,
    ...(options.allowance === undefined ? {} : { maxUploadBytesPerSession: options.allowance }) });
  const hls = { config: { loader: Loader, progressive: false }, media, levels: [{ details: { live: true, fragments } }] };
  swarm.attach(hls);
  t.after(async () => { swarm.stop(); await relay.close(); });
  if (coreWasm) await until(() => swarm.metrics().core?.state === 'ready');
  const load = sn => {
    const loader = new hls.config.fLoader(hls.config), context = { url: fragments[sn].url, frag: fragments[sn], responseType: 'arraybuffer',
      type: LoaderContextType.MEDIA_FRAGMENT, headers: {}, part: null, rangeStart: 0, rangeEnd: 0 };
    let done, fail;
    const result = new Promise((resolve, reject) => { done = resolve; fail = reject; });
    loader.load(context, {}, { onSuccess: response => done(new Uint8Array(response.data)), onError: fail, onTimeout: fail, onAbort: () => done(null) });
    return { loader, result };
  };
  const addPeer = async () => {
    const pool = new RelayPool([relay.url]); await pool.connect();
    const peer = new RelaySwarmSession({ pool, swarmId }); peer.start();
    t.after(() => { peer.close(); pool.close(); });
    await until(() => swarm.metrics().pubkey);
    peer.sendSignal(swarm.metrics().pubkey, { type: 'offer', transport: 'webrtc', requestId: 'warm-upload-fixture', payload: { sdp: 'fixture-sdp' } });
    await until(() => connections.length && swarm.metrics().peers.offersAccepted);
    const sent = [];
    class Channel extends EventTarget {
      readyState = 'open'; bufferedAmount = 0;
      send(data) { sent.push(typeof data === 'string' ? JSON.parse(data) : new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength).slice()); }
      close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
    }
    const channel = new Channel(), event = new Event('datachannel'); event.channel = channel;
    connections[0].dispatchEvent(event);
    await until(() => swarm.metrics().peers.connected === 1);
    return { sent, want(sn) { channel.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({ t: 'want', id: sn + 1, k: sha(`${swarmId}\n/media/s${sn}.m4s`) }),
    })); } };
  };
  return { requests, fragments, swarm, hls, media, load, bytes, state, addPeer };
}

test('warm ahead reuses one verified HTTP object locally without duplicate network or peer credit', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.load(0).result, f.bytes);
  await until(() => f.swarm.metrics().warmAhead?.verified >= 2);
  const before = f.swarm.metrics();
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  assert.deepEqual(await f.load(1).result, f.bytes);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1, 'same viewer reuses the exact future object');
  const after = f.swarm.metrics();
  assert.equal(after.warmAhead.localReuseBytes, f.bytes.length);
  assert.equal(after.bytes.peerFirst, before.bytes.peerFirst, 'local reuse adds no peer payload');
  assert(after.bytes.held >= f.bytes.length, 'verified cache also remains in the peer-serving held map');
  assert(after.warmAhead.cacheBytes <= after.bytes.held, 'warm cache is a subset of held bytes');
  assert(f.requests.every(row => row.context.type === LoaderContextType.MEDIA_FRAGMENT && row.context.headers), 'speculation preserves the real fragment-loader context kind');
});

test('whole-fragment contexts normalise real zero ranges while genuine byte ranges stay outside warm reuse', async t => {
  const f = await fixture(t);
  const context = { url: f.fragments[1].url, frag: f.fragments[1] };
  assert.equal(warmContext(context).key, warmContext({ ...context, rangeStart: 0, rangeEnd: 0 }).key);
  for (const range of [{ rangeStart: 0, rangeEnd: 4 }, { rangeStart: 4, rangeEnd: 8 }, { rangeStart: NaN }])
    assert.equal(warmContext({ ...context, ...range }), null);
});

test('a demanded in-flight warm object joins its existing load', async t => {
  const f = await fixture(t, { held: [1] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  await sleep(10);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  f.requests.find(row => row.context.frag.sn === 1).finish();
  assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.swarm.metrics().warmAhead.coalesced, 1);
});

test('promoting warmed work to genuine demand permits the next future load before the current one finishes', async t => {
  const f = await fixture(t, { held: [1, 2], size: 2048, maxHeldBytes: 4096 });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  assert.equal(f.requests.find(row => row.context.frag.sn === 1).completed, false);
  const m = f.swarm.metrics();
  assert.equal(m.warmAhead.promoted, 1); assert.equal(m.warmAhead.active, 1);
  assert.equal(m.warmAhead.reservationBytes, 2 * f.bytes.length);
  assert(m.warmAhead.trackedObjects <= 3);
  assert(m.bytes.held + m.warmAhead.reservationBytes <= 4096);
  f.requests.find(row => row.context.frag.sn === 1).finish();
  assert.deepEqual(await demand.result, f.bytes);
});

test('pause cancels promoted demand and the speculative successor, releasing their combined reservation', async t => {
  const f = await fixture(t, { held: [1, 2], size: 2048, maxHeldBytes: 4096 });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  demand.loader.abort();
  f.media.paused = true; f.media.dispatchEvent(new Event('pause'));
  assert(f.requests.filter(row => [1, 2].includes(row.context.frag.sn)).every(row => row.aborted));
  const m = f.swarm.metrics();
  assert.equal(m.warmAhead.promoted, 0); assert.equal(m.warmAhead.active, 0);
  assert.equal(m.warmAhead.reservationBytes, 0); assert.equal(m.warmAhead.trackedObjects, 0);
});

test('wrong committed content is rejected and never cached or advertised', async t => {
  const f = await fixture(t, { badHash: true });
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead?.rejected >= 2);
  const m = f.swarm.metrics();
  assert.equal(m.warmAhead.verified, 0); assert.equal(m.warmAhead.cacheBytes, 0);
  assert.equal(m.bytes.held, f.bytes.length, 'only ordinary demanded origin object can be held');
});

for (const invalidation of ['refuse', 'expired']) test(`cached bytes require the current host authority view: ${invalidation}`, async t => {
  const f = await fixture(t);
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead?.verified >= 2);
  f.state[invalidation] = true;
  assert.deepEqual(await f.load(1).result, f.bytes, 'normal origin path remains available');
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 2, 'old signed cache admission cannot bypass current refusal');
  assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, 0);
});

test('underflow starts ordinary source immediately while cache authority is unresponsive', async t => {
  const f = await fixture(t);
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  f.state.stall = true; f.media.buffered = { length: 0 };
  const demand = f.load(1);
  await sleep(0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 2, 'an explicit recovery request is visible');
  assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, 0);
});

test('buffered authority checks get at most 25 ms before independent source recovery', async t => {
  const f = await fixture(t);
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  f.state.stall = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const demand = f.load(1);
    for (let i = 0; i < 2000 && !f.state.blockedChecks; i++) await new Promise(setImmediate);
    assert(f.state.blockedChecks > 0);
    t.mock.timers.tick(24);
    assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
    t.mock.timers.tick(1);
    assert.deepEqual(await demand.result, f.bytes);
    assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 2);
    assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, 0);
  } finally { t.mock.timers.reset(); }
});

test('stopping during buffered cache revalidation starts source without waiting for the provider', async t => {
  const f = await fixture(t);
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  f.state.stall = true;
  f.state.onBlock = () => f.swarm.stop();
  const demand = f.load(1);
  assert.deepEqual(await demand.result, f.bytes);
  assert(f.state.blockedChecks > 0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 2);
});

test('a connected peer can request the verified future object before local demand consumes it', async t => {
  const f = await fixture(t);
  const peer = await f.addPeer();
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead?.verified >= 2);
  peer.want(1);
  await until(() => peer.sent.some(row => row.t === 'eof' && row.id === 2));
  assert.deepEqual(peer.sent.find(row => row instanceof Uint8Array), f.bytes);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, 0);
  assert.equal(f.swarm.metrics().bytes.uploaded, f.bytes.length);
});

test('exhausting the upload allowance also withdraws warm references and reservations', async t => {
  const f = await fixture(t, { allowance: 1024 });
  const peer = await f.addPeer();
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  peer.want(1);
  await until(() => f.swarm.metrics().bytes.uploadExhausted);
  const m = f.swarm.metrics();
  assert.equal(m.bytes.held, 0); assert.equal(m.warmAhead.cacheBytes, 0);
  assert.equal(m.warmAhead.reservationBytes, 0); assert.equal(m.warmAhead.active, 0);
});

test('pause and stop abort speculation and release verified warm references', async t => {
  const f = await fixture(t, { held: [1] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  f.media.paused = true; f.media.dispatchEvent(new Event('pause'));
  assert(f.requests.find(row => row.context.frag.sn === 1).aborted);
  assert.equal(f.swarm.metrics().warmAhead.active, 0); assert.equal(f.swarm.metrics().warmAhead.reservationBytes, 0);
  f.swarm.stop();
  assert.equal(f.swarm.metrics().warmAhead.cacheBytes, 0); assert.equal(f.swarm.metrics().bytes.held, 0);
});

test('a jump to another parsed position cancels unrelated speculative work', async t => {
  const f = await fixture(t, { held: [1] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  assert.deepEqual(await f.load(8).result, f.bytes);
  assert(f.requests.find(row => row.context.frag.sn === 1).aborted);
  await until(() => f.swarm.metrics().warmAhead.verified >= 1);
  assert(f.requests.some(row => row.context.frag.sn === 9));
});

test('leaving the swarm while a real demand joins warm work keeps ordinary origin playback available', async t => {
  const f = await fixture(t, { held: [1] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  f.swarm.stop();
  await until(() => f.requests.filter(row => row.context.frag.sn === 1).length === 2);
  f.requests.filter(row => row.context.frag.sn === 1).at(-1).finish();
  assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.swarm.metrics().warmAhead.active, 0);
});

test('reservation and shared held buffers respect the existing cache byte bound', async t => {
  const f = await fixture(t, { size: 2048, maxHeldBytes: 4096, maxHeldSegments: 2 });
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead?.verified >= 2);
  for (let sn = 1; sn < 7; sn++) {
    await f.load(sn).result;
    await sleep(15);
    const m = f.swarm.metrics();
    assert(m.bytes.held + m.warmAhead.reservationBytes <= 4096);
    assert(m.warmAhead.cacheBytes <= m.bytes.held);
    assert(m.warmAhead.cacheObjects <= 3); assert(m.warmAhead.active <= 1);
  }
});

test('default configuration starts no ahead requests and retains the original demand path', async t => {
  const f = await fixture(t, { enabled: false });
  assert.deepEqual(await f.load(0).result, f.bytes);
  await sleep(30);
  assert.equal(f.requests.length, 1); assert.equal(f.swarm.metrics().warmAhead, null);
});
