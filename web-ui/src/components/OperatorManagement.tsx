import { For, Show, createEffect, createSignal, onCleanup, untrack, type Component, type JSX } from 'solid-js';
import { mdiLayersSearch } from '@mdi/js';
import * as api from '../api/operator-management';
import { ApiError, apiErrorMessage } from '../api/fetch-helper';
import OperatorManagementActivity from './OperatorManagementActivity';
import '../styles/administration.css';
import '../styles/ai-routing-workspace.css';
import '../styles/settings-panel.css';
import '../styles/operator-management.css';

export interface OperatorManagementProps { userEmail?: string; isAdmin?: boolean }
const emptyGrant = (): api.ManagementGrant => ({ users: [], groups: [] });
const emptyPolicy = (): api.ManagementPolicy => ({ capabilities: [], resourceProfileId: null });
const sourceBytes = (value?: number) => value ?? api.DEFAULT_SOURCE_RESPONSE_BYTES;
const inferenceBytes = (value?: number) => value ?? api.DEFAULT_INFERENCE_REQUEST_BYTES;
const validInferenceBytes = (value?: number) => Number.isSafeInteger(inferenceBytes(value)) && inferenceBytes(value) >= 1;
const validSourceBytes = (value: number | undefined, ceiling: number) => Number.isInteger(sourceBytes(value)) && sourceBytes(value) >= 1 && sourceBytes(value) <= ceiling;
const sourceResponseHelp = 'Includes the HTTP envelope: response body and headers. Does not change request, inference, final-output or SDK history limits.';
const SourceResponseField: Component<{ label: string; value?: number; max: number; onChange: (value: number) => void }> = props =>
  <label class="admin-form-field"><span>{props.label}</span><input aria-label={props.label} type="number" required min="1" step="1" max={props.max}
    value={Number.isFinite(sourceBytes(props.value)) ? sourceBytes(props.value) : ''} onInput={event => props.onChange(event.currentTarget.valueAsNumber)} />
    <small>{sourceResponseHelp} Current upper limit: {props.max} bytes.</small></label>;
const lines = (value: string) => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
const name = (operator: api.ManagementSummary) => {
  if (operator.name === 'Conductor Review' && operator.profile === 'conductor' && operator.repositoryId === 1380652764
    && operator.repositoryUrl === 'https://github.com/nikolanovoselec/codeflare-operator-conductor') return 'Pull Request Reviewer';
  if (operator.name === 'Renovate Dispatcher' && operator.profile === 'dispatcher' && operator.repositoryId === 1380652724
    && operator.repositoryUrl === 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher') return 'Renovate Manager';
  return operator.name ?? operator.repositoryUrl ?? operator.id;
};
const category = (operator: api.ManagementSummary) => operator.profile === 'conductor' ? 'Conductor' : 'Dispatcher';
const releaseLabel = (release: api.ManagementRelease) => release.tagName ?? release.version ?? `GitHub release #${release.githubReleaseId}`;
const published = (date: string) => new Date(date).toLocaleString(undefined, { timeZone: 'UTC', timeZoneName: 'short' });
const releaseDisplay = (release: api.ManagementRelease) => `${releaseLabel(release)}${release.publishedAt ? ` · Published ${published(release.publishedAt)}` : ''}`;
const catalogInstallation = (operator: api.ManagementSummary) => ({
  count: operator.installationCount && operator.installationCount > 1 ? `${operator.installationCount} configurations` : '',
  pin: operator.installedTagName ?? 'version details unavailable',
  published: operator.installedGithubReleaseId
    ? operator.installedPublishedAt ? `Published ${published(operator.installedPublishedAt)}` : 'Publication time unavailable'
    : '',
});
const ReleaseChoices: Component<{ label: string; releases: api.ManagementRelease[]; selected: string; onSelect: (id: string) => void }> = props =>
  <fieldset class="admin-area-list-compact"><legend>{props.label}</legend><For each={props.releases}>{item =>
    <label class="admin-toggle-field"><input type="radio" name={props.label} value={item.id} checked={props.selected === item.id} onChange={() => props.onSelect(item.id)} />
      <span class="admin-form-field"><strong>{releaseLabel(item)}</strong><small>{!item.tagName && !item.version ? 'Version unavailable · ' : ''}{item.publishedAt ? `Published ${published(item.publishedAt)}` : 'Publication time unavailable'} · {item.approved ? 'Approved' : 'Requires approval'}</small><Show when={item.description}><small>{item.description}</small></Show></span>
    </label>
  }</For></fieldset>;
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);
function failure(error: unknown, mutation = false): string {
  if (denied(error)) return 'Access denied. Sign in with an authorized account or ask your administrator for access.';
  if (error instanceof ApiError && error.status === 409) return 'This revision is stale. Refresh current state and review it before trying again.';
  if (mutation) return error instanceof ApiError && error.status === 400
    ? 'Invalid source, package or configuration. Check the fields and refresh before trying again.'
    : 'The operation was not confirmed. Refresh current state before retrying; do not assume it succeeded.';
  return apiErrorMessage(error, 'Operators could not be loaded. Retry when the service is available.');
}

