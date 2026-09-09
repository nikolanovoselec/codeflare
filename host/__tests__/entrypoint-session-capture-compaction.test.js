import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const entrypoint = join(repoRoot, 'entrypoint.sh');

function extractFunction(name) {
  const lines = readFileSync(entrypoint, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  if (start < 0) throw new Error(`missing ${name}() in entrypoint.sh`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (end < 0) throw new Error(`missing end of ${name}() in entrypoint.sh`);
  return lines.slice(start, end + 1).join('\n');
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'entrypoint-capture-compaction-'));
  const runtime = join(root, 'runtime');
  const home = join(root, 'home');
  const sessions = join(home, 'Vault/Raw/Sessions');
  mkdirSync(join(runtime, 'sync'), { recursive: true });
  mkdirSync(join(runtime, 'locks'), { recursive: true });
  mkdirSync(join(home, '.pi/agent/scripts'), { recursive: true });
  mkdirSync(join(home, 'Vault/graphify-out'), { recursive: true });
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(home, '.pi/agent/scripts/merge-vault-graph.py'), '# managed merge\n');
  writeFileSync(join(home, 'Vault/graphify-out/vault-graph.json'), '{"nodes":[],"links":[]}\n');
  writeFileSync(join(home, 'Vault/graphify-out/graph.json'), '{"nodes":[],"links":[]}\n');
  writeFileSync(join(sessions, '2026-01-01T00-00-00Z-old.md'), 'old capture\n');
  return { root, runtime, home, sessions, log: join(root, 'calls.log') };
}

function harness(fx, body, invocation, { fail = '', mode = 'advanced', noop = false } = {}) {
  const source = join(fx.sessions, '2026-01-01T00-00-00Z-old.md');
  return `
set +e
unset VAULT_SESSION_COMPACTION_ENABLED
SESSION_MODE=${JSON.stringify(mode)}
CODEFLARE_RUNTIME_ROOT=${JSON.stringify(fx.runtime)}
SYNC_RUNTIME_DIR=${JSON.stringify(join(fx.runtime, 'sync'))}
CODEFLARE_GRAPH_LOCK=${JSON.stringify(join(fx.runtime, 'locks/graphify-global.lock'))}
USER_HOME=${JSON.stringify(fx.home)}
R2_BUCKET_NAME=bucket
RCLONE_CONFIG=${JSON.stringify(join(fx.root, 'rclone.conf'))}
CALLS=${JSON.stringify(fx.log)}
FAIL_STAGE=${JSON.stringify(fail)}
PREPARE_NOOP=${noop ? '1' : '0'}
BISYNC_CALLS=0
export SESSION_MODE CODEFLARE_RUNTIME_ROOT SYNC_RUNTIME_DIR CODEFLARE_GRAPH_LOCK USER_HOME R2_BUCKET_NAME RCLONE_CONFIG CALLS FAIL_STAGE PREPARE_NOOP

date() { [ "$1 $2" = "-u +%F" ] && printf '2026-03-31\\n' || command date "$@"; }
timeout() { shift; "$@"; }
rclone() {
  case "$1" in
    copyto)
      printf 'DOWNLOAD\\n' >> "$CALLS"
      [ "$FAIL_STAGE" != download ] || return 1
      printf 'remote archive\\n' > "$3"
      ;;
    lsf)
      printf 'REMOTE_LIST\\n' >> "$CALLS"
      [ "$FAIL_STAGE" != listing ] || return 1
      ;;
  esac
}
node() {
  case "$2" in
    prepare)
      printf 'PREPARE\\n' >> "$CALLS"
      [ "$FAIL_STAGE" != prepare ] || return 1
      if [ "$PREPARE_NOOP" = 1 ]; then
        printf '{"status":"noop"}\\n'
        return 0
      fi
      cat > "$4" <<JSON
{"archive":{"bytes":15,"filename":"Archive.md","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"archive_file":"${fx.sessions}/Archive.md","cutoff_date":"2026-02-28","deletion_sync_completed":false,"phase_state":"archive-prepared-sources-present","sources":[{"archive_marker":"<!-- capture-begin:archive:2026-01-01T00-00-00Z-old.md -->","bytes":12,"date":"2026-01-01","filename":"2026-01-01T00-00-00Z-old.md","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","source_file":"${source}","source_location":"archive:2026-01-01T00-00-00Z-old.md"}],"version":1}
JSON
      printf '{"status":"prepared"}\\n'
      ;;
    verify)
      printf 'VERIFY\\n' >> "$CALLS"
      [ "$FAIL_STAGE" != verify ]
      ;;
    delete)
      printf 'DELETE\\n' >> "$CALLS"
      [ "$FAIL_STAGE" != delete ] || return 1
      rm -f ${JSON.stringify(source)}
      printf '{"deleted_count":1}\\n'
      ;;
  esac
}
bisync_with_r2() {
  BISYNC_CALLS=$((BISYNC_CALLS + 1))
  printf 'BISYNC_%s\\n' "$BISYNC_CALLS" >> "$CALLS"
  [ "$FAIL_STAGE" != "bisync-$BISYNC_CALLS" ]
}
flock() {
  printf 'LOCK\\n' >> "$CALLS"
  [ "$FAIL_STAGE" != lock ]
}
python3() {
  printf 'RELOCATE\\n' >> "$CALLS"
  [ "$FAIL_STAGE" != relocate ]
}
graphify() {
  printf 'GLOBAL_ADD:%s\\n' "$*" >> "$CALLS"
  [ "$FAIL_STAGE" != global-add ]
}

${body}
${invocation}
`;
}

