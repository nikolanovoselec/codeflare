/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from 'vitest';
import { fixture, start, genericWire,
  capacitySourceUrl as sourceUrl, capacityInferenceRequest as inference,
  capacityReceipt as receipt, fillCapacityReads as fillReads } from './fixtures/dispatcher-production';

describe('REQ-OPERATOR-103: full-capacity Dispatcher operation accounting', () => {
  it('REQ-OPERATOR-047: default 1024 journal counts distinct reads and inference while cached operations reuse slots', () => fixture(async f => {
    await start(f);
    await fillReads(f, 1023);
    expect((await f.capability.fetch(inference('default-inference'))).status).toBe(200);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 1024, operationLimit: 1024 });
    expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
    expect((await f.capability.fetch(inference('default-inference'))).status).toBe(200);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 1024, operationLimit: 1024 });
    expect((await f.capability.fetch(inference('new-over-default'))).status).toBe(403);
    expect((await f.capability.fetch(genericWire('source', { operationId: 'new-over-default-read', url: sourceUrl }))).status).toBe(403);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, { repositoryOnly: true }), 120000);
});
