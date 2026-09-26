import { For, Show, createEffect, createSignal, onCleanup, untrack, type Component } from 'solid-js';
import * as api from '../api/operator-management';
import { ApiError, apiErrorMessage } from '../api/fetch-helper';
import OperatorManagementActivity from './OperatorManagementActivity';
import '../styles/administration.css';
import '../styles/ai-routing-workspace.css';
import '../styles/operator-management.css';

export interface OperatorManagementProps { userEmail?: string; isAdmin?: boolean }
const emptyGrant = (): api.ManagementGrant => ({ users: [], groups: [] });
const emptyPolicy = (): api.ManagementPolicy => ({ capabilities: [], resourceProfileId: null });
const lines = (value: string) => [...new Set(value.split('\n').map(line => line.trim()).filter(Boolean))];
const name = (operator: api.ManagementSummary) => operator.name ?? operator.repositoryUrl ?? operator.id;
const releaseLabel = (release: api.ManagementRelease) => release.version ?? `GitHub release #${release.githubReleaseId}`;
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
  const locked = () => busy() || stale() || detailLoading();
  const canRegister = () => !!choices() && !locked() && !hasUnavailableGrant(registrationManagers(), choices())
    && !hasUnavailableGrant(registrationInvokers(), choices())
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
    setRegistering(false); setPat(''); setError(''); setNotice(''); setStale(false);
    setSelected(id); syncUrl(); queueMicrotask(() => heading?.focus());
  }
  const popstate = () => {
    const url = initial();
    setSelected(url.searchParams.get('operator') ?? '');
    setInvocationId(url.searchParams.get('invoke') ?? '');
    setActivityView(url.searchParams.get('view') === 'activity' || !!invocationId());
    setQuery({ query: url.searchParams.get('query') ?? '', cursor: url.searchParams.get('cursor') ?? '',
      profile: url.searchParams.get('profile') ?? '', state: url.searchParams.get('state') ?? '' });
    setSearch(query().query ?? ''); setRegistering(false); setPat(''); setError(''); setNotice(''); setStale(false);
  };
  window.addEventListener('popstate', popstate);
  onCleanup(() => { active = false; setPat(''); window.removeEventListener('popstate', popstate); });
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
    const results = await Promise.all([loadCatalog(query()), loadDetail(selected())]);
    if (active && results.every(Boolean)) { setStale(false); setError(''); }
  }
  async function perform(action: () => Promise<unknown>, message: string) {
    if (locked()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await action();
      if (active) { setNotice(message); await refresh(); }
    } catch (cause) {
      if (active) {
        setError(failure(cause, true)); setStale(true);
        if (denied(cause)) { setDetail(undefined); setDetailError(cause); setCatalogError(cause); setItems([]); setRegistering(false); }
      }
    } finally { if (active) { setPat(''); setBusy(false); } }
  }
  const filter = (key: keyof api.CatalogQuery, value: string) => { setQuery({ ...query(), [key]: value, cursor: '' }); syncUrl(); };
  const register = () => { setRegistering(true); setPat(''); queueMicrotask(() => sourceInput?.focus()); };
  const closeRegistration = () => { setRegistering(false); setPat(''); queueMicrotask(() => registerButton?.focus()); };
  const showSection = (event: MouseEvent, activity: boolean) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setActivityView(activity); setSelected(''); setInvocationId(''); setRegistering(false); setPat('');
    if (!activity) {
      setQuery({ query: '', cursor: '', profile: '', state: '' });
      setSearch('');
    }
  };

  return <div class="operator-management" classList={{ 'is-embedded': props.isAdmin }} role={props.isAdmin ? undefined : 'main'}>
    <div class="admin-page">
      <header class="admin-page-header"><div><p class="admin-eyebrow">Operator management</p><h1 ref={heading} tabindex="-1">Operators</h1>
        <p>Discover a verified version, install it, then explicitly enable new runs. My activity remains personal.</p></div>
        <nav class="operator-actions" aria-label="Operators navigation"><Show when={!props.isAdmin}><a href="/app">Back to workspace</a></Show><a href="/operators" aria-current={!activityView() ? 'page' : undefined} onClick={event => showSection(event, false)}>Catalog</a><a href="/operators?view=activity" aria-current={activityView() ? 'page' : undefined} onClick={event => showSection(event, true)}>My activity</a></nav>
      </header>
      <Show when={!activityView()} fallback={<OperatorManagementActivity installationId={invocationId() || undefined} />}>
      <Show when={error()}><div class="operator-message" role="alert" aria-atomic="true"><p>{error()}</p>
        <button class="admin-secondary-button" disabled={busy()} onClick={() => void refresh()}>Refresh current state</button></div></Show>
      <Show when={notice()}><p role="status" class="operator-message">{notice()}</p></Show>
      <Show when={choicesError()}><p role="alert" class="operator-message">Identity choices and limits are unavailable. <a href="/admin/environment/access">Manage identities in Environment</a> or <button type="button" class="admin-secondary-button" onClick={() => void loadChoices()}>Retry choices</button>.</p></Show>
      <Show when={busy()}><p role="status">Saving and reconciling current state…</p></Show>
      <Show when={!selected()} fallback={<>
        <button class="admin-secondary-button" disabled={busy()} onClick={() => navigate('')}>Back to catalog</button>
        <Show when={detailLoading()}><p role="status">Loading operator details…</p></Show>
        <Show when={detailError()}><div role="alert" class="operator-message"><p>{failure(detailError())}</p>
          <button class="admin-secondary-button" disabled={busy()} onClick={() => void refresh()}>Retry details</button></div></Show>
        <Show when={detail()}>{value => <OperatorDetail detail={value()} choices={choices()} isAdmin={props.isAdmin} locked={locked()} perform={perform} />}</Show>
      </>}>
        <section class="admin-panel operator-panel" aria-label="Operator catalog">
          <div class="operator-section-heading"><h2>Catalog</h2><Show when={!denied(catalogError())}>
            <button ref={registerButton} class="admin-primary-button" disabled={busy()} onClick={register}>Register operator</button></Show></div>
          <form class="operator-filters" onSubmit={event => { event.preventDefault(); filter('query', search().trim()); }}>
            <label class="admin-form-field"><span>Search operators</span><input type="search" maxlength="256" value={search()} onInput={event => setSearch(event.currentTarget.value)} /></label>
            <label class="admin-form-field"><span>Profile</span><select value={query().profile ?? ''} onChange={event => filter('profile', event.currentTarget.value)}>
              <option value="">All profiles</option><option value="conductor">Conductor</option><option value="dispatcher">Dispatcher</option></select></label>
            <label class="admin-form-field"><span>State</span><select value={query().state ?? ''} onChange={event => filter('state', event.currentTarget.value)}>
              <option value="">All states</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></label>
            <button class="admin-secondary-button" type="submit" disabled={loading()}>Search</button>
          </form>
          <Show when={loading()}><p role="status">Loading operators…</p></Show>
          <Show when={catalogError()}><div role="alert" class="operator-message"><p>{failure(catalogError())}</p>
            <button class="admin-secondary-button" onClick={() => void refresh()}>Retry catalog</button>
            <Show when={denied(catalogError())}><a href="/">Sign in again</a></Show></div></Show>
          <Show when={!loading() && !catalogError()}>
            <Show when={items().length} fallback={<p>No operators match this catalog view.</p>}>
              <ul class="operator-list"><For each={items()}>{operator => <li class="admin-area-row">
                <div><strong>{name(operator)}</strong><p>{operator.description || 'Purpose available after release discovery.'}</p>
                  <p>{operator.installationCount && operator.installationCount > 1 ? `${operator.installationCount} installed configurations` : operator.installedGithubReleaseId ? `Installed: GitHub release #${operator.installedGithubReleaseId}` : 'No version installed'} · {operator.enabled ? 'Enabled for new runs' : 'Not enabled for new runs'}</p></div>
                <button class="admin-secondary-button" disabled={busy()} aria-label={`Manage ${name(operator)}`} onClick={() => navigate(operator.id)}>Manage</button>
              </li>}</For></ul>
            </Show>
            <nav class="operator-actions" aria-label="Catalog pages"><Show when={query().cursor}>
              <button class="admin-secondary-button" onClick={() => { setQuery({ ...query(), cursor: '' }); syncUrl(); }}>First page</button></Show>
              <Show when={cursor()}><button class="admin-secondary-button" onClick={() => { setQuery({ ...query(), cursor: cursor()! }); syncUrl(); }}>Next page</button></Show>
              <span>Up to 50 permitted operators per page</span></nav>
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
              <GrantFields title="Initial manager" value={registrationManagers()} choices={choices()} onChange={setRegistrationManagers} />
              <GrantFields title="Initial invoker" value={registrationInvokers()} choices={choices()} onChange={setRegistrationInvokers} />
              <PolicyFields title="Operator" value={registrationPolicy()} capabilities={choices()?.ceiling.capabilities ?? []} profiles={profile() === 'dispatcher' ? [] : choices()?.ceiling.resourceProfileIds ?? []} onChange={setRegistrationPolicy} />
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
function hasUnavailableGrant(value: api.ManagementGrant, choices?: api.ManagementChoices): boolean {
  return !choices || value.users.some(user => !choices.users.includes(user))
    || value.groups.some(group => !choices.groups.some(choice => sameGroup(group, choice)));
}
function hasUnavailablePolicy(value: api.ManagementPolicy, capabilities: string[], profiles: string[]): boolean {
  return value.capabilities.some(capability => !capabilities.includes(capability))
    || (value.resourceProfileId !== null && !profiles.includes(value.resourceProfileId));
}
const capabilityHelp: Record<string, string> = {
  session: 'Use an authorized session under the selected resource profile.',
  pi: 'Run the installed coding-agent interface within an authorized session.',
  storage: 'Use authorized, scoped storage.',
  inference: 'Use the invoking person’s permitted inference route.',
  fetch: 'Use parent-approved outbound reads within the current policy; not unrestricted internet access.',
};
const GrantFields: Component<{ title: string; value: api.ManagementGrant; choices?: api.ManagementChoices; onChange: (value: api.ManagementGrant) => void }> = props => {
  const unavailableUsers = () => props.value.users.filter(user => !props.choices?.users.includes(user));
  const unavailableGroups = () => props.value.groups.filter(group => !props.choices?.groups.some(choice => sameGroup(group, choice)));
  return <fieldset class="operator-fields"><legend>{props.title} grants</legend>
    <p>Select identities configured in <a href="/admin/environment/access">Environment · Access &amp; Identity</a>. Management does not grant permission to run an operator.</p>
    <Show when={props.choices?.unresolvedGroups.length}><p role="status">Configured groups without a verified stable membership ID cannot be assigned here: {props.choices!.unresolvedGroups.join(', ')}. Check their Access group configuration in Environment.</p></Show>
    <div class="admin-form-grid"><div class="admin-form-field"><span>{props.title} users</span><div class="admin-checkbox-list"><For each={props.choices?.users ?? []}>{user =>
      <label class="admin-toggle-field"><input type="checkbox" checked={props.value.users.includes(user)} onChange={event => props.onChange({ ...props.value,
        users: event.currentTarget.checked ? [...props.value.users, user] : props.value.users.filter(value => value !== user) })} /><span>{user}</span></label>
    }</For><For each={unavailableUsers()}>{user => <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => props.onChange({ ...props.value, users: props.value.users.filter(value => value !== user) })} />
      <span>{user} · unavailable — deselect to remove</span></label>}</For></div></div>
    <div class="admin-form-field"><span>{props.title} groups</span><div class="admin-checkbox-list"><For each={props.choices?.groups ?? []}>{group =>
      <label class="admin-toggle-field"><input type="checkbox" checked={props.value.groups.some(value => sameGroup(value, group))} onChange={event => props.onChange({ ...props.value,
        groups: event.currentTarget.checked ? [...props.value.groups, group] : props.value.groups.filter(value => !sameGroup(value, group)) })} /><span>{group.id}</span></label>
    }</For><For each={unavailableGroups()}>{group => <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => props.onChange({ ...props.value, groups: props.value.groups.filter(value => !sameGroup(value, group)) })} />
      <span>{group.id} · unavailable — deselect to remove</span></label>}</For></div></div></div>
  </fieldset>;
};
const PolicyFields: Component<{ title: string; value: api.ManagementPolicy; capabilities: string[]; profiles: string[];
  onChange: (value: api.ManagementPolicy) => void }> = props => <fieldset class="operator-fields"><legend>{props.title} restrictions</legend>
  <p>Maximum allowed actions limit what this operator may do; selecting one does not grant access by itself. The environment, operator, installation and invoking person must all allow it.</p>
  <div class="admin-form-grid"><div class="admin-form-field"><span>{props.title} capabilities</span><div class="admin-checkbox-list"><For each={props.capabilities}>{capability =>
    <label class="admin-toggle-field"><input type="checkbox" checked={props.value.capabilities.includes(capability)} onChange={event => props.onChange({ ...props.value,
      capabilities: event.currentTarget.checked ? [...props.value.capabilities, capability] : props.value.capabilities.filter(value => value !== capability) })} />
      <span>{capability} — {capabilityHelp[capability] ?? 'Restricted operator action'}</span></label>
  }</For><For each={props.value.capabilities.filter(item => !props.capabilities.includes(item))}>{item =>
    <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => props.onChange({ ...props.value,
      capabilities: props.value.capabilities.filter(value => value !== item) })} /><span>{item} · unavailable — deselect to remove</span></label>
  }</For></div></div>
    <label class="admin-form-field"><span>{props.title} resource profile</span><select value={props.value.resourceProfileId ?? ''} onChange={event => props.onChange({ ...props.value, resourceProfileId: event.currentTarget.value || null })}>
      <option value="">None</option><For each={props.profiles}>{id => <option value={id}>{id}</option>}</For>
      <Show when={props.value.resourceProfileId && !props.profiles.includes(props.value.resourceProfileId)}><option value={props.value.resourceProfileId ?? ''} disabled>{props.value.resourceProfileId} · unavailable</option></Show>
    </select><small>Predefined resource restrictions. An installation cannot exceed its operator's limit.</small></label></div>
