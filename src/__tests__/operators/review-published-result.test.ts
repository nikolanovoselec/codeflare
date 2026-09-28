import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readPublishedReview } from '../../operators/review-history-transport';
import { registerOperatorReviewRemote } from '../../../preseed/agents/pi/extensions/operator-review-remote';
import { collectBoundaryResult, publishBoundaryResult } from '../../../scripts/operator-boundary-action.mjs';

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const head = 'a'.repeat(40), currentHead = 'b'.repeat(40), base = 'c'.repeat(40);
const finding = { id: 'code-reviewer-guard', severity: 'HIGH', path: 'src/guard.ts', line: 12,
  message: 'Authorization check missing', evidence: 'A caller reaches the write before the guard.' };
const reports = ['code-reviewer', 'spec-reviewer', 'doc-updater'].map(lane => ({ schemaVersion: 1,
  lane, packetDigest: 'd'.repeat(64), generation: 2, head, complete: true, omissions: [],
  findings: lane === 'code-reviewer' ? [finding] : [] }));
const admission = { repositoryId: 138, pullRequest: 34, activityId: 'review-activity', generation: 2,
  workflowId: 531, runId: 7, runAttempt: 1, packageDigest: 'e'.repeat(64),
  inputDigest: '1'.repeat(64), resourceDigest: '2'.repeat(64), policyDigest: '3'.repeat(64) };
const context = { repositoryId: 138, pullRequest: 34, head, base, mergeBase: base };
const presentation = { commentBody: 'Boundary Reviews findings\nActivity review-activity; complete; 1 finding(s)',
  check: { name: 'Boundary Reviews (shadow)', conclusion: 'failure',
    summary: 'Activity review-activity; complete; 1 finding(s)' } };
function fixture(change: { artifact?: (artifact: any) => void; comment?: (comment: any) => void;
  check?: (check: any) => void; run?: (run: any) => void; list?: (items: any[]) => void;
  identity?: { commentAuthorId: number; checkAppId: number }; current?: boolean;
  extraFindings?: number; longEvidence?: string;
  published?: { artifact: any; comment: any; check: any } } = {}) {
  const result = { status: 'complete', activityId: 'review-activity', generation: 2,
    activityGeneration: 4, repositoryId: 138, pullRequest: 34, head,
    packageDigest: admission.packageDigest, manifestDigest: '4'.repeat(64), cleanup: 'stopped',
    originalReports: structuredClone(reports), history: { findings: [{ ...finding, lane: 'code-reviewer' }],
      clear: false, coverageAdvanced: true, rebuttals: [] }, presentation };
  if (change.longEvidence) {
    result.originalReports[0].findings[0].evidence = change.longEvidence;
    result.history.findings[0].evidence = change.longEvidence;
  }
  for (let n = 0; n < (change.extraFindings ?? 0); n++) {
    const added = { ...finding, id: `code-reviewer-more-${n}` };
    result.originalReports[0].findings.push(added);
    result.history.findings.push({ ...added, lane: 'code-reviewer' });
  }
  const binding = { admission, context, packetDigest: 'd'.repeat(64), activityGeneration: 4,
    runId: 7, runAttempt: 1 };
  const digest = sha({ binding, result });
  const marker = `review-138-34-review-activity-generation-2:${digest}`;
  const artifact = structuredClone(change.published?.artifact ?? { marker, digest, binding, result });
  const comment = structuredClone(change.published?.comment ?? { id: 501, user: { id: 777 }, issue_url: 'https://api.github.com/repos/owner/repo/issues/34',
    body: `<!-- codeflare-review:${marker} -->\n${presentation.commentBody}\n${JSON.stringify({ head, artifactDigest: digest })}` });
  const check = structuredClone(change.published?.check ?? { id: 601, app: { id: 888 }, name: presentation.check.name, head_sha: head,
    external_id: marker, status: 'completed', conclusion: 'failure',
    output: { title: presentation.check.name, summary: presentation.check.summary } });
  const run = { id: 7, run_attempt: 1, workflow_id: 531, repository: { id: 138 },
    event: 'pull_request_target', pull_requests: [{ number: 34 }] };
  const artifacts = [{ id: 701, name: `boundary-review-${artifact.digest}` }];
  change.artifact?.(artifact); change.comment?.(comment); change.check?.(check);
  change.run?.(run); change.list?.(artifacts);
  const operations: string[] = [];
  const history = { read: async (request: any) => {
    operations.push(request.operation);
    if (change.current === false) return { complete: false };
    const values: Record<string, unknown> = {
      repository: { id: 138, permissions: { pull: true } },
      'pr-context': { number: 34, state: 'open', head: { sha: currentHead, repo: { id: 138 } },
        base: { sha: base, repo: { id: 138 } } },
      'head-association': { head, pullRequest: 34 },
      'comments-page': request.page === 1 ? [comment] : [], comment,
      'artifact-list': request.page === 1 ? artifacts : [],
      artifact: { id: 701, runId: 7, bytes: Buffer.from(JSON.stringify(artifact)).toString('base64') },
      run, 'checks-page': { total_count: 1, check_runs: [check] }, check,
    };
    return request.operation in values ? { complete: true, value: values[request.operation] } : { complete: false };
  } };
  const read = (scope: Partial<{ repositoryId: number; pullRequest: number; activityId: string;
    head: string; trustedWorkflowId: number }> = {}) => readPublishedReview({ repositoryId: 138, pullRequest: 34,
      activityId: 'review-activity', trustedWorkflowId: 531, head, history,
      publisher: change.identity ?? { commentAuthorId: 777, checkAppId: 888 }, ...scope });
  return { read, operations, marker: artifact.marker, digest: artifact.digest };
}