/** One bounded catalog/detail flow. Authorization is exclusively enforced by the server. */
const OperatorManagement: Component<OperatorManagementProps> = (props) => {
  const initial = () => new URL(window.location.href);
  const [selected, setSelected] = createSignal(initial().searchParams.get('operator') ?? '');
  const [invocationId, setInvocationId] = createSignal(initial().searchParams.get('invoke') ?? '');
  const [activityView, setActivityView] = createSignal(initial().searchParams.get('view') === 'activity' || !!invocationId());
  const [query, setQuery] = createSignal<api.CatalogQuery>({ query: initial().searchParams.get('query') ?? '',
    cursor: initial().searchParams.get('cursor') ?? '', profile: initial().searchParams.get('profile') ?? '', state: initial().searchParams.get('state') ?? '' });
  const [search, setSearch] = createSignal(query().query ?? '');
  const [searchOpen, setSearchOpen] = createSignal(!!(query().query || query().profile || query().state));
  const [items, setItems] = createSignal<api.ManagementSummary[]>([]);
  const [cursor, setCursor] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [catalogError, setCatalogError] = createSignal<unknown>();
  const [detail, setDetail] = createSignal<api.ManagementDetail>();
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailError, setDetailError] = createSignal<unknown>();
  const [choices, setChoices] = createSignal<api.ManagementChoices>();
  const [choicesError, setChoicesError] = createSignal(false);
  const [registering, setRegistering] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [stale, setStale] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [feedbackSection, setFeedbackSection] = createSignal('');
  const [repositoryUrl, setRepositoryUrl] = createSignal('');
  const [pat, setPat] = createSignal('');
  const [profile, setProfile] = createSignal<'conductor' | 'dispatcher'>('conductor');
  const [registrationManagers, setRegistrationManagers] = createSignal<api.ManagementGrant>({ users: props.userEmail ? [props.userEmail] : [], groups: [] });
  const [registrationInvokers, setRegistrationInvokers] = createSignal(emptyGrant());
  const [registrationPolicy, setRegistrationPolicy] = createSignal(emptyPolicy());
  let active = true;
  let listRequest = 0;
  let detailRequest = 0;
  let heading: HTMLHeadingElement | undefined;
  let registerButton: HTMLButtonElement | undefined;
  let sourceInput: HTMLInputElement | undefined;
  let searchInput: HTMLInputElement | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSearch = () => { if (searchTimer) clearTimeout(searchTimer); searchTimer = undefined; };
  const locked = () => busy() || stale() || detailLoading();
  const canRegister = () => !!choices() && !locked() && registrationPolicy().capabilities.length > 0
    && (profile() === 'dispatcher' ? validSourceBytes(registrationPolicy().sourceResponseBytes, sourceBytes(choices()?.ceiling.sourceResponseBytes)) : !!registrationPolicy().resourceProfileId)
    && !hasUnavailablePolicy(registrationPolicy(), choices()!.ceiling.capabilities,
      profile() === 'dispatcher' ? [] : choices()!.ceiling.resourceProfileIds);

  function syncUrl(push = true) {
    const url = new URL(window.location.href);
    url.searchParams.delete('realm');
    for (const key of ['query', 'cursor', 'profile', 'state']) {
      const value = query()[key as keyof api.CatalogQuery];
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    if (selected()) url.searchParams.set('operator', selected()); else url.searchParams.delete('operator');
    window.history[push ? 'pushState' : 'replaceState']({}, '', url);
  }
  function navigate(id: string) {
    cancelSearch(); setRegistering(false); setPat(''); setError(''); setNotice(''); setStale(false);
    setSelected(id); syncUrl(); queueMicrotask(() => heading?.focus());
  }
  const popstate = () => {
    const url = initial();
    setSelected(url.searchParams.get('operator') ?? '');
    setInvocationId(url.searchParams.get('invoke') ?? '');
    setActivityView(url.searchParams.get('view') === 'activity' || !!invocationId());
    setQuery({ query: url.searchParams.get('query') ?? '', cursor: url.searchParams.get('cursor') ?? '',
      profile: url.searchParams.get('profile') ?? '', state: url.searchParams.get('state') ?? '' });
    cancelSearch(); setSearch(query().query ?? ''); setSearchOpen(!!(query().query || query().profile || query().state));
    setRegistering(false); setPat(''); setError(''); setNotice(''); setStale(false);
  };
  window.addEventListener('popstate', popstate);
  onCleanup(() => { active = false; cancelSearch(); setPat(''); window.removeEventListener('popstate', popstate); });
  async function loadCatalog(filter: api.CatalogQuery) {
    const sequence = ++listRequest;
    setLoading(true); setCatalogError(undefined); setItems([]); setCursor(null);
    try {
      const result = await api.listManagedOperators(filter);
      if (active && sequence === listRequest) { setItems(result.items); setCursor(result.cursor); }
      return true;
    } catch (cause) { if (active && sequence === listRequest) setCatalogError(cause); return false; }
    finally { if (active && sequence === listRequest) setLoading(false); }
  }
  async function loadDetail(id: string, clear = false) {
    const sequence = ++detailRequest;
    if (!id) { setDetail(undefined); setDetailLoading(false); return true; }
    if (clear) setDetail(undefined);
    setDetailLoading(true); setDetailError(undefined);
    try {
      const result = await api.getManagedOperator(id);
      if (active && sequence === detailRequest) setDetail(result);
      return true;
    } catch (cause) {
      if (active && sequence === detailRequest) { setDetail(undefined); setDetailError(cause); }
      return false;
    } finally { if (active && sequence === detailRequest) setDetailLoading(false); }
  }
  async function loadChoices() {
    try { const value = await api.getManagementChoices(); if (active) { setChoices(value); setChoicesError(false); } }
    catch { if (active) { setChoices(undefined); setChoicesError(true); } }
  }
  void loadChoices();
  createEffect(() => { if (!activityView()) void loadCatalog({ ...query() }); });
  createEffect(() => { if (!activityView()) void loadDetail(selected(), true); });
  async function refresh() {
    const [catalog, current] = await Promise.all([loadCatalog(query()), loadDetail(selected()), loadChoices()]);
    if (active && catalog && current) { setStale(false); setError(''); }
  }
  async function perform(action: () => Promise<unknown>, message: string, section = '') {
    if (locked()) return;
    setFeedbackSection(section);
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      if (active) { setNotice(message); await refresh(); }
    } catch (cause) {
      if (active) {
        setError(section === 'operator-capabilities' && cause instanceof ApiError && cause.status === 400
          ? 'Operator capabilities must fit current Environment limits. Refresh and review before trying again.'
          : failure(cause, true)); setStale(true);
        if (denied(cause)) { setDetail(undefined); setDetailError(cause); setCatalogError(cause); setItems([]); setRegistering(false); }
      }
    } finally { if (active) { setPat(''); setBusy(false); } }
  }
  const feedback = (section: string): JSX.Element => <Show when={feedbackSection() === section}>
    <Show when={busy()}><p role="status" class="operator-message">Saving and reconciling current state…</p></Show>
    <Show when={error()}><div class="operator-message" role="alert" aria-atomic="true"><p>{error()}</p>
      <button class="admin-secondary-button" disabled={busy()} onClick={() => void refresh()}>Refresh current state</button></div></Show>
    <Show when={notice()}><p role="status" class="operator-message" data-state="saved">{notice()}</p></Show>
  </Show>;
  const filter = (key: keyof api.CatalogQuery, value: string) => { setQuery({ ...query(), [key]: value, cursor: '' }); syncUrl(false); };
  const typeSearch = (value: string) => {
    setSearch(value); cancelSearch();
    searchTimer = setTimeout(() => { searchTimer = undefined; if (!selected() && !activityView()) filter('query', value.trim()); }, 250);
  };
  const toggleSearch = () => {
    cancelSearch();
    if (searchOpen()) {
      setSearchOpen(false); setSearch(''); setQuery({ query: '', cursor: '', profile: '', state: '' }); syncUrl(false);
    } else { setSearchOpen(true); queueMicrotask(() => searchInput?.focus()); }
  };
  const register = () => { setRegistering(true); setPat(''); queueMicrotask(() => sourceInput?.focus()); };
  const closeRegistration = () => { setRegistering(false); setPat(''); queueMicrotask(() => registerButton?.focus()); };
  const showInvocation = (event: MouseEvent, id: string) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const url = new URL((event.currentTarget as HTMLAnchorElement).href);
    window.history.pushState({}, '', url);
    setInvocationId(id); setActivityView(true); setSelected('');
  };
  const showSection = (event: MouseEvent, activity: boolean) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    cancelSearch(); setActivityView(activity); setSelected(''); setInvocationId(''); setRegistering(false); setPat('');
    if (!activity) {
      setQuery({ query: '', cursor: '', profile: '', state: '' });
      setSearch('');
    }
    const url = new URL(window.location.href);
    url.search = activity ? '?view=activity' : '';
    window.history.pushState({}, '', url);
  };

  return <div class="operator-management" classList={{ 'is-embedded': props.isAdmin }} role={props.isAdmin ? undefined : 'main'}>
    <div class="admin-page">
      <header class="admin-page-header"><div><h1 ref={heading} tabindex="-1">Operators</h1>
        <p>Choose a verified operator. Installing a version does not enable new runs.</p></div>
        <nav class="operator-actions" aria-label="Operators navigation"><Show when={!props.isAdmin}><a href="/app">Back to workspace</a></Show><a href="/operators" aria-current={!activityView() ? 'page' : undefined} onClick={event => showSection(event, false)}>Catalog</a><a href="/operators?view=activity" aria-current={activityView() ? 'page' : undefined} onClick={event => showSection(event, true)}>My activity</a></nav>
      </header>
      <Show when={!activityView()} fallback={<OperatorManagementActivity installationId={invocationId() || undefined} onBackToCatalog={event => showSection(event, false)} />}>
      {feedback('')}
      <Show when={choicesError() && !catalogError()}><p role="alert" class="operator-message">Identity choices and limits are unavailable. <a href="/admin/environment/access">Manage identities in Environment</a> or <button type="button" class="admin-secondary-button" onClick={() => void loadChoices()}>Retry choices</button>.</p></Show>
      <Show when={!selected()} fallback={<>
        <button class="admin-secondary-button" disabled={busy()} onClick={() => navigate('')}>Back to catalog</button>
        <Show when={detailLoading()}><p role="status">Loading operator details…</p></Show>
        <Show when={detailError()}><div role="alert" class="operator-message"><p>{failure(detailError())}</p>
          <button class="admin-secondary-button" disabled={busy()} onClick={() => void refresh()}>Retry details</button></div></Show>
        <Show when={detail()}>{value => <OperatorDetail detail={value()} choices={choices()} isAdmin={props.isAdmin} locked={locked()} perform={perform} feedback={feedback} onInvoke={showInvocation} />}</Show>
      </>}>
        <section class="admin-panel operator-panel" aria-label="Operator catalog">
          <div class="operator-section-heading"><h2>Available operators</h2><div class="operator-actions">
            <button type="button" class="admin-icon-button" aria-label="Search operators" title="Search operators" aria-controls="operator-search" aria-expanded={searchOpen()} onClick={toggleSearch}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={mdiLayersSearch} /></svg></button>
            <Show when={!denied(catalogError())}><button ref={registerButton} class="admin-primary-button" disabled={busy()} onClick={register}>Register operator</button></Show>
          </div></div>
          <Show when={searchOpen()}><div id="operator-search" class="admin-form-grid">
            <label class="admin-form-field"><span>Search operators</span><input ref={searchInput} type="search" maxlength="256" value={search()} onInput={event => typeSearch(event.currentTarget.value)} /></label>
            <label class="admin-form-field"><span>Category</span><select value={query().profile ?? ''} onChange={event => filter('profile', event.currentTarget.value)}>
              <option value="">All categories</option><option value="conductor">Conductor</option><option value="dispatcher">Dispatcher</option></select></label>
            <label class="admin-form-field"><span>Status</span><select value={query().state ?? ''} onChange={event => filter('state', event.currentTarget.value)}>
              <option value="">All statuses</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label>
          </div></Show>
          <Show when={loading()}><p role="status">Loading operators…</p></Show>
          <Show when={catalogError()}><div role="alert" class="operator-message"><p>{failure(catalogError())}</p>
            <button class="admin-secondary-button" onClick={() => void refresh()}>Retry catalog</button>
            <Show when={denied(catalogError())}><a href="/auth/logout" rel="external">Sign in again</a></Show></div></Show>
          <Show when={!loading() && !catalogError()}>
            <Show when={items().length} fallback={<p>No operators match this catalog view.</p>}>
              <ul class="operator-list"><For each={items()}>{operator => <li class="admin-area-row">
                <div><div class="operator-identity"><strong>{name(operator)}</strong><span class="settings-beta-badge operator-type-pill">{category(operator)}</span></div><p>{operator.description || 'Open this operator to review its verified versions and purpose.'}</p>
                  <div class="operator-catalog-meta"><Show when={catalogInstallation(operator).count}><span>{catalogInstallation(operator).count}</span></Show>
                    <Show when={operator.installedGithubReleaseId} fallback={<span>{operator.installationCount ? 'Configuration registered' : 'No version installed'}</span>}>
                      <span class="operator-catalog-version">Installed <b>{catalogInstallation(operator).pin}</b></span>
                    </Show>
                    <Show when={catalogInstallation(operator).published}><span>{catalogInstallation(operator).published}</span></Show>
                    <span class={`admin-status ${operator.enabled ? 'admin-status-enabled' : 'admin-status-disabled'}`}>{operator.enabled ? 'Enabled' : 'Disabled'}</span>
                  </div></div>
                <button class="admin-secondary-button" disabled={busy()} aria-label={`Manage ${name(operator)}`}  onClick={() => navigate(operator.id)}>Manage</button>
              </li>}</For></ul>
            </Show>
            <Show when={query().cursor || cursor()}><nav class="operator-actions" aria-label="Catalog pages"><Show when={query().cursor}>
              <button class="admin-secondary-button" onClick={() => { setQuery({ ...query(), cursor: '' }); syncUrl(); }}>First page</button></Show>
              <Show when={cursor()}><button class="admin-secondary-button" onClick={() => { setQuery({ ...query(), cursor: cursor()! }); syncUrl(); }}>Next page</button></Show>
              <span>Up to 50 permitted operators per page</span></nav></Show>
          </Show>
        </section>
        <Show when={registering() && !denied(catalogError())}>
          <section class="admin-panel operator-panel" aria-label="Register operator"><h2>Register an operator</h2>
            <p>Use a canonical GitHub repository URL and a repository-read PAT. The credential is acquisition-only and never returned. Registration does not approve or enable a release.</p>
            <form onSubmit={event => { event.preventDefault(); if (!canRegister()) return; void perform(async () => {
              const credential = pat(); setPat('');
              const created = await api.registerManagedOperator({ repositoryUrl: repositoryUrl().trim(), githubPat: credential,
                profile: profile(), managers: registrationManagers(), invokers: registrationInvokers(), policy: registrationPolicy() });
              if (active) { setRegistering(false); setSelected(created.id); syncUrl(); }
            }, 'Operator source registered. Discover a release to install.'); }}>
              <fieldset disabled={locked()}><div class="admin-form-grid">
                <label class="admin-form-field"><span>GitHub repository URL</span><input ref={sourceInput} type="url" required maxlength="2048" placeholder="https://github.com/owner/repository" value={repositoryUrl()} onInput={event => setRepositoryUrl(event.currentTarget.value)} /></label>
                <label class="admin-form-field"><span>Repository-read PAT</span><input type="password" required maxlength="16384" autocomplete="new-password" value={pat()} onInput={event => setPat(event.currentTarget.value)} /></label>
                <label class="admin-form-field"><span>Operator profile</span><select value={profile()} onChange={event => { setProfile(event.currentTarget.value as 'conductor' | 'dispatcher'); setRegistrationPolicy(emptyPolicy()); }}><option value="conductor">Conductor</option><option value="dispatcher">Dispatcher</option></select></label>
              </div>
              <Show when={choices()?.unresolvedGroups.length}><p role="status">Unverified configured groups cannot be assigned: {choices()!.unresolvedGroups.join(', ')}. Saved assignments remain until removed.</p></Show>
              <GrantFields title="Initial manager" value={registrationManagers()} choices={choices()} onChange={setRegistrationManagers} />
              <GrantFields title="Initial invoker" value={registrationInvokers()} choices={choices()} onChange={setRegistrationInvokers} />
              <PolicyFields title="Operator" profile={profile()} value={registrationPolicy()} sourceResponseMax={sourceBytes(choices()?.ceiling.sourceResponseBytes)} capabilities={choices()?.ceiling.capabilities ?? []} profiles={profile() === 'dispatcher' ? [] : choices()?.ceiling.resourceProfileIds ?? []} onChange={setRegistrationPolicy} />
              <p>Select initial capabilities and scope within Environment limits. Operator capabilities can be edited later; changing them disables enabled installations until explicitly re-enabled.</p>
              <div class="operator-actions"><button class="admin-primary-button" type="submit" disabled={!canRegister()}>Register source</button></div>
              </fieldset>
              <button class="admin-secondary-button" type="button" disabled={busy()} onClick={closeRegistration}>Cancel registration</button>
            </form>
          </section>
        </Show>

      </Show>
      </Show>
    </div>
  </div>;
};

