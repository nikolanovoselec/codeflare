// A deploy must never ship a commit that PR Checks has not passed.
//
// The workflow_run path gets that for free: it only fires on a green PR Checks
// run for the merge commit. The workflow_dispatch path did not — it built and
// deployed whatever the branch tip was, with no test gate at all, which made
// manual dispatch a silent bypass of every check in this repository.
//
// It is now gated on an inline `verify` job that calls PR Checks as a reusable
// workflow. This test pins that arrangement, because the failure mode of losing
// it is invisible: manual deploys keep working, they just stop being verified.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.github', 'workflows');
const deployYml = readFileSync(join(WORKFLOWS, 'deploy.yml'), 'utf8');
const testYml = readFileSync(join(WORKFLOWS, 'test.yml'), 'utf8');

// Jobs that check out a ref, build, or deploy. Every one of them must be
// unreachable unless the code was verified.
// `outcome` belongs here too. It was added later with a bare `always()`, and
// because this list did not name it, the assertions below — including the one
// that forbids always() — structurally could not see it. A gate list that is
// hand-maintained alongside the thing it guards drifts exactly this way.
const GATED_JOBS = ['prepare', 'build-worker', 'container', 'deploy', 'outcome'];

/** Returns the raw YAML block for a top-level job, comments and all. */
function jobBlock(name) {
  const lines = deployYml.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `deploy.yml has no top-level job "${name}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
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

describe('manual deploys cannot skip tests', () => {
  it('exposes PR Checks as a reusable workflow', () => {
    assert.match(
      testYml,
      /^ {2}workflow_call:/m,
      'test.yml no longer offers workflow_call, so deploy.yml cannot run the checks inline'
    );
  });

  it('runs PR Checks inline on manual dispatch', () => {
    const verify = jobBlock('verify');
    assert.match(
      verify,
      /uses: \.\/\.github\/workflows\/test\.yml/,
      'the verify job must call this repository\'s PR Checks, not a substitute'
    );
    assert.match(
      condition('verify'),
      /github\.event_name == 'workflow_dispatch'/,
      'the verify job must run on manual dispatch'
    );
  });

  for (const name of GATED_JOBS) {
    it(`gates "${name}" on the verify result`, () => {
      const gate = condition(name);
      const needs = jobBlock(name).match(/^ {4}needs: (.*)$/m);
      assert.ok(needs, `job "${name}" declares no needs, so it cannot see the verify result`);
      assert.match(needs[1], /\bverify\b/, `job "${name}" must depend on verify`);

      assert.match(
        gate,
        /needs\.verify\.result == 'success'/,
        `job "${name}" does not require a green verify — manual dispatch would deploy untested code`
      );
      // On workflow_run, verify is skipped by its own if:. Requiring the skip
      // explicitly means a *failed* verify can never be read as "not applicable".
      assert.match(
        gate,
        /needs\.verify\.result == 'skipped'/,
        `job "${name}" must require verify to be skipped on the workflow_run path, not merely absent`
      );
      // A bare event check ORed at the top level re-opens the bypass.
      assert.doesNotMatch(
        gate,
        /github\.event_name == 'workflow_dispatch' \)? *\|\|/,
        `job "${name}" allows workflow_dispatch without any verify condition`
      );
      // always() would run these jobs through a cancellation.
      assert.doesNotMatch(gate, /\balways\(\)/, `job "${name}" uses always(), so cancelling a deploy would not stop it`);

      // Every assertion above is applied identically to all five jobs, so a
      // clause added to one of them is only caught if it is illegal everywhere.
      // `outcome` legitimately accepts a cancelled verify — it is report-only
      // and exists to turn that case red — but the same clause on `deploy`
      // would ship untested code from a dispatch whose verify was cancelled by
      // a second dispatch. Allowlist the value per job rather than per file.
      const allowedResults = name === 'outcome'
        ? new Set(['success', 'skipped', 'cancelled'])
        : new Set(['success', 'skipped']);
      for (const [, value] of gate.matchAll(/needs\.verify\.result == '([a-z]+)'/g)) {
        assert.ok(
          allowedResults.has(value),
          `job "${name}" accepts verify result '${value}', which is not a gate this job may pass on`
        );
      }
    });
  }

  it('deploys the commit that was verified, never a branch name', () => {
    const outputs = jobBlock('prepare');
    const ref = outputs.match(/^ {6}ref: (.*)$/m);
    assert.ok(ref, 'prepare no longer exports a ref output');
    assert.doesNotMatch(
      ref[1],
      /github\.ref\b/,
      'prepare falls back to github.ref, which actions/checkout re-resolves at job start — the deployed commit could differ from the tested one'
    );
    assert.match(ref[1], /github\.sha/, 'the dispatch path must pin the SHA that verify tested');
  });
});