function runDaily(fx, options = {}, invocation = 'run_daily_vault_session_compaction') {
  const body = extractFunction('run_daily_vault_session_compaction');
  return spawnSync('bash', ['-c', harness(fx, body, invocation, options)], { encoding: 'utf8' });
}

function calls(fx) {
  return existsSync(fx.log) ? readFileSync(fx.log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

const expectedOrder = [
  'PREPARE',
  'DELETE',
  'LOCK',
  'RELOCATE',
  'GLOBAL_ADD:global add',
  'BISYNC_1',
];

describe('entrypoint session-capture compaction orchestration', () => {
  it('archives, deletes, relocates, and bisyncs once per UTC day', () => {
    const fx = fixture();
    const result = runDaily(fx, {}, 'run_daily_vault_session_compaction\nrun_daily_vault_session_compaction');
    assert.equal(result.status, 0, result.stderr);
    const actual = calls(fx);
    assert.equal(actual.length, expectedOrder.length);
    expectedOrder.forEach((entry, index) => assert.match(actual[index], new RegExp(`^${entry}`)));
    assert.equal(
      actual[4],
      `GLOBAL_ADD:global add ${join(fx.home, 'Vault/graphify-out/vault-graph.json')} --as user_vault`,
    );
    assert.equal(readFileSync(join(fx.runtime, 'sync/vault-session-compaction.utc-day'), 'utf8'), '2026-03-31\n');
    assert.equal(existsSync(join(fx.runtime, 'sync/vault-session-compaction')), false);
  });

  it('stamps a no-op day without publishing, relocating, or deleting', () => {
    const fx = fixture();
    const result = runDaily(fx, { noop: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(fx), ['PREPARE']);
    assert.equal(readFileSync(join(fx.runtime, 'sync/vault-session-compaction.utc-day'), 'utf8'), '2026-03-31\n');
    assert.equal(existsSync(join(fx.runtime, 'sync/vault-session-compaction')), false);
  });

  it('runs in the default session mode without a feature flag', () => {
    const fx = fixture();
    const result = runDaily(fx, { mode: 'default' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls(fx).length, expectedOrder.length);
  });

  it('stops at the first failed step without stamping completion', () => {
    const cases = new Map([
      ['delete', ['PREPARE', 'DELETE']],
      ['lock', ['PREPARE', 'DELETE', 'LOCK']],
      ['relocate', ['PREPARE', 'DELETE', 'LOCK', 'RELOCATE']],
      ['global-add', expectedOrder.slice(0, 5)],
      ['bisync-1', expectedOrder],
    ]);
    for (const [fail, expected] of cases) {
      const fx = fixture();
      const result = runDaily(fx, { fail });
      assert.notEqual(result.status, 0, `${fail} must return a nonfatal failure to its guarded caller`);
      const actual = calls(fx);
      assert.equal(actual.length, expected.length, `${fail}: ${actual.join(',')}`);
      expected.forEach((entry, index) => assert.match(actual[index], new RegExp(`^${entry}`), fail));
      assert.equal(existsSync(join(fx.runtime, 'sync/vault-session-compaction.utc-day')), false, fail);
      assert.equal(existsSync(join(fx.runtime, 'sync/vault-session-compaction')), true, fail);
    }
  });

  it('runs at startup only after a genuinely successful baseline and before the daemon starts', () => {
    for (const baselineStatus of ['success', 'timeout', 'failed']) {
      const fx = fixture();
      const startup = extractFunction('complete_managed_curation_startup');
      const script = `
        set +e
        RCLONE_CONFIG_RESULT=0
        STEP1_RESULT=0
        SESSION_MODE=advanced
        CODEFLARE_SESSION_WORKSPACE=terminal
        CODEFLARE_RUNTIME_ROOT=${JSON.stringify(fx.runtime)}
        SYNC_STATUS=pending
        CALLS=${JSON.stringify(fx.log)}
        export RCLONE_CONFIG_RESULT STEP1_RESULT SESSION_MODE CODEFLARE_SESSION_WORKSPACE CODEFLARE_RUNTIME_ROOT SYNC_STATUS CALLS
        prepare_managed_resource_filter() { :; }
        relay_managed_pi_extensions() { :; }
        release_agent_pty_after_fast_start_updates() { :; }
        renice() { :; }
        ionice() { :; }
        establish_bisync_baseline() {
          printf 'BASELINE\\n' >> "$CALLS"
          SYNC_STATUS=${JSON.stringify(baselineStatus)}
          [ "$SYNC_STATUS" != failed ]
        }
        init_user_vault() { printf 'VAULT_INIT\\n' >> "$CALLS"; }
        run_daily_vault_session_compaction() { printf 'COMPACT\\n' >> "$CALLS"; }
        start_sync_daemon() { printf 'DAEMON\\n' >> "$CALLS"; }
        start_silverbullet_supervisor() { :; }
        start_openvscode_supervisor() { :; }
        ${startup}
        complete_managed_curation_startup
        wait
      `;
      const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(
        calls(fx),
        baselineStatus === 'success'
          ? ['BASELINE', 'VAULT_INIT', 'COMPACT', 'DAEMON']
          : ['BASELINE', 'VAULT_INIT', 'DAEMON'],
        baselineStatus,
      );
    }
  });

  it('runs after natural successful daemon cycles but not manual/final trigger kinds', () => {
    const fx = fixture();
    const body = [
      extractFunction('run_vault_session_compaction_after_sync'),
      'run_daily_vault_session_compaction() { printf "COMPACT\\n" >> "$CALLS"; }',
    ].join('\n');
    const script = harness(
      fx,
      body,
      'run_vault_session_compaction_after_sync natural\nrun_vault_session_compaction_after_sync manual\nrun_vault_session_compaction_after_sync final',
    );
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls(fx), ['COMPACT']);
  });
});
