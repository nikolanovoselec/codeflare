import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { evaluateChangedLineCoverage } from '../../scripts/ci/check-coverage-result.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const load = (name) => parseYaml(readFileSync(join(WORKFLOWS, name), 'utf8'));
const deploy = load('deploy.yml');
const stress = load('stress-test.yml');
const fuzz = load('fuzz.yml');
const pentest = load('pentest.yml');
const promotion = load('promotion-source.yml');
const release = load('sign-release.yml');
const prChecks = load('test.yml');
const coverageAction = parseYaml(readFileSync(join(ROOT, '.github', 'actions', 'coverage-suite', 'action.yml'), 'utf8'));

const step = (job, name) => job.steps.find((candidate) => candidate.name === name);

describe('deployment workflow safety', () => {
  it('queues same-environment deployments instead of cancelling a mutating run', () => {
    assert.match(deploy.concurrency.group, /deploy-/);
    assert.equal(deploy.concurrency['cancel-in-progress'], false);
  });

  it('wires deployment to the behaviorally tested service-user seed boundary', () => {
    const seed = step(deploy.jobs.deploy, 'Seed service user in KV (stress-test identity, optional)');
    assert.equal(seed.run, 'scripts/ci/seed-service-user.sh');
    assert.deepEqual(Object.keys(seed.env).sort(), [
      'CF_ACCESS_CLIENT_SECRET',
      'CLOUDFLARE_ACCOUNT_ID',
      'CLOUDFLARE_API_TOKEN',
      'OAUTH_E2E_TEST_SECRET',
    ]);
  });

  it('limits stress setup to probe credentials and validated target steps', () => {
    const setup = stress.jobs.setup;
    assert.deepEqual(Object.keys(setup.env).sort(), [
      'CF_ACCESS_CLIENT_ID',
      'CF_ACCESS_CLIENT_SECRET',
      'OAUTH_E2E_TEST_SECRET',
    ]);
    assert.deepEqual(setup.steps.map((candidate) => candidate.name ?? candidate.uses), [
      'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
      'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
      'Resolve target',
      'Smoke test',
    ]);
    const resolve = step(setup, 'Resolve target');
    assert.equal(resolve.run, 'node scripts/ci/normalize-https-origin.mjs "$RAW_BASE" base_url');
    assert.equal(setup.outputs.base_url, '${{ steps.target.outputs.base_url }}');
    assert.equal(step(setup, 'Smoke test').env.E2E_BASE_URL, '${{ steps.target.outputs.base_url }}');
  });
});

describe('least-privilege workflow boundaries', () => {
  it('grants no repository permission to the source-policy check', () => {
    assert.deepEqual(promotion.permissions, {});
  });

  it('grants pentest source access only to jobs that check out scripts', () => {
    assert.deepEqual(pentest.permissions, {});
    assert.deepEqual(pentest.jobs.target.permissions, { contents: 'read' });
    assert.deepEqual(pentest.jobs.tls.permissions, { contents: 'read' });
    for (const name of ['security-headers', 'auth-gate', 'info-disclosure', 'injection', 'http-methods']) {
      assert.equal(pentest.jobs[name].permissions, undefined, name);
    }
  });

  it('exposes the release token only to steps that invoke GitHub release APIs', () => {
    const job = release.jobs.sign;
    assert.equal(job.env?.GH_TOKEN, undefined);
    assert.equal(step(job, 'Validate release source').env.GH_TOKEN, '${{ github.token }}');
    assert.equal(step(job, 'Upload signed release assets').env.GH_TOKEN, '${{ github.token }}');
    for (const name of ['Build deterministic release archive', 'Install Cosign', 'Sign release assets', 'Attest release assets']) {
      assert.equal(step(job, name).env?.GH_TOKEN, undefined, name);
    }
  });
});

