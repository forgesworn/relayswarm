import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, link, unlink } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { validStreamAuthorisation, delegationContent, revocationContent, KIND_COMMITMENT_DELEGATION, KIND_COMMITMENT_REVOCATION, verifyCommitmentDelegation } from "./browser/segment-commitment.mjs";

const MAX_STATE_BYTES = 32 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function publisherManifestPath(manifest = "master.m3u8") {
  if (typeof manifest !== "string" || !manifest || /[?%#\\\s]/u.test(manifest) || /^[a-z]+:/iu.test(manifest) || manifest.startsWith("//")) throw new Error("Invalid publisher manifest.");
  const path = new URL(manifest, "https://publisher.invalid/media/").pathname;
  if (!path.startsWith("/media/") || !/^[a-z0-9_./-]+$/iu.test(path)) throw new Error("Invalid publisher manifest.");
  return path;
}

export function publisherSwarmId(value) {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) throw new Error("Invalid swarm id.");
  return value;
}

export function publisherStreamEvent(secretKey, manifestPath, now = Date.now) {
  return finalizeEvent({ kind: 30311, created_at: Math.floor(now() / 1000), tags: [["d", digest(manifestPath).slice(0, 24)], ["relayswarm", "redistribute", "1"]], content: "RelaySwarm experimental publisher" }, secretKey);
}

export function validatePublisherStreamEvent(event, secretKey, manifestPath, { allowExternalAuthor = false } = {}) {
  if (!validStreamAuthorisation(event) || (!secretKey ? !allowExternalAuthor : event.pubkey !== getPublicKey(secretKey))
    || event.tags.filter((tag) => tag[0] === "d").length !== 1
    || event.tags.find((tag) => tag[0] === "d")?.[1] !== digest(manifestPath).slice(0, 24)) throw new Error("Publisher authorisation does not match its identity and manifest.");
  // No authorisation age limit: this signed stream identity must survive restarts.
  return structuredClone(event);
}

/** Create an author-signed, at-most-one-hour delegation. The signing key remains
 * with the caller; publishing this event does not discover or deliver revocations. */
export function createCommitmentDelegation({ secretKey, streamEvent, swarmId, delegatePubkey, notBefore,
  expiresAt, renditions, mediaTypes = ["main"], allowParts = false, maxSegmentBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
  const created_at = Math.floor(now() / 1000);
  if (!validStreamAuthorisation(streamEvent) || streamEvent.pubkey !== getPublicKey(secretKey)) throw new Error("Delegation requires the stream author's key.");
  const event = finalizeEvent({ kind: KIND_COMMITMENT_DELEGATION, created_at, tags: [["x", swarmId], ["e", streamEvent.id]],
    content: delegationContent({ streamEventId: streamEvent.id, swarmId, delegatePubkey, notBefore: notBefore ?? created_at,
      expiresAt: expiresAt ?? created_at + 300, renditions, mediaTypes, allowParts, maxSegmentBytes }) }, secretKey);
  // Validate all scopes before returning an authorisation. Future notBefore can
  // be checked at its activation time, without changing the issuance timestamp.
  if (!verifyCommitmentDelegation(event, { streamEvent, swarmId }, (notBefore ?? created_at) * 1000)) throw new Error("Invalid commitment delegation scope.");
  return event;
}
export function createCommitmentRevocation({ secretKey, streamEvent, swarmId, delegation, now = Date.now } = {}) {
  if (!validStreamAuthorisation(streamEvent) || streamEvent.pubkey !== getPublicKey(secretKey)
    || !verifyCommitmentDelegation(delegation, { streamEvent, swarmId }, Math.max(delegation.created_at, JSON.parse(delegation.content).notBefore) * 1000)) throw new Error("Revocation requires a valid author delegation.");
  const created_at = Math.floor(now() / 1000);
  if (created_at < delegation.created_at) throw new Error("Revocation predates its delegation.");
  return finalizeEvent({ kind: KIND_COMMITMENT_REVOCATION, created_at, tags: [["x", swarmId], ["e", delegation.id]],
    content: revocationContent({ streamEventId: streamEvent.id, swarmId, delegationId: delegation.id }) }, secretKey);
}

function privateFile(stat) {
  if (stat.nlink !== 1) throw Object.assign(new Error("Publisher state must have a single link."), { code: "STATE_LINKS" });
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600
    || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > MAX_STATE_BYTES) throw new Error("Publisher state must be a private, owner-only regular file.");
}

function decodeState(text, manifestPath, requestedSwarmId) {
  let state;
  try { state = JSON.parse(text); } catch { throw new Error("Invalid publisher state."); }
  if (state?.v !== 1 || state.manifest !== manifestPath || typeof state.secretKey !== "string" || !/^[0-9a-f]{64}$/u.test(state.secretKey)) throw new Error("Invalid publisher state or manifest mismatch.");
  const secretKey = Uint8Array.from(Buffer.from(state.secretKey, "hex"));
  let streamEvent;
  try { streamEvent = validatePublisherStreamEvent(state.streamEvent, secretKey, manifestPath); } catch { throw new Error("Invalid publisher state authorisation."); }
  publisherSwarmId(state.swarmId);
  if (requestedSwarmId !== undefined && requestedSwarmId !== state.swarmId) throw new Error("Publisher state swarm mismatch.");
  return { secretKey, streamEvent, swarmId: state.swarmId };
}

/** Opt-in private publisher identity. The parent directory must already exist,
 * belong to the current user and disallow writes by other users. Secrets are
 * never included in errors; malformed existing state is never overwritten.
 * Requires POSIX file permissions; Windows ACL support is not implemented. */
export async function loadPublisherState(path, { manifest = "master.m3u8", swarmId, now = Date.now } = {}) {
  if (process.platform === "win32") throw Object.assign(new Error("Persistent publisher state requires POSIX file permissions; Windows ACL support is not implemented."), { code: "ERR_PUBLISHER_STATE_UNSUPPORTED_PLATFORM" });
  if (typeof path !== "string" || !path) throw new Error("A publisher state path is required.");
  const manifestPath = publisherManifestPath(manifest);
  if (swarmId !== undefined) publisherSwarmId(swarmId);
  const requested = resolve(path), parent = dirname(requested);
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o022)
    || (typeof process.getuid === "function" && parentStat.uid !== process.getuid())) throw new Error("Publisher state requires a private, owner-controlled directory.");
  const canonicalParent = await realpath(parent);
  const file = join(canonicalParent, basename(requested));
  const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
  async function readOnce() {
    const handle = await open(file, constants.O_RDONLY | flags);
    try {
      const before = await handle.stat(); privateFile(before);
      const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      const after = await handle.stat(); privateFile(after);
      const current = await lstat(file);
      if (size > MAX_STATE_BYTES || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink()
        || current.dev !== after.dev || current.ino !== after.ino) throw new Error("Publisher state changed during reading.");
      return decodeState(bytes.subarray(0, size).toString("utf8"), manifestPath, swarmId);
    } finally { await handle.close(); }
  }
  async function read() {
    for (let attempt = 0; ; attempt++) {
      try { return await readOnce(); } catch (error) {
        // Atomic publication briefly has two hard links until the private
        // temporary name is removed. Permanent hard links remain forbidden.
        if (error.code !== "STATE_LINKS" || attempt >= 10) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  }
  try { return await read(); } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot safely load publisher state.", { cause: error });
  }
  const secretKey = generateSecretKey();
  const streamEvent = publisherStreamEvent(secretKey, manifestPath, now);
  const identity = { secretKey, streamEvent, swarmId: swarmId ?? `publisher-${streamEvent.id.slice(0, 32)}` };
  const temporary = join(canonicalParent, `.publisher-state-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | flags, 0o600);
  try {
    try {
      await handle.chmod(0o600);
      await handle.writeFile(JSON.stringify({ v: 1, manifest: manifestPath, secretKey: Buffer.from(secretKey).toString("hex"), streamEvent, swarmId: identity.swarmId }));
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(temporary, file); } catch (error) {
      if (error.code !== "EEXIST") throw new Error("Cannot safely create publisher state.", { cause: error });
      // Another process won publication. Its complete identity is authoritative.
    }
  } finally { await unlink(temporary); }
  const directory = await open(canonicalParent, constants.O_RDONLY | constants.O_DIRECTORY | flags);
  try { await directory.sync(); } finally { await directory.close(); }
  return read();
}
