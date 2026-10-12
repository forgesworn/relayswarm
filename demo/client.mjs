import Hls from "hls.js";
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";

const byId = (id) => document.getElementById(id);
const video = document.querySelector("video");
const startedAt = new Date().toISOString(), clockStart = performance.now();
const elapsed = () => Math.round(performance.now() - clockStart);
const push = (list, value, cap = 256) => { list.push(value); if (list.length > cap) list.shift(); };
const bytes = (amount) => amount < 1000 ? `${amount} B` : amount < 1e6 ? `${(amount / 1000).toFixed(1)} kB` : `${(amount / 1e6).toFixed(1)} MB`;
const player = { engine: "pending", firstPlayingAtMs: null, startupMs: null, stalls: 0, stallMs: 0, seeks: 0, seekRecoveryMs: [], fatalErrors: 0, errors: {}, fragmentsLoaded: 0, fragments: [], levelChanges: [] };
const network = { originMediaRequests: 0, encodedOriginMediaBytes: 0, transferOriginMediaBytes: 0 };
const sessions = [], snapshots = [];
const archivedTotals = { peerFirstBytes: 0, uploaded: 0, peerFirstLoads: 0, sessions: 0 };
let session, hls, swarm, initialLoader, startRequestedAt = null, stallAt = null, seekAt = null, native = false, activeConfig;
const status = (message) => { byId("status").textContent = message; };

video.addEventListener("playing", () => {
  if (player.firstPlayingAtMs === null) { player.firstPlayingAtMs = elapsed(); player.startupMs = startRequestedAt === null ? null : player.firstPlayingAtMs - startRequestedAt; }
  if (seekAt !== null) { push(player.seekRecoveryMs, elapsed() - seekAt); seekAt = null; }
  if (stallAt !== null) { player.stallMs += elapsed() - stallAt; stallAt = null; }
  render();
});
video.addEventListener("seeking", () => { player.seeks++; seekAt = elapsed(); stallAt = null; });
video.addEventListener("seeked", () => { if (!video.paused && video.readyState >= 3 && seekAt !== null) { push(player.seekRecoveryMs, elapsed() - seekAt); seekAt = null; } });
video.addEventListener("waiting", () => { if (player.firstPlayingAtMs !== null && !video.seeking && seekAt === null && !video.paused && stallAt === null) { player.stalls++; stallAt = elapsed(); } });
video.addEventListener("error", () => { if (native) { player.fatalErrors++; status("The browser could not play this stream."); } });

const observer = typeof PerformanceObserver === "function" ? new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const path = new URL(entry.name).pathname;
    if (!path.startsWith("/media/") || path.endsWith(".m3u8")) continue;
    network.originMediaRequests++;
    network.encodedOriginMediaBytes += entry.encodedBodySize || 0;
    network.transferOriginMediaBytes += entry.transferSize || 0;
  }
  render();
}) : null;
observer?.observe({ type: "resource", buffered: true });

function allMetrics() { return [...sessions.map((entry) => entry.metrics), ...(swarm ? [swarm.metrics()] : [])]; }
function totals() {
  return allMetrics().reduce((total, metrics) => { total.peerFirstBytes += metrics.bytes.peerFirst; total.uploaded += metrics.bytes.uploaded; total.peerFirstLoads += metrics.segments.peerFirstLoaded; return total; },
    { peerFirstBytes: archivedTotals.peerFirstBytes, uploaded: archivedTotals.uploaded, peerFirstLoads: archivedTotals.peerFirstLoads });
}
function stopSwarm() {
  if (!swarm) return;
  swarm.stop();
  sessions.push({ ...activeConfig, endedAtMs: elapsed(), metrics: swarm.metrics() });
  if (sessions.length > 64) {
    const removed = sessions.shift().metrics;
    archivedTotals.peerFirstBytes += removed.bytes.peerFirst; archivedTotals.uploaded += removed.bytes.uploaded;
    archivedTotals.peerFirstLoads += removed.segments.peerFirstLoaded; archivedTotals.sessions++;
  }
  swarm = null;
}
function configure() {
  stopSwarm();
  const mode = native ? "off" : byId("mode").value;
  activeConfig = { mode, upload: byId("upload").checked, uploadLimit: Number(byId("limit").value), cellular: byId("cellular").checked, startedAtMs: elapsed() };
  swarm = createHlsSwarm({ mode, swarmId: session.swarmId, relays: session.relays, streamEvent: session.streamEvent,
    getCommitment: async (context, { signal }) => {
      const query = new URLSearchParams({ path: new URL(context.url).pathname, level: String(context.frag.level), sequence: String(context.frag.sn), cc: String(context.frag.cc ?? 0) });
      if (context.rangeEnd) { query.set("start", String(context.rangeStart || 0)); query.set("end", String(context.rangeEnd)); }
      if (context.part) query.set("part", String(context.part.index));
      const response = await fetch(`${session.commitmentEndpoint}?${query}`, { signal });
      if (!response.ok) throw new Error("Publisher commitment unavailable.");
      return response.json();
    },
    serve: activeConfig.upload, maxUploadBytesPerSecond: activeConfig.uploadLimit, serveOnCellular: activeConfig.cellular,
    ...(session.iceServers ? { iceServers: session.iceServers } : {}),
  });
  if (hls) swarm.attach(hls);
  const metrics = swarm.metrics();
  byId("kill").disabled = mode === "off";
  status(native ? "Native HLS playback · origin only; peer delivery is unavailable in this browser." : metrics.mode === "off" && mode !== "off" ? `Origin playback · peer delivery unavailable (${metrics.disabledReason}).` : `${mode === "off" ? "Origin only" : mode === "shadow" ? "Shadow measurement" : "Verified peer-first"} · ${metrics.serving ? "uploading enabled" : "uploading off"}`);
  render();
}
function render() {
  const total = totals(), metrics = swarm?.metrics();
  byId("saved").textContent = bytes(total.peerFirstBytes);
  byId("origin").textContent = native || !observer ? "Unavailable" : String(network.originMediaRequests);
  byId("uploaded").textContent = bytes(total.uploaded);
  byId("peers").textContent = String(metrics?.peers.connected || 0);
  byId("detail").textContent = `${total.peerFirstLoads} verified peer-first loads · ${player.stalls} playback stalls · ${player.fragmentsLoaded} media fragments loaded`;
}
function report() {
  return { v: 1, kind: "relayswarm-field-receipt", startedAt, recordedAt: new Date().toISOString(), durationMs: elapsed(),
    environment: { browser: navigator.userAgent, secureContext: isSecureContext, networkLabel: byId("network").value, deviceLabel: byId("device").value, automated: navigator.webdriver === true },
    stream: { eventId: session?.streamEvent.id, publisher: session?.streamEvent.pubkey, swarmId: session?.swarmId, experimental: true },
    player: { ...player, currentTime: video.currentTime, paused: video.paused, bufferedSeconds: hls?.mainForwardBufferInfo?.len ?? null, activeStallMs: stallAt === null ? 0 : elapsed() - stallAt },
    network: { ...network, ...(native ? { originMediaRequests: null, encodedOriginMediaBytes: null, transferOriginMediaBytes: null } : {}), supported: Boolean(observer) && !native,
      scope: "same-origin media resource timings; includes init segments and cache hits; encoded bytes exclude protocol overhead; native HLS requests are not measured" },
    totals: totals(), current: swarm ? { ...activeConfig, metrics: swarm.metrics() } : null, sessions: [...sessions], snapshots: [...snapshots],
    retention: { fragments: "latest 256", snapshots: "latest 60, every five seconds", sessions: "latest 64", archivedSessions: archivedTotals.sessions, totals: "whole page session" },
    loaderRestored: !hls || hls.config.fLoader === initialLoader, limits: ["Network and device labels are supplied by the viewer.", "No peer IP addresses or private signing keys are recorded.", "A receipt is evidence for this session only; it is not a production-readiness claim."],
  };
}

