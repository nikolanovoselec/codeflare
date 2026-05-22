// Verifies REQ-AGENT-027 AC1: when the context-mode plugin is preseeded
// (custom tier + advanced session mode), `graphify` is in the
// enforce-ctx-mode.sh Bash whitelist so `graphify update .` is not denied.
//
// Two layers of verification:
//  1. String-level: the whitelist comment header lists `graphify`, and a
//     case-branch handles `graphify`.
//  2. Behavioural: run enforce-ctx-mode.sh as a PreToolUse hook against a
//     Bash tool_input that runs `graphify update .` and assert exit 0.
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/context-mode/scripts/enforce-ctx-mode.sh'
);
const hookText = readFileSync(HOOK, 'utf8');

function runHook(toolInput) {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify({
      session_id: 'test-' + Math.random().toString(36).slice(2, 10),
      tool_name: 'Bash',
      tool_input: toolInput,
    }),
    encoding: 'utf-8',
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('enforce-ctx-mode.sh graphify whitelist (REQ-AGENT-027)', () => {
  it('whitelist comment header lists `graphify`', () => {
    assert.ok(
      /Bash whitelist:[^\n]*graphify/.test(hookText),
      'header comment must enumerate graphify in the whitelist (drift signal)'
    );
  });

  it('there is a `graphify)` case branch in the whitelist switch', () => {
    assert.ok(
      /\n\s*graphify\)/.test(hookText),
      'enforce-ctx-mode.sh must have a `graphify)` branch in its first-word whitelist case'
    );
  });

  it('`graphify update .` is allowed (exit 0, no deny output)', () => {
    const { status, stdout } = runHook({ command: 'graphify update .' });
    assert.equal(status, 0, '`graphify update .` must not be denied (exit 0)');
    assert.ok(
      !/violates/.test(stdout) && !/deny/i.test(stdout),
      `expected no deny payload; got stdout=${stdout}`
    );
  });

  it('`graphify query "..."` is allowed', () => {
    const { status, stdout } = runHook({ command: 'graphify query "auth flow"' });
    assert.equal(status, 0);
    assert.ok(!/violates/.test(stdout));
  });

  it('unrelated unwhitelisted commands are still denied (negative control)', () => {
    // Sanity-check that the whitelist isn't accidentally pass-through.
    const { stdout } = runHook({ command: 'cat /etc/passwd' });
    assert.ok(
      /violates/.test(stdout) || /deny/i.test(stdout),
      'negative control: `cat` must still be denied so we know the whitelist is enforced'
    );
  });
});
