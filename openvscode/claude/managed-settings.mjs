import { isAbsolute, resolve } from "node:path";

// OpenVSCode User settings seeded for EVERY Browser IDE agent kind (pi, claude,
// none), independent of the selected agent. Disabling workspace trust opens the
// session workspace without VS Code's trust prompt -- the container is already
// the security boundary and IDE agents run unrestricted, so the trust gate adds
// no protection (REQ-IDE-009, AD114). Ignoring recommendations suppresses the
// cloned repository's "install recommended extensions" prompt. Disabling the
// default startup editor leaves the owned Codeflare welcome as the sole welcome.
const COMPANY_EXTENSION_ID = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/;

function extensionAllowance(managedExtensions = []) {
  if (!Array.isArray(managedExtensions) || managedExtensions.length > 20) {
    throw new TypeError("Managed extensions must be a bounded array");
  }
  const companyIds = managedExtensions.map((extension) => {
    const id = extension?.id;
    if (typeof id !== "string" || !COMPANY_EXTENSION_ID.test(id)) {
      throw new TypeError("Managed extension identity is invalid");
    }
    return id;
  });
  if (new Set(companyIds).size !== companyIds.length) throw new TypeError("Managed extension identities must be unique");
  return Object.fromEntries([
    ["*", true],
    ["codeflare.codeflare-agent-sidebar", true],
    ...[...new Set(companyIds)].sort().map((id) => [id, true]),
  ]);
}

function defaultTerminalProfile(sessionWorkspace) {
  return sessionWorkspace === "vscode" ? "Codeflare Session Agent" : "Bash";
}

export function buildBaseOpenVscodeSettings(managedExtensions = [], sessionWorkspace = "terminal") {
  return {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "extensions.allowed": extensionAllowance(managedExtensions),
    "workbench.startupEditor": "none",
    "terminal.integrated.defaultProfile.linux": defaultTerminalProfile(sessionWorkspace),
    "terminal.integrated.profiles.linux": {
      Bash: {
        path: "/bin/bash",
        args: ["-l"],
        env: { MANUAL_TAB: "1" },
      },
      "Codeflare Session Agent": {
        path: "/bin/bash",
        args: ["-l"],
      },
    },
    "chat.titleBar.signIn.enabled": false,
  };
}

export function buildPiOpenVscodeSettings(managedExtensions = [], sessionWorkspace = "terminal") {
  return {
    ...buildBaseOpenVscodeSettings(managedExtensions, sessionWorkspace),
    "chat.disableAIFeatures": true,
    "accessibility.openChatEditedFiles": false,
    "chat.notifyWindowOnResponseReceived": "windowNotFocused",
    "chat.notifyWindowOnConfirmation": "windowNotFocused",
    "chat.agentFilesLocations": {
      "~/.claude/agents": false,
    },
  };
}

export function buildUnsupportedOpenVscodeSettings(managedExtensions = [], sessionWorkspace = "terminal") {
  return {
    ...buildBaseOpenVscodeSettings(managedExtensions, sessionWorkspace),
    "chat.disableAIFeatures": true,
  };
}

export const MANAGED_OPENVSCODE_SETTING_KEYS = Object.freeze([
  "security.workspace.trust.enabled",
  "extensions.ignoreRecommendations",
  "extensions.allowed",
  "workbench.startupEditor",
  "terminal.integrated.defaultProfile.linux",
  "terminal.integrated.profiles.linux",
  "chat.titleBar.signIn.enabled",
  "chat.disableAIFeatures",
  "accessibility.openChatEditedFiles",
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

export function buildOpenVscodeSettings(claudeConfigDirectory, managedExtensions = [], sessionWorkspace = "terminal") {
  if (typeof claudeConfigDirectory !== "string" || !isAbsolute(claudeConfigDirectory) || claudeConfigDirectory.includes("\0")) {
    throw new TypeError("Claude config directory must be absolute");
  }
  const normalized = resolve(claudeConfigDirectory);
  if (normalized === "/") throw new TypeError("Claude config directory cannot be root");
  return {
    ...buildBaseOpenVscodeSettings(managedExtensions, sessionWorkspace),
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
