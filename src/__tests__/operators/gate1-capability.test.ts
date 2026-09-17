import { describe, expect, it, vi } from 'vitest';
import { Gate1OperatorCapability, type Gate1CapabilityOptions } from '../../operators/gate1-capability';
import { OperatorRuntimeCapability } from '../../operators/gate1-production';
import { resolveGate1Resources, type Gate1Resources } from '../../operators/gate1-resources';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { parseOperatorPolicy } from '../../operators/policy';
import type { Env } from '../../types';

const production = vi.hoisted(() => ({
  getContainer: vi.fn(() => ({})),
  resolveBucketName: vi.fn(async () => 'owner-bucket'),
  resolveSessionAccessGroup: vi.fn(async () => []),
  loadEnterpriseRouteConfig: vi.fn(async () => ({ routeCatalog: ['route-approved'],
    defaultRoute: 'route-approved', defaultReasoning: 'off' })),
}));
vi.mock('@cloudflare/containers', () => ({ getContainer: production.getContainer }));
vi.mock('../../lib/access', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/access')>(),
  resolveBucketName: production.resolveBucketName,
  resolveSessionAccessGroup: production.resolveSessionAccessGroup,
  loadEnterpriseRouteConfig: production.loadEnterpriseRouteConfig,
}));

const activityId = 'activity-gate1';
const operationId = 'gate1-output-v1';
const sessionId = 'gate1a1b2c3d4e5f6a7b8';
const resources = {
  profile: { activityId, sessionId, policyDigest: 'c'.repeat(64),
    outputPrefix: 'Operators/',
    piProfile: { systemPrompt: 'Write the fixed Gate 1 marker.' } },
  effectiveInference: { routeId: 'route-approved', reasoningLevel: 'high' },
  marker: { relativePath: `Gate 1/gate1-marker-${activityId}.txt`, storagePath: `Operators/Gate 1/gate1-marker-${activityId}.txt`,
    content: 'codeflare-gate1-marker-v1', sha256: 'd'.repeat(64) },
} as unknown as Gate1Resources;
const request = (generation = 3) => new Request('https://operator.invalid/v1/gate1/session', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ schemaVersion: 1, activityId, generation, checkpoint: null }),
});

function fixture(overrides: Partial<Gate1CapabilityOptions> = {}) {
  const calls: string[] = [];
  const session: Gate1CapabilityOptions['session'] = {
    ensure: vi.fn(async () => { calls.push('session.ensure'); return { status: 'ready' as const }; }),
    stop: vi.fn(async () => { calls.push('session.stop'); return { status: 'stopped' as const }; }),
  };
  const host = { fetch: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push(path);
    if (path.endsWith('/ensure')) return Response.json({ conversationId: 'conversation-1', ready: true });
    if (path.endsWith('/tasks')) return Response.json({ taskId: 'gate1-pi-file-v1', status: 'completed' }, { status: 202 });
    if (path === '/internal/bisync-trigger') return Response.json({ schemaVersion: 1, operationId,
      requestDigest: JSON.parse(String(init?.body)).requestDigest, status: 'uploaded', manifestDigest: 'f'.repeat(64),
      files: [{ path: resources.marker.relativePath, size: resources.marker.content.length, sha256: resources.marker.sha256 }] });
    throw new Error(`unexpected host path ${path}`);
  }) };
  const sync = {
    get: vi.fn(async () => null),
    prepare: vi.fn(async () => { calls.push('sync.prepare'); return { ok: true, phase: 'prepared' }; }),
    uploaded: vi.fn(async () => { calls.push('sync.uploaded'); return { ok: true, phase: 'uploaded' }; }),
    verified: vi.fn(async () => { calls.push('sync.verified'); return { ok: true, phase: 'verified' }; }),
  };
  const verify = vi.fn(async () => { calls.push('sync.verify'); return {
    manifestDigest: 'f'.repeat(64), filesVerified: 1, bytesVerified: resources.marker.content.length,
  }; });
  const capability = new Gate1OperatorCapability({ activityId, generation: 3,
    deadline: Date.now() + 60_000, resources, session, host, sync, verify, ...overrides });
  return { capability, calls, session, host, sync, verify };
}

