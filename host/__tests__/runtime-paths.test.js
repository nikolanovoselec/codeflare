import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CODEFLARE_RUNTIME_ROOT,
  OPENVSCODE_REQUEST_TRIGGER,
  OPENVSCODE_RUNTIME_DIR,
  SERVICES_RUNTIME_DIR,
  SYNC_DAEMON_PID_FILE,
  SYNC_LOG_FILE,
  SYNC_RUNTIME_DIR,
  SYNC_STATUS_FILE,
} from '../dist/runtime-paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

function extractFunction(name) {
  const lines = entrypoint.split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  if (start === -1) throw new Error(`Could not locate ${name}()`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (end === -1) throw new Error(`Could not locate end of ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

function captureRcloneArgs(functionName) {
  const fixture = mkdtempSync(join(tmpdir(), `codeflare-${functionName}-`));
  const runtimeRoot = join(fixture, 'run');
  const syncDir = join(runtimeRoot, 'sync');
  const argsFile = join(fixture, 'rclone-args');
  mkdirSync(join(syncDir, 'rclone'), { recursive: true });
  const script = [
    'set -e',
    `SYNC_RUNTIME_DIR='${syncDir}'`,
    `USER_HOME='${fixture}/home'`,
    "R2_BUCKET_NAME='bucket'",
    "RCLONE_CONFIG='/dev/null'",
    'RCLONE_FILTERS=()',
    `RECOVERY_FILTER_FILE='${syncDir}/recovery-filters.txt'`,
    `: > "$RECOVERY_FILTER_FILE"`,
    `rclone() { printf '%s\\n' "$*" >> '${argsFile}'; }`,
    'timeout() { shift; "$@"; }',
    'cleanup_main_transcripts() { :; }',
    'repair_hook_exec_bits() { :; }',
    'recover_vanished_files() { return 1; }',
    'pgrep() { return 1; }',
    'find() { :; }',
    extractFunction(functionName).replaceAll('/run/codeflare', runtimeRoot),
    functionName,
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return { args: readFileSync(argsFile, 'utf8'), syncDir };
}

describe('REQ-OPS-047: cleanup-safe container runtime state', () => {
  it('keeps required host runtime paths outside disposable /tmp', () => {
    assert.equal(CODEFLARE_RUNTIME_ROOT, '/run/codeflare');
    for (const path of [
      SYNC_RUNTIME_DIR,
      SERVICES_RUNTIME_DIR,
      OPENVSCODE_RUNTIME_DIR,
      SYNC_DAEMON_PID_FILE,
      SYNC_STATUS_FILE,
      SYNC_LOG_FILE,
      OPENVSCODE_REQUEST_TRIGGER,
    ]) {
      assert.ok(path.startsWith(`${CODEFLARE_RUNTIME_ROOT}/`), `${path} must be process-lifetime state`);
      assert.ok(!path.startsWith('/tmp/'), `${path} must survive disposable /tmp cleanup`);
    }
  });

  it('passes the protected rclone workdir through establish_bisync_baseline', () => {
    const { args, syncDir } = captureRcloneArgs('establish_bisync_baseline');
    assert.match(args, new RegExp(`--workdir ${syncDir}/rclone(?:\\s|$)`));
  });

  it('passes the protected rclone workdir through bisync_with_r2', () => {
    const { args, syncDir } = captureRcloneArgs('bisync_with_r2');
    assert.match(args, new RegExp(`--workdir ${syncDir}/rclone(?:\\s|$)`));
  });
});
