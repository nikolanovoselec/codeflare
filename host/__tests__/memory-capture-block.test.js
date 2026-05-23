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
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-capture-block.sh',
);

const BYPASS_FILE = '/tmp/memory-capture-bypass';

function makeFixture() {
  const home = mkdtempSync(join(tmpdir(), 'memblock-home-'));
  return home;
}

function writeVars(home, sessionId) {
  const dir = join(home, '.memory/counter');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.vars`);
  writeFileSync(path, JSON.stringify({ transcript: '/tmp/fake', last_line: '0' }));
  return path;
}

function runHook(home, payload) {
  return spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
  });
}

// REQ-MEM-012 AC1 (no deferred capture -> hook is inert)
describe('memory-capture-block.sh - common path / REQ-MEM-012 AC1', () => {
  it('exits 0 when .vars does not exist (Bash tool allowed)', () => {
    const home = makeFixture();
    const r = runHook(home, {
      session_id: 'sess-clean',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  it('exits 0 when .vars does not exist (any tool allowed)', () => {
    const home = makeFixture();
    for (const tool of ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'WebFetch']) {
      const r = runHook(home, {
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
    const home = makeFixture();
    const r = runHook(home, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.equal(r.status, 0);
  });
});

// REQ-MEM-012 AC3 (HARD BLOCK on undrained .vars for non-allowed tool)
describe('memory-capture-block.sh - hard block / REQ-MEM-012 AC3', () => {
  it('exits 2 with stderr when .vars exists and tool is Bash', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    const r = runHook(home, {
      session_id: 'sess-blocked',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /HARD BLOCK/);
    assert.match(r.stderr, /memory-capture/);
  });

  it('exits 2 when .vars exists and tool is Read', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    const r = runHook(home, {
      session_id: 'sess-blocked',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    });
    assert.equal(r.status, 2);
  });

  it('exits 2 when .vars exists and tool is Edit/Write/Grep/Glob/WebFetch', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    for (const tool of ['Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'mcp__context-mode__ctx_execute']) {
      const r = runHook(home, {
        session_id: 'sess-blocked',
        tool_name: tool,
        tool_input: {},
      });
      assert.equal(r.status, 2, `${tool} should be blocked when .vars exists`);
    }
  });

  it('block stderr contains spawn directive with PROMPT_FILE and VARS_FILE paths', () => {
    const home = makeFixture();
    const varsPath = writeVars(home, 'sess-blocked');
    const r = runHook(home, {
      session_id: 'sess-blocked',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /PROMPT_FILE=/);
    assert.match(r.stderr, new RegExp(`VARS_FILE=${varsPath.replace(/[/.]/g, '\\$&')}`));
    assert.match(r.stderr, /subagent_type:\s*"memory-capture"/);
    assert.match(r.stderr, /run_in_background:\s*true/);
    assert.match(r.stderr, /sonnet/);
  });
});

// REQ-MEM-012 AC4 (Task(memory-capture) is the only allowed tool when .vars exists)
describe('memory-capture-block.sh - subagent allowlist / REQ-MEM-012 AC4', () => {
  it('exits 0 when tool is Task with subagent_type=memory-capture', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    const r = runHook(home, {
      session_id: 'sess-blocked',
      tool_name: 'Task',
      tool_input: { subagent_type: 'memory-capture', prompt: 'drain' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
  });

  it('exits 2 when tool is Task with a different subagent_type', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    for (const subType of ['general-purpose', 'code-reviewer', 'spec-reviewer', 'vault-extract']) {
      const r = runHook(home, {
        session_id: 'sess-blocked',
        tool_name: 'Task',
        tool_input: { subagent_type: subType, prompt: 'work' },
      });
      assert.equal(r.status, 2, `Task/${subType} should be blocked`);
    }
  });

  it('exits 2 when tool is Task with no subagent_type', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    const r = runHook(home, {
      session_id: 'sess-blocked',
      tool_name: 'Task',
      tool_input: { prompt: 'no subagent_type' },
    });
    assert.equal(r.status, 2);
  });
});

// REQ-MEM-012 AC5 (one-shot bypass surface for stale .vars recovery)
describe('memory-capture-block.sh - bypass / REQ-MEM-012 AC5', () => {
  it('exits 0 and consumes bypass file when /tmp/memory-capture-bypass exists', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    // Cleanup any prior test leakage
    try { unlinkSync(BYPASS_FILE); } catch {}
    writeFileSync(BYPASS_FILE, '');
    const r = runHook(home, {
      session_id: 'sess-blocked',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /bypass consumed/);
    assert.equal(existsSync(BYPASS_FILE), false, 'bypass file should be deleted after consumption');
  });

  it('bypass is one-shot: second call after consumption blocks again', () => {
    const home = makeFixture();
    writeVars(home, 'sess-blocked');
    try { unlinkSync(BYPASS_FILE); } catch {}
    writeFileSync(BYPASS_FILE, '');
    const r1 = runHook(home, { session_id: 'sess-blocked', tool_name: 'Bash', tool_input: {} });
    assert.equal(r1.status, 0);
    const r2 = runHook(home, { session_id: 'sess-blocked', tool_name: 'Bash', tool_input: {} });
    assert.equal(r2.status, 2);
  });
});
