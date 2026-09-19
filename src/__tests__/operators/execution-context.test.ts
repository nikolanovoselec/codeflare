/**
 * Protected execution-context contract: verified human capture, safe projection,
 * exact activity binding and same-owner reauthentication. This is cryptographic
 * parent-state evidence, not live Access eligibility or deployed revocation proof.
 */
import { describe, expect, it } from 'vitest';
import type { VerifiedHumanAccessClaims } from '../../lib/jwt';
import { createOperatorExecutionContext, openOperatorExecutionAccess,
  projectOperatorExecution, reauthenticateOperatorExecution } from '../../operators/execution-context';

const env = { ENCRYPTION_KEY: btoa('e'.repeat(32)) };
const human = (overrides: Partial<VerifiedHumanAccessClaims> = {}): VerifiedHumanAccessClaims => ({
  subject: 'human-subject', email: 'human@example.test', issuer: 'https://access.example.test',
  audiences: ['operator-audience'], issuedAt: Math.floor(Date.now() / 1000) - 10,
  expiresAt: Math.floor(Date.now() / 1000) + 300, ...overrides,
});
const input = (overrides: Record<string, unknown> = {}) => ({ activityId: 'activity_1', operatorId: 'operator_1',
  artifactDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64), human: human(), accessJwt: 'signed.jwt.assertion', ...overrides });

describe('REQ-OPERATOR-003: protected verified execution context', () => {
  it('encrypts Access authority for one activity and exposes only a safe immutable projection', async () => {
    const context = await createOperatorExecutionContext(input(), env);
    expect(context).toMatchObject({ schemaVersion: 1, activityId: 'activity_1', operatorId: 'operator_1',
      principal: 'operator', artifactDigest: 'a'.repeat(64), policyDigest: 'b'.repeat(64),
      owner: { subject: 'human-subject', email: 'human@example.test' } });
    expect(context.protectedAccessCiphertext).toMatch(/^v1:/);
    expect(JSON.stringify(context)).not.toContain('signed.jwt.assertion');
    expect(projectOperatorExecution(context)).not.toHaveProperty('protectedAccessCiphertext');
    expect(await openOperatorExecutionAccess(context, env)).toEqual({ human: human(), accessJwt: 'signed.jwt.assertion' });
  });

  it('binds ciphertext to the exact activity and fails closed without protected storage', async () => {
    const context = await createOperatorExecutionContext(input(), env);
    await expect(openOperatorExecutionAccess({ ...context, activityId: 'activity_2' }, env)).rejects.toThrow('protection');
    await expect(createOperatorExecutionContext(input(), {})).rejects.toThrow('protection');
    await expect(openOperatorExecutionAccess(context, { ENCRYPTION_KEY: btoa('x'.repeat(32)) })).rejects.toThrow('protection');
  });

  it('rejects malformed, expired and caller-invented execution identities before encryption', async () => {
    for (const override of [
      { activityId: '../activity' }, { operatorId: '' }, { artifactDigest: 'A'.repeat(64) },
      { policyDigest: 'short' }, { human: human({ expiresAt: Math.floor(Date.now() / 1000) - 1 }) },
      { accessJwt: '' }, { accessJwt: 'x'.repeat(65537) },
    ]) await expect(createOperatorExecutionContext(input(override), env)).rejects.toThrow();
  });

  it('allows only the same human and issuer to replace authority without changing pinned identities', async () => {
    const context = await createOperatorExecutionContext(input(), env);
    const renewed = human({ issuedAt: human().issuedAt + 30, expiresAt: human().expiresAt + 300 });
    const next = await reauthenticateOperatorExecution(context, renewed, 'renewed.jwt.assertion', env);
    expect(projectOperatorExecution(next)).toEqual({ ...projectOperatorExecution(context), expiresAt: renewed.expiresAt });
    expect(await openOperatorExecutionAccess(next, env)).toEqual({ human: renewed, accessJwt: 'renewed.jwt.assertion' });
    for (const candidate of [human({ subject: 'other' }), human({ email: 'other@example.test' }),
      human({ issuer: 'https://other.example.test' }), human({ audiences: ['other-audience'] })]) {
      await expect(reauthenticateOperatorExecution(context, candidate, 'renewed.jwt.assertion', env)).rejects.toThrow('owner');
    }
  });

  it('does not accept ciphertext from the ordinary plaintext fallback', async () => {
    const context = await createOperatorExecutionContext(input(), env);
    await expect(openOperatorExecutionAccess({ ...context, protectedAccessCiphertext: 'plaintext-token' }, env))
      .rejects.toThrow('protection');
  });
});
