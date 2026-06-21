// Real behavioral tests for the vanishing-file recovery logic in
// entrypoint.sh (`recover_vanished_files`).
//
// Replaces the source-string audit assertions in
// host/__audits__/entrypoint-initial-sync.audit.js. Per
// tdd-discipline / engineering-constitution mandate 2 we RUN the real
// function body against representative rclone error output and assert on
// its OBSERVABLE EFFECTS: the recovery filter file it mutates and the
// recoverable/not-recoverable return code that drives the baseline retry
// loop. If `recover_vanished_files` were gutted to a no-op, the filter
// file would stay empty and the return code would be wrong, failing these.
//
// Mirrors the extract-body / spawn-in-bash-subshell / assert-side-effects
// harness in host/__tests__/entrypoint-bisync-behavior.test.js.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, '../../entrypoint.sh');

// Extract a top-level `name() { ... }` body (header to matching `^}`),
// same shape as extractDaemonBody() in entrypoint-bisync-behavior.test.js.
function extractFunctionBody(name) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  let start = -1;
  let end = -1;
  const header = new RegExp(`^${name}\\(\\) \\{`);
  for (let i = 0; i < lines.length; i++) {
    if (start === -1 && header.test(lines[i])) start = i;
    else if (start !== -1 && /^\}$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new Error(`Could not locate ${name}() in entrypoint.sh`);
  }
  return lines.slice(start, end + 1).join('\n');
}

const recoverBody = extractFunctionBody('recover_vanished_files');

// Run the real recover_vanished_files against `rcloneOutput`, returning
// { status, ret, filter } where:
//   - ret    = the function's exit code (0 = recoverable -> retry, 1 = not)
//   - filter = the contents of the session recovery filter file after the call
function runRecover(rcloneOutput) {
  const dir = mkdtempSync(join(tmpdir(), 'vanished-recover-'));
  const filterFile = join(dir, 'recovery-filters.txt');
  writeFileSync(filterFile, ''); // init_recovery_filters starts it empty

  const script = [
    'set -u',
    `RECOVERY_FILTER_FILE="${filterFile}"`,
    recoverBody,
    'recover_vanished_files "$1"',
    'echo "RET=$?"',
  ].join('\n');

  const res = spawnSync('bash', ['-c', script, '_', rcloneOutput], {
    encoding: 'utf-8',
  });
  const m = res.stdout.match(/RET=(\d+)/);
  return {
    status: res.status,
    stderr: res.stderr,
    ret: m ? Number(m[1]) : NaN,
    filter: existsSync(filterFile) ? readFileSync(filterFile, 'utf8') : null,
    filterFile,
  };
}

// rclone log line shape that recover_vanished_files parses: it greps for
// "failed to open source object.*no such file" and then extracts the path
// from the "lstat /home/user/<path>: no such file" fragment.
function vanishedLine(relPath) {
  return (
    `2024/01/01 12:00:00 ERROR : ${relPath}: failed to open source object: ` +
    `lstat /home/user/${relPath}: no such file or directory`
  );
}

describe('entrypoint.sh recover_vanished_files behavior (real) / REQ-STOR-004 AC5 (vanishing-file recovery filter)', () => {
  it('adds a vanished NON-workspace file to the session recovery filter and signals retry (REQ-STOR-004 AC5)', () => {
    const out = vanishedLine('.cache/rclone/tmpXYZ.partial');
    const r = runRecover(out);

    assert.equal(r.status, 0, `harness must run cleanly; stderr: ${r.stderr}`);
    assert.equal(
      r.ret,
      0,
      'a recoverable vanished file must return 0 so the baseline loop RETRIES',
    );
    // The exact exclude line the next bisync attempt consumes via --filter-from.
    assert.match(
      r.filter,
      /^- \.cache\/rclone\/tmpXYZ\.partial$/m,
      'the vanished non-workspace file must be appended to the recovery filter as an exclude rule',
    );
  });

  it('does NOT exclude a vanished WORKSPACE file (user code) but still signals a plain retry (REQ-STOR-004 AC5: workspace files trigger plain retry)', () => {
    const out = vanishedLine('workspace/myrepo/src/main.go');
    const r = runRecover(out);

    assert.equal(r.status, 0, `harness must run cleanly; stderr: ${r.stderr}`);
    assert.equal(
      r.ret,
      0,
      'a vanished workspace file must still return 0 (plain retry), never wedging the baseline',
    );
    assert.equal(
      r.filter.trim(),
      '',
      'workspace files are user code and must NOT be auto-excluded from sync',
    );
  });

  it('returns 1 (nothing recoverable) when the error is not a vanishing-file error, leaving the filter empty (REQ-STOR-004 AC5)', () => {
    const r = runRecover(
      '2024/01/01 12:00:00 ERROR : S3 bucket: AccessDenied: forbidden',
    );

    assert.equal(r.status, 0, `harness must run cleanly; stderr: ${r.stderr}`);
    assert.equal(
      r.ret,
      1,
      'a non-vanishing error must return 1 so the baseline does NOT loop forever (falls through to the non-recoverable break)',
    );
    assert.equal(
      r.filter.trim(),
      '',
      'no exclude rule should be written for an unrelated error',
    );
  });

  it('does not duplicate an already-excluded path across two recovery passes (REQ-STOR-004 AC5: idempotent filter accumulation)', () => {
    // Simulate two baseline attempts where the SAME ephemeral file vanishes
    // again on the retry. The second pass must not append a duplicate rule.
    const dir = mkdtempSync(join(tmpdir(), 'vanished-dup-'));
    const filterFile = join(dir, 'recovery-filters.txt');
    writeFileSync(filterFile, '');
    const out = vanishedLine('.claude/mcp-abc.json');

    const script = [
      'set -u',
      `RECOVERY_FILTER_FILE="${filterFile}"`,
      recoverBody,
      'recover_vanished_files "$1"; echo "RET1=$?"',
      'recover_vanished_files "$1"; echo "RET2=$?"',
    ].join('\n');
    const res = spawnSync('bash', ['-c', script, '_', out], {
      encoding: 'utf-8',
    });
    assert.equal(res.status, 0, `harness must run cleanly; stderr: ${res.stderr}`);

    const filter = readFileSync(filterFile, 'utf8');
    const occurrences = (
      filter.match(/^- \.claude\/mcp-abc\.json$/gm) || []
    ).length;
    assert.equal(
      occurrences,
      1,
      'the same vanished path must appear exactly once even across repeated recovery passes (grep -qxF -- dedupe guard)',
    );
  });
});
