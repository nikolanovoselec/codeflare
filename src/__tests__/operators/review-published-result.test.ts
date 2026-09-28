import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readPublishedReview } from '../../operators/review-history-transport';
import { registerOperatorReviewRemote } from '../../../preseed/agents/pi/extensions/operator-review-remote';

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
  extraFindings?: number } = {}) {
  const result = { status: 'complete', activityId: 'review-activity', generation: 2,
    activityGeneration: 4, repositoryId: 138, pullRequest: 34, head,
    packageDigest: admission.packageDigest, manifestDigest: '4'.repeat(64), cleanup: 'stopped',
    originalReports: structuredClone(reports), history: { findings: [{ ...finding, lane: 'code-reviewer' }],
      clear: false, coverageAdvanced: true, rebuttals: [] }, presentation };
  for (let n = 0; n < (change.extraFindings ?? 0); n++) {
    const added = { ...finding, id: `code-reviewer-more-${n}` };
    result.originalReports[0].findings.push(added);
    result.history.findings.push({ ...added, lane: 'code-reviewer' });
  }
  const binding = { admission, context, packetDigest: 'd'.repeat(64), activityGeneration: 4,
    runId: 7, runAttempt: 1 };
  const digest = sha({ binding, result });
  const marker = `review-138-34-review-activity-generation-2:${digest}`;
  const artifact = { marker, digest, binding, result };
  const comment = { id: 501, user: { id: 777 }, issue_url: 'https://api.github.com/repos/owner/repo/issues/34',
    body: `<!-- codeflare-review:${marker} -->\n${presentation.commentBody}\n${JSON.stringify({ head, artifactDigest: digest })}` };
  const check = { id: 601, app: { id: 888 }, name: presentation.check.name, head_sha: head,
    external_id: marker, status: 'completed', conclusion: 'failure',
    output: { title: presentation.check.name, summary: presentation.check.summary } };
  const run = { id: 7, run_attempt: 1, workflow_id: 531, repository: { id: 138 },
    event: 'pull_request_target', pull_requests: [{ number: 34 }] };
  const artifacts = [{ id: 701, name: `boundary-review-${digest}` }];
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
  return { read, operations, marker, digest };
}

describe('REQ-OPERATOR-053/056: independently published original Review evidence', () => {
  it('delivers authenticated publisher artifact/comment/check/run findings to the dedicated Pi session, not a synthetic branch entry', async () => {
    const branch: any[] = [{ type: 'custom_message', customType: 'subagent-notification',
      content: `<result>CI_RESULT success\nrepo=owner/repo pr=34 head=${head}</result>` }];
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
  it('bounds the visible projection without misrepresenting omitted findings as cleared', async () => {
    const published = await fixture({ extraFindings: 30 }).read();
    expect(published).toMatchObject({ status: 'published', omittedFindings: expect.any(Number) });
    expect(published.findings.length).toBeLessThanOrEqual(20);
    expect(published.omittedFindings).toBeGreaterThan(0);
  });
  it('does not treat an incomplete history read as clearance or published evidence', async () => {
    expect(await fixture({ current: false }).read()).toEqual({ status: 'unavailable' });
  });
});
