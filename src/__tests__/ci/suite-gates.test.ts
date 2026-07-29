// Behavioral tests for the two fail-closed CI gates that decide whether a test
// run counts as green. They run under plain Node (they spawn the gate scripts as
// subprocesses and build temp trees), so they are listed in
// vitest.node-suite.mjs rather than the Workers pool.
//
// REQ-OPS-003: PR checks run lint, test, typecheck and security audit.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { NODE_SUITE_FILES } from '../../../vitest.node-suite.mjs';
import { SUITES } from '../../../scripts/ci/suites.mjs';
import { updateCodeServerPins } from '../../../scripts/ci/update-code-server-pins.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPLETENESS = join(REPO, 'scripts/ci/check-suite-completeness.mjs');
const REPORT_GATE = join(REPO, 'scripts/ci/check-vitest-report.mjs');
const COVERAGE_GATE = join(REPO, 'scripts/ci/check-coverage-result.mjs');
const SHADOW_PINS_WORKFLOW = join(REPO, '.github/workflows/bump-shadow-pins.yml');

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'suite-gates-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function evaluateWorkflowCondition(expression: string, values: Record<string, string>): boolean {
  let resolved = expression;
  for (const reference of Object.keys(values).sort((left, right) => right.length - left.length)) {
    resolved = resolved.replaceAll(reference, JSON.stringify(values[reference]));
  }
  expect(resolved).not.toMatch(/\b(?:needs|steps)\./);
  return Boolean(runInNewContext(resolved, Object.create(null), { timeout: 100 }));
}

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
        // An absolute path under the tree the gate is run against, which is what
        // vitest actually writes. The old synthetic `/checkout/` prefix only
        // worked because the gate located the suite directory by searching for
        // `/<dir>/` inside the string; now that it relativises against cwd — the
        // exact operation, and the one production does — a fabricated prefix
        // outside the run directory produces `../../..` paths and matches
        // nothing. The fixture was the unfaithful half.
        name: join(work, 'tree', f),
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

