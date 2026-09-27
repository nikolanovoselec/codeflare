import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import type { DispatcherBundle } from '../../operators/distribution';
import { OperatorRuntimeCapability } from '../../operators/operator-runtime-capability';
import { loadOperatorDispatcherClass } from '../../operators/loader';

const activityId = 'dispatcher-activity';
const generation = 4;
const headSha = 'a'.repeat(40);

type RuntimePlan = {
  activityId: string;
  deadline: number;
  invocationJson: string;
  receipt: { operatorId: string; profile: 'dispatcher'; artifactDigest: string; policyJson: string };
};

function fixture(planOverrides: Partial<RuntimePlan> = {}) {
  const plan: RuntimePlan = {
    activityId, deadline: Date.now() + 60_000,
    invocationJson: JSON.stringify({ repository: 'owner/repository', pullRequest: 17, headSha }),
    receipt: { operatorId: 'renovate-dispatcher', profile: 'dispatcher', artifactDigest: 'b'.repeat(64), policyJson: '{"capabilities":["renovate"]}' },
    ...planOverrides,
  };
  const activity = { getRuntimePlan: async () => plan };
  const env = { OPERATOR_ACTIVITY: { getByName: () => activity } } as unknown as Env;
  const capability = new OperatorRuntimeCapability(
    { props: { activityId, generation } } as unknown as ExecutionContext, env,
  );
  const request = (path = '/v1/dispatcher/renovate', method = 'POST', body: unknown = {
    repository: 'owner/repository', pullRequest: 17, headSha,
  }) => new Request(`https://operator.internal${path}`, {
    method,
    ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  return { capability, request };
}

// Mock capability coverage only. Native Flue proof lives in loader-runtime.test.ts.
describe('REQ-OPERATOR-048: Dispatcher mocked capability contract', () => {
  it('runs approved Dispatcher work through the activity- and generation-bound capability without a session', async () => {
    const { capability, request } = fixture();

    const response = await capability.fetch(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schemaVersion: 1, status: expect.stringMatching(/waiting|completed/),
      result: expect.objectContaining({ activityId, generation, repository: 'owner/repository', pullRequest: 17, headSha }) });
  });

  it('denies profile substitutions, session/container requests, and mutation paths at the mocked capability boundary', async () => {
    const { capability, request } = fixture();
    const attempts = [
      request('/v1/dispatcher/renovate', 'POST', { repository: 'owner/repository', pullRequest: 17, headSha, profile: 'conductor' }),
      request('/v1/dispatcher/renovate', 'POST', { repository: 'owner/repository', pullRequest: 17, headSha, sessionId: 'session-1' }),
      request('/v1/dispatcher/renovate', 'POST', { repository: 'owner/repository', pullRequest: 17, headSha, mutation: { method: 'PATCH' } }),
      request('/v1/dispatcher/session', 'POST', {}),
    ];

    for (const attempt of attempts) expect((await capability.fetch(attempt)).status).toBe(403);
  });
});

const bundle: DispatcherBundle = {
  schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' },
  className: 'FlueDispatcherAgent', compatibilityDate: '2026-09-10',
  compatibilityFlags: ['nodejs_compat'], mainModule: 'index.js',
  modules: { 'index.js': { js: 'export class FlueDispatcherAgent {}' } },
};

describe('REQ-OPERATOR-018: retired Gate 1 execution', () => {
  it('denies an old prepared fixture receipt without constructing a session', async () => {
    const activity = { getRuntimePlan: async () => ({ activityId: 'old-gate1',
      receipt: { operatorId: 'codeflare-gate1-fixture' },
      invocationJson: '{"resources":{"session":{"profileId":"gate1-pi-file-v1"}}}',
    }) };
    const env = { OPERATOR_ACTIVITY: { getByName: () => activity } } as unknown as Env;
    const runtime = new OperatorRuntimeCapability(
      { props: { activityId: 'old-gate1', generation: 1 } } as unknown as ExecutionContext, env);
    expect((await runtime.fetch(new Request('https://operator.internal/v1/fixture'))).status).toBe(403);
  });
});

describe('REQ-OPERATOR-048: production Dispatcher Loader host', () => {
  it('loads the approved generated class with only a generation-bound capability and denied direct outbound', () => {
    const generatedClass = class {};
    let codeFactory: (() => Promise<unknown>) | undefined;
    const getDurableObjectClass = vi.fn(() => generatedClass);
    const loader = { get: vi.fn((_key: string, factory: () => Promise<unknown>) => {
      codeFactory = factory;
      return { getDurableObjectClass };
    }) };
    const capability = { fetch: vi.fn() } as unknown as Fetcher;

    const digest = 'b'.repeat(64);
    const loaded = loadOperatorDispatcherClass(loader, bundle, digest, 'activity-1', 3, capability);

    expect(loaded).toBe(generatedClass);
    expect(loader.get).toHaveBeenCalledWith(`dispatcher:activity-1:${digest}:3`, expect.any(Function));
    expect(getDurableObjectClass).toHaveBeenCalledWith('FlueDispatcherAgent');
    return expect(codeFactory!()).resolves.toEqual({
      compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'],
      mainModule: 'index.js', modules: bundle.modules, env: { OPERATOR: capability }, globalOutbound: null,
    });
  });

  it('rejects invalid activity identities and generations before asking Loader for a class', () => {
    const loader = { get: vi.fn() };
    const capability = {} as Fetcher;

    expect(() => loadOperatorDispatcherClass(loader, bundle, 'b'.repeat(64), '../other', 1, capability)).toThrow();
    expect(() => loadOperatorDispatcherClass(loader, bundle, 'b'.repeat(64), 'activity-1', 0, capability)).toThrow();
    expect(() => loadOperatorDispatcherClass(loader, bundle, 'not-a-digest', 'activity-1', 1, capability)).toThrow();
    expect(loader.get).not.toHaveBeenCalled();
  });
});
