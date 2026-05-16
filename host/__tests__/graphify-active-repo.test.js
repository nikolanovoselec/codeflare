// Verifies REQ-AGENT-023 AC5: the PostToolUse active-repo hook writes
// the agent's current repo root to ~/.cache/codeflare-hooks/graphify-active-cwd
// across all matcher shapes (Bash, Edit/Write/Read/NotebookEdit,
// mcp__context-mode__ctx_execute / _file / batch). Resolution walks up
// from the candidate dir to the nearest ancestor containing .git/ or
// graphify-out/. Sentinel is only rewritten on change.
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/graphify/scripts/graphify-active-repo.sh'
);

function runHook(input, sentinelDir) {
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: { ...process.env, GRAPHIFY_SENTINEL_DIR: sentinelDir },
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    status: result.status,
  };
}

function sentinel(sentinelDir) {
  const p = join(sentinelDir, 'graphify-active-cwd');
  return existsSync(p) ? readFileSync(p, 'utf-8').trim() : null;
}

function makeRepo(parent, name) {
  const repo = join(parent, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return repo;
}

describe('graphify-active-repo.sh', () => {
  let baseTmp, sentinelDir, workspace;

  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'gf-active-'));
  });

  beforeEach(() => {
    sentinelDir = mkdtempSync(join(baseTmp, 'sentinel-'));
    workspace = mkdtempSync(join(baseTmp, 'ws-'));
  });

  it('Bash shape: writes session cwd when it is inside a repo', () => {
    const repoA = makeRepo(workspace, 'repo-a');
    const { status } = runHook(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoA);
  });

  it('Edit shape: walks up from file_path to the repo root', () => {
    const repoA = makeRepo(workspace, 'repo-a');
    mkdirSync(join(repoA, 'src', 'sub'), { recursive: true });
    const { status } = runHook(
      {
        tool_name: 'Edit',
        tool_input: { file_path: join(repoA, 'src', 'sub', 'deep.py') },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoA);
  });

  it('Write and Read shapes also resolve via file_path', () => {
    const repoA = makeRepo(workspace, 'repo-a');
    runHook(
      { tool_name: 'Write', tool_input: { file_path: join(repoA, 'new.py') } },
      sentinelDir
    );
    assert.equal(sentinel(sentinelDir), repoA);

    const sentinelDir2 = mkdtempSync(join(baseTmp, 'sentinel2-'));
    runHook(
      { tool_name: 'Read', tool_input: { file_path: join(repoA, 'new.py') } },
      sentinelDir2
    );
    assert.equal(sentinel(sentinelDir2), repoA);
  });

  it('NotebookEdit shape: notebook_path is consulted instead of file_path', () => {
    const repoA = makeRepo(workspace, 'repo-a');
    const { status } = runHook(
      {
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: join(repoA, 'notebook.ipynb') },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoA);
  });

  it('ctx_execute shape: cd inside shell code resolves relative to session cwd', () => {
    const repoB = makeRepo(workspace, 'repo-b');
    const { status } = runHook(
      {
        tool_name: 'mcp__context-mode__ctx_execute',
        cwd: workspace,
        tool_input: { language: 'shell', code: 'cd repo-b && ls' },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoB);
  });

  it('ctx_execute shape: absolute cd path is honoured', () => {
    const repoB = makeRepo(workspace, 'repo-b');
    const { status } = runHook(
      {
        tool_name: 'mcp__context-mode__ctx_execute',
        cwd: workspace,
        tool_input: { language: 'shell', code: `cd ${repoB} && ls` },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoB);
  });

  it('ctx_execute shape: quoted path with spaces is parsed correctly', () => {
    const spacesRepo = makeRepo(workspace, 'repo with spaces');
    const { status } = runHook(
      {
        tool_name: 'mcp__context-mode__ctx_execute',
        cwd: workspace,
        tool_input: { language: 'shell', code: 'cd "repo with spaces" && ls' },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), spacesRepo);
  });

  it('ctx_batch_execute shape: iterates commands[] for cd targets', () => {
    const repoB = makeRepo(workspace, 'repo-b');
    const { status } = runHook(
      {
        tool_name: 'mcp__context-mode__ctx_batch_execute',
        cwd: workspace,
        tool_input: {
          commands: [
            { label: 'first', command: 'echo hi' },
            { label: 'switch', command: `cd ${repoB} && ls` },
          ],
        },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoB);
  });

  it('ctx_execute_file shape: same parsing as ctx_execute', () => {
    const repoB = makeRepo(workspace, 'repo-b');
    const { status } = runHook(
      {
        tool_name: 'mcp__context-mode__ctx_execute_file',
        cwd: workspace,
        tool_input: { language: 'shell', code: 'cd repo-b' },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoB);
  });

  it('git clone with flags: positional target dir is extracted', () => {
    const repoD = makeRepo(workspace, 'repo-d');
    const { status } = runHook(
      {
        tool_name: 'Bash',
        cwd: workspace,
        tool_input: {
          command: 'git clone --depth 1 -b main https://example.com/foo.git repo-d',
        },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoD);
  });

  it('gh repo clone with explicit target dir is detected', () => {
    const repoE = makeRepo(workspace, 'repo-e');
    const { status } = runHook(
      {
        tool_name: 'Bash',
        cwd: workspace,
        tool_input: { command: 'gh repo clone owner/foo repo-e' },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoE);
  });

  it('git clone URL with no explicit target: falls back to session cwd if not a repo', () => {
    // session cwd is workspace (not a repo), so no sentinel write
    const { status } = runHook(
      {
        tool_name: 'Bash',
        cwd: workspace,
        tool_input: { command: 'git clone https://example.com/foo.git' },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), null);
  });

  it('cwd not under any repo: no sentinel written', () => {
    const { status } = runHook(
      { tool_name: 'Bash', cwd: workspace, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), null);
  });

  it('unknown tool: exits 0 without touching sentinel', () => {
    const repoA = makeRepo(workspace, 'repo-a');
    // pre-populate the sentinel
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(sentinelDir, 'graphify-active-cwd'), repoA + '\n');

    const { status } = runHook(
      { tool_name: 'SomeOtherTool', cwd: repoA, tool_input: {} },
      sentinelDir
    );
    assert.equal(status, 0);
    // unchanged
    assert.equal(sentinel(sentinelDir), repoA);
  });

  it('sentinel only rewritten on change (idempotent)', () => {
    const repoA = makeRepo(workspace, 'repo-a');
    runHook(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    const sentinelPath = join(sentinelDir, 'graphify-active-cwd');

    // Backdate the file so a subsequent rewrite would visibly change mtime
    const past = new Date(Date.now() - 60_000);
    utimesSync(sentinelPath, past, past);
    const backdated = statSync(sentinelPath).mtimeMs;

    runHook(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls again' } },
      sentinelDir
    );
    const afterMtime = statSync(sentinelPath).mtimeMs;
    assert.equal(afterMtime, backdated, 'sentinel must NOT be rewritten when value unchanged');
  });

  it('repo switch: sentinel is rewritten with the new repo root', () => {
    const repoA = makeRepo(workspace, 'repo-a');
    const repoB = makeRepo(workspace, 'repo-b');
    runHook(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(sentinel(sentinelDir), repoA);
    runHook(
      { tool_name: 'Bash', cwd: repoB, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(sentinel(sentinelDir), repoB);
  });

  it('graphify-out/ also counts as a repo-root marker (not just .git/)', () => {
    const repoX = join(workspace, 'repo-x');
    mkdirSync(join(repoX, 'graphify-out'), { recursive: true });
    // No .git/, but graphify-out/ exists - should still be detected
    const { status } = runHook(
      { tool_name: 'Bash', cwd: repoX, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoX);
  });

  it('cd inside echo string is NOT a false positive', () => {
    const repoB = makeRepo(workspace, 'repo-b');
    // Real cd is to repo-b, but there is also an echo with "cd elsewhere"
    const { status } = runHook(
      {
        tool_name: 'mcp__context-mode__ctx_execute',
        cwd: workspace,
        tool_input: {
          language: 'shell',
          // The echo's cd should be skipped; the real cd is to repo-b
          code: 'echo "cd /tmp/elsewhere" && cd repo-b',
        },
      },
      sentinelDir
    );
    assert.equal(status, 0);
    assert.equal(sentinel(sentinelDir), repoB);
  });
});

// Tests for the single-active-repo global-graph maintenance logic
// added after production verification showed branch-switch and repo-
// switch staleness in the global graph. Strips graphify from PATH so
// the prune/add branches no-op cleanly without mutating the real
// ~/.graphify - we assert on sentinel state changes instead, which
// reliably reflects whether each code path was taken.
function runHookNoGraphify(input, sentinelDir) {
  const noGraphifyPath = '/usr/bin:/bin'; // no /usr/local/bin -> command -v graphify fails
  const result = spawnSync('bash', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    env: {
      ...process.env,
      GRAPHIFY_SENTINEL_DIR: sentinelDir,
      PATH: noGraphifyPath,
    },
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr, status: result.status };
}

describe('graphify-active-repo.sh single-active-repo maintenance', () => {
  let baseTmp, sentinelDir, workspace;
  before(() => { baseTmp = mkdtempSync(join(tmpdir(), 'gf-maint-')); });
  beforeEach(() => {
    sentinelDir = mkdtempSync(join(baseTmp, 'sentinel-'));
    workspace = mkdtempSync(join(baseTmp, 'ws-'));
  });

  function makeRepoWithGraph(parent, name) {
    const repo = makeRepo(parent, name);
    mkdirSync(join(repo, 'graphify-out'), { recursive: true });
    writeFileSync(join(repo, 'graphify-out', 'graph.json'), '{"nodes":[]}');
    return repo;
  }

  it('fast-path: same repo + graph mtime <= sentinel mtime -> exit 0, sentinel mtime unchanged', () => {
    const repoA = makeRepoWithGraph(workspace, 'repo-a');
    // Prime sentinel with repoA
    runHookNoGraphify(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    const sentinelPath = join(sentinelDir, 'graphify-active-cwd');
    // Set graph mtime to past so fast-path kicks in (graph older than sentinel)
    const past = (Date.now() / 1000) - 3600;
    utimesSync(join(repoA, 'graphify-out', 'graph.json'), past, past);
    // Ensure sentinel mtime is newer than graph
    const future = (Date.now() / 1000) + 1;
    utimesSync(sentinelPath, future, future);
    const before = statSync(sentinelPath).mtimeMs;
    // Re-run; should hit fast path and exit without touching sentinel
    const r = runHookNoGraphify(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(r.status, 0);
    const after = statSync(sentinelPath).mtimeMs;
    assert.equal(before, after, 'fast-path must not touch sentinel');
  });

  it('graph rebuild path: same repo + graph mtime > sentinel mtime -> sentinel mtime bumped', () => {
    const repoA = makeRepoWithGraph(workspace, 'repo-a');
    runHookNoGraphify(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    const sentinelPath = join(sentinelDir, 'graphify-active-cwd');
    // Force sentinel mtime older than graph (simulates /graphify rebuild after sentinel write)
    const past = (Date.now() / 1000) - 7200;
    utimesSync(sentinelPath, past, past);
    const future = (Date.now() / 1000) + 1;
    utimesSync(join(repoA, 'graphify-out', 'graph.json'), future, future);
    const before = statSync(sentinelPath).mtimeMs;
    const r = runHookNoGraphify(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(r.status, 0);
    const after = statSync(sentinelPath).mtimeMs;
    assert.ok(after > before,
      `graph-newer-than-sentinel must trigger the slow path and bump sentinel mtime (before=${before}, after=${after})`);
  });

  it('repo switch: sentinel value updated even when graphify CLI is unavailable', () => {
    const repoA = makeRepoWithGraph(workspace, 'repo-a');
    const repoB = makeRepoWithGraph(workspace, 'repo-b');
    runHookNoGraphify(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(sentinel(sentinelDir), repoA, 'sentinel should reflect first repo');
    // Switch to repoB; without graphify on PATH the global prune/add are
    // skipped, but the sentinel must still update so subsequent hook
    // fires see the new active repo.
    const r = runHookNoGraphify(
      { tool_name: 'Bash', cwd: repoB, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(r.status, 0);
    assert.equal(sentinel(sentinelDir), repoB, 'sentinel must update to new repo on switch');
  });

  it('first run: no prior sentinel -> writes it and exits cleanly', () => {
    const repoA = makeRepoWithGraph(workspace, 'repo-a');
    assert.equal(sentinel(sentinelDir), null, 'no sentinel before first run');
    const r = runHookNoGraphify(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(r.status, 0);
    assert.equal(sentinel(sentinelDir), repoA);
  });
});
