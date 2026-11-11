import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type Component } from 'solid-js';
import { getSessions } from '../api/client';
import { sessionStore } from '../stores/session';
import type { Session, SessionStatus } from '../types';
import '../styles/operator-run-settings.css';

type WorkspaceProjection = Pick<Session, 'id' | 'lifecycle' | 'generation'> & { status?: SessionStatus };
function running<T extends WorkspaceProjection>(value: T | undefined): value is T & { generation: number } {
  return !!value && /^[a-z0-9]{8,24}$/.test(value.id) && value.status === 'running'
    && (value.lifecycle === undefined || value.lifecycle === 'running')
    && Number.isSafeInteger(value.generation) && value.generation! > 0;
}

/** Uses the existing owner-scoped D1 catalog only. No workspace lifecycle writes. */
export function createRunWorkspace(enabled: () => boolean = () => true) {
  const active = () => {
    const value = sessionStore.getActiveSession();
    return !sessionStore.statusUnavailable && running(value) ? value : undefined;
  };
  const [selected, setSelected] = createSignal<{ id: string; generation: number }>();
  createEffect(() => {
    active()?.id; active()?.generation;
    setSelected(undefined);
  });
  const [catalog, { refetch }] = createResource(() => enabled() && !active(), async () => getSessions());
  const options = () => catalog.error ? [] : (catalog() ?? []).filter(running).filter(value => {
    const observed = (sessionStore.sessions ?? []).find(item => item.id === value.id);
    return !observed || running(observed) && observed.generation === value.generation;
  });
  const storeScope = createMemo(() => JSON.stringify((sessionStore.sessions ?? []).map(value =>
    [value.id, value.generation, value.status, value.lifecycle, value.revision])));
  let previousStoreScope = storeScope();
  createEffect(() => {
    const next = storeScope();
    if (next !== previousStoreScope) { previousStoreScope = next; setSelected(undefined); }
  });
  createEffect(() => {
    if (catalog.loading || catalog.error) return;
    const chosen = selected();
    if (chosen && !options().some(value => value.id === chosen.id && value.generation === chosen.generation)) setSelected(undefined);
  });
  const session = () => {
    if (!enabled() || sessionStore.statusUnavailable) return undefined;
    const current = active();
    if (current) return current;
    if (catalog.loading || catalog.error) return undefined;
    const chosen = selected();
    if (!chosen) return undefined;
    return options().find(value => value.id === chosen.id && value.generation === chosen.generation);
  };
  const scope = () => JSON.stringify([session()?.id, session()?.generation, active()?.id,
    sessionStore.statusUnavailable, catalog.loading, !!catalog.error,
    (catalog.error ? [] : catalog() ?? []).map(value => [value.id, value.generation, value.status, value.lifecycle]), storeScope()]);
  const choose = (id: string) => {
    const value = options().find(value => value.id === id);
    setSelected(value ? { id: value.id, generation: value.generation } : undefined);
  };
  let alive = true;
  onCleanup(() => { alive = false; });
  return { active, session, scope, options, choose, selected, catalog,
    refresh: () => { if (alive) void refetch(); } };
}

export const RunWorkspaceField: Component<{ workspace: ReturnType<typeof createRunWorkspace> }> = props =>
  <div class="operator-run-workspace">
    <p class="admin-help-text">Start automatic runs only for your selected running workspace session. Saving and enabling never activate a schedule; authority ends at the original Access expiry.</p>
    <Show when={props.workspace.active()} fallback={<>
      <label class="admin-form-field">Running workspace<select value={props.workspace.selected()?.id ?? ''}
        disabled={props.workspace.catalog.loading || !!props.workspace.catalog.error || sessionStore.statusUnavailable}
        onChange={event => props.workspace.choose(event.currentTarget.value)}>
        <option value="">Choose a running workspace</option>
        <For each={props.workspace.options()}>{value => <option value={value.id}>{value.name || 'Unnamed workspace'}</option>}</For>
      </select></label>
      <button type="button" class="admin-secondary-button" disabled={props.workspace.catalog.loading} onClick={() => props.workspace.refresh()}>Refresh workspaces</button>
      <Show when={props.workspace.catalog.loading}><p role="status">Loading owned running workspaces…</p></Show>
      <Show when={props.workspace.catalog.error || sessionStore.statusUnavailable}><p role="status">Workspace catalog unavailable. Refresh before starting automatic runs.</p></Show>
    </>}>
      {value => <p class="admin-help-text">Current running workspace: {value().name || 'Unnamed workspace'}</p>}
    </Show>
  </div>;
