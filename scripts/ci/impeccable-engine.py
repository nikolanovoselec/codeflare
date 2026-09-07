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


if __name__ == "__main__":
    verify_engine(str(Path(sys.argv[1]).resolve()), "--expect-idle-bug" in sys.argv[2:])
