/**
 * CF-006: Shared Zod schema for the /_internal/setBucketName JSON payload.
 * Used by buildSetBucketNameBody to validate before sending to the container.
 *
 * Uses .passthrough() on nested objects so extra fields survive validation.
 * Tab config is loosely validated — the frontend schema in web-ui/src/lib/schemas.ts
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
  cloudflareAccountId: z.string().optional(),
  encryptionKey: z.string().optional(),
  sessionMode: z.string(),
  sleepAfter: z.string(),
}).passthrough();
