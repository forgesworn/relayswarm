// Keep each simulated viewer's TURN principal out of the other browser contexts.
export function testIceForViewer(configuration, viewer) {
  if (!configuration) return null;
  if (!["all", "relay"].includes(configuration.iceTransportPolicy)) throw new Error("Invalid test ICE policy.");
  const iceServers = configuration.iceServersByViewer
    ? Object.hasOwn(configuration.iceServersByViewer, viewer) && configuration.iceServersByViewer[viewer]
    : configuration.iceServers;
  if (!Array.isArray(iceServers) || !iceServers.length) throw new Error(`Missing test ICE servers for ${viewer}.`);
  return { iceServers, iceTransportPolicy: configuration.iceTransportPolicy };
}
