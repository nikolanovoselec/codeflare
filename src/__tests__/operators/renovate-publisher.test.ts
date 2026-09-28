/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorActivity, createOperatorIntentDigest } from '../../operators/activity';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { operatorOwnerKey } from '../../operators/browser-activity';
import type { Env } from '../../types';

const HEAD = 'b'.repeat(40);
const BASE = 'a'.repeat(40);
const NOW = Date.now();
const human = { subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test',
  audiences: ['audience'], issuedAt: Math.floor(NOW / 1000) - 10, expiresAt: Math.floor(NOW / 1000) + 300 };
const target = { repository: 'owner/repo', pullRequest: 17 };
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
}) => Promise<void>) {
  const namespace = (env as unknown as { OPERATOR_ACTIVITY: DurableObjectNamespace }).OPERATOR_ACTIVITY;
  await runInDurableObject(namespace.getByName(`renovate-publication-${crypto.randomUUID()}`), async (_instance, native) => {
    const activityId = `activity-${crypto.randomUUID()}`;
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const invocationJson = JSON.stringify(target);
    const policy = { capabilities: ['fetch'], resourceProfileId: null };
    const selection = { controlsRevision: 1, installation: { id: 'installation', operatorId: 'operator', revision: 1,
      enabled: true, policy, configurationJson: '{}', releaseId: 'release' },
      operator: { operatorId: 'operator', profile: 'dispatcher', revision: 1, invokers: { users: [human.email], groups: [] } },
      release: { id: 'release', bundleDigest: 'c'.repeat(64) }, manifestJson: '{}' };
    const state: Record<string, unknown> = { current: true, admin: true, sessionState: 'running', sessionGeneration: 3,
      head: HEAD, base: BASE, checks: [{ name: 'test', status: 'completed', conclusion: 'success' }],
      reviews: [{ state: 'APPROVED', commit_id: HEAD }], requiredChecks: ['test'], mergeable: true,
      permission: 'admin', author: 'renovate[bot]', ambiguity: false, paginated: false };
    const writes: Array<{ method: string; url: string; body: unknown }> = [];
    const registry = { resolveManagementExecution: async () => state.current ? { ok: true, value: selection } : { ok: false, reason: 'disabled' } };
    Object.defineProperty(native, 'exports', { configurable: true, value: { GitHubInterceptor: () => ({
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        const body = request.method === 'GET' ? null : await request.clone().json().catch(() => null);
        if (request.method !== 'GET') {
          writes.push({ method: request.method, url: url.pathname, body });
          if (state.ambiguity) return Response.json({ message: 'response lost' }, { status: 502 });
          if (url.pathname.endsWith('/merge')) return Response.json({ merged: true, sha: HEAD });
          return Response.json({ id: 9001, body });
        }
        if (url.pathname.endsWith('/pulls/17')) return Response.json({ number: 17, state: 'open', mergeable: state.mergeable,
          user: { login: state.author, type: 'Bot' }, head: { sha: state.head }, base: { sha: state.base } });
        if (url.pathname.includes('/branches/')) return Response.json({ protection: { required_status_checks: { contexts: state.requiredChecks } } });
        if (url.pathname.includes('/check-runs')) return Response.json({ total_count: state.paginated ? 101 : (state.checks as unknown[]).length,
          check_runs: state.checks }, { headers: state.paginated ? { link: '<https://api.github.com/next>; rel="next"' } : {} });
        if (url.pathname.includes('/reviews')) return Response.json(state.reviews);
        if (url.pathname.includes('/collaborators/')) return Response.json({ permission: state.permission });
        if (url.pathname.includes('/comments')) return Response.json(writes.filter(w => w.url.includes('/comments')).map(() => ({ id: 9001 })));
        return Response.json({ rules: [], complete: true });
      },
    }) } });
    const environment = { ...encryption, ENTERPRISE_MODE: 'active', OPERATOR_REGISTRY: { getByName: () => registry },
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
    await test({ activity, writes, change: (key, value) => { state[key] = value; },
      restart: () => { activity = new OperatorActivity(native, environment); },
      setAssessment: async (value, status = 'completed') => { const stored = await native.storage.get<Record<string, unknown>>('admission');
        await native.storage.put('admission', { ...stored, drive: { generation: 1, status, checkpoint: null, result: value } }); },
      publish: (options = {}, authority = {}) => (activity as unknown as Publisher).publishRenovateAssessment(
        { ...command, ...options }, { human, accessJwt: 'private.jwt', platformAdmin: state.admin as boolean, ...authority }),
    });
  });
}

describe('REQ-OPERATOR-060: explicit fenced Renovate publication', () => {
  it('publishes only from a completed cited safe Activity and current admin owner/session, using its admitted target and expected head', () => fixture(async f => {
    const result = await f.publish();
    expect(result).toMatchObject({ ok: true });
    expect(f.writes.some(write => write.url.endsWith('/repos/owner/repo/pulls/17/merge')
      && (write.body as { sha?: string })?.sha === HEAD)).toBe(true);
    expect(f.writes.every(write => !write.url.includes('another-repo'))).toBe(true);
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
    expect(f.writes.every(write => write.url.includes('/comments') && JSON.stringify(write.body).length < 4096)).toBe(true);
  }));

  it.each(['admin', 'owner', 'session', 'stop', 'revoked', 'expiry'])('rejects %s authority loss without writes', reason => fixture(async f => {
    if (reason === 'admin') f.change('admin', false);
    if (reason === 'session') f.change('sessionGeneration', 4);
    if (reason === 'stop') f.change('sessionState', 'stopping');
    if (reason === 'revoked') f.change('current', false);
    const authority = reason === 'owner' ? { human: { ...human, subject: 'foreign' } }
      : reason === 'expiry' ? { human: { ...human, expiresAt: Math.floor(Date.now() / 1000) - 1 } } : {};
    await f.publish({}, authority).catch(() => undefined);
    expect(f.writes).toEqual([]);
  }));

  it.each(['head', 'base', 'checks', 'pagination', 'reviews', 'permission', 'author', 'mergeable', 'uncited'])('does not merge with %s drift or incomplete evidence', reason => fixture(async f => {
    if (reason === 'head') f.change('head', 'f'.repeat(40));
    if (reason === 'base') f.change('base', 'f'.repeat(40));
    if (reason === 'checks') f.change('checks', [{ name: 'test', status: 'in_progress', conclusion: null }]);
    if (reason === 'pagination') f.change('paginated', true);
    if (reason === 'reviews') f.change('reviews', []);
    if (reason === 'permission') f.change('permission', 'read');
    if (reason === 'author') f.change('author', 'someone-else');
    if (reason === 'mergeable') f.change('mergeable', null);
    if (reason === 'uncited') await f.setAssessment(uncited);
    await f.publish().catch(() => undefined);
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
