import type { Session, UserInfo, InitProgress, StartupStatusResponse, AgentType, TabConfig, TabPreset, UserPreferences } from '../types';
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
  ConfigureResponseSchema,
  UserEntrySchema,
  GetUsersResponseSchema,
  UserMutationResponseSchema,
  PresetsResponseSchema,
  CreatePresetResponseSchema,
  DeletePresetResponseSchema,
  UserPreferencesSchema,
  OnboardingConfigResponseSchema,
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
 * Returns a map of sessionId -> { status, ptyActive, startupStage? }
 */
export async function getBatchSessionStatus(): Promise<Record<string, { status: 'running' | 'stopped' | 'stopping'; ptyActive: boolean; startupStage?: string; lastStartedAt?: string | null; lastActiveAt?: string | null; metrics?: { cpu?: string; mem?: string; hdd?: string; syncStatus?: string; updatedAt?: string } }>> {
  const response = await fetchApi('/sessions/batch-status', {}, BatchSessionStatusResponseSchema);
  return response.statuses;
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
      // The backend uses ctx.waitUntil() — container may have started despite client error.
      // For transient errors, proceed to polling; polling will timeout naturally if container didn't start.
      const isDefinitiveFailure = err instanceof ApiError
        && err.status >= 400 && err.status < 500
        && err.status !== 429; // 429 is transient (rate limit)

      if (isDefinitiveFailure) {
        logger.error('Container start failed (definitive):', (err as ApiError).status, err.message);
        onError(`Container start failed: ${err.message}`);
        return;
      }
      // Transient error (network failure, timeout, 5xx, 429) — proceed to polling
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

export async function getUsers(): Promise<UserEntry[]> {
  const data = await fetchApi('/users', {}, GetUsersResponseSchema);
  return data.users;
}

export async function removeUser(email: string): Promise<void> {
  await fetchApi(`/users/${encodeURIComponent(email)}`, {
    method: 'DELETE',
  }, UserMutationResponseSchema);
}

// Setup API
export type SetupStatusResponse = z.infer<typeof SetupStatusResponseSchema>;

export async function getSetupStatus(): Promise<SetupStatusResponse> {
  return fetchApi('/setup/status', {}, SetupStatusResponseSchema);
}

export type DetectTokenResponse = z.infer<typeof DetectTokenResponseSchema>;

export async function detectToken(): Promise<DetectTokenResponse> {
  return fetchApi('/setup/detect-token', {}, DetectTokenResponseSchema);
}

export type SetupPrefillResponse = z.infer<typeof SetupPrefillResponseSchema>;

export async function getSetupPrefill(): Promise<SetupPrefillResponse> {
  return fetchApi('/setup/prefill', {}, SetupPrefillResponseSchema);
}

export type ConfigureResponse = z.infer<typeof ConfigureResponseSchema>;

export async function configure(body: {
  customDomain: string;
  allowedUsers: string[];
  adminUsers: string[];
  allowedOrigins?: string[];
}): Promise<ConfigureResponse> {
  return fetchApi('/setup/configure', {
    method: 'POST',
    body: JSON.stringify(body),
  }, ConfigureResponseSchema);
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

// Onboarding API (public - no auth required)
export type OnboardingConfigResponse = z.infer<typeof OnboardingConfigResponseSchema>;

export async function getOnboardingConfig(): Promise<OnboardingConfigResponse> {
  // Public endpoints live at /public/* (outside /api/*) to avoid CF Access interception
  return baseFetch<OnboardingConfigResponse>('/onboarding-config', {}, {
    basePath: '/public',
    schema: OnboardingConfigResponseSchema,
  });
}

// Admin API
export async function adminDestroyContainer(doId: string): Promise<{ success: boolean; message: string }> {
  return fetchApi('/admin/destroy-by-id', {
    method: 'POST',
    body: JSON.stringify({ doId }),
  }) as Promise<{ success: boolean; message: string }>;
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
