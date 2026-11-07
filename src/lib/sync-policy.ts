import { z } from 'zod';
import { SETUP_KEYS } from './kv-keys';

export const syncPolicyModeSchema = z.enum(['exclude', 'include']);
export type SyncPolicyMode = z.infer<typeof syncPolicyModeSchema>;

/** Only an absent legacy setting selects the default; malformed policy fails closed. */
export function parseStoredSyncPolicyMode(value: unknown): SyncPolicyMode {
  if (value === undefined || value === null) return 'exclude';
  const parsed = syncPolicyModeSchema.safeParse(value);
  if (!parsed.success) throw new Error('Invalid stored sync policy mode');
  return parsed.data;
}

export async function readSyncPolicyMode(kv: KVNamespace): Promise<SyncPolicyMode> {
  return parseStoredSyncPolicyMode(await kv.get(SETUP_KEYS.SYNC_POLICY_MODE));
}