describe('REQ-OPERATOR-018: platform operator capability binding', () => {
  it('delegates an admitted Gate 1 session through the activity- and generation-bound entrypoint', async () => {
    const deadline = Date.now() + 300_000;
    const human = { subject: 'human-gate1', email: 'owner@example.test', issuer: 'https://access.example.test',
      audiences: ['audience-gate1'], issuedAt: Math.floor(Date.now() / 1000) - 10,
      expiresAt: Math.floor(Date.now() / 1000) + 600 };
    const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'gate1-acceptance', activityId,
      operatorId: 'codeflare-gate1-fixture', runId: 'run-gate1',
      source: { kind: 'direct', reference: 'gate1-session-smoke' },
      revision: { reference: 'gate1-v1', digest: 'a'.repeat(64) }, inputDigest: 'b'.repeat(64),
      input: { scenario: 'session-smoke' }, attachments: [], resources: {
        inference: { routeId: 'route-approved', reasoningLevel: 'high' },
        session: { profileId: 'gate1-pi-file-v1' }, storage: { scopeId: 'gate1-output-v1' },
      } };
    const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
      github: { repositories: [], methods: [] }, storage: {
        readPrefixes: ['Operators/'], writePrefixes: ['Operators/'],
      }, inference: { routeIds: ['route-approved'], defaultRouteId: 'route-approved',
        reasoningLevels: ['off', 'high'], defaultReasoningLevel: 'off', inheritUserDefaults: false } });
    const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
    const executionContext = await createOperatorExecutionContext({ activityId,
      operatorId: 'codeflare-gate1-fixture', artifactDigest: 'd'.repeat(64), policyDigest: 'c'.repeat(64),
      human, accessJwt: 'private.jwt' }, encryption);
    const profile = (await resolveGate1Resources({ invocation: invocation as never,
      operatorId: 'codeflare-gate1-fixture', activityId, ownerBucket: 'owner-bucket', policy,
      policyDigest: 'c'.repeat(64), deadline, human, eligibleInference: {
        routeIds: ['route-approved'], defaultRouteId: 'route-approved', defaultReasoningLevel: 'off',
      } })).profile;
    const activity = {
      getRuntimePlan: vi.fn(async () => ({ activityId, deadline, invocationJson: JSON.stringify(invocation),
        executionContext, receipt: { operatorId: 'codeflare-gate1-fixture', policyJson: JSON.stringify(policy) } })),
      getSync: vi.fn(async () => ({ phase: 'verified', evidence: { filesVerified: 1, bytesVerified: 27 } })),
      getOwnedSession: vi.fn(async () => ({ requestId: 'gate1-session-v1', requestDigest: 'e'.repeat(64),
        activityId, ownerBucket: 'owner-bucket', sessionId: profile.sessionId, profile, status: 'stopped' })),
      saveOwnedSession: vi.fn(),
    };
    const env = { ...encryption, OPERATOR_ACTIVITY: { getByName: vi.fn(() => activity) }, CONTAINER: {},
      R2_ACCOUNT_ID: 'account', R2_ACCESS_KEY_ID: 'access-key', R2_SECRET_ACCESS_KEY: 'secret-key',
    } as unknown as Env;
    const capability = new OperatorRuntimeCapability(
      { props: { activityId, generation: 3 } } as unknown as ExecutionContext, env);

    const response = await capability.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'completed', result: {
      fixture: 'codeflare-gate1', activityId, sessionId: profile.sessionId,
    } });
    expect((await capability.fetch(request(4))).status).toBe(403);
  });

  it('keeps direct-only Gate 1 invocations on the deny-default loopback path', async () => {
    const invocation = { schemaVersion: 1, interfaceVersion: 1, consumerId: 'gate1-acceptance', activityId,
      operatorId: 'codeflare-gate1-fixture', runId: 'run-direct',
      source: { kind: 'direct', reference: 'gate1-direct-smoke' },
      revision: { reference: 'gate1-v1', digest: 'a'.repeat(64) }, inputDigest: 'b'.repeat(64),
      input: { scenario: 'direct-smoke' }, attachments: [],
      resources: { inference: null, session: null, storage: null } };
    const getRuntimePlan = vi.fn(async () => ({ activityId, invocationJson: JSON.stringify(invocation),
      receipt: { operatorId: 'codeflare-gate1-fixture' } }));
    const env = { OPERATOR_ACTIVITY: { getByName: vi.fn(() => ({ getRuntimePlan })) } } as unknown as Env;
    const capability = new OperatorRuntimeCapability(
      { props: { activityId, generation: 3 } } as unknown as ExecutionContext, env);

    expect((await capability.fetch(new Request('https://operator.internal/anything'))).status).toBe(403);
  });

  it('keeps non-Gate operators on a real deny-default loopback entrypoint', async () => {
    const getRuntimePlan = vi.fn(async () => ({ activityId, invocationJson: '{}', receipt: { operatorId: 'reviewer' } }));
    const env = { OPERATOR_ACTIVITY: { getByName: vi.fn(() => ({ getRuntimePlan })) } } as unknown as Env;
    const capability = new OperatorRuntimeCapability(
      { props: { activityId, generation: 3 } } as unknown as ExecutionContext, env);

    const response = await capability.fetch(new Request('https://operator.internal/anything'));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Capability unavailable',
      code: 'OPERATOR_CAPABILITY_DENIED', activityId, generation: 3 });
  });
});

