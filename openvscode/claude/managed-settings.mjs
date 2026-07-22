export const PRE_TOOL_USE_HOOK_PATH =
  "/opt/codeflare/openvscode/claude/pre-tool-use-permission.mjs";
export const PRE_TOOL_USE_TIMEOUT_SECONDS = 5;

export function buildManagedSettings() {
  return {
    permissions: {
      defaultMode: "default",
      ask: ["Edit", "Write", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch", "mcp__*"],
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
