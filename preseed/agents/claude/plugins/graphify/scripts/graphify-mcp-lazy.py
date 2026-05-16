#!/usr/bin/env python3
"""Hot-reload, repo-aware MCP wrapper for graphify.serve.

Two problems this wrapper solves:

1. graphify.serve sys.exit(1)s if graphify-out/graph.json is missing at
   startup. Codeflare sessions start with an empty workspace; the user
   clones a repo mid-session and there is no way to restart Claude Code
   (killing the session kills the container).

2. A single session typically holds 2-3 cloned repos. The MCP server is
   one persistent process with no native notion of "current repo". When
   the agent switches between repos via Bash `cd`, ctx_execute, git/gh
   clone, or just by editing files in a different directory, the wrapper
   must rebind G to the right repo's graph.

Resolution chain (in priority):
  (a) Global graph at ~/.graphify/global-graph.json — the unified merge
      of the persistent vault plus every globally-added per-repo graph
      (REQ-MEMORY-104). Preferred when present so mcp__graphify__* tools
      always see the unified view across vault + active repos.
  (b) Sentinel file at ~/.cache/codeflare-hooks/graphify-active-cwd
      written by the graphify-active-repo.sh PostToolUse hook (Bash,
      Edit, Write, Read, ctx_execute, ctx_batch_execute). Walks up from
      sentinel cwd to find a parent dir containing graphify-out/ or .git/.
  (c) Fallback: freshest mtime across
      CODEFLARE_WORKSPACE/*/graphify-out/graph.json. Used before the
      first hook fires and when the sentinel points at a repo without a
      graph yet.

Thread safety: graphify's tool handlers read G concurrently with the
watcher thread. To avoid mid-iteration RuntimeError (dictionary changed
size during iteration), rebinds build a fresh nx.DiGraph in full, then
swap the underlying _node/_adj/_pred/_succ/graph dicts as a single
operation under the lock. Readers that captured the old dict references
finish on a stable snapshot; new readers see the new dicts atomically.

Branch awareness: <repo>/.git/HEAD is read on rebind only for an
informative log line. Per-branch graphs are not supported (graphify
upstream models snapshots, not branches). The user runs `graphify
update` after a checkout; the wrapper picks up the new mtime.
"""

import os
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Optional, Tuple

import networkx as nx
import graphify.serve as gs

POLL_SECONDS: float = float(os.environ.get("GRAPHIFY_POLL_SECONDS", "2.0"))
WORKSPACE_ROOT: Path = Path(
    os.environ.get("CODEFLARE_WORKSPACE", "/home/user/workspace")
)
SENTINEL_PATH: Path = Path(
    os.environ.get(
        "GRAPHIFY_SENTINEL",
        str(Path.home() / ".cache" / "codeflare-hooks" / "graphify-active-cwd"),
    )
)
GLOBAL_GRAPH_PATH: Path = Path(
    os.environ.get(
        "GRAPHIFY_GLOBAL_GRAPH",
        str(Path.home() / ".graphify" / "global-graph.json"),
    )
)

_original_load = gs._load_graph


def _read_branch(repo_root: Path) -> Optional[str]:
    try:
        head = repo_root / ".git" / "HEAD"
        if head.is_file():
            line = head.read_text().strip()
            if line.startswith("ref: refs/heads/"):
                return line[len("ref: refs/heads/"):]
            return line[:8]
    except Exception:
        pass
    return None


def _walk_up_for_repo_root(start: Path) -> Optional[Path]:
    cur = start.resolve() if start.exists() else None
    if cur is None:
        return None
    while True:
        if (cur / "graphify-out").is_dir() or (cur / ".git").is_dir():
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent


