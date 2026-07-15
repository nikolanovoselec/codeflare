#!/usr/bin/env python3
"""merge-vault-graph.py - REQ-MEM-009 cumulative vault-graph merge.

Loads the per-extraction chunk JSON, composes it onto the persistent
vault-graph.json (hash-keyed union by node ID, edge tuple), re-clusters,
and writes both vault-graph.json (cumulative, source of truth for next
run) and graph.json (per-extraction artifact consumed by visualization).

Called inside a flock-guarded shell so concurrent vault writers cannot
interleave with the load+merge+persist critical section.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

DEFAULT_CHUNK = "/home/user/Vault/graphify-out/.graphify_chunk_01.json"
DEFAULT_VAULT_GRAPH = "/home/user/Vault/graphify-out/vault-graph.json"
DEFAULT_OUT = "/home/user/Vault/graphify-out/graph.json"


def dedupe_node_link_edges(blob: dict[str, Any]) -> dict[str, Any]:
    """Return node-link JSON with one edge per semantic evidence tuple."""
    unique: dict[tuple[Any, Any, Any, Any], dict[str, Any]] = {}
    for item in blob.get("links", blob.get("edges", [])):
        key = (
            item.get("source"),
            item.get("target"),
            item.get("relation"),
            item.get("source_file"),
        )
        unique.setdefault(key, item)
    edge_key = "links" if "links" in blob or "edges" not in blob else "edges"
    return {**blob, edge_key: list(unique.values())}


def merge_node_link_evidence(
    persisted: dict[str, Any], *evidence_blobs: dict[str, Any]
) -> dict[str, Any]:
    """Restore all prior/new edge evidence after simple graph composition."""
    edge_key = "links" if "links" in persisted or "edges" not in persisted else "edges"
    edges = list(persisted.get("links", persisted.get("edges", [])))
    for blob in evidence_blobs:
        edges.extend(blob.get("links", blob.get("edges", [])))
    return dedupe_node_link_edges({**persisted, edge_key: edges})


def dedupe_node_link_file(
    path: Path, *evidence_blobs: dict[str, Any]
) -> dict[str, Any]:
    persisted = json.loads(path.read_text(encoding="utf-8"))
    normalized = merge_node_link_evidence(persisted, *evidence_blobs)
    work_path = path.with_name(f".{path.name}.dedupe")
    work_path.write_text(
        json.dumps(normalized, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    os.replace(work_path, path)
    return normalized


def main() -> None:
    import networkx as nx
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json

    chunk_path = Path(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CHUNK)
    vault_graph_path = Path(
        sys.argv[2] if len(sys.argv) > 2 else DEFAULT_VAULT_GRAPH
    )
    out_path = Path(sys.argv[3] if len(sys.argv) > 3 else DEFAULT_OUT)

    graph_prior = nx.DiGraph()
    prior_blob: dict[str, Any] = {"nodes": [], "links": []}
    try:
        if vault_graph_path.exists():
            prior_blob = json.loads(vault_graph_path.read_text(encoding="utf-8"))
            try:
                graph_prior = nx.node_link_graph(prior_blob, edges="links")
            except (KeyError, TypeError):
                graph_prior = nx.node_link_graph(prior_blob)
    except (json.JSONDecodeError, KeyError, TypeError, OSError) as error:
        print(f"vault-graph.json unreadable ({error}); starting fresh")
        graph_prior = nx.DiGraph()

    extraction = json.loads(chunk_path.read_text(encoding="utf-8"))
    graph_new = build_from_json(extraction)

    if not graph_prior.is_directed():
        graph_prior = graph_prior.to_directed()
    if not graph_new.is_directed():
        graph_new = graph_new.to_directed()

    graph_merged = nx.compose(graph_prior, graph_new)
    communities = cluster(graph_merged) if graph_merged.number_of_nodes() else {}
    to_json(graph_merged, communities, str(vault_graph_path))
    persisted = dedupe_node_link_file(vault_graph_path, prior_blob, extraction)

    if out_path != vault_graph_path:
        out_work = out_path.with_name(f".{out_path.name}.merge")
        shutil.copyfile(vault_graph_path, out_work)
        os.replace(out_work, out_path)

    print(
        f"vault graph: {len(persisted.get('nodes', []))} nodes "
        f"({graph_new.number_of_nodes()} new, {graph_prior.number_of_nodes()} prior), "
        f"{len(persisted.get('links', persisted.get('edges', [])))} edges"
    )


if __name__ == "__main__":
    main()
