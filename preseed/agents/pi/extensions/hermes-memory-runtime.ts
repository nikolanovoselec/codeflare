import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isChildSessionHeader } from "./memory-vault-helpers";

type MemoryContext = {
  sessionManager?: { getHeader?: () => unknown };
};
type MemoryPi = {
  on(event: string, handler: (event: any, ctx: MemoryContext) => unknown): unknown;
};
type Initializer = (pi: MemoryPi) => void | Promise<void>;
export type HermesOwnerRegistry = { owner?: symbol };
const OWNER_KEY = Symbol.for("codeflare.hermes-memory.foreground-owner");

export async function attachHermesMemoryToForeground(
  registry: HermesOwnerRegistry,
  pi: MemoryPi,
  initialize: Initializer,
): Promise<boolean> {
  if (registry.owner) return false;
  const owner = Symbol("hermes-foreground");
  registry.owner = owner;
  try {
    await initialize(pi);
    // Registered after stock handlers so another session cannot take ownership
    // while upstream is still flushing or closing its database.
    pi.on("session_shutdown", () => {
      if (registry.owner === owner) delete registry.owner;
    });
    return true;
  } catch (error) {
    if (registry.owner === owner) delete registry.owner;
    throw error;
  }
}

function childSession(ctx: MemoryContext): boolean {
  return isChildSessionHeader(ctx.sessionManager?.getHeader?.());
}

function exactLink(path: string, target: string): boolean {
  try { return lstatSync(path).isSymbolicLink() && resolve(path, "..", readlinkSync(path)) === target; }
  catch { return false; }
}

function preparedLayout(home: string, agentDir: string): { owners: string; consolidationLocks: string } {
  const cache = join(home, ".cache", "pi-hermes-memory");
  const sessionId = process.env.SESSION_ID;
  const admission = process.env.CODEFLARE_HERMES_PERSISTENCE;
  if (!sessionId || !/^[a-z0-9]{8,24}$/.test(sessionId) || (admission !== "new" && admission !== "existing")) {
    throw new Error("session memory is not admitted");
  }
  const ready = join(process.env.CODEFLARE_RUNTIME_ROOT || "/run/codeflare", "sync", "hermes-ready");
  if (!lstatSync(ready).isFile() || readFileSync(ready, "utf8") !== `direct:${sessionId}\n`) {
    throw new Error("session memory restore is not complete");
  }
  const store = join(home, "Vault", "Memory", "Sessions", sessionId);
  const global = join(store, "global");
  const projects = join(store, "Projects");
  const workspace = join(projects, "workspace");
  const owners = join(cache, "owners");
  const consolidationLocks = join(cache, "consolidation-locks");
  for (const directory of [global, workspace, agentDir, owners, consolidationLocks]) {
    if (realpathSync(directory) !== resolve(directory)) throw new Error("managed memory directory ownership is unsafe");
  }
  const sessionFile = join(store, "session-id");
  const configFile = join(agentDir, "hermes-memory-config.json");
  if (!lstatSync(sessionFile).isFile() || !lstatSync(configFile).isFile()
    || readFileSync(sessionFile, "utf8") !== `${sessionId}\n`) throw new Error("session memory is not prepared");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  if (!config || Array.isArray(config) || config.memoryMode !== "policy-only" || config.lazyInitialization !== true
    || config.memoryDir !== global || config.projectsMemoryDir !== "hermes-project-memory") {
    throw new Error("managed memory configuration is not ready");
  }
  for (const file of [join(global, "USER.md"), join(global, "MEMORY.md"), join(global, "failures.md"), join(workspace, "MEMORY.md")]) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("session memory paths are not ready");
  }
  if (!exactLink(join(agentDir, "hermes-project-memory"), projects)) {
    throw new Error("managed project memory is not ready");
  }
  return { owners, consolidationLocks };
}

function workspaceMemoryApi(pi: ExtensionAPI, cwd: string): ExtensionAPI {
  // Scope only Hermes's public callbacks. The actual session and every other
  // extension/tool retain their real cwd, including sessions opened in clones.
  const context = <T extends object>(ctx: T): T & { cwd: string } => Object.create(
    Object.getPrototypeOf(ctx),
    { ...Object.getOwnPropertyDescriptors(ctx), cwd: { value: cwd, enumerable: true, configurable: true } },
  );
  const on = pi.on as unknown as MemoryPi["on"];
  return {
    ...pi,
    on: ((event: string, handler: (event: unknown, ctx: MemoryContext) => unknown) =>
      on.call(pi, event, (value, ctx) => handler(value, context(ctx)))) as ExtensionAPI["on"],
    registerTool(definition) {
      pi.registerTool({ ...definition, execute(id, params, signal, update, ctx) {
        return definition.execute(id, params, signal, update, context(ctx));
      } });
    },
    registerCommand(name, command) {
      pi.registerCommand(name, { ...command, handler(args, ctx) {
        return command.handler(args, context(ctx));
      } });
    },
  };
}

function processStartTime(): string {
  const stat = readFileSync("/proc/self/stat", "utf8");
  const value = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
  if (!/^\d+$/.test(value ?? "")) throw new Error("Pi process identity is unavailable");
  return value;
}

export default async function hermesMemoryRuntime(pi: ExtensionAPI): Promise<void> {
  const home = homedir();
  const agentDir = process.env.PI_CODING_AGENT_DIR || process.env.PI_AGENT_DIR || join(home, ".pi", "agent");
  const state = globalThis as typeof globalThis & { [OWNER_KEY]?: HermesOwnerRegistry };
  const registry = state[OWNER_KEY] ??= {};
  if (registry.owner) return;
  try {
    const layout = preparedLayout(home, agentDir);
    await attachHermesMemoryToForeground(registry, pi as unknown as MemoryPi, async () => {
      const entry = join(agentDir, "npm", "node_modules", "pi-hermes-memory", "src", "index.ts");
      // Qualify the installed binding before upstream can enter its optional
      // ABI-repair path. Missing/incompatible images must not install at runtime.
      const Database = createRequire(entry)("better-sqlite3");
      const probe = new Database(":memory:");
      probe.close();
      const upstream = await import(pathToFileURL(entry).href);
      if (typeof upstream.default !== "function") throw new Error("stock Hermes entrypoint is unavailable");
      // The stock option keeps consolidation locks off the durable paths
      // without a second alias in the agent directory.
      process.env.PI_HERMES_CONSOLIDATION_LOCK_DIR = layout.consolidationLocks;
      await upstream.default(workspaceMemoryApi(pi, join(home, "workspace")));
      let receipt: string | undefined;
      pi.on("session_start", (_event, ctx) => {
        if (ctx.mode !== "tui" || childSession(ctx)) return;
        mkdirSync(layout.owners, { recursive: true, mode: 0o700 });
        if (realpathSync(layout.owners) !== resolve(layout.owners)) throw new Error("memory owner directory is unsafe");
        receipt = join(layout.owners, `${process.pid}.json`);
        const temporary = `${receipt}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, JSON.stringify({ pid: process.pid, startTime: processStartTime() }), { mode: 0o600, flag: "wx" });
          renameSync(temporary, receipt);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
      });
      pi.on("session_shutdown", () => {
        if (receipt && existsSync(receipt)) unlinkSync(receipt);
      });
    });
  } catch {
    // Do not echo malformed configuration or provider values into diagnostics.
    // No fallback to an unexcluded store or runtime npm installation.
    console.warn("[hermes-memory] Memory unavailable: configuration, cache paths or the installed package are not ready");
  }
}
