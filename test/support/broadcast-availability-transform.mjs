import assert from "node:assert/strict";
const IMPORT = 'import { availabilityObservation } from "relayswarm-test-availability-observer";\n';
export const SEAMS = Object.freeze({
  client: [
    ['      initialLoader = hls.config.fLoader;', '\n      availabilityObservation.attach(hls, Hls.Events);'],
    ['window.relaySwarmDemo = { report, stop:', ''],
  ],
  swarm: [
    ['    const key = await this.#segmentKey(context);\n    if (signal.aborted || this.stopped) {', '    availabilityObservation.key(context, key, deadline, budgetMs);\n'],
    ['                  const key = await swarm.#segmentKey(context);\n                  if (!swarm.stopped)', '                  availabilityObservation.key(context, key);\n'],
  ],
  peer: [
    ['      this.channel.send(JSON.stringify(message));', '\n      availabilityObservation.queued(this, message);'],
    ['    if (added.length) this.onHaveChange?.(this, added);', '    availabilityObservation.accepted(this, added);\n'],
  ],
});
export function transform(kind, original) {
  assert.ok(Object.hasOwn(SEAMS, kind));
  let value = original;
  const changes = [];
  for (const [needle, addition] of SEAMS[kind]) {
    assert.equal(value.split(needle).length, 2, `Unique ${kind} observation seam required`);
    if (!addition) continue;
    let replacement;
    if (kind === "swarm") { const at = needle.indexOf("\n") + 1; replacement = needle.slice(0, at) + addition + needle.slice(at); }
    else if (kind === "peer" && needle.startsWith("    if (added")) replacement = addition + needle;
    else replacement = needle + addition;
    value = value.replace(needle, replacement); changes.push([replacement, needle]);
  }
  const suffix = kind === "client" ? '\nObject.defineProperty(window, "relaySwarmAvailabilityPrivate", { value: () => availabilityObservation.takePrivate() });\n' : "";
  return { source: IMPORT + value + suffix, undo(source) { assert.ok(source.startsWith(IMPORT)); let v = source.slice(IMPORT.length); if (suffix) { assert.ok(v.endsWith(suffix)); v = v.slice(0, -suffix.length); } for (const [replacement, needle] of [...changes].reverse()) { assert.equal(v.split(replacement).length, 2); v = v.replace(replacement, needle); } return v; } };
}
