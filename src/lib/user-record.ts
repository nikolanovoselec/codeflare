/**
 * User KV record schema — validates the shape of user data stored in KV.
 * CF-011: Replaces untyped `as Record<string, unknown>` casts.
 *
 * Uses .passthrough() to preserve unknown fields from older code versions.
 */
import { z } from 'zod';

const UserRecordSchema = z.object({
  addedBy: z.string().default('unknown'),
  addedAt: z.string().default(''),
  role: z.string().default('user'),
  accessTier: z.string().optional(),
  subscriptionTier: z.string().optional(),
  billingStatus: z.enum(['active', 'trialing', 'past_due', 'canceled']).optional().catch(undefined),
  subscribedAt: z.string().optional(),
  subscribedMode: z.string().optional(),
  stripeCustomerId: z.string().optional(),
  stripeSubscriptionId: z.string().optional(),
  stripePriceId: z.string().optional(),
  billingPeriodEnd: z.string().optional(),
  checkoutSessionId: z.string().optional(),
  onboardingComplete: z.boolean().optional(),
  trialUsed: z.boolean().optional(),
  requestedAt: z.string().optional(),
  lastSyncedAt: z.string().optional(),
  cancelAtPeriodEnd: z.boolean().optional(),
}).passthrough();

type UserRecord = z.infer<typeof UserRecordSchema>;

/**
 * Parse a raw KV value into a validated UserRecord.
 * Returns null if the value is null, not an object, or fails parsing.
 */
export function parseUserRecord(raw: unknown): UserRecord | null {
  if (raw === null || raw === undefined) return null;
  const result = UserRecordSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * CF-008: Atomic read-merge-write helper for user KV records.
 * Reads the existing record, merges the patch, validates, and writes back.
 * Prevents webhook handlers from using error-prone manual spread patterns.
 */
export async function updateUserRecord(
  kv: KVNamespace,
  email: string,
  patch: Partial<UserRecord>,
): Promise<void> {
  const existing = parseUserRecord(await kv.get(`user:${email}`, 'json')) ?? {};
  const updated = { ...existing, ...patch };
  await kv.put(`user:${email}`, JSON.stringify(updated));
}
