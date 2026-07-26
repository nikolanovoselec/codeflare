#!/usr/bin/env node
// Deterministic Phase 0 triage for a PR-boundary review lane.
//
// WHY THIS EXISTS
//
// Every review lane opened with a six-step Phase 0 -- bootstrap detection,
// layout resolution, config read, transition check, round counter, bulk-op
// audit -- and each step was a separate Bash call, so each was a separate turn.
// Measured: ~3,945 tokens and 5-6 turns per lane, before any reviewing began,
// and every byte of it stayed in context for the rest of the run. A lane's
// prompt cost is paid per turn, so early triage output is the most expensive
// kind of evidence: it is re-read on every turn that follows it.
//
// Not one of those steps needs a model. They are all `test -f`, a config read,
// and two `git log` walks. This emits the same answers as one JSON object in
// the lane's opening prompt, so Phase 0 costs zero turns.
//
// FAIL-SAFE DIRECTION
//
// Triage decides whether a review runs. Every unresolvable condition therefore
// resolves to `proceed`: an unreadable config, a git failure, or a missing tree
// yields a review, never a skip. The only paths that return `exit-no-op` are
// the ones the reviewer prose already defines as no-ops (no SDD bootstrap, an
// active transition, a round limit) and each is proven positively, never by
// the absence of evidence.
//
// Usage:
//   lane-triage.mjs --repo <root> --lane <name> [--range <base>..<head>]
//                   [--required-lanes "<lane> <lane>"]
//
// `--required-lanes` is the classifier's already-computed answer, passed in
// rather than recomputed: the shell classifier is the single source of truth
// for lane ownership and a second implementation here could disagree with it.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Record separator. A commit body contains blank lines and arbitrary text, so
// newline-delimited parsing would split one commit across several records; \x1e
// cannot appear in a git subject or body produced by normal tooling.
const RS = '\x1e';

function git(repo, args) {
  try {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key?.startsWith('--')) continue;
    values[key.slice(2)] = argv[i + 1];
    i += 1;
  }
  return values;
}

// Nested (sdd/spec/**) overrides flat (sdd/*). Every downstream path resolves
// from this one decision, exactly as the reviewer prose specifies.
function resolveLayout(repo) {
  const bootstrapped = existsSync(join(repo, 'sdd')) && existsSync(join(repo, 'sdd/README.md'));
  const nested = existsSync(join(repo, 'sdd/spec'));
  const base = nested ? 'sdd/spec' : 'sdd';
  return {
    bootstrapped,
    layout: nested ? 'nested' : 'flat',
    configPath: `${base}/config.yml`,
    triageFile: nested ? 'sdd/spec/.review-queue.md' : 'sdd/.review-needed.md',
    initTriage: `${base}/.init-triage.md`,
    changelog: `${base}/changes.md`,
  };
}

// Only the scalars that drive a decision are parsed. The rest of the file is
// handed over verbatim, because a partial YAML parser that silently mis-reads
// `forbidden_content_allowlist` would weaken enforcement in a way no test here
// would catch -- and the lane needs the literal text anyway.
function readConfig(repo, configPath) {
  const abs = join(repo, configPath);
  if (!existsSync(abs)) return { present: false, raw: '' };
  let raw = '';
  try {
    raw = readFileSync(abs, 'utf-8');
  } catch {
    return { present: false, raw: '' };
  }
  // Trailing `# ...` is a YAML comment, not part of the value. Booleans survive
  // it by accident (`true # note` is simply not `true`), but `mode` and
  // `changelog_entry_style` reach the lane prompt verbatim and would carry it.
  const scalar = (key) => {
    const m = raw.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
    if (!m) return undefined;
    return m[1].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  };
  return {
    present: true,
    raw,
    mode: scalar('mode'),
    enforce_tdd: scalar('enforce_tdd') === 'true',
    transition: scalar('transition') === 'true',
    changelog_entry_style: scalar('changelog_entry_style'),
  };
}

// transition: true AND at least one open init-triage item => the lane is
// suspended. transition: true with no such item is a corrupted state: that is
// a finding, and the review still runs.
function transitionState(repo, paths, config) {
  if (!config.transition) return { active: false, corrupt: false };
  const abs = join(repo, paths.initTriage);
  if (!existsSync(abs)) return { active: false, corrupt: true };
  let body = '';
  try {
    body = readFileSync(abs, 'utf-8');
  } catch {
    return { active: false, corrupt: true };
  }
  const open = /^\*\*Status:\*\*[ \t]+open\b/im.test(body);
  return { active: open, corrupt: !open };
}

const BULK_PREFIXES = ['[sdd-init]', '[sdd-clean]', '[sdd-triage]'];

// Lane-specific, and deliberately not unified: spec-reviewer counts a subject
// that CONTAINS its tags, doc-updater one that STARTS WITH them. That asymmetry
// is what each lane's prose says, and collapsing it here would silently change
// when a round limit fires.
const ROUND_RULES = {
  'spec-reviewer': {
    tags: ['[autonomous]', '[unleashed]', '[spec-reviewer]'],
    match: (subject, tag) => subject.includes(tag),
    tree: 'sdd/',
  },
  'doc-updater': {
    tags: ['[doc-updater]', '[autonomous]', '[unleashed]'],
    match: (subject, tag) => subject.startsWith(tag),
    tree: 'documentation/',
  },
};

