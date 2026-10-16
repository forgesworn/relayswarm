import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm, stat, chmod, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { loadPublisherState } from "../src/publisher-state.mjs";
import { createHlsPublisher } from "../src/hls-publisher.mjs";

const posixState = { skip: process.platform === "win32" ? "Persistent publisher state requires POSIX permissions; Windows ACL support is not implemented." : false };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-state-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "index.m3u8"), "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n");
  await writeFile(join(directory, "segment.ts"), "segment");
  return { directory, path: join(directory, "private-state.json"), manifest: "index.m3u8" };
}

test("private state retains author, authorisation and swarm across restarts", posixState, async (t) => {
  const options = await fixture(t);
  const state = await loadPublisherState(options.path, options);
  assert.equal((await stat(options.path)).mode & 0o777, 0o600);
  const restored = await loadPublisherState(options.path, { ...options, now: () => Date.now() + 86400000 });
  assert.deepEqual(restored.secretKey, state.secretKey);
  assert.equal(restored.streamEvent.id, state.streamEvent.id);
  assert.equal(restored.swarmId, state.swarmId);
  assert.equal(getPublicKey(restored.secretKey), restored.streamEvent.pubkey);
  const publisher = await createHlsPublisher({ mediaDir: options.directory, manifest: options.manifest, ...restored });
  const event = await publisher.commitment({ path: "/media/segment.ts", level: 0, sequence: 0, discontinuity: 0 });
  assert.equal(event.pubkey, state.streamEvent.pubkey);
  assert.equal(JSON.parse(event.content).streamEventId, state.streamEvent.id);
  const ephemeral = await createHlsPublisher({ mediaDir: options.directory, manifest: options.manifest });
  assert.notEqual(ephemeral.streamEvent.pubkey, state.streamEvent.pubkey);
});

test("state honours explicit swarm and rejects manifest, swarm and signing-key mismatches", posixState, async (t) => {
  const options = await fixture(t);
  const state = await loadPublisherState(options.path, { ...options, swarmId: "stable-custom-swarm" });
  assert.equal(state.swarmId, "stable-custom-swarm");
  await assert.rejects(loadPublisherState(options.path, { ...options, swarmId: "another-custom-swarm" }));
  await assert.rejects(loadPublisherState(options.path, { manifest: "other.m3u8" }));
  await assert.rejects(createHlsPublisher({ mediaDir: options.directory, manifest: options.manifest, ...state, secretKey: generateSecretKey() }));
  const stored = JSON.parse(await readFile(options.path, "utf8"));
  stored.secretKey = Buffer.from(generateSecretKey()).toString("hex");
  await writeFile(options.path, JSON.stringify(stored));
  await assert.rejects(loadPublisherState(options.path, options));
});

test("state rejects invalid authorisation and malformed files without overwriting them", posixState, async (t) => {
  const options = await fixture(t);
  await loadPublisherState(options.path, options);
  const stored = JSON.parse(await readFile(options.path, "utf8"));
  for (const text of ["not json", JSON.stringify({ ...stored, v: 2 }), JSON.stringify({ ...stored, streamEvent: { ...stored.streamEvent, content: "tampered" } }), "x".repeat(32769)]) {
    await writeFile(options.path, text);
    await assert.rejects(loadPublisherState(options.path, options));
    assert.equal(await readFile(options.path, "utf8"), text);
  }
});

test("state rejects public modes, symlinks, hard links and unsafe parent directories", posixState, async (t) => {
  const options = await fixture(t);
  await loadPublisherState(options.path, options);
  await chmod(options.path, 0o644);
  await assert.rejects(loadPublisherState(options.path, options));
  await chmod(options.path, 0o600);
  const alias = join(options.directory, "alias.json");
  await symlink(options.path, alias);
  await assert.rejects(loadPublisherState(alias, options));
  await rm(alias);
  await link(options.path, alias);
  await assert.rejects(loadPublisherState(options.path, options));
  await rm(alias);
  await chmod(options.directory, 0o777);
  await assert.rejects(loadPublisherState(options.path, options));
  await chmod(options.directory, 0o700);
});

test("concurrent state creation publishes one complete identity", posixState, async (t) => {
  const options = await fixture(t);
  const states = await Promise.all(Array.from({ length: 8 }, () => loadPublisherState(options.path, options)));
  assert.ok(states.every((state) => state.streamEvent.id === states[0].streamEvent.id && state.swarmId === states[0].swarmId));
  assert.equal((await stat(options.path)).nlink, 1);
  assert.equal((await stat(options.path)).mode & 0o777, 0o600);
});

test("Windows rejects persistent state before creating or reading private files", { skip: process.platform !== "win32" ? "Exercises the unsupported Windows ACL boundary on Windows." : false }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "relayswarm-state-unsupported-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "private-state.json");
  const unsupported = { code: "ERR_PUBLISHER_STATE_UNSUPPORTED_PLATFORM", message: /POSIX file permissions.*Windows ACL support/u };
  await assert.rejects(loadPublisherState(path), unsupported);
  assert.deepEqual(await readdir(directory), []);
  const sentinel = "existing state must remain untouched";
  await writeFile(path, sentinel);
  await assert.rejects(loadPublisherState(path), unsupported);
  assert.equal(await readFile(path, "utf8"), sentinel);
  assert.deepEqual(await readdir(directory), ["private-state.json"]);
});
