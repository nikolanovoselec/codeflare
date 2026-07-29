import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DOMAIN = 'browser-ide-image-v1:linux/amd64';
const CONTRACT_DOMAIN = 'browser-ide-reuse-contract-v1';
const CONTRACT_PATHS = new Set([
  '.github/workflows/test.yml',
  'scripts/ci/browser-ide-image-reuse.mjs',
]);
const IMAGE_EXACT_PATHS = new Set([
  '.cache-bust',
  '.dockerignore',
  'Dockerfile',
  'entrypoint.sh',
  'host/package-lock.json',
  'host/package.json',
  'host/tsconfig.json',
  'scripts/browser-ide-ui-state.py',
  'scripts/ci/smoke-openvscode-sidebar-image.mjs',
  'scripts/materialize-agent-seed.mjs',
  'scripts/patch-context-mode-bundles.mjs',
  'src/lib/agent-seed.generated.ts',
]);

export function isBrowserIdeImageInput(path) {
  if (IMAGE_EXACT_PATHS.has(path)) return true;
  if (path === 'host/src' || path.startsWith('host/src/')) return true;
  if (path === 'preseed' || path.startsWith('preseed/')) return true;
  if (path === 'openvscode') return true;
  if (path.startsWith('openvscode/')) {
    return path !== 'openvscode/README.md'
      && !path.includes('/test/')
      && !path.includes('/__tests__/');
  }
  return false;
}

function logicalDockerfileLines(source) {
  const lines = [];
  let logical = '';
  for (const physical of source.split(/\r?\n/)) {
    logical += physical;
    if (/\\\s*$/.test(logical)) {
      logical = logical.replace(/\\\s*$/, ' ');
      continue;
    }
    lines.push(logical.trim());
    logical = '';
  }
  if (logical.trim()) lines.push(logical.trim());
  return lines;
}

export function uncoveredDockerfileSources(source) {
  const uncovered = new Set();
  for (const line of logicalDockerfileLines(source)) {
    const match = line.match(/^(?:COPY|ADD)\s+(.+)$/i);
    if (!match) continue;
    const words = match[1].trim().split(/\s+/);
    if (words.some((word) => word.startsWith('--from'))) continue;
    while (words[0]?.startsWith('--')) words.shift();
    if (words.length < 2 || words[0].startsWith('[')) {
      uncovered.add('<unparsed-copy-source>');
      continue;
    }
    for (const raw of words.slice(0, -1)) {
      const path = raw.replace(/^\.\//, '').replace(/\/$/, '');
      if (!isBrowserIdeImageInput(path)
        && ![...IMAGE_EXACT_PATHS].some((exact) => path === exact || exact.startsWith(`${path}/`))) {
        uncovered.add(path);
      }
    }
  }
  return [...uncovered].sort();
}

function isReuseContractInput(path) {
  return CONTRACT_PATHS.has(path);
}

function normalizedEntry(entry) {
  if (
    !entry
    || typeof entry.path !== 'string'
    || typeof entry.mode !== 'string'
    || typeof entry.type !== 'string'
    || !/^[0-9a-f]{40,64}$/.test(entry.sha ?? '')
  ) throw new Error('Git tree contains a malformed entry');
  return `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}`;
}

export function fingerprintEntries(entries, includes, domain) {
  if (!Array.isArray(entries) || typeof includes !== 'function' || !domain) {
    throw new Error('Fingerprint inputs are invalid');
  }
  const selected = entries
    .filter((entry) => includes(entry?.path))
    .map(normalizedEntry)
    .sort();
  if (selected.length === 0) throw new Error(`Fingerprint ${domain} selected no files`);
  return createHash('sha256').update(`${domain}\0${selected.join('\0')}\0`).digest('hex');
}

function parseGitTree(raw) {
  return raw.split('\0').filter(Boolean).map((line) => {
    const match = line.match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/s);
    if (!match) throw new Error('git ls-tree returned a malformed entry');
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] };
  });
}

