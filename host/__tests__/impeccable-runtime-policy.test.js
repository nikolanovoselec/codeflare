import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyCodeflareImpeccableOverlay,
  replaceImpeccableTargets,
} from '../../scripts/update-impeccable-skill.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = join(repoRoot, 'preseed/agents/claude/skills/impeccable');

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('Impeccable managed runtime policy', () => {
  it('REQ-AGENT-163: wait honors configured idle grace', () => withTempDir((cwd) => {
    const questions = join(cwd, '.impeccable', 'questions');
    mkdirSync(questions, { recursive: true });
    writeFileSync(join(questions, 'question.state.json'), JSON.stringify({
      pid: process.pid,
      lastBeat: Date.now() - 20_000,
    }));

    const result = spawnSync(process.execPath, [
      join(skillRoot, 'scripts/serve-question.mjs'),
      '--wait', '--key', 'question', '--poll', '0.2', '--idle-grace', '60',
    ], { cwd, encoding: 'utf8' });

    assert.equal(result.status, 3);
    assert.match(result.stdout, /^WAITING:/);
    assert.doesNotMatch(result.stdout, /PAGE CLOSED/);
  }));

  it('REQ-AGENT-163: wait reports closure after configured idle grace', () => withTempDir((cwd) => {
    const questions = join(cwd, '.impeccable', 'questions');
    mkdirSync(questions, { recursive: true });
    writeFileSync(join(questions, 'question.state.json'), JSON.stringify({
      pid: process.pid,
      lastBeat: Date.now() - 70_000,
    }));

    const result = spawnSync(process.execPath, [
      join(skillRoot, 'scripts/serve-question.mjs'),
      '--wait', '--key', 'question', '--poll', '0.2', '--idle-grace', '60',
    ], { cwd, encoding: 'utf8' });

    assert.equal(result.status, 4);
    assert.match(result.stdout, /^PAGE CLOSED:/);
  }));

  it('REQ-AGENT-181: updater overlay fails before mutating a partial source', () => withTempDir((source) => {
    cpSync(skillRoot, source, { recursive: true });
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'reference/audit.md'), 'incomplete upstream file\n');

    assert.throws(
      () => applyCodeflareImpeccableOverlay(source, { allowAlreadyApplied: true }),
      /audit/i,
    );
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: updater rejects a missing deletion anchor before mutation', () => withTempDir((source) => {
    cpSync(skillRoot, source, { recursive: true });
    const auditPath = join(source, 'reference/audit.md');
    const before = readFileSync(auditPath, 'utf8');

    assert.throws(() => applyCodeflareImpeccableOverlay(source), /SKILL\.md/);
    assert.equal(readFileSync(auditPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: malformed routing metadata leaves targets unchanged', () => withTempDir((root) => {
    const target = join(root, 'target');
    mkdirSync(target);
    const sentinel = join(target, 'sentinel.txt');
    writeFileSync(sentinel, 'preserve me\n');

    assert.throws(
      () => replaceImpeccableTargets(join(root, 'source'), 'malformed skill\n', [{
        agent: 'claude',
        root: target,
        runtimePath: '~/.claude/skills/impeccable',
      }]),
      /frontmatter/i,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me\n');
  }));
});
