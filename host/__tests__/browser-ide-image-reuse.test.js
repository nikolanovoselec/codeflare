import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import {
  browserIdeImageGate,
  fingerprintEntries,
  isBrowserIdeImageInput,
  resolveReusableBrowserIdeImageRun,
  uncoveredDockerfileSources,
  validateBrowserIdeImageEvidence,
} from '../../scripts/ci/browser-ide-image-reuse.mjs';

const repo = 'nikolanovoselec/codeflare';
const runId = '123456';
const pr = '716';
const fingerprint = 'a'.repeat(64);
const contractFingerprint = 'b'.repeat(64);
const testedCommit = 'c'.repeat(40);
const testedTree = 'd'.repeat(40);

const run = {
  id: Number(runId),
  status: 'completed',
  conclusion: 'success',
  event: 'pull_request',
  path: '.github/workflows/test.yml',
  head_sha: 'e'.repeat(40),
  run_attempt: 1,
  head_repository: { full_name: repo },
  pull_requests: [{ number: Number(pr) }],
};

const jobs = {
  total_count: 2,
  jobs: [
    { name: 'Browser IDE complete image', conclusion: 'success' },
    { name: 'test', conclusion: 'success' },
  ],
};

const receipt = {
  schema: 'codeflare.pr-checks-receipt.v2',
  repository: repo,
  workflowPath: '.github/workflows/test.yml',
  runId,
  runAttempt: 1,
  testedCommit,
  testedTree,
  lanes: {
    browserIdeImage: {
      fingerprint,
      result: 'executed',
      sourceRunId: runId,
    },
  },
};

const expected = { repo, pr, fingerprint, contractFingerprint, runId };
const evidence = (id = runId, overrides = {}) => ({
  run: { ...run, id: Number(id), ...overrides.run },
  jobs: overrides.jobs ?? jobs,
  receipt: {
    ...receipt,
    runId: id,
    lanes: {
      browserIdeImage: {
        ...receipt.lanes.browserIdeImage,
        sourceRunId: id,
        ...overrides.lane,
      },
    },
    ...overrides.receipt,
  },
  contractFingerprint: overrides.contractFingerprint ?? contractFingerprint,
});

describe('Browser IDE image input fingerprint', () => {
  it('covers packaged image inputs and excludes unrelated product surfaces', () => {
    for (const path of [
      'Dockerfile',
      '.dockerignore',
      '.cache-bust',
      'entrypoint.sh',
      'host/src/server.ts',
      'host/package-lock.json',
      'openvscode/agent-sidebar/src/extension.ts',
      'preseed/agents/pi/package.json',
      'src/lib/agent-seed.generated.ts',
      'scripts/browser-ide-ui-state.py',
      'scripts/materialize-agent-seed.mjs',
      'scripts/patch-context-mode-bundles.mjs',
      'scripts/ci/smoke-openvscode-sidebar-image.mjs',
    ]) assert.equal(isBrowserIdeImageInput(path), true, path);

    for (const path of [
      'landing/src/pages/index.astro',
      'web-ui/src/App.tsx',
      'src/index.ts',
      'README.md',
      'documentation/lanes/ci-cd.md',
      'sdd/spec/operations.md',
      'scripts/ci/validate-pr-checks-run.mjs',
      'host/__tests__/workflow-files.test.js',
      'openvscode/README.md',
    ]) assert.equal(isBrowserIdeImageInput(path), false, path);
  });

  it('fails reuse safe when a Dockerfile COPY source is outside the fingerprint', () => {
    const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
    assert.deepEqual(uncoveredDockerfileSources(dockerfile), []);
    assert.deepEqual(
      uncoveredDockerfileSources(`${dockerfile}\nCOPY landing/dist/ /srv/landing/\n`),
      ['landing/dist'],
    );
    assert.deepEqual(
      uncoveredDockerfileSources('COPY --from=builder /out /app/out\n'),
      [],
    );
  });

  it('is order-independent and changes only when selected Git entries change', () => {
    const entries = [
      { mode: '100644', type: 'blob', sha: '1'.repeat(40), path: 'Dockerfile' },
      { mode: '100644', type: 'blob', sha: '2'.repeat(40), path: 'landing/src/pages/index.astro' },
    ];
    const baseline = fingerprintEntries(entries, isBrowserIdeImageInput, 'browser-ide-image-v1');
    assert.equal(
      fingerprintEntries([...entries].reverse(), isBrowserIdeImageInput, 'browser-ide-image-v1'),
      baseline,
    );
    assert.equal(
      fingerprintEntries(
        entries.map((entry) => entry.path.startsWith('landing/') ? { ...entry, sha: '3'.repeat(40) } : entry),
        isBrowserIdeImageInput,
        'browser-ide-image-v1',
      ),
      baseline,
    );
    assert.notEqual(
      fingerprintEntries(
        entries.map((entry) => entry.path === 'Dockerfile' ? { ...entry, sha: '4'.repeat(40) } : entry),
        isBrowserIdeImageInput,
        'browser-ide-image-v1',
      ),
      baseline,
    );
  });
});

