import test from "node:test";
import assert from "node:assert/strict";
import { createPersistentUploadBudget } from "../demo/upload-budget.mjs";
const environment = () => {
  const records = new Map(); let pending = Promise.resolve();
  return { records, storage: { getItem: (id) => records.get(id) ?? null, setItem: (id, value) => records.set(id, value) },
    locks: { request(_name, _options, callback) { const next = pending.then(callback); pending = next.catch(() => {}); return next; } } };
};
test("concurrent tabs cannot reserve beyond durable cap and full reload does not reset spent bytes", async () => {
  const env = environment(), options = { ...env, defaultLimit: 100 };
  const first = createPersistentUploadBudget(options), second = createPersistentUploadBudget(options);
  const result = await Promise.all([first.reserve(70), second.reserve(70)]);
  assert.deepEqual(result, [true, false]);
  assert.equal(createPersistentUploadBudget(options).snapshot().remaining, 30);
  assert.equal(await second.setLimit(150), true);
  assert.equal(await first.reserve(80), true);
  assert.equal(second.snapshot().remaining, 0);
  assert.equal(await second.reset(), true); assert.equal(first.snapshot().spent, 0);
  assert.deepEqual(Object.keys(JSON.parse([...env.records.values()][0])).sort(), ["limit", "revision", "spent", "v"]);
});
test("blocked, corrupt, torn or non-atomic storage fails closed", async () => {
  for (const modification of [
    (env) => { env.storage.getItem = () => { throw new Error("blocked"); }; },
    (env) => { env.storage.setItem = () => { throw new Error("quota"); }; },
    (env) => { env.storage.setItem = () => {}; },
    (env) => { env.records.set("relayswarm-upload-budget-v1", "{"); },
    (env) => { env.locks = null; },
  ]) {
    const env = environment(); modification(env);
    const budget = createPersistentUploadBudget({ ...env, defaultLimit: 100 });
    assert.equal(await budget.reserve(1), false); assert.equal(budget.snapshot().remaining, 0);
  }
});
test("only an explicit reset can recover a corrupt or previously unavailable quota", async () => {
  const env = environment(); env.records.set("relayswarm-upload-budget-v1", "broken");
  const budget = createPersistentUploadBudget({ ...env, defaultLimit: 100 });
  assert.equal(budget.snapshot().available, false); assert.equal(await budget.setLimit(200), false);
  assert.equal(await budget.reset(200), true); assert.equal(budget.snapshot().remaining, 200);
  assert.equal(await budget.reserve(200), true); assert.equal(await budget.reserve(1), false);
});
