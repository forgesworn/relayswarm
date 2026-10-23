import Hls from "hls.js";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { createPersistentUploadBudget } from "./upload-budget.mjs";
import { createMediaRecovery } from "./media-recovery.mjs";
import { createLivePlaylistRetry } from "./live-playlist-retry.mjs";
import { segmentMediaContext } from "../src/browser/segment-commitment.mjs";
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";
import { createFetchDiagnostics } from "./fetch-diagnostics.mjs";
import { createPolicyRenewal } from "./policy-renewal.mjs";
import { createAccountBudgetClient } from "./account-budget-client.mjs";
import { createTurnCredentials, normalizeTurnCredentialDescriptor } from "./turn-credentials.mjs";

const fetchDiagnostics = createFetchDiagnostics();

let persistentStorage; try { persistentStorage = globalThis.localStorage; } catch { /* Upload stays off when storage is blocked. */ }
const uploadBudget = createPersistentUploadBudget({ storage: persistentStorage, locks: navigator.locks });
const admissionKey = generateSecretKey(), admissionPubkey = getPublicKey(admissionKey);
const reportId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
let reportSequence = 0, admissionCredential = null;
const byId = (id) => document.getElementById(id);
byId("upload").checked = false; byId("telemetry").checked = false;
const video = document.querySelector("video");
const startedAt = new Date().toISOString(), clockStart = performance.now();
const elapsed = () => Math.round(performance.now() - clockStart);
const push = (list, value, cap = 256) => { list.push(value); if (list.length > cap) list.shift(); };
const bytes = (amount) => amount < 1000 ? `${amount} B` : amount < 1e6 ? `${(amount / 1000).toFixed(1)} kB` : `${(amount / 1e6).toFixed(1)} MB`;
const player = { engine: "pending", firstPlayingAtMs: null, startupMs: null, stalls: 0, stallMs: 0, seeks: 0, seekRecoveryMs: [], fatalErrors: 0, errors: {}, fragmentsLoaded: 0, fragments: [], levelChanges: [], errorRecords: [], nativeErrors: [], resumeAttempts: 0, resumeRecords: [] };
const network = { originMediaRequests: 0, encodedOriginMediaBytes: 0, transferOriginMediaBytes: 0 };
const sessions = [], snapshots = [];
// Field-run options, off unless the page URL asks, e.g. ?multiHolder=1&trace=4096.
// An out-of-range trace count records nothing rather than disabling peer delivery.
const fieldOptions = (() => {
  const query = new URLSearchParams(location.search ?? ""), trace = Number(query.get("trace") ?? 0);
  return { multiHolder: query.get("multiHolder") === "1", traceRequests: Number.isSafeInteger(trace) && trace > 0 && trace <= 32768 ? trace : 0 };
})();
const swarmTrace = () => fieldOptions.traceRequests && swarm ? { trace: swarm.trace() } : {};
let deliveryPolicy = { mode: null, revision: 0, telemetry: false }, policyUnavailable = true;
const archivedTotals = { peerFirstBytes: 0, uploaded: 0, peerFirstLoads: 0, sessions: 0 };
let session, hls, swarm, initialLoader, startRequestedAt = null, stallAt = null, seekAt = null, native = false, playerHasPlayed = false, activeConfig, needsViewerApply = false, suspensionGeneration = 0;
let accountActionPending = false;
const status = (message) => { byId("status").textContent = message; };
const accountBudget = createAccountBudgetClient({ secretKey: admissionKey, origin: location.origin,
  onRevoke() { suspensionGeneration++; needsViewerApply = true; stopSwarm(); byId("upload").checked = false; },
});
const turnCredentials = createTurnCredentials({ origin: location.origin,
  onRefresh() { if (swarm && activeConfig.mode !== "off" && peerAuthorityFresh(session)) configure(); },
  onUnavailable() {
    suspensionGeneration++; needsViewerApply = true; byId("upload").checked = false; stopSwarm();
    status("Peer relay credentials unavailable · origin playback; apply settings to rejoin.");
  },
});
const iceTransportPolicy = value => value?.iceTransportPolicy === undefined ? "all" : value.iceTransportPolicy;
const turnDescriptor = value => normalizeTurnCredentialDescriptor(value?.turnCredentials);
const turnIdentity = value => JSON.stringify([value?.swarmId, value?.streamEvent?.id, value?.admission?.issuer, value?.admission?.epoch, turnDescriptor(value)?.urlProjection ?? "issued"]);
const mediaRecovery = createMediaRecovery({ media: video, getHls: () => hls, getSession: () => session, now: elapsed,
  revokeContribution() { stopSwarm(); byId("mode").value = "off"; byId("upload").checked = false; },
  status(message) {
    status(message);
    const active = mediaRecovery.active();
    byId("kill").textContent = active ? "Stop recovery" : "Use origin only"; byId("kill").disabled = !active;
    for (const id of ["start", "mode", "upload", "reset-allowance", "quality"]) byId(id).disabled = active;
  },
});

