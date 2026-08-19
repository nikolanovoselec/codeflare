import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MANAGED_OPENVSCODE_SETTING_KEYS,
  buildOpenVscodeSettings,
  buildPiOpenVscodeSettings,
  buildUnsupportedOpenVscodeSettings,
} from "./managed-settings.mjs";

export const MANAGED_SETTINGS_PATH = "/etc/codeflare/claude-sidebar/settings.json";
const PROFILE_STORAGE_MAX_BYTES = 256 * 1024;
const MANAGED_EXTENSIONS_MAX_BYTES = 256 * 1024;
const ACCOUNTS_VISIBILITY_STORAGE_KEY = "workbench.activity.showAccounts";

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
    const projected = [];
    const sourceAvailable = await directoryExists(sourceRoot);
    if (sourceAvailable) {
      const canonicalSource = await realpath(sourceRoot);
      for (const name of SIDEBAR_LINK_ALLOWLIST) {
        const sourcePath = resolve(canonicalSource, name);
        if (await projectableEntry(sourcePath, canonicalSource)) {
          await symlink(sourcePath, resolve(stageRoot, name));
          projected.push(name);
        }
      }
    }
    await symlink(MANAGED_SETTINGS_PATH, resolve(stageRoot, "settings.json"));
    await writeFile(
      resolve(stageRoot, ".codeflare-projection.json"),
      `${JSON.stringify({ version: 1, links: projected, settings: MANAGED_SETTINGS_PATH })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );

    const existing = await lstatOrUndefined(targetRoot);
    if (existing?.isSymbolicLink()) throw new Error("target root must not be a symbolic link");
    await rm(targetRoot, { force: true, recursive: true });
    await rename(stageRoot, targetRoot);
  } catch (error) {
    await rm(stageRoot, { force: true, recursive: true });
    throw error;
  }
}

export async function prepareOfficialClaudeIde(options) {
  const sourceRoot = validateRoot(options?.sourceRoot, "source");
  const targetRoot = validateRoot(options?.targetRoot, "target");
  const serverDataRoot = validateRoot(options?.serverDataRoot, "OpenVSCode data");
  const existing = await lstatOrUndefined(targetRoot);
  if (existing) await validatePreparedSidebarConfig(targetRoot);
  else await prepareSidebarConfig({ sourceRoot, targetRoot });
  await prepareOpenVscodeSettings({
    serverDataRoot,
    claudeConfigRoot: targetRoot,
    managedExtensionsPath: options?.managedExtensionsPath,
  });
}

async function loadManagedExtensions(managedExtensionsPath, managedReleaseDigest) {
  const expectedDigest = managedReleaseDigest ?? process.env.REMOTE_CURATION_RELEASE_DIGEST;
  if (!/^[0-9a-f]{64}$/.test(expectedDigest ?? '')) return [];
  try {
    const path = managedExtensionsPath === undefined
      ? resolve(process.env.HOME ?? "/home/user", ".codeflare", "managed-extensions.json")
      : validateRoot(managedExtensionsPath, "managed extensions");
    const info = await lstatOrUndefined(path);
    if (!info) return [];
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MANAGED_EXTENSIONS_MAX_BYTES) {
      throw new Error("managed extensions must be a bounded real file");
    }
    const bytes = await readFile(path);
    if (bytes.length > MANAGED_EXTENSIONS_MAX_BYTES) throw new Error("managed extensions exceed their bound");
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "extensions,release,schemaVersion"
      || parsed.schemaVersion !== 1
      || !parsed.release
      || typeof parsed.release !== "object"
      || Array.isArray(parsed.release)
      || Object.keys(parsed.release).sort().join(",") !== "digest,sequence"
      || !/^[0-9a-f]{64}$/.test(parsed.release.digest)
      || parsed.release.digest !== expectedDigest
      || !Number.isSafeInteger(parsed.release.sequence)
      || parsed.release.sequence <= 0
      || !Array.isArray(parsed.extensions)
    ) {
      throw new Error("managed extensions manifest is invalid");
    }
    return parsed.extensions;
  } catch {
    console.error("[openvscode] Ignoring invalid managed extension manifest; using baseline extension allowance");
    return [];
  }
}

async function writeOpenVscodeUserSettings(serverDataRoot, settings) {
  const settingsDirectory = resolve(serverDataRoot, "data", "User");
  const settingsPath = resolve(settingsDirectory, "settings.json");
  await mkdir(settingsDirectory, { mode: 0o700, recursive: true });
  if (await realpath(settingsDirectory) !== settingsDirectory) {
    throw new Error("OpenVSCode settings directory must not be redirected");
  }
  const existing = await lstatOrUndefined(settingsPath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > 256 * 1024)) {
    throw new Error("OpenVSCode settings must be a bounded real file");
  }
  let preserved = {};
  if (existing) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenVSCode settings must be a JSON object");
    }
    const managed = new Set(MANAGED_OPENVSCODE_SETTING_KEYS);
    preserved = Object.fromEntries(Object.entries(parsed).filter(([key]) => !managed.has(key)));
  }
  const merged = { ...preserved, ...settings };
  const temporary = `${settingsPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(merged, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporary, settingsPath);
  } finally {
    await rm(temporary, { force: true });
  }
  await writeOpenVscodeProfileState(serverDataRoot);
}

