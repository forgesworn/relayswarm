#!/usr/bin/env node
// Explicit preparation only. Importing the validator never builds or fetches.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, readdir, copyFile, symlink, realpath, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_LIBRARY_VERSION = '0.24.5-forgesworn-turn-close.1';
export const NATIVE_BINDING_VERSION = '0.33.4';
export const NATIVE_SOURCES = Object.freeze({
  nodeDataChannel: '5f4365700d4dcc51ab2a3d90eb2d05592bf84c7a',
  libdatachannel: '443f6934d9007eb7076ab7825ba330f355fcbead',
  libjuice: '3c40a3545b6b1b62c7adee7f8f2bd58aa290afd6',
  usrsctp: 'fec583d54493f879d2ae44a743423bf8a04371ab',
  plog: '94899e0b926ac1b0f4750bfbd495167b4a6ae9ef',
  openssl: 'c9a9e5b10105ad850b6e4d1122c645c67767c341',
  nodeLicense: 'def0bdf8abee441cfcbf793a8dc24a6f3b899573:sha256:537308465103a306d0e3eecf42632b4ff1b48aaaec044e9fc10a78c81fd00b34',
  nodeHeaders: 'v24.13.0:sha256:f5589e2b4b962af05381a31d11c3c9b004daf8bd63c95c0e1a406600daa8ae88',
  nodeAddonApi: '8.5.0:sha512:/bRZty2mXUIFY/xU5HLvveNHlswNJej+RnxBjOMkidWfwZzgTbPG1E3K5TOxRLOR+5hX7bSofy8yf1hZevMS8A==',
});
export const NATIVE_PATCHES = Object.freeze({
  'libjuice-turn-close.patch': 'fe802d2af81470a65f9f2dee2c393a8d8468129a228714f2041960e013020069',
  'libdatachannel-version.patch': 'a81117db1686a20f8a9eeb95325018b2e2f65cdab7dbc90c74b26300db717e50',
});
const licences = ['node-datachannel', 'libdatachannel', 'libjuice', 'usrsctp', 'plog', 'openssl', 'node-addon-api', 'node-headers'];
export const NATIVE_OUTPUT_FILES = Object.freeze(['native-addon.node', 'SOURCE_NOTICE.txt',
  ...licences.map(name => `LICENSES/${name}.txt`), ...Object.keys(NATIVE_PATCHES).map(name => `patches/${name}`)]);
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const reject = () => new Error('Prepared native real-time artifact failed verification.');
const same = (a, b) => JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b).sort());

async function regular(directory, name, maximum) {
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const info = await lstat(join(directory, ...parts.slice(0, i)));
    if (!info.isDirectory() || info.isSymbolicLink()) throw reject();
  }
  const path = join(directory, name), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) throw reject();
  return readFile(path);
}

