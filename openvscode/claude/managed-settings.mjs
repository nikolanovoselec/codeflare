import { isAbsolute, resolve } from "node:path";

// OpenVSCode User settings seeded for EVERY Browser IDE agent kind (pi, claude,
// none), independent of the selected agent. Disabling workspace trust opens the
// session workspace without VS Code's trust prompt -- the container is already
// the security boundary and IDE agents run unrestricted, so the trust gate adds
// no protection (REQ-IDE-009, AD114). Ignoring recommendations suppresses the
// cloned repository's "install recommended extensions" prompt.
export function buildBaseOpenVscodeSettings() {
  return {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "chat.titleBar.signIn.enabled": false,
  };
}

export function buildPiOpenVscodeSettings() {
  return {
    ...buildBaseOpenVscodeSettings(),
    "chat.notifyWindowOnResponseReceived": "windowNotFocused",
    "chat.notifyWindowOnConfirmation": "windowNotFocused",
    "chat.agentFilesLocations": {
      "~/.claude/agents": false,
    },
  };
}

export function buildUnsupportedOpenVscodeSettings() {
  return {
    ...buildBaseOpenVscodeSettings(),
    "chat.disableAIFeatures": true,
  };
}

export const MANAGED_OPENVSCODE_SETTING_KEYS = Object.freeze([
  "security.workspace.trust.enabled",
  "extensions.ignoreRecommendations",
  "chat.titleBar.signIn.enabled",
  "chat.disableAIFeatures",
  "chat.notifyWindowOnResponseReceived",
  "chat.notifyWindowOnConfirmation",
  "chat.agentFilesLocations",
  "claudeCode.environmentVariables",
  "claudeCode.useTerminal",
  "claudeCode.initialPermissionMode",
  "claudeCode.disableLoginPrompt",
  "claudeCode.allowDangerouslySkipPermissions",
  "claudeCode.autosave",
  "claudeCode.preferredLocation",
  "claudeCode.hideOnboarding",
  "claudeCode.usePythonEnvironment",
]);

export function buildOpenVscodeSettings(claudeConfigDirectory) {
  if (typeof claudeConfigDirectory !== "string" || !isAbsolute(claudeConfigDirectory) || claudeConfigDirectory.includes("\0")) {
    throw new TypeError("Claude config directory must be absolute");
  }
  const normalized = resolve(claudeConfigDirectory);
  if (normalized === "/") throw new TypeError("Claude config directory cannot be root");
  return {
    ...buildBaseOpenVscodeSettings(),
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
