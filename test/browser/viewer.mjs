// One viewer for the shadow-mode harness: hls.js plays the live stream and,
// unless ?swarm=0, the swarm races peers for every fragment alongside it.
// Bundled by test/hls-swarm-browser.mjs.
import Hls from "hls.js";
import { createHlsSwarm } from "../../src/browser/hls-swarm.mjs";

const params = new URLSearchParams(location.search);
const viewer = params.get("viewer") || "0";
const useSwarm = params.get("swarm") !== "0";
const video = document.querySelector("video");

const player = { stalls: 0, errors: 0, fatalErrors: 0, playingAt: 0, lastTime: 0, fragsLoaded: 0 };
video.addEventListener("waiting", () => { if (player.playingAt) player.stalls += 1; });
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

const swarm = useSwarm
  ? createHlsSwarm({
      swarmId: params.get("swarmId"),
      relays: [params.get("relay")],
      iceServers: [],
      originFallbackMs: Number(params.get("fallbackMs") || 1500),
      metricsIntervalMs: 5000,
      testHooks: { corruptUploads: params.get("corrupt") === "1" },
    })
  : null;

const hls = new Hls({ liveSyncDurationCount: 3, enableWorker: true });
hls.on(Hls.Events.FRAG_LOADED, () => { player.fragsLoaded += 1; });
hls.on(Hls.Events.ERROR, (_event, data) => {
  player.errors += 1;
  if (data.fatal) player.fatalErrors += 1;
});
swarm?.attach(hls);
hls.loadSource(params.get("src"));
hls.attachMedia(video);
video.muted = true;
video.play().catch(() => {});

window.__viewer = {
  viewer,
  useSwarm,
  report: () => ({ viewer, useSwarm, player: { ...player, currentTime: video.currentTime }, swarm: swarm?.metrics() ?? null }),
  stop: () => swarm?.stop(),
  loaderRestored: () => !hls.config.fLoader,
};
