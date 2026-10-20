import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, symlink, link, rm, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { readIceConfigFile, validateIceConfig } from "../src/ice-config.mjs";

const turn = { urls: ["turn:relay.example:3478?transport=tcp", "turns:[2001:db8::1]:5349?transport=tcp"], username: "1791906000:trial", credential: "temporary+password=" };
const config = { v: 1, iceServers: [{ urls: "stun:stun.example:3478" }, turn] };

test("accepts TCP TURN browser credentials and isolates returned configuration", () => {
  const result = validateIceConfig(config);
  assert.deepEqual(result, config.iceServers);
  result[1].urls.push("turn:other.example:3478");
  assert.equal(config.iceServers[1].urls.length, 2);
});

test("rejects secret fields, embedded credentials and unbounded or ambiguous ICE URLs", () => {
  for (const input of [
    { ...config, staticAuthSecret: "do-not-publish" },
    { v: 1, iceServers: [{ ...turn, staticAuthSecret: "do-not-publish" }] },
    { v: 1, iceServers: [{ urls: "turn:user:pass@relay.example" }] },
    { v: 1, iceServers: [{ urls: "https://relay.example", username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "turn:relay.example:65536", username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "turn:relay.example?transport=tcp&transport=udp", username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "turn:relay.example?other=tcp", username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "turn:relay.example?", username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "turn:relay.example#", username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "turn:[:::::]:3478", username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "stun:relay.example?transport=tcp" }] },
    { v: 1, iceServers: [{ urls: ["stun:relay.example", "turn:relay.example"], username: "x", credential: "x" }] },
    { v: 1, iceServers: [{ urls: "stun:relay.example", credential: "secret" }] },
    { v: 1, iceServers: [{ urls: "turn:relay.example", username: "x", credential: "" }] },
    { v: 1, iceServers: Array(9).fill(turn) },
    { v: 1, iceServers: [{ ...turn, urls: Array(5).fill("turn:relay.example") }] },
    { v: 1, iceServers: [{ ...turn, credential: "x".repeat(257) }] },
  ]) assert.throws(() => validateIceConfig(input), /Invalid ICE configuration/u);
});

test("private configuration preserves credentials without including them in errors", { skip: process.platform === "win32" }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-ice-config-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await chmod(directory, 0o700);
  const file = join(directory, "ice.json");
  await writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  assert.deepEqual(await readIceConfigFile(file), config.iceServers);
  await chmod(file, 0o644);
  await assert.rejects(readIceConfigFile(file), /0600/u);
  await chmod(file, 0o600);
  const alias = join(directory, "alias.json");
  await link(file, alias);
  await assert.rejects(readIceConfigFile(file), /0600/u);
  await rm(alias);
  await symlink(file, alias);
  await assert.rejects(readIceConfigFile(alias));
  await writeFile(file, "temporary+password= invalid JSON");
  await assert.rejects(readIceConfigFile(file), (error) => !error.message.includes("temporary+password="));
  await writeFile(file, "x".repeat(16385));
  await assert.rejects(readIceConfigFile(file), /16 KiB/u);
  await chmod(directory, 0o777);
  await assert.rejects(readIceConfigFile(file), /owner-controlled/u);
});

test("demo CLI publishes the selected browser ICE configuration and keeps credentials out of logs", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-ice-cli-")));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await closed; } finally { clearTimeout(force); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  await chmod(directory, 0o700);
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "segment.ts"), "publisher transport fixture");
  const file = join(directory, "ice.json");
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  child = spawn(process.execPath, ["demo/server.mjs", "--media-dir", directory, "--manifest", "index.m3u8", "--port", "0", "--ice-config", file], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  const base = await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Demo CLI did not become ready.")), 5000);
    const check = (chunk) => {
      output += chunk;
      const match = /RelaySwarm field-test player: (http:\/\/localhost:\d+)/u.exec(output);
      if (match) { clearTimeout(deadline); child.stdout.off("data", check); resolve(match[1]); }
    };
    child.stdout.on("data", check);
    child.once("error", (error) => { clearTimeout(deadline); reject(error); });
    child.once("exit", () => { clearTimeout(deadline); reject(new Error("Demo CLI exited before readiness.")); });
  });
  const session = await fetch(`${base}/session.json`, { signal: AbortSignal.timeout(2000) }).then((response) => response.json());
  assert.deepEqual(session.iceServers, config.iceServers);
  assert.equal((await fetch(`${base}/media/ice.json`)).status, 404);
  assert.ok(!`${output}${errors}`.includes(turn.credential));
  for (const script of ["demo/server.mjs", "scripts/broadcast.mjs"]) {
    const state = join(directory, "unused-broadcast-state");
    const extra = script.startsWith("scripts/") ? ["--state-dir", state, "--port", "0"] : [];
    await assert.rejects(promisify(execFile)(process.execPath, [script, "--stun", "stun:stun.example:3478", "--ice-config", file, ...extra], { timeout: 2000 }), (error) => {
      assert.equal(error.code, 1);
      assert.ok(!error.stderr.includes(turn.credential));
      return true;
    });
    await assert.rejects(lstat(state), { code: "ENOENT" });
  }
});
