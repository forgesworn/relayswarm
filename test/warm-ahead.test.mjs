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
      // options.bodies(sn) gives each fragment its own signed body; options.firstByteMs
      // reports a first byte that long after the start (never after the end).
      const sourceBody = options.bodies ? options.bodies(context.frag.sn) : bytes;
      const row = { context, config, callbacks, loader: this, aborted: false, completed: false, started: performance.now(), finish: (body = sourceBody) => {
        if (row.aborted) return;
        clearTimeout(row.parentTimer);
        row.completed = true;
        const end = performance.now(), first = options.firstByteMs === undefined ? row.started : Math.min(end, row.started + options.firstByteMs);
        Object.assign(this.stats, { loaded: body.length, total: body.length, loading: { start: row.started, first, end } });
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
    iceGatheringState = 'complete'; localDescription = { sdp: 'fixture-sdp\r\na=candidate:fixture 1 udp 1 fixture.local 9 typ host\r\n' };
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
    const signed = options.bodies ? options.bodies(context.frag.sn) : bytes;
    const pieceSize = commitmentPieceSize(signed.length), pieces = [];
    if (options.rangePeer) for (let at = 0; at < signed.length; at += pieceSize) pieces.push(sha(signed.subarray(at, at + pieceSize)));
    const event = finalizeEvent({ kind: KIND_SEGMENT_COMMITMENT, created_at: seconds, tags: [['x', swarmId], ['e', streamEvent.id]],
      content: commitmentContent({ v: options.rangePeer ? 3 : 2, streamEventId: streamEvent.id, swarmId, key, rendition: '/media/index.m3u8',
        playlist: '/media/index.m3u8', mediaType: 'main', encryption: null, sequence: context.frag.sn, discontinuity: context.frag.cc,
        part: null, sha256: options.badHash ? 'f'.repeat(64) : sha(signed), size: signed.length, expiresAt: seconds + (state.expired ? -1 : 120),
        ...(options.rangePeer ? { pieceSize, pieces } : {}) }) }, sk);
    events.set(cacheKey, event); return event;
  };
  const swarm = createHlsSwarm({ swarmId, mode: 'peer-first', serve: true, warmAhead: options.enabled ?? true,
    streamEvent, getCommitment, RTCPeerConnectionImpl: PC, relays: [relay.url], ...(fixtureCore ? { coreWasm: fixtureCore } : {}),
    ...(options.rangePeer ? { multiHolder: true, zeroBudgetPeerRace: true, sustainablePeerWait: true, latePeerRace: options.latePeerRace ?? true,
      lateHaveRace: options.lateHaveRace ?? false,
      maxPeerWaitMs: options.maxPeerWaitMs ?? 2500, lateWindowMs: 4000 } : {}),
    ...(options.maxRaces ? { maxConcurrentRaces: options.maxRaces } : {}),
    ...(options.bufferedMixedRanges === undefined ? {} : { bufferedMixedRanges: options.bufferedMixedRanges }),
    ...(options.traceRequests === undefined ? {} : { traceRequests: options.traceRequests }),
    ...(options.gated ? { ticket: 'fixture-owner', admit: () => state.admit } : {}),
    maxHeldBytes: options.maxHeldBytes ?? 64 * 1024 * 1024, maxHeldSegments: options.maxHeldSegments ?? 12,
    ...(options.onPeerDelivery ? { onPeerDelivery: options.onPeerDelivery } : {}),
    ...(options.startupTarget === undefined ? {} : { startupBufferTarget: options.startupTarget }),
    ...(options.startupCommit === undefined ? {} : { startupBufferCommit: options.startupCommit }),
    ...(options.startupMaxBytes === undefined ? {} : { startupBufferMaxBytes: options.startupMaxBytes }),
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
  return { requests, fragments, swarm, hls, media, load, bytes, state, addPeer, connections };
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

for (const budget of ['zero', 'throw']) test(`promoted demand defers its speculative successor when recovery headroom is ${budget}`, async t => {
  const f = await fixture(t, { held: [1, 2] });
  await f.load(0).result;
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const original = f.requests.find(row => row.context.frag.sn === 1);
  f.media.currentTime = 1.9;
  f.media.buffered = { length: 1, start: () => 0, end: () => {
    if (budget === 'throw') throw new Error('fixture unavailable buffer');
    return 2;
  } };
  const demand = f.load(1);
  await sleep(10);
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false, 'a low-buffer promoted source owns the next service opportunity');
  assert.equal(original.aborted, false);
  assert.equal(f.swarm.metrics().warmAhead.promoted, 1);
  assert.equal(f.swarm.metrics().warmAhead.active, 0, 'denial before dequeue owns no new speculative row');
  original.finish();
  assert.deepEqual(await demand.result, f.bytes);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  assert.deepEqual(demand.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
});

test('deferred speculation regenerates the actual SDK fragment-loader context before resuming', async t => {
  let release, held = false;
  const f = await fixture(t, { held: [1, 2], beforeCommitment: ctx => ctx.frag.sn === 2 && !held
    ? new Promise(resolve => { held = true; release = resolve; }) : undefined });
  t.after(() => release?.());
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const original = f.requests.find(row => row.context.frag.sn === 1), first = f.load(1);
  await until(() => typeof release === 'function');
  f.media.currentTime = 1.9; f.media.buffered = { length: 1, start: () => 0, end: () => 2 };
  release(); await until(() => f.swarm.metrics().warmAhead.active === 0);
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  f.media.buffered = { length: 1, start: () => 0, end: () => 20 };
  original.finish(); assert.deepEqual(await first.result, f.bytes);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  const resumed = f.requests.find(row => row.context.frag.sn === 2);
  assert.equal(resumed.context.type, LoaderContextType.MEDIA_FRAGMENT);
  assert.equal(typeof resumed.context.headers, 'object'); assert.notEqual(resumed.context.headers, null);
  assert.equal(resumed.context.rangeStart, f.fragments[2].byteRangeStartOffset);
  assert.equal(resumed.context.rangeEnd, f.fragments[2].byteRangeEndOffset);
  const second = f.load(2); resumed.finish(); assert.deepEqual(await second.result, f.bytes);
  assert.deepEqual(second.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
  assert.equal(f.requests.filter(row => row.context.frag.sn === 2).length, 1);
  assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
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

test('valid cached authority can win after the 25 ms recovery starts but before its source body', { timeout: 5000 }, async t => {
  let hold = false, entered = 0, release;
  const f = await fixture(t, { held: [1], beforeCommitment: context => {
    if (hold && context.frag.sn === 1) {
      hold = false; entered++;
      return new Promise(resolve => { release = resolve; });
    }
  } });
  assert.deepEqual(await f.load(0).result, f.bytes);
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const initial = f.requests.find(row => row.context.frag.sn === 1);
  initial.finish();
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  const before = f.swarm.metrics();
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  hold = true;
  // Only timer delivery is controlled; signing, cache verification and the
  // actual SDK/manager callbacks are real. This is not elapsed-time evidence.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const demand = f.load(1);
    for (let i = 0; i < 2000 && !entered; i++) await new Promise(setImmediate);
    assert.equal(entered, 1, 'the cached object reaches its real signed-authority revalidation');
    assert.equal(typeof release, 'function');
    t.mock.timers.tick(24);
    assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
    assert.deepEqual(demand.calls, { success: 0, abort: 0, error: 0, timeout: 0 });
    t.mock.timers.tick(1);
    for (let i = 0; i < 2000 && f.requests.filter(row => row.context.frag.sn === 1).length < 2; i++)
      await new Promise(setImmediate);
    const target = f.requests.filter(row => row.context.frag.sn === 1);
    assert.equal(target.length, 2, 'the original 25 ms bound starts independent source recovery');
    const recovery = target[1];
    assert.equal(recovery.completed, false);
    assert.equal(recovery.aborted, false);
    assert.equal(recovery.loader.stats.loaded, 0, 'the recovery has produced no body bytes');
    release();
    assert.deepEqual(await demand.result, f.bytes);
    assert.equal(recovery.aborted, true, 'valid cache authority cancels the pending recovery');
    assert.equal(recovery.completed, false, 'the recovery attempt never supplies a body');
    assert.deepEqual(demand.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
    const after = f.swarm.metrics();
    assert.equal(after.warmAhead.localReuseBytes - before.warmAhead.localReuseBytes, f.bytes.length);
    assert.equal(after.bytes.peerFirst, before.bytes.peerFirst);
    assert.equal(after.bytes.peerFirst, 0);
    assert.equal(after.warmAhead.consumedPeerBytes, 0);
    recovery.finish(); recovery.finish();
    await new Promise(setImmediate);
    demand.loader.destroy(); demand.loader.abort();
    assert.equal(recovery.completed, false);
    assert.equal(target.filter(row => row.completed).length, 1, 'only the verified initial warm source completed');
    assert.deepEqual(demand.calls, { success: 1, abort: 0, error: 0, timeout: 0 });
    assert.deepEqual(demand.terminals, [{ type: 'success', sn: 1 }]);
    assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, after.warmAhead.localReuseBytes);
    assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  } finally { release?.(); t.mock.timers.reset(); }
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

test('combined steady warming and buffered mixed options serve a verified future with the actual Core', async t => {
  const f = await fixture(t, { rangePeer: true, silentPeer: true, held: [1], bufferedMixedRanges: true,
    traceRequests: 128 });
  assert.equal(f.swarm.metrics().core.state, 'ready', 'the committed WASM Core is actually selected');
  assert.equal(f.swarm.metrics().disabledReason, null);
  Object.assign(f.media, { readyState: 4, playbackRate: 1, ended: false, seeking: false });
  const peer = await f.addPeer(); f.connections[0].connectionState = 'connected';
  const genuine = f.load(0); assert.deepEqual(await genuine.result, f.bytes);
  await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const future = f.requests.find(row => row.context.frag.sn === 1);
  assert(future.context[STARTUP_MARKER], 'speculation enters the real SDK with its warm ownership marker');
  const key = sha('warm-ahead-fixture\n/media/s1.m4s');
  assert(!peer.sent.some(row => row?.t === 'have' && (row.keys ?? row.add ?? []).includes(key)),
    'unverified in-flight source bytes cannot advertise a held future');
  future.finish(); await until(() => f.swarm.metrics().warmAhead.verified >= 1);
  await until(() => peer.sent.some(row => row?.t === 'have' && (row.keys ?? row.add ?? []).includes(key)));
  const loadIds = f.swarm.trace().rows.filter(row => row.k === 'load' && row.sn === 1).map(row => row.load);
  assert(loadIds.length > 0, 'the speculative SDK load is present in the actual trace');
  assert(!f.swarm.trace().rows.some(row => row.k === 'mixedScope' && loadIds.includes(row.load)),
    'the marked speculative object does not enter buffered mixed setup');
  peer.want(1); await until(() => peer.sent.some(row => row?.t === 'eof' && row.id === 2));
  assert.deepEqual(peer.sent.find(row => row instanceof Uint8Array), f.bytes);
  const before = f.swarm.metrics().bytes.peerFirst;
  const consumed = f.load(1); assert.deepEqual(await consumed.result, f.bytes);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  assert.equal(consumed.calls.success, 1); assert.equal(genuine.calls.success, 1);
  assert.equal(f.swarm.metrics().warmAhead.localReuseBytes, f.bytes.length);
  assert.equal(f.swarm.metrics().bytes.peerFirst, before, 'HTTP warm reuse cannot invent accepted peer bytes');
  assert(f.swarm.metrics().warmAhead.active <= 1);
  f.media.paused = true; f.media.dispatchEvent(new Event('pause'));
  assert.equal(f.swarm.metrics().warmAhead.cacheBytes, 0);
});

test('an ordered reliable silent peer keeps the verified warm HTTP winner after an active WANT', { timeout: 20000 }, async t => {
  const f = await fixture(t, { rangePeer: true, silentPeer: true, held: [1, 2], bufferedMixedRanges: true, traceRequests: 128 });
  assert.equal(f.swarm.metrics().core.state, 'ready');
  Object.assign(f.media, { readyState: 4, playbackRate: 1, ended: false, seeking: false });
  const peer = await f.addPeer();
  Object.assign(peer.channel, { ordered: true, maxRetransmits: null, maxPacketLifeTime: null });
  f.connections[0].connectionState = 'connected'; peer.have(1);
  const key = sha('warm-ahead-fixture\n/media/s1.m4s');
  const first = f.load(0); assert.deepEqual(await first.result, f.bytes);
  await until(() => peer.sent.some(row => row?.t === 'want' && row.k === key));
  const want = peer.sent.find(row => row?.t === 'want' && row.k === key);
  const future = f.requests.find(row => row.context.frag.sn === 1); assert(future && !future.completed && !future.aborted);
  let httpSuccess = 0; const onSuccess = future.callbacks.onSuccess;
  future.callbacks.onSuccess = function (...args) { httpSuccess++; return onSuccess.apply(this, args); };
  future.finish();
  await until(() => peer.sent.some(row => row?.t === 'have' && (row.keys ?? row.add ?? []).includes(key)));
  await until(() => peer.sent.some(row => row?.t === 'cancel' && row.id === want.id));
  // A reliable cancelled response owns its drain until this exact holder's
  // matching range metadata/EOF arrives; cancellation does not waive it.
  peer.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'meta', id: want.id, size: f.bytes.length, p: want.p }) }));
  peer.channel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'eof', id: want.id }) }));
  assert.equal(peer.channel.readyState, 'open'); assert.equal(f.swarm.metrics().peers.connected, 1);
  assert.equal(httpSuccess, 1); assert(future.completed); assert.equal(future.aborted, false);
  assert.equal(f.swarm.metrics().peerAdmission.claimedLinks, 0); assert.equal(f.swarm.metrics().peerAdmission.waiting, 0);
  assert.equal(f.swarm.metrics().warmAhead.rejected, 0); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  assert.equal(first.calls.success, 1);
  await until(() => f.requests.some(row => row.context.frag.sn === 2));
  const next = f.requests.find(row => row.context.frag.sn === 2); assert(!next.completed && !next.aborted);
  assert.equal(f.swarm.metrics().warmAhead.reservationBytes, f.bytes.length, 'only the next held future owns a reservation');
  const consumed = f.load(1); assert.deepEqual(await consumed.result, f.bytes);
  assert.equal(consumed.calls.success, 1); assert.equal(f.swarm.metrics().bytes.peerFirst, 0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  f.media.paused = true; f.media.dispatchEvent(new Event('pause'));
  await until(() => f.swarm.metrics().warmAhead.reservationBytes === 0 && f.swarm.metrics().warmAhead.active === 0);
  assert(next.aborted);
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
  const urlFor = sn => options.urlFor?.(sn) ?? `https://origin.example/media/s${sn}.m4s`;
  const context = sn => ({ url: urlFor(sn), responseType: 'arraybuffer',
    frag: { sn, cc: 0, level: 0, type: 'main', start: options.starts?.[sn] ?? sn * 2, duration: options.durations?.[sn] ?? 2,
      url: urlFor(sn), baseurl: 'https://origin.example/media/index.m3u8' } });
  class Loader {
    stats = { loading: { start: 0 }, loaded: 0 };
    constructor() { options.onConstructor?.(); }
    load(ctx, _policy, callbacks) {
      if (options.timedStats) this.stats.loading = { start: performance.now() };
      const row = { context: ctx, config: _policy, callbacks, aborted: false, stats: this.stats,
        finish: (force = false, body = bytes) => {
          if (row.aborted && !force) return;
          row.response = { data: body.slice().buffer, url: ctx.url, code: 200 };
          this.stats.loaded = body.length;
          if (options.timedStats) {
            const end = performance.now();
            // hls.js sets loading.first at headers; null models a loader without it.
            if (options.firstByteMs !== null) this.stats.loading.first = Math.min(end, this.stats.loading.start + (options.firstByteMs ?? 1));
            this.stats.loading.end = end;
          }
          options.beforeSuccess?.(ctx, this.stats);
          callbacks.onSuccess(row.response, this.stats, ctx, null);
        } };
      this.row = row; requests.push(row);
    }
    abort() { if (this.row && !this.row.aborted) { this.row.aborted = true; this.stats.aborted = true;
      options.onAbort?.(this.row.context, this.row);
      this.row.callbacks.onAbort?.(this.stats, this.row.context, null); } }
    destroy() { this.abort(); }
  }
  const engine = createWarmAhead({ Loader, steady: options.steady ?? false,
    startupTarget: options.startup === false ? null : () => { state.targetCalls++; return state.target; }, startupCommit: options.commit,
    startupMaxBytes: options.startupMaxBytes,
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
    onReuse: options.onReuse, reuseBudget: options.reuseBudget, prefetch: options.prefetch,
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

// Logical controller proofs pair monotonic expiry with mocked timer delivery.
// Native elapsed-time tests and explicitly clocked replays remain separate.
function startupLogicalClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000; t.mock.method(performance, 'now', () => now);
  return ms => { now += ms; t.mock.timers.tick(ms); };
}

// Manager lifecycle controls with simulated four-byte source bodies. Actual
// SDK/Core transfer and credit are exercised separately, not manufactured here.
async function declinedWarmFixture(t, hooks = {}) {
  const have = new Set(), auth = [], contexts = new Map(), checks = [];
  const key = sn => `object-${sn}`;
  let f;
  const state = { have, auth, contexts, checks, key, get f() { return f; } };
  f = startupFixture(t, { startup: false, steady: true,
    permit: ctx => {
      auth.push(ctx.frag.sn); contexts.set(ctx.frag.sn, ctx);
      const permit = { key: key(ctx.frag.sn), size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true };
      return hooks.authorise ? hooks.authorise(ctx, permit, state) : permit;
    },
    prefetch: (ctx, permit, reconsidered) => {
      assert.equal(permit.size, 4, 'supply checks receive a fresh actual permit, never routing metadata');
      assert.equal(typeof permit.sha256, 'string'); assert.equal(typeof permit.current, 'function');
      checks.push({ sn: ctx.frag.sn, reconsidered: reconsidered === true });
      return have.has(permit.key);
    },
    onNext: ctx => hooks.next?.(ctx, state), onConstructor: () => hooks.constructor?.(state),
    onAbort: (ctx, row) => hooks.abort?.(ctx, row, state),
    reserve: size => hooks.reserve?.(size, state) ?? true,
    reuseBudget: ctx => hooks.budget?.(ctx, state) ?? 25,
  });
  const first = f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  assert.equal(first.calls.success, 1); assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0]);
  assert.equal(f.engine.snapshot().declinedSourceObjects, 2);
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().cacheObjects, 0);
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().trackedObjects, 0);
  return { ...state, f, first };
}

test('warm HAVE reconsideration retains at most two routes and consumes each notification once', async t => {
  startupLogicalClock(t);
  const { f, have, auth, key } = await declinedWarmFixture(t);
  assert.equal(f.engine.reconsiderHave(['unrelated']), 0);
  have.add(key(1)); assert.equal(f.engine.reconsiderHave([key(1), key(1)]), 1);
  assert.equal(f.engine.reconsiderHave([key(1)]), 0); await flushStartup();
  const future = f.requests.find(row => row.context.frag.sn === 1); assert(future);
  future.finish(); await flushStartup();
  assert.equal(f.engine.snapshot().verified, 1); assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
  assert.equal(auth.filter(sn => sn === 1).length, 2, 'initial refusal and one fresh authorised reconsideration');
  const count = f.state.authCalls;
  for (let i = 0; i < 4; i++) assert.equal(f.engine.reconsiderHave([key(1)]), 0);
  await flushStartup(); assert.equal(f.state.authCalls, count);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  assert(f.engine.snapshot().declinedSourceObjects <= 2);
});

for (const outcome of ['throw', 'nonboolean']) test(`warm HAVE reconsideration cannot retain an uncertain ${outcome} decision`, async t => {
  startupLogicalClock(t);
  const f = startupFixture(t, { startup: false, steady: true, prefetch: () => {
    if (outcome === 'throw') throw new Error('controlled optional policy failure');
    return undefined;
  } });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0]);
  assert.equal(f.engine.snapshot().declinedSourceObjects, 0); assert.equal(f.engine.snapshot().sourceYielded, 0);
  assert.equal(f.engine.snapshot().reservationBytes, 0); const count = f.state.authCalls;
  assert.equal(f.engine.reconsiderHave(['https://origin.example/media/s1.m4s']), 0);
  await flushStartup(); assert.equal(f.state.authCalls, count);
});

test('warm HAVE reconsideration retains the first eight-second deadline', async t => {
  const tick = startupLogicalClock(t), { f, have, key } = await declinedWarmFixture(t);
  tick(7900); have.add(key(1)); assert.equal(f.engine.reconsiderHave([key(1)]), 1); await flushStartup();
  const future = f.requests.find(row => row.context.frag.sn === 1); assert(future);
  const work = future.context[STARTUP_MARKER].work();
  assert.equal(work.enteredAt, 1000); assert.equal(work.deadline, 9000);
  tick(99); await flushStartup(); assert.equal(future.aborted, false);
  tick(1); await flushStartup(); assert.equal(future.aborted, true);
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().declinedSourceObjects, 0);
  const count = f.state.authCalls; have.add(key(2));
  assert.equal(f.engine.reconsiderHave([key(1), key(2)]), 0); await flushStartup();
  assert.equal(f.state.authCalls, count); assert.equal(f.engine.snapshot().verified, 0);
});

