import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchOriginRange, loadOriginRange, originRangeFor } from "../src/browser/origin-range.mjs";
import { httpRange } from "../demo/server.mjs";

const file = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7 + 3) & 255);

/** Serves `file` honouring Range as the demo does, or misbehaving on request. */
async function origin(t, mode = "honour") {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.headers.range ?? null);
    const range = httpRange(request.headers.range, file.length);
    if (mode === "ignore" || !range) return response.writeHead(200, { "content-length": file.length }).end(Buffer.from(file));
    const { start, end } = range;
    const body = Buffer.from(file.subarray(start, end + 1));
    if (mode === "short") return response.writeHead(206, { "content-range": `bytes ${start}-${end}/${file.length}` }).end(body.subarray(1));
    if (mode === "shifted") return response.writeHead(206, { "content-range": `bytes ${start + 1}-${end + 1}/${file.length}` }).end(body);
    response.writeHead(206, { "content-range": `bytes ${start}-${end}/${file.length}`, "content-length": body.length }).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/media/seg.ts`, seen };
}

test("a ranged origin fetch returns exactly the requested bytes", async (t) => {
  const { url, seen } = await origin(t);
  const bytes = await fetchOriginRange({ url }, 65_536, 196_608);
  assert.deepEqual(bytes, file.subarray(65_536, 196_608));
  assert.deepEqual(seen, ["bytes=65536-196607"]);
});

test("a byte-range segment offsets pieces by its own start and stays inside its end", async (t) => {
  const { url, seen } = await origin(t);
  const context = { url, rangeStart: 10_000, rangeEnd: 210_000 };
  assert.deepEqual(await fetchOriginRange(context, 65_536, 131_072), file.subarray(75_536, 141_072));
  assert.deepEqual(seen, ["bytes=75536-141071"]);
  assert.equal(originRangeFor(context, 196_608, 200_001), null, "past the segment's end");
  assert.deepEqual(originRangeFor(context, 196_608, 200_000), { first: 206_608, last: 209_999 });
  assert.equal(originRangeFor({}, 5, 5), null);
});

for (const mode of ["ignore", "short", "shifted"]) {
  test(`an origin that answers a range with ${mode} bytes yields nothing and reports it`, async (t) => {
    const { url } = await origin(t, mode);
    let ignored = 0;
    assert.equal(await fetchOriginRange({ url }, 0, 65_536, { onIgnored: () => { ignored += 1; } }), null);
    assert.equal(ignored, 1);
  });
}

test("a ranged fetch that fails without an answer is not reported as an ignored range", async (t) => {
  const { url } = await origin(t);
  let ignored = 0;
  const onIgnored = () => { ignored += 1; };
  assert.equal(await fetchOriginRange({ url: "http://127.0.0.1:1/x" }, 0, 10, { onIgnored }), null);
  const fetchImpl = async () => new Response("no", { status: 416 });
  assert.equal(await fetchOriginRange({ url }, 0, 10, { onIgnored, fetchImpl }), null);
  assert.equal(ignored, 0);
});

test("an aborted or unreachable ranged fetch yields nothing", async (t) => {
  const { url } = await origin(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await fetchOriginRange({ url }, 0, 10, { signal: controller.signal }), null);
  assert.equal(await fetchOriginRange({ url: "http://127.0.0.1:1/x" }, 0, 10), null);
});

/** A player loader over `file`; `mode` misbehaves on request. */
function playerLoader(mode = "honour") {
  const seen = [];
  class PlayerLoader {
    stats = {};
    constructor(config) { this.config = config; }
    load(context, config, callbacks) {
      seen.push({ context, config, hlsConfig: this.config });
      if (mode === "hang") return;
      if (mode === "error") return callbacks.onError({ code: 416, text: "Range Not Satisfiable" }, context, null, this.stats);
      const body = mode === "whole" ? file : file.subarray(context.rangeStart, context.rangeEnd);
      queueMicrotask(() => callbacks.onSuccess({ data: body.slice().buffer }, this.stats, context, null));
    }
    abort() { this.aborted = true; }
    destroy() { this.destroyed = true; }
  }
  return { Loader: PlayerLoader, seen };
}

test("a ranged load through the player's loader sets its range and passes its configs", async () => {
  const { Loader, seen } = playerLoader();
  const origin = { Loader, config: { xhrSetup() {} }, loaderConfig: { loadPolicy: {} } };
  const context = { url: "https://origin.example/media/seg.ts", rangeStart: 10_000, rangeEnd: 210_000, frag: { sn: 4 } };
  assert.deepEqual(await loadOriginRange(origin, context, 65_536, 131_072), file.subarray(75_536, 141_072));
  assert.equal(seen[0].context.rangeStart, 75_536);
  assert.equal(seen[0].context.rangeEnd, 141_072, "exclusive, as hls.js expects");
  assert.equal(seen[0].context.frag, context.frag);
  assert.equal(seen[0].hlsConfig, origin.config);
  assert.equal(seen[0].config, origin.loaderConfig);
  assert.equal(context.rangeStart, 10_000, "the caller's context is unchanged");
});

for (const mode of ["whole", "error"]) {
  test(`a player loader that answers a range with ${mode === "whole" ? "the whole segment" : "an error"} yields nothing`, async () => {
    const { Loader } = playerLoader(mode);
    let ignored = 0;
    assert.equal(await loadOriginRange({ Loader }, { url: "https://origin.example/x" }, 0, 65_536, { onIgnored: () => { ignored += 1; } }), null);
    assert.equal(ignored, mode === "whole" ? 1 : 0, "only a successful load of the wrong length is an ignored range");
  });
}

test("an aborted ranged load aborts the player's loader and yields nothing", async () => {
  const { Loader, seen } = playerLoader("hang");
  let instance = null;
  class Tracked extends Loader { constructor(config) { super(config); instance = this; } }
  const controller = new AbortController();
  const pending = loadOriginRange({ Loader: Tracked }, { url: "https://origin.example/x" }, 0, 10, { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, null);
  assert.ok(instance.aborted && instance.destroyed);
  assert.equal(seen.length, 1);
  assert.equal(await loadOriginRange({ Loader }, { url: "https://origin.example/x" }, 0, 10, { signal: controller.signal }), null);
  assert.equal(seen.length, 1, "an already aborted signal loads nothing");
});

test("ranged loader outcomes distinguish HTTP, timeout, cancellation and wrong-size responses exactly once", async t => {
  for (const outcome of ["payload", "error", "timeout", "abort", "wrong-size", "exception", "invalid-request"]) await t.test(outcome, async () => {
    const observed = [], controller = new AbortController();
    class Loader {
      load(_context, _config, callbacks) {
        this.callbacks = callbacks;
        if (outcome === "exception") throw new Error("private failure text");
        if (outcome === "error") callbacks.onError({ code: 416, text: "private failure text" });
        else if (outcome === "timeout") callbacks.onTimeout();
        else if (outcome === "abort") controller.abort();
        else callbacks.onSuccess({ code: 206, data: new Uint8Array(outcome === "wrong-size" ? 2 : 4).buffer });
      }
      abort() { this.callbacks?.onAbort(); }
      destroy() {}
    }
    const value = await loadOriginRange({ Loader }, { url: "https://origin.example/media/seg.ts" }, 0, outcome === "invalid-request" ? 0 : 4,
      { signal: controller.signal, onResult: value => { observed.push(value); throw new Error("host observer failed"); } });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].outcome, outcome);
    assert.deepEqual(Object.keys(observed[0]).sort(), ["expectedBytes", "httpStatus", "outcome", "receivedBytes"]);
    assert.equal(observed[0].httpStatus, outcome === "error" ? 416 : ["payload", "wrong-size"].includes(outcome) ? 206 : null);
    assert.equal(observed[0].receivedBytes, outcome === "payload" ? 4 : outcome === "wrong-size" ? 2 : null);
    assert.equal(value?.byteLength ?? null, outcome === "payload" ? 4 : null);
  });
});

test('range admission runs immediately before the original loader invocation and may refuse it', async () => {
  const { Loader, seen } = playerLoader(), order = [];
  class Observed extends Loader { load(...args) { order.push('invoke'); return super.load(...args); } }
  const origin = { Loader: Observed };
  assert.equal(await loadOriginRange(origin, { url: 'https://origin.example/x' }, 0, 65536,
    { beforeLoad: () => { order.push('guard'); return false; } }), null);
  assert.deepEqual(order, ['guard']); assert.equal(seen.length, 0);
  const bytes = await loadOriginRange(origin, { url: 'https://origin.example/x' }, 0, 65536,
    { beforeLoad: () => { order.push('guard'); return true; } });
  assert.deepEqual(bytes, file.subarray(0, 65536)); assert.deepEqual(order, ['guard', 'guard', 'invoke']);
});

test('range admission cancellation or throwing cannot invoke the original loader or settle twice', async () => {
  for (const action of ['abort', 'throw']) {
    const { Loader, seen } = playerLoader(), controller = new AbortController(), results = [];
    assert.equal(await loadOriginRange({ Loader }, { url: 'https://origin.example/x' }, 0, 65536,
      { signal: controller.signal, onResult: row => results.push(row), beforeLoad: () => {
        if (action === 'throw') throw Error('fixture refusal');
        controller.abort(); return true;
      } }), null);
    assert.equal(seen.length, 0); assert.equal(results.length, 1);
    assert.equal(results[0].outcome, action === 'abort' ? 'abort' : 'exception');
  }
});
