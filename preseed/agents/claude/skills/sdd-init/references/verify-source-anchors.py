#!/usr/bin/env python3
"""
verify-source-anchors.py - Phase 7a Programmatic Source-Anchor Verifier (CRITICAL)

Walks every `<!-- @impl: <path>::<symbol>[ = <value-pattern>] -->` anchor in
`sdd/**/*.md` + `documentation/**/*.md`, programmatically validates each
against source on disk, and emits a machine-readable JSON summary.

Exit code is the authoritative signal:
    0 - every anchor resolves AND every literal value pattern matches source
    1 - at least one anchor failed (orphaned, drifted, malformed, or any
        doc file was unreadable); commit MUST be blocked

The agent invoking /sdd init MUST run this BEFORE invoking spec-enforce /
doc-enforce and MUST copy the parsed/resolved/orphaned/drifted/malformed/
unreadable counts (plus exit_code) verbatim into the [sdd-init] commit body.
Self-attestation without the verifier output is itself a CRITICAL
phase-7a-self-attestation finding caught by the next PR-boundary review.

Usage:
    python3 verify-source-anchors.py [--root <repo-root>] [--json-out <path>] [--quiet]

Run from a clone whose working directory is the repo root, OR pass --root.
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

# Match: <!-- @impl: PATH::SYMBOL_OR_PAIR -->
# PATH allows any non-whitespace except `:`. The trailing capture is
# everything up to the literal `-->` close - non-greedy so we stop at the
# first `-->` rather than consuming `>` inside arrow-function values,
# threshold literals, or generic type parameters.
ANCHOR_RE = re.compile(
    r'<!--\s*@impl:\s*([^\s:][^:]*?)::(.+?)\s*-->'
)

# Sentinel for any `@impl` comment we recognise as "intended to be an anchor"
# but that fails to fully parse via ANCHOR_RE. Counted as `malformed` and
# fails the run - silent drop is exactly the failure mode this gate exists
# to prevent.
ANCHOR_SHAPE_RE = re.compile(r'<!--\s*@impl:')

# Inside the captured "symbol or pair" portion, an optional " = VALUE" tail
# is the literal-pattern part. We split here rather than in the outer regex
# to keep the symbol-vs-value boundary clean across whitespace variants.
SYM_VAL_RE = re.compile(r'^(.+?)\s*=\s*(.+?)\s*$')


def collect_anchors(repo_root: Path, doc_globs: list[str]) -> tuple[list[dict], list[dict], list[dict]]:
    """Return (anchors, malformed, unreadable).

    - anchors: fully-parsed entries [{file, line, path, symbol, value, raw}].
    - malformed: comments that look like `@impl` markers but don't match
      ANCHOR_RE - silent drop is forbidden, so they're reported as failures.
    - unreadable: doc files whose contents could not be read.
    """
    anchors: list[dict] = []
    malformed: list[dict] = []
    unreadable: list[dict] = []
    for pattern in doc_globs:
        for md in sorted(repo_root.glob(pattern)):
            try:
                lines = md.read_text(encoding='utf-8', errors='replace').splitlines()
            except OSError as exc:
                unreadable.append({
                    'file': str(md.relative_to(repo_root)),
                    'reason': str(exc),
                })
                continue
            for ln, text in enumerate(lines, 1):
                shape_hits = list(ANCHOR_SHAPE_RE.finditer(text))
                if not shape_hits:
                    continue
                parsed_hits = list(ANCHOR_RE.finditer(text))
                for m in parsed_hits:
                    path = m.group(1).strip()
                    sym_or_pair = m.group(2).strip()
                    sym_match = SYM_VAL_RE.match(sym_or_pair)
                    if sym_match:
                        symbol = sym_match.group(1).strip()
                        value = sym_match.group(2).strip()
                    else:
                        symbol = sym_or_pair
                        value = None
                    anchors.append({
                        'file': str(md.relative_to(repo_root)),
                        'line': ln,
                        'path': path,
                        'symbol': symbol,
                        'value': value,
                        'raw': m.group(0),
                    })
                # Any `@impl`-shaped marker on the line that ANCHOR_RE didn't
                # also match is a malformed anchor.
                if len(parsed_hits) < len(shape_hits):
                    malformed.append({
                        'file': str(md.relative_to(repo_root)),
                        'line': ln,
                        'text': text.strip(),
                        'reason': 'anchor-shape-but-not-parseable',
                    })
    return anchors, malformed, unreadable


def _symbol_region(body: str, leaf: str, window: int = 300) -> str | None:
    """Return the source region immediately AFTER the leaf identifier, or None
    if the leaf does not appear as a word-bounded token. Forward-only scoping
    so a value-assignment on a preceding line (e.g. `unrelated = 1;` followed
    by `TARGET = 5;`) cannot bleed into the value-pattern check for TARGET."""
    m = re.search(rf'\b{re.escape(leaf)}\b', body)
    if not m:
        return None
    end = min(len(body), m.start() + window)
    return body[m.start():end]


def verify_anchor(repo_root: Path, anchor: dict) -> dict:
    """Return {status: 'resolved'|'orphaned'|'drifted', reason: str|None}."""
    target = repo_root / anchor['path']

    if not target.exists():
        return {'status': 'orphaned', 'reason': f"path-not-found: {anchor['path']}"}
    if not target.is_file():
        return {'status': 'orphaned', 'reason': f"path-not-a-file: {anchor['path']}"}

    try:
        body = target.read_text(encoding='utf-8', errors='replace')
    except OSError as exc:
        return {'status': 'orphaned', 'reason': f'unreadable: {exc}'}

    # Symbol presence: word-boundary check on the leaf identifier (last
    # `.`-separated segment) AND fall back to the full literal for Kotlin/JS
    # where dots are package separators. Substring containment alone produces
    # false resolves against unrelated tokens that happen to contain the leaf.
    symbol = anchor['symbol']
    leaf = symbol.rsplit('.', 1)[-1]
    leaf_present = re.search(rf'\b{re.escape(leaf)}\b', body) is not None
    # Dotted-name fallback (e.g. Kotlin/JS `package.Class`): the full literal
    # with the dot is distinctive enough to substring-match safely. When
    # symbol == leaf (no dot), the substring fallback would defeat the
    # word-boundary check, so skip it in that case.
    has_dot = '.' in symbol
    full_present = has_dot and symbol in body
    if not (leaf_present or full_present):
        return {
            'status': 'orphaned',
            'reason': f"symbol-not-found: {anchor['path']}::{symbol}",
        }

    if anchor['value'] is not None:
        value = anchor['value']
        # Scope the value-pattern search to the region around the symbol.
        # Without scoping, short values like `1` / `true` / `0` substring-match
        # anywhere in the file and the verifier reports a false `resolved`.
        region = _symbol_region(body, leaf) or _symbol_region(body, symbol) or body
        candidates = [
            f' = {value}',
            f'= {value}',
            f' ={value}',
            f'={value}',
            f': {value}',
            f':{value}',
            f' {value};',
            f' {value},',
            f' {value})',
        ]
        # Bare-substring fallback only for sufficiently distinctive values.
        # `1`, `true`, single chars will substring-match almost any file.
        if len(value) >= 8:
            candidates.append(value)
        if not any(c in region for c in candidates):
            return {
                'status': 'drifted',
                'reason': f"value-pattern-not-found: {anchor['path']}::{symbol} expected={value!r}",
            }

    return {'status': 'resolved', 'reason': None}


def main() -> int:
    ap = argparse.ArgumentParser(
        description='Phase 7a programmatic source-anchor verifier (CRITICAL).'
    )
    ap.add_argument('--root', default='.', help='Repo root (default: cwd)')
    ap.add_argument(
        '--json-out',
        default=None,
        help='Write full JSON report to this path (in addition to stdout)',
    )
    ap.add_argument(
        '--quiet',
        action='store_true',
        help='Suppress human-readable summary; emit JSON only',
    )
    args = ap.parse_args()

    repo_root = Path(args.root).resolve()
    doc_globs = ['sdd/**/*.md', 'documentation/**/*.md']

    anchors, malformed, unreadable = collect_anchors(repo_root, doc_globs)

    failures: list[dict] = []
    resolved = 0
    for a in anchors:
        outcome = verify_anchor(repo_root, a)
        if outcome['status'] == 'resolved':
            resolved += 1
        else:
            failures.append({
                'file': a['file'], 'line': a['line'],
                'path': a['path'], 'symbol': a['symbol'],
                'value': a['value'],
                'status': outcome['status'],
                'reason': outcome['reason'],
            })

    orphaned = sum(1 for f in failures if f['status'] == 'orphaned')
    drifted = sum(1 for f in failures if f['status'] == 'drifted')
    failed = orphaned + drifted + len(malformed) + len(unreadable)

    report = {
        'parsed': len(anchors),
        'resolved': resolved,
        'orphaned': orphaned,
        'drifted': drifted,
        'malformed': len(malformed),
        'unreadable': len(unreadable),
        'failures': failures,
        'malformed_entries': malformed,
        'unreadable_entries': unreadable,
        'exit_code': 1 if failed > 0 else 0,
    }

    print(json.dumps(report, indent=2))

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report, indent=2), encoding='utf-8')

    if not args.quiet:
        print(
            f"\nPhase 7a verifier: parsed={report['parsed']} "
            f"resolved={report['resolved']} "
            f"orphaned={report['orphaned']} "
            f"drifted={report['drifted']} "
            f"malformed={report['malformed']} "
            f"unreadable={report['unreadable']} "
            f"exit_code={report['exit_code']}",
            file=sys.stderr,
        )

    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
