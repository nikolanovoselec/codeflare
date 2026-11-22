// Behavioral coverage of the pure git-clone resolution helpers for
// REQ-GITHUB-004 (running-session clone). The repo/ref validation + target-dir
// computation are extracted into host/src/git-clone.ts so they are unit-testable.
// The endpoint and startup shell paths are exercised against an ephemeral HTTP
// server, temporary workspace, and fake git executable at the bottom.
//
// Imports the COMPILED ../dist/git-clone.js (same pattern as
// final-sync-endpoint.test.js) — the test runner exercises the build output.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGitClone, resolveWorkspaceRoot, buildCloneArgs } from '../dist/git-clone.js';
import { createRequestHandler } from '../dist/request-router.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const WS = '/home/user/workspace';

function createFakeGit(root) {
  const bin = join(root, 'bin');
  const log = join(root, 'git-args.log');
  const events = join(root, 'startup-events.log');
  mkdirSync(bin, { recursive: true });
  const git = join(bin, 'git');
  writeFileSync(git, `#!/usr/bin/env bash\nif [ -n "\${FAKE_EVENT_LOG:-}" ]; then printf 'git\\n' >> "$FAKE_EVENT_LOG"; fi\nif [ -n "\${FAKE_GIT_ENV_LOG:-}" ]; then printf 'GIT_TERMINAL_PROMPT=%s\\n' "\${GIT_TERMINAL_PROMPT:-unset}" >> "$FAKE_GIT_ENV_LOG"; fi\nprintf '%s\\n' "$@" >> "$FAKE_GIT_LOG"\nif [ -n "\${FAKE_GIT_SLEEP:-}" ]; then sleep "$FAKE_GIT_SLEEP"; fi\nexit "\${FAKE_GIT_STATUS:-0}"\n`);
  chmodSync(git, 0o755);
  return { bin, log, events, envLog: join(root, 'git-env.log') };
}

function extractStartupCloneBlock() {
  const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
  const start = entrypoint.indexOf('# REQ-GITHUB-014 / REQ-GITHUB-015: repository restore at container start.');
  const end = entrypoint.indexOf('\n)\n\ncomplete_managed_curation_startup()', start);
  assert.ok(start >= 0 && end > start, 'entrypoint startup clone block is missing');
  return entrypoint.slice(start, end);
}

function runStartupClone({ repo, ref, existing = false, gitStatus = 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'entrypoint-git-clone-'));
  const workspace = join(root, 'workspace');
  const fake = createFakeGit(root);
  mkdirSync(workspace, { recursive: true });
  const existingSentinel = join(workspace, repo.split('/').at(-1), 'sentinel.txt');
  if (existing) {
    mkdirSync(dirname(existingSentinel), { recursive: true });
    writeFileSync(existingSentinel, 'preserve me');
  }
  const env = {
    ...process.env,
    PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
    USER_WORKSPACE: workspace,
    GIT_CLONE_REPO: repo,
    CODEFLARE_CLONE_RESTORE_FLAG_FILE: join(root, 'clone-outcome'),
    GIT_CLONE_REF: ref ?? '',
    GITHUB_HOST: 'github.example.com',
    FAKE_GIT_LOG: fake.log,
    FAKE_EVENT_LOG: fake.events,
    FAKE_GIT_STATUS: String(gitStatus),
  };
  const script = `${extractStartupCloneBlock()}\nprintf 'autostart\\n' >> "$FAKE_EVENT_LOG"\n`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
  return { root, workspace, fake, result, existingSentinel };
}

/**
 * REQ-GITHUB-015: drive the same startup block with a multi-repository target
 * list. Real shell, real `timeout`, fake git.
 */
