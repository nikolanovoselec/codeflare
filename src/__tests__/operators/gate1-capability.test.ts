import { describe, expect, it, vi } from 'vitest';
import { Gate1OperatorCapability, type Gate1CapabilityOptions } from '../../operators/gate1-capability';
import type { Gate1Resources } from '../../operators/gate1-resources';

const activityId = 'activity-gate1';
const operationId = 'gate1-output-v1';
const resources = {
  profile: { activityId, sessionId: `gate1-${activityId}`, policyDigest: 'c'.repeat(64),
    outputPrefix: `operator-fixtures/gate-1/${activityId}/gate1-${activityId}/` },
  effectiveInference: { routeId: 'route-approved', reasoningLevel: 'high' },
  marker: { relativePath: 'gate1-marker.txt', storagePath: `operator-fixtures/gate-1/${activityId}/gate1-${activityId}/gate1-marker.txt`,
    content: 'codeflare-gate1-marker-v1\n', sha256: 'd'.repeat(64) },
} as unknown as Gate1Resources;
const request = (generation = 3) => new Request('https://operator.invalid/v1/gate1/session', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ schemaVersion: 1, activityId, generation, checkpoint: null }),
});

function fixture(overrides: Partial<Gate1CapabilityOptions> = {}) {
  const calls: string[] = [];
  const session = {
    ensure: vi.fn(async () => { calls.push('session.ensure'); return { status: 'ready' }; }),
    stop: vi.fn(async () => { calls.push('session.stop'); return { status: 'stopped' }; }),
  };
  const host = { fetch: vi.fn(async (path: string, init?: RequestInit) => {
    calls.push(path);
    if (path.endsWith('/ensure')) return Response.json({ conversationId: 'conversation-1', ready: true });
    if (path.endsWith('/tasks')) return Response.json({ taskId: 'gate1-pi-file-v1', status: 'completed' }, { status: 202 });
    if (path.endsWith('/operations')) return Response.json({ schemaVersion: 1, operationId,
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

describe('REQ-OPERATOR-005: finite Gate 1 session capability', () => {
  it('owns session, structured Pi, explicit upload, independent verification and stop in order', async () => {
    const { capability, calls, sync, verify } = fixture();
    const response = await capability.fetch(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { fixture: 'codeflare-gate1', activityId, sessionId: `gate1-${activityId}`,
        operationId, filesVerified: 1, bytesVerified: resources.marker.content.length } });
    expect(calls).toEqual(['session.ensure', '/internal/operator/pi/ensure', '/internal/operator/pi/tasks',
      'sync.prepare', '/internal/operator/sync/operations', 'sync.uploaded', 'sync.verify',
      'sync.verified', 'session.stop']);
    expect(sync.prepare).toHaveBeenCalledWith(expect.objectContaining({ operationId,
      prefix: `${resources.profile.outputPrefix}${operationId}/` }));
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ operationId,
      prefix: `${resources.profile.outputPrefix}${operationId}/`, manifestDigest: 'f'.repeat(64) }));
  });

  it('returns a bounded waiting checkpoint without repeating later effects while startup is pending', async () => {
    const { capability, host } = fixture({ session: {
      ensure: vi.fn(async () => ({ status: 'starting' })), stop: vi.fn(),
    } });
    const response = await capability.fetch(request());
    expect(await response.json()).toEqual({ schemaVersion: 1, status: 'waiting',
      checkpoint: { stage: 'session' } });
    expect(host.fetch).not.toHaveBeenCalled();
  });

  it('fails closed on unknown effects and still requests owned stop after a terminal Pi failure', async () => {
    const unknown = fixture({ session: { ensure: vi.fn(async () => ({ status: 'unknown' })), stop: vi.fn() } });
    expect(await (await unknown.capability.fetch(request())).json()).toMatchObject({ status: 'failed',
      result: { code: 'GATE1_SESSION_UNKNOWN' } });
    const failed = fixture({ host: { fetch: vi.fn(async (path: string) => path.endsWith('/ensure')
      ? Response.json({ ready: true, conversationId: 'conversation-1' })
      : Response.json({ taskId: 'gate1-pi-file-v1', status: 'failed' }, { status: 202 })) } });
    expect(await (await failed.capability.fetch(request())).json()).toMatchObject({ status: 'failed',
      result: { code: 'GATE1_PI_FAILED' } });
    expect(failed.session.stop).toHaveBeenCalledOnce();
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
