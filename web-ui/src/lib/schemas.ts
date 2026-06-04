import { z } from 'zod';

// Agent type enum
export const AgentTypeSchema = z.enum(['claude-code', 'codex', 'copilot', 'antigravity', 'opencode', 'pi', 'bash']);

// Canonical TabConfigSchema definition (single source of truth, CF-018).
// The worker copy (src/lib/schemas.ts) re-exports this exact object so both
// build targets share one definition. This module stays pure Zod (no DOM/Solid
// deps) precisely so the Workers runtime and test pool can import it. The
// cross-tier parity guard (src/__tests__/contract/schemas.test.ts) verifies the
// re-export resolves to an identical schema (CF-010).
export const TabConfigSchema = z.object({
  id: z.string().regex(/^[1-6]$/, 'Tab id must be "1" through "6"'),
  command: z.string().max(200),
  label: z.string().max(50),
});

// Tab preset schema
const TabPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  tabs: z.array(TabConfigSchema),
  createdAt: z.string(),
});

// Session mode enum
export const SessionModeSchema = z.enum(['default', 'advanced']);

export const AccessTierSchema = z.enum(['pending', 'standard', 'advanced', 'blocked']);
export const SubscriptionTierSchema = z.enum([
  'blocked', 'pending', 'free', 'trial', 'standard', 'advanced', 'max', 'unlimited',
]);

export const AuthStatusResponseSchema = z.object({
  email: z.string(),
  accessTier: AccessTierSchema,
  subscriptionTier: SubscriptionTierSchema.optional(),
  role: z.enum(['admin', 'user']),
  turnstileSiteKey: z.string().nullable().optional(),
  requestedAt: z.string().nullable().optional(),
  onboardingComplete: z.boolean().optional(),
  hasSubscribed: z.boolean().optional(),
  trialUsed: z.boolean().optional(),
  sessionMode: z.enum(['default', 'advanced']).optional(),
  subscribedMode: z.enum(['default', 'advanced']).optional(),
  currency: z.string().optional(),
  billingStatus: z.string().nullable().optional(),
  userCapacityReached: z.boolean().optional(),
  enterpriseMode: z.boolean().optional(),
});

export const AuthProvidersResponseSchema = z.object({
  providers: z.array(z.object({
    id: z.string(),
    type: z.string(),
    name: z.string(),
    loginUrl: z.string().optional(),
  })),
});

// User preferences schema
export const UserPreferencesSchema = z.object({
  lastAgentType: AgentTypeSchema.optional(),
  lastPresetId: z.string().optional(),
  workspaceSyncEnabled: z.boolean().optional(),
  fastStartEnabled: z.boolean().optional(),
  sessionMode: SessionModeSchema.optional(),
  sleepAfter: z.enum(['5m', '15m', '30m', '1h', '2h']).optional(),
});

// Preset API response schemas
export const PresetsResponseSchema = z.object({
  presets: z.array(TabPresetSchema),
});

export const CreatePresetResponseSchema = z.object({
  preset: TabPresetSchema,
});

export const DeletePresetResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.boolean(),
  id: z.string(),
});

// Shared base schema for session objects (used by response schemas below)
export const SessionSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  lastAccessedAt: z.string(),
  status: z.enum(['stopped', 'running']).optional(),
  agentType: AgentTypeSchema.optional(),
  tabConfig: z.array(TabConfigSchema).optional(),
});

// Response schemas for API endpoints - these are the strict, runtime-validated schemas.
// Previously duplicated in client.ts (strict) and here (loose). Now consolidated as the single source of truth.

export const UserResponseSchema = z.object({
  email: z.string(),
  authenticated: z.boolean(),
  bucketName: z.string(),
  workerName: z.string().optional(),
  role: z.enum(['admin', 'user']).optional(),
  accessTier: AccessTierSchema.optional(),
  subscriptionTier: SubscriptionTierSchema.optional(),
  onboardingActive: z.boolean().optional(),
  saasMode: z.boolean().optional(),
  onboardingComplete: z.boolean().optional(),
  hasSubscribed: z.boolean().optional(),
  subscribedMode: z.enum(['default', 'advanced']).optional(),
  enterpriseMode: z.boolean().optional(),
});

export const SessionsResponseSchema = z.object({
  sessions: z.array(SessionSchema),
});

export const CreateSessionResponseSchema = z.object({
  session: SessionSchema,
});

// InitStage enum values from types.ts
export const InitStageSchema = z.enum(['creating', 'starting', 'syncing', 'mounting', 'verifying', 'ready', 'error', 'stopped']);

export const StartupStatusResponseSchema = z.object({
  stage: InitStageSchema,
  progress: z.number(),
  message: z.string(),
  details: z.object({
    bucketName: z.string(),
    container: z.string(),
    path: z.string(),
    email: z.string().optional(),
    containerStatus: z.string().optional(),
    syncStatus: z.enum(['pending', 'syncing', 'success', 'failed', 'skipped']).optional(),
    syncError: z.string().nullable().optional(),
    healthServerOk: z.boolean().optional(),
    terminalServerOk: z.boolean().optional(),
    cpu: z.string().optional(),
    mem: z.string().optional(),
    hdd: z.string().optional(),
  }),
  error: z.string().optional(),
});

