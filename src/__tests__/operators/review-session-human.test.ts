import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindReviewSessionHuman, discardReviewSessionHuman, openReviewSessionHuman } from '../../container/review-session-human';

const bucket = 'codeflare-enterprise-review';
const sessionId = 'review1234';
const generation = 1;
const encryption = { ENCRYPTION_KEY: btoa('a'.repeat(32)) };
afterEach(() => vi.useRealTimers());
const human = { subject: 'human-one', email: 'owner@example.test', issuer: 'https://team.cloudflareaccess.com',
  audiences: ['aud'], issuedAt: Math.floor(Date.now() / 1000) - 10, expiresAt: Math.floor(Date.now() / 1000) + 300 };
const bound = { bucket, sessionId, generation, human, accessJwt: 'private.jwt' };
function session() {
  const records = new Map<string, unknown>([['lifecycleGeneration', generation]]);
  const actions = { get: async (key: string) => records.get(key), put: async (key: string, value: unknown) => { records.set(key, value); },
    delete: async (key: string) => { records.delete(key); } };
  const storage = { ...actions, transaction: async <T>(work: (tx: typeof actions) => Promise<T>) => work(actions) };
  const host = { _bucketName: bucket, _sessionId: sessionId, _userEmail: human.email, ctx: { storage }, env: encryption };
  return { host, records };
}

describe('REQ-OPERATOR-053: parent-only Enterprise session authority', () => {
  it('survives a DO wake encrypted and reopens only for the bound session and owner', async () => {
    const { host, records } = session();
    await bindReviewSessionHuman(host, bound);
    expect(JSON.stringify([...records])).not.toContain('private.jwt');
    expect(await openReviewSessionHuman({ ...host }, { bucket, sessionId, email: human.email })).toEqual({ human, accessJwt: 'private.jwt' });
    await expect(openReviewSessionHuman({ ...host, _sessionId: 'other-session' }, { bucket, sessionId, email: human.email })).rejects.toThrow();
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: 'foreign@example.test' })).rejects.toThrow();
  });
  it('revokes the credential without losing the immutable principal', async () => {
    const { host } = session();
    await bindReviewSessionHuman(host, bound);
    await bindReviewSessionHuman(host, null);
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: human.email })).rejects.toThrow();
    await expect(bindReviewSessionHuman(host, { ...bound, human: { ...human, subject: 'other' },
      accessJwt: 'borrowed.jwt' })).rejects.toThrow();
  });
  it('rejects an assertion after its expiry even when its encrypted record survives', async () => {
    const { host } = session();
    await bindReviewSessionHuman(host, bound);
    vi.useFakeTimers();
    vi.setSystemTime((human.expiresAt + 1) * 1000);
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: human.email })).rejects.toThrow();
  });
  it('rejects delayed old-generation binding while allowing a genuinely new lifecycle', async () => {
    const { host, records } = session();
    await bindReviewSessionHuman(host, bound);
    records.set('shutdownRequested', Date.now());
    await expect(bindReviewSessionHuman(host, bound)).rejects.toThrow();
    await discardReviewSessionHuman(host);
    records.set('lifecycleGeneration', 2);
    records.delete('shutdownRequested');
    await expect(bindReviewSessionHuman(host, bound)).rejects.toThrow();
    await bindReviewSessionHuman(host, { ...bound, generation: 2 });
    expect(await openReviewSessionHuman(host, { bucket, sessionId, email: human.email }))
      .toEqual({ human, accessJwt: 'private.jwt' });
  });
  it('REQ-OPERATOR-053: an old prepared Action cannot reopen human authority after stop or generation replacement', async () => {
    const { host, records } = session();
    await bindReviewSessionHuman(host, bound);
    records.set('shutdownRequested', Date.now());
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: human.email })).rejects.toThrow();
    records.delete('shutdownRequested');
    records.set('lifecycleGeneration', generation + 1);
    await expect(openReviewSessionHuman(host, { bucket, sessionId, email: human.email })).rejects.toThrow();
  });
  it('refuses an expired human and a different subject on rebind', async () => {
    const { host } = session();
    await bindReviewSessionHuman(host, bound);
    await expect(bindReviewSessionHuman(host, { ...bound, human: { ...human, subject: 'another' },
      accessJwt: 'other.jwt' })).rejects.toThrow();
    await expect(bindReviewSessionHuman(host, { ...bound, human: { ...human, expiresAt: 1 },
      accessJwt: 'expired.jwt' })).rejects.toThrow();
  });
});