describe('REQ-OPERATOR-053/056: independently published original Review evidence', () => {
  it('REQ-OPERATOR-053/056: carries actual published three-lane evidence through authenticated history into the Pi branch after exact-head CI', async () => {
    const result = { status: 'complete', activityId: admission.activityId, generation: admission.generation,
      activityGeneration: 4, repositoryId: 138, pullRequest: 34, head,
      packageDigest: admission.packageDigest, manifestDigest: '4'.repeat(64), cleanup: 'stopped',
      originalReports: structuredClone(reports), history: { findings: [{ ...finding, lane: 'code-reviewer' }],
        clear: false, coverageAdvanced: true, rebuttals: [] }, presentation };
    const binding = { admission, context, packetDigest: 'd'.repeat(64), activityGeneration: 4,
      runId: 7, runAttempt: 1 };
    const produced: { artifact?: any; comment?: any; check?: any } = {};
    const rows: { comments: any[]; checks: any[]; artifacts: any[] } = {
      comments: [], checks: [], artifacts: [],
    };
    const json = (value: unknown) => new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json' },
    });
    const collected = await collectBoundaryResult({ origin: 'https://enterprise.example.test',
      activityId: admission.activityId, startCapability: 's'.repeat(43) }, {
      fetch: async (request: Request) => {
        const operation = new URL(request.url).pathname.split('/').at(-1);
        if (operation === 'start') return json({ ok: true, phase: 'queued', readCapability: 'r'.repeat(43) });
        if (operation === 'status') return json({ ok: true, terminal: true,
          status: 'completed', generation: 4 });
        if (operation === 'result') return json({ ok: true, terminal: true,
          status: 'completed', generation: 4, result });
        throw new Error('Unexpected protected Activity operation');
      }, now: () => 0,
    });
    expect(collected).toMatchObject({ status: 'collected', activityId: admission.activityId,
      activityGeneration: 4 });
    if (collected.status !== 'collected') throw new Error('Protected result was not collected');
    expect(collected.result.originalReports[0].findings).toEqual([finding]);
    const publication = await publishBoundaryResult(
      collected,
      { activityId: admission.activityId, generation: 4, repositoryId: 138, pullRequest: 34,
        head, packageDigest: admission.packageDigest, resultDigest: sha(result) },
      { activityGeneration: 4, binding, runId: 7, runAttempt: 1,
        ledger: { current: async () => ({ activityId: admission.activityId, generation: 4,
          repositoryId: 138, pullRequest: 34, head, base, mergeBase: base }),
        effect: async (request: any) => request.operation === 'begin'
          ? { status: 'new' } : { status: 'published', externalId: request.externalId } },
        artifact: {
          list: async () => rows.artifacts,
          read: async (id: number) => rows.artifacts.find(row => row.id === id),
          upload: async (body: any) => { produced.artifact = body;
            const row = { id: 701, name: `boundary-review-${body.digest}`, body };
            rows.artifacts.push(row); return row; },
        },
        github: { origin: 'https://api.github.com', repository: 'owner/repo', token: 'test-token',
          commentAuthorId: 777, checkAppId: 888,
          fetch: async (request: Request) => {
            const url = new URL(request.url);
            if (request.method === 'POST') {
              const body = await request.json() as any;
              if (url.pathname.endsWith('/comments')) {
                produced.comment = { id: 501, user: { id: 777 },
                  issue_url: 'https://api.github.com/repos/owner/repo/issues/34', ...body };
                rows.comments.push(produced.comment); return json(produced.comment);
              }
              produced.check = { id: 601, app: { id: 888 }, ...body };
              rows.checks.push(produced.check); return json(produced.check);
            }
            if (url.pathname.endsWith('/comments')) return json(rows.comments);
            if (url.pathname.endsWith('/check-runs')) return json({ total_count: rows.checks.length,
              check_runs: rows.checks });
            return json([...rows.comments, ...rows.checks].find(row => url.pathname.endsWith(`/${row.id}`)));
          } },
      },
    );
    expect(publication).toMatchObject({ status: 'published' });
    const history = fixture({ published: produced as { artifact: any; comment: any; check: any } });
    const authenticated = await history.read();
    expect(authenticated).toMatchObject({ status: 'published', artifactDigest: produced.artifact.digest,
      findings: [{ ...finding, lane: 'code-reviewer' }] });
    const branch: any[] = [], messages: any[] = [], selected: any[] = [];
    let observedHead = head;
    const handlers = new Map<string, (event: any, context: any) => Promise<void>>();
    const pi = { on: (name: string, callback: (event: any, context: any) => Promise<void>) => {
      handlers.set(name, callback); return () => handlers.delete(name);
    }, sendMessage: (message: any) => { messages.push(message); branch.push({ type: 'custom_message', ...message }); },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }) };
    registerOperatorReviewRemote(pi as never, {
      currentBoundary: async () => ({ repository: 'owner/repo', repositoryId: 138,
        pullRequest: 34, head: observedHead, repo: '/workspace/repo' }),
      selectBoundary: async (boundary: any) => { selected.push(boundary);
        return { mode: 'remote', activityId: admission.activityId }; },
      readPublishedResult: async () => history.read(),
    });
    const piContext = { cwd: '/workspace/repo', sessionManager: {
      getBranch: () => branch, getSessionFile: () => '/owned/review-session.jsonl',
    } };
    await handlers.get('tool_result')?.({ type: 'tool_result', toolName: 'bash',
      input: { command: 'git push origin feature' }, result: { isError: false } }, piContext);
    branch.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall',
      id: 'ci-launch', name: 'subagent', arguments: { subagent_type: 'ci-monitor',
        run_in_background: true, inherit_context: false, prompt: JSON.stringify({ repo: 'owner/repo',
          pr: 34, head, cwd: '/workspace/repo' }) } }] } });
    branch.push({ type: 'message', message: { role: 'toolResult', toolCallId: 'ci-launch',
      toolName: 'subagent', isError: false } });
    branch.push({ type: 'custom_message', customType: 'subagent-notification',
      content: `<tool-use-id>ci-launch</tool-use-id><status>Done</status>`
        + `<result>CI_RESULT success\npr=34 head=${head} repo=owner/repo</result>` });
    await handlers.get('agent_settled')?.({ type: 'agent_settled' }, piContext);
    expect(messages[1]).toMatchObject({ customType: 'pr-boundary-original-findings',
      details: { head, findings: [{ id: finding.id, message: finding.message }] } });
    branch.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'text',
      text: '| FINDING | VALIDITY | PROPOSED FIX | PROPORTIONALITY | MINIMAL DECISION |\n'
        + '|---|---|---|---|---|\n'
        + '| code-reviewer-guard | Rejected: existing guard applies | None | Caller checks authorization before write | Rejected |',
    }] } });
    await handlers.get('agent_end')?.({ type: 'agent_end' }, piContext);
    expect(messages.at(-1)?.customType).toBe('pr-boundary-fix-follow-up');
    observedHead = currentHead;
    await handlers.get('tool_result')?.({ type: 'tool_result', toolName: 'bash',
      input: { command: 'git push origin feature' }, result: { isError: false } }, piContext);
    expect(selected.at(-1)).toMatchObject({ repositoryId: 138, pullRequest: 34, head: currentHead,
      rejectedFindings: [{ findingId: finding.id, priorActivityId: admission.activityId,
        priorRound: admission.generation, priorHead: head,
        originalReportDigest: produced.artifact.digest,
        rationale: 'existing guard applies', evidence: 'Caller checks authorization before write' }] });
  });
  it('delivers authenticated publisher artifact/comment/check/run findings to the dedicated Pi session, not a synthetic branch entry', async () => {
    const branch: any[] = [];
    const messages: any[] = [];
    const handlers = new Map<string, (event: any, context: any) => Promise<void>>();
    const pi = { on: (name: string, callback: (event: any, context: any) => Promise<void>) => {
      handlers.set(name, callback); return () => handlers.delete(name);
    }, sendMessage: (message: any) => { messages.push(message); branch.push({ type: 'custom_message', ...message }); },
    appendEntry: (customType: string, data: unknown) => branch.push({ type: 'custom', customType, data }) };
    registerOperatorReviewRemote(pi as never, {
      currentBoundary: async () => ({ repository: 'owner/repo', repositoryId: 138,
        pullRequest: 34, head, repo: '/workspace/repo' }),
      selectBoundary: async () => ({ mode: 'remote', activityId: 'review-activity' }),
      readPublishedResult: async () => fixture().read(),
    });
    const context = { cwd: '/workspace/repo', sessionManager: { getBranch: () => branch } };
    await handlers.get('tool_result')?.({ type: 'tool_result', toolName: 'bash',
      input: { command: 'git push origin feature' }, result: { isError: false } }, context);
    branch.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall',
      id: 'ci-launch', name: 'subagent', arguments: { subagent_type: 'ci-monitor',
        run_in_background: true, inherit_context: false, prompt: JSON.stringify({ repo: 'owner/repo',
          pr: 34, head, cwd: '/workspace/repo' }) } }] } });
    branch.push({ type: 'message', message: { role: 'toolResult', toolCallId: 'ci-launch',
      toolName: 'subagent', isError: false } });
    branch.push({ type: 'custom_message', customType: 'subagent-notification',
      content: `<tool-use-id>ci-launch</tool-use-id><status>Done</status>`
        + `<result>CI_RESULT success\npr=34 head=${head} repo=owner/repo</result>` });
    await handlers.get('agent_settled')?.({ type: 'agent_settled' }, context);
    expect(messages.map(message => message.customType)).toEqual([
      'pr-boundary-remote-plan', 'pr-boundary-original-findings',
    ]);
    expect(messages[1]).toMatchObject({ details: { repository: 'owner/repo', pr: 34, head,
      round: 2, findings: [{ id: 'code-reviewer-guard', message: 'Authorization check missing' }] } });
    expect(messages[1].content).toContain('Authorization check missing');
  });
  it('returns bounded original findings from the exact authenticated artifact, comment, check and run for a prior PR head', async () => {
    const { read, operations, digest } = fixture();
    expect(await read()).toMatchObject({ schemaVersion: 1, status: 'published',
      repositoryId: 138, pullRequest: 34, activityId: 'review-activity', head,
      round: 2, artifactDigest: digest, findings: [{ ...finding, lane: 'code-reviewer' }] });
    expect(operations).toEqual(expect.arrayContaining(['pr-context', 'head-association',
      'comments-page', 'comment', 'artifact-list', 'artifact', 'run', 'checks-page', 'check']));
  });
  it.each([
    ['foreign repository', { repositoryId: 139 }], ['foreign PR', { pullRequest: 35 }],
    ['wrong activity', { activityId: 'other-activity' }], ['wrong prior head', { head: 'f'.repeat(40) }],
    ['wrong installed workflow', { trustedWorkflowId: 999 }],
  ])('never reveals findings for %s', async (_name, scope) => {
    expect(await fixture().read(scope)).toEqual({ status: 'unavailable' });
  });
  it.each([
    ['altered original report', { artifact: (a: any) => { a.result.originalReports[0].findings[0].message = 'changed'; } }],
    ['altered comment', { comment: (c: any) => { c.body = 'different'; } }],
    ['wrong comment author', { comment: (c: any) => { c.user.id = 123; } }],
    ['wrong check app', { check: (c: any) => { c.app.id = 123; } }],
    ['wrong check conclusion', { check: (c: any) => { c.conclusion = 'success'; } }],
    ['wrong run attempt', { run: (r: any) => { r.run_attempt = 2; } }],
    ['missing artifact', { list: (a: any[]) => { a.length = 0; } }],
  ])('treats %s as unavailable, never an empty successful result', async (_name, change) => {
    expect(await fixture(change).read()).toEqual({ status: 'unavailable' });
  });
  it('marks shortened evidence visibly rather than silently presenting an incomplete quotation', async () => {
    const published = await fixture({ longEvidence: 'e'.repeat(1000) }).read();
    expect(published).toMatchObject({ status: 'published',
      findings: [{ evidence: expect.stringContaining('[truncated]') }] });
  });
  it('bounds the visible projection without misrepresenting omitted findings as cleared', async () => {
    const published = await fixture({ extraFindings: 30 }).read();
    expect(published).toMatchObject({ status: 'published', omittedFindings: expect.any(Number) });
    if (published.status !== 'published') throw new Error('Expected authenticated published result');
    expect(published.findings.length).toBeLessThanOrEqual(20);
    expect(published.omittedFindings).toBeGreaterThan(0);
  });
  it('does not treat an incomplete history read as clearance or published evidence', async () => {
    expect(await fixture({ current: false }).read()).toEqual({ status: 'unavailable' });
  });
});
