#!/usr/bin/env python3
"""
verify-enumeration-coverage.py - Phase 7b Programmatic Enumeration-Coverage Verifier (CRITICAL)

Detects the *Import-Mode-narrowed-scope* failure mode: the agent silently drafts
ACs only around the easily-anchorable subset of source, leaving an empty triage
queue and a spec that looks clean but elides every ambiguity.

Phase 7a checks that every claim the agent DID write is anchored. Phase 7b
checks that the agent did not silently drop entire source files / behaviors
from the enumeration. The two together close the Validation-Equals-Generation
gap.

How it works:
  1. Walk the working tree, identify "load-bearing source files" via a
     project-shape-agnostic heuristic (lives under services/handlers/
     controllers/providers/models/domain/core OR is >= 100 source lines).
  2. For each such file, check whether its repo-relative path appears as the
     <path> portion of at least one `<!-- @impl: <path>::<symbol> -->` anchor
     anywhere in sdd/**/*.md + documentation/**/*.md, OR is referenced
     literally in sdd/spec/.init-triage.md / sdd/spec/.review-queue.md.
  3. Anything not covered is `unaccounted` -> must become a triage entry
     before commit.

Exit code is the authoritative signal:
    0 - every load-bearing file is accounted for in spec or triage.
    1 - at least one file is unaccounted (Import Mode narrowed scope).

The /sdd init agent MUST run this AFTER Phase 7a and BEFORE invoking
spec-enforce / doc-enforce, and MUST copy the summary line verbatim into
the [sdd-init] commit body. Anti-substitution clauses mirror Phase 7a
(see sdd-init/SKILL.md step 7b).
"""
from __future__ import annotations
import argparse
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

ANCHOR_PATH_RE = re.compile(r'<!--\s*@impl:\s*([^\s:][^:]*?)::')

LOAD_BEARING_DIR_TOKENS = (
    'services', 'service',
    'providers', 'provider',
    'handlers', 'handler',
    'controllers', 'controller',
    'models', 'model',
    'domain',
    'core',
    'commands', 'command',
    'usecases', 'use_cases',
    'workers', 'worker',
)

EXCLUDE_DIR_TOKENS = (
    'test', 'tests', '__tests__', '__pycache__',
    'spec', 'specs',
    'node_modules', 'dist', 'build', 'vendor',
    '.git', '.dart_tool', '.next', '.svelte-kit', '.cache',
    'generated', 'gen', '__generated__',
    'graphify-out',
    'documentation',
    'sdd',
)

SOURCE_EXTENSIONS = {
    '.dart', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py',
    '.go',
    '.rs',
    '.kt', '.kts',
    '.swift',
    '.rb',
    '.java', '.scala',
    '.cs',
    '.php',
    '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
}

LARGE_FILE_LINE_THRESHOLD = 100

GENERATED_FILE_MARKERS = (
    'GENERATED FILE',
    '@generated',
    'AUTO-GENERATED',
    'DO NOT EDIT',
    'GeneratedPluginRegistrant',
    '.generated.',
    '.g.dart',
    '.freezed.dart',
)


@dataclass(frozen=True)
class LoadBearing:
    path: str
    reason: str
    line_count: int


@dataclass
class CoverageReport:
    enumerated: int = 0
    accounted: int = 0
    unaccounted: int = 0
    coverage_pct: float = 0.0
    accounted_via: dict = field(default_factory=lambda: {'anchor': 0, 'triage': 0})
    unaccounted_entries: list = field(default_factory=list)
    enumerated_entries: list = field(default_factory=list)
    exit_code: int = 0


def is_under_excluded_dir(path: Path, repo_root: Path) -> bool:
    rel = path.relative_to(repo_root)
    return any(part.lower() in EXCLUDE_DIR_TOKENS for part in rel.parts[:-1])


def is_under_load_bearing_dir(path: Path, repo_root: Path) -> bool:
    rel = path.relative_to(repo_root)
    return any(part.lower() in LOAD_BEARING_DIR_TOKENS for part in rel.parts[:-1])


def is_generated(path: Path) -> bool:
    name = path.name
    if any(marker in name for marker in ('.g.', '.freezed.', '.generated.', '.pb.')):
        return True
    try:
        head = path.read_text(encoding='utf-8', errors='replace')[:512]
    except OSError:
        return False
    return any(marker in head for marker in GENERATED_FILE_MARKERS)


def count_source_lines(path: Path) -> int:
    try:
        text = path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return 0
    n = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # Lightweight comment skip; project-language-agnostic.
        if line.startswith(('//', '#', '/*', '*', '--', ';')):
            continue
        n += 1
    return n


