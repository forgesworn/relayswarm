#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "scripts", "spikes", "test"];
const files = ["poc.mjs", "native-poc.mjs"];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && extname(entry.name) === ".mjs") files.push(path);
  }
}

for (const root of roots) await collect(root);

for (const file of [...new Set(files)].sort()) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

process.stdout.write(`syntax OK (${files.length} modules)\n`);
