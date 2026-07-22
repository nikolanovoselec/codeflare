import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PRE_TOOL_USE_HOOK_PATH,
  PRE_TOOL_USE_TIMEOUT_SECONDS,
  buildManagedSettings,
} from "../managed-settings.mjs";

test("REQ-IDE-005: native permission rules independently ask for guarded built-ins and MCP", () => {
  const settings = buildManagedSettings();

  assert.equal(settings.permissions.defaultMode, "default");
  assert.deepEqual(settings.permissions.ask, [
    "Edit",
    "Write",
    "NotebookEdit",
    "Bash",
    "Task",
    "WebFetch",
    "WebSearch",
    "mcp__*",
  ]);
  assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
  assert.equal(settings.permissions.disableAutoMode, "disable");
});

test("REQ-IDE-005: hook timeout and non-2 failures stay fail-open while native rules remain independent", () => {
  const settings = buildManagedSettings();

  assert.deepEqual(settings.hooks.PreToolUse, [
    {
      matcher: "",
      hooks: [
        {
          type: "command",
          command: "node /opt/codeflare/openvscode/claude/pre-tool-use-permission.mjs",
          timeout: 5,
        },
      ],
    },
  ]);
  assert.equal(PRE_TOOL_USE_HOOK_PATH, "/opt/codeflare/openvscode/claude/pre-tool-use-permission.mjs");
  assert.equal(PRE_TOOL_USE_TIMEOUT_SECONDS, 5);
  assert.equal(settings.permissions.defaultMode, "default");
  assert.deepEqual(settings.permissions.ask, [
    "Edit", "Write", "NotebookEdit", "Bash", "Task", "WebFetch", "WebSearch", "mcp__*",
  ]);
  assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
});

test("REQ-IDE-005: managed settings disable bypass, Remote Control, IDE auto-install, updates, and telemetry", () => {
  const settings = buildManagedSettings();

  assert.equal(settings.permissions.disableBypassPermissionsMode, "disable");
  assert.equal(settings.permissions.disableAutoMode, "disable");
  assert.equal(settings.disableRemoteControl, true);
  assert.equal(settings.autoInstallIdeExtension, false);
  assert.deepEqual(settings.env, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
  });
  assert.equal(settings.enableAllProjectMcpServers, false);
  assert.deepEqual(settings.enabledMcpjsonServers, []);
});
