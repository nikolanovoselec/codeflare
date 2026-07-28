// A deploy must never ship a commit that PR Checks has not passed.
//
// The workflow_run path gets that for free: it only fires on a green PR Checks
// run for the merge commit. The workflow_dispatch path did not — it built and
// deployed whatever the branch tip was, with no test gate at all, which made
// manual dispatch a silent bypass of every check in this repository.
//
// It is gated either by a validated successful exact-head PR Checks run or by
// an inline `verify` job that calls PR Checks as a reusable workflow. This test
// pins both paths, because the failure mode of losing either gate is invisible:
// manual deploys keep working, they just stop being verified.

import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parse as parseYaml } from 'yaml';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const OUTCOME_GATE = join(ROOT, 'scripts', 'ci', 'assert-deploy-outcome.mjs');
const deployYml = readFileSync(join(WORKFLOWS, 'deploy.yml'), 'utf8');
const deployWorkflow = parseYaml(deployYml);
const testYml = readFileSync(join(WORKFLOWS, 'test.yml'), 'utf8');

// Jobs that check out a ref, build, or deploy. Every one must be unreachable
// unless the code was verified. `verify` and `verify-existing` are excluded because they ARE the mutually exclusive gates.
const GATED_JOBS = ['prepare', 'build-worker', 'container', 'deploy', 'outcome'];

