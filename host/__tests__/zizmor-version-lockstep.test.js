// zizmor runs twice in this repo, and the two runs must use the same validated
// manifest pin:
//
//   - test.yml's `workflow-audit` lane runs a checksum-pinned zizmor binary and
//     is the BLOCKING check (it feeds the required `test` context);
//   - zizmor.yml runs zizmor-action to upload SARIF to code scanning.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');
const pinPath = join(ROOT, '.github', 'workflow-tool-pins.json');
const pinScript = join(ROOT, 'scripts', 'ci', 'workflow-tool-pins.mjs');
const pins = JSON.parse(readFileSync(pinPath, 'utf8'));

describe('zizmor pin manifest', () => {
  it('emits one validated GitHub Actions output contract for both consumers', () => {
    const output = spawnSync(process.execPath, [pinScript, 'github-output', 'zizmor', pinPath], { encoding: 'utf8' });

    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout, `version=${pins.zizmor.version}\nsha256=${pins.zizmor.sha256}\n`);
  });

  it('pins the action itself to a digest, not a floating tag', () => {
    const match = read('zizmor.yml').match(/zizmorcore\/zizmor-action@([^\s#]+)/);
    assert.ok(match, 'zizmor.yml does not reference zizmor-action');
    assert.match(match[1], /^[0-9a-f]{40}$/, 'zizmor-action must be pinned to a full commit SHA');
  });
});
