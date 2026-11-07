import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
