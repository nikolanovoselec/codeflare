import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** REQ-OPERATOR-009: Phase 1 preserves observable local review packet behavior. */
describe('REQ-OPERATOR-009: unchanged canonical local-review resource', () => {
  it('retains legacy code-lane scope, changed inputs, hunks and patch evidence', async () => {
    const repo = await mkdtemp(resolve(tmpdir(), 'operator-review-packet-'));
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
      git('init');
      git('config', 'user.email', 'fixture@example.test');
      git('config', 'user.name', 'Fixture');
      await mkdir(resolve(repo, 'src'));
      await mkdir(resolve(repo, 'documentation'));
      await writeFile(resolve(repo, 'src/legacy.ts'), 'export const value = 1;\n');
      await writeFile(resolve(repo, 'documentation/guide.md'), '# Guide\n');
      git('add', '.'); git('commit', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      await writeFile(resolve(repo, 'src/legacy.ts'), 'export const value = 2;\n');
      await writeFile(resolve(repo, 'documentation/guide.md'), '# Updated guide\n');
      git('add', '.'); git('commit', '-m', 'change');
      const head = git('rev-parse', 'HEAD');
      const script = resolve(process.cwd(), 'preseed/agents/claude/skills/review-scope/scripts/build-review-packet.mjs');
      const packet = JSON.parse(execFileSync(process.execPath, [script, '--repo', repo, '--scope', 'diff',
        '--range', `${base}..${head}`, '--lane', 'code-reviewer'], { encoding: 'utf8' })) as {
          workSet: string; files: string[]; changedInputs: Array<{ path: string; hunks: unknown[] }>; patch: string;
        };
      expect(packet.workSet).toBe('changed-hunks-and-direct-invalidations');
      expect(packet.files).toEqual(['src/legacy.ts']);
      expect(packet.changedInputs).toEqual([{ path: 'documentation/guide.md', hunks: [expect.objectContaining({ newStart: 1 })] }]);
      expect(packet.patch).toContain('diff --git a/src/legacy.ts b/src/legacy.ts');
      expect(packet.patch).toContain('+export const value = 2;');
      expect(packet.patch).not.toContain('Updated guide');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
