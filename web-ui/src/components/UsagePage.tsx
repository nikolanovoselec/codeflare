import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js';
import { getUsage } from '../api/client';
import { sessionStore } from '../stores/session';
import { formatDuration } from '../lib/format';
import ScrambleText from './ScrambleText';
import '../styles/usage-page.css';
import '../styles/login-page.css';

const UsagePage: Component = () => {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const [dailySeconds, setDailySeconds] = createSignal(0);
  const [monthlySeconds, setMonthlySeconds] = createSignal(0);
  const [quotaSeconds, setQuotaSeconds] = createSignal<number | null>(null);
  const [tierName, setTierName] = createSignal('');

  let pollInterval: ReturnType<typeof setInterval> | undefined;

  async function fetchUsage() {
    try {
      const data = await getUsage();
      setDailySeconds(data.dailySeconds);
      setMonthlySeconds(data.monthlySeconds);
      setQuotaSeconds(data.monthlyQuotaSeconds);
      const mode = data.mode === 'advanced' ? 'Pro' : 'Standard';
      setTierName(`${data.tier} ${mode}`);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load usage');
    }
    setLoading(false);
  }

  onMount(() => {
    void fetchUsage();
    pollInterval = setInterval(() => void fetchUsage(), 30_000);
  });

  onCleanup(() => {
    if (pollInterval) clearInterval(pollInterval);
  });

  const usagePercent = () => {
    const q = quotaSeconds();
    if (q === null || q === 0) return 0;
    return Math.min(100, Math.round((monthlySeconds() / q) * 100));
  };

  const hasQuota = () => quotaSeconds() !== null;

  const barColor = () =>
    usagePercent() >= 100 ? '#ef4444' : usagePercent() >= 80 ? '#f59e0b' : '#3b82f6';

  return (
    <div class="login-page">
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class="login-content">
        <div class="login-logo">
          <img src="/logo-original-transparent.png" alt="Codeflare" class="login-logo-img" />
        </div>

        <h1 class="login-title">
          <ScrambleText text="Codeflare" class="login-title-scramble" />
        </h1>

        <p class="login-subtitle">
          The enterprise agentic engine. Autonomous agents build,
          review, test, and ship inside your own cloud boundary.
        </p>

        <Show when={!loading()} fallback={<div class="usage-loading">Loading usage data...</div>}>
          <Show when={!error()} fallback={<div class="usage-error">{error()}</div>}>
            <div class="usage-panel">
              <div class="usage-panel-header">
                <span class="usage-panel-plan">{tierName()}</span>
                <Show when={hasQuota()}>
                  <span class="usage-panel-percent">{usagePercent()}%</span>
                </Show>
              </div>

              <Show when={hasQuota()}>
                <div class="usage-bar-track">
                  <div
                    class="usage-bar-fill"
                    style={{ width: `${usagePercent()}%`, background: barColor() }}
                  />
                </div>
                <div class="usage-bar-labels">
                  <span>{formatDuration(monthlySeconds())}</span>
                  <span>{formatDuration(quotaSeconds()!)}</span>
                </div>
              </Show>

              <div class="usage-panel-stats">
                <div class="usage-panel-stat">
                  <span class="usage-panel-stat-label">Today</span>
                  <span class="usage-panel-stat-value">{formatDuration(dailySeconds())}</span>
                </div>
                <div class="usage-panel-stat">
                  <span class="usage-panel-stat-label">This month</span>
                  <span class="usage-panel-stat-value">{formatDuration(monthlySeconds())}</span>
                </div>
                <Show when={hasQuota()}>
                  <div class="usage-panel-stat">
                    <span class="usage-panel-stat-label">Quota</span>
                    <span class="usage-panel-stat-value">{formatDuration(quotaSeconds()!)}</span>
                  </div>
                </Show>
              </div>
            </div>

            <div class="usage-actions">
              <a href="/app/" class="usage-btn">Back to Dashboard</a>
              {/* Subscription is SaaS-only billing — hidden in enterprise where
                  /app/subscribe is not reachable and usage is view-only. */}
              <Show when={sessionStore.saasMode}>
                <a href="/app/subscribe" class="usage-btn usage-btn--secondary">Subscription</a>
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default UsagePage;
