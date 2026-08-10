import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readWorkflow = (name) =>
  parseYaml(
    readFileSync(resolve(__dirname, `../../.github/workflows/${name}`), 'utf8'),
  );

describe('REQ-OPS-018/019: protected branch required-check triggers', () => {
  for (const [file, job, requiredContext] of [
    ['codeql.yml', 'analyze', 'CodeQL'],
    ['fuzz.yml', 'fuzz', 'Property-based fuzzing'],
  ]) {
    it(`${requiredContext} runs for pull requests to both protected branches`, () => {
      const workflow = readWorkflow(file);

      assert.deepEqual(workflow.on.pull_request.branches, ['main', 'develop']);
      assert.equal(workflow.jobs[job].name, requiredContext === 'CodeQL' ? 'Analyze' : requiredContext);
    });
  }
});

describe('REQ-OPS-021: workflow-file static analysis', () => {
  it('REQ-OPS-021 AC1: audits workflow changes on pull requests and main pushes and gates merges through workflow-audit', () => {
    const zizmor = readWorkflow('zizmor.yml');
    const prChecks = readWorkflow('test.yml');
    const workflowPaths = [
      '.github/workflows/**',
      '.github/actions/**',
      '.github/workflow-tool-pins.json',
      'scripts/ci/workflow-tool-pins.mjs',
    ];

    assert.deepEqual(zizmor.on.pull_request, { paths: workflowPaths });
    assert.deepEqual(zizmor.on.push, { branches: ['main'], paths: workflowPaths });
    assert.deepEqual(prChecks.on.pull_request.branches, ['main', 'develop']);

    const sarifAudit = zizmor.jobs.zizmor.steps.find((candidate) =>
      candidate.uses?.startsWith('zizmorcore/zizmor-action@'),
    );
    assert.deepEqual(
      { uses: sarifAudit?.uses, with: sarifAudit?.with },
      {
        uses: 'zizmorcore/zizmor-action@6fc4b006235f201fdab3722e17240ab420d580e5',
        with: {
          'online-audits': false,
          version: '${{ steps.zizmor-pin.outputs.version }}',
        },
      },
    );

    const audit = prChecks.jobs['workflow-audit'];
    assert.equal(
      audit.if,
      "needs.changes.outputs.full == 'true' || needs.changes.outputs.workflows == 'true'",
    );
    const pin = audit.steps.find((candidate) => candidate.id === 'zizmor-pin');
    assert.equal(
      pin?.run,
      'node scripts/ci/workflow-tool-pins.mjs github-output zizmor >> "$GITHUB_OUTPUT"',
    );
    const blockingAudit = audit.steps.find(
      (candidate) => candidate.env?.ZIZMOR_VERSION === '${{ steps.zizmor-pin.outputs.version }}',
    );
    assert.deepEqual(blockingAudit?.env, {
      ZIZMOR_VERSION: '${{ steps.zizmor-pin.outputs.version }}',
      ZIZMOR_SHA256: '${{ steps.zizmor-pin.outputs.sha256 }}',
      GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    });
    assert.equal(
      blockingAudit?.run.trimEnd().split('\n').at(-1).trim(),
      '/tmp/zizmor --no-online-audits --format plain .github/',
    );

    const requiredCheck = prChecks.jobs.summary;
    assert.equal(requiredCheck.name, 'test');
    assert.ok(requiredCheck.needs.includes('workflow-audit'));
    const aggregate = requiredCheck.steps.find(
      (candidate) => candidate.env?.RESULTS === '${{ toJSON(needs) }}',
    );
    assert.equal(aggregate?.env.FULL, '${{ needs.changes.outputs.full }}');
    assert.equal(typeof aggregate?.run, 'string');
    const failedAudit = spawnSync('bash', ['-c', aggregate.run], {
      encoding: 'utf8',
      env: {
        ...process.env,
        FULL: 'false',
        RESULTS: JSON.stringify({
          changes: { result: 'success' },
          'workflow-audit': { result: 'failure' },
        }),
      },
    });
    assert.equal(failedAudit.status, 1, failedAudit.stderr || failedAudit.stdout);
    assert.equal(
      failedAudit.stdout.trim().split('\n').at(-1),
      '::error::Failed lanes: workflow-audit',
    );
  });
});
