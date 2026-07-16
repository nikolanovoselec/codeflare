import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/bump-shadow-pins.yml'), 'utf8');
const jobsDocument = workflow.slice(workflow.indexOf('\njobs:\n') + '\njobs:\n'.length);
const jobStarts = [...jobsDocument.matchAll(/^  ([a-z0-9-]+):\n/gm)];
const jobs = new Map(jobStarts.map((match, index) => [
  match[1],
  jobsDocument.slice(
    (match.index ?? 0) + match[0].length,
    jobStarts[index + 1]?.index ?? jobsDocument.length,
  ),
]));

function job(name) {
  const block = jobs.get(name);
  assert.ok(block, `missing workflow job: ${name}`);
  return block;
}

describe('REQ-OPS-020: shadow-pin version bump automation', () => {
  it('REQ-OPS-020 AC1: watches every pinned Docker binary through its own release job', () => {
    const contracts = new Map([
      ['zoxide', 'ZOXIDE_VERSION'],
      ['yazi', 'YAZI_VERSION'],
      ['lazygit', 'LAZYGIT_VERSION'],
      ['silverbullet', 'SILVERBULLET_VERSION'],
      ['openvscode-server', 'OPENVSCODE_VERSION'],
    ]);
    for (const [name, versionVariable] of contracts) {
      const block = job(name);
      assert.ok(block.includes('gh api repos/'));
      assert.ok(block.includes(versionVariable));
    }
  });

  it('REQ-OPS-020 AC2: updates context-mode Claude and Pi pins in one generated-seed job', () => {
    const block = job('context-mode');
    assert.ok(block.includes('preseed/agents/claude/'));
    assert.ok(block.includes('preseed/agents/pi/package.json'));
    assert.ok(block.includes('npm run generate:agent-seed'));
  });

  it('REQ-OPS-020 AC3: exposes dedicated jobs for every non-Docker shadow pin', () => {
    for (const name of [
      'graphify', 'bun', 'pi-preseed', 'impeccable', 'consult-llm-mcp',
      'chrome-devtools-mcp', 'browser-run-mcp',
    ]) assert.ok(jobs.has(name), `missing ${name} bump job`);
  });

  it('REQ-OPS-020 AC4: invalidates each Docker checksum before opening its bump PR', () => {
    for (const name of ['zoxide', 'yazi', 'lazygit', 'silverbullet', 'openvscode-server']) {
      assert.ok(job(name).includes('NEEDS_UPDATE_SEE_PR_BODY'), `${name} must invalidate its checksum`);
    }
  });

  it('REQ-OPS-020 AC5: every bump job checks for its version branch before creating a PR', () => {
    for (const [name, block] of jobs) {
      assert.ok(block.includes('git ls-remote --exit-code --heads origin "$BRANCH"'), `${name} lacks branch deduplication`);
    }
  });
});
