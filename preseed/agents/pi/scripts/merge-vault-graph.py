#!/usr/bin/env python3
"""merge-vault-graph.py - REQ-MEM-009 cumulative vault-graph merge.

Normal runs compose a new extraction onto the persistent graph and
re-cluster it. ``--relocate`` instead transforms provenance in the existing
cumulative graph without reading the extraction or rebuilding the graph.

Called inside a flock-guarded shell so concurrent vault writers cannot
interleave with the load+merge+persist critical section.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

DEFAULT_CHUNK = "/home/user/Vault/graphify-out/.graphify_chunk_01.json"
DEFAULT_VAULT_GRAPH = "/home/user/Vault/graphify-out/vault-graph.json"
DEFAULT_OUT = "/home/user/Vault/graphify-out/graph.json"
CAPTURE_NAME = re.compile(
    r"^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3])-[0-5]\d-[0-5]\d"
    r"(?:\.\d{3}Z|Z|[+-]\d{4})?-[A-Za-z0-9][A-Za-z0-9_-]*\.md$"
)


class RelocationError(ValueError):
    """A requested provenance relocation could not be completed safely."""


def relocation_map(data: dict[str, Any]) -> dict[str, tuple[str, str]]:
    """Validate compactor destinations against the current Archive.md bytes."""
    if not isinstance(data, dict):
        raise RelocationError("relocation_input_invalid: expected an object")
    archive_file = data.get("archive_file")
    sources = data.get("sources")
    if not isinstance(archive_file, str) or Path(archive_file).name != "Archive.md":
        raise RelocationError(
            "relocation_input_invalid: archive_file must resolve to Archive.md"
        )
    if not isinstance(sources, list) or not sources:
        raise RelocationError(
            "relocation_input_invalid: sources must be a non-empty list"
        )

    mappings: dict[str, tuple[str, str]] = {}
    locations: set[str] = set()
    markers: list[tuple[str, bytes]] = []
    for item in sources:
        if not isinstance(item, dict):
            raise RelocationError(
                "relocation_input_invalid: each source must be an object"
            )
        source_file = item.get("source_file")
        source_location = item.get("source_location")
        archive_marker = item.get("archive_marker")
        if not isinstance(source_file, str) or not source_file:
            raise RelocationError(
                "relocation_input_invalid: source_file must be a non-empty string"
            )
        if source_file == archive_file:
            raise RelocationError(
                "relocation_input_invalid: source_file cannot be Archive.md"
            )
        filename = Path(source_file).name
        expected_location = f"archive:{filename}"
        expected_marker = f"<!-- capture-begin:{expected_location} -->"
        if not CAPTURE_NAME.fullmatch(filename):
            raise RelocationError(
                f"relocation_input_invalid: invalid capture filename:{filename}"
            )
        if source_location != expected_location:
            raise RelocationError(
                f"relocation_input_invalid: invalid source_location:{source_file}"
            )
        if archive_marker != expected_marker:
            raise RelocationError(
                f"relocation_input_invalid: invalid archive_marker:{source_file}"
            )
        if source_file in mappings:
            raise RelocationError(
                f"relocation_input_invalid: duplicate source_file:{source_file}"
            )
        if source_location in locations:
            raise RelocationError(
                f"relocation_input_invalid: duplicate source_location:{source_location}"
            )
        mappings[source_file] = (archive_file, source_location)
        locations.add(source_location)
        markers.append((source_file, f"{expected_marker}\n".encode("ascii")))

    try:
        archive_bytes = Path(archive_file).read_bytes()
    except OSError as error:
        raise RelocationError(
            f"relocation_input_invalid: archive unreadable:{archive_file}:{error}"
        ) from error
    for source_file, marker in markers:
        if marker not in archive_bytes:
            raise RelocationError(
                f"relocation_input_invalid: archive_marker not found:{source_file}"
            )
    return mappings


def load_relocation(path: Path) -> dict[str, Any]:
    """Load and validate an explicit relocation request."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise RelocationError(f"relocation_input_invalid: {error}") from error
    relocation_map(data)
    return data


def load_relocation_graph(path: Path) -> dict[str, Any]:
    """Relocation requires an existing, structurally valid cumulative graph."""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as error:
        raise RelocationError(
            f"relocation_failed: vault_graph_unreadable:{path}:{error}"
        ) from error
    edge_key = "links" if isinstance(data, dict) and (
        "links" in data or "edges" not in data
    ) else "edges"
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("nodes"), list)
        or not isinstance(data.get(edge_key), list)
    ):
        raise RelocationError(
            f"relocation_failed: vault_graph_corrupt:{path}"
        )
    return data


def write_json_work(path: Path, suffix: str, data: dict[str, Any]) -> Path:
    """Write a complete staged graph without publishing it."""
    work_path = path.with_name(f".{path.name}.{suffix}")
    work_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return work_path


def node_link_edges(blob: dict[str, Any]) -> list[dict[str, Any]]:
    """Return only structurally valid edge objects from node-link JSON."""
    items = blob.get("links", blob.get("edges", []))
    if not isinstance(items, list):
        return []
    return [
        item
        for item in items
        if isinstance(item, dict)
        and all(
            isinstance(item.get(field), str)
            for field in ("source", "target", "relation")
        )
        and (
            item.get("source_file") is None
            or isinstance(item.get("source_file"), str)
        )
    ]


