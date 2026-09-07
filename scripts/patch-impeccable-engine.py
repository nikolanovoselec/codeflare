#!/usr/bin/env python3
"""Preserve Codeflare's configured question idle grace in engine 0.1.3."""
from pathlib import Path
import sys
import tomllib


def patch_engine(root):
    root = Path(root)
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    if manifest["workspace"]["package"]["version"] != "0.1.3":
        raise ValueError("Unsupported Impeccable engine; expected 0.1.3")
    path = root / "crates/context/src/serve_question.rs"
    source = path.read_text()
    before = "if !mid_delivery && lb != 0.0 && now_ms() - lb > 15000.0 {"
    after = "if !mid_delivery && lb != 0.0 && now_ms() - lb > idle_grace_ms { // CODEFLARE_IDLE_GRACE"
    if source.count(after) == 1 and source.count(before) == 0:
        return
    if source.count(before) != 1 or "CODEFLARE_IDLE_GRACE" in source:
        raise ValueError("Impeccable question idle-grace anchor is missing or ambiguous")
    path.write_text(source.replace(before, after))


if __name__ == "__main__":
    patch_engine(sys.argv[1])
