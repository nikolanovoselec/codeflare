// Verifies REQ-AGENT-023 AC5: the PostToolUse active-repo hook writes
// the agent's current repo root to ~/.cache/codeflare-hooks/graphify-active-cwd
// across all matcher shapes (Bash, Edit/Write/Read/NotebookEdit,
// mcp__context-mode__ctx_execute / _file / batch). Resolution walks up
// from the candidate dir to the nearest ancestor containing .git/ or
// graphify-out/. Sentinel is only rewritten on change.
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
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

  after(() => {
    // rmSync removes symlinks as links (does NOT follow them), so the
    // per-test symHome is unlinked without recursing into realHome.
    // realHome is itself a subtree under baseTmp and gets removed
    // independently on the same pass. `force: true` swallows ENOENT
    // for anything an individual test already cleaned up.
    rmSync(baseTmp, { recursive: true, force: true });
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

  // REQ-VAULT-004 AC4: vault skip. Entrypoint init seeds the vault under
  // tag `user_vault`; a tool call inside the vault must NOT re-tag it
  // with the directory basename (`.user_vault`) and the prune-on-switch
  // logic must never get a chance to remove the entrypoint snapshot.
  it('vault skip: candidate at $HOME/.user_vault exits without sentinel write', () => {
    const fakeHome = mkdtempSync(join(baseTmp, 'home-'));
    const vault = join(fakeHome, '.user_vault');
    mkdirSync(join(vault, 'graphify-out'), { recursive: true });
    mkdirSync(join(vault, 'notes'));
    writeFileSync(join(vault, 'graphify-out', 'graph.json'), '{"nodes":[]}');

    const result = spawnSync('bash', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: join(vault, 'notes', 'foo.md') },
      }),
      encoding: 'utf-8',
      env: { ...process.env, GRAPHIFY_SENTINEL_DIR: sentinelDir, HOME: fakeHome },
    });
    assert.equal(result.status, 0);
    assert.equal(sentinel(sentinelDir), null, 'vault must not be written to the active-repo sentinel');
  });

  it('vault skip: a tool call inside the vault does NOT clobber the active repo sentinel', () => {
    const fakeHome = mkdtempSync(join(baseTmp, 'home-'));
    const vault = join(fakeHome, '.user_vault');
    mkdirSync(join(vault, 'graphify-out'), { recursive: true });
    mkdirSync(join(vault, 'notes'));
    writeFileSync(join(vault, 'graphify-out', 'graph.json'), '{"nodes":[]}');

    const repoA = makeRepo(workspace, 'repo-a');
    // Prime the sentinel with repoA via a normal call
    runHook(
      { tool_name: 'Bash', cwd: repoA, tool_input: { command: 'ls' } },
      sentinelDir
    );
    assert.equal(sentinel(sentinelDir), repoA);

    // Now simulate a tool call inside the vault (capture sonnet etc).
    // The hook must NOT rewrite the sentinel away from repoA.
    const result = spawnSync('bash', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: join(vault, 'raw', 'sessions', 'x.md') },
      }),
      encoding: 'utf-8',
      env: { ...process.env, GRAPHIFY_SENTINEL_DIR: sentinelDir, HOME: fakeHome },
    });
    assert.equal(result.status, 0);
    assert.equal(sentinel(sentinelDir), repoA, 'active repo must remain unchanged by a vault tool call');
  });

  // Regression: when $HOME is itself a symlink (or otherwise non-canonical),
  // the raw string `$HOME/.user_vault` does NOT match the canonicalized
  // REPO path. The production hook handles this via two guards (canonicalize
  // $HOME, OR basename match). Because the script hardcodes `.user_vault`
  // as the literal in BOTH branches, a test that uses the same literal
  // cannot isolate one branch from the other - both fire on a vault under
  // a symlinked $HOME. We therefore keep one union test for that case
  // (asserts the skip happens; doesn't claim to isolate which branch
  // caught it) AND one outside-$HOME test where only the basename branch
  // can possibly match (legitimate isolation for that branch).
  it('vault skip: symlinked $HOME (union of canonicalization + basename guards)', () => {
    const realHome = mkdtempSync(join(baseTmp, 'real-home-'));
    // randomUUID() under the already-unique `baseTmp`: no syscalls, no
    // TOCTOU window between rm and symlink, no millisecond-collision risk.
    const symHome = join(baseTmp, `sym-home-${randomUUID()}`);
    symlinkSync(realHome, symHome);
    const vault = join(realHome, '.user_vault');
    mkdirSync(join(vault, 'graphify-out'), { recursive: true });
    mkdirSync(join(vault, 'notes'));
    writeFileSync(join(vault, 'graphify-out', 'graph.json'), '{"nodes":[]}');

    const result = spawnSync('bash', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: join(symHome, '.user_vault', 'notes', 'foo.md') },
      }),
      encoding: 'utf-8',
      env: { ...process.env, GRAPHIFY_SENTINEL_DIR: sentinelDir, HOME: symHome },
    });
    assert.equal(result.status, 0);
    assert.equal(
      sentinel(sentinelDir),
      null,
      'symlinked HOME must still trigger the vault skip; raw-string compare would miss this',
    );
  });

  it('vault skip: basename fallback catches a vault reached from outside $HOME', () => {
    // Counter-test: vault lives OUTSIDE $HOME (so the canonicalized-$HOME
    // equality compare does NOT match), but is named `.user_vault`. The
    // basename fallback is the only guard that can fire here. Reverting
    // only the basename branch would leave this test red.
    const realHome = mkdtempSync(join(baseTmp, 'real-home-bn-'));
    const outsideVaultParent = mkdtempSync(join(baseTmp, 'outside-'));
    const vault = join(outsideVaultParent, '.user_vault');
    mkdirSync(join(vault, 'graphify-out'), { recursive: true });
    mkdirSync(join(vault, 'notes'));
    writeFileSync(join(vault, 'graphify-out', 'graph.json'), '{"nodes":[]}');

    const result = spawnSync('bash', [HOOK], {
      input: JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: join(vault, 'notes', 'foo.md') },
      }),
      encoding: 'utf-8',
      env: { ...process.env, GRAPHIFY_SENTINEL_DIR: sentinelDir, HOME: realHome },
    });
    assert.equal(result.status, 0);
    assert.equal(
      sentinel(sentinelDir),
      null,
      'a vault directory outside $HOME but named `.user_vault` must trigger the basename-fallback skip',
    );
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
  after(() => { rmSync(baseTmp, { recursive: true, force: true }); });
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
