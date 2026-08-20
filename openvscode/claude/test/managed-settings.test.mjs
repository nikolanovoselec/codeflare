import assert from "node:assert/strict";
import { test } from "vitest";

import {
  MANAGED_OPENVSCODE_SETTING_KEYS,
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
    "extensions.allowed": { "*": true, "codeflare.codeflare-agent-sidebar": true },
    "workbench.startupEditor": "none",
    "chat.titleBar.signIn.enabled": false,
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

test("REQ-IDE-009 + REQ-IDE-021 + REQ-IDE-024: base settings suppress the legacy startup editor", () => {
  assert.deepEqual(buildBaseOpenVscodeSettings(), {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "extensions.allowed": { "*": true, "codeflare.codeflare-agent-sidebar": true },
    "workbench.startupEditor": "none",
    "chat.titleBar.signIn.enabled": false,
  });
});

test("REQ-IDE-047: Browser IDE terminals default to Bash and keep the session agent selectable", () => {
  const expectedProfiles = {
    Bash: {
      path: "/bin/bash",
      args: ["-l"],
      env: { MANUAL_TAB: "1" },
    },
    "Session Agent": {
      path: "/bin/bash",
      args: ["-l"],
    },
  };

  for (const settings of [
    buildBaseOpenVscodeSettings(),
    buildPiOpenVscodeSettings(),
    buildUnsupportedOpenVscodeSettings(),
    buildOpenVscodeSettings("/tmp/codeflare-sidebar/claude/config"),
  ]) {
    assert.equal(settings["terminal.integrated.defaultProfile.linux"], "Bash");
    assert.deepEqual(settings["terminal.integrated.profiles.linux"], expectedProfiles);
  }

  assert.equal(MANAGED_OPENVSCODE_SETTING_KEYS.includes("terminal.integrated.defaultProfile.linux"), true);
  assert.equal(MANAGED_OPENVSCODE_SETTING_KEYS.includes("terminal.integrated.profiles.linux"), true);
});

test("REQ-IDE-018 + REQ-IDE-019 AC6 + REQ-IDE-021 AC1 + REQ-IDE-033: Pi settings keep Inline edits in the invoking editor", () => {
  const settings = buildPiOpenVscodeSettings();
  assert.deepEqual(settings, {
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "extensions.allowed": { "*": true, "codeflare.codeflare-agent-sidebar": true },
    "workbench.startupEditor": "none",
    "chat.titleBar.signIn.enabled": false,
    "chat.disableAIFeatures": true,
    "accessibility.openChatEditedFiles": false,
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
    "extensions.allowed": { "*": true, "codeflare.codeflare-agent-sidebar": true },
    "workbench.startupEditor": "none",
    "chat.titleBar.signIn.enabled": false,
    "chat.disableAIFeatures": true,
  });
});

test("REQ-IDE-009: Claude settings also carry the base workspace-trust and recommendation keys", () => {
  const settings = buildOpenVscodeSettings("/tmp/codeflare-sidebar/claude/config");

  assert.equal(settings["security.workspace.trust.enabled"], false);
  assert.equal(settings["extensions.ignoreRecommendations"], true);
  assert.deepEqual(settings["extensions.allowed"], { "*": true, "codeflare.codeflare-agent-sidebar": true });
  assert.equal(settings["workbench.startupEditor"], "none");
  assert.equal(settings["chat.titleBar.signIn.enabled"], false);
});

test("REQ-IDE-040 AC1: every inventory applies the managed user-extension allowance", () => {
  const expected = { "*": true, "codeflare.codeflare-agent-sidebar": true };
  assert.deepEqual(buildPiOpenVscodeSettings()["extensions.allowed"], expected);
  assert.deepEqual(buildUnsupportedOpenVscodeSettings()["extensions.allowed"], expected);
  assert.deepEqual(buildOpenVscodeSettings("/tmp/codeflare-sidebar/claude/config")["extensions.allowed"], expected);
  assert.equal(MANAGED_OPENVSCODE_SETTING_KEYS.includes("extensions.allowed"), true);
});

test("REQ-IDE-042 AC2: company extension identities extend the personal allowance map", () => {
  const company = [
    { id: "cherrymarkdownpublisher.cherry-markdown" },
    { id: "acme.review-tools" },
  ];
  const expected = {
    "*": true,
    "codeflare.codeflare-agent-sidebar": true,
    "acme.review-tools": true,
    "cherrymarkdownpublisher.cherry-markdown": true,
  };

  assert.deepEqual(buildBaseOpenVscodeSettings(company)["extensions.allowed"], expected);
  assert.deepEqual(buildPiOpenVscodeSettings(company)["extensions.allowed"], expected);
  assert.deepEqual(buildUnsupportedOpenVscodeSettings(company)["extensions.allowed"], expected);
  assert.deepEqual(buildOpenVscodeSettings("/tmp/codeflare-sidebar/claude/config", company)["extensions.allowed"], expected);
});
