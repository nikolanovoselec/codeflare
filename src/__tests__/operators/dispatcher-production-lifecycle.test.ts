/// <reference types="@cloudflare/vitest-plugin/types" />
import { type DiagnosticPage, type DiagnosticRecord, type DispatcherFixture, denyDiagnosticWrites, diagnosticJson, diagnosticSummary, diagnosticTraversal, diagnosticsBrowser, digest, encodeSdkHeader, fixture, genericWire, invalidPreparationRefusal, nativeProfileFiles, preparationFailures, prospectiveBase, remoteMutations, retainedFence, runtimeEnvelope, seedDiagnosticSnapshot, start } from './fixtures/dispatcher-production';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from 'agents';
import { Hono } from 'hono';
import * as access from '../../lib/access';
import activityRoutes from '../../routes/operator-activities';
import { AppError } from '../../lib/error-types';
import { OperatorActivity } from '../../operators/activity';
import { captureError } from '../../operators/dispatcher-diagnostics-wire';
import { setLogLevel } from '../../lib/logger';
import type { Env } from '../../types';
import type { CurrentProspectiveRegistration } from '../../operators/registry';
import { within } from '../helpers/pending-recipient';
import { OperatorOwnerInferenceAuthority, discoverDispatcherOwnerProfile, forwardDispatcherOwnerInference } from '../../operators/dispatcher-owner-inference';
import { connectionSecret, normalCallback, normalDeployment } from './fixtures/normal-dispatcher';

describe('REQ-OPERATOR-063: comprehensive pipeline diagnostic contract', () => {
  const marker = 'PRIVATE_PIPELINE_CONTENT';
  const input = { messages: [{ role: 'user', content: marker }] };
  const wire = (operationId = 'PRIVATE_PIPELINE_OPERATION') => genericWire('inference', { operationId, input });
  const capture = async (run: (events: Array<Record<string, unknown>>) => Promise<void>, broken = false) => {
    const events: Array<Record<string, unknown>> = [];
    const spies = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method as 'log').mockImplementation(value => {
      if (broken) throw new Error(marker);
      try {
        const event = JSON.parse(String(value));
        if (event.module === 'operator-inference') events.push(event.data);
      } catch { /* Capture only the intentional structured pipeline wire. */ }
    }));
    setLogLevel('info');
    try { await run(events); }
    finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  };
  const privateWire = (events: Array<Record<string, unknown>>) => {
    const text = JSON.stringify(events);
    for (const value of [marker, 'PRIVATE_PIPELINE_OPERATION', 'PRIVATE_PIPELINE_RESPONSE', 'private.jwt', 'parent-only', 'owner@example.test', 'https://']) {
      expect(text).not.toContain(value);
    }
  };

  it.each([
    ['native-error', 'data: {"error":{"code":"NATIVE_BEDROCK_STREAM_ERROR","message":"PRIVATE_PIPELINE_RESPONSE"}}\n\ndata: [DONE]\n\n', 'native-error', 'none'],
    ['incomplete', 'data: {"choices":[{"delta":{"content":"PRIVATE_PIPELINE_RESPONSE"},"finish_reason":null}]}\n\ndata: [DONE]\n\n', 'none', 'none'],
    ['complete', 'data: {"choices":[{"delta":{"content":"PRIVATE_PIPELINE_RESPONSE"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', 'none', 'stop'],
  ])('correlates fresh and reconstructed cached %s inference without changing bytes or charging resend', (_name, body, streamError, stopReason) => fixture(async f => {
    await start(f);
    await capture(async events => {
      const first = await f.capability.fetch(wire());
      expect(first.status).toBe(200);
      expect(await first.text()).toBe(body);
      f.restart();
      const cached = await f.capability.fetch(wire());
      expect(cached.status).toBe(200);
      expect(await cached.text()).toBe(body);
      const source = await f.capability.fetch(genericWire('source', { operationId: 'diagnostic-capacity-observation', url: 'https://api.github.com/repos/another/service' }));
      expect(source.status).toBe(200);
      const receipt = await f.capability.fetch(genericWire('receipt', { operationId: 'diagnostic-capacity-observation' }));
      expect(await receipt.json()).toMatchObject({ operationCount: 2, operationLimit: 1024 });
      const journal = events.filter(value => value.stage === 'journal' && value.resource === 'inference');
      expect(journal).toEqual(expect.arrayContaining([
        expect.objectContaining({ activityId: f.activityId, generation: 1, outcome: 'reserved', operationCount: 1, operationLimit: 1024, requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }),
        expect.objectContaining({ activityId: f.activityId, generation: 1, outcome: 'cached', operationCount: 1, operationLimit: 1024 }),
      ]));
      const reserved = journal.find(value => value.outcome === 'reserved')!;
      const replayed = journal.find(value => value.outcome === 'cached')!;
      expect(replayed.operationOrdinal).toBe(reserved.operationOrdinal);
      expect(replayed.requestDigest).toBe(reserved.requestDigest);
      const responses = events.filter(value => value.stage === 'response-commit' || (value.stage === 'journal' && value.outcome === 'cached'));
      expect(responses).toEqual(expect.arrayContaining([expect.objectContaining({ streamError, stopReason,
        responseBytes: new TextEncoder().encode(body).byteLength, responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })]));
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: 'operation-prepared', activityId: f.activityId, generation: 1 }),
        expect.objectContaining({ stage: 'upstream', outcome: 'completed', status: 200 }),
      ]));
      privateWire(events);
    });
  }, { repositoryOnly: true, inferenceBody: body }));

  it('correlates payload conflict without altering original cache or authority', () => fixture(async f => {
    await start(f);
    await capture(async events => {
      const first = await f.capability.fetch(wire());
      const original = await first.text();
      const conflict = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_PIPELINE_OPERATION', input: { messages: [{ role: 'user', content: `${marker}_changed` }] } }));
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT' });
      expect(await (await f.capability.fetch(wire())).text()).toBe(original);
      expect(events).toContainEqual(expect.objectContaining({ stage: 'journal', outcome: 'conflict', activityId: f.activityId, generation: 1 }));
      privateWire(events);
    });
  }));

  it('reports upstream uncertainty and leaves failed inference fenced without model success', () => fixture(async f => {
    await start(f);
    f.loseResponse();
    await capture(async events => {
      const response = await f.capability.fetch(wire());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      const detail = await f.activity.getBrowserDetail();
      expect(detail).toMatchObject({ executionStatus: 'unknown', collectionStatus: 'unavailable' });
      expect(detail!.result).toBeNull();
      expect(events).toContainEqual(expect.objectContaining({ stage: 'upstream', outcome: 'failed', status: 502 }));
      expect(events).toContainEqual(expect.objectContaining({ stage: 'response-commit', outcome: 'unknown', activityId: f.activityId, generation: 1 }));
      privateWire(events);
    });
  }));

  it('REQ-OPERATOR-078: classifies inference output overflow without private content, collection or replay', () => fixture(async f => {
    await start(f);
    await capture(async events => {
      const response = await f.capability.fetch(wire());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', collectionStatus: 'unavailable', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(events).toContainEqual(expect.objectContaining({ stage: 'response-commit', outcome: 'unknown', resource: 'inference',
        failureClass: 'body-limit', activityId: f.activityId, generation: 1, operationOrdinal: 0 }));
      privateWire(events);
    });
  }, { repositoryOnly: true, inferenceBody: marker + 'x'.repeat(1048576) }));

  it.each(['budget', 'authority'] as const)('traces %s denial without protected I/O or lifecycle repair', name => fixture(async f => {
    await start(f);
    if (name === 'budget') expect((await f.capability.fetch(wire('consume-only-slot'))).status).toBe(200);
    else f.revoke();
    const before = await f.activity.getBrowserDetail();
    const issued = f.sent.map(request => ({ method: request.method, url: request.url }));
    await capture(async events => {
      const denied = await f.capability.fetch(wire());
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect(f.sent.map(request => ({ method: request.method, url: request.url }))).toEqual(issued);
      expect((await f.activity.getBrowserDetail())!.executionStatus).toBe(before!.executionStatus);
      expect(events).toContainEqual(expect.objectContaining({ outcome: 'denied', activityId: f.activityId, generation: 1 }));
      privateWire(events);
    });
  }, { operationLimit: 1 }));

  it('logging outage preserves exact cache bytes and original capacity', () => fixture(async f => {
    await start(f);
    await capture(async () => {
      const first = await f.capability.fetch(wire());
      expect(first.status).toBe(200);
      const body = await first.text();
      f.restart();
      expect(await (await f.capability.fetch(wire())).text()).toBe(body);
      expect((await f.activity.getBrowserDetail())!.executionStatus).toBe('running');
    }, true);
  }));
});

describe('REQ-OPERATOR-063: complete lifecycle diagnostic contract', () => {
  const capture = async (run: (events: Array<Record<string, unknown>>) => Promise<void>, broken = false) => {
    const events: Array<Record<string, unknown>> = [];
    const spies = ['log', 'warn', 'error'].map(method => vi.spyOn(console, method as 'log').mockImplementation(value => {
      if (broken) throw new Error('PRIVATE_LIFECYCLE_LOGGER');
      try { const entry = JSON.parse(String(value)); if (entry.module === 'operator-inference') events.push(entry.data); } catch { /* Closed structured wire only. */ }
    }));
    setLogLevel('info');
    try { await run(events); } finally { setLogLevel('silent'); spies.forEach(spy => spy.mockRestore()); }
  };
  it('correlates admission SDK settlement assessment collection and honest cleanup state', () => fixture(async f => capture(async events => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    const collected = await f.activity.collectBrowserResult();
    expect(collected).toMatchObject({ ok: true, detail: { executionStatus: 'completed', sdkCleanupReleased: true, result: assessment } });
    for (const stage of ['drive', 'settlement', 'assessment', 'sdk-release', 'collection', 'cleanup']) {
      expect(events).toContainEqual(expect.objectContaining({ stage, activityId: f.activityId, generation: 1 }));
    }
    expect(events).toContainEqual(expect.objectContaining({ stage: 'sdk-release', outcome: 'completed' }));
    expect(events).toContainEqual(expect.objectContaining({ stage: 'collection', outcome: 'completed' }));
    expect(events).toContainEqual(expect.objectContaining({ stage: 'cleanup', sdkReleased: true, physicalCleanup: 'unknown' }));
    expect(JSON.stringify(events)).not.toMatch(/submission-1|observedHead|private\.jwt|parent-only|owner@example\.test/);
  })));
  it('logs failed SDK settlement and collection refusal without pretending cleanup or success', () => fixture(async f => capture(async events => {
    await start(f);
    f.settle('submission-1', 'failed', { type: 'operation_failed', meta: {
      operation: 'direct(submission-1)', reason: 'Stream ended without finish_reason (retryable_interruption)' } });
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await f.activity.getBrowserDetail())!.executionStatus).toBe('unknown');
    expect(events).toContainEqual(expect.objectContaining({ stage: 'settlement', outcome: 'failed', failureClass: 'model-completion' }));
    expect(events).toContainEqual(expect.objectContaining({ stage: 'collection', outcome: 'denied' }));
    expect(events).not.toContainEqual(expect.objectContaining({ stage: 'collection', outcome: 'completed' }));
    expect(JSON.stringify(events)).not.toContain('submission-1');
  })));
  it('classifies cleanup failure then cleanup-only recovery without losing the immutable result', () => fixture(async f => {
    const sdk = Agent.prototype as unknown as { _cf_cleanupFacetPrefix: (...args: unknown[]) => Promise<void> };
    const original = sdk._cf_cleanupFacetPrefix;
    let fail = true;
    const fault = vi.spyOn(sdk, '_cf_cleanupFacetPrefix').mockImplementation(function (this: Agent, ...args: unknown[]) {
      if (fail) throw new Error('PRIVATE_CLEANUP_FAILURE');
      return original.apply(this, args);
    });
    try { await capture(async events => {
      await start(f);
      const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
      f.settle(); await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { sdkCleanupReleased: false, result: assessment } });
      expect(events).toContainEqual(expect.objectContaining({ stage: 'sdk-release', outcome: 'failed', failureClass: 'sdk-cleanup' }));
      fail = false;
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { sdkCleanupReleased: true, result: assessment } });
      expect(events).toContainEqual(expect.objectContaining({ stage: 'sdk-release', outcome: 'completed' }));
      expect(JSON.stringify(events)).not.toMatch(/PRIVATE_CLEANUP_FAILURE|submission-1/);
    }); } finally { fail = false; fault.mockRestore(); }
  }));
  it('all diagnostic sinks unavailable still permits validated collection and actual SDK release', () => fixture(async f => capture(async () => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { sdkCleanupReleased: true, result: assessment } });
  }, true)));
});

describe('REQ-OPERATOR-085: evidence-qualified Dispatcher cleanup projections', () => {
  it('REQ-OPERATOR-085: confirmed SDK release is visible across owner projections and reconstruction', () => fixture(async f => {
    await start(f);
    const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
    f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
    f.settle(); await f.activity.reconcileDispatcherLease();
    const collected = await f.activity.collectBrowserResult();
    expect(collected).toMatchObject({ ok: true, detail: { executionStatus: 'completed',
      collectionStatus: 'consumed', cleanupStatus: 'released', sdkCleanupReleased: true, result: assessment } });
    if (!collected.ok) throw new Error('Fixture result was not collected');
    const resultBytes = JSON.stringify(collected.detail.result);
    const submissions = [...f.childSubmissions];
    const outbound = [...f.sent];
    const alarm = await f.nextAlarm();
    const get = diagnosticsBrowser(f);
    expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ activityId: f.activityId,
      executionStatus: 'completed', collectionStatus: 'consumed', cleanupStatus: 'released' });
    const response = await get('');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ cleanupStatus: 'released', sdkCleanupReleased: true,
      executionStatus: 'completed', collectionStatus: 'consumed', result: assessment });

    const cold = f.restart(); await f.drainBackground();
    const detail = await cold.getBrowserDetail();
    expect(detail).toMatchObject({ activityId: f.activityId, executionStatus: 'completed',
      cleanupStatus: 'released', sdkCleanupReleased: true, collectionStatus: 'consumed', result: assessment });
    expect(JSON.stringify(detail!.result)).toBe(resultBytes);
    expect(await cold.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ cleanupStatus: 'released',
      executionStatus: 'completed', collectionStatus: 'consumed' });
    const recollected = await cold.collectBrowserResult();
    expect(recollected).toMatchObject({ ok: true, detail: { cleanupStatus: 'released', sdkCleanupReleased: true,
      executionStatus: 'completed', collectionStatus: 'consumed', result: assessment } });
    if (!recollected.ok) throw new Error('Retained result was not readable');
    expect(JSON.stringify(recollected.detail.result)).toBe(resultBytes);
    // Current-generation matching has no lease-status prerequisite. Exercise retained metadata only,
    // after genuine settlement/collection, without acquiring a child or changing its authority.
    for (const status of ['admitting', 'running', 'unknown', 'settled'] as const) {
      await f.mutateEvidence(async storage => {
        const lease = await storage.get<Record<string, unknown>>('dispatcher:lease');
        if (!lease) throw new Error('Fixture lease missing');
        await storage.put('dispatcher:lease', { ...lease, status });
      });
      expect(await cold.getBrowserDetail()).toMatchObject({ cleanupStatus: 'released', sdkCleanupReleased: true,
        executionStatus: 'completed', collectionStatus: 'consumed', result: assessment });
      expect(await cold.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ cleanupStatus: 'released',
        executionStatus: 'completed', collectionStatus: 'consumed' });
    }
    expect(await cold.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
    expect(f.childSubmissions).toEqual(submissions);
    expect(f.sent).toEqual(outbound);
    expect(await f.nextAlarm()).toBe(alarm);
  }));

  it('REQ-OPERATOR-085: unconfirmed cleanup preserves the immutable result without reporting release', () => fixture(async f => {
    const sdk = Agent.prototype as unknown as { _cf_cleanupFacetPrefix: (...args: unknown[]) => Promise<void> };
    const fault = vi.spyOn(sdk, '_cf_cleanupFacetPrefix').mockImplementation(async () => {
      throw new Error('Controlled SDK cleanup unavailable');
    });
    try {
      await start(f);
      const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
      f.settle(); await f.activity.reconcileDispatcherLease();
      const collected = await f.activity.collectBrowserResult();
      expect(collected).toMatchObject({ ok: true, detail: { executionStatus: 'completed',
        collectionStatus: 'consumed', cleanupStatus: 'pending', sdkCleanupReleased: false, result: assessment } });
      if (!collected.ok) throw new Error('Cleanup failure lost the result');
      const resultBytes = JSON.stringify(collected.detail.result);
      await f.drainBackground();
      const submissions = [...f.childSubmissions];
      const outbound = [...f.sent];
      const alarm = await f.nextAlarm();
      // This owner is already warm: cleanup can now succeed, so an added retry would change public evidence.
      // Existing cold-entry retirement is deliberately not suppressed or constrained by this case.
      fault.mockRestore();
      const response = await diagnosticsBrowser(f)('');
      expect(response.status).toBe(200);
      const detail = await response.json() as { result: unknown };
      expect(detail).toMatchObject({ executionStatus: 'completed', collectionStatus: 'consumed',
        cleanupStatus: 'pending', sdkCleanupReleased: false, result: assessment });
      expect(JSON.stringify(detail.result)).toBe(resultBytes);
      await f.drainBackground();
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed',
        collectionStatus: 'consumed', cleanupStatus: 'pending', sdkCleanupReleased: false, result: assessment });
      expect(await f.activity.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ cleanupStatus: 'pending',
        executionStatus: 'completed', collectionStatus: 'consumed' });
      expect(await f.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
      expect(f.childSubmissions).toEqual(submissions);
      expect(f.sent).toEqual(outbound);
      expect(await f.nextAlarm()).toBe(alarm);
    } finally { fault.mockRestore(); }
  }));

  it.each(['generation', 'inputDigest', 'artifactDigest'] as const)(
    'REQ-OPERATOR-085: mismatched %s cannot confirm SDK release', field => fixture(async f => {
      await start(f);
      const assessment = { readOnly: true, observedHead: 'b'.repeat(40) };
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: assessment }] }]);
      f.settle(); await f.activity.reconcileDispatcherLease();
      const collected = await f.activity.collectBrowserResult();
      expect(collected).toMatchObject({ ok: true, detail: { sdkCleanupReleased: true, result: assessment } });
      if (!collected.ok) throw new Error('Fixture result was not collected');
      const resultBytes = JSON.stringify(collected.detail.result);
      // Historical positive-release metadata with one wrong authority coordinate, not a fabricated DTO.
      await f.mutateEvidence(async storage => {
        const lease = await storage.get<{ generation: number } & Record<string, unknown>>('dispatcher:lease');
        if (!lease) throw new Error('Fixture lease missing');
        await storage.put('dispatcher:lease', { ...lease,
          [field]: field === 'generation' ? lease.generation + 1 : 'e'.repeat(64), sdkReleased: true });
      });
      const cold = f.restart(); await f.drainBackground();
      const detail = await cold.getBrowserDetail();
      expect(detail).toMatchObject({ executionStatus: 'completed', collectionStatus: 'consumed',
        cleanupStatus: 'pending', sdkCleanupReleased: false, result: assessment });
      expect(JSON.stringify(detail!.result)).toBe(resultBytes);
      expect(await cold.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ cleanupStatus: 'pending',
        executionStatus: 'completed', collectionStatus: 'consumed' });
      expect(await cold.collectBrowserResult()).toMatchObject({ ok: true, detail: { cleanupStatus: 'pending',
        sdkCleanupReleased: false, result: assessment, collectionStatus: 'consumed' } });
      expect(await cold.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
    }));

  it('REQ-OPERATOR-085: exact fenced SDK release remains known without restarting cancelled work', () => fixture(async f => {
    await start(f);
    await f.seedCancelledReleased();
    const submissions = [...f.childSubmissions];
    const outbound = [...f.sent];
    const alarm = await f.nextAlarm();
    const cold = f.restart(); await f.drainBackground();
    expect(await cold.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ activityId: f.activityId,
      executionStatus: 'cancel-requested', cleanupStatus: 'released', collectionStatus: 'unavailable' });
    expect(await cold.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested',
      cleanupStatus: 'released', sdkCleanupReleased: true, collectionStatus: 'unavailable', result: null });
    const response = await diagnosticsBrowser(f)('');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ executionStatus: 'cancel-requested', cleanupStatus: 'released',
      sdkCleanupReleased: true, collectionStatus: 'unavailable', result: null });
    expect(await cold.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(await cold.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
    // Original generation authority stays fenced even though its exact SDK release is known.
    expect(await cold.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { readOnly: true } })).toEqual({ ok: false, reason: 'stale-drive' });
    expect((await f.capability.fetch(genericWire('source', { operationId: 'no-authority-from-release',
      url: 'https://api.github.com/repos/another/service' }))).status).toBe(403);
    expect(await cold.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested', cleanupStatus: 'released',
      sdkCleanupReleased: true, collectionStatus: 'unavailable', result: null });
    // An exact predecessor is allowed, not an arbitrary positive release from a different fenced scope.
    await f.mutateEvidence(async storage => {
      const lease = await storage.get<{ generation: number } & Record<string, unknown>>('dispatcher:lease');
      if (!lease) throw new Error('Fixture lease missing');
      try {
        for (const field of ['generation', 'inputDigest', 'artifactDigest'] as const) {
          await storage.put('dispatcher:lease', { ...lease,
            [field]: field === 'generation' ? lease.generation + 2 : 'e'.repeat(64) });
          expect(await cold.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested',
            cleanupStatus: 'stopping', sdkCleanupReleased: false, collectionStatus: 'unavailable', result: null });
          expect(await cold.getBrowserSummary(f.proof.ownerKey)).toMatchObject({ executionStatus: 'cancel-requested',
            cleanupStatus: 'stopping', collectionStatus: 'unavailable' });
        }
      } finally { await storage.put('dispatcher:lease', lease); }
    });
    expect(await cold.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested', cleanupStatus: 'released',
      sdkCleanupReleased: true, collectionStatus: 'unavailable', result: null });
    expect(f.childSubmissions).toEqual(submissions);
    expect(f.sent).toEqual(outbound);
    expect(await f.nextAlarm()).toBe(alarm);
  }, { repositoryOnly: true, intent4: true }));
});


it('REQ-OPERATOR-063: owner inspection diagnoses an existing cached native error without replay or lifecycle mutation', () => fixture(async f => {
  await start(f);
  const original = await f.capability.fetch(genericWire('inference', { operationId: 'PRIVATE_HISTORICAL_OPERATION',
    input: { messages: [{ role: 'user', content: 'PRIVATE_HISTORICAL_PROMPT' }] } }));
  expect(await original.text()).toContain('NATIVE_BEDROCK_STREAM_ERROR');
  f.restart();
  const before = await f.activity.getBrowserDetail();
  const issued = f.sent.map(request => ({ method: request.method, url: request.url }));
  const events: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'log').mockImplementation(value => {
    try { const entry = JSON.parse(String(value)); if (entry.module === 'operator-inference') events.push(entry.data); } catch { /* Structured inspection wire. */ }
  });
  setLogLevel('info');
  try {
    const after = await f.activity.getBrowserDetail();
    expect(after).toEqual(before);
    expect(f.sent.map(request => ({ method: request.method, url: request.url }))).toEqual(issued);
    expect(events).toContainEqual(expect.objectContaining({ stage: 'journal-inspection', outcome: 'observed',
      activityId: f.activityId, generation: 1, streamError: 'native-error', stopReason: 'none',
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/), responseDigest: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_HISTORICAL|private\.jwt|parent-only|https:\/\//);
  } finally { spy.mockRestore(); setLogLevel('silent'); }
}, { inferenceBody: 'data: {"error":{"code":"NATIVE_BEDROCK_STREAM_ERROR","message":"PRIVATE_HISTORICAL_RESPONSE"}}\n\ndata: [DONE]\n\n' }));

describe('REQ-OPERATOR-063: stored SDK failure inspection', () => {
  const captureInspection = async (run: () => Promise<void>) => {
    const events: Array<Record<string, unknown>> = [];
    const output: string[] = [];
    const spies = (['log', 'warn', 'error'] as const).map(sink => vi.spyOn(console, sink).mockImplementation((...values: unknown[]) => {
      for (const value of values) {
        let text: string;
        try { text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value); }
        catch { text = String(value); }
        output.push(text);
        try {
          const entry = JSON.parse(text);
          if (entry.module === 'operator-inference') events.push(entry.data);
        } catch { /* Preserve non-JSON output for privacy and logging-OFF assertions. */ }
      }
    }));
    setLogLevel('info');
    try { await run(); return { events, output }; }
    finally { for (const spy of spies) spy.mockRestore(); setLogLevel('silent'); }
  };
  it.each([
    ['submission_retry_exhausted', 'submission_retry_exhausted'],
    ['PRIVATE_SDK_FAILURE_TYPE', 'other'],
  ])('owner read classifies retained %s without exposing content or restarting work', (type, expected) => fixture(async f => {
    await start(f);
    const source = await f.capability.fetch(genericWire('source', { operationId: 'stored-failure-read',
      url: 'https://api.github.com/repos/another/service/pulls/17' }));
    expect(source.status).toBe(200);
    f.settle('submission-1', 'failed', { type, message: 'PRIVATE_SDK_MESSAGE',
      meta: { reason: 'PRIVATE_SDK_REASON', operation: 'PRIVATE_SDK_OPERATION' } });
    await f.activity.reconcileDispatcherLease();
    const before = await f.activity.getBrowserDetail();
    const outbound = f.sent.map(request => ({ method: request.method, url: request.url }));
    const childSubmissions = f.childSubmissions.map(request => ({ method: request.method, url: request.url }));
    const restarted = f.restart();
    const { events, output } = await captureInspection(async () => {
      expect(await restarted.getBrowserDetail()).toEqual(before);
      expect(await restarted.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    });
    expect(before).toMatchObject({ executionStatus: 'unknown', collectionStatus: 'unavailable', result: null });
    expect(events).toContainEqual(expect.objectContaining({ stage: 'journal-inspection', boundary: 'projection',
      outcome: 'failed', activityId: f.activityId, generation: 1, sdkErrorType: expected }));
    expect(output.join('\n')).not.toMatch(/PRIVATE_SDK|private\.jwt|parent-only|submission-1/);
    expect(f.sent.map(request => ({ method: request.method, url: request.url }))).toEqual(outbound);
    expect(f.childSubmissions.map(request => ({ method: request.method, url: request.url }))).toEqual(childSubmissions);
  }, { repositoryOnly: true }));
  it('foreign failed settlement cannot create an owner failure classification', () => fixture(async f => {
    await start(f);
    f.settle('foreign-submission', 'failed', { type: 'submission_retry_exhausted' });
    await f.activity.reconcileDispatcherLease();
    const { events } = await captureInspection(async () => {
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    });
    expect(events.filter(event => event.sdkErrorType !== undefined)).toEqual([]);
  }));
  it('REQ-OPERATOR-079: logging OFF suppresses retained SDK failure inspection without changing owner state', () => fixture(async f => {
    await start(f);
    f.settle('submission-1', 'failed', { type: 'submission_retry_exhausted' });
    await f.activity.reconcileDispatcherLease();
    const { output } = await captureInspection(async () => {
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null,
        collectionStatus: 'unavailable' });
    });
    expect(output).toEqual([]);
  }, { loggingEnabled: false }));
});


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  const configuredTarget = { repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk' };
  const root = 'https://api.github.com/repos/acme/updates';
  const comment = (operationId: string) => ({ operationId, method: 'POST', url: `${root}/issues/17/comments`,
    body: JSON.stringify({ body: 'Exact admitted judgment' }) });
  it('the actual runtime Loader and exact mutation allowlist use the same immutable alternate admitted target through reconstruction', () => fixture(async f => {
    await start(f);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    expect(f.input).toEqual({ repository: configuredTarget.repository });
    expect(JSON.parse((await f.loaderEnv()).OPERATOR_ADMITTED_TARGET as string)).toEqual(f.admittedTarget);
    const request = comment('configured-comment');
    const completed = await f.capability.fetch(genericWire('source', request));
    expect(completed.status).toBe(200);
    const cached = await completed.json();
    f.restart();
    expect(await (await f.capability.fetch(genericWire('source', request))).json()).toEqual(cached);
    expect(remoteMutations(f).map(request => request.url)).toEqual([`${root}/issues/17/comments`]);
    expect((await f.capability.fetch(genericWire('source', { ...comment('foreign-target'), url: `${prospectiveBase}/issues/17/comments` }))).status).toBe(403);
    expect(remoteMutations(f).map(request => request.url)).toEqual([`${root}/issues/17/comments`]);
  }, { prospective: true, configuredTarget }));
  it('unknown alternate-target mutations are never replayed after reconstruction', () => fixture(async f => {
    await start(f); f.loseResponse();
    const operation = comment('configured-unknown');
    expect(await (await f.capability.fetch(genericWire('source', operation))).json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    f.restoreTransport(); f.restart();
    expect((await f.capability.fetch(genericWire('source', operation))).status).toBe(409);
    expect(remoteMutations(f).map(request => request.url)).toEqual([operation.url]);
  }, { prospective: true, configuredTarget }));
  it.each([{ repository: 'other/repo' }, { repositoryId: 1 }, { baseBranch: 'main' }, { installationRevision: 2 }])
    ('a substituted admission %j cannot borrow current configured authority', patch => fixture(async f => {
      await start(f); f.changeProof(patch);
      const outbound = [...f.sent];
      expect((await f.capability.fetch(genericWire('source', comment('substituted')))).status).toBe(403);
      expect(f.sent).toEqual(outbound);
    }, { prospective: true, configuredTarget }));
  it('fresh registration cannot rebind an old proof after settings change', () => fixture(async f => {
    await start(f);
    f.changeRegistration({ registrationId: 'fresh-settings-generation', ...configuredTarget,
      installationRevision: 2 } as unknown as Partial<CurrentProspectiveRegistration>);
    const outbound = [...f.sent];
    expect((await f.capability.fetch(genericWire('source', comment('old-proof')))).status).toBe(403);
    expect(f.sent).toEqual(outbound);
    expect(remoteMutations(f)).toEqual([]);
  }, { prospective: true, configuredTarget }));
});


