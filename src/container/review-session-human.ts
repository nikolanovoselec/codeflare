import { z } from 'zod';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import { ForbiddenError, ValidationError } from '../lib/error-types';
import { openOperatorSecret, sealOperatorSecret } from '../operators/protected-secrets';
import { SHUTDOWN_REQUESTED_KEY } from './container-metrics';

const identity = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const claims = z.strictObject({
  subject: z.string().min(1).max(512), email: z.string().email().max(320),
  issuer: z.string().url().max(2048), audiences: z.array(z.string().min(1).max(512)).min(1).max(16),
  groups: z.array(z.string().min(1).max(256)).max(1024).optional(),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
});
const envelope = z.strictObject({ bucket: identity, sessionId: identity,
  generation: z.number().int().nonnegative(), human: claims,
  accessJwt: z.string().min(1).max(65_536) });
type SealedHuman = z.infer<typeof envelope>;
type Principal = Pick<SealedHuman, 'bucket' | 'sessionId' | 'generation'> & {
  subject: string; email: string; issuer: string; audiences: string[];
};
const KEY = 'review:session-human';
const OWNER_KEY = 'review:session-principal';
type Storage = { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<unknown> };
type Host = {
  _bucketName: string | null; _sessionId: string | null; _userEmail: string | null;
  _shutdownStartedAt?: number; env: { ENCRYPTION_KEY?: string };
  ctx: { storage: Storage & { transaction<T>(callback: (tx: Storage) => Promise<T>): Promise<T> } };
};
const recordId = (bucket: string, sessionId: string) => JSON.stringify([bucket, sessionId]);
function own(host: Host, bucket: string, sessionId: string, email: string) {
  if (host._bucketName !== bucket || host._sessionId !== sessionId
    || host._userEmail?.toLowerCase() !== email.toLowerCase()) throw new ForbiddenError('Session ownership mismatch');
}
async function read(host: Host, store: Storage, bucket: string, sessionId: string): Promise<SealedHuman | null> {
  const ciphertext = await store.get(KEY);
  if (ciphertext == null) return null;
  if (typeof ciphertext !== 'string') throw new ForbiddenError('Session authority unavailable');
  try {
    const plaintext = await openOperatorSecret(ciphertext, host.env,
      { purpose: 'human-access', recordId: recordId(bucket, sessionId) });
    const parsed = envelope.parse(JSON.parse(plaintext));
    if (parsed.bucket !== bucket || parsed.sessionId !== sessionId) throw Error('Wrong session');
    return parsed;
  } catch { throw new ForbiddenError('Session authority unavailable'); }
}
async function readPrincipal(host: Host, store: Storage, bucket: string, sessionId: string): Promise<Principal | null> {
  const ciphertext = await store.get(OWNER_KEY);
  if (ciphertext == null) return null;
  if (typeof ciphertext !== 'string') throw new ForbiddenError('Session principal unavailable');
  try {
    const plaintext = await openOperatorSecret(ciphertext, host.env,
      { purpose: 'human-access', recordId: `${recordId(bucket, sessionId)}:principal` });
    const value = JSON.parse(plaintext) as Principal;
    if (value.bucket !== bucket || value.sessionId !== sessionId || typeof value.subject !== 'string'
      || typeof value.email !== 'string' || typeof value.issuer !== 'string'
      || !Array.isArray(value.audiences)) throw Error('Wrong principal');
    return value;
  } catch { throw new ForbiddenError('Session principal unavailable'); }
}
function principal(data: SealedHuman): Principal {
  return { bucket: data.bucket, sessionId: data.sessionId, generation: data.generation,
    subject: data.human.subject,
    email: data.human.email, issuer: data.human.issuer, audiences: data.human.audiences };
}
function same(a: Principal, b: Principal): boolean {
  return a.generation === b.generation && a.subject === b.subject
    && a.email.toLowerCase() === b.email.toLowerCase()
    && a.issuer === b.issuer && JSON.stringify(a.audiences) === JSON.stringify(b.audiences);
}

/** Authenticated parent only. Null revokes the credential but cannot replace the session principal. */
export async function bindReviewSessionHuman(host: Host, input: {
  bucket: string; sessionId: string; generation: number;
  human: VerifiedHumanAccessClaims; accessJwt: string;
} | null): Promise<void> {
  if (input === null) { await host.ctx.storage.delete(KEY); return; }
  const parsed = envelope.safeParse(input);
  if (!parsed.success || parsed.data.human.expiresAt * 1000 <= Date.now()
    || parsed.data.human.issuedAt > parsed.data.human.expiresAt) throw new ValidationError('Invalid human authority');
  const { bucket, sessionId, human } = parsed.data;
  own(host, bucket, sessionId, human.email);
  const ciphertext = await sealOperatorSecret(JSON.stringify(parsed.data), host.env,
    { purpose: 'human-access', recordId: recordId(bucket, sessionId) });
  const selectedPrincipal = principal(parsed.data);
  const principalCiphertext = await sealOperatorSecret(JSON.stringify(selectedPrincipal), host.env,
    { purpose: 'human-access', recordId: `${recordId(bucket, sessionId)}:principal` });
  await host.ctx.storage.transaction(async tx => {
    own(host, bucket, sessionId, human.email);
    if ((host._shutdownStartedAt ?? 0) > 0 || await tx.get(SHUTDOWN_REQUESTED_KEY)
      || await tx.get('lifecycleGeneration') !== parsed.data.generation) {
      throw new ForbiddenError('Session is shutting down');
    }
    const previous = await readPrincipal(host, tx, bucket, sessionId);
    if (previous && !same(previous, selectedPrincipal)) throw new ForbiddenError('Session human mismatch');
    if (!previous) await tx.put(OWNER_KEY, principalCiphertext);
    await tx.put(KEY, ciphertext);
  });
}

/** Only terminal lifecycle cleanup discards both the sealed credential and immutable principal. */
export async function discardReviewSessionHuman(host: Host): Promise<void> {
  await host.ctx.storage.delete(KEY);
  await host.ctx.storage.delete(OWNER_KEY);
}

/** Parent-only read: credentials never enter interceptor props, logs or child environment. */
export async function openReviewSessionHuman(host: Host, ref: { bucket: string; sessionId: string; email: string }): Promise<{
  human: VerifiedHumanAccessClaims; accessJwt: string;
}> {
  own(host, ref.bucket, ref.sessionId, ref.email);
  if ((host._shutdownStartedAt ?? 0) > 0 || await host.ctx.storage.get(SHUTDOWN_REQUESTED_KEY)) {
    throw new ForbiddenError('Session authority unavailable');
  }
  const [data, owner] = await Promise.all([
    read(host, host.ctx.storage, ref.bucket, ref.sessionId),
    readPrincipal(host, host.ctx.storage, ref.bucket, ref.sessionId),
  ]);
  if (!data || !owner || !same(owner, principal(data))
    || await host.ctx.storage.get('lifecycleGeneration') !== data.generation
    || data.human.email.toLowerCase() !== ref.email.toLowerCase()
    || data.human.expiresAt * 1000 <= Date.now()) throw new ForbiddenError('Session authority unavailable');
  return { human: data.human, accessJwt: data.accessJwt };
}