function runStartupClones({ targets, existingDirs = [], gitStatus = 0, gitSleep, perRepoTimeout, totalBudget, timeoutScale }) {
  const root = mkdtempSync(join(tmpdir(), 'entrypoint-clone-targets-'));
  const workspace = join(root, 'workspace');
  const fake = createFakeGit(root);
  const outcome = join(root, 'clone-outcome');
  if (timeoutScale !== undefined) {
    // The executable protocol peer rescales only wall time; real GNU timeout
    // still kills the real sleeping child. Production shell is unchanged.
    const timeout = join(fake.bin, 'timeout');
    writeFileSync(timeout, `#!/usr/bin/env bash\nseconds="$1"\nprintf '%s\\n' "$seconds" >> '${join(root, 'timeout-seconds')}'\nshift\nscaled=$(awk -v seconds="$seconds" 'BEGIN { print seconds * ${timeoutScale} }')\nexec /usr/bin/timeout "$scaled" "$@"\n`);
    chmodSync(timeout, 0o755);
  }
  writeFileSync(fake.log, '');
  mkdirSync(workspace, { recursive: true });
  for (const dir of existingDirs) mkdirSync(join(workspace, dir), { recursive: true });
  const env = {
    ...process.env,
    PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
    USER_WORKSPACE: workspace,
    GIT_CLONE_TARGETS: targets,
    CODEFLARE_CLONE_RESTORE_FLAG_FILE: outcome,
    GITHUB_HOST: 'github.example.com',
    FAKE_GIT_LOG: fake.log,
    FAKE_EVENT_LOG: fake.events,
    FAKE_GIT_ENV_LOG: fake.envLog,
    FAKE_GIT_STATUS: String(gitStatus),
    ...(gitSleep === undefined ? {} : { FAKE_GIT_SLEEP: String(gitSleep) }),
    ...(perRepoTimeout === undefined ? {} : { GIT_CLONE_PER_REPO_TIMEOUT_SECONDS: String(perRepoTimeout) }),
    ...(totalBudget === undefined ? {} : { GIT_CLONE_TOTAL_BUDGET_SECONDS: String(totalBudget) }),
  };
  delete env.GIT_CLONE_REPO;
  delete env.GIT_CLONE_REF;
  if (perRepoTimeout === undefined) delete env.GIT_CLONE_PER_REPO_TIMEOUT_SECONDS;
  if (totalBudget === undefined) delete env.GIT_CLONE_TOTAL_BUDGET_SECONDS;
  const script = `${extractStartupCloneBlock()}\nprintf 'autostart\\n' >> "$FAKE_EVENT_LOG"\n`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
  return { root, workspace, fake, result, outcome };
}

/** Clone target directories in the order git was asked to create them. */
function clonedDirs(fake, workspace) {
  const args = readFileSync(fake.log, 'utf8').trim().split('\n');
  return args.filter((line) => line.startsWith(`${workspace}/`)).map((line) => line.slice(workspace.length + 1));
}

