// Serve a test-only observed build on the same owned HTTP server. No browser
// routing/cache override; production source files and all other routes unchanged.
import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { startDemoServer } from "../../demo/server.mjs";
export function observedFmp4Client(original) {
  const marker = "      initialLoader = hls.config.fLoader;", videoMarker = 'const video = document.querySelector("video");';
  assert.equal(original.split(marker).length, 2, "The exact test observation seam must be unique");
  assert.equal(original.split(videoMarker).length, 2, "The exact video observation seam must be unique");
  return 'import { installFmp4StartupObserver } from "../test/support/fmp4-startup-observer.mjs";\n' +
    original.replace(videoMarker, videoMarker + '\nconst startupObserver = installFmp4StartupObserver(() => hls, video, byId("quality"));').replace(marker, marker + '\n      startupObserver.attach(hls, Hls.Events);') +
    '\nObject.defineProperty(window, "relaySwarmFmp4Startup", { value: () => startupObserver.snapshot() });\n';
}
export async function startObservedFmp4Demo(options) {
  const path = fileURLToPath(new URL("../../demo/client.mjs", import.meta.url));
  const original = await readFile(path, "utf8"), contents = observedFmp4Client(original);
  const built = await build({ stdin: { contents, resolveDir: dirname(path), sourcefile: path }, bundle: true, format: "esm", platform: "browser", write: false, minify: true, logLevel: "silent" });
  const bytes = built.outputFiles[0].contents;
  let server, demo; const create = http.createServer;
  try {
    http.createServer = (...args) => { assert.equal(server, undefined); server = create(...args); return server; }; syncBuiltinESMExports();
    demo = await startDemoServer(options);
  } finally { http.createServer = create; syncBuiltinESMExports(); }
  try {
    assert.equal(server.address().port, Number(new URL(demo.base).port));
    const handlers = server.listeners("request"); assert.equal(handlers.length, 1); server.removeListener("request", handlers[0]);
    server.on("request", (req, res) => {
      if (new URL(req.url, demo.base).pathname === "/client.js") {
        const end = res.end; res.end = function (_body, ...rest) { return end.call(this, req.method === "HEAD" ? undefined : bytes, ...rest); };
      }
      handlers[0](req, res);
    });
    return { ...demo, observation: { productionClientSHA256: createHash("sha256").update(original).digest("hex"), observedClientSHA256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, insertion: "one passive listener attachment after Hls construction plus private test snapshot accessor", productionSourceEdited: false } };
  } catch (error) { await demo?.close(); throw error; }
}
