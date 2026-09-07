#!/usr/bin/env python3
"""Behavioral proof for the image-owned Impeccable native question client."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def verify_engine(binary, expect_idle_bug=False):
    probe = subprocess.run([binary, "engine-probe"], capture_output=True, text=True, timeout=10, check=True)
    assert probe.stdout.strip() == "impeccable-engine 0.1.3", probe.stdout
    with tempfile.TemporaryDirectory(prefix="impeccable-engine-") as directory:
        questions = Path(directory) / ".impeccable" / "questions"
        questions.mkdir(parents=True)
        open_case = (20, 4, "PAGE CLOSED:") if expect_idle_bug else (20, 3, "WAITING:")
        for age_seconds, expected_status, expected_text in [open_case, (70, 4, "PAGE CLOSED:")]:
            (questions / "question.state.json").write_text(json.dumps({
                "pid": os.getpid(), "lastBeat": time.time() * 1000 - age_seconds * 1000,
            }))
            result = subprocess.run([
                binary, "serve-question", "--wait", "--key", "question",
                "--poll", "0.2", "--idle-grace", "60",
            ], cwd=directory, capture_output=True, text=True, timeout=10)
            assert result.returncode == expected_status, (result.returncode, result.stdout, result.stderr)
            assert result.stdout.startswith(expected_text), result.stdout
    print("Upstream idle-grace regression reproduced" if expect_idle_bug else "Impeccable native engine: identity and idle-grace behavior passed")


def verify_scan(binary, expect_symlink_bug=False):
    with tempfile.TemporaryDirectory(prefix="impeccable-scan-") as directory:
        root = Path(directory)
        target = root / "target"
        target.mkdir()
        outside = root / "outside"
        outside.mkdir()
        (outside / "private.png").write_bytes(b"unannotated raster")
        (target / "escape").symlink_to(outside, target_is_directory=True)

        def scan(path):
            return subprocess.run([binary, "embed-prompt", "--scan", str(path)],
                                  capture_output=True, text=True, timeout=10)

        result = scan(target)
        if expect_symlink_bug:
            assert result.returncode == 3 and "private.png" in result.stdout, result
            print("Upstream symlink traversal regression reproduced")
            return
        assert result.returncode == 0 and "private.png" not in result.stdout, result
        for explicit in [target / "escape", str(target / "escape") + "/"]:
            result = scan(explicit)
            assert result.returncode == 1, result
            assert "symbolic link" in result.stderr, result.stderr
        (target / "broken").symlink_to(root / "absent")
        (target / "cycle").symlink_to(target, target_is_directory=True)
        result = scan(target)
        assert result.returncode == 0, result
        nested = target / "nested"
        nested.mkdir()
        for extension in ["png", "jpg", "webp"]:
            (nested / f"plain.{extension}").write_bytes(b"unannotated raster")
        for excluded in [".hidden", "node_modules"]:
            folder = target / excluded
            folder.mkdir()
            (folder / "excluded.png").write_bytes(b"unannotated raster")
        result = scan(target)
        assert result.returncode == 3, result
        assert "SCAN: 3 rasters, 3 missing" in result.stdout, result.stdout
        assert "private.png" not in result.stdout and "excluded.png" not in result.stdout, result.stdout
    print("Native raster scan boundary passed")


if __name__ == "__main__":
    binary = str(Path(sys.argv[1]).resolve())
    upstream = "--expect-idle-bug" in sys.argv[2:]
    verify_engine(binary, upstream)
    verify_scan(binary, upstream)
