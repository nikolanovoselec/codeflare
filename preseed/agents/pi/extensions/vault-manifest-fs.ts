/**
 * Vault-extract content-hash manifest filesystem layer.
 *
 * Kept separate from Pi lifecycle code so detection and transactional promotion
 * can be driven with real temporary files in the Workers test pool.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  buildVaultManifest,
  isVaultExcludedPath,
  parseVaultManifest,
  vaultManifestChanges,
  type VaultManifest,
} from "./memory-vault-helpers";

export type ManifestPromotion = "promoted" | "already-promoted" | "invalid";

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

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
          out[relative(vaultRoot, path).replaceAll("\\", "/")] = sha256(readFileSync(path));
        } catch { /* vanished or unreadable: retry on the next pass */ }
      }
    }
  }
  return out;
}

export function readVaultManifest(manifestPath: string): VaultManifest {
  try { return parseVaultManifest(readFileSync(manifestPath, "utf8")); } catch { return parseVaultManifest(undefined); }
}

export function changedVaultFilesIn(vaultRoot: string, manifestPath: string): string[] {
  const current = collectVaultFileHashes(vaultRoot);
  return vaultManifestChanges(current, readVaultManifest(manifestPath)).map((path) => join(vaultRoot, path));
}

export function serializeVaultManifest(hashes: Record<string, string>): string {
  return JSON.stringify(buildVaultManifest(hashes), null, 2);
}

export function vaultManifestContentHash(hashes: Record<string, string>): string {
  return sha256(serializeVaultManifest(hashes));
}

export function writeVaultManifest(manifestPath: string, hashes: Record<string, string>): string {
  const content = serializeVaultManifest(hashes);
  mkdirSync(dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.tmp.${process.pid}`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, manifestPath);
  return sha256(content);
}

export function promoteVaultManifest(
  stagedPath: string,
  committedPath: string,
  expectedHash: string,
): ManifestPromotion {
  if (existsSync(stagedPath)) {
    try {
      if (sha256(readFileSync(stagedPath)) !== expectedHash) return "invalid";
      renameSync(stagedPath, committedPath);
      return "promoted";
    } catch {
      return "invalid";
    }
  }
  try {
    return sha256(readFileSync(committedPath)) === expectedHash ? "already-promoted" : "invalid";
  } catch {
    return "invalid";
  }
}

export function commitVaultManifestTo(vaultRoot: string, manifestPath: string): void {
  writeVaultManifest(manifestPath, collectVaultFileHashes(vaultRoot));
}

export default function () {
  // Helper module only; loaded by Pi extension scanner as a no-op extension.
}
