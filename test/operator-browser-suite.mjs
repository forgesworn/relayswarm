#!/usr/bin/env node
// Forward the same CLI options to the serial browser journeys in CI and locally.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let child, interrupted;
const forward = (signal) => { interrupted = signal; child?.kill(signal); };
const onInterrupt = () => forward("SIGINT"), onTerminate = () => forward("SIGTERM");
process.on("SIGINT", onInterrupt); process.on("SIGTERM", onTerminate);
try {
  for (const script of ["operator-browser.mjs", "policy-cache-browser.mjs", "account-budget-browser.mjs"]) {
    if (interrupted) break;
    child = spawn(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("exit", (status) => resolve(status ?? 1));
    });
    child = undefined;
    if (code !== 0) { process.exitCode = code; break; }
  }
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
} finally {
  process.removeListener("SIGINT", onInterrupt); process.removeListener("SIGTERM", onTerminate);
}