</fieldset>;

const OperatorDetail: Component<{ detail: api.ManagementDetail; choices?: api.ManagementChoices; isAdmin?: boolean; locked: boolean;
  perform: (action: () => Promise<unknown>, message: string) => Promise<void> }> = props => {
  const [section, setSection] = createSignal<'installed' | 'versions' | 'permissions'>('installed');
  const [managers, setManagers] = createSignal(emptyGrant());
  const [invokers, setInvokers] = createSignal(emptyGrant());
  const [installationId, setInstallationId] = createSignal('');
  const [releaseId, setReleaseId] = createSignal('');
  const [installOpen, setInstallOpen] = createSignal(false);
  const [policy, setPolicy] = createSignal(emptyPolicy());
  const [sourceUrl, setSourceUrl] = createSignal('');
  const [sourcePat, setSourcePat] = createSignal('');
  createEffect(() => {
    setManagers(props.detail.grants.managers); setInvokers(props.detail.grants.invokers);
    setSourceUrl(props.detail.operator.repositoryUrl); setSourcePat('');
  });
  createEffect(() => {
    const installations = props.detail.installations;
    setInstallationId(id => installations.some(item => item.id === id) ? id : installations[0]?.id ?? '');
  });
  const operator = () => props.detail.operator;
  const installation = () => props.detail.installations.find(item => item.id === installationId()) ?? props.detail.installations[0];
  const currentRelease = () => props.detail.releases.find(release => release.id === installation()?.releaseId);
  const purpose = () => currentRelease()?.description || props.detail.releases.find(item => item.description)?.description
    || operator().description || 'Purpose unavailable until a verified release is discovered.';
  const allowedCapabilities = () => operator().policy.capabilities.filter(item => props.choices?.ceiling.capabilities.includes(item));
  const allowedProfiles = () => operator().profile !== 'dispatcher' && operator().policy.resourceProfileId && props.choices?.ceiling.resourceProfileIds.includes(operator().policy.resourceProfileId!)
    ? [operator().policy.resourceProfileId!] : [];
  createEffect(() => { setPolicy(installation()?.policy ?? emptyPolicy()); });
  onCleanup(() => setSourcePat(''));
  const otherReleases = () => props.detail.releases.filter(item => item.id !== installation()?.releaseId);
  const selectedRelease = () => props.detail.releases.find(item => item.id === releaseId());
  const canChoose = () => !!props.choices && !props.locked;
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
          name: 'default', policy: operator().policy, revision: operator().revision,
        });
        await api.promoteInstallation(created.id, chosen.id, created.revision);
      }
      setReleaseId(''); setInstallOpen(false);
    }, 'Version installed — not enabled for new runs. Enable it separately when ready.');
  }
  return <>
    <section class="admin-panel operator-panel operator-overview" aria-label="Operator overview">
      <div class="admin-panel-heading"><div><p class="admin-eyebrow">{operator().profile}</p><h2>{name(operator())}</h2>
        <p><span class="operator-state">{installation()?.enabled ? 'Enabled for new runs' : installation()?.releaseId ? 'Installed — not enabled' : 'No version installed'}</span></p></div></div>
      <div class="admin-routing-intro"><h3>About this operator</h3><p>{purpose()}</p>
        <p>Codeflare runs the selected, approved release only for an authorized person. Each activity keeps the version selected when it started; results remain in My activity.</p></div>
    </section>
    <nav class="admin-routing-nav operator-section-nav" aria-label="Operator sections">
      <button type="button" aria-pressed={section() === 'installed'} onClick={() => { setSection('installed'); setReleaseId(''); }}>Installed version</button>
      <button type="button" aria-pressed={section() === 'versions'} onClick={() => { setSection('versions'); setReleaseId(''); setInstallOpen(false); }}>Versions &amp; updates</button>
      <button type="button" aria-pressed={section() === 'permissions'} onClick={() => { setSection('permissions'); setReleaseId(''); setInstallOpen(false); }}>Permissions</button>
    </nav>
    <section hidden={section() !== 'installed'} class="admin-panel operator-panel admin-routing-pane" aria-label="Installed version">
      <h2>Installed version</h2>
      <Show when={props.detail.installations.length > 1}><label class="admin-form-field"><span>Installed configuration</span><select value={installation()?.id} onChange={event => setInstallationId(event.currentTarget.value)}>
        <For each={props.detail.installations}>{item => <option value={item.id}>{item.name} · {item.releaseId ? 'version installed' : 'no version installed'}</option>}</For>
      </select><small>Each configuration has its own pinned release and enablement.</small></label></Show>
      <Show when={currentRelease()} fallback={<p>No version installed</p>}>{release => <>
        <div class="admin-connection-status" data-state={installation()?.enabled ? 'passed' : 'unclear'}>
          <div><strong>{releaseLabel(release())}</strong><span role="status">{installation()?.enabled ? 'Enabled for new runs' : 'Installed — not enabled'}</span></div>
        </div>
        <p>Pinned release: {releaseLabel(release())}</p>
        <p>Core {release().coreVersion ?? 'not reported'} · Intent {release().intentVersion ?? 'not reported'} · Interface {release().interfaceVersion}</p>
        <div class="operator-actions"><button class="admin-primary-button" type="button" disabled={props.locked} onClick={() => void props.perform(
          () => api.enableInstallation(installation()!.id, !installation()!.enabled, installation()!.revision),
          installation()!.enabled ? 'No new runs will start on this version.' : 'This version is enabled for new runs.')}>{installation()?.enabled ? 'Disable for new runs' : 'Enable for new runs'}</button>
          <Show when={installation()?.enabled}><a href={`/operators?invoke=${encodeURIComponent(installation()!.id)}`}>Run as yourself</a></Show>
        </div>
      </>}</Show>
      <Show when={!currentRelease()}><button type="button" class="admin-primary-button" disabled={props.locked || !props.detail.releases.length} onClick={() => setInstallOpen(true)}>Install operator</button></Show>
      <Show when={installOpen() && !currentRelease()}><div class="operator-install-setup"><h3>Choose an exact version</h3>
        <p>Installation pins this verified release but does not enable new runs. The operator’s existing limits apply; review them in Permissions.</p>
        <label class="admin-form-field"><span>Version to install</span><select value={releaseId()} onChange={event => setReleaseId(event.currentTarget.value)}><option value="">Select a verified release</option>
          <For each={props.detail.releases}>{item => <option value={item.id}>{releaseLabel(item)} · {item.approved ? 'approved' : 'requires approval'}</option>}</For></select></label>
        <Show when={selectedRelease()}>{item => <p>You selected {releaseLabel(item())}. Existing activities keep their original version. Enabling new runs is a separate step.</p>}</Show>
        <div class="operator-actions"><button type="button" class="admin-primary-button" disabled={!canChoose() || !releaseId()} onClick={() => void installSelected()}>Install selected version</button>
          <button type="button" class="admin-secondary-button" onClick={() => { setInstallOpen(false); setReleaseId(''); }}>Cancel</button></div>
      </div></Show>
      <details><summary>Technical details and advanced restrictions</summary>
        <dl class="operator-facts"><dt>Source repository</dt><dd>{operator().repositoryUrl}</dd><dt>Repository ID</dt><dd>{operator().repositoryId}</dd>
          <dt>Source credential</dt><dd>{operator().source.credentialConfigured ? 'Configured (write-only)' : 'Not configured'}</dd>
          <dt>Approved workflow</dt><dd>{operator().source.approvedWorkflow ? `${operator().source.approvedWorkflow!.id} · ${operator().source.approvedWorkflow!.ref}` : 'Not selected'}</dd>
          <dt>Maximum allowed actions</dt><dd>{operator().policy.capabilities.join(', ') || 'None'}</dd>
          <dt>Resource profile</dt><dd>{operator().policy.resourceProfileId ?? 'None'}</dd>
          <Show when={currentRelease()}>{item => <><dt>Source commit</dt><dd>{item().sourceCommit}</dd><dt>Bundle SHA-256</dt><dd>{item().bundleDigest}</dd><dt>Manifest SHA-256</dt><dd>{item().manifestDigest}</dd></>}</Show>
        </dl>
        <details><summary>Replace source</summary><p>Replacing source invalidates approval and stops new runs. Refresh and approve an exact release afterward.</p>
          <form onSubmit={event => { event.preventDefault(); void props.perform(async () => {
            const credential = sourcePat(); setSourcePat('');
            await api.replaceOperatorSource(operator().id, { revision: operator().revision, repositoryUrl: sourceUrl().trim(), githubPat: credential });
          }, 'Source replaced. Discover and approve a release before enabling.'); }}><fieldset disabled={props.locked}>
            <label class="admin-form-field"><span>Replacement repository URL</span><input type="url" required maxlength="2048" value={sourceUrl()} onInput={event => setSourceUrl(event.currentTarget.value)} /></label>
            <label class="admin-form-field"><span>Replacement repository-read PAT</span><input type="password" required maxlength="16384" autocomplete="new-password" value={sourcePat()} onInput={event => setSourcePat(event.currentTarget.value)} /></label>
            <button class="admin-secondary-button" type="submit">Replace source</button>
          </fieldset></form>
        </details>
        <Show when={installation()}>{item => <form onSubmit={event => { event.preventDefault(); void props.perform(() => api.configureInstallation(item().id, {
          revision: item().revision, policy: policy(), configuration: item().configuration ?? {},
        }), 'Restrictions saved. Enable new runs separately when ready.'); }}><fieldset disabled={props.locked}>
          <PolicyFields title={item().name} value={policy()} capabilities={allowedCapabilities()} profiles={allowedProfiles()} onChange={setPolicy} />
          <button class="admin-secondary-button" type="submit" aria-label={`Save restrictions for ${item().name}`} disabled={!props.choices || hasUnavailablePolicy(policy(), allowedCapabilities(), allowedProfiles())}>Save restrictions</button>
        </fieldset></form>}</Show>
      </details>
    </section>
    <section hidden={section() !== 'versions'} class="admin-panel operator-panel admin-routing-pane" aria-label="Versions and updates">
      <div class="operator-section-heading"><h2>Versions &amp; updates</h2><button class="admin-secondary-button" disabled={props.locked} onClick={() => void props.perform(
        () => api.refreshManagedReleases(operator().id, operator().revision), 'Release discovery refreshed; no version changed.')}>Refresh releases</button></div>
      <p>Other available versions include previous versions that can be selected for rollback. GitHub release numbers identify releases, but do not establish which is newer.</p>
      <h3>Other available versions</h3>
      <Show when={otherReleases().length} fallback={<p>No other verified versions are available.</p>}><ul class="operator-list"><For each={otherReleases()}>{item => <li>
        <strong>{releaseLabel(item)}</strong><p>{item.description || 'Package description unavailable.'}</p>
        <p>{item.approved ? 'Approved' : 'Requires approval'} · Core {item.coreVersion ?? 'not reported'} · Intent {item.intentVersion ?? 'not reported'}</p>
      </li>}</For></ul></Show>
      <Show when={installation()?.releaseId && otherReleases().length}><div class="operator-install-setup"><h3>Change installed version</h3>
        <label class="admin-form-field"><span>Exact version</span><select value={releaseId()} onChange={event => setReleaseId(event.currentTarget.value)}><option value="">Select a version</option>
          <For each={otherReleases()}>{item => <option value={item.id}>{releaseLabel(item)}</option>}</For></select></label>
        <Show when={selectedRelease()}>{item => <p>Switch {installation()?.name} to {releaseLabel(item())}? New runs will remain disabled until you enable them; running activities keep their pinned version.</p>}</Show>
        <button type="button" class="admin-primary-button" disabled={!canChoose() || !releaseId()} onClick={() => void installSelected()}>Install selected version</button>
      </div></Show>
    </section>
    <section hidden={section() !== 'permissions'} class="admin-panel operator-panel admin-routing-pane" aria-label="Access grants">
      <h2>Permissions</h2><p>Choose from existing Environment identities. Managing an operator never grants permission to run it or view another person’s activities.</p>
      <form onSubmit={event => { event.preventDefault(); void props.perform(() => api.saveOperatorGrants(operator().id, {
        managers: managers(), invokers: invokers(), revision: operator().revision,
      }), 'Permissions saved. Management does not grant execution.'); }}><fieldset disabled={props.locked}>
        <GrantFields title="Who can manage this operator" value={managers()} choices={props.choices} onChange={setManagers} />
        <GrantFields title="Who can run this operator" value={invokers()} choices={props.choices} onChange={setInvokers} />
        <button class="admin-primary-button" type="submit" disabled={!props.choices || hasUnavailableGrant(managers(), props.choices) || hasUnavailableGrant(invokers(), props.choices)}>Save grants</button>
      </fieldset></form>
      <Show when={props.isAdmin}><p>Global operator eligibility and limits are set in <a href="/admin/environment/access">Environment · Access &amp; Identity</a>.</p></Show>
    </section>
  </>;
};

