import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";

const FILE_LIMIT = 16384;
const invalid = () => new Error("Invalid ICE configuration; use bounded STUN/TURN URLs and browser credentials.");

function validateUrl(value) {
  if (typeof value !== "string" || value.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(value)) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!["stun:", "stuns:", "turn:", "turns:"].includes(url.protocol) || value.includes("#") || url.username || url.password || url.host) throw invalid();
  const match = /^(?:[a-z0-9.-]+|\[[a-f0-9:.]+\])(?::([0-9]+))?$/iu.exec(url.pathname);
  if (!match || match[1] && (Number(match[1]) < 1 || Number(match[1]) > 65535)) throw invalid();
  if (url.pathname.startsWith("[") && isIP(url.pathname.slice(1, url.pathname.indexOf("]"))) !== 6) throw invalid();
  const turn = url.protocol.startsWith("turn");
  if (value.includes("?") && (!turn || !/^\?transport=(?:udp|tcp)$/u.test(url.search))) throw invalid();
  return turn;
}

export function validateIceConfig(input) {
  if (!input || Array.isArray(input) || typeof input !== "object" || input.v !== 1
    || Object.keys(input).length !== 2 || !Object.hasOwn(input, "iceServers")
    || !Array.isArray(input.iceServers) || input.iceServers.length < 1 || input.iceServers.length > 8) throw invalid();
  return input.iceServers.map((server) => {
    if (!server || Array.isArray(server) || typeof server !== "object"
      || Object.keys(server).some((name) => !["urls", "username", "credential"].includes(name))) throw invalid();
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    if (urls.length < 1 || urls.length > 4) throw invalid();
    const transports = urls.map(validateUrl);
    const turn = transports.some(Boolean);
    if (turn && transports.some((value) => !value)) throw invalid();
    const credentials = (value) => typeof value === "string" && value.length >= 1 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/u.test(value);
    if (turn ? !credentials(server.username) || !credentials(server.credential)
      : Object.hasOwn(server, "username") || Object.hasOwn(server, "credential")) throw invalid();
    return { urls: Array.isArray(server.urls) ? [...urls] : urls[0], ...(turn ? { username: server.username, credential: server.credential } : {}) };
  });
}

export async function readIceConfigFile(path) {
  if (process.platform === "win32") throw new Error("Private ICE configuration requires POSIX permissions.");
  const target = resolve(path), parent = dirname(target);
  const directory = await lstat(parent);
  if (!directory.isDirectory() || await realpath(parent) !== parent || directory.mode & 0o022
    || process.getuid && directory.uid !== process.getuid()) throw new Error("ICE configuration needs an owner-controlled directory without symlinks.");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK || 0));
  const privateFile = (stat) => stat.isFile() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600
    && (!process.getuid || stat.uid === process.getuid()) && stat.size <= FILE_LIMIT;
  try {
    const before = await handle.stat();
    if (!privateFile(before)) throw new Error("ICE configuration must be an owner-only 0600 regular file of at most 16 KiB.");
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(), current = await lstat(target);
    const unchanged = (stat) => privateFile(stat) && stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
      && stat.mtimeMs === before.mtimeMs && stat.ctimeMs === before.ctimeMs;
    if (bytesRead !== before.size || !unchanged(after) || !unchanged(current)) throw new Error("ICE configuration changed while reading.");
    let input;
    try { input = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); } catch { throw invalid(); }
    return validateIceConfig(input);
  } finally { await handle.close(); }
}
