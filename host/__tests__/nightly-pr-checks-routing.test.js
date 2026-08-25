import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const prChecks = parseYaml(readFileSync(join(WORKFLOWS, 'test.yml'), 'utf8'));
const nightly = parseYaml(readFileSync(join(WORKFLOWS, 'nightly-pr-checks.yml'), 'utf8'));
const deploy = parseYaml(readFileSync(join(WORKFLOWS, 'deploy.yml'), 'utf8'));

describe('nightly PR Checks routing', () => {
  it('keeps scheduled verification outside the deploy-triggering workflow identity', () => {
    assert.equal(prChecks.name, 'PR Checks');
    assert.equal(prChecks.on.schedule, undefined);
    assert.equal(nightly.name, 'Nightly PR Checks');
    assert.notEqual(nightly.name, prChecks.name);
    assert.deepEqual(nightly.on.schedule, [{ cron: '30 3 * * *' }]);
    assert.deepEqual(deploy.on.workflow_run.workflows, ['PR Checks']);
    assert.ok(!deploy.on.workflow_run.workflows.includes(nightly.name));
  });

  it('calls the canonical full matrix without copying any test lane', () => {
    assert.deepEqual(nightly.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(nightly.jobs), ['full-matrix']);
    assert.equal(nightly.jobs['full-matrix'].uses, './.github/workflows/test.yml');
    assert.equal(nightly.jobs['full-matrix'].secrets, undefined);

    const changes = prChecks.jobs.changes;
    assert.equal(changes.outputs.full, "${{ steps.filter.outcome == 'skipped' }}");
    const filter = changes.steps.find((step) => step.id === 'filter');
    assert.match(filter.if, /github\.event_name == 'pull_request'/);
    assert.match(filter.if, /github\.event_name == 'push'/);
  });

  it('falls back to a checked-out exact diff without weakening lane coverage when the PR files API fails', () => {
    const changes = prChecks.jobs.changes;
    const checkout = changes.steps.find((step) => String(step.uses).startsWith('actions/checkout@'));
    const filter = changes.steps.find((step) => step.id === 'filter');
    const fallback = changes.steps.find((step) => step.id === 'filter_fallback');

    assert.equal(checkout.with['fetch-depth'], 0);
    assert.equal(filter['continue-on-error'], true);
    assert.equal(fallback.if, "steps.filter.outcome == 'failure'");
    assert.equal(fallback.run, 'scripts/ci/path-filter-fallback.sh');
    for (const lane of ['backend', 'webui', 'landing', 'host', 'ide', 'workflows']) {
      assert.match(changes.outputs[lane], new RegExp(`steps\\.filter_fallback\\.outputs\\.${lane}`));
    }
  });

  it('REQ-OPS-003: executes the fallback against exact commits and emits every lane', () => {
    const repository = mkdtempSync(join(tmpdir(), 'path-filter-fallback-'));
    const output = join(repository, 'github-output');
    const runnerTemp = join(repository, 'runner-temp');
    try {
      execFileSync('git', ['init', '-q'], { cwd: repository });
      execFileSync('git', ['config', 'user.email', 'ci@example.invalid'], { cwd: repository });
      execFileSync('git', ['config', 'user.name', 'CI'], { cwd: repository });
      writeFileSync(join(repository, 'fixture.txt'), 'base\n');
      execFileSync('git', ['add', '.'], { cwd: repository });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: repository });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
      writeFileSync(join(repository, 'fixture.txt'), 'head\n');
      execFileSync('git', ['commit', '-qam', 'head'], { cwd: repository });
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
      writeFileSync(output, '');

      execFileSync(join(ROOT, 'scripts', 'ci', 'path-filter-fallback.sh'), [], {
        cwd: repository,
        env: { ...process.env, BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output, RUNNER_TEMP: runnerTemp },
      });

      assert.deepEqual(readFileSync(output, 'utf8').trim().split('\n'), [
        'backend=true',
        'webui=true',
        'landing=true',
        'host=true',
        'pi=true',
        'ide=true',
        'workflows=true',
      ]);
      assert.equal(readFileSync(join(runnerTemp, 'changed-files.txt'), 'utf8'), 'fixture.txt\n');

      writeFileSync(output, '');
      const missing = spawnSync(join(ROOT, 'scripts', 'ci', 'path-filter-fallback.sh'), [], {
        cwd: repository,
        encoding: 'utf8',
        env: { ...process.env, BASE_SHA: '0'.repeat(40), HEAD_SHA: head, GITHUB_OUTPUT: output, RUNNER_TEMP: runnerTemp },
      });
      assert.notEqual(missing.status, 0);
      assert.equal(readFileSync(output, 'utf8'), '');

      const malformed = spawnSync(join(ROOT, 'scripts', 'ci', 'path-filter-fallback.sh'), [], {
        cwd: repository,
        encoding: 'utf8',
        env: { ...process.env, BASE_SHA: 'not-a-sha', HEAD_SHA: head, GITHUB_OUTPUT: output, RUNNER_TEMP: runnerTemp },
      });
      assert.notEqual(malformed.status, 0);
      assert.equal(readFileSync(output, 'utf8'), '');
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it('preserves every direct and reusable PR Checks entry point', () => {
    assert.deepEqual(prChecks.on.push.branches, ['main']);
    assert.deepEqual(prChecks.on.pull_request.branches, ['main', 'develop']);
    assert.ok(prChecks.on.merge_group !== undefined);
    assert.ok(prChecks.on.workflow_dispatch !== undefined);
    assert.ok(prChecks.on.workflow_call !== undefined);
    assert.equal(prChecks.jobs.summary.name, 'test');
  });
});
