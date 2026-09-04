import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, lstat, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import {
  MANAGED_SETTINGS_PATH,
  prepareBaseOpenVscodeSettings,
  prepareOfficialClaudeIde,
  prepareSidebarConfig,
  prepareUnsupportedOpenVscodeSettings,
} from "../prepare-sidebar-config.mjs";
import { buildOpenVscodeSettings, buildPiOpenVscodeSettings, buildUnsupportedOpenVscodeSettings } from "../managed-settings.mjs";

const EXPECTED_LINK_ALLOWLIST = Object.freeze([
  ".credentials.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "plugins",
  "skills",
]);

const fixtureRoots = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codeflare-claude-sidebar-"));
  const sourceRoot = join(root, "terminal-config");
  const targetRoot = join(root, "sidebar-config");
  await mkdir(sourceRoot);
  fixtureRoots.push(root);
  return { sourceRoot, targetRoot };
}

async function writeEntry(root, name, content = name) {
  const path = join(root, name);
  if (["agents", "commands", "plugins", "skills", "projects", "session-env", "shell-snapshots", "todos", "debug", "telemetry", "file-history", "paste-cache", "ide", "unknown-runtime"].includes(name)) {
    await mkdir(path);
    await writeFile(join(path, "entry"), content);
    return;
  }
  await writeFile(path, content);
}

async function regularFileContents(root) {
  const contents = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      contents.push(...(await regularFileContents(path)));
    } else if (entry.isFile()) {
      contents.push(await readFile(path, "utf8"));
    }
  }
  return contents;
}

test("prepare-sidebar-config creates a private 0700 config root", async () => {
  const { sourceRoot, targetRoot } = await fixture();

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  assert.equal((await stat(targetRoot)).mode & 0o777, 0o700);
});

test("REQ-IDE-006 AC1+AC2: projection links only allowlisted configuration and never copies secret bytes", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  const secret = "sidebar-fixture-secret-must-not-be-copied";

  for (const name of EXPECTED_LINK_ALLOWLIST) {
    await writeEntry(sourceRoot, name, name === ".credentials.json" ? secret : name);
  }

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  for (const name of EXPECTED_LINK_ALLOWLIST) {
    const projectedPath = join(targetRoot, name);
    assert.equal((await lstat(projectedPath)).isSymbolicLink(), true, `${name} must be linked`);
    assert.equal(await readlink(projectedPath), join(sourceRoot, name));
  }
  for (const content of await regularFileContents(targetRoot)) {
    assert.equal(content.includes(secret), false, "the projection copied credential bytes");
  }
});

test("REQ-IDE-006 AC4: projection rejects an allowlisted source entry redirected by a symbolic link", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  await writeEntry(sourceRoot, "history.jsonl", "terminal transcript");
  await symlink(join(sourceRoot, "history.jsonl"), join(sourceRoot, "CLAUDE.md"));

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  assert.equal((await readdir(targetRoot)).includes("CLAUDE.md"), false);
});

test("REQ-IDE-006 AC4: projection excludes terminal history, runtime state, and unknown entries", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  const excluded = [
    "history.jsonl",
    "projects",
    "session-env",
    "shell-snapshots",
    "todos",
    "debug",
    "telemetry",
    "file-history",
    "paste-cache",
    "ide",
    "unknown-runtime",
    "future-entry.json",
  ];
  for (const name of excluded) await writeEntry(sourceRoot, name);

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  const projectedNames = new Set(await readdir(targetRoot));
  for (const name of excluded) {
    assert.equal(projectedNames.has(name), false, `${name} leaked into the sidebar config`);
  }
});

