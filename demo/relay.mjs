import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";

/** A bounded, in-memory rendezvous relay for a controlled field trial.
 * It accepts only this publisher's swarm and drops history after two minutes. */
export function attachDemoRelay(server, { swarmId, origin, maxClients = 64 }) {
  const relay = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 });
  const history = new Map(), subscriptions = new WeakMap();
  let paused = false;
  function send(socket, frame) {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(frame));
  }
  function matches(event, filter) {
    return (!filter.kinds || filter.kinds.includes(event.kind)) && (!filter.since || event.created_at >= filter.since)
      && Object.entries(filter).every(([key, values]) => !key.startsWith("#") || (Array.isArray(values) && event.tags.some((tag) => tag[0] === key.slice(1) && values.includes(tag[1]))));
  }
  const upgrade = (request, socket, head) => {
    if (request.url !== "/relay" || request.headers.origin !== origin() || paused || relay.clients.size >= maxClients) { socket.destroy(); return; }
    relay.handleUpgrade(request, socket, head, (client) => relay.emit("connection", client));
  };
  server.on("upgrade", upgrade);
  relay.on("connection", (socket) => {
    const subs = new Map(); subscriptions.set(socket, subs);
    let received = 0, windowAt = Date.now();
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      if (Date.now() - windowAt >= 10000) { received = 0; windowAt = Date.now(); }
      if (++received > 80) { socket.close(1008, "Message budget exceeded"); return; }
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(frame)) return;
      if (frame[0] === "CLOSE") { subs.delete(frame[1]); return; }
      if (frame[0] === "REQ") {
        const [, id, filter] = frame;
        if (typeof id !== "string" || id.length > 64 || !filter || typeof filter !== "object" || subs.size >= 8
          || !Array.isArray(filter["#x"]) || filter["#x"].length !== 1 || filter["#x"][0] !== swarmId
          || (filter.kinds && (!Array.isArray(filter.kinds) || filter.kinds.some((kind) => kind !== 24170 && kind !== 24171)))) return;
        subs.set(id, filter);
        for (const [key, event] of history) {
          if (event.created_at < Date.now() / 1000 - 120) { history.delete(key); continue; }
          if (matches(event, filter)) send(socket, ["EVENT", id, event]);
        }
        send(socket, ["EOSE", id]); return;
      }
      if (frame[0] !== "EVENT") return;
      const event = frame[1];
      try {
        const seconds = Math.floor(Date.now() / 1000);
        if (!event || (event.kind !== 24170 && event.kind !== 24171) || !Number.isSafeInteger(event.created_at)
          || event.created_at < seconds - 120 || event.created_at > seconds + 30
          || !event.tags.some((tag) => tag[0] === "x" && tag[1] === swarmId) || !verifyEvent(event)) return;
      } catch { return; }
      if (history.has(event.id)) { send(socket, ["OK", event.id, true, "duplicate"]); return; }
      history.set(event.id, event);
      if (history.size > 512) history.delete(history.keys().next().value);
      send(socket, ["OK", event.id, true, ""]);
      for (const client of relay.clients) {
        if (client.readyState !== client.OPEN) continue;
        for (const [id, filter] of subscriptions.get(client) || []) if (matches(event, filter)) send(client, ["EVENT", id, event]);
      }
    });
  });
  return {
    pause() { paused = true; for (const client of relay.clients) client.terminate(); },
    resume() { paused = false; },
    clients: () => relay.clients.size,
    async close() { server.off("upgrade", upgrade); for (const client of relay.clients) client.terminate(); await new Promise((resolve) => relay.close(resolve)); },
  };
}
