#!/usr/bin/env node
import { constants } from "node:fs";
import { open, lstat, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fetchNativeObject } from "../src/native-client.mjs";

async function main() {
  const { values } = parseArgs({ options: { descriptor: { type: "string" }, output: { type: "string" },
    bootstrap: { type: "string", multiple: true }, "peer-timeout": { type: "string", default: "10000" },
    "allow-loopback": { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help) { console.log("relayswarm-native --descriptor trusted-object.json --output new-file [--bootstrap host:port] [--peer-timeout 10000] [--allow-loopback]\nRequires Node 22+. Digest and size in the local descriptor must come from a trusted application source. Output is created only after verification and existing files are never replaced."); return; }
  if (!values.descriptor || !values.output) throw new Error("Supply --descriptor and --output.");
  try { await lstat(values.output); throw Object.assign(new Error("Output already exists."), { code: "EEXIST" }); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const handle = await open(values.descriptor, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let descriptor;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 65536) throw new Error("Descriptor must be a regular file of at most 64 KiB.");
    const buffer = Buffer.alloc(65537), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error("Descriptor exceeds 64 KiB.");
    descriptor = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await handle.close(); }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Native transfer cancelled."));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    const result = await fetchNativeObject(descriptor, { bootstrap: values.bootstrap, peerTimeoutMs: Number(values["peer-timeout"]),
      allowLoopback: values["allow-loopback"], signal: controller.signal });
    const temporary = join(dirname(values.output), `.relayswarm-native-${randomUUID()}.tmp`);
    const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await output.writeFile(result.bytes); await output.sync(); } finally { await output.close(); }
      await link(temporary, values.output);
    } finally { await unlink(temporary); }
    console.log(JSON.stringify(result.receipt));
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

main().catch(() => { console.error("Native transfer failed; no unverified media was accepted. Check the trusted descriptor and endpoint policy."); process.exitCode = 1; });
