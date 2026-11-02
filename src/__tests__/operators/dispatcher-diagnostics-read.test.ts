/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from 'vitest';
import { readActivityDiagnostics, type DiagnosticReadState } from '../../operators/dispatcher-diagnostics-read';
import { appendDiagnostic, initializeDiagnostics } from '../../operators/dispatcher-diagnostics-store';
import { captureError, hostSource } from '../../operators/dispatcher-diagnostics-wire';

// External metadata storage only; production recording and public readback are real.
function metadataStorage() {
  const rows = new Map<string, unknown>();
  return {
    get: async (key: string) => structuredClone(rows.get(key)),
    put: async (key: string, value: unknown) => { rows.set(key, structuredClone(value)); },
    delete: async (key: string) => rows.delete(key),
  } as unknown as DurableObjectStorage;
}

describe('REQ-OPERATOR-084: current fence and earlier continued failures', () => {
  it.each([true, false])(
    'reports the current fence rather than a continued citation failure, optional fence event=%s', async retained => {
      const storage = metadataStorage();
      const binding = { generation: 1, artifactDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64) };
      await initializeDiagnostics(storage, binding, false);
      await appendDiagnostic(storage, binding, { timestamp: 10, owner: 'host', boundary: 'tool', outcome: 'failed',
        code: 'tool-failed', evidence: 'observed', origin: 'catching', correlation: {}, source: hostSource('tool'),
        error: { ...captureError(new Error('Citation rejected')), publicCode: 'citation-provenance' } });
      await appendDiagnostic(storage, binding, { timestamp: 20, owner: 'host', boundary: 'tool', outcome: 'completed',
        code: 'none', evidence: 'observed', origin: 'state-transition', correlation: {}, source: hostSource('tool') });
      if (retained) await appendDiagnostic(storage, binding, { timestamp: 30, owner: 'host', boundary: 'settlement', outcome: 'unknown',
        code: 'settlement-failed', evidence: 'observed', origin: 'state-transition', correlation: {}, source: hostSource('settlement') },
      { terminalGeneration: 1 });
      const state: DiagnosticReadState = { ownerKey: 'owner', activityId: 'causal-summary', binding, bindingValid: true,
        expectedIndex: true, logging: true, status: 'unknown', operations: 0, provenance: null,
        fence: { generation: 1, timestamp: 30, boundary: 'settlement', code: 'settlement-failed', uncertain: true } };
      const input = { storage, env: {}, ownerKey: 'owner', state: async () => state,
        projectOperation: async (): Promise<never> => { throw new Error('No operation in this metadata fixture'); } };

      const summary = await readActivityDiagnostics(input, { view: 'summary' });
      expect(summary).toMatchObject({ fence: state.fence, diagnosis: { state: 'observed-failure', executionStatus: 'unknown',
        code: 'settlement-failed', failedId: retained ? 'e-3' : null, nextCheck: 'inspect-failure' } });
      expect(summary).not.toHaveProperty('diagnosis.publicCode');
      expect(summary).not.toHaveProperty('diagnosis.continuedId');
      // Demoting an earlier cause must not delete or relabel its retained evidence.
      expect(await readActivityDiagnostics(input, { view: 'detail', recordId: 'e-1' })).toMatchObject({
        record: { id: 'e-1', boundary: 'tool', outcome: 'failed', error: { publicCode: 'citation-provenance' } },
      });
    });

  it('keeps an unknown effect visible after later work and an execution fence', async () => {
    const storage = metadataStorage();
    const binding = { generation: 1, artifactDigest: 'a'.repeat(64), inputDigest: 'b'.repeat(64) };
    await initializeDiagnostics(storage, binding, false);
    await appendDiagnostic(storage, binding, { timestamp: 10, owner: 'host', boundary: 'effect', outcome: 'unknown',
      code: 'effect-unknown', evidence: 'observed', origin: 'state-transition', correlation: {}, source: hostSource('effect') });
    await appendDiagnostic(storage, binding, { timestamp: 20, owner: 'host', boundary: 'tool', outcome: 'completed',
      code: 'none', evidence: 'observed', origin: 'state-transition', correlation: {}, source: hostSource('tool') });
    const state: DiagnosticReadState = { ownerKey: 'owner', activityId: 'causal-summary', binding, bindingValid: true,
      expectedIndex: true, logging: true, status: 'unknown', operations: 0, provenance: null,
      fence: { generation: 1, timestamp: 30, boundary: 'settlement', code: 'settlement-failed', uncertain: true } };
    const summary = await readActivityDiagnostics({ storage, env: {}, ownerKey: 'owner', state: async () => state,
      projectOperation: async (): Promise<never> => { throw new Error('No operation in this metadata fixture'); } }, { view: 'summary' });
    expect(summary).toMatchObject({ fence: state.fence, diagnosis: { state: 'observed-failure', code: 'settlement-failed',
      failedId: 'e-1', continuedId: 'e-2', nextCheck: 'inspect-failure' } });
  });
});
