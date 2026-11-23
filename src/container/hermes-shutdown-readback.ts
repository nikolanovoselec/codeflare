import { createHash } from 'node:crypto';
import type { Env } from '../types';
import { readBoundedResponse } from '../lib/bounded-stream';
import { HERMES_MARKDOWN } from '../lib/hermes-retention';
import { createR2Client, getR2Url } from '../lib/r2-client';
import { getR2Config } from '../lib/r2-config';
import { getRegimeState } from '../lib/r2-regime-state';
import { getSseHeaders } from '../lib/r2-sse';
import type { D1Session } from '../lib/session-repository';
import { snapshotPattern } from '../lib/session-shutdown';

const masters = 'Vault/Memory/Masters/';

export function verifiedMergeRevision(value: unknown, row: D1Session, snapshotId: string): string | undefined {
  if (!value || typeof value !== 'object') return;
  const { source, revision } = value as { source?: Record<string, unknown>; revision?: unknown };
  if (typeof revision === 'string' && /^[a-zA-Z0-9_-]{1,180}$/.test(revision) && revision !== 'legacy'
    && source?.owner === row.ownerKey && source.sessionId === row.sessionId
    && source.generation === (row.shutdown?.sourceGeneration ?? row.lifecycleGeneration)
    && source.intent === row.shutdown?.intent && source.snapshotId === snapshotId) return revision;
}

/** Positive readback only. A missing or different pointer cannot establish
 * that an interrupted conditional write will never arrive. This path never writes. */
export async function reconcileHermesPublication(env: Env, row: D1Session, signal: AbortSignal): Promise<string | undefined> {
  const snapshotId = row.shutdown?.snapshotId;
  if (row.shutdown?.phase !== 'uncertain' || (row.lifecycleState !== 'stopped' && !row.shutdown.resumed)
    || !snapshotId || !snapshotPattern.test(snapshotId)) return;
  const { ownerKey } = row;
  const regime = await getRegimeState(env, ownerKey);
  if (regime.status !== 'ready') return;
  const client = createR2Client(env);
  const { endpoint } = await getR2Config(env);
  const headers = getSseHeaders(env, regime.regime === 'plain');
  if (regime.keyMd5 && regime.regime === 'sse-c' && headers['x-amz-server-side-encryption-customer-key-MD5'] !== regime.keyMd5) return;
  const get = (key: string, match?: string) => client.fetch(getR2Url(endpoint, ownerKey, masters + key), {
    signal, redirect: 'error', headers: { ...headers, ...(match ? { 'If-Match': match } : {}) },
  });
  const pointer = await get('current.json');
  const etag = pointer.headers.get('etag');
  if (pointer.status !== 200 || !etag || !/^"[^"\r\n]+"$/.test(etag)) { await pointer.body?.cancel(); return; }
  const commit = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
    await readBoundedResponse(pointer, 4096, 'Hermes pointer', signal),
  )) as { files?: Record<string, unknown> } | null;
  const revision = verifiedMergeRevision(commit, row, snapshotId);
  const files = commit?.files;
  if (!revision || !files || Object.keys(files).length !== HERMES_MARKDOWN.length) return;
  for (const file of HERMES_MARKDOWN) {
    const digest = files[file];
    if (typeof digest !== 'string' || !snapshotPattern.test(digest)) return;
    const response = await get(`${revision}/${file}`);
    if (response.status !== 200) { await response.body?.cancel(); return; }
    const data = await readBoundedResponse(response, 150_000 * 4, 'Hermes revision file', signal);
    if (createHash('sha256').update(data).digest('hex') !== digest) return;
  }
  const current = await get('current.json', etag);
  await current.body?.cancel();
  if (current.status !== 200 || current.headers.get('etag') !== etag) return;
  const after = await getRegimeState(env, ownerKey);
  signal.throwIfAborted();
  if (after.status === 'ready' && after.generation === regime.generation && after.regime === regime.regime) return revision;
}
