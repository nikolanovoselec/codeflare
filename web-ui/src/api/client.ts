import type { Session, UserInfo, InitProgress, StartupStatusResponse, AgentType, TabConfig, TabPreset, UserPreferences, AuthStatus, AuthProvider } from '../types';
import { logger } from '../lib/logger';
import { STARTUP_POLL_INTERVAL_MS, SESSION_ID_DISPLAY_LENGTH, MAX_STARTUP_POLL_ERRORS, MAX_TERMINALS_PER_SESSION } from '../lib/constants';
import { z } from 'zod';
import {
  UserResponseSchema,
  SessionsResponseSchema,
  CreateSessionResponseSchema,
  StartupStatusResponseSchema,
  BatchSessionStatusResponseSchema,
  SetupStatusResponseSchema,
  DetectTokenResponseSchema,
  SetupPrefillResponseSchema,
  UserEntrySchema,
  GetUsersResponseSchema,
  PresetsResponseSchema,
  CreatePresetResponseSchema,
  DeletePresetResponseSchema,
  UserPreferencesSchema,
  LlmKeysResponseSchema,
  DeployKeysResponseSchema,
  OnboardingConfigResponseSchema,
  AuthStatusResponseSchema,
  AuthProvidersResponseSchema,
  AccessTierSchema,
  SubscriptionTierSchema,
} from '../lib/schemas';
import { mapStartupDetailsToProgress } from '../lib/status-mapper';
import { ApiError, baseFetch } from './fetch-helper';

const BASE_URL = '/api';

async function fetchApi<T>(endpoint: string, options: RequestInit, schema: z.ZodType<T>): Promise<T>;
async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T | undefined>;
async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {},
  schema?: z.ZodType<T>
): Promise<T | undefined> {
  return baseFetch<T>(`${BASE_URL}${endpoint}`, options, {
    credentials: 'same-origin',
    schema,
  });
}

// User API
export async function getUser(): Promise<UserInfo> {
  return fetchApi('/user', {}, UserResponseSchema);
}

// Session API
export async function getSessions(): Promise<Session[]> {
  const response = await fetchApi('/sessions', {}, SessionsResponseSchema);
  return response.sessions || [];
}

export async function createSession(name: string, agentType?: AgentType, tabConfig?: TabConfig[]): Promise<Session> {
  const body: Record<string, unknown> = { name };
  if (agentType) body.agentType = agentType;
  if (tabConfig) body.tabConfig = tabConfig;

  const response = await fetchApi('/sessions', {
    method: 'POST',
    body: JSON.stringify(body),
  }, CreateSessionResponseSchema);
  if (!response.session) {
    throw new Error('Failed to create session');
  }
  return response.session;
}

export async function updateSession(
  id: string,
  data: Partial<Pick<Session, 'name' | 'tabConfig'>>
): Promise<Session> {
  if (!SESSION_ID_RE.test(id)) {
    throw new ApiError('Invalid session ID format', 400, 'Bad Request');
  }
  const response = await fetchApi('/sessions/' + id, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }, CreateSessionResponseSchema);
  if (!response.session) {
    throw new Error('Failed to update session');
  }
  return response.session;
}

export async function deleteSession(id: string): Promise<void> {
  if (!SESSION_ID_RE.test(id)) {
    throw new ApiError('Invalid session ID format', 400, 'Bad Request');
  }
  await fetchApi(`/sessions/${id}`, {
    method: 'DELETE',
  });
}

/**
 * Get status for all sessions in a single batch call
 * Returns statuses map, maxSessions limit, and optional storageStats
 */
export async function getBatchSessionStatus(options?: { includePreseedCheck?: boolean }): Promise<{ statuses: Record<string, { status: 'running' | 'stopped'; ptyActive: boolean; startupStage?: string; lastStartedAt?: string | null; lastActiveAt?: string | null; metrics?: { cpu?: string; mem?: string; hdd?: string; syncStatus?: string; updatedAt?: string } }>; maxSessions: number; storageStats?: { totalFiles: number; totalFolders: number; totalSizeBytes: number }; usage?: { dailySeconds: number; monthlySeconds: number; monthlyQuotaSeconds: number | null; tier: string }; preseedNeedsUpgrade?: boolean }> {
  const path = options?.includePreseedCheck ? '/sessions/batch-status?includePreseedCheck=true' : '/sessions/batch-status';
  const response = await fetchApi(path, {}, BatchSessionStatusResponseSchema);
  return { statuses: response.statuses, maxSessions: response.maxSessions, storageStats: response.storageStats, usage: response.usage, preseedNeedsUpgrade: response.preseedNeedsUpgrade };
}

// Get container startup status (polling endpoint)
export async function getStartupStatus(sessionId: string): Promise<StartupStatusResponse> {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new ApiError('Invalid session ID format', 400, 'Bad Request');
  }
  return fetchApi(`/container/startup-status?sessionId=${sessionId}`, {}, StartupStatusResponseSchema);
}