/** Returns the raw YAML block for a top-level job. */
function jobBlock(name) {
  const lines = deployYml.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `deploy.yml has no top-level job "${name}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line));
  return rest.slice(0, end === -1 ? undefined : end).join('\n');
}

/** The `if:` expression of a job, with comment lines stripped. */
function condition(name) {
  const block = jobBlock(name);
  const match = block.match(/^ {4}if: >-\n((?: {6}.*\n)+)/m) ?? block.match(/^ {4}if: (.*)$/m);
  assert.ok(match, `job "${name}" has no if: gate at all`);
  return match[1]
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evaluateCondition(expression, values) {
  let resolved = expression.replaceAll('cancelled()', JSON.stringify(values.cancelled));
  for (const reference of Object.keys(values).filter((key) => key !== 'cancelled').sort((a, b) => b.length - a.length)) {
    resolved = resolved.replaceAll(reference, JSON.stringify(values[reference]));
  }
  assert.doesNotMatch(resolved, /\b(?:github|needs|inputs)\./, `unresolved workflow reference in: ${resolved}`);
  return Boolean(runInNewContext(resolved, Object.create(null), { timeout: 100 }));
}

describe('manual deploys cannot skip tests', () => {
  it('exposes PR Checks as a reusable workflow', () => {
    assert.match(
      testYml,
      /^ {2}workflow_call:/m,
      'test.yml no longer offers workflow_call, so deploy.yml cannot run the checks inline'
    );
  });

  it('runs PR Checks inline on manual dispatch', () => {
    assert.match(
      jobBlock('verify'),
      /uses: \.\/\.github\/workflows\/test\.yml/,
      "the verify job must call this repository's PR Checks, not a substitute"
    );
    const gate = condition('verify');
    assert.match(gate, /github\.event_name == 'workflow_dispatch'/, 'the verify job must run on manual dispatch');
    assert.match(gate, /inputs\.verified_run_id == ''/, 'inline verification must be the fallback when no run id is supplied');
  });

  it('publishes the actual checked-out tree as a reusable verification receipt', () => {
    assert.match(testYml, /git rev-parse 'HEAD\^\{tree\}'/, 'the receipt must identify the tested tree, not only event metadata');
    assert.match(testYml, /pr-checks-receipt-\$\{\{ github\.run_id \}\}/, 'the receipt artifact must be bound to its run id');
  });

  it('validates an existing PR Checks run before reusing it', () => {
    const block = jobBlock('verify-existing');
    assert.match(block, /actions: read/, 'exact-head run validation needs read-only Actions API access');
    assert.match(block, /inputs\.verified_run_id != ''/, 'run reuse must be opt-in with an explicit run id');
    assert.match(block, /validate-pr-checks-run\.mjs/, 'the workflow must validate the run rather than trust the input');
  });

  for (const name of GATED_JOBS) {
    it(`gates "${name}" on the verify result`, () => {
      const gate = condition(name);
      const needs = jobBlock(name).match(/^ {4}needs: (.*)$/m);
      assert.ok(needs, `job "${name}" declares no needs, so it cannot see the verify result`);
      assert.match(needs[1], /\bverify\b/, `job "${name}" must depend on verify`);
      assert.match(needs[1], /\bverify-existing\b/, `job "${name}" must depend on exact-head run validation`);

      assert.match(
        gate,
        /needs\.verify\.result == 'success'/,
        `job "${name}" does not accept a green inline verify`
      );
      assert.match(
        gate,
        /needs\.verify-existing\.result == 'success'/,
        `job "${name}" does not require successful existing-run validation`
      );
      assert.match(
        gate,
        /needs\.verify-existing\.outputs\.verified == 'true'/,
        `job "${name}" trusts a supplied run id without a positive validator output`
      );
      // On workflow_run, verify is skipped by its own if:. Requiring the skip
      // explicitly means a *failed* verify can never be read as "not applicable".
      assert.match(
        gate,
        /needs\.verify\.result == 'skipped'/,
        `job "${name}" must require verify to be skipped when another verification path is authoritative`
      );
      assert.match(
        gate,
        /needs\.verify-existing\.result == 'skipped'/,
        `job "${name}" must require existing-run validation to be skipped when it is not authoritative`
      );
      // always() would run these jobs through a cancellation.
      assert.doesNotMatch(gate, /\balways\(\)/, `job "${name}" uses always(), so cancelling a deploy would not stop it`);
    });
  }

  // Every dispatch rendered as the same "Deploy" row in the Actions list, so the
  // only way to tell a production deploy from an integration one was to open it.
  it('names each run after the environment it resolved', () => {
    const runName = deployYml.match(/^run-name: (.*)$/m);
    assert.ok(runName, 'deploy.yml declares no run-name, so every dispatch looks identical in the run list');
    assert.match(
      runName[1],
      /inputs\.environment/,
      'the run title must resolve the dispatched environment, not a constant'
    );

    // The title is what a reader trusts without opening the run, so it must
    // resolve the environment exactly as the concurrency group does — the two
    // expressions are duplicated only because run-name cannot read job outputs.
    const group = deployYml.match(/^ {2}group: deploy-(.*)$/m);
    assert.ok(group, 'deploy.yml declares no concurrency group');
    assert.ok(
      runName[1].includes(group[1]),
      'the run title and the concurrency group must resolve the environment identically'
    );

    // prepare.env_name is what actually deploys. It cannot be compared to the
    // two above by equality — it omits their leading workflow_run clause — but
    // the dispatch options must match, or the title names one environment while
    // another ships. Derived from env_name so it cannot go stale.
    const envName = jobBlock('prepare').match(/^ {6}env_name: (.*)$/m);
    assert.ok(envName, 'prepare no longer exports env_name');
    const dispatchOptions = envName[1].match(/\(inputs\.environment == 'enterprise'.*'integration'/);
    assert.ok(dispatchOptions, 'env_name no longer resolves the dispatchable environments');
    assert.ok(
      runName[1].includes(dispatchOptions[0]),
      'the run title must resolve the same environments as the target that deploys'
    );
  });

  // A called workflow inherits the CALLER's concurrency context, so two deploy
  // dispatches ran their inline verify in the same group and the second cancelled
  // the first. The cancelled deploy then failed its own gate — a green commit
  // reading as unverified purely because someone dispatched a second environment.
  it('gives each dispatch its own verify concurrency group', () => {
    const key = jobBlock('verify').match(/^ {6}concurrency_key: (.*)$/m);
    assert.ok(key, 'the verify job passes no concurrency_key, so concurrent dispatches share a group');
    assert.match(
      key[1],
      /github\.run_id/,
      'the concurrency_key must be per-run; anything coarser lets one dispatch cancel another'
    );

    // Anchor on the concurrency block, not on indentation alone — another
    // top-level mapping could grow its own `group:` key.
    const concurrency = testYml.slice(testYml.indexOf('\nconcurrency:'));
    const group = concurrency.match(/^ {2}group: (.*)$/m);
    assert.ok(group, 'test.yml declares no concurrency group');
    assert.match(
      group[1],
      /inputs\.concurrency_key/,
      'test.yml ignores the caller-supplied key, so passing it from deploy.yml has no effect'
    );
  });

  it('deploys the commit that was verified, never a branch name', () => {
    const ref = jobBlock('prepare').match(/^ {6}ref: (.*)$/m);
    assert.ok(ref, 'prepare no longer exports a ref output');
    assert.doesNotMatch(
      ref[1],
      /github\.ref\b/,
      'prepare falls back to github.ref, which actions/checkout re-resolves at job start — the deployed commit could differ from the tested one'
    );
    assert.match(ref[1], /github\.sha/, 'the dispatch path must pin the SHA that verify tested');
  });

  it('allows exactly one authoritative verification path to reach deploy', () => {
    const gate = condition('deploy');
    const base = {
      cancelled: false,
      'github.event_name': 'workflow_dispatch',
      'github.event.workflow_run.conclusion': '',
      'github.event.workflow_run.event': '',
      'github.event.workflow_run.head_repository.full_name': '',
      'github.repository': 'owner/repo',
      'needs.verify.result': 'skipped',
      'needs.verify-existing.result': 'skipped',
      'needs.verify-existing.outputs.verified': '',
      'needs.prepare.result': 'success',
      'needs.build-worker.result': 'success',
      'needs.container.result': 'success',
    };
    const fixtures = [
      ['inline checks', { ...base, 'needs.verify.result': 'success' }, true],
      ['validated run', { ...base, 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'true' }, true],
      ['both manual paths', { ...base, 'needs.verify.result': 'success', 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'true' }, false],
      ['no verification', base, false],
      ['failed inline checks', { ...base, 'needs.verify.result': 'failure' }, false],
      ['invalid reused run', { ...base, 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'false' }, false],
      ['cancelled verification', { ...base, cancelled: true, 'needs.verify.result': 'cancelled' }, false],
      ['green workflow run', {
        ...base,
        'github.event_name': 'workflow_run',
        'github.event.workflow_run.conclusion': 'success',
        'github.event.workflow_run.event': 'push',
        'github.event.workflow_run.head_repository.full_name': 'owner/repo',
      }, true],
      ['failed workflow run', {
        ...base,
        'github.event_name': 'workflow_run',
        'github.event.workflow_run.conclusion': 'failure',
        'github.event.workflow_run.event': 'push',
        'github.event.workflow_run.head_repository.full_name': 'owner/repo',
      }, false],
    ];

    for (const [name, values, expected] of fixtures) {
      assert.equal(evaluateCondition(gate, values), expected, name);
    }
  });

  it('fails the outcome when no deployment occurred', () => {
    const steps = deployWorkflow.jobs.outcome.steps;
    const kernelIndex = steps.findIndex((step) => step.run?.includes('node scripts/ci/assert-deploy-outcome.mjs "$DEPLOY"'));
    assert.ok(kernelIndex > 0, 'the outcome job must execute the behaviorally tested decision kernel after setup');
    const checkout = steps[kernelIndex - 1];
    assert.equal(checkout.uses, 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    assert.equal(checkout.with?.['persist-credentials'], false);
    for (const [result, expected] of [['success', 0], ['skipped', 1], ['failure', 1], ['cancelled', 1]]) {
      const outcome = spawnSync(process.execPath, [OUTCOME_GATE, result], { encoding: 'utf8' });
      assert.equal(outcome.status, expected, result);
    }
  });
});
