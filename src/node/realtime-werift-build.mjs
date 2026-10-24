// Opt-in build-time correction of one reviewed upstream revision. Installed
// packages are never changed. Unknown source or build policy is refused.
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { builtinModules } from "node:module";

export const weriftRealtimeRevision = Object.freeze({
  upstream: "werift", version: "0.24.4", patch: "relayswarm-realtime-1",
  files: Object.freeze({
    "package.json": "a196305ac3e2a89431eba1cf53e56248ff01633252bbb932b5141b600f69f65f",
    "lib/index.mjs": "fa8f4b515bb99d5a3d20f96c9e14643fa8aa8fe4ccc9c2fef48eade5425f1421",
  }),
});

// Upstream npm omits its licence file. Preserve the repository's MIT notice
// explicitly in every corrected bundle, alongside retained dependency notices.
// https://github.com/shinyoshiaki/werift-webrtc/blob/develop/LICENSE
const NOTICE = `/*!
werift 0.24.4; RelaySwarm build-time realtime corrections, revision 1.
MIT License

Copyright (c) 2020 shinyoshiaki

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/`;
const invalid = () => new Error("Unsupported werift realtime source revision or build policy.");
function replaceOnce(source, before, after) {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0) throw invalid();
  return source.slice(0, at) + after + source.slice(at + before.length);
}
function corrected(source) {
  let output = replaceOnce(source, "channelType = 1;\n      reliability = channel.maxRetransmits;", "channelType |= 1;\n      reliability = channel.maxRetransmits;");
  output = replaceOnce(output, "channelType = 2;\n      reliability = channel.maxPacketLifeTime;", "channelType |= 2;\n      reliability = channel.maxPacketLifeTime;");
  output = replaceOnce(output, "const [channel, protocol, userData] = this.dataChannelQueue.shift();", "const [channel, protocol, userData, queuedExpiry] = this.dataChannelQueue.shift();\n      if (queuedExpiry !== void 0 && queuedExpiry <= performance.now() / 1e3) {\n        channel.addBufferedAmount(-userData.length);\n        continue;\n      }");
  output = replaceOnce(output, "const expiry = channel.maxPacketLifeTime !== null ? Date.now() + channel.maxPacketLifeTime / 1e3 : void 0;", "const expiry = queuedExpiry;");
  output = replaceOnce(output, "channel.addBufferedAmount(size);\n    this.dataChannelQueue.push(", "channel.addBufferedAmount(size);\n    const queuedExpiry = channel.maxPacketLifeTime !== null ? performance.now() / 1e3 + channel.maxPacketLifeTime / 1e3 : void 0;\n    this.dataChannelQueue.push(");
  output = replaceOnce(output, 'typeof data === "string" ? [channel, WEBRTC_STRING, userData] : [channel, WEBRTC_BINARY, userData]', 'typeof data === "string" ? [channel, WEBRTC_STRING, userData, queuedExpiry] : [channel, WEBRTC_BINARY, userData, queuedExpiry]');
  const old = `  maybeAbandon(chunk) {
    if (chunk.abandoned) return true;
    const abandon = !!chunk.maxRetransmits && chunk.maxRetransmits < chunk.sentCount || !!chunk.expiry && chunk.expiry < Date.now() / 1e3;
    if (!abandon) return false;
    const chunkPos = this.sentQueue.findIndex((v) => v.type === chunk.type);
    for (let pos = chunkPos; pos >= 0; pos--) {
      const oChunk = this.sentQueue[pos];
      oChunk.abandoned = true;
      oChunk.retransmit = false;
      if (oChunk.flags & SCTP_DATA_LAST_FRAG) {
        break;
      }
    }
    for (let pos = chunkPos; pos < this.sentQueue.length; pos++) {
      const oChunk = this.sentQueue[pos];
      oChunk.abandoned = true;
      oChunk.retransmit = false;
      if (oChunk.flags & SCTP_DATA_LAST_FRAG) {
        break;
      }
    }
    return true;
  }`;
  output = replaceOnce(output, old, `  maybeAbandon(chunk) {
    if (chunk.abandoned) return true;
    const abandon = chunk.maxRetransmits !== void 0 && chunk.maxRetransmits < chunk.sentCount || chunk.expiry !== void 0 && chunk.expiry <= performance.now() / 1e3;
    if (!abandon) return false;
    const active = [...this.sentQueue, ...this.outboundQueue];
    const at = active.indexOf(chunk);
    if (at < 0) return false;
    let first = at, last = at;
    while (first > 0 && !(active[first].flags & SCTP_DATA_FIRST_FRAG) && !(active[first - 1].flags & SCTP_DATA_LAST_FRAG)
      && active[first - 1].streamId === chunk.streamId && tsnPlusOne(active[first - 1].tsn) === active[first].tsn) first--;
    while (last + 1 < active.length && !(active[last].flags & SCTP_DATA_LAST_FRAG) && !(active[last + 1].flags & SCTP_DATA_FIRST_FRAG)
      && active[last + 1].streamId === chunk.streamId && tsnPlusOne(active[last].tsn) === active[last + 1].tsn) last++;
    for (let pos = first; pos <= last; pos++) {
      const part = active[pos];
      if (part.realtimeInFlight) this.flightSizeDecrease(part);
      part.abandoned = true;
      part.retransmit = false;
    }
    return true;
  }
  scheduleRealtimeExpiry() {
    clearTimeout(this.realtimeExpiryTimer);
    this.realtimeExpiryTimer = void 0;
    if (this.isStopped) return;
    let expiry = Infinity;
    for (const chunk of [...this.sentQueue, ...this.outboundQueue]) {
      if (!chunk.abandoned && chunk.expiry !== void 0) expiry = Math.min(expiry, chunk.expiry);
    }
    if (expiry !== Infinity) this.realtimeExpiryTimer = setTimeout(() => {
      this.realtimeExpiryTimer = void 0;
      void this.transmit();
    }, Math.max(1, Math.ceil((expiry - performance.now() / 1e3) * 1e3)));
  }`);
  output = replaceOnce(output, "  async transmitOnce() {\n    if (this.isStopped) return;", `  async transmitOnce() {
    if (this.isStopped) return;
    const realtimeNow = performance.now() / 1e3;
    for (const chunk of [...this.sentQueue, ...this.outboundQueue]) {
      if (!chunk.abandoned && chunk.expiry !== void 0 && chunk.expiry <= realtimeNow) this.maybeAbandon(chunk);
    }
    while (this.outboundQueue[0]?.abandoned) this.sentQueue.push(this.outboundQueue.shift());
    this.updateAdvancedPeerAckPoint();`);
  output = replaceOnce(output, "if (dataChunk.retransmit) {\n        if (this.fastRecoveryTransmit)", "if (dataChunk.retransmit) {\n        if (this.maybeAbandon(dataChunk)) { this.transmitRequested = true; continue; }\n        if (this.fastRecoveryTransmit)");
  output = replaceOnce(output, "this.sentQueue.push(chunk);\n      this.flightSizeIncrease(chunk);", "this.sentQueue.push(chunk);\n      if (chunk.abandoned || this.maybeAbandon(chunk)) { this.updateAdvancedPeerAckPoint(); this.transmitRequested = true; continue; }\n      this.flightSizeIncrease(chunk);");
  output = replaceOnce(output, "    await this.transmit();\n    while (this.outboundQueue.length) {", "    this.scheduleRealtimeExpiry();\n    await this.transmit();\n    while (this.outboundQueue.length) {");
  output = replaceOnce(output, "    } finally {\n      this.transmitting = false;\n    }\n  }\n  async transmitOnce()", "    } finally {\n      this.transmitting = false;\n      this.scheduleRealtimeExpiry();\n    }\n  }\n  async transmitOnce()");
  output = replaceOnce(output, "  flightSizeIncrease(chunk) {\n    this.flightSize += chunk.bookSize;\n  }\n  flightSizeDecrease(chunk) {\n    this.flightSize = Math.max(0, this.flightSize - chunk.bookSize);\n  }", "  flightSizeIncrease(chunk) {\n    if (!chunk.realtimeInFlight) this.flightSize += chunk.bookSize;\n    chunk.realtimeInFlight = true;\n  }\n  flightSizeDecrease(chunk) {\n    if (chunk.realtimeInFlight) this.flightSize = Math.max(0, this.flightSize - chunk.bookSize);\n    chunk.realtimeInFlight = false;\n  }");
  output = replaceOnce(output, "this.fastRecoveryExit = void 0;\n    this.flightSize = 0;", "this.fastRecoveryExit = void 0;\n    this.flightSize = 0;\n    for (const chunk of this.sentQueue) chunk.realtimeInFlight = false;");
  output = replaceOnce(output, "this.updateAdvancedPeerAckPoint();\n    this.fastRecoveryExit = void 0;", "this.updateAdvancedPeerAckPoint();\n    if (!this.forwardTsnChunk && this.realtimeForwardTsn && uint32Gt(this.realtimeForwardTsn.cumulativeTsn, this.lastSackedTsn)) this.forwardTsnChunk = this.realtimeForwardTsn;\n    this.fastRecoveryExit = void 0;");
  output = replaceOnce(output, `    if (this.forwardTsnChunk) {
      await this.sendChunk(this.forwardTsnChunk).catch((err5) => {
        log30("send forwardTsn failed", err5.message);
      });
      this.forwardTsnChunk = void 0;`, `    if (this.forwardTsnChunk) {
      const forward = this.forwardTsnChunk;
      this.forwardTsnChunk = void 0;
      this.realtimeForwardTsn = forward;
      await this.sendChunk(forward).catch((err5) => {
        log30("send forwardTsn failed", err5.message);
      });`);
  output = replaceOnce(output, "    if (this.sentQueue.length === 0) {\n      this.timer3Cancel();\n    } else if (done > 0)", "    if (this.sentQueue.length === 0) {\n      if (this.realtimeForwardTsn && uint32Gt(this.realtimeForwardTsn.cumulativeTsn, this.lastSackedTsn)) {\n        if (!this.timer3Handle) this.timer3Start();\n      } else this.timer3Cancel();\n    } else if (done > 0)");
  output = replaceOnce(output, "  updateAdvancedPeerAckPoint() {\n    if (uint32Gt", "  updateAdvancedPeerAckPoint() {\n    if (this.realtimeForwardTsn && uint32Gte(this.lastSackedTsn, this.realtimeForwardTsn.cumulativeTsn)) this.realtimeForwardTsn = void 0;\n    if (uint32Gt");
  output = replaceOnce(output, "this.isClosed = true;\n      this.timer1Cancel();", "this.isClosed = true;\n      clearTimeout(this.realtimeExpiryTimer);\n      this.realtimeExpiryTimer = void 0;\n      this.timer1Cancel();");
  return output;
}

