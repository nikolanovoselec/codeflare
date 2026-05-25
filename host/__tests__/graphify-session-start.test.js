// Verifies REQ-AGENT-024 AC1: SessionStart hook three-tier fallback:
//   Tier 1: graph.json + python3 -> god-nodes structural summary
//   Tier 2: graph.json, query fails -> GRAPH_REPORT.md preamble
//   Tier 2 fallback: graph.json, no report -> generic nudge
//   Tier 3: code repo, no graph -> build-suggestion
//   Silent: non-code cwd -> no output
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../preseed/agents/claude/plugins/graphify/scripts/graphify-session-start.sh');

function runFromCwd(cwd, env) {
  const result = spawnSync('bash', [HOOK], {
    cwd,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test', cwd }),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
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

function makeGraph(outDir, nodes, edges) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'graph.json'), JSON.stringify({ nodes, edges }));
}

describe('graphify-session-start.sh (REQ-AGENT-024 AC1)', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'gf-session-'));
    assert.ok(existsSync(HOOK), `hook script missing at ${HOOK}`);
    chmodSync(HOOK, 0o755);
  });

  it('Tier 1: graph with nodes injects god-nodes structural summary with degree counts', () => {
    const cwd = mkdtempSync(join(baseTmp, 'tier1-'));
    const outDir = join(cwd, 'graphify-out');
    const nodes = [
      { id: '1', label: 'handleVaultRequest' },
      { id: '2', label: 'Container' },
      { id: '3', label: 'authMiddleware' },
    ];
    const edges = [
      { source: '1', target: '2' },
      { source: '1', target: '3' },
      { source: '2', target: '3' },
    ];
    makeGraph(outDir, nodes, edges);
    writeFileSync(join(outDir, 'GRAPH_REPORT.md'), '# report\nstub');

    const { json, status } = runFromCwd(cwd);
    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('degree'), 'Tier 1 must include degree counts');
    assert.ok(ctx.includes('Key concepts'), 'Tier 1 must include key concepts header');
    assert.ok(ctx.includes('mcp__graphify__query_graph'), 'must include tool guidance');
  });

  it('Tier 2: graph with empty nodes falls back to GRAPH_REPORT.md preamble', () => {
    const cwd = mkdtempSync(join(baseTmp, 'tier2-'));
    const outDir = join(cwd, 'graphify-out');
    makeGraph(outDir, [], []);
    writeFileSync(join(outDir, 'GRAPH_REPORT.md'), '# Graph Report\nThis is a test preamble.\n'.repeat(5));

    const { json, status } = runFromCwd(cwd);
    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON on Tier 2 fallback');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('Graph Report'), 'Tier 2 must include report preamble');
    assert.ok(ctx.includes('mcp__graphify__query_graph'), 'must include tool guidance');
  });

  it('Tier 2 fallback: graph.json present but no GRAPH_REPORT.md emits generic nudge', () => {
    const cwd = mkdtempSync(join(baseTmp, 'tier2-fb-'));
    const outDir = join(cwd, 'graphify-out');
    makeGraph(outDir, [], []);

    const { json } = runFromCwd(cwd);
    assert.ok(json, 'must emit JSON even without report');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('mcp__graphify__query_graph'), 'generic nudge must mention tools');
    assert.ok(!ctx.includes('Key concepts'), 'generic nudge must not include god-nodes');
  });

  it('Tier 3: code repo, no graph emits build-suggestion mentioning /graphify', () => {
    const cwd = mkdtempSync(join(baseTmp, 'tier3-'));
    writeFileSync(join(cwd, 'index.ts'), 'export const x = 1;\n');

    const { json } = runFromCwd(cwd);
    assert.ok(json, 'must emit a reminder for code repos without a graph');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('/graphify'), 'must mention /graphify');
    assert.ok(ctx.toLowerCase().includes('cluster-only'), 'big-repo guidance must be present');
  });

  it('non-code cwd: no reminder emitted', () => {
    const cwd = mkdtempSync(join(baseTmp, 'non-code-'));
    writeFileSync(join(cwd, 'notes.txt'), 'plain text');

    const { stdout, status } = runFromCwd(cwd);
    assert.equal(status, 0);
    assert.equal(stdout, '', 'non-code cwd must produce no output');
  });

  it('fail-safe: malformed stdin exits 0', () => {
    const cwd = mkdtempSync(join(baseTmp, 'malformed-'));
    const result = spawnSync('bash', [HOOK], {
      cwd,
      input: 'not-json {{{',
      encoding: 'utf-8',
    });
    assert.equal(result.status, 0, 'hook must never block session startup');
  });
});
