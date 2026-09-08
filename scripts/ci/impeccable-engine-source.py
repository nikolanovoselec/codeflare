#!/usr/bin/env python3
"""Fast source-level regression for Codeflare's pinned Impeccable Rust patches."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
SOURCE_PATHS = (
    "Cargo.toml",
    "crates/context/src/serve_question.rs",
    "crates/context/src/embed_prompt.rs",
)


def read_archive(url: str, expected_sha256: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "codeflare-impeccable-regression"})
    with urllib.request.urlopen(request, timeout=20) as response:
        archive = response.read(MAX_ARCHIVE_BYTES + 1)
    if len(archive) > MAX_ARCHIVE_BYTES:
        raise ValueError("Impeccable source archive exceeds the CI bound")
    if hashlib.sha256(archive).hexdigest() != expected_sha256:
        raise ValueError("Impeccable source archive digest does not match the reviewed pin")
    return archive


def extract_sources(archive: bytes, destination: Path) -> None:
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
        members = {member.name: member for member in tar.getmembers() if member.isfile()}
        roots = {PurePosixPath(name).parts[0] for name in members}
        if len(roots) != 1:
            raise ValueError("Pinned archive must contain one source root")
        archive_root = roots.pop()
        for relative in SOURCE_PATHS:
            member = members.get(f"{archive_root}/{relative}")
            if member is None:
                raise ValueError(f"Pinned archive must contain {relative}")
            source = tar.extractfile(member)
            if source is None:
                raise ValueError(f"Could not read {relative} from pinned archive")
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read())


def source_between(source: str, start: str, end: str) -> str:
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError(f"Impeccable source boundary is missing or ambiguous: {start}")
    return source[source.index(start):source.index(end)]


def compile_probe(source_root: Path, output: Path) -> None:
    embed = (source_root / "crates/context/src/embed_prompt.rs").read_text()
    serve = (source_root / "crates/context/src/serve_question.rs").read_text()
    walk = source_between(embed, "fn walk(", "\nfn is_raster(")
    is_raster = source_between(embed, "fn is_raster(", "\npub fn run(")
    conditions = re.findall(
        r"if\s+(!mid_delivery\s+&&\s+lb\s*!=\s*0\.0\s+&&\s+now_ms\(\)\s*-\s*lb\s*>\s*[^\s{]+)\s*\{",
        serve,
    )
    if len(conditions) != 1:
        raise ValueError("Impeccable idle-grace condition is missing or ambiguous")
    condition = conditions[0].replace("now_ms()", "now")
    harness = f"""
use std::env;

fn read_dir_names(path: &str) -> Option<Vec<String>> {{
    let mut names: Vec<String> = std::fs::read_dir(path).ok()?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    Some(names)
}}

{walk}

{is_raster}

fn closes(mid_delivery: bool, lb: f64, now: f64, idle_grace_ms: f64) -> bool {{
    {condition}
}}

