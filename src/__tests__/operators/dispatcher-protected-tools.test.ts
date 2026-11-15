import { describe, expect, it } from 'vitest';
import { parseDispatcherOperation, readDispatcherBody } from '../../operators/operator-runtime-capability';
import { applicationWire, fixture, genericWire, remoteMutations, start, writableApplication } from './fixtures/dispatcher-production';

const head = 'a'.repeat(40);
const target = { pullRequest: 1, headSha: head };
const wire = genericWire;

describe('REQ-OPERATOR-047: bounded source body lifecycle', () => {
  it('cancels a stalled source body and releases the stream when the caller deadline aborts', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('incomplete evidence'));
    } }));
    const controller = new AbortController();
    const body = readDispatcherBody(response, controller.signal);
    controller.abort(new Error('Caller deadline expired'));
    await expect(body).rejects.toThrow('Caller deadline expired');
    const reader = response.body!.getReader();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
  });
});

describe('REQ-OPERATOR-063: bounded inference count observation', () => {
  it('preserves schema refusal when its diagnostic observer fails and accepts later valid input', async () => {
    await expect(parseDispatcherOperation(wire('inference', { operationId: 'denied', input: { messages: [] } }),
      undefined, undefined, () => { throw new Error('Diagnostic observer unavailable'); }))
      .rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ code: 'too_small', minimum: 1 })]) });
    const body = { operationId: 'valid', input: { messages: [{ role: 'user', content: 'authorized work' }] } };
    await expect(parseDispatcherOperation(wire('inference', body), undefined, undefined,
      () => { throw new Error('Diagnostic observer unavailable'); })).resolves.toMatchObject({ body });
  });
});

// Domain eligibility/discovery and publication now belong to Dispatcher. Equivalent
// package coverage: test/renovate/renovate-discovery.test.ts (cutoff/bot/pagination)
// and github-effects.test.ts (exact-head policy and positive unique write recovery).
// Those package tests are not evidence that Root still serves these retired tools.
describe('REQ-OPERATOR-051/060: retired domain tools cannot acquire generic transport authority', () => {
  it.each([
    ['github/read', { operationId: 'one', resource: 'open-pull-requests' }],
    ['github/read', { operationId: 'two', resource: 'checks', target }],
    ['github/read', { operationId: 'legacy', resource: 'files' }],
    ['github/comment', { operationId: 'comment', target, decision: 'DO_NOT_MERGE', comment: 'Insufficient evidence' }],
    ['github/merge', { operationId: 'merge', target, decision: 'MERGE', comment: 'Research judgment' }],
    ['github/execute', { operationId: 'execute', target, decision: 'MERGE', comment: 'Research judgment' }],
    ['github/read', { operationId: 'foreign', resource: 'open-pull-requests', url: 'https://evil.test' }],
    ['github/comment', { operationId: 'forged', target, sessionId: 'forged', decision: 'MERGE', comment: 'Research judgment' }],
  ] as const)('refuses %s before I/O and preserves original source receipts across reconstruction (%#)', (path, body) => fixture(async f => {
    await start(f);
    const source = { operationId: 'authorized-source', url: 'https://api.github.com/repos/another/service' };
    const original = await f.capability.fetch(applicationWire(f, 'source', source));
    expect(original.status).toBe(200);
    const bytes = await original.text();
    const receipt = async () => {
      const response = await f.capability.fetch(applicationWire(f, 'receipt', { operationId: source.operationId }));
      expect(response.status).toBe(200);
      return response.json();
    };
    const before = await receipt();
    expect(before).toMatchObject({ phase: 'completed', operationCount: 1 });
    const sent = [...f.sent];
    for (const reload of [false, true]) {
      if (reload) f.restart();
      await expect(parseDispatcherOperation(wire(path, body))).rejects.toThrow('Dispatcher route denied');
      const denied = await f.capability.fetch(applicationWire(f, path, body));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'request-invalid', disposition: 'operation-local' });
      expect(await receipt()).toEqual(before);
      const cached = await f.capability.fetch(applicationWire(f, 'source', source));
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(bytes);
      expect(f.sent).toEqual(sent);
      expect(remoteMutations(f)).toEqual([]);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }
  }, writableApplication));
});