for (const ending of ['reserve-withdraw', 'constructor-withdraw', 'constructor-pause', 'authorise-mutate', 'authorise-mutate-throw', 'next-mutate-throw', 'next-stop', 'next-pause-after-constructor']) {
  test(`warm HAVE reconsideration rejects ${ending} before optional source`, async t => {
    startupLogicalClock(t); let armed = false, changed = false, constructed = false;
    const change = state => {
      changed = true; armed = false;
      if (ending.endsWith('withdraw')) state.have.delete(state.key(1));
      else if (ending === 'constructor-pause') state.f.state.allowed = false;
    };
    const { f, have, auth, key } = await declinedWarmFixture(t, {
      reserve: (_size, state) => { if (armed && ending === 'reserve-withdraw') change(state); return true; },
      constructor: state => {
        if (armed && ending === 'next-pause-after-constructor') constructed = true;
        else if (armed && ending.startsWith('constructor-')) change(state);
      },
      authorise: (ctx, permit, state) => {
        if (armed && ctx.frag.sn === 1 && ending.startsWith('authorise-')) {
          changed = true; armed = false; ctx.frag.start += 0.5;
          if (ending.endsWith('throw')) throw new Error('controlled changed context');
        }
        return permit;
      },
      next: (_ctx, state) => {
        if (ending === 'next-pause-after-constructor') {
          if (armed && constructed) { changed = true; armed = false; state.f.state.allowed = false; }
          return;
        }
        if (!armed || !ending.startsWith('next-')) return;
        if (ending === 'next-stop') { changed = true; armed = false; state.f.engine.stop(); }
        else if (state.auth.filter(sn => sn === 1).length === 2) {
          changed = true; armed = false; state.contexts.get(1).frag.start += 0.5;
          throw new Error('controlled parsed callback mutation');
        }
      },
    });
    armed = true; have.add(key(1)); assert.equal(f.engine.reconsiderHave([key(1)]), 1); await flushStartup();
    assert(changed, 'the guarded callback actually executed');
    assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0]);
    assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
    assert.equal(f.engine.snapshot().verified, 0); assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
    f.state.allowed = true; have.add(key(1)); const count = auth.length;
    for (let i = 0; i < 4; i++) assert.equal(f.engine.reconsiderHave([key(1)]), 0);
    await flushStartup(); assert.equal(auth.length, count, 'failed reconsideration cannot repopulate a HAVE retry route');
  });
}

test('warm HAVE reconsideration cannot reuse a changed authorised object key', async t => {
  startupLogicalClock(t); let changed = false;
  const { f, have, key } = await declinedWarmFixture(t, { authorise: (_ctx, permit) => changed ? { ...permit, key: 'replacement-object' } : permit });
  changed = true; have.add(key(1)); have.add('replacement-object');
  assert.equal(f.engine.reconsiderHave([key(1)]), 1); await flushStartup();
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0]);
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.reconsiderHave([key(1)]), 0);
});

test('warm HAVE reconsideration preserves genuine promotion during fresh authorisation', async t => {
  const tick = startupLogicalClock(t); let held = false, release;
  t.after(() => release?.());
  const { f, have, key } = await declinedWarmFixture(t, { authorise: (ctx, permit) => held && ctx.frag.sn === 1
    ? new Promise(resolve => { held = false; release = () => resolve(permit); }) : permit });
  tick(7900); held = true; have.add(key(1)); assert.equal(f.engine.reconsiderHave([key(1)]), 1); await flushStartup();
  assert.equal(typeof release, 'function');
  const demand = f.load(1, 12000); await flushStartup(); have.delete(key(1)); tick(200); release(); await flushStartup();
  const source = f.requests.find(row => row.context.frag.sn === 1); assert(source, 'genuine recovery remains available after pre-expiry promotion');
  source.finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(demand.calls.abort, 0); assert.equal(demand.calls.error, 0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
});

test('warm HAVE abandon retires optional ownership before any late completion or HAVE retry', async t => {
  startupLogicalClock(t);
  const { f, have, key } = await declinedWarmFixture(t);
  have.add(key(1)); assert.equal(f.engine.reconsiderHave([key(1)]), 1); await flushStartup();
  const source = f.requests.find(row => row.context.frag.sn === 1), marker = source.context[STARTUP_MARKER];
  const work = marker.work(); assert.equal(work.reconsidered, true); assert.equal(typeof marker.abandon, 'function');
  Reflect.set(work, 'reconsidered', false);
  assert.equal(marker.work().reconsidered, true, 'mutating a returned descriptor cannot change the owned mode');
  assert.equal(marker.abandon(), true); assert.equal(source.aborted, true); assert.equal(work.signal.aborted, true);
  assert.equal(marker.work(), null); assert.equal(marker.abandon(), false); await flushStartup();
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
  assert.equal(f.engine.snapshot().cacheObjects, 0); const count = f.state.authCalls;
  assert.equal(f.engine.reconsiderHave([key(1)]), 0);
  source.finish(true); await flushStartup();
  assert.equal(f.state.authCalls, count); assert.equal(f.engine.snapshot().verified, 0); assert.equal(f.retained.length, 0);
});

test('warm HAVE abandon refuses a genuine promotion and keeps its original source parent', async t => {
  const tick = startupLogicalClock(t), { f, have, key } = await declinedWarmFixture(t);
  have.add(key(1)); f.engine.reconsiderHave([key(1)]); await flushStartup();
  const source = f.requests.find(row => row.context.frag.sn === 1), marker = source.context[STARTUP_MARKER], first = marker.work();
  const parent = source.config;
  const demand = f.load(1, 12000); await flushStartup();
  assert.equal(marker.work().genuine.context, demand.context); assert.equal(marker.abandon(), false);
  assert.equal(source.aborted, false); assert.equal(marker.work().signal, first.signal);
  tick(8001); await flushStartup();
  assert.equal(marker.abandon(), false); assert.equal(source.aborted, false);
  assert.equal(marker.work().enteredAt, first.enteredAt); assert.equal(marker.work().deadline, first.deadline);
  assert.equal(source.config, parent); assert.equal(parent.loadPolicy.maxLoadTimeMs, 12000);
  source.finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(demand.calls.abort, 0); assert.equal(demand.calls.error, 0);
  assert.deepEqual([...new Uint8Array(demand.calls.args[0].data)], [2,4,6,8]);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
});

test('warm HAVE abandon abort reentry gives genuine demand its own immediate source', async t => {
  startupLogicalClock(t); let armed = false, demand, oldMarker, abortCalls = 0;
  const { f, have, key, first } = await declinedWarmFixture(t, { abort: (ctx, _row, state) => {
    if (!armed || ctx.frag.sn !== 1) return;
    armed = false; abortCalls++;
    assert.equal(oldMarker.work(), null, 'cancelled ownership is already unavailable inside BaseLoader.abort');
    assert.equal(oldMarker.abandon(), false);
    demand = state.f.load(1, 12000);
  } });
  have.add(key(1)); f.engine.reconsiderHave([key(1)]); await flushStartup();
  const oldSource = f.requests.find(row => row.context.frag.sn === 1); oldMarker = oldSource.context[STARTUP_MARKER];
  armed = true; assert.equal(oldMarker.abandon(), true); assert.equal(abortCalls, 1); assert(demand);
  const sources = f.requests.filter(row => row.context.frag.sn === 1);
  assert.equal(sources.length, 2, 'the reentrant genuine consumer starts source immediately instead of joining the dying row');
  assert.equal(sources[0], oldSource); assert.equal(oldSource.aborted, true); assert.equal(sources[1].aborted, false);
  assert.equal(f.engine.snapshot().coalesced, 0); assert.equal(demand.calls.abort, 0);
  oldSource.finish(true); await flushStartup();
  assert.equal(demand.calls.success, 0); assert.equal(demand.calls.abort, 0); assert.equal(sources[1].aborted, false);
  sources[1].finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(demand.calls.abort, 0); assert.equal(demand.calls.error, 0);
  assert.equal(first.calls.success, 1); assert.equal(first.calls.abort, 0);
  assert.equal(f.engine.snapshot().verified, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
});

for (const ending of ['clear', 'stop', 'expiry']) test(`warm HAVE abandon cannot revive retired ownership after ${ending}`, async t => {
  const tick = startupLogicalClock(t), { f, have, key } = await declinedWarmFixture(t);
  have.add(key(1)); f.engine.reconsiderHave([key(1)]); await flushStartup();
  const source = f.requests.find(row => row.context.frag.sn === 1), marker = source.context[STARTUP_MARKER];
  if (ending === 'expiry') tick(8000); else f.engine[ending]();
  await flushStartup(); assert.equal(marker.work(), null); assert.equal(marker.abandon(), false);
  source.finish(true); await flushStartup();
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
  assert.equal(f.engine.snapshot().verified, 0); assert.equal(f.engine.reconsiderHave([key(1)]), 0);
});

test('warm HAVE reconsideration preserves one-shot routing through promoted-headroom deferral', async t => {
  const tick = startupLogicalClock(t); let budget = 25, hold = false, release;
  t.after(() => release?.());
  const { f, have, auth, checks, key } = await declinedWarmFixture(t, {
    budget: () => budget,
    authorise: (ctx, permit) => hold && ctx.frag.sn === 2 ? new Promise(resolve => {
      hold = false; release = () => resolve(permit);
    }) : permit,
  });
  have.add(key(1)); assert.equal(f.engine.reconsiderHave([key(1)]), 1); await flushStartup();
  const source = f.requests.find(row => row.context.frag.sn === 1); assert(source);
  const demand = f.load(1, 12000); await flushStartup();
  assert.equal(f.engine.snapshot().promoted, 1); assert.equal(f.engine.snapshot().declinedSourceObjects, 2);
  const currentPlanAuth = auth.filter(sn => sn === 2).length;
  assert.equal(currentPlanAuth, 2, 'SN2 was separately declined for the original and current genuine plans');
  tick(2000); hold = true; have.add(key(2)); assert.equal(f.engine.reconsiderHave([key(2)]), 1); await flushStartup();
  assert.equal(typeof release, 'function'); budget = 0; release(); await flushStartup();
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 4);
  const heldAuth = f.state.authCalls; await flushStartup(); assert.equal(f.state.authCalls, heldAuth, 'blocked headroom does not busy-retry authority');
  have.delete(key(2)); tick(1000); budget = 25; source.finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  assert.equal(auth.filter(sn => sn === 2).length, currentPlanAuth + 2,
    'one fresh HAVE retry and one fresh authorisation on headroom resume remain mandatory');
  assert(checks.some(row => row.sn === 2 && row.reconsidered), 'resumed routing keeps the strict exact-supply policy');
  const count = f.state.authCalls; have.add(key(2));
  for (let i = 0; i < 4; i++) assert.equal(f.engine.reconsiderHave([key(2)]), 0);
  await flushStartup(); assert.equal(f.state.authCalls, count); assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
});

// Logical scheduling only: four-byte authorised bodies, not media throughput.
// Geometry is from manifest ad78fc006bc131da3dcbf10656d4b8023e3fde71cbe5dba7a39a1f3af7ae238c.
// Known SN1/4/8/9 services and recovery are retained scalar observations;
// SN7 is explicitly hypothetical. No service is invented for skipped SN5/6.
async function startupReachableReplay(t, sn7ServiceMs, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0; t.mock.method(performance, 'now', () => 1000 + elapsed);
  const starts = [0, 2, 4, 6, 8, 10.64, 12.64, 14.56, 16.56, 18.56, 20.56, 22.56];
  const durations = [2, 2, 2, 2, 2.64, 2, 1.92, 2, 2, 2, 2, 2];
  const services = { 1: 2917, 4: 3713, 7: sn7ServiceMs, 8: 1266, 9: 1120 };
  // Legacy scalar planning only: these replays retain the measured request order
  // from a loader without first-byte timing. Size-aware replays are separate.
  const f = startupFixture(t, { timedStats: true, firstByteMs: null, starts, durations, startupMaxBytes: 32 * 1024 * 1024, ...options,
    onNext: ctx => options.onNext?.(ctx, f, elapsed),
    beforeVerify: ctx => options.beforeVerify?.(ctx, f, elapsed),
    reserve: size => options.reserve?.(size, f, elapsed) ?? true });
  f.state.target = 2.851; // Derived from observed deadline target 14.851 minus 12 seconds.
  const first = f.load(1, 120000); await flushStartup();
  const samples = [], completions = [];
  while (elapsed < 12000 && !first.calls.success && !first.calls.error && !first.calls.abort) {
    const active = f.requests.find(row => !row.response && !row.aborted);
    const sn = active?.context.frag.sn;
    if (active) assert(Number.isFinite(services[sn]), `unobserved source service for SN${sn}`);
    const due = active ? active.stats.loading.start - 1000 + services[sn] : Infinity;
    const step = Math.min(10, 12000 - elapsed, Math.max(1, due - elapsed));
    elapsed += step; f.state.target = 2.851 + elapsed / 1000;
    t.mock.timers.tick(step);
    if (active && !active.aborted && elapsed >= due) {
      if (sn === 1) f.state.recovery = 3748.75;
      if (sn === 4) f.state.recovery = 4745;
      completions.push({ sn, elapsed }); active.finish();
    }
    await flushStartup();
    samples.push({ elapsed, target: f.state.target, startup: f.engine.startupSnapshot(), warm: f.engine.snapshot() });
  }
  const summary = { hypotheticalSn7ServiceMs: sn7ServiceMs, elapsed,
    requests: f.requests.map(row => row.context.frag.sn), completions,
    calls: { success: first.calls.success, error: first.calls.error, abort: first.calls.abort },
    startup: f.engine.startupSnapshot(), target: f.state.target, recoveryMs: f.state.recovery };
  return { f, first, samples, summary, elapsed };
}

for (const sn7ServiceMs of [500, 1120, 1266, 3500, 5000]) {
  test(`startup reachable window with hypothetical SN7 ${sn7ServiceMs}ms preserves recovery`, async t => {
    const { f, first, samples, summary, elapsed } = await startupReachableReplay(t, sn7ServiceMs);
    console.log(JSON.stringify({ fixture: 'startup-reachable-window-logical', ...summary }));
    assert(samples.every(({ startup, warm }) => startup.heldObjects <= 4 &&
      startup.heldBytes <= 32 * 1024 * 1024 && warm.cacheBytes + warm.reservationBytes <= 24 * 1024 * 1024 && warm.active <= 1));
    assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000);
    assert.equal(f.state.recovery, 4745, 'the observed recovery requirement is never reduced');
    if (sn7ServiceMs <= 1266) {
      assert.equal(first.calls.success, 1, 'a reachable verified window must release before the original deadline');
      assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0); assert(elapsed < 12000);
      assert.deepEqual(summary.requests, [1, 4, 7, 8, 9]);
      const ready = f.engine.startupSnapshot();
      assert(ready.verifiedStart <= f.state.target && ready.verifiedEnd > f.state.target);
      assert((ready.verifiedEnd - f.state.target) * 1000 >= f.state.recovery);
      assert.equal(first.calls.args[2], first.context); assert.equal(first.calls.args[0].data.byteLength, 4);
      assert.equal(samples.some(({ startup }) => startup.heldObjects === 4), true);
    } else {
      assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 1); assert.equal(elapsed, 12000);
      assert.equal(f.engine.startupSnapshot().reason, 'deadline');
      assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
      t.mock.timers.tick(20000); await flushStartup();
      assert.equal(first.calls.success, 0, 'a late body cannot renew or resurrect the failed startup');
    }
  });
}

test('startup reachable window cannot extend an unverified ahead prefix', async t => {
  let release;
  t.after(() => release?.());
  const { f, first, summary } = await startupReachableReplay(t, 1120, {
    beforeVerify: ctx => ctx.frag.sn === 8 ? new Promise(resolve => { release = resolve; }) : undefined,
  });
  assert(release, 'SN8 body reached the real verification boundary');
  assert.deepEqual(summary.requests, [1, 4, 7, 8]);
  assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 1);
  assert.equal(f.engine.startupSnapshot().reason, 'deadline');
  assert.equal(f.engine.snapshot().reservationBytes, 4, 'pending verification retains its reservation');
  release(); await flushStartup();
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
  assert.equal(first.calls.success, 0); assert.equal(f.requests.length, 4);
});

for (const refusal of ['reservation', 'future-bytes']) {
  test(`startup reachable window preserves exhausted ${refusal} admission`, async t => {
    let refused = 0;
    const { f, first, summary } = await startupReachableReplay(t, 1120, refusal === 'reservation' ? {
      reserve: (_size, engine) => {
        if (engine.engine.snapshot().cacheObjects === 2) { refused++; return false; }
        return true;
      },
    } : { permitSize: sn => sn === 9 ? 24 * 1024 * 1024 : 4 });
    if (refusal === 'reservation') assert(refused > 0);
    assert.deepEqual(summary.requests, [1, 4, 7, 8]);
    assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 1);
    assert.equal(f.engine.startupSnapshot().reason, 'deadline');
    assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
  });
}

test('startup reachable window cannot extend a gapped parsed prefix', async t => {
  const starts = [0, 2, 4, 6, 8, 10.64, 12.64, 14.56, 16.66, 18.66, 20.66, 22.66];
  const { f, first, summary } = await startupReachableReplay(t, 1120, { starts });
  assert.equal(summary.requests.includes(8), false); assert.equal(summary.requests.includes(9), false);
  assert.equal(first.calls.success, 0);
  assert(first.calls.error === 1 || first.calls.abort === 1);
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
});

for (const boundary of ['unreachable', 'sufficient-span']) {
  test(`startup reachable window does not extend an ahead ${boundary} pair`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let elapsed = 0; t.mock.method(performance, 'now', () => 1000 + elapsed);
    // Explicit metadata rejection vectors, not observed body services.
    const f = startupFixture(t, { timedStats: true, starts: [11, 13, 15, 17], durations: [2, 2, 2, 2] });
    f.state.target = boundary === 'unreachable' ? 0.1 : 2.851;
    f.state.recovery = boundary === 'unreachable' ? 4745 : 3500;
    const first = f.load(0, 120000); await flushStartup();
    for (const sn of [0, 1, 2]) {
      const row = f.requests.find(item => item.context.frag.sn === sn);
      assert(row, `ordinary bounded admission starts SN${sn}`);
      elapsed++; t.mock.timers.tick(1); row.finish(); await flushStartup();
    }
    t.mock.timers.tick(200); await flushStartup();
    assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2]);
    assert.equal(f.engine.snapshot().cacheObjects, 2); assert.equal(f.engine.startupSnapshot().verifiedEnd, null);
    assert.equal(f.engine.startupSnapshot().heldObjects, 3);
    assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 0);
    first.loader.abort(); await flushStartup();
    assert.equal(first.calls.abort, 1); assert.equal(f.engine.snapshot().reservationBytes, 0);
  });
}

for (const mutation of ['url', 'sn', 'start', 'mutate-throw', 'clear', 'stop']) {
  test(`startup reachable lookahead cancels reentrant ${mutation} before authority or source`, async t => {
    let changed = false, authAtMutation;
    const { f, first, summary } = await startupReachableReplay(t, 1120, {
      onNext: (ctx, engine) => {
        if (changed || ctx.frag.sn !== 7) return;
        changed = true; authAtMutation = engine.state.authCalls;
        if (mutation === 'clear' || mutation === 'stop') engine.engine[mutation]();
        else if (mutation === 'sn') ctx.frag.sn = 999;
        else if (mutation === 'start') ctx.frag.start += 0.5;
        else {
          ctx.url = ctx.frag.url = 'https://origin.example/media/changed.m4s';
          if (mutation === 'mutate-throw') throw new Error('test callback changed metadata');
        }
      },
    });
    assert(changed, 'the actual parsed lookahead callback was reached');
    assert.equal(f.state.authCalls, authAtMutation, 'changed scope is rejected before authorisation');
    assert.deepEqual(summary.requests, [1, 4]);
    assert.equal(first.calls.success, 0); assert.equal(first.calls.abort, mutation === 'stop' ? 0 : 1,
      'engine stop is intentionally quiet; other cancellations notify the current caller');
    if (mutation !== 'clear' && mutation !== 'stop') assert.equal(f.engine.startupSnapshot().reason, 'context-changed');
    t.mock.timers.tick(20000); await flushStartup();
    assert.equal(f.state.authCalls, authAtMutation); assert.equal(f.requests.length, 2);
    assert.equal(first.calls.success, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
  });
}

test('warm work ownership appears only after authority and reservation with exact fresh descriptors', async t => {
  let authorised, release, reserved = false;
  const f = startupFixture(t, { startup: false, steady: true, permit: ctx => {
    authorised = ctx; assert.equal(ctx[STARTUP_MARKER], undefined);
    return new Promise(resolve => { release = () => resolve({ key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true }); });
  }, reserve: () => { reserved = true; assert.equal(authorised[STARTUP_MARKER], undefined); return true; } });
  t.after(() => release?.());
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  assert.equal(reserved, false); assert.equal(authorised[STARTUP_MARKER], undefined);
  release(); await flushStartup();
  const row = f.requests.find(item => item.context.frag.sn === 1), marker = row.context[STARTUP_MARKER];
  assert.equal(typeof marker.work, 'function');
  const first = marker.work(), second = marker.work();
  assert(first); assert(second); assert.notEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), ['context','deadline','enteredAt','genuine','signal']);
  assert.equal(first.context, row.context); assert.equal(first.signal, second.signal);
  assert.equal(first.signal.aborted, false); assert.equal(first.genuine, null);
  assert.equal(first.deadline - first.enteredAt, 8000); assert(first.enteredAt <= performance.now());
});