// Start session with polling progress (replaces SSE)
export function startSession(
  id: string,
  onProgress: (progress: InitProgress) => void,
  onComplete: () => void,
  onError: (error: string) => void
): () => void {
  if (!SESSION_ID_RE.test(id)) {
    onError('Invalid session ID format');
    return () => {};
  }
  let cancelled = false;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();

  const startPolling = async () => {
    // First, trigger container start
    try {
      // Send initial creating stage
      onProgress({
        stage: 'creating',
        progress: 5,
        message: 'Preparing session...',
        details: [{ key: 'Session', value: id.substring(0, SESSION_ID_DISPLAY_LENGTH) }],
        startedAt,
      });

      // Trigger container start with the actual session ID
      await fetchApi(`/container/start?sessionId=${id}`, { method: 'POST' });
    } catch (err) {
      // Differentiate definitive failures from transient errors.
      // The backend uses ctx.waitUntil() - container may have started despite client error.
      // For transient errors, proceed to polling; polling will timeout naturally if container didn't start.
      const isDefinitiveFailure = err instanceof ApiError
        && err.status >= 400 && err.status < 500;

      if (isDefinitiveFailure) {
        logger.error('Container start failed (definitive):', (err as ApiError).status, err.message);
        onError(`Container start failed: ${err.message}`);
        return;
      }
      // Transient error (network failure, timeout, 5xx) - proceed to polling
      logger.debug('Container start request (transient, proceeding to poll):', err);
    }

    // Start polling for status
    let consecutiveErrors = 0;

    const poll = async () => {
      if (cancelled) return;

      try {
        const status = await getStartupStatus(id);
        consecutiveErrors = 0;

        const progress = mapStartupDetailsToProgress(status);
        progress.startedAt = startedAt;
        onProgress(progress);

        if (status.stage === 'ready') {
          if (pollInterval) clearInterval(pollInterval);
          onComplete();
        } else if (status.stage === 'error') {
          if (pollInterval) clearInterval(pollInterval);
          onError(status.error || 'Container startup failed');
        }
      } catch (err) {
        consecutiveErrors++;
        logger.error('Polling error:', err);
        if (consecutiveErrors >= MAX_STARTUP_POLL_ERRORS) {
          if (pollInterval) clearInterval(pollInterval);
          onError('Polling failed after too many consecutive errors');
          return;
        }
      }
    };

    // Initial poll
    await poll();

    // Continue polling at regular intervals
    pollInterval = setInterval(poll, STARTUP_POLL_INTERVAL_MS);
  };

  startPolling().catch((err) => onError(err instanceof Error ? err.message : String(err)));

  // Return cleanup function
  return () => {
    cancelled = true;
    if (pollInterval) clearInterval(pollInterval);
  };
}

export async function stopSession(id: string): Promise<void> {
  if (!SESSION_ID_RE.test(id)) {
    throw new ApiError('Invalid session ID format', 400, 'Bad Request');
  }
  await fetchApi(`/sessions/${id}/stop`, {
    method: 'POST',
  });
}

// User management
export type UserEntry = z.infer<typeof UserEntrySchema>;

export async function getUsers(): Promise<{ users: UserEntry[]; maxUsers: number }> {
  const data = await fetchApi('/users', {}, GetUsersResponseSchema);
  return { users: data.users, maxUsers: data.maxUsers ?? 0 };
}

export async function updateMaxUsers(maxUsers: number): Promise<{ success: boolean; maxUsers: number }> {
  return fetchApi('/users/max-users', {
    method: 'PUT',
    body: JSON.stringify({ maxUsers }),
  }, z.object({ success: z.boolean(), maxUsers: z.number() }));
}


// Setup API
type SetupStatusResponse = z.infer<typeof SetupStatusResponseSchema>;

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return fetchApi('/setup/status', {}, SetupStatusResponseSchema);
}

type DetectTokenResponse = z.infer<typeof DetectTokenResponseSchema>;

export async function detectToken(): Promise<DetectTokenResponse> {
  return fetchApi('/setup/detect-token', {}, DetectTokenResponseSchema);
}

type SetupPrefillResponse = z.infer<typeof SetupPrefillResponseSchema>;

export async function getSetupPrefill(): Promise<SetupPrefillResponse> {
  return fetchApi('/setup/prefill', {}, SetupPrefillResponseSchema);
}

// Preset API
export async function getPresets(): Promise<TabPreset[]> {
  const response = await fetchApi('/presets', {}, PresetsResponseSchema);
  return response.presets;
}

export async function savePreset(data: { name: string; tabs: TabConfig[] }): Promise<TabPreset> {
  const response = await fetchApi('/presets', {
    method: 'POST',
    body: JSON.stringify(data),
  }, CreatePresetResponseSchema);
  return response.preset;
}

