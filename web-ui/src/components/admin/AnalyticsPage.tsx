/* v8 ignore start -- user-validated administration UI */
import { A } from '@solidjs/router';
import { Component, For, Show, createResource, createSignal } from 'solid-js';
import { getAdminUsage, type AdminUsageQuery, type AdminUsageUser } from '../../api/client';

const periods: AdminUsageQuery['period'][] = ['day', 'week', 'month', 'year'];

function currentStart(period: AdminUsageQuery['period']): string {
  const now = new Date();
  if (period === 'day') return now.toISOString().slice(0, 10);
  if (period === 'month') return now.toISOString().slice(0, 7);
  if (period === 'year') return String(now.getUTCFullYear());
  const day = now.getUTCDay() || 7;
  now.setUTCDate(now.getUTCDate() - day + 1);
  return now.toISOString().slice(0, 10);
}

function duration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

interface UsageSeriesPoint {
  start: string;
  runtimeSeconds: number;
  sessionCount: number;
  historyUpdatedAt: string;
}

const UsageChart: Component<{ series: UsageSeriesPoint[] }> = (props) => {
  const maximum = () => Math.max(1, ...props.series.map((point) => point.runtimeSeconds));
  const slot = () => 560 / Math.max(1, props.series.length);
  const width = () => Math.max(4, Math.min(32, slot() - 8));
  const x = (index: number) => 48 + index * slot() + (slot() - width()) / 2;
  const height = (seconds: number) => seconds === 0 ? 0 : Math.max(2, seconds / maximum() * 104);

  return <div class="admin-measurement-chart">
    <svg viewBox="0 0 640 180" role="img" aria-label="Accounted runtime history">
      <line x1="48" y1="140" x2="608" y2="140" class="admin-chart-axis" />
      <For each={props.series}>{(point, index) => {
        const barHeight = () => height(point.runtimeSeconds);
        return <rect x={x(index())} y={140 - barHeight()} width={width()} height={barHeight()} class="admin-chart-bar">
          <title>{point.start}: {duration(point.runtimeSeconds)} across {point.sessionCount} sessions</title>
        </rect>;
      }}</For>
      <Show when={props.series.length > 0}>
        <text x="48" y="164">{props.series[0].start}</text>
        <Show when={props.series.length > 1}><text x="608" y="164" text-anchor="end">{props.series.at(-1)?.start}</text></Show>
      </Show>
    </svg>
    <table class="admin-visually-hidden"><caption>Accounted runtime history</caption><tbody><For each={props.series}>{(point) => <tr><th>{point.start}</th><td>{duration(point.runtimeSeconds)}</td><td>{point.sessionCount} sessions</td></tr>}</For></tbody></table>
  </div>;
};

