import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

function stat(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

type Config = Record<string, unknown> & { mcpServers?: Record<string, unknown> };
type Snapshot = { path: string; bytes: Buffer; info: Stats };
function config(bytes: Buffer): Config | undefined {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && (value.mcpServers === undefined || (value.mcpServers !== null
        && typeof value.mcpServers === "object" && !Array.isArray(value.mcpServers))) ? value : undefined;
  } catch { return undefined; }
}
function unchanged(snapshot: Snapshot): boolean {
  const current = stat(snapshot.path);
  const old = snapshot.info;
  return !!current?.isFile() && current.dev === old.dev && current.ino === old.ino
    && current.size === old.size && current.mtimeMs === old.mtimeMs && current.ctimeMs === old.ctimeMs;
}
function read(path: string): Snapshot | undefined {
  const info = stat(path);
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink()) throw Error("Unsafe config path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw Error("Config changed");
    const snapshot = { path, info: opened, bytes: readFileSync(fd) };
    if (!unchanged(snapshot)) throw Error("Config changed");
    return snapshot;
  } finally { closeSync(fd); }
}

// Unknown/custom originals survive outside active config names. Passive archive
// collisions never overwrite data or prevent ordinary startup preparation.
function preserve(snapshot: Snapshot, prefix: string): void {
  for (let suffix = 0; ; suffix++) {
    const path = suffix ? `${prefix}.${suffix}` : prefix;
    const info = stat(path);
    if (info) {
      if (info.isFile() && !info.isSymbolicLink() && info.size === snapshot.bytes.length) {
        try {
          const saved = read(path);
          if (saved?.bytes.equals(snapshot.bytes) && unchanged(saved)) return;
        } catch { /* Unreadable or changing passive archives are not active config authority. */ }
      }
      continue;
    }
    try { writeFileSync(path, snapshot.bytes, { flag: "wx", mode: snapshot.info.mode & 0o777 }); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}
const ownedCommands = () => ({ "consult-llm": "consult-llm-mcp",
  "chrome-devtools": process.env.CHROME_DEVTOOLS_MCP_BIN || "/opt/codeflare/bin/chrome-devtools-mcp" });
function ownedServer(name: string, server: unknown): boolean {
  if (!server || typeof server !== "object" || Array.isArray(server)) return false;
  const value = server as Record<string, unknown>;
  const command = Object.entries(ownedCommands()).find(([owned]) => name === owned)?.[1];
  if (!command || value.command !== command) return false;
  if (name === "chrome-devtools") {
    const args = value.args;
    if (!Object.keys(value).every(key => ["command", "args", "lifecycle"].includes(key))
      || (value.lifecycle !== undefined && value.lifecycle !== "lazy")
      || !Array.isArray(args) || args.length !== 2) return false;
    const endpoint = args.find(arg => typeof arg === "string" && arg.startsWith("--wsEndpoint="));
    const headers = args.find(arg => typeof arg === "string" && arg.startsWith("--wsHeaders="));
    if (!endpoint || !/^--wsEndpoint=wss:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[^/]+\/browser-rendering\/devtools\/browser(?:\?|$)/.test(endpoint) || !headers) return false;
    try {
      const value = JSON.parse(headers.slice("--wsHeaders=".length));
      return value !== null && typeof value === "object" && Object.keys(value).length === 1
        && typeof value.Authorization === "string" && value.Authorization.startsWith("Bearer ");
    } catch { return false; }
  }
  const env = value.env;
  return Object.keys(value).every(key => ["command", "args", "env", "lifecycle"].includes(key))
    && (value.args === undefined || (Array.isArray(value.args) && value.args.length === 0))
    && (value.lifecycle === undefined || value.lifecycle === "lazy")
    && (env === undefined || (!!env && typeof env === "object" && !Array.isArray(env)
      && Object.entries(env).every(([key, entry]) => typeof entry === "string" && ["OPENAI_API_KEY", "GEMINI_API_KEY",
        "CONSULT_LLM_OPENAI_BACKEND", "CONSULT_LLM_CODEX_REASONING_EFFORT"].includes(key))));
}
function managedOnly(value: Config): boolean {
  return Object.keys(value).every(key => key === "mcpServers" || key === "settings")
    && (value.settings === undefined || (value.settings !== null && typeof value.settings === "object"
      && !Array.isArray(value.settings) && Object.entries(value.settings)
        .every(([key, entry]) => key === "deferWithMissingMetadata" && entry === true)))
    && Object.entries(value.mcpServers || {}).every(([name, server]) => ownedServer(name, server));
}

// Startup regenerates reproducible owned entries with the existing constructors;
// factory-time preparation leaves working entries intact on Pi load or /reload.
export function migratePiMcpAdapterConfig(directory: string, regenerateManaged = false): boolean {
  try {
    if (!isAbsolute(directory)) return false;
    for (let path = resolve(directory); ; path = dirname(path)) {
      const info = stat(path);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return false;
      if (dirname(path) === path) break;
    }
    const legacyPath = join(directory, "mcp.json");
    const targetPath = join(directory, "mcp-adapter.json");
    const target = read(targetPath);
    const legacy = read(legacyPath);
    if (!target && !legacy && !regenerateManaged) return true;
    const targetConfig = target && config(target.bytes);
    const legacyConfig = legacy && config(legacy.bytes);
    let bytes = targetConfig ? target!.bytes : legacyConfig ? legacy!.bytes : Buffer.from("{}\n");
    if (target && !targetConfig) preserve(target, `${targetPath}.invalid`);
    if (regenerateManaged) {
      const value = config(bytes)!;
      let changed = false;
      for (const name of Object.keys(ownedCommands())) {
        if (ownedServer(name, value.mcpServers?.[name])) {
          delete value.mcpServers![name]; changed = true;
        }
      }
      if (!targetConfig && !legacyConfig) {
        value.settings = { deferWithMissingMetadata: true }; changed = true;
      }
      if (changed) bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    }
    if (legacy && (!legacyConfig || (!managedOnly(legacyConfig)
      && (targetConfig || !legacy.bytes.equals(bytes))))) {
      preserve(legacy, `${legacyPath}.migrated`);
    }
    if (target && !target.bytes.equals(bytes)) {
      if (!unchanged(target)) return false;
      unlinkSync(targetPath);
    }
    if (!target || !target.bytes.equals(bytes)) writeFileSync(targetPath, bytes, {
      flag: "wx", mode: (targetConfig ? target!.info.mode : legacyConfig ? legacy!.info.mode : 0o600) & 0o777,
    });
    const prepared = read(targetPath);
    if (!prepared || !config(prepared.bytes)
      || (target && target.bytes.equals(bytes) && !unchanged(target))) return false;
    if (legacy) {
      if (!unchanged(legacy)) return false;
      unlinkSync(legacyPath);
    }
    return true;
  } catch {
    // Never include config contents or credential-bearing parse errors.
    return false;
  }
}

type ExtensionAPI = {
  on?(event: "session_start", handler: (event: unknown, ctx: { ui: { notify(message: string, level: "warning"): void } }) => void): void;
};
export default function registerMcpAdapterMigration(pi: ExtensionAPI, env = process.env): void {
  const directory = env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
  if (!migratePiMcpAdapterConfig(directory)) {
    pi.on?.("session_start", (_event, ctx) => {
      ctx.ui.notify("MCP adapter config migration skipped: inspect legacy and adapter files; user data was preserved.", "warning");
    });
  }
}