const LineField: Component<{ label: string; values: string[]; onChange: (values: string[]) => void; hint: string }> = props => {
  const [draft, setDraft] = createSignal('');
  createEffect(() => {
    const value = props.values.join('\n');
    if (untrack(() => lines(draft()).join('\n')) !== value) setDraft(value);
  });
  return <label class="admin-form-field"><span>{props.label}</span><textarea aria-label={props.label} rows="3" maxlength="32768" value={draft()} onInput={event => {
    const value = event.currentTarget.value; setDraft(value);
    const entries = lines(value);
    props.onChange(entries);
  }} /><small>{props.hint}</small></label>;
};
const sameGroup = (a: api.ManagementGrant['groups'][number], b: api.ManagementGrant['groups'][number]) => a.issuer === b.issuer && a.id === b.id;
function hasUnavailablePolicy(value: api.ManagementPolicy, capabilities: string[], profiles: string[]): boolean {
  return value.capabilities.some(capability => !capabilities.includes(capability))
    || (value.resourceProfileId !== null && !profiles.includes(value.resourceProfileId));
}
const capabilityTitle: Record<string, string> = { session: 'Session access', pi: 'Coding agent', storage: 'Scoped storage', inference: 'Inference', fetch: 'Mediated requests' };
const capabilityHelp: Record<string, string> = {
  session: 'Use an authorized session within its selected scope.',
  pi: 'Run the installed coding-agent interface within an authorized session.',
  storage: 'Use authorized, scoped storage.',
  inference: 'Use the invoking person’s permitted inference route.',
  fetch: 'Make parent-mediated requests allowed by the current human and operator policies; not unrestricted network access.',
};
const GrantFields: Component<{ title: string; value: api.ManagementGrant; choices?: api.ManagementChoices; onChange: (value: api.ManagementGrant) => void }> = props => {
  const unavailableUsers = () => props.value.users.filter(user => !props.choices?.users.includes(user));
  const unavailableGroups = () => props.value.groups.filter(group => !props.choices?.groups.some(choice => sameGroup(group, choice)));
  return <fieldset class="operator-fields"><legend>{props.title}</legend>
    <p>{props.title === 'Managers' ? 'Can install versions and change settings. Cannot run the operator without a separate runner grant.' : props.title === 'Runners' ? 'Can start this operator with their own authorization. Cannot change its settings.' : 'Select an eligible identity; assignments not listed in this session remain saved until removed.'}</p>
    <div class="admin-form-grid"><div class="admin-form-field"><span>Users</span><div class="admin-checkbox-list">
      <Show when={!props.choices?.users.length && !unavailableUsers().length}><p>No eligible users available.</p></Show><For each={props.choices?.users ?? []}>{user =>
      <label class="admin-toggle-field"><input type="checkbox" checked={props.value.users.includes(user)} onChange={event => props.onChange({ ...props.value,
        users: event.currentTarget.checked ? [...props.value.users, user] : props.value.users.filter(value => value !== user) })} /><span>{user}</span></label>
    }</For><For each={unavailableUsers()}>{user => <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => props.onChange({ ...props.value, users: props.value.users.filter(value => value !== user) })} />
      <span>{user} · not listed in this session, retained until removed</span></label>}</For></div></div>
    <div class="admin-form-field"><span>Groups</span><div class="admin-checkbox-list">
      <Show when={!props.choices?.groups.length && !unavailableGroups().length}><p>No verified groups available.</p></Show>
      <For each={props.choices?.groups ?? []}>{group =>
      <label class="admin-toggle-field"><input type="checkbox" checked={props.value.groups.some(value => sameGroup(value, group))} onChange={event => props.onChange({ ...props.value,
        groups: event.currentTarget.checked ? [...props.value.groups, group] : props.value.groups.filter(value => !sameGroup(value, group)) })} /><span>{group.id}</span></label>
    }</For><For each={unavailableGroups()}>{group => <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => props.onChange({ ...props.value, groups: props.value.groups.filter(value => !sameGroup(value, group)) })} />
      <span>{group.id} · not listed in this session, retained until removed</span></label>}</For></div></div></div>
  </fieldset>;
};
const PolicyFields: Component<{ title: string; profile: 'conductor' | 'dispatcher'; value: api.ManagementPolicy; capabilities: string[]; profiles: string[]; sourceResponseMax: number;
  onChange: (value: api.ManagementPolicy) => void }> = props => <fieldset class="operator-fields"><legend>{props.title === 'Operator' ? 'Operator actions and scope' : 'Installation restrictions'}</legend>
  <div class="admin-form-grid"><div class="admin-form-field"><span>Allowed actions</span><div class="admin-checkbox-list"><For each={props.capabilities}>{capability =>
    <label class="admin-toggle-field"><input type="checkbox" checked={props.value.capabilities.includes(capability)} onChange={event => props.onChange({ ...props.value,
      capabilities: event.currentTarget.checked ? [...props.value.capabilities, capability] : props.value.capabilities.filter(value => value !== capability) })} />
      <span class="admin-form-field"><strong>{capabilityTitle[capability] ?? capability}</strong><small>{capabilityHelp[capability] ?? 'Restricted operator action'}</small></span></label>
  }</For><For each={props.value.capabilities.filter(item => !props.capabilities.includes(item))}>{item =>
    <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => props.onChange({ ...props.value,
      capabilities: props.value.capabilities.filter(value => value !== item) })} /><span>{item} · unavailable — deselect to remove</span></label>
  }</For></div></div>
    <Show when={props.profile === 'dispatcher'}><SourceResponseField label={`${props.title === 'Operator' ? 'Operator' : 'Installation'} source response limit (bytes)`}
      value={props.value.sourceResponseBytes} max={props.sourceResponseMax} onChange={value => props.onChange({ ...props.value, sourceResponseBytes: value })} /></Show>
    <Show when={props.profile === 'conductor'}>
      <label class="admin-form-field"><span>Session and storage scope</span><select aria-label={`${props.title} resource profile`} value={props.value.resourceProfileId ?? ''} onChange={event => props.onChange({ ...props.value, resourceProfileId: event.currentTarget.value || null })}>
        <option value="">None</option><For each={props.profiles}>{id => <option value={id}>{id}</option>}</For>
        <Show when={props.value.resourceProfileId && !props.profiles.includes(props.value.resourceProfileId)}><option value={props.value.resourceProfileId ?? ''} disabled>{props.value.resourceProfileId} · unavailable, retained</option></Show>
      </select><small>The <a href="/admin/environment/access">Environment allowlist</a> permits scope IDs; this installation narrows access to the selected ID. Runtime constructs the restricted session. Adding an ID does not provision a profile.</small>
      <Show when={!props.profiles.length}><small>No scope ID is eligible under current Environment and operator limits. A saved unavailable value is retained unless explicitly changed.</small></Show></label>
    </Show></div>
