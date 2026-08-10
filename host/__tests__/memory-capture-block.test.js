// Real behavioral tests for the PreToolUse memory-capture-block hook.
//
// Spawns the actual bash script with stdin JSON and asserts on exit code,
// stderr, and side-effect files. Each test uses a fresh temp $HOME so
// counter / lock files don't bleed between tests.
//
// Covers REQ-MEM-012 (hard-block on undrained memory-capture .vars).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh',
);

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'memblock-home-'));
  const counterDir = mkdtempSync(join(tmpdir(), 'memblock-counter-'));
  return { home, counterDir };
}

function writeVars({ counterDir }, sessionId) {
  const path = join(counterDir, `${sessionId}.vars`);
  writeFileSync(path, JSON.stringify({ transcript: '/tmp/fake', last_line: '0' }));
  return path;
}

function runHook({ home, counterDir }, payload) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home, MEMCAP_COUNTER_DIR: counterDir },
  });
}


// REQ-MEM-012 AC1 (no deferred capture -> hook is inert)
describe('memory-capture-block.sh - common path / REQ-MEM-012 AC1', () => {
  it('exits 0 when .vars does not exist (Bash tool allowed)', () => {
    const fx = makeFixture();
    const r = runHook(fx, {
      session_id: 'sess-clean',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  it('exits 0 when .vars does not exist (any tool allowed)', () => {
    const fx = makeFixture();
    for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch']) {
      const r = runHook(fx, {
        session_id: 'sess-clean',
        tool_name: tool,
        tool_input: {},
      });
      assert.equal(r.status, 0, `${tool} should be allowed when no .vars`);
    }
  });
});

// REQ-MEM-012 AC2 (defensive: missing session_id is a no-op)
describe('memory-capture-block.sh - input gating / REQ-MEM-012 AC2', () => {
  it('exits 0 when session_id is missing (defensive)', () => {
    const fx = makeFixture();
    const r = runHook(fx, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(r.status, 0);
  });
});

// REQ-MEM-012 AC3 (HARD BLOCK on undrained .vars for non-allowed tool)
describe('memory-capture-block.sh - hard block / REQ-MEM-012 AC3', () => {
  it('exits 2 with stderr when .vars exists and tool is Bash', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    const r = runHook(fx, {
      session_id: 'sess-blocked',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HARD BLOCK/);
    assert.match(r.stderr, /memory-capture/);
  });

  it('exits 2 when .vars exists and tool is Read', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    const r = runHook(fx, {
      session_id: 'sess-blocked',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    });
    assert.equal(r.status, 2);
  });

  it('exits 2 when .vars exists and tool is Edit/Write/Grep/Glob/WebFetch', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    for (const tool of ['Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'mcp__context-mode__ctx_execute']) {
      const r = runHook(fx, {
        session_id: 'sess-blocked',
        tool_name: tool,
        tool_input: {},
      });
      assert.equal(r.status, 2, `${tool} should be blocked when .vars exists`);
    }
  });

  it('block stderr contains spawn directive with PROMPT_FILE and VARS_FILE paths', () => {
    const fx = makeFixture();
    const varsPath = writeVars(fx, 'sess-blocked');
    const r = runHook(fx, {
      session_id: 'sess-blocked',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /PROMPT_FILE=/);
    // Escape every regex metacharacter (including backslash) so a path with
    // any special char in it is matched literally. CodeQL alert #54
    // (js/incomplete-sanitization) caught the prior 2-char class missing \\.
    assert.match(r.stderr, new RegExp(`VARS_FILE=${varsPath.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
    assert.match(r.stderr, /subagent_type:\s*"memory-capture"/);
    assert.match(r.stderr, /run_in_background:\s*true/);
    assert.match(r.stderr, /sonnet/);
  });
});

// REQ-MEM-012 AC4 (Task(memory-capture) is the only allowed tool when .vars exists)
describe('memory-capture-block.sh - subagent allowlist / REQ-MEM-012 AC4', () => {
  it('exits 0 when tool is Task with subagent_type=memory-capture', () => {
    const fx = makeFixture();
    const sid = `sess-allow-mc-${Date.now()}`;
    writeVars(fx, sid);
    const r = runHook(fx, {
      session_id: sid,
      tool_name: 'Task',
      tool_use_id: 'task-spawn-id',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  it('exits 2 when tool is Task with a different subagent_type', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    for (const subType of ['general-purpose', 'code-reviewer', 'spec-reviewer', 'vault-extract']) {
      const r = runHook(fx, {
        session_id: 'sess-blocked',
        tool_name: 'Task',
        tool_input: { subagent_type: subType, prompt: 'work' },
      });
      assert.equal(r.status, 2, `Task/${subType} should be blocked`);
    }
  });

  it('exits 2 when tool is Task with no subagent_type', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    const r = runHook(fx, {
      session_id: 'sess-blocked',
      tool_name: 'Task',
      tool_input: { prompt: 'no subagent_type' },
    });
    assert.equal(r.status, 2);
  });
});

// REQ-MEM-012 AC3+AC4: spawning the capture agent opens one bounded
// in-flight window so its own PreToolUse calls cannot self-deadlock.
describe('memory-capture-block.sh - in-flight capture sentinel / REQ-MEM-012 AC3+AC4', () => {
  it('allows the capture child first tool call without correlation metadata', () => {
    const fx = makeFixture();
    const sessionId = `sess-in-flight-${process.pid}-${Date.now()}`;
    const varsPath = writeVars(fx, sessionId);
    const sentinel = join(fx.counterDir, `${sessionId}.capture-in-flight`);

    assert.equal(runHook(fx, {
      session_id: sessionId,
      tool_name: 'Agent',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    }).status, 0);
    assert.equal(existsSync(sentinel), true);

    for (const payload of [
      { session_id: sessionId, tool_name: 'Read', tool_input: {} },
      { session_id: sessionId, agent_id: 'capture-child', tool_name: 'Write', tool_input: {} },
      { session_id: sessionId, agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'true' } },
    ]) {
      assert.equal(runHook(fx, payload).status, 0);
    }

    rmSync(varsPath);
    assert.equal(runHook(fx, { session_id: sessionId, tool_name: 'Read', tool_input: {} }).status, 0);
    assert.equal(existsSync(sentinel), false);
  });

  it('expires a stalled in-flight sentinel after 600 seconds and resumes blocking', () => {
    const fx = makeFixture();
    const sessionId = `sess-stale-${process.pid}-${Date.now()}`;
    writeVars(fx, sessionId);
    const sentinel = join(fx.counterDir, `${sessionId}.capture-in-flight`);
    assert.equal(runHook(fx, {
      session_id: sessionId,
      tool_name: 'Task',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    }).status, 0);
    const old = new Date(Date.now() - 601_000);
    utimesSync(sentinel, old, old);
    const blocked = runHook(fx, { session_id: sessionId, tool_name: 'Read', tool_input: {} });
    assert.equal(blocked.status, 2);
    assert.equal(existsSync(sentinel), false);
  });
});

describe('memory-capture-block.sh - no in-flight bypass / REQ-MEM-012 AC4 stop-hook', () => {
  it('blocks every non-capture-spawn call while .vars exists and no sentinel is active', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    const tools = [
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } },
      { tool_name: 'Edit', tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
      { tool_name: 'Write', tool_input: { file_path: '/tmp/y', content: 'z' } },
      { tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt: 'noop' } },
    ];
    for (const tool of tools) {
      const result = runHook(fx, { session_id: 'sess-blocked', ...tool });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /HARD BLOCK/);
    }
  });

  it('stderr states the block clears only after the capture spawn opens the in-flight window', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    const result = runHook(fx, { session_id: 'sess-blocked', tool_name: 'Bash', tool_input: {} });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unconditional/);
    assert.match(result.stderr, /no bypass file/i);
  });
});