function localTreeEntries(ref = 'HEAD') {
  return parseGitTree(execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', ref], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  }));
}

function requirePaths(entries, paths, label) {
  const present = new Set(entries.map((entry) => entry.path));
  const missing = [...paths].filter((path) => !present.has(path));
  if (missing.length > 0) throw new Error(`${label} is missing required files: ${missing.join(', ')}`);
}

function currentFingerprints(ref = 'HEAD', freshness = '') {
  const entries = localTreeEntries(ref);
  requirePaths(entries, IMAGE_EXACT_PATHS, 'Browser IDE image fingerprint');
  requirePaths(entries, CONTRACT_PATHS, 'Browser IDE reuse contract');
  const uncovered = uncoveredDockerfileSources(readFileSync('Dockerfile', 'utf8'));
  return {
    image: fingerprintEntries(
      entries,
      isBrowserIdeImageInput,
      `${IMAGE_DOMAIN}:${freshness || 'unsalted'}`,
    ),
    contract: fingerprintEntries(entries, isReuseContractInput, CONTRACT_DOMAIN),
    reuseSafe: uncovered.length === 0,
    uncovered,
  };
}

export function validateBrowserIdeImageEvidence(candidate, expected) {
  if (!RUN_ID_PATTERN.test(expected?.runId ?? '')) throw new Error('Candidate run id must be numeric');
  if (!RUN_ID_PATTERN.test(expected?.pr ?? '')) throw new Error('Pull request number must be numeric');
  if (!FINGERPRINT_PATTERN.test(expected?.fingerprint ?? '')) throw new Error('Image fingerprint is malformed');
  if (!FINGERPRINT_PATTERN.test(expected?.contractFingerprint ?? '')) {
    throw new Error('Reuse contract fingerprint is malformed');
  }

  const { run, jobs: jobsResponse, receipt, contractFingerprint } = candidate ?? {};
  if (String(run?.id) !== expected.runId) throw new Error('Candidate run identity mismatch');
  if (run?.status !== 'completed' || run?.conclusion !== 'success') {
    throw new Error('Candidate PR Checks run is not completed successfully');
  }
  if (run?.event !== 'pull_request') throw new Error('Candidate is not a pull request run');
  if (run?.path !== '.github/workflows/test.yml') throw new Error('Candidate is not the PR Checks workflow');
  if (run?.head_repository?.full_name !== expected.repo) {
    throw new Error('Candidate run belongs to another repository');
  }
  if (!Array.isArray(run?.pull_requests)
    || !run.pull_requests.some((item) => String(item?.number) === expected.pr)) {
    throw new Error('Candidate run belongs to another pull request');
  }
  if (contractFingerprint !== expected.contractFingerprint) {
    throw new Error('Candidate workflow reuse contract changed');
  }

  const jobs = Array.isArray(jobsResponse?.jobs) ? jobsResponse.jobs : [];
  if (jobsResponse?.total_count !== jobs.length) throw new Error('Candidate jobs response is incomplete');
  if (!jobs.some((job) => job?.name === 'test' && job?.conclusion === 'success')) {
    throw new Error('Candidate required summary is not successful');
  }
  if (!jobs.some((job) => job?.name === 'Browser IDE complete image' && job?.conclusion === 'success')) {
    throw new Error('Candidate complete-image job did not execute successfully');
  }

  if (receipt?.schema !== 'codeflare.pr-checks-receipt.v2') {
    throw new Error('Candidate receipt schema mismatch');
  }
  if (receipt?.repository !== expected.repo) throw new Error('Candidate receipt repository mismatch');
  if (receipt?.workflowPath !== '.github/workflows/test.yml') {
    throw new Error('Candidate receipt workflow mismatch');
  }
  if (String(receipt?.runId) !== expected.runId) throw new Error('Candidate receipt run id mismatch');
  if (!Number.isInteger(run?.run_attempt) || receipt?.runAttempt !== run.run_attempt) {
    throw new Error('Candidate receipt run attempt mismatch');
  }
  if (!SHA_PATTERN.test(receipt?.testedCommit ?? '') || !SHA_PATTERN.test(receipt?.testedTree ?? '')) {
    throw new Error('Candidate receipt commit or tree is malformed');
  }
  const lane = receipt?.lanes?.browserIdeImage;
  if (lane?.fingerprint !== expected.fingerprint) throw new Error('Candidate image fingerprint changed');
  if (lane?.result !== 'executed') throw new Error('Candidate image evidence is not a direct execution');
  if (String(lane?.sourceRunId) !== expected.runId) throw new Error('Candidate image source run mismatch');
}

export function resolveReusableBrowserIdeImageRun(
  candidateRunIds,
  expected,
  loadEvidence,
  onReject = () => {},
) {
  for (const runId of candidateRunIds) {
    try {
      const candidate = loadEvidence(runId);
      validateBrowserIdeImageEvidence(candidate, { ...expected, runId });
      return { reused: true, runId };
    } catch (error) {
      onReject(runId, error);
    }
  }
  return { reused: false };
}

export function browserIdeImageGate({ relevant, resolverResult, reused, imageResult }) {
  if (typeof relevant !== 'boolean' || typeof reused !== 'boolean') {
    throw new Error('Browser IDE image gate booleans are invalid');
  }
  if (resolverResult !== 'success') throw new Error('Browser IDE image reuse resolver did not succeed');
  if (!relevant) {
    if (reused || imageResult !== 'skipped') {
      throw new Error('Unaffected Browser IDE image lane produced an invalid result');
    }
    return;
  }
  if (reused) {
    if (imageResult !== 'skipped') throw new Error('Reused Browser IDE image lane also executed');
    return;
  }
  if (imageResult !== 'success') {
    throw new Error('Relevant Browser IDE image lane neither executed nor reused valid evidence');
  }
}

function ghApi(repo, endpoint) {
  return JSON.parse(execFileSync('gh', ['api', `repos/${repo}/${endpoint}`], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  }));
}

