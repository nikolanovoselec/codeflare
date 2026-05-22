// Verifies REQ-AGENT-023 AC10: the PreToolUse graph-first nudge hook
// fires only when a graphify graph exists in the agent's cwd, covers
// both non-custom-tier matchers (Grep, Glob) and custom-tier matchers
// (mcp__context-mode__ctx_search, mcp__context-mode__ctx_batch_execute),
// is non-blocking (always exits 0 with an additionalContext-only
// payload), and stays silent when no graph is present.
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../preseed/agents/claude/plugins/graphify/scripts/graph-first-nudge.sh');

function runHook(input) {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: process.env,
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

function makeRepoWithGraph(baseTmp) {
  const dir = mkdtempSync(join(baseTmp, 'repo-with-graph-'));
  mkdirSync(join(dir, 'graphify-out'), { recursive: true });
  writeFileSync(join(dir, 'graphify-out', 'graph.json'), '{"nodes":[],"edges":[]}');
  return dir;
}

function makeRepoNoGraph(baseTmp) {
  return mkdtempSync(join(baseTmp, 'repo-no-graph-'));
}

describe('graph-first-nudge.sh', () => {
  let baseTmp;
  before(() => { baseTmp = mkdtempSync(join(tmpdir(), 'gf-nudge-')); });

  it('non-custom tier: Grep with graph present -> inject fires', () => {
    const cwd = makeRepoWithGraph(baseTmp);
    const { json, status } = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'authMiddleware' },
      cwd,
    });
    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON when graph exists');
    assert.equal(json.hookSpecificOutput.hookEventName, 'PreToolUse');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('mcp__graphify__'), 'inject must mention graphify MCP tools');
    assert.ok(ctx.includes('structural'), 'inject must distinguish structural from content searches');
  });

  it('non-custom tier: Glob with graph present -> inject fires', () => {
    const cwd = makeRepoWithGraph(baseTmp);
    const { json } = runHook({
      tool_name: 'Glob',
      tool_input: { pattern: '**/*auth*' },
      cwd,
    });
    assert.ok(json, 'Glob must trigger the nudge when graph is present');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('mcp__graphify__'));
  });

  it('custom tier: ctx_search with graph present -> inject fires (Grep-equivalent path)', () => {
    const cwd = makeRepoWithGraph(baseTmp);
    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_search',
      tool_input: { queries: ['where is authMiddleware defined'] },
      cwd,
    });
    assert.ok(json, 'ctx_search must trigger nudge - this is the custom-tier code path');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('mcp__graphify__'));
  });

  it('custom tier: ctx_batch_execute with graph present -> inject uses hedged phrasing (may bundle non-grep commands)', () => {
    const cwd = makeRepoWithGraph(baseTmp);
    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_batch_execute',
      tool_input: {
        commands: [{ label: 'grep', command: 'grep -r auth src/' }],
        queries: ['auth'],
      },
      cwd,
    });
    assert.ok(json, 'ctx_batch_execute must trigger nudge');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(
      /any of these searches/i.test(ctx),
      'ctx_batch_execute inject must hedge with "any of these searches" because the call may bundle unrelated commands'
    );
  });

  it('no graph: Grep silently exits without inject', () => {
    const cwd = makeRepoNoGraph(baseTmp);
    const { stdout, status } = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'whatever' },
      cwd,
    });
    assert.equal(status, 0);
    assert.equal(stdout, '', 'no graph -> no inject');
  });

  it('no graph: ctx_search silently exits without inject', () => {
    const cwd = makeRepoNoGraph(baseTmp);
    const { stdout } = runHook({
      tool_name: 'mcp__context-mode__ctx_search',
      tool_input: { queries: ['anything'] },
      cwd,
    });
    assert.equal(stdout, '', 'no graph -> no inject (custom tier path)');
  });

  it('always non-blocking: exits 0 even on malformed input', () => {
    const result = spawnSync('bash', [HOOK], {
      input: 'not-json {{{',
      encoding: 'utf-8',
      env: process.env,
    });
    assert.equal(result.status, 0, 'hook must never exit non-zero - would break every grep call in the session');
    assert.equal(result.stdout.trim(), '');
  });

  it('always non-blocking: payload is additionalContext only, never decision: "block"', () => {
    const cwd = makeRepoWithGraph(baseTmp);
    const { json } = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'x' },
      cwd,
    });
    assert.ok(json, 'sanity: inject fired');
    assert.equal(
      json.hookSpecificOutput.decision,
      undefined,
      'must not set decision field - the use/don\'t-use call needs agent judgment'
    );
    assert.ok(
      !('permissionDecision' in (json.hookSpecificOutput || {})),
      'must not set permissionDecision either'
    );
  });

  it('Read is NOT a matcher (Read is "about to Edit", not a grep substitute)', () => {
    const cwd = makeRepoWithGraph(baseTmp);
    const { stdout } = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/some/file.ts' },
      cwd,
    });
    // The hook will only run if entrypoint.sh registered Read as a matcher,
    // which it does not. But if invoked directly with Read, the case
    // statement at the bottom of the hook script falls through to the
    // defensive *) branch and produces no inject. Verify that:
    assert.equal(stdout, '', 'Read must not produce an inject even when invoked directly');
  });

  it('ctx_execute is NOT a matcher (general-purpose escape hatch, too many false positives)', () => {
    const cwd = makeRepoWithGraph(baseTmp);
    const { stdout } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: { language: 'shell', code: 'echo hello' },
      cwd,
    });
    assert.equal(stdout, '', 'ctx_execute must not produce an inject even when invoked directly');
  });
});