describe('Browser IDE image reuse evidence', () => {
  it('accepts a direct successful image execution from the same PR and workflow contract', () => {
    assert.doesNotThrow(() => validateBrowserIdeImageEvidence(evidence(), expected));
  });

  for (const [name, changed] of [
    ['another repository', { run: { head_repository: { full_name: 'attacker/fork' } } }],
    ['another PR', { run: { pull_requests: [{ number: 999 }] } }],
    ['another workflow', { run: { path: '.github/workflows/other.yml' } }],
    ['a non-PR event', { run: { event: 'push' } }],
    ['an unfinished run', { run: { status: 'in_progress' } }],
    ['a failed run', { run: { conclusion: 'failure' } }],
    ['a failed image job', { jobs: { ...jobs, jobs: [{ name: 'Browser IDE complete image', conclusion: 'failure' }, jobs.jobs[1]] } }],
    ['a skipped image job', { jobs: { ...jobs, jobs: [{ name: 'Browser IDE complete image', conclusion: 'skipped' }, jobs.jobs[1]] } }],
    ['a failed summary', { jobs: { ...jobs, jobs: [jobs.jobs[0], { name: 'test', conclusion: 'failure' }] } }],
    ['a truncated jobs page', { jobs: { total_count: 3, jobs: jobs.jobs } }],
    ['a changed image fingerprint', { lane: { fingerprint: 'f'.repeat(64) } }],
    ['a changed workflow contract', { contractFingerprint: 'f'.repeat(64) }],
    ['transitive reused evidence', { lane: { result: 'reused' } }],
    ['another source run', { lane: { sourceRunId: '999' } }],
    ['a malformed tested commit', { receipt: { testedCommit: 'branch-name' } }],
    ['another receipt repository', { receipt: { repository: 'attacker/fork' } }],
    ['another run attempt', { receipt: { runAttempt: 2 } }],
    ['an unknown receipt schema', { receipt: { schema: 'unknown' } }],
  ]) {
    it(`rejects evidence from ${name}`, () => {
      assert.throws(() => validateBrowserIdeImageEvidence(evidence(runId, changed), expected));
    });
  }

  it('selects the newest valid direct execution and falls back when none validates', () => {
    const loaded = [];
    const selected = resolveReusableBrowserIdeImageRun(['222', '111'], expected, (id) => {
      loaded.push(id);
      return id === '222'
        ? evidence(id, { lane: { fingerprint: 'f'.repeat(64) } })
        : evidence(id);
    });
    assert.deepEqual(selected, { reused: true, runId: '111' });
    assert.deepEqual(loaded, ['222', '111']);
    assert.deepEqual(
      resolveReusableBrowserIdeImageRun(['222'], expected, (id) =>
        evidence(id, { lane: { result: 'reused' } })),
      { reused: false },
    );
  });
});

describe('Browser IDE image aggregate gate', () => {
  const accepts = (values) => assert.doesNotThrow(() => browserIdeImageGate(values));
  const rejects = (values) => assert.throws(() => browserIdeImageGate(values));

  it('accepts unaffected skips, current execution, or validated reuse only', () => {
    accepts({ relevant: false, resolverResult: 'success', reused: false, imageResult: 'skipped' });
    accepts({ relevant: true, resolverResult: 'success', reused: false, imageResult: 'success' });
    accepts({ relevant: true, resolverResult: 'success', reused: true, imageResult: 'skipped' });
  });

  it('rejects plain relevant skips, double execution, and resolver failures', () => {
    rejects({ relevant: true, resolverResult: 'success', reused: false, imageResult: 'skipped' });
    rejects({ relevant: true, resolverResult: 'success', reused: true, imageResult: 'success' });
    rejects({ relevant: true, resolverResult: 'failure', reused: false, imageResult: 'skipped' });
    rejects({ relevant: false, resolverResult: 'success', reused: true, imageResult: 'skipped' });
  });
});

