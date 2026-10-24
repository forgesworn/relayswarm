import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normaliseContext, runVectorCase } from "./proto-vectors.mjs";

const vectors = JSON.parse(await readFile(new URL("../core/vectors/commitments.json", import.meta.url), "utf8"));

test("committed commitment vectors still match the JavaScript verifier", () => {
  assert.ok(vectors.cases.length > 100);
  for (const entry of vectors.cases) {
    assert.deepEqual(runVectorCase(entry, vectors.at), entry.expected, entry.name);
    assert.equal(entry.expected === null ? "reject" : "accept", entry.intent, entry.name);
    if (entry.context) assert.deepEqual(normaliseContext(entry.context), entry.normalised, entry.name);
  }
});

test("a remembered signature verdict never accepts a changed event", async () => {
  // Every vector again, now with every accepted signature remembered: a
  // rejection that differs from an accepted event in any field still rejects.
  for (const entry of vectors.cases) assert.deepEqual(runVectorCase(entry, vectors.at), entry.expected, `${entry.name} (warm)`);
  const { validStreamAuthorisation } = await import("../src/browser/segment-commitment.mjs");
  const stream = vectors.cases.find((entry) => entry.op === "stream" && entry.expected === true).event;
  assert.equal(validStreamAuthorisation(stream), true);
  assert.equal(validStreamAuthorisation(structuredClone(stream)), true);
  assert.equal(validStreamAuthorisation({ ...stream, content: `${stream.content} ` }), false);
  assert.equal(validStreamAuthorisation({ ...stream, created_at: stream.created_at + 1 }), false);
  assert.equal(validStreamAuthorisation({ ...stream, sig: [stream.sig] }), false);
  assert.equal(validStreamAuthorisation({ ...stream, sig: `${stream.sig.slice(0, -1)}${stream.sig.at(-1) === "0" ? "1" : "0"}` }), false);
  assert.equal(validStreamAuthorisation({ ...stream, id: stream.id.toUpperCase() }), false);
});

const traces = JSON.parse(await readFile(new URL("../core/vectors/link-traces.json", import.meta.url), "utf8"));
const { runLinkTrace } = await import("./link-traces.mjs");

test("committed link traces still match the JavaScript PeerLink", async () => {
  assert.ok(traces.traces.length > 40);
  for (const trace of traces.traces) assert.deepEqual(await runLinkTrace(trace), trace.expected, trace.name);
});