def enumerate_load_bearing(repo_root: Path) -> list[LoadBearing]:
    seen_paths: set[str] = set()
    out: list[LoadBearing] = []
    for path in repo_root.rglob('*'):
        if not path.is_file():
            continue
        if path.suffix not in SOURCE_EXTENSIONS:
            continue
        if is_under_excluded_dir(path, repo_root):
            continue
        if is_generated(path):
            continue
        rel = str(path.relative_to(repo_root))
        if rel in seen_paths:
            continue

        under_lb = is_under_load_bearing_dir(path, repo_root)
        line_count = count_source_lines(path)
        if under_lb:
            reason = 'load-bearing-directory'
        elif line_count >= LARGE_FILE_LINE_THRESHOLD:
            reason = f'source-lines>={LARGE_FILE_LINE_THRESHOLD}'
        else:
            continue
        seen_paths.add(rel)
        out.append(LoadBearing(path=rel, reason=reason, line_count=line_count))
    return out


def collect_anchored_paths(repo_root: Path) -> set[str]:
    out: set[str] = set()
    for pattern in ('sdd/**/*.md', 'documentation/**/*.md'):
        for md in repo_root.glob(pattern):
            try:
                text = md.read_text(encoding='utf-8', errors='replace')
            except OSError:
                continue
            for m in ANCHOR_PATH_RE.finditer(text):
                anchored = m.group(1).strip()
                if anchored and '<' not in anchored and '>' not in anchored:
                    out.add(anchored)
    return out


def collect_triage_paths(repo_root: Path) -> set[str]:
    """Repo-relative source paths literally mentioned in triage / queue files."""
    out: set[str] = set()
    triage_files = [
        repo_root / 'sdd/spec/.init-triage.md',
        repo_root / 'sdd/spec/.review-queue.md',
        repo_root / 'sdd/.init-triage.md',
        repo_root / 'sdd/.review-needed.md',
    ]
    # Path-shape token: characters allowed in repo-relative source paths.
    path_token_re = re.compile(r'[\w./_-]+\.(?:dart|ts|tsx|js|jsx|mjs|cjs|py|go|rs|kt|kts|swift|rb|java|scala|cs|php|c|cc|cpp|cxx|h|hpp)')
    for t in triage_files:
        if not t.exists():
            continue
        try:
            text = t.read_text(encoding='utf-8', errors='replace')
        except OSError:
            continue
        for m in path_token_re.finditer(text):
            out.add(m.group(0))
    return out


def main() -> int:
    ap = argparse.ArgumentParser(
        description='Phase 7b programmatic enumeration-coverage verifier (CRITICAL).'
    )
    ap.add_argument('--root', default='.', help='Repo root (default: cwd)')
    ap.add_argument('--json-out', default=None, help='Write full JSON report to this path')
    ap.add_argument('--quiet', action='store_true', help='Suppress human-readable summary')
    ap.add_argument(
        '--waiver', default='sdd/spec/.phase-7b-waiver.txt',
        help='Per-line list of repo-relative paths to exclude from coverage check.',
    )
    args = ap.parse_args()

    repo_root = Path(args.root).resolve()

    enumerated = enumerate_load_bearing(repo_root)
    anchored_paths = collect_anchored_paths(repo_root)
    triage_paths = collect_triage_paths(repo_root)

    waiver_path = repo_root / args.waiver
    waived: set[str] = set()
    if waiver_path.exists():
        try:
            for line in waiver_path.read_text(encoding='utf-8').splitlines():
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                waived.add(line)
        except OSError:
            pass

    report = CoverageReport()
    for lb in enumerated:
        if lb.path in waived:
            continue
        report.enumerated += 1
        report.enumerated_entries.append(asdict(lb))
        if lb.path in anchored_paths:
            report.accounted += 1
            report.accounted_via['anchor'] += 1
        elif lb.path in triage_paths:
            report.accounted += 1
            report.accounted_via['triage'] += 1
        else:
            report.unaccounted_entries.append({
                'path': lb.path,
                'reason': lb.reason,
                'line_count': lb.line_count,
                'recommendation': (
                    'Draft an AC that references this file via @impl, '
                    'OR add a triage entry to sdd/spec/.init-triage.md '
                    'naming the file and the unresolved question.'
                ),
            })

    report.unaccounted = len(report.unaccounted_entries)
    report.coverage_pct = (
        round(100.0 * report.accounted / report.enumerated, 1)
        if report.enumerated else 100.0
    )
    report.exit_code = 1 if report.unaccounted > 0 else 0

    serialised = json.dumps(asdict(report), indent=2)
    print(serialised)
    if args.json_out:
        Path(args.json_out).write_text(serialised, encoding='utf-8')
    if not args.quiet:
        print(
            f"\nPhase 7b enum verifier: enumerated={report.enumerated} "
            f"accounted={report.accounted} unaccounted={report.unaccounted} "
            f"coverage_pct={report.coverage_pct} exit_code={report.exit_code}",
            file=sys.stderr,
        )
    return report.exit_code


if __name__ == '__main__':
    sys.exit(main())
