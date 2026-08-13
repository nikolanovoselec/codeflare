import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildBaseOpenVscodeSettings,
  buildManagedSettings,
  buildOpenVscodeSettings,
  buildPiOpenVscodeSettings,
  buildUnsupportedOpenVscodeSettings,
} from "../managed-settings.mjs";

test("REQ-IDE-007 AC3: Claude uses unrestricted mode without permission hooks", () => {
  const settings = buildManagedSettings();

  assert.deepEqual(settings.permissions, { defaultMode: "bypassPermissions" });
  assert.equal(settings.hooks, undefined);
});

test("REQ-IDE-005 AC3: Claude suppresses unrelated native Chat setup", () => {
  const settings = buildOpenVscodeSettings("/tmp/codeflare-sidebar/claude/config");

  assert.equal(settings["chat.disableAIFeatures"], true);
});

test("REQ-IDE-005 AC2 + REQ-IDE-006 AC1: OpenVSCode launches official Claude with isolated unrestricted UI", () => {
  assert.deepEqual(buildOpenVscodeSettings("/tmp/codeflare-sidebar/claude/config"), {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "chat.disableAIFeatures": true,
    "claudeCode.environmentVariables": [
      { name: "CLAUDE_CONFIG_DIR", value: "/tmp/codeflare-sidebar/claude/config" },
    ],
    "claudeCode.useTerminal": false,
    "claudeCode.initialPermissionMode": "bypassPermissions",
    "claudeCode.disableLoginPrompt": true,
    "claudeCode.allowDangerouslySkipPermissions": true,
    "claudeCode.autosave": true,
    "claudeCode.preferredLocation": "sidebar",
    "claudeCode.hideOnboarding": true,
    "claudeCode.usePythonEnvironment": false,
  });
  assert.throws(() => buildOpenVscodeSettings("relative/config"), /absolute/i);
});

test("REQ-IDE-007 AC3: unrestricted mode keeps configuration isolation and telemetry controls", () => {
  const settings = buildManagedSettings();

  assert.deepEqual(settings.permissions, { defaultMode: "bypassPermissions" });
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

test("REQ-IDE-009: base OpenVSCode settings auto-trust the workspace and ignore extension recommendations", () => {
  assert.deepEqual(buildBaseOpenVscodeSettings(), {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
  });
});

test("REQ-IDE-018 + REQ-IDE-019 AC4: Pi native Chat uses notifications and one personal agent source", () => {
  const settings = buildPiOpenVscodeSettings();
  assert.deepEqual(settings, {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "chat.notifyWindowOnResponseReceived": "windowNotFocused",
    "chat.notifyWindowOnConfirmation": "windowNotFocused",
    "chat.agentFilesLocations": {
      "~/.claude/agents": false,
    },
  });
  assert.equal(settings["chat.agentFilesLocations"]["~/.copilot/agents"], undefined);
});

test("REQ-IDE-005: unsupported inventory suppresses native Chat and Copilot setup", () => {
  assert.deepEqual(buildUnsupportedOpenVscodeSettings(), {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "chat.disableAIFeatures": true,
  });
});

test("REQ-IDE-009: Claude settings also carry the base workspace-trust and recommendation keys", () => {
  const settings = buildOpenVscodeSettings("/tmp/codeflare-sidebar/claude/config");

  assert.equal(settings["security.workspace.trust.enabled"], false);
  assert.equal(settings["extensions.ignoreRecommendations"], true);
});
