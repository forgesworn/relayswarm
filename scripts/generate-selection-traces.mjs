#!/usr/bin/env node
// Write seeded PeerSelection and NeighbourDiscovery sequences, with the
// JavaScript's outputs, for the Rust tests. Deterministic, so not committed:
// cargo test reads core/target/js-traces/selection-traces.json.

import { mkdir, writeFile } from "node:fs/promises";
import { discoveryOps, discoveryScenarios, runDiscoveryOps, runSelectionOps, selectionOps } from "../test/selection-traces.mjs";

const directory = new URL("../core/target/js-traces/", import.meta.url);
const selection = [1, 2, 3, 4, 5, 6].map((seed) => { const ops = selectionOps(seed, 250); return { seed, ops, expected: runSelectionOps(ops) }; });
const discovery = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => { const ops = discoveryOps(seed, 250); return { seed, ops, expected: runDiscoveryOps(ops) }; })
  .concat(discoveryScenarios.map(({ name, ops }) => ({ seed: name, ops, expected: runDiscoveryOps(ops) })));
await mkdir(directory, { recursive: true });
await writeFile(new URL("selection-traces.json", directory), `${JSON.stringify({ selection, discovery })}\n`);
process.stdout.write(`wrote ${selection.length} selection and ${discovery.length} discovery sequences\n`);
