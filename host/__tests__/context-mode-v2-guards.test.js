import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const hook = fileURLToPath(new URL('../../preseed/agents/claude/plugins/codeflare-hooks/scripts/block-local-builds.sh', import.meta.url));
function decision(tool, input) {
  const result = spawnSync('bash', [hook], {
    input: JSON.stringify({ tool_name: `mcp__context-mode__${tool}`, tool_input: input }),
    encoding: 'utf8',
    env: { ...process.env, LOCAL_BUILD_BYPASS_FILE: `/tmp/context-mode-unused-${randomUUID()}` },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : undefined;
}

describe('REQ-AGENT-052: local-build guard preserves context-mode v2 coverage', () => {
  for (const language of ['shell', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']) {
    it(`blocks test execution through ctx_execute ${language}`, () => {
      assert.equal(decision('ctx_execute', { language, code: 'npm test' })?.decision, 'block');
    });
  }
  it('blocks a build inside a v2 string command batch', () => {
    assert.equal(decision('ctx_batch', { commands: ['git status', 'npm run build'], queries: ['build'] })?.decision, 'block');
  });
  it('permits read-only batches and inert non-shell code', () => {
    assert.equal(decision('ctx_batch', { commands: ['git status'], queries: ['status'] }), undefined);
    assert.equal(decision('ctx_execute', { language: 'javascript', code: 'console.log("npm test")' }), undefined);
  });
});


describe('REQ-AGENT-052 AC4: Claude analyzer canonical containment', () => {
  it('refuses absolute, parent and symlink escapes while preserving legitimate argv and actual cwd', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'analyzer-containment-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'repo with spaces');
    mkdirSync(join(repo, 'sub'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    writeFileSync(join(repo, 'valid.js'), 'valid');
    writeFileSync(join(root, 'outside/a.js'), 'outside');
    symlinkSync(join(root, 'outside'), join(repo, 'link'));
    symlinkSync(join(root, 'outside'), join(repo, '-link'));
    symlinkSync(join(root, 'outside'), join(repo, 'link space'));
    execFileSync('git', ['init', '-q', repo]);
    const wrapper = 'node /home/user/.claude/skills/safe-local-checks/scripts/safe-local-check.mjs';
    for (const [args, allowed] of [[`"${root}/outside/a.js"`, false], ['../../outside/a.js', false], ['~/outside.js', false], ['../link/a.js', false],
      ['--config ../link/a.js', false], [`-c${root}/outside/a.js`, false], ['-- ../-link/a.js', false],
      ['../link\\ space/a.js', false], ['../valid.js', true], [`"${repo}/valid.js"`, true]]) {
      const result = spawnSync('bash', [hook], {
        cwd: root, input: JSON.stringify({ tool_name: 'Bash', cwd: join(repo, 'sub'), tool_input: { command: `${wrapper} oxlint ${args}` } }),
        encoding: 'utf8', env: { ...process.env, LOCAL_BUILD_BYPASS_FILE: join(root, 'absent') },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim() ? JSON.parse(result.stdout).decision : undefined, allowed ? undefined : 'block', args);
    }
    mkdirSync(join(repo, 'node'));
    const cdResult = spawnSync('bash', [hook], {
      cwd: root, input: JSON.stringify({ tool_name: 'Bash', cwd: repo,
        tool_input: { command: `cd node && ${wrapper} oxlint "${root}/outside/a.js"` } }),
      encoding: 'utf8', env: { ...process.env, LOCAL_BUILD_BYPASS_FILE: join(root, 'absent') },
    });
    assert.equal(cdResult.status, 0, cdResult.stderr);
    assert.equal(JSON.parse(cdResult.stdout).decision, 'block');
  });
});
