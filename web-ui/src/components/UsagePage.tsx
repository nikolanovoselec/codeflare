import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js';
import { getUsage } from '../api/client';
import { formatDuration } from '../lib/format';
import '../styles/usage-page.css';

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
      setTierName(data.tier);
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

  // SVG progress ring dimensions
  const RING_SIZE = 160;
  const RING_STROKE = 12;
  const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  return (
    <div class="login-page">
      <div class="login-particles login-particles--1" />
      <div class="login-particles login-particles--2" />

      <div class="login-content">
        <h1 class="usage-title">Usage</h1>

        <Show when={!loading()} fallback={<div class="usage-loading">Loading usage data...</div>}>
          <Show when={!error()} fallback={<div class="usage-error">{error()}</div>}>
            <Show when={hasQuota()}>
              <div class="usage-ring-container">
                <svg width={RING_SIZE} height={RING_SIZE} class="usage-ring">
                  <circle
                    cx={RING_SIZE / 2}
                    cy={RING_SIZE / 2}
                    r={RING_RADIUS}
                    fill="none"
                    stroke="var(--color-border)"
                    stroke-width={RING_STROKE}
                  />
                  <circle
                    cx={RING_SIZE / 2}
                    cy={RING_SIZE / 2}
                    r={RING_RADIUS}
                    fill="none"
                    stroke={usagePercent() >= 100 ? 'var(--color-error)' : usagePercent() >= 80 ? 'var(--color-warning)' : 'var(--color-accent)'}
                    stroke-width={RING_STROKE}
                    stroke-dasharray={RING_CIRCUMFERENCE}
                    stroke-dashoffset={RING_CIRCUMFERENCE * (1 - usagePercent() / 100)}
                    stroke-linecap="round"
                    transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
                  />
                </svg>
                <div class="usage-ring-label">
                  <span class="usage-ring-percent">{usagePercent()}%</span>
                  <span class="usage-ring-sublabel">of monthly quota</span>
                </div>
              </div>
            </Show>

            <div class="usage-stats">
              <div class="usage-stat-card">
                <div class="usage-stat-label">Today</div>
                <div class="usage-stat-value">{formatDuration(dailySeconds())}</div>
              </div>
              <div class="usage-stat-card">
                <div class="usage-stat-label">This Month</div>
                <div class="usage-stat-value">{formatDuration(monthlySeconds())}</div>
                <Show when={hasQuota()}>
                  <div class="usage-stat-quota">of {formatDuration(quotaSeconds()!)}</div>
                </Show>
              </div>
              <div class="usage-stat-card">
                <div class="usage-stat-label">Plan</div>
                <div class="usage-stat-value usage-stat-tier">{tierName()}</div>
              </div>
            </div>

            <div class="usage-actions">
              <a href="/app/" class="usage-btn">Back to Dashboard</a>
              <a href="/app/plan" class="usage-btn usage-btn--secondary">View Plans</a>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
};

export default UsagePage;
