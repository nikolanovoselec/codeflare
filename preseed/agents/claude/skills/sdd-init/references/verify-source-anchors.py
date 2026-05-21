#!/usr/bin/env python3
"""
verify-source-anchors.py - Phase 7a Programmatic Source-Anchor Verifier (CRITICAL)

Walks every `<!-- @impl: <path>::<symbol>[ = <value>] -->` anchor in
`sdd/**/*.md` + `documentation/**/*.md`, validates each against source on
disk, and emits a machine-readable JSON summary.

Convention: <symbol> is the EXACT identifier as it appears in source.
No package-qualified names, no class-dot-method, no leaf splitting.
The <path> already locates the file - the symbol just needs to be the
literal token to grep for. One identifier, one search.

Exit code is the authoritative signal:
    0 - every anchor resolves AND every value pattern matches
    1 - at least one anchor failed (orphaned, drifted, malformed, unreadable)

The /sdd init agent MUST run this BEFORE invoking spec-enforce / doc-enforce
and MUST copy the summary line verbatim into the [sdd-init] commit body.
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from pathlib import Path

# <!-- @impl: PATH::SYMBOL[ = VALUE] -->
# Path forbids `:` and whitespace (so `::` is the separator). Symbol-or-pair
# is everything up to the literal `-->` close - non-greedy so a `>` inside
# an arrow function value or generic type does not terminate the match.
ANCHOR_RE = re.compile(r'<!--\s*@impl:\s*([^\s:][^:]*?)::(.+?)\s*-->')

# Anything that looks like an `@impl` marker. Used to count malformed
# anchors (shape matches but ANCHOR_RE does not) so silent drops fail loudly.
ANCHOR_SHAPE_RE = re.compile(r'<!--\s*@impl:')

# Optional ` = value` tail inside the symbol-or-pair capture.
SYM_VAL_RE = re.compile(r'^(.+?)\s*=\s*(.+?)\s*$')

# Strip inline code spans before parsing. Doc prose describing the anchor
# convention is wrapped in backticks; without stripping, the verifier
# parses its own examples as real anchors.
BACKTICK_SPAN_RE = re.compile(r'``[^`]*``|`[^`]*`')
TRIPLE_FENCE_RE = re.compile(r'^\s*```')


def collect_anchors(repo_root: Path, doc_globs: list[str]) -> tuple[list[dict], list[dict], list[dict]]:
    """Return (anchors, malformed, unreadable)."""
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
            in_fence = False
            for ln, raw_text in enumerate(lines, 1):
                if TRIPLE_FENCE_RE.match(raw_text):
                    in_fence = not in_fence
                    continue
                if in_fence:
                    continue
                text = BACKTICK_SPAN_RE.sub('', raw_text)
                shape_hits = list(ANCHOR_SHAPE_RE.finditer(text))
                if not shape_hits:
                    continue
                parsed_hits = list(ANCHOR_RE.finditer(text))
                for m in parsed_hits:
                    path = m.group(1).strip()
                    sym_or_pair = m.group(2).strip()
                    # Paths never contain `<` or `>` on any filesystem.
                    # Prose using `<placeholder>` syntax is not an anchor.
                    if '<' in path or '>' in path:
                        continue
                    # Normalise cross-platform path tokens: strip leading
                    # `./` and convert `\\` to `/` so anchors written on
                    # any host match the repo-relative POSIX form.
                    if path.startswith('./'):
                        path = path[2:]
                    path = path.replace('\\', '/')
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
                if len(parsed_hits) < len(shape_hits):
                    malformed.append({
                        'file': str(md.relative_to(repo_root)),
                        'line': ln,
                        'text': raw_text.strip(),
                        'reason': 'anchor-shape-but-not-parseable',
                    })
    return anchors, malformed, unreadable


def verify_anchor(repo_root: Path, anchor: dict) -> dict:
    """Return {status, reason}. Status is resolved | orphaned | drifted."""
    target = repo_root / anchor['path']
    if not target.exists():
        return {'status': 'orphaned', 'reason': f"path-not-found: {anchor['path']}"}
    if not target.is_file():
        return {'status': 'orphaned', 'reason': f"path-not-a-file: {anchor['path']}"}

    try:
        body = target.read_text(encoding='utf-8', errors='replace')
    except OSError as exc:
        return {'status': 'orphaned', 'reason': f'unreadable: {exc}'}

    # Symbol must appear as a bare token in source. Word boundary on both
    # sides (lookarounds rather than \b so sigil-prefixed identifiers like
    # $x and @const work too).
    symbol = anchor['symbol']
    sym_match = re.search(rf'(?<!\w){re.escape(symbol)}(?!\w)', body)
    if not sym_match:
        return {
            'status': 'orphaned',
            'reason': f"symbol-not-found: {anchor['path']}::{symbol}",
        }

    # Value pattern: search only the 300 chars immediately after the
    # symbol's match position. A value-assignment elsewhere in the file
    # cannot bleed in. Bare-substring fallback only for sufficiently
    # distinctive values (len >= 8); short values like 1 / true would
    # substring-match almost any region.
    if anchor['value'] is not None:
        value = anchor['value']
        region_end = min(len(body), sym_match.start() + 300)
        region = body[sym_match.start():region_end]
        candidates = [
            f' = {value}', f'= {value}', f' ={value}', f'={value}',
            f': {value}', f':{value}',
            f' {value};', f' {value},', f' {value})',
        ]
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
    ap.add_argument('--json-out', default=None, help='Write full JSON report to this path')
    ap.add_argument('--quiet', action='store_true', help='Suppress human-readable summary')
    args = ap.parse_args()

    repo_root = Path(args.root).resolve()
    anchors, malformed, unreadable = collect_anchors(
        repo_root, ['sdd/**/*.md', 'documentation/**/*.md']
    )

    failures: list[dict] = []
    resolved = 0
    for a in anchors:
        outcome = verify_anchor(repo_root, a)
        if outcome['status'] == 'resolved':
            resolved += 1
        else:
            failures.append({
                'file': a['file'], 'line': a['line'],
                'path': a['path'], 'symbol': a['symbol'], 'value': a['value'],
                'status': outcome['status'], 'reason': outcome['reason'],
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
            f"resolved={report['resolved']} orphaned={report['orphaned']} "
            f"drifted={report['drifted']} malformed={report['malformed']} "
            f"unreadable={report['unreadable']} exit_code={report['exit_code']}",
            file=sys.stderr,
        )
    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
