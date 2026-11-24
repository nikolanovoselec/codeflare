import type { D1Session } from '../lib/session-repository';

export const HERMES_MERGE_BUDGET_MS = 20 * 60_000;

/** The queue head is fenced from terminal use before this runs. Native model
 * access still belongs to the current, live container until teardown starts. */
export async function mergeAfterFinalSave<T>(input: {
  signal: AbortSignal;
  finalSyncBudgetMs: number;
  assertCurrent(): Promise<void>;
  forwardExisting(request: Request): Promise<Response>;
  startupDisabled?(generation: unknown): Promise<T>;
  merge(attempt: { deadline: number; signal: AbortSignal; snapshotId?: string }): Promise<T>;
}): Promise<T> {
  const { signal } = input;
  signal.throwIfAborted();
  await input.assertCurrent();
  signal.throwIfAborted();
  const saveSignal = AbortSignal.any([signal, AbortSignal.timeout(input.finalSyncBudgetMs)]);
  const response = await input.forwardExisting(new Request('http://localhost/internal/final-sync', {
    method: 'POST', headers: { 'x-codeflare-hermes-merge': '1' }, signal: saveSignal,
  }));
  const receipt = await response.json().catch(() => null) as {
    synced?: unknown; snapshotId?: unknown; reason?: unknown; generation?: unknown;
  } | null;
  saveSignal.throwIfAborted();
  if (input.startupDisabled && response.status === 409
      && receipt?.synced === false && receipt.reason === 'hermes-disabled-at-startup') {
    return input.startupDisabled(receipt.generation);
  }
  if (!response.ok || receipt?.synced !== true) throw new Error('Final save not confirmed');
  const deadline = Date.now() + HERMES_MERGE_BUDGET_MS;
  const mergeSignal = AbortSignal.any([signal, AbortSignal.timeout(HERMES_MERGE_BUDGET_MS)]);
  await input.assertCurrent();
  mergeSignal.throwIfAborted();
  const snapshotId = typeof receipt.snapshotId === 'string' && /^[0-9a-f]{64}$/.test(receipt.snapshotId)
    ? receipt.snapshotId : undefined;
  return input.merge({ deadline, signal: mergeSignal, snapshotId });
}

export function verifiedHermesMerge(value: unknown, row: D1Session, snapshotId: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const { source } = value as { source?: Record<string, unknown> };
  return source?.owner === row.ownerKey && source.sessionId === row.sessionId
    && source.generation === (row.shutdown?.sourceGeneration ?? row.lifecycleGeneration)
    && source.intent === row.shutdown?.intent && source.snapshotId === snapshotId;
}
