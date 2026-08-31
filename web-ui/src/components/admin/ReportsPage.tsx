import { A } from '@solidjs/router';
import { Component, For, Show, createResource, createSignal } from 'solid-js';
import { getAdminConfiguration, getUsageReportDeliveries, sendUsageReportTest } from '../../api/client';

interface ReportSettings {
  enabled?: boolean;
  recipients?: string[];
  day?: number;
  hour?: number;
  timezone?: string;
  settingsRevision?: number;
}

const ReportsPage: Component = () => {
  const [configuration] = createResource(getAdminConfiguration);
  const [history, { refetch }] = createResource(getUsageReportDeliveries);
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string>();
  const settings = () => (configuration()?.sections.usageReports || { enabled: false }) as ReportSettings;
  const sendTest = async () => {
    setSending(true);
    setSendError(undefined);
    try {
      await sendUsageReportTest();
      await refetch();
    } catch {
      setSendError('Test delivery could not be queued. Check report settings and email provider configuration.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div class="admin-page">
      <header class="admin-page-header">
        <div><p class="admin-eyebrow">Monthly distribution</p><h1>Reports</h1><p>Private monthly usage summaries with exact CSV attachments.</p></div>
        <A class="admin-secondary-button" href="/admin/environment/usageReports">Edit schedule</A>
      </header>

      <Show when={!configuration.loading} fallback={<div class="admin-state-panel"><div class="app-loading-spinner" /><p>Loading report settings…</p></div>}>
        <Show when={!configuration.error} fallback={<div class="admin-state-panel"><h2>Report settings unavailable</h2><p>Environment settings could not be loaded.</p></div>}>
          <Show when={settings().enabled} fallback={
            <div class="admin-state-panel"><h2>Monthly reports are disabled</h2><p>No scheduled messages will be created. Historical delivery records remain available below.</p><A class="admin-primary-button" href="/admin/environment/usageReports">Configure reports</A></div>
          }>
            <section class="admin-metrics">
              <article class="admin-metric"><span>Schedule</span><strong>Day {settings().day}</strong><small>{String(settings().hour).padStart(2, '0')}:00 {settings().timezone}</small></article>
              <article class="admin-metric"><span>Recipients</span><strong class="admin-mono">{settings().recipients?.length || 0}</strong><small>Private messages</small></article>
              <article class="admin-metric"><span>Settings revision</span><strong class="admin-mono">{settings().settingsRevision}</strong><small>Current schedule owner</small></article>
            </section>
            <div class="admin-report-actions">
              <button type="button" class="admin-primary-button" disabled={sending()} onClick={() => void sendTest()}>{sending() ? 'Queueing…' : 'Send test report'}</button>
              <p>Uses latest closed UTC month. Delivery continues through scheduler if this request ends early.</p>
            </div>
            <Show when={sendError()}><div class="admin-inline-error" role="alert">{sendError()}</div></Show>
          </Show>
        </Show>
      </Show>

      <section class="admin-panel">
        <div class="admin-panel-heading"><div><h2>Delivery history</h2><p>Provider acceptance only. Test and scheduled dispatches remain distinct.</p></div></div>
        <Show when={!history.loading} fallback={<div class="admin-state-panel"><div class="app-loading-spinner" /><p>Loading delivery history…</p></div>}>
          <Show when={!history.error && history()} fallback={<div class="admin-state-panel"><h2>Delivery history unavailable</h2><button type="button" class="admin-primary-button" onClick={() => void refetch()}>Retry</button></div>}>
            {(resolved) => <Show when={resolved().deliveries.length > 0} fallback={<div class="admin-state-panel"><h2>No deliveries yet</h2><p>Scheduled and test attempts will appear here.</p></div>}>
              <div class="admin-table-scroll"><table class="admin-data-table"><thead><tr><th>Kind</th><th>Month</th><th>Recipient</th><th>State</th><th>Attempts</th><th>Updated</th></tr></thead><tbody>
                <For each={resolved().deliveries}>{(delivery) => <tr><td><span class={`admin-status-badge is-${delivery.state}`}>{delivery.deliveryKind === 'test' ? 'Test' : 'Scheduled'}</span></td><td class="admin-mono">{delivery.reportMonth}</td><td>{delivery.recipient}</td><td>{delivery.state}</td><td class="admin-mono">{delivery.attempt}/3</td><td class="admin-mono">{delivery.updatedAt}</td></tr>}</For>
              </tbody></table></div>
            </Show>}
          </Show>
        </Show>
      </section>
    </div>
  );
};

export default ReportsPage;