</fieldset>;

const OperatorDetail: Component<{ detail: api.ManagementDetail; choices?: api.ManagementChoices; isAdmin?: boolean; locked: boolean;
  perform: (action: () => Promise<unknown>, message: string, section?: string) => Promise<void>;
  feedback: (section: string) => JSX.Element; onInvoke: (event: MouseEvent, id: string) => void }> = props => {
  const [section, setSection] = createSignal<'installed' | 'versions' | 'permissions'>('installed');
  const [managers, setManagers] = createSignal(emptyGrant());
  const [invokers, setInvokers] = createSignal(emptyGrant());
  const [installationId, setInstallationId] = createSignal('');
  const [releaseId, setReleaseId] = createSignal('');
  const [installOpen, setInstallOpen] = createSignal(false);
  const [policy, setPolicy] = createSignal(emptyPolicy());
  const [operatorCapabilities, setOperatorCapabilities] = createSignal<string[]>([]);
  const [operatorSourceResponseBytes, setOperatorSourceResponseBytes] = createSignal<number>();
  const [operatorInferenceRequestBytes, setOperatorInferenceRequestBytes] = createSignal<number>();
  const [sourceUrl, setSourceUrl] = createSignal('');
  const [sourcePat, setSourcePat] = createSignal('');
  const [assessmentRepository, setAssessmentRepository] = createSignal('');
  const [assessmentPullRequest, setAssessmentPullRequest] = createSignal('');
  const assessmentUrl = () => {
    const params = new URLSearchParams({ invoke: installation()!.id });
    if (assessmentRepository().trim()) params.set('repository', assessmentRepository().trim());
    if (assessmentPullRequest().trim()) params.set('pullRequest', assessmentPullRequest().trim());
    return `/operators?${params}`;
  };
  createEffect(() => {
    setManagers(props.detail.grants.managers); setInvokers(props.detail.grants.invokers);
    setOperatorCapabilities(props.detail.operator.policy.capabilities);
    setOperatorSourceResponseBytes(props.detail.operator.policy.sourceResponseBytes);
    setOperatorInferenceRequestBytes(props.detail.operator.policy.inferenceRequestBytes);
    setSourceUrl(props.detail.operator.repositoryUrl); setSourcePat('');
  });
  createEffect(() => {
    const installations = props.detail.installations;
    const enabled = installations.filter(item => item.enabled);
    const initial = enabled.length === 1 ? enabled[0] : installations.length === 1 ? installations[0] : undefined;
    setInstallationId(id => installations.some(item => item.id === id) ? id : initial?.id ?? '');
  });
  const operator = () => props.detail.operator;
  const installation = () => props.detail.installations.find(item => item.id === installationId());
  const currentRelease = () => props.detail.releases.find(release => release.id === installation()?.releaseId);
  const guidedAssessment = () => operator().profile === 'dispatcher' && currentRelease()?.name === 'Renovate Dispatcher'
    && operator().repositoryUrl.replace(/\.git$/i, '').toLowerCase() === 'https://github.com/nikolanovoselec/codeflare-operator-dispatcher';
  const purpose = () => installation()?.releaseId
    ? currentRelease()?.description || 'Purpose unavailable for the selected installed version.'
    : props.detail.installations.length > 1 && !installation() ? 'Select an installed configuration to see its verified purpose.'
    : props.detail.releases.length === 1 ? props.detail.releases[0].description || 'Package description unavailable.'
    : 'Purpose available after selecting a verified version.';
  const environmentSourceMax = () => sourceBytes(props.choices?.ceiling.sourceResponseBytes);
  const installationSourceMax = () => Math.min(sourceBytes(operator().policy.sourceResponseBytes), environmentSourceMax());
  const validOperatorSource = () => operator().profile !== 'dispatcher'
    || (validSourceBytes(operatorSourceResponseBytes(), environmentSourceMax()) && validInferenceBytes(operatorInferenceRequestBytes()));
  const validInstallationSource = () => operator().profile !== 'dispatcher' || validSourceBytes(policy().sourceResponseBytes, installationSourceMax());
  const allowedCapabilities = () => operator().policy.capabilities.filter(item => props.choices?.ceiling.capabilities.includes(item));
  const allowedProfiles = () => operator().profile !== 'dispatcher' && operator().policy.resourceProfileId && props.choices?.ceiling.resourceProfileIds.includes(operator().policy.resourceProfileId!)
    ? [operator().policy.resourceProfileId!] : [];
  createEffect(() => { setPolicy(installation()?.policy ?? emptyPolicy()); });
  onCleanup(() => setSourcePat(''));
  const otherReleases = () => props.detail.releases.filter(item => item.id !== installation()?.releaseId);
  const selectedRelease = () => props.detail.releases.find(item => item.id === releaseId());
  const canChoose = () => !!props.choices && !props.locked;
  function openSection(next: 'installed' | 'versions' | 'permissions') {
    setSection(next); setReleaseId(''); setInstallOpen(false);
    queueMicrotask(() => document.getElementById(`operator-${next}`)?.scrollIntoView?.({ block: 'start' }));
  }
  async function installSelected() {
    const chosen = selectedRelease();
    if (!chosen || !canChoose()) return;
    await props.perform(async () => {
      const existing = installation();
      if (existing) await api.promoteInstallation(existing.id, chosen.id, existing.revision);
      else {
        // Create once, then pin. A lost response requires a manual current-state refresh,
        // never an automatic second create.
        const created = await api.createInstallation(operator().id, {
          name: 'default', policy: { capabilities: operator().policy.capabilities, resourceProfileId: operator().policy.resourceProfileId,
            ...(operator().policy.sourceResponseBytes === undefined ? {} : { sourceResponseBytes: operator().policy.sourceResponseBytes }) }, revision: operator().revision,
        });
        await api.promoteInstallation(created.id, chosen.id, created.revision);
      }
      setReleaseId(''); setInstallOpen(false);
    }, 'Version installed — not enabled for new runs. Enable it separately when ready.', section() === 'versions' ? 'versions-install' : 'installed-install');
  }
  return <>
    <section class="admin-panel operator-panel operator-overview" aria-label="Operator overview">
      <div class="admin-panel-heading"><div><div class="operator-identity"><h2>{name(operator())}</h2><span class="settings-beta-badge operator-type-pill">{category(operator())}</span></div>
        <p class="operator-state">{installation()?.enabled ? 'Enabled for new runs' : installation()?.releaseId ? 'Installed — not enabled' : props.detail.installations.length > 1 && !installation() ? 'Choose an installed configuration' : 'No version installed'}</p></div></div>
      <div class="admin-routing-intro"><p>{purpose()}</p></div>
    </section>
    <nav class="admin-routing-nav operator-section-nav" aria-label="Operator sections">
      <button type="button" aria-pressed={section() === 'installed'} onClick={() => openSection('installed')}>Installed version</button>
      <button type="button" aria-pressed={section() === 'versions'} onClick={() => openSection('versions')}>Versions &amp; updates</button>
      <button type="button" aria-pressed={section() === 'permissions'} onClick={() => openSection('permissions')}>Permissions</button>
    </nav>
    <section id="operator-installed" hidden={section() !== 'installed'} class="admin-panel operator-panel admin-routing-pane" aria-label="Installed version">
      <h2>Installed version</h2>
      <Show when={props.detail.installations.length > 1}><label class="admin-form-field"><span>Installed configuration</span><select aria-label="Installed configuration" value={installation()?.id ?? ''} onChange={event => setInstallationId(event.currentTarget.value)}>
        <option value="">Choose an installed configuration</option>
        <For each={props.detail.installations}>{item => <option value={item.id}>{item.name} · {item.enabled ? 'enabled for new runs' : item.releaseId ? 'installed, not enabled' : 'no version installed'}</option>}</For>
      </select><small>Each configuration has its own pinned release and enablement.</small></label></Show>
      <Show when={props.detail.installations.filter(item => item.enabled).length > 1}><p>Enabled configurations: {props.detail.installations.filter(item => item.enabled).map(item => item.name).join(', ')}. Choose one before changing it.</p></Show>
      <Show when={currentRelease()} fallback={<p>{installation()?.releaseId ? 'Installed version details unavailable' : props.detail.installations.length > 1 && !installation() ? 'Choose a configuration to view its pinned version.' : 'No version installed'}</p>}>{release => <>
        <div class="admin-connection-status" data-state={installation()?.enabled ? 'passed' : 'unclear'}>
          <div><strong>{releaseDisplay(release())}</strong><span role="status">{installation()?.enabled ? 'Enabled for new runs' : 'Installed — not enabled'}</span></div>
        </div>
        <Show when={!release().tagName || !release().publishedAt}><div class="operator-release-recovery"><p>{release().publishedAt ? 'Version label unavailable for this release.' : 'Publication time unavailable for this release.'} Refresh to check GitHub for verified version and publication details.</p>
          <button type="button" class="admin-secondary-button" disabled={props.locked} onClick={() => void props.perform(
            () => api.refreshManagedReleases(operator().id, operator().revision), 'Release details refreshed; the installed version and enablement are unchanged.', 'installed-metadata')}>Refresh release details</button>
          {props.feedback('installed-metadata')}</div></Show>
        <div class="operator-actions"><button class="admin-primary-button" type="button" disabled={props.locked} onClick={() => void props.perform(
          () => api.enableInstallation(installation()!.id, !installation()!.enabled, installation()!.revision),
          installation()!.enabled ? 'No new runs will start on this version.' : 'This version is enabled for new runs.', 'installed-enable')}>{installation()?.enabled ? 'Disable for new runs' : 'Enable for new runs'}</button>
        </div>
        <Show when={installation()?.enabled && guidedAssessment()}><div class="admin-form-grid">
          <label class="admin-form-field"><span>Repository to assess</span><input type="text" maxlength="256" autocomplete="off" placeholder="owner/repository" value={assessmentRepository()} onInput={event => setAssessmentRepository(event.currentTarget.value)} /></label>
          <label class="admin-form-field"><span>Pull request to assess</span><input type="number" min="1" step="1" max="9007199254740991" value={assessmentPullRequest()} onInput={event => setAssessmentPullRequest(event.currentTarget.value)} /></label>
        </div><p>Choose a repository and pull request you can read, or enter them in the guided form. Opening the form creates no activity; assessment starts only after you submit with your own invocation grant.</p>
          <div class="operator-actions"><a href={assessmentUrl()} onClick={event => props.onInvoke(event, installation()!.id)}>Assess a pull request</a></div></Show>
        <Show when={operator().profile === 'conductor' && operator().name === 'Conductor Review'}><p>Review preparation requires a protected pull request boundary. This package cannot start an ad hoc Review here; inspect your own work in My activity.</p></Show>
        {props.feedback('installed-enable')}
      </>}</Show>
      <Show when={!installation()?.releaseId && (!props.detail.installations.length || !!installation())}><button type="button" class="admin-primary-button" disabled={props.locked || !props.detail.releases.length} onClick={() => setInstallOpen(true)}>Install operator</button></Show>
      <Show when={installOpen() && !installation()?.releaseId}><div class="operator-install-setup"><h3>Choose an exact version</h3>
        <p>Installation pins this verified release but does not enable new runs. The operator’s existing limits apply; review them in Permissions.</p>
        <ReleaseChoices label="Version to install" releases={props.detail.releases} selected={releaseId()} onSelect={setReleaseId} />
        <Show when={selectedRelease()}>{item => <p>You selected {releaseDisplay(item())}. Existing activities keep their original version. Enabling new runs is a separate step.</p>}</Show>
        <div class="operator-actions"><button type="button" class="admin-primary-button" disabled={!canChoose() || !releaseId()} onClick={() => void installSelected()}>Install selected version</button>
          <button type="button" class="admin-secondary-button" onClick={() => { setInstallOpen(false); setReleaseId(''); }}>Cancel</button></div>
      </div></Show>
      {props.feedback('installed-install')}
      <section class="admin-profile-editor" aria-label="Runtime permissions">
        <h3>Runtime permissions</h3>
        <form onSubmit={event => { event.preventDefault(); if (!validOperatorSource()) return; void props.perform(() => api.saveOperatorCapabilities(operator().id, {
          revision: operator().revision, capabilities: operatorCapabilities(),
          ...(operator().profile === 'dispatcher' && operatorSourceResponseBytes() !== undefined ? { sourceResponseBytes: operatorSourceResponseBytes() } : {}),
          ...(operator().profile === 'dispatcher' && operatorInferenceRequestBytes() !== undefined ? { inferenceRequestBytes: operatorInferenceRequestBytes() } : {}),
        }), 'Operator capabilities saved. A change disables installed runs until you explicitly re-enable them.', 'operator-capabilities'); }}><fieldset disabled={props.locked}>
          <legend>Operator capabilities</legend><p>Allowed actions and source-response ceilings come from Environment. Inference request size is operator-specific. Changing these settings disables enabled installations; review each installation before re-enabling.</p>
          <div class="admin-checkbox-list"><For each={props.choices?.ceiling.capabilities ?? []}>{capability =>
            <label class="admin-toggle-field"><input type="checkbox" checked={operatorCapabilities().includes(capability)} onChange={event => setOperatorCapabilities(values => event.currentTarget.checked ? [...values, capability] : values.filter(value => value !== capability))} />
              <span class="admin-form-field"><strong>{capabilityTitle[capability] ?? capability}</strong><small>{capabilityHelp[capability] ?? 'Restricted operator action'}</small></span></label>
          }</For><For each={operatorCapabilities().filter(value => !props.choices?.ceiling.capabilities.includes(value))}>{capability =>
            <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => setOperatorCapabilities(values => values.filter(value => value !== capability))} />
              <span>{capability} · unavailable under current Environment limit; remove before saving</span></label>
          }</For></div>
          <Show when={operator().profile === 'dispatcher'}><SourceResponseField label="Operator source response limit (bytes)" value={operatorSourceResponseBytes()} max={environmentSourceMax()} onChange={setOperatorSourceResponseBytes} />
            <label class="admin-form-field"><span>Inference request limit (bytes)</span><input aria-label="Inference request limit (bytes)" type="number" required min="1" step="1" max={api.MAX_INFERENCE_REQUEST_BYTES}
              value={Number.isFinite(inferenceBytes(operatorInferenceRequestBytes())) ? inferenceBytes(operatorInferenceRequestBytes()) : ''}
              onInput={event => setOperatorInferenceRequestBytes(event.currentTarget.valueAsNumber)} />
              <small>Complete inference request body, including messages and tools. Source responses and final output keep their own limits. Platform limits still apply. Maximum: {api.MAX_INFERENCE_REQUEST_BYTES} bytes.</small></label>
          </Show>
          <button class="admin-secondary-button" type="submit" disabled={!props.choices || !validOperatorSource() || operatorCapabilities().some(value => !props.choices?.ceiling.capabilities.includes(value))}>Save operator capabilities</button>
        </fieldset>{props.feedback('operator-capabilities')}</form>
        <Show when={installation()}>{item => <form onSubmit={event => { event.preventDefault(); if (!validInstallationSource()) return; void props.perform(() => api.configureInstallation(item().id, {
          revision: item().revision, policy: policy(), configuration: item().configuration ?? {},
        }), 'Restrictions saved. Enable new runs separately when ready.', 'installed-restrictions'); }}><fieldset disabled={props.locked}>
          <PolicyFields title={item().name} profile={operator().profile} value={policy()} sourceResponseMax={installationSourceMax()} capabilities={allowedCapabilities()} profiles={allowedProfiles()} onChange={setPolicy} />
          <button class="admin-secondary-button" type="submit" aria-label={`Save restrictions for ${item().name}`} disabled={!props.choices || !validInstallationSource() || hasUnavailablePolicy(policy(), allowedCapabilities(), allowedProfiles())}>Save restrictions</button>
        </fieldset>{props.feedback('installed-restrictions')}</form>}</Show>
      </section>
      <details class="admin-route-details"><summary>Technical details</summary>
        <p>Core, Intent and Interface are package compatibility contract versions, not the installed release version.</p>
        <dl class="operator-facts"><dt>Package name</dt><dd>{operator().name ?? operator().repositoryUrl ?? operator().id}</dd><dt>Source repository</dt><dd>{operator().repositoryUrl}</dd><dt>Repository ID</dt><dd>{operator().repositoryId}</dd>
          <dt>Source credential</dt><dd>{operator().source.credentialConfigured ? 'Configured (write-only)' : 'Not configured'}</dd>
          <dt>Approved workflow</dt><dd>{operator().source.approvedWorkflow ? `${operator().source.approvedWorkflow!.id} · ${operator().source.approvedWorkflow!.ref}` : 'Not selected'}</dd>
          <dt>Maximum allowed actions</dt><dd>{operator().policy.capabilities.join(', ') || 'None'}</dd>
          <dt>Scope ID</dt><dd>{operator().policy.resourceProfileId ?? 'None'}</dd>
          <Show when={currentRelease()}>{item => <><dt>Core contract version</dt><dd>{item().coreVersion ?? 'Not reported'}</dd><dt>Intent contract version</dt><dd>{item().intentVersion ?? 'Not reported'}</dd><dt>Interface version</dt><dd>{item().interfaceVersion}</dd><dt>GitHub release ID</dt><dd>{item().githubReleaseId}</dd><dt>Release record</dt><dd>{item().id}</dd><dt>Source commit</dt><dd>{item().sourceCommit}</dd><dt>Bundle SHA-256</dt><dd>{item().bundleDigest}</dd><dt>Manifest SHA-256</dt><dd>{item().manifestDigest}</dd></>}</Show>
        </dl>
      </details>
      <details class="admin-route-details"><summary>Change source</summary><p>Replacing the repository invalidates approval and stops new runs. Discover and approve an exact release afterward. Existing activities retain their pinned release.</p>
        <form onSubmit={event => { event.preventDefault(); void props.perform(async () => {
          const credential = sourcePat(); setSourcePat('');
          await api.replaceOperatorSource(operator().id, { revision: operator().revision, repositoryUrl: sourceUrl().trim(), githubPat: credential });
        }, 'Source replaced. Discover and approve a release before enabling.', 'installed-source'); }}><fieldset disabled={props.locked}>
          <label class="admin-form-field"><span>Replacement repository URL</span><input type="url" required maxlength="2048" value={sourceUrl()} onInput={event => setSourceUrl(event.currentTarget.value)} /></label>
          <label class="admin-form-field"><span>Replacement repository-read PAT</span><input type="password" required maxlength="16384" autocomplete="new-password" value={sourcePat()} onInput={event => setSourcePat(event.currentTarget.value)} /></label>
          <button class="admin-secondary-button" type="submit">Replace source</button>
        </fieldset>{props.feedback('installed-source')}</form>
      </details>
    </section>
    <section id="operator-versions" hidden={section() !== 'versions'} class="admin-panel operator-panel admin-routing-pane" aria-label="Versions and updates">
      <div class="operator-section-heading"><h2>Versions &amp; updates</h2><button class="admin-secondary-button" disabled={props.locked} onClick={() => void props.perform(
        () => api.refreshManagedReleases(operator().id, operator().revision), 'Release discovery refreshed; no version changed.', 'versions-refresh')}>Refresh releases</button></div>
      {props.feedback('versions-refresh')}
      <p>Review the verified versions below. A lower or higher GitHub release number does not establish which version is newer; switching disables new runs until you re-enable them.</p>
      <h3>Other available versions</h3>
      <Show when={otherReleases().length} fallback={<p>No other verified versions are available.</p>}>
        <Show when={installation()?.releaseId} fallback={<ul class="operator-list"><For each={otherReleases()}>{item => <li><strong>{releaseDisplay(item)}</strong><p>{item.description || 'Package description unavailable.'}</p></li>}</For></ul>}>
          <div class="operator-install-setup">
            <ReleaseChoices label="Exact version" releases={otherReleases()} selected={releaseId()} onSelect={setReleaseId} />
            <Show when={selectedRelease()}>{item => <p>Switch {installation()?.name} to {releaseDisplay(item())}? New runs will remain disabled until you re-enable them; running activities keep their pinned version.</p>}</Show>
            <div class="operator-actions"><button type="button" class="admin-primary-button" disabled={!canChoose() || !releaseId()} onClick={() => void installSelected()}>Install selected version</button></div>
            {props.feedback('versions-install')}
          </div>
        </Show>
      </Show>
    </section>
    <section id="operator-permissions" hidden={section() !== 'permissions'} class="admin-panel operator-panel admin-routing-pane" aria-label="Access grants">
      <h2>Permissions</h2><p>Choose from identities configured in <a href="/admin/environment/access">Environment · Access &amp; Identity</a>. Management never grants execution or access to another person’s activity.</p>
      <Show when={props.choices?.unresolvedGroups.length}><p role="status">Unverified configured groups cannot be assigned: {props.choices!.unresolvedGroups.join(', ')}. Saved assignments not listed below remain until you remove them.</p></Show>
      <form onSubmit={event => { event.preventDefault(); void props.perform(() => api.saveOperatorGrants(operator().id, {
        managers: managers(), invokers: invokers(), revision: operator().revision,
      }), 'Permissions saved. Management does not grant execution.', 'permissions'); }}><fieldset disabled={props.locked}>
        <GrantFields title="Managers" value={managers()} choices={props.choices} onChange={setManagers} />
        <GrantFields title="Runners" value={invokers()} choices={props.choices} onChange={setInvokers} />
        <button class="admin-primary-button" type="submit" disabled={!props.choices}>Save permissions</button>
      </fieldset>{props.feedback('permissions')}</form>
    </section>
  </>;
};

