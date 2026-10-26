import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadPacer } from '../src/browser/upload-pacing.mjs';

function fixture(t, { maxWaiters = 3 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let at = 0, tokens = 0, refilledAt = 0, valid = true, refunds = 0;
  const rate = 4 * 1024 * 1024, grants = [], refusals = [];
  const refill = () => { tokens = Math.min(rate * 2, tokens + Math.max(0, at - refilledAt) * rate / 1000); refilledAt = at; };
  const pacer = createUploadPacer({ now: () => at, maxWaiters,
    take: charge => { refill(); if (tokens < charge) return false; tokens -= charge; grants.push({ at, charge }); return true; },
    give: charge => { refunds += charge; tokens = Math.min(rate * 2, tokens + charge); },
    delay: charge => { refill(); return Math.max(0, (charge - tokens) * 1000 / rate); },
    validate: row => { assert(!('data' in row)); assert(!Object.values(row).some(value => value instanceof ArrayBuffer || ArrayBuffer.isView(value))); return valid; },
    refuse: reason => refusals.push(reason),
  });
  t.after(() => { pacer.stop(); t.mock.timers.reset(); });
  return { pacer, rate, grants, refusals, get refunds() { return refunds; },
    invalidate() { valid = false; pacer.recheck(); },
    async advance(ms) { at += ms; t.mock.timers.tick(ms); await Promise.resolve(); await Promise.resolve(); },
    acquire(link = {}, extra = {}) { return pacer.acquire(link, { key: 'fixture', size: 6 * 1024 * 1024, charge: 393216, range: { start: 0, end: 4 }, ...extra }); } };
}

test('paced FIFO grants canonical pieces at the unchanged four-MiB refill rate and expires at 250ms', async t => {
  const f = fixture(t), a = f.acquire(), b = f.acquire(), c = f.acquire();
  assert.equal(f.pacer.snapshot().queued, 3);
  await f.advance(94); const first = await a;
  assert(first); assert.equal(f.pacer.snapshot().granted, 1);
  await f.advance(94); const second = await b;
  assert(second); assert.equal(f.pacer.snapshot().granted, 2);
  await f.advance(62); assert.equal(await c, null);
  assert.deepEqual(f.grants.map(row => row.at), [94, 188]);
  assert(f.grants.reduce((sum, row) => sum + row.charge, 0) <= f.rate * 0.25);
  assert.equal(f.pacer.snapshot().expired, 1);
  assert.equal(f.pacer.snapshot().waited, 3);
  assert.equal(f.pacer.snapshot().waitTotalMs, 94 + 188 + 250);
  assert.equal(f.pacer.snapshot().waitMaxMs, 250);
  f.pacer.finish(first, true); f.pacer.finish(second, true);
  assert.equal(f.pacer.snapshot().reservedBytes, 0); assert.equal(f.refunds, 0);
});

test('paced waiting is bounded per link/globally and stores no supplied bulk buffer', async t => {
  const f = fixture(t, { maxWaiters: 1 }), link = {};
  const held = f.acquire(link, { data: new Uint8Array(100) });
  assert.equal(await f.acquire(link), null); assert.equal(await f.acquire({}), null);
  assert.equal(f.pacer.snapshot().queued, 1);
  f.pacer.cancel(link); assert.equal(await held, null);
  assert.equal(f.pacer.snapshot().queued, 0); assert.equal(f.pacer.snapshot().refused, 2);
});

for (const ending of ['invalidate', 'close', 'stop']) test(`paced ${ending} settles waiting work without a late grant`, async t => {
  const f = fixture(t), link = {}, waiting = f.acquire(link);
  if (ending === 'invalidate') f.invalidate();
  else if (ending === 'close') f.pacer.cancel(link);
  else f.pacer.stop();
  assert.equal(await waiting, null);
  await f.advance(500); assert.equal(f.grants.length, 0);
  assert.equal(f.pacer.snapshot().queued, 0); assert.equal(f.pacer.snapshot().reservedBytes, 0);
});

test('paced local cancellation refunds an owned rate reservation only once', async t => {
  const f = fixture(t), link = {}, waiting = f.acquire(link);
  await f.advance(100); const reservation = await waiting;
  f.pacer.cancel(link); assert.equal(reservation.controller.signal.aborted, true);
  f.pacer.finish(reservation); f.pacer.cancel(link); f.pacer.stop();
  assert.equal(f.refunds, 393216); assert.equal(f.pacer.snapshot().reservedBytes, 0);
});

test('paced whole objects retain immediate refusal instead of a refill wait', async t => {
  const f = fixture(t);
  assert.equal(await f.acquire({}, { range: null, charge: 6 * 1024 * 1024 }), null);
  assert.equal(f.pacer.snapshot().queued, 0); assert.equal(f.pacer.snapshot().waited, 0);
});

test('paced delayed expiry never grants overdue work even when the bucket has refilled', async t => {
  const f = fixture(t), waiting = f.acquire();
  await f.advance(500);
  assert.equal(await waiting, null); assert.equal(f.grants.length, 0);
  assert.equal(f.pacer.snapshot().expired, 1); assert.equal(f.pacer.snapshot().waitMaxMs, 500);
});
