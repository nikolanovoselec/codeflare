// Behavioral tests for the two fail-closed CI gates that decide whether a
// backend test run counts as green. They run under plain Node (they spawn the
// gate scripts as subprocesses and build temp trees), so they are listed in
// vitest.node-suite.mjs rather than the Workers pool.
//
// REQ-OPS-003: PR checks run lint, test, typecheck and security audit.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NODE_SUITE_FILES } from '../../../vitest.node-suite.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPLETENESS = join(REPO, 'scripts/ci/check-suite-completeness.mjs');
const REPORT_GATE = join(REPO, 'scripts/ci/check-backend-test-report.mjs');

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'suite-gates-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function touch(root: string, relPath: string) {
  const p = join(root, relPath);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
}

/** A tree whose only backend test files are `files` (plus the Node suite). */
function tree(files: string[]) {
  const root = join(work, 'tree');
  mkdirSync(root, { recursive: true });
  for (const f of [...NODE_SUITE_FILES, ...files]) touch(root, f);
  return root;
}

/** A vitest JSON report naming `files` as collected, each with one assertion. */
function report(dir: string, name: string, files: string[], treeRoot = '/checkout') {
  const p = join(work, dir);
  mkdirSync(p, { recursive: true });
  const body = {
    numTotalTests: files.length,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: files.map((f) => ({
      name: `${treeRoot}/${f}`,
      startTime: 0,
      endTime: 10,
      assertionResults: [{ status: 'passed' }],
    })),
  };
  writeFileSync(join(p, name), JSON.stringify(body));
}

function runCompleteness(artifactRoot: string, lane: string, cwd: string) {
  return spawnSync(process.execPath, [COMPLETENESS, artifactRoot, lane], {
    cwd,
    encoding: 'utf8',
  });
}

describe('REQ-OPS-003 AC5: cross-shard completeness gate', () => {
  it('passes when every backend test file in the tree appears in some shard report', () => {
    const files = ['src/a.test.ts', 'src/nested/b.test.ts'];
    const cwd = tree(files);
    report('artifacts/shard-1', 'backend-tests.json', [files[0]]);
    report('artifacts/shard-2', 'backend-tests.json', [files[1]]);
    report('artifacts/shard-1', 'node-tests.json', NODE_SUITE_FILES);

    const r = runCompleteness(join(work, 'artifacts'), 'success', cwd);
    expect(r.status).toBe(0);
  });

  it('fails when a file present in the tree ran in no shard', () => {
    const files = ['src/a.test.ts', 'src/nested/b.test.ts'];
    const cwd = tree(files);
    report('artifacts/shard-1', 'backend-tests.json', [files[0]]);
    report('artifacts/shard-1', 'node-tests.json', NODE_SUITE_FILES);

    const r = runCompleteness(join(work, 'artifacts'), 'success', cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/nested/b.test.ts');
  });

  it('fails when a report names a file that is not in the tree', () => {
    const cwd = tree(['src/a.test.ts']);
    report('artifacts/shard-1', 'backend-tests.json', ['src/a.test.ts', 'src/ghost.test.ts']);
    report('artifacts/shard-1', 'node-tests.json', NODE_SUITE_FILES);

    const r = runCompleteness(join(work, 'artifacts'), 'success', cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/ghost.test.ts');
  });

  it('fails on a corrupt shard report rather than skipping it', () => {
    const cwd = tree(['src/a.test.ts']);
    const dir = join(work, 'artifacts/shard-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'backend-tests.json'), '{ not json');

    const r = runCompleteness(join(work, 'artifacts'), 'success', cwd);
    expect(r.status).toBe(1);
  });

  it('fails when the lane reported success but uploaded no reports', () => {
    const cwd = tree(['src/a.test.ts']);
    const r = runCompleteness(join(work, 'missing'), 'success', cwd);
    expect(r.status).toBe(1);
  });

  it('passes when the lane was skipped by the path filter', () => {
    const cwd = tree(['src/a.test.ts']);
    const r = runCompleteness(join(work, 'missing'), 'skipped', cwd);
    expect(r.status).toBe(0);
  });
});

function runReportGate(status: number, reportBody: unknown, log: string) {
  const rp = join(work, 'report.json');
  const lp = join(work, 'run.log');
  writeFileSync(rp, typeof reportBody === 'string' ? reportBody : JSON.stringify(reportBody));
  writeFileSync(lp, log);
  return spawnSync(process.execPath, [REPORT_GATE, String(status), rp, lp], { encoding: 'utf8' });
}

const TEARDOWN_CRASH = 'stack\n[vitest-pool]: Worker cloudflare-pool emitted error.\nmore';

const passing = (files = 2) => ({
  numTotalTests: files,
  numFailedTests: 0,
  numFailedTestSuites: 0,
  testResults: Array.from({ length: files }, (_, i) => ({
    name: `/checkout/src/${i}.test.ts`,
    assertionResults: [{ status: 'passed' }],
  })),
});

describe('REQ-OPS-003 AC4: backend test report gate', () => {
  it('accepts a clean run', () => {
    expect(runReportGate(0, passing(), '').status).toBe(0);
  });

  it('accepts a non-zero exit carrying the known workerd teardown fingerprint', () => {
    expect(runReportGate(1, passing(), TEARDOWN_CRASH).status).toBe(0);
  });

  it('rejects a non-zero exit without that fingerprint', () => {
    expect(runReportGate(1, passing(), 'some other crash').status).toBe(1);
  });

  it('rejects a report with failed tests even on a zero exit', () => {
    const r = passing();
    r.numFailedTests = 1;
    expect(runReportGate(0, r, '').status).toBe(1);
  });

  it('rejects a run that collected zero tests', () => {
    expect(
      runReportGate(0, { numTotalTests: 0, numFailedTests: 0, numFailedTestSuites: 0, testResults: [] }, '')
        .status,
    ).toBe(1);
  });

  it('rejects a file that collected zero assertions (collection crash)', () => {
    const r = passing();
    r.testResults.push({ name: '/checkout/src/dead.test.ts', assertionResults: [] });
    const out = runReportGate(0, r, '');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('src/dead.test.ts');
  });

  it('rejects an unparseable report', () => {
    expect(runReportGate(0, '{ not json', '').status).toBe(1);
  });
});
