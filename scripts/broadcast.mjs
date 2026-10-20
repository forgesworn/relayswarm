#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, realpath, lstat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startBroadcastPipeline } from "../src/broadcast-pipeline.mjs";
import { startDemoServer } from "../demo/server.mjs";
import { startBroadcastWaitingServer } from "../demo/broadcast-waiting.mjs";
import { readIceConfigFile } from "../src/ice-config.mjs";
import { isCliEntry } from "../src/cli-entry.mjs";
import { validateTurnCredentialsUrl, validateTurnUrlProjection } from "../demo/turn-credential-service.mjs";

async function privateFile(path, create) {
  const parent = dirname(resolve(path));
  const directory = await lstat(parent);
  if (!directory.isDirectory() || await realpath(parent) !== parent || (directory.mode & 0o022) || (typeof process.getuid === "function" && directory.uid !== process.getuid())) throw new Error("Secrets need an owner-controlled directory without symlinks.");
  if (create) {
    try { const fresh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); try { await fresh.writeFile(`${randomBytes(32).toString("hex")}\n`); await fresh.sync(); } finally { await fresh.close(); } }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const stat = await handle.stat(), entry = await lstat(path);
    if (!stat.isFile() || !entry.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > 4096) throw new Error("Secret files must be private regular files with mode 0600.");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(), current = await lstat(path);
    if (bytesRead > 4096 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1 || !current.isFile()) throw new Error("Secret file changed while reading.");
    const text = buffer.subarray(0, bytesRead).toString("utf8").trim();
    if (!text || /[\r\n]/u.test(text)) throw new Error("Secret file must contain one non-empty line.");
    return text;
  } finally { await handle.close(); }
}

