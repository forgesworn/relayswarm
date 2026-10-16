import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";

/** A bounded, in-memory rendezvous relay for a controlled field trial.
 * It accepts only this publisher's swarm and drops history after two minutes. */
export function attachDemoRelay(server, { swarmId, origin, maxClients = 64, publisherEvent, admit, maxMessagesPerWindow = 800 }) {
  const relay = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 });
  const history = new Map(), subscriptions = new WeakMap();
  const admitted = new Map();
  let paused = false, globalReceived = 0, globalWindowAt = Date.now();
  function send(socket, frame) {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.terminate(); return; }
    socket.send(JSON.stringify(frame));
  }
  function matches(event, filter) {
    return (!filter.kinds || Array.isArray(filter.kinds) && filter.kinds.includes(event.kind))
      && (!filter.authors || Array.isArray(filter.authors) && filter.authors.some((prefix) => event.pubkey.startsWith(prefix)))
      && (!filter.ids || filter.ids.some((prefix) => event.id.startsWith(prefix)))
      && (filter.since === undefined || event.created_at >= filter.since) && (filter.until === undefined || event.created_at <= filter.until)
      && Object.entries(filter).every(([key, values]) => !key.startsWith("#") || (Array.isArray(values) && event.tags.some((tag) => tag[0] === key.slice(1) && values.includes(tag[1]))));
  }
  function validFilter(filter) {
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || Object.keys(filter).length > 8) return false;
    for (const [key, value] of Object.entries(filter)) {
      if (["since", "until", "limit"].includes(key)) {
        if (!Number.isSafeInteger(value) || value < 0 || key === "limit" && (value < 1 || value > 512)) return false;
      } else if (key === "kinds") {
        if (!Array.isArray(value) || !value.length || value.length > 8 || value.some((kind) => !Number.isSafeInteger(kind) || kind < 0 || kind > 65535)) return false;
      } else if (["authors", "ids"].includes(key)) {
        if (!Array.isArray(value) || !value.length || value.length > 32 || value.some((prefix) => typeof prefix !== "string" || !/^[a-f0-9]{1,64}$/u.test(prefix))) return false;
      } else if (/^#[a-z]$/iu.test(key)) {
        if (!Array.isArray(value) || !value.length || value.length > 8 || value.some((tag) => typeof tag !== "string" || !tag || tag.length > 256)) return false;
      } else return false;
    }
    return true;
  }
  function remember(event) {
    const key = event.kind === 30311 ? `30311:${event.pubkey}:${event.tags.find((tag) => tag[0] === "d")?.[1]}` : event.id;
    const previous = history.get(key);
    if (previous && (previous.created_at > event.created_at || previous.created_at === event.created_at && previous.id <= event.id)) return;
    history.set(key, event);
    if (history.size > 512) {
      const oldestPeerRecord = [...history].find(([, value]) => value.kind !== 30311)?.[0];
      if (oldestPeerRecord !== undefined) history.delete(oldestPeerRecord);
    }
    for (const client of relay.clients) for (const [id, filter] of subscriptions.get(client) || []) if (matches(event, filter)) send(client, ["EVENT", id, event]);
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
      if (Date.now() - globalWindowAt >= 10000) { globalReceived = 0; globalWindowAt = Date.now(); }
      if (++globalReceived > maxMessagesPerWindow) { socket.close(1008, "Relay request budget exceeded"); return; }
      if (Date.now() - windowAt >= 10000) { received = 0; windowAt = Date.now(); }
      if (++received > 80) { socket.close(1008, "Message budget exceeded"); return; }
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(frame)) return;
      if (frame[0] === "CLOSE") { subs.delete(frame[1]); return; }
      if (frame[0] === "REQ") {
        const [, id, filter] = frame;
        if (!validFilter(filter)) return;
        const discovery = publisherEvent && Array.isArray(filter?.kinds) && filter.kinds.length === 1 && filter.kinds[0] === 30311
          && Array.isArray(filter.authors) && filter.authors.length === 1 && filter.authors[0] === publisherEvent.pubkey;
        const swarmFilter = Array.isArray(filter?.["#x"]) && filter["#x"].length === 1 && filter["#x"][0] === swarmId
          && (!filter.kinds || Array.isArray(filter.kinds) && filter.kinds.every((kind) => kind === 24170 || kind === 24171));
        if (typeof id !== "string" || id.length > 64 || !filter || typeof filter !== "object" || subs.size >= 8
          || (!discovery && !swarmFilter)) return;
        subs.set(id, filter);
        for (const [key, event] of history) {
          if (event.kind !== 30311 && event.created_at < Date.now() / 1000 - 120) { history.delete(key); continue; }
          if (matches(event, filter)) send(socket, ["EVENT", id, event]);
        }
        send(socket, ["EOSE", id]); return;
      }
      if (frame[0] !== "EVENT") return;
      const event = frame[1];
      let presenceTicket;
      try {
        const seconds = Math.floor(Date.now() / 1000);
        if (!event || (event.kind !== 24170 && event.kind !== 24171) || !Number.isSafeInteger(event.created_at)
          || event.created_at < seconds - 120 || event.created_at > seconds + 30
          || !event.tags.some((tag) => tag[0] === "x" && tag[1] === swarmId)) return;
        if (admit) {
          if (event.kind === 24170) {
            const payload = JSON.parse(event.content);
            if (admit(event.pubkey, payload.ticket) !== true) return;
            presenceTicket = payload.ticket;
            if (!admitted.has(event.pubkey) && admitted.size >= 512) {
              for (const [key, ticket] of admitted) if (admit(key, ticket) !== true) admitted.delete(key);
              if (admitted.size >= 512) return;
            }
          } else if (admit(event.pubkey, admitted.get(event.pubkey)) !== true) return;
        }
        if (!verifyEvent(event)) return;
        if (presenceTicket !== undefined) admitted.set(event.pubkey, presenceTicket);
      } catch { return; }
      if (history.has(event.id)) { send(socket, ["OK", event.id, true, "duplicate"]); return; }
      remember(event);
      send(socket, ["OK", event.id, true, ""]);
    });
  });
  return {
    pause() { paused = true; for (const client of relay.clients) client.terminate(); },
    resume() { paused = false; },
    clients: () => relay.clients.size,
    publishStreamEvent(value) {
      const event = structuredClone(value);
      if (!publisherEvent || event.kind !== 30311 || event.pubkey !== publisherEvent.pubkey || JSON.stringify(event).length > 16384
        || !verifyEvent(event) || event.id !== publisherEvent.id && (event.tags.find((tag) => tag[0] === "d")?.[1] !== `live-${publisherEvent.id}`
          || !event.tags.some((tag) => tag[0] === "relayswarm-authorisation" && tag[1] === publisherEvent.id))) throw new Error("Invalid publisher stream event.");
      remember(event);
    },
    async close() { server.off("upgrade", upgrade); for (const client of relay.clients) client.terminate(); await new Promise((resolve) => relay.close(resolve)); },
  };
}
