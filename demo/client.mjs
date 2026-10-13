import Hls from "hls.js";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { createPersistentUploadBudget } from "./upload-budget.mjs";
import { createMediaRecovery } from "./media-recovery.mjs";
import { segmentMediaContext } from "../src/browser/segment-commitment.mjs";
import { createHlsSwarm } from "../src/browser/hls-swarm.mjs";
import { createFetchDiagnostics } from "./fetch-diagnostics.mjs";
import { createPolicyRenewal } from "./policy-renewal.mjs";

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
const player = { engine: "pending", firstPlayingAtMs: null, startupMs: null, stalls: 0, stallMs: 0, seeks: 0, seekRecoveryMs: [], fatalErrors: 0, errors: {}, fragmentsLoaded: 0, fragments: [], levelChanges: [], errorRecords: [], nativeErrors: [] };
const network = { originMediaRequests: 0, encodedOriginMediaBytes: 0, transferOriginMediaBytes: 0 };
const sessions = [], snapshots = [];
let deliveryPolicy = { mode: null, revision: 0, telemetry: false }, policyUnavailable = true;
const archivedTotals = { peerFirstBytes: 0, uploaded: 0, peerFirstLoads: 0, sessions: 0 };
let session, hls, swarm, initialLoader, startRequestedAt = null, stallAt = null, seekAt = null, native = false, activeConfig, needsViewerApply = false, suspensionGeneration = 0;
const status = (message) => { byId("status").textContent = message; };
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
  if (mediaRecovery.active()) return;
  policyRenewal.fresh();
  stopSwarm();
  const configuredSession = session, configuredCredential = admissionCredential;
  const chosenMode = byId("mode").value;
  const requestedMode = native || policyUnavailable || needsViewerApply || chosenMode === "off" ? "off" : deliveryPolicy.mode ?? chosenMode;
  const mode = session.admission && !admissionCredential ? "off" : requestedMode;
  const budget = uploadBudget.snapshot(), allowance = budget.limit, remaining = budget.remaining;
  const admissionReady = !session.admission || admissionCredential && admissionCredential.epoch === session.admission.epoch && admissionCredential.expiresAt * 1000 > Date.now();
  activeConfig = { mode, upload: byId("upload").checked && mode !== "off" && budget.available && remaining > 0 && admissionReady, uploadAllowance: allowance, uploadLimit: Number(byId("limit").value), cellular: byId("cellular").checked, startedAtMs: elapsed() };
  swarm = createHlsSwarm({ mode, swarmId: session.swarmId, relays: session.relays, streamEvent: session.streamEvent, delegation: session.delegation, revokedDelegationIds: session.revokedDelegationIds, delegationRevocations: session.delegationRevocations, swarmParts: session.mediaCapabilities?.parts === true, originReserveMs: session.mediaCapabilities?.parts === true ? 500 : 2000,
    getCommitment: async (context, { signal }) => {
      const query = new URLSearchParams({ path: new URL(context.url).pathname, level: String(context.frag.level), sequence: String(context.frag.sn), cc: String(context.frag.cc ?? 0) });
      const mediaContext = segmentMediaContext(context);
      if (mediaContext) { query.set("playlist", mediaContext.playlist); query.set("mediaType", mediaContext.mediaType); }
      if (context.rangeEnd) { query.set("start", String(context.rangeStart || 0)); query.set("end", String(context.rangeEnd)); }
      if (context.part) query.set("part", String(context.part.index));
      return fetchDiagnostics.json("commitment", `${session.commitmentEndpoint}?${query}`, { signal });
    },
    secretKey: admissionKey,
    ...(configuredSession.admission && configuredCredential ? { ticket: configuredCredential.ticket, admit: async (pubkey, ticket, { signal }) => {
      try {
        if (session !== configuredSession || !policyRenewal.fresh()) return false;
        const result = await fetchDiagnostics.json("admissionVerify", configuredSession.admission.verifyEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pubkey, ticket }), signal });
        return session === configuredSession && !signal.aborted && policyRenewal.fresh() && result.admitted === true && result.epoch === configuredSession.admission.epoch;
      } catch { return false; }
    } } : {}),
    reserveUploadBytes: async (amount, options) => policyRenewal.fresh() && await uploadBudget.reserve(amount, options) && policyRenewal.fresh(),
    serve: activeConfig.upload, maxUploadBytesPerSession: remaining, maxUploadBytesPerSecond: activeConfig.uploadLimit, serveOnCellular: activeConfig.cellular,
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
  const budget = uploadBudget.snapshot();
  byId("uploaded").textContent = bytes(budget.spent);
  const allowance = budget.limit;
  byId("allowance-meter").max = allowance; byId("allowance-meter").value = Math.min(budget.spent, allowance);
  byId("allowance-used").textContent = `${bytes(budget.spent)} of ${bytes(allowance)} reserved in this browser${!budget.available ? " · persistent allowance unavailable; uploading disabled" : budget.spent >= allowance ? " · allowance exhausted; uploading stopped" : ""}`;
  byId("peers").textContent = String(metrics?.peers.connected || 0);
  byId("detail").textContent = `${total.peerFirstLoads} verified peer-first loads · ${player.stalls} playback stalls · ${player.fragmentsLoaded} media fragments loaded`;
}
function report() {
  policyRenewal.fresh();
  return { v: 1, kind: "relayswarm-field-receipt", startedAt, recordedAt: new Date().toISOString(), durationMs: elapsed(),
    environment: { browser: navigator.userAgent, secureContext: isSecureContext, networkLabel: byId("network").value, deviceLabel: byId("device").value, automated: navigator.webdriver === true },
    stream: { eventId: session?.streamEvent.id, publisher: session?.streamEvent.pubkey, swarmId: session?.swarmId, experimental: true },
    player: { ...player, mediaRecovery: mediaRecovery.snapshot(), isLive: hls?.latestLevelDetails?.live === true, liveLatencySeconds: Number.isFinite(hls?.latency) ? hls.latency : null, targetLatencySeconds: Number.isFinite(hls?.targetLatency) ? hls.targetLatency : null, liveSyncPosition: Number.isFinite(hls?.liveSyncPosition) ? hls.liveSyncPosition : null, currentTime: video.currentTime, paused: video.paused, bufferedSeconds: hls?.mainForwardBufferInfo?.len ?? null, activeStallMs: stallAt === null ? 0 : elapsed() - stallAt },
    network: { ...network, ...(native ? { originMediaRequests: null, encodedOriginMediaBytes: null, transferOriginMediaBytes: null } : {}), supported: Boolean(observer) && !native,
      scope: "same-origin media resource timings; includes init segments and cache hits; encoded bytes exclude protocol overhead; native HLS requests are not measured" },
    totals: totals(), uploadBudget: uploadBudget.snapshot(), deliveryPolicy: { ...deliveryPolicy, unavailable: policyUnavailable }, current: swarm ? { ...activeConfig, metrics: swarm.metrics() } : null, sessions: [...sessions], snapshots: [...snapshots],
    retention: { fragments: "latest 256", snapshots: "latest 60, every five seconds", sessions: "latest 64", archivedSessions: archivedTotals.sessions, totals: "whole page session" },
    loaderRestored: !hls || hls.config.fLoader === initialLoader, controlTimings: fetchDiagnostics.snapshot(), policyRenewal: policyRenewal.snapshot(), limits: ["Network and device labels are supplied by the viewer.", "No peer IP addresses or private signing keys are recorded.", "A receipt is evidence for this session only; it is not a production-readiness claim."],
  };
}

