import DHT from "hyperdht";
import UDX from "udx-native";

function ownedUdx() {
  const udx = new UDX(), sockets = new Set(), watchers = new Set();
  for (const [method, resources] of [["createSocket", sockets], ["watchNetworkInterfaces", watchers]]) {
    const create = udx[method].bind(udx);
    udx[method] = (...args) => {
      const resource = create(...args);
      resources.add(resource);
      resource.once("close", () => resources.delete(resource));
      return resource;
    };
  }
  return { udx, async close() {
    // dht-rpc's destroy can reject at bind before closing its UDX watcher.
    await Promise.allSettled([
      ...[...sockets].map(socket => Promise.resolve().then(() => socket.close())),
      ...[...watchers].map(watcher => Promise.resolve().then(() => watcher.destroy())),
    ]);
  } };
}

export async function startLocalDht({ createNode = options => new DHT(options) } = {}) {
  const resources = [], bootstrap = [];
  let closing;
  const close = () => closing ??= Promise.allSettled(resources.map(async resource => {
    try { await resource.node?.destroy({ force: true }); }
    finally { await resource.close(); }
  }));
  try {
    // Model a populated isolated DHT: NAT analysis needs several independent
    // responders. One bootstrapper can abort before the LAN stream arrives.
    for (let i = 0; i < 4; i++) {
      const resource = ownedUdx();
      resources.push(resource);
      // A range containing only zero bypasses HyperDHT's preferred fixed port.
      // The live DHT socket owns its kernel-assigned port until close.
      resource.node = createNode({ udx: resource.udx, port: [0, 1], host: "127.0.0.1",
        bootstrap: [...bootstrap], ephemeral: false, firewalled: false });
      await resource.node.fullyBootstrapped();
      bootstrap.push(`127.0.0.1:${resource.node.address().port}`);
    }
    // Verify every responder through another live node before handing it over.
    await Promise.all(resources.map((resource, index) => resources[(index + 1) % resources.length].node.ping({
      host: "127.0.0.1", port: resource.node.address().port,
    })));
  } catch (error) { await close(); throw error; }
  return { bootstrap, close };
}
