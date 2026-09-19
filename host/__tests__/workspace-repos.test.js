// REQ-GITHUB-015: the container reports the repositories present at the top of
// the workspace so a resume can restore all of them, not only the repository the
// session was created from.
//
// These tests drive REAL git repositories in a temporary workspace (no stubbed
// git, no reading of source text) and the real /health route, so what is
// asserted is the observable inventory behavior.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, closeSync, openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorkspaceRepos, isWorkspaceInventoryReady } from '../dist/metrics.js';
import { createRequestHandler } from '../dist/request-router.js';

const noop = () => {};

function git(cwd, args) {
  const result = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
}

/** Create a real git repo at <workspace>/<dir> with an optional origin + branch. */
function makeRepo(workspace, dir, { origin, branch = 'main', commit = false, detach = false } = {}) {
  const path = join(workspace, dir);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', branch]);
  if (origin) git(path, ['remote', 'add', 'origin', origin]);
  if (commit || detach) {
    writeFileSync(join(path, 'file.txt'), 'x');
    git(path, ['add', 'file.txt']);
    git(path, ['commit', '-qm', 'init']);
  }
  if (detach) git(path, ['checkout', '-q', '--detach', 'HEAD']);
  return path;
}

function makeWorkspace() {
  return mkdtempSync(join(tmpdir(), 'workspace-repos-'));
}

describe('REQ-GITHUB-015 AC1: workspace repository inventory', () => {
  it('reports owner/name and branch for HTTPS and SSH GitHub origins', async () => {
    const workspace = makeWorkspace();
    makeRepo(workspace, 'api', { origin: 'https://github.com/octo/api.git', branch: 'develop' });
    makeRepo(workspace, 'web', { origin: 'git@github.com:octo/web.git', branch: 'main' });

    const repos = await collectWorkspaceRepos(workspace, noop);

    assert.deepEqual(repos, [
      { repo: 'octo/api', ref: 'develop' },
      { repo: 'octo/web', ref: 'main' },
    ]);
  });

  it('omits the ref when the checkout is detached', async () => {
    const workspace = makeWorkspace();
    makeRepo(workspace, 'api', { origin: 'https://github.com/octo/api.git', detach: true });

    const repos = await collectWorkspaceRepos(workspace, noop);

    assert.deepEqual(repos, [{ repo: 'octo/api' }]);
  });

  it('skips directories that are not GitHub-backed repositories', async () => {
    const workspace = makeWorkspace();
    makeRepo(workspace, 'no-origin', {});
    makeRepo(workspace, 'elsewhere', { origin: 'https://gitlab.com/octo/elsewhere.git' });
    mkdirSync(join(workspace, 'plain-dir'), { recursive: true });
    writeFileSync(join(workspace, 'loose.txt'), 'x');
    makeRepo(workspace, 'kept', { origin: 'https://github.com/octo/kept.git', branch: 'main' });

    const repos = await collectWorkspaceRepos(workspace, noop);

    assert.deepEqual(repos, [{ repo: 'octo/kept', ref: 'main' }]);
  });

  it('reports one entry per repository when the same repository is checked out twice', async () => {
    const workspace = makeWorkspace();
    makeRepo(workspace, 'api', { origin: 'https://github.com/octo/api.git', branch: 'main' });
    makeRepo(workspace, 'api-copy', { origin: 'https://github.com/octo/api.git', branch: 'main' });

    const repos = await collectWorkspaceRepos(workspace, noop);

    assert.deepEqual(repos, [{ repo: 'octo/api', ref: 'main' }]);
  });

  it('returns nothing when the workspace is missing', async () => {
    const repos = await collectWorkspaceRepos(join(makeWorkspace(), 'absent'), noop);
    assert.deepEqual(repos, []);
  });

  it('omits an inventory that cannot inspect every workspace directory', async () => {
    const workspace = makeWorkspace();
    for (let i = 0; i < 20; i++) {
      mkdirSync(join(workspace, `dir-${String(i).padStart(2, '0')}`));
    }
    makeRepo(workspace, 'repo-20', { origin: 'https://github.com/octo/repo-20.git' });

    const repos = await collectWorkspaceRepos(workspace, noop);

    assert.equal(repos, undefined);
  });

  it('omits an inventory when its aggregate deadline is exhausted', async () => {
    const workspace = makeWorkspace();
    makeRepo(workspace, 'api', { origin: 'https://github.com/octo/api.git' });

    const repos = await collectWorkspaceRepos(workspace, noop, 0);

    assert.equal(repos, undefined);
  });
});

