#!/usr/bin/env node
// Account authentication and reservations in the real player. The disposable
// signer/session and existing loopback RTC flags are fixture accommodations.
import assert from "node:assert/strict";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import { createMediaFixture } from "../../demo/media-fixture.mjs";
import { startDemoServer } from "../../demo/server.mjs";

import { readFile } from "node:fs/promises";
import { cap, now, bounded, stamp, journal } from "./account-browser-guard.mjs";
const input = JSON.parse(await readFile(process.env.RELAYSWARM_ACCOUNT_INPUT, "utf8"));
const clock = input.clock;
const workerReceipt = input.workerReceipt;
const turnRenewal = input.values["turn-renewal"] === true;
// The supervisor records this direct child's group before authorising any setup.
await new Promise((resolve) => {
  const lost = () => process.exit(1);
  process.once("disconnect", lost);
  process.once("message", (message) => { process.removeListener("disconnect", lost); if (message?.start === true) resolve(); else process.exit(1); });
  process.send({ ready: true });
});
const args = ["--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"];
const receipt = { v: 1, kind: turnRenewal ? "relayswarm-account-budget-turn-renewal-browser" : "relayswarm-account-budget-browser", at: new Date().toISOString(), ok: false,
  scope: { network: "loopback", physicalDevices: false, wholeMs: 180000, browserFlags: args,
    signer: "disposable NIP-07 bridge with real signatures", websiteAccount: "test-owned authenticated session",
    quota: "durable accepted media reservations; not wire metering or NAT acceptance" }, checkpoints: [], failures: [], cleanup: {} };
if (turnRenewal) Object.assign(receipt.scope, { turnCredentialRenewal: true, issuer: "owned fake response; no issuer DNS or HTTP", turnEndpoint: "unavailable loopback TCP port9",
  actualInternetTurnOrTlsRelayProof: false, mediaTransport: "real loopback WebRTC host path", credentialTtlSeconds: 15 });
