#!/usr/bin/env node
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFile, open } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { createHlsPublisher, PublisherError } from "../src/hls-publisher.mjs";
import { createBlockingPlaylistReload, sendPlaylistResponse } from "./blocking-playlist-reload.mjs";
import { createOperatorControls, readOperatorTokenFile } from "./operator.mjs";
import { createAdmissionControls } from "./admission.mjs";
import { loadPublisherState } from "../src/publisher-state.mjs";
import { attachDemoRelay } from "./relay.mjs";
import { createMediaFixture } from "./media-fixture.mjs";
import { RelayPool } from "../src/relay-session.mjs";
import { readIceConfigFile } from "../src/ice-config.mjs";
import { createAccountBudgetControls } from "./account-budget.mjs";
import { createRequestDiagnostics } from "./request-diagnostics.mjs";
import { isCliEntry } from "../src/cli-entry.mjs";
import { createTurnCredentialService, validateTurnCredentialsUrl, validateTurnUrlProjection } from "./turn-credential-service.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function sendBufferedResponse(request, response, status, type, body) {
  const bytes = Buffer.isBuffer(body) ? body : typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  response.writeHead(status, { "content-type": type, "content-length": bytes.length });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

export function httpRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
  if (!match) throw new PublisherError("Unsupported byte range.", 416);
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new PublisherError("Unsatisfiable byte range.", 416);
  return { start, end: Math.min(end, size - 1) };
}

