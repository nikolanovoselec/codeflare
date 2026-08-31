import { Component, For, Show, createResource, createSignal } from 'solid-js';
import { getConfigurationRuns, type ConfigurationRun } from '../../api/client';

const sectionLabels: Record<ConfigurationRun['section'], string> = {
  access: 'Access', domain: 'Domain', aiRouting: 'AI routing', codingAgents: 'Coding agents',
  browserRendering: 'Browser Run', securityEgress: 'Security and egress', dataGovernance: 'Data governance',
  managedEnvironment: 'Managed environment', github: 'GitHub', cloudflareConnection: 'Cloudflare connection',
  usageReports: 'Usage reports',
};

const ActivityPage: Component = () => {
  const [cursor, setCursor] = createSignal('');
  const [activity, { refetch }] = createResource(cursor, (value) => getConfigurationRuns(value || undefined));
  const [expanded, setExpanded] = createSignal<string>();

  return (
    <div class="admin-page">
      <header class="admin-page-header">
        <div><p class="admin-eyebrow">Environment history</p><h1>Activity</h1><p>Sanitized settings changes retained for 90 days.</p></div>
        <button type="button" class="admin-secondary-button" onClick={() => void refetch()}>Refresh</button>
      </header>
      <Show when={!activity.loading} fallback={<div class="admin-state-panel"><div class="app-loading-spinner" /><p>Loading Activity…</p></div>}>
        <Show when={!activity.error && activity()} fallback={<div class="admin-state-panel"><h2>Activity unavailable</h2><p>Settings history could not be loaded.</p><button type="button" class="admin-primary-button" onClick={() => void refetch()}>Retry</button></div>}>
          {(resolved) => <Show when={resolved().items.length > 0} fallback={<div class="admin-state-panel"><h2>No retained changes</h2><p>Activity starts empty. Completed records expire after 90 days.</p></div>}>
            <section class="admin-activity-list" aria-label="Environment change history">
              <For each={resolved().items}>{(run) => (
                <article class="admin-activity-item">
                  <button type="button" class="admin-activity-summary" aria-expanded={expanded() === run.runId} onClick={() => setExpanded(expanded() === run.runId ? undefined : run.runId)}>
                    <span class={`admin-run-state is-${run.state}`}>{run.state}</span>
                    <span><strong>{sectionLabels[run.section]}</strong><small>{run.initiatedBy}</small></span>
                    <span class="admin-mono">{run.createdAt}</span>
                    <span class="admin-mono">r{run.baseRevision}{run.resultingRevision !== undefined ? ` → r${run.resultingRevision}` : ''}</span>
                  </button>
                  <Show when={expanded() === run.runId}>
                    <div class="admin-activity-detail">
                      <Show when={run.error}><div class="admin-inline-error"><strong>{run.error?.message}</strong><Show when={run.error?.operatorAction}><p>{run.error?.operatorAction}</p></Show></div></Show>
                      <ol><For each={run.tasks}>{(task) => <li><span class={`admin-run-state is-${task.state}`}>{task.state}</span><span>{task.id}</span><Show when={task.error}><small>{task.error?.message}</small></Show></li>}</For></ol>
                    </div>
                  </Show>
                </article>
              )}</For>
            </section>
            <Show when={resolved().nextCursor}><div class="admin-form-actions"><button type="button" class="admin-secondary-button" onClick={() => setCursor(resolved().nextCursor || '')}>Older changes</button></div></Show>
            <Show when={cursor()}><div class="admin-form-actions"><button type="button" class="admin-secondary-button" onClick={() => setCursor('')}>Back to newest</button></div></Show>
          </Show>}
        </Show>
      </Show>
    </div>
  );
};

export default ActivityPage;