// Intentional intent4 admission/progress wire contracts; the child seam is mocked here.
// Real generated-class SDK/effect/eviction proof remains in the preserved native suite.
describe('REQ-OPERATOR-048: original-lease serial SDK phase ownership', () => {
  type Context = { scope: string; generation: number; deadline: string; releaseDigest: string;
    authorityDigest: string; submissionId: string; phase: { kind: string; index?: number; target?: { pullRequest: number; headSha: string } };
    deliveryToken: string; previous?: Array<{ submissionId: string; phase: unknown; outcome: string }> };
  const frozen = [17, 18].map((pullRequest, index) => ({ pullRequest, headSha: String(index + 1).repeat(40) }));
  const wire = (path: string, body: unknown, token: string) => new Request(`https://operator.internal/v1/dispatcher/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-codeflare-dispatcher-delivery': token }, body: JSON.stringify(body),
  });
  const latestDelivery = async (f: DispatcherFixture) => {
    const input = await f.childSubmissions.at(-1)!.clone().json() as { kind: string; type: string; body: string;
      attributes: { deliveryToken: string }; idempotencyKey: string; uid: string | null };
    expect(input.kind).toBe('signal'); expect(input.type).toBe('dispatcher-phase');
    expect(input.body).toBe(JSON.stringify(f.input));
    return input;
  };
  const context = async (f: DispatcherFixture, suppliedToken?: string): Promise<Context> => {
    const token = suppliedToken ?? (await latestDelivery(f)).attributes.deliveryToken;
    const response = await f.capability.fetch(wire('phase-context', { deliveryToken: token }, token));
    expect(response.status).toBe(200);
    return response.json();
  };
  const progress = (f: DispatcherFixture, stamp: Context, next: unknown, payload: object) => {
    f.messages([{ submissionId: stamp.submissionId, parts: [{ type: 'data-dispatcher-progress', data: {
      version: 1, scope: stamp.scope, generation: stamp.generation, submissionId: stamp.submissionId,
      phase: stamp.phase, next, ...payload,
    } }] }]);
    f.settle(stamp.submissionId);
  };
  const discovery = async (f: DispatcherFixture) => {
    const first = await context(f);
    expect(first.scope).toBe('submission'); expect(first.phase).toEqual({ kind: 'discovery' });
    expect(first.previous).toBeUndefined();
    progress(f, first, { kind: 'target', index: 0, target: frozen[0] }, { targets: frozen });
    await f.activity.reconcileDispatcherLease();
    return first;
  };

  const coldOwner = async (f: DispatcherFixture): Promise<DispatcherFixture> => {
    const activity = f.restart();
    // Direct fixture calls bypass the platform's cold-constructor RPC gate.
    await f.drainBackground();
    // Existing recovery scenarios exercise an ordinary owner wake, not diagnostics.
    await activity.getAdmission();
    await f.drainBackground();
    return { ...f, activity };
  };
  const deadlineSchedule = async (f: DispatcherFixture) => {
    const row = (await f.activity.listSchedules()).find(row =>
      row.callback === 'reconcileDispatcherLease' && row.type === 'scheduled');
    expect(row?.type).toBe('scheduled');
    return row!;
  };
  const rows = frozen.map(target => ({ ...target, decision: 'DO_NOT_MERGE',
    comment: 'Actual fixture judgment', outcome: 'NOT_MERGED' }));
  const finalResult = (f: DispatcherFixture, results: unknown[] = rows) => ({
    ...(f.input as { repository: string }), results,
  });
  const stableCollection = (collected: Awaited<ReturnType<OperatorActivity['collectBrowserResult']>>) => {
    if (!collected.ok) return collected;
    // Collection updates its observation timestamp, not the immutable result or receipt.
    const { updatedAt: _updatedAt, ...detail } = collected.detail;
    return { ok: true, detail };
  };
  const finish = async (f: DispatcherFixture, results: unknown[] = rows) => {
    let stamp = await context(f);
    if (stamp.phase.kind === 'discovery') {
      progress(f, stamp, { kind: 'target', index: 0, target: frozen[0] }, { targets: frozen });
      await f.activity.reconcileDispatcherLease();
      stamp = await context(f);
    }
    // Exactly the existing two-target journey; no retired native workload expansion.
    for (const index of [0, 1]) if (stamp.phase.kind === 'target' && stamp.phase.index === index) {
      progress(f, stamp, index === 0 ? { kind: 'target', index: 1, target: frozen[1] } : { kind: 'final' },
        { results: results.slice(0, index + 1) });
      await f.activity.reconcileDispatcherLease();
      stamp = await context(f);
    }
    expect(stamp.phase).toEqual({ kind: 'final' });
    const result = finalResult(f, results);
    f.messages([{ submissionId: stamp.submissionId, parts: [{ type: 'data-assessment', data: result }] }]);
    f.settle(stamp.submissionId);
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result });
    const collected = await f.activity.collectBrowserResult();
    expect(collected).toMatchObject({ ok: true, detail: { result, sdkCleanupReleased: true } });
    expect(stableCollection(await f.activity.collectBrowserResult())).toEqual(stableCollection(collected));
    return collected;
  };
  const deny = async (response: Response) => {
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
  };
  const protectedRequests = (token: string) => [
    wire('source', { operationId: 'cold-fenced-comment', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"must not publish"}' }, token),
    wire('inference', { operationId: 'cold-fenced-model', input: { messages: [{ role: 'user', content: 'must not infer' }] } }, token),
  ];
  const receipt = async (f: DispatcherFixture, operationId: string, token: string) => {
    const response = await f.capability.fetch(wire('receipt', { operationId }, token));
    expect(response.status).toBe(200);
    return await response.json() as { phase: string; requestDigest: string; responseDigest?: string;
      method: string; url: string; operationCount: number };
  };

  const nativeProviderUrl = 'https://chatgpt.com/backend-api/codex/responses';
  const nativeBody = JSON.stringify({ model: 'gpt-6.1-sol', input: [], reasoning: { effort: 'low' }, stream: true });

  it.each(['oauth', 'api_key'] as const)(
    'REQ-OPERATOR-007/047/048: saved OpenAI %s selection uses matching auth, never the separate Codex login', kind => fixture(async f => {
      const token = kind === 'oauth' ? 'synthetic-openai-account-access' : 'synthetic-openai-api-key';
      const savedSettings = { defaultProvider: 'openai', defaultModel: 'gpt-6.1-sol', defaultThinkingLevel: 'high' };
      nativeProfileFiles.set('/owner-bucket/.pi/agent/settings.json', savedSettings);
      nativeProfileFiles.set('/owner-bucket/.pi/agent/auth.json', {
        openai: kind === 'oauth'
          ? { type: 'oauth', access: token, refresh: 'synthetic-openai-refresh', expires: Date.now() + 120_000 }
          : { type: 'api_key', key: token },
        'openai-codex': { type: 'oauth', access: 'synthetic-legacy-codex-access', refresh: 'synthetic-legacy-refresh',
          accountId: 'synthetic-legacy-account', expires: Date.now() + 120_000 },
      });
      const savedProfile = structuredClone(nativeProfileFiles);
      await start(f);
      const loader = await f.loaderEnv();
      const selected = JSON.parse(loader.OPERATOR_INFERENCE_SELECTION as string);
      expect(selected).toMatchObject({ source: 'pi-native', provider: 'openai', model: savedSettings.defaultModel,
        api: 'openai-responses', reasoningLevel: 'low' });
      const binding = await f.capability.fetch(genericWire('native-binding', { profileDigest: selected.profileDigest }));
      expect(binding.status).toBe(200);
      const bound = await binding.json() as { selection: unknown; auth: { apiKey: string; headers?: Record<string, string | null> } };
      expect(bound.selection).toEqual(selected);
      expect(bound.auth.apiKey).toBe(token);
      const admitted = await f.capability.fetch(genericWire('native-admission', {
        operationId: 'selected-openai-auth', profileDigest: selected.profileDigest }));
      expect(admitted.status).toBe(200);
      const { handle } = await admitted.json() as { handle: string };
      const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${bound.auth.apiKey}`,
        'x-codeflare-native-inference': handle });
      for (const [name, value] of Object.entries(bound.auth.headers ?? {})) {
        if (value !== null) headers.set(name, value);
      }
      const response = await f.capability.fetch(new Request('https://api.openai.com/v1/responses', {
        method: 'POST', headers, body: nativeBody }));
      expect(response.status).toBe(201);
      expect(await response.text()).toBe('selected OpenAI response');
      expect((await f.capability.fetch(genericWire('native-result', { handle, outcome: 'completed' }))).status).toBe(200);
      const sent = f.sent.filter(request => request.url === 'https://api.openai.com/v1/responses');
      expect(sent).toHaveLength(1);
      expect(sent[0].headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(sent[0].headers.has('chatgpt-account-id')).toBe(false);
      expect(await sent[0].clone().json()).toMatchObject({ model: savedSettings.defaultModel, reasoning: { effort: 'low' } });
      expect(nativeProfileFiles).toEqual(savedProfile);
      let durable = '';
      await f.mutateEvidence(async storage => { durable = JSON.stringify([...await storage.list()]); });
      // OPERATOR is an opaque RPC binding; the test double exposes its private env.
      const descriptor = { ...loader };
      delete descriptor.OPERATOR;
      expect(JSON.stringify(descriptor) + durable).not.toMatch(
        /synthetic-openai-account-access|synthetic-openai-api-key|synthetic-openai-refresh|synthetic-legacy-codex-access|synthetic-legacy-refresh|synthetic-scoped/);
    }, { repositoryOnly: true, recovery: true, intent4: false, facetContract: true, nativeInference: true,
      sourceTransport: async request => request.url === 'https://api.openai.com/v1/responses'
        ? new Response('selected OpenAI response', { status: 201 }) : Response.json({ ok: true }) }));

  it.each(['revoked', 'cancelled'] as const)(
    'REQ-OPERATOR-047/048: ordinary native transport needs no phase token and retains %s authority fences after cold replay', fence => fixture(async f => {
      await start(f);
      const selected = JSON.parse((await f.loaderEnv()).OPERATOR_INFERENCE_SELECTION as string);
      const bindingRequest = () => genericWire('native-binding', { profileDigest: selected.profileDigest });
      const binding = await f.capability.fetch(bindingRequest());
      expect(binding.status).toBe(200);
      const bound = await binding.json() as { auth: { apiKey: string }; selection: unknown };
      expect(bound.selection).toEqual(selected);
      const admission = { operationId: 'ordinary-native', profileDigest: selected.profileDigest };
      const admitted = await f.capability.fetch(genericWire('native-admission', admission));
      expect(admitted.status).toBe(200);
      const { handle } = await admitted.json() as { handle: string };
      const request = () => new Request(nativeProviderUrl, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${bound.auth.apiKey}`,
        'chatgpt-account-id': 'synthetic-account', 'x-codeflare-native-inference': handle }, body: nativeBody });
      const result = () => genericWire('native-result', { handle, outcome: 'completed' });
      // SDK setup or admission alone is never a committed transport receipt.
      expect((await f.capability.fetch(result())).status).toBe(403);
      expect(f.sent.filter(request => request.url === nativeProviderUrl)).toHaveLength(0);
      const response = await f.capability.fetch(request());
      expect(response.status).toBe(201);
      expect(response.headers.get('x-request-id')).toBe('ordinary-native-response');
      expect(await response.text()).toBe('exact ordinary native bytes');
      expect((await f.capability.fetch(result())).status).toBe(200);
      const cold = await coldOwner(f);
      const retained = await cold.capability.fetch(genericWire('native-admission', admission));
      expect(retained.status).toBe(200);
      expect(await retained.json()).toEqual({ handle });
      const replay = await cold.capability.fetch(request());
      expect(replay.status).toBe(201);
      expect(replay.headers.get('x-request-id')).toBe('ordinary-native-response');
      expect(await replay.text()).toBe('exact ordinary native bytes');
      expect((await cold.capability.fetch(result())).status).toBe(200);
      for (const protectedRequest of [bindingRequest(), genericWire('native-admission', admission), request(), result()]) {
        expect((await cold.staleCapability.fetch(protectedRequest)).status).toBe(403);
      }
      if (fence === 'revoked') cold.revoke();
      else expect(await cold.activity.cancelDrive()).toMatchObject({ ok: true });
      for (const protectedRequest of [bindingRequest(), genericWire('native-admission', admission), request(), result()]) {
        expect((await cold.capability.fetch(protectedRequest)).status).toBe(403);
      }
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      const sent = f.sent.filter(request => request.url === nativeProviderUrl);
      expect(sent).toHaveLength(1);
      expect(sent[0].headers.get('x-codeflare-dispatcher-delivery')).toBeNull();
      expect(sent[0].headers.get('x-codeflare-native-inference')).toBeNull();
      expect(await sent[0].clone().text()).toBe(nativeBody);
    }, { repositoryOnly: true, recovery: true, intent4: false, facetContract: true, nativeInference: true,
      sourceTransport: async request => request.url !== nativeProviderUrl ? Response.json({ ok: true })
        : new Response('exact ordinary native bytes', { status: 201, headers: { 'x-request-id': 'ordinary-native-response' } }) }));

  it('REQ-OPERATOR-047/048: native zstd inspection denies malformed bodies and forwards original compressed bytes', () => fixture(async f => {
    // Public Node codec only: CI must expose the same API used by the Parent inspector.
    // Missing Workerd codec support is a real CI blocker, not a skipped qualification.
    const { zstdCompressSync } = await import('node:zlib');
    const compressed = new Uint8Array(zstdCompressSync(new TextEncoder().encode(nativeBody)));
    await start(f);
    const selected = JSON.parse((await f.loaderEnv()).OPERATOR_INFERENCE_SELECTION as string);
    const binding = await f.capability.fetch(genericWire('native-binding', { profileDigest: selected.profileDigest }));
    expect(binding.status).toBe(200);
    const bound = await binding.json() as { auth: { apiKey: string } };
    const admitted = await f.capability.fetch(genericWire('native-admission', {
      operationId: 'native-compressed', profileDigest: selected.profileDigest }));
    expect(admitted.status).toBe(200);
    const { handle } = await admitted.json() as { handle: string };
    const request = (body: Uint8Array) => new Request(nativeProviderUrl, { method: 'POST', headers: {
      'content-type': 'application/json', 'content-encoding': 'zstd', authorization: `Bearer ${bound.auth.apiKey}`,
      'chatgpt-account-id': 'synthetic-account', 'x-codeflare-native-inference': handle }, body });
    // Invalid compressed input cannot claim or complete the admitted transport.
    expect((await f.capability.fetch(request(new TextEncoder().encode('not a zstd frame')))).status).toBe(403);
    expect((await f.capability.fetch(genericWire('native-result', { handle, outcome: 'completed' }))).status).toBe(403);
    expect(f.sent.filter(request => request.url === nativeProviderUrl)).toHaveLength(0);
    const response = await f.capability.fetch(request(compressed));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('compressed native response');
    const sent = f.sent.filter(request => request.url === nativeProviderUrl);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers.get('content-encoding')).toBe('zstd');
    expect(new Uint8Array(await sent[0].clone().arrayBuffer())).toEqual(compressed);
    expect((await f.capability.fetch(genericWire('native-result', { handle, outcome: 'completed' }))).status).toBe(200);
  }, { repositoryOnly: true, recovery: true, intent4: false, facetContract: true, nativeInference: true,
    sourceTransport: async request => request.url !== nativeProviderUrl ? Response.json({ ok: true })
      : new Response('compressed native response') }));

  it.each(['missing', 'stale'] as const)(
    'REQ-OPERATOR-047/048: serial native admission denies %s delivery without spending an upstream attempt', tokenKind => fixture(async f => {
      await start(f);
      const original = await context(f);
      if (tokenKind === 'stale') await discovery(f);
      const current = await context(f);
      const selected = JSON.parse((await f.loaderEnv()).OPERATOR_INFERENCE_SELECTION as string);
      const admission = { operationId: 'serial-native-current', profileDigest: selected.profileDigest };
      const deniedRequest = tokenKind === 'missing' ? genericWire('native-admission', admission)
        : wire('native-admission', admission, original.deliveryToken);
      await deny(await f.capability.fetch(deniedRequest));
      expect(f.sent.filter(request => request.url === nativeProviderUrl)).toHaveLength(0);
      const admitted = await f.capability.fetch(wire('native-admission', admission, current.deliveryToken));
      expect(admitted.status).toBe(200);
      const { handle } = await admitted.json() as { handle: string };
      // No provider request was committed; a successful SDK outcome cannot create one.
      expect((await f.capability.fetch(wire('native-result', { handle, outcome: 'completed' }, current.deliveryToken))).status).toBe(403);
      expect(await context(f)).toEqual(current);
      expect(f.sent.filter(request => request.url === nativeProviderUrl)).toHaveLength(0);
    }, { repositoryOnly: true, recovery: true, intent4: true, facetContract: true, nativeInference: true,
      sourceTransport: async () => Response.json({ ok: true }) }));

  it.each(['partial', 'unknown'] as const)(
    'REQ-OPERATOR-047/048: %s native transport cannot replay or settle after cold reconstruction', failure => fixture(async f => {
      await start(f);
      const selected = JSON.parse((await f.loaderEnv()).OPERATOR_INFERENCE_SELECTION as string);
      const binding = await f.capability.fetch(genericWire('native-binding', { profileDigest: selected.profileDigest }));
      expect(binding.status).toBe(200);
      const bound = await binding.json() as { auth: { apiKey: string } };
      const admission = { operationId: 'native-uncertain', profileDigest: selected.profileDigest };
      const admitted = await f.capability.fetch(genericWire('native-admission', admission));
      expect(admitted.status).toBe(200);
      const { handle } = await admitted.json() as { handle: string };
      const request = () => new Request(nativeProviderUrl, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${bound.auth.apiKey}`,
        'chatgpt-account-id': 'synthetic-account', 'x-codeflare-native-inference': handle }, body: nativeBody });
      const response = await f.capability.fetch(request());
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      const cold = await coldOwner(f);
      expect((await cold.capability.fetch(genericWire('native-admission', admission))).status).toBe(409);
      expect((await cold.capability.fetch(request())).status).toBe(409);
      for (const outcome of ['completed', 'failed']) {
        expect((await cold.capability.fetch(genericWire('native-result', { handle, outcome }))).status).toBe(403);
      }
      // A new operation label cannot evade the retained canonical wire/attempt fence.
      const fresh = await cold.capability.fetch(genericWire('native-admission', { ...admission, operationId: 'native-uncertain-fresh' }));
      expect(fresh.status).toBe(200);
      const freshHandle = (await fresh.json() as { handle: string }).handle;
      const freshRequest = request(); freshRequest.headers.set('x-codeflare-native-inference', freshHandle);
      expect((await cold.capability.fetch(freshRequest)).status).toBe(409);
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await cold.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
        result: { repository: 'another/service', results: [] } })).toMatchObject({ ok: false });
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      // A globally uncertain drive is stricter than an operation-local unknown:
      // after reconstruction neither old nor fresh native work regains authority.
      expect(await cold.activity.interruptDrive(1)).toMatchObject({ ok: true });
      const fenced = await coldOwner(cold);
      for (const protectedRequest of [genericWire('native-binding', { profileDigest: selected.profileDigest }),
        genericWire('native-admission', admission), genericWire('native-admission', {
          ...admission, operationId: 'native-after-global-uncertainty' }), request(),
        genericWire('native-result', { handle, outcome: 'failed' })]) {
        expect((await fenced.capability.fetch(protectedRequest)).status).toBe(403);
      }
      expect(await fenced.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(f.sent.filter(request => request.url === nativeProviderUrl)).toHaveLength(1);
    }, { repositoryOnly: true, recovery: true, intent4: false, facetContract: true, nativeInference: true,
      sourceTransport: async request => {
        if (request.url !== nativeProviderUrl) return Response.json({ ok: true });
        if (failure === 'unknown') throw new Error('Synthetic provider lost response');
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('partial native bytes'));
        }, pull(controller) { controller.error(new Error('Synthetic provider truncated response')); } }),
        { headers: { 'content-type': 'text/event-stream' } });
      } }));

  it.each(['binding', 'send'] as const)(
    'REQ-OPERATOR-047: expired cached native %s stops with logging OFF and survives cold reconstruction despite updated saved auth', boundary => fixture(async f => {
      await start(f, 20_000);
      const selected = JSON.parse((await f.loaderEnv()).OPERATOR_INFERENCE_SELECTION as string);
      // Saved-profile fixture input: only auth expiry changes, not the admitted selection or lease.
      nativeProfileFiles.set('/owner-bucket/.pi/agent/auth.json', { 'openai-codex': { type: 'oauth',
        access: 'synthetic-native-access', refresh: 'synthetic-native-refresh', accountId: 'synthetic-account', expires: Date.now() + 1_000 } });
      const bindingRequest = () => genericWire('native-binding', { profileDigest: selected.profileDigest });
      const binding = await f.capability.fetch(bindingRequest());
      expect(binding.status).toBe(200);
      const bound = await binding.json() as { auth: { apiKey: string }; expiresAt: number };
      const admitted = await f.capability.fetch(genericWire('native-admission', {
        operationId: 'native-expiring', profileDigest: selected.profileDigest }));
      expect(admitted.status).toBe(200);
      const { handle } = await admitted.json() as { handle: string };
      const request = () => new Request(nativeProviderUrl, { method: 'POST', headers: {
        'content-type': 'application/json', authorization: `Bearer ${bound.auth.apiKey}`,
        'chatgpt-account-id': 'synthetic-account', 'x-codeflare-native-inference': handle }, body: nativeBody });
      f.advanceClock(2_000);
      expect(bound.expiresAt).toBeLessThanOrEqual(Date.now());
      nativeProfileFiles.set('/owner-bucket/.pi/agent/auth.json', { 'openai-codex': { type: 'oauth',
        access: 'synthetic-replacement-access', refresh: 'synthetic-replacement-refresh', accountId: 'synthetic-account', expires: Date.now() + 120_000 } });
      const expired = await f.capability.fetch(boundary === 'binding' ? bindingRequest() : request());
      expect(expired.status).toBe(403);
      const authFailure = { code: 'PI_LOGIN_REQUIRED', provider: 'openai-codex', reason: 'expired' };
      expect(await expired.json()).toEqual({ authFailure });
      expect(await f.activity.getBrowserDetail()).toMatchObject({ authFailure });
      const cold = await coldOwner(f);
      for (const protectedRequest of [bindingRequest(), request(), genericWire('native-admission', {
        operationId: 'native-after-expiry', profileDigest: selected.profileDigest })]) {
        const stopped = await cold.capability.fetch(protectedRequest);
        expect(stopped.status).toBe(403);
        expect(await stopped.json()).toEqual({ authFailure });
      }
      expect((await cold.capability.fetch(genericWire('native-result', { handle, outcome: 'failed' }))).status).toBe(403);
      expect(await cold.activity.getBrowserDetail()).toMatchObject({ authFailure });
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(f.sent.filter(request => request.url === nativeProviderUrl)).toHaveLength(0);
    }, { repositoryOnly: true, recovery: true, intent4: false, facetContract: true, nativeInference: true, loggingEnabled: false,
      sourceTransport: async () => Response.json({ ok: true }) }));

  it('REQ-OPERATOR-007/047: unsupported native recovery protocol refuses without managed substitution', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true, state: { status: 'unknown' } });
    expect(f.childSubmissions).toEqual([]);
    expect(f.sent.filter(request => new URL(request.url).hostname === 'gateway.ai.cloudflare.com'
      || new URL(request.url).hostname === 'chatgpt.com')).toEqual([]);
  }, { repositoryOnly: true, recovery: false, intent4: false, facetContract: true, nativeInference: true }));

  it('REQ-OPERATOR-047/048: native response commits before delivery, replays after reconstruction, and rejects stale or late outcomes', async () => {
    const providerUrl = 'https://chatgpt.com/backend-api/codex/responses';
    const raw = new TextEncoder().encode('event: response.completed\r\ndata: {"type":"response.completed","response":{"id":"native-one","status":"completed","output_text":"✓"}}\r\n\r\n');
    let holdNativeResponse = false;
    let release!: () => void;
    const complete = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const sending = new Promise<void>(resolve => { entered = resolve; });
    await fixture(async f => {
      try {
        await start(f);
        const stamp = await context(f);
        const loaded = await f.loaderEnv();
        // The fallback descriptor only lets the old managed-only baseline reach
        // the missing application endpoint assertion, not an import/JSON error.
        const selected = typeof loaded.OPERATOR_INFERENCE_SELECTION === 'string'
          ? JSON.parse(loaded.OPERATOR_INFERENCE_SELECTION) : { profileDigest: '9'.repeat(64) };
        const binding = await f.capability.fetch(wire('native-binding', { profileDigest: selected.profileDigest }, stamp.deliveryToken));
        expect(binding.status).toBe(200);
        const bound = await binding.json() as { selection: Record<string, unknown>; auth: { apiKey: string }; expiresAt: number | null };
        expect(bound.selection).toMatchObject({ source: 'pi-native', provider: 'openai-codex', model: 'gpt-6.1-sol',
          api: 'openai-codex-responses', reasoningLevel: 'low', profileDigest: selected.profileDigest });
        expect(JSON.parse(loaded.OPERATOR_INFERENCE_SELECTION as string)).toEqual(bound.selection);
        expect(bound.auth.apiKey).toBe('synthetic-native-access');
        expect(bound.expiresAt).toEqual(expect.any(Number));
        // Inspect every declared metadata value, not the opaque RPC implementation.
        const descriptor = { ...loaded };
        delete descriptor.OPERATOR;
        expect(JSON.stringify(descriptor)).not.toMatch(/synthetic-native-access|synthetic-native-refresh|synthetic-scoped/);
        const anchor = await f.capability.fetch(wire('source', { operationId: 'native-budget-anchor',
          url: 'https://api.github.com/repos/another/service' }, stamp.deliveryToken));
        expect(anchor.status).toBe(200);
        const budget = () => receipt(f, 'native-budget-anchor', stamp.deliveryToken);
        expect(await budget()).toMatchObject({ operationCount: 1 });
        const admission = { operationId: 'native-logical-operation', profileDigest: selected.profileDigest };
        const admitted = await f.capability.fetch(wire('native-admission', admission, stamp.deliveryToken));
        expect(admitted.status).toBe(200);
        const { handle } = await admitted.json() as { handle: string };
        expect(handle).toEqual(expect.any(String));
        expect(handle.length).toBeGreaterThan(0);
        expect(f.sent.filter(request => request.url === providerUrl)).toHaveLength(0); // Admission is not a physical send.
        const body = JSON.stringify({ model: 'gpt-6.1-sol', instructions: 'Approved synthetic operator',
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Inspect approved input' }] }],
          reasoning: { effort: 'low' }, stream: true, store: false });
        const request = (transportHandle = handle, content = body) => new Request(providerUrl, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${bound.auth.apiKey}`,
            'chatgpt-account-id': 'synthetic-account', 'x-codeflare-native-inference': transportHandle }, body: content });
        expect((await f.capability.fetch(request('invalid-native-handle'))).status).toBe(403);
        expect(f.sent.filter(request => request.url === providerUrl)).toHaveLength(0);
        holdNativeResponse = true;
        let delivered = false;
        const first = f.capability.fetch(request()).then(response => { delivered = true; return response; });
        await Promise.race([sending, first.then(() => { throw new Error('Native response escaped before transport commitment'); })]);
        const duplicate = f.capability.fetch(request());
        expect((await f.capability.fetch(request(handle, body.replace('Inspect approved input', 'Changed input')))).status).toBe(409);
        expect(await budget()).toMatchObject({ operationCount: 2 });
        expect(delivered).toBe(false); // Incomplete transport bytes cannot escape the durable commit.
        release();
        for (const response of await Promise.all([first, duplicate])) {
          expect(response.status).toBe(201);
          expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
          expect(response.headers.get('x-request-id')).toBe('native-request-one');
          expect(response.headers.get('set-cookie')).toBeNull();
          expect(new Uint8Array(await response.arrayBuffer())).toEqual(raw);
        }
        const sent = f.sent.filter(request => request.url === providerUrl);
        expect(sent).toHaveLength(1);
        expect(sent[0].headers.get('x-codeflare-native-inference')).toBeNull();
        expect(sent[0].headers.get('authorization')).toBe('Bearer synthetic-native-access');
        expect(sent[0].headers.get('chatgpt-account-id')).toBe('synthetic-account');
        expect(await sent[0].clone().text()).toBe(body);
        expect((await f.capability.fetch(wire('native-result', { handle, outcome: 'completed' }, stamp.deliveryToken))).status).toBe(200);
        expect(await context(f)).toEqual(stamp); // SDK outcome is not Flue phase settlement.
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        const cold = await coldOwner(f);
        const reAdmitted = await cold.capability.fetch(wire('native-admission', admission, stamp.deliveryToken));
        expect(reAdmitted.status).toBe(200);
        const retained = await reAdmitted.json() as { handle: string };
        const replay = await cold.capability.fetch(request(retained.handle));
        expect(replay.status).toBe(201);
        expect(replay.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
        expect(replay.headers.get('x-request-id')).toBe('native-request-one');
        expect(replay.headers.get('set-cookie')).toBeNull();
        expect(new Uint8Array(await replay.arrayBuffer())).toEqual(raw);
        expect(await receipt(cold, 'native-budget-anchor', stamp.deliveryToken)).toMatchObject({ operationCount: 2 });
        const freshOperation = await cold.capability.fetch(wire('native-admission', {
          ...admission, operationId: 'native-fresh-label-same-wire' }, stamp.deliveryToken));
        expect(freshOperation.status).toBe(200);
        const freshHandle = (await freshOperation.json() as { handle: string }).handle;
        const conflict = await cold.capability.fetch(request(freshHandle));
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'OPERATOR_OPERATION_CONFLICT' });
        expect((await cold.capability.fetch(wire('native-result', { handle: freshHandle, outcome: 'completed' }, stamp.deliveryToken))).status).toBe(403);
        expect(f.sent.filter(request => request.url === providerUrl)).toHaveLength(1);
        for (const stale of [wire('native-binding', { profileDigest: selected.profileDigest }, stamp.deliveryToken),
          wire('native-admission', admission, stamp.deliveryToken), request(retained.handle)]) {
          expect((await cold.staleCapability.fetch(stale)).status).toBe(403);
        }
        expect(JSON.stringify(await cold.activity.getRuntimePlan())).not.toMatch(/synthetic-native-access|synthetic-native-refresh|synthetic-scoped/);
        expect(await cold.activity.cancelDrive()).toMatchObject({ ok: true });
        const fenced = await cold.activity.getBrowserDetail();
        expect((await cold.capability.fetch(wire('native-result', { handle: retained.handle, outcome: 'completed' }, stamp.deliveryToken))).status).toBe(403);
        expect(await cold.activity.getBrowserDetail()).toEqual(fenced);
        expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(f.sent.filter(request => request.url === providerUrl)).toHaveLength(1);
      } finally { release(); }
    }, { repositoryOnly: true, recovery: true, intent4: true, facetContract: true, nativeInference: true,
      sourceTransport: async request => request.url !== providerUrl ? Response.json({ ok: true })
        : new Response(holdNativeResponse ? new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(raw.slice(0, 23)); entered();
        void complete.then(() => { controller.enqueue(raw.slice(23)); controller.close(); });
      } }) : raw, { status: 201, headers: { 'content-type': 'text/event-stream; charset=utf-8',
        'x-request-id': 'native-request-one', 'set-cookie': 'synthetic-private-cookie' } }) });
  });

  it.each([401, 403])('REQ-OPERATOR-047: native auth rejection crosses real egress and persists safe recovery with logging OFF (HTTP %s)', async status => {
    const providerUrl = 'https://chatgpt.com/backend-api/codex/responses';
    await fixture(async f => {
      await start(f);
      const stamp = await context(f);
      const loaded = await f.loaderEnv();
      expect(typeof loaded.OPERATOR_INFERENCE_SELECTION).toBe('string');
      const selected = JSON.parse(loaded.OPERATOR_INFERENCE_SELECTION as string);
      const binding = await f.capability.fetch(wire('native-binding', { profileDigest: selected.profileDigest }, stamp.deliveryToken));
      expect(binding.status).toBe(200);
      const bound = await binding.json() as { auth: { apiKey: string } };
      const admitted = await f.capability.fetch(wire('native-admission', {
        operationId: 'native-auth-rejection', profileDigest: selected.profileDigest }, stamp.deliveryToken));
      expect(admitted.status).toBe(200);
      const { handle } = await admitted.json() as { handle: string };
      const response = await f.capability.fetch(new Request(providerUrl, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bound.auth.apiKey}`,
          'chatgpt-account-id': 'synthetic-account', 'x-codeflare-native-inference': handle },
        body: JSON.stringify({ model: 'gpt-6.1-sol', input: [], reasoning: { effort: 'low' }, stream: true }) }));
      expect(response.status).toBe(status);
      const value = await response.json();
      const authFailure = { code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider: 'openai-codex' };
      expect(value).toMatchObject({ authFailure });
      expect(JSON.stringify(value)).not.toMatch(/synthetic-native-access|synthetic-native-refresh|private-upstream-detail/);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ authFailure });
      expect((await f.capability.fetch(wire('native-binding', {
        profileDigest: selected.profileDigest }, stamp.deliveryToken))).status).toBe(403);
      expect(JSON.stringify(await f.activity.getRuntimePlan())).not.toMatch(/synthetic-native-access|synthetic-native-refresh/);
      expect(f.sent.filter(request => request.url === providerUrl)).toHaveLength(1);
      nativeProfileFiles.set('/owner-bucket/.pi/agent/auth.json', { 'openai-codex': { type: 'oauth',
        access: 'synthetic-replacement-access', refresh: 'synthetic-replacement-refresh',
        accountId: 'synthetic-account', expires: Date.now() + 120_000 } });
      const cold = await coldOwner(f);
      const stopped = await cold.capability.fetch(wire('native-binding', { profileDigest: selected.profileDigest }, stamp.deliveryToken));
      expect(stopped.status).toBe(403);
      expect(await stopped.json()).toEqual({ authFailure });
      expect((await cold.capability.fetch(wire('native-admission', {
        operationId: 'native-after-auth-rejection', profileDigest: selected.profileDigest }, stamp.deliveryToken))).status).toBe(403);
      expect(await cold.activity.getBrowserDetail()).toMatchObject({ authFailure });
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(f.sent.filter(request => request.url === providerUrl)).toHaveLength(1);
    }, { repositoryOnly: true, recovery: true, intent4: true, facetContract: true, nativeInference: true, loggingEnabled: false,
      sourceTransport: async request => request.url !== providerUrl ? Response.json({ ok: true })
        : Response.json({ error: { code: 'invalid_api_key', message: 'private-upstream-detail synthetic-native-access' } }, { status }) });
  });

  it.each([{ phase: 'discovery', validated: false }, { phase: 'target', validated: false },
    { phase: 'discovery', validated: true }, { phase: 'target', validated: true }])(
    'REQ-OPERATOR-078: AC1 verified $phase delivery binds preparation cause (validated=$validated); REQ-OPERATOR-081 AC2/4/5',
    ({ phase, validated }) => fixture(async f => {
      await start(f); if (phase === 'target') await discovery(f);
      const stamp = await context(f);
      const body = { operationId: 'current-preparation', input: { messages: validated ? [{ role: 'user', content: 'PRIVATE_PROMPT' }] : [] } };
      const response = await f.capability.fetch(wire('inference', body, stamp.deliveryToken));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED', reason: validated ? 'policy-denied' : 'request-invalid', disposition: 'operation-local' });
      const failure = (await preparationFailures(f)).at(-1);
      expect(failure).toMatchObject({ generation: stamp.generation, preparation: { route: 'inference',
        step: validated ? 'capability' : 'parse', failureClass: validated ? 'authority-denied' : 'invalid-wire' } });
      expect(failure?.correlation).toEqual({ deliveryDigest: await digest(stamp.deliveryToken), submissionDigest: await digest(stamp.submissionId),
        ...(validated ? { requestDigest: await digest(JSON.stringify({ path: '/v1/dispatcher/inference', body })) } : {}) });
      // Existing receipt/phase context is the sole authority: no parallel phase/attempt labels.
      expect(await context(f)).toEqual(stamp);
      expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_|current-preparation|private\.jwt/);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, { repositoryOnly: true, intent4: true, capabilities: ['fetch'] }));

  it.each(['missing', 'spoofed', 'stale'] as const)(
    'REQ-OPERATOR-081: AC2/4/5 %s delivery cannot borrow current SDK attribution from a preparation refusal', tokenKind => fixture(async f => {
      await start(f); const original = await context(f);
      if (tokenKind === 'stale') await discovery(f);
      const current = await context(f);
      const request = tokenKind === 'missing' ? genericWire('inference', { input: { messages: [] } })
        : wire('inference', { input: { messages: [] } }, tokenKind === 'stale' ? original.deliveryToken : 'forged-delivery');
      const response = await f.capability.fetch(request);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'execution-inactive', disposition: 'authority-denied' });
      const failure = (await preparationFailures(f)).at(-1);
      expect(failure).toMatchObject({ owner: 'host', generation: 1, code: 'authority-denied' });
      expect(failure?.correlation).toEqual({});
      expect(failure?.preparation ?? {}).not.toHaveProperty('phaseKind');
      expect(failure?.preparation ?? {}).not.toHaveProperty('phaseIndex');
      expect(await context(f)).toEqual(current);
      const allowed = await f.capability.fetch(wire('source', { operationId: 'current-after-stale', url: 'https://api.github.com/repos/another/service' }, current.deliveryToken));
      expect(allowed.status).toBe(200);
      expect(await receipt(f, 'current-after-stale', current.deliveryToken)).toMatchObject({ phase: 'completed', operationCount: 1 });
    }, { repositoryOnly: true, intent4: true }));

  it('REQ-OPERATOR-081: AC2/4/5 phase transition during a gated preparation read never adopts the newer submission', () => fixture(async f => {
    await start(f); const original = await context(f);
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
    const body = new ReadableStream<Uint8Array>({ async pull(controller) {
      entered(); await released;
      controller.enqueue(new TextEncoder().encode('{"operationId":"gated-preparation","input":{"messages":[]}}'));
      controller.close();
    } }, { highWaterMark: 0 });
    const result = f.capability.fetch(new Request('https://operator.internal/v1/dispatcher/inference', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codeflare-dispatcher-delivery': original.deliveryToken }, body }));
    try {
      await within(reading, 'authorized preparation body read');
      await discovery(f); const successor = await context(f);
      expect(successor.submissionId).not.toBe(original.submissionId);
      release(); await invalidPreparationRefusal(await within(result, 'old-phase parse refusal'));
      const failure = (await preparationFailures(f)).at(-1);
      expect(failure).toMatchObject({ code: 'tool-failed', preparation: { step: 'parse', route: 'inference', failureClass: 'invalid-wire' } });
      expect(failure?.correlation).toEqual({});
      expect(await context(f)).toEqual(successor);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    } finally { release(); await within(result, 'gated preparation cleanup').catch(() => undefined); }
  }, { repositoryOnly: true, intent4: true }));

  const liveChildRead = async (f: DispatcherFixture) => {
    const readback = f.ownedChildReadbacks().at(-1);
    if (!readback) throw new Error('Fixture has no owned child stub');
    expect(await (await readback()).json()).toMatchObject({ conversationId: 'fixture-conversation' });
    return readback;
  };
  const noOwnedRuntimeRead = async (f: DispatcherFixture) => {
    // Probe every parent-created incarnation, without test-originated get().
    // A new callable stub would witness forbidden post-cancel recreation.
    for (const readback of f.ownedChildReadbacks()) await expect(readback()).rejects.toThrow();
  };
  const cancellationFences = async (f: DispatcherFixture, token: string, released = true) => {
    for (const request of protectedRequests(token)) await deny(await f.capability.fetch(request));
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
      result: finalResult(f) })).toMatchObject({ ok: false, reason: 'stale-drive' });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    // REQ-OPERATOR-027 AC8: known SDK release changes only cleanup reporting, never cancellation authority.
    expect(await f.activity.getBrowserDetail()).toMatchObject({ activityId: f.activityId,
      executionStatus: 'cancel-requested', cleanupStatus: released ? 'released' : 'stopping',
      sdkCleanupReleased: released, collectionStatus: 'unavailable', result: null });
  };

  it('REQ-OPERATOR-048: AC2 retiring an uncertain keyed admission invalidates its owned child without replacing original work', () => fixture(async f => {
  // REQ-OPERATOR-081: additive retained-evidence assertions; original anchor/title preserved.
    await start(f);
    const token = (await latestDelivery(f)).attributes.deliveryToken;
    const original = await liveChildRead(f);
    const remote = await f.readRemoteComments();
    expect(await f.activity.cancelDrive()).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
    await cancellationFences(f, token);
    await expect(original()).rejects.toThrow();
    await noOwnedRuntimeRead(f);
    expect(await f.readRemoteComments()).toEqual(remote);
    await retainedFence(f, 'cancelled', 'fence');
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'event', boundary: 'submission', code: 'submission-failed', evidence: 'observed',
    })]));
    await noOwnedRuntimeRead(f);
  }, { repositoryOnly: true, intent4: true, losePhaseAdmission: 1, facetContract: true }));

  it('REQ-OPERATOR-017: AC4 intent4 cancellation does not restart its retired owned runtime', () => fixture(async f => {
    await start(f);
    const stamp = await context(f);
    const original = await liveChildRead(f);
    expect(await f.activity.cancelDrive()).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
    await expect(original()).rejects.toThrow();
    await f.activity.getBrowserDetail();
    await f.activity.reconcileDispatcherLease();
    await cancellationFences(f, stamp.deliveryToken);
    await noOwnedRuntimeRead(f);
  }, { repositoryOnly: true, intent4: true, facetContract: true }));

  it('REQ-OPERATOR-017: AC4 pending intent4 preparation cannot recreate an owned runtime after cancellation', () => fixture(async f => {
    await start(f);
    const first = await context(f);
    await liveChildRead(f);
    const cold = await coldOwner(f);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    // The reconstructed parent's cache is empty while the original child
    // remains live; pause its actual external factory preparation.
    f.afterBundleRead(async () => { enter(); await held; });
    const preparation = cold.activity.reconcileDispatcherLease();
    try {
      await entered;
      expect(await cold.activity.cancelDrive()).toMatchObject({ ok: true, state: {
        generation: 2, status: 'cancel-requested',
      } });
    } finally { release(); }
    await preparation;
    await cancellationFences(cold, first.deliveryToken);
    await noOwnedRuntimeRead(cold);
  }, { repositoryOnly: true, intent4: true, facetContract: true }));

  it('REQ-OPERATOR-048: retirement cleanup finishes an already released cancelled generation without new authority', () => fixture(async f => {
    await start(f);
    const stamp = await context(f);
    const original = await liveChildRead(f);
    const remote = await f.readRemoteComments();
    await f.seedCancelledReleased();
    const cold = await coldOwner(f);
    await cold.activity.reconcileDispatcherLease();
    // Read-only reconstruction does not itself finish authorized cancellation.
    expect(await (await original()).json()).toMatchObject({ conversationId: 'fixture-conversation' });
    const cancelled = { ok: true, state: { generation: 2, status: 'cancel-requested' } };
    expect(await cold.activity.cancelDrive()).toMatchObject(cancelled);
    await cancellationFences(cold, stamp.deliveryToken);
    await expect(original()).rejects.toThrow();
    await noOwnedRuntimeRead(cold);
    expect(await cold.activity.cancelDrive()).toMatchObject(cancelled);
    await noOwnedRuntimeRead(cold);
    expect(await cold.readRemoteComments()).toEqual(remote);
  }, { repositoryOnly: true, intent4: true, facetContract: true }));

  it.each([false, true])('REQ-OPERATOR-048: failed owned-child retirement cannot reopen fenced work; bookkeeping released=%s', released => fixture(async f => {
    await start(f);
    const stamp = await context(f);
    const original = await liveChildRead(f);
    if (released) await f.seedCancelledReleased();
    f.failOwnedAbort();
    await expect(f.activity.cancelDrive()).rejects.toThrow();
    await cancellationFences(f, stamp.deliveryToken, released);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ sdkCleanupReleased: released });
    expect(await (await original()).json()).toMatchObject({ conversationId: 'fixture-conversation' });
    expect(await f.activity.cancelDrive()).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
    await cancellationFences(f, stamp.deliveryToken);
    await expect(original()).rejects.toThrow();
    await noOwnedRuntimeRead(f);
  }, { repositoryOnly: true, intent4: true, facetContract: true }));

  it('REQ-OPERATOR-048: AC7 historical unkeyed cancellation preserves SDK abort delivery and original fences', () => fixture(async f => {
    await start(f);
    const remote = await f.readRemoteComments();
    expect(await f.activity.cancelDrive()).toMatchObject({ ok: true, state: { generation: 2, status: 'cancel-requested' } });
    expect(f.abortStatus()).toBe('cancel-requested');
    expect((await f.capability.fetch(genericWire('source', { operationId: 'historical-cancelled-read',
      method: 'GET', url: 'https://api.github.com/repos/another/service/issues/17/comments' }))).status).toBe(403);
    expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'waiting', checkpoint: null }))
      .toMatchObject({ ok: false, reason: 'stale-drive' });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(await f.readRemoteComments()).toEqual(remote);
  }, { repositoryOnly: true, facetContract: true }));

  it.each([{ phase: 'discovery', lost: 1 }, { phase: 'target', lost: 2 }, { phase: 'final', lost: 4 }])(
    'REQ-OPERATOR-048: AC2 cold $phase lost acknowledgement adopts the exact original wire and collects its final settlement; REQ-OPERATOR-017 AC1/2',
    ({ lost }) => fixture(async f => {
      await start(f);
      const plan = (await f.activity.getRuntimePlan())!;
      const deadline = await deadlineSchedule(f);
      const lineage: Context[] = [];
      let completedReceipt: Awaited<ReturnType<typeof receipt>> | undefined;
      let commentResponse: unknown;
      const mutation = { operationId: 'cold-original-comment', method: 'POST',
        url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"Original cold judgment"}' };
      if (lost > 1) lineage.push(await discovery(f));
      if (lost === 4) {
        const first = await context(f); lineage.push(first);
        const posted = await f.capability.fetch(wire('source', mutation, first.deliveryToken));
        expect(posted.status).toBe(200); commentResponse = await posted.json();
        expect(commentResponse).toMatchObject({ status: 201, body: expect.any(String) });
        completedReceipt = await receipt(f, mutation.operationId, first.deliveryToken);
        expect(completedReceipt).toMatchObject({ phase: 'completed', method: 'POST', url: mutation.url });
        const replay = await f.capability.fetch(wire('source', mutation, first.deliveryToken));
        expect(replay.status).toBe(200); expect(await replay.json()).toEqual(commentResponse);
        progress(f, first, { kind: 'target', index: 1, target: frozen[1] }, { results: rows.slice(0, 1) });
        await f.activity.reconcileDispatcherLease();
        const second = await context(f); lineage.push(second);
        progress(f, second, { kind: 'final' }, { results: rows });
        await f.activity.reconcileDispatcherLease();
      }
      // No phase-context call may repair the uncertain phase before cold construction.
      const originalWire = await latestDelivery(f);
      const deliveriesBefore = f.childSubmissions.length;
      const cold = await coldOwner(f);
      expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null,
        collectionStatus: 'unavailable' });
      expect(await cold.activity.dispatcherGenerationCurrent(1)).toBe(true);
      expect(await cold.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-active' });
      // Intentional wire contract: replay bytes, key, token and UID are unchanged.
      const reattachments = await Promise.all(f.childSubmissions.slice(deliveriesBefore).map(request => request.clone().json()));
      expect(reattachments).toEqual([originalWire]);
      expect(await latestDelivery(cold)).toEqual(originalWire);
      const stamp = await context(cold, originalWire.attributes.deliveryToken);
      expect(stamp).toMatchObject({ generation: 1, submissionId: `submission-${lost}`,
        deliveryToken: originalWire.attributes.deliveryToken, releaseDigest: f.artifactDigest,
        authorityDigest: await digest(JSON.stringify(plan.receipt)), deadline: new Date(plan.deadline).toISOString() });
      expect(stamp.phase.kind).toBe(lost === 1 ? 'discovery' : lost === 2 ? 'target' : 'final');
      if (lineage.length) {
        expect(stamp.authorityDigest).toBe(lineage[0].authorityDigest);
        expect(stamp.previous).toEqual(lineage.map(prior => ({ submissionId: prior.submissionId, phase: prior.phase, outcome: 'completed' })));
      }
      expect(originalWire.uid).toBe(lost === 1 ? null : 'fixture-incarnation');
      expect(await context(cold)).toEqual(stamp);
      expect(await cold.activity.getRuntimePlan()).toMatchObject({ deadline: plan.deadline, invocationJson: plan.invocationJson,
        executionContext: { artifactDigest: plan.executionContext.artifactDigest } });
      expect((await deadlineSchedule(cold)).time).toBe(deadline.time);
      const pendingHistory = [...f.childSubmissions];
      f.messages([]); f.settle('foreign-submission');
      await cold.activity.reconcileDispatcherLease();
      expect(await context(cold)).toEqual(stamp);
      expect(f.childSubmissions).toEqual(pendingHistory);
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      if (completedReceipt) {
        expect(await receipt(cold, mutation.operationId, stamp.deliveryToken)).toEqual(completedReceipt);
        expect(await f.readRemoteComments()).toEqual([{ id: 91, body: 'Original cold judgment', user: { id: 42 } }]);
        for (const prior of lineage) await deny(await f.capability.fetch(wire('source', mutation, prior.deliveryToken)));
        expect(await context(cold)).toEqual(stamp);
      }
      await finish(cold);
      expect((await latestDelivery(cold)).uid).toBe('fixture-incarnation');
      const terminalHistory = [...f.childSubmissions];
      await cold.activity.collectBrowserResult(); await cold.activity.reconcileDispatcherLease();
      expect(f.childSubmissions).toEqual(terminalHistory);
      expect(await f.readRemoteComments()).toEqual(lost === 4
        ? [{ id: 91, body: 'Original cold judgment', user: { id: 42 } }] : []);
    }, { repositoryOnly: true, intent4: true, losePhaseAdmission: lost, loggingEnabled: false }));

  it('REQ-OPERATOR-048: AC2 cold before-POST uncertainty admits original-generation discovery with unchanged input release and human expiry', () => fixture(async f => {
    const plan = (await f.activity.getRuntimePlan())!;
    // First authorization is before lease persistence; the next is phase admission
    // before POST. This one-shot collaborator fault exposes no unseen key/token.
    f.afterRegistryResolve(async () => {
      f.afterRegistryResolve(async () => { throw new Error('Fixture pre-POST authorization unavailable'); });
    });
    await start(f);
    expect(f.childSubmissions).toEqual([]);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    const deadline = await deadlineSchedule(f);
    const cold = { ...f, activity: f.restart() };
    await f.drainBackground();
    const diagnostic = await cold.activity.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(diagnostic).toMatchObject({ version: 1, consistency: 'stable-binding',
      parent: { executionStatus: 'running', lease: { generation: 1, status: 'admitting', receiptPresent: false } },
      sdk: { status: 'unavailable', reason: 'unbound' } });
    await f.drainBackground();
    expect(f.childSubmissions).toEqual([]);
    // The first ordinary owner entry still recovers before a phase-context request.
    await cold.activity.getAdmission();
    await f.drainBackground();
    expect(f.childSubmissions).toHaveLength(1);
    expect(await cold.activity.dispatcherGenerationCurrent(1)).toBe(true);
    const delivered = await latestDelivery(cold);
    expect(delivered.uid).toBeNull();
    const stamp = await context(cold);
    expect(stamp).toMatchObject({ generation: 1, phase: { kind: 'discovery' }, submissionId: 'submission-1',
      releaseDigest: f.artifactDigest, authorityDigest: await digest(JSON.stringify(plan.receipt)),
      deadline: new Date(plan.deadline).toISOString(), deliveryToken: delivered.attributes.deliveryToken });
    const privateMetadata = 'PRIVATE_SDK_DIAGNOSTIC_VALUE';
    const attemptId = `${privateMetadata}-attempt`;
    const timestamp = new Date().toISOString();
    // SDK-shaped fixture storage exercises the fixed SQLite read, not hosted SDK RPC or cold-child qualification.
    await f.mutateEvidence(async storage => {
      storage.sql.exec(`CREATE TABLE flue_agent_submissions (submission_id TEXT PRIMARY KEY, session_key TEXT,
        status TEXT, sequence INTEGER, attempt_count INTEGER, max_attempts INTEGER, accepted_at INTEGER,
        canonical_ready_at INTEGER, input_applied_at INTEGER, abort_requested_at INTEGER, started_at INTEGER,
        settled_at INTEGER, timeout_at INTEGER, lease_expires_at INTEGER, attempt_id TEXT, owner_id TEXT,
        joined_into TEXT, error TEXT, settlement_record_id TEXT, settlement_record TEXT)`);
      storage.sql.exec(`CREATE TABLE flue_conversation_streams (path TEXT PRIMARY KEY, identity_json TEXT,
        incarnation TEXT, next_offset INTEGER, producer_epoch INTEGER, next_producer_sequence INTEGER, producer_id TEXT)`);
      storage.sql.exec(`CREATE TABLE flue_conversation_stream_batches (path TEXT, seq INTEGER, data TEXT,
        submission_id TEXT, attempt_id TEXT, PRIMARY KEY (path, seq))`);
      const acceptedAt = Date.now();
      storage.sql.exec(`INSERT INTO flue_agent_submissions (submission_id, session_key, status, sequence,
        attempt_count, max_attempts, accepted_at, canonical_ready_at, input_applied_at, started_at,
        lease_expires_at, attempt_id, owner_id) VALUES (?, ?, 'running', 1, 1, 1024, ?, ?, ?, ?, ?, ?, ?)`,
      stamp.submissionId, 'agent-session:["Dispatcher","dispatcher"]', acceptedAt, acceptedAt, acceptedAt,
      acceptedAt, plan.deadline, attemptId, privateMetadata);
      storage.sql.exec(`INSERT INTO flue_conversation_streams VALUES
        ('fixture-stream', ?, 'fixture-stream-incarnation', 1, 1, 1, ?)`,
      JSON.stringify({ agentName: 'Dispatcher', instanceId: 'dispatcher' }), privateMetadata);
      storage.sql.exec(`INSERT INTO flue_conversation_stream_batches VALUES ('fixture-stream', 0, ?, ?, ?)`,
      JSON.stringify([
        { type: 'conversation_created', kind: 'root', uid: 'fixture-incarnation' },
        { type: 'assistant_tool_call', timestamp, id: `${privateMetadata}-call-record`,
          submissionId: stamp.submissionId, attemptId, toolCallId: `${privateMetadata}-call`,
          toolName: `${privateMetadata}-tool`, arguments: { content: privateMetadata } },
        { type: 'tool_outcome', timestamp, id: `${privateMetadata}-outcome-record`,
          submissionId: stamp.submissionId, attemptId, toolCallId: `${privateMetadata}-call`,
          toolName: `${privateMetadata}-tool`, data: { content: privateMetadata }, isError: false },
      ]), stamp.submissionId, attemptId);
    });
    const boundDiagnostic = await cold.activity.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(boundDiagnostic).toMatchObject({ consistency: 'stable-binding',
      parent: { resultPresent: false, checkpointPresent: false,
        lease: { generation: 1, status: 'running', receiptPresent: true, submissionDigest: await digest(stamp.submissionId) } },
      sdk: { status: 'available', submission: { status: 'running', attemptCount: 1, maxAttempts: 1024,
        attemptDigest: await digest(attemptId), ownerPresent: true, errorPresent: false, settlementRecordPresent: false },
      stream: { nextOffset: 1, producerPresent: true }, canonical: { scope: 'latest-instance-batches',
        contentRecordsExcluded: true, inlineMetadataComplete: true,
        batches: [{ sequence: 0, submissionDigest: await digest(stamp.submissionId), attemptDigest: await digest(attemptId) }],
        records: [
          { type: 'assistant_tool_call', scope: 'requested', toolCallDigest: await digest(`${privateMetadata}-call`),
            nameDigest: await digest(`${privateMetadata}-tool`) },
          { type: 'tool_outcome', scope: 'requested', dataPresent: true, error: false,
            toolCallDigest: await digest(`${privateMetadata}-call`), nameDigest: await digest(`${privateMetadata}-tool`) },
        ] } } });
    expect(JSON.stringify(boundDiagnostic)).not.toContain(privateMetadata);
    expect(JSON.stringify(boundDiagnostic)).not.toContain('fixture-incarnation');
    expect(stamp.previous).toBeUndefined();
    expect(await context(cold)).toEqual(stamp);
    expect(await latestDelivery(cold)).toEqual(delivered);
    expect((await deadlineSchedule(cold)).time).toBe(deadline.time);
    expect(await cold.activity.getRuntimePlan()).toMatchObject({ invocationJson: plan.invocationJson, deadline: plan.deadline });
    expect(await cold.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-active' });
    await finish(cold);
    expect(await f.readRemoteComments()).toEqual([]);
  }, { repositoryOnly: true, intent4: true, loggingEnabled: false, runtimeVersion: '2.2.2' }));

  it.each(['pending', 'unavailable'] as const)(
    'REQ-OPERATOR-048: AC3 cold recovered %s observations retain one bounded wake and consume only exact settlement without renewing expiry', mode => fixture(async f => {
      await start(f);
      const originalWire = await latestDelivery(f);
      const deadline = await deadlineSchedule(f);
      if (mode === 'unavailable') f.statusFault(() => { throw new Error('Fixture unavailable cold observation'); });
      const cold = await coldOwner(f);
      const stamp = await context(cold, originalWire.attributes.deliveryToken);
      const history = [...f.childSubmissions];
      let now = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      for (let alarm = 0; alarm < 3; alarm++) {
        const next = await f.nextAlarm();
        expect(next).not.toBeNull();
        expect(next!).toBeLessThan(deadline.time * 1000);
        now = Math.max(now + 1000, next! + 1000);
        if (mode === 'unavailable') f.statusFault(() => { throw new Error('Fixture repeated unavailable observation'); });
        await cold.activity.alarm(); await f.drainBackground();
        expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null, collectionStatus: 'unavailable' });
        expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(await context(cold)).toEqual(stamp);
        expect(f.childSubmissions).toEqual(history);
        const schedules = (await cold.activity.listSchedules()).filter(row => row.callback === 'reconcileDispatcherLease');
        expect(schedules.filter(row => row.type === 'scheduled').map(row => row.time)).toEqual([deadline.time]);
        const wakes = schedules.filter(row => row.type === 'delayed');
        expect(wakes).toHaveLength(1);
        expect(wakes[0].time * 1000).toBeGreaterThan(now);
        expect(wakes[0].time).toBeLessThan(deadline.time);
      }
      f.messages([]); f.settle('foreign-settlement'); await cold.activity.reconcileDispatcherLease();
      expect(await context(cold)).toEqual(stamp); expect(f.childSubmissions).toEqual(history);
      await finish(cold);
      expect(await f.readRemoteComments()).toEqual([]);
    }, { repositoryOnly: true, intent4: true, losePhaseAdmission: 1, loggingEnabled: false }));

  it('REQ-OPERATOR-048: AC3 recovered cold pending lease expires at its original deadline; REQ-OPERATOR-017 AC6 late begin and commit deny', () => fixture(async f => {
    await start(f); const originalWire = await latestDelivery(f);
    const deadline = await deadlineSchedule(f);
    const cold = await coldOwner(f); const stamp = await context(cold);
    expect(stamp.deadline).toBe(new Date(deadline.time * 1000).toISOString());
    const history = [...f.childSubmissions];
    vi.spyOn(Date, 'now').mockReturnValue(deadline.time * 1000);
    await cold.activity.alarm(); await f.drainBackground();
    expect(await cold.activity.dispatcherGenerationCurrent(1)).toBe(false);
    expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null, collectionStatus: 'unavailable' });
    for (const request of protectedRequests(originalWire.attributes.deliveryToken)) await deny(await f.capability.fetch(request));
    for (const request of protectedRequests(originalWire.attributes.deliveryToken)) await deny(await cold.activity.dispatcherOperation(1, request));
    f.messages([{ submissionId: stamp.submissionId, parts: [{ type: 'data-assessment', data: finalResult(f) }] }]);
    f.settle(stamp.submissionId); await cold.activity.reconcileDispatcherLease();
    expect(await cold.activity.beginDrive()).toEqual({ ok: false, reason: 'authority-expired' });
    expect(await cold.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null, result: finalResult(f) }))
      .toEqual({ ok: false, reason: 'authority-expired' });
    expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(f.childSubmissions).toEqual(history);
    expect(await f.readRemoteComments()).toEqual([]);
    expect(f.sent.filter(request => request.method !== 'GET')).toEqual([]);
  }, { repositoryOnly: true, intent4: true, losePhaseAdmission: 1, loggingEnabled: false }));

  it.each(['expired', 'exact-deadline', 'expiry-during-authorization', 'installation-revoked', 'invoker-removed',
    'session-revoked', 'registration-revoked', 'cancelled', 'cancel-during-authorization', 'inputDigest', 'artifactDigest'] as const)(
    'REQ-OPERATOR-048: AC5 cold keyed attachment cannot cross %s fence; REQ-OPERATOR-017 AC4/5/6 no late result', boundary => fixture(async f => {
      await start(f);
      const originalWire = await latestDelivery(f);
      const deadline = await deadlineSchedule(f);
      const history = [...f.childSubmissions];
      if (boundary === 'expired') f.expire();
      else if (boundary === 'exact-deadline') vi.spyOn(Date, 'now').mockReturnValue(deadline.time * 1000);
      else if (boundary === 'expiry-during-authorization') f.afterRegistryResolve(async () => { f.expire(); });
      else if (boundary === 'installation-revoked') f.revoke();
      else if (boundary === 'invoker-removed') f.revokeGrant();
      else if (boundary === 'session-revoked') f.revokeSession();
      else if (boundary === 'registration-revoked') f.changeRegistration(null);
      else if (boundary === 'cancelled') await f.activity.cancelDrive();
      else if (boundary === 'cancel-during-authorization') f.afterRegistryResolve(async () => { await f.activity.cancelDrive(); });
      else await f.changeRetiredPin(boundary);
      const cold = await coldOwner(f);
      // Authorization can leave an admitting lease for a bounded retry. AC5 is
      // deny-only for revocation; do not invent an immediate unknown-state contract.
      await deny(await f.capability.fetch(wire('phase-context',
        { deliveryToken: originalWire.attributes.deliveryToken }, originalWire.attributes.deliveryToken)));
      for (const request of protectedRequests(originalWire.attributes.deliveryToken)) await deny(await f.capability.fetch(request));
      await cold.activity.reconcileDispatcherLease({ generation: 1 });
      await cold.activity.alarm(); await f.drainBackground();
      f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: finalResult(f) }] }]);
      f.settle(); await cold.activity.reconcileDispatcherLease();
      const late = await cold.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null, result: finalResult(f) });
      expect(late.ok).toBe(false);
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await cold.activity.getBrowserDetail()).toMatchObject({ result: null, collectionStatus: 'unavailable' });
      if (boundary === 'cancelled' || boundary === 'cancel-during-authorization') {
        expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested' });
        expect(late).toEqual({ ok: false, reason: 'stale-drive' });
      } else if (['expired', 'exact-deadline', 'expiry-during-authorization', 'inputDigest', 'artifactDigest'].includes(boundary)) {
        expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown' });
        expect(await cold.activity.dispatcherGenerationCurrent(1)).toBe(false);
      }
      if (['expired', 'exact-deadline', 'expiry-during-authorization'].includes(boundary)) {
        expect(await cold.activity.beginDrive()).toEqual({ ok: false, reason: 'authority-expired' });
        expect(late).toEqual({ ok: false, reason: 'authority-expired' });
      }
      const schedules = (await cold.activity.listSchedules()).filter(row => row.callback === 'reconcileDispatcherLease');
      expect(schedules.every(row => row.time <= deadline.time)).toBe(true);
      expect(f.childSubmissions).toEqual(history);
      expect(f.sent.filter(request => request.method !== 'GET')).toEqual([]);
      expect(await f.readRemoteComments()).toEqual([]);
    }, { repositoryOnly: true, intent4: true, losePhaseAdmission: 1, loggingEnabled: false,
      ...(boundary === 'session-revoked' || boundary === 'registration-revoked' ? { prospective: true } : {}) }));

  it.each([true, false])(
    'REQ-OPERATOR-048: AC2 cold final recovery never replays or clears an unknown comment and requires exact deferred coverage=%s; REQ-OPERATOR-017 AC4', covered => fixture(async f => {
      await start(f); await discovery(f);
      const first = await context(f);
      const mutation = { operationId: 'cold-unknown-original-comment', method: 'POST',
        url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"Uncertain cold judgment"}' };
      f.loseResponse();
      const unknown = await f.capability.fetch(wire('source', mutation, first.deliveryToken));
      expect(unknown.status).toBe(409); expect(await unknown.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      f.restoreTransport();
      const originalReceipt = await receipt(f, mutation.operationId, first.deliveryToken);
      expect(originalReceipt).toMatchObject({ phase: 'unknown', method: 'POST', url: mutation.url });
      const retry = await f.capability.fetch(wire('source', mutation, first.deliveryToken));
      expect(retry.status).toBe(409); expect(await retry.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      const resultRows = [{ ...frozen[0], outcome: 'DEFERRED', reason: 'comment-uncertain' }, rows[1]];
      progress(f, first, { kind: 'target', index: 1, target: frozen[1] }, { results: resultRows.slice(0, 1) });
      await f.activity.reconcileDispatcherLease();
      const second = await context(f);
      progress(f, second, { kind: 'final' }, { results: resultRows });
      await f.activity.reconcileDispatcherLease();
      const originalWire = await latestDelivery(f);
      const deliveriesBefore = f.childSubmissions.length;
      const cold = await coldOwner(f);
      expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      expect(await Promise.all(f.childSubmissions.slice(deliveriesBefore).map(request => request.clone().json())))
        .toEqual([originalWire]);
      expect(await latestDelivery(cold)).toEqual(originalWire);
      const final = await context(cold);
      expect(final).toMatchObject({ phase: { kind: 'final' }, submissionId: 'submission-4', generation: first.generation,
        deadline: first.deadline, releaseDigest: first.releaseDigest, authorityDigest: first.authorityDigest });
      expect(await receipt(cold, mutation.operationId, final.deliveryToken)).toEqual(originalReceipt);
      expect(await f.readRemoteComments()).toEqual([{ id: 91, body: 'Uncertain cold judgment', user: { id: 42 } }]);
      await deny(await f.capability.fetch(wire('source', mutation, first.deliveryToken)));
      expect(await context(cold)).toEqual(final);
      const history = [...f.childSubmissions];
      // A changed final disposition conflicts with witnessed progress and must not
      // make the unknown mutation definite or grant a replacement generation.
      const result = finalResult(f, covered ? resultRows : rows);
      f.messages([{ submissionId: final.submissionId, parts: [{ type: 'data-assessment', data: result }] }]);
      f.settle(final.submissionId); await cold.activity.reconcileDispatcherLease();
      if (covered) {
        const collected = await cold.activity.collectBrowserResult();
        expect(collected).toMatchObject({ ok: true, detail: { result } });
        expect(stableCollection(await cold.activity.collectBrowserResult())).toEqual(stableCollection(collected));
      } else {
        expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
      }
      expect(await cold.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
      expect(f.childSubmissions).toEqual(history);
      expect(await f.readRemoteComments()).toEqual([{ id: 91, body: 'Uncertain cold judgment', user: { id: 42 } }]);
    }, { repositoryOnly: true, intent4: true, losePhaseAdmission: 4, loggingEnabled: false }));

  it.each(['generic', 'intent2'] as const)(
    'REQ-OPERATOR-017: AC4 cold historical unkeyed %s admitting uncertainty remains fenced; REQ-OPERATOR-048 historical constraint', variant => fixture(async f => {
      await start(f); await f.seedHistoricalAdmitting();
      const history = [...f.childSubmissions];
      const cold = await coldOwner(f);
      expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null, collectionStatus: 'unavailable' });
      expect(await cold.activity.dispatcherGenerationCurrent(1)).toBe(false);
      for (const request of protectedRequests('historical-no-token')) await deny(await f.capability.fetch(request));
      f.settle(); await cold.activity.reconcileDispatcherLease(); await cold.activity.alarm(); await f.drainBackground();
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await cold.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
      expect(f.childSubmissions).toEqual(history);
      expect(await f.readRemoteComments()).toEqual([]);
    }, { loggingEnabled: false, ...(variant === 'intent2' ? { prospective: true, legacyProspective: true } : { repositoryOnly: true }) }));

  it('REQ-OPERATOR-048: AC2 historical running receipt reconstructs and collects its exact settlement without POST replay', () => fixture(async f => {
    await start(f); const history = [...f.childSubmissions];
    f.settle(); const cold = await coldOwner(f);
    await cold.activity.reconcileDispatcherLease();
    expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'waiting', result: null });
    const collected = await cold.activity.collectBrowserResult();
    expect(collected).toMatchObject({ ok: true, detail: { executionStatus: 'completed', result: {
      repository: 'owner/repo', pullRequest: 17, observedHead: 'b'.repeat(40), readOnly: true,
      assessment: { classification: 'unknown', reasons: ['No verified compatibility declaration'] },
    } } });
    expect(stableCollection(await cold.activity.collectBrowserResult())).toEqual(stableCollection(collected));
    expect(f.childSubmissions).toEqual(history); expect(await f.readRemoteComments()).toEqual([]);
  }, { loggingEnabled: false }));

  it('REQ-OPERATOR-048: AC5 stale warmed callers and predecessor tokens cannot fence recovered current work; REQ-OPERATOR-017 AC2/5 rejects late generations', () => fixture(async f => {
    await start(f); const originalWire = await latestDelivery(f);
    const cold = await coldOwner(f); const original = await context(cold);
    const history = [...f.childSubmissions];
    for (const request of protectedRequests(originalWire.attributes.deliveryToken)) await deny(await f.staleCapability.fetch(request));
    await deny(await f.staleCapability.fetch(wire('phase-context', { deliveryToken: original.deliveryToken }, original.deliveryToken)));
    await cold.activity.reconcileDispatcherLease({ generation: 2 });
    expect(await cold.activity.commitDrive(2, { schemaVersion: 1, status: 'completed', checkpoint: null, result: finalResult(f) }))
      .toEqual({ ok: false, reason: 'stale-drive' });
    expect(await context(cold)).toEqual(original); expect(f.childSubmissions).toEqual(history);
    expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    await discovery(cold); const current = await context(cold);
    await deny(await f.capability.fetch(wire('phase-context', { deliveryToken: original.deliveryToken }, original.deliveryToken)));
    for (const request of protectedRequests(original.deliveryToken)) await deny(await f.capability.fetch(request));
    expect(await context(cold)).toEqual(current);
    const mutation = { operationId: 'recovered-current-comment', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"Current recovered judgment"}' };
    const posted = await f.capability.fetch(wire('source', mutation, current.deliveryToken));
    expect(posted.status).toBe(200); expect(await posted.json()).toMatchObject({ status: 201 });
    expect(await receipt(cold, mutation.operationId, current.deliveryToken)).toMatchObject({ phase: 'completed' });
    expect(await context(cold)).toEqual(current);
    await finish(cold);
    expect(await f.readRemoteComments()).toEqual([{ id: 91, body: 'Current recovered judgment', user: { id: 42 } }]);
  }, { repositoryOnly: true, intent4: true, losePhaseAdmission: 1, loggingEnabled: false }));

  it.each(['completed', 'unknown', 'cancel-requested'] as const)(
    'REQ-OPERATOR-017: AC4 cold %s reconstruction is inert with immutable collection and no repository replay; AC5 late cancelled result rejects', status => fixture(async f => {
      await start(f);
      let collected: Awaited<ReturnType<OperatorActivity['collectBrowserResult']>> | undefined;
      if (status === 'completed') collected = await finish(f);
      else if (status === 'unknown') await f.activity.interruptDrive(1);
      else await f.activity.cancelDrive();
      const before = await f.activity.getBrowserDetail();
      if (!before) throw new Error('Prepared fixture browser detail unavailable');
      const history = [...f.childSubmissions];
      const cold = await coldOwner(f);
      for (let alarm = 0; alarm < 2; alarm++) {
        await cold.activity.alarm(); await cold.activity.reconcileDispatcherLease({ generation: 1 }); await f.drainBackground();
      }
      // Lifecycle/result identity is inert; independent SDK release bookkeeping
      // may finish during reconstruction and observation timestamps are not immutable.
      expect(await cold.activity.getBrowserDetail()).toMatchObject({
        activityId: before.activityId, executionStatus: before.executionStatus,
        collectionStatus: before.collectionStatus, checkpoint: before.checkpoint, result: before.result,
      });
      expect(await cold.activity.beginDrive()).toEqual({ ok: false, reason: 'drive-settled' });
      if (collected) {
        expect(stableCollection(await cold.activity.collectBrowserResult())).toEqual(stableCollection(collected));
        expect(stableCollection(await cold.activity.collectBrowserResult())).toEqual(stableCollection(collected));
      } else {
        const token = (await latestDelivery(f)).attributes.deliveryToken;
        for (const request of protectedRequests(token)) await deny(await f.capability.fetch(request));
        expect(await cold.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null, result: finalResult(f) }))
          .toEqual({ ok: false, reason: 'stale-drive' });
        f.messages([{ submissionId: 'submission-1', parts: [{ type: 'data-assessment', data: finalResult(f) }] }]);
        f.settle(); await cold.activity.reconcileDispatcherLease();
        expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: status, result: null });
      }
      expect(f.childSubmissions).toEqual(history); expect(await f.readRemoteComments()).toEqual([]);
    }, { repositoryOnly: true, intent4: true, loggingEnabled: false }));

  it('REQ-OPERATOR-047: exhausted target inference attempts are operation-local while independent work retains original authority', () => fixture(async f => {
    await start(f); await discovery(f);
    const original = await context(f);
    const response = await f.capability.fetch(wire('inference', { operationId: 'target-inference',
      input: { messages: [{ role: 'user', content: 'Assess the admitted target' }] } }, original.deliveryToken));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'OPERATOR_INFERENCE_RECOVERY_EXHAUSTED',
      reason: 'operation-failed', disposition: 'operation-local' });
    expect(await context(f)).toEqual(original);
    const subsequent = await f.capability.fetch(wire('source', { operationId: 'independent-after-exhaustion',
      url: 'https://api.github.com/repos/another/service' }, original.deliveryToken));
    expect(subsequent.status).toBe(200);
    const retained = await receipt(f, 'independent-after-exhaustion', original.deliveryToken);
    expect(retained).toMatchObject({ phase: 'completed', operationCount: 3, operationLimit: 128 });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true, intent4: true, recovery: true, operationLimit: 128, inferenceAttemptLimit: 2,
    capacityPolicy: { inferenceRetryBaseMs: 1, inferenceRetryMaxMs: 2 }, inferenceTransport: async () => new Response(
      'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }) }));

  it.each(['failed', 'completed'] as const)(
    'REQ-OPERATOR-048/081: definitive SDK incarnation refusal after a %s target fences original work and retains witnessed progress', outcome => fixture(async f => {
      await start(f);
      await discovery(f);
      const first = await context(f);
      f.admissionFault(() => Response.json({ error: { type: 'agent_instance_not_found',
        message: 'Agent instance not found', details: 'PRIVATE_ADMISSION_BODY' } }, { status: 404 }));
      if (outcome === 'completed') {
        progress(f, first, { kind: 'target', index: 1, target: frozen[1] }, { results: [rows[0]] });
      } else {
        f.messages([]);
        f.settle(first.submissionId, 'failed', { type: 'operation_failed' });
      }
      await f.activity.reconcileDispatcherLease();
      await f.drainBackground();
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null,
        collectionStatus: 'unavailable', cleanupStatus: 'released', sdkCleanupReleased: true });
      expect(await f.activity.dispatcherGenerationCurrent(first.generation)).toBe(false);
      // Restoring the SDK must not resurrect an explicitly refused original incarnation.
      f.admissionFault(undefined);
      const cold = await coldOwner(f);
      f.advanceClock(6000);
      await cold.activity.alarm();
      await cold.activity.reconcileDispatcherLease();
      await f.drainBackground();
      expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null,
        collectionStatus: 'unavailable', sdkCleanupReleased: true });
      expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      const denied = await f.capability.fetch(wire('source', { operationId: 'after-admission-refusal', method: 'POST',
        url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"must not publish"}' }, first.deliveryToken));
      expect(denied.status).toBe(403);
      expect(await f.readRemoteComments()).toEqual([]);
      const get = diagnosticsBrowser(cold);
      const lifecycle = await (await get('/diagnostics')).json() as { parent: { lease: { resultCount: number } } };
      expect(lifecycle.parent.lease.resultCount).toBe(outcome === 'completed' ? 1 : 0);
      const summary = await diagnosticSummary(cold);
      expect(summary.fence).toMatchObject({ generation: first.generation, boundary: 'submission', code: 'submission-failed' });
      const history = await diagnosticTraversal(get);
      expect(history.records).toContainEqual(expect.objectContaining({ owner: 'host', boundary: 'submission', outcome: 'failed',
        code: 'submission-failed', error: expect.objectContaining({ transportStatus: 404, admissionType: 'agent_instance_not_found' }) }));
    }, { repositoryOnly: true, intent4: true, facetContract: true }));

  it.each([404, 500, 503])('REQ-OPERATOR-048/081: uncertain admission HTTP%i preserves original keyed work and safe failure status', status => fixture(async f => {
    await start(f);
    await discovery(f);
    const first = await context(f);
    f.admissionFault(() => Response.json({ ...(status === 404 ? { code: 'agent_instance_not_found' } : {}),
      detail: 'PRIVATE_UNCLASSIFIED_ADMISSION_BODY' }, { status }));
    f.messages([]);
    f.settle(first.submissionId, 'failed', { type: 'operation_failed' });
    await f.activity.reconcileDispatcherLease();
    await f.drainBackground();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null,
      collectionStatus: 'unavailable' });
    const originalWire = await latestDelivery(f);
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(history.records).toContainEqual(expect.objectContaining({ owner: 'host', boundary: 'submission', outcome: 'failed',
      error: expect.objectContaining({ transportStatus: status }) }));
    f.admissionFault(undefined);
    const cold = await coldOwner(f);
    await cold.activity.reconcileDispatcherLease();
    const next = await context(cold, originalWire.attributes.deliveryToken);
    expect(next).toMatchObject({ generation: first.generation, deadline: first.deadline, releaseDigest: first.releaseDigest,
      authorityDigest: first.authorityDigest, phase: { kind: 'target', index: 1, target: frozen[1] } });
    expect((await latestDelivery(cold)).idempotencyKey).toBe(originalWire.idempotencyKey);
    expect((await latestDelivery(cold)).uid).toBe(originalWire.uid);
    expect(await cold.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(await cold.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true, intent4: true, facetContract: true }));

  it('REQ-OPERATOR-081: a refused SDK admission retains its available validated diagnostic header without exposing response text', () => fixture(async f => {
    await start(f);
    await discovery(f);
    const first = await context(f);
    const report = await runtimeEnvelope(f);
    report.sdk!.submissionId = first.submissionId;
    const header = encodeSdkHeader({ version: 1, records: [report], outbox: { through: report.sequence, dropped: 0, status: 'available' } });
    f.admissionFault(() => Response.json({ detail: 'PRIVATE_REFUSED_SDK_RESPONSE' }, { status: 503,
      headers: { 'x-codeflare-sdk-diagnostics': header } }));
    f.messages([]);
    f.settle(first.submissionId, 'failed', { type: 'operation_failed' });
    await f.activity.reconcileDispatcherLease();
    await f.drainBackground();
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(history.records).toContainEqual(expect.objectContaining({ owner: 'sdk', boundary: report.boundary,
      code: report.code, outcome: report.outcome }));
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, { repositoryOnly: true, intent4: true, sdkDiagnostics: true }));

  it('REQ-OPERATOR-048/081: logging OFF still fences a definitive admission refusal without retaining optional transport details', () => fixture(async f => {
    await start(f);
    await discovery(f);
    const first = await context(f);
    f.admissionFault(() => Response.json({ error: { type: 'agent_instance_not_found',
      message: 'Agent instance not found', details: 'PRIVATE_LOGGING_OFF_RESPONSE' } }, { status: 404 }));
    f.messages([]);
    f.settle(first.submissionId, 'failed', { type: 'operation_failed' });
    await f.activity.reconcileDispatcherLease();
    await f.drainBackground();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null, sdkCleanupReleased: true });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    const summary = await diagnosticSummary(f);
    expect(summary.fence).toMatchObject({ generation: first.generation, code: 'submission-failed' });
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(JSON.stringify(history)).not.toContain('transportStatus');
  }, { repositoryOnly: true, intent4: true, loggingEnabled: false }));

  it('failed PR1 advances only after its exact SDK settlement; PR2 supplies actual complete data and immutable final collection', () => fixture(async f => {
    await start(f);
    const original = await discovery(f);
    const first = await context(f);
    expect(first.phase).toEqual({ kind: 'target', index: 0, target: frozen[0] });
    f.messages([]); f.settle(first.submissionId, 'failed', { type: 'operation_failed', meta: { reason: 'fixture provider failure' } });
    const admitted = await latestDelivery(f);
    // REQ-OPERATOR-048 AC2/3: a broken connection is not a replacement phase,
    // acknowledgement, submission, generation or deadline.
    f.interruptOwnedChild(new Error('Controlled Dispatcher status connection failure'));
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', collectionStatus: 'unavailable', result: null });
    expect(await context(f)).toEqual(first);
    expect(await latestDelivery(f)).toEqual(admitted);
    f.statusFault(() => { throw new Error('Observation unavailable'); });
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', collectionStatus: 'unavailable', result: null });
    expect(await context(f)).toEqual(first);
    expect(await latestDelivery(f)).toEqual(admitted);
    await f.activity.reconcileDispatcherLease();
    const second = await context(f);
    expect(second.phase).toEqual({ kind: 'target', index: 1, target: frozen[1] });
    expect(second.previous).toEqual([{ submissionId: original.submissionId, phase: original.phase, outcome: 'completed' },
      { submissionId: first.submissionId, phase: first.phase, outcome: 'failed' }]);
    for (const key of ['scope', 'generation', 'deadline', 'releaseDigest', 'authorityDigest'] as const) expect(second[key]).toBe(original[key]);
    const rows = [{ ...frozen[0], outcome: 'DEFERRED', reason: 'response-failed' },
      { ...frozen[1], decision: 'DO_NOT_MERGE', comment: 'Actual recorded judgment', outcome: 'NOT_MERGED' }];
    progress(f, second, { kind: 'final' }, { results: rows });
    await f.activity.reconcileDispatcherLease();
    const final = await context(f);
    expect(final.phase).toEqual({ kind: 'final' });
    expect((await f.activity.getBrowserDetail())!.executionStatus).toBe('running');
    const result = { ...(f.input as { repository: string }), results: rows };
    f.messages([{ submissionId: final.submissionId, parts: [{ type: 'data-assessment', data: result }] }]);
    f.settle(final.submissionId); await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'completed', result });
    const collected = await f.activity.collectBrowserResult();
    expect(collected).toMatchObject({ ok: true, detail: { result, sdkCleanupReleased: true } });
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result, sdkCleanupReleased: true } });
    expect((await latestDelivery(f)).uid).toBe('fixture-incarnation');
  }, { repositoryOnly: true, intent4: true, loggingEnabled: false, facetContract: true }));

  it.each(['expired', 'HTTP-rejected'] as const)('REQ-OPERATOR-048: %s status observation cannot keep original work alive', fault => fixture(async f => {
    await start(f); await discovery(f); const original = await context(f);
    f.statusFault(() => {
      if (fault === 'HTTP-rejected') return new Response('', { status: 503 });
      f.advanceClock(300_000); throw new Error('Observation unavailable');
    });
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null, collectionStatus: 'unavailable' });
    expect(await f.activity.dispatcherGenerationCurrent(original.generation)).toBe(false);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { repositoryOnly: true, intent4: true, loggingEnabled: false }));

  it.each(['unknown', 'cancel-requested'] as const)('REQ-OPERATOR-016/041: %s exposes only its exact retired SDK receipt', status => fixture(async f => {
    await start(f);
    if (status === 'unknown') await f.activity.interruptDrive(1); else await f.activity.cancelDrive();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: status, sdkCleanupReleased: true,
      collectionStatus: 'unavailable', result: null, cleanupStatus: 'released' });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    const denied = await f.capability.fetch(genericWire('source', { operationId: 'retired-effect', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: '{"body":"must not publish"}' }));
    expect(denied.status).toBe(403);
  }, { repositoryOnly: true, intent4: true, loggingEnabled: false }));

  it.each(['inputDigest', 'artifactDigest'] as const)('REQ-OPERATOR-041: a retired receipt with mismatched %s is not exposed', field => fixture(async f => {
    await start(f); await f.activity.interruptDrive(1); await f.changeRetiredPin(field);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', sdkCleanupReleased: false, result: null });
  }, { repositoryOnly: true, intent4: true, loggingEnabled: false }));

  it.each(['read-failure', 'unknown-write', 'domain-uncertain'] as const)('REQ-OPERATOR-061: only original settled and collected singleton deferral supplies immutable scheduled-retry proof: %s', scenario => fixture(async f => {
    await start(f);
    const coordinates = { repositoryId: f.proof.repositoryId, pullRequest: f.proof.pullRequest, head: f.proof.head };
    expect(await f.activity.readProspectiveRenovateRetryProof(coordinates)).toBeNull();
    const original = await context(f);
    const target = { pullRequest: coordinates.pullRequest, headSha: coordinates.head };
    progress(f, original, { kind: 'target', index: 0, target }, { targets: [target] });
    await f.activity.reconcileDispatcherLease();
    const current = await context(f);
    if (scenario === 'unknown-write') {
      f.loseResponse();
      const unknown = await f.capability.fetch(wire('source', { operationId: 'original-uncertain-comment', method: 'POST',
        url: `${prospectiveBase}/issues/${target.pullRequest}/comments`, body: '{"body":"Original intended comment"}' }, current.deliveryToken));
      expect(unknown.status).toBe(409);
      expect(await unknown.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      f.restoreTransport();
    }
    const result = { repository: f.proof.repository, results: [scenario === 'domain-uncertain'
      ? { ...target, outcome: 'DEFERRED', reason: 'comment-uncertain', decision: 'DO_NOT_MERGE', comment: 'Actual recorded judgment' }
      : { ...target, outcome: 'DEFERRED', reason: 'response-failed' }] };
    if (scenario === 'domain-uncertain') progress(f, current, { kind: 'final' }, { results: result.results });
    else { f.messages([]); f.settle(current.submissionId, 'failed', { type: 'operation_failed' }); }
    await f.activity.reconcileDispatcherLease();
    const final = await context(f);
    expect(await f.activity.readProspectiveRenovateRetryProof(coordinates)).toBeNull();
    f.messages([{ submissionId: final.submissionId, parts: [{ type: 'data-assessment', data: result }] }]);
    f.settle(final.submissionId); await f.activity.reconcileDispatcherLease();
    const proof = await f.activity.readProspectiveRenovateRetryProof(coordinates);
    if (scenario === 'read-failure') expect(proof).toMatchObject({ ...coordinates, activityId: f.proof.activityId, generation: final.generation,
      repository: f.proof.repository, baseBranch: f.proof.baseBranch, artifactDigest: f.proof.bundleDigest,
      createdAt: f.proof.createdAt, sdkSubmissionId: final.submissionId, terminalAt: expect.any(Number),
      collected: true, settled: true, disposition: 'DEFERRED' });
    else expect(proof).toBeNull(); // Complete collection never grants permission to repeat an uncertain effect.
    f.restart();
    expect(await f.activity.readProspectiveRenovateRetryProof(coordinates)).toEqual(proof);
    expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
    expect(await f.activity.readProspectiveRenovateRetryProof(coordinates)).toEqual(proof);
    expect(await f.activity.readProspectiveRenovateRetryProof({ ...coordinates, repositoryId: coordinates.repositoryId + 1 })).toBeNull();
    expect(await f.activity.readProspectiveRenovateRetryProof({ ...coordinates, head: 'c'.repeat(40) })).toBeNull();
    f.changeProof({ head: 'c'.repeat(40) });
    expect(await f.activity.readProspectiveRenovateRetryProof(coordinates)).toBeNull();
  }, { prospective: true, intent4: true }));

  it.each([1, 2])('lost phase %i acknowledgement reattaches the original keyed admission without replacing UID/SID', lost => fixture(async f => {
    await start(f);
    if (lost === 2) await discovery(f);
    const retainedWire = await latestDelivery(f);
    const recovered = await context(f, retainedWire.attributes.deliveryToken);
    expect(recovered.submissionId).toBe(`submission-${lost}`);
    expect(await latestDelivery(f)).toEqual(retainedWire);
    expect(await context(f, retainedWire.attributes.deliveryToken)).toEqual(recovered);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(f.sent).toEqual([]);
  }, { repositoryOnly: true, intent4: true, losePhaseAdmission: lost }));

  it('old delivery tokens cannot fetch context or protected sources, and do not fence the next phase', () => fixture(async f => {
    await start(f); const original = await discovery(f); const current = await context(f);
    const before = await f.activity.getBrowserDetail();
    const stale = await f.capability.fetch(wire('source', { operationId: 'old-read', url: 'https://api.github.com/repos/another/service' }, original.deliveryToken));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
    expect((await f.capability.fetch(wire('phase-context', { deliveryToken: original.deliveryToken }, original.deliveryToken))).status).toBe(403);
    expect(await f.activity.getBrowserDetail()).toEqual(before);
    const read = await f.capability.fetch(wire('source', { operationId: 'current-read', url: 'https://api.github.com/repos/another/service' }, current.deliveryToken));
    expect(read.status).toBe(200);
    const retained = await receipt(f, 'current-read', current.deliveryToken);
    const diagnostic = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(diagnostic).toMatchObject({ parent: { operations: { status: 'available', scan: 'complete',
      inspectedEntries: 1, records: [{ operationDigest: await digest('current-read'), ordinal: 0,
        status: 'completed', requestDigest: retained.requestDigest, responseDigest: retained.responseDigest,
        binding: { scope: 'requested', submissionDigest: await digest(current.submissionId),
          deliveryDigest: await digest(current.deliveryToken), phase: 'target', phaseIndex: 0, resource: 'source' },
        hostInference: null }] } } });
    for (const secret of ['current-read', current.submissionId, current.deliveryToken, 'https://api.github.com'])
      expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(await f.activity.getDispatcherDiagnostics('f'.repeat(64))).toBeNull();
    expect(await context(f)).toEqual(current);
  }, { repositoryOnly: true, intent4: true }));

  it.each([true, false])('exact deferred coverage of a lost comment response permits collection=%s without replay or clearing uncertainty', covered => fixture(async f => {
    await start(f); await discovery(f);
    const first = await context(f);
    const mutation = { operationId: 'uncertain-original-comment', method: 'POST',
      url: 'https://api.github.com/repos/another/service/issues/17/comments', body: JSON.stringify({ body: 'Original intended comment' }) };
    f.loseResponse();
    const response = await f.capability.fetch(wire('source', mutation, first.deliveryToken));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    f.restoreTransport();
    const originalReceipt = await f.capability.fetch(wire('receipt', { operationId: mutation.operationId }, first.deliveryToken));
    expect(await originalReceipt.json()).toMatchObject({ phase: 'unknown', method: 'POST', url: mutation.url, operationCount: 1 });
    const admitted = await latestDelivery(f);
    f.statusFault(() => { throw new Error('Observation unavailable'); });
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', collectionStatus: 'unavailable', result: null });
    expect(await context(f)).toEqual(first); expect(await latestDelivery(f)).toEqual(admitted);
    const retained = await f.capability.fetch(wire('receipt', { operationId: mutation.operationId }, first.deliveryToken));
    expect(await retained.json()).toMatchObject({ phase: 'unknown', operationCount: 1 });
    f.messages([]); f.settle(first.submissionId, 'failed', { type: 'operation_failed' });
    await f.activity.reconcileDispatcherLease();
    const second = await context(f);
    // A failed SDK response cannot invent the missing judgment. Its original target's
    // response-failed disposition accounts for the retained original unknown operation.
    const rows = [covered ? { ...frozen[0], outcome: 'DEFERRED', reason: 'response-failed' }
      : { ...frozen[0], decision: 'DO_NOT_MERGE', comment: 'Invalid definite outcome', outcome: 'NOT_MERGED' },
      { ...frozen[1], decision: 'DO_NOT_MERGE', comment: 'Unrelated actual fixture judgment', outcome: 'NOT_MERGED' }];
    const readback = await f.capability.fetch(wire('source', { operationId: 'independent-readback', url: mutation.url }, second.deliveryToken));
    expect(readback.status).toBe(200);
    expect(JSON.parse((await readback.json() as { body: string }).body)).toEqual([
      { id: 91, body: 'Original intended comment', user: { id: 42 } },
    ]);
    // REQ-OPERATOR-080: the tail contains different phases; association is explicit, not inferred.
    const diagnostic = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(diagnostic).toMatchObject({ parent: { operations: { scan: 'complete', inspectedEntries: 2,
      records: [
        { operationDigest: await digest('independent-readback'), ordinal: 1, status: 'completed',
          binding: { scope: 'requested', phase: 'target', phaseIndex: 1,
            submissionDigest: await digest(second.submissionId), deliveryDigest: await digest(second.deliveryToken) } },
        { operationDigest: await digest(mutation.operationId), ordinal: 0, status: 'unknown',
          binding: { scope: 'other', phase: 'target', phaseIndex: 0,
            submissionDigest: await digest(first.submissionId), deliveryDigest: await digest(first.deliveryToken) } },
      ] } } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/Original intended comment|uncertain-original-comment|independent-readback|api\.github\.com/);
    progress(f, second, { kind: 'final' }, { results: rows });
    await f.activity.reconcileDispatcherLease();
    const final = await context(f);
    const result = { ...(f.input as { repository: string }), results: rows };
    f.messages([{ submissionId: final.submissionId, parts: [{ type: 'data-assessment', data: result }] }]);
    f.settle(final.submissionId); await f.activity.reconcileDispatcherLease();
    if (covered) {
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
      expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result } });
    } else {
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
    }
    expect((await f.capability.fetch(wire('source', mutation, first.deliveryToken))).status).toBe(403);
  }, { repositoryOnly: true, intent4: true }));

  it('a late predecessor inference failure cannot commit into or interrupt its successor', async () => {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    await fixture(async f => {
      await start(f); await discovery(f); const first = await context(f);
      const late = f.capability.fetch(wire('inference', { operationId: 'held-pr1-model',
        input: { messages: [{ role: 'user', content: 'PR1 fixture input' }] } }, first.deliveryToken));
      await enteredPromise;
      const admitted = await latestDelivery(f);
      f.statusFault(() => { throw new Error('Observation unavailable'); });
      await f.activity.reconcileDispatcherLease();
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', collectionStatus: 'unavailable', result: null });
      expect(await context(f)).toEqual(first); expect(await latestDelivery(f)).toEqual(admitted);
      const receipt = await f.capability.fetch(wire('receipt', { operationId: 'held-pr1-model' }, first.deliveryToken));
      expect(receipt.status).toBe(403);
      expect(await receipt.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      f.messages([]); f.settle(first.submissionId, 'failed', { type: 'operation_failed' });
      await f.activity.reconcileDispatcherLease();
      const second = await context(f);
      release(); expect((await late).status).toBe(403);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
      const source = await f.capability.fetch(wire('source', { operationId: 'pr2-after-late-failure',
        url: 'https://api.github.com/repos/another/service' }, second.deliveryToken));
      expect(source.status).toBe(200); expect(await context(f)).toEqual(second);
    }, { repositoryOnly: true, intent4: true, recovery: true,
      inferenceTransport: async () => { entered(); await held; throw new Error('Late PR1 transport failure'); } });
  });

  it('the current phase cannot mutate a different PR or a different merge head', () => fixture(async f => {
    await start(f); await discovery(f); const current = await context(f);
    for (const body of [
      { operationId: 'foreign-phase-comment', method: 'POST', url: 'https://api.github.com/repos/another/service/issues/18/comments', body: '{"body":"wrong PR"}' },
      { operationId: 'wrong-phase-head', method: 'PUT', url: 'https://api.github.com/repos/another/service/pulls/17/merge', body: JSON.stringify({ sha: '9'.repeat(40), merge_method: 'merge' }) },
    ]) expect((await f.capability.fetch(wire('source', body, current.deliveryToken))).status).toBe(403);
    expect(f.sent).toEqual([]); expect(await context(f)).toEqual(current);
  }, { repositoryOnly: true, intent4: true }));

  it('rejects a parent output allowance below the package reservation bound before protected work', () => fixture(async f => {
    await start(f);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
    expect(f.sent).toEqual([]);
  }, { repositoryOnly: true, intent4: true, capacityPolicy: { assessmentBytes: 48 * 1024 - 1 } }));

  describe('REQ-OPERATOR-041: immutable retired effect response wire', () => {
    const options = { repositoryOnly: true, intent4: true, recovery: true, receiptFixture: true };
    const sourceUrl = 'https://api.github.com/repos/another/service/issues/17/comments';
    type Stored = Record<string, unknown>;
    type Receipts = { version: number; generation?: number; inputDigest?: string; artifactDigest?: string;
      admissionDigest?: string; scan: string; pageStatus: string; journalCount: number | null;
      inspectedEntries: number; unresolvedJournalEntries: number | null; unclassifiedEntries: number;
      nextAfterOrdinal: number | null; items: Array<Record<string, unknown>> };
    const browser = (f: DispatcherFixture) => {
      vi.spyOn(access, 'requireOperatorHumanContext').mockImplementation(async (_request, _env, email) => ({
        human: { subject: email === 'owner@example.test' ? 'owner' : 'foreign', email,
          issuer: 'https://access.example.test', audiences: ['audience'], issuedAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + 600 }, accessJwt: 'PRIVATE_BROWSER_JWT',
      }));
      const app = new Hono<{ Bindings: Env }>();
      app.onError((error, c) => error instanceof AppError
        ? c.json({ code: error.code }, error.statusCode as 400) : c.json({ code: 'INTERNAL_ERROR' }, 500));
      app.route('/api/operator-activities', activityRoutes);
      return (suffix = '/result', email = 'owner@example.test', method = 'GET') => app.request(
        `/api/operator-activities/${f.activityId}${suffix}`, { method, headers: {
          'cf-access-authenticated-user-email': email, 'X-Requested-With': 'XMLHttpRequest',
        } }, f.environment);
    };
    const setup = async (f: DispatcherFixture, count = 1) => {
      await start(f); await discovery(f); const stamp = await context(f);
      for (let index = 0; index < count; index++) {
        const response = await f.capability.fetch(wire('source', { operationId: `PRIVATE_OPERATION_${index}`,
          method: 'POST', url: sourceUrl, body: JSON.stringify({ body: `PRIVATE_HTTP_BODY_${index}` }) }, stamp.deliveryToken));
        expect(response.status).toBe(200);
        expect((await response.json() as { status: number }).status).toBe(201);
      }
      return stamp;
    };
    const read = async (get: ReturnType<typeof browser>, after?: number) => {
      const response = await get(`/result${after === undefined ? '' : `?receiptAfter=${after}`}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { effectReceipts?: Receipts; executionStatus: string; result: unknown;
        checkpoint: unknown; cleanupStatus: string; collectionStatus: string; updatedAt: string };
      expect(body.effectReceipts).toBeDefined();
      return body;
    };
    const patch = async (f: DispatcherFixture, key: string, change: (value: Stored) => Stored) => {
      await f.mutateEvidence(async storage => {
        const value = await storage.get<Stored>(key);
        if (!value) throw new Error('Controlled snapshot missing');
        await storage.put(key, change(value));
      });
    };
    const faultWrite = async (f: DispatcherFixture, change: (record: Stored, storage: DurableObjectStorage,
      key: string) => Promise<Stored>, method = 'POST') => f.mutateEvidence(async storage => {
      const entries = await storage.list<Stored>({ prefix: 'dispatcher:operation:1:' });
      const found = [...entries].find(([, value]) => (value.request as Stored | undefined)?.method === method);
      if (!found) throw new Error('Controlled write snapshot missing');
      await storage.put(found[0], await change(found[1], storage, found[0]));
    });
    const unavailable = (body: Awaited<ReturnType<typeof read>>) => {
      expect(body.effectReceipts).toMatchObject({ scan: 'unavailable', pageStatus: 'unavailable', items: [],
        journalCount: null, inspectedEntries: 0, nextAfterOrdinal: null });
      expect(body.effectReceipts).not.toHaveProperty('generation');
      expect(body.effectReceipts).not.toHaveProperty('inputDigest');
    };

    it('REQ-OPERATOR-041: AC4 cancelled original comment remains attributable over HTTP', () => fixture(async f => {
      const stamp = await setup(f); const remote = await f.readRemoteComments() as Array<{ id: number; body: string }>;
      await f.activity.cancelDrive(); const get = browser(await coldOwner(f)); const body = await read(get);
      expect(body).toMatchObject({ executionStatus: 'cancel-requested', result: null, collectionStatus: 'unavailable' });
      expect(body.effectReceipts).toMatchObject({ version: 1, generation: 1, artifactDigest: f.artifactDigest,
        scan: 'complete', pageStatus: 'complete', items: [{ binding: 'verified', journalPhase: 'completed',
          effect: 'comment', method: 'POST', target: { repository: 'another/service', ...frozen[0] },
          observedResponse: { kind: 'comment', status: 201, commentId: remote[0].id,
            responseBodyDigest: await digest(remote[0].body) } }] });
      const row = body.effectReceipts!.items[0];
      for (const field of ['operationDigest', 'requestDigest', 'responseDigest', 'submissionDigest', 'deliveryDigest'])
        expect(row[field]).toMatch(/^[a-f0-9]{64}$/);
      await deny(await f.capability.fetch(wire('source', { operationId: 'after-read', method: 'POST',
        url: sourceUrl, body: '{"body":"must not replay"}' }, stamp.deliveryToken)));
      expect(await f.readRemoteComments()).toEqual(remote);
      expect((await get('/result', 'owner@example.test', 'POST')).status).toBe(409);
    }, options));

    it('REQ-OPERATOR-041: AC4 original merge success binds the frozen head and remote SHA', () => fixture(async f => {
      const stamp = await setup(f);
      const response = await f.capability.fetch(wire('source', { operationId: 'original-merge', method: 'PUT',
        url: 'https://api.github.com/repos/another/service/pulls/17/merge',
        body: JSON.stringify({ sha: frozen[0].headSha, merge_method: 'merge' }) }, stamp.deliveryToken));
      expect(response.status).toBe(200); const remote = f.readRemoteMerge() as { sha: string };
      await f.activity.cancelDrive(); const body = await read(browser(f));
      expect(body.effectReceipts!.items).toContainEqual(expect.objectContaining({ effect: 'merge', binding: 'verified',
        target: { repository: 'another/service', ...frozen[0] },
        observedResponse: { kind: 'merge', status: 200, merged: true, mergeSha: remote.sha } }));
    }, options));

    it('REQ-OPERATOR-041: AC5 reconstructed receipt pages are stable and do not consume results', () => fixture(async f => {
      await setup(f); await f.activity.cancelDrive(); const get = browser(f); const first = await read(get);
      expect(await read(get)).toEqual(first); const restarted = await coldOwner(f);
      expect(await read(browser(restarted))).toEqual(first);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, options));

    it.each(['inputDigest', 'artifactDigest', 'executionArtifact', 'authorityDigest', 'intentVersion',
      'journalGeneration', 'leaseGeneration', 'leaseStatus', 'serialMissing', 'duplicateSubmission'] as const)(
      'REQ-OPERATOR-041: AC5 mismatched original selection is unavailable: %s', fault => fixture(async f => {
        await setup(f); await f.activity.cancelDrive();
        if (fault === 'journalGeneration') await patch(f, 'dispatcher:journal', value => ({ ...value, generation: 99 }));
        else if (fault === 'executionArtifact') await patch(f, 'admission', value => ({ ...value,
          executionContext: { ...(value.executionContext as Stored), artifactDigest: 'e'.repeat(64) } }));
        else if (fault === 'intentVersion') await patch(f, 'admission', value => {
          const receipt = value.receipt as Stored; const selection = receipt.selection as Stored;
          return { ...value, receipt: { ...receipt, selection: { ...selection,
            release: { ...(selection.release as Stored), intentVersion: '3' } } } };
        });
        else await patch(f, 'dispatcher:lease', value => {
          if (fault === 'inputDigest' || fault === 'artifactDigest') return { ...value, [fault]: 'e'.repeat(64) };
          if (fault === 'leaseGeneration') return { ...value, generation: 99 };
          if (fault === 'leaseStatus') return { ...value, status: 'running' };
          if (fault === 'serialMissing') return { ...value, serial: undefined };
          const serial = value.serial as Stored;
          if (fault === 'authorityDigest') return { ...value, serial: { ...serial, authorityDigest: 'e'.repeat(64) } };
          return { ...value, serial: { ...serial, previous: [...serial.previous as unknown[], serial.current] } };
        });
        const body = await read(browser(f)); unavailable(body);
        expect(body.executionStatus).toBe('cancel-requested'); expect(body.result).toBeNull();
      }, options));

    it.each(['missingCache', 'changedBody', 'missingDigest', 'wrongDigest', 'foreignUrl', 'malformed',
      'overflow', 'upstreamError', 'invalidId', 'resolutionOnly', 'foreignSubmission', 'foreignTarget',
      'missingBinding', 'foreignResource', 'encodedUrl'] as const)(
      'REQ-OPERATOR-041: AC5 invalid stored response or association stays unresolved: %s', fault => fixture(async f => {
        await setup(f); await f.activity.cancelDrive();
        await faultWrite(f, async (record, storage, key) => {
          const responseKey = `dispatcher:response:${key.slice('dispatcher:operation:1:'.length)}`;
          if (fault === 'missingCache') { await storage.delete(responseKey); return record; }
          if (fault === 'missingDigest') return { ...record, responseDigest: undefined };
          if (fault === 'wrongDigest') return { ...record, responseDigest: 'e'.repeat(64) };
          if (fault === 'missingBinding') return { ...record, phaseBinding: undefined };
          if (fault === 'foreignResource') return { ...record, phaseBinding: { ...(record.phaseBinding as Stored), resource: 'inference' } };
          if (fault === 'encodedUrl') return { ...record, request: { ...(record.request as Stored),
            url: sourceUrl.replace('/17/', '/%31%37/') } };
          if (fault === 'foreignSubmission' || fault === 'foreignTarget') {
            const binding = record.phaseBinding as Stored;
            return { ...record, phaseBinding: { ...binding, ...(fault === 'foreignSubmission'
              ? { submissionId: 'PRIVATE_FOREIGN_SUBMISSION' } : { phase: { kind: 'target', index: 1, target: frozen[1] } }) } };
          }
          const response = await storage.get<{ status: number; contentType: string; body: string }>(responseKey);
          let body = response!.body;
          if (fault === 'changedBody') body += 'PRIVATE_ERROR';
          else if (fault === 'malformed') body = 'PRIVATE_ERROR';
          else if (fault === 'overflow') body = 'x'.repeat(2 * 1024 * 1024);
          else if (fault === 'resolutionOnly') body = JSON.stringify({ resolved: true, operationId: 'PRIVATE_OPERATION' });
          else { const envelope = JSON.parse(body) as { url: string; status: number; body: string };
            if (fault === 'foreignUrl') envelope.url = 'https://api.github.com/repos/foreign/repo/issues/17/comments';
            if (fault === 'upstreamError') { envelope.status = 403; envelope.body = 'PRIVATE_ERROR'; }
            if (fault === 'invalidId') envelope.body = JSON.stringify({ id: Number.MAX_SAFE_INTEGER + 1, body: 'PRIVATE_HTTP_BODY' });
            body = JSON.stringify(envelope);
          }
          await storage.put(responseKey, { ...response, body });
          return fault === 'changedBody' ? record : { ...record, responseDigest: await digest(body) };
        });
        const body = await read(browser(f));
        expect(body.effectReceipts!.items).toMatchObject([{ binding: 'unresolved' }]);
        expect(body.effectReceipts!.items[0]).not.toHaveProperty('observedResponse');
        expect(JSON.stringify(body.effectReceipts)).not.toContain('PRIVATE_ERROR');
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      }, options));

    it('REQ-OPERATOR-041: AC5 original installation ceiling rejects an otherwise valid cached receipt', () => fixture(async f => {
      await setup(f); const remote = await f.readRemoteComments(); await f.activity.cancelDrive();
      await faultWrite(f, async (record, storage, key) => {
        const responseKey = `dispatcher:response:${key.slice('dispatcher:operation:1:'.length)}`;
        const response = await storage.get<{ status: number; contentType: string; body: string }>(responseKey);
        // JSON whitespace keeps the original success identity intact while violating only the retained installation ceiling.
        const body = response!.body + ' '.repeat(65536);
        await storage.put(responseKey, { ...response, body });
        return { ...record, responseDigest: await digest(body) };
      });
      const body = await read(browser(f));
      expect(body.effectReceipts!.items).toMatchObject([{ binding: 'unresolved' }]);
      expect(body.effectReceipts!.items[0]).not.toHaveProperty('observedResponse');
      expect(await f.readRemoteComments()).toEqual(remote);
    }, { ...options, sourceResponseBytes: 131072, installationSourceResponseBytes: 65536 }));

    it('REQ-OPERATOR-041: AC5 unknown write cannot borrow a success from external state', () => fixture(async f => {
      await start(f); await discovery(f); const stamp = await context(f); f.loseResponse();
      const uncertain = await f.capability.fetch(wire('source', { operationId: 'lost-response', method: 'POST',
        url: sourceUrl, body: '{"body":"Uncertain original effect"}' }, stamp.deliveryToken));
      expect(uncertain.status).toBe(409);
      expect(await uncertain.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      const remote = await f.readRemoteComments(); await f.activity.cancelDrive();
      const body = await read(browser(f)); expect(body.effectReceipts!.items).toMatchObject([{ binding: 'unresolved', journalPhase: 'unknown' }]);
      expect(body.effectReceipts!.items[0]).not.toHaveProperty('observedResponse');
      expect(await f.readRemoteComments()).toEqual(remote);
      await deny(await f.capability.fetch(wire('resolve', { operationId: 'lost-response', readbacks: ['other'] }, stamp.deliveryToken)));
    }, options));

    it('REQ-OPERATOR-041: AC6 validated public identity is returned without private content', () => fixture(async f => {
      const stamp = await setup(f); const remote = await f.readRemoteComments() as Array<{ id: number }>;
      await f.activity.cancelDrive(); const body = await read(browser(f));
      expect(body.effectReceipts!.items[0]).toMatchObject({ observedResponse: { commentId: remote[0].id } });
      for (const secret of ['PRIVATE_OPERATION', 'PRIVATE_HTTP_BODY', 'PRIVATE_BROWSER_JWT', 'private.jwt',
        'parent-only', stamp.deliveryToken, stamp.submissionId, 'https://api.github.com'])
        expect(JSON.stringify(body.effectReceipts)).not.toContain(secret);
    }, options));

    it('REQ-OPERATOR-041: AC5 eight-item pages preserve ascending exhaustive coverage', () => fixture(async f => {
      await setup(f, 9); const remote = await f.readRemoteComments() as Array<{ id: number }>;
      await f.activity.cancelDrive(); const get = browser(f); const first = (await read(get)).effectReceipts!;
      expect(first.items).toHaveLength(8); expect(first.pageStatus).toBe('more');
      expect(first.nextAfterOrdinal).toBe(first.items.at(-1)!.ordinal);
      const second = (await read(get, first.nextAfterOrdinal!)).effectReceipts!;
      expect(second.items).toHaveLength(1); expect(second.pageStatus).toBe('complete');
      expect(second.nextAfterOrdinal).toBeNull();
      expect([...first.items, ...second.items].map(item => (item.observedResponse as { commentId: number }).commentId))
        .toEqual(remote.map(item => item.id));
      for (const page of [first, second]) expect(page).toMatchObject({ generation: 1, scan: 'complete', journalCount: 9 });
      const diagnostic = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
      expect(diagnostic).toMatchObject({ sdk: { status: 'unavailable', reason: 'retired' }, parent: { operations: {
        status: 'available', generation: 1, selection: 'highest-logical-ordinals', scan: 'complete',
        inspectedEntries: 9, omittedEntries: true,
        records: Array.from({ length: 8 }, (_, index) => ({ ordinal: 8 - index, status: 'completed' })),
      } } });
      expect(new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(JSON.stringify(diagnostic)).not.toMatch(/PRIVATE_OPERATION|PRIVATE_HTTP_BODY|private\.jwt|parent-only|api\.github\.com/);
    }, options));

    describe('REQ-OPERATOR-081: retained owner v2 HTTP evidence', () => {
      const v2 = '/diagnostics/v2';
      const populateReads = async (f: DispatcherFixture, count = 40) => {
        await start(f); await discovery(f); const stamp = await context(f);
        const ids = Array.from({ length: count }, (_, index) => `PRIVATE_HISTORY_${index}`);
        for (const operationId of ids) expect((await f.capability.fetch(wire('source', {
          operationId, url: 'https://api.github.com/repos/another/service/issues/17/comments',
        }, stamp.deliveryToken))).status).toBe(200);
        await f.drainBackground();
        return { stamp, ids, digests: await Promise.all([...ids].sort().map(id => digest(id))) };
      };
      const originalBinding = async (f: DispatcherFixture) => {
        const oldWire = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
        return { generation: 1, artifactDigest: f.artifactDigest, inputDigest: oldWire!.parent.lease!.inputDigest };
      };
      const page = async (get: ReturnType<typeof diagnosticsBrowser>, suffix = '/history') =>
        diagnosticJson<DiagnosticPage>(await get(v2 + suffix));
      const errorStatus = async (response: Response, status: number) => {
        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).not.toMatch(/PRIVATE_|private\.jwt|parent-only/);
      };

      it('REQ-OPERATOR-081: AC1/4/5 summary retains original binding and nonserial receipt root after retirement', () => fixture(async f => {
        await start(f); const binding = await originalBinding(f);
        const before = await f.activity.getBrowserDetail();
        const summary = await diagnosticSummary(f);
        expect(summary).toMatchObject({ version: 2, activityId: f.activityId, consistency: 'stable-binding',
          binding, capture: 'enabled', sdkBinding: { status: 'available',
            rootDigest: await digest('fixture-incarnation'), submissionDigest: await digest('submission-1') },
          retention: { routineLimit: 1536, failureLimit: 64, terminalLimit: 64 } });
        expect(Number.isSafeInteger(summary.capturedAt)).toBe(true);
        expect(Object.keys(summary.provenance).sort()).toEqual(['hostRevision', 'patchSetDigest', 'sdkBaseAgents', 'sdkBaseRuntime']);
        for (const value of Object.values(summary.provenance)) expect(value === null || typeof value === 'string').toBe(true);
        expect(summary.sdkBinding.attemptDigest ?? null).toBeNull();
        expect(await f.activity.getBrowserDetail()).toEqual(before);
        await f.activity.cancelDrive(); f.restart(); await f.drainBackground();
        const retired = await diagnosticSummary(f);
        expect(retired.binding).toEqual(binding);
        expect(retired.sdkBinding).toMatchObject(summary.sdkBinding);
        expect(retired.fence).toMatchObject({ code: 'cancelled' });
        expect((await f.capability.fetch(genericWire('source', { operationId: 'no-renewal', url: sourceUrl }))).status).toBe(403);
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      }, { repositoryOnly: true, recovery: true }));

      it('REQ-OPERATOR-081: AC4/5 complete history traverses retained operation digests in storage order across small pages', () => fixture(async f => {
        const { digests } = await populateReads(f, 70); const binding = await originalBinding(f);
        await f.activity.cancelDrive(); f.restart(); await f.drainBackground();
        const { pages, records } = await diagnosticTraversal(diagnosticsBrowser(f));
        expect(pages.length).toBeGreaterThan(2);
        const operations = records.filter(record => record.kind === 'operation');
        expect(operations.map(record => record.id)).toEqual(digests.map(value => `o-1-${value}`));
        expect(operations.every(record => record.generation === 1)).toBe(true);
        expect(operations.every(record => record.sequence === undefined)).toBe(true);
        expect(pages.every(page => JSON.stringify(page.binding) === JSON.stringify(binding))).toBe(true);
        expect(pages.at(-1)).toMatchObject({ nextCursor: null, pageStatus: 'complete', retainedStatus: 'complete' });
      }, options));

      it('REQ-OPERATOR-081: AC4/5 metadata traversal exceeds a per-request legacy scan without migrating the aggregate', () => fixture(async f => {
        await start(f);
        // Metadata-only legacy fixture: no new native 1023–1025 workloads or external effects.
        const entries = Array.from({ length: 1100 }, (_, index) => ({
          body: { operationId: `PRIVATE_LEGACY_${index}`, url: 'https://api.github.com/repos/another/service' },
          phase: 'completed' as const, ordinal: index + 11,
          response: { url: 'https://api.github.com/repos/another/service', status: 200, headers: {}, body: 'PRIVATE_BODY' },
        }));
        await f.seedLegacyJournal(entries); await f.activity.cancelDrive(); await f.drainBackground();
        await f.mutateEvidence(async storage => {
          // Forbidden write/body access fails observably; this is fault injection, not a call-count assertion.
          vi.spyOn(storage, 'put').mockImplementation(async () => { throw new Error('PRIVATE_GET_MIGRATION'); });
          const read = storage.get.bind(storage);
          vi.spyOn(storage, 'get').mockImplementation((async (key: string | string[]) => {
            if ((Array.isArray(key) ? key : [key]).some(value => value.startsWith('dispatcher:response:')))
              throw new Error('PRIVATE_BODY_READ');
            return read(key as string);
          }) as typeof storage.get);
        });
        const get = diagnosticsBrowser(f); let firstCursor: string | null = null;
        try {
          const first = await diagnosticJson<DiagnosticPage>(await get('/diagnostics/v2/history'));
          expect(first.records.length).toBeGreaterThan(0);
          // The empty keyed journal is not the immutable legacy map's ordinal watermark.
          expect(first.highWater.operations).toBe(0);
          firstCursor = first.nextCursor;
          const { pages, records } = await diagnosticTraversal(get, '/diagnostics/v2/history', first);
          const expected = await Promise.all([...entries].sort((a, b) => a.body.operationId.localeCompare(b.body.operationId))
            .map(entry => digest(entry.body.operationId)));
          expect(new Set(records.filter(record => record.kind === 'operation').map(record => record.id)))
            .toEqual(new Set(expected.map(value => `o-1-${value}`)));
          expect(pages.length).toBeGreaterThan(34);
          expect(pages.at(-1)?.pageStatus).toBe('complete');
          expect(await f.readRemoteComments()).toEqual([]);
        } finally { vi.restoreAllMocks(); }
        expect(firstCursor).toEqual(expect.any(String));
        // Replace the aggregate with sparse keyed metadata from the same population.
        // The retained ordinal is not its cardinality/charged count, and an old legacy
        // cursor cannot silently cross this segment change under the same Activity binding.
        const retained = entries.at(-1)!;
        await f.mutateEvidence(async storage => {
          const legacy = await storage.get<Record<string, unknown>>('dispatcher:operations');
          await storage.put(`dispatcher:operation:1:${retained.body.operationId}`, legacy![retained.body.operationId]);
          await storage.put('dispatcher:journal', { generation: 1, count: 1, nextOrdinal: retained.ordinal + 1, unresolved: 0 });
          await storage.delete('dispatcher:operations');
        });
        const freshGet = diagnosticsBrowser(f);
        await errorStatus(await freshGet(`/diagnostics/v2/history?cursor=${encodeURIComponent(firstCursor!)}`), 409);
        const fresh = await diagnosticTraversal(freshGet);
        expect(fresh.pages[0].highWater.operations).toBe(retained.ordinal + 1);
        expect(fresh.records.filter(record => record.kind === 'operation')).toMatchObject([
          { id: `o-1-${await digest(retained.body.operationId)}`, ordinal: retained.ordinal },
        ]);
      }, { repositoryOnly: true, operationLimit: 2048 }));

      it('REQ-OPERATOR-081: AC2/4/5 detail returns retained failure capsule without private error or cache reads', () => fixture(async f => {
        await start(f); const binding = await originalBinding(f);
        f.settle('submission-1', 'failed', { type: 'operation_failed', meta: {
          operation: 'prompt', reason: 'PRIVATE_THROWN_REASON 🙂'.repeat(1000) } });
        await f.activity.reconcileDispatcherLease(); f.restart(); await f.drainBackground();
        const get = diagnosticsBrowser(f); const history = await diagnosticTraversal(get);
        const failed = history.records.find(record => record.kind === 'event' && record.outcome === 'failed'
          && record.code === 'settlement-failed');
        expect(failed).toMatchObject({ generation: 1, boundary: 'settlement', evidence: 'observed' });
        expect(failed!.capsuleId).toMatch(/^f-[0-9]+$/);
        const detail = await diagnosticJson<{ binding: unknown; record: DiagnosticRecord; capsule: Record<string, unknown> }>(
          await get(`${v2}/records/${failed!.id}`));
        expect(detail.binding).toEqual(binding);
        expect(detail.record).toEqual(failed);
        expect(detail.capsule).toMatchObject({ binding });
        expect(new TextEncoder().encode(JSON.stringify(detail.record)).byteLength).toBeLessThanOrEqual(4096);
        expect(new TextEncoder().encode(JSON.stringify(detail.capsule)).byteLength).toBeLessThanOrEqual(8192);
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
        await errorStatus(await get(`${v2}/records/o-1-${'0'.repeat(64)}`), 404);
      }, { repositoryOnly: true, recovery: true }));

      it('REQ-OPERATOR-081: AC4/5 export parts exhaust the same retained metadata with stable snapshot and public digests', () => fixture(async f => {
        await populateReads(f); await f.activity.cancelDrive(); const get = diagnosticsBrowser(f);
        const history = await diagnosticTraversal(get);
        const first = await page(get, '/export');
        f.advanceClock(60_000);
        const repeated = await page(get, '/export');
        expect(repeated.capturedAt).not.toBe(first.capturedAt);
        expect(first.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(first.partDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(repeated.snapshotDigest).toBe(first.snapshotDigest);
        expect(repeated.partDigest).toBe(first.partDigest);
        const exported = await diagnosticTraversal(get, `${v2}/export`, first);
        expect(exported.records).toEqual(history.records);
        for (const part of exported.pages) {
          expect(part.snapshotDigest).toBe(first.snapshotDigest);
          expect(part.partDigest).toMatch(/^[a-f0-9]{64}$/);
        }
        expect(new Set(exported.pages.map(part => part.partDigest)).size).toBe(exported.pages.length);
        expect(exported.pages.at(-1)).toMatchObject({ nextCursor: null, retainedStatus: 'complete' });
      }, options));

      it('REQ-OPERATOR-081: AC5 sealed history cursor survives reconstruction and fencing but fixes high-water', () => fixture(async f => {
        const { stamp, digests } = await populateReads(f); const get = diagnosticsBrowser(f);
        const first = await page(get); expect(first.nextCursor).toEqual(expect.any(String));
        expect((await f.capability.fetch(wire('source', { operationId: 'PRIVATE_AFTER_SNAPSHOT', url: sourceUrl }, stamp.deliveryToken))).status).toBe(200);
        await f.activity.cancelDrive(); f.restart(); await f.drainBackground();
        const resumed = await diagnosticTraversal(get, `${v2}/history`, first);
        expect(resumed.records.filter(record => record.kind === 'operation').map(record => record.id))
          .toEqual(digests.map(value => `o-1-${value}`));
        expect(resumed.records.map(record => record.id)).not.toContain(`o-1-${await digest('PRIVATE_AFTER_SNAPSHOT')}`);
        const fresh = await diagnosticTraversal(get);
        expect(fresh.records.map(record => record.id)).toContain(`o-1-${await digest('PRIVATE_AFTER_SNAPSHOT')}`);
      }, options));

      it.each(['tamper', 'foreign-activity', 'foreign-owner', 'duplicate', 'overlong', 'noncanonical'] as const)(
        'REQ-OPERATOR-081: AC5 sealed cursor rejects %s without releasing private evidence', fault => fixture(async f => {
          await populateReads(f); const get = diagnosticsBrowser(f); const first = await page(get);
          expect(first.nextCursor).toEqual(expect.any(String)); const cursor = first.nextCursor!;
          let suffix = `${v2}/history?cursor=${cursor}`;
          if (fault === 'tamper') suffix = `${v2}/history?cursor=${cursor[0] === 'A' ? 'B' : 'A'}${cursor.slice(1)}`;
          if (fault === 'duplicate') suffix += `&cursor=${cursor}`;
          if (fault === 'overlong') suffix = `${v2}/history?cursor=${'A'.repeat(4097)}`;
          if (fault === 'noncanonical') suffix = `${v2}/history?cursor=${cursor}%3D`;
          if (fault === 'foreign-activity') {
            // Valid exact-owner index for another Activity, backed by a separate existing SQLite fixture.
            await fixture(async other => {
              await start(other);
              await errorStatus(await diagnosticsBrowser(other)(suffix), 400);
            }, options);
          } else await errorStatus(await get(suffix, fault === 'foreign-owner' ? 'foreign@example.test' : 'owner@example.test'),
            fault === 'foreign-owner' ? 404 : 400);
        }, options));

      it.each(['inputDigest', 'artifactDigest'] as const)(
        'REQ-OPERATOR-081: AC5 cursor cannot cross changed original %s', field => fixture(async f => {
          await populateReads(f); const get = diagnosticsBrowser(f); const first = await page(get);
          expect(first.nextCursor).toEqual(expect.any(String));
          await f.changeRetiredPin(field);
          await errorStatus(await get(`${v2}/history?cursor=${first.nextCursor}`), 409);
        }, options));

      it('REQ-OPERATOR-081: AC5 durable owner changed during reads discards evidence even after initial index approval', () => fixture(async f => {
        await populateReads(f); await f.mutateEvidence(async storage => {
          const list = storage.list.bind(storage); let changed = false;
          vi.spyOn(storage, 'list').mockImplementation(async input => {
            const records = await list(input);
            if (!changed && input?.prefix?.startsWith('dispatcher:operation:')) {
              changed = true; const admission = await storage.get<Stored>('admission');
              await storage.put('admission', { ...admission, ownerKey: 'e'.repeat(64) });
            }
            return records;
          });
        });
        try { await errorStatus(await diagnosticsBrowser(f)(`${v2}/history`), 404); }
        finally { vi.restoreAllMocks(); }
      }, options));

      it.each(['/diagnostics/v2', '/diagnostics/v2/history', '/diagnostics/v2/records/e-1', '/diagnostics/v2/export'])(
        'REQ-OPERATOR-081: AC5 real owner boundary enforces authenticated session and selector precedence at %s', path => fixture(async f => {
          await populateReads(f); const get = diagnosticsBrowser(f);
          await errorStatus(await get(`${path}?body=true`), 400);
          await errorStatus(await get(`${path}?body=true`, 'foreign@example.test'), 404);
          await errorStatus(await get(`${path}?body=true`, 'owner@example.test', 'GET', 'absent-activity'), 404);
          await errorStatus(await get(path, ''), 401);
          f.revokeSession();
          await errorStatus(await get(path), 403);
          expect(await f.readRemoteComments()).toEqual([]);
        }, options));

      it('REQ-OPERATOR-081: AC5 binding changed during storage read discards the entire response', () => fixture(async f => {
        await populateReads(f); await f.mutateEvidence(async storage => {
          const list = storage.list.bind(storage); let changed = false;
          vi.spyOn(storage, 'list').mockImplementation(async input => {
            const values = await list(input);
            if (!changed && input?.prefix?.startsWith('dispatcher:operation:')) {
              changed = true; const lease = await storage.get<Stored>('dispatcher:lease');
              await storage.put('dispatcher:lease', { ...lease, inputDigest: 'e'.repeat(64) });
            }
            return values;
          });
        });
        await errorStatus(await diagnosticsBrowser(f)(`${v2}/history`), 409);
      }, options));

      it.each([undefined, '', 'invalid-key'])(
        'REQ-OPERATOR-081: AC5 cursor sealing fails closed without an existing valid encryption key (%s)', key => fixture(async f => {
          await populateReads(f); const originalKey = f.environment.ENCRYPTION_KEY;
          try {
            f.environment.ENCRYPTION_KEY = key as string;
            await errorStatus(await diagnosticsBrowser(f)(`${v2}/history`), 503);
          } finally { f.environment.ENCRYPTION_KEY = originalKey; }
        }, options));

      it('REQ-OPERATOR-081: AC4/5 storage read failure is unavailable rather than empty complete history', () => fixture(async f => {
        await populateReads(f); await f.mutateEvidence(async storage => {
          vi.spyOn(storage, 'list').mockImplementation(async () => { throw new Error('PRIVATE_STORAGE_ERROR'); });
        });
        try { await errorStatus(await diagnosticsBrowser(f)(`${v2}/history`), 503); }
        finally { vi.restoreAllMocks(); }
      }, options));

      it('REQ-OPERATOR-081: AC3/5 passive v2 reads cannot reopen retired facets consume results or replay uncertainty', () => fixture(async f => {
        await start(f); await discovery(f); const stamp = await context(f); f.loseResponse();
        const mutation = { operationId: 'PRIVATE_UNCERTAIN_V2', method: 'POST', url: sourceUrl, body: '{"body":"PRIVATE_EFFECT"}' };
        const uncertain = await f.capability.fetch(wire('source', mutation, stamp.deliveryToken));
        expect(uncertain.status).toBe(409); expect(await uncertain.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
        const remote = await f.readRemoteComments(); await f.activity.cancelDrive(); f.restart(); await f.drainBackground();
        const before = await f.environment.OPERATOR_ACTIVITY!.getByName(f.activityId).getBrowserDetail();
        await f.mutateEvidence(async storage => {
          const read = storage.get.bind(storage);
          vi.spyOn(storage, 'get').mockImplementation((async (key: string | string[]) => {
            if ((Array.isArray(key) ? key : [key]).some(value => value.startsWith('dispatcher:response:')))
              throw new Error('PRIVATE_BODY_READ');
            return read(key as string);
          }) as typeof storage.get);
        });
        const get = diagnosticsBrowser(f); await diagnosticJson(await get());
        const history = await diagnosticTraversal(get); await diagnosticTraversal(get, `${v2}/export`);
        for (const record of history.records) await diagnosticJson(await get(`${v2}/records/${record.id}`));
        await noOwnedRuntimeRead(f);
        expect(await f.environment.OPERATOR_ACTIVITY!.getByName(f.activityId).getBrowserDetail()).toEqual(before);
        await deny(await f.capability.fetch(wire('source', mutation, stamp.deliveryToken)));
        await deny(await f.capability.fetch(wire('source', { ...mutation, body: '{"body":"changed"}' }, stamp.deliveryToken)));
        expect(await f.readRemoteComments()).toEqual(remote);
        expect((await get('/continue', 'owner@example.test', 'POST')).status).toBe(409);
      }, { ...options, facetContract: true }));

      it('REQ-OPERATOR-081: AC2/4/5 routine eviction preserves pinned originating failure and invalidates old epoch cursor', () => fixture(async f => {
        await start(f, 250_000); await diagnosticSummary(f);
        const inference = genericWire('inference', { operationId: 'PRIVATE_OVERFLOW_MODEL',
          input: { messages: [{ role: 'user', content: 'PRIVATE_MODEL_INPUT' }] } });
        const response = await f.capability.fetch(inference);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        for (let index = 0; index < 40; index++) expect((await f.capability.fetch(genericWire('source', {
          operationId: `PRIVATE_BEFORE_RETENTION_${index}`, url: sourceUrl,
        }))).status).toBe(200);
        await f.drainBackground();
        const get = diagnosticsBrowser(f); const first = await page(get);
        expect(first.nextCursor).toEqual(expect.any(String));
        const initial = await diagnosticTraversal(get);
        const failure = initial.records.find(record => record.kind === 'event' && record.code === 'provider-failed');
        expect(failure).toMatchObject({ generation: 1, boundary: 'model', evidence: 'observed' });
        expect(failure!.capsuleId).toMatch(/^f-[0-9]+$/);
        // Generate ordinary host-owned metadata, not native multi-target SDK workloads.
        for (let index = 0; index < 1600; index++) expect((await f.capability.fetch(genericWire('source', {
          operationId: `PRIVATE_RETENTION_${index}`, url: sourceUrl,
        }))).status).toBe(200);
        await f.drainBackground();
        const after = await diagnosticSummary(f);
        expect(after.retention.evictedRoutine).toBeGreaterThan(0);
        expect(after.retention.epoch).not.toBe(first.retention.epoch);
        expect(after.health.status).toBe('loss');
        const retained = await diagnosticTraversal(get);
        expect(retained.pages.at(-1)?.retainedStatus).toBe('loss');
        expect(retained.records).toContainEqual(failure);
        expect(retained.records.filter(record => record.kind === 'event').length).toBeLessThanOrEqual(1536 + 128);
        const detail = await diagnosticJson<{ record: DiagnosticRecord; capsule: Record<string, unknown> }>(
          await get(`${v2}/records/${failure!.id}`));
        expect(detail.record).toEqual(failure);
        expect(detail.capsule).toMatchObject({ binding: after.binding });
        await errorStatus(await get(`${v2}/history?cursor=${first.nextCursor}`), 409);
        expect(['recovered-failure', 'evidence-incomplete']).toContain(after.diagnosis.state);
      }, { repositoryOnly: true, recovery: true, inferenceAttemptLimit: 2, operationLimit: 2000,
        capacityPolicy: { inferenceRetryBaseMs: 1, inferenceRetryMaxMs: 1 },
        inferenceTransport: async (_request, attempt) => {
          if (attempt === 1) throw new Error('PRIVATE_ORIGINATING_PROVIDER_FAILURE');
          return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
        } }));

      it('REQ-OPERATOR-081: AC1/2/4 independent recovered failures exhaust capsules without merging attempts or changing output', () => fixture(async f => {
        await start(f, 250_000); await diagnosticSummary(f);
        for (let index = 0; index < 65; index++) {
          const response = await f.capability.fetch(genericWire('inference', { operationId: `PRIVATE_FAILURE_${index}`,
            input: { messages: [{ role: 'user', content: 'PRIVATE_PROMPT' }] } }));
          expect(response.status).toBe(200);
          expect(await response.text()).toBe('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
        }
        await f.drainBackground(); f.restart(); await f.drainBackground();
        const summary = await diagnosticSummary(f);
        expect(summary.retention.droppedFailure).toBeGreaterThan(0);
        expect(summary.retention.droppedTerminal).toBe(0);
        expect(summary.health.status).toBe('loss');
        expect(['recovered-failure', 'evidence-incomplete']).toContain(summary.diagnosis.state);
        const history = await diagnosticTraversal(diagnosticsBrowser(f));
        const failures = history.records.filter(record => record.kind === 'event' && record.code === 'provider-failed'
          && record.correlation?.hostAttemptIndex === 1);
        expect(new Set(failures.map(record => record.correlation?.logicalOrdinal)).size).toBe(65);
        const pinned = failures.filter(record => record.capsuleId !== undefined);
        expect(pinned.length).toBeLessThanOrEqual(64);
        expect(pinned.length).toBeGreaterThan(0);
        expect(pinned[0].id).toBe(failures[0].id);
        expect(failures.at(-1)?.capsuleId).toBeUndefined();
        expect(history.pages.at(-1)?.retainedStatus).toBe('loss');
        expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
        // Controlled retained snapshots isolate causality: another operation's later
        // completion or recovery cannot settle this independent originating failure.
        const failed = { ...failures.at(-1)!, id: 'e-9000', sequence: 9000 };
        delete failed.capsuleId;
        const unrelated = history.records.find(record => record.kind === 'event' && record.outcome === 'completed'
          && record.correlation?.logicalOrdinal !== undefined
          && record.correlation.logicalOrdinal !== failed.correlation?.logicalOrdinal)!;
        expect(unrelated).toBeDefined();
        await seedDiagnosticSnapshot(f, [failed, { ...unrelated, id: 'e-9001', sequence: 9001 }]);
        expect((await diagnosticSummary(f)).diagnosis).toMatchObject({ state: 'observed-failure', failedId: failed.id });
        // Controlled recovery metadata must keep its event/source boundary consistent.
        const unrelatedRecovery = { ...unrelated, id: 'e-9001', sequence: 9001, boundary: 'recovery', outcome: 'recovered',
          source: { ...(unrelated.source as Record<string, unknown>), boundary: 'recovery' } };
        await seedDiagnosticSnapshot(f, [failed, unrelatedRecovery]);
        expect((await diagnosticSummary(f)).diagnosis).toMatchObject({ state: 'observed-failure', failedId: failed.id });
        const correlatedFailure = { ...failed, correlation: { ...failed.correlation, sdkAttemptDigest: 'a'.repeat(64) } };
        const conflictingRecovery = { ...unrelatedRecovery,
          correlation: { ...correlatedFailure.correlation, sdkAttemptDigest: 'b'.repeat(64) } };
        await seedDiagnosticSnapshot(f, [correlatedFailure, conflictingRecovery]);
        expect((await diagnosticSummary(f)).diagnosis.state).toBe('observed-failure');
        const matchingRecovery = { ...conflictingRecovery, correlation: { ...correlatedFailure.correlation, hostAttemptIndex: 2 } };
        await seedDiagnosticSnapshot(f, [correlatedFailure, matchingRecovery,
          { ...unrelatedRecovery, id: 'e-9002', sequence: 9002 }]);
        expect((await diagnosticSummary(f)).diagnosis.state).toBe('recovered-failure');
      }, { repositoryOnly: true, recovery: true, inferenceAttemptLimit: 2, operationLimit: 256,
        capacityPolicy: { inferenceRetryBaseMs: 1, inferenceRetryMaxMs: 1 },
        inferenceTransport: async (_request, attempt) => {
          // Same error fingerprint in genuinely different logical/charged attempts.
          if (attempt % 2 === 1) throw new Error('PRIVATE_SAME_ERROR_DIFFERENT_ATTEMPT');
          return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
        } }));

      it('REQ-OPERATOR-081: AC3 essential logging-OFF cancellation reason is readable before SDK cleanup completes', () => fixture(async f => {
        await start(f); const sdk = Agent.prototype as unknown as { _cf_cleanupFacetPrefix: (...args: unknown[]) => Promise<void> };
        const cleanup = sdk._cf_cleanupFacetPrefix;
        let entered!: () => void; let release!: () => void;
        const observing = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(sdk, '_cf_cleanupFacetPrefix').mockImplementation(async function (this: Agent, ...args: unknown[]) {
          entered(); await held; return cleanup.apply(this, args);
        });
        const cancellation = f.activity.cancelDrive();
        try {
          await observing;
          expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested', result: null });
          const summary = await diagnosticSummary(f);
          expect(summary).toMatchObject({ capture: 'disabled', binding: { generation: 1, artifactDigest: f.artifactDigest },
            fence: { code: 'cancelled', boundary: 'fence' } });
          expect((await f.capability.fetch(genericWire('source', { operationId: 'no-write-during-cleanup', url: sourceUrl }))).status).toBe(403);
        } finally { release(); await cancellation; }
        expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'cancel-requested', sdkCleanupReleased: true });
      }, { repositoryOnly: true, loggingEnabled: false }));

      it('REQ-OPERATOR-081: AC5 a stalled metadata read shares one ten-second observation bound', () => fixture(async f => {
        await populateReads(f); let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        await f.mutateEvidence(async storage => {
          const list = storage.list.bind(storage);
          vi.spyOn(storage, 'list').mockImplementation(async input => { await held; return list(input); });
        });
        const started = Date.now();
        try {
          await errorStatus(await diagnosticsBrowser(f)(`${v2}/history`), 503);
          expect(Date.now() - started).toBeLessThanOrEqual(10_500);
        } finally { release(); vi.restoreAllMocks(); }
      }, options), 15_000);

      it('REQ-OPERATOR-081: AC4/7 uncaptured historical unknown state stays incomplete with platform-required capability', () => fixture(async f => {
        await start(f);
        // Represent an already-retained pre-capture fence. This is NOT a claim
        // that a JavaScript catch observed a platform hard kill or its cause.
        await f.mutateEvidence(async storage => {
          const admission = await storage.get<Stored>('admission');
          const lease = await storage.get<Stored>('dispatcher:lease');
          await storage.put('admission', { ...admission, drive: { ...(admission!.drive as Stored),
            generation: 2, status: 'unknown' } });
          await storage.put('dispatcher:lease', { ...lease, status: 'unknown', sdkReleased: true });
        });
        f.restart(); await f.drainBackground();
        const summary = await diagnosticSummary(f);
        expect(summary.diagnosis).toMatchObject({ state: 'evidence-incomplete', failedId: null });
        expect(summary.diagnosis.nextCheck).not.toBe('none');
        expect(summary.capabilities).toEqual(expect.arrayContaining([
          expect.objectContaining({ boundary: 'platform', availability: 'platform-required' }),
        ]));
        expect((await f.capability.fetch(genericWire('source', { operationId: 'platform-no-replay', url: sourceUrl }))).status).toBe(403);
        expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      }, { repositoryOnly: true, loggingEnabled: false }));

      it('REQ-OPERATOR-081: AC4/5 retained diagnostics survive final automatic collection without changing v1', () => fixture(async f => {
        await setup(f); await finish(f); const get = diagnosticsBrowser(f);
        const before = await f.activity.getBrowserDetail();
        const v1 = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
        const summary = await diagnosticSummary(f);
        expect(summary.binding).toMatchObject({ generation: 1, artifactDigest: f.artifactDigest });
        expect(['no-failure-observed', 'evidence-incomplete']).toContain(summary.diagnosis.state);
        const history = await diagnosticTraversal(get);
        expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'event', boundary: 'settlement' })]));
        await diagnosticTraversal(get, `${v2}/export`);
        expect(await f.activity.getBrowserDetail()).toEqual(before);
        const afterV1 = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
        const { capturedAt: _before, ...oldWire } = v1!;
        const { capturedAt: _after, ...newWire } = afterV1!;
        expect(newWire).toEqual(oldWire);
        expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { result: finalResult(f) } });
      }, options));
    });

    it.each(['', '-1', '-0', '1.5', '9007199254740992', 'bad', '%20', '999', '0&receiptAfter=1']) (
      'REQ-OPERATOR-041: AC5 invalid receipt ordinal is rejected: %s', cursor => fixture(async f => {
        await setup(f); await f.activity.cancelDrive(); const get = browser(f);
        expect((await get(`/result?receiptAfter=${cursor}`)).status).toBe(400);
        expect((await get(`/result?receiptAfter=${cursor}`, 'foreign@example.test')).status).toBe(404);
      }, options));

    it.each(['count', 'duplicateOrdinal', 'missingOrdinal', 'unclassified', 'listFailure']) (
      'REQ-OPERATOR-041: AC5 damaged enumeration cannot fabricate empty complete history: %s', fault => fixture(async f => {
        await setup(f, 2); await f.activity.cancelDrive();
        if (fault === 'count') await patch(f, 'dispatcher:journal', value => ({ ...value, count: 99 }));
        else if (fault === 'listFailure') await f.mutateEvidence(async storage => {
          const list = storage.list.bind(storage);
          vi.spyOn(storage, 'list').mockImplementation(async input => {
            if (input?.prefix?.startsWith('dispatcher:operation:')) throw new Error('PRIVATE_STORAGE_ERROR');
            return list(input);
          });
        });
        else await faultWrite(f, async (record, storage, key) => {
          const other = [...await storage.list<Stored>({ prefix: 'dispatcher:operation:1:' })].find(([id]) => id !== key);
          return { ...record, ...(fault === 'duplicateOrdinal' ? { ordinal: other![1].ordinal }
            : fault === 'missingOrdinal' ? { ordinal: undefined } : { request: undefined, inference: undefined }) };
        });
        const body = await read(browser(f));
        expect(body.executionStatus).toBe('cancel-requested');
        if (fault === 'unclassified') expect(body.effectReceipts!.unclassifiedEntries).toBeGreaterThan(0);
        else expect(body.effectReceipts!.scan).not.toBe('complete');
        expect(JSON.stringify(body)).not.toContain('PRIVATE_STORAGE_ERROR');
      }, options));

    it('REQ-OPERATOR-041: AC5 selection changed during awaited storage reads is unavailable', () => fixture(async f => {
      await setup(f); await f.activity.cancelDrive();
      await f.mutateEvidence(async storage => {
        const list = storage.list.bind(storage); let changed = false;
        vi.spyOn(storage, 'list').mockImplementation(async input => {
          const entries = await list(input);
          if (!changed && input?.prefix?.startsWith('dispatcher:operation:')) {
            changed = true; const lease = await storage.get<Stored>('dispatcher:lease');
            await storage.put('dispatcher:lease', { ...lease, inputDigest: 'e'.repeat(64) });
          }
          return entries;
        });
      });
      unavailable(await read(browser(f)));
    }, options));

    it('REQ-OPERATOR-041: AC7 result-only scope preserves detail and collection responses', () => fixture(async f => {
      await setup(f); const get = browser(f);
      expect(await (await get()).json()).not.toHaveProperty('effectReceipts');
      await f.activity.cancelDrive(); const detail = await (await get('')).json();
      expect(detail).not.toHaveProperty('effectReceipts');
      expect((await get('/result', 'owner@example.test', 'POST')).status).toBe(409);
      expect((await get('/result', 'foreign@example.test')).status).toBe(404);
      expect((await get('/result', '')).status).toBe(401);
      expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
        result: finalResult(f) })).toMatchObject({ ok: false, reason: 'stale-drive' });
    }, options));

    it('REQ-OPERATOR-041: AC2 existing access and ownership gates still protect receipt reads', () => fixture(async f => {
      await setup(f); await f.activity.cancelDrive(); const get = browser(f);
      expect((await get()).status).toBe(200);
      expect((await get('/result', 'foreign@example.test')).status).toBe(404);
      expect((await get('/result', '')).status).toBe(401);
      vi.spyOn(access, 'requireOperatorHumanContext').mockRejectedValue(new AppError('FORBIDDEN', 403, 'Authentication rejected'));
      expect((await get()).status).toBe(403);
    }, options));

    it('REQ-OPERATOR-041: AC3 repeated GET preserves the automatically collected terminal assessment', () => fixture(async f => {
      await start(f); await discovery(f); let stamp = await context(f);
      for (const index of [0, 1]) {
        progress(f, stamp, index === 0 ? { kind: 'target', index: 1, target: frozen[1] } : { kind: 'final' },
          { results: rows.slice(0, index + 1) });
        await f.activity.reconcileDispatcherLease(); stamp = await context(f);
      }
      f.messages([{ submissionId: stamp.submissionId, parts: [{ type: 'data-assessment', data: finalResult(f) }] }]);
      f.settle(stamp.submissionId); await f.activity.reconcileDispatcherLease(); const get = browser(f);
      // Intent4 reconciliation already collects its completed final assessment.
      // A history GET must preserve that terminal proof, not invent a ready interval.
      for (let index = 0; index < 2; index++) expect(await (await get()).json()).toMatchObject({
        collectionStatus: 'consumed', result: finalResult(f), executionStatus: 'completed' });
      expect((await get('/result', 'owner@example.test', 'POST')).status).toBe(200);
      expect(await (await get()).json()).toMatchObject({ collectionStatus: 'consumed', result: finalResult(f) });
    }, options));

    it('REQ-OPERATOR-017: AC4 history reads cannot restart a cancelled original drive', () => fixture(async f => {
      const stamp = await setup(f); await f.activity.cancelDrive(); const get = browser(await coldOwner(f));
      expect((await get()).status).toBe(200); expect((await get()).status).toBe(200);
      expect((await get('/continue', 'owner@example.test', 'POST')).status).toBe(409);
      await deny(await f.capability.fetch(wire('source', { operationId: 'old-after-history', method: 'POST',
        url: sourceUrl, body: '{"body":"must not restart"}' }, stamp.deliveryToken)));
      expect(await f.readRemoteComments()).toMatchObject([{ id: 91 }]);
    }, options));

    it('REQ-OPERATOR-017: AC5 late original completion stays stale after history reads', () => fixture(async f => {
      await setup(f); await f.activity.cancelDrive(); const get = browser(f); expect((await get()).status).toBe(200);
      expect(await f.activity.commitDrive(1, { schemaVersion: 1, status: 'completed', checkpoint: null,
        result: finalResult(f) })).toMatchObject({ ok: false, reason: 'stale-drive' });
      expect(await (await get()).json()).toMatchObject({ executionStatus: 'cancel-requested', result: null, collectionStatus: 'unavailable' });
    }, options));

    it('REQ-OPERATOR-048: AC5 cancelled delivery cannot use protected operations after a receipt GET', () => fixture(async f => {
      const stamp = await setup(f); const remote = await f.readRemoteComments(); await f.activity.cancelDrive();
      expect((await browser(f)()).status).toBe(200);
      for (const request of [...protectedRequests(stamp.deliveryToken),
        wire('receipt', { operationId: 'PRIVATE_OPERATION_0' }, stamp.deliveryToken),
        wire('resolve', { operationId: 'PRIVATE_OPERATION_0', readbacks: [] }, stamp.deliveryToken)])
        await deny(await f.capability.fetch(request));
      expect(await f.readRemoteComments()).toEqual(remote);
    }, options));

    it('REQ-OPERATOR-048: AC3 history authentication cannot renew the original execution expiry', () => fixture(async f => {
      const stamp = await setup(f); await f.activity.cancelDrive(); f.expire(); const get = browser(f);
      expect((await get()).status).toBe(200);
      for (const request of protectedRequests(stamp.deliveryToken)) await deny(await f.capability.fetch(request));
      expect((await get('/continue', 'owner@example.test', 'POST')).status).toBe(409);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, options));

    it('REQ-OPERATOR-047: AC4 observation cannot replay an uncertain remote mutation', () => fixture(async f => {
      await start(f); await discovery(f); const stamp = await context(f); f.loseResponse();
      const mutation = { operationId: 'uncertain-history', method: 'POST', url: sourceUrl, body: '{"body":"Original uncertainty"}' };
      const uncertain = await f.capability.fetch(wire('source', mutation, stamp.deliveryToken));
      expect(uncertain.status).toBe(409);
      expect(await uncertain.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
      const remote = await f.readRemoteComments(); await f.activity.cancelDrive(); const get = browser(f);
      expect((await get()).status).toBe(200); expect((await get()).status).toBe(200);
      await deny(await f.capability.fetch(wire('source', mutation, stamp.deliveryToken)));
      await deny(await f.capability.fetch(wire('source', { ...mutation, body: '{"body":"Changed uncertainty"}' }, stamp.deliveryToken)));
      expect(await f.readRemoteComments()).toEqual(remote);
    }, options));

    it('REQ-OPERATOR-047: AC5 immutable cached response bytes survive non-consuming history reads', () => fixture(async f => {
      await start(f); await discovery(f); const stamp = await context(f);
      const mutation = { operationId: 'immutable-history', method: 'POST', url: sourceUrl, body: '{"body":"Immutable response contract"}' };
      const first = await f.capability.fetch(wire('source', mutation, stamp.deliveryToken)); const bytes = await first.text();
      expect((await browser(f)()).status).toBe(200);
      expect(await (await f.capability.fetch(wire('source', mutation, stamp.deliveryToken))).text()).toBe(bytes);
      expect(await f.readRemoteComments()).toMatchObject([{ id: 91, body: 'Immutable response contract' }]);
      await f.activity.cancelDrive(); expect((await browser(f)()).status).toBe(200);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, options));

    it('REQ-OPERATOR-048: AC7 historical unkeyed reads do not gain serial receipt authority', () => fixture(async f => {
      await start(f); await f.activity.cancelDrive(); const get = browser(f);
      const body = await (await get()).json(); expect(body).not.toHaveProperty('effectReceipts');
      expect(body).toMatchObject({ executionStatus: 'cancel-requested', result: null });
      expect((await f.capability.fetch(genericWire('source', { operationId: 'historical-after-read', url: sourceUrl }))).status).toBe(403);
    }, { repositoryOnly: true }));

    it.each(['notMerged', 'invalidSha', 'wrongStatus']) (
      'REQ-OPERATOR-041: AC5 a merge cache cannot counterfeit success: %s', fault => fixture(async f => {
        const stamp = await setup(f);
        expect((await f.capability.fetch(wire('source', { operationId: 'merge-fault', method: 'PUT',
          url: 'https://api.github.com/repos/another/service/pulls/17/merge',
          body: JSON.stringify({ sha: frozen[0].headSha, merge_method: 'merge' }) }, stamp.deliveryToken))).status).toBe(200);
        await f.activity.cancelDrive();
        await faultWrite(f, async (record, storage, key) => {
          const responseKey = `dispatcher:response:${key.slice('dispatcher:operation:1:'.length)}`;
          const response = await storage.get<{ status: number; contentType: string; body: string }>(responseKey);
          const envelope = JSON.parse(response!.body) as { status: number; body: string };
          const upstream = JSON.parse(envelope.body) as { sha: string; merged: boolean };
          if (fault === 'notMerged') upstream.merged = false;
          if (fault === 'invalidSha') upstream.sha = 'not-a-sha';
          if (fault === 'wrongStatus') envelope.status = 201;
          envelope.body = JSON.stringify(upstream); const body = JSON.stringify(envelope);
          await storage.put(responseKey, { ...response, body }); return { ...record, responseDigest: await digest(body) };
        }, 'PUT');
        const body = await read(browser(f)); const item = body.effectReceipts!.items.find(row => row.method === 'PUT');
        expect(item).toMatchObject({ binding: 'unresolved' }); expect(item).not.toHaveProperty('observedResponse');
      }, options));

    it('REQ-OPERATOR-041: AC5 a reserved mutation cannot adopt an intact cached success', () => fixture(async f => {
      await setup(f); await f.activity.cancelDrive();
      await faultWrite(f, async record => ({ ...record, phase: 'reserved' }));
      await patch(f, 'dispatcher:journal', record => ({ ...record, unresolved: 1 }));
      const body = await read(browser(f)); expect(body.effectReceipts!.items).toMatchObject([{ journalPhase: 'reserved', binding: 'unresolved' }]);
      expect(body.effectReceipts!.items[0]).not.toHaveProperty('observedResponse');
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, options));

    it('REQ-OPERATOR-041: AC5 unresolved mutations occupy their original page position', () => fixture(async f => {
      await setup(f, 9); await f.activity.cancelDrive();
      await faultWrite(f, async record => ({ ...record, phase: 'unknown' }));
      await patch(f, 'dispatcher:journal', record => ({ ...record, unresolved: 1 }));
      const get = browser(f); const first = (await read(get)).effectReceipts!;
      const second = (await read(get, first.nextAfterOrdinal!)).effectReceipts!;
      const items = [...first.items, ...second.items];
      expect(items).toHaveLength(9); expect(new Set(items.map(item => item.ordinal)).size).toBe(9);
      const uncertain = items.filter(item => item.journalPhase === 'unknown');
      expect(uncertain).toHaveLength(1); expect(uncertain[0]).toMatchObject({ binding: 'unresolved' });
      expect(uncertain[0]).not.toHaveProperty('observedResponse');
      expect(second).toMatchObject({ pageStatus: 'complete', unresolvedJournalEntries: 1 });
    }, options));
  });
});
/** Parent HTTP/Activity contracts only; generated Flue lifecycle is qualified in Dispatcher CI. */
describe('normal installed Dispatcher control', () => {
  const options = { normalHosting: true, repositoryOnly: true };
  const source = { operationId: 'normal-read', url: 'https://api.github.com/repos/another/service' };
  const result = { repository: 'another/service', results: [] };
  const control = (f: DispatcherFixture, path: string) => f.normalTransport!.requests.filter(request => request.path === `/control/${path}`);
  const callback = (f: DispatcherFixture, path: string, body: unknown, headers?: Record<string, string>) =>
    f.installationCapability.fetch(normalCallback(f.activityId, path, body, headers));
  const cold = async (f: DispatcherFixture) => {
    const activity = f.restart(); await f.drainBackground(); await activity.getAdmission(); await f.drainBackground(); return activity;
  };
  const stable = (value: Awaited<ReturnType<OperatorActivity['collectBrowserResult']>>) => {
    if (!value.ok) return value;
    const { updatedAt: _observationTimestamp, ...detail } = value.detail;
    return { ok: true, detail };
  };

  it('REQ-OPERATOR-048: AC1/6 trusted installation starts through public keyed control without a per-Activity Loader', () => fixture(async f => {
    const started = await start(f);
    expect(started).toMatchObject({ ok: true, state: { generation: 1, status: 'running' } });
    const sent = control(f, 'dispatch');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ authorization: `Bearer ${connectionSecret}`, body: {
      id: `${f.activityId}-g1`, installationId: 'installation', activityId: f.activityId, generation: 1,
      releaseId: 'release', connectionRevision: 1, workerVersionId: normalDeployment.workerVersionId,
      idempotencyKey: expect.any(String), message: expect.anything(), initialData: expect.anything(),
    } });
    expect(sent[0].body.uid).toBeUndefined();
    expect(JSON.stringify(sent[0].body.initialData)).toContain('another/service');
    expect(JSON.stringify(sent[0].body)).not.toMatch(/fixture-installation-secret|private\.jwt|parent-only|synthetic-native-access|connectionSecretCiphertext/);
    const accepted = [...f.normalTransport!.admissions.values()][0].receipt;
    await f.mutateEvidence(async storage => {
      expect(await storage.get('dispatcher:lease')).toMatchObject({ hosting: 'normal', receipt: accepted });
    });
    const permitted = await callback(f, 'source', source);
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toMatchObject({ status: 200, url: source.url });
  }, options));

  it('REQ-OPERATOR-007/048: normal managed lifecycle retains verified routes without personal/native approvals', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ inferenceSelection: {
      source: 'managed', routeId: 'approved', reasoningLevel: 'off' } });
    expect((await callback(f, 'source', source)).status).toBe(200);
  }, options));

  it('REQ-OPERATOR-007: normal managed policy preserves provider-default instead of inheriting Off or caller reasoning', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    expect(await f.activity.getBrowserDetail()).toMatchObject({ inferenceSelection: {
      source: 'managed', routeId: 'approved', reasoningLevel: null } });
    const response = await callback(f, 'inference', { operationId: 'managed-default',
      context: { messages: [{ role: 'user', content: 'Use the admitted SDK default' }] }, options: { reasoning: 'high' } });
    expect(response.status).toBe(200);
    const value = await response.json() as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(value.result.content[0].text).options).toEqual({});
  }, { ...options, managedProviderDefault: true }));

  it('REQ-OPERATOR-048: non-inference normal work requires no owner SDK profile or inference approval', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    expect(control(f, 'dispatch')[0].body.initialData).not.toHaveProperty('selection');
    expect((await callback(f, 'source', source)).status).toBe(200);
    expect((await callback(f, 'inference', { operationId: 'not-granted', context: { messages: [{ role: 'user', content: 'Denied' }] },
      options: {} })).status).toBe(403);
  }, { ...options, capabilities: ['fetch'] }));

  it('REQ-OPERATOR-007: AC2/3 configured owner callback preserves normalized tools metadata and SDK results without replay', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    const context = { systemPrompt: 'Preserve normalized context', messages: [{ role: 'user', content: 'Configured owner' }],
      tools: [{ name: 'read_owned', description: 'Finite input', parameters: { type: 'object', properties: {} } }],
      metadata: { trace: 'opaque-user-metadata' } };
    const input = { operationId: 'normal-configured-sdk', context, options: { reasoning: 'low', maxTokens: 128 } };
    const response = await callback(f, 'inference', input);
    expect(response.status).toBe(200);
    const result = await response.json() as { result: { content: Array<{ type: string; text: string }> } };
    expect(result).toMatchObject({ result: { role: 'assistant', provider: 'configured-provider', model: 'saved-model' } });
    expect(JSON.parse(result.result.content[0].text)).toEqual({ context, options: input.options, ordinal: 1 });
    expect((await callback(f, 'inference', input)).status).toBe(200);
    expect(await (await callback(f, 'inference', input)).json()).toEqual(result);
    const receipt = await callback(f, 'receipt', { operationId: input.operationId });
    expect(receipt.status).toBe(403);
    expect(await receipt.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'receipt-unavailable' });
    expect((await callback(f, 'inference', { ...input, context: { ...context, systemPrompt: 'Changed' } })).status).toBe(409);
  }, { ...options, nativeInference: true }));

  it('REQ-OPERATOR-003/047: production parent context is bound to the live owner source and cannot be borrowed by a foreign container', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    const lookup = () => new Request('https://operator.internal/v1/dispatcher/owner-context', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ activityId: f.activityId, generation: 1 }) });
    const authority = (bucket: string) => new OperatorOwnerInferenceAuthority({ props: {
      bucket, sessionId: 'ownerhost123', email: 'owner@example.test' } } as unknown as ExecutionContext, f.environment);
    const response = await authority('owner-bucket').fetch(lookup());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sessionId: 'ownerhost123', sessionGeneration: 3,
      selection: { provider: 'configured-provider', model: 'saved-model' } });
    expect((await authority('foreign-bucket').fetch(lookup())).status).toBe(403);
    f.revokeSession();
    expect((await authority('owner-bucket').fetch(lookup())).status).toBe(403);
  }, { ...options, nativeInference: true }));

  it('REQ-OPERATOR-007/047: closed owner SDK missing-auth evidence survives without diagnostics and cannot enable fallback', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true }); f.refuseNormalHostAuth();
    const input = { operationId: 'missing-owner-auth', context: { messages: [{ role: 'user', content: 'No credential guessing' }] },
      options: { reasoning: 'low', maxTokens: 128 } };
    expect((await callback(f, 'inference', input)).status).not.toBe(200);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ authFailure: {
      code: 'PI_LOGIN_REQUIRED', reason: 'missing', provider: 'configured-provider' } });
    expect((await callback(f, 'inference', { ...input, operationId: 'not-a-login-retry' })).status).toBe(403);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { ...options, nativeInference: true, loggingEnabled: false }));

  it('REQ-OPERATOR-048: receiver authorization retains original fenced abort after live connection rotation but cannot fence or start work', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    const wire = control(f, 'dispatch')[0].body;
    const receipt = [...f.normalTransport!.admissions.values()][0].receipt;
    const { id, installationId, activityId, generation, releaseId, connectionRevision, workerVersionId } = wire;
    const original = { id, installationId, activityId, generation, releaseId, connectionRevision, workerVersionId, receipt };
    expect((await callback(f, 'abort-authority', original)).status).toBe(403);
    expect(await f.activity.cancelDrive()).toMatchObject({ ok: true, state: { status: 'cancel-requested' } });
    f.changeConnection({ connectionRevision: 2, workerVersionId: 'new-version', connectionSecretCiphertext: 'v1:unverified-rotation' });
    const authorized = await callback(f, 'abort-authority', original);
    expect(authorized.status).toBe(200); expect(await authorized.json()).toEqual({ id, uid: receipt.uid });
    expect((await callback(f, 'abort-authority', { ...original, id: 'foreign-job' })).status).toBe(403);
    expect((await callback(f, 'source', source)).status).toBe(403);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, options));

  it('REQ-OPERATOR-007/047: normal serial inference is Activity-scoped while protected tools still require the original phase token', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
    expect([...f.normalTransport!.admissions.values()]).toMatchObject([{ receipt: { submissionId: expect.any(String), uid: expect.any(String) } }]);
    const response = await callback(f, 'inference', { operationId: 'serial-owner-model',
      context: { messages: [{ role: 'user', content: 'Assess the original phase' }] }, options: { reasoning: 'low', maxTokens: 128 } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { role: 'assistant', provider: 'configured-provider' } });
    expect((await callback(f, 'source', source)).status).toBe(403);
  }, { ...options, nativeInference: true, intent4: true }));

  // Installed HTTP / real parent Activity only, not generated SDK startup execution.
  type InstalledPhaseContext = { scope: string; generation: number; deadline: string; submissionId: string;
    deliveryToken: string; phase: { kind: string }; previous?: Array<{ submissionId: string; phase: unknown; outcome: string }> };
  const phaseToken = (f: DispatcherFixture) => (control(f, 'dispatch').at(-1)!.body.message as {
    attributes: { deliveryToken: string } }).attributes.deliveryToken;
  const installedContext = (f: DispatcherFixture, token: string, headers: Record<string, string> = {}) =>
    f.installationCapability.fetch(normalCallback(f.activityId, 'phase-context', { deliveryToken: token },
      { 'x-codeflare-dispatcher-delivery': token, ...headers }));

  it('REQ-OPERATOR-048/062: AC2 installed phase context joins original pending HTTP202 and advances only its serial receipt', () => fixture(async f => {
    const acknowledgement = f.normalTransport!.delayAcknowledgement();
    const starting = start(f);
    let pending: Promise<Response> | undefined;
    try {
      await within(acknowledgement.entered, 'original external admission accepted before HTTP202');
      const token = phaseToken(f);
      const original = [...f.normalTransport!.admissions.values()][0];
      expect(f.normalTransport!.admissions.size).toBe(1);
      expect(f.sent).toEqual([]);
      expect(f.ownerPortRequests).toEqual([]);
      // A foreign delivery cannot use an in-flight acknowledgement as authority.
      expect((await within(installedContext(f, 'foreign-delivery'), 'pre-ack foreign context denial')).status).toBe(403);
      pending = installedContext(f, token);
      acknowledgement.release();
      expect(await within(starting, 'original HTTP202 binding')).toMatchObject({ ok: true, state: { generation: 1, status: 'running' } });
      const response = await within(pending, 'installed original phase context');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const stamp = await response.json() as InstalledPhaseContext;
      expect(stamp).toMatchObject({ scope: 'submission', generation: 1, submissionId: original.receipt.submissionId,
        deliveryToken: token, phase: { kind: 'discovery' } });
      expect(stamp.previous).toBeUndefined();
      expect(f.normalTransport!.admissions.size).toBe(1);
      expect([...f.normalTransport!.admissions.values()][0]).toEqual(original);
      expect(f.sent).toEqual([]);
      expect(f.ownerPortRequests).toEqual([]);

      const target = { pullRequest: 17, headSha: '1'.repeat(40) };
      const next = { kind: 'target', index: 0, target };
      f.normalTransport!.settle('completed', [{ name: 'dispatcher-progress', data: {
        version: 1, scope: stamp.scope, generation: stamp.generation, submissionId: stamp.submissionId,
        phase: stamp.phase, next, targets: [target],
      } }]);
      await f.activity.reconcileDispatcherLease();
      const nextToken = phaseToken(f);
      expect(nextToken).not.toBe(token);
      expect(f.normalTransport!.admissions.size).toBe(2);
      const nextResponse = await within(installedContext(f, nextToken), 'next installed serial phase context');
      expect(nextResponse.status).toBe(200);
      const nextStamp = await nextResponse.json() as InstalledPhaseContext;
      const nextReceipt = [...f.normalTransport!.admissions.values()][1].receipt;
      expect(nextStamp).toMatchObject({ scope: stamp.scope, generation: stamp.generation, deadline: stamp.deadline,
        submissionId: nextReceipt.submissionId, deliveryToken: nextToken, phase: next,
        previous: [{ submissionId: stamp.submissionId, phase: stamp.phase, outcome: 'completed' }] });
      expect(nextStamp.submissionId).not.toBe(stamp.submissionId);
      expect((await installedContext(f, token)).status).toBe(403);
      expect((await callback(f, 'source', source, { 'x-codeflare-dispatcher-delivery': token })).status).toBe(403);
      expect(f.sent).toEqual([]);
      expect(f.ownerPortRequests).toEqual([]);
    } finally {
      acknowledgement.release();
      await within(starting, 'pending admission cleanup').catch(() => undefined);
      if (pending) await within(pending, 'pending context cleanup').catch(() => undefined);
    }
  }, { ...options, intent4: true }));

  it('REQ-OPERATOR-048: AC2 installed context accepts original receipt bound during asynchronous gateway authorization', () => fixture(async f => {
    const acknowledgement = f.normalTransport!.delayAcknowledgement();
    const starting = start(f);
    let pending: Promise<Response> | undefined;
    try {
      await within(acknowledgement.entered, 'external acceptance before authorization handoff');
      const token = phaseToken(f);
      const receipt = [...f.normalTransport!.admissions.values()][0].receipt;
      const bindOriginal = async () => {
        // Disarm before releasing: admission's own post-202 authorization must
        // never consume this seam and await its own still-pending start promise.
        f.afterRegistryResolve(async () => {});
        acknowledgement.release();
        await within(starting, 'original receipt bound during callback handoff');
      };
      // The one-shot external authorization seam releases the original202 before
      // returning. A pre-admission snapshot validator therefore sees receipt change.
      // The admission-aware route instead consumes the body before authorization;
      // body demand releases that same202, so neither ordering waits reentrantly.
      f.afterRegistryResolve(bindOriginal);
      const bytes = new TextEncoder().encode(JSON.stringify({ deliveryToken: token }));
      const body = new ReadableStream<Uint8Array>({ async pull(controller) {
        try { await bindOriginal(); controller.enqueue(bytes); controller.close(); }
        catch (error) { controller.error(error); }
      } }, { highWaterMark: 0 });
      pending = f.installationCapability.fetch(new Request(normalCallback(f.activityId, 'phase-context', { deliveryToken: token },
        { 'x-codeflare-dispatcher-delivery': token }), { method: 'POST', body }));
      const response = await within(pending, 'context across authenticated pre-ack handoff');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ generation: 1, deliveryToken: token,
        submissionId: receipt.submissionId, phase: { kind: 'discovery' } });
      expect(f.normalTransport!.admissions.size).toBe(1);
      expect([...f.normalTransport!.admissions.values()][0].receipt).toEqual(receipt);
      expect(f.sent).toEqual([]);
      expect(f.ownerPortRequests).toEqual([]);
    } finally {
      acknowledgement.release();
      await within(starting, 'authorization handoff admission cleanup').catch(() => undefined);
      if (pending) await within(pending, 'authorization handoff context cleanup').catch(() => undefined);
    }
  }, { ...options, intent4: true }));

  it.each(['cancel', 'expiry', 'revocation', 'foreign-deployment', 'rotated-deployment', 'foreign-token', 'mismatched-token'] as const)(
    'REQ-OPERATOR-003/047/048: direct installed phase context retains %s denial without protected effects', fault => fixture(async f => {
      await start(f);
      const token = phaseToken(f);
      const admissions = [...f.normalTransport!.admissions.values()];
      if (fault === 'cancel') await f.activity.cancelDrive();
      else if (fault === 'expiry') f.expire();
      else if (fault === 'revocation') f.revoke();
      else if (fault === 'rotated-deployment') f.changeConnection({ workerVersionId: 'replacement-worker' });
      const headers: Record<string, string> = fault === 'foreign-deployment' ? { 'x-codeflare-operator-worker-version': 'foreign-worker' }
        : fault === 'rotated-deployment' ? { 'x-codeflare-operator-worker-version': 'replacement-worker' }
        : fault === 'mismatched-token' ? { 'x-codeflare-dispatcher-delivery': 'foreign-delivery' } : {};
      const denied = await within(installedContext(f, fault === 'foreign-token' ? 'foreign-delivery' : token, headers), 'installed phase authority denial');
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'OPERATOR_CAPABILITY_DENIED' });
      expect((await callback(f, 'source', source, { 'x-codeflare-dispatcher-delivery': 'foreign-delivery' })).status).toBe(403);
      expect(f.sent).toEqual([]);
      expect(f.ownerPortRequests).toEqual([]);
      expect([...f.normalTransport!.admissions.values()]).toEqual(admissions);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, { ...options, intent4: true }));

  it('REQ-OPERATOR-048: AC2 lost admission acknowledgement cold-reconciles the exact original wire and full SDK receipt', () => fixture(async f => {
    f.normalTransport!.loseAcknowledgement();
    await start(f);
    const original = control(f, 'dispatch')[0];
    expect(original).toMatchObject({ body: { id: `${f.activityId}-g1`, idempotencyKey: expect.any(String) } });
    const retained = [...f.normalTransport!.admissions.values()][0].receipt;
    const activity = await cold(f);
    await activity.reconcileDispatcherLease();
    const retries = control(f, 'dispatch');
    expect(retries.length).toBeGreaterThanOrEqual(2);
    expect(retries.every(request => JSON.stringify(request) === JSON.stringify(original))).toBe(true);
    // External admission count is the no-replacement-work contract, not an internal call count.
    expect(f.normalTransport!.admissions.size).toBe(1);
    await f.mutateEvidence(async storage => {
      expect(await storage.get('dispatcher:lease')).toMatchObject({ hosting: 'normal', receipt: retained });
    });
    expect(await activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await callback(f, 'source', source)).status).toBe(200);
  }, options));

  it('REQ-OPERATOR-048: AC3 pending public read preserves receipt and original authority without replacement admission or abort', () => fixture(async f => {
    await start(f);
    const accepted = [...f.normalTransport!.admissions.values()][0].receipt;
    let before: unknown;
    await f.mutateEvidence(async storage => { before = (await storage.get<{ expiresAt: number }>('dispatcher:lease'))?.expiresAt; });
    for (let wake = 0; wake < 2; wake++) await f.activity.reconcileDispatcherLease();
    expect(control(f, 'read').length).toBeGreaterThan(0);
    for (const read of control(f, 'read')) expect(read.body).toMatchObject({ id: `${f.activityId}-g1`, receipt: accepted });
    expect(control(f, 'abort')).toEqual([]);
    expect(f.normalTransport!.admissions.size).toBe(1);
    await f.mutateEvidence(async storage => {
      expect(await storage.get('dispatcher:lease')).toMatchObject({ receipt: accepted, expiresAt: before });
    });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, options));

  it.each([500, 502, 503])('REQ-OPERATOR-048: transient read HTTP%i retains original receipt and authority until exact settlement', status => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true, state: { status: 'running', generation: 1 } });
    const admitted = [...f.normalTransport!.admissions.values()];
    const originalDeadline = (await f.activity.getRuntimePlan())!.deadline;
    f.normalTransport!.failNextRead(status);
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.dispatcherGenerationCurrent(1)).toBe(true);
    expect((await f.activity.getBrowserDetail())?.executionStatus).toBe('running');
    expect((await f.activity.getRuntimePlan())!.deadline).toBe(originalDeadline);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    f.normalTransport!.settle('completed', [{ name: 'assessment', data: result }]);
    const activity = await cold(f);
    await activity.reconcileDispatcherLease();
    expect(await activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { executionStatus: 'completed', result } });
    expect((await activity.getBrowserDetail())?.executionStatus).toBe('completed');
    expect([...f.normalTransport!.admissions.values()]).toEqual(admitted);
    for (const read of control(f, 'read')) expect(read.body).toMatchObject({ id: `${f.activityId}-g1`, receipt: admitted[0].receipt });
    expect(control(f, 'abort')).toEqual([]);
  }, options));

  it('REQ-OPERATOR-048: AC4 exact completed SDK assessment collects immutably across cold reads without new execution', () => fixture(async f => {
    await start(f);
    f.normalTransport!.settle('completed', [{ name: 'assessment', data: result }]);
    await f.activity.reconcileDispatcherLease();
    const collected = await f.activity.collectBrowserResult();
    expect(collected).toMatchObject({ ok: true, detail: { executionStatus: 'completed', result } });
    const admissions = [...f.normalTransport!.admissions.values()];
    const activity = await cold(f);
    f.normalTransport!.settle('completed', [{ name: 'assessment', data: { ...result, results: [{ forged: true }] } }]);
    await activity.reconcileDispatcherLease();
    expect(stable(await activity.collectBrowserResult())).toEqual(stable(collected));
    expect([...f.normalTransport!.admissions.values()]).toEqual(admissions);
  }, { ...options, loggingEnabled: false }));

  it.each(['uid', 'submissionId'] as const)(
    'REQ-OPERATOR-048: AC4 foreign completed reply %s cannot authorize collection', field => fixture(async f => {
      await start(f); f.normalTransport!.settle('completed', [{ name: 'assessment', data: result }]);
      f.normalTransport!.changeReply({ [field]: 'foreign-submission-or-incarnation' });
      await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
      expect(f.normalTransport!.admissions.size).toBe(1);
    }, options));

  it.each(['failed', 'aborted', 'missing-assessment', 'duplicate-assessment'] as const)(
    'REQ-OPERATOR-048: AC4 normal %s settlement is not a completed validated result', outcome => fixture(async f => {
      await start(f);
      const assessment = { name: 'assessment', data: result };
      f.normalTransport!.settle(outcome === 'failed' || outcome === 'aborted' ? outcome : 'completed',
        outcome === 'duplicate-assessment' ? [assessment, assessment] : []);
      await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect((await f.activity.getBrowserDetail())?.result).toBeNull();
      expect(f.normalTransport!.admissions.size).toBe(1);
    }, options));

  it('REQ-OPERATOR-016: AC6 normal abort is intent only and retains SDK state without claiming settlement or collection', () => fixture(async f => {
    await start(f);
    const accepted = [...f.normalTransport!.admissions.values()][0].receipt;
    expect(await f.activity.cancelDrive()).toMatchObject({ ok: true });
    expect(control(f, 'abort')).toContainEqual(expect.objectContaining({ body: expect.objectContaining({
      id: `${f.activityId}-g1`, receipt: accepted,
    }) }));
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect((await callback(f, 'source', source)).status).toBe(403);
    expect(f.normalTransport!.admissions.size).toBe(1);
    expect([...f.normalTransport!.admissions.values()][0].receipt).toEqual(accepted);
  }, options));

  it.each([
    ['installation', { 'x-codeflare-operator-installation': 'another-installation' }],
    ['activity', { 'x-codeflare-operator-activity': 'another-activity' }],
    ['generation', { 'x-codeflare-operator-generation': '2' }],
    ['release', { 'x-codeflare-operator-release': 'another-release' }],
    ['connection revision', { 'x-codeflare-operator-connection-revision': '2' }],
    ['credential', { authorization: 'Bearer wrong-installation-secret' }],
  ] as const)('REQ-OPERATOR-047: AC2/3 connection refuses foreign %s without protected effects', async (_name, headers) => fixture(async f => {
    await start(f);
    const denied = await callback(f, 'source', source, headers);
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toMatch(/inline-secret|owner@example|private\.jwt|fixture-installation-secret/);
    expect(f.sent).toEqual([]);
    const permitted = await callback(f, 'source', source);
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toMatchObject({ url: source.url, status: 200 });
  }, options));

  it.each(['cancel', 'expiry', 'revocation'] as const)(
    'REQ-OPERATOR-048: AC5 normal %s denies current installation callbacks and prevents late result collection', fault => fixture(async f => {
      await start(f);
      if (fault === 'cancel') await f.activity.cancelDrive();
      else if (fault === 'expiry') f.expire();
      else f.revoke();
      expect((await callback(f, 'source', source)).status).toBe(403);
      expect(f.sent).toEqual([]);
      f.normalTransport!.settle('completed', [{ name: 'assessment', data: result }]);
      await f.activity.reconcileDispatcherLease();
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(f.normalTransport!.admissions.size).toBe(1);
    }, options));

  it('REQ-OPERATOR-047: AC4/5 normal callbacks retain exact replay conflicts and the original one-operation budget across cold wake', () => fixture(async f => {
    await start(f);
    const first = await callback(f, 'source', source);
    expect(first.status).toBe(200);
    const committed = await first.text();
    const effects = f.sent.map(request => ({ url: request.url, method: request.method }));
    await cold(f);
    const replay = await callback(f, 'source', source);
    expect(replay.status).toBe(200); expect(await replay.text()).toBe(committed);
    expect((await callback(f, 'source', { ...source, url: `${source.url}/pulls/17` })).status).toBe(409);
    expect((await callback(f, 'source', { ...source, operationId: 'new-over-budget' })).status).toBe(403);
    expect(f.sent.map(request => ({ url: request.url, method: request.method }))).toEqual(effects);
    const receipt = await callback(f, 'receipt', { operationId: source.operationId });
    expect(receipt.status).toBe(200);
    expect(await receipt.json()).toMatchObject({ phase: 'completed', operationCount: 1, operationLimit: 1 });
  }, { ...options, operationLimit: 1 }));

  it('REQ-OPERATOR-047: AC4/5 uncertain normal mutation remains original and cannot resend or collect after cold wake', () => fixture(async f => {
    await start(f);
    const mutation = { operationId: 'normal-unknown-comment', method: 'POST', url: `${source.url}/issues/17/comments`, body: '{"body":"original judgment"}' };
    f.loseResponse();
    expect((await callback(f, 'source', mutation)).status).toBe(409);
    f.restoreTransport(); await cold(f);
    const replay = await callback(f, 'source', mutation);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'OPERATOR_OPERATION_UNKNOWN' });
    expect(await f.readRemoteComments()).toEqual([{ id: 91, body: 'original judgment', user: { id: 42 } }]);
    expect(f.sent.filter(request => request.method === 'POST').map(request => request.url)).toEqual([mutation.url]);
    f.normalTransport!.settle('completed', [{ name: 'assessment', data: result }]);
    await f.activity.reconcileDispatcherLease();
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, options));

  it('REQ-OPERATOR-003: AC2 normal authenticated operation cannot substitute the server-derived owner', () => fixture(async f => {
    await start(f);
    expect((await callback(f, 'source', { ...source, owner: 'another-owner', bucket: 'another-bucket' })).status).toBe(403);
    expect(f.sent).toEqual([]);
    const permitted = await callback(f, 'source', source);
    expect(permitted.status).toBe(200);
    expect(await permitted.json()).toMatchObject({ url: source.url, status: 200 });
  }, options));

  it.each(['bundleDigest', 'sourceCommit', 'compilerCommit', 'releaseId'] as const)(
    'REQ-OPERATOR-044: deployment identity constraint rejects substituted %s before any job admission', field => fixture(async f => {
      f.changeConnection({ [field]: field.endsWith('Commit') ? 'b'.repeat(40) : field.endsWith('Digest') ? 'b'.repeat(64) : 'other-release' });
      const started = await start(f);
      expect(started).toMatchObject({ ok: true, state: { status: 'unknown', generation: 2 } });
      expect(f.normalTransport!.admissions.size).toBe(0);
      expect(f.sent).toEqual([]);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, options));
});
/** Approved raw-log batch: real parent authorization/SQLite, synthetic external owner port only. */
describe('protected raw parent execution evidence', () => {
  const options = { normalHosting: true, repositoryOnly: true };
  const captureRaw = () => {
    const records: Array<{ module: string; message: string; data: Record<string, unknown> }> = [];
    for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((line: unknown) => {
      if (typeof line !== 'string') return;
      try { const record = JSON.parse(line); if (record.module === 'operator-execution') records.push(record); }
      catch { /* Other SDK/platform console records are not this intentional JSON wire. */ }
    });
    return records;
  };
  const rawText = (records: Array<{ data: Record<string, unknown> }>) => JSON.stringify(records.map(record => record.data));
  const inputFor = async (f: DispatcherFixture) => ({ generation: 1, plan: (await f.activity.getRuntimePlan())!,
    env: f.environment, current: () => f.activity.operatorGenerationCurrent(1), waitUntil: f.waitUntil });

  it.each([true, false])('REQ-OPERATOR-090: AC1/3/4 original admitted logging=%s controls full request and SDK response despite mutable current setting', loggingEnabled => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    f.setCurrentLogging(!loggingEnabled);
    const records = captureRaw(); setLogLevel('silent');
    const context = { systemPrompt: 'FULL_RAW_SYSTEM_é🦊', messages: [{ role: 'user', content: 'FULL_RAW_REQUEST_é🦊' }],
      tools: [{ name: 'domain_tool', parameters: { type: 'object', properties: { input: { type: 'string' } } } }] };
    const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'inference', {
      operationId: 'original-logging-decision', context, options: { reasoning: 'high', temperature: 0.25 } }));
    expect(response.status).toBe(200);
    const value = await response.json() as { events: unknown[]; result: { content: Array<{ text: string }> } };
    expect(JSON.parse(value.result.content[0].text)).toEqual({ context, options: { temperature: 0.25, reasoning: 'off' }, ordinal: 1 });
    const own = records.filter(record => record.data.activityId === f.activityId);
    if (loggingEnabled) {
      expect(rawText(own)).toContain('FULL_RAW_SYSTEM_é🦊');
      expect(rawText(own)).toContain('FULL_RAW_REQUEST_é🦊');
      expect(rawText(own)).toContain('domain_tool');
      expect(rawText(own)).toContain('assistant');
      expect(own.every(record => record.data.generation === 1)).toBe(true);
    } else expect(own).toEqual([]);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(f.normalTransport!.networkRequests.filter(request => new URL(request.url).hostname === 'api.cloudflare.com')).toEqual([]);
    setLogLevel('silent');
  }, { ...options, loggingEnabled }));

  it.each([true, false])('REQ-OPERATOR-090: AC1/4 admission and protected tool input/output logging=%s preserve full raw content and the original single remote effect', loggingEnabled => fixture(async f => {
    const records = captureRaw();
    expect(await start(f)).toMatchObject({ ok: true });
    const text = 'COMPLETE_TOOL_IO_é🦊'.repeat(601) + 'FINAL_TOOL_IO_BYTE';
    const operation = { operationId: 'raw-source-tool', method: 'POST', url: 'https://api.github.com/repos/another/service/issues/17/comments',
      body: JSON.stringify({ body: text }) };
    const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'source', operation));
    expect(response.status).toBe(200);
    const envelope = await response.json() as { status: number; body: string };
    expect(envelope.status).toBe(201);
    expect(JSON.parse(envelope.body)).toMatchObject({ id: 91, body: text });
    expect(await f.readRemoteComments()).toEqual([{ id: 91, body: text, user: { id: 42 } }]);
    const originalBody = envelope.body;
    const replay = await f.installationCapability.fetch(normalCallback(f.activityId, 'source', operation));
    expect(replay.status).toBe(200); expect((await replay.json() as { body: string }).body).toBe(originalBody);
    expect(await f.readRemoteComments()).toEqual([{ id: 91, body: text, user: { id: 42 } }]);
    if (loggingEnabled) {
      const raw = rawText(records);
      expect(raw).toContain(text); expect(raw).toContain('another/service');
      expect(raw).toContain('raw-source-tool');
      expect(raw).toContain('initialData');
      expect(raw).not.toMatch(/private\.jwt|parent-only|fixture-installation-secret-not-a-provider-credential/);
    } else expect(records).toEqual([]);
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(JSON.stringify(history)).not.toMatch(/COMPLETE_TOOL_IO_|FINAL_TOOL_IO_BYTE/);
    expect(f.normalTransport!.networkRequests.filter(request => new URL(request.url).hostname === 'api.cloudflare.com')).toEqual([]);
  }, { ...options, loggingEnabled, sourceResponseBytes: 65536, installationSourceResponseBytes: 65536 }));

  it.each(['profile', 'inference'] as const)('REQ-OPERATOR-003/007/047: trusted %s uses public profile HTTP or legacy inference RPC with parent-owned correlation', operation => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    const input = await inputFor(f);
    if (operation === 'profile') {
      expect(await discoverDispatcherOwnerProfile(input)).toMatchObject({ source: 'managed', model: 'approved' });
      expect(f.normalTransport!.requests).toEqual(expect.arrayContaining([expect.objectContaining({
        path: '/control/profile', authorization: `Bearer ${connectionSecret}`, body: {
          id: `${f.activityId}-g1`, installationId: 'installation',
          activityId: f.activityId, generation: 1, releaseId: 'release',
          connectionRevision: 1, workerVersionId: normalDeployment.workerVersionId,
        },
      })]));
      expect(f.ownerPortRequests.filter(request => new URL(request.url).pathname === '/operator-inference/profile')).toEqual([]);
      return;
    } else {
      const selected = await discoverDispatcherOwnerProfile(input);
      const response = await forwardDispatcherOwnerInference({ ...input, selection: selected, operation: { operationId: 'trusted-rpc-context',
        context: { messages: [{ role: 'user', content: 'ORIGINAL_RPC_PAYLOAD' }] }, options: {}, requestDigest: 'a'.repeat(64) } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: { role: 'assistant', model: 'approved' } });
    }
    const sent = f.ownerPortRequests.filter(request => new URL(request.url).pathname === '/operator-inference');
    expect(sent.length).toBeGreaterThan(0);
    for (const request of sent) {
      expect(request.loggingContext).toEqual({ activityId: f.activityId, generation: 1, loggingEnabled: true });
      expect(request.body).toMatchObject({ activityId: f.activityId, generation: 1, sessionGeneration: 3 });
      expect(request.body).not.toHaveProperty('loggingEnabled');
    }
  }, options));

  it.each([true, false])('REQ-OPERATOR-090: AC1/4 full upstream non-OK body and status are captured before the same generic refusal with logging=%s', loggingEnabled => {
    const body = 'ORIGINAL_UPSTREAM_BODY_é🦊'.repeat(503) + 'LAST_UPSTREAM_BYTE';
    return fixture(async f => {
      expect(await start(f)).toMatchObject({ ok: true });
      const records = captureRaw(); setLogLevel('silent');
      const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'inference', {
        operationId: 'non-ok-raw', context: { messages: [{ role: 'user', content: 'Observe failure' }] }, options: {} }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'OPERATOR_OPERATION_UNKNOWN', reason: 'operation-failed', disposition: 'operation-local' });
      const text = rawText(records);
      if (loggingEnabled) { expect(text).toContain(body); expect(text).toMatch(/"status":503/); }
      else expect(records).toEqual([]);
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
      expect(await f.readRemoteComments()).toEqual([]);
    }, { ...options, loggingEnabled, ownerTransport: async request => new URL(request.url).pathname === '/operator-inference'
      ? new Response(body, { status: 503 }) : undefined });
  });

  it.each([
    { failure: 'forward', loggingEnabled: true }, { failure: 'forward', loggingEnabled: false },
    { failure: 'body-read', loggingEnabled: true }, { failure: 'body-read', loggingEnabled: false },
  ] as const)('REQ-OPERATOR-078/082: original $failure Error identity survives logging=$loggingEnabled with full admitted cause/stack capture', ({ failure, loggingEnabled }) => {
    const cause = new Error('ORIGINAL_OWNER_CAUSE_é🦊'); cause.stack = 'Error: ORIGINAL_OWNER_CAUSE_é🦊\n at exactCause (owner.ts:31:7)';
    const original = new Error('ORIGINAL_OWNER_FAILURE', { cause }); original.stack = 'Error: ORIGINAL_OWNER_FAILURE\n at exactForward (rpc.ts:92:4)';
    let broken = false;
    return fixture(async f => {
      expect(await start(f)).toMatchObject({ ok: true });
      const input = await inputFor(f); const selection = await discoverDispatcherOwnerProfile(input);
      const records = captureRaw(); broken = true;
      const work = () => forwardDispatcherOwnerInference({ ...input, selection, operation: { operationId: 'original-error-identity',
        context: { messages: [{ role: 'user', content: 'Original request' }] }, options: {}, requestDigest: 'a'.repeat(64) } });
      await expect(work()).rejects.toBe(original);
      const text = rawText(records);
      if (loggingEnabled) for (const retained of [original.message, cause.message, 'exactForward (rpc.ts:92:4)', 'exactCause (owner.ts:31:7)'])
        expect(text).toContain(retained);
      else expect(records).toEqual([]);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    }, { ...options, loggingEnabled, ownerTransport: async request => {
      if (!broken || new URL(request.url).pathname !== '/operator-inference') return undefined;
      if (failure === 'forward') throw original;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }));
    } });
  });

  it.each([true, false])('REQ-OPERATOR-090/081: authenticated installed callback failure logging=%s preserves cause and closed refusal evidence across reconstruction', loggingEnabled => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    const deliveryToken = 'PRIVATE_CALLBACK_DELIVERY_TOKEN';
    const cause = new TypeError(`PRIVATE_CALLBACK_CAUSE Bearer ${connectionSecret} ${deliveryToken}`);
    cause.stack = `TypeError: ${cause.message}\n at originalCallbackCause (registry.ts:31:7)`;
    const original = new Error('PRIVATE_CALLBACK_ORIGINAL', { cause });
    original.stack = 'Error: PRIVATE_CALLBACK_ORIGINAL\n at originalCallbackAuthority (registry.ts:92:4)';
    const fingerprint = { ...captureError(original), transportStatus: 403, transportReason: 'execution-inactive',
      transportDisposition: 'authority-denied' };
    const records = captureRaw();
    const admissions = [...f.normalTransport!.admissions.values()];
    f.afterRegistryResolve(async () => { throw original; });
    const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'source', {
      operationId: 'installed-callback-authorization-failure', url: 'https://api.github.com/repos/another/service',
    }, { 'x-codeflare-dispatcher-delivery': deliveryToken }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'execution-inactive', disposition: 'authority-denied' });
    expect(f.sent).toEqual([]);
    expect(f.ownerPortRequests).toEqual([]);
    await f.drainBackground();
    const failures = records.filter(record => record.message === 'dispatcher-callback-failure');
    if (loggingEnabled) {
      expect(failures).not.toEqual([]);
      const raw = rawText(failures);
      for (const value of [original.message, 'PRIVATE_CALLBACK_CAUSE', 'originalCallbackAuthority (registry.ts:92:4)', 'originalCallbackCause (registry.ts:31:7)'])
        expect(raw).toContain(value);
      expect(raw).not.toContain(connectionSecret);
      expect(raw).not.toContain(deliveryToken);
    } else expect(records).toEqual([]);

    const reconstructed = f.restart(); await f.drainBackground();
    const get = diagnosticsBrowser(f);
    const history = await diagnosticTraversal(get);
    const retained = history.records.filter(record => record.boundary === 'delivery' && record.outcome === 'failed' && record.code === 'authority-denied');
    const exported = await diagnosticTraversal(get, '/diagnostics/v2/export');
    if (loggingEnabled) {
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({ generation: 1, owner: 'host', error: fingerprint });
      const detail = await diagnosticJson<{ record: DiagnosticRecord; capsule: Record<string, unknown> }>(await get(`/diagnostics/v2/records/${retained[0].id}`));
      expect(detail.record).toEqual(retained[0]);
      expect(detail.capsule).toMatchObject({ error: fingerprint });
      expect(exported.records.find(record => record.id === retained[0].id)).toEqual(retained[0]);
      expect(JSON.stringify({ history, detail, exported })).not.toMatch(/PRIVATE_CALLBACK_|fixture-installation-secret/);
    } else {
      expect((await diagnosticSummary(f)).capture).toBe('disabled');
      expect(retained).toEqual([]);
      expect(exported.records.filter(record => record.outcome === 'failed')).toEqual([]);
    }
    expect(await reconstructed.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(await reconstructed.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect([...f.normalTransport!.admissions.values()]).toEqual(admissions);
    expect(f.sent).toEqual([]);
    expect(f.ownerPortRequests).toEqual([]);
  }, { ...options, loggingEnabled }));

  it('REQ-OPERATOR-090/081: unavailable callback evidence sinks cannot replace the authenticated refusal or authorize effects', () => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true });
    const admissions = [...f.normalTransport!.admissions.values()];
    await denyDiagnosticWrites(f);
    vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('PRIVATE_CALLBACK_LOG_SINK_UNAVAILABLE'); });
    f.afterRegistryResolve(async () => { throw new Error('PRIVATE_CALLBACK_AUTHORITY_FAILURE', { cause: new TypeError('PRIVATE_CALLBACK_CAUSE') }); });
    const response = await within(f.installationCapability.fetch(normalCallback(f.activityId, 'source', {
      operationId: 'unavailable-callback-evidence', url: 'https://api.github.com/repos/another/service',
    })), 'refusal despite unavailable optional capture');
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'OPERATOR_CAPABILITY_DENIED', reason: 'execution-inactive', disposition: 'authority-denied' });
    await f.drainBackground();
    expect(f.sent).toEqual([]);
    expect(f.ownerPortRequests).toEqual([]);
    expect([...f.normalTransport!.admissions.values()]).toEqual(admissions);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, options));

  it.each([true, false])('REQ-OPERATOR-090/081/083: pre-lease original failure logging=%s retains readable ordered history/detail/export without invented submission', loggingEnabled => fixture(async f => {
    const cause = new TypeError('PRIVATE_PRELEASE_CAUSE');
    const original = new Error('PRIVATE_PRELEASE_ORIGINAL', { cause });
    const fingerprint = captureError(original);
    const records = captureRaw();
    f.afterBundleRead(async () => { throw original; });
    await start(f); await f.drainBackground();
    const reconstructed = f.restart(); await f.drainBackground();
    const before = await reconstructed.getBrowserDetail();
    expect(before).toMatchObject({ executionStatus: 'unknown', result: null, sdkCleanupReleased: false });
    const legacy = await reconstructed.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(legacy?.parent.lease).toBeNull();
    expect(f.normalTransport!.admissions.size).toBe(0);
    expect(f.childSubmissions).toEqual([]);
    const summary = await diagnosticSummary(f);
    expect(summary.binding).toMatchObject({ generation: 1, artifactDigest: f.artifactDigest });
    expect(summary.fence).toMatchObject({ generation: 1, code: 'artifact-mismatch' });
    const get = diagnosticsBrowser(f);
    const history = await diagnosticTraversal(get);
    if (loggingEnabled) {
      const failures = history.records.filter(record => record.outcome === 'failed' && record.code === 'artifact-mismatch');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ generation: 1, owner: 'host', boundary: 'artifact', error: fingerprint });
      const terminal = history.records.find(record => record.outcome === 'unknown' && record.code === 'artifact-mismatch');
      expect(terminal).toMatchObject({ generation: 1 });
      expect(failures[0].sequence!).toBeLessThan(terminal!.sequence!);
      const detail = await diagnosticJson<{ record: DiagnosticRecord; capsule: Record<string, unknown> }>(await get(`/diagnostics/v2/records/${failures[0].id}`));
      expect(detail.record).toEqual(failures[0]);
      expect(detail.capsule).toMatchObject({ eventId: failures[0].id, error: fingerprint, sdk: null });
      const exported = await diagnosticTraversal(get, '/diagnostics/v2/export');
      expect(exported.records.find(record => record.id === failures[0].id)).toEqual(failures[0]);
      expect(rawText(records)).toContain(original.message);
      expect(rawText(records)).toContain(cause.message);
      expect(JSON.stringify({ history, detail, exported })).not.toMatch(/PRIVATE_PRELEASE_/);
    } else {
      expect(summary.capture).toBe('disabled');
      expect(history.records.filter(record => record.outcome === 'failed')).toEqual([]);
      expect(records).toEqual([]);
    }
    expect((await get('/diagnostics/v2/history', 'foreign@example.test')).status).toBe(404);
    expect(await reconstructed.getBrowserDetail()).toEqual(before);
    expect((await reconstructed.getDispatcherDiagnostics(f.proof.ownerKey))?.parent).toEqual(legacy?.parent);
    expect(await reconstructed.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    expect(f.normalTransport!.admissions.size).toBe(0);
  }, { ...options, loggingEnabled }));

  it('REQ-OPERATOR-081/082/083: optional pre-lease recorder initialization failure cannot roll back the fence or disguise unreadable history', () => fixture(async f => {
    await denyDiagnosticWrites(f);
    f.afterBundleRead(async () => { throw new Error('PRIVATE_ORIGINAL_PRELEASE_WRITE_OUTAGE'); });
    await start(f); await f.drainBackground();
    vi.restoreAllMocks(); f.restart(); await f.drainBackground();
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null });
    const summary = await diagnosticSummary(f);
    expect(summary.fence).toMatchObject({ generation: 1, code: 'artifact-mismatch' });
    expect(summary.health.gaps).toContain('recorder-unavailable');
    const get = diagnosticsBrowser(f);
    for (const path of ['/diagnostics/v2/history', '/diagnostics/v2/export', '/diagnostics/v2/records/e-1']) {
      const response = await get(path); expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'DIAGNOSTICS_UNAVAILABLE' });
    }
    expect((await f.capability.fetch(genericWire('source', { operationId: 'no-prelease-replay', url: 'https://api.github.com/repos/another/service' }))).status).toBe(403);
    expect(f.normalTransport!.admissions.size).toBe(0);
    expect((await f.activity.getDispatcherDiagnostics(f.proof.ownerKey))?.parent.lease).toBeNull();
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, options));
});
/** Frozen passive policy wire: bodyless installation-authenticated POST.
 * The parent proves the original lease/deployment/receipt from its retained state.
 * The response grants no execution authority and does not reconstruct history.
 */
describe('original installed Dispatcher logging-policy read', () => {
  const options = { normalHosting: true, repositoryOnly: true };
  const proof = (f: DispatcherFixture) => {
    const wire = f.normalTransport!.requests.find(request => request.path === '/control/dispatch')!.body;
    const { id, installationId, activityId, generation, releaseId, connectionRevision, workerVersionId } = wire;
    return { id, installationId, activityId, generation, releaseId, connectionRevision, workerVersionId,
      receipt: [...f.normalTransport!.admissions.values()][0].receipt };
  };
  const read = (f: DispatcherFixture, body: unknown = undefined, headers?: Record<string, string>) =>
    f.installationCapability.fetch(normalCallback(f.activityId, 'logging-policy', body, headers));
  const expected = (f: DispatcherFixture, loggingEnabled: boolean) => ({ schemaVersion: 1, loggingEnabled, activityId: f.activityId, generation: 1,
    deployment: { installationId: 'installation', releaseId: 'release', connectionRevision: 1, workerVersionId: normalDeployment.workerVersionId } });
  const persistentState = async (f: DispatcherFixture) => {
    let snapshot: Map<string, unknown> = new Map();
    await f.mutateEvidence(async storage => { snapshot = structuredClone(await storage.list()); });
    return snapshot;
  };

  it.each([true, false])('REQ-OPERATOR-091: AC4 passive policy returns immutable original logging=%s and no credentials or work authority', loggingEnabled => fixture(async f => {
    expect(await start(f)).toMatchObject({ ok: true }); await f.drainBackground();
    f.setCurrentLogging(!loggingEnabled);
    const state = await persistentState(f), calls = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
    const response = await read(f);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(expected(f, loggingEnabled));
    expect(await persistentState(f)).toEqual(state);
    expect(f.normalTransport!.networkRequests).toEqual(calls);
    expect(f.ownerPortRequests).toEqual(profiles);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { ...options, loggingEnabled }));

  it.each(['cancelled', 'completed', 'disabled-and-rotated', 'expired'] as const)(
    'REQ-OPERATOR-003/047/091: exact original %s policy remains readable but grants no execution or current authority', terminal => fixture(async f => {
      expect(await start(f)).toMatchObject({ ok: true });
      if (terminal === 'completed') {
        f.normalTransport!.settle('completed', [{ name: 'assessment', data: { repository: 'another/service', results: [] } }]);
        await f.activity.reconcileDispatcherLease();
        expect(await f.activity.collectBrowserResult()).toMatchObject({ ok: true, detail: { executionStatus: 'completed' } });
      } else await f.activity.cancelDrive();
      if (terminal === 'disabled-and-rotated') {
        f.revoke(); f.changeConnection({ connectionRevision: 2, workerVersionId: 'new-version', connectionSecretCiphertext: 'v1:rotated-connection' });
      }
      if (terminal === 'expired') { f.expire(); f.revokeSession(); }
      f.restart(); await f.drainBackground();
      const state = await persistentState(f), calls = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
      const response = await read(f);
      expect(response.status).toBe(200); expect(await response.json()).toEqual(expected(f, true));
      expect(await persistentState(f)).toEqual(state); expect(f.normalTransport!.networkRequests).toEqual(calls); expect(f.ownerPortRequests).toEqual(profiles);
      const forbidden = await f.installationCapability.fetch(normalCallback(f.activityId, 'source', { operationId: 'policy-is-not-work',
        url: 'https://api.github.com/repos/another/service' }));
      expect(forbidden.status).toBe(403); expect(await f.readRemoteComments()).toEqual([]);
    }, options));

  it.each([
    { name: 'empty JSON', patch: null },
    { name: 'foreign Activity', patch: { activityId: 'foreign-activity' } },
    { name: 'fresh generation', patch: { generation: 2 } },
    { name: 'foreign job', patch: { id: 'foreign-job' } },
    { name: 'foreign receipt', patch: { receipt: { submissionId: 'foreign-submission', uid: 'foreign-instance', acceptedAt: '2026-10-28T00:00:00.000Z' } } },
    { name: 'foreign deployment', patch: { workerVersionId: 'foreign-version' } },
    { name: 'caller logging override', patch: { loggingEnabled: true } },
  ])('REQ-OPERATOR-003/047/091: supplied $name body is refused rather than used as passive policy authority', ({ patch }) => fixture(async f => {
    await start(f); await f.drainBackground();
    const state = await persistentState(f), calls = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
    const denied = await read(f, patch === null ? {} : { ...proof(f), ...patch });
    expect(denied.status).toBe(403); expect(await denied.text()).not.toMatch(/fixture-installation-secret|private\.jwt|parent-only/);
    expect(await persistentState(f)).toEqual(state); expect(f.normalTransport!.networkRequests).toEqual(calls); expect(f.ownerPortRequests).toEqual(profiles);
    const control = await read(f); expect(control.status).toBe(200); expect(await control.json()).toEqual(expected(f, false));
  }, { ...options, loggingEnabled: false }));

  const credentialCases: Array<{ name: string; headers: Record<string, string> }> = [
    { name: 'missing credential', headers: { authorization: '' } },
    { name: 'foreign credential', headers: { authorization: 'Bearer foreign-secret' } },
    { name: 'ambiguous generation', headers: { 'x-codeflare-operator-generation': '1, 1' } },
    { name: 'foreign Activity', headers: { 'x-codeflare-operator-activity': 'foreign-activity' } },
    { name: 'foreign installation', headers: { 'x-codeflare-operator-installation': 'foreign-installation' } },
    { name: 'foreign release', headers: { 'x-codeflare-operator-release': 'foreign-release' } },
    { name: 'fresh connection', headers: { 'x-codeflare-operator-connection-revision': '2' } },
    { name: 'foreign Worker version', headers: { 'x-codeflare-operator-worker-version': 'foreign-version' } },
  ];
  it.each(credentialCases)('REQ-OPERATOR-003/047/091: $name fails installation authentication before policy disclosure', ({ headers }) => fixture(async f => {
    await start(f); await f.drainBackground();
    const response = await read(f, undefined, headers);
    expect(response.status).toBe(403);
    const text = await response.text(); expect(text).not.toMatch(/loggingEnabled|fixture-installation-secret|private\.jwt|parent-only/);
    expect((await read(f)).status).toBe(200);
  }, options));

  it.each(['GET', 'query', 'hash', 'foreign origin', 'unretained requested generation'] as const)(
    'REQ-OPERATOR-003/047/091: %s cannot turn passive logging policy into alternate authority', variant => fixture(async f => {
      await start(f); await f.drainBackground();
      const request = normalCallback(f.activityId, 'logging-policy', undefined,
        variant === 'unretained requested generation' ? { 'x-codeflare-operator-generation': '2' } : undefined);
      const url = new URL(request.url);
      if (variant === 'query') url.search = '?loggingEnabled=true';
      if (variant === 'hash') url.hash = '#loggingEnabled=true';
      if (variant === 'foreign origin') url.hostname = 'foreign.example.test';
      const method = variant === 'GET' ? 'GET' : 'POST';
      const state = await persistentState(f), network = structuredClone(f.normalTransport!.networkRequests);
      const response = await f.installationCapability.fetch(new Request(url, { method, headers: request.headers }));
      expect(response.status).toBe(403); expect(await response.text()).not.toContain('loggingEnabled');
      expect(await persistentState(f)).toEqual(state); expect(f.normalTransport!.networkRequests).toEqual(network);
      expect((await read(f)).status).toBe(200);
    }, options));

  it('REQ-OPERATOR-091: original admitting lease policy is readable before an uncertain admission acknowledgement without observation or redispatch', () => fixture(async f => {
    f.normalTransport!.loseAcknowledgement(); await start(f); await f.drainBackground();
    await f.mutateEvidence(async storage => { expect(await storage.get('dispatcher:lease')).toMatchObject({ generation: 1, status: 'admitting' }); });
    const state = await persistentState(f), network = structuredClone(f.normalTransport!.networkRequests);
    const response = await read(f);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(expected(f, true));
    expect(await persistentState(f)).toEqual(state); expect(f.normalTransport!.networkRequests).toEqual(network);
    expect(f.normalTransport!.admissions.size).toBe(1);
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, options));

  it.each(['overwritten generation', 'foreign deployment', 'mismatched receipt', 'missing accepted receipt'] as const)(
    'REQ-OPERATOR-003/047/091: retained %s denies policy instead of reconstructing authority from historical connection metadata', fault => fixture(async f => {
      await start(f); await f.drainBackground();
      await f.mutateEvidence(async storage => {
        const lease = (await storage.get<Record<string, unknown>>('dispatcher:lease'))!;
        if (fault === 'overwritten generation') await storage.put('dispatcher:lease', { ...lease, generation: 2 });
        else if (fault === 'foreign deployment') await storage.put('dispatcher:lease', { ...lease,
          deployment: { ...(lease.deployment as Record<string, unknown>), workerVersionId: 'foreign-version' } });
        else if (fault === 'mismatched receipt') await storage.put('dispatcher:lease', { ...lease,
          receipt: { ...(lease.receipt as Record<string, unknown>), submissionId: 'foreign-submission' } });
        else { const { receipt: _receipt, ...unproven } = lease; await storage.put('dispatcher:lease', unproven); }
      });
      const state = await persistentState(f), network = structuredClone(f.normalTransport!.networkRequests), profiles = structuredClone(f.ownerPortRequests);
      const response = await read(f);
      expect(response.status).toBe(403); expect(await response.text()).not.toContain('loggingEnabled');
      expect(await persistentState(f)).toEqual(state); expect(f.normalTransport!.networkRequests).toEqual(network); expect(f.ownerPortRequests).toEqual(profiles);
    }, options));

  it('REQ-OPERATOR-003/047/091: unleased Activity cannot supply an original logging-policy binding', () => fixture(async f => {
    const response = await read(f);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain('loggingEnabled');
    expect(f.normalTransport!.admissions.size).toBe(0);
    expect(f.ownerPortRequests).toEqual([]);
  }, options));
});

// Admission profile failures are earlier than any normal SDK dispatch/lease.
// These synthetic failures do not identify the originating cause of 51978c9f.
describe('configured-owner pre-lease failure evidence', () => {
  it.each([
    { failure: 'status', loggingEnabled: true }, { failure: 'status', loggingEnabled: false },
    { failure: 'forward', loggingEnabled: true }, { failure: 'forward', loggingEnabled: false },
    { failure: 'body-read', loggingEnabled: true }, { failure: 'body-read', loggingEnabled: false },
  ] as const)('REQ-OPERATOR-007/090/081/082/083: profile $failure with logging=$loggingEnabled retains original evidence before generic admission refusal', ({ failure, loggingEnabled }) => {
    const cause = new Error('PRIVATE_PROFILE_ORIGIN'); cause.stack = 'Error: PRIVATE_PROFILE_ORIGIN\n at profileOrigin (configured.ts:3:1)';
    const original = new TypeError('PRIVATE_PROFILE_FORWARD_FAILURE', { cause });
    original.stack = 'TypeError: PRIVATE_PROFILE_FORWARD_FAILURE\n at profileForward (configured.ts:11:4)';
    const body = 'PROFILE_UPSTREAM_é🦊'.repeat(601) + 'FINAL_PROFILE_BYTE';
    return fixture(async f => {
      const records: Array<{ data: Record<string, unknown> }> = [];
      for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((line: unknown) => {
        if (typeof line !== 'string') return;
        try { const record = JSON.parse(line); if (record.module === 'operator-execution') records.push(record); } catch { /* Not our wire. */ }
      });
      await start(f); await f.drainBackground(); f.restart(); await f.drainBackground();
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'unknown', result: null, sdkCleanupReleased: false });
      expect((await f.activity.getDispatcherDiagnostics(f.proof.ownerKey))?.parent.lease).toBeNull();
      expect(f.normalTransport!.admissions.size).toBe(0); expect(f.childSubmissions).toEqual([]);
      const summary = await diagnosticSummary(f);
      expect(summary.fence).toMatchObject({ generation: 1, code: 'authority-denied' });
      if (loggingEnabled) {
        const raw = JSON.stringify(records);
        if (failure === 'status') { expect(raw).toContain(body); expect(raw).toMatch(/"status":502/); }
        else {
          for (const retained of [original.message, cause.message, 'profileOrigin (configured.ts:3:1)', 'profileForward (configured.ts:11:4)'])
            expect(raw).toContain(retained);
        }
        const history = await diagnosticTraversal(diagnosticsBrowser(f));
        const failures = history.records.filter(record => record.outcome === 'failed' && record.code === 'authority-denied');
        expect(failures).toHaveLength(1);
        if (failure !== 'status') expect(failures[0]).toMatchObject({ error: captureError(original) });
        expect(JSON.stringify(history)).not.toMatch(/PRIVATE_PROFILE_|PROFILE_UPSTREAM_/);
      } else { expect(records).toEqual([]); expect(summary.capture).toBe('disabled'); }
      expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
    }, { normalHosting: true, repositoryOnly: true, loggingEnabled, normalProfileTransport: async request => {
      if (new URL(request.url).pathname !== '/control/profile') return undefined;
      if (failure === 'status') return new Response(body, { status: 502 });
      if (failure === 'forward') throw original;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(original); } }));
    } });
  });

  it('REQ-OPERATOR-090/082: throwing raw console cannot change configured-owner response bytes or replace the original transport failure', () => {
    const original = new Error('ORIGINAL_TRANSPORT_FAILURE_WITH_CONSOLE_DOWN'); let broken = false;
    return fixture(async f => {
      expect(await start(f)).toMatchObject({ ok: true });
      const plan = (await f.activity.getRuntimePlan())!;
      const input = { generation: 1, plan, env: f.environment, current: () => f.activity.operatorGenerationCurrent(1), waitUntil: f.waitUntil };
      const selection = await discoverDispatcherOwnerProfile(input);
      for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation(() => { throw new Error('OPTIONAL_CONSOLE_DOWN'); });
      const context = { messages: [{ role: 'user', content: 'FULL_ORIGINAL_RESPONSE_é🦊' }] };
      const operation = { operationId: 'console-independent', context, options: {}, requestDigest: 'b'.repeat(64) };
      const response = await forwardDispatcherOwnerInference({ ...input, selection, operation });
      expect(response.status).toBe(200);
      const result = await response.json() as { events: unknown[]; result: { content: Array<{ text: string }> } };
      expect(JSON.parse(result.result.content[0].text)).toEqual({ context, options: { reasoning: 'off' }, ordinal: 1 });
      expect(result.events).toEqual([{ type: 'done', reason: 'stop', message: result.result }]);
      broken = true;
      await expect(forwardDispatcherOwnerInference({ ...input, selection, operation: { ...operation, operationId: 'console-independent-failure' } })).rejects.toBe(original);
      expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    }, { normalHosting: true, repositoryOnly: true, ownerTransport: async request => {
      if (broken && new URL(request.url).pathname === '/operator-inference') throw original;
      return undefined;
    } });
  });
});
