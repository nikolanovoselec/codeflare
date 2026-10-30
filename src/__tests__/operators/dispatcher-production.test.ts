/// <reference types="@cloudflare/vitest-plugin/types" />
import { type DiagnosticPage, type DiagnosticRecord, type DispatcherFixture, type FixtureDiagnosticIndex, bundle, bytes, changedCompose, collectedRawValues, composeBlob, composeRead, denyDiagnosticWrites, diagnosticIndexKey, diagnosticJson, diagnosticReport, diagnosticSummary, diagnosticTraversal, diagnosticsBrowser, digest, dozzleFiles, encodeSdkHeader, fixture, genericWire, guideBlobSha, guideExcerpt, guideRead, importRuntime, invalidPreparationRefusal, invocation, maximalDiagnosticEvent, preparationFailures, prospectiveBase, prospectiveComment, prospectiveMerge, prospectiveRepo, read, releaseRead, remoteMutations, retainedFence, runtimeEnvelope, seedDiagnosticSnapshot, sourceRead, start, startProspective, syntheticFramePaths, withCollectedLargeLogs } from './fixtures/dispatcher-production';
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { Agent } from 'agents';
import { OperatorActivity, OperatorDispatcherTail } from '../../operators/activity';
import { driveDispatcherRuntime } from '../../operators/runtime';
import { runOperatorActivity } from '../../operators/orchestrator';
import { parseDispatcherOperation, readDispatcherBody } from '../../operators/operator-runtime-capability';
import { captureError } from '../../operators/dispatcher-diagnostics-wire';
import { setLogLevel } from '../../lib/logger';
import { pendingRecipient, within } from '../helpers/pending-recipient';

// Legacy refusal assertions below preserve code/status compatibility and their related
// effect/lifecycle outcomes; additive reason/disposition are asserted exactly here.
// Strict successes/receipts/resolutions remain exact. The private producer's
// prior-effect no-attempt parser is tested there; this host does not emit it.
describe('REQ-OPERATOR-047: closed protected refusal contract', () => {
  const sourceUrl = 'https://api.github.com/repos/another/service';
  const source = (operationId: string) => genericWire('source', { operationId, url: sourceUrl });
  const refusal = async (response: Response, status: number, code: string, reason: string, disposition: string) => {
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, reason, disposition });
  };

  it.each([
    { name: 'invalid JSON', request: () => new Request('https://operator.internal/v1/dispatcher/source', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }) },
    { name: 'forged authority', request: () => genericWire('source', { operationId: 'forged', url: sourceUrl, owner: 'another-user' }) },
    { name: 'GET with body', request: () => genericWire('source', { operationId: 'get-body', url: sourceUrl, method: 'GET', body: '{}' }) },
    { name: 'unsupported protected route', request: () => genericWire('unsupported', { operationId: 'wrong-route' }) },
  ])('REQ-OPERATOR-047: malformed $name is operation-local and permits a corrected authorized source', ({ request }) => fixture(async f => {
    await start(f);
    await refusal(await f.capability.fetch(request()), 403, 'OPERATOR_CAPABILITY_DENIED', 'request-invalid', 'operation-local');
    expect(f.sent).toEqual([]);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    const corrected = await f.capability.fetch(source('corrected-source'));
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({ url: sourceUrl, status: 200,
      body: expect.stringContaining('"number":17') });
    const receipt = await f.capability.fetch(genericWire('receipt', { operationId: 'corrected-source' }));
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ phase: 'completed', operationCount: 1 });
  }, { repositoryOnly: true }));

  it('REQ-OPERATOR-047: configured fetch refusal is policy-local and never grants the refused effect', () => fixture(async f => {
    await start(f);
    await refusal(await f.capability.fetch(source('policy-refused')), 403,
      'OPERATOR_CAPABILITY_DENIED', 'policy-denied', 'operation-local');
    expect(f.sent).toEqual([]);
    const permitted = await f.capability.fetch(genericWire('inference', { operationId: 'permitted-inference',
      input: { messages: [{ role: 'user', content: 'Bounded authorized task' }] } }));
    expect(permitted.status).toBe(200);
    expect(await permitted.text()).toBe('data: [DONE]\n\n');
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, { repositoryOnly: true, capabilities: ['inference'] }));

  it.each(['stale', 'cancelled', 'expired'] as const)(
    'REQ-OPERATOR-048: %s execution refuses protected work with authority disposition and no effects', fault => fixture(async f => {
      await start(f);
      if (fault === 'cancelled') await f.activity.cancelDrive();
      if (fault === 'expired') f.expire();
      const caller = fault === 'stale' ? f.staleCapability : f.capability;
      await refusal(await caller.fetch(source('inactive-source')), 403,
        'OPERATOR_CAPABILITY_DENIED', 'execution-inactive', 'authority-denied');
      expect(f.sent).toEqual([]);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, { repositoryOnly: true }));

  it('REQ-OPERATOR-047: unverified live session is authority-denied rather than a malformed request', () => fixture(async f => {
    await start(f);
    f.revokeSession();
    await refusal(await f.capability.fetch(source('unverified-session')), 403,
      'OPERATOR_CAPABILITY_DENIED', 'authority-unverified', 'authority-denied');
    expect(f.sent).toEqual([]);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true }));

  it('REQ-OPERATOR-062: missing own receipt is operation-local while stale receipt callers learn no operation state', () => fixture(async f => {
    await start(f);
    await refusal(await f.capability.fetch(genericWire('receipt', { operationId: 'absent-operation' })), 403,
      'OPERATOR_CAPABILITY_DENIED', 'receipt-unavailable', 'operation-local');
    expect(f.sent).toEqual([]);
    expect((await f.capability.fetch(source('receipt-control'))).status).toBe(200);
    const observed = await f.capability.fetch(genericWire('receipt', { operationId: 'receipt-control' }));
    expect(observed.status).toBe(200);
    expect(await observed.json()).toMatchObject({ operationId: 'receipt-control', phase: 'completed', operationCount: 1 });
    const staleBodies = [];
    for (const operationId of ['receipt-control', 'absent-operation']) {
      const denied = await f.staleCapability.fetch(genericWire('receipt', { operationId }));
      expect(denied.status).toBe(403);
      staleBodies.push(await denied.json());
    }
    expect(staleBodies).toEqual(Array.from({ length: 2 }, () => ({ code: 'OPERATOR_CAPABILITY_DENIED',
      reason: 'execution-inactive', disposition: 'authority-denied' })));
  }, { repositoryOnly: true }));

  it('REQ-OPERATOR-047: immutable argument conflict is operation-local and cannot replace the original receipt', () => fixture(async f => {
    await start(f);
    const original = await f.capability.fetch(source('immutable-read'));
    expect(original.status).toBe(200);
    const envelope = await original.json();
    const effects = [...f.sent];
    await refusal(await f.capability.fetch(genericWire('source', { operationId: 'immutable-read', url: `${sourceUrl}/pulls/17` })),
      409, 'OPERATOR_OPERATION_CONFLICT', 'operation-conflict', 'operation-local');
    const cached = await f.capability.fetch(source('immutable-read'));
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(envelope);
    expect(f.sent).toEqual(effects);
    expect((await f.capability.fetch(source('independent-read'))).status).toBe(200);
  }, { repositoryOnly: true }));

  it('REQ-OPERATOR-047: exhausted shared operation capacity remains authority-denied while exact receipts stay readable', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(source('last-slot'))).status).toBe(200);
    const effects = [...f.sent];
    await refusal(await f.capability.fetch(source('over-capacity')), 403,
      'OPERATOR_CAPABILITY_DENIED', 'operation-limit', 'authority-denied');
    const receipt = await f.capability.fetch(genericWire('receipt', { operationId: 'last-slot' }));
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ phase: 'completed', operationCount: 1, operationLimit: 1 });
    expect(f.sent).toEqual(effects);
  }, { repositoryOnly: true, operationLimit: 1 }));

  it('REQ-OPERATOR-062: uncertain actual mutation keeps its original ID unknown and forbids blind replay', () => fixture(async f => {
    await start(f);
    const mutation = { operationId: 'unknown-original', method: 'POST', url: `${sourceUrl}/issues/17/comments`,
      body: '{"body":"Original uncertain judgment"}' };
    f.loseResponse();
    await refusal(await f.capability.fetch(genericWire('source', mutation)), 409,
      'OPERATOR_OPERATION_UNKNOWN', 'effect-uncertain', 'effect-uncertain');
    f.restoreTransport();
    await refusal(await f.capability.fetch(genericWire('source', mutation)), 409,
      'OPERATOR_OPERATION_UNKNOWN', 'effect-uncertain', 'effect-uncertain');
    const original = await f.capability.fetch(genericWire('receipt', { operationId: mutation.operationId }));
    expect(original.status).toBe(200);
    expect(await original.json()).toMatchObject({ operationId: mutation.operationId, phase: 'unknown', method: 'POST', operationCount: 1 });
    const readback = await f.capability.fetch(genericWire('source', { operationId: 'unknown-readback', url: mutation.url }));
    expect(readback.status).toBe(200);
    expect(JSON.parse((await readback.json() as { body: string }).body)).toEqual([
      { id: 91, body: 'Original uncertain judgment', user: { id: 42 } },
    ]);
    expect(await f.readRemoteComments()).toEqual([{ id: 91, body: 'Original uncertain judgment', user: { id: 42 } }]);
    expect(f.sent.filter(request => request.method === 'POST').map(request => request.url)).toEqual([mutation.url]);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true }));

});

describe('REQ-OPERATOR-063: reservation denial private wire', () => {
  const sourceUrl = 'https://api.github.com/repos/another/service';
  const inference = (operationId: string) => genericWire('inference', { operationId,
    input: { messages: [{ role: 'user', content: 'PRIVATE_RESERVATION_CONTENT {"activityId":"forged","generation":999}' }] } });
  const receipt = async (f: DispatcherFixture, operationId: string) => {
    const response = await f.capability.fetch(genericWire('receipt', { operationId }));
    expect(response.status).toBe(200);
    return await response.json() as { operationCount: number; operationLimit: number;
      requestDigest: string; responseDigest: string; phase: string };
  };
  const fillReads = async (f: DispatcherFixture, count: number) => {
    for (let index = 0; index < count; index++) {
      const response = await f.capability.fetch(genericWire('source', { operationId: `capacity-read-${index}`, url: sourceUrl }));
      expect(response.status).toBe(200);
      const value = await response.json() as { status: number; body: string };
      expect(value.status).toBe(200);
      expect(JSON.parse(value.body)).toMatchObject({ number: 17 });
    }
  };
  const fillMixedJournal = async (f: DispatcherFixture) => {
    await fillReads(f, 127);
    const response = await f.capability.fetch(inference('capacity-inference'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 128, operationLimit: 128 });
  };
  const reservationEvents = (events: string[]) => events.map(value => JSON.parse(value) as {
    module: string; data: Record<string, unknown>;
  }).filter(value => value.module === 'dispatcher-settlement' && value.data?.stage === 'reservation').map(value => value.data);

  it.each(['source', 'inference'] as const)(
    'REQ-OPERATOR-063: reservation diagnostic wire reports operation-limit for %s without child content', resource => fixture(async f => {
      await start(f);
      await fillMixedJournal(f);
      const before = await f.activity.getBrowserDetail();
      const outbound = [...f.sent];
      const events: string[] = [];
      setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
      try {
        const operationId = 'PRIVATE_RESERVATION_OPERATION';
        const response = await f.capability.fetch(resource === 'inference' ? inference(operationId)
          : genericWire('source', { operationId, url: sourceUrl, method: 'POST',
            body: '{"activityId":"forged","generation":999,"content":"PRIVATE_RESERVATION_CONTENT"}' }));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
        // Intentional private diagnostic wire: reason is the actual transaction branch, not an inferred SDK failure.
        expect(reservationEvents(events)).toEqual([{ stage: 'reservation', reason: 'operation-limit',
          activityId: f.activityId, generation: 1, resource, deadline: 'current', status: 403,
          operationCount: 128, operationLimit: 128 }]);
        expect(events.join('')).not.toContain('PRIVATE_RESERVATION');
        expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 128, operationLimit: 128 });
        expect((await f.capability.fetch(genericWire('receipt', { operationId }))).status).toBe(403);
        expect(f.sent).toEqual(outbound);
        expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: before!.result,
          cleanupStatus: before!.cleanupStatus, collectionStatus: before!.collectionStatus });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }, { repositoryOnly: true, operationLimit: 128 }));

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

  it.each([3, 129])('REQ-OPERATOR-047: admitted %i-operation budget denies fresh work at its exact boundary', operationLimit => fixture(async f => {
    await start(f);
    await fillReads(f, operationLimit);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: operationLimit, operationLimit });
    expect((await f.capability.fetch(inference('over-configured-budget'))).status).toBe(403);
    expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
    expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: operationLimit, operationLimit });
    f.expire();
    expect((await f.capability.fetch(genericWire('receipt', { operationId: 'capacity-read-0' }))).status).toBe(403);
  }, { repositoryOnly: true, operationLimit }));

  it('REQ-OPERATOR-063: configured budget exhaustion reports actual count and limit without lifecycle changes', () => fixture(async f => {
    await start(f); await fillReads(f, 3);
    const before = await f.activity.getBrowserDetail();
    const events: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      expect((await f.capability.fetch(inference('configured-budget-denied'))).status).toBe(403);
      expect(reservationEvents(events)).toEqual([{ stage: 'reservation', reason: 'operation-limit',
        activityId: f.activityId, generation: 1, resource: 'inference', deadline: 'current', status: 403,
        operationCount: 3, operationLimit: 3 }]);
      expect(await f.activity.getBrowserDetail()).toEqual(before);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, operationLimit: 3 }));

  it('REQ-OPERATOR-047: full Dispatcher journal preserves receipts cached retries conflicts and unknown-mutation resolution', () => fixture(async f => {
    await start(f);
    await fillReads(f, 125);
    const comments = `${sourceUrl}/issues/17/comments`;
    const completed = { operationId: 'capacity-comment', method: 'POST', url: comments, body: '{"body":"completed judgment"}' };
    const unknown = { ...completed, operationId: 'capacity-unknown', body: '{"body":"uncertain judgment"}' };
    const posted = await f.capability.fetch(genericWire('source', completed));
    expect(posted.status).toBe(200);
    const postedBody = await posted.json();
    f.loseResponse();
    expect(await (await f.capability.fetch(genericWire('source', unknown))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    f.restoreTransport();
    const observed = await f.capability.fetch(genericWire('source', { operationId: 'capacity-readback', url: comments }));
    expect(observed.status).toBe(200);
    expect(JSON.parse((await observed.json() as { body: string }).body)).toEqual(expect.arrayContaining([
      expect.objectContaining({ body: 'completed judgment' }), expect.objectContaining({ body: 'uncertain judgment' }),
    ]));
    const original = await receipt(f, unknown.operationId);
    const readback = await receipt(f, 'capacity-readback');
    expect(original).toMatchObject({ operationCount: 128, operationLimit: 128, phase: 'unknown' });
    const outbound = [...f.sent];
    expect(await (await f.capability.fetch(genericWire('source', completed))).json()).toEqual(postedBody);
    expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
    const conflict = await f.capability.fetch(genericWire('source', { ...completed, body: '{"body":"changed judgment"}' }));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT' });
    const uncertain = await f.capability.fetch(genericWire('source', unknown));
    expect(uncertain.status).toBe(409);
    expect(await uncertain.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    const resolution = { operationId: unknown.operationId, requestDigest: original.requestDigest,
      readbacks: [{ operationId: 'capacity-readback', requestDigest: readback.requestDigest, responseDigest: readback.responseDigest }] };
    for (let repeat = 0; repeat < 2; repeat++) {
      const resolved = await f.capability.fetch(genericWire('resolve', resolution));
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toEqual({ resolved: true, operationId: unknown.operationId, requestDigest: original.requestDigest });
    }
    expect(await receipt(f, unknown.operationId)).toMatchObject({ operationCount: 128, operationLimit: 128, phase: 'completed' });
    expect(f.sent).toEqual(outbound);
    const denied = await f.capability.fetch(inference('new-at-capacity'));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
  }, { repositoryOnly: true, operationLimit: 128 }));

  it('REQ-OPERATOR-063: reservation diagnostic wire reports lease-mismatch after concurrent cancellation without protected I/O', () => fixture(async f => {
    await start(f);
    let cancelled: Awaited<ReturnType<OperatorActivity['getBrowserDetail']>> = null;
    let alarm: number | null | undefined;
    f.afterRegistryResolve(async () => { await f.activity.cancelDrive(); cancelled = await f.activity.getBrowserDetail(); alarm = await f.nextAlarm(); });
    const events: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      const response = await f.capability.fetch(inference('PRIVATE_LEASE_OPERATION'));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(reservationEvents(events)).toEqual([{ stage: 'reservation', reason: 'lease-mismatch',
        activityId: f.activityId, generation: 1, resource: 'inference', deadline: 'current', status: 403 }]);
      expect(events.join('')).not.toContain('PRIVATE_');
      expect(f.sent).toEqual([]);
      expect(cancelled).toBeDefined();
      expect(await f.activity.getBrowserDetail()).toEqual(cancelled);
      expect(await f.nextAlarm()).toBe(alarm);
      expect((await f.capability.fetch(inference('old-capability'))).status).toBe(403);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, operationLimit: 128 }));

  it.each(['operation-limit', 'lease-mismatch'] as const)(
    'REQ-OPERATOR-063: owner reservation logging outage preserves %s denial lifecycle and original authority', reason => fixture(async f => {
      await start(f);
      let baseline = await f.activity.getBrowserDetail();
      let alarm = await f.nextAlarm();
      if (reason === 'operation-limit') { await fillMixedJournal(f); baseline = await f.activity.getBrowserDetail(); }
      else f.afterRegistryResolve(async () => { await f.activity.cancelDrive(); baseline = await f.activity.getBrowserDetail(); alarm = await f.nextAlarm(); });
      const outbound = [...f.sent];
      setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGING_OUTAGE'); });
      try {
        // Owner public transport, not the capability's outer catch: the original denial must resolve even when logging throws.
        const response = await f.activity.dispatcherOperation(1, inference('outage-denied'));
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
        expect(f.sent).toEqual(outbound);
        expect(await f.activity.getBrowserDetail()).toEqual(baseline);
        expect(await f.nextAlarm()).toBe(alarm);
        spy.mockImplementation(() => {});
        if (reason === 'operation-limit') {
          expect(await receipt(f, 'capacity-read-0')).toMatchObject({ operationCount: 128, operationLimit: 128 });
          expect((await f.capability.fetch(genericWire('source', { operationId: 'capacity-read-0', url: sourceUrl }))).status).toBe(200);
        }
        expect((await f.capability.fetch(inference('still-denied'))).status).toBe(403);
        f.expire();
        expect((await f.capability.fetch(inference('expired-original-authority'))).status).toBe(403);
        expect(f.sent).toEqual(outbound);
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }, { repositoryOnly: true, operationLimit: 128 }));
});

describe('REQ-OPERATOR-047: generic Activity mutation receipts and resolution', () => {
  it('exposes the configured API origin only to repository-only Loader code', async () => {
    for (const repositoryOnly of [false, true]) await fixture(async f => {
      await start(f);
      expect((await f.loaderEnv()).GITHUB_API_ORIGIN).toBe(repositoryOnly ? 'https://github.enterprise.test' : undefined);
      expect((await f.loaderEnv()).OPERATOR_ADMITTED_TARGET).toBeUndefined();
      if (repositoryOnly) {
        for (const body of [
          { operationId: 'wrong-host', method: 'POST', url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{}' },
          { operationId: 'wrong-body', method: 'GET', url: 'https://github.enterprise.test/repos/another/service', body: '{}' },
          { operationId: 'credential-selector', url: 'https://github.enterprise.test/user', headers: { authorization: 'forged' } },
        ]) expect((await f.capability.fetch(genericWire('source', body))).status).toBe(403);
        const controller = new AbortController(); controller.abort();
        expect((await f.capability.fetch(new Request(genericWire('source', { operationId: 'cancelled-mutation', method: 'POST',
          url: 'https://github.enterprise.test/repos/another/service/issues/17/comments', body: '{}' }), { signal: controller.signal }))).status).toBe(403);
        expect(f.sent).toEqual([]);
        const request = () => genericWire('source', { operationId: 'merge-cas', method: 'PUT',
          url: 'https://github.enterprise.test/repos/another/service/pulls/17/merge', body: '{"sha":"expected-head"}' });
        expect((await f.capability.fetch(request())).status).toBe(200);
        expect((await f.capability.fetch(request())).status).toBe(200);
        expect(f.sent.filter(value => value.method === 'PUT')).toHaveLength(1);
        expect(await f.sent.filter(value => value.method === 'PUT')[0].json()).toEqual({ sha: 'expected-head' });
      }
    }, { repositoryOnly, githubApiHost: 'github.enterprise.test' });
  });
  it('projects actual journal consumption on receipts without charging cached receipt observations', async () => fixture(async f => {
    await start(f);
    const source = { operationId: 'budget-read', url: 'https://api.github.com/repos/another/service' };
    expect((await f.capability.fetch(genericWire('source', source))).status).toBe(200);
    const first = await (await f.capability.fetch(genericWire('receipt', { operationId: source.operationId }))).json() as { operationCount: number; operationLimit: number };
    expect(first.operationLimit).toBe(1024);
    expect(first.operationCount).toBeGreaterThanOrEqual(1);
    expect((await f.capability.fetch(genericWire('source', { ...source, operationId: 'budget-read-next' }))).status).toBe(200);
    const next = await (await f.capability.fetch(genericWire('receipt', { operationId: source.operationId }))).json() as { operationCount: number };
    expect(next.operationCount).toBe(first.operationCount + 1);
    expect(await (await f.capability.fetch(genericWire('receipt', { operationId: source.operationId }))).json()).toEqual(next);
  }, { repositoryOnly: true }));
  it('keeps missing or ambiguous package readback unknown and fences revoked installation', async () => {
    for (const evidence of [[], [{ id: 1 }, { id: 2 }]]) await fixture(async f => {
      await start(f);
      const mutation = { operationId: 'ambiguous-comment', method: 'POST',
        url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"judgment"}' };
      f.loseResponse();
      expect((await f.capability.fetch(genericWire('source', mutation))).status).toBe(409);
      f.restoreTransport(); f.genericReadback(evidence);
      const readback = await (await f.capability.fetch(genericWire('source', { operationId: 'ambiguous-read', url: mutation.url }))).json() as { body: string };
      expect(JSON.parse(readback.body)).toEqual(evidence);
      // No unique package-validated domain receipt exists: do not call resolve.
      expect((await f.capability.fetch(genericWire('receipt', { operationId: mutation.operationId }))).status).toBe(200);
      expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      f.revoke();
      expect((await f.capability.fetch(genericWire('source', mutation))).status).toBe(403);
      expect(f.sent.filter(value => value.method === 'POST')).toHaveLength(1);
    }, { repositoryOnly: true });
  });
  it('never repeats an uncertain mutation; permits readback and immutable resolution', async () => {
    await fixture(async f => {
      await start(f);
      const mutation = { operationId: 'comment-once', method: 'POST', url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"judgment"}' };
      f.loseResponse();
      expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      expect(f.sent.filter(request => request.method === 'POST')).toHaveLength(1);
      expect(await (await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed"}' }))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT' });
      const original = await (await f.capability.fetch(genericWire('receipt', { operationId: mutation.operationId }))).json() as { requestDigest: string };
      const unresolved = { operationId: mutation.operationId, requestDigest: original.requestDigest, readbacks: [] };
      expect((await f.capability.fetch(genericWire('resolve', unresolved))).status).toBe(403);
      const absent = { operationId: 'missing', requestDigest: 'a'.repeat(64), responseDigest: 'b'.repeat(64) };
      expect(await (await f.capability.fetch(genericWire('resolve', { ...unresolved, readbacks: [absent] }))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      f.restoreTransport();
      const readback = { operationId: 'read-comment', url: mutation.url };
      const evidence = await (await f.capability.fetch(genericWire('source', readback))).json() as { body: string };
      // Package code validates the remote actor/target/text before asking the generic parent to seal references.
      expect(JSON.parse(evidence.body)).toEqual([{ id: 91, body: 'judgment', user: { id: 42 } }]);
      const reference = await (await f.capability.fetch(genericWire('receipt', { operationId: readback.operationId }))).json() as { operationId: string; requestDigest: string; responseDigest: string };
      const resolution = { ...unresolved, readbacks: [{ operationId: reference.operationId,
        requestDigest: reference.requestDigest, responseDigest: reference.responseDigest }] };
      expect(await (await f.capability.fetch(genericWire('resolve', { ...resolution, readbacks: [resolution.readbacks[0], resolution.readbacks[0]] }))).json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(await (await f.capability.fetch(genericWire('resolve', resolution))).json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
      expect(await (await f.capability.fetch(genericWire('resolve', resolution))).json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
      expect(f.sent.filter(request => request.method === 'POST')).toHaveLength(1);
      f.revokeSession();
      expect((await f.capability.fetch(genericWire('resolve', resolution))).status).toBe(403);
    }, { repositoryOnly: true });
  });
});

// Bounded host operations only; these do not execute or recreate any retired SDK workload.
describe('REQ-OPERATOR-047: real host transport cancellation', () => {
  it.each([false, true])(
    'REQ-OPERATOR-017: AC2/4/5 composed inference cancellation has no replacement or late commit (ignores abort=%s); REQ-OPERATOR-048 AC2/5',
    ignoreAbort => fixture(async f => {
      const recipient = pendingRecipient(ignoreAbort);
      vi.spyOn(globalThis, 'fetch').mockImplementation(input => recipient.fetch(input as Request));
      await start(f);
      const submissions = await Promise.all(f.childSubmissions.map(request => request.clone().text()));
      const result = f.capability.fetch(genericWire('inference', { operationId: 'owned-cancelled-inference',
        input: { messages: [{ role: 'user', content: 'Bounded task' }] } }));
      try {
        const forwarded = await within(recipient.entered, 'composed LLM recipient entry');
        expect(forwarded.headers.get('authorization')).toBe('Bearer parent-only');
        expect(forwarded.redirect).toBe('manual');
        await f.activity.cancelDrive();
        if (!ignoreAbort) await expect.poll(recipient.aborted, { timeout: 300 }).toBe(true);
        recipient.release(new Response('data: {"choices":[{"delta":{"content":"late-inference-answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } }));
        expect((await within(result, 'fenced inference response')).status).not.toBe(200);
        const restarted = f.restart(); await f.drainBackground(); await restarted.reconcileDispatcherLease();
        expect(await restarted.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested', result: null });
        expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        const replacement = await f.capability.fetch(genericWire('inference', { operationId: 'replacement-denied',
          input: { messages: [{ role: 'user', content: 'Bounded task' }] } }));
        expect(replacement.status).toBe(403);
        expect(await replacement.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED',
          reason: 'execution-inactive', disposition: 'authority-denied' });
        const retained = await restarted.getDispatcherDiagnostics(f.proof.ownerKey);
        expect(retained?.parent.operations.records).toEqual(expect.arrayContaining([expect.objectContaining({
          operationDigest: await digest('owned-cancelled-inference'), status: 'unknown',
        })]));
        expect(retained?.parent.operations.records.map(row => row.status)).not.toContain('completed');
        expect(JSON.stringify(retained)).not.toContain('late-inference-answer');
        expect(await Promise.all(f.childSubmissions.map(request => request.clone().text()))).toEqual(submissions);
        expect(recipient.activeUrls).toEqual([forwarded.url]);
      } finally {
        recipient.release(); await within(result, 'composed inference cleanup').catch(() => undefined);
      }
    }, { repositoryOnly: true, recovery: true, realInterceptors: true }));

  it.each([false, true])(
    'REQ-OPERATOR-047: AC2 composed source cancellation cannot commit late bytes (ignores abort=%s); REQ-OPERATOR-048 AC5',
    async ignoreAbort => {
      const recipient = pendingRecipient(ignoreAbort);
      await fixture(async f => {
        await start(f); const original = await f.activity.getBrowserDetail();
        const submissions = await Promise.all(f.childSubmissions.map(request => request.clone().text()));
        const controller = new AbortController();
        const result = f.capability.fetch(new Request(genericWire('source', { operationId: 'owned-cancelled-source',
          url: 'https://evidence.example.test/guide' }), { signal: controller.signal }));
        try {
          const forwarded = await within(recipient.entered, 'composed EGRESS recipient entry');
          expect(forwarded.url).toBe('https://evidence.example.test/guide'); expect(forwarded.redirect).toBe('manual');
          expect(forwarded.headers.has('authorization')).toBe(false);
          await f.activity.cancelDrive(); controller.abort();
          if (!ignoreAbort) await expect.poll(recipient.aborted, { timeout: 300 }).toBe(true);
          recipient.release(new Response('late-source-evidence'));
          expect((await within(result, 'fenced source response')).status).not.toBe(200);
          const restarted = f.restart(); await f.drainBackground(); await restarted.reconcileDispatcherLease();
          expect(await restarted.getBrowserDetail()).toMatchObject({ activityId: original?.activityId,
            executionStatus: 'cancel-requested', result: null });
          expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
          const retained = await restarted.getDispatcherDiagnostics(f.proof.ownerKey);
          expect(retained?.parent.operations.records).toEqual(expect.arrayContaining([expect.objectContaining({
            operationDigest: await digest('owned-cancelled-source'), status: 'unknown',
          })]));
          expect(retained?.parent.operations.records.map(row => row.status)).not.toContain('completed');
          expect(JSON.stringify(retained)).not.toContain('late-source-evidence');
          expect((await f.capability.fetch(genericWire('source', { operationId: 'no-replacement', url: forwarded.url }))).status).toBe(403);
          expect(await Promise.all(f.childSubmissions.map(request => request.clone().text()))).toEqual(submissions);
          expect(recipient.activeUrls).toEqual([forwarded.url]);
        } finally {
          controller.abort(); recipient.release(); await within(result, 'composed source cleanup').catch(() => undefined);
        }
      }, { repositoryOnly: true, realInterceptors: true, sourceTransport: recipient.fetch });
    });

  it('REQ-OPERATOR-047: AC2 composed source effective timeout cancels EGRESS without renewing authority', async () => {
    const recipient = pendingRecipient();
    await fixture(async f => {
      await start(f); const before = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
      const result = f.capability.fetch(genericWire('source', { operationId: 'bounded-source-timeout', url: 'https://evidence.example.test/pending' }));
      try {
        await within(recipient.entered, 'timeout source recipient entry');
        await expect.poll(recipient.aborted, { timeout: 500 }).toBe(true);
        expect((await within(result, 'source timeout refusal')).status).not.toBe(200);
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        const after = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
        expect(before?.parent.lease).toMatchObject({ generation: 1 });
        expect(after?.parent.lease).toMatchObject({ generation: before!.parent.lease!.generation,
          artifactDigest: before!.parent.lease!.artifactDigest, inputDigest: before!.parent.lease!.inputDigest,
          expiresAt: before!.parent.lease!.expiresAt });
      } finally { recipient.release(); await within(result, 'source timeout cleanup').catch(() => undefined); }
    }, { repositoryOnly: true, realInterceptors: true, sourceTransport: recipient.fetch, capacityPolicy: { sourceTimeoutMs: 25 } });
  });
});

describe('REQ-OPERATOR-063: retained host preparation cause', () => {
  const byteLimit = 512;
  const sourceUrl = 'https://api.github.com/repos/another/service';
  const corrected = (id: string) => genericWire('source', { operationId: id, url: sourceUrl });
  const receipt = async (f: DispatcherFixture, id: string) => {
    const response = await f.capability.fetch(genericWire('receipt', { operationId: id })); expect(response.status).toBe(200);
    return response.json();
  };
  const options = { repositoryOnly: true, inferenceRequestBytes: byteLimit, capacityPolicy: { dispatcherRequestBytes: byteLimit } };

  it.each([{ route: 'inference', crossing: 1 }, { route: 'inference', crossing: 3 },
    { route: 'source', crossing: 1 }, { route: 'source', crossing: 3 }])(
    'REQ-OPERATOR-063: AC6 $route overflow by $crossing bytes retains originating bounds and unchanged request-invalid refusal',
    ({ route, crossing }) => fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(corrected('overflow-budget-anchor'))).status).toBe(200);
      const body = route === 'inference' ? { operationId: 'bounded-request', input: { messages: [{ role: 'user', content: 'é' }] } }
        : { operationId: 'bounded-request', url: `${sourceUrl}?label=é` };
      const encoded = new TextEncoder().encode(JSON.stringify(body));
      const exact = new Uint8Array(byteLimit); exact.set(encoded); exact.fill(32, encoded.byteLength);
      const exactResponse = await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/' + route,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact }));
      expect(exactResponse.status).toBe(200); const originalBytes = await exactResponse.text();
      // Receipt budget observations use a source anchor: inference is not a source receipt.
      expect(await receipt(f, 'overflow-budget-anchor')).toMatchObject({ operationCount: 2, phase: 'completed' });
      let cancelled = false; let finish!: () => void;
      const overflow = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(exact); controller.enqueue(new TextEncoder().encode(crossing === 1 ? ' ' : ' é'));
        // Deliberately unfinished remainder: overflow must not wait to determine total length.
        finish = () => { try { controller.close(); } catch { /* Already cancelled by the reader. */ } };
      }, cancel() { cancelled = true; } });
      const rejected = f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/' + route,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: overflow }));
      try { await invalidPreparationRefusal(await within(rejected, 'overflow refusal before EOF')); }
      finally { finish(); await within(rejected, 'overflow cleanup').catch(() => undefined); }
      expect(cancelled).toBe(true);
      const failure = (await preparationFailures(f)).at(-1);
      // Intentional retained owner diagnostic contract, coupled to the unchanged refusal/receipt outcome.
      expect(failure).toMatchObject({ owner: 'host', boundary: 'tool', code: 'tool-failed', origin: 'originating',
        preparation: { step: 'parse', failureClass: 'body-limit', route, byteLimit, observedBytesLowerBound: byteLimit + crossing },
        error: { transportStatus: 403, transportReason: 'request-invalid', transportDisposition: 'operation-local' } });
      expect(failure?.preparation).not.toHaveProperty('resource');
      expect(failure?.correlation).toEqual({});
      expect(JSON.stringify(failure)).not.toMatch(/bounded-request|label=|api\.github|private\.jwt|owner@example|Dispatcher body exceeds limit/);
      expect(await receipt(f, 'overflow-budget-anchor')).toMatchObject({ operationCount: 2, phase: 'completed' });
      const repeated = await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/' + route,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact }));
      expect(repeated.status).toBe(200); expect(await repeated.text()).toBe(originalBytes);
      expect(await receipt(f, 'overflow-budget-anchor')).toMatchObject({ operationCount: 2 });
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect((await f.capability.fetch(corrected('corrected-after-overflow'))).status).toBe(200);
      expect(await receipt(f, 'corrected-after-overflow')).toMatchObject({ operationCount: 3 });
    }, options));

  it.each([
    { name: 'invalid JSON', route: 'inference', failureClass: 'invalid-json', request: () => new Request('https://operator.internal/v1/dispatcher/inference',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"PRIVATE_PROMPT":' }) },
    { name: 'invalid wire', route: 'inference', failureClass: 'invalid-wire', request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: { messages: [] } }) },
    { name: 'unsupported method', route: 'inference', failureClass: 'request-denied', request: () => new Request('https://operator.internal/v1/dispatcher/inference') },
    { name: 'unsupported content type', route: 'source', failureClass: 'request-denied', request: () => new Request('https://operator.internal/v1/dispatcher/source',
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'PRIVATE_BODY' }) },
    { name: 'missing body', route: 'inference', failureClass: 'request-denied', request: () => new Request('https://operator.internal/v1/dispatcher/inference',
      { method: 'POST', headers: { 'content-type': 'application/json' } }) },
    { name: 'invalid UTF8', route: 'inference', failureClass: 'request-denied', request: () => new Request('https://operator.internal/v1/dispatcher/inference',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0xc3, 0x28]) }) },
    { name: 'unknown route', route: 'unknown', failureClass: 'request-denied', request: () => genericWire('PRIVATE_ROUTE', { operationId: 'PRIVATE_OPERATION' }) },
    { name: 'foreign origin', route: 'unknown', failureClass: 'request-denied', direct: true, request: () => new Request('https://PRIVATE_ORIGIN.invalid/v1/dispatcher/inference',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }) },
  ])('REQ-OPERATOR-063: AC1/6 $name preparse refusal retains only closed parent-owned context', ({ request, route, failureClass, direct }) => fixture(async f => {
    await start(f);
    // Foreign outbound URLs have a separate capability facade; exercise the Activity's own protected parse boundary directly.
    await invalidPreparationRefusal(await (direct ? f.activity.dispatcherOperation(1, request()) : f.capability.fetch(request())));
    const failure = (await preparationFailures(f)).at(-1);
    expect(failure).toMatchObject({ owner: 'host', generation: 1, code: 'tool-failed', preparation: { step: 'parse', failureClass, route },
      error: { transportStatus: 403, transportReason: 'request-invalid', transportDisposition: 'operation-local' } });
    expect(failure?.preparation).toEqual({ step: 'parse', failureClass, route });
    expect(failure?.correlation).toEqual({});
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_|private\.jwt|inline-secret|owner@example|https?:/);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect((await f.capability.fetch(corrected('corrected-after-preparse'))).status).toBe(200);
    expect(await receipt(f, 'corrected-after-preparse')).toMatchObject({ operationCount: 1 });
    expect(await f.readRemoteComments()).toEqual([]);
  }, options));

  it('REQ-OPERATOR-078: AC1 validated capability refusal keeps canonical request digest without inventing SDK attempt', () => fixture(async f => {
    await start(f);
    const body = { operationId: 'capability-refusal', input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } };
    const response = await f.capability.fetch(genericWire('inference', body));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'policy-denied', disposition: 'operation-local' });
    const failure = (await preparationFailures(f)).at(-1);
    expect(failure).toMatchObject({ code: 'authority-denied', preparation: { step: 'capability', failureClass: 'authority-denied', route: 'inference' },
      error: { transportStatus: 403, transportReason: 'policy-denied', transportDisposition: 'operation-local' } });
    expect(failure?.correlation).toEqual({ requestDigest: await digest(JSON.stringify({ path: '/v1/dispatcher/inference', body })) });
    expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_|capability-refusal|private\.jwt/);
    expect((await f.capability.fetch(corrected('permitted-after-capability'))).status).toBe(200);
    expect(await receipt(f, 'permitted-after-capability')).toMatchObject({ operationCount: 1 });
  }, { ...options, capabilities: ['fetch'] }));

  it('REQ-OPERATOR-083: AC2/4/5/7 preparation cause survives reconstruction in passive owner history detail and export', () => fixture(async f => {
    await start(f); await invalidPreparationRefusal(await f.capability.fetch(genericWire('inference', { input: { messages: [] } })));
    const failure = (await preparationFailures(f)).at(-1)!;
    expect(failure).toMatchObject({ preparation: { step: 'parse', route: 'inference', failureClass: 'invalid-wire' } });
    const restarted = f.restart(); await f.drainBackground();
    const before = await restarted.getBrowserDetail();
    const submissions = await Promise.all(f.childSubmissions.map(request => request.clone().text()));
    const oldWire = await restarted.getDispatcherDiagnostics(f.proof.ownerKey);
    const get = diagnosticsBrowser(f);
    const history = await diagnosticTraversal(get);
    expect(history.records.find(record => record.id === failure.id)).toEqual(failure);
    const detail = await diagnosticJson<{ record: DiagnosticRecord; capsule: { eventId: string } }>(await get(`/diagnostics/v2/records/${failure.id}`));
    expect(detail.record).toEqual(failure); expect(detail.capsule.eventId).toBe(failure.id);
    const exported = await diagnosticTraversal(get, '/diagnostics/v2/export');
    expect(exported.records.find(record => record.id === failure.id)).toEqual(failure);
    expect((await get('/diagnostics/v2', 'foreign@example.test')).status).toBe(404);
    expect(await restarted.getBrowserDetail()).toEqual(before);
    expect((await restarted.getDispatcherDiagnostics(f.proof.ownerKey))?.parent).toEqual(oldWire?.parent);
    expect(await Promise.all(f.childSubmissions.map(request => request.clone().text()))).toEqual(submissions);
    expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await f.capability.fetch(corrected('after-passive-readback'))).status).toBe(200);
    expect(await receipt(f, 'after-passive-readback')).toMatchObject({ operationCount: 1 });
  }, options));

  it('REQ-OPERATOR-063: AC5 overflow observer failure preserves the original body-limit Error and reader cancellation', async () => {
    let observed: unknown; let cancelled = false; let finish!: () => void;
    const request = new Request('https://operator.internal/v1/dispatcher/inference', { method: 'POST',
      body: new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        finish = () => { try { controller.close(); } catch { /* Reader already cancelled. */ } };
      }, cancel() { cancelled = true; } }) });
    // Invoke the proposed optional trailing callback through the existing public function.
    // Baseline compiles without a future signature; the missing observation is the intended RED.
    const result: Promise<string> = Reflect.apply(readDispatcherBody, undefined, [request, request.signal, 2,
      (value: unknown) => { observed = value; throw new Error('PRIVATE_OBSERVER_ERROR'); }]);
    try { await expect(within(result, 'overflow observer rejection')).rejects.toThrow('Dispatcher body exceeds limit'); }
    finally { finish(); await within(result, 'overflow observer cleanup').catch(() => undefined); }
    expect(cancelled).toBe(true);
    expect(observed).toEqual({ byteLimit: 2, observedBytesLowerBound: 3 });
  });

  it.each(['OFF', 'recorder unavailable', 'warning unavailable'])(
    'REQ-OPERATOR-063: AC5 preparation diagnostics %s preserve original refusal authority and unknown-effect fences', mode => fixture(async f => {
      await start(f);
      const mutation = { operationId: 'original-unknown-write', method: 'POST',
        url: `${sourceUrl}/issues/17/comments`, body: '{"body":"Original uncertain effect"}' };
      f.loseResponse();
      expect((await f.capability.fetch(genericWire('source', mutation))).status).toBe(409);
      f.restoreTransport();
      const originalReceipt = await receipt(f, mutation.operationId);
      expect(originalReceipt).toMatchObject({ phase: 'unknown', operationCount: 1 });
      const remote = await f.readRemoteComments(); await f.drainBackground();
      if (mode === 'recorder unavailable') await denyDiagnosticWrites(f);
      if (mode === 'warning unavailable') {
        setLogLevel('warn'); vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_WARNING_OUTAGE'); });
      }
      try {
        await invalidPreparationRefusal(await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(byteLimit + 1) })));
        await f.drainBackground();
      } finally { vi.restoreAllMocks(); setLogLevel('silent'); }
      expect(await receipt(f, mutation.operationId)).toEqual(originalReceipt);
      expect((await f.capability.fetch(genericWire('source', mutation))).status).toBe(409);
      expect(await f.readRemoteComments()).toEqual(remote);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.capability.fetch(corrected('authorized-after-observer-outage'))).status).toBe(200);
      expect(await receipt(f, 'authorized-after-observer-outage')).toMatchObject({ operationCount: 2 });
      if (mode === 'recorder unavailable') {
        expect((await diagnosticSummary(f)).health.gaps).toContain('recorder-unavailable');
        expect((await diagnosticsBrowser(f)('/diagnostics/v2/history')).status).toBe(503);
      } else if (mode === 'OFF') {
        expect((await diagnosticSummary(f)).capture).toBe('disabled');
        expect((await preparationFailures(f)).filter(record => record.preparation !== undefined)).toEqual([]);
      }
    }, { ...options, loggingEnabled: mode !== 'OFF' }));

  it.each(['producer', 'runtime', 'protected request'])(
    'REQ-OPERATOR-081: AC2 child %s cannot supply host preparation metadata', channel => fixture(async f => {
      await start(f);
      const preparation = { step: 'parse', failureClass: 'body-limit', route: 'source', byteLimit: 1, observedBytesLowerBound: 2 };
      const request = channel === 'producer' ? diagnosticReport({ stage: 'producer', role: 'comment', outcome: 'failed', code: 'effect-denied', preparation })
        : channel === 'runtime' ? diagnosticReport({ ...await runtimeEnvelope(f), preparation }, '/v1/dispatcher/diagnostic/runtime')
          : genericWire('source', { operationId: 'forged-preparation', url: sourceUrl, preparation });
      const response = await f.capability.fetch(request); expect(response.status).toBe(channel === 'runtime' ? 400 : 403);
      const failures = await preparationFailures(f);
      expect(failures.some(record => JSON.stringify(record.preparation) === JSON.stringify(preparation))).toBe(false);
      expect(failures.every(record => record.correlation?.submissionDigest === undefined && record.correlation?.deliveryDigest === undefined)).toBe(true);
      expect((await f.capability.fetch(corrected('after-forged-preparation'))).status).toBe(200);
      expect(await receipt(f, 'after-forged-preparation')).toMatchObject({ operationCount: 1 });
      expect(await f.readRemoteComments()).toEqual([]);
    }, { ...options, sdkDiagnostics: channel === 'runtime' }));
});

