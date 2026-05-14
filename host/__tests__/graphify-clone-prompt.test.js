// Verifies REQ-AGENT-023 AC4: the PostToolUse clone-prompt hook
// recognises `git clone` and `gh repo clone` across the three supported
// tool-input shapes (Bash, mcp__context-mode__ctx_execute, ctx_batch_execute),
// rejects substring false positives, extracts the cloned directory from
// tool_response stdout, and is idempotent per cloned dir.
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh');

function runHook(input, fakeHome) {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, HOME: fakeHome },
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    status: result.status,
    json: result.stdout.trim() ? safeParse(result.stdout) : null,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

describe('graphify-clone-prompt.sh', () => {
  let baseTmp;
  before(() => { baseTmp = mkdtempSync(join(tmpdir(), 'gf-clone-')); });

  let fakeHome;
  beforeEach(() => {
    fakeHome = mkdtempSync(join(baseTmp, 'home-'));
    mkdirSync(join(fakeHome, '.cache'), { recursive: true });
  });

  it('Bash shape: real git clone produces a triage directive with the target dir', () => {
    const { json, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://github.com/foo/bar /tmp/bar' },
      tool_response: { stdout: "Cloning into '/tmp/bar'...\nremote: Enumerating objects" },
    }, fakeHome);
    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON');
    assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(
      json.hookSpecificOutput.additionalContext.includes('/tmp/bar'),
      'directive must name the cloned directory'
    );
    assert.ok(
      json.hookSpecificOutput.additionalContext.includes('AskUserQuestion'),
      'directive must instruct the agent to use AskUserQuestion'
    );
  });

  it('Bash shape: gh repo clone is recognised as well', () => {
    const { json } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh repo clone foo/bar /tmp/ghbar' },
      tool_response: { stdout: "Cloning into '/tmp/ghbar'..." },
    }, fakeHome);
    assert.ok(json, 'gh repo clone must trigger the directive');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('/tmp/ghbar'));
  });

  it('ctx_execute shape: shell-language code is parsed correctly (issue #317 multi-shape)', () => {
    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: { language: 'shell', code: 'git clone https://github.com/foo/bar /tmp/ctxbar' },
      tool_response: { stdout: "Cloning into '/tmp/ctxbar'..." },
    }, fakeHome);
    assert.ok(json, 'ctx_execute shape must trigger the directive');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('/tmp/ctxbar'));
  });

  it('ctx_batch_execute shape: commands array is joined and matched', () => {
    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_batch_execute',
      tool_input: {
        commands: [
          { label: 'prep', command: 'mkdir -p /tmp/work' },
          { label: 'clone', command: 'git clone https://example.com/repo /tmp/work/repo' },
        ],
      },
      tool_response: { stdout: "Cloning into '/tmp/work/repo'..." },
    }, fakeHome);
    assert.ok(json, 'ctx_batch_execute shape must trigger the directive');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('/tmp/work/repo'));
  });

  it('false positive: echo "git clone foo" must NOT trigger', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo "instructions: git clone foo"' },
      tool_response: { stdout: '' },
    }, fakeHome);
    assert.equal(status, 0);
    assert.equal(stdout, '', 'no directive should be emitted for echoed substrings');
  });

  it('false positive: shell-comment-only mention must NOT trigger', () => {
    const { stdout } = runHook({
      tool_name: 'Bash',
      tool_input: { command: '# remember: git clone things go here later' },
      tool_response: { stdout: '' },
    }, fakeHome);
    assert.equal(stdout, '', 'comment-only mention must not trigger');
  });

  it('chained command: git clone after && is anchored and triggers', () => {
    const { json } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'mkdir -p /tmp/x && git clone https://example.com/repo /tmp/x/repo' },
      tool_response: { stdout: "Cloning into '/tmp/x/repo'..." },
    }, fakeHome);
    assert.ok(json, 'git clone after && is a valid command position');
  });

  it('idempotency: same target dir prompts once per session', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://github.com/foo/bar /tmp/idempotent' },
      tool_response: { stdout: "Cloning into '/tmp/idempotent'..." },
    };
    const first = runHook(input, fakeHome);
    assert.ok(first.json, 'first invocation emits directive');
    const second = runHook(input, fakeHome);
    assert.equal(second.stdout, '', 'second invocation for the same dir must be a no-op');
  });

  it('idempotency: different target dirs each get prompted', () => {
    const a = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://example.com/a /tmp/dirA' },
      tool_response: { stdout: "Cloning into '/tmp/dirA'..." },
    }, fakeHome);
    const b = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://example.com/b /tmp/dirB' },
      tool_response: { stdout: "Cloning into '/tmp/dirB'..." },
    }, fakeHome);
    assert.ok(a.json && b.json, 'distinct dirs each emit a directive');
    assert.ok(a.json.hookSpecificOutput.additionalContext.includes('/tmp/dirA'));
    assert.ok(b.json.hookSpecificOutput.additionalContext.includes('/tmp/dirB'));
  });

  it('fail-safe: malformed input exits 0 with no output', () => {
    const result = spawnSync('bash', [HOOK], {
      input: 'not-valid-json {{{',
      encoding: 'utf-8',
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(result.status, 0, 'hook must never exit non-zero (sessions cannot crash because of it)');
    assert.equal(result.stdout.trim(), '');
  });

  it('pre-filter: input without the substring "clone" exits silently', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
      tool_response: { stdout: 'a b c' },
    }, fakeHome);
    assert.equal(status, 0);
    assert.equal(stdout, '');
  });
});
