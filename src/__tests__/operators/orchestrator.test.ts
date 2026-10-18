import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { prepareOperatorActivity, runOperatorActivity } from '../../operators/orchestrator';
import { createOperatorIntentDigest } from '../../operators/activity';
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('REQ-OPERATOR-018: request-attached production orchestration', () => {
  it('uses only a parent-reserved activity identity when preparing a boundary handoff', async () => {
    const reserved = 'reservation-activity';
    let persisted: { activityId: string; operatorId: string } | null = null;
    const env = { ...encryption,
      OPERATOR_REGISTRY: { getByName: () => ({ resolveForExecution: async () => ({ ok: true, value: {
        operatorId: 'reviewer', revision: 7, artifactDigest: 'a'.repeat(64), manifestJson: '{}', policyJson: '{}',
      } }) }) },
      OPERATOR_ACTIVITY: { getByName: () => ({ prepareAuthorized: async (intent: typeof persisted) => {
        persisted = intent; return { ok: true, phase: 'prepared' };
      } }) },
    } as unknown as Env;
    const result = await prepareOperatorActivity({ operatorId: 'reviewer',
      invocation: { activityId: 'caller-selected' } }, { human: claims, accessJwt: 'private.jwt' }, env,
    { activityId: reserved });
    expect(result.activityId).toBe(reserved);
    expect(persisted).toMatchObject({ activityId: reserved, operatorId: 'reviewer' });
    expect(result.activityId).not.toBe('caller-selected');
  });
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

  it('rejects the retired Gate 1 fixture before Registry or Activity I/O', async () => {
    const resolveForExecution = vi.fn();
    const prepareAuthorized = vi.fn();
    const env = { ...encryption,
      OPERATOR_REGISTRY: { getByName: () => ({ resolveForExecution }) },
      OPERATOR_ACTIVITY: { getByName: () => ({ prepareAuthorized }) },
    } as unknown as Env;
    await expect(prepareOperatorActivity({ operatorId: 'codeflare-gate1-fixture', invocation: {} },
      { human: claims, accessJwt: 'private.jwt' }, env)).rejects.toMatchObject({ statusCode: 404 });
    expect(resolveForExecution).not.toHaveBeenCalled();
    expect(prepareAuthorized).not.toHaveBeenCalled();
  });

  it('uses the admission-pinned distribution and direct-only deny-default bindings for one bounded drive', async () => {
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

    const loopback = { fetch: vi.fn(async () => new Response('loopback')) } as unknown as Fetcher;
    let capturedDeadline = 0;
    const bindLoopback = vi.fn((_activityId: string, _generation: number, driveDeadline: number) => {
      capturedDeadline = driveDeadline;
      return loopback;
    });
    const startedAt = Date.now();
    await runOperatorActivity('activity-1', env, bindLoopback);

    expect(registry.getPinnedDistribution).toHaveBeenCalledWith('activity-1');
    expect(fetch).toHaveBeenCalledOnce();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toMatchObject({ redirect: 'manual' });
    expect(loaded?.globalOutbound).toBeNull();
    expect(capturedDeadline).toBeGreaterThan(startedAt);
    expect(capturedDeadline).toBeLessThanOrEqual(startedAt + 30_000);
    expect(loaded?.env.OPERATOR).toBe(loopback);
    expect(requestBody).toMatchObject({ activityId: 'activity-1', generation: 1,
      invocation: { repository: 'owner/repo' } });
    expect(activity.commitDrive).toHaveBeenCalledOnce();
    expect(activity.interruptDrive).not.toHaveBeenCalled();
    expect(activity.fenceRuntimeFailure).not.toHaveBeenCalled();
  });

  it('aborts and fences a stalled child drive within the request-attached deadline', async () => {
    vi.useFakeTimers();
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
    const commitDrive = vi.fn();
    const interruptDrive = vi.fn(async () => ({ ok: true,
      state: { generation: 2, status: 'unknown', checkpoint: null, result: null } }));
    const fenceRuntimeFailure = vi.fn();
    let aborted = false;
    const activity = {
      getRuntimePlan: vi.fn(async () => ({ activityId: 'activity-1', deadline: Date.now() + 60_000,
        invocationJson: 'null', executionContext: context,
        receipt: { activityId: 'activity-1', operatorId: 'reviewer', intentDigest: 'c'.repeat(64), expectedRevision: 7,
          deadline: Date.now() + 60_000, artifactDigest, admittedAt: Date.now(), manifestJson, policyJson: '{}' } })),
      beginDrive: vi.fn(async () => ({ ok: true,
        state: { generation: 1, status: 'running', checkpoint: null, result: null } })),
      commitDrive,
      interruptDrive,
      fenceRuntimeFailure,
    };
    const loader = { load: vi.fn(() => ({ getEntrypoint: () => ({ fetch: async (request: Request) =>
      new Promise<Response>((_resolve, reject) => request.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      }, { once: true })) }) })) };
    const registry = { getPinnedDistribution: vi.fn(async () => ({ endpoint, connectionSecretCiphertext: ciphertext })) };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(bytes.byteLength) } })));
    const env = { ...encryption, LOADER: loader,
      OPERATOR_ACTIVITY: { getByName: () => activity }, OPERATOR_REGISTRY: { getByName: () => registry },
    } as unknown as Env;

    const attempt = runOperatorActivity('activity-1', env,
      () => ({ fetch: vi.fn() }) as unknown as Fetcher);
    await vi.advanceTimersByTimeAsync(25_001);
    await attempt;

    expect(aborted).toBe(true);
    expect(interruptDrive).toHaveBeenCalledOnce();
    expect(commitDrive).not.toHaveBeenCalled();
    expect(fenceRuntimeFailure).not.toHaveBeenCalled();
  });

  it('fences a failed attached runtime attempt without scheduling a replay', async () => {
    const fenceRuntimeFailure = vi.fn(async () => ({ ok: true, state: { status: 'unknown' } }));
    const activity = { getRuntimePlan: vi.fn(async () => ({ activityId: 'activity-1', deadline: Date.now() + 60_000,
      invocationJson: 'null', receipt: {}, executionContext: {} })), fenceRuntimeFailure };
    const env = { OPERATOR_ACTIVITY: { getByName: () => activity },
      OPERATOR_REGISTRY: { getByName: vi.fn() } } as unknown as Env;
    await runOperatorActivity('activity-1', env,
      () => ({ fetch: vi.fn() }) as unknown as Fetcher);
    expect(fenceRuntimeFailure).toHaveBeenCalledOnce();
    expect(activity.getRuntimePlan).toHaveBeenCalledOnce();
    expect(env.OPERATOR_REGISTRY!.getByName).not.toHaveBeenCalled();
  });
});


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  function configured(configuration: unknown = { renovate: { repository: 'acme/updates', automaticRuns: false,
    repetitionIntervalSeconds: 900 } }, intentVersion = '3') {
    const prepared: Array<{ intent: { activityId: string; intentDigest: string }; invocation: string }> = [];
    const selection = { controlsRevision: 1, installation: { id: 'configured-install', revision: 2,
      enabled: true, releaseId: 'release', configurationJson: JSON.stringify(configuration),
      policy: { capabilities: ['fetch'], resourceProfileId: null } },
      operator: { operatorId: 'renovate-dispatcher', profile: 'dispatcher', revision: 1,
        invokers: { users: [claims.email], groups: [] } }, release: { id: 'release', bundleDigest: 'a'.repeat(64) },
      manifestJson: JSON.stringify({ id: 'renovate-dispatcher', profile: 'dispatcher', intentVersion }) };
    const host = { ...encryption, OPERATOR_REGISTRY: { getByName: () => ({
      resolveManagementExecution: async () => ({ ok: true, value: selection }) }) },
      OPERATOR_ACTIVITY: { getByName: () => ({ prepareAuthorized: async (intent: typeof prepared[number]['intent'],
        _context: unknown, invocation: string) => { prepared.push({ intent, invocation }); return { ok: true }; } }) },
    } as unknown as Env;
    return { prepared, host, selection };
  }
  it.each([{}, { repository: 'acme/updates' }])('materializes only the configured repository before immutable admission for %j', async invocation => {
    const f = configured();
    const result = await prepareOperatorActivity({ installationId: 'configured-install', invocation },
      { human: claims, accessJwt: 'private.jwt' }, f.host);
    expect(f.prepared).toEqual([{ intent: expect.objectContaining({ activityId: result.activityId,
      intentDigest: await createOperatorIntentDigest('renovate-dispatcher', result.activityId, '{"repository":"acme/updates"}') }),
      invocation: '{"repository":"acme/updates"}' }]);
  });
  it.each([{ repository: 'other/repo' }, { repository: '' }, { repository: 'https://github.com/acme/updates' },
    { repository: 'acme/updates', pullRequest: 17 }, { repository: 'acme/updates', repetitionIntervalSeconds: 900 },
    { repository: 'acme/updates', automaticRuns: true }, { repository: 17 }, null, [], 'acme/updates'])
    ('rejects changed or malformed manual input %j before any prepared admission', async invocation => {
      const f = configured();
      await expect(prepareOperatorActivity({ installationId: 'configured-install', invocation },
        { human: claims, accessJwt: 'private.jwt' }, f.host)).rejects.toBeDefined();
      expect(f.prepared).toEqual([]);
    });
  it.each([{}, { renovate: { automaticRuns: true } }])('requires saved repository even for an explicit input when settings are %j', async configuration => {
    for (const invocation of [{}, { repository: 'nikolanovoselec/komodo' }]) {
      const f = configured(configuration);
      await expect(prepareOperatorActivity({ installationId: 'configured-install', invocation },
        { human: claims, accessJwt: 'private.jwt' }, f.host)).rejects.toBeDefined();
      expect(f.prepared).toEqual([]);
    }
  });
  it('does not reinterpret legacy single-PR input as configured intent3', async () => {
    const f = configured({}, '2');
    await prepareOperatorActivity({ installationId: 'configured-install', invocation: { repository: 'other/repo', pullRequest: 17 } },
      { human: claims, accessJwt: 'private.jwt' }, f.host);
    expect(f.prepared.map(value => JSON.parse(value.invocation))).toEqual([{ repository: 'other/repo', pullRequest: 17 }]);
  });
  it('pins the reservation selection before preparation and never rewrites an already-prepared invocation after settings change', async () => {
    const f = configured();
    const authority = { human: claims, accessJwt: 'private.jwt' };
    await prepareOperatorActivity({ installationId: 'configured-install', invocation: {} }, authority, f.host);
    const original = structuredClone(f.prepared);
    f.selection.installation.revision++;
    f.selection.installation.configurationJson = JSON.stringify({ renovate: {
      repository: 'other/service', automaticRuns: true, repetitionIntervalSeconds: 7200 } });
    await expect(prepareOperatorActivity({ installationId: 'configured-install', invocation: { repository: 'acme/updates' } },
      authority, f.host, { activityId: 'reserved-old-generation', expectedManagement: { controlsRevision: 1,
        installationRevision: 2, operatorRevision: 1, releaseId: 'release', bundleDigest: 'a'.repeat(64) } }))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(f.prepared).toEqual(original);
  });

});
