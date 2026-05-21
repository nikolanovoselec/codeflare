#!/usr/bin/env python3
"""
verify-source-anchors.py — Phase 7a Programmatic Source-Anchor Verifier (CRITICAL)

Walks every `<!-- @impl: <path>::<symbol>[ = <value-pattern>] -->` anchor in
`sdd/**/*.md` + `documentation/**/*.md`, programmatically validates each
against source on disk, and emits a machine-readable JSON summary.

Exit code is the authoritative signal:
    0 — every anchor resolves AND every literal value pattern matches source
    1 — at least one anchor failed (orphaned OR value-drift); commit MUST be blocked

The agent invoking /sdd init MUST run this BEFORE invoking spec-enforce / doc-enforce
and MUST copy the parsed/resolved/orphaned/drifted counts (plus exit code)
verbatim into the [sdd-init] commit body. Self-attestation without the verifier
output is itself a CRITICAL phase-7a-self-attestation finding caught by the
next PR-boundary review.

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

# Match: <!-- @impl: PATH::SYMBOL [ = VALUE] -->
# PATH allows any non-whitespace except `:`. SYMBOL allows any non-whitespace
# but stops at ` -->` or ` = `. VALUE captures the literal pattern verbatim.
ANCHOR_RE = re.compile(
    r'<!--\s*@impl:\s*([^\s:][^:]*?)::([^\s][^>]*?)\s*-->'
)

# Inside the captured "symbol" portion, an optional " = VALUE" tail is the
# literal-pattern part. We split here rather than in the outer regex to keep
# the symbol-vs-value boundary clean across whitespace variants.
SYM_VAL_RE = re.compile(r'^(.+?)\s*=\s*(.+?)\s*$')


def collect_anchors(repo_root: Path, doc_globs: list[str]) -> list[dict]:
    """Return [{file, line, path, symbol, value_or_none, raw}] for every anchor."""
    found: list[dict] = []
    for pattern in doc_globs:
        for md in sorted(repo_root.glob(pattern)):
            try:
                lines = md.read_text(encoding='utf-8', errors='replace').splitlines()
            except OSError as exc:
                print(f'WARN: cannot read {md}: {exc}', file=sys.stderr)
                continue
            for ln, text in enumerate(lines, 1):
                for m in ANCHOR_RE.finditer(text):
                    path = m.group(1).strip()
                    sym_or_pair = m.group(2).strip()
                    sym_match = SYM_VAL_RE.match(sym_or_pair)
                    if sym_match:
                        symbol = sym_match.group(1).strip()
                        value = sym_match.group(2).strip()
                    else:
                        symbol = sym_or_pair
                        value = None
                    found.append({
                        'file': str(md.relative_to(repo_root)),
                        'line': ln,
                        'path': path,
                        'symbol': symbol,
                        'value': value,
                        'raw': m.group(0),
                    })
    return found


def verify_anchor(repo_root: Path, anchor: dict) -> dict:
    """Return {status: 'resolved'|'orphaned'|'drifted', reason: str|None}."""
    target = repo_root / anchor['path']

    # 1. Path existence.
    if not target.exists():
        return {'status': 'orphaned', 'reason': f"path-not-found: {anchor['path']}"}
    if not target.is_file():
        return {'status': 'orphaned', 'reason': f"path-not-a-file: {anchor['path']}"}

    try:
        body = target.read_text(encoding='utf-8', errors='replace')
    except OSError as exc:
        return {'status': 'orphaned', 'reason': f'unreadable: {exc}'}

    # 2. Symbol presence. Take the last `.`-separated segment as the leaf
    #    identifier (e.g. `AuthService._migrateSensitiveDataIfNeeded` -> the
    #    method name, which is the part that uniquely identifies the symbol
    #    in source). For Kotlin/JS where dots are package separators not
    #    member separators we also accept the full literal as fallback.
    symbol = anchor['symbol']
    leaf = symbol.rsplit('.', 1)[-1]
    if leaf not in body and symbol not in body:
        return {
            'status': 'orphaned',
            'reason': f"symbol-not-found: {anchor['path']}::{symbol}",
        }

    # 3. Value-pattern check (only when an ` = VALUE` tail was supplied).
    if anchor['value'] is not None:
        value = anchor['value']
        # Try several literal renderings the source might use.
        candidates = [
            f'= {value}',
            f'={value}',
            f': {value}',
            f':{value}',
            f' {value};',
            f' {value},',
            f' {value})',
            value,
        ]
        if not any(c in body for c in candidates):
            return {
                'status': 'drifted',
                'reason': f"value-pattern-not-found: {anchor['path']}::{symbol} expected={value!r}",
            }

    return {'status': 'resolved', 'reason': None}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[1])
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

    anchors = collect_anchors(repo_root, doc_globs)
    if not anchors:
        # Empty corpus is acceptable on a fresh project, but worth surfacing.
        report = {
            'parsed': 0, 'resolved': 0, 'orphaned': 0, 'drifted': 0,
            'failures': [], 'exit_code': 0,
        }
    else:
        failures = []
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
        report = {
            'parsed': len(anchors),
            'resolved': resolved,
            'orphaned': orphaned,
            'drifted': drifted,
            'failures': failures,
            'exit_code': 1 if (orphaned + drifted) > 0 else 0,
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
            f"exit_code={report['exit_code']}",
            file=sys.stderr,
        )

    return report['exit_code']


if __name__ == '__main__':
    sys.exit(main())