def edge_evidence_key(item: dict[str, Any]) -> tuple[Any, ...]:
    """Keep normal edge identity stable and distinguish archived captures."""
    key: tuple[Any, ...] = (
        item.get("source"),
        item.get("target"),
        item.get("relation"),
        item.get("source_file"),
    )
    source_file = item.get("source_file")
    if isinstance(source_file, str) and Path(source_file).name == "Archive.md":
        return (*key, item.get("source_location"))
    return key


def dedupe_node_link_edges(blob: dict[str, Any]) -> dict[str, Any]:
    """Return node-link JSON with one edge per semantic evidence identity."""
    unique: dict[tuple[Any, ...], dict[str, Any]] = {}
    for item in node_link_edges(blob):
        unique.setdefault(edge_evidence_key(item), item)
    edge_key = "links" if "links" in blob or "edges" not in blob else "edges"
    return {**blob, edge_key: list(unique.values())}


def merge_node_link_evidence(
    persisted: dict[str, Any], *evidence_blobs: dict[str, Any]
) -> dict[str, Any]:
    """Restore unique nodes and edge evidence after simple graph composition."""
    nodes: dict[str, dict[str, Any]] = {}
    edges = node_link_edges(persisted)
    for blob in (persisted, *evidence_blobs):
        items = blob.get("nodes", [])
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and isinstance(item.get("id"), str):
                    nodes.setdefault(item["id"], item)
        if blob is not persisted:
            edges.extend(node_link_edges(blob))
    edge_key = "links" if "links" in persisted or "edges" not in persisted else "edges"
    merged = {**persisted, "nodes": list(nodes.values()), edge_key: edges}
    return dedupe_node_link_edges(merged)


def relocated_item(
    item: Any, mappings: dict[str, tuple[str, str]]
) -> Any:
    """Replace only provenance fields on one graph item."""
    if not isinstance(item, dict) or item.get("source_file") not in mappings:
        return item
    archive_file, source_location = mappings[item["source_file"]]
    return {
        **item,
        "source_file": archive_file,
        "source_location": source_location,
    }


def verify_relocated_provenance(
    before: dict[str, Any], after: dict[str, Any], data: dict[str, Any]
) -> None:
    """Fail unless relocation changed provenance and nothing else."""
    mappings = relocation_map(data)
    edge_key = "links" if "links" in before or "edges" not in before else "edges"
    after_nodes = after.get("nodes", [])
    after_edges = after.get(edge_key, [])

    for item in (
        (after_nodes if isinstance(after_nodes, list) else [])
        + (after_edges if isinstance(after_edges, list) else [])
    ):
        if isinstance(item, dict) and item.get("source_file") in mappings:
            raise RelocationError(
                f"relocation_failed: stale_source_file:{item['source_file']}"
            )

    expected_nodes = [relocated_item(item, mappings) for item in before.get("nodes", [])]
    if after_nodes != expected_nodes:
        raise RelocationError("relocation_failed: unresolved_node_location")

    expected_edges = [relocated_item(item, mappings) for item in before.get(edge_key, [])]
    if after_edges != expected_edges:
        raise RelocationError("relocation_failed: unresolved_edge_location")

    ignored = {"nodes", edge_key}
    if ({key: value for key, value in before.items() if key not in ignored}
            != {key: value for key, value in after.items() if key not in ignored}):
        raise RelocationError("relocation_failed: unrelated_graph_fields_changed")


def relocate_node_link_provenance(
    blob: dict[str, Any], data: dict[str, Any]
) -> dict[str, Any]:
    """Transform existing provenance one-for-one without merging evidence."""
    mappings = relocation_map(data)
    edge_key = "links" if "links" in blob or "edges" not in blob else "edges"
    relocated = {
        **blob,
        "nodes": [relocated_item(item, mappings) for item in blob.get("nodes", [])],
        edge_key: [relocated_item(item, mappings) for item in blob.get(edge_key, [])],
    }
    verify_relocated_provenance(blob, relocated, data)
    return relocated


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
    parser = argparse.ArgumentParser()
    parser.add_argument("chunk", nargs="?", default=DEFAULT_CHUNK)
    parser.add_argument("vault_graph", nargs="?", default=DEFAULT_VAULT_GRAPH)
    parser.add_argument("out", nargs="?", default=DEFAULT_OUT)
    parser.add_argument(
        "--relocate",
        type=Path,
        help="atomically apply provenance replacements from this JSON file",
    )
    args = parser.parse_args()

    chunk_path = Path(args.chunk)
    vault_graph_path = Path(args.vault_graph)
    out_path = Path(args.out)

    if args.relocate:
        relocation_data = load_relocation(args.relocate)
        prior_blob = load_relocation_graph(vault_graph_path)
        persisted = relocate_node_link_provenance(prior_blob, relocation_data)
        vault_work: Path | None = None
        out_work: Path | None = None
        try:
            vault_work = write_json_work(
                vault_graph_path, "relocate", persisted
            )
            if out_path != vault_graph_path:
                out_work = write_json_work(out_path, "relocate", persisted)
            relocation_map(relocation_data)
            os.replace(vault_work, vault_graph_path)
            vault_work = None
            if out_work is not None:
                os.replace(out_work, out_path)
                out_work = None
        finally:
            if vault_work is not None:
                vault_work.unlink(missing_ok=True)
            if out_work is not None:
                out_work.unlink(missing_ok=True)
        print(
            f"vault graph: {len(persisted.get('nodes', []))} nodes "
            f"(provenance relocated), "
            f"{len(persisted.get('links', persisted.get('edges', [])))} edges"
        )
        return

    import networkx as nx
    from graphify.build import build_from_json
    from graphify.cluster import cluster
    from graphify.export import to_json

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
        prior_blob = {"nodes": [], "links": []}

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
