#!/usr/bin/env node
// Playwright launches this executable in a detached group. Journal that group
// BEFORE Chrome starts, including the partial-launch path launchServer cannot return.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { birth, journal, cap, sameDirectory } from "./account-browser-guard.mjs";
const input = JSON.parse(readFileSync(process.env.RELAYSWARM_ACCOUNT_INPUT, "utf8"));
sameDirectory(input.root, input.rootIdentity);
cap(input.clock, "work", 1);
const owner = birth(process.pid); assert.equal(owner.pgid, process.pid);
journal(input.chromeJournal, { ...owner, nonce: input.nonce, at: new Date().toISOString() });
// This independent timer also survives a worker-side JS stall. No new epoch.
const alarm = setTimeout(() => process.kill(-process.pid, "SIGKILL"), cap(input.clock, "grace", 165000));
cap(input.clock, "work", 1);
const child = spawn(input.values.chrome, process.argv.slice(2), { stdio: [0, 1, 2, 3, 4] });
child.once("error", () => { clearTimeout(alarm); process.exit(1); });
child.once("exit", (code) => { clearTimeout(alarm); process.exit(code ?? 1); });
