import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { startDemoServer } from "../demo/server.mjs";

async function start(t) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-demo-test-"));
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\n#EXT-X-BYTERANGE:4@0\nshared.ts\n#EXTINF:2,\n#EXT-X-BYTERANGE:4\nshared.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "shared.ts"), "abcdefgh");
  await writeFile(join(directory, "private.key"), "do not serve");
  const demo = await startDemoServer({ mediaDir: directory, manifest: "index.m3u8", iceServers: [] });
  t.after(async () => { await demo.close(); await rm(directory, { recursive: true, force: true }); });
  return demo;
}

test("demo serves exact HTTP ranges and matching signed commitments without exposing keys", async (t) => {
  const demo = await start(t);
  const session = await fetch(`${demo.base}/session.json`).then((response) => response.json());
  assert.equal(session.swarmId, demo.publisher.swarmId);
  assert.equal(session.secretKey, undefined);
  const response = await fetch(`${demo.base}/media/shared.ts`, { headers: { range: "bytes=4-7" } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 4-7/8");
  assert.equal(await response.text(), "efgh");
  const query = new URLSearchParams({ path: "/media/shared.ts", level: "0", sequence: "1", cc: "0", start: "4", end: "8" });
  const commitment = await fetch(`${demo.base}/commitment?${query}`).then((value) => value.json());
  assert.equal(JSON.parse(commitment.content).size, 4);
  for (const path of ["/media/private.key", "/private.key", "/media/%2e%2e/private.key", "/media/shared.ts?notlisted=1"]) {
    // Query strings on an already listed media resource do not grant new access.
    if (path.includes("?")) assert.equal((await fetch(`${demo.base}${path}`)).status, 200);
    else assert.equal((await fetch(`${demo.base}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${demo.base}/media/shared.ts`, { headers: { range: "bytes=8-10" } })).status, 416);
  query.set("cc", "1"); assert.equal((await fetch(`${demo.base}/commitment?${query}`)).status, 404);
  assert.equal((await fetch(`${demo.base}/session.json`, { method: "POST" })).status, 405);
  const page = await fetch(demo.base);
  assert.ok(!page.headers.get("content-security-policy").includes("unsafe-inline"));
  assert.match(await page.text(), /id="upload" type="checkbox"/u);
});

test("demo refuses insecure remote bindings and invalid external configuration", async () => {
  await assert.rejects(startDemoServer({ host: "0.0.0.0" }), /require HTTPS/u);
  for (const publicUrl of ["http://example.test", "https://user:pass@example.test", "https://example.test/path"]) await assert.rejects(startDemoServer({ publicUrl }), /HTTPS origin/u);
  await assert.rejects(startDemoServer({ relays: ["ws://public.example"] }), /wss/u);
});

test("bounded demo relay delivers signed swarm events, honours CLOSE and recovers after an outage", async (t) => {
  const demo = await start(t);
  const connect = () => new Promise((resolve, reject) => {
    const socket = new WebSocket(`${demo.base.replace(/^http/u, "ws")}/relay`, { origin: demo.base });
    socket.once("open", () => resolve(socket)); socket.once("error", reject);
  });
  const socket = await connect(); t.after(() => socket.terminate());
  const frames = []; socket.on("message", (raw) => frames.push(JSON.parse(raw)));
  socket.send(JSON.stringify(["REQ", "s", { kinds: [24170], "#x": [demo.publisher.swarmId] }]));
  const event = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", demo.publisher.swarmId]], content: "presence" }, generateSecretKey());
  socket.send(JSON.stringify(["EVENT", event]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(frames.some((frame) => frame[0] === "EVENT" && frame[2].id === event.id));
  socket.send(JSON.stringify(["CLOSE", "s"]));
  const other = finalizeEvent({ kind: 24170, created_at: Math.floor(Date.now() / 1000), tags: [["x", demo.publisher.swarmId]], content: "next" }, generateSecretKey());
  socket.send(JSON.stringify(["EVENT", other]));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!frames.some((frame) => frame[0] === "EVENT" && frame[2].id === other.id));
  const closed = new Promise((resolve) => socket.once("close", resolve)); demo.relay.pause(); await closed;
  demo.relay.resume(); const restarted = await connect(); restarted.terminate();
});
