import { A, useParams } from '@solidjs/router';
import { Component, For, Show } from 'solid-js';
import { useAdministration } from './AdministrationLayout';
import { environmentAreas } from './environment-areas';
import type { ConfigurationSection } from '../../types';

const EnvironmentIndex: Component = () => {
  const configuration = useAdministration();
  const areas = environmentAreas(configuration);

  return (
    <div class="admin-page">
      <header class="admin-page-header">
        <div>
          <p class="admin-eyebrow">Environment settings</p>
          <h1>Environment</h1>
          <p>Open one bounded area. Review and Apply never rerun unrelated Setup work.</p>
        </div>
        <span class="admin-revision">Revision <strong class="admin-mono">{configuration.revision}</strong></span>
      </header>

      <section class="admin-panel">
        <div class="admin-panel-heading">
          <div>
            <h2>Environment areas</h2>
            <p>Values come from their current authoritative owners.</p>
          </div>
        </div>
        <div class="admin-area-list">
          <For each={areas}>{(area) => (
            <A class="admin-area-row admin-area-link" href={`/admin/environment/${area.section}`}>
              <div>
                <strong>{area.label}</strong>
                <span>{area.summary}</span>
              </div>
              <div class="admin-area-action">
                <span class={`admin-status admin-status-${area.status.toLowerCase().replace(' ', '-')}`}>{area.status}</span>
                <span>Open</span>
              </div>
            </A>
          )}</For>
        </div>
      </section>
    </div>
  );
};

export const EnvironmentAreaDetail: Component = () => {
  const configuration = useAdministration();
  const params = useParams<{ section: string }>();
  const area = () => environmentAreas(configuration).find((item) => item.section === params.section);
  const latest = () => configuration.latest[params.section as ConfigurationSection];

  return (
    <Show
      when={area()}
      fallback={
        <div class="admin-page">
          <div class="admin-state-panel">
            <h1>Environment area unavailable</h1>
            <p>This area does not apply to the current deployment mode.</p>
            <A href="/admin/environment">Back to Environment</A>
          </div>
        </div>
      }
    >
      {(resolved) => (
        <div class="admin-page">
          <header class="admin-page-header">
            <div>
              <p class="admin-eyebrow">Environment area</p>
              <h1>{resolved().label}</h1>
              <p>{resolved().summary}</p>
            </div>
            <A href="/admin/environment">Back to Environment</A>
          </header>
          <section class="admin-panel">
            <div class="admin-panel-heading">
              <div>
                <h2>Current configuration</h2>
                <p>Read-only until bounded Review changes and Apply are available.</p>
              </div>
              <span class={`admin-status admin-status-${resolved().status.toLowerCase().replace(' ', '-')}`}>{resolved().status}</span>
            </div>
            <pre class="admin-configuration-value">{JSON.stringify(configuration.sections[resolved().section] ?? {}, null, 2)}</pre>
          </section>
          <Show when={latest()}>
            <section class="admin-panel">
              <div class="admin-panel-heading"><h2>Latest settings change</h2></div>
              <pre class="admin-configuration-value">{JSON.stringify(latest(), null, 2)}</pre>
            </section>
          </Show>
        </div>
      )}
    </Show>
  );
};

export default EnvironmentIndex;
