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

function runHook(cwd, { toolName, toolInput, transcriptPath, envHome }) {
  // envHome is set by the active-cwd sentinel tests so the hook reads
  // a fixture-controlled ~/.cache/codeflare-hooks/graphify-active-cwd
  // instead of the real user's. Tests that don't pass envHome get the
  // ambient HOME and the sentinel-read just no-ops (file absent).
  const env = envHome
    ? { ...process.env, HOME: envHome }
    : process.env;
  return spawnSync('bash', [HOOK], {
    cwd,
    env,
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

describe('enforce-graphify.sh - gating / REQ-AGENT-042 (graphify hard-block enforcement)', () => {
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

describe('enforce-graphify.sh - active-cwd sentinel (codeflare layout)', () => {
  // In codeflare every agent session has cwd=~/workspace (parent of all
  // repos), so the literal-cwd graph check at L53 of the hook would
  // never pass and enforcement would be permanently dead. The hook
  // instead reads ~/.cache/codeflare-hooks/graphify-active-cwd (written
  // by graphify-active-repo.sh) to resolve the user's currently active
  // repo and check THAT repo's graph.json. These tests stage the
  // sentinel in a fixture HOME so the existing transcript machinery
  // exercises the real production path.
  function makeFakeHomeWithSentinel(activeRepoPath) {
    const home = mkdtempSync(join(tmpdir(), 'enforce-gf-home-'));
    const cacheDir = join(home, '.cache', 'codeflare-hooks');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'graphify-active-cwd'), activeRepoPath + '\n');
    return home;
  }

  it('reads sentinel when cwd has no graph but active repo does (denies on 4th search)', () => {
    const activeRepo = makeFixture(); // has graphify-out/graph.json
    const cwd = mkdtempSync(join(tmpdir(), 'enforce-gf-parent-')); // no graph here
    const home = makeFakeHomeWithSentinel(activeRepo);
    const t = makeTranscript(activeRepo, { count: 3 });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
      envHome: home,
    });
    // 3 prior greps + this one = 4, no graphify call -> deny
    assert.equal(r.status, 0); // hook itself succeeds
    assert.match(r.stdout, /permissionDecision":\s*"deny"/,
      'should deny via hookSpecificOutput when sentinel points at a graphified repo');
  });

  it('does NOT enforce when sentinel points at a repo without a graph', () => {
    // Vault-only-in-global case: user is in a new repo with no graph,
    // sentinel reflects that repo, no enforcement should fire even
    // though vault is sitting in the global graph.
    const noGraphRepo = mkdtempSync(join(tmpdir(), 'enforce-gf-nograph-'));
    mkdirSync(join(noGraphRepo, '.git'), { recursive: true });
    const cwd = mkdtempSync(join(tmpdir(), 'enforce-gf-parent-'));
    const home = makeFakeHomeWithSentinel(noGraphRepo);
    const t = makeTranscript(noGraphRepo, { count: 5 });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
      envHome: home,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '',
      'no graph in active repo -> hook must exit silently (vault-only global is NOT enforcement-eligible)');
  });

  it('falls back to cwd when sentinel is absent (vanilla graphify users outside codeflare)', () => {
    const cwd = makeFixture(); // graph.json present here
    const home = mkdtempSync(join(tmpdir(), 'enforce-gf-empty-home-'));
    const t = makeTranscript(cwd, { count: 3 });
    const r = runHook(cwd, {
      toolName: 'Grep',
      toolInput: { pattern: 'foo' },
      transcriptPath: t,
      envHome: home,
    });
    assert.match(r.stdout, /permissionDecision":\s*"deny"/,
      'absent sentinel -> cwd graph check still works for non-codeflare users');
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
