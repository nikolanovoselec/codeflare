import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { parse } from 'yaml';

const workflows = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

it('REQ-OPS-050: workflow scheduling defaults pin Ubuntu 24.04 while retaining explicit runner overrides', () => {
  // Runner labels are the GitHub scheduling wire contract, not implementation snapshots.
  for (const file of readdirSync(workflows).filter(name => /\.ya?ml$/.test(name))) {
    const workflow = parse(readFileSync(workflows + file, 'utf8'));
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      let selector = job['runs-on'] ?? job.with?.runner;
      if (selector === undefined) continue; // Reusable jobs schedule in the called workflow.
      if (selector === '${{ inputs.runner }}') selector = workflow.on.workflow_call.inputs.runner.default;
      if (typeof selector !== 'string' || !selector.includes('ubuntu')) continue;
      assert.ok(selector === 'ubuntu-24.04' || selector === "${{ vars.RUNNER || 'ubuntu-24.04' }}",
        `${file}/${id}: default Ubuntu scheduling must stay on 24.04, received ${selector}`);
    }
  }
});
