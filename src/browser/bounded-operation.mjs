// Bound asynchronous host callbacks without keeping listeners or timers alive
// after completion. The host receives the same signal to cancel its own I/O.
export function boundedOperation(operation, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fail = () => finish(new Error("Operation cancelled or timed out."));
    const timer = setTimeout(fail, timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", fail);
      if (error) reject(error);
      else resolve(value);
    };
    if (signal?.aborted) return fail();
    signal?.addEventListener("abort", fail, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw new Error("Operation cancelled.");
      return operation();
    }).then((value) => finish(null, value), finish);
  });
}
