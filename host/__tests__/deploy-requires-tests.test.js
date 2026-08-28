// A deploy must never ship a commit that PR Checks has not passed.
//
// The workflow_run path gets that for free: it only fires on a green PR Checks
// run for the merge commit. The workflow_dispatch path did not — it built and
// deployed whatever the branch tip was, with no test gate at all, which made
// manual dispatch a silent bypass of every check in this repository.
//
// It automatically resolves a validated successful exact-head, exact-tree PR
// Checks run, or falls back to an inline `verify` job that calls PR Checks as a
// reusable workflow. This test pins both paths, because losing either is invisible:
// manual deploys keep working, they just stop being verified.

import { spawnSync } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parse as parseYaml } from 'yaml';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const OUTCOME_GATE = join(ROOT, 'scripts', 'ci', 'assert-deploy-outcome.mjs');
const VAPID_GATE = join(ROOT, 'scripts', 'ci', 'validate-vapid-config.mjs');
const deployYml = readFileSync(join(WORKFLOWS, 'deploy.yml'), 'utf8');
const deployWorkflow = parseYaml(deployYml);
const testYml = readFileSync(join(WORKFLOWS, 'test.yml'), 'utf8');
const testWorkflow = parseYaml(testYml);

// Jobs that check out a ref, build, or deploy. Every one must be unreachable
// unless the code was verified. `verify-existing` resolves reuse and `verify` is its inline fallback, so neither is itself gated.
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

  it('runs PR Checks inline only when automatic exact-tree resolution finds no reusable run', () => {
    const verify = deployWorkflow.jobs.verify;
    assert.equal(verify.uses, './.github/workflows/test.yml');
    assert.equal(verify.needs, 'verify-existing');
    const gate = condition('verify');
    const base = {
      cancelled: false,
      'github.event_name': 'workflow_dispatch',
      'inputs.verified_run_id': '',
      'needs.verify-existing.result': 'success',
      'needs.verify-existing.outputs.verified': 'false',
    };
    for (const [name, values, expectedResult] of [
      ['no reusable run', base, true],
      ['reusable run found', { ...base, 'needs.verify-existing.outputs.verified': 'true' }, false],
      ['explicit override', { ...base, 'inputs.verified_run_id': '123456' }, false],
      ['resolver failed', { ...base, 'needs.verify-existing.result': 'failure' }, false],
      ['resolver output missing', { ...base, 'needs.verify-existing.outputs.verified': '' }, false],
      ['cancelled', { ...base, cancelled: true }, false],
      ['workflow_run', { ...base, 'github.event_name': 'workflow_run' }, false],
    ]) {
      assert.equal(evaluateCondition(gate, values), expectedResult, name);
    }
  });

  it('publishes the actual checked-out tree as a reusable verification receipt', () => {
    const steps = testWorkflow.jobs.summary.steps;
    const receipt = steps.find((step) => step.name === 'Write exact tested-tree receipt');
    const upload = steps.find((step) => step.name === 'Upload exact tested-tree receipt');

    assert.equal(receipt?.if, undefined);
    assert.deepEqual(receipt?.env, {
      REPOSITORY: '${{ github.repository }}',
      RUN_ID: '${{ github.run_id }}',
      RUN_ATTEMPT: '${{ github.run_attempt }}',
    });
    assert.deepEqual(receipt?.run?.split('\n').map((line) => line.trim()).filter(Boolean), [
      'set -euo pipefail',
      'tested_commit=$(git rev-parse HEAD)',
      "tested_tree=$(git rev-parse 'HEAD^{tree}')",
      'jq -n \\',
      '--arg repository "$REPOSITORY" \\',
      '--arg runId "$RUN_ID" \\',
      '--argjson runAttempt "$RUN_ATTEMPT" \\',
      '--arg testedCommit "$tested_commit" \\',
      '--arg testedTree "$tested_tree" \\',
      "'{schema:\"codeflare.pr-checks-receipt.v3\",repository:$repository,workflowPath:\".github/workflows/test.yml\",runId:$runId,runAttempt:$runAttempt,testedCommit:$testedCommit,testedTree:$testedTree}' \\",
      '> /tmp/pr-checks-receipt.json',
    ]);
    assert.deepEqual(upload, {
      name: 'Upload exact tested-tree receipt',
      uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      with: {
        name: 'pr-checks-receipt-${{ github.run_id }}',
        path: '/tmp/pr-checks-receipt.json',
        'retention-days': 7,
        'if-no-files-found': 'error',
      },
    });
  });

  it('automatically resolves an exact-tree PR Checks run before every manual deploy', () => {
    const resolver = deployWorkflow.jobs['verify-existing'];
    assert.equal(resolver.permissions.actions, 'read');
    assert.equal(resolver.outputs.verified, '${{ steps.resolve.outputs.verified }}');
    const gate = condition('verify-existing');
    assert.equal(evaluateCondition(gate, { cancelled: false, 'github.event_name': 'workflow_dispatch' }), true);
    assert.equal(evaluateCondition(gate, { cancelled: false, 'github.event_name': 'workflow_run' }), false);
    const resolveStep = resolver.steps.find((step) => step.id === 'resolve');
    assert.match(resolveStep?.run ?? '', /node scripts\/ci\/validate-pr-checks-run\.mjs resolve/);
  });

  const successfulPrerequisites = {
    cancelled: false,
    'inputs.verified_run_id': '',
    'needs.prepare.result': 'success',
    'needs.build-worker.result': 'success',
    'needs.container.result': 'success',
  };
  const reusableDispatch = {
    ...successfulPrerequisites,
    'github.event_name': 'workflow_dispatch',
    'needs.verify.result': 'skipped',
    'needs.verify-existing.result': 'success',
    'needs.verify-existing.outputs.verified': 'true',
    'github.event.workflow_run.conclusion': '',
    'github.event.workflow_run.event': '',
    'github.event.workflow_run.head_repository.full_name': '',
    'github.repository': 'nikolanovoselec/codeflare',
  };
  const inlineDispatch = {
    ...reusableDispatch,
    'needs.verify.result': 'success',
    'needs.verify-existing.outputs.verified': 'false',
  };
  const successfulWorkflowRun = {
    ...reusableDispatch,
    'github.event_name': 'workflow_run',
    'needs.verify-existing.result': 'skipped',
    'github.event.workflow_run.conclusion': 'success',
    'github.event.workflow_run.event': 'push',
    'github.event.workflow_run.head_repository.full_name': 'nikolanovoselec/codeflare',
  };
  const prerequisiteResults = {
    'build-worker': ['needs.prepare.result'],
    container: ['needs.prepare.result'],
    deploy: ['needs.prepare.result', 'needs.build-worker.result', 'needs.container.result'],
  };

  for (const name of GATED_JOBS) {
    it(`behaviorally gates "${name}" on an authoritative verification path`, () => {
      const gate = condition(name);
      const declaredNeeds = deployWorkflow.jobs[name].needs;
      const needs = Array.isArray(declaredNeeds) ? declaredNeeds : [declaredNeeds];
      assert.ok(needs.includes('verify'), `job "${name}" must depend on verify`);
      assert.ok(needs.includes('verify-existing'), `job "${name}" must depend on exact-head run validation`);

      for (const [scenario, values, expectedResult] of [
        ['validated reusable run', reusableDispatch, true],
        ['validated explicit run', { ...reusableDispatch, 'inputs.verified_run_id': '123456' }, true],
        ['successful inline verification', inlineDispatch, true],
        ['resolver failure', { ...reusableDispatch, 'needs.verify-existing.result': 'failure' }, false],
        ['missing resolver output', { ...reusableDispatch, 'needs.verify-existing.outputs.verified': '' }, false],
        ['failed inline verification', { ...inlineDispatch, 'needs.verify.result': 'failure' }, false],
        ['workflow cancelled', { ...reusableDispatch, cancelled: true }, false],
        ['green same-repository push workflow_run', successfulWorkflowRun, true],
        ['red workflow_run', { ...successfulWorkflowRun, 'github.event.workflow_run.conclusion': 'failure' }, false],
        ['fork workflow_run', { ...successfulWorkflowRun, 'github.event.workflow_run.head_repository.full_name': 'attacker/fork' }, false],
      ]) {
        assert.equal(evaluateCondition(gate, values), expectedResult, `${name}: ${scenario}`);
      }

      for (const prerequisite of prerequisiteResults[name] ?? []) {
        const values = { ...reusableDispatch, [prerequisite]: 'failure' };
        assert.equal(evaluateCondition(gate, values), false, `${name}: failed ${prerequisite}`);
      }
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
      'inputs.verified_run_id': '',
      'needs.prepare.result': 'success',
      'needs.build-worker.result': 'success',
      'needs.container.result': 'success',
    };
    const fixtures = [
      ['automatic run reuse', { ...base, 'needs.verify.result': 'skipped', 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'true' }, true],
      ['explicit run reuse', { ...base, 'inputs.verified_run_id': '123456', 'needs.verify.result': 'skipped', 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'true' }, true],
      ['inline fallback', { ...base, 'needs.verify.result': 'success', 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'false' }, true],
      ['explicit override cannot fall back', { ...base, 'inputs.verified_run_id': '123456', 'needs.verify.result': 'success', 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'false' }, false],
      ['both manual paths', { ...base, 'needs.verify.result': 'success', 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'true' }, false],
      ['missing resolver output', { ...base, 'needs.verify.result': 'skipped', 'needs.verify-existing.result': 'success' }, false],
      ['no verification', base, false],
      ['failed inline checks', { ...base, 'needs.verify.result': 'failure', 'needs.verify-existing.result': 'success', 'needs.verify-existing.outputs.verified': 'false' }, false],
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

describe('REQ-OPS-013 AC6-AC7: notification deployment configuration', () => {
  function keyPair() {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
      publicKey: ecdh.getPublicKey().toString('base64url'),
      privateKey: ecdh.getPrivateKey().toString('base64url'),
    };
  }

  function validate(env) {
    assert.ok(existsSync(VAPID_GATE), 'notification configuration validator is missing');
    return spawnSync(process.execPath, [VAPID_GATE], {
      encoding: 'utf8',
      env,
    });
  }

  it('allows notifications to be omitted and validates a configured matching P-256 keypair before Worker promotion', () => {
    const disabled = validate({});
    assert.equal(disabled.status, 0, disabled.stderr);

    const pair = keyPair();
    const valid = validate({
      VAPID_SUBJECT: 'mailto:ops@codeflare.example',
      VAPID_PUBLIC_KEY: pair.publicKey,
      VAPID_PRIVATE_KEY: pair.privateKey,
    });
    assert.equal(valid.status, 0, valid.stderr);

    const steps = deployWorkflow.jobs.deploy.steps;
    const validation = steps.findIndex((step) => step.name === 'Validate notification deployment configuration');
    const promotion = steps.findIndex((step) => step.name === 'Deploy to Cloudflare');
    assert.ok(validation >= 0, 'deploy job does not run the VAPID validator');
    assert.equal(
      steps[validation].run.trim(),
      'node scripts/ci/validate-vapid-config.mjs',
      'the validation step must invoke only the behaviorally tested gate',
    );
    assert.equal(steps[validation]['continue-on-error'], undefined,
      'VAPID validation must fail the deploy job closed');
    assert.ok(promotion > validation, 'VAPID validation must run before Worker promotion in the deploy job');
  });

  it('sources every VAPID field from Actions secret context so step metadata stays masked', () => {
    const expectedByStep = new Map([
      ['Validate notification deployment configuration', {
        VAPID_SUBJECT: '${{ secrets.VAPID_SUBJECT }}',
        VAPID_PUBLIC_KEY: '${{ secrets.VAPID_PUBLIC_KEY }}',
        VAPID_PRIVATE_KEY: '${{ secrets.VAPID_PRIVATE_KEY }}',
      }],
      ['Deploy to Cloudflare', {
        VAR_VAPID_SUBJECT: '${{ secrets.VAPID_SUBJECT }}',
      }],
      ['Set worker secrets (bulk)', {
        VAPID_PUBLIC_KEY: '${{ secrets.VAPID_PUBLIC_KEY }}',
        VAPID_PRIVATE_KEY: '${{ secrets.VAPID_PRIVATE_KEY }}',
      }],
    ]);

    for (const [stepName, expectedEnv] of expectedByStep) {
      const step = deployWorkflow.jobs.deploy.steps.find((candidate) => candidate.name === stepName);
      assert.ok(step, `deploy job is missing the ${stepName} step`);
      for (const [name, expression] of Object.entries(expectedEnv)) {
        assert.equal(step.env?.[name], expression, `${stepName} must source ${name} from Actions secret context`);
      }
    }
  });

  it('rejects partial, whitespace, malformed, and mismatched configuration without printing key values', () => {
    const pair = keyPair();
    const other = keyPair();
    const invalid = [
      ['partial configuration', { VAPID_PRIVATE_KEY: '' }],
      ['whitespace subject', { VAPID_SUBJECT: '   ' }],
      ['surrounding whitespace', { VAPID_SUBJECT: ' mailto:ops@codeflare.example' }],
      ['bad subject scheme', { VAPID_SUBJECT: 'ftp://codeflare.example' }],
      ['malformed public key', { VAPID_PUBLIC_KEY: 'PUBLIC_KEY_SENTINEL' }],
      ['malformed private key', { VAPID_PRIVATE_KEY: 'PRIVATE_KEY_SENTINEL' }],
      ['mismatched keypair', { VAPID_PRIVATE_KEY: other.privateKey }],
    ];

    for (const [name, overrides] of invalid) {
      const env = {
        VAPID_SUBJECT: 'https://codeflare.example',
        VAPID_PUBLIC_KEY: pair.publicKey,
        VAPID_PRIVATE_KEY: pair.privateKey,
        ...overrides,
      };
      const result = validate(env);
      assert.notEqual(result.status, 0, name);
      const output = `${result.stdout}${result.stderr}`;
      if (env.VAPID_PUBLIC_KEY) {
        assert.ok(!output.includes(env.VAPID_PUBLIC_KEY), `${name}: public key value leaked`);
      }
      if (env.VAPID_PRIVATE_KEY) {
        assert.ok(!output.includes(env.VAPID_PRIVATE_KEY), `${name}: private key value leaked`);
      }
    }
  });
});