video.addEventListener("playing", () => {
  playerHasPlayed = true;
  if (player.firstPlayingAtMs === null) { player.firstPlayingAtMs = elapsed(); player.startupMs = startRequestedAt === null ? null : player.firstPlayingAtMs - startRequestedAt; }
  if (seekAt !== null) { push(player.seekRecoveryMs, elapsed() - seekAt); seekAt = null; }
  if (stallAt !== null) { player.stallMs += elapsed() - stallAt; stallAt = null; }
  render();
});
video.addEventListener("seeking", () => { player.seeks++; seekAt = elapsed(); stallAt = null; });
video.addEventListener("seeked", () => { if (!video.paused && video.readyState >= 3 && seekAt !== null) { push(player.seekRecoveryMs, elapsed() - seekAt); seekAt = null; } });
video.addEventListener("waiting", () => { if (player.firstPlayingAtMs !== null && !video.seeking && seekAt === null && !video.paused && stallAt === null) { player.stalls++; stallAt = elapsed(); } });
video.addEventListener("error", () => {
  push(player.nativeErrors, { atMs: elapsed(), code: video.error?.code ?? null, message: String(video.error?.message ?? "").slice(0, 512) }, 64);
  if (native) { player.fatalErrors++; status("The browser could not play this stream."); }
});

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
  turnCredentials.setActive(false);
  if (!swarm) return;
  swarm.stop();
  sessions.push({ ...activeConfig, endedAtMs: elapsed(), metrics: swarm.metrics(), ...swarmTrace() });
  const traced = sessions.filter((entry) => entry.trace);
  if (traced.length > 8) delete traced[0].trace;
  if (sessions.length > 64) {
    const removed = sessions.shift().metrics;
    archivedTotals.peerFirstBytes += removed.bytes.peerFirst; archivedTotals.uploaded += removed.bytes.uploaded;
    archivedTotals.peerFirstLoads += removed.segments.peerFirstLoaded; archivedTotals.sessions++;
  }
  swarm = null;
}
function configure() {
  if (mediaRecovery.active() || accountActionPending) return;
  policyRenewal.fresh();
  const account = accountBudget.snapshot(), turnReady = turnCredentials.fresh();
  stopSwarm();
  const configuredSession = session, configuredCredential = admissionCredential;
  const chosenMode = byId("mode").value;
  const requestedMode = native || policyUnavailable || needsViewerApply || !turnReady || chosenMode === "off" ? "off" : deliveryPolicy.mode ?? chosenMode;
  const mode = session.admission && !admissionCredential ? "off" : requestedMode;
  const budget = uploadBudget.snapshot(), allowance = budget.limit;
  const remaining = account.required ? Math.min(budget.remaining, account.available ? account.remaining : 0) : budget.remaining;
  const admissionReady = ownCredentialFresh(session);
  const iceServers = session.turnCredentials ? turnCredentials.servers() : session.iceServers;
  activeConfig = { mode, upload: byId("upload").checked && mode !== "off" && budget.available && remaining > 0 && admissionReady, uploadAllowance: allowance, uploadLimit: Number(byId("limit").value), cellular: byId("cellular").checked, ...fieldOptions, startedAtMs: elapsed() };
  swarm = createHlsSwarm({ mode, coreWasm: "/relayswarm-core.wasm", ...fieldOptions, swarmId: session.swarmId, relays: session.relays, streamEvent: session.streamEvent, delegation: session.delegation, revokedDelegationIds: session.revokedDelegationIds, delegationRevocations: session.delegationRevocations, swarmParts: session.mediaCapabilities?.parts === true, originReserveMs: session.mediaCapabilities?.parts === true ? 500 : 2000,
    getCommitment: async (context, { signal }) => {
      const query = new URLSearchParams({ path: new URL(context.url).pathname, level: String(context.frag.level), sequence: String(context.frag.sn), cc: String(context.frag.cc ?? 0) });
      const mediaContext = segmentMediaContext(context);
      if (mediaContext) { query.set("playlist", mediaContext.playlist); query.set("mediaType", mediaContext.mediaType); }
      if (context.rangeEnd) { query.set("start", String(context.rangeStart || 0)); query.set("end", String(context.rangeEnd)); }
      if (context.part) query.set("part", String(context.part.index));
      return fetchDiagnostics.json("commitment", `${session.commitmentEndpoint}?${query}`, { signal });
    },
    secretKey: admissionKey, maxPeers: 4,
    ...(configuredSession.admission && configuredCredential ? { ticket: configuredCredential.ticket, admit: async (pubkey, ticket, { signal }) => {
      try {
        if (!peerAuthorityFresh(configuredSession) || signal.aborted) return false;
        const result = await fetchDiagnostics.json("admissionVerify", configuredSession.admission.verifyEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey, ticket }), signal });
        return peerAuthorityFresh(configuredSession) && !signal.aborted && result.admitted === true && result.epoch === configuredSession.admission.epoch;
      } catch { return false; }
    } } : {}),
    reserveUploadBytes: async (amount, options) => peerAuthorityFresh(configuredSession) && accountBudget.snapshot().available && !options?.signal?.aborted && await uploadBudget.reserve(amount, options) && peerAuthorityFresh(configuredSession) && !options?.signal?.aborted && await accountBudget.reserve(amount) && peerAuthorityFresh(configuredSession) && !options?.signal?.aborted,
    serve: activeConfig.upload, maxUploadBytesPerSession: remaining, maxUploadBytesPerSecond: activeConfig.uploadLimit, serveOnCellular: activeConfig.cellular,
    iceTransportPolicy: iceTransportPolicy(session), ...(iceServers ? { iceServers } : {}),
  });
  turnCredentials.setActive(mode !== "off" && admissionReady);
  if (hls) swarm.attach(hls);
  const metrics = swarm.metrics();
  byId("kill").disabled = mode === "off";
  status(native ? "Native HLS playback · origin only; peer delivery is unavailable in this browser." : metrics.mode === "off" && mode !== "off" ? `Origin playback · peer delivery unavailable (${metrics.disabledReason}).` : `${mode === "off" ? "Origin only" : mode === "shadow" ? "Shadow measurement" : "Verified peer-first"} · ${metrics.serving ? "uploading enabled" : "uploading off"}`);
  render();
}
function render() {
  accountBudget.snapshot();
  const total = totals(), metrics = swarm?.metrics();
  byId("saved").textContent = bytes(total.peerFirstBytes);
  byId("origin").textContent = native || !observer ? "Unavailable" : String(network.originMediaRequests);
  const budget = uploadBudget.snapshot();
  byId("uploaded").textContent = bytes(budget.spent);
  const allowance = budget.limit;
  byId("allowance-meter").max = allowance; byId("allowance-meter").value = Math.min(budget.spent, allowance);
  byId("allowance-used").textContent = `${bytes(budget.spent)} of ${bytes(allowance)} reserved in this browser${!budget.available ? " · persistent allowance unavailable; uploading disabled" : budget.spent >= allowance ? " · allowance exhausted; uploading stopped" : ""}`;
  byId("peers").textContent = String(metrics?.peers.connected || 0);
  byId("detail").textContent = `${total.peerFirstLoads} verified peer-first loads · ${player.stalls} playback stalls · ${player.fragmentsLoaded} media fragments loaded`;
  renderAccount();
}
function renderAccount() {
  const providers = accountBudget.providers(), account = accountBudget.snapshot();
  byId("account-budget-controls").hidden = providers.length === 0;
  for (const option of byId("account-method").options ?? []) { option.hidden = !providers.includes(option.value); option.disabled = option.hidden; }
  if (!providers.includes(byId("account-method").value)) byId("account-method").value = providers[0] ?? "";
  byId("account-link").hidden = !providers.includes("nostr") || !providers.includes("website");
  for (const id of ["account-connect", "account-disconnect", "account-link", "account-settings", "account-reset"]) byId(id).disabled = accountActionPending || accountBudget.busy() || mediaRecovery.active() || document.visibilityState !== "visible";
  byId("account-disconnect").disabled ||= !account.connected;
  byId("account-status").textContent = !account.required ? "Not connected. Only this browser’s allowance applies." : !account.available ? "Shared allowance unavailable. Uploading is off; reconnect explicitly before applying upload settings." : `${bytes(account.spent)} of ${bytes(account.limit)} reserved across this service · ${bytes(account.remaining)} remaining. Uploading still requires your checkbox and Apply settings.`;
}
function report() {
  policyRenewal.fresh();
  const account = accountBudget.snapshot(), turn = turnCredentials.snapshot();
  return { v: 1, kind: "relayswarm-field-receipt", startedAt, recordedAt: new Date().toISOString(), durationMs: elapsed(),
    environment: { browser: navigator.userAgent, secureContext: isSecureContext, networkLabel: byId("network").value, deviceLabel: byId("device").value, automated: navigator.webdriver === true },
    stream: { eventId: session?.streamEvent.id, publisher: session?.streamEvent.pubkey, swarmId: session?.swarmId, experimental: true },
    player: { ...player, mediaRecovery: mediaRecovery.snapshot(), isLive: hls?.latestLevelDetails?.live === true, liveLatencySeconds: Number.isFinite(hls?.latency) ? hls.latency : null, targetLatencySeconds: Number.isFinite(hls?.targetLatency) ? hls.targetLatency : null, liveSyncPosition: Number.isFinite(hls?.liveSyncPosition) ? hls.liveSyncPosition : null, currentTime: video.currentTime, paused: video.paused, bufferedSeconds: hls?.mainForwardBufferInfo?.len ?? null, activeStallMs: stallAt === null ? 0 : elapsed() - stallAt },
    network: { ...network, ...(native ? { originMediaRequests: null, encodedOriginMediaBytes: null, transferOriginMediaBytes: null } : {}), supported: Boolean(observer) && !native,
      scope: "same-origin media resource timings; includes init segments and cache hits; encoded bytes exclude protocol overhead; native HLS requests are not measured" },
    totals: totals(), uploadBudget: uploadBudget.snapshot(), accountBudget: account, deliveryPolicy: { ...deliveryPolicy, unavailable: policyUnavailable }, current: swarm ? { ...activeConfig, metrics: swarm.metrics(), ...swarmTrace() } : null, sessions: [...sessions], snapshots: [...snapshots],
    retention: { fragments: "latest 256", snapshots: "latest 60, every five seconds", sessions: "latest 64", traces: "latest 8 sessions, only when the page URL sets trace", archivedSessions: archivedTotals.sessions, totals: "whole page session" },
    loaderRestored: !hls || hls.config.fLoader === initialLoader, controlTimings: fetchDiagnostics.snapshot(), policyRenewal: policyRenewal.snapshot(), turnCredentials: turn, limits: ["Network and device labels are supplied by the viewer.", "No peer IP addresses or private signing keys are recorded; a trace names holders by per-session labels.", "A receipt is evidence for this session only; it is not a production-readiness claim."],
  };
}

