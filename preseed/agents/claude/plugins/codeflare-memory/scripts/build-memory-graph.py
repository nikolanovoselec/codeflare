#!/usr/bin/env python3
"""Build one deterministic graph chunk from a Pi session-memory note."""

from __future__ import annotations

import hashlib
import itertools
import json
import re
import sys
import unicodedata
from pathlib import Path

VAULT_ROOT = Path("/home/user/Vault")
WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")
BULLET = re.compile(r"^\s*[-*+]\s+")


def slug(value: str) -> str:
    ascii_value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    normalized = re.sub(r"[^a-z0-9]+", "_", ascii_value.lower()).strip("_")
    if normalized:
        return normalized
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def document_id(target: Path) -> str:
    try:
        relative = target.relative_to(VAULT_ROOT)
    except ValueError:
        relative = target
    return f"vault_{slug(str(relative.with_suffix('')))}"


def concept_labels(text: str) -> list[str]:
    labels: dict[str, str] = {}
    for match in WIKILINK.finditer(text):
        label = match.group(1).split("|", 1)[0].split("#", 1)[0].strip()
        if label:
            labels.setdefault(f"concept_{slug(label)}", label)
    return [labels[key] for key in sorted(labels)]


def concept_ids(text: str) -> list[str]:
    return sorted({f"concept_{slug(label)}" for label in concept_labels(text)})


def node(identifier: str, label: str, file_type: str, source_file: str | None) -> dict[str, object]:
    return {
        "id": identifier,
        "label": label,
        "file_type": file_type,
        "source_file": source_file,
        "source_location": None,
        "source_url": None,
        "captured_at": None,
        "author": None,
        "contributor": None,
    }


def edge(
    source: str,
    target: str,
    relation: str,
    confidence: str,
    confidence_score: float,
    source_file: str,
) -> dict[str, object]:
    return {
        "source": source,
        "target": target,
        "relation": relation,
        "confidence": confidence,
        "confidence_score": confidence_score,
        "source_file": source_file,
        "source_location": None,
        "weight": 1.0,
    }


def build_graph(note_text: str, target: Path) -> dict[str, object]:
    target_text = str(target)
    document = document_id(target)
    title = next(
        (
            match.group(1).strip()
            for line in note_text.splitlines()
            if (match := re.match(r"^#\s+(.+)$", line))
        ),
        target.stem,
    )
    labels = concept_labels(note_text)
    labels_by_id = {f"concept_{slug(label)}": label for label in labels}

    nodes = [node(document, title, "document", target_text)]
    nodes.extend(
        node(identifier, labels_by_id[identifier], "concept", None)
        for identifier in sorted(labels_by_id)
    )

    edges_by_key: dict[tuple[str, str, str, str], dict[str, object]] = {}
    for identifier in sorted(labels_by_id):
        item = edge(document, identifier, "references", "EXTRACTED", 1.0, target_text)
        edges_by_key[(document, identifier, "references", target_text)] = item

    for line in note_text.splitlines():
        if not BULLET.match(line):
            continue
        identifiers = concept_ids(line)
        for source, target_id in itertools.combinations(identifiers, 2):
            item = edge(source, target_id, "conceptually_related_to", "INFERRED", 0.8, target_text)
            edges_by_key[(source, target_id, "conceptually_related_to", target_text)] = item

    return {
        "nodes": nodes,
        "edges": [edges_by_key[key] for key in sorted(edges_by_key)],
        "hyperedges": [],
        "input_tokens": 0,
        "output_tokens": 0,
    }


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit("usage: build-memory-graph.py NOTE_PATH TARGET_PATH OUTPUT_PATH")
    note_path, target_path, output_path = map(Path, sys.argv[1:])
    graph = build_graph(note_path.read_text(encoding="utf-8"), target_path)
    output_path.write_text(json.dumps(graph, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
