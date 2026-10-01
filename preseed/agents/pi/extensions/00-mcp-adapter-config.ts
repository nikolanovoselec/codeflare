import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function stat(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validConfig(bytes: Buffer): boolean {
  const config = JSON.parse(bytes.toString("utf8"));
  return config !== null && typeof config === "object" && !Array.isArray(config)
    && (config.mcpServers === undefined || (config.mcpServers !== null
      && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)));
}

// Adapter 3.x uses the unchanged schema at a new filename. Never merge two user
// configurations or allow managed retirement to discard the legacy credentials.
export function migratePiMcpAdapterConfig(directory: string): boolean {
  let fd: number | undefined;
  try {
    if (!isAbsolute(directory)) return false;
    for (let path = resolve(directory); ; path = dirname(path)) {
      const info = stat(path);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return false;
      if (dirname(path) === path) break;
    }
    const legacy = join(directory, "mcp.json");
    const target = join(directory, "mcp-adapter.json");
    const targetStat = stat(target);
    if (targetStat) {
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) return false;
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      return validConfig(readFileSync(fd));
    }
    const legacyStat = stat(legacy);
    if (!legacyStat) return true;
    if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) return false;
    fd = openSync(legacy, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    const bytes = readFileSync(fd);
    if (!validConfig(bytes)) return false;
    // Exclusive creation is the no-clobber boundary, including concurrent loads.
    writeFileSync(target, bytes, { flag: "wx", mode: opened.mode & 0o777 });
    const current = stat(legacy);
    if (current?.isFile() && current.dev === opened.dev && current.ino === opened.ino) unlinkSync(legacy);
    return true;
  } catch {
    // No config contents or credential-bearing parse errors reach notifications.
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

type ExtensionAPI = {
  on?(event: "session_start", handler: (event: unknown, ctx: { ui: { notify(message: string, level: "warning"): void } }) => void): void;
};

export default function registerMcpAdapterMigration(pi: ExtensionAPI, env = process.env): void {
  // Factory-time migration precedes session_start consumers. Signed managed
  // delivery reaches existing images on the next Pi load or /reload.
  const directory = env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
  if (!migratePiMcpAdapterConfig(directory)) {
    pi.on?.("session_start", (_event, ctx) => {
      ctx.ui.notify("MCP adapter config migration skipped: inspect legacy and adapter files; user data was preserved.", "warning");
    });
  }
}
