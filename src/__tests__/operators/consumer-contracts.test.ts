/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * REQ-OPERATOR-009 fixture evidence only. These generic consumer records do not
 * implement Review business logic, publish checks or grant history authority.
 */
import { describe, expect, it } from 'vitest';
import { parseOperatorConsumerInvocation, reconcileOperatorConsumerInvocation,
  validateOperatorSessionOrigin } from '../../operators/consumer-contracts';
import { consumerContractFixtures } from './fixtures/consumer-contracts';

describe('REQ-OPERATOR-009: reusable bounded consumer contracts', () => {
  it('accepts minimal direct, session and webhook fixture shapes without business-specific fields', () => {
    for (const fixture of consumerContractFixtures) {
      expect(parseOperatorConsumerInvocation(fixture)).toEqual(fixture);
      expect(JSON.stringify(fixture)).not.toMatch(/review|pullRequest|mergeGate|githubToken/i);
    }
  });

  it('bounds opaque attachments and rejects authority, recursive payloads and path-like names', () => {
    const base = consumerContractFixtures[1];
    for (const invalid of [
      { ...base, attachments: Array.from({ length: 17 }, (_, i) => ({ ...base.attachments[0], name: `a${i}` })) },
      { ...base, attachments: [{ ...base.attachments[0], size: 8 * 1024 * 1024 + 1 }] },
      { ...base, attachments: [{ ...base.attachments[0], name: '../secret' }] },
      { ...base, accessJwt: 'private.jwt' },
      { ...base, input: { nested: { authority: { token: 'private' } } } },
    ]) expect(() => parseOperatorConsumerInvocation(invalid)).toThrow(/invalid consumer invocation/i);
  });

  it('reconciles exact run identity and rejects changed immutable source, revision or inputs', () => {
    const original = parseOperatorConsumerInvocation(consumerContractFixtures[0]);
    expect(reconcileOperatorConsumerInvocation(original, structuredClone(original))).toEqual(original);
    for (const changed of [
      { ...original, revision: { ...original.revision, digest: 'f'.repeat(64) } },
      { ...original, source: { ...original.source, reference: 'other' } },
      { ...original, inputDigest: 'e'.repeat(64) },
    ]) expect(() => reconcileOperatorConsumerInvocation(original, changed)).toThrow(/conflict/i);
  });

  it('binds session origin to the parent and denies operator recursion through human admission', () => {
    expect(validateOperatorSessionOrigin({ kind: 'human', ownerKey: 'a'.repeat(64) },
      { principal: 'human', ownerKey: 'a'.repeat(64), activityId: null })).toEqual({ kind: 'human', ownerKey: 'a'.repeat(64) });
    expect(validateOperatorSessionOrigin({ kind: 'operator', parentActivityId: 'activity-1' },
      { principal: 'operator', ownerKey: 'a'.repeat(64), activityId: 'activity-1' }))
      .toEqual({ kind: 'operator', parentActivityId: 'activity-1' });
    expect(() => validateOperatorSessionOrigin({ kind: 'human', ownerKey: 'a'.repeat(64) },
      { principal: 'operator', ownerKey: 'a'.repeat(64), activityId: 'activity-1' })).toThrow(/recursive/i);
    expect(() => validateOperatorSessionOrigin({ kind: 'operator', parentActivityId: 'other' },
      { principal: 'operator', ownerKey: 'a'.repeat(64), activityId: 'activity-1' })).toThrow(/origin/i);
  });
});