test('warm work ownership remains absent for the held original and startup-dependent futures', async t => {
  const f = startupFixture(t, { steady: true });
  f.load(0, 12000); await flushStartup();
  assert.equal(f.requests[0].context[STARTUP_MARKER].work, undefined);
  f.requests[0].finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().state, 'buffering');
  const future = f.requests.find(item => item.context.frag.sn === 1); assert(future);
  assert.equal(future.context[STARTUP_MARKER].work, undefined);
  future.finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().state, 'ready');
  assert.equal(future.context[STARTUP_MARKER].work, undefined, 'startup release cannot retrofit a work owner onto an existing transport');
});

test('warm work ownership preserves original entry and signal across genuine promotion past eight seconds', async t => {
  // Logical clock exercises owner phases only; these values are not elapsed performance evidence.
  t.mock.timers.enable({ apis: ['setTimeout'] }); let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => 25 });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const row = f.requests.find(item => item.context.frag.sn === 1), work = row.context[STARTUP_MARKER].work;
  assert.equal(typeof work, 'function'); const original = work(), originalConfig = row.config;
  clock += 6000; t.mock.timers.tick(6000); const demand = f.load(1, 12000); await flushStartup();
  clock += 2001; t.mock.timers.tick(2001); await flushStartup();
  const promoted = work(); assert(promoted); assert(clock > original.deadline);
  assert.equal(promoted.enteredAt, original.enteredAt); assert.equal(promoted.deadline, original.deadline);
  assert.equal(promoted.signal, original.signal); assert.equal(promoted.context, original.context);
  assert.equal(promoted.genuine.context, demand.context); assert.equal(row.config, originalConfig);
  assert.equal(row.config.loadPolicy.maxLoadTimeMs, 12000); assert.equal(row.aborted, false);
  row.finish(); await flushStartup(); assert.equal(demand.calls.success, 1); assert.equal(work(), null);
});

for (const lateMs of [0, 1]) test(`warm demand at original expiry plus${lateMs}ms cannot revive work before its timer callback`, async t => {
  // Deliberately advance the logical performance clock without dispatching timers.
  t.mock.timers.enable({ apis: ['setTimeout'] }); let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => 25 });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const original = f.requests.find(row => row.context.frag.sn === 1), work = original.context[STARTUP_MARKER].work, captured = work();
  assert(captured); assert.equal(captured.genuine, null);
  clock = captured.deadline + lateMs; assert.equal(work(), null);
  const demand = f.load(1, 12000); await flushStartup();
  assert.equal(original.aborted, true, 'first genuine demand cannot clear an already-expired speculative owner');
  assert.equal(captured.signal.aborted, true); assert.equal(work(), null);
  assert.equal(f.engine.snapshot().promotions, 0); assert.equal(f.engine.snapshot().coalesced, 0);
  const recovery = f.requests.filter(row => row.context.frag.sn === 1).at(-1);
  assert.notEqual(recovery, original); assert.equal(recovery.context, demand.context);
  assert.equal(recovery.config.loadPolicy.maxLoadTimeMs, 12000, 'the genuine load keeps its ordinary new demand parent budget');
  original.finish(true); await flushStartup(); assert.equal(demand.calls.success, 0);
  assert.equal(f.retained.length, 0, 'late old bytes cannot populate reusable warm data');
  recovery.finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(demand.calls.abort, 0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 2);
  assert.equal(f.engine.snapshot().verifiedPeerBytes, 0); assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
});

for (const change of ['url','frag-url','scope','sn','cc','level','start','duration','fragment'])
  test(`warm work ownership rejects changed ${change} identity`, async t => {
    const f = startupFixture(t, { startup: false, steady: true });
    f.load(0, 12000); f.requests[0].finish(); await flushStartup();
    const context = f.requests.find(item => item.context.frag.sn === 1).context, work = context[STARTUP_MARKER].work;
    assert.equal(typeof work, 'function'); assert(work());
    if (change === 'url') context.url += '?changed';
    else if (change === 'frag-url') context.frag.url += '?changed';
    else if (change === 'scope') context.frag.baseurl += '?changed';
    else if (change === 'fragment') context.frag = { ...context.frag };
    else context.frag[change] += 1;
    assert.equal(work(), null);
  });

for (const ending of ['clear','stop','disallowed','cancel','replacement'])
  test(`warm work ownership retires after ${ending}`, async t => {
    const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => 25 });
    f.load(0, 12000); f.requests[0].finish(); await flushStartup();
    const row = f.requests.find(item => item.context.frag.sn === 1), work = row.context[STARTUP_MARKER].work;
    assert.equal(typeof work, 'function'); assert(work());
    if (ending === 'clear') f.engine.clear();
    if (ending === 'stop') f.engine.stop();
    if (ending === 'disallowed') f.state.allowed = false;
    if (ending === 'cancel') { const demand = f.load(1, 12000); demand.loader.abort(); }
    if (ending === 'replacement') f.load(5, 12000);
    assert.equal(work(), null); await flushStartup(); assert.equal(work(), null);
  });

test('warm work ownership cannot survive a paused actual SDK media owner', async t => {
  const f = await fixture(t, { held: [1] });
  await f.load(0).result; await until(() => f.requests.some(row => row.context.frag.sn === 1));
  const work = f.requests.find(row => row.context.frag.sn === 1).context[STARTUP_MARKER].work;
  assert.equal(typeof work, 'function'); assert(work());
  f.media.paused = true; f.media.dispatchEvent(new Event('pause'));
  assert.equal(work(), null);
});

test('warm work ownership remains invalid while a cancelled validator still owns its body', async t => {
  let release; const f = startupFixture(t, { startup: false, steady: true,
    beforeVerify: ctx => ctx.frag.sn === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  t.after(() => release?.());
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const row = f.requests.find(item => item.context.frag.sn === 1), work = row.context[STARTUP_MARKER].work;
  assert.equal(typeof work, 'function'); assert(work()); row.finish(); await flushStartup();
  assert.equal(typeof release, 'function'); f.engine.clear();
  assert.equal(f.engine.snapshot().active, 1); assert.equal(f.engine.snapshot().reservationBytes, 4);
  assert.equal(work(), null); release(); await flushStartup();
  assert.equal(work(), null); assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.retained.length, 0);
});

test('warm work ownership rechecks lifecycle after a reentrant allowed getter', async t => {
  const f = startupFixture(t, { startup: false, steady: true });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const work = f.requests.find(item => item.context.frag.sn === 1).context[STARTUP_MARKER].work;
  assert.equal(typeof work, 'function'); assert(work());
  Object.defineProperty(f.state, 'allowed', { get() { f.engine.clear(); return true; } });
  assert.equal(work(), null);
});

for (const change of ['authorisation', 'reservation']) test(`promoted source headroom is rechecked after ${change} before speculative transport`, async t => {
  let budget = 25, release, changed = false;
  const permit = context => ({ key: context.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true });
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => budget,
    permit: ctx => change === 'authorisation' && ctx.frag.sn === 2 && !changed
      ? new Promise(resolve => { release = () => { changed = true; resolve(permit(ctx)); }; }) : permit(ctx),
    reserve: bytes => { if (change === 'reservation' && bytes === 8 && !changed) { changed = true; budget = 0; } return true; } });
  t.after(() => release?.());
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const original = f.requests.find(row => row.context.frag.sn === 1), demand = f.load(1, 12000);
  await flushStartup();
  if (change === 'authorisation') { assert.equal(typeof release, 'function'); budget = 0; release(); await flushStartup(); }
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  assert.equal(original.aborted, false); assert.equal(f.engine.snapshot().promoted, 1);
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 4);
  const authCalls = f.state.authCalls; await flushStartup(); assert.equal(f.state.authCalls, authCalls, 'denial cannot busy-retry authority');
  original.finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(demand.calls.abort, 0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 2).length, 1, 'genuine completion wakes the deferred future');
});

test('deferred speculation retains its original eight-second expiry on re-admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000, budget = 25, release;
  t.mock.method(performance, 'now', () => clock);
  const permit = ctx => ({ key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true });
  let held = false;
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => budget,
    permit: ctx => ctx.frag.sn === 2 && !held ? new Promise(resolve => { held = true; release = () => resolve(permit(ctx)); }) : permit(ctx) });
  t.after(() => release?.());
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const demand = f.load(1, 12000); await flushStartup();
  clock += 3000; t.mock.timers.tick(3000); budget = 0; release(); await flushStartup();
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  clock += 1000; t.mock.timers.tick(1000); f.requests.find(row => row.context.frag.sn === 1).finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); const deferred = f.requests.find(row => row.context.frag.sn === 2); assert(deferred);
  const work = deferred.context[STARTUP_MARKER].work;
  assert.equal(typeof work, 'function'); assert.equal(work().enteredAt, 1000); assert.equal(work().deadline, 9000);
  clock += 3999; t.mock.timers.tick(3999); await flushStartup(); assert.equal(deferred.aborted, false);
  clock += 1; t.mock.timers.tick(1); await flushStartup(); assert.equal(deferred.aborted, true, 'four seconds spent waiting do not buy a fresh eight seconds');
});

for (const ending of ['clear', 'stop', 'replacement', 'revocation']) test(`deferred speculation cannot revive after ${ending}`, async t => {
  let budget = 25, release;
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => budget,
    permit: ctx => ctx.frag.sn === 2 ? new Promise(resolve => { release = () => resolve(ending === 'revocation' ? null : {
      key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true }); }) : {
      key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true } });
  t.after(() => release?.());
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const original = f.requests.find(row => row.context.frag.sn === 1); f.load(1, 12000); await flushStartup();
  assert.equal(typeof release, 'function');
  if (ending === 'clear') f.engine.clear();
  if (ending === 'stop') f.engine.stop();
  if (ending === 'replacement') f.load(5, 12000);
  if (ending === 'clear' || ending === 'stop') assert.equal(f.engine.snapshot().active, 1, 'the cancelled validator retains its slot until actual settlement');
  budget = 0; release(); await flushStartup();
  original.finish(true); await flushStartup();
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  assert.equal(f.engine.snapshot().reservationBytes, ending === 'revocation' ? 4 : 0);
  if (ending === 'revocation') assert(f.requests.some(row => row.context.frag.sn === 3), 'refusal does not stop a different authorised future');
});

for (const change of ['authorisation', 'reservation']) test(`a candidate promoted during ${change} keeps its genuine parent source`, async t => {
  let budget = 25, release, promote = false, joined, held = false;
  const permit = ctx => ({ key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true });
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => budget,
    permit: ctx => change === 'authorisation' && ctx.frag.sn === 2 && !held ? new Promise(resolve => { held = true; release = () => resolve(permit(ctx)); }) : permit(ctx),
    reserve: bytes => { if (change === 'reservation' && bytes === 8 && promote) { promote = false; budget = 0; joined = f.load(2, 12000); } return true; } });
  t.after(() => release?.());
  f.load(0, 12000); f.requests[0].finish(); await flushStartup(); promote = true;
  f.load(1, 12000); await flushStartup();
  if (change === 'authorisation') { budget = 0; joined = f.load(2, 12000); release(); await flushStartup(); }
  const row = f.requests.find(row => row.context.frag.sn === 2); assert(row, 'the now-genuine candidate must still load');
  assert.equal(row.aborted, false); budget = 25; row.finish(); await flushStartup();
  assert.equal(joined.calls.success, 1); assert.equal(joined.calls.abort, 0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 2).length, 1);
  assert.equal(f.requests.find(row => row.context.frag.sn === 1).aborted, true, 'moving the demanded window retains cancellation of obsoleteSN1');
});

for (const ending of ['clear', 'stop', 'replacement']) test(`promoted headroom callback reentrancy cannot revive work after ${ending}`, async t => {
  let armed = false;
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => {
    if (armed) { armed = false; if (ending === 'clear') f.engine.clear(); if (ending === 'stop') f.engine.stop(); if (ending === 'replacement') f.load(5, 12000); }
    return 25;
  } });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup(); armed = true;
  f.load(1, 12000); await flushStartup();
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  assert.equal(f.engine.snapshot().reservationBytes, 0);
});

for (const ending of ['clear', 'stop', 'replacement']) test(`speculative reservation reentrancy cannot revive work after ${ending}`, async t => {
  let armed = false;
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => 25,
    reserve: size => { if (armed && size === 8) { armed = false; if (ending === 'clear') f.engine.clear(); if (ending === 'stop') f.engine.stop(); if (ending === 'replacement') f.load(5, 12000); } return true; } });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup(); armed = true;
  f.load(1, 12000); await flushStartup();
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  assert.equal(f.engine.snapshot().reservationBytes, 0);
});

test('a live promoted row without a current genuine context cannot admit speculation', async t => {
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => 25 });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  const demand = f.load(1, 12000); demand.context.frag.sn = 9;
  await flushStartup();
  assert.equal(f.requests.some(row => row.context.frag.sn === 2), false);
  assert.equal(f.engine.snapshot().promoted, 1); assert.equal(f.engine.snapshot().active, 0);
});
const requireOriginalVerified = async (f, body, beforeFinish = () => {}) => {
  await flushStartup();
  assert.equal(f.requests.length, 1, 'only the genuine source is admitted before its first verification');
  beforeFinish(f.requests[0]); f.requests[0].finish(false, body); await flushStartup();
  assert(f.engine.snapshot().verified >= 1, 'the actual original body verifies before future completion is driven');
};

test('startup shared source preserves measured recovery while a late-join room clock advances', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0;
  t.mock.method(performance, 'now', () => 1000 + elapsed);
  const bytes = Uint8Array.from({ length: 6 * 1024 * 1024 }, (_, index) => index % 251), digest = sha(bytes);
  const sourceSamples = [], remaining = new Map(), samples = [], completions = [];
  // A controlled shared source, not a replay or an inferred WAN capacity:
  // every active whole GET receives an equal share of3MiB/s. Recovery uses
  // completed source service, with the SDK's unchanged p90*1.25+100 margin.
  const f = startupFixture(t, { timedStats: true, startupMaxBytes: 32 * 1024 * 1024,
    permit: ctx => ({ key: ctx.url, size: bytes.length, sha256: digest, current: () => true }),
    beforeSuccess: (ctx, stats) => {
      sourceSamples.push(stats.loading.end - stats.loading.start);
      const sorted = [...sourceSamples].sort((a, b) => a - b);
      f.state.recovery = Math.max(2000, Math.round(sorted[Math.floor(sorted.length * .9)]) * 1.25 + 100);
      completions.push({ sn: ctx.frag.sn, elapsed, serviceMs: stats.loading.end - stats.loading.start });
    } });
  f.state.target = 2.4;
  const first = f.load(1, 20000);
  await flushStartup();
  const initialActive = f.requests.length;
  while (elapsed < 12000 && !first.calls.success && !first.calls.error) {
    const active = f.requests.filter(row => !row.response && !row.aborted);
    for (const row of active) if (!remaining.has(row)) remaining.set(row, bytes.length);
    const step = 10, allowance = 3 * 1024 * 1024 * step / 1000 / Math.max(1, active.length);
    for (const row of active) remaining.set(row, remaining.get(row) - allowance);
    elapsed += step; f.state.target = 2.4 + elapsed / 1000;
    t.mock.timers.tick(step);
    for (const row of active) if (!row.aborted && remaining.get(row) <= .001) row.finish(false, bytes);
    await flushStartup();
    samples.push({ elapsed, startup: f.engine.startupSnapshot(), warm: f.engine.snapshot() });
  }
  const last = f.engine.startupSnapshot();
  console.log(JSON.stringify({ fixture: 'startup-shared-source', initialActive, elapsed, completions,
    requests: f.requests.map(row => row.context.frag.sn), recoveryMs: f.state.recovery,
    state: last.state, target: last.targetTime, verifiedStart: last.verifiedStart, verifiedEnd: last.verifiedEnd,
    calls: { success: first.calls.success, error: first.calls.error, abort: first.calls.abort } }));
  assert.equal(first.calls.success, 1, 'a bounded source must provide verified contiguous recovery before the original12s deadline');
  assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0); assert(elapsed < 12000);
  assert(last.verifiedEnd - last.targetTime >= last.requiredHeadroomMs / 1000);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[2], first.context);
  assert(samples.every(({ startup, warm }) => startup.heldObjects <= 4 && startup.heldBytes <= 32 * 1024 * 1024 &&
    warm.cacheBytes + warm.reservationBytes <= 24 * 1024 * 1024 && warm.active <= 1));
  assert(f.state.reservations.every(size => size <= 32 * 1024 * 1024));
});

test('startup obsolete-own moving room projects a useful future before freezing its admitted window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0; t.mock.method(performance, 'now', () => 1000 + elapsed);
  const starts = [0, 2, 4, 6, 8, 10.64, 12.64, 14.56, 16.56, 18.56, 20.56];
  const durations = [2, 2, 2, 2, 2.64, 2, 1.92, 2, 2, 2, 2];
  // Captured scalar services for own/SN3/SN5/SN6; every other service is
  // explicitly synthetic. This model does not infer unrequested WAN timings.
  const services = { 1: 3413, 3: 2665, 5: 1953, 6: 2284 };
  const f = startupFixture(t, { timedStats: true, starts, durations });
  f.state.target = 2.137;
  const first = f.load(1, 20000); await flushStartup();
  const samples = [], completions = [];
  while (elapsed < 12000 && !first.calls.success && !first.calls.error) {
    const active = f.requests.find(row => !row.response && !row.aborted);
    const due = active ? active.stats.loading.start - 1000 + (services[active.context.frag.sn] ?? 1000) : Infinity;
    const step = Math.min(10, 12000 - elapsed, Math.max(1, due - elapsed));
    elapsed += step; f.state.target = 2.137 + elapsed / 1000;
    t.mock.timers.tick(step);
    if (active && !active.aborted && elapsed >= due) {
      if (active.context.frag.sn === 1) f.state.recovery = 4367.5;
      completions.push({ sn: active.context.frag.sn, elapsed }); active.finish();
    }
    await flushStartup();
    samples.push({ startup: f.engine.startupSnapshot(), warm: f.engine.snapshot() });
  }
  const future = f.requests[1];
  console.log(JSON.stringify({ fixture: 'obsolete-own-moving-room', requests: f.requests.map(row => row.context.frag.sn),
    completions, elapsed, state: f.engine.startupSnapshot().state, success: first.calls.success }));
  assert(future, 'the bounded poll eventually admits a future');
  const targetAtAdmission = 2.137 + (future.stats.loading.start - 1000) / 1000;
  assert(future.context.frag.start + future.context.frag.duration > targetAtAdmission + 4.3675,
    'a merely-ahead window without actual target coverage must pass recovery before admission');
  assert.equal(first.calls.success, 1, 'this explicitly synthetic completion schedule can release within the original deadline');
  assert(elapsed < 12000); assert.equal(first.calls.error, 0);
  assert(samples.every(({ startup, warm }) => startup.heldObjects <= 4 && startup.heldBytes <= 24 * 1024 * 1024 &&
    warm.active <= 1));
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000);
});

test('startup reservation refusal cannot freeze an unstarted forward window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let refused = false;
  const f = startupFixture(t, { reserve: size => {
    if (!refused && size === 8) { refused = true; f.state.recovery = 8000; return false; }
    return true;
  } });
  f.state.target = 5.5; f.state.recovery = 4367.5;
  const first = f.load(1, 20000); await requireOriginalVerified(f);
  for (let i = 0; i < 12; i++) { t.mock.timers.tick(100); await flushStartup(); }
  assert(refused, 'an otherwise admissible future reaches the shared reservation guard');
  assert.equal(f.requests[1]?.context.frag.sn, 6,
    'the refused [8,10] metadata cannot freeze and admit [10,12] below the new13.5s horizon');
  assert.equal(f.engine.snapshot().rejected, 1); assert.equal(first.calls.success, 0);
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000);
  first.loader.abort(); assert.equal(first.calls.abort, 1);
});

test('startup reservation reentrancy cancels changed identity before future HTTP starts', async t => {
  let first, changed = false;
  const f = startupFixture(t, { reserve: size => {
    if (size === 8) { changed = true; first.context.frag.start += 0.5; }
    return true;
  } });
  first = f.load(0, 12000); await requireOriginalVerified(f); await flushStartup();
  assert(changed, 'the real future reservation callback mutates the original host context');
  assert.equal(f.engine.startupSnapshot().state, 'cancelled');
  assert.equal(f.engine.startupSnapshot().reason, 'context-changed');
  assert.equal(f.requests.length, 1, 'identity cancellation must retire admission before any future source load');
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
  assert.equal(first.calls.success, 0);
});

