#!/usr/bin/env python3
"""Prepare/restore only the reviewed key-ordered, otherwise unpatched S3 fixture.

CLI: prepare-rclone-s3-fixture.py prepare|restore SOURCE VERSION BACKUP
1.73.5 saves the original pager to a new BACKUP, swaps its sort, then restores
and removes BACKUP. 1.75.2 and 1.76.0 verify their already key-ordered lists
on both calls; no source edit or BACKUP is needed. Never overwrite a BACKUP.
"""
import hashlib
from pathlib import Path
import sys

PAGER_SHA256 = "ef54065b059ef752883330fdb3b4cfb7f6d9242fa0ef767524ab8f3e0fd96764"
LIST_SHA256 = {
    "1.75.2": "f1e848a1dfe6ed86b1094cfbcbc61e5cc205225497da325cfdfccb50a3b97ad6",
    "1.76.0": "cb2773e1d5508d6e66a4b9ed0510f01d5eb22a105460771e42f6a46608eec05d",
}
OLD_SORT = b"list.Contents[i].LastModified.Before(list.Contents[j].LastModified.Time)"
KEY_SORT = b"list.Contents[i].Key < list.Contents[j].Key"
LIST_SORT = b"return strings.Compare(sortKey(a), sortKey(b))"


def require_digest(content, digest):
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError("Unreviewed S3 fixture source digest")


def fixture(action, root, version, backup):
    if action not in ("prepare", "restore"):
        raise ValueError("Expected prepare or restore")
    if version not in ("1.73.5", "1.75.2", "1.76.0"):
        raise ValueError(f"rclone {version} is not approved for the S3 fixture")
    if (root / "VERSION").read_text().strip() != f"v{version}":
        raise ValueError("Unreviewed upstream fixture version")
    pager = root / "cmd/serve/s3/pager.go"
    if version in LIST_SHA256:
        content = (root / "cmd/serve/s3/list.go").read_bytes()
        require_digest(content, LIST_SHA256[version])
        if content.count(LIST_SORT) != 1 or pager.exists() or backup.exists():
            raise ValueError("Unreviewed S3 fixture ordering or unexpected pager/backup")
        return
    if action == "prepare":
        original = pager.read_bytes()
    else:
        original = backup.read_bytes()
    require_digest(original, PAGER_SHA256)
    if original.count(OLD_SORT) != 1:
        raise ValueError("Unreviewed S3 fixture pager")
    prepared = original.replace(OLD_SORT, KEY_SORT)
    if action == "prepare":
        # Exclusive backup creation precedes the only source write.
        with backup.open("xb") as saved:
            saved.write(original)
        pager.write_bytes(prepared)
    else:
        if pager.read_bytes() != prepared:
            raise ValueError("S3 fixture pager changed after preparation; refusing restore")
        pager.write_bytes(original)
        backup.unlink()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 5:
            raise ValueError("Usage: prepare-rclone-s3-fixture.py prepare|restore SOURCE VERSION BACKUP")
        fixture(sys.argv[1], Path(sys.argv[2]), sys.argv[3], Path(sys.argv[4]))
    except (ValueError, OSError) as error:
        sys.exit(str(error))