describe('REQ-OPERATOR-081: protected synthetic SDK runtime import', () => {
  const options = { repositoryOnly: true, recovery: true, sdkDiagnostics: true };
  const sdkRecords = async (f: DispatcherFixture) => (await diagnosticTraversal(diagnosticsBrowser(f))).records
    .filter(record => record.kind === 'event' && record.owner === 'sdk');

  it('REQ-OPERATOR-081: AC1/2/4 protected import persists independent digests and cause lineage through reconstruction', () => fixture(async f => {
    await start(f); const report = await runtimeEnvelope(f);
    const before = await f.activity.getBrowserDetail();
    await importRuntime(f, report); await importRuntime(f, report);
    const other = await runtimeEnvelope(f, 2); other.sdk!.attemptId = 'PRIVATE_SECOND_ATTEMPT';
    await importRuntime(f, other);
    f.restart(); await f.drainBackground();
    const records = await sdkRecords(f);
    expect(records).toHaveLength(2);
    expect(records.map(record => record.correlation?.sdkAttemptDigest)).toEqual([
      await digest('PRIVATE_SDK_ATTEMPT'), await digest('PRIVATE_SECOND_ATTEMPT'),
    ]);
    expect(records[0]).toMatchObject({ boundary: 'model', code: 'provider-failed', origin: 'originating',
      error: report.error, source: report.source, correlation: {
        rootDigest: await digest('fixture-incarnation'), submissionDigest: await digest('submission-1'),
        streamIncarnationDigest: await digest('PRIVATE_SDK_STREAM'), sdkBatchSequence: 7,
        sdkProducerEpoch: 3, sdkProducerSequence: 11, sdkRecordIndex: 2,
      } });
    for (const record of records) {
      expect(record.correlation?.hostAttemptIndex ?? null).toBeNull();
      expect(record.correlation?.chargedOrdinal ?? null).toBeNull();
      expect(record.correlation?.logicalOrdinal ?? null).toBeNull();
    }
    expect(await f.activity.getBrowserDetail()).toEqual(before);
    const summary = await diagnosticSummary(f);
    expect(summary.health.sdkImport).toBe('host-persisted');
    expect(summary.provenance.patchSetDigest).toBe(f.sdkPatchSetDigest);
    const detail = await diagnosticJson<{ record: DiagnosticRecord; capsule: Record<string, unknown> }>(
      await diagnosticsBrowser(f)(`/diagnostics/v2/records/${records[0].id}`));
    expect(detail.record).toEqual(records[0]);
    expect(detail.capsule).toMatchObject({ kind: 'failure', code: 'provider-failed', error: report.error,
      sdk: { rootDigest: await digest('fixture-incarnation'), attemptDigest: await digest('PRIVATE_SDK_ATTEMPT'),
        batchSequence: 7, recordIndex: 2, settlement: 'unknown' } });
  }, options));

  it.each(['unknown-field', 'version', 'capture-id', 'sequence-zero', 'unsafe-sequence', 'timestamp',
    'raw-error', 'unknown-source', 'caller-url', 'cause-overflow', 'frame-overflow', 'private-id-length',
    'unknown-record-type', 'command', 'local-negative', 'owner-claim', 'activity-claim', 'generation-claim',
    'unsafe-sdk-counter', 'null-sdk', 'extra-sdk', 'unknown-local', 'unknown-error-loss'])(
    'REQ-OPERATOR-081: AC2/5 runtime envelope rejects %s without retaining content or granting work', fault => fixture(async f => {
      await start(f); const valid = await runtimeEnvelope(f); await importRuntime(f, valid);
      const report = structuredClone(valid) as unknown as Record<string, unknown>;
      report.captureId = await digest(`invalid-${fault}`);
      if (fault === 'unknown-field') report.message = 'PRIVATE_RAW_MESSAGE';
      if (fault === 'version') report.version = 2;
      if (fault === 'capture-id') report.captureId = 'PRIVATE_CAPTURE';
      if (fault === 'sequence-zero') report.sequence = 0;
      if (fault === 'unsafe-sequence') report.sequence = Number.MAX_SAFE_INTEGER + 1;
      if (fault === 'timestamp') report.timestamp = 1.5;
      if (fault === 'raw-error') (report.error as Record<string, unknown>).message = 'PRIVATE_ERROR_BODY';
      if (fault === 'unknown-source') (report.source as Record<string, unknown>).package = 'PRIVATE_PACKAGE';
      if (fault === 'caller-url') (report.source as Record<string, unknown>).url = 'https://private.invalid/source';
      if (fault === 'cause-overflow') (report.error as Record<string, unknown>).causes = Array(4).fill(valid.error!.causes[0]);
      if (fault === 'frame-overflow') (report.source as Record<string, unknown>).frames = Array(5).fill({
        repository: 'nikolanovoselec/codeflare', commit: bundle.sourceCommit,
        path: 'src/__tests__/operators/fixtures/synthetic-sdk.ts', line: 1, column: 0, kind: 'patch-boundary',
      });
      if (fault === 'private-id-length') (report.sdk as Record<string, unknown>).attemptId = 'x'.repeat(513);
      if (fault === 'unknown-record-type') (report.sdk as Record<string, unknown>).recordType = 'PRIVATE_RECORD';
      if (fault === 'command') report.command = 'renew';
      if (fault === 'local-negative') (report.local as Record<string, unknown>).dropped = -1;
      if (fault === 'owner-claim') report.owner = 'PRIVATE_FOREIGN_OWNER';
      if (fault === 'activity-claim') report.activityId = 'foreign-activity';
      if (fault === 'generation-claim') report.generation = 2;
      if (fault === 'unsafe-sdk-counter') (report.sdk as Record<string, unknown>).recordIndex = Number.MAX_SAFE_INTEGER + 1;
      if (fault === 'null-sdk') report.sdk = null;
      if (fault === 'extra-sdk') (report.sdk as Record<string, unknown>).responseBody = 'PRIVATE_SDK_RESPONSE';
      if (fault === 'unknown-local') (report.local as Record<string, unknown>).message = 'PRIVATE_LOCAL_ERROR';
      if (fault === 'unknown-error-loss') (report.error as Record<string, unknown>).loss = ['PRIVATE_ERROR_LOSS'];
      const before = await f.activity.getBrowserDetail();
      await importRuntime(f, report, f.capability, 400);
      expect(await sdkRecords(f)).toHaveLength(1);
      expect(await f.activity.getBrowserDetail()).toEqual(before);
      expect(await f.readRemoteComments()).toEqual([]);
    }, options));

  it('REQ-OPERATOR-081: AC2/5 runtime rejects oversized UTF-8 payload before accepting metadata', () => fixture(async f => {
    await start(f); const report = await runtimeEnvelope(f); await importRuntime(f, report);
    await importRuntime(f, { ...report, captureId: 'é'.repeat(5000) }, f.capability, 413);
    expect(await sdkRecords(f)).toHaveLength(1);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, options));

  it.each(['generation', 'artifact', 'patch', 'root', 'submission'])(
    'REQ-OPERATOR-081: AC1/5 foreign %s runtime report cannot enter original retained history', fault => fixture(async f => {
      await start(f); const valid = await runtimeEnvelope(f); await importRuntime(f, valid);
      const report = await runtimeEnvelope(f, 2);
      if (fault === 'patch') report.source.patchSetDigest = 'e'.repeat(64);
      if (fault === 'root') report.sdk!.rootUid = 'PRIVATE_FOREIGN_ROOT';
      if (fault === 'submission') report.sdk!.submissionId = 'PRIVATE_FOREIGN_SUBMISSION';
      if (fault === 'artifact') await f.changeRetiredPin('artifactDigest');
      await importRuntime(f, report, fault === 'generation' ? f.staleCapability : f.capability, [403, 409]);
      if (fault !== 'artifact') expect(await sdkRecords(f)).toHaveLength(1);
      expect(await f.readRemoteComments()).toEqual([]);
    }, options));

  it('REQ-OPERATOR-081: AC1/3/4 late original runtime metadata enriches retired history without reopening owned work', () => fixture(async f => {
    await start(f); const first = await runtimeEnvelope(f); await importRuntime(f, first);
    await f.activity.cancelDrive(); const before = await f.activity.getBrowserDetail();
    const late = await runtimeEnvelope(f, 2); late.boundary = 'release'; late.source.boundary = 'release';
    late.code = 'cleanup-failed'; await importRuntime(f, late);
    f.restart(); await f.drainBackground();
    expect(await sdkRecords(f)).toHaveLength(2);
    expect(await f.environment.OPERATOR_ACTIVITY!.getByName(f.activityId).getBrowserDetail()).toEqual(before);
    for (const read of f.ownedChildReadbacks()) await expect(read()).rejects.toThrow();
    expect((await f.capability.fetch(genericWire('source', { operationId: 'late-import-no-effect',
      method: 'POST', url: 'https://api.github.com/repos/another/service/issues/17/comments',
      body: '{"body":"must not execute"}' }))).status).toBe(403);
    expect(await f.readRemoteComments()).toEqual([]);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { ...options, intent4: true, facetContract: true }));

  it('REQ-OPERATOR-081: AC1/2/4 normal SDK response header imports already-read evidence without changing settlement or collection', () => fixture(async f => {
    await start(f); await diagnosticSummary(f);
    const report = await runtimeEnvelope(f);
    // The bounded source header can omit an unacknowledged record without dropping it.
    f.sdkHeader(encodeSdkHeader({ version: 1, records: [], outbox: { through: 1, dropped: 0, status: 'loss' } }));
    await f.activity.reconcileDispatcherLease(); await f.drainBackground();
    expect((await diagnosticSummary(f)).health).toMatchObject({ sdkImport: 'pending', gaps: ['sdk-import-incomplete'] });
    f.sdkHeader(encodeSdkHeader({ version: 1, records: [report], outbox: { through: 1, dropped: 0, status: 'available' } }));
    await f.activity.reconcileDispatcherLease(); await f.drainBackground();
    expect((await diagnosticSummary(f)).health).toMatchObject({ sdkImport: 'host-persisted', gaps: [] });
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40), assessment: { classification: 'unknown' } };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease(); await f.drainBackground();
    // Background reconciliation performs the existing automatic collection; the header must not change it.
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', sdkCleanupReleased: true, result: assessment });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: assessment, executionStatus: 'completed' } });
    f.restart(); await f.drainBackground();
    expect(await sdkRecords(f)).toHaveLength(1);
    expect((await diagnosticSummary(f)).health).toMatchObject({ sdkImport: 'pending',
      sdkImportReason: 'retirement-tail-unwitnessed', gaps: ['sdk-import-incomplete'] });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: assessment } });
  }, options));

  it('REQ-OPERATOR-081: AC2/4 rejected runtime metadata increments honest loss without retaining raw error fields', () => fixture(async f => {
    await start(f); const valid = await runtimeEnvelope(f); await importRuntime(f, valid);
    const before = await diagnosticSummary(f); const state = await f.activity.getBrowserDetail();
    await importRuntime(f, { ...valid, captureId: await digest('rejected-raw-error'), error: {
      ...valid.error, message: 'PRIVATE_FORBIDDEN_ERROR_BODY', stack: '/private/PRIVATE_PATH' } }, f.capability, 400);
    const after = await diagnosticSummary(f);
    expect(after.retention.rejected).toBe(before.retention.rejected! + 1);
    expect(after.health.gaps).toContain('invalid-record');
    expect(after.health.status).toBe('loss');
    expect(await sdkRecords(f)).toHaveLength(1);
    expect(await f.activity.getBrowserDetail()).toEqual(state);
    await f.activity.cancelDrive(); await f.drainBackground();
    const retired = await diagnosticSummary(f);
    expect(retired.health.gaps).toEqual(expect.arrayContaining(['invalid-record', 'sdk-import-incomplete']));
    expect(retired.health.sdkImport).toBe('pending');
    expect(retired.health.sdkImportReason).toBeUndefined(); // Rejected evidence is not solely an unwitnessed tail.
  }, options));

  it('REQ-OPERATOR-081: AC1/4 unsupported legacy SDK source cannot become verified retained evidence', () => fixture(async f => {
    await start(f); const before = await f.activity.getBrowserDetail();
    await diagnosticSummary(f);
    await importRuntime(f, await runtimeEnvelope(f), f.capability, [403, 409]);
    expect(await sdkRecords(f)).toEqual([]);
    expect((await diagnosticSummary(f)).health.sdkImport).toBe('legacy');
    expect(await f.activity.getBrowserDetail()).toEqual(before);
  }, { repositoryOnly: true }));

  it('REQ-OPERATOR-081: AC3 logging OFF acknowledges runtime suppression without optional evidence persistence', () => fixture(async f => {
    await start(f); const report = await runtimeEnvelope(f); await importRuntime(f, report);
    await f.activity.cancelDrive(); f.restart(); await f.drainBackground();
    const summary = await diagnosticSummary(f);
    expect(summary).toMatchObject({ capture: 'disabled', fence: { code: 'cancelled' } });
    expect(summary.health.sdkImport).not.toBe('host-persisted');
    expect(await sdkRecords(f)).toEqual([]);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { ...options, loggingEnabled: false }));

  it('REQ-OPERATOR-081: AC1/4/7 declared local outbox loss is imported honestly without claiming unavailable causes', () => fixture(async f => {
    await start(f); const report = await runtimeEnvelope(f); report.local = { through: 100, dropped: 36, status: 'loss' };
    await importRuntime(f, report); f.restart(); await f.drainBackground();
    const summary = await diagnosticSummary(f);
    expect(summary.health.status).toBe('loss');
    expect(summary.health.gaps).toContain('sdk-import-incomplete');
    expect(await sdkRecords(f)).toHaveLength(1);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, options));

  it('REQ-OPERATOR-081: AC3/4/7 stalled synthetic local delivery leaves an import gap and cannot delay cancellation', () => fixture(async f => {
    await start(f); const report = await runtimeEnvelope(f);
    f.sdkHeader(encodeSdkHeader({ version: 1, records: [], outbox: { through: 1, dropped: 0, status: 'available' } }));
    await f.activity.reconcileDispatcherLease();
    const pendingSummary = await diagnosticSummary(f);
    expect(pendingSummary.health.sdkImport).toBe('pending');
    expect(pendingSummary.health.gaps).toContain('sdk-import-incomplete');
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    // Delay delivery before the parent transaction, never hold SQLite's global transaction lock.
    const delivery = held.then(() => importRuntime(f, report));
    try {
      const cancellation = await Promise.race([f.activity.cancelDrive(),
        new Promise<'delayed'>(resolve => setTimeout(() => resolve('delayed'), 1000))]);
      expect(cancellation).toMatchObject({ ok: true, state: { status: 'cancel-requested' } });
      const beforeImport = await diagnosticSummary(f);
      expect(beforeImport.health.gaps).toContain('sdk-import-incomplete');
      expect(await sdkRecords(f)).toEqual([]);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    } finally { release(); await delivery; }
    const afterImport = await diagnosticSummary(f);
    expect(afterImport.health).toMatchObject({ sdkImport: 'pending', sdkImportReason: 'retirement-tail-unwitnessed',
      gaps: ['sdk-import-incomplete'] });
    expect(afterImport.fence).toMatchObject({ code: 'cancelled' });
    expect(await sdkRecords(f)).toHaveLength(1);
    expect(await f.readRemoteComments()).toEqual([]);
  }, options));
});

