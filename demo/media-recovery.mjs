// One repair attempt per page viewing session. The caller retains every fatal
// error: a successful repair is a separate measurement, not an erased failure.
export function createMediaRecovery({ media, getHls, getSession, revokeContribution, status, now = () => performance.now() }) {
  const state = { attempted: 0, outcome: "idle", records: [] };
  let pending = null;
  let liveObservation = null;
  function finish(outcome, reason) {
    if (!pending) return;
    const attempt = pending; pending = null;
    clearInterval(attempt.timer); clearTimeout(attempt.deadline);
    Object.assign(attempt.record, { outcome, reason, endedAtMs: now() }); state.outcome = outcome;
    if (outcome !== "recovered") {
      attempt.hls.stopLoad(); if (getHls() === attempt.hls) media.pause();
      status(outcome === "cancelled" ? "Playback recovery cancelled · uploading is off." : "Playback recovery failed. Reload to try again; download a receipt to retain the failure.");
    } else status("Playback recovered using origin only · uploading is off. Original errors remain in the receipt.");
  }
  function cancel(reason = "viewer-cancelled") { finish("cancelled", reason); }
  function handle(error) {
    if (!error.fatal) return false;
    if (state.attempted) {
      if (pending) finish("failed", "another-fatal-error");
      else { state.outcome = "failed"; getHls()?.stopLoad(); media.pause(); status("Playback stopped after another fatal error. Automatic recovery is exhausted; download a receipt."); }
      return true;
    }
    // hls.js 1.7 reclassifies append errors on ended/closed MediaSource objects
    // as mediaSourceRequiresReset. Its own retries still run before this fatal.
    if (error.type !== "mediaError" || !["bufferAppendError", "mediaSourceRequiresReset"].includes(error.details)) return false;
    return begin(error);
  }
  function begin(error, liveRestart = false) {
    const hls = getHls(), session = getSession();
    if (!hls || !session || state.attempted) return false;
    const live = hls.latestLevelDetails?.live === true;
    const position = live ? (Number.isFinite(hls.liveSyncPosition) ? hls.liveSyncPosition : -1) : media.currentTime;
    const record = { attemptedAtMs: now(), outcome: "queued", live, requestedPosition: position, details: error.details,
      ...(liveRestart ? { kind: "live-window-stall", fromCC: error.fromCC, toCC: error.toCC, stalledForMs: error.stalledForMs } : {}) };
    state.attempted = 1; state.outcome = "queued"; state.records.push(record);
    const attempt = { hls, session, record, timer: null, deadline: null }; pending = attempt;
    revokeContribution();
    status("Repairing playback using origin only · uploading is off. Use Stop recovery to cancel.");
    // hls.js completes fatal-error dispatch by stopping loading. Run afterwards
    // and explicitly restart: recoverMediaError alone retains that stopped state.
    queueMicrotask(() => {
      if (pending !== attempt) return;
      if (getHls() !== hls || getSession() !== session) { finish("cancelled", "player-or-session-changed"); return; }
      let baseline = position >= 0 ? position : null;
      const framesBefore = media.getVideoPlaybackQuality?.().totalVideoFrames ?? media.webkitDecodedFrameCount;
      state.outcome = record.outcome = "recovering";
      attempt.deadline = setTimeout(() => finish("failed", "progress-timeout"), 10000);
      attempt.timer = setInterval(() => {
        if (getHls() !== hls || getSession() !== session) { finish("cancelled", "player-or-session-changed"); return; }
        if (baseline === null && media.readyState >= 2) baseline = media.currentTime;
        const framesNow = media.getVideoPlaybackQuality?.().totalVideoFrames ?? media.webkitDecodedFrameCount;
        if (!media.error && !media.paused && media.readyState >= 2 && baseline !== null && media.currentTime > baseline + 0.25
          && (!liveRestart || framesNow > framesBefore)) finish("recovered", "playback-advanced");
      }, 200);
      try {
        if (liveRestart) hls.stopLoad();
        else hls.recoverMediaError();
        if (pending !== attempt) return;
        hls.startLoad(position);
        if (pending !== attempt) return;
        Promise.resolve(media.play()).catch(() => { if (pending === attempt) finish("failed", "play-rejected"); });
      } catch { finish("failed", "recovery-exception"); }
    });
    return true;
  }
  // Observe successful live playlist updates, not elapsed network retries. A
  // vanished continuity range can strand hls.js with its old previous fragment
  // even while fresh playlists keep arriving. Share the existing single repair
  // budget with fatal MSE recovery; neither path grants another automatic try.
  function observeLive(details, { lastFragmentCC, fatalErrors = 0 } = {}) {
    if (state.attempted || pending) return false;
    const hls = getHls(), session = getSession(), at = now();
    const frames = media.getVideoPlaybackQuality?.().totalVideoFrames ?? media.webkitDecodedFrameCount;
    if (!hls || !session || !details?.live || !Number.isFinite(frames) || frames <= 0) return false;
    if (!liveObservation || liveObservation.hls !== hls || liveObservation.session !== session) {
      liveObservation = { hls, session, frames, time: media.currentTime, progressAt: at, endSN: details.endSN, advancedAt: at };
      return false;
    }
    const observation = liveObservation;
    if (frames !== observation.frames || Math.abs(media.currentTime - observation.time) > 0.1 || media.paused || media.seeking) {
      Object.assign(observation, { frames, time: media.currentTime, progressAt: at });
    }
    if (details.endSN > observation.endSN) { observation.endSN = details.endSN; observation.advancedAt = at; }
    const position = hls.liveSyncPosition;
    let forward = 0;
    for (let i = 0; i < media.buffered.length; i++) {
      if (media.buffered.start(i) <= media.currentTime && media.buffered.end(i) >= media.currentTime) forward = media.buffered.end(i) - media.currentTime;
    }
    if (fatalErrors || media.error || media.paused || media.seeking || media.readyState >= 3 || forward > 0.25 || hls.loadingEnabled === false
      || at - observation.progressAt < 10000 || at - observation.advancedAt > 5000
      || !Number.isFinite(lastFragmentCC) || !(details.startCC > lastFragmentCC)
      || !(media.currentTime < details.fragmentStart - 0.25) || !Number.isFinite(position)
      || position < details.fragmentStart || position >= details.edge) return false;
    return begin({ details: "liveWindowStall", fromCC: lastFragmentCC, toCC: details.startCC, stalledForMs: at - observation.progressAt }, true);
  }
  return { handle, observeLive, cancel, active: () => pending !== null, snapshot: () => ({ ...state, records: state.records.map((record) => ({ ...record })) }) };
}
