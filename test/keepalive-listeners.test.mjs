import assert from "node:assert/strict";
import { Agent, request } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

// Exercise the actual listeners on their original sockets so a client reconnect
// cannot hide a server idle timeout.
const root = fileURLToPath(new URL("../", import.meta.url));
const { startDemoServer } = await import(pathToFileURL(join(root, "demo/server.mjs")));
const { startBroadcastWaitingServer } = await import(pathToFileURL(join(root, "demo/broadcast-waiting.mjs")));
const IDLE_MS = 121000, IO_MS = 2000, CLOSE_MS = 2000, MAX_BODY = 4096;

class IdleProbeAgent extends Agent {
  connections = 0;
  constructor() { super({ keepAlive: true, maxSockets: 1, maxTotalSockets: 1, maxFreeSockets: 1, timeout: 0 }); }
  createConnection(...args) {
    assert.ok(++this.connections <= 2, "At most the original connection and explicit handover are owned");
    return super.createConnection(...args);
  }
  keepSocketAlive(socket) {
    // Probe the server's idle lifetime, rather than the Node client's optional
    // Keep-Alive response-hint timer. No HTTP request or heartbeat resets it.
    socket.setKeepAlive(true, this.keepAliveMsecs);
    socket.unref(); socket.setTimeout(0);
    return true;
  }
}

function observeSocket(socket, label) {
  const observation = { socket, label, openedAt: performance.now(), closedAt: null };
  observation.closed = new Promise(resolve => socket.once("close", () => {
    observation.closedAt = performance.now();
    resolve({ kind: "closed", label, aliveMs: observation.closedAt - observation.openedAt });
  }));
  return observation;
}

function roundtrip(base, agent, { origin, expectedSocket, label }) {
  const url = new URL("/admission/verify", base); url.hostname = "127.0.0.1";
  const body = Buffer.from(JSON.stringify({ pubkey: "0".repeat(64), ticket: "not-an-issued-ticket" }));
  return new Promise((resolve, reject) => {
    let socket, observation, bytes = 0;
    const chunks = [];
    const req = request(url, { agent, method: "POST", headers: {
      origin, "content-type": "application/json", "content-length": body.length,
    } }, response => {
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > MAX_BODY) { req.destroy(new Error("Bounded response body exceeded")); return; }
        chunks.push(chunk);
      });
      response.once("aborted", () => fail(new Error("Response aborted")));
      response.once("error", fail);
      response.once("end", () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode, headers: response.headers, complete: response.complete,
          body: Buffer.concat(chunks), socket, observation, reusedSocket: req.reusedSocket });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Loopback request exceeded 2s")), IO_MS);
    function fail(error) { clearTimeout(timer); reject(error); }
    req.once("error", fail);
    req.once("socket", assigned => {
      socket = assigned;
      if (expectedSocket && socket !== expectedSocket) {
        req.destroy(new Error("Agent reconnected instead of reusing the original idle socket")); return;
      }
      if (!expectedSocket) observation = observeSocket(socket, label);
    });
    req.end(body);
  });
}

function exactReply(reply, status, body) {
  assert.equal(reply.status, status);
  assert.equal(reply.complete, true);
  assert.equal(reply.headers["content-type"], "application/json");
  assert.equal(reply.headers["content-length"], String(body.length));
  assert.equal(reply.headers["transfer-encoding"], undefined);
  assert.equal(reply.headers.connection, "keep-alive");
  assert.deepEqual(reply.body, body);
}

function denied(reply, demo) {
  exactReply(reply, 200, Buffer.from(JSON.stringify({ admitted: false, epoch: demo.admission.descriptor().epoch })));
}

function waitingReply(reply) {
  exactReply(reply, 503, Buffer.from('{"error":"Broadcast not ready."}'));
  assert.equal(reply.headers["retry-after"], "3");
}

async function realIdle(observations) {
  let timer;
  try {
    const started = performance.now();
    const result = await Promise.race([
      new Promise(resolve => { timer = setTimeout(() => resolve({ kind: "idle-complete" }), IDLE_MS); }),
      ...observations.map(row => row.closed),
    ]);
    assert.equal(result.kind, "idle-complete", `${result.label ?? "listener"} closed after ${Math.round(result.aliveMs ?? 0)}ms`);
    const elapsed = performance.now() - started;
    assert.ok(elapsed > 120000, "The original sockets must survive more than 120 real seconds");
    for (const row of observations) assert.equal(row.socket.destroyed, false);
    return elapsed;
  } finally { clearTimeout(timer); }
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function promptClose(server, observation) {
  const started = performance.now();
  const closing = server.close();
  assert.equal(server.close(), closing, "Listener close remains idempotent");
  await within(Promise.all([closing, observation.closed]), CLOSE_MS, "Listener/socket close exceeded 2s");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < CLOSE_MS);
  return elapsed;
}

