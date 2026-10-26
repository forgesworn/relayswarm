import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import Hls, { M3U8Parser, LoaderContextType } from 'hls.js';
import { warmContext } from '../src/browser/warm-ahead.mjs';
const { createWarmAhead, WARM_AHEAD: STARTUP_MARKER } = await import(process.env.TEST_STARTUP_WARM_MODULE ?? '../src/browser/warm-ahead.mjs');
import { commitmentContent, commitmentPieceSize, KIND_SEGMENT_COMMITMENT, verifySegmentCommitment } from '../src/browser/segment-commitment.mjs';
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
  const fixtureCore = coreWasm ?? (options.rangePeer ? await WebAssembly.compile(await readFile(new URL('../src/browser/relayswarm-core.wasm', import.meta.url))) : undefined);
  const bytes = Uint8Array.from({ length: options.size ?? 1024 }, (_, i) => i % 251);
  const requests = [], clients = new Set(), sk = generateSecretKey(), swarmId = 'warm-ahead-fixture';
  const streamEvent = finalizeEvent({ kind: 30311, created_at: Math.floor(Date.now() / 1000),
    tags: [['d', swarmId], ['relayswarm', 'redistribute', '1']], content: '' }, sk);
  // Use real hls.js 1.7.3 Fragment getters/base.url identity rather than a
  // convenient plain-object approximation of the application's parser.
  const playlist = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n' +
    Array.from({ length: 12 }, (_, sn) => `#EXTINF:2,\ns${sn}.m4s\n`).join('');
  const fragments = M3U8Parser.parseLevelPlaylist(playlist, 'https://origin.example/media/index.m3u8', 0, 'main', 0, null).fragments;
  const events = new Map();
  const state = { refuse: false, expired: false, stall: false, blockedChecks: 0, onBlock: null, admit: true };
  class Loader {
    stats = { loaded: 0, loading: { start: 0, first: 0, end: 0 } };
    load(context, config, callbacks) {
      this.context = context;
      const row = { context, config, callbacks, loader: this, aborted: false, completed: false, started: performance.now(), finish: (body = bytes) => {
        if (row.aborted) return;
        clearTimeout(row.parentTimer);
        row.completed = true;
        Object.assign(this.stats, { loaded: body.length, total: body.length, loading: { start: row.started, first: row.started, end: performance.now() } });
        callbacks.onSuccess({ url: context.url, data: body.slice().buffer, code: 200 }, this.stats, context, null);
      }, fail: error => {
        if (row.aborted || row.completed) return;
        clearTimeout(row.parentTimer); row.completed = true;
        callbacks.onError(error, context, null, this.stats);
      } };
      this.row = row; requests.push(row);
      if (options.parentDeadlineMs) row.parentTimer = setTimeout(() => {
        if (row.aborted || row.completed) return;
        row.completed = true; row.timedOut = true; this.stats.aborted = true;
        callbacks.onTimeout(this.stats, context, null);
      }, config.loadPolicy.maxLoadTimeMs);
      if (!options.held?.includes(context.frag.sn)) row.finish();
    }
    abort() { if (this.row && !this.row.completed && !this.row.aborted) { clearTimeout(this.row.parentTimer); this.row.aborted = true; this.stats.aborted = true; this.row.callbacks.onAbort?.(this.stats, this.context, null); } }
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
    await options.beforeCommitment?.(context);
    if (state.stall) { state.blockedChecks++; state.onBlock?.(); return new Promise(() => {}); }
    if (state.refuse) return null;
    const seconds = Math.floor(Date.now() / 1000), key = sha(`${swarmId}\n${new URL(context.url).pathname}`);
    const cacheKey = `${key}:${context.frag.sn}:${context.frag.cc}:${state.expired}`;
    if (events.has(cacheKey)) return events.get(cacheKey);
    const pieceSize = commitmentPieceSize(bytes.length), pieces = [];
    if (options.rangePeer) for (let at = 0; at < bytes.length; at += pieceSize) pieces.push(sha(bytes.subarray(at, at + pieceSize)));
    const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds, tags: [['x', swarmId], ['e', streamEvent.id]],
      content: commitmentContent({ v: options.rangePeer ? 3 : 2, streamEventId: streamEvent.id, swarmId, key, rendition: '/media/index.m3u8',
        playlist: '/media/index.m3u8', mediaType: 'main', encryption: null, sequence: context.frag.sn, discontinuity: context.frag.cc,
        part: null, sha256: options.badHash ? 'f'.repeat(64) : sha(bytes), size: bytes.length, expiresAt: seconds + (state.expired ? -1 : 120),
        ...(options.rangePeer ? { pieceSize, pieces } : {}) }) }, sk);
    events.set(cacheKey, event); return event;
  };
  const swarm = createHlsSwarm({ swarmId, mode: 'peer-first', serve: true, warmAhead: options.enabled ?? true,
    streamEvent, getCommitment, RTCPeerConnectionImpl: PC, relays: [relay.url], ...(fixtureCore ? { coreWasm: fixtureCore } : {}),
    ...(options.rangePeer ? { multiHolder: true, zeroBudgetPeerRace: true, sustainablePeerWait: true, latePeerRace: options.latePeerRace ?? true,
      lateHaveRace: options.lateHaveRace ?? false,
      maxPeerWaitMs: options.maxPeerWaitMs ?? 2500, lateWindowMs: 4000 } : {}),
    ...(options.maxRaces ? { maxConcurrentRaces: options.maxRaces } : {}),
    ...(options.gated ? { ticket: 'fixture-owner', admit: () => state.admit } : {}),
    maxHeldBytes: options.maxHeldBytes ?? 64 * 1024 * 1024, maxHeldSegments: options.maxHeldSegments ?? 12,
    ...(options.onPeerDelivery ? { onPeerDelivery: options.onPeerDelivery } : {}),
    ...(options.startupTarget === undefined ? {} : { startupBufferTarget: options.startupTarget }),
    ...(options.startupCommit === undefined ? {} : { startupBufferCommit: options.startupCommit }),
    ...(options.allowance === undefined ? {} : { maxUploadBytesPerSession: options.allowance }) });
  const hls = { config: { loader: Loader, progressive: false }, media, levels: [{ details: { live: true, fragments } }] };
  swarm.attach(hls);
  t.after(async () => { for (const loader of clients) loader.destroy(); swarm.stop(); await relay.close(); });
  if (fixtureCore && !swarm.metrics().disabledReason) await until(() => swarm.metrics().core?.state === 'ready');
  const load = (sn, existing, hooks = {}) => {
    const loader = existing ?? new hls.config.fLoader(hls.config), context = { url: fragments[sn].url, frag: fragments[sn], responseType: 'arraybuffer',
      type: LoaderContextType.MEDIA_FRAGMENT, headers: {}, part: null, rangeStart: 0, rangeEnd: 0 };
    clients.add(loader);
    loader.stats.retry = fragments[sn].stats.retry;
    fragments[sn].stats = loader.stats;
    let done, fail;
    const calls = { success: 0, abort: 0, error: 0, timeout: 0 };
    const terminals = [];
    const result = new Promise((resolve, reject) => { done = resolve; fail = reject; });
    const loadPolicy = { ...Hls.DefaultConfig.fragLoadPolicy.default,
      ...(options.parentDeadlineMs ? { maxLoadTimeMs: options.parentDeadlineMs } : {}), errorRetry: null, timeoutRetry: null };
    loader.load(context, { loadPolicy, timeout: loadPolicy.maxLoadTimeMs, maxRetry: 0, retryDelay: 0, maxRetryDelay: 0, highWaterMark: 64 * 1024 }, { onSuccess: (response, _stats, delivered) => {
      calls.success++; terminals.push({ type: 'success', sn: delivered.frag.sn }); hooks.onSuccess?.(loader); done(new Uint8Array(response.data));
    },
      onError: (error, failed) => { calls.error++; terminals.push({ type: 'error', sn: failed.frag.sn, code: error.code }); fail(error); },
      onTimeout: (error, timedOut) => { calls.timeout++; terminals.push({ type: 'timeout', sn: timedOut.frag.sn }); fail(error); },
      onAbort: (stats, aborted) => { calls.abort++; terminals.push({ type: 'abort', sn: aborted.frag.sn, aborted: stats.aborted }); done(null); } });
    return { loader, result, calls, terminals };
  };
  const addPeer = async () => {
    const pool = new RelayPool([relay.url]); await pool.connect();
    const peer = new RelaySwarmSession({ pool, swarmId }); peer.start();
    t.after(() => { peer.close(); pool.close(); });
    await until(() => swarm.metrics().pubkey);
    peer.sendSignal(swarm.metrics().pubkey, { type: 'offer', transport: 'webrtc', requestId: 'warm-upload-fixture', payload: { sdp: 'fixture-sdp', ...(options.gated ? { ticket: 'fixture-peer' } : {}) } });
    await until(() => connections.length && swarm.metrics().peers.offersAccepted);
    const sent = [];
    class Channel extends EventTarget {
      readyState = 'open'; bufferedAmount = 0;
      send(data) {
        const frame = typeof data === 'string' ? JSON.parse(data) : null;
        sent.push(frame ?? new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength).slice());
        if (options.rangePeer && !options.silentPeer && frame?.t === 'want') queueMicrotask(() => {
          if (this.readyState !== 'open') return;
          const size = commitmentPieceSize(bytes.length), from = frame.p ? frame.p[0] * size : 0,
            to = frame.p ? Math.min(bytes.length, frame.p[1] * size) : bytes.length, body = bytes.slice(from, to);
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'meta', id: frame.id, size: body.length, ...(frame.p ? { p: frame.p } : {}) }) }));
          for (let at = 0; at < body.length; at += 16 * 1024)
            this.dispatchEvent(new MessageEvent('message', { data: body.slice(at, at + 16 * 1024).buffer }));
          this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'eof', id: frame.id }) }));
        });
      }
      close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
    }
    const channel = new Channel(), event = new Event('datachannel'); event.channel = channel;
    connections[0].dispatchEvent(event);
    await until(() => swarm.metrics().peers.connected === 1);
    if (options.rangePeer) {
      peer.announcePresence({ role: 'viewer', open: true, transports: [{ type: 'webrtc', publicKey: peer.pubkey, obj: 2 }], ...(options.gated ? { ticket: 'fixture-peer' } : {}) });
      await until(() => swarm.metrics().peers.openPeersKnown === 1);
    }
    return { sent, channel, have(sn) { channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'have', keys: [sha(`${swarmId}\n/media/s${sn}.m4s`)] }) })); }, want(sn) { channel.dispatchEvent(new MessageEvent('message', {
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

test('latePeerRace joins a newly accepted exact-HAVE peer after genuine promotion and wins the same HTTP owner', async t => {
  const f = await fixture(t, { held: [1], rangePeer: true });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const original = f.requests.find(row => row.context.frag.sn === 1), demand = f.load(1);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  const peer = await f.addPeer(); peer.have(1);
  await until(() => f.swarm.metrics().latePeerRace?.won === 1);
  assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1, 'late adoption never creates another source GET');
  assert.equal(original.aborted, true); assert.equal(original.completed, false);
  assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
  assert.deepEqual(demand.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  assert.equal(peer.sent.filter(frame => frame?.t === 'want').length, 1);
});

test('latePeerRace cannot arm speculative work and an unrelated HAVE cannot consume its one opportunity', async t => {
  const f = await fixture(t, { held: [1], rangePeer: true, maxRaces: 1 });
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const peer = await f.addPeer(); peer.have(1); await sleep(10);
  assert.equal(f.swarm.metrics().latePeerRace.armed, 0);
  assert.equal(peer.sent.filter(frame => frame?.t === 'want').length, 0);
  peer.have(9);
  const demand = f.load(1); await sleep(10);
  assert.equal(f.swarm.metrics().latePeerRace.armed, 0);
  peer.have(1); await until(() => f.swarm.metrics().latePeerRace.won === 1);
  assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.swarm.metrics().latePeerRace.armed, 1);
  assert(f.swarm.metrics().latePeerRace.pending <= 1);
});

test('latePeerRace remains disabled by default while the original HTTP keeps its completion', async t => {
  const f = await fixture(t, { held: [1], rangePeer: true, latePeerRace: false });
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1), peer = await f.addPeer(); peer.have(1); await sleep(10);
  assert.equal(f.swarm.metrics().latePeerRace.enabled, false); assert.equal(f.swarm.metrics().latePeerRace.armed, 0);
  f.requests.find(row => row.context.frag.sn === 1).finish();
  assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  assert.equal(peer.sent.filter(frame => frame?.t === 'want').length, 0);
});

for (const refusal of ['refuse', 'expired', 'admit']) test(`latePeerRace checks current ${refusal} authority before requesting bytes`, async t => {
  const f = await fixture(t, { held: [1], rangePeer: true, gated: refusal === 'admit' });
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1), peer = await f.addPeer();
  f.state[refusal] = refusal === 'admit' ? false : true;
  peer.have(1); await until(() => f.swarm.metrics().latePeerRace.refused === 1);
  assert.equal(peer.sent.filter(frame => frame?.t === 'want').length, 0);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  const original = f.requests.find(row => row.context.frag.sn === 1);
  assert.equal(original.aborted, false);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  f.state[refusal] = refusal === 'admit' ? true : false;
  original.finish(); assert.deepEqual(await demand.result, f.bytes);
  assert.deepEqual(demand.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
});

test('latePeerRace expires at the earliest genuine entry even when the child HTTP starts later', async t => {
  let clock = 0, release, blocked = false;
  t.mock.method(performance, 'now', () => clock);
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { held: [1], rangePeer: true, beforeCommitment: ctx => {
    if (ctx.frag.sn === 1 && !blocked) { blocked = true; return gate; }
  } });
  await f.load(0).result; await until(() => blocked);
  const demand = f.load(1);
  clock = 3000; release(); await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const entered = f.swarm.metrics().latePeerRace.records.find(row => row.sequence === 1 && row.outcome === 'entered');
  assert.equal(entered.genuineAtMs, 0); assert.equal(entered.windowEndAtMs, 4000);
  clock = 4500;
  const peer = await f.addPeer(); peer.have(1); await until(() => f.swarm.metrics().latePeerRace.expired === 1);
  assert.equal(f.swarm.metrics().latePeerRace.armed, 0); assert.equal(peer.sent.filter(frame => frame?.t === 'want').length, 0);
  demand.loader.abort(); assert.equal(await demand.result, null);
  assert.equal(demand.calls.abort, 1); assert.equal(f.swarm.metrics().latePeerRace.pending, 0);
});

test('latePeerRace keeps the original parent HTTP deadline instead of granting a new four seconds', async t => {
  let clock = 0; t.mock.method(performance, 'now', () => clock);
  const f = await fixture(t, { held: [1], rangePeer: true, parentDeadlineMs: 1000 });
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  clock = 500; const demand = f.load(1);
  const entered = f.swarm.metrics().latePeerRace.records.find(row => row.sequence === 1 && row.outcome === 'entered');
  assert.equal(entered.genuineAtMs, 500); assert.equal(entered.windowEndAtMs, 1000);
  demand.loader.abort(); assert.equal(await demand.result, null);
  assert.equal(f.swarm.metrics().latePeerRace.pending, 0);
});

for (const ending of ['abort', 'pause', 'scope', 'origin']) test(`latePeerRace ${ending} retires waiting work without a stale callback`, async t => {
  const f = await fixture(t, { held: [1], rangePeer: true });
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1), original = f.requests.find(row => row.context.frag.sn === 1);
  if (ending === 'abort') { demand.loader.abort(); assert.equal(await demand.result, null); }
  else if (ending === 'pause') { f.media.paused = true; f.media.dispatchEvent(new Event('pause')); }
  else if (ending === 'scope') f.fragments[1].cc++;
  else { original.finish(); assert.deepEqual(await demand.result, f.bytes); }
  const peer = await f.addPeer(); peer.have(1); await sleep(10);
  assert.equal(f.swarm.metrics().latePeerRace.armed, 0);
  assert.equal(peer.sent.filter(frame => frame?.t === 'want').length, 0);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  if (ending === 'pause' || ending === 'scope') demand.loader.abort();
  assert.equal(f.swarm.metrics().latePeerRace.pending, 0);
  assert(demand.calls.success + demand.calls.abort <= 1);
});