export async function startDemoServer({ mediaDir, manifest = "master.m3u8", host = "127.0.0.1", port = 0, publicUrl, tlsKey, tlsCert, relays = [], iceServers, iceTransportPolicy = "all",
  publisherState, operatorToken, operatorTokenFile, operatorState, telemetry = false, reportCapacity, reportTtlMs, operatorExtraStatus, beforeListen,
  admissionOptions, accountBudget, turnCredentials, blockingPlaylistReload = true, mediaCapabilities = { parts: false }, allowEncryptedMedia = false, commitmentSecretKey, delegation, revokedDelegationIds = [], delegationRevocations = [] } = {}) {
  if (!["all", "relay"].includes(iceTransportPolicy)) throw new Error("Invalid ICE transport policy; use all or relay.");
  if (typeof blockingPlaylistReload !== "boolean") throw new Error("Invalid blocking playlist policy.");
  if (turnCredentials !== undefined) {
    if (!turnCredentials || typeof turnCredentials !== "object" || Array.isArray(turnCredentials) || iceServers !== undefined) throw new Error("Supply either static ICE servers or a TURN credential issuer.");
    validateTurnUrlProjection(turnCredentials.urlProjection);
    validateTurnCredentialsUrl(turnCredentials.url);
  }
  if (beforeListen !== undefined && typeof beforeListen !== "function") throw new Error("beforeListen must be a function.");
  if (!mediaCapabilities || typeof mediaCapabilities.parts !== "boolean" || Object.keys(mediaCapabilities).some((key) => key !== "parts")) throw new Error("Invalid media capabilities.");
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error("Supply both --tls-key and --tls-cert.");
  const publicBase = publicUrl ? new URL(publicUrl) : null;
  if (publicBase && (publicBase.protocol !== "https:" || publicBase.pathname !== "/" || publicBase.search || publicBase.hash || publicBase.username || publicBase.password)) throw new Error("--public-url must be an HTTPS origin, without credentials or a path.");
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !tlsKey && !publicBase) throw new Error("Remote browsers require HTTPS: configure TLS or --public-url behind an HTTPS proxy.");
  if (relays.length > 8 || relays.some((value) => { try { const url = new URL(value); return url.protocol !== "wss:" || Boolean(url.username || url.password); } catch { return true; } })) throw new Error("External relays must be 1-8 credential-free wss URLs.");
  if (operatorToken && operatorTokenFile) throw new Error("Supply only one operator token source.");
  const token = operatorTokenFile ? await readOperatorTokenFile(operatorTokenFile) : operatorToken;
  const state = publisherState ? await loadPublisherState(publisherState, { manifest }) : {};
  const publisher = await createHlsPublisher({ mediaDir, manifest, ...state, allowEncryptedMedia, commitmentSecretKey, delegation, revokedDelegationIds, delegationRevocations });
  const playlistReload = createBlockingPlaylistReload({ publisher, enabled: blockingPlaylistReload });
  const [page, css, bundle] = await Promise.all([
    readFile(join(here, "index.html")), readFile(join(here, "style.css")),
    build({ entryPoints: [join(here, "client.mjs")], bundle: true, format: "esm", platform: "browser", write: false, minify: true, logLevel: "silent" }),
  ]);
  const admission = createAdmissionControls({ ...admissionOptions, swarmId: publisher.swarmId });
  const controls = createOperatorControls({ token, telemetry, reportCapacity, reportTtlMs, operatorExtraStatus, statePath: operatorState, admission,
    requestDiagnostics: () => requestDiagnostics.snapshot() });
  let requestDiagnostics, accountControls, turnControls;
  let base, activeMedia = 0;
  const signingBudget = { count: 0, since: Date.now() };
  const handler = async (request, response) => {
    const requestStartedAt = performance.now();
    requestDiagnostics.observe(request, response);
    const connect = ["'self'", ...relays.map((value) => new URL(value).origin), base?.replace(/^http/u, "ws")].filter(Boolean).join(" ");
    response.setHeader("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");
    try {
      const url = new URL(request.url, "http://localhost");
      if (turnControls && await turnControls.handle(request, response, url.pathname, base)) return;
      if (accountControls && await accountControls.handle(request, response, url.pathname, base)) return;
      if (await controls.handle(request, response, url.pathname, base, publisher)) return;
      if (await admission.handle(request, response, url.pathname, base)) return;
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
      const category = url.pathname === "/commitment" ? "commitment" : url.pathname.startsWith("/media/") ? "media" : null;
      if (category) {
        controls.origin[`${category}Requests`]++;
        const write = response.write.bind(response), end = response.end.bind(response);
        const count = (chunk, encoding) => { if (chunk && request.method !== "HEAD") controls.origin[`${category}ResponseBytes`] += Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? chunk.length : Buffer.byteLength(chunk, typeof encoding === "string" ? encoding : undefined); };
        response.write = (chunk, encoding, callback) => { count(chunk, encoding); return write(chunk, encoding, callback); };
        response.end = (chunk, encoding, callback) => { count(chunk, encoding); return end(chunk, encoding, callback); };
      }
      const send = (type, body) => sendBufferedResponse(request, response, 200, type, body);
      if (url.pathname === "/") return send("text/html; charset=utf-8", page);
      if (url.pathname === "/style.css") return send("text/css; charset=utf-8", css);
      if (url.pathname === "/client.js") return send("text/javascript; charset=utf-8", bundle.outputFiles[0].contents);
      if (url.pathname === "/stream.json") return send("application/json", JSON.stringify(advertisement));
      if (url.pathname === "/session.json") return send("application/json", JSON.stringify({ v: 1, swarmId: publisher.swarmId, streamEvent: publisher.streamEvent,
        manifest: publisher.manifestPath, relays: relays.length ? relays : [`${base.replace(/^http/u, "ws")}/relay`],
        iceTransportPolicy, ...(iceServers ? { iceServers } : {}), ...(turnControls ? { turnCredentials: turnControls.descriptor() } : {}), ...(accountControls ? { accountBudget: accountControls.descriptor() } : {}), ...(publisher.delegation ? { delegation: publisher.delegation } : {}),
        ...(revokedDelegationIds.length ? { revokedDelegationIds } : {}), ...(delegationRevocations.length ? { delegationRevocations } : {}),
        admission: admission.descriptor(), mediaCapabilities: { ...mediaCapabilities }, streamAdvertisementEndpoint: "/stream.json", commitmentEndpoint: "/commitment", deliveryPolicyEndpoint: "/delivery-policy.json", experimental: true }));
      if (url.pathname === "/commitment") {
        if (Date.now() - signingBudget.since >= 10000) { signingBudget.count = 0; signingBudget.since = Date.now(); }
        if (++signingBudget.count > 240) throw new PublisherError("Commitment request budget exceeded.", 429);
        const event = await publisher.commitment({ path: url.searchParams.get("path"), level: url.searchParams.get("level"), sequence: url.searchParams.get("sequence"),
          discontinuity: url.searchParams.get("cc"), rangeStart: url.searchParams.get("start"), rangeEnd: url.searchParams.get("end"), part: url.searchParams.get("part"),
          playlist: url.searchParams.get("playlist"), mediaType: url.searchParams.get("mediaType") ?? "main" });
        return send("application/json", JSON.stringify(event));
      }
      if (!url.pathname.startsWith("/media/")) { response.writeHead(404).end(); return; }
      if (activeMedia >= 32) throw new PublisherError("Media request limit reached.", 503);
      activeMedia++;
      let handle, stream;
      const cancellation = new AbortController();
      const cancel = () => cancellation.abort();
      response.once("close", cancel);
      request.once("aborted", cancel);
      try {
        if (extname(url.pathname) === ".m3u8") {
          const bytes = await playlistReload.read(url.pathname, url.searchParams, { signal: cancellation.signal, startedAt: requestStartedAt });
          if (response.destroyed || request.aborted) return;
          let range;
          try { range = httpRange(request.headers.range, bytes.length); }
          catch (error) { response.setHeader("content-range", `bytes */${bytes.length}`); throw error; }
          await sendPlaylistResponse(response, bytes, { range, head: request.method === "HEAD", signal: cancellation.signal });
          return;
        }
        const path = await publisher.media(url.pathname);
        if (response.destroyed || request.aborted) return;
        handle = await open(path, "r");
        if (response.destroyed || request.aborted) return;
        const stat = await handle.stat();
        if (response.destroyed || request.aborted) return;
        if (!stat.isFile()) throw new PublisherError("Unknown media.", 404);
        let range;
        try { range = httpRange(request.headers.range, stat.size); }
        catch (error) { response.setHeader("content-range", `bytes */${stat.size}`); throw error; }
        const start = range?.start ?? 0, end = range?.end ?? stat.size - 1;
        const types = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4", ".m4s": "video/mp4" };
        response.writeHead(range ? 206 : 200, { "content-type": types[extname(url.pathname)] || "application/octet-stream", "content-length": end - start + 1,
          "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${stat.size}` } : {}) });
        if (request.method === "HEAD") { response.end(); return; }
        stream = handle.createReadStream({ start, end });
        await pipeline(stream, response, { signal: cancellation.signal });
      } catch (error) {
        if (!cancellation.signal.aborted && !response.destroyed && !request.aborted) throw error;
      } finally {
        response.off("close", cancel);
        request.off("aborted", cancel);
        stream?.destroy();
        try { await handle?.close(); } finally { activeMedia--; }
      }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof PublisherError ? error.status : error.code === "ENOENT" ? 404 : 500;
      sendBufferedResponse(request, response, status, "application/json", JSON.stringify({ error: status === 500 ? "Publisher unavailable." : error instanceof PublisherError ? error.message : "Unknown media." }));
    }
  };
  let server, relay, advertisement, renewal, closing, advertisementPool;
  try {
    if (turnCredentials !== undefined) turnControls = createTurnCredentialService(turnCredentials);
    if (accountBudget !== undefined) accountControls = createAccountBudgetControls(accountBudget);
    await accountControls?.ready();
    server = tlsKey ? httpsServer({ key: await readFile(tlsKey), cert: await readFile(tlsCert), maxHeaderSize: 8192 }, handler) : httpServer({ maxHeaderSize: 8192 }, handler);
    server.maxConnections = 128;
    server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
    relay = relays.length ? null : attachDemoRelay(server, { swarmId: publisher.swarmId, origin: () => base, publisherEvent: publisher.streamEvent, admit: admission.verify });
    requestDiagnostics = createRequestDiagnostics();
    const startedAt = Math.floor(Date.now() / 1000);
    function advertise(status = "live") {
      const relayUrls = relays.length ? relays : [`${base.replace(/^http/u, "ws")}/relay`];
      advertisement = publisher.advertisement({ manifestUrl: new URL(publisher.manifestPath, base).href, relays: relayUrls, status,
        starts: startedAt, previousEvent: advertisement, allowLoopback: !publicBase && !tlsKey });
      relay?.publishStreamEvent(advertisement);
      advertisementPool?.publish(advertisement);
    }
    await controls.ready();
    await beforeListen?.();
    await new Promise((done, reject) => { server.once("error", reject); server.listen(port, host, done); });
    const localHost = host === "127.0.0.1" ? "localhost" : host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "localhost" : host;
    base = publicBase?.origin || `${tlsKey ? "https" : "http"}://${localHost}:${server.address().port}`;
    relay?.publishStreamEvent(publisher.streamEvent);
    advertise();
    if (relays.length) {
      advertisementPool = new RelayPool(relays, { connectTimeoutMs: 5000, reconnect: true });
      advertisementPool.connect().then(() => { if (!closing) { advertisementPool.publish(publisher.streamEvent); advertisementPool.publish(advertisement); } }).catch(() => {});
    }
    renewal = setInterval(() => { try { advertise(); } catch { /* HTTP remains available if advertisement refresh fails. */ } }, 60000); renewal.unref();
    return { base, publisher, relay, admission, playlistReloadMetrics: () => playlistReload.snapshot(), advertisement: () => structuredClone(advertisement), close() {
      if (closing) return closing;
      closing = (async () => {
        clearInterval(renewal); try { advertise("ended"); } catch {}
        const failures = [];
        for (const cleanup of [() => playlistReload.close(), () => advertisementPool?.close(), () => relay?.close(), () => turnControls?.close(), () => accountControls?.close(),
          () => server.closeAllConnections(), () => new Promise((done, reject) => server.close((error) => error ? reject(error) : done())),
          () => controls.close(), () => requestDiagnostics.close()]) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw failures[0];
      })();
      return closing;
    } };
  } catch (error) {
    clearInterval(renewal); requestDiagnostics?.close(); advertisementPool?.close();
    await Promise.allSettled([Promise.resolve().then(() => playlistReload.close()), Promise.resolve().then(() => relay?.close()), Promise.resolve().then(() => server?.close()), Promise.resolve().then(() => controls.close()), Promise.resolve().then(() => accountControls?.close()), Promise.resolve().then(() => turnControls?.close())]);
    throw error;
  }
}

async function main() {
  const { values } = parseArgs({ options: { "media-dir": { type: "string" }, manifest: { type: "string", default: "master.m3u8" }, host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8787" },
    "public-url": { type: "string" }, "tls-key": { type: "string" }, "tls-cert": { type: "string" }, relay: { type: "string", multiple: true }, stun: { type: "string", multiple: true }, "ice-config": { type: "string" }, "ice-transport-policy": { type: "string", default: "all" }, "turn-credentials-url": { type: "string" }, "turn-url-projection": { type: "string", default: "issued" }, "publisher-state": { type: "string" }, "operator-token-file": { type: "string" }, "operator-state": { type: "string" }, "account-budget-state": { type: "string" }, "allow-encrypted-media": { type: "boolean", default: false }, telemetry: { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) { console.log("npm run demo -- [--media-dir DIR --manifest master.m3u8] [--host 127.0.0.1 --port 8787] [--public-url https://demo.example] [--tls-key FILE --tls-cert FILE] [--relay wss://relay.example] [--stun stun:stun.example:3478 | --ice-config FILE | --turn-credentials-url https://issuer.example/turn] [--ice-transport-policy all|relay] [--turn-url-projection issued|tls-tcp] [--publisher-state FILE] [--operator-token-file FILE] [--account-budget-state FILE] [--telemetry]\nWithout --media-dir, ffmpeg generates a two-rendition live test stream. ICE configuration must be a private POSIX file; browser TURN credentials are disclosed to viewers. See docs/FIELD-TEST.md."); return; }
  if (!["all", "relay"].includes(values["ice-transport-policy"])) throw new Error("Invalid ICE transport policy; use all or relay.");
  validateTurnUrlProjection(values["turn-url-projection"]);
  if (values["turn-url-projection"] !== "issued" && values["turn-credentials-url"] === undefined) throw new Error("TURN URL projection requires --turn-credentials-url.");
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
  if (values.stun?.some((url) => !/^stuns?:[^\s]+$/u.test(url))) throw new Error("--stun requires a STUN URL.");
  if ([values.stun, values["ice-config"], values["turn-credentials-url"]].filter(value => value !== undefined).length > 1) throw new Error("Supply only one of --stun, --ice-config or --turn-credentials-url.");
  if (values["turn-credentials-url"] !== undefined) validateTurnCredentialsUrl(values["turn-credentials-url"]);
  const iceServers = values["ice-config"] ? await readIceConfigFile(values["ice-config"]) : values.stun?.map((urls) => ({ urls }));
  const fixture = values["media-dir"] ? null : await createMediaFixture({ live: true });
  let demo;
  const close = async () => {
    const results = await Promise.allSettled([Promise.resolve().then(() => demo?.close()), Promise.resolve().then(() => fixture?.close())]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  };
  try {
    demo = await startDemoServer({ mediaDir: values["media-dir"] || fixture.directory, manifest: values.manifest, host: values.host, port,
      publisherState: values["publisher-state"], operatorTokenFile: values["operator-token-file"], operatorToken: values["operator-token-file"] ? undefined : process.env.RELAYSWARM_OPERATOR_TOKEN, telemetry: values.telemetry,
      operatorState: values["operator-state"], ...(values["account-budget-state"] ? { accountBudget: { statePath: values["account-budget-state"] } } : {}), allowEncryptedMedia: values["allow-encrypted-media"],
      iceTransportPolicy: values["ice-transport-policy"], publicUrl: values["public-url"], tlsKey: values["tls-key"], tlsCert: values["tls-cert"], relays: values.relay,
      ...(iceServers ? { iceServers } : {}), ...(values["turn-credentials-url"] !== undefined ? { turnCredentials: { url: values["turn-credentials-url"], urlProjection: values["turn-url-projection"] } } : {}) });
    console.log(`RelaySwarm field-test player: ${demo.base}\n${values["publisher-state"] ? "Publisher identity is restored from the private server state file." : "Publisher key is ephemeral and stays on this server."} Press Ctrl-C to stop.`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await close(); };
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop().catch((error) => { console.error(error.message); process.exitCode = 1; }));
  } catch (error) { await close().catch(() => {}); throw error; }
}

if (await isCliEntry(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
