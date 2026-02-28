import { createSignal } from 'solid-js';

/**
 * R2 Scoped Token Readiness Store
 *
 * Polls the backend to check if the per-user R2 scoped token is ready.
 * Extracted from session.ts (FIX-13) for separation of concerns.
 * Uses dependency injection (registerR2ReadinessDeps) for testability.
 */

// Dependency injection types
interface R2Api {
  getR2Status: () => Promise<{ ready: boolean }>;
  ensureR2Token: () => Promise<{ ready: boolean }>;
}

let api: R2Api | null = null;

const [r2Ready, setR2Ready] = createSignal(false);
let r2PollInterval: ReturnType<typeof setInterval> | null = null;
const R2_POLL_INTERVAL_MS = 3000;

/**
 * Register dependencies for the R2 readiness store.
 * Must be called before using startR2Polling/stopR2Polling.
 */
export function registerR2ReadinessDeps(deps: R2Api): void {
  api = deps;
}

async function checkR2Status(): Promise<void> {
  if (!api) return;
  try {
    const { ready } = await api.getR2Status();
    if (ready) {
      setR2Ready(true);
      stopR2Polling();
    }
  } catch {
    // Silently ignore — background polling
  }
}

export async function startR2Polling(): Promise<void> {
  if (!api) return;
  if (r2PollInterval !== null) return;

  // Eagerly ensure token exists (backend creates if missing)
  try {
    const { ready } = await api.ensureR2Token();
    if (ready) {
      setR2Ready(true);
      return; // Already ready, no need to poll
    }
  } catch {
    // Fall through to polling
  }

  // Poll for readiness
  checkR2Status();
  r2PollInterval = setInterval(checkR2Status, R2_POLL_INTERVAL_MS);
}

export function stopR2Polling(): void {
  if (r2PollInterval !== null) {
    clearInterval(r2PollInterval);
    r2PollInterval = null;
  }
}

export function isR2Ready(): boolean {
  return r2Ready();
}

/** @internal — exposed for tests */
export function _resetR2Ready(): void {
  setR2Ready(false);
  stopR2Polling();
}
