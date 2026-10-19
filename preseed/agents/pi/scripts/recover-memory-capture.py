#!/usr/bin/env python3
"""Recognize a matching post-commit Pi capture receipt without changing it."""

import json
import os
from pathlib import Path
import re
import runpy
import stat
import sys
from uuid import UUID

sys.dont_write_bytecode = True


def read_regular(path: Path, base: Path) -> str | None:
    """Refuse redirected/special artifacts before opening them, including FIFOs."""
    current = base
    for part in ("", *path.relative_to(base).parts):
        if part:
            current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            return None
        if current != path:
            if not stat.S_ISDIR(info.st_mode):
                raise ValueError("unsafe receipt directory")
        elif not stat.S_ISREG(info.st_mode):
            raise ValueError("receipt is not a regular file")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, encoding="utf-8") as stream:
        opened = os.fstat(stream.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("receipt changed while opening")
        return stream.read()


def main() -> None:
    if len(sys.argv) != 3:
        raise ValueError("usage: recover-memory-capture.py VARS_FILE VAULT_ROOT")
    variables = Path(sys.argv[1]).absolute()
    vault = Path(sys.argv[2])
    if not vault.is_absolute():
        raise ValueError("Vault root must be absolute")
    request = json.loads(read_regular(variables, variables.parent) or "")
    if not isinstance(request, dict) or type(request.get("version")) is not int or request["version"] != 1:
        raise ValueError("unsupported request")
    request_id = request.get("requestId")
    session_id = request.get("sessionId")
    timestamp = request.get("captureTimestamp")
    filename = request.get("captureFilename")
    count = request.get("promptCount")
    if not isinstance(request_id, str) or str(UUID(request_id)) != request_id:
        raise ValueError("invalid request identity")
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", session_id):
        raise ValueError("invalid session identity")
    if type(count) is not int or count < 0:
        raise ValueError("invalid prompt count")
    if not isinstance(timestamp, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3}Z|Z|[+-]\d{4})?", timestamp
    ):
        raise ValueError("invalid capture timestamp")
    if (not isinstance(filename, str) or filename == "Archive.md"
            or "/" in filename or "\\" in filename
            or not filename.startswith(timestamp + "-") or not filename.endswith(".md")):
        raise ValueError("invalid capture filename")
    target = vault / "Raw" / "Sessions" / filename
    chunk_path = vault / "graphify-out" / f".graphify_chunk_{request_id}.json"
    note = read_regular(target, vault)
    chunk_text = read_regular(chunk_path, vault)
    if note is None and chunk_text is None:
        print("NOT_PUBLISHED")
        return
    if note is None or chunk_text is None:
        raise ValueError("incomplete post-commit receipt")
    frontmatter = re.match(r"\A---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)", note)
    if not frontmatter:
        raise ValueError("capture identity is missing")
    expected = {
        "session_id": session_id,
        "captured_at": timestamp,
        "captured_prompt_count": str(count),
        "captured_chunks": "1",
    }
    found = {}
    for line in frontmatter[1].splitlines():
        key, separator, value = line.partition(":")
        if separator and key in expected:
            if key in found:
                raise ValueError("duplicate capture identity")
            value = value.strip()
            if value.startswith('"'):
                value = json.loads(value)
            elif value.startswith("'") and value.endswith("'"):
                value = value[1:-1].replace("''", "'")
            found[key] = value
    if found != expected:
        raise ValueError("capture identity differs from the frozen request")
    builder = runpy.run_path(str(Path(__file__).with_name("build-memory-graph.py")))
    if json.loads(chunk_text) != builder["build_graph"](note, target):
        raise ValueError("chunk differs from the deterministic capture graph")
    print(f"RECOVERED {target}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError):
        print("Capture recovery refused: invalid request or post-commit receipt.", file=sys.stderr)
        raise SystemExit(1)
