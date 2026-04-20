import { createSignal } from 'solid-js';

/**
 * Usage Quota State — extracted from session.ts (CF-013).
 *
 * Reactive signal for live usage-quota display in dropdown menus
 * and dashboard badges. Persists to localStorage so the UI can
 * show a cached value before the first batch-status response arrives.
 */

// ============================================================================
// Types
// ============================================================================

export interface UsageState {
  monthlySeconds: number;
  monthlyQuotaSeconds: number | null;
}

export type UsageWarningLevel = 'none' | '80' | '95' | '100';

// ============================================================================
// Cached usage bootstrap
// ============================================================================

function loadCachedUsage(): UsageState {
  try {
    const cached = localStorage.getItem('cf_usage');
    if (cached) {
      const parsed = JSON.parse(cached) as UsageState;
      if (typeof parsed.monthlySeconds === 'number') return parsed;
    }
  } catch { /* localStorage unavailable or corrupt */ }
  return { monthlySeconds: 0, monthlyQuotaSeconds: null };
}

// ============================================================================
// Reactive signal
// ============================================================================

const [usageSignal, setUsageSignal] = createSignal<UsageState>(loadCachedUsage());

// ============================================================================
// Public API
// ============================================================================

export function setUsageState(monthly: number, quota: number | null): void {
  const next: UsageState = { monthlySeconds: monthly, monthlyQuotaSeconds: quota };
  setUsageSignal(next);
  try {
    localStorage.setItem('cf_usage', JSON.stringify(next));
  } catch { /* localStorage unavailable */ }
}

export function getUsageState(): { monthlySeconds: number; monthlyQuotaSeconds: number | null } {
  return usageSignal();
}

export function isAtUsageQuota(): boolean {
  const { monthlySeconds, monthlyQuotaSeconds } = usageSignal();
  if (monthlyQuotaSeconds === null) return false;
  return monthlySeconds >= monthlyQuotaSeconds;
}

export function getUsageWarningLevel(): UsageWarningLevel {
  const { monthlySeconds, monthlyQuotaSeconds } = usageSignal();
  if (monthlyQuotaSeconds === null || monthlyQuotaSeconds === 0) return 'none';
  const pct = (monthlySeconds / monthlyQuotaSeconds) * 100;
  if (pct >= 100) return '100';
  if (pct >= 95) return '95';
  if (pct >= 80) return '80';
  return 'none';
}

// ============================================================================
// Dismissed quota warning (per UTC month)
// Implements REQ-SUB-018
// ============================================================================

type DismissedLevel = '80' | '95' | null;

function getDismissedKey(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `cf_dismissed_quota_${y}-${m}`;
}

function loadDismissedLevel(): DismissedLevel {
  try {
    const v = localStorage.getItem(getDismissedKey());
    if (v === '80' || v === '95') return v;
  } catch { /* localStorage unavailable */ }
  return null;
}

// Signal acts as a reactive trigger; actual value is read fresh from localStorage
// on each get so long-lived tabs pick up a new month's empty key automatically.
const [dismissedSignal, setDismissedSignal] = createSignal<DismissedLevel>(loadDismissedLevel());

export function getDismissedQuotaLevel(): DismissedLevel {
  dismissedSignal(); // reactive dependency — re-runs consumers on setDismissedQuotaLevel
  return loadDismissedLevel();
}

export function setDismissedQuotaLevel(level: '80' | '95'): void {
  try {
    localStorage.setItem(getDismissedKey(), level);
  } catch { /* localStorage unavailable */ }
  setDismissedSignal(level);
}
