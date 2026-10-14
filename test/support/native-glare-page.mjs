// Bundled only for the dedicated, transport-only native glare fixture.
import Hls from "hls.js";
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { createHlsSwarm } from "../../src/browser/hls-swarm.mjs";

const config = await fetch("/configuration").then(response => response.json());
const secret = generateSecretKey(), pubkey = getPublicKey(secret), pcs = [], channels = [], listeners = [], loaders = new Set();
const rows = [], counts = { pc: 0, pcRefused: 0, offer: 0, answer: 0, remoteOffer: 0, remoteAnswer: 0,
  rollback: 0, rollbackCompleted: 0, operationFailed: 0, channelOpen: 0, peakOpen: 0, dropped: 0 };
const candidateTypes = { host: 0, srflx: 0, prflx: 0, relay: 0, unknown: 0 };
let candidateEnds = 0, candidateCountOverflow = false;
let hls, swarm, stopped = false, started = false, trustedStart = false, ticket, expiresAt = 0, monotonicExpiry = 0, lastWall = Date.now(), expiryTimer;
let matchingHave = false, hlsDestroyed = null, setupFailed = false;
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
const digest = async bytes => hex(await crypto.subtle.digest("SHA-256", bytes));
const expectedKey = await digest(new TextEncoder().encode(`${config.swarmId}\n/media/seg.ts`));
const record = (event, value) => {
  if (rows.length >= 64) { counts.dropped++; return; }
  rows.push({ atMs: Math.round(performance.now()), event, value });
};
const nativeState = (pc, property, allowed) => {
  if (!pc) return null;
  try { const value = pc[property]; return allowed.includes(value) ? value : "unknown"; } catch { return "unknown"; }
};
const iceState = pc => nativeState(pc, "iceConnectionState", ["new", "checking", "connected", "completed", "failed", "disconnected", "closed"]);
const gatheringState = pc => nativeState(pc, "iceGatheringState", ["new", "gathering", "complete"]);
const nativeFailure = (operation, type, error) => {
  counts.operationFailed++;
  let name = "unknown";
  try {
    const value = error?.name;
    if (["OperationError", "InvalidStateError", "InvalidAccessError", "InvalidModificationError", "NotSupportedError",
      "TypeError", "AbortError", "UnknownError", "SyntaxError", "NetworkError", "SecurityError"].includes(value)) name = value;
  } catch { /* Error properties are not trusted diagnostic text. */ }
  record("native-operation-failed", `${operation}:${["offer", "answer", "rollback"].includes(type) ? type : "unknown"}:${name}`);
};
const listen = (target, event, callback) => { target.addEventListener(event, callback); listeners.push(() => target.removeEventListener(event, callback)); };
const fresh = () => {
  const wall = Date.now(), monotonic = performance.now(), forward = wall >= lastWall;
  lastWall = Math.max(lastWall, wall);
  return forward && !stopped && document.visibilityState === "visible" && wall < expiresAt && monotonic < monotonicExpiry;
};
const stop = () => {
  stopped = true; clearTimeout(expiryTimer);
  for (const loader of loaders) { try { loader.abort(); } catch {} try { loader.destroy(); } catch {} }
  loaders.clear();
  try { swarm?.stop(); } catch { setupFailed = true; }
  if (hls && hlsDestroyed !== true) {
    hlsDestroyed = false;
    try { hls.destroy(); hlsDestroyed = true; } catch { setupFailed = true; }
  }
};
listen(document, "visibilitychange", () => { if (started && document.visibilityState !== "visible") stop(); });
function observeChannel(channel, source) {
  if (channels.includes(channel)) return;
  if (channels.length >= 2) { setupFailed = true; channel.close(); return; }
  channels.push(channel); const id = channels.length;
  record("channel-created", source);
  const state = () => {
    counts.channelOpen = channels.filter(value => value.readyState === "open").length;
    counts.peakOpen = Math.max(counts.peakOpen, counts.channelOpen);
    record("channel-state", channel.readyState);
  };
  listen(channel, "open", state); listen(channel, "close", state); listen(channel, "error", () => { setupFailed = true; record("channel-error", id); });
  listen(channel, "message", event => {
    if (typeof event.data !== "string" || event.data.length > 65536) return;
    try {
      const message = JSON.parse(event.data);
      if (message.t === "have" && [message.keys, message.add].some(value => Array.isArray(value) && value.includes(expectedKey))) matchingHave = true;
    } catch { /* Native protocol handling owns malformed-message rejection. */ }
  });
}
class WitnessPC extends RTCPeerConnection {
  constructor(options) {
    if (counts.pc !== 0) { counts.pcRefused++; throw new Error("Lifetime PC cap"); }
    super(options); counts.pc++; pcs.push({ pc: this, created: performance.now() });
    listen(this, "signalingstatechange", () => record("signaling", this.signalingState));
    listen(this, "connectionstatechange", () => record("connection", this.connectionState));
    listen(this, "iceconnectionstatechange", () => record("ice", iceState(this)));
    listen(this, "icegatheringstatechange", () => record("gathering", gatheringState(this)));
    listen(this, "icecandidate", event => {
      let type = "unknown";
      try {
        if (event.candidate === null) {
          if (candidateEnds < Number.MAX_SAFE_INTEGER) candidateEnds++; else candidateCountOverflow = true;
          return;
        }
        // Read the native type property only; never inspect candidate strings.
        const value = event.candidate?.type;
        if (["host", "srflx", "prflx", "relay"].includes(value)) type = value;
      } catch { /* Unknown candidate classification stays explicit. */ }
      if (candidateTypes[type] < Number.MAX_SAFE_INTEGER) candidateTypes[type]++; else candidateCountOverflow = true;
    });
    listen(this, "datachannel", event => observeChannel(event.channel, "incoming"));
  }
  createDataChannel(...args) { const channel = super.createDataChannel(...args); observeChannel(channel, "local"); return channel; }
  setLocalDescription(description) {
    const type = description?.type;
    if (type === "rollback") counts.rollback++;
    let pending;
    try { pending = super.setLocalDescription(description); }
    catch (error) { nativeFailure("local", type, error); throw error; }
    return pending.then(value => {
      if (type === "offer") counts.offer++;
      if (type === "answer") counts.answer++;
      if (type === "rollback") counts.rollbackCompleted++;
      record("local-installed", type); return value;
    }, error => { nativeFailure("local", type, error); throw error; });
  }
  setRemoteDescription(description) {
    let pending;
    try { pending = super.setRemoteDescription(description); }
    catch (error) { nativeFailure("remote", description?.type, error); throw error; }
    return pending.then(value => {
      if (description.type === "offer") counts.remoteOffer++;
      if (description.type === "answer") counts.remoteAnswer++;
      record("remote-installed", description.type); return value;
    }, error => { nativeFailure("remote", description?.type, error); throw error; });
  }
}
async function json(path, body, signal) {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (response.status !== 200) throw new Error("Fixture admission refused");
  return response.json();
}
async function start(event) {
  if (!event.isTrusted || started || !document.querySelector("#upload").checked) return;
  started = true; trustedStart = true; document.querySelector("#start").disabled = true;
  try {
    const challenge = await json("/admission/challenge", { pubkey }, AbortSignal.timeout(3000));
    const proof = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [],
      content: JSON.stringify({ challenge: challenge.challenge, swarmId: challenge.swarmId, epoch: challenge.epoch }) }, secret);
    const began = performance.now();
    const own = await json("/admission/ticket", { proof }, AbortSignal.timeout(3000));
    const signed = JSON.parse(own.ticket);
    if (own.issuer !== config.admission.issuer || own.epoch !== config.admission.epoch || own.swarmId !== config.swarmId
      || signed.pubkey !== own.issuer || signed.kind !== 27236 || !verifyEvent(signed)
      || !signed.tags.some(([tag, value]) => tag === "p" && value === pubkey)
      || !signed.tags.some(([tag, value]) => tag === "x" && value === config.swarmId)
      || JSON.parse(signed.content).epoch !== own.epoch || !signed.tags.some(([tag, value]) => tag === "expiration" && value === String(own.expiresAt))) throw new Error("Own admission mismatch");
    ticket = own.ticket; expiresAt = own.expiresAt * 1000;
    monotonicExpiry = began + Math.min(120000, Math.max(0, expiresAt - Date.now()));
    if (!fresh()) throw new Error("Own admission expired");
    expiryTimer = setTimeout(stop, Math.min(expiresAt - Date.now(), monotonicExpiry - performance.now()));
    hls = new Hls({ enableWorker: false });
    swarm = createHlsSwarm({ mode: "peer-first", secretKey: secret, swarmId: config.swarmId,
      streamEvent: config.streamEvent, relays: [config.relay], ticket, serve: true, iceServers: [], RTCPeerConnectionImpl: WitnessPC,
      admit: async (key, credential, { signal }) => {
        if (!fresh()) { stop(); return false; }
        const response = await json("/admission/verify", { pubkey: key, ticket: credential }, signal);
        return fresh() && response.epoch === config.admission.epoch && response.admitted === true;
      },
      getCommitment: async (_context, { signal }) => {
        if (!fresh()) { stop(); throw new Error("Own admission expired"); }
        const response = await fetch("/commitment", { signal });
        if (!response.ok) throw new Error("Commitment unavailable");
        return response.json();
      },
    });
    swarm.attach(hls);
  } catch { setupFailed = true; stop(); }
}
document.querySelector("#start").addEventListener("click", start);
window.nativeGlare = {
  identify: () => pubkey, // Ephemeral public key is used by the Node relay in memory only.
  snapshot(readOnly = false) {
    const metrics = swarm?.metrics(), pc = pcs[0]?.pc;
    const transport = metrics?.transportDiagnostics?.counters ?? {};
    const wall = Date.now();
    const authorityFresh = readOnly ? wall >= lastWall && !stopped && document.visibilityState === "visible"
      && wall < expiresAt && performance.now() < monotonicExpiry : fresh();
    return { started, trustedStart, uploadChecked: document.querySelector("#upload").checked, stopped, setupFailed, authorityFresh, pcCount: counts.pc, offerInstalled: counts.offer,
      offerSent: transport["signal-send"]?.offer ?? 0,
      signalsReceived: (transport["offer-received"]?.authenticated ?? 0) + (transport["answer-received"]?.authenticated ?? 0),
      signalingState: pc?.signalingState ?? "unallocated", remainingDialMs: pcs.length ? Math.max(0, 12000 - (performance.now() - pcs[0].created)) : 0,
      connectionState: nativeState(pc, "connectionState", ["new", "connecting", "connected", "disconnected", "failed", "closed"]),
      iceConnectionState: iceState(pc), iceGatheringState: gatheringState(pc),
      candidateTypes: { ...candidateTypes }, candidateEnds, candidateCountOverflow,
      counts: { ...counts }, rows: rows.map(row => ({ ...row })), matchingHave,
      channels: channels.map((channel, index) => ({ id: index + 1, state: channel.readyState })),
      pcClosed: !!pc && pc.signalingState === "closed", hlsDestroyed,
      peers: metrics ? { connected: metrics.peers.connected, dialling: metrics.peers.dialling, linksOpened: metrics.peers.linksOpened,
        linksClosed: metrics.peers.linksClosed, dialsTimedOut: metrics.peers.dialsTimedOut, admitRefused: metrics.peers.admitRefused } : null,
      bytes: metrics ? { uploaded: metrics.bytes.uploaded, held: metrics.bytes.held, peerFirst: metrics.bytes.peerFirst } : null,
      peerLoads: metrics?.segments.peerFirstLoaded ?? 0, errors: metrics?.errors.total ?? 0,
    };
  },
  async load() {
    if (!fresh() || !hls?.config.fLoader) throw new Error("Fixture loader unavailable");
    const loader = new hls.config.fLoader(hls.config); loaders.add(loader);
    try {
      const data = await new Promise((resolve, reject) => loader.load({ url: `${location.origin}/media/seg.ts`, responseType: "arraybuffer",
        frag: { sn: 0, level: 0, cc: 0, type: "main", start: 0, duration: 2 } },
      { loadPolicy: hls.config.fragLoadPolicy.default, timeout: hls.config.fragLoadPolicy.default.maxLoadTimeMs },
      { onSuccess: response => resolve(response.data), onError: () => reject(new Error("Loader error")),
        onTimeout: () => reject(new Error("Loader timeout")), onAbort: () => reject(new Error("Loader aborted")) }));
      return { bytes: data.byteLength, sha256: await digest(data) };
    } finally { loaders.delete(loader); loader.destroy(); }
  },
  stop,
  detach() { for (const remove of listeners.splice(0)) remove(); document.querySelector("#start").removeEventListener("click", start); },
};
