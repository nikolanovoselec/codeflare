import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MANAGED_SETTINGS_PATH = "/etc/codeflare/claude-sidebar/settings.json";

export const SIDEBAR_LINK_ALLOWLIST = Object.freeze([
  ".credentials.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "plugins",
  "skills",
]);

export async function prepareSidebarConfig(options) {
  const sourceRoot = validateRoot(options?.sourceRoot, "source");
  const targetRoot = validateRoot(options?.targetRoot, "target");
  assertSeparateRoots(sourceRoot, targetRoot);

  const stageRoot = `${targetRoot}.stage-${process.pid}-${randomUUID()}`;
  const targetParent = dirname(targetRoot);
  await mkdir(targetParent, { mode: 0o700, recursive: true });
  if (await realpath(targetParent) !== targetParent) throw new Error("target parent must not be redirected");
  await rm(stageRoot, { force: true, recursive: true });
  try {
    await mkdir(stageRoot, { mode: 0o700, recursive: false });
    const sourceAvailable = await directoryExists(sourceRoot);
    if (sourceAvailable) {
      const canonicalSource = await realpath(sourceRoot);
      for (const name of SIDEBAR_LINK_ALLOWLIST) {
        const sourcePath = resolve(canonicalSource, name);
        if (await entryExists(sourcePath)) await symlink(sourcePath, resolve(stageRoot, name));
      }
    }
    await symlink(MANAGED_SETTINGS_PATH, resolve(stageRoot, "settings.json"));

    const existing = await lstatOrUndefined(targetRoot);
    if (existing?.isSymbolicLink()) throw new Error("target root must not be a symbolic link");
    await rm(targetRoot, { force: true, recursive: true });
    await rename(stageRoot, targetRoot);
  } catch (error) {
    await rm(stageRoot, { force: true, recursive: true });
    throw error;
  }
}

function validateRoot(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError(`${label} root must be an absolute path`);
  }
  const normalized = resolve(value);
  if (normalized === "/") throw new Error(`${label} root cannot be the filesystem root`);
  return normalized;
}

function assertSeparateRoots(sourceRoot, targetRoot) {
  const targetFromSource = relative(sourceRoot, targetRoot);
  const sourceFromTarget = relative(targetRoot, sourceRoot);
  if (
    targetFromSource === "" ||
    (!targetFromSource.startsWith("..") && !isAbsolute(targetFromSource)) ||
    (!sourceFromTarget.startsWith("..") && !isAbsolute(sourceFromTarget))
  ) {
    throw new Error("source and target roots must be separate");
  }
}

async function directoryExists(path) {
  const stat = await lstatOrUndefined(path);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("source root must be a real directory");
  return true;
}

async function entryExists(path) {
  return (await lstatOrUndefined(path)) !== undefined;
}

async function lstatOrUndefined(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function main() {
  await prepareSidebarConfig({
    sourceRoot: "/home/user/.claude",
    targetRoot: "/tmp/codeflare-sidebar/claude/config",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Claude sidebar configuration preparation failed.\n");
    process.exitCode = 2;
  });
}