/** Validates bytes and provenance without loading the native addon. */
export async function readPreparedNativeRealtime(directory) {
  const supplied = resolve(directory), info = await lstat(supplied);
  if (!info.isDirectory() || info.isSymbolicLink()) throw reject();
  const base = await realpath(supplied);
  const receipt = JSON.parse(await regular(base, 'native-addon.json', 64 * 1024));
  if (receipt.format !== 1 || receipt.bindingVersion !== NATIVE_BINDING_VERSION || receipt.libraryVersion !== NATIVE_LIBRARY_VERSION
    || receipt.platform !== process.platform || receipt.arch !== process.arch || receipt.sourceModified !== true
    || !same(receipt.sources, NATIVE_SOURCES) || !same(receipt.patches, NATIVE_PATCHES)
    || receipt.build?.maxJobs !== 2 || receipt.build?.media !== false || receipt.build?.websocket !== false
    || !same(Object.fromEntries(Object.keys(receipt.files ?? {}).map(name => [name, true])), Object.fromEntries(NATIVE_OUTPUT_FILES.map(name => [name, true])))) throw reject();
  for (const name of NATIVE_OUTPUT_FILES) {
    if (!/^[0-9a-f]{64}$/.test(receipt.files[name])) throw reject();
    const bytes = await regular(base, name, name.endsWith('.node') ? 64 * 1024 * 1024 : 1024 * 1024);
    if (digest(bytes) !== receipt.files[name]) throw reject();
    if (name.startsWith('patches/') && digest(bytes) !== NATIVE_PATCHES[name.slice(8)]) throw reject();
  }
  // Extra files could otherwise be mistaken for reviewed executable material.
  for (const name of await readdir(base)) if (!['native-addon.node', 'native-addon.json', 'SOURCE_NOTICE.txt', 'LICENSES', 'patches'].includes(name)) throw reject();
  for (const folder of ['LICENSES', 'patches']) {
    const expected = NATIVE_OUTPUT_FILES.filter(name => name.startsWith(folder + '/')).map(name => name.slice(folder.length + 1)).sort();
    if (JSON.stringify((await readdir(join(base, folder))).sort()) !== JSON.stringify(expected)) throw reject();
  }
  return { receipt, files: [...NATIVE_OUTPUT_FILES] };
}

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CMAKE_BUILD_PARALLEL_LEVEL: '2' }, ...options });
}
function git(directory, args) { return execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
/** Refuse every additional build input, including staged and ignored files.
 * Called on fresh owned source trees before adding only pinned patches/deps. */
export async function assertNativeSourcePristine(directory, revision, url) {
  if (git(directory, ['rev-parse', 'HEAD']) !== revision
    || (url && git(directory, ['remote', 'get-url', 'origin']) !== url)
    || git(directory, ['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])) throw reject();
}
async function clone(directory, url, revision) {
  if (!await exists(join(directory, '.git'))) {
    await mkdir(directory, { recursive: true }); run('git', ['init', '-q'], directory);
    run('git', ['remote', 'add', 'origin', url], directory);
    run('git', ['fetch', '--depth=1', 'origin', revision], directory);
    run('git', ['checkout', '--detach', '--force', revision], directory);
  }
  await assertNativeSourcePristine(directory, revision, url);
}
export async function readBoundedNativeDownload(response, maximum = 64 * 1024 * 1024) {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 * 1024 || !response.ok || !response.body) throw reject();
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await response.body.cancel(); throw reject();
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength > maximum - length) throw reject();
      length += value.byteLength; chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
async function download(url, path, algorithm, expected, encoding = 'hex') {
  // Every invocation owns a fresh destination: no unverified archive cache.
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  const bytes = await readBoundedNativeDownload(response);
  if (digest(bytes, algorithm, encoding) !== expected) throw reject();
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
}
async function apply(directory, patch) {
  // Fresh source was verified pristine above. Never reverse/restore a patch
  // in an existing checkout: staged or unexpected changes must not disappear.
  git(directory, ['diff', '--exit-code', '--quiet', 'HEAD', '--ignore-submodules=all']);
  run('git', ['apply', '--check', patch], directory); run('git', ['apply', patch], directory);
}
async function copyLicence(source, target) {
  for (const name of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING']) if (await exists(join(source, name))) {
    await copyFile(join(source, name), target); return;
  }
  throw new Error('Pinned native source licence was not found.');
}

/** Only fixed managed regular files may be replaced; never follow an output
 * symlink or overwrite/remove an unrelated entry, including nested files. */
export async function preflightNativeOutput(directory) {
  const absolute = resolve(directory), rootPath = parse(absolute).root;
  let current = rootPath;
  for (const part of absolute.slice(rootPath.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!await exists(current)) await mkdir(current);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw reject();
  }
  const allowed = new Set(['native-addon.json', ...NATIVE_OUTPUT_FILES]);
  for (const name of await readdir(absolute)) {
    const info = await lstat(join(absolute, name));
    if (info.isSymbolicLink()) throw reject();
    if (['LICENSES', 'patches'].includes(name)) {
      if (!info.isDirectory()) throw reject();
      for (const child of await readdir(join(absolute, name))) {
        const childInfo = await lstat(join(absolute, name, child));
        if (!allowed.has(name + '/' + child) || !childInfo.isFile() || childInfo.isSymbolicLink()) throw reject();
      }
    } else if (!allowed.has(name) || !info.isFile()) throw reject();
  }
}

/** Derived artifacts are never reused. Existing work/cache trees remain
 * untouched; only this invocation's newly owned child is cleaned. */
export async function withNativeBuildWorkspace(work, build) {
  await mkdir(work, { recursive: true });
  const lockPath = join(work, 'build.lock');
  const lock = await import('node:fs/promises').then(fs => fs.open(lockPath, 'wx', 0o600));
  let invocation, failed = false;
  try {
    invocation = await mkdtemp(join(work, 'invocation-'));
    return await build(invocation);
  } catch (error) { failed = true; throw error; }
  finally {
    let cleanupError;
    for (const cleanup of [() => invocation && rm(invocation, { recursive: true, force: true }),
      () => lock.close(), () => import('node:fs/promises').then(fs => fs.unlink(lockPath))]) {
      try { await cleanup(); } catch (error) { cleanupError ??= error; }
    }
    if (!failed && cleanupError) throw cleanupError;
  }
}

/** Network/source compilation happens only through this explicit command. */
export async function buildNativeRealtime({ output = join(root, 'target/realtime-native'),
  work = join(root, 'target/realtime-native-work'), cmake = 'cmake' } = {}) {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) throw reject();
  output = resolve(output); work = resolve(work);
  await preflightNativeOutput(output);
  return withNativeBuildWorkspace(work, async invocation => {
    const patchDirectory = join(invocation, 'patches'); await mkdir(patchDirectory);
    for (const [name, hash] of Object.entries(NATIVE_PATCHES)) {
      const bytes = await regular(join(root, 'scripts/native-patches'), name, 1024 * 1024);
      if (digest(bytes) !== hash) throw reject();
      // Apply and distribute the same verified snapshot even if a concurrent
      // maintainer changes their source checkout while this build runs.
      await writeFile(join(patchDirectory, name), bytes, { flag: 'wx', mode: 0o600 });
    }
    const binding = join(invocation, 'node-datachannel'), library = join(invocation, 'libdatachannel'), openssl = join(invocation, 'openssl');
    await clone(binding, 'https://github.com/murat-dogan/node-datachannel.git', NATIVE_SOURCES.nodeDataChannel);
    await clone(library, 'https://github.com/paullouisageneau/libdatachannel.git', NATIVE_SOURCES.libdatachannel);
    run('git', ['submodule', 'update', '--init', '--depth=1', 'deps/libjuice', 'deps/usrsctp', 'deps/plog'], library);
    for (const name of ['libjuice', 'usrsctp', 'plog']) await assertNativeSourcePristine(join(library, 'deps', name), NATIVE_SOURCES[name]);
    await assertNativeSourcePristine(library, NATIVE_SOURCES.libdatachannel);
    await clone(openssl, 'https://github.com/openssl/openssl.git', NATIVE_SOURCES.openssl);
    await apply(join(library, 'deps/libjuice'), join(patchDirectory, 'libjuice-turn-close.patch'));
    await apply(library, join(patchDirectory, 'libdatachannel-version.patch'));
    await download('https://nodejs.org/dist/v24.13.0/node-v24.13.0-headers.tar.gz', join(invocation, 'headers.tgz'), 'sha256', NATIVE_SOURCES.nodeHeaders.split(':').at(-1));
    await download('https://registry.npmjs.org/node-addon-api/-/node-addon-api-8.5.0.tgz', join(invocation, 'addon-api.tgz'), 'sha512', NATIVE_SOURCES.nodeAddonApi.split(':').at(-1), 'base64');
    await download(`https://raw.githubusercontent.com/nodejs/node/${NATIVE_SOURCES.nodeLicense.split(':')[0]}/LICENSE`,
      join(invocation, 'node-LICENSE'), 'sha256', NATIVE_SOURCES.nodeLicense.split(':').at(-1));
    const headers = join(invocation, 'headers'), api = join(binding, 'node_modules/node-addon-api');
    await mkdir(headers, { recursive: true }); await mkdir(api, { recursive: true });
    run('tar', ['-xzf', join(invocation, 'headers.tgz'), '--strip-components=1', '-C', headers], invocation);
    run('tar', ['-xzf', join(invocation, 'addon-api.tgz'), '--strip-components=1', '-C', api], invocation);
    const sslPrefix = join(invocation, 'openssl-install');
    if (!await exists(join(sslPrefix, 'lib/libcrypto.a'))) {
      const target = process.platform === 'darwin' ? (process.arch === 'arm64' ? 'darwin64-arm64-cc' : 'darwin64-x86_64-cc')
        : process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64';
      run('perl', ['Configure', target, 'no-shared', 'no-tests', '-fPIC', '--libdir=lib', `--prefix=${sslPrefix}`], openssl);
      run('make', ['-j2', 'build_libs'], openssl); run('make', ['install_dev'], openssl);
    }
    const build = join(invocation, 'cmake-build'); await mkdir(join(build, '_deps'), { recursive: true });
    if (!await exists(join(build, '_deps/libdatachannel-src'))) await symlink(library, join(build, '_deps/libdatachannel-src'), 'dir');
    run(cmake, ['-S', binding, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POSITION_INDEPENDENT_CODE=ON',
      '-DBUILD_SHARED_LIBS=OFF', '-DNO_MEDIA=ON', '-DNO_WEBSOCKET=ON', '-DNO_EXAMPLES=ON', '-DNO_TESTS=ON',
      '-DUSE_NICE=OFF', '-DUSE_GNUTLS=OFF', '-DUSE_MBEDTLS=OFF', `-DFETCHCONTENT_SOURCE_DIR_LIBDATACHANNEL=${library}`,
      `-DCMAKE_JS_INC=${join(headers, 'include/node')}`, `-DOPENSSL_ROOT_DIR=${sslPrefix}`,
      `-DOPENSSL_CRYPTO_LIBRARY=${join(sslPrefix, 'lib/libcrypto.a')}`, `-DOPENSSL_SSL_LIBRARY=${join(sslPrefix, 'lib/libssl.a')}`,
      ...(process.platform === 'darwin' ? ['-DCMAKE_SHARED_LINKER_FLAGS=-undefined dynamic_lookup'] : [])], invocation);
    run(cmake, ['--build', build, '--target', 'node_datachannel', '--parallel', '2'], invocation);
    await preflightNativeOutput(output);
    await mkdir(join(output, 'LICENSES'), { recursive: true }); await mkdir(join(output, 'patches'), { recursive: true });
    await copyFile(join(build, 'node_datachannel.node'), join(output, 'native-addon.node'));
    for (const [name, source] of Object.entries({ 'node-datachannel': binding, libdatachannel: library,
      libjuice: join(library, 'deps/libjuice'), usrsctp: join(library, 'deps/usrsctp'), plog: join(library, 'deps/plog'),
      openssl, 'node-addon-api': api })) await copyLicence(source, join(output, 'LICENSES', name + '.txt'));
    await copyFile(join(invocation, 'node-LICENSE'), join(output, 'LICENSES/node-headers.txt'));
    for (const name of Object.keys(NATIVE_PATCHES)) await copyFile(join(patchDirectory, name), join(output, 'patches', name));
    await writeFile(join(output, 'SOURCE_NOTICE.txt'), `Modified native real-time sidecar: ${NATIVE_LIBRARY_VERSION}\n` +
      `node-datachannel source: https://github.com/murat-dogan/node-datachannel/tree/${NATIVE_SOURCES.nodeDataChannel}\n` +
      `libdatachannel source: https://github.com/paullouisageneau/libdatachannel/tree/${NATIVE_SOURCES.libdatachannel}\n` +
      `libjuice source: https://github.com/paullouisageneau/libjuice/tree/${NATIVE_SOURCES.libjuice}\n` +
      `Modified MPL-covered files: libjuice src/agent.c and src/agent.h; libdatachannel include/rtc/version.h. Exact changes accompany this artifact in patches/.\n` +
      `Rebuild with RelaySwarm scripts/build-native-realtime.mjs. Dependency revisions are in native-addon.json; licences in LICENSES/.\n` +
      `The native sidecar is not MIT-only. No npm prebuilt files were modified. Cleanup is bounded best effort, not delivery during a network partition.\n`);
    const files = {};
    for (const name of NATIVE_OUTPUT_FILES) files[name] = digest(await readFile(join(output, name)));
    const receipt = { format: 1, bindingVersion: NATIVE_BINDING_VERSION, libraryVersion: NATIVE_LIBRARY_VERSION,
      platform: process.platform, arch: process.arch, sourceModified: true, sources: NATIVE_SOURCES, patches: NATIVE_PATCHES,
      build: { maxJobs: 2, media: false, websocket: false }, files };
    await writeFile(join(output, 'native-addon.json'), JSON.stringify(receipt, null, 2) + '\n');
    return readPreparedNativeRealtime(output);
  });
}

let directlyInvoked = false;
try { directlyInvoked = Boolean(process.argv[1]) && await realpath(process.argv[1]) === fileURLToPath(import.meta.url); } catch {}
if (directlyInvoked) {
  const args = process.argv.slice(2), option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  try { await buildNativeRealtime({ output: option('--output', undefined), work: option('--work', undefined), cmake: option('--cmake', 'cmake') });
    process.stdout.write('Prepared verified native real-time sidecar.\n'); }
  catch { process.stderr.write('Native real-time preparation failed; inspect the owned build output.\n'); process.exitCode = 1; }
}