const resolver = new URL('../../scripts/ci/browser-ide-image-reuse.mjs', import.meta.url);

function runResolverCli(fixture, expectedContract = contractFingerprint) {
  const root = mkdtempSync(join(tmpdir(), 'browser-ide-reuse-'));
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
if (args[0] === 'api') {
  const endpoint = args.at(-1);
  if (endpoint.includes('/actions/workflows/test.yml/runs?')) {
    process.stdout.write(JSON.stringify({ workflow_runs: fixture.runs }));
  } else {
    const runMatch = endpoint.match(/actions\\/runs\\/(\\d+)(?:\\/(jobs))?/);
    const commitMatch = endpoint.match(/git\\/commits\\/([0-9a-f]{40})/);
    const treeMatch = endpoint.match(/git\\/trees\\/([0-9a-f]{40})/);
    if (runMatch) {
      const item = fixture.evidence[runMatch[1]];
      process.stdout.write(JSON.stringify(runMatch[2] ? item.jobs : item.run));
    } else if (commitMatch) {
      const item = Object.values(fixture.evidence).find((value) => value.run.head_sha === commitMatch[1]);
      process.stdout.write(JSON.stringify({ tree: { sha: item.contractTreeSha } }));
    } else if (treeMatch) {
      const item = Object.values(fixture.evidence).find((value) => value.contractTreeSha === treeMatch[1]);
      process.stdout.write(JSON.stringify({ tree: item.contractEntries, truncated: false }));
    } else process.exit(1);
  }
} else if (args[0] === 'run' && args[1] === 'download') {
  const item = fixture.evidence[args[2]];
  if (!item?.receipt) process.exit(1);
  const output = args[args.indexOf('--dir') + 1];
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'pr-checks-receipt.json'), JSON.stringify(item.receipt));
} else process.exit(1);
`);
  chmodSync(ghPath, 0o755);
  try {
    const result = spawnSync(process.execPath, [
      resolver.pathname,
      'resolve',
      repo,
      pr,
      fingerprint,
      expectedContract,
      '999999',
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

function cliEvidence(id, createdAt, overrides = {}) {
  const item = evidence(id, overrides);
  const contractEntries = [
    { mode: '100644', type: 'blob', sha: '7'.repeat(40), path: '.github/workflows/test.yml' },
    { mode: '100644', type: 'blob', sha: '8'.repeat(40), path: 'scripts/ci/browser-ide-image-reuse.mjs' },
  ];
  return {
    ...item,
    run: { ...item.run, head_sha: String(id).padStart(40, '0') },
    contractTreeSha: String(Number(id) + 10).padStart(40, '0'),
    contractEntries,
    created_at: createdAt,
  };
}

describe('Browser IDE image reuse CLI boundary', () => {
  it('uses one bounded newest-first run page and skips invalid evidence', () => {
    const older = cliEvidence('111', '2026-07-29T10:00:00Z');
    const newer = cliEvidence('222', '2026-07-29T11:00:00Z', {
      lane: { fingerprint: 'f'.repeat(64) },
    });
    const expectedContract = fingerprintEntries(
      older.contractEntries,
      (path) => path === '.github/workflows/test.yml' || path === 'scripts/ci/browser-ide-image-reuse.mjs',
      'browser-ide-reuse-contract-v1',
    );
    const result = runResolverCli({
      runs: [
        { id: 111, created_at: older.created_at, pull_requests: [{ number: Number(pr) }] },
        { id: 222, created_at: newer.created_at, pull_requests: [{ number: Number(pr) }] },
        { id: 333, created_at: '2026-07-29T12:00:00Z', pull_requests: [{ number: 999 }] },
      ],
      evidence: { 111: older, 222: newer },
    }, expectedContract);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { reused: true, runId: '111' });
    const enumeration = result.calls.filter((args) => args[0] === 'api' && args.at(-1).includes('/runs?'));
    assert.equal(enumeration.length, 1);
    assert.match(enumeration[0].at(-1), /per_page=100/);
    assert.equal(enumeration[0].includes('--paginate'), false);
    assert.deepEqual(
      result.calls.filter((args) => args[0] === 'run').map((args) => args[2]),
      ['222', '111'],
    );
    assert.equal(result.calls.some((args) => args.join(' ').includes('333')), false);
  });
});
