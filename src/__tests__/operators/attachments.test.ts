import { describe, expect, it } from 'vitest';
import { projectOperatorAttachments, resolveOperatorAttachment } from '../../operators/attachments';

const digest = 'a'.repeat(64);
const invocation = {
  schemaVersion: 1 as const, interfaceVersion: 1 as const, consumerId: 'consumer', activityId: 'activity-1',
  operatorId: 'conductor-review', runId: 'run-1', source: { kind: 'webhook' as const, reference: 'owner/repository#17' },
  revision: { reference: 'release-1', digest: 'b'.repeat(64) }, inputDigest: 'c'.repeat(64),
  input: { packet: { reference: 'prepared-review-packet-1', digest } },
  attachments: [{ name: 'packet.json', mediaType: 'application/json', size: 128, sha256: digest, locator: 'packet-1' }],
  resources: { inference: null, session: { profileId: 'review-session' }, storage: { scopeId: 'review-storage' } },
};

describe('operator opaque attachment ownership', () => {
  it('projects only bounded transport metadata and resolves a fixed parent-owned destination', () => {
    const projected = projectOperatorAttachments(invocation);
    expect(projected).toEqual({ schemaVersion: 1, activityId: 'activity-1', files: invocation.attachments });
    expect(resolveOperatorAttachment(projected, { locator: 'packet-1', sha256: digest, size: 128 })).toEqual({
      status: 'restored', path: '/run/codeflare/operator-resources/input/packet.json',
    });
  });

  it('denies undeclared locator, digest, size and duplicate destinations', () => {
    const projected = projectOperatorAttachments(invocation);
    for (const request of [
      { locator: 'foreign', sha256: digest, size: 128 },
      { locator: 'packet-1', sha256: 'd'.repeat(64), size: 128 },
      { locator: 'packet-1', sha256: digest, size: 129 },
    ]) expect(() => resolveOperatorAttachment(projected, request)).toThrow(/denied/i);
    expect(() => projectOperatorAttachments({ ...invocation,
      attachments: [...invocation.attachments, { ...invocation.attachments[0], locator: 'packet-2' }] })).toThrow();
  });
});
