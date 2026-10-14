import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { startNativeTestInfrastructure } from "./support/native-fixture.mjs";

test("native fixture closes an acquired relay exactly once when DHT setup rejects", async () => {
  const failure = new Error("deliberate DHT setup failure");
  let closes = 0;
  await assert.rejects(startNativeTestInfrastructure({
    startRelay: async () => ({ close() { closes++; } }),
    startDht: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(closes, 1);
});

test("native fixture retains its setup rejection if relay cleanup also rejects", async () => {
  const failure = new Error("deliberate DHT setup failure");
  let closes = 0;
  await assert.rejects(startNativeTestInfrastructure({
    startRelay: async () => ({ close() { closes++; throw new Error("deliberate cleanup failure"); } }),
    startDht: async () => { throw failure; },
  }), (error) => error === failure);
  assert.equal(closes, 1);
});

test("native fixture hands successful setup to the existing test cleanup without closing it", async () => {
  let closes = 0;
  const relay = { close() { closes++; } }, dht = { close() { closes++; } };
  const result = await startNativeTestInfrastructure({ startRelay: async () => relay, startDht: async () => dht });
  assert.equal(result.relay, relay);
  assert.equal(result.dht, dht);
  assert.equal(closes, 0);
});

test("native fixture does not attempt DHT setup after relay acquisition rejects", async () => {
  const failure = new Error("deliberate relay setup failure");
  let dhtCalls = 0;
  await assert.rejects(startNativeTestInfrastructure({
    startRelay: async () => { throw failure; },
    startDht: async () => { dhtCalls++; },
  }), (error) => error === failure);
  assert.equal(dhtCalls, 0);
});

test("a real native-fixture subprocess exits naturally after DHT setup rejects behind a live relay", { timeout: 8000 }, () => {
  const helper = new URL("./support/native-fixture.mjs", import.meta.url).href;
  const localRelay = new URL("./support/local-relay.mjs", import.meta.url).href;
  const code = `
    import assert from "node:assert/strict";
    import { startNativeTestInfrastructure } from ${JSON.stringify(helper)};
    import { startLocalRelay } from ${JSON.stringify(localRelay)};
    const failure = new Error("deliberate DHT setup failure");
    let closes = 0;
    await assert.rejects(startNativeTestInfrastructure({
      startRelay: async () => {
        const relay = await startLocalRelay();
        return { close() { closes++; return relay.close(); } };
      },
      startDht: async () => { throw failure; },
    }), (error) => error === failure);
    assert.equal(closes, 1);
    console.log(JSON.stringify({ ok: true, relayCloseCalls: closes, originalErrorRetained: true }));
  `;
  // No process.exit/force-exit: a leaked relay listener keeps this child alive
  // until the finite parent timeout kills it, which must fail this regression.
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    timeout: 5000, killSignal: "SIGKILL", maxBuffer: 8192, encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, relayCloseCalls: 1, originalErrorRetained: true });
});