describe('REQ-OPS-003 AC6: Browser IDE extension suite ownership', () => {
  it('routes owned Browser IDE paths through the workflow classifier while leaving docs-only changes inert', () => {
    const workflow = parseYaml(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8')) as {
      jobs: { changes: { steps: Array<{ id?: string; with?: { filters?: string } }> } };
    };
    const filterSource = workflow.jobs.changes.steps.find((step) => step.id === 'filter')?.with?.filters;
    expect(filterSource).toBeTypeOf('string');
    const filters = parseYaml(filterSource!) as Record<string, unknown[]>;
    const idePatterns = flattenPatterns(filters.ide);
    const hostPatterns = flattenPatterns(filters.host);

    expect(matchesAny('openvscode/agent-sidebar/src/extension.ts', idePatterns)).toBe(true);
    expect(matchesAny('scripts/ci/smoke-openvscode-sidebar-image.mjs', idePatterns)).toBe(true);
    expect(matchesAny('scripts/browser-ide-ui-state.py', idePatterns)).toBe(true);
    expect(matchesAny('scripts/browser-ide-ui-state.py', hostPatterns)).toBe(true);
    expect(matchesAny('preseed/agents/pi/extensions/sidebar-approval.ts', idePatterns)).toBe(true);
    expect(matchesAny('.github/workflows/test.yml', idePatterns)).toBe(true);
    expect(matchesAny('documentation/lanes/container.md', idePatterns)).toBe(false);
  });

  it('audits production lockfiles without depending on restored node_modules trees', () => {
    const workflow = parseYaml(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8')) as {
      jobs: { quality: { steps: Array<{ name?: string; run?: string; 'working-directory'?: string }> } };
    };
    const audits = workflow.jobs.quality.steps.filter((step) => step.name?.startsWith('Security audit'));
    expect(audits).toEqual([
      { name: 'Security audit (backend)', run: 'npm audit --package-lock-only --audit-level=high --omit=dev' },
      { name: 'Security audit (frontend)', run: 'npm audit --package-lock-only --audit-level=high --omit=dev', 'working-directory': 'web-ui' },
    ]);
  });

  it('registers every owned extension test file for fail-closed report reconciliation', () => {
    expect(SUITES).toContainEqual({
      name: 'browser-ide',
      lane: 'browser-ide',
      dir: 'openvscode',
      extensions: ['.test.ts', '.test.mjs'],
      exclude: [],
      artifacts: ['browser-ide'],
    });
  });

  it('REQ-OPS-003 AC7: requires non-publishing complete-image smoke in the required status', () => {
    const workflow = parseYaml(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8')) as {
      jobs: Record<string, {
        if?: string;
        needs?: string | string[];
        'continue-on-error'?: boolean;
        permissions?: Record<string, string>;
        steps?: Array<{
          name?: string;
          if?: string;
          run?: string;
          uses?: string;
          with?: Record<string, unknown>;
          'continue-on-error'?: boolean;
        }>;
      }>;
    };
    const extensionJob = workflow.jobs['browser-ide'];
    const reuseJob = workflow.jobs['browser-ide-image-reuse'];
    const imageJob = workflow.jobs['browser-ide-image'];
    const summaryJob = workflow.jobs.summary;

    expect(extensionJob).toBeDefined();
    expect(reuseJob).toBeDefined();
    expect(imageJob).toBeDefined();
    expect(imageJob.needs).toEqual(['changes', 'browser-ide', 'browser-ide-image-reuse']);
    expect(imageJob['continue-on-error']).not.toBe(true);
    expect(imageJob.if?.replace(/\s+/g, ' ').trim()).toBe(
      "(needs.changes.outputs.full == 'true' || needs.changes.outputs.ide == 'true') && needs.browser-ide.result == 'success' && needs.browser-ide-image-reuse.result == 'success' && needs.browser-ide-image-reuse.outputs.reused != 'true'",
    );

    const imageSteps = imageJob.steps ?? [];
    const criticalSteps = imageSteps.filter((step) => step.name !== 'Upload image evidence');
    expect(criticalSteps.every((step) => step.if === undefined && step['continue-on-error'] !== true)).toBe(true);
    const imageCommands = imageSteps.flatMap((step) => step.run ?? []).join('\n');
    expect(imageJob.permissions?.actions).toBe('write');
    expect(imageCommands).toContain('docker buildx build');
    expect(imageCommands).toContain('--load');
    expect(imageCommands).toContain('/opt/codeflare/openvscode/smoke-openvscode-sidebar-image.mjs');
    // Identity and pinning shape, not the digest itself: what AC7 protects is
    // which actions this job may run -- adding a login or push action has to
    // fail here -- and that each is pinned to an immutable digest rather than a
    // floating tag. Asserting the digest value instead made every routine bump
    // of either action fail for a reason the AC does not care about.
    const imageUses = imageSteps.flatMap((step) => step.uses ?? []);
    expect(imageUses.map((use) => use.split('@')[0])).toEqual([
      'actions/checkout',
      'docker/setup-buildx-action',
      'actions/upload-artifact',
    ]);
    expect(imageUses.filter((use) => !/@[0-9a-f]{40}$/.test(use))).toEqual([]);
    expect(imageCommands).not.toMatch(
      /\b(?:docker|podman)\s+(?:(?:image|manifest)\s+)?(?:login|push)\b|\bdocker\s+(?:buildx\s+build|build)\b[^;&]*--push\b|\b(?:npm\s+publish|oras\s+push|skopeo\s+copy)\b/i,
    );
    expect(JSON.stringify(imageSteps)).not.toMatch(/(?:login|build-push)-action/i);

    const requiredJobs = Array.isArray(summaryJob.needs) ? summaryJob.needs : [summaryJob.needs];
    expect(requiredJobs).toEqual(expect.arrayContaining([
      'browser-ide',
      'browser-ide-image-reuse',
      'browser-ide-image',
    ]));
  });

  it('REQ-OPS-030: reuses only validated Browser IDE image evidence and gates relevant skips', () => {
    const workflow = parseYaml(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8')) as {
      jobs: Record<string, {
        needs?: string | string[];
        permissions?: Record<string, string>;
        outputs?: Record<string, string>;
        steps?: Array<{
          id?: string;
          name?: string;
          if?: string;
          run?: string;
          env?: Record<string, string>;
          with?: Record<string, unknown>;
        }>;
      }>;
    };
    const changes = workflow.jobs.changes;
    const reuse = workflow.jobs['browser-ide-image-reuse'];
    const image = workflow.jobs['browser-ide-image'] as typeof reuse & { if?: string };
    const summary = workflow.jobs.summary;
    const resolve = reuse.steps?.find((step) => step.name === 'Resolve reusable complete-image evidence');
    const gate = summary.steps?.find((step) => step.name === 'Verify complete-image result');
    const receipt = summary.steps?.find((step) => step.name === 'Write exact tested-tree receipt');
    const filters = String(changes.steps?.find((step) => step.id === 'filter')?.with?.filters ?? '');
    const ideInputs = filters.slice(filters.indexOf('\nide:'), filters.indexOf('\nhost:'));

    for (const input of [
      "'host/src/**'",
      "'openvscode/**'",
      "'preseed/**'",
      "'src/lib/agent-seed.generated.ts'",
      "'scripts/materialize-agent-seed.mjs'",
      "'scripts/patch-context-mode-bundles.mjs'",
    ]) expect(ideInputs).toContain(input);
    expect(reuse.needs).toBe('changes');
    expect(reuse.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(reuse.outputs).toMatchObject({
      reused: '${{ steps.resolve.outputs.reused }}',
      source_run_id: '${{ steps.resolve.outputs.source_run_id }}',
      fingerprint: '${{ steps.fingerprint.outputs.image }}',
      contract_fingerprint: '${{ steps.fingerprint.outputs.contract }}',
      reuse_safe: '${{ steps.fingerprint.outputs.reuse_safe }}',
    });
    expect(resolve?.if?.replace(/\s+/g, ' ').trim()).toBe(
      "github.event_name == 'pull_request' && steps.fingerprint.outputs.reuse_safe == 'true' && (needs.changes.outputs.full == 'true' || needs.changes.outputs.ide == 'true')",
    );
    const imageCondition = image.if?.replace(/\s+/g, ' ').trim() ?? '';
    const base = {
      "needs.changes.outputs.full": 'false',
      "needs.changes.outputs.ide": 'true',
      "needs.browser-ide.result": 'success',
      "needs.browser-ide-image-reuse.result": 'success',
      "needs.browser-ide-image-reuse.outputs.reused": 'false',
    };
    expect(evaluateWorkflowCondition(imageCondition, base)).toBe(true);
    expect(evaluateWorkflowCondition(imageCondition, {
      ...base,
      "needs.browser-ide-image-reuse.outputs.reused": 'true',
    })).toBe(false);
    expect(evaluateWorkflowCondition(imageCondition, {
      ...base,
      "needs.browser-ide-image-reuse.result": 'failure',
    })).toBe(false);
    expect(evaluateWorkflowCondition(imageCondition, {
      ...base,
      "needs.changes.outputs.ide": 'false',
    })).toBe(false);
    expect(evaluateWorkflowCondition(imageCondition, {
      ...base,
      "needs.changes.outputs.full": 'true',
      "needs.changes.outputs.ide": 'false',
    })).toBe(true);
    expect(gate?.run?.replace(/\s+/g, ' ').trim()).toBe(
      'node scripts/ci/browser-ide-image-reuse.mjs gate "$FULL" "$IDE" "$IMAGE_REUSE_RESULT" "$IMAGE_REUSED" "$IMAGE_RESULT"',
    );
    expect(receipt?.env).toMatchObject({
      REPOSITORY: '${{ github.repository }}',
      RUN_ID: '${{ github.run_id }}',
      RUN_ATTEMPT: '${{ github.run_attempt }}',
      IMAGE_FINGERPRINT: '${{ needs.browser-ide-image-reuse.outputs.fingerprint }}',
    });
    expect(receipt?.run?.split('\n').map((line) => line.trim()).filter(Boolean)).toEqual([
      'set -euo pipefail',
      'tested_commit=$(git rev-parse HEAD)',
      "tested_tree=$(git rev-parse 'HEAD^{tree}')",
      'node scripts/ci/browser-ide-image-reuse.mjs receipt \\',
      '"$REPOSITORY" "$RUN_ID" "$RUN_ATTEMPT" "$tested_commit" "$tested_tree" \\',
      '"$IMAGE_FINGERPRINT" "$FULL" "$IDE" "$IMAGE_REUSE_RESULT" \\',
      '"$IMAGE_REUSED" "$IMAGE_SOURCE_RUN_ID" "$IMAGE_RESULT" \\',
      '> /tmp/pr-checks-receipt.json',
    ]);
  });

  it('REQ-OPS-001 AC4: complete-image and deploy builds share compatible caches', () => {
    const testWorkflow = parseYaml(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const deployWorkflow = parseYaml(
      readFileSync(join(REPO, '.github/workflows/container-image.yml'), 'utf8'),
    ) as { jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }> };
    const buildCommand = (steps: Array<{ name?: string; run?: string }> | undefined, name: string) =>
      steps?.find((step) => step.name === name)?.run ?? '';
    const cacheFlags = (command: string) =>
      command.match(/--cache-(?:from|to) "[^"]+"/g)?.sort() ?? [];

    const completeImage = buildCommand(testWorkflow.jobs['browser-ide-image'].steps, 'Build complete image');
    const deployment = buildCommand(deployWorkflow.jobs.image.steps, 'Build container image');

    expect(cacheFlags(completeImage)).toEqual([
      '--cache-from "type=gha,scope=container-image-linux-amd64"',
      '--cache-to "type=gha,mode=max,scope=container-image-linux-amd64,ignore-error=true"',
    ]);
    expect(cacheFlags(deployment)).toEqual(cacheFlags(completeImage));
  });

  it('fails closed on coverage evidence and bounds the backend crash exception', () => {
    const table = ' All files | 100 | 100 | 100 | 100 |\n';
    const passed = ' Test Files  1 passed (1)\n Tests  2 passed (2)\n';
    const crash = '[vitest-pool]: Worker cloudflare-pool emitted error.\n';
    const cases = [
      { name: 'complete success', log: table, status: 0, tolerate: false, expected: 0 },
      { name: 'missing table', log: `${passed}${crash}`, status: 1, tolerate: true, expected: 1 },
      { name: 'failed tests', log: `${table} Tests 1 failed | 2 passed\n${crash}`, status: 1, tolerate: true, expected: 1 },
      { name: 'threshold miss', log: `${table}ERROR: Coverage for lines (79%) does not meet global threshold (80%)\n${crash}`, status: 1, tolerate: true, expected: 1 },
      { name: 'bounded backend crash', log: `${table}${passed}${crash}`, status: 1, tolerate: true, expected: 0 },
      { name: 'crash plus unrelated failure', log: `${table}${passed} Errors  2 errors\n${crash}`, status: 1, tolerate: true, expected: 1 },
      { name: 'untolerated frontend crash', log: `${table}${passed}${crash}`, status: 1, tolerate: false, expected: 1 },
      { name: 'unknown backend failure', log: table, status: 2, tolerate: true, expected: 2 },
    ];

    for (const fixture of cases) {
      const log = join(work, `${fixture.name.replaceAll(' ', '-')}.log`);
      writeFileSync(log, fixture.log);
      const result = spawnSync(
        process.execPath,
        [COVERAGE_GATE, log, String(fixture.status), String(fixture.tolerate)],
        { encoding: 'utf8' },
      );
      expect(result.status, fixture.name).toBe(fixture.expected);
    }
  });

  it('path-gates backend and frontend coverage through one reusable action', () => {
    const workflow = parseYaml(readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8')) as {
      jobs: Record<string, {
        if?: string;
        steps?: Array<{ uses?: string }>;
      }>;
    };
    const backend = workflow.jobs['coverage-backend'];
    const frontend = workflow.jobs['coverage-frontend'];

    expect(workflow.jobs.coverage).toBeUndefined();
    expect(backend.if).toContain("needs.changes.outputs.backend == 'true'");
    expect(frontend.if).toContain("needs.changes.outputs.webui == 'true'");
    expect(backend.steps?.some((step) => step.uses === './.github/actions/coverage-suite')).toBe(true);
    expect(frontend.steps?.some((step) => step.uses === './.github/actions/coverage-suite')).toBe(true);

    const action = parseYaml(readFileSync(join(REPO, '.github/actions/coverage-suite/action.yml'), 'utf8')) as {
      runs: { steps: Array<{ name?: string; run?: string }> };
    };
    const runStep = action.runs.steps.find((step) => step.name === 'Run suite with coverage');
    expect(runStep).toBeDefined();
    const activeCommands = (runStep?.run ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .join(' ')
      .replace(/\\\s+/g, ' ')
      .replace(/\s+/g, ' ');
    expect(activeCommands).toContain(
      'node "$GITHUB_WORKSPACE/scripts/ci/check-coverage-result.mjs" /tmp/coverage.log "$status" "$TOLERATE_POOL_CRASH"',
    );
  });
});

describe('REQ-OPS-027: code-server coupled-pin automation', () => {
  it('routes code-server bumps through one dedicated fail-closed updater', () => {
    const workflow = parseYaml(readFileSync(SHADOW_PINS_WORKFLOW, 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const job = workflow.jobs['code-server'];

    expect(job).toBeDefined();
    expect(workflow.jobs['openvscode-server']).toBeUndefined();
    const activeCommands = (job.steps ?? [])
      .flatMap((step) => (step.run ?? '').split('\n'))
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(activeCommands.filter((line) => line === 'node scripts/ci/update-code-server-pins.mjs Dockerfile')).toHaveLength(1);
  });

  it('updates every coupled runtime pin and invalidates the checksum atomically', () => {
    const source = [
      'CODE_SERVER_VERSION="4.1.0"',
      'CODE_SERVER_SHA256="old"',
      'CODE_SERVER_COMMIT="1111111111111111111111111111111111111111"',
      'CODE_SERVER_CODE_VERSION="1.1.0"',
      'CODE_SERVER_VSCODE_COMMIT="2222222222222222222222222222222222222222"',
    ].join('\n');

    expect(updateCodeServerPins(source, {
      codeServerVersion: '4.130.0',
      codeServerCommit: '3333333333333333333333333333333333333333',
      codeVersion: '1.130.0',
      vscodeCommit: '4444444444444444444444444444444444444444',
    })).toBe([
      'CODE_SERVER_VERSION="4.130.0"',
      'CODE_SERVER_SHA256="NEEDS_UPDATE_SEE_PR_BODY"',
      'CODE_SERVER_COMMIT="3333333333333333333333333333333333333333"',
      'CODE_SERVER_CODE_VERSION="1.130.0"',
      'CODE_SERVER_VSCODE_COMMIT="4444444444444444444444444444444444444444"',
    ].join('\n'));
  });

  it('fails closed for malformed metadata or an incomplete Dockerfile contract', () => {
    const pins = {
      codeServerVersion: '4.130.0',
      codeServerCommit: '3'.repeat(40),
      codeVersion: '1.130.0',
      vscodeCommit: '4'.repeat(40),
    };
    expect(() => updateCodeServerPins('CODE_SERVER_VERSION="4.1.0"', pins)).toThrow(/exactly one Dockerfile match/);
    expect(() => updateCodeServerPins([
      'CODE_SERVER_VERSION="4.1.0"',
      'CODE_SERVER_SHA256="old"',
      'CODE_SERVER_COMMIT="1"',
      'CODE_SERVER_CODE_VERSION="1.1.0"',
      'CODE_SERVER_VSCODE_COMMIT="2"',
    ].join('\n'), { ...pins, codeVersion: 'release prose' })).toThrow(/valid release versions/);
  });
});

function flattenPatterns(values: unknown[]): string[] {
  const patterns: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') patterns.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
  };
  values.forEach(visit);
  return patterns;
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) return path === pattern.slice(0, -3) || path.startsWith(pattern.slice(0, -2));
    return path === pattern;
  });
}

