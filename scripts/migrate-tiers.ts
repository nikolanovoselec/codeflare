/**
 * Migration script: accessTier → subscriptionTier
 *
 * Reads all user:* KV keys, adds subscriptionTier field based on:
 * - pending → pending
 * - blocked → blocked
 * - standard → standard
 * - advanced → advanced
 * - role: admin (any tier) → unlimited
 * - missing/undefined in SaaS mode → standard
 * - missing/undefined in non-SaaS mode → unlimited
 *
 * KEEPS accessTier for rollback safety. Idempotent — skips users
 * that already have subscriptionTier.
 *
 * Usage:
 *   npx wrangler d1 execute ... (not applicable — this is for KV)
 *   Run via wrangler: npx -y wrangler kv ... or integrate into a Worker script.
 *
 * This file documents the migration logic. Execute via a temporary Worker
 * or wrangler script that calls migrateUsers() with the KV binding.
 */

interface UserRecord {
  addedBy?: string;
  addedAt?: string;
  role?: string;
  accessTier?: string;
  subscriptionTier?: string;
  [key: string]: unknown;
}

type TierMapping = (user: UserRecord, isSaasMode: boolean) => string;

const mapTier: TierMapping = (user, isSaasMode) => {
  // Admins always get unlimited
  if (user.role === 'admin') return 'unlimited';

  // If accessTier is set, map directly (all 4 old values exist in the new schema)
  if (user.accessTier === 'pending') return 'pending';
  if (user.accessTier === 'blocked') return 'blocked';
  if (user.accessTier === 'standard') return 'standard';
  if (user.accessTier === 'advanced') return 'advanced';

  // Missing/undefined tier
  return isSaasMode ? 'standard' : 'unlimited';
};

export async function migrateUsers(
  kv: KVNamespace,
  isSaasMode: boolean
): Promise<{ migrated: number; skipped: number; total: number }> {
  let migrated = 0;
  let skipped = 0;
  let total = 0;
  let cursor: string | undefined;

  do {
    const result = await kv.list({ prefix: 'user:', cursor });

    for (const key of result.keys) {
      total++;
      const raw = await kv.get(key.name);
      if (!raw) continue;

      let user: UserRecord;
      try {
        user = JSON.parse(raw);
      } catch {
        continue;
      }

      // Idempotent: skip if already migrated
      if (user.subscriptionTier) {
        skipped++;
        continue;
      }

      const newTier = mapTier(user, isSaasMode);
      const updated = { ...user, subscriptionTier: newTier };
      await kv.put(key.name, JSON.stringify(updated));
      migrated++;
    }

    cursor = result.list_complete ? undefined : result.cursor;
  } while (cursor);

  return { migrated, skipped, total };
}

export { mapTier };
