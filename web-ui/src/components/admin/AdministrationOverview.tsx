import { A } from '@solidjs/router';
import { Component, For } from 'solid-js';
import { useAdministration } from './AdministrationLayout';
import { environmentAreas } from './environment-areas';

const AdministrationOverview: Component = () => {
  const configuration = useAdministration();
  const areas = environmentAreas(configuration);
  const domain = configuration.sections.domain as { customDomain?: string } | undefined;

  return (
    <div class="admin-page">
      <header class="admin-page-header">
        <div>
          <p class="admin-eyebrow">Administration</p>
          <h1>Overview</h1>
          <p>Inspect deployed settings and organization usage from one operator console.</p>
        </div>
      </header>

      <section class="admin-metrics" aria-label="Deployment summary">
        <article class="admin-metric">
          <span>Deployment mode</span>
          <strong>{configuration.mode}</strong>
          <small>Effective runtime mode</small>
        </article>
        <article class="admin-metric">
          <span>Custom domain</span>
          <strong class="admin-domain-value">{domain?.customDomain || 'Not configured'}</strong>
          <small>Stored Environment value</small>
        </article>
        <article class="admin-metric">
          <span>Environment revision</span>
          <strong class="admin-mono">{configuration.revision}</strong>
          <small>{configuration.activeRunId ? 'Settings change running' : 'No active settings change'}</small>
        </article>
      </section>

      <div class="admin-overview-grid">
        <section class="admin-panel">
          <div class="admin-area-list admin-area-list-compact">
            <For each={areas.slice(0, 6)}>{(area) => (
              <A class="admin-area-row admin-area-link" href={`/admin/environment/${area.section}`}>
                <div>
                  <strong>{area.label}</strong>
                  <span>{area.summary}</span>
                </div>
                <span class={`admin-status admin-status-${area.status.toLowerCase().replace(' ', '-')}`}>{area.status}</span>
              </A>
            )}</For>
          </div>
        </section>

        <section class="admin-panel admin-usage-summary">
          <div class="admin-panel-heading">
            <div>
              <h2>Organization usage</h2>
              <p>Historical collection starts after D1 rollout.</p>
            </div>
          </div>
          <div class="admin-empty-compact">
            <strong>No historical data yet</strong>
            <p>Current personal usage and quota enforcement continue unchanged.</p>
            <A href="/admin/analytics">Open Analytics</A>
          </div>
        </section>
      </div>
    </div>
  );
};

export default AdministrationOverview;
