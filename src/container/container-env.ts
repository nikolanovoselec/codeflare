/**
 * container-env — Environment variable construction and bucket-name management.
 *
 * Extracted from Container DO (index.ts) to reduce file size.
 * All functions receive explicit state/context parameters instead of `this`.
 */
import type { Env, TabConfig } from '../types';
import { TERMINAL_SERVER_PORT } from '../lib/constants';
import { getR2Config } from '../lib/r2-config';
import { toErrorMessage } from '../lib/error-types';
import { createLogger } from '../lib/logger';

const logger = createLogger('container-env');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Mutable state fields that updateEnvVars / setBucketName need to read/write. */
export interface ContainerEnvState {
  _bucketName: string | null;
  _r2AccountId: string | null;
  _r2Endpoint: string | null;
  _r2AccessKeyId: string | null;
  _r2SecretAccessKey: string | null;
  _workspaceSyncEnabled: boolean;
  _fastStartEnabled: boolean;
  _tabConfig: TabConfig[] | null;
  _openaiApiKey: string | null;
  _geminiApiKey: string | null;
  _githubToken: string | null;
  _cloudflareApiToken: string | null;
  _cloudflareAccountId: string | null;
  _encryptionKey: string | null;
  _sessionMode: string;
  _containerAuthToken: string | null;
  _sessionId: string | null;
  _userEmail: string | null;
}

/** Fields sent in the setBucketName body that may need updating on restart. */
interface RestartPrefsInput {
  sessionId?: string;
  userEmail?: string;
  workspaceSyncEnabled?: boolean;
  fastStartEnabled?: boolean;
  tabConfig?: TabConfig[];
  openaiApiKey?: string;
  geminiApiKey?: string;
  githubToken?: string;
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
  encryptionKey?: string;
  sessionMode?: string;
}