test("app and waiting keep the same HTTP/1.1 sockets past Caddy's 120s idle pool, then close and hand over promptly",
  { timeout: 165000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), "relayswarm-keepalive-listeners-"));
    const appAgent = new IdleProbeAgent(), waitingAgent = new IdleProbeAgent();
    let demo, waiting, replacement;
    const cleanup = { allListenersClosed: false, agentsDestroyed: false, fixtureRemoved: false };
    try {
      await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nshared.ts\n#EXT-X-ENDLIST\n", { mode: 0o600 });
      await writeFile(join(directory, "shared.ts"), "abcdefgh", { mode: 0o600 });
      waiting = await startBroadcastWaitingServer({ host: "127.0.0.1", port: 0 });
      demo = await startDemoServer({ mediaDir: directory, manifest: "index.m3u8", host: "127.0.0.1", port: 0, iceServers: [], relays: [] });
      const [appInitial, waitingInitial] = await Promise.all([
        roundtrip(demo.base, appAgent, { origin: demo.base, label: "app" }),
        roundtrip(waiting.base, waitingAgent, { origin: waiting.base, label: "waiting" }),
      ]);
      denied(appInitial, demo); waitingReply(waitingInitial);
      assert.equal(appInitial.reusedSocket, false); assert.equal(waitingInitial.reusedSocket, false);
      assert.equal(appAgent.connections, 1); assert.equal(waitingAgent.connections, 1);
      assert.ok(appInitial.observation && waitingInitial.observation);

      // Neither listener receives any HTTP request during this single real wait.
      const idleMs = await realIdle([appInitial.observation, waitingInitial.observation]);
      const [appAfter, waitingAfter] = await Promise.all([
        roundtrip(demo.base, appAgent, { origin: demo.base, expectedSocket: appInitial.socket }),
        roundtrip(waiting.base, waitingAgent, { origin: waiting.base, expectedSocket: waitingInitial.socket }),
      ]);
      denied(appAfter, demo); waitingReply(waitingAfter);
      assert.equal(appAfter.reusedSocket, true); assert.equal(waitingAfter.reusedSocket, true);
      assert.equal(appAfter.socket, appInitial.socket); assert.equal(waitingAfter.socket, waitingInitial.socket);
      assert.equal(appAgent.connections, 1); assert.equal(waitingAgent.connections, 1);

      const [appCloseMs, waitingCloseMs] = await Promise.all([
        promptClose(demo, appInitial.observation), promptClose(waiting, waitingInitial.observation),
      ]);
      const waitingPort = waiting.port;
      replacement = await startDemoServer({ mediaDir: directory, manifest: "index.m3u8", host: "127.0.0.1", port: waitingPort, iceServers: [], relays: [] });
      const handover = await roundtrip(replacement.base, waitingAgent, { origin: replacement.base, label: "handover" });
      denied(handover, replacement);
      assert.equal(handover.reusedSocket, false);
      assert.notEqual(handover.socket, waitingInitial.socket);
      assert.equal(waitingAgent.connections, 2, "Only the explicit same-port handover creates another socket");
      const replacementCloseMs = await promptClose(replacement, handover.observation);
      t.diagnostic(JSON.stringify({ idleMs, appStatus: 200, waitingStatus: 503, sameOriginalSockets: true,
        appConnectionsBeforeHandover: appAgent.connections, waitingConnectionsBeforeHandover: 1,
        appCloseMs, waitingCloseMs, replacementCloseMs, handoverStatus: 200 }));
    } finally {
      appAgent.destroy(); waitingAgent.destroy(); cleanup.agentsDestroyed = true;
      const settled = await Promise.allSettled([demo, waiting, replacement].filter(Boolean).map(server => server.close()));
      cleanup.allListenersClosed = settled.every(row => row.status === "fulfilled");
      await rm(directory, { recursive: true, force: true }); cleanup.fixtureRemoved = true;
      t.diagnostic(JSON.stringify({ cleanup }));
      const failure = settled.find(row => row.status === "rejected");
      if (failure) throw failure.reason;
    }
  });
