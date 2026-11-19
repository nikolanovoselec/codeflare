import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../types';
import { OperatorOwnerInferenceAuthority } from '../../operators/dispatcher-owner-inference';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class { constructor(public ctx: unknown, public env: Env) {} },
  DurableObject: class {}, RpcTarget: class {},
}));
vi.mock('@cloudflare/containers', () => ({ getContainer: vi.fn() }));
vi.mock('agents', () => ({ Agent: class {} }));
const authority = vi.hoisted(() => ({ generation: 7, denied: false }));
vi.mock('../../lib/container-helpers', async original => ({
  ...await original<typeof import('../../lib/container-helpers')>(),
  getPersonalPiSession: async (_container: unknown, ref: { bucket: string; sessionId: string; email: string }) => {
    if (authority.denied || ref.bucket !== 'owner-bucket' || ref.sessionId !== 'ownersession'
      || ref.email !== 'owner@example.test') throw Error('Owner unavailable');
    return { generation: authority.generation, groups: [] };
  },
}));
beforeEach(() => { authority.generation = 7; authority.denied = false; });
afterEach(() => vi.restoreAllMocks());

function fixture(read = async () => ({ boundaryActions: [] as unknown[] })) {
  const env = { CONTAINER: { getByName: () => ({}) },
    OPERATOR_REGISTRY: { getByName: () => ({ getManagementControls: read }) },
  } as unknown as Env;
  const endpoint = new OperatorOwnerInferenceAuthority({ props: {
    bucket: 'owner-bucket', sessionId: 'ownersession', email: 'owner@example.test',
  } } as unknown as ExecutionContext, env);
  return (body: unknown = { repository: 'owner/repo' }) => endpoint.fetch(new Request(
    'https://operator.internal/v1/review/applicability', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}

describe('REQ-OPERATOR-053: owner-bound Review enrollment preflight', () => {
  it('selects local without Activity, Conductor, browser authority or GitHub discovery', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('GitHub unavailable'); });
    const response = await fixture()();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ selection: 'local' });
  });
  it('rejects a caller-supplied foreign owner', async () => {
    const response = await fixture()({ repository: 'owner/repo', bucket: 'foreign' });
    expect(response.status).toBe(403);
  });
  it('requires current parent-bound ordinary-session authority', async () => {
    authority.denied = true;
    expect((await fixture()()).status).toBe(403);
  });
  it('rejects a generation change during Registry I/O', async () => {
    const response = await fixture(async () => {
      authority.generation += 1;
      return { boundaryActions: [] };
    })();
    expect(response.status).toBe(403);
  });
  it('reports unavailable rather than local when Registry read fails', async () => {
    const response = await fixture(async () => { throw Error('Registry unavailable'); })();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ selection: 'unavailable' });
  });
});
