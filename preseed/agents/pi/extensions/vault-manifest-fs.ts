/**
 * Vault-extract change detection — content-hash manifest (filesystem layer).
 *
 * Kept in its own module (no node:child_process, no Pi types) so the oracle test
 * can import and drive it directly in the Workers test pool. memory-vault.ts wraps
 * these with the hardcoded vault/manifest paths.
 *
 * Why content hashes and not mtimes: the R2 restore (rclone sync, entrypoint.sh)
 * rewrites every vault file's mtime to download-time — a May-authored note comes
 * back stamped "today", all files clustered at one instant. Any mtime-vs-marker
 * comparison then flags the whole vault as changed on the boot where the restore
 * lands after the marker, which is the 200k-token full re-extraction. Hashing the
 * bytes is immune: an mtime reset changes nothing, so unchanged content is zero work.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildVaultManifest, isVaultExcludedPath, parseVaultManifest, vaultManifestChanges, type VaultManifest } from "./memory-vault-helpers";

// Walk the vault and hash every non-excluded file's bytes.
// Returns {vault-relative path -> sha256 hex}. Unreadable files are skipped
// (permission/vanished), not failed — the next tick retries.
export function collectVaultFileHashes(vaultRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(vaultRoot)) return out;
  const stack = [vaultRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (isVaultExcludedPath(vaultRoot, path)) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) {
        try {
          out[relative(vaultRoot, path).replaceAll("\\", "/")] = createHash("sha256").update(readFileSync(path)).digest("hex");
        } catch { /* unreadable (permission/vanished): skip */ }
      }
    }
  }
  return out;
}

// Read + parse the persisted manifest; an absent or corrupt file is an empty
// manifest (every live file then reads as new).
export function readVaultManifest(manifestPath: string): VaultManifest {
  let text: string | null = null;
  try { text = readFileSync(manifestPath, "utf8"); } catch { /* absent → all new */ }
  return parseVaultManifest(text);
}

// Absolute paths of vault files whose bytes are new/changed vs the persisted
// manifest. Purely content-based → an mtime reset (R2 restore) yields zero.
// vaultManifestChanges already returns relpaths sorted, and prefixing vaultRoot
// uniformly preserves that order, so no re-sort is needed.
export function changedVaultFilesIn(vaultRoot: string, manifestPath: string): string[] {
  const current = collectVaultFileHashes(vaultRoot);
  return vaultManifestChanges(current, readVaultManifest(manifestPath)).map((rel) => join(vaultRoot, rel));
}

// Write a precomputed hash map as the manifest (atomic tmp+rename). Exported so a
// caller that already walked the vault (the extension's single detect-then-commit)
// does not have to re-hash every file a second time.
export function writeVaultManifest(manifestPath: string, hashes: Record<string, string>): void {
  const manifest = buildVaultManifest(hashes);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(tmp, manifestPath);
}

// Persist the current content map as the new high-water mark.
export function commitVaultManifestTo(vaultRoot: string, manifestPath: string): void {
  writeVaultManifest(manifestPath, collectVaultFileHashes(vaultRoot));
}

export default function () {
  // Helper module only; loaded by the Pi extension scanner as a no-op extension.
}
