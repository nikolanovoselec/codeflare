import { A, useParams } from '@solidjs/router';
import { Component, For, Show, createSignal } from 'solid-js';
import { useAdministration } from './AdministrationLayout';
import { environmentAreas } from './environment-areas';
import type { ConfigurationSection } from '../../types';
import {
  ConfigurationRequestError,
  getConfigurationRun,
  previewConfiguration,
  startConfigurationRun,
  type ConfigurationPreview,
  type ConfigurationRun,
} from '../../api/client';
import EnvironmentAreaFields, { environmentValues } from './EnvironmentAreaFields';

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
  const [preview, setPreview] = createSignal<ConfigurationPreview>();
  const [submittedValues, setSubmittedValues] = createSignal<unknown>();
  const [run, setRun] = createSignal<ConfigurationRun>();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();

  const review = async (event: SubmitEvent) => {
    event.preventDefault();
    const section = area()?.section;
    if (!section) return;
    setBusy(true); setError(undefined);
    try {
      const values = environmentValues(section, configuration.mode, new FormData(event.currentTarget as HTMLFormElement));
      setSubmittedValues(values);
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
      const response = await startConfigurationRun(section, configuration.revision, submittedValues());
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
          <EnvironmentAreaFields section={resolved().section} mode={configuration.mode} current={configuration.sections[resolved().section]} />
          <div class="admin-form-actions"><button type="submit" class="admin-primary-button" disabled={busy() || Boolean(configuration.activeRunId)}>{busy() ? 'Reviewing…' : 'Review changes'}</button></div>
        </form>
      </Show>
      <Show when={!run() ? preview() : undefined}>{(reviewed) => <section class="admin-panel">
        <div class="admin-panel-heading"><div><h2>Review changes</h2><p>Only tasks listed below will run.</p></div></div>
        <Show when={reviewed().changes.length > 0} fallback={<div class="admin-state-panel"><h3>No changes detected</h3><p>Return to edit before applying.</p></div>}>
          <dl class="admin-change-list"><For each={reviewed().changes}>{(change) => <div><dt>{change.field}</dt><dd>{change.secret ? (change.secret.willReplace ? 'Replace saved secret' : 'Preserve saved secret') : JSON.stringify(change.after)}</dd></div>}</For></dl>
          <h3>Execution plan</h3><ol class="admin-task-plan"><For each={reviewed().tasks}>{(task) => <li>{task.id}</li>}</For></ol>
          <For each={reviewed().warnings}>{(warning) => <div class="admin-inline-error">{warning.message}</div>}</For>
          <p class="admin-exclusions">Excluded: {reviewed().exclusions.join(', ')}</p>
          <div class="admin-form-actions"><button type="button" class="admin-secondary-button" onClick={() => setPreview(undefined)}>Back to edit</button><button type="button" class="admin-primary-button" disabled={busy()} onClick={() => void apply()}>{busy() ? 'Applying…' : 'Apply change'}</button></div>
        </Show>
      </section>}</Show>
      <Show when={run()}>{(currentRun) => <section class="admin-panel">
        <div class="admin-panel-heading"><div><h2>Execution {currentRun().state}</h2><p>Run <span class="admin-mono">{currentRun().runId}</span></p></div><span class={`admin-run-state is-${currentRun().state}`}>{currentRun().state}</span></div>
        <ol class="admin-task-plan"><For each={currentRun().tasks}>{(task) => <li><span class={`admin-run-state is-${task.state}`}>{task.state}</span> {task.id}<Show when={task.error}><small>{task.error?.message}</small></Show></li>}</For></ol>
        <Show when={currentRun().error}><div class="admin-inline-error"><strong>{currentRun().error?.message}</strong><p>{currentRun().error?.operatorAction}</p></div></Show>
        <Show when={['succeeded','failed','interrupted'].includes(currentRun().state)}><div class="admin-form-actions"><button type="button" class="admin-primary-button" onClick={() => window.location.reload()}>Reload current settings</button></div></Show>
      </section>}</Show>
    </div>}
  </Show>;
};

export default EnvironmentIndex;
