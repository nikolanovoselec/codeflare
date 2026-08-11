// Verifies REQ-MEM-013: Proactive memory injection on first prompt.
//   AC1: extracts keywords from prompt, queries unified graph for matches
//   AC2: matched nodes capped at 10 (budget cap)
//   AC3: fires at most once per session (sentinel file gate)
//   AC4: skips prompts shorter than 20 characters
//   AC7: a graph past the size ceiling is skipped without spending the sentinel
// The REQ's other criteria are Pi-side; the spec's @test anchors, not this
// header, are what record where each one is covered.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-context-inject.sh');
const RECALL_HOOK = resolve(__dirname, '../../preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh');
const RENDERED_BUDGET = 4096;

function makeGraph(dir, nodes) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'global-graph.json'), JSON.stringify({
    nodes,
    edges: [],
  }));
}

function runHook(opts) {
  const { counterDir, sessionId, prompt, home, maxGraphBytes } = opts;
  const input = JSON.stringify({
    hook_event_name: 'UserPromptSubmit',
    session_id: sessionId || 'test-sess',
    prompt: prompt || '',
  });
  const result = spawnSync('bash', [HOOK], {
    encoding: 'utf-8',
    input,
    env: {
      ...process.env,
      HOME: home || process.env.HOME,
      MEMCAP_COUNTER_DIR: counterDir,
      ...(maxGraphBytes ? { MEMORY_INJECT_MAX_GRAPH_BYTES: String(maxGraphBytes) } : {}),
    },
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

describe('memory-context-inject.sh (REQ-MEM-013)', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'mem-inject-'));
    assert.ok(existsSync(HOOK), `hook script missing at ${HOOK}`);
    chmodSync(HOOK, 0o755);
  });

  it('AC1: injects matched nodes from global graph on first prompt', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'ac1-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'ac1-home-'));
    const graphDir = join(homeDir, '.graphify');
    makeGraph(graphDir, [
      { id: '1', label: 'handleVaultRequest', source: 'src/routes/vault.ts', description: 'Main vault route handler' },
      { id: '2', label: 'Container', source: 'src/container/index.ts', description: 'Durable Object for container management' },
      { id: '3', label: 'Unrelated Widget', source: 'lib/widget.ts', description: 'A widget that does nothing relevant' },
    ]);

    const { json, status } = runHook({
      counterDir,
      home: homeDir,
      prompt: 'check the vault route handler and fix the container proxy issue',
    });

    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON with matched context');
    assert.equal(json.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes('handleVaultRequest'), 'must match vault-related node');
    assert.ok(ctx.includes('Container'), 'must match container-related node');
    assert.ok(!ctx.includes('Unrelated Widget'), 'non-matching decoy node must be excluded');
    assert.ok(ctx.includes('Prior context matching your query'), 'must include header');
  });

  it('AC2: injects at most 10 nodes even when more match', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'ac2-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'ac2-home-'));
    const graphDir = join(homeDir, '.graphify');
    const nodes = [];
    for (let i = 1; i <= 15; i++) {
      nodes.push({ id: String(i), label: `VaultHandler${i}`, source: `src/vault${i}.ts`, description: `Vault handler number ${i}` });
    }
    makeGraph(graphDir, nodes);

    const { json, status } = runHook({
      counterDir,
      home: homeDir,
      prompt: 'check all vault handler implementations and their dependencies',
    });

    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON');
    const ctx = json.hookSpecificOutput.additionalContext;
    const matches = ctx.match(/VaultHandler\d+/g) || [];
    assert.ok(matches.length <= 10, `budget cap: expected at most 10 matched nodes, got ${matches.length}`);
    assert.ok(matches.length >= 1, 'at least one node must match');
  });

  it('AC2: bounds the complete rendered context in UTF-8 bytes', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'ac2-bytes-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'ac2-bytes-home-'));
    makeGraph(join(homeDir, '.graphify'), Array.from({ length: 10 }, (_, index) => ({
      id: String(index),
      label: `vault${'é'.repeat(1500)}`,
      source: `Vault/${'路'.repeat(1500)}/${index}.md`,
      description: `vault ${'é'.repeat(100)}`,
    })));

    const { json } = runHook({
      counterDir,
      home: homeDir,
      prompt: 'check the vault memory context and matching notes now',
    });
    const context = json?.hookSpecificOutput?.additionalContext ?? '';
    assert.ok(context.includes('Prior context matching your query'));
    assert.ok(Buffer.byteLength(context, 'utf8') <= RENDERED_BUDGET);
    assert.ok(!context.includes('�'));
  });

  it('REQ-MEM-019 AC4: charges title, multibyte source path, body, and marker to one extract budget', () => {
    const sessionsDir = join(mkdtempSync(join(baseTmp, 'recall-budget-')), '会话'.repeat(40));
    mkdirSync(sessionsDir, { recursive: true });
    const sourcePath = join(sessionsDir, '2026-07-03T10-00-00+0200-a.md');
    writeFileSync(sourcePath, [
      `# ${'é'.repeat(300)}`,
      '## Context',
      '界'.repeat(1000),
      '## Decisions',
      '- retained decision',
    ].join('\n'));
    const result = spawnSync('bash', [RECALL_HOOK], {
      encoding: 'utf8',
      input: JSON.stringify({ source: 'compact' }),
      env: { ...process.env, POST_COMPACT_SESSIONS_DIR: sessionsDir, POST_COMPACT_PER_FILE_BYTES: '500' },
    });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    const block = context.match(/### [\s\S]*?(?=\n\nFull extracts live in)/)?.[0] ?? '';
    assert.ok(Buffer.byteLength(block, 'utf8') <= 500);
    assert.ok(!block.includes('�'));
    assert.ok(block.includes(`Source: ${sourcePath}`), 'long multibyte path must remain byte-exact');
  });

  it('REQ-MEM-019 AC4: omits a recall block when its exact Source metadata cannot fit', () => {
    const sessionsDir = join(mkdtempSync(join(baseTmp, 'recall-no-metadata-')), '路'.repeat(80));
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, '2026-07-03T10-00-00+0200-a.md'), '# title\n\n## Context\nretained\n');
    const result = spawnSync('bash', [RECALL_HOOK], {
      encoding: 'utf8',
      input: JSON.stringify({ source: 'compact' }),
      env: { ...process.env, POST_COMPACT_SESSIONS_DIR: sessionsDir, POST_COMPACT_PER_FILE_BYTES: '100' },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  it('AC3: fires at most once per session (sentinel directory prevents re-fire)', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'ac3-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'ac3-home-'));
    const graphDir = join(homeDir, '.graphify');
    makeGraph(graphDir, [
      { id: '1', label: 'TestNode', source: 'test.ts', description: 'test node for matching' },
    ]);

    const run1 = runHook({
      counterDir,
      sessionId: 'once-test',
      home: homeDir,
      prompt: 'check the TestNode implementation details please',
    });
    assert.ok(run1.json, 'first run must emit context');

    const sentinel = join(counterDir, 'once-test.inject-lock');
    assert.ok(existsSync(sentinel), 'sentinel directory must exist after first run');

    const run2 = runHook({
      counterDir,
      sessionId: 'once-test',
      home: homeDir,
      prompt: 'now do something else with the TestNode module',
    });
    assert.equal(run2.stdout, '', 'second run must produce no output (sentinel blocks)');
  });

  it('AC4: skips prompts shorter than 20 characters', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'ac4-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'ac4-home-'));
    const graphDir = join(homeDir, '.graphify');
    makeGraph(graphDir, [
      { id: '1', label: 'Anything', source: 'a.ts', description: 'should not match' },
    ]);

    const { stdout, status } = runHook({
      counterDir,
      home: homeDir,
      prompt: 'hi there',
    });
    assert.equal(status, 0);
    assert.equal(stdout, '', 'short prompt must produce no output');
    assert.ok(!existsSync(join(counterDir, 'test-sess.inject-lock')), 'sentinel must not be created for skipped prompts');
  });

  it('no graph: exits silently without error', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'nograph-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'nograph-home-'));

    const { stdout, status } = runHook({
      counterDir,
      home: homeDir,
      prompt: 'check the vault route handler and container proxy',
    });
    assert.equal(status, 0);
    assert.equal(stdout, '', 'no graph must produce no output');
    assert.ok(!existsSync(join(counterDir, 'test-sess.inject-lock')), 'sentinel must not be created when no graph exists');
  });

  it('fail-safe: malformed graph JSON exits silently', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'bad-graph-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'bad-graph-home-'));
    const graphDir = join(homeDir, '.graphify');
    mkdirSync(graphDir, { recursive: true });
    writeFileSync(join(graphDir, 'global-graph.json'), 'NOT JSON {{{{');

    const { stdout, status } = runHook({
      counterDir,
      home: homeDir,
      prompt: 'check the vault route handler and container proxy',
    });
    assert.equal(status, 0);
    assert.equal(stdout, '', 'malformed graph must produce no output');
  });

  it('AC7: skips a graph past the ceiling without spending the session sentinel', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'ac7-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'ac7-home-'));
    const graphDir = join(homeDir, '.graphify');
    makeGraph(graphDir, [
      { id: '1', label: 'handleVaultRequest', source: 'src/routes/vault.ts', description: 'Main vault route handler' },
    ]);
    const sessionId = 'ac7-session';

    // Below the graph's own size: the ceiling, not the content, decides.
    const skipped = runHook({
      counterDir,
      home: homeDir,
      sessionId,
      maxGraphBytes: 1,
      prompt: 'check the vault route handler and fix the container proxy issue',
    });

    assert.equal(skipped.status, 0);
    assert.equal(skipped.stdout, '', 'a graph past the ceiling must inject nothing');
    // The sentinel is the session's one shot. Spending it on a graph that was
    // never read would disable injection for the whole session.
    assert.ok(!existsSync(join(counterDir, `${sessionId}.inject-lock`)));

    // Same session, same graph, ceiling now above it: injection still happens,
    // which is only true because the skip left the sentinel unclaimed.
    const injected = runHook({
      counterDir,
      home: homeDir,
      sessionId,
      maxGraphBytes: 134217728,
      prompt: 'check the vault route handler and fix the container proxy issue',
    });

    assert.equal(injected.json?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
    assert.ok(injected.json?.hookSpecificOutput?.additionalContext?.includes('handleVaultRequest'));
    assert.ok(existsSync(join(counterDir, `${sessionId}.inject-lock`)));
  });

  it('AC7: an out-of-range numeric ceiling falls back instead of voiding the guard', () => {
    const counterDir = mkdtempSync(join(baseTmp, 'range-counter-'));
    const homeDir = mkdtempSync(join(baseTmp, 'range-home-'));
    makeGraph(join(homeDir, '.graphify'), [
      { id: '1', label: 'handleVaultRequest', source: 'src/routes/vault.ts', description: 'Main vault route handler' },
    ]);

    // All digits, but past what the shell can compare: the test errors and, with
    // stderr discarded, would read as "not over the ceiling" — a guard that is
    // present and inert. The fallback default must take over instead.
    const { json, status } = runHook({
      counterDir,
      home: homeDir,
      maxGraphBytes: '9'.repeat(40),
      prompt: 'check the vault route handler and fix the container proxy issue',
    });

    assert.equal(status, 0);
    assert.ok(json?.hookSpecificOutput?.additionalContext?.includes('handleVaultRequest'));
  });

  it('creates counter directory if missing', () => {
    const counterDir = join(baseTmp, 'mkdir-test-' + Date.now());
    assert.ok(!existsSync(counterDir), 'counter dir must not exist before test');

    const homeDir = mkdtempSync(join(baseTmp, 'mkdir-home-'));
    const graphDir = join(homeDir, '.graphify');
    makeGraph(graphDir, [
      { id: '1', label: 'TestNode', source: 'test.ts', description: 'test' },
    ]);

    const { status } = runHook({
      counterDir,
      home: homeDir,
      prompt: 'check the TestNode implementation details please',
    });
    assert.equal(status, 0);
    assert.ok(existsSync(counterDir), 'hook must create counter directory');
  });
});
