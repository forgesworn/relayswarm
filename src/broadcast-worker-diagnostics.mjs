// Fixed failure vocabulary only: messages, paths and unknown values stay private.
const stages = new Set([
  'unobserved', 'unknown', 'lease-acquire', 'marker-check', 'marker-create',
  'marker-write', 'marker-sync', 'marker-close', 'startup-directory-open',
  'startup-directory-sync', 'startup-directory-close', 'worker-group-kill',
  'worker-group-probe', 'worker-group-timeout', 'worker-close-notify', 'stop-worker-term',
  'stop-worker-kill', 'stop-await-workers', 'marker-remove',
  'stop-directory-open', 'stop-directory-sync', 'stop-directory-close',
  'lease-close', 'stopped-send', 'stop-disconnect', 'stop-unknown',
]);
const reasons = new Set([
  'unknown', 'ENOENT', 'EACCES', 'EPERM', 'ESRCH', 'EBADF', 'EIO',
  'EINVAL', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_SQLITE_ERROR',
]);

export function safeWorkerFailure(stage, reason) {
  return Object.freeze({
    stage: typeof stage === 'string' && stages.has(stage) ? stage : 'unknown',
    reason: typeof reason === 'string' && reasons.has(reason) ? reason : 'unknown',
  });
}

export function workerFailureReason(error) {
  try { return safeWorkerFailure('unknown', error?.code).reason; }
  catch { return 'unknown'; }
}
