// Test-only observation. No loader setters, recovery actions or network calls.
export function installFmp4StartupObserver(getHls, media, quality, clock = () => performance.now()) {
  const records = []; let dropped = 0, attached = false;
  const finite = (x) => Number.isFinite(x) ? x : null;
  const bool = (x) => typeof x === "boolean" ? x : null;
  // Computed Hls level getters can run ABR selection. Read only own data here.
  const data = (object, key) => object ? Object.getOwnPropertyDescriptor(object, key)?.value : undefined;
  const token = (x, values) => values.includes(x) ? x : "unknown";
  const states = ["STOPPED", "IDLE", "KEY_LOADING", "FRAG_LOADING", "FRAG_LOADING_WAITING_RETRY", "WAITING_TRACK", "WAITING_LEVEL", "WAITING_INIT_PTS", "PARSING", "PARSED", "ENDED", "ERROR", "WAITING_INTEGRITY"];
  const fragment = (f) => f ? { sequence: f.sn === "initSegment" ? "init" : finite(f.sn), level: finite(f.level), cc: finite(f.cc), start: finite(f.start), duration: finite(f.duration), loaderPresent: !!f.loader, aborted: bool(f.loader?.stats?.aborted), loaded: finite(f.loader?.stats?.loaded) } : null;
  const stream = (c) => c ? { state: token(c.state, states), level: finite(c.level), startFragRequested: bool(c.startFragRequested), current: fragment(c.fragCurrent), previous: fragment(c.fragPrevious), loaderPresent: !!c.fragmentLoader?.loader, loaderAborted: bool(c.fragmentLoader?.loader?.stats?.aborted), initLoaderPresent: !!c.initFragmentLoader?.loader, initLoaderAborted: bool(c.initFragmentLoader?.loader?.stats?.aborted) } : null;
  const read = () => {
    try {
      const h = getHls(), level = data(h, "levelController"), manual = data(level, "manualLevelIndex");
      return { atMs: Math.round(clock()), hlsPresent: !!h, loadLevel: finite(data(level, "currentLevelIndex")), autoLevel: Number.isInteger(manual) ? manual === -1 : null, stream: stream(h?.streamController), audio: stream(h?.audioStreamController), selectedLevel: finite(Number(quality.value)), media: { currentTime: finite(media.currentTime), readyState: finite(media.readyState), networkState: finite(media.networkState), paused: bool(media.paused), ended: bool(media.ended), errorCode: finite(media.error?.code), buffered: Array.from({ length: Math.min(media.buffered.length, 8) }, (_, i) => [finite(media.buffered.start(i)), finite(media.buffered.end(i))]) } };
    } catch { return { unavailable: true, atMs: Math.round(clock()) }; }
  };
  const add = (event, data = {}) => {
    try { if (records.length === 128) { records.shift(); dropped = Math.min(Number.MAX_SAFE_INTEGER, dropped + 1); } records.push({ event, atMs: Math.round(clock()), ...data }); } catch {}
  };
  quality.addEventListener("change", (e) => add("quality-change", { trusted: e.isTrusted, selectedLevel: finite(Number(quality.value)), state: read() }), true);
  for (const event of ["loadstart", "loadedmetadata", "loadeddata", "canplay", "playing", "waiting", "abort", "error", "stalled", "emptied"]) media.addEventListener(event, () => add(`media-${event}`, { state: read() }));
  return {
    attach(h, events) {
      if (attached) return; attached = true;
      for (const name of ["MANIFEST_PARSED", "LEVEL_LOADING", "LEVEL_LOADED", "LEVEL_SWITCHING", "LEVEL_SWITCHED", "FRAG_LOADING", "FRAG_LOADED", "FRAG_LOAD_EMERGENCY_ABORTED", "FRAG_PARSED", "FRAG_BUFFERED", "BUFFER_CREATED", "BUFFER_APPENDING", "BUFFER_APPENDED", "ERROR"]) {
        h.on(events[name], (_event, data = {}) => {
          try {
          const detail = name === "ERROR" ? token(data.details, ["aborted", "fragLoadError", "fragLoadTimeOut", "fragParsingError", "bufferAppendError", "bufferAppendingError", "bufferStalledError", "internalException"]) : null;
          add(name, { fragment: fragment(data.frag), level: finite(data.level), detail, fatal: bool(data.fatal), state: read() });
          } catch { add("observation-unavailable"); }
        });
      }
      add("observer-attached", { state: read() });
    },
    snapshot() { return { v: 1, capacity: 128, dropped, attached, state: read(), records: structuredClone(records), scope: "Test-only passive Hls/media event and numeric state observation; no playback actions" }; },
  };
}
