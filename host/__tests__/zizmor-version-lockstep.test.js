// zizmor runs twice in this repo, and the two runs must use the same validated
// manifest pin:
//
//   - test.yml's `workflow-audit` lane runs a checksum-pinned zizmor binary and
//     is the BLOCKING check (it feeds the required `test` context);
//   - zizmor.yml runs zizmor-action to upload SARIF to code scanning.
//
// If either workflow stops reading the shared pin, the alerts in the Security
// tab can be produced by a different auditor than the one that gates merges.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');
const pins = JSON.parse(readFileSync(join(ROOT, '.github', 'workflow-tool-pins.json'), 'utf8'));

describe('zizmor version lockstep', () => {
  it('feeds both the blocking audit and SARIF upload from the shared pin', () => {
    const gate = read('test.yml');
    const sarif = read('zizmor.yml');

    assert.match(gate, /ZIZMOR_VERSION: \$\{\{ steps\.zizmor-pin\.outputs\.version \}\}/);
    assert.match(gate, /ZIZMOR_SHA256: \$\{\{ steps\.zizmor-pin\.outputs\.sha256 \}\}/);
    assert.match(sarif, /version: \$\{\{ steps\.zizmor-pin\.outputs\.version \}\}/);
    assert.match(pins.zizmor.version, /^\d+\.\d+\.\d+$/);
    assert.match(pins.zizmor.sha256, /^[0-9a-f]{64}$/);
  });

  it('pins the action itself to a digest, not a floating tag', () => {
    const match = read('zizmor.yml').match(/zizmorcore\/zizmor-action@([^\s#]+)/);
    assert.ok(match, 'zizmor.yml does not reference zizmor-action');
    assert.match(match[1], /^[0-9a-f]{40}$/, 'zizmor-action must be pinned to a full commit SHA');
  });
});
