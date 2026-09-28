/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { operatorOwnerKey } from '../../operators/browser-activity';
import type { Env } from '../../types';

const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);
const NOW = Date.now();
const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://owner.cloudflareaccess.com',
  audiences: ['audience'], issuedAt: Math.floor(NOW / 1000) - 10, expiresAt: Math.floor(NOW / 1000) + 300 };
const target = { repository: 'nikolanovoselec/komodo', pullRequest: 1299 };
// Persisted output contract of assessment-evidence.ts, not the model's proposed decision.
const cited = { classification: 'safe', observedHead: HEAD, baseSha: BASE,
  checks: { state: 'passing', observedHead: HEAD },
  reasons: ['Version-pinned release and agent guide support the changed services'],
  compatibility: 'The cited migration guidance covers the observed server and agent changes.',
  citations: [
    { kind: 'release', source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2',
      quote: 'No changes are required for the default server or agent configuration.' },
    { kind: 'guide', source: `https://github.com/amir20/dozzle/blob/${'1'.repeat(40)}/docs/guide/agent.md`,
      quote: 'Start the agent with the agent subcommand and configure the remote server.' },
    { kind: 'config', ref: 'compose.yaml:dozzle:after' },
    { kind: 'config', ref: 'compose.yaml:dozzle:before' },
    { kind: 'config', ref: 'agent/compose.yaml:dozzle-agent:after' },
    { kind: 'config', ref: 'agent/compose.yaml:dozzle-agent:before' },
  ], gaps: [] as string[] };
const uncited = { ...cited, citations: [], compatibility: 'Compatibility not established' };

type Command = { sessionId: string; sessionGeneration: number; bucket: string; operationId: string };
type Publisher = { publishRenovateAssessment: (command: Command, authority: {
  human: typeof human; accessJwt: string; platformAdmin: boolean }) => Promise<unknown> };

