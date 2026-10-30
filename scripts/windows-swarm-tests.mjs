#!/usr/bin/env node

// Share selectors between the required Windows jobs. This changes scheduling,
// not test clocks, assertions or the original four-file Windows test universe.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const hardening = 'test/browser-hardening.test.mjs';
export const files = ['test/hls-swarm.test.mjs', hardening,
  'test/stream-discovery.test.mjs', 'test/origin-range.test.mjs'];
export const modelNames = [
  "mixed planning keeps each holder's first byte and payload flow separate after cold startup",
  'short or stale holder evidence receives bounded demand-bound refresh and can recover',
  'an origin-winning abort invalidates unknown-flow continuation without charging a holder failure',
  'known whole-unfit cached peer-only work leaves immediate HTTP alone',
  'known whole-fit cached peer-only work combines admissible holders',
  'multi-holder: a slow origin tail keeps the measured recovery reserve instead of falling back after two seconds',
];
export const escapeTestName = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const models = `^(?:${modelNames.map(escapeTestName).join('|')})$`;
const mixed = '^(?:buffered mixed |owned warm |owned steady warm |real Core contrasts legacy warm )';
const mixedA = '^(?:owned warm |owned steady warm |real Core contrasts legacy warm |buffered mixed (?:retains a shorter absolute parent|whole fallback |entry clock |cached handoff |preserves measured source recovery ))';
const mixedC = '^buffered mixed (?:leaves the next source recovery |retires peer work |verifies a pre-cap |discards physical peer )';
export const partitions = {
  base: { files, skip: `(?:${models}|${mixed})` },
  models: { files: [hardening], include: models },
  'mixed-a': { files: [hardening], include: mixedA },
  'mixed-b': { files: [hardening], include: mixed, skip: `(?:${mixedA}|${mixedC})` },
  'mixed-c': { files: [hardening], include: mixedC },
};

export function classifyRegistrations(input) {
  const rows = Array.isArray(input) ? input : input?.registrations;
  assert.ok(Array.isArray(rows) && rows.length, 'expected enumerated {file,name} registrations');
  const seen = new Set(), counts = Object.fromEntries(Object.keys(partitions).map(key => [key, 0]));
  const fileCounts = Object.fromEntries(files.map(file => [file, 0]));
  const classified = rows.map(row => {
    assert.ok(files.includes(row?.file) && typeof row.name === 'string' && row.name.length,
      'registration must belong to the original Windows four-file universe');
    const identity = JSON.stringify([row.file, row.name]);
    assert.ok(!seen.has(identity), `duplicate registration: ${identity}`);
    seen.add(identity);
    const selected = Object.entries(partitions).filter(([, p]) => p.files.includes(row.file) &&
      (!p.include || new RegExp(p.include).test(row.name)) && (!p.skip || !new RegExp(p.skip).test(row.name)));
    assert.equal(selected.length, 1, `registration must select exactly one job: ${identity}`);
    const partition = selected[0][0];
    counts[partition]++;
    fileCounts[row.file]++;
    return { ...row, partition };
  });
  for (const name of modelNames) assert.equal(classified.filter(row => row.file === hardening &&
    row.name === name && row.partition === 'models').length, 1, `missing required model: ${name}`);
  for (const [name, count] of Object.entries({ ...counts, ...fileCounts })) assert.ok(count > 0, `empty partition/file: ${name}`);
  return { total: classified.length, counts, fileCounts, registrations: classified };
}

function main(args) {
  if (['--classify', '--list'].includes(args[0]) && args.length === 2) {
    // The census must enumerate registrations without executing test callbacks;
    // classification cannot establish the completeness of an arbitrary input.
    const result = classifyRegistrations(JSON.parse(readFileSync(args[1], 'utf8')));
    if (args[0] === '--classify') delete result.registrations;
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  assert.ok(args.length === 1 && Object.hasOwn(partitions, args[0]),
    'usage: windows-swarm-tests.mjs base|models|mixed-a|mixed-b|mixed-c OR --classify|--list census.json');
  const partition = partitions[args[0]], command = ['--test', '--test-reporter=tap'];
  if (partition.include) command.push('--test-name-pattern', partition.include);
  if (partition.skip) command.push('--test-skip-pattern', partition.skip);
  const child = spawnSync(process.execPath, [...command, ...partition.files], { cwd: root, stdio: 'inherit', shell: false });
  if (child.error) throw child.error;
  if (child.signal) console.error(`Windows swarm child terminated by ${child.signal}`);
  process.exitCode = child.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
