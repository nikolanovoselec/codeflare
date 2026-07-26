// Behavioural tests for the review-lane evidence resolver.
//
// The contract under test is narrow and load-bearing: every answer this emits
// is one a lane would otherwise spend a turn obtaining, and a turn re-sends the
// whole prompt. So the tests assert resolution OUTCOMES against real files in
// real git repos -- an anchor that points at a renamed symbol must come back
// unresolved, a reference that resolves must not be reported as a failure --
// rather than that some JSON was produced.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/lib/lane-evidence.mjs',
);

function git(cwd, ...args) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8' }).stdout.trim();
}

function write(cwd, relative, body) {
  mkdirSync(dirname(join(cwd, relative)), { recursive: true });
  writeFileSync(join(cwd, relative), body);
}

function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'lane-evidence-'));
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.email', 'test@test');
  git(cwd, 'config', 'user.name', 'Test');
  write(cwd, 'README.md', '# fixture\n');
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', 'base');
  return { cwd, base: git(cwd, 'rev-parse', 'HEAD') };
}

function commit(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function run(cwd, lane, range) {
  const r = spawnSync('node', [SCRIPT, '--repo', cwd, '--lane', lane, ...(range ? ['--range', range] : [])], {
    cwd,
    encoding: 'utf-8',
  });
  return JSON.parse(r.stdout);
}

describe('lane-evidence.mjs — anchor resolution', () => {
  // The whole point of a `::symbol` anchor is that the path existing is not
  // enough. A lane discovers that one turn at a time; this is the same answer,
  // handed over.
  it('reports an anchor whose symbol no longer exists as unresolved', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/thing.js', 'function stillHere() {}\n');
    write(cwd, 'sdd/spec/agents.md', [
      '1. Present. <!-- @impl: src/thing.js::stillHere -->',
      '2. Renamed away. <!-- @impl: src/thing.js::wasRenamed -->',
      '3. File gone. <!-- @impl: src/deleted.js::anything -->',
    ].join('\n'));
    const head = commit(cwd, 'feat: anchors');

    const out = run(cwd, 'spec-reviewer', `${base}..${head}`);

    assert.equal(out.anchors.checked, 3);
    const broken = out.anchors.unresolved.map((row) => row.symbol).sort();
    assert.deepEqual(broken, ['anything', 'wasRenamed'],
      'a present path with a renamed symbol is exactly the drift these anchors exist for');
  });

  // Resolved rows are a count, not a list: emitting them in full is what made
  // this block 156 KB on a tree with 683 anchors, carried on every single turn.
  it('summarises the passes and enumerates only the failures', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/thing.js', 'function a() {}\nfunction b() {}\n');
    write(cwd, 'sdd/spec/agents.md', [
      '1. <!-- @impl: src/thing.js::a -->',
      '2. <!-- @impl: src/thing.js::b -->',
    ].join('\n'));
    const head = commit(cwd, 'feat: all resolve');

    const out = run(cwd, 'spec-reviewer', `${base}..${head}`);

    assert.equal(out.anchors.checked, 2);
    assert.deepEqual(out.anchors.unresolved, [],
      'a clean pass is a count; the lane may report it without re-running it');
  });
});

describe('lane-evidence.mjs — documentation references', () => {
  it('separates a reference that resolves from one that does not', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/real.ts', 'export const realSymbol = 1;\n');
    write(cwd, 'documentation/architecture.md',
      'Handled by `src/real.ts`, using `realSymbol`, formerly `deletedSymbol`.\n');
    const head = commit(cwd, 'docs: page');

    const out = run(cwd, 'doc-updater', `${base}..${head}`);

    const unresolved = out.references.unresolved.map((row) => row.ref);
    assert.ok(out.references.checked >= 3, 'every checkable reference must be answered');
    assert.deepEqual(unresolved, ['deletedSymbol'],
      'a reference resolving nowhere is the stale doc; the other two exist and must not be reported');
  });

  it('answers the scaffolding gate and the layout without a probe', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/README.md', '# Index\n\n- [Architecture](architecture.md)\n');
    write(cwd, 'documentation/architecture.md', '# Arch\n');
    const head = commit(cwd, 'docs: index');

    const out = run(cwd, 'doc-updater', `${base}..${head}`);

    assert.equal(out.docIndexPresent, true);
    assert.equal(out.docLayout, 'flat', 'no documentation/lanes/ directory means the flat layout');
    assert.match(out.docIndex, /\[Architecture\]/, 'the routing links are what the index is for');
  });
});

describe('lane-evidence.mjs — the decision record', () => {
  it('carries each ADR id, title and status so the record check costs no read', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'documentation/decisions/README.md', [
      '### AD001: First decision',
      '',
      '**Status:** Accepted (2026-01-01).',
      '',
      '### AD002: Rejected idea',
      '',
      '**Status:** Superseded by AD001.',
    ].join('\n'));
    const head = commit(cwd, 'docs: adrs');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);

    assert.deepEqual(out.adrs, [
      { id: 'AD001', title: 'First decision', status: 'Accepted' },
      { id: 'AD002', title: 'Rejected idea', status: 'Superseded' },
    ], 'status decides whether a finding is already settled, so it must survive the reduction');
  });
});

describe('lane-evidence.mjs — fail-safe direction', () => {
  // This resolves evidence; it never decides a review. Anything it cannot
  // answer must read as "unknown", never as "clean" -- a false clean would let
  // a check be skipped, which is the one failure mode worse than an extra turn.
  it('emits an absent field rather than a clean result when a tree is missing', () => {
    const { cwd, base } = makeRepo();
    write(cwd, 'src/thing.ts', 'export const x = 1;\n');
    const head = commit(cwd, 'feat: no docs tree at all');

    const out = run(cwd, 'code-reviewer', `${base}..${head}`);

    assert.equal(out.adrs, null,
      'no decision ledger must read as unknown, so the lane still checks; an empty list would read as "no ADRs apply"');
  });

  it('never throws a range failure into the lane', () => {
    const { cwd } = makeRepo();
    const out = run(cwd, 'spec-reviewer', 'notasha..alsonotasha');
    assert.equal(typeof out, 'object', 'an unresolvable range degrades, it does not crash the lane');
  });
});
