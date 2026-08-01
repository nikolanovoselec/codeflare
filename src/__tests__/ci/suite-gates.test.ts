// Behavioral tests for the two fail-closed CI gates that decide whether a test
// run counts as green. They run under plain Node (they spawn the gate scripts as
// subprocesses and build temp trees), so they are listed in
// vitest.node-suite.mjs rather than the Workers pool.
//
// REQ-OPS-003: PR checks run lint, test, typecheck and security audit.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { CLOUDFLARE_TEST_OPTIONS } from '../../../vitest.config';
import { NODE_SUITE_FILES } from '../../../vitest.node-suite.mjs';
import {
  sharedCacheEnabled,
  shouldAttemptSharedCacheLogin,
} from '../../../scripts/ci/container-build-cache-policy.mjs';
import { SUITES } from '../../../scripts/ci/suites.mjs';
import { updateCodeServerPins } from '../../../scripts/ci/update-code-server-pins.mjs';
import { updateSilverBulletPins } from '../../../scripts/ci/update-silverbullet-pins.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const COMPLETENESS = join(REPO, 'scripts/ci/check-suite-completeness.mjs');
const REPORT_GATE = join(REPO, 'scripts/ci/check-vitest-report.mjs');
const COVERAGE_GATE = join(REPO, 'scripts/ci/check-coverage-result.mjs');
const CODE_SERVER_PIN_UPDATER = join(REPO, 'scripts/ci/update-code-server-pins.mjs');
const SILVERBULLET_PIN_UPDATER = join(REPO, 'scripts/ci/update-silverbullet-pins.mjs');
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

type CacheStep = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  'continue-on-error'?: boolean;
};
type WorkflowPermissions = Record<string, string>;
type CacheJob = { permissions?: WorkflowPermissions; steps?: CacheStep[] };
type CacheWorkflow = {
  permissions?: WorkflowPermissions;
  jobs: Record<string, CacheJob>;
};

const PERMISSION_LEVEL = { none: 0, read: 1, write: 2 } as const;

function requiredReusableWorkflowPermissions(workflow: CacheWorkflow) {
  const required: WorkflowPermissions = {};
  for (const job of Object.values(workflow.jobs)) {
    for (const [scope, level] of Object.entries(job.permissions ?? workflow.permissions ?? {})) {
      if (!(level in PERMISSION_LEVEL)) throw new Error(`unsupported ${scope} permission: ${level}`);
      const existing = required[scope];
      if (
        !existing
        || PERMISSION_LEVEL[level as keyof typeof PERMISSION_LEVEL]
          > PERMISSION_LEVEL[existing as keyof typeof PERMISSION_LEVEL]
      ) {
        required[scope] = level;
      }
    }
  }
  return required;
}

function readCacheWorkflowContract() {
  const testWorkflow = parseYaml(
    readFileSync(join(REPO, '.github/workflows/test.yml'), 'utf8'),
  ) as CacheWorkflow;
  const imageWorkflow = parseYaml(
    readFileSync(join(REPO, '.github/workflows/container-image.yml'), 'utf8'),
  ) as { jobs: Record<string, CacheJob> };
  const deployWorkflow = parseYaml(
    readFileSync(join(REPO, '.github/workflows/deploy.yml'), 'utf8'),
  ) as { jobs: Record<string, CacheJob> };
  return {
    testWorkflow,
    completeImageJob: testWorkflow.jobs['browser-ide-image'],
    imageJob: imageWorkflow.jobs.image,
    deployWorkflow,
  };
}

function cacheBuildCommand(steps: CacheStep[] | undefined, name: string) {
  return steps?.find((step) => step.name === name)?.run ?? '';
}

function sharedCacheLogin(steps: CacheStep[] | undefined) {
  return steps?.find((step) => step.name === 'Log in to GHCR for shared BuildKit cache');
}

function cachePrefixedArguments(args: string[]) {
  return args.filter((arg) => arg.startsWith('--cache-'));
}

function valuesFollowing(args: string[], flag: string) {
  return args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
}

