import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/ci/check-coverage-result.mjs');
function checkLargeFixture(hits) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-large-fixture-'));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(root, 'src/__tests__/fixtures'), { recursive: true });
    git('init', '--initial-branch=review');
    git('config', 'user.name', 'Coverage Test');
    git('config', 'user.email', 'coverage@example.invalid');
    writeFileSync(join(root, 'src/example.ts'), 'export const value = 1;\n');
    git('add', '.'); git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'src/example.ts'), 'export const value = 2;\n');
    writeFileSync(join(root, 'src/__tests__/fixtures/large.generated.json'), JSON.stringify({ payload: 'x'.repeat(11 * 1024 * 1024) }));
    git('add', '.'); git('commit', '-m', 'head');
    writeFileSync(join(root, 'coverage.log'), 'All files | 100 | 100 | 100 | 100 |\n');
    writeFileSync(join(root, 'lcov.info'), `SF:src/example.ts\nDA:1,${hits}\nend_of_record\n`);
    const result = spawnSync(process.execPath, [checker, join(root, 'coverage.log'), '0', 'false', join(root, 'lcov.info'), base, '.', '80'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, hits ? 0 : 1, result.stderr);
    assert.match(result.stdout + result.stderr, hits ? /changed production line coverage 100%/ : /changed production line coverage 0%/);
    assert.doesNotMatch(result.stdout + result.stderr, /ENOBUFS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('REQ-OPS-022 AC6: ignored large test fixtures preserve covered production coverage enforcement', () => checkLargeFixture(1));
test('REQ-OPS-022 AC6: ignored large test fixtures preserve uncovered production coverage enforcement', () => checkLargeFixture(0));
