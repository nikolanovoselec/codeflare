#!/usr/bin/env python3
"""Repo-aware MCP wrapper using Graphify's complete query contexts.

One persistent process starts graphless, then selects a complete upstream graph
and matching communities on each context request. Upstream owns validation,
indexes, graph classes, generation freshness and bounded context retention; no
watcher mutates graph internals while handlers read them.

Resolution order remains global merged graph > valid sentinel-selected repo >
freshest workspace graph. A valid sentinel selecting a graphless repo stays
empty rather than falling through to a different repo. Per-branch graphs are
unsupported; explicitly authorized updates are observed on subsequent requests.

Only graph/context selection is adapted. Upstream's nominal path still owns
query headers and resource/report sidecar lookup; those paths are not rebound.
"""

import os
import sys
from pathlib import Path
from typing import Optional, Tuple

import networkx as nx
import graphify.serve as gs

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

_original_context_load = gs._GraphContextCache.load


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


def _load_active_context(self, _resolved_path: str, *, pinned: bool = False):
    # Codeflare owns selection; upstream owns loading and complete contexts.
    _root, path = _resolve_active()
    if path is None:
        return nx.DiGraph(), {}
    # Dynamic defaults share upstream's bounded project-context LRU.
    return _original_context_load(self, str(path.resolve()), pinned=False)


gs._GraphContextCache.load = _load_active_context

if __name__ == "__main__":
    # Path arg is ignored - wrapper resolves dynamically. Kept for
    # back-compat with the entrypoint registration signature.
    arg = sys.argv[1] if len(sys.argv) > 1 else "graphify-out/graph.json"
    gs.serve(arg)