test('latePeerRace never renews an already-created cached peer plan after its timeout', async t => {
  const f = await fixture(t, { held: [1], rangePeer: true, silentPeer: true, maxPeerWaitMs: 100 });
  const peer = await f.addPeer(); peer.have(1);
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  await until(() => peer.sent.some(frame => frame?.t === 'want'));
  await sleep(150); peer.have(1); await sleep(10);
  assert.equal(f.swarm.metrics().latePeerRace.armed, 0);
  assert.equal(peer.sent.filter(frame => frame?.t === 'want').length, 1);
  f.requests.find(row => row.context.frag.sn === 1).finish(); assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
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

test('an in-buffer seek retains wanted demand and speculation while an outside seek cancels speculation', async t => {
  const f = await fixture(t, { held: [1, 2] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  f.media.currentTime = 1.25; f.media.dispatchEvent(new Event('seeking'));
  assert(f.requests.filter(row => [1, 2].includes(row.context.frag.sn)).every(row => !row.aborted));
  f.requests.find(row => row.context.frag.sn === 1).finish();
  assert.deepEqual(await demand.result, f.bytes);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  f.media.currentTime = 25; f.media.dispatchEvent(new Event('seeking'));
  assert.equal(f.requests.find(row => row.context.frag.sn === 2).aborted, true);
  assert.equal(f.swarm.metrics().warmAhead.reservationBytes, 0);
});

for (const state of ['verified', 'in-flight']) test(`a forward seek into an exact ${state} warm fragment retains and reuses its original object`, async t => {
  const f = await fixture(t, { held: [1] });
  f.media.buffered = { length: 1, start: () => 0, end: () => 2 };
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const original = f.requests.find(row => row.context.frag.sn === 1);
  if (state === 'verified') { original.finish(); await until(() => f.swarm.metrics().warmAhead.verified >= 2); }
  assert.equal(f.fragments[1].start, 2); assert.equal(f.fragments[1].duration, 2);
  f.media.currentTime = 2.25; f.media.dispatchEvent(new Event('seeking'));
  assert.equal(original.aborted, false, 'a fresh initial alignment must retain the exact next object');
  const retained = f.swarm.metrics().warmAhead;
  if (state === 'verified') assert(retained.cacheBytes >= f.bytes.length);
  else assert.equal(retained.reservationBytes, f.bytes.length);
  // The target remains unbuffered. Ordinary source recovery must still race
  // current authorisation; the retained object can win without another body.
  const demand = f.load(1);
  if (state === 'in-flight') original.finish();
  assert.deepEqual(await demand.result, f.bytes);
  const requests = f.requests.filter(row => row.context.frag.sn === 1);
  assert.equal(requests.length, 2, 'the unbuffered recovery arm is visible');
  assert.equal(requests.filter(row => row.completed).length, 1, 'only the retained original body was downloaded');
  assert.equal(requests[1].aborted, true);
  assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, f.bytes.length);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
});

test('a completed genuine fragment retains its planned warm successor before the first append', async t => {
  const f = await fixture(t, { held: [1, 2], buffered: false });
  const first = f.load(0, undefined, { onSuccess: loader => loader.destroy() });
  assert.deepEqual(await first.result, f.bytes);
  assert.deepEqual(first.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const successor = f.requests.find(row => row.context.frag.sn === 1); successor.finish();
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  f.media.currentTime = 1.895; f.media.dispatchEvent(new Event('seeking'));
  assert.equal(f.swarm.metrics().warmAhead.cacheBytes, f.bytes.length);
  assert.equal(f.requests.find(row => row.context.frag.sn === 2).aborted, false);
  assert.deepEqual(await f.load(1).result, f.bytes);
  const bodies = f.requests.filter(row => row.context.frag.sn === 1);
  assert.equal(bodies.length, 2, 'empty-buffer source recovery remains visible');
  assert.equal(bodies.filter(row => row.completed).length, 1, 'the verified original is the only downloaded body');
  assert.equal(bodies[1].aborted, true);
  assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, f.bytes.length);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
});

for (const change of ['outside', 'invalid-start', 'invalid-duration', 'changed-next-key', 'changed-next-interval', 'invalid-demand', 'new-demand', 'clear', 'stop'])
  test(`latest genuine interval retention retires on ${change}`, async t => {
    const f = await fixture(t, { held: [1, 2, 9, 10], buffered: false });
    if (change === 'invalid-start') f.fragments[0].start = NaN;
    if (change === 'invalid-duration') f.fragments[0].duration = 0;
    await f.load(0).result;
    await until(() => f.requests.some(row => row.context.frag.sn === 1));
    f.requests.find(row => row.context.frag.sn === 1).finish();
    await until(() => f.requests.some(row => row.context.frag.sn === 2));
    if (change === 'changed-next-key') f.fragments[1].url = 'https://origin.example/media/replacement.m4s';
    if (change === 'changed-next-interval') f.fragments[1].start += 0.5;
    if (change === 'invalid-demand') { f.fragments[8].gap = true; await f.load(8).result; }
    if (change === 'new-demand') { await f.load(8).result; await until(() => f.requests.some(row => row.context.frag.sn === 9)); }
    if (change === 'clear') f.media.dispatchEvent(new Event('pause'));
    if (change === 'stop') f.swarm.stop();
    f.media.currentTime = change === 'outside' ? 1.895 + 10 : 1.895;
    f.media.dispatchEvent(new Event('seeking'));
    assert(f.requests.filter(row => !row.completed).every(row => row.aborted));
    const m = f.swarm.metrics().warmAhead;
    assert.equal(m.cacheBytes, 0); assert.equal(m.reservationBytes, 0); assert.equal(m.trackedObjects, 0);
  });

for (const outcome of ['abort', 'error']) test(`${outcome} of the current genuine load retires its unappended interval`, async t => {
  const f = await fixture(t, { held: [0, 1, 2], buffered: false });
  const current = f.load(0), result = current.result.then(value => ({ value }), error => ({ error }));
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  f.requests.find(row => row.context.frag.sn === 1).finish();
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  if (outcome === 'abort') { current.loader.abort(); assert.equal((await result).value, null); }
  else { f.requests.find(row => row.context.frag.sn === 0).fail({ code: 503 }); assert.equal((await result).error.code, 503); }
  f.media.currentTime = 1.895; f.media.dispatchEvent(new Event('seeking'));
  assert.equal(f.swarm.metrics().warmAhead.cacheBytes, 0);
  assert.equal(f.requests.find(row => row.context.frag.sn === 2).aborted, true);
});

for (const invalid of ['outside', 'end-boundary', 'out-of-scope', 'invalid-start', 'invalid-duration', 'invalid-end', 'invalid-target'])
  test(`a seek with ${invalid} warm metadata still clears unrelated speculative work`, async t => {
    const f = await fixture(t, { held: [1, 2] });
    f.media.buffered = { length: 1, start: () => 0, end: () => 2 };
    if (invalid === 'out-of-scope') f.fragments[1].level = 1;
    if (invalid === 'invalid-start') f.fragments[1].start = NaN;
    if (invalid === 'invalid-duration') f.fragments[1].duration = 0;
    if (invalid === 'invalid-end') { f.fragments[1].start = Number.MAX_VALUE; f.fragments[1].duration = Number.MAX_VALUE; }
    await f.load(0).result;
    await until(() => f.requests.some(row => row.context.frag.sn > 0));
    f.media.currentTime = invalid === 'outside' ? 25 : invalid === 'end-boundary' ? 4 : invalid === 'invalid-target' ? NaN : 2.25;
    f.media.dispatchEvent(new Event('seeking'));
    assert(f.requests.filter(row => row.context.frag.sn > 0).every(row => row.aborted));
    const m = f.swarm.metrics().warmAhead;
    assert.equal(m.cacheBytes, 0); assert.equal(m.reservationBytes, 0); assert.equal(m.trackedObjects, 0);
  });

test('a promoted request retains its original parent deadline and timeout result', async t => {
  const f = await fixture(t, { held: [1, 2], parentDeadlineMs: 12_000 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await f.load(0).result;
    for (let i = 0; i < 2000 && !f.requests.some(row => row.context.frag.sn === 1); i++) await new Promise(setImmediate);
    const row = f.requests.find(row => row.context.frag.sn === 1); assert(row);
    t.mock.timers.tick(6000);
    const demand = f.load(1), outcome = demand.result.then(value => ({ value }), error => ({ error }));
    t.mock.timers.tick(2000);
    await new Promise(setImmediate);
    assert.equal(row.aborted, false, 'promotion removes the speculative eight-second cap');
    assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
    t.mock.timers.tick(4000);
    await new Promise(setImmediate);
    assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1, 'the parent timeout is not a hidden fresh GET');
    assert.equal(demand.calls.timeout, 1);
    assert.equal((await outcome).error.aborted, true);
    assert.equal(f.fragments[1].stats, demand.loader.stats);
    assert.deepEqual(demand.terminals, [{ type: 'timeout', sn: 1 }]);
  } finally { t.mock.timers.reset(); }
});

test('a promoted parent error settles the original demand without an implicit retry', async t => {
  const f = await fixture(t, { held: [1] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1), outcome = demand.result.then(value => ({ value }), error => ({ error }));
  f.requests.find(row => row.context.frag.sn === 1).fail({ code: 503, text: 'Fixture parent refusal' });
  await new Promise(setImmediate);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  assert.equal((await outcome).error.code, 503);
  assert.deepEqual(demand.terminals, [{ type: 'error', sn: 1, code: 503 }]);
});

test('a stale completion cannot cancel a newer promoted demand on the same loader instance', async t => {
  const f = await fixture(t, { held: [1, 2, 3] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const first = f.load(1);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  const second = f.load(2, first.loader);
  assert.equal(await first.result, null);
  assert.equal(first.calls.abort, 1);
  assert.deepEqual(first.terminals, [{ type: 'abort', sn: 1, aborted: true }]);
  await new Promise(setImmediate);
  const row = f.requests.find(row => row.context.frag.sn === 2);
  assert.equal(row.aborted, false, 'old generation must not release the newer pending record');
  assert.equal(f.requests.filter(row => row.context.frag.sn === 2).length, 1);
  assert.equal(f.swarm.metrics().warmAhead.promoted, 1);
  row.finish();
  assert.deepEqual(await second.result, f.bytes);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 2).length, 1);
});

test('pause cancels promoted demand and the speculative successor, releasing their combined reservation', async t => {
  const f = await fixture(t, { held: [1, 2], size: 2048, maxHeldBytes: 4096 });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  demand.loader.abort();
  assert.equal(await demand.result, null);
  assert.equal(demand.calls.abort, 1);
  f.media.paused = true; f.media.dispatchEvent(new Event('pause'));
  assert(f.requests.filter(row => [1, 2].includes(row.context.frag.sn)).every(row => row.aborted));
  const m = f.swarm.metrics();
  assert.equal(m.warmAhead.promoted, 0); assert.equal(m.warmAhead.active, 0);
  assert.equal(m.warmAhead.reservationBytes, 0); assert.equal(m.warmAhead.trackedObjects, 0);
});

test('an explicit abort settles a coalesced demand once and fences late data', { timeout: 1000 }, async t => {
  const f = await fixture(t, { held: [1] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const demand = f.load(1);
  demand.loader.abort();
  assert.equal(await demand.result, null);
  assert.equal(demand.calls.abort, 1);
  demand.loader.abort(); demand.loader.destroy();
  f.requests.find(row => row.context.frag.sn === 1).finish();
  await new Promise(setImmediate);
  assert.deepEqual(demand.calls, { success: 0, abort: 1, error: 0, timeout: 0 });
});

test('an explicit abort settles cached authority revalidation without waiting for its provider', async t => {
  const f = await fixture(t);
  await f.load(0).result;
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  f.state.stall = true;
  let demand;
  f.state.onBlock = () => demand.loader.abort();
  demand = f.load(1);
  assert.equal(await demand.result, null);
  assert.deepEqual(demand.calls, { success: 0, abort: 1, error: 0, timeout: 0 });
  demand.loader.destroy(); demand.loader.abort();
  assert.equal(demand.calls.abort, 1);
});

test('ordinary origin abort and successful normal/cache destruction retain one terminal callback', async t => {
  const pending = await fixture(t, { held: [0] });
  const demand = pending.load(0);
  demand.loader.abort();
  assert.equal(await demand.result, null);
  demand.loader.destroy(); demand.loader.abort();
  assert.deepEqual(demand.calls, { success: 0, abort: 1, error: 0, timeout: 0 });

  const f = await fixture(t);
  const onSuccess = loader => { loader.destroy(); loader.abort(); };
  const normal = f.load(0, undefined, { onSuccess });
  assert.deepEqual(await normal.result, f.bytes);
  normal.loader.destroy(); normal.loader.abort();
  assert.deepEqual(normal.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  const cached = f.load(1, undefined, { onSuccess });
  assert.deepEqual(await cached.result, f.bytes);
  cached.loader.destroy(); cached.loader.abort();
  assert.deepEqual(cached.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
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

// Encoded-loader state only: no browser, player, network or media clock is
// simulated as playback evidence. Real-media qualification remains separate.
function startupFixture(t, options = {}) {
  const bytes = Uint8Array.of(2, 4, 6, 8), requests = [], retained = [], verified = [];
  const state = { target: 1.3, recovery: 2_000, targetCalls: 0, accepted: 0, allowed: true, authCalls: 0,
    holdRecheck: false, holdCheckSn: null, releaseRecheck: null, reservations: [], revoked: new Set() };
  const context = sn => ({ url: `https://origin.example/media/s${sn}.m4s`, responseType: 'arraybuffer',
    frag: { sn, cc: 0, level: 0, type: 'main', start: options.starts?.[sn] ?? sn * 2, duration: 2,
      url: `https://origin.example/media/s${sn}.m4s`, baseurl: 'https://origin.example/media/index.m3u8' } });
  class Loader {
    stats = { loading: { start: 0 }, loaded: 0 };
    load(ctx, _policy, callbacks) {
      const row = { context: ctx, callbacks, aborted: false, stats: this.stats,
        finish: (force = false, body = bytes) => {
          if (row.aborted && !force) return;
          row.response = { data: body.slice().buffer, url: ctx.url, code: 200 };
          this.stats.loaded = body.length;
          callbacks.onSuccess(row.response, this.stats, ctx, null);
        } };
      this.row = row; requests.push(row);
    }
    abort() { if (this.row && !this.row.aborted) { this.row.aborted = true; this.stats.aborted = true; this.row.callbacks.onAbort?.(this.stats, this.row.context, null); } }
    destroy() { this.abort(); }
  }
  const engine = createWarmAhead({ Loader, steady: options.steady ?? false,
    startupTarget: options.startup === false ? null : () => { state.targetCalls++; return state.target; }, startupCommit: options.commit,
    startupRecovery: () => state.recovery,
    allowed: () => state.allowed, next: ctx => {
      options.onNext?.(ctx);
      return [context(ctx.frag.sn + 1), context(ctx.frag.sn + 2)];
    },
    authorise: async ctx => {
      state.authCalls++;
      const permit = options.permit ? options.permit(ctx) : {
        key: ctx.url, size: options.permitSize?.(ctx.frag.sn) ?? bytes.length,
        sha256: sha(bytes), current: () => !state.revoked.has(ctx.frag.sn),
      };
      if (state.holdRecheck && state.authCalls >= 3 && (state.holdCheckSn === null || state.holdCheckSn === ctx.frag.sn)) {
        state.holdRecheck = false; await new Promise(resolve => { state.releaseRecheck = resolve; });
      }
      return permit;
    },
    reserve: size => { state.reservations.push(size); return options.reserve?.(size) ?? true; },
    verify: async (permit, data, context) => {
      verified.push(data); if (options.beforeVerify) await options.beforeVerify(context);
      return permit.sha256 === sha(new Uint8Array(data));
    },
    onVerified: (_permit, data) => { retained.push(data); return true; },
    onReuse: options.onReuse,
  });
  const load = (sn = 0, parentMs = 1_000) => {
    const loader = new engine.Loader({ progressive: options.progressive ?? false }), ctx = context(sn), calls = { success: 0, error: 0, abort: 0, progress: 0 };
    ctx.frag.stats = loader.stats;
    loader.load(ctx, { loadPolicy: { maxLoadTimeMs: parentMs } }, {
      onSuccess: (...args) => { calls.success++; calls.args = args; options.onSuccess?.(...args); },
      onError: (...args) => { calls.error++; calls.args = args; },
      onAbort: (...args) => { calls.abort++; calls.args = args; },
      onProgress: (...args) => { calls.progress++; calls.progressArgs = args; },
    });
    return { loader, context: ctx, calls };
  };
  t.after(() => { state.releaseRecheck?.(); engine.stop(); });
  return { engine, state, requests, retained, verified, load };
}
const flushStartup = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('rolling startup replaces only an obsolete future while retaining the exact first terminal', async t => {
  // Encoded-state replay of the M4 cause capture: all three objects verified,
  // target3.885 in [2,6], but only2115ms ahead for2762.5ms recovery. Advancing
  // beyond4 must free the old [2,4] slot, rather than wait idle until deadline.
  const f = startupFixture(t), first = f.load();
  f.state.target = 3.885; f.state.recovery = 2762.5;
  first.context[STARTUP_MARKER].peerBytes = 4;
  first.context[STARTUP_MARKER].accept = () => { f.state.accepted++; };
  for (let i = 0; i < 3; i++) { f.requests[i].finish(); await flushStartup(); }
  assert.equal(first.calls.success, 0);
  assert.equal(f.engine.startupSnapshot().verifiedStart, 2);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 6);
  assert.equal(f.engine.startupSnapshot().heldObjects, 3);
  assert.equal(f.engine.snapshot().active, 0);
  f.state.target = 4.085;
  await sleep(125);
  assert.equal(f.requests.length, 4, 'the owned startup clock must refill the obsolete future slot');
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2, 3]);
  assert.equal(f.engine.startupSnapshot().heldObjects, 3);
  assert.equal(f.engine.snapshot().cacheObjects, 1);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
  assert.equal(f.state.accepted, 0);
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[0].data, f.requests[0].response.data);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert.equal(f.state.accepted, 1);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 4);
  assert.equal(f.engine.startupSnapshot().verifiedStart, 4);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 8);
  assert.equal(f.engine.startupSnapshot().limits.objects, 3);
  assert.equal(f.engine.startupSnapshot().limits.bytes, 24 * 1024 * 1024);
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 8000);
  const reads = f.state.targetCalls;
  await sleep(125);
  assert.equal(f.state.targetCalls, reads, 'no startup clock remains after release');
  assert.equal(f.requests.length, 4, 'steady warming is still disabled');
});

test('rolling startup advances from its bounded cursor when both old futures are obsolete', async t => {
  const f = startupFixture(t), first = f.load();
  f.state.target = 3.885; f.state.recovery = 2762.5;
  for (let i = 0; i < 3; i++) { f.requests[i].finish(); await flushStartup(); }
  f.state.target = 6.1;
  await sleep(125);
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[3].context.frag.sn, 3, 'continue after the last obsolete parsed future');
  assert.ok(f.engine.startupSnapshot().heldObjects <= 3);
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 0);
  assert.equal(f.requests[4].context.frag.sn, 4);
  assert.ok(f.engine.startupSnapshot().heldObjects <= 3);
  f.requests[4].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2, 3, 4]);
});

