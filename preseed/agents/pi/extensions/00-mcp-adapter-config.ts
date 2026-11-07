import { constants, closeSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { randomUUID } from "node:crypto";
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
  // These exact public defaults are part of the managed constructor, not
  // permission to discard custom per-server policy or authentication fields.
  if (value.requestTimeoutMs !== undefined && value.requestTimeoutMs !== 360000
    || value.idleTimeout !== undefined && value.idleTimeout !== 10
    || value.directTools !== undefined && value.directTools !== "search") return false;
  const managedFields = ["requestTimeoutMs", "idleTimeout", "directTools"];
  if (name === "chrome-devtools") {
    const args = value.args;
    if (!Object.keys(value).every(key => ["command", "args", "lifecycle", ...managedFields].includes(key))
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
  return Object.keys(value).every(key => ["command", "args", "env", "lifecycle", ...managedFields].includes(key))
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
      // Browser inactivity is independent of the six-minute request timeout.
      // SDK progress notifications may reset that timeout; it is not a total deadline.
      if (url.searchParams.getAll("keep_alive").length === 1 && url.searchParams.get("keep_alive") === "1200000") return arg;
      url.searchParams.set("keep_alive", "1200000"); changed = true;
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

// The credential-free ownership marker has the same public {name,url} contract
// as the managed portal reconciler. It is not authority to read an auth store.
function validPortalMarker(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  const destinations = new Set<string>();
  return value.every(portal => {
    if (!portal || typeof portal !== "object" || Array.isArray(portal)
      || Object.keys(portal).sort().join(",") !== "name,url"
      || typeof portal.name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(portal.name)
      || names.has(portal.name) || typeof portal.url !== "string" || portal.url.length > 512
      || !/^https:\/\//i.test(portal.url) || /[\s\u0000-\u001f\u007f]/.test(portal.url)
      || portal.url.split("/")[2]?.includes("@")) return false;
    try {
      const url = new URL(portal.url);
      if (url.protocol !== "https:" || url.username || url.password || portal.url.includes("#")
        || url.port && url.port !== "443" || !url.hostname.includes(".")
        || [".local", ".internal", ".localhost"].some(suffix => url.hostname.endsWith(suffix))
        || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")
        || [...url.searchParams].some(([key, entry]) => key !== "codemode" || entry !== "search_and_execute")
        || url.searchParams.getAll("codemode").length > 1 || destinations.has(url.href)) return false;
      names.add(portal.name); destinations.add(url.href);
      return true;
    } catch { return false; }
  });
}

// Only translate the shared, evidenced public subset. Unknown stock fields may
// change security or execution semantics and must not be silently dropped.
function stockToAdapter(value: Config): Config {
  const record = (entry: unknown): entry is Record<string, unknown> =>
    !!entry && typeof entry === "object" && !Array.isArray(entry);
  if (!Object.keys(value).every(key => ["mcpServers", "settings", "_codeflareMcpPortals"].includes(key))) throw Error("Unsupported schema");
  if (value._codeflareMcpPortals !== undefined && !validPortalMarker(value._codeflareMcpPortals)) throw Error("Invalid ownership marker");
  if (value.settings !== undefined && (!record(value.settings)
    || !Object.entries(value.settings).every(([key, entry]) =>
      key === "requestTimeoutMs" && typeof entry === "number" && Number.isFinite(entry) && entry > 0
      || key === "deferWithMissingMetadata" && typeof entry === "boolean"))) throw Error("Unsupported settings");
  const literal = (entry: unknown, secret = false): string => {
    if (typeof entry !== "string" || /\$\{|\$env:|\{env:/.test(entry)
      || entry.startsWith("~")) throw Error("Unsupported expression");
    // Old env/headers reserve ! for command secrets. Escape stock literals once.
    return secret && entry.startsWith("!") ? `!${entry}` : entry;
  };
  const servers: Record<string, unknown> = Object.create(null);
  for (const [name, candidate] of Object.entries(value.mcpServers || {})) {
    if (!record(candidate) || !Object.keys(candidate).every(key => ["command", "args", "env", "cwd", "url", "headers",
      "caFile", "lifecycle", "requestTimeoutMs", "transport", "type"].includes(key))) throw Error("Unsupported server");
    const server = { ...candidate };
    const stdio = typeof server.command === "string" && server.command.length > 0;
    const remote = typeof server.url === "string" && server.url.length > 0;
    if (stdio === remote) throw Error("Ambiguous transport");
    if (server.transport !== undefined && server.type !== undefined && server.transport !== server.type) throw Error("Ambiguous transport");
    const transport = server.transport ?? server.type;
    if (transport !== undefined && !(stdio ? transport === "stdio" : ["http", "streamable-http", "sse"].includes(transport as string))) throw Error("Unsupported transport");
    delete server.transport; delete server.type;
    if (stdio && (server.headers !== undefined || server.caFile !== undefined)
      || remote && ["args", "env", "cwd"].some(key => server[key] !== undefined)) throw Error("Ambiguous transport");
    for (const key of ["command", "cwd", "url", "caFile"]) if (server[key] !== undefined) server[key] = literal(server[key]);
    if (server.args !== undefined) {
      if (!Array.isArray(server.args)) throw Error("Invalid arguments");
      server.args = server.args.map(entry => literal(entry));
    }
    for (const key of ["env", "headers"]) if (server[key] !== undefined) {
      if (!record(server[key])) throw Error("Invalid secret map");
      server[key] = Object.fromEntries(Object.entries(server[key]).map(([key, entry]) => [key, literal(entry, true)]));
    }
    if (server.lifecycle !== undefined && !["lazy", "eager"].includes(server.lifecycle as string)) throw Error("Unsupported lifecycle");
    if (server.requestTimeoutMs !== undefined && (typeof server.requestTimeoutMs !== "number"
      || !Number.isFinite(server.requestTimeoutMs) || server.requestTimeoutMs <= 0)) throw Error("Invalid timeout");
    if (remote) {
      server.httpTransport = transport === "sse" ? "sse" : "streamable-http";
      // Stock entries without explicit OAuth must not enable old auto-OAuth.
      server.auth = false;
    }
    Object.defineProperty(servers, name, { value: server, enumerable: true, writable: true, configurable: true });
  }
  return { ...(value.settings === undefined ? {} : { settings: value.settings }), mcpServers: servers,
    ...(value._codeflareMcpPortals === undefined ? {} : { _codeflareMcpPortals: value._codeflareMcpPortals }) };
}

// Native handoff never reads auth stores or evaluates expressions. Only an
// active stock file is an input; its exact archive is passive recovery, not state.
// A conflicting server/settings key is not authority to choose a winner.
export function preparePiMcpAdapterConfig(directory: string, regenerateManaged = false): boolean {
  let temporary: string | undefined;
  try {
    if (!isAbsolute(directory)) return false;
    const parents: { path: string; info: Stats }[] = [];
    for (let path = resolve(directory); ; path = dirname(path)) {
      const info = stat(path);
      if (!info?.isDirectory() || info.isSymbolicLink()) return false;
      parents.push({ path, info });
      if (dirname(path) === path) break;
    }
    const nativePath = join(directory, "mcp-adapter.json");
    const stockPath = join(directory, "mcp.json");
    const native = read(nativePath);
    const stock = read(stockPath);
    const selection = read(join(directory, "settings.json"));
    const nativeConfig: Config | undefined = native ? config(native.bytes) : {};
    const stockConfig = stock ? config(stock.bytes) : undefined;
    if (!nativeConfig || stock && !stockConfig) return false;
    const value = nativeConfig;
    if (value._codeflareMcpPortals !== undefined && !validPortalMarker(value._codeflareMcpPortals)) return false;
    for (const candidate of Object.values(value.mcpServers || {})) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const server = candidate as Record<string, unknown>;
      if ([server.command, server.url, server.socket].filter(entry => typeof entry === "string" && entry.length > 0).length !== 1) return false;
      if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(entry => typeof entry === "string"))) return false;
      for (const key of ["env", "headers"]) if (server[key] !== undefined && (!server[key] || typeof server[key] !== "object"
        || Array.isArray(server[key]) || !Object.values(server[key]).every(entry => typeof entry === "string"))) return false;
    }
    if (value.settings !== undefined && (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings))) return false;
    const prepareNativeTimeouts = (selected: Config) => {
      prepareBrowserTimeouts(selected);
      const browser = selected.mcpServers?.["chrome-devtools"];
      if (browser && typeof browser === "object" && !Array.isArray(browser)) {
        const entry = browser as Record<string, unknown>;
        entry.requestTimeoutMs = 360000;
        if (entry.lifecycle === undefined) entry.lifecycle = "lazy";
      }
    };
    if (stockConfig) {
      const translated = stockToAdapter(stockConfig);
      if (translated._codeflareMcpPortals !== undefined) {
        if (value._codeflareMcpPortals !== undefined
          && JSON.stringify(value._codeflareMcpPortals) !== JSON.stringify(translated._codeflareMcpPortals)) return false;
        value._codeflareMcpPortals = translated._codeflareMcpPortals;
      }
      for (const key of ["settings", "mcpServers"] as const) {
        const incoming = translated[key] as Record<string, unknown> | undefined;
        const current = value[key] as Record<string, unknown> | undefined;
        for (const [name, entry] of Object.entries(incoming || {})) {
          if (key === "settings" && name === "requestTimeoutMs") continue;
          if (current && Object.hasOwn(current, name) && JSON.stringify(current[name]) !== JSON.stringify(entry)) return false;
        }
        if (incoming) value[key] = { ...incoming, ...current };
      }
    }
    // Startup refreshes only positively recognized image constructors. Check
    // ownership before timeout normalization could hide a custom policy value.
    if (regenerateManaged) {
      for (const name of Object.keys(ownedCommands())) {
        if (ownedServer(name, value.mcpServers?.[name])) delete value.mcpServers![name];
      }
    }
    prepareNativeTimeouts(value);
    // The adapter otherwise warms cold lazy catalogues during startup. Default
    // only after merging so an explicit stock or native false remains authoritative.
    const settings = value.settings as Record<string, unknown>;
    if (!Object.hasOwn(settings, "deferWithMissingMetadata")) settings.deferWithMissingMetadata = true;
    // requestTimeoutMs is public in 5.3.1; idleTimeout is MINUTES (default 10).
    // Leave custom idle and unrelated per-server timeout overrides untouched.
    const sameNative = native && JSON.stringify(config(native.bytes)) === JSON.stringify(value);
    const bytes = sameNative ? native.bytes : Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    const inputsSafe = () => parents.every(({ path, info }) => {
      const current = stat(path);
      return current?.isDirectory() && current.dev === info.dev && current.ino === info.ino;
    }) && (stock ? unchanged(stock) : !stat(stockPath))
      && (selection ? unchanged(selection) : !stat(join(directory, "settings.json")));
    const safe = () => inputsSafe() && (native ? unchanged(native) : !stat(nativePath));
    if (!safe()) return false;
    if (!sameNative) {
      temporary = join(directory, `.mcp-adapter.${randomUUID()}.tmp`);
      writeFileSync(temporary, bytes, { flag: "wx", mode: native ? native.info.mode & 0o777 : 0o600 });
      if (!safe()) return false;
    }
    // Preserve the exact active source before either committing or retiring it.
    if (stock) preserve(stock, `${stockPath}.migrated`);
    if (!safe()) return false;
    if (!sameNative) {
      if (native) preserve(native, `${nativePath}.migrated`);
      if (!safe()) return false;
      if (native) renameSync(temporary!, nativePath);
      else linkSync(temporary!, nativePath); // Atomic no-clobber creation.
    }
    const prepared = read(nativePath);
    if (!prepared || !prepared.bytes.equals(bytes) || !unchanged(prepared) || !inputsSafe()) return false;
    if (stock) unlinkSync(stockPath);
    return true;
  } catch { return false; }
  finally {
    if (temporary) { try { unlinkSync(temporary); } catch { /* Renamed or already absent. */ } }
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
      const rawSource = selection.replace(/^[!+-]/, "");
      // Pi resolves exact global exclusions relative to the agent directory.
      // Unknown negative patterns can disable a client too: fail closed rather
      // than treating an unsupported filter as positive selection evidence.
      if (negative && /[*?\[\]{}]/.test(rawSource)) { uncertain = true; continue; }
      const source = negative && !isAbsolute(rawSource) ? resolve(directory, rawSource) : rawSource;
      // These exact managed exclusions disable non-client extensions only.
      // Settled startup adds the Review pair after curation delivery; neither
      // can exclude a client's package entrypoint. Keep other negatives closed.
      if (negative && ["mcp-portal-oauth.ts", "review-enforcement.ts", "operator-review-remote.ts"]
        .some(name => source === join(directory, "extensions", name)
          || source === join("/home/user/.pi/agent/extensions", name))) continue;
      const known = identify(source);
      if (known) {
        const path = isAbsolute(source)
          ? (source.endsWith(`/${known.entry}`) ? source : `${source}/${known.entry}`) : undefined;
        if (negative) {
          // A root/directory or npm exclusion is not an exact extension path.
          if (!path || path !== source) uncertain = true;
          else excluded.add(path);
        } else registrations.push({ client: known.client, path });
      } else if (negative || /mcp/i.test(source)) uncertain = true;
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
  if (!client) {
    pi.on?.("session_start", (_event, ctx) => {
      ctx.ui.notify("MCP config handoff skipped: client selection is ambiguous or unknown; configuration files were preserved. Inspect global package and extension selections.", "warning");
    });
    return;
  }
  if (!(client === "adapter" ? preparePiMcpAdapterConfig(directory) : migratePiMcpAdapterConfig(directory, false, true))) {
    pi.on?.("session_start", (_event, ctx) => {
      ctx.ui.notify("MCP config handoff skipped: inspect legacy environment expressions and configuration paths; user data was preserved.", "warning");
    });
  }
}
