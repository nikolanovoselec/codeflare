import { A, useParams } from '@solidjs/router';
import { Component, Show, createResource } from 'solid-js';
import { getAdminUsageUser, type AdminUsageQuery } from '../../api/client';

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const AnalyticsUserDetail: Component = () => {
  const params = useParams<{ userKey: string }>();
  const search = new URLSearchParams(window.location.search);
  const rawPeriod = search.get('period');
  const period: AdminUsageQuery['period'] = rawPeriod === 'week' || rawPeriod === 'month' || rawPeriod === 'year' ? rawPeriod : 'day';
  const start = search.get('start') || new Date().toISOString().slice(0, period === 'month' ? 7 : period === 'year' ? 4 : 10);
  const [user, { refetch }] = createResource(() => params.userKey, (userKey) => getAdminUsageUser(userKey, period, start));

  return (
    <div class="admin-page">
      <header class="admin-page-header">
        <div>
          <p class="admin-eyebrow">Analytics user detail</p>
          <h1>{user()?.email || 'User usage'}</h1>
          <p>Named aggregate history for {start} UTC.</p>
        </div>
        <A href={`/admin/analytics?period=${period}&start=${encodeURIComponent(start)}`}>Back to Analytics</A>
      </header>
      <Show when={!user.loading} fallback={<div class="admin-state-panel"><div class="app-loading-spinner" /><p>Loading user usage…</p></div>}>
        <Show when={!user.error && user()} fallback={
          <div class="admin-state-panel"><h2>User usage unavailable</h2><p>The selected history row could not be loaded.</p><button type="button" class="admin-primary-button" onClick={() => void refetch()}>Retry</button></div>
        }>
          {(resolved) => (
            <>
              <Show when={resolved().accountStatus === 'deleted'}>
                <div class="admin-state-panel admin-deleted-history"><h2>Live account deleted</h2><p>Named aggregate usage remains until historical retention expires.</p></div>
              </Show>
              <section class="admin-metrics">
                <article class="admin-metric"><span>Accounted runtime</span><strong class="admin-mono">{duration(resolved().runtimeSeconds)}</strong><small>{resolved().start} UTC</small></article>
                <article class="admin-metric"><span>Distinct sessions</span><strong class="admin-mono">{resolved().sessionCount}</strong><small>Positive runtime only</small></article>
                <article class="admin-metric"><span>Account status</span><strong>{resolved().accountStatus}</strong><small>{resolved().deletedAt || 'Live account'}</small></article>
              </section>
              <section class="admin-panel admin-period-summary">
                <div class="admin-panel-heading"><h2>Historical record</h2></div>
                <dl>
                  <div><dt>User key</dt><dd class="admin-mono">{resolved().userKey}</dd></div>
                  <div><dt>Data available since</dt><dd class="admin-mono">{resolved().dataSince}</dd></div>
                  <div><dt>History updated</dt><dd class="admin-mono">{resolved().historyUpdatedAt}</dd></div>
                </dl>
              </section>
            </>
          )}
        </Show>
      </Show>
    </div>
  );
};

export default AnalyticsUserDetail;