test('rolling startup metadata snapshots cannot retain runtime markers or response back-references', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [], f = startupFixture(t, { onNext: ctx => {
    if (ctx.frag.sn > 0) seen.push({ sn: ctx.frag.sn, symbols: Object.getOwnPropertySymbols(ctx).length,
      hasBackReference: Object.hasOwn(ctx, 'fixtureResponseBackReference') });
  } }), first = f.load(0, 8000);
  f.state.target = 3.885; f.state.recovery = 2762.5;
  for (let i = 0; i < 3; i++) {
    // The real WARM marker closes over a job whose resolved promise contains
    // the whole response. A second nonmetadata reference catches shallow-copy
    // variants that merely remove the known symbol.
    f.requests[i].context.fixtureResponseBackReference = f.requests[i];
    f.requests[i].finish(); await flushStartup();
  }
  f.state.target = 6.1;
  t.mock.timers.tick(100); await flushStartup();
  f.requests[3].context.fixtureResponseBackReference = f.requests[3];
  f.requests[3].finish(); await flushStartup(); f.requests[4].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.equal(f.engine.contains(0), true, 'post-release retention uses only the bounded metadata plan');
  assert.ok(seen.some(row => row.sn === 2));
  assert.ok(seen.some(row => row.sn === 3));
  assert.ok(seen.every(row => row.symbols === 0 && !row.hasBackReference),
    'parent, cursor and latest-demand metadata must not retain any runtime context marker or back-reference');
});

