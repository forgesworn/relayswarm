#!/usr/bin/env node

import { runNativeJourney } from "./src/native-journey.mjs";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

function values(name) {
  const found = [];
  for (let index = 0; index < process.argv.length - 1; index += 1) {
    if (process.argv[index] === name) found.push(process.argv[index + 1]);
  }
  return found;
}

function value(name, fallback) {
  return values(name).at(-1) ?? fallback;
}

const relayUrls = values("--relay");
const requestedSize = Number(value("--size", "1048576"));
if (!Number.isSafeInteger(requestedSize) || requestedSize < 0 || requestedSize > 256 * 1024 * 1024) {
  throw new Error("--size must be an integer between 0 and 268435456 bytes.");
}
const bootstrapValues = values("--bootstrap");

const result = await runNativeJourney({
  relayUrls: relayUrls.length ? relayUrls : DEFAULT_RELAYS,
  ...(bootstrapValues.length ? { bootstrap: bootstrapValues } : {}),
  bytes: Buffer.alloc(requestedSize, 0xa5),
  log: (message) => process.stderr.write(`[native] ${message}\n`),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
