/** Assign each individual declaration/table row to exactly one isolated process. */
export function createFlueCaseShard(index: number, total: number): () => boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total)
    || total < 1 || index < 0 || index >= total) {
    throw new Error('Invalid Flue case shard');
  }
  let ordinal = 0;
  return () => ordinal++ % total === index;
}