test('rolling startup initial-window snapshots never alias queued runtime contexts', async t => {
  const f = startupFixture(t, { startup: false, steady: true }), first = f.load();
  f.requests[0].finish(); await flushStartup();
  f.requests[1].finish(); await flushStartup(); f.requests[2].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  f.engine.release(f.requests[1].context.url);
  assert.equal(f.engine.snapshot().cacheObjects, 1);
  f.requests[1].context.frag.start += 0.25;
  assert.equal(f.engine.contains(0), true, 'initial latest-demand snapshots are independent of an evicted runtime row');
});

test('rolling startup retains an obsolete verification job reservation until its response settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  t.after(() => release?.());
  const f = startupFixture(t, { beforeVerify: ctx => ctx.frag.sn === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  const first = f.load(0, 8000);
  f.state.target = 3.885; f.state.recovery = 2762.5;
  f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
  assert.equal(typeof release, 'function');
  f.state.target = 4.085;
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[1].aborted, false, 'a verifier still owns the completed response body');
  assert.equal(f.requests.length, 2, 'no replacement may borrow that still-live reservation');
  assert.equal(f.engine.snapshot().reservationBytes, 8);
  assert.equal(f.engine.startupSnapshot().heldObjects, 2);
  release(); await flushStartup();
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[2].context.frag.sn, 2);
  f.requests[2].finish(); await flushStartup();
  assert.equal(f.requests[3].context.frag.sn, 3);
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.ok(f.state.reservations.every(size => size <= 24 * 1024 * 1024));
});

test('rolling startup retains the original deadline and rejects retry or late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t), first = f.load(0, 350);
  f.state.target = 3.885; f.state.recovery = 2762.5;
  for (let i = 0; i < 3; i++) { f.requests[i].finish(); await flushStartup(); }
  f.state.target = 4.085;
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[3].context.frag.sn, 3);
  t.mock.timers.tick(249); await flushStartup();
  assert.equal(first.calls.error, 0);
  t.mock.timers.tick(1); await flushStartup();
  assert.equal(first.calls.error, 1);
  assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
  assert.equal(f.requests[3].aborted, true);
  f.requests[3].finish(true); await flushStartup();
  const retry = f.load();
  assert.equal(retry.calls.error, 1);
  assert.equal(f.requests.length, 4);
  assert.equal(first.calls.success, 0);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
});

