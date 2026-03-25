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
  role: z.enum(['admin', 'user']).default('user'),
  accessTier: z.string().optional(),
  subscriptionTier: z.string().optional(),
  billingStatus: z.string().optional(),
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
