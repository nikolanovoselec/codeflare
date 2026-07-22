import assert from "node:assert/strict";
import { mkdtemp, mkdir, lstat, readFile, readlink, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import {
  MANAGED_SETTINGS_PATH,
  prepareSidebarConfig,
} from "../prepare-sidebar-config.mjs";

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

test("REQ-IDE-005: prepare-sidebar-config creates a private 0700 config root", async () => {
  const { sourceRoot, targetRoot } = await fixture();

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  assert.equal((await stat(targetRoot)).mode & 0o777, 0o700);
});

test("REQ-IDE-005: projection links only allowlisted configuration and never copies secret bytes", async () => {
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

test("REQ-IDE-005: projection rejects an allowlisted source entry redirected by a symbolic link", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  await writeEntry(sourceRoot, "history.jsonl", "terminal transcript");
  await symlink(join(sourceRoot, "history.jsonl"), join(sourceRoot, "CLAUDE.md"));

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  assert.equal((await readdir(targetRoot)).includes("CLAUDE.md"), false);
});

test("REQ-IDE-005: projection excludes terminal history, runtime state, source settings, and unknown entries", async () => {
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
    "settings.json",
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

test("REQ-IDE-005: projection pins settings to the fixed root-owned settings path", async () => {
  const { sourceRoot, targetRoot } = await fixture();
  await writeFile(join(sourceRoot, "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));

  await prepareSidebarConfig({ sourceRoot, targetRoot });

  const projectedSettings = join(targetRoot, "settings.json");
  assert.equal((await lstat(projectedSettings)).isSymbolicLink(), true);
  assert.equal(await readlink(projectedSettings), MANAGED_SETTINGS_PATH);
  assert.equal(MANAGED_SETTINGS_PATH, "/etc/codeflare/claude-sidebar/settings.json");
});
