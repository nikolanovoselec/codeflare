import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, '../../entrypoint.sh'), 'utf8');

function functionSource(name, nextMarker) {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} missing`);
  assert.notEqual(end, -1, `${name} terminator missing`);
  return source.slice(start, end);
}

const layDown = functionSource('lay_down_agent_seed_preseed', '\n# REQ-STOR-017 / AD90: image-authoritative relay');
const relay = functionSource('relay_managed_pi_extensions', '\n# Step 2: Establish bisync baseline');

function runLayDown(remoteCurationActive) {
  const home = mkdtempSync(join(tmpdir(), 'managed-home-'));
  const bake = mkdtempSync(join(tmpdir(), 'managed-bake-'));
  mkdirSync(join(bake, 'default/.claude'), { recursive: true });
  writeFileSync(join(bake, 'default/.claude/company.md'), 'baked');
  const result = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    `USER_HOME='${home}'`,
    `AGENT_SEED_BAKE_DIR='${bake}'`,
    "R2_SSE_DISABLED='true'",
    remoteCurationActive ? "REMOTE_CURATION_ACTIVE='true'" : '',
    layDown,
    'lay_down_agent_seed_preseed',
  ].join('\n')], { encoding: 'utf8' });
  return { result, file: join(home, '.claude/company.md') };
}

function runRelay(remoteCurationActive) {
  const home = mkdtempSync(join(tmpdir(), 'managed-relay-home-'));
  const warm = mkdtempSync(join(tmpdir(), 'managed-relay-warm-'));
  const bake = mkdtempSync(join(tmpdir(), 'managed-relay-bake-'));
  mkdirSync(join(home, '.pi/agent/extensions'), { recursive: true });
  mkdirSync(warm, { recursive: true });
  mkdirSync(join(bake, 'default/.pi/agent/extensions'), { recursive: true });
  writeFileSync(join(home, '.pi/agent/extensions/codeflare.ts'), 'restored release');
  writeFileSync(join(warm, 'codeflare.ts'), 'baked image');
  const result = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    `USER_HOME='${home}'`,
    `PI_WARM_EXTENSIONS_DIR='${warm}'`,
    `AGENT_SEED_BAKE_DIR='${bake}'`,
    remoteCurationActive ? "REMOTE_CURATION_ACTIVE='true'" : '',
    relay,
    'relay_managed_pi_extensions',
  ].join('\n')], { encoding: 'utf8' });
  return { result, file: join(home, '.pi/agent/extensions/codeflare.ts') };
}

describe('managed curation entrypoint behavior', () => {
  it('skips baked pre-laydown and Pi relay only while REMOTE_CURATION_ACTIVE=true', () => {
    const lay = runLayDown(true);
    const pi = runRelay(true);
    assert.equal(lay.result.status, 0, lay.result.stderr);
    assert.equal(pi.result.status, 0, pi.result.stderr);
    assert.equal(existsSync(lay.file), false);
    assert.equal(readFileSync(pi.file, 'utf8'), 'restored release');
  });

  it('restores baked behavior when curation is disabled', () => {
    const lay = runLayDown(false);
    const pi = runRelay(false);
    assert.equal(lay.result.status, 0, lay.result.stderr);
    assert.equal(pi.result.status, 0, pi.result.stderr);
    assert.equal(readFileSync(lay.file, 'utf8'), 'baked');
    assert.equal(readFileSync(pi.file, 'utf8'), 'baked image');
  });

  it('after initial restore, executes relay and transcript cleanup before the bisync baseline', () => {
    const start = source.indexOf('relay_managed_pi_extensions || true');
    const end = source.indexOf('\n\necho "[entrypoint] Startup complete.', start);
    assert.notEqual(start, -1, 'startup boundary missing');
    assert.notEqual(end, -1, 'startup boundary terminator missing');
    const startupBoundary = source.slice(start, end);
    const events = join(mkdtempSync(join(tmpdir(), 'managed-order-')), 'events');
    const result = spawnSync('bash', ['-c', [
      'set -euo pipefail',
      `EVENTS='${events}'`,
      "RCLONE_CONFIG_RESULT='0'",
      "STEP1_RESULT='0'",
      "SESSION_MODE='default'",
      'relay_managed_pi_extensions() { echo relay >> "$EVENTS"; }',
      'release_agent_pty_after_cleanup() { echo cleanup >> "$EVENTS"; }',
      'establish_bisync_baseline() { echo baseline >> "$EVENTS"; }',
      'init_user_vault() { :; }',
      'start_sync_daemon() { :; }',
      'renice() { :; }',
      'ionice() { :; }',
      startupBoundary,
      'wait',
    ].join('\n')], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n'), ['relay', 'cleanup', 'baseline']);
  });
});
