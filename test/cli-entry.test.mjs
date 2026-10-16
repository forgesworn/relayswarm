import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isCliEntry } from "../src/cli-entry.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url))), run = promisify(execFile);

test("CLI identity distinguishes its entry point from imports and missing paths", async () => {
  assert.equal(await isCliEntry(import.meta.url, fileURLToPath(import.meta.url)), true);
  assert.equal(await isCliEntry(import.meta.url, join(root, "demo/server.mjs")), false);
  assert.equal(await isCliEntry(import.meta.url, join(root, "missing-entry.mjs")), false);
  assert.equal(await isCliEntry(import.meta.url, ""), false);
  for (const script of ["demo/server.mjs", "scripts/broadcast.mjs", "scripts/probe-control-path.mjs"]) {
    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(join(root, script)).href)})`], { timeout: 5000 });
    assert.equal(stdout, "", "Importing a CLI must not run its command.");
  }
});

test("actual demo and broadcaster commands run through an absolute directory alias", { skip: process.platform === "win32", timeout: 10000 }, async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "relayswarm-cli-alias-")));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const alias = join(scratch, "package"); await symlink(root, alias, "dir");
  for (const script of ["demo/server.mjs", "scripts/broadcast.mjs"]) {
    const { stdout } = await run(process.execPath, [join(alias, script), "--help"], { timeout: 3000 });
    assert.ok(stdout.includes("--ice-config FILE"), "Alias invocation must execute the help command.");
  }
  await assert.rejects(run(process.execPath, [join(alias, "scripts/probe-control-path.mjs"), "--duration", "0"], { timeout: 3000 }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /Control probe failed/u);
    return true;
  });
});
