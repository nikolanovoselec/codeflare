import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

  if (receipt?.repository !== expected.repo) throw new Error('Verification receipt repository mismatch');
  if (String(receipt?.runId) !== expected.runId) throw new Error('Verification receipt run id mismatch');
  if (!SHA_PATTERN.test(receipt?.testedCommit ?? '')) throw new Error('Verification receipt commit is malformed');
  if (receipt?.testedTree !== expected.tree) throw new Error('Verification receipt tree does not match deploy tree');
}

function ghApi(repo, endpoint) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${endpoint}`], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }));
}

function main() {
  const [runId, repo, sha, tree, receiptPath] = process.argv.slice(2);
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
