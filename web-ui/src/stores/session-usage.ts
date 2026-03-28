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
