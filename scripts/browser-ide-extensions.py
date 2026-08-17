#!/usr/bin/env python3
"""Capture bounded Browser IDE extension intent without persisting extension bytes."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import signal
import stat
import tempfile
from pathlib import Path
from typing import Any


class UnsafeInput(ValueError):
    """An external file cannot safely participate in capture."""


def _read_json_file(path: Path, max_bytes: int, *, require_regular: bool = True) -> Any:
    info = path.lstat()
    if require_regular and (stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1):
        raise UnsafeInput(f"unsafe file type: {path}")
    if info.st_size > max_bytes:
        raise UnsafeInput(f"file exceeds bound: {path}")
    try:
        payload = path.read_bytes()
        if len(payload) > max_bytes:
            raise UnsafeInput(f"file grew beyond bound: {path}")
        return json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UnsafeInput(f"invalid JSON: {path}") from exc


def _is_plain_setting(value: Any, *, depth: int, max_depth: int) -> bool:
    if value is None or isinstance(value, (bool, int, float, str)):
        return not isinstance(value, float) or (value == value and value not in (float("inf"), float("-inf")))
    if isinstance(value, list) or not isinstance(value, dict) or depth >= max_depth:
        return False
    return all(
        isinstance(key, str)
        and 0 < len(key) <= 256
        and _is_plain_setting(child, depth=depth + 1, max_depth=max_depth)
        for key, child in value.items()
    )


def _validate_manifest(value: Any, policy: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise UnsafeInput("manifest must be an object")
    allowed_top = {"version", "securityWarningShown", "extensions", "settings"}
    if set(value) - allowed_top or value.get("version") != 1:
        raise UnsafeInput("unsupported manifest shape")
    if set(value) < {"version", "extensions", "settings"}:
        raise UnsafeInput("manifest fields missing")
    if "securityWarningShown" in value and not isinstance(value["securityWarningShown"], bool):
        raise UnsafeInput("invalid warning acknowledgement")

    extensions = value["extensions"]
    settings = value["settings"]
    if not isinstance(extensions, dict) or len(extensions) > policy["extensionMaxCount"]:
        raise UnsafeInput("invalid extensions map")
    if not isinstance(settings, dict):
        raise UnsafeInput("invalid settings map")
    if len(json.dumps(settings, ensure_ascii=False, separators=(",", ":")).encode()) > policy["settingsMaxBytes"]:
        raise UnsafeInput("settings exceed bound")

    extension_id = re.compile(policy["extensionIdPattern"])
    extension_version = re.compile(policy["extensionVersionPattern"])
    target_platform = re.compile(policy["targetPlatformPattern"])
    installed_at = re.compile(policy["installedAtPattern"])
    sha256 = re.compile(policy["sha256Pattern"])
    fixed_ids = set(policy["fixedExtensionIds"])
    for extension, record in extensions.items():
        if not isinstance(extension, str) or not extension_id.fullmatch(extension) or extension in fixed_ids:
            raise UnsafeInput("invalid extension identity")
        if not isinstance(record, dict) or set(record) - {"version", "targetPlatform", "installedAt", "sha256"}:
            raise UnsafeInput("invalid extension record")
        version = record.get("version")
        if not isinstance(version, str) or len(version) > policy["extensionVersionMaxLength"] or not extension_version.fullmatch(version):
            raise UnsafeInput("invalid extension version")
        platform = record.get("targetPlatform")
        if platform is not None and (not isinstance(platform, str) or not target_platform.fullmatch(platform)):
            raise UnsafeInput("invalid target platform")
        timestamp = record.get("installedAt")
        if timestamp is not None and (not isinstance(timestamp, str) or not installed_at.fullmatch(timestamp)):
            raise UnsafeInput("invalid installed timestamp")
        digest = record.get("sha256")
        if digest is not None and (not isinstance(digest, str) or not sha256.fullmatch(digest)):
            raise UnsafeInput("invalid extension digest")

    for key, setting in settings.items():
        if not isinstance(key, str) or not key or len(key) > 256:
            raise UnsafeInput("invalid setting key")
        encoded = json.dumps(setting, ensure_ascii=False, separators=(",", ":")).encode()
        if len(encoded) > policy["settingValueMaxBytes"] or not _is_plain_setting(
            setting,
            depth=0,
            max_depth=policy["settingObjectMaxDepth"],
        ):
            raise UnsafeInput("invalid setting value")
    return value


def _read_registry(extensions_dir: Path, policy: dict[str, Any]) -> dict[str, dict[str, Any]]:
    path = extensions_dir / "extensions.json"
    if not path.exists():
        return {}
    value = _read_json_file(path, policy["manifestMaxBytes"] * 16)
    if not isinstance(value, list):
        raise UnsafeInput("extension registry must be an array")
    extension_id = re.compile(policy["extensionIdPattern"])
    extension_version = re.compile(policy["extensionVersionPattern"])
    target_platform = re.compile(policy["targetPlatformPattern"])
    fixed_ids = set(policy["fixedExtensionIds"])
    present: dict[str, dict[str, Any]] = {}
    for entry in value:
        if not isinstance(entry, dict):
            raise UnsafeInput("invalid registry entry")
        identifier = entry.get("identifier")
        raw_id = identifier.get("id") if isinstance(identifier, dict) else None
        version = entry.get("version")
        if not isinstance(raw_id, str) or not isinstance(version, str):
            raise UnsafeInput("invalid registry identity")
        normalized_id = raw_id.lower()
        if not extension_id.fullmatch(normalized_id) or len(version) > policy["extensionVersionMaxLength"] or not extension_version.fullmatch(version):
            raise UnsafeInput("invalid registry identity")
        if normalized_id in fixed_ids:
            continue
        record: dict[str, Any] = {"version": version}
        metadata = entry.get("metadata")
        if isinstance(metadata, dict):
            platform = metadata.get("targetPlatform")
            if isinstance(platform, str) and target_platform.fullmatch(platform):
                record["targetPlatform"] = platform
            timestamp = metadata.get("installedTimestamp")
            if isinstance(timestamp, (int, float)) and timestamp >= 0:
                try:
                    observed = dt.datetime.fromtimestamp(timestamp / 1000, tz=dt.timezone.utc)
                    record["installedAt"] = observed.isoformat(timespec="milliseconds").replace("+00:00", "Z")
                except (OverflowError, OSError, ValueError):
                    pass
        present[normalized_id] = record
    if len(present) > policy["extensionMaxCount"]:
        raise UnsafeInput("registry exceeds extension bound")
    return present


def _read_obsolete(extensions_dir: Path, policy: dict[str, Any]) -> set[str]:
    path = extensions_dir / ".obsolete"
    if not path.exists():
        return set()
    try:
        value = _read_json_file(path, policy["manifestMaxBytes"])
    except UnsafeInput:
        return set()
    if not isinstance(value, dict):
        return set()
    return {key.lower() for key, obsolete in value.items() if isinstance(key, str) and obsolete is True}


def _obsolete_proves_uninstall(extension: str, record: dict[str, Any], obsolete: set[str]) -> bool:
    stem = f"{extension}-{record['version']}"
    candidates = {stem}
    platform = record.get("targetPlatform")
    if isinstance(platform, str):
        candidates.add(f"{stem}-{platform}")
    return bool(candidates & obsolete)


def _parent_chain_is_safe(path: Path) -> bool:
    current = path.parent
    while True:
        if current.exists() and current.is_symlink():
            return False
        if current == current.parent:
            return True
        current = current.parent


def _atomic_write(path: Path, payload: bytes) -> None:
    if not _parent_chain_is_safe(path):
        raise UnsafeInput("manifest parent redirects through a symlink")
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def capture(extensions_dir: Path, manifest_path: Path, policy_path: Path) -> bool:
    try:
        policy = _read_json_file(policy_path, 64 * 1024)
        if not isinstance(policy, dict) or policy.get("version") != 1:
            raise UnsafeInput("unsupported policy")
        manifest_exists = manifest_path.exists() or manifest_path.is_symlink()
        if manifest_exists:
            current = _validate_manifest(
                _read_json_file(manifest_path, policy["manifestMaxBytes"]),
                policy,
            )
        else:
            if not _parent_chain_is_safe(manifest_path):
                raise UnsafeInput("manifest parent redirects through a symlink")
            current = {"version": 1, "extensions": {}, "settings": {}}
        obsolete = _read_obsolete(extensions_dir, policy)
        present = {
            extension: record
            for extension, record in _read_registry(extensions_dir, policy).items()
            if not _obsolete_proves_uninstall(extension, record, obsolete)
        }

        next_extensions: dict[str, dict[str, Any]] = {}
        warning_acknowledged = current.get("securityWarningShown") is True
        for extension, record in current["extensions"].items():
            if extension in present and warning_acknowledged:
                continue
            if not _obsolete_proves_uninstall(extension, record, obsolete):
                next_extensions[extension] = record
        if warning_acknowledged:
            for extension, record in present.items():
                previous = current["extensions"].get(extension)
                if isinstance(previous, dict) and isinstance(previous.get("sha256"), str):
                    record = {**record, "sha256": previous["sha256"]}
                next_extensions[extension] = record
        if len(next_extensions) > policy["extensionMaxCount"]:
            raise UnsafeInput("capture exceeds extension bound")

        next_manifest: dict[str, Any] = {
            "version": 1,
            "extensions": dict(sorted(next_extensions.items())),
            "settings": current["settings"],
        }
        if "securityWarningShown" in current:
            next_manifest["securityWarningShown"] = current["securityWarningShown"]
        _validate_manifest(next_manifest, policy)
        payload = (json.dumps(next_manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
        if len(payload) > policy["manifestMaxBytes"]:
            raise UnsafeInput("captured manifest exceeds bound")
        if manifest_exists and next_manifest == current:
            return False
        _atomic_write(manifest_path, payload)
        return True
    except (KeyError, OSError, TypeError, UnsafeInput, ValueError):
        return False


def _signal_sync(pid_path: Path | None) -> None:
    if pid_path is None:
        return
    try:
        info = pid_path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_size > 32:
            return
        text = pid_path.read_text(encoding="ascii").strip()
        if not re.fullmatch(r"[1-9][0-9]{0,9}", text):
            return
        os.kill(int(text), signal.SIGUSR1)
    except (OSError, UnicodeError, ValueError):
        pass


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="operation", required=True)
    capture_parser = subparsers.add_parser("capture")
    capture_parser.add_argument("--extensions-dir", type=Path, required=True)
    capture_parser.add_argument("--manifest", type=Path, required=True)
    capture_parser.add_argument("--policy", type=Path, required=True)
    capture_parser.add_argument("--sync-pid-file", type=Path)
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    if args.operation == "capture":
        if capture(args.extensions_dir, args.manifest, args.policy):
            _signal_sync(args.sync_pid_file)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
