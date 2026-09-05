import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";

function matches(event, filter) {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
  if (Number.isSafeInteger(filter.since) && event.created_at < filter.since) return false;
  for (const [name, values] of Object.entries(filter)) {
    if (!name.startsWith("#") || !Array.isArray(values)) continue;
    const tagName = name.slice(1);
    if (!event.tags.some((tag) => Array.isArray(tag) && tag[0] === tagName && values.includes(tag[1]))) return false;
  }
  return true;
}

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

export async function startLocalRelay() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const subscriptions = new WeakMap();
  const events = [];
  await waitForListening(server);

  server.on("connection", (socket) => {
    subscriptions.set(socket, new Map());
    socket.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(frame)) return;
      if (frame[0] === "REQ" && typeof frame[1] === "string" && frame[2] && typeof frame[2] === "object") {
        subscriptions.get(socket).set(frame[1], frame[2]);
        for (const event of events) {
          if (matches(event, frame[2])) socket.send(JSON.stringify(["EVENT", frame[1], event]));
        }
        socket.send(JSON.stringify(["EOSE", frame[1]]));
        return;
      }
      if (frame[0] !== "EVENT" || !verifyEvent(frame[1])) return;
      const event = frame[1];
      if (!events.some(({ id }) => id === event.id)) events.push(event);
      socket.send(JSON.stringify(["OK", event.id, true, ""]));
      for (const client of server.clients) {
        if (client.readyState !== client.OPEN) continue;
        for (const [subscriptionId, filter] of subscriptions.get(client) ?? []) {
          if (matches(event, filter)) client.send(JSON.stringify(["EVENT", subscriptionId, event]));
        }
      }
    });
  });

  const address = server.address();
  return {
    url: `ws://127.0.0.1:${address.port}`,
    events,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