describe('REQ-OPS-023 AC3: cross-suite completeness gate', () => {
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
  // The gate asserts these are integers rather than defaulting them to 0, so a
  // reporter that stops emitting them cannot silently retire the skipped-test
  // check. That makes them part of the fixture contract, not optional decoration.
  numPendingTests: 0,
  numTodoTests: 0,
  testResults: Array.from({ length: files }, (_, i) => ({
    name: `/checkout/src/${i}.test.ts`,
    assertionResults: [{ status: 'passed' }],
  })),
});

describe('REQ-OPS-023 AC1: vitest report gate', () => {
  it('accepts a clean run', () => {
    expect(runReportGate(0, passing(), '').status).toBe(0);
  });

  it('rejects a report with failed tests even on a zero exit', () => {
    const r = passing();
    r.numFailedTests = 1;
    expect(runReportGate(0, r, '').status).toBe(1);
  });

  it('rejects a run that collected zero tests', () => {
    expect(
      runReportGate(0, { ...passing(0), numTotalTests: 0 }, '')
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

  it('rejects a report with no testResults array at all', () => {
    // A summary with no per-file evidence used to satisfy the gate: the
    // zero-assertion check iterated an empty array and found nothing wrong. The
    // gate's whole premise is that the exit code is untrustworthy and the report
    // is the evidence, so a report carrying no evidence cannot pass.
    const { testResults: _omitted, ...noDetail } = passing();
    expect(runReportGate(0, noDetail, '').status).toBe(1);
  });

  it('rejects a summary count that disagrees with the per-file detail', () => {
    const r = passing();
    r.numTotalTests = 99;
    const out = runReportGate(0, r, '');
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('99');
  });

  it('rejects a report missing the skipped/todo counters', () => {
    // With `?? 0` these defaulted silently, so a reporter that renamed them
    // turned the skip gate into `0 > 0` — permanently false, with nothing to
    // notice that the .skip backstop had gone.
    const { numPendingTests: _p, ...noPending } = passing();
    expect(runReportGate(0, noPending, '').status).toBe(1);
  });

  it('rejects skipped and todo tests', () => {
    expect(runReportGate(0, { ...passing(), numPendingTests: 1 }, '').status).toBe(1);
    expect(runReportGate(0, { ...passing(), numTodoTests: 1 }, '').status).toBe(1);
  });

  it('rejects a negative collected-test count', () => {
    expect(runReportGate(0, { ...passing(0), numTotalTests: -1 }, '').status).toBe(1);
  });
});

// Split out from the report-gate block: crash tolerance is a distinct
// contract - a carve-out with its own opt-in and its own fingerprint - not a
// case of "is this report clean". REQ-OPS-023 AC2 covers it.
describe('REQ-OPS-023 AC2: teardown-crash tolerance', () => {
  it('accepts a non-zero exit carrying the known workerd teardown fingerprint', () => {
    expect(runReportGate(1, passing(), TEARDOWN_CRASH).status).toBe(0);
  });

  it('rejects that same crash for a suite that did not opt into tolerance', () => {
    expect(runReportGate(1, passing(), TEARDOWN_CRASH, 'false').status).toBe(1);
  });

  it('rejects a non-zero exit without that fingerprint', () => {
    expect(runReportGate(1, passing(), 'some other crash').status).toBe(1);
  });
});
