import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fetchOriginRange, originRangeFor } from "../src/browser/origin-range.mjs";
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
  test(`an origin that answers a range with ${mode} bytes yields nothing`, async (t) => {
    const { url } = await origin(t, mode);
    assert.equal(await fetchOriginRange({ url }, 0, 65_536), null);
  });
}

test("an aborted or unreachable ranged fetch yields nothing", async (t) => {
  const { url } = await origin(t);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await fetchOriginRange({ url }, 0, 10, { signal: controller.signal }), null);
  assert.equal(await fetchOriginRange({ url: "http://127.0.0.1:1/x" }, 0, 10), null);
});
