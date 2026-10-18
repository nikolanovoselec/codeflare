import { readFile, writeFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(process.env.BOUNDARY_CLI_FIXTURE, 'utf8'));
const { revision, result, origin, traceFile, fault } = fixture;
let claimed = false;
const trace = { started: [], comparisons: [] };
const record = async () => writeFile(traceFile, JSON.stringify(trace));
await record();
globalThis.fetch = async input => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  if (url.origin === 'https://api.github.com') {
    if (request.headers.get('authorization') !== 'Bearer fixture-job-token') throw Error('GitHub credential contract');
    if (url.pathname === '/repos/owner/repo/pulls/34') return Response.json({ number: 34, state: 'open',
      head: { sha: claimed && fault === 'changed-after-claim' ? 'f'.repeat(40) : revision.head, repo: { id: 138 } },
      base: { sha: revision.base, ref: 'develop', repo: { id: fault === 'foreign-repository' ? 999 : 138 } } });
    if (url.pathname === `/repos/owner/repo/compare/${revision.base}...${revision.head}`) {
      trace.comparisons.push({ base: revision.base, head: revision.head }); await record();
      return Response.json({ merge_base_commit: { sha: fault === 'invalid-ancestry' ? '../foreign' : revision.mergeBase } });
    }
    if (url.pathname === `/repos/owner/repo/commits/${revision.head}/pulls`)
      return Response.json([{ number: 34, state: 'open', head: { sha: revision.head } }]);
    if (url.pathname === '/repos/owner/repo/actions/workflows/boundary-reviews.yml')
      return Response.json({ id: 531, state: 'active' });
  }
  if (url.origin === 'https://oidc.example.test') {
    if (request.headers.get('authorization') !== 'Bearer fixture-oidc-token') throw Error('OIDC credential contract');
    return Response.json({ value: 'fixture.signed.proof' });
  }
  if (['https://dev.example.test', 'https://integration.example.test', 'https://production.example.test'].includes(url.origin)
    && url.pathname.endsWith('/claims/discovery'))
    return Response.json(url.origin === origin ? { status: 'match', contextDigest: 'd'.repeat(64) } : { status: 'no-match' });
  if (url.origin === origin && url.pathname.endsWith('/claims/boundary')) {
    claimed = true;
    return Response.json({ ...revision, runId: 42, runAttempt: 1, workflowId: 531,
      contextDigest: 'd'.repeat(64), generation: 7, activityId: result.activityId,
      origin, startCapability: 's'.repeat(43) });
  }
  if (url.origin === origin && url.pathname.endsWith(`/activities/${result.activityId}/start`)) {
    if (request.headers.get('authorization') !== `Bearer ${'s'.repeat(43)}`) throw Error('Start credential contract');
    trace.started.push({ activityId: result.activityId }); await record();
    return Response.json({ ok: true, phase: 'queued', readCapability: 'r'.repeat(43) });
  }
  if (url.origin === origin && (url.pathname.endsWith('/status') || url.pathname.endsWith('/result'))) {
    if (request.headers.get('authorization') !== `Bearer ${'r'.repeat(43)}`) throw Error('Read credential contract');
    return Response.json({ ok: true, terminal: true, status: 'completed', generation: 1,
      ...(url.pathname.endsWith('/result') ? { result } : {}) });
  }
  throw Error(`Unexpected controlled endpoint ${url.origin}${url.pathname}`);
};
