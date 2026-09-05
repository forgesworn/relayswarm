import { createHash } from "node:crypto";
import { once } from "node:events";

const MAGIC = Buffer.from("RS");
const VERSION = 1;
const HEADER_BYTES = 8;
const MAX_FRAME_BYTES = 64 * 1024;
export const DEFAULT_MAX_OBJECT_BYTES = 256 * 1024 * 1024;

export const FRAME = Object.freeze({
  REQUEST: 1,
  META: 2,
  CHUNK: 3,
  EOF: 4,
  ERROR: 5,
});

const HEX64 = /^[0-9a-f]{64}$/u;

function parseJsonObject(payload) {
  const value = JSON.parse(payload.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a transfer object.");
  return value;
}

function validateObjectIdentity({ requestId, sha256, size }, maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES) {
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 64 || !/^[a-zA-Z0-9_-]+$/u.test(requestId)) {
    throw new Error("Invalid transfer request identifier.");
  }
  if (!HEX64.test(sha256)) throw new Error("Invalid transfer digest.");
  if (!Number.isSafeInteger(size) || size < 0 || size > maxObjectBytes) throw new Error("Invalid transfer size.");
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function encodeFrame(type, payload = Buffer.alloc(0)) {
  if (!Number.isInteger(type) || type < FRAME.REQUEST || type > FRAME.ERROR) throw new Error("Invalid transfer frame type.");
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) throw new Error("Transfer frame is too large.");
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[2] = VERSION;
  header[3] = type;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

async function writeFrame(stream, type, payload) {
  if (!stream.write(encodeFrame(type, payload))) await once(stream, "drain");
}

function readFirstFrame(stream) {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    const fail = (error) => {
      cleanup();
      if (!stream.destroyed) stream.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onEnd = () => fail(new Error("Native peer closed before requesting an object."));
    const onData = (chunk) => {
      pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
      if (pending.length < HEADER_BYTES) return;
      if (pending[0] !== MAGIC[0] || pending[1] !== MAGIC[1] || pending[2] !== VERSION) return fail(new Error("Invalid transfer frame header."));
      const type = pending[3];
      if (type < FRAME.REQUEST || type > FRAME.ERROR) return fail(new Error("Invalid transfer frame type."));
      const length = pending.readUInt32BE(4);
      if (length > MAX_FRAME_BYTES) return fail(new Error("Transfer frame is too large."));
      if (pending.length < HEADER_BYTES + length) return;
      if (pending.length !== HEADER_BYTES + length) return fail(new Error("Expected exactly one transfer request."));
      cleanup();
      resolve({ type, payload: pending.subarray(HEADER_BYTES) });
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

export async function* decodeFrames(stream) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    while (pending.length >= HEADER_BYTES) {
      if (pending[0] !== MAGIC[0] || pending[1] !== MAGIC[1] || pending[2] !== VERSION) {
        throw new Error("Invalid transfer frame header.");
      }
      const type = pending[3];
      if (type < FRAME.REQUEST || type > FRAME.ERROR) throw new Error("Invalid transfer frame type.");
      const length = pending.readUInt32BE(4);
      if (length > MAX_FRAME_BYTES) throw new Error("Transfer frame is too large.");
      if (pending.length < HEADER_BYTES + length) break;
      yield { type, payload: pending.subarray(HEADER_BYTES, HEADER_BYTES + length) };
      pending = pending.subarray(HEADER_BYTES + length);
    }
  }
  if (pending.length !== 0) throw new Error("Truncated transfer frame.");
}

export async function serveAuthorizedObject(stream, authorization, resolveObject, { maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES } = {}) {
  validateObjectIdentity(authorization, maxObjectBytes);
  if (typeof resolveObject !== "function") throw new Error("A transfer object resolver is required.");

  try {
    const frame = await readFirstFrame(stream);
    if (frame.type !== FRAME.REQUEST) throw new Error("Expected exactly one transfer request.");
    const request = parseJsonObject(frame.payload);
    validateObjectIdentity(request, maxObjectBytes);
    if (request.requestId !== authorization.requestId || request.sha256 !== authorization.sha256 || request.size !== authorization.size) {
      throw new Error("Transfer request does not match its Nostr authorization.");
    }

    const resolved = await resolveObject({ ...authorization });
    const bytes = Buffer.isBuffer(resolved) ? resolved : Buffer.from(resolved);
    if (bytes.length !== authorization.size || sha256Hex(bytes) !== authorization.sha256) {
      throw new Error("The local object does not match its authorized identity.");
    }

    await writeFrame(stream, FRAME.META, JSON.stringify({ sha256: authorization.sha256, size: authorization.size }));
    for (let offset = 0; offset < bytes.length; offset += MAX_FRAME_BYTES) {
      await writeFrame(stream, FRAME.CHUNK, bytes.subarray(offset, Math.min(offset + MAX_FRAME_BYTES, bytes.length)));
    }
    await writeFrame(stream, FRAME.EOF);
    stream.end();
    return { sha256: authorization.sha256, size: authorization.size };
  } catch (error) {
    if (!stream.destroyed && stream.writable) {
      try {
        await writeFrame(stream, FRAME.ERROR, JSON.stringify({ code: "TRANSFER_REJECTED" }));
        stream.end();
      } catch {}
    }
    throw error;
  }
}

export async function requestObject(stream, expected, { maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES } = {}) {
  validateObjectIdentity(expected, maxObjectBytes);
  const response = receiveObject(stream, expected, maxObjectBytes);
  try {
    await writeFrame(stream, FRAME.REQUEST, JSON.stringify(expected));
  } catch (error) {
    stream.destroy();
    response.catch(() => {});
    throw error;
  }
  return response;
}

function receiveObject(stream, expected, maxObjectBytes) {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    let metadataSeen = false;
    let receivedBytes = 0;
    const chunks = [];

    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
      stream.off("close", onClose);
    };
    const fail = (error) => {
      cleanup();
      if (!stream.destroyed) stream.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onEnd = () => fail(new Error("Native peer closed before completing the transfer."));
    const onClose = () => fail(new Error("Native peer connection closed before completing the transfer."));
    const onData = (chunk) => {
      try {
        pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
        while (pending.length >= HEADER_BYTES) {
          if (pending[0] !== MAGIC[0] || pending[1] !== MAGIC[1] || pending[2] !== VERSION) throw new Error("Invalid transfer frame header.");
          const type = pending[3];
          if (type < FRAME.REQUEST || type > FRAME.ERROR) throw new Error("Invalid transfer frame type.");
          const length = pending.readUInt32BE(4);
          if (length > MAX_FRAME_BYTES) throw new Error("Transfer frame is too large.");
          if (pending.length < HEADER_BYTES + length) return;
          const payload = pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
          pending = pending.subarray(HEADER_BYTES + length);

          if (type === FRAME.ERROR) throw new Error("Native peer rejected the transfer.");
          if (type === FRAME.META) {
            if (metadataSeen || receivedBytes !== 0) throw new Error("Unexpected transfer metadata.");
            const metadata = parseJsonObject(payload);
            if (metadata.sha256 !== expected.sha256 || metadata.size !== expected.size) {
              throw new Error("Native peer returned unexpected object metadata.");
            }
            metadataSeen = true;
            continue;
          }
          if (type === FRAME.CHUNK) {
            if (!metadataSeen) throw new Error("Object bytes arrived before metadata.");
            receivedBytes += payload.length;
            if (receivedBytes > expected.size || receivedBytes > maxObjectBytes) throw new Error("Native peer exceeded the expected object size.");
            chunks.push(Buffer.from(payload));
            continue;
          }
          if (type === FRAME.EOF) {
            if (payload.length !== 0 || !metadataSeen || receivedBytes !== expected.size) throw new Error("Native peer ended an incomplete transfer.");
            if (pending.length !== 0) throw new Error("Native peer sent data after the end of the transfer.");
            const bytes = Buffer.concat(chunks, receivedBytes);
            if (sha256Hex(bytes) !== expected.sha256) throw new Error("Native peer returned bytes with the wrong SHA-256 digest.");
            cleanup();
            stream.end();
            resolve(bytes);
            return;
          }
          throw new Error("Unexpected transfer frame.");
        }
      } catch (error) {
        fail(error);
      }
    };

    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
    stream.once("close", onClose);
  });
}