/** The caller must await this before supplying the plugin to an esbuild Node
 * bundle. It affects that build only, not another consumer of the package. */
export async function realtimeWeriftPlugin({ packageRoot } = {}) {
  if (typeof packageRoot !== "string") throw invalid();
  const root = await realpath(resolve(packageRoot));
  const verified = new Map();
  for (const [file, digest] of Object.entries(weriftRealtimeRevision.files)) {
    const data = await readFile(resolve(root, file));
    if (createHash("sha256").update(data).digest("hex") !== digest) throw invalid();
    verified.set(file, data.toString("utf8"));
  }
  const metadata = JSON.parse(verified.get("package.json"));
  if (metadata.name !== "werift" || metadata.version !== "0.24.4" || metadata.license !== "MIT") throw invalid();
  const source = corrected(verified.get("lib/index.mjs"));
  const entry = resolve(root, "lib/index.mjs");
  return { name: "relayswarm-realtime-werift-0244", setup(build) {
    if (build.initialOptions.platform !== "node" || !build.initialOptions.bundle || build.initialOptions.packages === "external"
      || (build.initialOptions.external ?? []).some(name => name !== 'node:*' && !builtinModules.includes(name) && !(name.startsWith('node:') && builtinModules.includes(name.slice(5))))
      || build.initialOptions.format !== "esm") throw invalid();
    build.initialOptions.banner = { ...build.initialOptions.banner,
      js: `${NOTICE}\n${build.initialOptions.banner?.js ?? ""}` };
    build.initialOptions.legalComments = "inline";
    build.onResolve({ filter: /^werift$/ }, () => ({ path: entry }));
    build.onResolve({ filter: /^werift\// }, () => { throw invalid(); });
    build.onLoad({ filter: /index\.mjs$/ }, args => resolve(args.path) === entry
      ? { contents: source, loader: "js", resolveDir: dirname(entry) } : undefined);
  } };
}
