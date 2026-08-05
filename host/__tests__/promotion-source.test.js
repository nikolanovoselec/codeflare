import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const workflow = parseYaml(
  readFileSync(resolve(root, '.github/workflows/promotion-source.yml'), 'utf8'),
);
const job = workflow.jobs['promotion-source'];
const validationStep = job.steps.at(-1);

function validate(base, head, headRepo = 'owner/repo', repository = 'owner/repo') {
  return spawnSync('bash', ['-euo', 'pipefail', '-c', validationStep.run], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BASE_REF: base,
      HEAD_REF: head,
      HEAD_REPO: headRepo,
      REPOSITORY: repository,
    },
  });
}

describe('REQ-OPS-036: protected main promotion source', () => {
  it('accepts develop as the only source for main and master', () => {
    for (const base of ['main', 'master']) {
      const accepted = validate(base, 'develop');
      assert.equal(accepted.status, 0, accepted.stderr);

      const rejected = validate(base, 'feature/direct-main');
      assert.equal(rejected.status, 1, `${base} accepted a non-develop source`);
      assert.match(rejected.stdout, /must originate from develop/);

      const forkDevelop = validate(base, 'develop', 'fork-owner/repo');
      assert.equal(forkDevelop.status, 1, `${base} accepted a fork's develop branch`);
      assert.match(forkDevelop.stdout, /canonical repository/);
    }
  });

  it('wires the validator to the protected promotion bases', () => {
    assert.deepEqual(workflow.on.pull_request.branches, ['main', 'master']);
    assert.deepEqual(workflow.permissions, {});
    assert.equal(job.name, 'Develop promotion source');
    assert.equal(validationStep.env.BASE_REF, '${{ github.base_ref }}');
    assert.equal(validationStep.env.HEAD_REF, '${{ github.head_ref }}');
    assert.equal(validationStep.env.HEAD_REPO, '${{ github.event.pull_request.head.repo.full_name }}');
    assert.equal(validationStep.env.REPOSITORY, '${{ github.repository }}');
  });
});
