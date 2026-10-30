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

function checkUpstreamFixture({ hits = 1, largeDonor = false, missingRecordPath } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'coverage-upstream-fixture-'));
  const packageRoot = join(root, 'web-ui');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(packageRoot, 'src'), { recursive: true });
    git('init', '--initial-branch=review');
    git('config', 'user.name', 'Coverage Test');
    git('config', 'user.email', 'coverage@example.invalid');
    writeFileSync(join(packageRoot, 'src/example.ts'), 'export const value = 1;\n');
    git('add', '.'); git('commit', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(packageRoot, 'src/example.ts'), 'export const value = 2;\n');
    if (largeDonor) {
      // A known donor addition exceeds both the diff-byte and changed-line bounds.
      const donor = join(packageRoot, 'src/chat/upstream/client-utils/src/ActionList.tsx');
      mkdirSync(dirname(donor), { recursive: true });
      writeFileSync(donor, `// ${'x'.repeat(1024)}\n`.repeat(11_000));
    }
    if (missingRecordPath) {
      const source = join(packageRoot, 'src/chat/upstream', missingRecordPath);
      mkdirSync(dirname(source), { recursive: true });
      writeFileSync(source, 'export const adaptation = true;\n');
    }
    git('add', '.'); git('commit', '-m', 'head');
    writeFileSync(join(root, 'coverage.log'), 'All files | 100 | 100 | 100 | 100 |\n');
    // Only owned example.ts has evidence; adapted/new files must not disappear.
    writeFileSync(join(root, 'lcov.info'), `SF:src/example.ts\nDA:1,${hits}\nend_of_record\n`);
    const result = spawnSync(process.execPath, [checker, join(root, 'coverage.log'), '0', 'false', join(root, 'lcov.info'), base, 'web-ui', '77'], { cwd: packageRoot, encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    assert.equal(result.status, missingRecordPath || !hits ? 1 : 0, output);
    if (missingRecordPath) {
      assert.match(output, /LCOV has no record for changed production file/);
      assert.ok(output.includes(`web-ui/src/chat/upstream/${missingRecordPath}`), output);
    } else {
      assert.match(output, hits ? /changed production line coverage 100%/ : /changed production line coverage 0%/);
    }
    assert.doesNotMatch(output, /ENOBUFS|exceeds/);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('REQ-OPS-022 AC6: large known donor addition with covered owned code passes', () => checkUpstreamFixture({ largeDonor: true }));
test('REQ-OPS-022 AC6: large known donor addition with uncovered owned code fails', () => checkUpstreamFixture({ largeDonor: true, hits: 0 }));

for (const missingRecordPath of [
  'client/src/hooks/useWebSocket.ts',
  'client/src/hooks/useSessionState.ts',
  'client/src/components/settings/ThemeProvider.tsx',
  'client/src/chat-embed/EmbedProviders.tsx',
  'client/src/lib/questions/questions-api.ts',
  'client-utils/src/DialogPortal.tsx',
  'client/src/components/questions/QuestionStack.tsx',
  'client/src/components/interactive-renderers/BatchRenderer.tsx',
  'dashboard-plugin-runtime/src/embedded-app-shell.tsx',
  'client/src/hooks/new-owned-hook.ts',
]) {
  test(`REQ-OPS-022 AC6: adapted or unknown donor-path file requires LCOV: ${missingRecordPath}`, () => checkUpstreamFixture({ missingRecordPath }));
}
