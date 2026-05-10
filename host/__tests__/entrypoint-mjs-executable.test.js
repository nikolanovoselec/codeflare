// Tests that the entrypoint chmods .mjs hook files in ~/.claude/hooks/
// to 0755 so the CLI's shebang-based execution path doesn't fail with
// "Permission denied".
//
// Per tdd-discipline: real fs setup, real chmod step run as bash, real
// exec attempt, observable assertions. No text-matching.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, statSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

// Extract the chmod step body. It's a 3-line `if [ -d ... ]; then find ... fi`
// block. We run it as a small bash snippet against a tmp HOME.
function extractChmodSnippet() {
  const startMarker = '# Ensure any .mjs hook files';
  const start = ENTRYPOINT.indexOf(startMarker);
  assert.ok(start > -1, 'chmod block not found in entrypoint.sh');
  const blockStart = ENTRYPOINT.indexOf('if [ -d', start);
  const blockEnd = ENTRYPOINT.indexOf('\nfi\n', blockStart) + 3;
  return ENTRYPOINT.slice(blockStart, blockEnd);
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'mjs-'));
  const hooksDir = join(home, '.claude', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  return { home, hooksDir };
}

function runChmodStep(home) {
  const snippet = extractChmodSnippet();
  // Inline the variable the snippet references.
  const script = `USER_CLAUDE_DIR="${home}/.claude"\n${snippet}`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  assert.equal(result.status, 0, `bash chmod step failed: ${result.stderr}`);
}

describe('entrypoint chmod for ~/.claude/hooks/*.mjs', () => {
  it('chmods a non-executable .mjs file to 0755', () => {
    const { home, hooksDir } = setup();
    const hook = join(hooksDir, 'cache-heal.mjs');
    // Simulate the CLI's self-install: writes the file with 0644.
    writeFileSync(hook, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o644 });
    chmodSync(hook, 0o644);

    const before = statSync(hook).mode & 0o777;
    assert.equal(before, 0o644, 'precondition: file starts at 0644');

    runChmodStep(home);

    const after = statSync(hook).mode & 0o777;
    assert.equal(after, 0o755, 'file should be 0755 after chmod step');
  });

  it('a chmodded .mjs is exec-able via bash shebang path', () => {
    // This is the actual bug repro: bash refuses to exec a 0644 .mjs even
    // with a valid shebang. After chmod, the same exec succeeds.
    const { home, hooksDir } = setup();
    const hook = join(hooksDir, 'probe.mjs');
    writeFileSync(hook, '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o644 });
    chmodSync(hook, 0o644);

    // Before chmod: exec via bash should fail with Permission denied.
    const before = spawnSync('bash', ['-c', hook], { encoding: 'utf-8' });
    assert.notEqual(before.status, 0, 'precondition: exec fails before chmod');
    assert.match(before.stderr, /[Pp]ermission denied/);

    runChmodStep(home);

    // After chmod: exec via bash should succeed (exit 0 from the script).
    const after = spawnSync('bash', ['-c', hook], { encoding: 'utf-8' });
    assert.equal(after.status, 0, `exec should succeed after chmod, got ${after.stderr}`);
  });

  it('handles missing hooks dir without erroring (no-op)', () => {
    // Fresh container, no hooks dir yet. Step must not fail.
    const home = mkdtempSync(join(tmpdir(), 'mjs-empty-'));
    runChmodStep(home);
    // No assertion needed — runChmodStep itself asserts exit 0.
  });

  it('chmods multiple .mjs files in one pass', () => {
    const { home, hooksDir } = setup();
    const a = join(hooksDir, 'a.mjs');
    const b = join(hooksDir, 'b.mjs');
    writeFileSync(a, '#!/usr/bin/env node\n');
    writeFileSync(b, '#!/usr/bin/env node\n');
    chmodSync(a, 0o644);
    chmodSync(b, 0o644);

    runChmodStep(home);

    assert.equal(statSync(a).mode & 0o777, 0o755);
    assert.equal(statSync(b).mode & 0o777, 0o755);
  });

  it('does not chmod non-.mjs files', () => {
    const { home, hooksDir } = setup();
    const sh = join(hooksDir, 'thing.sh');
    writeFileSync(sh, '#!/bin/bash\n');
    chmodSync(sh, 0o644);

    runChmodStep(home);

    assert.equal(
      statSync(sh).mode & 0o777,
      0o644,
      '.sh files should be left alone (the codeflare-(hooks|memory) plugin scripts are bash-invoked, not exec\\d)'
    );
  });
});
