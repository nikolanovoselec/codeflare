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
        .every(([key, entry]) => key === "deferWithMissingMetadata" && entry === true
          || key === "requestTimeoutMs" && entry === 360000)))
    && Object.entries(value.mcpServers || {}).every(([name, server]) => ownedServer(name, server));
}

// The replacement supports eager/lazy, not the old idle-disconnecting variants.
// Convert only known old values; unknown custom values are not silently reinterpreted.
function prepareLifecycles(value: Config): boolean {
  let changed = false;
  for (const candidate of Object.values(value.mcpServers || {})) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const server = candidate as Record<string, unknown>;
    if (server.lifecycle === "lazy-keep-alive" || server.lifecycle === "lazy-keepalive") {
      server.lifecycle = "lazy"; changed = true;
    }
  }
  return changed;
}

// Old adapter utils.ts interpolates exactly these three forms and reserves a
// single leading ! for commands. The replacement's stdio env is literal. Never
// evaluate expressions during handoff; validate the entire selection before I/O.
function prepareLegacyStdioEnvironment(value: Config): boolean {
  let changed = false;
  for (const candidate of Object.values(value.mcpServers || {})) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const server = candidate as Record<string, unknown>;
    const transport = server.transport ?? server.type ?? (server.command ? "stdio" : undefined);
    if (transport !== "stdio" || !server.env || typeof server.env !== "object" || Array.isArray(server.env)) continue;
    const env = server.env as Record<string, unknown>;
    for (const [name, entry] of Object.entries(env)) {
      if (typeof entry !== "string") continue;
      const literal = entry.startsWith("!!") ? entry.slice(1) : entry;
      if ((entry.startsWith("!") && !entry.startsWith("!!"))
        || /\$\{\w+\}|\$env:\w+|\{env:\w+\}/.test(literal)) {
        throw Error("Unsupported legacy MCP environment expression");
      }
      if (literal !== entry) { env[name] = literal; changed = true; }
    }
  }
  return changed;
}

// Explicit timeout preparation follows config selection, never filename migration alone.
function prepareBrowserTimeouts(value: Config): boolean {
  if (value.settings !== undefined && (!value.settings || typeof value.settings !== "object"
    || Array.isArray(value.settings))) throw Error("Invalid MCP settings");
  const settings = (value.settings ?? {}) as Record<string, unknown>;
  let changed = settings.requestTimeoutMs !== 360000;
  settings.requestTimeoutMs = 360000;
  value.settings = settings;
  const candidate = value.mcpServers?.["chrome-devtools"];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return changed;
  const browser = candidate as Record<string, unknown>;
  if (Object.hasOwn(browser, "requestTimeoutMs") && browser.requestTimeoutMs !== 360000) {
    browser.requestTimeoutMs = 360000; changed = true;
  }
  if (Array.isArray(browser.args)) browser.args = browser.args.map(arg => {
    if (typeof arg !== "string" || !arg.startsWith("--wsEndpoint=")) return arg;
    try {
      const url = new URL(arg.slice("--wsEndpoint=".length));
      if (url.protocol !== "wss:" || url.hostname !== "api.cloudflare.com"
        || url.port || url.username || url.password
        || !/^\/client\/v4\/accounts\/[^/]+\/browser-rendering\/devtools\/browser$/.test(url.pathname)) return arg;
      if (url.searchParams.getAll("keep_alive").length === 1 && url.searchParams.get("keep_alive") === "360000") return arg;
      url.searchParams.set("keep_alive", "360000"); changed = true;
      return "--wsEndpoint=" + url.toString();
    } catch { return arg; }
  });
  return changed;
}

