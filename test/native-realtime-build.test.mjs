import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, readdir, realpath, rm, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertNativeSourcePristine, readBoundedNativeDownload, withNativeBuildWorkspace,
  preflightNativeOutput, readPreparedNativeRealtime, NATIVE_OUTPUT_FILES, NATIVE_SOURCES,
  NATIVE_PATCHES, NATIVE_BINDING_VERSION, NATIVE_LIBRARY_VERSION } from '../scripts/build-native-realtime.mjs';

async function scratch(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'relayswarm-native-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function repository(t) {
  const directory = await scratch(t);
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.name', 'Synthetic build fixture');
  git(directory, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(directory, '.gitignore'), 'generated/\n');
  await writeFile(join(directory, 'CMakeLists.txt'), 'set(REVIEWED_SOURCE true)\n');
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'Synthetic reviewed inputs');
  return { directory, revision: git(directory, 'rev-parse', 'HEAD') };
}

test('native source verifier rejects staged, unstaged, untracked and ignored executable build inputs', async t => {
  const { directory, revision } = await repository(t);
  await assertNativeSourcePristine(directory, revision);
  await writeFile(join(directory, 'CMakeLists.txt'), 'execute_process(COMMAND unexpected)\n');
  await assert.rejects(assertNativeSourcePristine(directory, revision));
  git(directory, 'add', 'CMakeLists.txt');
  await assert.rejects(assertNativeSourcePristine(directory, revision));
  git(directory, 'reset', '--hard', 'HEAD');
  await writeFile(join(directory, 'injected.cmake'), 'unexpected\n');
  await assert.rejects(assertNativeSourcePristine(directory, revision));
  await rm(join(directory, 'injected.cmake'));
  await mkdir(join(directory, 'generated'));
  await writeFile(join(directory, 'generated', 'unexpected.c'), 'unexpected\n');
  await assert.rejects(assertNativeSourcePristine(directory, revision));
  await rm(join(directory, 'generated'), { recursive: true });
  await assertNativeSourcePristine(directory, revision);
  await assert.rejects(assertNativeSourcePristine(directory, '0'.repeat(40)));
});

test('fresh invocation never consumes or deletes prior source/OpenSSL/CMake caches', async t => {
  const work = await scratch(t);
  for (const folder of ['node-datachannel', 'openssl-install', 'cmake-build']) {
    await mkdir(join(work, folder)); await writeFile(join(work, folder, 'unreviewed'), folder);
  }
  let first;
  await withNativeBuildWorkspace(work, async directory => {
    first = directory; assert.deepEqual(await readdir(directory), []);
    await writeFile(join(directory, 'owned-artifact'), 'synthetic');
  });
  await assert.rejects(lstat(first), { code: 'ENOENT' });
  const primary = new Error('synthetic compiler failure');
  await assert.rejects(withNativeBuildWorkspace(work, async directory => {
    assert.notEqual(directory, first); assert.deepEqual(await readdir(directory), []);
    // Simulate a cleanup failure; it must not hide the compiler's error.
    await rm(join(work, 'build.lock'));
    throw primary;
  }), error => error === primary);
  assert.deepEqual((await readdir(work)).sort(), ['cmake-build', 'node-datachannel', 'openssl-install']);
  for (const folder of ['node-datachannel', 'openssl-install', 'cmake-build']) {
    assert.equal(await readFile(join(work, folder, 'unreviewed'), 'utf8'), folder);
  }
});

test('prepared receipt refuses mismatched source/config/file sets and tampered binary bytes without loading native code', async t => {
  const output = await scratch(t), files = {};
  await mkdir(join(output, 'LICENSES')); await mkdir(join(output, 'patches'));
  for (const name of NATIVE_OUTPUT_FILES) {
    const bytes = name.startsWith('patches/')
      ? await readFile(fileURLToPath(new URL('../scripts/native-patches/' + name.slice(8), import.meta.url)))
      : Buffer.from('synthetic verifier fixture ' + name);
    await writeFile(join(output, name), bytes);
    files[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const original = { format: 1, bindingVersion: NATIVE_BINDING_VERSION, libraryVersion: NATIVE_LIBRARY_VERSION,
    platform: process.platform, arch: process.arch, sourceModified: true, sources: NATIVE_SOURCES, patches: NATIVE_PATCHES,
    build: { maxJobs: 2, media: false, websocket: false }, files };
  const receipt = value => writeFile(join(output, 'native-addon.json'), JSON.stringify(value));
  await receipt(original); await readPreparedNativeRealtime(output);
  await receipt({ ...original, sources: { ...original.sources, libjuice: '0'.repeat(40) } });
  await assert.rejects(readPreparedNativeRealtime(output));
  await receipt({ ...original, build: { ...original.build, media: true } });
  await assert.rejects(readPreparedNativeRealtime(output));
  await receipt({ ...original, files: { ...files, 'other.node': '0'.repeat(64) } });
  await assert.rejects(readPreparedNativeRealtime(output));
  await receipt(original);
  await writeFile(join(output, 'native-addon.node'), 'changed native code');
  await assert.rejects(readPreparedNativeRealtime(output));
});

test('native download rejects declared oversize before reading and cancels chunked overflow', async () => {
  let cancelled = false, read = false;
  const oversized = { ok: true, headers: new Headers({ 'content-length': '9' }), body: {
    cancel: async () => { cancelled = true; }, getReader: () => { read = true; throw new Error('must not read'); },
  } };
  await assert.rejects(readBoundedNativeDownload(oversized, 8));
  assert.equal(cancelled, true); assert.equal(read, false);
  cancelled = false;
  let pulls = 0;
  const stream = new ReadableStream({ pull(controller) {
    pulls++; controller.enqueue(new Uint8Array(5));
  }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedNativeDownload(new Response(stream), 8));
  assert.equal(cancelled, true); assert(pulls <= 3);
  assert.deepEqual(await readBoundedNativeDownload(new Response(new Uint8Array([1, 2, 3])), 3), new Uint8Array([1, 2, 3]));
});

test('output preflight permits known regular upgrades and refuses unrelated files or symlink targets before overwrite', async t => {
  const root = await scratch(t), output = join(root, 'output');
  await preflightNativeOutput(output);
  await writeFile(join(output, 'native-addon.node'), 'previous reviewed artifact');
  await mkdir(join(output, 'LICENSES'));
  await writeFile(join(output, 'LICENSES', 'libjuice.txt'), 'previous notice');
  await preflightNativeOutput(output);
  await writeFile(join(output, 'unrelated.txt'), 'preserve');
  await assert.rejects(preflightNativeOutput(output));
  assert.equal(await readFile(join(output, 'unrelated.txt'), 'utf8'), 'preserve');
  await rm(join(output, 'unrelated.txt'));
  await writeFile(join(output, 'LICENSES', 'unrelated.txt'), 'preserve nested');
  await assert.rejects(preflightNativeOutput(output));
  await rm(join(output, 'LICENSES', 'unrelated.txt'));
  const external = join(root, 'external'); await writeFile(external, 'untouched');
  await rm(join(output, 'native-addon.node')); await symlink(external, join(output, 'native-addon.node'));
  await assert.rejects(preflightNativeOutput(output));
  assert.equal(await readFile(external, 'utf8'), 'untouched');
  await symlink(output, join(root, 'linked-output'));
  await assert.rejects(preflightNativeOutput(join(root, 'linked-output')));
  await symlink(root, join(root, 'linked-parent'));
  await assert.rejects(preflightNativeOutput(join(root, 'linked-parent', 'new-output')));
  await assert.rejects(lstat(join(root, 'new-output')), { code: 'ENOENT' });
});
