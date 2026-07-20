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
    // This used to assert the exclude was within 6000 characters of the nearest
    // `rclone bisync` string. That is a proxy, not a property: it drifts with
    // unrelated edits anywhere in between (adding comments to the shutdown
    // handler broke it while the filter was exactly where it should be), and it
    // would happily pass a filter sitting in genuinely dead code 5KB above the
    // command. Assert membership of the live filter array instead, which is what
    // "not in dead code" actually means here.
    const arrayMatch = entrypoint.match(/^RCLONE_FILTERS_COMMON=\(([\s\S]*?)^\)/m);
    assert.ok(arrayMatch, 'entrypoint.sh must define a RCLONE_FILTERS_COMMON array');
    assert.ok(
      arrayMatch[1].includes('--filter "- **/graphify-out/**"'),
      'the graphify-out exclude must be a member of RCLONE_FILTERS_COMMON, not a stray line elsewhere in the file'
    );
    // And that array must be what the bisync invocations actually expand.
    assert.ok(
      /RCLONE_FILTERS=\(\s*\n\s*"\$\{RCLONE_FILTERS_COMMON\[@\]\}"/.test(entrypoint),
      'RCLONE_FILTERS_COMMON must be spread into the RCLONE_FILTERS array the bisync calls use'
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
