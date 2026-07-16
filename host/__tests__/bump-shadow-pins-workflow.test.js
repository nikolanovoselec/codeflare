import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  executableLines,
  parseGitHubWorkflow,
} from '../../scripts/lib/github-workflow-contract.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = parseGitHubWorkflow(
  readFileSync(resolve(repoRoot, '.github/workflows/bump-shadow-pins.yml'), 'utf8'),
);

function job(name) {
  const value = workflow.jobs.get(name);
  assert.ok(value, `missing workflow job: ${name}`);
  return value;
}

function step(jobName, selector) {
  const value = job(jobName).steps.find(selector);
  assert.ok(value, `missing workflow step in ${jobName}`);
  return value;
}

function runLines(jobName, selector) {
  const run = step(jobName, selector).run;
  assert.equal(typeof run, 'string', `${jobName} step must execute a run block`);
  return executableLines(run);
}

describe('GitHub workflow structural parser', () => {
  it('rejects malformed step placement and excludes commented commands', () => {
    const valid = parseGitHubWorkflow(`name: fixture\njobs:\n  demo:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Execute\n        run: |\n          # gh api repos/commented/example\n          gh api repos/live/example\n`);

    assert.deepEqual(
      executableLines(valid.jobs.get('demo').steps[0].run),
      ['gh api repos/live/example'],
    );
    assert.throws(() => parseGitHubWorkflow(`jobs:\n  demo:\n    runs-on: ubuntu-latest\n    run: echo misplaced\n`), /steps|unsupported/);
  });
});

describe('REQ-OPS-020: shadow-pin version bump automation', () => {
  it('REQ-OPS-020 AC1: executes one release lookup for every pinned Docker binary', () => {
    const contracts = new Map([
      ['zoxide', 'ZOXIDE_VERSION'],
      ['yazi', 'YAZI_VERSION'],
      ['lazygit', 'LAZYGIT_VERSION'],
      ['silverbullet', 'SILVERBULLET_VERSION'],
      ['openvscode-server', 'OPENVSCODE_VERSION'],
    ]);

    for (const [name, versionVariable] of contracts) {
      const lines = runLines(name, (candidate) => candidate.id === 'ver');
      assert.ok(lines.some((line) => /^TAG=\$\(gh api repos\/.+\/releases\//.test(line)), `${name} lacks an executable release lookup`);
      assert.ok(lines.some((line) => line.startsWith(`CURRENT=$(grep -oP '${versionVariable}=`)), `${name} lacks an executable current-pin read`);
    }
  });

  it('REQ-OPS-020 AC2: updates context-mode Claude and Pi pins in one generated-seed step', () => {
    const lines = runLines('context-mode', (candidate) => candidate.name === 'Apply bump');
    assert.ok(lines.some((line) => line.includes("'preseed/agents/claude/plugins/context-mode/")));
    assert.ok(lines.some((line) => line.includes("'preseed/agents/pi/package.json'")));
    assert.ok(lines.includes('npm run generate:agent-seed'));
  });

  it('REQ-OPS-020 AC3: exposes executable jobs for every non-Docker shadow pin', () => {
    for (const name of [
      'graphify', 'bun', 'pi-preseed', 'impeccable', 'consult-llm-mcp',
      'chrome-devtools-mcp', 'browser-run-mcp',
    ]) {
      const value = job(name);
      assert.equal(value.runsOn, 'ubuntu-latest');
      assert.ok(value.steps.some((candidate) => typeof candidate.run === 'string'));
    }
  });

  it('REQ-OPS-020 AC4: invalidates each Docker checksum in its executable bump step', () => {
    for (const name of ['zoxide', 'yazi', 'lazygit', 'silverbullet', 'openvscode-server']) {
      const lines = runLines(name, (candidate) => candidate.name === 'Apply bump');
      assert.ok(lines.some((line) => line.includes('_SHA256=') && line.includes('NEEDS_UPDATE_SEE_PR_BODY')), `${name} must invalidate its checksum`);
    }
  });

  it('REQ-OPS-020 AC5: every bump job executes branch deduplication before creating a PR', () => {
    for (const [name, value] of workflow.jobs) {
      const branch = value.steps.find((candidate) => candidate.id === 'branch');
      assert.ok(branch, `${name} lacks a branch deduplication step`);
      assert.ok(
        executableLines(branch.run).some((line) => /^if git ls-remote --exit-code --heads origin "\$BRANCH"/.test(line)),
        `${name} lacks executable branch deduplication`,
      );
    }
  });
});
