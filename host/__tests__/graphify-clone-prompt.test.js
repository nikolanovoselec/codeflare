// Verifies REQ-AGENT-025 AC1+AC2: the PostToolUse clone-prompt hook
// recognises `git clone` and `gh repo clone` across the three supported
// tool-input shapes (Bash, mcp__context-mode__ctx_execute, ctx_batch_execute),
// rejects substring false positives, extracts the cloned directory from
// tool_response stdout (including MCP content shape), and is idempotent
// per cloned dir.
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(__dirname, '../../preseed/agents/claude/plugins/graphify/scripts/graphify-clone-prompt.sh');

function runHook(input, fakeHome, sessionId) {
  // The hook now scopes its idempotency marker dir by session_id from
  // the hook envelope (truly per-session). Tests inject a unique
  // session_id so different test cases never share marker state.
  const sid = sessionId || `test-session-${Math.random().toString(36).slice(2, 10)}`;
  const envelope = { session_id: sid, ...input };
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(envelope),
    encoding: 'utf-8',
    env: { ...process.env, HOME: fakeHome },
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    status: result.status,
    sessionId: sid,
    json: result.stdout.trim() ? safeParse(result.stdout) : null,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

describe('graphify-clone-prompt.sh / REQ-AGENT-025 (post-clone graph triage)', () => {
  let baseTmp;
  before(() => { baseTmp = mkdtempSync(join(tmpdir(), 'gf-clone-')); });

  let fakeHome;
  beforeEach(() => {
    fakeHome = mkdtempSync(join(baseTmp, 'home-'));
    mkdirSync(join(fakeHome, '.cache'), { recursive: true });
  });

  it('Bash shape: real git clone produces a triage directive with the target dir', () => {
    const { json, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://github.com/foo/bar /tmp/bar' },
      tool_response: { stdout: "Cloning into '/tmp/bar'...\nremote: Enumerating objects" },
    }, fakeHome);
    assert.equal(status, 0);
    assert.ok(json, 'must emit JSON');
    assert.equal(json.hookSpecificOutput.hookEventName, 'PostToolUse');
    assert.ok(
      json.hookSpecificOutput.additionalContext.includes('/tmp/bar'),
      'directive must name the cloned directory'
    );
    assert.ok(
      json.hookSpecificOutput.additionalContext.includes('AskUserQuestion'),
      'directive must instruct the agent to use AskUserQuestion'
    );
  });

  it('Bash shape: gh repo clone is recognised as well', () => {
    const { json } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'gh repo clone foo/bar /tmp/ghbar' },
      tool_response: { stdout: "Cloning into '/tmp/ghbar'..." },
    }, fakeHome);
    assert.ok(json, 'gh repo clone must trigger the directive');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('/tmp/ghbar'));
  });

  it('ctx_execute shape: shell-language code is parsed correctly (issue #317 multi-shape)', () => {
    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      tool_input: { language: 'shell', code: 'git clone https://github.com/foo/bar /tmp/ctxbar' },
      tool_response: { stdout: "Cloning into '/tmp/ctxbar'..." },
    }, fakeHome);
    assert.ok(json, 'ctx_execute shape must trigger the directive');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('/tmp/ctxbar'));
  });

  it('ctx_batch_execute shape: commands array is joined and matched', () => {
    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_batch_execute',
      tool_input: {
        commands: [
          { label: 'prep', command: 'mkdir -p /tmp/work' },
          { label: 'clone', command: 'git clone https://example.com/repo /tmp/work/repo' },
        ],
      },
      tool_response: { stdout: "Cloning into '/tmp/work/repo'..." },
    }, fakeHome);
    assert.ok(json, 'ctx_batch_execute shape must trigger the directive');
    assert.ok(json.hookSpecificOutput.additionalContext.includes('/tmp/work/repo'));
  });

  it('false positive: echo "git clone foo" must NOT trigger', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo "instructions: git clone foo"' },
      tool_response: { stdout: '' },
    }, fakeHome);
    assert.equal(status, 0);
    assert.equal(stdout, '', 'no directive should be emitted for echoed substrings');
  });

  it('false positive: shell-comment-only mention must NOT trigger', () => {
    const { stdout } = runHook({
      tool_name: 'Bash',
      tool_input: { command: '# remember: git clone things go here later' },
      tool_response: { stdout: '' },
    }, fakeHome);
    assert.equal(stdout, '', 'comment-only mention must not trigger');
  });

  it('chained command: git clone after && is anchored and triggers', () => {
    const { json } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'mkdir -p /tmp/x && git clone https://example.com/repo /tmp/x/repo' },
      tool_response: { stdout: "Cloning into '/tmp/x/repo'..." },
    }, fakeHome);
    assert.ok(json, 'git clone after && is a valid command position');
  });

  it('idempotency: same target dir prompts once per session (marker dir is session-scoped)', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://github.com/foo/bar /tmp/idempotent' },
      tool_response: { stdout: "Cloning into '/tmp/idempotent'..." },
    };
    const sharedSid = 'session-idempotent-test';
    const first = runHook(input, fakeHome, sharedSid);
    assert.ok(first.json, 'first invocation emits directive');
    const second = runHook(input, fakeHome, sharedSid);
    assert.equal(second.stdout, '', 'second invocation in SAME session for the same dir must be a no-op');
  });

  it('idempotency: marker is session-scoped (different session_id re-prompts even for same dir)', () => {
    const input = {
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://github.com/foo/bar /tmp/cross-session' },
      tool_response: { stdout: "Cloning into '/tmp/cross-session'..." },
    };
    const sessionA = runHook(input, fakeHome, 'session-A');
    const sessionB = runHook(input, fakeHome, 'session-B');
    assert.ok(sessionA.json, 'session A: directive emitted');
    assert.ok(
      sessionB.json,
      'session B: directive must be re-emitted - markers scoped by session_id, so a fresh session re-triages the same clone'
    );
  });

  it('idempotency: different target dirs each get prompted', () => {
    const a = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://example.com/a /tmp/dirA' },
      tool_response: { stdout: "Cloning into '/tmp/dirA'..." },
    }, fakeHome);
    const b = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'git clone https://example.com/b /tmp/dirB' },
      tool_response: { stdout: "Cloning into '/tmp/dirB'..." },
    }, fakeHome);
    assert.ok(a.json && b.json, 'distinct dirs each emit a directive');
    assert.ok(a.json.hookSpecificOutput.additionalContext.includes('/tmp/dirA'));
    assert.ok(b.json.hookSpecificOutput.additionalContext.includes('/tmp/dirB'));
  });

  it('MCP content shape: ctx_execute with .tool_response.content[].text emits directive (regression: bug fixed where stdout-shape parsing missed MCP responses entirely, causing the hook to leak the placeholder "the repo you just cloned" and skip graph-present detection)', () => {
    const { json, stdout } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: '/agent/cwd',
      tool_input: { language: 'shell', code: 'git clone https://github.com/foo/bar /tmp/mcp-bar' },
      tool_response: { content: [ { type: 'text', text: "Cloning into '/tmp/mcp-bar'..." } ] },
    }, fakeHome);
    assert.ok(json, 'MCP content shape must produce a directive');
    assert.ok(
      json.hookSpecificOutput.additionalContext.includes('/tmp/mcp-bar'),
      'directive must name the cloned dir extracted from MCP content array'
    );
    assert.ok(
      !json.hookSpecificOutput.additionalContext.includes('the repo you just cloned'),
      'directive must NOT contain the placeholder string when extraction succeeded'
    );
  });

  it('MCP content shape: ctx_execute + relative target + graph present at $cwd/<target>/graphify-out/graph.json -> graph-present branch (real-world bug: cloning codeflare while graphify-out was committed misfired the no-graph branch)', () => {
    const targetParent = mkdtempSync(join(baseTmp, 'mcp-rel-'));
    const repoName = 'repo-with-graph';
    mkdirSync(join(targetParent, repoName, 'graphify-out'), { recursive: true });
    writeFileSync(join(targetParent, repoName, 'graphify-out', 'graph.json'), '{}');

    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: targetParent,
      tool_input: { language: 'shell', code: `git clone https://github.com/foo/bar ${repoName}` },
      tool_response: { content: [ { type: 'text', text: `Cloning into '${repoName}'...` } ] },
    }, fakeHome);
    assert.ok(json, 'MCP + relative + graph present must still emit a directive');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(/do NOT prompt/i.test(ctx), 'graph-present branch must be taken when graph exists at $cwd/<target>/graphify-out/graph.json');
    assert.ok(!ctx.includes('AskUserQuestion'), 'graph-present branch must NOT mention AskUserQuestion');
  });

  it('URL-derivation fallback: when stdout has no Cloning line, repo name is parsed from clone URL and resolved against cwd (catches grep-filtered or stderr-only clone output)', () => {
    const cwdDir = mkdtempSync(join(baseTmp, 'url-derive-'));
    mkdirSync(join(cwdDir, 'codeflare', 'graphify-out'), { recursive: true });
    writeFileSync(join(cwdDir, 'codeflare', 'graphify-out', 'graph.json'), '{}');

    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: cwdDir,
      tool_input: { language: 'shell', code: 'git clone https://github.com/nikolanovoselec/codeflare.git' },
      tool_response: { content: [ { type: 'text', text: '(no Cloning line; stdout was grep-filtered)' } ] },
    }, fakeHome);
    assert.ok(json, 'URL-derivation must still produce a directive');
    assert.ok(
      /do NOT prompt/i.test(json.hookSpecificOutput.additionalContext),
      'fallback must detect existing graph via $cwd/<url-basename>/graphify-out/graph.json'
    );
  });

  it('ctx_batch_execute MCP content: commands array + .content[].text response is parsed correctly', () => {
    const targetParent = mkdtempSync(join(baseTmp, 'batch-'));
    mkdirSync(join(targetParent, 'repo', 'graphify-out'), { recursive: true });
    writeFileSync(join(targetParent, 'repo', 'graphify-out', 'graph.json'), '{}');

    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_batch_execute',
      cwd: targetParent,
      tool_input: { commands: [
        { label: 'prep',  command: 'mkdir -p /tmp/x' },
        { label: 'clone', command: 'git clone https://x/y repo' },
      ]},
      tool_response: { content: [ { type: 'text', text: "Cloning into 'repo'..." } ] },
    }, fakeHome);
    assert.ok(json);
    assert.ok(/do NOT prompt/i.test(json.hookSpecificOutput.additionalContext));
  });

  it('URL-derivation skips CLI flags: `git clone --depth 1 <url>` derives the repo name, not the flag value (regression: bare-token awk picked "1" as the target)', () => {
    const cwdDir = mkdtempSync(join(baseTmp, 'depth-flag-'));
    mkdirSync(join(cwdDir, 'codeflare', 'graphify-out'), { recursive: true });
    writeFileSync(join(cwdDir, 'codeflare', 'graphify-out', 'graph.json'), '{}');

    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: cwdDir,
      tool_input: { language: 'shell', code: 'git clone --depth 1 https://github.com/nikolanovoselec/codeflare.git' },
      tool_response: { content: [ { type: 'text', text: '(stdout filtered, no Cloning line)' } ] },
    }, fakeHome);
    assert.ok(json, '`--depth 1` form must still produce a directive');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(
      /do NOT prompt/i.test(ctx),
      'URL-derivation must skip the --depth flag value and find the existing graph at <cwd>/codeflare/graphify-out/graph.json'
    );
    assert.ok(
      !/[/`]1[/`]/.test(ctx) && !ctx.includes('cwd/1'),
      'directive must NOT cite "1" (the --depth value) as the cloned target'
    );
  });

  it('URL-derivation handles `--branch foo --depth 1` (multiple flag pairs before the URL)', () => {
    const cwdDir = mkdtempSync(join(baseTmp, 'multi-flag-'));
    mkdirSync(join(cwdDir, 'myrepo', 'graphify-out'), { recursive: true });
    writeFileSync(join(cwdDir, 'myrepo', 'graphify-out', 'graph.json'), '{}');

    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: cwdDir,
      tool_input: { language: 'shell', code: 'git clone --branch main --depth 1 https://x/myrepo.git' },
      tool_response: { content: [ { type: 'text', text: '(no Cloning line)' } ] },
    }, fakeHome);
    assert.ok(json);
    assert.ok(/do NOT prompt/i.test(json.hookSpecificOutput.additionalContext));
  });

  it('URL-derivation handles `--depth=1` long-opt with equals (no separate value token to skip)', () => {
    const cwdDir = mkdtempSync(join(baseTmp, 'eq-flag-'));
    mkdirSync(join(cwdDir, 'repo', 'graphify-out'), { recursive: true });
    writeFileSync(join(cwdDir, 'repo', 'graphify-out', 'graph.json'), '{}');

    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: cwdDir,
      tool_input: { language: 'shell', code: 'git clone --depth=1 https://x/repo.git' },
      tool_response: { content: [ { type: 'text', text: '(no Cloning line)' } ] },
    }, fakeHome);
    assert.ok(json);
    assert.ok(/do NOT prompt/i.test(json.hookSpecificOutput.additionalContext));
  });

  it('URL-derivation strips trailing `;` / `&&` separator from derived token (regression: chained command poisoned the target)', () => {
    const cwdDir = mkdtempSync(join(baseTmp, 'chained-'));
    mkdirSync(join(cwdDir, 'repo', 'graphify-out'), { recursive: true });
    writeFileSync(join(cwdDir, 'repo', 'graphify-out', 'graph.json'), '{}');

    const { json } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: cwdDir,
      tool_input: { language: 'shell', code: 'git clone https://x/repo.git; echo done' },
      tool_response: { content: [ { type: 'text', text: '(no Cloning line)' } ] },
    }, fakeHome);
    assert.ok(json);
    assert.ok(/do NOT prompt/i.test(json.hookSpecificOutput.additionalContext));
  });

  it('jq-resilience: non-array `content` (string) does not crash; falls through to URL-derivation', () => {
    const cwdDir = mkdtempSync(join(baseTmp, 'jq-resil-'));
    mkdirSync(join(cwdDir, 'repo', 'graphify-out'), { recursive: true });
    writeFileSync(join(cwdDir, 'repo', 'graphify-out', 'graph.json'), '{}');

    const { json, status } = runHook({
      tool_name: 'mcp__context-mode__ctx_execute',
      cwd: cwdDir,
      tool_input: { language: 'shell', code: 'git clone https://x/repo.git' },
      tool_response: { content: 'oops not an array' },
    }, fakeHome);
    assert.equal(status, 0, 'hook must never exit non-zero on pathological content shape');
    assert.ok(json, 'pathological content shape must still fall through to URL-derivation');
    assert.ok(/do NOT prompt/i.test(json.hookSpecificOutput.additionalContext));
  });

  it('fail-safe: malformed input exits 0 with no output', () => {
    const result = spawnSync('bash', [HOOK], {
      input: 'not-valid-json {{{',
      encoding: 'utf-8',
      env: { ...process.env, HOME: fakeHome },
    });
    assert.equal(result.status, 0, 'hook must never exit non-zero (sessions cannot crash because of it)');
    assert.equal(result.stdout.trim(), '');
  });

  it('pre-filter: input without the substring "clone" exits silently', () => {
    const { stdout, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls -la /tmp' },
      tool_response: { stdout: 'a b c' },
    }, fakeHome);
    assert.equal(status, 0);
    assert.equal(stdout, '');
  });

  it('graph-present branch: cloned dir already has graphify-out/graph.json -> directive says "do NOT prompt" and recommends graphify update', () => {
    // Stage a target dir with a pre-existing graph
    const targetDir = mkdtempSync(join(baseTmp, 'with-graph-'));
    mkdirSync(join(targetDir, 'graphify-out'), { recursive: true });
    writeFileSync(join(targetDir, 'graphify-out', 'graph.json'), '{"nodes":[],"edges":[]}');

    const { json, status } = runHook({
      tool_name: 'Bash',
      tool_input: { command: `git clone https://github.com/foo/bar ${targetDir}` },
      tool_response: { stdout: `Cloning into '${targetDir}'...` },
    }, fakeHome);
    assert.equal(status, 0);
    assert.ok(json, 'graph-present clone must still emit a directive');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(
      /do NOT prompt/i.test(ctx),
      'graph-present directive must instruct the agent NOT to prompt'
    );
    assert.ok(
      ctx.includes('graphify update'),
      'graph-present directive must recommend `graphify update` for cheap AST refresh'
    );
    assert.ok(
      !ctx.includes('AskUserQuestion'),
      'graph-present directive must NOT mention AskUserQuestion'
    );
  });

  it('graph-absent branch: no graphify-out/graph.json -> directive instructs AskUserQuestion + /graphify full build', () => {
    const targetDir = mkdtempSync(join(baseTmp, 'no-graph-'));
    // No graphify-out/ created.

    const { json } = runHook({
      tool_name: 'Bash',
      tool_input: { command: `git clone https://github.com/foo/bar ${targetDir}` },
      tool_response: { stdout: `Cloning into '${targetDir}'...` },
    }, fakeHome);
    assert.ok(json, 'graph-absent clone must emit the triage directive');
    const ctx = json.hookSpecificOutput.additionalContext;
    assert.ok(
      ctx.includes('AskUserQuestion'),
      'graph-absent directive must instruct the agent to use AskUserQuestion'
    );
    assert.ok(
      ctx.includes('/graphify'),
      'graph-absent directive must reference the /graphify full-build command'
    );
    assert.ok(
      !ctx.includes('graphify update'),
      'graph-absent directive must NOT recommend `graphify update` (no graph to refresh)'
    );
  });
});