function captureDockerBuildArguments(command: string, cacheEnabled: boolean, label: string) {
  const bin = join(work, 'bin');
  const docker = join(bin, 'docker');
  const argsFile = join(work, `${label}-${cacheEnabled}.args`);
  const githubOutput = join(work, `${label}-${cacheEnabled}.output`);
  mkdirSync(bin, { recursive: true });
  writeFileSync(docker, '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\n\' "$@" > "$DOCKER_ARGS_FILE"\n');
  chmodSync(docker, 0o755);
  const result = spawnSync(
    'bash',
    ['--noprofile', '--norc', '-euo', 'pipefail', '-c', command],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CACHE_ENABLED: String(cacheEnabled),
        DOCKER_ARGS_FILE: argsFile,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_REPOSITORY: 'owner/codeflare',
        IMAGE: 'complete-image:test',
        IMAGE_NAME: 'registry.example/codeflare',
        REF: '0123456789012345678901234567890123456789',
        TAG: 'in-test',
      },
    },
  );
  expect(result.status, `${label}: ${result.stderr}`).toBe(0);
  return readFileSync(argsFile, 'utf8').trim().split('\n');
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
    const optionalCacheSteps = new Set([
      'Resolve shared cache eligibility',
      'Log in to GHCR for shared BuildKit cache',
      'Resolve shared cache availability',
    ]);
    const criticalSteps = imageSteps.filter((step) =>
      step.name !== 'Upload image evidence' && !optionalCacheSteps.has(step.name ?? ''));
    expect(criticalSteps.every((step) => step.if === undefined && step['continue-on-error'] !== true)).toBe(true);
    const imageCommands = imageSteps.flatMap((step) => step.run ?? []).join('\n');
    expect(imageJob.permissions?.packages).toBe('read');
    expect(imageCommands).toContain('docker buildx build');
    expect(imageCommands).toContain('--load');
    expect(imageCommands).toContain('/opt/codeflare/openvscode/smoke-openvscode-sidebar-image.mjs');
    // Identity and pinning shape, not the digest itself: what AC7 protects is
    // which actions this job may run -- adding an image-publishing action has to
    // fail here -- and that each is pinned to an immutable digest rather than a
    // floating tag. Asserting the digest value instead made every routine bump
    // of either action fail for a reason the AC does not care about.
    const imageUses = imageSteps.flatMap((step) => step.uses ?? []);
    expect(imageUses.map((use) => use.split('@')[0])).toEqual([
      'actions/checkout',
      'docker/login-action',
      'docker/setup-buildx-action',
      'actions/upload-artifact',
    ]);
    expect(imageUses.filter((use) => !/@[0-9a-f]{40}$/.test(use))).toEqual([]);
    expect(imageCommands).not.toMatch(
      /\b(?:docker|podman)\s+(?:(?:image|manifest)\s+)?(?:login|push)\b|\bdocker\s+(?:buildx\s+build|build)\b[^;&]*--push\b|\b(?:npm\s+publish|oras\s+push|skopeo\s+copy)\b/i,
    );
    expect(JSON.stringify(imageSteps)).not.toMatch(/build-push-action/i);

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

  it('REQ-OPS-031 AC3: excludes forks and Dependabot from shared-cache authentication', () => {
    expect(shouldAttemptSharedCacheLogin({
      eventName: 'pull_request',
      repository: 'owner/codeflare',
      headRepository: 'owner/codeflare',
      actor: 'contributor',
    })).toBe(true);
    expect(shouldAttemptSharedCacheLogin({
      eventName: 'push',
      repository: 'owner/codeflare',
      headRepository: '',
      actor: 'maintainer',
    })).toBe(true);
    expect(shouldAttemptSharedCacheLogin({
      eventName: 'pull_request',
      repository: 'owner/codeflare',
      headRepository: 'fork/codeflare',
      actor: 'contributor',
    })).toBe(false);
    expect(shouldAttemptSharedCacheLogin({
      eventName: 'pull_request',
      repository: 'owner/codeflare',
      headRepository: 'owner/codeflare',
      actor: 'dependabot[bot]',
    })).toBe(false);

    const { completeImageJob } = readCacheWorkflowContract();
    const policy = completeImageJob.steps?.find(
      (step) => step.name === 'Resolve shared cache eligibility',
    );
    expect(policy).toMatchObject({
      id: 'cache-policy',
      env: {
        EVENT_NAME: '${{ github.event_name }}',
        REPOSITORY: '${{ github.repository }}',
        HEAD_REPOSITORY: '${{ github.event.pull_request.head.repo.full_name }}',
        ACTOR: '${{ github.actor }}',
      },
    });
    expect(policy?.run).toContain('container-build-cache-policy.mjs eligibility');
    expect(sharedCacheLogin(completeImageJob.steps)?.if).toBe(
      "steps.cache-policy.outputs.login_allowed == 'true'",
    );
    expect(sharedCacheEnabled('skipped')).toBe(false);
    const args = captureDockerBuildArguments(
      cacheBuildCommand(completeImageJob.steps, 'Build complete image'),
      false,
      'ac7-complete-image',
    );
    expect(cachePrefixedArguments(args)).toEqual([]);
  });

  it('REQ-OPS-031 AC1 + AC2 + AC5: imports one cache, restricts publication, and ignores export errors', () => {
    const { completeImageJob, imageJob, deployWorkflow } = readCacheWorkflowContract();
    const completeImage = cacheBuildCommand(completeImageJob.steps, 'Build complete image');
    const deployment = cacheBuildCommand(imageJob.steps, 'Build container image');
    const cacheRef = (command: string) =>
      command.split('\n').find((line) => line.startsWith('CACHE_REF='));

    expect(cacheRef(completeImage)).toBe(
      'CACHE_REF="ghcr.io/${GITHUB_REPOSITORY,,}/container-build-cache:linux-amd64"',
    );
    expect(cacheRef(deployment)).toBe(cacheRef(completeImage));
    const expectedFrom = 'type=registry,ref=ghcr.io/owner/codeflare/container-build-cache:linux-amd64';
    const expectedTo = `${expectedFrom},mode=max,oci-mediatypes=true,image-manifest=true,ignore-error=true`;
    const completeImageArgs = captureDockerBuildArguments(
      completeImage,
      true,
      'ac1-complete-image',
    );
    expect(cachePrefixedArguments(completeImageArgs)).toEqual(['--cache-from']);
    expect(valuesFollowing(completeImageArgs, '--cache-from')).toEqual([expectedFrom]);
    expect(valuesFollowing(completeImageArgs, '--cache-to')).toEqual([]);
    const deploymentArgs = captureDockerBuildArguments(deployment, true, 'ac1-deployment');
    expect(cachePrefixedArguments(deploymentArgs)).toEqual(['--cache-from', '--cache-to']);
    expect(valuesFollowing(deploymentArgs, '--cache-from')).toEqual([expectedFrom]);
    expect(valuesFollowing(deploymentArgs, '--cache-to')).toEqual([expectedTo]);
    expect(completeImageJob.permissions?.packages).toBe('read');
    expect(imageJob.permissions?.packages).toBe('write');
    expect(deployWorkflow.jobs.verify.permissions?.packages).toBe('read');
    expect(deployWorkflow.jobs.container.permissions?.packages).toBe('write');
    for (const step of [
      sharedCacheLogin(completeImageJob.steps),
      sharedCacheLogin(imageJob.steps),
    ]) {
      expect(step).toMatchObject({
        uses: 'docker/login-action@abd2ef45e78c5afb21d64d4ca52ee8550d9572c7',
        with: {
          registry: 'ghcr.io',
          username: '${{ github.actor }}',
          password: '${{ secrets.GITHUB_TOKEN }}',
        },
      });
    }
  });

  it('REQ-OPS-029 AC2: inline deploy verification grants every reusable-workflow permission', () => {
    const { deployWorkflow, testWorkflow } = readCacheWorkflowContract();

    expect(deployWorkflow.jobs.verify.permissions).toEqual(
      requiredReusableWorkflowPermissions(testWorkflow),
    );
  });

  it('REQ-OPS-031 AC4: cache login unavailability cannot block complete-image or deploy builds', () => {
    expect(sharedCacheEnabled('success')).toBe(true);
    expect(sharedCacheEnabled('failure')).toBe(false);
    expect(sharedCacheEnabled('skipped')).toBe(false);

    const { completeImageJob, imageJob } = readCacheWorkflowContract();
    for (const job of [completeImageJob, imageJob]) {
      const login = sharedCacheLogin(job.steps);
      const availability = job.steps?.find(
        (step) => step.name === 'Resolve shared cache availability',
      );
      expect(login).toMatchObject({ id: 'cache-login', 'continue-on-error': true });
      expect(availability).toMatchObject({
        id: 'cache',
        env: { LOGIN_OUTCOME: '${{ steps.cache-login.outcome }}' },
      });
      expect(availability?.run).toContain('container-build-cache-policy.mjs availability');
    }

    const builds = [
      [completeImageJob, 'Build complete image', 'ac8-complete-image'],
      [imageJob, 'Build container image', 'ac8-deployment'],
    ] as const;
    for (const [job, stepName, label] of builds) {
      expect(job.steps?.find((step) => step.name === stepName)?.env?.CACHE_ENABLED)
        .toBe('${{ steps.cache.outputs.enabled }}');
      const args = captureDockerBuildArguments(
        cacheBuildCommand(job.steps, stepName),
        false,
        label,
      );
      expect(args).toEqual(expect.arrayContaining(['buildx', 'build', '--load']));
      expect(cachePrefixedArguments(args)).toEqual([]);
    }
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
  });

  it('executes the reusable coverage action through its configured fail-closed boundary', () => {
    const action = parseYaml(readFileSync(join(REPO, '.github/actions/coverage-suite/action.yml'), 'utf8')) as {
      runs: { steps: Array<{ name?: string; run?: string }> };
    };
    const runStep = action.runs.steps.find((step) => step.name === 'Run suite with coverage');
    const fakeBin = join(work, 'bin');
    mkdirSync(fakeBin);
    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(fakeNpm, '#!/bin/sh\nprintf "%s\\n" "$FAKE_NPM_OUTPUT"\nexit "${FAKE_NPM_STATUS:-0}"\n');
    chmodSync(fakeNpm, 0o755);

    const execute = (output: string) => spawnSync('bash', ['-c', runStep?.run ?? ''], {
      cwd: work,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        GITHUB_WORKSPACE: REPO,
        TOLERATE_POOL_CRASH: 'false',
        FAKE_NPM_OUTPUT: output,
        FAKE_NPM_STATUS: '0',
      },
    });

    expect(execute('Test Files  1 passed (1)\n Tests  2 passed (2)').status).toBe(1);
    expect(execute(' All files | 100 | 100 | 100 | 100 |\n Test Files  1 passed (1)\n Tests  2 passed (2)').status).toBe(0);
  });
});

