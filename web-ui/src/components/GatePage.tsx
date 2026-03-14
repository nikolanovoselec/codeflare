import { Component, onMount, onCleanup, createSignal, Show } from 'solid-js';
import { getAuthStatus } from '../api/client';
import type { AuthStatus } from '../types';
import { logger } from '../lib/logger';
import '../styles/gate-page.css';

const POLL_INTERVAL_MS = 10_000;

const GatePage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [status, setStatus] = createSignal<AuthStatus | null>(null);
  const [error, setError] = createSignal('');

  let pollInterval: ReturnType<typeof setInterval> | undefined;

  async function fetchStatus() {
    try {
      const result = await getAuthStatus();
      setStatus(result);
      setError('');

      // Auto-redirect if access granted
      if (result.accessTier === 'standard' || result.accessTier === 'advanced') {
        if (pollInterval) clearInterval(pollInterval);
        window.location.href = '/app/';
        return;
      }

      // Stop polling for blocked users — status won't change without admin action
      if (result.accessTier === 'blocked') {
        if (pollInterval) clearInterval(pollInterval);
      }
    } catch (err) {
      logger.error('Failed to fetch auth status:', err);
      setError('Unable to check account status. Retrying...');
    }
    setLoading(false);
  }

  onMount(() => {
    fetchStatus();
    pollInterval = setInterval(fetchStatus, POLL_INTERVAL_MS);
  });

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  const isPending = () => status()?.accessTier === 'pending';
  const isBlocked = () => status()?.accessTier === 'blocked';

  return (
    <div class="gate-page">
      <Show
        when={!loading()}
        fallback={
          <div class="gate-loading">
            <div class="gate-spinner" />
          </div>
        }
      >
        <div class="gate-container">
          <Show when={isPending()}>
            <div class="gate-icon">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2m0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8m.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z" />
              </svg>
            </div>
            <h1 class="gate-title">Account Pending Approval</h1>
            <p class="gate-message">
              Your account is waiting for administrator approval. This page will automatically
              refresh when your access is granted.
            </p>
            <div class="gate-email">{status()!.email}</div>
            <div class="gate-polling">
              <span class="gate-pulse" />
              Checking status...
            </div>
          </Show>

          <Show when={isBlocked()}>
            <div class="gate-icon gate-icon--blocked">
              <svg viewBox="0 0 24 24" width="48" height="48" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9A7.902 7.902 0 0 1 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1A7.902 7.902 0 0 1 20 12c0 4.42-3.58 8-8 8z" />
              </svg>
            </div>
            <h1 class="gate-title">Account Blocked</h1>
            <p class="gate-message">
              Your account has been blocked by an administrator.
              Please contact support if you believe this is an error.
            </p>
            <div class="gate-email">{status()!.email}</div>
          </Show>

          <Show when={error()}>
            <p class="gate-message">{error()}</p>
          </Show>

          <a href="/auth/logout" class="gate-logout-button">
            Log out
          </a>
        </div>
      </Show>
    </div>
  );
};

export default GatePage;