describe('REQ-OPERATOR-081: additive legacy producer lineage', () => {
  it('REQ-OPERATOR-081: AC2 flat producer lineage retains bounded fingerprints without changing original 2048-byte wire outcome', () => fixture(async f => {
    await start(f);
    const report = { stage: 'producer', role: 'decide', phase: 'tool', outcome: 'failed', code: 'citation-provenance',
      errorKind: 'TypeError', errorDigest: await digest('PRIVATE_PRODUCER_ERROR'),
      errorStackDigest: await digest('PRIVATE_PRODUCER_STACK'),
      errorCauseDigests: [await digest('PRIVATE_PRODUCER_CAUSE')], errorCaptureLoss: ['cause-cycle'] };
    expect((await f.capability.fetch(diagnosticReport(report))).status).toBe(204);
    await f.drainBackground();
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({ owner: 'producer',
      boundary: 'tool', outcome: 'failed', error: expect.objectContaining({ kind: 'TypeError',
        messageDigest: report.errorDigest, stackDigest: report.errorStackDigest, loss: ['cause-cycle'] }) })]));
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true }));
});

describe('REQ-OPERATOR-081: deterministic recorder integrity and budgets', () => {
  const options = { repositoryOnly: true, sdkDiagnostics: true, recovery: true };
  it.each(['cancel', 'collect', 'failed-settlement'])(
    'REQ-OPERATOR-081: AC2/3 optional recorder write failure preserves original %s outcome and essential fence', scenario => fixture(async f => {
      await start(f); await importRuntime(f, await runtimeEnvelope(f));
      await denyDiagnosticWrites(f);
      const assessment = { readOnly: true, observedHead: 'b'.repeat(40), assessment: { classification: 'unknown' } };
      try {
        if (scenario === 'cancel') {
          expect(await f.activity.cancelDrive()).toMatchObject({ ok: true, state: { status: 'cancel-requested', generation: 2 } });
        } else if (scenario === 'collect') {
          f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
          f.settle(); await f.activity.reconcileDispatcherLease();
          expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
            executionStatus: 'completed', result: assessment, sdkCleanupReleased: true } });
        } else {
          f.settle('submission-1', 'failed', { type: 'operation_failed', meta: {
            operation: 'prompt', reason: 'PRIVATE_ORIGINAL_SDK_FAILURE' } });
          await f.activity.reconcileDispatcherLease();
          expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
          expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        }
      } finally { vi.restoreAllMocks(); }
      f.restart(); await f.drainBackground();
      const summary = await diagnosticSummary(f);
      expect(['loss', 'unavailable']).toContain(summary.health.status);
      expect(summary.health.gaps).toContain('recorder-unavailable');
      if (scenario === 'collect') {
        expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: assessment } });
      } else {
        expect(summary.fence).toMatchObject({ code: scenario === 'cancel' ? 'cancelled' : 'settlement-failed' });
        expect((await f.capability.fetch(genericWire('source', { operationId: 'recorder-no-replay',
          method: 'POST', url: 'https://api.github.com/repos/another/service/issues/17/comments',
          body: '{"body":"must not execute"}' }))).status).toBe(403);
      }
      expect(await f.readRemoteComments()).toEqual([]);
    }, options));

  it('REQ-OPERATOR-081: AC2/3 recorder outage preserves committed cache bytes and does not repeat remote effects', () => fixture(async f => {
    await start(f); await importRuntime(f, await runtimeEnvelope(f));
    const wire = { operationId: 'PRIVATE_CACHE_DURING_RECORDER_OUTAGE', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"PRIVATE_ORIGINAL_EFFECT"}' };
    const response = await f.capability.fetch(genericWire('source', wire));
    expect(response.status).toBe(200); const original = await response.text();
    const remote = await f.readRemoteComments();
    await denyDiagnosticWrites(f);
    try {
      expect(await (await f.capability.fetch(genericWire('source', wire))).text()).toBe(original);
      expect(await f.readRemoteComments()).toEqual(remote);
      await f.activity.cancelDrive();
      expect((await f.capability.fetch(genericWire('source', wire))).status).toBe(403);
    } finally { vi.restoreAllMocks(); }
    expect((await diagnosticSummary(f)).fence).toMatchObject({ code: 'cancelled' });
    expect(await f.readRemoteComments()).toEqual(remote);
  }, { ...options, receiptFixture: true }));

  it.each(['missing', 'null', 'version', 'foreign-binding', 'invalid-counter', 'overflow-list'])(
    'REQ-OPERATOR-081: AC4 expected %s index reconstructs as unavailable rather than legacy or zero loss', fault => fixture(async f => {
      await start(f); await diagnosticSummary(f);
      const { index: healthyIndex } = await seedDiagnosticSnapshot(f);
      await f.mutateEvidence(async storage => {
        const index = await storage.get<FixtureDiagnosticIndex>(diagnosticIndexKey);
        if (fault === 'missing') await storage.delete(diagnosticIndexKey);
        else if (fault === 'null') await storage.put(diagnosticIndexKey, null);
        else await storage.put(diagnosticIndexKey, { ...index,
          ...(fault === 'version' ? { version: 99 } : fault === 'foreign-binding' ? { artifactDigest: 'e'.repeat(64) }
            : fault === 'invalid-counter' ? { evictedRoutine: -1 }
              : { routineIds: Array.from({ length: 1537 }, (_, index) => `e-${index + 1}`) }) });
      });
      f.restart(); await f.drainBackground();
      const get = diagnosticsBrowser(f); const summary = await diagnosticSummary(f);
      expect(summary.capture).toBe('unavailable');
      expect(summary.health).toMatchObject({ status: 'unavailable', sdkImport: 'unavailable' });
      expect(summary.health.gaps).toContain('recorder-unavailable');
      expect(summary.diagnosis.state).toBe('evidence-incomplete');
      expect(summary.highWater.events).toBeNull();
      for (const key of ['epoch', 'firstSequence', 'lastSequence', 'evictedRoutine', 'droppedFailure',
        'droppedTerminal', 'oversized', 'rejected'] as const) expect(summary.retention[key]).toBeNull();
      for (const route of ['/diagnostics/v2/history', '/diagnostics/v2/export']) {
        const response = await get(route); expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).not.toContain('PRIVATE_');
      }
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect(await f.readRemoteComments()).toEqual([]);
      if (fault === 'missing') {
        // A valid index cannot turn missing/corrupt recorder health into known zero loss.
        for (const health of [undefined, { version: 99 }]) {
          await f.mutateEvidence(async storage => {
            await storage.put(diagnosticIndexKey, healthyIndex);
            if (health === undefined) await storage.delete('dispatcher:diagnostics:health');
            else await storage.put('dispatcher:diagnostics:health', health);
          });
          const unavailable = await diagnosticSummary(f);
          expect(unavailable.capture).toBe('unavailable');
          expect(unavailable.health).toMatchObject({ status: 'unavailable', sdkImport: 'unavailable' });
          expect(unavailable.highWater.events).toBeNull();
          expect(unavailable.retention.evictedRoutine).toBeNull();
          expect(unavailable.retention.lastSequence).toBeNull();
          const response = await get('/diagnostics/v2/history');
          expect(response.status).toBe(503);
          expect(response.headers.get('cache-control')).toBe('no-store');
          expect(await response.text()).not.toMatch(/PRIVATE_|private\.jwt|parent-only/);
        }
      }
    }, options));

  it('REQ-OPERATOR-081: AC4/5 maximal admissible metadata stops on bytes and advances through every retained event', () => fixture(async f => {
    await start(f); await diagnosticSummary(f); await f.drainBackground();
    // Controlled public-shaped metadata, not evidence of SDK execution or source-frame capture.
    const records = Array.from({ length: 40 }, (_, index) => maximalDiagnosticEvent(2000 + index));
    for (const record of records) (record.source as Record<string, unknown>).patchSetDigest = f.sdkPatchSetDigest;
    // This is a complete synthetic retained snapshot, not a pending SDK outbox import.
    await seedDiagnosticSnapshot(f, records, { sdkImport: 'host-persisted' });
    const get = diagnosticsBrowser(f);
    const first = await diagnosticJson<DiagnosticPage>(await get('/diagnostics/v2/history'));
    expect(first.records.length).toBeGreaterThan(0);
    expect(first.records.length).toBeLessThanOrEqual(14);
    expect(first.nextCursor).toEqual(expect.any(String));
    const history = await diagnosticTraversal(get, '/diagnostics/v2/history', first);
    expect(history.records.map(record => record.id)).toEqual(records.map(record => record.id));
    for (const page of history.pages) expect(page.records.length).toBeLessThanOrEqual(14);
    expect(history.pages.at(-1)?.retainedStatus).toBe('complete');
    const exported = await diagnosticTraversal(get, '/diagnostics/v2/export');
    expect(exported.records).toEqual(history.records);
    await seedDiagnosticSnapshot(f, records, { sdkImport: 'unavailable', evictedRoutine: 1 });
    const loss = await diagnosticSummary(f);
    expect(loss.health).toMatchObject({ status: 'loss', sdkImport: 'unavailable' });
    expect(loss.health.gaps).toEqual(expect.arrayContaining(['routine-evicted', 'sdk-import-incomplete']));
    expect(loss.retention.evictedRoutine).toBe(1);
    expect((await diagnosticTraversal(get)).pages.at(-1)?.retainedStatus).toBe('loss');
  }, options));

  it('REQ-OPERATOR-081: AC2/4 oversized valid metadata is rejected with a truthful counter without changing execution', () => fixture(async f => {
    await start(f); const valid = await runtimeEnvelope(f); await importRuntime(f, valid);
    const before = await f.activity.getBrowserDetail(); const summary = await diagnosticSummary(f);
    const oversized = await runtimeEnvelope(f, 2);
    oversized.source.frames = syntheticFramePaths.map(path => ({ repository: 'nikolanovoselec/codeflare',
      commit: bundle.sourceCommit, path, line: 1, column: 0, kind: 'patch-boundary' }));
    oversized.sdk!.batchSequence = Number.MAX_SAFE_INTEGER; oversized.sdk!.producerEpoch = Number.MAX_SAFE_INTEGER;
    oversized.sdk!.producerSequence = Number.MAX_SAFE_INTEGER; oversized.sdk!.recordIndex = Number.MAX_SAFE_INTEGER;
    oversized.error!.causes = Array.from({ length: 3 }, () => ({ kind: 'SyntaxError',
      messageDigest: 'd'.repeat(64), stackDigest: 'e'.repeat(64) }));
    oversized.error!.loss = ['message-truncated', 'stack-truncated', 'cause-depth'];
    oversized.error!.fingerprintScope = 'bounded';
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeLessThanOrEqual(8192);
    await importRuntime(f, oversized);
    const after = await diagnosticSummary(f);
    expect(after.retention.oversized).toBe(summary.retention.oversized! + 1);
    expect(after.health.status).toBe('loss');
    expect(after.health.gaps).toContain('oversized-record');
    const records = (await diagnosticTraversal(diagnosticsBrowser(f))).records.filter(record => record.owner === 'sdk');
    expect(records).toHaveLength(1);
    expect(await f.activity.getBrowserDetail()).toEqual(before);
  }, options));

  it('REQ-OPERATOR-081: AC3/4 full synthetic terminal reserve drops the later capsule but preserves authoritative cancellation', () => fixture(async f => {
    await start(f); await diagnosticSummary(f); await f.drainBackground();
    const ids = Array.from({ length: 64 }, (_, index) => `t-${index + 2}`);
    const { binding } = await seedDiagnosticSnapshot(f, [], { terminalIds: ids });
    await f.mutateEvidence(async storage => {
      for (let index = 0; index < ids.length; index++) await storage.put(`dispatcher:diagnostics:capsule:${ids[index]}`, {
        id: ids[index], kind: 'terminal', binding: { ...binding, generation: index + 2 }, eventId: null,
        code: 'cancelled', error: null, lastHostPersistedId: null, sdk: null,
        affectedOperations: [], affectedOperationsOmitted: null, loss: ['legacy-uncaptured'], uncertainty: 'evidence-incomplete',
      });
    });
    // Reserve-allocation qualification only: these are prefilled metadata slots,
    // not a claim that 64 native runs or terminal generations were executed.
    expect(await f.activity.cancelDrive()).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
    f.restart(); await f.drainBackground();
    const summary = await diagnosticSummary(f);
    expect(summary.fence).toMatchObject({ code: 'cancelled' });
    expect(summary.retention.droppedTerminal).toBe(1);
    expect(summary.health.gaps).toContain('terminal-overflow');
    expect(summary.health.status).toBe('loss');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await f.capability.fetch(genericWire('source', { operationId: 'no-terminal-reserve-replay',
      url: 'https://api.github.com/repos/another/service' }))).status).toBe(403);
  }, options));
});

describe('REQ-OPERATOR-047/048: future inference attempt accounting', () => {
  const accountingRetryPolicy = { inferenceRetryBaseMs: 1, inferenceRetryMaxMs: 2 };
  const inference = (text = 'PRIVATE_INFERENCE_PROMPT') => genericWire('inference', { operationId: 'logical-inference',
    input: { messages: [{ role: 'user', content: text }] } });
  const complete = 'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const incomplete = 'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
  const sse = (body = complete) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const anchor = async (f: DispatcherFixture) => {
    expect((await f.capability.fetch(genericWire('source', { operationId: 'budget-anchor', url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
  };
  const budget = async (f: DispatcherFixture) => {
    const response = await f.capability.fetch(genericWire('receipt', { operationId: 'budget-anchor' }));
    expect(response.status).toBe(200);
    return response.json();
  };
  const paid = (f: DispatcherFixture) => f.sent.filter(request => request.url === 'https://api.openai.com/v1/chat/completions');
  function gate<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  }

  it('REQ-OPERATOR-048: configured successor delays finish within the unchanged short admission and retain charged cache', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f, 1000); await anchor(f);
    const response = await f.capability.fetch(inference());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(complete);
    expect(await budget(f)).toMatchObject({ operationCount: 5, operationLimit: 1024 });
    // REQ-OPERATOR-080: logical operation identity is not the latest host-attempt ordinal.
    const diagnostic = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(diagnostic).toMatchObject({ parent: { operations: { status: 'available', generation: 1,
      selection: 'highest-logical-ordinals', scan: 'complete', inspectedEntries: 2, omittedEntries: false,
      records: [
        { operationDigest: await digest('logical-inference'), ordinal: 1, status: 'completed', binding: null,
          responseDigest: await digest(complete), hostInference: { index: 4, ordinal: 4,
            status: 'completed', classification: 'usable', responseDigest: await digest(complete) } },
        { operationDigest: await digest('budget-anchor'), ordinal: 0, hostInference: null },
      ] } } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_INFERENCE_PROMPT|logical-inference|budget-anchor|api\.github\.com/);
    f.restart();
    expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
    expect(await budget(f)).toMatchObject({ operationCount: 5 });
    await f.drainBackground();
    const summary = await diagnosticSummary(f);
    expect(summary.diagnosis.state).toBe('recovered-failure');
    expect(summary.fence).toBeNull();
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    const attempts = history.records.filter(record => record.kind === 'event'
      && record.correlation?.logicalOrdinal === 1 && record.correlation?.hostAttemptIndex !== undefined);
    expect(new Set(attempts.map(record => record.correlation!.hostAttemptIndex))).toEqual(new Set([1, 2, 3, 4]));
    expect(attempts).toEqual(expect.arrayContaining([expect.objectContaining({
      correlation: expect.objectContaining({ logicalOrdinal: 1, hostAttemptIndex: 4, chargedOrdinal: 4 }),
    })]));
    // A host attempt must not invent an SDK attempt association.
    for (const record of attempts) expect(record.correlation?.sdkAttemptDigest ?? null).toBeNull();
  }, { repositoryOnly: true, recovery: true, inferenceAttemptLimit: 4,
    capacityPolicy: { inferenceRetryBaseMs: 1, inferenceRetryMaxMs: 2 },
    inferenceTransport: async (_request, attempt) => sse(attempt === 4 ? complete : incomplete) }));

  it.each(['incomplete', 'native-error', 'native-error-prefix', '429', '503', 'transport'] as const)(
    'REQ-OPERATOR-048: %s reserves one successor, delivers only its usable bytes and charges both attempts', failure => fixture(async f => {
      await start(f); await anchor(f);
      const result = await f.capability.fetch(inference());
      expect(result.status).toBe(200); expect(await result.text()).toBe(complete);
      expect(paid(f)).toHaveLength(2);
      expect(await paid(f)[0].clone().text()).toBe(await paid(f)[1].clone().text());
      expect(await budget(f)).toMatchObject({ operationCount: 3, operationLimit: 1024 });
      f.restart();
      expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
      expect(await budget(f)).toMatchObject({ operationCount: 3 });
      expect(paid(f)).toHaveLength(2);
    }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, inferenceAttemptLimit: 2,
      inferenceTransport: async (_request, attempt) => {
        if (attempt > 1) return sse();
        if (failure === 'transport') throw new Error('PRIVATE_UPSTREAM_ERROR');
        if (failure === '429' || failure === '503') return Response.json({ error: 'upstream unavailable' }, { status: Number(failure) });
        return sse(failure === 'native-error-prefix' ? 'data: {"error":{"code":"NATIVE_BEDROCK_STREAM_ERROR"}}\n\n' + `:${'x'.repeat(70 * 1024)}\n\n` + complete
          : failure === 'native-error' ? 'data: {"error":{"code":"NATIVE_BEDROCK_STREAM_ERROR"}}\n\n' : incomplete);
      } }));

  it.each([true, false])('REQ-OPERATOR-078: inference attempts emit only closed metadata under logging=%s', loggingEnabled => fixture(async f => {
    const logs: string[] = [];
    setLogLevel('info');
    const spy = vi.spyOn(console, 'log').mockImplementation(value => {
      // This existing privacy contract covers bounded metadata, not the separate
      // protected raw channel qualified by the new ON/OFF cases below.
      try { if (JSON.parse(String(value)).module === 'operator-execution') return; } catch { /* Keep unknown logs under the privacy assertion. */ }
      logs.push(String(value));
    });
    try {
      await start(f); await anchor(f);
      expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
      const observations = logs.flatMap(value => { try { return [JSON.parse(value)]; } catch { return []; } })
        .filter(value => value.module === 'operator-inference' && value.data?.stage === 'inference-attempt').map(value => value.data);
      if (loggingEnabled) expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ activityId: f.activityId, generation: 1, operationOrdinal: 1, inferenceAttempt: 1,
          inferenceAttemptLimit: 2, operationCount: 2, outcome: 'unknown', inferenceOutcome: 'transport' }),
        expect.objectContaining({ activityId: f.activityId, generation: 1, operationOrdinal: 2, inferenceAttempt: 2,
          operationCount: 3, outcome: 'completed', inferenceOutcome: 'usable', responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      ])); else expect(observations).toEqual([]);
      expect(logs.join('')).not.toMatch(/PRIVATE_INFERENCE_PROMPT|PRIVATE_UPSTREAM_ERROR/);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, loggingEnabled, inferenceAttemptLimit: 2, inferenceTransport: async (_request, attempt) => {
    if (attempt === 1) throw new Error('PRIVATE_UPSTREAM_ERROR');
    return sse();
  } }));

  it('REQ-OPERATOR-048: identical live callers join, changed input conflicts, and committed bytes never reopen', async () => {
    const entered = gate<void>(); const release = gate<Response>();
    await fixture(async f => {
      await start(f); await anchor(f);
      const first = f.capability.fetch(inference()); await entered.promise;
      const duplicate = f.capability.fetch(inference());
      const conflict = await f.capability.fetch(inference('changed'));
      expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT' });
      expect(await budget(f)).toMatchObject({ operationCount: 2 });
      release.resolve(sse());
      for (const response of await Promise.all([first, duplicate])) {
        expect(response.status).toBe(200); expect(await response.text()).toBe(complete);
      }
      f.restart();
      expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
      expect(paid(f)).toHaveLength(1);
      expect(await budget(f)).toMatchObject({ operationCount: 2 });
    }, { repositoryOnly: true, recovery: true, inferenceTransport: async () => { entered.resolve(); return release.promise; } });
  });

  it.each([1, 2])('REQ-OPERATOR-048: attempt limit %i includes the initial request and cannot be replenished by delivery', limit => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f);
    const result = await f.capability.fetch(inference());
    expect(result.status).toBe(409); expect(await result.json()).toEqual({ code: 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED',
      reason: 'execution-inactive', disposition: 'authority-denied' });
    expect(paid(f)).toHaveLength(limit);
    f.restart();
    expect((await f.capability.fetch(inference())).status).toBe(403);
    expect(paid(f)).toHaveLength(limit);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null, collectionStatus: 'unavailable' });
    const summary = await retainedFence(f, 'capacity-exhausted', 'recovery');
    expect(summary.diagnosis.state).toBe('observed-failure');
    expect(summary.diagnosis.code).toBe('capacity-exhausted');
  }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, inferenceAttemptLimit: limit, inferenceTransport: async () => sse(incomplete) }));

  it.each([{ limit: undefined, attempts: 4 }, { limit: 5, attempts: 5 }])(
    'REQ-OPERATOR-048: the default is four, not a ceiling ($attempts attempts)', ({ limit, attempts }) => fixture(async f => {
      await start(f, 60_000); await anchor(f);
      expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
      expect(paid(f)).toHaveLength(attempts);
      expect(await budget(f)).toMatchObject({ operationCount: attempts + 1 });
    }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, inferenceAttemptLimit: limit,
      inferenceTransport: async (_request, attempt) => sse(attempt === attempts ? complete : incomplete) }), 60_000);

  it('REQ-OPERATOR-047: the shared operation budget denies a successor even with inference attempts remaining', () => fixture(async f => {
    await start(f); await anchor(f);
    expect(await budget(f)).toMatchObject({ operationCount: 1, operationLimit: 2 });
    expect(await (await f.capability.fetch(inference())).json()).toEqual({ code: 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED',
      reason: 'operation-limit', disposition: 'authority-denied' });
    expect(paid(f)).toHaveLength(1);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true, recovery: true, operationLimit: 2, inferenceAttemptLimit: 5, inferenceTransport: async () => sse(incomplete) }));

  it.each(['oversized', 'encoding', 'malformed', 'media-type'] as const)(
    'REQ-OPERATOR-048: %s response does not authorize another paid request', failure => fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(inference())).status).toBe(409);
      expect(paid(f)).toHaveLength(1);
      expect((await f.capability.fetch(inference())).status).toBe(403);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
    }, { repositoryOnly: true, recovery: true, inferenceRequestBytes: 512, inferenceTransport: async () => failure === 'oversized'
      ? sse('x'.repeat(513)) : failure === 'encoding' ? new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'content-type': 'text/event-stream' } })
        : failure === 'media-type' ? new Response('<html>upstream failure</html>') : sse('data: {invalid}\n\n') }));

  it.each([400, 401, 403])('REQ-OPERATOR-048: terminal HTTP %i is an immutable SDK error, not a fresh paid attempt', status => fixture(async f => {
    await start(f); await anchor(f);
    const result = await f.capability.fetch(inference());
    expect(result.status).toBe(status); const body = await result.text();
    f.restart();
    const repeated = await f.capability.fetch(inference());
    expect(repeated.status).toBe(status); expect(await repeated.text()).toBe(body);
    expect(paid(f)).toHaveLength(1); expect(await budget(f)).toMatchObject({ operationCount: 2 });
  }, { repositoryOnly: true, recovery: true, inferenceTransport: async () => Response.json({ error: { message: 'context_length_exceeded' } }, { status }) }));

  it('REQ-OPERATOR-048: context overflow retains its original SDK signal without spending a same-input successor', () => fixture(async f => {
    await start(f);
    const body = 'data: {"choices":[{"delta":{},"finish_reason":"context_length_exceeded"}]}\n\n';
    expect(await (await f.capability.fetch(inference())).text()).toBe(body);
    f.restart(); expect(await (await f.capability.fetch(inference())).text()).toBe(body);
    expect(paid(f)).toHaveLength(1);
  }, { repositoryOnly: true, recovery: true,
    inferenceBody: 'data: {"choices":[{"delta":{},"finish_reason":"context_length_exceeded"}]}\n\n' }));

  it.each(['session', 'grant', 'cancel', 'deadline', 'route', 'installation', 'digest'] as const)(
    'REQ-OPERATOR-048: %s fencing during an attempt prevents response consumption and successor dispatch', async reason => {
      let invalidate!: () => Promise<unknown> | void;
      await fixture(async f => {
        invalidate = reason === 'session' ? f.revokeSession : reason === 'grant' ? f.revokeGrant
          : reason === 'cancel' ? () => f.activity.cancelDrive() : reason === 'deadline' ? f.expire
            : () => f.changeInferenceAuthority(reason);
        await start(f);
        expect((await f.capability.fetch(inference())).status).not.toBe(200);
        expect(paid(f)).toHaveLength(1);
        expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: false });
        f.restart(); expect((await f.capability.fetch(inference())).status).toBe(403);
        expect(paid(f)).toHaveLength(1);
      }, { repositoryOnly: true, recovery: true, inferenceTransport: async () => { await invalidate(); return sse(); } });
    });

  it('REQ-OPERATOR-048: a reconstructed owner charges the uncertain predecessor and rejects its late result without fencing the successor', async () => {
    const firstEntered = gate<void>(); const secondEntered = gate<void>();
    const firstRelease = gate<Response>(); const secondRelease = gate<Response>();
    await fixture(async f => {
      await start(f); await anchor(f);
      const previous = f.capability.fetch(inference()); await firstEntered.promise;
      const replacement = f.restart();
      const successor = f.capability.fetch(inference()); await secondEntered.promise;
      firstRelease.resolve(sse(complete.replace('answer', 'late-original')));
      expect((await previous).status).toBe(409);
      expect(await replacement.getBrowserDetail()).toMatchObject({ executionStatus: 'running' });
      secondRelease.resolve(sse());
      expect(await (await successor).text()).toBe(complete);
      expect(await budget(f)).toMatchObject({ operationCount: 3 });
      expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
      expect(paid(f)).toHaveLength(2);
    }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, inferenceTransport: async (_request, attempt) => {
      if (attempt === 1) { firstEntered.resolve(); return firstRelease.promise; }
      secondEntered.resolve(); return secondRelease.promise;
    } });
  });

  it('REQ-OPERATOR-047: a lost successor-allocation acknowledgement reuses its durable allowance', () => fixture(async f => {
    await start(f); await anchor(f); f.loseAllocationAcknowledgement();
    expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
    expect(await budget(f)).toMatchObject({ operationCount: 3 });
    expect(paid(f)).toHaveLength(2);
  }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, inferenceTransport: async (_request, attempt) => sse(attempt === 1 ? incomplete : complete) }));

  it('REQ-OPERATOR-048: a reconstructed owner consumes the retained unclaimed successor without allocating another attempt', async () => {
    const entered = gate<void>(); const release = gate<Response>();
    await fixture(async f => {
      await start(f); await anchor(f);
      let successor: Promise<Response> | undefined;
      f.loseAllocationAcknowledgement(async () => {
        f.restart(); successor = f.capability.fetch(inference()); await entered.promise;
      });
      expect((await f.capability.fetch(inference())).status).toBe(409);
      expect(await budget(f)).toMatchObject({ operationCount: 3 });
      release.resolve(sse());
      expect(await (await successor!).text()).toBe(complete);
      expect(paid(f)).toHaveLength(2);
      expect(await budget(f)).toMatchObject({ operationCount: 3 });
    }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, inferenceTransport: async (_request, attempt) => {
      if (attempt === 1) return sse(incomplete);
      entered.resolve(); return release.promise;
    } });
  });

  it('REQ-OPERATOR-062: inference recovery neither repeats nor erases an unrelated uncertain repository write', () => fixture(async f => {
    await start(f); await anchor(f); f.loseResponse();
    const write = () => genericWire('source', { operationId: 'uncertain-comment', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"uncertain judgment"}' });
    expect((await f.capability.fetch(write())).status).toBe(409);
    f.restoreTransport();
    expect(await (await f.capability.fetch(inference())).text()).toBe(complete);
    expect((await f.capability.fetch(write())).status).toBe(409);
    const receipt = await f.capability.fetch(genericWire('receipt', { operationId: 'uncertain-comment' }));
    expect(await receipt.json()).toMatchObject({ phase: 'unknown', operationCount: 4 });
    expect(f.sent.filter(request => request.url.endsWith('/comments') && request.method === 'POST')).toHaveLength(1);
    expect(paid(f)).toHaveLength(2);
  }, { repositoryOnly: true, recovery: true, capacityPolicy: accountingRetryPolicy, inferenceTransport: async (_request, attempt) => sse(attempt === 1 ? incomplete : complete) }));

  it('REQ-OPERATOR-048: historical admissions retain their original cached error bytes despite the new default policy', () => fixture(async f => {
    await start(f);
    expect(await (await f.capability.fetch(inference())).text()).toBe(incomplete);
    f.restart(); expect(await (await f.capability.fetch(inference())).text()).toBe(incomplete);
    expect(paid(f)).toHaveLength(1);
  }, { repositoryOnly: true, inferenceBody: incomplete, inferenceAttemptLimit: 5 }));
});

