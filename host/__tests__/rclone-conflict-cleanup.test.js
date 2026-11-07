import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Isolate unmanaged lifecycle behavior; real policy composition is covered by the rclone matrix.
const unmanagedPolicyFixture = "prepare_managed_resource_filter() { :; }\ncompose_rclone_filters() { RCLONE_EFFECTIVE_FILTERS=(\"${RCLONE_FILTERS[@]}\"); }";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const helper = join(repo, 'scripts/rclone-conflict-cleanup.sh');
const entrypoint = readFileSync(join(repo, 'entrypoint.sh'), 'utf8');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function fixture(t) {
  const real = spawnSync('bash', ['-c', 'command -v rclone'], { encoding: 'utf8' });
  assert.equal(real.status, 0, 'real rclone must be provisioned');
  const realRclone = real.stdout.trim();
  assert.ok(realRclone, 'real rclone executable is required');
  const root = mkdtempSync(join(tmpdir(), 'rclone-conflict-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, 'local home');
  const remote = join(root, 'remote', 'bucket', 'scope');
  const bin = join(root, 'bin');
  for (const dir of [local, remote, bin, join(root, 'runtime/sync/rclone')]) mkdirSync(dir, { recursive: true });
  const put = (base, name, bytes = 'retained bytes') => {
    const path = join(base, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    return path;
  };
  // Only the fixture adapter understands r2:. The real rclone receives local paths,
  // an empty config and real filter flags, exercising its actual basename semantics.
  writeFileSync(join(bin, 'rclone'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const [command, target, ...flags] = process.argv.slice(2);
const remote = process.env.FIXTURE_REMOTE;
if ((command === 'bisync' || command === 'sync') && process.env.REAL_TRANSFER === '1') {
  const args = [target, ...flags].map(value => value === 'r2:bucket/' || value === 'r2:bucket'
    ? path.dirname(remote) : value.startsWith('r2:bucket/') ? path.join(path.dirname(remote), value.slice('r2:bucket/'.length)) : value);
  const result = cp.spawnSync(process.env.REAL_RCLONE, [command, ...args], { encoding: 'utf8' });
  if (result.error) console.error(result.error.message);
  process.stderr.write(result.stderr || '');
  if (process.env.FIXTURE_ARTIFACTS) {
    const found = [];
    function visit(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) visit(p);
        else if (e.isFile() && e.name.includes('.conflict')) found.push(p);
      }
    }
    visit(process.env.USER_HOME); visit(path.dirname(remote));
    fs.writeFileSync(process.env.FIXTURE_ARTIFACTS, JSON.stringify(found));
  }
  process.exit(result.status ?? 91);
}
if (command === 'bisync' || command === 'sync') {
  fs.writeFileSync(path.join(process.env.USER_HOME, 'from transfer.conflict1'), 'new local conflict');
  fs.writeFileSync(path.join(remote, 'from transfer.conflicted.md'), 'new remote conflict');
  process.exit(Number(process.env.TRANSFER_EXIT || 0));
}
if (command !== 'delete' || !(target === 'r2:bucket' || target.startsWith('r2:bucket/'))) {
  console.error('Unexpected fixture operation'); process.exit(90);
}
if (process.env.DELETE_EXIT) process.exit(Number(process.env.DELETE_EXIT));
if (process.env.DELETE_STALL) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
const mapped = path.join(path.dirname(remote), target === 'r2:bucket' ? '' : target.slice('r2:bucket/'.length));
const result = cp.spawnSync(process.env.REAL_RCLONE, ['delete', mapped, ...flags, '--config', '/dev/null', '--retries', '1', '--low-level-retries', '1'], { encoding: 'utf8' });
if (result.error) console.error(result.error.message);
process.stderr.write(result.stderr || '');
process.exit(result.status ?? 91);
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RCLONE_CONFIG: '/dev/null',
    USER_HOME: local, R2_BUCKET_NAME: 'bucket', FIXTURE_REMOTE: remote, REAL_RCLONE: realRclone,
    CODEFLARE_RUNTIME_ROOT: join(root, 'runtime'), SYNC_RUNTIME_DIR: join(root, 'runtime/sync') };
  const run = (body, extra = {}) => spawnSync('bash', ['-c', `set -euo pipefail\nsource ${quote(helper)}\n${body}`],
    { encoding: 'utf8', env: { ...env, ...extra } });
  const cleanup = (status = 0, extra = {}) => run(`cleanup_rclone_conflicts ${quote(local)} r2:bucket/scope ${status}`, extra);
  return { root, local, remote, put, run, cleanup };
}

it('REQ-STOR-054 AC1: post-sync cleanup removes local and remote conflict copies', t => {
  const f = fixture(t);
  const names = ['Index.conflicted-1.md', 'file.conflict1.ext', '.hidden.conflict2', 'nested/spaced name.conflict9', 'directory.conflict/child.conflict1'];
  for (const base of [f.local, f.remote]) for (const name of names) f.put(base, name);
  const result = f.cleanup();
  assert.equal(result.status, 0, result.stderr);
  for (const base of [f.local, f.remote]) for (const name of names) assert.equal(existsSync(join(base, name)), false, name);
});

it('REQ-STOR-054 AC2: cleanup preserves originals and scopes deletion to the sync roots', t => {
  const f = fixture(t);
  const names = ['Index.md', '.hidden', 'upper.CONFLICT1', 'conflict-no-dot', 'directory.conflict/ordinary.txt', 'spaces here/canonical.txt',
    'Operators/protected.conflict1', 'Operators/nested/.hidden.conflict2',
    '.codeflare/operators/protected.conflict1', '.codeflare/operators/nested/spaced name.conflicted.md'];
  for (const base of [f.local, f.remote]) {
    for (const name of names) f.put(base, name, `original ${name}`);
    mkdirSync(join(base, 'empty.conflict'), { recursive: true });
    f.put(base, 'remove.conflict1');
  }
  const outside = join(f.root, 'outside');
  f.put(outside, 'foreign.conflict1');
  f.put(join(f.root, 'remote/bucket/other-prefix'), 'other.conflict1');
  f.put(join(f.root, 'remote/another-bucket'), 'other.conflict1');
  symlinkSync(outside, join(f.local, 'foreign-directory'));
  symlinkSync(join(outside, 'foreign.conflict1'), join(f.local, 'link.conflict1'));
  const result = f.cleanup();
  assert.equal(result.status, 0, result.stderr);
  for (const base of [f.local, f.remote]) {
    for (const name of names) assert.equal(readFileSync(join(base, name), 'utf8'), `original ${name}`);
    assert.ok(existsSync(join(base, 'empty.conflict')));
    assert.ok(existsSync(join(base, 'directory.conflict')));
    assert.equal(existsSync(join(base, 'remove.conflict1')), false);
  }
  for (const path of [join(outside, 'foreign.conflict1'), join(f.root, 'remote/bucket/other-prefix/other.conflict1'), join(f.root, 'remote/another-bucket/other.conflict1'), join(f.local, 'link.conflict1')]) assert.ok(existsSync(path), path);
});

function extractFunction(name) {
  const start = entrypoint.indexOf(`${name}() {`);
  const end = entrypoint.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Missing entrypoint fixture function ${name}`);
  return entrypoint.slice(start, end + 3);
}

it('REQ-STOR-054 AC3: cleanup follows the sync attempt without masking its failure', t => {
  const f = fixture(t);
  for (const status of [0, 7, 124]) {
    const result = f.run(`
${unmanagedPolicyFixture}
RCLONE_FILTERS=()
RECOVERY_FILTER_FILE=/dev/null
cleanup_main_transcripts() { :; }
cleanup_remote_pi_transcript_conflicts() { :; }
record_sync_disk_failure() { :; }
repair_hook_exec_bits() { :; }
pgrep() { return 1; }
${extractFunction('bisync_with_r2')}
bisync_with_r2
`, { TRANSFER_EXIT: String(status), FIXTURE_REMOTE: f.remote });
    assert.equal(result.status, status, result.stderr);
    assert.equal(existsSync(join(f.local, 'from transfer.conflict1')), false, `local after transfer exit ${status}`);
    assert.equal(existsSync(join(f.remote, 'from transfer.conflicted.md')), false, `remote after transfer exit ${status}`);
  }
});

it('REQ-STOR-054 AC4: cleanup errors remain visible and empty repeats are harmless', t => {
  const f = fixture(t);
  for (let n = 0; n < 2; n++) assert.equal(f.cleanup().status, 0);
  f.put(f.local, 'local.conflict1');
  f.put(f.remote, 'remote.conflict1');
  const failed = f.cleanup(0, { DELETE_EXIT: '9' });
  assert.equal(failed.status, 9);
  assert.match(failed.stderr, /Remote conflict-copy cleanup failed/);
  assert.equal(existsSync(join(f.local, 'local.conflict1')), false);
  assert.equal(readFileSync(join(f.remote, 'remote.conflict1'), 'utf8'), 'retained bytes');
  const originalFailed = f.cleanup(7, { DELETE_EXIT: '9' });
  assert.equal(originalFailed.status, 7);
  assert.match(originalFailed.stderr, /Remote conflict-copy cleanup failed/);
  assert.equal(f.cleanup().status, 0);
  assert.equal(f.cleanup().status, 0);
  f.put(f.local, 'failed-transfer.conflict1');
  f.put(f.remote, 'failed-transfer.conflict1');
  assert.equal(f.cleanup(7).status, 7);
  assert.equal(existsSync(join(f.local, 'failed-transfer.conflict1')), false);
  assert.equal(existsSync(join(f.remote, 'failed-transfer.conflict1')), false);
  const invalid = f.run(`cleanup_rclone_conflicts ${quote(join(f.root, 'missing'))} r2:bucket/scope 0`);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid sync roots/);
});

it('REQ-STOR-054 AC5: empty repeats preserve ordinary files', t => {
  const f = fixture(t);
  for (const root of [f.local, f.remote]) f.put(root, 'ordinary.txt', 'canonical bytes');
  for (let cycle = 0; cycle < 2; cycle++) {
    const result = f.cleanup();
    assert.equal(result.status, 0, result.stderr);
    for (const root of [f.local, f.remote]) assert.equal(readFileSync(join(root, 'ordinary.txt'), 'utf8'), 'canonical bytes');
  }
});

it('REQ-STOR-054 AC6: exhausted budgets leave remote copies intact and preserve transfer status', t => {
  const f = fixture(t);
  for (const status of [0, 7, 124]) {
    f.put(f.local, 'budget.conflict1'); f.put(f.remote, 'budget.conflict1');
    const r = f.run(`cleanup_rclone_conflicts ${quote(f.local)} r2:bucket/scope ${status} 0`, { DELETE_STALL: '1' });
    assert.equal(r.status, status || 124, r.stderr);
    assert.match(r.stderr, /sync deadline exhausted/);
    assert.equal(existsSync(join(f.local, 'budget.conflict1')), false);
    assert.equal(readFileSync(join(f.remote, 'budget.conflict1'), 'utf8'), 'retained bytes');
  }
});

it('REQ-STOR-054 AC6: a stalled remote cleanup obeys its remaining deadline', t => {
  const f = fixture(t);
  for (const status of [0, 7]) {
    const started = performance.now();
    // Unsetting SECONDS removes its Bash clock behavior. Pin local-scan elapsed
    // time so this case reaches the remote stall; exhausted budgets are tested above.
    // The real timeout command still enforces the one-second remote deadline.
    const r = f.run(`unset SECONDS; SECONDS=0
cleanup_rclone_conflicts ${quote(f.local)} r2:bucket/scope ${status} 1`, { DELETE_STALL: '1' });
    assert.equal(r.status, status || 124, r.stderr);
    assert.match(r.stderr, /Remote conflict-copy cleanup failed/);
    assert.ok(performance.now() - started < 8000, 'stalled cleanup must terminate within the bounded fixture window');
  }
});

const transferHarness = `
${unmanagedPolicyFixture}
RCLONE_FILTERS=()
RECOVERY_FILTER_FILE=/dev/null
record_sync_disk_failure() { :; }
recover_vanished_files() { return 1; }
cleanup_main_transcripts() { :; }
cleanup_remote_pi_transcript_conflicts() { :; }
repair_hook_exec_bits() { :; }
pgrep() { return 1; }
`;

it('REQ-STOR-054 AC6: startup and baseline share their existing transfer deadline with cleanup', t => {
  for (const [name, policy] of [['initial_sync_from_r2', 'SYNC_TIMEOUT=120'], ['establish_bisync_baseline', 'BISYNC_TIMEOUT=600']]) {
    const f = fixture(t);
    f.put(f.local, 'budget.conflict1'); f.put(f.remote, 'budget.conflict1');
    const fn = extractFunction(name).replace(policy, policy.replace(/=\d+/, '=1'));
    const r = f.run(`${transferHarness}
timeout() {
  if [ "$3" = sync ] || [ "$3" = bisync ]; then sleep 1.1; return 124; fi
  command timeout "$@"
}
${fn}
${name}
`, { DELETE_STALL: '1' });
    assert.equal(r.status, 0, r.stderr); // Existing startup timeout policy continues startup.
    const log = readFileSync(join(f.root, 'runtime/sync/sync.log'), 'utf8');
    assert.match(log, /sync deadline exhausted/);
    assert.equal(existsSync(join(f.local, 'budget.conflict1')), false);
    assert.equal(readFileSync(join(f.remote, 'budget.conflict1'), 'utf8'), 'retained bytes');
  }
});

it('REQ-STOR-054 AC6: ordinary cleanup uses the existing thirty-second network bound', t => {
  const f = fixture(t), bound = join(f.root, 'bound');
  const r = f.run(`date() { printf '100\\n'; }
timeout() { printf '%s' "$1" > ${quote(bound)}; shift; command timeout 1 "$@"; }
cleanup_rclone_conflicts ${quote(f.local)} r2:bucket/scope 0`, { DELETE_STALL: '1' });
  assert.equal(r.status, 124, r.stderr);
  assert.equal(readFileSync(bound, 'utf8'), '30');
  assert.match(r.stderr, /Remote conflict-copy cleanup failed/);
});

it('REQ-STOR-054 AC1: a genuine divergence preserves the winner and discards eligible loser copies', t => {
  const f = fixture(t), remoteBucket = dirname(f.remote), artifacts = join(f.root, 'artifacts.json');
  const unchanged = 'unchanged anchor';
  for (const root of [f.local, remoteBucket]) {
    f.put(root, 'canonical.txt', 'original'); f.put(root, 'anchor.txt', unchanged);
    for (const prefix of ['Operators', '.codeflare/operators']) f.put(root, `${prefix}/protected.conflict1`, 'protected owner bytes');
    utimesSync(join(root, 'canonical.txt'), new Date(Date.now() - 180000), new Date(Date.now() - 180000));
  }
  const baseline = f.run(`${transferHarness}\n${extractFunction('establish_bisync_baseline')}\nestablish_bisync_baseline`, { REAL_TRANSFER: '1' });
  assert.equal(baseline.status, 0, baseline.stderr);
  f.put(remoteBucket, 'canonical.txt', 'remote divergent version');
  utimesSync(join(remoteBucket, 'canonical.txt'), new Date(Date.now() - 120000), new Date(Date.now() - 120000));
  const winner = 'newer local canonical version';
  f.put(f.local, 'canonical.txt', winner);
  utimesSync(join(f.local, 'canonical.txt'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const result = f.run(`${transferHarness}\n${extractFunction('bisync_with_r2')}\nbisync_with_r2`, { REAL_TRANSFER: '1', FIXTURE_ARTIFACTS: artifacts });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(readFileSync(artifacts, 'utf8'));
  const losers = observed.filter(p => p.includes('canonical') && p.includes('.conflict'));
  assert.ok(losers.length > 0, 'the real transfer must have produced a genuine loser copy before cleanup');
  for (const p of losers) assert.equal(existsSync(p), false);
  for (const root of [f.local, remoteBucket]) {
    assert.equal(readFileSync(join(root, 'canonical.txt'), 'utf8'), winner);
    assert.equal(readFileSync(join(root, 'anchor.txt'), 'utf8'), unchanged);
    for (const prefix of ['Operators', '.codeflare/operators']) assert.equal(readFileSync(join(root, prefix, 'protected.conflict1'), 'utf8'), 'protected owner bytes');
  }
});
