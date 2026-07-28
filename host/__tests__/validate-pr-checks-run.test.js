import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePrChecksRun } from '../../scripts/ci/validate-pr-checks-run.mjs';

const expected = {
  repo: 'nikolanovoselec/codeflare',
  runId: '123456',
  sha: 'a'.repeat(40),
  tree: 'b'.repeat(40),
};

const run = {
  status: 'completed',
  conclusion: 'success',
  head_sha: expected.sha,
  path: '.github/workflows/test.yml',
  head_repository: { full_name: expected.repo },
};

const receipt = {
  repository: expected.repo,
  runId: expected.runId,
  testedCommit: 'c'.repeat(40),
  testedTree: expected.tree,
};

const jobs = {
  total_count: 2,
  jobs: [
    { name: 'Backend tests (shard-1)', conclusion: 'success' },
    { name: 'test', conclusion: 'success' },
  ],
};

describe('exact-head PR Checks run validation', () => {
  it('accepts a completed successful run for the exact repository and SHA with a green required summary', () => {
    assert.doesNotThrow(() => validatePrChecksRun(run, jobs, receipt, expected));
  });

  for (const [name, changedRun] of [
    ['wrong SHA', { ...run, head_sha: 'b'.repeat(40) }],
    ['wrong repository', { ...run, head_repository: { full_name: 'attacker/fork' } }],
    ['wrong workflow', { ...run, path: '.github/workflows/other.yml' }],
    ['unfinished run', { ...run, status: 'in_progress' }],
    ['failed run', { ...run, conclusion: 'failure' }],
  ]) {
    it(`rejects a ${name}`, () => {
      assert.throws(() => validatePrChecksRun(changedRun, jobs, receipt, expected));
    });
  }

  it('rejects a run without a successful required test summary', () => {
    assert.throws(() => validatePrChecksRun(run, {
      ...jobs,
      jobs: jobs.jobs.map((job) => job.name === 'test' ? { ...job, conclusion: 'failure' } : job),
    }, receipt, expected));
  });

  it('rejects a truncated jobs response instead of overlooking an unreturned required job', () => {
    assert.throws(() => validatePrChecksRun(run, { total_count: 3, jobs: jobs.jobs }, receipt, expected));
  });

  for (const [name, changedReceipt] of [
    ['wrong tested tree', { ...receipt, testedTree: 'd'.repeat(40) }],
    ['wrong receipt repository', { ...receipt, repository: 'attacker/fork' }],
    ['wrong receipt run id', { ...receipt, runId: '999999' }],
    ['malformed tested commit', { ...receipt, testedCommit: 'branch-name' }],
  ]) {
    it(`rejects a receipt with the ${name}`, () => {
      assert.throws(() => validatePrChecksRun(run, jobs, changedReceipt, expected));
    });
  }
});