fn main() {{
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("idle") {{
        let age: f64 = args[2].parse().unwrap();
        let grace: f64 = args[3].parse().unwrap();
        println!("{{}}", closes(false, 1.0, age + 1.0, grace));
        return;
    }}
    let mut rasters = Vec::new();
    match walk(&args[2], true, &mut rasters) {{
        Ok(()) => {{
            rasters.sort();
            for raster in rasters {{ println!("{{}}", raster); }}
        }}
        Err(error) => {{
            eprintln!("{{}}", error);
            std::process::exit(1);
        }}
    }}
}}
"""
    harness_path = output.with_suffix(".rs")
    harness_path.write_text(harness)
    subprocess.run(["rustc", "--edition=2021", str(harness_path), "-o", str(output)], check=True, timeout=15)


def run(binary: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(binary), *args], capture_output=True, text=True, timeout=5)


def verify_probe(binary: Path, expect_upstream_bugs: bool) -> None:
    idle_open = run(binary, "idle", "20000", "60000")
    idle_closed = run(binary, "idle", "70000", "60000")
    expected_open = "true" if expect_upstream_bugs else "false"
    if idle_open.returncode != 0 or idle_open.stdout.strip() != expected_open:
        raise AssertionError((idle_open.returncode, idle_open.stdout, idle_open.stderr))
    if idle_closed.returncode != 0 or idle_closed.stdout.strip() != "true":
        raise AssertionError((idle_closed.returncode, idle_closed.stdout, idle_closed.stderr))

    with tempfile.TemporaryDirectory(prefix="impeccable-source-scan-") as directory:
        root = Path(directory)
        target = root / "target"
        nested = target / "nested"
        nested.mkdir(parents=True)
        outside = root / "outside"
        outside.mkdir()
        (outside / "private.png").write_bytes(b"private")
        (target / "escape").symlink_to(outside, target_is_directory=True)
        expected = []
        for extension in ("png", "jpg", "webp"):
            raster = nested / f"plain.{extension}"
            raster.write_bytes(b"raster")
            expected.append(str(raster))
        for excluded in (".hidden", "node_modules"):
            folder = target / excluded
            folder.mkdir()
            (folder / "excluded.png").write_bytes(b"excluded")

        scanned = run(binary, "scan", str(target))
        if scanned.returncode != 0:
            raise AssertionError((scanned.returncode, scanned.stdout, scanned.stderr))
        actual = scanned.stdout.strip().splitlines()
        if expect_upstream_bugs:
            if str(target / "escape" / "private.png") not in actual:
                raise AssertionError("Upstream symlink traversal regression was not reproduced")
            return

        if actual != sorted(expected):
            raise AssertionError((actual, sorted(expected)))
        (target / "broken").symlink_to(root / "absent")
        (target / "cycle").symlink_to(target, target_is_directory=True)
        scanned = run(binary, "scan", str(target))
        if scanned.returncode != 0 or scanned.stdout.strip().splitlines() != sorted(expected):
            raise AssertionError((scanned.returncode, scanned.stdout, scanned.stderr))
        for explicit in (
            target / "escape",
            Path(f"{target / 'escape'}/"),
            target / "escape" / ".",
            target / "escape" / "private.png",
            target / "escape" / "..",
        ):
            rejected = run(binary, "scan", str(explicit))
            if rejected.returncode != 1 or "symbolic link" not in rejected.stderr:
                raise AssertionError((str(explicit), rejected.returncode, rejected.stdout, rejected.stderr))


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    pin = json.loads((root / "image/impeccable-engine.json").read_text())
    if pin.get("version") != "0.1.3" or not re.fullmatch(r"[a-f0-9]{40}", pin.get("commit", "")):
        raise ValueError("Invalid Impeccable engine identity pin")
    if not re.fullmatch(r"[a-f0-9]{64}", pin.get("sha256", "")):
        raise ValueError("Invalid Impeccable engine archive pin")
    if shutil.which("rustc") is None:
        raise RuntimeError("The CI runner must provide rustc")

    archive = read_archive(
        f"https://codeload.github.com/pbakaus/impeccable/tar.gz/{pin['commit']}",
        pin["sha256"],
    )
    with tempfile.TemporaryDirectory(prefix="impeccable-source-") as directory:
        source_root = Path(directory) / "source"
        extract_sources(archive, source_root)
        cargo = source_root.joinpath("Cargo.toml").read_text()
        if not re.search(r"(?m)^version\s*=\s*\"0\.1\.3\"\s*$", cargo):
            raise ValueError("Pinned Impeccable source version is not 0.1.3")

        upstream_probe = Path(directory) / "upstream-probe"
        compile_probe(source_root, upstream_probe)
        verify_probe(upstream_probe, expect_upstream_bugs=True)

        subprocess.run(
            [sys.executable, str(root / "scripts/patch-impeccable-engine.py"), str(source_root)],
            check=True,
            timeout=5,
        )
        patched_probe = Path(directory) / "patched-probe"
        compile_probe(source_root, patched_probe)
        verify_probe(patched_probe, expect_upstream_bugs=False)

    print("Impeccable source identity, idle-grace, and raster boundaries passed")


if __name__ == "__main__":
    main()
