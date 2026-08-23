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
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  writeFileSync(git, `#!/usr/bin/env bash\nif [ -n "\${FAKE_EVENT_LOG:-}" ]; then printf 'git\\n' >> "$FAKE_EVENT_LOG"; fi\nprintf '%s\\n' "$@" >> "$FAKE_GIT_LOG"\nif [ -n "\${FAKE_GIT_SLEEP:-}" ]; then sleep "$FAKE_GIT_SLEEP"; fi\nexit "\${FAKE_GIT_STATUS:-0}"\n`);
  chmodSync(git, 0o755);
  return { bin, log, events };
}

function extractStartupCloneBlock() {
  const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');
  const start = entrypoint.indexOf('# REQ-GITHUB-014: one-shot repo clone at container start.');
  const end = entrypoint.indexOf('\n# Configure tab auto-start\n', start);
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
