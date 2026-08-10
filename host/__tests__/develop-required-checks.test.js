import assert from 'node:assert/strict';
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

    const audit = prChecks.jobs['workflow-audit'];
    assert.match(audit.if, /needs\.changes\.outputs\.workflows == 'true'/);
    assert.ok(audit.steps.some((candidate) => candidate.name?.startsWith('Run zizmor')));

    const requiredCheck = prChecks.jobs.summary;
    assert.equal(requiredCheck.name, 'test');
    assert.ok(requiredCheck.needs.includes('workflow-audit'));
    const aggregate = requiredCheck.steps.find((candidate) => candidate.name === 'Aggregate lane results');
    assert.equal(aggregate.env.RESULTS, '${{ toJSON(needs) }}');
    assert.match(aggregate.run, /result == "failure"/);
  });
});
