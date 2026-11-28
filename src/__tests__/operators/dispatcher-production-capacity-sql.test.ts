/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from 'vitest';
import { fixture, start, genericWire, sourceRead, collectedRawValues, withCollectedLargeLogs } from './fixtures/dispatcher-production';

describe('REQ-OPERATOR-103: full-capacity Dispatcher operation accounting', () => {
  it('REQ-OPERATOR-047: SQL-backed default capacity completes 1024 distinct maximum-length source URLs and reuses cached slots after reload', () => withCollectedLargeLogs(true, output => fixture(async f => {
    await start(f);
    const urlFor = (index: number) => {
      const prefix = `https://docs.example.test/migration?request=${String(index).padStart(4, '0')}&padding=`;
      return prefix + 'x'.repeat(4096 - prefix.length);
    };
    const receipt = async (index: number, count: number) => {
      const response = await f.capability.fetch(genericWire('receipt', { operationId: `max-url-${index}` }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ operationId: `max-url-${index}`, generation: 1,
        method: 'GET', url: urlFor(index), phase: 'completed', operationCount: count, operationLimit: 1024 });
    };
    // Real native SQLite KV enforces the platform's 2 MiB serialized value limit.
    // Only the upstream transport is controlled: no real network or synthetic journal limit.
    for (let index = 0; index < 1024; index++) {
      const response = await f.capability.fetch(sourceRead(`max-url-${index}`, urlFor(index)));
      expect(response.status, `source reservation/completion ${index + 1} of 1024`).toBe(200);
      expect(await response.json()).toEqual({ url: urlFor(index), status: 200,
        headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'Official migration guidance' });
      if (index === 0 || index === 511 || index === 1023) await receipt(0, index + 1);
    }
    const preparedById = new Map((collectedRawValues(output, 'operation-prepared') as Array<{
      body: { operationId: string; url: string };
    }>).map(value => [value.body.operationId, value.body]));
    for (let index = 0; index < 1024; index++) {
      expect(preparedById.get(`max-url-${index}`)).toEqual({ operationId: `max-url-${index}`, url: urlFor(index) });
    }
    f.sourceBody('Changed upstream content must not replace completed long-URL receipts');
    f.restart();
    for (const index of [0, 511, 1023]) {
      const cached = await f.capability.fetch(sourceRead(`max-url-${index}`, urlFor(index)));
      expect(cached.status).toBe(200);
      expect(await cached.json()).toEqual({ url: urlFor(index), status: 200,
        headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'Official migration guidance' });
      await receipt(index, 1024);
    }
    const denied = await f.capability.fetch(sourceRead('max-url-next', urlFor(1024)));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    expect((await f.capability.fetch(genericWire('receipt', { operationId: 'max-url-next' }))).status).toBe(403);
    await receipt(0, 1024);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, { repositoryOnly: true })), 120000);
});
