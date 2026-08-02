import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
    assert.equal(
      strictSemverUpgrade('9007199254740992.0.0', '9007199254740993.0.0'),
      true,
    );
    assert.equal(
      strictSemverUpgrade('9007199254740993.0.0', '9007199254740992.0.0'),
      false,
    );
  });

  it('fails closed for versions outside the shadow-pin numeric contract', () => {
    for (const value of ['', 'v1.2.3', '1.2', '1.2.3-beta.1', '1.2.3 || true']) {
      assert.throws(() => strictSemverUpgrade(value, '2.0.0'), /numeric semantic version/);
      assert.throws(() => strictSemverUpgrade('1.0.0', value), /numeric semantic version/);
    }
  });
});

describe('shadow-pin workflow forward-only routing', () => {
  const cooldownComparatorSteps = Object.entries(workflow.jobs).flatMap(
    ([jobName, job]) => {
      const steps = job.steps ?? [];
      const usesCooldown = steps.some(
        (step) => step.uses === './.github/actions/npm-cooldown-version',
      );
      if (!usesCooldown) return [];
      return steps
        .filter((step) => (step.run ?? '').includes('scripts/ci/semver-forward.mjs'))
        .map((step) => ({ jobName, step }));
    },
  );

  it('routes every shared npm cooldown candidate through the forward-only comparator', () => {
    const cooldownJobs = Object.values(workflow.jobs).filter((job) =>
      (job.steps ?? []).some(
        (step) => step.uses === './.github/actions/npm-cooldown-version',
      ),
    );

    assert.equal(cooldownComparatorSteps.length, cooldownJobs.length);
  });

  it('fails every cooldown route when the comparator rejects malformed input', () => {
    const directory = mkdtempSync(join(tmpdir(), 'semver-forward-'));
    const node = join(directory, 'node');
    const jq = join(directory, 'jq');
    const output = join(directory, 'github-output');

    writeFileSync(
      node,
      '#!/usr/bin/env bash\nif [[ "$*" == *semver-forward.mjs* ]]; then exit 2; fi\nprintf "1.0.0"\n',
    );
    writeFileSync(jq, '#!/usr/bin/env bash\nprintf "1.0.0"\n');
    chmodSync(node, 0o755);
    chmodSync(jq, 0o755);

    try {
      for (const { jobName, step } of cooldownComparatorSteps) {
        const result = spawnSync('bash', ['-c', step.run], {
          cwd: resolve(__dirname, '../..'),
          encoding: 'utf8',
          env: {
            ...process.env,
            COOLDOWN_VERSION: 'malformed',
            GITHUB_OUTPUT: output,
            PATH: `${directory}:${process.env.PATH}`,
            PKG: 'example-package',
          },
        });
        assert.equal(result.status, 2, `${jobName} silently skipped malformed input`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