function sameIdentity(a, b) {
  return a?.swarmId === b?.swarmId && a?.streamEvent?.id === b?.streamEvent?.id && a?.admission?.epoch === b?.admission?.epoch && a?.admission?.issuer === b?.admission?.issuer;
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
byId("settings").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session || mediaRecovery.active() || document.visibilityState !== "visible") return;
  byId("start").disabled = true;
  const submittedSession = session, priorCredential = admissionCredential;
  const submittedGeneration = suspensionGeneration;
  const applyIsCurrent = () => submittedGeneration === suspensionGeneration && document.visibilityState === "visible";
  try {
    await uploadBudget.setLimit(Number(byId("allowance").value));
    if (!applyIsCurrent()) return;
    if (byId("mode").value !== "off" && policyRenewal.fresh() && deliveryPolicy.mode !== "off") {
      const credential = await obtainAdmission(submittedSession, priorCredential);
      if (applyIsCurrent() && session === submittedSession && admissionCredential === priorCredential && policyRenewal.fresh()) admissionCredential = credential;
    }
  } catch { if (applyIsCurrent() && session === submittedSession && admissionCredential === priorCredential) { admissionCredential = null; status("Peer admission unavailable · origin playback remains available."); } }
  finally { byId("start").disabled = mediaRecovery.active(); }
  if (mediaRecovery.active() || !applyIsCurrent()) return;
  needsViewerApply = false;
  if (startRequestedAt === null) {
    startRequestedAt = elapsed();
    if (Hls.isSupported()) {
      player.engine = `hls.js ${Hls.version}`;
      hls = new Hls({ ...(session.mediaCapabilities?.parts === true ? {} : { liveSyncDurationCount: 4 }), maxBufferLength: 20, maxMaxBufferLength: 30 });
      initialLoader = hls.config.fLoader;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hls.levels.forEach((level, index) => { const option = document.createElement("option"); option.value = String(index); option.textContent = `${level.height}p · ${Math.round(level.bitrate / 1000)} kbps`; byId("quality").append(option); });
        byId("quality").disabled = false;
      });
      hls.on(Hls.Events.FRAG_LOADED, (_event, { frag, part, payload, networkDetails }) => {
        if (frag.sn === "initSegment") return;
        player.fragmentsLoaded++;
        push(player.fragments, { atMs: elapsed(), level: frag.level, sequence: frag.sn, part: part?.index ?? null, mediaType: frag.type ?? "video", playlist: segmentMediaContext({ frag, url: frag.url })?.playlist ?? null, discontinuity: frag.cc, rangeStart: frag.byteRangeStartOffset ?? null, rangeEnd: frag.byteRangeEndOffset ?? null, size: payload.byteLength,
          source: networkDetails ? "origin" : activeConfig.mode === "peer-first" ? "peer" : "unknown", statsLoaded: frag.stats.loaded,
          loadingMs: frag.stats.loading.end - frag.stats.loading.start });
        render();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => push(player.levelChanges, { atMs: elapsed(), level: data.level }));
      hls.on(Hls.Events.LEVEL_UPDATED, (_event, { details }) => mediaRecovery.observeLive(details, {
        lastFragmentCC: player.fragments.at(-1)?.discontinuity, fatalErrors: player.fatalErrors,
      }));
      hls.on(Hls.Events.ERROR, (_event, data) => {
        push(player.errorRecords, { atMs: elapsed(), details: data.details, fatal: Boolean(data.fatal), type: data.type, reason: String(data.reason ?? "").slice(0, 512), message: String(data.error?.message ?? "").slice(0, 512), nativeError: video.error && { code: video.error.code, message: video.error.message.slice(0, 512) }, mediaType: data.frag?.type ?? null, playlist: data.frag ? segmentMediaContext({ frag: data.frag, url: data.frag.url })?.playlist ?? null : null }, 64);
        player.errors[data.details] = (player.errors[data.details] || 0) + 1;
        if (data.fatal) { player.fatalErrors++; if (!mediaRecovery.handle(data)) status("Playback stopped after a fatal error. Download a receipt to retain the measurements."); }
      });
      configure();
      hls.loadSource(session.manifest); hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      native = true; player.engine = "native HLS"; byId("mode").value = "off"; byId("mode").disabled = true; byId("upload").disabled = true; configure(); video.src = session.manifest;
    } else { player.engine = "unsupported"; status("This browser cannot play the test stream."); startRequestedAt = null; return; }
    byId("start").textContent = "Apply settings"; byId("download").disabled = false;
    video.play().catch(() => { if (!mediaRecovery.snapshot().attempted) status("Press play on the video to begin."); });
  } else configure();
});
byId("reset-allowance")?.addEventListener("click", async () => {
  stopSwarm(); byId("upload").checked = false;
  await uploadBudget.reset(Number(byId("allowance").value));
  if (startRequestedAt !== null) configure(); render();
});
byId("quality").addEventListener("change", () => { if (hls) { const level = Number(byId("quality").value); if (player.firstPlayingAtMs === null) hls.loadLevel = level; else hls.nextLevel = level; } });
byId("kill").addEventListener("click", () => { if (mediaRecovery.active()) { mediaRecovery.cancel(); return; } byId("mode").value = "off"; configure(); });
byId("download").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(report(), null, 2)}\n`], { type: "application/json" }));
  const link = document.createElement("a"); link.href = url; link.download = `relayswarm-field-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function suspendPeerAuthority() { suspensionGeneration++; needsViewerApply = true; policyRenewal.suspend(); stopSwarm(); }
