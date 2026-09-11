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


def completed_copy_source(patched: Path) -> str:
    source = (patched / "cmd/bisync/queue.go").read_text()
    start = source.index("func (b *bisyncRun) WriteCompletedCopy(")
    marker = "\n}\n\n// ReadResults"
    if source.count(marker, start) != 1:
        raise ValueError("Patched completion callback boundary is missing or ambiguous")
    function = source[start:source.index(marker, start) + 2]
    function = function.replace("fs.Object", "Object")
    function = function.replace("operations.GetLoggerOpt", "GetLoggerOpt")
    function = function.replace("operations.Winner", "Winner")
    return function


def compile_behavior_probe(patched: Path, output: Path) -> None:
    function = completed_copy_source(patched)
    harness = f'''package main

import (
 "bytes"
 "context"
 "encoding/json"
 "fmt"
 "sync"
 "time"
)

var TZ = time.UTC

type objectFs struct{{ name string }}
func (f *objectFs) Name() string {{ return f.name }}
type Object interface {{
 Remote() string
 Size() int64
 ModTime(context.Context) time.Time
 Hash(context.Context, string) (string, error)
 Fs() *objectFs
}}
type fixtureObject struct{{ remote string; size int64; modified time.Time; hash string; fs *objectFs }}
func (o fixtureObject) Remote() string {{ return o.remote }}
func (o fixtureObject) Size() int64 {{ return o.size }}
func (o fixtureObject) ModTime(context.Context) time.Time {{ return o.modified }}
func (o fixtureObject) Hash(context.Context, string) (string, error) {{ return o.hash, nil }}
func (o fixtureObject) Fs() *objectFs {{ return o.fs }}
type Winner struct{{ Obj Object; Side string; Err error }}
type Results struct {{
 Name, AltName, Src, Dst string
 Size int64
 Modtime time.Time
 Hash, Flags string
 IsSrc, IsDst, IsWinner bool
 Winner Winner
 Origin string
 Err error
}}
type queueOptions struct{{ lock sync.Mutex; ignoreListingChecksum bool }}
type bisyncRun struct{{ queueOpt queueOptions }}
func (b *bisyncRun) getHashType(string) string {{ return "sha256" }}
func altName(string, Object, Object) string {{ return "" }}
func FsPathIfAny(Object) string {{ return "fixture" }}
type loggerOptions struct{{ JSON *bytes.Buffer }}
type loggerKey struct{{}}
func GetLoggerOpt(ctx context.Context) loggerOptions {{ return ctx.Value(loggerKey{{}}).(loggerOptions) }}
var fs = struct{{ Errorf func(Object, string, ...any) }}{{
 Errorf: func(_ Object, format string, args ...any) {{ panic(fmt.Sprintf(format, args...)) }},
}}

{function}

func main() {{
 sourceTime := time.Unix(100, 100)
 destinationTime := time.Unix(200, 200)
 fixtureFs := &objectFs{{name: "fixture"}}
 src := fixtureObject{{remote: "session.jsonl", size: 9, modified: sourceTime, hash: "source", fs: fixtureFs}}
 dst := fixtureObject{{remote: "session.jsonl", size: 9, modified: destinationTime, hash: "destination", fs: fixtureFs}}
 var encoded bytes.Buffer
 ctx := context.WithValue(context.Background(), loggerKey{{}}, loggerOptions{{JSON: &encoded}})
 b := &bisyncRun{{queueOpt: queueOptions{{ignoreListingChecksum: false}}}}
 b.WriteCompletedCopy(ctx, src, dst)
 decoder := json.NewDecoder(&encoded)
 type projection struct {{ Modtime time.Time; Hash, Origin string; IsWinner bool; Winner struct{{ Side string }} }}
 var sourceResult, destinationResult projection
 if decoder.Decode(&sourceResult) != nil || decoder.Decode(&destinationResult) != nil {{ panic("completion records were not encoded") }}
 if !sourceResult.Modtime.Equal(sourceTime) || !destinationResult.Modtime.Equal(destinationTime) {{ panic("source and destination metadata were conflated") }}
 if sourceResult.IsWinner || !destinationResult.IsWinner || destinationResult.Winner.Side != "dst" {{ panic("destination was not the completed winner") }}
 if sourceResult.Origin != "copy-completed" || destinationResult.Origin != "copy-completed" {{ panic("completion provenance was lost") }}
 if sourceResult.Hash != "source" || destinationResult.Hash != "destination" {{ panic("per-side hashes were conflated") }}
 fmt.Println("patched completion callback preserved independent metadata")
}}
'''
    source = output.with_suffix(".go")
    source.write_text(harness)
    subprocess.run(["go", "build", "-trimpath", "-o", str(output), str(source)], check=True, timeout=35)
    subprocess.run([str(output)], check=True, timeout=5)


def main() -> None:
    root = Path(__file__).resolve().parents[2]
    if shutil.which("go") is None:
        raise RuntimeError("The CI runner must provide Go")
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
        compile_behavior_probe(patched, Path(directory) / "completion-probe")

    print(f"rclone v{VERSION} source identity, patch compatibility, and completion behavior passed")


if __name__ == "__main__":
    main()
