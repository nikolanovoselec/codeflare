import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import { readWorkflowToolPin } from '../../scripts/ci/workflow-tool-pins.mjs';

const script = resolve(import.meta.dirname, '../../scripts/ci/workflow-tool-pins.mjs');

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

function run(args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

describe('REQ-OPS-041: least-privilege workflow-tool pin updates', () => {
  it('updates and stages only the non-workflow manifest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-workflow-pins-'));
    try {
      const githubDirectory = join(directory, '.github');
      const workflowDirectory = join(githubDirectory, 'workflows');
      const path = join(githubDirectory, 'workflow-tool-pins.json');
      const unrelated = join(workflowDirectory, 'sentinel.yml');
      mkdirSync(workflowDirectory, { recursive: true });
      writePins(path);
      writeFileSync(unrelated, 'name: unchanged\n');
      const initialized = spawnSync('git', ['init', '--quiet'], { cwd: directory, encoding: 'utf8' });
      assert.equal(initialized.status, 0, initialized.stderr);

      const updated = run(['update-and-stage', 'zizmor', '1.27.0', '1.28.0', 'c'.repeat(64)], directory);

      assert.equal(updated.status, 0, updated.stderr);
      assert.deepEqual(readWorkflowToolPin(path, 'zizmor'), {
        version: '1.28.0',
        sha256: 'c'.repeat(64),
      });
      assert.deepEqual(readWorkflowToolPin(path, 'actionlint'), {
        version: '1.7.12',
        sha256: 'b'.repeat(64),
      });
      assert.equal(readFileSync(unrelated, 'utf8'), 'name: unchanged\n');

      const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: directory, encoding: 'utf8' });
      assert.equal(staged.status, 0, staged.stderr);
      assert.equal(staged.stdout, '.github/workflow-tool-pins.json\n');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects stale or malformed CLI updates without writing a partial result', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codeflare-workflow-pins-'));
    try {
      const path = join(directory, 'pins.json');
      writePins(path);
      const before = readFileSync(path, 'utf8');

      const stale = run(['update', 'actionlint', '1.7.11', '1.7.13', 'd'.repeat(64), path]);
      assert.notEqual(stale.status, 0);
      assert.match(stale.stderr, /expected actionlint 1\.7\.11, found 1\.7\.12/);

      const malformed = run(['update', 'actionlint', '1.7.12', 'latest', 'd'.repeat(64), path]);
      assert.notEqual(malformed.status, 0);
      assert.match(malformed.stderr, /invalid version/);
      assert.equal(readFileSync(path, 'utf8'), before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
