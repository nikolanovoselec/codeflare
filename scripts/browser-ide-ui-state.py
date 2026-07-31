#!/usr/bin/env python3
"""Capture/restore a bounded, credential-free subset of code-server UI state."""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sqlite3
import stat
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse

MAX_SNAPSHOT_BYTES = 1024 * 1024
MAX_VALUE_BYTES = 256 * 1024
WORKSPACE_STATE_KEYS = frozenset({
    "memento/workbench.parts.editor",
    "editors.mru",
    "workbench.explorer.treeViewState",
})
THEME_SETTING_KEYS = frozenset({
    "workbench.colorTheme",
    "workbench.iconTheme",
    "workbench.productIconTheme",
    "workbench.preferredDarkColorTheme",
    "workbench.preferredLightColorTheme",
    "window.autoDetectColorScheme",
})


def canonical_root(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or "\0" in value:
        raise ValueError(f"{label} must be absolute")
    resolved = path.resolve(strict=True)
    if resolved == Path("/") or not resolved.is_dir():
        raise ValueError(f"{label} must be a non-root directory")
    return resolved


def workspace_uri(workspace: Path) -> str:
    return workspace.as_uri()


def js_workspace_hash(value: str) -> str:
    result = 149417
    for character in value:
        result = ((result * 31) + ord(character)) & 0xFFFFFFFF
    signed = result if result < 0x80000000 else result - 0x100000000
    return format(signed, "x") if signed >= 0 else f"-{format(-signed, 'x')}"


# The browser workbench keys single-folder storage off the folderUri it was
# booted with, which the trusted host projects as vscode-remote://<authority>,
# not the container-local file:// form - and the authority is not knowable
# here. Identity is therefore matched by decoded path and replayed verbatim
# from capture, never derived from an assumed URI shape.
WORKSPACE_STORAGE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


def uri_targets_workspace(value: object, workspace: Path) -> bool:
    if not isinstance(value, str) or "\0" in value or "\\" in value:
        return False
    split = urlparse(value)
    if split.query or split.fragment or split.params:
        return False
    if split.scheme == "file":
        if split.netloc:
            return False
    elif split.scheme == "vscode-remote":
        if not split.netloc:
            return False
    else:
        return False
    return unquote(split.path) == str(workspace)


def safe_workspace_path(value: str, workspace: Path) -> bool:
    candidate = Path(value)
    if not candidate.is_absolute() or "\0" in value:
        return False
    normalized = Path(os.path.normpath(candidate))
    try:
        if os.path.commonpath((str(workspace), str(normalized))) != str(workspace):
            return False
        if normalized.exists() or normalized.is_symlink():
            canonical = normalized.resolve(strict=True)
        else:
            canonical = normalized.parent.resolve(strict=True) / normalized.name
        return os.path.commonpath((str(workspace), str(canonical))) == str(workspace)
    except (OSError, ValueError):
        return False


def safe_file_uri(value: str, workspace: Path) -> bool:
    parsed = urlparse(value)
    if (parsed.scheme != "file" or parsed.netloc not in ("", "localhost")
            or parsed.query or parsed.fragment):
        return False
    return safe_workspace_path(unquote(parsed.path), workspace)


def safe_resource(value: object, workspace: Path) -> bool:
    if isinstance(value, str):
        return safe_file_uri(value, workspace)
    if not isinstance(value, dict) or set(value) - {"scheme", "path", "authority", "query", "fragment"}:
        return False
    if value.get("scheme") != "file" or not isinstance(value.get("path"), str):
        return False
    if value.get("authority", "") not in ("", "localhost"):
        return False
    if value.get("query", "") != "" or value.get("fragment", "") != "":
        return False
    return safe_workspace_path(value["path"], workspace)


def state_matches_schema(key: str, value: object, workspace: Path) -> bool:
    if key == "memento/workbench.parts.editor":
        if not isinstance(value, dict) or set(value) != {"editorpart.state"}:
            return False
        state = value["editorpart.state"]
        return (isinstance(state, dict)
                and set(state) == {"resource"}
                and safe_resource(state["resource"], workspace))
    if key == "editors.mru":
        return (isinstance(value, list)
                and all(isinstance(item, dict)
                        and set(item) == {"resource"}
                        and safe_resource(item["resource"], workspace)
                        for item in value))
    if key == "workbench.explorer.treeViewState":
        return (isinstance(value, dict)
                and set(value) == {"expanded"}
                and isinstance(value["expanded"], list)
                and all(safe_resource(item, workspace) for item in value["expanded"]))
    return False


def safe_state_value(key: str, raw: object, workspace: Path) -> str | None:
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf8")
        except UnicodeDecodeError:
            return None
    if not isinstance(raw, str) or len(raw.encode("utf8")) > MAX_VALUE_BYTES:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return raw if state_matches_schema(key, parsed, workspace) else None


def read_theme_settings(settings_path: Path) -> dict[str, object]:
    try:
        info = settings_path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > MAX_VALUE_BYTES:
            return {}
        parsed = json.loads(settings_path.read_text(encoding="utf8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    result: dict[str, object] = {}
    for key in THEME_SETTING_KEYS:
        value = parsed.get(key)
        if isinstance(value, bool) or (isinstance(value, str) and len(value.encode("utf8")) <= 256):
            result[key] = value
    return result


def locate_workspace_database(data_root: Path, workspace: Path) -> tuple[Path, dict[str, str]] | None:
    storage_root = data_root / "data" / "User" / "workspaceStorage"
    try:
        candidates = list(storage_root.iterdir())
    except OSError:
        return None
    for candidate in candidates:
        try:
            if candidate.is_symlink() or not candidate.is_dir():
                continue
            if not WORKSPACE_STORAGE_ID.fullmatch(candidate.name):
                continue
            marker = candidate / "workspace.json"
            info = marker.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > 64 * 1024:
                continue
            metadata = json.loads(marker.read_text(encoding="utf8"))
            folder = metadata.get("folder")
            if not uri_targets_workspace(folder, workspace):
                continue
            database = candidate / "state.vscdb"
            db_info = database.lstat()
            if stat.S_ISREG(db_info.st_mode) and not stat.S_ISLNK(db_info.st_mode):
                return database, {"id": candidate.name, "folder": folder}
        except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError, AttributeError):
            continue
    return None


def read_workspace_state(database: Path | None, workspace: Path) -> dict[str, str]:
    if database is None:
        return {}
    result: dict[str, str] = {}
    try:
        connection = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            connection.execute("PRAGMA query_only=ON")
            placeholders = ",".join("?" for _ in WORKSPACE_STATE_KEYS)
            rows = connection.execute(
                f"SELECT key,value FROM ItemTable WHERE key IN ({placeholders})",
                tuple(WORKSPACE_STATE_KEYS),
            )
            for key, raw in rows:
                safe = safe_state_value(key, raw, workspace)
                if key in WORKSPACE_STATE_KEYS and safe is not None:
                    result[key] = safe
        finally:
            connection.close()
    except (OSError, sqlite3.Error):
        return {}
    return result


def secure_parent(path: Path) -> Path:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = path.parent.resolve(strict=True)
    if parent != path.parent:
        raise ValueError("snapshot parent must not be redirected")
    return parent


def atomic_json_write(path: Path, value: object) -> None:
    parent = secure_parent(path)
    encoded = (json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n").encode("utf8")
    if len(encoded) > MAX_SNAPSHOT_BYTES:
        raise ValueError("snapshot exceeds size limit")
    temporary = parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(8)}"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=True) as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600, follow_symlinks=False)
        directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def capture(data_root: Path, snapshot: Path, workspace: Path) -> None:
    located = locate_workspace_database(data_root, workspace)
    settings = read_theme_settings(data_root / "data" / "User" / "settings.json")
    state = read_workspace_state(located[0] if located else None, workspace)
    if located is None and not settings and not state:
        return
    payload: dict[str, object] = {
        "version": 1,
        "workspace": workspace_uri(workspace),
        "settings": settings,
        "workspaceState": state,
    }
    if located is not None:
        payload["workspaceIdentity"] = located[1]
    atomic_json_write(snapshot, payload)


def load_snapshot(path: Path, workspace: Path) -> dict[str, object] | None:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > MAX_SNAPSHOT_BYTES:
            return None
        parsed = json.loads(path.read_text(encoding="utf8"))
    except (FileNotFoundError, OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(parsed, dict) or set(parsed) - {"workspaceIdentity"} != {"version", "workspace", "settings", "workspaceState"}:
        return None
    if parsed.get("version") != 1 or parsed.get("workspace") != workspace_uri(workspace):
        return None
    identity = parsed.get("workspaceIdentity")
    safe_identity: dict[str, str] | None = None
    if identity is not None:
        if not isinstance(identity, dict) or set(identity) != {"id", "folder"}:
            return None
        storage_id = identity.get("id")
        folder = identity.get("folder")
        if not isinstance(storage_id, str) or not WORKSPACE_STORAGE_ID.fullmatch(storage_id):
            return None
        if not uri_targets_workspace(folder, workspace):
            return None
        safe_identity = {"id": storage_id, "folder": folder}
    settings = parsed.get("settings")
    state_values = parsed.get("workspaceState")
    if not isinstance(settings, dict) or not isinstance(state_values, dict):
        return None
    safe_settings: dict[str, object] = {}
    for key, value in settings.items():
        if key not in THEME_SETTING_KEYS:
            return None
        if isinstance(value, bool) or (isinstance(value, str) and len(value.encode("utf8")) <= 256):
            safe_settings[key] = value
        else:
            return None
    safe_state: dict[str, str] = {}
    for key, raw in state_values.items():
        if key not in WORKSPACE_STATE_KEYS:
            return None
        safe = safe_state_value(key, raw, workspace)
        if safe is None:
            return None
        safe_state[key] = safe
    return {"settings": safe_settings, "workspaceState": safe_state, "workspaceIdentity": safe_identity}


def ensure_data_user_root(data_root: Path) -> Path:
    user_root = data_root / "data" / "User"
    user_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if user_root.resolve(strict=True) != user_root:
        raise ValueError("code-server data root must not be redirected")
    return user_root


def restore(data_root: Path, snapshot: Path, workspace: Path) -> None:
    captured = load_snapshot(snapshot, workspace)
    if captured is None:
        return
    user_root = ensure_data_user_root(data_root)
    settings_path = user_root / "settings.json"
    existing: dict[str, object] = {}
    try:
        info = settings_path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_size > MAX_VALUE_BYTES:
            return
        parsed = json.loads(settings_path.read_text(encoding="utf8"))
        if not isinstance(parsed, dict):
            return
        existing = parsed
    except FileNotFoundError:
        pass
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return
    atomic_json_write(settings_path, {**existing, **captured["settings"]})

    identity = captured["workspaceIdentity"]
    if not isinstance(identity, dict):
        identity = {"id": js_workspace_hash(workspace_uri(workspace)), "folder": workspace_uri(workspace)}
    storage = user_root / "workspaceStorage" / identity["id"]
    storage.mkdir(mode=0o700, parents=True, exist_ok=True)
    if storage.resolve(strict=True) != storage:
        raise ValueError("workspace storage must not be redirected")
    atomic_json_write(storage / "workspace.json", {"folder": identity["folder"]})
    database = storage / "state.vscdb"
    try:
        database_info = database.lstat()
        if not stat.S_ISREG(database_info.st_mode) or stat.S_ISLNK(database_info.st_mode):
            raise ValueError("workspace state database must be a real file")
    except FileNotFoundError:
        pass
    connection = sqlite3.connect(database)
    try:
        connection.execute("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
        connection.executemany(
            "INSERT OR REPLACE INTO ItemTable(key,value) VALUES (?,?)",
            captured["workspaceState"].items(),
        )
        connection.commit()
    finally:
        connection.close()
    os.chmod(database, 0o600, follow_symlinks=False)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("capture", "restore"))
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--workspace", required=True)
    args = parser.parse_args()
    try:
        workspace = canonical_root(args.workspace, "workspace")
        data_root = Path(args.data_root)
        snapshot = Path(args.snapshot)
        if not data_root.is_absolute() or not snapshot.is_absolute():
            raise ValueError("data root and snapshot must be absolute")
        if args.operation == "capture":
            capture(data_root, snapshot, workspace)
        else:
            restore(data_root, snapshot, workspace)
        return 0
    except (OSError, ValueError, sqlite3.Error) as error:
        print(f"browser IDE UI state {args.operation} skipped: {error}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
