/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from 'vitest';
import { digest, fixture, genericWire, start } from './fixtures/dispatcher-production';

const url = 'https://api.github.com/repos/another/service';
const operationId = 'retained-evidence';
const source = () => genericWire('source', { operationId, url });
type Receipt = { generation: number; requestDigest: string; responseDigest: string; [key: string]: unknown };
const request = (receipt: Receipt, patch: Record<string, unknown> = {}) => genericWire('receipt', {
  operationId, sourceResponse: { generation: receipt.generation, requestDigest: receipt.requestDigest,
    responseDigest: receipt.responseDigest, url, ...patch },
});

describe('REQ-OPERATOR-097: cached-only source receipt wire', () => {
  it.each([
    { name: 'uppercase host and dot segments', originalUrl: 'https://API.GITHUB.COM/repos/another/../another/service', sourceUrlChars: 200 },
    { name: 'implicit root slash', originalUrl: 'https://api.github.com', sourceUrlChars: 200 },
    { name: 'above-default admitted URL', originalUrl: `${url}?q=${'x'.repeat(17000)}`, sourceUrlChars: 20000 },
    { name: 'canonical encoding expands beyond raw input capacity', originalUrl: `${url}?q=${'é'.repeat(8)}`, sourceUrlChars: 80 },
  ])('recovers $name without changing the original URL proof or envelope digest', ({ originalUrl, sourceUrlChars }) => fixture(async f => {
    await start(f);
    const originalResponse = await f.capability.fetch(genericWire('source', { operationId, url: originalUrl }));
    expect(originalResponse.status).toBe(200);
    const original = await originalResponse.json() as { url: string };
    expect(original.url).toBe(new URL(originalUrl).href);
    const receipt = await (await f.capability.fetch(genericWire('receipt', { operationId }))).json() as Receipt;
    expect(receipt.url).toBe(originalUrl);
    const effects = [...f.sent];
    const recovered = await f.capability.fetch(request(receipt, { url: originalUrl }));
    expect(recovered.status).toBe(200);
    const wire = await recovered.json() as Receipt & { sourceResponse: unknown };
    expect(wire).toEqual({ ...receipt, sourceResponse: original });
    expect(await digest(JSON.stringify(wire.sourceResponse))).toBe(receipt.responseDigest);
    expect(f.sent).toEqual(effects);
    expect(await (await f.capability.fetch(genericWire('receipt', { operationId }))).json()).toEqual(receipt);
  }, { repositoryOnly: true, capacityPolicy: { sourceUrlChars } }));

  it('rejects proof URLs beyond the admitted capacity before reading archived bytes', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(source())).status).toBe(200);
    const receipt = await (await f.capability.fetch(genericWire('receipt', { operationId }))).json() as Receipt;
    const effects = [...f.sent];
    const denied = await f.capability.fetch(request(receipt, { url: `${url}x` }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'request-invalid' });
    expect(f.sent).toEqual(effects);
    expect(await (await f.capability.fetch(genericWire('receipt', { operationId }))).json()).toEqual(receipt);
  }, { repositoryOnly: true, capacityPolicy: { sourceUrlChars: url.length } }));

  it('recovers the original envelope after reconstruction without new source effects or budget consumption', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(source());
    expect(response.status).toBe(200);
    const original = await response.json();
    const receiptResponse = await f.capability.fetch(genericWire('receipt', { operationId }));
    expect(receiptResponse.status).toBe(200);
    const receipt = await receiptResponse.json() as Receipt;
    expect(receipt).toMatchObject({ operationCount: 1, operationLimit: 1, phase: 'completed', method: 'GET' });
    const effects = [...f.sent];
    f.changeTarget({ title: 'Upstream changed after the original evidence read' });
    f.restart();
    const recovered = await f.capability.fetch(request(receipt));
    expect(recovered.status).toBe(200);
    const recoveredWire = await recovered.json() as Receipt & { sourceResponse: unknown };
    expect(recoveredWire).toEqual({ ...receipt, sourceResponse: original });
    expect(await digest(JSON.stringify(recoveredWire.sourceResponse))).toBe(receipt.responseDigest);
    expect(f.sent).toEqual(effects);
    const unchanged = await f.capability.fetch(genericWire('receipt', { operationId }));
    expect(await unchanged.json()).toEqual(receipt);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true, operationLimit: 1 }));

  it.each(['generation', 'requestDigest', 'responseDigest', 'url'] as const)(
    'refuses a mismatched %s without issuing another source operation', field => fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(source())).status).toBe(200);
      const receipt = await (await f.capability.fetch(genericWire('receipt', { operationId }))).json() as Receipt;
      const effects = [...f.sent];
      const patch = { [field]: field === 'generation' ? receipt.generation + 1
        : field === 'url' ? `${url}/other` : 'f'.repeat(64) };
      const denied = await f.capability.fetch(request(receipt, patch));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'receipt-unavailable' });
      expect(f.sent).toEqual(effects);
      expect(await (await f.capability.fetch(genericWire('receipt', { operationId }))).json()).toEqual(receipt);
    }, { repositoryOnly: true }));

  it.each(['missing', 'corrupt'] as const)('refuses %s retained bytes without falling through to an upstream GET', fault => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(source())).status).toBe(200);
    const receipt = await (await f.capability.fetch(genericWire('receipt', { operationId }))).json() as Receipt;
    const effects = [...f.sent];
    await f.mutateEvidence(async storage => {
      const key = `dispatcher:response:${operationId}`;
      if (fault === 'missing') await storage.delete(key);
      else await storage.put(key, { status: 200, contentType: 'application/json', body: '{invalid retained JSON' });
    });
    const denied = await f.capability.fetch(request(receipt));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'receipt-unavailable' });
    expect(f.sent).toEqual(effects);
    expect(await (await f.capability.fetch(genericWire('receipt', { operationId }))).json()).toEqual(receipt);
  }, { repositoryOnly: true }));

  it.each(['stale', 'cancelled', 'expired', 'session'] as const)(
    'retains the existing %s authority fence before releasing source bytes', fault => fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(source())).status).toBe(200);
      const receipt = await (await f.capability.fetch(genericWire('receipt', { operationId }))).json() as Receipt;
      const effects = [...f.sent];
      if (fault === 'cancelled') await f.activity.cancelDrive();
      if (fault === 'expired') f.expire();
      if (fault === 'session') f.revokeSession();
      const effectsAfterAuthorityChange = [...f.sent];
      const caller = fault === 'stale' ? f.staleCapability : f.capability;
      const denied = await caller.fetch(request(receipt));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual(effectsAfterAuthorityChange);
      if (fault !== 'cancelled') expect(f.sent).toEqual(effects);
    }, { repositoryOnly: true }));

  it('cannot release or replay an uncertain mutation as retained GET evidence', () => fixture(async f => {
    await start(f);
    f.loseResponse();
    const mutation = await f.capability.fetch(genericWire('source', { operationId, method: 'POST',
      url: `${url}/issues/17/comments`, body: '{"body":"Original uncertain effect"}' }));
    expect(mutation.status).toBe(409);
    f.restoreTransport();
    const receipt = await (await f.capability.fetch(genericWire('receipt', { operationId }))).json() as Receipt;
    expect(receipt).toMatchObject({ method: 'POST', phase: 'unknown' });
    const effects = [...f.sent];
    const denied = await f.capability.fetch(request({ ...receipt, responseDigest: 'f'.repeat(64) },
      { url: `${url}/issues/17/comments` }));
    expect(denied.status).toBe(403);
    expect(f.sent).toEqual(effects);
    expect(await (await f.capability.fetch(genericWire('receipt', { operationId }))).json()).toEqual(receipt);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true }));
});
