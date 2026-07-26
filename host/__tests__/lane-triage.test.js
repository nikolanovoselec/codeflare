// Behavioral tests for the deterministic Phase 0 triage.
//
// This script decides whether a review lane runs at all, and it reproduces
// enforcement rules (round limit, bulk-op audit) that used to live in reviewer
// prose. A regression here does not fail loudly -- it silently stops a gate
// from firing. So every test asserts a decision or a named finding, never a
// message template.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRIAGE = join(
  HERE,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-triage.mjs',
);

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' });
}

function repo({ sdd = true, nested = true, config = 'mode: interactive\n' } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'triage-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@test');
  git(cwd, 'config', 'user.name', 'Test');
  if (sdd) {
    const base = nested ? 'sdd/spec' : 'sdd';
    mkdirSync(join(cwd, base), { recursive: true });
    writeFileSync(join(cwd, 'sdd/README.md'), '# fixture\n');
    if (config !== null) writeFileSync(join(cwd, `${base}/config.yml`), config);
  }
  writeFileSync(join(cwd, 'seed.txt'), 'seed\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', 'init');
  return cwd;
}

// Commit with an explicit body, so the bulk-op audit has something to inspect.
function commit(cwd, path, body, subject, commitBody) {
  mkdirSync(join(cwd, dirname(path)), { recursive: true });
  writeFileSync(join(cwd, path), body);
  git(cwd, 'add', '-A');
  const args = ['commit', '-q', '-m', subject];
  if (commitBody) args.push('-m', commitBody);
  git(cwd, ...args);
}

function triage(cwd, lane, extra = []) {
  const r = spawnSync('node', [TRIAGE, '--repo', cwd, '--lane', lane, ...extra], {
    encoding: 'utf-8',
  });
  return JSON.parse(r.stdout);
}

describe('lane-triage.mjs — bootstrap and layout', () => {
  it('resolves nested layout paths when sdd/spec exists', () => {
    const cwd = repo({ nested: true });
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.sdd.layout, 'nested');
    assert.equal(t.sdd.configPath, 'sdd/spec/config.yml');
    assert.equal(t.sdd.triageFile, 'sdd/spec/.review-queue.md');
  });

  it('resolves flat layout paths when sdd/spec is absent', () => {
    const cwd = repo({ nested: false });
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.sdd.layout, 'flat');
    assert.equal(t.sdd.configPath, 'sdd/config.yml');
    assert.equal(t.sdd.triageFile, 'sdd/.review-needed.md');
  });

  it('no-ops the SDD-gated lanes but not the code lane when sdd/ is absent', () => {
    const cwd = repo({ sdd: false });
    assert.equal(triage(cwd, 'spec-reviewer').decision, 'exit-no-op');
    assert.equal(triage(cwd, 'doc-updater').decision, 'exit-no-op');
    assert.equal(triage(cwd, 'code-reviewer').decision, 'proceed',
      'the code lane reviews source in a repo with no sdd/ at all');
  });

  it('hands the config over verbatim so the lane never re-reads it', () => {
    const cwd = repo({ config: 'mode: interactive\nenforce_tdd: true\nchangelog_entry_style: verbose\n' });
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.config.enforce_tdd, true);
    assert.equal(t.config.changelog_entry_style, 'verbose');
    assert.match(t.config.raw, /^mode: interactive$/m,
      'config.raw must carry the literal file, not a reserialised parse');
  });
});

describe('lane-triage.mjs — transition gate', () => {
  it('suspends the lane when transition is true and an item is open', () => {
    const cwd = repo({ config: 'mode: interactive\ntransition: true\n' });
    writeFileSync(join(cwd, 'sdd/spec/.init-triage.md'), '**Status:** open\n');
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.decision, 'exit-no-op');
    assert.equal(t.transition.active, true);
  });

  it('treats transition true with no open item as corrupt and still reviews', () => {
    const cwd = repo({ config: 'mode: interactive\ntransition: true\n' });
    writeFileSync(join(cwd, 'sdd/spec/.init-triage.md'), '**Status:** resolved\n');
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.decision, 'proceed', 'a corrupt transition must not skip the review');
    assert.equal(t.transition.corrupt, true);
  });

  it('treats transition true with a missing triage file as corrupt, not suspended', () => {
    const cwd = repo({ config: 'mode: interactive\ntransition: true\n' });
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.decision, 'proceed');
    assert.equal(t.transition.corrupt, true);
  });
});

