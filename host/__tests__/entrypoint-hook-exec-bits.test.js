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
// from the post-sync path, these fail.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

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
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  return result.status;
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

  it('runs on the post-sync path, not only at boot', () => {
    // The boot-only repair is what left the bit stripped for a whole daemon
    // cycle. bisync_with_r2 is the single choke point every sync goes through -
    // the periodic round, the vanished-file retry, and the final sync on stop -
    // so the repair belongs in its success branch.
    const bisync = extractFunction('bisync_with_r2');
    const successBranch = bisync.slice(bisync.indexOf('if [ $RESULT -eq 0 ]; then'));
    assert.ok(
      successBranch.includes('repair_hook_exec_bits'),
      'a successful bisync must repair hook exec bits it may have just stripped',
    );
  });
});
