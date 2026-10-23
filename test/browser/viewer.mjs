// One viewer for the shadow-mode harness: hls.js plays the live stream and,
// unless ?swarm=0, the swarm races peers for every fragment alongside it.
// Bundled by test/hls-swarm-browser.mjs.
import Hls from "hls.js";
import { createHlsSwarm } from "../../src/browser/hls-swarm.mjs";

const params = new URLSearchParams(location.search);
const viewer = params.get("viewer") || "0";
const useSwarm = params.get("swarm") !== "0";
const video = document.querySelector("video");

const player = { stalls: 0, errors: 0, fatalErrors: 0, playingAt: 0, lastTime: 0, fragsLoaded: 0, errorDetails: {}, stallTimes: [] };
video.addEventListener("waiting", () => { if (player.playingAt) { player.stalls += 1; player.stallTimes.push({ atMs: Math.round(performance.now()), currentTime: video.currentTime }); } });
video.addEventListener("playing", () => { if (!player.playingAt) player.playingAt = performance.now(); });
setInterval(() => { player.lastTime = video.currentTime; }, 500);

// Chrome offers host candidates only on the default-route interface until the
// page holds a media permission. On a machine whose default route is a VPN,
// same-machine viewers then cannot reach each other, so the harness grants a
// fake microphone to unlock every interface. Real viewers use STUN instead.
if (params.get("unlockInterfaces") === "1") {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {}
}

// ?rotation=0 is the before picture: peers refuse when full instead of
// rotating, nobody retries, and nobody is referred anywhere.
const rotation = params.get("rotation") !== "0";
const withoutRotation = { idleEvictMs: 10 ** 9, maxRetriesPerPeer: 0, maxReferrals: 0, retryFloorMs: 30_000, retryCeilingMs: 30_000 };

const mode = params.get("mode") || "shadow";
const streamEvent = mode === "peer-first" ? await fetch("/authorisation.json").then((response) => response.json()) : undefined;
let commitmentRequests = 0;
const resourceSamples = [];
const resourceHighWater = { samples: 0, firstAtMs: null, lastAtMs: null, activePeers: 0, heldBytes: 0, relays: 0, jsHeapBytes: 0 };
const testConnections = new Set();
class ObservedPeerConnection extends RTCPeerConnection {
  constructor(configuration) {
    super(configuration);
    testConnections.add(this);
    this.addEventListener("connectionstatechange", () => { if (this.connectionState === "closed") testConnections.delete(this); });
  }
}

const swarm = useSwarm
  ? createHlsSwarm({
      mode,
      streamEvent,
      getCommitment: async (context, { signal }) => {
        commitmentRequests++;
        if (params.get("commitmentFaults") === "1" && (commitmentRequests === 2 || commitmentRequests % 7 === 0)) {
          return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true }));
        }
        const query = new URLSearchParams({ path: new URL(context.url).pathname, level: String(context.frag.level), sequence: String(context.frag.sn), cc: String(context.frag.cc ?? 0) });
        if (params.get("commitmentFaults") === "1" && (commitmentRequests === 1 || commitmentRequests % 5 === 0)) query.set("bad", "1");
        return fetch(`/commitment?${query}`, { signal }).then((response) => response.json());
      },
      serve: true, // Test fixtures explicitly contribute and race every segment.
      shadowSampleRate: 1,
      swarmId: params.get("swarmId"),
      relays: [params.get("relay")],
      iceServers: globalThis.__relaySwarmTestIce?.iceServers ?? [],
      iceTransportPolicy: globalThis.__relaySwarmTestIce?.iceTransportPolicy ?? "all",
      ...(globalThis.__relaySwarmTestIce ? { RTCPeerConnectionImpl: ObservedPeerConnection } : {}),
      originFallbackMs: Number(params.get("fallbackMs") || 1500),
      metricsIntervalMs: 5000,
      onMetrics: (metrics) => {
        const atMs = Math.round(performance.now());
        resourceSamples.push({ atMs, connected: metrics.peers.connected, dialling: metrics.peers.dialling,
          heldBytes: metrics.bytes.held, uploadedBytes: metrics.bytes.uploaded, relays: metrics.relays.connected });
        if (resourceSamples.length > 120) resourceSamples.shift();
        resourceHighWater.samples++;
        resourceHighWater.firstAtMs ??= atMs;
        resourceHighWater.lastAtMs = atMs;
        resourceHighWater.activePeers = Math.max(resourceHighWater.activePeers, metrics.peers.connected + metrics.peers.dialling);
        resourceHighWater.heldBytes = Math.max(resourceHighWater.heldBytes, metrics.bytes.held);
        resourceHighWater.relays = Math.max(resourceHighWater.relays, metrics.relays.connected);
        resourceHighWater.jsHeapBytes = Math.max(resourceHighWater.jsHeapBytes, performance.memory?.usedJSHeapSize ?? 0);
      },
      ...(params.get("maxPeers") ? { maxPeers: Number(params.get("maxPeers")), maxUploadPeers: Number(params.get("maxPeers")) } : {}),
      testHooks: { corruptUploads: params.get("corrupt") === "1" },
      ...(rotation ? {} : withoutRotation),
    })
  : null;

// The tampering seeder keeps one segment's lead in peer-first tests so
// integrity is exercised against an object already advertised by a peer.
const liveSyncDurationCount = mode === "peer-first" ? 4 : 3;
// A playback lead alone does not imply an availability lead: unconstrained
// live prefetch reaches the same edge in every tab. Keep peer-first viewers'
// forward buffer behind the full-prefetch seeder, including the baseline.
const hls = new Hls({ liveSyncDurationCount, enableWorker: true,
  ...(mode === "peer-first" ? { maxBufferLength: 4, maxMaxBufferLength: 6 } : {}),
});
hls.on(Hls.Events.FRAG_LOADED, () => { player.fragsLoaded += 1; });
hls.on(Hls.Events.ERROR, (_event, data) => {
  player.errors += 1;
  player.errorDetails[data.details] = (player.errorDetails[data.details] || 0) + 1;
  if (data.fatal) player.fatalErrors += 1;
});
swarm?.attach(hls);
hls.loadSource(params.get("src"));
hls.attachMedia(video);
video.muted = true;
video.play().catch(() => {});

window.__viewer = {
  iceEvidence: async () => Promise.all([...testConnections].filter((pc) => pc.connectionState === "connected").map(async (pc) => {
    const stats = await pc.getStats();
    let pair;
    stats.forEach((report) => { if (report.type === "transport" && report.selectedCandidatePairId) pair = stats.get(report.selectedCandidatePairId); });
    if (!pair) stats.forEach((report) => { if (report.type === "candidate-pair" && report.nominated && report.state === "succeeded") pair = report; });
    const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
    return { local: local?.candidateType, remote: remote?.candidateType, relayProtocol: local?.relayProtocol,
      localPort: local?.port, remotePort: remote?.port, bytesSent: pair?.bytesSent ?? 0, bytesReceived: pair?.bytesReceived ?? 0 };
  })),
  viewer,
  useSwarm,
  report: () => ({ viewer, useSwarm, player: { ...player, currentTime: video.currentTime }, swarm: swarm?.metrics() ?? null, resourceSamples: [...resourceSamples], resourceHighWater: { ...resourceHighWater } }),
  stop: () => swarm?.stop(),
  loaderRestored: () => !hls.config.fLoader,
  stoppedMetrics: () => swarm?.metrics(),
};
