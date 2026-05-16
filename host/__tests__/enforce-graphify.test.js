// Real behavioral tests for the graphify PreToolUse enforcement hook.
//
// Spawn the actual bash script with stdin input and assert on exit code
// plus deny-message presence. Fixture builds a transcript with N grep-
// class entries since the last real user prompt, then triggers the
// hook on a fresh structural search. Each test uses a fresh temp dir
// so /tmp/graphify-bypass cannot leak between tests (the hook also
// auto-deletes it on use).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/graphify/scripts/enforce-graphify.sh',
);

function makeFixture({ withGraph = true } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'enforce-graphify-'));
  if (withGraph) {
    mkdirSync(join(cwd, 'graphify-out'), { recursive: true });
    writeFileSync(join(cwd, 'graphify-out/graph.json'), '{}');
  }
  return cwd;
}

// Build a transcript with `count` grep-class Bash tool_use entries
// after a real user prompt. Each entry is one JSONL line in the shape
// the hook walks (matches the awk regex on "name":"Bash" + "command").
function makeTranscript(cwd, { count = 0, withGraphifyCall = false, withUserPrompt = true, extraLines = [] } = {}) {
  const path = join(cwd, 'transcript.jsonl');
  const lines = [];
  if (withUserPrompt) {
    lines.push(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'find all usages of foo' },
    }));
  }
  for (let i = 0; i < count; i++) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Bash',
          input: { command: `grep -rn foo${i} src/` },
        }],
      },
    }));
  }
  if (withGraphifyCall) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'mcp__graphify__query_graph',
          input: { query: 'foo' },
        }],
      },
    }));
  }
  for (const extra of extraLines) lines.push(extra);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function runHook(cwd, { toolName, toolInput, transcriptPath }) {
  return spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: toolInput,
      transcript_path: transcriptPath,
      cwd,
    }),
    encoding: 'utf-8',
  });
}

describe('enforce-graphify.sh - gating', () => {
  it('exits 0 silently when graphify-out/graph.json is absent (vibe repo)', () => {
    const cwd = makeFixture({ withGraph: false });
    const t = makeTranscript(cwd, { count: 5 });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('exits 0 when /tmp/graphify-bypass exists, and deletes it (one-shot)', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 5 });
    writeFileSync('/tmp/graphify-bypass', '');
    try {
      const r = runHook(cwd, {
        toolName: 'Grep',
        toolInput: { pattern: 'foo' },
        transcriptPath: t,
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(existsSync('/tmp/graphify-bypass'), false,
        'bypass sentinel must be deleted on use');
    } finally {
      try { spawnSync('rm', ['-f', '/tmp/graphify-bypass']); } catch {}
    }
  });
});

describe('enforce-graphify.sh - classification', () => {
  it('exits 0 on non-search Bash (e.g., git status)', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 5 });
    const r = runHook(cwd, {
      toolName: 'Bash',
      toolInput: { command: 'git status --short' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('exits 0 on Glob (not in matcher set anyway, but defensively)', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 5 });
    const r = runHook(cwd, {
      toolName: 'Glob',
      toolInput: { pattern: '**/*.ts' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('enforce-graphify.sh - block decision', () => {
  it('blocks native Grep when 3 prior greps and 0 graphify calls', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 3 });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /permissionDecision.*deny/);
    assert.match(r.stdout, /BLOCKED/);
    assert.match(r.stdout, /graphify/);
  });

  it('allows Grep when fewer than 3 prior structural searches', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 2 });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('allows Grep when a graphify MCP call landed in the same turn', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 5, withGraphifyCall: true });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  it('counts graphify CLI (graphify query) toward GRAPHIFY_COUNT', () => {
    const cwd = makeFixture();
    const extra = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'graphify query "what calls foo"' },
        }],
      },
    });
    const t = makeTranscript(cwd, { count: 5, extraLines: [extra] });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '', 'graphify CLI query should open the gate');
  });

  it('blocks Bash grep with chained pipeline (segment splitter)', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 3 });
    const r = runHook(cwd, {
      toolName: 'Bash',
      toolInput: { command: 'cat foo.ts | grep -n "myFunc"' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /permissionDecision.*deny/);
  });

  it('blocks ctx_execute shell with grep', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 3 });
    const r = runHook(cwd, {
      toolName: 'mcp__context-mode__ctx_execute',
      toolInput: { language: 'shell', code: 'grep -rn foo src/' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /permissionDecision.*deny/);
  });

  it('does not block ctx_execute with non-shell language (python)', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 5 });
    const r = runHook(cwd, {
      toolName: 'mcp__context-mode__ctx_execute',
      toolInput: { language: 'python', code: 'import re; re.search("foo", open("x").read())' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

describe('enforce-graphify.sh - magic-phrase bypass', () => {
  it('exits 0 when latest user message contains "skip graph"', () => {
    const cwd = makeFixture();
    const t = makeTranscript(cwd, { count: 0, withUserPrompt: false });
    // Manually craft the transcript so the user prompt comes AFTER the
    // greps to assert the "latest user message" check.
    writeFileSync(t, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'skip graph for this turn' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -rn foo' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -rn bar' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -rn baz' } }] } }),
    ].join('\n') + '\n');
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'qux' },
      transcriptPath: t,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});