const AnalyticsPage: Component = () => {
  const [draftPeriod, setDraftPeriod] = createSignal<AdminUsageQuery['period']>('day');
  const [draftStart, setDraftStart] = createSignal(currentStart('day'));
  const [query, setQuery] = createSignal<AdminUsageQuery>({
    period: 'day', start: currentStart('day'), sort: 'runtimeSeconds', direction: 'desc', limit: 50,
  });
  const [usage, { refetch }] = createResource(query, getAdminUsage);

  const apply = () => setQuery({ ...query(), period: draftPeriod(), start: draftStart(), cursor: undefined });
  const changePeriod = (period: AdminUsageQuery['period']) => {
    setDraftPeriod(period);
    setDraftStart(currentStart(period));
  };
  const sort = (field: NonNullable<AdminUsageQuery['sort']>) => {
    const current = query();
    setQuery({
      ...current,
      sort: field,
      direction: current.sort === field && current.direction === 'desc' ? 'asc' : 'desc',
      cursor: undefined,
    });
  };
  const exportHref = () => {
    const current = query();
    return `/api/admin/usage?period=${current.period}&start=${encodeURIComponent(current.start)}&sort=${current.sort}&direction=${current.direction}&format=csv`;
  };
  const exportFilename = () => `codeflare-usage-${query().period}-${query().start}.csv`;

  return (
    <div class="admin-page admin-analytics-page">
      <header class="admin-page-header">
        <div>
          <p class="admin-eyebrow">Organization usage</p>
          <h1>Analytics</h1>
          <p>Accounted runtime and distinct positive-runtime sessions in UTC.</p>
        </div>
      </header>

      <form class="admin-filter-bar" onSubmit={(event) => { event.preventDefault(); apply(); }}>
        <div class="admin-segmented" role="group" aria-label="Usage period">
          <For each={periods}>{(period) => (
            <button type="button" classList={{ 'is-active': draftPeriod() === period }} onClick={() => changePeriod(period)}>{period}</button>
          )}</For>
        </div>
        <label>
          <span>UTC period start</span>
          <input value={draftStart()} onInput={(event) => setDraftStart(event.currentTarget.value)} />
        </label>
        <button type="submit" class="admin-primary-button">Apply filters</button>
        <a class="admin-secondary-button" href={exportHref()} download={exportFilename()}>Export CSV</a>
      </form>

      <Show when={!usage.loading} fallback={<div class="admin-state-panel"><div class="app-loading-spinner" /><p>Loading organization usage…</p></div>}>
        <Show when={!usage.error && usage()} fallback={
          <div class="admin-state-panel">
            <h2>Analytics unavailable</h2>
            <p>Historical usage could not be loaded. Personal usage remains available.</p>
            <button type="button" class="admin-primary-button" onClick={() => void refetch()}>Retry</button>
          </div>
        }>
          {(resolved) => (
            <Show when={resolved().dataSince} fallback={
              <div class="admin-state-panel">
                <h2>No historical usage yet</h2>
                <p>No {query().period} history is available for {query().start} UTC. Collection starts with the first successful accounting write; existing totals are not backfilled.</p>
              </div>
            }>
              <section class="admin-metrics" aria-label="Usage summary">
                <article class="admin-metric"><span>Accounted runtime</span><strong class="admin-mono">{duration(resolved().summary.runtimeSeconds)}</strong><small>{resolved().start} UTC</small></article>
                <article class="admin-metric"><span>Active users</span><strong class="admin-mono">{resolved().summary.activeUsers}</strong><small>Positive runtime in period</small></article>
                <article class="admin-metric"><span>Distinct sessions</span><strong class="admin-mono">{resolved().summary.sessionCount}</strong><small>Across active users</small></article>
              </section>

              <div class="admin-analytics-grid">
                <section class="admin-panel">
                  <div class="admin-panel-heading"><div><h2>Accounted runtime history</h2><p>Actual organization totals from existing D1 period aggregates.</p></div></div>
                  <UsageChart series={resolved().series} />
                </section>
                <aside class="admin-panel admin-period-summary">
                  <div class="admin-panel-heading"><div><h2>Data freshness</h2><p>Historical D1 snapshots can lag live Timekeeper usage. The timestamp below is the newest row returned, not a global synchronization guarantee.</p></div></div>
                  <dl>
                    <div><dt>Data available since</dt><dd class="admin-mono">{resolved().dataSince}</dd></div>
                    <div><dt>History updated</dt><dd class="admin-mono">{resolved().historyUpdatedAt || 'No row update'}</dd></div>
                    <div><dt>Timezone</dt><dd>UTC</dd></div>
                  </dl>
                </aside>
              </div>

              <section class="admin-panel">
                <div class="admin-panel-heading"><div><h2>User ranking</h2><p>Deleted users remain named until retention expires.</p></div></div>
                <div class="admin-table-scroll">
                  <table class="admin-data-table">
                    <thead><tr>
                      <th><button type="button" onClick={() => sort('email')}>User</button></th>
                      <th>Status</th>
                      <th><button type="button" onClick={() => sort('runtimeSeconds')}>Runtime</button></th>
                      <th><button type="button" onClick={() => sort('sessionCount')}>Sessions</button></th>
                      <th>Data since</th>
                    </tr></thead>
                    <tbody><For each={resolved().users}>{(user: AdminUsageUser) => (
                      <tr>
                        <td><A href={`/admin/analytics/users/${user.userKey}?period=${resolved().period}&start=${encodeURIComponent(resolved().start)}`}>{user.email}</A></td>
                        <td><span class={`admin-status admin-status-${user.accountStatus === 'active' ? 'enabled' : 'disabled'}`}>{user.accountStatus}</span></td>
                        <td class="admin-mono">{duration(user.runtimeSeconds)}</td>
                        <td class="admin-mono">{user.sessionCount}</td>
                        <td class="admin-mono">{user.dataSince}</td>
                      </tr>
                    )}</For></tbody>
                  </table>
                </div>
                <Show when={resolved().nextCursor}>{(cursor) => (
                  <div class="admin-table-actions"><button type="button" class="admin-secondary-button" onClick={() => setQuery({ ...query(), cursor: cursor() })}>Load next 50 users</button></div>
                )}</Show>
              </section>
            </Show>
          )}
        </Show>
      </Show>
    </div>
  );
};

export default AnalyticsPage;
/* v8 ignore stop */
