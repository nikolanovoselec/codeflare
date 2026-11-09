import { describe, expect, it } from 'vitest';
import { publicSdkReportSchema, projectPublicSdkRecords, readPublicSdkDiagnostics } from '../../operators/dispatcher-public-diagnostics';
import { appendDiagnostic, initializeDiagnostics } from '../../operators/dispatcher-diagnostics-store';
import { hashDiagnostic } from '../../operators/dispatcher-diagnostics-wire';
import { fixture, start, diagnosticsBrowser, diagnosticTraversal, denyDiagnosticWrites } from './fixtures/dispatcher-production';
import { normalCallback } from './fixtures/normal-dispatcher';

const binding = { generation: 1, artifactDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64) };
const receipt = { submissionId: 'original-submission', uid: 'original-root', acceptedAt: '2026-11-09T00:00:00.000Z' };
const context = { sdkVersion: '2.3.0', rootUid: receipt.uid, submissionIds: [receipt.submissionId, 'prior-submission'] };
const report = (metadata: Record<string, unknown> = { kind: 'event', eventType: 'submission_running', eventIndex: 3,
  attemptCount: 2, maxAttempts: 4 }) => ({ version: 2, captureId: 'c'.repeat(64), timestamp: 1700000000000,
  records: [{ submissionId: receipt.submissionId, metadata }] });

// These tests qualify the parent protocol and retention, not SDK event production.
describe('REQ-OPERATOR-080/081: public SDK evidence without private storage access', () => {
  it.each(['prompt', 'args', 'result', 'sql', 'attemptId', 'batchSequence', 'source'])(
    'rejects private or invented %s metadata at the reporting boundary', field => {
      const value = report();
      value.records[0].metadata[field] = 'PRIVATE_VALUE';
      expect(publicSdkReportSchema.safeParse(value).success).toBe(false);
    });

  it('keeps observed attempt counts distinct from unavailable native identities and canonical coordinates', () => {
    const projected = projectPublicSdkRecords(publicSdkReportSchema.parse(report()), context);
    expect(projected[0].observation).toMatchObject({ owner: 'sdk', boundary: 'delivery', outcome: 'started',
      source: { package: '@flue/runtime', baseVersion: '2.3.0', patchSetDigest: null, status: 'partial', frames: [] },
      correlation: { rootDigest: hashDiagnostic(receipt.uid), submissionDigest: hashDiagnostic(receipt.submissionId) },
      publicSdk: { attemptCount: 2, maxAttempts: 4, eventIndex: 3 } });
    expect(projected[0].observation.correlation).not.toHaveProperty('sdkAttemptDigest');
    expect(projected[0].observation.correlation).not.toHaveProperty('sdkBatchSequence');
    expect(JSON.stringify(projected)).not.toMatch(/original-submission|original-root/);
  });

  it('binds delayed prior-submission observations to their own receipt rather than the current phase', () => {
    const value = report(); value.records[0].submissionId = 'prior-submission';
    const projected = projectPublicSdkRecords(publicSdkReportSchema.parse(value), context);
    expect(projected[0].observation.correlation.submissionDigest).toBe(hashDiagnostic('prior-submission'));
    value.records[0].submissionId = 'foreign-submission';
    expect(() => projectPublicSdkRecords(publicSdkReportSchema.parse(value), context)).toThrow(/binding/i);
  });

  it('retains pass-wide recovery without borrowing a current submission or attempt', () => {
    const value = { ...report(), records: [{ metadata: { kind: 'event', eventType: 'submission_recovery', eventIndex: 0,
      recoveryOperation: 'reconcile_pass', recoveryOutcome: 'deferred' } }] };
    const projected = projectPublicSdkRecords(publicSdkReportSchema.parse(value), context);
    expect(projected[0].observation).toMatchObject({ boundary: 'recovery', correlation: {} });
  });

  it('labels the public tool-batch commit witness without inventing operational finalization', () => {
    const projected = projectPublicSdkRecords(publicSdkReportSchema.parse(report({ kind: 'event',
      eventType: 'turn_messages', eventIndex: 9 })), context);
    expect(projected[0].observation).toMatchObject({ boundary: 'canonical-commit', outcome: 'committed',
      publicSdk: { eventType: 'turn_messages' } });
    expect(projected[0].observation.publicSdk).not.toHaveProperty('settlement');
  });

  it('bounds incoming records and refuses an invented incarnation', () => {
    const value = report();
    expect(publicSdkReportSchema.safeParse({ ...value, records: Array.from({ length: 65 }, () => value.records[0]) }).success).toBe(false);
    expect(() => projectPublicSdkRecords(publicSdkReportSchema.parse({ ...value,
      records: [{ ...value.records[0], rootUid: 'foreign-root' }] }), context)).toThrow(/binding/i);
  });

  it('bounds a passive read even when parent storage never responds', async () => {
    const unavailable = await readPublicSdkDiagnostics({ get: async () => new Promise<never>(() => {}) },
      binding, receipt, '2.3.0', Date.now() + 5);
    expect(unavailable).toEqual({ status: 'unavailable', reason: 'read-timeout' });
  });

  it('retains independent observations while deduplicating a replay of the same delivery', async () => {
    const data = new Map<string, unknown>();
    const tx = { get: async (key: string) => data.get(key), put: async (key: string, value: unknown) => { data.set(key, value); },
      delete: async (key: string) => { data.delete(key); } };
    await initializeDiagnostics(tx as never, binding, true);
    const first = publicSdkReportSchema.parse(report());
    for (const value of [first, first, { ...first, captureId: 'd'.repeat(64) }]) {
      for (const entry of projectPublicSdkRecords(value, context)) await appendDiagnostic(tx as never, binding, entry.observation, { captureId: entry.captureId });
    }
    const before = JSON.stringify([...data]);
    const output = await readPublicSdkDiagnostics(tx, binding, receipt, '2.3.0', Date.now() + 1000);
    expect(output).toMatchObject({ status: 'available', public: { format: 'flue-public-v3',
      receipt: { submissionDigest: hashDiagnostic(receipt.submissionId), rootDigest: hashDiagnostic(receipt.uid) },
      coverage: { complete: false } } });
    expect(output.public?.observations).toHaveLength(2);
    expect(output).not.toHaveProperty('stream');
    expect(output).not.toHaveProperty('canonical');
    expect(JSON.stringify([...data])).toBe(before);
    const eventKey = [...data.keys()].find(key => key.startsWith('dispatcher:diagnostics:event:'))!;
    const stored = data.get(eventKey) as { correlation: Record<string, unknown> };
    data.set(eventKey, { ...stored, correlation: { ...stored.correlation, sdkAttemptDigest: 'e'.repeat(64) } });
    const forged = await readPublicSdkDiagnostics(tx, binding, receipt, '2.3.0', Date.now() + 1000);
    expect(forged).toEqual({ status: 'unavailable', reason: 'invalid-metadata' });
  });
});

