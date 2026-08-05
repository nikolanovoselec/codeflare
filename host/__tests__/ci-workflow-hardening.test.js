import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const load = (name) => parseYaml(readFileSync(join(WORKFLOWS, name), 'utf8'));
const deploy = load('deploy.yml');
const stress = load('stress-test.yml');
const fuzz = load('fuzz.yml');
const pentest = load('pentest.yml');
const promotion = load('promotion-source.yml');
const release = load('sign-release.yml');

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

  it('keeps stress tests read-only and wires target resolution to the validated boundary', () => {
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

    const workflowContract = JSON.stringify(stress.jobs);
    assert.doesNotMatch(workflowContract, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/);
    assert.doesNotMatch(workflowContract, /\b(?:npx\s+)?wrangler\s|kv\s+key\s+put|secret\s+put/);
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