async function writeOpenVscodeProfileState(serverDataRoot) {
  // Keep the existing bounded server-side State resource for the Accounts
  // preference only. Code OSS 1.132 owns status-entry visibility in browser
  // IndexedDB, so Pi setup chrome is handled by managed settings and extension context instead.
  const storageDirectory = resolve(serverDataRoot, "data", "User", "State");
  const storagePath = resolve(storageDirectory, "storage.json");
  await mkdir(storageDirectory, { mode: 0o700, recursive: true });
  if (await realpath(storageDirectory) !== storageDirectory) {
    throw new Error("OpenVSCode profile storage directory must not be redirected");
  }
  const existing = await lstatOrUndefined(storagePath);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size > PROFILE_STORAGE_MAX_BYTES)) {
    throw new Error("OpenVSCode profile storage must be a bounded real file");
  }
  let preserved = {};
  if (existing) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(storagePath, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      parsed = {};
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OpenVSCode profile storage must be a JSON object");
    }
    preserved = parsed;
  }
  const serialized = `${JSON.stringify({
    ...preserved,
    [ACCOUNTS_VISIBILITY_STORAGE_KEY]: "false",
  }, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > PROFILE_STORAGE_MAX_BYTES) {
    throw new Error("OpenVSCode profile storage exceeds its bounded size");
  }
  const temporary = `${storagePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporary,
      serialized,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporary, storagePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function prepareOpenVscodeSettings(options) {
  const serverDataRoot = validateRoot(options?.serverDataRoot, "OpenVSCode data");
  const claudeConfigRoot = validateRoot(options?.claudeConfigRoot, "Claude config");
  const managedExtensions = await loadManagedExtensions(options?.managedExtensionsPath, options?.managedReleaseDigest);
  await writeOpenVscodeUserSettings(serverDataRoot, buildOpenVscodeSettings(claudeConfigRoot, managedExtensions));
}

// Seed the kind-independent base settings for the pi and none inventories,
// which have no Claude config projection. REQ-IDE-009.
export async function prepareBaseOpenVscodeSettings(serverDataRoot, options = {}) {
  const root = validateRoot(serverDataRoot, "OpenVSCode data");
  const managedExtensions = await loadManagedExtensions(options?.managedExtensionsPath, options?.managedReleaseDigest);
  await writeOpenVscodeUserSettings(root, buildPiOpenVscodeSettings(managedExtensions));
}

export async function prepareUnsupportedOpenVscodeSettings(serverDataRoot, options = {}) {
  const root = validateRoot(serverDataRoot, "OpenVSCode data");
  const managedExtensions = await loadManagedExtensions(options?.managedExtensionsPath, options?.managedReleaseDigest);
  await writeOpenVscodeUserSettings(root, buildUnsupportedOpenVscodeSettings(managedExtensions));
}

async function validatePreparedSidebarConfig(targetRoot) {
  const root = await lstat(targetRoot);
  if (!root.isDirectory() || root.isSymbolicLink() || await realpath(targetRoot) !== targetRoot) {
    throw new Error("prepared Claude config must be a real directory");
  }
  const settings = await lstat(resolve(targetRoot, "settings.json"));
  if (!settings.isSymbolicLink() || await readlink(resolve(targetRoot, "settings.json")) !== MANAGED_SETTINGS_PATH) {
    throw new Error("prepared Claude settings are not managed");
  }
  const marker = JSON.parse(await readFile(resolve(targetRoot, ".codeflare-projection.json"), "utf8"));
  if (marker?.version !== 1 || !Array.isArray(marker.links) || marker.settings !== MANAGED_SETTINGS_PATH) {
    throw new Error("prepared Claude projection is invalid");
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

async function projectableEntry(path, canonicalSource) {
  const entry = await lstatOrUndefined(path);
  if (!entry || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) return false;
  const pending = [path];
  const visited = new Set();
  let inspected = 0;
  while (pending.length > 0) {
    if (++inspected > 10_000) return false;
    const candidate = pending.pop();
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink()) {
      const target = await realpath(candidate);
      if (!isAllowlistedSourcePath(target, canonicalSource)) return false;
      if (!visited.has(target)) pending.push(target);
      continue;
    }
    const canonicalCandidate = await realpath(candidate);
    if (!isAllowlistedSourcePath(canonicalCandidate, canonicalSource)) return false;
    if (visited.has(canonicalCandidate)) continue;
    visited.add(canonicalCandidate);
    if (candidateStat.isDirectory()) {
      const children = await readdir(candidate);
      for (const child of children) pending.push(resolve(candidate, child));
    } else if (!candidateStat.isFile()) {
      return false;
    }
  }
  return true;
}

function isAllowlistedSourcePath(path, canonicalSource) {
  const rel = relative(canonicalSource, path);
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
  return SIDEBAR_LINK_ALLOWLIST.includes(rel.split(/[\\/]/, 1)[0]);
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
  const serverDataRoot = process.argv[2];
  // Absent kind defaults to claude for backward compatibility with the original
  // single-argument shim contract.
  const agentKind = process.argv[3] || "claude";
  if (agentKind === "pi") {
    await prepareBaseOpenVscodeSettings(serverDataRoot);
    return;
  }
  if (agentKind !== "claude") {
    await prepareUnsupportedOpenVscodeSettings(serverDataRoot);
    return;
  }
  const managedSettings = await lstat(MANAGED_SETTINGS_PATH);
  if (!managedSettings.isFile() || managedSettings.isSymbolicLink() ||
      managedSettings.uid !== 0 || (managedSettings.mode & 0o222) !== 0) {
    throw new Error("managed Claude settings must be a root-owned immutable file");
  }
  await prepareOfficialClaudeIde({
    sourceRoot: "/home/user/.claude",
    targetRoot: "/tmp/codeflare-sidebar/claude/config",
    serverDataRoot,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Claude sidebar configuration preparation failed.\n");
    process.exitCode = 2;
  });
}