// Startup regenerates only positively owned entries; next-load preparation never regenerates auth.
export function migratePiMcpAdapterConfig(directory: string, regenerateManaged = false, prepareTimeouts = false): boolean {
  try {
    if (!isAbsolute(directory)) return false;
    for (let path = resolve(directory); ; path = dirname(path)) {
      const info = stat(path);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return false;
      if (dirname(path) === path) break;
    }
    const legacyPath = join(directory, "mcp-adapter.json");
    const targetPath = join(directory, "mcp.json");
    const target = read(targetPath);
    const legacy = read(legacyPath);
    if (!target && !legacy && !regenerateManaged && !prepareTimeouts) return true;
    const targetConfig = target && config(target.bytes);
    const legacyConfig = legacy && config(legacy.bytes);
    let bytes = targetConfig ? target!.bytes : legacyConfig ? legacy!.bytes : Buffer.from("{}\n");
    const selected = config(bytes)!;
    // Destination literals are already in the new schema: never decode them.
    // Reject unsupported selected legacy expressions before even archiving a
    // malformed destination, so a failed handoff cannot partially change files.
    const envChanged = !targetConfig && !!legacyConfig && prepareLegacyStdioEnvironment(selected);
    const lifecycleChanged = prepareLifecycles(selected);
    if (envChanged || lifecycleChanged) bytes = Buffer.from(`${JSON.stringify(selected, null, 2)}\n`);
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
        value.settings = {}; changed = true;
      }
      if (changed) bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    }
    if (prepareTimeouts) {
      const value = config(bytes)!;
      if (prepareBrowserTimeouts(value)) bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    }
    if (legacy && (!legacyConfig || (!managedOnly(legacyConfig)
      && (targetConfig || !legacy.bytes.equals(bytes))))) {
      preserve(legacy, `${legacyPath}.migrated`);
    }
    if (target && !target.bytes.equals(bytes)) {
      if (targetConfig && !managedOnly(targetConfig)) preserve(target, `${targetPath}.migrated`);
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

type McpClient = "stock" | "adapter";
// This is deliberately not Pi's glob resolver. Only known client entrypoints
// and exact resource filters qualify a destructive stock-schema handoff.
function configuredMcpClient(directory: string): McpClient | undefined {
  try {
    if (!isAbsolute(directory)) return undefined;
    for (let path = resolve(directory); ; path = dirname(path)) {
      const info = stat(path);
      if (info && (!info.isDirectory() || info.isSymbolicLink())) return undefined;
      if (dirname(path) === path) break;
    }
    const snapshot = read(join(directory, "settings.json"));
    const settings = snapshot && config(snapshot.bytes);
    if (!settings) return undefined;
    const packages = settings.packages === undefined ? [] : settings.packages;
    const extensions = settings.extensions === undefined ? [] : settings.extensions;
    if (!Array.isArray(packages) || !Array.isArray(extensions)
      || !extensions.every(entry => typeof entry === "string")) return undefined;
    const selected = new Set<McpClient>();
    const excluded = new Set<string>();
    const registrations: { client: McpClient; path?: string }[] = [];
    let uncertain = false;
    function identify(source: string): { client: McpClient; entry: string } | undefined {
      const npm = /^npm:(pi-mcp-extension|pi-mcp-adapter)(?:@\d+\.\d+\.\d+)?$/.exec(source);
      // No filesystem probing: installation is not evidence of selection.
      const local = isAbsolute(source) && resolve(source) === source
        ? /\/node_modules\/(pi-mcp-extension|pi-mcp-adapter)(?:\/(src\/index\.ts|index\.ts))?$/.exec(source) : null;
      const name = npm?.[1] || local?.[1];
      if (!name) return undefined;
      const entry = name === "pi-mcp-extension" ? "src/index.ts" : "index.ts";
      if (local?.[2] && local[2] !== entry) return undefined;
      return { client: name === "pi-mcp-extension" ? "stock" : "adapter", entry };
    }
    for (const candidate of packages) {
      const value = typeof candidate === "string" ? { source: candidate } : candidate;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || typeof value.source !== "string") return undefined;
      const known = identify(value.source);
      if (!known) {
        if (/mcp/i.test(value.source)) uncertain = true;
        continue;
      }
      // Project filtering deltas and unknown selection semantics are not proof.
      if (value.autoload !== undefined) { uncertain = true; continue; }
      const path = isAbsolute(value.source)
        ? (value.source.endsWith(`/${known.entry}`) ? value.source : `${value.source}/${known.entry}`) : undefined;
      const filters = value.extensions;
      if (filters === undefined) { registrations.push({ client: known.client, path }); continue; }
      if (!Array.isArray(filters) || !filters.every(filter => typeof filter === "string")) return undefined;
      if (filters.length === 0) continue;
      const exact = (filter: string) => filter.replace(/^[!+-]/, "").replace(/^\.\//, "") === known.entry;
      if (!filters.every(exact)) { uncertain = true; continue; }
      if (!filters.some(filter => filter.startsWith("-"))
        && (!filters.some(filter => filter.startsWith("!")) || filters.some(filter => filter.startsWith("+")))) registrations.push({ client: known.client, path });
    }
    for (const selection of extensions as string[]) {
      if (selection === "-builtin:mcp") continue;
      // Global glob overrides need Pi's full resolver; do not infer ownership.
      if (selection.startsWith("!")) { uncertain = true; continue; }
      const negative = selection.startsWith("-");
      const source = selection.replace(/^[!+-]/, "");
      const known = identify(source);
      if (known) {
        const path = isAbsolute(source)
          ? (source.endsWith(`/${known.entry}`) ? source : `${source}/${known.entry}`) : undefined;
        if (negative) {
          // A root/directory or npm exclusion is not an exact extension path.
          if (!path || path !== source) uncertain = true;
          else excluded.add(path);
        } else registrations.push({ client: known.client, path });
      } else if (!negative && /mcp/i.test(source)) uncertain = true;
    }
    for (const registration of registrations) {
      if (registration.path && excluded.has(registration.path)) continue;
      // npm installation roots may differ across images. A path exclusion is
      // not proof that an npm registration was disabled.
      if (!registration.path && [...excluded].some(path => identify(path)?.client === registration.client)) uncertain = true;
      selected.add(registration.client);
    }
    return !uncertain && selected.size === 1 ? [...selected][0] : undefined;
  } catch { return undefined; }
}

type ExtensionAPI = {
  on?(event: "session_start", handler: (event: unknown, ctx: { ui: { notify(message: string, level: "warning"): void } }) => void): void;
};
export default function registerMcpAdapterMigration(pi: ExtensionAPI, env = process.env): void {
  const directory = env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent");
  const client = configuredMcpClient(directory);
  if (client === "adapter") return;
  if (!client) {
    pi.on?.("session_start", (_event, ctx) => {
      ctx.ui.notify("MCP config handoff skipped: client selection is ambiguous or unknown; configuration files were preserved. Inspect global package and extension selections.", "warning");
    });
    return;
  }
  if (!migratePiMcpAdapterConfig(directory, false, true)) {
    pi.on?.("session_start", (_event, ctx) => {
      ctx.ui.notify("MCP config handoff skipped: inspect legacy environment expressions and configuration paths; user data was preserved.", "warning");
    });
  }
}
