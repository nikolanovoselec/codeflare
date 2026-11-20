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
  const cooldownRoutes = Object.entries(workflow.jobs).flatMap(([jobName, job]) => {
    const steps = job.steps ?? [];
    const usesCooldown = steps.some(
      (step) => step.uses === '$/.github/actions/npm-cooldown-version',
    );
    if (!usesCooldown) return [];
    return [{
      jobName,
      comparatorSteps: steps.filter((step) =>
        (step.run ?? '').includes('scripts/ci/semver-forward.mjs')),
    }];
  });

  it('routes every shared npm cooldown candidate through the forward-only comparator', () => {
    for (const { jobName, comparatorSteps } of cooldownRoutes) {
      assert.equal(
        comparatorSteps.length,
        1,
        `${jobName} must make exactly one forward-only decision`,
      );
    }
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
      for (const { jobName, comparatorSteps } of cooldownRoutes) {
        const result = spawnSync('bash', ['-c', comparatorSteps[0].run], {
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

describe('manual updater input and credential security contracts', () => {
  it('rejects malformed, non-forward and missing registry versions before publishing a candidate', () => {
    const directory = mkdtempSync(join(tmpdir(), 'manual-pin-security-'));
    const output = join(directory, 'output');
    const npm = join(directory, 'npm');
    // Registry metadata fixture only: never install or access the network.
    writeFileSync(npm, '#!/usr/bin/env bash\nprintf \'"%s"\\n\' "$REGISTRY_VERSION"\n');
    chmodSync(npm, 0o755);
    try {
      for (const [jobName, inputName] of [['agent-clis', 'PI_VERSION'], ['root-agents', 'REQUESTED_VERSION']]) {
        const step = workflow.jobs[jobName].steps.find(step => step.id === 'ver');
        for (const [requested, registry, accepted] of [
          ['999.0.0', '999.0.0', true],
          ['999.0.0', '998.0.0', false],
          ['0.0.0', '0.0.0', false],
          ['999.0.0-beta.1', '', false],
          ['0999.0.0', '', false],
          ['999.0.0\n', '', false],
          ['999.0.0\nlatest=1.0.0', '', false],
          ['$(exit 0)', '', false],
        ]) {
          writeFileSync(output, '');
          const result = spawnSync('bash', ['-c', step.run], {
            cwd: resolve(__dirname, '../..'), encoding: 'utf8',
            env: {
              ...process.env, PATH: `${directory}:${process.env.PATH}`,
              GITHUB_OUTPUT: output, COOLDOWN_VERSION: '',
              PKG: '@earendil-works/pi-coding-agent',
              [inputName]: requested, REGISTRY_VERSION: registry,
            },
          });
          assert.equal(result.status === 0, accepted, `${jobName}: ${JSON.stringify(requested)}: ${result.stderr}`);
          const published = readFileSync(output, 'utf8');
          if (accepted) assert.ok(published.includes(`latest=${requested}\n`));
          else assert.equal(published, '', 'untrusted candidates must not reach workflow outputs');
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not persist checkout credentials or expose tokens to dependency execution', () => {
    for (const jobName of ['agent-clis', 'root-agents']) {
      const job = workflow.jobs[jobName];
      assert.equal(job.env?.GH_TOKEN, undefined);
      for (const step of job.steps) {
        if (step.uses?.startsWith('actions/checkout@')) {
          assert.equal(step.with['persist-credentials'], false);
        }
        if (step.env?.GH_TOKEN) {
          assert.ok(/git push|gh pr create/.test(step.run), 'token belongs only to delivery steps');
          assert.doesNotMatch(step.run, /\bnpm\b|\bnode\b/, 'no dependency execution with a delivery token');
        }
      }
    }
  });
});
