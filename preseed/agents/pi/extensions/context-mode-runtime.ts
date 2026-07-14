import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTEXT_MODE_PACKAGE = "npm:context-mode@1.0.169";
export const CONTEXT_MODE_PACKAGE_ID = "npm:context-mode";
export const CONTEXT_MODE_ENABLED_PACKAGE = { source: CONTEXT_MODE_PACKAGE, extensions: [] } as const;
export const CONTEXT_MODE_DISABLED_PACKAGE = { source: CONTEXT_MODE_PACKAGE, extensions: [], skills: [] } as const;

export type ContextModePackageEntry = string | {
  source?: string;
  extensions?: string[];
  skills?: string[];
};

export type ContextModeSettings = {
  packages?: ContextModePackageEntry[];
};

type ContextModeLifecycleApi = {
  on(event: string, handler: () => void | Promise<void>): void;
};

type ContextModeInitializer = (pi: ContextModeLifecycleApi) => void | Promise<void>;

export type ContextModeOwnerRegistry = {
  owner?: symbol;
};

const CONTEXT_MODE_OWNER_KEY = Symbol.for("codeflare.context-mode.foreground-owner");
const DEFAULT_AGENT_DIR = join(homedir(), ".pi", "agent");

function packageSource(entry: ContextModePackageEntry | undefined): string | undefined {
  return typeof entry === "string" ? entry : entry?.source;
}

function packageIdentity(source: string): string {
  return source.replace(/@[^/@]+$/, "");
}

export function isContextModePackage(entry: ContextModePackageEntry | undefined): boolean {
  const source = packageSource(entry);
  return Boolean(source && packageIdentity(source) === CONTEXT_MODE_PACKAGE_ID);
}

export function contextModeEnabled(settings: ContextModeSettings): boolean {
  return (settings.packages ?? []).some((entry) => {
    if (!isContextModePackage(entry)) return false;
    if (typeof entry === "string") return true;
    return entry.skills === undefined;
  });
}

export function clearInheritedContextModeBridgeIdleOverride(): void {
  // context-mode chooses the root/subagent idle policy per session. A process-wide override would
  // disable reaping for every bridge and defeat the root-only ownership guard below.
  delete process.env.CONTEXT_MODE_BRIDGE_IDLE_MS;
}

export async function attachContextModeToForeground(
  registry: ContextModeOwnerRegistry,
  pi: ContextModeLifecycleApi,
  initialize: ContextModeInitializer,
): Promise<boolean> {
  if (registry.owner) return false;

  const owner = Symbol("context-mode-foreground");
  registry.owner = owner;
  try {
    await initialize(pi);
    pi.on("session_shutdown", () => {
      if (registry.owner === owner) delete registry.owner;
    });
    return true;
  } catch (error) {
    if (registry.owner === owner) delete registry.owner;
    throw error;
  }
}

function processOwnerRegistry(): ContextModeOwnerRegistry {
  const runtime = globalThis as typeof globalThis & {
    [CONTEXT_MODE_OWNER_KEY]?: ContextModeOwnerRegistry;
  };
  const existing = runtime[CONTEXT_MODE_OWNER_KEY];
  if (existing) return existing;
  const registry: ContextModeOwnerRegistry = {};
  runtime[CONTEXT_MODE_OWNER_KEY] = registry;
  return registry;
}

function readContextModeSettings(agentDir: string): ContextModeSettings {
  try {
    return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as ContextModeSettings;
  } catch {
    return {};
  }
}

export default async function (pi: ContextModeLifecycleApi): Promise<void> {
  clearInheritedContextModeBridgeIdleOverride();

  const agentDir = process.env.PI_AGENT_DIR || DEFAULT_AGENT_DIR;
  if (!contextModeEnabled(readContextModeSettings(agentDir))) return;

  await attachContextModeToForeground(processOwnerRegistry(), pi, async (api) => {
    const extensionPath = join(agentDir, "npm", "node_modules", "context-mode", "build", "adapters", "pi", "extension.js");
    const contextMode = await import(pathToFileURL(extensionPath).href) as { default?: ContextModeInitializer };
    if (typeof contextMode.default !== "function") {
      throw new Error(`context-mode Pi extension is unavailable at ${extensionPath}`);
    }
    await contextMode.default(api);
  });
}
