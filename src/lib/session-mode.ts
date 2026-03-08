import type { UserPreferences, SessionMode } from '../types';

export function resolveSessionMode(prefs: UserPreferences | null): SessionMode {
  return prefs?.sessionMode ?? 'default';
}
