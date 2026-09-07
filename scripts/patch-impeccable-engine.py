#!/usr/bin/env python3
"""Preserve Codeflare's question idle grace and raster scan boundary in engine 0.1.3."""
from pathlib import Path
import sys
import tomllib


def patch_engine(root):
    root = Path(root)
    manifest = tomllib.loads((root / "Cargo.toml").read_text())
    if manifest["workspace"]["package"]["version"] != "0.1.3":
        raise ValueError("Unsupported Impeccable engine; expected 0.1.3")
    patches = [
        ("serve_question.rs",
         "if !mid_delivery && lb != 0.0 && now_ms() - lb > 15000.0 {",
         "if !mid_delivery && lb != 0.0 && now_ms() - lb > idle_grace_ms { // CODEFLARE_IDLE_GRACE"),
        ("embed_prompt.rs",
         '    let md = std::fs::metadata(p).map_err(|e| e.to_string())?;',
         '''    // CODEFLARE_SCAN_BOUNDARY: never traverse a nested link or accept a linked target.
    if is_root {
        let mut prefix = std::path::PathBuf::new();
        for component in std::path::Path::new(p).components() {
            prefix.push(component.as_os_str());
            let metadata = std::fs::symlink_metadata(&prefix).map_err(|e| e.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err("scan target cannot be a symbolic link".into());
            }
        }
    }
    let trimmed = p.trim_end_matches('/');
    let checked_path = if trimmed.is_empty() { p } else { trimmed };
    let md = std::fs::symlink_metadata(checked_path).map_err(|e| e.to_string())?;
    if md.file_type().is_symlink() {
        if is_root {
            return Err("scan target cannot be a symbolic link".into());
        }
        return Ok(());
    }'''),
    ]
    transformed = []
    for filename, before, after in patches:
        path = root / "crates/context/src" / filename
        source = path.read_text()
        if source.count(after) == 1 and source.count(before) == 0:
            continue
        if source.count(before) != 1 or after in source:
            raise ValueError(f"Impeccable {filename} anchor is missing or ambiguous")
        transformed.append((path, source.replace(before, after)))
    # Validate every source before writing any correction.
    for path, source in transformed:
        path.write_text(source)


if __name__ == "__main__":
    patch_engine(sys.argv[1])