describe('Cloudflare test transport capacity', () => {
  it('enables the larger WebSocket message ceiling for generated payloads', () => {
    expect(CLOUDFLARE_TEST_OPTIONS.miniflare.compatibilityFlags).toContain(
      'increase_websocket_message_size',
    );
  });
});

describe('REQ-OPS-032: SilverBullet coupled-pin automation', () => {
  it('resolves the authoritative release digest through the workflow command boundary', () => {
    const workflow = parseYaml(readFileSync(SHADOW_PINS_WORKFLOW, 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const resolveStep = workflow.jobs.silverbullet.steps?.find(
      (step) => step.name === 'Resolve the latest release and authoritative digest',
    );
    const fixture = join(work, 'silverbullet-resolve');
    const fakeBin = join(fixture, 'bin');
    const output = join(fixture, 'github-output');
    mkdirSync(join(fixture, 'src/routes/vault'), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(fixture, 'Dockerfile'), 'SILVERBULLET_VERSION="2.9.0"');
    writeFileSync(
      join(fixture, 'src/routes/vault/native-sw.ts'),
      '/** SilverBullet 2.9.0 native service worker. */',
    );
    writeFileSync(join(fakeBin, 'gh'), '#!/bin/sh\nprintf \'%s\n\' "$FAKE_RELEASE"\n');
    chmodSync(join(fakeBin, 'gh'), 0o755);
    const digest = `sha256:${'a'.repeat(64)}`;
    const asset = {
      name: 'silverbullet-server-linux-x86_64.zip',
      digest,
      browser_download_url: 'https://example.invalid/silverbullet.zip',
    };
    const execute = (release: unknown, outputPath: string) => spawnSync(
      'bash',
      ['-c', resolveStep?.run ?? ''],
      {
        cwd: fixture,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          GITHUB_OUTPUT: outputPath,
          FAKE_RELEASE: JSON.stringify(release),
        },
      },
    );
    const result = execute({ tag_name: 'v2.10.0', assets: [asset] }, output);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8').trim().split('\n')).toEqual([
      'current=2.9.0',
      'latest=2.10.0',
      `sha256=${'a'.repeat(64)}`,
      'url=https://example.invalid/silverbullet.zip',
    ]);
    expect(execute(
      { tag_name: 'v2.10.0', assets: [{ ...asset, digest: undefined }] },
      join(fixture, 'missing-digest-output'),
    ).status).toBe(1);
  });

  it('updates the Docker pin and vendored worker atomically', () => {
    const dockerfile = [
      'SILVERBULLET_VERSION="2.9.0"',
      'SILVERBULLET_SHA256="old"',
    ].join('\n');
    const nativeWorkerSource = [
      '/** SilverBullet 2.9.0 native service worker. */',
      '/** Drift guard. From SilverBullet 2.9.0. */',
      'export const VAULT_NATIVE_SW_SHA256 = "deadbeef";',
      'export const VAULT_NATIVE_SW_VERBATIM = "old-worker";',
    ].join('\n');
    const worker = 'new Request("/",{cache:"reload"});const replacementTokens="$&-$`-$\'-$${value}"';

    const updated = updateSilverBulletPins(dockerfile, nativeWorkerSource, worker, {
      version: '2.10.0',
      artifactSha256: 'a'.repeat(64),
    });

    expect(updated.dockerfile).toContain('SILVERBULLET_VERSION="2.10.0"');
    expect(updated.dockerfile).toContain(`SILVERBULLET_SHA256="${'a'.repeat(64)}"`);
    expect(updated.nativeWorkerSource).toContain('SilverBullet 2.10.0 native service worker');
    expect(updated.nativeWorkerSource).toContain(JSON.stringify(worker));
    expect(updated.nativeWorkerSource.match(/export const VAULT_NATIVE_SW_VERBATIM/g)).toHaveLength(1);
    expect(updated.nativeWorkerSource).not.toContain('old-worker');
  });

  it('fails closed for malformed release metadata or incomplete pin contracts', () => {
    const nativeWorkerSource = [
      '/** SilverBullet 2.9.0 native service worker. */',
      '/** Drift guard. From SilverBullet 2.9.0. */',
      'export const VAULT_NATIVE_SW_SHA256 = "deadbeef";',
      'export const VAULT_NATIVE_SW_VERBATIM = "old-worker";',
    ].join('\n');
    expect(() => updateSilverBulletPins(
      'SILVERBULLET_VERSION="2.9.0"',
      nativeWorkerSource,
      'new Request("/",{cache:"reload"})',
      { version: '2.10.0', artifactSha256: 'a'.repeat(64) },
    )).toThrow(/SILVERBULLET_SHA256: expected exactly one match/);
    expect(() => updateSilverBulletPins(
      'SILVERBULLET_VERSION="2.9.0"\nSILVERBULLET_SHA256="old"',
      nativeWorkerSource,
      'stale worker',
      { version: 'release prose', artifactSha256: 'not-a-digest' },
    )).toThrow(/release metadata|cache reload/);
  });

  it('executes the updater through its CLI boundary', () => {
    const dockerfile = join(work, 'Dockerfile');
    const nativeWorker = join(work, 'native-sw.ts');
    const worker = join(work, 'service_worker.js');
    writeFileSync(dockerfile, 'SILVERBULLET_VERSION="2.9.0"\nSILVERBULLET_SHA256="old"');
    writeFileSync(nativeWorker, [
      '/** SilverBullet 2.9.0 native service worker. */',
      '/** Drift guard. From SilverBullet 2.9.0. */',
      'export const VAULT_NATIVE_SW_SHA256 = "deadbeef";',
      'export const VAULT_NATIVE_SW_VERBATIM = "old-worker";',
    ].join('\n'));
    writeFileSync(worker, 'new Request("/",{cache:"reload"})');

    const result = spawnSync(process.execPath, [SILVERBULLET_PIN_UPDATER, dockerfile, nativeWorker, worker], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SILVERBULLET_VERSION: '2.10.0',
        SILVERBULLET_SHA256: 'a'.repeat(64),
      },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(dockerfile, 'utf8')).toContain('SILVERBULLET_VERSION="2.10.0"');
    expect(readFileSync(nativeWorker, 'utf8')).toContain(JSON.stringify(readFileSync(worker, 'utf8')));
  });
});

