#!/usr/bin/env python3
"""Hot-reload MCP wrapper for graphify.serve.

graphify's MCP server upstream sys.exit(1)s if `graphify-out/graph.json`
doesn't exist at startup. That makes it useless in Codeflare sessions
where a freshly-cloned repo has no graph yet AND there is no clean way
to restart Claude Code without losing session state (killing the session
kills the container).

This wrapper monkey-patches graphify.serve._load_graph to return a
LazyGraph - a subclass of nx.DiGraph that:
  - starts empty (no crash, MCP shows connected with all 7 tools)
  - polls the on-disk graph.json in a background thread
  - hot-swaps its node/edge contents in place when the file appears
    or changes (mtime-keyed)

All graphify tool handlers see what looks like a normal NX graph; they
just transparently get real results once the user runs /graphify.
No notifications/tools/list_changed needed - graphify's tool list is
static, only the tool *results* change.
"""

import sys
import threading
import time
from pathlib import Path

import networkx as nx
import graphify.serve as gs

GRAPH_PATH = sys.argv[1] if len(sys.argv) > 1 else "graphify-out/graph.json"
POLL_SECONDS = 2.0

_original_load = gs._load_graph


class LazyGraph(nx.DiGraph):
    """nx.DiGraph that reloads its contents from a JSON file when its mtime changes.

    Subclass (not proxy) so isinstance(G, nx.Graph) checks in graphify/networkx
    pass cleanly. The watcher thread does an atomic clear+repopulate under
    a lock so concurrent reads see a consistent snapshot.
    """

    def __init__(self, path):
        super().__init__()
        # Use object.__setattr__ so NX's strict attribute machinery
        # doesn't mistake these for graph-level data.
        object.__setattr__(self, "_lazy_path", Path(path).resolve())
        object.__setattr__(self, "_lazy_mtime", -1.0)
        object.__setattr__(self, "_lazy_lock", threading.Lock())
        self._lazy_reload()
        watcher = threading.Thread(target=self._lazy_watch, daemon=True)
        watcher.start()

    def _lazy_reload(self):
        try:
            p = self._lazy_path
            if not p.is_file():
                return
            mt = p.stat().st_mtime
            if mt == self._lazy_mtime:
                return
            new_g = _original_load(str(p))
            with self._lazy_lock:
                self.clear()
                self.add_nodes_from(new_g.nodes(data=True))
                self.add_edges_from(new_g.edges(data=True))
                self.graph.update(new_g.graph)
                object.__setattr__(self, "_lazy_mtime", mt)
        except Exception as exc:
            print(f"[graphify-lazy] reload failed: {exc}", file=sys.stderr)

    def _lazy_watch(self):
        while True:
            time.sleep(POLL_SECONDS)
            self._lazy_reload()


def _lazy_load_graph(graph_path):
    return LazyGraph(graph_path)


gs._load_graph = _lazy_load_graph

if __name__ == "__main__":
    gs.serve(GRAPH_PATH)
