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
  const port = await availableUdpPort();
  const node = DHT.bootstrapper(port, "127.0.0.1");
  await node.ready();
  return {
    bootstrap: [`127.0.0.1:${port}`],
    async close() {
      await node.destroy();
    },
  };
}