test('combined startup buffering and steady warming release once then continue parsed futures', async t => {
  const f = startupFixture(t, { steady: true, startupMaxBytes: 32 * 1024 * 1024, reuseBudget: () => 25 });
  let firstAccepted = 0, futureAccepted = 0;
  const first = f.load(0, 20000);
  first.context[STARTUP_MARKER].peerBytes = 4;
  first.context[STARTUP_MARKER].accept = () => { firstAccepted++; };
  await requireOriginalVerified(f);
  assert.equal(first.calls.success, 0); assert.equal(firstAccepted, 0);
  assert.equal(f.engine.startupSnapshot().limits.objects, 4);
  assert.equal(f.engine.startupSnapshot().limits.bytes, 32 * 1024 * 1024);
  assert(f.engine.startupSnapshot().heldObjects <= 4);
  assert(f.engine.startupSnapshot().heldBytes <= 32 * 1024 * 1024);
  const future = f.requests.find(row => row.context.frag.sn === 1);
  future.context[STARTUP_MARKER].peerBytes = 4;
  future.context[STARTUP_MARKER].accept = () => { futureAccepted++; };
  future.finish(); await flushStartup();
  assert.equal(first.calls.success, 1); assert.equal(firstAccepted, 1);
  assert.equal(futureAccepted, 0, 'reservoir verification is not consumption of the future object');
  assert.equal(f.engine.startupSnapshot().state, 'ready');
  assert.equal(f.engine.snapshot().limits.objects, 3);
  assert.equal(f.engine.snapshot().limits.bytes, 24 * 1024 * 1024);
  const cached = f.load(1, 20000); await flushStartup();
  assert.equal(cached.calls.success, 1); assert.equal(first.calls.success, 1);
  assert.equal(futureAccepted, 1); assert.equal(firstAccepted, 1);
  assert.equal(f.engine.snapshot().consumedPeerBytes, 8);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
  const next = f.requests.find(row => row.context.frag.sn === 2); assert(next);
  next.finish(); await flushStartup();
  const continuation = f.requests.find(row => row.context.frag.sn === 3);
  assert(continuation, 'the real next parsed window continues after startup instead of one-shot shutdown');
  assert(f.engine.snapshot().trackedObjects <= 3);
  assert(f.engine.snapshot().cacheBytes + f.engine.snapshot().reservationBytes <= 24 * 1024 * 1024);
  // The SDK pause handler invalidates the warm scope through this same clear.
  f.state.allowed = false; f.engine.clear(); await flushStartup();
  assert(continuation.aborted); assert.equal(f.engine.snapshot().cacheBytes, 0);
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
  assert.equal(first.calls.success, 1); assert.equal(cached.calls.success, 1);
});

test('startup future HTTP waits for genuine whole verification and wakes without a new timer', async t => {
  let release;
  const f = startupFixture(t, { beforeVerify: ctx => ctx.frag.sn === 0
    ? new Promise(resolve => { release = resolve; }) : undefined });
  const first = f.load(0, 12000);
  await flushStartup();
  assert.equal(f.requests.length, 1);
  f.requests[0].finish(); await flushStartup();
  assert.equal(typeof release, 'function');
  assert.equal(f.requests.length, 1, 'a complete but still-unverified first body cannot start future HTTP');
  assert.equal(first.calls.success, 0);
  release(); await flushStartup();
  assert.equal(f.requests.length, 2, 'verification completion unblocks the existing admission pump');
  assert.equal(f.requests[1].context.frag.sn, 1);
  f.requests[1].finish(); await flushStartup();
  assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
});

test('startup preserves its verified genuine prefix while the unpublished room clock is frozen', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000;
  t.mock.method(performance, 'now', () => clock);
  const sourceSamples = [];
  const f = startupFixture(t, { timedStats: true, beforeSuccess: (_ctx, stats) => {
    sourceSamples.push(stats.loading.end - stats.loading.start);
    const sorted = [...sourceSamples].sort((a, b) => a - b);
    f.state.recovery = Math.max(2000, Math.round(sorted[Math.floor(sorted.length * .9)]) * 1.25 + 100);
  } });
  f.state.target = .02;
  const first = f.load(0, 20000); await flushStartup();
  clock += 4000; t.mock.timers.tick(4000); f.requests[0].finish(); await flushStartup();
  assert.equal(f.state.recovery, 5100);
  assert.equal(first.calls.success, 0);
  assert.equal(f.requests[1]?.context.frag.sn, 1, 'the verified demanded[0,2] must retain its contiguous[2,4] successor');
  for (const index of [1, 2]) {
    clock += 2000; t.mock.timers.tick(2000); f.requests[index].finish(); await flushStartup();
  }
  const snapshot = f.engine.startupSnapshot();
  assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
  assert.equal(snapshot.verifiedStart, 0); assert.equal(snapshot.verifiedEnd, 6);
  assert(snapshot.verifiedEnd - snapshot.targetTime >= snapshot.requiredHeadroomMs / 1000);
  assert.equal(snapshot.requiredHeadroomMs, 5100); assert.equal(snapshot.limits.deadlineMs, 12000);
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2]);
});

test('startup admits one extra verified contiguous future only when dynamic recovery exceeds its full three-object window', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const firstSn of [0, 5]) {
    let commits = 0;
    const f = startupFixture(t, { commit: () => { commits++; } });
    f.state.target = firstSn * 2;
    const first = f.load(firstSn, 8000); f.state.recovery = 6550;
    await requireOriginalVerified(f);
    f.requests[1].finish(); await flushStartup();
    f.requests[2].finish(); await flushStartup();
    t.mock.timers.tick(100); await flushStartup();
    assert.equal(f.requests.length, 4, 'verified six-second coverage must admit its parsed contiguous successor');
    assert.equal(f.requests[3].context.frag.sn, firstSn + 3);
    assert.equal(f.engine.snapshot().active, 1); assert.equal(first.calls.success, 0); assert.equal(commits, 0);
    assert.equal(f.engine.startupSnapshot().heldObjects, 4);
    assert.equal(f.engine.startupSnapshot().limits.objects, 4);
    assert.equal(f.engine.snapshot().limits.objects, 4);
    assert.equal(f.engine.contains(firstSn * 2), true, 'the expanded parsed plan retains the pending first interval');
    f.requests[3].finish(); await flushStartup();
    assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0); assert.equal(commits, 1);
    assert.equal(f.engine.startupSnapshot().verifiedEnd, firstSn * 2 + 8);
    assert.equal(f.requests.length, 4, 'no fifth request is needed');
    assert.equal(f.engine.snapshot().limits.objects, 3, 'steady warm resource contract stays unchanged');
    assert.equal(f.engine.contains(firstSn * 2), true, 'the third future remains in the retained initial-seek plan after release');
    const reuse = f.load(firstSn + 3); await flushStartup();
    assert.equal(reuse.calls.success, 1); assert.equal(f.engine.snapshot().localReuseBytes, 4);
    assert.equal(f.requests.length, 5, 'normal reuse still starts its existing recovery request');
    assert.equal(f.requests[4].aborted, true); assert.equal(f.requests[4].response, undefined);
    assert.equal(f.requests.filter(row => row.context.frag.sn === firstSn + 3 && row.response).length, 1,
      'the fourth verified body is reused without a second completed response');
    assert.ok(f.state.reservations.every(size => size <= 24 * 1024 * 1024));
    f.engine.stop();
  }
});

test('startup expansion leaves a sufficient window unchanged and never admits a fifth held object', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const recovery of [6000, 9000]) {
    const f = startupFixture(t); f.state.target = 0; f.state.recovery = recovery;
    const first = f.load(0, 8000); await requireOriginalVerified(f);
    f.requests[1].finish(); await flushStartup(); f.requests[2].finish(); await flushStartup();
    t.mock.timers.tick(100); await flushStartup();
    if (recovery === 6000) {
      assert.equal(first.calls.success, 1); assert.equal(f.requests.length, 3, 'do not expand an adequate verified window');
    } else {
      assert.equal(f.requests.length, 4); f.requests[3].finish(); await flushStartup();
      t.mock.timers.tick(7800); await flushStartup();
      assert.equal(f.requests.length, 4); assert.equal(f.engine.startupSnapshot().heldObjects, 4);
      assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 0);
      t.mock.timers.tick(100); await flushStartup();
      assert.equal(first.calls.error, 1); assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
    }
    f.engine.stop();
  }
});

test('startup expansion keeps cancellation, context, authority and original parent deadline ownership', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['abort', 'clear', 'stop', 'scope', 'geometry', 'cc', 'authority', 'corrupt', 'deadline']) {
    let commits = 0;
    const f = startupFixture(t, { commit: () => { commits++; }, permit: ctx => {
      // Match the SDK's full immutable context-bound authority, rather than
      // the fixture's default URL-only permit (which does not bind CC).
      const key = warmContext(ctx)?.key, sn = ctx.frag.sn;
      return { key, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)),
        current: value => warmContext(value)?.key === key && !f.state.revoked.has(sn) };
    } }); f.state.target = 0;
    const first = f.load(0, 500); f.state.recovery = 6550; await requireOriginalVerified(f);
    f.requests[1].finish(); await flushStartup(); f.requests[2].finish(); await flushStartup();
    t.mock.timers.tick(100); await flushStartup();
    assert.equal(f.requests.length, 4); const fourth = f.requests[3];
    if (action === 'abort') first.loader.abort();
    else if (action === 'clear') f.engine.clear();
    else if (action === 'stop') f.engine.stop();
    else if (action === 'scope') fourth.context.frag.baseurl += '?changed';
    else if (action === 'geometry') fourth.context.frag.start += 0.25;
    else if (action === 'cc') fourth.context.frag.cc++;
    else if (action === 'authority') f.state.revoked.add(3);
    if (['scope', 'geometry'].includes(action)) { t.mock.timers.tick(100); await flushStartup(); }
    if (['cc', 'authority', 'corrupt'].includes(action)) fourth.finish(false, action === 'corrupt' ? Uint8Array.of(9, 8, 7, 6) : undefined);
    await flushStartup();
    t.mock.timers.tick(399 - (['scope', 'geometry'].includes(action) ? 100 : 0)); await flushStartup();
    if (action === 'deadline') assert.equal(first.calls.error, 0);
    t.mock.timers.tick(1); await flushStartup();
    assert.equal(first.calls.success, 0, action); assert.equal(commits, 0, action);
    assert.equal(first.calls.error + first.calls.abort, action === 'stop' ? 0 : 1, action);
    if (action === 'deadline') assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
    assert.equal(f.engine.snapshot().cacheBytes, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
    const terminals = first.calls.error + first.calls.abort;
    fourth.finish(true); await flushStartup();
    assert.equal(first.calls.error + first.calls.abort, terminals); assert.equal(first.calls.success, 0);
    assert.equal(f.requests.length, 4, 'late completion cannot restart the retired plan');
    f.engine.stop();
  }
});

test('startup byte budget also rejects unbounded direct helper configuration', () => {
  for (const value of [null, NaN, Infinity, 24 * 1024 * 1024 - 1, 32 * 1024 * 1024 + 1, 24 * 1024 * 1024 + 0.5])
    assert.throws(() => createWarmAhead({ Loader: class {}, startupTarget: () => 0, startupMaxBytes: value }), RangeError);
  assert.throws(() => createWarmAhead({ Loader: class {}, startupMaxBytes: 32 * 1024 * 1024 }), RangeError);
});

test('startup byte budget validates its explicit range and requires startup for a nondefault allowance', async t => {
  const lower = 24 * 1024 * 1024, upper = 32 * 1024 * 1024;
  for (const value of [null, false, true, NaN, Infinity, lower - 1, upper + 1, lower + 0.5, String(upper), {}, Number.MAX_SAFE_INTEGER]) {
    const f = await fixture(t, { enabled: false, startupTarget: () => 0, startupMaxBytes: value });
    assert.equal(f.swarm.metrics().disabledReason, 'invalid-startup-buffer-max-bytes', String(value));
  }
  const absent = await fixture(t, { enabled: false, startupMaxBytes: upper });
  assert.equal(absent.swarm.metrics().disabledReason, 'invalid-startup-buffer-max-bytes');
  for (const value of [lower, lower + 1, upper]) {
    const f = await fixture(t, { enabled: false, startupTarget: () => 0, startupMaxBytes: value });
    assert.equal(f.swarm.metrics().disabledReason, null);
    assert.equal(f.swarm.metrics().startupBuffer.limits.bytes, value);
  }
  const ordinary = await fixture(t, { enabled: false });
  assert.equal(ordinary.swarm.metrics().disabledReason, null); assert.equal(ordinary.swarm.metrics().startupBuffer, null);
});

test('startup byte budget reserves its chosen allowance against the host cache before first HTTP', async t => {
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3,
    startupMaxBytes: 32 * 1024 * 1024, maxHeldBytes: 24 * 1024 * 1024 });
  const first = f.load(0);
  await assert.rejects(first.result, error => error.startupBufferReason === 'reservation-refused');
  assert.equal(f.requests.length, 0); assert.equal(first.calls.error, 1); assert.equal(first.calls.success, 0);
});

test('startup byte budget keeps future cache and in-flight reservations within24MiB under a32MiB aggregate', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const bodies = new Map([[0, Uint8Array.of(2, 4, 6, 8)], [1, new Uint8Array(8 * 1024 * 1024)],
    [2, new Uint8Array(8 * 1024 * 1024)], [3, new Uint8Array(9 * 1024 * 1024)]]);
  const hashes = new Map([...bodies].map(([sn, body]) => [sn, sha(body)]));
  const f = startupFixture(t, { startupMaxBytes: 32 * 1024 * 1024,
    permit: ctx => ({ key: ctx.url, size: bodies.get(ctx.frag.sn)?.length ?? 4,
      sha256: hashes.get(ctx.frag.sn), current: () => true }) });
  const first = f.load(0, 8000); f.state.recovery = 3627.5; await requireOriginalVerified(f);
  f.requests[1].finish(false, bodies.get(1)); await flushStartup();
  f.state.target = 3.885;
  f.requests[2].finish(false, bodies.get(2)); await flushStartup();
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.engine.snapshot().rejected, 1, '25MiB of futures is refused even though the aggregate fits32MiB');
  assert.equal(f.requests.length, 3); assert.equal(f.engine.snapshot().active, 0);
  assert.equal(f.engine.snapshot().cacheBytes, 16 * 1024 * 1024);
  assert.equal(f.engine.startupSnapshot().heldBytes, 16 * 1024 * 1024 + 4);
  assert.equal(first.calls.success, 0); first.loader.abort(); assert.equal(first.calls.abort, 1);
});

test('startup byte budget keeps the original cancellation, deadline and individual-object bounds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const ending of ['abort', 'deadline', 'oversized']) {
    const f = startupFixture(t, { startupMaxBytes: 32 * 1024 * 1024,
      ...(ending === 'oversized' ? { permitSize: () => 24 * 1024 * 1024 + 1 } : {}) });
    const first = f.load(0, 200); await flushStartup();
    if (ending !== 'oversized') f.requests[0].finish(); await flushStartup();
    if (ending === 'abort') first.loader.abort();
    else if (ending === 'deadline') { t.mock.timers.tick(200); await flushStartup(); }
    assert.equal(first.calls.success, 0); assert.equal(first.calls.abort, ending === 'abort' ? 1 : 0);
    assert.equal(first.calls.error, ending === 'abort' ? 0 : 1);
    if (ending !== 'abort') assert.equal(first.calls.args[0].startupBufferReason,
      ending === 'deadline' ? 'deadline' : 'first-authority-refused');
    for (const row of f.requests) row.finish(true); await flushStartup();
    assert.equal(first.calls.abort + first.calls.error, 1); assert.equal(first.calls.success, 0);
  }
});

test('startup byte budget admits the pinned 4K original plus three contiguous futures only with the opted allowance', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sizes = new Map([[0, 6471966], [3, 6060338], [4, 8604060], [5, 6059257]]);
  const bodies = new Map([...sizes].map(([sn, size]) => [sn, new Uint8Array(size).fill(sn)]));
  const hashes = new Map([...bodies].map(([sn, body]) => [sn, sha(body)]));
  for (const opted of [false, true]) {
    const f = startupFixture(t, { startupMaxBytes: opted ? 32 * 1024 * 1024 : undefined,
      starts: [0, 2, 4, 6, 8, 10.64, 12.64], durations: [2, 2, 2, 2, 2.64, 2, 2],
      permit: ctx => ({ key: ctx.url, size: sizes.get(ctx.frag.sn) ?? 4,
        sha256: hashes.get(ctx.frag.sn) ?? sha(Uint8Array.of(2, 4, 6, 8)), current: () => true }) });
    f.state.target = 3.1; f.state.recovery = 4587.5;
    const first = f.load(0, 12000); await requireOriginalVerified(f, bodies.get(0));
    for (let i = 0; i < 3; i++) { t.mock.timers.tick(100); await flushStartup(); }
    assert.equal(f.requests[1].context.frag.sn, 3);
    f.requests[1].finish(false, bodies.get(3)); await flushStartup();
    assert.equal(f.requests[2].context.frag.sn, 4);
    f.requests[2].finish(false, bodies.get(4)); await flushStartup();
    f.state.target = 7.459;
    t.mock.timers.tick(100); await flushStartup();
    if (!opted) {
      assert.equal(f.requests.length, 3); assert.equal(f.engine.snapshot().rejected, 1);
      assert.equal(first.calls.success, 0); first.loader.abort(); assert.equal(first.calls.abort, 1);
      continue;
    }
    assert.equal(f.requests[3]?.context.frag.sn, 5, '27,195,621 bytes fit the chosen32MiB aggregate');
    assert.equal(f.engine.startupSnapshot().heldBytes, 27195621);
    assert.equal(f.engine.startupSnapshot().limits.bytes, 32 * 1024 * 1024);
    assert.equal(f.engine.startupSnapshot().limits.futureBytes, 24 * 1024 * 1024);
    assert.equal(f.state.reservations[0], 32 * 1024 * 1024, 'chosen worst case is reserved before first HTTP');
    f.requests[3].finish(false, bodies.get(5)); await flushStartup();
    assert.equal(first.calls.success, 1); assert.equal(first.calls.abort, 0); assert.equal(first.calls.error, 0);
    assert.equal(first.calls.args[0], f.requests[0].response); assert.equal(first.calls.args[1], f.requests[0].stats);
    assert.equal(first.calls.args[2], first.context);
    assert.equal(f.engine.snapshot().limits.bytes, 24 * 1024 * 1024);
    assert.equal(f.engine.snapshot().cacheBytes, 20723655);
    assert.equal(f.engine.startupSnapshot().requiredHeadroomMs, 4587.5);
  }
});

test('startup extra-future admission refuses the same 24MiB byte cap without a source request or unsafe release', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t, { permitSize: sn => sn === 3 ? 24 * 1024 * 1024 : 4 });
  f.state.target = 0; f.state.recovery = 6550; const first = f.load(0, 8000); await requireOriginalVerified(f);
  f.requests[1].finish(); await flushStartup(); f.requests[2].finish(); await flushStartup();
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.engine.snapshot().rejected, 1, 'the additional signed size exceeds remaining shared bytes');
  assert.equal(f.requests.length, 3); assert.equal(first.calls.success, 0);
  assert.equal(f.engine.snapshot().active, 0); assert.ok(f.engine.snapshot().trackedObjects <= 4);
  t.mock.timers.tick(8000); await flushStartup();
  assert.equal(first.calls.error, 1); assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
  assert.equal(f.engine.snapshot().cacheBytes, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
});

test('startup expansion uses fresh moved targets during its request and final authority wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const duringAuthority of [false, true]) {
    let commits = 0;
    const f = startupFixture(t, { commit: () => { commits++; } }); f.state.target = 0;
    const first = f.load(0, 500); f.state.recovery = 6550; await requireOriginalVerified(f);
    f.requests[1].finish(); await flushStartup(); f.requests[2].finish(); await flushStartup();
    t.mock.timers.tick(100); await flushStartup();
    assert.equal(f.requests.length, 4); assert.equal(f.engine.contains(0), true);
    if (duringAuthority) {
      f.state.holdRecheck = true; f.state.holdCheckSn = 3;
      f.requests[3].finish(); await flushStartup();
      assert.equal(typeof f.state.releaseRecheck, 'function');
      f.state.target = 1.5; f.state.releaseRecheck(); await flushStartup();
    } else {
      f.state.target = 1.4; f.requests[3].finish(); await flushStartup();
    }
    assert.equal(first.calls.success, duringAuthority ? 0 : 1);
    assert.equal(commits, duringAuthority ? 0 : 1);
    if (!duringAuthority) assert.equal(first.calls.args[0], f.requests[0].response, 'release preserves the original held response');
    assert.equal(first.context, f.requests[0].context, 'the original held response keeps its caller context');
    if (duringAuthority) {
      assert.equal(f.engine.contains(0), true);
      t.mock.timers.tick(400); await flushStartup();
      assert.equal(first.calls.error, 1); assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
      assert.equal(f.requests.length, 4, 'an infeasible moving target does not admit a fifth held object');
    }
    f.engine.stop();
  }
});

const fillStartupWindow = async (f, beforeFinish = () => {}) => {
  // Verify the genuine first body before future HTTP, then form the same
  // controlled deficit without any early Hls callback or admission bypass.
  f.state.recovery = 2762.5;
  await requireOriginalVerified(f, undefined, beforeFinish);
  beforeFinish(f.requests[1]); f.requests[1].finish(); await flushStartup();
  f.state.target = 3.885; f.state.recovery = 2762.5;
  beforeFinish(f.requests[2]); f.requests[2].finish(); await flushStartup();
};

