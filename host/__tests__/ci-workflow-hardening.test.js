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

  it('fails a configured deployment when service-user seeding exhausts bounded retries', () => {
    const seed = step(deploy.jobs.deploy, 'Seed service user in KV (stress-test identity, optional)');
    assert.ok(seed);
    assert.match(seed.run, /for attempt in 1 2 3/);
    assert.match(seed.run, /wrangler kv key put/);
    assert.match(seed.run, /exit 1/);
    assert.doesNotMatch(seed.run, /non-fatal/);
  });

  it('keeps stress tests read-only against the deployed target', () => {
    const setup = stress.jobs.setup;
    const source = JSON.stringify(setup);
    assert.doesNotMatch(source, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID/);
    assert.doesNotMatch(source, /wrangler|secret put|kv key put/);
    assert.ok(step(setup, 'Smoke test'));
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
  it('uses the lock-keyed dependency installer for every fuzz package tree', () => {
    const installs = fuzz.jobs.fuzz.steps.filter((candidate) => candidate.uses === './.github/actions/install-deps');
    assert.deepEqual(installs.map((candidate) => candidate.with), [
      { directory: '.', 'key-prefix': 'fuzz-root' },
      { directory: 'web-ui', 'key-prefix': 'fuzz-web-ui' },
      { directory: 'host', 'key-prefix': 'fuzz-host' },
    ]);
    assert.doesNotMatch(JSON.stringify(fuzz.jobs.fuzz.steps), /npm ci/);
  });

  it('normalizes the pentest target once and fans six probes out from that output', () => {
    const target = pentest.jobs.target;
    assert.equal(target.outputs.target, '${{ steps.normalize.outputs.target }}');
    const probes = ['security-headers', 'tls', 'auth-gate', 'info-disclosure', 'injection', 'http-methods'];
    for (const name of probes) {
      const job = pentest.jobs[name];
      assert.equal(job.needs, 'target', name);
      assert.equal(job.env.TARGET, '${{ needs.target.outputs.target }}', name);
      assert.equal(step(job, 'Normalize target URL'), undefined, name);
    }
  });
});
