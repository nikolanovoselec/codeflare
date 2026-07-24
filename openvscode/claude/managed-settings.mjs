import { isAbsolute, resolve } from "node:path";

export function buildOpenVscodeSettings(claudeConfigDirectory) {
  if (typeof claudeConfigDirectory !== "string" || !isAbsolute(claudeConfigDirectory) || claudeConfigDirectory.includes("\0")) {
    throw new TypeError("Claude config directory must be absolute");
  }
  const normalized = resolve(claudeConfigDirectory);
  if (normalized === "/") throw new TypeError("Claude config directory cannot be root");
  return {
    "chat.disableAIFeatures": true,
    "claudeCode.environmentVariables": [
      { name: "CLAUDE_CONFIG_DIR", value: normalized },
    ],
    "claudeCode.useTerminal": false,
    "claudeCode.initialPermissionMode": "bypassPermissions",
    "claudeCode.disableLoginPrompt": true,
    "claudeCode.allowDangerouslySkipPermissions": true,
    "claudeCode.autosave": true,
    "claudeCode.preferredLocation": "sidebar",
    "claudeCode.hideOnboarding": true,
    "claudeCode.usePythonEnvironment": false,
  };
}

export function buildManagedSettings() {
  return {
    permissions: {
      defaultMode: "bypassPermissions",
    },
    disableRemoteControl: true,
    autoInstallIdeExtension: false,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: [],
  };
}