test('startup service lead plans beyond measured retrieval cost in the sourceSN2 offset replay', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 10000, elapsed = 0; t.mock.method(performance, 'now', () => clock);
  const f = startupFixture(t, { timedStats: true,
    starts: [0, 2, 0, 2, 4, 6.64, 8.64, 10.56], durations: [2, 2, 2, 2, 2.64, 2, 1.92, 2] });
  f.state.target = .02; const first = f.load(2, 8000), samples = [];
  const advance = async ms => {
    for (let left = ms; left > 0;) {
      const step = Math.min(100, left); elapsed += step; left -= step; clock += step;
      f.state.target = .02 + elapsed / 1000; t.mock.timers.tick(step); await flushStartup();
      samples.push(f.engine.startupSnapshot().planningServiceMs);
    }
  };
  await requireOriginalVerified(f);
  await advance(2636);
  await advance(607); f.requests[1].finish(); await flushStartup();
  // Raw times are offset from actual sourceSN2, whose programme start is4s.
  // Successful stats below model the observed cancelled-HTTP cadence; those
  // HTTP timings were NOT captured peer-loader stats. SN6's full completion
  // was unknown, so2000ms is an explicit controlled completion for BOTH paths.
  const cadence = { 4: 2059, 5: 1449, 6: 2000, 7: 2000 };
  samples.push(f.engine.startupSnapshot().planningServiceMs);
  while (!first.calls.success && !first.calls.error && elapsed < 8000) {
    const row = f.requests.find(row => row.context.frag.sn >= 4 && !row.response && !row.aborted);
    if (!row) { await advance(Math.min(100, 8000 - elapsed)); continue; }
    await advance(Math.min(cadence[row.context.frag.sn] ?? 2000, 8000 - elapsed));
    if (!first.calls.error) { row.finish(); await flushStartup(); }
    assert.ok(f.engine.startupSnapshot().heldObjects <= 3);
    assert.ok(f.engine.snapshot().active <= 1);
  }
  assert.equal(first.calls.success, 1, 'planning must account for verified future retrieval cost before the unchanged8s deadline');
  assert.equal(first.calls.error, 0); assert.ok(elapsed < 8000);
  assert.ok(samples.includes(3243));
  assert.ok(!f.requests.some(row => row.context.frag.sn === 4), 'unrequested raw[4,6.64] is too short after3.243s measured service');
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert.equal(f.engine.startupSnapshot().requiredHeadroomMs, 2000, 'service lead never becomes release recovery');
  assert.ok(f.engine.startupSnapshot().verifiedEnd - f.state.target >= 2);
  assert.equal(f.engine.startupSnapshot().planningServiceMs, null, 'active timing sample retires on terminal success');
});

test('startup service lead accepts a verified50ms future without a rate floor or slow-path baseline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000; t.mock.method(performance, 'now', () => clock);
  const f = startupFixture(t, { timedStats: true }), first = f.load(0, 8000); await requireOriginalVerified(f);
  f.state.target = 3.9;
  clock += 50; f.requests[1].finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().planningServiceMs, 50);
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2]);
  clock += 50; f.requests[2].finish(); await flushStartup();
  clock += 10;
  assert.equal(first.calls.success, 1);
  assert.equal(f.engine.startupSnapshot().requiredHeadroomMs, 2000);
});

test('startup service lead ignores unknown, invalid and foreign-operation timestamps', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000; t.mock.method(performance, 'now', () => clock);
  for (const bad of ['missing', 'negative', 'zero', 'future', 'stale', 'nan', 'aborted', 'partial']) {
    const f = startupFixture(t, { timedStats: true, beforeSuccess: (ctx, stats) => {
      if (ctx.frag.sn !== 1) return;
      if (bad === 'missing') delete stats.loading;
      if (bad === 'negative') stats.loading.end = stats.loading.start - 1;
      if (bad === 'zero') stats.loading.end = stats.loading.start;
      if (bad === 'future') stats.loading.end = clock + 1;
      if (bad === 'stale') stats.loading.start -= 1;
      if (bad === 'nan') stats.loading.end = NaN;
      if (bad === 'aborted') stats.aborted = true;
      if (bad === 'partial') stats.loaded--;
    } }), first = f.load(0, 8000); await requireOriginalVerified(f);
    f.state.target = 3.9; clock += 50; f.requests[1].finish(); await flushStartup();
    assert.equal(f.engine.startupSnapshot().planningServiceMs, null, bad);
    assert.equal(first.calls.success, 0, bad);
    assert.equal(f.requests[2]?.context.frag.sn, 2, 'unknown timing adds no invented delay');
    f.engine.stop();
  }
});

test('startup service lead snapshots scalar timing before stats mutation during verification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000, release; t.mock.method(performance, 'now', () => clock); t.after(() => release?.());
  const f = startupFixture(t, { timedStats: true,
    beforeVerify: ctx => ctx.frag.sn === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  const first = f.load(0, 8000); await requireOriginalVerified(f); f.state.target = 3.9;
  clock += 50; f.requests[1].finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().planningServiceMs, null);
  Object.assign(f.requests[1].stats, { aborted: true, loaded: 0, loading: { start: -1, end: 999999 } });
  clock += 20; release(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().planningServiceMs, 50, 'no stats object or mutable interval is retained');
  assert.equal(first.calls.success, 0);
});

test('startup service lead learns nothing from corrupt or cancelled pending verification', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000; t.mock.method(performance, 'now', () => clock);
  for (const action of ['corrupt', 'abort', 'clear']) {
    let release; t.after(() => release?.());
    const f = startupFixture(t, { timedStats: true,
      beforeVerify: ctx => action !== 'corrupt' && ctx.frag.sn === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
    const first = f.load(0, 8000); await requireOriginalVerified(f); f.state.target = 3.9;
    clock += 50;
    f.requests[1].finish(false, action === 'corrupt' ? Uint8Array.of(9, 8, 7, 6) : undefined); await flushStartup();
    if (action === 'abort') first.loader.abort();
    if (action === 'clear') f.engine.clear();
    release?.(); await flushStartup();
    assert.equal(f.engine.startupSnapshot().planningServiceMs, null, action);
    assert.equal(first.calls.success, 0, action);
    assert.equal(f.engine.snapshot().consumedPeerBytes, 0, action);
    f.engine.stop();
  }
});

test('startup service lead retains a contiguous fourth-slot extension after the target reaches its verified prefix', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000; t.mock.method(performance, 'now', () => clock);
  const f = startupFixture(t, { timedStats: true }), first = f.load(0, 8000);
  f.state.recovery = 3627.5; await requireOriginalVerified(f);
  // Futures begin after the genuine verifier. Their measured service is a
  // planning sample, not a minimum cost imposed on the next object.
  clock += 2100; f.requests[1].finish(); await flushStartup();
  f.state.target = 3.885;
  clock += 2100; f.requests[2].finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().planningServiceMs, 2100);
  assert.equal(first.calls.success, 0);
  clock += 100; t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[3]?.context.frag.sn, 3, 'extend verified [2,6] with [6,8] instead of skipping its successor');
  assert.equal(f.engine.startupSnapshot().heldObjects, 4);
  clock += 50; f.state.target += 0.05; f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 1); assert.equal(first.calls.abort, 0); assert.equal(first.calls.error, 0);
  assert.equal(first.calls.args[0], f.requests[0].response);
  assert.equal(first.calls.args[1], f.requests[0].stats); assert.equal(first.calls.args[2], first.context);
  assert.equal(f.engine.startupSnapshot().requiredHeadroomMs, 3627.5);
  assert.equal(f.engine.startupSnapshot().limits.objects, 4);
  assert.ok(f.engine.startupSnapshot().verifiedEnd - f.state.target >= 3.6275);
});

test('startup service lead changes cannot move an already selected forward start', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000; t.mock.method(performance, 'now', () => clock);
  // Scalar service lead only; the size-aware profile path has its own replays.
  const f = startupFixture(t, { timedStats: true, firstByteMs: null, starts: [0, 2, 4, 5, 6, 9], durations: [2, 2, 1, 1, 3, 2] });
  const first = f.load(0, 8000); await requireOriginalVerified(f); f.state.target = 2.3; f.state.recovery = 3500;
  clock += 50; f.requests[1].finish(); await flushStartup();
  clock += 100; t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[2]?.context.frag.sn, 3);
  clock += 500; f.requests[2].finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().planningServiceMs, 500);
  clock += 100; t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[3]?.context.frag.sn, 4, 'changed service fills contiguous[6,9] rather than selecting a later start');
  assert.equal(first.calls.success, 0);
});

// Size-aware startup admission. Field geometry is the retained 4K programme's
// real fragment sizes and timing. Only SN1/SN4/SN6 service times were measured
// on the viewer; every other service below is HYPOTHETICAL and named as such.
const FIELD_STARTS = [0, 2, 4, 6, 8, 10.64, 12.64, 14.56, 16.56, 18.56, 20.56, 22.56];
const FIELD_DURATIONS = [2, 2, 2, 2, 2.64, 2, 1.92, 2, 2, 2, 2, 2];
const FIELD_SIZES = [6471966, 6074938, 5723873, 6060338, 8604060, 6059257, 5735496, 6231822, 6026326, 6058936, 6206410, 6145869];
const MIB = 1024 * 1024;
const fieldBodies = new Map();
const fieldBody = size => {
  if (!fieldBodies.has(size)) { const body = new Uint8Array(size); fieldBodies.set(size, { body, digest: sha(body) }); }
  return fieldBodies.get(size);
};
// Math.max(2000, p90 * 1.25 + 100), p90 at floor(0.9 * n), rounded.
const fieldRecovery = services => {
  const sorted = [...services].sort((a, b) => a - b);
  return Math.max(2000, Math.round(sorted[Math.floor(0.9 * sorted.length)] * 1.25 + 100));
};

// Logical-clock replay of the field geometry. `services(sn)` returns the
// scheduled total service time in whole milliseconds for each request; the
// loader reports `firstByteMs` as its first-byte delay (null: no first byte).
async function sizeAwareReplay(t, { firstByteMs, services, target = 2.1, ownSn = 1, parentMs = 120000 }) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0; t.mock.method(performance, 'now', () => 1000 + elapsed);
  const authLog = [], samples = [], completions = [], recoveries = [], served = [];
  const f = startupFixture(t, { timedStats: true, firstByteMs, starts: FIELD_STARTS, durations: FIELD_DURATIONS,
    startupMaxBytes: 32 * MIB,
    permit: ctx => {
      const sn = ctx.frag.sn, size = FIELD_SIZES[sn];
      authLog.push({ sn, elapsed });
      return { key: ctx.url, size, sha256: fieldBody(size).digest, current: () => !f.state.revoked.has(sn) };
    } });
  f.state.target = target;
  const first = f.load(ownSn, parentMs); await flushStartup();
  let releaseAt = null;
  while (elapsed < 12000 && !first.calls.success && !first.calls.error && !first.calls.abort) {
    const active = f.requests.find(row => !row.response && !row.aborted);
    const sn = active?.context.frag.sn;
    if (active) assert(sn < FIELD_SIZES.length, `request beyond the retained programme: SN${sn}`);
    const service = active ? services(sn) : null;
    const due = active ? active.stats.loading.start - 1000 + service : Infinity;
    const step = Math.min(10, 12000 - elapsed, Math.max(1, due - elapsed));
    elapsed += step; f.state.target = target + elapsed / 1000;
    t.mock.timers.tick(step);
    if (active && !active.aborted && elapsed >= due) {
      served.push(service); f.state.recovery = fieldRecovery(served); recoveries.push(f.state.recovery);
      completions.push({ sn, elapsed, serviceMs: service });
      releaseAt = authLog.length;
      active.finish(false, fieldBody(FIELD_SIZES[sn]).body);
    }
    await flushStartup();
    samples.push({ elapsed, target: f.state.target, startup: f.engine.startupSnapshot(), warm: f.engine.snapshot() });
  }
  const requests = f.requests.map(row => row.context.frag.sn);
  const authorised = [...new Set(authLog.map(entry => entry.sn))];
  const skipped = authorised.filter(sn => !requests.includes(sn));
  const summary = { elapsed, requests, skipped, completions, recoveryMs: f.state.recovery,
    calls: { success: first.calls.success, error: first.calls.error, abort: first.calls.abort },
    authCalls: f.state.authCalls, startup: f.engine.startupSnapshot() };
  if (!first.calls.success) releaseAt = null; // no final validation without a release
  return { f, first, samples, completions, recoveries, authLog, releaseAt, summary, elapsed, requests, skipped };
}
// Gates no scenario may weaken.
const assertStartupGates = ({ f, first, samples, recoveries, elapsed }) => {
  assert(samples.every(({ startup, warm }) => startup.heldObjects <= 4 && startup.heldBytes <= 32 * MIB && warm.active <= 1),
    'held objects, held bytes and active requests stay inside their startup bounds');
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000, 'the original deadline is unchanged');
  assert(elapsed <= 12000);
  assert(recoveries.every((value, i) => i === 0 || value >= recoveries[i - 1]), 'recovery is never reduced');
  assert.equal(f.state.recovery, recoveries.at(-1) ?? 2000);
  if (first.calls.success === 1) {
    const ready = f.engine.startupSnapshot();
    assert(elapsed < 12000, 'release precedes the original deadline');
    assert(ready.verifiedStart <= f.state.target && f.state.target < ready.verifiedEnd, 'release covers the actual room target');
    assert((ready.verifiedEnd - f.state.target) * 1000 >= f.state.recovery, 'release keeps the full measured recovery');
  } else {
    assert.equal(first.calls.success, 0);
    assert.equal(f.engine.startupSnapshot().reason, 'deadline');
  }
};

test('size-aware startup replays the measured viewer order under legacy scalar planning', async t => {
  // SN7 is HYPOTHETICAL: 2514 ms is the measured partial pace, not an observed SN7 service.
  const measured = { 1: 2585, 4: 4314, 6: 2371, 7: 2514 };
  const r = await sizeAwareReplay(t, { firstByteMs: null, services: sn => {
    assert(sn in measured, `unexpected request SN${sn}`); return measured[sn]; } });
  console.log(JSON.stringify({ fixture: 'size-aware-startup-legacy-replay', hypotheticalSn7ServiceMs: 2514, ...r.summary }));
  assert.deepEqual(r.requests, [1, 4, 6, 7]);
  assert.equal(r.first.calls.success, 0); assert.equal(r.first.calls.error, 1);
  assert.equal(r.elapsed, 12000);
  assert.equal(r.f.engine.startupSnapshot().reason, 'deadline');
  assert.equal(r.f.engine.startupSnapshot().requiredHeadroomMs, 5493,
    'p90 of 2585/4314 is 4314 ms; 4314 * 1.25 + 100 = 5492.5 rounds to 5493');
  assert(r.samples.every(({ startup }) => startup.sourceProfile === null), 'no first-byte timing forms no profile');
  assertStartupGates(r);
});

// Authorisation accounting. During admission each requested future is
// authorised once; a skipped candidate costs at most one extra re-authorisation
// (a hold). Everything after the last completion is the final validation of the
// held coverage.
const assertAuthAccounting = ({ f, authLog, releaseAt, requests, skipped }) => {
  const admission = authLog.slice(0, releaseAt ?? authLog.length), validation = authLog.slice(releaseAt ?? authLog.length);
  for (const sn of requests) assert.equal(admission.filter(entry => entry.sn === sn).length, 1, `SN${sn} authorised once for admission`);
  for (const sn of skipped) assert(admission.filter(entry => entry.sn === sn).length <= 2, `SN${sn} skipped with at most one hold`);
  assert(validation.length <= 4, 'final validation authorises the original and at most three held futures');
  assert.equal(f.state.authCalls, authLog.length);
  return { admission: admission.length, validation: validation.length };
};

test('size-aware startup selects the smaller reachable futures from measured first-byte and body timing', async t => {
  // SN1 is measured (2585 ms; its 260 ms TTFB is responseAtWallMs minus the
  // request start in viewer-1-origin-capture.json). The same 260 ms TTFB is
  // applied to every later body. SN5, SN6 and SN7 are HYPOTHETICAL at
  // the first complete rate, 2350.149 bytes per ms; no SN5/SN6/SN7 service was observed.
  const rate = 2350.149, hypothetical = [];
  const services = sn => {
    if (sn === 1) return 2585;
    const ms = Math.round(FIELD_SIZES[sn] / rate); hypothetical.push({ sn, ms }); return ms;
  };
  const r = await sizeAwareReplay(t, { firstByteMs: 260, services });
  const { f, first, samples, requests, skipped } = r, accounting = assertAuthAccounting(r);
  console.log(JSON.stringify({ fixture: 'size-aware-startup-replay', hypotheticalServicesMs: [...new Map(hypothetical.map(h => [h.sn, h.ms]))],
    ...r.summary, authAdmission: accounting.admission, authValidation: accounting.validation }));
  assert.deepEqual(requests.slice(0, 3), [1, 5, 6]);
  for (const sn of [2, 3, 4]) assert(!requests.includes(sn), `SN${sn} is never requested`);
  assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
  assert(r.elapsed < 12000, 'release precedes the original 12000 ms deadline');
  assert.equal(r.recoveries[0], 3331, 'recovery after the measured SN1 service is 2585 * 1.25 + 100, rounded');
  assert(r.recoveries.every(value => value >= 3331), 'recovery is never reduced below its SN1 value');
  assertStartupGates(r);
  assert.equal(f.engine.startupSnapshot().requiredHeadroomMs, f.state.recovery);
  const profiled = samples.find(({ startup }) => startup.sourceProfile !== null);
  assert(profiled, 'a profile forms once SN1 verifies');
  assert.deepEqual(profiled.startup.sourceProfile, { size: 6074938, ttfbMs: 260, bodyMs: 2325 });
  assert(accounting.admission <= requests.length + skipped.length * 2);
  assert.equal(first.calls.args[2], first.context); assert.equal(first.calls.args[0].data.byteLength, FIELD_SIZES[1]);
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
});

test('size-aware startup keeps the adverse fastest-body scenario green', async t => {
  // Every service (including SN1) is HYPOTHETICAL at the optimistic flow rate,
  // 2598.6 bytes per ms. The frozen replay's zero-TTFB control would form no
  // profile (a same-instant first byte is refused), so this profile-active
  // variant uses a 1 ms first byte. The rejected scalar seed failed here by
  // skipping SN3 for the larger SN4; the size-aware path must not.
  const r = await sizeAwareReplay(t, { firstByteMs: 1, services: sn => Math.round(FIELD_SIZES[sn] / 2598.6) });
  assertAuthAccounting(r);
  console.log(JSON.stringify({ fixture: 'size-aware-startup-fastest-body', ...r.summary }));
  assert(r.samples.some(({ startup }) => startup.sourceProfile !== null), 'the size-aware profile is active in this scenario');
  assert.equal(r.first.calls.success, 1); assert(r.elapsed < 12000);
  assert.equal(r.first.calls.error, 0);
  assert(!r.requests.includes(4), 'the largest fragment is not admitted ahead of smaller reachable ones');
  assertStartupGates(r);
});

test('size-aware startup classifies the slowest measured rate honestly', async t => {
  // Every service (including SN1) is HYPOTHETICAL at the slowest complete rate,
  // 1994.4 bytes per ms. Under this logical clock the outcome is deterministic:
  // no window reaches the recovery headroom before the unchanged deadline, and
  // the manager reports that failure rather than releasing a short window.
  const r = await sizeAwareReplay(t, { firstByteMs: 260, services: sn => Math.round(FIELD_SIZES[sn] / 1994.4) });
  assertAuthAccounting(r);
  console.log(JSON.stringify({ fixture: 'size-aware-startup-slowest-rate', outcome: r.first.calls.success ? 'released' : 'failed', ...r.summary }));
  assert(r.samples.some(({ startup }) => startup.sourceProfile !== null), 'the size-aware profile is active in this scenario');
  assertStartupGates(r);
  assert.deepEqual(r.requests.slice(0, 3), [1, 5, 6]);
  assert.equal(r.first.calls.success, 0); assert.equal(r.elapsed, 12000);
  assert.equal(r.first.calls.error, 1); assert.equal(r.first.calls.args[0].startupBufferReason, 'deadline');
  t.mock.timers.tick(20000); await flushStartup();
  assert.equal(r.first.calls.success, 0, 'no late success after the deadline');
  assert.equal(r.f.engine.snapshot().reservationBytes, 0);
});

test('size-aware startup projection during a release check holds without reading the host target', async t => {
  const tick = startupLogicalClock(t);
  let releasePermit;
  const f = startupFixture(t, { timedStats: true, permit: ctx => {
    const permit = { key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true };
    return ctx.frag.sn === 2 && !releasePermit ? new Promise(resolve => { releasePermit = () => resolve(permit); }) : permit;
  } });
  t.after(() => releasePermit?.());
  // Target 2.5 s is inside SN1 [2,4), past the owner [0,2). With recovery 1000 ms
  // the projection admits SN1 (4 > 2.5 + 1.1) and, as SN1 starts before the
  // target, no window freezes, so later candidates stay on the projection path.
  f.state.target = 2.5; f.state.recovery = 1000;
  const first = f.load(0, 20000); await flushStartup();
  tick(100); f.requests[0].finish(); await flushStartup(); await flushStartup();
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1], 'SN1 is admitted by projection');
  assert.deepEqual(f.engine.startupSnapshot().sourceProfile, { size: 4, ttfbMs: 1, bodyMs: 99 });
  // A slow sample raises the host's recovery before SN1 verifies, so its 1.5 s
  // of coverage no longer releases and SN2 is admitted; SN2's authority is pending.
  f.state.recovery = 1600;
  tick(100); f.requests[1].finish(); await flushStartup(); await flushStartup();
  assert.equal(f.engine.snapshot().cacheObjects, 1); assert.equal(first.calls.success, 0);
  assert.equal(typeof releasePermit, 'function', 'SN2 reached its permit through the size-aware path');
  // Recovery falls again, so the next poll starts the release check from the
  // cached SN1 coverage and blocks inside its authority recheck.
  f.state.recovery = 1000; f.state.holdRecheck = true; f.state.holdCheckSn = 0;
  tick(100); await flushStartup();
  assert.equal(typeof f.state.releaseRecheck, 'function', 'the release check is pending');
  const targetReads = f.state.targetCalls, reservations = f.state.reservations.length, requests = f.requests.length;
  releasePermit(); await flushStartup(); await flushStartup();
  assert.equal(f.state.targetCalls, targetReads, 'the projection reads no host target while the check owns it');
  assert.equal(f.requests.length, requests, 'no load starts during the check');
  assert.equal(f.state.reservations.length, reservations, 'no reservation is attempted during the check');
  assert(f.engine.snapshot().queued >= 1, 'the candidate returns to the queue as metadata');
  assert.equal(f.engine.snapshot().active, 0);
  assert.equal(first.calls.success, 0);
  f.state.releaseRecheck(); await flushStartup(); await flushStartup();
  assert.equal(first.calls.success, 1, 'the pending release completes from the verified coverage');
  assert.equal(f.engine.startupSnapshot().state, 'ready');
  assert.equal(f.requests.length, requests, 'the held candidate never loads after release with steady speculation off');
});

