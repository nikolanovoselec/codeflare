import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const RUN_ID_PATTERN = /^[1-9][0-9]*$/;

export function validatePrChecksRun(run, jobsResponse, receipt, expected) {
  if (!RUN_ID_PATTERN.test(expected.runId)) throw new Error('PR Checks run id must be numeric');
  if (!SHA_PATTERN.test(expected.sha) || !SHA_PATTERN.test(expected.tree)) {
    throw new Error('Expected commit and tree must be full Git SHAs');
  }
  if (run?.status !== 'completed' || run?.conclusion !== 'success') {
    throw new Error('PR Checks run is not completed successfully');
  }
  if (run?.head_sha !== expected.sha) throw new Error('PR Checks run head does not match deploy head');
  if (run?.head_repository?.full_name !== expected.repo) throw new Error('PR Checks run belongs to another repository');
  if (run?.path !== '.github/workflows/test.yml') throw new Error('Run is not the PR Checks workflow');

  const jobs = Array.isArray(jobsResponse?.jobs) ? jobsResponse.jobs : [];
  if (jobsResponse?.total_count !== jobs.length) throw new Error('PR Checks jobs response is incomplete');
  if (!jobs.some((job) => job?.name === 'test' && job?.conclusion === 'success')) {
    throw new Error('Required test summary is not successful');
  }

  if (receipt?.schema !== 'codeflare.pr-checks-receipt.v3') throw new Error('Verification receipt schema mismatch');
  if (receipt?.workflowPath !== '.github/workflows/test.yml') throw new Error('Verification receipt workflow mismatch');
  if (!Number.isInteger(receipt?.runAttempt) || receipt.runAttempt < 1) throw new Error('Verification receipt attempt is invalid');
  if (receipt?.repository !== expected.repo) throw new Error('Verification receipt repository mismatch');
  if (String(receipt?.runId) !== expected.runId) throw new Error('Verification receipt run id mismatch');
  if (!SHA_PATTERN.test(receipt?.testedCommit ?? '')) throw new Error('Verification receipt commit is malformed');
  if (receipt?.testedTree !== expected.tree) throw new Error('Verification receipt tree does not match deploy tree');
}

export function resolveReusablePrChecksRun(candidateRunIds, explicitRunId, expected, loadEvidence, onReject = () => {}) {
  if (explicitRunId && !RUN_ID_PATTERN.test(explicitRunId)) {
    throw new Error('PR Checks run id must be numeric');
  }
  const runIds = explicitRunId ? [explicitRunId] : candidateRunIds;
  for (const runId of runIds) {
    try {
      const { run, jobs, receipt } = loadEvidence(runId);
      validatePrChecksRun(run, jobs, receipt, { ...expected, runId });
      return { verified: true, runId };
    } catch (error) {
      if (explicitRunId) throw error;
      onReject(runId, error);
    }
  }
  return { verified: false };
}

function ghApi(repo, endpoint) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${endpoint}`], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }));
}

function discoverSuccessfulRunIds(repo, sha) {
  const pages = JSON.parse(execFileSync('gh', [
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/actions/workflows/test.yml/runs?head_sha=${sha}&status=success&per_page=100`,
  ], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  }));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page?.workflow_runs))) {
    throw new Error('PR Checks run enumeration returned an invalid response');
  }
  const candidates = pages
    .flatMap((page) => page.workflow_runs)
    .filter((run) => run?.head_sha === sha)
    .map((run) => ({ runId: String(run.id), createdAt: Date.parse(run.created_at) }))
    .filter((run) => RUN_ID_PATTERN.test(run.runId) && Number.isFinite(run.createdAt))
    .sort((left, right) => right.createdAt - left.createdAt);
  return [...new Set(candidates.map((run) => run.runId))];
}

function loadRunEvidence(repo, runId) {
  const receiptRoot = mkdtempSync(join(tmpdir(), `pr-checks-${runId}-`));
  try {
    execFileSync('gh', [
      'run', 'download', runId,
      '--repo', repo,
      '--name', `pr-checks-receipt-${runId}`,
      '--dir', receiptRoot,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    return {
      run: ghApi(repo, `actions/runs/${runId}`),
      jobs: ghApi(repo, `actions/runs/${runId}/jobs?per_page=100`),
      receipt: JSON.parse(readFileSync(join(receiptRoot, 'pr-checks-receipt.json'), 'utf8')),
    };
  } finally {
    rmSync(receiptRoot, { recursive: true, force: true });
  }
}

function resolve(repo, sha, tree, explicitRunId = '') {
  if (!repo || !SHA_PATTERN.test(sha ?? '') || !SHA_PATTERN.test(tree ?? '')) {
    throw new Error('Usage: validate-pr-checks-run.mjs resolve <repo> <sha> <tree> [run-id]');
  }
  const candidates = explicitRunId ? [] : discoverSuccessfulRunIds(repo, sha);
  return resolveReusablePrChecksRun(
    candidates,
    explicitRunId,
    { repo, sha, tree },
    (runId) => loadRunEvidence(repo, runId),
    (runId, error) => process.stderr.write(
      `Skipping PR Checks run ${runId}: ${error instanceof Error ? error.message : String(error)}\n`,
    ),
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'resolve') {
    const [, repo, sha, tree, explicitRunId = ''] = args;
    process.stdout.write(`${JSON.stringify(resolve(repo, sha, tree, explicitRunId))}\n`);
    return;
  }

  const [runId, repo, sha, tree, receiptPath] = args;
  if (!runId || !repo || !sha || !tree || !receiptPath) {
    throw new Error('Usage: validate-pr-checks-run.mjs <run-id> <repo> <sha> <tree> <receipt-path>');
  }
  if (!RUN_ID_PATTERN.test(runId)) throw new Error('PR Checks run id must be numeric');
  const run = ghApi(repo, `actions/runs/${runId}`);
  const jobs = ghApi(repo, `actions/runs/${runId}/jobs?per_page=100`);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  validatePrChecksRun(run, jobs, receipt, { runId, repo, sha, tree });
  process.stdout.write(`Validated PR Checks run ${runId} for ${sha} (tree ${tree})\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
