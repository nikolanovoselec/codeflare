import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindReviewSessionHuman, openReviewSessionHuman } from '../../container/review-session-human';

const bucket = 'codeflare-enterprise-review';
const sessionId = 'review1234';
const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
afterEach(() => vi.useRealTimers());
const human = { subject: 'human-one', email: 'owner@example.test', issuer: 'https://team.cloudflareaccess.com',
  audiences: ['aud'], issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 300 };
function session() {
  const records = new Map<string, unknown>();
  const storage = { get: async (key: string) => records.get(key), put: async (key: string, value: unknown) => { records.set(key, value); },
    delete: async (key: string) => { records.delete(key); } };
  const host = { _bucketName: bucket, _sessionId: sessionId, _userEmail: human.email, ctx: { storage }, env: encryption };
  return { host, records };
}

describe('REQ-OPERATOR-053: parent-only Enterprise session authority', () => {
  it('survives a DO wake encrypted and reopens only for the bound session and owner', async () => {
    const { host, records } = session();
    await bindReviewSessionHuman(host, { bucket, sessionId, human, accessJwt: 'private.jwt' });
    expect(JSON.stringify([...records])).not.toContain('private.jwt');
    expect(await openReviewSessionHuman({ ...host }, { bucket, sessionId, email: human.email })).toEqual({ human, accessJwt: 'private.jwt' });
    await expect(openReviewSessionHuman({ ...host, _sessionId: 'other-session' }, { bucket, sessionId, email: human.email })).rejects.toThrow();
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: 'foreign@example.test' })).rejects.toThrow();
  });
  it('clears stale authority on unauthenticated reconnect and never lends it to another session', async () => {
    const { host } = session();
    await bindReviewSessionHuman(host, { bucket, sessionId, human, accessJwt: 'private.jwt' });
    await bindReviewSessionHuman(host, null);
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: human.email })).rejects.toThrow();
    await expect(bindReviewSessionHuman(host, { bucket, sessionId,
      human: { ...human, subject: 'other' }, accessJwt: 'borrowed.jwt' })).rejects.toThrow();
  });
  it('rejects an assertion after its expiry even when its encrypted record survives', async () => {
    const { host } = session();
    await bindReviewSessionHuman(host, { bucket, sessionId, human, accessJwt: 'private.jwt' });
    vi.useFakeTimers();
    vi.setSystemTime((human.expiresAt + 1) * 1000);
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: human.email })).rejects.toThrow();
  });
  it('refuses an expired human and a different subject on rebind', async () => {
    const { host } = session();
    await bindReviewSessionHuman(host, { bucket, sessionId, human, accessJwt: 'private.jwt' });
    await expect(bindReviewSessionHuman(host, { bucket, sessionId, human: { ...human, subject: 'another' }, accessJwt: 'other.jwt' })).rejects.toThrow();
    await expect(bindReviewSessionHuman(host, { bucket, sessionId, human: { ...human, expiresAt: 1 }, accessJwt: 'expired.jwt' })).rejects.toThrow();
  });
});