const contexts = [], pages = [], pageErrors = [], renewals = {};
const accountKey = generateSecretKey(), accountPubkey = getPublicKey(accountKey);
const websiteSession = randomBytes(32).toString("hex"), websiteDigest = createHash("sha256").update(websiteSession).digest();
let root = input.root, fixture, demo, browser, browserServer, expired = false;
let issuerCalls = 0;
const begin = performance.now();
const log = (message) => console.error(`[account-budget-browser] ${message}`);
const budget = (maximum) => cap(clock, "work", maximum);
const alarm = setTimeout(() => { expired = true; void browser?.close().catch(() => {}); }, budget(150000));
// IPC loss requests cleanup; the independent launcher and Chrome watchdog still
// enforce the original deadline if an awaited setup/close cannot settle.
const requestStop = () => { expired = true; void browser?.close().catch(() => {}); };
process.on("disconnect", requestStop);
process.on("message", (message) => { if (message?.stop) requestStop(); });
const save = async () => { await writeFile(workerReceipt, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }); };
try {
  receipt.stage = "media-setup"; cap(clock, "work", 1);
  fixture = await createMediaFixture({ sectionSeconds: 60 });
  const config = { mediaDir: fixture.directory, publisherState: join(root, "publisher.json"),
    ...(turnRenewal ? { turnCredentials: { url: "https://issuer.invalid/turn", fetchImpl: async () => {
      issuerCalls++;
      return new Response(JSON.stringify({ urls: ["turn:127.0.0.1:9?transport=tcp"], username: `owned-${issuerCalls}`, credential: `owned-test-${issuerCalls}`, ttl: 15 }), { headers: { "content-type": "application/json" } });
    } } } : { iceServers: [] }),
    accountBudget: { statePath: join(root, "account-budget.json"), grantTtlSeconds: 30,
      resolveWebsiteAccount(request, { signal }) {
        if (signal.aborted) return null;
        const matches = String(request.headers.cookie || "").split(";").map((part) => part.trim()).filter((part) => part.startsWith("account-fixture="));
        if (matches.length !== 1) return null;
        const candidate = matches[0].slice("account-fixture=".length);
        if (!/^[a-f0-9]{64}$/u.test(candidate) || !timingSafeEqual(createHash("sha256").update(candidate).digest(), websiteDigest)) return null;
        return { issuer: "owned-loopback-fixture", subject: "test-viewer" };
      },
    } };
  receipt.stage = "server-setup"; cap(clock, "work", 1);
  demo = await startDemoServer(config);
  receipt.stage = "browser-setup";
  journal(input.chromeIntent, { nonce: input.nonce, at: stamp() });
  browserServer = await chromium.launchServer({ executablePath: input.chromeWrapper, headless: true, args, timeout: budget(15000) });
  const chromeOwner = JSON.parse(await readFile(input.chromeJournal, "utf8"));
  assert.equal(chromeOwner.nonce, input.nonce); assert.equal(browserServer.process().pid, chromeOwner.pid);
  receipt.scope.chromeProcessIdentityMatched = true;
  browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: budget(15000) });
  const persistent = await browser.newContext(); contexts.push(persistent);
  receipt.scope.browserVersion = browser.version();
  const read = (page) => page.evaluate(() => window.relaySwarmDemo.report());
  const inspect = async (name, page) => {
    const report = await read(page);
    assert.ok(!JSON.stringify(report).includes(accountPubkey), "Player receipts must omit the stable account identity");
    return { name, totals: report.totals, local: report.uploadBudget, shared: report.accountBudget,
      uploadChecked: await page.locator("#upload").isChecked(), telemetryChecked: await page.locator("#telemetry").isChecked(),
      serving: report.current?.metrics.serving ?? false, currentTime: report.player.currentTime, fatalErrors: report.player.fatalErrors,
      ...(turnRenewal ? { turn: { refreshes: report.turnCredentials?.refreshes ?? null, available: report.turnCredentials?.available ?? null,
        failures: report.turnCredentials?.failures ?? null, remainingMs: report.turnCredentials?.remainingMs ?? null },
      activeSwarmStartedAtMs: report.current?.startedAtMs ?? null, activeSwarmPeerLoads: report.current?.metrics.segments.peerFirstLoaded ?? null,
      activeSwarmPeerBytes: report.current?.metrics.bytes.peerFirst ?? null } : {}) };
  };
  const checkpoint = async (name) => { receipt.checkpoints.push({ name, atMs: Math.round(performance.now() - begin), viewers: await Promise.all(pages.map(({ name, page }) => inspect(name, page))) }); await save(); log(name); };
  async function viewer(name, { context, method, level = 0, upload = false } = {}) {
    if (!context) { context = await browser.newContext(); contexts.push(context); }
    let signerCalls = 0, keyReads = 0;
    await context.exposeFunction("__ownedAccountTestSign", (event) => { signerCalls++; assert.equal(event.kind, 27237); return finalizeEvent(event, accountKey); });
    await context.exposeFunction("__ownedAccountTestKey", () => { keyReads++; return accountPubkey; });
    await context.addInitScript(() => { window.nostr = { getPublicKey: () => window.__ownedAccountTestKey(), signEvent: (event) => window.__ownedAccountTestSign(event) }; });
    if (method === "website") await context.addCookies([{ name: "account-fixture", value: websiteSession, url: demo.base, httpOnly: true, sameSite: "Strict" }]);
    const page = await context.newPage(); page.setDefaultTimeout(budget(12000)); pages.push({ name, page, context, signerCalls: () => signerCalls, keyReads: () => keyReads });
    page.on("pageerror", () => pageErrors.push({ name, category: "pageerror" }));
    page.on("response", (response) => { if (new URL(response.url()).pathname === "/account-budget/renew" && response.status() === 200) renewals[name] = (renewals[name] || 0) + 1; });
    await page.goto(demo.base); await page.waitForFunction(() => window.relaySwarmDemo?.ready() && !document.getElementById("start").disabled);
    assert.equal(signerCalls, 0, "The page must not request account signatures before an explicit account action");
    assert.equal(keyReads, 0, "The page must not read the stable account identity before an explicit account action");
    assert.equal(await page.locator("#upload").isChecked(), false); assert.equal(await page.locator("#telemetry").isChecked(), false);
    if (method) {
      await page.locator("#account-method").selectOption(method); await page.locator("#account-connect").click();
      await page.waitForFunction(() => window.relaySwarmDemo.report().accountBudget?.connected && window.relaySwarmDemo.report().accountBudget.available);
      assert.equal(await page.locator("#upload").isChecked(), false, "Account authentication does not grant upload consent");
      assert.equal(signerCalls > 0, method === "nostr");
      assert.equal(keyReads > 0, method === "nostr");
    }
    // Match the existing maintained loopback WebRTC fixture; the product does
    // not request microphone access and this is no default-network field pass.
    await page.evaluate(async () => { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); for (const track of stream.getTracks()) track.stop(); });
    await page.locator("#mode").selectOption("peer-first");
    if (upload) { await page.locator("#upload").check(); await page.locator("#limit").selectOption("1250000"); }
    await page.locator("#start").click(); await page.waitForFunction(() => !document.getElementById("quality").disabled);
    await page.locator("#quality").selectOption(String(level));
    await page.waitForFunction(() => window.relaySwarmDemo.report().player.firstPlayingAtMs !== null);
    return page;
  }
  receipt.stage = "viewer-setup";
  const nostr = await viewer("nostr-contributor", { context: persistent, method: "nostr", level: 0, upload: true });
  const website = await viewer("website-contributor", { method: "website", level: 1, upload: true });
  const consumer = await viewer("receive-only");
  const turnBefore = turnRenewal ? await Promise.all(pages.map(({ name, page }) => inspect(name, page))) : null;
  if (turnRenewal) for (const before of turnBefore) assert.ok(Number.isFinite(before.activeSwarmStartedAtMs));
  receipt.stage = "verified-peer-delivery";
  await consumer.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((fragment) => fragment.source === "peer" && fragment.level === 0), null, { timeout: budget(20000) });
  await consumer.locator("#quality").selectOption("1");
  await consumer.waitForFunction(() => window.relaySwarmDemo.report().player.fragments.some((fragment) => fragment.source === "peer" && fragment.level === 1), null, { timeout: budget(20000) });
  receipt.stage = "account-renewal";
  // The additional TURN gate shares the existing first40s renewal phase; it
  // does not append a new wait budget or renew the original worker deadline.
  const renewalEnd = turnRenewal ? now() + BigInt(budget(40000)) * 1000000n : null;
  for (const page of [nostr, website]) await page.waitForFunction(() => window.relaySwarmDemo.report().durationMs >= 35000 && window.relaySwarmDemo.report().accountBudget.available, null,
    { timeout: turnRenewal ? cap({ work: String(renewalEnd) }, "work", budget(40000)) : budget(40000) });
  assert.ok(renewals["nostr-contributor"] > 0 && renewals["website-contributor"] > 0);
  assert.equal(pages[0].signerCalls(), 1, "Page-key renewal does not prompt the stable signer again");
  assert.equal(pages[0].keyReads(), 1);
  assert.equal(pages[1].signerCalls(), 0);
  assert.equal(pages[1].keyReads(), 0);
  if (turnRenewal) {
    receipt.stage = "turn-credential-rollover";
    await consumer.waitForFunction((before) => {
      const report = window.relaySwarmDemo.report();
      return report.durationMs >= 35000 && report.turnCredentials?.refreshes >= 2
        && report.turnCredentials.refreshes > before.refreshes && report.current?.startedAtMs > before.startedAtMs
        && report.current?.metrics.segments.peerFirstLoaded > 0 && report.current?.metrics.bytes.peerFirst > 0;
    }, { startedAtMs: turnBefore[2].activeSwarmStartedAtMs, refreshes: turnBefore[2].turn.refreshes }, { timeout: cap({ work: String(renewalEnd) }, "work", budget(40000)) });
    const after = await Promise.all(pages.map(({ name, page }) => inspect(name, page)));
    for (let i = 0; i < after.length; i++) {
      assert.ok(after[i].turn.refreshes >= 2); assert.equal(after[i].turn.available, true);
      assert.ok(Number.isSafeInteger(after[i].local.spent) && Number.isSafeInteger(turnBefore[i].local.spent) && after[i].local.spent >= turnBefore[i].local.spent);
      if (i < 2) {
        assert.ok(Number.isSafeInteger(after[i].shared.spent) && Number.isSafeInteger(turnBefore[i].shared.spent) && after[i].shared.spent >= turnBefore[i].shared.spent);
        assert.equal(after[i].uploadChecked, true); assert.equal(after[i].serving, true);
      }
      else { assert.equal(after[i].uploadChecked, false); assert.equal(after[i].totals.uploaded, 0); }
    }
    receipt.turnRollover = { issuerCalls, before: turnBefore, after };
    await checkpoint("turn-rollover-preserves-consent-and-spend-with-new-swarm-peer-delivery");
  }
  receipt.renewals = { ...renewals }; receipt.scope.accountGrantTtlSeconds = 30;
  await checkpoint("both-authentication-paths-reserve-before-real-peer-upload");
  const original = await Promise.all([inspect("nostr", nostr), inspect("website", website)]);
  for (const result of original) { assert.ok(result.totals.uploaded > 0); assert.ok(result.shared.spent >= result.totals.uploaded); assert.ok(result.local.spent >= result.totals.uploaded); assert.equal(result.telemetryChecked, false); }
  const beforeLinkSpent = original.reduce((sum, result) => sum + result.shared.spent, 0);
  receipt.stage = "account-link";
  await persistent.addCookies([{ name: "account-fixture", value: websiteSession, url: demo.base, httpOnly: true, sameSite: "Strict" }]);
  await nostr.locator("#account-link").click();
  await nostr.waitForFunction((minimum) => { const state = window.relaySwarmDemo.report().accountBudget; return state?.available && state.spent >= minimum && !document.getElementById("upload").checked; }, beforeLinkSpent);
  await website.waitForFunction(() => !document.getElementById("upload").checked && !window.relaySwarmDemo.report().accountBudget.available, null, { timeout: budget(12000) });
  await checkpoint("explicit-link-preserves-spend-and-withdraws-old-page-consent");
  const linked = await inspect("linked", nostr);
  const acceptedAtLink = receipt.checkpoints.at(-1).viewers
    .filter(({ name }) => name.endsWith("-contributor"))
    .reduce((sum, viewer) => sum + viewer.totals.uploaded, 0);
  assert.ok(linked.shared.spent >= acceptedAtLink, "Durable linked spend covers committed serving totals, including archived stopped swarms");
  assert.ok(linked.shared.spent >= beforeLinkSpent); assert.equal(linked.uploadChecked, false); assert.equal(linked.serving, false);
  receipt.stage = "server-restart";
  const base = demo.base, port = Number(new URL(base).port);
  await demo.close(); demo = null;
  cap(clock, "work", 1);
  demo = await startDemoServer({ ...config, port }); assert.equal(demo.base, base);
  await nostr.reload(); await nostr.waitForFunction(() => window.relaySwarmDemo?.ready());
  assert.equal(await nostr.locator("#upload").isChecked(), false);
  assert.equal((await read(nostr)).accountBudget.connected, false, "A reload does not persist account credentials");
  await nostr.locator("#account-method").selectOption("nostr"); await nostr.locator("#account-connect").click();
  await nostr.waitForFunction((minimum) => { const state = window.relaySwarmDemo.report().accountBudget; return state?.available && state.spent >= minimum; }, linked.shared.spent);
  assert.ok((await read(nostr)).uploadBudget.spent >= original[0].local.spent);
  await checkpoint("server-restart-and-explicit-page-reconnection-retain-shared-spend");
  receipt.stage = "reset-and-disconnect";
  await nostr.locator("#account-reset").click();
  await nostr.waitForFunction(() => { const state = window.relaySwarmDemo.report().accountBudget; return state?.available && state.spent === 0; });
  assert.equal(await nostr.locator("#upload").isChecked(), false);
  await nostr.locator("#account-disconnect").click();
  await nostr.waitForFunction(() => !window.relaySwarmDemo.report().accountBudget.connected);
  const disconnected = (await read(nostr)).accountBudget;
  assert.equal(disconnected.required, true); assert.equal(disconnected.available, false);
  await checkpoint("fresh-owner-reset-and-explicit-disconnection-never-enable-uploading");
  assert.equal(pageErrors.length, 0); assert.ok(!expired); receipt.ok = true; receipt.stage = "complete";
} catch (error) { receipt.failures.push({ category: ["AssertionError", "TimeoutError", "Error", "AbortError"].includes(error.name) ? error.name : "other" }); }
finally {
  clearTimeout(alarm);
  const close = async (name, resource, operation) => {
    receipt.cleanup[name] = resource ? false : null;
    if (!resource) return;
    try { await bounded(operation, clock, "grace", 12000); receipt.cleanup[name] = true; }
    catch { receipt.cleanup[name] = false; }
  };
  // All three attempts start even if another close hangs or throws. A missing
  // resource after partial setup is unknown, never invented successful cleanup.
  await Promise.allSettled([
    close("browserClosed", browserServer, async () => { await browser?.close(); await browserServer.close(); }),
    close("serverClosed", demo, () => demo.close()),
    close("mediaFixtureRemoved", fixture, () => fixture.close()),
  ]);
  receipt.elapsedMs = Math.round(performance.now() - begin); receipt.finishedAt = stamp();
  receipt.deadlineExpired = expired || now() >= BigInt(clock.work); receipt.pageErrors = pageErrors;
  receipt.ok = receipt.ok && !receipt.deadlineExpired && Object.values(receipt.cleanup).every((value) => value === true);
  assert.ok(!JSON.stringify(receipt).includes(accountPubkey));
  await save();
}
process.exit(receipt.ok ? 0 : 1);
