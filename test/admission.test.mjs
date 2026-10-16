import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { Agent, createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
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
test("explicit 32-ticket proxy allowance retains all other admission defaults", { timeout: 5000 }, async () => {
  const time = 100000, controls = createAdmissionControls({ swarmId: "stream", now: () => time, perAddressTickets: 32 });
  const defaults = createAdmissionControls({ swarmId: "stream" }).metrics();
  assert.equal(defaults.perAddressTickets, 12);
  for (const name of ["capacity", "ticketTtlSeconds", "globalTickets", "perAddressRequests", "requestCapacity"]) {
    assert.equal(controls.metrics()[name], defaults[name]);
  }
  for (let index = 0; index < 32; index++) {
    const { response } = await issue(controls, generateSecretKey(), time, { address: "127.0.0.1", forwarded: `untrusted-${index}` });
    assert.equal(response.status, 200);
  }
  const denied = await issue(controls, generateSecretKey(), time, { address: "127.0.0.1", forwarded: "another-untrusted-address" });
  assert.equal(denied.response.status, 429);
  assert.equal(controls.metrics().tickets, 32);
});
test("invalid signatures, mismatched challenge keys and challenge overload are refused before minting", async () => {
  const controls = createAdmissionControls({ swarmId: "stream", capacity: 1, now: () => 100000 });
  const viewer = generateSecretKey(), challenge = await post(controls, "/admission/challenge", { pubkey: getPublicKey(viewer) });
  assert.equal((await post(controls, "/admission/challenge", { pubkey: getPublicKey(viewer) })).status, 429);
  const proof = finalizeEvent({ kind: 27235, tags: [], created_at: 100, content: JSON.stringify({ challenge: challenge.result.challenge, epoch: challenge.result.epoch, swarmId: "stream" }) }, viewer);
  assert.equal((await post(controls, "/admission/ticket", { proof: { ...proof, sig: "0".repeat(128) } })).status, 403);
  assert.equal((await post(controls, "/admission/ticket", { proof })).status, 200);
});

test("admission JSON has exact UTF-8 Content-Length over HTTP/1.1", { timeout: 5000 }, async (t) => {
  const controls = createAdmissionControls({ swarmId: "stream-£-🎥", now: () => 100000, perAddressRequests: 3 });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let origin;
  const server = createServer((request, response) => {
    void controls.handle(request, response, request.url, origin).catch((error) => response.destroy(error));
  });
  t.after(async () => {
    agent.destroy(); server.closeAllConnections();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  const pubkey = getPublicKey(generateSecretKey());
  const roundtrip = (path, input, requestOrigin = origin) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(input), "utf8");
    const request = httpRequest(new URL(path, origin), {
      method: "POST", agent,
      headers: { origin: requestOrigin, "content-type": "application/json", "content-length": body.length },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, version: response.httpVersion, headers: response.headers, complete: response.complete, body: Buffer.concat(chunks) }));
    });
    request.on("error", reject); request.end(body);
  });
  const exactReply = (reply, status, expected) => {
    const expectedBody = Buffer.from(JSON.stringify(expected), "utf8");
    assert.equal(reply.status, status); assert.equal(reply.version, "1.1"); assert.equal(reply.complete, true);
    assert.equal(reply.headers["content-type"], "application/json");
    assert.equal(reply.headers["content-length"], String(expectedBody.length));
    assert.equal(reply.headers["transfer-encoding"], undefined);
    assert.deepEqual(reply.body, expectedBody);
  };
  const challenge = await roundtrip("/admission/challenge", { pubkey });
  const challengeBody = JSON.parse(challenge.body.toString("utf8"));
  assert.match(challengeBody.challenge, /^[a-f0-9]{48}$/u);
  exactReply(challenge, 200, { challenge: challengeBody.challenge, expiresAt: 130000, ...controls.descriptor() });
  assert.ok(challenge.body.length > challenge.body.toString("utf8").length, "non-ASCII response exercises byte length");
  exactReply(await roundtrip("/admission/verify", { pubkey, ticket: "" }), 200, { admitted: false, epoch: controls.descriptor().epoch });
  exactReply(await roundtrip("/admission/verify", {}), 400, { error: "Supply pubkey and bounded ticket." });
  exactReply(await roundtrip("/admission/challenge", { pubkey }, "https://other.example"), 403, { error: "Same-origin admission required." });
  exactReply(await roundtrip("/admission/challenge", { pubkey }), 429, { error: "Admission address request budget exceeded." });
});