test('rolling startup clock is bounded and never downloads a fully obsolete metadata horizon', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t), first = f.load(0, 8000);
  f.state.target = 3.885; f.state.recovery = 2762.5;
  for (let i = 0; i < 3; i++) { f.requests[i].finish(); await flushStartup(); }
  const reads = f.state.targetCalls;
  f.state.target = 1000;
  t.mock.timers.tick(7900); await flushStartup();
  assert.ok(f.state.targetCalls - reads <= 80, 'at most one target read per100ms pending-startup poll');
  assert.equal(f.requests.length, 3, 'cursor-only obsolete hops do not fetch old source data');
  assert.equal(f.engine.startupSnapshot().heldObjects, 1, 'only the original first response remains');
  assert.equal(f.engine.snapshot().queued, 0);
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(first.calls.error, 1);
  assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
  const stoppedReads = f.state.targetCalls;
  t.mock.timers.tick(1000); await flushStartup();
  assert.equal(f.state.targetCalls, stoppedReads);
});

test('rolling startup cancellation retires its clock and cannot release late bytes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['abort', 'destroy', 'clear', 'stop', 'pause', 'null-target', 'context']) {
    const f = startupFixture(t), first = f.load(0, 8000);
    f.state.target = 3.885; f.state.recovery = 2762.5;
    for (let i = 0; i < 3; i++) { f.requests[i].finish(); await flushStartup(); }
    f.state.target = 4.085;
    t.mock.timers.tick(100); await flushStartup();
    assert.equal(f.requests[3].context.frag.sn, 3);
    if (action === 'abort') first.loader.abort();
    if (action === 'destroy') first.loader.destroy();
    if (action === 'clear') f.engine.clear();
    if (action === 'stop') f.engine.stop();
    if (action === 'pause') f.state.allowed = false;
    if (action === 'null-target') f.state.target = null;
    if (action === 'context') first.context.frag.start += 0.1;
    t.mock.timers.tick(100); await flushStartup();
    assert.equal(f.engine.startupSnapshot().state, 'cancelled', action);
    const reads = f.state.targetCalls;
    f.requests[3].finish(true); t.mock.timers.tick(500); await flushStartup();
    assert.equal(f.state.targetCalls, reads, action);
    assert.equal(first.calls.success, 0, action);
    assert.equal(first.calls.error, 0, action);
    assert.equal(f.engine.snapshot().reservationBytes, 0, action);
    assert.equal(f.engine.snapshot().active, 0, action);
    assert.equal(f.engine.snapshot().consumedPeerBytes, 0, action);
  }
});

test('rolling startup pins coverage across commit without polling the publishing target', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release, commits = 0;
  const f = startupFixture(t, { commit: () => { commits++; return new Promise(resolve => { release = resolve; }); } });
  const first = f.load(0, 8000);
  f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
  assert.equal(commits, 1);
  assert.equal(f.engine.pinned(f.requests[1].context.url), true);
  const reads = f.state.targetCalls;
  f.state.target = null; t.mock.timers.tick(500); await flushStartup();
  assert.equal(f.state.targetCalls, reads, 'publishing has no active room target until its ACK');
  assert.equal(f.engine.pinned(f.requests[1].context.url), true);
  assert.equal(first.calls.success, 0);
  assert.equal(f.requests.length, 2);
  f.state.target = 4.085; release(); await flushStartup();
  assert.equal(f.engine.pinned(f.requests[1].context.url), false);
  assert.equal(f.requests[2].context.frag.sn, 2);
  t.mock.timers.tick(100); await flushStartup();
  f.requests[2].finish(); await flushStartup();
  assert.equal(f.requests[3].context.frag.sn, 3);
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.equal(commits, 1);
  assert.equal(f.engine.startupSnapshot().commitCompleted, true);
});

test('rolling startup rechecks new parsed geometry and signed authority after verification yields', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['geometry', 'authority']) {
    const starts = [0, 2, 4, 6], f = startupFixture(t, { starts }), first = f.load(0, 8000);
    f.state.target = 3.885; f.state.recovery = 2762.5;
    for (let i = 0; i < 3; i++) { f.requests[i].finish(); await flushStartup(); }
    f.state.target = 4.085;
    t.mock.timers.tick(100); await flushStartup();
    f.state.holdRecheck = true; f.state.holdCheckSn = 3;
    f.requests[3].finish(); await flushStartup();
    assert.equal(typeof f.state.releaseRecheck, 'function');
    assert.equal(f.engine.pinned(f.requests[3].context.url), true);
    if (action === 'geometry') starts[3] += 0.25;
    else f.state.revoked.add(3);
    f.state.releaseRecheck(); await flushStartup();
    assert.equal(f.engine.startupSnapshot().state, action === 'geometry' ? 'cancelled' : 'failed', action);
    assert.equal(first.calls.success, 0, action);
    assert.equal(f.engine.snapshot().consumedPeerBytes, 0, action);
    assert.equal(f.engine.pinned(f.requests[3].context.url), false, action);
  }
});

test('rolling startup does not evict still-needed verified bytes for an oversized next reservation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t, { permitSize: sn => sn === 2 ? 24 * 1024 * 1024 - 4 : 4 }), first = f.load(0, 8000);
  f.state.target = 3.885; f.state.recovery = 2762.5;
  f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
  assert.equal(f.requests.length, 2, 'the new object does not fit beside first and current future');
  assert.equal(f.engine.snapshot().rejected, 1);
  assert.equal(f.engine.snapshot().cacheObjects, 1, 'required [2,4] stays resident');
  assert.equal(f.engine.startupSnapshot().heldObjects, 2);
  assert.equal(first.calls.success, 0);
  assert.ok(f.state.reservations.every(size => size <= 24 * 1024 * 1024));
});

test('rolling startup real SDK uses currently parsed future fragments without early Hls credit', async t => {
  let target = 3.885;
  const f = await fixture(t, { enabled: false, startupTarget: () => target, held: [0, 1, 2, 3] });
  const first = f.load(0);
  for (let sn = 0; sn < 3; sn++) {
    await until(() => f.requests.some(row => row.context.frag.sn === sn));
    if (sn === 2) target = 4.085;
    f.requests.find(row => row.context.frag.sn === sn).finish();
  }
  await until(() => f.requests.some(row => row.context.frag.sn === 3));
  const held = f.swarm.metrics();
  assert.equal(first.calls.success, 0);
  assert.equal(held.bytes.peerFirst, 0);
  assert.equal(held.bytes.fromOrigin, 3 * f.bytes.length, 'actual downloaded source bodies remain reported while Hls is held');
  assert.ok(held.startupBuffer.heldObjects <= 3);
  const future = f.requests.find(row => row.context.frag.sn === 3);
  assert.equal(future.context.frag.start, 6);
  assert.equal(future.context.frag.duration, 2);
  f.media.currentTime = 0; f.media.dispatchEvent(new Event('seeking'));
  assert.equal(f.swarm.metrics().startupBuffer.state, 'buffering', 'a real SDK seeking observer recognises its original genuine first context');
  assert.equal(first.calls.abort, 0);
  assert.equal(future.aborted, false, 'rolling beyond the initial next-two map does not retire valid work');
  future.finish();
  assert.deepEqual(await first.result, f.bytes);
  assert.equal(first.calls.success, 1);
  assert.equal(f.swarm.metrics().startupBuffer.state, 'ready');
  assert.equal(f.swarm.metrics().bytes.fromOrigin, 4 * f.bytes.length);
  f.media.dispatchEvent(new Event('seeking'));
  assert.equal(f.swarm.metrics().warmAhead.cacheObjects, 2, 'the same parsed rolling window survives a pre-frame first-position seek');
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2, 3]);
  f.media.currentTime = 100; f.media.dispatchEvent(new Event('seeking'));
  assert.equal(f.swarm.metrics().warmAhead.cacheObjects, 0, 'a seek outside that genuine bounded scope still retires the cache');
});

test('startup buffer holds the first callback for verified headroom, then releases the exact objects once', async t => {
  const f = startupFixture(t), first = f.load();
  assert.equal(f.requests.length, 1, 'normal HTTP starts before asynchronous authorisation');
  assert.equal(f.state.authCalls, 0);
  first.context[STARTUP_MARKER] && (first.context[STARTUP_MARKER].accept = () => { f.state.accepted++; });
  first.context[STARTUP_MARKER].peerBytes = 4;
  f.requests[0].finish(); await flushStartup();
  assert.equal(first.calls.success, 0, 'first encoded object alone cannot cover target1.3 plus2s recovery');
  assert.equal(f.state.accepted, 0, 'a held peer body is not consumed-player contribution');
  assert.equal(f.engine.snapshot().verified, 1);
  assert.equal(f.engine.snapshot().verifiedBytes, 4);
  assert.equal(f.engine.snapshot().verifiedPeerBytes, 4);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
  assert.equal(f.requests.length, 2);
  assert.equal(f.engine.startupSnapshot().heldObjects, 2, 'first held body occupies the same bounded reservoir');
  f.requests[1].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[0].data, f.requests[0].response.data);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert.equal(f.state.accepted, 1);
  assert.equal(f.engine.snapshot().verified, 2);
  assert.equal(f.engine.snapshot().verifiedBytes, 8);
  assert.equal(f.engine.snapshot().verifiedPeerBytes, 4);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 4);
  assert.ok(!f.retained.includes(f.requests[0].response.data), 'first body transfers to Hls, never retained as a detached SDK seed');
  assert.ok(f.verified.includes(f.requests[0].response.data));
  assert.equal(f.engine.startupSnapshot().state, 'ready');
  assert.equal(f.engine.startupSnapshot().heldBytes, 0);
  assert.equal(f.requests.length, 2, 'steady warming stays off after release');
  const reads = f.state.targetCalls; f.state.target = null;
  const second = f.load(1); await flushStartup();
  assert.equal(second.calls.success, 1);
  assert.equal(f.state.targetCalls, reads, 'the startup callback is never read after release/first frame');
  assert.equal(f.state.accepted, 1);
  assert.ok(f.requests.every(row => row.context.frag.sn < 2));
});

