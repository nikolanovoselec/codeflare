// Behavioral test for entrypoint.sh's repair_hook_exec_bits().
//
// ~/.claude/hooks/ entries are registered by bare path and spawned through their
// shebang, so they must be executable. R2 stores object content, not POSIX modes,
// so every sync that rewrites one drops the exec bit and the hook then fails with
// "Permission denied". Repairing only at boot left the bit stripped for the rest
// of the daemon cycle - observed live: container up at 21:29, a bisync round
// rewrote context-mode-cache-heal.mjs back to 0644 at 22:02, and the next
// SessionStart errored.
//
// "Run the real thing" per tdd-discipline.md: extracts the actual shell function
// from entrypoint.sh and runs it against a temp tree, then asserts the resulting
// file modes. If the find expression stops matching, or the repair is dropped
// from the boot or post-sync path, these fail.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function runtimeEnv() {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'hook-exec-runtime-'));
  const syncRuntimeDir = join(runtimeRoot, 'sync');
  mkdirSync(syncRuntimeDir, { recursive: true });
  return { ...process.env, CODEFLARE_RUNTIME_ROOT: runtimeRoot, SYNC_RUNTIME_DIR: syncRuntimeDir };
}

// Extract a top-level shell function body, bounded by its `name() {` opener and
// the first line that is exactly `}` (top-level functions in entrypoint.sh close
// at column 0).
function extractFunction(name) {
  const opener = `${name}() {`;
  const start = entrypoint.indexOf(opener);
  assert.notEqual(start, -1, `${name} not found in entrypoint.sh`);
  const end = entrypoint.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `${name} has no top-level close`);
  return entrypoint.slice(start, end + 3);
}

function modeOf(path) {
  return (statSync(path).mode & 0o777).toString(8);
}

// Runs the real repair function against `claudeDir` and returns the exit code.
function runRepair(claudeDir) {
  const script = `set -eu\nUSER_CLAUDE_DIR="${claudeDir}"\n${extractFunction('repair_hook_exec_bits')}\nrepair_hook_exec_bits\n`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: runtimeEnv() });
  return result.status;
}

function extractBootRepair() {
  const start = entrypoint.indexOf('# Ensure hook files in ~/.claude/hooks/ are executable.');
  assert.notEqual(start, -1, 'boot repair start not found in entrypoint.sh');
  const end = entrypoint.indexOf('# Enable plugins', start);
  assert.notEqual(end, -1, 'boot repair end not found in entrypoint.sh');
  return entrypoint.slice(start, end);
}

function runBootRepair(home) {
  const script = [
    'set -eu',
    `USER_CLAUDE_DIR=${JSON.stringify(join(home, '.claude'))}`,
    extractFunction('repair_hook_exec_bits'),
    extractBootRepair(),
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: runtimeEnv() });
}

function runSuccessfulBisync(home) {
  const claudeDir = join(home, '.claude');
  const recoveryFile = join(home, 'recovery-filters.txt');
  writeFileSync(recoveryFile, '');
  const script = [
    'set -euo pipefail',
    `USER_HOME=${JSON.stringify(home)}`,
    `USER_CLAUDE_DIR=${JSON.stringify(claudeDir)}`,
    "R2_BUCKET_NAME='bucket'",
    `RCLONE_CONFIG=${JSON.stringify(join(home, 'rclone.conf'))}`,
    `RECOVERY_FILTER_FILE=${JSON.stringify(recoveryFile)}`,
    'RCLONE_FILTERS=()',
    'pgrep() { return 1; }',
    'cleanup_main_transcripts() { :; }',
    'rclone() { return 0; }',
    'find() { if [ "${1:-}" = "/home/user" ]; then return 0; fi; command find "$@"; }',
    extractFunction('repair_hook_exec_bits'),
    extractFunction('record_sync_disk_failure'),
    extractFunction('bisync_with_r2'),
    'bisync_with_r2 ""',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8', env: runtimeEnv() });
}

describe('entrypoint repair_hook_exec_bits', () => {
  it('restores +x on hook scripts a sync stripped, leaving other files alone', () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-exec-'));
    const hooks = join(home, '.claude', 'hooks');
    mkdirSync(join(hooks, 'nested'), { recursive: true });

    // Exactly what a restore from R2 produces: right content, no exec bit.
    const fixtures = {
      'cache-heal.mjs': 0o644,
      'user-hook.sh': 0o644,
      'nested/deep.mjs': 0o644,
      'notes.md': 0o644,
    };
    for (const [rel, mode] of Object.entries(fixtures)) {
      writeFileSync(join(hooks, rel), '#!/usr/bin/env node\n', { mode });
    }

    assert.equal(runRepair(join(home, '.claude')), 0);

    // Spawnable hook types are repaired, including one level of nesting.
    assert.equal(modeOf(join(hooks, 'cache-heal.mjs')), '755');
    assert.equal(modeOf(join(hooks, 'user-hook.sh')), '755');
    assert.equal(modeOf(join(hooks, 'nested/deep.mjs')), '755');
    // A non-executable payload is not silently made executable.
    assert.equal(modeOf(join(hooks, 'notes.md')), '644');
  });

  it('is a no-op when the hooks directory does not exist', () => {
    // Runs on every boot and after every sync, including default-mode sessions
    // that never create the directory; a failure here would abort the caller.
    const home = mkdtempSync(join(tmpdir(), 'hook-exec-absent-'));
    assert.equal(runRepair(join(home, '.claude')), 0);
  });

  it('repairs a restored hook on the boot path before plugin setup', () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-exec-boot-'));
    const hooks = join(home, '.claude', 'hooks');
    const hook = join(hooks, 'cache-heal.mjs');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(hook, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o644 });
    chmodSync(hook, 0o644);

    const result = runBootRepair(home);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(modeOf(hook), '755');
  });

  it('repairs and can execute a hook after a successful bisync', () => {
    const home = mkdtempSync(join(tmpdir(), 'hook-exec-bisync-'));
    const hooks = join(home, '.claude', 'hooks');
    const hook = join(hooks, 'cache-heal.mjs');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(hook, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o644 });
    chmodSync(hook, 0o644);

    const result = runSuccessfulBisync(home);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(modeOf(hook), '755');
    const execution = spawnSync(hook, { encoding: 'utf8' });
    assert.equal(execution.status, 0, execution.stderr);
  });
});