function sameIdentity(a, b) {
  return a?.swarmId === b?.swarmId && a?.streamEvent?.id === b?.streamEvent?.id && a?.admission?.epoch === b?.admission?.epoch && a?.admission?.issuer === b?.admission?.issuer;
}
function samePeerConfiguration(a, b) {
  const fields = (value) => [value?.swarmId, value?.streamEvent, value?.relays, value?.admission, value?.manifest, value?.deliveryPolicyEndpoint, value?.commitmentEndpoint, value?.iceServers, iceTransportPolicy(value), turnDescriptor(value), value?.mediaCapabilities, value?.delegation, value?.revokedDelegationIds, value?.delegationRevocations, value?.deliveryPolicySession];
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}
function ownCredentialFresh(configuredSession) {
  if (!configuredSession.admission) return true;
  const credential = admissionCredential, admission = configuredSession.admission;
  return Boolean(credential && credential.issuer === admission.issuer && credential.epoch === admission.epoch && credential.swarmId === configuredSession.swarmId && Number.isSafeInteger(credential.expiresAt) && credential.expiresAt * 1000 > Date.now());
}
function peerAuthorityFresh(configuredSession) {
  if (session !== configuredSession || needsViewerApply || document.visibilityState !== "visible" || !policyRenewal.fresh() || !turnCredentials.fresh()) return false;
  if (ownCredentialFresh(configuredSession)) return true;
  policyUnavailableNow("admission-expired");
  return false;
}
async function obtainAdmission(candidateSession, existing, signal) {
  if (!candidateSession.admission) return null;
  const admission = candidateSession.admission;
  if (existing?.epoch === admission.epoch && existing.issuer === admission.issuer && existing.swarmId === candidateSession.swarmId && existing.expiresAt * 1000 - Date.now() > 20000) return existing;
  const post = (label, endpoint, body) => fetchDiagnostics.json(label, endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
  const challenge = await post("admissionChallenge", admission.challengeEndpoint, { pubkey: admissionPubkey });
  if (challenge.issuer !== admission.issuer || challenge.epoch !== admission.epoch || challenge.swarmId !== candidateSession.swarmId || typeof challenge.challenge !== "string") throw new Error("Peer admission changed.");
  const proof = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ challenge: challenge.challenge, swarmId: candidateSession.swarmId, epoch: challenge.epoch }) }, admissionKey);
  const credential = await post("admissionTicket", admission.ticketEndpoint, { proof });
  if (credential.issuer !== admission.issuer || credential.epoch !== admission.epoch || credential.swarmId !== candidateSession.swarmId || typeof credential.ticket !== "string" || credential.ticket.length > 2048 || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt * 1000 <= Date.now()) throw new Error("Invalid peer admission.");
  return credential;
}
function mountPlayer({ reloadNative = false } = {}) {
  const selectedQuality = byId("quality").value;
  byId("quality").length = 1; byId("quality").disabled = true;
  playerHasPlayed = false;
    if (Hls.isSupported()) {
      byId("mode").disabled = false; byId("upload").disabled = false;
      player.engine = `hls.js ${Hls.version}`;
      let mountedHls;
      const playlistRetry = createLivePlaylistRetry({ loadPolicy: Hls.DefaultConfig.playlistLoadPolicy, Loader: Hls.DefaultConfig.pLoader ?? Hls.DefaultConfig.loader,
        ErrorController: Hls.DefaultConfig.errorController, errorEvent: Hls.Events.ERROR,
        current: () => hls === mountedHls && document.visibilityState === "visible", live: () => mountedHls?.latestLevelDetails?.live === true });
      hls = mountedHls = new Hls({ ...(session.mediaCapabilities?.parts === true ? {} : { liveSyncDurationCount: 4 }), maxBufferLength: 20, maxMaxBufferLength: 30,
        playlistLoadPolicy: playlistRetry.loadPolicy, pLoader: playlistRetry.Loader, errorController: playlistRetry.ErrorController });
      initialLoader = hls.config.fLoader;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (hls !== mountedHls) return;
        hls.levels.forEach((level, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = `${level.height}p · ${Math.round(level.bitrate / 1000)} kbps`; byId("quality").append(option); });
        if (/^\d+$/u.test(selectedQuality) && Number(selectedQuality) < hls.levels.length) {
          hls.loadLevel = Number(selectedQuality); byId("quality").value = selectedQuality;
        } else byId("quality").value = "-1";
        byId("quality").disabled = false;
      });
      hls.on(Hls.Events.FRAG_LOADED, (_event, { frag, part, payload, networkDetails }) => {
        if (hls !== mountedHls) return;
        if (frag.sn === "initSegment") return;
        player.fragmentsLoaded++;
        push(player.fragments, { atMs: elapsed(), level: frag.level, sequence: frag.sn, part: part?.index ?? null, mediaType: frag.type ?? "video", playlist: segmentMediaContext({ frag, url: frag.url })?.playlist ?? null, discontinuity: frag.cc, rangeStart: frag.byteRangeStartOffset ?? null, rangeEnd: frag.byteRangeEndOffset ?? null, size: payload.byteLength,
          source: networkDetails ? "origin" : activeConfig.mode === "peer-first" ? "peer" : "unknown", statsLoaded: frag.stats.loaded,
          loadingMs: frag.stats.loading.end - frag.stats.loading.start });
        render();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => { if (hls === mountedHls) push(player.levelChanges, { atMs: elapsed(), level: data.level }); });
      hls.on(Hls.Events.LEVEL_UPDATED, (_event, { details }) => {
        if (hls !== mountedHls || document.visibilityState !== "visible") return;
        playlistRetry.loaded();
        mediaRecovery.observeLive(details, { lastFragmentCC: player.fragments.at(-1)?.discontinuity, fatalErrors: player.fatalErrors });
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (hls !== mountedHls) return;
        push(player.errorRecords, { atMs: elapsed(), details: data.details, fatal: Boolean(data.fatal), type: data.type, reason: String(data.reason ?? "").slice(0, 512), message: String(data.error?.message ?? "").slice(0, 512), nativeError: video.error && { code: video.error.code, message: video.error.message.slice(0, 512) }, mediaType: data.frag?.type ?? null, playlist: data.frag ? segmentMediaContext({ frag: data.frag, url: data.frag.url })?.playlist ?? null : null }, 64);
        player.errors[data.details] = (player.errors[data.details] || 0) + 1;
        if (data.fatal) { player.fatalErrors++; if (document.visibilityState !== "visible" || !mediaRecovery.handle(data)) status("Playback stopped after a fatal error. Download a receipt to retain the measurements."); }
      });
      configure();
      hls.loadSource(session.manifest); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      native = true; player.engine = "native HLS"; byId("mode").value = "off"; byId("mode").disabled = true; byId("upload").disabled = true; configure(); video.src = session.manifest;
      if (reloadNative) video.load();
    } else { player.engine = "unsupported"; status("This browser cannot play the test stream."); return false; }
  return true;
}