test("REQ-IDE-005 AC2 + REQ-IDE-006 AC1: official Claude launch writes isolated OpenVSCode settings", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");

  await prepareOfficialClaudeIde({ sourceRoot, targetRoot, serverDataRoot });

  const settingsPath = join(serverDataRoot, "data", "User", "settings.json");
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")),
    buildOpenVscodeSettings(targetRoot),
  );
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("REQ-IDE-047: inherited VS Code workspace selects the session agent for every inventory", async () => {
  const previousWorkspace = process.env.CODEFLARE_SESSION_WORKSPACE;
  process.env.CODEFLARE_SESSION_WORKSPACE = "vscode";
  try {
    const { sourceRoot, targetRoot } = await fixture();
    const roots = {
      pi: join(sourceRoot, "pi-data"),
      unsupported: join(sourceRoot, "unsupported-data"),
      claude: join(sourceRoot, "claude-data"),
    };

    await prepareBaseOpenVscodeSettings(roots.pi);
    await prepareUnsupportedOpenVscodeSettings(roots.unsupported);
    await prepareOfficialClaudeIde({ sourceRoot, targetRoot, serverDataRoot: roots.claude });

    for (const root of Object.values(roots)) {
      const settings = JSON.parse(await readFile(join(root, "data", "User", "settings.json"), "utf8"));
      assert.equal(settings["terminal.integrated.defaultProfile.linux"], "Codeflare Session Agent");
      assert.deepEqual(settings["terminal.integrated.profiles.linux"], {
        bash: null,
        Bash: {
          path: "/bin/bash",
          args: ["-l"],
          env: { MANUAL_TAB: "1" },
        },
        "Codeflare Session Agent": {
          path: "/bin/bash",
          args: ["-l"],
        },
      });
    }
  } finally {
    if (previousWorkspace === undefined) delete process.env.CODEFLARE_SESSION_WORKSPACE;
    else process.env.CODEFLARE_SESSION_WORKSPACE = previousWorkspace;
  }
});

test("REQ-IDE-047: absent or unknown inherited workspace fails safely to the terminal default", async () => {
  const previousWorkspace = process.env.CODEFLARE_SESSION_WORKSPACE;
  try {
    for (const workspace of [undefined, "unknown"]) {
      if (workspace === undefined) delete process.env.CODEFLARE_SESSION_WORKSPACE;
      else process.env.CODEFLARE_SESSION_WORKSPACE = workspace;
      const { sourceRoot } = await fixture();
      const serverDataRoot = join(sourceRoot, "openvscode-data");

      await prepareBaseOpenVscodeSettings(serverDataRoot);

      const settings = JSON.parse(await readFile(join(serverDataRoot, "data", "User", "settings.json"), "utf8"));
      assert.equal(settings["terminal.integrated.defaultProfile.linux"], "Bash");
    }
  } finally {
    if (previousWorkspace === undefined) delete process.env.CODEFLARE_SESSION_WORKSPACE;
    else process.env.CODEFLARE_SESSION_WORKSPACE = previousWorkspace;
  }
});

test("REQ-IDE-007 AC3: official Claude restart restores unrestricted managed settings", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");
  const settingsPath = join(serverDataRoot, "data", "User", "settings.json");

  await prepareOfficialClaudeIde({ sourceRoot, targetRoot, serverDataRoot });
  await writeFile(settingsPath, JSON.stringify({
    "claudeCode.initialPermissionMode": "default",
    "claudeCode.allowDangerouslySkipPermissions": false,
  }));
  await prepareOfficialClaudeIde({ sourceRoot, targetRoot, serverDataRoot });

  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")),
    buildOpenVscodeSettings(targetRoot),
  );
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});

