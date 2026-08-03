import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { readWorkflowToolPin, updateWorkflowToolPin } from '../../scripts/ci/workflow-tool-pins.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const workflow = readFileSync(join(repositoryRoot, '.github/workflows/bump-shadow-pins.yml'), 'utf8');

function writePins(path) {
  writeFileSync(path, `${JSON.stringify({
    zizmor: {
      version: '1.27.0',
      sha256: 'a'.repeat(64),
    },
    actionlint: {
      version: '1.7.12',
      sha256: 'b'.repeat(64),
    },
  }, null, 2)}\n`);
}

describe('REQ-OPS-020: workflow-tool shadow pins', () => {
  it('updates one exact pin without changing the other tool', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-workflow-pins-'));
    try {
      const path = join(directory, 'pins.json');
      writePins(path);

      updateWorkflowToolPin(path, 'zizmor', '1.27.0', '1.28.0', 'c'.repeat(64));

      assert.deepEqual(readWorkflowToolPin(path, 'zizmor'), {
        version: '1.28.0',
        sha256: 'c'.repeat(64),
      });
      assert.deepEqual(readWorkflowToolPin(path, 'actionlint'), {
        version: '1.7.12',
        sha256: 'b'.repeat(64),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects stale or malformed updates without writing a partial result', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-workflow-pins-'));
    try {
      const path = join(directory, 'pins.json');
      writePins(path);
      const before = readFileSync(path, 'utf8');

      assert.throws(
        () => updateWorkflowToolPin(path, 'actionlint', '1.7.11', '1.7.13', 'd'.repeat(64)),
        /expected actionlint 1\.7\.11, found 1\.7\.12/,
      );
      assert.throws(
        () => updateWorkflowToolPin(path, 'actionlint', '1.7.12', 'latest', 'd'.repeat(64)),
        /invalid version/,
      );
      assert.equal(readFileSync(path, 'utf8'), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps automated bumps outside the workflow-write permission boundary', () => {
    const zizmorJob = workflow.slice(workflow.indexOf('\n  zizmor:'), workflow.indexOf('\n  actionlint:'));
    const actionlintJob = workflow.slice(workflow.indexOf('\n  actionlint:'));

    for (const job of [zizmorJob, actionlintJob]) {
      assert.match(job, /node scripts\/ci\/workflow-tool-pins\.mjs update/);
      assert.match(job, /git add \.github\/workflow-tool-pins\.json/);
      assert.doesNotMatch(job, /git add \.github\/workflows\//);
    }
  });
});
