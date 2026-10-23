import test from "node:test";
import assert from "node:assert/strict";
import { testIceForViewer } from "./support/fixture-ice.mjs";

test("each browser context receives only its own TURN principal", () => {
  const configuration = {
    iceTransportPolicy: "relay",
    iceServersByViewer: {
      v0: [{ urls: "turn:localhost", username: "expires:v0", credential: "first" }],
      v1: [{ urls: "turn:localhost", username: "expires:v1", credential: "second" }],
    },
    expectedRelayProtocol: "tcp",
  };
  const first = testIceForViewer(configuration, "v0");
  const second = testIceForViewer(configuration, "v1");
  assert.equal(first.iceServers[0].username, "expires:v0");
  assert.equal(second.iceServers[0].username, "expires:v1");
  assert.equal(first.iceTransportPolicy, "relay");
  assert.equal(JSON.stringify(first).includes("second"), false);
  assert.equal(Object.hasOwn(first, "iceServersByViewer"), false);
});

test("a missing viewer cannot borrow a shared TURN credential", () => {
  assert.throws(() => testIceForViewer({ iceTransportPolicy: "relay", iceServersByViewer: { v0: [] },
    iceServers: [{ urls: "turn:localhost", username: "shared" }] }, "v1"), /Missing test ICE servers/);
});

test("direct fixtures and explicit shared configurations remain supported", () => {
  assert.equal(testIceForViewer(null, "v0"), null);
  const iceServers = [{ urls: "turn:localhost" }];
  assert.deepEqual(testIceForViewer({ iceServers, iceTransportPolicy: "relay" }, "v0"), { iceServers, iceTransportPolicy: "relay" });
  assert.throws(() => testIceForViewer({ iceServers, iceTransportPolicy: "invalid" }, "v0"), /Invalid test ICE policy/);
});
