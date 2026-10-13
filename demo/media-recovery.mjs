// One repair attempt per page viewing session. The caller retains every fatal
// error: a successful repair is a separate measurement, not an erased failure.
export function createMediaRecovery({ media, getHls, getSession, revokeContribution, status, now = () => performance.now() }) {
  const state = { attempted: 0, outcome: "idle", records: [] };
  let pending = null;
  function finish(outcome, reason) {
    if (!pending) return;
    const attempt = pending; pending = null;
    clearInterval(attempt.timer); clearTimeout(attempt.deadline);
    Object.assign(attempt.record, { outcome, reason, endedAtMs: now() }); state.outcome = outcome;
    if (outcome !== "recovered") {
      attempt.hls.stopLoad(); if (getHls() === attempt.hls) media.pause();
      status(outcome === "cancelled" ? "Playback recovery cancelled · uploading is off." : "Playback stopped after a media error. Reload to try again; download a receipt to retain the failure.");
    } else status("Playback recovered using origin only · uploading is off. The fatal error remains in the receipt.");
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
    const hls = getHls(), session = getSession();
    if (!hls || !session) return false;
    const live = hls.latestLevelDetails?.live === true;
    const position = live ? (Number.isFinite(hls.liveSyncPosition) ? hls.liveSyncPosition : -1) : media.currentTime;
    const record = { attemptedAtMs: now(), outcome: "queued", live, requestedPosition: position, details: error.details };
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
      state.outcome = record.outcome = "recovering";
      attempt.deadline = setTimeout(() => finish("failed", "progress-timeout"), 10000);
      attempt.timer = setInterval(() => {
        if (getHls() !== hls || getSession() !== session) { finish("cancelled", "player-or-session-changed"); return; }
        if (baseline === null && media.readyState >= 2) baseline = media.currentTime;
        if (!media.error && !media.paused && media.readyState >= 2 && baseline !== null && media.currentTime > baseline + 0.25) finish("recovered", "playback-advanced");
      }, 200);
      try {
        hls.recoverMediaError();
        if (pending !== attempt) return;
        hls.startLoad(position);
        if (pending !== attempt) return;
        Promise.resolve(media.play()).catch(() => { if (pending === attempt) finish("failed", "play-rejected"); });
      } catch { finish("failed", "recovery-exception"); }
    });
    return true;
  }
  return { handle, cancel, active: () => pending !== null, snapshot: () => ({ ...state, records: state.records.map((record) => ({ ...record })) }) };
}