describe('REQ-OPERATOR-005: finite Gate 1 session capability', () => {
  it('owns session, structured Pi, explicit upload, independent verification and stop in order', async () => {
    const { capability, calls, host, sync, verify } = fixture();
    const response = await capability.fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { fixture: 'codeflare-gate1', activityId, sessionId,
        operationId, filesVerified: 1, bytesVerified: resources.marker.content.length } });
    expect(calls).toEqual(['session.ensure', '/internal/operator/pi/ensure', '/internal/operator/pi/tasks',
      'sync.prepare', '/internal/bisync-trigger', 'sync.uploaded', 'sync.verify',
      'sync.verified', 'session.stop']);
    const taskRequest = host.fetch.mock.calls.find(([path]) => path === '/internal/operator/pi/tasks')?.[1];
    expect(JSON.parse(String(taskRequest?.body))).toEqual({ taskId: 'gate1-pi-file-v1',
      digest: expect.stringMatching(/^[0-9a-f]{64}$/), mode: 'tool', toolName: 'write',
      arguments: { path: `/home/user/${resources.marker.storagePath}`, content: resources.marker.content } });
    expect(sync.prepare).toHaveBeenCalledWith(expect.objectContaining({ operationId,
      prefix: `.codeflare/operators/${activityId}/${operationId}/` }));
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operationId,
      prefix: `.codeflare/operators/${activityId}/${operationId}/`, filePrefix: 'Operators/',
      manifestDigest: 'f'.repeat(64) }));
  });

  it('returns a bounded waiting checkpoint without repeating later effects while startup is pending', async () => {
    const { capability, host } = fixture({ session: {
      ensure: vi.fn(async () => ({ status: 'starting' as const })),
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
    } });
    const response = await capability.fetch(request());
    expect(await response.json()).toEqual({ schemaVersion: 1, status: 'waiting',
      checkpoint: { stage: 'session' } });
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it('fails closed on unknown effects and still requests owned stop after a terminal Pi failure', async () => {
    const unknown = fixture({ session: {
      ensure: vi.fn(async () => ({ status: 'unknown' as const })),
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
    } });
    expect(await (await unknown.capability.fetch(request())).json()).toMatchObject({ status: 'failed',
      result: { code: 'GATE1_SESSION_UNKNOWN' } });
    const startupFailure = fixture({ session: {
      ensure: vi.fn(async () => { throw new Error('Gate 1 session startup failed:init-not-ready'); }),
      stop: vi.fn(async () => ({ status: 'stopped' as const })),
    } });
    expect(await (await startupFailure.capability.fetch(request())).json()).toMatchObject({ status: 'failed',
      result: { code: 'GATE1_SESSION_START_INIT_NOT_READY' } });
    const failed = fixture({ host: { fetch: vi.fn(async (path: string) => path.endsWith('/ensure')
      ? Response.json({ ready: true, conversationId: 'conversation-1' })
      : Response.json({ taskId: 'gate1-pi-file-v1', status: 'failed' }, { status: 202 })) } });
    expect(await (await failed.capability.fetch(request())).json()).toMatchObject({ status: 'failed',
      result: { code: 'GATE1_PI_FAILED' } });
    expect(failed.session.stop).toHaveBeenCalledOnce();

    const missingOutput = fixture({ host: { fetch: vi.fn(async (path: string) => {
      if (path.endsWith('/ensure')) return Response.json({ ready: true, conversationId: 'conversation-1' });
      if (path.endsWith('/tasks')) return Response.json({ taskId: 'gate1-pi-file-v1', status: 'completed' }, { status: 202 });
      if (path.includes('/events?')) return Response.json({ events: [
        { sequence: 1, event: { type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write',
          args: { path: `/home/user/${resources.marker.storagePath}`, content: resources.marker.content } } },
        { sequence: 2, event: { type: 'tool_execution_end', toolCallId: 'write-1', toolName: 'write', isError: false } },
      ], nextCursor: 2, gap: false });
      return Response.json({ error: 'Sync output is unavailable', code: 'SYNC_OUTPUT_NOT_FOUND' }, { status: 409 });
    }) } });
    expect(await (await missingOutput.capability.fetch(request())).json()).toMatchObject({ status: 'failed',
      result: { code: 'GATE1_SYNC_OUTPUT_NOT_FOUND' } });
    expect(missingOutput.session.stop).toHaveBeenCalledOnce();

    const stateFailure = fixture({ host: { fetch: vi.fn(async (path: string) => {
      if (path.endsWith('/ensure')) return Response.json({ ready: true, conversationId: 'conversation-1' });
      if (path.endsWith('/tasks')) return Response.json({ taskId: 'gate1-pi-file-v1', status: 'completed' }, { status: 202 });
      if (path.includes('/events?')) return Response.json({ events: [
        { sequence: 1, event: { type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write',
          args: { path: `/home/user/${resources.marker.storagePath}`, content: resources.marker.content } } },
        { sequence: 2, event: { type: 'tool_execution_end', toolCallId: 'write-1', toolName: 'write', isError: false } },
      ], nextCursor: 2, gap: false });
      return Response.json({ error: 'Sync state is unavailable', code: 'SYNC_STATE_FAILED' }, { status: 503 });
    }) } });
    expect(await (await stateFailure.capability.fetch(request())).json()).toMatchObject({ status: 'failed',
      result: { code: 'GATE1_SYNC_STATE_FAILED' } });
    expect(stateFailure.session.stop).toHaveBeenCalledOnce();
  });

  it('rejects every route, method, query, oversized body and stale generation outside the fixed contract', async () => {
    const { capability, session } = fixture();
    expect((await capability.fetch(new Request('https://operator.invalid/other'))).status).toBe(404);
    expect((await capability.fetch(new Request('https://operator.invalid/v1/gate1/session'))).status).toBe(405);
    expect((await capability.fetch(new Request('https://operator.invalid/v1/gate1/session?x=1', { method: 'POST' }))).status).toBe(400);
    expect((await capability.fetch(request(2))).status).toBe(403);
    expect((await capability.fetch(new Request('https://operator.invalid/v1/gate1/session', { method: 'POST',
      body: 'x'.repeat(65 * 1024) }))).status).toBe(413);
    expect(session.ensure).not.toHaveBeenCalled();
  });
});