describe('REQ-OPS-022 AC6: bounded changed-production-line LCOV gate', () => {
  const productionDiff = (path, range = '1,5') => [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -0,0 +${range} @@`,
    '+changed',
  ].join('\n');
  const lcov = (path, hits) => [
    'TN:',
    `SF:${path}`,
    ...hits.map(([line, count]) => `DA:${line},${count}`),
    'end_of_record',
  ].join('\n');

  it('REQ-OPS-022 AC6: accepts a practical 80% changed-line floor without requiring 100%', () => {
    const result = evaluateChangedLineCoverage({
      diff: productionDiff('src/example.ts'),
      lcov: lcov('src/example.ts', [[1, 1], [2, 1], [3, 1], [4, 1], [5, 0]]),
      packageRoot: '.',
      threshold: 80,
    });

    assert.equal(result.ok, true);
    assert.equal(result.covered, 4);
    assert.equal(result.total, 5);
    assert.equal(result.percentage, 80);
  });

  it('REQ-OPS-022 AC6: fails when changed executable production lines fall below the package floor', () => {
    const result = evaluateChangedLineCoverage({
      diff: productionDiff('web-ui/src/example.tsx', '10,2'),
      lcov: lcov('web-ui/src/example.tsx', [[10, 1], [11, 0]]),
      packageRoot: 'web-ui',
      threshold: 70,
    });

    assert.equal(result.ok, false);
    assert.match(result.message, /50%.*70%/);
  });

  it('REQ-OPS-022 AC6: uses the destination path and changed destination lines for a rename', () => {
    const diff = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -4 +4 @@',
      '-old()',
      '+updated()',
    ].join('\n');
    const result = evaluateChangedLineCoverage({
      diff,
      lcov: lcov('src/new.ts', [[4, 1]]),
      packageRoot: '.',
      threshold: 80,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.files, ['src/new.ts']);
  });

  it('REQ-OPS-022 AC6: treats deletions and test-only changes as having no changed production evidence', () => {
    const deletion = [
      'diff --git a/src/retired.ts b/src/retired.ts',
      'deleted file mode 100644',
      '--- a/src/retired.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-retired()',
    ].join('\n');
    const testOnly = productionDiff('src/__tests__/example.test.ts');

    assert.equal(evaluateChangedLineCoverage({ diff: deletion, lcov: null, packageRoot: '.', threshold: 80 }).ok, true);
    assert.equal(evaluateChangedLineCoverage({ diff: testOnly, lcov: null, packageRoot: '.', threshold: 80 }).ok, true);
  });

  it('REQ-OPS-022 AC6: fails closed on missing, malformed, or file-incomplete LCOV required by a production change', () => {
    const diff = productionDiff('src/example.ts');
    const cases = [
      null,
      'SF:src/example.ts\nDA:not-a-line\nend_of_record',
      lcov('src/different.ts', [[1, 1]]),
    ];

    for (const evidence of cases) {
      const result = evaluateChangedLineCoverage({ diff, lcov: evidence, packageRoot: '.', threshold: 80 });
      assert.equal(result.ok, false);
    }
  });

  it('REQ-OPS-022 AC6: fails closed when the bounded diff or LCOV input limit is exceeded', () => {
    const diff = `${productionDiff('src/example.ts')}\n${'x'.repeat(300)}`;
    const report = `${lcov('src/example.ts', [[1, 1]])}\n${'x'.repeat(300)}`;

    assert.equal(evaluateChangedLineCoverage({ diff, lcov: report, packageRoot: '.', threshold: 80, maxDiffBytes: 100 }).ok, false);
    assert.equal(evaluateChangedLineCoverage({ diff: productionDiff('src/example.ts'), lcov: report, packageRoot: '.', threshold: 80, maxLcovBytes: 100 }).ok, false);
  });

  it('REQ-OPS-022 AC5/AC6: runs affected package coverage on pull requests with package-specific changed-line floors', () => {
    for (const [jobName, changedArea, packageRoot, threshold] of [
      ['coverage-backend', 'backend', '.', '80'],
      ['coverage-frontend', 'webui', 'web-ui', '70'],
    ]) {
      const job = prChecks.jobs[jobName];
      assert.doesNotMatch(job.if, /event_name != 'pull_request'/);
      assert.match(job.if, new RegExp(`needs\\.changes\\.outputs\\.${changedArea} == 'true'`));
      const coverage = job.steps.find((candidate) => candidate.uses === './.github/actions/coverage-suite');
      assert.equal(coverage.with['working-directory'], packageRoot);
      assert.equal(coverage.with['changed-base'], '${{ github.event.pull_request.base.sha }}');
      assert.equal(coverage.with['changed-line-threshold'], threshold);
    }

    const fetchBase = coverageAction.runs.steps.find((candidate) => candidate.name === 'Fetch changed-line base commit');
    const runCoverage = coverageAction.runs.steps.find((candidate) => candidate.name === 'Run suite with coverage');
    assert.equal(fetchBase.if, "inputs.changed-base != ''");
    assert.match(fetchBase.run, /git fetch --no-tags --depth=1 origin "\$CHANGED_BASE"/);
    assert.match(runCoverage.run, /coverage\/lcov\.info/);
    assert.match(runCoverage.run, /check-coverage-result\.mjs/);
    assert.match(runCoverage.run, /CHANGED_LINE_THRESHOLD/);
  });
});

describe('shared CI components', () => {
  it('installs every fuzz package tree before its corresponding suite', () => {
    const steps = fuzz.jobs.fuzz.steps;
    const installs = steps.filter((candidate) => candidate.uses === './.github/actions/install-deps');
    assert.deepEqual(installs.map((candidate) => candidate.with), [
      { directory: '.', 'key-prefix': 'fuzz-root' },
      { directory: 'web-ui', 'key-prefix': 'fuzz-web-ui' },
      { directory: 'host', 'key-prefix': 'fuzz-host' },
    ]);
    for (const [directory, suite] of [
      ['.', 'Run backend fuzz tests (extended iterations)'],
      ['web-ui', 'Run frontend fuzz tests'],
      ['host', 'Run host fuzz tests'],
    ]) {
      const installIndex = steps.findIndex((candidate) => candidate.with?.directory === directory);
      const suiteIndex = steps.findIndex((candidate) => candidate.name === suite);
      assert.ok(installIndex >= 0 && installIndex < suiteIndex, `${directory} dependencies must precede ${suite}`);
    }
    assert.doesNotMatch(JSON.stringify(steps), /npm ci/);
  });

  it('normalizes the pentest target once and fans six probes out from that output', () => {
    const target = pentest.jobs.target;
    assert.equal(target.outputs.target, '${{ steps.normalize.outputs.target }}');
    assert.equal(
      step(target, 'Normalize target URL').run,
      'node scripts/ci/normalize-https-origin.mjs "$RAW_TARGET" target',
    );
    const probes = ['security-headers', 'tls', 'auth-gate', 'info-disclosure', 'injection', 'http-methods'];
    for (const name of probes) {
      const job = pentest.jobs[name];
      assert.equal(job.needs, 'target', name);
      assert.equal(job.env.TARGET, '${{ needs.target.outputs.target }}', name);
      assert.equal(step(job, 'Normalize target URL'), undefined, name);
    }
  });
});