export const ManagementAccessPanel: Component = () => {
  const [choices, setChoices] = createSignal<api.ManagementChoices>();
  const [current, setCurrent] = createSignal<api.ManagementAccess>();
  const [managers, setManagers] = createSignal(emptyGrant());
  const [capabilities, setCapabilities] = createSignal<string[]>([]);
  const [resources, setResources] = createSignal('');
  const [sourceResponseBytes, setSourceResponseBytes] = createSignal<number>();
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [stale, setStale] = createSignal(false);
  let active = true;
  onCleanup(() => { active = false; });
  function populate(value: api.ManagementAccess) {
    setCurrent(value); setManagers(value.managers); setCapabilities(value.ceiling.capabilities); setResources(value.ceiling.resourceProfileIds.join('\n'));
    setSourceResponseBytes(value.ceiling.sourceResponseBytes);
  }
  async function load() {
    setLoading(true); setError('');
    try {
      const [value, available] = await Promise.all([api.getManagementAccess(), api.getManagementChoices()]);
      if (active) { populate(value); setChoices(available); setStale(false); }
    }
    catch (cause) { if (active) { setCurrent(undefined); setChoices(undefined); setError(failure(cause)); } }
    finally { if (active) setLoading(false); }
  }
  void load();
  async function save() {
    if (busy() || stale() || !current() || !validSourceBytes(sourceResponseBytes(), api.MAX_SOURCE_RESPONSE_BYTES)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await api.saveManagementAccess({ revision: current()!.revision, managers: managers(),
        ceiling: { ...current()!.ceiling, capabilities: capabilities(), resourceProfileIds: lines(resources()),
          ...(sourceResponseBytes() !== undefined ? { sourceResponseBytes: sourceResponseBytes() } : {}) } });
      if (active) { populate(value); setNotice('Management access saved. Operator ownership and invocation grants remain separate.'); }
    } catch (cause) { if (active) { setError(failure(cause, true)); setStale(true); } }
    finally { if (active) setBusy(false); }
  }
  return <section class="operator-access-content" aria-label="Operator eligibility and limits">
    <p>Select existing Environment identities who may be eligible to manage operators. An operator must also grant them management; neither permission lets them run it.</p>
    <Show when={loading()}><p role="status">Loading management access…</p></Show>
    <Show when={error()}><div role="alert" class="operator-message"><p>{error()}</p><button class="admin-secondary-button" disabled={busy()} onClick={() => void load()}>Refresh management access</button></div></Show>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={current()}><form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy() || loading() || stale()}>
      <GrantFields title="Eligible manager" value={managers()} choices={choices()} onChange={setManagers} />
      <fieldset class="operator-fields"><legend>Maximum allowed actions</legend><p>These are upper limits, not permission to run an operator. Each operator and installation may narrow them; the person starting a run must also be authorized.</p>
        <div class="admin-checkbox-list operator-choice-list"><For each={choices()?.capabilities ?? []}>{capability => <label class="admin-toggle-field"><input type="checkbox" checked={capabilities().includes(capability)} onChange={event => setCapabilities(values => event.currentTarget.checked ? [...values, capability] : values.filter(value => value !== capability))} /><span class="admin-form-field"><strong>{capabilityTitle[capability] ?? capability}</strong><small>{capabilityHelp[capability] ?? 'Restricted operator action'}</small></span></label>}</For>
          <For each={capabilities().filter(value => !choices()?.capabilities.includes(value))}>{item => <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => setCapabilities(values => values.filter(value => value !== item))} /><span>{item} · unavailable — deselect to remove</span></label>}</For></div>
      </fieldset>
      <SourceResponseField label="Largest Dispatcher source response (bytes)" value={sourceResponseBytes()} max={api.MAX_SOURCE_RESPONSE_BYTES} onChange={setSourceResponseBytes} />
      <details class="operator-scope-details"><summary>Conductor request IDs (advanced)</summary>
        <p>These are allowed names for Conductor requests, not profiles you create. At installation, an administrator selects one allowed ID. On every run, the requested session and storage must both name that same allowed ID or the run is denied. This does not create a session or configure storage; Codeflare builds those resources under its existing permissions. Dispatcher does not use these IDs.</p>
        <LineField label="Allowed request IDs" values={lines(resources())} onChange={values => setResources(values.join('\n'))} hint="One ID per line. Keep review-profile unless the package contract requires a different name; removing an ID can prevent installed runs." />
      </details>
      <div class="operator-actions"><button type="submit" class="admin-primary-button" disabled={!choices() || !validSourceBytes(sourceResponseBytes(), api.MAX_SOURCE_RESPONSE_BYTES) || capabilities().some(value => !choices()?.capabilities.includes(value))}>Save management access</button></div>
    </fieldset></form></Show>
  </section>;
};
export default OperatorManagement;