byId("settings").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!session) return;
  if (startRequestedAt === null) {
    startRequestedAt = elapsed();
    if (Hls.isSupported()) {
      player.engine = `hls.js ${Hls.version}`;
      hls = new Hls({ liveSyncDurationCount: 4, maxBufferLength: 20, maxMaxBufferLength: 30 });
      initialLoader = hls.config.fLoader;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hls.levels.forEach((level, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = `${level.height}p · ${Math.round(level.bitrate / 1000)} kbps`; byId("quality").append(option); });
        byId("quality").disabled = false;
      });
      hls.on(Hls.Events.FRAG_LOADED, (_event, { frag, payload, networkDetails }) => {
        if (frag.sn === "initSegment") return;
        player.fragmentsLoaded++;
        push(player.fragments, { atMs: elapsed(), level: frag.level, sequence: frag.sn, discontinuity: frag.cc, rangeStart: frag.byteRangeStartOffset ?? null, rangeEnd: frag.byteRangeEndOffset ?? null, size: payload.byteLength,
          source: networkDetails ? "origin" : activeConfig.mode === "peer-first" ? "peer" : "unknown", statsLoaded: frag.stats.loaded,
          loadingMs: frag.stats.loading.end - frag.stats.loading.start });
        render();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => push(player.levelChanges, { atMs: elapsed(), level: data.level }));
      hls.on(Hls.Events.ERROR, (_event, data) => { player.errors[data.details] = (player.errors[data.details] || 0) + 1; if (data.fatal) { player.fatalErrors++; status("Playback stopped after a fatal error. Download a receipt to retain the measurements."); } });
      configure();
      hls.loadSource(session.manifest); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      native = true; player.engine = "native HLS"; byId("mode").value = "off"; byId("mode").disabled = true; byId("upload").disabled = true; configure(); video.src = session.manifest;
    } else { player.engine = "unsupported"; status("This browser cannot play the test stream."); startRequestedAt = null; return; }
    byId("start").textContent = "Apply settings"; byId("download").disabled = false;
    video.play().catch(() => status("Press play on the video to begin."));
  } else configure();
});
byId("quality").addEventListener("change", () => { if (hls) hls.nextLevel = Number(byId("quality").value); });
byId("kill").addEventListener("click", () => { byId("mode").value = "off"; configure(); });
byId("download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(report(), null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `relayswarm-field-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener("pagehide", stopSwarm);
window.addEventListener("pageshow", () => { if (startRequestedAt !== null && !swarm) { byId("kill").disabled = true; status("Peer delivery stopped while this page was inactive. Playback uses origin; apply settings to rejoin."); } });
window.relaySwarmDemo = { report, stop: () => { stopSwarm(); render(); }, ready: () => Boolean(session), media: video };
setInterval(render, 1000);
setInterval(() => { if (swarm) push(snapshots, { atMs: elapsed(), metrics: swarm.metrics() }, 60); }, 5000);
try {
  const response = await fetch("/session.json"); if (!response.ok) throw new Error("Session unavailable.");
  session = await response.json(); byId("start").disabled = false;
  status(isSecureContext ? "Ready · choose a delivery mode and start playback." : "This address needs HTTPS for peer delivery. Origin playback is available.");
} catch { status("The publisher is unavailable. Reload after it has started."); }
