#!/usr/bin/env node
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFile, open } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { createHlsPublisher, PublisherError } from "../src/hls-publisher.mjs";
import { attachDemoRelay } from "./relay.mjs";
import { createMediaFixture } from "./media-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));

export function httpRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
  if (!match) throw new PublisherError("Unsupported byte range.", 416);
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) throw new PublisherError("Unsatisfiable byte range.", 416);
  return { start, end: Math.min(end, size - 1) };
}

export async function startDemoServer({ mediaDir, manifest = "master.m3u8", host = "127.0.0.1", port = 0, publicUrl, tlsKey, tlsCert, relays = [], iceServers } = {}) {
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error("Supply both --tls-key and --tls-cert.");
  const publicBase = publicUrl ? new URL(publicUrl) : null;
  if (publicBase && (publicBase.protocol !== "https:" || publicBase.pathname !== "/" || publicBase.search || publicBase.hash || publicBase.username || publicBase.password)) throw new Error("--public-url must be an HTTPS origin, without credentials or a path.");
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !tlsKey && !publicBase) throw new Error("Remote browsers require HTTPS: configure TLS or --public-url behind an HTTPS proxy.");
  if (relays.length > 8 || relays.some((value) => { try { const url = new URL(value); return url.protocol !== "wss:" || Boolean(url.username || url.password); } catch { return true; } })) throw new Error("External relays must be 1-8 credential-free wss URLs.");
  const publisher = await createHlsPublisher({ mediaDir, manifest });
  const [page, css, bundle] = await Promise.all([
    readFile(join(here, "index.html")), readFile(join(here, "style.css")),
    build({ entryPoints: [join(here, "client.mjs")], bundle: true, format: "esm", platform: "browser", write: false, minify: true, logLevel: "silent" }),
  ]);
  let base, activeMedia = 0;
  const signingBudget = { count: 0, since: Date.now() };
  const handler = async (request, response) => {
    const connect = ["'self'", ...relays.map((value) => new URL(value).origin), base?.replace(/^http/u, "ws")].filter(Boolean).join(" ");
    response.setHeader("content-security-policy", `default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src ${connect}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`);
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
    try {
      const url = new URL(request.url, "http://localhost");
      const send = (type, body) => { response.writeHead(200, { "content-type": type }); response.end(request.method === "HEAD" ? undefined : body); };
      if (url.pathname === "/") return send("text/html; charset=utf-8", page);
      if (url.pathname === "/style.css") return send("text/css; charset=utf-8", css);
      if (url.pathname === "/client.js") return send("text/javascript; charset=utf-8", bundle.outputFiles[0].contents);
      if (url.pathname === "/session.json") return send("application/json", JSON.stringify({ v: 1, swarmId: publisher.swarmId, streamEvent: publisher.streamEvent,
        manifest: publisher.manifestPath, relays: relays.length ? relays : [`${base.replace(/^http/u, "ws")}/relay`],
        ...(iceServers ? { iceServers } : {}), commitmentEndpoint: "/commitment", experimental: true }));
      if (url.pathname === "/commitment") {
        if (Date.now() - signingBudget.since >= 10000) { signingBudget.count = 0; signingBudget.since = Date.now(); }
        if (++signingBudget.count > 240) throw new PublisherError("Commitment request budget exceeded.", 429);
        const event = await publisher.commitment({ path: url.searchParams.get("path"), level: url.searchParams.get("level"), sequence: url.searchParams.get("sequence"),
          discontinuity: url.searchParams.get("cc"), rangeStart: url.searchParams.get("start"), rangeEnd: url.searchParams.get("end"), part: url.searchParams.get("part") });
        return send("application/json", JSON.stringify(event));
      }
      if (!url.pathname.startsWith("/media/")) { response.writeHead(404).end(); return; }
      if (activeMedia >= 32) throw new PublisherError("Media request limit reached.", 503);
      activeMedia++;
      let handle;
      try {
        handle = await open(await publisher.media(url.pathname), "r");
        const stat = await handle.stat();
        if (!stat.isFile()) throw new PublisherError("Unknown media.", 404);
        let range;
        try { range = httpRange(request.headers.range, stat.size); }
        catch (error) { response.setHeader("content-range", `bytes */${stat.size}`); throw error; }
        const start = range?.start ?? 0, end = range?.end ?? stat.size - 1;
        const types = { ".m3u8": "application/vnd.apple.mpegurl", ".ts": "video/mp2t", ".mp4": "video/mp4", ".m4s": "video/mp4" };
        response.writeHead(range ? 206 : 200, { "content-type": types[extname(url.pathname)] || "application/octet-stream", "content-length": end - start + 1,
          "accept-ranges": "bytes", ...(range ? { "content-range": `bytes ${start}-${end}/${stat.size}` } : {}) });
        if (request.method === "HEAD") { response.end(); await handle.close(); activeMedia--; return; }
        const stream = handle.createReadStream({ start, end });
        stream.once("error", (error) => response.destroy(error));
        response.once("close", () => stream.destroy());
        stream.once("close", () => { activeMedia--; });
        stream.pipe(response);
      } catch (error) { await handle?.close(); activeMedia--; throw error; }
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      const status = error instanceof PublisherError ? error.status : error.code === "ENOENT" ? 404 : 500;
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: status === 500 ? "Publisher unavailable." : error instanceof PublisherError ? error.message : "Unknown media." }));
    }
  };
  const server = tlsKey ? httpsServer({ key: await readFile(tlsKey), cert: await readFile(tlsCert), maxHeaderSize: 8192 }, handler) : httpServer({ maxHeaderSize: 8192 }, handler);
  server.maxConnections = 128;
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  const relay = relays.length ? null : attachDemoRelay(server, { swarmId: publisher.swarmId, origin: () => base });
  try {
    await new Promise((done, reject) => { server.once("error", reject); server.listen(port, host, done); });
    const localHost = host === "127.0.0.1" ? "localhost" : host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "localhost" : host;
    base = publicBase?.origin || `${tlsKey ? "https" : "http"}://${localHost}:${server.address().port}`;
    return { base, publisher, relay, async close() { await relay?.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
  } catch (error) { await relay?.close(); server.close(); throw error; }
}

async function main() {
  const { values } = parseArgs({ options: { "media-dir": { type: "string" }, manifest: { type: "string", default: "master.m3u8" }, host: { type: "string", default: "127.0.0.1" }, port: { type: "string", default: "8787" },
    "public-url": { type: "string" }, "tls-key": { type: "string" }, "tls-cert": { type: "string" }, relay: { type: "string", multiple: true }, stun: { type: "string", multiple: true }, help: { type: "boolean" } } });
  if (values.help) { console.log("npm run demo -- [--media-dir DIR --manifest master.m3u8] [--host 127.0.0.1 --port 8787] [--public-url https://demo.example] [--tls-key FILE --tls-cert FILE] [--relay wss://relay.example] [--stun stun:stun.example:3478]\nWithout --media-dir, ffmpeg generates a two-rendition live test stream. See docs/FIELD-TEST.md."); return; }
  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port.");
  if (values.stun?.some((url) => !/^stuns?:[^\s]+$/u.test(url))) throw new Error("--stun requires a STUN URL.");
  const fixture = values["media-dir"] ? null : await createMediaFixture({ live: true });
  let demo;
  try {
    demo = await startDemoServer({ mediaDir: values["media-dir"] || fixture.directory, manifest: values.manifest, host: values.host, port,
      publicUrl: values["public-url"], tlsKey: values["tls-key"], tlsCert: values["tls-cert"], relays: values.relay,
      ...(values.stun ? { iceServers: values.stun.map((urls) => ({ urls })) } : {}) });
    console.log(`RelaySwarm field-test player: ${demo.base}\nPublisher key is ephemeral and stays on this server. Press Ctrl-C to stop.`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await demo.close(); await fixture?.close(); };
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => stop().catch((error) => { console.error(error.message); process.exitCode = 1; }));
  } catch (error) { await demo?.close(); await fixture?.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
