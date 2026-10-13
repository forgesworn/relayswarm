import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Physical path identity keeps CLI entry points working through path aliases. */
export async function isCliEntry(moduleUrl, entry = process.argv[1]) {
  if (typeof entry !== "string" || !entry) return false;
  try {
    const [command, module] = await Promise.all([realpath(entry), realpath(fileURLToPath(moduleUrl))]);
    return command === module;
  } catch { return false; }
}