// Batch session status response schema
export const BatchSessionStatusResponseSchema = z.object({
  statuses: z.record(z.string(), z.object({
    status: z.enum(['running', 'stopped']),
    ptyActive: z.boolean(),
    startupStage: z.string().optional(),
    lastStartedAt: z.string().nullable().optional(),
    lastActiveAt: z.string().nullable().optional(),
    metrics: z.object({
      cpu: z.string().optional(),
      mem: z.string().optional(),
      hdd: z.string().optional(),
      syncStatus: z.string().optional(),
      updatedAt: z.string().optional(),
    }).optional(),
  })),
  maxSessions: z.number(),
  storageStats: z.object({
    totalFiles: z.number(),
    totalFolders: z.number(),
    totalSizeBytes: z.number(),
  }).optional(),
  usage: z.object({
    dailySeconds: z.number(),
    monthlySeconds: z.number(),
    monthlyQuotaSeconds: z.number().nullable(),
    tier: z.string(),
  }).optional(),
  preseedNeedsUpgrade: z.boolean().optional(),
});

// Setup API schemas - moved from client.ts (strict versions)
export const SetupStatusResponseSchema = z.object({
  configured: z.boolean(),
  tokenDetected: z.boolean().optional(),
  customDomain: z.string().optional(),
  saasMode: z.boolean().optional(),
});

export const DetectTokenResponseSchema = z.object({
  detected: z.boolean(),
  valid: z.boolean().optional(),
  account: z.object({ id: z.string(), name: z.string() }).optional(),
  error: z.string().optional(),
});

export const SetupPrefillResponseSchema = z.object({
  customDomain: z.string().optional(),
  adminUsers: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
});

// User management schemas - moved from client.ts (strict versions)
export const UserEntrySchema = z.object({
  email: z.string(),
  addedBy: z.string(),
  addedAt: z.string(),
  role: z.enum(['admin', 'user']).default('user'),
  accessTier: AccessTierSchema.optional(),
  subscriptionTier: SubscriptionTierSchema.optional(),
  subscribedMode: z.enum(['default', 'advanced']).optional(),
});

export const GetUsersResponseSchema = z.object({
  users: z.array(UserEntrySchema),
  maxUsers: z.number().optional(),
});

// Storage API schemas
const StorageObjectSchema = z.object({
  key: z.string(),
  size: z.number(),
  lastModified: z.string(),
  etag: z.string().optional(),
});

export const StorageListResultSchema = z.object({
  objects: z.array(StorageObjectSchema),
  prefixes: z.array(z.string()),
  isTruncated: z.boolean(),
  nextContinuationToken: z.string().nullable().optional(),
});

export const UploadResponseSchema = z.object({
  key: z.string(),
  size: z.number().optional(),
});

export const DeleteResponseSchema = z.object({
  deleted: z.array(z.string()),
  deletedPrefixes: z.array(z.object({ prefix: z.string(), count: z.number() })).optional(),
  errors: z.array(z.object({ key: z.string(), error: z.string() })),
});


export const MultipartInitResponseSchema = z.object({
  uploadId: z.string(),
  key: z.string(),
});

export const MultipartPartResponseSchema = z.object({
  etag: z.string(),
});

export const MultipartCompleteResponseSchema = z.object({
  key: z.string(),
});

// Storage stats
export const StorageStatsResponseSchema = z.object({
  totalFiles: z.number(),
  totalFolders: z.number(),
  totalSizeBytes: z.number(),
  bucketName: z.string().optional(),
  maxStorageBytes: z.number().nullable().optional(),
});

export const RecreateGettingStartedDocsResponseSchema = z.object({
  success: z.boolean(),
  bucketCreated: z.boolean(),
  written: z.array(z.string()),
  skipped: z.array(z.string()),
});

export const RecreateAgentConfigsResponseSchema = z.object({
  success: z.boolean(),
  bucketCreated: z.boolean(),
  written: z.array(z.string()),
  skipped: z.array(z.string()),
  deleted: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});

// Storage preview (discriminated by type)
export const StoragePreviewTextResponseSchema = z.object({
  type: z.literal('text'),
  content: z.string(),
  size: z.number(),
  lastModified: z.string(),
});

export const StoragePreviewImageResponseSchema = z.object({
  type: z.literal('image'),
  url: z.string(),
  size: z.number(),
  lastModified: z.string(),
});

export const StoragePreviewBinaryResponseSchema = z.object({
  type: z.literal('binary'),
  size: z.number(),
  lastModified: z.string(),
});

// LLM API keys response schema
export const LlmKeysResponseSchema = z.object({
  openaiApiKey: z.string().optional(),
  geminiApiKey: z.string().optional(),
});

// Deploy keys response schema
const CloudflareAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const DeployKeysResponseSchema = z.object({
  githubToken: z.string().optional(),
  cloudflareApiToken: z.string().optional(),
  // null is an explicit clear emitted by the Worker (REQ-AGENT-029 AC2).
  cloudflareAccountId: z.string().nullable().optional(),
  cloudflareAccounts: z.array(CloudflareAccountSchema).optional(),
});

// Onboarding config schema (public endpoint)
export const OnboardingConfigResponseSchema = z.object({
  active: z.boolean(),
  turnstileSiteKey: z.string().nullable(),
});

// Sessions sync fan-out (REQ-STOR-015 AC1).
// Mirrors SyncSessionResult from src/lib/sync-fanout.ts.
export const SessionsSyncResponseSchema = z.object({
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      status: z.union([z.literal('triggered'), z.literal('not-running'), z.literal('failed')]),
      error: z.string().optional(),
    })
  ),
  count: z.number(),
});