test('size-aware startup profile from one origin leaves another origin on the scalar rule', async t => {
  // The owner comes from origin A and every parsed future from origin B. A's
  // profile must not project B's candidates: admission, authority traffic and
  // request order must match the same geometry without any first-byte timing.
  const tick = startupLogicalClock(t);
  const run = async firstByteMs => {
    const auth = [];
    const f = startupFixture(t, { timedStats: true, firstByteMs,
      urlFor: sn => `https://${sn === 0 ? 'origin.example' : 'other.example'}/media/s${sn}.m4s`,
      permit: ctx => { auth.push(ctx.frag.sn); return { key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true }; } });
    f.state.target = 2.5; f.state.recovery = 3500;
    const first = f.load(0, 20000); await flushStartup();
    tick(100); f.requests[0].finish(); await flushStartup();
    const profile = f.engine.startupSnapshot().sourceProfile;
    const trace = [];
    for (let i = 0; i < 6; i++) { trace.push({ requests: f.requests.map(row => row.context.frag.sn), auth: [...auth], queued: f.engine.snapshot().queued }); tick(100); await flushStartup(); }
    assert.equal(first.calls.success, 0);
    f.engine.stop();
    return { profile, trace, auth };
  };
  const scalar = await run(null), profiled = await run(1);
  assert.equal(scalar.profile, null);
  assert.deepEqual(profiled.profile, { size: 4, ttfbMs: 1, bodyMs: 99 }, 'origin A measured a profile from the owner body');
  assert.deepEqual(profiled.trace, scalar.trace, 'origin B candidates follow the scalar rule poll for poll');
  assert.deepEqual(profiled.auth, scalar.auth, 'no origin B candidate is authorised early because of the origin A profile');
  assert.deepEqual(scalar.auth, scalar.trace.at(-1).requests,
    'the scalar rule authorises exactly the requested fragments; skipped candidates cost no authorisation');
});

// Real SDK fixture: real signed commitments, real sha256 and the real
// authorise/verify/current path. Signed sizes differ per fragment.
const sdkSizes = [1024, 2048, 1536, 4096];
const sdkBody = (sn, salt = 0, length = sdkSizes[sn]) => Uint8Array.from({ length }, (_, i) => (i + sn + salt) % 251);

test('size-aware startup adopts a profile only from a verified same-origin body with real signed size', async t => {
  const f = await fixture(t, { enabled: false, startupTarget: () => 1.3, held: [0, 1, 2, 3], firstByteMs: 5, bodies: sn => sdkBody(sn) });
  const row = sn => f.requests.find(item => item.context.frag.sn === sn), startup = () => f.swarm.metrics().startupBuffer;
  const first = f.load(0);
  await until(() => row(0)); assert.equal(startup().sourceProfile, null, 'no profile before any body');
  await sleep(20); row(0).finish();
  await until(() => startup().sourceProfile !== null);
  const adopted = startup().sourceProfile;
  assert.equal(adopted.size, 1024, 'the signed size, not a default body size');
  assert(adopted.ttfbMs > 0 && adopted.bodyMs > 0);
  // A wrong hash of the same signed length is rejected and teaches nothing.
  await until(() => row(1)); const rejected = f.swarm.metrics().warmAhead.rejected;
  await sleep(20); row(1).finish(sdkBody(1, 7));
  await until(() => f.swarm.metrics().warmAhead.rejected === rejected + 1);
  assert.deepEqual(startup().sourceProfile, adopted, 'a wrong-hash body leaves the profile unchanged');
  // A body shorter than its signed size is rejected and teaches nothing.
  await until(() => row(2));
  await sleep(20); row(2).finish(sdkBody(2, 0, sdkSizes[2] - 1));
  await until(() => f.swarm.metrics().warmAhead.rejected === rejected + 2);
  assert.deepEqual(startup().sourceProfile, adopted, 'a wrong-length body leaves the profile unchanged');
  assert.equal(first.calls.success, 0); assert.equal(startup().state, 'buffering');
});

test('size-aware startup drops the profile when signed authority is not current at verification', async t => {
  // The captured signed commitment expires between the request and its
  // verification (Date.now is skewed only until the next authorisation).
  let skew = 0; const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + skew);
  let target = 1.3;
  const f = await fixture(t, { enabled: false, startupTarget: () => target, held: [0, 1, 2, 3], firstByteMs: 5,
    bodies: sn => sdkBody(sn), beforeCommitment: context => { if (context.frag.sn >= 2) skew = 0; } });
  const row = sn => f.requests.find(item => item.context.frag.sn === sn), startup = () => f.swarm.metrics().startupBuffer;
  const first = f.load(0);
  await until(() => row(0)); await sleep(20); row(0).finish();
  await until(() => startup().sourceProfile !== null);
  assert.equal(startup().sourceProfile.size, 1024);
  await until(() => row(1));
  // The room target moves into SN1, so its verified coverage stays below the
  // recovery requirement and no final authority check can end startup here.
  target = 2.5; skew = 10 * 60 * 1000;
  await sleep(20); row(1).finish();
  await until(() => f.swarm.metrics().warmAhead.verified >= 2);
  skew = 0;
  assert.equal(startup().sourceProfile, null, 'a verified future without current authority retires the older profile');
  assert.equal(startup().state, 'buffering'); assert.equal(first.calls.success, 0);
  assert.equal(f.swarm.metrics().warmAhead.rejected, 0, 'the body itself verified');
});

// Logical-clock manager fixture with an active 4-byte source profile. The owner
// (SN0, [0,2]) starts at logical time 0 and finishes after 100 ms with a 1 ms
// first byte, so its profile is { size: 4, ttfbMs: 1, bodyMs: 99 } and every
// 4-byte candidate projects 100 ms of service. The default room target (2.5 s)
// is past the owner, so only the size-aware skip rule governs SN1 and later.
// The owner is verified and the first admission pass has run when this returns.
const profiledStartup = async (t, tick, { target = 2.5, recovery = 2000, parentMs = 20000, beforeOwner, onNext, ...options } = {}) => {
  const f = startupFixture(t, { timedStats: true, onNext: ctx => onNext?.(ctx, f), ...options });
  f.state.target = target; f.state.recovery = recovery;
  const first = f.load(0, parentMs); await flushStartup();
  assert.equal(f.requests.length, 1, 'only the genuine source is admitted before its first verification');
  beforeOwner?.(f, first);
  tick(100); f.requests[0].finish(); await flushStartup();
  assert(f.engine.snapshot().verified >= 1, 'the actual original body verifies');
  if (f.engine.startupSnapshot().state === 'buffering')
    assert.deepEqual(f.engine.startupSnapshot().sourceProfile, { size: 4, ttfbMs: 1, bodyMs: 99 }, 'the size-aware profile is active for every candidate below');
  return { f, first };
};

for (const phase of ['pre-authority', 'post-authority']) {
  for (const mutation of ['url', 'sn', 'start', 'mutate-throw', 'clear', 'stop']) {
    test(`size-aware startup projection cancels before any load when next mutates the candidate: ${phase} ${mutation}`, async t => {
      const tick = startupLogicalClock(t), nth = phase === 'pre-authority' ? 1 : 2;
      let seen = 0, at = null;
      const { f, first } = await profiledStartup(t, tick, { recovery: 2000, onNext: (ctx, engine) => {
        if (ctx.frag.sn !== 1 || ++seen !== nth) return;
        at = { auth: engine.state.authCalls, reservations: engine.state.reservations.length, requests: engine.requests.length,
          profile: engine.engine.startupSnapshot().sourceProfile };
        if (mutation === 'clear' || mutation === 'stop') engine.engine[mutation]();
        else if (mutation === 'sn') ctx.frag.sn = 999;
        else if (mutation === 'start') ctx.frag.start += 0.5;
        else {
          ctx.url = ctx.frag.url = 'https://origin.example/media/changed.m4s';
          if (mutation === 'mutate-throw') throw new Error('test callback changed metadata');
        }
      } });
      await flushStartup();
      assert(at, 'the candidate callback was reached');
      assert.deepEqual(at.profile, { size: 4, ttfbMs: 1, bodyMs: 99 }, 'a size-aware profile is active when the candidate is checked');
      assert.equal(at.auth, phase === 'pre-authority' ? 1 : 2,
        'the pre-authority check precedes the candidate permit; the projection follows it');
      const startup = f.engine.startupSnapshot();
      assert.equal(startup.state, 'cancelled');
      if (mutation !== 'clear' && mutation !== 'stop') assert.equal(startup.reason, 'context-changed');
      assert.equal(first.calls.success, 0);
      assert.equal(first.calls.abort, mutation === 'stop' ? 0 : 1, 'engine stop is quiet; every other cancellation notifies the caller');
      assert.equal(f.requests.length, at.requests, 'no source load starts for the mutated candidate');
      assert.equal(f.state.reservations.length, at.reservations, 'no reservation is attempted for the mutated candidate');
      assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
      assert.equal(startup.sourceProfile, null);
      tick(20000); await flushStartup();
      assert.equal(f.state.authCalls, at.auth, 'authority is not requested again after cancellation');
      assert.equal(f.requests.length, at.requests); assert.equal(first.calls.success, 0);
      assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().trackedObjects, 0);
    });
  }
}

test('size-aware startup survives permit.current calling stop or clear during adoption', async t => {
  const tick = startupLogicalClock(t);
  for (const action of ['stop', 'clear']) {
    let engine, fired = 0;
    const { f } = await profiledStartup(t, tick, {
      permit: ctx => ({ key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)),
        current: () => { if (ctx.frag.sn === 0 && fired++ === 0) engine[action](); return true; } }),
      beforeOwner: owner => { engine = owner.engine; } });
    assert.equal(fired, 1, `${action}: current ran once, after verification`);
    const startup = f.engine.startupSnapshot();
    assert.equal(startup.sourceProfile, null, action); assert.equal(startup.state, 'cancelled', action);
    assert.equal(f.requests.length, 1, `${action}: no further request`);
    tick(20000); await flushStartup();
    assert.equal(f.requests.length, 1, action); assert.equal(f.engine.snapshot().reservationBytes, 0, action);
    assert.equal(f.engine.snapshot().active, 0, action); assert.equal(f.engine.startupSnapshot().sourceProfile, null, action);
    f.engine.stop();
  }
});

test('size-aware startup projection tolerates target or recovery becoming invalid', async t => {
  const tick = startupLogicalClock(t);
  for (const invalid of ['target', 'recovery']) {
    let state, candidateAuth = 0;
    // The candidate's permit is the only point between the pre-authority check
    // and the projection, so the host clock or recovery goes bad exactly there.
    const { f, first } = await profiledStartup(t, tick, {
      permit: ctx => {
        if (ctx.frag.sn === 1) { candidateAuth++; if (invalid === 'target') state.target = null; else state.recovery = NaN; }
        return { key: ctx.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true };
      },
      beforeOwner: owner => { state = owner.state; } });
    assert.equal(candidateAuth, 1, `${invalid}: the candidate reached its permit`);
    const startup = f.engine.startupSnapshot();
    assert.equal(startup.state, invalid === 'target' ? 'cancelled' : 'failed', invalid);
    assert.equal(startup.reason, invalid === 'target' ? 'target-unavailable' : 'invalid-recovery', invalid);
    assert.equal(first.calls.success, 0, invalid);
    if (invalid === 'target') assert.equal(first.calls.abort, 1);
    else { assert.equal(first.calls.error, 1); assert.equal(first.calls.args[0].startupBufferReason, 'invalid-recovery'); }
    assert.equal(f.requests.length, 1, `${invalid}: no load starts for the candidate`);
    assert.equal(f.engine.snapshot().reservationBytes, 0, invalid); assert.equal(f.engine.snapshot().active, 0, invalid);
    assert.equal(startup.sourceProfile, null, invalid);
    tick(20000); await flushStartup();
    assert.equal(f.requests.length, 1, invalid); assert.equal(candidateAuth, 1, invalid);
    f.engine.stop();
  }
});

test('size-aware startup projection is retired by supersession when a genuine load arrives while buffering', async t => {
  const tick = startupLogicalClock(t);
  // SN1 and SN2 are both inside target + recovery + projected service, so the
  // projection would skip SN1 and then hold SN2 (hop spent). SN2's permit is
  // pending when a genuine load of SN2 arrives.
  const { f, first } = await profiledStartup(t, tick, { recovery: 3500,
    beforeOwner: owner => { owner.state.holdRecheck = true; owner.state.holdCheckSn = 2; } });
  assert.equal(typeof f.state.releaseRecheck, 'function', 'SN2 authority is pending');
  assert.equal(f.requests.length, 1, 'SN1 was skipped without a body');
  const demand = f.load(2, 20000);
  f.state.releaseRecheck(); await flushStartup();
  // MANAGER BEHAVIOUR (not a defect): beginStartup supersedes a buffering
  // startup when another warm-eligible load arrives, so the genuine SN2 load is
  // aborted and the pending candidate is retired instead of being coalesced. The
  // projection therefore never skips or holds a row that a genuine consumer owns.
  const startup = f.engine.startupSnapshot();
  assert.equal(startup.state, 'cancelled'); assert.equal(startup.reason, 'superseded');
  assert.equal(first.calls.abort, 1, 'the startup owner is told it was superseded');
  assert.equal(demand.calls.abort, 1); assert.equal(demand.calls.success, 0);
  assert.equal(f.requests.length, 1, 'neither the held candidate nor the genuine load starts a source request');
  assert.equal(f.engine.snapshot().queued, 0, 'no held metadata survives the cancellation');
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().active, 0);
  tick(20000); await flushStartup();
  assert.equal(f.requests.length, 1);
});

// Counts authority requests per fragment without changing the default 4-byte permit.
const countingPermit = (counts, sizeOf = () => 4) => ctx => {
  counts.set(ctx.frag.sn, (counts.get(ctx.frag.sn) ?? 0) + 1);
  return { key: ctx.url, size: sizeOf(ctx.frag.sn), sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true };
};
const requestedSns = f => f.requests.map(row => row.context.frag.sn);

test('size-aware startup hold keeps the original item deadline and never renews it', async t => {
  const tick = startupLogicalClock(t), auth = new Map();
  // Recovery 3500 ms puts SN1 and SN2 inside target + recovery + 100 ms: SN1 is
  // skipped with the poll's only hop, so SN2 is held with its first deadline.
  const { f } = await profiledStartup(t, tick, { recovery: 3500, permit: countingPermit(auth) });
  const admittedAt = performance.now(); // the pass that first authorised SN2 and fixed its 8000 ms deadline
  assert.deepEqual(requestedSns(f), [0], 'SN1 skipped and SN2 held without a body');
  assert.equal(auth.get(1), 1); assert.equal(auth.get(2), 1);
  assert.equal(f.engine.snapshot().queued, 2, 'the held SN2 and its successor wait for the next poll');
  f.state.recovery = 2000; // the held SN2 is now admissible, so the next poll requests it
  tick(100); await flushStartup();
  assert.deepEqual(requestedSns(f), [0, 2], 'the held candidate is requested on the next poll');
  assert.equal(auth.get(2), 2, 'one authority request per poll');
  assert.equal(auth.get(1), 1, 'the skipped SN1 is not authorised again');
  const row = f.requests[1]; let abortedAt = null;
  for (let i = 0; i < 100 && abortedAt === null; i++) {
    tick(100); await flushStartup();
    if (row.aborted) abortedAt = performance.now() - admittedAt;
  }
  assert.equal(abortedAt, 8000, 'the held item expires at its first deadline, not eight seconds after re-admission');
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000);
});

test('size-aware startup respects a short parent deadline during projection', async t => {
  const tick = startupLogicalClock(t);
  // Recovery 8000 ms with a static 2.5 s target: SN1 to SN4 end inside target +
  // recovery + 100 ms (10.6 s), so only the reachable-future rule can admit them.
  // Its horizon is the remaining startup lifetime: 5 s here, 12 s in the control.
  const sequences = {};
  for (const parentMs of [5000, 20000]) {
    const entry = performance.now();
    const { f, first } = await profiledStartup(t, tick, { recovery: 8000, parentMs });
    for (let i = 0; i < 30 && f.requests.length < 2; i++) { tick(100); await flushStartup(); }
    sequences[parentMs] = requestedSns(f);
    assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000, 'the reported startup limit is the unchanged ceiling');
    if (parentMs === 5000) {
      let failedAt = null;
      for (let i = 0; i < 100 && failedAt === null; i++) {
        if (first.calls.error) failedAt = performance.now() - entry;
        else { tick(100); await flushStartup(); }
      }
      assert.equal(failedAt, 5000, 'the failure arrives at the parent deadline');
      assert.equal(f.engine.startupSnapshot().reason, 'deadline');
      assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
      assert.equal(first.calls.success, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
    }
    f.engine.stop();
  }
  assert.deepEqual(sequences[5000], [0, 3], 'with 5 s left, SN3 is the last future reachable at room-clock speed');
  assert.deepEqual(sequences[20000], [0, 5], 'the same candidates are skipped further with the full 12 s lifetime');
});

test('size-aware startup absolute deadline during a hold fails once and releases nothing late', async t => {
  const tick = startupLogicalClock(t), auth = new Map();
  // The programme starts after a room target of 0.5 s that the owner does not cover,
  // and a 250 ms parent leaves too little time for any future to be reachable, so
  // every pass skips one candidate and holds the next. The deadline lands mid-hold.
  const starts = Array.from({ length: 20 }, (_, i) => 10 + 2 * i);
  const { f, first } = await profiledStartup(t, tick, { target: 0.5, recovery: 20000, parentMs: 250, starts, permit: countingPermit(auth) });
  assert.deepEqual(requestedSns(f), [0]); assert.equal(auth.get(1), 1); assert.equal(auth.get(2), 1, 'SN2 is held at the first pass');
  tick(100); await flushStartup(); // second pass: SN2 skipped, SN3 held
  assert.equal(auth.get(2), 2); assert.equal(auth.get(3), 1);
  assert.equal(f.engine.snapshot().queued, 2, 'a held candidate is queued when the deadline arrives');
  tick(50); await flushStartup();
  assert.equal(f.engine.startupSnapshot().state, 'failed'); assert.equal(f.engine.startupSnapshot().reason, 'deadline');
  assert.equal(first.calls.error, 1); assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().queued, 0);
  const authAtDeadline = f.state.authCalls;
  for (const row of f.requests) row.finish(true);
  await flushStartup(); tick(20000); await flushStartup();
  assert.equal(first.calls.success, 0, 'a late body cannot release the failed startup');
  assert.equal(first.calls.error, 1, 'the failure is delivered once');
  assert.equal(f.state.authCalls, authAtDeadline); assert.equal(requestedSns(f).length, 1);
  assert.equal(f.engine.snapshot().cacheObjects, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
});

test('size-aware startup reservation refusal after projection leaves no waiting or hop state behind', async t => {
  const tick = startupLogicalClock(t), auth = new Map(); let refused = 0;
  // SN1 is admitted by the projection and then refused by the shared reservation.
  // SN2 is signed at 400 bytes, so its projected service (about 9.9 s) puts it
  // inside target + recovery and the projection skips it. SN3 is admitted again.
  const { f } = await profiledStartup(t, tick, { target: 2.5, recovery: 1000,
    permit: countingPermit(auth, sn => sn === 2 ? 400 : 4),
    reserve: size => { if (!refused && size === 8) { refused++; return false; } return true; } });
  assert.equal(refused, 1, 'the admitted SN1 reached the reservation guard');
  assert.equal(f.engine.snapshot().rejected, 1);
  assert.deepEqual(requestedSns(f), [0, 3],
    'with no poll in between, the skip still had its hop and the successor was admitted: no waiting state remained');
  assert.equal(auth.get(1), 1); assert.equal(auth.get(2), 1); assert.equal(auth.get(3), 1);
  assert.equal(f.engine.snapshot().active, 1);
  assert.equal(f.engine.snapshot().reservationBytes, 8, 'only the original and the admitted SN3 are reserved');
  tick(100); await flushStartup();
  assert.deepEqual(requestedSns(f), [0, 3]); assert.equal(auth.get(1), 1, 'the refused SN1 is not retried');
  f.requests[1].finish(); await flushStartup();
  assert.equal(f.engine.snapshot().rejected, 1);
  f.engine.stop();
  assert.equal(f.engine.snapshot().reservationBytes, 0);
});

