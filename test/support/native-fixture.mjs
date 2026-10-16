import { startLocalDht } from "./local-dht.mjs";
import { startLocalRelay } from "./local-relay.mjs";

// Own partial setup until both fixtures can be handed to the test's finally.
export async function startNativeTestInfrastructure({ startRelay = startLocalRelay, startDht = startLocalDht } = {}) {
  const relay = await startRelay();
  try {
    const dht = await startDht();
    return { relay, dht };
  } catch (error) {
    await Promise.allSettled([Promise.resolve().then(() => relay.close())]);
    throw error;
  }
}
