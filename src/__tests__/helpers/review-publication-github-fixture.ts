import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';

export type ReviewPublicationFault = 'publisher-identity' | 'comment-author' | 'comment-readback-author'
  | 'comment-content' | 'check-app' | 'check-content' | 'artifact-bytes' | 'artifact-run'
  | 'run-workflow' | 'head-association' | 'unavailable';
export const reviewPublicationFaults: ReviewPublicationFault[] = [
  'publisher-identity', 'comment-author', 'comment-readback-author', 'comment-content', 'check-app',
  'check-content', 'artifact-bytes', 'artifact-run', 'run-workflow', 'head-association', 'unavailable',
];

/** External GitHub/Actions wire data only: consumers retain the real identity,
 * authenticated history transport, ZIP decoder and publication reader.
 * The older operator-github-fixture models package acquisition, not PR publication. */
export function createReviewPublicationGitHubFixture(options: {
  currentHead: string; priorHead: string; activityId: string; round: number; token: string;
  finding: { id: string; severity: string; path: string; line: number; message: string; evidence: string };
  extraFindings?: number; longEvidence?: boolean;
}) {
  const repositoryId = 138, pullRequest = 34, workflowId = 531, runId = 7;
  const root = '/repos/owner/repo', base = 'c'.repeat(40);
  const originals = [{ ...options.finding,
    ...(options.longEvidence ? { evidence: 'Caller missing guard. '.repeat(30) } : {}) },
  ...Array.from({ length: options.extraFindings ?? 0 }, (_, index) => ({ ...options.finding, id: `extra-${index}` }))];
  const admission = { repositoryId, pullRequest, activityId: options.activityId, generation: options.round,
    workflowId, runId, runAttempt: 1, packageDigest: 'e'.repeat(64) };
  const binding = { admission, context: { repositoryId, pullRequest, head: options.priorHead, base, mergeBase: base },
    packetDigest: 'd'.repeat(64), activityGeneration: 4, runId, runAttempt: 1 };
  const summary = `Activity ${options.activityId}; complete; ${originals.length} finding(s)`;
  const presentation = { commentBody: `Boundary Reviews findings\n${summary}`,
    check: { name: 'Boundary Reviews (shadow)', conclusion: 'failure', summary } };
  const result = { status: 'complete', activityId: options.activityId, generation: options.round,
    activityGeneration: 4, repositoryId, pullRequest, head: options.priorHead,
    packageDigest: admission.packageDigest, cleanup: 'stopped',
    originalReports: ['code-reviewer', 'spec-reviewer', 'doc-updater'].map(lane => ({ schemaVersion: 1,
      lane, packetDigest: binding.packetDigest, generation: options.round, head: options.priorHead,
      complete: true, omissions: [], findings: lane === 'code-reviewer' ? originals : [] })),
    history: { clear: false, coverageAdvanced: true, findings: originals, rebuttals: [] }, presentation };
  const digest = createHash('sha256').update(JSON.stringify({ binding, result })).digest('hex');
  const marker = `review-${repositoryId}-${pullRequest}-${options.activityId}-generation-${options.round}:${digest}`;
  const artifact = { marker, digest, binding, result };
  const comment = { id: 501, user: { id: 777 }, issue_url: `https://api.github.com${root}/issues/34`,
    body: `<!-- codeflare-review:${marker} -->\n${presentation.commentBody}\n`
      + JSON.stringify({ head: options.priorHead, artifactDigest: digest }) };
  const check = { id: 601, app: { id: 888 }, name: presentation.check.name, head_sha: options.priorHead,
    external_id: marker, status: 'completed', conclusion: 'failure',
    output: { title: presentation.check.name, summary } };
  const signed = 'https://objects.actions.githubusercontent.com/review.zip?signature=canned';
  let fault: ReviewPublicationFault | undefined;
  const requests: Request[] = [];
  const fetcher = async (request: Request): Promise<Response> => {
    requests.push(request.clone());
    const url = new URL(request.url), path = url.pathname;
    if (request.method !== 'GET') throw Error('Read-only publication request attempted a write');
    if (url.href === signed) {
      if (request.headers.has('authorization') || request.headers.has('cookie')
        || request.headers.has('cf-access-jwt-assertion')) throw Error('Authority reached signed artifact');
      const wire = fault === 'artifact-bytes'
        ? { ...artifact, result: { ...result, head: '9'.repeat(40) } } : artifact;
      return new Response(Uint8Array.from(zipSync({ 'review.json': strToU8(JSON.stringify(wire)) }, { level: 0 })));
    }
    if (url.origin !== 'https://api.github.com') throw Error('Unexpected publication transport origin');
    if (request.headers.get('authorization') !== `Bearer ${options.token}`
      || request.redirect !== 'manual') return Response.json({ message: 'Unauthorized' }, { status: 403 });
    if (fault === 'unavailable') return Response.json({ message: 'Forbidden' }, { status: 403 });
    if (path === '/users/github-actions%5Bbot%5D')
      return Response.json({ id: 777, login: 'github-actions[bot]', type: 'Bot' });
    if (path === '/apps/github-actions')
      return Response.json({ id: 888, slug: fault === 'publisher-identity' ? 'untrusted' : 'github-actions' });
    if (path === root) return Response.json({ id: repositoryId, permissions: { pull: true } });
    if (path === `${root}/pulls/34`) return Response.json({ number: 34, state: 'open',
      head: { sha: options.currentHead, repo: { id: repositoryId } },
      base: { sha: base, ref: 'main', repo: { id: repositoryId } } });
    if (path === `${root}/commits/${options.priorHead}/pulls`)
      return Response.json([{ number: fault === 'head-association' ? 35 : 34 }]);
    if (path === `${root}/issues/34/comments`) return Response.json(url.searchParams.get('page') === '1'
      ? [{ ...comment, user: { id: fault === 'comment-author' ? 999 : 777 } }] : []);
    if (path === `${root}/issues/comments/501`) return Response.json({ ...comment,
      user: { id: fault === 'comment-readback-author' ? 999 : 777 },
      body: fault === 'comment-content' ? `${comment.body}\nForged finding` : comment.body });
    if (path === `${root}/actions/artifacts`) return Response.json({ total_count: 1,
      artifacts: [{ id: 701, name: `boundary-review-${digest}` }] });
    if (path === `${root}/actions/artifacts/701`) return Response.json({ id: 701, expired: false,
      workflow_run: { id: fault === 'artifact-run' ? 8 : runId, repository_id: repositoryId, head_sha: base } });
    if (path === `${root}/actions/runs/7` || fault === 'artifact-run' && path === `${root}/actions/runs/8`)
      return Response.json({ id: Number(path.split('/').at(-1)), run_attempt: 1,
      workflow_id: fault === 'run-workflow' ? 532 : workflowId, head_sha: base,
      repository: { id: repositoryId }, event: 'pull_request_target', pull_requests: [{ number: 34 }] });
    if (path === `${root}/actions/artifacts/701/zip`)
      return new Response(null, { status: 302, headers: { location: signed } });
    if (path === `${root}/commits/${options.priorHead}/check-runs`)
      return Response.json({ total_count: 1, check_runs: [check] });
    if (path === `${root}/check-runs/601`) return Response.json({ ...check,
      app: { id: fault === 'check-app' ? 999 : 888 },
      output: fault === 'check-content' ? { ...check.output, summary: 'Forged summary' } : check.output });
    return Response.json({ message: 'Not found' }, { status: 404 });
  };
  return { fetcher, requests, digest, setFault: (value?: ReviewPublicationFault) => { fault = value; } };
}