export interface SetBucketNameCreds {
  r2AccessKeyId?: string;
  r2SecretAccessKey?: string;
  r2AccountId?: string;
  r2Endpoint?: string;
  workspaceSyncEnabled?: boolean;
  fastStartEnabled?: boolean;
  tabConfig?: TabConfig[];
  openaiApiKey?: string;
  geminiApiKey?: string;
  githubToken?: string;
  cloudflareApiToken?: string;
  cloudflareAccountId?: string;
  encryptionKey?: string;
  sessionMode?: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate setBucketName input fields.
 * Returns an error message string if validation fails, or null if valid.
 */
export function validateBucketNameInput(input: {
  bucketName: unknown;
  r2AccessKeyId?: unknown;
  r2SecretAccessKey?: unknown;
  r2AccountId?: unknown;
  r2Endpoint?: unknown;
  workspaceSyncEnabled?: unknown;
  fastStartEnabled?: unknown;
  sessionMode?: unknown;
}): string | null {
  const { bucketName, r2AccessKeyId, r2SecretAccessKey, r2AccountId, r2Endpoint, workspaceSyncEnabled, fastStartEnabled, sessionMode } = input;

  if (typeof bucketName !== 'string' || bucketName.trim() === '') {
    return 'bucketName must be a non-empty string';
  }
  if (r2AccessKeyId !== undefined && (typeof r2AccessKeyId !== 'string' || r2AccessKeyId.trim() === '')) {
    return 'r2AccessKeyId must be a non-empty string when provided';
  }
  if (r2SecretAccessKey !== undefined && (typeof r2SecretAccessKey !== 'string' || r2SecretAccessKey.trim() === '')) {
    return 'r2SecretAccessKey must be a non-empty string when provided';
  }
  if (workspaceSyncEnabled !== undefined && typeof workspaceSyncEnabled !== 'boolean') {
    return 'workspaceSyncEnabled must be a boolean when provided';
  }
  if (fastStartEnabled !== undefined && typeof fastStartEnabled !== 'boolean') {
    return 'fastStartEnabled must be a boolean when provided';
  }
  if (sessionMode !== undefined && typeof sessionMode !== 'string') {
    return 'sessionMode must be a string when provided';
  }
  if (r2AccountId !== undefined && (typeof r2AccountId !== 'string' || r2AccountId.trim() === '')) {
    return 'r2AccountId must be a non-empty string when provided';
  }
  if (r2Endpoint !== undefined) {
    if (typeof r2Endpoint !== 'string' || r2Endpoint.trim() === '') {
      return 'r2Endpoint must be a non-empty string when provided';
    }
    try {
      new URL(r2Endpoint);
    } catch {
      return 'r2Endpoint must be a valid URL';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Env-var construction
// ---------------------------------------------------------------------------

/**
 * Build the envVars record from the current container state.
 * Returns a new object (never mutates the input state).
 */
export function buildEnvVars(
  state: Readonly<ContainerEnvState>,
  env: Env,
): Record<string, string> {
  const bucketName = state._bucketName || 'unknown-bucket';
  const accessKeyId = state._r2AccessKeyId || env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = state._r2SecretAccessKey || env.R2_SECRET_ACCESS_KEY || '';
  const accountId = state._r2AccountId || env.R2_ACCOUNT_ID || '';
  const endpoint = state._r2Endpoint || env.R2_ENDPOINT || '';

  logger.info('R2 credentials configured', {
    bucketName,
    hasAccessKey: !!accessKeyId,
    hasSecretKey: !!secretAccessKey,
    hasAccountId: !!accountId,
    hasEndpoint: !!endpoint,
    workspaceSyncEnabled: state._workspaceSyncEnabled,
  });

  return {
    // R2 credentials - AWS naming convention for rclone S3 provider compatibility
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
    // R2 configuration
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
    R2_ACCOUNT_ID: accountId,
    R2_BUCKET_NAME: bucketName,
    R2_ENDPOINT: endpoint,
    WORKSPACE_SYNC_ENABLED: state._workspaceSyncEnabled ? 'true' : 'false',
    FAST_CLI_START: state._fastStartEnabled ? 'true' : 'false',
    SYNC_MODE: state._workspaceSyncEnabled ? 'full' : 'none',
    // Terminal server port
    TERMINAL_PORT: String(TERMINAL_SERVER_PORT),
    // Auth token for container HTTP requests
    CONTAINER_AUTH_TOKEN: state._containerAuthToken ?? '',
    SESSION_ID: state._sessionId || '',
    // Tab configuration (JSON string for the terminal server to parse)
    ...(state._tabConfig && { TAB_CONFIG: JSON.stringify(state._tabConfig) }),
    // LLM API keys (injected for consult-llm-mcp MCP server)
    ...(state._openaiApiKey && { OPENAI_API_KEY: state._openaiApiKey }),
    ...(state._geminiApiKey && { GEMINI_API_KEY: state._geminiApiKey }),
    // Encryption key for rclone SSE-C
    ...(state._encryptionKey && { ENCRYPTION_KEY: state._encryptionKey }),
    // Deploy credentials (GitHub + Cloudflare for push & deploy)
    ...(state._githubToken && { GH_TOKEN: state._githubToken }),
    ...(state._cloudflareApiToken && { CLOUDFLARE_API_TOKEN: state._cloudflareApiToken }),
    ...(state._cloudflareAccountId && { CLOUDFLARE_ACCOUNT_ID: state._cloudflareAccountId }),
    // Session mode (controls memory persistence in entrypoint.sh)
    SESSION_MODE: state._sessionMode,
  };
}

// ---------------------------------------------------------------------------
// setBucketName logic
// ---------------------------------------------------------------------------

/**
 * Persist the bucket name and apply credentials to the mutable state.
 * Returns updated copies of changed state fields (caller must assign them).
 */
export async function applyBucketName(
  state: ContainerEnvState,
  name: string,
  env: Env,
  storage: { put: (key: string, value: unknown) => Promise<void> },
  r2Creds?: SetBucketNameCreds,
): Promise<void> {
  state._bucketName = name;
  await storage.put('bucketName', name);
  if (typeof r2Creds?.workspaceSyncEnabled === 'boolean') {
    state._workspaceSyncEnabled = r2Creds.workspaceSyncEnabled;
    await storage.put('workspaceSyncEnabled', r2Creds.workspaceSyncEnabled);
  }
  if (typeof r2Creds?.fastStartEnabled === 'boolean') {
    state._fastStartEnabled = r2Creds.fastStartEnabled;
    await storage.put('fastStartEnabled', r2Creds.fastStartEnabled);
  }

  // Store tab config if provided
  if (r2Creds?.tabConfig) {
    state._tabConfig = r2Creds.tabConfig;
    await storage.put('tabConfig', r2Creds.tabConfig);
  }

  // Store LLM API keys in instance memory only (not persisted to DO storage; injected per container start)
  if (r2Creds?.openaiApiKey) state._openaiApiKey = r2Creds.openaiApiKey;
  if (r2Creds?.geminiApiKey) state._geminiApiKey = r2Creds.geminiApiKey;

  // Store deploy credentials in instance memory only (not persisted to DO storage; injected per container start)
  if (r2Creds?.githubToken) state._githubToken = r2Creds.githubToken;
  if (r2Creds?.cloudflareApiToken) state._cloudflareApiToken = r2Creds.cloudflareApiToken;
  if (r2Creds?.cloudflareAccountId) state._cloudflareAccountId = r2Creds.cloudflareAccountId;

  // Store encryption key in instance memory
  if (r2Creds?.encryptionKey) state._encryptionKey = r2Creds.encryptionKey;

  // Store session mode in instance memory only (not persisted to DO storage; re-sent on each container start)
  if (r2Creds?.sessionMode) state._sessionMode = r2Creds.sessionMode;

  // Use Worker-provided R2 credentials (most reliable — Worker definitely has secrets)
  if (r2Creds?.r2AccessKeyId) state._r2AccessKeyId = r2Creds.r2AccessKeyId;
  if (r2Creds?.r2SecretAccessKey) state._r2SecretAccessKey = r2Creds.r2SecretAccessKey;
  if (r2Creds?.r2AccountId) state._r2AccountId = r2Creds.r2AccountId;
  if (r2Creds?.r2Endpoint) state._r2Endpoint = r2Creds.r2Endpoint;

  // Fall back to getR2Config only if Worker didn't provide account ID
  if (!state._r2AccountId) {
    try {
      const r2Config = await getR2Config(env);
      state._r2AccountId = r2Config.accountId;
      state._r2Endpoint = r2Config.endpoint;
    } catch (err) {
      logger.warn('R2 config not available in setBucketName', {
        error: toErrorMessage(err),
      });
    }
  }

  logger.info('Stored bucket name', { bucketName: name });
}

// ---------------------------------------------------------------------------
// Preference update on restart (idempotent path)
// ---------------------------------------------------------------------------

/**
 * Update user preferences on a restart when the bucket name is already set.
 * Mutates `state` in place. Returns true if any preference changed (caller
 * should regenerate envVars).
 */
export async function applyPrefsOnRestart(
  state: ContainerEnvState,
  storage: { put: (key: string, value: unknown) => Promise<void> },
  input: RestartPrefsInput,
): Promise<boolean> {
  let changed = false;

  if (input.sessionId) {
    await storage.put('_sessionId', input.sessionId);
    state._sessionId = input.sessionId;
    changed = true;
  }

  if (typeof input.workspaceSyncEnabled === 'boolean' && input.workspaceSyncEnabled !== state._workspaceSyncEnabled) {
    state._workspaceSyncEnabled = input.workspaceSyncEnabled;
    await storage.put('workspaceSyncEnabled', input.workspaceSyncEnabled);
    changed = true;
    logger.info('Updated workspaceSyncEnabled on restart', { workspaceSyncEnabled: input.workspaceSyncEnabled });
  }

  if (typeof input.fastStartEnabled === 'boolean' && input.fastStartEnabled !== state._fastStartEnabled) {
    state._fastStartEnabled = input.fastStartEnabled;
    await storage.put('fastStartEnabled', input.fastStartEnabled);
    changed = true;
    logger.info('Updated fastStartEnabled on restart', { fastStartEnabled: input.fastStartEnabled });
  }

  if (input.tabConfig) {
    state._tabConfig = input.tabConfig;
    await storage.put('tabConfig', input.tabConfig);
    changed = true;
  }

  // Always update LLM keys, deploy keys, and session mode on restart (read fresh each start)
  if (input.openaiApiKey !== undefined) {
    state._openaiApiKey = input.openaiApiKey || null;
    changed = true;
  }
  if (input.geminiApiKey !== undefined) {
    state._geminiApiKey = input.geminiApiKey || null;
    changed = true;
  }
  if (input.githubToken !== undefined) {
    state._githubToken = input.githubToken || null;
    changed = true;
  }
  if (input.cloudflareApiToken !== undefined) {
    state._cloudflareApiToken = input.cloudflareApiToken || null;
    changed = true;
  }
  if (input.cloudflareAccountId !== undefined) {
    state._cloudflareAccountId = input.cloudflareAccountId || null;
    changed = true;
  }
  if (input.encryptionKey !== undefined) {
    state._encryptionKey = input.encryptionKey || null;
    changed = true;
  }
  if (input.sessionMode) {
    state._sessionMode = input.sessionMode;
    changed = true;
  }

  // Update userEmail on restart (critical for Timekeeper pings)
  if (input.userEmail && input.userEmail !== state._userEmail) {
    state._userEmail = input.userEmail;
    await storage.put('userEmail', input.userEmail);
    logger.info('Updated userEmail on restart', { userEmail: input.userEmail });
  }

  return changed;
}