describe('REQ-GITHUB-015 AC1: isWorkspaceInventoryReady', () => {
  const savedFlag = process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE;

  after(() => {
    if (savedFlag === undefined) delete process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE;
    else process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE = savedFlag;
  });

  it('is ready when the flag variable is unset (no-op in tests and dev mode)', () => {
    delete process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE;
    assert.equal(isWorkspaceInventoryReady(), true);
  });

  it('is not ready while the flag file is absent', () => {
    const workspace = makeWorkspace();
    process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE = join(workspace, 'clone-restore-complete');
    assert.equal(isWorkspaceInventoryReady(), false);
  });

  it('is ready once the flag file has been written', () => {
    const workspace = makeWorkspace();
    const flagPath = join(workspace, 'clone-restore-complete');
    process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE = flagPath;
    closeSync(openSync(flagPath, 'w'));
    assert.equal(isWorkspaceInventoryReady(), true);
  });
});

describe('REQ-GITHUB-015 AC1: /health carries the inventory', () => {
  let server;
  let port;
  let workspace;
  const savedWorkspace = process.env.USER_WORKSPACE;

  before(async () => {
    workspace = makeWorkspace();
    makeRepo(workspace, 'api', { origin: 'https://github.com/octo/api.git', branch: 'develop' });
    process.env.USER_WORKSPACE = workspace;
    server = http.createServer(createRequestHandler({
      sessionManager: { size: 1, list: () => [], getOrCreate: () => null, delete: () => false },
      wsEventLog: [],
      activityTracker: { recordHeartbeat: noop, recordInput: noop, getActivityInfo: () => ({ ok: true }) },
      log: noop,
      serverStartTime: Date.now(),
      readiness: () => ({
        prewarmReady: true,
        initFlagObserved: true,
        terminalServiceReady: true,
        editorReady: false,
        editorReadyTimedOut: false,
      }),
      silverbullet: { host: '127.0.0.1', port: 1 },
      openvscode: { host: '127.0.0.1', port: 1 },
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
  });

  after(async () => {
    if (savedWorkspace === undefined) delete process.env.USER_WORKSPACE;
    else process.env.USER_WORKSPACE = savedWorkspace;
    server.close();
    await once(server, 'close');
  });

  it('REQ-GITHUB-015 AC1: reports the tracked repositories on /health', async () => {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.end();
    });

    assert.deepEqual(body.workspaceRepos, [{ repo: 'octo/api', ref: 'develop' }]);
  });
});

describe('REQ-GITHUB-015 AC1: /health withholds the inventory during restore', () => {
  let server;
  let port;
  const savedWorkspace = process.env.USER_WORKSPACE;
  const savedFlag = process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE;

  before(async () => {
    const workspace = makeWorkspace();
    makeRepo(workspace, 'api', { origin: 'https://github.com/octo/api.git', branch: 'develop' });
    process.env.USER_WORKSPACE = workspace;
    // Flag file deliberately never written: the restore is still "in progress".
    process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE = join(workspace, 'clone-restore-complete');
    server = http.createServer(createRequestHandler({
      sessionManager: { size: 1, list: () => [], getOrCreate: () => null, delete: () => false },
      wsEventLog: [],
      activityTracker: { recordHeartbeat: noop, recordInput: noop, getActivityInfo: () => ({ ok: true }) },
      log: noop,
      serverStartTime: Date.now(),
      readiness: () => ({
        prewarmReady: true,
        initFlagObserved: true,
        terminalServiceReady: true,
        editorReady: false,
        editorReadyTimedOut: false,
      }),
      silverbullet: { host: '127.0.0.1', port: 1 },
      openvscode: { host: '127.0.0.1', port: 1 },
    }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
  });

  after(async () => {
    if (savedWorkspace === undefined) delete process.env.USER_WORKSPACE;
    else process.env.USER_WORKSPACE = savedWorkspace;
    if (savedFlag === undefined) delete process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE;
    else process.env.CODEFLARE_CLONE_RESTORE_FLAG_FILE = savedFlag;
    server.close();
    await once(server, 'close');
  });

  it('omits workspaceRepos rather than reporting a partial workspace as the whole inventory', async () => {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/health' }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.end();
    });

    assert.equal('workspaceRepos' in body, false);
  });
});
