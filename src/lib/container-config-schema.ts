/**
 * CF-006: Shared Zod schema for the /_internal/setBucketName JSON payload.
 * Used by buildSetBucketNameBody to validate before sending to the container.
 *
 * Uses .passthrough() on nested objects so extra fields survive validation.
 * Tab config is loosely validated - the frontend schema in web-ui/src/lib/schemas.ts
 * enforces the strict shape; this schema only guards the transport layer.
 */
import { z } from 'zod';

export const SetBucketNameBodySchema = z.object({
  bucketName: z.string(),
  sessionId: z.string(),
  userEmail: z.string(),
  r2AccessKeyId: z.string(),
  r2SecretAccessKey: z.string(),
  r2AccountId: z.string(),
  r2Endpoint: z.string(),
  tabConfig: z.array(z.object({}).passthrough()),
  workspaceSyncEnabled: z.boolean(),
  fastStartEnabled: z.boolean(),
  openaiApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  githubToken: z.string().optional(),
  cloudflareApiToken: z.string().optional(),
  // null is an explicit clear that must propagate to the container so a
  // revoked account ID is unset rather than left stale (REQ-AGENT-029 AC2).
  cloudflareAccountId: z.string().nullable().optional(),
  encryptionKey: z.string().optional(),
  sessionMode: z.string(),
  sleepAfter: z.string(),
  /** REQ-MEM-001 AC4: forward the user's IANA timezone to the container. */
  userTimezone: z.string().optional(),
}).passthrough();

/**
 * TD5: Zod schema for the /_internal/setSessionId JSON payload.
 *
 * Unlike SetBucketNameBodySchema (validated by the Worker-side builder before
 * sending), setSessionId has no Worker-side sender - sessionId is normally
 * persisted via setBucketName. The only untrusted entry is the inbound DO
 * request, so this is validated receiver-side in handleSetSessionId.
 *
 * sessionId stays optional: an absent value is a successful no-op, matching the
 * pre-existing idempotent contract. A non-string value is now rejected (400)
 * instead of silently coerced.
 */
export const SetSessionIdBodySchema = z.object({
  sessionId: z.string().optional(),
});
