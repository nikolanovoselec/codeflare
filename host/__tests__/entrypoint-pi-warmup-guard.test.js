// REQ-SESSION-015: container readiness must not be blocked by a failed
// best-effort startup step.
//
// Verifies the Pi warm-up and Fast Start update paths are guarded so a non-zero
// exit cannot abort the entrypoint (under `set -euo pipefail`) before the
// init-complete flag is written — the production regression fixed in PR #440.
//
// Strategy (same family as entrypoint-pi-transcript-cleanup.test.js): execute the
// real guarded warm-up call and the real update/readiness wrapper with failing
// stubs. A negative control reconstructs the unguarded warm-up form.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(__dirname, '..', '..', 'entrypoint.sh');

// Pull the real call lines (not the `name() {` definitions) out of entrypoint.sh.
// A trailing space after the name selects the invocation, not the definition.
function extractGuardedWarmupCall() {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const warm = lines.find((line) => line.startsWith('warm_pi_npm_dependencies '));
  assert.ok(warm, 'entrypoint.sh must invoke warm_pi_npm_dependencies (guarded)');
  return warm;
}

function extractSimpleFunction(name) {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  assert.ok(start >= 0 && end > start, `entrypoint.sh must define ${name}()`);
  return lines.slice(start, end + 1).join('\n');
}

// Run a startup snippet under the same shell options the entrypoint uses, with
// all guarded startup steps forced to FAIL. Returns { code, flagWritten }.
function runStartup(snippet, scratch) {
  const flag = join(scratch, 'codeflare-init-complete');
  const script = `set -euo pipefail
warm_pi_npm_dependencies() { return 1; }
${snippet}
# Critical post-step the entrypoint must reach: writing the init-complete flag.
touch '${flag}'
`;
  let code = 0;
  try {
    execFileSync('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code = typeof err.status === 'number' ? err.status : 1;
  }
  return { code, flagWritten: existsSync(flag) };
}

function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-warmup-guard-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('entrypoint startup update guards / REQ-SESSION-015 (a failed best-effort step must not block the init-complete flag)', () => {
  test('REQ-AGENT-206: executes the update before readiness and continues after failure', () => {
    const wrapper = extractSimpleFunction('release_agent_pty_after_fast_start_updates');
    const scratch = makeScratch();
    try {
      const output = execFileSync('bash', ['-c', `set -euo pipefail
${wrapper}
update_pi_and_codex_when_fast_start_disabled() { echo update; return 1; }
release_agent_pty_after_cleanup() { echo ready; }
USER_HOME='${scratch.dir}'
release_agent_pty_after_fast_start_updates
`], { encoding: 'utf8' });
      assert.deepEqual(output.trim().split('\n'), [
        'update',
        '[entrypoint] WARNING: update_pi_and_codex_when_fast_start_disabled failed; continuing startup',
        'ready',
      ]);
    } finally {
      scratch.cleanup();
    }
  });

  test('guarded warm-up call from entrypoint.sh still reaches the init-flag write when it fails', () => {
    const warm = extractGuardedWarmupCall();
    const scratch = makeScratch();
    try {
      const { code, flagWritten } = runStartup(warm, scratch.dir);
      assert.equal(code, 0, 'entrypoint must not abort when a warm-up step exits non-zero');
      assert.ok(flagWritten, 'init-complete flag must be written despite warm-up failure');
    } finally {
      scratch.cleanup();
    }
  });

  test('regression sentinel: an UNguarded call aborts before the init-flag write', () => {
    const scratch = makeScratch();
    try {
      // Pre-PR-#440 form: no `|| echo` guard. Under `set -e` this must abort
      // before the flag write — confirming the guard above is load-bearing.
      const { code, flagWritten } = runStartup(
        'warm_pi_npm_dependencies',
        scratch.dir,
      );
      assert.notEqual(code, 0, 'unguarded failing warm-up must abort the script');
      assert.ok(!flagWritten, 'init-complete flag must NOT be written when the entrypoint aborts');
    } finally {
      scratch.cleanup();
    }
  });
});
