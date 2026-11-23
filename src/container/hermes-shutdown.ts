export const HERMES_MERGE_BUDGET_MS = 20 * 60_000;

/** The queue head is fenced from terminal use before this runs. Native model
 * access still belongs to the current, live container until teardown starts. */
export async function mergeAfterFinalSave<T>(input: {
  signal: AbortSignal;
  finalSyncBudgetMs: number;
  assertCurrent(): Promise<void>;
  forwardExisting(request: Request): Promise<Response>;
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
  const receipt: { synced?: boolean; snapshotId?: unknown } | null = await response.json().catch(() => null);
  if (!response.ok || receipt?.synced !== true) throw new Error('Final save not confirmed');
  saveSignal.throwIfAborted();
  const deadline = Date.now() + HERMES_MERGE_BUDGET_MS;
  const mergeSignal = AbortSignal.any([signal, AbortSignal.timeout(HERMES_MERGE_BUDGET_MS)]);
  await input.assertCurrent();
  mergeSignal.throwIfAborted();
  const snapshotId = typeof receipt.snapshotId === 'string' && /^[0-9a-f]{64}$/.test(receipt.snapshotId)
    ? receipt.snapshotId : undefined;
  return input.merge({ deadline, signal: mergeSignal, snapshotId });
}