function roundCounter(repo, lane) {
  const rule = ROUND_RULES[lane];
  if (!rule) return null;
  const raw = git(repo, ['log', '-6', `--format=${RS}%H %s`, '--name-only']);
  if (!raw.trim()) return { counted: 0, inspected: 0, action: 'continue' };
  let counted = 0;
  let inspected = 0;
  for (const record of raw.split(RS)) {
    if (!record.trim()) continue;
    inspected += 1;
    const [header, ...fileLines] = record.split('\n');
    const subject = header.slice(header.indexOf(' ') + 1).trim();
    if (BULK_PREFIXES.some((p) => subject.startsWith(p))) continue;
    if (!rule.tags.some((tag) => rule.match(subject, tag))) continue;
    if (!fileLines.some((f) => f.trim().startsWith(rule.tree))) continue;
    counted += 1;
  }
  return { counted, inspected, action: counted >= 5 ? 'stop' : 'continue' };
}

const AUDIT_LINES = [
  {
    id: 'phase-7a-evidence-missing',
    label: 'Phase 7a anchor verifier line',
    severity: 'CRITICAL',
    onlyFor: ['[sdd-init]'],
    re: /^[\s>*`-]*Phase 7a verifier: parsed=\d+ resolved=\d+ orphaned=\d+ drifted=\d+/m,
  },
  {
    id: 'phase-7b-evidence-missing',
    label: 'Phase 7b enum verifier line',
    severity: 'CRITICAL',
    onlyFor: ['[sdd-init]'],
    re: /^[\s>*`-]*Phase 7b enum verifier: enumerated=\d+ accounted=\d+ unaccounted=\d+/m,
  },
  {
    id: 'enforcement-skill-not-invoked',
    label: 'spec-enforce audit line',
    severity: 'HIGH',
    onlyFor: ['[sdd-init]', '[sdd-clean]'],
    re: /^[\s>*`-]*spec-enforce: ran \([^)]*anchors verified[^)]*\)/m,
  },
  {
    id: 'enforcement-skill-not-invoked',
    label: 'doc-enforce audit line',
    severity: 'HIGH',
    onlyFor: ['[sdd-init]', '[sdd-clean]'],
    re: /^[\s>*`-]*doc-enforce: ran \([^)]*anchors verified[^)]*\)/m,
  },
];

function bulkOpAudit(repo) {
  const raw = git(repo, ['log', '-5', `--format=${RS}%H%n%s%n%b`]);
  const findings = [];
  let checked = 0;
  for (const record of raw.split(RS)) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    const sha = lines[0].trim();
    const subject = (lines[1] ?? '').trim();
    const prefix = ['[sdd-init]', '[sdd-clean]'].find((p) => subject.startsWith(p));
    if (!prefix) continue;
    checked += 1;
    const body = lines.slice(2).join('\n');
    for (const line of AUDIT_LINES) {
      if (!line.onlyFor.includes(prefix)) continue;
      if (!line.re.test(body)) {
        findings.push({ sha, subject, id: line.id, severity: line.severity, missing: line.label });
      }
    }
    // The Phase 7b line is load-bearing beyond mere presence: unaccounted > 0
    // without a justification block means the import narrowed its own scope.
    const enumMatch = body.match(/^[\s>*`-]*Phase 7b enum verifier:.*unaccounted=(\d+)/m);
    if (enumMatch && Number(enumMatch[1]) > 0 && !/justif/i.test(body)) {
      findings.push({
        sha, subject, id: 'import-mode-narrowed-scope', severity: 'CRITICAL',
        missing: `unaccounted=${enumMatch[1]} with no justification block`,
      });
    }
  }
  return { checked, findings };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo || process.cwd();
  const lane = args.lane || '';
  const paths = resolveLayout(repo);

  const out = { lane, range: args.range || null, sdd: paths, decision: 'proceed', reason: null };

  if (!paths.bootstrapped) {
    // Only spec and doc lanes are SDD-gated; the code lane reviews source in a
    // repo with no sdd/ at all.
    if (lane === 'spec-reviewer' || lane === 'doc-updater') {
      out.decision = 'exit-no-op';
      out.reason = 'no SDD bootstrap (sdd/ or sdd/README.md absent)';
      return out;
    }
    return out;
  }

  out.config = readConfig(repo, paths.configPath);
  out.transition = transitionState(repo, paths, out.config);
  if (out.transition.active) {
    out.decision = 'exit-no-op';
    out.reason = 'SDD transition in progress; review suspended until triage drains';
    return out;
  }

  const round = roundCounter(repo, lane);
  if (round) {
    out.roundLimit = round;
    if (round.action === 'stop') {
      out.decision = 'exit-no-op';
      out.reason = `round limit reached (${round.counted} of the last ${round.inspected} commits counted for this lane)`;
      return out;
    }
  }

  out.bulkOpAudit = bulkOpAudit(repo);
  if (args['required-lanes'] !== undefined) {
    out.requiredLanes = args['required-lanes'].trim().split(/\s+/).filter(Boolean);
  }
  return out;
}

try {
  process.stdout.write(`${JSON.stringify(main(), null, 1)}\n`);
} catch (error) {
  // Never let a triage crash skip a review: emit the fail-safe decision.
  process.stdout.write(`${JSON.stringify({
    decision: 'proceed',
    reason: `triage failed (${error instanceof Error ? error.message : String(error)}); defaulting to a full review`,
  })}\n`);
}
