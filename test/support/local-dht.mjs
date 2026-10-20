import { createSocket } from "node:dgram";
import DHT from "hyperdht";

async function availableUdpPort() {
  const socket = createSocket("udp4");
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", resolve);
  });
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export async function startLocalDht() {
  const nodes = [], bootstrap = [];
  try {
    // Model a populated isolated DHT: NAT analysis needs several independent
    // responders. One bootstrapper can abort before the LAN stream arrives.
    for (let i = 0; i < 4; i++) {
      const port = await availableUdpPort(), node = DHT.bootstrapper(port, "127.0.0.1");
      nodes.push(node);
      await node.ready();
      bootstrap.push(`127.0.0.1:${port}`);
    }
  } catch (error) { await Promise.allSettled(nodes.map((node) => node.destroy())); throw error; }
  return {
    bootstrap,
    async close() {
      await Promise.all(nodes.map((node) => node.destroy()));
    },
  };
}