/** Real Activity storage; only the independent session, registry and GitHub services are substituted. */
async function fixture(test: (f: {
  publish: (options?: Partial<Command>, authority?: Partial<{ human: typeof human; accessJwt: string; platformAdmin: boolean }>) => Promise<unknown>;
  activity: OperatorActivity; writes: Array<{ method: string; url: string; body: unknown }>;
  setAssessment: (value: unknown, status?: 'waiting' | 'completed') => Promise<void>; change: (key: string, value: unknown) => void;
  restart: () => void;
}) => Promise<void>, selected = target) {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`renovate-publication-${crypto.randomUUID()}`), async (_instance, native) => {
    const activityId = `activity-${crypto.randomUUID()}`;
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const invocationJson = JSON.stringify(selected);
    const policy = { capabilities: ['fetch'], resourceProfileId: null };
    const selection = { controlsRevision: 1, installation: { id: 'installation', operatorId: 'operator', revision: 1,
      enabled: true, policy, configurationJson: '{}', releaseId: 'release' },
      operator: { operatorId: 'operator', profile: 'dispatcher', revision: 1, invokers: { users: [human.email], groups: [] } },
      release: { id: 'release', bundleDigest: 'c'.repeat(64) }, manifestJson: '{}' };
    const state: Record<string, unknown> = { current: true, admin: true, sessionState: 'running', sessionGeneration: 3,
      head: HEAD, base: BASE, checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      reviews: [{ state: 'APPROVED', commit_id: HEAD, user: { login: 'reviewer' } }], requiredChecks: ['test'], mergeable: true,
      permission: 'admin', author: 'renovate[bot]', ambiguity: false, paginated: false, loggedOut: false,
      advanceBaseOnApproval: false, stopOnApproval: false, rulesetType: 'non_fast_forward', prState: 'open',
      moveHeadDuringChecks: false, forgedReadback: false, mergeReadbackUnavailable: false };
    const writes: Array<{ method: string; url: string; body: unknown }> = [];
    const registry = { resolveManagementExecution: async () => state.current ? { ok: true, value: selection } : { ok: false, reason: 'disabled' } };
    Object.defineProperty(native, 'exports', { configurable: true, value: { GitHubInterceptor: () => ({
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        const body = request.method === 'GET' ? null : await request.clone().json().catch(() => null);
        if (request.method !== 'GET') {
          writes.push({ method: request.method, url: url.pathname, body });
          if (url.pathname.endsWith('/reviews')) {
            if (state.advanceBaseOnApproval) state.base = 'f'.repeat(40);
            if (state.stopOnApproval) state.sessionState = 'stopping';
          }
          if (url.pathname.endsWith('/merge')) state.prState = 'closed';
          if (state.ambiguity) return Response.json({ message: 'response lost' }, { status: 502 });
          if (url.pathname.endsWith('/merge')) return Response.json({ merged: true, sha: HEAD });
          return Response.json({ id: 9001, body });
        }
        if (url.pathname === '/user') return Response.json({ id: 314, login: 'publisher' });
        if (url.pathname === '/repos/nikolanovoselec/komodo/') return Response.json({ id: 973175879,
          full_name: 'nikolanovoselec/komodo', default_branch: 'main', permissions: { admin: state.permission === 'admin' } });
        if (url.pathname.endsWith('/pulls/1299')) return Response.json({ number: 1299, state: state.prState, mergeable: state.mergeable,
          mergeable_state: state.mergeable ? 'clean' : 'unknown',
          user: { id: 29139614, login: state.author, type: 'Bot' }, head: { sha: state.head },
          base: { sha: state.base, ref: 'main' } });
        if (url.pathname.endsWith('/branches/main/protection')) return Response.json({
          required_status_checks: { contexts: state.requiredChecks },
          required_pull_request_reviews: { required_approving_review_count: 1 },
        });
        if (url.pathname.endsWith('/rulesets')) return Response.json([{ id: 5212225, enforcement: 'active', target: 'branch' }]);
        if (url.pathname.endsWith('/rulesets/5212225')) return Response.json({ enforcement: 'active',
          rules: [{ type: state.rulesetType }],
          conditions: { ref_name: { include: ['~ALL'], exclude: ['refs/heads/renovate/**'] } } });
        if (url.pathname.includes('/check-runs')) {
          if (state.moveHeadDuringChecks) state.head = 'f'.repeat(40);
          return Response.json({ total_count: state.paginated ? 101 : (state.checks as unknown[]).length,
            check_runs: state.checks }, { headers: state.paginated ? { link: '<https://api.github.com/next>; rel="next"' } : {} });
        }
        if (url.pathname.includes('/commits/') && url.pathname.endsWith('/status')) return Response.json({ statuses: [] });
        if (url.pathname.includes('/reviews')) return Response.json([...(state.reviews as object[]),
          ...writes.filter(w => w.url.endsWith('/reviews')).map(w => ({ id: 9001, body: (w.body as { body: string }).body,
            state: 'APPROVED', commit_id: HEAD, user: state.forgedReadback
              ? { id: 315, login: 'other-user' } : { id: 314, login: 'publisher' } }))]);
        if (url.pathname.includes('/comments')) return Response.json(writes.filter(w => w.url.includes('/comments'))
          .map(w => ({ id: 9001, body: (w.body as { body: string }).body,
            user: state.forgedReadback ? { id: 315, login: 'other-user' } : { id: 314, login: 'publisher' } })));
        if (url.pathname.endsWith('/pulls/1299/merge')) return state.mergeReadbackUnavailable
          ? new Response(null, { status: 503 }) : writes.some(w => w.url.endsWith('/merge'))
            ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
        return Response.json({ message: 'Unexpected GitHub route' }, { status: 404 });
      },
    }) } });
    const environment = { ...encryption, ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry },
      KV: { get: async (key: string) => key === `user:${human.email}` ? JSON.stringify({ role: state.admin ? 'admin' : 'user' }) : null },
      USAGE_DB: { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ first: async () => {
        if (!sql.includes('runtime_sessions') || args[0] !== 'owner-bucket' || args[1] !== 'session-1') return null;
        return { owner_key: 'owner-bucket', session_id: 'session-1', lifecycle_state: state.sessionState,
          lifecycle_generation: state.sessionGeneration, name: 'Admin session', workspace: 'default', terminal_mode: 'terminal',
          created_at: new Date(NOW).toISOString(), last_accessed_at: new Date(NOW).toISOString(),
          response_revision: 0, observation_sequence: 0, editor_ready: 1, editor_ready_error: 0,
          agent_type: null, tab_config_json: null, clone_json: null, clones_json: null, transitioned_at: null,
          last_started_at: null, last_active_at: null, cpu: null, memory: null, disk: null,
          sync_status: null, metrics_observed_at: null, last_input_at: null, unreachable_incident_id: null,
          unreachable_first_observed_at: null, unreachable_deadline_ms: null, termination_intent_id: null,
          termination_generation: null, boundary_activity_id: null };
      } }) }) } } as unknown as Env;
    let activity = new OperatorActivity(native, environment);
    const context = await createOperatorExecutionContext({ activityId, operatorId: 'operator',
      artifactDigest: 'c'.repeat(64), policyDigest: 'd'.repeat(64), human, accessJwt: 'private.jwt' }, encryption);
    const intent = { activityId, operatorId: 'operator', installationId: 'installation',
      intentDigest: await createOperatorIntentDigest('operator', activityId, invocationJson),
      expectedRevision: 1, expectedInstallationRevision: 1, expectedControlsRevision: 1,
      deadline: human.expiresAt * 1000, startExpiresAt: human.expiresAt * 1000, startVerifier: 'e'.repeat(64) };
    await native.storage.put('admission', { intent, phase: 'queued', receipt: {
      ...intent, admittedAt: NOW, selection }, executionContext: context, invocationJson, ownerKey: await operatorOwnerKey(human),
      drive: { generation: 1, status: 'completed', checkpoint: null, result: cited } });
    const command = { bucket: 'owner-bucket', sessionId: 'session-1', sessionGeneration: 3, operationId: 'publication-1' };
    const access = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => state.loggedOut
      ? new Response(null, { status: 401 })
      : Response.json({ id: human.subject, email: human.email, groups: [] }));
    try { await test({ activity, writes, change: (key, value) => { state[key] = value; },
      restart: () => { activity = new OperatorActivity(native, environment); },
      setAssessment: async (value, status = 'completed') => { const stored = await native.storage.get<Record<string, unknown>>('admission');
        await native.storage.put('admission', { ...stored, drive: { generation: 1, status, checkpoint: null, result: value } }); },
      publish: (options = {}, authority = {}) => (activity as unknown as Publisher).publishRenovateAssessment(
        { ...command, ...options }, { human, accessJwt: 'private.jwt', platformAdmin: state.admin as boolean, ...authority }),
    }); } finally { access.mockRestore(); }
  });
}

