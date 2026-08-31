import type { Session, UserInfo, InitProgress, StartupStatusResponse, AgentType, TabConfig, UserPreferences, AuthStatus, AuthProvider, AdminConfigurationResponse } from '../types';
import { logger } from '../lib/logger';
import { STARTUP_POLL_INTERVAL_MS, SESSION_ID_DISPLAY_LENGTH, MAX_STARTUP_POLL_ERRORS, MAX_TERMINALS_PER_SESSION, SESSION_ID_RE } from '../lib/constants';
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

const ConfigurationSectionSchema = z.enum([
  'access', 'domain', 'aiRouting', 'codingAgents', 'browserRendering', 'securityEgress',
  'dataGovernance', 'managedEnvironment', 'github', 'cloudflareConnection', 'usageReports',
]);

const AdminConfigurationResponseSchema: z.ZodType<AdminConfigurationResponse> = z.object({
  mode: z.enum(['default', 'onboarding', 'saas', 'enterprise']),
  revision: z.number().int().nonnegative(),
  applicableSections: z.array(ConfigurationSectionSchema),
  sections: z.record(z.string(), z.unknown()),
  activeRunId: z.string().nullable(),
  latest: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export async function getAdminConfiguration(): Promise<AdminConfigurationResponse> {
  return fetchApi('/admin/configuration', {}, AdminConfigurationResponseSchema);
}

const AdminUsageUserSchema = z.object({
  userKey: z.string().regex(/^[0-9a-f]{64}$/),
  email: z.string().email(),
  accountStatus: z.enum(['active', 'deleted']),
  dataSince: z.string(),
  deletedAt: z.string().nullable(),
  runtimeSeconds: z.number().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  historyUpdatedAt: z.string(),
});

const AdminUsageResponseSchema = z.object({
  period: z.enum(['day', 'week', 'month', 'year']),
  start: z.string(),
  timezone: z.literal('UTC'),
  sort: z.enum(['runtimeSeconds', 'sessionCount', 'email']),
  direction: z.enum(['asc', 'desc']),
  summary: z.object({
    runtimeSeconds: z.number().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
    activeUsers: z.number().int().nonnegative(),
  }),
  dataSince: z.string().nullable(),
  historyUpdatedAt: z.string().nullable(),
  users: z.array(AdminUsageUserSchema),
  nextCursor: z.string().nullable(),
});

type AdminUsageResponse = z.infer<typeof AdminUsageResponseSchema>;
export type AdminUsageUser = z.infer<typeof AdminUsageUserSchema>;

export interface AdminUsageQuery {
  period: 'day' | 'week' | 'month' | 'year';
  start: string;
  sort?: 'runtimeSeconds' | 'sessionCount' | 'email';
  direction?: 'asc' | 'desc';
  cursor?: string;
  limit?: number;
}

export async function getAdminUsage(query: AdminUsageQuery): Promise<AdminUsageResponse> {
  const params = new URLSearchParams(Object.entries(query)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => [key, String(value)]));
  return fetchApi(`/admin/usage?${params}`, {}, AdminUsageResponseSchema);
}

const AdminUsageDetailSchema = AdminUsageUserSchema.extend({
  period: z.enum(['day', 'week', 'month', 'year']),
  start: z.string(),
  timezone: z.literal('UTC'),
});

export async function getAdminUsageUser(
  userKey: string,
  period: AdminUsageQuery['period'],
  start: string,
): Promise<z.infer<typeof AdminUsageDetailSchema>> {
  return fetchApi(
    `/admin/usage/users/${encodeURIComponent(userKey)}?period=${period}&start=${encodeURIComponent(start)}`,
    {},
    AdminUsageDetailSchema,
  );
}

const UsageReportDeliverySchema = z.object({
  id: z.string(),
  deliveryKind: z.enum(['scheduled', 'test']),
  dispatchId: z.string(),
  settingsRevision: z.number().int(),
  reportMonth: z.string(),
  recipient: z.string().email(),
  state: z.enum(['pending', 'sending', 'accepted', 'failed']),
  attempt: z.number().int(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  acceptedAt: z.string().nullable().optional(),
});

const UsageReportDeliveriesSchema = z.object({
  deliveries: z.array(UsageReportDeliverySchema),
  nextCursor: z.string().nullable(),
});

export type UsageReportDelivery = z.infer<typeof UsageReportDeliverySchema>;

export async function getUsageReportDeliveries(): Promise<z.infer<typeof UsageReportDeliveriesSchema>> {
  return fetchApi('/admin/usage-report-deliveries?limit=50', {}, UsageReportDeliveriesSchema);
}

export async function sendUsageReportTest(): Promise<{ dispatchId: string; deliveryKind: 'test'; state: 'pending' }> {
  return fetchApi('/admin/usage-report-tests', { method: 'POST' }, z.object({
    dispatchId: z.string(), deliveryKind: z.literal('test'), state: z.literal('pending'),
  }));
}

// Per-device agent notification enrollment (REQ-TERM-025 AC1-AC5)
const AgentNotificationConfigSchema = z.object({
  vapidPublicKey: z.string().min(1),
});

export interface AgentNotificationSubscriptionRegistration {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

export async function getAgentNotificationVapidPublicKey(): Promise<string> {
  const config = await fetchApi('/notifications/config', {}, AgentNotificationConfigSchema);
  return config.vapidPublicKey;
}

export async function saveAgentNotificationSubscription(
  subscription: AgentNotificationSubscriptionRegistration,
): Promise<void> {
  await fetchApi('/notifications/subscription', {
    method: 'POST',
    body: JSON.stringify(subscription),
  });
}

export async function deleteAgentNotificationSubscription(endpoint: string): Promise<void> {
  await fetchApi('/notifications/subscription', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint }),
  });
}

