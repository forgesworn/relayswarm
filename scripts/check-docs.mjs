import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { documentationSources, outsideFences, rawBase, renderAiContext, root } from './build-ai-context.mjs';

const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sources = [...await documentationSources(), 'AGENTS.md', 'CLAUDE.md', 'llms.txt', 'spikes/RESULTS.md'];
const documents = new Map(await Promise.all(sources.map(async source => [source, await readFile(resolve(root, source), 'utf8')])));
const failures = [];
let linkCount = 0;

function prose(markdown) {
  // The transformation runs only outside code fences.
  let result = '';
  outsideFences(markdown, line => { result += `${line}\n`; return line; });
  return result;
}
function anchors(markdown) {
  const counts = new Map(), result = new Set();
  for (const line of prose(markdown).split('\n')) {
    const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?$/u.exec(line)?.[1];
    if (!heading) continue;
    const slug = heading.toLowerCase().replace(/<[^>]*>/gu, '').replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/gu, '-');
    const count = counts.get(slug) || 0; counts.set(slug, count + 1);
    result.add(count ? `${slug}-${count}` : slug);
  }
  return result;
}
async function checkLink(target, source) {
  let local;
  if (target.startsWith(rawBase)) local = target.slice(rawBase.length);
  else if (target.startsWith('https://github.com/forgesworn/relayswarm/blob/main/')) local = target.split('/blob/main/')[1];
  else if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)) return;
  else local = target.startsWith('#') ? `${source}${target}` : posix.join(posix.dirname(source), target);
  const [path, fragment] = local.split('#');
  const filename = decodeURIComponent(path.split('?')[0]);
  if (filename.startsWith('/') || filename === '..' || filename.startsWith('../')) throw new Error(`link leaves repository: ${target}`);
  const file = resolve(root, filename);
  await stat(file);
  if (fragment && filename.endsWith('.md')) {
    const markdown = documents.get(filename) ?? await readFile(file, 'utf8');
    assert.ok(anchors(markdown).has(decodeURIComponent(fragment)), `missing heading #${fragment} in ${filename}`);
  }
  linkCount++;
}

for (const [source, markdown] of documents) {
  for (const match of prose(markdown).matchAll(/!?\[[^\]\n]*\]\(([^\s)]+)\)/gu)) {
    try { await checkLink(match[1], source); } catch (error) { failures.push(`${source}: ${error.message}`); }
  }
  for (const match of markdown.matchAll(/\bnpm run ([a-z][\w:-]*)/gu)) {
    if (!metadata.scripts[match[1]]) failures.push(`${source}: unknown npm script ${match[1]}`);
  }
}

const index = documents.get('llms.txt');
if (!index.startsWith('# RelaySwarm\n') || !/^> /mu.test(index)) failures.push('llms.txt: expected project heading and blockquote summary');
let inList = false;
for (const line of index.split('\n')) {
  if (line.startsWith('## ')) { inList = true; continue; }
  if (inList && line.trim() && !/^- \[[^\]]+\]\(https:\/\/[^)]+\): .+/u.test(line)) failures.push(`llms.txt: expected annotated public file link: ${line}`);
}

for (const [subpath, target] of Object.entries(metadata.exports)) {
  if (subpath.includes('*') || !target.endsWith('.mjs')) continue;
  const module = await readFile(resolve(root, target), 'utf8');
  const exported = [...module.matchAll(/\bexport (?:async )?(?:class|function\*?|const) ([A-Za-z]\w*)/gu)].map(match => match[1]).sort();
  const name = `relayswarm${subpath === '.' ? '' : `/${subpath.slice(2)}`}`;
  const row = documents.get('docs/API.md').split('\n').find(line => line.startsWith(`| \`${name}\` |`));
  const documented = [...(row?.split(' | ')[2] || '').matchAll(/`([A-Za-z]\w*)`/gu)].map(match => match[1]).sort();
  try { assert.deepEqual(documented, exported); }
  catch { failures.push(`API: ${name} export table differs from its module (${exported.join(', ')})`); }
}

try { assert.equal(await readFile(resolve(root, 'llms-full.txt'), 'utf8'), await renderAiContext()); }
catch { failures.push('llms-full.txt is missing or stale; run npm run docs:generate'); }
if (!documents.get('CLAUDE.md').startsWith('@AGENTS.md\n')) failures.push('CLAUDE.md must import AGENTS.md');

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Documentation passed: ${sources.length} authored files, ${linkCount} repository links, API exports and current AI context.`);
