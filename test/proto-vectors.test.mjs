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