test('startup buffer rechecks a moving target after authority yields instead of releasing stale headroom', async t => {
  const f = startupFixture(t), first = f.load();
  f.requests[0].finish(); await flushStartup();
  f.state.holdRecheck = true; f.requests[1].finish(); await flushStartup();
  assert.equal(typeof f.state.releaseRecheck, 'function');
  f.state.target = 3.8; f.state.releaseRecheck(); await flushStartup();
  assert.equal(first.calls.success, 0);
  assert.equal(f.requests.length, 3);
  f.requests[2].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 6);
  assert.equal(f.engine.startupSnapshot().targetTime, 3.8);
});

test('startup buffer deadline fails once and cannot renew through a retry loader', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t), first = f.load(0, 25);
  f.requests[0].finish(); await flushStartup();
  assert.equal(first.calls.success, 0);
  t.mock.timers.tick(25); await flushStartup();
  assert.equal(first.calls.error, 1);
  assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
  assert.equal(f.engine.startupSnapshot().state, 'failed');
  const count = f.requests.length, retry = f.load();
  assert.equal(retry.calls.error, 1); assert.equal(f.requests.length, count);
  f.requests[1].finish(true); await flushStartup();
  assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 1);
});

test('startup buffer null target cancels held work without a late success or error', async t => {
  const f = startupFixture(t), first = f.load();
  f.requests[0].finish(); await flushStartup();
  f.state.target = null; f.requests[1].finish(); await flushStartup();
  assert.equal(first.calls.abort, 1); assert.equal(first.calls.error, 0); assert.equal(first.calls.success, 0);
  assert.equal(f.engine.startupSnapshot().state, 'cancelled');
  assert.equal(f.engine.startupSnapshot().heldBytes, 0);
});

test('startup buffer explicit abort, quiet destroy and engine stop fence late loader callbacks', async t => {
  for (const action of ['abort', 'destroy', 'stop']) {
    const f = startupFixture(t), first = f.load();
    first.context[STARTUP_MARKER].peerBytes = 4;
    f.requests[0].finish(); await flushStartup();
    assert.equal(f.engine.snapshot().verifiedPeerBytes, 4, action);
    assert.equal(f.engine.snapshot().consumedPeerBytes, 0, action);
    if (action === 'stop') f.engine.stop(); else first.loader[action]();
    const before = { ...first.calls };
    for (const row of f.requests) {
      row.finish(true);
      row.callbacks.onProgress?.({ loaded: 1 }, row.context, Uint8Array.of(2).buffer);
      row.callbacks.onProgress?.({ loaded: 1 }, row.context);
    }
    await flushStartup();
    assert.equal(first.calls.success, 0, action); assert.equal(first.calls.error, 0, action);
    assert.equal(first.calls.abort, action === 'abort' ? 1 : 0, action);
    assert.deepEqual(first.calls, before, action);
    assert.equal(f.engine.snapshot().verifiedPeerBytes, 4, action);
    assert.equal(f.engine.snapshot().consumedPeerBytes, 0, action);
    assert.equal(f.engine.startupSnapshot().heldBytes, 0, action);
  }
});

test('startup buffer reservations include first input and reject a future object beyond the shared cap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t, { permitSize: sn => (sn === 0 ? 16 : 12) * 1024 * 1024 }), first = f.load(0, 25);
  await flushStartup();
  assert.equal(f.requests.length, 1, 'future12MiB cannot fit beside the reserved first16MiB');
  assert.equal(f.engine.startupSnapshot().heldBytes, 16 * 1024 * 1024);
  assert.ok(f.engine.snapshot().trackedObjects <= 3);
  assert.ok(f.engine.snapshot().reservationBytes <= 24 * 1024 * 1024);
  t.mock.timers.tick(25); await flushStartup();
  assert.equal(first.calls.error, 1);
});

test('startup buffer rejects oversized first progress before retaining a response', async t => {
  const f = startupFixture(t), first = f.load(); await flushStartup();
  f.requests[0].callbacks.onProgress({ loaded: 5 });
  assert.equal(first.calls.error, 1);
  assert.equal(first.calls.args[0].startupBufferReason, 'first-oversize');
  f.requests[0].finish(true); await flushStartup(); assert.equal(first.calls.success, 0);
});

test('startup buffer rejects a corrupt first body without accepting peer contribution', async t => {
  const f = startupFixture(t), first = f.load();
  first.context[STARTUP_MARKER].accept = () => { f.state.accepted++; };
  f.requests[0].finish(false, Uint8Array.of(3, 4, 6, 8));
  await flushStartup();
  assert.equal(first.calls.error, 1); assert.equal(first.calls.success, 0); assert.equal(f.state.accepted, 0);
  assert.equal(first.calls.args[0].startupBufferReason, 'first-integrity');
});

test('startup buffer cannot count future cached bytes across a timeline gap as headroom', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t, { starts: [0, 4, 6] }), first = f.load(0, 25);
  f.requests[0].finish(); await flushStartup();
  f.requests[1].finish(); await flushStartup();
  f.requests[2].finish(); await flushStartup();
  assert.equal(first.calls.success, 0);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 2);
  t.mock.timers.tick(25); await flushStartup(); assert.equal(first.calls.error, 1);
});

test('startup buffer initial unavailable target starts no HTTP or authority work', async t => {
  const f = startupFixture(t); f.state.target = null;
  const first = f.load(); await flushStartup();
  assert.equal(f.requests.length, 0); assert.equal(f.state.authCalls, 0);
  assert.equal(first.calls.abort, 1); assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 0);
  assert.equal(f.engine.startupSnapshot().state, 'cancelled');
});

test('startup buffer option creates a one-shot engine while steady warming is false', async t => {
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3 });
  assert.deepEqual(await f.load(0).result, f.bytes);
  assert.equal(f.swarm.metrics().startupBuffer.state, 'ready');
  assert.equal(f.swarm.metrics().startupBuffer.released, 1);
  await sleep(20);
  assert.ok(f.requests.every(row => row.context.frag.sn < 3));
});

test('startup buffer never forwards payload progress before integrity and headroom checks', async t => {
  const f = startupFixture(t), first = f.load(); await flushStartup();
  f.requests[0].callbacks.onProgress({ loaded: 2 }, first.context, Uint8Array.of(2, 4).buffer);
  assert.equal(first.calls.progress, 0, 'partial bytes cannot reach demux/presentation');
  f.requests[0].callbacks.onProgress({ loaded: 4 }, first.context, Uint8Array.of(2, 4, 6, 8).buffer);
  assert.equal(first.calls.progress, 0, 'completed-body progress from non-progressive XHR is also held');
  f.requests[0].finish(false, Uint8Array.of(3, 4, 6, 8));
  await flushStartup();
  assert.equal(first.calls.success, 0); assert.equal(first.calls.progress, 0); assert.equal(first.calls.error, 1);
});

test('startup buffer explicitly rejects progressive configuration before first main data starts', async t => {
  const f = startupFixture(t, { progressive: true }), first = f.load(); await flushStartup();
  assert.equal(first.calls.error, 1); assert.equal(first.calls.args[0].startupBufferReason, 'progressive-unsupported');
  assert.equal(f.requests.length, 0); assert.equal(f.state.authCalls, 0);
});

test('startup buffer cancels changed original contexts during authority yields without accepting old bytes', async t => {
  const mutations = [
    ctx => { ctx.frag.sn++; }, ctx => { ctx.frag.cc++; },
    ctx => { ctx.url = 'https://origin.example/media/other.m4s'; },
    ctx => { ctx.frag.url = 'https://origin.example/media/other.m4s'; },
    ctx => { ctx.frag.start += 0.5; }, ctx => { ctx.rangeStart = 1; },
  ];
  for (const mutate of mutations) {
    const f = startupFixture(t), first = f.load();
    first.context[STARTUP_MARKER].accept = () => { f.state.accepted++; };
    f.requests[0].finish(); await flushStartup();
    f.state.holdRecheck = true; f.requests[1].finish(); await flushStartup();
    assert.equal(typeof f.state.releaseRecheck, 'function');
    mutate(first.context); f.state.releaseRecheck(); await flushStartup();
    assert.equal(first.calls.success, 0); assert.equal(f.state.accepted, 0); assert.equal(first.calls.abort, 1);
    assert.equal(f.engine.startupSnapshot().state, 'cancelled');
    assert.equal(f.engine.startupSnapshot().reason, 'context-changed');
  }
});

test('startup buffer reserves worst-case shared space synchronously before first HTTP or authority work', async t => {
  const f = startupFixture(t), first = f.load();
  assert.deepEqual(f.state.reservations, [24 * 1024 * 1024]);
  assert.equal(f.state.authCalls, 0); assert.equal(f.requests.length, 1);
  first.loader.destroy();

  const refused = startupFixture(t, { reserve: () => false }), denied = refused.load();
  assert.equal(refused.requests.length, 0, 'the shared held-cache cap must admit the reservation before HTTP can start');
  assert.equal(refused.state.authCalls, 0);
  assert.equal(denied.calls.error, 1);
  assert.equal(denied.calls.args[0].startupBufferReason, 'reservation-refused');
});

