// The inert-delta prover decides whether a source change is comments and
// whitespace only. It is allowed to be wrong in exactly one direction: it may
// fail to prove an inert delta, never claim an active one is inert. These tests
// pin the projection rules that carry that proof.
//
// Line classification cannot do this job: a line reading `// x` may be text
// inside a template literal. The file that motivated the check has both real
// template literals and a block comment containing backticks, so the scanner
// has to carry lexical state. That is what is asserted here.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { project } from '../../preseed/agents/claude/skills/review-scope/scripts/inert-source-delta.mjs';

const PROVER = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../preseed/agents/claude/skills/review-scope/scripts/inert-source-delta.mjs',
);

function repoWithCommentEdit() {
  const cwd = mkdtempSync(join(tmpdir(), 'inert-proof-'));
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' }).stdout.trim();
  git('init', '-q');
  git('config', 'user.email', 'test@test');
  git('config', 'user.name', 'Test');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1; // old\n');
  git('add', '-A'); git('commit', '-q', '-m', 'seed');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1; // new\n');
  git('add', '-A'); git('commit', '-q', '-m', 'reword');
  return { cwd, base, head: git('rev-parse', 'HEAD') };
}

function runProver(entry, cwd, base, head) {
  return spawnSync(process.execPath, [entry, base, head], {
    cwd,
    input: 'src/a.ts\0',
    encoding: 'utf8',
  });
}

describe('inert-source-delta project()', () => {
  it('projects a comment-only edit to an identical form', () => {
    assert.equal(project('const a = 1; // old\n'), project('const a = 1; // new\n'));
  });

  it('projects a whitespace-only edit to an identical form', () => {
    assert.equal(
      project('const a = 1;\nconst b = 2;\n'),
      project('const   a = 1;\n\n\nconst b   = 2;\n'),
    );
  });

  it('projects a reworded block comment to an identical form', () => {
    assert.equal(project('/* old */\nconst a=1;\n'), project('/* new text */\nconst a=1;\n'));
  });

  it('separates a comment edit that also changes one code token', () => {
    assert.notEqual(project('const a = 1; // x\n'), project('const a = 2; // y\n'));
  });

  it('treats a comment marker inside a template literal as content', () => {
    // The unsoundness that rules out line-prefix matching.
    assert.notEqual(project('const s = `\n// keep\n`;\n'), project('const s = `\n// changed\n`;\n'));
  });

  it('preserves whitespace inside a string literal', () => {
    assert.notEqual(project('x("a  b");\n'), project('x("a b");\n'));
  });

  it('does not desync on a backtick inside a block comment', () => {
    assert.equal(project('/* ` */\nconst a=1;\n'), project('/* ` other */\nconst a=1;\n'));
  });

  it('treats a template substitution as code', () => {
    assert.notEqual(project('const s = `${a+1}`;\n'), project('const s = `${a+2}`;\n'));
  });

  it('keeps a multi-line block comment as a line break', () => {
    // JS treats a multi-line comment as a line terminator for automatic
    // semicolon insertion, so collapsing it to a space would change meaning.
    assert.notEqual(project('a /*\n*/ b'), project('a b'));
  });

  it('refuses to decide a possible regex literal', () => {
    assert.throws(() => project('const r = /a+/;\n'));
  });

  it('refuses to decide JSX', () => {
    assert.throws(() => project('const x = <a/>;\n'));
  });

  it('refuses to decide an unterminated template literal', () => {
    assert.throws(() => project('const s = `abc;\n'));
  });

  it('refuses to decide a blob containing a NUL byte', () => {
    assert.throws(() => project('const a=1;\0\n'));
  });
});

describe('inert-source-delta proof token', () => {
  // A zero exit alone used to mean "inert", so every path that ended without
  // deciding read as a proof. Proof is positive now: callers require the token.
  it('emits the token only when the delta is actually proven', () => {
    const { cwd, base, head } = repoWithCommentEdit();
    const proven = runProver(PROVER, cwd, base, head);
    assert.equal(proven.status, 0);
    assert.equal(proven.stdout.trim(), 'INERT');

    // Same repo, a range whose base equals its head has nothing to prove.
    const empty = runProver(PROVER, cwd, head, head);
    assert.notEqual(empty.status, 0);
    assert.equal(empty.stdout.trim(), '');
  });

  it('still decides when invoked through a symlink', () => {
    // Node resolves symlinks for import.meta.url but not for process.argv[1],
    // so the entry guard compared two different paths, main() never ran, and
    // the process exited 0 having proven nothing -- dropping two review lanes
    // on a fully behavioural diff, silently.
    const { cwd, base, head } = repoWithCommentEdit();
    const linkDir = mkdtempSync(join(tmpdir(), 'inert-link-'));
    const link = join(linkDir, 'prover.mjs');
    symlinkSync(PROVER, link);
    const viaLink = runProver(link, cwd, base, head);
    assert.equal(viaLink.status, 0);
    assert.equal(viaLink.stdout.trim(), 'INERT',
      'a symlinked install must decide, not exit zero having decided nothing');
  });
});