// Session API
export async function getSessions(): Promise<Session[]> {
  const response = await fetchApi('/sessions', {}, SessionsResponseSchema);
  return response.sessions || [];
}

// Optional repo to clone into the new container at start (REQ-GITHUB-004).
// `ref` is omitted today (backend defaults to the repo's default branch);
// kept optional so a future branch picker is a one-line change.
export interface CreateSessionClone {
  repo: string;
  ref?: string;
}

export async function createSession(
  name: string,
  agentType?: AgentType,
  tabConfig?: TabConfig[],
  clone?: CreateSessionClone,
): Promise<Session> {
  const body: Record<string, unknown> = { name };
  if (agentType) body.agentType = agentType;
  if (tabConfig) body.tabConfig = tabConfig;
  if (clone) body.clone = clone;

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
export async function getBatchSessionStatus(options?: { includePreseedCheck?: boolean }): Promise<{ statuses: Record<string, { status: 'running' | 'stopped'; ptyActive: boolean; startupStage?: string; lastStartedAt?: string | null; lastActiveAt?: string | null; editorReady?: boolean; editorReadyError?: boolean; metrics?: { cpu?: string; mem?: string; hdd?: string; syncStatus?: string; updatedAt?: string } }>; maxSessions: number; storageStats?: { totalFiles: number; totalFolders: number; totalSizeBytes: number }; usage?: { dailySeconds: number; monthlySeconds: number; monthlyQuotaSeconds: number | null; tier: string }; preseedNeedsUpgrade?: boolean; managedReleaseStatus?: 'current' | 'upgrading' | 'update_pending'; bucketMigrating?: boolean; bucketMigrationPending?: boolean; bucketMigrationPercent?: number }> {
  const path = options?.includePreseedCheck ? '/sessions/batch-status?includePreseedCheck=true' : '/sessions/batch-status';
  const response = await fetchApi(path, {}, BatchSessionStatusResponseSchema);
  return { statuses: response.statuses, maxSessions: response.maxSessions, storageStats: response.storageStats, usage: response.usage, preseedNeedsUpgrade: response.preseedNeedsUpgrade, managedReleaseStatus: response.managedReleaseStatus, bucketMigrating: response.bucketMigrating, bucketMigrationPending: response.bucketMigrationPending, bucketMigrationPercent: response.bucketMigrationPercent };
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
  onError: (error: string, code?: string) => void,
  options: { retryEditorTimeout?: boolean } = {},
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
        onError(`Container start failed: ${err.message}`, (err as ApiError).code);
        return;
      }
      // Transient error (network failure, timeout, 5xx) - proceed to polling
      logger.debug('Container start request (transient, proceeding to poll):', err);
    }

    // A running VS Code host exposes the prior timeout until its automatic
    // retry probe begins. Retry ignores only that stale state; once mounting is
    // observed, a later timeout is a new failure.
    let ignorePriorEditorTimeout = options.retryEditorTimeout === true;
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
          const isPriorEditorTimeout = ignorePriorEditorTimeout
            && status.error === 'VS Code did not become ready. Retry starting the session.';
          if (!isPriorEditorTimeout) {
            if (pollInterval) clearInterval(pollInterval);
            onError(status.error || 'Container startup failed');
          }
        } else {
          ignorePriorEditorTimeout = false;
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

export async function createCheckoutSession(tier: string, mode?: string, turnstileToken?: string): Promise<{ checkoutUrl: string }> {
  return fetchApi('/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ tier, mode, turnstileToken }),
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

// Compound route supports the classic range; Worker authorizes Herdr ID 1 after session lookup.
export function getTerminalWebSocketUrl(sessionId: string, terminalId: string = '1', manual?: boolean): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId "${sessionId}": must be 8-24 lowercase alphanumeric characters`);
  }
  const id = Number.parseInt(terminalId, 10);
  if (!Number.isInteger(id) || String(id) !== terminalId || id < 1 || id > MAX_TERMINALS_PER_SESSION) {
    throw new Error(`Invalid terminalId "${terminalId}": must be between 1 and ${MAX_TERMINALS_PER_SESSION}`);
  }
  const compoundSessionId = `${sessionId}-${terminalId}`;
  const wsUrl = new URL(`/api/terminal/${compoundSessionId}/ws`, window.location.href);
  wsUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (manual) wsUrl.searchParams.set('manual', '1');
  return wsUrl.toString();
}
