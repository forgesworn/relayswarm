import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createSocket } from "node:dgram";
import test from "node:test";
import DHT from "hyperdht";
import { startNativeTestInfrastructure } from "./support/native-fixture.mjs";
import { startLocalDht } from "./support/local-dht.mjs";

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

test("local DHT retains four kernel-owned ports and verifies every responder before handing them over", { timeout: 10000 }, async () => {
  const nodes = [], pings = [], destroys = [];
  let fixture;
  try {
    fixture = await startLocalDht({ createNode(options) {
      assert.deepEqual(options.port, [0, 1]);
      assert.equal(options.host, "127.0.0.1");
      assert.equal(options.bootstrap.length, nodes.length);
      const node = new DHT(options), ping = node.ping.bind(node), destroy = node.destroy.bind(node);
      node.ping = async address => { const result = await ping(address); pings.push(address); return result; };
      node.destroy = async options => { destroys.push(node); return destroy(options); };
      nodes.push(node);
      return node;
    } });
    assert.equal(nodes.length, 4);
    assert.equal(new Set(fixture.bootstrap).size, 4);
    assert.deepEqual(fixture.bootstrap, nodes.map(node => `127.0.0.1:${node.address().port}`));
    assert.deepEqual(new Set(pings.map(({ host, port }) => `${host}:${port}`)), new Set(fixture.bootstrap), "all four real RPCs answered");
    for (const node of nodes) {
      const socket = createSocket("udp4");
      try {
        await assert.rejects(new Promise((resolve, reject) => {
          socket.once("error", reject);
          socket.bind(node.address().port, "127.0.0.1", resolve);
        }), { code: "EADDRINUSE" });
      } finally { socket.close(); }
    }
  } finally { await fixture?.close(); await fixture?.close(); }
  assert.equal(destroys.length, 4, "fixture close is idempotent");
  assert.equal(new Set(destroys).size, 4);
});

test("partial local DHT setup closes native sockets, watchers and the relay without replacing its error", { timeout: 20000 }, async t => {
  const helper = new URL("./support/native-fixture.mjs", import.meta.url).href;
  const localDht = new URL("./support/local-dht.mjs", import.meta.url).href;
  const localRelay = new URL("./support/local-relay.mjs", import.meta.url).href;
  const dhtModule = import.meta.resolve("hyperdht");
  for (const phase of ["constructor", "ready-and-destroy", "occupied-bind"]) await t.test(phase, () => {
    const code = `
      import assert from "node:assert/strict";
      import { createSocket } from "node:dgram";
      import DHT from ${JSON.stringify(dhtModule)};
      import { startNativeTestInfrastructure } from ${JSON.stringify(helper)};
      import { startLocalDht } from ${JSON.stringify(localDht)};
      import { startLocalRelay } from ${JSON.stringify(localRelay)};
      const phase = process.argv[1], resources = [];
      let original = Object.assign(new Error("deliberate setup failure"), { code: "EADDRINUSE" });
      let blocker, caught, returned, created = 0, destroyed = 0, relayCloses = 0;
      try {
        if (phase === "occupied-bind") {
          blocker = createSocket("udp4");
          await new Promise((resolve, reject) => { blocker.once("error", reject); blocker.bind(0, "127.0.0.1", resolve); });
        }
        try {
          returned = await startNativeTestInfrastructure({
            startRelay: async () => {
              const relay = await startLocalRelay();
              return { close() { relayCloses++; return relay.close(); } };
            },
            startDht: () => startLocalDht({ createNode(options) {
              const index = created++;
              for (const method of ["createSocket", "watchNetworkInterfaces"]) {
                const make = options.udx[method].bind(options.udx);
                options.udx[method] = (...args) => {
                  const resource = make(...args), observation = { closed: false };
                  resources.push(observation);
                  resource.once("close", () => { observation.closed = true; });
                  if (phase === "occupied-bind" && index === 1 && method === "createSocket") {
                    const bind = resource.bind.bind(resource);
                    resource.bind = (_port, host, ...rest) => bind(blocker.address().port, host, ...rest);
                  }
                  return resource;
                };
              }
              if (phase !== "occupied-bind") {
                const socket = options.udx.createSocket(); socket.bind(0, options.host);
                options.udx.watchNetworkInterfaces();
                if (phase === "constructor") throw original;
                return {
                  async fullyBootstrapped() { if (index === 1) throw original; },
                  address: () => socket.address(),
                  destroy() { destroyed++; throw new Error("deliberate destroy failure"); },
                };
              }
              const node = new DHT(options), ready = node.fullyBootstrapped.bind(node), destroy = node.destroy.bind(node);
              node.fullyBootstrapped = async () => { try { return await ready(); } catch (error) { original = error; throw error; } };
              node.destroy = async options => { destroyed++; return destroy(options); };
              return node;
            } }),
          });
        } catch (error) { caught = error; }
        assert.equal(caught, original);
        assert.equal(caught.code, "EADDRINUSE");
        assert.equal(created, phase === "constructor" ? 1 : 2);
        assert.equal(destroyed, phase === "constructor" ? 0 : 2);
        assert.ok(resources.length >= 2);
        assert.ok(resources.every(resource => resource.closed), "all allocated public UDX resources closed even when DHT destroy rejects");
        assert.equal(relayCloses, 1);
        console.log(JSON.stringify({ ok: true, phase, originalErrorRetained: true, allNativeResourcesClosed: true, relayCloses }));
      } finally {
        if (returned) await Promise.allSettled([returned.dht.close(), returned.relay.close()]);
        if (blocker) await new Promise(resolve => blocker.close(resolve));
      }
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", code, phase], {
      timeout: 4500, killSignal: "SIGKILL", maxBuffer: 16384, encoding: "utf8", windowsHide: true,
    });
    // A forced exit or a leaked interface watcher must fail this regression.
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, phase, originalErrorRetained: true, allNativeResourcesClosed: true, relayCloses: 1 });
  });
});