test('size-aware startup skip leaves the same plan, cursor and queue as a scalar hop', async t => {
  const tick = startupLogicalClock(t), runs = {};
  // SN0 owner, SN1 admitted as a contiguous extension and verified after 100 ms
  // of service. The room target then jumps to 4.5 s with 3500 ms recovery, so
  // SN2 (4 bytes, projected service 100 ms in the profile run and a 100 ms scalar
  // sample in the legacy run) is skipped; SN3 is inside the window too.
  for (const mode of ['scalar', 'profile']) {
    const f = startupFixture(t, { timedStats: true, firstByteMs: mode === 'scalar' ? null : undefined });
    f.state.recovery = 3500;
    const first = f.load(0, 20000); await flushStartup();
    tick(100); f.requests[0].finish(); await flushStartup();
    assert.deepEqual(requestedSns(f), [0, 1], `${mode}: SN1 is admitted as a contiguous extension`);
    tick(100); f.state.target = 4.5; f.requests[1].finish(); await flushStartup();
    const startup = f.engine.startupSnapshot();
    assert.equal(startup.planningServiceMs, 100, mode);
    assert.deepEqual(startup.sourceProfile, mode === 'scalar' ? null : { size: 4, ttfbMs: 1, bodyMs: 99 }, mode);
    const { sourceProfile, planningServiceMs, ...rest } = startup, warm = f.engine.snapshot();
    runs[mode] = { startup: rest, requests: requestedSns(f), queued: warm.queued, cacheObjects: warm.cacheObjects,
      trackedObjects: warm.trackedObjects, active: warm.active, reservationBytes: warm.reservationBytes };
    let polls = 0;
    while (requestedSns(f).length < 3 && polls < 20) { tick(100); polls++; await flushStartup(); }
    runs[mode].next = { requests: requestedSns(f), polls };
    assert.equal(first.calls.success, 0, mode);
    f.engine.stop();
  }
  const { next: scalarNext, ...scalar } = runs.scalar, { next: profileNext, ...profile } = runs.profile;
  console.log(JSON.stringify({ fixture: 'size-aware-startup-skip-parity', scalar: runs.scalar, profile: runs.profile }));
  assert.deepEqual(profile, scalar, 'after the SN2 skip both paths hold the same startup state, queue, cache and reservation');
  assert.equal(scalarNext.requests.at(-1), profileNext.requests.at(-1), 'both paths request the same successor next');
  assert(profileNext.polls <= scalarNext.polls,
    'the profile path may request that successor in the same poll as the skip; the scalar path waits for the next poll');
});

const profileModes = ['valid', 'missing-first', 'first-equals-start', 'first-equals-end', 'aborted', 'wrong-loaded',
  'cross-origin-url', 'non-200', 'peer-bytes', 'mutated-after-callback'];
const expectedProfile = (bodyMs) => ({ size: 4, ttfbMs: 1, bodyMs });

test('size-aware startup forms no profile from invalid timing, peer bytes or mutated stats', async t => {
  const tick = startupLogicalClock(t);
  for (const subject of ['owner', 'future']) for (const mode of profileModes) {
    const label = `${subject}/${mode}`, badSn = subject === 'owner' ? 0 : 1;
    let f;
    f = startupFixture(t, { timedStats: true,
      beforeSuccess: (ctx, stats) => {
        if (ctx.frag.sn !== badSn) return;
        const row = f.requests.find(item => item.context === ctx);
        if (mode === 'missing-first') delete stats.loading.first; // a loader that reports no first byte
        if (mode === 'first-equals-start') stats.loading.first = stats.loading.start;
        if (mode === 'first-equals-end') stats.loading.first = stats.loading.end;
        if (mode === 'aborted') stats.aborted = true;
        if (mode === 'wrong-loaded') stats.loaded -= 1;
        if (mode === 'cross-origin-url') row.response.url = `https://cdn.example/media/s${ctx.frag.sn}.m4s`;
        if (mode === 'non-200') row.response.code = 206;
        if (mode === 'peer-bytes') ctx[STARTUP_MARKER].peerBytes = 1;
      } });
    f.state.recovery = 3500; // a 1.3 s target never has enough verified headroom, so startup stays buffering
    const first = f.load(0, 20000); await flushStartup();
    tick(100);
    f.requests[0].finish();
    if (subject === 'owner' && mode === 'mutated-after-callback') Object.assign(f.requests[0].stats, { loaded: 0, aborted: true, loading: { start: -1, first: -1, end: -1 } });
    await flushStartup();
    const afterOwner = f.engine.startupSnapshot();
    if (subject === 'owner') {
      assert.deepEqual(afterOwner.sourceProfile, ['valid', 'mutated-after-callback'].includes(mode) ? expectedProfile(99) : null, label);
      assert.equal(afterOwner.planningServiceMs, null, `${label}: an owner sample never sets the scalar`);
    } else assert.deepEqual(afterOwner.sourceProfile, expectedProfile(99), `${label}: a valid owner profile precedes the future`);
    assert.deepEqual(requestedSns(f), [0, 1], label);
    tick(50);
    f.requests[1].finish();
    if (subject === 'future' && mode === 'mutated-after-callback')
      Object.assign(f.requests[1].stats, { loaded: 0, aborted: true, loading: { start: -1, first: -1, end: -1 } });
    await flushStartup();
    const startup = f.engine.startupSnapshot();
    // The future sample is 50 ms with a 1 ms first byte, unless the mode invalidates it.
    const futureValid = subject === 'owner' || ['valid', 'mutated-after-callback'].includes(mode);
    assert.deepEqual(startup.sourceProfile, futureValid ? expectedProfile(49) : null, label);
    // The scalar service sample has its own, older validity rules.
    const scalarForbidden = subject === 'future' && ['aborted', 'wrong-loaded'].includes(mode);
    assert.equal(startup.planningServiceMs, scalarForbidden ? null : 50, `${label}: the scalar planning sample follows its own rules`);
    assert.equal(first.calls.success, 0, label); assert.equal(startup.state, 'buffering', label);
    f.engine.stop();
  }
});

test('startup horizon planner survives the captured serial peer cadence without renewing the eight-second deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = [0, 2, 4, 6, 8.64, 10.64, 12.56], durations = [2, 2, 2, 2.64, 2, 1.92, 2];
  const f = startupFixture(t, { starts, durations }); f.state.target = 1.6;
  const first = f.load(0, 8000); let elapsed = 0;
  const advance = async ms => {
    for (let left = ms; left > 0;) {
      const step = Math.min(100, left); elapsed += step; left -= step;
      f.state.target = 1.6 + elapsed / 1000;
      t.mock.timers.tick(step); await flushStartup();
    }
  };
  await flushStartup();
  await advance(2241);
  await advance(771);
  // The genuine source now verifies before any speculative HTTP is admitted.
  // Keep the same3.012s observed planning point and original8s parent budget.
  f.requests[0].finish(); await flushStartup();
  assert.equal(f.state.target, 4.612);
  await advance(100); // The unchanged bounded poll advances one skipped metadata hop.
  assert.equal(f.engine.snapshot().cacheObjects, 0);
  assert.equal(f.engine.snapshot().active, 1);
  assert.equal(f.engine.snapshot().queued, 1);
  f.requests[1].finish(); await flushStartup();
  // Preserve the observed per-object peer service cadence after that point.
  // This is an encoded-state replay, not a claim about future WAN latency.
  const cadence = { 2: 1450, 3: 2064, 4: 1427, 5: 1427 };
  while (!first.calls.success && !first.calls.error && elapsed < 8000) {
    const row = f.requests.find(row => row.context.frag.sn >= 2 && !row.response && !row.aborted);
    if (!row) { await advance(Math.min(100, 8000 - elapsed)); continue; }
    const ms = Math.min(cadence[row.context.frag.sn] ?? 1427, 8000 - elapsed);
    await advance(ms);
    if (!first.calls.error) { row.finish(); await flushStartup(); }
    assert.ok(f.engine.startupSnapshot().heldObjects <= 3);
    assert.ok(f.engine.startupSnapshot().heldBytes <= 24 * 1024 * 1024);
  }
  assert.equal(first.calls.success, 1, 'fresh horizon planning must form two seconds ahead before the original deadline');
  assert.equal(first.calls.error, 0);
  assert.ok(elapsed < 8000);
  assert.ok(!f.requests.some(row => row.context.frag.sn === 2), 'unrequested [4,6] cannot supply target4.612 +2s');
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert.ok(f.engine.startupSnapshot().verifiedEnd - f.state.target >= 2);
});

test('startup horizon planner retains a completed deficit and fills one contiguous successor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t), first = f.load(0, 8000);
  f.state.recovery = 2762.5; await requireOriginalVerified(f); f.requests[1].finish(); await flushStartup();
  f.state.target = 3.885; f.state.recovery = 2762.5;
  f.requests[2].finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().heldObjects, 3);
  assert.equal(first.calls.success, 0);
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[3]?.context.frag.sn, 3, 'extend the verified prefix with its next contiguous future');
  assert.equal(f.engine.startupSnapshot().heldObjects, 4, 'retain the original and both useful futures during the extra request');
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 1, 'retained coverage releases at the actual target3.885 without waiting for4');
  assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert.equal(f.engine.startupSnapshot().verifiedStart, 2);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 8);
  t.mock.timers.tick(500); await flushStartup();
  assert.equal(f.requests.length, 4, 'released startup cannot keep rolling or start extra work');
  f.state.target = 4.05; t.mock.timers.tick(100); await flushStartup();
  assert.equal(first.calls.success, 1);
});

test('startup horizon planner freezes an ahead window instead of skipping every short future', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const starts = [0, 2, 4, 6, 8.64, 10.64], durations = [2, 2, 2, 2.64, 2, 2];
  const f = startupFixture(t, { starts, durations }); f.state.target = 3.1; f.state.recovery = 5000;
  const first = f.load(0, 8000); await flushStartup();
  f.requests[0].finish(); await flushStartup();
  for (let i = 0; i < 3; i++) { t.mock.timers.tick(100); await flushStartup(); }
  const future = f.requests.find(row => row.context.frag.sn === 3);
  assert.ok(future, 'parsed [6,8.64] passes the projected horizon before its admitted window freezes');
  future.finish(); await flushStartup();
  const next = f.requests.find(row => row.context.frag.sn === 4); assert.ok(next); next.finish(); await flushStartup();
  t.mock.timers.tick(1000); await flushStartup();
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 3, 4, 5],
    'the verified [6,10.64] prefix needs the fourth slot for its unchanged five-second recovery');
  assert.equal(first.calls.success, 0);
  assert.equal(f.engine.startupSnapshot().heldObjects, 4);
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 0, 'an ahead-only complete window cannot release at actual target3.1');
  f.state.target = 6.05; t.mock.timers.tick(100); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.equal(f.engine.startupSnapshot().verifiedStart, 6);
  assert((f.engine.startupSnapshot().verifiedEnd - f.state.target) * 1000 >= 5000);
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 3, 4, 5], 'filling the prefix never skips its selected start');
});

for (const recovery of [3500, 1500]) test(`startup horizon planner freezes a selected successor behind a cached prefix (${recovery}ms)`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t, { starts: [0, 2, 4, 5, 6, 9], durations: [2, 2, 1, 1, 3, 2] });
  const first = f.load(0, 8000); await requireOriginalVerified(f);
  f.state.target = recovery === 3500 ? 2.3 : 3.5; f.state.recovery = recovery;
  f.requests[1].finish(); await flushStartup();
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[2]?.context.frag.sn, 3,
    'one hop selects [5,6]; an earlier cached [2,4] cannot allow another skip');
  f.requests[2].finish(); await flushStartup();
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(first.calls.success, 0);
  assert.equal(f.requests[3]?.context.frag.sn, 4);
  f.requests[3].finish(); await flushStartup();
  t.mock.timers.tick(400); await flushStartup();
  assert.equal(f.requests.length, 4, 'the completed deficit prefix can retire without moving selected start5');
  assert.equal(first.calls.success, 0, 'verified [5,9] still cannot release before the actual target reaches5');
  f.state.target = 5.1; t.mock.timers.tick(100); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.ok(f.engine.startupSnapshot().verifiedEnd - f.state.target >= recovery / 1000);
});

test('rolling startup replaces only an obsolete future while retaining the exact first terminal', async t => {
  // Encoded-state replay of the M4 cause capture: all three objects verified,
  // target3.885 in [2,6], but only2115ms ahead for2762.5ms recovery. Advancing
  // beyond4 must free the old [2,4] slot, rather than wait idle until deadline.
  const f = startupFixture(t), first = f.load();
  first.context[STARTUP_MARKER].peerBytes = 4;
  first.context[STARTUP_MARKER].accept = () => { f.state.accepted++; };
  await fillStartupWindow(f);
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
  assert.equal(f.engine.startupSnapshot().limits.objects, 4);
  assert.equal(f.engine.startupSnapshot().limits.bytes, 24 * 1024 * 1024);
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000);
  const reads = f.state.targetCalls;
  await sleep(125);
  assert.equal(f.state.targetCalls, reads, 'no startup clock remains after release');
  assert.equal(f.requests.length, 4, 'steady warming is still disabled');
});

test('rolling startup cursor retains the last reachable future under its short parent deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t), first = f.load();
  await fillStartupWindow(f);
  f.state.target = 6.1;
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(100); await flushStartup(); }
  assert.equal(f.requests.length, 4);
  assert.equal(f.requests[3].context.frag.sn, 3,
    'after obsolete futures, [6,8] is reachable; skipping to8 would exceed the unchanged one-second parent');
  assert.ok(f.engine.startupSnapshot().heldObjects <= 3);
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 0);
  assert.equal(f.requests[4].context.frag.sn, 4);
  assert.ok(f.engine.startupSnapshot().heldObjects <= 3);
  f.requests[4].finish(); await flushStartup();
  assert.equal(first.calls.success, 1, 'verified [6,10] safely covers actual target6.1 plus unchanged recovery');
  assert.equal(f.engine.startupSnapshot().verifiedStart, 6);
  assert((f.engine.startupSnapshot().verifiedEnd - f.state.target) * 1000 >= f.state.recovery);
  assert.equal(f.requests[0].config.loadPolicy.maxLoadTimeMs, 1000);
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2, 3, 4]);
  t.mock.timers.tick(1000); await flushStartup();
  assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0);
});

test('rolling startup metadata snapshots cannot retain runtime markers or response back-references', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [], f = startupFixture(t, { onNext: ctx => {
    if (ctx.frag.sn > 0) seen.push({ sn: ctx.frag.sn, symbols: Object.getOwnPropertySymbols(ctx).length,
      hasBackReference: Object.hasOwn(ctx, 'fixtureResponseBackReference') });
  } }), first = f.load(0, 8000);
  // The runtime marker and arbitrary back-reference must not enter metadata.
  await fillStartupWindow(f, row => { row.context.fixtureResponseBackReference = row; });
  f.state.target = 6.1;
  for (let i = 0; i < 2; i++) { t.mock.timers.tick(100); await flushStartup(); }
  f.requests[3].context.fixtureResponseBackReference = f.requests[3];
  f.requests[3].finish(); await flushStartup(); f.requests[4].finish(); await flushStartup();
  f.state.target = 8.05; t.mock.timers.tick(100); await flushStartup();
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
  await requireOriginalVerified(f); f.state.target = 3.885; f.state.recovery = 2762.5;
  f.requests[1].finish(); await flushStartup();
  assert.equal(typeof release, 'function');
  f.state.target = 4.085;
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[1].aborted, false, 'a verifier still owns the completed response body');
  assert.equal(f.requests.length, 2, 'no replacement may borrow that still-live reservation');
  assert.equal(f.engine.snapshot().reservationBytes, 8);
  assert.equal(f.engine.startupSnapshot().heldObjects, 2);
  release(); await flushStartup();
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[2].context.frag.sn, 3, 'only after verification settles may the stale unrequested hop be skipped');
  f.requests[2].finish(); await flushStartup();
  assert.equal(f.requests[3].context.frag.sn, 4);
  f.state.target = 6.05;
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.ok(f.state.reservations.every(size => size <= 24 * 1024 * 1024));
});

test('rolling startup retains the original deadline and rejects retry or late completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = startupFixture(t), first = f.load(0, 350);
  await fillStartupWindow(f);
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
  await fillStartupWindow(f);
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
    await fillStartupWindow(f);
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
  t.mock.timers.tick(100); await flushStartup();
  assert.equal(f.requests[2].context.frag.sn, 3);
  f.requests[2].finish(); await flushStartup();
  assert.equal(f.requests[3].context.frag.sn, 4);
  f.state.target = 6.05;
  f.requests[3].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.equal(commits, 1);
  assert.equal(f.engine.startupSnapshot().commitCompleted, true);
});

test('startup parsed metadata refresh tolerates arithmetic roundoff but cancels real geometry changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cases = [['start', 3.552713678800501e-15], ['duration', 3.552713678800501e-15],
    ['start', 1e-6], ['duration', 1e-6], ['start', 1e-6, 1e9]];
  for (const [field, delta, offset = 0] of cases) {
    const starts = [offset, offset + 2, offset + 4], durations = [2, 2, 2];
    const f = startupFixture(t, { starts, durations }); f.state.target = offset + 1.3;
    const first = f.load(0, 8000);
    f.requests[0].finish(); await flushStartup();
    const response = f.requests[0].response, stats = first.loader.stats;
    assert.equal(f.requests[1].context.frag[field], field === 'start' ? offset + 2 : 2);
    // next() returns freshly parsed metadata; the retained request and plan
    // keep their original geometry, as in an Hls playlist refresh.
    (field === 'start' ? starts : durations)[1] += delta;
    t.mock.timers.tick(100); await flushStartup();
    f.requests[1].finish(true); await flushStartup();
    if (delta < 1e-9) {
      assert.equal(f.engine.startupSnapshot().state, 'ready', field);
      assert.equal(first.calls.success, 1); assert.equal(first.calls.abort, 0); assert.equal(first.calls.error, 0);
      assert.equal(first.calls.args[0], response); assert.equal(first.calls.args[1], stats); assert.equal(first.calls.args[2], first.context);
    } else {
      assert.equal(f.engine.startupSnapshot().state, 'cancelled', field);
      assert.equal(f.engine.startupSnapshot().reason, 'context-changed');
      assert.equal(first.calls.success, 0); assert.equal(first.calls.abort, 1); assert.equal(first.calls.error, 0);
    }
  }
});

test('rolling startup rechecks new parsed geometry and signed authority after verification yields', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const action of ['geometry', 'authority']) {
    const starts = [0, 2, 4, 6], f = startupFixture(t, { starts }), first = f.load(0, 8000);
    await fillStartupWindow(f);
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
  f.state.recovery = 2762.5; await requireOriginalVerified(f);
  f.requests[1].finish(); await flushStartup();
  f.state.target = 3.885;
  assert.equal(f.requests.length, 2, 'the new object does not fit beside first and current future');
  assert.equal(f.engine.snapshot().rejected, 1);
  assert.equal(f.engine.snapshot().cacheObjects, 1, 'required [2,4] stays resident');
  assert.equal(f.engine.startupSnapshot().heldObjects, 2);
  assert.equal(first.calls.success, 0);
  assert.ok(f.state.reservations.every(size => size <= 24 * 1024 * 1024));
});