describe('REQ-OPERATOR-080/081: authenticated normal-host public capture', () => {
  const options = { normalHosting: true, repositoryOnly: true };
  it('retains evidence across reconstruction and serves owner reads without child access or execution changes', () => fixture(async f => {
    await start(f);
    const original = [...f.normalTransport!.admissions.values()][0].receipt;
    const payload = report(); payload.records[0].submissionId = original.submissionId;
    const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'diagnostic/runtime', payload));
    expect(response.status).toBe(204);
    const before = await f.activity.getBrowserDetail();
    const deadline = (await f.activity.getRuntimePlan())!.deadline;
    const childRequests = structuredClone(f.normalTransport!.requests);
    const restored = f.restart();
    const snapshot = await restored.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(snapshot?.sdk).toMatchObject({ status: 'available', public: { format: 'flue-public-v3',
      receipt: { submissionDigest: hashDiagnostic(original.submissionId), rootDigest: hashDiagnostic(original.uid) } } });
    expect(snapshot?.sdk.public?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metadata: expect.objectContaining({ eventType: 'submission_running', attemptCount: 2 }) }),
    ]));
    const history = await diagnosticTraversal(diagnosticsBrowser(f));
    expect(history.records).toEqual(expect.arrayContaining([expect.objectContaining({ owner: 'sdk',
      publicSdk: expect.objectContaining({ eventType: 'submission_running' }) })]));
    expect(await restored.getDispatcherDiagnostics('e'.repeat(64))).toBeNull();
    expect(f.normalTransport!.requests).toEqual(childRequests);
    expect((await restored.getRuntimePlan())!.deadline).toBe(deadline);
    expect(await restored.getBrowserDetail()).toMatchObject({ executionStatus: before!.executionStatus, result: before!.result });
    await restored.cancelDrive();
    const retiredRequests = structuredClone(f.normalTransport!.requests);
    const retired = await restored.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(retired?.sdk.public?.observations).toEqual(snapshot?.sdk.public?.observations);
    expect(f.normalTransport!.requests).toEqual(retiredRequests);
    const late = { ...payload, captureId: 'd'.repeat(64) };
    expect((await f.installationCapability.fetch(normalCallback(f.activityId, 'diagnostic/runtime', late))).status).toBe(204);
    expect((await restored.getDispatcherDiagnostics(f.proof.ownerKey))?.sdk.public?.observations).toHaveLength(2);
    expect(f.normalTransport!.requests).toEqual(retiredRequests);
  }, options));

  it.each(['foreign-submission', 'foreign-generation', 'foreign-deployment'])('rejects %s without attaching false evidence', fault => fixture(async f => {
    await start(f);
    const payload = report(); payload.records[0].submissionId = [...f.normalTransport!.admissions.values()][0].receipt.submissionId;
    if (fault === 'foreign-submission') payload.records[0].submissionId = 'foreign';
    const headers: Record<string, string> | undefined = fault === 'foreign-generation' ? { 'x-codeflare-operator-generation': '2' }
      : fault === 'foreign-deployment' ? { 'x-codeflare-operator-worker-version': 'foreign' } : undefined;
    const response = await f.installationCapability.fetch(normalCallback(f.activityId, 'diagnostic/runtime', payload, headers));
    expect(response.status).toBeGreaterThanOrEqual(400);
    const snapshot = await f.activity.getDispatcherDiagnostics(f.proof.ownerKey);
    expect(snapshot?.sdk.public?.observations ?? []).toEqual([]);
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
  }, options));

  it.each([false, true])('logging disabled or recorder failure remains non-authorizing (recorder failure=%s)', failure => fixture(async f => {
    await start(f);
    const payload = report(); payload.records[0].submissionId = [...f.normalTransport!.admissions.values()][0].receipt.submissionId;
    if (failure) await denyDiagnosticWrites(f);
    await f.installationCapability.fetch(normalCallback(f.activityId, 'diagnostic/runtime', payload));
    expect(await f.activity.getBrowserDetail()).toMatchObject({ executionStatus: 'running', result: null });
    expect(await f.activity.collectBrowserResult()).toEqual({ ok: false, reason: 'not-ready' });
  }, { ...options, loggingEnabled: failure }));
});
