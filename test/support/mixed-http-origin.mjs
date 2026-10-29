import { createServer, request } from 'node:http';
import { once } from 'node:events';

// Shared real HTTP body/Range accounting. No Core or Hls admission policy.
export async function mixedHttpOrigin(t, bytes, BaseLoader = class { constructor() { this.stats = {}; } }, invocationProbe = null) {
  const size = bytes.length, received = [], requests = [];
  let first;
  const firstRequest = new Promise(resolve => { first = resolve; });
  const server = createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/u.exec(req.headers.range ?? '');
    const from = match ? Number(match[1]) : 0, to = match ? Number(match[2]) + 1 : size;
    const row = { range: req.headers.range ?? null, status: match ? 206 : 200, sent: 0, complete: false };
    requests.push(row); first(row);
    res.writeHead(row.status, { 'content-length': to - from,
      ...(match ? { 'content-range': `bytes ${from}-${to - 1}/${size}` } : {}) });
    let at = from, timer;
    const write = () => {
      if (res.destroyed) return;
      if (at >= to) { row.complete = true; res.end(); return; }
      const end = Math.min(to, at + 65536), chunk = bytes.subarray(at, end);
      row.sent += chunk.length; res.write(chunk); at = end;
      if (at >= to) { row.complete = true; res.end(); return; }
      timer = setTimeout(write, 65536 / (3 * 1024 * 1024) * 1000);
    };
    res.on('close', () => clearTimeout(timer)); write();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/media/seg.ts`;
  class HttpLoader extends BaseLoader {
    constructor(config) {
      super(config);
      let loading = this.stats.loading;
      Object.defineProperty(this.stats, 'loading', { configurable: true, enumerable: true,
        get: () => loading, set: value => {
          loading = value;
          if (Number.isFinite(value?.start) && value.start > 0) this.sdkEnteredAtMs = value.start;
        } });
    }
    load(ctx, config, callbacks) {
      const priorStart = this.sdkEnteredAtMs ?? this.stats?.loading?.start;
      this.receipt = { range: ctx.rangeEnd ? [ctx.rangeStart, ctx.rangeEnd] : null,
        bytes: 0, complete: false, aborted: false, status: null,
        sdkEnteredAtMs: Number.isFinite(priorStart) ? priorStart : null, invokedAtMs: performance.now(),
        maxLoadTimeMs: config?.loadPolicy?.maxLoadTimeMs ?? null,
        maxTimeToFirstByteMs: config?.loadPolicy?.maxTimeToFirstByteMs ?? null };
      if (invocationProbe) this.receipt.invocationProbe = invocationProbe();
      received.push(this.receipt);
      this.aborted = false; this.stats = { aborted: false, loaded: 0, loading: { start: performance.now(), first: 0, end: 0 } };
      this.req = request(ctx.url, { agent: false, headers: ctx.rangeEnd ? { Range: `bytes=${ctx.rangeStart}-${ctx.rangeEnd - 1}` } : {} }, res => {
        this.receipt.status = res.statusCode; this.stats.loading.first = performance.now(); const chunks = [];
        res.on('data', chunk => { chunks.push(chunk); this.stats.loaded += chunk.length; this.receipt.bytes += chunk.length; });
        res.on('end', () => {
          if (this.aborted) return;
          this.receipt.complete = true; this.receipt.completedAtMs = performance.now();
          this.stats.loading.end = performance.now(); const data = Buffer.concat(chunks);
          callbacks.onSuccess({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), code: res.statusCode }, this.stats, ctx, null);
        });
      });
      this.req.on('error', () => { if (!this.aborted) callbacks.onError?.({ code: 0 }, ctx, null, this.stats); }); this.req.end();
    }
    abort() { this.aborted = true; if (this.receipt) this.receipt.aborted = true; this.req?.destroy(); }
    destroy() { this.abort(); }
  }
  return { url, received, requests, HttpLoader, firstRequest };
}
