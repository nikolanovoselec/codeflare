// REQ-SESSION-015: container readiness must not be blocked by a failed
// best-effort startup step.
//
// Verifies the Pi warm-up calls in entrypoint.sh are guarded so a non-zero exit
// cannot abort the entrypoint (under `set -euo pipefail`) before the
// init-complete flag is written — the production regression fixed in PR #440.
//
// Strategy (same family as entrypoint-pi-transcript-cleanup.test.js): extract the
// REAL call lines from entrypoint.sh, run them in a bash subshell under the
// entrypoint's own shell options with the warm-up functions stubbed to FAIL, and
// assert execution still reaches the (simulated) init-flag write. A negative
// control reconstructs the pre-fix UNguarded form and asserts it aborts before the
// flag — proving the assertion detects the regression rather than passing vacuously.

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
function extractGuardedCalls() {
  const lines = readFileSync(ENTRYPOINT, 'utf8').split('\n');
  const warm = lines.find((l) => l.startsWith('warm_pi_npm_dependencies '));
  const update = lines.find((l) => l.startsWith('update_pi_when_fast_start_disabled '));
  assert.ok(warm, 'entrypoint.sh must invoke warm_pi_npm_dependencies (guarded)');
  assert.ok(update, 'entrypoint.sh must invoke update_pi_when_fast_start_disabled (guarded)');
  return { warm, update };
}

// Run a startup snippet under the same shell options the entrypoint uses, with
// both warm-up steps forced to FAIL. Returns { code, flagWritten }.
function runStartup(snippet, scratch) {
  const flag = join(scratch, 'codeflare-init-complete');
  const script = `set -euo pipefail
warm_pi_npm_dependencies() { return 1; }
update_pi_when_fast_start_disabled() { return 1; }
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

describe('entrypoint Pi warm-up guard / REQ-SESSION-015 (a failed best-effort step must not block the init-complete flag)', () => {
  test('guarded warm-up calls from entrypoint.sh still reach the init-flag write when they fail', () => {
    const { warm, update } = extractGuardedCalls();
    const scratch = makeScratch();
    try {
      const { code, flagWritten } = runStartup(`${warm}\n${update}`, scratch.dir);
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
        'warm_pi_npm_dependencies\nupdate_pi_when_fast_start_disabled',
        scratch.dir,
      );
      assert.notEqual(code, 0, 'unguarded failing warm-up must abort the script');
      assert.ok(!flagWritten, 'init-complete flag must NOT be written when the entrypoint aborts');
    } finally {
      scratch.cleanup();
    }
  });
});
