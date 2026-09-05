/* v8 ignore start -- user-validated administration UI */
import { A, useParams } from '@solidjs/router';
import { mdiChevronRight } from '@mdi/js';
import { Component, For, Show, createSignal } from 'solid-js';
import Icon from '../Icon';
import { useAdministration } from './AdministrationLayout';
import { environmentAreas, filterEnvironmentAreas } from './environment-areas';
import {
  ConfigurationRequestError,
  getConfigurationRun,
  previewConfiguration,
  startConfigurationRun,
  type ConfigurationPreview,
  type ConfigurationRun,
} from '../../api/client';
import EnvironmentAreaFields, { environmentValues } from './EnvironmentAreaFields';
import { environmentContext, executionOutcome, operatorTaskLabel } from './administration-presentation';

function changeValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return 'Not configured';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (field === 'groupRouting') return value.map((item) => {
      const group = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      const routes = Array.isArray(group.routes) ? group.routes.join(', ') : 'none';
      return `${String(group.accessGroup ?? 'Group')}: ${routes}; default ${String(group.defaultRoute ?? 'none')} (${String(group.reasoning ?? 'off')})`;
    }).join(' · ');
    return value.map(String).join(', ');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (field === 'routeContextWindows') return entries.map(([route, tokens]) => `${route}: ${String(tokens)} tokens`).join(' · ');
    if (field === 'reasoningConfiguration') {
      const assignments = (value as Record<string, unknown>).routeAssignments;
      if (assignments && typeof assignments === 'object' && !Array.isArray(assignments)) {
        return Object.entries(assignments as Record<string, unknown>).map(([route, assignment]) => {
          const activeProfile = assignment && typeof assignment === 'object' ? (assignment as Record<string, unknown>).activeProfile : undefined;
          const ref = activeProfile && typeof activeProfile === 'object' ? activeProfile as Record<string, unknown> : {};
          return `${route}: ${String(ref.id ?? 'unassigned')} revision ${String(ref.revision ?? 'unknown')}`;
        }).join(' · ');
      }
    }
    return entries.map(([key, item]) => `${key}: ${typeof item === 'object' ? 'updated' : String(item)}`).join(' · ');
  }
  return String(value);
}

const EnvironmentIndex: Component = () => {
  const configuration = useAdministration();
  const areas = environmentAreas(configuration);
  const [search, setSearch] = createSignal('');
  const filteredAreas = () => filterEnvironmentAreas(areas, search());

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
          <label class="admin-environment-search"><span>Find an area</span><input type="search" value={search()} onInput={(event) => setSearch(event.currentTarget.value)} placeholder="Search Environment" /></label>
        </div>
        <Show when={filteredAreas().length > 0} fallback={<div class="admin-state-panel"><h2>No matching areas</h2><p>Try another name, setting, or saved value.</p></div>}>
          <div class="admin-area-list">
            <For each={filteredAreas()}>{(area) => (
              <A class="admin-area-row admin-area-link" href={`/admin/environment/${area.section}`}>
                <div>
                  <strong>{area.label}</strong>
                  <span>{area.summary}</span>
                </div>
                <div class="admin-area-action">
                  <span class={`admin-status admin-status-${area.status.toLowerCase().replace(' ', '-')}`}>{area.status}</span>
                  <Icon path={mdiChevronRight} size={18} aria-hidden="true" />
                </div>
              </A>
            )}</For>
          </div>
        </Show>
      </section>
    </div>
  );
};

