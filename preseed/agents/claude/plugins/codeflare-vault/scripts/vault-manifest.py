#!/usr/bin/env python3
"""vault-manifest.py - content-hash change detection for vault-extract.

The vault-extract high-water mark is a content-hash manifest, NOT a file mtime.
The R2 restore (rclone sync, entrypoint.sh) rewrites every vault file's mtime to
download-time - a May-authored note comes back stamped "today", all files
clustered at one instant - so any `find -newer marker` / mtime comparison flags
the whole vault as changed on the boot where the restore lands after the marker.
That was the 200k-token full re-extraction. Hashing the bytes is immune: an mtime
reset changes nothing, so unchanged content is zero work.

The manifest is {"version": 1, "files": {vault-relative path: sha256 hex}}, stored
at <vault>/graphify-out/vault-extract-manifest.json (R2-synced via an explicit
allow-rule so it survives restart). This mirrors the Pi TypeScript implementation
in vault-manifest-fs.ts byte-for-byte (same exclusion set, same sha256, same
POSIX relative keys) so a session can switch runtimes and share one manifest.

Usage:
  vault-manifest.py changed <vault_root> <manifest_path>
      Print absolute paths of files whose bytes are new/changed vs the manifest,
      one per line, sorted. Deletions are not printed (they need no extraction).
  vault-manifest.py commit <vault_root> <manifest_path>
      Write the manifest = current {relpath: sha256} for every non-excluded file
      (atomic tmp+rename). This is the "advance the high-water mark" step.

Stdlib only (no graphify/networkx), so it is cheap to spawn from the 60s daemon.
"""

import hashlib
import json
import os
import sys

# Exclusion set — MUST stay identical to VAULT_GENERATED_PREFIXES +
# VAULT_PRESEED_ROOT_FILES in memory-vault-helpers.ts. A path is excluded when it
# is generated/agent-owned/derived, a codeflare-authoritative root page, or
# resolves outside the vault root.
PRUNE_PREFIXES = (
    "Raw/Sessions",      # memory-capture session notes (agent-owned)
    "Raw/Graphs",        # served viz copy (extractor step 6) — the self-trigger
    "graphify-out",      # all graphify artifacts incl. the manifest itself
    "Library/Codeflare", # boot-preseeded SilverBullet plug bundles
    ".silverbullet",     # editor-managed metadata
)
PRESEED_ROOT_FILES = frozenset(("Index.md", "README.md", "CONFIG.md", "STYLES.md"))


def _rel(vault_root, path):
    return os.path.relpath(path, vault_root).replace(os.sep, "/")


def _excluded(rel):
    if not rel or rel.startswith(".."):
        return True
    if rel in PRESEED_ROOT_FILES:
        return True
    return any(rel == p or rel.startswith(p + "/") for p in PRUNE_PREFIXES)


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(vault_root):
    """Return {vault-relative path -> sha256} for every non-excluded file."""
    out = {}
    if not os.path.isdir(vault_root):
        return out
    for dirpath, dirnames, filenames in os.walk(vault_root):
        # Prune excluded directories in place so we never descend into them.
        dirnames[:] = [d for d in dirnames if not _excluded(_rel(vault_root, os.path.join(dirpath, d)))]
        for name in filenames:
            abspath = os.path.join(dirpath, name)
            rel = _rel(vault_root, abspath)
            if _excluded(rel):
                continue
            try:
                out[rel] = _sha256(abspath)
            except OSError:
                # Unreadable (permission/vanished): skip; next tick retries.
                continue
    return out


def load_manifest(manifest_path):
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            blob = json.load(f)
    except (OSError, ValueError):
        return {}
    files = blob.get("files") if isinstance(blob, dict) else None
    if not isinstance(files, dict):
        return {}
    return {k: v for k, v in files.items() if isinstance(v, str)}


def cmd_changed(vault_root, manifest_path):
    current = collect(vault_root)
    prior = load_manifest(manifest_path)
    changed = [rel for rel, h in current.items() if prior.get(rel) != h]
    for rel in sorted(changed):
        print(os.path.join(vault_root, rel))


def cmd_commit(vault_root, manifest_path):
    current = collect(vault_root)
    manifest = {"version": 1, "files": {k: current[k] for k in sorted(current)}}
    os.makedirs(os.path.dirname(manifest_path), exist_ok=True)
    tmp = "{}.tmp.{}".format(manifest_path, os.getpid())
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, manifest_path)


def main(argv):
    if len(argv) != 4 or argv[1] not in ("changed", "commit"):
        sys.stderr.write("usage: vault-manifest.py {changed|commit} <vault_root> <manifest_path>\n")
        return 2
    _, mode, vault_root, manifest_path = argv
    if mode == "changed":
        cmd_changed(vault_root, manifest_path)
    else:
        cmd_commit(vault_root, manifest_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