describe('REQ-OPERATOR-081: host construction source boundary', () => {
  it('REQ-OPERATOR-081: AC1/2/3 Loader construction failure retains startup reason without protected effects', () => fixture(async f => {
    const loader = f.environment.LOADER!;
    // Existing external Worker Loader seam, not a missing-module/import failure.
    vi.spyOn(loader, 'get').mockImplementation(() => { throw new Error('PRIVATE_LOADER_CONSTRUCTION_FAILURE'); });
    try {
      expect(await start(f)).toMatchObject({ ok: true, state: { status: 'unknown' } });
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
      expect(f.childSubmissions).toEqual([]);
      expect(await f.readRemoteComments()).toEqual([]);
      await retainedFence(f, 'startup-failed', 'construction');
      expect((await f.capability.fetch(genericWire('source', { operationId: 'after-construction-failure',
        url: 'https://api.github.com/repos/another/service' }))).status).toBe(403);
    } finally { vi.restoreAllMocks(); }
  }, { repositoryOnly: true }));
});

describe('REQ-OPERATOR-047/048: production Dispatcher lease and restricted effects', () => {
  it.each([true, false])('REQ-OPERATOR-079: the real Tail entrypoint honors logging=%s without forwarding private child records', async loggingEnabled => {
    const records: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { records.push(String(value)); });
    try {
      const tail = new OperatorDispatcherTail({ props: { activityId: 'activity', generation: 1, loggingEnabled } } as unknown as ExecutionContext,
        env as unknown as ConstructorParameters<typeof OperatorDispatcherTail>[1]);
      await tail.tail([{ logs: [{ level: 'warn', message: ['Dispatcher inference boundary', { stage: 'fetch-rejected' }] },
        { level: 'warn', message: ['Dispatcher inference boundary', { stage: 'fetch-rejected', reason: 'PRIVATE_TAIL_CONTENT' }] }] }]);
      if (loggingEnabled) expect(records.map(value => JSON.parse(value).data)).toEqual([{ activityId: 'activity', generation: 1, stage: 'fetch-rejected' }]);
      else expect(records).toEqual([]);
      expect(records.join('')).not.toContain('PRIVATE_TAIL_CONTENT');
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  });
  it('binds only this Activity and generation into the child Tail Worker', () => fixture(async f => {
    await start(f);
    await f.deliverTail([{ logs: [{ message: ['Dispatcher inference boundary', { stage: 'fetch-rejected' }] }] }]);
    expect(f.deliveredTail).toEqual([{ activityId: f.activityId, generation: 1, stage: 'fetch-rejected' }]);
  }));
  it('REQ-OPERATOR-048: bounded diagnostic report uses trusted Activity/generation and leaves execution running', () => fixture(async f => {
    await start(f);
    const before = await f.activity.getBrowserDetail();
    setLogLevel('warn');
    const events: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      expect((await f.capability.fetch(diagnosticReport())).status).toBe(204);
      expect((await f.capability.fetch(diagnosticReport({ stage: 'http-rejected', status: 422 }))).status).toBe(204);
      const reports = events.map(value => JSON.parse(value) as { module: string; data: Record<string, unknown> })
        .filter(value => value.module === 'dispatcher-inference-report');
      expect(reports.map(value => value.data)).toEqual([
        { activityId: f.activityId, generation: 1, stage: 'fetch-rejected' },
        { activityId: f.activityId, generation: 1, stage: 'http-rejected', status: 422 },
      ]);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: before!.executionStatus,
        cleanupStatus: before!.cleanupStatus, checkpoint: before!.checkpoint, result: before!.result });
      expect((await f.capability.fetch(read('after-valid-report'))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));

  it('REQ-OPERATOR-049/078: one disabled logging setting suppresses execution diagnostics without changing fences or effects', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    setLogLevel('debug');
    const output: string[] = [];
    const spies = ['log', 'debug', 'info', 'warn', 'error'].map(level => vi.spyOn(console, level as 'warn').mockImplementation(value => { output.push(String(value)); }));
    try {
      await start(f);
      expect(await f.loaderEnv()).toMatchObject({ OPERATOR_LOGGING_ENABLED: 'false' });
      expect((await f.capability.fetch(diagnosticReport({ stage: 'producer', role: 'decide', outcome: 'failed', code: 'citation-provenance' }))).status).toBe(204);
      expect((await f.capability.fetch(diagnosticReport())).status).toBe(204);
      expect((await f.capability.fetch(genericWire('source', { operationId: 'logging-disabled-read', url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
      f.settle('submission-1', 'failed', { type: 'operation_failed', meta: { operation: 'direct(submission-1)', reason: 'Citation provenance unavailable' } });
      await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
      expect(output.filter(value => /operator-inference|dispatcher-settlement|dispatcher-inference-report/.test(value))).toEqual([]);
      const assertSuppressedProjection = async () => f.mutateEvidence(async storage => {
        // Durable projection privacy is the logging-OFF contract, independent of console filtering.
        const lease = await storage.get<{ projection?: Record<string, unknown> }>('dispatcher:lease');
        expect(lease?.projection).toMatchObject({ outcome: 'failed' });
        for (const field of ['errorMetadata', 'settlementDiagnostic', 'sdkEvidence']) {
          expect(lease!.projection).not.toHaveProperty(field);
        }
        const admission = await storage.get<{ diagnosticFence?: unknown }>('admission');
        expect(admission?.diagnosticFence).toMatchObject({ generation: 1, code: 'settlement-failed', boundary: 'settlement' });
      });
      await assertSuppressedProjection();
      const retained = await retainedFence(f, 'settlement-failed', 'settlement');
      await assertSuppressedProjection();
      expect(retained.capture).toBe('disabled');
      const history = await diagnosticTraversal(diagnosticsBrowser(f));
      expect(history.records.filter(record => record.kind === 'event' && record.error !== undefined)).toEqual([]);
    } finally { spies.forEach(spy => spy.mockRestore()); setLogLevel('silent'); }
  }, { loggingEnabled: false, repositoryOnly: true }));
  it('REQ-OPERATOR-082: diagnostic error capture refuses unsafe transport getters without exposing private exception content', () => {
    let accessed = false;
    const error = Object.create(null);
    for (const field of ['message', 'stack', 'cause', 'transportStatus', 'transportReason', 'transportDisposition']) {
      Object.defineProperty(error, field, { get() { accessed = true; throw new Error('PRIVATE_GETTER_CONTENT'); } });
    }
    const captured = captureError(error);
    expect(captured).toMatchObject({ kind: 'other', messageDigest: null, stackDigest: null,
      loss: expect.arrayContaining(['unsafe-error-access']) });
    expect(accessed).toBe(false);
    expect(captured).not.toHaveProperty('transportStatus');
    expect(captured).not.toHaveProperty('transportReason');
    expect(captured).not.toHaveProperty('transportDisposition');
    expect(JSON.stringify(captured)).not.toContain('PRIVATE_GETTER_CONTENT');
  });

  it('REQ-OPERATOR-081: owner export retains safe originating transport refusal in event.error after successful recovery and reconstruction', () => fixture(async f => {
    await start(f);
    const metadata = { transportStatus: 403, transportReason: 'request-invalid', transportDisposition: 'operation-local' };
    const report = { stage: 'producer', role: 'comment', phase: 'response', outcome: 'failed', code: 'effect-denied',
      errorKind: 'TransportDenied', errorDigest: 'a'.repeat(64), errorCauseDigests: ['b'.repeat(64)], ...metadata };
    expect((await f.capability.fetch(diagnosticReport(report))).status).toBe(204);
    // Legacy producers can omit all new fields; no new ABI or success authority is implied.
    expect((await f.capability.fetch(diagnosticReport({ stage: 'producer', role: 'comment', outcome: 'completed', code: 'none' }))).status).toBe(204);
    const later = await f.capability.fetch(read('after-refusal-report'));
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({ number: 17, head: { sha: 'b'.repeat(40) } });
    await f.drainBackground();
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40), assessment: { classification: 'unknown' } };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    await f.drainBackground();
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true,
      detail: { executionStatus: 'completed', result: assessment } });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result: assessment });
    const restarted = f.restart();
    await f.drainBackground();
    const get = diagnosticsBrowser(f);
    const exported = await diagnosticTraversal(get, '/diagnostics/v2/export');
    const originating = exported.records.find(record => record.owner === 'producer' && record.outcome === 'failed');
    expect(originating).toMatchObject({ kind: 'event', boundary: 'tool', code: 'tool-failed',
      source: { package: '@codeflare/operator-dispatcher' }, error: { kind: 'TransportDenied', publicCode: 'effect-denied',
        messageDigest: report.errorDigest, causes: [{ kind: 'other', messageDigest: report.errorCauseDigests[0], stackDigest: null }], ...metadata } });
    const history = await diagnosticTraversal(get);
    expect(history.records.find(record => record.id === originating!.id)).toEqual(originating);
    const summary = await diagnosticSummary(f);
    expect(summary.fence).toBeNull();
    expect(await restarted.getBrowserDetail()).toMatchObject({ executionStatus: 'completed' });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { executionStatus: 'completed' } });
    expect(await f.activity.getDispatcherDiagnostics('f'.repeat(64))).toBeNull();
  }));

  it.each([undefined, 'none'] as const)('REQ-OPERATOR-083: transport-only report with error kind %s survives reconstructed owner readback without invented exception evidence', errorKind => fixture(async f => {
    await start(f);
    const metadata = { transportStatus: 403, transportReason: 'request-invalid', transportDisposition: 'operation-local' };
    expect((await f.capability.fetch(diagnosticReport({ stage: 'producer', role: 'comment', outcome: 'failed',
      code: 'effect-denied', ...(errorKind === undefined ? {} : { errorKind }), ...metadata }))).status).toBe(204);
    await f.drainBackground();
    f.restart();
    const get = diagnosticsBrowser(f);
    const exported = await diagnosticTraversal(get, '/diagnostics/v2/export');
    const originating = exported.records.find(record => record.owner === 'producer' && record.outcome === 'failed');
    expect(originating).toMatchObject({ kind: 'event', code: 'tool-failed', evidence: 'observed',
      error: { kind: 'other', publicCode: 'effect-denied', messageDigest: null, stackDigest: null,
        causes: [], loss: [], fingerprintScope: 'unavailable', ...metadata } });
    const history = await diagnosticTraversal(get);
    expect(history.records.find(record => record.id === originating!.id)).toEqual(originating);
    expect((await f.capability.fetch(read('after-transport-only-report'))).status).toBe(200);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(await f.activity.getDispatcherDiagnostics('f'.repeat(64))).toBeNull();
  }));

  it.each([
    { transportStatus: '403' }, { transportStatus: 200 }, { transportStatus: 600 }, { transportStatus: 403.5 },
    { transportReason: 'PRIVATE_REFUSAL_BODY' }, { transportDisposition: 'PRIVATE_REFUSAL_BODY' },
    { transportReason: { secret: 'PRIVATE_REFUSAL_BODY' } }, { transportDisposition: ['operation-local'] },
  ])('REQ-OPERATOR-079: malformed transport metadata %# cannot enter owner diagnostics or change protected work', metadata => fixture(async f => {
    await start(f);
    const rejected = await f.capability.fetch(diagnosticReport({ stage: 'producer', role: 'comment', phase: 'response',
      outcome: 'failed', code: 'effect-denied', errorKind: 'TransportDenied', ...metadata }));
    expect(rejected.status).toBe(403);
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(history.records.filter(record => record.owner === 'producer')).toEqual([]);
    expect(JSON.stringify(history)).not.toContain('PRIVATE_REFUSAL_BODY');
    const response = await f.capability.fetch(read('after-invalid-refusal-metadata'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ number: 17, head: { sha: 'b'.repeat(40) } });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }));

  it('REQ-OPERATOR-082: logging OFF suppresses safe transport details without rejecting reports or granting results', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(diagnosticReport({ stage: 'producer', role: 'comment', outcome: 'failed',
      code: 'effect-denied', errorKind: 'TransportDenied', transportStatus: 403,
      transportReason: 'request-invalid', transportDisposition: 'operation-local' }))).status).toBe(204);
    await f.drainBackground();
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(history.records.filter(record => record.owner === 'producer')).toEqual([]);
    expect(JSON.stringify(history)).not.toContain('transportReason');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await f.capability.fetch(read('after-suppressed-report'))).status).toBe(200);
    expect(f.sent.map(request => request.method)).toEqual(['GET']);
  }, { loggingEnabled: false }));

  it('REQ-OPERATOR-078: producer diagnostics identify citation failure without charging, authority or private content', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f);
    setLogLevel('warn');
    const events: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      const observation = { stage: 'producer', role: 'decide', phase: 'tool', outcome: 'failed', code: 'citation-provenance',
        targetCount: 27, decisionCount: 0, artifactCount: 54, sealed: false, claimIndex: 0, claimCount: 1,
        artifactFound: true, artifactComplete: true, status: 200, quoteMatched: true, commentContainsSource: false };
      expect((await f.capability.fetch(diagnosticReport(observation))).status).toBe(204);
      const report = events.map(value => JSON.parse(value)).find(value => value.message === 'Dispatcher producer diagnostic');
      expect(report.data).toEqual({ activityId: f.activityId, generation: 1, ...observation });
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.capability.fetch(genericWire('source', { operationId: 'after-producer-report', url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
      const receipt = await f.capability.fetch(genericWire('receipt', { operationId: 'after-producer-report' }));
      expect(await receipt.json()).toMatchObject({ operationCount: 1, operationLimit: 1024 });
      await f.drainBackground();
      const history = await diagnosticTraversal(diagnosticsBrowser(f));
      expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: 'event', owner: 'producer', boundary: 'tool', outcome: 'failed', evidence: 'observed',
      })]));
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true }));
  it.each([
    { stage: 'producer', role: 'decide', outcome: 'failed', code: 'citation-provenance', activityId: 'forged' },
    { stage: 'producer', role: 'decide', outcome: 'failed', code: 'citation-provenance', message: 'PRIVATE_PROVIDER_BODY_SENTINEL' },
    { stage: 'producer', role: 'decide', outcome: 'failed', code: 'citation-provenance', argumentFields: ['credential'] },
    { stage: 'producer', role: 'decide', outcome: 'failed', code: 'citation-provenance', targetCount: -1 },
    { stage: 'producer', role: 'private-secret', outcome: 'failed', code: 'citation-provenance' },
    { stage: 'producer', role: 'decide', outcome: 'failed', code: 'private-secret' },
    { stage: 'fetch-rejected', activityId: 'forged' }, { stage: 'fetch-rejected', reason: 'PRIVATE_PROVIDER_BODY_SENTINEL' },
    { stage: 'http-rejected', status: '422' }, { stage: 'http-rejected', status: 200 },
    { stage: 'http-rejected', status: 600 }, { stage: 'http-rejected', status: 422.5 },
    { stage: 'unknown' }, { stage: 'fetch-rejected', status: 422 }, 'PRIVATE_PROVIDER_BODY_SENTINEL',
  ])('REQ-OPERATOR-048: bounded diagnostic report rejects malformed child payload %#', body => fixture(async f => {
    await start(f);
    setLogLevel('warn');
    const events: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { events.push(String(value)); });
    try {
      expect((await f.capability.fetch(diagnosticReport(body))).status).toBe(403);
      expect(events.join('')).not.toContain('PRIVATE_PROVIDER_BODY_SENTINEL');
      expect(events.some(value => value.includes('dispatcher-inference-report'))).toBe(false);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report denies wrong route, method, content-type, syntax, byte size and stale generation', () => fixture(async f => {
    await start(f);
    const url = 'https://operator.internal/v1/dispatcher/diagnostic';
    for (const request of [diagnosticReport(undefined, '/v1/dispatcher/unrelated'),
      diagnosticReport(undefined, '/v1/dispatcher/diagnostic', 'GET'),
      new Request(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"stage":"fetch-rejected"}' }),
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"stage":' }),
      new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: `${' '.repeat(300)}{"stage":"fetch-rejected"}` }),
      diagnosticReport({ stage: 'http-rejected' })]) {
      expect((await f.capability.fetch(request)).status).toBe(403);
    }
    expect((await f.staleCapability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    expect((await f.capability.fetch(read('after-rejected-report'))).status).toBe(200);
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report refuses an unfinished body without holding the Activity', () => fixture(async f => {
    await start(f);
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"stage":"fetch-rejected"'));
    }, cancel() { canceled = true; } });
    const request = new Request('https://operator.internal/v1/dispatcher/diagnostic', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([f.capability.fetch(request),
        new Promise<'pending'>(resolve => { timer = setTimeout(() => resolve('pending'), 700); })]);
      expect(response).not.toBe('pending');
      expect((response as Response).status).toBe(403);
      expect(performance.now() - startedAt).toBeLessThan(400);
    } finally { clearTimeout(timer); }
    expect(canceled).toBe(true);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report denies revoked authority without relying on cancellation', () => fixture(async f => {
    await start(f);
    f.revoke();
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.result).toBeNull();
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report denies cancellation without relying on expiry', () => fixture(async f => {
    await start(f);
    await f.activity.cancelDrive();
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.result).toBeNull();
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report never extends its original human deadline', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(204);
    f.expire();
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
    expect((await f.capability.fetch(read('after-report-expiry'))).status).toBe(403);
    expect((await f.activity.getBrowserDetail())?.result).toBeNull();
  }));

  it('REQ-OPERATOR-078: producer failure reports have an independent bounded budget without consuming execution authority', () => fixture(async f => {
    await start(f);
    const body = { stage: 'producer', role: 'decide', outcome: 'failed', code: 'citation-provenance' };
    const responses = await Promise.all(Array.from({ length: 68 }, () => f.capability.fetch(diagnosticReport(body))));
    expect(responses.map(response => response.status).sort()).toEqual([...Array.from({ length: 64 }, () => 204), ...Array.from({ length: 4 }, () => 429)]);
    expect((await f.capability.fetch(diagnosticReport({ stage: 'producer', role: 'research', outcome: 'completed', code: 'none' }))).status).toBe(204);
    expect((await f.capability.fetch(diagnosticReport())).status).toBe(204);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }));
  it('REQ-OPERATOR-048: bounded diagnostic report caps concurrent valid reports at eight per live Activity generation', () => fixture(async f => {
    await start(f);
    const responses = await Promise.all(Array.from({ length: 12 }, () => f.capability.fetch(diagnosticReport())));
    expect(responses.map(response => response.status).sort()).toEqual([
      ...Array.from({ length: 8 }, () => 204), ...Array.from({ length: 4 }, () => 429),
    ]);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));

  it('REQ-OPERATOR-048: bounded diagnostic report tolerates unavailable owner logging without publishing a result', () => fixture(async f => {
    await start(f);
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_REPORT_FAILURE'); });
    try {
      expect((await f.capability.fetch(diagnosticReport())).status).toBe(403);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));

  it('exposes only PR identity, never a secret-bearing description', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(read('project-pr'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ number: 17, head: { sha: 'b'.repeat(40) }, base: { sha: 'a'.repeat(40) },
      user: { login: 'fork-specific-bot[bot]', id: 42, type: 'Bot' } });
    expect(JSON.stringify(body)).not.toContain('inline-secret');
  }));
  it('passes only complete image deltas from PR files, never secret-bearing patch context or other changes', () => fixture(async f => {
    await start(f);
    f.files([{ ...changedCompose('middleware/dozzle/compose.yaml'),
      patch: '@@ -1,3 +1,3 @@\n- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2\n  password: inline-secret' },
    { ...changedCompose('tools/dozzle_agent/compose.yaml'), additions: 2, deletions: 2,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2\n- DOZZLE_AUTH_TOKEN=inline-secret\n+ DOZZLE_AUTH_TOKEN=other-secret' },
    { filename: 'private/inline-secret.txt', status: 'modified', additions: 1, deletions: 1,
      patch: '-password=inline-secret\n+password=other-secret' }]);
    const response = await f.capability.fetch(read('safe-files', { resource: 'files' }));
    expect(response.status).toBe(200);
    const result = await response.json() as { data: Array<{ patch: string | null; filename: string }> };
    expect(result.data).toMatchObject([
      { filename: 'middleware/dozzle/compose.yaml', patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.2' },
      { filename: 'tools/dozzle_agent/compose.yaml', patch: null },
      { filename: '[other-changed-file]', patch: null },
    ]);
    expect(JSON.stringify(result)).not.toContain('inline-secret');
    expect(JSON.stringify(result)).not.toContain('other-secret');
  }));
  it('projects version-relevant default server and agent configuration without disclosing stable private values', () => fixture(async f => {
    await start(f);
    const paths = ['middleware/dozzle/compose.yaml', 'ai_llm/dozzle_agent/compose.yaml'];
    f.files(paths.map(path => changedCompose(path)));
    const bodies: Record<string, unknown> = {};
    for (const [index, path] of paths.entries()) {
      for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
        ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
        bodies[`${ref}:${path}`] = composeBlob(path, sha, index === 0
          ? `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n    environment:\n      DOZZLE_REMOTE_AGENT: agent.internal:7007\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '8080:8080'\n`
          : `services:\n  dozzle-agent:\n    image: amir20/dozzle:${tag}\n    command: agent\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '7007:7007'\n`);
      }
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ files: [
      { path: paths[0], unchangedConfiguration: true,
        before: { services: [{ mode: 'server', redacted: true, environmentKeys: ['DOZZLE_REMOTE_AGENT'] }] },
        after: { services: [{ mode: 'server', redacted: true, environmentKeys: ['DOZZLE_REMOTE_AGENT'] }] } },
      { path: paths[1], unchangedConfiguration: true,
        before: { services: [{ mode: 'agent', redacted: false }] },
        after: { services: [{ mode: 'agent', redacted: false }] } },
    ] });
    expect(JSON.stringify(result)).not.toContain('agent.internal');
    expect(JSON.stringify(result)).not.toContain('/private/docker.sock');
  }));
  it('does not hide harmless unchanged ports and Docker socket mounts on a default server', () => fixture(async f => {
    await start(f); const path = 'middleware/dozzle/compose.yaml'; f.files([changedCompose(path)]);
    const bodies: Record<string, unknown> = {};
    for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
      ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
      bodies[`${ref}:${path}`] = composeBlob(path, sha,
        `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n    container_name: private-dozzle\n    restart: unless-stopped\n    network_mode: bridge\n    volumes:\n      - /private/docker.sock:/var/run/docker.sock:ro\n    ports:\n      - '8080:8080'\n`);
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output).toMatchObject({ files: [{ unchangedConfiguration: true,
      before: { services: [{ mode: 'server', redacted: false }] },
      after: { services: [{ mode: 'server', redacted: false }] } }] });
    expect(JSON.stringify(output)).not.toContain('/private/docker.sock');
    expect(JSON.stringify(output)).not.toContain('private-dozzle');
  }));
  it.each([
    { name: 'persistent /data', property: "    volumes:\n      - /private/dozzle:/data\n" },
    { name: 'external env file', property: "    env_file: /private/agent.env\n" },
    { name: 'interpolated settings', property: "    environment:\n      DOZZLE_REMOTE_AGENT: ${DOZZLE_AGENTS}\n" },
    { name: 'external override', property: "    extends:\n      file: /private/shared.yml\n      service: dozzle\n" },
  ])('keeps $name unresolved despite unchanged image-excluded configuration', ({ property }) => fixture(async f => {
    await start(f); const path = 'middleware/dozzle/compose.yaml'; f.files([changedCompose(path)]);
    const bodies: Record<string, unknown> = {};
    for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
      ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
      bodies[`${ref}:${path}`] = composeBlob(path, sha,
        `services:\n  dozzle:\n    image: amir20/dozzle:${tag}\n${property}`);
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const output = await response.json();
    expect(output).toMatchObject({ files: [{ unchangedConfiguration: true,
      after: { services: [{ redacted: true }] } }] });
    expect(JSON.stringify(output)).not.toContain('/private/');
    expect(JSON.stringify(output)).not.toContain('${DOZZLE_AGENTS}');
  }));
  it('projects every admitted server and agent Compose blob at pinned base/head without leaking inline secrets', () => fixture(async f => {
    await start(f);
    const paths = ['middleware/dozzle/compose.yaml', 'tools/dozzle_agent/compose.yaml'];
    f.files(paths.map(path => changedCompose(path)));
    const bodies: Record<string, unknown> = {};
    for (const [index, path] of paths.entries()) {
      const service = index === 0 ? 'dozzle' : 'dozzle-agent';
      for (const [ref, tag, sha] of [['a'.repeat(40), 'v11.1.1', 'e'.repeat(40)],
        ['b'.repeat(40), 'v11.1.2', 'd'.repeat(40)]]) {
        bodies[`${ref}:${path}`] = composeBlob(path, sha,
          `services:\n  ${service}:\n    image: amir20/dozzle:${tag}\n    command: ${index === 0 ? 'server' : 'agent'}\n    environment:\n      DOZZLE_AUTH_TOKEN: inline-secret\n`);
      }
    }
    f.compose(bodies);
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    const result = await response.json() as { files: unknown[] };
    expect(result).toMatchObject({ repository: 'owner/repo', pullRequest: 17,
      baseSha: 'a'.repeat(40), observedHead: 'b'.repeat(40), files: paths.map(path => ({ path,
        before: { sha: 'e'.repeat(40), services: [{ image: 'amir20/dozzle:v11.1.1', mode: path.includes('agent') ? 'agent' : 'server', redacted: true }] },
        after: { sha: 'd'.repeat(40), services: [{ image: 'amir20/dozzle:v11.1.2', mode: path.includes('agent') ? 'agent' : 'server', redacted: true }] } })) });
    expect(JSON.stringify(result)).not.toContain('inline-secret');
    expect(JSON.stringify(result)).toContain('DOZZLE_AUTH_TOKEN');
  }));
  it.each([1000, 2000])('REQ-OPERATOR-047: admitted compose-read timeout %i bounds pinned configuration research', composeReadTimeoutMs => fixture(async f => {
    await start(f);
    const path = 'middleware/dozzle/compose.yaml';
    f.files([changedCompose(path)]);
    f.compose({ [`${'a'.repeat(40)}:${path}`]: composeBlob(path, 'e'.repeat(40), 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.1\n'),
      [`${'b'.repeat(40)}:${path}`]: composeBlob(path, 'd'.repeat(40), 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n') });
    f.exceedComposeDeadline();
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(composeReadTimeoutMs === 1000 ? 409 : 200);
    if (response.ok) expect(await response.json()).toMatchObject({ files: [{ path, unchangedConfiguration: true }] });
  }, { capacityPolicy: { composeReadTimeoutMs } }));

  it('reads pinned Compose blobs despite an omitted diff patch without inferring safety', () => fixture(async f => {
    await start(f);
    const path = 'middleware/dozzle/compose.yaml';
    f.files([{ ...changedCompose(path), patch: undefined }]);
    f.compose({ [`${'a'.repeat(40)}:${path}`]: composeBlob(path, 'e'.repeat(40),
      'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.1\n'),
    [`${'b'.repeat(40)}:${path}`]: composeBlob(path, 'd'.repeat(40),
      'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n') });
    const response = await f.capability.fetch(composeRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ files: [{ path, unchangedConfiguration: true,
      before: { sha: 'e'.repeat(40), services: [{ mode: 'server', redacted: false }] },
      after: { sha: 'd'.repeat(40), services: [{ mode: 'server', redacted: false }] } }] });
  }));
  it.each(['missing', 'wrong-sha', 'oversized', 'redirect', 'moved-base', 'moved-head', 'pagination', 'foreign-path'])('rejects $name changed Compose provenance', name => fixture(async f => {
    await start(f);
    const path = 'middleware/dozzle/compose.yaml';
    f.files(name === 'pagination' ? Array.from({ length: 101 }, (_, index) => changedCompose(`group-${index}/compose.yaml`))
      : [changedCompose(name === 'foreign-path' ? '../secrets/compose.yaml' : path)]);
    const before = composeBlob(path, 'e'.repeat(40), 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.1\n');
    const after = composeBlob(path, name === 'wrong-sha' ? 'f'.repeat(40) : 'd'.repeat(40),
      name === 'oversized' ? `services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n    labels: ${'x'.repeat(70_000)}`
        : 'services:\n  dozzle:\n    image: amir20/dozzle:v11.1.2\n');
    f.compose({ [`${'a'.repeat(40)}:${path}`]: before,
      ...name === 'missing' ? {} : { [`${'b'.repeat(40)}:${path}`]: name === 'redirect'
        ? new Response(null, { status: 302, headers: { location: 'https://evil.invalid/' } }) : after } });
    if (name === 'moved-base') f.moveBaseAfterContents();
    if (name === 'moved-head') f.moveHeadAfterFiles();
    expect((await f.capability.fetch(composeRead())).status).toBe(409);
  }));
  it('rejects child-selected paths, refs and URLs before protected Compose I/O', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(composeRead('chosen', { path: 'other/compose.yaml' }))).status).toBe(403);
    expect((await f.capability.fetch(composeRead('chosen-ref', { ref: 'a'.repeat(40) }))).status).toBe(403);
    expect((await f.capability.fetch(composeRead('chosen-url', { url: 'https://evil.invalid/' }))).status).toBe(403);
  }));
  it('reads only the release identified by the admitted PR diff and returns a pinned receipt', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ observedHead: 'b'.repeat(40),
      source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2',
      repository: 'amir20/dozzle', tag: 'v11.1.2', body: 'No configuration changes' });
    expect(f.sent.map(r => r.url)).toEqual([
      'https://api.github.com/repos/owner/repo/pulls/17',
      'https://api.github.com/repos/owner/repo/pulls/17/files?per_page=100&page=1',
      'https://api.github.com/repos/owner/repo/pulls/17',
      'https://api.github.com/repos/amir20/dozzle/releases/tags/v11.1.2',
      'https://api.github.com/repos/owner/repo/pulls/17',
    ]);
    expect(f.sent.every(r => !r.headers.has('authorization') && r.redirect === 'manual')).toBe(true);
  }));
  it('reads one cited upstream release for thirteen compose image changes of Komodo #1299', () => fixture(async f => {
    await start(f);
    f.files(['ai_llm', 'dns_ntp', 'komodo_core', 'media_servers', 'minecraft', 'nextcloud',
      'openziti-i', 'openziti-ii', 'openziti-iii', 'servarr', 'storage', 'tools']
      .map(group => ({ ...dozzleFiles()[0], filename: `${group}/dozzle_agent/compose.yaml` }))
      .concat([{ ...dozzleFiles()[0], filename: 'middleware/dozzle/compose.yaml' }]));
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.2', repository: 'amir20/dozzle',
      observedHead: 'b'.repeat(40) });
  }));
  it('derives a later eligible upstream release from the admitted PR rather than hardcoding #1299', () => fixture(async f => {
    await start(f); f.files(dozzleFiles('v11.1.2', 'v11.1.3'));
    f.release({ tag_name: 'v11.1.3', body: 'New migration notes',
      html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.3' });
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.3', body: 'New migration notes',
      source: 'https://github.com/amir20/dozzle/releases/tag/v11.1.3', observedHead: 'b'.repeat(40) });
  }));
  it('reads an immutable version-tagged official agent guide through a fixed parent source', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    const response = await f.capability.fetch(guideRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ repository: 'amir20/dozzle', tag: 'v11.1.2',
      observedHead: 'b'.repeat(40), commitSha: '1'.repeat(40),
      source: `https://github.com/amir20/dozzle/blob/${'1'.repeat(40)}/docs/guide/agent.md`,
      body: expect.stringContaining('run Dozzle with the `agent` subcommand') });
    expect(f.sent.map(r => r.url)).toContain(
      `https://api.github.com/repos/amir20/dozzle/contents/docs/guide/agent.md?ref=${'1'.repeat(40)}`);
    expect(f.sent.every(r => !r.headers.has('authorization') && r.redirect === 'manual')).toBe(true);
  }));
  it.each([8000, 10000])('REQ-OPERATOR-047: admitted release-read timeout %i bounds late complete research', releaseReadTimeoutMs => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedReleaseDeadline();
    const response = await f.capability.fetch(releaseRead());
    expect(response.status).toBe(releaseReadTimeoutMs === 8000 ? 409 : 200);
    if (response.ok) expect(await response.json()).toMatchObject({ body: 'No configuration changes', tag: 'v11.1.2' });
  }, { capacityPolicy: { releaseReadTimeoutMs } }));

  it.each([18000, 20000])('REQ-OPERATOR-047: admitted guide-read timeout %i bounds late verified research', guideReadTimeoutMs => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedGuideDeadline();
    const response = await f.capability.fetch(guideRead());
    expect(response.status).toBe(guideReadTimeoutMs === 18000 ? 409 : 200);
    if (response.ok) expect(await response.json()).toMatchObject({ body: guideExcerpt, commitSha: '1'.repeat(40) });
  }, { capacityPolicy: { guideReadTimeoutMs } }));

  it.each([new TextEncoder().encode(guideExcerpt).byteLength - 1, new TextEncoder().encode(guideExcerpt).byteLength])(
    'REQ-OPERATOR-047: admitted guide-byte limit %i preserves exact verified text or refuses it', guideBytes => fixture(async f => {
      await start(f); f.files(dozzleFiles());
      const response = await f.capability.fetch(guideRead());
      expect(response.status).toBe(guideBytes < new TextEncoder().encode(guideExcerpt).byteLength ? 409 : 200);
      if (response.ok) expect(await response.json()).toMatchObject({ body: guideExcerpt, blobSha: guideBlobSha });
    }, { capacityPolicy: { guideBytes } }));

  it('also binds a lightweight tag directly to a pinned guide commit', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    f.tag({ ref: 'refs/tags/v11.1.2', object: { type: 'commit', sha: '1'.repeat(40) } });
    const response = await f.capability.fetch(guideRead());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tag: 'v11.1.2', commitSha: '1'.repeat(40) });
    expect(f.sent.some(r => r.url.includes('/git/tags/'))).toBe(false);
  }));
  it.each([
    { name: 'wrong version tag', replace: (f: { tag: (value: unknown) => void }) =>
      f.tag({ ref: 'refs/tags/v11.1.1', object: { type: 'tag', sha: '3'.repeat(40) } }) },
    { name: 'unresolved tag object', replace: (f: { annotatedTag: (value: unknown) => void }) =>
      f.annotatedTag({ tag: 'v11.1.2', object: { type: 'tag', sha: '1'.repeat(40) } }) },
    { name: 'mismatched annotated tag', replace: (f: { annotatedTag: (value: unknown) => void }) =>
      f.annotatedTag({ tag: 'v11.1.1', object: { type: 'commit', sha: '1'.repeat(40) } }) },
    { name: 'wrong guide path', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/other.md', '2'.repeat(40), 'not an agent guide')) },
    { name: 'redirected guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(Response.json({ message: 'Moved' }, { status: 302 })) },
    { name: 'missing guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(Response.json({ message: 'Missing' }, { status: 404 })) },
    { name: 'invalid guide encoding', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide({ ...composeBlob('docs/guide/agent.md', '2'.repeat(40), 'agent'), content: '$not-base64' }) },
    { name: 'mismatched guide blob SHA', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/guide/agent.md', '2'.repeat(40), guideExcerpt)) },
    { name: 'oversized guide', replace: (f: { guide: (value: unknown) => void }) =>
      f.guide(composeBlob('docs/guide/agent.md', '2'.repeat(40), 'x'.repeat(70_000))) },
  ])('rejects a $name without exposing a guide to the child', ({ replace }) => fixture(async f => {
    await start(f); f.files(dozzleFiles()); replace(f);
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a moved PR while reading the version-tagged guide', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterRelease();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a moved base while reading the version-tagged guide', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveBaseAfterGuide();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }));
  it('rejects a late guide even when the upstream transport ignores abort', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedGuideDeadline();
    expect((await f.capability.fetch(guideRead())).status).toBe(409);
  }, { capacityPolicy: { guideReadTimeoutMs: 18000 } }));
  it('denies child-selected guide URL, repository and ref before upstream I/O', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    for (const extra of [{ url: 'https://evil.invalid/' }, { repository: 'other/repo' }, { ref: 'main' }]) {
      expect((await f.capability.fetch(guideRead('chosen', extra))).status).toBe(403);
    }
    expect(f.sent.every(r => !r.url.includes('/git/ref/tags/'))).toBe(true);
  }));
  it('rejects release evidence when the PR head changes after the files read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterFiles();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('rejects release evidence when the PR head changes during the upstream read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.moveHeadAfterRelease();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }));
  it('does not return late upstream notes even when a transport ignores abort', () => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.exceedReleaseDeadline();
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }, { capacityPolicy: { releaseReadTimeoutMs: 8000 } }));
  it.each([
    { files: [], name: 'no matching diff' },
    { files: [...dozzleFiles(), { filename: 'agent/compose.yaml', status: 'modified', additions: 1,
      deletions: 1 }], name: 'unavailable Compose patch' },
    { files: [{ ...dozzleFiles()[0], additions: 2,
      patch: `${dozzleFiles()[0].patch}\n+ image: amir20/dozzle:v11.1.3` }], name: 'mixed edits in one Compose patch' },
    { files: [{ ...dozzleFiles()[0], additions: 2 }], name: 'truncated Compose patch' },
    { files: [{ filename: 'compose.yaml', status: 'modified', additions: 1, deletions: 1,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: attacker/dozzle:v11.1.2' }], name: 'foreign image' },
    { files: [...dozzleFiles(), { filename: 'other/compose.yaml', status: 'modified', additions: 1, deletions: 1,
      patch: '- image: amir20/dozzle:v11.1.1\n+ image: amir20/dozzle:v11.1.3' }], name: 'conflicting image tag' },
  ])('does not fetch upstream for $name', ({ files }) => fixture(async f => {
    await start(f); f.files(files);
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
    expect(f.sent.every(r => !r.url.includes('/releases/'))).toBe(true);
  }));
  it.each([
    { value: { tag_name: 'v11.1.2', body: 'notes', html_url: 'https://evil.test/note' }, status: 200 },
    { value: { tag_name: 'v11.1.1', body: 'notes', html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.1' }, status: 200 },
    { value: { message: 'Moved' }, status: 302 },
    { value: { tag_name: 'v11.1.2', body: 'x'.repeat(70_000), html_url: 'https://github.com/amir20/dozzle/releases/tag/v11.1.2' }, status: 200 },
  ])('rejects unverified, redirecting or oversized upstream notes', ({ value, status }) => fixture(async f => {
    await start(f); f.files(dozzleFiles()); f.release(value, status);
    expect((await f.capability.fetch(releaseRead())).status).toBe(409);
  }, { capacityPolicy: { dispatcherRequestBytes: 65536 } }));
  it('denies child URL, repository and credential selection on release read', () => fixture(async f => {
    await start(f); f.files(dozzleFiles());
    expect((await f.capability.fetch(releaseRead('release-foreign', { url: 'https://evil.test/' }))).status).toBe(403);
    expect((await f.capability.fetch(releaseRead('release-other', { repository: 'other/repo' }))).status).toBe(403);
    expect(f.sent.every(r => !r.url.includes('/releases/tags/'))).toBe(true);
  }));
  it('reserves once; admission and unrelated settlement remain running; exact settlement alone permits continuation', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-active' });
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'waiting', checkpoint: null }))
      .toEqual({ ok: false, reason: 'invalid-update' });
    f.settle('foreign'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    // REQ-OPERATOR-081 AC1 and REQ-OPERATOR-083 AC1/2: real protected operations and the actual
    // waiting/continuation path, not a synthetic generation/index snapshot.
    for (let index = 0; index < 16; index++) {
      expect((await f.capability.fetch(read(index === 0 ? 'read-1' : `continuation-read-${index}`))).status).toBe(200);
    }
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    const get = diagnosticsBrowser(f);
    const first = await diagnosticJson<DiagnosticPage>(await get('/diagnostics/v2/history'));
    expect(first.nextCursor).toEqual(expect.any(String));
    const prior = await diagnosticTraversal(get, '/diagnostics/v2/history', first);
    const priorEvent = prior.records.find(record => record.kind === 'event')!;
    const operationDigest = await digest('read-1');
    const priorOperation = prior.records.find(record => record.id === `o-1-${operationDigest}`)!;
    expect(priorOperation).toMatchObject({ kind: 'operation', generation: 1, operationDigest });
    expect(await f.activity.beginDrive()).toMatchObject({ ok: true, state: { generation: 2 } });
    expect((await f.capability.fetch(read())).status).toBe(403);
    expect(await f.activity.admitDispatcher(2, f.bundle, f.artifactDigest, f.input))
      .toMatchObject({ ok: true, state: { status: 'running', generation: 2 } });
    expect((await f.staleCapability.fetch(read())).status).toBe(200);
    f.restart(); await f.drainBackground();
    const summary = await diagnosticSummary(f);
    expect(summary.binding).toEqual({ ...first.binding, generation: 2 });
    expect(summary.retention.epoch!).toBeGreaterThan(first.retention.epoch!);
    await diagnosticJson(await get(`/diagnostics/v2/history?cursor=${encodeURIComponent(first.nextCursor!)}`), 409);
    const retained = await diagnosticTraversal(get);
    expect(retained.records).toEqual(expect.arrayContaining(prior.records));
    expect(retained.records).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'operation', id: `o-2-${operationDigest}`, generation: 2, operationDigest,
    })]));
    const continuedEvents = retained.records.filter(record => record.kind === 'event' && record.generation === 2);
    expect(continuedEvents.length).toBeGreaterThan(0);
    expect(continuedEvents.every(record => record.sequence! > first.highWater.events!)).toBe(true);
    for (const record of [priorEvent, priorOperation]) {
      const detail = await diagnosticJson<{ record: DiagnosticRecord }>(await get(`/diagnostics/v2/records/${record.id}`));
      expect(detail.record).toEqual(record);
    }
    const exported = await diagnosticTraversal(get, '/diagnostics/v2/export');
    expect(exported.records).toEqual(retained.records);
  }));
  it('rechecks a later settlement before the bounded lease expires without caller continuation', () => fixture(async f => {
    const startedAt = Date.now();
    await start(f);
    await f.activity.reconcileDispatcherLease();
    const alarm = await f.nextAlarm();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThan(startedAt + 15_000);
    f.settle();
    vi.spyOn(Date, 'now').mockReturnValue(alarm! + 1_000);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: { assessment: { classification: 'unknown' } },
    } });
  }));
  it('REQ-OPERATOR-048: repeated SDK alarms retain one pending recheck and the original deadline', () => fixture(async f => {
    await start(f);
    const deadline = (await f.activity.listSchedules()).find(row =>
      row.callback === 'reconcileDispatcherLease' && row.type === 'scheduled');
    expect(deadline).toBeDefined();
    await f.activity.reconcileDispatcherLease();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    for (let i = 0; i < 12; i++) {
      const next = await f.nextAlarm();
      expect(next).not.toBeNull();
      expect(next!).toBeLessThan(now + 10_000);
      now = Math.max(now + 1_000, next! + 1_000);
      clock.mockReturnValue(now);
      await f.activity.alarm();
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      const scheduled = await f.activity.listSchedules();
      expect(scheduled.filter(row => row.callback === 'reconcileDispatcherLease' && row.type === 'scheduled')
        .map(row => row.time)).toEqual([deadline?.time]);
      expect(scheduled.filter(row => row.callback === 'reconcileDispatcherLease' && row.type === 'delayed').length)
        .toBe(1);
    }
    f.settle();
    const next = await f.nextAlarm();
    expect(next).not.toBeNull();
    now = Math.max(now + 1_000, next! + 1_000);
    clock.mockReturnValue(now);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: { assessment: { classification: 'unknown' } },
    } });
  }));
  it('REQ-OPERATOR-048: the original deadline still fences a pending SDK recheck', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f);
    const deadline = (await f.activity.listSchedules()).find(row =>
      row.callback === 'reconcileDispatcherLease' && row.type === 'scheduled');
    expect(deadline?.type).toBe('scheduled');
    await f.activity.reconcileDispatcherLease();
    vi.spyOn(Date, 'now').mockReturnValue(deadline!.time * 1_000 + 1_000);
    await f.activity.alarm();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    await retainedFence(f, 'deadline-expired');
  }));
  it('collects two inference turns and the exact assessment past the former 90-second budget while authority remains current', () => fixture(async f => {
    await start(f);
    const inference = (operationId: string) => new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId, input: { messages: [{ role: 'user', content: 'assess cited evidence' }] } }),
    });
    expect((await f.capability.fetch(inference('first-inference'))).status).toBe(200);
    f.advanceClock(112_000);
    expect((await f.capability.fetch(inference('second-inference'))).status).toBe(200);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('waiting');
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: { assessment: { classification: 'unknown' } },
    } });
  }));
  it('fences a late assessment after the original human authorization expires', () => fixture(async f => {
    await start(f);
    f.advanceClock(301_000);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await f.capability.fetch(read('late-assessment'))).status).toBe(403);
  }));
  it('never outlives a shorter original human-authorization deadline', () => fixture(async f => {
    await start(f);
    f.advanceClock(43_000);
    expect((await f.capability.fetch(read('before-human-expiry'))).status).toBe(200);
    f.advanceClock(46_000);
    expect((await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'after-human-expiry', input: { messages: [{ role: 'user', content: 'assess' }] } }),
    }))).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { humanLifetimeSeconds: 45 }));
  it('denies a revoked invoker past the former 90-second cutoff while human authority is otherwise current', () => fixture(async f => {
    await start(f);
    f.advanceClock(112_000);
    expect((await f.capability.fetch(read('before-revocation'))).status).toBe(200);
    f.revoke();
    expect((await f.capability.fetch(read('after-revocation'))).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }));
  it.each(['not-observed', 'succeeded', 'failed'] as const)(
    'REQ-OPERATOR-063: terminal diagnostic wire distinguishes %s completion from a missing assessment without accepting it', state => fixture(async f => {
      await start(f);
      const parts: unknown[] = [{ type: 'text', text: 'PRIVATE_MODEL_TEXT' }];
      if (state !== 'not-observed') parts.push({ type: 'dynamic-tool', toolName: 'finish_dispatcher',
        toolCallId: 'PRIVATE_TOOL_IDENTIFIER', state: state === 'succeeded' ? 'output-available' : 'output-error',
        output: 'PRIVATE_TOOL_OUTPUT', errorText: 'PRIVATE_TOOL_ERROR' });
      f.messages([{ submissionId: 'submission-1', parts }]);
      const emitted: string[] = [];
      setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      try {
        f.settle(); await f.activity.reconcileDispatcherLease();
        const events = emitted.map(value => JSON.parse(value) as { module: string; message: string; data?: Record<string, unknown> })
          .filter(value => value.module === 'dispatcher-settlement' && value.message === 'Dispatcher settlement observed');
        expect(events).toHaveLength(1);
        expect(events[0].data).toEqual({ activityId: f.activityId, generation: 1, outcome: 'completed',
          projectedWrites: 0, assessmentPresent: false, messageCount: 1,
          completionCalls: state === 'not-observed' ? 0 : 1, completionSucceeded: state === 'succeeded' ? 1 : 0,
          completionFailed: state === 'failed' ? 1 : 0, completionPending: 0,
          completionTruncated: false, unmatchedAssessment: false });
        expect(emitted.join('')).not.toContain('PRIVATE_');
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }),
  );
  it('REQ-OPERATOR-063: terminal diagnostic wire confirms an observed assessment without exposing it', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40), private: 'PRIVATE_ASSESSMENT_CONTENT' };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'dynamic-tool', toolName: 'finish_dispatcher', toolCallId: 'PRIVATE_TOOL_IDENTIFIER', state: 'output-available', output: assessment },
      { type: 'data-assessment', data: assessment },
    ] }]);
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      const event = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
        .find(value => value.message === 'Dispatcher settlement observed');
      expect(event?.data).toMatchObject({ activityId: f.activityId, generation: 1, outcome: 'completed',
        projectedWrites: 1, assessmentPresent: true, completionCalls: 1, completionSucceeded: 1 });
      expect(emitted.join('')).not.toContain('PRIVATE_');
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it.each(['capacity', 'receipt', 'ready'] as const)(
    'REQ-OPERATOR-076: seal-preflight.v1 trusted terminal %s metadata cannot authorize missing assessment', category => fixture(async f => {
      await start(f);
      const seal = { category, targetCount: 24, decisionCount: 24, sealed: category === 'ready',
        operationCount: category === 'receipt' ? null : 32, operationLimit: category === 'receipt' ? null : 128,
        requiredOperationCount: category === 'receipt' ? null : 97 };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-dispatcher-seal-preflight', data: seal }] }]);
      const emitted: string[] = []; setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      try {
        f.settle(); await f.activity.reconcileDispatcherLease();
        const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
          .find(value => value.message === 'Dispatcher settlement observed');
        expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1, outcome: 'completed',
          projectedWrites: 0, assessmentPresent: false, producerSealObserved: true, producerSealTruncated: false,
          producerSealCategory: category, producerSealTargetCount: 24, producerSealDecisionCount: 24,
          producerSealSealed: category === 'ready', producerSealOperationCount: seal.operationCount,
          producerSealOperationLimit: seal.operationLimit, producerSealRequiredOperationCount: seal.requiredOperationCount });
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }),
  );
  it('REQ-OPERATOR-076: invalid seal-preflight.v1 cannot expose private content or block validated collection', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-seal-preflight', data: { category: 'PRIVATE_PRODUCER_CONTENT', receipt: 'PRIVATE_RECEIPT_CONTENT' } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    const emitted: string[] = []; setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
        .find(value => value.message === 'Dispatcher settlement observed');
      expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1,
        projectedWrites: 1, assessmentPresent: true, producerSealObserved: false, producerSealTruncated: true });
      expect(emitted.join('')).not.toContain('PRIVATE_');
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('REQ-OPERATOR-076: seal-preflight.v1 logger outage preserves actual collection and SDK release', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-seal-preflight', data: { category: 'ready', targetCount: 1, decisionCount: 1,
        operationCount: 10, operationLimit: 128, requiredOperationCount: 5, sealed: true } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    setLogLevel('warn'); const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGER_ERROR'); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it.each(['ready', 'incomplete-results', 'unknown-operation'] as const)(
    'REQ-OPERATOR-063: readiness.v1 terminal wire exposes trusted closed %s metadata without accepting a missing assessment', category => fixture(async f => {
      await start(f);
      f.messages([{ submissionId: 'submission-1', parts: [
        { type: 'data-dispatcher-readiness', data: { discovered: true, sealed: true,
          targetCount: 2, decisionCount: 2, resultCount: category === 'ready' ? 2 : 1,
          unknownOperationCount: category === 'unknown-operation' ? 1 : 0, category } },
        { type: 'dynamic-tool', toolName: 'finish_dispatcher', toolCallId: 'PRIVATE_TOOL_IDENTIFIER',
          state: 'output-error', errorText: 'PRIVATE_TOOL_ERROR' },
      ] }]);
      const emitted: string[] = []; setLogLevel('warn');
      const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      try {
        f.settle(); await f.activity.reconcileDispatcherLease();
        const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
          .find(value => value.message === 'Dispatcher settlement observed');
        expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1, outcome: 'completed',
          projectedWrites: 0, assessmentPresent: false, producerReadinessObserved: true, producerReadinessTruncated: false,
          producerCategory: category, producerDiscovered: true, producerSealed: true,
          producerTargetCount: 2, producerDecisionCount: 2, producerResultCount: category === 'ready' ? 2 : 1,
          producerUnknownOperationCount: category === 'unknown-operation' ? 1 : 0 });
        expect(emitted.join('')).not.toContain('PRIVATE_');
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      } finally { spy.mockRestore(); setLogLevel('silent'); }
    }),
  );
  it('REQ-OPERATOR-063: invalid readiness.v1 terminal wire cannot expose content or block validated collection', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-readiness', data: { category: 'PRIVATE_PRODUCER_CONTENT' } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    const emitted: string[] = []; setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      const observed = emitted.map(value => JSON.parse(value) as { message: string; data?: Record<string, unknown> })
        .find(value => value.message === 'Dispatcher settlement observed');
      expect(observed?.data).toMatchObject({ activityId: f.activityId, generation: 1,
        projectedWrites: 1, assessmentPresent: true, producerReadinessObserved: false, producerReadinessTruncated: true });
      expect(emitted.join('')).not.toContain('PRIVATE_');
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('REQ-OPERATOR-063: readiness.v1 logging outage preserves actual result and SDK release', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [
      { type: 'data-dispatcher-readiness', data: { discovered: true, sealed: false,
        targetCount: 0, decisionCount: 0, resultCount: 0, unknownOperationCount: 0, category: 'ready' } },
      { type: 'data-assessment', data: assessment },
    ] }]);
    setLogLevel('warn'); const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGER_ERROR'); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('REQ-OPERATOR-063: unavailable terminal diagnostic logging cannot prevent valid collection or SDK release', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw new Error('PRIVATE_LOGGING_FAILURE'); });
    try {
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('fences a completed model turn with no submitted assessment instead of advertising waiting', () => fixture(async f => {
    await start(f);
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'text', text: 'Assessment incomplete' }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }));
  it('fences failed settlement rather than granting a continuation', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f); f.settle('submission-1', 'failed'); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
    await retainedFence(f, 'settlement-failed', 'settlement');
  }));
  for (const { name, error, errorType, operation, classification } of [
    { name: 'known model completion failure', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'Stream ended without finish_reason (retryable_interruption)' } }, errorType: 'operation_failed', operation: 'prompt', classification: 'model-completion' },
    { name: 'durable direct model completion failure', error: { type: 'operation_failed', meta: {
      operation: 'direct(submission-1)', reason: 'Stream ended without finish_reason (retryable_interruption)' } },
      errorType: 'operation_failed', operation: 'direct', classification: 'model-completion' },
    { name: 'durable direct persistence failure', error: { type: 'operation_failed', meta: {
      operation: 'direct(submission-1)', reason: 'the input could not be persisted' } },
      errorType: 'operation_failed', operation: 'direct', classification: 'persistence' },
    { name: 'untrusted direct label suffix', error: { type: 'operation_failed', meta: {
      operation: 'direct(submission-1) private.jwt', reason: 'the input could not be persisted' } },
      errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'other submission direct label', error: { type: 'operation_failed', meta: {
      operation: 'direct(other-submission)', reason: 'the input could not be persisted' } },
      errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'known input supersession', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'the session advanced past this input before it completed' } }, errorType: 'operation_failed', operation: 'prompt', classification: 'superseded' },
    { name: 'known input persistence failure', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'the input could not be persisted' } }, errorType: 'operation_failed', operation: 'prompt', classification: 'persistence' },
    { name: 'secret-suffixed completion lookalike', error: { type: 'operation_failed', meta: {
      operation: 'prompt', reason: 'Stream ended without finish_reason (retryable_interruption) private.jwt' } },
      errorType: 'operation_failed', operation: 'prompt', classification: 'unknown' },
    { name: 'unrecognized metadata', error: { type: 'operation_failed', meta: {
      operation: 'arbitrary-secret', reason: 'inline-secret' } }, errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'malformed metadata', error: { type: 'operation_failed', meta: { operation: { secret: 'private.jwt' }, reason: { secret: 'inline-secret' } } },
      errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'absent error', error: undefined, errorType: 'other', operation: 'unknown', classification: 'unknown' },
    { name: 'absent metadata', error: { type: 'operation_failed' }, errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'null metadata', error: { type: 'operation_failed', meta: null }, errorType: 'operation_failed', operation: 'unknown', classification: 'unknown' },
    { name: 'unrecognized error type', error: { type: 'inline-secret', meta: { operation: 'prompt', reason: 'Stream ended without finish_reason (retryable_interruption)' } },
      errorType: 'other', operation: 'unknown', classification: 'unknown' },
  ]) {
    it(`REQ-OPERATOR-048: diagnoses ${name} without leaking settlement metadata or replaying`, () => fixture(async f => {
    // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
      await start(f);
      const emitted: string[] = [];
      setLogLevel('warn');
      try {
        vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
        f.settle('submission-1', 'failed', error);
        await f.activity.reconcileDispatcherLease();
        const events = emitted.map(value => JSON.parse(value) as { module: string; message: string;
          data?: Record<string, unknown> }).filter(event => event.module === 'dispatcher-settlement'
          && event.message === 'Dispatcher settlement rejected' && event.data?.stage === 'outcome');
        expect(events).toHaveLength(1);
        const detail = await f.activity.getBrowserDetail();
        expect(detail?.activityId).toMatch(/^activity-[0-9a-f-]{36}$/);
        expect(events[0].data).toMatchObject({ activityId: detail?.activityId,
          generation: 1, outcome: 'failed', errorType, operation, failureClass: classification });
        expect(Object.keys(events[0].data ?? {}).sort()).toEqual([
          'activityId', 'errorType', 'failureClass', 'generation', 'operation', 'outcome',
          'reasonAvailable', 'reasonBytes', 'reasonClass', 'reasonCode', 'reasonDigest', 'stage',
        ]);
        expect(events[0].data?.reasonDigest).toEqual(events[0].data?.reasonAvailable ? expect.stringMatching(/^[a-f0-9]{64}$/) : null);
        expect(JSON.stringify(events)).not.toMatch(/private\.jwt|inline-secret|arbitrary-secret/);
        expect(detail?.executionStatus).toBe('unknown');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
        expect((await f.capability.fetch(read('after-failed'))).status).toBe(403);
        await retainedFence(f, 'settlement-failed', 'settlement');
        const history = await diagnosticTraversal(diagnosticsBrowser(f));
        expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({
          kind: 'event', boundary: 'settlement', code: 'settlement-failed', origin: 'state-transition', evidence: 'observed',
        })]));
      } finally { setLogLevel('silent'); }
    }));
  }
  it('REQ-OPERATOR-078: SDK failure fingerprint identifies a public rejection without exposing the reason or granting recovery', () => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      f.settle('submission-1', 'failed', { type: 'operation_failed', meta: {
        operation: 'direct(submission-1)', reason: 'Citation provenance unavailable' } });
      await f.activity.reconcileDispatcherLease();
      const report = emitted.map(value => JSON.parse(value)).find(value => value.message === 'Dispatcher settlement rejected');
      expect(report.data).toMatchObject({ reasonCode: 'citation-provenance',
        reasonDigest: '09154b2003b842c3c043252312ca33b20825cdf1560f91e02a4af060259b5441', failureClass: 'unknown' });
      expect(emitted.join('')).not.toContain('Citation provenance unavailable');
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
      const assertFingerprintProjection = async () => f.mutateEvidence(async storage => {
        const lease = await storage.get<{ projection?: Record<string, unknown> }>('dispatcher:lease');
        expect(lease?.projection).toMatchObject({ outcome: 'failed',
          errorMetadata: { publicCode: 'citation-provenance', messageDigest: report.data.reasonDigest },
          settlementDiagnostic: { reasonAvailable: true, reasonCode: 'citation-provenance',
            reasonDigest: report.data.reasonDigest, reasonBytes: 31, reasonClass: 'none' } });
        expect(JSON.stringify(lease?.projection)).not.toContain('Citation provenance unavailable');
      });
      await assertFingerprintProjection();
      const before = await f.activity.getBrowserDetail();
      const fence = (await diagnosticSummary(f)).fence;
      expect(fence).toMatchObject({ generation: 1, code: 'settlement-failed', boundary: 'settlement' });
      const logsBeforeRestart = [...emitted];
      f.restart(); await f.drainBackground();
      await assertFingerprintProjection();
      expect(await f.activity.getBrowserDetail()).toEqual(before);
      expect((await diagnosticSummary(f)).fence).toEqual(fence);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await start(f)).toEqual({ ok: false, reason: 'drive-settled' });
      expect(emitted).toEqual(logsBeforeRestart);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }));
  it('collects the settled pinned assessment once as a terminal result without another submission', () => fixture(async f => {
    await start(f);
    const assessment = { repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
      evidence: { complete: false, stale: false, truncated: false, bot: 'renovate[bot]' },
      bounds: { files: 3, checks: 76 }, assessment: { classification: 'unknown',
        observedHead: 'b'.repeat(40), baseSha: 'a'.repeat(40), checks: { state: 'unconfigured', observedHead: null },
        reasons: ['No complete upstream evidence'], compatibility: 'Compatibility cannot be established',
        citations: [], gaps: ['Migration guidance unavailable'] } };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting',
      sdkCleanupReleased: true });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', collectionStatus: 'consumed', sdkCleanupReleased: true, result: assessment } });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
      executionStatus: 'completed', result: assessment } });
    expect((await f.activity.getBrowserDetail())?.result).toEqual(assessment);
  }));
  it('keeps SDK cleanup unproved on failure and retries only cleanup after terminal collection', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    const sdk = Agent.prototype as unknown as { _cf_cleanupFacetPrefix: (...args: unknown[]) => Promise<void> };
    const original = sdk._cf_cleanupFacetPrefix;
    let failCleanup = true;
    vi.spyOn(sdk, '_cf_cleanupFacetPrefix').mockImplementation(function (this: Agent, ...args: unknown[]) {
      if (failCleanup) throw new Error('Synthetic SDK cleanup failure');
      return original.apply(this, args);
    });
    try {
      await start(f);
      const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting', sdkCleanupReleased: false });
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: false, result: assessment } });
      failCleanup = false;
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
      f.restart(); await f.drainBackground();
      const summary = await diagnosticSummary(f);
      expect(summary.diagnosis.state).toBe('recovered-failure');
      const history = await diagnosticTraversal(diagnosticsBrowser(f));
      expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({
        kind: 'event', boundary: 'release', code: 'cleanup-failed', outcome: 'failed',
      })]));
    } finally { failCleanup = false; }
  }));
  it.each(['missing', 'foreign', 'duplicate', 'oversized'] as const)(
    'does not manufacture a terminal assessment from %s settled evidence', variant => fixture(async f => {
      await start(f);
      const output = { readOnly: true, observedHead: 'b'.repeat(40) };
      const part = { type: 'data-assessment', data: output };
      const messages = variant === 'missing' ? [] : variant === 'foreign'
        ? [{ submissionId: 'foreign', parts: [part] }]
        : [{ submissionId: 'submission-1', parts: variant === 'duplicate' ? [part, part]
          : [{ type: 'data-assessment', data: { payload: 'x'.repeat(70 * 1024) } }] }];
      f.messages(messages);
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
    }, { capacityPolicy: { assessmentBytes: 65536 } }));
  it('fences a single checks page exceeding the protected 64 KiB response bound', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(read('submission-pull-request'))).status).toBe(200);
    f.oversizedChecks(1, 70_000);
    expect((await f.capability.fetch(read('submission-checks', { resource: 'checks' }))).status).toBe(409);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
  }, { capacityPolicy: { dispatcherRequestBytes: 65536 } }));
  it('returns all 76 authorized check conclusions from bounded pages without forwarding large metadata', () => fixture(async f => {
    await start(f); f.oversizedChecks();
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { data: { check_runs: unknown[] }; truncated: boolean };
    expect(evidence.truncated).toBe(false);
    expect(evidence.data.check_runs).toHaveLength(76);
    expect(evidence.data.check_runs[75]).toEqual({ name: 'check-75', conclusion: 'success' });
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeLessThan(64 * 1024);
    expect(f.sent.some(request => new URL(request.url).searchParams.get('page') === '8')).toBe(true);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
  it.each([2, 3])('REQ-OPERATOR-047: configured %i pages of three checks preserves complete conclusions or explicit truncation', checkRunPageLimit => fixture(async f => {
    await start(f); f.oversizedChecks(7, 0);
    const response = await f.capability.fetch(read('configured-check-pages', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { data: { check_runs: unknown[] }; truncated: boolean };
    expect(evidence.truncated).toBe(checkRunPageLimit === 2);
    if (checkRunPageLimit === 3) expect(evidence.data.check_runs).toEqual(Array.from({ length: 7 }, (_, index) => ({ name: `check-${index}`, conclusion: 'success' })));
    else expect(evidence.data.check_runs.length).toBeLessThanOrEqual(6);
  }, { capacityPolicy: { checkRunPageLimit, checkRunPageSize: 3 } }));

  it('marks a check list beyond the 100-run bound as truncated rather than complete', () => fixture(async f => {
    await start(f); f.oversizedChecks(101);
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { data: { check_runs: unknown[] }; truncated: boolean };
    expect(evidence.truncated).toBe(true);
    expect(evidence.data.check_runs.length).toBeLessThanOrEqual(100);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }, { capacityPolicy: { checkRunPageLimit: 10 } }));
  it('marks overlapping check pages incomplete even when the row count matches', () => fixture(async f => {
    await start(f); f.oversizedChecks(20, 3000, true);
    const response = await f.capability.fetch(read('submission-checks', { resource: 'checks' }));
    expect(response.status).toBe(200);
    const evidence = await response.json() as { truncated: boolean };
    expect(evidence.truncated).toBe(true);
  }));
  it('fences expired leases even when their exact settlement arrives late', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f); f.expire(); f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    await retainedFence(f, 'deadline-expired');
  }));
  it('fences uncertain admission without retrying the generated child', async () => {
    let state = { generation: 1, status: 'running', checkpoint: null, result: null };
    const activity = { beginDrive: async () => ({ ok: true, state }),
      admitDispatcher: async () => { throw new Error('lost admission'); },
      interruptDrive: async () => ({ ok: true, state: state = { ...state, generation: 2, status: 'unknown' } }),
    } as unknown as OperatorActivity;
    expect(await driveDispatcherRuntime({ activity, deadline: Date.now() + 1000,
      bundle, artifactDigest: await digest(bytes), invocation })).toMatchObject({ ok: true, state: { status: 'unknown' } });
  });
  it('resumes the exact persisted lease after reconstruction without re-admission', () => fixture(async f => {
    await start(f); f.settle(); const restarted = f.restart();
    await restarted.reconcileDispatcherLease();
    expect((await restarted.getBrowserDetail())?.executionStatus).toBe('waiting');
  }));
  it('fences before signaling facet abort and rejects late settlement and warmed effects', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    await f.activity.cancelDrive(); expect(f.abortStatus()).toBe('cancel-requested');
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('cancel-requested');
    expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
    await retainedFence(f, 'cancelled', 'fence');
  }));
  it.each(['expire', 'revoke'] as const)('denies %s without new protected effects', action => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    f[action](); expect((await f.capability.fetch(read('read-2'))).status).toBe(403);
    expect(f.sent.map(r => r.url)).toEqual(['https://api.github.com/repos/owner/repo/pulls/17']);
  }));
  it('sends the parent-owned GitHub REST User-Agent for both bounded PR and files reads', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(read('files-read', { resource: 'files' }))).status).toBe(200);
    expect(f.sent.map(request => request.headers.get('user-agent'))).toEqual([
      'Codeflare-Operator-Dispatcher', 'Codeflare-Operator-Dispatcher',
    ]);
    expect(f.sent.every(request => !request.headers.has('authorization'))).toBe(true);
  }));
  it('reconciles completed operation output and conflicts on changed semantics', () => fixture(async f => {
    await start(f); const first = await f.capability.fetch(read());
    expect(await (await f.capability.fetch(read())).text()).toBe(await first.text());
    expect((await f.capability.fetch(read('read-1', { resource: 'files' }))).status).toBe(409);
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it.each([
    { name: 'oversized inference', preparationStep: 'parse', failureClass: 'body-limit',
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT'.repeat(100000) }] } }) },
    { name: 'oversized source', preparationStep: 'parse', failureClass: 'body-limit',
      request: () => genericWire('source', { operationId: 'PRIVATE_OPERATION', method: 'POST',
        url: 'https://api.github.com/repos/another/service/issues/17/comments', body: 'PRIVATE_BODY'.repeat(6000) }) },
    { name: 'invalid JSON', preparationStep: 'parse', failureClass: 'invalid-json',
      request: () => new Request('https://operator.internal/v1/dispatcher/inference', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: '{"PRIVATE_PROMPT":' }) },
    { name: 'forged wire identity', preparationStep: 'parse', failureClass: 'invalid-wire', wireRules: ['envelope-field'],
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', activityId: 'CHILD_ACTIVITY', generation: 909,
        input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } }) },
    { name: 'pinned SDK compaction wire', preparationStep: 'parse', failureClass: 'invalid-wire', wireRules: ['inference-max-completion-tokens'],
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], max_completion_tokens: 16000 } }) },
    { name: 'unsupported method', preparationStep: 'parse', failureClass: 'request-denied',
      request: () => new Request('https://operator.internal/v1/dispatcher/inference', { method: 'GET' }) },
    { name: 'unsupported route', preparationStep: 'parse', failureClass: 'request-denied',
      request: () => genericWire('PRIVATE_ROUTE', { operationId: 'PRIVATE_OPERATION' }) },
    { name: 'missing inference capability', preparationStep: 'capability', failureClass: 'authority-denied', capabilities: ['fetch'],
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } }) },
    { name: 'changed installation', preparationStep: 'capability', failureClass: 'authority-denied', revoked: true,
      request: () => genericWire('inference', { operationId: 'PRIVATE_OPERATION', input: {
        messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } }) },
  ])('REQ-OPERATOR-063: preparation rejection $name preserves denial and private diagnostic wire',
  ({ preparationStep, failureClass, request, capabilities, revoked, wireRules }) => fixture(async f => {
    await start(f);
    if (revoked) f.revoke();
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      const response = await f.capability.fetch(request());
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
      // REQ-OPERATOR-063 intentional security/observability wire: fixed categories,
      // trusted correlation and no child identity, exception, request or credential data.
      const event = emitted.map(value => JSON.parse(value) as { module: string; message: string;
        data?: Record<string, unknown> }).find(value => value.module === 'dispatcher-settlement'
        && value.message === 'Dispatcher operation rejected' && value.data?.stage === 'preparation');
      expect(event?.data).toEqual({ stage: 'preparation', preparationStep, failureClass,
        activityId: f.activityId, generation: 1, resource: 'unparsed', deadline: 'current', status: 403,
        ...(wireRules ? { wireRules, wireRulesTruncated: false } : {}) });
      expect(emitted.join('\n')).not.toMatch(/PRIVATE_|CHILD_ACTIVITY|private\.jwt|inline-secret|owner@example/);
      const detail = await f.activity.getBrowserDetail();
      expect(detail?.executionStatus).toBe('running');
      expect(detail?.result).toBeNull();
      if (!revoked) expect((await f.capability.fetch(genericWire('source', { operationId: 'valid-after-denial',
        url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, capabilities, capacityPolicy: { dispatcherRequestBytes: 65536 } }));
  it.each([
    { name: 'invalid envelope', input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }], actor: 'CHILD_ACTIVITY' } },
    { name: 'message count', input: { messages: [] } },
  ])('REQ-OPERATOR-063: preparation logging outage preserves denial and later authorized work ($name)', ({ input }) => fixture(async f => {
    await start(f);
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => { throw Error('PRIVATE_LOGGING_FAILURE'); });
    try {
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_OPERATION', input }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      expect(f.sent).toEqual([]);
      expect((await f.capability.fetch(genericWire('source', { operationId: 'valid-after-logging-outage',
        url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true }));
  it.each([
    { name: 'missing messages', input: {}, rule: 'inference-messages-shape' },
    { name: 'empty messages', input: { messages: [] }, rule: 'inference-messages-count',
      countObservation: { messages: 0, tools: null, messageMinimum: 1, messageMaximum: 256, messageCountViolation: 'below-minimum' } },
    { name: 'message count', input: { messages: Array.from({ length: 257 }, () => ({ content: 'PRIVATE_PROMPT' })), tools: [{ PRIVATE_TOOL: 'inline-secret' }] }, rule: 'inference-messages-count',
      countObservation: { messages: 257, tools: 1, messageMinimum: 1, messageMaximum: 256, messageCountViolation: 'above-maximum' } },
    { name: 'admitted message bound', capacityPolicy: { inferenceMessageLimit: 2 }, input: { messages: [{}, {}, {}], tools: [] }, rule: 'inference-messages-count',
      countObservation: { messages: 3, tools: 0, messageMinimum: 1, messageMaximum: 2, messageCountViolation: 'above-maximum' } },
    { name: 'unknown tool shape at message refusal', input: { messages: [], tools: 'PRIVATE_TOOL' }, rule: ['inference-messages-count', 'inference-tools-shape'],
      countObservation: { messages: 0, tools: null, messageMinimum: 1, messageMaximum: 256, messageCountViolation: 'below-minimum' } },
    { name: 'message list shape', input: { messages: 'PRIVATE_PROMPT' }, rule: 'inference-messages-shape' },
    { name: 'tool count', input: { messages: [{}], tools: Array.from({ length: 129 }, () => ({})) }, rule: 'inference-tools-count' },
    { name: 'tool list shape', input: { messages: [{}], tools: 'PRIVATE_TOOL' }, rule: 'inference-tools-shape' },
    { name: 'completion token field', input: { messages: [{}], max_completion_tokens: 16000 }, rule: 'inference-max-completion-tokens' },
    { name: 'output token upper bound', input: { messages: [{}], max_tokens: 32769 }, rule: 'inference-token-bound' },
    { name: 'output token lower bound', input: { messages: [{}], max_tokens: 0 }, rule: 'inference-token-bound' },
    { name: 'output token shape', input: { messages: [{}], max_tokens: 1.5 }, rule: 'inference-token-shape' },
    { name: 'temperature bound', input: { messages: [{}], temperature: 3 }, rule: 'inference-temperature' },
    { name: 'stream shape', input: { messages: [{}], stream: 'PRIVATE_STREAM' }, rule: 'inference-stream' },
    { name: 'stream options', input: { messages: [{}], stream_options: { include_usage: false } }, rule: 'inference-stream-options' },
    { name: 'private nested option key', input: { messages: [{}], stream_options: { include_usage: true, PRIVATE_KEY: 'inline-secret' } }, rule: 'inference-stream-options' },
    { name: 'private input key', input: { messages: [{}], PRIVATE_KEY: 'private.jwt' }, rule: 'inference-unsupported-field' },
    { name: 'input shape', input: null, rule: 'inference-input' },
  ])('REQ-OPERATOR-063: identifies $name without exposing rejected data or changing authority', ({ input, rule, countObservation, capacityPolicy }) => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_OPERATION', input }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
      // Intentional diagnostic security contract: bounded fixed rule labels,
      // trusted identity, and the unchanged generic public denial.
      const event = emitted.map(value => JSON.parse(value) as { module: string; data?: Record<string, unknown> })
        .find(value => value.module === 'dispatcher-settlement' && value.data?.stage === 'preparation');
      expect(event?.data).toEqual({ stage: 'preparation', preparationStep: 'parse', failureClass: 'invalid-wire',
        activityId: f.activityId, generation: 1, resource: 'unparsed', deadline: 'current', status: 403,
        wireRules: Array.isArray(rule) ? rule : [rule], wireRulesTruncated: false, ...countObservation });
      expect(emitted.join('\n')).not.toMatch(/PRIVATE_|inline-secret|private\.jwt|owner@example/);
      // Structural counts are intentional observations, not rejected token values.
      // Exclude trusted UUID text when checking that token values remain private.
      expect(JSON.stringify({ ...event!.data, activityId: undefined })).not.toMatch(/32769|16000/);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
      expect((await f.capability.fetch(genericWire('source', { operationId: 'valid-after-rule-denial',
        url: 'https://api.github.com/repos/another/service' }))).status).toBe(200);
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true, capacityPolicy }));
  it('REQ-OPERATOR-063: bounds multiple rejected rules without retaining arbitrary issue paths or values', () => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    const spy = vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
    try {
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_OPERATION'.repeat(20), input: {
        messages: [],
        tools: Array.from({ length: 129 }, () => ({})), max_tokens: 32769, temperature: 3,
        stream: 'PRIVATE_STREAM', stream_options: { include_usage: false }, PRIVATE_KEY: 'inline-secret',
      } }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
      const event = emitted.map(value => JSON.parse(value) as { module: string; data?: Record<string, unknown> })
        .find(value => value.module === 'dispatcher-settlement' && value.data?.stage === 'preparation');
      expect(event?.data).toEqual({ stage: 'preparation', preparationStep: 'parse', failureClass: 'invalid-wire',
        activityId: f.activityId, generation: 1, resource: 'unparsed', deadline: 'current', status: 403,
        wireRules: ['operation-id', 'inference-messages-count', 'inference-tools-count', 'inference-token-bound'], wireRulesTruncated: true,
        messages: 0, tools: 129, messageMinimum: 1, messageMaximum: 256, messageCountViolation: 'below-minimum' });
      expect(emitted.join('\n')).not.toMatch(/PRIVATE_|inline-secret|private\.jwt|32769|ZodError|too_big/);
      expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    } finally { spy.mockRestore(); setLogLevel('silent'); }
  }, { repositoryOnly: true }));
  it.each([
    { name: 'conflict', stage: 'reservation', resource: 'files', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        await f.capability.fetch(read('diagnostic-conflict'));
        return f.capability.fetch(read('diagnostic-conflict', { resource: 'files' }));
      } },
    { name: 'rejected transport uncertain operation', stage: 'effect', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.throwTransport(); return f.capability.fetch(read('diagnostic-uncertain'));
      } },
    { name: 'unreadable completed response', stage: 'effect', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.emptyResponse(); return f.capability.fetch(read('diagnostic-empty'));
      } },
    { name: 'expired authority', stage: 'authority', resource: 'unparsed', deadline: 'expired', status: 403,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.expire(); return f.capability.fetch(read('diagnostic-expired'));
      } },
    { name: 'stale generation with current deadline', stage: 'authority', resource: 'unparsed', deadline: 'current', status: 403,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => f.staleCapability.fetch(read('diagnostic-stale')) },
    { name: 'upstream non-success response', stage: 'upstream', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.loseResponse(); return f.capability.fetch(read('diagnostic-upstream'));
      } },
    { name: 'inference upstream non-success response', stage: 'upstream', resource: 'inference', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.loseResponse(); return f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ operationId: 'diagnostic-inference', input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT_NOT_LOGGED' }] } }),
        }));
      } },
    { name: 'forwarded upstream HTTP 409', stage: 'forwarded-upstream', resource: 'pull-request', deadline: 'current', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.upstreamConflict(true); return f.capability.fetch(read('diagnostic-forwarded'));
      } },
    { name: 'expired result commit', stage: 'commit', resource: 'pull-request', deadline: 'expired', status: 409,
      exercise: async (f: Parameters<Parameters<typeof fixture>[0]>[0]) => {
        f.expireAfterRead(); return f.capability.fetch(read('diagnostic-commit'));
      } },
  ])('REQ-OPERATOR-047/048: emits bounded $name diagnostic with its fenced response', ({ name, stage, resource, deadline, status, exercise }) => fixture(async f => {
    await start(f);
    const emitted: string[] = [];
    setLogLevel('warn');
    try {
      vi.spyOn(console, 'warn').mockImplementation(value => { emitted.push(String(value)); });
      const response = await exercise(f);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(name === 'forwarded upstream HTTP 409'
        ? { error: 'upstream-conflict' } : { code: status === 403 ? 'OPERATOR_CAPABILITY_DENIED'
          : stage === 'reservation' ? 'OPERATOR_OPERATION_CONFLICT' : 'OPERATOR_OPERATION_UNKNOWN',
          reason: status === 403 ? 'execution-inactive' : stage === 'reservation' ? 'operation-conflict' : 'operation-failed',
          disposition: status === 403 ? 'authority-denied' : 'operation-local' });
      const events = emitted.map(value => JSON.parse(value) as { module: string; message: string;
        data?: Record<string, unknown> }).filter(event => event.module === 'dispatcher-settlement'
        && event.message === 'Dispatcher operation rejected');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ data: { stage, resource, deadline, status } });
      expect(Object.keys(events[0].data ?? {}).sort()).toEqual(stage === 'upstream'
        ? ['deadline', 'resource', 'stage', 'status', 'upstreamStatus'] : ['deadline', 'resource', 'stage', 'status']);
      if (stage === 'upstream') expect(events[0].data?.upstreamStatus).toBe(502);
      expect(JSON.stringify(events)).not.toMatch(/private transport failure|lost response|diagnostic-conflict|diagnostic-uncertain|diagnostic-empty|diagnostic-expired|diagnostic-stale|diagnostic-upstream|diagnostic-forwarded|diagnostic-commit|diagnostic-inference|PRIVATE_PROMPT_NOT_LOGGED|private\.jwt|inline-secret/);
      if (name === 'forwarded upstream HTTP 409') {
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
        f.upstreamConflict(false);
        const replay = await f.capability.fetch(read('diagnostic-forwarded'));
        expect(replay.status).toBe(409);
        expect(await replay.json()).toEqual({ error: 'upstream-conflict' });
        expect(emitted.filter(value => value.includes('Dispatcher operation rejected'))).toHaveLength(1);
        expect((await f.capability.fetch(read('diagnostic-fresh'))).status).toBe(200);
      } else if (stage === 'effect' || stage === 'upstream' || stage === 'commit') {
        expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
        expect((await f.capability.fetch(read('diagnostic-followup'))).status).toBe(403);
      } else if (stage === 'reservation' || deadline === 'current') {
        expect((await f.capability.fetch(read('diagnostic-fresh'))).status).toBe(200);
      } else {
        expect(f.sent.some(request => request.url.startsWith('https://api.github.com/'))).toBe(false);
      }
    } finally { setLogLevel('silent'); }
  }));
  it('does not replay uncertain effects and cannot commit waiting afterward', () => fixture(async f => {
    await start(f); f.loseResponse(); expect((await f.capability.fetch(read())).status).toBe(409);
    expect((await f.capability.fetch(read())).status).toBe(403);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('unknown');
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it.each([
    { tools: 2, maxTokens: 10, status: 200 },
    { tools: 3, maxTokens: 10, status: 403 },
    { tools: 2, maxTokens: 11, status: 403 },
  ])('REQ-OPERATOR-047: admitted tool/token capacities bound complete inference %j', ({ tools, maxTokens, status }) => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(genericWire('inference', { operationId: 'tool-token-bound', input: {
      messages: [{ role: 'user', content: 'Synthetic request' }], max_tokens: maxTokens,
      tools: Array.from({ length: tools }, (_, index) => ({ type: 'function', function: { name: `tool_${index}`, parameters: { type: 'object' } } })),
    } }));
    expect(response.status).toBe(status);
    if (status === 200) expect(await response.text()).toBe('data: [DONE]\n\n');
    else expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
  }, { repositoryOnly: true, capacityPolicy: { inferenceToolLimit: 2, inferenceTokenLimit: 10, inferenceDefaultTokens: 5 } }));

  it('REQ-OPERATOR-047: admitted default completion tokens are forwarded only when omitted', async () => {
    for (const maxTokens of [undefined, 9]) await fixture(async f => {
      await start(f);
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'default-token-bound', input: {
        messages: [{ role: 'user', content: 'Synthetic request' }], ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      } }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(`data: ${JSON.stringify({ choices: [{ delta: { content: String(maxTokens ?? 5) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    }, { repositoryOnly: true, capacityPolicy: { inferenceTokenLimit: 10, inferenceDefaultTokens: 5 }, inferenceTransport: async request => {
      const value = await request.json() as { max_tokens: number };
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: String(value.max_tokens) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
  });

  it('REQ-OPERATOR-047: configured non-inference UTF-8 envelope and text bounds retain complete wire values', async () => {
    const body = { operationId: 'source-bound', url: 'https://docs.example.test/guide', method: 'POST', body: '🙂' };
    const requestBytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    const allowed = { dispatcherRequestBytes: requestBytes, sourceRequestChars: 2, sourceUrlChars: body.url.length };
    const wire = () => genericWire('source', body);
    expect((await parseDispatcherOperation(wire(), undefined, allowed)).body).toEqual(body);
    for (const denied of [{ ...allowed, dispatcherRequestBytes: requestBytes - 1 },
      { ...allowed, sourceRequestChars: 1 }, { ...allowed, sourceUrlChars: body.url.length - 1 }]) {
      await expect(parseDispatcherOperation(wire(), undefined, denied)).rejects.toThrow();
    }
    const unicodeUrl = { ...body, url: 'https://docs.example.test/🙂' };
    expect((await parseDispatcherOperation(genericWire('source', unicodeUrl), undefined,
      { sourceUrlChars: unicodeUrl.url.length })).body).toEqual(unicodeUrl);
    await expect(parseDispatcherOperation(genericWire('source', unicodeUrl), undefined,
      { sourceUrlChars: unicodeUrl.url.length - 1 })).rejects.toThrow();
    const comment = { operationId: 'comment-bound', target: { pullRequest: 17, headSha: 'b'.repeat(40) }, decision: 'DO_NOT_MERGE', comment: '🙂' };
    expect((await parseDispatcherOperation(genericWire('github/comment', comment), undefined, { commentChars: 2 })).body).toEqual(comment);
    await expect(parseDispatcherOperation(genericWire('github/comment', comment), undefined, { commentChars: 1 })).rejects.toThrow();
    const resolution = { operationId: 'unknown-write', requestDigest: 'a'.repeat(64), readbacks: [
      { operationId: 'read-1', requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64) },
      { operationId: 'read-2', requestDigest: 'd'.repeat(64), responseDigest: 'e'.repeat(64) },
    ] };
    expect((await parseDispatcherOperation(genericWire('resolve', resolution), undefined, { resolutionReadbackLimit: 2 })).body).toEqual(resolution);
    await expect(parseDispatcherOperation(genericWire('resolve', resolution), undefined, { resolutionReadbackLimit: 1 })).rejects.toThrow();
  });

  it.each([
    { recovery: false, messageCount: 139, inferenceMessageLimit: undefined },
    { recovery: true, messageCount: 139, inferenceMessageLimit: undefined },
    { recovery: false, messageCount: 300, inferenceMessageLimit: 300 },
    { recovery: true, messageCount: 300, inferenceMessageLimit: 300 },
  ])('REQ-OPERATOR-047: admitted history preserves complete forwarding and cached bytes %j', async ({ recovery, messageCount, inferenceMessageLimit }) => {
    const input = { messages: Array.from({ length: messageCount }, (_, index) => ({ role: 'user', content: `Synthetic history ${index} 🙂` })),
      tools: Array.from({ length: 8 }, (_, index) => ({ type: 'function', function: { name: `source_${index}`,
        parameters: { type: 'object', properties: {} } } })) };
    const completion = (history: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0,
      delta: { content: JSON.stringify(history) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    const complete = completion(input);
    let providerAvailable = true;
    await fixture(async f => {
      await start(f);
      const operation = { operationId: 'complete-history', input };
      const first = await f.capability.fetch(genericWire('inference', operation));
      expect(first.status).toBe(200);
      // Complete forwarded history and exact SSE/cache bytes are the intentional wire contract.
      expect(await first.text()).toBe(complete);
      providerAvailable = false;
      f.restart();
      const cached = await f.capability.fetch(genericWire('inference', operation));
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(complete);
      f.revoke();
      const denied = await f.capability.fetch(genericWire('inference', operation));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    }, { repositoryOnly: true, recovery, inferenceMessageLimit, inferenceTransport: async request => {
      if (!providerAvailable) return Response.json({ error: 'provider unavailable' }, { status: 503 });
      const forwarded = await request.json() as { messages: unknown[]; tools: unknown[] };
      return new Response(completion({ messages: forwarded.messages, tools: forwarded.tools }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    } });
  });

  it.each([
    { inferenceMessageLimit: undefined, messageCount: 256, status: 200 },
    { inferenceMessageLimit: undefined, messageCount: 257, status: 403 },
    { inferenceMessageLimit: 1, messageCount: 1, status: 200 },
    { inferenceMessageLimit: 1, messageCount: 2, status: 403 },
    { inferenceMessageLimit: 128, messageCount: 139, status: 403 },
    { inferenceMessageLimit: 139, messageCount: 139, status: 200 },
    { inferenceMessageLimit: 139, messageCount: 140, status: 403 },
    { inferenceMessageLimit: 300, messageCount: 301, status: 403 },
  ])('REQ-OPERATOR-045/047: admitted message limit $inferenceMessageLimit bounds $messageCount-message requests',
    ({ inferenceMessageLimit, messageCount, status }) => fixture(async f => {
      await start(f);
      const response = await f.capability.fetch(genericWire('inference', { operationId: 'message-bound', input: {
        messages: Array.from({ length: messageCount }, (_, index) => ({ role: 'user', content: `History ${index}` })),
      } }));
      expect(response.status).toBe(status);
      if (status === 200) expect(await response.text()).toBe('data: [DONE]\n\n');
      else expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    }, { repositoryOnly: true, inferenceMessageLimit }));

  it.each(['envelope', 'input'])('REQ-OPERATOR-047: child %s cannot override the admitted inference message limit', placement => fixture(async f => {
    await start(f);
    const input = { messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
      ...(placement === 'input' ? { inferenceMessageLimit: 256 } : {}) };
    const response = await f.capability.fetch(genericWire('inference', { operationId: 'child-message-limit', input,
      ...(placement === 'envelope' ? { inferenceMessageLimit: 256 } : {}) }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
  }, { repositoryOnly: true, inferenceMessageLimit: 1 }));

  it('REQ-OPERATOR-047: 139-message history remains bounded by the exact admitted UTF-8 request allowance', async () => {
    const operation = { operationId: 'history-byte-bound', input: {
      messages: Array.from({ length: 139 }, (_, index) => ({ role: 'user', content: `History ${index} 🙂` })),
    } };
    const bytes = new TextEncoder().encode(JSON.stringify(operation)).byteLength;
    const inferenceBody = 'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    for (const limit of [bytes - 1, bytes]) await fixture(async f => {
      await start(f);
      const response = await f.capability.fetch(genericWire('inference', operation));
      expect(response.status).toBe(limit === bytes ? 200 : 403);
      if (limit === bytes) expect(await response.text()).toBe(inferenceBody);
      else expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    }, { repositoryOnly: true, recovery: true, inferenceRequestBytes: limit, inferenceBody });
  });

  it.each([65537, 1048576])('REQ-OPERATOR-047: admitted operator inference bytes forward %i-byte content without child authority', contentBytes => withCollectedLargeLogs(contentBytes === 1048576, output => fixture(async f => {
    await start(f);
    const content = 'x'.repeat(contentBytes);
    const response = await f.capability.fetch(genericWire('inference', {
      operationId: 'configured-inference', input: { messages: [{ role: 'user', content }] },
    }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(f.sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(f.sent[0].headers.has('authorization')).toBe(false);
    expect(await f.sent[0].json()).toMatchObject({ messages: [{ role: 'user', content }] });
    f.revoke();
    expect((await f.capability.fetch(genericWire('inference', {
      operationId: 'revoked-large-inference', input: { messages: [{ role: 'user', content }] },
    }))).status).toBe(403);
    if (contentBytes === 1048576) expect(collectedRawValues(output, 'operation-prepared')).toContainEqual(expect.objectContaining({
      body: { operationId: 'configured-inference', input: { messages: [{ role: 'user', content }] } },
    }));
  }, { inferenceRequestBytes: Number.MAX_SAFE_INTEGER })));

  it('REQ-OPERATOR-047: absent inference limit accepts an exact 1 MiB request and rejects one extra byte', () => withCollectedLargeLogs(true, output => fixture(async f => {
    await start(f);
    const operationId = 'default-inference-bytes';
    const empty = { operationId, input: { messages: [{ role: 'user', content: '' }] } };
    const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
    const content = 'x'.repeat(1048576 - overhead);
    expect((await f.capability.fetch(genericWire('inference', { operationId,
      input: { messages: [{ role: 'user', content }] } }))).status).toBe(200);
    expect((await f.capability.fetch(genericWire('inference', { operationId,
      input: { messages: [{ role: 'user', content: content + 'x' }] } }))).status).toBe(403);
    expect(collectedRawValues(output, 'operation-prepared')).toContainEqual(expect.objectContaining({
      body: { operationId, input: { messages: [{ role: 'user', content }] } },
    }));
  })));

  it('REQ-OPERATOR-047: operator inference bytes enforce exact UTF-8 request boundaries', async () => {
    const body = { operationId: 'exact-inference', input: { messages: [{ role: 'user', content: '🙂'.repeat(30) }] } };
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    for (const limit of [bytes - 1, bytes]) await fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(genericWire('inference', body))).status).toBe(limit === bytes ? 200 : 403);
    }, { inferenceRequestBytes: limit });
  });

  it('REQ-OPERATOR-047: source response configuration and child fields cannot raise inference request bytes', async () => {
    await fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(genericWire('inference', { operationId: 'default-limit',
        input: { messages: [{ role: 'user', content: 'x'.repeat(65537) }] } }))).status).toBe(403);
      expect((await f.capability.fetch(genericWire('inference', { operationId: 'child-limit',
        inferenceRequestBytes: Number.MAX_SAFE_INTEGER, input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(403);
      expect((await f.capability.fetch(genericWire('inference', { operationId: 'valid-default',
        input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(200);
    }, { sourceResponseBytes: 131072, inferenceRequestBytes: 65536 });
    await fixture(async f => {
      await start(f);
      expect((await f.capability.fetch(read('source-unchanged', { padding: 'x'.repeat(65537) }))).status).toBe(403);
    }, { inferenceRequestBytes: Number.MAX_SAFE_INTEGER });
  });

  it.each([undefined, 5120, 8192])('REQ-OPERATOR-047: routes bounded ordinary or canonical summary budget %s without forwarding child authority', budget => fixture(async f => {
    await start(f);
    const messages = budget === undefined ? [{ role: 'user', content: 'assess' }]
      : [{ role: 'system', content: 'Summarize the supplied research.' }, { role: 'user', content: 'Synthetic research context.' }];
    const response = await f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', {
      method: 'POST', headers: { authorization: 'child-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: 'inference-1', input: { messages,
        ...(budget === undefined ? {} : { max_tokens: budget }) } }),
    }));
    expect(response.status).toBe(200); expect(await response.text()).toBe('data: [DONE]\n\n');
    expect(f.sent[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(f.sent[0].headers.has('authorization')).toBe(false);
    // Parent output-limit/default injection and canonical forwarding are wire contracts.
    const forwarded = await f.sent[0].json();
    expect(forwarded).toMatchObject({ messages, max_tokens: budget ?? 8192 });
    expect(forwarded).not.toHaveProperty('max_completion_tokens');
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    f.revoke();
    expect((await f.capability.fetch(genericWire('inference', { operationId: 'revoked-summary',
      input: { messages, max_tokens: 5120 } }))).status).toBe(403);
  }));
  it('denies foreign resources, unknown routes, oversized input and foreign/root scheduling while allowed reads work', () => fixture(async f => {
    await start(f); expect((await f.capability.fetch(read())).status).toBe(200);
    for (const request of [read('x', { repository: 'other/repo' }), read('x', { resource: 'merge' }),
      read('x', { padding: 'x'.repeat(65537) }), new Request('https://operator.internal/v1/session'),
      new Request('https://example.test/v1/dispatcher/github/read', { method: 'POST', body: '{}' })]) {
      expect((await f.capability.fetch(request)).status).toBe(403);
    }
    await expect(f.capability._cf_scheduleForFacet([{ className: 'OperatorActivity', name: 'foreign' }],
      1, 'cancelDrive')).rejects.toThrow();
    expect(f.sent.map(r => r.method)).toEqual(['GET']);
  }));
  it('delegates only the pinned child wake callback and scopes cancellation to that facet', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const created = await f.capability._cf_scheduleForFacet(path, 1, '__flueWakeAgentSubmissions');
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toMatchObject({ type: 'delayed' });
    await expect(f.capability._cf_scheduleForFacet(path, 1, 'cancelDrive')).rejects.toThrow();
    await expect(f.capability._cf_getScheduleForFacet([path[0], { ...path[1], name: 'foreign' }], created.schedule.id))
      .rejects.toThrow();
    const before = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(before).toMatchObject({ parent: { driveGeneration: 1, lease: { generation: 1, status: 'running' } } });
    const rootSchedule = await f.activity.scheduler.get(created.schedule.id);
    expect(rootSchedule).toBeDefined();
    // Exercise the supported host alarm callback with its original stored
    // generation envelope, never a raw row rebound to the latest lease.
    const wake = () => f.activity.dispatchDispatcherSchedule(rootSchedule!.payload, rootSchedule!);
    const checkFibers = () => f.activity._cf_checkRunFibersForFacet(path);
    // REQ-OPERATOR-048 AC2/3: native invalidation is external to production's
    // explicit abort path. Preserve the failed call, not a hidden inline resend.
    const wakeError = new Error('Controlled Dispatcher wake connection failure');
    f.interruptOwnedChild(wakeError);
    await expect(wake()).rejects.toBe(wakeError);
    const constructionError = new Error('Controlled Dispatcher preparation failure');
    f.afterBundleRead(async () => { throw constructionError; });
    await expect(wake()).rejects.toBe(constructionError);
    await expect(wake()).resolves.toBeUndefined();
    const fiberError = new Error('Controlled Dispatcher fiber connection failure');
    f.interruptOwnedChild(fiberError);
    await expect(checkFibers()).rejects.toBe(fiberError);
    await expect(checkFibers()).resolves.toBe(0);
    expect((await f.activity.getDispatcherDiagnostics(f.proof.ownerKey))?.parent.lease).toEqual(before!.parent.lease);
    expect(await f.capability._cf_cancelScheduleForFacet(path, created.schedule.id)).toMatchObject({ ok: true });
    expect(await f.capability._cf_getScheduleForFacet(path, created.schedule.id)).toBeUndefined();
    const retirementError = new Error('Controlled Dispatcher connection loss before cancellation');
    f.interruptOwnedChild(retirementError);
    await expect(wake()).rejects.toBe(retirementError);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    f.afterBundleRead(async () => { enter(); await held; });
    const preparation = wake();
    try {
      await entered;
      await f.activity.cancelDrive();
    } finally { release(); }
    // REQ-OPERATOR-017 AC4: cleanup and a previously authorized construction
    // must not instantiate a replacement after cancellation, including legacy.
    await expect(preparation).rejects.toBeInstanceOf(Error);
    await expect(wake()).resolves.toBeUndefined();
    await expect(checkFibers()).resolves.toBe(0);
    for (const readback of f.ownedChildReadbacks()) await expect(readback()).rejects.toBeInstanceOf(Error);
    expect((await f.capability.fetch(read('retired-after-connection-recovery'))).status).toBe(403);
  }, { facetContract: true }));
  // Historical storage contract: these rows predate host generation envelopes.
  // Seed authentic column shapes, then observe migration through the public bridge.
  function seedLegacySchedule(storage: DurableObjectStorage, path: Array<{ className: string; name: string }>,
    kind: 'delayed' | 'scheduled' | 'interval', due: number) {
    // A genuine Agents0.20.1 snapshot has no version marker from the already-started 0.28 fixture.
    storage.kv.delete('cf_agents:schedules_schema_version');
    storage.sql.exec(`CREATE TABLE cf_agents_schedules (id TEXT PRIMARY KEY, callback TEXT NOT NULL,
      payload TEXT, type TEXT NOT NULL, time INTEGER NOT NULL, delayInSeconds INTEGER, cron TEXT,
      intervalSeconds INTEGER, running INTEGER DEFAULT 0, execution_started_at INTEGER,
      retry_options TEXT, owner_path TEXT, owner_path_key TEXT, created_at INTEGER)`);
    storage.sql.exec(`INSERT INTO cf_agents_schedules (id, callback, payload, type, time,
      delayInSeconds, intervalSeconds, retry_options, owner_path, owner_path_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'legacy-wake', '__flueWakeAgentSubmissions', null,
    kind, due, kind === 'delayed' ? 10 : null, kind === 'interval' ? 10 : null,
    JSON.stringify({ maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 }), JSON.stringify(path),
    path.map(step => `${encodeURIComponent(step.className)}:${encodeURIComponent(step.name)}`).join('/'), Math.floor(Date.now() / 1000));
  }

  it.each(['delayed', 'scheduled', 'interval'] as const)('REQ-OPERATOR-048 AC2/AC7: preserves original generation-one %s rows and IDs across SDK storage migration', kind => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const due = Math.floor(Date.now() / 1000) + 10;
    await f.mutateEvidence(async storage => { seedLegacySchedule(storage, path, kind, due); });
    const restored = f.restart();
    expect(await restored.dispatcherBridge(1, '_cf_getScheduleForFacet', [path, 'legacy-wake']))
      .toMatchObject({ id: 'legacy-wake', type: kind, time: due, callback: '__flueWakeAgentSubmissions', payload: null,
        retry: { maxAttempts: 2, baseDelayMs: 10, maxDelayMs: 20 } });
    expect(await restored.dispatcherBridge(1, '_cf_cancelScheduleForFacet', [path, 'legacy-wake']))
      .toEqual({ ok: true, callback: '__flueWakeAgentSubmissions' });
    expect(await restored.dispatcherBridge(1, '_cf_getScheduleForFacet', [path, 'legacy-wake'])).toBeUndefined();
  }));

  it('REQ-OPERATOR-048 AC2/AC7: ambiguous predecessor ownership preserves every legacy row and fails before startup', () => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    let before: unknown;
    await f.mutateEvidence(async storage => {
      seedLegacySchedule(storage, path, 'delayed', Math.floor(Date.now() / 1000) + 10);
      const admission = await storage.get<{ drive: Record<string, unknown> }>('admission');
      const lease = await storage.get<Record<string, unknown>>('dispatcher:lease');
      if (!admission || !lease) throw new Error('Fixture original binding missing');
      await storage.put('admission', { ...admission, drive: { ...admission.drive, generation: 2 } });
      await storage.put('dispatcher:lease', { ...lease, generation: 2 });
      before = storage.sql.exec('SELECT * FROM cf_agents_schedules ORDER BY id').toArray();
    });
    expect(() => f.restart()).toThrow(/legacy.*generation|ownership/i);
    await f.mutateEvidence(async storage => {
      expect(storage.sql.exec('SELECT * FROM cf_agents_schedules ORDER BY id').toArray()).toEqual(before);
    });
  }));

  it('REQ-OPERATOR-048 AC7: invalid mixed migration rows leave the complete legacy storage byte contract intact', () => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    let before: unknown;
    await f.mutateEvidence(async storage => {
      seedLegacySchedule(storage, path, 'delayed', Math.floor(Date.now() / 1000) + 10);
      storage.sql.exec(`INSERT INTO cf_agents_schedules (id, callback, payload, type, time, owner_path, owner_path_key)
        VALUES ('root-invalid', 'reconcileDispatcherLease', '{invalid-json', 'delayed', 1, NULL, NULL)`);
      before = storage.sql.exec('SELECT * FROM cf_agents_schedules ORDER BY id').toArray();
    });
    expect(() => f.restart()).toThrow(/legacy.*schedule|migration/i);
    await f.mutateEvidence(async storage => {
      expect(storage.sql.exec('SELECT * FROM cf_agents_schedules ORDER BY id').toArray()).toEqual(before);
    });
  }));

  it('REQ-OPERATOR-047/048: preserves the old dated, delayed and interval scheduling wire and deduplication', () => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const first = await f.capability._cf_scheduleForFacet(path, 4, '__flueWakeAgentSubmissions', undefined, { idempotent: true });
    expect(first).toMatchObject({ created: true, schedule: { type: 'delayed', delayInSeconds: 4, callback: '__flueWakeAgentSubmissions', payload: undefined } });
    const repeated = await f.capability._cf_scheduleForFacet(path, 20, '__flueWakeAgentSubmissions', undefined, { idempotent: true });
    expect(repeated).toMatchObject({ created: false, schedule: { id: first.schedule.id, time: first.schedule.time, payload: null } });
    const due = new Date(Date.now() + 15_000);
    const dated = await f.capability._cf_scheduleForFacet(path, due, '__flueWakeAgentSubmissions');
    expect(dated).toMatchObject({ created: true, schedule: { type: 'scheduled', time: Math.floor(due.getTime() / 1000) } });
    const interval = await f.capability._cf_scheduleEveryForFacet(path, 10, '__flueWakeAgentSubmissions');
    expect(interval).toMatchObject({ created: true, schedule: { type: 'interval', intervalSeconds: 10 } });
    // The old interval protocol uses _idempotent, not the one-shot spelling.
    expect(await f.activity.dispatcherBridge(1, '_cf_scheduleEveryForFacet', [path, 10, '__flueWakeAgentSubmissions', undefined, { idempotent: false }]))
      .toMatchObject({ created: false, schedule: { id: interval.schedule.id } });
    const distinct = await f.capability._cf_scheduleEveryForFacet(path, 10, '__flueWakeAgentSubmissions', undefined, { _idempotent: false });
    expect(distinct.created).toBe(true);
    expect(distinct.schedule.id).not.toBe(interval.schedule.id);
    expect(await f.capability._cf_listSchedulesForFacet(path, { type: 'interval' })).toHaveLength(2);
    expect(await f.capability._cf_listSchedulesForFacet(path, { id: dated.schedule.id })).toMatchObject([{ id: dated.schedule.id }]);
    expect(await f.capability._cf_cancelScheduleForFacet(path, first.schedule.id)).toEqual({ ok: true, callback: '__flueWakeAgentSubmissions' });
    expect(await f.capability._cf_cancelScheduleForFacet(path, first.schedule.id)).toEqual({ ok: false });
    expect(await f.capability._cf_getScheduleForFacet(path, first.schedule.id)).toBeUndefined();
  }));

  it('REQ-OPERATOR-047/048: child schedule reads and cancellations cannot expose root reconciliation jobs', () => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const root = await f.activity.scheduler.set(15, 'reconcileDispatcherLease', { generation: 1 });
    const child = await f.capability._cf_scheduleForFacet(path, 15, '__flueWakeAgentSubmissions');
    expect(await f.capability._cf_getScheduleForFacet(path, root.id)).toBeUndefined();
    expect(await f.capability._cf_cancelScheduleForFacet(path, root.id)).toEqual({ ok: false });
    const listed = await f.capability._cf_listSchedulesForFacet(path);
    expect(listed.map(schedule => schedule.id)).toEqual([child.schedule.id]);
    expect(listed[0]).toMatchObject({ callback: '__flueWakeAgentSubmissions', payload: null });
    expect(await f.activity.scheduler.get(root.id)).toMatchObject({ id: root.id });
    await f.activity.cancelDrive();
    expect(await f.activity.scheduler.get(child.schedule.id)).toBeUndefined();
    expect(await f.activity.scheduler.get(root.id)).toMatchObject({ id: root.id });
  }));

  it('REQ-OPERATOR-047/048: concurrent child creation cannot cross the 128-schedule boundary', () => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const outcomes = await Promise.allSettled(Array.from({ length: 130 }, () =>
      f.capability._cf_scheduleForFacet(path, 30, '__flueWakeAgentSubmissions')));
    const accepted = outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? [outcome.value] : []);
    expect(accepted).toHaveLength(128);
    expect(new Set(accepted.map(outcome => outcome.schedule.id)).size).toBe(128);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(2);
    expect(await f.capability._cf_listSchedulesForFacet(path)).toHaveLength(128);
  }));

  it('REQ-OPERATOR-047/048: concurrent idempotent intervals create only one child schedule', () => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      f.capability._cf_scheduleEveryForFacet(path, 15, '__flueWakeAgentSubmissions')));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(new Set(results.map(result => result.schedule.id)).size).toBe(1);
    expect(await f.capability._cf_listSchedulesForFacet(path)).toHaveLength(1);
  }));

  it('REQ-OPERATOR-047/048: invalid scheduling inputs and stale generation create no work', () => fixture(async f => {
    await start(f);
    const path = [{ className: 'OperatorActivity', name: f.activityId }, { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    for (const delay of [-1, 31, Number.NaN, Infinity]) {
      await expect(f.capability._cf_scheduleForFacet(path, delay, '__flueWakeAgentSubmissions')).rejects.toThrow();
    }
    await expect(f.capability._cf_scheduleEveryForFacet(path, 0, '__flueWakeAgentSubmissions')).rejects.toThrow();
    await expect(f.capability._cf_scheduleForFacet(path, 1, '__flueWakeAgentSubmissions', { unauthorized: true })).rejects.toThrow();
    await expect(f.activity.dispatcherBridge(1, '_cf_scheduleForFacet', [path, 1, '__flueWakeAgentSubmissions', undefined, { retry: { maxAttempts: 99 } }])).rejects.toThrow();
    await expect(f.activity.dispatcherBridge(1, '_cf_listSchedulesForFacet', [path, { arbitrary: true }])).rejects.toThrow();
    await expect(f.activity.dispatcherBridge(1, '_cf_getScheduleForFacet', [path, 'bad/id'])).rejects.toThrow();
    expect(await f.capability._cf_listSchedulesForFacet(path)).toEqual([]);
    await f.activity.cancelDrive();
    await expect(f.capability._cf_scheduleForFacet(path, 1, '__flueWakeAgentSubmissions')).rejects.toThrow();
  }));

  it('admits only the activity-bound, connection-free child notifications without widening authority', () => fixture(async f => {
    await start(f);
    const plan = await f.activity.getRuntimePlan();
    const path = [{ className: 'OperatorActivity', name: plan!.activityId },
      { className: 'FlueDispatcherAgent', name: 'dispatcher' }];
    const bridge = f.capability as unknown as {
      _cf_subAgentConnectionMetas(ownerPath: typeof path): Promise<unknown>;
      _cf_broadcastToSubAgent(ownerPath: typeof path, message: unknown, without?: string[]): Promise<void>;
    };
    expect(await bridge._cf_subAgentConnectionMetas(path)).toEqual([]);
    await expect(bridge._cf_broadcastToSubAgent(path, { type: 'notice' })).resolves.toBeUndefined();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    const foreign = [{ ...path[0], name: 'other-activity' }, path[1]];
    await expect(bridge._cf_subAgentConnectionMetas(foreign)).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(foreign, { type: 'notice' })).rejects.toThrow();
    await expect(bridge._cf_broadcastToSubAgent(path, 'x'.repeat(64 * 1024 + 1))).rejects.toThrow();
  }));
  it('orchestrates managed Dispatcher bundles without the default entrypoint path', () => fixture(async f => {
    const plan = await f.activity.getRuntimePlan();
    await runOperatorActivity(plan!.activityId, f.environment, () => { throw new Error('default capability must not be selected'); });
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
  }));
});
describe('REQ-OPERATOR-047: package-selected research under managed parent authority', () => {
  it('reads an independently selected GitHub repository with the original owner, without a Dozzle allowlist', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(sourceRead('source-gh', 'https://api.github.com/repos/community/compiler/releases/tags/v3.2.1'));
    expect(response.status).toBe(200);
    const receipt = await response.json() as { status: number; body: string };
    expect(receipt.status).toBe(200);
    expect(JSON.parse(receipt.body)).toEqual({ tag_name: 'v3.2.1', guidance: 'Owned authenticated research' });
  }, { repositoryOnly: true }));
  it.each([25, 1000])('REQ-OPERATOR-047: configured source timeout %i refuses late bodies without claiming complete evidence', sourceTimeoutMs => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(genericWire('source', { operationId: 'source-time-bound', url: 'https://docs.example.test/guide' }));
    expect(response.status).toBe(sourceTimeoutMs === 25 ? 422 : 200);
    if (response.ok) expect(await response.json()).toMatchObject({ body: 'Official migration guidance' });
    else expect(await response.json()).toEqual({ code: 'OPERATOR_SOURCE_INCOMPLETE' });
    expect((await f.activity.getBrowserDetail())?.result).toBeNull();
  }, { repositoryOnly: true, sourceDelayMs: 100, capacityPolicy: { sourceTimeoutMs } }));

  it('returns bounded Internet content and provenance without upstream session cookies', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(sourceRead('source-web', 'https://docs.example.test/migration'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: 'https://docs.example.test/migration', status: 200,
      headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'Official migration guidance' });
  }, { repositoryOnly: true }));
  it('serves standard fetch through the same generation-bound capability without passing session cookies', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(new Request('https://docs.example.test/migration', {
      headers: { 'x-codeflare-operator-operation-id': 'standard-fetch' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('guide-v3');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('Official migration guidance');
  }, { repositoryOnly: true }));
  it('denies direct outbound without stable operation identity or with caller credentials', () => fixture(async f => {
    await start(f);
    const deniedHeaders: HeadersInit[] = [{}, { 'x-codeflare-operator-operation-id': 'forged', authorization: 'foreign' }];
    for (const headers of deniedHeaders) {
      const response = await f.capability.fetch(new Request('https://docs.example.test/migration', { headers }));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    }
  }, { repositoryOnly: true }));
  it('denies identity, credential and write substitution while allowing the legitimate source read', () => fixture(async f => {
    await start(f);
    for (const extra of [{ user: 'foreign@example.test' }, { headers: { authorization: 'foreign' } }, { method: 'POST' }]) {
      expect((await f.capability.fetch(sourceRead('forged', 'https://docs.example.test/migration', extra))).status).toBe(403);
    }
    expect((await f.capability.fetch(sourceRead('valid', 'https://docs.example.test/migration'))).status).toBe(200);
  }, { repositoryOnly: true }));
  it('collects only after the documented updates pages reach the durable head', () => fixture(async f => {
    await start(f);
    const output = { repository: 'another/service', results: [] };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-result', data: output }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result: output });
  }, { repositoryOnly: true, pagedStatus: true }));
  it('collects compact output through the real Activity from a large SDK reset', () => fixture(async f => {
    await start(f);
    const output = { repository: 'another/service', results: [] };
    f.messages([{ id: 'irrelevant', submissionId: 'foreign', parts: [{ type: 'text', text: 'x'.repeat(2 * 1024 * 1024) }] },
      { submissionId: 'submission-1', parts: [{ type: 'text', text: 'y'.repeat(2 * 1024 * 1024) }, { type: 'data-result', data: output }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result: output });
  }, { repositoryOnly: true }));
  it('reconciles concurrent identical reads without losing the generation or changing the stored receipt', () => fixture(async f => {
    await start(f);
    const replies = await Promise.all([1, 2].map(() => f.capability.fetch(sourceRead('same-read', 'https://docs.example.test/migration'))));
    expect(replies.map(response => response.status)).toEqual([200, 200]);
    const receipts = await Promise.all(replies.map(response => response.json()));
    expect(receipts[0]).toEqual(receipts[1]);
    const cached = await f.capability.fetch(sourceRead('same-read', 'https://docs.example.test/migration'));
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(receipts[0]);
  }, { repositoryOnly: true }));
  it('denies a missing registered fetch capability', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(sourceRead('denied', 'https://docs.example.test/migration'))).status).toBe(403);
  }, { repositoryOnly: true, capabilities: ['inference'] }));
  it('denies research after the original caller session is revoked', () => fixture(async f => {
    await start(f);
    f.revokeSession();
    expect((await f.capability.fetch(sourceRead('revoked', 'https://docs.example.test/migration'))).status).toBe(403);
  }, { repositoryOnly: true }));
  it('keeps the legacy single-PR package confined to its original interface', () => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(sourceRead('legacy', 'https://docs.example.test/migration'))).status).toBe(403);
  }));
});