describe('lane-triage.mjs — round counter', () => {
  it('stops the spec lane at 5 counted commits touching sdd/', () => {
    const cwd = repo();
    for (let i = 0; i < 5; i += 1) {
      commit(cwd, `sdd/spec/f${i}.md`, `${i}\n`, `[autonomous] spec change ${i}`);
    }
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.roundLimit.counted, 5);
    assert.equal(t.decision, 'exit-no-op');
  });

  it('does not count a commit that touched only another lane tree', () => {
    const cwd = repo();
    for (let i = 0; i < 5; i += 1) {
      commit(cwd, `sdd/spec/f${i}.md`, `${i}\n`, `[autonomous] spec change ${i}`);
    }
    // Same history: the doc lane counts documentation/ touches, and there are none.
    const t = triage(cwd, 'doc-updater');
    assert.equal(t.roundLimit.counted, 0);
    assert.equal(t.decision, 'proceed');
  });

  it('excludes the bulk-op prefixes from the counter regardless of paths', () => {
    const cwd = repo();
    for (let i = 0; i < 5; i += 1) {
      commit(cwd, `sdd/spec/f${i}.md`, `${i}\n`, `[sdd-clean] bulk pass ${i}`);
    }
    const t = triage(cwd, 'spec-reviewer');
    assert.equal(t.roundLimit.counted, 0);
    assert.equal(t.decision, 'proceed');
  });

  it('resets below the limit when a plain user commit lands', () => {
    const cwd = repo();
    for (let i = 0; i < 4; i += 1) {
      commit(cwd, `sdd/spec/f${i}.md`, `${i}\n`, `[autonomous] spec change ${i}`);
    }
    commit(cwd, 'sdd/spec/user.md', 'u\n', 'spec: a normal user-directed change');
    const t = triage(cwd, 'spec-reviewer');
    assert.ok(t.roundLimit.counted < 5, `expected under the limit, got ${t.roundLimit.counted}`);
    assert.equal(t.decision, 'proceed');
  });

  it('honours the doc lane starts-with rule rather than the spec contains rule', () => {
    const cwd = repo();
    // A subject that CONTAINS but does not START WITH the tag: counts for spec,
    // not for doc. Collapsing the two rules would change when a limit fires.
    for (let i = 0; i < 5; i += 1) {
      commit(cwd, `documentation/d${i}.md`, `${i}\n`, `chore: rollup [autonomous] ${i}`);
    }
    assert.equal(triage(cwd, 'doc-updater').roundLimit.counted, 0);
  });
});

