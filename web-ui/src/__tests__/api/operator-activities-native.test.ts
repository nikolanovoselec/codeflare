import { describe, expect, it } from 'vitest';
import { operatorActivitySummarySchema } from '../../api/operator-activities';

const nativeSelection = { source: 'pi-native', provider: 'openai-codex', model: 'gpt-6.1-sol',
  api: 'openai-codex-responses', reasoningLevel: 'low', profileDigest: 'a'.repeat(64) };
const summary = { activityId: 'native-activity', operatorId: 'operator', executionStatus: 'failed',
  cleanupStatus: 'pending', collectionStatus: 'unavailable', attention: true,
  sessionId: null, source: null, updatedAt: 1 };

describe('REQ-OPERATOR-007/047: native Activity functional browser wire', () => {
  it.each(['installation', 'inherited'] as const)('retains %s reasoning and login recovery in Runs without diagnostics', reasoningSource => {
    const wire = { ...summary, inferenceSelection: { ...nativeSelection, reasoningSource },
      authFailure: { code: 'PI_LOGIN_REQUIRED', reason: 'rejected', provider: 'openai-codex' } };
    expect(operatorActivitySummarySchema.parse(wire)).toEqual(wire);
  });
  it('preserves configured custom SDK identity and closed login recovery without a built-in provider catalogue', () => {
    const provider = 'Owner.Custom/router';
    const wire = { ...summary, inferenceSelection: { ...nativeSelection, provider, api: 'owner.dynamic/api', model: 'team/custom/model' },
      authFailure: { code: 'PI_LOGIN_REQUIRED', reason: 'missing', provider } };
    expect(operatorActivitySummarySchema.parse(wire)).toEqual(wire);
    expect(operatorActivitySummarySchema.safeParse({ ...wire,
      authFailure: { ...wire.authFailure, provider: `${provider}\nPRIVATE` } }).success).toBe(false);
  });
  it('rejects arbitrary authentication text and credential-bearing native metadata', () => {
    expect(operatorActivitySummarySchema.safeParse({ ...summary, inferenceSelection: nativeSelection,
      authFailure: { code: 'PI_LOGIN_REQUIRED', reason: 'untrusted-upstream-text', provider: 'openai-codex' } }).success).toBe(false);
    expect(operatorActivitySummarySchema.safeParse({ ...summary,
      inferenceSelection: { ...nativeSelection, apiKey: 'SYNTHETIC_NOT_PUBLIC' } }).success).toBe(false);
  });
});
