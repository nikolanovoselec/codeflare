import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { prepareOperatorActivity, runOperatorActivity } from '../../operators/orchestrator';
import { createOperatorExecutionContext } from '../../operators/execution-context';
import { sealOperatorSecret } from '../../operators/protected-secrets';

const claims = {
  subject: 'owner', email: 'owner@example.test', issuer: 'https://access.example.test', audiences: ['audience'],
  issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 300,
};
const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };

async function sha256(bytes: Uint8Array | string): Promise<string> {
  const value = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

afterEach(() => vi.unstubAllGlobals());

describe('REQ-OPERATOR-003: request-attached production orchestration', () => {
  it('server-generates activity authority and persists bounded invocation before returning a start capability', async () => {
    const prepareAuthorized = vi.fn(async () => ({ ok: true, phase: 'prepared' }));
    const registry = { resolveForExecution: vi.fn(async () => ({ ok: true, value: {
      operatorId: 'reviewer', revision: 7, artifactDigest: 'a'.repeat(64), manifestJson: '{}', policyJson: '{"schemaVersion":1}',
    } })) };
    const env = { ...encryption,
      OPERATOR_REGISTRY: { getByName: () => registry },
      OPERATOR_ACTIVITY: { getByName: () => ({ prepareAuthorized }) },
    } as unknown as Env;
    const result = await prepareOperatorActivity({ operatorId: 'reviewer', invocation: { repository: 'owner/repo' } },
      { human: claims, accessJwt: 'private.jwt' }, env);

    expect(result.activityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.startCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.startExpiresAt).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    expect(registry.resolveForExecution).toHaveBeenCalledWith('reviewer');
    expect(prepareAuthorized).toHaveBeenCalledWith(expect.objectContaining({ activityId: result.activityId,
      operatorId: 'reviewer', expectedRevision: 7, startVerifier: expect.stringMatching(/^[0-9a-f]{64}$/) }),
    expect.objectContaining({ activityId: result.activityId, operatorId: 'reviewer',
      protectedAccessCiphertext: expect.stringMatching(/^v1:/) }), '{"repository":"owner/repo"}');
    expect(JSON.stringify(prepareAuthorized.mock.calls[0])).not.toContain('private.jwt');
  });

  it('uses the admission-pinned distribution and direct-only deny-default bindings for one drive', async () => {
    const bundle = { schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05',
      compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js', modules: { 'index.js': { js: 'export default {}' } } };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const artifactDigest = await sha256(bytes);
    const endpoint = 'https://publisher.example.test/operator.json';
    const manifestJson = JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'reviewer', name: 'Reviewer',
      description: '', coreVersion: '1', intentVersion: '1', inputSchema: {}, requiredCapabilities: [],
      artifact: { path: '/bundle.json', sha256: artifactDigest, url: 'https://publisher.example.test/bundle.json' } });
    const context = await createOperatorExecutionContext({ activityId: 'activity-1', operatorId: 'reviewer',
      artifactDigest, policyDigest: 'b'.repeat(64), human: claims, accessJwt: 'private.jwt' }, encryption);
    const ciphertext = await sealOperatorSecret('connection-secret', encryption,
      { purpose: 'connection', recordId: 'reviewer' });
    const activity = {
      getRuntimePlan: vi.fn(async () => ({ activityId: 'activity-1', deadline: Date.now() + 60_000,
        invocationJson: '{"repository":"owner/repo"}', executionContext: context,
        receipt: { activityId: 'activity-1', operatorId: 'reviewer', intentDigest: 'c'.repeat(64), expectedRevision: 7,
          deadline: Date.now() + 60_000, artifactDigest, admittedAt: Date.now(), manifestJson, policyJson: '{}' } })),
      beginDrive: vi.fn(async () => ({ ok: true, state: { generation: 1, status: 'running', checkpoint: null, result: null } })),
      commitDrive: vi.fn(async (_generation: number, update: unknown) => ({ ok: true, state: update })),
      interruptDrive: vi.fn(async () => ({ ok: true, state: { generation: 2, status: 'unknown', checkpoint: null, result: null } })),
      fenceRuntimeFailure: vi.fn(async () => ({ ok: true, state: { generation: 1, status: 'unknown', checkpoint: null, result: null } })),
    };
    interface LoadedOptions { env: { OPERATOR: Fetcher }; globalOutbound: Fetcher | null }
    let loaded: LoadedOptions | undefined;
    let requestBody: unknown;
    const loader = { load: vi.fn((options: LoadedOptions) => {
      loaded = options;
      return { getEntrypoint: () => ({ fetch: async (request: Request) => {
        requestBody = await request.json();
        return Response.json({ schemaVersion: 1, status: 'completed', checkpoint: null, result: { ok: true } });
      } }) };
    }) };
    const registry = { getPinnedDistribution: vi.fn(async () => ({ endpoint, connectionSecretCiphertext: ciphertext })) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) } })));
    const env = { ...encryption, LOADER: loader,
      OPERATOR_ACTIVITY: { getByName: () => activity }, OPERATOR_REGISTRY: { getByName: () => registry },
    } as unknown as Env;

    await runOperatorActivity('activity-1', env);

    expect(registry.getPinnedDistribution).toHaveBeenCalledWith('activity-1');
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ redirect: 'manual' });
    expect(loaded?.globalOutbound).toBeNull();
    expect((await loaded!.env.OPERATOR.fetch('https://operator.internal/capability')).status).toBe(403);
    expect(requestBody).toMatchObject({ activityId: 'activity-1', generation: 1,
      invocation: { repository: 'owner/repo' } });
    expect(activity.commitDrive).toHaveBeenCalledOnce();
    expect(activity.interruptDrive).not.toHaveBeenCalled();
    expect(activity.fenceRuntimeFailure).not.toHaveBeenCalled();
  });

  it('fences a failed attached runtime attempt without scheduling a replay', async () => {
    const fenceRuntimeFailure = vi.fn(async () => ({ ok: true, state: { status: 'unknown' } }));
    const activity = { getRuntimePlan: vi.fn(async () => ({ activityId: 'activity-1', deadline: Date.now() + 60_000,
      invocationJson: 'null', receipt: {}, executionContext: {} })), fenceRuntimeFailure };
    const env = { OPERATOR_ACTIVITY: { getByName: () => activity },
      OPERATOR_REGISTRY: { getByName: vi.fn() } } as unknown as Env;
    await runOperatorActivity('activity-1', env);
    expect(fenceRuntimeFailure).toHaveBeenCalledOnce();
    expect(activity.getRuntimePlan).toHaveBeenCalledOnce();
    expect(env.OPERATOR_REGISTRY!.getByName).not.toHaveBeenCalled();
  });
});
