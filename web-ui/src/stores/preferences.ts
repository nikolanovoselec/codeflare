import type { UserPreferences } from '../types';

/**
 * User Preferences Store
 *
 * Handles loading and updating user preferences (lastAgentType, lastPresetId, etc.).
 * Extracted from session.ts (FIX-13) for separation of concerns.
 * Uses dependency injection (registerPreferencesDeps) for testability.
 */

// Dependency injection types
interface PreferencesApi {
  getPreferences: () => Promise<UserPreferences>;
  updatePreferences: (prefs: Partial<UserPreferences>) => Promise<UserPreferences>;
}

interface PreferencesLogger {
  warn: (...args: unknown[]) => void;
}

let api: PreferencesApi | null = null;
let log: PreferencesLogger | null = null;
let setPreferences: ((prefs: UserPreferences) => void) | null = null;

/**
 * Register dependencies for the preferences store.
 * Must be called before using loadPreferences/updatePreferences.
 */
export function registerPreferencesDeps(deps: {
  api: PreferencesApi;
  logger: PreferencesLogger;
  setPreferences: (prefs: UserPreferences) => void;
}): void {
  api = deps.api;
  log = deps.logger;
  setPreferences = deps.setPreferences;
}

export async function loadPreferences(): Promise<void> {
  if (!api || !setPreferences) return;
  try {
    const prefs = await api.getPreferences();
    setPreferences(prefs);
  } catch (err) {
    log?.warn('[Preferences] Failed to load preferences:', err);
  }
}

export async function updateUserPreferences(prefs: Partial<UserPreferences>): Promise<void> {
  if (!api || !setPreferences) return;
  try {
    const updated = await api.updatePreferences(prefs);
    setPreferences(updated);
  } catch (err) {
    log?.warn('[Preferences] Failed to update preferences:', err);
  }
}
