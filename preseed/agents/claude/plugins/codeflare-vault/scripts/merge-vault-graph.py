#!/usr/bin/env python3
"""merge-vault-graph.py - REQ-MEM-009 cumulative vault-graph merge.

Loads the per-extraction chunk JSON, composes it onto the persistent
vault-graph.json (hash-keyed union by node ID, edge tuple), re-clusters,
and writes both vault-graph.json (cumulative, source of truth for next
run) and graph.json (per-extraction artifact consumed by step 6's
cluster-only viz re-render).

Called from vault-extract-prompt.md Step 4 inside a flock-guarded
subshell so concurrent capture-pipeline or active-repo writers cannot
interleave with the load+merge+persist critical section.

Paths default to the Codeflare vault layout but may be overridden via
positional arguments (chunk_path vault_graph_path out_path) so tests
can drive the script against synthetic fixtures.

Requires graphify + networkx (installed in the codeflare container at
/root/.local/share/uv/tools/graphifyy). Exits non-zero on any failure;
the caller propagates that to EXTRACT_FAILED so the high-water mark
is left old and the next 60s daemon tick retries.
"""

import json
import sys
from pathlib import Path

import networkx as nx
from graphify.build import build_from_json
from graphify.cluster import cluster
from graphify.export import to_json

DEFAULT_CHUNK = '/home/user/Vault/graphify-out/.graphify_chunk_01.json'
DEFAULT_VAULT_GRAPH = '/home/user/Vault/graphify-out/vault-graph.json'
DEFAULT_OUT = '/home/user/Vault/graphify-out/graph.json'

chunk_path = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CHUNK)
vault_graph_path = Path(sys.argv[2] if len(sys.argv) > 2 else DEFAULT_VAULT_GRAPH)
out_path = Path(sys.argv[3] if len(sys.argv) > 3 else DEFAULT_OUT)

# REQ-MEM-009 AC4: missing/unreadable persistent vault-graph.json is
# recoverable - start fresh. Any JSON parse error or KeyError on the
# expected node_link shape means the file is corrupt; treat as missing.
G_prior = nx.DiGraph()
try:
    if vault_graph_path.exists():
        prior_blob = json.loads(vault_graph_path.read_text(encoding='utf-8'))
        # node_link_graph default in nx 3.x reads 'edges'; vault-graph.json
        # historically wrote 'links'. Try both so older files still load.
        try:
            G_prior = nx.node_link_graph(prior_blob, edges='links')
        except (KeyError, TypeError):
            G_prior = nx.node_link_graph(prior_blob)
except (json.JSONDecodeError, KeyError, TypeError, OSError) as e:
    print(f'vault-graph.json unreadable ({e}); starting fresh')
    G_prior = nx.DiGraph()

extraction = json.loads(chunk_path.read_text(encoding='utf-8'))
G_new = build_from_json(extraction)

# REQ-MEM-009 AC2: hash-keyed union - nx.compose dedupes nodes by ID
# (existing IDs keep their attributes; new IDs append). Edges are
# unioned by (source, target) tuple.
G_merged = nx.compose(G_prior, G_new)

# REQ-MEM-009 AC1: persist the cumulative vault graph for the next
# extraction to load.
to_json(G_merged, cluster(G_merged) if G_merged.number_of_nodes() else {}, str(vault_graph_path))

# Also write the per-extraction graph.json (kept for backwards-compat
# with any caller that still reads the chunk-shaped artifact).
to_json(G_merged, cluster(G_merged) if G_merged.number_of_nodes() else {}, str(out_path))

print(
    f'vault graph: {G_merged.number_of_nodes()} nodes '
    f'({G_new.number_of_nodes()} new, {G_prior.number_of_nodes()} prior), '
    f'{G_merged.number_of_edges()} edges'
)