describe('REQ-OPERATOR-047/048: parent-composed source response allowance', () => {
  it.each([undefined, 131072])('REQ-OPERATOR-047: exposes source allowance %s only to repository Loader', async sourceResponseBytes => {
    for (const repositoryOnly of [false, true]) await fixture(async f => {
      await start(f);
      expect((await f.loaderEnv()).OPERATOR_SOURCE_RESPONSE_BYTES)
        .toBe(repositoryOnly ? String(sourceResponseBytes ?? 1048576) : undefined);
    }, { repositoryOnly, sourceResponseBytes });
  });

  it.each([undefined, 65536, 131072])('REQ-OPERATOR-047: enforces source allowance %s through Activity and immutable cache', sourceResponseBytes => fixture(async f => {
    await start(f);
    const request = () => sourceRead('large-source', 'https://docs.example.test/migration');
    const response = await f.capability.fetch(request());
    expect(response.status).toBe(sourceResponseBytes === 65536 ? 422 : 200);
    const body = await response.json();
    expect(body).toEqual(sourceResponseBytes === 65536 ? { code: 'OPERATOR_SOURCE_INCOMPLETE' } : {
      url: 'https://docs.example.test/migration', status: 200,
      headers: { 'content-type': 'text/plain', etag: 'guide-v3' }, body: 'x'.repeat(100 * 1024),
    });
    f.sourceBody('Changed upstream content must not replace a completed receipt');
    f.restart();
    const cached = await f.capability.fetch(request());
    expect(cached.status).toBe(response.status);
    expect(await cached.json()).toEqual(body);
  }, { repositoryOnly: true, sourceResponseBytes, sourceBody: 'x'.repeat(100 * 1024) }));

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

  it.each(['reserved', 'unknown'] as const)(
    'REQ-OPERATOR-047: legacy aggregate recovery preserves counts cached receipts conflicts and %s mutation ordering across reload', phase => fixture(async f => {
      await start(f);
      const url = 'https://api.github.com/repos/another/service/issues/17/comments';
      const oldRead = { operationId: 'legacy-before', url };
      const mutation = { operationId: 'legacy-mutation', url, method: 'POST' as const, body: '{"body":"legacy judgment"}' };
      const laterRead = { operationId: 'legacy-after', url };
      const cachedEnvelope = { url, status: 200, headers: { 'content-type': 'application/json' }, body: '[]' };
      // Enumeration order deliberately differs from historical reservation order.
      // Ordinals are seed data, never asserted as an internal schema contract.
      await f.seedLegacyJournal([
        { body: mutation, ordinal: 1, phase },
        { body: laterRead, ordinal: 2, phase: 'completed', response: cachedEnvelope },
        { body: oldRead, ordinal: 0, phase: 'completed', response: cachedEnvelope },
      ]);
      f.restart();
      const receipt = async (operationId: string, count: number) => {
        const response = await f.capability.fetch(genericWire('receipt', { operationId }));
        expect(response.status).toBe(200);
        const value = await response.json() as { operationId: string; requestDigest: string; responseDigest: string; phase: string };
        expect(value).toMatchObject({ operationId, operationCount: count, operationLimit: 4 });
        return value;
      };
      const reference = (value: { operationId: string; requestDigest: string; responseDigest: string }) => ({
        operationId: value.operationId, requestDigest: value.requestDigest, responseDigest: value.responseDigest,
      });
      const original = await receipt(mutation.operationId, 3);
      // Recovery may conservatively promote a stranded reservation to unknown.
      expect(['reserved', 'unknown']).toContain(original.phase);
      f.genericReadback([{ id: 9999, body: 'Changed upstream must not replace legacy cached responses', user: { id: 42 } }]);
      for (const body of [oldRead, laterRead]) {
        const cached = await f.capability.fetch(genericWire('source', body));
        expect(cached.status).toBe(200);
        expect(await cached.json()).toEqual(cachedEnvelope);
      }
      const conflict = await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed judgment"}' }));
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT' });
      for (let reload = 0; reload < 2; reload++) {
        f.restart();
        const unresolved = await f.capability.fetch(genericWire('source', mutation));
        expect(unresolved.status).toBe(409);
        expect(await unresolved.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
        expect(await receipt(mutation.operationId, 3)).toMatchObject({ phase: 'unknown', requestDigest: original.requestDigest });
      }
      const resolution = { operationId: mutation.operationId, requestDigest: original.requestDigest,
        readbacks: [reference(await receipt(oldRead.operationId, 3))] };
      const tooEarly = await f.capability.fetch(genericWire('resolve', resolution));
      expect(tooEarly.status).toBe(409);
      expect(await tooEarly.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      // A fresh read after recovery must have a later reservation order and consume
      // exactly one slot. Its empty remote result also proves the seeded write was not replayed.
      const freshRead = { operationId: 'legacy-fresh-read', url };
      f.genericReadback(undefined);
      const observed = await f.capability.fetch(genericWire('source', freshRead));
      expect(observed.status).toBe(200);
      expect(JSON.parse((await observed.json() as { body: string }).body)).toEqual([]);
      await receipt(oldRead.operationId, 4);
      f.restart();
      f.genericReadback([{ id: 9999, body: 'Changed upstream after reload must not replace legacy cache', user: { id: 42 } }]);
      for (const body of [oldRead, laterRead]) {
        const cached = await f.capability.fetch(genericWire('source', body));
        expect(cached.status).toBe(200);
        expect(await cached.json()).toEqual(cachedEnvelope);
      }
      // Both migrated historical evidence and post-recovery evidence remain later
      // than the unknown mutation; only the earlier receipt was rejected above.
      const readbacks = [reference(await receipt(laterRead.operationId, 4)), reference(await receipt(freshRead.operationId, 4))];
      for (let reload = 0; reload < 2; reload++) {
        f.restart();
        const resolved = await f.capability.fetch(genericWire('resolve', { ...resolution, readbacks }));
        expect(resolved.status).toBe(200);
        expect(await resolved.json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
        expect(await receipt(mutation.operationId, 4)).toMatchObject({ phase: 'completed', requestDigest: original.requestDigest });
        const cached = await f.capability.fetch(genericWire('source', mutation));
        expect(cached.status).toBe(200);
        expect(await cached.json()).toEqual({ resolved: true, operationId: mutation.operationId, requestDigest: original.requestDigest });
      }
      const changed = await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed judgment"}' }));
      expect(changed.status).toBe(409);
      expect(await changed.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT' });
      const denied = await f.capability.fetch(genericWire('source', { operationId: 'legacy-over-budget', url }));
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      await receipt(mutation.operationId, 4);
    }, { repositoryOnly: true, operationLimit: 4 }));

  it('REQ-OPERATOR-047: SQL-backed Activity journals and reloads an exact 1 MiB source envelope', async () => {
    const url = 'https://docs.example.test/migration';
    const headers = { 'content-type': 'text/plain', etag: 'guide-v3' };
    const overhead = new TextEncoder().encode(JSON.stringify({ url, status: 200, headers, body: '' })).byteLength;
    const sourceBody = 'x'.repeat(1024 * 1024 - overhead);
    await fixture(async f => {
      await start(f);
      const request = () => sourceRead('near-max-source', url);
      const response = await f.capability.fetch(request());
      expect(response.status).toBe(200);
      const serialized = await response.text();
      expect(new TextEncoder().encode(serialized).byteLength).toBe(1024 * 1024);
      expect(JSON.parse(serialized)).toEqual({ url, status: 200, headers, body: sourceBody });
      f.sourceBody('Changed upstream content must not replace the near-max journal receipt');
      f.restart();
      const cached = await f.capability.fetch(request());
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(serialized);
    }, { repositoryOnly: true, sourceResponseBytes: 1024 * 1024, sourceBody });
  });

  it('REQ-OPERATOR-047: rejects escaped UTF-8 envelope overflow through Activity', () => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(sourceRead('escaped-source', 'https://docs.example.test/migration'));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ code: 'OPERATOR_SOURCE_INCOMPLETE' });
  }, { repositoryOnly: true, sourceResponseBytes: 131072, sourceBody: 'é\n'.repeat(33000) }));

  it('REQ-OPERATOR-047: actual Loader outbound unwraps the approved large source without cookies', () => fixture(async f => {
    await start(f);
    const outbound = await f.loaderOutbound();
    if (!outbound) throw new Error('Repository Loader outbound missing');
    const response = await outbound.fetch(new Request('https://docs.example.test/migration', {
      headers: { 'x-codeflare-operator-operation-id': 'large-outbound' },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('guide-v3');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('x'.repeat(100 * 1024));
  }, { repositoryOnly: true, sourceResponseBytes: 131072, sourceBody: 'x'.repeat(100 * 1024) }));

  it.each(['source', 'inference'])('REQ-OPERATOR-047: raising source responses leaves %s explicitly configured request limit at 64 KiB', path => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(genericWire(path, path === 'source' ? {
      operationId: 'oversized-source-request', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: 'x'.repeat(65537),
    } : { operationId: 'oversized-inference-request', input: { messages: [{ role: 'user', content: 'x'.repeat(65537) }] } }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    expect(f.sent).toEqual([]);
  }, { repositoryOnly: true, sourceResponseBytes: 131072, inferenceRequestBytes: 65536,
    capacityPolicy: { dispatcherRequestBytes: 65536 } }));

  it.each([65536, 131072])('REQ-OPERATOR-047: source settings cannot widen the configured %i-byte inference response bound', limit => fixture(async f => {
    await start(f);
    const response = await f.capability.fetch(genericWire('inference', {
      operationId: 'oversized-inference-response', input: { messages: [{ role: 'user', content: 'assess' }] },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', collectionStatus: 'unavailable', result: null });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true, sourceResponseBytes: 1048576, inferenceRequestBytes: limit, inferenceBody: 'x'.repeat(limit + 1) }));

  it.each([70 * 1024, 131072, 1048577])('REQ-OPERATOR-047: complete %i-byte inference SSE survives caching and reconstruction at the configured inference bound', async responseBytes => {
    const prefix = 'data: {"choices":[{"delta":{"content":"';
    const suffix = '"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const body = prefix + 'x'.repeat(responseBytes - new TextEncoder().encode(prefix + suffix).byteLength) + suffix;
    for (const recovery of [false, true]) await fixture(async f => {
      await start(f);
      const request = () => genericWire('inference', { operationId: 'large-inference-response', input: { messages: [{ role: 'user', content: 'assess' }] } });
      const first = await f.capability.fetch(request());
      expect(first.status).toBe(200);
      expect(await first.text()).toBe(body);
      f.restart();
      const cached = await f.capability.fetch(request());
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(body);
      const source = await f.capability.fetch(genericWire('source', {
        operationId: 'large-inference-accounting', url: 'https://api.github.com/repos/another/service',
      }));
      expect(source.status).toBe(200);
      const receipt = await f.capability.fetch(genericWire('receipt', { operationId: 'large-inference-accounting' }));
      expect(receipt.status).toBe(200);
      expect(await receipt.json()).toMatchObject({ operationCount: 2, operationLimit: 1024 });
    }, { repositoryOnly: true, recovery, sourceResponseBytes: 65536, inferenceRequestBytes: responseBytes, inferenceBody: body });
  });

  it.each([1048576, 1048577])('REQ-OPERATOR-048: approved default final assessment preserves complete %i-byte output or refuses collection', resultBytes => fixture(async f => {
    await start(f);
    const empty = { repository: 'another/service', results: [], padding: '' };
    const result = { ...empty, padding: 'x'.repeat(resultBytes - new TextEncoder().encode(JSON.stringify(empty)).byteLength) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-result', data: result }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    if (resultBytes === 1048576) {
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
      f.restart();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
    } else {
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }
  }, { repositoryOnly: true }));

  it('REQ-OPERATOR-018/048: admitted Dispatcher commit and reconstruction preserve complete non-SDK output above 64 KiB', () => fixture(async f => {
    const drive = await f.activity.beginDrive();
    if (!drive.ok) throw new Error('Admitted drive unavailable');
    const result = { padding: 'x'.repeat(131072) };
    const update = { schemaVersion: 1, status: 'waiting', checkpoint: null, result };
    expect(await f.activity.commitDrive(drive.state.generation, update)).toMatchObject({ ok: true,
      state: { generation: drive.state.generation, status: 'waiting', result } });
    f.restart();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ result });
  }, { repositoryOnly: true, capacityPolicy: { driveResponseBytes: 200000 } }));

  it('REQ-OPERATOR-048: SDK assessment collection is independent of a smaller non-SDK drive envelope', () => fixture(async f => {
    await start(f);
    const result = { repository: 'another/service', results: [], padding: 'x'.repeat(4096) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-result', data: result }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
    f.restart();
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
  }, { repositoryOnly: true, capacityPolicy: { driveResponseBytes: 128 } }));

  it.each([64512, 65537])('REQ-OPERATOR-048: source allowance preserves final-result admission for %s bytes', resultBytes => fixture(async f => {
    await start(f);
    const empty = { repository: 'another/service', results: [], padding: '' };
    const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength;
    const result = { ...empty, padding: 'x'.repeat(resultBytes - overhead) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-result', data: result }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    if (resultBytes === 64512) {
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result });
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
    } else {
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }
  }, { repositoryOnly: true, sourceResponseBytes: 131072, capacityPolicy: { assessmentBytes: 65536 } }));
});

describe('REQ-OPERATOR-047/048/061/062/071: repository-only prospective parent authority', () => {
  it.each([false, true])('reauthorizes a stored settled assessment at public collection; prospective actor revoked=%s', revoked => fixture(async f => {
    await start(f);
    const assessment = { repository: prospectiveRepo, results: [{ pullRequest: 17, headSha: f.proof.head,
      decision: 'DO_NOT_MERGE', comment: 'Evidence does not justify merging', outcome: 'NOT_MERGED' }] };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle();
    await f.activity.reconcileDispatcherLease();
    // Real settlement persists the assessment but the targeted legacy drive still awaits public collection.
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting',
      collectionStatus: 'unavailable', result: null });
    const submitted = await Promise.all(f.childSubmissions.map(async request => ({ method: request.method,
      url: request.url, body: await request.clone().text() })));
    expect(submitted.length).toBeGreaterThan(0);
    f.sent.splice(0);
    if (revoked) f.changeRegistration(null);
    const restarted = f.restart();
    if (revoked) {
      expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await restarted.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting',
        collectionStatus: 'unavailable', result: null });
    } else {
      // Same settled fixture, current authority: collection really can expose this immutable result.
      expect(await restarted.collectBrowserResult()).toMatchObject({ ok: true, detail: {
        executionStatus: 'completed', collectionStatus: 'consumed', result: assessment } });
    }
    expect(await Promise.all(f.childSubmissions.map(async request => ({ method: request.method,
      url: request.url, body: await request.clone().text() })))).toEqual(submitted);
    expect(f.sent).toEqual([]);
  }, { prospective: true, legacyProspective: true }));

  it('authorizes repository-only work and projects one closed nonsecret target into the actual Loader, identically after reconstruction', () => fixture(async f => {
    await startProspective(f);
    expect(f.input).toEqual({ repository: prospectiveRepo });
    const loaded = await f.loaderEnv();
    expect(typeof loaded.OPERATOR_ADMITTED_TARGET).toBe('string');
    // Intent-3 Loader wire is an intentional closed metadata contract, not public input or a grant.
    expect(JSON.parse(loaded.OPERATOR_ADMITTED_TARGET as string)).toEqual(f.admittedTarget);
    const loadedKeys = Object.keys(loaded).sort();
    expect(loadedKeys).toEqual(['GITHUB_API_ORIGIN', 'OPERATOR', 'OPERATOR_ADMITTED_TARGET', 'OPERATOR_SOURCE_RESPONSE_BYTES', 'OPERATOR_SUBMISSION_ATTEMPT_LIMIT']);
    expect(loaded.OPERATOR_ADMITTED_TARGET).not.toContain('private.jwt');
    const restarted = f.restart();
    expect((await f.capability.fetch(genericWire('source', { operationId: 'reconstructed-read',
      url: `${prospectiveBase}/pulls/17` }))).status).toBe(200);
    await restarted.reconcileDispatcherLease();
    expect((await f.loaderEnv()).OPERATOR_ADMITTED_TARGET).toBe(loaded.OPERATOR_ADMITTED_TARGET);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each([1, 2])('REQ-OPERATOR-047: admitted-target comment UTF-16 limit %i admits a complete judgment or denies before effect', targetCommentChars => fixture(async f => {
    await startProspective(f);
    const body = JSON.stringify({ body: '🙂' });
    const response = await f.capability.fetch(genericWire('source', { ...prospectiveComment('comment-text-bound'), body }));
    expect(response.status).toBe(targetCommentChars === 1 ? 403 : 200);
    if (response.ok) {
      const envelope = await response.json() as { status: number; body: string };
      expect(envelope.status).toBe(201);
      expect(JSON.parse(envelope.body)).toMatchObject({ body: '🙂' });
    } else expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true, capacityPolicy: { targetCommentChars } }));

  it('accepts canonical GitHub second-resolution creation time without weakening the immutable cutoff', () => fixture(async f => {
    const createdAt = f.proof.createdAt.replace(/\.\d{3}Z$/, 'Z');
    f.changeProof({ createdAt }); f.changeTarget({ created_at: createdAt });
    await startProspective(f);
    expect(JSON.parse((await f.loaderEnv()).OPERATOR_ADMITTED_TARGET as string))
      .toEqual({ ...f.admittedTarget, createdAt });
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(200);
    expect(remoteMutations(f).map(request => request.url)).toEqual([`${prospectiveBase}/issues/17/comments`]);
  }, { prospective: true }));

  it.each([
    ['missing proof', null], ['foreign Activity', { activityId: 'foreign-activity' }],
    ['foreign installation', { installationId: 'foreign-installation' }], ['foreign owner', { ownerKey: 'f'.repeat(64) }],
    ['foreign repository ID', { repositoryId: 1 }], ['missing PR', { pullRequest: undefined }],
    ['nonpositive PR', { pullRequest: 0 }], ['unsafe PR', { pullRequest: Number.MAX_SAFE_INTEGER + 1 }],
    ['malformed head', { head: 'expected-head' }], ['uppercase head', { head: 'B'.repeat(40) }],
    ['invalid creation date', { createdAt: 'not-a-date' }], ['invalid cutoff', { activatedAt: 'not-a-date' }],
    ['future creation date', { createdAt: '2099-01-01T00:00:00Z' }],
    ['cutoff differs from original registration', { activatedAt: '2000-01-01T00:00:00Z' }],
  ] as Array<[string, Record<string, unknown> | null]>)('denies %s rather than treating proof as optional', (_name, patch) => fixture(async f => {
    await startProspective(f);
    f.changeProof(patch);
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(403);
    expect((await f.capability.fetch(genericWire('inference', { operationId: 'invalid-proof-inference',
      input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['pre-cutoff', 'equal-cutoff', 'foreign subject', 'foreign issuer', 'foreign email', 'foreign audience'])('denies %s proof coordinates', name => fixture(async f => {
    await startProspective(f);
    if (name === 'pre-cutoff' || name === 'equal-cutoff') f.changeProof({ createdAt: name === 'equal-cutoff'
      ? f.proof.activatedAt : new Date(Date.parse(f.proof.activatedAt) - 1).toISOString() });
    else f.changeProof({ actor: { ...f.proof.actor, ...(name === 'foreign subject' ? { subject: 'other-human' }
      : name === 'foreign issuer' ? { issuer: 'https://other.example.test' }
        : name === 'foreign email' ? { email: 'other@example.test' } : { audiences: ['other-audience'] }) } });
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each([
    { pullRequest: 18 }, { createdAfter: '2000-01-01T00:00:00.000Z' }, { actor: 'other-human' },
    { OPERATOR_ADMITTED_TARGET: { repository: prospectiveRepo, pullRequest: 18, headSha: 'c'.repeat(40) } },
  ])('does not accept public target/cutoff/principal metadata as prospective authority %j', inputExtra => fixture(async f => {
    await start(f);
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true, inputExtra }));

  it('admits only canonical comment and merge wires at the configured API, preserving expected-head CAS and parent identity', () => fixture(async f => {
    await start(f);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    const base = `https://github.enterprise.test/repos/${prospectiveRepo}`;
    for (const mutation of [prospectiveComment('comment', base), prospectiveMerge('merge', base)]) {
      const response = await f.capability.fetch(genericWire('source', mutation));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ url: mutation.url, status: mutation.method === 'POST' ? 201 : 200 });
    }
    const writes = remoteMutations(f);
    expect(writes.map(request => ({ method: request.method, url: request.url }))).toEqual([
      { method: 'POST', url: `${base}/issues/17/comments` }, { method: 'PUT', url: `${base}/pulls/17/merge` },
    ]);
    expect(await writes[0].clone().json()).toEqual({ body: 'Exact admitted judgment' });
    expect(await writes[1].clone().json()).toEqual({ sha: f.proof.head, merge_method: 'merge' });
    expect(writes.every(request => !request.headers.has('authorization') && !request.headers.has('cookie')
      && request.redirect === 'manual')).toBe(true);
    expect(f.sent.some(request => request.method === 'GET' && request.url === `${base}/pulls/17`)).toBe(true);
    expect(f.sent.some(request => request.method === 'GET' && request.url === base)).toBe(true);
  }, { prospective: true, githubApiHost: 'github.enterprise.test' }));

  it.each([
    ['foreign PR', 'POST', `${prospectiveBase}/issues/18/comments`],
    ['foreign repository', 'POST', 'https://api.github.com/repos/other/project/issues/17/comments'],
    ['foreign endpoint', 'POST', `${prospectiveBase}/pulls/17/reviews`],
    ['issue edit', 'PUT', `${prospectiveBase}/issues/17`],
    ['workflow dispatch', 'POST', `${prospectiveBase}/actions/workflows/1/dispatches`],
    ['wrong method', 'PUT', `${prospectiveBase}/issues/17/comments`],
    ['wrong merge method', 'POST', `${prospectiveBase}/pulls/17/merge`],
    ['public host alias', 'POST', `https://github.com/repos/${prospectiveRepo}/issues/17/comments`],
    ['lookalike host', 'POST', `https://api.github.com.evil.test/repos/${prospectiveRepo}/issues/17/comments`],
    ['query', 'POST', `${prospectiveBase}/issues/17/comments?target=18`],
    ['empty query delimiter', 'POST', `${prospectiveBase}/issues/17/comments?`],
    ['encoded PR', 'POST', `${prospectiveBase}/issues/%31%37/comments`],
    ['encoded slash', 'POST', `${prospectiveBase}/issues%2f17/comments`],
    ['encoded repo', 'POST', 'https://api.github.com/repos/nikolanovoselec/%6bomodo/issues/17/comments'],
    ['traversal alias', 'POST', `${prospectiveBase}/pulls/../issues/17/comments`],
    ['duplicate slash', 'POST', `${prospectiveBase}//issues/17/comments`],
    ['trailing slash', 'POST', `${prospectiveBase}/issues/17/comments/`],
  ])('rejects raw source %s before remote mutation', (_name, method, url) => fixture(async f => {
    await startProspective(f);
    expect((await f.capability.fetch(genericWire('source', { ...prospectiveComment(), method, url }))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each([
    ['comment invalid JSON', false, '{'], ['comment empty', false, '{"body":""}'],
    ['comment blank', false, '{"body":"  "}'], ['comment nonstring', false, '{"body":42}'],
    ['comment extra selector', false, '{"body":"judgment","pullRequest":18}'],
    ['comment list', false, '[{"body":"judgment"}]'],
    ['merge wrong SHA', true, JSON.stringify({ sha: 'c'.repeat(40), merge_method: 'merge' })],
    ['merge missing SHA', true, '{"merge_method":"merge"}'],
    ['merge missing method', true, JSON.stringify({ sha: 'b'.repeat(40) })],
    ['merge unsupported method', true, JSON.stringify({ sha: 'b'.repeat(40), merge_method: 'squash' })],
    ['merge extra selector', true, JSON.stringify({ sha: 'b'.repeat(40), merge_method: 'merge', pullRequest: 18 })],
  ] as Array<[string, boolean, string]>)('rejects %s at the prospective wire boundary', (_name, merge, body) => fixture(async f => {
    await startProspective(f);
    expect((await f.capability.fetch(genericWire('source', { ...(merge ? prospectiveMerge() : prospectiveComment()), body }))).status).toBe(403);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it('does not let standard Loader outbound or schema-valid legacy effects/discovery escape the source fence', () => fixture(async f => {
    // Typed effects have an independent current-admin gate before the prospective endpoint guard.
    // Supply that valid external role port, not a bypass of Activity or the operation under test.
    f.environment.KV = { get: async (key: string) => key === 'user:owner@example.test'
      ? '{"role":"admin"}' : null } as unknown as KVNamespace;
    await startProspective(f);
    // Admission's canonical source read above is the positive control. Observe only subsequent remote I/O.
    f.sent.splice(0);
    const outbound = await f.loaderOutbound();
    if (!outbound) throw new Error('Repository Loader outbound missing');
    const response = await outbound.fetch(new Request(`${prospectiveBase}/issues/18/comments`, { method: 'POST',
      headers: { 'x-codeflare-operator-operation-id': 'outbound-bypass', 'content-type': 'application/json' }, body: '{"body":"foreign"}' }));
    expect(response.status).toBe(403);
    const legacyWires = [
      { path: 'github/comment', body: { operationId: 'typed-comment', target: { pullRequest: 17, headSha: f.proof.head },
        decision: 'DO_NOT_MERGE', comment: 'Judgment' } },
      { path: 'github/merge', body: { operationId: 'typed-merge', target: { pullRequest: 17, headSha: f.proof.head },
        decision: 'MERGE', comment: 'Judgment' } },
      { path: 'github/read', body: { operationId: 'typed-discovery', resource: 'open-pull-requests' } },
    ];
    for (const { path, body } of legacyWires) {
      const request = genericWire(path, body);
      // Valid legacy transport is the contract: a parse rejection is not evidence of the prospective guard.
      expect((await parseDispatcherOperation(request.clone())).body).toEqual(body);
      const denied = await f.capability.fetch(request);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent).toEqual([]);
    }
    // If legacy targeted reads remain available, they cannot adopt another PR/head.
    expect((await f.capability.fetch(read('typed-foreign', { target: { pullRequest: 18, headSha: f.proof.head } }))).status).toBe(403);
    expect(f.sent).toEqual([]);
    // The installation/claim remains usable through the admitted canonical source endpoint.
    expect((await f.capability.fetch(genericWire('source', prospectiveComment('after-legacy-denial')))).status).toBe(200);
    const writes = remoteMutations(f);
    expect(writes.map(request => ({ method: request.method, url: request.url }))).toEqual([
      { method: 'POST', url: `${prospectiveBase}/issues/17/comments` },
    ]);
    expect(await writes[0].clone().json()).toEqual({ body: 'Exact admitted judgment' });
  }, { prospective: true }));

  it.each(([
    ['changed head', { head: { sha: 'c'.repeat(40) } }], ['wrong PR', { number: 18 }],
    ['changed date', { created_at: '2099-01-01T00:00:00.000Z' }],
    ['changed base', { base: { ref: 'develop', sha: 'a'.repeat(40), repo: { id: 973175879, full_name: prospectiveRepo } } }],
    ['foreign base repo', { base: { ref: 'main', sha: 'a'.repeat(40), repo: { id: 1, full_name: 'other/repo' } } }],
    ['foreign authenticated repo ID', { repository: { id: 1, full_name: prospectiveRepo } }],
    ['closed target', { state: 'closed' }], ['draft target', { draft: true }],
  ] as Array<[string, Record<string, unknown>]>).flatMap(([name, patch]) =>
    ['comment', 'merge'].map(phase => ({ name, patch, phase }))))('fresh authenticated preflight denies $phase for $name', ({ patch, phase }) => fixture(async f => {
    await startProspective(f);
    f.changeTarget(patch);
    const response = await f.capability.fetch(genericWire('source', phase === 'merge' ? prospectiveMerge() : prospectiveComment()));
    expect(response.ok).toBe(false);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['unavailable', 'incomplete'])('denies a new write when target authority reads are %s', name => fixture(async f => {
    await startProspective(f);
    if (name === 'unavailable') f.throwTransport(); else f.emptyResponse();
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).ok).toBe(false);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['grant', 'session', 'registration', 'cancel'])('rechecks %s loss after awaited preflight before forwarding', name => fixture(async f => {
    await startProspective(f);
    f.afterTargetRead(async () => {
      if (name === 'grant') f.revokeGrant();
      else if (name === 'session') f.revokeSession();
      else if (name === 'registration') f.changeRegistration(null);
      else await f.activity.cancelDrive();
    });
    expect((await f.capability.fetch(genericWire('source', prospectiveComment()))).ok).toBe(false);
    expect(f.sent.some(request => request.method === 'GET' && request.url === `${prospectiveBase}/pulls/17`)).toBe(true);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it.each(['session', 'grant', 'installation', 'expiry', 'actor', 'bucket', 'session-id', 'session-generation', 'registration-installation', 'registration-loss', 'stale-capability'])('fences warmed and reconstructed protected work on %s loss', name => fixture(async f => {
    await startProspective(f);
    if (name === 'session') f.revokeSession();
    else if (name === 'grant') f.revokeGrant();
    else if (name === 'installation') f.revoke();
    else if (name === 'expiry') f.expire();
    else if (name === 'actor') f.changeRegistration({ human: { subject: 'another-current-admin', email: 'owner@example.test',
      issuer: f.proof.actor.issuer, audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000) - 1,
      expiresAt: Math.floor(Date.now() / 1000) + 300 } });
    else if (name === 'bucket') f.changeRegistration({ bucket: 'other-bucket' });
    else if (name === 'session-id') f.changeRegistration({ sessionId: 'replacement-session' });
    else if (name === 'session-generation') f.changeRegistration({ sessionGeneration: 4 });
    else if (name === 'registration-installation') f.changeRegistration({ installationId: 'other-installation' });
    else if (name === 'registration-loss') f.changeRegistration(null);
    const capability = name === 'stale-capability' ? f.staleCapability : f.capability;
    for (const reconstruct of [false, true]) {
      if (reconstruct) f.restart();
      expect((await capability.fetch(genericWire('source', prospectiveComment(`fenced-write-${reconstruct}`)))).status).toBe(403);
      expect((await capability.fetch(genericWire('source', { operationId: `fenced-read-${reconstruct}`, url: `${prospectiveBase}/pulls/17` }))).status).toBe(403);
      expect((await capability.fetch(genericWire('inference', { operationId: `fenced-inference-${reconstruct}`,
        input: { messages: [{ role: 'user', content: 'assess' }] } }))).status).toBe(403);
    }
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true }));

  it('returns identical completed bytes after target moves/closes and reconstruction; changed semantics still conflict', () => fixture(async f => {
    await startProspective(f);
    const mutation = prospectiveComment();
    const first = await f.capability.fetch(genericWire('source', mutation));
    expect(first.status).toBe(200);
    const original = await first.text();
    f.changeTarget({ state: 'closed', head: { sha: 'c'.repeat(40) } });
    f.restart();
    // No new-write preflight may displace a previously completed operation's original receipt.
    f.throwTransport();
    const retry = await f.capability.fetch(genericWire('source', mutation));
    expect(retry.status).toBe(200);
    expect(await retry.text()).toBe(original);
    expect((await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed"}' }))).status).toBe(409);
    expect(remoteMutations(f).map(request => request.url)).toEqual([mutation.url]);
  }, { prospective: true }));

  it('preserves unknown writes without replay, allows closed/moved target readback, and seals only same-generation receipt references', () => fixture(async f => {
    await startProspective(f);
    const mutation = prospectiveComment('unknown-admitted-comment');
    f.loseResponse();
    expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    f.restoreTransport();
    f.changeTarget({ state: 'closed', head: { sha: 'c'.repeat(40) } });
    f.restart();
    f.throwTransport();
    expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    expect((await f.capability.fetch(genericWire('source', { ...mutation, body: '{"body":"changed"}' }))).status).toBe(409);
    f.restoreTransport();
    const readback = { operationId: 'admitted-positive-readback', url: mutation.url };
    const observed = await f.capability.fetch(genericWire('source', readback));
    expect(observed.status).toBe(200);
    expect(JSON.parse((await observed.json() as { body: string }).body)).toEqual([
      { id: 91, body: 'Exact admitted judgment', user: { id: 42 } },
    ]);
    const original = await (await f.capability.fetch(genericWire('receipt', { operationId: mutation.operationId }))).json() as { requestDigest: string };
    const reference = await (await f.capability.fetch(genericWire('receipt', { operationId: readback.operationId }))).json() as {
      operationId: string; requestDigest: string; responseDigest: string };
    const resolution = { operationId: mutation.operationId, requestDigest: original.requestDigest,
      readbacks: [{ operationId: reference.operationId, requestDigest: reference.requestDigest, responseDigest: reference.responseDigest }] };
    expect((await f.staleCapability.fetch(genericWire('resolve', resolution))).status).toBe(403);
    expect(await (await f.capability.fetch(genericWire('resolve', { ...resolution,
      readbacks: [{ ...resolution.readbacks[0], responseDigest: 'f'.repeat(64) }] }))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    expect(await (await f.capability.fetch(genericWire('resolve', resolution))).json()).toEqual({ resolved: true,
      operationId: mutation.operationId, requestDigest: original.requestDigest });
    expect(await (await f.capability.fetch(genericWire('source', mutation))).json()).toEqual({ resolved: true,
      operationId: mutation.operationId, requestDigest: original.requestDigest });
    expect(remoteMutations(f).map(request => request.url)).toEqual([mutation.url]);
  }, { prospective: true }));
});
