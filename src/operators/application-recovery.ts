import { z } from 'zod';
import type { Env } from '../types';
import type { VerifiedHumanAccessClaims } from '../lib/jwt';
import type { ApplicationExecutionAuthority } from './application-workflow';
import { applicationStateRecordValid, verifyApplicationStateRecovery, type StateRecord } from './application-state';
import { openOperatorSecret } from './protected-secrets';
import { readBoundedResponse } from '../lib/bounded-stream';
import { AppError, ValidationError } from '../lib/error-types';

export interface RecoveryFactsRequest {
  human: VerifiedHumanAccessClaims;
  deadline: number;
  original: ApplicationExecutionAuthority['original'];
  ledger: ApplicationExecutionAuthority['ledger'];
}
export type RecoveryFacts = { resettable: false; reason: string } | {
  resettable: true; reason: string; proofDigest: string; invocation?: unknown;
  origin: { generation: number; deadline: number };
};
// JSON escaping can expand a valid 1-KiB key sixfold; reserve room for
// its anchor metadata and the nested continuation cursor as well.
export const RECOVERY_CURSOR_MAX_CHARS = 16 * 1024;
const recoveryKey = z.string().min(1).max(1024);
const recoveryVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryEntries = z.array(z.strictObject({ key: recoveryKey, version: recoveryVersion })).min(1).max(64)
  .refine(items => new Set(items.map(item => item.key)).size === items.length);
export interface RecoveryRecord {
  key: string; version: string; value?: unknown; invocation?: unknown; activityId?: string;
  status: 'owned' | 'conflict' | 'unavailable'; reason: string; resettable: boolean;
}
interface RecoveryOriginal {
  activityId: string; installationId: string; ownerKey: string; sourceId: string;
  legacy: boolean; value: unknown;
}
export interface RecoveryInspection {
  record: RecoveryRecord; original?: RecoveryOriginal;
  storageKey: string; raw?: StateRecord; legacy: StateRecord['legacy'];
}
export const recoveryDigest = async (value: string): Promise<string> => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
const encode = (value: unknown) => JSON.stringify(value);
const bounded = (value: unknown) => new TextEncoder().encode(encode(value)).byteLength <= 64 * 1024;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const legacyRecoveryKey = (key: string): string | null => /^renovate:head:[1-9][0-9]*:[1-9][0-9]*:[a-f0-9]{40,64}$/.test(key)
  ? `renovate-admission:${key.slice('renovate:head:'.length)}` : null;
export const applicationRecoveryPrefix = async (sourceId: string) => `application-state:v1:${await recoveryDigest(sourceId)}:`;

/** Uses precisely the normal state adapter's overlay and legacy version scheme.
 * Ownership is evaluated before exposing values. Never returns foreign payloads. */
export async function inspectRecoveryRecord(storage: Pick<DurableObjectStorage, 'get'>, key: string, sourceId: string,
  ownerKey: string, legacyOwnership: (value: Record<string, unknown>) => Promise<string | null>): Promise<RecoveryInspection> {
  if (!recoveryKey.safeParse(key).success) throw new AppError('UNAVAILABLE', 503, 'Invalid stored recovery key');
  const storageKey = `${await applicationRecoveryPrefix(sourceId)}${await recoveryDigest(key)}`;
  const raw = await storage.get<unknown>(storageKey);
  const aliasKey = legacyRecoveryKey(key);
  const prior = aliasKey ? await storage.get<unknown>(aliasKey) : undefined;
  if (raw !== undefined && !bounded(raw) || prior !== undefined && !bounded(prior)) {
    throw new AppError('UNAVAILABLE', 503, 'Recovery record exceeds limit');
  }
  const legacy: StateRecord['legacy'] = aliasKey ? { storageKey: aliasKey, version: prior === undefined ? null : await recoveryDigest(encode(prior)) } : null;
  const version = raw === undefined ? await recoveryDigest(encode(['legacy', sourceId, key, legacy])) : await recoveryDigest(`record:${encode(raw)}`);
  const base = { storageKey, legacy, record: { key, version, status: 'unavailable' as const, reason: 'malformed', resettable: false } };
  const blocked = (reason: string, status: RecoveryRecord['status'] = 'conflict'): RecoveryInspection => ({ ...base, record: { ...base.record, status, reason } });
  if (raw !== undefined) {
    if (!bounded(raw) || !applicationStateRecordValid(raw) || raw.key !== key) return blocked('malformed', 'unavailable');
    if (raw.ownerKey !== ownerKey) return blocked('record-owner-mismatch');
    if (raw.sourceId !== sourceId) return blocked('source-mismatch');
  }
  const retainedRelease = raw !== undefined && applicationStateRecordValid(raw) && raw.recovery !== undefined;
  if (retainedRelease) {
    if (raw.legacy?.storageKey !== legacy?.storageKey || raw.legacy?.version !== legacy?.version) return blocked('legacy-version-drift');
    if (!await verifyApplicationStateRecovery(storage, raw, legacy)) return blocked('malformed', 'unavailable');
  }
  if (prior !== undefined) {
    if (!bounded(prior) || !object(prior)) return blocked('malformed', 'unavailable');
    if (!retainedRelease) {
      const reason = await legacyOwnership(prior);
      if (reason) return blocked(reason, reason === 'malformed' ? 'unavailable' : 'conflict');
    }
    if (`${prior.repositoryId}:${prior.pullRequest}:${prior.head}` !== key.slice('renovate:head:'.length)) return blocked('malformed', 'unavailable');
  }
  if (raw !== undefined && applicationStateRecordValid(raw)) {
    if (raw.legacy?.storageKey !== legacy?.storageKey || raw.legacy?.version !== legacy?.version) return blocked('legacy-version-drift');
    return { ...base, raw, original: { activityId: raw.activityId, installationId: raw.installationId,
      ownerKey: raw.ownerKey, sourceId: raw.sourceId, legacy: object(prior) && prior.activityId === raw.activityId, value: raw.value },
    record: { ...base.record, status: 'owned', reason: 'proof-required', value: raw.value, activityId: raw.activityId } };
  }
  if (!object(prior) || typeof prior.activityId !== 'string' || typeof prior.installationId !== 'string') return blocked('malformed', 'unavailable');
  return { ...base, original: { activityId: prior.activityId, installationId: prior.installationId, ownerKey, sourceId, legacy: true, value: prior },
    record: { ...base.record, status: 'owned', reason: 'proof-required', value: prior, activityId: prior.activityId } };
}

