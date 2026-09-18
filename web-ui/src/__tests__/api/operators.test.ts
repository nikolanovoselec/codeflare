/**
 * Browser wire-contract tests: canonical paths, authenticated transport, response validation and
 * explicit mutation payloads. Conflict handling must not silently replay a mutation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listOperators, getOperator, registerOperator, discoverOperator, approveOperator, setOperatorEnabled,
  setOperatorDistribution, setOperatorPolicy, rotateOperatorWebhookKey, type OperatorPolicyInput } from '../../api/operators';
import { cancelOperatorActivity } from '../../api/operator-activities';

const fetchMock = vi.fn();
const registration = { operatorId: 'operator', revision: 2, enabled: false, approvedArtifactDigest: null };
const policy: OperatorPolicyInput = { schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
  storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
    reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } };
const detail = { registration, endpoint: 'https://operator.example.test/', connectionSecretConfigured: true,
  webhookKeyConfigured: false, discoveredManifestJson: null, approvedManifestJson: null, policyJson: JSON.stringify(policy) };
beforeEach(() => { vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe('REQ-OPERATOR-008: operator administration client', () => {
  it.each([
    { path: '', method: 'GET', call: () => listOperators(), response: { operators: [registration] } },
    { path: '/operator', method: 'GET', call: () => getOperator('operator'), response: detail },
    { path: '', method: 'POST', call: () => registerOperator({ endpoint: detail.endpoint, connectionSecret: 'secret', policy }), response: registration },
    { path: '/operator/discover', method: 'POST', call: () => discoverOperator('operator'), response: { manifestJson: '{}' } },
    { path: '/operator/approve', method: 'POST', call: () => approveOperator('operator', 2, 'a'.repeat(64)), response: registration },
    { path: '/operator/enable', method: 'POST', call: () => setOperatorEnabled('operator', 2, true), response: registration },
    { path: '/operator/distribution', method: 'POST', call: () => setOperatorDistribution('operator', 2, detail.endpoint, 'secret'), response: registration },
    { path: '/operator/policy', method: 'POST', call: () => setOperatorPolicy('operator', 2, policy), response: registration },
    { path: '/operator/webhook-key', method: 'POST', call: () => rotateOperatorWebhookKey('operator', 2), response: { registration, key: 'k'.repeat(43) } },
  ])('uses the authenticated canonical API for $method $path', async ({ path, method, call, response }) => {
    fetchMock.mockResolvedValue(Response.json(response));
    expect(await call()).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/operators${path}`, expect.objectContaining({ method, credentials: 'same-origin', redirect: 'manual' }));
  });
  it('sends explicit revision and digest without implicit enablement or retry', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'Revision conflict', code: 'CONFLICT' }, { status: 409 }));
    await expect(approveOperator('operator', 2, 'a'.repeat(64))).rejects.toThrow('Revision conflict');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ expectedRevision: 2, artifactDigest: 'a'.repeat(64) });
  });
  it('rejects malformed response shapes rather than treating them as an empty registry', async () => {
    fetchMock.mockResolvedValue(Response.json({ operators: 'unavailable' }));
    await expect(listOperators()).rejects.toThrow();
  });
});

describe('REQ-OPERATOR-036: activity client mutations are not replayed automatically', () => {
  it('submits cancellation once when the server rejects it', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'Cancellation conflict', code: 'CONFLICT' }, { status: 409 }));

    await expect(cancelOperatorActivity('activity-1')).rejects.toThrow('Cancellation conflict');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/operator-activities/activity-1/cancel', expect.objectContaining({
      method: 'POST', body: '{}', credentials: 'same-origin', redirect: 'manual',
    }));
  });
});
