import { readOperatorTokenFile } from "../demo/operator.mjs";
try {
  const token = await readOperatorTokenFile("/state/operator-token");
  const response = await fetch("http://127.0.0.1:8787/operator/status", { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error();
  const status = await response.json();
  const published = Date.parse(status.broadcast?.lastPublishedAt);
  if (!Number.isFinite(published) || Date.now() - published > 45000 || status.broadcast.hls?.state !== "publishing") throw new Error();
} catch { process.exitCode = 1; }