describe('REQ-GITHUB-004: resolveGitClone validation + dir computation', () => {
  it('resolves a valid owner/name repo to <workspace>/<name>', () => {
    const r = resolveGitClone('octo/hello-world', undefined, WS);
    assert.equal(r.ok, true);
    assert.equal(r.repoName, 'hello-world');
    assert.equal(r.dir, '/home/user/workspace/hello-world');
    assert.equal(r.ref, undefined);
  });

  it('preserves a trailing .git in the validated repository basename', () => {
    const r = resolveGitClone('octo/hello-world.git', undefined, WS);
    assert.equal(r.ok, true);
    assert.equal(r.repoName, 'hello-world.git');
    assert.equal(r.dir, '/home/user/workspace/hello-world.git');
  });

  it('normalizes the workspace root and keeps the target as its direct child', () => {
    const r = resolveGitClone('octo/hello-world', undefined, `${WS}/nested/..`);
    assert.equal(r.ok, true);
    assert.equal(r.dir, '/home/user/workspace/hello-world');
  });

  it('carries a valid ref through (including nested refs)', () => {
    const r = resolveGitClone('octo/repo', 'feature/x', WS);
    assert.equal(r.ok, true);
    assert.equal(r.ref, 'feature/x');
  });

  it('rejects a repo without an owner/name slash', () => {
    assert.equal(resolveGitClone('notvalid', undefined, WS).ok, false);
  });

  it('rejects a repo with path-traversal segments', () => {
    assert.equal(resolveGitClone('octo/../../etc', undefined, WS).ok, false);
  });

  it('rejects dot segments but preserves a safe dot-prefixed basename verbatim', () => {
    assert.equal(resolveGitClone('octo/..', undefined, WS).ok, false);
    assert.equal(resolveGitClone('octo/.', undefined, WS).ok, false);
    const safe = resolveGitClone('a/..git', undefined, WS);
    assert.equal(safe.ok, true);
    assert.equal(safe.repoName, '..git');
    assert.equal(safe.dir, '/home/user/workspace/..git');
  });

  it('rejects a non-string repo', () => {
    assert.equal(resolveGitClone(42, undefined, WS).ok, false);
    assert.equal(resolveGitClone(undefined, undefined, WS).ok, false);
  });

  it('rejects a ref containing a space (shell/arg-injection guard)', () => {
    assert.equal(resolveGitClone('octo/repo', 'main; rm -rf', WS).ok, false);
  });

  it('rejects a ref starting with a dash (option-injection guard)', () => {
    // Both the `=`-bearing form AND a bare option-leading dash must be rejected:
    // a ref like `--upload-pack` (no `=`) is the git argument-injection vector
    // and the charset alone (which permits `-`) would let it through.
    assert.equal(resolveGitClone('octo/repo', '--upload-pack=evil', WS).ok, false);
    assert.equal(resolveGitClone('octo/repo', '--upload-pack', WS).ok, false);
    assert.equal(resolveGitClone('octo/repo', '-rf', WS).ok, false);
  });

  it('accepts a missing ref (undefined / null) as ref-less', () => {
    assert.equal(resolveGitClone('octo/repo', undefined, WS).ok, true);
    assert.equal(resolveGitClone('octo/repo', null, WS).ok, true);
  });
});

describe('REQ-GITHUB-004: resolveWorkspaceRoot', () => {
  it('prefers USER_WORKSPACE when set', () => {
    assert.equal(resolveWorkspaceRoot({ USER_WORKSPACE: '/srv/ws', HOME: '/home/u' }), '/srv/ws');
  });

  it('falls back to <HOME>/workspace', () => {
    assert.equal(resolveWorkspaceRoot({ HOME: '/home/u' }), '/home/u/workspace');
  });

  it('falls back to /home/user/workspace when neither is set', () => {
    assert.equal(resolveWorkspaceRoot({}), '/home/user/workspace');
  });
});

describe('REQ-GITHUB-004: buildCloneArgs (argv, never a shell string)', () => {
  it('builds clone -- <url> <dir> without --branch when ref absent', () => {
    const args = buildCloneArgs('octo/repo', undefined, '/ws/repo', 'github.com');
    // `--` terminates option parsing so the URL/dir can never be read as flags.
    assert.deepEqual(args, ['clone', '--', 'https://github.com/octo/repo.git', '/ws/repo']);
  });

  it('inserts --branch=<ref> (joined) before the -- separator when ref present', () => {
    const args = buildCloneArgs('octo/repo', 'develop', '/ws/repo', 'github.com');
    // Joined form so a ref can never become a standalone option token.
    assert.deepEqual(args, ['clone', '--branch=develop', '--', 'https://github.com/octo/repo.git', '/ws/repo']);
  });

  it('uses the supplied GitHub host (data-residency tenants)', () => {
    const args = buildCloneArgs('octo/repo', undefined, '/ws/repo', 'ghe.example.com');
    assert.ok(args.includes('https://ghe.example.com/octo/repo.git'));
  });

  it('REQ-GITHUB-004: preserves one existing .git suffix in the remote URL instead of duplicating it', () => {
    const args = buildCloneArgs('octo/repo.git', undefined, '/ws/repo.git', 'github.com');
    assert.deepEqual(args, ['clone', '--', 'https://github.com/octo/repo.git', '/ws/repo.git']);
  });

  it('keeps the url and dir as separate argv entries (no shell interpolation)', () => {
    const args = buildCloneArgs('octo/repo', undefined, '/ws/repo', 'github.com');
    // dir is its own array element; never concatenated into the url.
    assert.equal(args[args.length - 1], '/ws/repo');
    assert.equal(args.filter((a) => a.includes(' ')).length, 0);
  });
});