def _resolve_active() -> Tuple[Optional[Path], Optional[Path]]:
    """Return (repo_root, graph_path). Either may be None.

    Priority: global merged graph > sentinel-pinned repo > freshest workspace
    graph. When the global graph is present it always wins so MCP tool
    handlers see the unified vault+repos view.
    """
    try:
        if GLOBAL_GRAPH_PATH.is_file():
            return None, GLOBAL_GRAPH_PATH
    except Exception as exc:
        print(
            f"[graphify-lazy] global graph check failed: {exc!r}",
            file=sys.stderr,
        )

    try:
        if SENTINEL_PATH.is_file():
            raw = SENTINEL_PATH.read_text().strip()
            if raw:
                candidate = Path(raw)
                if candidate.is_dir():
                    root = _walk_up_for_repo_root(candidate) or candidate
                    gp = root / "graphify-out" / "graph.json"
                    return root, (gp if gp.is_file() else None)
    except Exception as exc:
        print(f"[graphify-lazy] sentinel read failed: {exc!r}", file=sys.stderr)

    if WORKSPACE_ROOT.is_dir():
        try:
            cands = list(WORKSPACE_ROOT.glob("*/graphify-out/graph.json"))
            if cands:
                fresh = max(cands, key=lambda p: p.stat().st_mtime)
                return fresh.parent.parent, fresh
        except Exception:
            pass
    return None, None


class LazyGraph(nx.DiGraph):
    """nx.DiGraph that rebinds to whichever repo is currently active.

    Reads from graphify tool handlers run on the main MCP thread; the
    watcher runs on a daemon thread. To prevent mid-iteration mutation
    crashes, every rebind swaps the underlying dict members atomically
    under self._lock — never mutates them in place while readers might
    be iterating.
    """

    def __init__(self) -> None:
        super().__init__()
        object.__setattr__(self, "_lock", threading.Lock())
        object.__setattr__(self, "_path", None)
        object.__setattr__(self, "_mtime", -1.0)
        object.__setattr__(self, "_root", None)
        object.__setattr__(self, "_branch", None)
        self._tick()
        watcher = threading.Thread(target=self._watch, daemon=True)
        watcher.start()

    def _empty_under_lock(self) -> None:
        """Replace internal dicts with fresh empty ones, atomically."""
        empty = nx.DiGraph()
        with self._lock:
            self._node = empty._node
            self._adj = empty._adj
            self._pred = empty._pred
            self._succ = empty._succ
            self.graph = empty.graph

    def _swap_in_new_graph(self, new_g: nx.DiGraph) -> None:
        """Replace internal dicts with new_g's dicts, atomically."""
        with self._lock:
            self._node = new_g._node
            self._adj = new_g._adj
            self._pred = new_g._pred
            self._succ = new_g._succ
            self.graph = new_g.graph

    def _tick(self) -> None:
        try:
            root, path = _resolve_active()

            if root != self._root:
                object.__setattr__(self, "_root", root)
                object.__setattr__(self, "_path", path)
                object.__setattr__(self, "_mtime", -1.0)
                object.__setattr__(
                    self, "_branch", _read_branch(root) if root else None
                )
                self._empty_under_lock()
                print(
                    f"[graphify-lazy] active repo -> {root} "
                    f"(branch={self._branch}, graph={'yes' if path else 'no'})",
                    file=sys.stderr,
                )

            if not path:
                return

            mt = path.stat().st_mtime
            if mt == self._mtime:
                return

            new_g = _original_load(str(path))
            self._swap_in_new_graph(new_g)
            object.__setattr__(self, "_mtime", mt)
            print(
                f"[graphify-lazy] loaded {len(self._node)} nodes from {path}",
                file=sys.stderr,
            )
        except Exception as exc:
            print(f"[graphify-lazy] tick failed: {exc!r}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    def _watch(self) -> None:
        while True:
            time.sleep(POLL_SECONDS)
            self._tick()


def _lazy_load_graph(_graph_path: str) -> LazyGraph:
    return LazyGraph()


gs._load_graph = _lazy_load_graph

if __name__ == "__main__":
    # Path arg is ignored - wrapper resolves dynamically. Kept for
    # back-compat with the entrypoint registration signature.
    arg = sys.argv[1] if len(sys.argv) > 1 else "graphify-out/graph.json"
    gs.serve(arg)