byId("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session || mediaRecovery.active() || accountActionPending || document.visibilityState !== "visible") return;
  byId("start").disabled = true;
  const submittedSession = session, priorCredential = admissionCredential;
  const submittedGeneration = suspensionGeneration;
  let turnReady = true;
  const applyIsCurrent = () => submittedGeneration === suspensionGeneration && document.visibilityState === "visible";
  try {
    await uploadBudget.setLimit(Number(byId("allowance").value));
    if (!applyIsCurrent()) return;
    if (byId("mode").value !== "off" && policyRenewal.fresh() && deliveryPolicy.mode !== "off") {
      const credential = await obtainAdmission(submittedSession, priorCredential);
      if (applyIsCurrent() && session === submittedSession && admissionCredential === priorCredential && policyRenewal.fresh()) admissionCredential = credential;
      if (applyIsCurrent() && session === submittedSession && policyRenewal.fresh() && Hls.isSupported() && session.turnCredentials) {
        turnReady = await turnCredentials.acquire();
        if (!turnReady && applyIsCurrent()) byId("upload").checked = false;
      }
    }
  } catch { if (applyIsCurrent() && session === submittedSession && admissionCredential === priorCredential) { admissionCredential = null; status("Peer admission unavailable · origin playback remains available."); } }
  finally { byId("start").disabled = mediaRecovery.active(); }
  if (mediaRecovery.active() || !applyIsCurrent()) return;
  needsViewerApply = !turnReady;
  if (startRequestedAt === null) {
    startRequestedAt = elapsed();
    if (!mountPlayer()) { startRequestedAt = null; return; }
    byId("start").textContent = "Apply settings"; byId("download").disabled = false; byId("resume").disabled = false;
    video.play().catch(() => { if (applyIsCurrent() && session === submittedSession && !playerHasPlayed && !mediaRecovery.snapshot().attempted) status("Press play on the video to begin."); });
  } else configure();
});
// Rebuild only after an explicit gesture. Safari's native Play can otherwise
// keep retrying the resource that failed or was suspended in the background.
byId("resume").addEventListener("click", () => {
  if (!session || startRequestedAt === null || accountActionPending || document.visibilityState !== "visible") return;
  suspensionGeneration++; needsViewerApply = true; stopSwarm();
  policyRenewal.resume(); mediaRecovery.cancel("viewer-resume");
  byId("upload").checked = false; byId("telemetry").checked = false;
  const generation = suspensionGeneration, resumedSession = session;
  const record = { attempt: player.resumeAttempts + 1, atMs: elapsed(), outcome: "requested" };
  player.resumeAttempts++; push(player.resumeRecords, record, 8);
  const current = () => generation === suspensionGeneration && session === resumedSession && document.visibilityState === "visible";
  byId("resume-status").textContent = "Reloading playback from origin. Apply settings to rejoin peers; uploading is off.";
  try {
    video.pause();
    const previousHls = hls; hls = undefined;
    previousHls?.destroy();
    native = false;
    if (!mountPlayer({ reloadNative: true })) throw new Error("Playback unsupported.");
    // Keep play() in this gesture's synchronous call stack; never auto-play on return.
    Promise.resolve(video.play()).then(() => {
      record.outcome = "play-request-resolved";
      record.superseded = !current();
      if (current()) byId("resume-status").textContent = "Origin playback requested. Apply settings to rejoin peers; uploading is off.";
    }, () => {
      record.outcome = "play-rejected";
      record.superseded = !current();
      if (current()) byId("resume-status").textContent = "The browser did not resume playback. Press Play, or use Resume playback to reload the stream again.";
    });
  } catch {
    record.outcome = "restart-failed";
    if (current()) byId("resume-status").textContent = "Playback could not be restarted. Use Resume playback to try again; download a receipt to retain the errors.";
  }
  render();
});

