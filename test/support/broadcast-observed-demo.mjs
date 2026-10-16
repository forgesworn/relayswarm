// Test-only build; no build/server is started on import.
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { startDemoServer } from "../../demo/server.mjs";
import { transform } from "./broadcast-availability-transform.mjs";

export async function buildObservedBundle(beforeAction = () => {}) {
  beforeAction();
  const clientPath = fileURLToPath(new URL("../../demo/client.mjs", import.meta.url));
  const paths = new Map([[resolve(dirname(clientPath), "../src/browser/hls-swarm.mjs"), "swarm"], [resolve(dirname(clientPath), "../src/browser/peer-link.mjs"), "peer"]]);
  const hits = { client: 0, swarm: 0, peer: 0 }, pins = {};
  function observed(kind, original) {
    assert.equal(hits[kind]++, 0); const changed = transform(kind, original);
    assert.equal(changed.undo(changed.source), original);
    pins[kind] = createHash("sha256").update(original).digest("hex");
    return changed.source;
  }
  const client = observed("client", await readFile(clientPath, "utf8"));
  const bundle = await build({ stdin: { contents: client, resolveDir: dirname(clientPath), sourcefile: clientPath }, bundle: true, format: "esm", platform: "browser", write: false, minify: true, logLevel: "silent",
    plugins: [{ name: "pinned-availability-observation", setup(builder) {
      builder.onResolve({ filter: /^relayswarm-test-availability-observer$/ }, () => ({ path: "collector", namespace: "test-availability" }));
      builder.onLoad({ filter: /.*/, namespace: "test-availability" }, async () => ({ contents: await readFile(new URL("./broadcast-availability-observer.mjs", import.meta.url), "utf8"), loader: "js" }));
      builder.onLoad({ filter: /(?:hls-swarm|peer-link)\.mjs$/, namespace: "file" }, async args => {
        const kind = paths.get(args.path); assert.ok(kind, "Only exact owned modules may be transformed");
        return { contents: observed(kind, await readFile(args.path, "utf8")), resolveDir: dirname(args.path), loader: "js" };
      });
    } }],
  });
  assert.deepEqual(hits, { client: 1, swarm: 1, peer: 1 }); beforeAction();
  const bytes = bundle.outputFiles[0].contents;
  return { bytes, observation: { sourcePins: pins, transformedModules: hits, observedBytes: bytes.byteLength, observedSHA256: createHash("sha256").update(bytes).digest("hex"), diagnosticOnly: true, injectedTestBundle: true, ordinaryQualificationEvidence: false } };
}
export async function startObservedDemo(options, beforeAction = () => {}) {
  const { bytes, observation } = await buildObservedBundle(beforeAction);
  beforeAction();
  let server, demo; const create = http.createServer;
  try {
    http.createServer = (...args) => { assert.equal(server, undefined); beforeAction(); server = create(...args); return server; }; syncBuiltinESMExports();
    demo = await startDemoServer({ ...options, beforeListen: beforeAction });
  } finally { http.createServer = create; syncBuiltinESMExports(); }
  try {
    assert.equal(server.address().port, Number(new URL(demo.base).port));
    const handlers = server.listeners("request"); assert.equal(handlers.length, 1); server.removeListener("request", handlers[0]);
    server.on("request", (req, res) => {
      if (new URL(req.url, demo.base).pathname === "/client.js") {
        const end = res.end, writeHead = res.writeHead;
        // The observed bundle has its own length; preserve all other server headers.
        res.writeHead = function (status, headers) { return writeHead.call(this, status, status === 200 ? { ...headers, "content-length": bytes.byteLength } : headers); };
        res.end = function (body, ...rest) { return end.call(this, this.statusCode === 200 ? req.method === "HEAD" ? undefined : bytes : body, ...rest); };
      }
      handlers[0](req, res);
    });
    return { ...demo, observation };
  } catch (error) { await demo?.close(); throw error; }
}
