import { z } from 'zod';

// Agent type enum
export const AgentTypeSchema = z.enum(['claude-unleashed', 'claude-code', 'codex', 'gemini', 'bash']);

// Tab config schema (mirrors backend src/lib/schemas.ts constraints)
const TabConfigSchema = z.object({
  id: z.string().regex(/^[1-6]$/),
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

// User preferences schema
export const UserPreferencesSchema = z.object({
  lastAgentType: AgentTypeSchema.optional(),
  lastPresetId: z.string().optional(),
  workspaceSyncEnabled: z.boolean().optional(),
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
  status: z.enum(['stopped', 'running', 'stopping']).optional(),
  agentType: AgentTypeSchema.optional(),
  tabConfig: z.array(TabConfigSchema).optional(),
});

// Response schemas for API endpoints — these are the strict, runtime-validated schemas.
// Previously duplicated in client.ts (strict) and here (loose). Now consolidated as the single source of truth.

export const UserResponseSchema = z.object({
  email: z.string(),
  authenticated: z.boolean(),
  bucketName: z.string(),
  workerName: z.string().optional(),
  role: z.enum(['admin', 'user']).optional(),
  onboardingActive: z.boolean().optional(),
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
    status: z.enum(['running', 'stopped', 'stopping']),
    ptyActive: z.boolean(),
    startupStage: z.string().optional(),
  })),
});

// Setup API schemas — moved from client.ts (strict versions)
export const SetupStatusResponseSchema = z.object({
  configured: z.boolean(),
  tokenDetected: z.boolean().optional(),
  customDomain: z.string().optional(),
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

export const ConfigureResponseSchema = z.object({
  success: z.boolean(),
  steps: z.array(z.object({ step: z.string(), status: z.string(), error: z.string().optional() })).optional(),
  error: z.string().optional(),
  customDomainUrl: z.string().optional(),
  accountId: z.string().optional(),
});

// User management schemas — moved from client.ts (strict versions)
export const UserEntrySchema = z.object({
  email: z.string(),
  addedBy: z.string(),
  addedAt: z.string(),
  role: z.enum(['admin', 'user']).default('user'),
});

export const GetUsersResponseSchema = z.object({
  users: z.array(UserEntrySchema),
});

export const UserMutationResponseSchema = z.object({
  success: z.boolean(),
  email: z.string(),
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
  errors: z.array(z.object({ key: z.string(), error: z.string() })),
});

export const MoveResponseSchema = z.object({
  source: z.string(),
  destination: z.string(),
  warning: z.string().optional(),
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
});

export const RecreateGettingStartedDocsResponseSchema = z.object({
  success: z.boolean(),
  bucketCreated: z.boolean(),
  written: z.array(z.string()),
  skipped: z.array(z.string()),
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

// Onboarding config schema (public endpoint)
export const OnboardingConfigResponseSchema = z.object({
  active: z.boolean(),
  turnstileSiteKey: z.string().nullable(),
});