export async function deletePreset(id: string): Promise<void> {
  await fetchApi(`/presets/${id}`, {
    method: 'DELETE',
  }, DeletePresetResponseSchema);
}

export async function patchPreset(id: string, data: { label: string }): Promise<TabPreset> {
  const response = await fetchApi(`/presets/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  }, CreatePresetResponseSchema);
  return response.preset;
}

// Preferences API
export async function getPreferences(): Promise<UserPreferences> {
  return fetchApi('/preferences', {}, UserPreferencesSchema);
}

export async function updatePreferences(prefs: Partial<UserPreferences>): Promise<UserPreferences> {
  return fetchApi('/preferences', {
    method: 'PATCH',
    body: JSON.stringify(prefs),
  }, UserPreferencesSchema);
}

// LLM Keys API
type LlmKeysResponse = z.infer<typeof LlmKeysResponseSchema>;

export async function getLlmKeys(): Promise<LlmKeysResponse> {
  return fetchApi('/llm-keys', {}, LlmKeysResponseSchema);
}

export async function updateLlmKeys(keys: { openaiApiKey?: string | null; geminiApiKey?: string | null }): Promise<LlmKeysResponse> {
  return fetchApi('/llm-keys', {
    method: 'PUT',
    body: JSON.stringify(keys),
  }, LlmKeysResponseSchema);
}

export async function deleteLlmKeys(): Promise<void> {
  await fetchApi('/llm-keys', {
    method: 'DELETE',
  });
}

// Deploy Keys API
export type DeployKeysResponse = z.infer<typeof DeployKeysResponseSchema>;

export async function getDeployKeys(): Promise<DeployKeysResponse> {
  return fetchApi('/deploy-keys', {}, DeployKeysResponseSchema);
}

export async function updateDeployKeys(keys: {
  githubToken?: string | null;
  cloudflareApiToken?: string | null;
  cloudflareAccountId?: string | null;
}): Promise<DeployKeysResponse> {
  return fetchApi('/deploy-keys', {
    method: 'PUT',
    body: JSON.stringify(keys),
  }, DeployKeysResponseSchema);
}

export async function deleteDeployKeys(): Promise<void> {
  await fetchApi('/deploy-keys', {
    method: 'DELETE',
  });
}

// Onboarding API (public - no auth required)
type OnboardingConfigResponse = z.infer<typeof OnboardingConfigResponseSchema>;

export async function getOnboardingConfig(): Promise<OnboardingConfigResponse> {
  return fetchApi('/auth/onboarding-config', {}, OnboardingConfigResponseSchema);
}

// Mark onboarding as complete for the current user
export async function markOnboardingComplete(): Promise<{ success: boolean }> {
  const data = await fetchApi<{ success: boolean }>('/user/onboarding-complete', { method: 'POST' });
  return data ?? { success: false };
}

// R2 scoped token readiness
export async function getR2Status(): Promise<{ ready: boolean }> {
  const data = await fetchApi<{ ready: boolean }>('/user/r2-status', {});
  return data ?? { ready: false };
}

export async function ensureR2Token(): Promise<{ ready: boolean }> {
  const data = await fetchApi<{ ready: boolean }>('/user/ensure-r2-token', { method: 'POST' });
  return data ?? { ready: false };
}

// Auth providers - stays public because login page needs it before user is authenticated
export async function getAuthProviders(): Promise<{ providers: AuthProvider[] }> {
  return baseFetch<{ providers: AuthProvider[] }>('/auth/providers', {}, {
    basePath: '/public',
    schema: AuthProvidersResponseSchema,
  });
}

export async function getAuthStatus(): Promise<AuthStatus> {
  return fetchApi('/auth/status', {}, AuthStatusResponseSchema);
}

// requestAccess removed - replaced by subscribe() for self-service tier selection


const UpdateUserTierResponseSchema = z.object({
  success: z.boolean(),
  email: z.string(),
  subscriptionTier: SubscriptionTierSchema,
  accessTier: AccessTierSchema.or(SubscriptionTierSchema),
});

export async function updateUserTier(
  email: string,
  subscriptionTier: string,
  subscribedMode?: 'default' | 'advanced',
): Promise<z.infer<typeof UpdateUserTierResponseSchema>> {
  return fetchApi(`/users/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: JSON.stringify({ subscriptionTier, ...(subscribedMode !== undefined && { subscribedMode }) }),
  }, UpdateUserTierResponseSchema);
}


const UsageResponseSchema = z.object({
  dailySeconds: z.number(),
  monthlySeconds: z.number(),
  monthlyQuotaSeconds: z.number().nullable(),
  tier: z.string(),
  mode: z.enum(['default', 'advanced']).optional(),
});