test("REQ-IDE-006 AC1+AC2: projection replaces source settings with the fixed managed settings path", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  await writeFile(join(sourceRoot, "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  const projectedSettings = join(targetRoot, "settings.json");
  assert.equal((await lstat(projectedSettings)).isSymbolicLink(), true);
  assert.equal(await readlink(projectedSettings), MANAGED_SETTINGS_PATH);
  assert.equal(MANAGED_SETTINGS_PATH, "/etc/codeflare/claude-sidebar/settings.json");
});

test("REQ-IDE-002 AC7 + REQ-IDE-016 AC2 + REQ-IDE-040 AC2: settings preparation preserves safe UI preferences but replaces stale managed inventory settings", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");
  const settingsDirectory = join(serverDataRoot, "data", "User");
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(join(settingsDirectory, "settings.json"), JSON.stringify({
    "workbench.colorTheme": "Default Light Modern",
    "keyboard.layout": "de",
    "extensions.allowed": { "*": false },
    "workbench.startupEditor": "welcomePage",
    "terminal.integrated.defaultProfile.linux": "Legacy Agent",
    "terminal.integrated.profiles.linux": {
      "Legacy Agent": { path: "/bin/bash", args: ["-l"] },
    },
    "chat.disableAIFeatures": false,
    "accessibility.openChatEditedFiles": true,
    "chat.titleBar.signIn.enabled": true,
    "chat.notifyWindowOnResponseReceived": "off",
    "chat.agentFilesLocations": {
      "~/.claude/agents": true,
    },
    "claudeCode.disableLoginPrompt": false,
  }));

  await prepareBaseOpenVscodeSettings(serverDataRoot);

  assert.deepEqual(JSON.parse(await readFile(join(settingsDirectory, "settings.json"), "utf8")), {
    "workbench.colorTheme": "Default Light Modern",
    "keyboard.layout": "de",
    "security.workspace.trust.enabled": false,
    "extensions.ignoreRecommendations": true,
    "extensions.allowed": { "*": true, "codeflare.codeflare-agent-sidebar": true },
    "workbench.startupEditor": "none",
    "terminal.integrated.defaultProfile.linux": "Bash",
    "terminal.integrated.profiles.linux": {
      bash: null,
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
    "chat.disableAIFeatures": true,
    "accessibility.openChatEditedFiles": false,
    "chat.notifyWindowOnResponseReceived": "windowNotFocused",
    "chat.notifyWindowOnConfirmation": "windowNotFocused",
    "chat.agentFilesLocations": {
      "~/.claude/agents": false,
    },
  });
});

test("REQ-IDE-042 AC1: settings preparation reads the restored company extension manifest", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");
  const managedExtensionsPath = join(sourceRoot, "..", ".codeflare", "managed-extensions.json");
  await mkdir(join(managedExtensionsPath, ".."), { recursive: true });
  const manifest = JSON.stringify({
    schemaVersion: 1,
    release: { digest: "a".repeat(64), sequence: 7 },
    extensions: [{ id: "cherrymarkdownpublisher.cherry-markdown" }],
  });
  await writeFile(managedExtensionsPath, manifest);

  await prepareBaseOpenVscodeSettings(serverDataRoot, {
    managedExtensionsPath,
    managedReleaseDigest: "a".repeat(64),
    managedManifestDigest: createHash("sha256").update(manifest).digest("hex"),
  });

  const written = JSON.parse(await readFile(join(serverDataRoot, "data", "User", "settings.json"), "utf8"));
  assert.deepEqual(written["extensions.allowed"], {
    "*": true,
    "codeflare.codeflare-agent-sidebar": true,
    "cherrymarkdownpublisher.cherry-markdown": true,
  });
});

test("REQ-IDE-042 AC1: company allowance rejects valid substituted bytes with a different trusted digest", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");
  const managedExtensionsPath = join(sourceRoot, "..", ".codeflare", "managed-extensions.json");
  await mkdir(join(managedExtensionsPath, ".."), { recursive: true });
  const trustedManifest = JSON.stringify({
    schemaVersion: 1,
    release: { digest: "a".repeat(64), sequence: 7 },
    extensions: [{ id: "cherrymarkdownpublisher.cherry-markdown" }],
  });
  const substitutedManifest = JSON.stringify({
    schemaVersion: 1,
    release: { digest: "a".repeat(64), sequence: 7 },
    extensions: [{ id: "acme.substituted" }],
  });
  await writeFile(managedExtensionsPath, substitutedManifest);

  await prepareBaseOpenVscodeSettings(serverDataRoot, {
    managedExtensionsPath,
    managedReleaseDigest: "a".repeat(64),
    managedManifestDigest: createHash("sha256").update(trustedManifest).digest("hex"),
  });

  const written = JSON.parse(await readFile(join(serverDataRoot, "data", "User", "settings.json"), "utf8"));
  assert.deepEqual(written["extensions.allowed"], {
    "*": true,
    "codeflare.codeflare-agent-sidebar": true,
  });
});

test("REQ-IDE-042 AC1: company allowance ignores a restored manifest from another applied release", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");
  const managedExtensionsPath = join(sourceRoot, "..", ".codeflare", "managed-extensions.json");
  await mkdir(join(managedExtensionsPath, ".."), { recursive: true });
  const manifest = JSON.stringify({
    schemaVersion: 1,
    release: { digest: "a".repeat(64), sequence: 7 },
    extensions: [{ id: "cherrymarkdownpublisher.cherry-markdown" }],
  });
  await writeFile(managedExtensionsPath, manifest);

  await prepareBaseOpenVscodeSettings(serverDataRoot, {
    managedExtensionsPath,
    managedReleaseDigest: "b".repeat(64),
    managedManifestDigest: createHash("sha256").update(manifest).digest("hex"),
  });

  const written = JSON.parse(await readFile(join(serverDataRoot, "data", "User", "settings.json"), "utf8"));
  assert.deepEqual(written["extensions.allowed"], {
    "*": true,
    "codeflare.codeflare-agent-sidebar": true,
  });
});

