import { readFileSync, writeFileSync } from "node:fs";
import {
  CONTEXT_MODE_DISABLED_PACKAGE,
  CONTEXT_MODE_ENABLED_PACKAGE,
  contextModeEnabled,
  isContextModePackage,
} from "./context-mode-runtime";

const PI_SETTINGS_FILE = "/home/user/.pi/agent/settings.json";

type NotifyLevel = "info" | "warning" | "error";

type ExtensionCommandContext = {
  ui: { notify(message: string, level?: NotifyLevel): void };
  reload(): Promise<void>;
};

type ExtensionAPI = {
  registerCommand(
    name: string,
    config: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
    },
  ): void;
};

export type PiSettings = {
  packages?: Array<string | { source?: string; extensions?: string[]; skills?: string[]; [key: string]: unknown }>;
  extensions?: string[];
  [key: string]: unknown;
};

export type PiSettingsStore = {
  read(): PiSettings;
  write(settings: PiSettings): void;
};

const PI_SETTINGS_STORE: PiSettingsStore = {
  read() {
    try {
      return JSON.parse(readFileSync(PI_SETTINGS_FILE, "utf8")) as PiSettings;
    } catch {
      return {};
    }
  },
  write(settings) {
    writeFileSync(PI_SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  },
};

export function setContextModeEnabled(
  enabled: boolean,
  store: PiSettingsStore = PI_SETTINGS_STORE,
): "enabled" | "disabled" {
  const settings = store.read();
  const packages = (settings.packages ?? []).filter((entry) => !isContextModePackage(entry));
  const contextModePackage = enabled ? CONTEXT_MODE_ENABLED_PACKAGE : CONTEXT_MODE_DISABLED_PACKAGE;
  packages.push({
    ...contextModePackage,
    extensions: [...contextModePackage.extensions],
    ...(enabled ? {} : { skills: [...CONTEXT_MODE_DISABLED_PACKAGE.skills] }),
  });
  store.write({ ...settings, packages });
  return enabled ? "enabled" : "disabled";
}

function contextModeStatusText(store: PiSettingsStore = PI_SETTINGS_STORE): string {
  const enabled = contextModeEnabled(store.read());
  return enabled
    ? "context-mode is enabled for Pi in this container. Use `/ctx off` to disable it and reload this Pi process; the next Codeflare container start restores the disabled default."
    : "context-mode is disabled for Pi in this container. Use `/ctx on` to enable it and reload this Pi process; the next Codeflare container start restores the disabled default.";
}

export async function handleContextModeCommand(
  args: string,
  ctx: ExtensionCommandContext,
  store: PiSettingsStore = PI_SETTINGS_STORE,
): Promise<void> {
  const action = args.trim().toLowerCase().split(/\s+/, 1)[0] || "status";
  if (["on", "enable", "enabled"].includes(action)) {
    setContextModeEnabled(true, store);
    ctx.ui.notify("context-mode enabled in Pi settings; reloading this Pi process...", "info");
    await ctx.reload();
    return;
  }
  if (["off", "disable", "disabled"].includes(action)) {
    setContextModeEnabled(false, store);
    ctx.ui.notify("context-mode disabled in Pi settings; reloading this Pi process...", "info");
    await ctx.reload();
    return;
  }
  ctx.ui.notify(contextModeStatusText(store), "info");
}

export default function contextModeCommand(pi: ExtensionAPI): void {
  pi.registerCommand("ctx", {
    description: "Show, enable, or disable context-mode in this container's Pi settings. Usage: /ctx status|on|off",
    handler: (args, ctx) => handleContextModeCommand(args, ctx),
  });
}
