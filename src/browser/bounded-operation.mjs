// Give each host operation its own cancellation signal. Expiry must cancel the
// underlying I/O as well as the caller's wait, without stopping other operations.
export function boundedOperation(operation, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false, timer;
    const finish = (ok, value, abort = false, reason = value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (abort) controller.abort(reason);
      if (ok) resolve(value); else reject(value);
    };
    const cancel = () => finish(false, new Error("Operation cancelled."), true, signal.reason);
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => finish(false, new Error("Operation cancelled or timed out."), true), timeoutMs);
    Promise.resolve().then(() => {
      if (!settled) return operation(controller.signal);
    }).then((value) => finish(true, value), (error) => finish(false, error));
  });
}
