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
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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

// REQ-MEM-012 AC4 (no bypass: every non-allowed tool call blocks while .vars
// exists, no in-hook escape, block clears only when subagent runs and deletes
// .vars). Stop-hook semantics same as the review-agent enforcement hook.
describe('memory-capture-block.sh - child-correlated authorization / REQ-MEM-012 AC3+AC4', () => {
  it('permits only the correlated capture child while keeping parent and unrelated children blocked', () => {
    const fx = makeFixture();
    const sessionId = 'sess-correlated';
    writeVars(fx, sessionId);

    const spawn = runHook(fx, {
      session_id: sessionId,
      tool_name: 'Agent',
      tool_use_id: 'spawn-private-id',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    });
    assert.equal(spawn.status, 0);

    const accepted = runHook(fx, {
      session_id: sessionId,
      agent_id: 'capture-child-private-id',
      agent_type: 'memory-capture',
      tool_name: 'Read',
      tool_input: {},
    });
    assert.equal(accepted.status, 0);
    assert.equal(accepted.stderr, '');

    for (const payload of [
      { tool_name: 'Bash', tool_input: {} },
      { agent_id: 'other-child', agent_type: 'general-purpose', tool_name: 'Read', tool_input: {} },
      { agent_id: 'other-capture', agent_type: 'memory-capture', tool_name: 'Read', tool_input: {} },
      { tool_name: 'Agent', tool_input: { subagent_type: 'memory-capture', prompt: 'replay' } },
    ]) {
      const result = runHook(fx, { session_id: sessionId, ...payload });
      assert.equal(result.status, 2);
      assert.ok(!result.stderr.includes('capture-child-private-id'));
      assert.ok(!result.stderr.includes('spawn-private-id'));
    }

    const acceptedAgain = runHook(fx, {
      session_id: sessionId,
      agent_id: 'capture-child-private-id',
      agent_type: 'memory-capture',
      tool_name: 'Write',
      tool_input: {},
    });
    assert.equal(acceptedAgain.status, 0);
  });

  it('rejects missing child correlation and expired unclaimed authorization', () => {
    const missing = makeFixture();
    writeVars(missing, 'sess-missing');
    assert.equal(runHook(missing, {
      session_id: 'sess-missing',
      agent_type: 'memory-capture',
      tool_name: 'Read',
      tool_input: {},
    }).status, 2);

    const expired = makeFixture();
    writeVars(expired, 'sess-expired');
    assert.equal(runHook(expired, {
      session_id: 'sess-expired',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    }).status, 0);
    const authorization = join(expired.counterDir, 'sess-expired.capture-auth');
    assert.ok(existsSync(authorization));
    const old = new Date(Date.now() - 601_000);
    utimesSync(authorization, old, old);
    assert.equal(runHook(expired, {
      session_id: 'sess-expired',
      agent_id: 'late-child',
      agent_type: 'memory-capture',
      tool_name: 'Read',
      tool_input: {},
    }).status, 2);
    assert.equal(existsSync(authorization), false);
  });

  it('stores correlation only in the session-local authorization file', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-local');
    const result = runHook(fx, {
      session_id: 'sess-local',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    });
    assert.equal(result.status, 0);
    const authorization = join(fx.counterDir, 'sess-local.capture-auth');
    assert.ok(existsSync(authorization));
    assert.match(readFileSync(authorization, 'utf8'), /^pending\n$/);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

describe('memory-capture-block.sh - no bypass / REQ-MEM-012 AC4 stop-hook', () => {
  it('blocks every non-Task-memory-capture call unconditionally while .vars exists', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    // Try a variety of tool calls; all must hard-block.
    const tools = [
      { tool_name: 'Bash', tool_input: { command: 'ls' } },
      { tool_name: 'Read', tool_input: { file_path: '/etc/hosts' } },
      { tool_name: 'Edit', tool_input: { file_path: '/tmp/x', old_string: 'a', new_string: 'b' } },
      { tool_name: 'Write', tool_input: { file_path: '/tmp/y', content: 'z' } },
      { tool_name: 'Task', tool_input: { subagent_type: 'general-purpose', prompt: 'noop' } },
    ];
    for (const t of tools) {
      const r = runHook(fx, { session_id: 'sess-blocked', ...t });
      assert.equal(r.status, 2, `${t.tool_name} (subagent_type=${t.tool_input?.subagent_type ?? 'n/a'}) must block`);
      assert.match(r.stderr, /HARD BLOCK/);
    }
  });

  it('stderr explicitly states the block is unconditional and has no bypass', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    const r = runHook(fx, { session_id: 'sess-blocked', tool_name: 'Bash', tool_input: {} });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unconditional/);
    assert.match(r.stderr, /no bypass file/);
  });
});
