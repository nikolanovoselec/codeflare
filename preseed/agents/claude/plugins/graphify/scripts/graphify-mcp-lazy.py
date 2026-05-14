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
  (a) Sentinel file at ~/.cache/codeflare-hooks/graphify-active-cwd written
      by the graphify-active-repo.sh PostToolUse hook (covers Bash, Edit,
      Write, Read, ctx_execute, ctx_batch_execute). Walks up from sentinel
      cwd to find a parent dir containing graphify-out/ or .git/.
  (b) Fallback: freshest mtime across CODEFLARE_WORKSPACE/*/graphify-out/graph.json.
      Used before the first hook fires and when the sentinel points at a
      repo without a graph yet.

LazyGraph subclasses nx.DiGraph so isinstance checks in graphify and
networkx pass. The watcher thread atomically clears and repopulates G
under a lock on every 2-second tick. graphify's tool list is static
(always 7 tools), so no notifications/tools/list_changed is needed -
only G's contents swap.

Branch awareness: <repo>/.git/HEAD is read on rebind for an informative
log line. Per-branch graphs are not supported - graphify upstream models
snapshots, not branches. The user runs `graphify update` after a
checkout and the wrapper picks up the new mtime.
"""

import os
import sys
import threading
import time
from pathlib import Path

import networkx as nx
import graphify.serve as gs

POLL_SECONDS = 2.0
WORKSPACE_ROOT = Path(os.environ.get("CODEFLARE_WORKSPACE", "/home/user/workspace"))
SENTINEL_PATH = Path(
    os.environ.get(
        "GRAPHIFY_SENTINEL",
        str(Path.home() / ".cache" / "codeflare-hooks" / "graphify-active-cwd"),
    )
)

_original_load = gs._load_graph


def _read_branch(repo_root):
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


def _walk_up_for_repo_root(start):
    cur = start.resolve() if start.exists() else None
    if cur is None:
        return None
    while True:
        if (cur / "graphify-out").is_dir() or (cur / ".git").is_dir():
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent


def _resolve_active():
    """Return (repo_root, graph_path). Either may be None."""
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
        print(f"[graphify-lazy] sentinel read failed: {exc}", file=sys.stderr)

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
    """nx.DiGraph that rebinds to whichever repo is currently active."""

    def __init__(self):
        super().__init__()
        object.__setattr__(self, "_lock", threading.Lock())
        object.__setattr__(self, "_path", None)
        object.__setattr__(self, "_mtime", -1.0)
        object.__setattr__(self, "_root", None)
        object.__setattr__(self, "_branch", None)
        self._tick()
        watcher = threading.Thread(target=self._watch, daemon=True)
        watcher.start()

    def _tick(self):
        try:
            root, path = _resolve_active()

            if root != self._root:
                with self._lock:
                    self.clear()
                    object.__setattr__(self, "_root", root)
                    object.__setattr__(self, "_path", path)
                    object.__setattr__(self, "_mtime", -1.0)
                    object.__setattr__(
                        self, "_branch", _read_branch(root) if root else None
                    )
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
            with self._lock:
                self.clear()
                self.add_nodes_from(new_g.nodes(data=True))
                self.add_edges_from(new_g.edges(data=True))
                self.graph.update(new_g.graph)
                object.__setattr__(self, "_mtime", mt)
            print(
                f"[graphify-lazy] loaded {len(self.nodes())} nodes from {path}",
                file=sys.stderr,
            )
        except Exception as exc:
            print(f"[graphify-lazy] tick failed: {exc}", file=sys.stderr)

    def _watch(self):
        while True:
            time.sleep(POLL_SECONDS)
            self._tick()


def _lazy_load_graph(_graph_path):
    return LazyGraph()


gs._load_graph = _lazy_load_graph

if __name__ == "__main__":
    # Path arg is ignored - wrapper resolves dynamically. Kept for back-
    # compat with the entrypoint registration signature.
    arg = sys.argv[1] if len(sys.argv) > 1 else "graphify-out/graph.json"
    gs.serve(arg)
