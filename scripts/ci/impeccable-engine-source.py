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
import tomllib
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


def probe_module(source_root: Path, module_name: str) -> str:
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
    version = tomllib.loads((source_root / "Cargo.toml").read_text())["workspace"]["package"]["version"]
    constants = ""
    if version == "0.1.21":
        # Compile the actual reviewed upstream constant, not a probe substitute.
        declarations = re.findall(r"(?m)^const PAGE_CLOSED_GRACE_MS: f64 = [^;\n]+;$", serve)
        if declarations != ["const PAGE_CLOSED_GRACE_MS: f64 = 90000.0;"]:
            raise ValueError("Impeccable page-closed grace constant differs from the reviewed source")
        constants = declarations[0]
    return f"""
mod {module_name} {{
{constants}
    fn read_dir_names(path: &str) -> Option<Vec<String>> {{
        let mut names: Vec<String> = std::fs::read_dir(path).ok()?
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .collect();
        names.sort();
        Some(names)
    }}

{walk}

{is_raster}

    #[allow(unused_variables)]
    pub fn closes(age: f64, idle_grace_ms: f64) -> bool {{
        let mid_delivery = false;
        let lb = 1.0;
        let now = age + lb;
        {condition}
    }}

    pub fn scan(path: &str) -> Result<Vec<String>, String> {{
        let mut rasters = Vec::new();
        walk(path, true, &mut rasters)?;
        rasters.sort();
        Ok(rasters)
    }}
}}
"""


def compile_probe(upstream_root: Path, patched_root: Path, output: Path) -> None:
    harness = f"""
use std::env;

{probe_module(upstream_root, "upstream")}
{probe_module(patched_root, "patched")}

fn main() {{
    let args: Vec<String> = env::args().collect();
    let variant = args[1].as_str();
    if args[2] == "idle" {{
        let age: f64 = args[3].parse().unwrap();
        let grace: f64 = args[4].parse().unwrap();
        let closed = match variant {{
            "upstream" => upstream::closes(age, grace),
            "patched" => patched::closes(age, grace),
            _ => panic!("unknown source variant"),
        }};
        println!("{{}}", closed);
        return;
    }}
    let result = match variant {{
        "upstream" => upstream::scan(&args[3]),
        "patched" => patched::scan(&args[3]),
        _ => panic!("unknown source variant"),
    }};
    match result {{
        Ok(rasters) => for raster in rasters {{ println!("{{}}", raster); }},
        Err(error) => {{
            eprintln!("{{}}", error);
            std::process::exit(1);
        }}
    }}
}}
"""
    harness_path = output.with_suffix(".rs")
    harness_path.write_text(harness)
    subprocess.run(["rustc", "--edition=2021", str(harness_path), "-o", str(output)], check=True, timeout=60)


def run(binary: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([str(binary), *args], capture_output=True, text=True, timeout=5)


def verify_probe(binary: Path, expect_upstream_bugs: bool, engine_version: str) -> None:
    variant = "upstream" if expect_upstream_bugs else "patched"
    legacy_upstream = expect_upstream_bugs and engine_version != "0.1.21"
    for age, grace, closes in [
        (20000, 60000, legacy_upstream),
        (70000, 60000, not expect_upstream_bugs or legacy_upstream),
        (110000, 60000, True),
        (100000, 120000, expect_upstream_bugs),
        (130000, 120000, True),
    ]:
        result = run(binary, variant, "idle", str(age), str(grace))
        if result.returncode != 0 or result.stdout.strip() != str(closes).lower():
            raise AssertionError((engine_version, variant, age, grace, result.returncode, result.stdout, result.stderr))

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

        scanned = run(binary, variant, "scan", str(target))
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
        scanned = run(binary, variant, "scan", str(target))
        if scanned.returncode != 0 or scanned.stdout.strip().splitlines() != sorted(expected):
            raise AssertionError((scanned.returncode, scanned.stdout, scanned.stderr))
        escape = str(target / "escape")
        for explicit in (escape, f"{escape}/", f"{escape}/.", f"{escape}/private.png", f"{escape}/.."):
            rejected = run(binary, variant, "scan", explicit)
            if rejected.returncode != 1 or "symbolic link" not in rejected.stderr:
                raise AssertionError((explicit, rejected.returncode, rejected.stdout, rejected.stderr))


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    if shutil.which("rustc") is None:
        raise RuntimeError("The CI runner must provide rustc")

    # Keep the current 4.8.0 regression alongside the new candidate. Complete
    # native-binary gates for these and every legacy engine remain in Docker.
    for name, version, commit, digest in [
        ("impeccable-engine-4.8.0.json", "0.1.18", "f29cd24fdecfa5612e35e34c1c868d4a3fca930c",
         "1f243cc93a5ab530aac10dbae0e13447d356b2d4ca3cd990e59de36327ff2bc9"),
        ("impeccable-engine.json", "0.1.21", "fe45455d36ed14c85ece25c9b868344e55713352",
         "36ebd8da4a2c6117202c9816634a05de6bcc3a55e6bba84d49e247bb7f06892b"),
    ]:
        pin = json.loads((root / "image" / name).read_text())
        if pin != {"version": version, "commit": commit, "sha256": digest}:
            raise ValueError(f"Impeccable {name} differs from the reviewed source identity")
        archive = read_archive(
            f"https://codeload.github.com/pbakaus/impeccable/tar.gz/{commit}", digest,
        )
        with tempfile.TemporaryDirectory(prefix="impeccable-source-") as directory:
            source_root = Path(directory) / "source"
            extract_sources(archive, source_root)
            cargo = tomllib.loads(source_root.joinpath("Cargo.toml").read_text())
            if cargo["workspace"]["package"]["version"] != version:
                raise ValueError("Pinned Impeccable source version does not match its identity")

            patched_root = Path(directory) / "patched-source"
            shutil.copytree(source_root, patched_root)
            subprocess.run(
                [sys.executable, str(root / "scripts/patch-impeccable-engine.py"), str(patched_root)],
                check=True,
                timeout=5,
            )
            probe = Path(directory) / "source-probe"
            compile_probe(source_root, patched_root, probe)
            verify_probe(probe, expect_upstream_bugs=True, engine_version=version)
            verify_probe(probe, expect_upstream_bugs=False, engine_version=version)

        print(f"Impeccable {version} source identity, idle-grace, and raster boundaries passed")


if __name__ == "__main__":
    main()
