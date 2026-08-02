import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflow = parseYaml(
  readFileSync(resolve(__dirname, '../../.github/workflows/scorecard.yml'), 'utf8'),
);

const defaultBranchExpression =
  "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";

describe('REQ-OPS-009: Scorecard default-branch dispatch routing', () => {
  it('runs the scanner only when a manual dispatch targets the default branch', () => {
    const condition = workflow.jobs.scorecard.if;

    assert.equal(
      condition,
      `github.event_name != 'workflow_dispatch' || ${defaultBranchExpression}`,
    );
  });

  it('turns a non-default manual dispatch into an explicit successful no-op', () => {
    const guard = workflow.jobs['unsupported-ref'];

    assert.equal(
      guard.if,
      `github.event_name == 'workflow_dispatch' && !(${defaultBranchExpression})`,
    );
    assert.equal(guard.permissions?.contents, 'read');
    assert.equal(guard.steps?.[0]?.env?.REF_NAME, '${{ github.ref_name }}');
    assert.match(guard.steps?.[0]?.run ?? '', /only supports the default branch/);
    assert.match(guard.steps?.[0]?.run ?? '', /\$REF_NAME/);
    assert.doesNotMatch(guard.steps?.[0]?.run ?? '', /\$\{\{/);
    assert.match(guard.steps?.[0]?.run ?? '', /GITHUB_STEP_SUMMARY/);
  });
});