export const ManagementAccessPanel: Component = () => {
  const [choices, setChoices] = createSignal<api.ManagementChoices>();
  const [current, setCurrent] = createSignal<api.ManagementAccess>();
  const [managers, setManagers] = createSignal(emptyGrant());
  const [capabilities, setCapabilities] = createSignal<string[]>([]);
  const [resources, setResources] = createSignal('');
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');
  const [stale, setStale] = createSignal(false);
  let active = true;
  onCleanup(() => { active = false; });
  function populate(value: api.ManagementAccess) {
    setCurrent(value); setManagers(value.managers); setCapabilities(value.ceiling.capabilities); setResources(value.ceiling.resourceProfileIds.join('\n'));
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
    if (busy() || stale() || !current()) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const value = await api.saveManagementAccess({ revision: current()!.revision, managers: managers(),
        ceiling: { capabilities: capabilities(), resourceProfileIds: lines(resources()) } });
      if (active) { populate(value); setNotice('Management access saved. Operator ownership and invocation grants remain separate.'); }
    } catch (cause) { if (active) { setError(failure(cause, true)); setStale(true); } }
    finally { if (active) setBusy(false); }
  }
  return <section class="admin-panel operator-panel"><h2>Operator eligibility and limits</h2>
    <p>Select existing Environment identities for global management eligibility. This does not grant access to an operator by itself, and managing never permits execution.</p>
    <Show when={loading()}><p role="status">Loading management access…</p></Show>
    <Show when={error()}><div role="alert" class="operator-message"><p>{error()}</p><button class="admin-secondary-button" disabled={busy()} onClick={() => void load()}>Refresh management access</button></div></Show>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={current()}><form onSubmit={event => { event.preventDefault(); void save(); }}><fieldset disabled={busy() || loading() || stale()}>
      <GrantFields title="Eligible manager" value={managers()} choices={choices()} onChange={setManagers} />
      <fieldset class="operator-fields"><legend>Maximum allowed actions</legend><p>These are upper limits, not permissions by themselves. Environment rules, operator settings, installation limits and the person running it must all permit the action.</p>
        <div class="admin-checkbox-list"><For each={choices()?.capabilities ?? []}>{capability => <label class="admin-toggle-field"><input type="checkbox" checked={capabilities().includes(capability)} onChange={event => setCapabilities(values => event.currentTarget.checked ? [...values, capability] : values.filter(value => value !== capability))} /><span>{capability} — {capabilityHelp[capability]}</span></label>}</For>
          <For each={capabilities().filter(value => !choices()?.capabilities.includes(value))}>{item => <label class="admin-toggle-field"><input type="checkbox" checked onChange={() => setCapabilities(values => values.filter(value => value !== item))} /><span>{item} · unavailable — deselect to remove</span></label>}</For></div>
        <LineField label="Allowed resource profile IDs" values={lines(resources())} onChange={values => setResources(values.join('\n'))} hint="Advanced deployment limit: only stable resource profiles already provisioned by the platform. Operator selections use a dropdown from this list." />
      </fieldset>
      <p>Revision {current()!.revision}</p><button type="submit" class="admin-primary-button" disabled={!choices() || hasUnavailableGrant(managers(), choices()) || capabilities().some(value => !choices()?.capabilities.includes(value))}>Save management access</button>
    </fieldset></form></Show>
  </section>;
};
export default OperatorManagement;