test("REQ-IDE-042 AC1: invalid company manifest falls back to the baseline allowance without blocking the IDE", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");
  const managedExtensionsPath = join(sourceRoot, "..", ".codeflare", "managed-extensions.json");
  await mkdir(join(managedExtensionsPath, ".."), { recursive: true });
  const manifest = JSON.stringify({ schemaVersion: 1, extensions: [{ id: "invalid" }] });
  await writeFile(managedExtensionsPath, manifest);

  await prepareBaseOpenVscodeSettings(serverDataRoot, {
    managedExtensionsPath,
    managedReleaseDigest: "a".repeat(64),
    managedManifestDigest: createHash("sha256").update(manifest).digest("hex"),
  });

  const written = JSON.parse(await readFile(join(serverDataRoot, "data", "User", "settings.json"), "utf8"));
  assert.deepEqual(written["extensions.allowed"], {
    "*": true,
    "codeflare.codeflare-agent-sidebar": true,
  });
});

test("REQ-IDE-005: unsupported inventory disables generic Chat after restoring preferences", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");

  await prepareUnsupportedOpenVscodeSettings(serverDataRoot);

  assert.deepEqual(
    JSON.parse(await readFile(join(serverDataRoot, "data", "User", "settings.json"), "utf8")),
    buildUnsupportedOpenVscodeSettings(),
  );
});

test("REQ-IDE-002: malformed restored settings cannot prevent managed settings recovery", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");
  const settingsDirectory = join(serverDataRoot, "data", "User");
  await mkdir(settingsDirectory, { recursive: true });
  await writeFile(join(settingsDirectory, "settings.json"), "{malformed");

  await prepareBaseOpenVscodeSettings(serverDataRoot);

  assert.deepEqual(
    JSON.parse(await readFile(join(settingsDirectory, "settings.json"), "utf8")),
    buildPiOpenVscodeSettings(),
  );
});

test("REQ-IDE-021: every prepared inventory preserves status entries and hides Accounts chrome", async () => {
  const preparations = [
    async (root) => prepareBaseOpenVscodeSettings(root),
    async (root) => prepareUnsupportedOpenVscodeSettings(root),
    async (root) => prepareOfficialClaudeIde({
      sourceRoot: (await fixture()).sourceRoot,
      targetRoot: join(root, "claude-config"),
      serverDataRoot: root,
    }),
  ];

  for (const prepare of preparations) {
    const { sourceRoot } = await fixture();
    const serverDataRoot = join(sourceRoot, "openvscode-data");
    const storageDirectory = join(serverDataRoot, "data", "User", "State");
    await mkdir(storageDirectory, { recursive: true });
    await writeFile(join(storageDirectory, "storage.json"), JSON.stringify({
      unrelated: "preserved",
      "workbench.statusbar.hidden": '["other.status.entry"]',
      "workbench.activity.showAccounts": "true",
    }));
    await prepare(serverDataRoot);
    await prepare(serverDataRoot);
    assert.deepEqual(
      JSON.parse(await readFile(join(storageDirectory, "storage.json"), "utf8")),
      {
        unrelated: "preserved",
        "workbench.statusbar.hidden": '["other.status.entry"]',
        "workbench.activity.showAccounts": "false",
      },
    );
  }
});

test("REQ-IDE-021: malformed profile storage recovers and redirected storage fails closed", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "openvscode-data");
  const storageDirectory = join(serverDataRoot, "data", "User", "State");
  const storagePath = join(storageDirectory, "storage.json");
  await mkdir(storageDirectory, { recursive: true });
  await writeFile(storagePath, "not json");
  await prepareBaseOpenVscodeSettings(serverDataRoot);
  assert.deepEqual(JSON.parse(await readFile(storagePath, "utf8")), {
    "workbench.activity.showAccounts": "false",
  });

  const redirectedRoot = join(sourceRoot, "redirected-data");
  const redirectedStorage = join(redirectedRoot, "data", "User", "State");
  await mkdir(redirectedStorage, { recursive: true });
  await rm(join(redirectedStorage, "storage.json"), { force: true });
  await symlink(storagePath, join(redirectedStorage, "storage.json"));
  await assert.rejects(
    prepareBaseOpenVscodeSettings(redirectedRoot),
    /profile storage must be a bounded real file/,
  );
});

test("REQ-IDE-009 + REQ-IDE-018: Pi settings seed writes workspace and native notification keys", async () => {
  const { sourceRoot } = await fixture();
  const serverDataRoot = join(sourceRoot, "..", "openvscode-data");

  await prepareBaseOpenVscodeSettings(serverDataRoot);

  const settingsPath = join(serverDataRoot, "data", "User", "settings.json");
  const written = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(written, buildPiOpenVscodeSettings());
  assert.equal(Object.keys(written).some((key) => key.startsWith("claudeCode.")), false);
  assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
});
