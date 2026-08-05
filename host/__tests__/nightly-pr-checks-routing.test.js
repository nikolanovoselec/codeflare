import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  it('preserves every direct and reusable PR Checks entry point', () => {
    assert.deepEqual(prChecks.on.push.branches, ['main']);
    assert.deepEqual(prChecks.on.pull_request.branches, ['main', 'develop']);
    assert.ok(prChecks.on.merge_group !== undefined);
    assert.ok(prChecks.on.workflow_dispatch !== undefined);
    assert.ok(prChecks.on.workflow_call !== undefined);
    assert.equal(prChecks.jobs.summary.name, 'test');
  });
});
