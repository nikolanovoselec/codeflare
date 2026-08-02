import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

import { strictSemverUpgrade } from '../../scripts/ci/semver-forward.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflow = parseYaml(
  readFileSync(resolve(__dirname, '../../.github/workflows/bump-shadow-pins.yml'), 'utf8'),
);

describe('strictSemverUpgrade', () => {
  it('permits only a strictly newer numeric semantic version', () => {
    assert.equal(strictSemverUpgrade('0.31.0', '0.43.0'), true);
    assert.equal(strictSemverUpgrade('0.43.0', '0.43.1'), true);
    assert.equal(strictSemverUpgrade('0.43.0', '0.44.0'), true);
    assert.equal(strictSemverUpgrade('0.43.0', '1.0.0'), true);

    assert.equal(strictSemverUpgrade('0.43.0', '0.43.0'), false);
    assert.equal(strictSemverUpgrade('0.43.0', '0.31.0'), false);
    assert.equal(strictSemverUpgrade('1.0.0', '0.99.99'), false);
  });

  it('fails closed for versions outside the shadow-pin numeric contract', () => {
    for (const value of ['', 'v1.2.3', '1.2', '1.2.3-beta.1', '1.2.3 || true']) {
      assert.throws(() => strictSemverUpgrade(value, '2.0.0'), /numeric semantic version/);
      assert.throws(() => strictSemverUpgrade('1.0.0', value), /numeric semantic version/);
    }
  });
});

describe('shadow-pin workflow forward-only routing', () => {
  it('routes every shared npm cooldown candidate through the forward-only comparator', () => {
    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      const steps = job.steps ?? [];
      const usesCooldown = steps.some(
        (step) => step.uses === './.github/actions/npm-cooldown-version',
      );
      if (!usesCooldown) continue;

      const comparatorSteps = steps.filter((step) =>
        (step.run ?? '').includes('scripts/ci/semver-forward.mjs'),
      );
      assert.equal(
        comparatorSteps.length,
        1,
        `${jobName} must make exactly one forward-only decision for its cooldown candidate`,
      );
    }
  });
});
