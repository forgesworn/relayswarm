// Established live rendition playlists may outlast hls.js's short default
// retry sequence during a publisher restart. This never retries a fatal error
// or changes manifest, fragment, key or request-timeout policies.
export function createLivePlaylistRetry({ loadPolicy, Loader, ErrorController, errorEvent, current, live, now = () => performance.now() }) {
  const original = loadPolicy.default.errorRetry;
  if (!original || original.shouldRetry) return { loadPolicy, Loader, ErrorController, loaded() {} };
  // Count eligible 5xx failures/retry decisions, not ordinary user-initiated
  // quality changes or successful refreshes. Normal failures consume this too.
  const maximumMs = 60000, maximumFailures = 32;
  let episode = null, failingFrame = null;
  const established = () => { try { return live() === true; } catch { return false; } };
  const active = () => { try { return current() === true && established(); } catch { return false; } };
  function within(value) {
    const at = now();
    return value === episode && !value.closed && Number.isFinite(at) && at >= value.started && at < value.end && active();
  }
  const errorRetry = { ...original, maxNumRetry: maximumFailures,
    shouldRetry(config, count, timeout, response, allowed) {
      const ordinary = count < original.maxNumRetry && allowed;
      const frame = failingFrame;
      const refuse = () => { frame.maximum = count; return false; };
      if (frame?.terminal) return refuse();
      if (timeout || frame?.context.type !== "level" || ![502, 503, 504].includes(response?.code) || !established()) return ordinary;
      if (!active()) { if (episode) { episode.closed = true; return refuse(); } return ordinary; }
      const at = now();
      if (!Number.isFinite(at)) return refuse();
      episode ??= { started: at, end: at + maximumMs, failures: 0, extended: false, closed: false };
      const delay = Math.min((original.backoff === "linear" ? 1 : 2 ** count) * original.retryDelayMs, original.maxRetryDelayMs);
      if (!within(episode) || ++episode.failures >= maximumFailures || at + delay >= episode.end) {
        episode.closed = true; return refuse();
      }
      if (!ordinary || episode.failures > original.maxNumRetry) episode.extended = true;
      frame.maximum = maximumFailures;
      return true;
    },
  };
  function errorFrame(context, terminal, callback) {
    const previous = failingFrame; failingFrame = { context, terminal, maximum: original.maxNumRetry };
    try { return callback(); } finally { failingFrame = previous; }
  }
  class PlaylistErrorController extends ErrorController {
    constructor(hls) {
      super(hls); this.retryHost = hls;
      this.captureRetryDecision = (_event, data) => {
        const action = data.errorAction;
        if (action?.retryConfig?.shouldRetry !== errorRetry.shouldRetry) return;
        // LevelController also retries unresolved alternate actions without
        // calling shouldRetry. Give that event an independent effective cap.
        const frame = failingFrame;
        const maximum = frame?.context === data.context ? frame.maximum : original.maxNumRetry;
        action.retryConfig = { ...action.retryConfig, maxNumRetry: maximum };
      };
      hls.on(errorEvent, this.captureRetryDecision, this);
    }
    destroy() { this.retryHost.off(errorEvent, this.captureRetryDecision, this); super.destroy(); }
  }
  class PlaylistLoader extends Loader {
    load(context, config, callbacks) {
      // HLS owns the retry timer. Recheck at dispatch as well as scheduling,
      // including a delayed timer after hiding, retirement or the fixed end.
      if (context.type === "level" && episode?.extended && !within(episode)) {
        episode.closed = true;
        this.context = context;
        errorFrame(context, true, () => callbacks.onError({ code: 400, text: "Live playlist retry window ended." }, context, null, this.stats));
        return;
      }
      return super.load(context, config, { ...callbacks,
        onError: (response, actualContext, ...rest) => {
          return errorFrame(actualContext, false, () => callbacks.onError(response, actualContext, ...rest));
        },
      });
    }
  }
  return {
    loadPolicy: { ...loadPolicy, default: { ...loadPolicy.default, errorRetry } },
    Loader: PlaylistLoader,
    ErrorController: PlaylistErrorController,
    loaded() { episode = null; },
  };
}
