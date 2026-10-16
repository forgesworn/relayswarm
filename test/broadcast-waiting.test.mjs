import { spawn } from "node:child_process";
import { mkdtemp, realpath, writeFile, rm, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startBroadcastWaitingServer } from "../demo/broadcast-waiting.mjs";

test("waiting listener serves a refreshing page and bounded unavailable endpoints", async (t) => {
  const waiting = await startBroadcastWaitingServer({ port: 0 });
  t.after(() => waiting.close());
  const response = await fetch(waiting.base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Waiting for the broadcast/u);
  assert.match(html, /http-equiv="refresh" content="3"/u);
  assert.doesNotMatch(html, /<script|<style|token|credential|session\.json|operator/u);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/u);
  const head = await fetch(waiting.base, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(html));
  for (const path of ["/session.json", "/relay", "/operator/status", "/unknown"]) {
    const unavailable = await fetch(`${waiting.base}${path}`);
    assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get("retry-after"), "3");
    assert.deepEqual(await unavailable.json(), { error: "Broadcast not ready." });
  }
  const unavailableHead = await fetch(`${waiting.base}/session.json`, { method: "HEAD" });
  assert.equal(unavailableHead.status, 503); assert.equal(await unavailableHead.text(), "");
  assert.equal((await fetch(waiting.base, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${waiting.base}/operator/policy`, { method: "POST", body: "ignored" })).status, 503);
});

test("waiting listener rejects unsafe public origin, remote HTTP and incomplete TLS", async () => {
  for (const publicUrl of ["http://example.test", "https://user:secret@example.test", "https://example.test/path", "https://example.test/?x=1", "https://example.test/#x", "invalid"]) {
    await assert.rejects(startBroadcastWaitingServer({ port: 0, publicUrl }), /HTTPS origin/u);
  }
  await assert.rejects(startBroadcastWaitingServer({ host: "0.0.0.0", port: 0 }), /require HTTPS/u);
  await assert.rejects(startBroadcastWaitingServer({ port: 0, tlsKey: "unread-key" }), /both TLS/u);
  await assert.rejects(startBroadcastWaitingServer({ port: 0, tlsCert: "unread-cert" }), /both TLS/u);
  await assert.rejects(startBroadcastWaitingServer({ port: -1 }), /port/u);
});

test("waiting close is idempotent and permits player replacement on the same port", async (t) => {
  const waiting = await startBroadcastWaitingServer({ port: 0, publicUrl: "https://stream.example.test" });
  assert.equal(waiting.base, "https://stream.example.test");
  const closed = waiting.close(); assert.equal(waiting.close(), closed); await closed; await waiting.close();
  const player = createServer((_request, response) => response.end("Player ready"));
  await new Promise((done, reject) => { player.once("error", reject); player.listen(waiting.port, "127.0.0.1", done); });
  t.after(() => new Promise((done) => { player.close(done); player.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${waiting.port}`);
  assert.equal(response.status, 200); assert.equal(await response.text(), "Player ready");
});


test("CLI replaces its waiting listener with the session/player on the same ephemeral port", { timeout: 20000, skip: process.platform === "win32" ? "POSIX executable encoder fixture is unsupported on Windows." : false }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-cli-waiting-")));
  const gate = join(directory, "publish"), encoder = join(directory, "encoder.mjs"), state = join(directory, "state");
  // A controlled encoder supplies catalogue fixtures after the waiting page
  // is observed. This tests CLI handoff, not media decoding or ingest.
  await writeFile(encoder, `#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
const args=process.argv.slice(2), gate=${JSON.stringify(gate)};
const timer=setInterval(()=>{
 if (!existsSync(gate)) return;
 clearInterval(timer);
 for (let i=0;i<args.length;i++) if(args[i]==='-hls_segment_filename'){
  const segment=args[i+1].replace(/%0\\d+d/, '0000000000000000001'), playlist=args[i+2];
  mkdirSync(dirname(playlist),{recursive:true}); writeFileSync(segment,'abcdefgh');
  writeFileSync(playlist,'#EXTM3U\\n#EXT-X-VERSION:3\\n#EXT-X-TARGETDURATION:2\\n#EXT-X-MEDIA-SEQUENCE:1\\n#EXTINF:2,\\n'+basename(segment)+'\\n');
 }
},20);
setInterval(()=>{},1000);
`, { mode: 0o700 });
  const child = spawn(process.execPath, ["scripts/broadcast.mjs", "--ffmpeg", encoder, "--state-dir", state, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise((done) => child.once("close", done));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; await rm(directory, { recursive: true, force: true }); });
  let output = ""; child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", () => {});
  const log = (pattern) => new Promise((done, reject) => {
    const check = () => { const match = output.match(pattern); if (match) { cleanup(); done(match[1]); } };
    const closed = () => { cleanup(); reject(new Error("Broadcaster ended before expected listener state")); };
    const cleanup = () => { clearTimeout(timer); child.stdout.off("data", check); child.off("close", closed); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Broadcaster listener transition timed out")); }, 10000);
    child.stdout.on("data", check); child.once("close", closed); check();
  });
  const base = await log(/Broadcaster waiting page: (\S+)/u);
  assert.match(await fetch(base).then((response) => response.text()), /Waiting for the broadcast/u);
  assert.equal((await fetch(`${base}/session.json`)).status, 503);
  await writeFile(gate, "go", { mode: 0o600 });
  assert.equal(await log(/RelaySwarm broadcaster player: (\S+)/u), base);
  const session = await fetch(`${base}/session.json`).then((response) => response.json());
  assert.equal(session.v, 1); assert.ok(session.streamEvent.id); assert.equal(session.secretKey, undefined);
  assert.match(await fetch(base).then((response) => response.text()), /id="settings"/u);
  assert.equal((await stat(join(state, "publisher.json"))).mode & 0o777, 0o600);
  child.kill("SIGTERM"); await exited;
  await assert.rejects(access(join(state, "media", ".broadcast-lock")), { code: "ENOENT" });
});
