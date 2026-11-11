#!/usr/bin/env python3
"""Behavioral proof for the image-owned Impeccable native question client."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def verify_engine(binary, expect_idle_bug=False, expected_version="0.1.15"):
    assert expected_version in ("0.1.5", "0.1.10", "0.1.11", "0.1.15", "0.1.16", "0.1.18", "0.1.21"), expected_version
    probe = subprocess.run([binary, "engine-probe"], capture_output=True, text=True, timeout=10, check=True)
    assert probe.stdout.strip() == f"impeccable-engine {expected_version}", probe.stdout
    with tempfile.TemporaryDirectory(prefix="impeccable-engine-") as directory:
        questions = Path(directory) / ".impeccable" / "questions"
        questions.mkdir(parents=True)
        # Legacy upstream closes too early (15s); 0.1.21 closes too late
        # for grace=60 (90s). Both also ignore a longer configured grace.
        legacy_upstream = expect_idle_bug and expected_version != "0.1.21"
        for age_seconds, grace_seconds, closes in [
            (20, 60, legacy_upstream),
            (70, 60, not expect_idle_bug or legacy_upstream),
            (110, 60, True),
            (100, 120, expect_idle_bug),
            (130, 120, True),
        ]:
            expected_status, expected_text = (4, "PAGE CLOSED:") if closes else (3, "WAITING:")
            (questions / "question.state.json").write_text(json.dumps({
                "pid": os.getpid(), "lastBeat": time.time() * 1000 - age_seconds * 1000,
            }))
            result = subprocess.run([
                binary, "serve-question", "--wait", "--key", "question",
                "--poll", "0.2", "--idle-grace", str(grace_seconds),
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
        for explicit in [
            str(target / "escape"), str(target / "escape") + "/",
            str(target / "escape") + "/.", str(target / "escape" / "private.png"),
            str(target / "escape") + "/..",
        ]:
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
    version = next((argument.split("=", 1)[1] for argument in sys.argv[2:]
                    if argument.startswith("--engine-version=")), "0.1.15")
    verify_engine(binary, upstream, version)
    verify_scan(binary, upstream)