describe('REQ-OPERATOR-060: explicit fenced Renovate publication', () => {
  it('publishes only from a completed cited safe Activity and current admin owner/session, using its admitted target and expected head', () => fixture(async f => {
    const result = await f.publish();
    expect(result).toMatchObject({ ok: true, phase: 'completed', effect: 'merge', mergeSha: HEAD });
    expect(f.writes.some(write => write.url.endsWith('/repos/nikolanovoselec/komodo/pulls/1299/reviews')
      && (write.body as { commit_id?: string })?.commit_id === HEAD)).toBe(true);
    expect(f.writes.some(write => write.url.endsWith('/repos/nikolanovoselec/komodo/pulls/1299/merge')
      && (write.body as { sha?: string })?.sha === HEAD)).toBe(true);
    expect(f.writes.every(write => !write.url.includes('another-repo'))).toBe(true);
  }));

  it('does not publish an unapproved pre-activation repository or PR', () => fixture(async f => {
    await f.publish().catch(() => undefined);
    expect(f.writes).toEqual([]);
  }, { repository: 'another/repo', pullRequest: 18 }));

  it('satisfies a required review through its own approval before rechecking merge readiness', () => fixture(async f => {
    f.change('reviews', []);
    expect(await f.publish()).toMatchObject({ ok: true, effect: 'merge' });
    expect(f.writes.map(write => write.url)).toEqual([
      '/repos/nikolanovoselec/komodo/pulls/1299/reviews',
      '/repos/nikolanovoselec/komodo/pulls/1299/merge',
    ]);
  }));

  it('does not collect or publish a waiting assessment, even when its child snapshot looks safe', () => fixture(async f => {
    await f.setAssessment(cited, 'waiting');
    await f.publish().catch(() => undefined);
    expect(f.writes).toEqual([]);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
  }));

  it.each(['unsafe', 'unknown'])('%s permits only a bounded comment, not approval or merge', classification => fixture(async f => {
    await f.setAssessment({ ...cited, classification, reasons: ['Cannot verify compatibility'],
      compatibility: 'Cannot establish compatibility', gaps: classification === 'unknown' ? ['Unresolved migration'] : [] });
    await f.publish();
    expect(f.writes.some(write => write.url.endsWith('/comments') && JSON.stringify(write.body).length < 4096)).toBe(true);
    expect(f.writes.some(write => write.url.endsWith('/reviews') || write.url.endsWith('/merge'))).toBe(false);
  }));

  it.each(['admin', 'owner', 'session', 'stop', 'revoked', 'logout', 'expiry'])('rejects %s authority loss without writes', reason => fixture(async f => {
    if (reason === 'admin') f.change('admin', false);
    if (reason === 'session') f.change('sessionGeneration', 4);
    if (reason === 'stop') f.change('sessionState', 'stopping');
    if (reason === 'revoked') f.change('current', false);
    if (reason === 'logout') f.change('loggedOut', true);
    const authority = reason === 'owner' ? { human: { ...human, subject: 'foreign' } }
      : reason === 'expiry' ? { human: { ...human, expiresAt: Math.floor(Date.now() / 1000) - 1 } } : {};
    await f.publish({}, authority).catch(() => undefined);
    expect(f.writes).toEqual([]);
  }));

  it.each(['head', 'base', 'checks', 'pagination', 'reviews', 'rules', 'permission', 'author', 'mergeable', 'uncited'])('does not merge with %s drift or incomplete evidence', reason => fixture(async f => {
    if (reason === 'head') f.change('head', 'f'.repeat(40));
    if (reason === 'base') f.change('base', 'f'.repeat(40));
    if (reason === 'checks') f.change('checks', [{ name: 'test', status: 'in_progress', conclusion: null }]);
    if (reason === 'pagination') f.change('paginated', true);
    if (reason === 'reviews') f.change('reviews', [{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }]);
    if (reason === 'rules') f.change('rulesetType', 'required_status_checks');
    if (reason === 'permission') f.change('permission', 'read');
    if (reason === 'author') f.change('author', 'someone-else');
    if (reason === 'mergeable') f.change('mergeable', null);
    if (reason === 'uncited') await f.setAssessment(uncited);
    await f.publish().catch(() => undefined);
    expect(f.writes.some(write => write.url.endsWith('/merge'))).toBe(false);
  }));

  it('rereads PR revisions after check and policy observations before approval', () => fixture(async f => {
    f.change('moveHeadDuringChecks', true);
    await f.publish().catch(() => undefined);
    expect(f.writes).toEqual([]);
  }));

  it.each(['base', 'stop'])('rechecks %s after an approved review and before merge', reason => fixture(async f => {
    f.change(reason === 'base' ? 'advanceBaseOnApproval' : 'stopOnApproval', true);
    await f.publish().catch(() => undefined);
    expect(f.writes.some(write => write.url.endsWith('/reviews'))).toBe(true);
    expect(f.writes.some(write => write.url.endsWith('/merge'))).toBe(false);
  }));

  it('does not treat zero configured checks as a veto or as compatibility proof', () => fixture(async f => {
    f.change('checks', []);
    f.change('requiredChecks', []);
    await f.setAssessment({ ...cited, checks: { state: 'unconfigured', observedHead: HEAD } });
    await f.publish().catch(() => undefined);
    expect(f.writes.some(write => write.url.endsWith('/merge'))).toBe(true);
  }));

  it('does not infer compatibility from zero checks when the assessment has no citations', () => fixture(async f => {
    f.change('checks', []);
    f.change('requiredChecks', []);
    await f.setAssessment({ ...uncited, checks: { state: 'unconfigured', observedHead: HEAD } });
    await f.publish().catch(() => undefined);
    expect(f.writes.some(write => write.url.endsWith('/merge'))).toBe(false);
  }));

  it.each(['approval', 'comment'])('does not accept a copied %s marker from a different GitHub actor', effect => fixture(async f => {
    if (effect === 'comment') await f.setAssessment({ ...cited, classification: 'unknown',
      reasons: ['Compatibility unresolved'], gaps: ['Migration unverified'] });
    f.change('ambiguity', true);
    f.change('forgedReadback', true);
    expect(await f.publish()).toMatchObject({ ok: false, reason: 'uncertain-effect' });
    expect(f.writes.some(write => write.url.endsWith('/merge'))).toBe(false);
  }));

  it('reconciles an ambiguous comment by its durable external marker without reposting it', () => fixture(async f => {
    await f.setAssessment({ ...cited, classification: 'unknown', reasons: ['Upstream compatibility unresolved'],
      gaps: ['Migration behavior unverified'] });
    f.change('ambiguity', true);
    expect(await f.publish()).toMatchObject({ ok: true, phase: 'completed', effect: 'comment' });
    f.restart();
    expect(await f.publish()).toMatchObject({ ok: true, phase: 'completed', effect: 'comment' });
    expect(f.writes.map(write => write.url)).toEqual(['/repos/nikolanovoselec/komodo/issues/1299/comments']);
  }));

  it('reconciles a previously reserved merge even after its accepted write closes the PR', () => fixture(async f => {
    f.change('ambiguity', true);
    f.change('mergeReadbackUnavailable', true);
    expect(await f.publish()).toMatchObject({ ok: false, reason: 'uncertain-effect' });
    f.change('mergeReadbackUnavailable', false);
    f.restart();
    expect(await f.publish()).toMatchObject({ ok: false, reason: 'remote-merged-unattributed' });
    expect(f.writes.map(write => write.url)).toEqual([
      '/repos/nikolanovoselec/komodo/pulls/1299/reviews',
      '/repos/nikolanovoselec/komodo/pulls/1299/merge',
    ]);
  }));

  it('retains an unattributed merged readback after a lost merge response without replay', () => fixture(async f => {
    f.change('ambiguity', true);
    const first = await f.publish();
    expect(first).toMatchObject({ ok: false, reason: 'remote-merged-unattributed' });
    f.restart();
    expect(await f.publish()).toEqual(first);
    expect(f.writes.map(write => write.url)).toEqual([
      '/repos/nikolanovoselec/komodo/pulls/1299/reviews',
      '/repos/nikolanovoselec/komodo/pulls/1299/merge',
    ]);
  }));

  it('rereads a completed publication without another approval or merge', () => fixture(async f => {
    const first = await f.publish();
    expect(first).toMatchObject({ ok: true, phase: 'completed' });
    f.restart();
    const again = await f.publish();
    expect(again).toEqual(first);
    expect(f.writes.map(write => write.url)).toEqual([
      '/repos/nikolanovoselec/komodo/pulls/1299/reviews',
      '/repos/nikolanovoselec/komodo/pulls/1299/merge',
    ]);
  }));

  it('fences repeated and concurrent commands across restart, including ambiguous remote responses', () => fixture(async f => {
    f.change('ambiguity', true);
    await Promise.allSettled([f.publish(), f.publish()]);
    const effects = JSON.stringify(f.writes);
    f.restart();
    await f.publish().catch(() => undefined);
    expect(JSON.stringify(f.writes)).toBe(effects);
    expect(f.writes.every(write => !write.url.endsWith('/merge')
      || (write.body as { sha?: string })?.sha === HEAD)).toBe(true);
  }));
});
