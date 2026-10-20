// Browser-side diagnostic observer only. It neither changes bytes nor recovers
// playback: fatal decoder/append failures remain failures of the test journey.
export function installMediaDiagnostics() {
  const trace = [];
  const transitions = [];
  window.relaySwarmMediaDiagnostics = trace;
  window.relaySwarmMediaTransitions = transitions;
  const transition = (value) => { transitions.push({ at: performance.now(), ...value }); if (transitions.length > 100) transitions.shift(); };
  const ranges = (value) => {
    try { return Array.from({ length: value.length }, (_, i) => [value.start(i), value.end(i)]); } catch { return []; }
  };
  const record = (kind, buffer, extra = {}) => {
    if (trace.length >= 100) return;
    const media = document.querySelector("video");
    trace.push({ at: performance.now(), kind, ...extra, mime: buffer?.relaySwarmDiagnosticMime,
      updating: buffer?.updating, timestampOffset: buffer?.timestampOffset,
      appendWindowStart: buffer?.appendWindowStart, appendWindowEnd: buffer?.appendWindowEnd,
      buffered: ranges(buffer?.buffered), recentAppends: [...(buffer?.relaySwarmRecentAppends ?? [])], media: media ? { time: media.currentTime, readyState: media.readyState,
        buffered: ranges(media.buffered), error: media.error && { code: media.error.code, message: media.error.message } } : null,
      recentResources: performance.getEntriesByType("resource").slice(-5).map(({ name, duration }) => ({ name, duration })) });
  };
  const add = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const buffer = add.call(this, mime);
    buffer.relaySwarmDiagnosticMime = mime;
    buffer.relaySwarmRecentAppends = [];
    transition({ kind: "source-buffer-created", mime });
    buffer.addEventListener("error", () => record("source-buffer-error", buffer));
    return buffer;
  };
  const change = SourceBuffer.prototype.changeType;
  if (change) SourceBuffer.prototype.changeType = function (mime) {
    try { const result = change.call(this, mime); transition({ kind: "source-buffer-change-type", from: this.relaySwarmDiagnosticMime, mime }); this.relaySwarmDiagnosticMime = mime; return result; }
    catch (error) { record("change-type-exception", this, { name: error.name, message: error.message, requestedMime: mime }); throw error; }
  };
  const append = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (bytes) {
    try {
      const recent = this.relaySwarmRecentAppends || (this.relaySwarmRecentAppends = []);
      const prefix = new Uint8Array(bytes.buffer || bytes, bytes.byteOffset || 0, Math.min(bytes.byteLength, 16));
      recent.push({ at: performance.now(), bytes: bytes.byteLength, prefix: [...prefix].map((value) => value.toString(16).padStart(2, "0")).join(""), timestampOffset: this.timestampOffset });
      if (recent.length > 8) recent.shift();
    } catch { /* Let the native method handle invalid or detached input. */ }
    try { return append.call(this, bytes); }
    catch (error) { record("append-exception", this, { name: error.name, message: error.message, bytes: bytes?.byteLength }); throw error; }
  };
  document.addEventListener("error", (event) => { if (event.target instanceof HTMLMediaElement) record("media-error", null); }, true);
}