export const EnvironmentAreaDetail: Component = () => {
  const configuration = useAdministration();
  const params = useParams<{ section: string }>();
  const area = () => environmentAreas(configuration).find((item) => item.section === params.section);
  const [preview, setPreview] = createSignal<ConfigurationPreview>();
  const [submittedValues, setSubmittedValues] = createSignal<unknown>();
  const [run, setRun] = createSignal<ConfigurationRun>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [confirmedWarnings, setConfirmedWarnings] = createSignal<string[]>([]);

  const review = async (event: SubmitEvent) => {
    event.preventDefault();
    const section = area()?.section;
    if (!section) return;
    setBusy(true); setError(undefined);
    try {
      const values = environmentValues(section, configuration.mode, new FormData(event.currentTarget as HTMLFormElement));
      setSubmittedValues(values);
      setConfirmedWarnings([]);
      setPreview(await previewConfiguration(section, configuration.revision, values));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Environment values are invalid.');
    } finally { setBusy(false); }
  };

  const apply = async () => {
    const section = area()?.section;
    if (!section || !submittedValues()) return;
    setBusy(true); setError(undefined);
    try {
      const response = await startConfigurationRun(section, configuration.revision, submittedValues(), confirmedWarnings());
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Configuration stream was unavailable');
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const chunk = await reader.read();
        buffer += decoder.decode(chunk.value, { stream: !chunk.done });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line) continue;
          const event = JSON.parse(line) as { type?: string; run?: ConfigurationRun };
          if (event.type === 'snapshot' && event.run) setRun(event.run);
        }
        if (chunk.done) break;
      }
    } catch (reason) {
      if (reason instanceof ConfigurationRequestError && reason.status === 409) {
        setError(`${reason.message}. Reload current settings before applying again.`);
      } else setError(reason instanceof Error ? reason.message : 'Settings change failed.');
    } finally { setBusy(false); }
  };

  const reconnect = async () => {
    if (!configuration.activeRunId) return;
    setBusy(true); setError(undefined);
    try { setRun(await getConfigurationRun(configuration.activeRunId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Active settings change could not be reconnected.'); }
    finally { setBusy(false); }
  };

  return <Show when={area()} fallback={<div class="admin-page"><div class="admin-state-panel"><h1>Environment area unavailable</h1><p>This area does not apply to the current deployment mode.</p><A href="/admin/environment">Back to Environment</A></div></div>}>
    {(resolved) => <div class="admin-page">
      <header class="admin-page-header"><div><p class="admin-eyebrow">Environment area</p><h1>{resolved().label}</h1><p>{resolved().summary}</p></div><A href="/admin/environment">Back to Environment</A></header>
      <Show when={configuration.activeRunId && !run()}><div class="admin-state-panel admin-conflict-panel"><h2>Settings change active</h2><p>Reconnect to the persisted run before starting another change.</p><button type="button" class="admin-primary-button" disabled={busy()} onClick={() => void reconnect()}>Reconnect</button></div></Show>
      <Show when={error()}><div class="admin-inline-error" role="alert">{error()}</div></Show>
      <Show when={!preview() && !run()}>
        <form class="admin-panel admin-environment-form" onSubmit={(event) => void review(event)}>
          <div class="admin-panel-heading"><div><h2>Edit current settings</h2><p>Blank secret fields preserve their stored value.</p></div><span class="admin-revision">Revision <strong class="admin-mono">{configuration.revision}</strong></span></div>
          <div class="admin-editor-layout">
            <EnvironmentAreaFields section={resolved().section} mode={configuration.mode} current={configuration.sections[resolved().section]} />
            <aside class="admin-editor-context">
              <h3>Before you apply</h3>
              <dl>
                <div><dt>Current source</dt><dd>{environmentContext(resolved().section).source}</dd></div>
                <div><dt>Operation</dt><dd>{environmentContext(resolved().section).operation}</dd></div>
                <div><dt>Effect</dt><dd>{environmentContext(resolved().section).effect}</dd></div>
              </dl>
            </aside>
          </div>
          <div class="admin-form-actions"><button type="submit" class="admin-primary-button" disabled={busy() || Boolean(configuration.activeRunId)}>{busy() ? 'Reviewing…' : 'Review changes'}</button></div>
        </form>
      </Show>
      <Show when={!run() ? preview() : undefined}>{(reviewed) => <section class="admin-panel">
        <div class="admin-panel-heading"><div><h2>Review changes</h2><p>Only tasks listed below will run.</p></div></div>
        <Show when={reviewed().changes.length > 0} fallback={<div class="admin-state-panel"><h3>No changes detected</h3><p>Return to edit before applying.</p></div>}>
          <dl class="admin-change-list"><For each={reviewed().changes}>{(change) => <div><dt>{change.field}</dt><dd>{change.secret ? (change.secret.willReplace ? 'Replace saved secret' : 'Preserve saved secret') : changeValue(change.field, change.after)}</dd></div>}</For></dl>
          <h3>Execution plan</h3><ol class="admin-task-plan"><For each={reviewed().tasks}>{(task) => <li>{operatorTaskLabel(task.id)}</li>}</For></ol>
          <For each={reviewed().warnings}>{(warning) => <label class="admin-warning-confirmation"><input type="checkbox" checked={confirmedWarnings().includes(warning.code)} onChange={(event) => setConfirmedWarnings((codes) => event.currentTarget.checked ? [...codes, warning.code] : codes.filter((code) => code !== warning.code))} /><span><strong>Confirm warning</strong>{warning.message}</span></label>}</For>
          <details class="admin-technical-details">
            <summary>Technical details</summary>
            <dl>
              <div><dt>Task IDs</dt><dd class="admin-mono">{reviewed().tasks.map((task) => task.id).join(', ')}</dd></div>
              <div><dt>Excluded setup work</dt><dd class="admin-mono">{reviewed().exclusions.join(', ') || 'None'}</dd></div>
            </dl>
          </details>
          <div class="admin-form-actions"><button type="button" class="admin-secondary-button" onClick={() => { setPreview(undefined); setConfirmedWarnings([]); }}>Back to edit</button><button type="button" class="admin-primary-button" disabled={busy() || reviewed().warnings.some((warning) => !confirmedWarnings().includes(warning.code))} onClick={() => void apply()}>{busy() ? 'Applying…' : 'Apply change'}</button></div>
        </Show>
      </section>}</Show>
      <Show when={run()}>{(currentRun) => <section class="admin-panel">
        <div class="admin-panel-heading"><div><h2>Execution {currentRun().state}</h2><p>Only the reviewed Environment area was changed.</p></div><span class={`admin-run-state is-${currentRun().state}`}>{currentRun().state}</span></div>
        <Show when={currentRun().state === 'succeeded' && currentRun().resultingRevision !== undefined}>
          <div class="admin-execution-outcome">
            <strong>{executionOutcome(currentRun().section, currentRun().resultingRevision!)}</strong>
            <Show when={preview()?.changes.length}><dl class="admin-change-list"><For each={preview()?.changes}>{(change) => <div><dt>{change.field}</dt><dd>{change.secret ? (change.secret.willReplace ? 'Saved secret replaced' : 'Saved secret preserved') : changeValue(change.field, change.after)}</dd></div>}</For></dl></Show>
          </div>
        </Show>
        <ol class="admin-task-plan"><For each={currentRun().tasks}>{(task) => <li><span class={`admin-run-state is-${task.state}`}>{task.state}</span> {operatorTaskLabel(task.id)}<Show when={task.error}><small>{task.error?.message}</small></Show></li>}</For></ol>
        <Show when={currentRun().error}><div class="admin-inline-error"><strong>{currentRun().error?.message}</strong><p>{currentRun().error?.operatorAction}</p></div></Show>
        <details class="admin-technical-details">
          <summary>Technical details</summary>
          <dl>
            <div><dt>Run ID</dt><dd class="admin-mono">{currentRun().runId}</dd></div>
            <div><dt>Task IDs</dt><dd class="admin-mono">{currentRun().tasks.map((task) => task.id).join(', ')}</dd></div>
          </dl>
        </details>
        <Show when={['succeeded','failed','interrupted'].includes(currentRun().state)}><div class="admin-form-actions"><button type="button" class="admin-primary-button" onClick={() => window.location.reload()}>Reload current settings</button></div></Show>
      </section>}</Show>
    </div>}
  </Show>;
};

export default EnvironmentIndex;
/* v8 ignore stop */
