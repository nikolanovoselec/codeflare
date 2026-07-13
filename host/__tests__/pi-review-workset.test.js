import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { buildReviewPacket } from '../../preseed/agents/pi/skills/review-scope/scripts/build-review-packet.mjs';

function git(repo, ...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, relativePath, content) {
  const target = join(repo, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'pi-review-workset-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@users.noreply.github.com');
  write(repo, 'src/value.ts', 'export const value = 1;\n');
  write(repo, 'sdd/spec/value.md', '# Value\n');
  write(repo, 'documentation/lanes/value.md', '# Value\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  write(repo, 'src/value.ts', 'export const value = 2;\n');
  write(repo, 'sdd/spec/value.md', '# Value\n\nChanged.\n');
  write(repo, 'documentation/lanes/value.md', '# Value\n\nChanged.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'change');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

test('REQ-AGENT-059 AC6: diff packets contain only lane-owned changed hunks', () => {
  const { repo, base, head } = fixture();
  try {
    const range = `${base}..${head}`;
    const code = buildReviewPacket({ repo, scope: 'diff', range, lane: 'code-reviewer' });
    const spec = buildReviewPacket({ repo, scope: 'diff', range, lane: 'spec-reviewer' });
    const docs = buildReviewPacket({ repo, scope: 'diff', range, lane: 'doc-updater' });

    assert.deepEqual(code.files, ['src/value.ts']);
    assert.match(code.patch, /src\/value\.ts/);
    assert.doesNotMatch(code.patch, /sdd\/|documentation\//);
    assert.deepEqual(spec.files, ['sdd/spec/value.md']);
    assert.deepEqual(docs.files, ['documentation/lanes/value.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('REQ-AGENT-059 AC7: all scope enumerates the lane tree while diff rejects an invalid range', () => {
  const { repo, base } = fixture();
  try {
    const all = buildReviewPacket({ repo, scope: 'all', lane: 'spec-reviewer' });
    assert.equal(all.workSet, 'whole-requested-tree');
    assert.deepEqual(all.files, ['sdd/spec/value.md']);
    assert.equal(all.patch, '');

    assert.throws(
      () => buildReviewPacket({ repo, scope: 'diff', range: `${'f'.repeat(40)}..${base}`, lane: 'code-reviewer' }),
      /valid ancestor range/,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
