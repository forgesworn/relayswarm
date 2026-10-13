import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { createAdmissionControls } from "../demo/admission.mjs";
const base = "https://stream.example";
async function post(controls, path, input, { address = "127.0.0.1", origin = base, forwarded } = {}) {
  const request = Readable.from([Buffer.from(JSON.stringify(input))]);
  Object.assign(request, { method: "POST", socket: { remoteAddress: address }, headers: { origin, "content-type": "application/json", ...(forwarded ? { "x-forwarded-for": forwarded } : {}) } });
  let status, result;
  await controls.handle(request, { writeHead(code) { status = code; return this; }, end(body) { result = JSON.parse(body); } }, path, base);
  return { status, result };
}
async function issue(controls, secretKey, time, extra) {
  const pubkey = getPublicKey(secretKey), challenge = await post(controls, "/admission/challenge", { pubkey }, extra);
  assert.equal(challenge.status, 200);
  const proof = finalizeEvent({ kind: 27235, tags: [], created_at: Math.floor(time / 1000), content: JSON.stringify({ challenge: challenge.result.challenge, epoch: challenge.result.epoch, swarmId: challenge.result.swarmId }) }, secretKey);
  return { proof, response: await post(controls, "/admission/ticket", { proof }, extra) };
}
test("host signed admission binds possession, swarm, expiry and bounded revocation", async () => {
  let time = 100000; const controls = createAdmissionControls({ swarmId: "stream", now: () => time }), viewer = generateSecretKey();
  const { proof, response } = await issue(controls, viewer, time);
  assert.equal(response.status, 200); assert.ok(verifyEvent(JSON.parse(response.result.ticket)));
  assert.equal(controls.verify(getPublicKey(viewer), response.result.ticket), true);
  assert.equal(controls.verify(getPublicKey(generateSecretKey()), response.result.ticket), false);
  assert.equal((await post(controls, "/admission/ticket", { proof })).status, 403);
  controls.revoke(getPublicKey(viewer)); assert.equal(controls.verify(getPublicKey(viewer), response.result.ticket), false);
  assert.equal((await post(controls, "/admission/challenge", { pubkey: getPublicKey(viewer) })).status, 403);
  time += 121000; const next = await issue(controls, viewer, time); assert.equal(next.response.status, 200);
  controls.rotate(); assert.equal(controls.verify(getPublicKey(viewer), next.response.result.ticket), false);
});
test("ticket lifetime expires and issuance quota ignores untrusted forwarded addresses", async () => {
  let time = 100000; const controls = createAdmissionControls({ swarmId: "stream", now: () => time, perAddressTickets: 1 });
  const first = await issue(controls, generateSecretKey(), time);
  assert.equal(first.response.status, 200);
  const second = await issue(controls, generateSecretKey(), time, { forwarded: "different-address" }); assert.equal(second.response.status, 429);
  assert.equal((await post(controls, "/admission/challenge", { pubkey: getPublicKey(generateSecretKey()) }, { origin: "https://other.example" })).status, 403);
  time += 121000; assert.equal(controls.verify(JSON.parse(first.response.result.ticket).tags[0][1], first.response.result.ticket), false);
});
test("invalid signatures, mismatched challenge keys and challenge overload are refused before minting", async () => {
  const controls = createAdmissionControls({ swarmId: "stream", capacity: 1, now: () => 100000 });
  const viewer = generateSecretKey(), challenge = await post(controls, "/admission/challenge", { pubkey: getPublicKey(viewer) });
  assert.equal((await post(controls, "/admission/challenge", { pubkey: getPublicKey(viewer) })).status, 429);
  const proof = finalizeEvent({ kind: 27235, tags: [], created_at: 100, content: JSON.stringify({ challenge: challenge.result.challenge, epoch: challenge.result.epoch, swarmId: "stream" }) }, viewer);
  assert.equal((await post(controls, "/admission/ticket", { proof: { ...proof, sig: "0".repeat(128) } })).status, 403);
  assert.equal((await post(controls, "/admission/ticket", { proof })).status, 200);
});
