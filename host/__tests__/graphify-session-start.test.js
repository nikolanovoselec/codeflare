// Verifies REQ-AGENT-023 AC3: SessionStart hook injects appropriate
// context for three cwd shapes:
//   1. graphify-out/graph.json + GRAPH_REPORT.md present -> graph reminder
//   2. code repo without a graph -> build-suggestion reminder
//   3. non-code cwd -> silent (no output)
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../preseed/agents/claude/plugins/graphify/scripts/graphify-session-start.sh');

function runFromCwd(cwd) {
  const result = spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test' }),
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout.trim(),
    status: result.status,
    json: result.stdout.trim() ? safeParse(result.stdout) : null,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

describe('graphify-session-start.sh', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'gf-session-'));
    // Sanity: hook script must exist and be executable
    assert.ok(existsSync(HOOK), `hook script missing at ${HOOK}`);
    chmodSync(HOOK, 0o755);
  });

  it('graph present: injects a context-mode reminder pointing at GRAPH_REPORT.md and MCP tools', () => {
    const cwd = mkdtempSync(join(baseTmp, 'graph-present-'));
    const outDir = join(cwd, 'graphify-out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'graph.json'), JSON.stringify({ nodes: [], edges: [] }));
    writeFileSync(join(outDir, 'GRAPH_REPORT.md'), '# graph report\nstub');

    const { json, status } = runFromCwd(cwd);
    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON when a graph exists');
    assert.equal(json.hookSpecificOutput.hookEventName, 'SessionStart');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('GRAPH_REPORT.md'), 'reminder must mention GRAPH_REPORT.md');
    assert.ok(
      ctx.includes('mcp__graphify__query_graph'),
      'reminder must list the MCP tool names so the agent can call them by ID'
    );
    assert.ok(ctx.includes('mcp__graphify__get_node'));
    assert.ok(ctx.includes('mcp__graphify__get_neighbors'));
    assert.ok(ctx.includes('mcp__graphify__shortest_path'));
  });

  it('code repo, no graph: emits a build-suggestion reminder mentioning /graphify', () => {
    const cwd = mkdtempSync(join(baseTmp, 'code-no-graph-'));
    writeFileSync(join(cwd, 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(cwd, 'helper.py'), 'def y(): return 2\n');

    const { json } = runFromCwd(cwd);
    assert.ok(json, 'must emit a reminder when cwd contains code files but no graph');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('/graphify'), 'reminder must mention the /graphify slash command');
    assert.ok(
      ctx.toLowerCase().includes('cluster-only'),
      'big-repo guidance (cluster-only --no-viz) must be present'
    );
  });

  it('non-code cwd: no reminder is emitted', () => {
    const cwd = mkdtempSync(join(baseTmp, 'non-code-'));
    writeFileSync(join(cwd, 'notes.txt'), 'plain text only');
    writeFileSync(join(cwd, 'README'), 'no extension');

    const { stdout, status } = runFromCwd(cwd);
    assert.equal(status, 0);
    assert.equal(
      stdout,
      '',
      'cwd without code files and without a graph must produce no SessionStart context (silent)'
    );
  });

  it('partial graph (graph.json without GRAPH_REPORT.md): treated as no-graph and falls through to the code-check branch', () => {
    const cwd = mkdtempSync(join(baseTmp, 'partial-graph-'));
    const outDir = join(cwd, 'graphify-out');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'graph.json'), JSON.stringify({ nodes: [] }));
    writeFileSync(join(cwd, 'main.go'), 'package main\nfunc main() {}\n');

    const { json } = runFromCwd(cwd);
    assert.ok(json, 'partial graph + code present should fall through to build-suggestion');
    assert.ok(
      json.hookSpecificOutput.additionalContext.includes('/graphify'),
      'reminder must be the build-suggestion variant, not the graph-present variant'
    );
    assert.ok(
      !json.hookSpecificOutput.additionalContext.includes('GRAPH_REPORT.md'),
      'partial graph should not trigger the GRAPH_REPORT-pointing reminder'
    );
  });

  it('fail-safe: malformed stdin still exits 0', () => {
    const cwd = mkdtempSync(join(baseTmp, 'malformed-'));
    const result = spawnSync('bash', [HOOK], {
      cwd,
      input: 'not-json {{{',
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, 'hook must never block session startup');
  });
});