window.addEventListener("pagehide", () => { suspendPeerAuthority(); mediaRecovery.cancel("page-hidden"); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") suspendPeerAuthority(); else policyRenewal.resume(); });
window.addEventListener("pageshow", () => { policyRenewal.resume(); if (startRequestedAt !== null && !swarm) { byId("kill").disabled = true; status("Peer delivery stopped while this page was inactive. Playback uses origin; apply settings to rejoin."); } });
window.relaySwarmDemo = { report, stop: () => { mediaRecovery.cancel(); stopSwarm(); render(); }, ready: () => Boolean(session), media: video };
function policyUnavailableNow(reason, policy) {
  if (reason === "operator-off") {
    deliveryPolicy = { ...deliveryPolicy, ...policy }; policyUnavailable = false;
    byId("upload").checked = false;
    if (!policy.telemetry) { byId("telemetry").checked = false; byId("telemetry").disabled = true; }
    if (swarm && activeConfig.mode !== "off") configure();
    byId("policy-status").textContent = "Operator delivery policy: origin only.";
    return;
  }
  policyUnavailable = true;
  byId("upload").checked = false;
  byId("telemetry").disabled = true;
  byId("telemetry-status").textContent = "Reporting is unavailable because the server policy could not be checked.";
  byId("telemetry").checked = false;
  if (reason === "publisher-session-changed") { mediaRecovery.cancel(reason); admissionCredential = null; }
  if (swarm && activeConfig.mode !== "off") configure();
  byId("policy-status").textContent = "Delivery policy unavailable · using origin until it returns.";
}
const policyRenewal = createPolicyRenewal({
  async load({ signal, policy, invalidate }) {
    const base = session, credential = admissionCredential;
    const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    // Same-URL cache locking can queue a renewal behind a stuck earlier check,
    // even before the server's no-store response headers have arrived.
    const next = await fetchDiagnostics.json("policy", base.deliveryPolicyEndpoint || "/delivery-policy.json", { cache: "no-store", signal: requestSignal() });
    if (!policy(next)) return null;
    const current = await fetchDiagnostics.json("session", "/session.json", { cache: "no-store", signal: requestSignal() });
    if (current?.v !== 1 || typeof current.swarmId !== "string" || !current.streamEvent || typeof current.streamEvent.id !== "string" || !Array.isArray(current.relays) || current.manifest !== base.manifest) {
      invalidate("invalid-session"); throw new Error("Publisher session changed incompatibly.");
    }
    const identityChanged = !sameIdentity(current, base);
    if (identityChanged) invalidate("publisher-session-changed");
    const renewAdmission = Boolean(current.admission && startRequestedAt !== null && byId("mode").value !== "off" && next.mode !== "off" && (identityChanged || !credential || credential.expiresAt * 1000 - Date.now() <= 20000));
    const candidateCredential = renewAdmission ? await obtainAdmission(current, identityChanged ? null : credential, signal) : identityChanged ? null : credential;
    return { base, next, current, candidateCredential, priorCredential: credential, renewAdmission };
  },
  eligible: ({ base, current }) => sameIdentity(base, session) || sameIdentity(current, session),
  commit({ next, current, candidateCredential, priorCredential, renewAdmission }) {
    const identityChanged = !sameIdentity(current, session);
    const changed = policyUnavailable || next.mode !== deliveryPolicy.mode || identityChanged;
    if (identityChanged) { mediaRecovery.cancel("publisher-session-changed"); stopSwarm(); session = current; }
    if (identityChanged || admissionCredential === priorCredential) admissionCredential = candidateCredential;
    deliveryPolicy = next; policyUnavailable = false;
    if (next.mode === "off") byId("upload").checked = false;
    byId("telemetry").disabled = !next.telemetry;
    byId("telemetry-status").textContent = next.telemetry ? "Reporting is available. Tick the checkbox to share measurements." : "Reporting is switched off on this server. The checkbox is unavailable.";
    if (!next.telemetry) byId("telemetry").checked = false;
    if ((changed || renewAdmission) && (swarm || startRequestedAt !== null && !needsViewerApply)) configure();
    byId("policy-status").textContent = next.mode === null ? "Viewer chooses delivery mode." : `Operator delivery policy: ${next.mode === "off" ? "origin only" : next.mode}.`;
  },
  revoke: policyUnavailableNow,
});
function refreshPolicy() { return session ? policyRenewal.renew() : Promise.resolve(false); }
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
  session = await fetchDiagnostics.json("session", "/session.json", { cache: "no-store" }); byId("allowance").value = String(uploadBudget.snapshot().limit); await refreshPolicy(); byId("start").disabled = false;
  status(isSecureContext ? "Ready · choose a delivery mode and start playback." : "This address needs HTTPS for peer delivery. Origin playback is available.");
} catch { status("The publisher is unavailable. Reload after it has started."); }
