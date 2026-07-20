// Behavioral tests for the two fail-closed CI gates that decide whether a test
// run counts as green. They run under plain Node (they spawn the gate scripts as
// subprocesses and build temp trees), so they are listed in
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
import { SUITES } from '../../../scripts/ci/suites.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPLETENESS = join(REPO, 'scripts/ci/check-suite-completeness.mjs');
const REPORT_GATE = join(REPO, 'scripts/ci/check-vitest-report.mjs');

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
function report(artifactDir: string, name: string, files: string[]) {
  const p = join(work, 'artifacts', artifactDir);
  mkdirSync(p, { recursive: true });
  writeFileSync(
    join(p, name),
    JSON.stringify({
      numTotalTests: files.length,
      numFailedTests: 0,
      numFailedTestSuites: 0,
      testResults: files.map((f) => ({
        name: `/checkout/${f}`,
        startTime: 0,
        endTime: 10,
        assertionResults: [{ status: 'passed' }],
      })),
    }),
  );
}

function runCompleteness(lanes: Record<string, string>, cwd: string, artifactRoot = 'artifacts') {
  // The gate requires a result for EVERY suite lane, because an absent key is
  // indistinguishable from a skipped lane and would disarm that suite silently.
  // Default the lanes a given test is not exercising to 'skipped' (inert: no
  // reports + skipped is the documented pass) so each case stays focused on one
  // suite without the others failing it for an unrelated reason — and, more
  // importantly, so the cases that assert exit 1 still fail for the defect under
  // test rather than for a missing key.
  const allLanes = Object.fromEntries(SUITES.map((s: { lane: string }) => [s.lane, 'skipped']));
  return spawnSync(
    process.execPath,
    [COMPLETENESS, join(work, artifactRoot), JSON.stringify({ ...allLanes, ...lanes })],
    { cwd, encoding: 'utf8' },
  );
}

describe('REQ-OPS-003 AC5: cross-suite completeness gate', () => {
  it('passes when every backend test file in the tree appears in some report', () => {
    const files = ['src/a.test.ts', 'src/nested/b.test.ts'];
    const cwd = tree(files);
    report('backend-shard-1', 'backend-shard-1.json', [files[0]]);
    report('backend-shard-2', 'backend-shard-2.json', [files[1]]);
    report('backend-node', 'backend-node.json', NODE_SUITE_FILES);

    const r = runCompleteness({ backend: 'success' }, cwd);
    expect(r.status).toBe(0);
  });

  it('fails when a file present in the tree ran in no shard', () => {
    const files = ['src/a.test.ts', 'src/nested/b.test.ts'];
    const cwd = tree(files);
    report('backend-shard-1', 'backend-shard-1.json', [files[0]]);
    report('backend-node', 'backend-node.json', NODE_SUITE_FILES);

    const r = runCompleteness({ backend: 'success' }, cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/nested/b.test.ts');
  });

  it('fails when a report names a file that is not in the tree', () => {
    const cwd = tree(['src/a.test.ts']);
    report('backend-shard-1', 'backend-shard-1.json', ['src/a.test.ts', 'src/ghost.test.ts']);
    report('backend-node', 'backend-node.json', NODE_SUITE_FILES);

    const r = runCompleteness({ backend: 'success' }, cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('src/ghost.test.ts');
  });

  it('fails on a corrupt report rather than skipping it', () => {
    const cwd = tree(['src/a.test.ts']);
    const dir = join(work, 'artifacts', 'backend-shard-1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'backend-shard-1.json'), '{ not json');

    expect(runCompleteness({ backend: 'success' }, cwd).status).toBe(1);
  });

  it('fails when a lane reported success but uploaded no reports', () => {
    const cwd = tree(['src/a.test.ts']);
    expect(runCompleteness({ backend: 'success' }, cwd, 'missing').status).toBe(1);
  });

  it('fails when a suite has no lane result at all, rather than reading it as skipped', () => {
    // Adding a suite to suites.mjs without adding its lane to the LANES argument
    // in test.yml used to disarm the reconciler for that suite: the lookup
    // yields undefined, and undefined !== 'success' takes the "nothing to
    // reconcile" branch. Pass the raw JSON directly, bypassing the defaults
    // above, so the omission is real.
    const cwd = tree(['src/a.test.ts']);
    const r = spawnSync(process.execPath, [COMPLETENESS, join(work, 'missing'), '{"backend":"skipped"}'], {
      cwd,
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('frontend');
  });

  it('passes when a lane was skipped by the path filter', () => {
    const cwd = tree(['src/a.test.ts']);
    expect(runCompleteness({ backend: 'skipped' }, cwd, 'missing').status).toBe(0);
  });

  it('fails when two shards both claim the same file', () => {
    const files = ['src/a.test.ts', 'src/nested/b.test.ts'];
    const cwd = tree(files);
    report('backend-shard-1', 'backend-shard-1.json', files);
    // Shard 2 disagreed about the split and re-ran one of shard 1's files.
    report('backend-shard-2', 'backend-shard-2.json', [files[1]]);
    report('backend-node', 'backend-node.json', NODE_SUITE_FILES);

    const r = runCompleteness({ backend: 'success' }, cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('more than one report');
    expect(r.stderr).toContain('src/nested/b.test.ts');
  });

  it('reconciles each suite against its own tree, not just the backend', () => {
    const cwd = tree(['src/a.test.ts']);
    touch(cwd, 'web-ui/src/__tests__/one.test.tsx');
    touch(cwd, 'web-ui/src/__tests__/two.test.tsx');
    report('backend-shard-1', 'backend-shard-1.json', ['src/a.test.ts']);
    report('backend-node', 'backend-node.json', NODE_SUITE_FILES);
    // Only one of the two frontend files is reported.
    report('frontend-shard-1', 'frontend-shard-1.json', ['web-ui/src/__tests__/one.test.tsx']);

    const r = runCompleteness({ backend: 'success', frontend: 'success' }, cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('web-ui/src/__tests__/two.test.tsx');
  });

  it('does not let one suite pass vacuously when another has no reports', () => {
    const cwd = tree(['src/a.test.ts']);
    report('backend-shard-1', 'backend-shard-1.json', ['src/a.test.ts']);
    report('backend-node', 'backend-node.json', NODE_SUITE_FILES);

    // Backend fully reconciles, but the frontend lane claims success with nothing.
    const r = runCompleteness({ backend: 'success', frontend: 'success' }, cwd);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('frontend');
  });
});

function runReportGate(status: number, reportBody: unknown, log: string, tolerate = 'true') {
  const rp = join(work, 'report.json');
  const lp = join(work, 'run.log');
  writeFileSync(rp, typeof reportBody === 'string' ? reportBody : JSON.stringify(reportBody));
  writeFileSync(lp, log);
  return spawnSync(process.execPath, [REPORT_GATE, String(status), rp, lp, tolerate], {
    encoding: 'utf8',
  });
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

describe('REQ-OPS-003 AC4: vitest report gate', () => {
  it('accepts a clean run', () => {
    expect(runReportGate(0, passing(), '').status).toBe(0);
  });

  it('accepts a non-zero exit carrying the known workerd teardown fingerprint', () => {
    expect(runReportGate(1, passing(), TEARDOWN_CRASH).status).toBe(0);
  });

  it('rejects that same crash for a suite that did not opt into tolerance', () => {
    expect(runReportGate(1, passing(), TEARDOWN_CRASH, 'false').status).toBe(1);
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
