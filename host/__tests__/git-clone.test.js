// Behavioral coverage of the pure git-clone resolution helpers for
// REQ-GITHUB-004 (running-session clone). The repo/ref validation + target-dir
// computation are extracted into host/src/git-clone.ts so they are unit-testable
// without spawning git; the endpoint's fs.existsSync + spawn + timeout I/O lives
// in server.ts and is verified structurally at the bottom of this file.
//
// Imports the COMPILED ../dist/git-clone.js (same pattern as
// final-sync-endpoint.test.js) — the test runner exercises the build output.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitClone, resolveWorkspaceRoot, buildCloneArgs } from '../dist/git-clone.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const WS = '/home/user/workspace';

describe('REQ-GITHUB-004: resolveGitClone validation + dir computation', () => {
  it('resolves a valid owner/name repo to <workspace>/<name>', () => {
    const r = resolveGitClone('octo/hello-world', undefined, WS);
    assert.equal(r.ok, true);
    assert.equal(r.repoName, 'hello-world');
    assert.equal(r.dir, '/home/user/workspace/hello-world');
    assert.equal(r.ref, undefined);
  });

  it('strips a trailing .git from the computed repo name + dir', () => {
    const r = resolveGitClone('octo/hello-world.git', undefined, WS);
    assert.equal(r.ok, true);
    assert.equal(r.repoName, 'hello-world');
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

  it('rejects a single-segment .. / . repo name that would escape the workspace dir', () => {
    // These pass the owner/name regex but their dir would escape via path.join:
    // octo/.. -> <ws>/.., octo/. -> <ws>, a/..git -> (after .git strip) <ws>/.
    assert.equal(resolveGitClone('octo/..', undefined, WS).ok, false);
    assert.equal(resolveGitClone('octo/.', undefined, WS).ok, false);
    assert.equal(resolveGitClone('a/..git', undefined, WS).ok, false);
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

  it('keeps the url and dir as separate argv entries (no shell interpolation)', () => {
    const args = buildCloneArgs('octo/repo', undefined, '/ws/repo', 'github.com');
    // dir is its own array element; never concatenated into the url.
    assert.equal(args[args.length - 1], '/ws/repo');
    assert.equal(args.filter((a) => a.includes(' ')).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Structural verification of the endpoint I/O wiring that cannot be unit-imported
// (the monolithic http handler in server.ts and the entrypoint clone step).
// Source-text assertions, not behavioral — same convention as
// final-sync-endpoint.test.js.
// ---------------------------------------------------------------------------
const server = readFileSync(resolve(repoRoot, 'host/src/server.ts'), 'utf8');
const entrypoint = readFileSync(resolve(repoRoot, 'entrypoint.sh'), 'utf8');

describe('REQ-GITHUB-004: git-clone endpoint wiring (structural)', () => {
  const idx = server.indexOf("'/internal/git-clone'");
  const block = server.slice(idx, idx + 2600);

  it('exposes POST /internal/git-clone', () => {
    assert.ok(/pathname === '\/internal\/git-clone' && method === 'POST'/.test(server));
  });

  it('refuses an existing target with 409 CLONE_TARGET_EXISTS (collision refuse)', () => {
    assert.ok(block.includes('fs.existsSync'));
    assert.ok(block.includes('409'));
    assert.ok(block.includes('CLONE_TARGET_EXISTS'));
  });

  it('spawns git as an argv via the pure helper, not a shell string', () => {
    assert.ok(block.includes("spawn('git'") || block.includes('spawn("git"'));
    assert.ok(block.includes('buildCloneArgs'));
    assert.ok(!block.includes('shell: true'));
  });

  it('maps exit code 0 -> 200, non-zero -> 502, and times out -> 504', () => {
    assert.ok(block.includes('200') && block.includes("status: 'cloned'"));
    assert.ok(block.includes('502') && block.includes('CLONE_FAILED'));
    assert.ok(block.includes('504') && block.includes('CLONE_TIMEOUT'));
  });
});

describe('REQ-GITHUB-004: entrypoint clone step (structural)', () => {
  const i = entrypoint.indexOf('GIT_CLONE_REPO');
  const block = entrypoint.slice(i - 200, i + 1400);

  it('gates the clone on GIT_CLONE_REPO and runs before configure_tab_autostart', () => {
    assert.ok(/if \[ -n "\$\{GIT_CLONE_REPO:-\}" \]/.test(entrypoint));
    const cloneIdx = entrypoint.indexOf('GIT_CLONE_REPO');
    // Match the configure_tab_autostart CALL (bare, on its own line), NOT the
    // function definition `configure_tab_autostart() {` which appears far earlier.
    const autostartIdx = entrypoint.indexOf('\nconfigure_tab_autostart\n');
    assert.ok(cloneIdx !== -1 && autostartIdx !== -1 && cloneIdx < autostartIdx);
  });

  it('skips (does not clone) when the target dir already exists (collision refuse)', () => {
    assert.ok(block.includes('[ -e "$CLONE_DIR" ]'));
  });

  it('passes --branch only when GIT_CLONE_REF is set', () => {
    assert.ok(block.includes('--branch "$GIT_CLONE_REF"'));
    assert.ok(/if \[ -n "\$\{GIT_CLONE_REF:-\}" \]/.test(block));
  });

  it('uses a -- end-of-options separator on both clone branches (git arg-injection guard)', () => {
    // Mirrors buildCloneArgs: the positional URL/dir can never be read as flags.
    assert.ok(block.includes('git clone --branch "$GIT_CLONE_REF" -- "https://'));
    assert.ok(block.includes('git clone -- "https://'));
  });

  it('re-validates the repo/ref shape before cloning (rejects an option-leading dash)', () => {
    assert.ok(block.includes("grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'"));
    assert.ok(block.includes("grep -qE '^[A-Za-z0-9._/][A-Za-z0-9._/-]*$'"));
  });

  it('is best-effort: a clone failure does not abort startup', () => {
    assert.ok(/git clone[\s\S]*?\|\| echo/.test(block));
  });
});