describe('lane-triage.mjs — bulk-op audit', () => {
  const FULL_BODY = [
    'Phase 7a verifier: parsed=10 resolved=10 orphaned=0 drifted=0',
    'Phase 7b enum verifier: enumerated=10 accounted=10 unaccounted=0',
    'spec-enforce: ran (23 rows, 0 findings, anchors verified)',
    'doc-enforce: ran (16 rows, 0 findings, anchors verified)',
  ].join('\n');

  it('reports nothing when an sdd-init commit carries all four audit lines', () => {
    const cwd = repo();
    commit(cwd, 'sdd/spec/x.md', 'x\n', '[sdd-init] bootstrap', FULL_BODY);
    assert.deepEqual(triage(cwd, 'spec-reviewer').bulkOpAudit.findings, []);
  });

  it('flags every missing audit line on an sdd-init commit', () => {
    const cwd = repo();
    commit(cwd, 'sdd/spec/x.md', 'x\n', '[sdd-init] bootstrap');
    const ids = triage(cwd, 'spec-reviewer').bulkOpAudit.findings.map((f) => f.id);
    assert.ok(ids.includes('phase-7a-evidence-missing'));
    assert.ok(ids.includes('phase-7b-evidence-missing'));
    assert.ok(ids.includes('enforcement-skill-not-invoked'));
  });

  it('does not demand Phase 7a/7b of an sdd-clean commit', () => {
    const cwd = repo();
    commit(cwd, 'sdd/spec/x.md', 'x\n', '[sdd-clean] pass', [
      'spec-enforce: ran (23 rows, 0 findings, anchors verified)',
      'doc-enforce: ran (16 rows, 0 findings, anchors verified)',
    ].join('\n'));
    const ids = triage(cwd, 'spec-reviewer').bulkOpAudit.findings.map((f) => f.id);
    assert.ok(!ids.includes('phase-7a-evidence-missing'),
      'sdd-clean does not run Phase 7a, so demanding its line would be a false positive');
    assert.ok(!ids.includes('phase-7b-evidence-missing'));
  });

  it('rejects an enforce line missing the load-bearing anchors-verified token', () => {
    const cwd = repo();
    commit(cwd, 'sdd/spec/x.md', 'x\n', '[sdd-clean] pass', [
      'spec-enforce: ran (23 rows, 0 findings)',
      'doc-enforce: ran (16 rows, 0 findings, anchors verified)',
    ].join('\n'));
    const ids = triage(cwd, 'spec-reviewer').bulkOpAudit.findings.map((f) => f.id);
    assert.ok(ids.includes('enforcement-skill-not-invoked'),
      'presence alone is not proof; the anchors-verified token is what proves CQ-SOURCE ran');
  });

  it('escalates unaccounted>0 with no justification to narrowed scope', () => {
    const cwd = repo();
    commit(cwd, 'sdd/spec/x.md', 'x\n', '[sdd-init] bootstrap', [
      'Phase 7a verifier: parsed=10 resolved=10 orphaned=0 drifted=0',
      'Phase 7b enum verifier: enumerated=10 accounted=7 unaccounted=3',
      'spec-enforce: ran (23 rows, 0 findings, anchors verified)',
      'doc-enforce: ran (16 rows, 0 findings, anchors verified)',
    ].join('\n'));
    const f = triage(cwd, 'spec-reviewer').bulkOpAudit.findings
      .find((x) => x.id === 'import-mode-narrowed-scope');
    assert.ok(f, 'unaccounted work with no justification narrows the import silently');
    assert.equal(f.severity, 'CRITICAL');
  });

  it('accepts unaccounted>0 when the body justifies it', () => {
    const cwd = repo();
    commit(cwd, 'sdd/spec/x.md', 'x\n', '[sdd-init] bootstrap', [
      'Phase 7a verifier: parsed=10 resolved=10 orphaned=0 drifted=0',
      'Phase 7b enum verifier: enumerated=10 accounted=7 unaccounted=3',
      'spec-enforce: ran (23 rows, 0 findings, anchors verified)',
      'doc-enforce: ran (16 rows, 0 findings, anchors verified)',
      'Justification: the three unaccounted files are vendored fixtures.',
    ].join('\n'));
    const ids = triage(cwd, 'spec-reviewer').bulkOpAudit.findings.map((f) => f.id);
    assert.ok(!ids.includes('import-mode-narrowed-scope'));
  });

  it('parses a commit body containing blank lines as one record', () => {
    const cwd = repo();
    commit(cwd, 'sdd/spec/x.md', 'x\n', '[sdd-init] bootstrap',
      `Preamble paragraph.\n\n${FULL_BODY}\n\nTrailing paragraph.`);
    assert.deepEqual(triage(cwd, 'spec-reviewer').bulkOpAudit.findings, [],
      'newline-delimited parsing would split this commit and lose its audit lines');
  });
});

describe('lane-triage.mjs — fail-safe direction', () => {
  it('proceeds rather than skipping when the repo path is not a git repo', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'triage-nogit-'));
    mkdirSync(join(cwd, 'sdd/spec'), { recursive: true });
    writeFileSync(join(cwd, 'sdd/README.md'), '# f\n');
    writeFileSync(join(cwd, 'sdd/spec/config.yml'), 'mode: interactive\n');
    assert.equal(triage(cwd, 'spec-reviewer').decision, 'proceed');
  });

  it('proceeds when the config is absent entirely', () => {
    const cwd = repo({ config: null });
    assert.equal(triage(cwd, 'spec-reviewer').decision, 'proceed');
  });

  it('carries the classifier lane list through rather than recomputing it', () => {
    const cwd = repo();
    const t = triage(cwd, 'spec-reviewer', ['--required-lanes', 'code-reviewer spec-reviewer']);
    assert.deepEqual(t.requiredLanes, ['code-reviewer', 'spec-reviewer']);
  });
});
