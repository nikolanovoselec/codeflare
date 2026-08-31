import { z } from 'zod';
import { getManagedReconcileProgressKey } from './kv-keys';

const PROGRESS_TTL_SECONDS = 24 * 60 * 60;

const ManagedReconcileProgressSchema = z.object({
  schemaVersion: z.literal(1),
  targetDigest: z.string().regex(/^[0-9a-f]{64}$/),
  phase: z.enum(['planning', 'writing', 'finalizing']),
  completed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
}).strict().refine((value) => value.completed <= value.total, {
  message: 'Managed reconciliation progress exceeds total',
});

export type ManagedReconcileProgress = z.infer<typeof ManagedReconcileProgressSchema>;

export async function readManagedReconcileProgress(
  kv: KVNamespace,
  bucketName: string,
): Promise<ManagedReconcileProgress | undefined> {
  const value = await kv.get(getManagedReconcileProgressKey(bucketName), 'json');
  const parsed = ManagedReconcileProgressSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export async function writeManagedReconcileProgress(
  kv: KVNamespace,
  bucketName: string,
  progress: Omit<ManagedReconcileProgress, 'schemaVersion' | 'updatedAt'>,
): Promise<void> {
  const value = ManagedReconcileProgressSchema.parse({
    schemaVersion: 1,
    ...progress,
    updatedAt: new Date().toISOString(),
  });
  await kv.put(getManagedReconcileProgressKey(bucketName), JSON.stringify(value), {
    expirationTtl: PROGRESS_TTL_SECONDS,
  });
}

export async function clearMatchingManagedReconcileProgress(
  kv: KVNamespace,
  bucketName: string,
  targetDigest: string,
): Promise<void> {
  const progress = await readManagedReconcileProgress(kv, bucketName);
  if (progress?.targetDigest === targetDigest) {
    await kv.delete(getManagedReconcileProgressKey(bucketName));
  }
}
