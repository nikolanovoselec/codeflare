// Guards the required status context in .github/workflows/test.yml.
//
// `summary` (check name "test") is the ONE required branch-protection context.
// It decides merges by inspecting `needs` — so a lane that is not listed there
// is invisible to the gate: it can fail while the merge button stays green.
// Nothing in GitHub Actions enforces that coupling, and the failure is silent
// in the worst way: adding a lane feels like adding coverage.
//
// This also pins the two rules the aggregate itself depends on: it must run
// with `if: always()` (otherwise a skipped dependency skips the aggregate and
// the required check never reports, blocking merges forever), and it must fail
// on cancelled as well as failed lanes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(__dirname, '../../.github/workflows/test.yml'), 'utf8');

/** Top-level job ids: two-space indented `key:` inside the `jobs:` block. */
// Job ids admit underscores; a `[a-z][a-z0-9-]*` pattern silently DROPS one,
// so a lane renamed to `workflow_audit` would vanish from this check and could
// then be missing from summary.needs while the merge button stayed green -
// exactly the hole this file exists to close. The sibling guard in
// deploy-requires-tests.test.js uses a literal job list for the same reason.
function jobIds() {
  const jobs = workflow.slice(workflow.indexOf('\njobs:'));
  return [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]);
}

/** The `needs:` list of the summary job. */
function summaryNeeds() {
  const start = workflow.indexOf('\n  summary:');
  assert.ok(start > 0, 'test.yml must declare a `summary` job');
  const block = workflow.slice(start);
  const needs = block.match(/\n {4}needs:\n((?: {6}- [A-Za-z0-9_-]+\n)+)/);
  assert.ok(needs, 'the summary job must declare a `needs:` list');
  return [...needs[1].matchAll(/- ([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
}

describe('required status context covers every lane (test.yml summary job)', () => {
  it('REQ-OPS-003 AC6: declares and routes the required Browser IDE lane', () => {
    const lanes = jobIds();
    assert.ok(lanes.includes('browser-ide'), 'test.yml must declare a browser-ide job');
    assert.match(workflow, /\n {6}ide: \$\{\{ steps\.filter\.outputs\.ide \}\}/, 'changes must expose the ide filter');
    assert.match(workflow, /- 'openvscode\/\*\*'/, 'the ide filter must route openvscode/** changes');
    assert.ok(summaryNeeds().includes('browser-ide'), 'browser-ide must reach the required test status');
  });

  it('lists every job except itself in needs, so no lane escapes the merge gate', () => {
    const lanes = jobIds().filter((id) => id !== 'summary');
    const needs = summaryNeeds();
    assert.ok(lanes.length > 1, `expected several lanes, parsed ${JSON.stringify(lanes)}`);

    const uncovered = lanes.filter((l) => !needs.includes(l));
    assert.deepEqual(
      uncovered,
      [],
      `these jobs are not in summary.needs, so they cannot fail the required "test" check: ` +
        `${JSON.stringify(uncovered)}. Add them to needs, or the gate silently ignores them.`,
    );
  });

  it('does not name a lane in needs that no longer exists', () => {
    const lanes = jobIds();
    const stale = summaryNeeds().filter((n) => !lanes.includes(n));
    assert.deepEqual(stale, [], `summary.needs references non-existent jobs: ${JSON.stringify(stale)}`);
  });

  it('runs with always() so a skipped lane still lets the required check report', () => {
    const block = workflow.slice(workflow.indexOf('\n  summary:'));
    const guard = block.slice(0, block.indexOf('\n    steps:'));
    assert.match(
      guard,
      /\n {4}if: always\(\)/,
      'summary must use `if: always()`; without it a skipped dependency skips the aggregate ' +
        'and the required context never reports, which blocks every merge',
    );
  });

  it('treats cancelled lanes as failures, not as passes', () => {
    const block = workflow.slice(workflow.indexOf('\n  summary:'));
    assert.match(
      block,
      /result == "cancelled"/,
      'the aggregate must fail on cancelled lanes; a cancelled lane ran no assertions',
    );
  });
});