// Progress only, never authority: Registry revalidates the owned anchor and
// package-selected scope on every continuation.
const previewCursor = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('scope'), after: z.string().max(3000).optional() }),
  z.strictObject({ phase: z.literal('records'), after: z.string().max(3000).optional(),
    anchor: z.strictObject({ key: recoveryKey, version: recoveryVersion }) }),
]);
export function parseRecoveryCursor(value?: string): z.infer<typeof previewCursor> {
  try {
    return value === undefined ? { phase: 'scope' } : previewCursor.parse(JSON.parse(z.string().max(RECOVERY_CURSOR_MAX_CHARS).parse(value)));
  } catch { throw new ValidationError('Invalid recovery cursor'); }
}

/** Fixed namespace traversal, bounded pages, explicit cursor; no arbitrary storage prefix. */
export async function recoveryInventoryPage(storage: Pick<DurableObjectStorage, 'list' | 'get'>, sourceId: string,
  after?: string): Promise<{ keys: string[]; nextCursor: string | null }> {
  const modern = await applicationRecoveryPrefix(sourceId);
  let phase = 'm', cursor: string | undefined;
  if (after) {
    try {
      const parsed = z.tuple([z.enum(['m', 'l']), z.string().max(2048)]).parse(JSON.parse(after));
      [phase, cursor] = parsed;
      if (cursor && !(phase === 'm' ? cursor.startsWith(modern) : cursor.startsWith('renovate-admission:'))) throw Error();
    } catch { throw new ValidationError('Invalid recovery cursor'); }
  }
  const prefix = phase === 'm' ? modern : 'renovate-admission:';
  const page = new Map<string, unknown>();
  let pageBytes = 0, exhausted = false;
  for (let index = 0; index < 64; index++) {
    const next = await storage.list<unknown>({ prefix, limit: 1, ...(cursor ? { startAfter: cursor } : {}) });
    if (!next.size) { exhausted = true; break; }
    const [storageKey, value] = [...next][0];
    const size = new TextEncoder().encode(encode(value)).byteLength;
    if (size > 64 * 1024) throw new AppError('UNAVAILABLE', 503, 'Recovery record exceeds limit');
    if (pageBytes + size > 1024 * 1024) break;
    pageBytes += size;
    page.set(storageKey, value);
    cursor = storageKey;
  }
  const keys: string[] = [];
  for (const [storageKey, value] of page) {
    if (phase === 'm') {
      // Audit and request receipts occupy the same namespace but are not state.
      if (storageKey.slice(modern.length).includes(':')) continue;
      if (object(value) && typeof value.key === 'string') keys.push(value.key);
    } else {
      const key = `renovate:head:${storageKey.slice(prefix.length)}`;
      if (legacyRecoveryKey(key)) {
        // An existing overlay is returned only in the modern phase.
        if (await storage.get(`${modern}${await recoveryDigest(key)}`) === undefined) keys.push(key);
      }
    }
  }
  return { keys, nextCursor: !exhausted ? encode([phase, cursor]) : phase === 'm' ? encode(['l', '']) : null };
}

const responseSchema = z.strictObject({ scope: z.strictObject({ prefix: recoveryKey, anchorKey: recoveryKey }).optional(),
  items: z.array(z.strictObject({ key: recoveryKey, label: z.string().min(1).max(256),
    disposition: z.enum(['reset', 'skip']), reason: z.string().min(1).max(256), value: z.json().optional() })).max(64) });
export async function callApplicationRecovery(env: Env, connection: { installationId: string; releaseId: string;
  connectionRevision: number; workerVersionId: string; connectionSecretCiphertext: string; controlOrigin: string },
  operation: 'scope' | 'reset', configuration: unknown, records: RecoveryRecord[], requestId: string,
  reauthorize: () => Promise<void>) {
  if (records.length > 64 || new TextEncoder().encode(encode(records)).byteLength > 1024 * 1024) throw Error('Recovery batch exceeded');
  await reauthorize();
  const secret = await openOperatorSecret(connection.connectionSecretCiphertext, env,
    { purpose: 'connection', recordId: connection.installationId });
  const signal = AbortSignal.timeout(15_000);
  const response = await fetch(`${connection.controlOrigin}/control/recovery`, { method: 'POST', redirect: 'manual', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: encode({ installationId: connection.installationId, releaseId: connection.releaseId,
      connectionRevision: connection.connectionRevision, workerVersionId: connection.workerVersionId,
      operation, configuration, records, requestId, now: Date.now() }) });
  const bytes = await readBoundedResponse(response, 1024 * 1024, 'Application recovery', signal);
  if (!response.ok) throw Error('Application recovery unavailable');
  const result = responseSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const allowed = new Set(records.map(record => record.key));
  if (new Set(result.items.map(item => item.key)).size !== result.items.length
    || result.items.some(item => !allowed.has(item.key))) throw Error('Unbound application recovery result');
  await reauthorize();
  return result;
}
