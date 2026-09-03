import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyCodeflareImpeccableOverlay } from '../../scripts/update-impeccable-skill.mjs';

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

    assert.throws(() => applyCodeflareImpeccableOverlay(source), /audit/i);
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));
});