describe('REQ-OPS-027: code-server coupled-pin automation', () => {
  it('derives and cross-checks packaged provenance through the workflow command boundary', () => {
    const workflow = parseYaml(readFileSync(SHADOW_PINS_WORKFLOW, 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const job = workflow.jobs['code-server'];
    const deriveStep = job.steps?.find(
      (step) => step.name === 'Derive code-server pins from the immutable artifact and release tag',
    );
    expect(job).toBeDefined();
    expect(workflow.jobs['openvscode-server']).toBeUndefined();

    const fixture = join(work, 'code-server-resolve');
    const fakeBin = join(fixture, 'bin');
    const archiveRoot = join(fixture, 'archive', 'code-server-4.2.0-linux-amd64');
    const output = join(fixture, 'github-output');
    mkdirSync(join(archiveRoot, 'lib/vscode'), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(join(fixture, 'Dockerfile'), [
      'CODE_SERVER_VERSION="4.1.0"',
      'CODE_SERVER_COMMIT="1111111111111111111111111111111111111111"',
      'CODE_SERVER_CODE_VERSION="1.1.0"',
      'CODE_SERVER_VSCODE_COMMIT="2222222222222222222222222222222222222222"',
    ].join('\n'));
    const packageCommit = '3'.repeat(40);
    const tagCommit = '4'.repeat(40);
    const treeSha = '5'.repeat(40);
    const vscodeCommit = '6'.repeat(40);
    writeFileSync(join(archiveRoot, 'package.json'), JSON.stringify({ version: '4.2.0', commit: packageCommit }));
    writeFileSync(join(archiveRoot, 'lib/vscode/package.json'), JSON.stringify({ version: '1.2.0' }));
    writeFileSync(join(archiveRoot, 'lib/vscode/product.json'), JSON.stringify({
      version: '1.2.0',
      commit: packageCommit,
      codeServerVersion: '4.2.0',
    }));
    const archive = join(fixture, 'code-server-4.2.0-linux-amd64.tar.gz');
    const packArchive = () => spawnSync(
      'tar',
      ['-czf', archive, '-C', join(fixture, 'archive'), 'code-server-4.2.0-linux-amd64'],
      { encoding: 'utf8' },
    );
    const tar = packArchive();
    expect(tar.status, tar.stderr).toBe(0);
    writeFileSync(join(fakeBin, 'gh'), `#!/bin/bash
set -euo pipefail
if [ "$1" = "release" ]; then cp "$FAKE_ARCHIVE" "/tmp/$7"; exit 0; fi
case "$2|\${4:-}" in
  'repos/coder/code-server/releases/latest|.tag_name') echo v4.2.0 ;;
  'repos/coder/code-server/git/ref/tags/v4.2.0|.object.type') echo commit ;;
  'repos/coder/code-server/git/ref/tags/v4.2.0|.object.sha') echo "$FAKE_TAG_COMMIT" ;;
  "repos/coder/code-server/git/commits/$FAKE_TAG_COMMIT|.tree.sha") echo "$FAKE_TREE_SHA" ;;
  "repos/coder/code-server/git/trees/$FAKE_TREE_SHA?recursive=1|"*) echo "$FAKE_VSCODE_COMMIT" ;;
  "repos/microsoft/vscode/contents/package.json?ref=$FAKE_VSCODE_COMMIT|.content") echo "$FAKE_CODE_CONTENT" ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
    chmodSync(join(fakeBin, 'gh'), 0o755);
    const execute = (outputPath: string) => spawnSync('bash', ['-c', deriveStep?.run ?? ''], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        GITHUB_OUTPUT: outputPath,
        FAKE_ARCHIVE: archive,
        FAKE_TAG_COMMIT: tagCommit,
        FAKE_TREE_SHA: treeSha,
        FAKE_VSCODE_COMMIT: vscodeCommit,
        FAKE_CODE_CONTENT: Buffer.from(JSON.stringify({ version: '1.2.0' })).toString('base64'),
      },
    });
    const result = execute(output);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, 'utf8').trim().split('\n')).toEqual([
      'current=4.1.0',
      'latest=4.2.0',
      `commit=${packageCommit}`,
      'code_version=1.2.0',
      `vscode_commit=${vscodeCommit}`,
    ]);

    writeFileSync(join(archiveRoot, 'lib/vscode/product.json'), JSON.stringify({
      version: '1.2.0',
      commit: '7'.repeat(40),
      codeServerVersion: '4.2.0',
    }));
    const mismatchedTar = packArchive();
    expect(mismatchedTar.status, mismatchedTar.stderr).toBe(0);
    expect(execute(join(fixture, 'mismatch-output')).status).toBe(1);
  });

  it('executes the configured workflow step through the updater boundary', () => {
    const workflow = parseYaml(readFileSync(SHADOW_PINS_WORKFLOW, 'utf8')) as {
      jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const applyStep = workflow.jobs['code-server'].steps?.find(
      (step) => step.name === 'Apply bump and invalidate the release checksum',
    );
    const fixture = join(work, 'shadow-pin');
    const fakeBin = join(fixture, 'bin');
    mkdirSync(join(fixture, 'scripts/ci'), { recursive: true });
    mkdirSync(fakeBin);
    copyFileSync(CODE_SERVER_PIN_UPDATER, join(fixture, 'scripts/ci/update-code-server-pins.mjs'));
    writeFileSync(join(fakeBin, 'git'), '#!/bin/sh\n[ "$1" = "diff" ] && exit 1\nexit 0\n');
    chmodSync(join(fakeBin, 'git'), 0o755);
    writeFileSync(join(fixture, 'Dockerfile'), [
      'CODE_SERVER_VERSION="4.1.0"',
      'CODE_SERVER_SHA256="old"',
      'CODE_SERVER_COMMIT="1111111111111111111111111111111111111111"',
      'CODE_SERVER_CODE_VERSION="1.1.0"',
      'CODE_SERVER_VSCODE_COMMIT="2222222222222222222222222222222222222222"',
    ].join('\n'));

    const result = spawnSync('bash', ['-c', applyStep?.run ?? ''], {
      cwd: fixture,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        BRANCH: 'bump/code-server-4.130.0',
        CUR: '4.1.0',
        LAT: '4.130.0',
        GH_TOKEN: 'test-token',
        GITHUB_REPOSITORY: 'example/codeflare',
        CODE_SERVER_VERSION: '4.130.0',
        CODE_SERVER_COMMIT: '3333333333333333333333333333333333333333',
        CODE_SERVER_CODE_VERSION: '1.130.0',
        CODE_SERVER_VSCODE_COMMIT: '4444444444444444444444444444444444444444',
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(join(fixture, 'Dockerfile'), 'utf8')).toContain('CODE_SERVER_VERSION="4.130.0"');
    expect(readFileSync(join(fixture, 'Dockerfile'), 'utf8')).toContain('CODE_SERVER_SHA256="NEEDS_UPDATE_SEE_PR_BODY"');
  });

  it('executes the updater through its CLI boundary', () => {
    const dockerfile = join(work, 'Dockerfile');
    writeFileSync(dockerfile, [
      'CODE_SERVER_VERSION="4.1.0"',
      'CODE_SERVER_SHA256="old"',
      'CODE_SERVER_COMMIT="1111111111111111111111111111111111111111"',
      'CODE_SERVER_CODE_VERSION="1.1.0"',
      'CODE_SERVER_VSCODE_COMMIT="2222222222222222222222222222222222222222"',
    ].join('\n'));

    const result = spawnSync(process.execPath, [CODE_SERVER_PIN_UPDATER, dockerfile], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CODE_SERVER_VERSION: '4.130.0',
        CODE_SERVER_COMMIT: '3333333333333333333333333333333333333333',
        CODE_SERVER_CODE_VERSION: '1.130.0',
        CODE_SERVER_VSCODE_COMMIT: '4444444444444444444444444444444444444444',
      },
    });

    expect(result.status).toBe(0);
    expect(readFileSync(dockerfile, 'utf8')).toContain('CODE_SERVER_SHA256="NEEDS_UPDATE_SEE_PR_BODY"');
    expect(readFileSync(dockerfile, 'utf8')).toContain('CODE_SERVER_CODE_VERSION="1.130.0"');
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

  it('reconciles the single artifact layout emitted directly under the download root', () => {
    const cwd = tree([]);
    const file = 'openvscode/agent-sidebar/test/only.test.ts';
    touch(cwd, file);
    report('browser-ide', 'browser-ide.json', [file]);
    copyFileSync(
      join(work, 'artifacts', 'browser-ide', 'browser-ide.json'),
      join(work, 'artifacts', 'browser-ide.json'),
    );
    rmSync(join(work, 'artifacts', 'browser-ide'), { recursive: true });

    const r = runCompleteness({ 'browser-ide': 'success' }, cwd);
    expect(r.status, r.stderr).toBe(0);
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