test('startup buffer rejects future coverage evicted while another authority check is pending', async t => {
  const f = startupFixture(t), first = f.load();
  first.context[STARTUP_MARKER].accept = () => { f.state.accepted++; };
  f.requests[0].finish(); await flushStartup();
  f.state.holdRecheck = true; f.requests[1].finish(); await flushStartup();
  assert.equal(typeof f.state.releaseRecheck, 'function');
  f.engine.release(f.requests[1].context.url);
  assert.equal(f.engine.snapshot().cacheObjects, 0);
  f.state.releaseRecheck(); await flushStartup();
  assert.equal(first.calls.success, 0, 'a captured row reference is not resident verified coverage');
  assert.equal(f.state.accepted, 0); assert.equal(first.calls.error, 1);
  assert.equal(first.calls.args[0].startupBufferReason, 'coverage-evicted');
});

test('startup buffer pins reauthorised future rows and releases pins immediately on abort or deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['abort', 'deadline']) {
    const f = startupFixture(t), first = f.load(0, 25);
    f.requests[0].finish(); await flushStartup();
    f.state.holdRecheck = true; f.requests[1].finish(); await flushStartup();
    const key = f.requests[1].context.url;
    assert.equal(f.engine.pinned(key), true, 'shared held-cache trimming cannot evict active revalidation coverage');
    if (action === 'abort') first.loader.abort(); else t.mock.timers.tick(25);
    assert.equal(f.engine.pinned(key), false, 'an unresolved authority must not retain a pin after cancellation');
    assert.equal(f.engine.snapshot().reservationBytes, 0);
    f.state.releaseRecheck(); await flushStartup();
    assert.equal(first.calls.success, 0);
    assert.equal(first.calls.abort, action === 'abort' ? 1 : 0);
    assert.equal(first.calls.error, action === 'deadline' ? 1 : 0);
  }
});

test('startup buffer revalidates earlier signed authority synchronously after another row yields', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
  const sk = generateSecretKey(), swarmId = 'startup-final-authority', seconds = Math.floor(Date.now() / 1000), events = new Map();
  const streamEvent = finalizeEvent({ kind: 30311, created_at: seconds,
    tags: [['d', swarmId], ['relayswarm', 'redistribute', '1']], content: '' }, sk);
  const f = startupFixture(t, { permit: ctx => {
    const key = sha(ctx.url);
    if (!events.has(ctx.frag.sn)) events.set(ctx.frag.sn, finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT,
      created_at: seconds, tags: [['x', swarmId], ['e', streamEvent.id]],
      content: commitmentContent({ v: 1, streamEventId: streamEvent.id, swarmId, key, rendition: '0',
        sequence: ctx.frag.sn, discontinuity: ctx.frag.cc, part: null, sha256: sha(Uint8Array.of(2, 4, 6, 8)),
        size: 4, expiresAt: seconds + (ctx.frag.sn === 0 ? 1 : 120) }) }, sk));
    const event = events.get(ctx.frag.sn), valid = context => verifySegmentCommitment(event,
      { streamEvent, swarmId, key, context, maxSegmentBytes: 16 * 1024 * 1024 });
    const permit = valid(ctx);
    return permit && { ...permit, key, current: context => Boolean(valid(context)) };
  } }), first = f.load();
  first.context[STARTUP_MARKER].accept = () => { f.state.accepted++; };
  f.requests[0].finish(); await flushStartup();
  f.state.holdRecheck = true; f.state.holdCheckSn = 1;
  f.requests[1].finish(); await flushStartup();
  assert.equal(typeof f.state.releaseRecheck, 'function');
  t.mock.timers.setTime((seconds + 2) * 1000);
  f.state.releaseRecheck(); await flushStartup();
  assert.equal(first.calls.success, 0, 'the earlier valid first permission expired while future authority yielded');
  assert.equal(f.state.accepted, 0); assert.equal(first.calls.error, 1);
  assert.equal(first.calls.args[0].startupBufferReason, 'authority-changed');
});

test('startup buffer synchronous accepted-delivery cancellation cannot release a stale first callback', async t => {
  for (const phase of ['accept', 'reuse']) {
    const f = startupFixture(t, { onReuse: phase === 'reuse' ? () => f.engine.stop() : undefined }), first = f.load();
    first.context[STARTUP_MARKER].peerBytes = 4;
    if (phase === 'accept') first.context[STARTUP_MARKER].accept = () => f.engine.stop();
    f.requests[0].finish(); await flushStartup();
    f.requests[1].finish(); await flushStartup();
    assert.equal(first.calls.success, 0, phase);
    assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
    assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
    assert.equal(f.engine.snapshot().reservationBytes, 0);
    assert.equal(f.engine.startupSnapshot().released, 0);
  }
});

test('startup buffer real SDK peer notification can stop only after matching bytes reach the Hls callback', async t => {
  let first, observed;
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3, held: [0], rangePeer: true,
    onPeerDelivery: ({ bytes }) => {
      observed = { callbacks: first.calls.success, credited: f.swarm.metrics().bytes.peerFirst, bytes };
      f.swarm.stop();
    } });
  const peer = await f.addPeer(); peer.have(0);
  first = f.load(0);
  assert.deepEqual(await first.result, f.bytes);
  assert.deepEqual(observed, { callbacks: 1, credited: f.bytes.length, bytes: f.bytes.length });
  assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
  const warm = f.swarm.metrics().warmAhead;
  assert.equal(warm.verifiedPeerBytes, f.bytes.length);
  assert.equal(warm.consumedPeerBytes, f.bytes.length);
  assert.ok(warm.consumedPeerBytes <= warm.verifiedPeerBytes);
  assert.deepEqual(first.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  assert.equal(f.swarm.metrics().startupBuffer.released, 1);
});

test('startup buffer required future can adopt late exact HAVE without pretending Hls already consumed it', async t => {
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3, held: [1], rangePeer: true });
  const first = f.load(0);
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const original = f.requests.find(row => row.context.frag.sn === 1);
  const dependency = original.context[STARTUP_MARKER]?.startupDependency?.();
  assert.equal(first.calls.success, 0); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  const peer = await f.addPeer(); peer.have(1);
  await until(() => f.swarm.metrics().startupBuffer.state === 'ready');
  assert.ok(dependency, 'required future had the active first terminal as its dependency');
  assert.deepEqual(await first.result, f.bytes);
  const m = f.swarm.metrics(), entered = m.latePeerRace.records.find(row => row.sequence === 1 && row.outcome === 'entered');
  assert.equal(entered.reason, 'startup-buffer-dependency');
  assert.equal(entered.genuineAtMs, null, 'a required future is not yet a separate Hls consumer');
  assert.ok(entered.windowEndAtMs <= entered.startupDeadlineAtMs);
  assert.ok(entered.windowEndAtMs <= entered.startupDependencyAtMs + 4000);
  assert.equal(original.aborted, true); assert.equal(original.completed, false);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  assert.equal(m.warmAhead.verifiedPeerBytes, f.bytes.length);
  assert.equal(m.warmAhead.consumedPeerBytes, 0); assert.equal(m.bytes.peerFirst, 0);
  assert.equal(dependency.signal.aborted, true, 'first-terminal release retires the dependency immediately');
  assert.equal(original.context[STARTUP_MARKER].startupDependency(), null);
  assert.deepEqual(await f.load(1).result, f.bytes);
  assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length, 'credit begins only at the real future callback');
});

test('startup buffer fast verified held first peer establishes transport usefulness before consumed credit', async t => {
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3, held: [0, 1], rangePeer: true, lateHaveRace: true, size: 128 * 1024 });
  const peer = await f.addPeer(); peer.have(0);
  const first = f.load(0);
  await until(() => f.swarm.metrics().warmAhead.verifiedPeerBytes === f.bytes.length);
  assert.equal(first.calls.success, 0); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  assert.equal(f.swarm.metrics().warmAhead.consumedPeerBytes, 0);
  peer.have(1);
  await until(() => f.swarm.metrics().startupBuffer.state === 'ready').catch(error => {
    const m = f.swarm.metrics();
    throw new Error(error.message + JSON.stringify({ startup: m.startupBuffer, peerNoFit: m.segments.peerNoFit,
      workerTransfers: m.core.multiHolder.transfers, verifiedPeerBytes: m.warmAhead.verifiedPeerBytes, consumedPeerBytes: m.bytes.peerFirst }));
  });
  assert.deepEqual(await first.result, f.bytes);
  const m = f.swarm.metrics();
  assert.equal(m.core.multiHolder.transfers, 2);
  assert.equal(m.segments.peerNoFit, 0);
  assert.equal(m.warmAhead.verifiedPeerBytes, f.bytes.length * 2);
  assert.equal(m.warmAhead.consumedPeerBytes, f.bytes.length);
  assert.equal(m.bytes.peerFirst, f.bytes.length, 'held future remains unconsumed');
  assert.ok(m.peerRequestDiagnostics.records.every(row => row.elapsedMs - row.firstByteMs < 300), 'short flows do not invent a rate');
  assert.deepEqual(await f.load(1).result, f.bytes);
  assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length * 2);
});

test('startup buffer future dependency cannot survive pause or changed parsed future identity', async t => {
  for (const action of ['pause', 'parsed-change']) {
    const f = await fixture(t, { enabled: false, startupTarget: () => 1.3, held: [1], rangePeer: true });
    const first = f.load(0);
    await until(() => f.requests.some(row => row.context.frag.sn === 1));
    const original = f.requests.find(row => row.context.frag.sn === 1), mark = original.context[STARTUP_MARKER];
    const dependency = mark.startupDependency(); assert.ok(dependency);
    if (action === 'pause') { f.media.paused = true; f.media.dispatchEvent(new Event('pause')); }
    else f.fragments[1].start += 1;
    assert.equal(mark.startupDependency(), null, action);
    const peer = await f.addPeer(); peer.have(1); await sleep(20);
    assert.equal(f.swarm.metrics().latePeerRace.armed, 0, action);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0, action);
    assert.equal(first.calls.success, 0, action);
    if (action === 'parsed-change') {
      original.finish();
      await until(() => f.swarm.metrics().startupBuffer.state !== 'buffering');
      assert.equal(first.calls.success, 0, 'a completed old future must not release against changed parsed geometry');
    }
    if (action === 'pause') assert.equal(dependency.signal.aborted, true);
    first.loader.destroy();
  }
});

