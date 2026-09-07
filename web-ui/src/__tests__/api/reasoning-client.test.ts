import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getReasoningCatalog, getReasoningRouteInventory, discoverReasoningCompatibility } from '../../api/client';

const fetchMock = vi.fn();
const gateway = { gatewayUrl: 'https://gateway.ai.cloudflare.com/v1/account/gateway', replacementToken: 'draft-test-token' };
const profileRef = { id: 'custom-team', revision: 1, hash: 'a'.repeat(64) };
const verification = { schemaVersion: 1, profileRef, routeVersion: 'v1', inventoryDigest: 'd'.repeat(64), connectionFingerprint: 'f'.repeat(64), canaryVersion: 'canary', supportedLevels: ['medium'], scope: 'single-model', checkedAt: '2026-09-06T12:00:00Z' };
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());

describe('Enterprise Pi administration transport', () => {
  it('rejects an unknown authority method instead of silently relabeling it', async () => {
    fetchMock.mockResolvedValueOnce(response({ classification: 'Administrator-confirmed', assignable: true,
      checkId: 'check-id', verification: { ...verification, method: 'unknown' } }));
    await expect(discoverReasoningCompatibility({ route: 'team', profileRef, administratorConfirmed: true, maxCompletionTokens: 4096 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('REQ-ENTERPRISE-042: checks a draft connection and retains its sanitized status', async () => {
    fetchMock.mockResolvedValueOnce(response({ schemaVersion: 1, profiles: [], notices: [], usage: [], routes: ['team'], routeCatalogStatus: 'ready', connection: { status: 'ready', message: 'Routes can be read.' } }));
    const result = await getReasoningCatalog(gateway);
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/reasoning/catalog');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toEqual({ gateway });
    expect(result.connection).toEqual({ status: 'ready', message: 'Routes can be read.' });
    expect(result).not.toHaveProperty('replacementToken');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 'administrator'] as const)('REQ-ENTERPRISE-043: retains %s authority through real discovery and inventory response parsing', async (method) => {
    const authority = { ...verification, ...(method && { method }) };
    const context = { gateway, backendDescriptions: { primary: 'Team backend' } };
    fetchMock.mockResolvedValueOnce(response({ route: 'team', routeVersion: 'v1', inventoryDigest: verification.inventoryDigest, legs: [], verification: authority }));
    expect((await getReasoningRouteInventory('team', context)).verification).toEqual(authority);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(context);
    const profileDraft = { ...profileRef, name: 'Team mapping' };
    const classification = method ? 'Administrator-confirmed' : 'Verified';
    const confirmation = method ? { administratorConfirmed: true as const } : {};
    fetchMock.mockResolvedValueOnce(response({ classification, assignable: true, checkId: 'check-id', verification: authority }));
    const result = await discoverReasoningCompatibility({ route: 'team', profileRef, profileDraft, ...context, ...confirmation, maxCompletionTokens: 4096 });
    expect(result.classification).toBe(classification);
    expect(result.assignable).toBe(true);
    expect(result.checkId).toBe('check-id');
    expect(result.verification).toEqual(authority);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ route: 'team', profileRef, profileDraft, ...context, ...confirmation, maxCompletionTokens: 4096 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
