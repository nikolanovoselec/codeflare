/**
 * CF-006: Shared Zod schema for the /_internal/setBucketName JSON payload.
 * Used by buildSetBucketNameBody to validate before sending to the container.
 *
 * Uses .passthrough() on nested objects so extra fields survive validation.
 * Tab config is loosely validated - the frontend schema in web-ui/src/lib/schemas.ts
 * enforces the strict shape; this schema only guards the transport layer.
 */
import { z } from 'zod';
import { ManagedResourcePolicySchema } from '../types';

export const SetBucketNameBodySchema = z.object({
  bucketName: z.string(),
  sessionId: z.string(),
  userEmail: z.string(),
  r2AccessKeyId: z.string(),
  r2SecretAccessKey: z.string(),
  r2AccountId: z.string(),
  r2Endpoint: z.string(),
  tabConfig: z.array(z.object({}).passthrough()),
  terminalMode: z.enum(['classic', 'herdr']),
  workspaceSyncEnabled: z.boolean(),
  fastStartEnabled: z.boolean(),
  openaiApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
  // null on any of the three deploy creds is an explicit clear that must
  // propagate to the container so a revoked credential is unset rather than
  // left stale (REQ-AGENT-029 AC2).
  githubToken: z.string().nullable().optional(),
  cloudflareApiToken: z.string().nullable().optional(),
  cloudflareAccountId: z.string().nullable().optional(),
  encryptionKey: z.string().optional(),
  /** REQ-ENTERPRISE-018: Governed Mode — bucket's R2 SSE-C-disabled regime forwarded to the container. */
  r2SseDisabled: z.boolean().optional(),
  remoteCurationActive: z.boolean().optional(),
  remoteCurationReleaseDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  remoteCurationManifestDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().optional(),
  managedResourcePolicy: ManagedResourcePolicySchema,
  managedResourcePathsDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  sessionMode: z.string(),
  sessionWorkspace: z.enum(['terminal', 'vscode']),
  sleepAfter: z.string(),
  /** REQ-ENTERPRISE-004: the user's matched Access groups, one cf-aig-metadata tag per group. */
  userGroups: z.array(z.string()).optional(),
  /** REQ-ENTERPRISE-005 (revised): dynamic-route catalog + resolved default route:reasoning for entrypoint.sh. */
  routeCatalog: z.array(z.string()).optional(),
  defaultRoute: z.string().optional(),
  defaultReasoning: z.string().optional(),
  /** REQ-ENTERPRISE-012: per-route context window map (route name -> positive token count). */
  routeContextWindows: z.record(z.string(), z.number().int().positive()).optional(),
  /** REQ-MEM-001 AC4: forward the user's IANA timezone to the container. */
  userTimezone: z.string().optional(),
  /** REQ-GITHUB-004: one-shot GitHub clone directive (repo owner/name + optional ref). */
  gitCloneRepo: z.string().optional(),
  gitCloneRef: z.string().optional(),
}).passthrough().superRefine((value, context) => {
  if (value.remoteCurationActive === true && !value.remoteCurationReleaseDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['remoteCurationReleaseDigest'], message: 'active remote curation requires its applied release digest' });
  }
  if (value.remoteCurationActive === true && !value.remoteCurationManifestDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['remoteCurationManifestDigest'], message: 'active remote curation requires its managed extension manifest digest' });
  }
  if (value.remoteCurationActive !== true && value.remoteCurationReleaseDigest != null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['remoteCurationReleaseDigest'], message: 'inactive remote curation cannot transport a release digest' });
  }
  if (value.remoteCurationActive !== true && value.remoteCurationManifestDigest != null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['remoteCurationManifestDigest'], message: 'inactive remote curation cannot transport a managed extension manifest digest' });
  }
  const protectedResources = value.managedResourcePolicy !== 'mutable';
  if (protectedResources && !value.remoteCurationReleaseDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['remoteCurationReleaseDigest'], message: 'protected managed resources require the applied curation release digest' });
  }
  if (protectedResources && !value.managedResourcePathsDigest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['managedResourcePathsDigest'], message: 'protected managed resources require an applied path digest' });
  }
  if (!protectedResources && value.managedResourcePathsDigest !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['managedResourcePathsDigest'], message: 'mutable managed resources require a null path digest' });
  }
});

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