function routerDeps(overrides = {}) {
  return {
    sessionManager: { size: 0, list: () => [], getOrCreate: () => null, delete: () => false },
    wsEventLog: [],
    activityTracker: { recordHeartbeat: () => {}, recordInput: () => {}, getActivityInfo: () => ({}) },
    log: () => {},
    serverStartTime: Date.now(),
    readiness: () => ({ prewarmReady: true, initFlagObserved: true, terminalServiceReady: true }),
    silverbullet: { host: '127.0.0.1', port: 1 },
    openvscode: { host: '127.0.0.1', port: 1 },
    ...overrides,
  };
}

async function withRouter(overrides, run) {
  const server = http.createServer(createRequestHandler(routerDeps(overrides)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await run(server.address().port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        authorization: 'Bearer clone-test-token',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(responseBody) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('REQ-GITHUB-004: git-clone HTTP boundary (behavioral)', () => {
  it('REQ-GITHUB-004: returns the cloned path and invokes git with safe argv, preserving a .git basename', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-clone-route-'));
    const workspace = join(root, 'workspace');
    const fake = createFakeGit(root);
    mkdirSync(workspace);
    const saved = {
      token: process.env.CONTAINER_AUTH_TOKEN,
      workspace: process.env.USER_WORKSPACE,
      path: process.env.PATH,
      log: process.env.FAKE_GIT_LOG,
      status: process.env.FAKE_GIT_STATUS,
      host: process.env.GITHUB_HOST,
    };
    Object.assign(process.env, {
      CONTAINER_AUTH_TOKEN: 'clone-test-token',
      USER_WORKSPACE: workspace,
      PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: fake.log,
      FAKE_GIT_STATUS: '0',
      GITHUB_HOST: 'github.com',
    });
    try {
      const response = await withRouter({}, (port) => postJson(port, '/internal/git-clone', {
        repo: 'octo/repo.git',
        ref: 'feature/safe',
      }));

      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { status: 'cloned', path: join(workspace, 'repo.git') });
      assert.deepEqual(readFileSync(fake.log, 'utf8').trim().split('\n'), [
        'clone',
        '--branch=feature/safe',
        '--',
        'https://github.com/octo/repo.git',
        join(workspace, 'repo.git'),
      ]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        const key = name === 'token' ? 'CONTAINER_AUTH_TOKEN'
          : name === 'workspace' ? 'USER_WORKSPACE'
            : name === 'path' ? 'PATH'
              : name === 'log' ? 'FAKE_GIT_LOG'
                : name === 'status' ? 'FAKE_GIT_STATUS' : 'GITHUB_HOST';
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('REQ-GITHUB-004: returns 409 without invoking git when the resolved target exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-clone-collision-'));
    const workspace = join(root, 'workspace');
    const fake = createFakeGit(root);
    mkdirSync(join(workspace, 'repo'), { recursive: true });
    const savedToken = process.env.CONTAINER_AUTH_TOKEN;
    const savedWorkspace = process.env.USER_WORKSPACE;
    const savedPath = process.env.PATH;
    const savedLog = process.env.FAKE_GIT_LOG;
    Object.assign(process.env, {
      CONTAINER_AUTH_TOKEN: 'clone-test-token',
      USER_WORKSPACE: workspace,
      PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: fake.log,
    });
    try {
      const response = await withRouter({}, (port) => postJson(port, '/internal/git-clone', { repo: 'octo/repo' }));
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'CLONE_TARGET_EXISTS');
      assert.equal(existsSync(fake.log), false);
    } finally {
      if (savedToken === undefined) delete process.env.CONTAINER_AUTH_TOKEN; else process.env.CONTAINER_AUTH_TOKEN = savedToken;
      if (savedWorkspace === undefined) delete process.env.USER_WORKSPACE; else process.env.USER_WORKSPACE = savedWorkspace;
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      if (savedLog === undefined) delete process.env.FAKE_GIT_LOG; else process.env.FAKE_GIT_LOG = savedLog;
    }
  });

  it('REQ-GITHUB-004: maps a nonzero git exit to 502 and a bounded overrun to 504', async () => {
    const root = mkdtempSync(join(tmpdir(), 'git-clone-failures-'));
    const workspace = join(root, 'workspace');
    const fake = createFakeGit(root);
    mkdirSync(workspace);
    const saved = { ...process.env };
    Object.assign(process.env, {
      CONTAINER_AUTH_TOKEN: 'clone-test-token',
      USER_WORKSPACE: workspace,
      PATH: `${fake.bin}:${process.env.PATH ?? ''}`,
      FAKE_GIT_LOG: fake.log,
      FAKE_GIT_STATUS: '7',
      GITHUB_HOST: 'github.com',
    });
    try {
      const failed = await withRouter({}, (port) => postJson(port, '/internal/git-clone', { repo: 'octo/fails' }));
      assert.equal(failed.status, 502);
      assert.equal(failed.body.code, 'CLONE_FAILED');

      process.env.FAKE_GIT_STATUS = '0';
      process.env.FAKE_GIT_SLEEP = '1';
      const realSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback) => realSetTimeout(callback, 0));
      try {
        const timedOut = await withRouter({}, (port) => postJson(port, '/internal/git-clone', { repo: 'octo/slow' }));
        assert.equal(timedOut.status, 504);
        assert.equal(timedOut.body.code, 'CLONE_TIMEOUT');
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

describe('REQ-GITHUB-014: entrypoint startup clone path (real shell behavior)', () => {
  it('REQ-GITHUB-014 AC3: preserves a validated .git basename, branches safely, and keeps argv separated', () => {
    const { workspace, fake, result } = runStartupClone({ repo: 'octo/repo.git', ref: 'feature/safe' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(fake.log, 'utf8').trim().split('\n'), [
      'clone',
      '--branch',
      'feature/safe',
      '--',
      'https://github.example.com/octo/repo.git',
      join(workspace, 'repo.git'),
    ]);
    assert.deepEqual(readFileSync(fake.events, 'utf8').trim().split('\n'), ['git', 'autostart']);
  });

  it('REQ-GITHUB-014 AC6+AC7: rejects option-leading refs and refuses an existing target without invoking git', () => {
    const invalid = runStartupClone({ repo: 'octo/repo', ref: '--upload-pack' });
    assert.equal(invalid.result.status, 0, invalid.result.stderr);
    assert.match(invalid.result.stdout, /Skipping clone: invalid repo\/ref/);
    assert.equal(existsSync(invalid.fake.log), false);

    const collision = runStartupClone({ repo: 'octo/repo', existing: true });
    assert.equal(collision.result.status, 0, collision.result.stderr);
    assert.match(collision.result.stdout, /already exists \(collision refuse\)/);
    assert.equal(existsSync(collision.fake.log), false);
    assert.equal(readFileSync(collision.existingSentinel, 'utf8'), 'preserve me');
  });

  it('REQ-GITHUB-014 AC4+AC5: logs a clone failure and continues startup successfully', () => {
    const { fake, result } = runStartupClone({ repo: 'octo/repo', gitStatus: 7 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clone failed for octo\/repo; continuing startup/);
    assert.deepEqual(readFileSync(fake.events, 'utf8').trim().split('\n'), ['git', 'autostart']);
  });
});

describe('REQ-GITHUB-015: bounded multi-repository restore (real shell behavior)', () => {
  it('REQ-GITHUB-320: publishes successful and partial restore outcomes', t => {
    for (const [gitStatus, expected] of [[0, 'complete'], [7, 'issues']]) {
      const run = runStartupClones({ targets: 'octo/api octo/web', gitStatus });
      t.after(() => rmSync(run.root, { recursive: true, force: true }));
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(readFileSync(run.outcome, 'utf8').trim(), expected);
    }
  });

  it('REQ-GITHUB-015 AC4: restores every tracked repository in order and leaves an existing folder alone', () => {
    const { workspace, fake, result } = runStartupClones({
      targets: 'octo/api#develop octo/web octo/kept',
      existingDirs: ['kept'],
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(clonedDirs(fake, workspace), ['api', 'web']);
    assert.match(result.stdout, /kept.*already exists \(collision refuse\)/);
    const args = readFileSync(fake.log, 'utf8').trim().split('\n');
    assert.ok(args.includes('--branch'), 'a target ref must reach git as --branch');
    assert.ok(args.includes('develop'));
    assert.ok(args.includes('https://github.example.com/octo/api.git'));
  });

  it('REQ-GITHUB-015 AC5: abandons a repository that exceeds its own time limit and still tries the next', () => {
    const { workspace, fake, result } = runStartupClones({
      targets: 'octo/slow octo/fast',
      gitSleep: 3,
      perRepoTimeout: 1,
      totalBudget: 60,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clone failed for octo\/slow/);
    assert.deepEqual(clonedDirs(fake, workspace), ['slow', 'fast']);
  });

  it('REQ-GITHUB-015 AC5: stops attempting repositories once the overall budget is spent', () => {
    const { workspace, fake, result } = runStartupClones({
      targets: 'octo/slow octo/skipped',
      gitSleep: 3,
      perRepoTimeout: 1,
      totalBudget: 1,
    });

    assert.equal(result.status, 0, result.stderr);
    // The wall-clock deadline may expire before even the first Git process starts.
    const attempted = clonedDirs(fake, workspace);
    assert.deepEqual(attempted, ['slow'].slice(0, attempted.length));
    assert.match(result.stdout, /clone budget exhausted/);
    assert.equal(readFileSync(fake.events, 'utf8').trim().split('\n').at(-1), 'autostart');
  });

  it('REQ-GITHUB-015 AC6+AC7: never prompts for credentials, logs failures, and always reaches autostart', () => {
    const { fake, result } = runStartupClones({ targets: 'octo/api octo/web', gitStatus: 7 });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /clone failed for octo\/api/);
    assert.match(result.stdout, /clone failed for octo\/web/);
    assert.deepEqual(readFileSync(fake.envLog, 'utf8').trim().split('\n'), [
      'GIT_TERMINAL_PROMPT=0',
      'GIT_TERMINAL_PROMPT=0',
    ]);
    assert.deepEqual(readFileSync(fake.events, 'utf8').trim().split('\n'), ['git', 'git', 'autostart']);
  });

  it('REQ-GITHUB-015 AC4: skips an invalid target without invoking git and keeps going', () => {
    const { workspace, fake, result } = runStartupClones({ targets: 'not-a-repo octo/api#--upload-pack octo/good' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(clonedDirs(fake, workspace), ['good']);
    assert.match(result.stdout, /Skipping clone: invalid repo\/ref/);
  });

  it('REQ-GITHUB-015 AC5: falls back to the default overall budget instead of aborting on a malformed override', () => {
    // Regression: `$(( ... ${GIT_CLONE_TOTAL_BUDGET_SECONDS:-180} ))` with a
    // non-numeric override used to abort the whole entrypoint under
    // `set -euo pipefail`, in a block documented as never aborting start.
    const { workspace, fake, result } = runStartupClones({
      targets: 'octo/api',
      totalBudget: 'not-a-number',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /integer expression expected/);
    assert.deepEqual(clonedDirs(fake, workspace), ['api']);
  });
});

describe('REQ-GITHUB-016 AC4: restore timeout settings at the executable boundary', () => {
  for (const [label, perRepoTimeout, outcome] of [
    ['default 120 seconds expires', undefined, 'issues'],
    ['zero disables timeout', 0, 'complete'],
    ['larger 600 seconds is not clamped', 600, 'complete'],
  ]) {
    it(label, t => {
      // 100x wall-time compression: a 300-second peer finishes under 0/600,
      // but is terminated by the default 120 deadline. No Git/network call.
      const run = runStartupClones({ targets: 'octo/timed', gitSleep: 3,
        perRepoTimeout, totalBudget: 60, timeoutScale: 0.01 });
      t.after(() => rmSync(run.root, { recursive: true, force: true }));
      assert.equal(run.result.status, 0, run.result.stderr);
      assert.equal(readFileSync(run.outcome, 'utf8').trim(), outcome);
      assert.equal(readFileSync(join(run.root, 'timeout-seconds'), 'utf8').trim(), String(perRepoTimeout ?? 120));
      assert.deepEqual(clonedDirs(run.fake, run.workspace), ['timed']);
      assert.equal(readFileSync(run.fake.events, 'utf8').trim().split('\n').at(-1), 'autostart');
      if (outcome === 'issues') assert.match(run.result.stdout, /clone failed for octo\/timed/);
      else assert.doesNotMatch(run.result.stdout, /clone failed/);
    });
  }
});

it('REQ-GITHUB-320 AC2: health withholds workspace inventory during the actual restore loop and publishes it after completion', async t => {
  const root = mkdtempSync(join(tmpdir(), 'clone-inventory-'));
  const workspace = join(root, 'workspace');
  const fake = createFakeGit(root);
  const flag = join(root, 'clone-outcome');
  const release = join(root, 'release');
  mkdirSync(workspace);
  // A filesystem-backed Git protocol peer: restore blocks before completing;
  // inventory requests after restore read its remote and current branch.
  writeFileSync(join(fake.bin, 'git'), `#!/usr/bin/env bash
if [ "$1" = clone ]; then
  mkdir -p "\${@: -1}"
  printf 'restore-peer-blocked\\n' >&2
  while [ ! -f '${release}' ]; do sleep 0.02; done
  mkdir -p "\${@: -1}/.git"
elif [ "$1" = -C ]; then
  if [ "$3" = remote ]; then printf 'https://github.com/octo/repo.git\\n';
  else printf 'trunk\\n'; fi
else exit 7
fi
`);
  const saved = { ...process.env };
  Object.assign(process.env, { CONTAINER_AUTH_TOKEN: 'clone-test-token', USER_WORKSPACE: workspace,
    PATH: `${fake.bin}:${saved.PATH ?? ''}`, CODEFLARE_CLONE_RESTORE_FLAG_FILE: flag,
    GIT_CLONE_TARGETS: 'octo/repo', GITHUB_HOST: 'github.com' });
  delete process.env.CODEFLARE_OPERATOR_SESSION;
  delete process.env.GIT_CLONE_REPO;
  const child = spawn('bash', ['-c', extractStartupCloneBlock()], { env: { ...process.env }, detached: true });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid, 'SIGKILL');
      await exited;
    }
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  });
  let stderr = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Restore peer did not start')), 5000);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.includes('restore-peer-blocked')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Restore exited before release: ${stderr}`)); });
  });
  const health = port => new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/health',
      headers: { authorization: 'Bearer clone-test-token' } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
  });
  await withRouter({}, async port => {
    const pending = await health(port);
    assert.equal(pending.status, 200);
    assert.equal(pending.body.repositoryRestore, 'restoring');
    assert.equal(Object.hasOwn(pending.body, 'workspaceRepos'), false);
    assert.equal(existsSync(flag), false);
    writeFileSync(release, 'continue');
    const [code] = await exited;
    assert.equal(code, 0, stderr);
    const complete = await health(port);
    assert.equal(complete.status, 200);
    assert.equal(complete.body.repositoryRestore, 'complete');
    assert.deepEqual(complete.body.workspaceRepos, [{ repo: 'octo/repo', ref: 'trunk' }]);
  });
});

for (const owner of ['startup', 'live-session']) {
  it(`REQ-GITHUB-004 AC4: ${owner} clone checks out the local remote default branch without an explicit ref`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'clone-default-branch-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const realGit = '/usr/bin/git';
    const home = join(root, 'home');
    const config = join(root, 'gitconfig');
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const workspace = join(root, 'workspace');
    const target = join(workspace, 'repo');
    const bin = join(root, 'bin');
    const argvLog = join(root, 'clone-argv.json');
    const outcome = join(root, 'clone-outcome');
    const origin = 'https://clone-fixture.invalid/octo/repo.git';
    for (const dir of [home, workspace, bin]) mkdirSync(dir);
    writeFileSync(config, '');
    // Do not inherit user credentials, Git configuration, hooks or transports.
    // Even an unmapped HTTPS URL fails closed: only local file transport is allowed.
    const gitEnv = {
      PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config, GIT_ATTR_NOSYSTEM: '1',
      GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Clone fixture', GIT_AUTHOR_EMAIL: 'clone@example.invalid',
      GIT_COMMITTER_NAME: 'Clone fixture', GIT_COMMITTER_EMAIL: 'clone@example.invalid',
    };
    const git = (...args) => {
      const result = spawnSync(realGit, args, { cwd: root, env: gitEnv, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      return result.stdout.trim();
    };
    git('init', '--bare', '--initial-branch=trunk', '--template=', remote);
    git('init', '--initial-branch=trunk', '--template=', seed);
    const bytes = Buffer.from('Actual trunk checkout\nUnicode: café 🌿\n', 'utf8');
    writeFileSync(join(seed, 'branch-proof.txt'), bytes);
    git('-C', seed, 'add', 'branch-proof.txt');
    git('-C', seed, 'commit', '-m', 'test fixture trunk');
    const revision = git('-C', seed, 'rev-parse', 'HEAD');
    git('-C', seed, 'push', remote, 'HEAD:refs/heads/trunk');
    assert.equal(git('--git-dir', remote, 'symbolic-ref', 'HEAD'), 'refs/heads/trunk');
    // Native Git URL rewriting maps this one fixture origin to the disposable
    // bare remote. It does not alter the production owner's clone arguments.
    git('config', '--file', config, `url.${pathToFileURL(remote).href}.insteadOf`, origin);
    // The PATH peer records actual argv and runs real Git in the isolated env.
    // Reject any other source/destination before invoking even the file transport.
    writeFileSync(join(bin, 'git'), `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args));
if (args[0] !== 'clone' || args.at(-2) !== ${JSON.stringify(origin)} || args.at(-1) !== ${JSON.stringify(target)}) process.exit(97);
const result = spawnSync(${JSON.stringify(realGit)}, args, {
  cwd: ${JSON.stringify(root)}, env: ${JSON.stringify(gitEnv)}, stdio: 'inherit', timeout: 10000,
});
process.exit(result.status ?? 1);
`);
    chmodSync(join(bin, 'git'), 0o755);
    const cloneEnv = { ...gitEnv, PATH: `${bin}:${gitEnv.PATH}`, USER_WORKSPACE: workspace,
      GITHUB_HOST: 'clone-fixture.invalid', CONTAINER_AUTH_TOKEN: 'clone-test-token',
      GIT_CLONE_REPO: 'octo/repo', CODEFLARE_CLONE_RESTORE_FLAG_FILE: outcome };
    if (owner === 'startup') {
      // Existing fixture extracts the production startup owner verbatim; no
      // GIT_CLONE_REF or GIT_CLONE_TARGETS is supplied for the new-session path.
      const result = spawnSync('bash', ['-c', extractStartupCloneBlock()], {
        cwd: root, env: cloneEnv, encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.equal(readFileSync(outcome, 'utf8').trim(), 'complete');
    } else {
      const saved = { ...process.env };
      Object.assign(process.env, cloneEnv);
      try {
        const response = await withRouter({}, port => postJson(port, '/internal/git-clone', { repo: 'octo/repo' }));
        assert.equal(response.status, 200);
        assert.deepEqual(response.body, { status: 'cloned', path: target });
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
      }
    }
    assert.deepEqual(JSON.parse(readFileSync(argvLog, 'utf8')), ['clone', '--', origin, target]);
    assert.equal(git('-C', target, 'symbolic-ref', '--short', 'HEAD'), 'trunk');
    assert.equal(git('-C', target, 'rev-parse', 'HEAD'), revision);
    assert.deepEqual(readFileSync(join(target, 'branch-proof.txt')), bytes);
  });
}