byId("reset-allowance")?.addEventListener("click", async () => {
  stopSwarm(); byId("upload").checked = false;
  await uploadBudget.reset(Number(byId("allowance").value));
  if (startRequestedAt !== null) configure(); render();
});
async function accountAction(action, reset = false) {
  if (mediaRecovery.active() || accountActionPending || document.visibilityState !== "visible") return;
  accountActionPending = true; byId("start").disabled = true;
  suspensionGeneration++; needsViewerApply = true; stopSwarm(); byId("upload").checked = false;
  const methods = action === "link" ? ["nostr", "website"] : [byId("account-method").value];
  try {
    const operation = accountBudget.ownerAction(action, methods, action === "settings" ? { limit: Number(byId("account-allowance").value), reset } : undefined);
    renderAccount(); await operation;
    status("Account allowance connected. Uploading is off; choose the checkbox and apply settings when ready.");
  } catch { status("Account allowance could not be confirmed. Uploading remains off. Usage may have changed; this page does not retry or refund it."); }
  finally {
    // A checkbox/Apply attempted during a signer prompt is not post-grant consent.
    suspensionGeneration++; needsViewerApply = true; stopSwarm(); byId("upload").checked = false;
    accountActionPending = false; byId("start").disabled = mediaRecovery.active() || !session;
  }
  renderAccount();
}
byId("account-connect").addEventListener("click", () => accountAction("grant"));
byId("account-disconnect").addEventListener("click", async () => {
  if (mediaRecovery.active() || accountActionPending || document.visibilityState !== "visible") return;
  accountActionPending = true; byId("start").disabled = true;
  let confirmed = false;
  try { const operation = accountBudget.disconnect(); renderAccount(); confirmed = await operation; }
  catch { /* Unknown server revocation never restores page authority. */ }
  finally {
    suspensionGeneration++; needsViewerApply = true; stopSwarm(); byId("upload").checked = false;
    accountActionPending = false; byId("start").disabled = mediaRecovery.active() || !session;
  }
  status(confirmed ? "Account disconnected and server grant revoked. Uploading is off." : "Account disconnected on this page. Server revocation was not confirmed; uploading is off.");
  renderAccount();
});
byId("account-link").addEventListener("click", () => accountAction("link"));
byId("account-settings").addEventListener("click", () => accountAction("settings"));
byId("account-reset").addEventListener("click", () => accountAction("settings", true));
byId("quality").addEventListener("change", () => { if (hls) { const level = Number(byId("quality").value); if (!playerHasPlayed) hls.loadLevel = level; else hls.nextLevel = level; } });
byId("kill").addEventListener("click", () => { if (mediaRecovery.active()) { mediaRecovery.cancel(); return; } byId("mode").value = "off"; configure(); });
byId("download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(report(), null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `relayswarm-field-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function suspendPeerAuthority() { suspensionGeneration++; needsViewerApply = true; accountBudget.suspend(); policyRenewal.suspend(); turnCredentials.suspend(); stopSwarm(); }
window.addEventListener("pagehide", () => { suspendPeerAuthority(); mediaRecovery.cancel("page-hidden"); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") { suspendPeerAuthority(); mediaRecovery.cancel("page-hidden"); } else policyRenewal.resume(); });
window.addEventListener("pageshow", () => { policyRenewal.resume(); if (startRequestedAt !== null && !swarm) { byId("kill").disabled = true; status("Peer delivery stopped while this page was inactive. Apply settings to rejoin."); byId("resume-status").textContent = "If playback stopped, use Resume playback to reload the stream from origin. Uploading remains off."; } });
window.relaySwarmDemo = { report, stop: () => { mediaRecovery.cancel(); stopSwarm(); render(); }, ready: () => Boolean(session), turnLeaseObservation: () => turnCredentials.leaseObservation(), media: video };
function reportingAvailability(available, message, switchedOff = false) {
  byId("telemetry").disabled = !available;
  if (!available) byId("telemetry").checked = false;
  byId("telemetry-label").textContent = available ? "Share numeric measurements with this server" : switchedOff ? "Reporting is switched off by this service" : "Numeric reporting is unavailable";
  byId("telemetry-status").textContent = message;
}
function policyUnavailableNow(reason, policy) {
  if (reason === "operator-off") {
    deliveryPolicy = { ...deliveryPolicy, ...policy }; policyUnavailable = false;
    byId("upload").checked = false;
    if (!policy.telemetry) reportingAvailability(false, "This service has reporting switched off. No numeric measurements will be sent.", true);
    if (swarm && activeConfig.mode !== "off") configure();
    byId("policy-status").textContent = "Operator delivery policy: origin only.";
    return;
  }
  policyUnavailable = true;
  byId("upload").checked = false;
  reportingAvailability(false, "Reporting is unavailable because the server policy could not be checked. No numeric measurements will be sent.");
  if (reason === "publisher-session-changed") { mediaRecovery.cancel(reason); admissionCredential = null; }
  if (swarm && activeConfig.mode !== "off") configure();
  byId("policy-status").textContent = "Delivery policy unavailable · using origin until it returns.";
}
const policyRenewal = createPolicyRenewal({
  async load({ signal, policy, invalidate }) {
    const base = session, credential = admissionCredential;
    const inline = base.deliveryPolicySession === "inline-v1";
    if (base.deliveryPolicySession !== undefined && !inline) { invalidate("invalid-session"); throw new Error("Unsupported policy session snapshot."); }
    const pair = new AbortController();
    const requestSignal = () => AbortSignal.any([signal, pair.signal, AbortSignal.timeout(5000)]);
    // Legacy reads stay parallel/no-store. Negotiated inline snapshots need
    // only the policy request; never downgrade a malformed advertised snapshot.
    const nextPolicy = fetchDiagnostics.json("policy", base.deliveryPolicyEndpoint || "/delivery-policy.json", { cache: "no-store", signal: requestSignal() });
    const sessionResult = inline ? null : fetchDiagnostics.json("session", "/session.json", { cache: "no-store", signal: requestSignal() }).then(
      current => ({ ok: true, current }), error => ({ ok: false, error }));
    try {
      const next = await nextPolicy;
      if (!policy(next)) return null;
      if (!next.telemetry) reportingAvailability(false, "This service has reporting switched off. No numeric measurements will be sent.", true);
      const result = inline ? { ok: true, current: next.session } : await sessionResult;
      if (!result.ok) throw result.error;
      const current = result.current;
      if (current?.v !== 1 || typeof current.swarmId !== "string" || !current.streamEvent || typeof current.streamEvent.id !== "string" || !Array.isArray(current.relays) || !["all", "relay"].includes(iceTransportPolicy(current)) || current.manifest !== base.manifest
        || current.deliveryPolicySession !== undefined && current.deliveryPolicySession !== "inline-v1" || inline && current.deliveryPolicySession !== "inline-v1") {
        invalidate("invalid-session"); throw new Error("Publisher session changed incompatibly.");
      }
      try { turnDescriptor(current); }
      catch { invalidate("invalid-session"); throw new Error("Publisher session changed incompatibly."); }
      const identityChanged = !sameIdentity(current, base);
      if (identityChanged) invalidate("publisher-session-changed");
      const renewAdmission = Boolean(current.admission && startRequestedAt !== null && byId("mode").value !== "off" && next.mode !== "off" && (identityChanged || !credential || credential.expiresAt * 1000 - Date.now() <= 20000));
      const candidateCredential = renewAdmission ? await obtainAdmission(current, identityChanged ? null : credential, signal) : identityChanged ? null : credential;
      const nextPolicySnapshot = inline ? { v: next.v, mode: next.mode, revision: next.revision, telemetry: next.telemetry } : next;
      return { base, next: nextPolicySnapshot, current, candidateCredential, priorCredential: credential, renewAdmission };
    } finally {
      pair.abort();
      await sessionResult;
    }
  },
  eligible: ({ base, current }) => sameIdentity(base, session) || sameIdentity(current, session),
  commit({ next, current, candidateCredential, priorCredential, renewAdmission }) {
    const keepOriginOnly = Boolean(swarm && activeConfig.mode === "off" && session.swarmId === current.swarmId && session.streamEvent.id === current.streamEvent.id && session.streamEvent.pubkey === current.streamEvent.pubkey && session.manifest === current.manifest);
    const identityChanged = !sameIdentity(current, session);
    const configurationChanged = !samePeerConfiguration(current, session);
    const transportPolicyChanged = iceTransportPolicy(current) !== iceTransportPolicy(session);
    const projectionChanged = turnDescriptor(current)?.urlProjection !== turnDescriptor(session)?.urlProjection;
    const changed = policyUnavailable || next.mode !== deliveryPolicy.mode || identityChanged || configurationChanged;
    accountBudget.configure(current.accountBudget);
    if (transportPolicyChanged || projectionChanged) { suspensionGeneration++; needsViewerApply = true; stopSwarm(); byId("upload").checked = false; }
    if (identityChanged) { mediaRecovery.cancel("publisher-session-changed"); stopSwarm(); }
    if (identityChanged || configurationChanged) session = current;
    turnCredentials.configure(current.turnCredentials, turnIdentity(current));
    const credentialInstalled = identityChanged || admissionCredential === priorCredential;
    if (credentialInstalled) admissionCredential = candidateCredential;
    deliveryPolicy = next; policyUnavailable = false;
    if (next.mode === "off") byId("upload").checked = false;
    reportingAvailability(next.telemetry, next.telemetry ? "Reporting is available. Tick the checkbox to share measurements." : "This service has reporting switched off. No numeric measurements will be sent.", !next.telemetry);
    // Revocation still requires Apply for peers; an existing origin player can retain a real off configuration.
    if (changed && (swarm || startRequestedAt !== null && (!needsViewerApply || keepOriginOnly))) configure();
    else if (renewAdmission && credentialInstalled && swarm && !needsViewerApply) {
      if (!peerAuthorityFresh(session)) throw new Error("Peer admission renewal unavailable.");
      // A disabled peer implementation is a supported origin fallback. It has
      // no live peers to preserve and rejects in-place credential updates.
      if (swarm.metrics().mode === "off") configure();
      else if (!swarm.updateTicket(admissionCredential.ticket)) throw new Error("Peer admission renewal unavailable.");
    }
    byId("policy-status").textContent = next.mode === null ? "Viewer chooses delivery mode." : `Operator delivery policy: ${next.mode === "off" ? "origin only" : next.mode}.`;
  },
  revoke: policyUnavailableNow,
});
async function refreshPolicy() {
  if (!session) return false;
  const result = await policyRenewal.renew();
  if (result && document.visibilityState === "visible") await accountBudget.maintain();
  renderAccount(); return result;
}
async function sendReport() {
  if (!policyRenewal.fresh() || !byId("telemetry").checked || !deliveryPolicy.telemetry || startRequestedAt === null) return;
  const total = totals();
  const values = { durationMs: elapsed(), peerBytes: total.peerFirstBytes, uploadedBytes: total.uploaded, originMediaRequests: network.originMediaRequests, originMediaBytes: network.encodedOriginMediaBytes, stalls: player.stalls, stallMs: Math.round(player.stallMs), fatalErrors: player.fatalErrors };
  try { await fetchDiagnostics.json("report", "/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ v: 1, reportId, sequence: ++reportSequence, values }) }); } catch { /* Playback does not depend on reporting. */ }
}
setInterval(refreshPolicy, 2000);
setInterval(sendReport, 15000);
setInterval(render, 1000);
setInterval(() => { if (swarm) push(snapshots, { atMs: elapsed(), metrics: swarm.metrics() }, 60); }, 5000);
try {
  session = await fetchDiagnostics.json("session", "/session.json", { cache: "no-store" });
  if (!["all", "relay"].includes(iceTransportPolicy(session))) throw new Error("Invalid ICE transport policy.");
  turnDescriptor(session);
  accountBudget.configure(session.accountBudget); turnCredentials.configure(session.turnCredentials, turnIdentity(session)); byId("allowance").value = String(uploadBudget.snapshot().limit); await refreshPolicy(); byId("start").disabled = false;
  status(isSecureContext ? "Ready · choose a delivery mode and start playback." : "This address needs HTTPS for peer delivery. Origin playback is available.");
} catch { status("The publisher is unavailable. Reload after it has started."); }
