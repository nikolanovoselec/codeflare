import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveReusablePrChecksRun,
  validatePrChecksRun,
} from '../../scripts/ci/validate-pr-checks-run.mjs';

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
  schema: 'codeflare.pr-checks-receipt.v3',
  repository: expected.repo,
  workflowPath: '.github/workflows/test.yml',
  runId: expected.runId,
  runAttempt: 1,
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

const validator = new URL('../../scripts/ci/validate-pr-checks-run.mjs', import.meta.url);

function runResolverCli(fixture, explicitRunId = '') {
  const root = mkdtempSync(join(tmpdir(), 'pr-checks-resolver-'));
  const fixturePath = join(root, 'fixture.json');
  const callsPath = join(root, 'calls.jsonl');
  const ghPath = join(root, 'gh');
  writeFileSync(fixturePath, JSON.stringify(fixture));
  writeFileSync(ghPath, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
fs.appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'api' && args.includes('--slurp')) {
  process.stdout.write(JSON.stringify([{ workflow_runs: fixture.runs }]));
} else if (args[0] === 'api') {
  const endpoint = args.at(-1);
  const match = endpoint.match(/actions\\/runs\\/(\\d+)(?:\\/(jobs))?/);
  const evidence = fixture.evidence[match?.[1]];
  if (!evidence) process.exit(1);
  process.stdout.write(JSON.stringify(match?.[2] ? evidence.jobs : evidence.run));
} else if (args[0] === 'run' && args[1] === 'download') {
  const evidence = fixture.evidence[args[2]];
  if (!evidence?.receipt) process.exit(1);
  const output = args[args.indexOf('--dir') + 1];
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'pr-checks-receipt.json'), JSON.stringify(evidence.receipt));
} else {
  process.exit(1);
}
`);
  chmodSync(ghPath, 0o755);
  try {
    const result = spawnSync(process.execPath, [
      validator.pathname,
      'resolve',
      expected.repo,
      expected.sha,
      expected.tree,
      explicitRunId,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GH_FIXTURE: fixturePath,
        GH_CALLS: callsPath,
      },
    });
    const calls = readFileSync(callsPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    return { ...result, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cliEvidence(runId, overrides = {}) {
  return {
    run: { ...run, ...overrides.run },
    jobs: overrides.jobs ?? jobs,
    receipt: { ...receipt, runId, ...overrides.receipt },
  };
}

describe('automatic exact-tree PR Checks CLI resolution', () => {
  it('sorts discovered runs newest-first and skips an invalid newest receipt', () => {
    const result = runResolverCli({
      runs: [
        { id: 111, head_sha: expected.sha, created_at: '2026-07-29T10:00:00Z' },
        { id: 222, head_sha: expected.sha, created_at: '2026-07-29T11:00:00Z' },
      ],
      evidence: {
        111: cliEvidence('111'),
        222: cliEvidence('222', { receipt: { testedTree: 'd'.repeat(40) } }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { verified: true, runId: '111' });
    assert.deepEqual(
      result.calls.filter((args) => args[0] === 'run').map((args) => args[2]),
      ['222', '111'],
    );
  });

  it('returns inline fallback only after every discovered receipt is invalid', () => {
    const result = runResolverCli({
      runs: [{ id: 222, head_sha: expected.sha, created_at: '2026-07-29T11:00:00Z' }],
      evidence: { 222: cliEvidence('222', { receipt: { testedTree: 'd'.repeat(40) } }) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { verified: false });
  });

  it('fails a bad explicit override without enumerating automatic candidates', () => {
    const result = runResolverCli({
      runs: [{ id: 111, head_sha: expected.sha, created_at: '2026-07-29T10:00:00Z' }],
      evidence: { 999: cliEvidence('999', { receipt: { testedTree: 'd'.repeat(40) } }) },
    }, '999');
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.some((args) => args.includes('--slurp')), false);
  });
});

describe('automatic exact-tree PR Checks run resolution', () => {
  const evidence = (runId, overrides = {}) => ({
    run: { ...run, ...overrides.run },
    jobs: overrides.jobs ?? jobs,
    receipt: { ...receipt, runId, ...overrides.receipt },
  });

  it('selects the first valid run after skipping a newer invalid candidate', () => {
    const loaded = [];
    const result = resolveReusablePrChecksRun(['222', '111'], '', expected, (runId) => {
      loaded.push(runId);
      return runId === '222'
        ? evidence(runId, { receipt: { testedTree: 'd'.repeat(40) } })
        : evidence(runId);
    });
    assert.deepEqual(result, { verified: true, runId: '111' });
    assert.deepEqual(loaded, ['222', '111']);
  });

  it('falls back when every automatically discovered candidate is invalid', () => {
    const result = resolveReusablePrChecksRun(['222', '111'], '', expected, (runId) =>
      evidence(runId, { receipt: { testedTree: 'd'.repeat(40) } }));
    assert.deepEqual(result, { verified: false });
  });

  it('stops loading candidates after the first valid run', () => {
    const loaded = [];
    const result = resolveReusablePrChecksRun(['222', '111'], '', expected, (runId) => {
      loaded.push(runId);
      return evidence(runId);
    });
    assert.deepEqual(result, { verified: true, runId: '222' });
    assert.deepEqual(loaded, ['222']);
  });

  it('fails closed instead of falling back when an explicit run is invalid', () => {
    assert.throws(() => resolveReusablePrChecksRun(['222'], '999', expected, (runId) =>
      evidence(runId, { receipt: { testedTree: 'd'.repeat(40) } })));
  });
});

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
    ['wrong schema', { ...receipt, schema: 'codeflare.pr-checks-receipt.v2' }],
    ['wrong workflow', { ...receipt, workflowPath: '.github/workflows/other.yml' }],
    ['invalid run attempt', { ...receipt, runAttempt: 0 }],
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
