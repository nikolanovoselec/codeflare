import { describe, expect, it } from 'vitest';
import { discoverRenovatePulls, eligibleRenovatePull, executeRenovateDecision, renovateGithub } from '../../operators/renovate-publication';
import { parseDispatcherOperation } from '../../operators/operator-runtime-capability';
import type { Env } from '../../types';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const now = Date.parse('2026-10-01T12:00:00Z');
const pull = (number = 1) => ({ number, state: 'open', created_at: new Date(now).toISOString(),
  user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' }, head: { sha: head },
  base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } }, mergeable: true, mergeable_state: 'clean' });
const wire = (path: string, body: unknown) => new Request(`https://operator.internal/v1/dispatcher/${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const target = { pullRequest: 1, headSha: head };

describe('REQ-OPERATOR-051: repository-only protected Dispatcher tools', () => {
  it('accepts nested exact-head targets and legacy reads but rejects arbitrary destinations and atomic execution', async () => {
    for (const body of [{ operationId: 'one', resource: 'open-pull-requests' },
      { operationId: 'two', resource: 'checks', target }, { operationId: 'legacy', resource: 'files' }]) {
      expect((await parseDispatcherOperation(wire('github/read', body))).body).toEqual(body);
    }
    await expect(parseDispatcherOperation(wire('github/read', { operationId: 'one', resource: 'open-pull-requests', url: 'https://evil.test' }))).rejects.toThrow();
    const comment = { operationId: 'write-comment', target, decision: 'DO_NOT_MERGE', comment: 'Insufficient evidence' };
    expect((await parseDispatcherOperation(wire('github/comment', comment))).body).toEqual(comment);
    await expect(parseDispatcherOperation(wire('github/merge', comment))).rejects.toThrow();
    await expect(parseDispatcherOperation(wire('github/execute', comment))).rejects.toThrow();
    await expect(parseDispatcherOperation(wire('github/comment', { ...comment, sessionId: 'forged' }))).rejects.toThrow();
    const merge = { ...comment, operationId: 'write-merge', decision: 'MERGE' };
    expect((await parseDispatcherOperation(wire('github/merge', merge))).body).toEqual(merge);
  });
  it('uses inclusive rolling created_at cutoff and actual bot identity, not updated time or a forged label', () => {
    expect(eligibleRenovatePull({ ...pull(), created_at: new Date(now - 14 * 86400000).toISOString() }, 'owner/repo', now)).not.toBeNull();
    for (const row of [{ ...pull(), created_at: new Date(now - 14 * 86400000 - 1).toISOString(), updated_at: new Date(now).toISOString() },
      { ...pull(), user: { id: 123, login: 'renovate[bot]', type: 'Bot' } },
      { ...pull(), base: { repo: { full_name: 'foreign/repo' } } },
      { ...pull(), created_at: new Date(now + 1).toISOString() }]) {
      expect(eligibleRenovatePull(row, 'owner/repo', now)).toBeNull();
    }
  });
  it('reports bounded truncation and never follows arbitrary next URLs', async () => {
    const result = await discoverRenovatePulls('owner/repo', async path => {
      const page = Number(new URL('https://fixed.test' + path).searchParams.get('page'));
      if (page < 1 || page > 10 || !path.startsWith('/pulls?state=open&sort=created&direction=desc&')) throw new Error('Invalid discovery route');
      return Response.json(Array.from({ length: 10 }, (_, i) => pull((page - 1) * 10 + i + 1)),
        { headers: { link: '<https://evil.test/private>; rel="next"' } });
    }, now);
    expect(result.truncated).toBe(true);
    expect(result.pullRequests).toHaveLength(100);
  });
  it('rejects incomplete or overlapping discovery pages', async () => {
    await expect(discoverRenovatePulls('owner/repo', async () => Response.json([pull()],
      { headers: { link: '<https://evil.test>; rel="next"' } }), now)).rejects.toThrow('incomplete');
    await expect(discoverRenovatePulls('owner/repo', async () => Response.json(Array.from({ length: 10 }, () => pull())), now)).rejects.toThrow('changed');
  });
});

type Comment = { id: number; body: string; user: { id: number; login: string } };
type Options = { stale?: boolean; failedChecks?: boolean; unauthorized?: boolean; noPermission?: boolean;
  changedAuthor?: boolean; unsupportedRule?: boolean; changesRequested?: boolean; lostComment?: boolean;
  lostMerge?: boolean; rejectedComment?: boolean; rejectedMerge?: boolean; ambiguousMergedHead?: boolean };
function effects(options: Options = {}) {
  const comments: Comment[] = [];
  let merged = false;
  const transport = { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'POST') {
      if (options.rejectedComment) return new Response(null, { status: 503 });
      const body = await request.json() as { body: string };
      const comment = { id: 23 + comments.length, body: body.body, user: { id: 99, login: 'admin' } };
      comments.push(comment);
      if (options.lostComment) throw new Error('Lost receipt');
      return Response.json(comment, { status: 201 });
    }
    if (request.method === 'PUT') {
      const body = await request.json() as { sha: string };
      if (body.sha !== head) throw new Error('Wrong expected head');
      if (options.rejectedMerge) return new Response(null, { status: 503 });
      merged = true;
      if (options.lostMerge) throw new Error('Lost merge receipt');
      return Response.json({ merged: true, sha: 'c'.repeat(40) });
    }
    if (path === '/user') return Response.json({ id: 99, login: 'admin' });
    if (path.endsWith('/comments')) return Response.json(comments);
    if (path.endsWith('/merge')) return new Response(null, { status: merged ? 204 : 404 });
    if (path.endsWith('/pulls/1')) return Response.json({ ...pull(), merged, created_at: new Date().toISOString(),
      head: { sha: options.stale || (merged && options.ambiguousMergedHead) ? 'd'.repeat(40) : head },
      user: options.changedAuthor ? { id: 123, login: 'renovate[bot]', type: 'Bot' } : pull().user });
    if (path.endsWith('/protection')) return new Response(null, { status: 404 });
    if (path.endsWith('/rulesets')) return Response.json(options.unsupportedRule ? [{ id: 1, enforcement: 'active', target: 'unknown' }] : []);
    if (path.endsWith('/reviews')) return Response.json(options.changesRequested ? [{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }] : []);
    if (path.endsWith('/check-runs')) return Response.json({ total_count: 1, check_runs: [{ name: 'CI', status: 'completed', conclusion: options.failedChecks ? 'failure' : 'success' }] });
    if (path.endsWith('/status')) return Response.json({ statuses: [] });
    return Response.json({ id: 42, full_name: 'owner/repo', default_branch: 'main', permissions: { admin: !options.noPermission } });
  } };
  const github = renovateGithub({ env: {} as Env, exports: { GitHubInterceptor: () => transport },
    user: 'admin@example.test', bucket: 'bucket', repository: 'owner/repo', pullRequest: 1, prospective: false,
    repositoryDiscovery: true, current: async () => { if (options.unauthorized) throw new Error('Authority revoked'); } });
  const execute = (phase: 'comment' | 'merge', input: { decision?: 'MERGE' | 'DO_NOT_MERGE'; reconcileOnly?: boolean;
    operationBase?: string; comment?: string; headSha?: string; activityId?: string } = {}) => executeRenovateDecision({ github,
    activityId: input.activityId ?? 'activity', phase, reconcileOnly: input.reconcileOnly ?? false, observed: { base: { sha: base } },
    value: { operationId: `${input.operationBase ?? 'operation'}-${phase}`, target: { pullRequest: 1, headSha: input.headSha ?? head },
      decision: input.decision ?? 'MERGE', comment: input.comment ?? 'Research judgment' } });
  return { execute, comments, remoteMerged: () => merged, options };
}
const receipt = (decision: 'MERGE' | 'DO_NOT_MERGE' = 'MERGE') => ({ pullRequest: 1, headSha: head, decision, comment: 'Research judgment' });

describe('REQ-OPERATOR-060: separate protected tools retain current authority and remote receipts', () => {
  it('comments without merging, then separately merges with expected head and strict flat receipts', async () => {
    const f = effects();
    expect(await (await f.execute('comment')).json()).toEqual({ ...receipt(), posted: true, commentId: 23 });
    expect(f.remoteMerged()).toBe(false);
    expect(await (await f.execute('merge')).json()).toEqual({ ...receipt(), outcome: 'MERGED' });
    expect(f.remoteMerged()).toBe(true);
  });
  it('does not post a missing comment from the merge tool', async () => {
    const f = effects();
    expect(await (await f.execute('merge')).json()).toEqual({ ...receipt(), outcome: 'EXECUTION_FAILED' });
    expect(f.comments).toEqual([]);
    expect(f.remoteMerged()).toBe(false);
  });
  it('returns negative comment receipt and never authorizes its positive replacement judgment', async () => {
    const f = effects();
    expect(await (await f.execute('comment', { decision: 'DO_NOT_MERGE' })).json()).toEqual({ ...receipt('DO_NOT_MERGE'), posted: true, commentId: 23 });
    expect(await (await f.execute('merge')).json()).toEqual({ ...receipt(), outcome: 'EXECUTION_FAILED' });
    expect(f.remoteMerged()).toBe(false);
  });
  it('requires the same comment text, activity, paired operation, publisher and exact head', async () => {
    for (const mismatch of [{ comment: 'Different judgment' }, { operationBase: 'foreign' },
      { activityId: 'foreign' }, { headSha: 'd'.repeat(40) }]) {
      const f = effects();
      await f.execute('comment');
      expect(await (await f.execute('merge', mismatch)).json()).toMatchObject({ outcome: 'EXECUTION_FAILED' });
      expect(f.remoteMerged()).toBe(false);
    }
    const f = effects();
    await f.execute('comment');
    f.comments[0].user = { id: 123, login: 'admin' };
    expect(await (await f.execute('merge')).json()).toMatchObject({ outcome: 'EXECUTION_FAILED' });
    expect(f.remoteMerged()).toBe(false);
  });
  it('blocks merge for failed checks, unsupported rules or requested review changes', async () => {
    for (const options of [{ failedChecks: true }, { unsupportedRule: true }, { changesRequested: true }]) {
      const f = effects(options);
      await f.execute('comment');
      expect(await (await f.execute('merge')).json()).toEqual({ ...receipt(), outcome: 'EXECUTION_FAILED' });
      expect(f.remoteMerged()).toBe(false);
    }
  });
  it('denies stale heads, forged bots, missing GitHub admin permission and revoked authority before comments', async () => {
    for (const options of [{ stale: true }, { unauthorized: true }, { noPermission: true }, { changedAuthor: true }]) {
      const f = effects(options);
      await expect(f.execute('comment')).rejects.toThrow();
      expect(f.comments).toEqual([]);
      expect(f.remoteMerged()).toBe(false);
    }
  });
  it('rechecks authority and current head independently after comment publication', async () => {
    for (const options of [{ unauthorized: true }, { stale: true }, { noPermission: true }]) {
      const f = effects();
      await f.execute('comment');
      Object.assign(f.options, options);
      if (options.unauthorized) await expect(f.execute('merge')).rejects.toThrow('revoked');
      else expect(await (await f.execute('merge')).json()).toMatchObject({ outcome: 'EXECUTION_FAILED' });
      expect(f.remoteMerged()).toBe(false);
    }
  });
  it('reconciles lost responses and duplicate calls without creating additional comments', async () => {
    const f = effects({ lostComment: true, lostMerge: true });
    expect(await (await f.execute('comment')).json()).toEqual({ ...receipt(), posted: true, commentId: 23 });
    expect(await (await f.execute('comment', { reconcileOnly: true })).json()).toEqual({ ...receipt(), posted: true, commentId: 23 });
    expect(f.comments).toHaveLength(1);
    expect(await (await f.execute('merge')).json()).toEqual({ ...receipt(), outcome: 'MERGED' });
    expect(await (await f.execute('merge', { reconcileOnly: true })).json()).toEqual({ ...receipt(), outcome: 'MERGED' });
    expect(f.remoteMerged()).toBe(true);
  });
  it('does not turn uncertain operations without remote receipts into another write or a fabricated success', async () => {
    const f = effects();
    await expect(f.execute('comment', { reconcileOnly: true })).rejects.toThrow('receipt unavailable');
    expect(f.comments).toEqual([]);
    await f.execute('comment');
    expect(await (await f.execute('merge', { reconcileOnly: true })).json()).toEqual({ ...receipt(), outcome: 'EXECUTION_FAILED' });
    expect(f.remoteMerged()).toBe(false);
    const rejected = effects({ rejectedComment: true });
    await expect(rejected.execute('comment')).rejects.toThrow('receipt unavailable');
    expect(rejected.comments).toEqual([]);
    const failed = effects({ rejectedMerge: true });
    await failed.execute('comment');
    expect(await (await failed.execute('merge')).json()).toEqual({ ...receipt(), outcome: 'EXECUTION_FAILED' });
    expect(failed.remoteMerged()).toBe(false);
  });
  it('does not call a merged status proof of merging another head', async () => {
    const f = effects({ lostMerge: true, ambiguousMergedHead: true });
    await f.execute('comment');
    await expect(f.execute('merge')).rejects.toThrow('revision unverified');
  });
});
