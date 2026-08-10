// Real behavioral tests for the PreToolUse memory-capture-block hook.
//
// Spawns the actual bash script with stdin JSON and asserts on exit code,
// stderr, and side-effect files. Each test uses a fresh temp $HOME so
// counter / lock files don't bleed between tests.
//
// Covers REQ-MEM-012 (hard-block on undrained memory-capture .vars).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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

function runHookAsync({ home, counterDir }, payload) {
  return new Promise((resolveResult) => {
    const child = spawn('bash', [HOOK], {
      env: { ...process.env, HOME: home, MEMCAP_COUNTER_DIR: counterDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolveResult({ status, stderr }));
    child.stdin.end(JSON.stringify(payload));
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

// REQ-MEM-012 AC3+AC4: the correlated capture child is preferred, while a
// timed breaker prevents a missing harness signal from permanently deadlocking.
describe('memory-capture-block.sh - child authorization breaker / REQ-MEM-012 AC3+AC4', () => {
  it('permits the exact child after the parent result binds its identity', () => {
    const fx = makeFixture();
    const sessionId = 'sess-correlated';
    writeVars(fx, sessionId);

    assert.equal(runHook(fx, {
      session_id: sessionId,
      tool_name: 'Agent',
      tool_use_id: 'spawn-private-id',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    }).status, 0);
    assert.equal(runHook(fx, {
      hook_event_name: 'PostToolUse',
      session_id: sessionId,
      tool_name: 'Agent',
      tool_use_id: 'spawn-private-id',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
      tool_response: { status: 'async_launched', agentId: 'actual-capture-child' },
    }).status, 0);
    assert.equal(runHook(fx, {
      session_id: sessionId,
      agent_id: 'actual-capture-child',
      agent_type: 'memory-capture',
      tool_name: 'Read',
      tool_input: {},
    }).status, 0);
    assert.equal(runHook(fx, {
      session_id: sessionId,
      agent_id: 'other-child',
      agent_type: 'memory-capture',
      tool_name: 'Read',
      tool_input: {},
    }).status, 2);
  });

  it('logs missing correlation and fails open after 120 seconds', () => {
    const fx = makeFixture();
    const sessionId = 'sess-broken-handshake';
    writeVars(fx, sessionId);
    assert.equal(runHook(fx, {
      session_id: sessionId,
      tool_name: 'Agent',
      tool_use_id: 'spawn-private-id',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    }).status, 0);

    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      agent_type: 'memory-capture',
      tool_name: 'Read',
      tool_use_id: 'child-read',
      tool_input: {},
    };
    assert.equal(runHook(fx, payload).status, 2);
    const blocklog = readFileSync(join(fx.counterDir, `${sessionId}.blocklog`), 'utf8');
    assert.match(blocklog, /"tool":"Read"/);
    assert.match(blocklog, /"event":"PreToolUse"/);
    assert.match(blocklog, /"agent_id":""/);
    assert.match(blocklog, /"agent_type":"memory-capture"/);
    assert.match(blocklog, /"tool_use_id":"child-read"/);
    assert.match(blocklog, /"response_agent_id":""/);
    assert.match(blocklog, /"auth_state":"pending:spawn-private-id"/);

    const authorization = join(fx.counterDir, `${sessionId}.capture-auth`);
    const old = new Date(Date.now() - 121_000);
    utimesSync(authorization, old, old);
    assert.equal(runHook(fx, payload).status, 0);
  });

  it('expires stale parent authorization and returns to blocking', () => {
    const expired = makeFixture();
    writeVars(expired, 'sess-expired');
    assert.equal(runHook(expired, {
      session_id: 'sess-expired',
      tool_name: 'Agent',
      tool_use_id: 'late-child',
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
      tool_use_id: 'harness-spawn-id',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    });
    assert.equal(result.status, 0);
    const authorization = join(fx.counterDir, 'sess-local.capture-auth');
    assert.ok(existsSync(authorization));
    assert.match(readFileSync(authorization, 'utf8'), /^pending:harness-spawn-id\n$/);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('allows only one of two concurrent parent spawn identities', async () => {
    const fx = makeFixture();
    const sessionId = 'sess-concurrent';
    writeVars(fx, sessionId);
    const results = await Promise.all(['spawn-a', 'spawn-b'].map((toolUseId) => runHookAsync(fx, {
      session_id: sessionId,
      tool_name: 'Agent',
      tool_use_id: toolUseId,
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    })));
    assert.deepEqual(results.map((result) => result.status).sort(), [0, 2]);
    const authorization = readFileSync(join(fx.counterDir, `${sessionId}.capture-auth`), 'utf8');
    const winner = authorization.match(/^pending:(spawn-[ab])\n$/)?.[1];
    assert.ok(winner);
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

  it('does not activate the breaker when no capture spawn was recorded', () => {
    const fx = makeFixture();
    const varsPath = writeVars(fx, 'sess-no-spawn');
    const old = new Date(Date.now() - 121_000);
    utimesSync(varsPath, old, old);
    const r = runHook(fx, { session_id: 'sess-no-spawn', tool_name: 'Read', tool_input: {} });
    assert.equal(r.status, 2);
    assert.equal(existsSync(join(fx.counterDir, 'sess-no-spawn.capture-auth')), false);
  });

  it('stderr states there is no bypass file and names the bounded handshake breaker', () => {
    const fx = makeFixture();
    writeVars(fx, 'sess-blocked');
    const r = runHook(fx, { session_id: 'sess-blocked', tool_name: 'Bash', tool_input: {} });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no bypass file/);
    assert.match(r.stderr, /fails open after 120s/);
  });
});
