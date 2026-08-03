import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
    const step = guard.steps?.[0];

    assert.equal(
      guard.if,
      `github.event_name == 'workflow_dispatch' && !(${defaultBranchExpression})`,
    );
    assert.equal(guard.permissions?.contents, 'read');
    assert.equal(step?.env?.REF_NAME, '${{ github.ref_name }}');
    assert.match(step?.run ?? '', /only supports the default branch/);
    assert.match(step?.run ?? '', /\$REF_NAME/);
    assert.doesNotMatch(step?.run ?? '', /\$\{\{/);
    assert.match(step?.run ?? '', /GITHUB_STEP_SUMMARY/);

    const directory = mkdtempSync(join(tmpdir(), 'scorecard-guard-'));
    const summary = join(directory, 'summary.md');
    const canary = join(directory, 'injected');
    const refName = `develop$(touch ${canary})`;

    try {
      const result = spawnSync('bash', ['-euo', 'pipefail', '-c', step.run], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summary,
          REF_NAME: refName,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(summary, 'utf8').includes(refName), true);
      assert.equal(existsSync(canary), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
