import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../../entrypoint.sh'), 'utf8');
const lines = source.split('\n');

function functionSource(name) {
  const start = lines.findIndex((line) => line === `${name}() {`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.notEqual(start, -1, `${name} missing`);
  assert.notEqual(end, -1, `${name} terminator missing`);
  return lines.slice(start, end + 1).join('\n');
}

function productionInvocation(name) {
  const invocation = lines.find((line) => line === name);
  assert.equal(invocation, name, `${name} production invocation missing`);
  return invocation;
}

const layDown = functionSource('lay_down_agent_seed_preseed');
const relay = functionSource('relay_managed_pi_extensions');
const initialRestore = functionSource('run_initial_r2_restore');
const completeStartup = functionSource('complete_managed_curation_startup');
const managedStartup = functionSource('run_managed_curation_startup');
const managedStartupInvocation = productionInvocation('run_managed_curation_startup');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'managed-entrypoint-'));
  const home = join(root, 'home');
  const bake = join(root, 'bake');
  const warm = join(root, 'warm');
  mkdirSync(join(home, '.pi/agent/extensions'), { recursive: true });
  mkdirSync(join(bake, 'default/.claude'), { recursive: true });
  mkdirSync(join(bake, 'default/.pi/agent/extensions'), { recursive: true });
  mkdirSync(warm, { recursive: true });
  const runtimeRoot = join(root, 'runtime');
  mkdirSync(join(runtimeRoot, 'sync'), { recursive: true });
  writeFileSync(join(bake, 'default/.claude/company.md'), 'baked');
  writeFileSync(join(home, '.pi/agent/extensions/codeflare.ts'), 'restored release');
  writeFileSync(join(warm, 'codeflare.ts'), 'baked image');
  return { root, home, bake, warm, runtimeRoot, events: join(root, 'events') };
}

function runStartup(remoteCurationActive) {
  const f = fixture();
  const result = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    `USER_HOME='${f.home}'`,
    `USER_WORKSPACE='${join(f.home, 'workspace')}'`,
    `AGENT_SEED_BAKE_DIR='${f.bake}'`,
    `PI_WARM_EXTENSIONS_DIR='${f.warm}'`,
    `EVENTS='${f.events}'`,
    "R2_SSE_DISABLED='true'",
    "RCLONE_CONFIG_RESULT='0'",
    "ENTERPRISE_MODE=''",
    "SYNC_ERROR='null'",
    "SESSION_MODE='default'",
    remoteCurationActive ? "REMOTE_CURATION_ACTIVE='true'" : '',
    'cp() {',
    '  case "$*" in',
    '    *"$AGENT_SEED_BAKE_DIR"/*) echo laydown >> "$EVENTS" ;;',
    '    *"$PI_WARM_EXTENSIONS_DIR"/*) echo relay >> "$EVENTS" ;;',
    '  esac',
    '  command cp "$@"',
    '}',
    'update_sync_status() { :; }',
    'initial_sync_from_r2() { echo initial >> "$EVENTS"; }',
    'release_agent_pty_after_cleanup() { echo cleanup >> "$EVENTS"; }',
    'establish_bisync_baseline() { echo baseline >> "$EVENTS"; }',
    'init_user_vault() { :; }',
    'start_sync_daemon() { :; }',
    'start_vault_monitor_daemon() { :; }',
    'start_silverbullet_supervisor() { :; }',
    'start_openvscode_supervisor() { :; }',
    'run_post_restore_startup() { echo post-restore >> "$EVENTS"; }',
    'renice() { :; }',
    'ionice() { :; }',
    layDown,
    relay,
    initialRestore,
    completeStartup,
    managedStartup,
    managedStartupInvocation,
    'wait',
  ].join('\n')], {
    encoding: 'utf8',
    env: { ...process.env, CODEFLARE_RUNTIME_ROOT: f.runtimeRoot },
  });
  return {
    ...f,
    result,
    companyFile: join(f.home, '.claude/company.md'),
    extensionFile: join(f.home, '.pi/agent/extensions/codeflare.ts'),
  };
}

describe('managed curation entrypoint behavior', () => {
  it('preserves restored managed content while remote curation is active', () => {
    const run = runStartup(true);

    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(existsSync(run.companyFile), false);
    assert.equal(readFileSync(run.extensionFile, 'utf8'), 'restored release');
    assert.deepEqual(readFileSync(run.events, 'utf8').trim().split('\n'), [
      'initial',
      'post-restore',
      'cleanup',
      'baseline',
    ]);
  });

  it('executes the reachable baked restore, relay, cleanup, and baseline in order when curation is disabled', () => {
    const run = runStartup(false);

    assert.equal(run.result.status, 0, run.result.stderr);
    assert.equal(readFileSync(run.companyFile, 'utf8'), 'baked');
    assert.equal(readFileSync(run.extensionFile, 'utf8'), 'baked image');
    assert.deepEqual(readFileSync(run.events, 'utf8').trim().split('\n'), [
      'laydown',
      'initial',
      'post-restore',
      'relay',
      'cleanup',
      'baseline',
    ]);
  });
});