function discoverCandidateRunIds(repo, pr, currentRunId) {
  const response = ghApi(
    repo,
    'actions/workflows/test.yml/runs?event=pull_request&status=success&per_page=100',
  );
  if (!Array.isArray(response?.workflow_runs)) {
    throw new Error('PR Checks run enumeration returned an invalid response');
  }
  const candidates = response.workflow_runs
    .filter((item) => String(item?.id) !== currentRunId)
    .filter((item) => Array.isArray(item?.pull_requests)
      && item.pull_requests.some((pull) => String(pull?.number) === pr))
    .map((item) => ({ runId: String(item.id), createdAt: Date.parse(item.created_at) }))
    .filter((item) => RUN_ID_PATTERN.test(item.runId) && Number.isFinite(item.createdAt))
    .sort((left, right) => right.createdAt - left.createdAt);
  return [...new Set(candidates.map((item) => item.runId))];
}

function candidateContractFingerprint(repo, headSha) {
  if (!SHA_PATTERN.test(headSha ?? '')) throw new Error('Candidate head commit is malformed');
  const commit = ghApi(repo, `git/commits/${headSha}`);
  if (!SHA_PATTERN.test(commit?.tree?.sha ?? '')) throw new Error('Candidate Git tree is malformed');
  const response = ghApi(repo, `git/trees/${commit.tree.sha}?recursive=1`);
  if (response?.truncated !== false || !Array.isArray(response?.tree)) {
    throw new Error('Candidate Git tree response is incomplete');
  }
  requirePaths(response.tree, CONTRACT_PATHS, 'Candidate Browser IDE reuse contract');
  return fingerprintEntries(response.tree, isReuseContractInput, CONTRACT_DOMAIN);
}

function loadCandidateEvidence(repo, runId) {
  const root = mkdtempSync(join(tmpdir(), `browser-ide-image-${runId}-`));
  try {
    execFileSync('gh', [
      'run', 'download', runId,
      '--repo', repo,
      '--name', `pr-checks-receipt-${runId}`,
      '--dir', root,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const run = ghApi(repo, `actions/runs/${runId}`);
    return {
      run,
      jobs: ghApi(repo, `actions/runs/${runId}/jobs?per_page=100`),
      receipt: JSON.parse(readFileSync(join(root, 'pr-checks-receipt.json'), 'utf8')),
      contractFingerprint: candidateContractFingerprint(repo, run.head_sha),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function resolve(repo, pr, fingerprint, contractFingerprint, currentRunId) {
  if (
    !repo
    || !RUN_ID_PATTERN.test(pr ?? '')
    || !FINGERPRINT_PATTERN.test(fingerprint ?? '')
    || !FINGERPRINT_PATTERN.test(contractFingerprint ?? '')
    || !RUN_ID_PATTERN.test(currentRunId ?? '')
  ) {
    throw new Error(
      'Usage: browser-ide-image-reuse.mjs resolve <repo> <pr> <fingerprint> <contract-fingerprint> <current-run-id>',
    );
  }
  const candidates = discoverCandidateRunIds(repo, pr, currentRunId);
  return resolveReusableBrowserIdeImageRun(
    candidates,
    { repo, pr, fingerprint, contractFingerprint },
    (runId) => loadCandidateEvidence(repo, runId),
    (runId, error) => process.stderr.write(
      `Skipping Browser IDE image evidence from run ${runId}: ${error instanceof Error ? error.message : String(error)}\n`,
    ),
  );
}

function parseBoolean(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be true or false`);
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'fingerprint') {
    const [ref = 'HEAD', freshness = ''] = args;
    process.stdout.write(`${JSON.stringify(currentFingerprints(ref, freshness))}\n`);
    return;
  }
  if (command === 'resolve') {
    process.stdout.write(`${JSON.stringify(resolve(...args))}\n`);
    return;
  }
  if (command === 'gate') {
    const [full, ide, resolverResult, reused, imageResult] = args;
    browserIdeImageGate({
      relevant: parseBoolean(full, 'full') || parseBoolean(ide, 'ide'),
      resolverResult,
      reused: parseBoolean(reused, 'reused'),
      imageResult,
    });
    process.stdout.write('Browser IDE complete-image lane is verified\n');
    return;
  }
  throw new Error('Usage: browser-ide-image-reuse.mjs <fingerprint|resolve|gate> ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