export async function getUsage(): Promise<z.infer<typeof UsageResponseSchema>> {
  return fetchApi('/usage', {}, UsageResponseSchema);
}

// Robust schema for tier objects - tolerates null, missing, and string values
// from KV data that may have been written by older code versions.
const TierObjectSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  monthlySeconds: z.number().nullable(),
  maxSessions: z.number(),
  sessionModes: z.array(z.string()).default(['default']),
  canLogin: z.boolean(),
  order: z.number(),
  isDefault: z.boolean(),
  priceMonthly: z.number().nullable(),
  trialQuotaHours: z.number().nullable().optional(),
  trialDays: z.number().nullable().optional(),
  description: z.string().default(''),
  advancedPriceMonthly: z.number().nullable().optional(),
  maxStorageBytes: z.number().nullable().optional(),
}).passthrough(); // allow extra fields from KV without failing

const TiersResponseSchema = z.object({
  tiers: z.array(TierObjectSchema),
});

export async function getTiers(): Promise<z.infer<typeof TiersResponseSchema>> {
  return fetchApi('/admin/tiers', {}, TiersResponseSchema);
}

export async function updateTiers(tiers: unknown[]): Promise<{ success: boolean }> {
  return fetchApi('/admin/tiers', {
    method: 'PUT',
    body: JSON.stringify(tiers),
  }, z.object({ success: z.boolean() }));
}

export async function getPublicTiers(): Promise<z.infer<typeof TiersResponseSchema>> {
  return fetchApi('/auth/tiers', {}, TiersResponseSchema);
}

const SubscribeResponseSchema = z.object({
  success: z.boolean(),
  tier: z.string(),
  trialQuotaHours: z.number(),
  onboardingComplete: z.boolean(),
});

export async function subscribe(tier: string, turnstileToken: string, mode?: string): Promise<z.infer<typeof SubscribeResponseSchema>> {
  return fetchApi('/auth/subscribe', {
    method: 'POST',
    body: JSON.stringify({ tier, turnstileToken, mode }),
  }, SubscribeResponseSchema);
}

// Billing API
const CheckoutResponseSchema = z.object({
  checkoutUrl: z.string(),
});

export async function createCheckoutSession(tier: string, mode?: string): Promise<{ checkoutUrl: string }> {
  return fetchApi('/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ tier, mode }),
  }, CheckoutResponseSchema);
}

const PortalResponseSchema = z.object({
  portalUrl: z.string(),
});

export async function createPortalSession(): Promise<{ portalUrl: string }> {
  return fetchApi('/billing/portal', {
    method: 'POST',
  }, PortalResponseSchema);
}

const BillingStatusSchema = z.object({
  stripeCustomerId: z.string().nullable(),
  stripeSubscriptionId: z.string().nullable(),
  stripePriceId: z.string().nullable(),
  billingPeriodEnd: z.string().nullable(),
  checkoutSessionId: z.string().nullable(),
  billingStatus: z.string().nullable(),
});

export async function getBillingStatus(): Promise<z.infer<typeof BillingStatusSchema>> {
  return fetchApi('/billing/status', { method: 'GET' }, BillingStatusSchema);
}

export async function createSwitchSession(tier: string, mode?: string): Promise<{ portalUrl: string }> {
  return fetchApi('/billing/switch', {
    method: 'POST',
    body: JSON.stringify({ tier, mode }),
  }, PortalResponseSchema);
}

export async function deleteUser(email: string): Promise<{ success: boolean; email: string }> {
  return fetchApi(`/users/${encodeURIComponent(email)}`, {
    method: 'DELETE',
  }, z.object({ success: z.boolean(), email: z.string() }));
}

// Session ID format: 8-24 lowercase alphanumeric characters (matches backend SESSION_ID_PATTERN)
const SESSION_ID_RE = /^[a-z0-9]{8,24}$/;

// WebSocket URL helper - uses compound session ID for multiple terminals per session
export function getTerminalWebSocketUrl(sessionId: string, terminalId: string = '1', manual?: boolean): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId "${sessionId}": must be 8-24 lowercase alphanumeric characters`);
  }
  const id = parseInt(terminalId, 10);
  if (isNaN(id) || id < 1 || id > MAX_TERMINALS_PER_SESSION) {
    throw new Error(`Invalid terminalId "${terminalId}": must be between 1 and ${MAX_TERMINALS_PER_SESSION}`);
  }
  // Compound session ID: sessionId-terminalId (e.g., "abc123-1", "abc123-2")
  // Backend treats each as a unique PTY session within the same container
  const compoundSessionId = `${sessionId}-${terminalId}`;
  const wsUrl = new URL(`/api/terminal/${compoundSessionId}/ws`, window.location.href);
  wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (manual) {
    wsUrl.searchParams.set('manual', '1');
  }
  return wsUrl.toString();
}
