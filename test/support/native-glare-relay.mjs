// A dedicated offer collision fixture. It never decrypts or rewrites signals.
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools/pure";

export function createOfferBarrier({ peers, deliver, clock = performance.now.bind(performance), holdMs = 6000 }) {
  assert.equal(peers.length, 2); assert.notEqual(peers[0], peers[1]);
  const held = new Map(), seen = new Set();
  let started = null, released = false, closed = false, failure = false, delivered = 0;
  const valid = () => { assert.ok(!closed && !failure); assert.ok(released || started === null || clock() - started < holdMs); };
  return {
    accept(event) {
      try {
        valid();
        assert.ok(peers.includes(event.pubkey));
        assert.equal(event.tags.filter(([tag]) => tag === "p").length, 1);
        assert.equal(event.tags.find(([tag]) => tag === "p")[1], peers.find(key => key !== event.pubkey));
        if (seen.has(event.id)) return false;
        assert.ok(seen.size < 8); seen.add(event.id);
        if (released) { deliver(event); delivered++; return true; }
        assert.ok(!held.has(event.pubkey) && held.size < 2);
        started ??= clock(); held.set(event.pubkey, event); return true;
      } catch (error) { failure = true; throw error; }
    },
    release(witnesses) {
      try {
        valid(); assert.ok(!released && held.size === 2 && witnesses.length === 2);
        for (const witness of witnesses) assert.ok(witness.pcCount === 1 && witness.offerInstalled === 1
          && witness.offerSent === 1 && witness.signalsReceived === 0 && witness.signalingState === "have-local-offer"
          && witness.remainingDialMs > 0 && witness.authorityFresh === true && witness.stopped === false);
        released = true;
        for (const event of held.values()) { deliver(event); delivered++; }
        held.clear();
      } catch (error) { failure = true; throw error; }
    },
    snapshot() { return { held: held.size, released, forwardedEvents: delivered, failed: failure, closed }; },
    close() { closed = true; held.clear(); seen.clear(); },
  };
}

export function attachNativeGlareRelay(server, { origin, swarmId, admit, WebSocketServerImpl = WebSocketServer }) {
  const relay = new WebSocketServerImpl({ noServer: true, maxPayload: 24 * 1024 });
  const subscriptions = new Map(), history = new Map(), admitted = new Map();
  let peers = [], barrier, failed = false, count = 0, windowAt = Date.now();
  const send = (socket, frame) => {
    if (socket.readyState !== socket.OPEN) return;
    const encoded = JSON.stringify(frame);
    if (socket.bufferedAmount + Buffer.byteLength(encoded) > 1024 * 1024) { failed = true; socket.terminate(); return; }
    socket.send(encoded);
  };
  const matches = (event, filter) => filter.kinds.includes(event.kind)
    && (filter.since === undefined || event.created_at >= filter.since)
    && event.tags.some(([tag, value]) => tag === "x" && value === swarmId)
    && (!filter["#p"] || event.tags.some(([tag, value]) => tag === "p" && value === filter["#p"][0]));
  const deliver = event => {
    const key = event.kind === 24170 ? event.pubkey : event.id;
    if (!history.has(key) && history.size >= 10) { failed = true; throw new Error("Glare relay history bound"); }
    history.set(key, event);
    for (const [socket, filters] of subscriptions) for (const [id, filter] of filters) if (matches(event, filter)) send(socket, ["EVENT", id, event]);
  };
  const upgrade = (request, socket, head) => {
    if (failed || peers.length !== 2 || request.url !== "/relay" || request.headers.origin !== origin()
      || relay.clients.size >= 2) { socket.destroy(); return; }
    relay.handleUpgrade(request, socket, head, client => relay.emit("connection", client));
  };
  server.on("upgrade", upgrade);
  relay.on("connection", socket => {
    const filters = new Map(); subscriptions.set(socket, filters);
    let received = 0, at = Date.now();
    socket.on("error", () => { failed = true; });
    socket.on("close", () => subscriptions.delete(socket));
    socket.on("message", bytes => {
      try {
        if (Date.now() - at >= 10000) { at = Date.now(); received = 0; }
        if (Date.now() - windowAt >= 10000) { windowAt = Date.now(); count = 0; }
        assert.ok(++received <= 80 && ++count <= 800);
        const frame = JSON.parse(bytes.toString()); assert.ok(Array.isArray(frame));
        if (frame[0] === "CLOSE") { filters.delete(frame[1]); return; }
        if (frame[0] === "REQ") {
          const [, id, filter] = frame;
          assert.ok(frame.length === 3 && typeof id === "string" && id.length <= 64 && filters.size < 8);
          assert.ok(filter && Object.keys(filter).every(key => ["kinds", "#x", "#p", "since"].includes(key)));
          assert.ok(Array.isArray(filter.kinds) && filter.kinds.length > 0 && filter.kinds.length <= 2
            && filter.kinds.every(kind => kind === 24170 || kind === 24171));
          assert.deepEqual(filter["#x"], [swarmId]);
          if (filter["#p"]) assert.ok(filter["#p"].length === 1 && peers.includes(filter["#p"][0]));
          if (filter.since !== undefined) assert.ok(Number.isSafeInteger(filter.since));
          filters.set(id, filter);
          // Only released events enter history. REQ replay cannot bypass the barrier.
          for (const event of history.values()) if (matches(event, filter)) send(socket, ["EVENT", id, event]);
          send(socket, ["EOSE", id]); return;
        }
        assert.ok(frame[0] === "EVENT" && frame.length === 2);
        const event = frame[1], seconds = Math.floor(Date.now() / 1000);
        assert.ok(event && peers.includes(event.pubkey) && [24170, 24171].includes(event.kind)
          && Number.isSafeInteger(event.created_at) && event.created_at >= seconds - 120 && event.created_at <= seconds + 30
          && Array.isArray(event.tags) && event.tags.filter(([tag]) => tag === "x").length === 1
          && event.tags.some(([tag, value]) => tag === "x" && value === swarmId) && verifyEvent(event));
        if (event.kind === 24170) {
          const payload = JSON.parse(event.content);
          assert.ok(payload.v === 3 && admit(event.pubkey, payload.ticket) === true);
          admitted.set(event.pubkey, payload.ticket); deliver(event);
        } else {
          assert.equal(admit(event.pubkey, admitted.get(event.pubkey)), true);
          barrier.accept(event);
        }
        send(socket, ["OK", event.id, true, ""]);
      } catch { failed = true; socket.close(1008, "Fixture protocol refused"); }
    });
  });
  return {
    setPeers(value) {
      assert.ok(!barrier && value.length === 2 && value.every(key => /^[a-f0-9]{64}$/u.test(key)));
      peers = [...value]; barrier = createOfferBarrier({ peers, deliver });
    },
    release(witnesses) { assert.ok(!failed); barrier.release(witnesses); },
    snapshot() {
      const state = barrier?.snapshot() ?? { held: 0, released: false };
      return { ...state, relayFailed: failed, barrierFailed: state.failed ?? null,
        failed: failed || state.failed === true, clients: relay.clients.size, history: history.size };
    },
    async close() {
      server.removeListener("upgrade", upgrade); barrier?.close(); history.clear(); admitted.clear();
      for (const client of relay.clients) client.terminate();
      await new Promise(resolve => relay.close(resolve)); subscriptions.clear();
    },
  };
}