test('startup commit waits for safe verified bytes, then ACK and fresh authority before the exact callback', async t => {
  let commitCalls = 0, release, argument;
  const f = startupFixture(t, { commit: value => {
    commitCalls++; argument = value; return new Promise(resolve => { release = resolve; });
  } }), first = f.load();
  first.context[STARTUP_MARKER].peerBytes = 4;
  f.requests[0].finish(); await flushStartup();
  assert.equal(commitCalls, 0, 'the first body alone has insufficient current-target headroom');
  f.requests[1].finish(); await flushStartup();
  assert.equal(commitCalls, 1); assert.ok(Object.isFrozen(argument));
  assert.deepEqual(Object.keys(argument), ['signal']); assert.ok(argument.signal instanceof AbortSignal);
  assert.equal(argument.signal.aborted, false); assert.equal(first.calls.success, 0);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
  assert.equal(f.engine.pinned(f.requests[1].context.url), true);
  assert.equal(f.engine.startupSnapshot().commitStarted, true);
  assert.equal(f.engine.startupSnapshot().commitCompleted, false);
  const beforeChecks = f.state.authCalls;
  release(); await flushStartup();
  assert.equal(first.calls.success, 1); assert.equal(commitCalls, 1);
  assert.ok(f.state.authCalls >= beforeChecks + 2, 'ACK is followed by a fresh authority batch');
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 4);
  assert.equal(f.engine.startupSnapshot().commitCompleted, true);
  const second = f.load(1); await flushStartup();
  assert.equal(second.calls.success, 1); assert.equal(commitCalls, 1);
});

test('startup commit rechecks slow ACK target and holds for more verified headroom without recalling the hook', async t => {
  let release, calls = 0;
  const f = startupFixture(t, { commit: () => { calls++; return new Promise(resolve => { release = resolve; }); } }), first = f.load();
  f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
  f.state.target = 3.8; release(); await flushStartup();
  assert.equal(first.calls.success, 0); assert.equal(calls, 1);
  assert.equal(f.engine.startupSnapshot().commitCompleted, true);
  assert.equal(f.requests.length, 3); f.requests[2].finish(); await flushStartup();
  assert.equal(first.calls.success, 1); assert.equal(calls, 1);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 6);
});

test('startup commit keeps the original deadline and ignores a late ACK or rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const rejectLate of [false, true]) {
    let resolve, reject, signal, calls = 0;
    const f = startupFixture(t, { commit: value => { signal = value.signal; calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); } }), first = f.load(0, 25);
    f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
    t.mock.timers.tick(25); await flushStartup();
    assert.equal(signal.aborted, true); assert.equal(first.calls.error, 1);
    assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
    assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.pinned(f.requests[1].context.url), false);
    if (rejectLate) reject(new Error('late private host error')); else resolve();
    await flushStartup();
    assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 1);
    const count = f.requests.length, retry = f.load();
    assert.equal(retry.calls.error, 1); assert.equal(f.requests.length, count); assert.equal(calls, 1);
  }
});

test('startup commit cancels quietly on caller abort, pause-clear, destroy, stop and reentrant stop', async t => {
  for (const action of ['abort', 'pause-clear', 'destroy', 'stop', 'reentrant']) {
    let release, signal;
    const f = startupFixture(t, { commit: value => {
      signal = value.signal;
      if (action === 'reentrant') f.engine.stop();
      return new Promise(resolve => { release = resolve; });
    } }), first = f.load();
    f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
    if (action === 'pause-clear') { f.state.allowed = false; f.engine.clear(); }
    else if (action === 'stop') f.engine.stop();
    else if (action !== 'reentrant') first.loader[action]();
    await flushStartup(); assert.equal(signal.aborted, true);
    const before = { ...first.calls }; release(); await flushStartup();
    assert.deepEqual(first.calls, before); assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 0);
    assert.equal(first.calls.abort, ['abort', 'pause-clear'].includes(action) ? 1 : 0);
    assert.equal(f.engine.snapshot().consumedPeerBytes, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
  }
});

test('startup commit failure reports a fixed reason once without leaking the host error', async t => {
  let calls = 0;
  const f = startupFixture(t, { commit: () => { calls++; throw new Error('private host detail'); } }), first = f.load();
  f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
  assert.equal(first.calls.error, 1); assert.equal(first.calls.success, 0);
  assert.equal(first.calls.args[0].startupBufferReason, 'commit-refused');
  assert.ok(!JSON.stringify(first.calls.args[0]).includes('private'));
  assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
  const retry = f.load(); assert.equal(retry.calls.error, 1); assert.equal(calls, 1);
});

test('startup commit revalidates original context, parsed geometry, reservoir residency and authority after ACK', async t => {
  for (const action of ['original-context', 'parsed-future', 'evicted', 'authority']) {
    let release;
    const starts = [0, 2, 4], f = startupFixture(t, { starts,
      commit: () => new Promise(resolve => { release = resolve; }) }), first = f.load();
    first.context[STARTUP_MARKER].peerBytes = 4;
    f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
    if (action === 'original-context') first.context.frag.sn++;
    if (action === 'parsed-future') starts[1] += 1;
    if (action === 'evicted') f.engine.release(f.requests[1].context.url);
    if (action === 'authority') f.state.revoked.add(0);
    release(); await flushStartup();
    assert.equal(first.calls.success, 0, action); assert.equal(f.engine.snapshot().consumedPeerBytes, 0, action);
    assert.equal(f.engine.startupSnapshot().state, ['evicted', 'authority'].includes(action) ? 'failed' : 'cancelled', action);
  }
});

test('startup commit real SDK hook retains verified peer bytes without accepted credit until ACK', async t => {
  let release, calls = 0;
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3,
    startupCommit: ({ signal }) => { assert.equal(signal.aborted, false); calls++; return new Promise(resolve => { release = resolve; }); },
    held: [0], rangePeer: true });
  const peer = await f.addPeer(); peer.have(0);
  const first = f.load(0); await until(() => calls === 1);
  assert.equal(first.calls.success, 0); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  assert.equal(f.swarm.metrics().warmAhead.consumedPeerBytes, 0);
  release(); assert.deepEqual(await first.result, f.bytes);
  assert.equal(first.calls.success, 1); assert.equal(calls, 1);
  assert.equal(f.swarm.metrics().bytes.peerFirst, f.bytes.length);
});

test('startup commit real SDK pause aborts ACK ownership without a late first callback', async t => {
  let release, signal;
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3,
    startupCommit: value => { signal = value.signal; return new Promise(resolve => { release = resolve; }); } });
  const first = f.load(0); await until(() => typeof release === 'function');
  f.media.paused = true; f.media.dispatchEvent(new Event('pause'));
  assert.equal(signal.aborted, true);
  assert.equal(await first.result, null);
  release(); await sleep(20);
  assert.deepEqual(first.calls, { success: 0, abort: 1, error: 0, timeout: 0 });
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  assert.equal(f.swarm.metrics().startupBuffer.commitCompleted, false);
});

test('startup commit real SDK checks freshly signed expiry again after ACK', async t => {
  let release;
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3,
    startupCommit: () => new Promise(resolve => { release = resolve; }) });
  const first = f.load(0), outcome = first.result.catch(error => error);
  await until(() => typeof release === 'function');
  f.state.expired = true; release();
  const error = await outcome;
  assert.equal(error.startupBufferReason, 'authority-changed');
  assert.deepEqual(first.calls, { success: 0, abort: 0, error: 1, timeout: 0 });
  assert.equal(f.swarm.metrics().startupBuffer.state, 'failed');
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
});

test('startup commit invalid configuration declines without a startup target or function', async t => {
  const absent = await fixture(t, { enabled: false, startupCommit: () => {} });
  const invalid = await fixture(t, { enabled: false, startupTarget: () => 0, startupCommit: true });
  assert.equal(absent.swarm.metrics().disabledReason, 'invalid-startup-buffer-commit');
  assert.equal(invalid.swarm.metrics().disabledReason, 'invalid-startup-buffer-commit');
});

test('startup commit final authority verdict and Hls handoff share one synchronous turn', async t => {
  for (const useHook of [false, true]) {
    let afterAck = !useHook, queued = false, revoked = false;
    const events = [];
    const f = startupFixture(t, { commit: useHook ? () => { afterAck = true; } : null,
      permit: ctx => ({ key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => {
        if (afterAck && ctx.frag.sn === 1 && !queued) {
          queued = true; queueMicrotask(() => { revoked = true; events.push('revoked'); });
        }
        return !revoked;
      } }),
      onSuccess: () => events.push(revoked ? 'delivered-after-revocation' : 'delivered-before-revocation'),
    }), first = f.load();
    f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
    assert.equal(first.calls.success, 1);
    assert.deepEqual(events, ['delivered-before-revocation', 'revoked'], 'no Promise boundary may separate the final authority verdict from actual handoff');
  }
});

test('startup commit successful-signal cleanup cannot stop Hls before its credited peer handoff', async t => {
  let first, atAbort = null;
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3, held: [0], rangePeer: true,
    startupCommit: ({ signal }) => signal.addEventListener('abort', () => {
      atAbort = { callbacks: first.calls.success, credited: f.swarm.metrics().bytes.peerFirst };
      first.loader.destroy(); f.swarm.stop();
    }, { once: true }),
  });
  const peer = await f.addPeer(); peer.have(0);
  first = f.load(0); await until(() => atAbort !== null);
  assert.deepEqual(atAbort, { callbacks: 1, credited: f.bytes.length });
  assert.deepEqual(first.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  assert.deepEqual(await first.result, f.bytes);
});
