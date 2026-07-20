// zizmor runs twice in this repo, and the two runs must be the same auditor:
//
//   - test.yml's `workflow-audit` lane runs a checksum-pinned zizmor binary and
//     is the BLOCKING check (it feeds the required `test` context);
//   - zizmor.yml runs zizmor-action to upload SARIF to code scanning.
//
// If the versions drift, the alerts in the Security tab are produced by a
// different auditor than the one that gates merges: it reports findings nobody
// has to fix, and stays quiet about ones that block.
//
// The drift is not hypothetical. zizmor-action resolves `version:` against a
// digest table baked into the action release, so bumping the version input past
// what the pinned action knows fails every run with "Unknown version: X.Y.Z" —
// which is exactly what v0.5.6 + '1.27.0' did.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.github', 'workflows');

const read = (name) => readFileSync(join(WORKFLOWS, name), 'utf8');

function gateVersion() {
  const match = read('test.yml').match(/^\s*ZIZMOR_VERSION:\s*'([^']+)'/m);
  assert.ok(match, 'test.yml no longer declares ZIZMOR_VERSION — the blocking audit lane is gone or renamed');
  return match[1];
}

function sarifVersion() {
  const job = read('zizmor.yml');
  const match = job.match(/zizmorcore\/zizmor-action@[\s\S]*?^\s*version:\s*'([^']+)'/m);
  assert.ok(match, 'zizmor.yml no longer pins a zizmor version — the action would float to `latest`');
  return match[1];
}

describe('zizmor version lockstep', () => {
  it('audits with the same zizmor version in the blocking lane and the SARIF upload', () => {
    assert.equal(
      sarifVersion(),
      gateVersion(),
      'zizmor.yml and test.yml pin different zizmor versions, so code-scanning alerts and the merge gate disagree'
    );
  });

  it('pins the action itself to a digest, not a floating tag', () => {
    const match = read('zizmor.yml').match(/zizmorcore\/zizmor-action@([^\s#]+)/);
    assert.ok(match, 'zizmor.yml does not reference zizmor-action');
    assert.match(match[1], /^[0-9a-f]{40}$/, 'zizmor-action must be pinned to a full commit SHA');
  });
});
