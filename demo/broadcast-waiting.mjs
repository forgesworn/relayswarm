import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { readFile } from "node:fs/promises";

const page = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="3"><title>RelaySwarm · waiting for broadcast</title></head>
<body><main><h1>Waiting for the broadcast</h1><p>The player will appear when the broadcast is ready.</p><p>This page checks again automatically.</p></main></body></html>`);

/** Temporary listener while a broadcaster prepares its first playable output. */
export async function startBroadcastWaitingServer({ host = "127.0.0.1", port = 8787, publicUrl, tlsKey, tlsCert } = {}) {
  if (Boolean(tlsKey) !== Boolean(tlsCert)) throw new Error("Supply both TLS key and certificate files.");
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid waiting server port.");
  let publicBase;
  if (publicUrl) {
    try { publicBase = new URL(publicUrl); } catch { throw new Error("Public URL must be an HTTPS origin."); }
    if (publicBase.protocol !== "https:" || publicBase.pathname !== "/" || publicBase.search || publicBase.hash || publicBase.username || publicBase.password) throw new Error("Public URL must be an HTTPS origin without credentials or a path.");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(host) && !tlsKey && !publicBase) throw new Error("Remote browsers require HTTPS or an HTTPS proxy origin.");
  const handler = (request, response) => {
    response.setHeader("content-security-policy", "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("cache-control", "no-store");
    let path;
    try { path = new URL(request.url, "http://waiting.invalid").pathname; } catch { response.writeHead(400).end(); return; }
    if (path === "/") {
      if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { allow: "GET, HEAD" }).end(); return; }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": page.length });
      response.end(request.method === "HEAD" ? undefined : page); return;
    }
    const body = '{"error":"Broadcast not ready."}';
    response.writeHead(503, { "content-type": "application/json", "retry-after": "3", "content-length": Buffer.byteLength(body) });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  const server = tlsKey ? httpsServer({ key: await readFile(tlsKey), cert: await readFile(tlsCert), maxHeaderSize: 8192 }, handler) : httpServer({ maxHeaderSize: 8192 }, handler);
  server.maxConnections = 128;
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 1000;
  await new Promise((done, reject) => {
    const failed = (error) => { server.off("listening", listening); reject(error); };
    const listening = () => { server.off("error", failed); done(); };
    server.once("error", failed); server.once("listening", listening); server.listen(port, host);
  });
  const boundPort = server.address().port;
  const localHost = host === "127.0.0.1" || host === "0.0.0.0" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  let closing;
  return { base: publicBase?.origin || `${tlsKey ? "https" : "http"}://${localHost}:${boundPort}`, port: boundPort,
    close() {
      if (!closing) closing = new Promise((done, reject) => {
        server.close((error) => error ? reject(error) : done());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
