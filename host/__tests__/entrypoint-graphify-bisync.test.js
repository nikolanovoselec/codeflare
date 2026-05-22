// Verifies REQ-AGENT-026 AC1: rclone bisync filter in entrypoint.sh excludes
// **/graphify-out/** so R2 never carries graphify artifacts. Per-repo graph
// data is committed to git (or kept local-ephemeral) - never sync'd via R2.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entrypoint = readFileSync(resolve(__dirname, '../../entrypoint.sh'), 'utf8');

describe('entrypoint.sh rclone bisync filter for graphify (REQ-AGENT-026)', () => {
  it('AC1: explicitly excludes **/graphify-out/** from R2 bisync', () => {
    assert.ok(
      entrypoint.includes('--filter "- **/graphify-out/**"'),
      'entrypoint.sh must contain an `--filter "- **/graphify-out/**"` exclude line in the rclone filter list'
    );
  });

  it('AC1: the exclude is placed inside the rclone bisync filter block, not in dead code', () => {
    const excludeIdx = entrypoint.indexOf('--filter "- **/graphify-out/**"');
    assert.notEqual(excludeIdx, -1);
    // The filter must be inside an rclone invocation block. The simplest
    // structural check: find the surrounding bisync command marker before it.
    const blockStart = entrypoint.lastIndexOf('rclone bisync', excludeIdx);
    assert.notEqual(
      blockStart,
      -1,
      'the graphify-out exclude line must live inside an rclone bisync filter block'
    );
    // Distance sanity-check: rclone block opener should be reasonably close
    // (within ~6KB) to the filter line. If a refactor moves the filter list
    // out of the rclone invocation, this catches it.
    assert.ok(
      excludeIdx - blockStart < 6000,
      'graphify-out exclude is suspiciously far from the rclone bisync call (possible orphaned filter)'
    );
  });

  it('AC1: no INCLUDE filter for graphify-out (would defeat the exclude)', () => {
    assert.ok(
      !/--filter\s+"\+\s+\*\*\/graphify-out\/\*\*"/.test(entrypoint),
      'entrypoint.sh must NOT contain an include filter for graphify-out/'
    );
    assert.ok(
      !/--filter\s+"\+\s+graphify-out\//.test(entrypoint),
      'entrypoint.sh must NOT contain an include filter for graphify-out/ artifacts'
    );
  });
});
