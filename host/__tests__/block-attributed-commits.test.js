// Real behavioral tests for the SDD PreToolUse attribution hook.
//
// Tests spawn the actual bash script with stdin input shaped like Claude
// Code's hook payload, and assert on exit code + stdout (which carries
// the deny decision when attribution is detected).
//
// The hook is registered on three matchers (see entrypoint.sh
// SETTINGS_CONFIG): Bash, mcp__context-mode__ctx_execute, and
// mcp__context-mode__ctx_batch_execute. Each matcher feeds a different
// tool_input shape; the script's 3-shape jq pattern collapses them to a
// single COMMAND string before the attribution scan. These tests pin
// the multi-shape behavior so a future regression silently re-opens the
// MCP-side bypass discovered alongside issue #319.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-hooks/scripts/block-attributed-commits.sh',
);

function runHook(payload) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
  });
}

const ATTRIBUTED_MESSAGE =
  'fix(thing): patch\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>';

const CLEAN_MESSAGE = 'fix(thing): patch the thing';

// ---------------------------------------------------------------------------
// Bash tool — pre-existing behavior, pinned as regression baseline
// ---------------------------------------------------------------------------

describe('block-attributed-commits.sh — Bash tool', () => {
  it('denies git commit with Co-Authored-By line', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: `git commit -m "${ATTRIBUTED_MESSAGE}"` },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision"\s*:\s*"deny"/);
    assert.match(r.stdout, /Attribution detected/);
  });

  it('allows git commit with a clean message', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: `git commit -m "${CLEAN_MESSAGE}"` },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('allows non-commit/non-attribution git commands (git status)', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('denies gh pr create --body containing AI attribution', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: {
        command:
          'gh pr create --title "feat: x" --body "summary\n\nGenerated with Claude Code"',
      },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision"\s*:\s*"deny"/);
  });
});

// ---------------------------------------------------------------------------
// ctx_execute — MCP shell tool. Companion bug-class to issue #319.
// ---------------------------------------------------------------------------

describe('block-attributed-commits.sh — ctx_execute (language=shell)', () => {
  it('denies git commit with attribution made via ctx_execute', () => {
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: {
        language: 'shell',
        code: `git commit -m "${ATTRIBUTED_MESSAGE}"`,
      },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision"\s*:\s*"deny"/,
      'ctx_execute shell git commit with attribution must be denied — same contract as Bash');
  });

  it('allows clean git commit made via ctx_execute', () => {
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: {
        language: 'shell',
        code: `git commit -m "${CLEAN_MESSAGE}"`,
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('denies gh pr create --body with attribution via ctx_execute', () => {
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: {
        language: 'shell',
        code:
          'gh pr create --title "feat" --body "x\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"',
      },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision"\s*:\s*"deny"/);
  });

  it('exits silently when ctx_execute language is not shell', () => {
    // Defense in depth: even though the matcher fires on every
    // ctx_execute call, the jq language gate ensures non-shell
    // payloads (javascript, python) cannot trigger the regex.
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: {
        language: 'javascript',
        code: 'console.log("git commit -m Co-Authored-By: Claude")',
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'non-shell ctx_execute must not be scanned for attribution');
  });

  it('exits silently for non-git/non-gh shell code', () => {
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: {
        language: 'shell',
        code: 'ls -la && cat README.md',
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

// ---------------------------------------------------------------------------
// ctx_batch_execute — MCP batch shell tool
// ---------------------------------------------------------------------------

describe('block-attributed-commits.sh — ctx_batch_execute', () => {
  it('denies when any command entry has attribution', () => {
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_batch_execute',
      tool_input: {
        commands: [
          { label: 'status', command: 'git status' },
          { label: 'commit', command: `git commit -m "${ATTRIBUTED_MESSAGE}"` },
        ],
        queries: ['noop'],
      },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision"\s*:\s*"deny"/,
      'ctx_batch_execute with any attributed entry must be denied');
  });

  it('allows a batch of clean commands', () => {
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_batch_execute',
      tool_input: {
        commands: [
          { label: 'status', command: 'git status' },
          { label: 'commit', command: `git commit -m "${CLEAN_MESSAGE}"` },
        ],
        queries: ['noop'],
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('denies when ctx_batch_execute contains gh pr edit with Co-Authored-By in body', () => {
    const r = runHook({
      tool_name: 'mcp__context-mode__ctx_batch_execute',
      tool_input: {
        commands: [
          {
            label: 'edit',
            command:
              'gh pr edit 123 --body "summary\n\nCo-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"',
          },
        ],
        queries: ['noop'],
      },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /"permissionDecision"\s*:\s*"deny"/);
  });
});

// ---------------------------------------------------------------------------
// Tool-name gating
// ---------------------------------------------------------------------------

describe('block-attributed-commits.sh — unrelated tools exit 0', () => {
  it('exits silently for Read tool', () => {
    const r = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/anything' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('exits silently for Write tool even if content looks like attribution', () => {
    const r = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: '/tmp/x',
        content: 'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>',
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