async function main() {
  const { values } = parseArgs({ options: {
    input: { type: "string", default: "rtsp://127.0.0.1:8554/live" }, "state-dir": { type: "string", default: "artifacts/broadcast" }, ffmpeg: { type: "string", default: "ffmpeg" },
    mediamtx: { type: "string" }, "router-config": { type: "string", default: fileURLToPath(new URL("../broadcast/mediamtx.yml", import.meta.url)) },
    "youtube-url-file": { type: "string" }, "public-url": { type: "string" }, host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8787" },
    "admission-per-address-tickets": { type: "string", default: "12" },
    "admission-per-address-requests": { type: "string", default: "600" },
    "tls-key": { type: "string" }, "tls-cert": { type: "string" }, relay: { type: "string", multiple: true }, stun: { type: "string", multiple: true }, "ice-config": { type: "string" }, "ice-transport-policy": { type: "string", default: "all" }, "turn-credentials-url": { type: "string" }, "turn-url-projection": { type: "string", default: "issued" }, "account-budget": { type: "boolean", default: false }, telemetry: { type: "boolean", default: false }, help: { type: "boolean" },
  } });
  if (values.help) {
    console.log("npm run broadcast -- [--mediamtx PATH] [--input rtsp://127.0.0.1:8554/live] [--state-dir DIR] [--youtube-url-file FILE] [--public-url https://trial.example] [--host 127.0.0.1] [--port 8787] [--tls-key FILE --tls-cert FILE] [--relay wss://relay.example] [--stun stun:stun.example:3478 | --ice-config FILE | --turn-credentials-url https://issuer.example/turn] [--ice-transport-policy all|relay] [--turn-url-projection issued|tls-tcp] [--account-budget] [--admission-per-address-tickets 12] [--admission-per-address-requests 600] [--telemetry]\nSource must supply video and audio. Publisher identity and operator credentials remain in the private state directory. --account-budget enables an optional Nostr-linked allowance in the private account-budget.json ledger; connecting it never enables uploading. Website account authentication is supplied through startDemoServer's host callback. ICE configuration must be a private POSIX file; browser TURN credentials are disclosed to viewers. See docs/BROADCASTING.md.");
    return;
  }
  if (!["all", "relay"].includes(values["ice-transport-policy"])) throw new Error("Invalid ICE transport policy; use all or relay.");
  validateTurnUrlProjection(values["turn-url-projection"]);
  if (values["turn-url-projection"] !== "issued" && values["turn-credentials-url"] === undefined) throw new Error("TURN URL projection requires --turn-credentials-url.");
  const admissionPerAddressTickets = Number(values["admission-per-address-tickets"]);
  if (!Number.isSafeInteger(admissionPerAddressTickets) || admissionPerAddressTickets < 1 || admissionPerAddressTickets > 120) throw new Error("Admission tickets per address must be an integer from 1 to 120.");
  const admissionPerAddressRequests = Number(values["admission-per-address-requests"]);
  if (!Number.isSafeInteger(admissionPerAddressRequests) || admissionPerAddressRequests < 1 || admissionPerAddressRequests > 10000) throw new Error("Admission requests per address must be an integer from 1 to 10000.");
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || values.stun?.some((url) => !/^stuns?:[^\s]+$/u.test(url))) throw new Error("Invalid broadcaster port or STUN configuration.");
  if ([values.stun, values["ice-config"], values["turn-credentials-url"]].filter(value => value !== undefined).length > 1) throw new Error("Supply only one of --stun, --ice-config or --turn-credentials-url.");
  if (values["turn-credentials-url"] !== undefined) validateTurnCredentialsUrl(values["turn-credentials-url"]);
  const iceServers = values["ice-config"] ? await readIceConfigFile(values["ice-config"]) : values.stun?.map((urls) => ({ urls }));
  await mkdir(resolve(values["state-dir"]), { recursive: true, mode: 0o700 });
  const state = resolve(values["state-dir"]), stateStat = await lstat(state);
  if (!stateStat.isDirectory() || await realpath(state) !== state || (stateStat.mode & 0o022) || (typeof process.getuid === "function" && stateStat.uid !== process.getuid())) throw new Error("Broadcaster state directory must be owner-controlled without symlinks.");
  const tokenFile = join(state, "operator-token");
  await privateFile(tokenFile, true);
  const forwardUrl = values["youtube-url-file"] ? await privateFile(resolve(values["youtube-url-file"]), false) : undefined;
  let router, pipeline, server, waiting, stopping = false, stoppedResolve;
  const stopped = new Promise((done) => { stoppedResolve = done; });
  const stop = async () => {
    if (stopping) return stopped;
    stopping = true;
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => server?.close()), Promise.resolve().then(() => waiting?.close()), Promise.resolve().then(() => pipeline?.close()),
        (async () => {
          if (router && router.exitCode === null && router.signalCode === null) {
            const ended = new Promise((done) => router.once("close", done));
            router.kill("SIGTERM"); const force = setTimeout(() => router.kill("SIGKILL"), 3000);
            try { await ended; } finally { clearTimeout(force); }
          }
        })(),
      ]);
      if (results.some((result) => result.status === "rejected")) process.exitCode = 1;
    } finally { stoppedResolve(); }
  };
  const onSignal = () => { stop().catch(() => { process.exitCode = 1; stoppedResolve(); }); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    if (values.mediamtx) {
      router = spawn(values.mediamtx, [resolve(values["router-config"])], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      router.stderr.on("data", () => {});
      router.once("error", () => { process.exitCode = 1; onSignal(); });
      router.once("close", () => { if (!stopping) { console.error("The ingest router stopped; stopping broadcaster."); process.exitCode = 1; onSignal(); } });
    }
    waiting = await startBroadcastWaitingServer({ host: values.host, port, publicUrl: values["public-url"], tlsKey: values["tls-key"], tlsCert: values["tls-cert"] });
    if (stopping) { await waiting.close(); return; }
    console.log("Broadcaster waiting page: " + waiting.base);
    pipeline = await startBroadcastPipeline({ input: values.input, mediaDir: join(state, "media"), ffmpeg: values.ffmpeg, forwardUrl });
    if (stopping) { await pipeline.close(); return; }
    console.log("Waiting for a broadcast with video and audio. For the bundled local router, set OBS Custom server to rtmp://127.0.0.1:1935/live and leave stream key empty.");
    await pipeline.ready({ timeoutMs: 0 });
    if (stopping) return;
    const playerPort = waiting.port;
    server = await startDemoServer({ mediaDir: pipeline.mediaDir, manifest: pipeline.manifest, publisherState: join(state, "publisher.json"), operatorTokenFile: tokenFile, operatorState: join(state, "operator.json"),
      admissionOptions: { perAddressTickets: admissionPerAddressTickets, perAddressRequests: admissionPerAddressRequests }, iceTransportPolicy: values["ice-transport-policy"],
      host: values.host, port: playerPort, publicUrl: values["public-url"], tlsKey: values["tls-key"], tlsCert: values["tls-cert"], relays: values.relay, telemetry: values.telemetry,
      ...(values["account-budget"] ? { accountBudget: { statePath: join(state, "account-budget.json") } } : {}),
      beforeListen: async () => {
        if (stopping) throw new Error("Broadcaster stopped during player preparation.");
        await waiting.close();
        if (stopping) throw new Error("Broadcaster stopped during listener handoff.");
      },
      operatorExtraStatus: () => pipeline.metrics(), ...(iceServers ? { iceServers } : {}),
      ...(values["turn-credentials-url"] !== undefined ? { turnCredentials: { url: values["turn-credentials-url"], urlProjection: values["turn-url-projection"] } } : {}) });
    if (stopping) { await server.close(); return; }
    console.log(`RelaySwarm broadcaster player: ${server.base}\nOperator token file: ${tokenFile}\nPublisher identity persists across restarts. Press Ctrl-C to stop.`);
    await Promise.race([stopped, pipeline.failure.then((error) => { throw error; })]);
  } catch (error) {
    if (!stopping) throw error;
  } finally { await stop(); process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); }
}

if (await isCliEntry(import.meta.url)) main().catch(() => { console.error("Broadcaster could not start. Check dependencies, private files, input and HTTPS configuration; no upstream credentials are logged."); process.exitCode = 1; });
