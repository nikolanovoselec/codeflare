#!/usr/bin/env python3
"""Fast exact-source compatibility gate for Codeflare's pinned rclone patch."""
from __future__ import annotations

import hashlib
import io
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

VERSION = "1.73.5"
ARCHIVE_URL = f"https://codeload.github.com/rclone/rclone/tar.gz/refs/tags/v{VERSION}"
ARCHIVE_SHA256 = "e52541bc238dd434a0335f467697d7d9575529698a74aab534ad39b8649f8a49"
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
SOURCE_PATHS = (
    "VERSION",
    "backend/s3/s3.go",
    "cmd/bisync/listing.go",
    "cmd/bisync/queue.go",
    "fs/operations/copy.go",
    "fs/operations/logger.go",
    "fs/operations/multithread.go",
)
PATCHED_PATHS = frozenset(SOURCE_PATHS[1:])


def read_archive() -> bytes:
    request = urllib.request.Request(ARCHIVE_URL, headers={"User-Agent": "codeflare-rclone-regression"})
    with urllib.request.urlopen(request, timeout=20) as response:
        archive = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError("rclone source archive exceeds the CI bound")
    if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA256:
        raise ValueError("rclone source archive digest does not match the reviewed pin")
    return archive


def extract_sources(archive: bytes, destination: Path) -> None:
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
        members = {member.name: member for member in source.getmembers() if member.isfile()}
        roots = {PurePosixPath(name).parts[0] for name in members}
        if len(roots) != 1:
            raise ValueError("Pinned archive must contain one source root")
        archive_root = roots.pop()
        for relative in SOURCE_PATHS:
            member = members.get(f"{archive_root}/{relative}")
            if member is None:
                raise ValueError(f"Pinned archive must contain {relative}")
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError(f"Could not read {relative} from pinned archive")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(stream.read())


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    archive = read_archive()
    with tempfile.TemporaryDirectory(prefix="rclone-source-") as directory:
        upstream = Path(directory) / "upstream"
        patched = Path(directory) / "patched"
        extract_sources(archive, upstream)
        if (upstream / "VERSION").read_text().strip() != f"v{VERSION}":
            raise ValueError("Pinned rclone source version is not the reviewed version")
        shutil.copytree(upstream, patched)
        subprocess.run(
            [sys.executable, str(root / "scripts/patch-rclone-bisync.py"), str(patched), VERSION],
            check=True,
            timeout=5,
        )
        changed = {
            relative
            for relative in SOURCE_PATHS
            if (upstream / relative).read_bytes() != (patched / relative).read_bytes()
        }
        if changed != PATCHED_PATHS:
            raise ValueError(f"rclone patch changed an unexpected source set: {sorted(changed ^ PATCHED_PATHS)}")

    print(f"rclone v{VERSION} source identity and bookkeeping patch compatibility passed")


if __name__ == "__main__":
    main()