test('rolling startup real SDK uses currently parsed future fragments without early Hls credit', async t => {
  let target = 1.3;
  const f = await fixture(t, { enabled: false, startupTarget: () => target, held: [0, 1, 2, 3] });
  const first = f.load(0);
  for (const sn of [0, 1, 2]) {
    await until(() => f.requests.some(row => row.context.frag.sn === sn));
    if (sn === 1) target = 2.1;
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
  const tick = startupLogicalClock(t);
  const f = startupFixture(t), first = f.load(0, 25);
  f.requests[0].finish(); await flushStartup();
  assert.equal(first.calls.success, 0);
  tick(25); await flushStartup();
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
  const tick = startupLogicalClock(t);
  const f = startupFixture(t, { permitSize: sn => (sn === 0 ? 16 : 12) * 1024 * 1024 }), first = f.load(0, 25);
  await flushStartup();
  assert.equal(f.requests.length, 1, 'future12MiB cannot fit beside the reserved first16MiB');
  assert.equal(f.engine.startupSnapshot().heldBytes, 16 * 1024 * 1024);
  assert.ok(f.engine.snapshot().trackedObjects <= 3);
  assert.ok(f.engine.snapshot().reservationBytes <= 24 * 1024 * 1024);
  tick(25); await flushStartup();
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
  const tick = startupLogicalClock(t);
  const f = startupFixture(t, { starts: [0, 4, 6] }), first = f.load(0, 25);
  f.requests[0].finish(); await flushStartup();
  f.requests[1].finish(); await flushStartup();
  f.requests[2].finish(); await flushStartup();
  assert.equal(first.calls.success, 0);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 2);
  tick(25); await flushStartup(); assert.equal(first.calls.error, 1);
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
  const tick = startupLogicalClock(t);
  for (const action of ['abort', 'deadline']) {
    const f = startupFixture(t), first = f.load(0, 25);
    f.requests[0].finish(); await flushStartup();
    f.state.holdRecheck = true; f.requests[1].finish(); await flushStartup();
    const key = f.requests[1].context.url;
    assert.equal(f.engine.pinned(key), true, 'shared held-cache trimming cannot evict active revalidation coverage');
    if (action === 'abort') first.loader.abort(); else tick(25);
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

// Encoded-loader regression for the observed early-publication boundary.
// SN0/SN1 services are controlled941/4916ms from the captured trajectory;
// SN2+ later1000ms and the10ms ACK are explicit synthetic assumptions. No
// unrequested field response or WAN throughput is inferred from this fixture.
test('startup first-room publication retains a strict recovery surplus before starting its clock', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0, epoch = null, commitCalls = 0;
  t.mock.method(performance, 'now', () => 1000 + elapsed);
  const bytes = Uint8Array.from({ length: 6 * 1024 * 1024 }, (_, index) => index % 251), digest = sha(bytes);
  const sourceSamples = [], completions = [], checkpoints = [];
  const f = startupFixture(t, { timedStats: true, startupMaxBytes: 32 * 1024 * 1024,
    permit: ctx => ({ key: ctx.url, size: bytes.length, sha256: digest, current: () => true }),
    beforeSuccess: (ctx, stats) => {
      const serviceMs = stats.loading.end - stats.loading.start;
      sourceSamples.push(serviceMs);
      const sorted = [...sourceSamples].sort((a, b) => a - b);
      f.state.recovery = Math.max(2000, Math.round(sorted[Math.floor(sorted.length * .9)]) * 1.25 + 100);
      completions.push({ sn: ctx.frag.sn, elapsed, serviceMs, recoveryMs: f.state.recovery });
    },
    commit: ({ signal }) => {
      assert.equal(signal.aborted, false); commitCalls++; epoch = elapsed;
      return new Promise(resolve => setTimeout(resolve, 10));
    },
  });
  f.state.target = 0;
  const first = f.load(0, 12000);
  await flushStartup();
  while (elapsed < 12000 && !first.calls.success && !first.calls.error) {
    elapsed++;
    f.state.target = epoch === null ? 0 : (elapsed - epoch) / 1000;
    t.mock.timers.tick(1);
    for (const row of f.requests) {
      const serviceMs = row.context.frag.sn === 0 ? 941 : row.context.frag.sn === 1 ? 4916 : 1000;
      if (!row.response && !row.aborted && performance.now() - row.stats.loading.start >= serviceMs) row.finish(false, bytes);
    }
    await flushStartup();
    const warm = f.engine.snapshot(), startup = f.engine.startupSnapshot();
    assert(startup.heldObjects <= 4 && startup.heldBytes <= 32 * 1024 * 1024);
    assert(warm.cacheBytes + warm.reservationBytes <= 24 * 1024 * 1024 && warm.active <= 1);
    if ([941, 5857].includes(elapsed)) checkpoints.push({ elapsed, commitCalls, startup });
  }
  const final = f.engine.startupSnapshot();
  console.log(JSON.stringify({ fixture: 'startup-first-room-strict-surplus', elapsed, epoch, commitCalls, completions,
    checkpoints, requests: f.requests.map(row => row.context.frag.sn), final,
    calls: { success: first.calls.success, error: first.calls.error, abort: first.calls.abort } }));
  assert.equal(first.calls.success, 1, 'verified contiguous recovery must release before the unchanged12s deadline');
  assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0); assert(elapsed < 12000);
  assert.equal(checkpoints[0].commitCalls, 0, 'own[0,2] equal to R2000 must not publish an advancing room clock');
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 1, 2, 3]);
  assert.equal(commitCalls, 1); assert.equal(final.commitCompleted, true); assert.equal(final.released, 1);
  assert.equal(final.requiredHeadroomMs, 6245);
  assert((final.verifiedEnd - final.targetTime) * 1000 >= final.requiredHeadroomMs);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert(f.state.reservations.every(size => size <= 32 * 1024 * 1024));
});

test('startup without a commit hook still releases exact recovery equality', async t => {
  const f = startupFixture(t), first = f.load(0, 12000);
  f.state.target = 0;
  await requireOriginalVerified(f);
  const final = f.engine.startupSnapshot();
  assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
  assert.equal(final.verifiedEnd - final.targetTime, 2); assert.equal(final.requiredHeadroomMs, 2000);
  assert.equal(final.commitStarted, false); assert.equal(final.commitCompleted, false); assert.equal(final.released, 1);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
});

test('startup commit rechecks strict surplus after awaited authority instead of publishing at fresh equality', async t => {
  let commits = 0;
  const f = startupFixture(t, { commit: () => { commits++; } }), first = f.load(0, 12000);
  await requireOriginalVerified(f);
  f.state.holdRecheck = true; f.state.holdCheckSn = 0;
  f.requests[1].finish(); await flushStartup();
  assert.equal(typeof f.state.releaseRecheck, 'function'); assert.equal(commits, 0);
  f.state.target = 2; f.state.releaseRecheck(); await flushStartup();
  assert.equal(commits, 0, 'authority await cannot lend an earlier surplus to the external hook');
  assert.equal(first.calls.success, 0); assert.equal(f.engine.startupSnapshot().commitStarted, false);
  assert.equal(f.requests.length, 3); f.requests[2].finish(); await flushStartup();
  assert.equal(commits, 1); assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0);
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
  const tick = startupLogicalClock(t);
  for (const rejectLate of [false, true]) {
    let resolve, reject, signal, calls = 0;
    const f = startupFixture(t, { commit: value => { signal = value.signal; calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); } }), first = f.load(0, 25);
    f.requests[0].finish(); await flushStartup(); f.requests[1].finish(); await flushStartup();
    assert.equal(calls, 1); assert(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false); assert.equal(first.calls.error, 0); assert.equal(first.calls.success, 0);
    tick(24); await flushStartup();
    assert.equal(signal.aborted, false); assert.equal(first.calls.error, 0); assert.equal(first.calls.success, 0);
    tick(1); await flushStartup();
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

test('rolling startup can retain a third future after the held first interval is obsolete', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0; const origin = 1000;
  t.mock.method(performance, 'now', () => origin + elapsed);
  const f = startupFixture(t, { timedStats: true }); f.state.target = 0; f.state.recovery = 5000;
  const first = f.load(0, 8000), observations = [];
  const capture = () => observations.push({ startup: f.engine.startupSnapshot(), warm: f.engine.snapshot() });
  const advanceTo = async end => {
    while (elapsed < end) {
      const step = Math.min(100, end - elapsed); elapsed += step;
      f.state.target = elapsed / 1000; t.mock.timers.tick(step); await flushStartup();
    }
  };
  await requireOriginalVerified(f);
  await advanceTo(50); f.requests[1].finish(); await flushStartup();
  await advanceTo(1100); f.requests[2].finish(); await flushStartup();
  await advanceTo(4000);
  const successor = f.requests.find(row => row.context.frag.sn === 3);
  assert(successor, 'the original rolling planner requests its next contiguous future');
  await advanceTo(4050); successor.finish(); await flushStartup();
  await advanceTo(4500); f.state.recovery = 5000;
  capture();
  await advanceTo(4600); capture();
  const extra = f.requests.find(row => row.context.frag.sn === 4);
  assert(extra, 'the next [8,10] interval is parsed, authorised and admitted under the existing byte budget');
  await advanceTo(4650); extra.finish(); await flushStartup(); capture();
  const releasedBy4650 = first.calls.success;
  assert.equal(f.engine.snapshot().active, 0);
  assert(f.engine.startupSnapshot().heldObjects <= 4);
  assert(f.engine.startupSnapshot().heldBytes <= 24 * 1024 * 1024);
  assert(f.state.reservations.every(size => size <= 24 * 1024 * 1024));
  // The verified [4,6], [6,8], [8,10] bodies could provide 5.35s at
  // target4.65 while retaining the exact original response as object four.
  // These intervals and timings are controlled fixtures, not a WAN replay.
  assert(10 - f.state.target > f.state.recovery / 1000);
  assert.equal(releasedBy4650, 1, 'a feasible three-future window must not discard needed [4,6] coverage merely because the original first interval expired');
  assert(observations.some(row => row.startup.state === 'buffering' && row.startup.heldObjects === 4),
    'the extra body uses the fourth slot while the original response is still held');
  assert(observations.every(row => row.startup.heldObjects <= 4 && row.startup.heldBytes <= 24 * 1024 * 1024 && row.warm.active <= 1));
  assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  const completedRequests = f.requests.length;
  await advanceTo(8000);
  assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0);
  assert.equal(f.requests.length, completedRequests, 'the original deadline cannot restart released startup work');
});

test('startup extra-future byte refusal preserves useful coverage after the original interval expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1000; t.mock.method(performance, 'now', () => clock);
  const cap = 24 * 1024 * 1024;
  const f = startupFixture(t, { permitSize: sn => sn === 3 ? cap : 4 });
  const first = f.load(0, 8000); await fillStartupWindow(f);
  assert.equal(f.engine.startupSnapshot().verifiedStart, 2);
  assert.equal(f.engine.startupSnapshot().verifiedEnd, 6);
  clock += 100; t.mock.timers.tick(100); await flushStartup();
  const warm = f.engine.snapshot(), startup = f.engine.startupSnapshot();
  assert.equal(warm.rejected, 1, 'the fourth signed object exceeds the remaining unchanged byte budget');
  assert.equal(f.requests.length, 3, 'refusal happens before a fourth source load');
  assert.equal(warm.active, 0); assert.equal(warm.cacheObjects, 2); assert.equal(warm.cacheBytes, 8);
  assert.equal(startup.heldObjects, 3); assert.equal(startup.heldBytes, 12);
  assert.equal(startup.verifiedStart, 2); assert.equal(startup.verifiedEnd, 6,
    'byte refusal cannot evict the still-needed verified prefix');
  assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 0);
  assert(f.state.reservations.every(size => size <= cap));
  clock += 7899; t.mock.timers.tick(7899); await flushStartup();
  assert.equal(first.calls.error, 0, 'no early terminal or renewed deadline');
  clock++; t.mock.timers.tick(1); await flushStartup();
  assert.equal(first.calls.error, 1); assert.equal(first.calls.abort, 0); assert.equal(first.calls.success, 0);
  assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
  assert.equal(f.requests.length, 3); assert.equal(f.engine.snapshot().cacheBytes, 0);
  assert.equal(f.engine.snapshot().reservationBytes, 0);
  t.mock.timers.tick(1000); await flushStartup(); assert.equal(first.calls.error, 1);
});


// Controlled continuation after the saved run cancelled its fourth request;
// 8700ms is a test completion, not an observed WAN completion or decoder result.
async function startupBudgetCadence(t, parentMs = 20000) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let elapsed = 0;
  t.mock.method(performance, 'now', () => 1000 + elapsed);
  const f = startupFixture(t, { timedStats: true });
  f.state.target = 0; f.state.recovery = 7718.75;
  const first = f.load(0, parentMs), samples = [];
  const capture = () => samples.push({ startup: f.engine.startupSnapshot(), warm: f.engine.snapshot() });
  const to = async end => {
    while (elapsed < end) {
      const step = Math.min(100, end - elapsed);
      elapsed += step; t.mock.timers.tick(step); await flushStartup();
    }
    capture();
  };
  await requireOriginalVerified(f); capture();
  await to(6000); f.requests[1].finish(); await flushStartup(); capture();
  assert.equal(f.requests[2].context.frag.sn, 2);
  await to(7000); f.requests[2].finish(); await flushStartup(); capture();
  await to(7100); // Existing100ms poll admits the fourth verified-coverage successor.
  assert.equal(f.requests[3].context.frag.sn, 3, 'existing fourth residency slot supplies contiguous[6,8]');
  return { f, first, samples, to, capture };
}

test('startup load budget: controlled fourth body at8.7s releases within12s, without changing steady8s', async t => {
  const { f, first, samples, to, capture } = await startupBudgetCadence(t);
  await to(8700); f.requests[3].finish(); await flushStartup(); capture();
  assert.equal(first.calls.success, 1, 'a controlled feasible fourth completion after8s remains within the intentional startup budget');
  assert.equal(first.calls.error, 0); assert.equal(first.calls.abort, 0);
  assert.strictEqual(first.calls.args[0], f.requests[0].response);
  assert.strictEqual(first.calls.args[1], f.requests[0].stats);
  assert.strictEqual(first.calls.args[2], first.context);
  assert.equal(f.engine.startupSnapshot().requiredHeadroomMs, 7718.75);
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000);
  assert(samples.some(row => row.startup.state === 'buffering' && row.warm.limits.deadlineMs === 12000));
  assert(samples.some(row => row.startup.state === 'buffering' && row.startup.heldObjects === 4));
  assert(samples.every(row => row.startup.heldObjects <= 4 && row.startup.heldBytes <= 24 * 1024 * 1024 && row.warm.active <= 1));
  assert(f.state.reservations.every(bytes => bytes <= 24 * 1024 * 1024));
  assert.equal(f.engine.snapshot().limits.deadlineMs, 8000, 'released startup returns to steady request diagnostics');
  const count = f.requests.length; await to(20000);
  assert.equal(f.requests.length, count); assert.equal(first.calls.success, 1); assert.equal(first.calls.error, 0);
});

for (const parent of [20000, 9000]) test(`startup load budget: absolute ${Math.min(parent, 12000)} ms limit cannot renew through retry or late body`, async t => {
  const { f, first, to } = await startupBudgetCadence(t, parent), limit = Math.min(parent, 12000);
  await to(limit - 1); assert.equal(first.calls.error, 0, 'no early failure or per-step deadline renewal');
  assert.equal(f.engine.startupSnapshot().limits.deadlineMs, 12000);
  assert.equal(f.engine.snapshot().limits.deadlineMs, 12000);
  await to(limit); assert.equal(first.calls.error, 1);
  assert.equal(first.calls.args[0].startupBufferReason, 'deadline');
  assert.equal(f.requests[3].aborted, true); assert.equal(f.engine.startupSnapshot().state, 'failed');
  const count = f.requests.length; f.requests[3].finish(true); await flushStartup();
  const retry = f.load(0, 20000); assert.equal(retry.calls.error, 1); assert.equal(f.requests.length, count);
  await to(20000); assert.equal(first.calls.success, 0); assert.equal(first.calls.error, 1);
  assert.equal(f.engine.snapshot().reservationBytes, 0); assert.equal(f.engine.snapshot().cacheBytes, 0);
  assert.equal(f.engine.snapshot().limits.deadlineMs, 8000);
});

test('a canceled warm verifier retains its default slot and body reservation until actual settlement', async t => {
  let release; t.after(() => release?.());
  const f = startupFixture(t, {
    beforeVerify: ctx => ctx.frag.sn === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  const first = f.load(0, 12000); await requireOriginalVerified(f);
  f.requests[1].finish(); await flushStartup();
  first.loader.abort(); await flushStartup();
  assert.equal(first.calls.abort, 1); assert.equal(f.engine.snapshot().active, 1);
  assert.equal(f.engine.snapshot().reservationBytes, 4, 'the default path cannot hide a still-owned whole body either');
  release(); await flushStartup();
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
  assert.equal(f.retained.length, 0); assert.equal(first.calls.success, 0);
});

test('canceled warm authorisation retains its slot until rejection without starting HTTP', async t => {
  let reject; t.after(() => reject?.(new Error('fixture retired')));
  const bytes = Uint8Array.of(2, 4, 6, 8);
  const f = startupFixture(t, { permit: ctx => ctx.frag.sn === 1
    ? new Promise((_resolve, fail) => { reject = fail; })
    : { key: ctx.url, size: bytes.length, sha256: sha(bytes), current: () => true } });
  const first = f.load(0, 12000); await requireOriginalVerified(f);
  assert.equal(typeof reject, 'function');
  first.loader.abort(); await flushStartup();
  assert.equal(first.calls.abort, 1);
  assert.equal(f.engine.snapshot().active, 1);
  assert.equal(f.engine.snapshot().reservationBytes, 0);
  assert.equal(f.requests.length, 1, 'cancelled authorisation cannot create a future HTTP request');
  reject(new Error('fixture refusal')); await flushStartup();
  assert.equal(f.engine.snapshot().active, 0);
  assert.equal(f.engine.snapshot().reservationBytes, 0);
  assert.equal(f.requests.length, 1); assert.equal(first.calls.success, 0);
});

test('a canceled warm verifier releases its retained body on rejection without delivery', async t => {
  let reject; t.after(() => reject?.(new Error('fixture retired')));
  const f = startupFixture(t, {
    beforeVerify: ctx => ctx.frag.sn === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : undefined });
  const first = f.load(0, 12000); await requireOriginalVerified(f);
  f.requests[1].finish(); await flushStartup();
  first.loader.abort(); await flushStartup();
  assert.equal(f.engine.snapshot().active, 1);
  assert.equal(f.engine.snapshot().reservationBytes, 4);
  reject(new Error('fixture refusal')); await flushStartup();
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
  assert.equal(f.retained.length, 0); assert.equal(first.calls.success, 0);
});

test('retired warm rows keep ownership but cannot cover a seek position', async t => {
  let release; t.after(() => release?.());
  const f = startupFixture(t, {
    beforeVerify: ctx => ctx.frag.sn === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  const first = f.load(0, 12000); await requireOriginalVerified(f);
  f.requests[1].finish(); await flushStartup();
  first.loader.abort(); await flushStartup();
  assert.equal(f.engine.snapshot().active, 1);
  assert.equal(f.engine.snapshot().reservationBytes, 4);
  assert.equal(f.engine.contains(2.5), false, 'retired data is retained memory, not current media coverage');
  release(); await flushStartup(); assert.equal(f.engine.snapshot().reservationBytes, 0);
});

test('retired warm rows outside a new demand plan do not invalidate its actual seek position', async t => {
  let release; t.after(() => release?.());
  const f = startupFixture(t, { startup: false, steady: true,
    beforeVerify: ctx => ctx.frag.sn === 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  f.load(0, 12000); await flushStartup();
  f.requests[1].finish(); await flushStartup();
  const current = f.load(4, 12000); await flushStartup();
  assert.equal(current.calls.abort, 0); assert.equal(current.calls.error, 0);
  assert.equal(f.engine.snapshot().active, 1);
  assert.equal(f.engine.snapshot().reservationBytes, 4);
  assert.equal(f.engine.contains(9), true, 'the current genuine8–10s demand remains valid despite an old canceled2–4s row');
  assert.equal(f.engine.contains(2.5), false);
  release(); await flushStartup(); assert.equal(f.engine.snapshot().reservationBytes, 0);
});


for (const refusal of ['false', 'throw']) test(`warm speculative source refusal ${refusal} leaves genuine demand immediate`, async t => {
  const decisions = [];
  const f = startupFixture(t, { startup: false, steady: true, prefetch: context => {
    decisions.push(context.frag.sn);
    if (context.frag.sn !== 1) return true;
    if (refusal === 'throw') throw Error('fixture unavailable owner');
    return false;
  } });
  const first = f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  assert.equal(first.calls.success, 1);
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0, 2], 'unowned future is skipped while the next authorised future can run');
  const demand = f.load(1, 12000);
  const genuine = f.requests.find(row => row.context === demand.context);
  assert(genuine, 'genuine source begins synchronously despite speculative refusal');
  genuine.finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(demand.calls.error, 0); assert.equal(demand.calls.abort, 0);
  assert.deepEqual(decisions, [1, 2]);
  assert.equal(f.engine.snapshot().verifiedPeerBytes, 0); assert.equal(f.engine.snapshot().consumedPeerBytes, 0);
});

for (const ending of ['clear', 'stop']) test(`warm speculative owner callback cannot start work after reentrant ${ending}`, async t => {
  let f, checks = 0;
  f = startupFixture(t, { startup: false, steady: true, prefetch: () => {
    checks++; f.engine[ending](); return true;
  } });
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  assert.equal(checks, 1);
  assert.deepEqual(f.requests.map(row => row.context.frag.sn), [0]);
  assert.equal(f.engine.snapshot().active, 0); assert.equal(f.engine.snapshot().reservationBytes, 0);
});

test('warm speculative owner decision cannot deny a genuine promotion awaiting authority', async t => {
  let release, held = false;
  const checks = [];
  const f = startupFixture(t, { startup: false, steady: true, reuseBudget: () => 25,
    permit: context => {
      const permit = { key: context.url, size: 4, sha256: sha(Uint8Array.of(2, 4, 6, 8)), current: () => true };
      if (context.frag.sn !== 1 || held) return permit;
      held = true; return new Promise(resolve => { release = () => resolve(permit); });
    },
    prefetch: context => { checks.push(context.frag.sn); return false; } });
  t.after(() => release?.());
  f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  assert.equal(typeof release, 'function');
  const demand = f.load(1, 12000); release(); await flushStartup();
  const promoted = f.requests.find(row => row.context.frag.sn === 1);
  assert(promoted); assert(!checks.includes(1), 'the speculative policy is bypassed after real promotion');
  promoted.finish(); await flushStartup();
  assert.equal(demand.calls.success, 1); assert.equal(demand.calls.error, 0);
  assert.equal(f.requests.filter(row => row.context.frag.sn === 1).length, 1);
});

test('warm speculative owner refusal does not limit startup coverage', async t => {
  let f; const states = [];
  f = startupFixture(t, { steady: true, prefetch: () => { states.push(f.engine.startupSnapshot().state); return false; } });
  const first = f.load(0, 12000); f.requests[0].finish(); await flushStartup();
  assert.equal(f.engine.startupSnapshot().state, 'buffering');
  const future = f.requests.find(row => row.context.frag.sn === 1); assert(future);
  future.finish(); await flushStartup();
  assert.equal(first.calls.success, 1); assert.equal(f.engine.startupSnapshot().state, 'ready');
  assert(states.every(state => state === 'ready'), 'startup admits its own required coverage before steady ownership decisions');
});
