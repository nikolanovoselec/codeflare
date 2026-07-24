import { isAbsolute, resolve } from "node:path";

export const PRE_TOOL_USE_HOOK_PATH =
  "/opt/codeflare/openvscode/claude/pre-tool-use-permission.mjs";
export const PRE_TOOL_USE_TIMEOUT_SECONDS = 5;

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
    "claudeCode.initialPermissionMode": "default",
    "claudeCode.disableLoginPrompt": true,
    "claudeCode.allowDangerouslySkipPermissions": false,
    "claudeCode.autosave": true,
    "claudeCode.preferredLocation": "sidebar",
    "claudeCode.hideOnboarding": true,
    "claudeCode.usePythonEnvironment": false,
  };
}

export function buildManagedSettings() {
  return {
    permissions: {
      defaultMode: "default",
      ask: ["WebFetch", "WebSearch", "mcp__*"],
      disableBypassPermissionsMode: "disable",
      disableAutoMode: "disable",
    },
    disableRemoteControl: true,
    autoInstallIdeExtension: false,
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: `node ${PRE_TOOL_USE_HOOK_PATH}`,
              timeout: PRE_TOOL_USE_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
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
