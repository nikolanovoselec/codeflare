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
